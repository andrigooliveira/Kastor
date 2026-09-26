/* ───────────────────────────────────────────────────────────────
   reWork — Cobrança dos planos (Asaas)

   Quem configura: o reWork Console (Pagamentos). A chave de API do Asaas
   fica no banco, criptografada (auth.encryptString) — nada de variável de
   ambiente. Ao salvar a chave, o reWork cadastra o próprio webhook no Asaas
   com um token gerado aqui.

   Como o dono assina (página Plano e pagamento → /api/billing/checkout):
     - Cartão: página de pagamento do Asaas (Checkout recorrente). O cartão
       fica salvo lá; o Asaas cria a assinatura e avisa (SUBSCRIPTION_CREATED).
     - Pix / boleto: o reWork cria a assinatura pela API e mostra a fatura.
   Todo ciclo o Asaas gera a cobrança sozinho e manda por e-mail (e a nota
   fiscal, se ligada no painel do Asaas).

   O que manda no acesso: org.plan.paidUntil ("pago até"). Cada pagamento
   confirmado estende um ciclo a partir do vencimento. Passado o "pago até",
   a organização tem BILLING_GRACE_DAYS pra pagar; depois fica só pra
   consulta (ver orgPlan no server). Assinatura cancelada vale até o
   "pago até", sem carência.

   Trocas:
     - plano no mesmo ciclo e forma de pagamento: muda o valor da assinatura
       (vale na próxima cobrança). Subir libera os limites na hora; descer
       vale a partir do próximo pagamento e só se o uso couber no plano novo;
     - ciclo ou forma de pagamento: cria uma assinatura nova que começa no
       fim do período já pago e apaga a antiga.

   Preço de fundador: as primeiras N organizações a assinar (até a data do
   console) guardam founder = true e pagam FOUNDER_PRICES pra sempre, mesmo
   que PRICES suba depois.
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');

const PRICES = {
  essencial: { MONTHLY: 79, YEARLY: 790 },
  equipe:    { MONTHLY: 179, YEARLY: 1790 },
  agencia:   { MONTHLY: 299, YEARLY: 2990 }
};
// Preço de lançamento, travado pra quem entrou como fundador.
const FOUNDER_PRICES = {
  essencial: { MONTHLY: 79, YEARLY: 790 },
  equipe:    { MONTHLY: 179, YEARLY: 1790 },
  agencia:   { MONTHLY: 299, YEARLY: 2990 }
};
const PAID_PLANS = Object.keys(PRICES);
const CYCLES = { MONTHLY: 1, YEARLY: 12 };
const METHODS = ['CREDIT_CARD', 'PIX', 'BOLETO'];
const METHOD_LABEL = { CREDIT_CARD: 'Cartão de crédito', PIX: 'Pix', BOLETO: 'Boleto' };
const BILLING_GRACE_DAYS = 7;
const KV_KEY = 'billing:config';
const BASE_URLS = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' };
const CHECKOUT_URLS = { sandbox: 'https://sandbox.asaas.com/checkoutSession/show?id=', production: 'https://asaas.com/checkoutSession/show?id=' };
const WEBHOOK_EVENTS = [
  'PAYMENT_CREATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED',
  'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
  'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_UPDATED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_DELETED'
];
const DAY = 864e5;

/* ── CPF/CNPJ (só dígitos + dígito verificador) ── */
function validCpf(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
function validCnpj(d) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

/* Datas no fuso de Brasília (vencimentos do Asaas são datas, sem hora). */
function ymdBr(ms) {
  const d = new Date((ms == null ? Date.now() : ms) - 3 * 3600e3);
  return d.toISOString().slice(0, 10);
}
// Fim do dia `ymd` + `months` meses, em Brasília (31/jan + 1 mês = 28 ou 29/fev).
function endOfCycle(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const tm = m - 1 + months;
  const ty = y + Math.floor(tm / 12), tmm = ((tm % 12) + 12) % 12;
  const day = Math.min(d, new Date(Date.UTC(ty, tmm + 1, 0)).getUTCDate());
  return new Date(Date.UTC(ty, tmm, day, 23 + 3, 59, 59)).toISOString(); // 23:59:59 -03:00
}

module.exports = function setupBilling(app, deps) {
  const db = new Proxy({}, { get: (_, key) => deps.getDb()[key] });
  const { store, auth, saveEntity, nowISO, requireAuth, plans, orgPlan, orgUsage, appBaseUrl, requireConsole, audit } = deps;
  const planById = (id) => plans.find(p => p.id === id) || null;
  const orgById = (id) => (db.organizations || []).find(o => o.id === id) || null;

  /* ── Configuração (KV, chave criptografada) ── */
  let config = null; // { env, apiKeyEnc, apiKeyLast4, webhookId, webhookTokenEnc, webhookUrl, founderSlots, founderUntil, updatedAt, updatedBy }
  async function loadConfig() {
    try { const raw = await store.getKv(KV_KEY); config = raw ? JSON.parse(raw) : null; } catch { config = null; }
    return config;
  }
  async function saveConfig(next) {
    config = next;
    await store.setKv(KV_KEY, JSON.stringify(next));
  }
  const cfg = () => config || {};
  const enabled = () => !!(config && config.apiKeyEnc && config.env);
  const apiKey = () => { try { return auth.decryptString(cfg().apiKeyEnc); } catch { return null; } };
  const webhookToken = () => { try { return cfg().webhookTokenEnc ? auth.decryptString(cfg().webhookTokenEnc) : null; } catch { return null; } };
  // ASAAS_API_BASE só pra teste automatizado (servidor falso do Asaas).
  const baseUrl = (env) => process.env.ASAAS_API_BASE || BASE_URLS[env || cfg().env] || BASE_URLS.sandbox;

  /* ── Cliente da API do Asaas ── */
  async function asaas(method, path, body, opts = {}) {
    const key = opts.key || apiKey();
    if (!key) throw Object.assign(new Error('Cobrança não configurada.'), { status: 503 });
    let res;
    try {
      res = await fetch(baseUrl(opts.env) + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'access_token': key, 'User-Agent': 'reWork' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      throw Object.assign(new Error('Não foi possível falar com o Asaas agora. Tente de novo em instantes.'), { status: 502, cause: e });
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const msg = data && Array.isArray(data.errors) && data.errors.length ? data.errors.map(e => e.description).join(' ') : `Asaas respondeu ${res.status}.`;
      throw Object.assign(new Error(msg), { status: res.status === 401 ? 400 : 502, asaasStatus: res.status, data });
    }
    return data;
  }

  /* ── Preços ── */
  function founderInfo() {
    const slots = Number.isInteger(cfg().founderSlots) ? cfg().founderSlots : 20;
    const used = (db.organizations || []).filter(o => o.billing && o.billing.founder).length;
    const until = cfg().founderUntil || null;
    const open = used < slots && (!until || ymdBr() <= until);
    return { slots, used, left: Math.max(0, slots - used), until, open };
  }
  function priceTableFor(org) {
    const b = org && org.billing;
    if (b && b.founder) return FOUNDER_PRICES;
    // Quem ainda não assinou e cabe nas vagas de fundador vê o preço de fundador.
    if ((!b || !b.subscriptionId) && founderInfo().open) return FOUNDER_PRICES;
    return PRICES;
  }
  function priceFor(org, planId, cycle) {
    const t = priceTableFor(org)[planId];
    return t ? t[cycle] : null;
  }
  function catalogFor(org) {
    const table = priceTableFor(org);
    return PAID_PLANS.map(id => {
      const p = planById(id);
      return { id, name: p.name, users: p.users, storageGb: p.storageGb, fileMb: p.fileMb, prices: table[id], standard: PRICES[id] };
    });
  }

  /* ── Estado da organização ── */
  function ensureBilling(org) {
    if (!org.billing) org.billing = { status: 'none', events: [], paidPayments: [], log: [] };
    const b = org.billing;
    b.events = b.events || []; b.paidPayments = b.paidPayments || []; b.log = b.log || [];
    return b;
  }
  function logEvent(b, entry) {
    b.log.unshift({ at: nowISO(), ...entry });
    if (b.log.length > 40) b.log.length = 40;
  }
  function publicBilling(org) {
    const b = org.billing || {};
    const plan = orgPlan(org);
    return {
      status: b.status || 'none',
      planId: b.planId || null, nextPlanId: b.nextPlanId || null,
      cycle: b.cycle || null, method: b.method || null, value: b.value || null,
      founder: !!b.founder,
      customer: b.customerId ? { name: b.name || null, email: b.email || null, doc: b.cpfCnpj ? maskDoc(b.cpfCnpj) : null } : null,
      pending: b.pending ? { planId: b.pending.planId, cycle: b.pending.cycle, method: b.pending.method, url: b.pending.url || null, createdAt: b.pending.createdAt } : null,
      pendingInvoiceUrl: b.pendingInvoiceUrl || null,
      paidUntil: plan.paidUntil || null, graceEndsAt: plan.graceEndsAt || null, overdue: !!plan.overdue, canceled: !!plan.canceled,
      lastPaymentAt: b.lastPaymentAt || null
    };
  }
  function maskDoc(d) { return d.length === 14 ? `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}` : `***.${d.slice(3, 6)}.***-${d.slice(9)}`; }

  // Data em que a assinatura nova começa a cobrar: o dia seguinte ao fim do
  // período já pago, ou o dia em que o teste acaba; sem nada disso, hoje.
  function startDateFor(org) {
    const p = orgPlan(org);
    const now = Date.now();
    const candidates = [];
    if (p.paidUntil && !p.canceled && Date.parse(p.paidUntil) > now) candidates.push(Date.parse(p.paidUntil));
    if (p.trial && p.trialEndsAt && Date.parse(p.trialEndsAt) > now) candidates.push(Date.parse(p.trialEndsAt));
    if (!candidates.length) return ymdBr();
    return ymdBr(Math.max(...candidates) + 60e3);
  }

  /* Liga a assinatura criada à organização (Pix/boleto na hora; cartão
     quando o Asaas avisa que a assinatura do checkout foi criada). */
  async function adoptSubscription(org, sub, intent) {
    const b = ensureBilling(org);
    const oldId = b.subscriptionId && b.subscriptionId !== sub.id ? b.subscriptionId : null;
    b.subscriptionId = sub.id;
    b.planId = intent.planId; b.nextPlanId = null;
    b.cycle = intent.cycle; b.method = intent.method;
    b.value = Number(sub.value) || intent.value;
    b.pending = null;
    if (!b.startedAt) b.startedAt = nowISO();
    if (b.founder === undefined || b.founder === null) b.founder = false;
    if (intent.founder) b.founder = true;
    const p = orgPlan(org);
    const paidAhead = p.paidUntil && !p.canceled && Date.parse(p.paidUntil) > Date.now();
    const inTrial = p.trial && p.trialEndsAt && Date.parse(p.trialEndsAt) > Date.now();
    b.status = paidAhead || inTrial ? 'active' : 'pending';
    // Assinou durante o teste: o plano escolhido vale já, até o fim do teste
    // (a primeira cobrança vence nesse dia).
    if (inTrial) {
      org.plan = { id: intent.planId, paidUntil: p.trialEndsAt, source: 'billing', changedAt: nowISO(), changedBy: 'Assinatura' };
    } else if (paidAhead) {
      // Troca de ciclo/forma: plano atual segue até o fim do pago.
      org.plan = { ...org.plan, canceled: false };
    }
    logEvent(b, { event: 'subscribed', detail: `${planById(intent.planId).name} · ${intent.cycle === 'YEARLY' ? 'anual' : 'mensal'} · ${METHOD_LABEL[intent.method]}` });
    saveEntity('organizations', org);
    if (oldId) {
      b.replaced = [...(b.replaced || []), oldId].slice(-10);
      saveEntity('organizations', org);
      try { await asaas('DELETE', '/subscriptions/' + oldId); } catch (e) { console.warn('[billing] não apagou a assinatura antiga', oldId, e.message); }
    }
  }

  /* Pagamento confirmado: estende o "pago até" um ciclo a partir do vencimento. */
  function onPaid(org, p) {
    const b = ensureBilling(org);
    if (b.paidPayments.includes(p.id)) return false;
    b.paidPayments.unshift(p.id); if (b.paidPayments.length > 36) b.paidPayments.length = 36;
    const months = CYCLES[b.cycle] || 1;
    const due = String(p.dueDate || ymdBr()).slice(0, 10);
    const end = endOfCycle(due, months);
    const cur = org.plan && org.plan.source === 'billing' && org.plan.paidUntil ? org.plan.paidUntil : null;
    const paidUntil = cur && Date.parse(cur) > Date.parse(end) ? cur : end;
    const planId = b.nextPlanId || b.planId || (org.plan && org.plan.id);
    b.planId = planId; b.nextPlanId = null;
    b.status = 'active'; b.lastPaymentAt = nowISO(); b.pendingInvoiceUrl = null;
    org.plan = { id: planId, paidUntil, source: 'billing', changedAt: nowISO(), changedBy: 'Asaas' };
    logEvent(b, { event: 'paid', paymentId: p.id, value: p.value, detail: `pago até ${paidUntil.slice(0, 10)}` });
    return true;
  }

  /* ── Webhook do Asaas ── */
  function orgByCustomer(customerId) {
    if (!customerId) return null;
    return (db.organizations || []).find(o => o.billing && o.billing.customerId === customerId) || null;
  }
  async function handleEvent(ev) {
    const payment = ev.payment || null;
    const sub = ev.subscription || null;
    const obj = payment || sub || {};
    let org = orgByCustomer(obj.customer);
    // Reserva: a referência que mandamos (id da organização). Cobre o caso de
    // o checkout do cartão criar outro cadastro de cliente no Asaas.
    if (!org && obj.externalReference) {
      const byRef = orgById(obj.externalReference);
      if (byRef && byRef.billing && byRef.billing.customerId) { org = byRef; org.billing.customerId = obj.customer || org.billing.customerId; }
    }
    if (!org) { console.warn('[billing] evento sem organização:', ev.event, obj.customer || '', obj.id || ''); return 'ignored'; }
    const b = ensureBilling(org);
    if (ev.id && b.events.includes(ev.id)) return 'duplicate';
    if (ev.id) { b.events.unshift(ev.id); if (b.events.length > 100) b.events.length = 100; }
    const e = ev.event;
    // Assinatura do checkout de cartão chegou: liga à organização.
    const adoptCard = async (subId, value) => {
      if (!b.pending || b.pending.method !== 'CREDIT_CARD' || b.subscriptionId === subId) return;
      if ((b.replaced || []).includes(subId)) return;
      await adoptSubscription(org, { id: subId, value }, b.pending);
    };
    if (e === 'SUBSCRIPTION_CREATED' && sub) {
      await adoptCard(sub.id, sub.value);
    } else if ((e === 'SUBSCRIPTION_DELETED' || e === 'SUBSCRIPTION_INACTIVATED') && sub) {
      if (sub.id === b.subscriptionId && !(b.replaced || []).includes(sub.id)) {
        b.status = 'canceled'; b.canceledAt = b.canceledAt || nowISO();
        if (org.plan && org.plan.source === 'billing') org.plan = { ...org.plan, canceled: true };
        logEvent(b, { event: 'canceled', detail: 'assinatura encerrada no Asaas' });
      }
    } else if ((e === 'PAYMENT_CONFIRMED' || e === 'PAYMENT_RECEIVED') && payment) {
      if (payment.subscription && payment.subscription !== b.subscriptionId) await adoptCard(payment.subscription, payment.value);
      if (!payment.subscription || payment.subscription === b.subscriptionId) onPaid(org, payment);
    } else if (e === 'PAYMENT_CREATED' && payment && payment.subscription === b.subscriptionId) {
      if (b.status === 'pending') b.pendingInvoiceUrl = payment.invoiceUrl || b.pendingInvoiceUrl || null;
    } else if (e === 'PAYMENT_OVERDUE' && payment && payment.subscription === b.subscriptionId) {
      b.status = 'past_due';
      b.pendingInvoiceUrl = payment.invoiceUrl || null;
      logEvent(b, { event: 'overdue', paymentId: payment.id, value: payment.value });
    } else if (e === 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' && payment) {
      logEvent(b, { event: 'card_refused', paymentId: payment.id, value: payment.value });
    } else if ((e === 'PAYMENT_REFUNDED' || e === 'PAYMENT_CHARGEBACK_REQUESTED') && payment) {
      // Não tira o plano sozinho: fica registrado pro console decidir.
      logEvent(b, { event: e === 'PAYMENT_REFUNDED' ? 'refunded' : 'chargeback', paymentId: payment.id, value: payment.value });
    }
    saveEntity('organizations', org);
    return 'ok';
  }

  app.post('/api/billing/webhook', async (req, res) => {
    const token = webhookToken();
    const got = String(req.headers['asaas-access-token'] || '');
    const ok = token && got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
    if (!ok) return res.status(401).json({ error: 'token inválido' });
    try {
      const r = await handleEvent(req.body || {});
      res.json({ received: true, result: r });
    } catch (e) {
      console.error('[billing] webhook', e);
      // 200 mesmo assim: repetir o mesmo evento não resolve e travaria a fila do Asaas.
      res.json({ received: true, result: 'error' });
    }
  });

  /* ── Rotas do dono da organização ── */
  const ownerOnly = (req, res, next) => {
    if (!req.user.isOwner) return res.status(403).json({ error: 'Só o dono da organização cuida do plano e do pagamento.' });
    next();
  };
  app.get('/api/billing', requireAuth, (req, res) => {
    const org = req.org;
    const usage = orgUsage(org);
    res.json({
      enabled: enabled(), sandbox: cfg().env === 'sandbox',
      canManage: !!req.user.isOwner,
      plan: usage.plan, seats: usage.seats, storage: usage.storage,
      catalog: catalogFor(org), founder: { ...founderInfo(), mine: !!(org.billing && org.billing.founder) },
      billing: publicBilling(org),
      startDate: startDateFor(org),
      graceDays: BILLING_GRACE_DAYS,
      defaults: { name: org.name, email: req.user.email || '' }
    });
  });

  function checkFits(org, planId) {
    const p = planById(planId);
    const u = orgUsage(org);
    if (p.users != null && u.seats.used > p.users) return `O plano ${p.name} vai até ${p.users} pessoas, e a organização tem ${u.seats.used} (contando convites pendentes). Desative alguém ou cancele convites antes de mudar.`;
    if (p.storageGb != null && u.storage.bytes > p.storageGb * 1024 ** 3) return `O plano ${p.name} tem ${p.storageGb} GB de espaço, e a organização já usa mais que isso. Apague arquivos antes de mudar.`;
    return null;
  }

  app.post('/api/billing/checkout', requireAuth, ownerOnly, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'O pagamento ainda não está disponível. Fale com o suporte do reWork.' });
    const org = req.org;
    const bd = req.body || {};
    const planId = String(bd.planId || '');
    const cycle = String(bd.cycle || '');
    const method = String(bd.method || '');
    if (!PAID_PLANS.includes(planId)) return res.status(400).json({ error: 'Escolha um plano.', field: 'planId' });
    if (!CYCLES[cycle]) return res.status(400).json({ error: 'Escolha mensal ou anual.', field: 'cycle' });
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'Escolha a forma de pagamento.', field: 'method' });
    const name = String(bd.name || '').trim().slice(0, 120);
    const email = String(bd.email || '').trim().toLowerCase().slice(0, 160);
    // Em branco = mantém o CPF/CNPJ já salvo da organização.
    const doc = onlyDigits(bd.cpfCnpj) || (org.billing && org.billing.cpfCnpj) || '';
    if (name.length < 2) return res.status(400).json({ error: 'Informe o nome ou a razão social para a nota fiscal.', field: 'name' });
    if (!validCpf(doc) && !validCnpj(doc)) return res.status(400).json({ error: 'CPF ou CNPJ inválido. Confira os números.', field: 'cpfCnpj' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido para receber as faturas.', field: 'email' });
    const fitErr = checkFits(org, planId);
    const cur = orgPlan(org);
    // Descer de plano com uso acima do limite: bloqueia (subir sempre pode).
    if (fitErr && (planById(planId).users || 0) < (cur.users || Infinity)) return res.status(400).json({ error: fitErr, field: 'planId' });

    const b = ensureBilling(org);
    const founder = !!b.founder || (!b.subscriptionId && founderInfo().open);
    const value = (founder ? FOUNDER_PRICES : PRICES)[planId][cycle];
    const planName = planById(planId).name;
    const description = `reWork ${planName} · ${cycle === 'YEARLY' ? 'anual' : 'mensal'} · ${org.name}`.slice(0, 250);
    try {
      // Cliente no Asaas (um por organização).
      const customerBody = { name, cpfCnpj: doc, email, externalReference: org.id, notificationDisabled: false };
      if (b.customerId) {
        try { await asaas('PUT', '/customers/' + b.customerId, customerBody); }
        catch (e) { if (e.asaasStatus === 404) b.customerId = null; else throw e; }
      }
      if (!b.customerId) b.customerId = (await asaas('POST', '/customers', customerBody)).id;
      b.name = name; b.email = email; b.cpfCnpj = doc;
      const nextDueDate = startDateFor(org);
      const intent = { planId, cycle, method, value, founder, createdAt: nowISO() };
      if (method === 'CREDIT_CARD') {
        const base = appBaseUrl(req);
        const back = `${base}/${org.id}/billing`;
        const co = await asaas('POST', '/checkouts', {
          billingTypes: ['CREDIT_CARD'], chargeTypes: ['RECURRENT'], minutesToExpire: 120,
          callback: { successUrl: back + '?pagamento=ok', cancelUrl: back + '?pagamento=cancelado', expiredUrl: back + '?pagamento=expirado' },
          items: [{ name: `reWork ${planName}`.slice(0, 30), description, quantity: 1, value }],
          subscription: { cycle, nextDueDate: `${nextDueDate} 12:00:00` },
          customer: b.customerId,
          externalReference: org.id
        });
        const url = co.link || (CHECKOUT_URLS[cfg().env] || CHECKOUT_URLS.sandbox) + co.id;
        b.pending = { ...intent, checkoutId: co.id, url };
        logEvent(b, { event: 'checkout', detail: `${planName} · cartão` });
        saveEntity('organizations', org);
        return res.json({ url, kind: 'checkout' });
      }
      const sub = await asaas('POST', '/subscriptions', {
        customer: b.customerId, billingType: method, value, nextDueDate, cycle, description, externalReference: org.id
      });
      await adoptSubscription(org, sub, intent);
      // Primeira fatura (existe quando vence hoje ou em poucos dias).
      let invoiceUrl = null;
      try {
        const pays = await asaas('GET', `/subscriptions/${sub.id}/payments`);
        const first = (pays.data || []).find(x => x.status === 'PENDING' || x.status === 'OVERDUE');
        invoiceUrl = first ? first.invoiceUrl : null;
      } catch {}
      if (b.status === 'pending') b.pendingInvoiceUrl = invoiceUrl;
      saveEntity('organizations', org);
      res.json({ url: invoiceUrl, kind: 'invoice', firstDueDate: nextDueDate, billing: publicBilling(org) });
    } catch (e) {
      console.warn('[billing] checkout', e.message);
      res.status(e.status || 500).json({ error: e.message || 'Não foi possível iniciar o pagamento.' });
    }
  });

  // Troca de plano mantendo ciclo e forma de pagamento.
  app.post('/api/billing/plan', requireAuth, ownerOnly, async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'O pagamento ainda não está disponível.' });
    const org = req.org;
    const b = ensureBilling(org);
    const planId = String((req.body || {}).planId || '');
    if (!PAID_PLANS.includes(planId)) return res.status(400).json({ error: 'Escolha um plano.' });
    if (!b.subscriptionId || b.status === 'canceled') return res.status(400).json({ error: 'A organização não tem assinatura ativa. Assine um plano primeiro.' });
    const current = b.nextPlanId || b.planId;
    if (planId === current) return res.json({ billing: publicBilling(org) });
    const up = (planById(planId).users || 0) > (planById(b.planId).users || 0);
    if (!up) { const err = checkFits(org, planId); if (err) return res.status(400).json({ error: err }); }
    const value = priceFor(org, planId, b.cycle);
    try {
      await asaas('PUT', '/subscriptions/' + b.subscriptionId, {
        value, updatePendingPayments: true,
        description: `reWork ${planById(planId).name} · ${b.cycle === 'YEARLY' ? 'anual' : 'mensal'} · ${org.name}`.slice(0, 250)
      });
    } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    b.value = value;
    if (up) {
      // Sobe na hora; o valor novo vale a partir da próxima cobrança.
      b.planId = planId; b.nextPlanId = null;
      if (org.plan) org.plan = { ...org.plan, id: planId, changedAt: nowISO(), changedBy: req.user.name };
    } else {
      b.nextPlanId = planId; // desce no próximo pagamento
    }
    logEvent(b, { event: 'plan_changed', detail: `${planById(current).name} → ${planById(planId).name}${up ? '' : ' (na próxima cobrança)'}` });
    saveEntity('organizations', org);
    res.json({ billing: publicBilling(org), plan: orgPlan(org) });
  });

  app.post('/api/billing/cancel', requireAuth, ownerOnly, async (req, res) => {
    const org = req.org;
    const b = ensureBilling(org);
    if (!b.subscriptionId || b.status === 'canceled') return res.status(400).json({ error: 'Não há assinatura ativa.' });
    try { await asaas('DELETE', '/subscriptions/' + b.subscriptionId); }
    catch (e) { if (e.asaasStatus !== 404) return res.status(e.status || 500).json({ error: e.message }); }
    b.status = 'canceled'; b.canceledAt = nowISO(); b.pending = null; b.nextPlanId = null;
    b.cancelReason = String((req.body || {}).reason || '').slice(0, 500) || null;
    if (org.plan && org.plan.source === 'billing') org.plan = { ...org.plan, canceled: true };
    logEvent(b, { event: 'canceled', detail: 'cancelada pelo dono' });
    saveEntity('organizations', org);
    res.json({ billing: publicBilling(org), plan: orgPlan(org) });
  });

  // Faturas (direto do Asaas).
  app.get('/api/billing/payments', requireAuth, ownerOnly, async (req, res) => {
    const b = req.org.billing;
    if (!enabled() || !b || !b.customerId) return res.json({ items: [] });
    try {
      const r = await asaas('GET', `/payments?customer=${encodeURIComponent(b.customerId)}&limit=24`);
      res.json({
        items: (r.data || []).map(p => ({
          id: p.id, value: p.value, status: p.status, dueDate: p.dueDate, paymentDate: p.paymentDate || p.confirmedDate || null,
          method: p.billingType, invoiceUrl: p.invoiceUrl || null, description: p.description || ''
        }))
      });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ── Console (superadmins) ── */
  function consoleView(req) {
    const orgs = (db.organizations || []).filter(o => !o.deletedAt);
    const subs = orgs.filter(o => o.billing && o.billing.subscriptionId && o.billing.status !== 'canceled');
    const mrr = subs.reduce((acc, o) => acc + (o.billing.cycle === 'YEARLY' ? o.billing.value / 12 : o.billing.value || 0), 0);
    const byPlan = {};
    subs.forEach(o => { byPlan[o.billing.planId] = (byPlan[o.billing.planId] || 0) + 1; });
    const now = Date.now();
    const row = (o) => {
      const p = orgPlan(o);
      return { id: o.id, name: o.name, planName: p.name, status: (o.billing && o.billing.status) || 'none', cycle: o.billing && o.billing.cycle, method: o.billing && o.billing.method, value: o.billing && o.billing.value, founder: !!(o.billing && o.billing.founder), paidUntil: p.paidUntil || null, graceEndsAt: p.graceEndsAt || null, trialEndsAt: p.trialEndsAt || null };
    };
    return {
      configured: enabled(),
      env: cfg().env || 'sandbox',
      apiKeyLast4: cfg().apiKeyLast4 || null,
      webhook: cfg().webhookId ? { id: cfg().webhookId, url: cfg().webhookUrl } : null,
      suggestedWebhookUrl: appBaseUrl(req) + '/api/billing/webhook',
      updatedAt: cfg().updatedAt || null, updatedBy: cfg().updatedBy || null,
      founder: founderInfo(),
      prices: PRICES, founderPrices: FOUNDER_PRICES,
      plans: PAID_PLANS.map(id => ({ id, name: planById(id).name })),
      stats: {
        mrr: Math.round(mrr * 100) / 100, subscribers: subs.length, byPlan,
        pastDue: orgs.filter(o => o.billing && o.billing.status === 'past_due').map(row),
        pending: orgs.filter(o => o.billing && o.billing.status === 'pending').map(row),
        trialsEnding: orgs.filter(o => { const p = orgPlan(o); return p.trial && p.trialEndsAt && Date.parse(p.trialEndsAt) > now && Date.parse(p.trialEndsAt) < now + 7 * DAY && !(o.billing && o.billing.subscriptionId); }).map(row),
        subscribers_list: subs.map(row)
      }
    };
  }
  app.get('/api/console/billing', requireConsole, (req, res) => res.json(consoleView(req)));

  app.put('/api/console/billing', requireConsole, async (req, res) => {
    const bd = req.body || {};
    const env = bd.env === 'production' ? 'production' : 'sandbox';
    const next = { ...cfg() };
    // Vagas e prazo do preço de fundador.
    if (bd.founderSlots !== undefined) {
      const n = Number(bd.founderSlots);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return res.status(400).json({ error: 'Vagas de fundador: número inteiro entre 0 e 10.000.', field: 'founderSlots' });
      next.founderSlots = n;
    }
    if (bd.founderUntil !== undefined) {
      if (bd.founderUntil && !/^\d{4}-\d{2}-\d{2}$/.test(bd.founderUntil)) return res.status(400).json({ error: 'Data inválida.', field: 'founderUntil' });
      next.founderUntil = bd.founderUntil || null;
    }
    const newKey = typeof bd.apiKey === 'string' ? bd.apiKey.trim() : '';
    const envChanged = env !== (cfg().env || 'sandbox');
    if (envChanged && !newKey) return res.status(400).json({ error: `Para trocar para ${env === 'production' ? 'Produção' : 'Sandbox'}, cole a chave de API dessa conta.`, field: 'apiKey' });
    if (newKey) {
      const prefixOk = env === 'production' ? newKey.startsWith('$aact_prod_') : newKey.startsWith('$aact_hmlg_');
      if (!prefixOk && !process.env.ASAAS_API_BASE) return res.status(400).json({ error: env === 'production' ? 'Essa não é uma chave de Produção (começa com $aact_prod_).' : 'Essa não é uma chave de Sandbox (começa com $aact_hmlg_).', field: 'apiKey' });
      // Confere a chave e cadastra o webhook (troca o antigo, se houver).
      try { await asaas('GET', '/finance/balance', null, { key: newKey, env }); }
      catch (e) { return res.status(400).json({ error: 'O Asaas não aceitou essa chave: ' + e.message, field: 'apiKey' }); }
      const url = appBaseUrl(req) + '/api/billing/webhook';
      if (!/^https:\/\//.test(url) && !process.env.ASAAS_API_BASE) return res.status(400).json({ error: `O webhook precisa de um endereço https (este console está em ${url}). Configure pelo endereço de produção do reWork.` });
      const token = crypto.randomBytes(32).toString('hex');
      let hook;
      try {
        const list = await asaas('GET', '/webhooks', null, { key: newKey, env });
        for (const w of (list.data || [])) if (w.url === url || w.name === 'reWork') { try { await asaas('DELETE', '/webhooks/' + w.id, null, { key: newKey, env }); } catch {} }
        hook = await asaas('POST', '/webhooks', {
          name: 'reWork', url, email: req.consoleAdmin.email && req.consoleAdmin.email.includes('@') ? req.consoleAdmin.email : undefined,
          enabled: true, interrupted: false, apiVersion: 3, authToken: token, sendType: 'SEQUENTIALLY', events: WEBHOOK_EVENTS
        }, { key: newKey, env });
      } catch (e) { return res.status(400).json({ error: 'A chave funciona, mas não deu para cadastrar o webhook: ' + e.message }); }
      next.env = env;
      next.apiKeyEnc = auth.encryptString(newKey);
      next.apiKeyLast4 = newKey.slice(-4);
      next.webhookId = hook.id; next.webhookUrl = url;
      next.webhookTokenEnc = auth.encryptString(token);
    }
    next.updatedAt = nowISO(); next.updatedBy = req.consoleAdmin.name;
    await saveConfig(next);
    audit(req, 'billing_config', { env: next.env, key: newKey ? '…' + next.apiKeyLast4 : 'mantida', founderSlots: next.founderSlots, founderUntil: next.founderUntil || null });
    res.json(consoleView(req));
  });

  // Testa a chave e o webhook salvos.
  app.post('/api/console/billing/test', requireConsole, async (req, res) => {
    if (!enabled()) return res.status(400).json({ error: 'Cole a chave de API primeiro.' });
    const out = { key: false, webhook: null };
    try { await asaas('GET', '/finance/balance'); out.key = true; }
    catch (e) { return res.json({ ...out, error: e.message }); }
    try {
      const w = await asaas('GET', '/webhooks/' + cfg().webhookId);
      out.webhook = { enabled: w.enabled !== false, interrupted: !!w.interrupted, url: w.url };
    } catch (e) { out.webhook = { error: e.message }; }
    res.json(out);
  });

  // Detalhe de cobrança de uma organização (tela da organização no console).
  function consoleOrgBilling(org) {
    if (!org) return null;
    const b = org.billing || null;
    return b ? { ...publicBilling(org), subscriptionId: b.subscriptionId || null, customerId: b.customerId || null, log: (b.log || []).slice(0, 20) } : null;
  }

  return { loadConfig, enabled, consoleOrgBilling, BILLING_GRACE_DAYS, PRICES };
};
module.exports.BILLING_GRACE_DAYS = BILLING_GRACE_DAYS;
module.exports._test = { validCpf, validCnpj, endOfCycle, ymdBr };
