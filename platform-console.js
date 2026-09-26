/* ───────────────────────────────────────────────────────────────
   reWork Console — painel da plataforma (/console)

   Separado do reWork em si:
     - contas próprias (db.platformAdmins, ids "pa_…"), que não existem como
       usuários do produto e não abrem o app;
     - cookie próprio (rework_console, SameSite=Strict, 12h) — a sessão do
       reWork não abre o console e vice-versa;
     - verificação em duas etapas (TOTP, app autenticador) obrigatória pra
       todo superadmin, menos o acesso padrão.

   Acesso padrão: sem nenhum superadmin cadastrado, o boot cria o usuário
   "admin" com a senha "admin123" (como o admin do reWork), sem verificação em
   duas etapas. Serve pra entrar a primeira vez e convidar os superadmins de
   verdade; depois dá pra desativar em Superadmins. O console mostra um aviso
   enquanto alguém estiver usando esse acesso.

   Recuperação de acesso (funciona mesmo com um único superadmin):
     1) códigos de recuperação — 10, de uso único, gerados ao cadastrar o app;
        substituem o código do celular;
     2) "esqueci a senha" por e-mail — link de 1h que troca só a senha (o
        código do celular continua sendo pedido);
     3) recuperação pelo servidor — com CONSOLE_RECOVERY_TOKEN definido, a
        tela /console/recuperar redefine senha E app de qualquer superadmin.
        Cada valor do token vale uma vez só.

   Também mora aqui a lista de espera: o formulário público /acesso grava em
   db.accessRequests e o console revisa.

   Planos e exclusão de organização:
     - plano de cada organização (Teste de 30 dias, Essencial/Profissional/Agência
       ou Personalizado, com limites próprios de pessoas, armazenamento e
       tamanho de arquivo) — catálogo e contas no server.js (PLANS, orgPlan,
       orgUsage). Organização nova nasce no Teste;
     - excluir = a organização some pra todo mundo na hora, mas os dados
       ficam guardados por 30 dias: dá pra restaurar ou baixar o backup
       (JSON) pelo console. Passado o prazo (ou em "apagar agora"), o
       purgeOrg do server apaga tudo de vez.
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const CONSOLE_COOKIE = 'rework_console';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TICKET_TTL_MS = 10 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const ACTIVATION_TTL_MS = 48 * 60 * 60 * 1000;
const PASSWORD_MIN = 12;
const AUDIT_MAX = 3000;
const ORG_KEEP_DAYS = 30;
const ISSUER = 'reWork Console';

const REQUEST_STATUSES = ['new', 'reviewing', 'approved', 'rejected'];
const TEAM_SIZES = ['1-5', '6-15', '16-50', '51-200', '200+'];
const SOURCES = ['indicacao', 'google', 'instagram', 'linkedin', 'evento', 'outro'];

/* TOTP, códigos de recuperação e comparações seguras: totp.js (compartilhado
   com a verificação em duas etapas do reWork). */
const { b32encode, totpVerify, hotp, b32decode, safeEqual, sha256, normRecovery, newRecoveryCodes } = require('./totp');

module.exports = function setupConsole(app, deps) {
  // O `db` do server é trocado no boot (loadDB) — lê sempre o atual.
  const db = new Proxy({}, { get: (_, key) => deps.getDb()[key] });
  const { tenancy, createOrgWithOwner, plans, orgPlan, orgUsage, buildOrgExport, orgExportFilename, purgeOrg, TRIAL_DAYS, uploadMaxMb } = deps;
  const {
    store, auth, saveEntity, removeEntity, uid, nowISO, notDeleted,
    makeRateLimit, clientIp, parseCookies, isHttpsRequest, isValidEmail,
    mailEnabled, sendEmail, emailTpl, appBaseUrl, uploadsDir, buildSha, integrations, publicDir
  } = deps;

  const now = () => Date.now();
  const DEFAULT_LOGIN = 'admin';
  const DEFAULT_PASSWORD = 'admin123';
  function ensureDefaultAdmin() {
    if ((db.platformAdmins || []).length) return null;
    const admin = {
      id: 'pa_' + crypto.randomBytes(8).toString('hex'), name: 'Administrador', email: DEFAULT_LOGIN,
      active: true, isDefaultAccount: true, twoFactorExempt: true,
      createdAt: nowISO(), createdBy: null, passwordSetAt: nowISO(),
      totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null
    };
    db.platformAdmins.push(admin);
    auth.setPassword(admin.id, DEFAULT_PASSWORD);
    saveEntity('platformAdmins', admin);
    console.log(`  [console] acesso padrão criado — /console · usuário: ${DEFAULT_LOGIN} · senha: ${DEFAULT_PASSWORD} (desative depois de criar o seu)`);
    return admin;
  }
  const canEnter = (a) => a && a.active !== false && (a.totpEnabledAt || a.twoFactorExempt);
  const normEmail = (e) => String(e || '').trim().toLowerCase();

  /* ── Sessão do console ── */
  function sessionCookie(req, token) {
    const secure = isHttpsRequest(req) ? '; Secure' : '';
    return `${CONSOLE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
  }
  function clearCookie() {
    return `${CONSOLE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
  function adminFromReq(req) {
    const token = parseCookies(req)[CONSOLE_COOKIE];
    const s = token && auth.sessionForToken(token);
    if (!s || !s.data || s.data.scope !== 'console') return null;
    const admin = db.platformAdmins.find(a => a.id === s.userId && canEnter(a));
    return admin ? { admin, token } : null;
  }
  function requireConsole(req, res, next) {
    const r = adminFromReq(req);
    if (!r) return res.status(401).json({ error: 'Sessão do console expirada. Entre de novo.' });
    req.consoleAdmin = r.admin; req.consoleToken = r.token;
    next();
  }
  function startSession(req, res, admin) {
    const token = auth.addToken(admin.id, { scope: 'console', ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) }, { ttlMs: SESSION_TTL_MS });
    res.set('Set-Cookie', sessionCookie(req, token));
    admin.lastLoginAt = nowISO();
    admin.lastLoginIp = clientIp(req);
    saveEntity('platformAdmins', admin);
  }
  function publicAdmin(a) {
    return {
      id: a.id, name: a.name, email: a.email, active: a.active !== false,
      twoFactor: !!a.totpEnabledAt, pendingActivation: !a.passwordSetAt && !a.twoFactorExempt,
      isDefaultAccount: !!a.isDefaultAccount, twoFactorExempt: !!a.twoFactorExempt,
      recoveryLeft: (a.recoveryCodes || []).filter(c => !c.usedAt).length,
      createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || null
    };
  }
  /* Gera e grava (só o hash) um jogo novo de códigos; devolve os códigos em texto. */
  function issueRecoveryCodes(admin) {
    const codes = newRecoveryCodes();
    admin.recoveryCodes = codes.map(c => ({ hash: sha256('rc:' + normRecovery(c)), usedAt: null }));
    admin.recoveryIssuedAt = nowISO();
    return codes;
  }

  /* ── Auditoria ── */
  function audit(req, action, details, actor) {
    const who = actor || req.consoleAdmin || null;
    const entry = {
      id: uid(), action, details: details || null,
      adminId: who ? who.id : null, adminName: who ? who.name : (req ? null : 'Sistema'),
      ip: req ? clientIp(req) : null, at: nowISO()
    };
    db.platformAudit.push(entry);
    saveEntity('platformAudit', entry);
    if (db.platformAudit.length > AUDIT_MAX) {
      const drop = db.platformAudit.splice(0, db.platformAudit.length - AUDIT_MAX);
      drop.forEach(e => removeEntity('platformAudit', e.id));
    }
  }

  /* ── Etapa intermediária do login (senha ok → código / cadastro do app) ── */
  const tickets = new Map(); // ticket → { adminId, kind: 'totp'|'enroll', secret?, exp, attempts }
  setInterval(() => { const t = now(); for (const [k, v] of tickets) if (v.exp < t) tickets.delete(k); }, 60000).unref();
  function newTicket(adminId, kind, secret) {
    for (const [k, v] of tickets) if (v.adminId === adminId) tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('base64url');
    tickets.set(ticket, { adminId, kind, secret: secret || null, exp: now() + TICKET_TTL_MS, attempts: 0 });
    return ticket;
  }
  async function enrollPayload(admin) {
    const secret = b32encode(crypto.randomBytes(20));
    const label = encodeURIComponent(`${ISSUER}:${admin.email}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toString(otpauth, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
    return { step: 'enroll', ticket: newTicket(admin.id, 'enroll', secret), secret: secret.match(/.{1,4}/g).join(' '), otpauth, qr };
  }

  /* ── Limites ── */
  const rlLogin = makeRateLimit(new Map(), 5, 'tentativas');
  const rlVerify = makeRateLimit(new Map(), 10, 'tentativas');
  const rlSetup = makeRateLimit(new Map(), 5, 'tentativas', clientIp, 10 * 60 * 1000);
  const rlRequest = makeRateLimit(new Map(), 5, 'pedidos', clientIp, 10 * 60 * 1000);

  function checkNewPassword(pw) {
    if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `A senha do console precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
    if (pw.length > 200) return 'Senha longa demais.';
    return null;
  }

  /* ───────────── Rotas públicas (entrada) ───────────── */
  app.get('/api/console/status', (req, res) => {
    const hasAdmin = db.platformAdmins.length > 0;
    res.json({
      setupNeeded: false,
      recoveryEnabled: hasAdmin && String(process.env.CONSOLE_RECOVERY_TOKEN || '').length >= 16,
      emailEnabled: mailEnabled(),
      signedIn: !!adminFromReq(req),
      passwordMin: PASSWORD_MIN
    });
  });

  app.post('/api/console/login', rlLogin, async (req, res) => {
    const { email, password } = req.body || {};
    const admin = db.platformAdmins.find(a => a.email === normEmail(email) && a.active !== false && a.passwordSetAt);
    if (!admin || !auth.verifyPassword(admin.id, password)) {
      audit(req, 'login_failed', { email: normEmail(email).slice(0, 120) }, admin || null);
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    if (admin.twoFactorExempt) {
      startSession(req, res, admin);
      audit(req, 'login', { via: 'default_account' }, admin);
      return res.json({ ok: true, step: 'done', admin: publicAdmin(admin) });
    }
    if (!admin.totpEnabledAt) return res.json(await enrollPayload(admin));
    res.json({ step: 'totp', ticket: newTicket(admin.id, 'totp') });
  });

  app.post('/api/console/login/verify', rlVerify, (req, res) => {
    const { ticket, code } = req.body || {};
    const t = tickets.get(String(ticket || ''));
    if (!t || t.exp < now()) return res.status(410).json({ error: 'A verificação expirou. Entre de novo.', restart: true });
    const admin = db.platformAdmins.find(a => a.id === t.adminId && a.active !== false);
    if (!admin) { tickets.delete(ticket); return res.status(410).json({ error: 'Conta indisponível.', restart: true }); }
    t.attempts++;
    if (t.attempts > 5) { tickets.delete(ticket); return res.status(429).json({ error: 'Muitas tentativas. Entre de novo.', restart: true }); }
    let step;
    let recoveryCodes = null, usedRecovery = false;
    if (t.kind === 'enroll') {
      step = totpVerify(t.secret, code, null);
      if (step == null) return res.status(400).json({ error: 'Código incorreto. Confira o app autenticador e tente de novo.' });
      admin.totpSecretEnc = auth.encryptString(t.secret);
      admin.totpEnabledAt = nowISO();
      recoveryCodes = issueRecoveryCodes(admin);
      audit(req, 'two_factor_enabled', null, admin);
    } else if (/[a-z]/i.test(String(code || ''))) {
      // Código de recuperação (tem letras): vale uma vez só.
      const h = sha256('rc:' + normRecovery(code));
      const rc = (admin.recoveryCodes || []).find(c => !c.usedAt && safeEqual(c.hash, h));
      if (!rc) {
        audit(req, 'recovery_code_failed', null, admin);
        return res.status(400).json({ error: 'Código de recuperação inválido ou já usado.' });
      }
      rc.usedAt = nowISO();
      usedRecovery = true;
      step = admin.totpLastStep;
      audit(req, 'recovery_code_used', { left: admin.recoveryCodes.filter(c => !c.usedAt).length }, admin);
    } else {
      let secret = '';
      try { secret = auth.decryptString(admin.totpSecretEnc); } catch {}
      step = secret ? totpVerify(secret, code, admin.totpLastStep) : null;
      if (step == null) {
        audit(req, 'two_factor_failed', null, admin);
        return res.status(400).json({ error: 'Código incorreto ou já usado. Espere o próximo código do app.' });
      }
    }
    admin.totpLastStep = step;
    tickets.delete(ticket);
    startSession(req, res, admin);
    audit(req, 'login', usedRecovery ? { via: 'recovery_code' } : null, admin);
    res.json({ ok: true, admin: publicAdmin(admin), recoveryCodes, usedRecovery });
  });

  /* ── "Esqueci a senha" por e-mail: troca só a senha; o app continua valendo ── */
  const rlForgot = makeRateLimit(new Map(), 5, 'pedidos', clientIp, 10 * 60 * 1000);
  app.post('/api/console/forgot', rlForgot, async (req, res) => {
    if (!mailEnabled()) return res.json({ ok: true, emailEnabled: false });
    const em = normEmail((req.body || {}).email);
    const a = db.platformAdmins.find(x => x.email === em && x.active !== false && x.passwordSetAt);
    // Resposta igual com ou sem conta — não revela quem é superadmin.
    if (a) {
      const token = crypto.randomBytes(24).toString('base64url');
      a.resetTokenHash = sha256(token);
      a.resetExpiresAt = new Date(now() + RESET_TTL_MS).toISOString();
      saveEntity('platformAdmins', a);
      const link = `${appBaseUrl(req)}/console/redefinir/${token}`;
      const m = emailTpl.consoleResetPassword({ name: a.name, link, baseUrl: appBaseUrl(req) });
      setImmediate(() => sendEmail(a.email, m.subject, m.html, m.text));
      audit(req, 'password_reset_requested', null, a);
    }
    res.json({ ok: true, emailEnabled: true });
  });
  function adminByReset(token) {
    if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const h = sha256(token);
    const a = db.platformAdmins.find(x => x.resetTokenHash && safeEqual(x.resetTokenHash, h) && x.active !== false);
    if (!a || !a.resetExpiresAt || Date.parse(a.resetExpiresAt) < now()) return null;
    return a;
  }
  app.get('/api/console/reset/:token', rlSetup, (req, res) => {
    const a = adminByReset(req.params.token);
    if (!a) return res.status(410).json({ error: 'Este link não vale mais. Peça um novo em "Esqueci a senha".' });
    res.json({ email: a.email, passwordMin: PASSWORD_MIN });
  });
  app.post('/api/console/reset/:token', rlSetup, (req, res) => {
    const a = adminByReset(req.params.token);
    if (!a) return res.status(410).json({ error: 'Este link não vale mais. Peça um novo em "Esqueci a senha".' });
    const pwErr = checkNewPassword((req.body || {}).password);
    if (pwErr) return res.status(400).json({ error: pwErr, field: 'password' });
    auth.setPassword(a.id, req.body.password);
    a.resetTokenHash = null; a.resetExpiresAt = null;
    saveEntity('platformAdmins', a);
    auth.dropTokensFor(a.id);
    audit(req, 'password_reset', null, a);
    res.json({ ok: true });
  });

  /* ── Recuperação pelo servidor (último recurso) ──
     Quem controla as variáveis de ambiente define CONSOLE_RECOVERY_TOKEN e usa
     /console/recuperar: sai um link de ativação que redefine senha e app. Cada
     valor do token vale uma vez (fica marcado no banco); depois de usar,
     apague a variável. */
  const rlRecover = makeRateLimit(new Map(), 5, 'tentativas', clientIp, 10 * 60 * 1000);
  app.post('/api/console/recover', rlRecover, async (req, res) => {
    const expected = process.env.CONSOLE_RECOVERY_TOKEN;
    if (!expected || expected.length < 16) return res.status(503).json({ error: 'A recuperação pelo servidor está desligada. Defina CONSOLE_RECOVERY_TOKEN (16+ caracteres) nas variáveis de ambiente e reinicie.' });
    const { token, email } = req.body || {};
    if (!safeEqual(token, expected)) {
      audit(req, 'server_recovery_failed', { email: normEmail(email).slice(0, 120) });
      return res.status(403).json({ error: 'Código de recuperação do servidor incorreto.', field: 'token' });
    }
    const usedKey = 'console:recovery-used:' + sha256(expected).slice(0, 32);
    if (await store.getKv(usedKey)) return res.status(410).json({ error: 'Este valor de CONSOLE_RECOVERY_TOKEN já foi usado. Defina outro valor e reinicie o servidor.', field: 'token' });
    const a = db.platformAdmins.find(x => x.email === normEmail(email));
    if (!a) return res.status(404).json({ error: 'Nenhum superadmin com esse e-mail.', field: 'email' });
    a.active = true;
    const link = activationLink(req, a);
    saveEntity('platformAdmins', a);
    auth.dropTokensFor(a.id);
    await store.setKv(usedKey, nowISO());
    audit(req, 'server_recovery', { adminId: a.id, email: a.email }, a);
    // Avisa os outros superadmins (se houver e o e-mail estiver configurado).
    if (mailEnabled()) {
      const others = db.platformAdmins.filter(x => x.id !== a.id && x.active !== false && x.totpEnabledAt);
      const m = emailTpl.consoleRecoveryNotice({ name: a.name, email: a.email, baseUrl: appBaseUrl(req) });
      for (const o of others) setImmediate(() => sendEmail(o.email, m.subject, m.html, m.text));
    }
    res.json({ link, name: a.name });
  });

  // Ativação de superadmin convidado (define senha → cadastra o app)
  function adminByActivation(token) {
    if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const h = sha256(token);
    const a = db.platformAdmins.find(x => x.setupTokenHash === h && x.active !== false);
    if (!a || !a.setupExpiresAt || Date.parse(a.setupExpiresAt) < now()) return null;
    return a;
  }
  app.get('/api/console/activate/:token', rlSetup, (req, res) => {
    const a = adminByActivation(req.params.token);
    if (!a) return res.status(410).json({ error: 'Este link de ativação não vale mais. Peça um novo para quem te convidou.' });
    res.json({ name: a.name, email: a.email, passwordMin: PASSWORD_MIN });
  });
  app.post('/api/console/activate/:token', rlSetup, async (req, res) => {
    const a = adminByActivation(req.params.token);
    if (!a) return res.status(410).json({ error: 'Este link de ativação não vale mais. Peça um novo para quem te convidou.' });
    const pwErr = checkNewPassword((req.body || {}).password);
    if (pwErr) return res.status(400).json({ error: pwErr, field: 'password' });
    auth.setPassword(a.id, req.body.password);
    a.passwordSetAt = nowISO();
    a.setupTokenHash = null; a.setupExpiresAt = null;
    a.totpSecretEnc = null; a.totpEnabledAt = null; a.totpLastStep = null;
    saveEntity('platformAdmins', a);
    auth.dropTokensFor(a.id);
    audit(req, 'admin_activated', null, a);
    res.json(await enrollPayload(a));
  });

  /* ───────────── Sessão ───────────── */
  app.get('/api/console/me', requireConsole, (req, res) => res.json(publicAdmin(req.consoleAdmin)));

  // Ações sensíveis da própria conta pedem o código atual do app.
  function checkFreshCode(admin, code) {
    let secret = '';
    try { secret = auth.decryptString(admin.totpSecretEnc); } catch {}
    const step = secret ? totpVerify(secret, code, admin.totpLastStep) : null;
    if (step != null) admin.totpLastStep = step;
    return step != null;
  }
  const rlAccount = makeRateLimit(new Map(), 10, 'tentativas', req => 'pa:' + (req.consoleAdmin ? req.consoleAdmin.id : clientIp(req)), 10 * 60 * 1000);
  app.post('/api/console/me/recovery-codes', requireConsole, rlAccount, (req, res) => {
    const a = req.consoleAdmin;
    if (a.twoFactorExempt) return res.status(400).json({ error: 'O acesso padrão não tem verificação em duas etapas nem códigos de recuperação.' });
    if (!checkFreshCode(a, (req.body || {}).code)) return res.status(400).json({ error: 'Código do app incorreto ou já usado.', field: 'code' });
    const codes = issueRecoveryCodes(a);
    saveEntity('platformAdmins', a);
    audit(req, 'recovery_codes_issued');
    res.json({ recoveryCodes: codes, admin: publicAdmin(a) });
  });
  app.post('/api/console/me/password', requireConsole, rlAccount, (req, res) => {
    const a = req.consoleAdmin;
    const { current, password, code } = req.body || {};
    if (!auth.verifyPassword(a.id, current)) return res.status(400).json({ error: 'Senha atual incorreta.', field: 'current' });
    const pwErr = checkNewPassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr, field: 'password' });
    if (!a.twoFactorExempt && !checkFreshCode(a, code)) return res.status(400).json({ error: 'Código do app incorreto ou já usado.', field: 'code' });
    auth.setPassword(a.id, password);
    saveEntity('platformAdmins', a);
    auth.dropTokensFor(a.id, req.consoleToken);
    audit(req, 'password_changed');
    res.json({ ok: true });
  });
  app.post('/api/console/logout', (req, res) => {
    const r = adminFromReq(req);
    if (r) { auth.removeToken(r.token); req.consoleAdmin = r.admin; audit(req, 'logout'); }
    res.set('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });

  /* ───────────── Métricas ───────────── */
  const DAY = 864e5;
  const ts = (v) => (v ? Date.parse(v) : NaN);
  function entryTime(e) { return ts(e.start || e.createdAt); }

  let _storageCache = { at: 0, uploads: null, db: null };
  function dirSize(dir) {
    let total = 0, files = 0;
    const walk = (d) => {
      let items = [];
      try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) walk(p);
        else { try { total += fs.statSync(p).size; files++; } catch {} }
      }
    };
    walk(dir);
    return { bytes: total, files };
  }
  async function storageInfo() {
    if (now() - _storageCache.at < 10 * 60 * 1000) return _storageCache;
    let dbBytes = null;
    try { dbBytes = Number((await store._pool.query('SELECT pg_database_size(current_database()) AS s')).rows[0].s); } catch {}
    _storageCache = { at: now(), uploads: dirSize(uploadsDir), db: dbBytes };
    return _storageCache;
  }

  /* ── Números por organização ── */
  const inOrg = (type, orgId) => (db[type] || []).filter(e => tenancy.belongs(type, e, orgId));
  const membersOf = (orgId) => (db.memberships || []).filter(m => m.orgId === orgId);
  const userById = (id) => (db.users || []).find(u => u.id === id) || null;
  function orgSummary(org) {
    const t = now();
    const seen = auth.lastSeenByUser();
    const ms = membersOf(org.id);
    const active = ms.filter(m => m.active !== false);
    const lastSeenOf = (m) => seen.get(m.userId) || 0;
    const demands = inOrg('demands', org.id).filter(notDeleted);
    let hours30 = 0, hoursTotal = 0;
    for (const d of demands) for (const e of (d.timeEntries || [])) {
      const h = Number(e.hours) || 0;
      hoursTotal += h;
      if (entryTime(e) >= t - 30 * DAY) hours30 += h;
    }
    const lastActivity = Math.max(0, ...active.map(lastSeenOf));
    const owner = userById(org.ownerId);
    const ownerInvite = !org.ownerId ? (db.invites || []).filter(i => i.orgId === org.id && i.kind === 'owner' && !i.revokedAt).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0] : null;
    return {
      id: org.id, name: org.name, logo: org.logo || null, isDefault: !!org.isDefault,
      status: org.status || 'active', createdAt: org.createdAt || null,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email || null } : null,
      ownerInvite: ownerInvite ? { email: ownerInvite.email, expiresAt: ownerInvite.expiresAt, accepted: !!ownerInvite.acceptedAt, expired: Date.parse(ownerInvite.expiresAt) <= t } : null,
      members: active.length,
      admins: active.filter(m => m.role === 'admin' || m.role === 'owner').length,
      freelancers: active.filter(m => m.role === 'free').length,
      deactivated: ms.length - active.length,
      active7: active.filter(m => lastSeenOf(m) >= t - 7 * DAY).length,
      active30: active.filter(m => lastSeenOf(m) >= t - 30 * DAY).length,
      squads: inOrg('workspaces', org.id).length,
      clients: inOrg('clients', org.id).filter(c => notDeleted(c) && c.active !== false).length,
      projects: inOrg('projects', org.id).filter(p => notDeleted(p) && p.active !== false).length,
      demandsTotal: demands.length,
      demandsOpen: demands.filter(d => !d.completedAt).length,
      created30: demands.filter(d => ts(d.createdAt) >= t - 30 * DAY).length,
      completed30: demands.filter(d => ts(d.completedAt) >= t - 30 * DAY).length,
      hours30: Math.round(hours30 * 10) / 10,
      hoursTotal: Math.round(hoursTotal * 10) / 10,
      docs: inOrg('writerDocuments', org.id).filter(notDeleted).length,
      lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
      usage: orgUsage(org)
    };
  }
  const allOrgs = () => (db.organizations || []).filter(o => !o.deletedAt);
  const deletedOrgs = () => (db.organizations || []).filter(o => o.deletedAt);
  const orgById = (id) => (db.organizations || []).find(o => o.id === id) || null;
  function deletedSummary(org) {
    const members = membersOf(org.id).filter(m => m.active !== false).length;
    const owner = userById(org.ownerId);
    return {
      id: org.id, name: org.name, isDefault: !!org.isDefault, createdAt: org.createdAt || null,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email || null } : null,
      members, deletedAt: org.deletedAt, deletedBy: org.deletedBy || null, purgeAt: org.purgeAt,
      daysLeft: Math.max(0, Math.ceil((Date.parse(org.purgeAt) - now()) / DAY)),
      reason: org.deleteReason || null,
      plan: orgPlan(org)
    };
  }
  /* Série diária dos últimos `days` dias (data local do servidor). */
  function dailySeries(days, pickTime, orgId) {
    const out = [];
    const base = new Date(); base.setHours(0, 0, 0, 0);
    const start = base.getTime() - (days - 1) * DAY;
    for (let i = 0; i < days; i++) {
      const d = new Date(start + i * DAY);
      out.push({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, value: 0 });
    }
    const list = orgId ? inOrg('demands', orgId) : (db.demands || []);
    for (const item of list) {
      if (!notDeleted(item)) continue;
      const v = pickTime(item);
      if (!Number.isFinite(v) || v < start) continue;
      const idx = Math.floor((v - start) / DAY);
      if (idx >= 0 && idx < days) out[idx].value++;
    }
    return out;
  }
  function requestCounts() {
    const c = { new: 0, reviewing: 0, approved: 0, rejected: 0 };
    for (const r of db.accessRequests) if (c[r.status] !== undefined) c[r.status]++;
    return c;
  }

  app.get('/api/console/overview', requireConsole, async (req, res) => {
    const orgs = allOrgs().map(orgSummary).sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
    const t = now();
    const seen = auth.lastSeenByUser();
    // Pessoas: contas distintas com vínculo ativo (alguém pode estar em várias).
    const people = new Set((db.memberships || []).filter(m => m.active !== false).map(m => m.userId));
    const act = (days) => [...people].filter(id => (seen.get(id) || 0) >= t - days * DAY).length;
    const sum = (k) => orgs.reduce((acc, o) => acc + (o[k] || 0), 0);
    const st = await storageInfo();
    res.json({
      orgs: { total: orgs.length, items: orgs },
      totals: {
        people: people.size, active7: act(7), active30: act(30),
        demandsOpen: sum('demandsOpen'), created30: sum('created30'), completed30: sum('completed30'),
        hours30: Math.round(sum('hours30') * 10) / 10
      },
      series: { created: dailySeries(30, d => ts(d.createdAt)), completed: dailySeries(30, d => ts(d.completedAt)) },
      support: { open: deps.supportOpenCount ? deps.supportOpenCount() : 0 },
      waitlist: {
        counts: requestCounts(),
        latest: db.accessRequests.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5).map(publicRequest)
      },
      system: {
        build: buildSha, node: process.version,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        dbBytes: st.db, uploadsBytes: st.uploads ? st.uploads.bytes : null, uploadsFiles: st.uploads ? st.uploads.files : null,
        sessions: auth.activeSessionCount(s => !(s.data && s.data.scope === 'console')),
        integrations: integrations()
      }
    });
  });

  app.get('/api/console/orgs', requireConsole, (req, res) => {
    res.json({
      items: allOrgs().map(orgSummary).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      deleted: deletedOrgs().map(deletedSummary).sort((a, b) => String(a.purgeAt).localeCompare(String(b.purgeAt))),
      plans
    });
  });

  app.get('/api/console/orgs/:id', requireConsole, (req, res) => {
    const org = orgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada. Se foi apagada de vez, os dados não existem mais.' });
    // Excluída: só o que precisa pra decidir (restaurar, baixar o backup, apagar).
    if (org.deletedAt) return res.json({ deleted: deletedSummary(org), plans });
    const seen = auth.lastSeenByUser();
    const wsList = inOrg('workspaces', org.id);
    const wsName = Object.fromEntries(wsList.map(w => [w.id, w.name]));
    const members = membersOf(org.id).map(m => {
      const u = userById(m.userId) || {};
      return {
        id: m.userId, name: u.name || '—', username: u.username || '', email: u.email || null,
        role: m.area || '', position: m.position || '',
        access: m.role,
        squads: (m.role === 'owner' || m.role === 'admin') ? [] : (m.workspaces || []).map(id => wsName[id]).filter(Boolean),
        active: m.active !== false,
        lastSeenAt: seen.get(m.userId) ? new Date(seen.get(m.userId)).toISOString() : null,
        createdAt: m.createdAt || null
      };
    }).sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'pt-BR'));
    const demands = inOrg('demands', org.id).filter(notDeleted);
    const clients = inOrg('clients', org.id);
    const squads = wsList.map(w => ({
      id: w.id, name: w.name, color: w.color || '#7A00FF',
      members: membersOf(org.id).filter(m => m.active !== false && (m.role === 'owner' || m.role === 'admin' || (m.workspaces || []).includes(w.id))).length,
      clients: clients.filter(c => c.workspaceId === w.id && notDeleted(c) && c.active !== false).length,
      open: demands.filter(d => d.workspaceId === w.id && !d.completedAt).length,
      total: demands.filter(d => d.workspaceId === w.id).length
    })).sort((a, b) => b.total - a.total);
    // Horas por mês (últimos 6)
    const months = [];
    const cur = new Date(); cur.setDate(1); cur.setHours(0, 0, 0, 0);
    for (let i = 5; i >= 0; i--) {
      const m = new Date(cur.getFullYear(), cur.getMonth() - i, 1);
      months.push({ key: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, value: 0 });
    }
    for (const d of demands) for (const e of (d.timeEntries || [])) {
      const v = entryTime(e);
      if (!Number.isFinite(v)) continue;
      const dt = new Date(v);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const slot = months.find(m => m.key === key);
      if (slot) slot.value = Math.round((slot.value + (Number(e.hours) || 0)) * 10) / 10;
    }
    audit(req, 'org_viewed', { orgId: org.id, name: org.name });
    res.json({ org: orgSummary(org), members, squads, hoursByMonth: months, series: { created: dailySeries(30, d => ts(d.createdAt), org.id) }, plans, billing: deps.orgBilling ? deps.orgBilling(org) : null });
  });

  /* ── Plano e limites ── */
  const LIMIT_MAX = 100000;
  app.put('/api/console/orgs/:id/plan', requireConsole, (req, res) => {
    const org = allOrgs().find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada.' });
    const b = req.body || {};
    const base = plans.find(p => p.id === b.planId);
    if (!base) return res.status(400).json({ error: 'Escolha um plano.', field: 'planId' });
    const next = { id: base.id };
    const prevSaved = org.plan || {};
    if (base.id === 'teste') {
      // Dias de teste a partir de hoje; sem informar, mantém o prazo atual (ou
      // começa quando o dono entrar, se ainda não entrou).
      if (b.trialDays !== undefined && b.trialDays !== null && b.trialDays !== '') {
        const days = Number(b.trialDays);
        // 0 = encerra o teste agora (a organização fica só pra consulta).
        if (!Number.isInteger(days) || days < 0 || days > 90) return res.status(400).json({ error: 'Dias de teste: use um número inteiro entre 0 (encerrar agora) e 90.', field: 'trialDays' });
        next.trialEndsAt = new Date(now() + days * DAY).toISOString();
      } else if (prevSaved.id === 'teste' && prevSaved.trialEndsAt) {
        next.trialEndsAt = prevSaved.trialEndsAt;
      } else if (org.ownerId) {
        next.trialEndsAt = new Date(now() + TRIAL_DAYS * DAY).toISOString();
      }
      if (next.trialEndsAt) next.trialStartedAt = prevSaved.id === 'teste' && prevSaved.trialStartedAt ? prevSaved.trialStartedAt : nowISO();
    }
    if (base.id === 'custom') {
      // null/vazio = sem limite
      const num = (v, field, label, int) => {
        if (v === null || v === undefined || v === '') return { value: null };
        const n = Number(v);
        // Armazenamento aceita fração (0,5 GB; o mínimo de 0,001 GB ≈ 1 MB serve pra teste).
        if (!Number.isFinite(n) || n < (int ? 1 : 0.001) || n > LIMIT_MAX || (int && !Number.isInteger(n))) return { error: `${label}: use um número ${int ? 'inteiro ' : ''}entre 1 e ${LIMIT_MAX.toLocaleString('pt-BR')}, ou deixe em branco para não limitar.`, field };
        return { value: int ? n : Math.round(n * 1000) / 1000 };
      };
      const users = num(b.users, 'users', 'Pessoas', true);
      if (users.error) return res.status(400).json(users);
      const storage = num(b.storageGb, 'storageGb', 'Armazenamento', false);
      if (storage.error) return res.status(400).json(storage);
      let fileMb = null;
      if (b.fileMb !== undefined && b.fileMb !== null && b.fileMb !== '') {
        fileMb = Number(b.fileMb);
        if (!Number.isInteger(fileMb) || fileMb < 1 || fileMb > uploadMaxMb) return res.status(400).json({ error: `Tamanho por arquivo: use um número inteiro entre 1 e ${uploadMaxMb} MB, ou deixe em branco (${uploadMaxMb} MB).`, field: 'fileMb' });
      }
      next.users = users.value; next.storageGb = storage.value; next.fileMb = fileMb;
    }
    const before = orgPlan(org);
    org.plan = { ...next, changedAt: nowISO(), changedBy: req.consoleAdmin.name };
    saveEntity('organizations', org);
    const after = orgPlan(org);
    const lim = (p) => `${p.name} (${p.users == null ? 'sem limite de pessoas' : p.users + ' pessoas'}, ${p.storageGb == null ? 'sem limite de armazenamento' : p.storageGb + ' GB'}, arquivos até ${p.fileMb == null ? uploadMaxMb : p.fileMb} MB${p.trialEndsAt ? `, teste até ${p.trialEndsAt.slice(0, 10)}` : ''})`;
    audit(req, 'org_plan_changed', { orgId: org.id, name: org.name, from: lim(before), to: lim(after) });
    res.json(orgSummary(org));
  });

  /* ── Exclusão (guarda 30 dias), restauração, backup e apagar de vez ── */
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  app.post('/api/console/orgs/:id/delete', requireConsole, (req, res) => {
    const org = allOrgs().find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada.' });
    if (org.isDefault) return res.status(400).json({ error: 'A organização principal desta instalação não pode ser excluída.' });
    if (!sameName((req.body || {}).confirm, org.name)) return res.status(400).json({ error: 'Digite o nome da organização exatamente como aparece para confirmar.', field: 'confirm' });
    const at = new Date();
    org.deletedAt = at.toISOString();
    org.deletedBy = req.consoleAdmin.name;
    org.purgeAt = new Date(at.getTime() + ORG_KEEP_DAYS * DAY).toISOString();
    org.deleteReason = clip((req.body || {}).reason, 500) || null;
    saveEntity('organizations', org);
    audit(req, 'org_deleted', { orgId: org.id, name: org.name, purgeAt: org.purgeAt, reason: org.deleteReason });
    res.json(deletedSummary(org));
  });
  app.post('/api/console/orgs/:id/restore', requireConsole, (req, res) => {
    const org = deletedOrgs().find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Organização excluída não encontrada.' });
    delete org.deletedAt; delete org.deletedBy; delete org.purgeAt; delete org.deleteReason;
    org.restoredAt = nowISO();
    saveEntity('organizations', org);
    audit(req, 'org_restored', { orgId: org.id, name: org.name });
    res.json(orgSummary(org));
  });
  app.get('/api/console/orgs/:id/export', requireConsole, (req, res) => {
    const org = orgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada.' });
    audit(req, 'org_exported', { orgId: org.id, name: org.name });
    res.set('Content-Disposition', `attachment; filename="${orgExportFilename(org)}"`);
    res.type('application/json').send(JSON.stringify(buildOrgExport(org, `reWork Console · ${req.consoleAdmin.name}`), null, 2));
  });
  app.delete('/api/console/orgs/:id', requireConsole, (req, res) => {
    const org = deletedOrgs().find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Só dá para apagar de vez uma organização que já foi excluída.' });
    if (!sameName((req.body || {}).confirm, org.name)) return res.status(400).json({ error: 'Digite o nome da organização exatamente como aparece para confirmar.', field: 'confirm' });
    const result = purgeOrg(org);
    audit(req, 'org_purged', { orgId: org.id, name: org.name, ...result, early: true });
    res.json({ ok: true, ...result });
  });
  // Passados os 30 dias, apaga sozinho (confere de hora em hora).
  function runOrgPurgeJob() {
    const t = now();
    for (const org of deletedOrgs()) {
      if (!org.purgeAt || Date.parse(org.purgeAt) > t) continue;
      try {
        const result = purgeOrg(org);
        audit(null, 'org_purged', { orgId: org.id, name: org.name, ...result, early: false });
      } catch (e) { console.error(`[console] falha ao apagar "${org.name}":`, e.message); }
    }
  }
  const _purgeBoot = setTimeout(runOrgPurgeJob, 2 * 60 * 1000); _purgeBoot.unref();
  setInterval(runOrgPurgeJob, 60 * 60 * 1000).unref();

  /* Trocar o dono (suporte da plataforma). O dono anterior vira administrador. */
  app.post('/api/console/orgs/:id/owner', requireConsole, (req, res) => {
    const org = allOrgs().find(o => o.id === req.params.id);
    if (!org) return res.status(404).json({ error: 'Organização não encontrada.' });
    const target = tenancy.memberIn(String((req.body || {}).userId || ''), org.id);
    if (!target || target.active === false) return res.status(400).json({ error: 'Escolha uma pessoa ativa da organização.' });
    const prev = org.ownerId ? tenancy.memberIn(org.ownerId, org.id) : null;
    if (prev && prev !== target) { prev.role = 'admin'; saveEntity('memberships', prev); }
    target.role = 'owner'; target.workspaces = [];
    org.ownerId = target.userId;
    saveEntity('memberships', target);
    saveEntity('organizations', org);
    const u = userById(target.userId);
    audit(req, 'org_owner_changed', { orgId: org.id, name: org.name, owner: u ? u.name : target.userId });
    res.json(orgSummary(org));
  });

  /* ───────────── Lista de espera ───────────── */
  function publicRequest(r) {
    return {
      id: r.id, name: r.name, email: r.email, company: r.company, website: r.website || '',
      teamSize: r.teamSize, role: r.role || '', phone: r.phone || '', source: r.source || '',
      message: r.message || '', status: r.status, notes: r.notes || [],
      createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt,
      reviewedBy: r.reviewedBy || null, reviewedAt: r.reviewedAt || null, submissions: r.submissions || 1,
      orgId: r.orgId || null, orgName: r.orgId ? ((db.organizations || []).find(o => o.id === r.orgId) || {}).name || r.orgNameAtPurge || null : null,
      orgPurgedAt: r.orgPurgedAt || null
    };
  }
  const clip = (v, n) => String(v || '').trim().slice(0, n);

  app.post('/api/access-requests', rlRequest, (req, res) => {
    const b = req.body || {};
    // Robôs: campo isca preenchido ou envio rápido demais → finge que deu certo.
    if (b.company_site || (Number(b.elapsedMs) > 0 && Number(b.elapsedMs) < 2500)) return res.status(201).json({ ok: true });
    const name = clip(b.name, 120), company = clip(b.company, 120), email = normEmail(b.email);
    if (name.length < 2) return res.status(400).json({ error: 'Informe seu nome.', field: 'name' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Informe um e-mail válido.', field: 'email' });
    if (company.length < 2) return res.status(400).json({ error: 'Informe o nome da empresa ou agência.', field: 'company' });
    if (!TEAM_SIZES.includes(b.teamSize)) return res.status(400).json({ error: 'Escolha o tamanho da equipe.', field: 'teamSize' });
    if (b.consent !== true) return res.status(400).json({ error: 'Aceite a Política de Privacidade para enviar.', field: 'consent' });
    const fields = {
      name, email, company,
      website: clip(b.website, 200), teamSize: b.teamSize, role: clip(b.role, 80), phone: clip(b.phone, 40),
      source: SOURCES.includes(b.source) ? b.source : '', message: clip(b.message, 2000)
    };
    const at = nowISO();
    // Mesmo e-mail com pedido ainda aberto: atualiza em vez de duplicar.
    let r = db.accessRequests.find(x => x.email === email && (x.status === 'new' || x.status === 'reviewing'));
    if (r) {
      Object.assign(r, fields, { updatedAt: at, submissions: (r.submissions || 1) + 1 });
    } else {
      r = { id: uid(), ...fields, status: 'new', notes: [], createdAt: at, updatedAt: at, submissions: 1, ipHash: sha256('rw:' + clientIp(req)).slice(0, 16), consentAt: at };
      db.accessRequests.push(r);
    }
    saveEntity('accessRequests', r);
    // Confirmação pra quem pediu + aviso pros superadmins (se o e-mail estiver configurado).
    if (mailEnabled()) {
      const baseUrl = appBaseUrl(req);
      setImmediate(() => {
        const mine = emailTpl.accessRequestReceived({ name, company, baseUrl });
        sendEmail(email, mine.subject, mine.html, mine.text);
        const notice = emailTpl.accessRequestNew({ request: fields, consoleUrl: `${baseUrl}/console/lista-de-espera?id=${r.id}`, baseUrl });
        for (const a of db.platformAdmins) if (a.active !== false && a.totpEnabledAt) sendEmail(a.email, notice.subject, notice.html, notice.text);
      });
    }
    res.status(201).json({ ok: true });
  });

  app.get('/api/console/access-requests', requireConsole, (req, res) => {
    const items = db.accessRequests.slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicRequest);
    res.json({ items, counts: requestCounts(), plans });
  });

  app.patch('/api/console/access-requests/:id', requireConsole, (req, res) => {
    const r = db.accessRequests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const { status, note } = req.body || {};
    const at = nowISO();
    if (status !== undefined) {
      if (!REQUEST_STATUSES.includes(status)) return res.status(400).json({ error: 'Situação inválida.' });
      if (status !== r.status) {
        const from = r.status;
        r.status = status;
        r.reviewedBy = req.consoleAdmin.name; r.reviewedAt = at;
        r.notes = [...(r.notes || []), { id: uid(), kind: 'status', from, to: status, by: req.consoleAdmin.name, at }];
        audit(req, 'request_status', { requestId: r.id, email: r.email, from, to: status });
      }
    }
    const text = clip(note, 2000);
    if (text) {
      r.notes = [...(r.notes || []), { id: uid(), kind: 'note', text, by: req.consoleAdmin.name, at }];
      audit(req, 'request_note', { requestId: r.id, email: r.email });
    }
    r.updatedAt = at;
    saveEntity('accessRequests', r);
    res.json(publicRequest(r));
  });

  app.post('/api/console/access-requests/:id/create-org', requireConsole, async (req, res) => {
    const r = db.accessRequests.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (r.orgId) return res.status(409).json({ error: 'A organização deste pedido já foi criada.' });
    const name = clip((req.body || {}).name || r.company, 80);
    if (name.length < 2) return res.status(400).json({ error: 'Informe o nome da organização.', field: 'name' });
    // Sem escolha, nasce no Teste (os 14 dias começam quando o dono entrar).
    const plan = plans.find(p => p.id === (req.body || {}).planId) || plans.find(p => p.id === 'teste');
    const { org, link, emailSent } = await createOrgWithOwner(req, { name, ownerEmail: r.email, ownerName: r.name, requestId: r.id, createdBy: req.consoleAdmin.id });
    if (plan) { org.plan = { id: plan.id, changedAt: nowISO(), changedBy: req.consoleAdmin.name }; saveEntity('organizations', org); }
    const at = nowISO();
    const from = r.status;
    r.status = 'approved'; r.orgId = org.id;
    r.reviewedBy = req.consoleAdmin.name; r.reviewedAt = at; r.updatedAt = at;
    r.notes = [...(r.notes || []),
      ...(from !== 'approved' ? [{ id: uid(), kind: 'status', from, to: 'approved', by: req.consoleAdmin.name, at }] : []),
      { id: uid(), kind: 'org', text: `Organização "${org.name}" criada e convite de dono enviado para ${r.email}.`, by: req.consoleAdmin.name, at }];
    saveEntity('accessRequests', r);
    audit(req, 'org_created', { orgId: org.id, name: org.name, email: r.email, plan: orgPlan(org).name });
    res.status(201).json({ request: publicRequest(r), org: orgSummary(org), link, emailSent });
  });

  /* ───────────── Superadmins ───────────── */
  app.get('/api/console/admins', requireConsole, (req, res) => {
    res.json({ items: db.platformAdmins.map(publicAdmin), me: req.consoleAdmin.id });
  });

  function activationLink(req, a) {
    const token = crypto.randomBytes(24).toString('base64url');
    a.setupTokenHash = sha256(token);
    a.setupExpiresAt = new Date(now() + ACTIVATION_TTL_MS).toISOString();
    return `${appBaseUrl(req)}/console/ativar/${token}`;
  }
  async function sendActivation(req, a, link) {
    if (!mailEnabled()) return { sent: false, reason: 'smtp_not_configured' };
    const m = emailTpl.consoleAdminInvite({ name: a.name, inviter: req.consoleAdmin.name, link, baseUrl: appBaseUrl(req) });
    return sendEmail(a.email, m.subject, m.html, m.text);
  }

  app.post('/api/console/admins', requireConsole, async (req, res) => {
    const nm = clip((req.body || {}).name, 120);
    const em = normEmail((req.body || {}).email);
    if (!nm) return res.status(400).json({ error: 'Informe o nome.', field: 'name' });
    if (!isValidEmail(em)) return res.status(400).json({ error: 'Informe um e-mail válido.', field: 'email' });
    if (db.platformAdmins.some(a => a.email === em)) return res.status(409).json({ error: 'Já existe um superadmin com esse e-mail.', field: 'email' });
    const a = { id: 'pa_' + crypto.randomBytes(8).toString('hex'), name: nm, email: em, active: true, createdAt: nowISO(), createdBy: req.consoleAdmin.id, passwordSetAt: null, totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null };
    const link = activationLink(req, a);
    db.platformAdmins.push(a);
    saveEntity('platformAdmins', a);
    const mail = await sendActivation(req, a, link);
    audit(req, 'admin_invited', { adminId: a.id, email: em });
    res.status(201).json({ admin: publicAdmin(a), link, emailSent: !!mail.sent });
  });

  /* Novo link de ativação. Serve também pra quem perdeu o celular: a pessoa
     define senha nova e cadastra o app de novo. */
  app.post('/api/console/admins/:id/reset', requireConsole, async (req, res) => {
    const a = db.platformAdmins.find(x => x.id === req.params.id);
    if (!a || a.active === false) return res.status(404).json({ error: 'Superadmin não encontrado.' });
    if (a.id === req.consoleAdmin.id) return res.status(400).json({ error: 'Peça para outro superadmin gerar o seu link.' });
    if (a.twoFactorExempt) return res.status(400).json({ error: 'O acesso padrão não usa link de ativação. Desative-o e use a sua conta.' });
    const link = activationLink(req, a);
    saveEntity('platformAdmins', a);
    auth.dropTokensFor(a.id);
    const mail = await sendActivation(req, a, link);
    audit(req, 'admin_reset', { adminId: a.id, email: a.email });
    res.json({ admin: publicAdmin(a), link, emailSent: !!mail.sent });
  });

  app.patch('/api/console/admins/:id', requireConsole, (req, res) => {
    const a = db.platformAdmins.find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'Superadmin não encontrado.' });
    const { active } = req.body || {};
    if (typeof active === 'boolean' && active !== (a.active !== false)) {
      if (!active) {
        if (a.id === req.consoleAdmin.id) return res.status(400).json({ error: 'Você não pode desativar a própria conta.' });
        const left = db.platformAdmins.filter(x => x.id !== a.id && canEnter(x)).length;
        if (!left) return res.status(400).json({ error: 'É preciso manter pelo menos um superadmin ativo.' });
        auth.dropTokensFor(a.id);
      }
      a.active = active;
      a.setupTokenHash = null; a.setupExpiresAt = null;
      saveEntity('platformAdmins', a);
      audit(req, active ? 'admin_reactivated' : 'admin_deactivated', { adminId: a.id, email: a.email });
    }
    res.json(publicAdmin(a));
  });

  /* ───────────── Auditoria ───────────── */
  app.get('/api/console/audit', requireConsole, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    res.json({ items: db.platformAudit.slice(-limit).reverse() });
  });

  /* ───────────── Páginas ───────────── */
  const noindex = (res) => res.set('X-Robots-Tag', 'noindex, nofollow');
  app.get(/^\/console(?:\/.*)?$/, (req, res) => { noindex(res); res.sendFile(path.join(publicDir, 'console.html')); });
  app.get(/^\/acesso\/?$/, (req, res) => res.sendFile(path.join(publicDir, 'acesso.html')));

  return { totpVerify, hotp, b32decode, ensureDefaultAdmin, runOrgPurgeJob, requireConsole, audit };
};
