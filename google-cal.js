/* ───────────────────────────────────────────────────────────────
   KASTOR — Google Calendar integration (one-way, read-only)

   Isola toda a comunicação com Google (OAuth + Calendar API) num módulo só
   pra não poluir server.js. Fase 1 cobre autenticação e listagem de
   calendários. Sync de eventos vem na Fase 2.

   Escopos: readonly do Calendar + email/profile básico pra identificar
   a conta conectada.
   ─────────────────────────────────────────────────────────────── */
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// CSRF state store: token → { userId, createdAt }. TTL 10min.
// Em memória serve pra localhost/single-instance; pra multi-instance depois
// migramos pra tabela ou Redis.
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

function makeState(userId) {
  pruneStates();
  const token = crypto.randomBytes(16).toString('hex');
  stateStore.set(token, { userId, createdAt: Date.now() });
  return token;
}

function popState(token) {
  pruneStates();
  const entry = stateStore.get(token);
  if (entry) stateStore.delete(token);
  return entry || null;
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function makeOAuth2Client() {
  if (!isConfigured()) {
    throw new Error('Google Calendar não configurado. Defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI no ambiente.');
  }
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// URL de consentimento — `access_type: 'offline'` + `prompt: 'consent'`
// garantem que o Google emita um refresh_token (sem eles, só access_token,
// que expira em 1h e mata a integração no dia seguinte).
function getAuthUrl(state) {
  const client = makeOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true
  });
}

// Troca o `code` do callback pelos tokens (access + refresh).
async function exchangeCode(code) {
  const client = makeOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Cria um client autenticado com os tokens salvos do usuário.
// Se `onTokenRefresh` for passado, é chamado quando o access_token é
// renovado automaticamente — o caller deve persistir os novos tokens.
function makeAuthedClient(tokens, onTokenRefresh) {
  const client = makeOAuth2Client();
  client.setCredentials(tokens);
  if (typeof onTokenRefresh === 'function') {
    client.on('tokens', (fresh) => {
      // Google só emite tokens novos quando faz refresh — mescla com o
      // refresh_token que já temos (o novo pacote pode não trazê-lo).
      const merged = { ...tokens, ...fresh };
      if (!fresh.refresh_token && tokens.refresh_token) merged.refresh_token = tokens.refresh_token;
      onTokenRefresh(merged);
    });
  }
  return client;
}

async function getUserInfo(tokens) {
  const client = makeAuthedClient(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const r = await oauth2.userinfo.get();
  return {
    email: r.data.email || null,
    name: r.data.name || null,
    picture: r.data.picture || null
  };
}

async function listCalendars(tokens, onTokenRefresh) {
  const client = makeAuthedClient(tokens, onTokenRefresh);
  const cal = google.calendar({ version: 'v3', auth: client });
  const r = await cal.calendarList.list({ maxResults: 250 });
  return (r.data.items || []).map(c => ({
    id: c.id,
    summary: c.summary || c.id,
    description: c.description || '',
    primary: !!c.primary,
    backgroundColor: c.backgroundColor || null,
    foregroundColor: c.foregroundColor || null,
    accessRole: c.accessRole || 'reader'
  }));
}

// Revoga o access_token no Google (best-effort — se falhar, apagamos
// os tokens localmente do mesmo jeito).
async function revokeTokens(tokens) {
  if (!tokens || !tokens.access_token) return;
  try {
    const client = makeOAuth2Client();
    client.setCredentials(tokens);
    await client.revokeCredentials();
  } catch (e) {
    // Ignorável — o importante é o unlink local
    console.debug('[google-cal] revoke falhou (ignorado):', e.message);
  }
}

/* ── SYNC ENGINE ────────────────────────────────────────────
   Estratégia:
   - Primeira sync sem syncToken: usa timeMin/timeMax (6 meses atrás → 12 meses
     à frente) + singleEvents:true (expande recorrências em ocorrências).
   - Syncs seguintes: usa syncToken que a Google devolve — traz só delta.
   - Se syncToken expira (410 Gone), sinaliza expired=true pra caller fazer
     full re-sync limpando o token guardado.
   Pagina automaticamente via pageToken até esgotar. */
async function syncCalendar(tokens, calendarId, syncToken, onTokenRefresh) {
  const client = makeAuthedClient(tokens, onTokenRefresh);
  const cal = google.calendar({ version: 'v3', auth: client });

  const events = [];
  let pageToken = null;
  let nextSyncToken = null;

  const baseParams = {
    calendarId,
    maxResults: 250,
    showDeleted: true // eventos cancelados vêm com status: 'cancelled' — usamos pra remover local
  };
  if (syncToken) {
    baseParams.syncToken = syncToken;
  } else {
    const now = new Date();
    const timeMin = new Date(now); timeMin.setMonth(now.getMonth() - 6);
    const timeMax = new Date(now); timeMax.setMonth(now.getMonth() + 12);
    baseParams.timeMin = timeMin.toISOString();
    baseParams.timeMax = timeMax.toISOString();
    baseParams.singleEvents = true;
    baseParams.orderBy = 'startTime';
  }

  const MAX_PAGES = 40; // guarda contra loop infinito
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = { ...baseParams };
    if (pageToken) params.pageToken = pageToken;
    try {
      const r = await cal.events.list(params);
      if (Array.isArray(r.data.items)) events.push(...r.data.items);
      if (r.data.nextPageToken) { pageToken = r.data.nextPageToken; continue; }
      nextSyncToken = r.data.nextSyncToken || null;
      break;
    } catch (e) {
      // 410 Gone → syncToken expirou (após ~30 dias sem uso).
      if ((e.code === 410 || e.response?.status === 410) && syncToken) {
        return { events: [], nextSyncToken: null, expired: true };
      }
      throw e;
    }
  }
  return { events, nextSyncToken, expired: false };
}

// Converte o payload cru da Google pro shape local. Tolera eventos parciais
// (só start, sem end etc) — nada quebra se algum campo faltar.
function normalizeEvent(raw, calendarId, calendarColor) {
  const isAllDay = !!(raw.start && raw.start.date);
  const start = isAllDay ? raw.start.date : (raw.start && raw.start.dateTime) || null;
  const end   = isAllDay ? (raw.end && raw.end.date) : (raw.end && raw.end.dateTime) || null;
  return {
    googleEventId: raw.id,
    calendarId,
    summary: raw.summary || '(Sem título)',
    start,
    end,
    allDay: isAllDay,
    status: raw.status || 'confirmed',
    htmlLink: raw.htmlLink || null,
    recurringEventId: raw.recurringEventId || null,
    backgroundColor: calendarColor || '#4285F4',
    // Fonte pro cliente exibir botão "Entrar na reunião" com ícone correto.
    // Prioridade: hangoutLink (Meet nativo) → conferenceData.entryPoints (Meet/Zoom
    // configurado via conference) → location → description (regex de URL).
    meeting: detectMeeting(raw),
    updated: raw.updated || null
  };
}

function detectMeeting(raw) {
  if (raw.hangoutLink) return { url: raw.hangoutLink, kind: 'meet' };
  const eps = (raw.conferenceData && raw.conferenceData.entryPoints) || [];
  const video = eps.find(e => e && e.entryPointType === 'video' && e.uri);
  if (video) return { url: video.uri, kind: detectKindFromUrl(video.uri) };
  // Scan location + description por URLs conhecidas
  const text = (raw.location || '') + '\n' + (raw.description || '');
  const urls = text.match(/https?:\/\/[^\s<>"'\)]+/gi) || [];
  for (const url of urls) {
    const k = detectKindFromUrl(url);
    if (k !== 'other') return { url: url.replace(/[.,;)]+$/, ''), kind: k };
  }
  return null;
}
function detectKindFromUrl(url) {
  if (/meet\.google\.com/i.test(url)) return 'meet';
  if (/zoom\.us/i.test(url)) return 'zoom';
  if (/teams\.microsoft\.com|teams\.live\.com/i.test(url)) return 'teams';
  return 'other';
}

module.exports = {
  isConfigured,
  makeState,
  popState,
  getAuthUrl,
  exchangeCode,
  makeAuthedClient,
  getUserInfo,
  listCalendars,
  revokeTokens,
  syncCalendar,
  normalizeEvent,
  SCOPES
};
