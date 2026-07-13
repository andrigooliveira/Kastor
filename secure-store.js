/* ───────────────────────────────────────────────────────────────
   KASTOR — Armazenamento seguro de credenciais
   Mantém senhas (hash+salt) e tokens FORA do db.json, num arquivo
   criptografado (AES-256-GCM). db.json passa a guardar só dados de
   perfil — nada sensível.
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
   Faça backup desse arquivo junto com o auth.enc. */
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

let store = { credentials: {}, tokens: [] };

function load() {
  try {
    store = decrypt(fs.readFileSync(AUTH_PATH, 'utf8'));
  } catch {
    store = { credentials: {}, tokens: [] };
  }
  if (!store.credentials) store.credentials = {};
  if (!Array.isArray(store.tokens)) store.tokens = [];
  return store;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = AUTH_PATH + '.tmp';
    fs.writeFileSync(tmp, encrypt(store), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_PATH);
  }, 60);
}

/* ── Senhas ── */
function setPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  store.credentials[userId] = { salt, hash };
  save();
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
function removeCredentials(userId) {
  delete store.credentials[userId];
  store.tokens = store.tokens.filter(t => t.userId !== userId);
  save();
}

/* ── Tokens de sessão ──
   Cada token tem expiresAt (TTL configurável via KASTOR_SESSION_DAYS, padrão 30).
   userIdForToken devolve null se já expirou — caller cai pra 401 e cliente refaz login.
   Tokens expirados ficam no store até alguém pedir cleanup (próxima escrita compacta). */
const SESSION_TTL_MS = (Number(process.env.KASTOR_SESSION_DAYS) > 0 ? Number(process.env.KASTOR_SESSION_DAYS) : 30) * 24 * 60 * 60 * 1000;
function _cleanupExpired() {
  const now = Date.now();
  const before = store.tokens.length;
  store.tokens = store.tokens.filter(t => !t.expiresAt || t.expiresAt > now);
  return store.tokens.length !== before;
}
function addToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  store.tokens.push({
    token, userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + SESSION_TTL_MS
  });
  // Mantém só as 10 sessões mais recentes desse usuário (entre não-expiradas)
  _cleanupExpired();
  const mine = store.tokens.filter(t => t.userId === userId);
  if (mine.length > 10) {
    const keep = new Set(mine.slice(-10).map(t => t.token));
    store.tokens = store.tokens.filter(t => t.userId !== userId || keep.has(t.token));
  }
  save();
  return token;
}
function userIdForToken(token) {
  if (!token) return null;
  const t = store.tokens.find(x => x.token === token);
  if (!t) return null;
  // Token sem expiresAt = formato antigo, aceita por compat (será revalidado ao próximo login)
  if (t.expiresAt && t.expiresAt <= Date.now()) return null;
  return t.userId;
}
function removeToken(token) {
  store.tokens = store.tokens.filter(t => t.token !== token);
  save();
}
function dropTokensFor(userId) {
  store.tokens = store.tokens.filter(t => t.userId !== userId);
  save();
}

module.exports = {
  load, save,
  setPassword, verifyPassword, hasPassword, removeCredentials,
  addToken, userIdForToken, removeToken, dropTokensFor,
  _store: () => store
};
