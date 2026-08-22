/* ═══════════════════════════════════════════════════════════════════════
   discord-bot.js — helper HTTP pra Discord Bot API v10
   Modo dormente: se DISCORD_BOT_TOKEN não estiver setado, isEnabled()
   retorna false e todas as chamadas viram no-ops (retornam null/false).
   O caller SEMPRE chama; a decisão de habilitar é aqui, num único ponto.

   Cache in-memory (24h TTL) pra:
     - Resolução de userId → { username, global_name, avatar_url }
     - DM channel_id por userId (Discord garante que é estável, evita
       segunda request por DM já iniciado)

   Rate limits: Bot tem ~50 req/s globais. Cache resolve ~99% das
   consultas de mini-card. DMs raramente ultrapassam poucos/segundo
   em uso normal, então não implementamos throttle. Se estourar,
   Discord devolve 429 com Retry-After — logamos e desistimos daquele
   send (nunca reenfileira/reretenta pra não amplificar surto).
   ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN || null;

/* Caches — Map<key, { value, expiresAt }>. Purged on read (lazy TTL). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _userCache = new Map();       // key: discordId, value: { username, global_name, avatar_url } | null (miss cached)
const _dmChannelCache = new Map();  // key: discordId, value: channel_id

function _readCache(cache, key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { cache.delete(key); return undefined; }
  return hit.value;
}
function _writeCache(cache, key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function isEnabled() { return !!TOKEN; }

/* Requisição HTTP autenticada. Nunca throws — retorna { ok, status, data }.
   Chamadas mudas (bot off) devolvem { ok: false, status: 0, data: null }. */
async function _request(path, opts = {}) {
  if (!TOKEN) return { ok: false, status: 0, data: null };
  const url = API_BASE + path;
  const headers = {
    'Authorization': 'Bot ' + TOKEN,
    'User-Agent': 'Kastor (https://github.com/andrigooliveira/Kastor, 1.0)',
    ...(opts.headers || {}),
  };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  try {
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    // 204 e alguns 4xx sem body — tenta parsear, ignora se vazio
    const txt = await r.text();
    if (txt) { try { data = JSON.parse(txt); } catch { data = { raw: txt }; } }
    if (!r.ok) {
      console.warn(`[discord-bot] ${opts.method || 'GET'} ${path} → ${r.status}${data?.message ? ' · ' + data.message : ''}`);
    }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    console.error(`[discord-bot] ${opts.method || 'GET'} ${path} threw:`, e.message);
    return { ok: false, status: -1, data: null };
  }
}

/* Resolve um userId (snowflake) pro perfil público do Discord.
   Retorna:
     { id, username, global_name, avatar_url } quando o bot enxerga o user
     null se 404 (usuário inexistente) ou 403 (bot sem permissão)
   Cache 24h — inclui misses (null) pra não bombardear a API com IDs inválidos. */
async function getUser(discordId) {
  if (!isEnabled()) return null;
  if (typeof discordId !== 'string' || !/^\d{15,22}$/.test(discordId)) return null;
  const cached = _readCache(_userCache, discordId);
  if (cached !== undefined) return cached;
  const r = await _request('/users/' + discordId);
  if (!r.ok || !r.data || !r.data.id) {
    _writeCache(_userCache, discordId, null);
    return null;
  }
  const u = r.data;
  // avatar hash → URL do CDN. Gif se hash começa com "a_", senão png.
  let avatar_url = null;
  if (u.avatar) {
    const ext = String(u.avatar).startsWith('a_') ? 'gif' : 'png';
    avatar_url = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${ext}?size=128`;
  }
  const value = {
    id: u.id,
    username: u.username || null,
    global_name: u.global_name || null,
    avatar_url,
  };
  _writeCache(_userCache, discordId, value);
  return value;
}

/* Envia mensagem/embed em um canal público. `payload` segue o schema
   do Discord (content/embeds/allowed_mentions). Retorna true/false. */
async function sendChannelMessage(channelId, payload) {
  if (!isEnabled()) return false;
  if (!channelId) return false;
  const r = await _request(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: payload,
  });
  return r.ok;
}

/* Abre (ou reusa) o DM channel do bot com um usuário e envia. Duas requests
   na primeira vez (POST /users/@me/channels + POST /channels/:id/messages),
   uma única nas subsequentes (channel_id em cache).
   Retorna true/false. */
async function sendDM(discordUserId, payload) {
  if (!isEnabled()) return false;
  if (!discordUserId) return false;
  let channelId = _readCache(_dmChannelCache, discordUserId);
  if (!channelId) {
    const r = await _request('/users/@me/channels', {
      method: 'POST',
      body: { recipient_id: String(discordUserId) },
    });
    if (!r.ok || !r.data?.id) return false;
    channelId = r.data.id;
    _writeCache(_dmChannelCache, discordUserId, channelId);
  }
  return sendChannelMessage(channelId, payload);
}

/* Invalida o cache pra um user específico (usado após admin trocar o
   discordId de alguém no perfil — próximo lookup ressolve fresco). */
function invalidateUser(discordId) {
  _userCache.delete(discordId);
  _dmChannelCache.delete(discordId);
}

/* ID do próprio bot — cacheado (imutável durante o processo). Usado pra
   filtrar mensagens que sejam do bot no clearBotDMs. */
let _botUserIdCache = null;
async function getBotUserId() {
  if (_botUserIdCache) return _botUserIdCache;
  if (!isEnabled()) return null;
  const r = await _request('/users/@me');
  if (r.ok && r.data?.id) { _botUserIdCache = r.data.id; return _botUserIdCache; }
  return null;
}

/* Apaga as mensagens que o bot enviou nas DMs com um usuário específico.
   Discord DMs não têm bulk-delete — cada mensagem é uma request. Rate limit
   por canal é ~5 req/s; usamos 1 req a cada 250ms pra ficar bem abaixo.
   `maxPages` limita o total de páginas de 100 mensagens (default 5 = até 500).
   Retorna { deleted, scanned }. */
async function clearBotDMs(discordUserId, { maxPages = 5, perDeleteMs = 250 } = {}) {
  if (!isEnabled()) return { deleted: 0, scanned: 0, error: 'bot_disabled' };
  const botId = await getBotUserId();
  if (!botId) return { deleted: 0, scanned: 0, error: 'no_bot_id' };
  let channelId = _readCache(_dmChannelCache, discordUserId);
  if (!channelId) {
    const r = await _request('/users/@me/channels', {
      method: 'POST', body: { recipient_id: String(discordUserId) },
    });
    if (!r.ok || !r.data?.id) return { deleted: 0, scanned: 0, error: 'no_dm_channel' };
    channelId = r.data.id;
    _writeCache(_dmChannelCache, discordUserId, channelId);
  }

  let deleted = 0, scanned = 0, before = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    if (before) qs.set('before', before);
    const listResp = await _request(`/channels/${channelId}/messages?${qs}`);
    if (!listResp.ok || !Array.isArray(listResp.data)) break;
    const msgs = listResp.data;
    if (msgs.length === 0) break;
    scanned += msgs.length;
    // Só apaga mensagens do próprio bot — as do usuário Discord bloqueia mesmo
    // pra bot com Manage Messages em DM.
    const mine = msgs.filter(m => m && m.author && m.author.id === botId);
    for (const m of mine) {
      const del = await _request(`/channels/${channelId}/messages/${m.id}`, { method: 'DELETE' });
      if (del.ok) deleted++;
      await new Promise(r => setTimeout(r, perDeleteMs));
    }
    if (msgs.length < 100) break; // última página
    before = msgs[msgs.length - 1].id;
  }
  return { deleted, scanned };
}

module.exports = {
  isEnabled,
  getUser,
  sendChannelMessage,
  sendDM,
  invalidateUser,
  getBotUserId,
  clearBotDMs,
};
