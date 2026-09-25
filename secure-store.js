/* ───────────────────────────────────────────────────────────────
   reWork — Armazenamento seguro de credenciais
   Senhas (hash+salt), sessões e chaves de acesso (WebAuthn) ficam em
   memória e são gravadas no Postgres (tabelas auth_*, ver db-store.js):
     - senha: {salt, hash} cifrado com a chave mestra (AES-256-GCM) — um
       vazamento só do banco não expõe nem os hashes;
     - sessão: só o SHA-256 do token; o token em si vive apenas no cookie.

   A API continua síncrona (requireAuth, login etc. não mudam): a leitura é
   da memória e a gravação vai pra uma fila serial em segundo plano.

   Transição do data/auth.enc (formato antigo):
     - No boot, se o arquivo existe e ainda não foi importado — ou foi
       regravado depois da última escrita desta versão (ex.: rollback pra
       uma versão antiga) — o conteúdo é importado pro banco.
     - Enquanto a transição durar, o auth.enc continua sendo regravado com
       as senhas e chaves (sem sessões). Um rollback mantém todo mundo com a
       senha atual; só pede login de novo. Remover depois que a etapa de
       organizações estiver estável.
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// KASTOR_DATA_DIR (mesma var que o server) permite isolar dados em testes/prod.
const DATA_DIR  = process.env.KASTOR_DATA_DIR || path.join(__dirname, 'data');
const AUTH_PATH = path.join(DATA_DIR, 'auth.enc');
const KEY_PATH  = path.join(DATA_DIR, 'secret.key');

/* Chave mestra: usa FLUXO_SECRET (variável de ambiente) se existir;
   caso contrário, gera uma chave aleatória e guarda em data/secret.key.
   Faça backup desse arquivo — sem ele as senhas ficam ilegíveis. */
function masterKey() {
  let secret = process.env.FLUXO_SECRET;
  if (!secret) {
    try {
      secret = fs.readFileSync(KEY_PATH, 'utf8').trim();
    } catch {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(KEY_PATH, secret, { mode: 0o600 });
    }
  }
  return crypto.scryptSync(secret, 'fluxo-auth-store', 32);
}

const KEY = masterKey();

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const iv  = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/* Estado em memória. `credentials` e `webauthn` mantêm o formato antigo
   (o server ainda acessa via _store() na migração de bases muito antigas). */
let store = { credentials: {}, webauthn: {} };
const sessions = new Map(); // tokenHash → { tokenHash, userId, createdAt, expiresAt, lastSeenAt, data }

/* ── Persistência ── */
let backend = null;              // db-store (createStore)
let _chain = Promise.resolve();  // fila serial de escritas no banco
let _failures = 0;
function persist(label, fn) {
  if (!backend) return;
  _chain = _chain.then(() => fn(backend)).catch(e => {
    _failures++;
    console.error(`[auth] falha ao gravar (${label}):`, e.message);
  });
}

// auth.enc de transição: senhas + chaves, sem sessões.
let _fileTimer = null;
function writeLegacyFile() {
  clearTimeout(_fileTimer);
  _fileTimer = setTimeout(() => { _fileTimer = null; writeLegacyFileNow(); }, 200);
}

/* Espera as escritas pendentes (shutdown). */
async function flush() {
  if (_fileTimer) { clearTimeout(_fileTimer); _fileTimer = null; writeLegacyFileNow(); }
  await _chain;
}
function writeLegacyFileNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = AUTH_PATH + '.tmp';
    fs.writeFileSync(tmp, encrypt({ credentials: store.credentials, tokens: [], webauthn: store.webauthn }), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_PATH);
    const mtime = fs.statSync(AUTH_PATH).mtimeMs;
    persist('auth.enc mtime', b => b.setKv('auth:encMtime', String(mtime)));
  } catch (e) { console.error('[auth] falha ao gravar auth.enc:', e.message); }
}

/* Lê o auth.enc no formato antigo. Devolve null se não existe; lança se
   existe mas não abre (chave mestra diferente). */
function readLegacyFile() {
  let raw;
  try { raw = fs.readFileSync(AUTH_PATH, 'utf8'); } catch { return null; }
  const data = decrypt(raw);
  return {
    credentials: data.credentials || {},
    tokens: Array.isArray(data.tokens) ? data.tokens : [],
    webauthn: data.webauthn || {}
  };
}

async function importLegacy(legacy, b) {
  const now = Date.now();
  let nc = 0, ns = 0, nw = 0;
  await b.transaction(async client => {
    for (const [userId, c] of Object.entries(legacy.credentials)) {
      if (!c || !c.salt || !c.hash) continue;
      await b.authUpsertCredential(userId, encrypt({ salt: c.salt, hash: c.hash }), client);
      nc++;
    }
    for (const t of legacy.tokens) {
      if (!t || !t.token || !t.userId) continue;
      const expiresAt = t.expiresAt || now + SESSION_TTL_MS;
      if (expiresAt <= now) continue;
      await b.authUpsertSession({
        tokenHash: hashToken(t.token), userId: t.userId,
        createdAt: Date.parse(t.createdAt) || now, expiresAt, lastSeenAt: null, data: {}
      }, client);
      ns++;
    }
    for (const [userId, list] of Object.entries(legacy.webauthn)) {
      for (const c of (Array.isArray(list) ? list : [])) {
        if (!c || !c.credentialID) continue;
        await b.authUpsertWebauthn(userId, c.credentialID, c, client);
        nw++;
      }
    }
  });
  console.log(`  [auth] importado do auth.enc: ${nc} senha(s), ${ns} sessão(ões), ${nw} chave(s) de acesso`);
}

/* Boot: importa o auth.enc quando preciso e carrega tudo do banco. */
async function init(dbStore) {
  backend = dbStore;
  let st = null;
  try { st = fs.statSync(AUTH_PATH); } catch {}
  const migrated = await backend.getKv('auth:migrated');
  const ownMtime = Number(await backend.getKv('auth:encMtime')) || 0;
  if (st && (!migrated || st.mtimeMs > ownMtime + 1)) {
    let legacy = null;
    try { legacy = readLegacyFile(); }
    catch (e) {
      // Chave mestra errada: não marca como importado — um boot com a chave
      // certa ainda consegue importar.
      console.error('[auth] auth.enc existe mas não abre com a chave atual (FLUXO_SECRET / secret.key). Nada importado.', e.message);
    }
    if (legacy) {
      await importLegacy(legacy, backend);
      await backend.setKv('auth:migrated', new Date().toISOString());
    }
  } else if (!migrated) {
    await backend.setKv('auth:migrated', new Date().toISOString());
  }

  const rows = await backend.authLoadAll();
  const credentials = {};
  let bad = 0;
  for (const r of rows.credentials) {
    try { credentials[r.user_id] = decrypt(r.secret); } catch { bad++; }
  }
  if (bad) console.error(`[auth] ${bad} senha(s) não abriram com a chave atual — confira FLUXO_SECRET / secret.key`);
  const webauthn = {};
  for (const r of rows.webauthn) {
    (webauthn[r.user_id] = webauthn[r.user_id] || []).push(r.data);
  }
  store = { credentials, webauthn };
  sessions.clear();
  const now = Date.now();
  for (const r of rows.sessions) {
    const expiresAt = r.expires_at != null ? Number(r.expires_at) : null;
    if (expiresAt && expiresAt <= now) continue;
    sessions.set(r.token_hash, {
      tokenHash: r.token_hash, userId: r.user_id,
      createdAt: Number(r.created_at), expiresAt,
      lastSeenAt: r.last_seen_at != null ? Number(r.last_seen_at) : null,
      data: r.data || {}
    });
  }
  // Limpeza periódica de sessões vencidas (memória + banco).
  setInterval(cleanupExpired, 60 * 60 * 1000).unref();
  return { credentials: Object.keys(credentials).length, sessions: sessions.size };
}

/* ── Senhas ── */
function setPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  store.credentials[userId] = { salt, hash };
  persist('senha', b => b.authUpsertCredential(userId, encrypt({ salt, hash })));
  writeLegacyFile();
}
function verifyPassword(userId, password) {
  const c = store.credentials[userId];
  if (!c || !c.salt || !c.hash) return false;
  const test = crypto.scryptSync(String(password), c.salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(c.hash, 'hex'));
  } catch { return false; }
}
function hasPassword(userId) { return !!store.credentials[userId]; }
/* Senha no formato antigo (embutida no usuário em bases muito antigas). */
function importLegacyCredential(userId, salt, hash) {
  if (store.credentials[userId] || !salt || !hash) return;
  store.credentials[userId] = { salt, hash };
  persist('senha antiga', b => b.authUpsertCredential(userId, encrypt({ salt, hash })));
  writeLegacyFile();
}
function removeCredentials(userId) {
  delete store.credentials[userId];
  persist('remover senha', b => b.authDeleteCredential(userId));
  dropTokensFor(userId);
  writeLegacyFile();
}

/* ── Sessões ──
   TTL configurável via KASTOR_SESSION_DAYS (padrão 30 dias). No máximo 10
   sessões por pessoa (a mais antiga sai). `data` guarda metadados da sessão
   (ip, navegador; depois, a organização ativa). */
const SESSION_TTL_MS = (Number(process.env.KASTOR_SESSION_DAYS) > 0 ? Number(process.env.KASTOR_SESSION_DAYS) : 30) * 24 * 60 * 60 * 1000;
const SESSIONS_PER_USER = 10;
const TOUCH_EVERY_MS = 10 * 60 * 1000;

function cleanupExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [h, s] of sessions) {
    if (s.expiresAt && s.expiresAt <= now) { sessions.delete(h); removed++; }
  }
  if (removed) persist('limpar sessões', b => b.authDeleteExpiredSessions(now));
}
function addToken(userId, data = {}, opts = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : SESSION_TTL_MS;
  const rec = { tokenHash: hashToken(token), userId, createdAt: now, expiresAt: now + ttl, lastSeenAt: now, data: { ...data } };
  sessions.set(rec.tokenHash, rec);
  persist('nova sessão', b => b.authUpsertSession(rec));
  const mine = [...sessions.values()].filter(s => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  for (const old of mine.slice(0, Math.max(0, mine.length - SESSIONS_PER_USER))) {
    sessions.delete(old.tokenHash);
    persist('sessão antiga', b => b.authDeleteSession(old.tokenHash));
  }
  return token;
}
function sessionForToken(token) {
  if (!token) return null;
  const s = sessions.get(hashToken(token));
  if (!s) return null;
  const now = Date.now();
  if (s.expiresAt && s.expiresAt <= now) return null;
  if (!s.lastSeenAt || now - s.lastSeenAt > TOUCH_EVERY_MS) {
    s.lastSeenAt = now;
    persist('sessão vista', b => b.authUpsertSession(s));
  }
  return s;
}
function userIdForToken(token) {
  const s = sessionForToken(token);
  return s ? s.userId : null;
}
function setSessionData(token, patch) {
  const s = sessionForToken(token);
  if (!s) return;
  s.data = { ...(s.data || {}), ...patch };
  persist('dados da sessão', b => b.authUpsertSession(s));
}
function listSessions(userId) {
  const now = Date.now();
  return [...sessions.values()]
    .filter(s => s.userId === userId && (!s.expiresAt || s.expiresAt > now))
    .sort((a, b) => (b.lastSeenAt || b.createdAt) - (a.lastSeenAt || a.createdAt));
}
/* Último acesso de cada pessoa (maior lastSeenAt entre as sessões vivas). */
function lastSeenByUser() {
  const out = new Map();
  for (const s of sessions.values()) {
    const t = s.lastSeenAt || s.createdAt || 0;
    if (t > (out.get(s.userId) || 0)) out.set(s.userId, t);
  }
  return out;
}
function activeSessionCount(filter) {
  const now = Date.now();
  let n = 0;
  for (const s of sessions.values()) if ((!s.expiresAt || s.expiresAt > now) && (!filter || filter(s))) n++;
  return n;
}
function removeToken(token) {
  if (!token) return;
  const h = hashToken(token);
  sessions.delete(h);
  persist('encerrar sessão', b => b.authDeleteSession(h));
}
/* Encerra todas as sessões da pessoa (menos, opcionalmente, a atual). */
function dropTokensFor(userId, exceptToken) {
  const keep = exceptToken ? hashToken(exceptToken) : null;
  for (const [h, s] of sessions) {
    if (s.userId === userId && h !== keep) sessions.delete(h);
  }
  persist('encerrar sessões', b => b.authDeleteSessionsForUser(userId, keep));
}
/* Sessão no formato antigo (tokens que viviam no db.json em bases muito antigas). */
function importLegacyToken(t) {
  if (!t || !t.token || !t.userId) return;
  const now = Date.now();
  const expiresAt = t.expiresAt || now + SESSION_TTL_MS;
  if (expiresAt <= now) return;
  const rec = { tokenHash: hashToken(t.token), userId: t.userId, createdAt: Date.parse(t.createdAt) || now, expiresAt, lastSeenAt: null, data: {} };
  sessions.set(rec.tokenHash, rec);
  persist('sessão antiga', b => b.authUpsertSession(rec));
}

/* ── Encriptação de strings arbitrárias ──
   Usado pelo cofre de senhas (/api/passwords) e pelos convites pra guardar
   valores sem plaintext. Reversível enquanto a chave mestra estiver intacta. */
function encryptString(plain) {
  if (plain == null) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptString(b64) {
  if (!b64) return '';
  const raw = Buffer.from(String(b64), 'base64');
  const iv  = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

/* ── WebAuthn: credenciais por usuário ──
   Lista por userId com { credentialID, publicKey, counter, name, createdAt,
   transports }. Campos binários em base64url. O `counter` é atualizado a
   cada assertion pra prevenir replay. */
function webauthnList(userId) {
  return Array.isArray(store.webauthn?.[userId]) ? store.webauthn[userId] : [];
}
function webauthnAdd(userId, cred) {
  if (!store.webauthn) store.webauthn = {};
  if (!Array.isArray(store.webauthn[userId])) store.webauthn[userId] = [];
  store.webauthn[userId].push(cred);
  persist('chave de acesso', b => b.authUpsertWebauthn(userId, cred.credentialID, cred));
  writeLegacyFile();
}
function webauthnFind(userId, credentialID) {
  return webauthnList(userId).find(c => c.credentialID === credentialID) || null;
}
function webauthnUpdateCounter(userId, credentialID, counter) {
  const c = webauthnFind(userId, credentialID);
  if (!c) return;
  c.counter = counter;
  c.lastUsedAt = new Date().toISOString();
  persist('chave de acesso', b => b.authUpsertWebauthn(userId, credentialID, c));
  writeLegacyFile();
}
function webauthnRemove(userId, credentialID) {
  const arr = webauthnList(userId);
  const next = arr.filter(c => c.credentialID !== credentialID);
  if (!store.webauthn) store.webauthn = {};
  store.webauthn[userId] = next;
  persist('remover chave', b => b.authDeleteWebauthn(userId, credentialID));
  writeLegacyFile();
  return arr.length !== next.length;
}
function webauthnRemoveAll(userId) {
  if (store.webauthn) delete store.webauthn[userId];
  persist('remover chaves', b => b.authDeleteWebauthn(userId, null));
  writeLegacyFile();
}

module.exports = {
  init, flush,
  setPassword, verifyPassword, hasPassword, removeCredentials, importLegacyCredential,
  addToken, userIdForToken, sessionForToken, setSessionData, listSessions, lastSeenByUser, activeSessionCount,
  removeToken, dropTokensFor, importLegacyToken, hashToken,
  encryptString, decryptString,
  webauthnList, webauthnAdd, webauthnFind, webauthnUpdateCounter, webauthnRemove, webauthnRemoveAll,
  _store: () => store,
  _failures: () => _failures
};
