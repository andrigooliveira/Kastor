/* ───────────────────────────────────────────────────────────────
   reWork — Suporte (chamados)

   Quem abre: qualquer pessoa logada no app (/support). Cada chamado leva
   quem abriu (nome, usuário, e-mail), a organização e o contexto (página em
   que estava, plano, navegador). A conversa é uma lista de mensagens com
   anexos opcionais (prints e PDFs).

   Quem responde: os superadmins, pelo reWork Console (/console/suporte).
   Chamado novo e resposta do cliente → e-mail pra todos os superadmins
   ativos. Resposta da equipe → e-mail pra quem abriu + aviso no sino.

   Situação: open (esperando a equipe) → answered (esperando o cliente) →
   closed (resolvido). Responder um resolvido reabre.

   Excluir (quem abriu, pelo app; ou um superadmin, pelo console) apaga o
   chamado e os anexos de vez, pros dois lados.

   Os chamados moram em db.supportTickets (fora do filtro de organização: o
   console vê todos; no app cada pessoa só vê os próprios). Anexos ficam em
   DATA_DIR/support/ e só saem pelas rotas daqui (dono do chamado ou console).
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CATEGORIES = {
  duvida: 'Dúvida de uso',
  problema: 'Algo não funciona',
  cobranca: 'Plano e pagamento',
  conta: 'Acesso e conta',
  sugestao: 'Sugestão',
  outro: 'Outro'
};
const STATUS_LABEL = { open: 'Aberto', answered: 'Respondido', closed: 'Resolvido' };
const FILE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const FILE_MAX = 5 * 1024 * 1024;
const FILES_PER_MESSAGE = 4;
const BODY_MAX = 8000;
const SUBJECT_MAX = 140;

module.exports = function setupSupport(app, deps) {
  const db = new Proxy({}, { get: (_, key) => deps.getDb()[key] });
  const { dataDir, saveEntity, removeEntity, uid, nowISO, requireAuth, requireConsole, audit, sendEmail, mailEnabled, emailTpl, appBaseUrl, orgPlan, store, broadcastToUser, makeRateLimit, buildSha } = deps;
  const filesDir = path.join(dataDir, 'support');
  fs.mkdirSync(filesDir, { recursive: true });
  const list = () => db.supportTickets || [];
  const orgById = (id) => (db.organizations || []).find(o => o.id === id) || null;
  const userById = (id) => (db.users || []).find(u => u.id === id) || null;

  /* ── Anexos (data URI no JSON → arquivo) ── */
  function saveFiles(files) {
    if (!Array.isArray(files) || !files.length) return { files: [] };
    if (files.length > FILES_PER_MESSAGE) return { error: `Envie até ${FILES_PER_MESSAGE} arquivos por mensagem.` };
    const out = [];
    for (const f of files) {
      const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String((f && f.dataUrl) || ''));
      if (!m || !FILE_TYPES[m[1].toLowerCase()]) return { error: 'Anexe só imagens (PNG, JPG, WEBP, GIF) ou PDF.' };
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > FILE_MAX) return { error: 'Cada arquivo pode ter até 5 MB.' };
      const type = m[1].toLowerCase();
      const id = crypto.randomBytes(12).toString('hex') + '.' + FILE_TYPES[type];
      fs.writeFileSync(path.join(filesDir, id), buf);
      out.push({ id, name: String((f && f.name) || id).slice(0, 120), type, size: buf.length });
    }
    return { files: out };
  }
  /* Apaga o chamado e os anexos (de vez, pros dois lados). */
  function deleteTicket(t) {
    for (const f of (t.messages || []).flatMap(m => m.files || [])) {
      try { fs.unlinkSync(path.join(filesDir, f.id)); } catch {}
    }
    const i = db.supportTickets.indexOf(t);
    if (i >= 0) db.supportTickets.splice(i, 1);
    removeEntity('supportTickets', t.id);
  }
  function sendFile(res, ticket, fileId) {
    const ok = ticket && (ticket.messages || []).some(m => (m.files || []).some(f => f.id === fileId));
    if (!ok || !/^[a-f0-9]{24}\.(png|jpg|webp|gif|pdf)$/.test(fileId)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    const f = ticket.messages.flatMap(m => m.files || []).find(x => x.id === fileId);
    res.setHeader('Content-Type', f.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(path.join(filesDir, fileId)).on('error', () => res.status(404).end()).pipe(res);
  }

  /* ── Formatos de saída ── */
  const publicMessage = (m, forStaff) => ({
    id: m.id, from: m.from, authorName: m.from === 'staff' && !forStaff ? 'Equipe reWork' : m.authorName,
    staffName: forStaff && m.from === 'staff' ? m.authorName : undefined,
    body: m.body, at: m.at, files: (m.files || []).map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size }))
  });
  function summary(t, forStaff) {
    const last = (t.messages || [])[t.messages.length - 1] || {};
    return {
      id: t.id, number: t.number, subject: t.subject, category: t.category, categoryLabel: CATEGORIES[t.category] || t.category,
      status: t.status, statusLabel: STATUS_LABEL[t.status], createdAt: t.createdAt, updatedAt: t.updatedAt,
      lastFrom: last.from || null, preview: String(last.body || '').slice(0, 160), messages: (t.messages || []).length,
      unread: forStaff ? !!t.unreadForStaff : !!t.unreadForUser,
      orgId: t.orgId, orgName: t.orgName,
      ...(forStaff ? { userName: t.userName, username: t.username, email: t.email } : {})
    };
  }
  function detail(t, forStaff) {
    return {
      ...summary(t, forStaff),
      userName: t.userName, username: t.username, email: t.email,
      messages: (t.messages || []).map(m => publicMessage(m, forStaff)),
      ...(forStaff ? { context: t.context || null, orgPlan: (() => { const o = orgById(t.orgId); return o ? orgPlan(o).name : null; })() } : {})
    };
  }

  /* ── Avisos ── */
  function staffEmails() {
    return (db.platformAdmins || []).filter(a => a.active !== false && /@/.test(a.email || '')).map(a => a.email);
  }
  async function mailStaff(req, t, kind, message) {
    if (!mailEnabled()) return;
    const to = staffEmails();
    if (!to.length) return;
    const base = appBaseUrl(req);
    const mail = emailTpl.supportToStaff({ ticket: t, message, kind, link: `${base}/console/suporte/${t.id}`, baseUrl: base, categoryLabel: CATEGORIES[t.category] || t.category });
    for (const addr of to) {
      try { await sendEmail(addr, mail.subject, mail.html, mail.text); } catch (e) { console.warn('[support] e-mail pro console', e.message); }
    }
  }
  async function notifyCustomer(req, t, message) {
    const base = appBaseUrl(req);
    const link = `${base}/${t.orgId}/support/${t.number}`;
    if (mailEnabled() && t.email) {
      const mail = emailTpl.supportToCustomer({ ticket: t, message, link, baseUrl: base });
      try { await sendEmail(t.email, mail.subject, mail.html, mail.text); } catch (e) { console.warn('[support] e-mail pro cliente', e.message); }
    }
    // Aviso no sino (vale na organização do chamado).
    const n = {
      id: uid(), userId: t.userId, type: 'support_reply', orgId: t.orgId,
      demandId: null, demandName: t.subject, fromUser: null, ticketNumber: t.number,
      commentText: String(message.body || '').slice(0, 200), read: false, createdAt: nowISO()
    };
    store.insertNotification(n).catch(err => console.error('[support] notificação:', err.message));
    try { broadcastToUser(t.userId, 'notification', 'create'); } catch {}
  }

  /* ── App: quem abriu ── */
  const rlCreate = makeRateLimit(new Map(), 10, 'chamados', (req) => req.user ? req.user.id : req.ip, 60 * 60 * 1000);
  const mine = (req) => list().filter(t => t.userId === req.user.id);
  const findMine = (req) => mine(req).find(t => String(t.number) === String(req.params.number));

  app.get('/api/support/tickets', requireAuth, (req, res) => {
    res.json({
      items: mine(req).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(t => summary(t, false)),
      categories: CATEGORIES, email: req.user.email || null, emailEnabled: mailEnabled()
    });
  });

  app.post('/api/support/tickets', requireAuth, rlCreate, (req, res) => {
    const b = req.body || {};
    const category = CATEGORIES[b.category] ? b.category : null;
    const subject = String(b.subject || '').trim().slice(0, SUBJECT_MAX);
    const body = String(b.message || '').trim().slice(0, BODY_MAX);
    if (!category) return res.status(400).json({ error: 'Escolha o assunto do chamado.', field: 'category' });
    if (subject.length < 4) return res.status(400).json({ error: 'Escreva um título curto para o chamado.', field: 'subject' });
    if (body.length < 10) return res.status(400).json({ error: 'Conte um pouco mais sobre o que aconteceu.', field: 'message' });
    const up = saveFiles(b.files);
    if (up.error) return res.status(400).json({ error: up.error, field: 'files' });
    const now = nowISO();
    const number = list().reduce((mx, t) => Math.max(mx, Number(t.number) || 0), 1000) + 1;
    const u = req.user;
    const ctx = b.context && typeof b.context === 'object' ? b.context : {};
    const t = {
      id: uid(), number, orgId: req.org.id, orgName: req.org.name,
      userId: u.id, userName: u.name || u.username, username: u.username, email: u.email || null,
      category, subject, status: 'open',
      messages: [{ id: uid(), from: 'user', authorId: u.id, authorName: u.name || u.username, body, at: now, files: up.files }],
      context: {
        path: String(ctx.path || '').slice(0, 300) || null,
        screen: String(ctx.screen || '').slice(0, 40) || null,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        plan: orgPlan(req.org).name, role: req.membership && req.membership.role, build: buildSha || null
      },
      createdAt: now, updatedAt: now, lastCustomerAt: now,
      unreadForStaff: true, unreadForUser: false
    };
    db.supportTickets.push(t);
    saveEntity('supportTickets', t);
    mailStaff(req, t, 'new', t.messages[0]);
    res.status(201).json(detail(t, false));
  });

  app.get('/api/support/tickets/:number', requireAuth, (req, res) => {
    const t = findMine(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    if (t.unreadForUser) { t.unreadForUser = false; saveEntity('supportTickets', t); }
    res.json(detail(t, false));
  });

  app.post('/api/support/tickets/:number/messages', requireAuth, (req, res) => {
    const t = findMine(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const body = String((req.body || {}).message || '').trim().slice(0, BODY_MAX);
    if (!body) return res.status(400).json({ error: 'Escreva a mensagem.', field: 'message' });
    const up = saveFiles((req.body || {}).files);
    if (up.error) return res.status(400).json({ error: up.error, field: 'files' });
    const m = { id: uid(), from: 'user', authorId: req.user.id, authorName: req.user.name || req.user.username, body, at: nowISO(), files: up.files };
    const reopened = t.status === 'closed';
    t.messages.push(m);
    t.status = 'open'; t.updatedAt = m.at; t.lastCustomerAt = m.at; t.closedAt = null;
    t.unreadForStaff = true;
    saveEntity('supportTickets', t);
    mailStaff(req, t, reopened ? 'reopened' : 'reply', m);
    res.json(detail(t, false));
  });

  app.post('/api/support/tickets/:number/close', requireAuth, (req, res) => {
    const t = findMine(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    t.status = 'closed'; t.closedAt = nowISO(); t.closedBy = 'customer'; t.updatedAt = t.closedAt;
    saveEntity('supportTickets', t);
    res.json(detail(t, false));
  });

  app.delete('/api/support/tickets/:number', requireAuth, (req, res) => {
    const t = findMine(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    deleteTicket(t);
    res.json({ deleted: true });
  });

  app.get('/api/support/tickets/:number/files/:file', requireAuth, (req, res) => sendFile(res, findMine(req), req.params.file));

  /* ── Console: superadmins ── */
  app.get('/api/console/support', requireConsole, (req, res) => {
    const st = String(req.query.status || 'active');
    const all = list();
    const items = all.filter(t => st === 'all' ? true : st === 'active' ? t.status !== 'closed' : t.status === st)
      .slice().sort((a, b) => {
        // Esperando a equipe primeiro, do mais antigo pro mais novo; o resto por atualização.
        if (a.status === 'open' && b.status !== 'open') return -1;
        if (b.status === 'open' && a.status !== 'open') return 1;
        return a.status === 'open' ? String(a.updatedAt).localeCompare(String(b.updatedAt)) : String(b.updatedAt).localeCompare(String(a.updatedAt));
      })
      .map(t => summary(t, true));
    const counts = { open: 0, answered: 0, closed: 0 };
    all.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
    res.json({ items, counts, categories: CATEGORIES, emailEnabled: mailEnabled(), staffEmails: staffEmails().length });
  });

  const findAny = (req) => list().find(t => t.id === req.params.id);
  app.get('/api/console/support/:id', requireConsole, (req, res) => {
    const t = findAny(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    if (t.unreadForStaff) { t.unreadForStaff = false; saveEntity('supportTickets', t); }
    const user = userById(t.userId);
    res.json({ ...detail(t, true), userActive: !!user, otherTickets: list().filter(x => x.userId === t.userId && x.id !== t.id).length });
  });

  app.post('/api/console/support/:id/reply', requireConsole, async (req, res) => {
    const t = findAny(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const b = req.body || {};
    const body = String(b.message || '').trim().slice(0, BODY_MAX);
    if (!body) return res.status(400).json({ error: 'Escreva a resposta.', field: 'message' });
    const m = { id: uid(), from: 'staff', authorId: req.consoleAdmin.id, authorName: req.consoleAdmin.name, body, at: nowISO(), files: [] };
    t.messages.push(m);
    t.status = b.close ? 'closed' : 'answered';
    if (b.close) { t.closedAt = m.at; t.closedBy = 'staff'; }
    t.updatedAt = m.at; t.lastStaffAt = m.at;
    t.unreadForUser = true; t.unreadForStaff = false;
    saveEntity('supportTickets', t);
    audit(req, 'support_reply', { ticket: t.number, org: t.orgName, close: !!b.close });
    notifyCustomer(req, t, m);
    res.json(detail(t, true));
  });

  app.post('/api/console/support/:id/status', requireConsole, (req, res) => {
    const t = findAny(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const status = String((req.body || {}).status || '');
    if (!STATUS_LABEL[status]) return res.status(400).json({ error: 'Situação inválida.' });
    t.status = status; t.updatedAt = nowISO();
    if (status === 'closed') { t.closedAt = t.updatedAt; t.closedBy = 'staff'; } else t.closedAt = null;
    saveEntity('supportTickets', t);
    audit(req, 'support_status', { ticket: t.number, org: t.orgName, status });
    res.json(detail(t, true));
  });

  app.delete('/api/console/support/:id', requireConsole, (req, res) => {
    const t = findAny(req);
    if (!t) return res.status(404).json({ error: 'Chamado não encontrado.' });
    audit(req, 'support_deleted', { ticket: t.number, org: t.orgName, subject: t.subject, from: t.username });
    deleteTicket(t);
    res.json({ deleted: true });
  });

  app.get('/api/console/support/:id/files/:file', requireConsole, (req, res) => sendFile(res, findAny(req), req.params.file));

  // Pro contador do menu do console.
  const openCount = () => list().filter(t => t.status === 'open').length;
  return { openCount, CATEGORIES };
};
