/* ═══════════════════════════════════════════════════════════════════════
   discord-oauth.js — login e vínculo de conta via Discord OAuth2

   Independente do bot (discord-bot.js). O bot manda DMs; este módulo só
   descobre o snowflake do usuário no callback OAuth pra resolver login
   ou gravar u.discordId. Usa `scope=identify` (não pede email — o Discord
   já retorna username+global_name+avatar).

   Modo dormente: se DISCORD_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI não
   estiverem setados, isConfigured() retorna false e o server esconde os
   botões (sem 500 pro usuário).

   State CSRF: Map<state, { mode, userId, createdAt }>. mode = 'login'
   (start público, sem auth) ou 'link' (start com auth, grava discordId
   no user logado). TTL 10min. Em memória serve pra single-instance;
   multi-instance move pra Postgres na Fase 3 do SCALING.md.
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL     = 'https://discord.com/api/v10/oauth2/token';
const USERS_ME_URL  = 'https://discord.com/api/v10/users/@me';
const SCOPES = ['identify'];

const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

function makeState(mode, userId) {
  pruneStates();
  const token = crypto.randomBytes(16).toString('hex');
  stateStore.set(token, { mode, userId: userId || null, createdAt: Date.now() });
  return token;
}

function popState(token) {
  pruneStates();
  const entry = stateStore.get(token);
  if (entry) stateStore.delete(token);
  return entry || null;
}

function isConfigured() {
  return !!(process.env.DISCORD_OAUTH_CLIENT_ID
         && process.env.DISCORD_OAUTH_CLIENT_SECRET
         && process.env.DISCORD_OAUTH_REDIRECT_URI);
}

function getAuthUrl(state) {
  if (!isConfigured()) {
    throw new Error('Discord OAuth não configurado. Defina DISCORD_OAUTH_CLIENT_ID, DISCORD_OAUTH_CLIENT_SECRET e DISCORD_OAUTH_REDIRECT_URI.');
  }
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_OAUTH_CLIENT_ID,
    redirect_uri: process.env.DISCORD_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    // prompt=none pula a tela de consentimento se o user já autorizou antes
    // (login recorrente vira 1-clique). Discord ignora se ainda não autorizou.
    prompt: 'none',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/* Troca `code` por access_token e devolve o profile do Discord.
   Devolve { id, username, global_name, avatar_url } — id é o snowflake.
   Nunca guardamos o access_token; ele é one-shot pra pegar o id e some. */
async function exchangeCodeForProfile(code) {
  if (!isConfigured()) throw new Error('Discord OAuth não configurado.');
  const form = new URLSearchParams({
    client_id: process.env.DISCORD_OAUTH_CLIENT_ID,
    client_secret: process.env.DISCORD_OAUTH_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.DISCORD_OAUTH_REDIRECT_URI,
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => '');
    throw new Error(`Discord token exchange falhou (${tokenRes.status}): ${txt.slice(0, 200)}`);
  }
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error('Discord não devolveu access_token.');

  const meRes = await fetch(USERS_ME_URL, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!meRes.ok) {
    const txt = await meRes.text().catch(() => '');
    throw new Error(`Discord /users/@me falhou (${meRes.status}): ${txt.slice(0, 200)}`);
  }
  const me = await meRes.json();
  if (!me.id || !/^\d{15,22}$/.test(me.id)) {
    throw new Error('Discord devolveu id inválido no /users/@me.');
  }
  let avatar_url = null;
  if (me.avatar) {
    const ext = String(me.avatar).startsWith('a_') ? 'gif' : 'png';
    avatar_url = `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.${ext}?size=128`;
  }
  return {
    id: me.id,
    username: me.username || null,
    global_name: me.global_name || null,
    avatar_url,
  };
}

module.exports = {
  isConfigured,
  makeState,
  popState,
  getAuthUrl,
  exchangeCodeForProfile,
};
