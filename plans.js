/* ───────────────────────────────────────────────────────────────
   reWork — Catálogo de planos (editável no reWork Console › Planos)

   Um plano é { id, name, kind, users, storageGb, fileMb, ... }:
     - kind 'trial'  → o Teste (um só, fixo): limites + trialDays (duração);
     - kind 'paid'   → planos à venda: limites + prices { MONTHLY, YEARLY }
                       + founderPrices opcional (null = igual ao normal),
                       featured ("Mais escolhido"), archived (fora da venda);
     - kind 'custom' → o Personalizado (fixo): limites definidos por
                       organização no console (caminho do Enterprise).

   Fica no KV (plans:catalog). Sem nada salvo, nasce de DEFAULT_PLANS (com os
   preços que o console de Pagamentos tinha guardado, se houver). A lista é
   um array só, mutado no lugar: server, console e cobrança recebem a mesma
   referência e sempre veem o catálogo atual.

   Mudar limites vale na hora para quem está no plano. Mudar preço não mexe
   nas assinaturas que já existem no Asaas (vale para assinatura nova e troca
   de plano). Plano em uso não é apagado: dá para tirar da venda (archived).
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');

const KV_KEY = 'plans:catalog';
const DEFAULT_TRIAL_DAYS = 30;
const DEFAULT_PLANS = [
  { id: 'teste', name: 'Teste', kind: 'trial', trial: true, users: 5, storageGb: 2, fileMb: 25, trialDays: DEFAULT_TRIAL_DAYS },
  { id: 'essencial', name: 'Essencial', kind: 'paid', users: 5, storageGb: 5, fileMb: 25, prices: { MONTHLY: 79, YEARLY: 790 }, founderPrices: null, featured: false, archived: false },
  { id: 'equipe', name: 'Profissional', kind: 'paid', users: 15, storageGb: 15, fileMb: 50, prices: { MONTHLY: 179, YEARLY: 1790 }, founderPrices: null, featured: true, archived: false },
  { id: 'agencia', name: 'Agência', kind: 'paid', users: 30, storageGb: 30, fileMb: 100, prices: { MONTHLY: 299, YEARLY: 2990 }, founderPrices: null, featured: false, archived: false },
  { id: 'custom', name: 'Personalizado', kind: 'custom', users: null, storageGb: null, fileMb: null }
];
const clone = (x) => JSON.parse(JSON.stringify(x));

function createPlans({ store, uploadMaxMb }) {
  const list = clone(DEFAULT_PLANS);
  const byId = (id) => list.find(p => p.id === id) || null;
  const trialPlan = () => list.find(p => p.kind === 'trial') || null;
  const trialDays = () => { const t = trialPlan(); return t && t.trialDays > 0 ? t.trialDays : DEFAULT_TRIAL_DAYS; };
  // À venda, do mais barato ao mais caro.
  const paidPlans = (withArchived) => list.filter(p => p.kind === 'paid' && (withArchived || !p.archived))
    .sort((a, b) => (a.prices.MONTHLY - b.prices.MONTHLY) || a.name.localeCompare(b.name, 'pt-BR'));

  function replace(next) {
    list.length = 0;
    for (const p of next) list.push(normalize(p));
  }
  // Garante os fixos (Teste e Personalizado) e os campos de cada tipo.
  function normalize(p) {
    const out = { ...p };
    if (out.kind === 'trial') { out.trial = true; out.trialDays = out.trialDays > 0 ? out.trialDays : DEFAULT_TRIAL_DAYS; }
    if (out.kind === 'paid') { out.founderPrices = out.founderPrices || null; out.featured = !!out.featured; out.archived = !!out.archived; }
    return out;
  }

  /* Boot: lê o catálogo; na primeira vez, monta dos padrões com os preços que
     o console de Pagamentos tinha salvo (config.prices / founderPrices). */
  async function load(legacy) {
    let saved = null;
    try { const raw = await store.getKv(KV_KEY); saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
    if (Array.isArray(saved) && saved.length) {
      const next = saved.slice();
      for (const fixed of DEFAULT_PLANS.filter(d => d.kind !== 'paid')) if (!next.some(p => p.id === fixed.id)) next.unshift(clone(fixed));
      replace(next);
      return;
    }
    const next = clone(DEFAULT_PLANS);
    const lp = legacy && legacy.prices, lf = legacy && legacy.founderPrices;
    for (const p of next.filter(x => x.kind === 'paid')) {
      if (lp && lp[p.id]) p.prices = { ...p.prices, ...lp[p.id] };
      if (lf && lf[p.id]) {
        const f = { ...p.prices, ...lf[p.id] };
        p.founderPrices = f.MONTHLY === p.prices.MONTHLY && f.YEARLY === p.prices.YEARLY ? null : f;
      }
    }
    replace(next);
  }
  const save = () => store.setKv(KV_KEY, JSON.stringify(list));

  /* ── Validação do que vem do console ── */
  const money = (v) => Math.round(Number(v) * 100) / 100;
  function checkPrices(input, label, field) {
    if (!input || typeof input !== 'object') return { error: `Informe os preços (${label}).`, field };
    const m = money(input.MONTHLY), y = money(input.YEARLY);
    if (!(m >= 5 && m <= 100000)) return { error: `Mensal (${label}): entre R$ 5 e R$ 100.000.`, field: field + '.MONTHLY' };
    if (!(y >= 5 && y <= 1200000)) return { error: `Anual (${label}): entre R$ 5 e R$ 1.200.000.`, field: field + '.YEARLY' };
    if (y > m * 12) return { error: `Anual (${label}) não pode custar mais que 12 mensalidades (${(m * 12).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`, field: field + '.YEARLY' };
    return { value: { MONTHLY: m, YEARLY: y } };
  }
  function checkLimits(b, out) {
    const users = Number(b.users), storageGb = Math.round(Number(b.storageGb) * 100) / 100, fileMb = Number(b.fileMb);
    if (!Number.isInteger(users) || users < 1 || users > 100000) return { error: 'Pessoas: número inteiro entre 1 e 100.000.', field: 'users' };
    if (!(storageGb >= 0.1 && storageGb <= 100000)) return { error: 'Armazenamento: entre 0,1 e 100.000 GB.', field: 'storageGb' };
    if (!Number.isInteger(fileMb) || fileMb < 1 || fileMb > uploadMaxMb) return { error: `Tamanho por arquivo: número inteiro entre 1 e ${uploadMaxMb} MB (o máximo do servidor).`, field: 'fileMb' };
    Object.assign(out, { users, storageGb, fileMb });
    return null;
  }
  function checkName(name, self) {
    const n = String(name || '').trim().slice(0, 40);
    if (n.length < 2) return { error: 'Dê um nome ao plano.', field: 'name' };
    if (list.some(p => p !== self && p.name.toLowerCase() === n.toLowerCase())) return { error: 'Já existe um plano com esse nome.', field: 'name' };
    return { value: n };
  }
  /* Aplica o formulário do console num plano (novo ou existente). Devolve
     { plan } ou { error, field }; não grava. */
  function apply(current, b) {
    b = b || {};
    const kind = current ? current.kind : 'paid';
    const next = current ? { ...current } : { id: null, kind: 'paid', founderPrices: null, featured: false, archived: false };
    if (b.name !== undefined || !current) { const n = checkName(b.name, current); if (n.error) return n; next.name = n.value; }
    if (kind === 'custom') return { plan: next }; // Personalizado: só o nome; limites são por organização.
    if (!current || ['users', 'storageGb', 'fileMb'].some(k => b[k] !== undefined)) {
      const e = checkLimits({ users: b.users ?? next.users, storageGb: b.storageGb ?? next.storageGb, fileMb: b.fileMb ?? next.fileMb }, next);
      if (e) return e;
    }
    if (kind === 'trial') {
      if (b.trialDays !== undefined) {
        const d = Number(b.trialDays);
        if (!Number.isInteger(d) || d < 1 || d > 365) return { error: 'Duração do teste: número inteiro de dias entre 1 e 365.', field: 'trialDays' };
        next.trialDays = d;
      }
      return { plan: next };
    }
    if (b.prices !== undefined || !current) { const r = checkPrices(b.prices, 'preço normal', 'prices'); if (r.error) return r; next.prices = r.value; }
    if (b.founderPrices !== undefined) {
      if (b.founderPrices === null) next.founderPrices = null;
      else { const r = checkPrices(b.founderPrices, 'fundador', 'founderPrices'); if (r.error) return r; next.founderPrices = r.value; }
    }
    if (typeof b.featured === 'boolean') next.featured = b.featured;
    if (typeof b.archived === 'boolean') next.archived = b.archived;
    return { plan: next };
  }
  function newId(name) {
    const base = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'plano';
    let id = base;
    while (byId(id)) id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    return id;
  }
  function upsert(plan) {
    if (!plan.id) plan.id = newId(plan.name);
    const i = list.findIndex(p => p.id === plan.id);
    if (i >= 0) list[i] = normalize(plan); else list.push(normalize(plan));
    // "Mais escolhido": no máximo um.
    if (plan.featured) for (const p of list) if (p.id !== plan.id && p.kind === 'paid') p.featured = false;
    return byId(plan.id);
  }
  function remove(id) {
    const i = list.findIndex(p => p.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  return { list, byId, trialPlan, trialDays, paidPlans, load, save, apply, upsert, remove, uploadMaxMb, DEFAULT_PLANS };
}

/* Rotas do console (área Pagamentos: ver para listar, editar para mudar). */
function setupPlanRoutes(app, { plans, requireConsole, audit, getDb, saveEntity }) {
  const db = new Proxy({}, { get: (_, key) => getDb()[key] });
  // Quem usa o plano: organizações nele (org.plan) e assinaturas que apontam pra ele.
  function usage(id) {
    const orgs = (db.organizations || []).filter(o => !o.deletedAt);
    const onPlan = orgs.filter(o => o.plan && o.plan.id === id).length;
    const subs = orgs.filter(o => { const b = o.billing; return b && b.status !== 'canceled' && (b.planId === id || b.nextPlanId === id || (b.pending && b.pending.planId === id)); }).length;
    return { orgs: onPlan, subscriptions: subs, inUse: onPlan + subs > 0 };
  }
  const view = (p) => ({ ...p, usage: usage(p.id) });
  const summary = (p) => p.kind === 'paid'
    ? `${p.name}: ${p.users} pessoas, ${p.storageGb} GB, ${p.fileMb} MB/arquivo, R$ ${p.prices.MONTHLY}/mês, R$ ${p.prices.YEARLY}/ano${p.founderPrices ? ` (fundador R$ ${p.founderPrices.MONTHLY}/R$ ${p.founderPrices.YEARLY})` : ''}${p.archived ? ', fora da venda' : ''}`
    : p.kind === 'trial' ? `${p.name}: ${p.trialDays} dias, ${p.users} pessoas, ${p.storageGb} GB, ${p.fileMb} MB/arquivo` : p.name;

  app.get('/api/console/plans', requireConsole, (req, res) => {
    const order = { trial: 0, paid: 1, custom: 2 };
    const items = plans.list.slice().sort((a, b) => (order[a.kind] - order[b.kind]) || ((a.prices ? a.prices.MONTHLY : 0) - (b.prices ? b.prices.MONTHLY : 0)));
    res.json({ items: items.map(view), uploadMaxMb: plans.uploadMaxMb });
  });
  app.post('/api/console/plans', requireConsole, async (req, res) => {
    const r = plans.apply(null, req.body);
    if (r.error) return res.status(400).json(r);
    const p = plans.upsert(r.plan);
    await plans.save();
    audit(req, 'plan_created', { planId: p.id, summary: summary(p) });
    res.status(201).json(view(p));
  });
  app.put('/api/console/plans/:id', requireConsole, async (req, res) => {
    const cur = plans.byId(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Plano não encontrado.' });
    const before = summary(cur);
    const r = plans.apply(cur, req.body);
    if (r.error) return res.status(400).json(r);
    // Tirar da venda o último plano à venda deixaria a página de planos vazia.
    if (r.plan.archived && !cur.archived && plans.paidPlans().length <= 1) return res.status(400).json({ error: 'É preciso manter pelo menos um plano à venda.' });
    const p = plans.upsert(r.plan);
    await plans.save();
    audit(req, 'plan_updated', { planId: p.id, from: before, to: summary(p) });
    res.json(view(p));
  });
  app.delete('/api/console/plans/:id', requireConsole, async (req, res) => {
    const cur = plans.byId(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Plano não encontrado.' });
    if (cur.kind !== 'paid') return res.status(400).json({ error: `O plano ${cur.name} é fixo e não pode ser apagado.` });
    const u = usage(cur.id);
    if (u.inUse) return res.status(409).json({ error: `${cur.name} está em uso (${u.orgs} ${u.orgs === 1 ? 'organização' : 'organizações'}, ${u.subscriptions} ${u.subscriptions === 1 ? 'assinatura' : 'assinaturas'}). Tire da venda em vez de apagar: quem já usa continua, e ninguém novo assina.`, code: 'in_use' });
    if (!cur.archived && plans.paidPlans().length <= 1) return res.status(400).json({ error: 'É preciso manter pelo menos um plano à venda.' });
    plans.remove(cur.id);
    await plans.save();
    audit(req, 'plan_deleted', { planId: cur.id, summary: summary(cur) });
    res.json({ ok: true });
  });
}

module.exports = { createPlans, setupPlanRoutes, DEFAULT_PLANS, DEFAULT_TRIAL_DAYS };
