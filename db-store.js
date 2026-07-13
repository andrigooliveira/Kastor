/* ───────────────────────────────────────────────────────────────
   KASTOR — Camada de persistência SQLite (node:sqlite, built-in)

   Modelo híbrido:
     - Tabela genérica `entities` guarda cada entidade como (type, id, workspace_id, JSON)
       com índice em (type, workspace_id). Listagens por workspace ficam O(log n).
     - Tabela `notifications` é dedicada (escrita frequente, busca por usuário).
     - Tabela `password_resets` separada por mesmo motivo.

   Por que assim e não tabelas por entidade?
     - Schema permanece flexível enquanto o código ainda evolui.
     - Servidor continua operando entidades como objetos JS, sem ORM.
     - Migração futura pra colunas dedicadas em hot paths é localizada.
   ─────────────────────────────────────────────────────────────── */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ENTITY_TYPES = [
  'workspaces', 'users', 'clients', 'projects', 'flows',
  'demands', 'roles', 'templates', 'webhooks', 'schedules', 'clientTemplates',
  'recurrings', 'listas', 'googleEvents'
];

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'kastor.db');
  const db = new DatabaseSync(dbPath);

  // PRAGMAs de performance/durabilidade. WAL = leituras concorrentes com escritas.
  // synchronous=NORMAL é suficiente quando o filesystem tem fsync confiável.
  // busy_timeout=5s: em containers com latência de disco (Docker Swarm em volume
  // remoto, por exemplo), sem isso qualquer write concorrente cospe SQLITE_BUSY.
  // 5s cobre a folga; ainda barato porque a maior parte das writes é sub-ms.
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
  `);

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      workspace_id TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (type, id)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_type_ws
      ON entities (type, workspace_id);
    CREATE INDEX IF NOT EXISTS idx_entities_type_updated
      ON entities (type, updated_at DESC);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user_created
      ON notifications (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notif_user_read
      ON notifications (user_id, is_read);

    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pwreset_expires
      ON password_resets (expires_at);

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  // Prepared statements (criar uma vez, reusar) — node:sqlite é síncrono
  const stmts = {
    upsertEntity: db.prepare(
      'INSERT INTO entities (type, id, workspace_id, data, updated_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(type, id) DO UPDATE SET workspace_id=excluded.workspace_id, data=excluded.data, updated_at=excluded.updated_at'
    ),
    deleteEntity: db.prepare('DELETE FROM entities WHERE type = ? AND id = ?'),
    getEntity: db.prepare('SELECT data FROM entities WHERE type = ? AND id = ?'),
    listEntitiesByType: db.prepare('SELECT data FROM entities WHERE type = ?'),
    listEntitiesByWorkspace: db.prepare('SELECT data FROM entities WHERE type = ? AND workspace_id = ?'),

    insertNotification: db.prepare(
      'INSERT INTO notifications (id, user_id, data, is_read, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    listNotifications: db.prepare(
      'SELECT id, data, is_read FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ),
    markNotifRead: db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?'),
    markAllNotifReadFor: db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?'),
    trimUserNotifications: db.prepare(
      'DELETE FROM notifications WHERE id IN (' +
      '  SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?' +
      ')'
    ),

    insertReset: db.prepare(
      'INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    getReset: db.prepare('SELECT user_id, expires_at, used FROM password_resets WHERE token = ?'),
    markResetUsed: db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?'),
    cleanupResets: db.prepare('DELETE FROM password_resets WHERE used = 1 OR expires_at < ?'),

    getKv: db.prepare('SELECT v FROM kv WHERE k = ?'),
    setKv: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
  };

  // ── ENTIDADES ──
  // Extrator de workspace_id pra cada tipo. Entidades globais devolvem null.
  function workspaceIdOf(type, entity) {
    if (!entity) return null;
    if (type === 'workspaces' || type === 'roles' || type === 'users') return null;
    return entity.workspaceId || null;
  }

  function upsert(type, entity) {
    if (!entity || !entity.id) throw new Error('upsert: entity sem id');
    const wsId = workspaceIdOf(type, entity);
    stmts.upsertEntity.run(type, entity.id, wsId, JSON.stringify(entity), Date.now());
  }
  function upsertMany(type, list) {
    const tx = db.transaction(() => {
      for (const entity of list) upsert(type, entity);
    });
    tx();
  }
  function remove(type, id) {
    stmts.deleteEntity.run(type, id);
  }
  function get(type, id) {
    const row = stmts.getEntity.get(type, id);
    return row ? JSON.parse(row.data) : null;
  }
  function listByType(type) {
    return stmts.listEntitiesByType.all(type).map(r => JSON.parse(r.data));
  }
  function listByWorkspace(type, wsId) {
    return stmts.listEntitiesByWorkspace.all(type, wsId).map(r => JSON.parse(r.data));
  }

  // Carrega todas as entidades pra um objeto compatível com o `db` em memória
  // que o restante do código já espera (chaves: workspaces, users, demands, etc).
  function loadAllToCache() {
    const out = { notifications: [] }; // notifications viajam por endpoint dedicado
    for (const t of ENTITY_TYPES) out[t] = listByType(t);
    return out;
  }

  // ── NOTIFICAÇÕES ──
  function insertNotification(n) {
    stmts.insertNotification.run(
      n.id, n.userId,
      JSON.stringify(n),
      n.read ? 1 : 0,
      Date.parse(n.createdAt) || Date.now()
    );
  }
  function listNotificationsFor(userId, limit = 100) {
    return stmts.listNotifications.all(userId, limit).map(r => {
      const obj = JSON.parse(r.data);
      obj.read = !!r.is_read;
      return obj;
    });
  }
  function markNotificationRead(id) {
    stmts.markNotifRead.run(id);
  }
  function markAllNotificationsReadFor(userId) {
    stmts.markAllNotifReadFor.run(userId);
  }
  function trimNotificationsFor(userId, keep) {
    stmts.trimUserNotifications.run(userId, keep);
  }

  // ── PASSWORD RESETS ──
  function insertReset(rec) {
    stmts.insertReset.run(
      rec.token, rec.userId, rec.expiresAt, rec.used ? 1 : 0,
      Date.parse(rec.createdAt) || Date.now()
    );
  }
  function getReset(token) {
    const r = stmts.getReset.get(token);
    if (!r) return null;
    return { userId: r.user_id, expiresAt: r.expires_at, used: !!r.used };
  }
  function markResetUsed(token) {
    stmts.markResetUsed.run(token);
  }
  function cleanupResets() {
    stmts.cleanupResets.run(Date.now());
  }

  // ── KV simples (versão de schema, flags) ──
  function getKv(k) {
    const r = stmts.getKv.get(k);
    return r ? r.v : null;
  }
  function setKv(k, v) {
    stmts.setKv.run(k, String(v));
  }

  // ── MIGRAÇÃO ── importa um objeto db.json antigo pra dentro do SQLite
  function importJson(jsonDb) {
    if (!jsonDb || typeof jsonDb !== 'object') return { imported: 0 };
    const tx = db.transaction(() => {
      let total = 0;
      for (const t of ENTITY_TYPES) {
        const arr = Array.isArray(jsonDb[t]) ? jsonDb[t] : [];
        for (const ent of arr) {
          upsert(t, ent);
          total++;
        }
      }
      for (const n of (jsonDb.notifications || [])) {
        if (n && n.id && n.userId) {
          try { insertNotification(n); } catch { /* já existe */ }
          total++;
        }
      }
      for (const r of (jsonDb.passwordResets || [])) {
        if (r && r.token) {
          try { insertReset(r); } catch { /* já existe */ }
          total++;
        }
      }
      return total;
    });
    return { imported: tx() };
  }

  function close() { db.close(); }

  return {
    upsert, upsertMany, remove, get, listByType, listByWorkspace,
    loadAllToCache,
    insertNotification, listNotificationsFor, markNotificationRead,
    markAllNotificationsReadFor, trimNotificationsFor,
    insertReset, getReset, markResetUsed, cleanupResets,
    getKv, setKv,
    importJson,
    close,
    _raw: db // exposto pra inspeção em testes
  };
}

module.exports = { createStore, ENTITY_TYPES };
