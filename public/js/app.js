/* ───────────────────────────────────────────────────────────────
   KASTOR — Frontend (v3)
   Workspaces · horas · comentários com @ · etapas arrastáveis
   ─────────────────────────────────────────────────────────────── */

/* ─── ESTADO ─── */
// O token de sessão vive em um cookie httpOnly setado pelo server (kastor_session).
// O JS não tem acesso a ele — proteção contra XSS. O frontend só sabe SE está
// autenticado quando /api/me responde 200.
let me         = null;
let users      = [];
let workspaces = [];
let clients    = [];
let projects   = [];
let flows      = [];
let demands    = [];
let notifications = [];
let roles      = [];
let templates  = [];
let webhooks   = [];
let schedules  = [];
let clientTemplates = [];
let recurrings = [];
let listas = [];
let notifPollTimer = null;

let activeWs   = localStorage.getItem('fluxo_ws') || null;

let currentPage = 'dashboard';
let editingId = null;        // demanda em edição
let detailId  = null;        // demanda no modal de detalhe
let editingProjectId = null;
let editingFlowId = null;
let editingUserId = null;
let editingWsId = null;
let editingRoleId = null;
let duplicatingFlowId = null;
let projSortKey = 'name', projSortDir = 1;
let flowSortKey = 'name', flowSortDir = 1;
let userSortKey = 'name', userSortDir = 1;
let wsSortKey = 'name', wsSortDir = 1;
let roleSortKey = 'name', roleSortDir = 1;
let tplSortKey = 'name', tplSortDir = 1;
let showArchivedProjects = false;
let showArchivedUsers = false;
let projAvatarData = null;
let demandAttachments = [];
let detailView = 'main'; // 'main' | 'history' | 'stages'
// Draft da sub-view de edição de etapas: { skipped: Set<stageId>, responsibles: {stageId: userId|null} }
let stagesEditDraft = null;
let dashUserInit = false;    // dashboard já veio filtrado pro usuário ativo?
let listView = 'table';
let sortKey = 'deadline';
let sortAsc = true;
const calState = { all: new Date(), mine: new Date() };
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

/* ─── ROUTING — cada tela e modal tem URL própria em inglês ───
   Páginas (raiz):
     /dashboard, /demands, /my-demands, /capacity, /templates,
     /projects, /flows, /workspaces, /users, /integrations, /profile
   Modais (subrota):
     /demands/new, /demands/<id>, /demands/<id>/edit
     /projects/new, /projects/<id>
     /flows/new, /flows/<id>
     /users/new, /users/<id>
     /integrations/webhooks/new, /integrations/webhooks/<id>

   Convenção: ações do usuário (goPage, openX, closeModal) escrevem na URL via
   pushState/replaceState; o popstate handler reaplica a rota silenciosamente
   (sem reescrever a URL) pra evitar loops. */
const PAGE_TO_PATH = {
  dashboard:    '/dashboard',
  list:         '/demands',
  mine:         '/my-demands',
  capacity:     '/capacity',
  agenda:       '/agenda',
  templates:    '/templates',
  recurring:    '/recurring',
  clients:      '/clients',
  projects:     '/projects',
  flows:        '/flows',
  workspaces:   '/workspaces',
  users:        '/users',
  integrations: '/integrations',
  profile:      '/profile',
  docs:         '/docs',
  clientsModels: '/clients/models'
};
const PATH_TO_PAGE = Object.fromEntries(Object.entries(PAGE_TO_PATH).map(([k, v]) => [v, k]));
let _routerSilent = false;   // true durante popstate → suprime push/replace
function pageUrlFor(page)  {
  // Recurring tem 2 sub-rotas (demands/lists) — resolve pela aba persistida em localStorage.
  // Evita ler _recTab direto pra não bater no TDZ do `let` durante boot.
  if (page === 'recurring') {
    let tab = 'demandas';
    try { tab = localStorage.getItem('kastor-rec-tab') || 'demandas'; } catch {}
    return tab === 'listas' ? '/recurring/lists' : '/recurring/demands';
  }
  return PAGE_TO_PATH[page] || '/dashboard';
}
function currentPageUrl()  { return pageUrlFor(currentPage); }
function navPush(path) {
  if (_routerSilent) return;
  const target = path + location.search;
  if (location.pathname + location.search === target) return;
  history.pushState(null, '', target);
}
function navReplace(path) {
  if (_routerSilent) return;
  const target = path + location.search;
  if (location.pathname + location.search === target) return;
  history.replaceState(null, '', target);
}
function parseRoute(path) {
  const p = (path || '/').replace(/\/+$/, '') || '/';
  // /recurring bare (sem sub-rota) → sinaliza tab pra applyRoute redirecionar
  // pra URL canônica (/recurring/demands ou /recurring/lists) via setRecurringTab.
  if (p === '/recurring') {
    let tab = 'demandas';
    try { tab = localStorage.getItem('kastor-rec-tab') || 'demandas'; } catch {}
    return { page: 'recurring', tab };
  }
  if (PATH_TO_PAGE[p]) return { page: PATH_TO_PAGE[p] };
  let m;
  if ((m = p.match(/^\/demands\/new$/)))                    return { page: 'list',         modal: 'demand',  op: 'new' };
  if ((m = p.match(/^\/demands\/([^/]+)\/edit$/)))          return { page: 'list',         modal: 'demand',  op: 'edit', id: m[1] };
  if ((m = p.match(/^\/demands\/([^/]+)$/)))                return { page: 'list',         modal: 'detail',  id: m[1] };
  if ((m = p.match(/^\/clients\/new$/)))                    return { page: 'clients',      modal: 'client',  op: 'new' };
  if ((m = p.match(/^\/clients\/([^/]+)\/edit$/)))          return { page: 'clients',      modal: 'client',  op: 'edit', id: m[1] };
  if ((m = p.match(/^\/clients\/([^/]+)\/report$/)))        return { page: 'clients',      view: 'report', id: m[1] };
  if ((m = p.match(/^\/clients\/([^/]+)$/)))                return { page: 'clients',      view: 'detail', id: m[1] };
  if ((m = p.match(/^\/projects\/new$/)))                   return { page: 'projects',     modal: 'project', op: 'new' };
  if ((m = p.match(/^\/projects\/([^/]+)\/edit$/)))         return { page: 'clients',      modal: 'project', op: 'edit', id: m[1] };
  if ((m = p.match(/^\/projects\/([^/]+)\/report$/)))       return { page: 'clients',      view: 'project-report', id: m[1] };
  if ((m = p.match(/^\/projects\/([^/]+)$/)))               return { page: 'clients',      view: 'project-detail', id: m[1] };
  if ((m = p.match(/^\/flows\/new$/)))                      return { page: 'flows',        modal: 'flow',    op: 'new' };
  if ((m = p.match(/^\/flows\/([^/]+)$/)))                  return { page: 'flows',        modal: 'flow',    op: 'edit', id: m[1] };
  if ((m = p.match(/^\/users\/new$/)))                      return { page: 'users',        modal: 'user',    op: 'new' };
  if ((m = p.match(/^\/users\/([^/]+)$/)))                  return { page: 'users',        modal: 'user',    op: 'edit', id: m[1] };
  if ((m = p.match(/^\/integrations\/webhooks\/new$/)))     return { page: 'integrations', modal: 'webhook', op: 'new' };
  if ((m = p.match(/^\/integrations\/webhooks\/([^/]+)$/))) return { page: 'integrations', modal: 'webhook', op: 'edit', id: m[1] };
  // Tabs específicas — precedem o modal edit pra não bater com o regex genérico.
  if ((m = p.match(/^\/recurring\/demands$/)))              return { page: 'recurring',    tab: 'demandas' };
  if ((m = p.match(/^\/recurring\/lists$/)))                return { page: 'recurring',    tab: 'listas' };
  if ((m = p.match(/^\/recurring\/new$/)))                  return { page: 'recurring',    modal: 'recurring', op: 'new' };
  if ((m = p.match(/^\/recurring\/([^/]+)$/)))              return { page: 'recurring',    modal: 'recurring', op: 'edit', id: m[1] };
  return { page: 'dashboard' };
}
function applyRoute() {
  const r = parseRoute(location.pathname);
  // Todas as telas são navegáveis. Telas administrativas viram readonly pra
  // usuários comuns via .admin-only no DOM (toggle por body.user-readonly).
  _routerSilent = true;
  try {
    // 1) Página — se já estamos nela (boot inicial), força renderCurrent
    //    pra preencher os skeletons. Sem isso, dashboard fica em loading
    //    eterno até o usuário navegar e voltar.
    if (currentPage !== r.page) goPage(r.page);
    else renderCurrent();
    // 2) Fecha qualquer modal roteado aberto (modais transitórios como
    //    confirm/prompt/picker/cmdk ficam intactos).
    const ROUTED = ['detail-modal','demand-modal','project-modal','flow-modal','user-modal','webhook-modal','recurring-modal'];
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      if (ROUTED.includes(m.id)) m.classList.remove('open');
    });
    // 3) Abre o modal solicitado pela rota
    if (r.modal === 'detail' && r.id) {
      const d = demandById(r.id);
      if (d) {
        if (d.workspaceId && d.workspaceId !== activeWs) switchWorkspace(d.workspaceId);
        showDetail(r.id);
      }
    } else if (r.modal === 'demand' && r.op === 'new') {
      if (typeof openNewDemand === 'function') openNewDemand();
    } else if (r.modal === 'demand' && r.op === 'edit' && r.id) {
      detailId = r.id;
      if (typeof editCurrentDemand === 'function') editCurrentDemand();
    } else if (r.modal === 'client') {
      if (typeof openClientModal === 'function') openClientModal(r.op === 'edit' ? r.id : null);
    } else if (r.view === 'detail' && r.page === 'clients' && r.id) {
      if (typeof openClient === 'function') openClient(r.id);
    } else if (r.view === 'project-detail' && r.page === 'clients' && r.id) {
      if (typeof openProjectDetail === 'function') openProjectDetail(r.id);
    } else if (r.view === 'report' && r.page === 'clients' && r.id) {
      currentClientId = r.id;
      if (typeof openClientReport === 'function') openClientReport();
    } else if (r.view === 'project-report' && r.page === 'clients' && r.id) {
      currentProjectId = r.id;
      const p = projectById(r.id);
      if (p) currentClientId = p.clientId || null;
      if (typeof openProjectReport === 'function') openProjectReport();
    } else if (r.modal === 'project') {
      if (typeof openProjectModal === 'function') openProjectModal(r.op === 'edit' ? r.id : null);
    } else if (r.modal === 'flow' && me?.isAdmin) {
      if (typeof openFlowModal === 'function') openFlowModal(r.op === 'edit' ? r.id : null);
    } else if (r.modal === 'user' && me?.isAdmin) {
      if (typeof openUserModal === 'function') openUserModal(r.op === 'edit' ? r.id : null);
    } else if (r.modal === 'webhook' && me?.isAdmin) {
      if (typeof openWebhookModal === 'function') openWebhookModal(r.op === 'edit' ? r.id : null);
    } else if (r.modal === 'recurring') {
      if (typeof openRecurringModal === 'function') openRecurringModal(r.op === 'edit' ? r.id : null);
    }
    // 4) Aplica tab da rota (aba Demandas/Listas do painel recurring)
    if (r.page === 'recurring' && r.tab && typeof setRecurringTab === 'function') {
      setRecurringTab(r.tab);
    }
  } finally {
    _routerSilent = false;
  }
}
window.addEventListener('popstate', applyRoute);

/* ─── PERSISTÊNCIA DE FILTROS POR TELA ───
   Cada tela com filtros salva um snapshot do estado em localStorage. Restaura
   no início do render correspondente — antes de capturar os valores atuais.
   Evita que o usuário tenha que re-aplicar filtros toda vez que volta. */
const FILTER_KEYS = {
  list:      { storage: 'kastor-filters-list',      ids: ['search-input','filter-user','filter-project','filter-client','filter-period','filter-period-start','filter-period-end','filter-quick'] },
  dashboard: { storage: 'kastor-filters-dashboard', ids: ['dash-f-user','dash-f-client','dash-f-period','dash-f-type'] },
  capacity:  { storage: 'kastor-filters-capacity',  ids: ['capacity-period'] },
  clients:   { storage: 'kastor-filters-clients',   ids: ['client-search','client-f-ws'] }
};
// Restore só roda na PRIMEIRA pintura após entrar na página. Renders subsequentes
// (provocados por onchange de filtro) NÃO restauram — senão a tecla que o usuário
// acabou de mexer seria sobrescrita pelo valor salvo do localStorage.
const _filtersRestored = {};
function _markFiltersDirty(page) { _filtersRestored[page] = false; }
function saveFilters(page) {
  const def = FILTER_KEYS[page]; if (!def) return;
  const snap = {};
  def.ids.forEach(id => { const el = document.getElementById(id); if (el) snap[id] = el.value; });
  try { localStorage.setItem(def.storage, JSON.stringify(snap)); } catch {}
}
function restoreFilters(page) {
  const def = FILTER_KEYS[page]; if (!def) return;
  if (_filtersRestored[page]) return;
  _filtersRestored[page] = true;
  try {
    const raw = localStorage.getItem(def.storage);
    if (!raw) return;
    const snap = JSON.parse(raw);
    def.ids.forEach(id => {
      const el = document.getElementById(id);
      // Pra <select>, .value só "cola" se o option existir. Como renderList rebuilda
      // os <option> a partir do .value atual (prevUser etc.), restaurar antes do
      // rebuild + então deixar o rebuild adicionar selected=true funciona.
      if (el && snap[id] != null) el.value = snap[id];
    });
  } catch {}
}

/* ─── API ─── */
async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin', // envia o cookie httpOnly de sessão
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (netErr) {
    // Sem conexão (offline, DNS, servidor caiu). Erro tipado pra o global handler.
    const e = new Error('Sem conexão com o servidor. Tenta de novo em instantes.');
    e._apiKind = 'network';
    throw e;
  }
  if (res.status === 401) { forceLogout(); const e = new Error('Não autenticado'); e._apiSilent = true; throw e; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    const e = new Error(`Muitas tentativas. Aguarde ${retry || 'alguns'} segundos.`);
    e._apiKind = 'ratelimit';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(data.error || `Erro ${res.status}`);
    e._apiKind = 'server';
    throw e;
  }
  return data;
}

/* Global fallback: se um Promise de api() rejeita SEM ninguém tratar, mostra
   toast pra o usuário não ficar com botão "carregando…" pra sempre e sem feedback.
   Callers que fazem `.catch(...)` explícito NÃO caem aqui — o padrão está preservado. */
window.addEventListener('unhandledrejection', ev => {
  const err = ev.reason;
  if (!err || err._apiSilent) return;
  if (typeof toast === 'function' && (err._apiKind || (err.message && err.message !== 'Não autenticado'))) {
    toast(err.message || 'Erro inesperado', 'error');
    ev.preventDefault(); // silencia o warning "Uncaught (in promise)"
  }
});

/* ─── HELPERS ─── */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/* ─── Prioridade ─── */
const PRIORITIES = [
  { value: 1, label: 'Imediato', color: '#EF4444' }, // vermelho
  { value: 2, label: 'Alta',     color: '#FB7415' }, // laranja
  { value: 3, label: 'Média',    color: '#FACC15' }, // amarelo
  { value: 4, label: 'Baixa',    color: '#60A5FA' }, // azul claro
];
function priorityLabel(v) { return (PRIORITIES.find(p => p.value === v) || PRIORITIES[2]).label; }
function priorityColor(v) { return (PRIORITIES.find(p => p.value === v) || PRIORITIES[2]).color; }
/* Célula compacta dos entregáveis pra tabelas: "P · A · V" com tooltip.
   Se TODOS forem zero, mostra "—". */
function qtyCell(d) {
  const p = Number(d.qtyPieces) || 0;
  const a = Number(d.qtyArts) || 0;
  const v = Number(d.qtyVariations) || 0;
  if (!p && !a && !v) return '<span class="qty-cell-empty">—</span>';
  return `<span class="qty-cell-compact" title="${p} peça${p === 1 ? '' : 's'} · ${a} arte${a === 1 ? '' : 's'} · ${v} variaç${v === 1 ? 'ão' : 'ões'}">
    <span class="qty-num">${p}</span><span class="qty-sep">·</span><span class="qty-num">${a}</span><span class="qty-sep">·</span><span class="qty-num">${v}</span>
  </span>`;
}

function priorityPill(v) {
  const p = PRIORITIES.find(x => x.value === v) || PRIORITIES[2];
  return `<span class="pill" style="color:${p.color};background:${hexDim(p.color)};font-size:10px">${p.label}</span>`;
}
/* Ordena opções de um select alfabeticamente (preserva primeira opção como placeholder) */
function sortSelectAlpha(sel) {
  if (!sel || sel.options.length < 2) return;
  const first = sel.options[0];
  const isPlaceholder = !first.value;
  const start = isPlaceholder ? 1 : 0;
  const opts = [...sel.options].slice(start);
  opts.sort((a, b) => norm(a.text).localeCompare(norm(b.text)));
  while (sel.options.length > start) sel.remove(start);
  opts.forEach(o => sel.add(o));
}

/* ─── URL helpers ─── */
function normalizeUrl(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Já tem protocolo: mantém
  if (/^https?:\/\//i.test(s)) return s;
  // Outros protocolos (mailto:, tel:, ftp:, etc.) — mantém como está
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  // Prepend https://
  return 'https://' + s;
}
/* Detecta URLs dentro de texto livre e converte em <a target=_blank>. Recebe string JÁ ESCAPADA. */
function linkifyEscaped(escaped) {
  // Padrão: protocolo opcional + domínio + path. Adiciona https:// se omitido.
  const re = /\b((?:https?:\/\/|www\.)[^\s<]+|[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|com\.br|net|org|io|co|app|dev|info|gov|edu|me|tv|ai|design)(?:\/[^\s<]*)?)\b/gi;
  return escaped.replace(re, m => {
    // Evita linkificar conteúdo dentro de tags já inseridas (mention spans não contém URL real, então é raro)
    const href = normalizeUrl(m);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="auto-link">${m}</a>`;
  });
}

function userById(id)    { return users.find(u => u.id === id) || null; }
function projectById(id) { return projects.find(p => p.id === id) || null; }
function flowById(id)    { return flows.find(f => f.id === id) || null; }
function wsById(id)      { return workspaces.find(w => w.id === id) || null; }

function wsProjects() { return projects.filter(p => p.workspaceId === activeWs); }
function wsClients()  { return clients.filter(c => c.workspaceId === activeWs); }
function wsFlows()    { return flows.filter(f => f.workspaceId === activeWs); }
function wsDemands()  { return demands.filter(d => d.workspaceId === activeWs); }
function wsUsers()    { return users.filter(u => u.active !== false && (u.isAdmin || (u.workspaces || []).includes(activeWs))); }
function clientById(id) { return clients.find(c => c.id === id) || null; }

function stageOf(d) {
  const f = flowById(d.flowId);
  if (!f) return null;
  // Procura primeiro nas etapas originais do fluxo, depois nas adicionadas
  // por instância (stageAdditions). Sem isso, listas/kanban/pills mostram "—"
  // quando a demanda está numa etapa que só existe no escopo dela.
  const additions = Array.isArray(d.stageAdditions) ? d.stageAdditions : [];
  const base = f.stages.find(s => s.id === d.status) || additions.find(s => s.id === d.status);
  if (!base) return null;
  // Aplica overrides por instância (label/color/done/deadlineDays) — a mesma
  // regra do activeStagesOf, sem o filtro de skipped (aqui é lookup direto).
  const labels = (d.stageLabels && typeof d.stageLabels === 'object') ? d.stageLabels : {};
  const ov = (d.stageOverrides && typeof d.stageOverrides === 'object') ? d.stageOverrides[d.status] : null;
  let s = base;
  if (labels[d.status]) s = { ...s, label: labels[d.status] };
  if (ov) s = {
    ...s,
    ...(ov.color !== undefined ? { color: ov.color } : {}),
    ...(ov.deadlineDays !== undefined ? { deadlineDays: ov.deadlineDays } : {}),
    ...(ov.done !== undefined ? { done: ov.done } : {})
  };
  return s;
}
/* Etapas ativas para esta demanda — respeita a customização por instância:
   ordem (stageOrder), rótulos (stageLabels) e pulos (skippedStages).
   O fluxo original não muda. */
function activeStagesOf(d, flow) {
  if (!flow) flow = flowById(d.flowId);
  if (!flow) return [];
  const skipped = new Set(Array.isArray(d.skippedStages) ? d.skippedStages : []);
  const labels = (d.stageLabels && typeof d.stageLabels === 'object') ? d.stageLabels : {};
  const overrides = (d.stageOverrides && typeof d.stageOverrides === 'object') ? d.stageOverrides : {};
  const additions = Array.isArray(d.stageAdditions) ? d.stageAdditions : [];
  // Pool completo (originais + adicionadas) indexado por id.
  const allById = new Map();
  flow.stages.forEach(s => allById.set(s.id, s));
  additions.forEach(s => allById.set(s.id, s));
  // Ordem: se stageOrder existe, usa (contém IDs de originais E adicionadas).
  // Senão, originais na ordem do fluxo + adicionadas no final.
  let orderedIds;
  if (Array.isArray(d.stageOrder) && d.stageOrder.length) {
    const set = new Set(d.stageOrder);
    orderedIds = [...d.stageOrder.filter(id => allById.has(id))];
    // Pega o que ficou fora do stageOrder (segurança contra IDs novos)
    flow.stages.forEach(s => { if (!set.has(s.id)) orderedIds.push(s.id); });
    additions.forEach(s => { if (!set.has(s.id)) orderedIds.push(s.id); });
  } else {
    orderedIds = [...flow.stages.map(s => s.id), ...additions.map(s => s.id)];
  }
  // Aplica label + overrides (color/deadlineDays/done). Filtra puladas.
  return orderedIds
    .filter(id => !skipped.has(id))
    .map(id => {
      const base = allById.get(id);
      if (!base) return null;
      const ov = overrides[id];
      let s = base;
      if (labels[id]) s = { ...s, label: labels[id] };
      if (ov) s = { ...s, ...(ov.color !== undefined ? { color: ov.color } : {}), ...(ov.deadlineDays !== undefined ? { deadlineDays: ov.deadlineDays } : {}), ...(ov.done !== undefined ? { done: ov.done } : {}) };
      return s;
    })
    .filter(Boolean);
}
/* Responsável efetivo de uma etapa para uma demanda específica.
   Override por instância tem precedência sobre o padrão do fluxo. */
function effectiveStageResponsibleId(d, stage) {
  if (d && d.stageResponsibles && Object.prototype.hasOwnProperty.call(d.stageResponsibles, stage.id)) {
    return d.stageResponsibles[stage.id];
  }
  return stage.responsibleId || null;
}
/* Versão completa com resolução via função (role → project → client roleAssignments).
   Espelha resolveStageOwner do backend. Retorna userId ou null. */
function resolveStageOwnerId(d, stage) {
  if (!stage) return null;
  const direct = effectiveStageResponsibleId(d, stage);
  if (direct) return direct;
  if (stage.responsibleRole) {
    const p = d.projectId ? projectById(d.projectId) : null;
    const projAssign = p?.roleAssignments?.[stage.responsibleRole];
    if (projAssign) return projAssign;
    const c = p?.clientId ? clientById(p.clientId) : null;
    const cliAssign = c?.roleAssignments?.[stage.responsibleRole];
    if (cliAssign) return cliAssign;
  }
  return null;
}
/* Responsável efetivo de uma demanda inteira — resolve via cadeia:
   1) d.ownerId direto
   2) stage.responsibleId da etapa atual (com override d.stageResponsibles)
   3) stage.responsibleRole → project.roleAssignments[role] → client.roleAssignments[role]
   Mesma lógica do backend resolveStageOwner + fallback pra ownerId direto. */
function effectiveOwnerOf(d) {
  if (!d) return null;
  if (d.ownerId) {
    const u = userById(d.ownerId);
    if (u) return u;
  }
  const stage = stageOf(d);
  if (stage) {
    const uidDirect = effectiveStageResponsibleId(d, stage);
    if (uidDirect) {
      const u = userById(uidDirect);
      if (u) return u;
    }
    if (stage.responsibleRole) {
      const p = d.projectId ? projectById(d.projectId) : null;
      const projAssign = p?.roleAssignments?.[stage.responsibleRole];
      if (projAssign) {
        const u = userById(projAssign);
        if (u) return u;
      }
      const c = p?.clientId ? clientById(p.clientId) : null;
      const cliAssign = c?.roleAssignments?.[stage.responsibleRole];
      if (cliAssign) {
        const u = userById(cliAssign);
        if (u) return u;
      }
    }
  }
  return null;
}
function isDone(d)  { const s = stageOf(d); return !!(s && s.done); }
function todayStr() { return new Date().toISOString().slice(0,10); }
function effDue(d)  { return d.stageDueDate || d.deadline || null; }
function isLate(d)  { const due = effDue(d); return !!due && !isDone(d) && due < todayStr(); }
function wasLate(d) { return isDone(d) && d.deadline && d.completedAt && d.completedAt.slice(0,10) > d.deadline; }
function demandType(d) { const f = flowById(d.flowId); return f ? (f.demandType || '') : ''; }

// Cria uma versão debounced de fn — útil pra inputs de busca que rebuildam
// listas grandes em cada tecla. Cancela chamadas pendentes a cada novo trigger.
function debounce(fn, ms = 150) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function fmtDate(s) {
  if (!s) return '—';
  const [y,m,d] = String(s).slice(0,10).split('-');
  return `${d}/${m}/${y}`;
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  return dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtHours(h) {
  const v = Math.round(Number(h || 0) * 100) / 100;
  return (Number.isInteger(v) ? v : v.toFixed(1).replace('.', ',')) + 'h';
}
function hexDim(hex) {
  const h = (hex || '#7A00FF').replace('#','');
  const n = parseInt(h.length === 3 ? h.split('').map(c=>c+c).join('') : h, 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},0.15)`;
}
function statusPill(d) {
  const s = stageOf(d);
  if (!s) return '<span class="pill pill-muted">—</span>';
  return `<span class="pill" style="color:${s.color};background:${hexDim(s.color)}"><span class="pill-dot" style="background:${s.color}"></span>${esc(s.label)}</span>`;
}
function ownerName(d) { const u = userById(d.ownerId); return u ? u.name : '—'; }
function avatarHTML(u, cls = 'avatar') {
  const pClass = presenceClassFor(u);
  const fullCls = pClass ? `${cls} ${pClass}` : cls;
  if (u && u.avatar) return `<div class="${fullCls}" style="background-image:url('${u.avatar}');background-size:cover;background-position:center"></div>`;
  const initial = u ? (u.name || u.username || '?').trim().charAt(0).toUpperCase() : '?';
  const seed = u ? (u.id || u.username || u.name || '?') : '?';
  return `<div class="${fullCls}" style="background:${avatarGradient(seed)};color:#fff;border:0;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08)">${esc(initial)}</div>`;
}
/* Classe de presença que vira um anel ao redor do avatar.
   verde = ativo nos últimos 5min, amarelo = 5-30min, sem anel a partir de 30min. */
function presenceClassFor(u) {
  if (!u || !u.lastSeen) return '';
  const t = new Date(u.lastSeen).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMin = (Date.now() - t) / 60000;
  if (diffMin < 5)  return 'presence-online';
  if (diffMin < 30) return 'presence-away';
  return '';
}
// Gera um gradiente determinístico a partir de um seed (id do usuário) — cada
// pessoa ganha sua cor consistente, mantendo bom contraste com texto branco.
// Memoizado: o resultado é puro do seed, e avatarHTML chama esta função em
// todo render (lista, kanban, calendário, comentários) — cache evita rehash.
/* Paleta curada de gradients — 16 combos elegantes que sempre ficam bons com
   texto branco. Mais bonito que HSL random (que dava matches feios em verdes
   doentios ou neons). Hash do seed → índice da paleta. */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #FF6B6B 0%, #C92A2A 100%)', // coral → vermelho
  'linear-gradient(135deg, #F8A055 0%, #D14A1F 100%)', // laranja → tijolo
  'linear-gradient(135deg, #FFB84D 0%, #B8860B 100%)', // âmbar
  'linear-gradient(135deg, #FFD93D 0%, #E07B00 100%)', // amarelo → bronze
  'linear-gradient(135deg, #8BC34A 0%, #2E7D32 100%)', // verde-claro → verde
  'linear-gradient(135deg, #4ECDC4 0%, #1B9E96 100%)', // turquesa
  'linear-gradient(135deg, #44BCD8 0%, #0277B6 100%)', // ciano → azul
  'linear-gradient(135deg, #6FA8DC 0%, #1A5490 100%)', // azul-claro → marinho
  'linear-gradient(135deg, #4A6FE3 0%, #2E3B8E 100%)', // royal blue
  'linear-gradient(135deg, #7A6BE8 0%, #3F2DA5 100%)', // indigo
  'linear-gradient(135deg, #9C6FE8 0%, #6128D7 100%)', // violeta → roxo
  'linear-gradient(135deg, #C77DFF 0%, #7A00FF 100%)', // lavanda → brand
  'linear-gradient(135deg, #E6A0E0 0%, #A93FA8 100%)', // rosa-claro → magenta
  'linear-gradient(135deg, #F472B6 0%, #BE185D 100%)', // pink
  'linear-gradient(135deg, #FB7185 0%, #9F1239 100%)', // rosé
  'linear-gradient(135deg, #94A3B8 0%, #475569 100%)'  // slate (fallback neutro)
];
const _avatarGradientCache = new Map();
function avatarGradient(seed) {
  const key = String(seed);
  const cached = _avatarGradientCache.get(key);
  if (cached) return cached;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) >>> 0;
  const result = AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
  _avatarGradientCache.set(key, result);
  return result;
}
function projectAvatarHTML(p, cls = 'avatar') {
  if (!p) return `<div class="${cls}">?</div>`;
  if (p.avatar) return `<div class="${cls}" style="background-image:url('${p.avatar}');background-size:cover;background-position:center"></div>`;
  const letter = (p.name || 'P').charAt(0).toUpperCase();
  return `<div class="${cls}" style="background:${hexDim(p.color)};color:${p.color}">${esc(letter)}</div>`;
}
function clientAvatarHTML(c, cls = 'avatar') {
  if (!c) return `<div class="${cls}">?</div>`;
  if (c.avatar) return `<div class="${cls}" style="background-image:url('${c.avatar}');background-size:cover;background-position:center"></div>`;
  const color = c.color || '#7A00FF';
  const letter = (c.name || 'C').charAt(0).toUpperCase();
  return `<div class="${cls}" style="background:${hexDim(color)};color:${color}">${esc(letter)}</div>`;
}

/* ── Universal filter dropdown ──
   Mantém o <select> nativo (para compatibilidade) e renderiza um .filter-cdrop sibling com a UI padronizada.
   Opções extras:
   - userIcon: true → adiciona avatar do usuário ao lado do nome
   - projectIcon: true → adiciona avatar do projeto ao lado do nome
*/
// Cores oficiais das prioridades da demanda (usadas no dot do dropdown e
// potencialmente em badges/pills no kanban).
const PRIORITY_COLORS = {
  '1': '#EF4444', // Imediato — vermelho
  '2': '#FB7415', // Alta — laranja vivo (forte contraste com o amarelo do Média)
  '3': '#FACC15', // Média — amarelo
  '4': '#60A5FA'  // Baixa — azul claro
};
function applyPriorityDropdown(selId) {
  applyFilterDropdown(selId, { dotMap: PRIORITY_COLORS });
}

function applyFilterDropdown(selId, opts = {}) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.classList.add('filter-native-hidden');
  let wrap = sel.nextElementSibling;
  if (!wrap || !wrap.classList.contains('filter-cdrop')) {
    wrap = document.createElement('div');
    wrap.className = 'filter-cdrop';
    sel.after(wrap);
  }
  const value = sel.value;
  const options = [...sel.options].map(o => {
    const opt = { value: o.value, label: o.label };
    if (opts.userIcon && o.value) {
      const u = userById(o.value);
      if (u) opt.avatar = avatarHTML(u, 'avatar filter-cdrop-avatar');
    } else if (opts.projectIcon && o.value) {
      const p = projectById(o.value);
      if (p) opt.avatar = projectAvatarHTML(p, 'avatar filter-cdrop-avatar');
    } else if (opts.clientIcon && o.value) {
      const c = (clients || []).find(x => x.id === o.value);
      if (c) opt.avatar = clientAvatarHTML(c, 'avatar filter-cdrop-avatar');
    } else if (opts.dotMap && opts.dotMap[o.value]) {
      // Bola colorida por valor (ex.: prioridades). Estilo inline pra evitar
      // proliferar classes; .filter-cdrop-dot só padroniza tamanho/forma.
      opt.avatar = `<span class="filter-cdrop-dot" style="background:${opts.dotMap[o.value]}"></span>`;
    }
    return opt;
  });
  const current = options.find(o => o.value === value) || options[0] || { value: '', label: '' };
  const filtering = !!current.value;
  wrap.classList.toggle('filtering', filtering);
  wrap.dataset.targetSel = selId;
  wrap.innerHTML = `
    <button type="button" class="filter-cdrop-trigger" onclick="toggleFilterCdrop(this.parentElement)">
      ${current.avatar || ''}
      <span class="filter-cdrop-label">${esc(current.label || '')}</span>
      <i data-lucide="chevron-down" class="ic-xs"></i>
    </button>
    <div class="filter-cdrop-menu">
      ${options.map(o => `
        <div class="filter-cdrop-item ${o.value === value ? 'active' : ''}" onclick="pickFilterCdrop('${esc(selId)}', this.dataset.v)" data-v="${esc(o.value)}">
          ${o.avatar || ''}
          <span>${esc(o.label)}</span>
        </div>`).join('')}
    </div>
  `;
}
function toggleFilterCdrop(wrap) {
  document.querySelectorAll('.filter-cdrop.open, .cdrop.open').forEach(el => { if (el !== wrap) el.classList.remove('open'); });
  wrap.classList.toggle('open');
  if (wrap.classList.contains('open')) {
    // Auto-flip pra cima quando não cabe abaixo. Mede contra o container
    // de scroll mais próximo (modal-body / modal / viewport) — só assim
    // dropdowns dentro de modais detectam o limite real, não o da janela.
    const menu = wrap.querySelector('.filter-cdrop-menu');
    if (menu) {
      wrap.classList.remove('drop-up');
      const rect = wrap.getBoundingClientRect();
      const scrollHost = wrap.closest('.modal-body') || wrap.closest('.modal') || document.documentElement;
      const hostRect = scrollHost.getBoundingClientRect ? scrollHost.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const bottomLimit = Math.min(hostRect.bottom, window.innerHeight);
      const topLimit = Math.max(hostRect.top, 0);
      const spaceBelow = bottomLimit - rect.bottom;
      const spaceAbove = rect.top - topLimit;
      const menuH = menu.scrollHeight || menu.offsetHeight || 0;
      if (spaceBelow < menuH + 12 && spaceAbove > spaceBelow) wrap.classList.add('drop-up');
    }
  }
  paintIcons();
}
function pickFilterCdrop(selId, value) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  document.querySelectorAll('.filter-cdrop.open').forEach(el => el.classList.remove('open'));
  if (![...sel.options].some(o => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    sel.add(opt);
  }
  sel.value = value;
  // Atualiza imediatamente o trigger visual e a marcação .active.
  // Sem isto, o label do botão só se atualizava se algum onchange disparar
  // um re-render externo — selects estáticos (ex.: prioridade) ficavam congelados.
  const wrap = sel.nextElementSibling;
  if (wrap && wrap.classList.contains('filter-cdrop')) {
    const items = wrap.querySelectorAll('.filter-cdrop-item');
    let chosenItem = null;
    items.forEach(it => {
      const isMatch = it.dataset.v === value;
      it.classList.toggle('active', isMatch);
      if (isMatch) chosenItem = it;
    });
    const label = wrap.querySelector('.filter-cdrop-label');
    const trigger = wrap.querySelector('.filter-cdrop-trigger');
    if (chosenItem && label && trigger) {
      // Texto do item: o span que NÃO é o dot/avatar — usar o nome do option
      // do select nativo como fallback confiável.
      const opt = [...sel.options].find(o => o.value === value);
      label.textContent = opt ? opt.label : '';
      // Sincroniza a media (dot/avatar) do trigger com a do item escolhido
      const itemAvatar = chosenItem.querySelector('.filter-cdrop-avatar, .filter-cdrop-dot');
      const existingMedia = trigger.querySelector('.filter-cdrop-avatar, .filter-cdrop-dot');
      if (existingMedia) existingMedia.remove();
      if (itemAvatar) trigger.insertBefore(itemAvatar.cloneNode(true), trigger.firstChild);
    }
    wrap.classList.toggle('filtering', !!value);
  }
  let fired = false;
  if (typeof sel.onchange === 'function') {
    try { sel.onchange.call(sel, new Event('change')); fired = true; }
    catch (e) { console.error('Filter onchange error:', e); }
  }
  if (!fired) {
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
// Fecha cdrops ao clicar fora
document.addEventListener('click', ev => {
  if (!ev.target.closest('.filter-cdrop')) {
    document.querySelectorAll('.filter-cdrop.open').forEach(c => c.classList.remove('open'));
  }
});
function cellUser(u) {
  if (!u) return '—';
  return `<span class="cell-user">${avatarHTML(u)} ${esc(u.name)}</span>`;
}
// ─── EMPTY STATES com ilustração line-art ───
/* Empty states ilustrados — SVGs com viewBox 160×120, usando o accent (--accent)
   e tons de surface pra dar profundidade. Cada ilustração tem uma "cena" leve
   em vez de só um ícone monocromático. Variáveis CSS são interpoladas via
   currentColor pra fallback e style="--accent" pra cor da marca. */
const EMPTY_ICONS = {
  default: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <rect x="30" y="28" width="100" height="68" rx="8" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".22" stroke-width="1.5"/>
    <path d="M30 44h100" stroke="currentColor" stroke-opacity=".22" stroke-width="1.5"/>
    <circle cx="40" cy="36" r="2" fill="var(--accent-text, #B380FF)"/>
    <circle cx="48" cy="36" r="2" fill="currentColor" opacity=".35"/>
    <circle cx="56" cy="36" r="2" fill="currentColor" opacity=".35"/>
    <rect x="44" y="56" width="48" height="6" rx="3" fill="currentColor" opacity=".22"/>
    <rect x="44" y="70" width="32" height="6" rx="3" fill="var(--accent-text, #B380FF)" opacity=".4"/>
    <rect x="44" y="84" width="20" height="4" rx="2" fill="currentColor" opacity=".18"/>
  </svg>`,
  inbox: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <path d="M36 50h88l-10 26H46z" fill="var(--accent-text, #B380FF)" opacity=".2"/>
    <path d="M30 76v14a6 6 0 006 6h88a6 6 0 006-6V76" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <path d="M30 76l8-26h84l8 26" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M46 76h12a14 14 0 0028 0h12" stroke="var(--accent-text, #B380FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <circle cx="80" cy="34" r="3" fill="var(--accent-text, #B380FF)" opacity=".5"/>
    <circle cx="64" cy="28" r="2" fill="currentColor" opacity=".3"/>
    <circle cx="96" cy="28" r="2" fill="currentColor" opacity=".3"/>
  </svg>`,
  search: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <circle cx="68" cy="56" r="28" fill="var(--accent-text, #B380FF)" opacity=".10"/>
    <circle cx="68" cy="56" r="28" stroke="currentColor" stroke-opacity=".3" stroke-width="2"/>
    <path d="M90 78l18 18" stroke="var(--accent-text, #B380FF)" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M58 50h20M68 40v20" stroke="currentColor" stroke-opacity=".45" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  calendar: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="110" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <rect x="32" y="28" width="96" height="74" rx="8" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <path d="M32 48h96" stroke="currentColor" stroke-opacity=".3" stroke-width="1.5"/>
    <path d="M52 20v14M108 20v14" stroke="currentColor" stroke-opacity=".5" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="42" y="58" width="14" height="10" rx="2" fill="currentColor" opacity=".18"/>
    <rect x="60" y="58" width="14" height="10" rx="2" fill="var(--accent-text, #B380FF)" opacity=".5"/>
    <rect x="78" y="58" width="14" height="10" rx="2" fill="currentColor" opacity=".18"/>
    <rect x="96" y="58" width="14" height="10" rx="2" fill="currentColor" opacity=".18"/>
    <rect x="42" y="74" width="14" height="10" rx="2" fill="currentColor" opacity=".12"/>
    <rect x="60" y="74" width="14" height="10" rx="2" fill="currentColor" opacity=".12"/>
    <rect x="78" y="74" width="14" height="10" rx="2" fill="currentColor" opacity=".12"/>
  </svg>`,
  comments: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <path d="M30 38a8 8 0 018-8h68a8 8 0 018 8v32a8 8 0 01-8 8H62l-14 12V78h-10a8 8 0 01-8-8z" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <rect x="44" y="46" width="50" height="5" rx="2.5" fill="var(--accent-text, #B380FF)" opacity=".55"/>
    <rect x="44" y="56" width="34" height="5" rx="2.5" fill="currentColor" opacity=".22"/>
    <circle cx="106" cy="36" r="6" fill="var(--accent-text, #B380FF)" opacity=".7"/>
    <text x="106" y="40" font-size="8" font-weight="700" fill="#fff" text-anchor="middle" font-family="system-ui">1</text>
  </svg>`,
  users: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".10"/>
    <circle cx="62" cy="52" r="14" fill="var(--accent-text, #B380FF)" fill-opacity=".55"/>
    <circle cx="62" cy="52" r="14" stroke="var(--accent-text, #B380FF)" stroke-opacity=".7" stroke-width="1.5"/>
    <path d="M38 96c4-14 12-20 24-20s20 6 24 20" fill="var(--accent-text, #B380FF)" fill-opacity=".25" stroke="var(--accent-text, #B380FF)" stroke-opacity=".55" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="104" cy="50" r="10" fill="currentColor" fill-opacity=".18"/>
    <circle cx="104" cy="50" r="10" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5"/>
    <path d="M92 84c2-9 8-14 16-14s14 5 18 14" fill="currentColor" fill-opacity=".08" stroke="currentColor" stroke-opacity=".4" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`,
  flow: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <path d="M48 60h28l16-30M48 60h28l16 30" stroke="currentColor" stroke-opacity=".35" stroke-width="2" stroke-linecap="round" fill="none"/>
    <path d="M104 60h22" stroke="var(--accent-text, #B380FF)" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 4"/>
    <circle cx="40" cy="60" r="10" fill="var(--accent-text, #B380FF)" opacity=".7"/>
    <circle cx="96" cy="30" r="9" fill="currentColor" opacity=".18" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>
    <circle cx="96" cy="90" r="9" fill="currentColor" opacity=".18" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>
    <circle cx="132" cy="60" r="10" fill="currentColor" opacity=".18" stroke="currentColor" stroke-opacity=".4" stroke-width="1.5"/>
  </svg>`,
  webhook: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="108" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <circle cx="80" cy="38" r="14" fill="var(--accent-text, #B380FF)" opacity=".25" stroke="var(--accent-text, #B380FF)" stroke-opacity=".7" stroke-width="1.5"/>
    <circle cx="46" cy="82" r="14" fill="currentColor" opacity=".10" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>
    <circle cx="114" cy="82" r="14" fill="currentColor" opacity=".10" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/>
    <path d="M73 50l-18 20M87 50l18 20M58 82h44" stroke="currentColor" stroke-opacity=".4" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  kanban: `<svg viewBox="0 0 160 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="80" cy="110" rx="56" ry="6" fill="currentColor" opacity=".08"/>
    <rect x="22" y="22" width="36" height="78" rx="6" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <rect x="62" y="22" width="36" height="58" rx="6" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <rect x="102" y="22" width="36" height="68" rx="6" fill="currentColor" opacity=".06" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <rect x="28" y="32" width="24" height="8" rx="2" fill="var(--accent-text, #B380FF)" opacity=".55"/>
    <rect x="28" y="46" width="24" height="8" rx="2" fill="currentColor" opacity=".18"/>
    <rect x="68" y="32" width="24" height="8" rx="2" fill="currentColor" opacity=".18"/>
    <rect x="108" y="32" width="24" height="8" rx="2" fill="currentColor" opacity=".18"/>
    <rect x="108" y="46" width="24" height="8" rx="2" fill="var(--accent-text, #B380FF)" opacity=".4"/>
  </svg>`,
};
function emptyState(title, sub, iconName, cta) {
  const icon = EMPTY_ICONS[iconName] || EMPTY_ICONS.default;
  // cta opcional: { label, onclick, icon?, variant? ('primary' default | 'ghost') }
  const ctaHtml = cta && cta.label
    ? `<button type="button" class="empty-state-cta ${cta.variant === 'ghost' ? 'is-ghost' : ''}" onclick="${cta.onclick}">
        ${cta.icon ? `<i data-lucide="${cta.icon}" class="ic-sm"></i>` : ''}
        <span>${esc(cta.label)}</span>
      </button>`
    : '';
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon}</div>
    <div class="empty-state-title">${esc(title)}</div>
    <div class="empty-state-sub">${esc(sub || '')}</div>
    ${ctaHtml}
  </div>`;
}

// ─── SKELETONS ───
function skeletonMetrics(n = 4) {
  return Array.from({length: n}, () => `
    <div class="metric-card">
      <div class="skeleton skeleton-line sm" style="width:55%;margin-bottom:14px"></div>
      <div class="skeleton skeleton-line lg" style="width:42%;margin-bottom:10px"></div>
      <div class="skeleton skeleton-line xs" style="width:70%"></div>
    </div>`).join('');
}
function skeletonTableRows(cols = 7, rows = 6) {
  return Array.from({length: rows}, (_, i) => `
    <tr><td colspan="${cols}"><div class="skeleton skeleton-line" style="width:${50 + ((i * 13) % 40)}%;margin:0"></div></td></tr>
  `).join('');
}

/* ─── HOVER TOOLTIP PARA GRÁFICOS DE LINHA ──────────────────────
   Genérico: recebe um host (com SVG dentro, preserveAspectRatio="none"
   recomendado) e config com pontos no sistema de coordenadas do viewBox.
   Mostra: tooltip flutuante + linha-guia vertical + ponto destacado.

   config = {
     viewBox:  { w, h, padL, padR, padT, innerH },
     points:   [ { x, label, series: [{ y, value, color }] } ],
     lineEls:  HTMLElement (guide line dentro do SVG) — opcional
     markerEls:[HTMLElement] (1 por série, dentro do SVG) — opcional
     tooltipEl:HTMLElement absoluta dentro do host
     format:   (val, seriesIdx) => string
   } */
function attachChartHover(host, config) {
  if (!host || !config.points || !config.points.length) return;
  const tip = config.tooltipEl;
  const guide = config.lineEls;
  const markers = config.markerEls || [];
  const { w: vbW, h: vbH, padT, innerH } = config.viewBox;
  let lastIdx = -1;

  const onMove = (e) => {
    const rect = host.getBoundingClientRect();
    if (!rect.width) return;
    const localX = e.clientX - rect.left;
    const svgX = localX * vbW / rect.width;
    // Acha o ponto mais próximo
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < config.points.length; i++) {
      const d = Math.abs(config.points[i].x - svgX);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best === lastIdx) return;
    lastIdx = best;
    const p = config.points[best];
    // Posiciona guide line + markers (em SVG coords)
    if (guide) {
      guide.setAttribute('x1', p.x);
      guide.setAttribute('x2', p.x);
      guide.style.opacity = '1';
    }
    p.series.forEach((s, i) => {
      const m = markers[i];
      if (!m) return;
      m.setAttribute('cx', p.x);
      m.setAttribute('cy', s.y);
      m.style.opacity = '1';
    });
    // Posiciona tooltip (em pixel coords do host)
    if (tip) {
      const lines = p.series.map((s, i) => {
        const sw = s.color ? `<span class="chart-tip-dot" style="background:${s.color}"></span>` : '';
        return `<div class="chart-tip-row">${sw}<span class="chart-tip-label">${esc(s.name || '')}</span><span class="chart-tip-value">${esc(config.format(s.value, i))}</span></div>`;
      }).join('');
      tip.innerHTML = `<div class="chart-tip-head">${esc(p.label)}</div>${lines}`;
      const tipX = p.x * rect.width / vbW;
      // Limita pra não vazar o host
      const tipW = tip.offsetWidth || 140;
      let left = tipX + 10;
      if (left + tipW > rect.width - 8) left = tipX - tipW - 10;
      if (left < 4) left = 4;
      tip.style.left = left + 'px';
      tip.style.top = '8px';
      tip.style.opacity = '1';
    }
  };
  const onLeave = () => {
    lastIdx = -1;
    if (tip) tip.style.opacity = '0';
    if (guide) guide.style.opacity = '0';
    markers.forEach(m => m && (m.style.opacity = '0'));
  };
  host.addEventListener('mousemove', onMove);
  host.addEventListener('mouseleave', onLeave);
}

// ─── SPARKLINE (mini SVG line chart) ───
function sparkline(values, opts = {}) {
  if (!Array.isArray(values) || values.length < 2) return '';
  const w = opts.width || 96;
  const h = opts.height || 24;
  const color = opts.color || 'var(--accent-text)';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastY = h - pad - ((values[values.length - 1] - min) / range) * (h - pad * 2);
  const lastX = (values.length - 1) * step;
  const areaPath = `M0,${h} L${pts.join(' L')} L${w},${h} Z`;
  const linePath = `M${pts.join(' L')}`;
  const gid = 'spk' + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" style="display:block;overflow:visible">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#${gid})"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2" fill="${color}"/>
  </svg>`;
}

/* Toast com botão "Desfazer" — usado após soft delete de demanda/cliente/projeto.
   `undoFn` só é chamado se o usuário clicar antes do toast desaparecer (~8s).
   Após ~7 dias o backend faz purge definitivo (config em UNDO_PURGE_MS). */
function toastWithUndo(msg, undoFn) {
  toast(msg, 'warn', {
    label: 'Desfazer',
    fn: async () => {
      try {
        await undoFn();
        toast('Restaurado.', 'success');
        if (typeof refreshData === 'function') await refreshData();
      } catch (e) {
        toast('Não foi possível desfazer: ' + (e.message || 'erro'), 'error');
      }
    }
  });
}
function toast(msg, type = 'success', action = null) {
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  const msgEl = document.createElement('span');
  msgEl.className = 'toast-msg';
  msgEl.textContent = msg;
  t.appendChild(msgEl);
  let hasAction = false;
  if (action && action.label && typeof action.fn === 'function') {
    hasAction = true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      try { action.fn(); } catch (err) { console.error(err); }
      t.remove();
    });
    t.appendChild(btn);
  }
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), hasAction ? 6000 : 3500);
}
/* ─── ATALHOS DE TECLADO ─── */
const KB_SHORTCUTS = [
  { keys: ['⌘/Ctrl', 'K'], label: 'Paleta de comandos (busca + ações)' },
  { keys: ['?'],       label: 'Mostrar atalhos' },
  { keys: ['/'],       label: 'Focar na busca' },
  { keys: ['n'],       label: 'Nova demanda' },
  { keys: ['g', 'd'],  label: 'Ir para Dashboard' },
  { keys: ['g', 'l'],  label: 'Ir para Demandas' },
  { keys: ['g', 'm'],  label: 'Ir para Minhas Demandas' },
  { keys: ['g', 'c'],  label: 'Ir para Capacidade' },
  { keys: ['g', 'p'],  label: 'Ir para Projetos' },
  { keys: ['Esc'],     label: 'Fechar modal/painel' },
];
let _gPressed = false;
function initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    // Ctrl/Cmd+K abre paleta de comandos a qualquer momento
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (cmdkOpen) closeCommandPalette();
      else openCommandPalette();
      return;
    }
    // Ignora se está digitando
    const t = e.target;
    const inEditable = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
    // Esc sempre — fecha popovers/cheatsheet
    if (e.key === 'Escape') {
      if (cmdkOpen) { e.preventDefault(); closeCommandPalette(); return; }
      if (hideShortcutsHelp()) { e.preventDefault(); return; }
      // demais Escs são tratados por outros listeners (modais)
      return;
    }
    if (inEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === '?') { e.preventDefault(); showShortcutsHelp(); }
    else if (k === '/') { e.preventDefault(); const s = $('search-input'); if (s) s.focus(); }
    else if (k === 'n') { e.preventDefault(); if (typeof openNewDemand === 'function') openNewDemand(); }
    else if (k === 'g') { _gPressed = true; setTimeout(() => { _gPressed = false; }, 800); }
    else if (_gPressed) {
      const go = { d: 'dashboard', l: 'list', m: 'mine', c: 'capacity', p: 'projects' }[k];
      if (go) { e.preventDefault(); _gPressed = false; goPage(go); }
    }
  });
}

/* ─── PALETA DE COMANDOS (⌘K) ───
   Modal central com input de busca. Lista ações de navegação + demandas
   do workspace ativo que casam com o termo. Navegação por teclado:
   ↑ ↓ Enter Esc. Hover do mouse também atualiza o item ativo. */
let cmdkOpen = false;
let cmdkActiveIdx = 0;
let cmdkResults = [];
function openCommandPalette() {
  let el = document.getElementById('cmdk');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cmdk';
    el.className = 'cmdk-overlay';
    el.innerHTML = `
      <div class="cmdk-card" role="dialog" aria-label="Paleta de comandos">
        <div class="cmdk-input-wrap">
          <i data-lucide="search" class="ic-sm cmdk-input-icon"></i>
          <input class="cmdk-input" id="cmdk-input" placeholder="Buscar cliente, demanda, projeto, lista, recorrente, fluxo, usuário ou ação…" autocomplete="off" spellcheck="false">
          <kbd class="cmdk-hint-kbd">Esc</kbd>
        </div>
        <div class="cmdk-results" id="cmdk-results"></div>
        <div class="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
          <span><kbd>↵</kbd> selecionar</span>
          <span><kbd>esc</kbd> fechar</span>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', ev => { if (ev.target === el) closeCommandPalette(); });
    const input = el.querySelector('#cmdk-input');
    input.addEventListener('input', renderCommandPalette);
    input.addEventListener('keydown', cmdkOnKey);
  }
  el.querySelector('#cmdk-input').value = '';
  cmdkActiveIdx = 0;
  el.classList.add('open');
  cmdkOpen = true;
  renderCommandPalette();
  setTimeout(() => { const i = document.getElementById('cmdk-input'); if (i) i.focus(); }, 30);
}
function closeCommandPalette() {
  const el = document.getElementById('cmdk');
  if (!el) return;
  el.classList.remove('open');
  cmdkOpen = false;
}
function cmdkOnKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkActiveIdx = Math.min(cmdkResults.length - 1, cmdkActiveIdx + 1); paintCmdkActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkActiveIdx = Math.max(0, cmdkActiveIdx - 1); paintCmdkActive(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const r = cmdkResults[cmdkActiveIdx];
    if (r) cmdkRun(r);
  }
}
function paintCmdkActive() {
  const items = document.querySelectorAll('#cmdk-results .cmdk-item');
  items.forEach((it, i) => it.classList.toggle('active', i === cmdkActiveIdx));
  const active = items[cmdkActiveIdx];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
function cmdkRun(r) {
  closeCommandPalette();
  setTimeout(() => { try { r.run(); } catch (err) { console.error(err); } }, 60);
}
function cmdkActions() {
  const acts = [
    // Ações de criação — no topo pra achar rápido.
    { icon: 'plus',         label: 'Nova demanda',                  kind: 'Ação',     run: () => typeof openNewDemand === 'function' && openNewDemand() },
    { icon: 'plus',         label: 'Novo cliente',                  kind: 'Ação',     run: () => typeof openClientModal === 'function' && openClientModal(null) },
    { icon: 'plus',         label: 'Nova lista recorrente',         kind: 'Ação',     run: () => typeof openNovaListaModal === 'function' && openNovaListaModal() },
    // Navegação — telas principais
    { icon: 'gauge',        label: 'Ir para Dashboard',             kind: 'Navegar',  run: () => goPage('dashboard') },
    { icon: 'list',         label: 'Ir para Demandas',              kind: 'Navegar',  run: () => goPage('list') },
    { icon: 'user',         label: 'Ir para Minhas Demandas',       kind: 'Navegar',  run: () => goPage('mine') },
    { icon: 'bar-chart-3',  label: 'Ir para Capacidade',            kind: 'Navegar',  run: () => goPage('capacity') },
    { icon: 'calendar',     label: 'Ir para Agenda',                kind: 'Navegar',  run: () => goPage('agenda') },
    { icon: 'calendar',     label: 'Ir para Calendário (Demandas)', kind: 'Navegar',  run: () => { goPage('list'); setTimeout(() => typeof setListView === 'function' && setListView('calendar'), 50); } },
    { icon: 'kanban',       label: 'Ir para Kanban (Demandas)',     kind: 'Navegar',  run: () => { goPage('list'); setTimeout(() => typeof setListView === 'function' && setListView('kanban'), 50); } },
    { icon: 'building-2',   label: 'Ir para Clientes',              kind: 'Navegar',  run: () => goPage('clients') },
    { icon: 'folder',       label: 'Ir para Projetos',              kind: 'Navegar',  run: () => goPage('projects') },
    { icon: 'workflow',     label: 'Ir para Fluxos',                kind: 'Navegar',  run: () => goPage('flows') },
    { icon: 'refresh-ccw',  label: 'Ir para Recorrentes · Demandas',kind: 'Navegar',  run: () => { goPage('recurring'); setTimeout(() => typeof setRecurringTab === 'function' && setRecurringTab('demandas'), 30); } },
    { icon: 'list-checks',  label: 'Ir para Recorrentes · Listas',  kind: 'Navegar',  run: () => { goPage('recurring'); setTimeout(() => typeof setRecurringTab === 'function' && setRecurringTab('listas'), 30); } },
    { icon: 'file-text',    label: 'Ir para Templates',             kind: 'Navegar',  run: () => goPage('templates') },
    { icon: 'user-circle',  label: 'Ir para Perfil',                kind: 'Navegar',  run: () => goPage('profile') },
    { icon: 'info',         label: 'Ir para Documentação',          kind: 'Navegar',  run: () => goPage('docs') },
  ];
  // Admin-only.
  if (me?.isAdmin) {
    acts.push({ icon: 'users',    label: 'Ir para Usuários',     kind: 'Navegar', run: () => goPage('users') });
    acts.push({ icon: 'layers',   label: 'Ir para Workspaces',   kind: 'Navegar', run: () => goPage('workspaces') });
    acts.push({ icon: 'webhook',  label: 'Ir para Integrações',  kind: 'Navegar', run: () => goPage('integrations') });
  }
  acts.push({ icon: 'sun-moon',  label: 'Alternar tema (claro/escuro)', kind: 'Ação', run: () => typeof toggleTheme === 'function' && toggleTheme() });
  acts.push({ icon: 'panel-left',label: 'Alternar sidebar (colapsar)',  kind: 'Ação', run: () => typeof toggleSidebarCollapse === 'function' && toggleSidebarCollapse() });
  acts.push({ icon: 'keyboard',  label: 'Mostrar atalhos de teclado',   kind: 'Ação', run: () => showShortcutsHelp() });
  return acts;
}
function renderCommandPalette() {
  const input = document.getElementById('cmdk-input');
  const out = document.getElementById('cmdk-results');
  if (!input || !out) return;
  const q = (input.value || '').trim().toLowerCase();
  const allActions = cmdkActions();
  const acts = q
    ? allActions.filter(a => a.label.toLowerCase().includes(q))
    : allActions;
  let dems = [], projs = [], flws = [], usrs = [], clis = [], lstas = [], recs = [];
  if (q) {
    // Clientes — no topo (topo da hierarquia).
    clis = (Array.isArray(clients) ? clients : [])
      .filter(c => !activeWs || c.workspaceId === activeWs)
      .filter(c => c.name && c.name.toLowerCase().includes(q))
      .slice(0, 6)
      .map(c => {
        const projCount = projects.filter(p => p.clientId === c.id && p.active !== false).length;
        return {
          icon: 'building-2',
          label: c.name,
          kind: 'Cliente',
          sub: `${projCount} projeto${projCount === 1 ? '' : 's'}`,
          run: () => openClient(c.id)
        };
      });
    dems = (Array.isArray(demands) ? demands : [])
      .filter(d => !activeWs || d.workspaceId === activeWs)
      .filter(d => d.name && d.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map(d => ({
        icon: 'square',
        label: d.name,
        kind: 'Demanda',
        sub: (projectById(d.projectId)?.name || ''),
        run: () => showDetail(d.id)
      }));
    projs = (typeof wsProjects === 'function' ? wsProjects() : [])
      .filter(p => (p.name && p.name.toLowerCase().includes(q)) || (p.client && p.client.toLowerCase().includes(q)))
      .slice(0, 6)
      .map(p => ({
        icon: 'folder',
        label: p.name,
        kind: 'Projeto',
        sub: p.client || '',
        // Detalhe de projeto agora tem view própria — muito mais útil que o modal.
        run: () => (typeof openProjectDetail === 'function' ? openProjectDetail(p.id) : openProjectModal(p.id))
      }));
    // Listas recorrentes (templates apenas — instâncias aplicadas ficam ocultas).
    lstas = (Array.isArray(listas) ? listas : [])
      .filter(l => (!activeWs || l.workspaceId === activeWs) && !l.sourceListaId)
      .filter(l => l.name && l.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map(l => {
        const c = l.clientId ? clientById(l.clientId) : null;
        const p = l.projectId ? projectById(l.projectId) : null;
        const sub = c ? `${c.name}${p ? ` · ${p.name}` : ''}` : (p ? p.name : 'Geral');
        return {
          icon: 'list-checks',
          label: l.name,
          kind: 'Lista',
          sub,
          run: () => { goPage('recurring'); setTimeout(() => typeof setRecurringTab === 'function' && setRecurringTab('listas'), 30); }
        };
      });
    // Demandas recorrentes.
    recs = (Array.isArray(recurrings) ? recurrings : [])
      .filter(r => (!activeWs || r.workspaceId === activeWs))
      .filter(r => r.name && r.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map(r => {
        const c = r.clientId ? clientById(r.clientId) : null;
        const p = r.projectId ? projectById(r.projectId) : null;
        const sub = c ? `${c.name}${p ? ` · ${p.name}` : ''}` : (p ? p.name : '');
        return {
          icon: 'refresh-ccw',
          label: r.name,
          kind: 'Recorrente',
          sub,
          run: () => (typeof openRecurringModal === 'function' ? openRecurringModal(r.id) : goPage('recurring'))
        };
      });
    flws = (typeof wsFlows === 'function' ? wsFlows() : [])
      .filter(f => f.name && f.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map(f => ({
        icon: 'workflow',
        label: f.name,
        kind: 'Fluxo',
        sub: f.demandType || '',
        run: () => { if (me && me.isAdmin) openFlowModal(f.id); else goPage('flows'); }
      }));
    usrs = (typeof wsUsers === 'function' ? wsUsers() : [])
      .filter(u => (u.name && u.name.toLowerCase().includes(q)) || (u.username && u.username.toLowerCase().includes(q)))
      .slice(0, 5)
      .map(u => ({
        icon: 'user',
        label: u.name,
        kind: 'Usuário',
        sub: u.role || u.username || '',
        run: () => { if (me && me.isAdmin) openUserModal(u.id); else goPage('users'); }
      }));
  }
  cmdkResults = [...acts, ...clis, ...dems, ...projs, ...lstas, ...recs, ...flws, ...usrs];
  if (cmdkActiveIdx >= cmdkResults.length) cmdkActiveIdx = Math.max(0, cmdkResults.length - 1);
  if (!cmdkResults.length) {
    out.innerHTML = `<div class="cmdk-empty">Nada encontrado${q ? ` para "${esc(q)}"` : ''}</div>`;
    return;
  }
  let html = '';
  let idx = 0;
  const renderItem = (r) => {
    const active = idx === cmdkActiveIdx ? ' active' : '';
    const sub = r.sub ? `<span class="cmdk-item-sub"> · ${esc(r.sub)}</span>` : '';
    const item = `<div class="cmdk-item${active}" data-i="${idx}">
      <i data-lucide="${r.icon}" class="ic-sm cmdk-item-icon"></i>
      <span class="cmdk-item-label">${esc(r.label)}${sub}</span>
      <span class="cmdk-item-kind">${esc(r.kind)}</span>
    </div>`;
    idx++;
    return item;
  };
  const ENTITY_KINDS = ['Cliente','Demanda','Projeto','Lista','Recorrente','Fluxo','Usuário'];
  const sections = [
    { title: 'Ações & navegação', items: cmdkResults.filter(r => !ENTITY_KINDS.includes(r.kind)) },
    { title: 'Clientes',          items: cmdkResults.filter(r => r.kind === 'Cliente') },
    { title: 'Demandas',          items: cmdkResults.filter(r => r.kind === 'Demanda') },
    { title: 'Projetos',          items: cmdkResults.filter(r => r.kind === 'Projeto') },
    { title: 'Listas',            items: cmdkResults.filter(r => r.kind === 'Lista') },
    { title: 'Demandas recorrentes', items: cmdkResults.filter(r => r.kind === 'Recorrente') },
    { title: 'Fluxos',            items: cmdkResults.filter(r => r.kind === 'Fluxo') },
    { title: 'Usuários',          items: cmdkResults.filter(r => r.kind === 'Usuário') }
  ];
  for (const sec of sections) {
    if (!sec.items.length) continue;
    html += `<div class="cmdk-section">${sec.title}</div>`;
    sec.items.forEach(r => { html += renderItem(r); });
  }
  out.innerHTML = html;
  out.querySelectorAll('.cmdk-item').forEach(it => {
    it.addEventListener('mouseenter', () => { cmdkActiveIdx = parseInt(it.dataset.i, 10); paintCmdkActive(); });
    it.addEventListener('click', () => {
      const r = cmdkResults[parseInt(it.dataset.i, 10)];
      if (r) cmdkRun(r);
    });
  });
  paintIcons();
}
function showShortcutsHelp() {
  let el = document.getElementById('shortcuts-help');
  if (!el) {
    el = document.createElement('div');
    el.id = 'shortcuts-help';
    el.className = 'shortcuts-overlay';
    el.innerHTML = `
      <div class="shortcuts-card">
        <div class="shortcuts-head">
          <div class="shortcuts-title">Atalhos de teclado</div>
          <button class="modal-close" onclick="hideShortcutsHelp()" data-tooltip="Fechar"><i data-lucide="x" class="ic-sm"></i></button>
        </div>
        <div class="shortcuts-list">
          ${KB_SHORTCUTS.map(s => `<div class="shortcuts-row">
            <div class="shortcuts-keys">${s.keys.map(k => `<kbd>${esc(k)}</kbd>`).join('<span class="shortcuts-plus">depois</span>')}</div>
            <div class="shortcuts-label">${esc(s.label)}</div>
          </div>`).join('')}
        </div>
        <div class="shortcuts-hint">Atalhos não funcionam enquanto você digita em um campo.</div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', ev => { if (ev.target === el) hideShortcutsHelp(); });
  }
  el.classList.add('open');
  paintIcons();
}
function hideShortcutsHelp() {
  const el = document.getElementById('shortcuts-help');
  if (!el || !el.classList.contains('open')) return false;
  el.classList.remove('open');
  return true;
}

/* ─── TOOLTIPS GLOBAIS ───
   Substitui o tooltip nativo do navegador (cinza/feio) por um estilizado.
   Lê tanto data-tooltip="..." quanto title="..." (suprimindo o nativo). */
let _tooltipEl = null;
let _tooltipHover = null;
let _tooltipTimer = null;
function initTooltips() {
  if (_tooltipEl) return;
  _tooltipEl = document.createElement('div');
  _tooltipEl.className = 'tt';
  document.body.appendChild(_tooltipEl);

  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tooltip], [title]');
    if (t === _tooltipHover) return;
    // Sempre limpa o alvo anterior quando o cursor mudou — inclusive quando
    // vai pra área SEM tooltip. Cobre o caso do elemento ter saído do DOM
    // (re-render por SSE, ação do usuário) sem disparar mouseout, o que
    // deixava o tooltip travado apontando pra um elemento órfão.
    if (_tooltipHover) {
      if (_tooltipHover.dataset && _tooltipHover.dataset._tt !== undefined) {
        _tooltipHover.setAttribute('title', _tooltipHover.dataset._tt);
        delete _tooltipHover.dataset._tt;
      }
      _tooltipHover = null;
      clearTimeout(_tooltipTimer);
      hideTooltip();
    }
    if (!t) return;
    const text = t.getAttribute('data-tooltip') || t.getAttribute('title');
    if (!text || !text.trim()) return;
    if (t.hasAttribute('title')) {
      t.dataset._tt = t.getAttribute('title');
      t.removeAttribute('title');
    }
    _tooltipHover = t;
    clearTimeout(_tooltipTimer);
    _tooltipTimer = setTimeout(() => showTooltipFor(t, text), 350);
  });
  document.addEventListener('mouseout', e => {
    const t = e.target.closest('[data-tooltip], [data-_tt]');
    if (!t || t !== _tooltipHover) return;
    // Restaura title nativo se foi suprimido
    if (t.dataset._tt !== undefined) {
      t.setAttribute('title', t.dataset._tt);
      delete t.dataset._tt;
    }
    _tooltipHover = null;
    clearTimeout(_tooltipTimer);
    hideTooltip();
  });
  // Esconde em scroll/clique/blur
  window.addEventListener('scroll', hideTooltip, true);
  document.addEventListener('mousedown', hideTooltip);
}
function showTooltipFor(target, text) {
  if (!_tooltipEl) return;
  // Não mostra tooltip pra elemento que já saiu do DOM entre o mouseover e
  // o timer disparar (350ms de espera).
  if (!target.isConnected) { _tooltipHover = null; return; }
  _tooltipEl.textContent = text;
  const r = target.getBoundingClientRect();
  const x = Math.max(8, Math.min(window.innerWidth - 8, r.left + r.width / 2));
  let y = r.bottom + 8;
  // Se ficaria fora da viewport por baixo, mostra acima do elemento
  const flipUp = y + 36 > window.innerHeight;
  if (flipUp) y = r.top - 8;
  _tooltipEl.style.left = x + 'px';
  _tooltipEl.style.top = y + 'px';
  _tooltipEl.classList.toggle('above', flipUp);
  _tooltipEl.classList.add('open');
}
function hideTooltip() {
  if (_tooltipEl) _tooltipEl.classList.remove('open');
  clearTimeout(_tooltipTimer);
}

function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('open');
  paintIcons();
  // Auto-focus no primeiro campo editável do modal (input/textarea/select visível e habilitado).
  // Se algum open*() específico chamar .focus() depois, prevalece. Skip com data-no-autofocus.
  setTimeout(() => {
    if (!el.classList.contains('open')) return;
    if (el.dataset.noAutofocus) return;
    if (el.contains(document.activeElement) && document.activeElement !== document.body) return;
    const focusable = el.querySelector(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]), ' +
      'textarea:not([disabled]):not([readonly]), ' +
      'select:not([disabled])'
    );
    if (focusable) focusable.focus();
  }, 80);
}
const ROUTED_MODAL_IDS = ['detail-modal','demand-modal','project-modal','flow-modal','user-modal','webhook-modal','client-modal'];
function closeModal(id) {
  $(id).classList.remove('open');
  // Para o poll de quase-realtime quando o detalhe é fechado
  if (id === 'detail-modal' && typeof stopDetailPoll === 'function') stopDetailPoll();
  // Limpa hashes legados (#demand-xyz)
  if (id === 'detail-modal' && location.hash.startsWith('#demand-')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  // Modais com rota própria → ao fechar reescreve URL pro destino apropriado.
  // Se ainda houver outro modal roteado por trás (ex.: editou uma demanda
  // a partir do detalhe), volta pra URL desse modal. Senão, URL da página.
  if (ROUTED_MODAL_IDS.includes(id)) {
    const stillOpen = ROUTED_MODAL_IDS.find(mid => mid !== id && document.getElementById(mid)?.classList.contains('open'));
    if (stillOpen === 'detail-modal' && detailId) navReplace('/demands/' + detailId);
    else navReplace(currentPageUrl());
  }
}

/* ── Lucide Icons ── */
function ic(name, attrs) {
  const extra = attrs ? ' ' + Object.entries(attrs).map(([k,v]) => `${k}="${esc(v)}"`).join(' ') : '';
  return `<i data-lucide="${name}"${extra}></i>`;
}
function paintIcons() {
  if (typeof window !== 'undefined' && window.lucide && lucide.createIcons) {
    try { lucide.createIcons(); } catch (e) {}
  }
}
/* Auto-paint de ícones Lucide.
   Vários renderers montam HTML com <i data-lucide="X"> e às vezes esquecem
   de chamar paintIcons() depois — o <i> fica sem conteúdo (invisível) mas o
   onclick do wrapper continua funcionando. Este observer detecta inserções
   e repinta automaticamente, debounced via rAF pra não repintar em rajada. */
(function autoPaintIcons() {
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; paintIcons(); });
  };
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if ((node.matches && node.matches('i[data-lucide]')) ||
            (node.querySelector && node.querySelector('i[data-lucide]'))) {
          schedule();
          return;
        }
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();

/* ─── COLOR PICKER CUSTOM (16 swatches, design system) ─────────
   Substitui o input[type=color] nativo (que renderiza o picker do SO).
   Uso direto:
     <button type="button" class="color-swatch-trigger" style="background:#7A00FF"
             onclick="openColorPicker(this, (hex) => …)"></button>
   Pra wrapping de hidden input nativo:
     openColorPickerForInput(triggerEl, 'ws-color') — preserva oninput existente. */
const COLOR_PALETTE = [
  '#64748B', '#7A00FF', '#A855F7', '#EC4899',
  '#F43F5E', '#EF4444', '#F59E0B', '#EAB308',
  '#84CC16', '#22C55E', '#10B981', '#14B8A6',
  '#06B6D4', '#3B82F6', '#6366F1', '#0F172A'
];
let _cpPopover = null;
let _cpActiveTrigger = null;
let _cpOnSelect = null;

function _ensureColorPickerPopover() {
  if (_cpPopover) return _cpPopover;
  _cpPopover = document.createElement('div');
  _cpPopover.className = 'color-picker-popover';
  _cpPopover.innerHTML = '<div class="color-picker-grid">' +
    COLOR_PALETTE.map(c => `<button type="button" class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`).join('') +
    '</div>';
  document.body.appendChild(_cpPopover);
  _cpPopover.addEventListener('click', (e) => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    const hex = sw.dataset.color;
    if (_cpOnSelect) _cpOnSelect(hex);
    closeColorPicker();
  });
  // Click outside fecha
  document.addEventListener('mousedown', (e) => {
    if (!_cpPopover.classList.contains('open')) return;
    if (_cpPopover.contains(e.target)) return;
    if (_cpActiveTrigger && _cpActiveTrigger.contains(e.target)) return;
    closeColorPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _cpPopover.classList.contains('open')) closeColorPicker();
  });
  return _cpPopover;
}
function openColorPicker(triggerEl, onSelect, currentHex) {
  const pop = _ensureColorPickerPopover();
  _cpActiveTrigger = triggerEl;
  _cpOnSelect = onSelect;
  // Highlight selected
  pop.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('is-selected',
      (currentHex || '').toLowerCase() === (sw.dataset.color || '').toLowerCase());
  });
  // Posiciona embaixo do trigger
  const r = triggerEl.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.classList.add('open');
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
  pop.style.visibility = '';
  triggerEl.classList.add('is-open');
}
function closeColorPicker() {
  if (!_cpPopover) return;
  _cpPopover.classList.remove('open');
  if (_cpActiveTrigger) _cpActiveTrigger.classList.remove('is-open');
  _cpActiveTrigger = null;
  _cpOnSelect = null;
}
// Helper pra hidden input compat (preserva oninput/onchange existentes)
function openColorPickerForInput(triggerEl, inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  openColorPicker(triggerEl, (hex) => {
    input.value = hex;
    triggerEl.style.background = hex;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, input.value);
}
// Quando o modal abre com cor pré-existente, sincroniza o background do trigger.
function setColorValue(inputId, hex) {
  const v = hex || '#7A00FF';
  const input = document.getElementById(inputId);
  if (input) input.value = v;
  const trigger = document.querySelector(`.color-swatch-trigger[data-color-input="${inputId}"]`);
  if (trigger) trigger.style.background = v;
}

/* ─── LUCIDE ICON PICKER ───────────────────────────────────
   Modal com grid de TODOS os ícones do Lucide + search. Storage:
     - 'lucide:icon-name'  → ícone da biblioteca
     - 'data:image/...'    → upload do usuário (legacy/custom)
     - null                → placeholder. */
let _lucideAllNames = null;
let _lucidePickerOnPick = null;
let _lucidePickerRendered = false;

function getLucideAllNames() {
  if (_lucideAllNames) return _lucideAllNames;
  const lib = window.lucide || {};
  const src = lib.icons || {};
  // Cada chave de lucide.icons é o nome do ícone em kebab-case.
  // Fallback: filtra exports PascalCase do próprio window.lucide se .icons vazio.
  let names = Object.keys(src);
  if (!names.length) {
    names = Object.keys(lib).filter(k => /^[A-Z]/.test(k) && k !== 'XMLNS')
      .map(camelToKebab);
  }
  names.sort();
  _lucideAllNames = names;
  return names;
}
function camelToKebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

function openLucidePicker(currentIcon, onPick) {
  _lucidePickerOnPick = onPick;
  const grid = $('lucide-picker-grid');
  const currentName = (currentIcon || '').startsWith('lucide:') ? currentIcon.slice(7) : null;
  // Renderiza grid uma vez só (cache pra próxima abertura)
  if (!_lucidePickerRendered) {
    const names = getLucideAllNames();
    if (!names.length) {
      grid.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">Não foi possível carregar a biblioteca de ícones.</div>';
    } else {
      grid.innerHTML = names.map(n =>
        `<button type="button" class="lucide-picker-item" data-name="${esc(n)}" title="${esc(n)}" onclick="pickLucideIcon('${esc(n)}')"><i data-lucide="${esc(n)}"></i></button>`
      ).join('');
      paintIcons();
    }
    $('lucide-result-count').textContent = names.length;
    _lucidePickerRendered = true;
  }
  // Highlight da seleção atual
  grid.querySelectorAll('.lucide-picker-item').forEach(el => {
    el.classList.toggle('is-selected', el.dataset.name === currentName);
  });
  // Reset search
  const search = $('lucide-search');
  if (search) { search.value = ''; filterLucidePicker(); }
  openModal('lucide-picker-modal');
  setTimeout(() => search?.focus(), 80);
  // Scroll pro selecionado, se houver
  if (currentName) {
    setTimeout(() => {
      const sel = grid.querySelector('.lucide-picker-item.is-selected');
      if (sel) sel.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, 60);
  }
}
function filterLucidePicker() {
  const q = norm($('lucide-search').value || '');
  const items = $('lucide-picker-grid').querySelectorAll('.lucide-picker-item');
  let count = 0;
  items.forEach(el => {
    const match = !q || norm(el.dataset.name).includes(q);
    el.classList.toggle('hidden', !match);
    if (match) count++;
  });
  $('lucide-result-count').textContent = count;
}
function pickLucideIcon(name) {
  if (_lucidePickerOnPick) _lucidePickerOnPick('lucide:' + name);
  closeModal('lucide-picker-modal');
}
function handleLucidePickerUpload(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('Imagem excede 2MB.', 'error'); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    if (_lucidePickerOnPick) _lucidePickerOnPick(e.target.result);
    closeModal('lucide-picker-modal');
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}

/* Helper de render de ícone de fluxo — suporta os 3 formatos. */
function flowIconInnerHtml(icon, fallback) {
  if (!icon) return `<i data-lucide="${fallback || 'workflow'}" class="ic-sm"></i>`;
  if (typeof icon === 'string' && icon.startsWith('lucide:')) {
    return `<i data-lucide="${esc(icon.slice(7))}" class="ic-md"></i>`;
  }
  return '';
}
function flowIconBackgroundStyle(icon) {
  if (typeof icon === 'string' && icon.startsWith('lucide:')) return '';
  if (!icon) return '';
  return `background-image:url('${icon}');background-size:cover;background-position:center`;
}

/* ─────────── CUSTOM DATE / DATETIME PICKER ───────────
   Substitui o calendário e o seletor de hora nativos do navegador por um popup
   customizado que segue o design system. Para garantir que o picker nativo não
   apareça, os inputs <type=date> e <type=datetime-local> são convertidos para
   <type=text readonly> em tempo de execução, mantendo o formato de valor original.

   Formato do valor mantido por tipo:
     - date            → YYYY-MM-DD
     - datetime-local  → YYYY-MM-DDTHH:MM */
const FDP_MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
let fdpTarget = null;        // input atualmente vinculado ao picker
let fdpMode = 'date';        // 'date' | 'datetime'
let fdpViewDate = null;      // {year, month} mostrado no calendário
let fdpYearsMode = false;
let fdpSelectedDay = null;   // {year, month, day} — só commit ao OK no modo datetime

function fdpParse(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return {
    year: +m[1], month: +m[2] - 1, day: +m[3],
    hour: m[4] !== undefined ? +m[4] : 0,
    minute: m[5] !== undefined ? +m[5] : 0
  };
}
function fdpFormatDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function fdpFormatDateTime(year, month, day, hour, minute) {
  return `${fdpFormatDate(year, month, day)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
function fdpFormatDisplay(value, mode) {
  // Para exibição amigável no input "text" (dd/mm/aaaa ou dd/mm/aaaa HH:MM)
  const p = fdpParse(value);
  if (!p) return '';
  const d = `${String(p.day).padStart(2, '0')}/${String(p.month + 1).padStart(2, '0')}/${p.year}`;
  if (mode === 'datetime') return `${d} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return d;
}
function fdpTodayParts() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}
function fdpRenderGrid() {
  const grid = document.getElementById('fdp-grid');
  const title = document.querySelector('.fdp-title');
  const { year, month } = fdpViewDate;
  title.innerHTML = `${FDP_MONTHS[month]} de ${year} <i data-lucide="chevron-down" class="ic-xs"></i>`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev  = new Date(year, month, 0).getDate();
  const today = fdpTodayParts();
  // No modo datetime, a seleção é "pendente" (fdpSelectedDay) até clicar OK
  const selected = fdpMode === 'datetime' ? fdpSelectedDay : fdpParse(fdpTarget?._fdpValue || '');

  const cells = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ day: daysInPrev - i, month: month - 1, year: month === 0 ? year - 1 : year, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, month, year, other: false });
  while (cells.length < 42) {
    const last = cells[cells.length - 1];
    const next = new Date(last.year, last.month, last.day + 1);
    cells.push({ day: next.getDate(), month: next.getMonth(), year: next.getFullYear(), other: true });
  }

  grid.innerHTML = cells.map(c => {
    const isToday = c.day === today.day && c.month === today.month && c.year === today.year;
    const isSelected = selected && c.day === selected.day && c.month === selected.month && c.year === selected.year;
    const classes = ['fdp-day'];
    if (c.other) classes.push('other');
    if (isToday) classes.push('today');
    if (isSelected) classes.push('selected');
    return `<button type="button" class="${classes.join(' ')}" data-y="${c.year}" data-m="${c.month}" data-d="${c.day}">${c.day}</button>`;
  }).join('');
  paintIcons();
}
function fdpRenderYears() {
  const wrap = document.getElementById('fdp-years');
  const cur = fdpViewDate.year;
  const start = cur - 6, end = cur + 7;
  const today = fdpTodayParts();
  const html = [];
  for (let y = start; y <= end; y++) {
    const isCur = y === cur;
    const isToday = y === today.year;
    html.push(`<button type="button" class="fdp-year ${isCur ? 'selected' : ''} ${isToday ? 'today' : ''}" data-year="${y}">${y}</button>`);
  }
  wrap.innerHTML = html.join('');
}
function fdpToggleYears(force) {
  fdpYearsMode = force !== undefined ? force : !fdpYearsMode;
  document.getElementById('fdp-grid').style.display = fdpYearsMode ? 'none' : '';
  document.querySelector('.fdp-dow').style.display = fdpYearsMode ? 'none' : '';
  document.getElementById('fdp-years').style.display = fdpYearsMode ? '' : 'none';
  const timeBox = document.getElementById('fdp-time');
  if (timeBox) timeBox.style.display = (!fdpYearsMode && fdpMode === 'datetime') ? '' : 'none';
  if (fdpYearsMode) fdpRenderYears();
}
function fdpPositionNear(input) {
  const dp = document.getElementById('fluxo-datepicker');
  const r = input.getBoundingClientRect();
  dp.style.display = 'block';
  const dpRect = dp.getBoundingClientRect();
  const margin = 6;
  let top = r.bottom + margin + window.scrollY;
  let left = r.left + window.scrollX;
  if (r.bottom + dpRect.height + margin > window.innerHeight) {
    top = Math.max(8 + window.scrollY, r.top - dpRect.height - margin + window.scrollY);
  }
  if (left + dpRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - dpRect.width - 8);
  }
  dp.style.top = top + 'px';
  dp.style.left = left + 'px';
}
function fdpOpen(input) {
  if (input.disabled) return;
  fdpTarget = input;
  fdpMode = input.dataset.fdp === 'datetime' ? 'datetime' : 'date';
  const dp = document.getElementById('fluxo-datepicker');
  const okBtn = document.getElementById('fdp-ok');
  const timeBox = document.getElementById('fdp-time');
  // Botão OK só aparece no modo datetime (datepicker simples confirma direto ao clicar no dia)
  if (okBtn) okBtn.style.display = fdpMode === 'datetime' ? '' : 'none';
  if (timeBox) timeBox.style.display = fdpMode === 'datetime' ? '' : 'none';

  const parsed = fdpParse(input._fdpValue || '');
  const t = parsed || fdpTodayParts();
  fdpViewDate = { year: t.year, month: t.month };
  fdpSelectedDay = parsed ? { year: parsed.year, month: parsed.month, day: parsed.day } : null;
  if (fdpMode === 'datetime') {
    document.getElementById('fdp-h').value = String(t.hour).padStart(2, '0');
    document.getElementById('fdp-m').value = String(t.minute).padStart(2, '0');
  }
  fdpToggleYears(false);
  fdpRenderGrid();
  fdpPositionNear(input);
  dp.classList.add('open');
}
function fdpClose() {
  const dp = document.getElementById('fluxo-datepicker');
  dp.classList.remove('open');
  dp.style.display = 'none';
  fdpTarget = null;
}
function fdpCommit(value) {
  // Apenas atribui ISO via .value; nosso setter armazena em _fdpValue e atualiza o display
  if (!fdpTarget) return;
  fdpTarget.value = value || '';
  fdpTarget.dispatchEvent(new Event('input', { bubbles: true }));
  fdpTarget.dispatchEvent(new Event('change', { bubbles: true }));
}
function fdpClampTime(h, m) {
  h = parseInt(h, 10); m = parseInt(m, 10);
  if (!Number.isFinite(h)) h = 0;
  if (!Number.isFinite(m)) m = 0;
  return { h: Math.max(0, Math.min(23, h)), m: Math.max(0, Math.min(59, m)) };
}
function fdpReadTime() {
  return fdpClampTime(document.getElementById('fdp-h').value, document.getElementById('fdp-m').value);
}
function fdpWriteTime(h, m) {
  document.getElementById('fdp-h').value = String(h).padStart(2, '0');
  document.getElementById('fdp-m').value = String(m).padStart(2, '0');
}
function fdpSelectDay(year, month, day) {
  if (fdpMode === 'date') {
    fdpCommit(fdpFormatDate(year, month, day));
    fdpClose();
  } else {
    fdpSelectedDay = { year, month, day };
    fdpRenderGrid();
  }
}
function fdpInitGlobal() {
  const dp = document.getElementById('fluxo-datepicker');
  if (!dp || dp.dataset.bound) return;
  dp.dataset.bound = '1';

  // Não fecha o popup com mousedowns internos
  dp.addEventListener('mousedown', e => e.stopPropagation());

  // Cliques dentro do popup
  dp.addEventListener('click', e => {
    const day = e.target.closest('.fdp-day');
    const yr  = e.target.closest('.fdp-year');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (day) { fdpSelectDay(+day.dataset.y, +day.dataset.m, +day.dataset.d); return; }
    if (yr)  { fdpViewDate.year = +yr.dataset.year; fdpToggleYears(false); fdpRenderGrid(); return; }

    if (act === 'prev') {
      if (fdpYearsMode) { fdpViewDate.year -= 14; fdpRenderYears(); }
      else { fdpViewDate.month--; if (fdpViewDate.month < 0) { fdpViewDate.month = 11; fdpViewDate.year--; } fdpRenderGrid(); }
    } else if (act === 'next') {
      if (fdpYearsMode) { fdpViewDate.year += 14; fdpRenderYears(); }
      else { fdpViewDate.month++; if (fdpViewDate.month > 11) { fdpViewDate.month = 0; fdpViewDate.year++; } fdpRenderGrid(); }
    } else if (act === 'title') {
      fdpToggleYears();
    } else if (act === 'today') {
      const t = fdpTodayParts();
      if (fdpMode === 'date') {
        fdpCommit(fdpFormatDate(t.year, t.month, t.day));
        fdpClose();
      } else {
        fdpSelectedDay = { year: t.year, month: t.month, day: t.day };
        fdpWriteTime(t.hour, t.minute);
        fdpViewDate = { year: t.year, month: t.month };
        fdpRenderGrid();
      }
    } else if (act === 'clear') {
      fdpCommit('');
      fdpClose();
    } else if (act === 'ok') {
      if (!fdpSelectedDay) {
        // Se nada foi clicado mas o usuário quer confirmar a hora com a data atual, usa hoje
        const t = fdpTodayParts();
        fdpSelectedDay = { year: t.year, month: t.month, day: t.day };
      }
      const { h, m } = fdpReadTime();
      fdpCommit(fdpFormatDateTime(fdpSelectedDay.year, fdpSelectedDay.month, fdpSelectedDay.day, h, m));
      fdpClose();
    } else if (act === 'h-up' || act === 'h-down' || act === 'm-up' || act === 'm-down') {
      let { h, m } = fdpReadTime();
      if (act === 'h-up')   h = (h + 1) % 24;
      if (act === 'h-down') h = (h + 23) % 24;
      if (act === 'm-up')   m = (m + 5) % 60;  // passos de 5 minutos
      if (act === 'm-down') m = (m + 55) % 60;
      fdpWriteTime(h, m);
    }
  });

  // Aceita digitação direta nos campos de hora/minuto
  ['fdp-h', 'fdp-m'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      el.value = el.value.replace(/[^0-9]/g, '').slice(0, 2);
    });
    el.addEventListener('blur', () => {
      const max = id === 'fdp-h' ? 23 : 59;
      let v = parseInt(el.value, 10);
      if (!Number.isFinite(v)) v = 0;
      el.value = String(Math.max(0, Math.min(max, v))).padStart(2, '0');
    });
  });

  // Fecha ao clicar fora ou Esc
  document.addEventListener('mousedown', e => {
    if (!fdpTarget) return;
    if (e.target === fdpTarget) return;
    if (e.target.closest('#fluxo-datepicker')) return;
    fdpClose();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && fdpTarget) fdpClose();
  });

  // Reposiciona em resize/scroll
  window.addEventListener('resize', () => { if (fdpTarget) fdpPositionNear(fdpTarget); });
  window.addEventListener('scroll', () => { if (fdpTarget) fdpPositionNear(fdpTarget); }, true);

  // Converte os inputs nativos para "text" (bloqueando definitivamente o picker do navegador)
  fdpConvertAll();
  // Reaplica conversão a inputs criados dinamicamente (modais que são re-renderizados)
  new MutationObserver(() => fdpConvertAll()).observe(document.body, { childList: true, subtree: true });

  // Abre o popup ao clicar/focar num input convertido
  document.addEventListener('mousedown', e => {
    const input = e.target.closest('input[data-fdp]');
    if (!input || input.disabled) return;
    e.preventDefault();
    input.focus();
    fdpOpen(input);
  }, true);
  document.addEventListener('focus', e => {
    const input = e.target.closest && e.target.closest('input[data-fdp]');
    if (!input || input.disabled) return;
    fdpOpen(input);
  }, true);
}

// Captura o descritor original de HTMLInputElement.prototype.value para podermos
// escrever o texto exibido sem cair no nosso próprio setter (recursão).
const FDP_NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function fdpConvertAll() {
  // Converte qualquer <input type=date|datetime-local> ainda não tratado
  document.querySelectorAll('input[type="date"]:not([data-fdp]), input[type="datetime-local"]:not([data-fdp])').forEach(inp => {
    const mode = inp.type === 'datetime-local' ? 'datetime' : 'date';
    const isoVal = FDP_NATIVE_VALUE.get.call(inp); // valor original (ISO)
    inp.type = 'text';
    inp.setAttribute('readonly', 'readonly');
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('placeholder', mode === 'datetime' ? 'dd/mm/aaaa --:--' : 'dd/mm/aaaa');
    inp.dataset.fdp = mode;
    inp._fdpValue = isoVal || '';
    // Define o texto exibido (formatado) sem disparar nosso setter
    FDP_NATIVE_VALUE.set.call(inp, fdpFormatDisplay(inp._fdpValue, mode));
    // Sobrescreve .value: getter retorna ISO; setter aceita ISO e atualiza texto
    Object.defineProperty(inp, 'value', {
      configurable: true,
      get() { return this._fdpValue || ''; },
      set(v) {
        this._fdpValue = v || '';
        FDP_NATIVE_VALUE.set.call(this, fdpFormatDisplay(this._fdpValue, this.dataset.fdp));
      }
    });
  });
}

// Init no DOMReady
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fdpInitGlobal);
} else {
  fdpInitGlobal();
}

/* ── Modal de confirmação universal ── */
let _confirmResolve = null;
function showConfirm(opts) {
  const o = Object.assign({
    title: 'Confirmar ação',
    message: 'Tem certeza?',
    okLabel: 'Confirmar',
    cancelLabel: 'Cancelar',
    danger: false,
    kind: null, // 'danger' | 'warn' | 'info' | 'success' (auto: danger => 'danger')
  }, opts || {});
  $('confirm-title').textContent = o.title;
  $('confirm-message').innerHTML = o.message;
  const okBtn = $('confirm-ok-btn');
  okBtn.textContent = o.okLabel;
  okBtn.className = 'btn ' + (o.danger ? 'btn-danger' : 'btn-primary');
  // Ícone tematizado: injeta antes da mensagem se ainda não existe
  const kind = o.kind || (o.danger ? 'danger' : 'info');
  const ICONS = {
    danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    warn:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
  };
  const body = document.querySelector('#confirm-modal .modal-body');
  if (body) {
    let icon = body.querySelector('.confirm-icon');
    if (icon) icon.remove();
    icon = document.createElement('div');
    icon.className = 'confirm-icon is-' + kind;
    icon.innerHTML = ICONS[kind] || ICONS.info;
    body.insertBefore(icon, body.firstChild);
  }
  okBtn.focus();
  document.querySelector('#confirm-modal .modal-title').parentElement.parentElement
    .classList.toggle('modal-danger', !!o.danger);
  openModal('confirm-modal');
  return new Promise(res => { _confirmResolve = res; });
}
function confirmAccept() { closeModal('confirm-modal'); if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; } }
function confirmCancel() { closeModal('confirm-modal'); if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; } }

/* ── Prompt universal (entrada de texto) ── */
let _promptResolve = null;
function showPrompt(opts) {
  const o = Object.assign({ title: 'Informar', message: '', placeholder: '', defaultValue: '', okLabel: 'OK', type: 'text' }, opts || {});
  let p = document.getElementById('prompt-modal');
  if (!p) {
    p = document.createElement('div');
    p.id = 'prompt-modal';
    p.className = 'modal-overlay';
    p.innerHTML = `<div class="modal modal-sm" data-no-outside-close="1">
      <div class="modal-header"><div class="modal-title" id="prompt-title">Informar</div><button class="modal-close" onclick="promptCancel()"><i data-lucide="x" class="ic-sm"></i></button></div>
      <div class="modal-body">
        <div id="prompt-message" style="font-size:13px;color:var(--text-dim);margin-bottom:10px"></div>
        <input class="form-control" id="prompt-input" type="text">
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="promptCancel()">Cancelar</button>
        <button class="btn btn-primary" id="prompt-ok-btn" onclick="promptAccept()">OK</button>
      </div>
    </div>`;
    document.body.appendChild(p);
  }
  $('prompt-title').textContent = o.title;
  $('prompt-message').textContent = o.message;
  const inp = $('prompt-input');
  // Suporte a 'date' → converte pra fdp (fluxo-datepicker) e usa .value ISO.
  // Se já estava convertido (data-fdp), só reseta valor. Se troca de type,
  // remove marks anteriores e re-converte via fdpConvertAll().
  if (o.type === 'date') {
    if (inp.dataset.fdp !== 'date') {
      // Reverte pra native <input type="date"> pra o fdpConvertAll fazer o resto.
      delete inp.dataset.fdp;
      inp.removeAttribute('readonly');
      inp.type = 'date';
      if (typeof fdpConvertAll === 'function') fdpConvertAll();
    }
    inp.value = o.defaultValue || '';
  } else {
    // Voltando pra text — se tava fdp, tem que restaurar comportamento normal.
    if (inp.dataset.fdp) {
      // Descarta o descriptor customizado revertendo pra native type="text"
      delete inp.dataset.fdp;
      inp.removeAttribute('readonly');
      const desc = Object.getOwnPropertyDescriptor(inp, 'value');
      if (desc && desc.configurable) {
        try { delete inp.value; } catch {}
        Object.defineProperty(inp, 'value', Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'));
      }
      inp.type = 'text';
    }
    inp.placeholder = o.placeholder || '';
    inp.value = o.defaultValue || '';
  }
  $('prompt-ok-btn').textContent = o.okLabel;
  openModal('prompt-modal');
  setTimeout(() => { inp.focus(); if (o.type !== 'date') inp.select(); }, 80);
  inp.onkeydown = ev => { if (ev.key === 'Enter' && o.type !== 'date') promptAccept(); };
  return new Promise(res => { _promptResolve = res; });
}
function promptAccept() {
  const v = $('prompt-input').value.trim();
  closeModal('prompt-modal');
  if (_promptResolve) { _promptResolve(v); _promptResolve = null; }
}
function promptCancel() {
  closeModal('prompt-modal');
  if (_promptResolve) { _promptResolve(null); _promptResolve = null; }
}

/* ── Click fora do modal fecha (com proteção) ── */
function attemptCloseModal(id) {
  if (id === 'detail-modal' && hasUnsavedDetailEdits()) {
    showConfirm({
      title: 'Descartar alterações?',
      message: 'Você tem alterações pendentes não confirmadas. Se sair agora, elas serão perdidas.',
      okLabel: 'Descartar e fechar',
      danger: true
    }).then(ok => { if (ok) { discardDetailEdits(); closeModal('detail-modal'); } });
    return;
  }
  if (id === 'flow-modal' && flowModalDirty) {
    showConfirm({
      title: 'Descartar alterações?',
      message: 'Você tem alterações no fluxo que não foram salvas. Deseja sair sem salvar?',
      okLabel: 'Descartar e fechar',
      danger: true
    }).then(ok => { if (ok) { flowModalDirty = false; closeModal('flow-modal'); } });
    return;
  }
  closeModal(id);
}
document.addEventListener('click', ev => {
  const overlay = ev.target.closest('.modal-overlay');
  if (!overlay || !overlay.classList.contains('open')) return;
  if (ev.target !== overlay) return; // clicou no fundo, não no conteúdo
  const inner = overlay.querySelector('.modal');
  if (inner && inner.dataset.noOutsideClose === '1') return;
  attemptCloseModal(overlay.id);
}, true);
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-overlay.open')].pop();
  if (!open) return;
  const inner = open.querySelector('.modal');
  if (inner && inner.dataset.noOutsideClose === '1') return;
  attemptCloseModal(open.id);
});
document.addEventListener('click', e => {
  // fecha dropdowns customizados ao clicar fora
  document.querySelectorAll('.user-select.open').forEach(el => {
    if (!el.contains(e.target)) el.classList.remove('open');
  });
  const pop = $('mention-pop');
  if (pop && pop.classList.contains('open') && !pop.contains(e.target) && e.target.id !== 'comment-input') {
    pop.classList.remove('open');
  }
});

/* ─── SELECT DE USUÁRIO COM FOTO ─── */
function buildUserSelect(container, list, selectedId, onPick, placeholder = '— Sem responsável —') {
  container.classList.add('user-select');
  container.dataset.value = selectedId || '';
  const sorted = list.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const sel = selectedId ? userById(selectedId) : null;
  const btnLabel = sel
    ? `${avatarHTML(sel)}<span class="user-mini"><span class="user-mini-name">${esc(sel.name)}</span>${sel.role ? `<span class="user-mini-role">${esc(sel.role)}</span>` : ''}</span>`
    : `<span style="color:var(--text-muted)">${esc(placeholder)}</span>`;
  let opts = `<div class="user-select-opt ${!selectedId ? 'sel' : ''}" data-uid="">
      <div class="avatar" style="background:var(--surface-3);color:var(--text-muted)">—</div>
      <span class="user-mini"><span class="user-mini-name" style="color:var(--text-muted)">${esc(placeholder)}</span></span>
    </div>`;
  sorted.forEach(u => {
    opts += `<div class="user-select-opt ${u.id === selectedId ? 'sel' : ''}" data-uid="${u.id}">
      ${avatarHTML(u)}
      <span class="user-mini"><span class="user-mini-name">${esc(u.name)}</span>${u.role ? `<span class="user-mini-role">${esc(u.role)}</span>` : ''}</span>
    </div>`;
  });
  container.innerHTML = `
    <button type="button" class="user-select-btn">${btnLabel}<i data-lucide="chevron-down" class="ic-xs"></i></button>
    <div class="user-select-menu">${opts}</div>`;
  container.querySelector('.user-select-btn').onclick = e => {
    e.stopPropagation();
    document.querySelectorAll('.user-select.open').forEach(el => { if (el !== container) el.classList.remove('open'); });
    container.classList.toggle('open');
    if (container.classList.contains('open')) {
      // Auto-flip pra cima quando não cabe abaixo dentro do modal/host
      container.classList.remove('drop-up');
      const menu = container.querySelector('.user-select-menu');
      if (menu) {
        const rect = container.getBoundingClientRect();
        const scrollHost = container.closest('.modal-body') || container.closest('.modal') || document.documentElement;
        const hostRect = scrollHost.getBoundingClientRect ? scrollHost.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const bottomLimit = Math.min(hostRect.bottom, window.innerHeight);
        const topLimit = Math.max(hostRect.top, 0);
        const spaceBelow = bottomLimit - rect.bottom;
        const spaceAbove = rect.top - topLimit;
        const menuH = menu.scrollHeight || menu.offsetHeight || 0;
        if (spaceBelow < menuH + 12 && spaceAbove > spaceBelow) container.classList.add('drop-up');
      }
    }
  };
  container.querySelectorAll('.user-select-opt').forEach(opt => {
    opt.onclick = () => {
      const uid = opt.dataset.uid || '';
      container.classList.remove('open');
      buildUserSelect(container, list, uid || null, onPick, placeholder);
      if (onPick) onPick(uid || null);
    };
  });
}

/* ─── AUTENTICAÇÃO ─── */
async function doLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  $('login-error').textContent = '';
  if (!username || !password) { $('login-error').textContent = 'Informe usuário e senha.'; return; }
  try {
    const data = await api('/login', 'POST', { username, password });
    // O cookie httpOnly já foi setado pelo server. Só guardamos os dados do usuário.
    me = data.user;
    await enterApp();
  } catch (e) {
    $('login-error').textContent = e.message;
  }
}
async function doLogout() {
  try { await api('/logout', 'POST'); } catch {}
  forceLogout();
}
function forceLogout() {
  me = null;
  clearInterval(notifPollTimer);
  // Limpa qualquer resíduo do mecanismo antigo (fluxo_token em localStorage)
  try { localStorage.removeItem('fluxo_token'); } catch {}
  $('app').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('login-password').value = '';
}

/* ─── BANNER DE BOAS-VINDAS (primeiro login) ───
   Aparece uma vez por usuário. Flag em localStorage — o usuário limpar cache
   traz o banner de volta, o que é aceitável pra algo tão pequeno. */
function _welcomeKey() { return me && me.id ? 'kastor-welcome-seen-' + me.id : null; }
function maybeShowWelcomeBanner() {
  const key = _welcomeKey();
  const el = $('welcome-banner');
  if (!key || !el) return;
  let seen = false;
  try { seen = localStorage.getItem(key) === '1'; } catch {}
  if (seen) return;
  el.hidden = false;
}
function dismissWelcomeBanner() {
  const key = _welcomeKey();
  const el = $('welcome-banner');
  if (el) el.hidden = true;
  if (key) { try { localStorage.setItem(key, '1'); } catch {} }
}
function openDocsFromWelcome() {
  dismissWelcomeBanner();
  goPage('docs');
}

/* ─── TEMA (light/dark) ─── */
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  const lbl = document.getElementById('theme-toggle-label');
  if (lbl) lbl.textContent = t === 'light' ? 'Modo claro' : 'Modo escuro';
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
  // Troca só o logo da tela de login conforme o tema (preto no claro, branco no escuro).
  // A sidebar tem 3 variantes fixas no HTML (branco/preto/K icon) e o CSS decide qual
  // mostrar via seletores por (data-theme × sidebar-collapsed). Mexer no src daqui
  // sobrescrevia o Kastor_logo.svg com o wordmark, quebrando o estado colapsado.
  const loginLogoSrc = t === 'light' ? '/Kastor_preto.svg' : '/Kastor_branco.svg';
  document.querySelectorAll('.login-logo img').forEach(img => {
    if (img.getAttribute('src') !== loginLogoSrc) img.setAttribute('src', loginLogoSrc);
  });
}
function toggleTheme() {
  const current = localStorage.getItem('kastor-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('kastor-theme', next);
  applyTheme(next);
}
// Aplica o tema o mais cedo possível — antes do app render — para evitar flash
applyTheme(localStorage.getItem('kastor-theme') || 'dark');

async function boot() {
  // Estado do collapse da sidebar aplicado ANTES do render pra evitar flash.
  applySidebarCollapseInit();
  // Rota pré-autenticação: /reset/<token> abre a tela de reset de senha
  // (pública — sem auth nem app carregado).
  const resetMatch = location.pathname.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
  if (resetMatch) { showResetScreen(resetMatch[1]); return; }
  // Sem token em localStorage agora — tenta /me direto. Se cookie httpOnly
  // estiver válido, server devolve o user; senão 401 → forceLogout.
  try {
    me = await api('/me');
    await enterApp();
  } catch { forceLogout(); }
}

/* ─── FLUXO "ESQUECI MINHA SENHA" ───
   1. Link no login chama showForgotPassword → pergunta e-mail → POST /api/forgot-password
   2. Usuário recebe e-mail com /reset/<token>
   3. Boot detecta /reset/<token> e chama showResetScreen
   4. doResetPassword troca a senha e redireciona pro login */
async function showForgotPassword() {
  const email = await showPrompt({
    title: 'Esqueci minha senha',
    message: 'Informe o e-mail cadastrado no seu perfil. Se houver conta vinculada, vamos enviar um link para definir uma nova senha.',
    placeholder: 'voce@empresa.com',
    okLabel: 'Enviar link'
  });
  if (!email || !email.trim()) return;
  try {
    await api('/forgot-password', 'POST', { email: email.trim() });
    toast('Se o e-mail estiver cadastrado, você vai receber as instruções em alguns minutos. Confira também o spam.', 'success');
  } catch (e) {
    // 503 = SMTP não configurado — vale mostrar a mensagem real do server
    toast(e.message || 'Erro ao enviar', 'error');
  }
}
let _resetToken = null;
function showResetScreen(token) {
  _resetToken = token;
  // Esconde tudo e mostra só a tela de reset
  $('login-screen').style.display = 'none';
  $('app').style.display = 'none';
  $('reset-screen').classList.add('open');
  setTimeout(() => { const i = document.getElementById('reset-new-pass'); if (i) i.focus(); }, 60);
}
async function doResetPassword() {
  const p1 = $('reset-new-pass').value;
  const p2 = $('reset-confirm-pass').value;
  const err = $('reset-error');
  err.textContent = '';
  if (!p1 || p1.length < 6) { err.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
  if (p1 !== p2) { err.textContent = 'As senhas não conferem.'; return; }
  try {
    await api('/reset-password', 'POST', { token: _resetToken, newPassword: p1 });
    // Redireciona pro login com URL limpa
    history.replaceState(null, '', '/');
    location.reload();
  } catch (e) {
    err.textContent = e.message || 'Erro ao redefinir senha.';
  }
}

async function enterApp() {
  // Mostra a UI imediatamente com skeleton — usuário não vê tela em branco
  $('login-screen').style.display = 'none';
  $('app').style.display = 'flex';
  $('app').classList.add('active');
  initTooltips();
  initKeyboardShortcuts();
  $('topbar-title').textContent = 'Dashboard';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-dashboard'));
  if ($('metrics-grid')) $('metrics-grid').innerHTML = skeletonMetrics();
  if ($('list-table-body')) $('list-table-body').innerHTML = skeletonTableRows(9, 6);
  if ($('sidebar-uname')) $('sidebar-uname').innerHTML = '<span class="skeleton skeleton-line sm" style="display:inline-block;width:80px;height:11px;vertical-align:middle"></span>';

  await loadAll();

  renderSidebarUser();
  renderWsSwitch();
  dashUserInit = false;
  // Carrega rota inicial. Compat: links antigos #demand-<id> são migrados
  // pra /demands/<id> antes de aplicar a rota.
  const legacyHash = (location.hash || '').match(/^#demand-([A-Za-z0-9_-]+)/);
  if (legacyHash) {
    history.replaceState(null, '', '/demands/' + legacyHash[1] + location.search);
  }
  if (location.pathname === '/' || location.pathname === '/index.html') {
    goPage('dashboard');
  } else {
    applyRoute();
  }
  maybeShowWelcomeBanner();
  await fetchNotifications();
  startNotifPoll();
  startRealtimeSync(); // SSE — substitui polling agressivo de dados
  paintIcons();
}

async function loadAll() {
  const results = await Promise.all([
    api('/workspaces'), api('/users'), api('/clients'), api('/projects'),
    api('/flows'), api('/demands'), api('/roles'), api('/templates'),
    api('/webhooks').catch(() => []),
    api('/schedules').catch(() => []),
    api('/client-templates').catch(() => []),
    api('/recurrings').catch(() => []),
    api('/listas').catch(() => [])
  ]);
  [workspaces, users, clients, projects, flows, demands, roles, templates, webhooks, schedules, clientTemplates, recurrings, listas] = results;
  const allowed = workspaces.map(w => w.id);
  if (!activeWs || !allowed.includes(activeWs)) activeWs = allowed[0] || null;
  localStorage.setItem('fluxo_ws', activeWs || '');
}

async function fetchNotifications() {
  try { notifications = await api('/notifications'); } catch { notifications = []; }
  renderNotifBadge();
}
function startNotifPoll() {
  clearInterval(notifPollTimer);
  notifPollTimer = setInterval(fetchNotifications, 30000); // a cada 30s
}

async function refreshData() {
  await loadAll();
  renderWsSwitch();
  renderCurrent();
  fetchNotifications(); // atualiza notificações silenciosamente
}

/* ─── WORKSPACE SWITCH ─── */
function renderWsSwitch() {
  const wrap = $('ws-switch');
  wrap.classList.toggle('single', workspaces.length <= 1);
  const active = wsById(activeWs);
  const dot = $('ws-trigger-dot');
  const label = $('ws-trigger-label');
  const letter = $('ws-trigger-letter');
  if (dot) dot.style.background = active?.color || 'var(--accent)';
  if (label) label.textContent = active?.name || '—';
  // Letter tile mostrada no modo sidebar-collapsed — pega inicial do nome.
  if (letter) {
    letter.textContent = (active?.name || '?').charAt(0).toUpperCase();
    letter.style.background = active?.color || 'var(--accent)';
  }
  const menu = $('ws-cdrop-menu');
  if (menu) {
    const sorted = [...workspaces].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', 'pt-BR', { sensitivity: 'base' }));
    menu.innerHTML = sorted.map(w => `
      <div class="filter-cdrop-item ${w.id === activeWs ? 'active' : ''}" onclick="switchWorkspace('${w.id}')">
        <span class="pill-dot" style="background:${w.color || 'var(--accent)'}"></span>
        <span>${esc(w.name)}</span>
      </div>`).join('');
  }
  // Atualiza a faixa de cor do workspace ativo na sidebar
  document.documentElement.style.setProperty('--current-ws-color', active?.color || 'var(--accent)');
  paintIcons();
}
function switchWorkspace(id) {
  activeWs = id;
  localStorage.setItem('fluxo_ws', id);
  dashUserInit = false; // re-aplica filtro padrão do usuário no novo workspace
  // Fecha o dropdown do switcher
  const cdrop = $('ws-cdrop');
  if (cdrop) cdrop.classList.remove('open');
  renderWsSwitch();
  renderCurrent();
  toast('Workspace: ' + (wsById(id)?.name || ''), 'success');
}

/* ─── NAVEGAÇÃO ─── */
function renderSidebarUser() {
  // Mostra apenas o primeiro nome — sidebar compacta com o restante do design.
  const firstName = (me.name || '').split(/\s+/)[0] || me.name || '';
  $('sidebar-uname').textContent = firstName;
  // Mantém o id="sidebar-avatar" depois da substituição — regex pega qualquer
  // combinação de classes (avatar, avatar presence-online, etc) pra não quebrar
  // se avatarHTML virar a incluir mais classes (ex.: anel de presença).
  const av = $('sidebar-avatar');
  if (av) av.outerHTML = avatarHTML(me, 'avatar').replace(/class="([^"]+)"/, 'class="$1" id="sidebar-avatar"');
  // Classes de permissão no body pra gate visual das seções:
  //   user-readonly     → nem admin nem moderador (esconde .admin-only)
  //   user-moderator    → moderador (esconde .full-admin-only, mas vê .admin-only)
  //   admin (nenhuma)   → vê tudo
  document.body.classList.toggle('user-readonly', !me.isAdmin && !me.isModerator);
  document.body.classList.toggle('user-moderator', !!me.isModerator && !me.isAdmin);
}

/* Sidebar collapse — estado persistido em localStorage. */
function toggleSidebarCollapse() {
  const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('kastor-sidebar-collapsed', isCollapsed ? '1' : '0'); } catch {}
}
// Aplica estado inicial (chamado no boot).
function applySidebarCollapseInit() {
  try {
    if (localStorage.getItem('kastor-sidebar-collapsed') === '1') {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch {}
}

const PAGE_TITLES = {
  dashboard: 'Dashboard', list: 'Demandas', mine: 'Minhas Demandas',
  clients: 'Clientes', projects: 'Projetos', flows: 'Fluxos de Demanda',
  workspaces: 'Workspaces', users: 'Usuários', profile: 'Meu Perfil',
  capacity: 'Capacidade', templates: 'Templates', integrations: 'Integrações', agenda: 'Agenda',
  recurring: 'Listas de tarefas', docs: 'Documentação', clientsModels: 'Modelos de Cliente'
};
function goPage(page) {
  currentPage = page;
  // Cada entrada na página força um restoreFilters na próxima render.
  _markFiltersDirty(page);
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $('topbar-title').textContent = PAGE_TITLES[page] || '';
  renderCurrent();
  navPush(pageUrlFor(page));
  // Em mobile, fecha o menu lateral ao navegar pra uma página.
  closeSidebar();
}

/* ─── SIDEBAR MOBILE — slide-in com backdrop ───
   Em desktop a sidebar é fixa. Abaixo de ~880px ela vira off-canvas:
   o body ganha .menu-open, sidebar desliza pra dentro, backdrop intercepta clicks.
   Estado vive apenas em classList — sem persistência (sempre começa fechada). */
function toggleSidebar() {
  document.body.classList.toggle('menu-open');
}
function closeSidebar() {
  document.body.classList.remove('menu-open');
}
// Esc fecha o menu mobile quando aberto.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
    const anyModal = document.querySelector('.modal-overlay.open, #cmdk.open, #shortcuts-help.open');
    if (!anyModal) { e.preventDefault(); closeSidebar(); }
  }
});
function renderCurrent() {
  switch (currentPage) {
    case 'dashboard':  renderDashboard(); break;
    case 'list':       renderList(); renderCalendar('all'); break;
    case 'mine':       renderMine(); renderCalendar('mine'); break;
    case 'capacity':   renderCapacity(); break;
    case 'agenda':     renderAgenda(); break;
    case 'templates':  renderTemplates(); break;
    case 'recurring':  renderRecurring(); break;
    case 'integrations': renderIntegrations(); break;
    case 'docs':       break; /* iframe estático — nada pra renderizar */
    case 'clients': {
      // Decide entre grid, detalhe de cliente ou detalhe de projeto sem perder estado
      // quando refreshData() roda com um modal aberto (URL temporariamente em /projects/<id>/edit).
      const path = location.pathname;
      const isOnGridUrl = path === '/clients' || path === '/clients/';
      const clientDetailMatch = path.match(/^\/clients\/([^/]+)$/);
      const projectDetailMatch = path.match(/^\/projects\/([^/]+)$/);
      const reportMatch = path.match(/^\/clients\/([^/]+)\/report$/);
      const projectReportMatch = path.match(/^\/projects\/([^/]+)\/report$/);
      const clientDetailId = clientDetailMatch ? clientDetailMatch[1] : null;
      const projectDetailId = projectDetailMatch ? projectDetailMatch[1] : null;
      const reportId = reportMatch ? reportMatch[1] : null;
      const projectReportId = projectReportMatch ? projectReportMatch[1] : null;
      if (isOnGridUrl) {
        currentClientId = null;
        currentProjectId = null;
        renderClients();
      } else if (projectReportId && projectById(projectReportId)) {
        currentProjectId = projectReportId;
        const p = projectById(projectReportId);
        currentClientId = p?.clientId || null;
        showProjectReportView();
        renderProjectReport(projectReportId);
      } else if (reportId && clientById(reportId)) {
        currentClientId = reportId;
        showClientReportView();
        renderClientReport(reportId);
      } else if (projectDetailId && projectById(projectDetailId)) {
        currentProjectId = projectDetailId;
        showProjectDetailView();
        renderProjectDetail(projectDetailId);
      } else if (clientDetailId && clientById(clientDetailId)) {
        currentClientId = clientDetailId;
        currentProjectId = null;
        showClientDetailView();
        renderClientDetail(clientDetailId);
      } else if (currentProjectId && projectById(currentProjectId)) {
        // URL em outra rota (modal), preserva o detalhe de projeto que estava aberto
        showProjectDetailView();
        renderProjectDetail(currentProjectId);
      } else if (currentClientId && clientById(currentClientId)) {
        showClientDetailView();
        renderClientDetail(currentClientId);
      } else {
        renderClients();
      }
      break;
    }
    case 'clientsModels': {
      // Subtela dentro da página Clientes — mesmo container, view diferente.
      // O nav ativa 'clients'; forçamos aqui pra o item da sidebar refletir.
      document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === 'clients'));
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-clients'));
      $('topbar-title').textContent = 'Modelos de Cliente';
      showClientsModelsView();
      renderClientsModels();
      break;
    }
    case 'projects':   renderProjects(); break;
    case 'flows':      renderFlows(); break;
    case 'workspaces': renderWorkspaces(); break;
    case 'users':      renderUsers(); break;
    case 'profile':    renderProfile(); break;
  }
  paintIcons();
}

/* ─── FILTROS COMUNS ─── */
function fillSelect(sel, options, currentValue, firstLabel) {
  const prev = currentValue !== undefined ? currentValue : sel.value;
  const sorted = options.slice().sort((a, b) => norm(a.label).localeCompare(norm(b.label)));
  sel.innerHTML = `<option value="">${firstLabel}</option>` +
    sorted.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  if ([...sel.options].some(op => op.value === prev)) sel.value = prev;
}
function fillRoleSelect(selId, currentValue) {
  const sel = $(selId);
  const sorted = roles.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  sel.innerHTML = '<option value="">— Sem função —</option>' +
    sorted.map(r => `<option value="${esc(r.name)}" ${r.name === currentValue ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
}
function matchPeriod(dateStr, period, range) {
  if (!period) return true;
  // 'custom' usa range { start, end } explícito — start/end podem ser vazios
  // (só limita a extremidade preenchida). Sem nenhum dos dois → não filtra.
  if (period === 'custom') {
    const start = range?.start || '';
    const end = range?.end || '';
    if (!start && !end) return true;
    if (!dateStr) return false;
    const d = String(dateStr).slice(0, 10);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  }
  if (!dateStr) return false;
  const d = String(dateStr).slice(0,10);
  const now = new Date();
  const today = todayStr();
  if (period === 'today') return d === today;
  if (period === '7') {
    const lim = new Date(); lim.setDate(lim.getDate() + 7);
    return d >= today && d <= lim.toISOString().slice(0,10);
  }
  if (period === 'month') {
    const pref = today.slice(0,7);
    return d.startsWith(pref);
  }
  if (period === 'lastmonth') {
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const pref = `${lm.getFullYear()}-${String(lm.getMonth()+1).padStart(2,'0')}`;
    return d.startsWith(pref);
  }
  if (period === '90') {
    const lim = new Date(); lim.setDate(lim.getDate() - 90);
    return d >= lim.toISOString().slice(0,10) && d <= today;
  }
  return true;
}

/* ─── DASHBOARD ─── */
function dashDemandTypes() {
  return [...new Set(wsFlows().map(f => f.demandType).filter(Boolean))].sort();
}
function dashFilteredDemands() {
  const fu = $('dash-f-user').value;
  const fp = $('dash-f-period').value;
  const ft = $('dash-f-type').value;
  const fc = $('dash-f-client').value;
  return wsDemands().filter(d => {
    if (fu && d.ownerId !== fu) return false;
    if (!matchPeriod(effDue(d), fp)) return false;
    if (ft && demandType(d) !== ft) return false;
    if (fc) {
      const p = projectById(d.projectId);
      if (!p || p.client !== fc) return false;
    }
    return true;
  });
}
function clearDashFilters() {
  ['dash-f-user','dash-f-period','dash-f-type','dash-f-client'].forEach(id => $(id).value = '');
  renderDashboard();
}
/* ─── Widget "Meu dia" ───
   Foco pessoal no topo do dashboard: prazo hoje, atrasadas suas, menções não
   lidas. Sempre relativo ao usuário logado. Não respeita os filtros da tela. */
function renderMyDay() {
  const wrap = $('my-day-grid');
  if (!wrap || !me) return;
  const today = todayStr();
  // Escopo: demandas visíveis pro usuário (workspaces acessíveis), não deletadas,
  // não concluídas. "Suas" = ownerId === me.id OU watcher.
  const mine = (demands || []).filter(d => {
    if (d.deletedAt) return false;
    if (isDone(d)) return false;
    if (!(me.isAdmin || (me.workspaces || []).includes(d.workspaceId))) return false;
    if (d.ownerId === me.id) return true;
    if (Array.isArray(d.watchers) && d.watchers.includes(me.id)) return true;
    return false;
  });
  const dueToday = mine.filter(d => effDue(d) === today).slice(0, 20);
  const overdue  = mine.filter(d => isLate(d)).slice(0, 20);
  const mentionsUnread = (notifications || [])
    .filter(n => !n.read && n.type === 'mention')
    .slice(0, 20);

  const anyContent = dueToday.length + overdue.length + mentionsUnread.length > 0;
  // Se não há nada relevante, esconde totalmente — dashboard vira o de sempre.
  if (!anyContent) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  wrap.innerHTML = [
    _myDayCard('Prazo hoje', 'calendar-check', dueToday, _myDayDemandRow, 'Você não tem entregas pra hoje.'),
    _myDayCard('Atrasadas', 'alert-triangle', overdue, _myDayOverdueRow, 'Nada atrasado. ', 'danger'),
    _myDayCard('Menções não lidas', 'at-sign', mentionsUnread, _myDayMentionRow, 'Nenhuma menção nova.')
  ].join('');
  paintIcons();
}
function _myDayCard(title, icon, items, rowFn, empty, tone) {
  const rows = items.slice(0, 3).map(rowFn).join('');
  const more = items.length > 3
    ? `<div class="my-day-more">+ ${items.length - 3} mais</div>`
    : '';
  const body = items.length
    ? `<div class="my-day-items">${rows}${more}</div>`
    : `<div class="my-day-empty">${esc(empty)}</div>`;
  return `<div class="my-day-card ${tone ? 'is-' + tone : ''}">
    <div class="my-day-head">
      <span class="my-day-title"><i data-lucide="${icon}" class="ic-sm"></i> ${esc(title)}</span>
      <span class="my-day-count">${items.length}</span>
    </div>
    ${body}
  </div>`;
}
function _myDayDemandRow(d) {
  const p = projectById(d.projectId);
  const proj = p ? esc(p.name) : '—';
  return `<button type="button" class="my-day-row" onclick="showDetail('${esc(d.id)}')">
    <span class="my-day-row-name">${esc(d.name)}</span>
    <span class="my-day-row-sub">${proj}</span>
  </button>`;
}
function _myDayOverdueRow(d) {
  const due = effDue(d);
  const days = due ? Math.max(1, Math.floor((Date.now() - new Date(due + 'T00:00:00').getTime()) / 86400000)) : 0;
  return `<button type="button" class="my-day-row" onclick="showDetail('${esc(d.id)}')">
    <span class="my-day-row-name">${esc(d.name)}</span>
    <span class="my-day-row-sub">${days} dia${days === 1 ? '' : 's'} de atraso</span>
  </button>`;
}
function _myDayMentionRow(n) {
  const dName = n.demandName || 'demanda';
  return `<button type="button" class="my-day-row" onclick="openNotif('${esc(n.id)}', '${esc(n.demandId || '')}')">
    <span class="my-day-row-name">${esc(dName)}</span>
    <span class="my-day-row-sub">${esc(fmtDateTime(n.createdAt))}</span>
  </button>`;
}

function renderDashboard() {
  // Widget pessoal no topo — recalculado a cada re-render.
  renderMyDay();
  // selects de filtro (preservando seleção)
  fillSelect($('dash-f-user'), wsUsers().map(u => ({ value: u.id, label: u.name })), undefined, 'Todos os usuários');
  fillSelect($('dash-f-type'), dashDemandTypes().map(t => ({ value: t, label: t })), undefined, 'Todos os tipos');
  fillSelect($('dash-f-client'),
    [...new Set(wsProjects().map(p => p.client).filter(Boolean))].sort().map(c => ({ value: c, label: c })),
    undefined, 'Todos os clientes');

  // por padrão o dashboard abre filtrado para o usuário ativo
  if (!dashUserInit) {
    dashUserInit = true;
    if ([...$('dash-f-user').options].some(o => o.value === me.id)) $('dash-f-user').value = me.id;
  }

  // Filtros salvos da sessão anterior vencem o default acima (mas só na primeira
  // pintura do dashboard — depois disso o user já interagiu).
  restoreFilters('dashboard');

  ['dash-f-user','dash-f-period','dash-f-type','dash-f-client'].forEach(id => {
    $(id).classList.toggle('filtering', !!$(id).value);
  });

  // Estilizar os filtros como dropdowns customizados
  applyFilterDropdown('dash-f-user', { userIcon: true });
  applyFilterDropdown('dash-f-client');
  applyFilterDropdown('dash-f-period');
  applyFilterDropdown('dash-f-type');
  applyFilterDropdown('hours-f-period');

  const list = dashFilteredDemands();

  // Escopo COMPLETO do workspace (ignora filtros) — usado por Próximos 7 dias,
  // Em atraso, Radar de projetos. Esses widgets sempre olham "a partir de hoje"
  // independente do filtro de período. Filtro de cliente ainda aplica ao radar.
  const wsAll = wsDemands();

  // ── KPIs (respeitam filtros) ──
  const open = list.filter(d => !isDone(d));
  const late = list.filter(isLate);
  const ymNow = new Date().toISOString().slice(0,7);
  const doneMonth = list.filter(d => d.completedAt && d.completedAt.slice(0,7) === ymNow);
  let hoursMonth = 0;
  list.forEach(d => (d.timeEntries || []).forEach(e => {
    const when = ((e.start || e.createdAt || '') + '').slice(0,7);
    if (when === ymNow) hoursMonth += Number(e.hours) || 0;
  }));

  $('dash-kpis').innerHTML = `
    <div class="dash-kpi">
      <div class="dash-kpi-label">Em andamento</div>
      <div class="dash-kpi-value">${open.length}</div>
      <div class="dash-kpi-sub">demandas abertas no filtro</div>
    </div>
    <div class="dash-kpi ${late.length ? 'is-danger' : ''}">
      <div class="dash-kpi-label">Em atraso</div>
      <div class="dash-kpi-value">${late.length}</div>
      <div class="dash-kpi-sub">deadline vencido</div>
    </div>
    <div class="dash-kpi">
      <div class="dash-kpi-label">Entregues no mês</div>
      <div class="dash-kpi-value">${doneMonth.length}</div>
      <div class="dash-kpi-sub">${MONTHS[new Date().getMonth()]}</div>
    </div>
    <div class="dash-kpi">
      <div class="dash-kpi-label">Horas apontadas</div>
      <div class="dash-kpi-value">${fmtHours(hoursMonth)}</div>
      <div class="dash-kpi-sub">mês corrente</div>
    </div>
  `;
  animateCounters($('dash-kpis'));

  // ── Próximos 7 dias / Em atraso / Radar / Top responsáveis / Throughput ──
  renderDashNext7(wsAll);
  renderDashOverdue(wsAll);
  renderDashRadar();
  renderDashTopOwners(list);
  renderDashChart(list);
  renderHoursBoard(list);
  saveFilters('dashboard');
}

// ── Próximos 7 dias ── 7 pills horizontais, cada uma com contagem por dia
// baseada em effDue (prazo efetivo). Ignora completadas. Hover mostra lista.
function renderDashNext7(wsAll) {
  const el = $('dash-next7');
  const sub = $('dash-next7-sub');
  if (!el) return;
  const today0 = new Date(); today0.setHours(0,0,0,0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today0); d.setDate(d.getDate() + i);
    return d;
  });
  const ymd = (d) => d.toISOString().slice(0,10);
  // Nome do dia em maiúsculo completo: HOJE, AMANHÃ, DOMINGO, SEGUNDA, TERÇA…
  const dayLabel = (d, i) => {
    if (i === 0) return 'HOJE';
    if (i === 1) return 'AMANHÃ';
    const long = d.toLocaleDateString('pt-BR', { weekday: 'long' });
    // toLocaleDateString devolve "segunda-feira" — cortamos o "-feira" e uppercase.
    return long.replace(/-feira$/i, '').toUpperCase();
  };

  const open = wsAll.filter(d => !isDone(d));
  const byDay = new Map(days.map(d => [ymd(d), []]));
  open.forEach(d => {
    const due = effDue(d);
    if (!due) return;
    if (byDay.has(due)) byDay.get(due).push(d);
  });

  const maxCount = Math.max(1, ...[...byDay.values()].map(a => a.length));
  const total = [...byDay.values()].reduce((s, a) => s + a.length, 0);
  if (sub) sub.textContent = `${total} demanda${total === 1 ? '' : 's'} com prazo nos próximos 7 dias`;

  el.innerHTML = days.map((d, i) => {
    const items = byDay.get(ymd(d));
    const pct = items.length / maxCount;
    const level = items.length === 0 ? 0 : (pct > 0.66 ? 3 : pct > 0.33 ? 2 : 1);
    const preview = items.slice(0, 4).map(x => `<div class="dash-next7-item">${esc(x.name)}</div>`).join('')
      + (items.length > 4 ? `<div class="dash-next7-item dash-next7-item--more">+${items.length - 4} outras</div>` : '');
    const tooltip = items.length
      ? `<div class="dash-next7-tooltip">${preview}</div>`
      : '';
    return `<div class="dash-next7-pill dash-next7-lvl-${level} ${i === 0 ? 'is-today' : ''}"
                 onclick="goToDayInList('${ymd(d)}')">
      <div class="dash-next7-day">${esc(dayLabel(d, i))}</div>
      <div class="dash-next7-date">${d.getDate().toString().padStart(2, '0')}</div>
      <div class="dash-next7-count">${items.length}</div>
      ${tooltip}
    </div>`;
  }).join('');
}

// Filtro na tela de demandas por dia específico via deep-link ?due=YYYY-MM-DD.
// A URL fica compartilhável e sobrevive a refresh. Chip visível na barra de
// filtros permite remover o filtro sem editar a URL manualmente.
function goToDayInList(ymdStr) {
  // Preserva query params existentes; troca só o due.
  const url = '/demands?due=' + encodeURIComponent(ymdStr);
  history.pushState(null, '', url);
  goPage('list');
}
// Lê ?due da URL corrente. Retorna 'YYYY-MM-DD' ou null.
function currentDueFilter() {
  try {
    const u = new URL(location.href);
    const raw = u.searchParams.get('due');
    if (!raw) return null;
    // Valida formato pra não confiar cegamente na URL.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    return raw;
  } catch { return null; }
}
function clearDueFilter() {
  const u = new URL(location.href);
  u.searchParams.delete('due');
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  renderList();
}
// Chip visível na barra de filtros da tela de demandas quando ?due tá ativo.
// Botão X remove o filtro e reseta a URL.
function renderDueFilterChip() {
  const wrap = $('due-filter-chip-wrap');
  if (!wrap) return;
  const due = currentDueFilter();
  if (!due) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  const label = new Date(due + 'T12:00:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
  wrap.style.display = '';
  wrap.innerHTML = `<div class="due-filter-chip">
    <i data-lucide="calendar" class="ic-sm"></i>
    <span>Prazo em <strong>${esc(label)}</strong></span>
    <button type="button" class="due-filter-chip-close" onclick="clearDueFilter()" title="Remover filtro">
      <i data-lucide="x" class="ic-xs"></i>
    </button>
  </div>`;
  paintIcons();
}

// ── Em atraso — top 5 mais atrasadas (sempre a partir de hoje, ignora filtros) ──
function renderDashOverdue(wsAll) {
  const el = $('dash-overdue');
  const sub = $('dash-overdue-sub');
  if (!el) return;
  const overdue = wsAll.filter(isLate);
  const today0 = new Date(); today0.setHours(0,0,0,0);
  const withDelay = overdue.map(d => {
    const due = effDue(d);
    const dueD = due ? new Date(due) : null;
    const daysLate = dueD ? Math.floor((today0 - dueD) / 86400000) : 0;
    return { d, daysLate };
  }).sort((a, b) => b.daysLate - a.daysLate);

  if (sub) sub.textContent = `${overdue.length} demanda${overdue.length === 1 ? '' : 's'} com prazo vencido`;

  if (!overdue.length) {
    el.innerHTML = `<div class="dash-empty-inline">
      <i data-lucide="check-circle-2" class="ic-sm"></i>
      Nada atrasado.
    </div>`;
    paintIcons();
    return;
  }

  el.innerHTML = withDelay.slice(0, 5).map(({ d, daysLate }) => {
    const proj = projectById(d.projectId);
    const client = proj?.client || (proj?.clientId ? clientById(proj.clientId)?.name : '') || '';
    const owner = effectiveOwnerOf(d);
    const ownerHtml = owner
      ? `<div class="dash-overdue-owner">${avatarHTML(owner, 'avatar avatar-xs')} <span class="dash-overdue-owner-name">${esc(owner.name)}</span></div>`
      : `<div class="dash-overdue-owner dash-overdue-owner--empty"><i data-lucide="user-x" class="ic-xs"></i> <span>Sem responsável</span></div>`;
    // Meta: "Cliente · Projeto". Se um lado faltar, mostra só o outro.
    const metaParts = [];
    if (client) metaParts.push(esc(client));
    if (proj?.name) metaParts.push(esc(proj.name));
    const metaText = metaParts.join(' · ');
    return `<div class="dash-overdue-row" onclick="showDetail('${esc(d.id)}')">
      <div class="dash-overdue-days">
        <strong>${daysLate}</strong>
        <span>dia${daysLate === 1 ? '' : 's'}</span>
      </div>
      <div class="dash-overdue-body">
        <div class="dash-overdue-name">${esc(d.name)}</div>
        ${metaText ? `<div class="dash-overdue-meta">${metaText}</div>` : ''}
      </div>
      ${ownerHtml}
    </div>`;
  }).join('');
  paintIcons();
}

// ── Radar de projetos ── grid de cards com semáforo.
// Sem filtro de cliente: todos os projetos ativos do workspace, mostra qual cliente.
// Com filtro de cliente: só os projetos daquele cliente, sem repetir a identificação.
function renderDashRadar() {
  const el = $('dash-radar');
  const sub = $('dash-radar-sub');
  if (!el) return;
  const clientFilter = $('dash-f-client')?.value || '';
  const wsProjs = wsProjects().filter(p => p.active !== false);
  const shown = clientFilter
    ? wsProjs.filter(p => p.client === clientFilter)
    : wsProjs;

  if (sub) {
    sub.textContent = clientFilter
      ? `${shown.length} projeto${shown.length === 1 ? '' : 's'} de ${clientFilter}`
      : `${shown.length} projeto${shown.length === 1 ? '' : 's'} ativos`;
  }

  if (!shown.length) {
    el.innerHTML = `<div class="dash-empty-inline">Nenhum projeto ativo${clientFilter ? ` para ${esc(clientFilter)}` : ''}.</div>`;
    return;
  }

  // Semáforo: verde = 0 atrasadas, amarelo = até 20%, vermelho = >20%.
  const cards = shown.map(p => {
    const projDemands = demands.filter(d => d.projectId === p.id && !isDone(d));
    const overdue = projDemands.filter(isLate).length;
    const total = projDemands.length;
    const ratio = total > 0 ? overdue / total : 0;
    const status = overdue === 0 ? 'ok' : (ratio > 0.2 ? 'critical' : 'warn');
    const label = overdue === 0 ? 'Sem atrasos' : `${overdue} atrasada${overdue === 1 ? '' : 's'}`;
    const clientLabel = clientFilter ? '' : `<div class="dash-radar-client">${esc(p.client || '—')}</div>`;
    return `<div class="dash-radar-card dash-radar-${status}"
                 onclick="openProjectDetail('${esc(p.id)}')"
                 title="${esc(p.name)} · ${label} · ${total} demanda${total === 1 ? '' : 's'} abertas">
      <div class="dash-radar-body">
        <div class="dash-radar-name">${esc(p.name)}</div>
        ${clientLabel}
        <div class="dash-radar-meta">${total} aberta${total === 1 ? '' : 's'} · ${label}</div>
      </div>
    </div>`;
  });

  el.innerHTML = cards.join('');
}

// ── Top responsáveis ── entregas do mês por conclusão de etapa.
//
// Regra: um usuário ganha 1 entrega quando conclui SUA etapa em uma demanda.
// "Concluir" = existe stage_changed no histórico com details.fromId = stage.id
// no mês corrente. Contabiliza APENAS a PRIMEIRA etapa (em ordem do fluxo) em
// que o usuário é responsável naquela demanda — se ele estiver em várias
// etapas da mesma demanda, só a primeira conta.
function renderDashTopOwners(list) {
  const el = $('dash-top-owners');
  if (!el) return;
  const ymNow = new Date().toISOString().slice(0,7);
  const byUser = new Map();

  list.forEach(d => {
    const flow = flowById(d.flowId);
    if (!flow) return;
    const stages = activeStagesOf(d, flow); // ordem customizada da instância
    const stageChangeEvents = (d.history || []).filter(h => h.action === 'stage_changed' && h.details && h.details.fromId);
    const seenUsers = new Set();

    for (const stage of stages) {
      const uid = resolveStageOwnerId(d, stage);
      if (!uid) continue;
      if (seenUsers.has(uid)) continue; // usuário já contabilizado nesta demanda
      seenUsers.add(uid); // marca como "primeira etapa" mesmo se ainda não concluiu

      // Etapa concluída? Procura o PRIMEIRO stage_changed cuja fromId é ela.
      const evt = stageChangeEvents.find(h => h.details.fromId === stage.id);
      if (!evt) continue; // não concluída ainda → sem crédito
      if ((evt.at || '').slice(0,7) !== ymNow) continue; // outro mês

      byUser.set(uid, (byUser.get(uid) || 0) + 1);
    }
  });

  const rows = [...byUser.entries()]
    .map(([uid, n]) => ({ u: userById(uid), n }))
    .filter(x => x.u)
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  if (!rows.length) {
    el.innerHTML = `<div class="dash-empty-inline">Nenhuma entrega no mês.</div>`;
    return;
  }
  const max = Math.max(...rows.map(r => r.n));
  el.innerHTML = rows.map(r => {
    const pct = Math.round((r.n / max) * 100);
    return `<div class="dash-top-row">
      <div class="dash-top-user">${avatarHTML(r.u, 'avatar avatar-xs')} <span>${esc(r.u.name)}</span></div>
      <div class="dash-top-track"><div class="dash-top-fill" style="width:${pct}%"></div></div>
      <div class="dash-top-value">${r.n}</div>
    </div>`;
  }).join('');
}

/* Anima cada .metric-value de 0 até o número final usando easing.
   Guarda o último valor renderizado em data-last-value para só animar
   quando muda (assim filtros que mantêm o número não re-disparam). */
function animateCounters(scope) {
  if (!scope) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const els = scope.querySelectorAll('.metric-value');
  els.forEach(el => {
    const raw = (el.textContent || '').trim();
    const target = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    if (!Number.isFinite(target)) return;
    if (el.dataset.lastValue === String(target)) return;
    el.dataset.lastValue = String(target);
    if (target === 0 || reduced) { el.textContent = String(target); return; }
    const duration = 650;
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const v = Math.round(ease(t) * target);
      el.textContent = String(v);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = String(target);
    }
    requestAnimationFrame(tick);
  });
}
/* Throughput chart — 12 semanas de entregas, dividido em no prazo × atrasadas.
   Reaproveita attachChartHover (o tooltip a ser preservado).
   Independente dos filtros de período (sempre 12 semanas), mas respeita
   filtros de cliente/usuário/tipo pela `list` recebida. */
function renderDashChart(list) {
  const chartEl = $('dash-chart');
  if (!chartEl) return;

  // Buckets semanais começando na segunda-feira. 12 semanas retroativas.
  const t = new Date(); t.setHours(0,0,0,0);
  const dayOfWeek = t.getDay(); // 0 = domingo
  const daysToMonday = (dayOfWeek + 6) % 7;
  const currentMonday = new Date(t); currentMonday.setDate(t.getDate() - daysToMonday);
  const weeks = 12;
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(currentMonday); start.setDate(start.getDate() - i * 7);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    buckets.push({
      date: start, // usado pra label X no SVG abaixo
      ymdStart: start.toISOString().slice(0,10),
      ymdEnd: end.toISOString().slice(0,10),
      onTime: 0, late: 0
    });
  }
  list.forEach(d => {
    if (!d.completedAt) return;
    const compYmd = d.completedAt.slice(0,10);
    const b = buckets.find(bk => compYmd >= bk.ymdStart && compYmd <= bk.ymdEnd);
    if (!b) return;
    if (wasLate(d)) b.late++;
    else b.onTime++;
  });

  const lines = [
    { key: 'onTime', label: 'No prazo',  color: '#10b981' },
    { key: 'late',   label: 'Atrasadas', color: '#ef4444' },
  ];
  const visible = lines;
  const days = weeks; // reuso do nome de variável pelo bloco SVG abaixo

  // SVG dimensions (proporção wide para preencher melhor cards largos)
  const w = 1600, h = 360, pad = { t: 20, r: 30, b: 42, l: 50 };
  const innerW = w - pad.l - pad.r, innerH = h - pad.t - pad.b;
  // Y max
  let yMax = 0;
  visible.forEach(l => { buckets.forEach(b => { if (b[l.key] > yMax) yMax = b[l.key]; }); });
  yMax = Math.max(4, Math.ceil(yMax * 1.15));
  // Gridlines em 5 níveis
  const gridSteps = 5;
  const gridLevels = [];
  for (let i = 0; i <= gridSteps; i++) gridLevels.push(Math.round(yMax * i / gridSteps));

  // X positions
  const xAt = i => pad.l + (days <= 1 ? 0 : i * innerW / (days - 1));
  const yAt = v => pad.t + innerH - (v / yMax) * innerH;

  // Linhas retas com quebras secas (sem suavização) — fidelidade exata aos dados
  const smoothPath = (pts) => {
    if (pts.length < 2) return '';
    return 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L ');
  };

  // Linhas + área (só se for uma linha visível, mostra área; com múltiplas fica poluído)
  const showArea = visible.length === 1;
  const pathParts = visible.map(l => {
    const pts = buckets.map((b, i) => [xAt(i), yAt(b[l.key])]);
    const path = smoothPath(pts);
    let area = '';
    if (showArea) {
      const areaPts = pts.slice();
      const last = areaPts[areaPts.length - 1], first = areaPts[0];
      const baseY = pad.t + innerH;
      area = `<path d="${smoothPath(areaPts)} L ${last[0]} ${baseY} L ${first[0]} ${baseY} Z" fill="${l.color}" fill-opacity="0.1"/>`;
    }
    const dots = pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${l.color}" opacity="0.85"/>`).join('');
    return `${area}<path d="${path}" fill="none" stroke="${l.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');

  // X labels (mostra 6-8 marcadores)
  const maxLabels = 8;
  const labelStep = Math.max(1, Math.ceil(days / maxLabels));
  const xLabels = buckets.map((b, i) => {
    if (i % labelStep !== 0 && i !== days - 1) return '';
    const dd = String(b.date.getDate()).padStart(2, '0');
    const mm = String(b.date.getMonth() + 1).padStart(2, '0');
    return `<text x="${xAt(i)}" y="${h - 12}" fill="var(--text-muted)" font-size="11" text-anchor="middle">${dd}/${mm}</text>`;
  }).join('');

  // Y labels + gridlines
  const yEls = gridLevels.map(v => `
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${yAt(v)}" y2="${yAt(v)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" opacity="0.5"/>
    <text x="${pad.l - 10}" y="${yAt(v) + 4}" fill="var(--text-muted)" font-size="11" text-anchor="end">${v}</text>
  `).join('');

  // Marcadores e guide pra tooltip — invisíveis até o hover
  const markerEls = visible.map((l, i) =>
    `<circle id="dash-mk-${i}" r="5" fill="${l.color}" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke" style="opacity:0;pointer-events:none"/>`
  ).join('');
  const guideEl = `<line id="dash-guide" class="chart-guide" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + innerH}" stroke="rgba(255,255,255,0.35)" stroke-width="1" vector-effect="non-scaling-stroke" style="opacity:0;pointer-events:none"/>`;

  $('dash-chart').innerHTML = `
    <div class="chart-hover-host" id="dash-chart-host" style="position:relative">
      <svg viewBox="0 0 ${w} ${h}" class="dash-chart-svg" preserveAspectRatio="none">
        ${yEls}
        ${pathParts}
        ${xLabels}
        ${guideEl}
        ${markerEls}
      </svg>
      <div class="chart-tooltip" id="dash-chart-tooltip"></div>
    </div>`;

  // Wire hover — pra cada bucket, monta uma "série" com (y, value, color) por linha visível
  const tipPoints = buckets.map((b, i) => ({
    x: xAt(i),
    label: b.date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
    series: visible.map(l => ({ name: l.label, value: b[l.key], y: yAt(b[l.key]), color: l.color }))
  }));
  const host = $('dash-chart-host');
  if (host) {
    attachChartHover(host, {
      viewBox: { w, h, padL: pad.l, padR: pad.r, padT: pad.t, innerH },
      points: tipPoints,
      lineEls: $('dash-guide'),
      markerEls: visible.map((_, i) => $('dash-mk-' + i)),
      tooltipEl: $('dash-chart-tooltip'),
      format: (v) => String(v)
    });
  }
}

/* Quadro de apontamento de horas */
function renderHoursBoard(list) {
  const fu = $('dash-f-user').value;
  const hp = $('hours-f-period').value;
  // entradas de tempo das demandas filtradas; se houver filtro de usuário,
  // considera apenas as horas apontadas por ele
  const rows = [];
  list.forEach(d => (d.timeEntries || []).forEach(e => {
    if (fu && e.userId !== fu) return;
    if (hp && !matchPeriod(e.createdAt, hp)) return;
    rows.push({ demand: d, entry: e });
  }));
  const total = rows.reduce((acc, r) => acc + (Number(r.entry.hours) || 0), 0);

  // por etapa (label + cor resolvidos pelo fluxo da demanda)
  const byStage = new Map();
  rows.forEach(r => {
    const f = flowById(r.demand.flowId);
    const s = f ? f.stages.find(x => x.id === r.entry.stageId) : null;
    const key = s ? s.label : 'Outras';
    const cur = byStage.get(key) || { label: key, color: s ? s.color : '#64748B', hours: 0 };
    cur.hours += Number(r.entry.hours) || 0;
    byStage.set(key, cur);
  });
  const stages = [...byStage.values()].sort((a,b) => b.hours - a.hours);
  const maxStage = Math.max(1, ...stages.map(s => s.hours));

  // por demanda — quando há filtro de usuário, agrupa por demanda+usuário
  // para mostrar quem apontou. Caso contrário, agrupa só por demanda.
  const groupByUser = !!fu;
  const byDemand = new Map();
  rows.forEach(r => {
    const key = groupByUser ? `${r.demand.id}::${r.entry.userId || ''}` : r.demand.id;
    const cur = byDemand.get(key) || { d: r.demand, userId: r.entry.userId, hours: 0 };
    cur.hours += Number(r.entry.hours) || 0;
    byDemand.set(key, cur);
  });
  const dList = [...byDemand.values()].sort((a,b) => b.hours - a.hours);

  $('hours-board').innerHTML = `
    <div class="hours-card">
      <div class="hours-total"><span class="hours-total-value">${fmtHours(total)}</span><span class="hours-total-label">total apontado${fu ? ' por ' + esc(userById(fu)?.name || '') : ''} no filtro</span></div>
      ${stages.length ? stages.map(s => `
        <div class="hours-stage-row">
          <span class="hours-stage-name"><span class="pill-dot" style="background:${s.color}"></span>${esc(s.label)}</span>
          <span class="hours-stage-bar"><span class="hours-stage-fill" style="display:block;width:${s.hours/maxStage*100}%;background:${s.color}"></span></span>
          <span class="hours-stage-val">${fmtHours(s.hours)}</span>
        </div>`).join('') : '<div class="hours-empty">Nenhuma hora apontada nas demandas do filtro.</div>'}
    </div>
    <div class="hours-card">
      <div class="panel-title" style="margin-bottom:10px">Horas por demanda</div>
      ${dList.length ? dList.map(x => {
        const u = groupByUser ? userById(x.userId) : null;
        return `<div class="hours-demand-row">
          <span class="hours-demand-name" onclick="showDetail('${x.d.id}')">${esc(x.d.name)}</span>
          <span class="pill pill-muted" style="font-size:10px">${esc(projectById(x.d.projectId)?.name || '—')}</span>
          ${groupByUser ? `<span class="hours-demand-user">${u ? avatarHTML(u) + '<span>' + esc(u.name.split(' ')[0]) + '</span>' : '<span style="color:var(--text-muted)">—</span>'}</span>` : ''}
          <span class="hours-demand-val">${fmtHours(x.hours)}</span>
        </div>`;
      }).join('') : '<div class="hours-empty">Aponte horas dentro de uma demanda para vê-las aqui.</div>'}
    </div>`;
}

/* ─── DEMANDAS (LISTA GERAL) ─── */
function setListView(v) {
  listView = v;
  $('list-view-table').classList.toggle('active', v === 'table');
  $('list-view-kanban').classList.toggle('active', v === 'kanban');
  $('list-view-cal').classList.toggle('active', v === 'cal');
  $('list-table-view').style.display = v === 'table' ? '' : 'none';
  $('list-kanban-view').style.display = v === 'kanban' ? '' : 'none';
  $('list-cal-view').style.display = v === 'cal' ? '' : 'none';
  if (v === 'cal') renderCalendar('all');
  if (v === 'kanban') renderKanban();
}

/* ─── EXPORT CSV ─── */
/* Escape RFC 4180: qualquer célula com `,`, `"` ou quebra de linha vira "…"
   com aspas internas duplicadas. Números/null viram string vazia se nulos. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(headers, rows, filename) {
  // BOM UTF-8 pra Excel abrir com acentos certos. \r\n é padrão CSV.
  const bom = '﻿';
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  const csv = bom + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/* Exporta as demandas atualmente filtradas na página /demands. Respeita
   busca, filtros e workspace ativo — o mesmo conjunto que aparece na tela. */
function exportDemandsCsv() {
  const list = listFilteredDemands();
  if (!list.length) { toast('Não há demandas pra exportar com os filtros atuais.', 'warn'); return; }
  const headers = [
    'ID', 'Nome', 'Cliente', 'Projeto', 'Fluxo', 'Etapa atual',
    'Responsável', 'Prioridade', 'Prazo etapa', 'Prazo final',
    'Horas estimadas', 'Horas apontadas', 'Peças', 'Artes', 'Variações',
    'Criada em', 'Concluída em', 'Status'
  ];
  const rows = list.map(d => {
    const p = projectById(d.projectId);
    const cl = p ? (clients.find(c => c.id === p.clientId)?.name || p.client || '') : '';
    const f = flowById(d.flowId);
    const st = stageOf(d);
    const owner = userById(d.ownerId);
    const totalHours = (d.timeEntries || []).reduce((s, e) => s + (Number(e.hours) || 0), 0);
    return [
      d.id, d.name, cl, p?.name || '', f?.name || '', st?.label || '',
      owner?.name || '', priorityLabel(d.priority) || '',
      d.stageDueDate || '', d.deadline || '',
      d.estimatedHours ?? '', totalHours.toFixed(2),
      d.qtyPieces ?? 0, d.qtyArts ?? 0, d.qtyVariations ?? 0,
      (d.createdAt || '').slice(0, 10),
      (d.completedAt || '').slice(0, 10),
      d.completedAt ? 'Concluída' : (st?.done ? 'Concluída' : 'Em andamento')
    ];
  });
  const ymd = new Date().toISOString().slice(0, 10);
  downloadCsv(headers, rows, `kastor-demandas-${ymd}.csv`);
  toast(`${list.length} demanda${list.length === 1 ? '' : 's'} exportada${list.length === 1 ? '' : 's'}.`);
}

/* Exporta a visão atual de Capacidade (Equipe / Projeto / Cliente).
   Extrai as métricas direto do DOM renderizado (classes .capacity-row,
   .capacity-user-name, .capacity-stat) — garante que o CSV bate 1-pra-1
   com o que o usuário vê. Cada .capacity-stat gera 2 colunas (valor + label). */
function exportCapacityCsv() {
  const rowEls = document.querySelectorAll('#capacity-list .capacity-row');
  if (!rowEls.length) { toast('Não há dados de capacidade pra exportar.', 'warn'); return; }
  // Descobre quais métricas existem no primeiro row pra montar o header
  const firstStats = rowEls[0].querySelectorAll('.capacity-stat');
  const statLabels = [...firstStats].map(s => s.querySelector('.capacity-stat-label')?.textContent.trim() || 'métrica');
  const isTeam = capacityView === 'team';
  const nameCol = isTeam ? 'Usuário' : (capacityView === 'project' ? 'Projeto' : 'Cliente');
  const subCol = isTeam ? 'Função' : 'Detalhe';
  const headers = [nameCol, subCol, ...statLabels];
  if (isTeam) headers.push('Utilização');
  const rows = [];
  rowEls.forEach(row => {
    const name = row.querySelector('.capacity-user-name')?.textContent.trim() || '';
    const sub = row.querySelector('.capacity-user-role')?.textContent.trim() || '';
    const stats = [...row.querySelectorAll('.capacity-stat')].map(s => s.querySelector('.capacity-stat-value')?.textContent.trim() || '');
    const util = row.querySelector('.capacity-bar-label')?.childNodes[0]?.textContent.trim() || '';
    rows.push(isTeam ? [name, sub, ...stats, util] : [name, sub, ...stats]);
  });
  const ymd = new Date().toISOString().slice(0, 10);
  const label = { team: 'equipe', project: 'projetos', client: 'clientes' }[capacityView] || 'capacidade';
  downloadCsv(headers, rows, `kastor-capacidade-${label}-${ymd}.csv`);
  toast(`${rows.length} linha${rows.length === 1 ? '' : 's'} exportada${rows.length === 1 ? '' : 's'}.`);
}

/* ─── Popover do filtro Período (pfp) ───
   Substitui o select + inputs de data. Presets no topo + calendário com range
   selecionável embaixo + rodapé (Limpar/Hoje). Estado persistido nos 3 hidden
   inputs (#filter-period, #filter-period-start, #filter-period-end) — bate com
   FILTER_KEYS['list'] e é consumido inalterado por listFilteredDemands. */
const PFP_PRESETS = [
  { val: '',          label: 'Todo o período' },
  { val: 'today',     label: 'Hoje' },
  { val: '7',         label: 'Próximos 7 dias' },
  { val: 'month',     label: 'Este mês' },
  { val: 'lastmonth', label: 'Mês passado' },
  { val: '90',        label: 'Últimos 90 dias' }
];
const PFP_MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
let _pfpOpen = false;
let _pfpView = null; // { year, month } — mês visível no calendário

function togglePfp(evt) {
  if (evt) evt.stopPropagation();
  if (_pfpOpen) closePfp(); else openPfp();
}
function openPfp() {
  const pop = $('pfp-popover'); if (!pop) return;
  // Ponto de partida do mês visível: o start (se custom) ou hoje.
  const start = $('filter-period-start')?.value || '';
  const base = start ? new Date(start + 'T00:00:00') : new Date();
  _pfpView = { year: base.getFullYear(), month: base.getMonth() };
  pop.classList.add('open');
  _pfpOpen = true;
  pfpRenderPresets();
  pfpRenderCal();
  paintIcons();
}
function closePfp() {
  const pop = $('pfp-popover'); if (!pop) return;
  pop.classList.remove('open');
  _pfpOpen = false;
}
// Escuta cliques/Esc pra fechar. Cliques dentro do popover não fecham.
document.addEventListener('click', (e) => {
  if (!_pfpOpen) return;
  const pop = $('pfp-popover');
  const trg = $('pfp-trigger');
  if (pop && pop.contains(e.target)) return;
  if (trg && trg.contains(e.target)) return;
  closePfp();
});
document.addEventListener('keydown', (e) => {
  if (_pfpOpen && e.key === 'Escape') { e.preventDefault(); closePfp(); }
});

function pfpRenderPresets() {
  const wrap = $('pfp-presets'); if (!wrap) return;
  const cur = $('filter-period').value;
  wrap.innerHTML = PFP_PRESETS.map(p => `
    <button type="button" class="pfp-preset-btn ${p.val === cur && !pfpHasRange() ? 'active' : ''}" onclick="pfpPickPreset('${p.val}')">${esc(p.label)}</button>
  `).join('');
}
function pfpHasRange() {
  return !!($('filter-period-start')?.value || $('filter-period-end')?.value);
}
function pfpRenderCal() {
  const grid = $('pfp-cal-grid');
  const title = $('pfp-cal-title');
  if (!grid || !title || !_pfpView) return;
  const { year, month } = _pfpView;
  title.textContent = `${PFP_MONTHS[month]} · ${year}`;

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev  = new Date(year, month, 0).getDate();

  const startISO = $('filter-period-start').value || '';
  const endISO   = $('filter-period-end').value || '';
  const todayISO = todayStr();

  // Monta 42 células (6 semanas) — leadings do mês anterior + mês atual + trailings.
  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: daysInPrev - i, month: month - 1, year: month === 0 ? year - 1 : year, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, month, year, other: false });
  while (cells.length < 42) {
    const last = cells[cells.length - 1];
    const nxt = new Date(last.year, last.month, last.day + 1);
    cells.push({ day: nxt.getDate(), month: nxt.getMonth(), year: nxt.getFullYear(), other: true });
  }

  grid.innerHTML = cells.map(c => {
    const iso = `${c.year}-${String(c.month + 1).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
    const cls = ['pfp-day'];
    if (c.other) cls.push('other');
    if (iso === todayISO) cls.push('today');
    if (startISO && endISO) {
      if (iso === startISO && iso === endISO) cls.push('range-single');
      else if (iso === startISO) cls.push('range-start');
      else if (iso === endISO)   cls.push('range-end');
      else if (iso > startISO && iso < endISO) cls.push('range-mid');
    } else if (startISO && iso === startISO) {
      cls.push('range-single');
    }
    return `<button type="button" class="${cls.join(' ')}" data-iso="${iso}" onclick="pfpPickDay('${iso}')">${c.day}</button>`;
  }).join('');
}
function pfpNav(delta) {
  if (!_pfpView) return;
  _pfpView.month += delta;
  if (_pfpView.month < 0)  { _pfpView.month = 11; _pfpView.year--; }
  if (_pfpView.month > 11) { _pfpView.month = 0;  _pfpView.year++; }
  pfpRenderCal();
  paintIcons();
}
function pfpPickPreset(val) {
  // Preset limpa o range custom (mutuamente exclusivos).
  $('filter-period').value = val || '';
  $('filter-period-start').value = '';
  $('filter-period-end').value = '';
  closePfp();
  pfpUpdateTriggerLabel();
  renderList();
}
function pfpPickDay(iso) {
  const startEl = $('filter-period-start');
  const endEl = $('filter-period-end');
  const start = startEl.value, end = endEl.value;
  // Ciclo: (1) nada selecionado → define start; (2) só start → define end (ou reinicia
  // se o clique for antes do start); (3) range completo → reinicia com o novo start.
  let newStart, newEnd, done = false;
  if (!start || (start && end)) {
    newStart = iso; newEnd = '';
  } else if (iso < start) {
    newStart = iso; newEnd = '';
  } else {
    newStart = start; newEnd = iso; done = true;
  }
  startEl.value = newStart;
  endEl.value = newEnd;
  $('filter-period').value = 'custom';
  pfpRenderPresets();
  pfpRenderCal();
  pfpUpdateTriggerLabel();
  if (done) closePfp();
  renderList();
}
function pfpClear() {
  $('filter-period').value = '';
  $('filter-period-start').value = '';
  $('filter-period-end').value = '';
  pfpRenderPresets();
  pfpRenderCal();
  pfpUpdateTriggerLabel();
  renderList();
}
function pfpToday() {
  // Só volta o mês visível pra o atual — não altera filtro nem seleção.
  const t = new Date();
  _pfpView = { year: t.getFullYear(), month: t.getMonth() };
  pfpRenderCal();
  paintIcons();
}
function pfpUpdateTriggerLabel() {
  const trg = $('pfp-trigger'); if (!trg) return;
  const lbl = $('pfp-label');
  const p = $('filter-period').value;
  const s = $('filter-period-start').value;
  const e = $('filter-period-end').value;
  let text = 'Todo o período';
  const isFiltering = !!p;
  if (p === 'custom') {
    if (s && e) text = `${fmtPfpShort(s)} → ${fmtPfpShort(e)}`;
    else if (s)  text = `${fmtPfpShort(s)} → …`;
    else         text = 'Personalizado';
  } else if (p) {
    text = PFP_PRESETS.find(x => x.val === p)?.label || 'Período';
  }
  if (lbl) lbl.textContent = text;
  trg.classList.toggle('filtering', isFiltering);
}
function fmtPfpShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso;
  const mo = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][parseInt(m[2],10)-1];
  return `${parseInt(m[3], 10)} ${mo}`;
}
function pfpSyncFromInputs() {
  pfpUpdateTriggerLabel();
  if (_pfpOpen) { pfpRenderPresets(); pfpRenderCal(); }
}

/* Chip toggle "Status" (Abertas / Concluídas / Todas) da página Demandas.
   O <input type="hidden" id="filter-quick"> é a fonte de verdade — mantém
   compat com listFilteredDemands() e a persistência FILTER_KEYS['list']. */
function setDemandStatusFilter(v) {
  const inp = document.getElementById('filter-quick');
  if (!inp) return;
  inp.value = v || '';
  syncDemandStatusChip();
  renderList();
}
function syncDemandStatusChip() {
  const inp = document.getElementById('filter-quick');
  if (!inp) return;
  const v = inp.value || '';
  document.querySelectorAll('.demand-status-toggle .client-status-btn[data-status]')
    .forEach(b => b.classList.toggle('active', b.dataset.status === v));
}

function listFilteredDemands() {
  const q  = norm($('search-input').value.trim());
  const fu = $('filter-user').value;
  const fp = $('filter-project').value;
  const fc = $('filter-client')?.value || '';
  const fd = $('filter-period').value;
  const fdRange = fd === 'custom'
    ? { start: $('filter-period-start')?.value || '', end: $('filter-period-end')?.value || '' }
    : null;
  const fq = $('filter-quick').value;
  const due = currentDueFilter(); // ?due=YYYY-MM-DD via URL (deep-link do dashboard)
  return wsDemands().filter(d => {
    if (q && !norm(d.name).includes(q)) return false;
    if (fu && d.ownerId !== fu) return false;
    if (fp && d.projectId !== fp) return false;
    // Filtro por cliente: casa pelo clientId do projeto da demanda.
    if (fc) {
      const proj = projectById(d.projectId);
      if (!proj || proj.clientId !== fc) return false;
    }
    if (!matchPeriod(effDue(d), fd, fdRange)) return false;
    // ?due tem precedência sobre o range de período — filtra pra exatamente aquele dia.
    if (due && effDue(d) !== due) return false;
    if (fq === 'late' && !isLate(d)) return false;
    if (fq === 'open' && isDone(d)) return false;
    if (fq === 'done' && !isDone(d)) return false;
    return true;
  });
}

function renderList() {
  // Aplica filtros salvos da sessão anterior ANTES de capturar o valor atual
  // (o rebuild dos options abaixo respeita o value setado aqui via prevUser).
  restoreFilters('list');
  // User filter with avatars
  const prevUser = $('filter-user').value;
  const userOpts = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('filter-user').innerHTML = '<option value="">Usuário</option>' +
    userOpts.map(u => `<option value="${esc(u.id)}" ${u.id === prevUser ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  fillSelect($('filter-project'), wsProjects().map(p => ({ value: p.id, label: p.name })), undefined, 'Projeto');
  // Filtro de cliente do workspace atual (só ativos, ordenados alfabeticamente).
  const wsClientList = (clients || [])
    .filter(c => c.workspaceId === activeWs && c.active !== false)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  fillSelect($('filter-client'), wsClientList.map(c => ({ value: c.id, label: c.name })), undefined, 'Cliente');

  applyFilterDropdown('filter-user', { userIcon: true });
  applyFilterDropdown('filter-client', { clientIcon: true });
  applyFilterDropdown('filter-project', { projectIcon: true });
  // filter-period agora é hidden input controlado pelo popover pfp — sincroniza
  // label do trigger + estado visual do popover (caso esteja aberto).
  pfpSyncFromInputs();
  // filter-quick agora é um input hidden alimentado pelo chip toggle "Status".
  // Sincroniza o .active dos botões a partir do value (importante após restore).
  syncDemandStatusChip();
  renderDueFilterChip();

  const list = listFilteredDemands().slice().sort((a,b) => {
    let va, vb;
    if (sortKey === 'name')           { va = norm(a.name); vb = norm(b.name); }
    else if (sortKey === 'project')   { va = norm(projectById(a.projectId)?.name || ''); vb = norm(projectById(b.projectId)?.name || ''); }
    else if (sortKey === 'client')    { va = norm(projectById(a.projectId)?.client || ''); vb = norm(projectById(b.projectId)?.client || ''); }
    else if (sortKey === 'type')      { va = norm(demandType(a) || ''); vb = norm(demandType(b) || ''); }
    else if (sortKey === 'status')    { const fa = flowById(a.flowId), fb = flowById(b.flowId); const ea = fa ? activeStagesOf(a, fa) : []; const eb = fb ? activeStagesOf(b, fb) : []; va = ea.findIndex(s => s.id === a.status); vb = eb.findIndex(s => s.id === b.status); if (va === -1) va = 999; if (vb === -1) vb = 999; }
    else if (sortKey === 'owner')     { va = norm(userById(a.ownerId)?.name || ''); vb = norm(userById(b.ownerId)?.name || ''); }
    else if (sortKey === 'completed') { va = a.completedAt || '9999'; vb = b.completedAt || '9999'; }
    else if (sortKey === 'priority')  { va = a.priority || 3; vb = b.priority || 3; }
    else if (sortKey === 'qty')       { va = (a.qtyArts || 0); vb = (b.qtyArts || 0); }
    else                              { va = effDue(a) || '9999'; vb = effDue(b) || '9999'; }
    return (va < vb ? -1 : va > vb ? 1 : 0) * (sortAsc ? 1 : -1);
  });

  // Limpa seleções "fantasma" (IDs que não estão mais visíveis no filtro atual).
  // Sem isso o contador mostra "5 selecionadas" e as bulk actions agem em demandas
  // que o usuário não vê — confuso. Se alguém quiser reincluir, basta marcar de novo.
  if (selectedDemandIds && selectedDemandIds.size) {
    const visibleIds = new Set(list.map(d => d.id));
    for (const id of [...selectedDemandIds]) {
      if (!visibleIds.has(id)) selectedDemandIds.delete(id);
    }
  }

  if (!list.length) {
    $('list-table-body').innerHTML = `<tr><td colspan="11">${emptyState('Nenhuma demanda encontrada', 'Ajuste a busca ou os filtros para encontrar o que procura.', 'search')}</td></tr>`;
    if (listView === 'kanban') renderKanban();
    if (listView === 'cal') renderCalendar('all');
    refreshBulkBar();
    saveFilters('list');
    return;
  }
  $('list-table-body').innerHTML = list.map(d => {
    const p = projectById(d.projectId);
    const due = effDue(d);
    const sel = selectedDemandIds.has(d.id);
    return `<tr class="demand-row ${sel ? 'selected' : ''}" data-demand-id="${d.id}" onclick="onDemandRowClick(event, '${d.id}')">
      <td class="col-bulk-check"><input type="checkbox" class="bulk-check-row" ${sel ? 'checked' : ''} onclick="event.stopPropagation();toggleDemandSelection('${d.id}', this.checked)"></td>
      <td><span class="demand-name">${esc(d.name)}</span></td>
      <td>${p ? esc(p.name) : '—'}</td>
      <td>${esc(p?.client || '—')}</td>
      <td>${esc(demandType(d) || '—')}</td>
      <td>${statusPill(d)}</td>
      <td>${cellUser(userById(d.ownerId))}</td>
      <td class="${isLate(d) ? 'deadline-late' : ''}">${fmtDate(due)}${isLate(d) ? ' <i data-lucide="alert-triangle" class="ic-sm"></i>' : ''}</td>
      <td>${priorityPill(d.priority)}</td>
      <td>${qtyCell(d)}</td>
      <td>${d.completedAt ? fmtDate(d.completedAt) : '—'}</td>
    </tr>`;
  }).join('');
  if (listView === 'kanban') renderKanban();
  if (listView === 'cal') renderCalendar('all');
  refreshBulkBar();
  saveFilters('list');
}
function sortList(key) {
  if (sortKey === key) sortAsc = !sortAsc; else { sortKey = key; sortAsc = true; }
  renderList();
}
// Versão debounced só pro campo de busca — evita rebuild da tabela em cada
// tecla. Cliques em selects e botões continuam usando renderList() direto.
// Exposta em window porque é chamada via oninput="…" inline no HTML, e const
// no top-level NÃO vira propriedade de window (diferente de function/var).
window.renderListDebounced = debounce(renderList, 120);

/* ─── KANBAN ─── */
/* Comparador estável para a ordem dentro de uma coluna. Demandas com
   kanbanOrder definido aparecem primeiro, ordenadas por esse valor crescente.
   As demais caem para o critério antigo (prioridade asc). */
function kanbanSort(a, b) {
  const ka = (a.kanbanOrder === null || a.kanbanOrder === undefined) ? null : Number(a.kanbanOrder);
  const kb = (b.kanbanOrder === null || b.kanbanOrder === undefined) ? null : Number(b.kanbanOrder);
  if (ka !== null && kb !== null) return ka - kb;
  if (ka !== null) return -1;
  if (kb !== null) return 1;
  return (a.priority || 3) - (b.priority || 3);
}
function renderKanban() {
  const board = $('kanban-board');
  if (!board) return;
  const flowFilter = $('filter-flow')?.value || '';
  const list = listFilteredDemands().slice().sort(kanbanSort);

  let columns;
  if (flowFilter) {
    // Modo "fluxo único": colunas = etapas do fluxo na ordem em que estão definidas
    const flow = flowById(flowFilter);
    if (!flow) {
      board.innerHTML = `<div class="kanban-empty">${emptyState('Fluxo não encontrado', 'O fluxo selecionado não está mais disponível.', 'flow')}</div>`;
      paintIcons();
      return;
    }
    columns = flow.stages.map((s, i) => ({
      label: s.label,
      color: s.color || '#7A00FF',
      done: !!s.done,
      position: i,
      items: list.filter(d => d.flowId === flow.id && d.status === s.id)
    }));
  } else {
    // Modo "todos os fluxos": agrupa por rótulo, mesclando etapas homônimas entre fluxos
    const cols = new Map();
    let order = 0;
    for (const f of wsFlows()) {
      for (const s of f.stages) {
        if (!cols.has(s.label)) {
          cols.set(s.label, { label: s.label, color: s.color || '#7A00FF', done: !!s.done, position: order++, items: [] });
        }
      }
    }
    for (const d of list) {
      const f = flowById(d.flowId); if (!f) continue;
      const s = f.stages.find(x => x.id === d.status); if (!s) continue;
      const col = cols.get(s.label);
      if (col) col.items.push(d);
    }
    columns = [...cols.values()].sort((a, b) => a.position - b.position);
  }
  if (!columns.length) {
    board.innerHTML = `<div class="kanban-empty">${emptyState('Nenhum fluxo configurado', 'Crie um fluxo de demanda para visualizar o kanban.', 'kanban')}</div>`;
    paintIcons();
    return;
  }
  board.innerHTML = columns.map(col => `
    <div class="kanban-column">
      <div class="kanban-column-head" style="border-top-color:${col.color}">
        <span class="pill-dot" style="background:${col.color}"></span>
        <span class="kanban-column-title">${esc(col.label)}</span>
        <span class="kanban-column-count">${col.items.length}</span>
      </div>
      <div class="kanban-column-body" data-stage-label="${esc(col.label)}">
        ${col.items.length ? col.items.map(d => kanbanCard(d)).join('') : '<div class="kanban-column-empty">Sem demandas</div>'}
      </div>
    </div>
  `).join('');
  setupKanbanDragDrop();
  paintIcons();
}

/* Conjunto ordenado de usuários envolvidos com uma demanda: owner primeiro,
   depois autores de comentário, autores no histórico e responsáveis por etapas
   definidos como override de instância. */
function demandCollaborators(d) {
  const seen = new Set();
  const out = [];
  const push = (uid) => {
    if (!uid || seen.has(uid)) return;
    const u = userById(uid);
    if (!u) return;
    seen.add(uid);
    out.push(u);
  };
  push(d.ownerId);
  (d.comments || []).forEach(c => push(c.userId));
  (d.history || []).forEach(h => push(h.userId));
  if (d.stageResponsibles && typeof d.stageResponsibles === 'object') {
    Object.values(d.stageResponsibles).forEach(push);
  }
  return out;
}

function kanbanCard(d) {
  const p = projectById(d.projectId);
  const owner = userById(d.ownerId);
  const due = effDue(d);
  const late = isLate(d);
  let ownerBlock;
  if (!owner) {
    ownerBlock = '<span class="kanban-card-owner-empty">Sem responsável</span>';
  } else {
    const collabs = demandCollaborators(d);
    const MAX = 3;
    const visible = collabs.slice(0, MAX);
    const more = collabs.length - visible.length;
    const tip = collabs.length > 1 ? collabs.map(u => u.name).join(', ') : owner.name;
    ownerBlock = `<div class="kanban-card-avatars" data-tooltip="${esc(tip)}">
      <span class="avatar-stack">
        ${visible.map((u, i) => `<span class="avatar-stack-item" style="z-index:${10 - i}">${avatarHTML(u, 'avatar avatar-stack-avatar')}</span>`).join('')}
        ${more > 0 ? `<span class="avatar-stack-more">+${more}</span>` : ''}
      </span>
      <span class="kanban-card-owner-name">${esc(owner.name.split(' ')[0])}</span>
    </div>`;
  }
  const dueBlock = due
    ? `<span class="kanban-card-due ${late ? 'late' : ''}"><i data-lucide="${late ? 'alert-triangle' : 'calendar'}" class="ic-xs"></i> ${esc(fmtDate(due))}</span>`
    : '';
  return `
    <div class="kanban-card" draggable="true" data-demand-id="${d.id}" onclick="showDetail('${d.id}')">
      <div class="kanban-card-top">${priorityPill(d.priority)}</div>
      <div class="kanban-card-name">${esc(d.name)}</div>
      <div class="kanban-card-meta">${esc(p?.name || '—')}${p?.client ? ` · ${esc(p.client)}` : ''}</div>
      <div class="kanban-card-foot">
        ${ownerBlock}
        ${dueBlock}
      </div>
    </div>
  `;
}

/* ─── KANBAN: DRAG & DROP com reorder + placeholder ─── */
let _kanbanDndBound = false;
let _kbPlaceholder = null;
let _kbDraggingId = null;
function _kbEnsurePlaceholder() {
  if (_kbPlaceholder) return _kbPlaceholder;
  _kbPlaceholder = document.createElement('div');
  _kbPlaceholder.className = 'kanban-drop-placeholder';
  return _kbPlaceholder;
}
function _kbRemovePlaceholder() {
  if (_kbPlaceholder && _kbPlaceholder.parentElement) _kbPlaceholder.parentElement.removeChild(_kbPlaceholder);
}
/* Para um dado mouse Y dentro de uma coluna, retorna o card antes do qual
   o placeholder deve ser inserido (ou null se ele deve ir no final). */
function _kbCardAfter(body, y) {
  const cards = [...body.querySelectorAll('.kanban-card:not(.dragging)')];
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) return c;
  }
  return null;
}
function setupKanbanDragDrop() {
  if (_kanbanDndBound) return;
  const board = $('kanban-board');
  if (!board) return;
  _kanbanDndBound = true;

  // O click do showDetail é suprimido quando o mousedown vira drag (evita abrir o
  // modal logo após soltar o card).
  let suppressNextClick = false;

  board.addEventListener('dragstart', e => {
    const card = e.target.closest('.kanban-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.demandId);
    e.dataTransfer.effectAllowed = 'move';
    _kbDraggingId = card.dataset.demandId;
    // setTimeout pra Chrome aplicar a opacidade só depois do snapshot do drag image
    setTimeout(() => card.classList.add('dragging'), 0);
    suppressNextClick = true;
  });
  board.addEventListener('dragend', e => {
    const card = e.target.closest('.kanban-card');
    if (card) card.classList.remove('dragging');
    board.querySelectorAll('.kanban-column-body.drag-over').forEach(el => el.classList.remove('drag-over'));
    _kbRemovePlaceholder();
    _kbDraggingId = null;
    setTimeout(() => { suppressNextClick = false; }, 50);
  });
  board.addEventListener('dragover', e => {
    const body = e.target.closest('.kanban-column-body');
    if (!body) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.classList.add('drag-over');
    // Esconde o estado "vazio" enquanto arrasta sobre coluna sem cards
    const empty = body.querySelector('.kanban-column-empty');
    if (empty) empty.style.display = 'none';
    // Posiciona o placeholder antes do card mais próximo abaixo do cursor
    const placeholder = _kbEnsurePlaceholder();
    const ref = _kbCardAfter(body, e.clientY);
    if (ref) body.insertBefore(placeholder, ref);
    else body.appendChild(placeholder);
  });
  board.addEventListener('dragleave', e => {
    const body = e.target.closest('.kanban-column-body');
    if (!body) return;
    if (body.contains(e.relatedTarget)) return;
    body.classList.remove('drag-over');
    const empty = body.querySelector('.kanban-column-empty');
    if (empty) empty.style.display = '';
  });
  board.addEventListener('drop', e => {
    const body = e.target.closest('.kanban-column-body');
    if (!body) return;
    e.preventDefault();
    body.classList.remove('drag-over');
    const demandId = e.dataTransfer.getData('text/plain') || _kbDraggingId;
    const stageLabel = body.dataset.stageLabel;
    if (!demandId || !stageLabel) { _kbRemovePlaceholder(); return; }
    // Calcula índice alvo baseado na posição atual do placeholder.
    // Como o card sendo arrastado ainda está no DOM (com classe .dragging),
    // descontamos quantos cards dragging aparecem ANTES do placeholder
    // pra que o índice corresponda à lista SEM o source.
    let targetIndex = -1;
    const placeholder = _kbPlaceholder;
    if (placeholder && placeholder.parentElement === body) {
      const allChildren = [...body.children].filter(c => (c.classList && c.classList.contains('kanban-card')) || c === placeholder);
      const phIdx = allChildren.indexOf(placeholder);
      const draggingBefore = allChildren.slice(0, phIdx).filter(c => c.classList && c.classList.contains('dragging')).length;
      targetIndex = phIdx - draggingBefore;
    }
    _kbRemovePlaceholder();
    const card = document.querySelector(`.kanban-card[data-demand-id="${demandId}"]`);
    const sourceColBody = card ? card.closest('.kanban-column-body') : null;
    const sameColumn = sourceColBody === body;
    if (sameColumn) {
      handleKanbanReorder(demandId, body, targetIndex);
    } else {
      moveDemandToStage(demandId, stageLabel, targetIndex);
    }
  });
  // Suprime o click que viria após o drop
  board.addEventListener('click', e => {
    if (!suppressNextClick) return;
    const card = e.target.closest('.kanban-card');
    if (card) {
      e.stopPropagation();
      e.preventDefault();
    }
    suppressNextClick = false;
  }, true);
}

/* Helper: calcula um kanbanOrder novo entre dois vizinhos da coluna alvo.
   Usado tanto na reorder dentro da mesma coluna quanto no move cross-column
   com posição específica. Espaçamento padrão de 1000 reduz reescritas. */
function computeKanbanOrder(body, demandId, targetIndex) {
  const cards = [...body.querySelectorAll('.kanban-card')].filter(c => c.dataset.demandId !== demandId);
  if (targetIndex < 0) targetIndex = cards.length;
  if (targetIndex > cards.length) targetIndex = cards.length;
  const before = cards[targetIndex - 1];
  const after = cards[targetIndex];
  const beforeDemand = before ? demandById(before.dataset.demandId) : null;
  const afterDemand = after ? demandById(after.dataset.demandId) : null;
  const bo = beforeDemand && Number.isFinite(Number(beforeDemand.kanbanOrder)) ? Number(beforeDemand.kanbanOrder) : null;
  const ao = afterDemand && Number.isFinite(Number(afterDemand.kanbanOrder)) ? Number(afterDemand.kanbanOrder) : null;
  if (bo !== null && ao !== null) return (bo + ao) / 2;
  if (bo !== null) return bo + 1000;
  if (ao !== null) return ao - 1000;
  return Date.now(); // primeira reordenação na coluna
}

/* Reordena dentro da mesma coluna. OTIMISTA: aplica mudança local e
   re-renderiza ANTES da resposta da rede. Em erro, reverte. */
async function handleKanbanReorder(demandId, body, targetIndex) {
  const d = demandById(demandId);
  if (!d) return;
  const newOrder = computeKanbanOrder(body, demandId, targetIndex);
  const prevOrder = d.kanbanOrder ?? null;
  if (prevOrder === newOrder) return;
  d.kanbanOrder = newOrder;
  renderKanban();
  try {
    const upd = await api('/demands/' + demandId, 'PUT', { kanbanOrder: newOrder });
    patchDemand(upd); // server pode ter normalizado o valor
    // re-render apenas se algo realmente divergiu do otimismo
    if ((upd.kanbanOrder ?? null) !== newOrder) renderKanban();
  } catch (err) {
    // Rollback: restaura ordem antiga e re-renderiza
    d.kanbanOrder = prevOrder;
    renderKanban();
    toast(err.message || 'Erro ao reordenar', 'error');
  }
}

/* Move pra outra etapa. OTIMISTA: status + (opcional) kanbanOrder aplicados
   localmente antes do request; revertidos em caso de erro. */
async function moveDemandToStage(demandId, stageLabel, targetIndex) {
  const d = demandById(demandId);
  if (!d) return;
  const flow = flowById(d.flowId);
  if (!flow) { toast('Fluxo não encontrado para esta demanda', 'error'); return; }
  const target = flow.stages.find(s => s.label === stageLabel);
  if (!target) {
    toast(`A etapa "${stageLabel}" não existe no fluxo "${flow.name}". Mova a demanda dentro do mesmo fluxo.`, 'error');
    return;
  }
  if (target.id === d.status) return;

  // Calcula nova posição (kanbanOrder) se o usuário soltou em local específico.
  let newOrder = null;
  if (typeof targetIndex === 'number' && targetIndex >= 0) {
    const board = document.getElementById('kanban-board');
    const body = board && board.querySelector(`.kanban-column-body[data-stage-label="${CSS.escape(stageLabel)}"]`);
    if (body) newOrder = computeKanbanOrder(body, demandId, targetIndex);
  }

  // Snapshot pra rollback
  const prevStatus       = d.status;
  const prevKanbanOrder  = d.kanbanOrder ?? null;
  const prevStageEntered = d.stageEnteredAt;
  const prevCompletedAt  = d.completedAt;

  // Aplica otimisticamente
  d.status = target.id;
  if (newOrder !== null) d.kanbanOrder = newOrder;
  d.stageEnteredAt = nowIsoLocal();
  if (target.done && !d.completedAt) d.completedAt = d.stageEnteredAt;
  else if (!target.done) d.completedAt = null;

  renderKanban();
  // Animação imediata no card que acabou de cair
  requestAnimationFrame(() => {
    const card = document.querySelector(`.kanban-card[data-demand-id="${demandId}"]`);
    if (card) {
      card.classList.add('just-landed');
      setTimeout(() => card.classList.remove('just-landed'), 700);
      const col = card.closest('.kanban-column');
      if (col) {
        col.classList.add('flash-drop');
        setTimeout(() => col.classList.remove('flash-drop'), 700);
      }
    }
  });

  const payload = { status: target.id };
  if (newOrder !== null) payload.kanbanOrder = newOrder;
  try {
    const upd = await api('/demands/' + demandId, 'PUT', payload);
    patchDemand(upd);
    // Re-render só se server retornou estado diferente do otimismo (mudou owner por
    // auto-atribuição da etapa, completou em outra etapa, etc).
    const diverged = upd.status !== target.id
                  || (upd.kanbanOrder ?? null) !== (newOrder ?? prevKanbanOrder)
                  || upd.ownerId !== d.ownerId;
    if (diverged) renderKanban();
    toast(`Movido para "${target.label}"`, 'success');
  } catch (err) {
    // Rollback
    d.status         = prevStatus;
    d.kanbanOrder    = prevKanbanOrder;
    d.stageEnteredAt = prevStageEntered;
    d.completedAt    = prevCompletedAt;
    renderKanban();
    toast(err.message || 'Erro ao mover demanda', 'error');
  }
}

// Helper local — ISO da hora atual (mesma lógica do nowISO do server, lado cliente).
function nowIsoLocal() { return new Date().toISOString(); }

/* ─── MINHAS DEMANDAS ─── */
let mineSortKey = 'deadline', mineSortAsc = true;
function myDemands() { return wsDemands().filter(d => d.ownerId === me.id); }
function renderMine() {
  const fq = $('mine-f-quick').value;
  applyFilterDropdown('mine-f-quick');
  const list = myDemands().filter(d => {
    if (fq === 'late') return isLate(d);
    if (fq === 'open') return !isDone(d);
    if (fq === 'done') return isDone(d);
    return true;
  }).sort((a,b) => {
    let va, vb;
    if (mineSortKey === 'name')        { va = norm(a.name); vb = norm(b.name); }
    else if (mineSortKey === 'project') { va = norm(projectById(a.projectId)?.name || ''); vb = norm(projectById(b.projectId)?.name || ''); }
    else if (mineSortKey === 'status')  { const fa = flowById(a.flowId), fb = flowById(b.flowId); va = fa ? fa.stages.findIndex(s => s.id === a.status) : 0; vb = fb ? fb.stages.findIndex(s => s.id === b.status) : 0; }
    else                                { va = effDue(a) || '9999'; vb = effDue(b) || '9999'; }
    return (va < vb ? -1 : va > vb ? 1 : 0) * (mineSortAsc ? 1 : -1);
  });

  $('mine-table-body').innerHTML = list.length ? list.map(d => `
    <tr class="demand-row" onclick="showDetail('${d.id}')">
      <td><span class="demand-name">${esc(d.name)}</span></td>
      <td>${esc(projectById(d.projectId)?.name || '—')}</td>
      <td>${statusPill(d)}</td>
      <td>${qtyCell(d)}</td>
      <td class="${isLate(d) ? 'deadline-late' : ''}">${fmtDate(effDue(d))}</td>
    </tr>`).join('')
    : `<tr><td colspan="5">${emptyState('Nenhuma demanda encontrada', 'Você não tem demandas neste filtro.', 'inbox')}</td></tr>`;
  // Calendário e Agenda embed ficam sempre visíveis abaixo da tabela em
  // "Minhas Demandas". Re-render junto pra refletir mudanças imediato.
  if ($('cal-mine-body')) renderCalendar('mine');
  if (typeof renderAgenda === 'function') renderAgenda();
}
function sortMine(key) {
  if (mineSortKey === key) mineSortAsc = !mineSortAsc; else { mineSortKey = key; mineSortAsc = true; }
  renderMine();
}

/* ─── CALENDÁRIOS ─── */
function calNav(which, dir) {
  calState[which].setMonth(calState[which].getMonth() + dir);
  renderCalendar(which);
}
function calToday(which) { calState[which] = new Date(); renderCalendar(which); }


/* ─── CAPACIDADE DA EQUIPE ─── */
let capacityView = 'team'; // 'team' | 'project' | 'client'
function setCapacityView(v) {
  capacityView = v;
  renderCapacity();
}

function renderCapacity() {
  restoreFilters('capacity');
  const period = $('capacity-period').value || '7';
  const today = new Date(); today.setHours(0,0,0,0);
  // Janelas:
  //   - Numérico (7/14/30): capacidade = próximos N dias, apontadas = últimos N dias.
  //   - Este mês: capacidade = mês corrente INTEIRO, apontadas = início do mês até hoje (MTD).
  let capStart, capEnd, logStart, logEnd;
  if (period === 'month') {
    capStart = new Date(today.getFullYear(), today.getMonth(), 1);
    capEnd   = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    logStart = new Date(capStart);
    logEnd   = new Date(today);
  } else {
    const days = parseInt(period, 10);
    capStart = new Date(today);
    capEnd   = new Date(today); capEnd.setDate(capEnd.getDate() + days - 1);
    logEnd   = new Date(today);
    logStart = new Date(today); logStart.setDate(logStart.getDate() - (days - 1));
  }
  const startYmd = capStart.toISOString().slice(0,10);
  const endYmd   = capEnd.toISOString().slice(0,10);
  const logStartYmd = logStart.toISOString().slice(0,10);
  const logEndYmd   = logEnd.toISOString().slice(0,10);

  // Conta dias úteis (seg–sex, exclui sáb 6 e dom 0) entre capStart e capEnd inclusive.
  // 5 dias úteis × 8h = 40h por semana cheia.
  const capPeriodDays = Math.round((capEnd - capStart) / 86400000) + 1;
  let businessDays = 0;
  for (let i = 0; i < capPeriodDays; i++) {
    const d = new Date(capStart); d.setDate(d.getDate() + i);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) businessDays++;
  }
  const capacityHours = businessDays * 8;

  // Atualiza estado visual dos botões de view
  ['team', 'project', 'client'].forEach(v => {
    const btn = $('capacity-view-' + v);
    if (btn) btn.classList.toggle('active', capacityView === v);
  });

  // Esconde o cabeçalho ("Capacidade da Equipe") com base no modo
  const heading = $('capacity-heading');
  if (heading) heading.textContent = capacityView === 'team' ? 'Capacidade da Equipe' : (capacityView === 'project' ? 'Horas por Projeto' : 'Horas por Cliente');

  const hint = $('capacity-hint');
  if (hint) hint.textContent = capacityView === 'team'
    ? 'Distribuição de demandas em aberto por responsável. Carga estimada com base nas demandas atribuídas e nas horas já apontadas.'
    : (capacityView === 'project'
        ? 'Total de horas apontadas em cada projeto, somando os apontamentos de todos os usuários no período.'
        : 'Total de horas apontadas para cada cliente, somando todos os projetos do cliente no período.');

  saveFilters('capacity');
  if (capacityView === 'team') return renderCapacityTeam(startYmd, endYmd, businessDays, capacityHours, logStartYmd, logEndYmd);
  if (capacityView === 'project') return renderCapacityAggregate('project', startYmd, endYmd, businessDays, capacityHours);
  return renderCapacityAggregate('client', startYmd, endYmd, businessDays, capacityHours);
}

function renderCapacityTeam(startYmd, endYmd, businessDays, capacityHours, logStartYmd, logEndYmd) {
  const wsdemands = wsDemands().filter(d => !isDone(d));
  const wsusers = wsUsers().filter(u => u.active !== false);

  // Horas apontadas: janela definida no renderCapacity (próximos/últimos N dias
  // pros períodos numéricos, ou início do mês até hoje quando "Este mês").
  const inLookback = (e) => {
    const when = ((e.start || e.createdAt || '') + '').slice(0,10);
    return when >= logStartYmd && when <= logEndYmd;
  };
  // Janela de "entregas": considera a demanda no período se:
  //   - foi CONCLUÍDA dentro da janela (completedAt no período)
  //   - OU está EM ABERTO e atribuída ao usuário (em produção agora)
  // Isso evita que o "0 0 0" apareça enquanto a demanda ainda está em execução.
  const deliveredInWindow = (d) => {
    if (d.completedAt) {
      const day = String(d.completedAt).slice(0, 10);
      return day >= logStartYmd && day <= logEndYmd;
    }
    return !isDone(d); // em aberto = conta como volume previsto
  };

  const rows = wsusers.map(u => {
    const userDemands = wsdemands.filter(d => d.ownerId === u.id);
    const inPeriod = userDemands.filter(d => {
      const due = effDue(d);
      return due && due >= startYmd && due <= endYmd;
    });
    const lateCount = userDemands.filter(d => isLate(d)).length;
    // Horas apontadas pelo usuário NOS ÚLTIMOS N dias (independente da demanda estar em aberto ou não)
    const hoursLogged = wsDemands().reduce((s, d) => {
      return s + (d.timeEntries || [])
        .filter(e => e.userId === u.id && inLookback(e))
        .reduce((a, e) => a + (Number(e.hours) || 0), 0);
    }, 0);
    // Entregáveis: soma das 3 contagens em demandas DESTE usuário (concluídas no período OU ativas).
    // Usa deliverableUserId (quem executou as artes) como prioridade; se vazio, cai pro ownerId atual.
    const deliveredDemands = wsDemands().filter(d => (d.deliverableUserId || d.ownerId) === u.id && deliveredInWindow(d));
    const totalPieces     = deliveredDemands.reduce((s, d) => s + (Number(d.qtyPieces) || 0), 0);
    const totalArts       = deliveredDemands.reduce((s, d) => s + (Number(d.qtyArts) || 0), 0);
    const totalVariations = deliveredDemands.reduce((s, d) => s + (Number(d.qtyVariations) || 0), 0);
    const estimatedLoad = userDemands.reduce((s, d) => s + (Number(d.estimatedHours) > 0 ? Number(d.estimatedHours) : 4), 0);
    // Preenchimento da barra: horas apontadas no período / capacidade do período
    const pct = capacityHours > 0 ? Math.min(150, Math.round(hoursLogged / capacityHours * 100)) : 0;
    const status = pct >= 100 ? 'overload' : pct >= 75 ? 'high' : pct >= 40 ? 'medium' : 'low';
    return { u, userDemands, inPeriod, lateCount, hoursLogged, totalPieces, totalArts, totalVariations, estimatedLoad, pct, status };
  }).sort((a, b) => {
    // 1º critério: horas apontadas (decrescente) — quem mais trabalhou no topo
    if (b.hoursLogged !== a.hoursLogged) return b.hoursLogged - a.hoursLogged;
    // 2º critério: nome do usuário em ordem alfabética (A-Z)
    return norm(a.u.name).localeCompare(norm(b.u.name));
  });

  // Totais do workspace (somatório de todas as rows) — visão global de produção
  const wsTotal = rows.reduce((acc, r) => ({
    pieces: acc.pieces + r.totalPieces,
    arts: acc.arts + r.totalArts,
    variations: acc.variations + r.totalVariations,
    hours: acc.hours + r.hoursLogged
  }), { pieces: 0, arts: 0, variations: 0, hours: 0 });

  $('capacity-list').innerHTML = `
    <div class="capacity-summary">
      <div class="capacity-summary-item"><div class="capacity-summary-label">Capacidade no período</div><div class="capacity-summary-value">${capacityHours}h</div><div class="capacity-summary-sub">${businessDays} dias úteis × 8h</div></div>
      <div class="capacity-summary-item"><div class="capacity-summary-label">Demandas em aberto</div><div class="capacity-summary-value">${wsdemands.length}</div><div class="capacity-summary-sub">no workspace ${esc(wsById(activeWs)?.name || '')}</div></div>
      <div class="capacity-summary-item"><div class="capacity-summary-label">Pessoas ativas</div><div class="capacity-summary-value">${wsusers.length}</div><div class="capacity-summary-sub">com acesso ao workspace</div></div>
    </div>
    <!-- Banner de produção total — soma de todas as pessoas no período -->
    <div class="capacity-prod-banner">
      <div class="capacity-prod-title">Produção do workspace no período</div>
      <div class="capacity-prod-stats">
        <div class="capacity-prod-stat"><span class="capacity-prod-value">${fmtHours(wsTotal.hours)}</span><span class="capacity-prod-label">horas apontadas</span></div>
        <div class="capacity-prod-divider"></div>
        <div class="capacity-prod-stat"><span class="capacity-prod-value">${wsTotal.pieces}</span><span class="capacity-prod-label">peças únicas</span></div>
        <div class="capacity-prod-stat"><span class="capacity-prod-value">${wsTotal.arts}</span><span class="capacity-prod-label">artes individuais</span></div>
        <div class="capacity-prod-stat"><span class="capacity-prod-value">${wsTotal.variations}</span><span class="capacity-prod-label">variações</span></div>
      </div>
    </div>
    <div class="capacity-rows">
    ${rows.map(r => `
      <div class="capacity-row ${r.status}">
        <div class="capacity-user">
          ${avatarHTML(r.u)}
          <div>
            <div class="capacity-user-name">${esc(r.u.name)}</div>
            <div class="capacity-user-role">${esc(r.u.role || '—')}</div>
          </div>
        </div>
        <div class="capacity-stats">
          <div class="capacity-stat"><span class="capacity-stat-value">${r.userDemands.length}</span><span class="capacity-stat-label">em aberto</span></div>
          <div class="capacity-stat"><span class="capacity-stat-value">${r.inPeriod.length}</span><span class="capacity-stat-label">no período</span></div>
          <div class="capacity-stat ${r.lateCount > 0 ? 'late' : ''}"><span class="capacity-stat-value">${r.lateCount}</span><span class="capacity-stat-label">atrasadas</span></div>
          <div class="capacity-stat"><span class="capacity-stat-value">${fmtHours(r.hoursLogged)}</span><span class="capacity-stat-label">apontadas</span></div>
          <div class="capacity-stat-divider"></div>
          <div class="capacity-stat" title="Peças únicas entregues no período"><span class="capacity-stat-value">${r.totalPieces}</span><span class="capacity-stat-label">peças</span></div>
          <div class="capacity-stat" title="Artes individuais entregues no período"><span class="capacity-stat-value">${r.totalArts}</span><span class="capacity-stat-label">artes</span></div>
          <div class="capacity-stat" title="Variações/exportações entregues no período"><span class="capacity-stat-value">${r.totalVariations}</span><span class="capacity-stat-label">variações</span></div>
        </div>
        <div class="capacity-bar-wrap">
          <div class="capacity-bar-track">
            <div class="capacity-bar-fill ${r.status}" style="width:${Math.min(100, r.pct)}%"></div>
            ${r.pct > 100 ? `<div class="capacity-bar-over" style="width:${Math.min(100, r.pct - 100)}%"></div>` : ''}
          </div>
          <div class="capacity-bar-label">${r.pct}%<span class="capacity-bar-sub"> · ${fmtHours(r.hoursLogged)} / ${capacityHours}h</span></div>
        </div>
      </div>
    `).join('')}
    </div>
  `;
  if (!rows.length) $('capacity-list').innerHTML = emptyState('Sem usuários ativos', 'Cadastre usuários e atribua-os a este workspace.', 'users');
}

function renderCapacityAggregate(kind, startYmd, endYmd, businessDays, capacityHours) {
  // Período retroativo: considera apontamentos do início do período até hoje
  // (o filtro de "próximos N dias" passa a significar "últimos N dias" para os modos de horas apontadas)
  const period = $('capacity-period').value || '7';
  const today = new Date(); today.setHours(0,0,0,0);
  let startBack;
  if (period === 'month') {
    startBack = new Date(today.getFullYear(), today.getMonth(), 1);
  } else {
    const days = parseInt(period, 10);
    startBack = new Date(today); startBack.setDate(startBack.getDate() - (days - 1));
  }
  const backStartYmd = startBack.toISOString().slice(0,10);
  const todayYmd = new Date().toISOString().slice(0,10);

  // Junta todos os apontamentos de demandas do workspace no período retroativo
  const wsdemands = wsDemands();
  const allEntries = [];
  wsdemands.forEach(d => {
    (d.timeEntries || []).forEach(e => {
      const ymd = (e.createdAt || '').slice(0, 10);
      if (ymd >= backStartYmd && ymd <= todayYmd) allEntries.push({ d, e });
    });
  });

  // Agrupa por projeto ou por cliente
  const groups = new Map();
  allEntries.forEach(({ d, e }) => {
    const proj = projectById(d.projectId);
    let key, label, sub, projects;
    if (kind === 'project') {
      key = proj?.id || '__none__';
      label = proj?.name || '— Sem projeto —';
      sub = proj?.client || '';
      projects = proj ? [proj] : [];
    } else {
      // por cliente — se projeto sem cliente, agrupa em "Sem cliente"
      key = (proj?.client || '__none__').toLowerCase();
      label = proj?.client || '— Sem cliente —';
      sub = '';
      projects = wsProjects().filter(p => (p.client || '').toLowerCase() === key);
    }
    const cur = groups.get(key) || {
      key, label, sub, projects, color: proj?.color || '#7A00FF',
      hours: 0, demands: new Set(), users: new Set(), entries: 0,
      pieces: 0, arts: 0, variations: 0
    };
    cur.hours += Number(e.hours) || 0;
    cur.demands.add(d.id);
    if (e.userId) cur.users.add(e.userId);
    cur.entries++;
    if (kind === 'client') cur.projects = projects;
    groups.set(key, cur);
  });

  // Segundo loop: soma entregáveis (peças/artes/variações) por grupo.
  // Critério = demanda concluída no período OU em aberto (mesma regra da Equipe).
  // Itera UMA vez por demanda (evita dupla-contagem que viria de iterar por entries).
  const isInWindow = (d) => {
    if (d.completedAt) {
      const day = String(d.completedAt).slice(0, 10);
      return day >= backStartYmd && day <= todayYmd;
    }
    return !isDone(d);
  };
  wsdemands.forEach(d => {
    if (!isInWindow(d)) return;
    if (!(d.qtyPieces || d.qtyArts || d.qtyVariations)) return;
    const proj = projectById(d.projectId);
    let key;
    if (kind === 'project') key = proj?.id || '__none__';
    else key = (proj?.client || '__none__').toLowerCase();
    const g = groups.get(key);
    if (!g) return; // grupo só existe se houver apontamentos — sem horas, sem linha
    g.pieces += Number(d.qtyPieces) || 0;
    g.arts += Number(d.qtyArts) || 0;
    g.variations += Number(d.qtyVariations) || 0;
  });

  const rows = [...groups.values()].sort((a, b) => b.hours - a.hours);
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);
  const maxHours = Math.max(1, ...rows.map(r => r.hours));

  // Resumo
  const summary = `
    <div class="capacity-summary">
      <div class="capacity-summary-item"><div class="capacity-summary-label">Total apontado</div><div class="capacity-summary-value">${fmtHours(totalHours)}</div><div class="capacity-summary-sub">no período (${businessDays} dias úteis)</div></div>
      <div class="capacity-summary-item"><div class="capacity-summary-label">${kind === 'project' ? 'Projetos com horas' : 'Clientes com horas'}</div><div class="capacity-summary-value">${rows.length}</div><div class="capacity-summary-sub">no workspace ${esc(wsById(activeWs)?.name || '')}</div></div>
      <div class="capacity-summary-item"><div class="capacity-summary-label">Apontamentos</div><div class="capacity-summary-value">${allEntries.length}</div><div class="capacity-summary-sub">registros no período</div></div>
    </div>`;

  if (!rows.length) {
    $('capacity-list').innerHTML = summary + emptyState(
      kind === 'project' ? 'Sem horas apontadas em projetos no período' : 'Sem horas apontadas em clientes no período',
      'Os apontamentos das demandas aparecerão aqui quando registrados.'
    );
    return;
  }

  $('capacity-list').innerHTML = summary + `
    <div class="capacity-rows">
    ${rows.map(r => {
      const pct = Math.round(r.hours / maxHours * 100);
      const share = totalHours > 0 ? Math.round(r.hours / totalHours * 100) : 0;
      return `<div class="capacity-row">
        <div class="capacity-user">
          <span class="capacity-color-dot" style="background:${r.color}"></span>
          <div>
            <div class="capacity-user-name">${esc(r.label)}</div>
            <div class="capacity-user-role">${kind === 'project' ? (r.sub ? esc(r.sub) : 'Sem cliente') : (r.projects.length + ' projeto' + (r.projects.length === 1 ? '' : 's'))}</div>
          </div>
        </div>
        <div class="capacity-stats">
          <div class="capacity-stat"><span class="capacity-stat-value">${fmtHours(r.hours)}</span><span class="capacity-stat-label">apontadas</span></div>
          <div class="capacity-stat"><span class="capacity-stat-value">${r.demands.size}</span><span class="capacity-stat-label">demanda${r.demands.size === 1 ? '' : 's'}</span></div>
          <div class="capacity-stat"><span class="capacity-stat-value">${r.users.size}</span><span class="capacity-stat-label">pessoa${r.users.size === 1 ? '' : 's'}</span></div>
          <div class="capacity-stat"><span class="capacity-stat-value">${r.entries}</span><span class="capacity-stat-label">apontamento${r.entries === 1 ? '' : 's'}</span></div>
          <div class="capacity-stat-divider"></div>
          <div class="capacity-stat" title="Peças únicas entregues no período"><span class="capacity-stat-value">${r.pieces}</span><span class="capacity-stat-label">peças</span></div>
          <div class="capacity-stat" title="Artes individuais entregues no período"><span class="capacity-stat-value">${r.arts}</span><span class="capacity-stat-label">artes</span></div>
          <div class="capacity-stat" title="Variações/exportações entregues no período"><span class="capacity-stat-value">${r.variations}</span><span class="capacity-stat-label">variações</span></div>
        </div>
        <div class="capacity-bar-wrap">
          <div class="capacity-bar-track">
            <div class="capacity-bar-fill medium" style="width:${pct}%;background:${r.color}"></div>
          </div>
          <div class="capacity-bar-label">${share}%<span class="capacity-bar-sub"> · do total apontado</span></div>
        </div>
      </div>`;
    }).join('')}
    </div>
  `;
}

function renderCalendar(which) {
  const ref = calState[which];
  const y = ref.getFullYear(), m = ref.getMonth();
  $('cal-' + which + '-title').textContent = MONTHS[m] + ' ' + y;
  const source = which === 'mine' ? myDemands() : listFilteredDemands();
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < first; i++) html += '<div class="cal-day" style="visibility:hidden"></div>';
  for (let day = 1; day <= days; day++) {
    const ymd = fmtYMD(y, m, day);
    const evs = source.filter(d => effDue(d) === ymd);
    const isToday = ymd === todayStr();
    // Sábado (6) e domingo (0) recebem .weekend pra ganhar visual atenuado no CSS.
    const dow = new Date(y, m, day).getDay();
    const isWeekend = dow === 0 || dow === 6;
    html += `<div class="cal-day ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''}">
      <div class="cal-day-num">${isToday ? `<span class="cal-today-pill">${day}</span>` : day}</div>
      ${evs.slice(0,4).map(d => {
        const s = stageOf(d);
        const late = isLate(d);
        const owner = userById(d.ownerId);
        const bg = late ? 'var(--danger-dim)' : hexDim(s?.color);
        const fg = late ? 'var(--danger)' : (s?.color || 'var(--text)');
        const avatarHtml = owner
          ? avatarHTML(owner, 'avatar cal-event-avatar')
          : `<span class="cal-event-dot" style="background:${fg}"></span>`;
        return `<div class="cal-event" onclick="showDetail('${d.id}')" data-tooltip="${esc(d.name)}${owner ? ' · ' + esc(owner.name) : ''}" style="background:${bg};color:${fg}">
          ${avatarHtml}
          <span class="cal-event-name">${esc(d.name)}</span>
        </div>`;
      }).join('')}
      ${evs.length > 4 ? `<div class="cal-day-more">+${evs.length - 4} mais</div>` : ''}
    </div>`;
  }
  $('cal-' + which + '-body').innerHTML = html;
}
function fmtYMD(y, m, d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

/* ─── MODAL: NOVA / EDITAR DEMANDA ─── */
/* Fluxos disponíveis pra um projeto, na nova arquitetura por cliente:
   1. Fluxos exclusivos desse projetId (caso especial — fluxo amarrado a 1 projeto)
   2. Fluxos do MESMO CLIENTE do projeto (via field `client`)
   3. Fluxos "Geral" do workspace (sem cliente) — sempre disponíveis */
function flowsForProject(projectId) {
  const proj = projectById(projectId);
  const projClient = (proj?.client || '').trim().toLowerCase();
  const all = wsFlows();
  const exclusive = all.filter(f => f.projectId === projectId);
  const byClient = projClient
    ? all.filter(f => !f.projectId && (f.client || '').trim().toLowerCase() === projClient)
    : [];
  const general = all.filter(f => !f.projectId && !(f.client || '').trim());
  // Dedup mantendo ordem: exclusive > client-specific > general
  const seen = new Set();
  return [...exclusive, ...byClient, ...general].filter(f => {
    if (seen.has(f.id)) return false;
    seen.add(f.id); return true;
  });
}
function onDemandProjectChange() {
  const pid = $('f-project').value;
  const fl = (pid ? flowsForProject(pid) : wsFlows())
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const prev = $('f-flow').value;
  $('f-flow').innerHTML = fl.map(f => `<option value="${f.id}">${esc(f.name)}${f.demandType ? ' · ' + esc(f.demandType) : ''}</option>`).join('');
  if ([...$('f-flow').options].some(o => o.value === prev)) $('f-flow').value = prev;
  syncStatusOptions();
}
function syncStatusOptions(selectedStageId) {
  const flow = flowById($('f-flow').value);
  $('f-status').innerHTML = flow
    ? flow.stages.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')
    : '';
  if (selectedStageId && flow && flow.stages.some(s => s.id === selectedStageId)) $('f-status').value = selectedStageId;
  // Auto-atribui responsável da etapa ao criar nova demanda
  if (!editingId && flow) {
    const stageId = $('f-status').value;
    const stage = flow.stages.find(s => s.id === stageId);
    const autoOwner = stage?.responsibleId || null;
    buildUserSelect($('f-owner-select'), wsUsers(), autoOwner, null);
    // Defaults herdados do fluxo: só aplica em NOVA demanda e se o usuário ainda
    // não digitou nada nos campos (não sobrescreve mudanças manuais).
    const descEl = $('f-description');
    if (descEl && !descEl.value.trim() && flow.defaultDescription) {
      descEl.value = flow.defaultDescription;
    }
    // Checklist herdado — só popula se ainda tá zerado (evita resetar edições)
    if (!demandChecklistDraft.length && Array.isArray(flow.defaultChecklist)) {
      demandChecklistDraft = flow.defaultChecklist.map(it => ({ text: String(it.text || '') }));
    }
    renderDemandChecklist();
  }
}
function onDemandStatusChange() {
  if (!editingId) {
    const flow = flowById($('f-flow').value);
    if (flow) {
      const stage = flow.stages.find(s => s.id === $('f-status').value);
      buildUserSelect($('f-owner-select'), wsUsers(), stage?.responsibleId || null, null);
    }
  }
}

/* Draft do checklist a ser criado junto com a demanda nova.
   Inicializado pelo defaultChecklist do fluxo em syncStatusOptions().
   Editável aqui — usuário pode adicionar/remover/editar texto antes de salvar. */
let demandChecklistDraft = [];
function renderDemandChecklist() {
  const wrap = $('f-checklist-list');
  const group = $('f-checklist-group');
  if (!wrap || !group) return;
  // Só exibe na criação (não em edição — checklist edita pela aba detail)
  if (editingId) { group.style.display = 'none'; return; }
  if (!demandChecklistDraft.length) {
    group.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  group.style.display = '';
  wrap.innerHTML = demandChecklistDraft.map((it, i) => `
    <div class="flow-checklist-item">
      <input class="form-control" value="${esc(it.text)}" placeholder="Item do checklist" oninput="demandChecklistDraft[${i}].text=this.value">
      <button type="button" class="icon-btn danger" title="Remover" onclick="removeDemandChecklistItem(${i})"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('');
  paintIcons();
}
function addDemandChecklistItem() {
  demandChecklistDraft.push({ text: '' });
  renderDemandChecklist();
  const inputs = $('f-checklist-list').querySelectorAll('input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeDemandChecklistItem(i) {
  demandChecklistDraft.splice(i, 1);
  renderDemandChecklist();
}
function fillDemandSelectors(d) {
  const projs = wsProjects().filter(p => p.active !== false || (d && d.projectId === p.id))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('f-project').innerHTML = '<option value="">— Selecione um projeto —</option>' +
    projs.map(p => `<option value="${p.id}">${esc(p.name)}${p.client ? ' · ' + esc(p.client) : ''}</option>`).join('');
}
function fillTemplateSelector() {
  const wsTemplates = templates.filter(t => t.workspaceId === activeWs)
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const sel = $('f-template');
  sel.innerHTML = '<option value="">— Em branco —</option>' +
    wsTemplates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('f-template-group').style.display = wsTemplates.length ? '' : 'none';
}
function applyDemandTemplate() {
  const tid = $('f-template').value;
  if (!tid) return;
  const t = templates.find(x => x.id === tid); if (!t) return;
  if ($('f-name').value.trim() === '') $('f-name').value = t.name || '';
  $('f-description').value = t.description || '';
  $('f-briefing').value = t.briefing || '';
  $('f-estimated').value = t.estimatedHours || '';
  $('f-priority').value = t.priority || 3;
  if (t.projectId && projects.some(p => p.id === t.projectId)) {
    $('f-project').value = t.projectId;
    onDemandProjectChange();
  }
  if (t.flowId && flows.some(f => f.id === t.flowId)) {
    $('f-flow').value = t.flowId;
    syncStatusOptions();
  }
  if (t.ownerId) buildUserSelect($('f-owner-select'), wsUsers(), t.ownerId, null);
  demandAttachments = (t.attachments || []).map(a => ({ ...a, id: 'a' + Math.random().toString(36).slice(2,10) }));
  refreshFormAttList('f-attachments-list');
  toast('Template "' + t.name + '" aplicado!');
}

function openNewDemand() {
  editingId = null;
  $('modal-title').textContent = 'Nova demanda';
  $('demand-delete-btn').style.display = 'none';
  fillDemandSelectors(null);
  fillTemplateSelector();
  $('f-template').value = '';
  $('f-name').value = ''; $('f-description').value = '';
  $('f-briefing').value = ''; $('f-deadline').value = '';
  $('f-estimated').value = ''; $('f-priority').value = '3';
  $('f-qty-pieces').value = ''; $('f-qty-arts').value = ''; $('f-qty-variations').value = '';
  fillDeliverableUserSelect('f-deliverable-user', null);
  demandChecklistDraft = [];
  renderDemandChecklist();
  $('f-rec-enabled').checked = false; $('f-rec-config').style.display = 'none';
  $('f-rec-pattern').value = 'weekly'; $('f-rec-weekday').value = '1'; $('f-rec-end').value = '';
  $('f-project').value = '';
  demandAttachments = [];
  refreshFormAttList('f-attachments-list');
  applyPriorityDropdown('f-priority');
  // Inicia o wizard no step 1 (cliente). Reset completo do estado (inclui customização).
  wizardState = { step: 1, clientId: null, projectId: null, flowId: null };
  resetWizardCustomization();
  wizardLastFlowApplied = null;
  wizardGoTo(1);
  openModal('demand-modal');
  navPush('/demands/new');
  setTimeout(() => setupDragDrop('#demand-modal .modal-content', 'f-attachments-list', processDroppedFiles), 60);
}
function openEditDemand(id) {
  const d = demands.find(x => x.id === id); if (!d) return;
  editingId = id;
  $('modal-title').textContent = 'Editar demanda';
  $('demand-delete-btn').style.display = '';
  fillDemandSelectors(d);
  fillTemplateSelector();
  $('f-template-group').style.display = 'none';
  // Em edição, pula o wizard — vai direto pro form (step 4) com seleção pronta
  wizardState = { step: 4, clientId: projectById(d.projectId)?.clientId || null, projectId: d.projectId, flowId: d.flowId };
  // Marca o flow como "já aplicado" pra evitar reset dos campos preenchidos pela demanda
  wizardLastFlowApplied = d.flowId;
  wizardGoTo(4);
  $('f-name').value = d.name;
  $('f-description').value = d.description || '';
  $('f-briefing').value = d.briefing || '';
  $('f-deadline').value = d.deadline || '';
  $('f-estimated').value = d.estimatedHours || '';
  $('f-priority').value = d.priority || 3;
  $('f-qty-pieces').value = d.qtyPieces || '';
  $('f-qty-arts').value = d.qtyArts || '';
  $('f-qty-variations').value = d.qtyVariations || '';
  fillDeliverableUserSelect('f-deliverable-user', d.deliverableUserId || '');
  // Em edição, o checklist é gerenciado pelo painel de detalhe (não aqui)
  demandChecklistDraft = [];
  renderDemandChecklist();
  // Recurrence
  const rec = d.recurrence;
  $('f-rec-enabled').checked = !!(rec && rec.enabled);
  $('f-rec-config').style.display = rec?.enabled ? '' : 'none';
  $('f-rec-pattern').value = rec?.pattern || 'weekly';
  $('f-rec-weekday').value = rec?.weekDay ?? 1;
  if ($('f-rec-monthday')) $('f-rec-monthday').value = rec?.monthDay || 1;
  $('f-rec-end').value = rec?.endDate || '';
  $('f-rec-weekday-g').style.display = (rec?.pattern || 'weekly') === 'weekly' ? '' : 'none';
  $('f-rec-monthday-g').style.display = rec?.pattern === 'monthly' ? '' : 'none';
  $('f-project').value = d.projectId || '';
  demandAttachments = (d.attachments || []).slice();
  refreshFormAttList('f-attachments-list');
  onDemandProjectChange();
  $('f-flow').value = d.flowId;
  syncStatusOptions(d.status);
  buildUserSelect($('f-owner-select'), wsUsers(), d.ownerId, null);
  applyPriorityDropdown('f-priority');
  openModal('demand-modal');
  navPush('/demands/' + id + '/edit');
  setTimeout(() => setupDragDrop('#demand-modal .modal-content', 'f-attachments-list', processDroppedFiles), 60);
}
async function saveDemand() {
  const recEnabled = $('f-rec-enabled').checked;
  // Lê valores brutos pra log diagnóstico — se algum vier "" ou NaN sabemos por aí
  const _rawQty = {
    p: $('f-qty-pieces')?.value,
    a: $('f-qty-arts')?.value,
    v: $('f-qty-variations')?.value
  };
  const payload = {
    name: $('f-name').value,
    description: $('f-description').value,
    projectId: $('f-project').value,
    flowId: $('f-flow').value,
    briefing: normalizeUrl($('f-briefing').value),
    deadline: $('f-deadline').value || null,
    estimatedHours: $('f-estimated').value ? Number($('f-estimated').value) : null,
    priority: Number($('f-priority').value) || 3,
    qtyPieces: Number($('f-qty-pieces').value) || 0,
    qtyArts: Number($('f-qty-arts').value) || 0,
    qtyVariations: Number($('f-qty-variations').value) || 0,
    deliverableUserId: $('f-deliverable-user')?.value || null,
    // Checklist inicial — só faz sentido em CRIAÇÃO. Em edição ignora (o user
    // edita pela aba detail). Filtra itens vazios.
    checklist: editingId ? undefined : demandChecklistDraft.filter(it => (it.text || '').trim()).map(it => ({ text: it.text.trim() })),
    status: $('f-status').value,
    ownerId: $('f-owner-select').dataset.value || null,
    attachments: demandAttachments.slice(),
    recurrence: recEnabled ? {
      enabled: true,
      pattern: $('f-rec-pattern').value,
      weekDay: parseInt($('f-rec-weekday').value, 10),
      monthDay: parseInt(($('f-rec-monthday')?.value) || '1', 10),
      endDate: $('f-rec-end').value || null
    } : { enabled: false }
  };
  // Customização de etapas por instância (do step "cust" do wizard).
  // Só envia em criação — edição segue por rotas dedicadas (/skipped-stages etc).
  if (!editingId && wizardState.customization) {
    const c = wizardState.customization;
    if (c.skippedStages?.length)                 payload.skippedStages = c.skippedStages;
    if (c.stageResponsibles && Object.keys(c.stageResponsibles).length) payload.stageResponsibles = c.stageResponsibles;
    if (c.stageLabels && Object.keys(c.stageLabels).length) payload.stageLabels = c.stageLabels;
    if (c.stageOverrides && Object.keys(c.stageOverrides).length) payload.stageOverrides = c.stageOverrides;
    if (c.stageAdditions?.length)                payload.stageAdditions = c.stageAdditions;
    if (Array.isArray(c.stageOrder) && c.stageOrder.length) payload.stageOrder = c.stageOrder;
  }
  console.log('[saveDemand] entregáveis raw:', _rawQty, '→ payload:', { p: payload.qtyPieces, a: payload.qtyArts, v: payload.qtyVariations });
  try {
    let result;
    if (editingId) result = await api('/demands/' + editingId, 'PUT', payload);
    else result = await api('/demands', 'POST', payload);
    console.log('[saveDemand] resposta qty:', { p: result?.qtyPieces, a: result?.qtyArts, v: result?.qtyVariations });
    const wasCreate = !editingId;
    const newId = result && result.id;
    closeModal('demand-modal');
    await refreshData();
    if (detailId && editingId === detailId) renderDetail();
    if (wasCreate && newId) {
      toast('Demanda criada!', 'success', { label: 'Abrir', fn: () => showDetail(newId) });
    } else {
      toast(editingId ? 'Demanda atualizada!' : 'Demanda criada!');
    }
  } catch (e) {
    console.error('[saveDemand] erro:', e);
    toast(e.message, 'error');
  }
}

/* ── Salvar como template ── */
async function openSaveAsTemplate() {
  if (!$('f-name').value.trim()) { toast('Preencha ao menos o nome da demanda.', 'error'); return; }
  const name = await showPrompt({
    title: 'Salvar como template',
    message: 'Dê um nome a este template:',
    defaultValue: $('f-name').value.trim(),
    placeholder: 'Ex: Carrossel Instagram - Padrão',
    okLabel: 'Salvar template'
  });
  if (!name) return;
  try {
    await api('/templates', 'POST', {
      name,
      workspaceId: activeWs,
      description: $('f-description').value,
      briefing: normalizeUrl($('f-briefing').value),
      projectId: $('f-project').value || null,
      flowId: $('f-flow').value || null,
      ownerId: $('f-owner-select').dataset.value || null,
      estimatedHours: $('f-estimated').value ? Number($('f-estimated').value) : null,
      priority: Number($('f-priority').value) || 3,
      attachments: demandAttachments.slice()
    });
    toast('Template criado!');
    await refreshData();
    fillTemplateSelector();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteDemand() {
  if (!editingId) return;
  const d = demandById(editingId);
  const ok = await showConfirm({
    title: 'Excluir demanda',
    message: `Tem certeza que deseja excluir <strong>${esc(d?.name || 'esta demanda')}</strong>?<br><br>Essa ação não pode ser desfeita.`,
    okLabel: 'Excluir definitivamente',
    danger: true
  });
  if (!ok) return;
  try {
    const delId = editingId;
    await api('/demands/' + delId, 'DELETE');
    closeModal('demand-modal');
    closeModal('detail-modal');
    detailId = null;
    toastWithUndo('Demanda excluída.', () => api('/demands/' + delId + '/undelete', 'POST'));
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteFromDetail() {
  if (!detailId) return;
  editingId = detailId;
  await deleteDemand();
}
function editCurrentDemand() {
  if (!detailId) return;
  openEditDemand(detailId);
}

/* ─── MODAL: DETALHE DA DEMANDA ─── */
function showDetail(id) {
  detailId = id;
  detailView = 'main';
  renderDetail();             // render imediato com o que tem em cache
  draftRestoreComment();       // restaura rascunho de comentário se houver
  openModal('detail-modal');
  navPush('/demands/' + id);  // URL compartilhável
  // Atualiza com a versão fresca do server (pega anexos/comentários que outros
  // usuários adicionaram desde o último loadAll) + inicia poll periódico.
  refreshDetailDemand();
  startDetailPoll();
}
function demandById(id) { return demands.find(x => x.id === id) || null; }

/* ─── REFRESH DO MODAL DE DETALHE EM QUASE-REALTIME ───
   Polling de 15s busca a versão mais nova da demanda aberta. Permite
   que mudanças de outros usuários (anexos, comentários, etapa) apareçam
   sem precisar dar F5. Pausa enquanto o usuário está digitando pra
   não perder texto em meio a um comentário. */
let _detailPollTimer = null;
async function toggleWatchCurrent() {
  if (!detailId) return;
  const d = demandById(detailId);
  if (!d) return;
  const isWatching = Array.isArray(d.watchers) && d.watchers.includes(me?.id);
  try {
    const r = await api('/demands/' + detailId + (isWatching ? '/unwatch' : '/watch'), 'POST');
    // Atualiza local + re-render sem esperar o refresh
    d.watchers = d.watchers || [];
    if (r.watching) {
      if (!d.watchers.includes(me.id)) d.watchers.push(me.id);
      toast('Observando esta demanda.', 'success');
    } else {
      d.watchers = d.watchers.filter(id => id !== me.id);
      toast('Você parou de observar.', 'success');
    }
    renderDetail();
  } catch (e) { toast(e.message || 'Erro', 'error'); }
}

async function refreshDetailDemand() {
  if (!detailId) return;
  const modal = document.getElementById('detail-modal');
  if (!modal || !modal.classList.contains('open')) return;
  // Pula a atualização se o usuário tá digitando dentro do modal
  const active = document.activeElement;
  if (active && modal.contains(active) &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
    return;
  }
  try {
    const fresh = await api('/demands/' + detailId);
    if (!fresh || fresh.id !== detailId) return;
    const local = demandById(detailId);
    // Re-renderiza apenas se algo de fato mudou (compara via JSON.stringify rápido).
    if (!local || JSON.stringify(local) !== JSON.stringify(fresh)) {
      patchDemand(fresh);
      renderDetail();
    }
  } catch {}
}
function startDetailPoll() {
  stopDetailPoll();
  // SSE já refresca o modal em tempo real (handleSseMessage chama refreshDetailDemand).
  // Mantemos polling de fallback em janela maior caso o SSE caia silenciosamente.
  _detailPollTimer = setInterval(refreshDetailDemand, 60000);
}
function stopDetailPoll() {
  if (_detailPollTimer) { clearInterval(_detailPollTimer); _detailPollTimer = null; }
}

function renderDetail() {
  const d = demandById(detailId);
  if (!d) { closeModal('detail-modal'); return; }
  if (detailView === 'history') return renderDetailHistory(d);
  if (detailView === 'stages') return renderDetailStages(d);
  const flow = flowById(d.flowId);
  const stage = stageOf(d);
  const p = projectById(d.projectId);
  const active = activeStagesOf(d, flow);
  const idx = active.findIndex(s => s.id === d.status);
  const owner = userById(d.ownerId);
  const hasCustomization = Array.isArray(d.skippedStages) && d.skippedStages.length > 0;

  // Pipeline: círculos numerados ligados por um traço (sem labels — nome aparece no tooltip)
  const stepCount = active.length;
  const fillPct = stepCount > 1 ? (idx / (stepCount - 1)) * 100 : (idx >= 0 ? 100 : 0);
  const pipeline = flow ? `
    <div class="pipeline-bar" style="--fill:${Math.max(0, Math.min(100, fillPct))}%">
      <div class="pipeline-bar-track"></div>
      <div class="pipeline-bar-fill"></div>
      <div class="pipeline-bar-steps">
        ${active.map((s, i) => {
          const stepPct = stepCount > 1 ? (i / (stepCount - 1)) * 100 : 50;
          const state = i < idx ? 'done' : (i === idx ? 'current' : '');
          return `<div class="pipeline-bar-step ${state}" style="left:${stepPct}%" data-tooltip="${esc(s.label)}">
            <div class="pipeline-bar-dot">${i + 1}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  // Apontamentos de horas
  const timeRows = (d.timeEntries || []).slice().reverse().map(e => {
    const u = userById(e.userId);
    const f2 = flowById(d.flowId);
    const st = f2 ? f2.stages.find(x => x.id === e.stageId) : null;
    const canEdit = e.userId === me.id;
    const canDel = e.userId === me.id || me.isAdmin;
    return `<div class="appt-row" id="appt-${e.id}">
      ${avatarHTML(u)}
      <span class="appt-name">${esc(u?.name || '—')}</span>
      <span class="appt-hours">${fmtHours(e.hours)}</span>
      <span class="appt-time-range">
        <span class="appt-range">${e.start ? fmtDateTime(e.start) : '—'}</span>
        <i data-lucide="arrow-right" class="ic-sm appt-arrow"></i>
        <span class="appt-range">${e.end ? fmtDateTime(e.end) : '—'}</span>
      </span>
      ${st ? `<span class="pill" style="color:${st.color};background:${hexDim(st.color)};font-size:10px">${esc(st.label)}</span>` : ''}
      <div class="appt-actions">
        ${canEdit ? `<button class="detail-icon-btn" title="Editar" onclick="startEditTimeEntry('${e.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>` : ''}
        ${canDel ? `<button class="detail-icon-btn danger" title="Remover" onclick="confirmDeleteTimeEntry('${e.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>` : ''}
      </div>
    </div>`;
  }).join('');

  // Comentários
  const comments = (d.comments || []).map(c => {
    const u = userById(c.userId);
    const canEdit = c.userId === me.id;
    const canDel = c.userId === me.id || me.isAdmin;
    let text = esc(c.text).replace(/@([a-zA-Z0-9._-]+)/g, (m, uname) => {
      const found = users.find(x => x.username.toLowerCase() === uname.toLowerCase());
      return found ? `<span class="mention">@${esc(found.username)}</span>` : m;
    });
    text = mdApply(linkifyEscaped(text));
    const atts = (c.attachments || []).map(a => {
      if (a.type && a.type.startsWith('image/')) {
        return `<div class="comment-img-wrap"><img class="comment-img" src="${a.data}" alt="${esc(a.name)}" onclick="window.open(this.src,'_blank')"></div>`;
      }
      return `<a class="comment-file" href="${a.data}" download="${esc(a.name)}" title="Baixar ${esc(a.name)}"><i data-lucide="paperclip" class="ic-sm"></i> ${esc(a.name)}</a>`;
    }).join('');
    return `<div class="comment" id="comment-${c.id}">
      <div class="comment-head">
        ${avatarHTML(u)}
        <span class="comment-author">${esc(u?.name || '—')}</span>
        <span class="comment-time">${fmtDateTime(c.createdAt)}${c.editedAt ? ' · editado' : ''}</span>
        <div class="comment-actions">
          ${canEdit ? `<button class="detail-icon-btn comment-act" title="Editar" onclick="startEditComment('${c.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>` : ''}
          ${canDel ? `<button class="detail-icon-btn danger comment-act" title="Remover" onclick="confirmDeleteComment('${c.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>` : ''}
        </div>
      </div>
      ${text ? `<div class="comment-text">${text}</div>` : ''}
      ${atts ? `<div class="comment-attachments">${atts}</div>` : ''}
      ${renderReactions(c)}
    </div>`;
  }).join('');

  const totalHours = (d.timeEntries || []).reduce((a,e) => a + (Number(e.hours) || 0), 0);

  $('detail-content').innerHTML = `
    <div class="detail-content">
      <div class="detail-head">
        <div class="detail-head-top">
          <div>
            <div class="detail-title" data-tooltip="Clique para renomear" onclick="startEditDemandTitle(this)">${esc(d.name)}</div>
            <div class="detail-head-meta">
              ${p ? `<span>${esc(p.name)}</span>` : ''}
              ${p?.client ? `<span class="meta-sep">|</span><span>${esc(p.client)}</span>` : ''}
              ${demandType(d) ? `<span class="meta-sep">|</span><span class="pill pill-muted" style="font-size:10px">${esc(demandType(d))}</span>` : ''}
            </div>
          </div>
          <div class="detail-head-actions">
            ${(() => {
              const watching = Array.isArray(d.watchers) && d.watchers.includes(me?.id);
              const cnt = (d.watchers || []).length;
              const cntBadge = cnt > 0 ? ` <span class="detail-watch-count">${cnt}</span>` : '';
              return `<button class="detail-icon-btn ${watching ? 'on' : ''}" title="${watching ? 'Você observa esta demanda · clique pra parar' : 'Observar esta demanda (receber notificações de comentários e mudanças de etapa)'}" onclick="toggleWatchCurrent()"><i data-lucide="${watching ? 'eye' : 'eye-off'}" class="ic-sm"></i>${cntBadge}</button>`;
            })()}
            <button class="detail-icon-btn danger" title="Excluir demanda" onclick="confirmDeleteCurrentDemand()"><i data-lucide="trash-2" class="ic-sm"></i></button>
            <button class="detail-icon-btn ${hasCustomization ? 'on' : ''}" title="Etapas desta demanda" onclick="openDetailStages()"><i data-lucide="list-checks" class="ic-sm"></i></button>
            <button class="detail-icon-btn" title="Histórico" onclick="openDetailHistory()"><i data-lucide="history" class="ic-sm"></i></button>
            <span class="detail-head-divider"></span>
            <button class="detail-icon-btn" title="Fechar" onclick="attemptCloseModal('detail-modal')"><i data-lucide="x" class="ic-sm"></i></button>
          </div>
        </div>
      </div>

      <div class="detail-body">
        ${pipeline ? `<div class="detail-pipeline-wrap">${pipeline}</div>` : ''}

        <div class="detail-fields-row">
          <div class="detail-field">
            <div class="detail-field-label">Responsável</div>
            <div id="detail-owner-picker"></div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Prazo da etapa atual</div>
            <input type="date" class="form-control" id="detail-stage-due" value="${d.stageDueDate || ''}" onchange="markDetailDirty('stageDue')">
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Prazo final</div>
            <input type="date" class="form-control" id="detail-deadline" value="${d.deadline || ''}" onchange="markDetailDirty('deadline')">
          </div>
        </div>

        <div class="detail-meta-grid">
          <div class="detail-field">
            <div class="detail-field-label">Fluxo</div>
            <div class="detail-field-value">${esc(flow?.name || '—')}</div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Entrou na etapa em</div>
            <div class="detail-field-value">${fmtDateTime(d.stageEnteredAt)}</div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Criada em</div>
            <div class="detail-field-value">${fmtDateTime(d.createdAt)}</div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Concluída em</div>
            <div class="detail-field-value">${d.completedAt ? fmtDate(d.completedAt) : '—'}</div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Prioridade</div>
            <div class="detail-field-value">${priorityPill(d.priority)}</div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Horas estimadas</div>
            <div class="detail-field-value" style="display:flex;align-items:center;gap:8px">
              ${d.estimatedHours ? esc(fmtHours(d.estimatedHours)) : '<span style="color:var(--text-muted)">—</span>'}
              <button class="detail-icon-btn" title="Editar estimativa" onclick="editEstimatedInline()"><i data-lucide="pencil" class="ic-sm"></i></button>
            </div>
          </div>
          <div class="detail-field">
            <div class="detail-field-label">Horas realizadas</div>
            <div class="detail-field-value">
              ${(() => {
                const total = (d.timeEntries || []).reduce((a,e) => a + (Number(e.hours)||0), 0);
                if (!d.estimatedHours) return total > 0 ? esc(fmtHours(total)) : '<span style="color:var(--text-muted)">—</span>';
                const pct = Math.round(total / d.estimatedHours * 100);
                const cls = pct > 100 ? 'deadline-late' : '';
                return `<span class="${cls}">${esc(fmtHours(total))} <span style="color:var(--text-muted);font-size:11px">(${pct}%)</span></span>`;
              })()}
            </div>
          </div>
        </div>

        <!-- Entregáveis no detalhe — botão Salvar explícito (não confia em onchange) -->
        <div class="detail-section-block">
          <div class="detail-section-title">Entregáveis</div>
          <div class="qty-grid">
            <div class="qty-cell">
              <input class="form-control" id="detail-qty-pieces" type="number" min="0" step="1" value="${d.qtyPieces || ''}" placeholder="0">
              <span class="qty-cell-label">Peças <span class="qty-cell-hint" title="Peças únicas. Ex.: 1 criativo + 1 carrossel = 2">?</span></span>
            </div>
            <div class="qty-cell">
              <input class="form-control" id="detail-qty-arts" type="number" min="0" step="1" value="${d.qtyArts || ''}" placeholder="0">
              <span class="qty-cell-label">Artes <span class="qty-cell-hint" title="Total de artes individuais. Ex.: 1 criativo + carrossel de 3 telas = 4 artes">?</span></span>
            </div>
            <div class="qty-cell">
              <input class="form-control" id="detail-qty-variations" type="number" min="0" step="1" value="${d.qtyVariations || ''}" placeholder="0">
              <span class="qty-cell-label">Variações <span class="qty-cell-hint" title="Exportações/formatos. Ex.: 1 criativo em 3 formatos = 3 variações">?</span></span>
            </div>
          </div>
          <div class="detail-deliverable-attr">
            <label class="form-label" style="margin:0">Atribuir a <span class="qty-cell-hint" title="Quem realmente executou estas artes. Se vazio, conta pro responsável atual da demanda (que pode estar em outra etapa do fluxo).">?</span></label>
            <select class="form-control" id="detail-deliverable-user" style="max-width:280px"></select>
            <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="saveDeliverablesDetail()"><i data-lucide="save" class="ic-sm"></i> Salvar entregáveis</button>
          </div>
        </div>

        <div class="detail-section-block">
          <div class="field-head">
            <div class="field-label">Briefing</div>
            <button class="detail-icon-btn" title="Editar briefing" onclick="editBriefingInline()"><i data-lucide="pencil" class="ic-sm"></i></button>
          </div>
          <div id="detail-briefing-view">
            ${d.briefing ? `<a class="detail-briefing-link" href="${esc(normalizeUrl(d.briefing))}" target="_blank" rel="noopener noreferrer">${esc(d.briefing)}</a>` : '<span style="color:var(--text-muted)">Sem briefing cadastrado</span>'}
          </div>
          <div class="field-label" style="margin-top:18px">Descrição</div>
          <div id="detail-description-view">
            ${d.description ? `<div class="detail-description md-body">${mdRender(d.description)}</div>` : '<span style="color:var(--text-muted)">Sem descrição cadastrada</span>'}
          </div>
        </div>

        <div class="detail-section-block">
          <div class="field-head">
            <div class="field-label">Arquivos da Demanda</div>
            <div style="display:flex;gap:4px">
              <input type="file" id="detail-att-file-input" multiple style="display:none" onchange="handleDetailAttachmentFiles(event)">
              <button class="detail-icon-btn" title="Anexar arquivo" onclick="$('detail-att-file-input').click()"><i data-lucide="paperclip" class="ic-sm"></i></button>
              <input type="file" id="detail-att-img-input" accept="image/*" multiple style="display:none" onchange="handleDetailAttachmentImages(event)">
              <button class="detail-icon-btn" title="Anexar imagem" onclick="$('detail-att-img-input').click()"><i data-lucide="image" class="ic-sm"></i></button>
              <button class="detail-icon-btn" title="Adicionar link" onclick="addDetailAttachmentLink()"><i data-lucide="link" class="ic-sm"></i></button>
            </div>
          </div>
          <div class="demand-att-list" id="detail-attachments-list">${renderDemandAttList(d.attachments || [], true)}</div>
        </div>

        ${d.recurrence?.enabled ? `<div class="detail-section-block" style="padding:12px 18px;display:flex;align-items:center;gap:10px">
          <i data-lucide="repeat" class="ic-sm" style="color:var(--accent-text)"></i>
          <span style="font-size:12px;color:var(--text-dim)">Demanda recorrente · <strong>${esc({daily:'Diariamente',weekly:'Semanalmente',monthly:'Mensalmente'}[d.recurrence.pattern] || d.recurrence.pattern)}</strong>${d.recurrence.lastGeneratedDate ? ' · Última geração: ' + fmtDate(d.recurrence.lastGeneratedDate) : ''}</span>
        </div>` : ''}

        ${renderChecklist(d)}

        <div class="detail-section-heading">Comentários</div>
        <div class="comment-list">${comments || '<div class="hours-empty">Nenhum comentário ainda. Use @ para marcar alguém da equipe.</div>'}</div>
        <div class="comment-compose">
          <textarea class="form-control" id="comment-input" placeholder="Digite seu comentário — você pode colar (Ctrl+V) ou arrastar imagens aqui" oninput="mentionWatch(this); draftSaveComment(this)" onkeydown="mentionKeys(event)"></textarea>
          <div class="mention-pop" id="mention-pop"></div>
          <div class="comment-compose-bar">
            <div class="comment-attach-btns">
              <input type="file" id="comment-file-input" multiple style="display:none" onchange="handleCommentFiles(event)">
              <button class="detail-icon-btn" onclick="$('comment-file-input').click()" title="Anexar arquivo"><i data-lucide="paperclip" class="ic-sm"></i></button>
              <input type="file" id="comment-img-input" accept="image/*" multiple style="display:none" onchange="handleCommentImages(event)">
              <button class="detail-icon-btn" onclick="$('comment-img-input').click()" title="Anexar imagem"><i data-lucide="image" class="ic-sm"></i></button>
            </div>
            <button class="btn btn-primary btn-sm" onclick="sendComment()">Enviar comentário</button>
          </div>
          <div class="comment-pending-files" id="comment-pending-files"></div>
        </div>

        <div class="detail-section-divider"></div>

        <div class="detail-section-heading">
          <span>Apontamentos de Horas</span>
          ${totalHours > 0 ? `<span class="detail-section-heading-total">Total · ${fmtHours(totalHours)}</span>` : ''}
        </div>
        <div class="time-list">${timeRows || '<div class="hours-empty">Nenhuma hora apontada ainda.</div>'}</div>
      </div>
    </div>`;

  // Footer sticky: apontamento (início, término, horas) | separador | etapa
  $('detail-footer').innerHTML = `
    <div class="detail-footer-section">
      <div class="detail-footer-group">
        <div class="detail-footer-label">Início</div>
        <input class="form-control footer-date" id="time-start" type="datetime-local">
      </div>
      <div class="detail-footer-group">
        <div class="detail-footer-label">Término</div>
        <input class="form-control footer-date" id="time-end" type="datetime-local" onchange="autoHours()">
      </div>
      <div class="detail-footer-group" style="flex:0 0 auto">
        <div class="detail-footer-label">Horas</div>
        <div class="hours-input-group">
          <input class="form-control" id="time-hours" type="number" min="0" step="0.25" placeholder="0">
          <button class="btn hours-timer-btn" id="timer-toggle-btn" onclick="toggleTimer()" title="Cronômetro"><i data-lucide="play" class="ic-sm"></i></button>
        </div>
        <div class="timer-display" id="timer-display" style="display:none"><span id="timer-clock">00:00:00</span></div>
      </div>
      <div class="detail-footer-group" style="flex:0 0 auto;justify-content:flex-end">
        <div class="detail-footer-label" style="visibility:hidden">.</div>
        <button class="btn btn-primary hours-add-btn" onclick="addTimeEntry()" title="Apontar horas"><i data-lucide="check" class="ic-sm"></i></button>
      </div>
    </div>
    <div class="detail-footer-sep"></div>
    <div class="detail-footer-section detail-footer-stage">
      <div class="detail-footer-group" style="flex:1;min-width:0">
        <div class="detail-footer-label">Etapa</div>
        <div class="detail-footer-stage-controls">
          <button class="detail-footer-arrow" ${idx <= 0 ? 'disabled' : ''} onclick="moveStage(-1)" title="Etapa anterior"><i data-lucide="chevron-left"></i></button>
          <div id="detail-stage-picker" style="flex:1"></div>
          <button class="detail-footer-arrow primary" ${!flow || idx < 0 || idx >= active.length - 1 ? 'disabled' : ''} onclick="moveStage(1)" title="Avançar etapa"><i data-lucide="chevron-right"></i></button>
        </div>
      </div>
    </div>
  `;

  // Owner picker (custom dropdown com avatar)
  buildOwnerPicker(d, owner);
  // Stage picker (custom dropdown)
  buildStagePicker(d, flow);
  // Restaura estado do cronômetro
  refreshTimerUI();
  if (getTimer(detailId).running) ensureTimerInterval();

  detailDirty = {};
  // Popula select de "atribuir entregáveis a" — só agora que o DOM tá renderizado
  fillDeliverableUserSelect('detail-deliverable-user', d.deliverableUserId || '');
  paintIcons();
  // Garante que datetime-local inputs recém-renderizados usem o picker customizado
  if (typeof fdpConvertAll === 'function') fdpConvertAll();
  // Drag-and-drop de arquivos no modal de detalhe
  setupDragDrop('#detail-modal .detail-content', 'detail-attachments-list', processDroppedFiles);
  // Paste + drag-and-drop de imagens direto no compositor de comentários
  setupCommentComposer();
}

/* Owner picker — dropdown customizado com avatar do responsável atual */
function buildOwnerPicker(d, owner) {
  const list = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const el = $('detail-owner-picker');
  const ownerLabel = owner
    ? `${avatarHTML(owner)}<span class="owner-name">${esc(owner.name)}</span>`
    : `<span class="avatar" style="background:var(--surface-3);color:var(--text-muted)">?</span><span class="owner-name" style="color:var(--text-muted)">Sem responsável</span>`;
  el.innerHTML = `
    <div class="cdrop" id="owner-cdrop">
      <div class="owner-picker" onclick="toggleCdrop('owner-cdrop', event)">
        ${ownerLabel}
        <span class="caret"><i data-lucide="chevron-down" class="ic-sm"></i></span>
      </div>
      <div class="cdrop-menu">
        <div class="cdrop-item ${!d.ownerId ? 'active' : ''}" onclick="changeOwner(null)">
          <span class="avatar" style="background:var(--surface-3);color:var(--text-muted)">?</span>
          <span>Sem responsável</span>
        </div>
        ${list.map(u => `
          <div class="cdrop-item ${u.id === d.ownerId ? 'active' : ''}" onclick="changeOwner('${u.id}')">
            ${avatarHTML(u)}
            <span>${esc(u.name)}${u.role ? ' · ' + esc(u.role) : ''}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

/* Stage picker para o footer */
function buildStagePicker(d, flow) {
  const el = $('detail-stage-picker');
  if (!flow) { el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Sem fluxo</span>'; return; }
  const stages = activeStagesOf(d, flow);
  // Busca a etapa atual no pool completo (originais + stageAdditions) já
  // com overrides aplicados — antes olhava só flow.stages, e o label caía
  // pra "Selecionar etapa" quando d.status era uma etapa adicionada.
  const cur = stages.find(s => s.id === d.status);
  el.innerHTML = `
    <div class="cdrop" id="stage-cdrop">
      <div class="cdrop-trigger" onclick="toggleCdrop('stage-cdrop', event)">
        ${cur ? `<span class="cdrop-dot" style="background:${cur.color}"></span>` : ''}
        <span class="cdrop-label">${esc(cur?.label || 'Selecionar etapa')}</span>
        <span class="cdrop-caret"><i data-lucide="chevron-down" class="ic-xs"></i></span>
      </div>
      <div class="cdrop-menu">
        ${stages.map(s => `
          <div class="cdrop-item ${s.id === d.status ? 'active' : ''}" onclick="pickStage('${s.id}')">
            <span class="cdrop-dot" style="background:${s.color}"></span>
            <span>${esc(s.label)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function toggleCdrop(id, ev) {
  if (ev) ev.stopPropagation();
  // fecha todos
  document.querySelectorAll('.cdrop.open').forEach(c => { if (c.id !== id) c.classList.remove('open'); });
  const c = document.getElementById(id);
  if (c) c.classList.toggle('open');
}
document.addEventListener('click', ev => {
  if (!ev.target.closest('.cdrop')) {
    document.querySelectorAll('.cdrop.open').forEach(c => c.classList.remove('open'));
  }
});

/* Stage change via picker */
async function pickStage(stageId) {
  const d = demandById(detailId); if (!d || stageId === d.status) {
    document.querySelectorAll('.cdrop.open').forEach(c => c.classList.remove('open'));
    return;
  }
  document.querySelectorAll('.cdrop.open').forEach(c => c.classList.remove('open'));
  try {
    const upd = await api('/demands/' + d.id, 'PUT', { status: stageId });
    patchDemand(upd);
    toast('Etapa atualizada!');
    renderDetail();
    renderCurrent();
    fetchNotifications();
  } catch (e) { toast(e.message, 'error'); }
}

/* Dirty state tracking — campos de data salvos manualmente */
let detailDirty = {};
function markDetailDirty(key) { detailDirty[key] = true; renderDetailDirtyBadge(); }
function hasUnsavedDetailEdits() {
  if (Object.keys(detailDirty).length > 0) return true;
  const ci = document.getElementById('comment-input');
  if (ci && ci.value.trim()) return true;
  if (typeof pendingAttachments !== 'undefined' && pendingAttachments && pendingAttachments.length) return true;
  // Verifica se há comentários em edição inline
  if (document.getElementById('edit-comment-text')) return true;
  return false;
}
function discardDetailEdits() { detailDirty = {}; }
/* ── HISTÓRICO DA DEMANDA ── */
function openDetailHistory() {
  detailView = 'history';
  renderDetail();
}
function backToDetailMain() {
  detailView = 'main';
  stagesEditDraft = null;
  renderDetail();
}

/* ── EDITOR DE ETAPAS (por instância da demanda) ──
   Permite (a) ativar/desativar etapas e (b) sobrescrever o responsável padrão da etapa
   APENAS nesta demanda. O fluxo original permanece intacto. */
/* Constrói o "pool" de IDs válidos pra esta demanda: originais do fluxo +
   as etapas adicionadas por instância (stageAdditions). Usado como fonte de
   verdade em toda a UI e validação do editor "Etapas desta demanda". */
function _demandStageIdPool(d) {
  const flow = flowById(d.flowId);
  const ids = flow ? flow.stages.map(s => s.id) : [];
  const adds = Array.isArray(d.stageAdditions) ? d.stageAdditions.map(s => s.id) : [];
  return [...ids, ...adds];
}
function openDetailStages() {
  const d = demandById(detailId); if (!d) return;
  const poolIds = _demandStageIdPool(d);
  const poolSet = new Set(poolIds);
  // Ordem inicial: usa a custom existente + qualquer etapa NOVA (do fluxo ou
  // das adicionadas por instância) no fim.
  const customOrder = Array.isArray(d.stageOrder) ? d.stageOrder.filter(id => poolSet.has(id)) : [];
  const set = new Set(customOrder);
  const remaining = poolIds.filter(id => !set.has(id));
  const initialOrder = customOrder.length ? [...customOrder, ...remaining] : poolIds;
  stagesEditDraft = {
    skipped: new Set(Array.isArray(d.skippedStages) ? d.skippedStages : []),
    responsibles: { ...(d.stageResponsibles && typeof d.stageResponsibles === 'object' ? d.stageResponsibles : {}) },
    labels: { ...(d.stageLabels && typeof d.stageLabels === 'object' ? d.stageLabels : {}) },
    order: initialOrder,
  };
  detailView = 'stages';
  renderDetail();
}
function toggleStageDraft(stageId) {
  if (!stagesEditDraft) return;
  if (stagesEditDraft.skipped.has(stageId)) stagesEditDraft.skipped.delete(stageId);
  else stagesEditDraft.skipped.add(stageId);
  renderDetail();
}
function setStageResponsibleDraft(stageId, value) {
  if (!stagesEditDraft) return;
  // value: '' = sem responsável (null override) · '__default__' = remove override · userId = override
  if (value === '__default__') {
    delete stagesEditDraft.responsibles[stageId];
  } else if (value === '') {
    stagesEditDraft.responsibles[stageId] = null;
  } else {
    stagesEditDraft.responsibles[stageId] = value;
  }
  renderDetail();
}
function setStageLabelDraft(stageId, value) {
  if (!stagesEditDraft) return;
  const d = demandById(detailId); if (!d) return;
  // Pool: fluxo + adicionadas (as duas podem ser renomeadas)
  const flow = flowById(d.flowId);
  let orig = flow?.stages.find(s => s.id === stageId);
  if (!orig) orig = (d.stageAdditions || []).find(s => s.id === stageId);
  if (!orig) return;
  const trimmed = (value || '').trim();
  if (!trimmed || trimmed === orig.label) delete stagesEditDraft.labels[stageId];
  else stagesEditDraft.labels[stageId] = trimmed.slice(0, 80);
  // Atualiza estado do botão Salvar sem perder foco do input
  refreshStagesEditButtons(d);
}
function refreshStagesEditButtons(d) {
  const dirty = isStagesDraftDirty(d);
  const empty = !stagesEditDraft || (
    stagesEditDraft.skipped.size === 0 &&
    Object.keys(stagesEditDraft.responsibles).length === 0 &&
    Object.keys(stagesEditDraft.labels).length === 0 &&
    !isStagesOrderCustomized(d)
  );
  const saveBtn = document.getElementById('stages-edit-save');
  const resetBtn = document.getElementById('stages-edit-reset');
  if (saveBtn) saveBtn.disabled = !dirty;
  if (resetBtn) resetBtn.disabled = empty;
}
function isStagesOrderCustomized(d) {
  if (!stagesEditDraft) return false;
  // Ordem padrão = originais do fluxo + adicionadas (nessa ordem).
  const baseOrder = _demandStageIdPool(d);
  if (stagesEditDraft.order.length !== baseOrder.length) return true;
  return stagesEditDraft.order.some((id, i) => baseOrder[i] !== id);
}
function resetStagesDraft() {
  if (!stagesEditDraft) return;
  const d = demandById(detailId);
  stagesEditDraft = {
    skipped: new Set(),
    responsibles: {},
    labels: {},
    order: d ? _demandStageIdPool(d) : [],
  };
  renderDetail();
}
async function saveStagesDraft() {
  if (!stagesEditDraft) return;
  const d = demandById(detailId); if (!d) return;
  try {
    const upd = await api('/demands/' + d.id + '/skipped-stages', 'PUT', {
      skippedStages: [...stagesEditDraft.skipped],
      stageResponsibles: stagesEditDraft.responsibles,
      stageOrder: stagesEditDraft.order,
      stageLabels: stagesEditDraft.labels,
    });
    patchDemand(upd);
    stagesEditDraft = null;
    detailView = 'main';
    toast('Etapas desta demanda atualizadas!');
    renderDetail();
    renderCurrent();
  } catch (e) { toast(e.message, 'error'); }
}
function isStagesDraftDirty(d) {
  if (!stagesEditDraft) return false;
  // skippedStages
  const origSkip = new Set(d.skippedStages || []);
  if (origSkip.size !== stagesEditDraft.skipped.size) return true;
  for (const id of stagesEditDraft.skipped) if (!origSkip.has(id)) return true;
  // responsibles
  const origResp = (d.stageResponsibles && typeof d.stageResponsibles === 'object') ? d.stageResponsibles : {};
  const respKeys = new Set([...Object.keys(origResp), ...Object.keys(stagesEditDraft.responsibles)]);
  for (const k of respKeys) {
    if ((origResp[k] ?? null) !== (stagesEditDraft.responsibles[k] ?? null)) return true;
    if (!Object.prototype.hasOwnProperty.call(origResp, k) !== !Object.prototype.hasOwnProperty.call(stagesEditDraft.responsibles, k)) return true;
  }
  // labels
  const origLabels = (d.stageLabels && typeof d.stageLabels === 'object') ? d.stageLabels : {};
  const labelKeys = new Set([...Object.keys(origLabels), ...Object.keys(stagesEditDraft.labels)]);
  for (const k of labelKeys) {
    if ((origLabels[k] || null) !== (stagesEditDraft.labels[k] || null)) return true;
  }
  // order — compara contra ordem salva; se não há, usa o pool default (fluxo + additions).
  const origOrder = Array.isArray(d.stageOrder) && d.stageOrder.length
    ? d.stageOrder
    : _demandStageIdPool(d);
  if (origOrder.length !== stagesEditDraft.order.length) return true;
  if (stagesEditDraft.order.some((id, i) => origOrder[i] !== id)) return true;
  return false;
}

/* Drag & drop para reordenar etapas no editor por instância */
let stagesDragIdx = null;
function stagesDragStart(e, i) {
  stagesDragIdx = i;
  e.dataTransfer.effectAllowed = 'move';
  // Só o grip é draggable — a classe .dragging deve ir na row pai
  const row = e.currentTarget.closest('.stages-edit-row') || e.currentTarget;
  row.classList.add('dragging');
}
function stagesDragOver(e, i) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function stagesDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function stagesDrop(e, i) {
  e.preventDefault();
  if (!stagesEditDraft || stagesDragIdx === null || stagesDragIdx === i) {
    stagesDragIdx = null;
    document.querySelectorAll('.stages-edit-row').forEach(r => r.classList.remove('dragging','drag-over'));
    return;
  }
  const [moved] = stagesEditDraft.order.splice(stagesDragIdx, 1);
  stagesEditDraft.order.splice(i, 0, moved);
  stagesDragIdx = null;
  renderDetail();
}
function stagesDragEnd() {
  stagesDragIdx = null;
  document.querySelectorAll('.stages-edit-row').forEach(r => r.classList.remove('dragging','drag-over'));
}
function renderDetailStages(d) {
  const flow = flowById(d.flowId);
  // Pool completo de etapas visíveis pra essa demanda: originais do fluxo + as
  // adicionadas por instância (stageAdditions). O draft trata os dois de forma
  // uniforme — reordenação, rename e skip aplicam a qualquer uma.
  const additions = Array.isArray(d.stageAdditions) ? d.stageAdditions : [];
  const poolById = new Map();
  if (flow) flow.stages.forEach(s => poolById.set(s.id, s));
  additions.forEach(s => poolById.set(s.id, s));
  // Garante draft inicializado (caso entre direto pelo deep link, por ex.)
  if (!stagesEditDraft) {
    // Ordem inicial: usa d.stageOrder se existir; senão originais + adicionadas.
    let initOrder;
    if (Array.isArray(d.stageOrder) && d.stageOrder.length) {
      const seen = new Set();
      initOrder = d.stageOrder.filter(id => poolById.has(id) && !seen.has(id) && seen.add(id));
      // Segurança: qualquer id novo (não no stageOrder) vai no fim.
      poolById.forEach((_, id) => { if (!seen.has(id)) initOrder.push(id); });
    } else {
      initOrder = [...(flow ? flow.stages.map(s => s.id) : []), ...additions.map(s => s.id)];
    }
    stagesEditDraft = { skipped: new Set(d.skippedStages || []), responsibles: { ...(d.stageResponsibles || {}) }, labels: { ...(d.stageLabels || {}) }, order: initOrder };
  }
  const draft = stagesEditDraft;
  const dirty = isStagesDraftDirty(d);
  const empty = draft.skipped.size === 0 && Object.keys(draft.responsibles).length === 0 && Object.keys(draft.labels).length === 0 && !isStagesOrderCustomized(d);
  const sortedUsers = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));

  // Itera na ordem do draft, resolvendo cada ID no pool completo (fluxo + additions)
  const rowsList = draft.order.map(id => poolById.get(id)).filter(Boolean);

  $('detail-content').innerHTML = `
    <div class="detail-content">
      <div class="detail-head">
        <div class="detail-head-top">
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-ghost btn-sm" onclick="backToDetailMain()" style="display:inline-flex;align-items:center;gap:6px">
              <i data-lucide="arrow-left" class="ic-sm"></i> Voltar
            </button>
            <div>
              <div class="detail-title">Etapas desta demanda</div>
              <div class="detail-head-meta">
                <span>${esc(d.name)}</span>
                ${flow ? `<span class="meta-sep">|</span><span>Fluxo: ${esc(flow.name)}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="detail-head-actions">
            <button id="stages-edit-reset" class="btn btn-ghost btn-sm" onclick="resetStagesDraft()" ${empty ? 'disabled' : ''}>Restaurar padrões</button>
            <button id="stages-edit-save" class="btn btn-primary btn-sm" onclick="saveStagesDraft()" ${!dirty ? 'disabled' : ''}>Salvar</button>
            <button class="detail-icon-btn" title="Fechar" onclick="attemptCloseModal('detail-modal')"><i data-lucide="x" class="ic-sm"></i></button>
          </div>
        </div>
      </div>
      <div class="detail-body">
        <div class="stages-edit-hint">
          Arraste pela alça à esquerda para reordenar, edite o nome direto no campo e troque
          o responsável no dropdown. As alterações afetam <strong>apenas esta demanda</strong> —
          o fluxo original <strong>${esc(flow?.name || '—')}</strong> continua intacto.
        </div>
        ${flow ? `<div class="stages-edit-list">${rowsList.map((s, i) => {
          const isCurrent = s.id === d.status;
          const isOn = !draft.skipped.has(s.id);
          const hasRespOverride = Object.prototype.hasOwnProperty.call(draft.responsibles, s.id);
          const currentResp = hasRespOverride ? draft.responsibles[s.id] : (s.responsibleId || null);
          const defaultUser = s.responsibleId ? userById(s.responsibleId) : null;
          const defaultLabel = defaultUser ? `Padrão do fluxo: ${defaultUser.name}` : 'Padrão do fluxo: sem responsável';
          const selectId = `stages-resp-${s.id}`;
          const currentLabel = draft.labels[s.id] || s.label;
          const hasLabelOverride = !!draft.labels[s.id];
          const lockedReason = isCurrent ? 'Etapa atual — mude antes para desativar' : '';
          return `<div class="stages-edit-row ${isOn ? 'on' : 'off'} ${isCurrent ? 'locked' : ''}"
                       ondragover="stagesDragOver(event, ${i})"
                       ondragleave="stagesDragLeave(event)"
                       ondrop="stagesDrop(event, ${i})"
                       ondragend="stagesDragEnd()"
                       ${lockedReason ? `title="${esc(lockedReason)}"` : ''}>
            <div class="stages-edit-grip" draggable="true" ondragstart="stagesDragStart(event, ${i})" title="Arraste para reordenar"><i data-lucide="grip-vertical" class="ic-sm"></i></div>
            <input type="checkbox" ${isOn ? 'checked' : ''} ${isCurrent ? 'disabled' : ''} onchange="toggleStageDraft('${s.id}')">
            <span class="stages-edit-num">${String(i + 1).padStart(2, '0')}</span>
            <span class="pill-dot" style="background:${s.color}"></span>
            <input class="form-control stages-edit-label-input" value="${esc(currentLabel)}" placeholder="${esc(s.label)}" oninput="setStageLabelDraft('${s.id}', this.value)" maxlength="80">
            <div class="stages-edit-badges">
              ${s.done ? '<span class="pill pill-success" style="font-size:9px">Conclusão</span>' : ''}
              ${isCurrent ? '<span class="pill" style="font-size:9px;background:var(--accent-dim);color:var(--accent-text)">Atual</span>' : ''}
              ${!isOn && !isCurrent ? '<span class="pill pill-muted" style="font-size:9px">Desativada</span>' : ''}
              ${hasLabelOverride ? '<span class="pill" style="font-size:9px;background:var(--accent-dim);color:var(--accent-text)">Renomeada</span>' : ''}
              ${hasRespOverride ? '<span class="pill" style="font-size:9px;background:var(--accent-dim);color:var(--accent-text)">Resp. customizado</span>' : ''}
            </div>
            <div class="stages-edit-resp-wrap">
              <select id="${selectId}" class="form-control" onchange="setStageResponsibleDraft('${s.id}', this.value)">
                <option value="__default__" ${!hasRespOverride ? 'selected' : ''}>${esc(defaultLabel)}</option>
                <option value="" ${hasRespOverride && currentResp === null ? 'selected' : ''}>— Sem responsável —</option>
                ${sortedUsers.map(u => `<option value="${u.id}" ${currentResp === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
              </select>
            </div>
          </div>`;
        }).join('')}</div>` : '<div class="hours-empty">Esta demanda não tem fluxo associado.</div>'}
      </div>
    </div>`;
  paintIcons();
  // Aplica dropdowns com avatar nos selects de responsável
  if (flow) {
    rowsList.forEach(s => applyFilterDropdown(`stages-resp-${s.id}`, { userIcon: true }));
  }
}

/* ── RECORRÊNCIA ── */
function onRecurrenceToggle() {
  const enabled = $('detail-rec-enabled').checked;
  $('detail-rec-config').style.display = enabled ? 'block' : 'none';
}
function onRecurrencePatternChange() {
  const p = $('detail-rec-pattern').value;
  $('detail-rec-weekday-group').style.display = p === 'weekly' ? '' : 'none';
  $('detail-rec-monthday-group').style.display = p === 'monthly' ? '' : 'none';
}
/* Popula <select> de "atribuir entregáveis a" — usuários ativos do workspace +
   opção vazia (= cai pro responsável atual da demanda). */
function fillDeliverableUserSelect(selId, currentValue) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const list = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  sel.innerHTML = '<option value="">— Responsável atual da demanda —</option>' +
    list.map(u => `<option value="${u.id}" ${u.id === currentValue ? 'selected' : ''}>${esc(u.name)}${u.role ? ' · ' + esc(u.role) : ''}</option>`).join('');
}

/* Salva os 3 campos de entregáveis + usuário atribuído (do detail) via botão explícito. */
async function saveDeliverablesDetail() {
  if (!detailId) return;
  const payload = {
    qtyPieces: Number($('detail-qty-pieces')?.value) || 0,
    qtyArts: Number($('detail-qty-arts')?.value) || 0,
    qtyVariations: Number($('detail-qty-variations')?.value) || 0,
    deliverableUserId: $('detail-deliverable-user')?.value || null
  };
  console.log('[saveDeliverables] payload:', payload);
  try {
    const upd = await api('/demands/' + detailId, 'PUT', payload);
    console.log('[saveDeliverables] resposta:', { p: upd.qtyPieces, a: upd.qtyArts, v: upd.qtyVariations, by: upd.deliverableUserId });
    patchDemand(upd);
    toast('Entregáveis atualizados!');
    renderDetail();
  } catch (e) {
    console.error('[saveDeliverables] erro:', e);
    toast(e.message || 'Erro ao salvar entregáveis', 'error');
  }
}

async function editEstimatedInline() {
  const d = demandById(detailId); if (!d) return;
  const val = await showPrompt({
    title: 'Horas estimadas',
    message: 'Quantas horas estima para concluir esta demanda?',
    defaultValue: d.estimatedHours ? String(d.estimatedHours) : '',
    placeholder: 'Ex: 4',
    okLabel: 'Salvar'
  });
  if (val === null) return;
  const num = val.trim() === '' ? null : Number(val);
  try {
    const upd = await api('/demands/' + detailId, 'PUT', { estimatedHours: num });
    patchDemand(upd);
    toast('Estimativa atualizada!');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}

async function saveRecurrence() {
  const enabled = $('detail-rec-enabled').checked;
  const recurrence = enabled ? {
    enabled: true,
    pattern: $('detail-rec-pattern').value,
    weekDay: parseInt($('detail-rec-weekday').value, 10),
    monthDay: parseInt($('detail-rec-monthday').value, 10),
    startDate: $('detail-rec-start').value || null,
    endDate: $('detail-rec-end').value || null
  } : { enabled: false };
  try {
    const upd = await api('/demands/' + detailId, 'PUT', { recurrence });
    patchDemand(upd);
    toast(enabled ? 'Recorrência ativada!' : 'Recorrência desativada.');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}

function describeHistory(h, d) {
  const u = userById(h.userId);
  const uname = u?.name || 'Usuário';
  const dt = h.details || {};
  const flow = flowById(d.flowId);
  const stageLabel = sid => {
    if (!flow) return sid;
    const s = flow.stages.find(x => x.id === sid);
    return s ? s.label : 'etapa removida';
  };
  switch (h.action) {
    case 'created':            return `criou a demanda <strong>${esc(dt.demandName || d.name)}</strong>`;
    case 'renamed':            return `renomeou de <strong>${esc(dt.from || '')}</strong> para <strong>${esc(dt.to || '')}</strong>`;
    case 'owner_set': {
      const target = userById(dt.ownerId);
      return `atribuiu o responsável <strong>${esc(target?.name || '—')}</strong>`;
    }
    case 'owner_changed': {
      const from = userById(dt.fromId), to = userById(dt.toId);
      if (!from && to) return `definiu o responsável como <strong>${esc(to.name)}</strong>`;
      if (from && !to) return `removeu o responsável (era <strong>${esc(from.name)}</strong>)`;
      return `alterou o responsável de <strong>${esc(from?.name || '—')}</strong> para <strong>${esc(to?.name || '—')}</strong>`;
    }
    case 'owner_auto_assigned': {
      const to = userById(dt.toId);
      return `responsável atribuído automaticamente: <strong>${esc(to?.name || '—')}</strong>`;
    }
    case 'project_changed':    return `alterou o projeto da demanda`;
    case 'description_changed':return `alterou a descrição`;
    case 'briefing_changed':   return `alterou o link do briefing`;
    case 'deadline_changed':   return `alterou o prazo final${dt.to ? ' para <strong>' + esc(fmtDate(dt.to)) + '</strong>' : ' (removido)'}`;
    case 'stage_due_changed':  return `alterou o prazo da etapa${dt.to ? ' para <strong>' + esc(fmtDate(dt.to)) + '</strong>' : ' (removido)'}`;
    case 'flow_changed':       return `alterou o fluxo da demanda`;
    case 'stage_changed':      return `avançou da etapa <strong>${esc(stageLabel(dt.fromId))}</strong> para <strong>${esc(stageLabel(dt.toId))}</strong>`;
    case 'attachment_added':   return `anexou ${dt.kind === 'link' ? 'um link' : 'um arquivo'}: <strong>${esc(dt.name || '')}</strong>`;
    case 'attachment_removed': return `removeu o anexo <strong>${esc(dt.name || '')}</strong>`;
    case 'comment_added':      return `comentou${dt.preview ? ': <em>"' + esc(dt.preview) + (dt.preview.length >= 80 ? '…' : '') + '"</em>' : ''}`;
    case 'comment_edited':     return `editou um comentário`;
    case 'comment_removed':    return `removeu um comentário`;
    case 'time_added':         return `apontou <strong>${esc(fmtHours(dt.hours))}</strong> de trabalho${dt.stageId ? ' em <strong>' + esc(stageLabel(dt.stageId)) + '</strong>' : ''}`;
    case 'time_edited':        return `editou apontamento (agora <strong>${esc(fmtHours(dt.hours))}</strong>)`;
    case 'time_removed':       return `removeu um apontamento de <strong>${esc(fmtHours(dt.hours))}</strong>`;
    case 'estimated_hours_changed': return `alterou a estimativa de horas${dt.to ? ' para <strong>' + esc(fmtHours(dt.to)) + '</strong>' : ' (removida)'}`;
    case 'priority_changed':    return `alterou a prioridade de <strong>${esc(priorityLabel(dt.from))}</strong> para <strong>${esc(priorityLabel(dt.to))}</strong>`;
    case 'recurrence_enabled': return `ativou a recorrência (<strong>${esc(dt.pattern || '')}</strong>)`;
    case 'recurrence_disabled':return `desativou a recorrência`;
    case 'recurrence_changed': return `alterou a configuração de recorrência`;
    case 'created_from_recurrence': return `gerou esta demanda automaticamente pela recorrência`;
    case 'checklist_added':    return `adicionou item ao checklist: <em>"${esc((dt.text || '').slice(0, 60))}${(dt.text || '').length > 60 ? '…' : ''}"</em>`;
    case 'checklist_edited':   return `editou um item do checklist`;
    case 'checklist_removed':  return `removeu item do checklist: <em>"${esc((dt.text || '').slice(0, 60))}${(dt.text || '').length > 60 ? '…' : ''}"</em>`;
    case 'checklist_checked':  return `concluiu item do checklist: <em>"${esc((dt.text || '').slice(0, 60))}${(dt.text || '').length > 60 ? '…' : ''}"</em>`;
    case 'checklist_unchecked':return `desmarcou item do checklist`;
    case 'stages_customized': {
      const flow = flowById(d.flowId);
      const lookup = id => flow?.stages.find(s => s.id === id)?.label || '(removida)';
      const added = (h.detail?.added || []).map(lookup);
      const removed = (h.detail?.removed || []).map(lookup);
      const respChanges = h.detail?.responsibles || [];
      const labelChanges = h.detail?.labelChanges || [];
      const orderChanged = !!h.detail?.orderChanged;
      const parts = [];
      if (added.length) parts.push(`desativou: <em>${esc(added.join(', '))}</em>`);
      if (removed.length) parts.push(`reativou: <em>${esc(removed.join(', '))}</em>`);
      if (orderChanged) parts.push('reordenou etapas');
      if (labelChanges.length) {
        const names = labelChanges.map(c => `${esc(lookup(c.stageId))} → <em>${esc(c.to || lookup(c.stageId))}</em>`);
        parts.push(`renomeou: ${names.join(', ')}`);
      }
      if (respChanges.length) {
        const respDesc = respChanges.map(c => {
          const stageName = lookup(c.stageId);
          const userName = c.to ? (userById(c.to)?.name || '(usuário)') : (c.to === null ? 'sem responsável' : 'padrão do fluxo');
          return `${esc(stageName)} → <em>${esc(userName)}</em>`;
        });
        parts.push(`responsáveis: ${respDesc.join(', ')}`);
      }
      return `customizou etapas — ${parts.length ? parts.join(' · ') : 'sem mudanças visíveis'}`;
    }
    default:                   return esc(h.action);
  }
}
function renderDetailHistory(d) {
  const p = projectById(d.projectId);
  const history = (d.history || []).slice().reverse();
  $('detail-content').innerHTML = `
    <div class="detail-content">
      <div class="detail-head">
        <div class="detail-head-top">
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-ghost btn-sm" onclick="backToDetailMain()" style="display:inline-flex;align-items:center;gap:6px">
              <i data-lucide="arrow-left" class="ic-sm"></i> Voltar
            </button>
            <div>
              <div class="detail-title">Histórico da demanda</div>
              <div class="detail-head-meta">
                <span>${esc(d.name)}</span>
                ${p ? `<span class="meta-sep">|</span><span>${esc(p.name)}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="detail-head-actions">
            <button class="detail-icon-btn" title="Fechar" onclick="attemptCloseModal('detail-modal')"><i data-lucide="x" class="ic-sm"></i></button>
          </div>
        </div>
      </div>
      <div class="detail-body">
        ${history.length ? `<div class="history-list">${history.map(h => {
          const u = userById(h.userId);
          return `<div class="history-item">
            ${avatarHTML(u)}
            <div class="history-body">
              <div class="history-text"><strong>${esc(u?.name || 'Usuário')}</strong> ${describeHistory(h, d)}</div>
              <div class="history-time">${esc(fmtDateTime(h.at))}</div>
            </div>
          </div>`;
        }).join('')}</div>` : '<div class="hours-empty">Nenhum registro no histórico ainda.</div>'}
      </div>
    </div>`;
  $('detail-footer').innerHTML = '';
  paintIcons();
}

function renderDetailDirtyBadge() {
  // Barra "Alterações pendentes" — colada NA PARTE DE CIMA do footer sticky
  // (o footer já é sticky bottom, então essa barra herda a mesma ancoragem).
  const existing = document.getElementById('detail-save-pending');
  if (Object.keys(detailDirty).length === 0) { if (existing) existing.remove(); return; }
  if (existing) return;
  const bar = document.createElement('div');
  bar.id = 'detail-save-pending';
  bar.className = 'detail-pending-bar';
  bar.innerHTML = `
    <span class="detail-pending-msg"><i data-lucide="alert-triangle" class="ic-sm"></i> Alterações pendentes</span>
    <button class="btn btn-primary btn-sm" onclick="commitDetailEdits()">Salvar</button>
    <button class="btn btn-ghost btn-sm" onclick="cancelDetailEdits()">Descartar</button>`;
  const footer = document.getElementById('detail-footer');
  if (footer) footer.insertBefore(bar, footer.firstChild);
  paintIcons();
}
async function commitDetailEdits() {
  const d = demandById(detailId); if (!d) return;
  const payload = {};
  if (detailDirty.stageDue) payload.stageDueDate = $('detail-stage-due').value || null;
  if (detailDirty.deadline) payload.deadline = $('detail-deadline').value || null;
  try {
    const upd = await api('/demands/' + d.id, 'PUT', payload);
    patchDemand(upd);
    detailDirty = {};
    toast('Alterações salvas!');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}
function cancelDetailEdits() {
  detailDirty = {};
  renderDetail();
}

/* Briefing/descrição inline edit
   Auto-save: dispara em blur ou após ~1s parado de digitar. Salva silenciosamente
   (sem re-render) pra não perder cursor/foco. Indicador minimalista mostra o
   estado: "Salvando…" → "Salvo" → fade. Botão "Concluir" só esconde o editor. */
function editBriefingInline() {
  const d = demandById(detailId); if (!d) return;
  const bView = $('detail-briefing-view');
  const dView = $('detail-description-view');
  bView.innerHTML = `<input class="form-control" id="edit-briefing" type="url" value="${esc(d.briefing || '')}" placeholder="https://...">`;
  dView.innerHTML = `<textarea class="form-control" id="edit-description" rows="5" placeholder="Detalhes da demanda...">${esc(d.description || '')}</textarea>
    <div class="inline-edit-foot">
      <span class="inline-edit-status" id="edit-desc-status"></span>
      <button class="btn btn-ghost btn-sm" onclick="renderDetail()">Concluir</button>
    </div>`;
  const briefingInput = $('edit-briefing');
  const descTextarea = $('edit-description');
  if (briefingInput) {
    briefingInput.addEventListener('input', autoSaveBriefingDebounced);
    briefingInput.addEventListener('blur', autoSaveBriefing);
  }
  if (descTextarea) {
    descTextarea.addEventListener('input', autoSaveBriefingDebounced);
    descTextarea.addEventListener('blur', autoSaveBriefing);
  }
}
async function autoSaveBriefing() {
  const d = demandById(detailId); if (!d) return;
  const briefingEl = document.getElementById('edit-briefing');
  const descEl = document.getElementById('edit-description');
  if (!briefingEl && !descEl) return; // editor fechado
  const newBrief = briefingEl ? normalizeUrl(briefingEl.value) : d.briefing;
  const newDesc  = descEl ? descEl.value.trim() : d.description;
  if (newBrief === (d.briefing || '') && newDesc === (d.description || '')) return;
  setInlineEditStatus('Salvando…');
  try {
    const upd = await api('/demands/' + d.id, 'PUT', { briefing: newBrief, description: newDesc });
    patchDemand(upd);
    setInlineEditStatus('Salvo', 'ok');
  } catch (e) {
    setInlineEditStatus('Erro ao salvar', 'err');
  }
}
const autoSaveBriefingDebounced = debounce(autoSaveBriefing, 1000);
function setInlineEditStatus(text, kind) {
  const el = document.getElementById('edit-desc-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'inline-edit-status' + (kind ? ' ' + kind : '');
  if (kind === 'ok') {
    clearTimeout(setInlineEditStatus._t);
    setInlineEditStatus._t = setTimeout(() => {
      const cur = document.getElementById('edit-desc-status');
      if (cur && cur.textContent === text) { cur.textContent = ''; cur.className = 'inline-edit-status'; }
    }, 1800);
  }
}
// Mantida pra compat se algum onclick antigo ainda chamar
async function saveBriefingInline() { await autoSaveBriefing(); renderDetail(); }

/* Confirmações */
async function confirmDeleteCurrentDemand() {
  const d = demandById(detailId); if (!d) return;
  const ok = await showConfirm({
    title: 'Excluir demanda',
    message: `Tem certeza que deseja excluir <strong>${esc(d.name)}</strong>?<br><br>Essa ação não pode ser desfeita. Todos os comentários, apontamentos e histórico serão perdidos.`,
    okLabel: 'Excluir definitivamente',
    danger: true
  });
  if (!ok) return;
  try {
    const delId = d.id;
    await api('/demands/' + delId, 'DELETE');
    closeModal('detail-modal');
    detailId = null;
    toastWithUndo('Demanda excluída.', () => api('/demands/' + delId + '/undelete', 'POST'));
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function confirmDeleteComment(cid) {
  const ok = await showConfirm({
    title: 'Excluir comentário',
    message: 'Esta ação não pode ser desfeita. Deseja remover este comentário?',
    okLabel: 'Excluir',
    danger: true
  });
  if (ok) deleteComment(cid);
}
async function confirmDeleteTimeEntry(eid) {
  const ok = await showConfirm({
    title: 'Excluir apontamento',
    message: 'Tem certeza que deseja remover este apontamento de horas?',
    okLabel: 'Excluir',
    danger: true
  });
  if (ok) deleteTimeEntry(eid);
}

/* ─── Anexos de Demanda (arquivos, imagens, links) ─── */
/* Classifica MIME em: image / pdf / video / audio / other. Usado pra decidir
   se o preview inline vale a pena (image/pdf/video/audio) ou se só mostra ícone. */
function attPreviewKind(type) {
  const t = (type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'other';
}
function attIcon(kind) {
  return { image: 'image', pdf: 'file-text', video: 'video', audio: 'music', other: 'file' }[kind] || 'file';
}
function renderDemandAttList(list, withDelete) {
  if (!list || !list.length) return '<div class="hours-empty" style="text-align:left">Nenhum arquivo anexado.</div>';
  return list.map((a, i) => {
    if (a.kind === 'link') {
      const href = esc(normalizeUrl(a.url || a.name));
      return `<div class="demand-att-item" data-id="${esc(a.id)}">
        <i data-lucide="link" class="ic-sm" style="color:var(--accent-text)"></i>
        <a href="${href}" target="_blank" rel="noopener noreferrer" class="demand-att-name">${esc(a.name || a.url)}</a>
        ${withDelete ? `<button class="detail-icon-btn danger" title="Remover" onclick="removeDetailAttachment('${esc(a.id)}')"><i data-lucide="x" class="ic-sm"></i></button>` : `<button class="detail-icon-btn danger" title="Remover" onclick="removeFormAttachment('${esc(a.id)}', 'f-attachments-list')"><i data-lucide="x" class="ic-sm"></i></button>`}
      </div>`;
    }
    const kind = attPreviewKind(a.type);
    const previewable = kind !== 'other';
    const src = esc(a.data || a.url || '');
    const nameEsc = esc(a.name);
    const openCall = previewable
      ? `openAttPreview('${src}', '${esc(a.type || '')}', '${esc(a.name || '')}')`
      : null;
    const thumbOrIcon = kind === 'image'
      ? `<img src="${a.data || a.url}" class="demand-att-thumb" onclick="${openCall}" style="cursor:zoom-in">`
      : `<i data-lucide="${attIcon(kind)}" class="ic-sm" style="color:var(--accent-text);${previewable ? 'cursor:pointer' : ''}" ${openCall ? `onclick="${openCall}"` : ''}></i>`;
    const nameEl = previewable
      ? `<a href="#" class="demand-att-name" onclick="event.preventDefault();${openCall}">${nameEsc}</a>`
      : `<a href="${src}" download="${nameEsc}" class="demand-att-name">${nameEsc}</a>`;
    return `<div class="demand-att-item" data-id="${esc(a.id)}">
      ${thumbOrIcon}
      ${nameEl}
      ${previewable ? `<a href="${src}" download="${nameEsc}" class="detail-icon-btn" title="Baixar"><i data-lucide="download" class="ic-sm"></i></a>` : ''}
      ${withDelete ? `<button class="detail-icon-btn danger" title="Remover" onclick="removeDetailAttachment('${esc(a.id)}')"><i data-lucide="x" class="ic-sm"></i></button>` : `<button class="detail-icon-btn danger" title="Remover" onclick="removeFormAttachment('${esc(a.id)}', 'f-attachments-list')"><i data-lucide="x" class="ic-sm"></i></button>`}
    </div>`;
  }).join('');
}

/* Modal fullscreen de preview — image/pdf/video/audio. Reusa uma <div> única,
   criada on-demand. Fechar: clique fora, Esc ou botão X. */
function openAttPreview(src, type, name) {
  if (!src) return;
  let el = document.getElementById('att-preview-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'att-preview-modal';
    el.className = 'att-preview-overlay';
    el.addEventListener('click', ev => { if (ev.target === el) closeAttPreview(); });
    document.body.appendChild(el);
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && el.classList.contains('open')) closeAttPreview();
    });
  }
  const kind = attPreviewKind(type);
  let body = '';
  if (kind === 'image') {
    body = `<img src="${src}" alt="${esc(name)}" class="att-preview-image">`;
  } else if (kind === 'pdf') {
    body = `<iframe src="${src}" class="att-preview-frame" title="${esc(name)}"></iframe>`;
  } else if (kind === 'video') {
    body = `<video src="${src}" controls class="att-preview-video"></video>`;
  } else if (kind === 'audio') {
    body = `<audio src="${src}" controls class="att-preview-audio"></audio>`;
  } else {
    // fallback — abre em nova aba
    window.open(src, '_blank'); return;
  }
  el.innerHTML = `
    <div class="att-preview-head">
      <span class="att-preview-name">${esc(name || 'Anexo')}</span>
      <a href="${src}" download="${esc(name || '')}" class="detail-icon-btn" title="Baixar"><i data-lucide="download" class="ic-sm"></i></a>
      <button class="detail-icon-btn" onclick="closeAttPreview()" title="Fechar"><i data-lucide="x" class="ic-sm"></i></button>
    </div>
    <div class="att-preview-body">${body}</div>`;
  el.classList.add('open');
  paintIcons();
}
function closeAttPreview() {
  const el = document.getElementById('att-preview-modal');
  if (!el) return;
  el.classList.remove('open');
  el.innerHTML = ''; // para vídeo/áudio pararem de tocar
}

function genAttId() { return 'a' + Math.random().toString(36).slice(2,10); }

/* Form attachments (modal de nova demanda) — usa demandAttachments */
function refreshFormAttList(listId) {
  $(listId).innerHTML = renderDemandAttList(demandAttachments, false);
  paintIcons();
}
function readDemandFiles(files, isImage, listId) {
  [...files].forEach(file => {
    if (file.size > 5 * 1024 * 1024) { toast('Arquivo "' + file.name + '" excede 5 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const finish = (data, type) => {
        demandAttachments.push({ id: genAttId(), kind: 'file', name: file.name, type, data });
        refreshFormAttList(listId);
      };
      if (isImage) {
        const img = new Image();
        img.onload = () => {
          const max = 1200;
          let w = img.width, h = img.height;
          if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          finish(canvas.toDataURL('image/jpeg', 0.85), 'image/jpeg');
        };
        img.src = e.target.result;
      } else finish(e.target.result, file.type);
    };
    reader.readAsDataURL(file);
  });
}
function handleDemandAttachmentFiles(ev, listId) { readDemandFiles(ev.target.files, false, listId); ev.target.value = ''; }
function handleDemandAttachmentImages(ev, listId) { readDemandFiles(ev.target.files, true, listId); ev.target.value = ''; }
async function addDemandAttachmentLink(listId) {
  const url = await showPrompt({ title: 'Adicionar link', message: 'Cole o link abaixo:', placeholder: 'https://...' });
  if (!url) return;
  const normalized = normalizeUrl(url);
  demandAttachments.push({ id: genAttId(), kind: 'link', name: url.trim(), url: normalized });
  refreshFormAttList(listId);
}
function removeFormAttachment(id, listId) {
  demandAttachments = demandAttachments.filter(a => a.id !== id);
  refreshFormAttList(listId);
}

/* Detail attachments — operam direto na demanda via API */
async function handleDetailAttachmentFiles(ev) {
  const d = demandById(detailId); if (!d) return;
  for (const file of ev.target.files) {
    if (file.size > 5 * 1024 * 1024) { toast('Arquivo "' + file.name + '" excede 5 MB.', 'error'); continue; }
    await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = async e => {
        const newAtts = (d.attachments || []).concat({ id: genAttId(), kind: 'file', name: file.name, type: file.type, data: e.target.result });
        try {
          const upd = await api('/demands/' + d.id, 'PUT', { attachments: newAtts });
          patchDemand(upd);
        } catch (err) { toast(err.message, 'error'); }
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }
  ev.target.value = '';
  renderDetail();
  toast('Anexo adicionado!');
}
async function handleDetailAttachmentImages(ev) {
  const d = demandById(detailId); if (!d) return;
  for (const file of ev.target.files) {
    if (file.size > 5 * 1024 * 1024) { toast('Arquivo "' + file.name + '" excede 5 MB.', 'error'); continue; }
    await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = async () => {
          const max = 1200;
          let w = img.width, h = img.height;
          if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const data = canvas.toDataURL('image/jpeg', 0.85);
          const newAtts = (d.attachments || []).concat({ id: genAttId(), kind: 'file', name: file.name, type: 'image/jpeg', data });
          try {
            const upd = await api('/demands/' + d.id, 'PUT', { attachments: newAtts });
            patchDemand(upd);
          } catch (err) { toast(err.message, 'error'); }
          resolve();
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
  ev.target.value = '';
  renderDetail();
  toast('Imagem adicionada!');
}
async function addDetailAttachmentLink() {
  const d = demandById(detailId); if (!d) return;
  const url = await showPrompt({ title: 'Adicionar link', message: 'Cole o link abaixo:', placeholder: 'https://...' });
  if (!url) return;
  const newAtts = (d.attachments || []).concat({ id: genAttId(), kind: 'link', name: url.trim(), url: normalizeUrl(url) });
  try {
    const upd = await api('/demands/' + d.id, 'PUT', { attachments: newAtts });
    patchDemand(upd);
    toast('Link adicionado!');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}
async function removeDetailAttachment(id) {
  const d = demandById(detailId); if (!d) return;
  const ok = await showConfirm({ title: 'Remover anexo', message: 'Tem certeza que deseja remover este anexo?', okLabel: 'Remover', danger: true });
  if (!ok) return;
  try {
    const upd = await api('/demands/' + d.id, 'PUT', { attachments: (d.attachments || []).filter(a => a.id !== id) });
    patchDemand(upd);
    toast('Anexo removido.', 'warn');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}

async function changeOwner(uid) {
  document.querySelectorAll('.cdrop.open').forEach(c => c.classList.remove('open'));
  try {
    const d = await api('/demands/' + detailId, 'PUT', { ownerId: uid });
    patchDemand(d);
    toast('Responsável atualizado!');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}
function patchDemand(d) {
  const i = demands.findIndex(x => x.id === d.id);
  if (i >= 0) demands[i] = d; else demands.push(d);
}

/* ─── Edição inline do título da demanda ───
   Click no <div class="detail-title"> dispara isto: troca por <input>,
   commit no blur ou Enter, cancela no Esc. */
function startEditDemandTitle(el) {
  if (!el || el.querySelector('input')) return;
  const d = demandById(detailId);
  if (!d) return;
  const current = d.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'detail-title-input';
  input.value = current;
  input.maxLength = 200;
  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = (input.value || '').trim();
    if (!save || !next || next === current) {
      el.textContent = current;
      return;
    }
    try {
      const upd = await api('/demands/' + d.id, 'PUT', { name: next });
      patchDemand(upd);
      el.textContent = next;
      if (typeof renderList === 'function') renderList();
      const kb = document.getElementById('kanban-board');
      if (kb && typeof renderKanban === 'function') renderKanban();
      toast('Demanda renomeada!');
    } catch (err) {
      toast(err.message || 'Erro ao renomear', 'error');
      el.textContent = current;
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function moveStage(dir) {
  const d = demandById(detailId); if (!d) return;
  const flow = flowById(d.flowId); if (!flow) return;
  const active = activeStagesOf(d, flow);
  const idx = active.findIndex(s => s.id === d.status);
  const next = active[idx + dir];
  if (!next) return;
  try {
    const upd = await api('/demands/' + d.id, 'PUT', { status: next.id });
    patchDemand(upd);
    toast(dir > 0 ? 'Etapa avançada: ' + next.label : 'Etapa retrocedida: ' + next.label);
    renderDetail();
    renderCurrent();
    fetchNotifications();
  } catch (e) { toast(e.message, 'error'); }
}
/* ── CRONÔMETRO DE APONTAMENTO ──
   Estado por demanda. Persiste a hora de início e o acumulado mesmo que o modal
   re-renderize. O cronômetro corre via setInterval atualizando o display. */
let timerState = {}; // { [demandId]: { running, startedAt, accumulatedMs, beginAt } }
let timerInterval = null;

function getTimer(demandId) {
  if (!timerState[demandId]) {
    timerState[demandId] = { running: false, accumulatedMs: 0, beginAt: null, startedAt: null };
  }
  return timerState[demandId];
}
function formatTimerClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function timerElapsedMs(t) {
  let ms = t.accumulatedMs;
  if (t.running && t.beginAt) ms += Date.now() - t.beginAt;
  return ms;
}
function refreshTimerUI() {
  const t = detailId ? getTimer(detailId) : null;
  const display = $('timer-display');
  const clock = $('timer-clock');
  const btn = $('timer-toggle-btn');
  if (!display || !clock || !btn || !t) return;
  const elapsed = timerElapsedMs(t);
  // Mostra o display se houver tempo acumulado ou estiver correndo
  display.style.display = (t.running || elapsed > 0) ? '' : 'none';
  clock.textContent = formatTimerClock(elapsed);
  // Botão alterna entre play e pause
  btn.classList.toggle('running', t.running);
  btn.innerHTML = t.running ? '<i data-lucide="pause" class="ic-sm"></i>' : '<i data-lucide="play" class="ic-sm"></i>';
  btn.title = t.running ? 'Pausar cronômetro' : 'Iniciar cronômetro';
  paintIcons();
}
function tickTimer() {
  const t = detailId ? getTimer(detailId) : null;
  if (!t || !t.running) return;
  const clock = $('timer-clock');
  if (clock) clock.textContent = formatTimerClock(timerElapsedMs(t));
}
function ensureTimerInterval() {
  if (timerInterval) return;
  timerInterval = setInterval(tickTimer, 1000);
}
function toggleTimer() {
  const d = demandById(detailId); if (!d) return;
  const t = getTimer(detailId);
  if (t.running) {
    // Pausar: acumula o tempo decorrido
    t.accumulatedMs += Date.now() - t.beginAt;
    t.running = false;
    t.beginAt = null;
    // Preenche o campo de horas com o acumulado (em horas decimais)
    const hours = Math.round((t.accumulatedMs / 3600000) * 100) / 100;
    if (hours > 0) $('time-hours').value = hours;
    // Preenche término = agora; início = agora - acumulado (se ainda não preenchido)
    const now = new Date();
    const toLocal = dt => {
      const off = dt.getTimezoneOffset();
      return new Date(dt.getTime() - off * 60000).toISOString().slice(0, 16);
    };
    if (!$('time-end').value) $('time-end').value = toLocal(now);
    if (!$('time-start').value && t.startedAt) $('time-start').value = toLocal(new Date(t.startedAt));
    toast('Cronômetro pausado · ' + formatTimerClock(t.accumulatedMs));
  } else {
    // Iniciar/retomar
    t.running = true;
    t.beginAt = Date.now();
    if (!t.startedAt) t.startedAt = Date.now();
    ensureTimerInterval();
    toast('Cronômetro iniciado');
  }
  refreshTimerUI();
}
function resetTimer(demandId) {
  if (timerState[demandId]) delete timerState[demandId];
}

/* Converte um valor exibido (dd/mm/aaaa HH:MM ou ISO) para ISO datetime-local */
function toIsoDateTime(v) {
  if (!v) return null;
  v = String(v).trim();
  // Já está em ISO
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
  // Formato display: dd/mm/aaaa HH:MM
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
  // Formato display sem hora
  const md = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (md) return `${md[3]}-${md[2]}-${md[1]}T00:00`;
  return null;
}

/* Apontamento de horas */
function autoHours() {
  const s = toIsoDateTime($('time-start').value);
  const e = toIsoDateTime($('time-end').value);
  if (s && e && !$('time-hours').value) {
    const diff = (new Date(e) - new Date(s)) / 3600000;
    if (diff > 0) $('time-hours').value = Math.round(diff * 100) / 100;
  }
}
async function addTimeEntry() {
  const d = demandById(detailId); if (!d) return;
  let hours = Number($('time-hours').value);
  const start = toIsoDateTime($('time-start').value);
  const end = toIsoDateTime($('time-end').value);
  if (!(hours > 0) && start && end) {
    const diff = (new Date(end) - new Date(start)) / 3600000;
    if (diff > 0) hours = Math.round(diff * 100) / 100;
  }
  if (!(hours > 0)) { toast('Informe as horas ou um início e término válidos.', 'error'); return; }
  try {
    const upd = await api('/demands/' + d.id + '/time', 'POST', { hours, start, end });
    patchDemand(upd);
    resetTimer(d.id);
    toast('Horas apontadas!');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteTimeEntry(entryId) {
  try {
    const upd = await api('/demands/' + detailId + '/time/' + entryId, 'DELETE');
    patchDemand(upd);
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}

function startEditTimeEntry(eid) {
  const d = demandById(detailId); if (!d) return;
  const e = (d.timeEntries || []).find(x => x.id === eid); if (!e) return;
  const el = document.getElementById('appt-' + eid); if (!el) return;
  const toLocal = iso => {
    if (!iso) return '';
    const dt = new Date(iso);
    const off = dt.getTimezoneOffset();
    return new Date(dt.getTime() - off * 60000).toISOString().slice(0,16);
  };
  el.outerHTML = `<div class="appt-row appt-edit" id="appt-${eid}">
    <div class="form-group" style="margin:0;flex:1;min-width:120px">
      <label class="form-label">Horas</label>
      <input class="form-control" id="ae-hours" type="number" min="0" step="0.25" value="${e.hours}">
    </div>
    <div class="form-group" style="margin:0;flex:2;min-width:160px">
      <label class="form-label">Início</label>
      <input class="form-control" id="ae-start" type="datetime-local" value="${toLocal(e.start)}">
    </div>
    <div class="form-group" style="margin:0;flex:2;min-width:160px">
      <label class="form-label">Término</label>
      <input class="form-control" id="ae-end" type="datetime-local" value="${toLocal(e.end)}">
    </div>
    <div style="display:flex;gap:6px;align-items:end;padding-bottom:4px">
      <button class="btn btn-ghost btn-sm" onclick="renderDetail()">Cancelar</button>
      <button class="btn btn-primary btn-sm" onclick="saveEditTimeEntry('${eid}')">Salvar</button>
    </div>
  </div>`;
  paintIcons();
  if (typeof fdpConvertAll === 'function') fdpConvertAll();
  $('ae-hours').focus();
}
async function saveEditTimeEntry(eid) {
  let hours = Number($('ae-hours').value);
  const start = toIsoDateTime($('ae-start').value);
  const end = toIsoDateTime($('ae-end').value);
  if (!(hours > 0) && start && end) {
    const diff = (new Date(end) - new Date(start)) / 3600000;
    if (diff > 0) hours = Math.round(diff * 100) / 100;
  }
  if (!(hours > 0)) { toast('Informe as horas ou início/término válidos.', 'error'); return; }
  try {
    const upd = await api('/demands/' + detailId + '/time/' + eid, 'PUT', { hours, start, end });
    patchDemand(upd);
    toast('Apontamento atualizado!');
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}

/* Comentários com @menção */
let mentionIdx = -1;
function mentionCandidates(term) {
  const t = norm(term);
  return wsUsers().filter(u => norm(u.username).startsWith(t) || norm(u.name).includes(t)).slice(0, 6);
}
function mentionContext(ta) {
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = before.match(/@([a-zA-Z0-9._-]*)$/);
  return m ? { term: m[1], start: pos - m[0].length, pos } : null;
}
function mentionWatch(ta) {
  const ctx = mentionContext(ta);
  const pop = $('mention-pop');
  if (!ctx) { pop.classList.remove('open'); return; }
  const list = mentionCandidates(ctx.term);
  if (!list.length) { pop.classList.remove('open'); return; }
  mentionIdx = 0;
  pop.innerHTML = list.map((u, i) => `
    <div class="mention-opt ${i === 0 ? 'active' : ''}" data-uname="${esc(u.username)}" onclick="pickMention('${esc(u.username)}')">
      ${avatarHTML(u)} <span class="user-mini"><span class="user-mini-name">${esc(u.name)}</span><span class="user-mini-role">@${esc(u.username)}</span></span>
    </div>`).join('');
  pop.classList.add('open');
  pop.style.bottom = (ta.offsetHeight + 6) + 'px';
  pop.style.left = '0';
}
function mentionKeys(e) {
  const pop = $('mention-pop');
  if (!pop.classList.contains('open')) return;
  const opts = [...pop.querySelectorAll('.mention-opt')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mentionIdx = (mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('active', i === mentionIdx));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickMention(opts[mentionIdx]?.dataset.uname);
  } else if (e.key === 'Escape') {
    pop.classList.remove('open');
  }
}
function pickMention(uname) {
  if (!uname) return;
  const ta = $('comment-input');
  const ctx = mentionContext(ta);
  if (!ctx) return;
  ta.value = ta.value.slice(0, ctx.start) + '@' + uname + ' ' + ta.value.slice(ctx.pos);
  $('mention-pop').classList.remove('open');
  ta.focus();
}
async function sendComment() {
  const text = $('comment-input').value.trim();
  if (!text && !pendingAttachments.length) return;
  try {
    const upd = await api('/demands/' + detailId + '/comment', 'POST', { text, attachments: pendingAttachments });
    pendingAttachments = [];
    draftClearComment(detailId); // rascunho salvou seu papel — pode sair
    patchDemand(upd);
    renderDetail();
    toast('Comentário enviado!');
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── DRAFT DE COMENTÁRIO (autosave em localStorage) ───
   Salva o rascunho debounced (300ms após parar de digitar) numa key por
   demanda. Restaura ao abrir o detalhe. Limpa ao enviar ou explicitamente. */
const _DRAFT_KEY = id => 'kastor-draft-comment-' + id;
let _draftSaveTimer = null;
function draftSaveComment(el) {
  if (!detailId) return;
  clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(() => {
    try {
      if (el.value.trim()) localStorage.setItem(_DRAFT_KEY(detailId), el.value);
      else localStorage.removeItem(_DRAFT_KEY(detailId));
    } catch {}
  }, 300);
}
function draftClearComment(id) {
  try { localStorage.removeItem(_DRAFT_KEY(id)); } catch {}
}
function draftRestoreComment() {
  if (!detailId) return;
  const ta = document.getElementById('comment-input');
  if (!ta) return;
  let saved = '';
  try { saved = localStorage.getItem(_DRAFT_KEY(detailId)) || ''; } catch {}
  // Só restaura se o textarea estiver vazio (evita sobrescrever se o usuário
  // já começou a digitar entre o render e o restore).
  if (saved && !ta.value) ta.value = saved;
}
async function deleteComment(cid) {
  try {
    const upd = await api('/demands/' + detailId + '/comment/' + cid, 'DELETE');
    patchDemand(upd);
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}

/* Anexos de comentário */
let pendingAttachments = [];
function renderPendingFiles() {
  const el = $('comment-pending-files');
  if (!el) return;
  el.innerHTML = pendingAttachments.map((a, i) => {
    const preview = a.type.startsWith('image/')
      ? `<img src="${a.data}" class="pending-thumb">`
      : '<i data-lucide="file" class="ic-sm"></i>';
    return `<span class="pending-file">${preview} ${esc(a.name)} <button class="icon-btn danger" onclick="removePending(${i})" title="Remover"><i data-lucide="x" class="ic-sm"></i></button></span>`;
  }).join('');
}
function removePending(i) { pendingAttachments.splice(i, 1); renderPendingFiles(); }
function readFilesAsBase64(files, isImage) {
  [...files].forEach(file => {
    if (file.size > 5 * 1024 * 1024) { toast('Arquivo "' + file.name + '" excede 5 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      if (isImage) {
        // Redimensiona imagens grandes
        const img = new Image();
        img.onload = () => {
          const max = 1200;
          let w = img.width, h = img.height;
          if (w > max || h > max) {
            const r = Math.min(max / w, max / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const data = canvas.toDataURL('image/jpeg', 0.85);
          pendingAttachments.push({ name: file.name, type: file.type, data });
          renderPendingFiles();
        };
        img.src = e.target.result;
      } else {
        pendingAttachments.push({ name: file.name, type: file.type, data: e.target.result });
        renderPendingFiles();
      }
    };
    reader.readAsDataURL(file);
  });
}
function handleCommentFiles(ev) { readFilesAsBase64(ev.target.files, false); ev.target.value = ''; }
function handleCommentImages(ev) { readFilesAsBase64(ev.target.files, true); ev.target.value = ''; }

/* Paste (Ctrl+V) e drag-and-drop direto no compositor de comentário.
   Reaproveita readFilesAsBase64 → pendingAttachments → renderPendingFiles.
   stopPropagation evita conflito com o setupDragDrop do modal de demanda. */
function setupCommentComposer() {
  const ta = $('comment-input');
  const compose = ta?.closest('.comment-compose');
  if (!ta || !compose) return;

  ta.addEventListener('paste', e => {
    const items = e.clipboardData?.items || [];
    const imageFiles = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (!imageFiles.length) return; // sem imagem: deixa o paste de texto normal
    e.preventDefault();
    readFilesAsBase64(imageFiles, true);
    toast(imageFiles.length === 1 ? 'Imagem colada!' : `${imageFiles.length} imagens coladas!`);
  });

  let dragDepth = 0;
  compose.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    compose.classList.add('drag-over');
  });
  compose.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });
  compose.addEventListener('dragleave', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) compose.classList.remove('drag-over');
  });
  compose.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    compose.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const imgs = files.filter(f => f.type.startsWith('image/'));
    const others = files.filter(f => !f.type.startsWith('image/'));
    if (imgs.length) readFilesAsBase64(imgs, true);
    if (others.length) readFilesAsBase64(others, false);
    const total = files.length;
    toast(`${total} arquivo${total === 1 ? '' : 's'} adicionado${total === 1 ? '' : 's'} ao comentário`);
  });
}

/* Edição de comentário */
function startEditComment(cid) {
  const d = demandById(detailId); if (!d) return;
  const c = d.comments.find(x => x.id === cid); if (!c) return;
  const el = document.getElementById('comment-' + cid);
  if (!el) return;
  const atts = (c.attachments || []).map((a, i) => {
    const preview = a.type && a.type.startsWith('image/') ? `<img src="${a.data}" class="pending-thumb">` : '<i data-lucide="file" class="ic-sm"></i>';
    return `<span class="pending-file">${preview} ${esc(a.name)} <button class="icon-btn danger" onclick="removeEditAtt('${cid}', ${i})" title="Remover"><i data-lucide="x" class="ic-sm"></i></button></span>`;
  }).join('');
  el.innerHTML = `
    <textarea class="form-control" id="edit-comment-text" rows="3">${esc(c.text)}</textarea>
    <div class="comment-pending-files" id="edit-comment-files">${atts}</div>
    <div class="comment-compose-bar" style="margin-top:8px">
      <div class="comment-attach-btns">
        <input type="file" id="edit-file-input" multiple style="display:none" onchange="handleEditFiles(event,'${cid}')">
        <button class="btn btn-ghost btn-sm" onclick="$('edit-file-input').click()"><i data-lucide="paperclip" class="ic-sm"></i></button>
        <input type="file" id="edit-img-input" accept="image/*" multiple style="display:none" onchange="handleEditImages(event,'${cid}')">
        <button class="btn btn-ghost btn-sm" onclick="$('edit-img-input').click()"><i data-lucide="image" class="ic-sm"></i></button>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="renderDetail()">Cancelar</button>
        <button class="btn btn-primary btn-sm" onclick="saveEditComment('${cid}')">Salvar</button>
      </div>
    </div>`;
  el.dataset.editAtts = JSON.stringify(c.attachments || []);
  $('edit-comment-text').focus();
}
function removeEditAtt(cid, idx) {
  const el = document.getElementById('comment-' + cid);
  const atts = JSON.parse(el.dataset.editAtts || '[]');
  atts.splice(idx, 1);
  el.dataset.editAtts = JSON.stringify(atts);
  const container = $('edit-comment-files');
  container.innerHTML = atts.map((a, i) => {
    const preview = a.type && a.type.startsWith('image/') ? `<img src="${a.data}" class="pending-thumb">` : '<i data-lucide="file" class="ic-sm"></i>';
    return `<span class="pending-file">${preview} ${esc(a.name)} <button class="icon-btn danger" onclick="removeEditAtt('${cid}', ${i})"><i data-lucide="x" class="ic-sm"></i></button></span>`;
  }).join('');
}
function handleEditFiles(ev, cid) {
  const el = document.getElementById('comment-' + cid);
  [...ev.target.files].forEach(file => {
    if (file.size > 5 * 1024 * 1024) { toast('"' + file.name + '" excede 5 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const atts = JSON.parse(el.dataset.editAtts || '[]');
      atts.push({ name: file.name, type: file.type, data: e.target.result });
      el.dataset.editAtts = JSON.stringify(atts);
      removeEditAtt(cid, -1); // re-render (splice -1 doesn't remove)
      // Actually re-render properly
      const container = $('edit-comment-files');
      container.innerHTML = atts.map((a, i) => {
        const preview = a.type && a.type.startsWith('image/') ? `<img src="${a.data}" class="pending-thumb">` : '<i data-lucide="file" class="ic-sm"></i>';
        return `<span class="pending-file">${preview} ${esc(a.name)} <button class="icon-btn danger" onclick="removeEditAtt('${cid}', ${i})"><i data-lucide="x" class="ic-sm"></i></button></span>`;
      }).join('');
    };
    reader.readAsDataURL(file);
  });
  ev.target.value = '';
}
function handleEditImages(ev, cid) {
  const el = document.getElementById('comment-' + cid);
  [...ev.target.files].forEach(file => {
    if (file.size > 5 * 1024 * 1024) { toast('"' + file.name + '" excede 5 MB.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const max = 1200;
        let w = img.width, h = img.height;
        if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const data = canvas.toDataURL('image/jpeg', 0.85);
        const atts = JSON.parse(el.dataset.editAtts || '[]');
        atts.push({ name: file.name, type: file.type, data });
        el.dataset.editAtts = JSON.stringify(atts);
        const container = $('edit-comment-files');
        container.innerHTML = atts.map((a, i) => {
          const preview = a.type && a.type.startsWith('image/') ? `<img src="${a.data}" class="pending-thumb">` : '<i data-lucide="file" class="ic-sm"></i>';
          return `<span class="pending-file">${preview} ${esc(a.name)} <button class="icon-btn danger" onclick="removeEditAtt('${cid}', ${i})"><i data-lucide="x" class="ic-sm"></i></button></span>`;
        }).join('');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  ev.target.value = '';
}
async function saveEditComment(cid) {
  const el = document.getElementById('comment-' + cid);
  const text = $('edit-comment-text').value.trim();
  const attachments = JSON.parse(el.dataset.editAtts || '[]');
  if (!text && !attachments.length) { toast('O comentário não pode ficar vazio.', 'error'); return; }
  try {
    const upd = await api('/demands/' + detailId + '/comment/' + cid, 'PUT', { text, attachments });
    patchDemand(upd);
    renderDetail();
    toast('Comentário atualizado!');
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── PROJETOS ─── */
function renderProjects() {
  // Populate filters
  const allP = wsProjects();
  const clients = [...new Set(allP.map(p => p.client).filter(Boolean))].sort();
  const cSel = $('proj-f-client');
  const cPrev = cSel.value;
  cSel.innerHTML = '<option value="">Todos os clientes</option>' + clients.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if ([...cSel.options].some(o => o.value === cPrev)) cSel.value = cPrev;

  applyFilterDropdown('proj-f-client');
  applyFilterDropdown('proj-f-status');

  // Apply filters
  const q = norm($('proj-search').value);
  const fc = $('proj-f-client').value;
  const fs = $('proj-f-status').value;
  let list = allP.filter(p => {
    if (q && !norm(p.name).includes(q) && !norm(p.client).includes(q)) return false;
    if (fc && p.client !== fc) return false;
    if (fs === 'active' && p.active === false) return false;
    if (fs === 'archived' && p.active !== false) return false;
    if (!fs && !showArchivedProjects && p.active === false) return false;
    return true;
  });

  // Sort
  list.sort((a, b) => {
    let va, vb;
    if (projSortKey === 'name') { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
    else if (projSortKey === 'client') { va = (a.client || '').toLowerCase(); vb = (b.client || '').toLowerCase(); }
    else if (projSortKey === 'demands') { va = wsDemands().filter(d => d.projectId === a.id).length; vb = wsDemands().filter(d => d.projectId === b.id).length; }
    else if (projSortKey === 'flow') {
      const fa = wsFlows().find(f => f.projectId === a.id);
      const fb = wsFlows().find(f => f.projectId === b.id);
      va = norm(fa?.name || ''); vb = norm(fb?.name || '');
    }
    else if (projSortKey === 'status') { va = a.active !== false ? 0 : 1; vb = b.active !== false ? 0 : 1; }
    else { va = a.name; vb = b.name; }
    return va < vb ? -projSortDir : va > vb ? projSortDir : 0;
  });

  const archivedCount = allP.filter(p => p.active === false).length;
  $('proj-archive-toggle').textContent = showArchivedProjects ? 'Ocultar arquivados' : `Ver arquivados (${archivedCount})`;
  $('proj-archive-toggle').style.display = archivedCount || showArchivedProjects ? '' : 'none';

  $('projects-table-body').innerHTML = list.length ? list.map(p => {
    const count = wsDemands().filter(d => d.projectId === p.id).length;
    const exclusive = wsFlows().filter(f => f.projectId === p.id);
    const pAvatar = p.avatar
      ? `<img src="${p.avatar}" class="avatar" style="width:28px;height:28px;border-radius:6px">`
      : `<span class="avatar" style="width:28px;height:28px;font-size:11px;border-radius:6px;background:${hexDim(p.color)};color:${p.color}">${esc(p.name.charAt(0))}</span>`;
    const actions = me.isAdmin ? `
      <div class="row-actions">
        <button class="detail-icon-btn" title="Editar" onclick="openProjectModal('${p.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>
        <button class="detail-icon-btn" title="Duplicar" onclick="duplicateProject('${p.id}')"><i data-lucide="copy" class="ic-sm"></i></button>
        ${p.active !== false ? `<button class="detail-icon-btn" title="Arquivar" onclick="archiveProject('${p.id}')"><i data-lucide="archive" class="ic-sm"></i></button>` : `<button class="detail-icon-btn" title="Restaurar" onclick="archiveProject('${p.id}')"><i data-lucide="archive-restore" class="ic-sm"></i></button>`}
        <button class="detail-icon-btn danger" title="Excluir" onclick="confirmDeleteProject('${p.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
      </div>
    ` : '';
    return `<tr class="row-hover-actions" style="${p.active === false ? 'opacity:.55' : ''}">
      <td><div style="display:flex;align-items:center;gap:8px">${pAvatar}<span style="font-weight:600">${esc(p.name)}</span></div></td>
      <td>${esc(p.client || '—')}</td>
      <td>${exclusive.length ? exclusive.map(f => `<span class="pill pill-muted" style="font-size:10px">${esc(f.name)}</span>`).join(' ') : '<span style="color:var(--text-muted);font-size:12px">Fluxos gerais</span>'}</td>
      <td>${count}</td>
      <td>${p.active !== false ? '<span class="pill pill-success">Ativo</span>' : '<span class="pill pill-muted">Arquivado</span>'}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="6">${emptyState('Nenhum projeto encontrado', 'Ajuste os filtros ou crie um novo projeto.', 'inbox')}</td></tr>`;
}
function sortProjects(key) {
  if (projSortKey === key) projSortDir *= -1;
  else { projSortKey = key; projSortDir = 1; }
  renderProjects();
}
function toggleArchivedProjects() {
  showArchivedProjects = !showArchivedProjects;
  $('proj-f-status').value = '';
  renderProjects();
}
async function archiveProject(id) {
  const p = projectById(id); if (!p) return;
  const action = p.active !== false ? 'Arquivar' : 'Restaurar';
  try {
    await api('/projects/' + id, 'PUT', { active: p.active === false });
    toast(p.active === false ? 'Projeto restaurado.' : 'Projeto arquivado.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function confirmDeleteProject(id) {
  const p = projectById(id); if (!p) return;
  const linkedDemands = wsDemands().filter(d => d.projectId === id).length;
  const linkedFlows = wsFlows().filter(f => f.projectId === id).length;
  const ok = await showConfirm({
    title: 'Excluir projeto definitivamente',
    message: `Excluir <strong>${esc(p.name)}</strong> permanentemente?<br><br>${linkedDemands ? `Esta ação removerá também <strong>${linkedDemands}</strong> demanda(s) vinculada(s).<br>` : ''}${linkedFlows ? `${linkedFlows} fluxo(s) exclusivo(s) também serão removidos.<br>` : ''}<br><strong>Esta ação não pode ser desfeita.</strong>`,
    okLabel: 'Excluir definitivamente',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/projects/' + id + '?force=1', 'DELETE');
    toastWithUndo('Projeto excluído (demandas incluídas).', () => api('/projects/' + id + '/undelete', 'POST'));
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
function removeProjectAvatar() {
  projAvatarData = null;
  refreshProjectAvatarPreview();
}
function handleProjectAvatar(ev) {
  const file = ev.target.files[0]; if (!file) return;
  const img = new Image();
  img.onload = () => {
    const s = 256;
    const canvas = document.createElement('canvas');
    canvas.width = s; canvas.height = s;
    const min = Math.min(img.width, img.height);
    const sx = (img.width - min) / 2, sy = (img.height - min) / 2;
    canvas.getContext('2d').drawImage(img, sx, sy, min, min, 0, 0, s, s);
    projAvatarData = canvas.toDataURL('image/jpeg', 0.85);
    refreshProjectAvatarPreview();
  };
  img.src = URL.createObjectURL(file);
  ev.target.value = '';
}
let projectModalClientId = null; // cliente associado nesta abertura do modal
async function openProjectModal(id, presetClientId) {
  editingProjectId = id || null;
  $('project-modal-title').textContent = id ? 'Editar Projeto' : 'Novo Projeto';
  const p = id ? projectById(id) : null;

  // Cliente obrigatório: vem do projeto em edição ou do preset (tela do cliente).
  // Sem qualquer contexto, redireciona pra Clientes em vez de abrir sem destino.
  projectModalClientId = p?.clientId || presetClientId || null;
  if (!projectModalClientId) {
    toast('Selecione um cliente pra adicionar um projeto.', 'warn');
    goPage('clients');
    return;
  }
  // Cliente do preset/projeto pode estar stale (frontend não sincronizado com backend).
  // Faz um refresh on-demand antes de abrir pra evitar erro "Cliente inválido" no save.
  if (!clientById(projectModalClientId)) {
    try { clients = await api('/clients'); } catch {}
    if (!clientById(projectModalClientId)) {
      toast('Cliente não encontrado. Selecione um cliente da lista.', 'error');
      projectModalClientId = null;
      goPage('clients');
      return;
    }
  }

  $('p-name').value = p?.name || '';
  setColorValue('p-color', p?.color || '#7A00FF');
  $('p-drive-files').value = p?.driveFiles || '';
  $('p-brand-assets').value = p?.brandAssets || '';
  $('p-guidelines').value = p?.guidelines || '';

  // Footer: edit mostra Excluir + toggle Estado; new esconde os dois
  $('p-delete-btn').style.display = p ? '' : 'none';
  $('p-status-group').style.display = p ? '' : 'none';
  projectModalStatusActive = p ? (p.active !== false) : true;
  refreshProjectStatusUI();

  projAvatarData = p?.avatar || null;
  refreshProjectAvatarPreview();

  openModal('project-modal');
  navPush(id ? '/projects/' + id + '/edit' : '/projects/new');
}

function refreshProjectAvatarPreview() {
  const el = $('p-avatar-preview');
  if (!el) return;
  if (projAvatarData) {
    el.style.backgroundImage = `url('${projAvatarData}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.innerHTML = '';
    el.style.background = `url('${projAvatarData}') center/cover no-repeat`;
    $('p-avatar-remove').style.display = '';
  } else {
    el.style.backgroundImage = '';
    el.style.background = '';
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Sem foto</span>';
    $('p-avatar-remove').style.display = 'none';
  }
}

let projectModalStatusActive = true;
function setProjectModalStatus(active) {
  projectModalStatusActive = active;
  refreshProjectStatusUI();
}
function refreshProjectStatusUI() {
  document.querySelectorAll('.client-status-pick[data-pval]').forEach(b => {
    b.classList.toggle('active', (b.dataset.pval === 'active') === projectModalStatusActive);
  });
}

function openProjectDeleteConfirm() {
  if (!editingProjectId) return;
  const p = projectById(editingProjectId);
  if (!p) return;
  const linkedDemands = wsDemands().filter(d => d.projectId === p.id).length;
  const linkedFlows = wsFlows().filter(f => f.projectId === p.id).length;
  $('project-delete-title').textContent = `Excluir "${p.name}"?`;
  $('project-delete-confirm-text').innerHTML = `Para confirmar, digite <strong>${esc(p.name)}</strong> abaixo:`;
  const w = $('project-delete-warning');
  const warns = [];
  if (linkedDemands) warns.push(`<strong>${linkedDemands}</strong> demanda(s) vinculada(s) também serão removidas.`);
  if (linkedFlows) warns.push(`<strong>${linkedFlows}</strong> fluxo(s) exclusivo(s) também serão removidos.`);
  w.innerHTML = warns.join('<br>');
  $('project-delete-input').value = '';
  updateProjectDeleteBtnState();
  openModal('project-delete-modal');
}
function updateProjectDeleteBtnState() {
  const p = editingProjectId ? projectById(editingProjectId) : null;
  const ok = !!(p && $('project-delete-input').value.trim() === p.name);
  $('project-delete-confirm-btn').disabled = !ok;
}
async function confirmDeleteProjectTyped() {
  if (!editingProjectId) return;
  const id = editingProjectId;
  try {
    await api('/projects/' + id + '?force=1', 'DELETE');
    closeModal('project-delete-modal');
    closeModal('project-modal');
    toastWithUndo('Projeto excluído (demandas incluídas).', () => api('/projects/' + id + '/undelete', 'POST'));
    const ctxClientId = currentClientId;
    await refreshData();
    if (ctxClientId) renderClientDetail(ctxClientId);
  } catch (e) { toast(e.message, 'error'); }
}

async function saveProject() {
  const clientId = projectModalClientId;
  if (!clientId) { toast('Cliente não definido.', 'error'); return; }
  const payload = {
    name: $('p-name').value,
    clientId,
    color: $('p-color').value,
    active: editingProjectId ? projectModalStatusActive : true,
    avatar: projAvatarData,
    driveFiles: $('p-drive-files').value,
    brandAssets: $('p-brand-assets').value,
    guidelines: $('p-guidelines').value
  };
  try {
    if (editingProjectId) await api('/projects/' + editingProjectId, 'PUT', payload);
    else await api('/projects', 'POST', payload);
    closeModal('project-modal');
    toast(editingProjectId ? 'Projeto atualizado!' : 'Projeto criado!');
    const wasEditing = editingProjectId;
    const ctxClientId = currentClientId;
    // Restaura URL antes do refresh (o modal trocou pra /projects/.../edit)
    // Se estava editando via detalhe de projeto → volta pro detalhe.
    // Se estava criando ou editando pela lista do cliente → volta pro cliente.
    if (wasEditing && currentProjectId === wasEditing) {
      navPush('/projects/' + wasEditing);
    } else if (ctxClientId) {
      navPush('/clients/' + ctxClientId);
    }
    await refreshData();
    // Re-render do detalhe apropriado (refreshData zera cache local).
    if (wasEditing && currentProjectId === wasEditing && projectById(wasEditing)) {
      renderProjectDetail(wasEditing);
    }
  } catch (e) {
    // Cliente inválido: cache local pode estar desatualizado. Sincroniza e instrui.
    if (e.message && e.message.toLowerCase().includes('cliente inválido')) {
      console.warn('[saveProject] clientId rejeitado pelo backend:', clientId, 'payload:', payload);
      try { clients = await api('/clients'); } catch {}
      toast('Cliente foi alterado em outro lugar. Recarregue a página (Ctrl+F5) e tente de novo.', 'error');
    } else {
      toast(e.message, 'error');
    }
  }
}
async function duplicateProject(id) {
  try {
    await api('/projects/' + id + '/duplicate', 'POST', {});
    toast('Projeto duplicado! Os fluxos exclusivos foram copiados junto.');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── FLUXOS (admin) ─── */
/* ─── FLUXOS — Nova arquitetura: clientes → fluxos por cliente ─── */
let currentClientView = null;       // cliente sendo visualizado em fluxos-view-detail (string ou '__general__')
let clientFlowSortKey = 'name';
let clientFlowSortDir = 1;

/* Helper: agrupa fluxos por cliente usando a entidade Client (clientId).
   Fluxos sem clientId ficam no grupo '__general__'. O `client` (string)
   é usado como fallback durante a migração. */
function flowGroupsByClient() {
  const allF = wsFlows();
  const groups = new Map();
  for (const f of allF) {
    let key, label;
    if (f.clientId) {
      const c = clientById(f.clientId);
      key = c ? c.id : '__general__';
      label = c ? c.name : 'Geral';
    } else if (f.client && f.client.trim()) {
      // Fallback: tenta achar a entidade pelo nome (string legado)
      const c = wsClients().find(x => (x.name || '').toLowerCase() === f.client.trim().toLowerCase());
      key = c ? c.id : '__general__';
      label = c ? c.name : f.client.trim();
    } else {
      key = '__general__';
      label = 'Geral';
    }
    if (!groups.has(key)) groups.set(key, { client: key, label, flows: [] });
    groups.get(key).flows.push(f);
  }
  return [...groups.values()];
}

function renderFlows() {
  // Reseta pra view de clientes ao entrar na página
  $('flows-view-clients').style.display = '';
  $('flows-view-detail').style.display = 'none';
  currentClientView = null;

  // Constrói cards a partir de TODOS os clientes ativos do workspace,
  // não só dos que já têm fluxos. Quem ainda não tem fluxo aparece com
  // contagem 0, pronto pra criar o primeiro. Mais 1 card "Geral" pra
  // fluxos workspace-wide (sem clientId).
  const allF = wsFlows();
  const allC = wsClients().filter(c => c.active !== false);
  const groups = [];
  // Card "Geral" — fluxos sem clientId
  const generalFlows = allF.filter(f => !f.clientId);
  groups.push({ key: '__general__', label: 'Geral', color: null, avatar: null, flows: generalFlows });
  // Um card por cliente cadastrado
  for (const c of allC) {
    const cFlows = allF.filter(f => f.clientId === c.id);
    groups.push({ key: c.id, label: c.name, color: c.color, avatar: c.avatar, flows: cFlows });
  }

  // Popula select de filtro com clientes cadastrados (não os derivados de fluxos)
  const fcSel = $('flow-f-client');
  if (fcSel) {
    const prev = fcSel.value;
    const opts = allC.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)))
      .map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    fcSel.innerHTML = '<option value="">Todos os clientes</option>' + opts;
    if ([...fcSel.options].some(o => o.value === prev)) fcSel.value = prev;
    applyFilterDropdown('flow-f-client');
  }

  // Filtra busca + cliente
  const q = norm(($('flow-search').value || '').trim());
  const fc = fcSel ? fcSel.value : '';
  let list = groups.filter(g => {
    if (q && !norm(g.label).includes(q)) return false;
    if (fc && g.key !== fc) return false;
    return true;
  });

  // Sort: "Geral" sempre primeiro, depois alfabético
  list.sort((a, b) => {
    if (a.key === '__general__') return -1;
    if (b.key === '__general__') return 1;
    return norm(a.label).localeCompare(norm(b.label));
  });

  const grid = $('flow-clients-grid');
  if (!list.length) {
    grid.innerHTML = emptyState('Nenhum cliente encontrado',
      'Cadastre um cliente na aba "Clientes" pra começar.', 'flow');
    paintIcons();
    return;
  }

  grid.innerHTML = list.map(g => {
    let avatarHtml;
    if (g.key === '__general__') {
      avatarHtml = `<div class="flow-card-avatar" style="background:var(--surface-3);color:var(--text-dim)"><i data-lucide="layers" class="ic-sm"></i></div>`;
    } else if (g.avatar) {
      avatarHtml = `<div class="flow-card-avatar" style="background-image:url('${g.avatar}');background-size:cover;background-position:center"></div>`;
    } else {
      const color = g.color || '#7A00FF';
      const letter = g.label.charAt(0).toUpperCase();
      avatarHtml = `<div class="flow-card-avatar" style="background:${hexDim(color)};color:${color}">${esc(letter)}</div>`;
    }
    const subLabel = g.flows.length === 0 ? 'Sem fluxos · clique pra criar' : `${g.flows.length} fluxo${g.flows.length === 1 ? '' : 's'}`;
    return `<div class="flow-card" onclick="openClientFlows('${esc(g.key).replace(/'/g, "\\'")}')">
      ${avatarHtml}
      <div class="flow-card-name">${esc(g.label)}</div>
      <div class="flow-card-sub">${esc(subLabel)}</div>
    </div>`;
  }).join('');
  paintIcons();
}

/* Abre a view de fluxos de um cliente específico */
function openClientFlows(client) {
  currentClientView = client;
  $('flows-view-clients').style.display = 'none';
  $('flows-view-detail').style.display = '';
  // Reset filtros da subview
  const ds = $('flow-detail-search'); if (ds) ds.value = '';
  const dt = $('flow-detail-type'); if (dt) dt.value = '';
  renderClientFlows(client);
}
function closeClientFlows() {
  currentClientView = null;
  $('flows-view-clients').style.display = '';
  $('flows-view-detail').style.display = 'none';
  renderFlows();
}
function setClientFlowSort(key) {
  if (clientFlowSortKey === key) clientFlowSortDir *= -1;
  else { clientFlowSortKey = key; clientFlowSortDir = 1; }
  document.querySelectorAll('.flow-sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderClientFlows(currentClientView);
}

function renderClientFlows(client) {
  if (!client) return;
  // `client` aqui é o id do Client entity (ou '__general__'). Pega fluxos por clientId.
  const allF = wsFlows();
  let flows, label;
  if (client === '__general__') {
    flows = allF.filter(f => !f.clientId);
    label = 'Geral';
  } else {
    const c = clientById(client);
    if (!c) { closeClientFlows(); return; }
    flows = allF.filter(f => f.clientId === client);
    label = c.name;
  }

  // Breadcrumb
  const bc = $('flow-detail-breadcrumb');
  if (bc) {
    bc.innerHTML = `<span style="color:var(--text-muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;font-size:11px">Fluxos de demanda · </span><span>${esc(label)}</span>`;
  }

  // Popula select de tipo
  const types = [...new Set(flows.map(f => f.demandType).filter(Boolean))].sort();
  const dt = $('flow-detail-type');
  if (dt) {
    const prev = dt.value;
    dt.innerHTML = '<option value="">Todos os tipos</option>' + types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if ([...dt.options].some(o => o.value === prev)) dt.value = prev;
    applyFilterDropdown('flow-detail-type');
  }

  // Filtra
  const q = norm(($('flow-detail-search').value || '').trim());
  const ft = dt ? dt.value : '';
  let list = flows.filter(f => {
    if (q && !norm(f.name).includes(q)) return false;
    if (ft && f.demandType !== ft) return false;
    return true;
  });

  // Sort
  list.sort((a, b) => {
    let va, vb;
    if (clientFlowSortKey === 'type') { va = norm(a.demandType || ''); vb = norm(b.demandType || ''); }
    else if (clientFlowSortKey === 'modified') {
      // Sem campo updatedAt explícito — usa createdAt como proxy (mais recente primeiro)
      va = a.createdAt || ''; vb = b.createdAt || '';
      return (vb < va ? -1 : vb > va ? 1 : 0) * clientFlowSortDir;
    }
    else { va = norm(a.name); vb = norm(b.name); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * clientFlowSortDir;
  });

  const grid = $('flow-detail-grid');
  if (!list.length) {
    grid.innerHTML = emptyState('Nenhum fluxo neste cliente',
      'Clique em "Novo Fluxo" pra criar o primeiro.', 'flow');
    paintIcons();
    return;
  }

  grid.innerHTML = list.map(f => {
    const count = demands.filter(d => d.flowId === f.id).length;
    const iconHtml = !f.icon
      ? `<div class="flow-card-icon flow-card-icon--placeholder"><i data-lucide="workflow" class="ic-sm"></i></div>`
      : (typeof f.icon === 'string' && f.icon.startsWith('lucide:'))
        ? `<div class="flow-card-icon flow-card-icon--lucide"><i data-lucide="${esc(f.icon.slice(7))}" class="ic-md"></i></div>`
        : `<div class="flow-card-icon" style="background-image:url('${f.icon}');background-size:cover;background-position:center"></div>`;
    const adminActions = me.isAdmin ? `<div class="flow-card-actions" onclick="event.stopPropagation()">
        <button class="detail-icon-btn" title="Duplicar" onclick="openDuplicateFlow('${f.id}')"><i data-lucide="copy" class="ic-xs"></i></button>
        <button class="detail-icon-btn danger" title="Excluir" onclick="deleteFlow('${f.id}')"><i data-lucide="trash-2" class="ic-xs"></i></button>
      </div>` : '';
    const clickAttr = me.isAdmin ? `onclick="openFlowModal('${f.id}')"` : 'style="cursor:default"';
    return `<div class="flow-card flow-card-flow" ${clickAttr}>
      ${iconHtml}
      ${adminActions}
      <div class="flow-card-name">${esc(f.name)}</div>
      <div class="flow-card-sub">${esc(f.demandType || 'Sem tipo')} · ${count} demanda${count === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');
  paintIcons();
}

/* Versão do openFlowModal que pré-preenche o cliente — usada do botão da subview.
   `clientKey` agora é o ID do Client (ou '__general__' pra fluxo workspace-wide). */
function openFlowModalForClient(clientKey) {
  openFlowModal(null, clientKey === '__general__' ? null : clientKey);
}

/* Compat — sortFlowsBy não é mais usado mas mantido pra evitar quebra */
function sortFlowsBy() { /* legacy — substituído por setClientFlowSort */ }

/* Editor de fluxo com etapas arrastáveis */
let stageRows = [];
let dragIdx = null;

let flowModalDirty = false;
let flowIconData = null;  // data URI/URL do ícone selecionado pra esse modal
let flowModalClientId = null; // ID do Client em contexto (null = Geral / workspace-wide)
function openFlowModal(id, presetClientId) {
  editingFlowId = id || null;
  flowModalDirty = false;
  const isNew = !id;
  const f = id ? flowById(id) : null;
  // Contexto: edição usa o clientId do fluxo (fallback no nome legado);
  // nova usa o preset (subview do cliente). Sempre id de Client entity.
  if (f) {
    if (f.clientId) flowModalClientId = f.clientId;
    else if (f.client) {
      const c = wsClients().find(x => (x.name || '').toLowerCase() === (f.client || '').toLowerCase());
      flowModalClientId = c ? c.id : null;
    } else flowModalClientId = null;
  } else {
    flowModalClientId = presetClientId || null;
  }
  $('flow-modal-title').textContent = isNew ? 'Novo fluxo' : 'Editar fluxo';
  const clientEntity = flowModalClientId ? clientById(flowModalClientId) : null;
  $('flow-modal-subtitle').textContent = clientEntity ? clientEntity.name : 'Geral · disponível pra todos os clientes';

  $('fl-name').value = f?.name || '';
  $('fl-type').value = f?.demandType || '';
  $('flowtypes-datalist').innerHTML = [...new Set(flows.map(x => x.demandType).filter(Boolean))]
    .map(t => `<option value="${esc(t)}">`).join('');

  // Project picker fica escondido por padrão. Útil só pra fluxos exclusivos
  // de um projeto específico — caso raro, atalho via console se necessário.
  $('fl-project-group').style.display = 'none';
  $('fl-project').innerHTML = '<option value="">— Todos os projetos do cliente —</option>' +
    wsProjects().slice().sort((a,b) => norm(a.name).localeCompare(norm(b.name))).map(p => `<option value="${p.id}" ${f && f.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  // Ícone customizado: edição carrega o existente; nova fica vazio
  flowIconData = f?.icon || null;
  refreshFlowIconPreview();

  // Toggle "Aplicar a todos os projetos": só faz sentido pra nova criação em
  // contexto de cliente — duplica o fluxo pra cada projeto desse cliente.
  const applyWrap = $('fl-apply-toggle-wrap');
  const applyAvailable = isNew && !!flowModalClientId;
  applyWrap.style.display = applyAvailable ? '' : 'none';
  $('fl-apply-all').checked = false;

  stageRows = f
    ? f.stages.map(s => ({ roleFilter: null, responsibleRole: null, ...s }))
    : [
        { id: null, label: 'Backlog',   color: '#64748B', done: false, roleFilter: null, responsibleId: null, responsibleRole: null, deadlineDays: null },
        { id: null, label: 'Execução',  color: '#7A00FF', done: false, roleFilter: null, responsibleId: null, responsibleRole: null, deadlineDays: 3 },
        { id: null, label: 'Concluída', color: '#22D3A5', done: true,  roleFilter: null, responsibleId: null, responsibleRole: null, deadlineDays: null }
      ];
  renderStageRows();
  // Defaults aplicados a novas demandas deste fluxo
  $('fl-default-desc').value = f?.defaultDescription || '';
  flowDefaultChecklist = Array.isArray(f?.defaultChecklist)
    ? f.defaultChecklist.map(it => ({ text: String(it.text || '') }))
    : [];
  renderFlowChecklist();
  openModal('flow-modal');
  navPush(id ? '/flows/' + id : '/flows/new');
}

/* Checklist padrão do fluxo — array editável de { text } */
let flowDefaultChecklist = [];
function renderFlowChecklist() {
  const wrap = $('fl-default-checklist');
  if (!wrap) return;
  if (!flowDefaultChecklist.length) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0">Nenhum item ainda. Clique em "Adicionar item".</div>';
  } else {
    wrap.innerHTML = flowDefaultChecklist.map((it, i) => `
      <div class="flow-checklist-item">
        <input class="form-control" value="${esc(it.text)}" placeholder="Ex.: Revisar gramática" oninput="flowDefaultChecklist[${i}].text=this.value;flowModalDirty=true">
        <button type="button" class="icon-btn danger" title="Remover" onclick="removeFlowChecklistItem(${i})"><i data-lucide="x" class="ic-sm"></i></button>
      </div>`).join('');
  }
  paintIcons();
}
function addFlowChecklistItem() {
  flowDefaultChecklist.push({ text: '' });
  flowModalDirty = true;
  renderFlowChecklist();
  // Foca no input recém-criado
  const inputs = $('fl-default-checklist').querySelectorAll('input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeFlowChecklistItem(i) {
  flowDefaultChecklist.splice(i, 1);
  flowModalDirty = true;
  renderFlowChecklist();
}

/* ── Ícone do fluxo (Lucide picker ou imagem) ── */
function refreshFlowIconPreview() {
  const el = $('fl-icon-preview');
  if (!el) return;
  el.style.backgroundImage = '';
  el.classList.remove('has-icon');
  if (!flowIconData) {
    el.innerHTML = '<span class="flow-icon-label">ícone</span>';
    return;
  }
  if (typeof flowIconData === 'string' && flowIconData.startsWith('lucide:')) {
    el.classList.add('has-icon');
    el.innerHTML = `<i data-lucide="${esc(flowIconData.slice(7))}" class="ic-md"></i>`;
    paintIcons();
  } else {
    el.classList.add('has-icon');
    el.innerHTML = '';
    el.style.backgroundImage = `url('${flowIconData}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  }
}
// Trigger principal: abre o picker do Lucide (com fallback de upload dentro do modal)
function openFlowIconPicker() {
  openLucidePicker(flowIconData, (val) => {
    flowIconData = val;
    refreshFlowIconPreview();
    flowModalDirty = true;
  });
}
// Mantido pra compat com o input nativo legacy, caso ainda exista alguma referência
function handleFlowIconUpload(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('Imagem excede 2MB.', 'error'); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    flowIconData = e.target.result;
    refreshFlowIconPreview();
    flowModalDirty = true;
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}

function renderStageRows() {
  // Mantém referência aos campos pra construir os dropdowns.
  // Convenção de dados: cada stage guarda `roleFilter` (qual função foi
  // escolhida) e UMA destas duas formas de responsável:
  //   - responsibleId: id de usuário específico
  //   - useClientDefault: true → resolver via client.roleAssignments[roleFilter]
  // Persistimos como responsibleRole = roleFilter quando useClientDefault=true
  // (compatível com o backend resolveStageOwner).
  const allUsers = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const allRoles = (roles || []).slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const hasClient = !!flowModalClientId;

  $('stage-list').innerHTML = stageRows.map((s, i) => {
    // Reconstrói o estado de UI a partir do que veio do backend
    const roleFilter = s.roleFilter || s.responsibleRole || '';
    const useDefault = !!s.responsibleRole && !s.responsibleId;
    const userId = s.responsibleId || '';

    // Função dropdown
    const fnOpts = `<option value="">— Sem função —</option>` +
      allRoles.map(r => `<option value="${esc(r.name)}" ${r.name === roleFilter ? 'selected' : ''}>${esc(r.name)}</option>`).join('');

    // Responsável dropdown — filtrado pela função selecionada
    let respHtml = '<option value="">— Sem responsável —</option>';
    if (roleFilter) {
      const filteredUsers = allUsers.filter(u => (u.role || '') === roleFilter);
      if (hasClient) {
        respHtml += `<option value="__client_default__" ${useDefault ? 'selected' : ''}>Padrão do cliente</option>`;
      }
      respHtml += filteredUsers.map(u =>
        `<option value="${u.id}" ${u.id === userId ? 'selected' : ''}>${esc(u.name)}</option>`
      ).join('');
    } else {
      // Sem função selecionada: mostra todos os usuários (libera assign direto)
      respHtml += allUsers.map(u =>
        `<option value="${u.id}" ${u.id === userId ? 'selected' : ''}>${esc(u.name)}</option>`
      ).join('');
    }

    return `<div class="stage-row" data-idx="${i}"
         ondragover="stageDragOver(event,${i})"
         ondragleave="stageDragLeave(event)" ondrop="stageDrop(event,${i})" ondragend="stageDragEnd()">
      <div class="stage-grip" draggable="true" ondragstart="stageDragStart(event,${i})" title="Arraste para reordenar"><i data-lucide="grip-vertical" class="ic-sm"></i></div>
      <button type="button" class="color-swatch-trigger stage-color" style="background:${s.color}" onclick="openColorPicker(this, (c) => { stageRows[${i}].color = c; this.style.background = c; flowModalDirty = true; }, stageRows[${i}].color)" title="Cor da etapa"></button>
      <input class="form-control" value="${esc(s.label)}" placeholder="Nome da etapa" oninput="stageRows[${i}].label=this.value">
      <select id="stage-role-${i}" class="form-control stage-role" title="Função desta etapa" onchange="setStageRoleFilter(${i}, this.value)">${fnOpts}</select>
      <select id="stage-resp-${i}" class="form-control stage-resp" title="Responsável padrão da etapa" onchange="setStageResponsible(${i}, this.value)">${respHtml}</select>
      <div class="stage-days-wrap"><span class="stage-mini-label">Prazo (dias)</span><input class="form-control" type="number" min="1" placeholder="—" value="${s.deadlineDays || ''}" oninput="stageRows[${i}].deadlineDays=this.value?Number(this.value):null"></div>
      <label class="stage-done-toggle"><input type="checkbox" ${s.done ? 'checked' : ''} onchange="stageRows[${i}].done=this.checked"> Conclui</label>
      <div class="stage-actions">
        <button class="icon-btn" title="Duplicar etapa" onclick="duplicateStageRow(${i})"><i data-lucide="copy" class="ic-sm"></i></button>
        <button class="icon-btn danger" title="Remover etapa" onclick="removeStageRow(${i})"><i data-lucide="x" class="ic-sm"></i></button>
      </div>
    </div>`;
  }).join('');
  // Dropdown customizado com avatar nos usuários (responsável). O de função
  // fica como select nativo — não tem avatar pra exibir.
  stageRows.forEach((_, i) => applyFilterDropdown(`stage-resp-${i}`, { userIcon: true }));
  paintIcons();
}

function setStageRoleFilter(i, value) {
  if (!stageRows[i]) return;
  stageRows[i].roleFilter = value || null;
  // Troca de função invalida o usuário escolhido (a menos que ele tenha essa função).
  if (stageRows[i].responsibleId) {
    const u = userById(stageRows[i].responsibleId);
    if (!u || (u.role || '') !== value) {
      stageRows[i].responsibleId = null;
      stageRows[i].responsibleRole = null;
    }
  }
  // Se "Padrão do cliente" estava marcado, atualiza pra apontar pra nova função
  if (stageRows[i].responsibleRole) {
    stageRows[i].responsibleRole = value || null;
  }
  renderStageRows(); // re-render imediato pra atualizar o dropdown de responsável
}

function setStageResponsible(i, value) {
  if (!stageRows[i]) return;
  if (!value) {
    stageRows[i].responsibleId = null;
    stageRows[i].responsibleRole = null;
  } else if (value === '__client_default__') {
    stageRows[i].responsibleRole = stageRows[i].roleFilter || null;
    stageRows[i].responsibleId = null;
  } else {
    stageRows[i].responsibleId = value;
    stageRows[i].responsibleRole = null;
    // Auto-define a função baseada no usuário escolhido (consistência visual)
    if (!stageRows[i].roleFilter) {
      const u = userById(value);
      if (u && u.role) stageRows[i].roleFilter = u.role;
    }
  }
  // Re-render pra o trigger do .filter-cdrop refletir a escolha imediatamente
  // (sem isso, a label visível só atualiza no próximo render).
  renderStageRows();
}

function duplicateStageRow(i) {
  if (!stageRows[i]) return;
  const copy = { ...stageRows[i], id: null, label: (stageRows[i].label || '') + ' (cópia)' };
  stageRows.splice(i + 1, 0, copy);
  renderStageRows();
}
function addStageRow() {
  stageRows.push({ id: null, label: '', color: '#7A00FF', done: false, roleFilter: null, responsibleId: null, responsibleRole: null, deadlineDays: null });
  renderStageRows();
  const inputs = $('stage-list').querySelectorAll('.stage-row input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeStageRow(i) {
  stageRows.splice(i, 1);
  renderStageRows();
}
function stageDragStart(e, i) {
  dragIdx = i;
  e.dataTransfer.effectAllowed = 'move';
  // Só o grip é draggable — a classe .dragging deve ir na row pai
  const row = e.currentTarget.closest('.stage-row') || e.currentTarget;
  row.classList.add('dragging');
}
function stageDragOver(e, i) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function stageDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function stageDrop(e, i) {
  e.preventDefault();
  if (dragIdx === null || dragIdx === i) { renderStageRows(); return; }
  const [moved] = stageRows.splice(dragIdx, 1);
  stageRows.splice(i, 0, moved);
  dragIdx = null;
  renderStageRows();
}
function stageDragEnd() {
  dragIdx = null;
  document.querySelectorAll('.stage-row').forEach(r => r.classList.remove('dragging','drag-over'));
}

async function saveFlow() {
  const isNew = !editingFlowId;
  const applyAll = isNew && !!flowModalClientId && $('fl-apply-all') && $('fl-apply-all').checked;
  const clientEntity = flowModalClientId ? clientById(flowModalClientId) : null;
  const payload = {
    name: $('fl-name').value,
    demandType: $('fl-type').value,
    projectId: $('fl-project').value || null,
    workspaceId: activeWs,
    clientId: flowModalClientId || null,
    client: clientEntity ? clientEntity.name : null, // mantém legado em sincronia
    icon: flowIconData || null,
    stages: stageRows,
    applyToAll: applyAll,
    defaultDescription: $('fl-default-desc')?.value || '',
    defaultChecklist: flowDefaultChecklist.filter(it => (it.text || '').trim()).map(it => ({ text: it.text.trim() }))
  };
  try {
    const r = editingFlowId
      ? await api('/flows/' + editingFlowId, 'PUT', payload)
      : await api('/flows', 'POST', payload);
    closeModal('flow-modal');
    flowModalDirty = false;
    if (applyAll && r && r.count) {
      toast(`Fluxo aplicado a ${r.count} projeto${r.count === 1 ? '' : 's'} do cliente "${clientEntity?.name || ''}"!`);
    } else {
      toast(editingFlowId ? 'Fluxo atualizado!' : 'Fluxo criado!');
    }
    await refreshData();
    if (currentClientView) renderClientFlows(currentClientView);
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteFlow(id) {
  const f = flowById(id);
  const ok = await showConfirm({
    title: 'Excluir fluxo',
    message: `Excluir o fluxo <strong>${esc(f?.name || '')}</strong>?<br><br>Essa ação não pode ser desfeita.`,
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/flows/' + id, 'DELETE');
    toast('Fluxo excluído.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
function openDuplicateFlow(id) {
  duplicatingFlowId = id;
  $('dup-project').innerHTML = '<option value="">— Manter como fluxo geral —</option>' +
    wsProjects().slice().sort((a,b) => norm(a.name).localeCompare(norm(b.name))).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  openModal('dupflow-modal');
}
async function confirmDuplicateFlow() {
  try {
    await api('/flows/' + duplicatingFlowId + '/duplicate', 'POST', { projectId: $('dup-project').value || null });
    closeModal('dupflow-modal');
    toast('Fluxo duplicado!');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── WORKSPACES (admin) ─── */
function renderWorkspaces() {
  const sorted = workspaces.slice().sort((a, b) => {
    let va, vb;
    const nProjA = projects.filter(p => p.workspaceId === a.id).length;
    const nProjB = projects.filter(p => p.workspaceId === b.id).length;
    const nUsersA = users.filter(u => u.active !== false && (u.isAdmin || (u.workspaces || []).includes(a.id))).length;
    const nUsersB = users.filter(u => u.active !== false && (u.isAdmin || (u.workspaces || []).includes(b.id))).length;
    if (wsSortKey === 'projects') { va = nProjA; vb = nProjB; }
    else if (wsSortKey === 'members') { va = nUsersA; vb = nUsersB; }
    else { va = norm(a.name); vb = norm(b.name); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * wsSortDir;
  });
  $('ws-table-body').innerHTML = sorted.map(w => {
    const nProj = projects.filter(p => p.workspaceId === w.id).length;
    const nUsers = users.filter(u => u.active !== false && (u.isAdmin || (u.workspaces || []).includes(w.id))).length;
    const actions = me.isAdmin ? `<div class="row-actions">
          <button class="detail-icon-btn" title="Editar" onclick="openWsModal('${w.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>
          <button class="detail-icon-btn danger" title="Excluir" onclick="deleteWs('${w.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
        </div>` : '';
    return `<tr class="row-hover-actions">
      <td><span class="pill" style="color:${w.color || '#7A00FF'};background:${hexDim(w.color)}"><span class="pill-dot" style="background:${w.color || '#7A00FF'}"></span>${esc(w.name)}</span></td>
      <td>${nProj}</td>
      <td>${nUsers}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}
function sortWsBy(key) {
  if (wsSortKey === key) wsSortDir *= -1;
  else { wsSortKey = key; wsSortDir = 1; }
  renderWorkspaces();
}
function openWsModal(id) {
  editingWsId = id || null;
  $('ws-modal-title').textContent = id ? 'Editar Workspace' : 'Novo Workspace';
  const w = id ? wsById(id) : null;
  $('ws-name').value = w?.name || '';
  setColorValue('ws-color', w?.color || '#7A00FF');
  openModal('ws-modal');
}
async function saveWs() {
  const payload = { name: $('ws-name').value, color: $('ws-color').value };
  try {
    if (editingWsId) await api('/workspaces/' + editingWsId, 'PUT', payload);
    else await api('/workspaces', 'POST', payload);
    closeModal('ws-modal');
    toast(editingWsId ? 'Workspace atualizado!' : 'Workspace criado! Libere o acesso da equipe na aba Usuários.');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteWs(id) {
  const w = wsById(id);
  const ok = await showConfirm({
    title: 'Excluir workspace',
    message: `Excluir o workspace <strong>${esc(w?.name || '')}</strong>?<br><br>Todos os projetos, fluxos e demandas dele serão removidos. <strong>Essa ação não pode ser desfeita.</strong>`,
    okLabel: 'Excluir definitivamente',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/workspaces/' + id, 'DELETE');
    if (activeWs === id) { activeWs = null; }
    toast('Workspace excluído.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── USUÁRIOS (admin) ─── */
function renderUsers() {
  const activeUsers = users.filter(u => u.active !== false);
  const archivedUsers = users.filter(u => u.active === false);
  const displayList = (showArchivedUsers ? users : activeUsers).slice().sort((a, b) => {
    let va, vb;
    if (userSortKey === 'name')     { va = norm(a.name); vb = norm(b.name); }
    else if (userSortKey === 'username') { va = norm(a.username); vb = norm(b.username); }
    else if (userSortKey === 'role')     { va = norm(a.role || ''); vb = norm(b.role || ''); }
    else if (userSortKey === 'ws')       { va = (a.workspaces || []).length; vb = (b.workspaces || []).length; }
    else if (userSortKey === 'admin')    { va = a.isAdmin ? 0 : 1; vb = b.isAdmin ? 0 : 1; }
    else if (userSortKey === 'active')   { va = a.active !== false ? 0 : 1; vb = b.active !== false ? 0 : 1; }
    else { va = norm(a.name); vb = norm(b.name); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * userSortDir;
  });

  $('user-archive-toggle').textContent = showArchivedUsers ? 'Ocultar desativados' : `Ver desativados (${archivedUsers.length})`;
  $('user-archive-toggle').style.display = archivedUsers.length || showArchivedUsers ? '' : 'none';

  $('users-table-body').innerHTML = displayList.map(u => {
    const wsNames = u.isAdmin
      ? '<span style="color:var(--text-muted);font-size:12px">Todos (admin)</span>'
      : (u.workspaces || []).map(id => wsById(id)).filter(Boolean).map(w => `<span class="pill pill-muted" style="font-size:10px">${esc(w.name)}</span>`).join(' ') || '—';
    return `<tr class="row-hover-actions" style="${u.active === false ? 'opacity:.55' : ''}">
      <td>${cellUser(u)}</td>
      <td style="color:var(--text-dim)">${esc(u.username)}</td>
      <td>${esc(u.role || '—')}</td>
      <td>${wsNames}</td>
      <td>${u.isAdmin ? '<span class="pill pill-admin">Admin</span>' : '<span class="pill pill-muted">Equipe</span>'}</td>
      <td>${u.active !== false ? '<span class="pill pill-success">Ativo</span>' : '<span class="pill pill-muted">Desativado</span>'}</td>
      <td>${me.isAdmin ? `<div class="row-actions">
          <button class="detail-icon-btn" title="Editar" onclick="openUserModal('${u.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>
          ${u.id !== me.id ? (u.active !== false
            ? `<button class="detail-icon-btn danger" title="Desativar" onclick="toggleUser('${u.id}')"><i data-lucide="user-x" class="ic-sm"></i></button>`
            : `<button class="detail-icon-btn" title="Reativar" onclick="toggleUser('${u.id}')"><i data-lucide="user-check" class="ic-sm"></i></button>`
          ) : ''}
        </div>` : ''}</td>
    </tr>`;
  }).join('');
  renderRoles();
}
function toggleArchivedUsers() {
  showArchivedUsers = !showArchivedUsers;
  renderUsers();
}
function sortUsersBy(key) {
  if (userSortKey === key) userSortDir *= -1;
  else { userSortKey = key; userSortDir = 1; }
  renderUsers();
}
function renderRoles() {
  const sorted = roles.slice().sort((a, b) => {
    const ca = users.filter(u => u.role === a.name && u.active !== false).length;
    const cb = users.filter(u => u.role === b.name && u.active !== false).length;
    let va, vb;
    if (roleSortKey === 'count') { va = ca; vb = cb; }
    else { va = norm(a.name); vb = norm(b.name); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * roleSortDir;
  });
  $('roles-table-body').innerHTML = sorted.length ? sorted.map(r => {
    const count = users.filter(u => u.role === r.name && u.active !== false).length;
    const actions = me.isAdmin ? `<div class="row-actions">
          <button class="detail-icon-btn" title="Editar" onclick="openRoleModal('${r.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>
          <button class="detail-icon-btn danger" title="Excluir" onclick="deleteRole('${r.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
        </div>` : '';
    return `<tr class="row-hover-actions">
      <td><strong>${esc(r.name)}</strong></td>
      <td>${count} ${count === 1 ? 'usuário' : 'usuários'}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="3">${emptyState('Nenhuma função cadastrada', 'Adicione funções para organizar a equipe.', 'users')}</td></tr>`;
}
function sortRolesBy(key) {
  if (roleSortKey === key) roleSortDir *= -1;
  else { roleSortKey = key; roleSortDir = 1; }
  renderRoles();
}
function openRoleModal(id) {
  editingRoleId = id || null;
  $('role-modal-title').textContent = id ? 'Editar Função' : 'Nova Função';
  const r = id ? roles.find(x => x.id === id) : null;
  $('role-name').value = r?.name || '';
  openModal('role-modal');
  setTimeout(() => $('role-name').focus(), 60);
}

/* ─── TEMPLATES ─── */

/* ─── INTEGRAÇÕES / WEBHOOKS ─── */
const WEBHOOK_EVENT_LABELS = {
  'demand.created': 'Demanda criada',
  'demand.completed': 'Demanda concluída',
  'demand.stage_changed': 'Etapa avançada',
  'demand.assigned': 'Responsável alterado manualmente',
  'demand.stage_assigned': 'Responsável atribuído pela etapa',
  'demand.deadline_changed': 'Prazo alterado',
  'demand.priority_changed': 'Prioridade alterada',
  'comment.added': 'Comentário adicionado',
  'comment.mention': 'Menção em comentário',
  'checklist.completed': 'Item de checklist concluído',
};
let editingWhId = null;
async function renderIntegrations() {
  try {
    webhooks = await api('/webhooks');
  } catch (e) { /* ignore */ }
  const wsHooks = webhooks.filter(h => h.workspaceId === activeWs);
  $('webhooks-table-body').innerHTML = wsHooks.length ? wsHooks.map(h => {
    const eventChips = (h.events || []).slice(0, 3).map(e => `<span class="pill pill-muted" style="font-size:9px">${esc(WEBHOOK_EVENT_LABELS[e] || e)}</span>`).join(' ');
    const moreCount = (h.events || []).length - 3;
    const statusPill = !h.active
      ? '<span class="pill pill-muted">Pausado</span>'
      : (h.lastError ? `<span class="pill" style="color:var(--danger);background:var(--danger-dim)">Erro</span>` : '<span class="pill pill-success">Ativo</span>');
    const target = h.targetUserId ? userById(h.targetUserId) : null;
    const targetChip = target
      ? `<div style="margin-top:4px"><span class="pill" style="font-size:9px;color:var(--accent-text);background:var(--accent-dim)">Alvo: ${esc(target.name)}</span>${target.discordId ? '' : '<span class="pill" style="font-size:9px;color:var(--danger);background:var(--danger-dim);margin-left:4px" title="Esse usuário ainda não vinculou o ID do Discord">sem ID</span>'}</div>`
      : '';
    return `<tr class="row-hover-actions">
      <td><strong>${esc(h.name)}</strong>${targetChip}${h.lastTriggered ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">Último envio: ${esc(fmtDateTime(h.lastTriggered))}</div>` : ''}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:11px;color:var(--text-dim)" title="${esc(h.url)}">${esc(h.url)}</td>
      <td>${h.format === 'discord' ? '<span class="pill" style="color:#5865f2;background:rgba(88,101,242,0.15);font-size:10px">Discord</span>' : '<span class="pill pill-muted" style="font-size:10px">Raw JSON</span>'}</td>
      <td>${eventChips}${moreCount > 0 ? `<span class="pill pill-muted" style="font-size:9px">+${moreCount}</span>` : ''}</td>
      <td>${statusPill}${h.lastError ? `<div style="font-size:10px;color:var(--danger);margin-top:2px">${esc(h.lastError.slice(0, 50))}</div>` : ''}</td>
      <td>${me.isAdmin ? `<div class="row-actions">
          <button class="detail-icon-btn" title="Editar" onclick="openWebhookModal('${h.id}')"><i data-lucide="pencil" class="ic-sm"></i></button>
          <button class="detail-icon-btn" title="Enviar teste" onclick="testWebhookById('${h.id}')"><i data-lucide="send" class="ic-sm"></i></button>
          <button class="detail-icon-btn danger" title="Excluir" onclick="confirmDeleteWebhook('${h.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
        </div>` : ''}
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6">${emptyState('Nenhuma integração cadastrada', 'Adicione um webhook para receber eventos das demandas em ferramentas externas como Discord, Slack, Make ou n8n.', 'webhook')}</td></tr>`;
  paintIcons();
}
function openWebhookModal(id) {
  editingWhId = id || null;
  $('webhook-modal-title').textContent = id ? 'Editar Integração' : 'Nova Integração';
  const h = id ? webhooks.find(x => x.id === id) : null;
  $('wh-name').value = h?.name || '';
  $('wh-url').value = h?.url || '';
  $('wh-format').value = h?.format || 'discord';
  $('wh-active').value = h?.active === false ? 'false' : 'true';
  $('wh-test-btn').style.display = id ? '' : 'none';
  const targetSel = $('wh-target-user');
  const usersForWs = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  targetSel.innerHTML = '<option value="">— Todos os usuários (sem filtro) —</option>' +
    usersForWs.map(u => `<option value="${u.id}">${esc(u.name)}${u.discordId ? '' : ' (sem ID do Discord)'}</option>`).join('');
  targetSel.value = h?.targetUserId || '';
  const events = h?.events || ['demand.created', 'demand.completed', 'demand.stage_changed'];
  $('wh-events').innerHTML = Object.entries(WEBHOOK_EVENT_LABELS).map(([k, label]) => `
    <label class="wh-event-row">
      <input type="checkbox" value="${k}" ${events.includes(k) ? 'checked' : ''}>
      <span>${esc(label)}</span>
    </label>
  `).join('');
  openModal('webhook-modal');
  navPush(id ? '/integrations/webhooks/' + id : '/integrations/webhooks/new');
  setTimeout(() => $('wh-name').focus(), 60);
}
async function saveWebhook() {
  const events = [...document.querySelectorAll('#wh-events input:checked')].map(i => i.value);
  const payload = {
    workspaceId: activeWs,
    name: $('wh-name').value,
    url: $('wh-url').value,
    format: $('wh-format').value,
    active: $('wh-active').value === 'true',
    events,
    targetUserId: $('wh-target-user').value || null
  };
  try {
    if (editingWhId) await api('/webhooks/' + editingWhId, 'PUT', payload);
    else await api('/webhooks', 'POST', payload);
    closeModal('webhook-modal');
    toast(editingWhId ? 'Integração atualizada!' : 'Integração criada!');
    webhooks = await api('/webhooks');
    renderIntegrations();
  } catch (e) { toast(e.message, 'error'); }
}
async function testWebhook() {
  if (!editingWhId) return;
  await testWebhookById(editingWhId);
}
async function testWebhookById(id) {
  try {
    await api('/webhooks/' + id + '/test', 'POST');
    toast('Teste enviado com sucesso!');
    webhooks = await api('/webhooks');
    renderIntegrations();
  } catch (e) { toast(e.message, 'error'); }
}
async function confirmDeleteWebhook(id) {
  const h = webhooks.find(x => x.id === id); if (!h) return;
  const ok = await showConfirm({
    title: 'Excluir integração',
    message: `Excluir o webhook <strong>${esc(h.name)}</strong>?<br><br>Os eventos das demandas deixarão de ser enviados para este endpoint.`,
    okLabel: 'Excluir', danger: true
  });
  if (!ok) return;
  try {
    await api('/webhooks/' + id, 'DELETE');
    toast('Integração excluída.', 'warn');
    webhooks = await api('/webhooks');
    renderIntegrations();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── CHECKLIST INTERNO NA DEMANDA ─── */
async function addChecklistItem() {
  const input = $('checklist-input');
  const text = (input?.value || '').trim();
  if (!text) { input?.focus(); return; }
  try {
    const upd = await api('/demands/' + detailId + '/checklist', 'POST', { text });
    patchDemand(upd);
    input.value = '';
    renderDetail();
    setTimeout(() => $('checklist-input')?.focus(), 60);
  } catch (e) { toast(e.message, 'error'); }
}
async function toggleChecklistItem(itemId, done) {
  try {
    const upd = await api('/demands/' + detailId + '/checklist/' + itemId, 'PUT', { done });
    patchDemand(upd);
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}
async function removeChecklistItem(itemId) {
  try {
    const upd = await api('/demands/' + detailId + '/checklist/' + itemId, 'DELETE');
    patchDemand(upd);
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
}
function renderChecklist(d) {
  const items = d.checklist || [];
  const done = items.filter(i => i.done).length;
  const pct = items.length ? Math.round(done / items.length * 100) : 0;
  return `
    <div class="detail-section-block">
      <div class="field-head">
        <div class="field-label">
          <i data-lucide="check-square" class="ic-sm" style="vertical-align:middle"></i>
          Checklist
          ${items.length ? `<span style="margin-left:8px;font-size:11px;color:var(--text-muted);font-weight:500">${done}/${items.length}</span>` : ''}
        </div>
      </div>
      ${items.length ? `<div class="checklist-bar"><div class="checklist-bar-fill" style="width:${pct}%"></div></div>` : ''}
      <div class="checklist-list">
        ${items.map(it => {
          const author = userById(it.doneBy);
          return `<div class="checklist-item ${it.done ? 'done' : ''}">
            <button type="button" class="checklist-check" onclick="toggleChecklistItem('${it.id}', ${!it.done})" title="${it.done ? 'Desmarcar' : 'Marcar como concluído'}">
              ${it.done ? '<i data-lucide="check" class="ic-sm"></i>' : ''}
            </button>
            <span class="checklist-text">${esc(it.text)}</span>
            ${it.done && author ? `<span class="checklist-meta">por ${esc(author.name.split(' ')[0])} · ${esc(fmtDate(it.doneAt))}</span>` : ''}
            <button type="button" class="detail-icon-btn checklist-del" onclick="removeChecklistItem('${it.id}')" title="Remover"><i data-lucide="x" class="ic-xs"></i></button>
          </div>`;
        }).join('')}
      </div>
      <div class="checklist-add">
        <input class="form-control" id="checklist-input" placeholder="Adicionar item ao checklist…" onkeydown="if(event.key==='Enter'){event.preventDefault();addChecklistItem()}">
        <button class="btn btn-ghost btn-sm" onclick="addChecklistItem()"><i data-lucide="plus" class="ic-sm"></i> Adicionar</button>
      </div>
    </div>
  `;
}

/* ─── REAÇÕES EM COMENTÁRIOS ─── */
const REACTION_EMOJIS = ['👍', '❤️', '👀', '✅', '🎉'];
async function toggleReaction(commentId, emoji) {
  try {
    const upd = await api('/demands/' + detailId + '/comment/' + commentId + '/react', 'POST', { emoji });
    patchDemand(upd);
    renderDetail();
  } catch (e) { toast(e.message, 'error'); }
  // Fecha qualquer picker aberto
  document.querySelectorAll('.reaction-picker.open').forEach(p => p.classList.remove('open'));
}
function toggleReactionPicker(commentId) {
  const picker = document.getElementById('rxp-' + commentId);
  if (!picker) return;
  const wasOpen = picker.classList.contains('open');
  document.querySelectorAll('.reaction-picker.open').forEach(p => p.classList.remove('open'));
  if (!wasOpen) {
    picker.classList.add('open');
    // Fecha ao clicar fora
    setTimeout(() => {
      const handler = (e) => {
        if (!e.target.closest('.reaction-picker-wrap')) {
          picker.classList.remove('open');
          document.removeEventListener('mousedown', handler);
        }
      };
      document.addEventListener('mousedown', handler);
    }, 50);
  }
}
function renderReactions(c) {
  const reactions = c.reactions || {};
  const keys = Object.keys(reactions).filter(k => (reactions[k] || []).length > 0);
  const myId = me?.id;
  const chips = keys.map(emoji => {
    const userIds = reactions[emoji] || [];
    const mine = userIds.includes(myId);
    const names = userIds.map(id => userById(id)?.name || '?').join(', ');
    return `<button type="button" class="reaction-chip ${mine ? 'mine' : ''}" onclick="toggleReaction('${c.id}', '${emoji}')" title="${esc(names)}">
      <span class="reaction-emoji">${emoji}</span>
      <span class="reaction-count">${userIds.length}</span>
    </button>`;
  }).join('');
  const pickerOpts = REACTION_EMOJIS.map(e => `<button type="button" class="reaction-opt" onclick="toggleReaction('${c.id}', '${e}')">${e}</button>`).join('');
  return `<div class="reactions-row">
    ${chips}
    <div class="reaction-picker-wrap">
      <button type="button" class="reaction-add" onclick="toggleReactionPicker('${c.id}')" title="Adicionar reação"><i data-lucide="smile-plus" class="ic-xs"></i></button>
      <div class="reaction-picker" id="rxp-${c.id}">${pickerOpts}</div>
    </div>
  </div>`;
}

/* ─── DRAG AND DROP DE ANEXOS ─── */
let dragCounter = 0;
function setupDragDrop(containerSelector, targetListId, callback) {
  // callback recebe os arquivos e adiciona aos anexos
  const setup = (el) => {
    if (el.dataset.dndBound) return;
    el.dataset.dndBound = '1';
    el.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounter++;
      el.classList.add('drag-over');
    });
    el.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('dragleave', e => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        el.classList.remove('drag-over');
      }
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      dragCounter = 0;
      el.classList.remove('drag-over');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      await callback(files, targetListId);
    });
  };
  document.querySelectorAll(containerSelector).forEach(setup);
}

async function processDroppedFiles(files, listElementId) {
  // Converte cada arquivo em base64 e adiciona à lista global
  for (const file of files) {
    const limit = 10 * 1024 * 1024;
    if (file.size > limit) { toast(`${file.name}: arquivo muito grande (máx 10MB)`, 'error'); continue; }
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    demandAttachments.push({
      id: 'a' + Math.random().toString(36).slice(2,10),
      kind: 'file',
      name: file.name,
      type: file.type || 'application/octet-stream',
      data: String(dataUrl)
    });
  }
  if (listElementId === 'detail-attachments-list') {
    // Modal de detalhe: salva direto via PUT
    const d = demandById(detailId); if (!d) return;
    const newAtts = [...(d.attachments || []), ...demandAttachments.filter(a => !(d.attachments || []).find(x => x.id === a.id))];
    try {
      const upd = await api('/demands/' + d.id, 'PUT', { attachments: newAtts });
      patchDemand(upd);
      demandAttachments = [];
      renderDetail();
      toast('Arquivo anexado!');
    } catch (e) { toast(e.message, 'error'); }
  } else {
    refreshFormAttList(listElementId);
    toast(`${files.length} arquivo${files.length === 1 ? '' : 's'} adicionado${files.length === 1 ? '' : 's'}`);
  }
}

/* ─── DEMANDAS RECORRENTES (mensais) ───
   Painel separado pra moldes que viram demandas mensalmente. Não auto-gera —
   o usuário escolhe o mês e clica em "Gerar" por linha ou em bulk.
   Estado de geração vive no próprio recurring (generations[{ym,demandId}]). */
let editingRecurringId = null;
let recurringChecklistDraft = [];

function currentYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function ymLabel(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '';
  const [y, m] = ym.split('-').map(Number);
  return MONTHS[m - 1] + '/' + y;
}
function recurringGenerationFor(r, ym) {
  return (r.generations || []).find(g => g.ym === ym) || null;
}

/* ─── Painel Recorrentes v2 ────────────────────────────────
   Layout 2-col: coluna esquerda = clientes; direita = tabs (DEMANDAS/LISTAS),
   search, segmented group-by, header do cliente, grupos com sub-listas.
   Estado persistido: cliente selecionado, tab, group-by, colapsados. */
const _recCollapsed = new Set(JSON.parse(localStorage.getItem('kastor-rec-collapsed') || '[]'));
function _persistRecCollapsed() {
  try { localStorage.setItem('kastor-rec-collapsed', JSON.stringify([..._recCollapsed])); } catch {}
}
let _recSelectedClientId = localStorage.getItem('kastor-rec-client') || null;
let _recTab = localStorage.getItem('kastor-rec-tab') || 'demandas';
let _recGroupBy = localStorage.getItem('kastor-rec-groupby') || 'project';

function toggleRecGroup(key) {
  if (_recCollapsed.has(key)) _recCollapsed.delete(key);
  else _recCollapsed.add(key);
  _persistRecCollapsed();
  // Toggle visual sem re-render pra não perder scroll
  document.querySelectorAll(`[data-collapse-key="${CSS.escape(key)}"]`).forEach(el => el.classList.toggle('is-collapsed'));
}

function setRecurringTab(tab) {
  _recTab = tab;
  try { localStorage.setItem('kastor-rec-tab', tab); } catch {}
  document.querySelectorAll('.rec-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
  $('rec-tab-demandas').style.display = tab === 'demandas' ? '' : 'none';
  $('rec-tab-listas').style.display = tab === 'listas' ? '' : 'none';
  // Esconde coluna de clientes quando aba Listas ativa (layout muda pra full-width)
  document.body.classList.toggle('rec-tab-listas-active', tab === 'listas');
  // Sincroniza URL com a aba ativa (não faz nada se já estamos na URL correta —
  // navPush já tem guard). _routerSilent evita loop quando chamado pelo popstate.
  const targetPath = tab === 'listas' ? '/recurring/lists' : '/recurring/demands';
  navPush(targetPath);
  renderRecurring();
}
function setRecurringGroupBy(g) {
  _recGroupBy = g;
  try { localStorage.setItem('kastor-rec-groupby', g); } catch {}
  document.querySelectorAll('.rec-groupby-btn').forEach(b => b.classList.toggle('is-active', b.dataset.groupby === g));
  renderRecurring();
}
function setRecurringClient(clientId) {
  const wasAll = _recSelectedClientId === '__all__';
  _recSelectedClientId = clientId;
  try { localStorage.setItem('kastor-rec-client', clientId); } catch {}
  // Quando entra no modo "Todos os clientes", sempre padroniza pra groupBy=client
  // — a visualização nested (cliente → projetos) é o comportamento do wireframe.
  if (clientId === '__all__' && !wasAll) {
    _recGroupBy = 'client';
    try { localStorage.setItem('kastor-rec-groupby', 'client'); } catch {}
  }
  // Ao sair de "Todos" pra um cliente específico, garante um groupBy válido
  // (não pode ficar em 'client' que só existe no modo Todos).
  if (clientId !== '__all__' && _recGroupBy === 'client') {
    _recGroupBy = 'project';
    try { localStorage.setItem('kastor-rec-groupby', 'project'); } catch {}
  }
  renderRecurring();
}

// Conta demandas geradas de um recorrente no mês corrente: retorna
// { pending: 0/1, inProgress: 0/1, done: 0/1 } — exatamente uma dessas é 1.
function recurringStatusForMonth(r, ym) {
  if (r.active === false) return { pending: 0, inProgress: 0, done: 0, inactive: 1 };
  const gen = recurringGenerationFor(r, ym);
  if (!gen) return { pending: 1, inProgress: 0, done: 0 };
  const d = demandById(gen.demandId);
  if (!d) return { pending: 1, inProgress: 0, done: 0 }; // demanda excluída = re-pendente
  if (d.completedAt) return { pending: 0, inProgress: 0, done: 1 };
  return { pending: 0, inProgress: 1, done: 0 };
}

function renderRecurring() {
  $('rec-tab-demandas').style.display = _recTab === 'demandas' ? '' : 'none';
  $('rec-tab-listas').style.display = _recTab === 'listas' ? '' : 'none';
  document.querySelectorAll('.rec-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === _recTab));
  // Body class: layout muda pra full-width na aba Listas (esconde coluna clientes).
  // Aplicado aqui pra ser consistente independente do caminho de entrada (nav-item, URL direta, popstate).
  document.body.classList.toggle('rec-tab-listas-active', _recTab === 'listas');

  const ym = currentYm();
  const wsClients = clients.filter(c => c.workspaceId === activeWs && c.active !== false)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));

  // '__all__' = modo "Todos os clientes" (pill do topo). Persistido em localStorage.
  const isAll = _recSelectedClientId === '__all__';
  if (!isAll && !wsClients.some(c => c.id === _recSelectedClientId)) {
    // Fallback: se o cliente selecionado sumiu, cai pro "todos"
    _recSelectedClientId = '__all__';
  }

  // Pills de group-by dinâmicas:
  //   modo todos → Cliente | Projeto | Função | Responsável
  //   modo cliente → Projeto | Função | Responsável
  syncRecurringGroupByPills(isAll);

  renderRecurringClientsCol(wsClients);
  if (_recTab === 'demandas') renderRecurringContent(ym);
  else if (_recTab === 'listas') renderListasContent();
  paintIcons();
}

// Rebuilda a segmented control dependendo do modo (todos vs cliente).
// Chamada dentro de renderRecurring — mantém _recGroupBy consistente.
function syncRecurringGroupByPills(isAll) {
  const wrap = document.querySelector('.rec-groupby');
  if (!wrap) return;
  // Modo "Todos os clientes" não tem 'Projeto' — a nested view por cliente
  // já cobre a hierarquia. Projeto flat agrega demais e confunde.
  const opts = isAll
    ? [['client', 'Cliente'], ['role', 'Função'], ['owner', 'Responsável']]
    : [['project', 'Projeto'], ['role', 'Função'], ['owner', 'Responsável']];
  // Ajusta groupBy se o corrente não existir no set atual
  if (!opts.some(([k]) => k === _recGroupBy)) {
    _recGroupBy = isAll ? 'client' : 'project';
    try { localStorage.setItem('kastor-rec-groupby', _recGroupBy); } catch {}
  }
  wrap.innerHTML = opts.map(([k, label]) =>
    `<button class="rec-groupby-btn ${k === _recGroupBy ? 'is-active' : ''}" data-groupby="${k}" onclick="setRecurringGroupBy('${k}')">${label}</button>`
  ).join('');
}

function renderRecurringClientsCol(wsClients) {
  const col = $('rec-clients-col');
  // Card sempre-presente "Todos os clientes" no topo
  const isAllSel = _recSelectedClientId === '__all__';
  const totalPill = `<div class="rec-clients-all ${isAllSel ? 'is-selected' : ''}" onclick="setRecurringClient('__all__')">
    <span>Todos os clientes</span>
  </div>`;
  if (!wsClients.length) {
    col.innerHTML = totalPill + '<div class="rec-clients-empty">Nenhum cliente neste workspace.</div>';
    return;
  }
  const cardsHtml = wsClients.map(c => {
    const projectCount = projects.filter(p => p.clientId === c.id && p.active !== false).length;
    const isSel = c.id === _recSelectedClientId;
    const avatar = c.avatar
      ? `<div class="rec-client-card-avatar" style="background-image:url('${c.avatar}')"></div>`
      : `<div class="rec-client-card-avatar" style="background:${hexDim(c.color || '#7A00FF')};color:${c.color || '#7A00FF'}">${esc((c.name || '?').charAt(0).toUpperCase())}</div>`;
    return `<div class="rec-client-card ${isSel ? 'is-selected' : ''}" onclick="setRecurringClient('${c.id}')">
      ${avatar}
      <div class="rec-client-card-body">
        <div class="rec-client-card-name">${esc(c.name)}</div>
        <div class="rec-client-card-sub">${projectCount} projeto${projectCount === 1 ? '' : 's'}</div>
      </div>
    </div>`;
  }).join('');
  col.innerHTML = totalPill + cardsHtml;
}

function renderRecurringContent(ym) {
  const body = $('rec-content-body');
  const q = norm($('rec-search')?.value || '');
  const isAll = _recSelectedClientId === '__all__';

  if (isAll) {
    // Modo "Todos os clientes": ignora _recSelectedClientId, roda por todo o workspace.
    const wsRecurrings = recurrings
      .filter(r => r.workspaceId === activeWs)
      .filter(r => !q || norm(r.name).includes(q));
    body.innerHTML = renderRecurringAllClients(wsRecurrings, ym, _recGroupBy);
    paintIcons();
    return;
  }

  const client = clientById(_recSelectedClientId);
  if (!client) {
    body.innerHTML = emptyState('Nenhum cliente selecionado', 'Escolha um cliente na coluna à esquerda ou "Todos os clientes" pra ver as demandas.', 'default');
    return;
  }
  body.innerHTML = renderRecurringSingleClient(client, ym, _recGroupBy, q);
  paintIcons();
}

/* Modo cliente específico — header do cliente + grupos por projeto/função/responsável. */
function renderRecurringSingleClient(client, ym, groupBy, q) {
  const clientRecurrings = recurrings
    .filter(r => r.workspaceId === activeWs && r.clientId === client.id)
    .filter(r => !q || norm(r.name).includes(q));

  const counts = aggregateStatusCounts(clientRecurrings, ym);
  const headerHtml = renderRecurringClientHeader(client, counts);
  const groupSpecs = collectRecurringGroups(groupBy, client, clientRecurrings);
  const groupsHtml = groupSpecs.map(spec => renderRecurringGroup(spec, clientRecurrings, ym, groupBy, client)).join('');
  return headerHtml + (groupsHtml || emptyState('Sem grupos ainda', 'Adicione uma Lista ou uma recorrente personalizada abaixo.', 'default'));
}

/* Modo Todos os clientes — 4 opções de group-by (Cliente/Projeto/Função/Responsável). */
function renderRecurringAllClients(wsRecurrings, ym, groupBy) {
  if (groupBy === 'client') {
    // Agrupa por cliente. Cada cliente é um card grande com sub-grupos (Geral/Projeto).
    const wsClients = clients.filter(c => c.workspaceId === activeWs && c.active !== false)
      .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
    return wsClients.map(c => renderRecurringClientTopGroup(c, wsRecurrings, ym)).join('');
  }
  // Groupby por projeto/função/responsável — flat, sem "Geral"
  const groups = new Map();
  const keyFor = (r) => {
    if (groupBy === 'project') return r.projectId || '__none__';
    if (groupBy === 'role')    return r.roleId    || '__none__';
    if (groupBy === 'owner')   return r.ownerId   || '__none__';
  };
  const labelFor = (k) => {
    if (k === '__none__') {
      if (groupBy === 'project') return 'Sem projeto';
      if (groupBy === 'role')    return 'Sem função';
      return 'Sem responsável';
    }
    if (groupBy === 'project') return projectById(k)?.name || 'Projeto removido';
    if (groupBy === 'role')    return roles.find(x => x.id === k)?.name || 'Função removida';
    return userById(k)?.name || 'Usuário removido';
  };
  for (const r of wsRecurrings) {
    const k = keyFor(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => norm(labelFor(a)).localeCompare(norm(labelFor(b))));
  return sortedKeys.map(key => {
    const items = groups.get(key);
    const spec = { key,
      label: labelFor(key),
      projectId: groupBy === 'project' ? (key === '__none__' ? null : key) : null,
      roleId:    groupBy === 'role'    ? (key === '__none__' ? null : key) : null,
      ownerId:   groupBy === 'owner'   ? (key === '__none__' ? null : key) : null,
      isAllMode: true
    };
    return renderRecurringGroup(spec, items, ym, groupBy, null);
  }).join('');
}

/* Card grande de cliente (usado só no modo "todos + agrupado por cliente"). */
function renderRecurringClientTopGroup(client, wsRecurrings, ym) {
  const clientItems = wsRecurrings.filter(r => r.clientId === client.id);
  const counts = aggregateStatusCounts(clientItems, ym);
  const groupKey = `top:client:${client.id}`;
  const isCollapsed = _recCollapsed.has(groupKey);
  const avatar = client.avatar
    ? `<div class="rec-client-header-avatar" style="background-image:url('${client.avatar}')"></div>`
    : `<div class="rec-client-header-avatar" style="background:${hexDim(client.color || '#7A00FF')};color:${client.color || '#7A00FF'}">${esc((client.name || '?').charAt(0).toUpperCase())}</div>`;
  // Sub-grupos sempre renderizados; visibilidade controlada por CSS (evita
  // problema de re-render ao colapsar/expandir).
  const groupSpecs = collectRecurringGroups('project', client, clientItems);
  const subgroupsHtml = `<div class="rec-client-top-body">
    ${groupSpecs.map(spec => renderRecurringGroup(spec, clientItems, ym, 'project', client)).join('')}
  </div>`;
  return `<div class="rec-client-top ${isCollapsed ? 'is-collapsed' : ''}" data-collapse-key="${esc(groupKey)}">
    <div class="rec-client-top-head" onclick="toggleRecGroup('${esc(groupKey)}')">
      ${avatar}
      <div class="rec-client-header-name">${esc(client.name)}</div>
      <div class="rec-status-counts">
        <span class="rec-status-count is-progress">Em andamento <b>${counts.inProgress}</b></span>
        <span class="rec-status-count is-pending">Pendente <b>${counts.pending}</b></span>
        <span class="rec-status-count is-done">Concluído <b>${counts.done}</b></span>
        <span class="rec-status-count">Total <b>${counts.total}</b></span>
      </div>
      <i data-lucide="chevron-down" class="ic-sm rec-chevron" style="margin-left:8px"></i>
    </div>
    ${subgroupsHtml}
  </div>`;
}

/* Helper: agrega contagens de status pra um conjunto de recorrentes. */
function aggregateStatusCounts(items, ym) {
  let pending = 0, inProgress = 0, done = 0;
  items.forEach(r => {
    if (r.active === false) return;
    const s = recurringStatusForMonth(r, ym);
    pending += s.pending; inProgress += s.inProgress; done += s.done;
  });
  const total = items.filter(r => r.active !== false).length;
  return { pending, inProgress, done, total };
}

/* Header do cliente selecionado (modo específico). */
function renderRecurringClientHeader(client, counts) {
  const avatarHtml = client.avatar
    ? `<div class="rec-client-header-avatar" style="background-image:url('${client.avatar}')"></div>`
    : `<div class="rec-client-header-avatar" style="background:${hexDim(client.color || '#7A00FF')};color:${client.color || '#7A00FF'}">${esc((client.name || '?').charAt(0).toUpperCase())}</div>`;
  return `<div class="rec-client-header">
    ${avatarHtml}
    <div class="rec-client-header-name">${esc(client.name)}</div>
    <div class="rec-status-counts">
      <span class="rec-status-count is-progress">Em andamento <b>${counts.inProgress}</b></span>
      <span class="rec-status-count is-pending">Pendente <b>${counts.pending}</b></span>
      <span class="rec-status-count is-done">Concluído <b>${counts.done}</b></span>
      <span class="rec-status-count">Total <b>${counts.total}</b></span>
    </div>
  </div>`;
}

/* Constrói a lista de grupos a exibir dado o groupBy escolhido. */
function collectRecurringGroups(groupBy, client, clientRecurrings) {
  if (groupBy === 'project') {
    // Sempre inclui "Geral" (recorrentes sem projeto) + TODOS projetos ativos do cliente
    // (independente de terem demandas). Consistente com o count da sidebar.
    const groups = [{ key: '__geral__', label: 'Geral', projectId: null }];
    const clientProjs = projects.filter(p => p.clientId === client.id && p.active !== false)
      .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
    for (const p of clientProjs) groups.push({ key: p.id, label: p.name, projectId: p.id });
    return groups;
  }
  if (groupBy === 'role') {
    const used = new Set(clientRecurrings.map(r => r.roleId || '__none__'));
    const groups = [];
    for (const rId of used) {
      if (rId === '__none__') groups.push({ key: '__none__', label: 'Sem função', roleId: null });
      else {
        const role = roles.find(x => x.id === rId);
        if (role) groups.push({ key: role.id, label: role.name, roleId: role.id });
      }
    }
    if (!groups.length) groups.push({ key: '__none__', label: 'Sem função', roleId: null });
    return groups.sort((a, b) => norm(a.label).localeCompare(norm(b.label)));
  }
  // owner
  const used = new Set(clientRecurrings.map(r => r.ownerId || '__none__'));
  const groups = [];
  for (const uId of used) {
    if (uId === '__none__') groups.push({ key: '__none__', label: 'Sem responsável', ownerId: null });
    else {
      const u = userById(uId);
      if (u) groups.push({ key: u.id, label: u.name, ownerId: u.id });
    }
  }
  if (!groups.length) groups.push({ key: '__none__', label: 'Sem responsável', ownerId: null });
  return groups.sort((a, b) => norm(a.label).localeCompare(norm(b.label)));
}

/* Renderiza 1 grupo (Projeto/Função/Responsável) com suas Listas + Personalizada + botões. */
function renderRecurringGroup(spec, clientRecurrings, ym, groupBy, client) {
  // Filtra recorrentes deste grupo
  const items = clientRecurrings.filter(r => {
    if (groupBy === 'project') return (spec.projectId ? r.projectId === spec.projectId : !r.projectId);
    if (groupBy === 'role')    return (spec.roleId    ? r.roleId    === spec.roleId    : !r.roleId);
    if (groupBy === 'owner')   return (spec.ownerId   ? r.ownerId   === spec.ownerId   : !r.ownerId);
    return false;
  });

  // Contadores do grupo
  let p = 0, i = 0, d = 0;
  items.forEach(r => {
    if (r.active === false) return;
    const s = recurringStatusForMonth(r, ym);
    p += s.pending; i += s.inProgress; d += s.done;
  });
  const totalActive = items.filter(r => r.active !== false).length;

  const groupKey = `g:${groupBy}:${spec.key}`;
  const isCollapsed = _recCollapsed.has(groupKey);

  // Listas exibidas no grupo: TODAS as listas que têm recorrentes no grupo atual.
  // Isso cobre o caso de listas Geral aplicadas a projetos específicos (clones
  // mantêm o listaId da lista template original) — a lista aparece no grupo
  // do projeto de destino mesmo se seu escopo original for outro.
  const usedListaIds = new Set(items.map(r => r.listaId).filter(Boolean));
  const scopedListas = listas.filter(l => usedListaIds.has(l.id))
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));

  // Sub-blocos: cada Lista (com seus itens filtrados) + itens sem lista ("Personalizada")
  const sublistsHtml = scopedListas.map(l => {
    const listItems = items.filter(r => r.listaId === l.id);
    return renderRecurringSublist({
      key: `l:${l.id}:${groupBy}:${spec.key}`,
      title: l.name,
      icon: 'list',
      items: listItems,
      ym, groupBy,
      emptyLabel: 'Lista vazia.',
      listaId: l.id,
      canDelete: !!client  // só permite excluir a Lista se estamos em contexto de cliente
    });
  }).join('');

  const looseItems = items.filter(r => !r.listaId);
  // Personalizada só existe DEPOIS que o usuário criou a primeira demanda personalizada
  const personalizadaHtml = looseItems.length
    ? renderRecurringSublist({
        key: `personalizada:${groupBy}:${spec.key}`,
        title: 'Personalizada',
        icon: 'circle-dashed',
        items: looseItems,
        ym, groupBy,
        emptyLabel: 'Sem recorrentes personalizadas neste grupo.'
      })
    : '';

  // Contexto pros botões "Adicionar" (herança de projeto/função/responsável).
  // No modo All sem cliente, o modal cai no state atual (usuário escolhe cliente lá).
  const addCtx = {
    clientId: (client && client.id) || null,
    projectId: spec.projectId || null,
    roleId: spec.roleId || null,
    ownerId: spec.ownerId || null
  };
  const addCtxJson = JSON.stringify(addCtx).replace(/'/g, "&#39;");

  return `<div class="rec-group ${isCollapsed ? 'is-collapsed' : ''}" data-collapse-key="${esc(groupKey)}">
    <div class="rec-group-head" onclick="toggleRecGroup('${esc(groupKey)}')">
      <i data-lucide="chevron-down" class="ic-sm rec-chevron"></i>
      <div class="rec-group-title">${esc(spec.label)}</div>
      <div class="rec-status-counts" style="gap:14px">
        <span class="rec-status-count is-progress">Em andamento <b>${i}</b></span>
        <span class="rec-status-count is-pending">Pendente <b>${p}</b></span>
        <span class="rec-status-count is-done">Concluído <b>${d}</b></span>
        <span class="rec-status-count">Total <b>${totalActive}</b></span>
      </div>
    </div>
    <div class="rec-group-body">
      ${sublistsHtml}
      ${personalizadaHtml}
      <div class="rec-add-row-wrap">
        ${client ? `<button class="rec-add-row" onclick='openAdicionarListaModal(${addCtxJson})'>
          <span class="rec-add-row-icon"><i data-lucide="plus" class="ic-xs"></i></span>
          <span>Adicionar lista</span>
        </button>` : ''}
        <button class="rec-add-row ${client ? '' : 'full-width'}" onclick='openPersonalizadaModal(${addCtxJson})'>
          <span class="rec-add-row-icon"><i data-lucide="plus" class="ic-xs"></i></span>
          <span>Adicionar demanda recorrente personalizada</span>
        </button>
      </div>
    </div>
  </div>`;
}

/* Renderiza um sub-bloco (Lista ou Personalizada).
   addCtx opcional → renderiza botão "+ Adicionar item" no fim.
   listaId + canDelete opcionais → renderiza ação de excluir a Lista no header. */
function renderRecurringSublist({ key, title, icon, items, ym, groupBy, emptyLabel, listaId, canDelete }) {
  // Nota: adicionar item numa Lista NÃO acontece aqui — só na aba Listas.
  // Este painel só exibe. A criação de personalizada usa o botão do rodapé.
  const isCollapsed = _recCollapsed.has(key);
  const itemsHtml = items.map(r => renderRecurringItem(r, ym, groupBy)).join('')
    || `<div class="rec-sublist-empty">${esc(emptyLabel)}</div>`;
  const deleteHtml = canDelete && listaId
    ? `<button type="button" class="rec-sublist-delete" title="Excluir lista (itens ficam sem lista)" onclick="event.stopPropagation();confirmDeleteLista('${esc(listaId)}', '${esc(title)}')"><i data-lucide="trash-2" class="ic-xs"></i></button>`
    : '';
  return `<div class="rec-sublist ${isCollapsed ? 'is-collapsed' : ''}" data-collapse-key="${esc(key)}">
    <div class="rec-sublist-head" onclick="toggleRecGroup('${esc(key)}')">
      <i data-lucide="chevron-down" class="ic-xs rec-chevron-sm"></i>
      <span style="flex:1">${esc(title)}</span>
      ${deleteHtml}
    </div>
    <div class="rec-sublist-body">
      ${itemsHtml}
    </div>
  </div>`;
}

async function confirmDeleteLista(id, name) {
  const ok = await showConfirm({
    title: 'Excluir lista',
    message: `Excluir a lista <strong>${esc(name)}</strong>?<br><br>Os itens que estavam nela viram "personalizados" (não são excluídos).`,
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/listas/' + id, 'DELETE');
    toast('Lista excluída.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* Renderiza 1 item (recorrente) com status badge e ações. */
function renderRecurringItem(r, ym, groupBy) {
  const inactive = r.active === false;
  const gen = recurringGenerationFor(r, ym);
  const d = gen ? demandById(gen.demandId) : null;

  // Status: Em andamento / Pendente / Concluída / Inativo
  let statusLabel, statusClass, isDoneCheck;
  if (inactive) { statusLabel = 'Inativo'; statusClass = 'is-inactive'; isDoneCheck = false; }
  else if (gen && d && d.completedAt) { statusLabel = 'Concluída'; statusClass = 'is-done'; isDoneCheck = true; }
  else if (gen && d) { statusLabel = 'Em andamento'; statusClass = 'is-progress'; isDoneCheck = true; }
  else { statusLabel = 'Pendente'; statusClass = 'is-pending'; isDoneCheck = false; }

  const f = r.flowId ? flowById(r.flowId) : null;
  const role = r.roleId ? roles.find(x => x.id === r.roleId) : null;
  const owner = r.ownerId ? userById(r.ownerId) : null;

  // Ordem definida pelo wireframe: Função → Responsável → Fluxo
  const metaChips = [];
  if (role)  metaChips.push(`<span class="rec-meta-chip"><i data-lucide="user-cog" class="ic-xs"></i>${esc(role.name)}</span>`);
  if (owner) metaChips.push(`<span class="rec-meta-chip"><i data-lucide="user" class="ic-xs"></i>${esc(owner.name)}</span>`);
  if (f)     metaChips.push(`<span class="rec-meta-chip"><i data-lucide="workflow" class="ic-xs"></i>${esc(f.name)}</span>`);
  if (r.dayOfMonth) metaChips.push(`<span class="rec-meta-chip"><i data-lucide="calendar" class="ic-xs"></i>Dia ${r.dayOfMonth}</span>`);

  const checkTitle = inactive
    ? 'Inativo — edite pra reativar'
    : isDoneCheck ? `Já gerada em ${ymLabel(ym)} — abrir demanda` : `Gerar demanda de ${ymLabel(ym)}`;
  const checkOnClick = inactive ? ''
    : isDoneCheck && d ? `showDetail('${gen.demandId}')`
    : `generateRecurring('${r.id}')`;

  // Dot de prioridade (inline com o nome) — Number() defensivo caso venha string
  const prio = PRIORITIES.find(x => x.value === Number(r.priority || 3)) || PRIORITIES[2];
  const prioDot = `<span class="rec-item-prio-dot" style="background:${prio.color}" title="${esc(prio.label)}"></span>`;

  return `<div class="rec-item ${inactive ? 'is-inactive' : ''}">
    <div class="rec-item-body">
      <div class="rec-item-name-row">${prioDot}<span class="rec-item-name">${esc(r.name)}</span></div>
      ${metaChips.length ? `<div class="rec-item-meta">${metaChips.join('')}</div>` : ''}
    </div>
    <div class="rec-status-pill ${statusClass}">${esc(statusLabel)}</div>
    <div class="rec-item-actions">
      <button class="rec-action-btn" title="Gerar / abrir demanda do mês" onclick="event.stopPropagation();${checkOnClick}" ${inactive ? 'disabled' : ''}><i data-lucide="zap" class="ic-sm"></i></button>
      <button class="rec-action-btn" title="Editar" onclick="event.stopPropagation();editRecurringSmart('${r.id}')"><i data-lucide="edit-3" class="ic-sm"></i></button>
      <button class="rec-action-btn" title="${r.active === false ? 'Reativar' : 'Desativar'}" onclick="event.stopPropagation();toggleRecurringActive('${r.id}')"><i data-lucide="${r.active === false ? 'circle-check' : 'x'}" class="ic-sm"></i></button>
      <button class="rec-action-btn danger" title="Excluir" onclick="event.stopPropagation();confirmDeleteRecurring('${r.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
    </div>
  </div>`;
}

/* ─── Modal Nova Demanda Personalizada ───────────────────────
   Wizard 2 steps: (1) picker de fluxo com Recentes + Todos, (2) form.
   Contexto de cliente/projeto vem de onde o botão foi clicado (ctx).
   Salva como recurring com listaId=null e retorna à página. */
const _personaState = { step: 1, flowId: null, ctx: {} };
let _personaAttachments = [];
let _personaChecklist = [];

function openPersonalizadaModal(ctx) {
  _personaState.step = 1;
  _personaState.flowId = null;
  _personaState.ctx = ctx || {};
  _personaAttachments = [];
  _personaChecklist = [];
  demandAttachments = _personaAttachments; // handleDemandAttachmentFiles lê essa var global
  // Header dinâmico: se veio de uma Lista, título vira "Nova demanda" +
  // nome da lista como subtítulo. Senão, mantém "Nova demanda personalizada".
  const titleEl = $('persona-title');
  const subEl = $('persona-subtitle');
  if (ctx && ctx.listaId) {
    const lista = listas.find(l => l.id === ctx.listaId);
    titleEl.textContent = 'Nova demanda';
    subEl.textContent = lista?.name || '';
    subEl.style.display = lista ? '' : 'none';
  } else {
    titleEl.textContent = 'Nova demanda personalizada';
    subEl.style.display = 'none';
    subEl.textContent = '';
  }
  // Reset form
  $('persona-name').value = '';
  $('persona-desc').value = '';
  $('persona-briefing').value = '';
  $('persona-priority').value = '3';
  $('persona-flow-search').value = '';
  refreshFormAttList('persona-attachments-list');
  renderPersonaChecklist();

  // Popula select de responsável (usuários do workspace)
  const wsUsersList = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('persona-owner').innerHTML = '<option value="">— Sem responsável fixo —</option>' +
    wsUsersList.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');

  renderPersonaFlows();
  personaGoTo(1);
  openModal('personalizada-modal');
  setTimeout(() => setupDragDrop('#personalizada-modal .modal-content', 'persona-attachments-list', processDroppedFiles), 60);
}

function personaGoTo(step) {
  _personaState.step = step;
  $('persona-step-1').style.display = step === 1 ? '' : 'none';
  $('persona-step-2').style.display = step === 2 ? '' : 'none';
  $('persona-back-btn').style.display = step === 2 ? '' : 'none';
  $('persona-next-btn').style.display = step === 1 ? '' : 'none';
  $('persona-create-btn').style.display = step === 2 ? '' : 'none';

  // Pill do fluxo: só visível quando já tem um selecionado
  const pill = $('persona-flow-pill');
  if (_personaState.flowId) {
    const f = flowById(_personaState.flowId);
    pill.textContent = (f?.name || 'FLUXO').toUpperCase();
    pill.style.display = '';
  } else {
    pill.style.display = 'none';
  }

  // Breadcrumb (só no step 2)
  if (step === 2) {
    const bc = $('persona-breadcrumb');
    const ctx = _personaState.ctx || {};
    const c = ctx.clientId ? clientById(ctx.clientId) : null;
    const p = ctx.projectId ? projectById(ctx.projectId) : null;
    const parts = [c?.name || 'Cliente', p?.name || 'Geral'];
    bc.innerHTML = parts.filter(Boolean).map(s => esc(s)).join(' <span style="opacity:.45">›</span> ');
    setTimeout(() => $('persona-name').focus(), 60);
  }
  updatePersonaNextBtn();
  paintIcons();
}

function updatePersonaNextBtn() {
  $('persona-next-btn').disabled = !_personaState.flowId;
}

/* Renderiza os cards de fluxo (Recentes + Todos) filtrados por busca. */
function renderPersonaFlows() {
  const q = norm($('persona-flow-search').value || '');
  const ctx = _personaState.ctx || {};
  // Escopo de fluxos: se tem projeto, pega fluxos do projeto; senão do cliente; senão do workspace
  let availableFlows;
  if (ctx.projectId) availableFlows = flowsForProject(ctx.projectId);
  else if (ctx.clientId) {
    const c = clientById(ctx.clientId);
    availableFlows = flows.filter(f =>
      f.workspaceId === activeWs && (
        f.clientId === ctx.clientId ||
        (c && (f.client || '').toLowerCase() === (c.name || '').toLowerCase()) ||
        (!f.clientId && !f.client) // fluxos gerais do workspace
      )
    );
  }
  else availableFlows = wsFlows();
  availableFlows = availableFlows.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));

  const filtered = availableFlows.filter(f => !q || norm(f.name).includes(q));

  // Recentes: até 4 do localStorage, filtrando pelos disponíveis
  const recentIds = getPersonaRecentFlowIds();
  const recents = recentIds
    .map(id => filtered.find(f => f.id === id))
    .filter(Boolean)
    .slice(0, 4);

  const recentWrap = $('persona-flows-recent-wrap');
  const recentGrid = $('persona-flows-recent');
  const allGrid = $('persona-flows-all');
  if (recents.length && !q) {
    recentGrid.innerHTML = recents.map(f => renderPersonaFlowCard(f)).join('');
    recentWrap.style.display = '';
  } else {
    recentWrap.style.display = 'none';
  }

  if (!filtered.length) {
    allGrid.innerHTML = `<div style="color:var(--text-muted);padding:20px;grid-column:1/-1;text-align:center">${q ? 'Nenhum fluxo encontrado.' : 'Nenhum fluxo disponível neste contexto.'}</div>`;
  } else {
    allGrid.innerHTML = filtered.map(f => renderPersonaFlowCard(f)).join('');
  }
  paintIcons();
}

function renderPersonaFlowCard(f) {
  const isSel = _personaState.flowId === f.id;
  // Suporta ícones lucide, uploads e fallback workflow
  let iconHtml;
  if (!f.icon) {
    iconHtml = `<div class="wizard-card-avatar wizard-card-avatar--icon"><i data-lucide="workflow" class="ic-md"></i></div>`;
  } else if (typeof f.icon === 'string' && f.icon.startsWith('lucide:')) {
    iconHtml = `<div class="wizard-card-avatar wizard-card-avatar--icon"><i data-lucide="${esc(f.icon.slice(7))}" class="ic-md"></i></div>`;
  } else {
    iconHtml = `<div class="wizard-card-avatar" style="background-image:url('${f.icon}');background-size:cover;background-position:center"></div>`;
  }
  return `<div class="wizard-card ${isSel ? 'is-selected' : ''}" onclick="personaPickFlow('${f.id}')" ondblclick="personaPickFlow('${f.id}');personaGoTo(2)">
    ${iconHtml}
    <div class="wizard-card-name">${esc(f.name)}</div>
  </div>`;
}

function personaPickFlow(fid) {
  _personaState.flowId = fid;
  // Re-render pra atualizar seleção visual
  document.querySelectorAll('#persona-flows-recent .wizard-card, #persona-flows-all .wizard-card').forEach(el => el.classList.remove('is-selected'));
  document.querySelectorAll(`#persona-step-1 [onclick*="personaPickFlow('${fid}')"]`).forEach(el => el.classList.add('is-selected'));
  updatePersonaNextBtn();
  // Atualiza pill (feedback visual imediato)
  const pill = $('persona-flow-pill');
  const f = flowById(fid);
  pill.textContent = (f?.name || 'FLUXO').toUpperCase();
  pill.style.display = '';
}

/* Checklist inicial editável — array de { text } */
function renderPersonaChecklist() {
  const wrap = $('persona-checklist-list');
  if (!wrap) return;
  wrap.innerHTML = _personaChecklist.map((it, i) => `
    <div class="flow-checklist-item">
      <input class="form-control" value="${esc(it.text)}" placeholder="Item do checklist" oninput="_personaChecklist[${i}].text=this.value">
      <button type="button" class="icon-btn danger" title="Remover" onclick="removePersonaChecklistItem(${i})"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('');
  paintIcons();
}
function addPersonaChecklistItem() {
  _personaChecklist.push({ text: '' });
  renderPersonaChecklist();
  const inputs = $('persona-checklist-list').querySelectorAll('input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removePersonaChecklistItem(i) {
  _personaChecklist.splice(i, 1);
  renderPersonaChecklist();
}

async function savePersonalizada() {
  const name = $('persona-name').value.trim();
  if (!name) return toast('Nome é obrigatório', 'error');
  if (!_personaState.flowId) return toast('Selecione um fluxo', 'error');
  const ctx = _personaState.ctx || {};
  // Ctx precisa de cliente OU projeto OU lista — sem nenhum não dá pra derivar workspace.
  if (!ctx.clientId && !ctx.projectId && !ctx.listaId) {
    return toast('Contexto perdido — reabra o modal', 'error');
  }

  const body = {
    name,
    clientId: ctx.clientId || null,
    projectId: ctx.projectId || null,  // null = Geral (sem projeto específico)
    flowId: _personaState.flowId,
    roleId: null,
    ownerId: $('persona-owner').value || null,
    deliverableUserId: null,
    description: $('persona-desc').value || '',
    briefing: $('persona-briefing').value || '',
    priority: Number($('persona-priority').value) || 3,
    qtyPieces: 0, qtyArts: 0, qtyVariations: 0,
    attachments: _personaAttachments,
    defaultChecklist: _personaChecklist.filter(it => (it.text || '').trim()).map(it => ({ text: it.text.trim() })),
    dayOfMonth: null,
    listaId: ctx.listaId || null,  // vem preenchido quando aberto da aba Listas
    active: true
  };
  try {
    await api('/recurrings', 'POST', body);
    savePersonaRecentFlow(_personaState.flowId);
    closeModal('personalizada-modal');
    toast(ctx.listaId ? 'Demanda adicionada à lista!' : 'Demanda personalizada criada!', 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* Recentes — persiste últimos fluxos escolhidos em localStorage. */
function getPersonaRecentFlowIds() {
  try { return JSON.parse(localStorage.getItem('kastor-persona-recent-flows') || '[]'); }
  catch { return []; }
}
function savePersonaRecentFlow(fid) {
  const list = getPersonaRecentFlowIds().filter(x => x !== fid);
  list.unshift(fid);
  try { localStorage.setItem('kastor-persona-recent-flows', JSON.stringify(list.slice(0, 8))); } catch {}
}

/* ─── Modal Nova Demanda em Lista (aba Listas) ───────────────
   Modal SEPARADO do personalizada — mesma estrutura visual mas save
   escreve como item de TEMPLATE (listaId = template, projectId/clientId
   herdados do template). Instâncias aplicadas NÃO são afetadas. */
const _ndlState = { step: 1, flowId: null, listaId: null, lista: null };
let _ndlAttachments = [];
let _ndlChecklist = [];

function openNovaDemandaListaModal(listaId) {
  const lista = listas.find(l => l.id === listaId);
  if (!lista) return toast('Lista não encontrada', 'error');
  _ndlState.step = 1;
  _ndlState.flowId = null;
  _ndlState.listaId = listaId;
  _ndlState.lista = lista;
  _ndlAttachments = [];
  _ndlChecklist = [];
  demandAttachments = _ndlAttachments;
  // Reset campos
  $('ndl-name').value = '';
  $('ndl-desc').value = '';
  $('ndl-briefing').value = '';
  $('ndl-priority').value = '3';
  $('ndl-flow-search').value = '';
  $('ndl-subtitle').textContent = lista.name;
  refreshFormAttList('ndl-attachments-list');
  renderNdlChecklist();
  // Responsável
  const wsUsersList = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('ndl-owner').innerHTML = '<option value="">— Sem responsável fixo —</option>' +
    wsUsersList.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  renderNdlFlows();
  ndlGoTo(1);
  openModal('nova-demanda-lista-modal');
  setTimeout(() => setupDragDrop('#nova-demanda-lista-modal .modal-content', 'ndl-attachments-list', processDroppedFiles), 60);
}

function ndlGoTo(step) {
  _ndlState.step = step;
  $('ndl-step-1').style.display = step === 1 ? '' : 'none';
  $('ndl-step-2').style.display = step === 2 ? '' : 'none';
  $('ndl-back-btn').style.display = step === 2 ? '' : 'none';
  $('ndl-next-btn').style.display = step === 1 ? '' : 'none';
  $('ndl-create-btn').style.display = step === 2 ? '' : 'none';
  const pill = $('ndl-flow-pill');
  if (_ndlState.flowId) {
    const f = flowById(_ndlState.flowId);
    pill.textContent = (f?.name || 'FLUXO').toUpperCase();
    pill.style.display = '';
  } else {
    pill.style.display = 'none';
  }
  $('ndl-next-btn').disabled = !_ndlState.flowId;
  if (step === 2) setTimeout(() => $('ndl-name').focus(), 60);
  paintIcons();
}

function renderNdlFlows() {
  const q = norm($('ndl-flow-search').value || '');
  const lista = _ndlState.lista;
  // Escopo: se lista tem projeto → flowsForProject; senão cliente → do cliente; senão workspace inteiro
  let available;
  if (lista?.projectId) available = flowsForProject(lista.projectId);
  else if (lista?.clientId) {
    const c = clientById(lista.clientId);
    available = flows.filter(f => f.workspaceId === activeWs && (
      f.clientId === lista.clientId ||
      (c && (f.client || '').toLowerCase() === (c.name || '').toLowerCase()) ||
      (!f.clientId && !f.client)
    ));
  } else available = wsFlows(); // lista Geral → todos os fluxos do workspace
  available = available.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const filtered = available.filter(f => !q || norm(f.name).includes(q));
  const recentIds = getPersonaRecentFlowIds();
  const recents = recentIds.map(id => filtered.find(f => f.id === id)).filter(Boolean).slice(0, 4);
  const recentWrap = $('ndl-flows-recent-wrap');
  const recentGrid = $('ndl-flows-recent');
  const allGrid = $('ndl-flows-all');
  if (recents.length && !q) {
    recentGrid.innerHTML = recents.map(renderNdlFlowCard).join('');
    recentWrap.style.display = '';
  } else recentWrap.style.display = 'none';
  allGrid.innerHTML = filtered.length
    ? filtered.map(renderNdlFlowCard).join('')
    : `<div style="color:var(--text-muted);padding:20px;grid-column:1/-1;text-align:center">${q ? 'Nenhum fluxo encontrado.' : 'Nenhum fluxo disponível.'}</div>`;
  paintIcons();
}

function renderNdlFlowCard(f) {
  const isSel = _ndlState.flowId === f.id;
  let iconHtml;
  if (!f.icon) iconHtml = `<div class="wizard-card-avatar wizard-card-avatar--icon"><i data-lucide="workflow" class="ic-md"></i></div>`;
  else if (typeof f.icon === 'string' && f.icon.startsWith('lucide:'))
    iconHtml = `<div class="wizard-card-avatar wizard-card-avatar--icon"><i data-lucide="${esc(f.icon.slice(7))}" class="ic-md"></i></div>`;
  else iconHtml = `<div class="wizard-card-avatar" style="background-image:url('${f.icon}');background-size:cover;background-position:center"></div>`;
  return `<div class="wizard-card ${isSel ? 'is-selected' : ''}" onclick="ndlPickFlow('${f.id}')" ondblclick="ndlPickFlow('${f.id}');ndlGoTo(2)">
    ${iconHtml}<div class="wizard-card-name">${esc(f.name)}</div>
  </div>`;
}

function ndlPickFlow(fid) {
  _ndlState.flowId = fid;
  document.querySelectorAll('#ndl-flows-recent .wizard-card, #ndl-flows-all .wizard-card').forEach(el => el.classList.remove('is-selected'));
  document.querySelectorAll(`#ndl-step-1 [onclick*="ndlPickFlow('${fid}')"]`).forEach(el => el.classList.add('is-selected'));
  $('ndl-next-btn').disabled = false;
  const pill = $('ndl-flow-pill');
  const f = flowById(fid);
  pill.textContent = (f?.name || 'FLUXO').toUpperCase();
  pill.style.display = '';
}

function renderNdlChecklist() {
  const wrap = $('ndl-checklist-list');
  if (!wrap) return;
  wrap.innerHTML = _ndlChecklist.map((it, i) => `
    <div class="flow-checklist-item">
      <input class="form-control" value="${esc(it.text)}" placeholder="Item do checklist" oninput="_ndlChecklist[${i}].text=this.value">
      <button type="button" class="icon-btn danger" title="Remover" onclick="removeNdlChecklistItem(${i})"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('');
  paintIcons();
}
function addNdlChecklistItem() {
  _ndlChecklist.push({ text: '' });
  renderNdlChecklist();
  const inputs = $('ndl-checklist-list').querySelectorAll('input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeNdlChecklistItem(i) {
  _ndlChecklist.splice(i, 1);
  renderNdlChecklist();
}

async function saveNovaDemandaLista() {
  const name = $('ndl-name').value.trim();
  if (!name) return toast('Nome é obrigatório', 'error');
  if (!_ndlState.flowId) return toast('Selecione um fluxo', 'error');
  const lista = _ndlState.lista;
  if (!lista) return toast('Contexto perdido — reabra o modal', 'error');

  // Item de TEMPLATE: clientId/projectId herdam da lista (podem ser null pra Geral)
  const body = {
    name,
    clientId: lista.clientId || null,
    projectId: lista.projectId || null,
    flowId: _ndlState.flowId,
    roleId: null,
    ownerId: $('ndl-owner').value || null,
    deliverableUserId: null,
    description: $('ndl-desc').value || '',
    briefing: $('ndl-briefing').value || '',
    priority: Number($('ndl-priority').value) || 3,
    qtyPieces: 0, qtyArts: 0, qtyVariations: 0,
    attachments: _ndlAttachments,
    defaultChecklist: _ndlChecklist.filter(it => (it.text || '').trim()).map(it => ({ text: it.text.trim() })),
    dayOfMonth: null,
    listaId: lista.id,  // aponta pro TEMPLATE
    active: true
  };
  try {
    await api('/recurrings', 'POST', body);
    savePersonaRecentFlow(_ndlState.flowId);
    closeModal('nova-demanda-lista-modal');
    toast('Demanda adicionada à lista!', 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── Modal Editar Demanda de Lista APLICADA (aba Demandas) ───
   Modal simplificado: só nome, descrição, briefing, anexos, checklist, prioridade.
   Cliente/Projeto/Fluxo/Função/Responsável/Dia ficam bloqueados (herdados
   do contexto de aplicação). Editar uma demanda de lista aplicada NÃO afeta
   nenhuma outra instância nem o template original. */
let _edaEditingId = null;
let _edaAttachments = [];
let _edaChecklist = [];

/* Roteador: decide qual modal de edição abrir baseado no contexto da demanda.
   Demanda em QUALQUER lista (template OU aplicada) → modal simplificado
   (cliente/projeto/fluxo/função/responsável/dia são atributos da lista, não da demanda).
   Demandas standalone (personalizadas ou soltas) → modal completo. */
function editRecurringSmart(id) {
  const r = recurrings.find(x => x.id === id);
  if (!r) return openRecurringModal(id);
  if (r.listaId) openEditarDemandaAplicadaModal(id);
  else openRecurringModal(id);
}

function openEditarDemandaAplicadaModal(id) {
  const r = recurrings.find(x => x.id === id);
  if (!r) return toast('Demanda não encontrada', 'error');
  _edaEditingId = id;
  $('eda-title').textContent = `Editar "${r.name}"`;
  $('eda-name').value = r.name || '';
  $('eda-desc').value = r.description || '';
  $('eda-briefing').value = r.briefing || '';
  $('eda-priority').value = r.priority || 3;
  _edaAttachments = (r.attachments || []).slice();
  demandAttachments = _edaAttachments;
  _edaChecklist = (r.defaultChecklist || []).map(it => ({ text: String(it.text || '') }));
  refreshFormAttList('eda-attachments-list');
  renderEdaChecklist();
  openModal('editar-demanda-aplicada-modal');
  setTimeout(() => $('eda-name').focus(), 60);
}

function renderEdaChecklist() {
  const wrap = $('eda-checklist-list');
  if (!wrap) return;
  wrap.innerHTML = _edaChecklist.map((it, i) => `
    <div class="flow-checklist-item">
      <input class="form-control" value="${esc(it.text)}" placeholder="Item do checklist" oninput="_edaChecklist[${i}].text=this.value">
      <button type="button" class="icon-btn danger" title="Remover" onclick="removeEdaChecklistItem(${i})"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('');
  paintIcons();
}
function addEdaChecklistItem() {
  _edaChecklist.push({ text: '' });
  renderEdaChecklist();
  const inputs = $('eda-checklist-list').querySelectorAll('input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeEdaChecklistItem(i) {
  _edaChecklist.splice(i, 1);
  renderEdaChecklist();
}

async function saveEditarDemandaAplicada() {
  if (!_edaEditingId) return;
  const name = $('eda-name').value.trim();
  if (!name) return toast('Nome é obrigatório', 'error');
  // PATCH parcial: só os campos que a UI expõe
  const body = {
    name,
    description: $('eda-desc').value || '',
    briefing: $('eda-briefing').value || '',
    priority: Number($('eda-priority').value) || 3,
    attachments: _edaAttachments,
    defaultChecklist: _edaChecklist.filter(it => (it.text || '').trim()).map(it => ({ text: it.text.trim() }))
  };
  try {
    await api('/recurrings/' + _edaEditingId, 'PUT', body);
    closeModal('editar-demanda-aplicada-modal');
    toast('Demanda atualizada!', 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* Toggle active/inactive via PUT — não gera demandas quando inativo. */
async function toggleRecurringActive(id) {
  const r = recurrings.find(x => x.id === id);
  if (!r) return;
  try {
    await api('/recurrings/' + id, 'PUT', { active: !r.active });
    toast(r.active ? 'Recorrente desativada.' : 'Recorrente reativada.', 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* Cria uma Lista com prompt simples. Contexto vem do grupo (cliente + projeto). */
async function promptCreateLista(ctx) {
  const name = window.prompt('Nome da nova lista:', '');
  if (!name || !name.trim()) return;
  try {
    await api('/listas', 'POST', {
      name: name.trim(),
      clientId: ctx.clientId || null,
      projectId: ctx.projectId || null
    });
    toast('Lista criada!', 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── Aba LISTAS — CRUD visual das listas ─────────────────
   Estado (groupby + collapse) separado da aba Demandas.
   Cards mostram: nome + cliente/projeto + ações (editar/duplicar/excluir)
   e lista de itens (recorrentes com listaId matching). */
let _listasGroupBy = localStorage.getItem('kastor-listas-groupby') || 'client';
const _listasCollapsed = new Set(JSON.parse(localStorage.getItem('kastor-listas-collapsed') || '[]'));
function _persistListasCollapsed() {
  try { localStorage.setItem('kastor-listas-collapsed', JSON.stringify([..._listasCollapsed])); } catch {}
}
function toggleListaCard(id) {
  if (_listasCollapsed.has(id)) _listasCollapsed.delete(id);
  else _listasCollapsed.add(id);
  _persistListasCollapsed();
  const el = document.querySelector(`.lista-card[data-lista-id="${CSS.escape(id)}"]`);
  if (el) el.classList.toggle('is-collapsed');
}
function setListasGroupBy(g) {
  _listasGroupBy = g;
  try { localStorage.setItem('kastor-listas-groupby', g); } catch {}
  document.querySelectorAll('[data-listas-groupby]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.listasGroupby === g));
  renderListasContent();
}

function renderListasContent() {
  // Sincroniza estado visual das pills
  document.querySelectorAll('[data-listas-groupby]').forEach(b =>
    b.classList.toggle('is-active', b.dataset.listasGroupby === _listasGroupBy));

  const body = $('listas-content-body');
  const q = norm($('listas-search')?.value || '');
  // Só templates originais aparecem aqui — instâncias aplicadas (sourceListaId) ficam ocultas.
  const wsListas = listas.filter(l => l.workspaceId === activeWs && !l.sourceListaId)
    .filter(l => !q || norm(l.name).includes(q));

  if (!wsListas.length) {
    body.innerHTML = emptyState(
      'Nenhuma lista criada',
      'Crie sua primeira lista pra agrupar demandas recorrentes por tema (ex.: Posts do Mês, Relatórios Trimestrais).',
      'inbox',
      { label: 'Criar primeira lista', onclick: 'openNovaListaModal()', icon: 'plus' }
    );
    paintIcons();
    return;
  }

  // Sort pelo groupby — mantemos flat mas em ordem estável.
  // Cliente → ordena por cliente.name + lista.name.
  // Projeto → ordena por projeto.name (Geral primeiro) + lista.name.
  // Função/Responsável → ordena pelo primeiro item da lista que tem esse campo.
  const withMeta = wsListas.map(l => {
    const client = l.clientId ? clientById(l.clientId) : null;
    const project = l.projectId ? projectById(l.projectId) : null;
    const items = recurrings.filter(r => r.listaId === l.id);
    const roles_ = new Set(items.map(r => r.roleId).filter(Boolean));
    const owners = new Set(items.map(r => r.ownerId).filter(Boolean));
    return { l, client, project, items, roles: roles_, owners };
  });
  withMeta.sort((a, b) => {
    if (_listasGroupBy === 'client') {
      const ca = norm(a.client?.name || 'zzz'), cb = norm(b.client?.name || 'zzz');
      if (ca !== cb) return ca.localeCompare(cb);
    } else if (_listasGroupBy === 'project') {
      // Geral (sem projeto) primeiro
      if (!a.project && b.project) return -1;
      if (a.project && !b.project) return 1;
      const pa = norm(a.project?.name || ''), pb = norm(b.project?.name || '');
      if (pa !== pb) return pa.localeCompare(pb);
    } else if (_listasGroupBy === 'role') {
      const ra = [...a.roles].map(id => norm(roles.find(x => x.id === id)?.name || '')).sort()[0] || 'zzz';
      const rb = [...b.roles].map(id => norm(roles.find(x => x.id === id)?.name || '')).sort()[0] || 'zzz';
      if (ra !== rb) return ra.localeCompare(rb);
    } else if (_listasGroupBy === 'owner') {
      const oa = [...a.owners].map(id => norm(userById(id)?.name || '')).sort()[0] || 'zzz';
      const ob = [...b.owners].map(id => norm(userById(id)?.name || '')).sort()[0] || 'zzz';
      if (oa !== ob) return oa.localeCompare(ob);
    }
    return norm(a.l.name).localeCompare(norm(b.l.name));
  });

  body.innerHTML = withMeta.map(({ l, client, project, items }) => renderListaCard(l, client, project, items)).join('');
  paintIcons();
}

function renderListaCard(lista, client, project, items) {
  const isCollapsed = _listasCollapsed.has(lista.id);
  const contextLabel = project ? project.name : 'Geral';
  const clientLabel = client?.name || '';
  const contextHtml = clientLabel
    ? `<span class="lista-card-context">${esc(clientLabel)}${project ? ` · ${esc(contextLabel)}` : ''}</span>`
    : `<span class="lista-card-context">${esc(contextLabel)}</span>`;

  const itemsHtml = items.length
    ? items.map(r => renderListaItem(r)).join('')
    : '<div class="lista-empty-msg">Nenhuma demanda nessa lista, clique em "Adicionar demanda a lista" para criar a primeira.</div>';

  const addCtx = {
    clientId: lista.clientId || null,
    projectId: lista.projectId || null,
    listaId: lista.id
  };
  const addCtxJson = JSON.stringify(addCtx).replace(/'/g, "&#39;");

  return `<div class="lista-card ${isCollapsed ? 'is-collapsed' : ''}" data-lista-id="${esc(lista.id)}">
    <div class="lista-card-head" onclick="toggleListaCard('${esc(lista.id)}')">
      <i data-lucide="chevron-down" class="ic-sm lista-chevron"></i>
      <div class="lista-card-title">${esc(lista.name)}</div>
      ${contextHtml}
      <div class="lista-card-actions">
        <button class="rec-action-btn" title="Editar lista" onclick="event.stopPropagation();openEditListaModal('${esc(lista.id)}')"><i data-lucide="edit-3" class="ic-sm"></i></button>
        <button class="rec-action-btn" title="Duplicar lista (copia todos os itens)" onclick="event.stopPropagation();duplicateLista('${esc(lista.id)}')"><i data-lucide="copy" class="ic-sm"></i></button>
        <button class="rec-action-btn danger" title="Excluir lista" onclick="event.stopPropagation();confirmDeleteListaFromTab('${esc(lista.id)}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
      </div>
    </div>
    <div class="lista-card-body">
      ${itemsHtml}
      <button type="button" class="lista-add-demand" onclick="openNovaDemandaListaModal('${esc(lista.id)}')">
        <span class="lista-add-demand-icon"><i data-lucide="plus" class="ic-xs"></i></span>
        <span>Adicionar demanda a lista</span>
      </button>
    </div>
  </div>`;
}

function renderListaItem(r) {
  const prio = PRIORITIES.find(x => x.value === Number(r.priority || 3)) || PRIORITIES[2];
  const f = r.flowId ? flowById(r.flowId) : null;
  const role = r.roleId ? roles.find(x => x.id === r.roleId) : null;
  const owner = r.ownerId ? userById(r.ownerId) : null;

  const metaChips = [];
  if (role)  metaChips.push(`<span class="rec-meta-chip"><i data-lucide="user-cog" class="ic-xs"></i>${esc(role.name)}</span>`);
  if (owner) metaChips.push(`<span class="rec-meta-chip"><i data-lucide="user" class="ic-xs"></i>${esc(owner.name)}</span>`);
  if (f)     metaChips.push(`<span class="rec-meta-chip"><i data-lucide="workflow" class="ic-xs"></i>${esc(f.name)}</span>`);

  return `<div class="lista-item">
    <div class="lista-item-body">
      <div class="lista-item-name-row">
        <span class="rec-item-prio-dot" style="background:${prio.color}" title="${esc(prio.label)}"></span>
        <span class="lista-item-name">${esc(r.name)}</span>
      </div>
      ${metaChips.length ? `<div class="lista-item-meta">${metaChips.join('')}</div>` : ''}
    </div>
    <div class="lista-item-actions">
      <button class="rec-action-btn" title="Editar" onclick="event.stopPropagation();editRecurringSmart('${r.id}')"><i data-lucide="edit-3" class="ic-sm"></i></button>
      <button class="rec-action-btn danger" title="Remover da lista" onclick="event.stopPropagation();confirmDeleteRecurring('${r.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
    </div>
  </div>`;
}

/* ─── Modal Nova/Editar Lista ────────────────────────── */
let _editingListaId = null;

function _populateNovaListaSelects(selectedClientId) {
  const wsClientList = clients.filter(c => c.workspaceId === activeWs && c.active !== false)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('nl-client').innerHTML = '<option value="">— Selecione o cliente —</option>' +
    wsClientList.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('nl-client').value = selectedClientId || '';
  onNovaListaClientChange();
}

function openNovaListaModal() {
  _editingListaId = null;
  $('nova-lista-title').textContent = 'Nova lista de demandas';
  $('nl-save-btn').textContent = 'Criar lista';
  $('nl-name').value = '';
  $('nl-desc').value = '';
  _populateNovaListaSelects(null);
  openModal('nova-lista-modal');
  setTimeout(() => $('nl-name').focus(), 60);
}

function openEditListaModal(id) {
  const lista = listas.find(l => l.id === id);
  if (!lista) return toast('Lista não encontrada', 'error');
  _editingListaId = id;
  // Título dinâmico com nome atual da lista entre aspas (como no wireframe)
  $('nova-lista-title').textContent = `Editar "${lista.name || 'Lista'}"`;
  $('nl-save-btn').textContent = 'Salvar alterações';
  $('nl-name').value = lista.name || '';
  $('nl-desc').value = lista.description || '';
  _populateNovaListaSelects(lista.clientId);
  $('nl-project').value = lista.projectId || '';
  openModal('nova-lista-modal');
}

function onNovaListaClientChange() {
  const cid = $('nl-client').value;
  // Sem cliente → mostra TODOS os projetos ativos do workspace (lista geral pode
  // opcionalmente ser fixada a um projeto). Com cliente → só os do cliente.
  const eligibleProjs = projects.filter(p => p.active !== false && p.workspaceId === activeWs)
    .filter(p => !cid || p.clientId === cid)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('nl-project').innerHTML = '<option value="">— Selecione o projeto —</option>' +
    eligibleProjs.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

async function saveNovaLista() {
  const name = $('nl-name').value.trim();
  if (!name) return toast('Nome é obrigatório', 'error');
  // Cliente E projeto TOTALMENTE opcionais. Sem eles vira lista "geral"
  // aplicável a qualquer contexto do workspace.
  const clientId = $('nl-client').value || null;
  const projectId = $('nl-project').value || null;
  const description = $('nl-desc').value || '';
  const body = { name, clientId, projectId, description, workspaceId: activeWs };
  try {
    if (_editingListaId) await api('/listas/' + _editingListaId, 'PUT', body);
    else await api('/listas', 'POST', body);
    closeModal('nova-lista-modal');
    toast(_editingListaId ? 'Lista atualizada!' : 'Lista criada!', 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmDeleteListaFromTab(id) {
  const lista = listas.find(l => l.id === id);
  if (!lista) return;
  const ok = await showConfirm({
    title: `Excluir "${lista.name}"?`,
    message: 'Tem certeza que deseja excluir essa lista?<br>Essa ação não poderá ser desfeita.',
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/listas/' + id, 'DELETE');
    toast('Lista excluída.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── Duplicar Lista ────────────────────────────────────
   Modal abre com campos VAZIOS. Preenchidos = override, vazios = herdam.
   Ao salvar, cria nova lista + clona TODOS os recorrentes apontando pra ela. */
let _duplicatingListaId = null;

function duplicateLista(id) {
  openDuplicarListaModal(id);
}

function openDuplicarListaModal(id) {
  const lista = listas.find(l => l.id === id);
  if (!lista) return toast('Lista não encontrada', 'error');
  _duplicatingListaId = id;
  $('duplicar-lista-title').textContent = `Duplicar "${lista.name}"?`;
  // Fields começam VAZIOS — placeholder mostra o valor original como sugestão.
  $('dl-name').value = '';
  $('dl-name').placeholder = lista.name;
  $('dl-desc').value = '';
  $('dl-desc').placeholder = lista.description || 'Adicione uma descrição';
  // Popula selects com "Manter original" como primeira opção
  const wsClientList = clients.filter(c => c.workspaceId === activeWs && c.active !== false)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const origClient = lista.clientId ? clientById(lista.clientId) : null;
  // "" = manter original; "__none__" = trocar pra Geral (sem cliente); id = trocar pra cliente específico
  $('dl-client').innerHTML = `<option value="">— Manter (${esc(origClient?.name || 'Geral')}) —</option>` +
    `<option value="__none__">Geral (sem cliente)</option>` +
    wsClientList.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('dl-client').value = '';
  onDuplicarListaClientChange(); // popula projetos (herdando cliente original)
  openModal('duplicar-lista-modal');
  setTimeout(() => $('dl-name').focus(), 60);
}

function onDuplicarListaClientChange() {
  const lista = listas.find(l => l.id === _duplicatingListaId);
  const originalClientId = lista?.clientId || null;
  const originalProjectId = lista?.projectId || null;
  const clientVal = $('dl-client').value;
  // Cliente efetivo pra filtrar projetos:
  //   ""         → manter original
  //   "__none__" → Geral (sem cliente) → mostra TODOS os projetos ativos do workspace
  //   id         → filtra pelo cliente escolhido
  const isExplicitGeral = clientVal === '__none__';
  const cid = isExplicitGeral ? null : (clientVal || originalClientId);
  const eligibleProjs = projects.filter(p => p.active !== false && p.workspaceId === activeWs)
    .filter(p => isExplicitGeral || !cid || p.clientId === cid)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const origProject = originalProjectId ? projectById(originalProjectId) : null;
  // "Manter" só é válido se o cliente não mudou (ou se o projeto original ainda pertence ao novo cliente)
  const stillValid = !clientVal || (origProject && origProject.clientId === clientVal);
  const keepLabel = stillValid ? (origProject?.name || 'Geral') : 'Geral';
  $('dl-project').innerHTML = `<option value="">— Manter (${esc(keepLabel)}) —</option>` +
    eligibleProjs.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('dl-project').value = '';
}

async function saveDuplicarLista() {
  if (!_duplicatingListaId) return;
  const orig = listas.find(l => l.id === _duplicatingListaId);
  if (!orig) return toast('Lista original não encontrada', 'error');

  // Campos vazios herdam da original.
  const newName = $('dl-name').value.trim() || orig.name;
  const newDesc = $('dl-desc').value.trim() || orig.description || '';
  const clientOverride = $('dl-client').value;
  const projectOverride = $('dl-project').value;
  // Cliente: "" = manter, "__none__" = Geral (null explícito), id = novo cliente
  let newClientId;
  if (clientOverride === '__none__') newClientId = null;
  else if (clientOverride) newClientId = clientOverride;
  else newClientId = orig.clientId || null;
  // Projeto: se cliente mudou e projeto original não pertence ao novo cliente, cai pra null
  let newProjectId;
  if (projectOverride) newProjectId = projectOverride;
  else if (clientOverride && orig.projectId) {
    // Cliente foi trocado explicitamente (pra outro ou pra Geral) — valida projeto original
    const origProj = projectById(orig.projectId);
    newProjectId = (origProj && origProj.clientId === newClientId) ? orig.projectId : null;
  } else {
    newProjectId = orig.projectId || null;
  }

  try {
    const newLista = await api('/listas', 'POST', {
      name: newName,
      clientId: newClientId,
      projectId: newProjectId,
      description: newDesc,
      workspaceId: activeWs
    });
    // Clona cada recorrente pra nova lista (herda cliente/projeto da nova lista)
    const items = recurrings.filter(r => r.listaId === orig.id);
    for (const r of items) {
      await api('/recurrings', 'POST', {
        name: r.name,
        clientId: newClientId || r.clientId,
        projectId: newProjectId || r.projectId,
        flowId: r.flowId,
        roleId: r.roleId,
        ownerId: r.ownerId,
        deliverableUserId: r.deliverableUserId,
        description: r.description,
        briefing: r.briefing,
        priority: r.priority,
        qtyPieces: r.qtyPieces, qtyArts: r.qtyArts, qtyVariations: r.qtyVariations,
        defaultChecklist: r.defaultChecklist,
        dayOfMonth: r.dayOfMonth,
        listaId: newLista.id,
        active: r.active
      });
    }
    closeModal('duplicar-lista-modal');
    toast(`Lista duplicada${items.length ? ` com ${items.length} item${items.length === 1 ? '' : 's'}` : ''}!`, 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

// Abre modal já com um campo pré-preenchido (vindo do contexto do grupo)
// Guarda o listaId corrente do modal (mesmo motivo do editingRecurringId — fora do DOM).
let _recModalListaId = null;

function openRecurringModalPrefilled(ctx) {
  openRecurringModal(null);
  setTimeout(() => {
    try {
      if (ctx && typeof ctx === 'object') {
        if (ctx.clientId)  { $('rec-client').value = ctx.clientId; onRecurringClientChange(); }
        if (ctx.projectId) {
          // Se vier projeto, descobre o cliente dele e seleciona ambos
          const p = projectById(ctx.projectId);
          if (p && p.clientId) { $('rec-client').value = p.clientId; onRecurringClientChange(); }
          $('rec-project').value = ctx.projectId;
          onRecurringProjectChange();
        }
        if (ctx.roleId)    $('rec-role').value = ctx.roleId;
        if (ctx.ownerId)   $('rec-owner').value = ctx.ownerId;
        if (ctx.listaId !== undefined) _recModalListaId = ctx.listaId || null;
      }
    } catch {}
  }, 80);
}

function openRecurringModal(id) {
  editingRecurringId = id || null;
  $('recurring-modal-title').textContent = id ? 'Editar Recorrente' : 'Nova Recorrente';
  $('rec-delete-btn').style.display = id ? '' : 'none';

  // Se a demanda está numa lista APLICADA (instância, não template),
  // esconde campos estruturais — eles vêm herdados do contexto de aplicação.
  const editedRec = id ? recurrings.find(x => x.id === id) : null;
  const listaOfDemand = editedRec?.listaId ? listas.find(l => l.id === editedRec.listaId) : null;
  const isInAppliedList = !!(listaOfDemand && listaOfDemand.sourceListaId);
  document.querySelectorAll('#recurring-modal .rec-structural-field').forEach(el => {
    el.style.display = isInAppliedList ? 'none' : '';
  });

  // Popula selects base (cliente/projeto/fluxo/função/responsável)
  const wsClientList = clients.filter(c => c.workspaceId === activeWs && c.active !== false)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('rec-client').innerHTML = '<option value="">— Selecione —</option>' +
    wsClientList.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  // Function options já vêm fixas no HTML como "Sem função"; preenche roles
  $('rec-role').innerHTML = '<option value="">— Sem função —</option>' +
    roles.slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)))
      .map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  // Responsável: usuários do workspace
  const wsUsersList = wsUsers().slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('rec-owner').innerHTML = '<option value="">— Sem responsável fixo —</option>' +
    wsUsersList.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('rec-deliverable-user').innerHTML = '<option value="">— Responsável atual —</option>' +
    wsUsersList.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');

  if (id) {
    const r = recurrings.find(x => x.id === id);
    if (!r) return toast('Recorrente não encontrado', 'error');
    $('rec-name').value = r.name || '';
    $('rec-client').value = r.clientId || '';
    onRecurringClientChange(); // popula projetos
    $('rec-project').value = r.projectId || '';
    onRecurringProjectChange(); // popula fluxos
    $('rec-flow').value = r.flowId || '';
    $('rec-role').value = r.roleId || '';
    $('rec-owner').value = r.ownerId || '';
    $('rec-dom').value = r.dayOfMonth || '';
    $('rec-desc').value = r.description || '';
    $('rec-briefing').value = r.briefing || '';
    $('rec-qty-pieces').value = r.qtyPieces || '';
    $('rec-qty-arts').value = r.qtyArts || '';
    $('rec-qty-variations').value = r.qtyVariations || '';
    $('rec-deliverable-user').value = r.deliverableUserId || '';
    $('rec-priority').value = r.priority || 3;
    $('rec-active').checked = r.active !== false;
    _recModalListaId = r.listaId || null;
    recurringChecklistDraft = (r.defaultChecklist || []).map(it => ({ text: String(it.text || '') }));
  } else {
    // Reset pra criação
    $('rec-name').value = '';
    $('rec-client').value = '';
    onRecurringClientChange();
    $('rec-flow').innerHTML = '<option value="">— Selecione um projeto primeiro —</option>';
    $('rec-role').value = '';
    $('rec-owner').value = '';
    $('rec-dom').value = '';
    $('rec-desc').value = '';
    $('rec-briefing').value = '';
    $('rec-qty-pieces').value = '';
    $('rec-qty-arts').value = '';
    $('rec-qty-variations').value = '';
    $('rec-deliverable-user').value = '';
    $('rec-priority').value = '3';
    $('rec-active').checked = true;
    _recModalListaId = null;
    recurringChecklistDraft = [];
  }
  renderRecurringChecklist();
  openModal('recurring-modal');
  navPush(id ? '/recurring/' + id : '/recurring/new');
  setTimeout(() => $('rec-name').focus(), 60);
}

function onRecurringClientChange() {
  const cid = $('rec-client').value;
  const wsProjs = projects.filter(p => p.workspaceId === activeWs && p.active !== false)
    .filter(p => !cid || p.clientId === cid)
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('rec-project').innerHTML = '<option value="">— Selecione um projeto —</option>' +
    wsProjs.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('rec-flow').innerHTML = '<option value="">— Selecione um projeto primeiro —</option>';
}
function onRecurringProjectChange() {
  const pid = $('rec-project').value;
  if (!pid) { $('rec-flow').innerHTML = '<option value="">— Selecione um projeto primeiro —</option>'; return; }
  const fl = flowsForProject(pid).slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  $('rec-flow').innerHTML = fl.length
    ? fl.map(f => `<option value="${f.id}">${esc(f.name)}${f.demandType ? ' · ' + esc(f.demandType) : ''}</option>`).join('')
    : '<option value="">— Nenhum fluxo disponível —</option>';
}

function renderRecurringChecklist() {
  const wrap = $('rec-checklist-list');
  if (!wrap) return;
  wrap.innerHTML = recurringChecklistDraft.map((it, i) => `
    <div class="flow-checklist-item">
      <input class="form-control" value="${esc(it.text)}" placeholder="Item do checklist" oninput="recurringChecklistDraft[${i}].text=this.value">
      <button type="button" class="icon-btn danger" title="Remover" onclick="removeRecurringChecklistItem(${i})"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('');
  paintIcons();
}
function addRecurringChecklistItem() {
  recurringChecklistDraft.push({ text: '' });
  renderRecurringChecklist();
  const inputs = $('rec-checklist-list').querySelectorAll('input.form-control');
  if (inputs.length) inputs[inputs.length - 1].focus();
}
function removeRecurringChecklistItem(i) {
  recurringChecklistDraft.splice(i, 1);
  renderRecurringChecklist();
}

async function saveRecurring() {
  const name = $('rec-name').value.trim();
  if (!name) return toast('Nome é obrigatório', 'error');
  const projectId = $('rec-project').value;
  if (!projectId) return toast('Selecione um projeto', 'error');
  const flowId = $('rec-flow').value;
  if (!flowId) return toast('Selecione um fluxo', 'error');
  const body = {
    name,
    clientId: $('rec-client').value || null,
    projectId,
    flowId,
    roleId: $('rec-role').value || null,
    ownerId: $('rec-owner').value || null,
    deliverableUserId: $('rec-deliverable-user').value || null,
    description: $('rec-desc').value || '',
    briefing: $('rec-briefing').value || '',
    priority: Number($('rec-priority').value) || 3,
    qtyPieces: Number($('rec-qty-pieces').value) || 0,
    qtyArts: Number($('rec-qty-arts').value) || 0,
    qtyVariations: Number($('rec-qty-variations').value) || 0,
    dayOfMonth: $('rec-dom').value ? Number($('rec-dom').value) : null,
    active: $('rec-active').checked,
    listaId: _recModalListaId,
    defaultChecklist: recurringChecklistDraft.filter(it => (it.text || '').trim()).map(it => ({ text: it.text.trim() }))
  };
  try {
    if (editingRecurringId) await api('/recurrings/' + editingRecurringId, 'PUT', body);
    else await api('/recurrings', 'POST', body);
    closeModal('recurring-modal');
    navPush('/recurring');
    toast(editingRecurringId ? 'Recorrente atualizada!' : 'Recorrente criada!');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteRecurring() {
  if (!editingRecurringId) return;
  const r = recurrings.find(x => x.id === editingRecurringId);
  if (!r) return;
  const ok = await showConfirm({
    title: 'Excluir recorrente',
    message: `Excluir o molde <strong>${esc(r.name)}</strong>?<br><br>As demandas já geradas <strong>não</strong> serão removidas.`,
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/recurrings/' + editingRecurringId, 'DELETE');
    closeModal('recurring-modal');
    navPush('/recurring');
    toast('Recorrente excluída.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function confirmDeleteRecurring(id) {
  const r = recurrings.find(x => x.id === id); if (!r) return;
  const ok = await showConfirm({
    title: `Excluir "${r.name}"?`,
    message: 'Tem certeza que deseja excluir essa demanda?<br>Essa ação não poderá ser desfeita.',
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/recurrings/' + id, 'DELETE');
    toast('Demanda excluída.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── Modal Adicionar Lista ───────────────────────────────
   Aplica um template (lista) num projeto: clona todos os recorrentes
   da lista escolhida com projectId = target. listaId permanece =
   source.id pra manter o agrupamento visual sob o nome da lista.
   Deletar clone não afeta o template — cada recorrente é registro próprio. */
let _adicionarListaCtx = null;
let _selectedListaIdInAdd = null;

function openAdicionarListaModal(ctx) {
  _adicionarListaCtx = ctx || {};
  _selectedListaIdInAdd = null;
  $('al-search').value = '';
  $('al-add-btn').disabled = true;
  filterAdicionarListaOptions();
  openModal('adicionar-lista-modal');
  setTimeout(() => $('al-search').focus(), 60);
}

function filterAdicionarListaOptions() {
  const ctx = _adicionarListaCtx || {};
  const q = norm($('al-search').value);
  // Só templates originais podem ser aplicados — instâncias já aplicadas não aparecem
  const wsListas = listas.filter(l => l.workspaceId === activeWs && !l.sourceListaId);
  // Aplicáveis a este contexto: geral (sem cliente) OU do mesmo cliente
  const applicable = wsListas.filter(l => !l.clientId || l.clientId === ctx.clientId);
  // Filtro por busca de nome
  const filtered = applicable.filter(l => !q || norm(l.name).includes(q))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const container = $('al-options');
  if (!filtered.length) {
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">Nenhuma lista disponível pra este contexto.</div>';
    return;
  }
  container.innerHTML = filtered.map(l => {
    const client = l.clientId ? clientById(l.clientId) : null;
    const project = l.projectId ? projectById(l.projectId) : null;
    const scope = [client?.name || 'Geral', project?.name].filter(Boolean).join(' · ');
    const itemCount = recurrings.filter(r => r.listaId === l.id).length;
    const isSelected = _selectedListaIdInAdd === l.id;
    return `<div class="al-option ${isSelected ? 'is-selected' : ''}" onclick="selectListaInAddModal('${l.id}')">
      <div class="al-option-title">${esc(l.name)}</div>
      <div class="al-option-sub">${esc(scope)} · ${itemCount} demanda${itemCount === 1 ? '' : 's'}</div>
    </div>`;
  }).join('');
  paintIcons();
}

function selectListaInAddModal(id) {
  _selectedListaIdInAdd = id;
  $('al-add-btn').disabled = false;
  document.querySelectorAll('#al-options .al-option').forEach(el =>
    el.classList.toggle('is-selected', el.textContent && el.getAttribute('onclick')?.includes(`'${id}'`)));
  // Re-render pra atualizar seleção visual de forma robusta
  filterAdicionarListaOptions();
}

async function saveAdicionarLista() {
  if (!_selectedListaIdInAdd) return toast('Selecione uma lista', 'error');
  const template = listas.find(l => l.id === _selectedListaIdInAdd);
  if (!template) return toast('Lista não encontrada', 'error');
  const ctx = _adicionarListaCtx || {};
  const items = recurrings.filter(r => r.listaId === template.id);
  if (!items.length) return toast('Essa lista não tem demandas ainda.', 'warn');

  try {
    // 1) Cria a INSTÂNCIA aplicada (nova lista independente, sourceListaId=template)
    //    Snapshot: mudanças futuras no template NÃO afetam essa instância.
    const applied = await api('/listas', 'POST', {
      name: template.name,
      clientId: ctx.clientId || null,
      projectId: ctx.projectId || null,
      description: template.description || '',
      sourceListaId: template.id,
      workspaceId: activeWs
    });

    // 2) Clona cada recorrente do template pra instância aplicada.
    //    listaId aponta pra applied.id (não pro template) — isolando os registros.
    let count = 0, errs = 0;
    for (const r of items) {
      try {
        await api('/recurrings', 'POST', {
          name: r.name,
          clientId: ctx.clientId || null,
          projectId: ctx.projectId || null,
          flowId: r.flowId,
          roleId: r.roleId,
          ownerId: r.ownerId,
          deliverableUserId: r.deliverableUserId,
          description: r.description,
          briefing: r.briefing,
          priority: r.priority,
          qtyPieces: r.qtyPieces, qtyArts: r.qtyArts, qtyVariations: r.qtyVariations,
          defaultChecklist: r.defaultChecklist,
          dayOfMonth: r.dayOfMonth,
          listaId: applied.id,  // aponta pra INSTÂNCIA, não pro template
          active: true
        });
        count++;
      } catch { errs++; }
    }
    closeModal('adicionar-lista-modal');
    toast(`Lista "${template.name}" aplicada com ${count} demanda${count === 1 ? '' : 's'}${errs ? ` (${errs} falha${errs === 1 ? '' : 's'})` : ''}!`, errs ? 'warn' : 'success');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

async function generateRecurring(id) {
  const r = recurrings.find(x => x.id === id);
  if (!r) return;
  // rec-ym (input de mês) foi removido no redesign — usa o mês corrente direto
  const ym = ($('rec-ym')?.value) || currentYm();
  const existing = recurringGenerationFor(r, ym);
  if (existing) {
    const ok = await showConfirm({
      title: 'Regerar demanda do mês',
      message: `Já existe uma demanda gerada em <strong>${ymLabel(ym)}</strong> para "<strong>${esc(r.name)}</strong>".<br><br>A demanda anterior continua existindo. Deseja criar outra?`,
      okLabel: 'Regerar'
    });
    if (!ok) return;
    // Backend só re-gera se a demanda foi excluída — então só prossigo se existing.demandId não existe mais
    if (demandById(existing.demandId)) return toast('Demanda já existe — abra pelo link na tabela.', 'warn');
  }
  try {
    const res = await api('/recurrings/' + id + '/generate', 'POST', { ym });
    toast(res.alreadyGenerated ? 'Demanda já existia.' : 'Demanda gerada!');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

async function generateAllRecurringPending() {
  const ym = $('rec-ym').value || currentYm();
  const fClient = $('rec-f-client').value;
  const fProject = $('rec-f-project').value;
  const fRole = $('rec-f-role').value;
  const fUser = $('rec-f-user').value;
  const pending = recurrings
    .filter(r => r.workspaceId === activeWs && r.active !== false)
    .filter(r => !fClient || r.clientId === fClient)
    .filter(r => !fProject || r.projectId === fProject)
    .filter(r => !fRole || r.roleId === fRole)
    .filter(r => !fUser || r.ownerId === fUser)
    .filter(r => !recurringGenerationFor(r, ym));
  if (!pending.length) return toast('Nenhuma recorrente pendente neste mês.', 'warn');
  const ok = await showConfirm({
    title: 'Gerar todas pendentes',
    message: `Serão geradas <strong>${pending.length}</strong> demanda(s) referentes a <strong>${ymLabel(ym)}</strong>.<br><br>Continuar?`,
    okLabel: 'Gerar todas'
  });
  if (!ok) return;
  let ok_count = 0, errs = 0;
  for (const r of pending) {
    try { await api('/recurrings/' + r.id + '/generate', 'POST', { ym }); ok_count++; }
    catch { errs++; }
  }
  toast(`${ok_count} demanda(s) geradas${errs ? `, ${errs} falha(s)` : ''}.`, errs ? 'warn' : 'success');
  await refreshData();
}

function renderTemplates() {
  const list = templates.filter(t => t.workspaceId === activeWs).slice().sort((a, b) => {
    let va, vb;
    if (tplSortKey === 'project') { va = norm(projectById(a.projectId)?.name || ''); vb = norm(projectById(b.projectId)?.name || ''); }
    else if (tplSortKey === 'flow') { va = norm(flowById(a.flowId)?.name || ''); vb = norm(flowById(b.flowId)?.name || ''); }
    else if (tplSortKey === 'hours') { va = a.estimatedHours || 0; vb = b.estimatedHours || 0; }
    else { va = norm(a.name); vb = norm(b.name); }
    return (va < vb ? -1 : va > vb ? 1 : 0) * tplSortDir;
  });
  $('templates-table-body').innerHTML = list.length ? list.map(t => {
    const p = t.projectId ? projectById(t.projectId) : null;
    const f = t.flowId ? flowById(t.flowId) : null;
    return `<tr class="row-hover-actions">
      <td><strong>${esc(t.name)}</strong>${t.description ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(t.description.slice(0, 80))}${t.description.length > 80 ? '…' : ''}</div>` : ''}</td>
      <td>${p ? esc(p.name) : '<span style="color:var(--text-muted)">— Qualquer —</span>'}</td>
      <td>${f ? esc(f.name) : '<span style="color:var(--text-muted)">— Qualquer —</span>'}</td>
      <td>${t.estimatedHours ? fmtHours(t.estimatedHours) : '—'}</td>
      <td>
        <div class="row-actions">
          <button class="detail-icon-btn" title="Criar demanda a partir deste template" onclick="useTemplate('${t.id}')"><i data-lucide="plus" class="ic-sm"></i></button>
          <button class="detail-icon-btn danger" title="Excluir" onclick="confirmDeleteTemplate('${t.id}')"><i data-lucide="trash-2" class="ic-sm"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="5">${emptyState('Nenhum template cadastrado', 'Crie um template a partir da área de criação de demanda usando o botão "Salvar como template".', 'default')}</td></tr>`;
}
function useTemplate(tid) {
  openNewDemand();
  setTimeout(() => {
    $('f-template').value = tid;
    applyDemandTemplate();
  }, 100);
}
function sortTplBy(key) {
  if (tplSortKey === key) tplSortDir *= -1;
  else { tplSortKey = key; tplSortDir = 1; }
  renderTemplates();
}
async function confirmDeleteTemplate(id) {
  const t = templates.find(x => x.id === id); if (!t) return;
  const ok = await showConfirm({
    title: 'Excluir template',
    message: `Excluir o template <strong>${esc(t.name)}</strong>?<br><br>Esta ação não pode ser desfeita.`,
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/templates/' + id, 'DELETE');
    toast('Template excluído.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

async function saveRole() {
  const name = $('role-name').value.trim();
  if (!name) { toast('Informe o nome da função.', 'error'); return; }
  try {
    if (editingRoleId) await api('/roles/' + editingRoleId, 'PUT', { name });
    else await api('/roles', 'POST', { name });
    closeModal('role-modal');
    toast(editingRoleId ? 'Função atualizada!' : 'Função criada!');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteRole(id) {
  const r = roles.find(x => x.id === id);
  if (!r) return;
  const ok = await showConfirm({
    title: 'Excluir função',
    message: `Excluir a função <strong>${esc(r.name)}</strong>?<br><br>Os usuários que a possuem ficarão sem função definida.`,
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/roles/' + id, 'DELETE');
    toast('Função excluída.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
function openUserModal(id) {
  editingUserId = id || null;
  $('user-modal-title').textContent = id ? 'Editar Usuário' : 'Cadastrar Usuário';
  const u = id ? userById(id) : null;
  $('u-name').value = u?.name || '';
  fillRoleSelect('u-role', u?.role || '');
  $('u-username').value = u?.username || '';
  $('u-username').disabled = !!id;
  $('u-username-group').style.opacity = id ? .55 : 1;
  $('u-password').value = '';
  $('u-password-label').textContent = id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial *';
  $('u-email').value = u?.email || '';
  $('u-discord-id').value = u?.discordId || '';
  $('u-admin').checked = !!u?.isAdmin;
  $('u-moderator').checked = !!u?.isModerator;
  onUserAdminChange(); // atualiza estado do checkbox Moderador (esconde se admin)
  const selected = u ? (u.workspaces || []) : [activeWs];
  $('u-workspaces').innerHTML = [...workspaces]
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR', { sensitivity: 'base' }))
    .map(w => `
    <label class="ws-chip-check ${selected.includes(w.id) ? 'on' : ''}">
      <input type="checkbox" value="${w.id}" ${selected.includes(w.id) ? 'checked' : ''}
             onchange="this.parentElement.classList.toggle('on', this.checked)">
      <span class="pill-dot" style="background:${w.color || '#7A00FF'}"></span>${esc(w.name)}
    </label>`).join('');
  openModal('user-modal');
  navPush(id ? '/users/' + id : '/users/new');
}
/* Admin absorve moderador: se marca admin, força moderator = false + esconde. */
function onUserAdminChange() {
  const isAdmin = $('u-admin').checked;
  const modWrap = $('u-moderator-wrap');
  if (modWrap) modWrap.style.display = isAdmin ? 'none' : '';
  if (isAdmin) $('u-moderator').checked = false;
}
async function saveUser() {
  const wsSel = [...$('u-workspaces').querySelectorAll('input:checked')].map(i => i.value);
  const payload = {
    name: $('u-name').value, role: $('u-role').value,
    isAdmin: $('u-admin').checked,
    isModerator: !$('u-admin').checked && $('u-moderator').checked,
    workspaces: wsSel,
    discordId: ($('u-discord-id').value || '').trim() || null,
    email: ($('u-email').value || '').trim() || null
  };
  const pass = $('u-password').value;
  try {
    if (editingUserId) {
      if (pass) payload.password = pass;
      await api('/users/' + editingUserId, 'PUT', payload);
    } else {
      payload.username = $('u-username').value;
      payload.password = pass;
      await api('/users', 'POST', payload);
    }
    closeModal('user-modal');
    toast(editingUserId ? 'Usuário atualizado!' : 'Usuário criado! Envie o acesso para a pessoa.');
    await refreshData();
    if (editingUserId === me.id) { me = await api('/me'); renderSidebarUser(); }
  } catch (e) { toast(e.message, 'error'); }
}
async function resetUserPassword(id) {
  const pass = prompt('Nova senha para ' + (userById(id)?.name || 'o usuário') + ' (mín. 6 caracteres):');
  if (!pass) return;
  try {
    await api('/users/' + id, 'PUT', { password: pass });
    toast('Senha redefinida. Envie a nova senha para a pessoa.');
  } catch (e) { toast(e.message, 'error'); }
}
async function toggleUser(id) {
  const u = userById(id); if (!u) return;
  try {
    await api('/users/' + id, 'PUT', { active: u.active === false });
    toast(u.active === false ? 'Usuário reativado.' : 'Usuário desativado.', 'warn');
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── PERFIL ─── */
function renderProfile() {
  $('profile-name-display').textContent = me.name;
  $('profile-role-display').textContent = me.isAdmin ? (me.role ? me.role + ' · Administrador' : 'Administrador') : (me.role || 'Equipe');
  $('profile-username-display').textContent = '@' + me.username;
  $('profile-f-name').value = me.name;
  $('profile-f-username').value = me.username;
  $('profile-f-discord-id').value = me.discordId || '';
  $('profile-f-email').value = me.email || '';
  const prefs = me.emailPrefs || { assigned: true, stage_assigned: true, mention: true, watch_stage: true, watch_comment: true, daily_digest: true };
  $('profile-pref-assigned').checked = prefs.assigned !== false;
  $('profile-pref-stage_assigned').checked = prefs.stage_assigned !== false;
  $('profile-pref-mention').checked = prefs.mention !== false;
  if ($('profile-pref-watch_stage'))   $('profile-pref-watch_stage').checked = prefs.watch_stage !== false;
  if ($('profile-pref-watch_comment')) $('profile-pref-watch_comment').checked = prefs.watch_comment !== false;
  if ($('profile-pref-daily_digest'))  $('profile-pref-daily_digest').checked = prefs.daily_digest !== false;
  $('profile-email-smtp-warning').style.display = me._smtpEnabled === false ? '' : 'none';
  fillRoleSelect('profile-f-role', me.role || '');
  // Mesma lógica do sidebar: regex aguenta classes extras (presence-online, etc).
  const profAv = $('profile-avatar');
  if (profAv) profAv.outerHTML = avatarHTML(me, 'avatar avatar-lg').replace(/class="([^"]+)"/, 'class="$1" id="profile-avatar"');
  $('avatar-remove-btn').style.display = me.avatar ? '' : 'none';
  // Painel do Google Calendar — carrega estado assíncrono.
  renderGoogleCalendarPanel();
  handleGoogleCallbackToast();
}

// Mostra toast quando a URL vem de ?google=connected|error do callback.
// Limpa a query pra não re-disparar em navegações subsequentes.
async function handleGoogleCallbackToast() {
  const u = new URL(location.href);
  const gcal = u.searchParams.get('google');
  if (!gcal) return;
  if (gcal === 'connected') {
    toast('Google Calendar conectado com sucesso!');
    // Atualiza me com o novo googleConnected pra render da agenda funcionar
    // sem F5. api('/me') retorna publicUser() com o flag já atualizado.
    try { me = await api('/me'); } catch {}
  } else if (gcal === 'error') {
    const reason = u.searchParams.get('reason') || 'desconhecido';
    toast('Falha ao conectar Google Calendar: ' + reason, 'error');
  }
  u.searchParams.delete('google');
  u.searchParams.delete('reason');
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
}

async function renderGoogleCalendarPanel() {
  const body = $('profile-google-body');
  if (!body) return;
  let status;
  try {
    status = await api('/google/status');
  } catch (e) {
    body.innerHTML = `<div class="webhook-hint" style="color:var(--danger)">Erro ao consultar status: ${esc(e.message)}</div>`;
    return;
  }
  if (!status.configured) {
    body.innerHTML = `
      <div class="webhook-hint" style="border-left:3px solid var(--warn);color:var(--warn)">
        ⚠️ Integração não configurada no servidor. O administrador precisa definir
        <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e <code>GOOGLE_REDIRECT_URI</code>
        no arquivo <code>.env</code> antes de conectar.
      </div>`;
    return;
  }
  if (!status.connected) {
    body.innerHTML = `
      <div class="webhook-hint" style="margin-bottom:14px">
        Conecte a sua conta do Google para que os eventos da sua agenda apareçam junto com os blocos da plataforma.
        Nenhuma informação é enviada de volta pro Google — a integração é somente leitura.
      </div>
      <div style="text-align:right">
        <a class="btn btn-primary" href="/api/google/auth">
          <i data-lucide="calendar-plus" class="ic-sm"></i> Conectar Google Calendar
        </a>
      </div>`;
    paintIcons();
    return;
  }
  // Conectado — mostra conta + lista de calendários com checkboxes
  const acc = status.account || {};
  const cals = status.calendars || [];
  const avatarBlock = acc.picture
    ? `<img src="${esc(acc.picture)}" alt="" class="google-account-avatar">`
    : `<div class="google-account-avatar google-account-avatar--fallback">${esc((acc.name || acc.email || 'G').charAt(0).toUpperCase())}</div>`;
  const calsHtml = cals.length
    ? cals.map(c => `
      <label class="google-cal-row">
        <input type="checkbox" data-cal-id="${esc(c.id)}" ${c.selected ? 'checked' : ''} onchange="saveGoogleCalendarSelection()">
        <span class="google-cal-swatch" style="background:${esc(c.backgroundColor || '#4285F4')}"></span>
        <span class="google-cal-name">${esc(c.summary)}${c.primary ? ' <span class="google-cal-primary-tag">principal</span>' : ''}</span>
      </label>`).join('')
    : `<div class="webhook-hint">Nenhum calendário disponível.</div>`;
  const lastSync = status.lastSyncAt
    ? `Última sincronização: ${formatRelativeTime(status.lastSyncAt)}`
    : 'Ainda não sincronizado';
  body.innerHTML = `
    <div class="google-account">
      ${avatarBlock}
      <div class="google-account-info">
        <div class="google-account-name">${esc(acc.name || 'Conta Google')}</div>
        <div class="google-account-email">${esc(acc.email || '')}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="disconnectGoogleCalendar()">
        <i data-lucide="unlink" class="ic-sm"></i> Desconectar
      </button>
    </div>
    <div class="google-cals-label">Calendários a sincronizar</div>
    <div class="google-cals-list">${calsHtml}</div>
    <div class="google-sync-row">
      <div class="google-sync-info">${esc(lastSync)}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="refreshGoogleCalendars()">
          <i data-lucide="refresh-cw" class="ic-sm"></i> Atualizar lista
        </button>
        <button class="btn btn-primary btn-sm" onclick="syncGoogleNow(false)">
          <i data-lucide="cloud-download" class="ic-sm"></i> Sincronizar agora
        </button>
      </div>
    </div>
  `;
  paintIcons();
  // Se conectou mas nunca sincronizou, dispara auto-sync uma vez.
  if (!status.lastSyncAt && cals.some(c => c.selected)) {
    setTimeout(() => syncGoogleNow(true), 400);
  }
}

// Formata tempo relativo curto (5 min atrás, 2h atrás, ontem).
function formatRelativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'agora mesmo';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' min atrás';
  if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' h atrás';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

async function saveGoogleCalendarSelection() {
  const checks = document.querySelectorAll('#profile-google-body input[data-cal-id]');
  const selections = {};
  checks.forEach(c => { selections[c.dataset.calId] = c.checked; });
  try {
    await api('/google/calendars', 'PUT', { selections });
    toast('Seleção salva.');
    // Sync depois de salvar — usuário quer ver os eventos dos calendários novos.
    syncGoogleNow(true);
  } catch (e) { toast(e.message, 'error'); }
}

// Sync manual (botão) ou silencioso (auto-trigger).
// `silent=true` suprime o toast de sucesso pra não interromper.
// Guard `_gcalSyncInFlight` evita double-click disparar dois syncs simultâneos —
// o backend não é reentrante em relação ao mesmo user (mutação sequencial de tokens).
let _gcalSyncInFlight = false;
async function syncGoogleNow(silent) {
  if (_gcalSyncInFlight) return;
  _gcalSyncInFlight = true;
  try {
    const r = await api('/google/sync', 'POST');
    if (r?.errors?.length) {
      toast('Sync com avisos: ' + r.errors.length + ' calendário(s) com erro', 'warn');
    } else if (!silent) {
      const total = (r?.upserted || 0) + (r?.deleted || 0);
      toast(total ? `Sincronizado: ${r.upserted} novo/atualizado, ${r.deleted} removido` : 'Já estava tudo em dia.');
    }
    // Atualiza cache local (limpa antes pra forçar refetch — evita ver dados stale).
    if (me?.id) {
      delete googleEventsForUser[me.id];
      refreshGoogleEventsForUser(me.id);
    }
    // Re-render do painel pra atualizar "última sync"
    renderGoogleCalendarPanel();
  } catch (e) {
    if (!silent) toast('Erro no sync: ' + e.message, 'error');
  } finally {
    _gcalSyncInFlight = false;
  }
}

async function refreshGoogleCalendars() {
  try {
    await api('/google/refresh-calendars', 'POST');
    toast('Lista de calendários atualizada.');
    renderGoogleCalendarPanel();
  } catch (e) { toast(e.message, 'error'); }
}

async function disconnectGoogleCalendar() {
  if (!confirm('Desconectar Google Calendar? Você precisa autorizar novamente pra voltar a sincronizar.')) return;
  try {
    await api('/google/disconnect', 'POST');
    toast('Google Calendar desconectado.', 'warn');
    // Limpa cache local e re-render se estiver numa view que mostra eventos.
    if (me?.id) delete googleEventsForUser[me.id];
    // Atualiza me.googleConnected pra refletir o novo estado no resto da UI.
    if (me) me.googleConnected = false;
    renderGoogleCalendarPanel();
    if (currentPage === 'agenda' || currentPage === 'mine') renderAgenda();
  } catch (e) { toast(e.message, 'error'); }
}
async function saveEmailSettings() {
  const email = ($('profile-f-email').value || '').trim();
  const emailPrefs = {
    assigned: $('profile-pref-assigned').checked,
    stage_assigned: $('profile-pref-stage_assigned').checked,
    mention: $('profile-pref-mention').checked,
    watch_stage: $('profile-pref-watch_stage')?.checked ?? true,
    watch_comment: $('profile-pref-watch_comment')?.checked ?? true,
    daily_digest: $('profile-pref-daily_digest')?.checked ?? true,
  };
  try {
    me = await api('/me', 'PUT', { email: email || null, emailPrefs });
    toast('Preferências de e-mail salvas!');
    renderProfile();
  } catch (e) { toast(e.message, 'error'); }
}
async function sendEmailTest() {
  const currentEmail = ($('profile-f-email').value || '').trim();
  if (currentEmail && currentEmail !== me.email) {
    // Salva o e-mail antes de testar pra evitar testar contra o e-mail antigo
    try { me = await api('/me', 'PUT', { email: currentEmail }); } catch (e) { toast(e.message, 'error'); return; }
  }
  if (!me.email) { toast('Cadastre um e-mail antes de testar.', 'error'); return; }
  try {
    await api('/me/email/test', 'POST');
    toast('E-mail de teste enviado para ' + me.email);
  } catch (e) { toast(e.message, 'error'); }
}
async function saveProfile() {
  try {
    me = await api('/me', 'PUT', { name: $('profile-f-name').value, role: $('profile-f-role').value, username: $('profile-f-username').value });
    toast('Perfil atualizado!');
    renderSidebarUser(); renderProfile();
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function saveDiscordId() {
  const raw = ($('profile-f-discord-id').value || '').trim();
  try {
    me = await api('/me', 'PUT', { discordId: raw || null });
    toast(raw ? 'ID do Discord vinculado!' : 'ID do Discord removido.');
    renderProfile();
    await refreshData();
  } catch (e) { toast(e.message, 'error'); }
}
async function changePassword() {
  const currentPassword = $('profile-f-pass-current').value;
  const newPassword = $('profile-f-pass-new').value;
  if (!currentPassword || !newPassword) { toast('Preencha a senha atual e a nova senha.', 'error'); return; }
  try {
    me = await api('/me', 'PUT', { currentPassword, newPassword });
    $('profile-f-pass-current').value = ''; $('profile-f-pass-new').value = '';
    toast('Senha alterada com sucesso!');
  } catch (e) { toast(e.message, 'error'); }
}
function handleAvatarUpload(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const img = new Image();
  const reader = new FileReader();
  reader.onload = e => { img.src = e.target.result; };
  img.onload = async () => {
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const min = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, size, size);
    const data = canvas.toDataURL('image/jpeg', 0.85);
    try {
      me = await api('/me', 'PUT', { avatar: data });
      toast('Foto de perfil atualizada!');
      renderSidebarUser(); renderProfile();
    } catch (e2) { toast(e2.message, 'error'); }
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}
async function removeAvatar() {
  try {
    me = await api('/me', 'PUT', { avatar: null });
    toast('Foto removida.', 'warn');
    renderSidebarUser(); renderProfile();
  } catch (e) { toast(e.message, 'error'); }
}

/* ─── NOTIFICAÇÕES ─── */
let _lastNotifUnread = 0;
function renderNotifBadge() {
  const unread = notifications.filter(n => !n.read).length;
  const badge = $('notif-badge');
  const bell = document.querySelector('.notif-bell');
  if (badge) {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = unread > 0 ? '' : 'none';
    badge.classList.toggle('has-unread', unread > 0);
  }
  if (bell) {
    bell.classList.toggle('has-unread', unread > 0);
    // Pulse + pop quando o contador AUMENTA (notificação nova chegou)
    if (unread > _lastNotifUnread && _lastNotifUnread !== 0) {
      bell.classList.remove('pulse');
      void bell.offsetWidth; // força reflow para reaplicar a animação
      bell.classList.add('pulse');
      if (badge) {
        badge.classList.remove('pop');
        void badge.offsetWidth;
        badge.classList.add('pop');
      }
    }
  }
  _lastNotifUnread = unread;
}

function toggleNotifPanel() {
  const panel = $('notif-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) renderNotifList();
}

function notifMessage(n) {
  const from = userById(n.fromUser);
  const fromName = from ? from.name : 'Alguém';
  switch (n.type) {
    case 'assigned':
      return `<strong>${esc(fromName)}</strong> atribuiu a demanda <strong>${esc(n.demandName)}</strong> para você${n.stageName ? ' na etapa ' + esc(n.stageName) : ''}`;
    case 'stage_assigned':
      return `A demanda <strong>${esc(n.demandName)}</strong> avançou para a etapa <strong>${esc(n.stageName || '—')}</strong> e foi atribuída a você`;
    case 'mention':
      return `<strong>${esc(fromName)}</strong> mencionou você em <strong>${esc(n.demandName)}</strong>` +
        (n.commentText ? `<div class="notif-comment">${esc(n.commentText)}</div>` : '');
    default:
      return `Notificação sobre <strong>${esc(n.demandName)}</strong>`;
  }
}

function renderNotifList() {
  const list = notifications.slice(0, 50);
  if (!list.length) {
    $('notif-list').innerHTML = '<div class="notif-empty">Nenhuma notificação por enquanto.</div>';
    return;
  }
  $('notif-list').innerHTML = list.map(n => `
    <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="openNotif('${n.id}', '${n.demandId || ''}')">
      <div class="notif-dot-wrap">${!n.read ? '<span class="notif-dot"></span>' : ''}</div>
      <div class="notif-body">
        <div class="notif-text">${notifMessage(n)}</div>
        <div class="notif-time">${fmtDateTime(n.createdAt)}</div>
      </div>
    </div>`).join('');
}

async function openNotif(notifId, demandId) {
  // marca como lido
  const n = notifications.find(x => x.id === notifId);
  if (n && !n.read) {
    n.read = true;
    api('/notifications/' + notifId + '/read', 'PUT').catch(() => {});
    renderNotifBadge();
  }
  // fecha painel e abre a demanda
  $('notif-panel').classList.remove('open');
  if (demandId && demands.find(d => d.id === demandId)) {
    showDetail(demandId);
  } else if (demandId) {
    // demanda pode estar em outro workspace; recarrega dados
    await refreshData();
    if (demands.find(d => d.id === demandId)) showDetail(demandId);
    else toast('Demanda não encontrada (pode ter sido excluída ou estar em outro workspace).', 'warn');
  }
}

async function markAllRead() {
  try {
    await api('/notifications/read-all', 'PUT');
    notifications.forEach(n => { n.read = true; });
    renderNotifBadge();
    renderNotifList();
  } catch (e) { toast(e.message, 'error'); }
}

// Fecha o painel ao clicar fora
document.addEventListener('click', e => {
  const wrap = document.querySelector('.notif-wrap');
  if (wrap && !wrap.contains(e.target)) {
    $('notif-panel').classList.remove('open');
  }
});

/* ─── BULK ACTIONS — seleção múltipla de demandas na lista ─── */
let selectedDemandIds = new Set();
function onDemandRowClick(ev, id) {
  // Click no checkbox NÃO abre o detalhe (handled por event.stopPropagation no input).
  // Click em qualquer outra parte da row abre normalmente.
  showDetail(id);
}
function toggleDemandSelection(id, checked) {
  if (checked) selectedDemandIds.add(id);
  else selectedDemandIds.delete(id);
  // Atualiza visual da row sem re-render total
  const row = document.querySelector(`.demand-row[data-demand-id="${id}"]`);
  if (row) row.classList.toggle('selected', checked);
  refreshBulkBar();
}
function toggleBulkSelectAll(checked) {
  const rows = document.querySelectorAll('#list-table-body .demand-row');
  rows.forEach(r => {
    const id = r.dataset.demandId;
    if (!id) return;
    if (checked) selectedDemandIds.add(id);
    else selectedDemandIds.delete(id);
    r.classList.toggle('selected', checked);
    const cb = r.querySelector('.bulk-check-row');
    if (cb) cb.checked = checked;
  });
  refreshBulkBar();
}
function clearBulkSelection() {
  selectedDemandIds.clear();
  document.querySelectorAll('.demand-row.selected').forEach(r => r.classList.remove('selected'));
  document.querySelectorAll('.bulk-check-row').forEach(c => c.checked = false);
  const all = $('bulk-check-all'); if (all) all.checked = false;
  refreshBulkBar();
}
function refreshBulkBar() {
  const bar = $('bulk-actions-bar');
  const count = $('bulk-count');
  const checkAll = $('bulk-check-all');
  if (!bar) return;
  const n = selectedDemandIds.size;
  bar.classList.toggle('open', n > 0);
  if (count) count.textContent = `${n} ${n === 1 ? 'selecionada' : 'selecionadas'}`;
  // Sincroniza o "select all" com a seleção atual
  if (checkAll) {
    const rows = document.querySelectorAll('#list-table-body .demand-row');
    const visibleIds = [...rows].map(r => r.dataset.demandId).filter(Boolean);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedDemandIds.has(id));
    checkAll.checked = allSelected;
    checkAll.indeterminate = n > 0 && !allSelected;
  }
}

async function bulkRun(op, data, confirmMsg) {
  const ids = [...selectedDemandIds];
  if (!ids.length) return;
  if (confirmMsg) {
    const ok = await showConfirm({
      title: op === 'delete' ? 'Confirmar exclusão' : 'Confirmar ação',
      message: confirmMsg,
      okLabel: op === 'delete' ? 'Excluir' : 'Aplicar',
      danger: op === 'delete'
    });
    if (!ok) return;
  }
  try {
    const r = await api('/demands/bulk', 'POST', { ids, op, data });
    clearBulkSelection();
    await refreshData();
    const skippedMsg = r.skipped ? ` · ${r.skipped} ignorada${r.skipped === 1 ? '' : 's'}` : '';
    if (op === 'delete' && r.undoable && Array.isArray(r.deletedIds) && r.deletedIds.length) {
      const dIds = r.deletedIds;
      toastWithUndo(
        `${r.updated} demanda${r.updated === 1 ? '' : 's'} excluída${r.updated === 1 ? '' : 's'}${skippedMsg}`,
        () => Promise.all(dIds.map(id => api('/demands/' + id + '/undelete', 'POST').catch(() => {})))
      );
    } else {
      toast(`${r.updated} demanda${r.updated === 1 ? '' : 's'} atualizada${r.updated === 1 ? '' : 's'}${skippedMsg}`);
    }
  } catch (e) {
    toast(e.message || 'Erro ao aplicar ação em lote', 'error');
  }
}
function openBulkOwnerPicker() {
  if (!selectedDemandIds.size) return;
  const opts = [{ value: '', label: '— sem responsável —' }, ...wsUsers().map(u => ({ value: u.id, label: u.name }))];
  showCustomPicker('Alterar responsável', 'Selecione o novo responsável:', opts, (val) => bulkRun('setOwner', { ownerId: val || null }));
}
function openBulkPriorityPicker() {
  if (!selectedDemandIds.size) return;
  const opts = [
    { value: '1', label: 'Crítica' },
    { value: '2', label: 'Alta' },
    { value: '3', label: 'Normal' },
    { value: '4', label: 'Baixa' }
  ];
  showCustomPicker('Alterar prioridade', 'Selecione a nova prioridade:', opts, (val) => bulkRun('setPriority', { priority: Number(val) }));
}
function openBulkStagePicker() {
  if (!selectedDemandIds.size) return;
  // Coleta labels de etapas dos fluxos das demandas selecionadas (intersection)
  const ids = [...selectedDemandIds];
  const flowsOfSel = [...new Set(ids.map(id => demandById(id)?.flowId).filter(Boolean))];
  if (!flowsOfSel.length) { toast('Demandas sem fluxo válido.', 'error'); return; }
  const stagesByFlow = flowsOfSel.map(fid => new Set((flowById(fid)?.stages || []).map(s => s.label)));
  // Interseção: labels presentes em TODOS os fluxos
  const common = [...stagesByFlow[0]].filter(lbl => stagesByFlow.every(s => s.has(lbl)));
  if (!common.length) {
    toast('As demandas selecionadas usam fluxos sem etapas em comum.', 'error');
    return;
  }
  const opts = common.map(lbl => ({ value: lbl, label: lbl }));
  showCustomPicker('Mover para etapa', 'Selecione a etapa alvo:', opts, (val) => bulkRun('setStatus', { stageLabel: val, status: 'by-label' }));
}
function bulkDelete() {
  if (!selectedDemandIds.size) return;
  const n = selectedDemandIds.size;
  bulkRun('delete', null, `Excluir definitivamente ${n} demanda${n === 1 ? '' : 's'}? Esta ação não pode ser desfeita.`);
}
async function openBulkDeadlinePicker() {
  if (!selectedDemandIds.size) return;
  // Usa showPrompt em modo date — retorna ISO YYYY-MM-DD ou vazio pra limpar.
  const val = await showPrompt({
    title: 'Alterar prazo final',
    message: 'Novo prazo final. Deixe vazio pra remover o prazo das selecionadas.',
    type: 'date',
    okLabel: 'Aplicar'
  });
  if (val === null) return; // cancel
  bulkRun('setDeadline', { deadline: val || null });
}
function openBulkProjectPicker() {
  if (!selectedDemandIds.size) return;
  // Só permite mudar entre projetos do MESMO workspace — as demandas
  // selecionadas devem estar todas no mesmo. Se houver mistura, bloqueia.
  const ids = [...selectedDemandIds];
  const wsSet = new Set(ids.map(id => demandById(id)?.workspaceId).filter(Boolean));
  if (wsSet.size !== 1) {
    toast('As demandas selecionadas estão em workspaces diferentes — mude uma de cada vez.', 'error');
    return;
  }
  const wsId = [...wsSet][0];
  const projs = (projects || [])
    .filter(p => p.workspaceId === wsId && p.active !== false)
    .slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  if (!projs.length) { toast('Nenhum projeto disponível no workspace.', 'error'); return; }
  const opts = projs.map(p => ({
    value: p.id,
    label: p.client ? `${p.name} · ${p.client}` : p.name
  }));
  showCustomPicker('Mudar projeto', 'Selecione o novo projeto (mesmo workspace):', opts, (val) => bulkRun('setProject', { projectId: val }));
}

/* Picker dedicado — lista de botões. Reconstrói o conteúdo a cada chamada. */
function showCustomPicker(title, message, options, onPick) {
  let p = document.getElementById('picker-modal');
  if (!p) {
    p = document.createElement('div');
    p.id = 'picker-modal';
    p.className = 'modal-overlay';
    p.innerHTML = `<div class="modal modal-sm">
      <div class="modal-header">
        <div class="modal-title" id="picker-title">Escolher</div>
        <button class="modal-close" onclick="closeModal('picker-modal')"><i data-lucide="x" class="ic-sm"></i></button>
      </div>
      <div class="modal-body">
        <div id="picker-message" style="font-size:13px;color:var(--text-dim);margin-bottom:12px"></div>
        <div class="picker-list" id="picker-list"></div>
      </div>
    </div>`;
    document.body.appendChild(p);
  }
  $('picker-title').textContent = title;
  $('picker-message').textContent = message;
  $('picker-list').innerHTML = options.map(o => `<button type="button" class="picker-item" data-val="${esc(String(o.value))}">${esc(o.label)}</button>`).join('');
  $('picker-list').querySelectorAll('.picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.val;
      closeModal('picker-modal');
      onPick(v);
    });
  });
  openModal('picker-modal');
}

/* ─── MARKDOWN LEVE ───
   Aceita uma string JÁ ESCAPADA (esc() aplicado antes) e processa:
   **bold**, *italic*, `code`, listas com - no início da linha, ## heading
   e quebras de parágrafo (linha vazia). Links já vêm prontos por linkifyEscaped. */
function mdApply(escaped) {
  if (!escaped) return '';
  let s = escaped;
  // Code inline `texto` — capturado antes pra não confundir com asteriscos
  s = s.replace(/`([^`\n]+?)`/g, '<code class="md-code">$1</code>');
  // Bold **texto**
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  // Italic *texto* — depois do bold pra não interferir
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  // Listas: linhas começando com "- " viram <li>; agrupa contíguas em <ul>
  s = s.replace(/(^|\n)((?:- [^\n]+(?:\n|$))+)/g, (_m, pre, block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^- /, '').trim()).map(t => `<li>${t}</li>`).join('');
    return `${pre}<ul class="md-list">${items}</ul>`;
  });
  return s;
}
// Renderiza uma string CRUA (não-escapada) aplicando esc + linkify + markdown.
function mdRender(raw) {
  if (raw == null) return '';
  const escaped = esc(String(raw));
  return mdApply(linkifyEscaped(escaped));
}

/* ─── PRESENÇA — ping a cada minuto + refresh leve da lista de usuários ─── */
let _presencePingTimer = null;
async function pingPresence() {
  try {
    const r = await api('/me/ping', 'POST', {});
    if (r && r.lastSeen && me) me.lastSeen = r.lastSeen;
    // Atualiza lastSeen dos demais usuários — necessário pra dot deles
    try {
      const freshUsers = await api('/users');
      if (Array.isArray(freshUsers)) users = freshUsers;
    } catch {}
  } catch {}
}
function startPresence() {
  if (_presencePingTimer) clearInterval(_presencePingTimer);
  pingPresence();
  _presencePingTimer = setInterval(pingPresence, 60000); // 1 min
}

/* ─── MODO ZEN (FOCAR) ─── */
function isZenMode() { return document.body.classList.contains('zen-mode'); }
function toggleZenMode() {
  const on = !isZenMode();
  document.body.classList.toggle('zen-mode', on);
  localStorage.setItem('kastor-zen', on ? '1' : '0');
  const btn = $('zen-toggle-btn');
  if (btn) {
    btn.setAttribute('title', on ? 'Sair do modo focar (Esc)' : 'Modo focar (esconde sidebar e topbar)');
    btn.innerHTML = on
      ? '<i data-lucide="minimize-2" class="ic-sm"></i>'
      : '<i data-lucide="maximize-2" class="ic-sm"></i>';
    paintIcons();
  }
  // Garante botão flutuante de saída
  let exit = document.getElementById('zen-exit-floating');
  if (on && !exit) {
    exit = document.createElement('button');
    exit.id = 'zen-exit-floating';
    exit.className = 'zen-exit-floating';
    exit.setAttribute('data-tooltip', 'Sair do modo focar (Esc)');
    exit.innerHTML = '<i data-lucide="minimize-2" class="ic-sm"></i>';
    exit.onclick = toggleZenMode;
    document.body.appendChild(exit);
    paintIcons();
  } else if (!on && exit) {
    exit.remove();
  }
}
function applyZenFromStorage() {
  if (localStorage.getItem('kastor-zen') === '1') toggleZenMode();
}

// Ganchos no boot — aplicar zen guardado + iniciar presence depois do me carregar.
// Como boot() já roda no fim do arquivo, expomos via window e chamamos no enterApp.
const _origEnterApp = enterApp;
enterApp = async function patchedEnterApp() {
  await _origEnterApp.apply(this, arguments);
  applyZenFromStorage();
  startPresence();
};

/* Esc também sai do modo zen (além de fechar modal/painel) */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isZenMode()) {
    // Só sai se não há modal/popover aberto que vai capturar Esc primeiro
    const anyModal = document.querySelector('.modal-overlay.open, #cmdk.open, #shortcuts-help.open');
    if (!anyModal) { e.preventDefault(); toggleZenMode(); }
  }
});

/* ─── CLIENTES — Página, detalhe e modais ─── */
let currentClientId = null;
let clientStatusFilter = 'all'; // 'all' | 'active' | 'archived'
let currentClientPeriod = '90';
let editingClientId = null;
let clientAvatarData = null;
let clientModalStatusActive = true;
// Estado da nova view de detalhe de projeto (compartilha o page-clients).
let currentProjectId = null;
let currentProjectPeriod = '90';

function setClientStatusFilter(s) {
  clientStatusFilter = s;
  document.querySelectorAll('.client-status-btn').forEach(b => b.classList.toggle('active', b.dataset.status === s));
  renderClients();
}

function renderClients() {
  // Reseta pra view de grid. currentClientId já é tratado pelo dispatcher
  // em renderCurrent('clients'). hideAllDetailViews cobre TODAS as views
  // alternativas (detalhe, modelos, relatórios) — evita duas views empilhadas
  // depois de navegar de /clients/models pra /clients.
  hideAllDetailViews();
  $('clients-view-grid').style.display = '';

  // Popula select de workspace
  const fwSel = $('client-f-ws');
  if (fwSel) {
    const prev = fwSel.value;
    const accessibleWs = workspaces.filter(w => me.isAdmin || (me.workspaces || []).includes(w.id));
    fwSel.innerHTML = '<option value="">Todos os workspaces</option>' +
      accessibleWs.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
    if ([...fwSel.options].some(o => o.value === prev)) fwSel.value = prev;
    applyFilterDropdown('client-f-ws');
  }

  // Restaura filtros persistidos (search + workspace). Só roda na 1ª pintura
  // após entrar na página — em renders subsequentes, valores atuais prevalecem.
  const wasFirstEnterClients = !_filtersRestored['clients'];
  restoreFilters('clients');
  // Default de primeiro acesso (sem filtro salvo): pré-seleciona o workspace ativo.
  if (fwSel && wasFirstEnterClients && !fwSel.value && activeWs) {
    fwSel.value = activeWs;
    applyFilterDropdown('client-f-ws');
  }

  // Filtra
  const q = norm(($('client-search').value || '').trim());
  const fw = fwSel ? fwSel.value : '';
  let list = clients.filter(c => {
    if (me.isAdmin === false && !(me.workspaces || []).includes(c.workspaceId)) return false;
    if (q && !norm(c.name).includes(q)) return false;
    if (fw && c.workspaceId !== fw) return false;
    if (clientStatusFilter === 'active' && c.active === false) return false;
    if (clientStatusFilter === 'archived' && c.active !== false) return false;
    return true;
  });

  // Sort: ativos primeiro, depois alfabético
  list.sort((a, b) => {
    const aa = a.active !== false, ba = b.active !== false;
    if (aa !== ba) return aa ? -1 : 1;
    return norm(a.name).localeCompare(norm(b.name));
  });

  saveFilters('clients');

  const grid = $('clients-grid');
  if (!list.length) {
    grid.innerHTML = emptyState('Nenhum cliente encontrado', 'Crie seu primeiro cliente clicando em "Novo Cliente".', 'users');
    paintIcons();
    return;
  }

  grid.innerHTML = list.map(c => {
    let avatarHtml;
    if (c.avatar) {
      avatarHtml = `<div class="client-card-avatar" style="background-image:url('${c.avatar}');background-size:cover;background-position:center"></div>`;
    } else {
      const letter = (c.name || 'C').charAt(0).toUpperCase();
      avatarHtml = `<div class="client-card-avatar" style="background:${hexDim(c.color || '#7A00FF')};color:${c.color || '#7A00FF'}">${esc(letter)}</div>`;
    }
    const ws = wsById(c.workspaceId);
    const projCount = projects.filter(p => p.clientId === c.id).length;
    const statusBadge = c.active === false
      ? '<span class="client-card-status client-card-status--archived">Arquivado</span>'
      : '<span class="client-card-status client-card-status--active">Ativo</span>';
    return `<div class="flow-card client-card ${c.active === false ? 'is-archived' : ''}" onclick="openClient('${c.id}')">
      ${avatarHtml}
      <div class="flow-card-name">${esc(c.name)}</div>
      <div class="flow-card-sub">${esc(ws?.name || '—')}</div>
      <div class="flow-card-sub" style="font-size:11px;color:var(--text-muted)">${projCount} projeto${projCount === 1 ? '' : 's'}</div>
      ${statusBadge}
    </div>`;
  }).join('');
  paintIcons();
}

function openClient(id) {
  const c = clientById(id);
  if (!c) { toast('Cliente não encontrado', 'error'); renderClients(); return; }
  currentClientId = id;
  currentProjectId = null;
  showClientDetailView();
  renderClientDetail(id);
  navPush('/clients/' + id);
}
function closeClientDetail() {
  currentClientId = null;
  currentProjectId = null;
  $('clients-view-grid').style.display = '';
  hideAllDetailViews();
  navPush('/clients');
  renderClients();
}
// Helpers de switch de view — só uma view visível por vez.
function hideAllDetailViews() {
  const ids = ['clients-view-detail', 'clients-view-models', 'projects-view-detail', 'client-report-view', 'project-report-view'];
  ids.forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
}
function showClientsModelsView() {
  $('clients-view-grid').style.display = 'none';
  hideAllDetailViews();
  const el = $('clients-view-models'); if (el) el.style.display = '';
  // Se abrir a página sem nada expandido, abre o primeiro modelo — evita
  // impressão de "página vazia" e mostra logo o conteúdo típico.
  if (_modelsExpanded.size === 0) {
    const first = (clientTemplates || [])
      .filter(t => me.isAdmin || (me.workspaces || []).includes(t.workspaceId))
      .sort((a, b) => norm(a.name).localeCompare(norm(b.name)))[0];
    if (first) _modelsExpanded.add(first.id);
  }
  const inp = $('models-search');
  if (inp) inp.value = _modelsSearchQuery || '';
}

/* ─── PÁGINA MODELOS DE CLIENTE ───
   CRUD dos client templates (snapshots reutilizáveis). Adicionar um fluxo novo
   a um modelo propaga o fluxo pros clientes existentes criados a partir dele
   (endpoint /api/client-templates/:id/projects/:pIdx/flows no server).

   Layout: toolbar (voltar + busca + novo modelo) + acordeão de modelos.
   Cada modelo expandido tem 2 subseções: PROJETOS (pill cards) + FLUXOS (cards
   visuais achatados de todos os projetos do modelo). */
let _modelsSearchQuery = '';
const _modelsExpanded = new Set(); // ids de modelos abertos no acordeão

function onModelsSearch(v) {
  _modelsSearchQuery = (v || '').trim().toLowerCase();
  renderClientsModels();
}
function toggleModelExpanded(id) {
  if (_modelsExpanded.has(id)) _modelsExpanded.delete(id);
  else _modelsExpanded.add(id);
  renderClientsModels();
}

function renderClientsModels() {
  const wrap = $('clients-models-list');
  if (!wrap) return;
  const q = _modelsSearchQuery;
  let list = (clientTemplates || [])
    .filter(t => me.isAdmin || (me.workspaces || []).includes(t.workspaceId))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  if (q) {
    list = list.filter(t => {
      if ((t.name || '').toLowerCase().includes(q)) return true;
      const projs = t.projects || [];
      if (projs.some(p => (p.name || '').toLowerCase().includes(q))) return true;
      return projs.some(p => (p.flows || []).some(f =>
        (f.name || '').toLowerCase().includes(q) ||
        (f.demandType || '').toLowerCase().includes(q)
      ));
    });
  }
  if (!list.length) {
    wrap.innerHTML = q
      ? emptyState('Nenhum modelo encontrado', 'Tente refinar a busca ou limpar o filtro.', 'search-x')
      : emptyState('Nenhum modelo criado', 'Clique em "Novo modelo" pra criar um snapshot reutilizável com projetos e fluxos.', 'layers');
    paintIcons();
    return;
  }
  wrap.innerHTML = list.map(t => renderModelCard(t)).join('');
  paintIcons();
}

function renderModelCard(t) {
  const isOpen = _modelsExpanded.has(t.id);
  const derivados = (clients || []).filter(c => c.fromClientTemplateId === t.id).length;
  const projs = t.projects || [];
  const projCount = projs.length;
  const flowCount = projs.reduce((s, p) => s + (p.flows || []).length, 0);
  // Etiqueta do badge principal — "X PROJETOS · Y FLUXOS" em caixa alta compacta.
  const badgeLbl = `${projCount} PROJETO${projCount === 1 ? '' : 'S'} · ${flowCount} FLUXO${flowCount === 1 ? '' : 'S'}`;

  const projectsGrid = projCount
    ? `<div class="model-projects-grid">${projs.map((p, pi) => `
        <div class="model-project-pill" onclick="renameTemplateProject('${t.id}', ${pi})" title="${esc(p.name)}">
          <span class="model-project-pill-name">${esc(p.name)}</span>
          <span class="model-project-pill-actions">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); renameTemplateProject('${t.id}', ${pi})" title="Renomear projeto"><i data-lucide="pencil" class="ic-sm"></i></button>
            <button class="btn btn-ghost btn-sm bulk-danger" onclick="event.stopPropagation(); confirmDeleteTemplateProject('${t.id}', ${pi})" title="Excluir projeto"><i data-lucide="trash-2" class="ic-sm"></i></button>
          </span>
        </div>`).join('')}</div>`
    : '<div class="hours-empty" style="text-align:left;padding:6px 0">Nenhum projeto ainda.</div>';

  // Flatten de todos os fluxos com referência ao projeto original — necessário
  // pra editar/excluir (endpoints exigem pIdx + fIdx).
  const flatFlows = [];
  projs.forEach((p, pi) => (p.flows || []).forEach((f, fi) => flatFlows.push({ f, p, pi, fi })));
  const flowsGrid = flatFlows.length
    ? `<div class="model-flows-grid">${flatFlows.map(({ f, p, pi, fi }) => `
        <div class="model-flow-card" onclick="openTemplateFlowModal('${t.id}', ${pi}, ${fi})" title="Editar fluxo">
          ${projCount > 1 ? `<span class="model-flow-card-proj" title="${esc(p.name)}">${esc(p.name)}</span>` : ''}
          <span class="model-flow-icon" style="background:${modelFlowIconBg(p.color || t.color)}">
            <i data-lucide="workflow"></i>
          </span>
          <span class="model-flow-card-name">${esc(f.name || 'Fluxo sem nome')}</span>
          ${f.demandType ? `<span class="model-flow-card-type">${esc(f.demandType)}</span>` : ''}
          <span class="model-flow-card-actions">
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openTemplateFlowModal('${t.id}', ${pi}, ${fi})" title="Editar fluxo"><i data-lucide="pencil" class="ic-sm"></i></button>
            <button class="btn btn-ghost btn-sm bulk-danger" onclick="event.stopPropagation(); confirmDeleteTemplateFlow('${t.id}', ${pi}, ${fi})" title="Excluir fluxo"><i data-lucide="trash-2" class="ic-sm"></i></button>
          </span>
        </div>`).join('')}</div>`
    : '<div class="hours-empty" style="text-align:left;padding:6px 0">Nenhum fluxo ainda.</div>';

  const projPickerBtn = projCount === 0
    ? `<button class="btn btn-ghost btn-sm" onclick="toast('Adicione um projeto antes de criar um fluxo.', 'warn')" title="Adicione um projeto primeiro"><i data-lucide="plus" class="ic-sm"></i> Novo Fluxo</button>`
    : projCount === 1
      ? `<button class="btn btn-ghost btn-sm" onclick="openTemplateFlowModal('${t.id}', 0, null)"><i data-lucide="plus" class="ic-sm"></i> Novo Fluxo</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="openProjectPicker(event, '${t.id}')"><i data-lucide="plus" class="ic-sm"></i> Novo Fluxo</button>`;

  const body = isOpen ? `
    <div class="model-card-body">
      <div class="model-section">
        <div class="model-section-head">
          <span class="model-section-label">PROJETOS</span>
          <button class="btn btn-ghost btn-sm" onclick="addTemplateProject('${t.id}')"><i data-lucide="folder-plus" class="ic-sm"></i> Novo Projeto</button>
        </div>
        ${projectsGrid}
      </div>
      <div class="model-section">
        <div class="model-section-head">
          <span class="model-section-label">FLUXOS</span>
          ${projPickerBtn}
        </div>
        ${flowsGrid}
      </div>
    </div>` : '';

  const chevronIc = isOpen ? 'chevron-down' : 'chevron-left';
  return `<div class="model-card ${isOpen ? 'is-open' : ''}" data-model-id="${t.id}">
    <div class="model-card-head" onclick="toggleModelExpanded('${t.id}')">
      <span class="model-card-chevron"><i data-lucide="${chevronIc}" class="ic-sm"></i></span>
      <div class="model-card-title">
        <strong>${esc(t.name)}</strong>
        <span class="model-card-badge">${badgeLbl}</span>
        ${derivados > 0 ? `<span class="model-card-badge model-card-badge-derivados">${derivados} CLIENTE${derivados === 1 ? '' : 'S'} VINCULADO${derivados === 1 ? '' : 'S'}</span>` : ''}
      </div>
      <div class="model-card-actions" onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="openModelEditName('${t.id}')" title="Renomear modelo"><i data-lucide="pencil" class="ic-sm"></i></button>
        <button class="btn btn-ghost btn-sm bulk-danger" onclick="confirmDeleteModel('${t.id}')" title="Excluir modelo"><i data-lucide="trash-2" class="ic-sm"></i></button>
      </div>
    </div>
    ${body}
  </div>`;
}

/* Fundo do ícone do card de fluxo — tinta suave da cor do projeto/modelo.
   Aceita hex #RRGGBB; qualquer outra coisa cai no tom padrão da accent. */
function modelFlowIconBg(color) {
  const hex = /^#[0-9a-f]{6}$/i.test(color || '') ? color : null;
  if (!hex) return 'var(--accent-soft)';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.14)`;
}

/* Menu flutuante pra escolher em qual projeto criar o fluxo — só usado quando
   o modelo tem 2+ projetos. Fecha ao clicar fora ou selecionar. */
function openProjectPicker(evt, tplId) {
  evt.stopPropagation();
  document.querySelectorAll('.model-proj-picker').forEach(el => el.remove());
  const t = clientTemplates.find(x => x.id === tplId);
  const projs = t?.projects || [];
  if (!projs.length) return;
  const btn = evt.currentTarget;
  const rect = btn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'model-proj-picker';
  menu.innerHTML = `<div class="model-proj-picker-empty">Adicionar fluxo em…</div>` +
    projs.map((p, pi) => `<button class="model-proj-picker-item" data-pi="${pi}">${esc(p.name)}</button>`).join('');
  menu.style.top = (window.scrollY + rect.bottom + 4) + 'px';
  menu.style.left = (window.scrollX + rect.right - 200) + 'px'; // alinha pela direita do botão
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  menu.querySelectorAll('.model-proj-picker-item').forEach(el => {
    el.addEventListener('click', () => {
      const pi = Number(el.dataset.pi);
      close();
      openTemplateFlowModal(tplId, pi, null);
    });
  });
  // adia o registro do handler de fora pra não capturar o mesmo click que abriu o menu
  setTimeout(() => {
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
}

async function openModelEditName(id) {
  const t = clientTemplates.find(x => x.id === id);
  if (!t) return;
  const newName = await showPrompt({
    title: 'Renomear modelo',
    message: 'Novo nome do modelo:',
    defaultValue: t.name,
    placeholder: 'Ex.: Cliente Padrão de Ads',
    okLabel: 'Salvar'
  });
  if (!newName || !newName.trim() || newName.trim() === t.name) return;
  try {
    const upd = await api('/client-templates/' + id, 'PUT', { name: newName.trim() });
    Object.assign(t, upd);
    renderClientsModels();
    toast('Modelo renomeado.');
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmDeleteModel(id) {
  const t = clientTemplates.find(x => x.id === id);
  if (!t) return;
  const derivados = (clients || []).filter(c => c.fromClientTemplateId === t.id).length;
  const ok = await showConfirm({
    title: 'Excluir modelo?',
    message: `O modelo "${t.name}" será excluído.${derivados > 0 ? ` Os ${derivados} cliente(s) vinculado(s) continuam existindo, mas perdem o vínculo (fluxos novos deixarão de ser replicados neles).` : ''}`,
    okLabel: 'Excluir', danger: true
  });
  if (!ok) return;
  try {
    await api('/client-templates/' + id, 'DELETE');
    clientTemplates = clientTemplates.filter(x => x.id !== id);
    renderClientsModels();
    toast('Modelo excluído.', 'warn');
  } catch (e) { toast(e.message, 'error'); }
}

/* ── CRIAR MODELO DO ZERO ── */
function openNewModelModal() {
  $('nm-name').value = '';
  $('nm-color').value = '#7A00FF';
  const trg = $('nm-color-trigger');
  if (trg) trg.style.background = '#7A00FF';
  const wsSel = $('nm-workspace');
  const accessibleWs = workspaces.filter(w => me.isAdmin || (me.workspaces || []).includes(w.id));
  wsSel.innerHTML = accessibleWs
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR', { sensitivity: 'base' }))
    .map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  if (accessibleWs.some(w => w.id === activeWs)) wsSel.value = activeWs;
  openModal('new-model-modal');
  setTimeout(() => $('nm-name').focus(), 60);
}
async function saveNewModel() {
  const name = $('nm-name').value.trim();
  if (!name) { toast('Informe um nome pro modelo.', 'error'); return; }
  const workspaceId = $('nm-workspace').value;
  const color = $('nm-color').value || '#7A00FF';
  try {
    const tpl = await api('/client-templates', 'POST', { name, workspaceId, color });
    clientTemplates.push(tpl);
    closeModal('new-model-modal');
    renderClientsModels();
    toast('Modelo criado. Adicione projetos e fluxos.');
  } catch (e) { toast(e.message, 'error'); }
}

/* ── PROJETO DO MODELO ── */
async function addTemplateProject(tplId) {
  const t = clientTemplates.find(x => x.id === tplId);
  if (!t) return;
  const name = await showPrompt({
    title: 'Novo projeto no modelo',
    message: 'Nome do projeto (ex.: Social Media, Ads, Blog):',
    placeholder: 'Nome do projeto',
    okLabel: 'Adicionar'
  });
  if (!name || !name.trim()) return;
  try {
    const upd = await api('/client-templates/' + tplId + '/projects', 'POST', { name: name.trim() });
    Object.assign(t, upd);
    renderClientsModels();
    toast('Projeto adicionado ao modelo.');
  } catch (e) { toast(e.message, 'error'); }
}
async function renameTemplateProject(tplId, pIdx) {
  const t = clientTemplates.find(x => x.id === tplId);
  const proj = t?.projects?.[pIdx];
  if (!proj) return;
  const newName = await showPrompt({
    title: 'Renomear projeto',
    message: 'Novo nome do projeto:',
    defaultValue: proj.name,
    placeholder: 'Nome do projeto',
    okLabel: 'Salvar'
  });
  if (!newName || !newName.trim() || newName.trim() === proj.name) return;
  try {
    const upd = await api(`/client-templates/${tplId}/projects/${pIdx}`, 'PUT', { name: newName.trim() });
    Object.assign(t, upd);
    renderClientsModels();
  } catch (e) { toast(e.message, 'error'); }
}
async function confirmDeleteTemplateProject(tplId, pIdx) {
  const t = clientTemplates.find(x => x.id === tplId);
  const proj = t?.projects?.[pIdx];
  if (!proj) return;
  const flowCount = (proj.flows || []).length;
  const ok = await showConfirm({
    title: 'Excluir projeto do modelo?',
    message: `O projeto "${proj.name}"${flowCount ? ` (e ${flowCount} fluxo${flowCount === 1 ? '' : 's'} dentro dele)` : ''} será removido do modelo. Clientes já criados a partir dele NÃO são afetados.`,
    okLabel: 'Excluir', danger: true
  });
  if (!ok) return;
  try {
    const upd = await api(`/client-templates/${tplId}/projects/${pIdx}`, 'DELETE');
    Object.assign(t, upd);
    renderClientsModels();
    toast('Projeto removido do modelo.', 'warn');
  } catch (e) { toast(e.message, 'error'); }
}

/* ── EDITOR COMPLETO DE FLUXO DO MODELO ──
   Um único modal (#template-flow-modal) usado pra criar E editar. Diferença
   é só se fIdx === null (criar → POST) ou é número (editar → PUT). */
let _tflCtx = null; // { tplId, pIdx, fIdx (null se novo), stages: [], checklist: [] }
function openTemplateFlowModal(tplId, pIdx, fIdx) {
  const t = clientTemplates.find(x => x.id === tplId);
  const proj = t?.projects?.[pIdx];
  if (!t || !proj) return;
  const isEdit = fIdx !== null && fIdx !== undefined;
  const flow = isEdit ? proj.flows?.[fIdx] : null;
  if (isEdit && !flow) return;
  _tflCtx = {
    tplId, pIdx, fIdx: isEdit ? fIdx : null,
    // Cópias locais editáveis — só persiste no Save.
    stages: isEdit ? flow.stages.map(s => ({ ...s })) : [
      { label: 'A fazer',      color: '#64748B', done: false, deadlineDays: null, responsibleRole: null },
      { label: 'Em andamento', color: '#38BDF8', done: false, deadlineDays: null, responsibleRole: null },
      { label: 'Concluída',    color: '#22D3A5', done: true,  deadlineDays: null, responsibleRole: null }
    ],
    checklist: isEdit ? [...(flow.defaultChecklist || [])] : []
  };
  $('tfl-title').textContent = isEdit ? `Editar fluxo em "${proj.name}"` : `Novo fluxo em "${proj.name}"`;
  $('tfl-name').value = flow?.name || '';
  $('tfl-type').value = flow?.demandType || '';
  $('tfl-description').value = flow?.defaultDescription || '';
  // datalist com tipos usados em outros fluxos do workspace
  const types = [...new Set(flows.filter(f => f.workspaceId === t.workspaceId).map(f => f.demandType).filter(Boolean))].sort();
  $('tfl-type-datalist').innerHTML = types.map(x => `<option value="${esc(x)}">`).join('');
  $('tfl-delete-btn').style.display = isEdit ? '' : 'none';
  renderTflStages();
  renderTflChecklist();
  openModal('template-flow-modal');
}
function renderTflStages() {
  const wrap = $('tfl-stages-list');
  if (!wrap || !_tflCtx) return;
  const sortedRoles = (roles || []).slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR', { sensitivity: 'base' }));
  wrap.innerHTML = _tflCtx.stages.map((s, i) => {
    // Opções do select de role com selected inline (evita bugs de replace).
    const cur = s.responsibleRole || '';
    const roleOpts = [`<option value="" ${cur === '' ? 'selected' : ''}>— Sem função —</option>`]
      .concat(sortedRoles.map(r => `<option value="${esc(r.name)}" ${cur === r.name ? 'selected' : ''}>${esc(r.name)}</option>`))
      .join('');
    const color = s.color || '#7A00FF';
    return `<div class="tfl-stage-row" data-idx="${i}">
      <button type="button" class="color-swatch-trigger tfl-stage-color" style="background:${esc(color)}" onclick="openColorPicker(this, (c) => { tflSetStage(${i}, 'color', c); this.style.background = c; }, '${esc(color)}')" title="Cor da etapa"></button>
      <input type="text" class="wizard-cust-name" placeholder="Nome da etapa" value="${esc(s.label || '')}" oninput="tflSetStage(${i}, 'label', this.value)">
      <select class="wizard-cust-resp" onchange="tflSetStage(${i}, 'responsibleRole', this.value || null)">${roleOpts}</select>
      <input type="number" class="wizard-cust-days" min="0" step="1" placeholder="—" value="${s.deadlineDays ?? ''}" oninput="tflSetStage(${i}, 'deadlineDays', this.value === '' ? null : Number(this.value))" title="Prazo em dias (opcional)">
      <label class="wizard-cust-toggle" title="Marcar como etapa final (conclui a demanda)">
        <input type="checkbox" ${s.done ? 'checked' : ''} onchange="tflSetStage(${i}, 'done', this.checked)"> <span class="tfl-stage-done-lbl">Final</span>
      </label>
      <button type="button" class="wizard-cust-remove" title="Remover etapa" onclick="tflRemoveStage(${i})"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`;
  }).join('');
  paintIcons();
}
function tflSetStage(idx, field, value) {
  if (!_tflCtx || !_tflCtx.stages[idx]) return;
  _tflCtx.stages[idx][field] = value;
  // Não re-renderiza — os inputs já refletem o próprio valor. Cor é atualizada
  // inline via oninput no elemento (evita perder o foco enquanto edita).
}
function tflAddStage() {
  if (!_tflCtx) return;
  _tflCtx.stages.push({ label: '', color: '#7A00FF', done: false, deadlineDays: null, responsibleRole: null });
  renderTflStages();
}
function tflRemoveStage(idx) {
  if (!_tflCtx) return;
  if (_tflCtx.stages.length <= 2) { toast('O fluxo precisa ter pelo menos 2 etapas.', 'warn'); return; }
  _tflCtx.stages.splice(idx, 1);
  renderTflStages();
}
function renderTflChecklist() {
  const wrap = $('tfl-checklist-list');
  if (!wrap || !_tflCtx) return;
  wrap.innerHTML = _tflCtx.checklist.map((it, i) => `
    <div class="flow-checklist-item">
      <input type="text" class="form-control" placeholder="Ex.: Aprovar copy" value="${esc(it.text || '')}" oninput="tflSetChecklist(${i}, this.value)">
      <button type="button" class="detail-icon-btn danger" onclick="tflRemoveChecklist(${i})" title="Remover"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('');
  paintIcons();
}
function tflSetChecklist(idx, value) {
  if (!_tflCtx || !_tflCtx.checklist[idx]) return;
  _tflCtx.checklist[idx].text = value;
}
function tflAddChecklist() {
  if (!_tflCtx) return;
  _tflCtx.checklist.push({ text: '' });
  renderTflChecklist();
}
function tflRemoveChecklist(idx) {
  if (!_tflCtx) return;
  _tflCtx.checklist.splice(idx, 1);
  renderTflChecklist();
}
async function tflSave() {
  if (!_tflCtx) return;
  const name = $('tfl-name').value.trim();
  if (!name) { toast('Nome do fluxo é obrigatório.', 'error'); return; }
  const validStages = _tflCtx.stages.filter(s => (s.label || '').trim());
  if (validStages.length < 2) { toast('O fluxo precisa de pelo menos 2 etapas com nome.', 'error'); return; }
  const payload = {
    name,
    demandType: $('tfl-type').value.trim(),
    defaultDescription: $('tfl-description').value,
    defaultChecklist: _tflCtx.checklist.filter(it => (it.text || '').trim()),
    stages: validStages.map(s => ({
      label: (s.label || '').trim(),
      color: /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#7A00FF',
      done: !!s.done,
      deadlineDays: Number.isInteger(s.deadlineDays) ? s.deadlineDays : null,
      responsibleRole: s.responsibleRole || null
    }))
  };
  const { tplId, pIdx, fIdx } = _tflCtx;
  const t = clientTemplates.find(x => x.id === tplId);
  try {
    if (fIdx === null) {
      // Criar novo fluxo — endpoint replica em clientes vinculados.
      const r = await api(`/client-templates/${tplId}/projects/${pIdx}/flows`, 'POST', payload);
      Object.assign(t, r.template);
      if (r.replicatedIn > 0) {
        flows = await api('/flows');
        toast(`Fluxo criado e replicado em ${r.replicatedIn} cliente${r.replicatedIn === 1 ? '' : 's'}.`);
      } else {
        toast('Fluxo criado no modelo.');
      }
    } else {
      const upd = await api(`/client-templates/${tplId}/projects/${pIdx}/flows/${fIdx}`, 'PUT', payload);
      Object.assign(t, upd);
      toast('Fluxo atualizado. Clientes existentes NÃO recebem essa alteração — só fluxos novos são replicados.');
    }
    closeModal('template-flow-modal');
    renderClientsModels();
  } catch (e) { toast(e.message, 'error'); }
}
async function tflDelete() {
  if (!_tflCtx || _tflCtx.fIdx === null) return;
  const { tplId, pIdx, fIdx } = _tflCtx;
  const t = clientTemplates.find(x => x.id === tplId);
  const flow = t?.projects?.[pIdx]?.flows?.[fIdx];
  if (!flow) return;
  const ok = await showConfirm({
    title: 'Excluir fluxo do modelo?',
    message: `O fluxo "${flow.name}" será removido do modelo. Clientes já criados a partir dele NÃO são afetados.`,
    okLabel: 'Excluir', danger: true
  });
  if (!ok) return;
  try {
    const upd = await api(`/client-templates/${tplId}/projects/${pIdx}/flows/${fIdx}`, 'DELETE');
    Object.assign(t, upd);
    closeModal('template-flow-modal');
    renderClientsModels();
    toast('Fluxo removido do modelo.', 'warn');
  } catch (e) { toast(e.message, 'error'); }
}
async function confirmDeleteTemplateFlow(tplId, pIdx, fIdx) {
  const t = clientTemplates.find(x => x.id === tplId);
  const flow = t?.projects?.[pIdx]?.flows?.[fIdx];
  if (!flow) return;
  const ok = await showConfirm({
    title: 'Excluir fluxo do modelo?',
    message: `O fluxo "${flow.name}" será removido do modelo. Clientes já criados a partir dele NÃO são afetados.`,
    okLabel: 'Excluir', danger: true
  });
  if (!ok) return;
  try {
    const upd = await api(`/client-templates/${tplId}/projects/${pIdx}/flows/${fIdx}`, 'DELETE');
    Object.assign(t, upd);
    renderClientsModels();
    toast('Fluxo removido do modelo.', 'warn');
  } catch (e) { toast(e.message, 'error'); }
}
function showClientDetailView() {
  $('clients-view-grid').style.display = 'none';
  hideAllDetailViews();
  $('clients-view-detail').style.display = '';
}
function showProjectDetailView() {
  $('clients-view-grid').style.display = 'none';
  hideAllDetailViews();
  const pvd = $('projects-view-detail'); if (pvd) pvd.style.display = '';
}
function showClientReportView() {
  $('clients-view-grid').style.display = 'none';
  hideAllDetailViews();
  const rpt = $('client-report-view'); if (rpt) rpt.style.display = '';
}
function showProjectReportView() {
  $('clients-view-grid').style.display = 'none';
  hideAllDetailViews();
  const rpt = $('project-report-view'); if (rpt) rpt.style.display = '';
}

// ─── PROJETO: view de detalhe (dentro de page-clients) ──────────────────
function openProjectDetail(id) {
  const p = projectById(id);
  if (!p) { toast('Projeto não encontrado', 'error'); return; }
  // Garante que estamos na página certa (URL direta pode entrar por outro tab).
  if (currentPage !== 'clients') goPage('clients');
  currentProjectId = id;
  currentClientId = p.clientId || null; // pra facilitar o "voltar" pro cliente
  showProjectDetailView();
  renderProjectDetail(id);
  navPush('/projects/' + id);
}
function closeProjectDetail() {
  const backToClientId = currentClientId;
  currentProjectId = null;
  if (backToClientId && clientById(backToClientId)) {
    showClientDetailView();
    renderClientDetail(backToClientId);
    navPush('/clients/' + backToClientId);
  } else {
    $('clients-view-grid').style.display = '';
    $('clients-view-detail').style.display = 'none';
    const pvd = $('projects-view-detail'); if (pvd) pvd.style.display = 'none';
    navPush('/clients');
    renderClients();
  }
}
function openProjectModalEdit() {
  if (!currentProjectId) return;
  openProjectModal(currentProjectId);
}

/* ─── Galeria de anexos (cliente + projeto) ───
   Agrega anexos de demandas e comentários no escopo dado, com busca + chips
   de filtro por tipo. Reusa openAttPreview pra visualização. */
const _attGalState = {
  client:  { search: '', kind: '' },
  project: { search: '', kind: '' }
};
const _attGalKindLabels = [
  { k: '',      label: 'Todos' },
  { k: 'image', label: 'Imagens' },
  { k: 'pdf',   label: 'PDFs' },
  { k: 'video', label: 'Vídeos' },
  { k: 'audio', label: 'Áudios' },
  { k: 'link',  label: 'Links' },
  { k: 'other', label: 'Outros' }
];
function attGalKindOf(a) {
  if (a.kind === 'link') return 'link';
  return attPreviewKind(a.type);
}
function collectClientAttachments(clientId) {
  const projIds = new Set((projects || []).filter(p => p.clientId === clientId).map(p => p.id));
  const dds = (demands || []).filter(d => projIds.has(d.projectId) && !d.deletedAt);
  return collectAttachmentsFromDemands(dds);
}
function collectProjectAttachments(projectId) {
  const dds = (demands || []).filter(d => d.projectId === projectId && !d.deletedAt);
  return collectAttachmentsFromDemands(dds);
}
function collectAttachmentsFromDemands(dds) {
  const items = [];
  dds.forEach(d => {
    (d.attachments || []).forEach(a => {
      items.push({ ...a, demandId: d.id, demandName: d.name, addedAt: d.updatedAt || d.createdAt || '' });
    });
    (d.comments || []).forEach(c => {
      (c.attachments || []).forEach(a => {
        items.push({ ...a, demandId: d.id, demandName: d.name, addedAt: c.at || c.createdAt || '' });
      });
    });
  });
  // Ordem: mais recentes primeiro (fallback zero se sem timestamp).
  return items.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
}
function renderAttGallery(ctx) {
  const wrap = $('att-gallery-' + ctx);
  if (!wrap) return;
  const items = ctx === 'client'
    ? collectClientAttachments(currentClientId)
    : collectProjectAttachments(currentProjectId);
  const st = _attGalState[ctx];
  const q = (st.search || '').toLowerCase();
  const filtered = items.filter(a => {
    if (st.kind && attGalKindOf(a) !== st.kind) return false;
    if (q) {
      const n = (a.name || '').toLowerCase();
      const dn = (a.demandName || '').toLowerCase();
      if (!n.includes(q) && !dn.includes(q)) return false;
    }
    return true;
  });
  // Contagem por tipo pra mostrar no chip.
  const counts = { '': items.length };
  items.forEach(a => {
    const k = attGalKindOf(a);
    counts[k] = (counts[k] || 0) + 1;
  });
  const chipsHtml = _attGalKindLabels.map(({ k, label }) => {
    const n = counts[k] || 0;
    if (k && n === 0) return ''; // esconde chip vazio (exceto "Todos")
    return `<button type="button" class="att-gal-chip ${k === st.kind ? 'is-active' : ''}" onclick="attGalPickKind('${ctx}', '${k}')">${esc(label)}<span class="att-gal-chip-count">${n}</span></button>`;
  }).join('');
  const gridHtml = filtered.length
    ? filtered.map(a => attGalTileHtml(a)).join('')
    : `<div class="att-gal-empty">${items.length ? 'Nenhum anexo bate com o filtro.' : 'Nenhum anexo neste ' + (ctx === 'client' ? 'cliente' : 'projeto') + ' ainda.'}</div>`;
  wrap.innerHTML = `
    <div class="att-gal-toolbar">
      <div class="filter-input-wrap att-gal-search">
        <i data-lucide="search" class="filter-input-icon ic-sm"></i>
        <input class="filter-input filter-input--with-icon" placeholder="Buscar anexo ou demanda…" value="${esc(st.search)}" oninput="attGalSearch('${ctx}', this.value)">
      </div>
      <div class="att-gal-chips">${chipsHtml}</div>
    </div>
    <div class="att-gal-grid">${gridHtml}</div>
  `;
  paintIcons();
}
function attGalTileHtml(a) {
  const kind = attGalKindOf(a);
  const nameEsc = esc(a.name || (kind === 'link' ? (a.url || 'Link') : 'Arquivo'));
  const demandEsc = esc(a.demandName || 'Demanda');
  const src = a.data || a.url || '';
  const srcEsc = esc(src);
  const previewable = kind !== 'other' && kind !== 'link';
  const openCall = kind === 'link'
    ? `window.open('${esc(normalizeUrl(a.url || a.name))}', '_blank')`
    : previewable
      ? `openAttPreview('${srcEsc}', '${esc(a.type || '')}', '${esc(a.name || '')}')`
      : `window.open('${srcEsc}', '_blank')`;
  const openDemandCall = `event.stopPropagation();showDetail('${esc(a.demandId)}')`;
  const thumb = kind === 'image' && src
    ? `<div class="att-gal-thumb att-gal-thumb-image" style="background-image:url('${srcEsc}')"></div>`
    : `<div class="att-gal-thumb att-gal-thumb-icon"><i data-lucide="${attIcon(kind)}"></i></div>`;
  return `<div class="att-gal-tile" title="${nameEsc}" onclick="${openCall}">
    ${thumb}
    <div class="att-gal-tile-body">
      <div class="att-gal-tile-name">${nameEsc}</div>
      <button type="button" class="att-gal-tile-demand" title="Abrir demanda" onclick="${openDemandCall}">${demandEsc}</button>
    </div>
  </div>`;
}
function attGalSearch(ctx, val) {
  _attGalState[ctx].search = val || '';
  // Re-render debounced pra não rebuildar em cada tecla.
  clearTimeout(_attGalState[ctx]._t);
  _attGalState[ctx]._t = setTimeout(() => renderAttGallery(ctx), 120);
}
function attGalPickKind(ctx, kind) {
  _attGalState[ctx].kind = kind || '';
  renderAttGallery(ctx);
}

function renderClientDetail(id) {
  const c = clientById(id);
  if (!c) return;

  // Breadcrumb
  const bc = $('client-detail-breadcrumb');
  if (bc) {
    bc.innerHTML = `<span style="color:var(--text-muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;font-size:11px">Clientes cadastrados · </span><span>${esc(c.name)}</span>`;
  }

  // PROJETOS
  const projs = projects.filter(p => p.clientId === id);
  const projGrid = $('client-detail-projects');
  if (!projs.length) {
    projGrid.innerHTML = `<div style="grid-column:1/-1">${emptyState('Nenhum projeto', 'Crie o primeiro projeto deste cliente.', 'inbox')}</div>`;
  } else {
    projGrid.innerHTML = projs.map(p => {
      const statusLabel = p.active === false ? 'Arquivado' : 'Ativo';
      const statusClass = p.active === false ? 'client-card-status--archived' : 'client-card-status--active';
      const avatar = p.avatar
        ? `<div class="client-card-avatar" style="background-image:url('${p.avatar}');background-size:cover;background-position:center"></div>`
        : `<div class="client-card-avatar" style="background:${hexDim(p.color || '#7A00FF')};color:${p.color || '#7A00FF'}">${esc((p.name || 'P').charAt(0).toUpperCase())}</div>`;
      return `<div class="flow-card" onclick="openProjectDetail('${p.id}')">
        ${avatar}
        <div class="flow-card-name">${esc(p.name)}</div>
        <div class="flow-card-sub">${esc(statusLabel)}</div>
      </div>`;
    }).join('');
  }

  // SOBRE — descrição (guidelines), link do drive (driveFiles), ativos (brandAssets).
  // Edição fica no modal do cliente. Aqui é só visualização.
  const descEl = $('client-detail-description');
  const driveEl = $('client-detail-drive');
  const assetsEl = $('client-detail-assets');
  if (descEl) {
    const g = (c.guidelines || '').trim();
    descEl.innerHTML = g
      ? `<div class="client-info-text">${esc(g).replace(/\n/g, '<br>')}</div>`
      : `<div class="client-info-empty">Sem descrição cadastrada.</div>`;
  }
  const renderLinkOrEmpty = (raw, emptyLabel) => {
    const url = (raw || '').trim();
    if (!url) return `<div class="client-info-empty">${emptyLabel}</div>`;
    const label = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return `<a class="client-info-link" href="${esc(url)}" target="_blank" rel="noopener">
      <i data-lucide="external-link" class="ic-sm"></i>
      <span>${esc(label)}</span>
    </a>`;
  };
  if (driveEl)  driveEl.innerHTML  = renderLinkOrEmpty(c.driveFiles,  'Nenhum link do drive.');
  if (assetsEl) assetsEl.innerHTML = renderLinkOrEmpty(c.brandAssets, 'Nenhum link de ativos.');

  // PESSOAS — uma linha por função cadastrada, com select de usuário padrão pro cliente.
  // Persiste em c.roleAssignments: { [roleName]: userId | null }.
  const peopleEl = $('client-detail-people');
  const allRoles = (roles || []).slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const assigns = c.roleAssignments || {};
  // Usuários candidatos pra cada função: filtra por workspace acessível + função
  const wsUsers = users.filter(u =>
    (u.workspaces || []).includes(c.workspaceId) || u.isAdmin
  );
  if (!allRoles.length) {
    peopleEl.innerHTML = `<div class="client-people-empty">Nenhuma função cadastrada. Crie funções em <a href="#" onclick="event.preventDefault(); goPage('users');">Usuários</a> para definir responsáveis padrão por cliente.</div>`;
  } else {
    peopleEl.innerHTML = allRoles.map(role => {
      const candidates = wsUsers.filter(u => (u.role || '') === role.name);
      const currentUid = assigns[role.name] || '';
      const opts = [`<option value="">— Sem responsável padrão —</option>`]
        .concat(candidates.map(u => `<option value="${u.id}" ${u.id === currentUid ? 'selected' : ''}>${esc(u.name)}</option>`))
        .join('');
      const currentUser = currentUid ? userById(currentUid) : null;
      const previewAvatar = currentUser ? avatarHTML(currentUser, 'avatar') : `<div class="avatar" style="background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center"><i data-lucide="user" class="ic-sm"></i></div>`;
      return `<div class="client-person-row">
        <div class="client-person-role">${esc(role.name)}</div>
        <div class="client-person-name">${previewAvatar}</div>
        <select class="form-control" onchange="setClientRoleAssignment('${id}', '${esc(role.name).replace(/'/g, "\\'")}', this.value)" ${candidates.length ? '' : 'disabled'}>
          ${candidates.length ? opts : `<option value="">Sem usuários nesta função</option>`}
        </select>
      </div>`;
    }).join('');
  }

  // TEMPO DEDICADO
  renderClientTimeBlock(id);
  // GALERIA DE ANEXOS
  renderAttGallery('client');
  paintIcons();
}

function setClientTimePeriod(p) {
  currentClientPeriod = p;
  document.querySelectorAll('.client-time-period').forEach(b => b.classList.toggle('active', b.dataset.period === p));
  if (currentClientId) renderClientTimeBlock(currentClientId);
}

async function setClientRoleAssignment(clientId, roleName, userId) {
  const c = clientById(clientId);
  if (!c) return;
  const next = Object.assign({}, c.roleAssignments || {});
  next[roleName] = userId || null;
  try {
    await api('/clients/' + clientId, 'PUT', { roleAssignments: next });
    // Atualiza cache local sem refetch completo (mudança trivial)
    c.roleAssignments = next;
    renderClientDetail(clientId);
    toast('Responsável padrão atualizado.');
  } catch (e) { toast(e.message, 'error'); }
}

function renderClientTimeBlock(clientId) {
  const projs = projects.filter(p => p.clientId === clientId);
  const projIds = new Set(projs.map(p => p.id));
  // Filtra time entries
  const today0 = new Date(); today0.setHours(0,0,0,0);
  let fromYmd = null;
  if (currentClientPeriod !== 'all') {
    const days = parseInt(currentClientPeriod, 10) || 90;
    const from = new Date(today0); from.setDate(from.getDate() - (days - 1));
    fromYmd = from.toISOString().slice(0,10);
  }
  const inRange = (e) => {
    if (!fromYmd) return true;
    const when = ((e.start || e.createdAt || '') + '').slice(0,10);
    return when >= fromYmd;
  };
  let totalHours = 0;
  const byUser = new Map();
  const byDay = new Map();
  demands.forEach(d => {
    if (!projIds.has(d.projectId)) return;
    (d.timeEntries || []).forEach(e => {
      if (!inRange(e)) return;
      const h = Number(e.hours) || 0;
      totalHours += h;
      if (e.userId) byUser.set(e.userId, (byUser.get(e.userId) || 0) + h);
      const day = ((e.start || e.createdAt || '') + '').slice(0,10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + h);
    });
  });

  $('client-time-value').textContent = fmtHours(totalHours);

  // Lista de usuários — ordenado por horas (decrescente) + barra de progresso
  const days = currentClientPeriod === 'all' ? 30 : parseInt(currentClientPeriod, 10);
  let businessDays = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today0); d.setDate(d.getDate() - i);
    if (d.getDay() !== 0 && d.getDay() !== 6) businessDays++;
  }
  const capacity = businessDays * 8;
  const rows = [...byUser.entries()]
    .map(([uid, h]) => ({ u: userById(uid), hours: h }))
    .filter(r => r.u)
    .sort((a, b) => b.hours - a.hours);
  const rowsEl = $('client-time-rows');
  if (!rows.length) {
    rowsEl.innerHTML = `<div class="client-people-empty">Ninguém apontou horas nos projetos deste cliente no período selecionado.</div>`;
  } else {
    rowsEl.innerHTML = rows.map(r => {
      const pct = capacity > 0 ? Math.min(150, Math.round((r.hours / capacity) * 100)) : 0;
      const status = pct >= 100 ? 'overload' : pct >= 75 ? 'high' : pct >= 40 ? 'medium' : 'low';
      return `<div class="client-time-row">
        <div class="client-time-user">
          ${avatarHTML(r.u, 'avatar')}
          <div>
            <div class="client-time-user-name">${esc(r.u.name)}</div>
            <div class="client-time-user-role">${esc(r.u.role || '—')}</div>
          </div>
        </div>
        <div class="client-time-meta">
          <span class="client-time-pct">${pct}%</span>
          <span class="client-time-hh">${fmtHours(r.hours)} / ${capacity}h</span>
        </div>
        <div class="capacity-bar-track" style="flex:1;max-width:none">
          <div class="capacity-bar-fill ${status}" style="width:${Math.min(100, pct)}%"></div>
        </div>
      </div>`;
    }).join('');
  }

  // Chart: linha de horas por dia (últimos N dias)
  const chartEl = $('client-time-chart');
  if (chartEl) {
    // Sem apontamentos no período → esconde o gráfico "linha morta" e mostra
    // empty state proporcional. Reaproveita o helper unificado.
    if (totalHours === 0) {
      chartEl.innerHTML = `<div class="client-chart-wrap client-chart-wrap--empty">
        ${emptyState('Sem apontamentos no período', 'Quando alguém apontar horas em demandas deste cliente, o gráfico aparece aqui.', 'calendar')}
      </div>`;
      paintIcons();
      return;
    }
    const buckets = [];
    const dayCount = currentClientPeriod === 'all' ? 30 : Math.min(90, parseInt(currentClientPeriod, 10) || 30);
    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date(today0); d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0,10);
      buckets.push({ ymd, hours: byDay.get(ymd) || 0, day: d });
    }
    const max = Math.max(1, ...buckets.map(b => b.hours));
    const w = 760, h = 180, padL = 30, padR = 16, padT = 14, padB = 22;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const xStep = innerW / Math.max(1, buckets.length - 1);
    const points = buckets.map((b, i) => [padL + i * xStep, padT + innerH - (b.hours / max) * innerH]);
    const linePath = points.length ? 'M ' + points.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ') : '';
    const areaPath = points.length ? `${linePath} L ${points[points.length-1][0].toFixed(1)} ${padT + innerH} L ${points[0][0].toFixed(1)} ${padT + innerH} Z` : '';
    const peak = Math.ceil(max);
    chartEl.innerHTML = `<div class="client-chart-wrap">
      <div class="client-chart-head">
        <div class="client-chart-title">Horas</div>
        <div class="client-chart-value">${fmtHours(totalHours)} <span class="client-chart-delta">no período</span></div>
      </div>
      <div class="chart-hover-host" id="cli-chart-host">
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:200px;display:block">
          <defs>
            <linearGradient id="clientHoursGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#3CE3A0" stop-opacity="0.35"/>
              <stop offset="100%" stop-color="#3CE3A0" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <g stroke="rgba(255,255,255,0.05)" stroke-width="1" vector-effect="non-scaling-stroke">
            <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}"/>
            <line x1="${padL}" y1="${padT + innerH/2}" x2="${w - padR}" y2="${padT + innerH/2}"/>
            <line x1="${padL}" y1="${padT + innerH}" x2="${w - padR}" y2="${padT + innerH}"/>
          </g>
          <g fill="var(--text-muted)" font-size="11" font-family="'JetBrains Mono', monospace">
            <text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${peak}h</text>
            <text x="${padL - 6}" y="${padT + innerH/2 + 4}" text-anchor="end">${Math.round(peak/2)}h</text>
            <text x="${padL - 6}" y="${padT + innerH + 4}" text-anchor="end">0</text>
          </g>
          ${areaPath ? `<path d="${areaPath}" fill="url(#clientHoursGrad)"/>` : ''}
          ${linePath ? `<path d="${linePath}" fill="none" stroke="#3CE3A0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
          <line id="cli-chart-guide" class="chart-guide" x1="0" y1="${padT}" x2="0" y2="${padT + innerH}" stroke="rgba(255,255,255,0.35)" stroke-width="1" vector-effect="non-scaling-stroke" style="opacity:0;pointer-events:none"/>
          <circle id="cli-chart-marker" r="4" fill="#3CE3A0" stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke" style="opacity:0;pointer-events:none"/>
        </svg>
        <div class="chart-tooltip" id="cli-chart-tooltip"></div>
      </div>
    </div>`;
    // Wire hover
    const host = $('cli-chart-host');
    if (host && points.length) {
      const tipPoints = buckets.map((b, i) => ({
        x: points[i][0], label: new Date(b.ymd + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        series: [{ name: 'Horas', value: b.hours, y: points[i][1], color: '#3CE3A0' }]
      }));
      attachChartHover(host, {
        viewBox: { w, h, padL, padR, padT, innerH },
        points: tipPoints,
        lineEls: $('cli-chart-guide'),
        markerEls: [$('cli-chart-marker')],
        tooltipEl: $('cli-chart-tooltip'),
        format: (v) => v > 0 ? fmtHours(v) : '0h'
      });
    }
  }
}

/* ─── PROJETO: detalhe (view compartilhando page-clients) ─────────────
   Segue a mesma estrutura do detalhe de cliente:
   - SOBRE (descrição, drive, ativos) — vindo de project.driveFiles/brandAssets/guidelines
   - PESSOAS (usuário padrão por função) — vindo de project.roleAssignments
     Herdado do cliente na criação, edições INDEPENDENTES daqui pra frente.
   - TEMPO DEDICADO — só demandas do próprio projeto. */
function renderProjectDetail(id) {
  const p = projectById(id);
  if (!p) return;
  const c = p.clientId ? clientById(p.clientId) : null;

  // Breadcrumb: "Cliente · Projeto"
  const bc = $('project-detail-breadcrumb');
  if (bc) {
    const clientPart = c
      ? `<a href="#" onclick="event.preventDefault(); openClient('${c.id}')" style="color:var(--text-muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;font-size:11px;text-decoration:none">${esc(c.name)}</a>`
      : `<span style="color:var(--text-muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;font-size:11px">Sem cliente</span>`;
    bc.innerHTML = `${clientPart}<span style="color:var(--text-muted);font-weight:500;font-size:11px"> · </span><span>${esc(p.name)}</span>`;
  }

  // SOBRE
  const descEl = $('project-detail-description');
  const driveEl = $('project-detail-drive');
  const assetsEl = $('project-detail-assets');
  if (descEl) {
    const g = (p.guidelines || '').trim();
    descEl.innerHTML = g
      ? `<div class="client-info-text">${esc(g).replace(/\n/g, '<br>')}</div>`
      : `<div class="client-info-empty">Sem descrição cadastrada.</div>`;
  }
  const renderLinkOrEmpty = (raw, emptyLabel) => {
    const url = (raw || '').trim();
    if (!url) return `<div class="client-info-empty">${emptyLabel}</div>`;
    const label = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return `<a class="client-info-link" href="${esc(url)}" target="_blank" rel="noopener">
      <i data-lucide="external-link" class="ic-sm"></i>
      <span>${esc(label)}</span>
    </a>`;
  };
  if (driveEl)  driveEl.innerHTML  = renderLinkOrEmpty(p.driveFiles,  'Nenhum link do drive.');
  if (assetsEl) assetsEl.innerHTML = renderLinkOrEmpty(p.brandAssets, 'Nenhum link de ativos.');

  // PESSOAS — mesma lógica de cliente, mas persistindo em project.roleAssignments.
  const peopleEl = $('project-detail-people');
  const allRoles = (roles || []).slice().sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const assigns = p.roleAssignments || {};
  const wsUsers = users.filter(u => (u.workspaces || []).includes(p.workspaceId) || u.isAdmin);
  if (!allRoles.length) {
    peopleEl.innerHTML = `<div class="client-people-empty">Nenhuma função cadastrada. Crie funções em <a href="#" onclick="event.preventDefault(); goPage('users');">Usuários</a> para definir responsáveis padrão por projeto.</div>`;
  } else {
    peopleEl.innerHTML = allRoles.map(role => {
      const candidates = wsUsers.filter(u => (u.role || '') === role.name);
      const currentUid = assigns[role.name] || '';
      const opts = [`<option value="">— Sem responsável padrão —</option>`]
        .concat(candidates.map(u => `<option value="${u.id}" ${u.id === currentUid ? 'selected' : ''}>${esc(u.name)}</option>`))
        .join('');
      const currentUser = currentUid ? userById(currentUid) : null;
      const previewAvatar = currentUser
        ? avatarHTML(currentUser, 'avatar')
        : `<div class="avatar" style="background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center"><i data-lucide="user" class="ic-sm"></i></div>`;
      return `<div class="client-person-row">
        <div class="client-person-role">${esc(role.name)}</div>
        <div class="client-person-name">${previewAvatar}</div>
        <select class="form-control" onchange="setProjectRoleAssignment('${id}', '${esc(role.name).replace(/'/g, "\\'")}', this.value)" ${candidates.length ? '' : 'disabled'}>
          ${candidates.length ? opts : `<option value="">Sem usuários nesta função</option>`}
        </select>
      </div>`;
    }).join('');
  }

  renderProjectTimeBlock(id);
  // GALERIA DE ANEXOS
  renderAttGallery('project');
  paintIcons();
}

function setProjectTimePeriod(period) {
  currentProjectPeriod = period;
  document.querySelectorAll('.project-time-period').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  if (currentProjectId) renderProjectTimeBlock(currentProjectId);
}

async function setProjectRoleAssignment(projectId, roleName, userId) {
  const p = projectById(projectId);
  if (!p) return;
  const next = Object.assign({}, p.roleAssignments || {});
  next[roleName] = userId || null;
  try {
    await api('/projects/' + projectId, 'PUT', { roleAssignments: next });
    p.roleAssignments = next;
    renderProjectDetail(projectId);
    toast('Responsável padrão do projeto atualizado.');
  } catch (e) { toast(e.message, 'error'); }
}

function renderProjectTimeBlock(projectId) {
  const today0 = new Date(); today0.setHours(0,0,0,0);
  let fromYmd = null;
  if (currentProjectPeriod !== 'all') {
    const days = parseInt(currentProjectPeriod, 10) || 90;
    const from = new Date(today0); from.setDate(from.getDate() - (days - 1));
    fromYmd = from.toISOString().slice(0,10);
  }
  const inRange = (e) => {
    if (!fromYmd) return true;
    const when = ((e.start || e.createdAt || '') + '').slice(0,10);
    return when >= fromYmd;
  };
  let totalHours = 0;
  const byUser = new Map();
  const byDay = new Map();
  demands.forEach(d => {
    if (d.projectId !== projectId) return;
    (d.timeEntries || []).forEach(e => {
      if (!inRange(e)) return;
      const h = Number(e.hours) || 0;
      totalHours += h;
      if (e.userId) byUser.set(e.userId, (byUser.get(e.userId) || 0) + h);
      const day = ((e.start || e.createdAt || '') + '').slice(0,10);
      if (day) byDay.set(day, (byDay.get(day) || 0) + h);
    });
  });

  $('project-time-value').textContent = fmtHours(totalHours);

  // Lista de usuários — mesmo layout do cliente.
  const days = currentProjectPeriod === 'all' ? 30 : parseInt(currentProjectPeriod, 10);
  let businessDays = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(today0); d.setDate(d.getDate() - i);
    if (d.getDay() !== 0 && d.getDay() !== 6) businessDays++;
  }
  const capacity = businessDays * 8;
  const rows = [...byUser.entries()]
    .map(([uid, h]) => ({ u: userById(uid), hours: h }))
    .filter(r => r.u)
    .sort((a, b) => b.hours - a.hours);
  const rowsEl = $('project-time-rows');
  if (!rows.length) {
    rowsEl.innerHTML = `<div class="client-people-empty">Ninguém apontou horas neste projeto no período selecionado.</div>`;
  } else {
    rowsEl.innerHTML = rows.map(r => {
      const pct = capacity > 0 ? Math.min(150, Math.round((r.hours / capacity) * 100)) : 0;
      const status = pct >= 100 ? 'overload' : pct >= 75 ? 'high' : pct >= 40 ? 'medium' : 'low';
      return `<div class="client-time-row">
        <div class="client-time-user">
          ${avatarHTML(r.u, 'avatar')}
          <div>
            <div class="client-time-user-name">${esc(r.u.name)}</div>
            <div class="client-time-user-role">${esc(r.u.role || '—')}</div>
          </div>
        </div>
        <div class="client-time-meta">
          <span class="client-time-pct">${pct}%</span>
          <span class="client-time-hh">${fmtHours(r.hours)} / ${capacity}h</span>
        </div>
        <div class="capacity-bar-track" style="flex:1;max-width:none">
          <div class="capacity-bar-fill ${status}" style="width:${Math.min(100, pct)}%"></div>
        </div>
      </div>`;
    }).join('');
  }

  // Gráfico de horas por dia — mesmo layout do cliente.
  const chartEl = $('project-time-chart');
  if (chartEl) {
    if (totalHours === 0) {
      chartEl.innerHTML = `<div class="client-chart-wrap client-chart-wrap--empty">
        ${emptyState('Sem apontamentos no período', 'Quando alguém apontar horas em demandas deste projeto, o gráfico aparece aqui.', 'calendar')}
      </div>`;
      paintIcons();
      return;
    }
    const buckets = [];
    const dayCount = currentProjectPeriod === 'all' ? 30 : Math.min(90, parseInt(currentProjectPeriod, 10) || 30);
    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date(today0); d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0,10);
      buckets.push({ ymd, hours: byDay.get(ymd) || 0, day: d });
    }
    const max = Math.max(1, ...buckets.map(b => b.hours));
    const w = 760, h = 180, padL = 30, padR = 16, padT = 14, padB = 22;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;
    const xStep = innerW / Math.max(1, buckets.length - 1);
    const points = buckets.map((b, i) => [padL + i * xStep, padT + innerH - (b.hours / max) * innerH]);
    const linePath = points.length ? 'M ' + points.map(pt => `${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' L ') : '';
    const areaPath = points.length ? `${linePath} L ${points[points.length-1][0].toFixed(1)} ${padT + innerH} L ${points[0][0].toFixed(1)} ${padT + innerH} Z` : '';
    const peak = Math.ceil(max);
    chartEl.innerHTML = `<div class="client-chart-wrap">
      <div class="client-chart-head">
        <div class="client-chart-title">Horas</div>
        <div class="client-chart-value">${fmtHours(totalHours)} <span class="client-chart-delta">no período</span></div>
      </div>
      <div class="chart-hover-host" id="proj-chart-host">
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:200px;display:block">
          <defs>
            <linearGradient id="projectHoursGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#3CE3A0" stop-opacity="0.35"/>
              <stop offset="100%" stop-color="#3CE3A0" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <g stroke="rgba(255,255,255,0.05)" stroke-width="1" vector-effect="non-scaling-stroke">
            <line x1="${padL}" y1="${padT}" x2="${w - padR}" y2="${padT}"/>
            <line x1="${padL}" y1="${padT + innerH/2}" x2="${w - padR}" y2="${padT + innerH/2}"/>
            <line x1="${padL}" y1="${padT + innerH}" x2="${w - padR}" y2="${padT + innerH}"/>
          </g>
          <g fill="var(--text-muted)" font-size="11" font-family="'JetBrains Mono', monospace">
            <text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${peak}h</text>
            <text x="${padL - 6}" y="${padT + innerH/2 + 4}" text-anchor="end">${Math.round(peak/2)}h</text>
            <text x="${padL - 6}" y="${padT + innerH + 4}" text-anchor="end">0</text>
          </g>
          ${areaPath ? `<path d="${areaPath}" fill="url(#projectHoursGrad)"/>` : ''}
          ${linePath ? `<path d="${linePath}" fill="none" stroke="#3CE3A0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
          <line id="proj-chart-guide" x1="0" y1="${padT}" x2="0" y2="${padT + innerH}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0" vector-effect="non-scaling-stroke"/>
          <circle id="proj-chart-marker" cx="0" cy="0" r="4" fill="#3CE3A0" opacity="0"/>
        </svg>
        <div class="chart-tooltip" id="proj-chart-tooltip"></div>
      </div>
    </div>`;
    const host = $('proj-chart-host');
    if (host && points.length) {
      const tipPoints = buckets.map((b, i) => ({
        x: points[i][0], label: new Date(b.ymd + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
        series: [{ name: 'Horas', value: b.hours, y: points[i][1], color: '#3CE3A0' }]
      }));
      attachChartHover(host, {
        viewBox: { w, h, padL, padR, padT, innerH },
        points: tipPoints,
        lineEls: $('proj-chart-guide'),
        markerEls: [$('proj-chart-marker')],
        tooltipEl: $('proj-chart-tooltip'),
        format: (v) => v > 0 ? fmtHours(v) : '0h'
      });
    }
  }
}

/* ─── RELATÓRIO MENSAL DO CLIENTE ───────────────────────────────────
   View print-friendly agregando o que foi feito no mês:
   demandas entregues, horas por função, horas por responsável, dados do cliente.
   Estado independente (currentReportMonth) — o mês pode ser trocado sem sair. */
let currentReportMonth = null; // 'YYYY-MM'
let currentProjectReportMonth = null; // idem, escopo por projeto

function openClientReport() {
  if (!currentClientId) { toast('Nenhum cliente selecionado', 'warn'); return; }
  if (!currentReportMonth) currentReportMonth = new Date().toISOString().slice(0,7);
  showClientReportView();
  renderClientReport(currentClientId);
  navPush('/clients/' + currentClientId + '/report');
}
function closeClientReport() {
  const cid = currentClientId;
  if (cid && clientById(cid)) {
    showClientDetailView();
    renderClientDetail(cid);
    navPush('/clients/' + cid);
  } else {
    closeClientDetail();
  }
}
function setReportMonth(ym) {
  currentReportMonth = ym;
  if (currentClientId) renderClientReport(currentClientId);
}
// Carrega jsPDF sob demanda — ~365KB no boot pra um recurso raro.
// Servido local em /vendor/ pra não bater no CSP ('self' only).
// UMD do jsPDF expõe window.jspdf.jsPDF. Cachea a Promise pra concorrência.
let _jspdfPromise = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jspdf.umd.min.js';
    s.onload  = () => {
      if (window.jspdf && window.jspdf.jsPDF) resolve(window.jspdf.jsPDF);
      else reject(new Error('jsPDF carregou mas não expôs a API esperada'));
    };
    s.onerror = () => reject(new Error('Falha ao carregar gerador de PDF'));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}

// Download do PDF gerado PROGRAMATICAMENTE via jsPDF (bundled em html2pdf.bundle).
// Diferente do fluxo antigo (screenshot com html2canvas), aqui construímos cada
// bloco por API — texto selecionável, tamanho pequeno, paginação previsível,
// não depende de viewport / CSS ativo.
async function downloadClientReport() {
  if (!currentClientId) return;
  const c = clientById(currentClientId);
  if (!c) return;
  const ym = currentReportMonth || new Date().toISOString().slice(0,7);
  const [year, mon] = ym.split('-').map(Number);
  const monthNum = ym.split('-')[1] || '';
  const monthLabel = `${MONTHS[mon - 1]} de ${year}`;
  const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
  const filename = `Relatório Mensal ${monthNum} - ${sanitize(c.name)} - Kastor.pdf`;

  toast('Gerando PDF…');
  try {
    const jsPDF = await loadJsPDF();

    // ── Agregações do período (mesma lógica do renderClientReport) ──
    const projs = projects.filter(p => p.clientId === c.id);
    const projIds = new Set(projs.map(p => p.id));
    const projectsActive = projs.filter(p => p.active !== false).length;
    const clientDemands = demands.filter(d => projIds.has(d.projectId));
    const delivered = clientDemands.filter(d => d.completedAt && d.completedAt.slice(0,7) === ym);
    const inProgress = clientDemands.filter(d => !isDone(d));
    let totalHours = 0;
    const hoursByRole = new Map();
    const hoursByUser = new Map();
    clientDemands.forEach(d => {
      (d.timeEntries || []).forEach(e => {
        const when = ((e.start || e.createdAt || '') + '').slice(0,7);
        if (when !== ym) return;
        const h = Number(e.hours) || 0;
        totalHours += h;
        if (e.userId) hoursByUser.set(e.userId, (hoursByUser.get(e.userId) || 0) + h);
        const u = e.userId ? userById(e.userId) : null;
        const role = u?.role || '—';
        hoursByRole.set(role, (hoursByRole.get(role) || 0) + h);
      });
    });

    // ── Setup do doc ──
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const PAGE_W = 210, PAGE_H = 297;
    const MARGIN = 15;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const FOOT_RESERVED = 12; // espaço reservado no rodapé pra footer

    // Paleta consistente com o resto do app.
    const ACCENT = [122, 0, 255];     // #7A00FF
    const TEXT   = [24, 24, 27];       // #18181B
    const MUTED  = [82, 82, 91];       // #52525B
    const BORDER = [228, 228, 231];    // #E4E4E7
    const BG     = [249, 250, 251];    // #F9FAFB
    const HEADBG = [244, 244, 245];    // #F4F4F5
    const RED    = [239, 68, 68];      // #EF4444
    const RED_BG = [254, 226, 226];    // #FEE2E2

    let cursor = MARGIN;
    let pageIdx = 1;

    // ── Utilidades ──
    const truncate = (s, n) => {
      s = String(s || '—');
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    };
    const setColor = (rgb, kind = 'text') => {
      if (kind === 'text') doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      if (kind === 'fill') doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      if (kind === 'draw') doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
    };
    const ensureSpace = (needed) => {
      if (cursor + needed > PAGE_H - MARGIN - FOOT_RESERVED) {
        doc.addPage();
        pageIdx++;
        cursor = MARGIN;
      }
    };

    // ── Header ──
    const headerH = 30;
    setColor(BG, 'fill');
    setColor(BORDER, 'draw');
    doc.roundedRect(MARGIN, cursor, CONTENT_W, headerH, 2, 2, 'FD');
    // Eyebrow accent
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setColor(ACCENT);
    doc.text('RELATÓRIO MENSAL', MARGIN + 8, cursor + 9);
    // Nome do cliente
    doc.setFontSize(20);
    setColor(TEXT);
    doc.text(truncate(c.name, 45), MARGIN + 8, cursor + 19, { maxWidth: CONTENT_W - 16 });
    // Mês por extenso
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    setColor(MUTED);
    doc.text(monthLabel, MARGIN + 8, cursor + 26);
    cursor += headerH + 8;

    // ── KPIs (4 cards em uma linha) ──
    const kpis = [
      { label: 'ENTREGUES NO MÊS',  value: String(delivered.length) },
      { label: 'EM ANDAMENTO',      value: String(inProgress.length) },
      { label: 'HORAS APONTADAS',   value: fmtHours(totalHours) },
      { label: 'PROJETOS ATIVOS',   value: String(projectsActive) }
    ];
    const kpiGap = 4;
    const kpiW = (CONTENT_W - kpiGap * 3) / 4;
    const kpiH = 22;
    kpis.forEach((k, i) => {
      const x = MARGIN + i * (kpiW + kpiGap);
      setColor([255,255,255], 'fill');
      setColor(BORDER, 'draw');
      doc.roundedRect(x, cursor, kpiW, kpiH, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      setColor(MUTED);
      doc.text(k.label, x + 4, cursor + 6.5);
      doc.setFontSize(16);
      setColor(TEXT);
      doc.text(k.value, x + 4, cursor + 17);
    });
    cursor += kpiH + 10;

    // ── Helper: título de seção ──
    const drawSectionTitle = (title) => {
      ensureSpace(10);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      setColor(MUTED);
      doc.text(title, MARGIN, cursor);
      cursor += 5;
    };
    // Helper: box vazio ("nenhuma demanda...", etc)
    const drawEmptyBox = (msg) => {
      ensureSpace(14);
      setColor(BG, 'fill');
      setColor(BORDER, 'draw');
      doc.roundedRect(MARGIN, cursor, CONTENT_W, 12, 2, 2, 'FD');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      setColor(MUTED);
      doc.text(msg, PAGE_W / 2, cursor + 7.5, { align: 'center' });
      cursor += 16;
    };

    // ── Demandas entregues ──
    drawSectionTitle('DEMANDAS ENTREGUES');

    if (!delivered.length) {
      drawEmptyBox(`Nenhuma demanda entregue em ${monthLabel.toLowerCase()}.`);
    } else {
      const cols = [
        { label: 'DEMANDA',      w: 55 },
        { label: 'PROJETO',      w: 32 },
        { label: 'RESPONSÁVEL',  w: 30 },
        { label: 'PRAZO',        w: 20 },
        { label: 'ENTREGA',      w: 26 },
        { label: 'HORAS',        w: 17, align: 'right' }
      ]; // soma = 180
      const rowH = 8;

      const drawTableHeader = () => {
        setColor(HEADBG, 'fill');
        setColor(BORDER, 'draw');
        doc.rect(MARGIN, cursor, CONTENT_W, rowH, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        setColor(MUTED);
        let cx = MARGIN;
        cols.forEach(col => {
          const tx = col.align === 'right' ? cx + col.w - 3 : cx + 3;
          doc.text(col.label, tx, cursor + 5, { align: col.align || 'left' });
          cx += col.w;
        });
        cursor += rowH;
      };

      drawTableHeader();
      const sorted = delivered.slice().sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''));
      for (const d of sorted) {
        // Paginação: se não couber, addPage + redesenha o header
        if (cursor + rowH > PAGE_H - MARGIN - FOOT_RESERVED) {
          doc.addPage(); pageIdx++; cursor = MARGIN;
          drawTableHeader();
        }
        const proj = projectById(d.projectId);
        const owner = d.ownerId ? userById(d.ownerId) : null;
        const dh = (d.timeEntries || []).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
        const late = wasLate(d);

        // Linha
        setColor([255,255,255], 'fill');
        setColor(BORDER, 'draw');
        doc.rect(MARGIN, cursor, CONTENT_W, rowH, 'FD');
        let cx = MARGIN;
        doc.setFontSize(9);
        // Demanda (bold)
        doc.setFont('helvetica', 'bold');
        setColor(TEXT);
        doc.text(truncate(d.name, 34), cx + 3, cursor + 5.3);
        cx += cols[0].w;
        // Projeto
        doc.setFont('helvetica', 'normal');
        doc.text(truncate(proj?.name || '—', 18), cx + 3, cursor + 5.3);
        cx += cols[1].w;
        // Responsável
        doc.text(owner ? truncate(owner.name, 16) : '—', cx + 3, cursor + 5.3);
        cx += cols[2].w;
        // Prazo
        doc.text(d.deadline ? fmtDate(d.deadline) : '—', cx + 3, cursor + 5.3);
        cx += cols[3].w;
        // Entrega (com tag ATRASADA)
        if (late) setColor(RED); else setColor(TEXT);
        doc.text(d.completedAt ? fmtDate(d.completedAt) : '—', cx + 3, cursor + 5.3);
        if (late) {
          doc.setFontSize(6);
          const tw = doc.getTextWidth('ATRASADA') + 2;
          setColor(RED_BG, 'fill');
          doc.roundedRect(cx + 15, cursor + 1.8, tw, 4, 0.5, 0.5, 'F');
          setColor(RED);
          doc.text('ATRASADA', cx + 16, cursor + 4.9);
          doc.setFontSize(9);
        }
        cx += cols[4].w;
        // Horas (right)
        setColor(TEXT);
        doc.setFont('helvetica', 'bold');
        doc.text(fmtHours(dh), cx + cols[5].w - 3, cursor + 5.3, { align: 'right' });
        cursor += rowH;
      }
      cursor += 6;
    }

    // ── Helper: seção de barras horizontais ──
    const drawBarSection = (title, entries, emptyMsg, labelResolver) => {
      drawSectionTitle(title);
      if (!entries.length) {
        drawEmptyBox(emptyMsg);
        return;
      }
      const rowH = 9;
      const labelW = 55;
      const valueW = 22;
      const barW = CONTENT_W - labelW - valueW - 6;
      const barH = 4;
      const max = Math.max(...entries.map(([, h]) => h));
      for (const [key, h] of entries) {
        ensureSpace(rowH);
        const label = labelResolver ? labelResolver(key) : String(key);
        // Label
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        setColor(TEXT);
        doc.text(truncate(label, 30), MARGIN, cursor + 5);
        // Bar track
        const barX = MARGIN + labelW;
        const barY = cursor + 3;
        setColor([230, 230, 234], 'fill');
        doc.roundedRect(barX, barY, barW, barH, 1, 1, 'F');
        // Bar fill
        const pct = max > 0 ? (h / max) : 0;
        setColor(ACCENT, 'fill');
        doc.roundedRect(barX, barY, Math.max(0.5, barW * pct), barH, 1, 1, 'F');
        // Value
        doc.setFontSize(9);
        setColor(TEXT);
        doc.text(fmtHours(h), MARGIN + CONTENT_W, cursor + 5, { align: 'right' });
        cursor += rowH;
      }
      cursor += 6;
    };

    const roleEntries = [...hoursByRole.entries()].sort((a, b) => b[1] - a[1]);
    drawBarSection('HORAS POR FUNÇÃO', roleEntries, 'Sem horas apontadas neste mês.');

    const userEntries = [...hoursByUser.entries()]
      .filter(([uid]) => userById(uid))
      .sort((a, b) => b[1] - a[1]);
    drawBarSection('HORAS POR RESPONSÁVEL', userEntries, 'Ninguém apontou horas neste mês.',
      (uid) => userById(uid)?.name || 'Usuário');

    // ── Footer em cada página ──
    const totalPages = doc.internal.getNumberOfPages();
    const genLabel = `Gerado em ${new Date().toLocaleString('pt-BR')} · Kastor`;
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      setColor(MUTED);
      doc.text(genLabel, MARGIN, PAGE_H - MARGIN + 4);
      doc.text(`${i} / ${totalPages}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 4, { align: 'right' });
    }

    doc.save(filename);
    toast('Relatório baixado!');
  } catch (e) {
    console.error('[downloadClientReport]', e);
    toast(e.message || 'Erro ao gerar PDF', 'error');
  }
}

// ── Month picker (popover com grid + navegação de ano) ─────────────
// Reutilizável: cada "kind" (client, project) tem seus IDs de DOM e uma
// dupla getMonth/setMonth. Só uma instância pode estar aberta por vez —
// _mpState guarda kind ativo + ano em exibição.
const MONTHS_SHORT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const MP_KIND = {
  client: {
    pickerId: 'report-month-picker',
    popoverId: 'mp-popover',
    labelId:   'mp-label',
    yearId:    'mp-year',
    gridId:    'mp-months',
    getMonth: () => currentReportMonth,
    setMonth: (ym) => { setReportMonth(ym); }
  },
  project: {
    pickerId: 'preport-month-picker',
    popoverId: 'pmp-popover',
    labelId:   'pmp-label',
    yearId:    'pmp-year',
    gridId:    'pmp-months',
    getMonth: () => currentProjectReportMonth,
    setMonth: (ym) => { setProjectReportMonth(ym); }
  }
};
let _mpState = null; // null = fechado | { kind, yearShown }

function toggleMp(kind, e) {
  if (e) e.stopPropagation();
  if (_mpState?.kind === kind) closeMp();
  else openMp(kind);
}
function openMp(kind) {
  const cfg = MP_KIND[kind]; if (!cfg) return;
  const pop = $(cfg.popoverId); if (!pop) return;
  // Fecha qualquer outro que estivesse aberto (guarda de sanidade)
  if (_mpState && _mpState.kind !== kind) closeMp();
  const ym = cfg.getMonth() || new Date().toISOString().slice(0,7);
  _mpState = { kind, yearShown: parseInt(ym.split('-')[0], 10) };
  pop.classList.add('open');
  renderMpGrid();
}
function closeMp() {
  if (!_mpState) return;
  const cfg = MP_KIND[_mpState.kind];
  const pop = $(cfg.popoverId);
  if (pop) pop.classList.remove('open');
  _mpState = null;
}
function mpChangeYear(delta) {
  if (!_mpState) return;
  _mpState.yearShown += delta;
  renderMpGrid();
}
function mpSelectMonth(m) {
  if (!_mpState) return;
  const cfg = MP_KIND[_mpState.kind];
  const y = _mpState.yearShown;
  const ym = `${y}-${String(m).padStart(2,'0')}`;
  cfg.setMonth(ym);
  closeMp();
}
function mpJumpToday() {
  if (!_mpState) return;
  const now = new Date();
  _mpState.yearShown = now.getFullYear();
  mpSelectMonth(now.getMonth() + 1);
}
document.addEventListener('click', (e) => {
  if (!_mpState) return;
  const cfg = MP_KIND[_mpState.kind];
  const wrap = $(cfg.pickerId);
  if (wrap && !wrap.contains(e.target)) closeMp();
});
document.addEventListener('keydown', (e) => {
  if (_mpState && e.key === 'Escape') { e.preventDefault(); closeMp(); }
});

// Sincroniza label do trigger + grid (se estiver aberto naquele kind).
function renderMp(kind) {
  const cfg = MP_KIND[kind]; if (!cfg) return;
  const ym = cfg.getMonth() || new Date().toISOString().slice(0,7);
  const [y, m] = ym.split('-').map(Number);
  const lbl = $(cfg.labelId);
  if (lbl) lbl.textContent = `${MONTHS[m - 1]} de ${y}`;
  if (_mpState?.kind === kind) renderMpGrid();
}
function renderMpGrid() {
  if (!_mpState) return;
  const cfg = MP_KIND[_mpState.kind];
  const yearEl = $(cfg.yearId);
  const gridEl = $(cfg.gridId);
  if (!yearEl || !gridEl) return;
  const y = _mpState.yearShown;
  yearEl.textContent = String(y);
  const ymSel = cfg.getMonth() || new Date().toISOString().slice(0,7);
  const [ySel, mSel] = ymSel.split('-').map(Number);
  const now = new Date();
  const yNow = now.getFullYear(), mNow = now.getMonth() + 1;
  gridEl.innerHTML = MONTHS_SHORT.map((label, i) => {
    const m = i + 1;
    const isSelected = y === ySel && m === mSel;
    const isCurrent  = y === yNow && m === mNow;
    const classes = ['mp-month'];
    if (isSelected) classes.push('is-selected');
    else if (isCurrent) classes.push('is-current');
    return `<button type="button" class="${classes.join(' ')}" onclick="mpSelectMonth(${m})">${label}</button>`;
  }).join('');
}

function renderClientReport(clientId) {
  const c = clientById(clientId);
  if (!c) return;
  const ym = currentReportMonth || new Date().toISOString().slice(0,7);
  const [y, m] = ym.split('-').map(Number);
  const monthLabel = `${MONTHS[m - 1]} de ${y}`;

  // Popula seletor de mês (label + grid do popover).
  renderMp('client');

  // Header
  $('report-client-name').textContent = c.name;
  $('report-period-label').textContent = monthLabel;
  $('report-generated-at').textContent = new Date().toLocaleString('pt-BR');

  // Escopo: projetos do cliente + demandas desses projetos.
  const projs = projects.filter(p => p.clientId === c.id);
  const projIds = new Set(projs.map(p => p.id));
  const projectsActive = projs.filter(p => p.active !== false).length;
  const clientDemands = demands.filter(d => projIds.has(d.projectId));

  // Demandas entregues no mês = completedAt dentro do intervalo YYYY-MM.
  const monthPrefix = ym;
  const delivered = clientDemands.filter(d => d.completedAt && d.completedAt.slice(0,7) === monthPrefix);
  const inProgress = clientDemands.filter(d => !isDone(d));

  // Horas apontadas no mês (agrega por dia YYYY-MM).
  let totalHours = 0;
  const hoursByRole = new Map();
  const hoursByUser = new Map();
  clientDemands.forEach(d => {
    (d.timeEntries || []).forEach(e => {
      const when = ((e.start || e.createdAt || '') + '').slice(0,7);
      if (when !== monthPrefix) return;
      const h = Number(e.hours) || 0;
      totalHours += h;
      if (e.userId) hoursByUser.set(e.userId, (hoursByUser.get(e.userId) || 0) + h);
      const u = e.userId ? userById(e.userId) : null;
      const role = u?.role || '—';
      hoursByRole.set(role, (hoursByRole.get(role) || 0) + h);
    });
  });

  // KPIs (4 cards)
  $('report-kpis').innerHTML = `
    <div class="report-kpi">
      <div class="report-kpi-label">Entregues no mês</div>
      <div class="report-kpi-value">${delivered.length}</div>
    </div>
    <div class="report-kpi">
      <div class="report-kpi-label">Em andamento</div>
      <div class="report-kpi-value">${inProgress.length}</div>
    </div>
    <div class="report-kpi">
      <div class="report-kpi-label">Horas apontadas</div>
      <div class="report-kpi-value">${fmtHours(totalHours)}</div>
    </div>
    <div class="report-kpi">
      <div class="report-kpi-label">Projetos ativos</div>
      <div class="report-kpi-value">${projectsActive}</div>
    </div>
  `;

  // Demandas entregues — tabela com projeto, responsável, prazo, entrega, horas.
  const deliveredEl = $('report-delivered');
  if (!delivered.length) {
    deliveredEl.innerHTML = `<div class="client-people-empty">Nenhuma demanda entregue em ${monthLabel.toLowerCase()}.</div>`;
  } else {
    const sorted = delivered.slice().sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''));
    deliveredEl.innerHTML = `<table class="report-table">
      <thead>
        <tr>
          <th>Demanda</th>
          <th>Projeto</th>
          <th>Responsável</th>
          <th>Prazo</th>
          <th>Entrega</th>
          <th class="num">Horas</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(d => {
          const proj = projectById(d.projectId);
          const owner = d.ownerId ? userById(d.ownerId) : null;
          const dh = (d.timeEntries || []).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          const late = wasLate(d);
          return `<tr>
            <td class="report-td-name">${esc(d.name || '—')}</td>
            <td>${esc(proj?.name || '—')}</td>
            <td>${owner ? esc(owner.name) : '<span class="report-muted">—</span>'}</td>
            <td>${d.deadline ? fmtDate(d.deadline) : '<span class="report-muted">—</span>'}</td>
            <td class="${late ? 'report-late' : ''}">${d.completedAt ? fmtDate(d.completedAt) : '—'}${late ? ' <span class="report-late-tag">atrasada</span>' : ''}</td>
            <td class="num">${fmtHours(dh)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  // Horas por função — barras horizontais.
  const roleRowsEl = $('report-hours-role');
  const roleEntries = [...hoursByRole.entries()].sort((a, b) => b[1] - a[1]);
  if (!roleEntries.length) {
    roleRowsEl.innerHTML = `<div class="client-people-empty">Sem horas apontadas neste mês.</div>`;
  } else {
    const maxRole = Math.max(...roleEntries.map(([, h]) => h));
    roleRowsEl.innerHTML = roleEntries.map(([role, h]) => {
      const pct = maxRole > 0 ? Math.round((h / maxRole) * 100) : 0;
      return `<div class="report-bar-row">
        <div class="report-bar-label">${esc(role)}</div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%"></div></div>
        <div class="report-bar-value">${fmtHours(h)}</div>
      </div>`;
    }).join('');
  }

  // Horas por responsável — mesmo padrão, com avatar.
  const userRowsEl = $('report-hours-user');
  const userEntries = [...hoursByUser.entries()]
    .map(([uid, h]) => ({ u: userById(uid), hours: h }))
    .filter(x => x.u)
    .sort((a, b) => b.hours - a.hours);
  if (!userEntries.length) {
    userRowsEl.innerHTML = `<div class="client-people-empty">Ninguém apontou horas neste mês.</div>`;
  } else {
    const maxUser = Math.max(...userEntries.map(x => x.hours));
    userRowsEl.innerHTML = userEntries.map(x => {
      const pct = maxUser > 0 ? Math.round((x.hours / maxUser) * 100) : 0;
      return `<div class="report-bar-row report-bar-row--user">
        <div class="report-bar-user">${avatarHTML(x.u, 'avatar')} <span>${esc(x.u.name)}</span></div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%"></div></div>
        <div class="report-bar-value">${fmtHours(x.hours)}</div>
      </div>`;
    }).join('');
  }

  paintIcons();
}

/* ─── RELATÓRIO MENSAL DO PROJETO ───────────────────────────────────
   Espelha a lógica do relatório do cliente mas escopa por projectId.
   4º KPI muda pra "Em atraso" (mais acionável que "projetos ativos" quando
   o escopo já é um projeto único). */
function openProjectReport() {
  if (!currentProjectId) { toast('Nenhum projeto selecionado', 'warn'); return; }
  if (!currentProjectReportMonth) currentProjectReportMonth = new Date().toISOString().slice(0,7);
  showProjectReportView();
  renderProjectReport(currentProjectId);
  navPush('/projects/' + currentProjectId + '/report');
}
function closeProjectReport() {
  const pid = currentProjectId;
  if (pid && projectById(pid)) {
    showProjectDetailView();
    renderProjectDetail(pid);
    navPush('/projects/' + pid);
  } else {
    closeClientDetail();
  }
}
function setProjectReportMonth(ym) {
  currentProjectReportMonth = ym;
  if (currentProjectId) renderProjectReport(currentProjectId);
}

function renderProjectReport(projectId) {
  const p = projectById(projectId);
  if (!p) return;
  const c = p.clientId ? clientById(p.clientId) : null;
  const ym = currentProjectReportMonth || new Date().toISOString().slice(0,7);
  const [y, m] = ym.split('-').map(Number);
  const monthLabel = `${MONTHS[m - 1]} de ${y}`;

  renderMp('project');

  // Header
  $('preport-eyebrow').textContent = c ? `RELATÓRIO MENSAL · PROJETO DE ${c.name.toUpperCase()}` : 'RELATÓRIO MENSAL · PROJETO';
  $('preport-title').textContent = p.name;
  $('preport-period-label').textContent = monthLabel;
  $('preport-generated-at').textContent = new Date().toLocaleString('pt-BR');

  // Escopo: só demandas deste projeto.
  const projectDemands = demands.filter(d => d.projectId === projectId);
  const monthPrefix = ym;
  const delivered = projectDemands.filter(d => d.completedAt && d.completedAt.slice(0,7) === monthPrefix);
  const inProgress = projectDemands.filter(d => !isDone(d));
  // Em atraso = deadline passou e não concluída.
  const today = todayStr();
  const overdue = projectDemands.filter(d => d.deadline && !isDone(d) && d.deadline < today);

  // Horas do período.
  let totalHours = 0;
  const hoursByRole = new Map();
  const hoursByUser = new Map();
  projectDemands.forEach(d => {
    (d.timeEntries || []).forEach(e => {
      const when = ((e.start || e.createdAt || '') + '').slice(0,7);
      if (when !== monthPrefix) return;
      const h = Number(e.hours) || 0;
      totalHours += h;
      if (e.userId) hoursByUser.set(e.userId, (hoursByUser.get(e.userId) || 0) + h);
      const u = e.userId ? userById(e.userId) : null;
      const role = u?.role || '—';
      hoursByRole.set(role, (hoursByRole.get(role) || 0) + h);
    });
  });

  // KPIs — troca "Projetos ativos" por "Em atraso" (mais útil no escopo projeto).
  $('preport-kpis').innerHTML = `
    <div class="report-kpi">
      <div class="report-kpi-label">Entregues no mês</div>
      <div class="report-kpi-value">${delivered.length}</div>
    </div>
    <div class="report-kpi">
      <div class="report-kpi-label">Em andamento</div>
      <div class="report-kpi-value">${inProgress.length}</div>
    </div>
    <div class="report-kpi">
      <div class="report-kpi-label">Horas apontadas</div>
      <div class="report-kpi-value">${fmtHours(totalHours)}</div>
    </div>
    <div class="report-kpi">
      <div class="report-kpi-label">Em atraso</div>
      <div class="report-kpi-value ${overdue.length ? 'report-kpi-danger' : ''}">${overdue.length}</div>
    </div>
  `;

  // Demandas entregues — tabela (sem coluna Projeto já que é o próprio escopo).
  const deliveredEl = $('preport-delivered');
  if (!delivered.length) {
    deliveredEl.innerHTML = `<div class="client-people-empty">Nenhuma demanda entregue em ${monthLabel.toLowerCase()}.</div>`;
  } else {
    const sorted = delivered.slice().sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''));
    deliveredEl.innerHTML = `<table class="report-table">
      <thead>
        <tr>
          <th>Demanda</th>
          <th>Responsável</th>
          <th>Prazo</th>
          <th>Entrega</th>
          <th class="num">Horas</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(d => {
          const owner = d.ownerId ? userById(d.ownerId) : null;
          const dh = (d.timeEntries || []).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
          const late = wasLate(d);
          return `<tr>
            <td class="report-td-name">${esc(d.name || '—')}</td>
            <td>${owner ? esc(owner.name) : '<span class="report-muted">—</span>'}</td>
            <td>${d.deadline ? fmtDate(d.deadline) : '<span class="report-muted">—</span>'}</td>
            <td class="${late ? 'report-late' : ''}">${d.completedAt ? fmtDate(d.completedAt) : '—'}${late ? ' <span class="report-late-tag">atrasada</span>' : ''}</td>
            <td class="num">${fmtHours(dh)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  // Horas por função.
  const roleRowsEl = $('preport-hours-role');
  const roleEntries = [...hoursByRole.entries()].sort((a, b) => b[1] - a[1]);
  if (!roleEntries.length) {
    roleRowsEl.innerHTML = `<div class="client-people-empty">Sem horas apontadas neste mês.</div>`;
  } else {
    const maxRole = Math.max(...roleEntries.map(([, h]) => h));
    roleRowsEl.innerHTML = roleEntries.map(([role, h]) => {
      const pct = maxRole > 0 ? Math.round((h / maxRole) * 100) : 0;
      return `<div class="report-bar-row">
        <div class="report-bar-label">${esc(role)}</div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%"></div></div>
        <div class="report-bar-value">${fmtHours(h)}</div>
      </div>`;
    }).join('');
  }

  // Horas por responsável.
  const userRowsEl = $('preport-hours-user');
  const userEntries = [...hoursByUser.entries()]
    .map(([uid, h]) => ({ u: userById(uid), hours: h }))
    .filter(x => x.u)
    .sort((a, b) => b.hours - a.hours);
  if (!userEntries.length) {
    userRowsEl.innerHTML = `<div class="client-people-empty">Ninguém apontou horas neste mês.</div>`;
  } else {
    const maxUser = Math.max(...userEntries.map(x => x.hours));
    userRowsEl.innerHTML = userEntries.map(x => {
      const pct = maxUser > 0 ? Math.round((x.hours / maxUser) * 100) : 0;
      return `<div class="report-bar-row report-bar-row--user">
        <div class="report-bar-user">${avatarHTML(x.u, 'avatar')} <span>${esc(x.u.name)}</span></div>
        <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%"></div></div>
        <div class="report-bar-value">${fmtHours(x.hours)}</div>
      </div>`;
    }).join('');
  }

  paintIcons();
}

// Download programático — mesma estrutura do cliente mas escopado ao projeto.
async function downloadProjectReport() {
  if (!currentProjectId) return;
  const p = projectById(currentProjectId);
  if (!p) return;
  const c = p.clientId ? clientById(p.clientId) : null;
  const ym = currentProjectReportMonth || new Date().toISOString().slice(0,7);
  const [year, mon] = ym.split('-').map(Number);
  const monthNum = ym.split('-')[1] || '';
  const monthLabel = `${MONTHS[mon - 1]} de ${year}`;
  const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
  const clientPart = c ? ` - ${sanitize(c.name)}` : '';
  const filename = `Relatório Mensal ${monthNum} - ${sanitize(p.name)}${clientPart} - Kastor.pdf`;

  toast('Gerando PDF…');
  try {
    const jsPDF = await loadJsPDF();

    // Agregações.
    const projectDemands = demands.filter(d => d.projectId === p.id);
    const delivered = projectDemands.filter(d => d.completedAt && d.completedAt.slice(0,7) === ym);
    const inProgress = projectDemands.filter(d => !isDone(d));
    const today = todayStr();
    const overdue = projectDemands.filter(d => d.deadline && !isDone(d) && d.deadline < today);
    let totalHours = 0;
    const hoursByRole = new Map();
    const hoursByUser = new Map();
    projectDemands.forEach(d => {
      (d.timeEntries || []).forEach(e => {
        const when = ((e.start || e.createdAt || '') + '').slice(0,7);
        if (when !== ym) return;
        const h = Number(e.hours) || 0;
        totalHours += h;
        if (e.userId) hoursByUser.set(e.userId, (hoursByUser.get(e.userId) || 0) + h);
        const u = e.userId ? userById(e.userId) : null;
        const role = u?.role || '—';
        hoursByRole.set(role, (hoursByRole.get(role) || 0) + h);
      });
    });

    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const PAGE_W = 210, PAGE_H = 297;
    const MARGIN = 15;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const FOOT_RESERVED = 12;
    const ACCENT = [122, 0, 255];
    const TEXT   = [24, 24, 27];
    const MUTED  = [82, 82, 91];
    const BORDER = [228, 228, 231];
    const BG     = [249, 250, 251];
    const HEADBG = [244, 244, 245];
    const RED    = [239, 68, 68];
    const RED_BG = [254, 226, 226];

    let cursor = MARGIN;
    const truncate = (s, n) => { s = String(s || '—'); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const setColor = (rgb, kind = 'text') => {
      if (kind === 'text') doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      if (kind === 'fill') doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      if (kind === 'draw') doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
    };
    const ensureSpace = (needed) => {
      if (cursor + needed > PAGE_H - MARGIN - FOOT_RESERVED) {
        doc.addPage(); cursor = MARGIN;
      }
    };

    // ── Header ──
    const headerH = 32;
    setColor(BG, 'fill'); setColor(BORDER, 'draw');
    doc.roundedRect(MARGIN, cursor, CONTENT_W, headerH, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setColor(ACCENT);
    const eyebrow = c ? `RELATÓRIO MENSAL · PROJETO DE ${c.name.toUpperCase()}` : 'RELATÓRIO MENSAL · PROJETO';
    doc.text(truncate(eyebrow, 60), MARGIN + 8, cursor + 9);
    doc.setFontSize(20);
    setColor(TEXT);
    doc.text(truncate(p.name, 45), MARGIN + 8, cursor + 20, { maxWidth: CONTENT_W - 16 });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    setColor(MUTED);
    doc.text(monthLabel, MARGIN + 8, cursor + 28);
    cursor += headerH + 8;

    // ── KPIs ──
    const kpis = [
      { label: 'ENTREGUES NO MÊS', value: String(delivered.length), danger: false },
      { label: 'EM ANDAMENTO',     value: String(inProgress.length), danger: false },
      { label: 'HORAS APONTADAS',  value: fmtHours(totalHours), danger: false },
      { label: 'EM ATRASO',        value: String(overdue.length), danger: overdue.length > 0 }
    ];
    const kpiGap = 4;
    const kpiW = (CONTENT_W - kpiGap * 3) / 4;
    const kpiH = 22;
    kpis.forEach((k, i) => {
      const x = MARGIN + i * (kpiW + kpiGap);
      setColor([255,255,255], 'fill'); setColor(BORDER, 'draw');
      doc.roundedRect(x, cursor, kpiW, kpiH, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      setColor(MUTED);
      doc.text(k.label, x + 4, cursor + 6.5);
      doc.setFontSize(16);
      setColor(k.danger ? RED : TEXT);
      doc.text(k.value, x + 4, cursor + 17);
    });
    cursor += kpiH + 10;

    const drawSectionTitle = (title) => {
      ensureSpace(10);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      setColor(MUTED);
      doc.text(title, MARGIN, cursor);
      cursor += 5;
    };
    const drawEmptyBox = (msg) => {
      ensureSpace(14);
      setColor(BG, 'fill'); setColor(BORDER, 'draw');
      doc.roundedRect(MARGIN, cursor, CONTENT_W, 12, 2, 2, 'FD');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      setColor(MUTED);
      doc.text(msg, PAGE_W / 2, cursor + 7.5, { align: 'center' });
      cursor += 16;
    };

    // ── Demandas entregues (sem coluna Projeto) ──
    drawSectionTitle('DEMANDAS ENTREGUES');
    if (!delivered.length) {
      drawEmptyBox(`Nenhuma demanda entregue em ${monthLabel.toLowerCase()}.`);
    } else {
      // 5 colunas: Demanda 65 | Responsável 40 | Prazo 25 | Entrega 32 | Horas 18 = 180
      const cols = [
        { label: 'DEMANDA',     w: 65 },
        { label: 'RESPONSÁVEL', w: 40 },
        { label: 'PRAZO',       w: 25 },
        { label: 'ENTREGA',     w: 32 },
        { label: 'HORAS',       w: 18, align: 'right' }
      ];
      const rowH = 8;
      const drawTableHeader = () => {
        setColor(HEADBG, 'fill'); setColor(BORDER, 'draw');
        doc.rect(MARGIN, cursor, CONTENT_W, rowH, 'FD');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
        setColor(MUTED);
        let cx = MARGIN;
        cols.forEach(col => {
          const tx = col.align === 'right' ? cx + col.w - 3 : cx + 3;
          doc.text(col.label, tx, cursor + 5, { align: col.align || 'left' });
          cx += col.w;
        });
        cursor += rowH;
      };
      drawTableHeader();
      const sorted = delivered.slice().sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''));
      for (const d of sorted) {
        if (cursor + rowH > PAGE_H - MARGIN - FOOT_RESERVED) {
          doc.addPage(); cursor = MARGIN; drawTableHeader();
        }
        const owner = d.ownerId ? userById(d.ownerId) : null;
        const dh = (d.timeEntries || []).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
        const late = wasLate(d);
        setColor([255,255,255], 'fill'); setColor(BORDER, 'draw');
        doc.rect(MARGIN, cursor, CONTENT_W, rowH, 'FD');
        let cx = MARGIN;
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold'); setColor(TEXT);
        doc.text(truncate(d.name, 40), cx + 3, cursor + 5.3);
        cx += cols[0].w;
        doc.setFont('helvetica', 'normal');
        doc.text(owner ? truncate(owner.name, 22) : '—', cx + 3, cursor + 5.3);
        cx += cols[1].w;
        doc.text(d.deadline ? fmtDate(d.deadline) : '—', cx + 3, cursor + 5.3);
        cx += cols[2].w;
        if (late) setColor(RED); else setColor(TEXT);
        doc.text(d.completedAt ? fmtDate(d.completedAt) : '—', cx + 3, cursor + 5.3);
        if (late) {
          doc.setFontSize(6);
          const tw = doc.getTextWidth('ATRASADA') + 2;
          setColor(RED_BG, 'fill');
          doc.roundedRect(cx + 15, cursor + 1.8, tw, 4, 0.5, 0.5, 'F');
          setColor(RED);
          doc.text('ATRASADA', cx + 16, cursor + 4.9);
          doc.setFontSize(9);
        }
        cx += cols[3].w;
        setColor(TEXT); doc.setFont('helvetica', 'bold');
        doc.text(fmtHours(dh), cx + cols[4].w - 3, cursor + 5.3, { align: 'right' });
        cursor += rowH;
      }
      cursor += 6;
    }

    const drawBarSection = (title, entries, emptyMsg, labelResolver) => {
      drawSectionTitle(title);
      if (!entries.length) { drawEmptyBox(emptyMsg); return; }
      const rowH = 9;
      const labelW = 55;
      const valueW = 22;
      const barW = CONTENT_W - labelW - valueW - 6;
      const barH = 4;
      const max = Math.max(...entries.map(([, h]) => h));
      for (const [key, h] of entries) {
        ensureSpace(rowH);
        const label = labelResolver ? labelResolver(key) : String(key);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
        setColor(TEXT);
        doc.text(truncate(label, 30), MARGIN, cursor + 5);
        const barX = MARGIN + labelW;
        const barY = cursor + 3;
        setColor([230, 230, 234], 'fill');
        doc.roundedRect(barX, barY, barW, barH, 1, 1, 'F');
        const pct = max > 0 ? (h / max) : 0;
        setColor(ACCENT, 'fill');
        doc.roundedRect(barX, barY, Math.max(0.5, barW * pct), barH, 1, 1, 'F');
        doc.setFontSize(9); setColor(TEXT);
        doc.text(fmtHours(h), MARGIN + CONTENT_W, cursor + 5, { align: 'right' });
        cursor += rowH;
      }
      cursor += 6;
    };

    const roleEntries = [...hoursByRole.entries()].sort((a, b) => b[1] - a[1]);
    drawBarSection('HORAS POR FUNÇÃO', roleEntries, 'Sem horas apontadas neste mês.');

    const userEntries = [...hoursByUser.entries()]
      .filter(([uid]) => userById(uid))
      .sort((a, b) => b[1] - a[1]);
    drawBarSection('HORAS POR RESPONSÁVEL', userEntries, 'Ninguém apontou horas neste mês.',
      (uid) => userById(uid)?.name || 'Usuário');

    // Footer.
    const totalPages = doc.internal.getNumberOfPages();
    const genLabel = `Gerado em ${new Date().toLocaleString('pt-BR')} · Kastor`;
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      setColor(MUTED);
      doc.text(genLabel, MARGIN, PAGE_H - MARGIN + 4);
      doc.text(`${i} / ${totalPages}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 4, { align: 'right' });
    }
    doc.save(filename);
    toast('Relatório baixado!');
  } catch (e) {
    console.error('[downloadProjectReport]', e);
    toast(e.message || 'Erro ao gerar PDF', 'error');
  }
}

/* ─── MODAL: NOVO/EDITAR CLIENTE ─── */
function openClientModal(id) {
  editingClientId = id || null;
  const c = id ? clientById(id) : null;
  const isNew = !c;
  $('client-modal-title').textContent = isNew ? 'Novo Cliente' : 'Editar Cliente';
  $('c-name').value = c?.name || '';
  $('c-segment').value = c?.segment || '';
  $('c-drive-files').value = c?.driveFiles || '';
  $('c-brand-assets').value = c?.brandAssets || '';
  $('c-guidelines').value = c?.guidelines || '';
  setColorValue('c-color', c?.color || '#7A00FF');
  // Workspace
  const wsSel = $('c-workspace');
  const accessibleWs = workspaces.filter(w => me.isAdmin || (me.workspaces || []).includes(w.id));
  wsSel.innerHTML = accessibleWs.map(w =>
    `<option value="${w.id}" ${(c ? c.workspaceId : activeWs) === w.id ? 'selected' : ''}>${esc(w.name)}</option>`
  ).join('');
  // Avatar
  clientAvatarData = c?.avatar || null;
  refreshClientAvatarPreview();
  // Datalist de segmentos existentes
  const segs = [...new Set(clients.map(x => x.segment).filter(Boolean))].sort();
  $('client-segments-datalist').innerHTML = segs.map(s => `<option value="${esc(s)}">`).join('');
  // Footer: edit mostra status toggle + excluir + salvar como modelo
  $('c-foot-left').style.display = '';
  $('c-delete-btn').style.display = isNew ? 'none' : '';
  $('c-status-group').style.display = isNew ? 'none' : '';
  $('c-save-template-btn').style.display = isNew ? 'none' : '';
  if (c) {
    clientModalStatusActive = c.active !== false;
    refreshClientStatusUI();
  }
  // Onboarding: dropdown de modelos só no Novo
  const tplBar = $('c-template-bar');
  const tplSel = $('c-template');
  if (isNew && tplSel && tplBar) {
    const wsId = activeWs;
    const myTpls = (clientTemplates || []).filter(t => t.workspaceId === wsId);
    if (myTpls.length) {
      tplBar.style.display = '';
      tplSel.innerHTML = `<option value="">— Em branco —</option>` +
        myTpls.map(t => {
          const nProj = (t.projects || []).length;
          const nFlow = (t.projects || []).reduce((s, p) => s + (p.flows || []).length, 0);
          return `<option value="${t.id}">${esc(t.name)} (${nProj} projeto${nProj === 1 ? '' : 's'} · ${nFlow} fluxo${nFlow === 1 ? '' : 's'})</option>`;
        }).join('');
      tplSel.value = '';
    } else {
      tplBar.style.display = 'none';
    }
  } else if (tplBar) {
    tplBar.style.display = 'none';
  }
  openModal('client-modal');
  navPush(isNew ? '/clients/new' : '/clients/' + id + '/edit');
}
function openClientModalEdit() {
  if (currentClientId) openClientModal(currentClientId);
}
function refreshClientAvatarPreview() {
  const el = $('c-avatar-preview');
  if (!el) return;
  if (clientAvatarData) {
    el.style.backgroundImage = `url('${clientAvatarData}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.innerHTML = '';
    $('c-avatar-remove').style.display = '';
  } else {
    el.style.backgroundImage = '';
    el.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Sem foto</span>';
    $('c-avatar-remove').style.display = 'none';
  }
}
function handleClientAvatarUpload(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Imagem excede 5MB.', 'error'); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (e) => { clientAvatarData = e.target.result; refreshClientAvatarPreview(); };
  reader.readAsDataURL(file);
  ev.target.value = '';
}
function removeClientAvatar() {
  clientAvatarData = null;
  refreshClientAvatarPreview();
}
function setClientModalStatus(active) {
  clientModalStatusActive = active;
  refreshClientStatusUI();
}
function refreshClientStatusUI() {
  document.querySelectorAll('.client-status-pick').forEach(b => {
    b.classList.toggle('active', (b.dataset.val === 'active') === clientModalStatusActive);
  });
}
async function saveClient() {
  const name = ($('c-name').value || '').trim();
  if (!name) { toast('Nome do cliente é obrigatório.', 'error'); return; }
  // Modo "novo a partir de modelo" — usa endpoint dedicado que cria projetos+fluxos junto
  const templateId = !editingClientId && $('c-template') ? $('c-template').value : '';
  if (templateId) {
    try {
      const r = await api('/clients/from-template', 'POST', {
        templateId, name, workspaceId: $('c-workspace').value
      });
      closeModal('client-modal');
      toast(`Cliente criado a partir do modelo (${r.counts.projects} projeto${r.counts.projects === 1 ? '' : 's'}, ${r.counts.flows} fluxo${r.counts.flows === 1 ? '' : 's'}).`);
      await refreshData();
      return;
    } catch (e) {
      toast(e.message || 'Erro ao aplicar modelo', 'error');
      return;
    }
  }
  const payload = {
    name,
    workspaceId: $('c-workspace').value,
    color: $('c-color').value,
    segment: $('c-segment').value,
    driveFiles: $('c-drive-files').value,
    brandAssets: $('c-brand-assets').value,
    guidelines: $('c-guidelines').value,
    avatar: clientAvatarData
  };
  if (editingClientId) payload.active = clientModalStatusActive;
  try {
    const r = editingClientId
      ? await api('/clients/' + editingClientId, 'PUT', payload)
      : await api('/clients', 'POST', payload);
    closeModal('client-modal');
    toast(editingClientId ? 'Cliente atualizado!' : 'Cliente criado!');
    // Se estava na tela de detalhe (URL /clients/<id>/edit), volta pro detalhe
    if (currentClientId) navPush('/clients/' + currentClientId);
    await refreshData();
  } catch (e) {
    toast(e.message || 'Erro ao salvar cliente', 'error');
  }
}

/* Salvar cliente atual como modelo — abre confirm que pede o nome */
function openSaveClientTemplate() {
  if (!editingClientId) return;
  const c = clientById(editingClientId);
  if (!c) return;
  const projs = projects.filter(p => p.clientId === c.id && p.active !== false);
  const flowsCount = projs.reduce((sum, p) => sum + flows.filter(f => f.projectId === p.id).length, 0);
  $('c-tpl-save-summary').innerHTML = `Vai salvar <strong>${esc(c.name)}</strong> como modelo: <strong>${projs.length}</strong> projeto${projs.length === 1 ? '' : 's'} e <strong>${flowsCount}</strong> fluxo${flowsCount === 1 ? '' : 's'} ativos. Demandas, agendamentos e atribuições NÃO vão pro modelo.`;
  $('c-tpl-save-name').value = `Modelo: ${c.name}`;
  openModal('client-template-save-modal');
  setTimeout(() => $('c-tpl-save-name').focus(), 60);
}
async function confirmSaveClientTemplate() {
  const name = ($('c-tpl-save-name').value || '').trim();
  if (!name) { toast('Dê um nome ao modelo.', 'error'); return; }
  try {
    await api('/client-templates', 'POST', { sourceClientId: editingClientId, name });
    clientTemplates = await api('/client-templates');
    closeModal('client-template-save-modal');
    toast('Modelo salvo. Disponível ao criar um novo cliente.');
  } catch (e) {
    toast(e.message || 'Erro ao salvar modelo', 'error');
  }
}

/* Exclusão com confirmação (digite o nome) */
function openClientDeleteConfirm() {
  if (!editingClientId) return;
  const c = clientById(editingClientId);
  if (!c) return;
  $('client-delete-title').textContent = `Excluir ${c.name}?`;
  $('client-delete-confirm-text').innerHTML = `Para confirmar, digite <strong>${esc(c.name)}</strong> abaixo:`;
  $('client-delete-input').value = '';
  $('client-delete-input').placeholder = c.name;
  $('client-delete-confirm-btn').disabled = true;
  $('client-delete-warning').textContent = '';
  // Aviso se tem projetos vinculados
  const linked = projects.filter(p => p.clientId === c.id).length;
  if (linked > 0) {
    $('client-delete-warning').textContent = `⚠ Este cliente tem ${linked} projeto(s) vinculado(s). Exclua ou mova os projetos antes.`;
  }
  openModal('client-delete-modal');
}
function updateClientDeleteBtnState() {
  if (!editingClientId) return;
  const c = clientById(editingClientId);
  const typed = ($('client-delete-input').value || '').trim();
  const linked = projects.filter(p => p.clientId === c.id).length;
  $('client-delete-confirm-btn').disabled = !(c && typed === c.name && linked === 0);
}
async function confirmDeleteClient() {
  if (!editingClientId) return;
  try {
    const delId = editingClientId;
    await api('/clients/' + delId, 'DELETE');
    closeModal('client-delete-modal');
    closeModal('client-modal');
    editingClientId = null;
    toastWithUndo('Cliente excluído.', () => api('/clients/' + delId + '/undelete', 'POST'));
    await refreshData();
    closeClientDetail();
  } catch (e) {
    toast(e.message || 'Erro ao excluir', 'error');
  }
}

/* Atalho: abrir modal de projeto já com o cliente atual pré-selecionado */
function openProjectModalForCurrentClient() {
  if (typeof openProjectModal === 'function') openProjectModal(null, currentClientId);
}

/* ─── AGENDA ────────────────────────────────────────────────────
   Planejamento semanal por usuário. Bloco = (userId, demandId, date,
   startMin, endMin). Grid renderizado como CSS Grid + blocos absolutos
   posicionados nas colunas de dia via `grid-column`. */
const AGENDA_DAY_START_MIN = 9 * 60;   // 09:00
const AGENDA_DAY_END_MIN   = 18 * 60;  // 18:00
const AGENDA_SLOT_MIN      = 15;       // 15min por linha (granularidade fina)
const AGENDA_SLOT_PX       = 22;       // px por slot — tabela alta o suficiente sem virar 2 telas
const AGENDA_LUNCH_MIN     = 12 * 60;  // 12:00–13:00 destacado
let agendaUserId = null;          // usuário filtrado (default = me)
let agendaWeekStart = null;       // segunda da semana atual visualizada
let agendaWeeks = 2;              // 1 ou 2 semanas lado a lado
let editingScheduleId = null;     // id do bloco sendo editado no modal
let _agendaDrag = null;           // estado interno de drag

function agendaWeekStartFor(d) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  const dow = x.getDay(); // 0=dom, 1=seg...
  const diff = (dow === 0 ? -6 : 1 - dow);
  x.setDate(x.getDate() + diff);
  return x;
}
function agendaYmd(d) {
  return d.toISOString().slice(0, 10);
}
function agendaMinsToHHMM(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function agendaHHMMtoMins(s) {
  const [h, m] = (s || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function agendaInit() {
  if (!agendaUserId) agendaUserId = me?.id || null;
  if (!agendaWeekStart) agendaWeekStart = agendaWeekStartFor(new Date());
}
function agendaPrevWeek() {
  agendaWeekStart.setDate(agendaWeekStart.getDate() - 7);
  renderAgenda();
}
function agendaNextWeek() {
  agendaWeekStart.setDate(agendaWeekStart.getDate() + 7);
  renderAgenda();
}
function agendaThisWeek() {
  agendaWeekStart = agendaWeekStartFor(new Date());
  renderAgenda();
}
function setAgendaView(n) {
  agendaWeeks = n === 1 ? 1 : 2;
  document.querySelectorAll('.agenda-view-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.view) === agendaWeeks));
  renderAgenda();
}
function onAgendaUserChange() {
  agendaUserId = $('agenda-user').value || null;
  renderAgenda();
}

/* Lista de dias úteis (seg-sex) no período visualizado */
function agendaDays() {
  agendaInit();
  const days = [];
  const totalDays = 7 * agendaWeeks;
  const base = new Date(agendaWeekStart);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    days.push(d);
  }
  return days;
}

/* Layout das colunas: insere uma "coluna gap" entre semanas 1 e 2 na view de 2.
   Retorna {cols, gridTemplate, dayColsCount} — cada `col` tem
   { type:'day'|'gap', gridCol:number, day?:Date, dayIdx?:number }. */
function agendaColumnsLayout() {
  const days = agendaDays();
  const cols = [];
  const tmpl = ['60px']; // coluna de tempo (HORÁRIO)
  let gridCol = 2;
  days.forEach((d, i) => {
    // Antes do 6º dia (segunda da semana 2) insere a divisória
    if (agendaWeeks === 2 && i === 5) {
      cols.push({ type: 'gap', gridCol });
      tmpl.push('14px');
      gridCol++;
    }
    cols.push({ type: 'day', day: d, dayIdx: i, gridCol });
    tmpl.push('minmax(110px, 1fr)');
    gridCol++;
  });
  return { cols, gridTemplate: tmpl.join(' '), days };
}

/* ─── GOOGLE EVENTS na agenda ─────────────────────────────────
   Cache por usuário — evita refetch a cada mudança de semana.
   Auto-refresh disparado por: entrar na agenda, sync manual, mudança de
   usuário no seletor. Se o usuário não conectou Google, cache fica vazio. */
let googleEventsForUser = {}; // { userId: [events] }
let _googleEventsFetchInFlight = {}; // { userId: Promise } — evita fetches duplicados

async function refreshGoogleEventsForUser(userId) {
  if (!userId) return [];
  if (_googleEventsFetchInFlight[userId]) return _googleEventsFetchInFlight[userId];
  const p = (async () => {
    try {
      const events = await api('/google/events?userId=' + encodeURIComponent(userId));
      googleEventsForUser[userId] = Array.isArray(events) ? events : [];
      // Re-render se estamos numa tela que mostra agenda.
      if (currentPage === 'agenda' || currentPage === 'mine') renderAgenda();
      return googleEventsForUser[userId];
    } catch (e) {
      // Falha silenciosa — se não conectou Google, endpoint devolve [] normal.
      // Erros de rede real ficam só no console.
      console.debug('[google] fetch events:', e.message);
      googleEventsForUser[userId] = [];
      return [];
    } finally {
      delete _googleEventsFetchInFlight[userId];
    }
  })();
  _googleEventsFetchInFlight[userId] = p;
  return p;
}

// Converte evento Google (start/end ISO) pro shape de bloco da agenda.
// Retorna null se o evento não cair no dia (ex: allDay, outro dia).
function googleEventToBlock(ev, dayYmd) {
  if (!ev || !ev.start) return null;
  if (ev.allDay) {
    // Eventos all-day não são renderizados na grade horária — decisão de MVP.
    // Podem ganhar uma faixa no topo depois.
    return null;
  }
  const startIso = ev.start;
  const endIso = ev.end || ev.start;
  const startYmd = startIso.slice(0, 10);
  const endYmd = endIso.slice(0, 10);
  // Filtra pra apenas o dia atual (multi-day: só o primeiro dia por enquanto)
  if (startYmd !== dayYmd) return null;
  const startDate = new Date(startIso);
  const endDate = new Date(endIso);
  const startMin = startDate.getHours() * 60 + startDate.getMinutes();
  // Se end for em outro dia, corta em 23:59
  const endMin = (endYmd === dayYmd)
    ? endDate.getHours() * 60 + endDate.getMinutes()
    : 24 * 60;
  return {
    kind: 'google',
    id: ev.id,
    startMin,
    endMin: Math.max(startMin + 15, endMin), // duração mínima visível
    summary: ev.summary || '(Sem título)',
    htmlLink: ev.htmlLink || null,
    backgroundColor: ev.backgroundColor || '#4285F4'
  };
}

// N-lane column layout — pra 2+ blocos que se sobrepõem no mesmo dia,
// atribui uma "coluna" a cada um sem overlap dentro dela. Retorna
// { assign: { blockId: colIdx }, totalCols }.
function computeLaneLayout(blocks) {
  const sorted = blocks.slice().sort((a, b) => a.startMin - b.startMin);
  const columns = []; // columns[i] = array de blocos naquela coluna
  const assign = {};
  for (const b of sorted) {
    let placedCol = -1;
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const conflict = col.some(x => !(x.endMin <= b.startMin || x.startMin >= b.endMin));
      if (!conflict) { col.push(b); placedCol = i; break; }
    }
    if (placedCol < 0) { columns.push([b]); placedCol = columns.length - 1; }
    assign[b.id] = placedCol;
  }
  return { assign, totalCols: columns.length };
}

function renderAgenda() {
  agendaInit();
  // Popula select de usuários (só na página standalone /agenda)
  const sel = $('agenda-user');
  if (sel) {
    const wsU = wsUsers().slice().sort((a,b) => norm(a.name).localeCompare(norm(b.name)));
    sel.innerHTML = wsU.map(u =>
      `<option value="${u.id}" ${u.id === agendaUserId ? 'selected' : ''}>${esc(u.name)}${u.id === me.id ? ' (você)' : ''}</option>`
    ).join('');
    if (!sel.value && wsU[0]) { agendaUserId = wsU[0].id; sel.value = agendaUserId; }
  }
  // Renderiza nos dois alvos possíveis — standalone (Agenda) e embed (Minhas Demandas)
  renderAgendaInto('agenda-grid-wrap', 'agenda-week-label', agendaUserId);
  renderAgendaInto('mine-agenda-grid-wrap', 'mine-agenda-week-label', me?.id || null);
}

function renderAgendaInto(wrapId, weekLabelId, userId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return; // página não montada nesse momento
  const days = agendaDays();
  const first = days[0], last = days[days.length - 1];
  const wkLabel = document.getElementById(weekLabelId);
  if (wkLabel && first && last) {
    const fmt = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    wkLabel.textContent = `${fmt(first)} → ${fmt(last)}`;
  }
  if (!userId) { wrap.innerHTML = '<div class="agenda-empty">Sem usuário pra exibir.</div>'; return; }
  buildAgendaGrid(wrap, userId, days);
}

function buildAgendaGrid(wrap, agendaUserIdLocal, days) {
  if (!agendaUserIdLocal) { wrap.innerHTML = '<div class="agenda-empty">Selecione um usuário pra ver a agenda.</div>'; return; }

  const slotsPerDay = Math.ceil((AGENDA_DAY_END_MIN - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN);
  const rows = slotsPerDay;
  const layout = agendaColumnsLayout();
  const dayCols = layout.cols.filter(c => c.type === 'day');

  const grid = document.createElement('div');
  grid.className = 'agenda-grid';
  grid.style.gridTemplateColumns = layout.gridTemplate;
  grid.style.gridTemplateRows = `auto repeat(${rows}, ${AGENDA_SLOT_PX}px)`;
  grid.style.width = '100%';
  // O grid carrega o userId alvo no dataset pra que handlers de drag/click
  // (que podem ser de qualquer instância: standalone OU embed em Minhas Demandas)
  // saibam pra quem agendar/editar — sem depender da variável global agendaUserId.
  grid.dataset.userId = agendaUserIdLocal;

  // Canto (0,0)
  const corner = document.createElement('div');
  corner.className = 'agenda-corner';
  corner.style.gridRow = '1 / 2';
  corner.style.gridColumn = '1 / 2';
  grid.appendChild(corner);

  const todayYmd = agendaYmd(new Date());
  // Headers da linha 1 — itera sobre todas as colunas (day + gap)
  layout.cols.forEach(c => {
    if (c.type === 'gap') {
      const gapHead = document.createElement('div');
      gapHead.className = 'agenda-cell is-day-header is-week-gap';
      gapHead.style.gridRow = '1 / 2';
      gapHead.style.gridColumn = `${c.gridCol} / ${c.gridCol + 1}`;
      grid.appendChild(gapHead);
      return;
    }
    const d = c.day;
    const head = document.createElement('div');
    head.className = 'agenda-cell is-day-header';
    if (agendaYmd(d) === todayYmd) head.classList.add('is-today');
    const dayName = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '').toUpperCase();
    const dayDate = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const dayMin = schedules
      .filter(s => s.userId === agendaUserIdLocal && s.date === agendaYmd(d))
      .reduce((sum, s) => sum + (s.endMin - s.startMin), 0);
    const dayHours = dayMin / 60;
    const capacityH = 8;
    let capClass = '';
    if (dayHours > capacityH) capClass = 'over';
    else if (dayHours > capacityH * 0.85) capClass = 'high';
    const capLabel = `${dayHours.toFixed(1).replace('.', ',')}h / ${capacityH}h`;
    head.innerHTML = `<span>${esc(dayName)}</span><span class="day-date">${esc(dayDate)}</span><span class="day-cap ${capClass}">${esc(capLabel)}</span>`;
    head.style.gridRow = '1 / 2';
    head.style.gridColumn = `${c.gridCol} / ${c.gridCol + 1}`;
    grid.appendChild(head);
  });

  // Linhas de horário + células. Granularidade 15min, mas só o :00 mostra label.
  // Marcação fina: :30 ganha linha mais clara, demais ficam sutis.
  for (let r = 0; r < rows; r++) {
    const min = AGENDA_DAY_START_MIN + r * AGENDA_SLOT_MIN;
    const onHour = (min % 60) === 0;
    const onHalf = (min % 60) === 30;
    const t = document.createElement('div');
    t.className = 'agenda-cell is-time';
    if (onHour) t.textContent = agendaMinsToHHMM(min);
    t.style.gridRow = `${r + 2} / ${r + 3}`;
    t.style.gridColumn = '1 / 2';
    grid.appendChild(t);

    layout.cols.forEach(c => {
      const cell = document.createElement('div');
      cell.className = 'agenda-cell';
      if (c.type === 'gap') cell.classList.add('is-week-gap');
      if (onHour) cell.classList.add('is-hour'); else if (onHalf) cell.classList.add('is-half-hour');
      if (min >= AGENDA_LUNCH_MIN && min < AGENDA_LUNCH_MIN + 60) cell.classList.add('is-lunch');
      cell.style.gridRow = `${r + 2} / ${r + 3}`;
      cell.style.gridColumn = `${c.gridCol} / ${c.gridCol + 1}`;
      if (c.type === 'day') {
        cell.dataset.date = agendaYmd(c.day);
        cell.dataset.min = String(min);
        cell.addEventListener('mousedown', onAgendaCellMouseDown);
      }
      grid.appendChild(cell);
    });
  }

  // Blocos por cima. Antes de renderizar, computamos o "lane layout" por dia
  // pra que schedules + google events sobrepostos fiquem lado a lado ao invés
  // de empilhados. Cada dia é isolado dos outros no layout.
  const userSchedules = schedules.filter(s => s.userId === agendaUserIdLocal);
  const userGoogleEvents = (googleEventsForUser[agendaUserIdLocal] || []);

  const dayLayouts = {}; // { ymd: { assign, totalCols } }
  dayCols.forEach(c => {
    const ymd = agendaYmd(c.day);
    const daySchedules = userSchedules.filter(s => s.date === ymd).map(s => ({
      id: 'sched:' + s.id, startMin: s.startMin, endMin: s.endMin, kind: 'sched', ref: s
    }));
    const dayGoogles = userGoogleEvents
      .map(ev => googleEventToBlock(ev, ymd))
      .filter(Boolean)
      .map(b => ({ ...b, id: 'gcal:' + b.id, kind: 'google', ref: b }));
    dayLayouts[ymd] = computeLaneLayout([...daySchedules, ...dayGoogles]);
  });

  // Helper: converte col/totalCols → width%/left% inline pra bloco absoluto.
  const laneStyle = (col, totalCols) => {
    if (totalCols <= 1) return '';
    const w = 100 / totalCols;
    return `left: ${(col * w).toFixed(3)}%; width: calc(${w.toFixed(3)}% - 4px);`;
  };

  userSchedules.forEach(s => {
    const dayCol = dayCols.find(c => agendaYmd(c.day) === s.date);
    if (!dayCol) return;
    const startRow = Math.max(0, Math.floor((s.startMin - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN));
    const endRow = Math.min(rows, Math.ceil((s.endMin - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN));
    if (endRow <= startRow) return;
    const demand = demands.find(x => x.id === s.demandId);
    const project = demand ? projects.find(p => p.id === demand.projectId) : null;
    const client = project && project.clientId ? clients.find(c => c.id === project.clientId) : null;
    // Prioridade: snapshot da cor da etapa NO MOMENTO da criação do bloco →
    // cor do projeto → fallback. Assim o bloco "guarda" o estado planejado
    // mesmo se a demanda avançar de etapa depois.
    const color = s.stageColorSnapshot || project?.color || '#7A00FF';
    const layout = dayLayouts[s.date];
    const myCol = layout ? layout.assign['sched:' + s.id] : 0;
    const totalCols = layout ? layout.totalCols : 1;
    const block = document.createElement('div');
    block.className = 'agenda-block';
    if (totalCols > 1) block.classList.add('is-laned');
    block.dataset.scheduleId = s.id;
    block.style.gridRow = `${startRow + 2} / ${endRow + 2}`;
    block.style.gridColumn = `${dayCol.gridCol} / ${dayCol.gridCol + 1}`;
    if (totalCols > 1) block.style.cssText += laneStyle(myCol, totalCols);
    block.style.background = color;
    const projName = project ? project.name : '';
    const clientName = client ? client.name : '';
    const demandName = demand ? demand.name : '(demanda removida)';
    const canEdit = !!(me && (me.isAdmin || s.userId === me.id));
    const actions = canEdit ? `
      <div class="agenda-block-actions">
        <button class="agenda-block-action" title="Editar" data-action="edit"><i data-lucide="pencil" class="ic-xs"></i></button>
        <button class="agenda-block-action danger" title="Excluir" data-action="delete"><i data-lucide="x" class="ic-xs"></i></button>
      </div>` : '';
    // Linha de cliente · projeto (ou só um deles se faltar)
    const meta = [clientName, projName].filter(Boolean).join(' · ');
    block.innerHTML = `
      ${actions}
      <div class="agenda-block-name">${esc(demandName)}</div>
      ${meta ? `<div class="agenda-block-project">${esc(meta)}</div>` : ''}
      ${canEdit ? '<div class="agenda-block-resize" data-resize="1"></div>' : ''}`;
    block.addEventListener('mousedown', (e) => {
      // Cliques nos botões de ação não disparam drag — tratados via click
      if (e.target.closest('[data-action]')) return;
      onAgendaBlockMouseDown(e, s, canEdit);
    });
    block.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        if (actionBtn.dataset.action === 'edit') openScheduleModal(s.id);
        else if (actionBtn.dataset.action === 'delete') confirmDeleteSchedule(s.id);
        return;
      }
      if (!_agendaDrag || !_agendaDrag.moved) {
        if (demand) showDetail(demand.id);
      }
    });
    grid.appendChild(block);
  });

  // Google Calendar events — blocos read-only, azuis, sem drag/resize.
  // Clique abre modal enxuto com título + link "Abrir no Google Calendar".
  dayCols.forEach(c => {
    const ymd = agendaYmd(c.day);
    const layout = dayLayouts[ymd];
    if (!layout) return;
    const dayEvents = userGoogleEvents
      .map(ev => googleEventToBlock(ev, ymd))
      .filter(Boolean);
    dayEvents.forEach(gb => {
      const startRow = Math.max(0, Math.floor((gb.startMin - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN));
      const endRow = Math.min(rows, Math.ceil((gb.endMin - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN));
      if (endRow <= startRow) return;
      const laneId = 'gcal:' + gb.id;
      const myCol = layout.assign[laneId] ?? 0;
      const totalCols = layout.totalCols;
      const block = document.createElement('div');
      block.className = 'agenda-block agenda-block--google';
      if (totalCols > 1) block.classList.add('is-laned');
      block.style.gridRow = `${startRow + 2} / ${endRow + 2}`;
      block.style.gridColumn = `${c.gridCol} / ${c.gridCol + 1}`;
      if (totalCols > 1) block.style.cssText += laneStyle(myCol, totalCols);
      block.style.background = gb.backgroundColor || '#4285F4';
      block.innerHTML = `
        <div class="agenda-block-name">
          <svg class="agenda-block-google-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4">
            <rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>
          </svg>
          <span>${esc(gb.summary)}</span>
        </div>`;
      block.addEventListener('click', () => openGoogleEventDetail(gb));
      grid.appendChild(block);
    });
  });

  wrap.innerHTML = '';
  wrap.appendChild(grid);
  paintIcons();

  // Se ainda sem cache de eventos, dispara fetch async. O backend devolve []
  // se o usuário-alvo não tem Google conectado, então não custa nada tentar.
  // Re-render acontece dentro de refreshGoogleEventsForUser quando termina.
  if (!googleEventsForUser[agendaUserIdLocal]) {
    refreshGoogleEventsForUser(agendaUserIdLocal);
  }
}

// Modal enxuto pro evento Google — título + horário + botão "Abrir no Google Calendar".
// Cria o overlay on-demand pra não poluir o HTML com mais um modal fixo.
function openGoogleEventDetail(gb) {
  const startHH = String(Math.floor(gb.startMin / 60)).padStart(2, '0');
  const startMM = String(gb.startMin % 60).padStart(2, '0');
  const endHH = String(Math.floor(gb.endMin / 60)).padStart(2, '0');
  const endMM = String(gb.endMin % 60).padStart(2, '0');
  const timeLabel = `${startHH}:${startMM} — ${endHH}:${endMM}`;
  let modal = document.getElementById('gcal-event-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'gcal-event-modal';
    modal.className = 'modal-overlay';
    // Sem data-no-outside-close: o handler global de outside-click cuida do fechar.
    modal.innerHTML = `
      <div class="modal modal-sm">
        <div class="modal-body">
          <div class="gcal-modal-badge">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4">
              <rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>
            </svg>
            <span>Evento do Google Calendar</span>
          </div>
          <div class="gcal-modal-title" id="gcal-modal-title"></div>
          <div class="gcal-modal-time" id="gcal-modal-time"></div>
        </div>
        <div class="modal-footer" style="justify-content:space-between">
          <button class="btn btn-ghost" onclick="closeModal('gcal-event-modal')">Fechar</button>
          <a class="btn btn-primary" id="gcal-modal-link" target="_blank" rel="noopener">
            <i data-lucide="external-link" class="ic-sm"></i> Abrir no Google Calendar
          </a>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  $('gcal-modal-title').textContent = gb.summary;
  $('gcal-modal-time').textContent = timeLabel;
  const linkEl = $('gcal-modal-link');
  if (gb.htmlLink) {
    linkEl.href = gb.htmlLink;
    linkEl.style.display = '';
  } else {
    linkEl.style.display = 'none';
  }
  openModal('gcal-event-modal');
  paintIcons();
}

async function confirmDeleteSchedule(id) {
  const ok = await showConfirm({
    title: 'Excluir bloco',
    message: 'Remover esse bloco da agenda?',
    okLabel: 'Excluir',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/schedules/' + id, 'DELETE');
    schedules = await api('/schedules');
    renderAgenda();
  } catch (e) { toast(e.message, 'error'); }
}
async function deleteScheduleFromModal() {
  if (!editingScheduleId) return;
  try {
    await api('/schedules/' + editingScheduleId, 'DELETE');
    schedules = await api('/schedules');
    closeModal('schedule-modal');
    renderAgenda();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Drag-to-create ──
   mousedown numa célula vazia, mousemove pinta ghost, mouseup abre modal. */
function onAgendaCellMouseDown(e) {
  if (e.button !== 0) return;
  const cell = e.currentTarget;
  const grid = cell.closest('.agenda-grid');
  const targetUserId = grid?.dataset.userId || agendaUserId;
  if (me && !me.isAdmin && targetUserId !== me.id) return;
  e.preventDefault();
  const date = cell.dataset.date;
  const startMin = Number(cell.dataset.min);
  _agendaDrag = { mode: 'create', date, startRow: startMin, endRow: startMin + AGENDA_SLOT_MIN, ghost: null, moved: false, targetUserId, grid };
  document.addEventListener('mousemove', onAgendaCreateMove);
  document.addEventListener('mouseup', onAgendaCreateUp, { once: true });
  const ghost = document.createElement('div');
  ghost.className = 'agenda-ghost';
  ghost.style.gridColumn = cell.style.gridColumn;
  ghost.style.gridRow = cell.style.gridRow;
  grid.appendChild(ghost);
  _agendaDrag.ghost = ghost;
  _agendaDrag.ghostCol = cell.style.gridColumn;
}
function onAgendaCreateMove(e) {
  if (!_agendaDrag || _agendaDrag.mode !== 'create') return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;
  const cell = el.classList && el.classList.contains('agenda-cell') ? el : el.closest('.agenda-cell');
  if (!cell || !cell.dataset.min || cell.dataset.date !== _agendaDrag.date) return;
  _agendaDrag.moved = true;
  const cur = Number(cell.dataset.min) + AGENDA_SLOT_MIN;
  _agendaDrag.endRow = Math.max(_agendaDrag.startRow + AGENDA_SLOT_MIN, cur);
  const startRowIdx = Math.floor((_agendaDrag.startRow - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN) + 2;
  const endRowIdx = Math.ceil((_agendaDrag.endRow - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN) + 2;
  _agendaDrag.ghost.style.gridRow = `${startRowIdx} / ${endRowIdx}`;
}
function onAgendaCreateUp() {
  document.removeEventListener('mousemove', onAgendaCreateMove);
  if (_agendaDrag && _agendaDrag.ghost && _agendaDrag.ghost.parentNode) {
    _agendaDrag.ghost.parentNode.removeChild(_agendaDrag.ghost);
  }
  if (_agendaDrag) {
    openScheduleModal(null, { date: _agendaDrag.date, startMin: _agendaDrag.startRow, endMin: _agendaDrag.endRow, userId: _agendaDrag.targetUserId || agendaUserId });
  }
  _agendaDrag = null;
}

/* ── Drag-to-move + drag-to-resize ──
   mousedown num bloco existente → ou move (corpo) ou resize (borda inferior).
   Em move: ghost segue cursor e ancora em cell mais próxima.
   Em resize: ajusta só o endMin. */
function onAgendaBlockMouseDown(e, schedule, canEdit) {
  if (!canEdit) return;
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const isResize = !!(e.target.dataset && e.target.dataset.resize);
  const block = e.currentTarget;
  _agendaDrag = {
    mode: isResize ? 'resize' : 'move',
    scheduleId: schedule.id,
    origDate: schedule.date,
    origStart: schedule.startMin,
    origEnd: schedule.endMin,
    origGridRow: block.style.gridRow,
    origGridColumn: block.style.gridColumn,
    block,
    ghost: null,
    moved: false
  };
  block.classList.add('dragging');
  // Ghost card: só faz sentido pra mover (o resize é preview no próprio bloco).
  // Clona o bloco pra que o ghost tenha exatamente o mesmo visual, com styles
  // do drag-ghost por cima (opacity/outline).
  if (!isResize) {
    const ghost = block.cloneNode(true);
    ghost.classList.add('agenda-block-ghost');
    ghost.classList.remove('dragging');
    ghost.removeAttribute('data-schedule-id');
    // Remove interações do ghost — ele é só visual.
    ghost.style.pointerEvents = 'none';
    block.parentElement.appendChild(ghost);
    _agendaDrag.ghost = ghost;
  }
  document.addEventListener('mousemove', onAgendaBlockMove);
  document.addEventListener('mouseup', onAgendaBlockUp, { once: true });
}
function onAgendaBlockMove(e) {
  if (!_agendaDrag) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;
  const cell = el.classList && el.classList.contains('agenda-cell') ? el : el.closest('.agenda-cell');
  if (!cell || !cell.dataset.min || !cell.dataset.date) return; // ignora células de gap
  const min = Number(cell.dataset.min);
  if (_agendaDrag.mode === 'move') {
    const duration = _agendaDrag.origEnd - _agendaDrag.origStart;
    _agendaDrag.newDate = cell.dataset.date;
    _agendaDrag.newStart = min;
    _agendaDrag.newEnd = Math.min(AGENDA_DAY_END_MIN, min + duration);
    _agendaDrag.moved = true;
    // Bloco original fica onde está (com .dragging aplicando opacity).
    // O ghost é que segue o cursor com preview da posição alvo.
    const startRowIdx = Math.floor((_agendaDrag.newStart - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN) + 2;
    const endRowIdx = Math.ceil((_agendaDrag.newEnd - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN) + 2;
    if (_agendaDrag.ghost) {
      _agendaDrag.ghost.style.gridRow = `${startRowIdx} / ${endRowIdx}`;
      _agendaDrag.ghost.style.gridColumn = cell.style.gridColumn;
    }
  } else { // resize — sem ghost, preview no próprio bloco
    const newEnd = Math.max(_agendaDrag.origStart + AGENDA_SLOT_MIN, min + AGENDA_SLOT_MIN);
    if (newEnd === _agendaDrag.newEnd) return;
    _agendaDrag.newEnd = Math.min(AGENDA_DAY_END_MIN, newEnd);
    _agendaDrag.moved = true;
    const startRowIdx = Math.floor((_agendaDrag.origStart - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN) + 2;
    const endRowIdx = Math.ceil((_agendaDrag.newEnd - AGENDA_DAY_START_MIN) / AGENDA_SLOT_MIN) + 2;
    _agendaDrag.block.style.gridRow = `${startRowIdx} / ${endRowIdx}`;
  }
}
async function onAgendaBlockUp() {
  document.removeEventListener('mousemove', onAgendaBlockMove);
  if (!_agendaDrag) return;
  const drag = _agendaDrag;
  drag.block.classList.remove('dragging');
  if (drag.ghost && drag.ghost.parentElement) drag.ghost.parentElement.removeChild(drag.ghost);
  _agendaDrag = null;
  if (!drag.moved) return; // click puro, deixa o click handler abrir o detalhe
  const payload = {};
  if (drag.mode === 'move') {
    payload.date = drag.newDate;
    payload.startMin = drag.newStart;
    payload.endMin = drag.newEnd;
  } else {
    payload.endMin = drag.newEnd;
  }
  console.log('[agenda drag]', drag.mode, 'schedule:', drag.scheduleId, 'payload:', payload);
  try {
    await api('/schedules/' + drag.scheduleId, 'PUT', payload);
    schedules = await api('/schedules'); // refetch sempre — fonte da verdade é o backend
    renderAgenda();
  } catch (e) {
    console.error('[agenda drag] PUT falhou:', e);
    toast(e.message || 'Erro ao mover/redimensionar', 'error');
    renderAgenda();
  }
}

/* ── Modal de agendar/editar bloco ── */
let _schedulePresetUserId = null; // userId do contexto de criação
function openScheduleModal(id, preset) {
  editingScheduleId = id || null;
  _schedulePresetUserId = preset?.userId || null;
  const s = id ? schedules.find(x => x.id === id) : null;
  $('schedule-modal-title').textContent = s ? 'Editar bloco' : 'Agendar bloco';
  // Popula select de demandas — SÓ demandas atribuídas ao usuário selecionado,
  // ativas no workspace acessível. Em modo edição, mantém a demanda atual
  // mesmo que não esteja mais atribuída a esse user.
  const sel = $('sch-demand');
  const wsId = activeWs;
  const ownerUid = s ? s.userId : (preset?.userId || agendaUserId);
  let list = demands
    .filter(d => d.workspaceId === wsId)
    .filter(d => d.ownerId === ownerUid)
    .sort((a,b) => norm(a.name).localeCompare(norm(b.name)));
  // Se editando e a demanda atual não está mais no usuário, força ela na lista
  if (s && !list.some(d => d.id === s.demandId)) {
    const cur = demands.find(d => d.id === s.demandId);
    if (cur) list.unshift(cur);
  }
  const currentDemandId = s ? s.demandId : '';
  if (!list.length) {
    sel.innerHTML = '<option value="">— Esse usuário não tem demandas atribuídas —</option>';
  } else {
    sel.innerHTML = '<option value="">— Selecione uma demanda —</option>' + list.map(d => {
      const p = projects.find(pp => pp.id === d.projectId);
      const c = p && p.clientId ? clients.find(cc => cc.id === p.clientId) : null;
      const meta = [c?.name, p?.name].filter(Boolean).join(' · ');
      const lbl = meta ? `${d.name} — ${meta}` : d.name;
      return `<option value="${d.id}" ${d.id === currentDemandId ? 'selected' : ''}>${esc(lbl)}</option>`;
    }).join('');
  }
  const date = (s ? s.date : preset?.date) || agendaYmd(new Date());
  const startMin = s ? s.startMin : (preset?.startMin || AGENDA_DAY_START_MIN);
  const endMin = s ? s.endMin : (preset?.endMin || (startMin + 60));
  $('sch-date').value = date;
  $('sch-start').value = agendaMinsToHHMM(startMin);
  $('sch-end').value = agendaMinsToHHMM(endMin);
  // "Quando" texto amigável
  const userName = userById(s ? s.userId : (preset?.userId || agendaUserId))?.name || '—';
  $('sch-when').textContent = `Para ${userName}`;
  $('sch-delete-btn').style.display = s ? '' : 'none';
  openModal('schedule-modal');
}
async function saveSchedule() {
  const demandId = $('sch-demand').value;
  if (!demandId) { toast('Selecione uma demanda.', 'error'); return; }
  const date = $('sch-date').value;
  const startMin = agendaHHMMtoMins($('sch-start').value);
  const endMin = agendaHHMMtoMins($('sch-end').value);
  if (endMin <= startMin) { toast('Horário final precisa ser depois do início.', 'error'); return; }
  const payload = { demandId, date, startMin, endMin };
  // Pra criar (não-edição), respeita o usuário do contexto: o `_schedulePresetUserId`
  // é setado pelo openScheduleModal a partir do preset (drag em qualquer instância).
  if (!editingScheduleId) payload.userId = _schedulePresetUserId || agendaUserId;
  console.log('[saveSchedule] payload:', payload, 'editingId:', editingScheduleId);
  try {
    if (editingScheduleId) {
      await api('/schedules/' + editingScheduleId, 'PUT', payload);
    } else {
      await api('/schedules', 'POST', payload);
    }
    // Refetch do servidor — garante que o frontend mostra exatamente o que está
    // persistido (sem depender de splice/push manual no array local).
    schedules = await api('/schedules');
    closeModal('schedule-modal');
    renderAgenda();
  } catch (e) {
    console.error('[saveSchedule] falhou:', e);
    toast(e.message || 'Erro ao salvar', 'error');
  }
}

/* ─── REAL-TIME SYNC (Server-Sent Events) ───────────────────────
   EventSource conecta em /api/stream e recebe eventos sempre que
   outro usuário muda algo no workspace acessível. Cada evento dispara
   refetch da entidade afetada + re-render da página corrente.
   Reconexão automática é nativa do EventSource — só tratamos o
   fechamento explícito (logout).
   Debounce: várias mudanças em rajada (ex.: bulk) viram 1 refetch. */
let sseConnection = null;
let _sseEvents = []; // fila de eventos crus pra flush em janela curta
let _sseRefetchTimer = null;

// Mapa entity → { arr: nome da variável global (só pra doc), refetchList: () => Promise, singularPath: (id) => string }
const SSE_ENTITY_MAP = {
  demand:    { get: () => demands,     set: v => { demands = v; },     path: id => '/demands/' + id,    listPath: '/demands' },
  schedule:  { get: () => schedules,   set: v => { schedules = v; },   path: id => '/schedules/' + id,  listPath: '/schedules' },
  client:    { get: () => clients,     set: v => { clients = v; },     path: id => '/clients/' + id,    listPath: '/clients' },
  project:   { get: () => projects,    set: v => { projects = v; },    path: id => '/projects/' + id,   listPath: '/projects' },
  flow:      { get: () => flows,       set: v => { flows = v; },       path: id => '/flows/' + id,      listPath: '/flows' },
  recurring: { get: () => recurrings,  set: v => { recurrings = v; },  path: id => '/recurrings/' + id, listPath: '/recurrings' },
  lista:     { get: () => listas,      set: v => { listas = v; },      path: id => '/listas/' + id,     listPath: '/listas' },
};

function startRealtimeSync() {
  if (sseConnection) return; // já conectado
  try {
    sseConnection = new EventSource('/api/stream');
    sseConnection.addEventListener('message', onSseMessage);
    sseConnection.addEventListener('error', () => {
      // Browser tenta reconectar sozinho. Só logamos pra debug.
      console.debug('[sse] error / reconnecting...');
    });
  } catch (e) {
    console.warn('[sse] não foi possível conectar:', e);
  }
}

function stopRealtimeSync() {
  if (!sseConnection) return;
  sseConnection.close();
  sseConnection = null;
}

function onSseMessage(ev) {
  let data; try { data = JSON.parse(ev.data); } catch { return; }
  if (!data || !data.entity) return;
  _sseEvents.push(data);
  clearTimeout(_sseRefetchTimer);
  _sseRefetchTimer = setTimeout(flushSseRefetch, 250);
}

/* Aplicação granular:
   - op=delete   → remove local (sem network)
   - op=create/update com id → GET singular → substitui/adiciona no array
   - op=bulk ou sem id → refetch lista inteira (fallback)
   Coalesce: eventos com mesmo entity+id em janela curta são deduplicados. */
async function flushSseRefetch() {
  const events = _sseEvents.slice();
  _sseEvents.length = 0;
  // Dedup — última operação por (entity,id) vence
  const dedup = new Map();
  const fullRefetch = new Set(); // entities que precisam refetch da lista inteira
  let demandTouched = false;
  for (const e of events) {
    if (e.entity === 'demand') demandTouched = true;
    const spec = SSE_ENTITY_MAP[e.entity];
    if (!spec) continue;
    if (!e.id || e.op === 'bulk') { fullRefetch.add(e.entity); continue; }
    dedup.set(e.entity + ':' + e.id, e);
  }
  const tasks = [];
  // 1) Refetches em lote (fallback pra bulk/sem-id)
  for (const entity of fullRefetch) {
    const spec = SSE_ENTITY_MAP[entity];
    tasks.push(api(spec.listPath).then(v => spec.set(v)).catch(() => {}));
  }
  // 2) Operações granulares
  for (const e of dedup.values()) {
    const spec = SSE_ENTITY_MAP[e.entity];
    if (e.op === 'delete') {
      spec.set(spec.get().filter(x => x.id !== e.id));
    } else {
      tasks.push(
        api(spec.path(e.id))
          .then(entity => {
            const arr = spec.get();
            const idx = arr.findIndex(x => x.id === e.id);
            if (idx >= 0) arr[idx] = entity;
            else arr.push(entity);
            spec.set(arr);
          })
          .catch(err => {
            // Se o GET singular deu 404 (perdeu acesso ao workspace, por ex.), tira da lista local
            if (String(err.message || '').match(/não encontrad/i)) {
              spec.set(spec.get().filter(x => x.id !== e.id));
            }
          })
      );
    }
  }
  await Promise.all(tasks);
  renderCurrent();
  if (demandTouched && detailId && document.getElementById('detail-modal')?.classList.contains('open')) {
    refreshDetailDemand();
  }
}

/* ─── TOOLTIPS CUSTOMIZADOS ──────────────────────────────────
   Substitui o tooltip nativo do browser (que vem de title="") por uma camada
   estilizada com fade-in. Funciona pra QUALQUER elemento com title= no DOM,
   inclusive os adicionados dinamicamente. Suprime o nativo movendo o atributo
   pra data-ktip e removendo title em hover. */
(function setupCustomTooltips() {
  const tipEl = document.createElement('div');
  tipEl.className = 'k-tooltip';
  document.body.appendChild(tipEl);
  let showTimer = null;
  let activeTarget = null;

  function getTipText(el) {
    return el.getAttribute('data-ktip') || el.getAttribute('title') || '';
  }

  function positionTip(el) {
    const r = el.getBoundingClientRect();
    tipEl.style.left = (r.left + r.width / 2) + 'px';
    tipEl.style.top = r.top + 'px';
  }

  function showFor(el) {
    const text = getTipText(el);
    if (!text) return;
    // Move title pra data-ktip pra suprimir o nativo
    if (el.hasAttribute('title')) {
      el.setAttribute('data-ktip', el.getAttribute('title'));
      el.removeAttribute('title');
    }
    tipEl.textContent = text;
    positionTip(el);
    tipEl.classList.add('show');
  }
  function hide() {
    tipEl.classList.remove('show');
    activeTarget = null;
  }

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[title], [data-ktip]');
    if (!t || t === activeTarget) return;
    // Ignora pickers complexos onde o título é parte da UX (ex.: nada por enquanto)
    activeTarget = t;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showFor(t), 280); // delay tipo macOS
  }, true);
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[title], [data-ktip]');
    if (!t) return;
    clearTimeout(showTimer);
    if (t === activeTarget) hide();
  }, true);
  document.addEventListener('scroll', () => { clearTimeout(showTimer); hide(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearTimeout(showTimer); hide(); } });
})();

/* ─── LOADING STATE EM BOTÕES ─────────────────────────────────
   Helper: chame com um event ou um button + asyncFn. Aplica .is-loading
   (CSS já tem regra com spinner) e disabled enquanto roda, restaura no fim. */
async function withLoading(eventOrBtn, asyncFn) {
  const btn = (eventOrBtn && eventOrBtn.currentTarget) || (eventOrBtn instanceof Element ? eventOrBtn : null);
  if (!btn) return asyncFn();
  btn.disabled = true;
  btn.classList.add('is-loading');
  try { return await asyncFn(); }
  finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

/* ─── WIZARD DA NOVA DEMANDA ─────────────────────────────────────
   4 steps: Cliente → Projeto → Fluxo → Form. Click 1x seleciona um card,
   click duplo avança. Footer mostra Voltar/Avançar (steps 1-3) ou
   Voltar/Salvar como template/Criar demanda (step 4). Editar pula direto
   pro step 4 com seleção pré-preenchida. */
let wizardState = { step: 1, clientId: null, projectId: null, flowId: null };
// Último fluxo cujos defaults (descrição + checklist) já foram aplicados no form.
// Permite re-aplicar quando o usuário troca de fluxo no wizard sem perder edições
// quando ele volta e re-seleciona o MESMO fluxo.
let wizardLastFlowApplied = null;

/* Sequência do wizard: 1 (cliente) → 2 (projeto) → 3 (fluxo) → 'cust' (customizar
   etapas por instância — pular na edição) → 4 (detalhes finais). O step 'cust' é
   novo e opcional na prática — o usuário pode só apertar "Avançar" sem tocar. */
const WIZARD_STEPS = [1, 2, 3, 'cust', 4];
function wizardStepIndex(s) { return WIZARD_STEPS.indexOf(s); }

function wizardGoTo(n) {
  wizardState.step = n;
  // Mostra só o step ativo
  WIZARD_STEPS.forEach(s => {
    const el = document.getElementById('dw-step-' + s);
    if (el) el.style.display = (s === n ? '' : 'none');
  });
  // Footer dinâmico
  const back = $('dw-back-btn');
  const next = $('dw-next-btn');
  const create = $('dw-create-btn');
  const tpl = $('save-as-template-btn');
  const isFinal = (n === 4);
  const idx = wizardStepIndex(n);
  // Voltar: oculto no step 1 (na criação) e em modo edição (não tem wizard).
  if (back) back.style.display = (idx > 0 && !editingId) ? '' : 'none';
  if (next) next.style.display = isFinal ? 'none' : '';
  if (create) create.style.display = isFinal ? '' : 'none';
  if (create) create.textContent = editingId ? 'Salvar Demanda' : 'Criar demanda';
  if (tpl) tpl.style.display = isFinal ? '' : 'none';
  // Render do step ativo
  if (n === 1) renderWizardClients();
  else if (n === 2) renderWizardProjects();
  else if (n === 3) renderWizardFlows();
  else if (n === 'cust') renderWizardCustomization();
  else if (n === 4) renderWizardStep4();
  updateWizardNextEnabled();
  paintIcons();
}

function wizardBack() {
  const idx = wizardStepIndex(wizardState.step);
  if (idx <= 0) return;
  wizardGoTo(WIZARD_STEPS[idx - 1]);
}
function wizardNext() {
  const idx = wizardStepIndex(wizardState.step);
  if (idx < 0 || idx >= WIZARD_STEPS.length - 1) return;
  wizardGoTo(WIZARD_STEPS[idx + 1]);
}
function updateWizardNextEnabled() {
  const btn = $('dw-next-btn');
  if (!btn) return;
  let ok = true; // cust e 4 sempre dá pra prosseguir
  if (wizardState.step === 1) ok = !!wizardState.clientId;
  else if (wizardState.step === 2) ok = !!wizardState.projectId;
  else if (wizardState.step === 3) ok = !!wizardState.flowId;
  btn.disabled = !ok;
}

/* Estado da customização inicial. Reset a cada abertura do wizard.
   Estrutura reflete o que o backend aceita em /api/demands (POST):
     skippedStages: [stageId]
     stageResponsibles: { stageId: userId | null }
     stageLabels: { stageId: 'nome custom' }
     stageOverrides: { stageId: { color?, deadlineDays?, done? } }  ← override de etapas ORIGINAIS
     stageAdditions: [{ id, label, color, deadlineDays, responsibleId, done }]
     stageOrder: [stageId]  ← inclui originais + adicionadas na ordem final */
function resetWizardCustomization() {
  wizardState.customization = {
    skippedStages: [], stageResponsibles: {}, stageLabels: {},
    stageOverrides: {}, stageAdditions: [], stageOrder: null
  };
}
/* Aplica valor efetivo de uma etapa considerando origem + overrides. Usado
   pra renderizar o valor "atual" mesmo pras originais que sofreram override. */
function _custEffectiveStageValue(stage, isAddition, field) {
  if (isAddition) return stage[field];
  const ov = wizardState.customization.stageOverrides[stage.id];
  if (ov && ov[field] !== undefined) return ov[field];
  return stage[field];
}
function renderWizardCustomization() {
  const wrap = $('dw-cust-list');
  if (!wrap) return;
  const flow = flowById(wizardState.flowId);
  if (!flow) { wrap.innerHTML = '<div class="hours-empty">Fluxo não encontrado.</div>'; return; }
  if (!wizardState.customization) resetWizardCustomization();
  // Pré-popula checklist com o default do fluxo (só se ainda tá zerado —
  // evita resetar edições feitas no step 4 se o usuário voltar pro cust).
  if (!Array.isArray(demandChecklistDraft) || !demandChecklistDraft.length) {
    demandChecklistDraft = Array.isArray(flow.defaultChecklist)
      ? flow.defaultChecklist.map(it => ({ text: String(it.text || '') }))
      : [];
  }
  const cust = wizardState.customization;
  const wsIdForUsers = wizardState.projectId ? projectById(wizardState.projectId)?.workspaceId : activeWs;
  const userOptions = users
    .filter(u => u.active !== false && (u.isAdmin || (u.workspaces || []).includes(wsIdForUsers)))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));

  // Ordem efetiva: se stageOrder existe, usa; senão originais + adicionadas.
  const allById = new Map();
  flow.stages.forEach(s => allById.set(s.id, { stage: s, isAddition: false }));
  cust.stageAdditions.forEach(s => allById.set(s.id, { stage: s, isAddition: true }));
  let orderedIds;
  if (Array.isArray(cust.stageOrder) && cust.stageOrder.length) {
    const seen = new Set();
    orderedIds = cust.stageOrder.filter(id => allById.has(id) && !seen.has(id) && seen.add(id));
    // Garante que qualquer id novo (não no stageOrder) apareça no final
    flow.stages.forEach(s => { if (!seen.has(s.id)) { orderedIds.push(s.id); seen.add(s.id); } });
    cust.stageAdditions.forEach(s => { if (!seen.has(s.id)) { orderedIds.push(s.id); seen.add(s.id); } });
  } else {
    orderedIds = [...flow.stages.map(s => s.id), ...cust.stageAdditions.map(s => s.id)];
  }

  const rowHTML = (stageId) => {
    const meta = allById.get(stageId);
    if (!meta) return '';
    const { stage, isAddition } = meta;
    const skipped = cust.skippedStages.includes(stageId);
    const label = cust.stageLabels[stageId] || stage.label;
    const color = _custEffectiveStageValue(stage, isAddition, 'color') || '#7A00FF';
    const days = _custEffectiveStageValue(stage, isAddition, 'deadlineDays');
    const done = _custEffectiveStageValue(stage, isAddition, 'done');
    const respValue = (stageId in cust.stageResponsibles) ? cust.stageResponsibles[stageId]
      : (isAddition ? (stage.responsibleId || '') : '');
    const roleOpts = `<option value="">— Padrão do fluxo —</option>` +
      userOptions.map(u => `<option value="${u.id}" ${respValue === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
    const badge = isAddition
      ? '<span class="wizard-cust-badge is-added">Nova</span>'
      : '<span class="wizard-cust-badge is-original">Original</span>';
    const removeBtn = isAddition
      ? `<button type="button" class="wizard-cust-remove" title="Remover etapa" onclick="wizardCustRemoveAddition('${stageId}')"><i data-lucide="trash-2" class="ic-sm"></i></button>`
      : '<span class="wizard-cust-remove-placeholder"></span>';
    return `<div class="wizard-cust-row-v2 ${skipped ? 'is-skipped' : ''} ${isAddition ? 'is-added' : ''}" draggable="true" data-stage-id="${stageId}">
      <span class="wizard-cust-drag" title="Arraste pra reordenar"><i data-lucide="grip-vertical" class="ic-sm"></i></span>
      <button type="button" class="color-swatch-trigger wizard-cust-color-lg" style="background:${esc(color)}" onclick="openColorPicker(this, (c) => { wizardCustSetColor('${stageId}', c); this.style.background = c; }, '${esc(color)}')" title="Cor da etapa"></button>
      <input type="text" class="wizard-cust-name" value="${esc(label)}" placeholder="Nome da etapa" oninput="wizardCustSetLabel('${stageId}', this.value)">
      ${badge}
      <select class="wizard-cust-resp" onchange="wizardCustSetResp('${stageId}', this.value)">${roleOpts}</select>
      <div class="wizard-cust-days-wrap">
        <span class="wizard-cust-mini-label">Prazo (dias)</span>
        <input type="number" class="wizard-cust-days" min="0" step="1" value="${days ?? ''}" placeholder="—" oninput="wizardCustSetDays('${stageId}', this.value)">
      </div>
      <label class="wizard-cust-toggle wizard-cust-done" title="Marcar como etapa que encerra a demanda">
        <input type="checkbox" ${done ? 'checked' : ''} onchange="wizardCustSetDone('${stageId}', this.checked)"> <span>Conclui</span>
      </label>
      <label class="wizard-cust-toggle wizard-cust-active" title="${skipped ? 'Habilitar' : 'Pular esta etapa'}">
        <input type="checkbox" ${!skipped ? 'checked' : ''} onchange="wizardCustToggleSkip('${stageId}', this.checked)"> <span>Ativa</span>
      </label>
      ${removeBtn}
    </div>`;
  };
  wrap.innerHTML = orderedIds.map(rowHTML).join('');
  _installCustDragDrop(wrap);
  renderWizardCustChecklist();
  paintIcons();
}
function renderWizardCustChecklist() {
  const wrap = $('dw-cust-checklist');
  if (!wrap) return;
  // Reusa demandChecklistDraft — o step 4 lê essa mesma variável no submit.
  if (!Array.isArray(demandChecklistDraft)) demandChecklistDraft = [];
  wrap.innerHTML = demandChecklistDraft.map((it, i) => `
    <div class="wizard-cust-chk-item">
      <input type="text" class="form-control" placeholder="Ex.: Aprovar copy com cliente" value="${esc(it.text || '')}" oninput="wizardCustSetChecklistText(${i}, this.value)">
      <button type="button" class="detail-icon-btn danger" onclick="wizardCustRemoveChecklistItem(${i})" title="Remover"><i data-lucide="x" class="ic-sm"></i></button>
    </div>`).join('') || '<div class="hours-empty" style="text-align:left;padding:6px 0">Nenhum item ainda.</div>';
  paintIcons();
}
function wizardCustSetChecklistText(idx, value) {
  if (!demandChecklistDraft[idx]) return;
  demandChecklistDraft[idx].text = value;
}
function wizardCustAddChecklistItem() {
  if (!Array.isArray(demandChecklistDraft)) demandChecklistDraft = [];
  demandChecklistDraft.push({ text: '' });
  renderWizardCustChecklist();
}
function wizardCustRemoveChecklistItem(idx) {
  demandChecklistDraft.splice(idx, 1);
  renderWizardCustChecklist();
}

/* Drag & drop nativo pra reordenar etapas. Guarda a ordem em cust.stageOrder
   (array de stageIds — mistura originais e adicionadas). */
let _custDragId = null;
function _installCustDragDrop(container) {
  container.querySelectorAll('.wizard-cust-row-v2').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      _custDragId = row.dataset.stageId;
      row.classList.add('is-dragging');
      // Alguns browsers precisam de setData pro drag funcionar
      try { e.dataTransfer.setData('text/plain', _custDragId); } catch {}
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      container.querySelectorAll('.wizard-cust-row-v2').forEach(r => r.classList.remove('drop-above', 'drop-below'));
      _custDragId = null;
    });
    row.addEventListener('dragover', (e) => {
      if (!_custDragId || _custDragId === row.dataset.stageId) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-above', 'drop-below');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!_custDragId || _custDragId === row.dataset.stageId) return;
      const rect = row.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      _reorderCust(_custDragId, row.dataset.stageId, above);
    });
  });
}
function _reorderCust(draggedId, targetId, above) {
  const cust = wizardState.customization;
  const flow = flowById(wizardState.flowId);
  // Snapshot da ordem atual (inclui originais + adicionadas).
  const current = Array.isArray(cust.stageOrder) && cust.stageOrder.length
    ? [...cust.stageOrder]
    : [...flow.stages.map(s => s.id), ...cust.stageAdditions.map(s => s.id)];
  const fromIdx = current.indexOf(draggedId);
  if (fromIdx < 0) return;
  current.splice(fromIdx, 1);
  let toIdx = current.indexOf(targetId);
  if (toIdx < 0) return;
  if (!above) toIdx += 1;
  current.splice(toIdx, 0, draggedId);
  cust.stageOrder = current;
  renderWizardCustomization();
}

function wizardCustToggleSkip(stageId, enabled) {
  const cust = wizardState.customization;
  if (enabled) cust.skippedStages = cust.skippedStages.filter(id => id !== stageId);
  else if (!cust.skippedStages.includes(stageId)) cust.skippedStages.push(stageId);
  // Re-render pra visual do skipped (opacity)
  renderWizardCustomization();
}
function wizardCustSetLabel(stageId, value) {
  const cust = wizardState.customization;
  const v = (value || '').trim();
  const flow = flowById(wizardState.flowId);
  const addition = cust.stageAdditions.find(s => s.id === stageId);
  if (addition) { addition.label = v || 'Nova etapa'; return; }
  const orig = flow?.stages.find(s => s.id === stageId);
  if (orig && v && v !== orig.label) cust.stageLabels[stageId] = v;
  else delete cust.stageLabels[stageId];
}
function wizardCustSetResp(stageId, value) {
  const cust = wizardState.customization;
  const addition = cust.stageAdditions.find(s => s.id === stageId);
  if (addition) { addition.responsibleId = value || null; return; }
  if (value === '') delete cust.stageResponsibles[stageId];
  else cust.stageResponsibles[stageId] = value;
}
function wizardCustSetDays(stageId, value) {
  const cust = wizardState.customization;
  const n = value === '' ? null : parseInt(value, 10);
  const parsed = (n === null || (Number.isFinite(n) && n >= 0)) ? n : null;
  const addition = cust.stageAdditions.find(s => s.id === stageId);
  if (addition) { addition.deadlineDays = parsed; return; }
  // Etapa original — override. Só grava se diferente do padrão do fluxo.
  const flow = flowById(wizardState.flowId);
  const orig = flow?.stages.find(s => s.id === stageId);
  const same = (orig?.deadlineDays ?? null) === (parsed ?? null);
  _writeStageOverride(stageId, 'deadlineDays', same ? undefined : parsed);
}
function wizardCustSetColor(stageId, value) {
  if (!/^#[0-9a-f]{6}$/i.test(value || '')) return;
  const cust = wizardState.customization;
  const addition = cust.stageAdditions.find(s => s.id === stageId);
  if (addition) { addition.color = value; return; }
  const flow = flowById(wizardState.flowId);
  const orig = flow?.stages.find(s => s.id === stageId);
  const same = (orig?.color || '').toLowerCase() === value.toLowerCase();
  _writeStageOverride(stageId, 'color', same ? undefined : value);
}
function wizardCustSetDone(stageId, checked) {
  const cust = wizardState.customization;
  const addition = cust.stageAdditions.find(s => s.id === stageId);
  if (addition) { addition.done = !!checked; return; }
  const flow = flowById(wizardState.flowId);
  const orig = flow?.stages.find(s => s.id === stageId);
  const same = !!orig?.done === !!checked;
  _writeStageOverride(stageId, 'done', same ? undefined : !!checked);
}
/* Grava/limpa override numa etapa original. undefined = remove override
   (volta ao padrão do fluxo). Se o objeto de override fica vazio, remove todo. */
function _writeStageOverride(stageId, field, value) {
  const cust = wizardState.customization;
  const ov = cust.stageOverrides[stageId] || {};
  if (value === undefined) delete ov[field];
  else ov[field] = value;
  if (Object.keys(ov).length === 0) delete cust.stageOverrides[stageId];
  else cust.stageOverrides[stageId] = ov;
}
function wizardAddCustStage() {
  if (!wizardState.customization) resetWizardCustomization();
  const newStage = {
    id: 'add-' + Math.random().toString(36).slice(2, 10),
    label: 'Nova etapa',
    color: '#7A00FF',
    deadlineDays: null,
    responsibleId: null,
    done: false
  };
  wizardState.customization.stageAdditions.push(newStage);
  // Se já tem stageOrder, adiciona no final pra manter consistência
  if (Array.isArray(wizardState.customization.stageOrder)) {
    wizardState.customization.stageOrder.push(newStage.id);
  }
  renderWizardCustomization();
}
function wizardCustRemoveAddition(id) {
  const cust = wizardState.customization;
  cust.stageAdditions = cust.stageAdditions.filter(s => s.id !== id);
  if (Array.isArray(cust.stageOrder)) cust.stageOrder = cust.stageOrder.filter(x => x !== id);
  renderWizardCustomization();
}

/* Renderizadores dos 3 grids de seleção. Card click = seleciona; dblclick = avança. */
function _wizardCardHandlers(el, onSelect) {
  el.addEventListener('click', () => onSelect(false));
  el.addEventListener('dblclick', () => onSelect(true));
}

/* Recentes — guarda os últimos IDs usados por (usuário × tipo) em localStorage.
   MRU: recém-usado vai pra frente, cai fora da lista após WIZARD_RECENTS_MAX. */
const WIZARD_RECENTS_MAX = 5;
function _recentsKey(kind) { return `kastor-recents-${kind}-${me?.id || 'anon'}`; }
function wizardGetRecents(kind) {
  try {
    const raw = localStorage.getItem(_recentsKey(kind));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function wizardPushRecent(kind, id) {
  if (!id) return;
  let arr = wizardGetRecents(kind).filter(x => x !== id);
  arr.unshift(id);
  arr = arr.slice(0, WIZARD_RECENTS_MAX);
  try { localStorage.setItem(_recentsKey(kind), JSON.stringify(arr)); } catch {}
}
/* Ordena a lista completa colocando os recentes primeiro (mesma ordem do MRU),
   depois o resto na ordem original. Devolve um objeto separando pra que o render
   possa exibir cabeçalho "Recentes" e "Todos". */
function wizardSplitRecents(kind, fullList) {
  const recentIds = wizardGetRecents(kind);
  const byId = new Map(fullList.map(x => [x.id, x]));
  const recents = recentIds.map(id => byId.get(id)).filter(Boolean);
  const recentSet = new Set(recents.map(x => x.id));
  const rest = fullList.filter(x => !recentSet.has(x.id));
  return { recents, rest };
}

function _wizardClientCard(c) {
  const card = document.createElement('div');
  card.className = 'wizard-card' + (wizardState.clientId === c.id ? ' is-selected' : '');
  const avatar = c.avatar
    ? `<div class="wizard-card-avatar" style="background-image:url('${c.avatar}');background-size:cover;background-position:center"></div>`
    : `<div class="wizard-card-avatar" style="background:${hexDim(c.color || '#7A00FF')};color:${c.color || '#7A00FF'}">${esc((c.name || 'C').charAt(0).toUpperCase())}</div>`;
  card.innerHTML = `${avatar}<div class="wizard-card-name">${esc(c.name)}</div>`;
  _wizardCardHandlers(card, (advance) => {
    wizardState.clientId = c.id;
    wizardPushRecent('client', c.id);
    // Limpa downstream se mudou a seleção
    wizardState.projectId = null; wizardState.flowId = null;
    renderWizardClients();
    updateWizardNextEnabled();
    if (advance) wizardNext();
  });
  return card;
}
function renderWizardClients() {
  const wrap = $('dw-clients-grid');
  if (!wrap) return;
  const q = norm(($('dw-client-search')?.value || '').trim());
  const list = clients
    .filter(c => (me.isAdmin || (me.workspaces || []).includes(c.workspaceId)))
    .filter(c => c.active !== false)
    .filter(c => !q || norm(c.name).includes(q))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  if (!list.length) {
    wrap.innerHTML = emptyState('Nenhum cliente cadastrado', 'Crie clientes em "Clientes" antes de criar uma demanda.', 'users');
    return;
  }
  wrap.innerHTML = '';
  // Se não há busca, mostra "Recentes" no topo (se houver). Com busca, oculta pra
  // não confundir — o usuário está procurando algo específico.
  if (!q) {
    const { recents, rest } = wizardSplitRecents('client', list);
    if (recents.length) {
      const head = document.createElement('div');
      head.className = 'wizard-section-head';
      head.textContent = 'RECENTES';
      wrap.appendChild(head);
      recents.forEach(c => wrap.appendChild(_wizardClientCard(c)));
      const head2 = document.createElement('div');
      head2.className = 'wizard-section-head';
      head2.textContent = 'TODOS';
      wrap.appendChild(head2);
      rest.forEach(c => wrap.appendChild(_wizardClientCard(c)));
      return;
    }
  }
  list.forEach(c => wrap.appendChild(_wizardClientCard(c)));
}

function renderWizardProjects() {
  const wrap = $('dw-projects-grid');
  if (!wrap) return;
  const q = norm(($('dw-project-search')?.value || '').trim());
  const cid = wizardState.clientId;
  const list = projects
    .filter(p => p.clientId === cid && p.active !== false)
    .filter(p => !q || norm(p.name).includes(q))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  if (!list.length) {
    wrap.innerHTML = emptyState('Nenhum projeto ativo', 'Esse cliente não tem projetos ativos. Crie um pelo painel do cliente.', 'inbox');
    return;
  }
  wrap.innerHTML = '';
  list.forEach(p => {
    const card = document.createElement('div');
    card.className = 'wizard-card' + (wizardState.projectId === p.id ? ' is-selected' : '');
    const avatar = p.avatar
      ? `<div class="wizard-card-avatar" style="background-image:url('${p.avatar}');background-size:cover;background-position:center"></div>`
      : `<div class="wizard-card-avatar" style="background:${hexDim(p.color || '#7A00FF')};color:${p.color || '#7A00FF'}">${esc((p.name || 'P').charAt(0).toUpperCase())}</div>`;
    card.innerHTML = `${avatar}<div class="wizard-card-name">${esc(p.name)}</div>`;
    _wizardCardHandlers(card, (advance) => {
      wizardState.projectId = p.id;
      wizardState.flowId = null;
      renderWizardProjects();
      updateWizardNextEnabled();
      if (advance) wizardNext();
    });
    wrap.appendChild(card);
  });
}

function _wizardFlowCard(f) {
  const card = document.createElement('div');
  card.className = 'wizard-card' + (wizardState.flowId === f.id ? ' is-selected' : '');
  const iconHtml = !f.icon
    ? `<div class="wizard-card-avatar wizard-card-avatar--icon"><i data-lucide="workflow" class="ic-sm"></i></div>`
    : (typeof f.icon === 'string' && f.icon.startsWith('lucide:'))
      ? `<div class="wizard-card-avatar wizard-card-avatar--icon"><i data-lucide="${esc(f.icon.slice(7))}" class="ic-md"></i></div>`
      : `<div class="wizard-card-avatar" style="background-image:url('${f.icon}');background-size:cover;background-position:center"></div>`;
  const sub = f.demandType ? `<div class="wizard-card-sub">${esc(f.demandType)}</div>` : '';
  card.innerHTML = `${iconHtml}<div class="wizard-card-name">${esc(f.name)}</div>${sub}`;
  _wizardCardHandlers(card, (advance) => {
    wizardState.flowId = f.id;
    wizardPushRecent('flow', f.id);
    renderWizardFlows();
    updateWizardNextEnabled();
    if (advance) wizardNext();
  });
  return card;
}
function renderWizardFlows() {
  const wrap = $('dw-flows-grid');
  if (!wrap) return;
  const q = norm(($('dw-flow-search')?.value || '').trim());
  const typeFilter = $('dw-flow-type')?.value || '';
  const pid = wizardState.projectId;
  const allFlows = flowsForProject(pid);
  // Popula filtro de tipo
  const types = [...new Set(allFlows.map(f => f.demandType).filter(Boolean))].sort();
  const tSel = $('dw-flow-type');
  if (tSel) {
    const cur = tSel.value;
    tSel.innerHTML = '<option value="">Todos os tipos</option>' + types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if (types.includes(cur)) tSel.value = cur;
  }
  const list = allFlows
    .filter(f => !typeFilter || f.demandType === typeFilter)
    .filter(f => !q || norm(f.name).includes(q))
    .sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  if (!list.length) {
    wrap.innerHTML = emptyState('Nenhum fluxo disponível', 'Esse projeto não tem fluxos. Crie um pelo painel do cliente.', 'flow');
    return;
  }
  wrap.innerHTML = '';
  // Recentes só sem busca/filtro — evita confundir quando o usuário está procurando algo.
  if (!q && !typeFilter) {
    const { recents, rest } = wizardSplitRecents('flow', list);
    if (recents.length) {
      const head = document.createElement('div');
      head.className = 'wizard-section-head';
      head.textContent = 'RECENTES';
      wrap.appendChild(head);
      recents.forEach(f => wrap.appendChild(_wizardFlowCard(f)));
      const head2 = document.createElement('div');
      head2.className = 'wizard-section-head';
      head2.textContent = 'TODOS';
      wrap.appendChild(head2);
      rest.forEach(f => wrap.appendChild(_wizardFlowCard(f)));
      paintIcons();
      return;
    }
  }
  list.forEach(f => wrap.appendChild(_wizardFlowCard(f)));
  paintIcons();
}

/* Step 4 — popula o form atual a partir do state do wizard. */
function renderWizardStep4() {
  const cid = wizardState.clientId;
  const pid = wizardState.projectId;
  const fid = wizardState.flowId;
  // Breadcrumb visual
  const c = cid ? clientById(cid) : null;
  const p = pid ? projectById(pid) : null;
  const f = fid ? flowById(fid) : null;
  const bc = $('dw-breadcrumb');
  if (bc) {
    bc.innerHTML = [c?.name, p?.name, f?.name].filter(Boolean).map(s => esc(s)).join(' <span style="opacity:.45">›</span> ');
  }
  // Sincroniza os selects ocultos (compat com o resto do código)
  if (pid) $('f-project').value = pid;
  // Trocou de fluxo desde a última aplicação? Reseta defaults (descrição + checklist)
  // para que o novo fluxo herde seus próprios valores em syncStatusOptions().
  // Só aplica em criação — edição mantém os campos da demanda existente.
  if (!editingId && fid && fid !== wizardLastFlowApplied) {
    $('f-description').value = '';
    demandChecklistDraft = [];
    renderDemandChecklist();
    wizardLastFlowApplied = fid;
  }
  // onDemandProjectChange popula f-flow options; se já tiver, força o nosso
  if (pid) {
    onDemandProjectChange();
    if (fid) {
      $('f-flow').value = fid;
      syncStatusOptions(editingId ? demandById(editingId)?.status : undefined);
    }
  }
  // Sincroniza responsável (se edição) — já feito pelo openEditDemand;
  // na criação, syncStatusOptions já chama buildUserSelect com auto-owner.
  if (!editingId) {
    // Foca o nome
    setTimeout(() => $('f-name').focus(), 60);
  }
}

/* ─── START ─── */
boot();
