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

/* Guilds em que o bot está presente. TTL 5min pra refletir invites novos
   sem precisar restart. Retorna [{ id, name, icon }]. */
let _guildsCache = null;
let _guildsCacheExpires = 0;
async function listGuilds() {
  if (!isEnabled()) return [];
  if (_guildsCache && Date.now() < _guildsCacheExpires) return _guildsCache;
  const r = await _request('/users/@me/guilds');
  if (!r.ok || !Array.isArray(r.data)) return [];
  _guildsCache = r.data.map(g => ({ id: g.id, name: g.name, icon: g.icon || null }));
  _guildsCacheExpires = Date.now() + 5 * 60 * 1000;
  return _guildsCache;
}

/* Canais de texto de um guild — filtra type 0 (GUILD_TEXT) e type 5
   (GUILD_ANNOUNCEMENT). Threads (10/11/12) e voz (2/13) ignorados —
   pra bot postar mensagem só faz sentido em canais de texto. TTL 5min. */
const _channelsCacheByGuild = new Map(); // guildId → { value, expiresAt }
async function listGuildChannels(guildId) {
  if (!isEnabled() || !guildId) return [];
  const cached = _channelsCacheByGuild.get(guildId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const r = await _request(`/guilds/${guildId}/channels`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  const TEXT_TYPES = new Set([0, 5]);
  const channels = r.data
    .filter(c => TEXT_TYPES.has(c.type))
    .map(c => ({ id: c.id, name: c.name, position: c.position, parent_id: c.parent_id || null }))
    .sort((a, b) => a.position - b.position);
  _channelsCacheByGuild.set(guildId, { value: channels, expiresAt: Date.now() + 5 * 60 * 1000 });
  return channels;
}

/* Força re-fetch dos canais/guilds no próximo lookup — usado após admin
   trocar o binding ou mover canais no Discord (webhook manual). */
function invalidateGuildsCache() {
  _guildsCache = null;
  _channelsCacheByGuild.clear();
}

/* ═══════════════════════════════════════════════════════════════════════
   Discord CHANNEL WEBHOOKS (não confundir com o webhook system LEGADO
   da Kastor — aquele é POST HTTP externo). Aqui usamos o webhook nativo
   do Discord dentro de um canal pra podermos postar com "persona" (nome
   e foto por mensagem). Bots normais têm 1 identidade global; via
   webhook, cada mensagem pode ter username/avatar_url próprios.
   Requer permissão MANAGE_WEBHOOKS no canal.
   ═══════════════════════════════════════════════════════════════════════ */

/* Cria um webhook em um canal. Retorna { id, token } ou null se falhar.
   `name` é o nome default do webhook (mostrado no Discord na config do
   canal). Cada mensagem depois pode sobrescrever username/avatar_url. */
async function createChannelWebhook(channelId, name) {
  if (!isEnabled() || !channelId) return null;
  const cleanName = String(name || 'reWork').trim().slice(0, 80) || 'reWork';
  const r = await _request(`/channels/${channelId}/webhooks`, {
    method: 'POST',
    body: { name: cleanName },
  });
  if (!r.ok || !r.data?.id || !r.data?.token) {
    console.warn('[discord-bot] createChannelWebhook falhou:', r.status, r.data?.message);
    return null;
  }
  return { id: r.data.id, token: r.data.token };
}

/* Deleta o webhook pelo id+token (não precisa auth do bot — token é a auth).
   Usado quando binding é removido ou o canal muda. Silencia erros. */
async function deleteChannelWebhook(webhookId, webhookToken) {
  if (!webhookId || !webhookToken) return false;
  try {
    const r = await fetch(`${API_BASE}/webhooks/${webhookId}/${webhookToken}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) {
    console.warn('[discord-bot] deleteChannelWebhook:', e.message);
    return false;
  }
}

/* Envia payload via webhook token — mensagem aparece com o username +
   avatar_url passados no payload, não com a identidade do bot. */
async function sendViaWebhook(webhookId, webhookToken, payload) {
  if (!webhookId || !webhookToken) return false;
  try {
    const r = await fetch(`${API_BASE}/webhooks/${webhookId}/${webhookToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Kastor (https://github.com/andrigooliveira/Kastor, 1.0)' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.warn('[discord-bot] sendViaWebhook falhou:', r.status);
    return r.ok;
  } catch (e) {
    console.warn('[discord-bot] sendViaWebhook:', e.message);
    return false;
  }
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
  listGuilds,
  listGuildChannels,
  invalidateGuildsCache,
  createChannelWebhook,
  deleteChannelWebhook,
  sendViaWebhook,
};
