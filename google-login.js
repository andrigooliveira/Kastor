/* ═══════════════════════════════════════════════════════════════════════
   google-login.js — entrar com Google (OAuth2 / OpenID Connect)

   Separado da integração do Google Agenda (google-cal.js): outro cliente
   OAuth, outras variáveis, e só os escopos básicos (openid email profile),
   que não passam pela verificação do Google. Nada de token guardado: o
   id_token serve só pra descobrir quem é a conta Google no callback.

   Modo dormente: sem GOOGLE_LOGIN_CLIENT_ID/SECRET/REDIRECT_URI,
   isConfigured() é false e o botão some da tela de entrada.

   State CSRF: Map<state, { mode, userId, createdAt }>. mode = 'login'
   (start público) ou 'link' (start com sessão, grava o vínculo). TTL 10min,
   uso único, em memória (single-instance, igual ao Discord).
   ═══════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const SCOPES = ['openid', 'email', 'profile'];
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
  return !!(process.env.GOOGLE_LOGIN_CLIENT_ID
         && process.env.GOOGLE_LOGIN_CLIENT_SECRET
         && process.env.GOOGLE_LOGIN_REDIRECT_URI);
}

function client() {
  if (!isConfigured()) {
    throw new Error('Login com Google não configurado. Defina GOOGLE_LOGIN_CLIENT_ID, GOOGLE_LOGIN_CLIENT_SECRET e GOOGLE_LOGIN_REDIRECT_URI.');
  }
  return new OAuth2Client(
    process.env.GOOGLE_LOGIN_CLIENT_ID,
    process.env.GOOGLE_LOGIN_CLIENT_SECRET,
    process.env.GOOGLE_LOGIN_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  return client().generateAuthUrl({
    scope: SCOPES,
    state,
    access_type: 'online',
    // Sempre deixa escolher a conta: quem usa Google pessoal e do trabalho
    // no mesmo navegador não entra na errada sem perceber.
    prompt: 'select_account'
  });
}

/* Troca o `code` pelo id_token e valida (assinatura, emissor, audiência).
   Devolve { sub, email, emailVerified, name, picture } — sub é o id fixo
   da conta Google (o e-mail pode mudar, o sub não). */
async function exchangeCodeForProfile(code) {
  const c = client();
  const { tokens } = await c.getToken(code);
  if (!tokens.id_token) throw new Error('O Google não devolveu a identificação da conta.');
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_LOGIN_CLIENT_ID });
  const p = ticket.getPayload() || {};
  if (!p.sub) throw new Error('Conta Google sem identificador.');
  return {
    sub: String(p.sub),
    email: p.email ? String(p.email).toLowerCase() : null,
    emailVerified: p.email_verified === true,
    name: p.name || null,
    picture: p.picture || null
  };
}

module.exports = {
  isConfigured,
  makeState,
  popState,
  getAuthUrl,
  exchangeCodeForProfile
};
