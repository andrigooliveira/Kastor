/* ───────────────────────────────────────────────────────────────
   reWork — Organizações (multi-tenant)

   Cada requisição autenticada roda dentro de um contexto (AsyncLocalStorage)
   com a organização ativa. Dentro dele, `db` (o proxy criado aqui) só
   enxerga os dados daquela organização:

     - leitura  (db.demands.filter/find/…)  → só itens da organização;
     - escrita  (push / splice / db.x = db.x.filter(…)) → age na lista real,
       sem tocar nos itens das outras organizações.

   Fora de um contexto (boot, jobs agendados, rotas públicas por token) o
   proxy devolve as listas inteiras — o comportamento de antes.

   A que organização pertence cada item:
     - workspaces, memberships, invites e itens "da organização inteira"
       (áreas, cargos, tipos de demanda…) → campo `orgId`;
     - o resto → pelo squad (`workspaceId` → workspace.orgId);
     - users → quem tem vínculo (membership) com a organização.

   Permissões por organização: o vínculo guarda o nível (owner, admin, mod,
   equipe, free), os squads, a área e o cargo da pessoa naquela
   organização. Em cada usuário, isAdmin/isModerator/isFreelancer/
   workspaces/role/position/active viram propriedades calculadas a partir do
   vínculo da organização ativa — o resto do código continua lendo e
   escrevendo `u.isAdmin`, `u.workspaces` etc. como antes.
   ─────────────────────────────────────────────────────────────── */
const { AsyncLocalStorage } = require('async_hooks');

const ROLES = ['owner', 'admin', 'mod', 'equipe', 'free'];
// Tipos que NÃO passam pelo filtro de organização.
const UNSCOPED = new Set(['organizations', 'platformAdmins', 'accessRequests', 'platformAudit', 'googleEvents', 'notifications']);
// Campos do usuário que passam a morar no vínculo.
const MEMBER_FIELDS = ['isAdmin', 'isModerator', 'isFreelancer', 'workspaces', 'role', 'position', 'active'];

function createTenancy({ getRaw, onMemberChange }) {
  const ctx = new AsyncLocalStorage();
  const raw = () => getRaw();

  const currentOrgId = () => { const s = ctx.getStore(); return s ? s.orgId : null; };
  const run = (orgId, fn, extra) => ctx.run({ orgId, cache: new Map(), ...(extra || {}) }, fn);

  /* ── Índices (reconstruídos quando a lista muda de tamanho/identidade) ── */
  let wsIdx = { src: null, len: -1, map: new Map() };
  function wsOrgId(wsId) {
    const list = raw().workspaces || [];
    if (wsIdx.src !== list || wsIdx.len !== list.length) {
      wsIdx = { src: list, len: list.length, map: new Map(list.map(w => [w.id, w.orgId || null])) };
    }
    const hit = wsIdx.map.get(wsId);
    if (hit === undefined && wsId) {
      // Workspace novo sem índice ainda (ex.: orgId carimbado depois do push)
      const w = list.find(x => x.id === wsId);
      if (w) { wsIdx.map.set(w.id, w.orgId || null); return w.orgId || null; }
    }
    return hit || null;
  }
  let mIdx = { src: null, len: -1, byOrg: new Map(), byUser: new Map() };
  function memberIndex() {
    const list = raw().memberships || [];
    if (mIdx.src !== list || mIdx.len !== list.length) {
      const byOrg = new Map(), byUser = new Map();
      for (const m of list) {
        if (!byOrg.has(m.orgId)) byOrg.set(m.orgId, new Map());
        byOrg.get(m.orgId).set(m.userId, m);
        if (!byUser.has(m.userId)) byUser.set(m.userId, []);
        byUser.get(m.userId).push(m);
      }
      mIdx = { src: list, len: list.length, byOrg, byUser };
    }
    return mIdx;
  }
  const memberIn = (userId, orgId) => (orgId && memberIndex().byOrg.get(orgId)?.get(userId)) || null;
  const membershipsOf = (userId) => memberIndex().byUser.get(userId) || [];
  const orgById = (id) => (raw().organizations || []).find(o => o.id === id) || null;
  const orgActive = (id) => { const o = orgById(id); return !!o && o.status !== 'suspended' && !o.deletedAt; };
  /* Vínculos ativos (em organizações ativas), do mais recente pro mais antigo uso. */
  function activeMemberships(userId) {
    return membershipsOf(userId).filter(m => m.active !== false && orgActive(m.orgId));
  }
  /* Vínculo "principal": o da última organização usada, senão o mais antigo ativo. */
  function primaryMembership(user) {
    const ms = activeMemberships(user.id);
    if (!ms.length) return membershipsOf(user.id)[0] || null;
    const last = user && user.lastOrgId && ms.find(m => m.orgId === user.lastOrgId);
    return last || ms.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  }
  /* Vínculo que vale agora: o da organização ativa; fora de contexto, o principal. */
  function memberFor(user) {
    const org = currentOrgId();
    return org ? memberIn(user.id, org) : primaryMembership(user);
  }

  /* ── A que organização pertence um item ── */
  function orgOf(type, e) {
    if (!e) return null;
    if (type === 'workspaces' || type === 'memberships' || type === 'invites') return e.orgId || null;
    return e.orgId || (e.workspaceId ? wsOrgId(e.workspaceId) : null);
  }
  function belongs(type, e, orgId) {
    if (type === 'users') return !!memberIn(e.id, orgId);
    return orgOf(type, e) === orgId;
  }

  /* ── Visão filtrada de uma lista, que escreve na lista real ── */
  function scopedView(store, key) {
    const real = raw()[key];
    const c = store.cache.get(key);
    if (c && c.src === real && c.len === real.length) return c.proxy;
    const arr = real.filter(e => belongs(key, e, store.orgId));
    const removeFromReal = (items) => {
      const list = raw()[key];
      for (const it of items) { const i = list.indexOf(it); if (i >= 0) list.splice(i, 1); }
    };
    const proxy = new Proxy(arr, {
      get(target, prop) {
        if (prop === 'push' || prop === 'unshift') {
          return (...items) => { raw()[key][prop](...items); const n = target[prop](...items); refresh(); return n; };
        }
        if (prop === 'splice') {
          return (...args) => {
            const removed = target.splice(...args);
            removeFromReal(removed);
            const added = args.slice(2);
            if (added.length) raw()[key].push(...added);
            refresh();
            return removed;
          };
        }
        if (prop === 'pop' || prop === 'shift') {
          return () => { const it = target[prop](); if (it !== undefined) removeFromReal([it]); refresh(); return it; };
        }
        return Reflect.get(target, prop);
      },
      set(target, prop, value) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const list = raw()[key];
          const old = target[prop];
          const i = old === undefined ? -1 : list.indexOf(old);
          if (i >= 0) list[i] = value; else list.push(value);
          target[prop] = value;
          refresh();
          return true;
        }
        target[prop] = value;
        return true;
      }
    });
    // Mantém o cache válido depois de mexer pela própria visão.
    function refresh() { store.cache.set(key, { src: raw()[key], len: raw()[key].length, proxy }); }
    refresh();
    return proxy;
  }

  const db = new Proxy({}, {
    get(_, key) {
      const r = raw();
      if (!r) return undefined;
      const val = r[key];
      const store = ctx.getStore();
      if (!store || !store.orgId || !Array.isArray(val) || UNSCOPED.has(key)) return val;
      return scopedView(store, key);
    },
    set(_, key, value) {
      const r = raw();
      const store = ctx.getStore();
      if (store && store.orgId && Array.isArray(value) && Array.isArray(r[key]) && !UNSCOPED.has(key)) {
        // Troca só a fatia da organização ativa (ex.: db.x = db.x.filter(…)).
        const others = r[key].filter(e => !belongs(key, e, store.orgId));
        r[key] = others.concat(value);
        store.cache.delete(key);
        return true;
      }
      r[key] = value;
      if (store) store.cache.delete(key);
      return true;
    },
    has(_, key) { return key in (raw() || {}); },
    ownKeys() { return Reflect.ownKeys(raw() || {}); },
    getOwnPropertyDescriptor(_, key) {
      const r = raw() || {};
      return key in r ? { value: r[key], writable: true, enumerable: true, configurable: true } : undefined;
    }
  });

  /* ── Usuário: campos do vínculo viram propriedades calculadas ── */
  const ATTACHED = Symbol('tenancyAttached');
  function legacySnapshot(user) {
    const m = primaryMembership(user);
    if (!m) return {};
    return {
      isAdmin: m.role === 'owner' || m.role === 'admin', isModerator: m.role === 'mod', isFreelancer: m.role === 'free',
      workspaces: m.workspaces || [], role: m.area || '', position: m.position || null, active: m.active !== false
    };
  }
  function changed(m) { if (m && onMemberChange) onMemberChange(m); }
  function attachUser(user) {
    if (!user || user[ATTACHED]) return user;
    for (const f of MEMBER_FIELDS) delete user[f];
    const def = (name, get, set) => Object.defineProperty(user, name, { get, set, enumerable: false, configurable: true });
    def('isOwner', () => memberFor(user)?.role === 'owner', () => {});
    def('orgRole', () => memberFor(user)?.role || null, () => {});
    def('isAdmin', () => { const r = memberFor(user)?.role; return r === 'owner' || r === 'admin'; }, (v) => {
      const m = memberFor(user); if (!m || m.role === 'owner') return;
      if (v) m.role = 'admin'; else if (m.role === 'admin') m.role = 'equipe';
      changed(m);
    });
    def('isModerator', () => memberFor(user)?.role === 'mod', (v) => {
      const m = memberFor(user); if (!m || m.role === 'owner' || m.role === 'admin') return;
      if (v) m.role = 'mod'; else if (m.role === 'mod') m.role = 'equipe';
      changed(m);
    });
    def('isFreelancer', () => memberFor(user)?.role === 'free', (v) => {
      const m = memberFor(user); if (!m || m.role === 'owner' || m.role === 'admin' || m.role === 'mod') return;
      if (v) m.role = 'free'; else if (m.role === 'free') m.role = 'equipe';
      changed(m);
    });
    def('workspaces', () => { const m = memberFor(user); if (!m) return []; if (!Array.isArray(m.workspaces)) m.workspaces = []; return m.workspaces; },
      (v) => { const m = memberFor(user); if (!m) return; m.workspaces = Array.isArray(v) ? v : []; changed(m); });
    def('role', () => memberFor(user)?.area || '', (v) => { const m = memberFor(user); if (!m) return; m.area = String(v || ''); changed(m); });
    def('position', () => memberFor(user)?.position || null, (v) => { const m = memberFor(user); if (!m) return; m.position = v || null; changed(m); });
    def('active', () => { const m = memberFor(user); return !!m && m.active !== false; }, (v) => {
      const m = memberFor(user); if (!m) return; m.active = !!v; changed(m);
    });
    // Gravação no banco: dados da pessoa + retrato do vínculo principal (mantém
    // as linhas legíveis por uma versão antiga do servidor, em caso de volta).
    Object.defineProperty(user, 'toJSON', { value() { return { ...this, ...legacySnapshot(this) }; }, enumerable: false, configurable: true });
    Object.defineProperty(user, ATTACHED, { value: true, enumerable: false });
    return user;
  }

  return {
    ctx, run, currentOrgId, db, ROLES, UNSCOPED, MEMBER_FIELDS,
    wsOrgId, orgOf, belongs, memberIn, membershipsOf, activeMemberships, primaryMembership, memberFor,
    orgById, orgActive, attachUser
  };
}

module.exports = { createTenancy, ROLES };
