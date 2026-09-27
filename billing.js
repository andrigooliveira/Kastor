/* ───────────────────────────────────────────────────────────────
   reWork — Cobrança dos planos (Asaas)

   Quem configura: o reWork Console (Pagamentos). A chave de API do Asaas
   fica no banco, criptografada (auth.encryptString) — nada de variável de
   ambiente. Ao salvar a chave, o reWork cadastra o próprio webhook no Asaas
   com um token gerado aqui.

   Como o dono assina (página Plano e pagamento → /api/billing/checkout):
     - Cartão: página de pagamento do Asaas (Checkout recorrente). O cartão
       fica salvo lá; o Asaas cria a assinatura e avisa (SUBSCRIPTION_CREATED).
     - Pix Automático: o reWork cria uma autorização (/pix/automatic/
       authorizations, modo SUBSCRIPTION) e mostra o QR Code. O banco exige
       pagar o primeiro ciclo nesse QR; ele cobre o período que começa em
       startDateFor (fim do teste ou do pago) e as próximas cobranças saem
       sozinhas da conta autorizada. Trocar de conta = autorização nova.
     - Pix (fatura) / boleto: o reWork cria a assinatura pela API e mostra a fatura.
   Todo ciclo o Asaas gera a cobrança sozinho e manda por e-mail (e a nota
   fiscal, se ligada no painel do Asaas).

   Forma de pagamento guardada: b.card ({ brand, last4 }, do cartão da
   assinatura) e b.pixAuth ({ id, status }, da autorização do Pix Automático).

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
   console) guardam founder = true e pagam a tabela de fundador pra sempre,
   mesmo que a tabela normal suba depois.

   Planos e preços: catálogo do console › Planos (plans.js). Cada plano pago
   tem prices e, opcional, founderPrices (sem ele, fundador paga o normal).
   Mudar preço não mexe no valor das assinaturas que já existem no Asaas:
   vale pra assinatura nova e troca de plano.

   Enterprise: o dono (ou admin) pede pela página de planos
   (/api/billing/enterprise); vira lead "upsell" no CRM do console.
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CYCLES = { MONTHLY: 1, YEARLY: 12 };
const METHODS = ['CREDIT_CARD', 'PIX_AUTOMATIC', 'PIX', 'BOLETO'];
const METHOD_LABEL = { CREDIT_CARD: 'Cartão de crédito', PIX_AUTOMATIC: 'Pix Automático', PIX: 'Pix', BOLETO: 'Boleto' };
const PIX_FREQUENCY = { MONTHLY: 'MONTHLY', YEARLY: 'ANNUALLY' };
const PIX_QR_SECONDS = 2 * 3600;
const BILLING_GRACE_DAYS = 7;
const KV_KEY = 'billing:config';
const BASE_URLS = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' };
const CHECKOUT_URLS = { sandbox: 'https://sandbox.asaas.com/checkoutSession/show?id=', production: 'https://asaas.com/checkoutSession/show?id=' };
const WEBHOOK_EVENTS = [
  'PAYMENT_CREATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED',
  'PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
  'SUBSCRIPTION_CREATED', 'SUBSCRIPTION_UPDATED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_DELETED'
];
// Só existem em conta com Pix Automático liberado; sem ele, o webhook fica sem estes.
const PIX_AUTO_EVENTS = [
  'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED',
  'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_EXPIRED', 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED',
  'PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_REFUSED'
];
const DAY = 864e5;
// O checkout do Asaas exige uma imagem em cada item (o sandbox deixa passar sem).
let _itemImage;
function itemImage() {
  if (_itemImage === undefined) {
    try { _itemImage = fs.readFileSync(path.join(__dirname, 'public', 'favicon.png')).toString('base64'); }
    catch { _itemImage = null; }
  }
  return _itemImage;
}

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
// `ymd` + `months` meses (31/jan + 1 mês = 28 ou 29/fev), como [ano, mês0, dia].
function addMonthsParts(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const tm = m - 1 + months;
  const ty = y + Math.floor(tm / 12), tmm = ((tm % 12) + 12) % 12;
  return [ty, tmm, Math.min(d, new Date(Date.UTC(ty, tmm + 1, 0)).getUTCDate())];
}
function addMonths(ymd, months) {
  const [y, m, d] = addMonthsParts(ymd, months);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Fim do dia `ymd` + `months` meses, em Brasília.
function endOfCycle(ymd, months) {
  const [y, m, d] = addMonthsParts(ymd, months);
  return new Date(Date.UTC(y, m, d, 23 + 3, 59, 59)).toISOString(); // 23:59:59 -03:00
}

module.exports = function setupBilling(app, deps) {
  const db = new Proxy({}, { get: (_, key) => deps.getDb()[key] });
  const { store, auth, saveEntity, nowISO, requireAuth, plans, orgPlan, orgUsage, appBaseUrl, requireConsole, audit } = deps;
  const planById = (id) => plans.find(p => p.id === id) || null;
  const planName = (id) => (planById(id) || { name: id }).name;
  // Planos à venda (catálogo do console), do mais barato ao mais caro.
  const paidPlans = () => (deps.plansApi ? deps.plansApi.paidPlans() : plans.filter(p => p.kind === 'paid' && !p.archived));
  const isPaid = (p) => !!p && p.kind === 'paid' && !!p.prices;
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
  async function asaas(method, path_, body, opts = {}) {
    const key = opts.key || apiKey();
    if (!key) throw Object.assign(new Error('Cobrança não configurada.'), { status: 503 });
    let res;
    try {
      res = await fetch(baseUrl(opts.env) + path_, {
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
      let msg = data && Array.isArray(data.errors) && data.errors.length ? data.errors.map(e => e.description).join(' ') : `Asaas respondeu ${res.status}.`;
      // Checkout: o endereço de volta precisa ser do site cadastrado na conta do Asaas.
      if (/dom[ií]nio/i.test(msg) && path_.startsWith('/checkouts')) msg += ` Cadastre o site ${opts.site || 'do reWork'} em Minha Conta › Informações, no painel do Asaas.`;
      console.warn(`[billing] Asaas ${method} ${path_.split('?')[0]} → ${res.status}`, JSON.stringify((data && data.errors) || data || null).slice(0, 800));
      // Recusa de dado (4xx) volta como 400 com a mensagem do Asaas; chave
      // recusada e falha do lado deles, 502.
      const status = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 ? 400 : 502;
      throw Object.assign(new Error(msg), { status, asaasStatus: res.status, data });
    }
    return data;
  }

  // Tem assinatura (ou autorização de Pix Automático, que pode ainda não ter o id da assinatura).
  const hasSubscription = (b) => !!(b && (b.subscriptionId || (b.pixAuth && b.pixAuth.id)));

  /* ── Preços (do catálogo de planos) ── */
  const pricesOf = (p, founder) => (founder && p.founderPrices) || p.prices;
  // Preços que o console de Pagamentos guardava antes do catálogo (migração, 1x).
  const legacyPrices = () => ({ prices: cfg().prices || null, founderPrices: cfg().founderPrices || null });
  function founderInfo() {
    const slots = Number.isInteger(cfg().founderSlots) ? cfg().founderSlots : 20;
    const used = (db.organizations || []).filter(o => o.billing && o.billing.founder).length;
    const until = cfg().founderUntil || null;
    const open = used < slots && (!until || ymdBr() <= until);
    return { slots, used, left: Math.max(0, slots - used), until, open };
  }
  // Fundador (já é, ou ainda não assinou e cabe nas vagas) paga a tabela de fundador.
  function founderFor(org) {
    const b = org && org.billing;
    if (b && b.founder) return true;
    return !hasSubscription(b) && founderInfo().open;
  }
  function priceFor(org, planId, cycle) {
    const p = planById(planId);
    return isPaid(p) ? pricesOf(p, founderFor(org))[cycle] : null;
  }
  // Planos à venda + o da assinatura atual (mesmo fora da venda, pra ela ver o dela).
  function catalogFor(org) {
    const founder = founderFor(org);
    const b = org && org.billing;
    const list = paidPlans().slice();
    for (const id of [b && b.planId, b && b.nextPlanId]) {
      const p = id && planById(id);
      if (isPaid(p) && !list.includes(p)) list.push(p);
    }
    return list.map(p => ({ id: p.id, name: p.name, users: p.users, storageGb: p.storageGb, fileMb: p.fileMb, prices: pricesOf(p, founder), standard: p.prices, featured: !!p.featured, archived: !!p.archived }));
  }
  // Pode assinar/mudar para este plano: à venda, ou o próprio plano atual.
  const canPick = (org, id) => { const p = planById(id); const b = org && org.billing; return isPaid(p) && (!p.archived || (b && (b.planId === id || b.nextPlanId === id))); };

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
  // Forma de pagamento que a assinatura usa hoje (a "padrão" da organização).
  function paymentMethodOf(b) {
    if (!b.method || !b.status || b.status === 'none') return null;
    return {
      type: b.method, label: METHOD_LABEL[b.method] || b.method,
      card: b.method === 'CREDIT_CARD' && b.card ? { brand: b.card.brand || null, last4: b.card.last4 || null } : null,
      pixAuto: b.method === 'PIX_AUTOMATIC' && b.pixAuth ? { status: b.pixAuth.status || null, activatedAt: b.pixAuth.activatedAt || null } : null,
      since: b.methodSince || b.startedAt || null
    };
  }
  function publicPending(p) {
    if (!p) return null;
    const qr = p.qr && (!p.qr.expiresAt || Date.parse(p.qr.expiresAt) > Date.now()) ? p.qr : null;
    return {
      planId: p.planId, cycle: p.cycle, method: p.method, url: p.url || null, createdAt: p.createdAt,
      qr: p.method === 'PIX_AUTOMATIC' ? qr : null, coverFrom: p.coverFrom || null, value: p.value || null
    };
  }
  function publicBilling(org) {
    const b = org.billing || {};
    const plan = orgPlan(org);
    return {
      status: b.status || 'none',
      planId: b.planId || null, nextPlanId: b.nextPlanId || null,
      cycle: b.cycle || null, method: b.method || null, value: b.value || null,
      founder: !!b.founder,
      paymentMethod: paymentMethodOf(b),
      customer: b.customerId ? { name: b.name || null, email: b.email || null, doc: b.cpfCnpj ? maskDoc(b.cpfCnpj) : null, phone: b.phone || null, addr: b.addr || null } : null,
      pending: publicPending(b.pending),
      pendingInvoiceUrl: b.pendingInvoiceUrl || null,
      paidUntil: plan.paidUntil || null, graceEndsAt: plan.graceEndsAt || null, overdue: !!plan.overdue, canceled: !!plan.canceled,
      lastPaymentAt: b.lastPaymentAt || null
    };
  }
  function maskDoc(d) { return d.length === 14 ? `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}` : `***.${d.slice(3, 6)}.***-${d.slice(9)}`; }

  // Data em que a assinatura nova começa a cobrar: o dia seguinte ao fim do
  // período já pago, ou o dia em que o teste acaba; sem nada disso, hoje.
  // Cancelada conta também: o que já foi pago vale até o fim, então quem
  // assina de novo nesse meio tempo só volta a pagar quando ele acabar.
  function startDateFor(org) {
    const p = orgPlan(org);
    const now = Date.now();
    const candidates = [];
    if (p.paidUntil && Date.parse(p.paidUntil) > now) candidates.push(Date.parse(p.paidUntil));
    if (p.trial && p.trialEndsAt && Date.parse(p.trialEndsAt) > now) candidates.push(Date.parse(p.trialEndsAt));
    if (!candidates.length) return ymdBr();
    return ymdBr(Math.max(...candidates) + 60e3);
  }

  /* Liga a assinatura criada à organização (Pix/boleto na hora; cartão
     quando o Asaas avisa que a assinatura do checkout foi criada). */
  async function adoptSubscription(org, sub, intent) {
    const b = ensureBilling(org);
    const oldId = b.subscriptionId && b.subscriptionId !== sub.id ? b.subscriptionId : null;
    const oldAuth = b.pixAuth && b.pixAuth.id && b.pixAuth.id !== intent.authorizationId ? b.pixAuth.id : null;
    b.subscriptionId = sub.id;
    b.planId = intent.planId; b.nextPlanId = null;
    b.cycle = intent.cycle;
    if (b.method !== intent.method || intent.method === 'CREDIT_CARD' || intent.method === 'PIX_AUTOMATIC') b.methodSince = nowISO();
    b.method = intent.method;
    b.card = intent.method === 'CREDIT_CARD' ? cardOf(sub) : null;
    b.pixAuth = intent.method === 'PIX_AUTOMATIC'
      ? { id: intent.authorizationId, status: intent.authStatus || 'CREATED', activatedAt: intent.authStatus === 'ACTIVE' ? nowISO() : null, coverFrom: intent.coverFrom || null, firstPaid: false }
      : null;
    b.value = Number(sub.value) || intent.value;
    b.pending = null;
    if (!b.startedAt) b.startedAt = nowISO();
    if (b.founder === undefined || b.founder === null) b.founder = false;
    if (intent.founder) b.founder = true;
    const p = orgPlan(org);
    // Período já pago ainda valendo (inclusive de assinatura cancelada).
    const paidAhead = p.paidUntil && Date.parse(p.paidUntil) > Date.now();
    const inTrial = p.trial && p.trialEndsAt && Date.parse(p.trialEndsAt) > Date.now();
    b.status = paidAhead || inTrial ? 'active' : 'pending';
    // Assinou durante o teste: o plano escolhido vale já, até o fim do teste
    // (a primeira cobrança vence nesse dia).
    if (inTrial) {
      org.plan = { id: intent.planId, paidUntil: p.trialEndsAt, source: 'billing', changedAt: nowISO(), changedBy: 'Assinatura' };
    } else if (paidAhead) {
      // Troca de ciclo/forma, ou assinou de novo antes do fim do pago: o plano
      // atual segue até lá e a cancelada volta a valer (com carência).
      if (p.canceled) { b.canceledAt = null; b.cancelReason = null; }
      org.plan = { ...org.plan, canceled: false };
    }
    logEvent(b, { event: 'subscribed', detail: `${planName(intent.planId)} · ${intent.cycle === 'YEARLY' ? 'anual' : 'mensal'} · ${METHOD_LABEL[intent.method]}` });
    if (oldId) b.replaced = [...(b.replaced || []), oldId].slice(-10);
    saveEntity('organizations', org);
    await dropOld(oldId, oldAuth);
    if (intent.method === 'CREDIT_CARD' && !b.card && sub.id) refreshCard(org);
  }
  // Apaga a assinatura e a autorização de Pix Automático que foram trocadas.
  async function dropOld(subId, authId) {
    if (authId) { try { await asaas('DELETE', '/pix/automatic/authorizations/' + authId); } catch (e) { if (e.asaasStatus !== 404) console.warn('[billing] não cancelou a autorização antiga', authId, e.message); } }
    if (subId) { try { await asaas('DELETE', '/subscriptions/' + subId); } catch (e) { if (e.asaasStatus !== 404) console.warn('[billing] não apagou a assinatura antiga', subId, e.message); } }
  }

  /* Cartão da assinatura (bandeira e final), pra mostrar a forma de pagamento. */
  function cardOf(obj) {
    const c = obj && obj.creditCard;
    if (!c || !(c.creditCardNumber || c.creditCardBrand)) return null;
    return { brand: c.creditCardBrand || null, last4: String(c.creditCardNumber || '').replace(/\D/g, '').slice(-4) || null };
  }
  const _cardFetching = new Set();
  async function refreshCard(org) {
    const b = org.billing;
    if (!b || !b.subscriptionId || b.method !== 'CREDIT_CARD' || _cardFetching.has(org.id)) return;
    _cardFetching.add(org.id);
    try {
      b.cardCheckedAt = nowISO();
      const sub = await asaas('GET', '/subscriptions/' + b.subscriptionId);
      const card = cardOf(sub);
      if (card) b.card = card;
      saveEntity('organizations', org);
    } catch (e) { console.warn('[billing] cartão da assinatura', e.message); }
    finally { _cardFetching.delete(org.id); }
  }

  /* Pagamento confirmado: estende o "pago até" um ciclo a partir do vencimento. */
  // `over` (primeiro Pix do Pix Automático): o pagamento cobre o período que
  // começa em over.from, no plano e ciclo da autorização nova.
  function onPaid(org, p, over) {
    const b = ensureBilling(org);
    if (b.paidPayments.includes(p.id)) return false;
    b.paidPayments.unshift(p.id); if (b.paidPayments.length > 36) b.paidPayments.length = 36;
    const months = CYCLES[over ? over.cycle : b.cycle] || 1;
    const due = String((over && over.from) || p.dueDate || ymdBr()).slice(0, 10);
    const end = endOfCycle(due, months);
    const cur = org.plan && org.plan.source === 'billing' && org.plan.paidUntil ? org.plan.paidUntil : null;
    const paidUntil = cur && Date.parse(cur) > Date.parse(end) ? cur : end;
    const planId = (over && over.planId) || b.nextPlanId || b.planId || (org.plan && org.plan.id);
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
    const authz = ev.authorization || null;
    const instr = ev.paymentInstruction || null;
    const obj = payment || sub || (authz && { ...authz, customer: authz.customerId || authz.customer }) || (instr && instr.authorization && { customer: instr.authorization.customerId || instr.customer }) || {};
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
    // Pix Automático: autorização esperando o primeiro Pix (pending) ou já adotada.
    const pendAuth = b.pending && b.pending.method === 'PIX_AUTOMATIC' ? b.pending : null;
    const isMyAuth = (id) => !!id && ((pendAuth && pendAuth.authorizationId === id) || (b.pixAuth && b.pixAuth.id === id));
    if (e === 'SUBSCRIPTION_CREATED' && sub) {
      await adoptCard(sub.id, sub.value);
    } else if ((e === 'SUBSCRIPTION_DELETED' || e === 'SUBSCRIPTION_INACTIVATED') && sub) {
      if (sub.id === b.subscriptionId && !(b.replaced || []).includes(sub.id)) {
        b.status = 'canceled'; b.canceledAt = b.canceledAt || nowISO();
        if (org.plan && org.plan.source === 'billing') org.plan = { ...org.plan, canceled: true };
        logEvent(b, { event: 'canceled', detail: 'assinatura encerrada no Asaas' });
      }
    } else if ((e === 'PAYMENT_CONFIRMED' || e === 'PAYMENT_RECEIVED') && payment) {
      // Primeiro Pix do QR do Pix Automático: paga o período e liga a autorização.
      // (Se a autorização ativou antes, ela já foi adotada: b.pixAuth sem firstPaid.)
      const waiting = pendAuth ? { authId: pendAuth.authorizationId, subId: pendAuth.subscriptionId, from: pendAuth.coverFrom, cycle: pendAuth.cycle, planId: pendAuth.planId }
        : b.pixAuth && !b.pixAuth.firstPaid && b.pixAuth.coverFrom ? { authId: b.pixAuth.id, subId: b.subscriptionId, from: b.pixAuth.coverFrom, cycle: b.cycle, planId: b.planId } : null;
      const firstPix = waiting && payment.billingType === 'PIX'
        && (payment.pixAutomaticAuthorizationId === waiting.authId || (!payment.pixAutomaticAuthorizationId && (!payment.subscription || payment.subscription === waiting.subId)));
      if (firstPix) {
        onPaid(org, payment, waiting);
        if (pendAuth) await adoptSubscription(org, { id: pendAuth.subscriptionId || null, value: pendAuth.value }, pendAuth);
        b.pixAuth.firstPaid = true;
      } else {
        if (payment.subscription && payment.subscription !== b.subscriptionId) await adoptCard(payment.subscription, payment.value);
        // Assinatura que o Asaas criou pro Pix Automático, se ainda não sabíamos o id.
        if (b.method === 'PIX_AUTOMATIC' && !b.subscriptionId && payment.subscription && payment.billingType === 'PIX' && !(b.replaced || []).includes(payment.subscription)) b.subscriptionId = payment.subscription;
        const mine = !payment.subscription || payment.subscription === b.subscriptionId || (b.pixAuth && payment.pixAutomaticAuthorizationId === b.pixAuth.id);
        if (mine) {
          onPaid(org, payment);
          if (b.method === 'CREDIT_CARD' && cardOf(payment)) b.card = cardOf(payment);
        }
      }
    } else if (authz && e.startsWith('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_') && isMyAuth(authz.id)) {
      const st = e.slice('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_'.length); // ACTIVATED | CANCELLED | EXPIRED | REFUSED
      if (pendAuth && pendAuth.authorizationId === authz.id) {
        if (authz.subscriptionId) pendAuth.subscriptionId = authz.subscriptionId;
        if (st === 'ACTIVATED') {
          // Ativou antes de o primeiro Pix chegar: liga já; o Pix conta quando chegar.
          await adoptSubscription(org, { id: pendAuth.subscriptionId || null, value: pendAuth.value }, { ...pendAuth, authStatus: 'ACTIVE' });
        } else {
          b.pending = null;
          logEvent(b, { event: 'pix_auto_' + st.toLowerCase(), detail: 'autorização do Pix Automático não concluída' });
        }
      } else if (b.pixAuth && b.pixAuth.id === authz.id) {
        b.pixAuth.status = st === 'ACTIVATED' ? 'ACTIVE' : st;
        if (st === 'ACTIVATED') b.pixAuth.activatedAt = nowISO();
        if (authz.subscriptionId && !b.subscriptionId) b.subscriptionId = authz.subscriptionId;
        if (st !== 'ACTIVATED') logEvent(b, { event: 'pix_auto_' + st.toLowerCase(), detail: st === 'CANCELLED' ? 'autorização cancelada (banco ou Asaas)' : 'autorização sem efeito' });
      }
    } else if (e === 'PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_REFUSED' && instr) {
      logEvent(b, { event: 'pix_auto_refused', paymentId: instr.paymentId || null, detail: 'o banco recusou o débito do Pix Automático' });
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
  // Formas oferecidas: Pix Automático só com a conta do Asaas liberada (console).
  const methodsOffered = () => METHODS.filter(m => m !== 'PIX_AUTOMATIC' || cfg().pixAutomatic);
  app.get('/api/billing', requireAuth, (req, res) => {
    const org = req.org;
    const usage = orgUsage(org);
    const b = org.billing;
    // Assinatura no cartão sem bandeira/final guardados: busca no Asaas (no máximo 1x por hora).
    if (enabled() && b && b.method === 'CREDIT_CARD' && b.subscriptionId && !b.card && (!b.cardCheckedAt || Date.now() - Date.parse(b.cardCheckedAt) > 3600e3)) refreshCard(org);
    res.json({
      enabled: enabled(), sandbox: cfg().env === 'sandbox',
      canManage: !!req.user.isOwner,
      plan: usage.plan, seats: usage.seats, storage: usage.storage,
      catalog: catalogFor(org), founder: { ...founderInfo(), mine: !!(org.billing && org.billing.founder) },
      billing: publicBilling(org),
      methods: methodsOffered(),
      startDate: startDateFor(org),
      graceDays: BILLING_GRACE_DAYS,
      defaults: { name: org.name, email: req.user.email || '' },
      enterprise: enterpriseState(org),
      canRequestEnterprise: !!(req.user.isOwner || req.user.isAdmin)
    });
  });

  // Endereço pelo CEP (ViaCEP), pelo servidor: o CSP do app não deixa o navegador sair.
  app.get('/api/billing/cep/:cep', requireAuth, ownerOnly, async (req, res) => {
    const cep = onlyDigits(req.params.cep);
    if (!/^\d{8}$/.test(cep)) return res.status(400).json({ error: 'CEP com 8 números.' });
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) });
      const j = r.ok ? await r.json() : null;
      if (!j || j.erro) return res.status(404).json({ error: 'CEP não encontrado. Confira ou preencha o endereço à mão.' });
      res.json({ postalCode: cep, address: j.logradouro || '', province: j.bairro || '', city: j.localidade || '', state: j.uf || '' });
    } catch { res.status(502).json({ error: 'Não deu para buscar o CEP agora. Preencha o endereço à mão.' }); }
  });

  /* ── Enterprise (upsell) ──
     O dono ou um admin conta o que precisa na página de planos; vira lead
     "upsell" no CRM do console (db.accessRequests, kind 'upsell', com orgId),
     e os superadmins recebem aviso por e-mail. Pedido aberto da mesma
     organização é atualizado em vez de duplicado. */
  const OPEN_STAGES = ['new', 'contacted', 'demo', 'proposal', 'reviewing'];
  const openUpsell = (org) => (db.accessRequests || []).filter(r => r.kind === 'upsell' && r.orgId === org.id && OPEN_STAGES.includes(r.status))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null;
  function enterpriseState(org) {
    const r = openUpsell(org);
    return r ? { requestedAt: r.updatedAt || r.createdAt, people: r.people || null, message: r.message || '' } : null;
  }
  const teamSizeFor = (n) => n <= 5 ? '1-5' : n <= 15 ? '6-15' : n <= 50 ? '16-50' : n <= 200 ? '51-200' : '200+';
  app.post('/api/billing/enterprise', requireAuth, async (req, res) => {
    if (!req.user.isOwner && !req.user.isAdmin) return res.status(403).json({ error: 'Só o dono ou um admin da organização pede o Enterprise.' });
    const org = req.org;
    const bd = req.body || {};
    const message = String(bd.message || '').trim().slice(0, 2000);
    const people = Number(bd.people);
    const phone = String(bd.phone || '').trim().slice(0, 40);
    if (!Number.isInteger(people) || people < 1 || people > 100000) return res.status(400).json({ error: 'Informe quantas pessoas vão usar o reWork.', field: 'people' });
    if (message.length < 20) return res.status(400).json({ error: 'Conte um pouco mais do que vocês precisam (pelo menos 20 caracteres).', field: 'message' });
    if (!Array.isArray(db.accessRequests)) return res.status(503).json({ error: 'Não deu para registrar agora. Tente de novo em instantes.' });
    const at = nowISO();
    const fields = {
      name: req.user.name || req.user.username || '', email: req.user.email || '', company: org.name, country: org.country || 'BR',
      teamSize: teamSizeFor(people), people, phone, role: req.user.isOwner ? 'Dono da organização' : 'Admin da organização',
      message, currentPlan: orgPlan(org).name
    };
    let r = openUpsell(org);
    if (r) {
      Object.assign(r, fields, { updatedAt: at, submissions: (r.submissions || 1) + 1 });
    } else {
      r = { id: crypto.randomBytes(6).toString('hex'), kind: 'upsell', source: 'upsell', orgId: org.id, ...fields, status: 'new', notes: [], createdAt: at, updatedAt: at, submissions: 1 };
      db.accessRequests.push(r);
    }
    saveEntity('accessRequests', r);
    // Aviso pros superadmins (se o e-mail estiver configurado).
    if (deps.mailEnabled && deps.mailEnabled() && deps.emailTpl && deps.emailTpl.accessRequestNew) {
      const baseUrl = appBaseUrl(req);
      const m = deps.emailTpl.accessRequestNew({ request: fields, consoleUrl: `${baseUrl}/console/lista-de-espera?id=${r.id}`, baseUrl, upsell: true });
      setImmediate(() => { for (const a of (db.platformAdmins || [])) if (a.active !== false && a.totpEnabledAt) deps.sendEmail(a.email, m.subject, m.html, m.text, { lang: 'pt' }); });
    }
    res.status(201).json({ enterprise: enterpriseState(org) });
  });

  // Dono viu a escolha de plano dos primeiros passos (assinando ou seguindo no teste).
  app.post('/api/billing/intro-done', requireAuth, ownerOnly, (req, res) => {
    if (!req.org.billingIntroAt) { req.org.billingIntroAt = nowISO(); saveEntity('organizations', req.org); }
    res.json({ ok: true });
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
    if (!canPick(org, planId)) return res.status(400).json({ error: 'Escolha um plano.', field: 'planId' });
    if (!CYCLES[cycle]) return res.status(400).json({ error: 'Escolha mensal ou anual.', field: 'cycle' });
    if (!methodsOffered().includes(method)) return res.status(400).json({ error: method === 'PIX_AUTOMATIC' ? 'O Pix Automático ainda não está disponível. Escolha outra forma de pagamento.' : 'Escolha a forma de pagamento.', field: 'method' });
    const name = String(bd.name || '').trim().slice(0, 120);
    const email = String(bd.email || '').trim().toLowerCase().slice(0, 160);
    // Em branco = mantém o CPF/CNPJ já salvo da organização.
    const doc = onlyDigits(bd.cpfCnpj) || (org.billing && org.billing.cpfCnpj) || '';
    if (name.length < 2) return res.status(400).json({ error: 'Informe o nome ou a razão social para a nota fiscal.', field: 'name' });
    if (!validCpf(doc) && !validCnpj(doc)) return res.status(400).json({ error: 'CPF ou CNPJ inválido. Confira os números.', field: 'cpfCnpj' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido para receber as faturas.', field: 'email' });
    // Telefone e endereço: o checkout do cartão no Asaas recusa cliente sem eles.
    // Em branco = mantém o que já está salvo na organização.
    const saved = (org.billing && org.billing.addr) || {};
    const phone = onlyDigits(bd.phone) || (org.billing && org.billing.phone) || '';
    const addr = bd.postalCode !== undefined ? {
      postalCode: onlyDigits(bd.postalCode).slice(0, 8),
      address: String(bd.address || '').trim().slice(0, 120),
      addressNumber: String(bd.addressNumber || '').trim().slice(0, 20),
      complement: String(bd.complement || '').trim().slice(0, 80),
      province: String(bd.province || '').trim().slice(0, 80),
      city: String(bd.city || '').trim().slice(0, 80),
      state: String(bd.state || '').trim().toUpperCase().slice(0, 2)
    } : saved;
    if (method === 'CREDIT_CARD') {
      if (!/^\d{10,11}$/.test(phone)) return res.status(400).json({ error: 'Informe um telefone com DDD.', field: 'phone' });
      if (!/^\d{8}$/.test(addr.postalCode || '')) return res.status(400).json({ error: 'Informe o CEP do endereço de cobrança.', field: 'postalCode' });
      if (!addr.address) return res.status(400).json({ error: 'Informe a rua do endereço de cobrança.', field: 'address' });
      if (!addr.addressNumber) return res.status(400).json({ error: 'Informe o número do endereço (ou "S/N").', field: 'addressNumber' });
      if (!addr.province) return res.status(400).json({ error: 'Informe o bairro do endereço de cobrança.', field: 'province' });
    }
    const fitErr = checkFits(org, planId);
    const cur = orgPlan(org);
    // Descer de plano com uso acima do limite: bloqueia (subir sempre pode).
    if (fitErr && (planById(planId).users || 0) < (cur.users || Infinity)) return res.status(400).json({ error: fitErr, field: 'planId' });

    const b = ensureBilling(org);
    const founder = !!b.founder || (!hasSubscription(b) && founderInfo().open);
    const value = pricesOf(planById(planId), founder)[cycle];
    const planLabel = planName(planId);
    const description = `reWork ${planLabel} · ${cycle === 'YEARLY' ? 'anual' : 'mensal'} · ${org.name}`.slice(0, 250);
    try {
      // Cliente no Asaas (um por organização).
      const customerBody = { name, cpfCnpj: doc, email, externalReference: org.id, notificationDisabled: false };
      if (phone) { customerBody.phone = phone; if (phone.length === 11) customerBody.mobilePhone = phone; }
      // A cidade o Asaas tira do CEP.
      if (addr.postalCode) Object.assign(customerBody, { postalCode: addr.postalCode, address: addr.address, addressNumber: addr.addressNumber, complement: addr.complement || undefined, province: addr.province });
      if (b.customerId) {
        try { await asaas('PUT', '/customers/' + b.customerId, customerBody); }
        catch (e) { if (e.asaasStatus === 404) b.customerId = null; else throw e; }
      }
      if (!b.customerId) b.customerId = (await asaas('POST', '/customers', customerBody)).id;
      b.name = name; b.email = email; b.cpfCnpj = doc;
      if (phone) b.phone = phone;
      if (addr.postalCode) b.addr = addr;
      const nextDueDate = startDateFor(org);
      const intent = { planId, cycle, method, value, founder, createdAt: nowISO() };
      if (method === 'CREDIT_CARD') {
        const base = appBaseUrl(req);
        const back = `${base}/${org.id}/billing`;
        const item = { name: `reWork ${planLabel}`.slice(0, 30), description: description.slice(0, 150), quantity: 1, value };
        if (itemImage()) item.imageBase64 = itemImage();
        const co = await asaas('POST', '/checkouts', {
          billingTypes: ['CREDIT_CARD'], chargeTypes: ['RECURRENT'], minutesToExpire: 120,
          callback: { successUrl: back + '?pagamento=ok', cancelUrl: back + '?pagamento=cancelado', expiredUrl: back + '?pagamento=expirado' },
          items: [item],
          subscription: { cycle, nextDueDate: `${nextDueDate} 12:00:00` },
          customer: b.customerId,
          externalReference: org.id
        }, { site: base.replace(/^https?:\/\//, '') });
        const url = co.link || (CHECKOUT_URLS[cfg().env] || CHECKOUT_URLS.sandbox) + co.id;
        b.pending = { ...intent, checkoutId: co.id, url };
        logEvent(b, { event: 'checkout', detail: `${planLabel} · cartão` });
        saveEntity('organizations', org);
        return res.json({ url, kind: 'checkout' });
      }
      if (method === 'PIX_AUTOMATIC') {
        // O primeiro Pix (QR) paga o período que começa em nextDueDate; as
        // cobranças automáticas começam um ciclo depois.
        const months = CYCLES[cycle];
        const a = await asaas('POST', '/pix/automatic/authorizations', {
          customerId: b.customerId,
          frequency: PIX_FREQUENCY[cycle],
          contractId: `rw${org.id}${Date.now().toString(36)}`.slice(0, 35),
          startDate: addMonths(nextDueDate, months),
          value,
          description: `reWork ${planLabel}`.slice(0, 35),
          paymentCreationMode: 'SUBSCRIPTION',
          immediateQrCode: { expirationSeconds: PIX_QR_SECONDS, originalValue: value, description: `reWork ${planLabel} · 1º ${cycle === 'YEARLY' ? 'ano' : 'mês'}`.slice(0, 35) }
        });
        const iq = a.immediateQrCode || {};
        const qr = {
          payload: a.payload || iq.payload || null,
          image: a.encodedImage || iq.encodedImage || null,
          expiresAt: iq.expirationDate ? new Date(String(iq.expirationDate).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iq.expirationDate) ? '' : '-03:00')).toISOString() : new Date(Date.now() + PIX_QR_SECONDS * 1000).toISOString()
        };
        if (!qr.payload && !qr.image) throw Object.assign(new Error('O Asaas não devolveu o QR Code do Pix Automático. Tente de novo.'), { status: 502 });
        // Autorização anterior que ainda esperava o primeiro Pix: some.
        const prev = b.pending && b.pending.method === 'PIX_AUTOMATIC' ? b.pending.authorizationId : null;
        b.pending = { ...intent, authorizationId: a.id, subscriptionId: a.subscriptionId || null, coverFrom: nextDueDate, qr };
        logEvent(b, { event: 'checkout', detail: `${planLabel} · Pix Automático` });
        saveEntity('organizations', org);
        if (prev && prev !== a.id) dropOld(null, prev);
        return res.json({ kind: 'pix_auto', qr, coverFrom: nextDueDate, billing: publicBilling(org) });
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
    if (!canPick(org, planId)) return res.status(400).json({ error: 'Escolha um plano.' });
    if (!hasSubscription(b) || b.status === 'canceled') return res.status(400).json({ error: 'A organização não tem assinatura ativa. Assine um plano primeiro.' });
    const current = b.nextPlanId || b.planId;
    if (planId === current) return res.json({ billing: publicBilling(org) });
    // O valor do Pix Automático fica na autorização do banco: plano novo pede autorização nova.
    if (b.method === 'PIX_AUTOMATIC') return res.status(409).json({ error: 'Com Pix Automático, mudar de plano pede uma nova autorização no banco.', code: 'reauthorize' });
    const up = (planById(planId).users || 0) > ((planById(b.planId) || {}).users || 0);
    if (!up) { const err = checkFits(org, planId); if (err) return res.status(400).json({ error: err }); }
    const value = priceFor(org, planId, b.cycle);
    try {
      await asaas('PUT', '/subscriptions/' + b.subscriptionId, {
        value, updatePendingPayments: true,
        description: `reWork ${planName(planId)} · ${b.cycle === 'YEARLY' ? 'anual' : 'mensal'} · ${org.name}`.slice(0, 250)
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
    logEvent(b, { event: 'plan_changed', detail: `${planName(current)} → ${planName(planId)}${up ? '' : ' (na próxima cobrança)'}` });
    saveEntity('organizations', org);
    res.json({ billing: publicBilling(org), plan: orgPlan(org) });
  });

  app.post('/api/billing/cancel', requireAuth, ownerOnly, async (req, res) => {
    const org = req.org;
    const b = ensureBilling(org);
    if (!hasSubscription(b) || b.status === 'canceled') return res.status(400).json({ error: 'Não há assinatura ativa.' });
    try {
      if (b.pixAuth && b.pixAuth.id) await asaas('DELETE', '/pix/automatic/authorizations/' + b.pixAuth.id).catch(e => { if (e.asaasStatus !== 404) throw e; });
      if (b.subscriptionId) await asaas('DELETE', '/subscriptions/' + b.subscriptionId).catch(e => { if (e.asaasStatus !== 404) throw e; });
    } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    if (b.pending && b.pending.method === 'PIX_AUTOMATIC') dropOld(null, b.pending.authorizationId);
    if (b.pixAuth) b.pixAuth.status = 'CANCELLED';
    b.status = 'canceled'; b.canceledAt = nowISO(); b.pending = null; b.nextPlanId = null;
    b.cancelReason = String((req.body || {}).reason || '').slice(0, 500) || null;
    if (org.plan && org.plan.source === 'billing') org.plan = { ...org.plan, canceled: true };
    logEvent(b, { event: 'canceled', detail: 'cancelada pelo dono' });
    saveEntity('organizations', org);
    res.json({ billing: publicBilling(org), plan: orgPlan(org) });
  });

  // Desiste da troca/assinatura em andamento (checkout do cartão ou QR do Pix Automático).
  app.post('/api/billing/pending/discard', requireAuth, ownerOnly, (req, res) => {
    const org = req.org;
    const b = ensureBilling(org);
    if (b.pending) {
      if (b.pending.method === 'PIX_AUTOMATIC' && b.pending.authorizationId) dropOld(null, b.pending.authorizationId);
      b.pending = null;
      if (b.status === 'pending' && !hasSubscription(b)) b.status = 'none';
      saveEntity('organizations', org);
    }
    res.json({ billing: publicBilling(org) });
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
  const webhookEvents = (c) => (c && c.pixAutomatic ? [...WEBHOOK_EVENTS, ...PIX_AUTO_EVENTS] : WEBHOOK_EVENTS);
  function consoleView(req) {
    const orgs = (db.organizations || []).filter(o => !o.deletedAt);
    const subs = orgs.filter(o => hasSubscription(o.billing) && o.billing.status !== 'canceled');
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
      pixAutomatic: !!cfg().pixAutomatic,
      plans: plans.filter(isPaid).map(p => ({ id: p.id, name: p.name, archived: !!p.archived })),
      stats: {
        mrr: Math.round(mrr * 100) / 100, subscribers: subs.length, byPlan,
        pastDue: orgs.filter(o => o.billing && o.billing.status === 'past_due').map(row),
        pending: orgs.filter(o => o.billing && o.billing.status === 'pending').map(row),
        trialsEnding: orgs.filter(o => { const p = orgPlan(o); return p.trial && p.trialEndsAt && Date.parse(p.trialEndsAt) > now && Date.parse(p.trialEndsAt) < now + 7 * DAY && !hasSubscription(o.billing); }).map(row),
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
    const pixChanged = typeof bd.pixAutomatic === 'boolean' && bd.pixAutomatic !== !!cfg().pixAutomatic;
    if (typeof bd.pixAutomatic === 'boolean') next.pixAutomatic = bd.pixAutomatic;
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
          enabled: true, interrupted: false, apiVersion: 3, authToken: token, sendType: 'SEQUENTIALLY', events: webhookEvents(next)
        }, { key: newKey, env });
      } catch (e) { return res.status(400).json({ error: 'A chave funciona, mas não deu para cadastrar o webhook: ' + e.message }); }
      next.env = env;
      next.apiKeyEnc = auth.encryptString(newKey);
      next.apiKeyLast4 = newKey.slice(-4);
      next.webhookId = hook.id; next.webhookUrl = url;
      next.webhookTokenEnc = auth.encryptString(token);
    } else if (pixChanged && enabled() && cfg().webhookId) {
      // Liga/desliga os avisos do Pix Automático no webhook já cadastrado.
      try { await asaas('PUT', '/webhooks/' + cfg().webhookId, { events: webhookEvents(next) }); }
      catch (e) { return res.status(400).json({ error: 'Não deu para atualizar os avisos do webhook no Asaas: ' + e.message, field: 'pixAutomatic' }); }
    }
    next.updatedAt = nowISO(); next.updatedBy = req.consoleAdmin.name;
    await saveConfig(next);
    audit(req, 'billing_config', { env: next.env, key: newKey ? '…' + next.apiKeyLast4 : 'mantida', founderSlots: next.founderSlots, founderUntil: next.founderUntil || null, pixAutomatic: !!next.pixAutomatic });
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
    // Checkout do cartão só volta pro reWork se o site cadastrado no Asaas for o mesmo domínio.
    try {
      const ci = await asaas('GET', '/myAccount/commercialInfo/');
      const host = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
      const expected = host(appBaseUrl(req));
      const registered = host(ci && ci.site);
      out.site = { registered: registered || null, expected, ok: !!registered && (registered === expected || expected.endsWith('.' + registered)) };
    } catch (e) { out.site = { error: e.message }; }
    res.json(out);
  });

  // Detalhe de cobrança de uma organização (tela da organização no console).
  function consoleOrgBilling(org) {
    if (!org) return null;
    const b = org.billing || null;
    return b ? { ...publicBilling(org), subscriptionId: b.subscriptionId || null, customerId: b.customerId || null, log: (b.log || []).slice(0, 20) } : null;
  }

  return { loadConfig, enabled, consoleOrgBilling, BILLING_GRACE_DAYS, legacyPrices };
};
module.exports.BILLING_GRACE_DAYS = BILLING_GRACE_DAYS;
module.exports._test = { validCpf, validCnpj, endOfCycle, addMonths, ymdBr };
