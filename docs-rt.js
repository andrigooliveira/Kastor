/* ══════════════════════════════════════════════════════════════════════
   docs-rt.js — WebSocket runtime pra colaboração em tempo real dos
                documentos do Kastor Docs.

   Como funciona (protocolo Yjs padrão)
   ─────────────────────────────────
   - 1 documento colaborativo = 1 "room" (chave = docId)
   - Cada conexão WS entra em uma room. O servidor:
       · guarda um Y.Doc em memória por room
       · relaya updates entre peers da mesma room
       · mantém awareness (cursores, presença)
       · snapshotta periodicamente pra callback (persistência)

   Autenticação
   ─────────────
   - Verifica o cookie de sessão HTTP na upgrade (mesmo cookie do app)
   - Se não valida, fecha o socket com código 4001

   Persistência
   ─────────────
   - Não usa disco (LevelDB) por enquanto: mantém o Y.Doc em memória
     e chama `onPersist(docId, updateBytes)` a cada 30s ou quando
     a última conexão sai. O caller passa uma função que grava esses
     bytes junto do writerDocument.
   - Ao criar a room, se `loadInitialState(docId)` retorna Uint8Array,
     aplica isso pra reidratar do Postgres.

   Notas
   ─────────────
   - yjs/y-protocols/lib0 são ESM-only; carregamos via import() dinâmico
     na função `init()` e cacheamos os módulos.
   - Precisamos rodar dentro do MESMO processo do server.js pra
     compartilhar auth.userIdForToken sem duplicar código.
   ══════════════════════════════════════════════════════════════════════ */
const { WebSocketServer } = require('ws');
const url = require('url');

// Módulos ESM carregados via import() dinâmico
let Y, syncProtocol, awarenessProtocol, encoding, decoding;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/* Rooms ativas: docId → Room */
const rooms = new Map();

class Room {
  constructor(docId, opts) {
    this.docId = docId;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.conns = new Set();
    this.onPersist = opts.onPersist || (() => {});
    this.dirty = false;
    this.persistTimer = null;

    // Broadcast updates do doc pra todos os peers (exceto origem)
    this.doc.on('update', (update, origin) => {
      this.dirty = true;
      this._schedulePersist();
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) if (c !== origin && c.readyState === 1) c.send(msg);
    });

    // Broadcast awareness updates
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      // Lembra quais clientes cada conexão controla, pra limpar a presença
      // (cursor/avatar) quando ela cair — senão fica um cursor fantasma.
      if (origin && origin._room === this) {
        if (!origin._awIds) origin._awIds = new Set();
        for (const id of added.concat(updated)) origin._awIds.add(id);
        for (const id of removed) origin._awIds.delete(id);
      }
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      );
      const msg = encoding.toUint8Array(enc);
      for (const c of this.conns) if (c !== origin && c.readyState === 1) c.send(msg);
    });
  }

  add(conn) {
    this.conns.add(conn);
    conn._room = this;

    // Envia SYNC_STEP_1 (state vector) — cliente responde com SYNC_STEP_2
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    conn.send(encoding.toUint8Array(enc));

    // Envia awareness atual pra o novo peer
    const awStates = this.awareness.getStates();
    if (awStates.size > 0) {
      const encA = encoding.createEncoder();
      encoding.writeVarUint(encA, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        encA,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awStates.keys()))
      );
      conn.send(encoding.toUint8Array(encA));
    }
  }

  onMessage(conn, data) {
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        // readSyncMessage aplica step2/updates no doc e escreve resposta em enc
        syncProtocol.readSyncMessage(dec, enc, this.doc, conn);
        // Só responde se houver algo (SYNC_STEP_1 do peer merece SYNC_STEP_2)
        if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(dec),
          conn
        );
      }
    } catch (e) {
      console.warn('[docs-rt] onMessage error:', e.message);
    }
  }

  remove(conn) {
    this.conns.delete(conn);
    // Remove awareness pending do peer (client_ids que esse conn detinha)
    const clientIds = Array.from(conn._awIds || []).filter(id => this.awareness.getStates().has(id));
    if (clientIds.length) {
      awarenessProtocol.removeAwarenessStates(this.awareness, clientIds, null);
    }
    // Se ficou vazia, persiste uma última vez e libera
    if (this.conns.size === 0) {
      this._persistNow();
      // Room fica em memória por 60s pra reconexões rápidas não perderem estado
      setTimeout(() => {
        if (this.conns.size === 0) {
          rooms.delete(this.docId);
        }
      }, 60000);
    }
  }

  _schedulePersist() {
    if (this.persistTimer) return;
    // Sala nova (sem snapshot salvo): grava logo, pra um restart não perder o
    // estado e obrigar outro cliente a semear de novo. Depois, a cada 30s.
    const wait = this.fresh ? 2000 : 30000;
    this.fresh = false;
    this.persistTimer = setTimeout(() => this._persistNow(), wait);
  }

  _persistNow() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    if (!this.dirty) return;
    try {
      const update = Y.encodeStateAsUpdate(this.doc);
      this.onPersist(this.docId, update);
      this.dirty = false;
    } catch (e) {
      console.warn('[docs-rt] persist error:', e.message);
    }
  }
}

/* Carrega os módulos ESM uma vez (é assíncrono). */
async function loadModules() {
  if (Y) return;
  const [yjs, sync, aw, enc, dec] = await Promise.all([
    import('yjs'),
    import('y-protocols/sync'),
    import('y-protocols/awareness'),
    import('lib0/encoding'),
    import('lib0/decoding')
  ]);
  Y = yjs;
  syncProtocol = sync;
  awarenessProtocol = aw;
  encoding = enc;
  decoding = dec;
}

/* Setup principal — chamado pelo server.js depois do app.listen(). Retorna
   {broadcastForceLoad, closeAll, listRooms} pra o server usar. */
async function setup(httpServer, opts = {}) {
  await loadModules();

  const {
    // (req) => userIdOrNull — verifica o cookie de sessão
    authenticate,
    // (docId, userId) => boolean — checa permissão
    canAccess,
    // async (docId) => Uint8Array|null — carrega snapshot Yjs prévio
    loadInitialState,
    // (docId, updateBytes) => void — persiste (chamado com throttle)
    onPersist
  } = opts;

  const wss = new WebSocketServer({ noServer: true });

  // Upgrade handler no HTTP server. Rota: /rt/docs/<docId>
  httpServer.on('upgrade', async (req, socket, head) => {
    const u = url.parse(req.url, true);
    const m = u.pathname && u.pathname.match(/^\/rt\/docs\/([a-f0-9-]+)$/i);
    if (!m) return; // deixa outros handlers (SSE não usa WS, então tudo bem)
    const docId = m[1];

    let userId = null;
    try { userId = authenticate(req); } catch { userId = null; }
    if (!userId) {
      socket.destroy();
      return;
    }
    let allowed = false;
    try { allowed = await canAccess(docId, userId); } catch { allowed = false; }
    if (!allowed) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._userId = userId;
      ws._connId = Math.random().toString(36).slice(2);
      wss.emit('connection', ws, req, docId);
    });
  });

  wss.on('connection', async (ws, req, docId) => {
    let room = rooms.get(docId);
    if (!room) {
      room = new Room(docId, { onPersist });
      rooms.set(docId, room);
      // Reidrata do snapshot persistido. Quem conectar enquanto isso espera
      // (room.ready): senão sincroniza com a sala vazia, o cliente semeia o
      // conteúdo de novo e ele duplica quando o snapshot chega.
      room.ready = (async () => {
        try {
          const initial = await loadInitialState(docId);
          if (initial && initial.byteLength > 0) Y.applyUpdate(room.doc, initial);
          else room.fresh = true;   // nunca salvo: primeira persistência sai rápido
        } catch (e) {
          console.warn('[docs-rt] loadInitialState error:', e.message);
        }
      })();
    }
    await room.ready;

    ws.binaryType = 'arraybuffer';
    room.add(ws);

    ws.on('message', (data) => room.onMessage(ws, data));
    ws.on('close', () => room.remove(ws));
    ws.on('error', () => { try { ws.close(); } catch {} });
  });

  return {
    listRooms: () => Array.from(rooms.keys()),
    persistAll: () => { for (const r of rooms.values()) r._persistNow(); },
    close: () => wss.close()
  };
}

module.exports = { setup };
