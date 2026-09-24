/* ═══════════════════════════════════════════════════════════════════════
   Kastor Docs — boot standalone
   ─────────────────────────────
   Rodando em /writer, SEM app.js da plataforma. Este arquivo:
     1. Checa auth via /api/me (usa o mesmo cookie httpOnly da plataforma).
     2. Carrega /vendor/writer.bundle.js (Tiptap).
     3. Faz roteamento próprio (/writer, /writer/<slug>).
     4. Fala com /api/writer/* pra CRUD e autosave.

   Não depende de nada do app.js. Toast, esc-html, tudo local.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const KD = window.KD = {
    me: null,
    workspaces: [],
    docsList: [],
    sort: 'updated',
    currentDoc: null,
    editor: null,
    saveTimer: null,
    saving: false,
    lastSavedVersion: 0,
    dirty: false
  };

  // ── helpers ────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function slugify(s, maxLen) {
    maxLen = maxLen || 60;
    const t = String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '');
    return t.length > maxLen ? t.slice(0, maxLen).replace(/-+$/, '') : t;
  }
  const ID_TAIL = /(?:^|-)([0-9a-f]{12})$/i;
  function extractId(slug) {
    const m = String(slug || '').match(ID_TAIL);
    return m ? m[1] : slug;
  }
  function docSlug(d) {
    const s = slugify(d.title || 'documento');
    return s ? s + '-' + d.id : d.id;
  }
  function toast(msg, type) {
    const el = $('kd-toast');
    el.textContent = msg;
    el.className = 'kd-toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.className = 'kd-toast', 3000);
  }
  function fmtDate(iso) {
    try {
      const dt = new Date(iso);
      const now = new Date();
      if (dt.toDateString() === now.toDateString())
        return 'Hoje, ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const y = new Date(now); y.setDate(y.getDate() - 1);
      if (dt.toDateString() === y.toDateString()) return 'Ontem';
      return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    } catch { return ''; }
  }
  function jsonToText(n) {
    if (!n) return '';
    if (typeof n === 'string') return n;
    if (n.text) return n.text;
    if (Array.isArray(n.content)) return n.content.map(jsonToText).join(' ');
    return '';
  }

  // ── API client (minimal) ───────────────────────────────────────────────
  async function api(path, method, body) {
    const res = await fetch('/api' + path, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) throw new Error('__unauth__');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
    return data;
  }

  // ── Carrega o bundle Tiptap sob demanda (só na tela de editor) ────────
  let bundlePromise = null;
  function ensureBundle() {
    if (window.KastorWriter) return Promise.resolve(window.KastorWriter);
    if (bundlePromise) return bundlePromise;
    bundlePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/writer.bundle.js?v=20260924pg8';
      s.async = true;
      s.onload = () => window.KastorWriter ? resolve(window.KastorWriter) : reject(new Error('bundle sem KastorWriter'));
      s.onerror = () => reject(new Error('Falha ao carregar o editor.'));
      document.head.appendChild(s);
    });
    return bundlePromise;
  }

  // ── Router ────────────────────────────────────────────────────────────
  function currentRoute() {
    const p = location.pathname.replace(/\/+$/, '') || '/hub/docs';
    // /hub/docs/public/<token> — viewer público (sem auth)
    const mp = p.match(/^\/(?:hub\/)?docs\/public\/([a-zA-Z0-9]+)$/);
    if (mp) return { view: 'public', token: mp[1] };
    // /hub/docs/<slug> — editor privado
    const m = p.match(/^\/(?:hub\/)?docs\/([a-zA-Z0-9-]+)$/);
    if (m) return { view: 'editor', slug: m[1], id: extractId(m[1]) };
    return { view: 'list' };
  }
  function goList()          { history.pushState({}, '', '/hub/docs'); route(); }
  function goEditor(doc)     { history.pushState({}, '', '/hub/docs/' + docSlug(doc)); route(); }
  window.addEventListener('popstate', () => route());

  async function route() {
    const r = currentRoute();
    const app = $('kd-app');
    if (r.view === 'public') {
      app.className = 'kd-app is-editor is-public';
      await openPublicViewer(r.token);
    } else if (r.view === 'editor') {
      app.className = 'kd-app is-editor';
      if (!KD.currentDoc || KD.currentDoc.id !== r.id) await openEditor(r.id);
    } else {
      teardownEditor();
      app.className = 'kd-app is-list';
      await loadList();
      renderList();
      // /hub/docs?novo=1 (botão "Novo documento" do Hub) → já abre os modelos
      const qs = new URLSearchParams(location.search);
      if (qs.has('novo')) {
        history.replaceState({}, '', '/hub/docs');
        _kdOpenTemplatesModal({ clientId: qs.get('cliente'), projectId: qs.get('projeto') });
      }
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    // Rota pública (/hub/docs/public/:token) — não exige auth: renderiza o
    // viewer read-only puxando do endpoint /api/writer/public/:token.
    // Escondemos topbar/user chip pra visitante externo não ver artefatos.
    if (currentRoute().view === 'public') {
      $('kd-boot').hidden = true;
      $('kd-app').hidden = false;
      route();
      return;
    }
    // Auth check
    try {
      KD.me = await api('/me');
      if (KD.me.isFreelancer) {
        showAuthWall('Freelancers não têm acesso ao Kastor Docs.');
        return;
      }
    } catch (e) {
      if (e.message === '__unauth__') return showAuthWall('Faça login pra continuar.');
      showAuthWall(e.message || 'Erro ao autenticar.');
      return;
    }

    // Bootstrap: workspaces (só o que precisamos)
    try {
      const boot = await api('/bootstrap');
      KD.workspaces = boot.workspaces || [];
      // Referências da plataforma (#demanda, #cliente, #projeto)
      KD.refData = {
        demands: boot.demands || [], clients: boot.clients || [],
        projects: boot.projects || [], flows: boot.flows || []
      };
    } catch (e) { /* ok — sem lista de workspaces, ainda funciona pra criar em activeWs default */ }

    // Cache de users pra mostrar miniperfil no hover dos avatares de presença
    try {
      const list = await api('/users');
      KD.usersById = new Map(list.map(u => [u.id, u]));
    } catch (e) { KD.usersById = new Map(); }

    // Preenche user chip (usa display name, não username — igual o Hub)
    const avatar = $('kd-user-avatar');
    const uName = $('kd-user-name');
    if (KD.me) {
      const displayName = KD.me.name || KD.me.username || 'Usuário';
      uName.textContent = displayName;
      if (KD.me.avatar) {
        const img = document.createElement('img');
        img.src = KD.me.avatar; img.alt = '';
        avatar.innerHTML = ''; avatar.appendChild(img);
      } else {
        avatar.textContent = displayName.charAt(0).toUpperCase();
      }
      const chip = $('kd-user-chip');
      if (chip) chip.title = displayName;
    }

    // Pinta filtro de squad (hidden, mas usado internamente pelo createDoc)
    populateWsFilter();
    // Sincroniza o logo do topbar com o tema atual (preto no light, branco no dark)
    syncBrandLogo();
    // Sincroniza a toolbar de recentes com as preferências salvas
    initRecentToolbar();

    // Reveal app
    $('kd-boot').hidden = true;
    $('kd-app').hidden = false;

    route();
  }
  function showAuthWall(msg) {
    $('kd-boot').hidden = true;
    $('kd-app').hidden = true;
    const w = $('kd-auth-wall');
    w.hidden = false;
    if (msg) w.querySelector('p').textContent = msg;
  }

  // ── Lista ─────────────────────────────────────────────────────────────
  async function loadList() {
    // Skeleton enquanto carrega — evita flash de "empty state" antes dos dados chegarem
    const grid = $('kd-grid');
    if (grid && KD.docsList.length === 0) {
      grid.innerHTML = Array.from({length: 4}).map(() => `
        <div class="kd-skeleton-card">
          <div class="kd-skeleton-line" style="width:70%"></div>
          <div class="kd-skeleton-line short"></div>
          <div class="kd-skeleton-line short" style="width:50%"></div>
          <div class="kd-skeleton-line tiny"></div>
        </div>`).join('');
    }
    try {
      KD.docsList = await api('/writer');
    } catch (e) {
      KD.docsList = [];
      toast(e.message || 'Falha ao carregar documentos.', 'error');
    }
  }
  function populateWsFilter() {
    const sel = $('kd-f-ws');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todos os squads</option>' +
      KD.workspaces.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');
  }

  // ── Sync logo com tema (preto no light, branco no dark) ────────────────
  function syncBrandLogo() {
    const img = $('kd-brand-logo');
    if (!img) return;
    let cur = document.documentElement.getAttribute('data-theme');
    if (!cur) cur = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    img.src = cur === 'light' ? '/reworkdocs_preto.svg' : '/reworkdocs_branco.svg';
  }
  window.__kdSyncBrandLogo = syncBrandLogo;

  // ── Toolbar de recentes (owner filter / view toggle / sort menu) ───────
  // Preferências persistidas via localStorage, mesmo namespace do Hub.
  function readPref(k, def) { try { return localStorage.getItem('kastor-hub-' + k) || def; } catch { return def; } }
  function savePref(k, v) { try { localStorage.setItem('kastor-hub-' + k, v); } catch {} }
  KD.owner = readPref('owner', 'mine');
  KD.sort  = readPref('sort',  'updated');
  KD.view  = readPref('view',  'grid');

  function initRecentToolbar() {
    applyOwnerTabs(); applyViewIcon();
    markSelectedInMenu('kd-recent-sort-menu', 'sort', KD.sort);
    $('kd-owner-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-owner]'); if (!b) return;
      KD.owner = b.dataset.owner; savePref('owner', KD.owner);
      applyOwnerTabs(); renderList();
    });
    $('kd-recent-sort-menu').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sort]'); if (!b) return;
      KD.sort = b.dataset.sort; savePref('sort', KD.sort);
      markSelectedInMenu('kd-recent-sort-menu', 'sort', KD.sort);
      $('kd-recent-sort-menu').hidden = true;
      renderList();
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('.kd-recent-menu')) return;
      const m = $('kd-recent-sort-menu'); if (m) m.hidden = true;
    });
  }
  function applyOwnerTabs() {
    document.querySelectorAll('#kd-owner-tabs [data-owner]').forEach(b => {
      const on = b.dataset.owner === KD.owner;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  const KD_ICON_LIST = '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>';
  const KD_ICON_GRID = '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>';
  function applyViewIcon() {
    const grid = $('kd-grid');
    const btn = $('kd-recent-view-btn');
    const ic = $('kd-recent-view-icon');
    if (!grid || !btn || !ic) return;
    const isList = KD.view === 'list';
    grid.classList.toggle('is-list', isList);
    btn.title = isList ? 'Ver em grade' : 'Ver em lista';
    ['fill:none', 'stroke:currentColor', 'stroke-width:2', 'stroke-linecap:round', 'stroke-linejoin:round']
      .forEach(kv => { const [k, v] = kv.split(':'); ic.setAttribute(k, v); });
    ic.innerHTML = isList ? KD_ICON_GRID : KD_ICON_LIST;
    requestAnimationFrame(() => window.__kdRescaleThumbs?.());
  }
  function markSelectedInMenu(menuId, key, val) {
    const menu = $(menuId); if (!menu) return;
    menu.querySelectorAll('button').forEach(b => b.classList.toggle('is-selected', b.dataset[key] === val));
  }
  window.kdRecentToggleMenu = function (which, ev) {
    ev && ev.stopPropagation();
    const m = $('kd-recent-sort-menu'); if (m) m.hidden = !m.hidden;
  };
  window.kdRecentToggleView = function () {
    KD.view = KD.view === 'grid' ? 'list' : 'grid';
    savePref('view', KD.view);
    applyViewIcon();
  };

  function renderList() {
    const grid = $('kd-grid');
    if (!grid) return;
    const myId = KD.me && KD.me.id;
    let list = KD.docsList.slice();
    if (KD.owner === 'mine')   list = list.filter(d => d.ownerId === myId);
    if (KD.owner === 'shared') list = list.filter(d => d.ownerId !== myId);
    // Filtro por busca (título) — case-insensitive, sem acento.
    if (KD.searchQuery) {
      const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      const q = norm(KD.searchQuery);
      if (q) list = list.filter(d => norm(d.title).includes(q));
    }
    list.sort((a, b) => {
      if (KD.sort === 'title')   return (a.title || '').localeCompare(b.title || '');
      if (KD.sort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });

    if (!list.length) {
      const msg = KD.searchQuery
        ? 'Nenhum documento com “' + esc(KD.searchQuery) + '” no título.'
        : (KD.owner === 'mine'
          ? 'Você ainda não criou nenhum documento.'
          : KD.owner === 'shared'
            ? 'Ninguém compartilhou documentos com você ainda.'
            : 'Nenhum documento por aqui ainda.');
      const cta = !KD.searchQuery && KD.owner !== 'shared'
        ? '<button type="button" class="btn btn-primary btn-sm" onclick="_kdOpenTemplatesModal()">Criar o primeiro</button>' : '';
      grid.innerHTML = `<div class="kd-recent-empty">${msg}${cta}</div>`;
      return;
    }

    const MAX_TITLE = 42;
    const THUMB_REF_WIDTH = 620;
    // Card externo é <a> (via wrap p/ acessibilidade), então <a> aninhados
    // do PM (link marks) precisam virar <span> ou o browser fecha o wrapper
    // e o card vira só bg. Server já sanitiza; client garante fallback.
    const stripAnchors = (html) => String(html || '')
      .replace(/<a\b[^>]*>/gi, '<span>').replace(/<\/a>/gi, '</span>');
    const trunc = (t) => {
      const s = String(t || 'Sem título');
      return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1).trimEnd() + '…' : s;
    };

    grid.innerHTML = list.slice(0, 60).map(d => {
      const fullTitle = String(d.title || 'Sem título');
      const thumb = stripAnchors(d.thumbHTML || '');
      const thumbClass = thumb ? 'kd-recent-card-thumb' : 'kd-recent-card-thumb is-empty';
      const slug = docSlug(d);
      return `<a class="kd-recent-card" href="/hub/docs/${esc(slug)}" data-id="${esc(d.id)}" title="${esc(fullTitle)}">
        <div class="${thumbClass}" aria-hidden="true">
          ${thumb ? `<div class="kd-recent-card-thumb-page">${thumb}</div>` : ''}
        </div>
        <div class="kd-recent-card-footer">
          <span class="kd-recent-card-app-inline"><img src="/reworkdocs_icone.svg" alt=""></span>
          <span class="kd-recent-card-text">
            <span class="kd-recent-card-title">${esc(fullTitle)}</span>
            <span class="kd-recent-card-meta-date">${esc(fmtDate(d.updatedAt || d.createdAt))}</span>
          </span>
        </div>
      </a>`;
    }).join('');

    // Click → abre editor
    grid.querySelectorAll('.kd-recent-card').forEach(c => {
      c.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        const d = KD.docsList.find(x => x.id === c.dataset.id);
        if (d) goEditor(d);
      });
    });

    // Recalibra o transform:scale dos thumbs pra caber na largura do card
    const rescaleThumbs = () => {
      grid.querySelectorAll('.kd-recent-card-thumb').forEach(t => {
        const page = t.querySelector('.kd-recent-card-thumb-page');
        if (!page) return;
        page.style.transform = 'scale(' + (t.clientWidth / THUMB_REF_WIDTH) + ')';
      });
    };
    window.__kdRescaleThumbs = rescaleThumbs;
    rescaleThumbs();
    requestAnimationFrame(rescaleThumbs);
    if (!window.__kdThumbResizeBound) {
      window.__kdThumbResizeBound = true;
      let raf;
      window.addEventListener('resize', () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(rescaleThumbs);
      });
    }
  }
  window.kdRenderList = renderList;

  window.kdRecentSearchInput = function (v) {
    KD.searchQuery = String(v || '');
    renderList();
  };

  // ── CRUD ──────────────────────────────────────────────────────────────
  /* Squad do documento novo: o do cliente/projeto vinculado, senão o padrão. */
  function _kdWsFor(link) {
    const R = KD.refData || {};
    const ent = link && (link.projectId ? (R.projects || []).find(x => x.id === link.projectId)
                                        : link.clientId ? (R.clients || []).find(x => x.id === link.clientId) : null);
    return (ent && ent.workspaceId) || ($('kd-f-ws').value) || (KD.me?.workspaces && KD.me.workspaces[0]) || (KD.workspaces[0]?.id);
  }
  async function createDoc(link) {
    link = link && (link.clientId || link.projectId) ? link : {};
    const wsId = _kdWsFor(link);
    if (!wsId) { toast('Sem squad disponível pra criar documento.', 'error'); return; }
    try {
      const doc = await api('/writer', 'POST', { workspaceId: wsId, title: 'Sem título', content: null, ...link });
      KD.docsList.unshift(doc);
      // Marca como rascunho recém-criado: se o user sair sem editar nada
      // (nem título nem conteúdo), o doc é removido no teardown/unload.
      // Evita entulhar a lista de recentes com "Sem título" vazios.
      doc._justCreated = true;
      goEditor(doc);
    } catch (e) { toast(e.message || 'Falha ao criar documento.', 'error'); }
  }
  window.kdCreateDoc = createDoc;

  /* Cria um doc já com HTML pré-preenchido (usado por templates/import).
     Salva o HTML no doc VIA `content: {type: 'doc', content: [{type:...}]}`
     não funciona bem — melhor deixar vazio e injetar via setContent depois
     que o editor montar (goEditor faz isso via KD.pendingHtml). */
  async function _kdCreateDocWith(html, title, link) {
    link = link && (link.clientId || link.projectId) ? link : {};
    const wsId = _kdWsFor(link);
    if (!wsId) { toast('Sem squad disponível pra criar documento.', 'error'); return; }
    try {
      // O HTML do modelo vira conteúdo do editor já na criação: o editor
      // colaborativo semeia a partir dele ao abrir (sem setContent atrasado).
      let content = null;
      if (html) { try { content = (await ensureBundle()).htmlToJSON(html); } catch (e) { console.warn('[modelo]', e); } }
      const doc = await api('/writer', 'POST', { workspaceId: wsId, title: title || 'Sem título', content, ...link });
      KD.docsList.unshift(doc);
      goEditor(doc);
    } catch (e) { toast(e.message || 'Falha ao criar documento.', 'error'); }
  }

  /* Templates de documento — HTML pré-preenchido. Escolhido no modal de "novo".
     Podem ser customizados/editados aqui sem toucar em nenhuma outra coisa. */
  /* Retorna a data de hoje no formato DD/MM/AAAA. */
  function _kdToday() {
    const d = new Date();
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }
  /* Dados do cliente/projeto escolhido no modal pros modelos. Sem cliente,
     os modelos mantêm o texto de exemplo. */
  function _kdCtx(ctx, key, fallback) {
    const c = ctx && ctx.client, pr = ctx && ctx.project;
    if (key === 'client') return esc(c ? c.name : 'Acme Ltda');
    if (key === 'me') return esc(KD.me?.name || KD.me?.username || '[seu nome]');
    if (key === 'subject') return esc(pr ? pr.name : c ? c.name : fallback);
    return '';
  }
  function _kdAboutClient(ctx) {
    const c = ctx && ctx.client;
    if (!c) return '';
    const g = String(c.guidelines || '').trim();
    const seg = String(c.segment || '').trim();
    if (!g && !seg) return '';
    const paras = g ? g.split(/\n{2,}/).map(t => '<p>' + esc(t).replace(/\n/g, '<br>') + '</p>').join('') : '';
    return '<h2>Sobre o cliente</h2>' + (seg ? '<p><strong>Segmento:</strong> ' + esc(seg) + '</p>' : '') + paras;
  }
  const KD_TEMPLATES = [
    {
      key: 'blank', title: 'Em branco', desc: 'Comece do zero', icon: '📄',
      preview: '<div class="kd-template-preview kd-template-preview--blank">+</div>',
      html: ''
    },
    {
      key: 'briefing', title: 'Briefing de projeto', desc: 'Contexto, escopo, prazos', icon: '📋',
      preview: `<div class="kd-template-preview">
        <strong>Briefing — Redesign do site</strong>
        <span class="kd-tp-line short"></span>
        <div class="kd-tp-h2">1. Contexto</div>
        <span class="kd-tp-line full"></span><span class="kd-tp-line full"></span><span class="kd-tp-line mid"></span>
        <div class="kd-tp-h2">2. Escopo</div>
        <span class="kd-tp-line full"></span><span class="kd-tp-line mid"></span>
        <div class="kd-tp-h2">3. Prazos</div>
        <table class="kd-tp-table"><thead><tr><th>Marco</th><th>Data</th></tr></thead><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table>
        <div class="kd-tp-callout">Precisa aprovação</div>
      </div>`,
      html: (ctx) => [
        '<h1>Briefing — ' + _kdCtx(ctx, 'subject', 'Redesign do site institucional') + '</h1>',
        '<p><strong>Cliente:</strong> ' + _kdCtx(ctx, 'client') + ' &nbsp;·&nbsp; <strong>Data:</strong> ' + _kdToday() + ' &nbsp;·&nbsp; <strong>Responsável:</strong> ' + _kdCtx(ctx, 'me') + '</p>',
        _kdAboutClient(ctx),
        '<h2>1. Contexto</h2>',
        '<p>O site atual está no ar há 4 anos e não reflete mais o posicionamento da marca. A taxa de conversão do formulário caiu 35% no último semestre e a versão mobile tem problemas de layout.</p>',
        '<h2>2. Objetivos</h2>',
        '<ul><li><strong>Aumentar conversão do formulário</strong> em pelo menos 20% em 3 meses após o go-live.</li><li>Modernizar identidade visual mantendo o roxo institucional.</li><li>Otimizar carregamento pra abaixo de 2s no mobile.</li></ul>',
        '<h2>3. Público-alvo</h2>',
        '<p>Gestores de marketing em empresas B2B de médio porte (50–500 funcionários). Perfil técnico moderado, decisão de compra colaborativa.</p>',
        '<h2>4. Escopo</h2>',
        '<h3>O que entra</h3>',
        '<ul><li>Wireframe + protótipo alta fidelidade das 8 páginas principais.</li><li>Design system básico (tokens de cor, tipografia, componentes).</li><li>Implementação front-end responsiva.</li></ul>',
        '<h3>O que NÃO entra</h3>',
        '<ul><li>Migração de conteúdo do blog (fica pro time interno).</li><li>Integração com CRM (fase 2).</li></ul>',
        '<h2>5. Prazos e marcos</h2>',
        '<table><thead><tr><th>Marco</th><th>Entrega</th><th>Responsável</th></tr></thead><tbody><tr><td>Kick-off + descoberta</td><td>Sem 1</td><td>Todos</td></tr><tr><td>Wireframes aprovados</td><td>Sem 3</td><td>Design</td></tr><tr><td>Protótipo alta fidelidade</td><td>Sem 5</td><td>Design</td></tr><tr><td>Front-end pronto</td><td>Sem 9</td><td>Dev</td></tr><tr><td>Go-live</td><td>Sem 10</td><td>Todos</td></tr></tbody></table>',
        '<h2>6. Referências</h2>',
        '<p>Sites que servem de inspiração: <a href="https://linear.app">linear.app</a>, <a href="https://vercel.com">vercel.com</a>.</p>',
        '<div data-callout="true" data-variant="warn"><p><strong>Aprovação necessária:</strong> este briefing precisa ser validado pelo cliente antes de iniciar. Ajustes de escopo depois do kick-off entram como change request.</p></div>'
      ].join('')
    },
    {
      key: 'sow', title: 'Escopo de trabalho', desc: 'Contrato: entregas + valor', icon: '📝',
      preview: `<div class="kd-template-preview">
        <strong>Escopo de Trabalho</strong>
        <span class="kd-tp-line mid"></span>
        <div class="kd-tp-h2">1. Objeto</div>
        <span class="kd-tp-line full"></span><span class="kd-tp-line mid"></span>
        <div class="kd-tp-h2">2. Entregas</div>
        <span class="kd-tp-line full"></span><span class="kd-tp-line full"></span>
        <div class="kd-tp-h2">3. Investimento</div>
        <span class="kd-tp-line short"></span>
        <div class="kd-tp-callout kd-tp-callout-info">Aceite ↔ assinatura</div>
      </div>`,
      html: (ctx) => [
        '<h1>Escopo de Trabalho — ' + _kdCtx(ctx, 'subject', 'Projeto Redesign') + '</h1>',
        '<p><strong>Contratante:</strong> ' + _kdCtx(ctx, 'client') + ' &nbsp;·&nbsp; <strong>Contratado:</strong> [Sua empresa] &nbsp;·&nbsp; <strong>Data:</strong> ' + _kdToday() + '</p>',
        '<h2>1. Objeto</h2>',
        '<p>Prestação de serviços de design e desenvolvimento front-end para o site institucional da Contratante, conforme especificações detalhadas no briefing anexo.</p>',
        '<h2>2. Entregas</h2>',
        '<ol><li><strong>Descoberta + wireframes</strong> (8 páginas) — 3 semanas.</li><li><strong>Design system + protótipo alta fidelidade</strong> — 2 semanas.</li><li><strong>Implementação front-end</strong> (HTML/CSS/JS responsivo) — 4 semanas.</li><li><strong>Deploy + treinamento do time</strong> — 1 semana.</li></ol>',
        '<h2>3. Cronograma</h2>',
        '<table><thead><tr><th>Etapa</th><th>Início</th><th>Fim</th></tr></thead><tbody><tr><td>Descoberta</td><td>01/10/2026</td><td>21/10/2026</td></tr><tr><td>Design</td><td>22/10/2026</td><td>04/11/2026</td></tr><tr><td>Dev front</td><td>05/11/2026</td><td>02/12/2026</td></tr><tr><td>Go-live</td><td>03/12/2026</td><td>10/12/2026</td></tr></tbody></table>',
        '<h2>4. Investimento</h2>',
        '<p><strong>R$ 45.000,00</strong> (quarenta e cinco mil reais), pagos em 3 parcelas iguais de R$ 15.000,00: na assinatura, na entrega do protótipo e no go-live.</p>',
        '<h2>5. Condições gerais</h2>',
        '<ul><li>Prazo de execução: 10 semanas corridas a partir do kick-off.</li><li>Até 3 ciclos de revisão por entrega inclusos.</li><li>Alterações fora do escopo original serão orçadas à parte em change request.</li><li>Propriedade intelectual dos arquivos finais é da Contratante após pagamento integral.</li></ul>',
        '<div data-callout="true" data-variant="info"><p><strong>Aceite:</strong> a assinatura eletrônica deste documento por representantes legais das duas partes valida o contrato e inicia a contagem dos prazos.</p></div>'
      ].join('')
    },
    {
      key: 'report', title: 'Relatório executivo', desc: 'KPIs + análise + próximos passos', icon: '📊',
      preview: `<div class="kd-template-preview">
        <strong>Relatório — Q3</strong>
        <div class="kd-tp-h2">Resumo executivo</div>
        <span class="kd-tp-line full"></span><span class="kd-tp-line mid"></span>
        <div class="kd-tp-cols"><div class="kd-tp-col"><strong>+18%</strong><br>MRR</div><div class="kd-tp-col"><strong>2.4k</strong><br>Leads</div><div class="kd-tp-col"><strong>92</strong><br>NPS</div></div>
        <div class="kd-tp-h2">Próximos passos</div>
        <span class="kd-tp-check">Ação 1</span><span class="kd-tp-check">Ação 2</span>
      </div>`,
      html: (ctx) => [
        '<h1>Relatório Executivo — Q3 2026</h1>',
        '<p><em>Preparado por: ' + _kdCtx(ctx, 'me') + (ctx && ctx.client ? ' &nbsp;·&nbsp; Cliente: ' + _kdCtx(ctx, 'client') : '') + ' &nbsp;·&nbsp; Publicado em: ' + _kdToday() + '</em></p>',
        '<h2>Resumo executivo</h2>',
        '<p>O Q3 fechou 18% acima do trimestre anterior em MRR, puxado por 3 grandes contas fechadas no segmento enterprise. NPS subiu 8 pontos após a entrega do novo onboarding. Principal desafio: churn na base SMB cresceu para 4.2%.</p>',
        '<h2>Principais resultados</h2>',
        '<div data-column-block="true" data-cols="3" style="grid-template-columns: repeat(3, 1fr);"><div data-column="true"><h3 style="text-align:center">+18%</h3><p style="text-align:center;color:#26a65b"><strong>MRR</strong><br>vs. Q2</p></div><div data-column="true"><h3 style="text-align:center">2.4k</h3><p style="text-align:center"><strong>Novos leads</strong><br>+12% vs. meta</p></div><div data-column="true"><h3 style="text-align:center">92</h3><p style="text-align:center"><strong>NPS</strong><br>+8 pts</p></div></div>',
        '<h2>Análise detalhada</h2>',
        '<h3>O que funcionou</h3>',
        '<ul><li>Novo onboarding reduziu tempo até "primeira valor" de 12 pra 5 dias.</li><li>Campanha no LinkedIn trouxe 40% dos leads qualificados.</li></ul>',
        '<h3>O que precisa atenção</h3>',
        '<ul><li>Churn SMB em 4.2% — investigar drivers (feature gap? preço? suporte?).</li><li>CAC subiu 8% — canais orgânicos perdendo tração.</li></ul>',
        '<h2>Próximos passos</h2>',
        '<ul data-type="taskList" class="kd-task-list"><li data-checked="false" class="kd-task-item"><label><input type="checkbox"></label><div><p>Pesquisar 20 contas SMB que deram churn nas últimas 4 semanas.</p></div></li><li data-checked="false" class="kd-task-item"><label><input type="checkbox"></label><div><p>Rodar experimento de preço com plano intermediário.</p></div></li><li data-checked="false" class="kd-task-item"><label><input type="checkbox"></label><div><p>Redistribuir 15% do orçamento de Google Ads pra content marketing.</p></div></li></ul>',
        '<h2>Riscos e bloqueios</h2>',
        '<div data-callout="true" data-variant="danger"><p><strong>Atenção:</strong> se o churn SMB seguir crescendo, o crescimento líquido do Q4 pode ficar flat mesmo com boa aquisição.</p></div>'
      ].join('')
    },
    {
      key: 'meeting', title: 'Ata de reunião', desc: 'Presentes, decisões, ações', icon: '🗓',
      preview: `<div class="kd-template-preview">
        <strong>Ata — Sprint planning</strong>
        <span class="kd-tp-line short"></span>
        <div class="kd-tp-h2">Pauta</div>
        <span class="kd-tp-line full"></span><span class="kd-tp-line mid"></span>
        <div class="kd-tp-h2">Decisões</div>
        <span class="kd-tp-line full"></span>
        <div class="kd-tp-h2">Ações</div>
        <span class="kd-tp-check">@a — task</span><span class="kd-tp-check">@b — task</span>
      </div>`,
      html: (ctx) => [
        '<h1>Ata — Sprint planning #14</h1>',
        '<p><strong>Data:</strong> ' + _kdToday() + ' &nbsp;·&nbsp; <strong>Horário:</strong> 10:00–11:30 &nbsp;·&nbsp; <strong>Local:</strong> Meet</p>',
        '<p><strong>Presentes:</strong> ' + _kdCtx(ctx, 'me') + (ctx && ctx.client ? ', equipe ' + _kdCtx(ctx, 'client') : ', Product Owner, Tech Lead, 2 devs, 1 designer') + '</p>',
        '<h2>Pauta</h2>',
        '<ol><li>Revisão do sprint anterior (velocity + entregas)</li><li>Priorização do backlog</li><li>Definição do escopo do próximo sprint</li></ol>',
        '<h2>Discussões e decisões</h2>',
        '<h3>1. Retrospectiva rápida do sprint 13</h3>',
        '<p>Fechamos 32 story points de 38 planejados (84%). O que atrasou: bug crítico na API de pagamento consumiu 2 dias do backend.</p>',
        '<p><strong>Decisão:</strong> reservar 20% do sprint pra bugs/tech debt daqui pra frente, em vez de bloquear 100% em features.</p>',
        '<h3>2. Prioridade do próximo sprint</h3>',
        '<p>Debate entre fechar a integração com Stripe (revenue impact) vs. redesign do checkout (conversão).</p>',
        '<p><strong>Decisão:</strong> Stripe primeiro (2 semanas), checkout entra no sprint seguinte.</p>',
        '<h2>Ações</h2>',
        '<ul data-type="taskList" class="kd-task-list"><li data-checked="false" class="kd-task-item"><label><input type="checkbox"></label><div><p>Devs — quebrar tickets da integração Stripe em subtarefas &lt;1d cada — <em>até quarta</em></p></div></li><li data-checked="false" class="kd-task-item"><label><input type="checkbox"></label><div><p>PO — atualizar roadmap público com data revisada do checkout — <em>até sexta</em></p></div></li><li data-checked="false" class="kd-task-item"><label><input type="checkbox"></label><div><p>Tech lead — revisar plano de rollback do Stripe com o time de infra — <em>antes do deploy</em></p></div></li></ul>',
        '<h2>Próxima reunião</h2>',
        '<p>Sprint review em 2 semanas, mesma hora. Convite no Google Calendar.</p>'
      ].join('')
    },
    {
      key: 'onepager', title: 'One-pager', desc: 'Resumo visual em 1 página', icon: '🎯',
      preview: `<div class="kd-template-preview">
        <strong style="text-align:center">Projeto X</strong>
        <div class="kd-tp-callout kd-tp-callout-info" style="text-align:center">Proposta de valor</div>
        <div class="kd-tp-cols" style="grid-template-columns: 1fr 1fr"><div class="kd-tp-col"><strong>Problema</strong><br><span class="kd-tp-line full"></span></div><div class="kd-tp-col"><strong>Solução</strong><br><span class="kd-tp-line full"></span></div></div>
        <div class="kd-tp-cols"><div class="kd-tp-col"><strong>10x</strong></div><div class="kd-tp-col"><strong>30%</strong></div><div class="kd-tp-col"><strong>R$0</strong></div></div>
      </div>`,
      html: (ctx) => [
        '<h1 style="text-align:center">Projeto Copiloto — one-pager</h1>',
        '<p style="text-align:center"><em>Assistente de IA que responde dúvidas de clientes usando a base de conhecimento da empresa</em></p>',
        '<div data-callout="true" data-variant="info"><p style="text-align:center"><strong>Reduz em 60% o tempo médio de resposta do suporte, mantendo a qualidade das respostas com fontes citadas.</strong></p></div>',
        '<div data-column-block="true" data-cols="2" style="grid-template-columns: repeat(2, 1fr);"><div data-column="true"><h3>Problema</h3><p>Time de suporte responde 800+ tickets/mês. 40% são dúvidas já respondidas na base — mas o cliente não encontra sozinho.</p></div><div data-column="true"><h3>Solução</h3><p>Chat com IA na página do produto que puxa contexto da base + histórico do cliente. Se não sabe, escala pro humano com o contexto pronto.</p></div></div>',
        '<h2>Números-chave (projeção 6 meses)</h2>',
        '<div data-column-block="true" data-cols="3" style="grid-template-columns: repeat(3, 1fr);"><div data-column="true"><h2 style="text-align:center;color:#26a65b">-60%</h2><p style="text-align:center"><strong>Tempo resposta</strong><br>de 8h → 3h</p></div><div data-column="true"><h2 style="text-align:center;color:#4a90e2">+15pts</h2><p style="text-align:center"><strong>CSAT</strong><br>projeção</p></div><div data-column="true"><h2 style="text-align:center;color:#7A00FF">R$120k</h2><p style="text-align:center"><strong>Economia/ano</strong><br>em headcount</p></div></div>',
        '<h2>Como funciona</h2>',
        '<ol><li>Cliente pergunta no chat da página do produto.</li><li>IA busca na base + docs + tickets antigos.</li><li>Responde com fontes citadas ou escala pro humano com contexto.</li></ol>',
        '<div data-callout="true" data-variant="tip"><p><strong>Próximo passo:</strong> POC de 4 semanas com 100 tickets/dia pra validar a projeção.</p></div>'
      ].join('')
    }
  ];

  /* Abre modal com grid de templates. Click → cria doc com o HTML do template.
     Cada card tem preview visual (mini-página estilizada) + meta (ícone, título,
     descrição). Grid é 3 colunas em desktop, 2 em tablet, 1 em mobile. */
  function _kdOpenTemplatesModal(preset) {
    const R = KD.refData || {};
    const sel = { clientId: null, projectId: null };
    if (preset && preset.projectId) {
      const pr = (R.projects || []).find(x => x.id === preset.projectId);
      if (pr) { sel.projectId = pr.id; sel.clientId = pr.clientId || null; }
    } else if (preset && preset.clientId && (R.clients || []).some(x => x.id === preset.clientId)) {
      sel.clientId = preset.clientId;
    }
    let overlay = document.getElementById('kd-templates-modal');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'kd-templates-modal';
    overlay.className = 'kd-modal-overlay';
    overlay.innerHTML = `
      <div class="kd-modal kd-modal--wide">
        <div class="kd-modal-head">
          <div class="kd-modal-title">Novo documento</div>
          <div class="kd-tpl-for">
            <span>Para</span>
            <button type="button" class="kd-tpl-for-btn" id="kd-tpl-for-btn"></button>
          </div>
          <button type="button" class="kd-icon-btn" onclick="_kdCloseTemplatesModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="kd-modal-body">
          <div class="kd-templates-grid">
            ${KD_TEMPLATES.map(t => `
              <button type="button" class="kd-template-card" data-key="${esc(t.key)}" title="${esc(t.title)}">
                ${t.preview || '<div class="kd-template-preview kd-template-preview--blank">+</div>'}
                <div class="kd-template-meta">
                  <div class="kd-template-icon">${t.icon}</div>
                  <div class="kd-template-text">
                    <div class="kd-template-title">${esc(t.title)}</div>
                    <div class="kd-template-desc">${esc(t.desc)}</div>
                  </div>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _kdCloseTemplatesModal(); });
    // "Para": cliente ou projeto (opcional) — preenche o modelo e vincula o doc
    const forBtn = overlay.querySelector('#kd-tpl-for-btn');
    const paintFor = () => {
      const pr = sel.projectId && (R.projects || []).find(x => x.id === sel.projectId);
      const cl = sel.clientId && (R.clients || []).find(x => x.id === sel.clientId);
      forBtn.innerHTML = cl || pr
        ? `<span class="kd-suggest-dot" style="background:${esc((pr || cl).color || '#7A00FF')}"></span>${esc(cl ? cl.name : '')}${pr ? `<span class="kd-tpl-for-sep">›</span>${esc(pr.name)}` : ''}`
        : '<span class="kd-tpl-for-empty">Nenhum cliente</span>';
      forBtn.insertAdjacentHTML('beforeend', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>');
    };
    paintFor();
    forBtn.addEventListener('click', () => {
      window.KDUI?.pickEntity(forBtn, {
        title: 'Documento para…', allowClear: !!(sel.clientId || sel.projectId),
        current: sel.projectId ? { kind: 'project', id: sel.projectId } : sel.clientId ? { kind: 'client', id: sel.clientId } : null,
        onPick: (it) => {
          if (!it) { sel.clientId = null; sel.projectId = null; }
          else if (it.kind === 'project') { const pr = (R.projects || []).find(x => x.id === it.id); sel.projectId = it.id; sel.clientId = pr?.clientId || null; }
          else { sel.clientId = it.id; sel.projectId = null; }
          paintFor();
        }
      });
    });
    overlay.querySelectorAll('[data-key]').forEach(el => {
      el.addEventListener('click', () => {
        const t = KD_TEMPLATES.find(x => x.key === el.dataset.key);
        _kdCloseTemplatesModal();
        if (!t) return;
        const link = { clientId: sel.clientId, projectId: sel.projectId };
        if (t.key === 'blank') return createDoc(link);
        const ctx = {
          client: sel.clientId ? (R.clients || []).find(x => x.id === sel.clientId) : null,
          project: sel.projectId ? (R.projects || []).find(x => x.id === sel.projectId) : null
        };
        // html pode ser string OU function (que gera na hora, com data atual).
        const html = typeof t.html === 'function' ? t.html(ctx) : t.html;
        const subject = ctx.project ? ctx.project.name : ctx.client ? ctx.client.name : '';
        _kdCreateDocWith(html, t.title + (subject ? ' — ' + subject : ''), link);
      });
    });
  }
  window._kdOpenTemplatesModal = _kdOpenTemplatesModal;
  window._kdCloseTemplatesModal = () => document.getElementById('kd-templates-modal')?.remove();

  /* Abre file picker pra importar DOCX/TXT/etc → POST /api/writer/import →
     cria novo doc com o HTML retornado. */
  function _kdImportPickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,.doc,.odt,.rtf,.txt,.md,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/vnd.oasis.opendocument.text,application/rtf,text/plain,text/markdown,text/html';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = (input.files || [])[0];
      document.body.removeChild(input);
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) { toast('Arquivo excede 50 MB.', 'error'); return; }
      toast('Convertendo "' + file.name + '"…', 'info');
      try {
        const dataUri = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.readAsDataURL(file);
        });
        const resp = await fetch('/api/writer/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name: file.name, data: dataUri })
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || ('HTTP ' + resp.status));
        }
        const { html } = await resp.json();
        const title = file.name.replace(/\.[a-z0-9]{1,10}$/i, '');
        // Cria doc vazio + guarda HTML em localStorage keyed pelo id +
        // abre em NOVA ABA. A nova aba mounta o editor e, no _pendingImport,
        // consome o localStorage e chama setContent com o HTML.
        const wsId = ($('kd-f-ws')?.value) || (KD.me?.workspaces && KD.me.workspaces[0]) || (KD.workspaces[0]?.id);
        if (!wsId) { toast('Sem squad disponível pra criar documento.', 'error'); return; }
        const doc = await api('/writer', 'POST', { workspaceId: wsId, title, content: null });
        try { localStorage.setItem('kd:pendingImport:' + doc.id, html); } catch {}
        // Atualiza a lista de recentes em background pro user ver o novo item
        // se voltar pra home.
        KD.docsList.unshift(doc);
        if (typeof renderList === 'function') { try { renderList(); } catch {} }
        // Abre em nova aba
        window.open('/hub/docs/' + docSlug(doc), '_blank');
        toast('Importado! Abrindo em nova aba…', 'success');
      } catch (e) {
        toast('Falha ao importar: ' + (e.message || 'erro'), 'error');
      }
    });
    input.click();
  }
  window._kdImportPickFile = _kdImportPickFile;

  /* Provider de items pro Mention (extension). Filtra usuários por query. */
  /* Menções: mesma cara dos avatares da plataforma — foto quando tem, senão
     a inicial sobre o degradê fixo da pessoa (mesmo hash do app.js). */
  const KD_AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #FF6B6B 0%, #C92A2A 100%)', 'linear-gradient(135deg, #F8A055 0%, #D14A1F 100%)',
    'linear-gradient(135deg, #FFB84D 0%, #B8860B 100%)', 'linear-gradient(135deg, #FFD93D 0%, #E07B00 100%)',
    'linear-gradient(135deg, #8BC34A 0%, #2E7D32 100%)', 'linear-gradient(135deg, #4ECDC4 0%, #1B9E96 100%)',
    'linear-gradient(135deg, #44BCD8 0%, #0277B6 100%)', 'linear-gradient(135deg, #6FA8DC 0%, #1A5490 100%)',
    'linear-gradient(135deg, #4A6FE3 0%, #2E3B8E 100%)', 'linear-gradient(135deg, #7A6BE8 0%, #3F2DA5 100%)',
    'linear-gradient(135deg, #9C6FE8 0%, #6128D7 100%)', 'linear-gradient(135deg, #C77DFF 0%, #7A00FF 100%)',
    'linear-gradient(135deg, #E6A0E0 0%, #A93FA8 100%)', 'linear-gradient(135deg, #F472B6 0%, #BE185D 100%)'
  ];
  function _kdAvatarGradient(seed) {
    const key = String(seed || '?');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) >>> 0;
    return KD_AVATAR_GRADIENTS[h % KD_AVATAR_GRADIENTS.length];
  }
  window.kdMentionItems = (query) => {
    if (!KD.usersById) return [];
    const nrm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const q = nrm(query).trim();
    const rows = [];
    for (const u of KD.usersById.values()) {
      if (u.active === false) continue;
      const name = nrm(u.name || u.username);
      const hit = !q ? 2 : name.startsWith(q) ? 0 : name.split(/\s+/).some(w => w.startsWith(q)) ? 1 : (name.includes(q) || nrm(u.email).includes(q) || nrm(u.username).includes(q)) ? 2 : -1;
      if (hit < 0) continue;
      rows.push({ u, hit });
    }
    rows.sort((a, b) => a.hit - b.hit || String(a.u.name || '').localeCompare(String(b.u.name || ''), 'pt-BR'));
    return rows.slice(0, 8).map(({ u }) => ({
      id: u.id,
      name: u.name || u.username || 'Usuário',
      role: [u.position, u.role].filter(Boolean).join(' · '),
      color: _kdAvatarGradient(u.id || u.username || u.name),
      avatar: u.avatar || null
    }));
  };

  /* Retorna true se o doc atual é "vazio de nascença": foi criado agora,
     título permanece "Sem título" e o PM JSON só tem parágrafos vazios. */
  function _kdCurrentDocIsUntouched() {
    const doc = KD.currentDoc;
    if (!doc || !doc._justCreated) return false;
    if ((doc.title || '').trim() && doc.title !== 'Sem título') return false;
    if (!KD.editor) return true; // ainda não montou → nada foi digitado
    const json = KD.editor.getJSON();
    if (!json || !Array.isArray(json.content)) return true;
    // "Vazio" = zero nodes, ou só parágrafos/headings sem texto e sem nodes
    return json.content.every(n => {
      if (!n) return true;
      if (n.type !== 'paragraph' && n.type !== 'heading') return false;
      if (!Array.isArray(n.content) || n.content.length === 0) return true;
      return n.content.every(c => c.type === 'text' ? !(c.text || '').trim() : false);
    });
  }
  /* Deleta o doc atual sem confirmação — só chamado pra rascunhos vazios. */
  async function _kdDeleteUntouchedDoc() {
    const doc = KD.currentDoc;
    if (!doc) return;
    try {
      await api('/writer/' + doc.id, 'DELETE');
      KD.docsList = KD.docsList.filter(d => d.id !== doc.id);
    } catch {}
  }

  // ── Viewer público (leitura via link) ─────────────────────────────────
  async function openPublicViewer(token) {
    setStatus('loading', 'Carregando…');
    try {
      const [bundle, doc] = await Promise.all([
        ensureBundle(),
        fetch('/api/writer/public/' + encodeURIComponent(token))
          .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Erro'); return d; })
      ]);
      teardownEditor();
      KD.currentDoc = doc;
      KD.myRole = 'viewer';
      // Título só como texto (input pode ficar readOnly)
      const titleIn = $('writer-title-input');
      if (titleIn) { titleIn.value = doc.title || ''; titleIn.readOnly = true; }
      document.title = (doc.title || 'Documento') + ' — reWork Docs';
      // Esconde tudo que não faz sentido em modo público
      // Visitante: sem menus, sem barra, sem voltar — só o documento e o tema
      document.querySelectorAll('.writer-topbar-actions > button').forEach(b => {
        if (b.getAttribute('title') !== 'Alternar tema') b.hidden = true;
      });
      document.querySelectorAll('.kd-ed-back, #kd-menubar, #writer-editor-toolbar, #kd-doc-link, #kd-approval-badge').forEach(el => { el.hidden = true; });
      _kdPublicApprovalBar(token, doc);

      const mount = $('writer-editor-mount');
      mount.innerHTML = '';
      // Instancia editor read-only, SEM colab (não conecta ao WS público)
      const editor = bundle.createReadOnlyEditor
        ? bundle.createReadOnlyEditor(mount, { initialJSON: doc.content || bundle.emptyDoc() })
        : bundle.createCollabEditor(mount, {
            docId: doc.id, wsUrl: 'ws://invalid', initialJSON: doc.content || bundle.emptyDoc(),
            user: { name: 'Visitante', color: '#888', avatar: null, id: null },
            placeholder: 'Documento em modo leitura', autofocus: false, editable: false,
            onUpdate: () => {}, onSelectionUpdate: () => {}, onStatus: () => {}
          });
      KD.editor = editor.editor || editor;
      _kdOutlineRefresh();
      _kdApplyLayout();
      setStatus('saved', 'Documento público (leitura)');
    } catch (e) {
      $('writer-editor-mount').innerHTML =
        `<div style="padding:40px 20px;text-align:center;color:var(--text-2)">
          <h3 style="margin:0 0 8px">Link inválido ou revogado</h3>
          <p style="margin:0;font-size:13px">${esc(e.message || 'Documento não encontrado.')}</p>
        </div>`;
      setStatus('error', 'Erro');
    }
  }

  /* Barra de aprovação no link público: aparece quando o time pediu
     aprovação. O cliente aprova ou pede ajustes (com nome + comentário). */
  function _kdPublicApprovalBar(token, doc) {
    document.getElementById('kd-pub-approval')?.remove();
    const a = doc.approval;
    if (!a) return;
    const bar = document.createElement('div');
    bar.id = 'kd-pub-approval';
    bar.className = 'kd-pub-approval';
    const nameKey = 'kd-approver-name';
    let savedName = ''; try { savedName = localStorage.getItem(nameKey) || ''; } catch {}
    const paintDone = (ap) => {
      const ok = ap.status === 'approved';
      bar.className = 'kd-pub-approval is-done ' + (ok ? 'is-approved' : 'is-changes');
      bar.innerHTML = `<div class="kd-pub-approval-text"><strong>${ok ? 'Documento aprovado' : 'Ajustes pedidos'}</strong>
        <span>${esc(ap.decidedBy || '')}${ap.decidedAt ? ' · ' + esc(new Date(ap.decidedAt).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })) : ''}${ap.comment ? ' — ' + esc(ap.comment) : ''}</span></div>`;
    };
    if (a.status !== 'pending') { paintDone(a); document.querySelector('.writer-editor-view')?.appendChild(bar); return; }
    bar.innerHTML = `
      <div class="kd-pub-approval-text"><strong>Este documento aguarda sua aprovação</strong><span>Leia com calma e responda aqui mesmo.</span></div>
      <div class="kd-pub-approval-actions">
        <button type="button" class="btn btn-ghost" data-d="changes">Pedir ajustes</button>
        <button type="button" class="btn btn-confirm" data-d="approved">Aprovar</button>
      </div>`;
    document.querySelector('.writer-editor-view')?.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      const decision = b.dataset.d;
      const bd = document.createElement('div');
      bd.className = 'kd-dialog-backdrop';
      bd.innerHTML = `<div class="kd-dialog" role="dialog" aria-modal="true">
        <div class="kd-dialog-head"><div class="kd-dialog-title">${decision === 'approved' ? 'Aprovar documento' : 'Pedir ajustes'}</div></div>
        <form class="kd-dialog-body kd-dform">
          <label class="kd-dform-field"><span>Seu nome</span><input name="name" maxlength="80" required value="${esc(savedName)}"></label>
          <label class="kd-dform-field"><span>${decision === 'approved' ? 'Comentário (opcional)' : 'O que precisa mudar?'}</span><textarea name="comment" rows="4" maxlength="2000" ${decision === 'changes' ? 'required' : ''}></textarea></label>
          <div class="kd-dform-actions">
            <button type="button" class="btn btn-ghost" data-x>Cancelar</button>
            <button type="submit" class="btn ${decision === 'approved' ? 'btn-confirm' : 'btn-primary'}">${decision === 'approved' ? 'Aprovar' : 'Enviar ajustes'}</button>
          </div>
        </form></div>`;
      document.body.appendChild(bd);
      const close = () => bd.remove();
      bd.addEventListener('click', (ev) => { if (ev.target === bd || ev.target.closest('[data-x]')) close(); });
      const form = bd.querySelector('form');
      (savedName ? form.comment : form.name).focus();
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
        try {
          const r = await fetch('/api/writer/public/' + encodeURIComponent(token) + '/approval', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, name: form.name.value.trim(), comment: form.comment.value.trim() })
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || 'Não foi possível enviar.');
          try { localStorage.setItem(nameKey, form.name.value.trim()); } catch {}
          close();
          paintDone(d.approval);
          toast(decision === 'approved' ? 'Obrigado! Aprovação enviada.' : 'Obrigado! Ajustes enviados pro time.');
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    });
  }

  async function openEditor(id) {
    setStatus('loading', 'Carregando…');
    try {
      const [bundle, doc] = await Promise.all([ensureBundle(), api('/writer/' + id)]);
      teardownEditor();
      KD.currentDoc = doc;
      KD.lastSavedVersion = doc.version || 0;
      KD.dirty = false;
      $('writer-title-input').value = doc.title || '';
      const mount = $('writer-editor-mount');
      mount.innerHTML = '';

      // WS URL — mesmo host que serviu a página, protocolo casa com HTTP/HTTPS
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrlBase = wsProto + '//' + location.host + '/rt/docs';
      const user = _localUserForCollab();

      // Determina role: editor/commenter/viewer/owner. Se veio null do server,
      // o user não deveria estar aqui — trata como viewer defensivo.
      KD.myRole = doc.myRole || 'viewer';
      const canEdit = KD.myRole === 'editor' || KD.myRole === 'owner';

      const collab = bundle.createCollabEditor(mount, {
        docId: doc.id,
        wsUrl: wsUrlBase,
        initialJSON: doc.content || bundle.emptyDoc(),
        user,
        placeholder: canEdit ? 'Comece a escrever ou pressione / para comandos…' : 'Documento em modo leitura',
        autofocus: canEdit,
        editable: canEdit,
        onUpdate: () => {
          KD.dirty = true; scheduleSave();
          if (KD._status !== 'saving') setStatus('saving', 'Salvando…');
          _kdAfterChange();
        },
        onSelectionUpdate: () => { _kdRulerRefresh(); },
        onStatus: (s) => {
          KD.connStatus = s;
          renderPresence();
          if (s === 'connected' && !KD.dirty) setStatus('saved', canEdit ? 'Sincronizado' : 'Modo leitura');
          if (s === 'disconnected') setStatus('error', 'Desconectado — reconectando…');
        }
      });
      KD.collab = collab;
      KD.editor = collab.editor;
      // Se o doc foi criado com HTML pré-preenchido (template ou import),
      // injeta agora que o editor tá montado. Aguarda um tick pro Yjs
      // conectar antes de setContent (senão a operação some no re-sync).
      // Fontes possíveis:
      // 1. doc._pendingHtml → template escolhido no modal (mesma aba).
      // 2. localStorage["kd:pendingImport:<id>"] → import de DOCX/TXT feito
      //    numa aba anterior (a home) que abriu esta aba nova.
      let pendingHtml = doc._pendingHtml || null;
      if (!pendingHtml) {
        try {
          const key = 'kd:pendingImport:' + doc.id;
          pendingHtml = localStorage.getItem(key);
          if (pendingHtml) localStorage.removeItem(key);
        } catch {}
      }
      if (pendingHtml) {
        doc._pendingHtml = null;
        setTimeout(() => {
          try { KD.editor?.commands.setContent(pendingHtml, false, { preserveWhitespace: 'full' }); }
          catch (e) { console.warn('[setContent pending]', e); }
        }, 600);
      }
      _kdApplyRoleUI();
      window.KDUI && window.KDUI.mount();
      _kdRenderDocMeta();
      // Índice do doc: 1º render após o editor montar
      _kdOutlineRefresh();
      _kdApplyLayout();
      _kdRulerRefresh();
      // Carrega threads + renderiza balões flutuantes (não depende do painel)
      kdCommentsLoad();

      // Menu de contexto custom no editor (substitui o do browser)
      _kdBindContextMenu(mount);
      // Interações com imagens (click pra selecionar/resize, right-click menu)
      _kdBindImageInteractions(mount);

      // Scroll no topo — várias vezes ao longo de ~1.5s pra vencer:
      //  - autofocus do TipTap tentando scrollar cursor pra visão
      //  - pagination reajustando min-height do paper (debounce 120ms)
      //  - Yjs "synced" trazendo conteúdo remoto após o mount
      //  - browser restore scroll de navegação anterior
      // Cancela assim que o user scrollar de verdade (evita brigar com ele).
      const scroll = document.querySelector('.writer-editor-scroll');
      if (scroll) {
        let userScrolled = false;
        const onUserScroll = () => { userScrolled = true; scroll.removeEventListener('wheel', onUserScroll); scroll.removeEventListener('touchmove', onUserScroll); scroll.removeEventListener('keydown', onUserScroll); };
        scroll.addEventListener('wheel', onUserScroll, { passive: true, once: true });
        scroll.addEventListener('touchmove', onUserScroll, { passive: true, once: true });
        scroll.addEventListener('keydown', onUserScroll, { once: true });
        [0, 60, 200, 500, 900, 1400].forEach(ms => setTimeout(() => {
          if (!userScrolled) scroll.scrollTop = 0;
        }, ms));
      }

      // Presence: escuta awareness pra pintar avatares dos peers.
      // Track lastSeenAt por peer pra ring de atividade (verde/amarelo/cinza).
      KD._peerLastSeen = new Map(); // clientId → timestamp ms
      collab.provider.awareness.on('change', ({ added, updated, removed }) => {
        const now = Date.now();
        for (const cid of [...added, ...updated]) KD._peerLastSeen.set(cid, now);
        for (const cid of removed) KD._peerLastSeen.delete(cid);
        renderPresence();
      });
      // Re-render a cada 20s pra atualizar os rings sem esperar update do peer
      if (KD._presenceTimer) clearInterval(KD._presenceTimer);
      KD._presenceTimer = setInterval(renderPresence, 20000);
      renderPresence();

      renderToolbar();
      setStatus('saved', 'Salvo');
      _kdSyncTitle();
      _kdUpdateWordCount();
      // Carrega comentários em background (não bloqueia editor)
      kdCommentsLoad();
    } catch (e) {
      setStatus('error', e.message || 'Erro ao abrir');
      toast(e.message || 'Falha ao abrir documento.', 'error');
    }
  }
  /* Aplica a UI baseada em role. Chamado no openEditor.
     - viewer: sem toolbar, sem title editável, sem delete, sem comment button,
               sem share (só o owner tem)
     - commenter: sem toolbar de edit, mas botão de comment ativo, sem delete
     - editor: tudo normal, sem share
     - owner: tudo + share */
  function _kdApplyRoleUI() {
    const role = KD.myRole || 'viewer';
    const canEdit    = role === 'editor'    || role === 'owner';
    const canComment = canEdit              || role === 'commenter';
    const canShare   = role === 'owner';
    const view = document.querySelector('.writer-editor-view');
    if (view) view.dataset.role = role;
    // Toolbar de formatação
    const tb = $('writer-editor-toolbar');
    if (tb) tb.style.display = canEdit ? '' : 'none';
    // Title editável só se editor+
    const title = $('writer-title-input');
    if (title) title.readOnly = !canEdit;
    // Delete só owner
    const delBtn = document.querySelector('.writer-topbar-actions button[title="Excluir"]');
    if (delBtn) delBtn.style.display = canShare ? '' : 'none';
    // Share só owner
    const shareBtn = document.querySelector('.kd-topbar-share-btn');
    if (shareBtn) shareBtn.style.display = canShare ? '' : 'none';
    // Comment button
    const cmtBtn = $('kd-topbar-comments-btn');
    if (cmtBtn) cmtBtn.style.display = canComment ? '' : 'none';
    // Se não pode comentar, força painel fechado
    if (!canComment) {
      const p = $('kd-comments-panel'); if (p) p.hidden = true; KDC.panelOpen = false;
    }
    // Badge visual no topbar (quando não é editor)
    let banner = $('kd-role-banner');
    if (!canEdit) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'kd-role-banner';
        banner.className = 'kd-role-banner';
        const topbar = document.querySelector('.writer-editor-topbar');
        if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(banner, topbar.nextSibling);
      }
      banner.textContent = role === 'commenter'
        ? 'Você está no modo comentarista — pode selecionar trechos e comentar, mas não editar o texto.'
        : 'Você está no modo leitor — o documento está em somente leitura.';
    } else if (banner) { banner.remove(); }
  }

  function teardownEditor() {
    if (KD.saveTimer) { clearTimeout(KD.saveTimer); KD.saveTimer = null; }
    // Rascunho vazio → remove do server antes de derrubar o editor.
    // Fire-and-forget: renderização da lista roda logo depois e o filter
    // local já foi aplicado no _kdDeleteUntouchedDoc.
    if (_kdCurrentDocIsUntouched()) _kdDeleteUntouchedDoc();
    window.KDUI && window.KDUI.teardown();
    if (KD.collab) { try { KD.collab.destroy(); } catch {} KD.collab = null; }
    else if (KD.editor) { try { KD.editor.destroy(); } catch {} }
    KD.editor = null;
    KD.currentDoc = null;
    KD.dirty = false;
    _clearPresence();
  }

  /* Deriva a "identidade" do usuário local pra awareness — cor estável por user id. */
  function _localUserForCollab() {
    const u = KD.me || {};
    return {
      id: u.id || null,     // identificação estável — usada pra abrir o miniperfil
      name:  u.name || u.username || 'Usuário',
      color: _colorForUser(u.id || u.username || 'anon'),
      avatar: u.avatar || null
    };
  }
  /* Paleta discreta (rótulos de cursor com boa legibilidade em bg claro E escuro).
     Hash simples do id/username → índice determinístico. */
  const _PRESENCE_COLORS = ['#7A00FF','#00B894','#0984E3','#E17055','#FDCB6E','#D63031','#6C5CE7','#00CEC9','#E84393','#2D3436'];
  function _colorForUser(seed) {
    let h = 0;
    for (const c of String(seed)) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
    return _PRESENCE_COLORS[Math.abs(h) % _PRESENCE_COLORS.length];
  }

  /* Renderiza avatares dos peers no topbar, com ring de atividade:
     - verde  → ativo agora (<1min desde último update)
     - amarelo→ ativo há 1..10min
     - cinza + grayscale → parado há >10min
     Dedupe por nome+cor (não temos user.id no awareness).
     Pega o lastSeen MAIS RECENTE entre os clientIds do mesmo nome (múltiplas abas). */
  function renderPresence() {
    if (!KD.collab) return _clearPresence();
    let host = document.getElementById('kd-presence');
    if (!host) {
      const tb = document.querySelector('.writer-editor-topbar');
      if (!tb) return;
      host = document.createElement('div');
      host.id = 'kd-presence';
      host.className = 'kd-presence-stack';
      const actions = tb.querySelector('.writer-topbar-actions');
      if (actions) tb.insertBefore(host, actions);
      else tb.appendChild(host);
    }
    const now = Date.now();
    const states = KD.collab.provider.awareness.getStates();
    // Agrupa por identidade (user.id prioritário; fallback name+color pra
    // não perder peers sem id — versões antigas do bundle não passavam id).
    const byId = new Map();
    for (const [cid, s] of states) {
      if (!s || !s.user) continue;
      const key = s.user.id || (s.user.name + '|' + s.user.color);
      const lastSeen = KD._peerLastSeen?.get(cid) || now;
      const cur = byId.get(key);
      if (!cur || lastSeen > cur.lastSeen) byId.set(key, { user: s.user, lastSeen });
    }
    const peers = Array.from(byId.values());
    host.innerHTML = peers.slice(0, 6).map(p => {
      const age = now - p.lastSeen;
      let state = 'active';
      if (age > 10 * 60 * 1000)      state = 'idle-long';
      else if (age > 60 * 1000)      state = 'idle';
      const inner = p.user.avatar
        ? `<img src="${esc(p.user.avatar)}" alt="">`
        : esc((p.user.name || '?').charAt(0).toUpperCase());
      // `data-user-id` habilita o miniperfil no hover
      const uid = p.user.id ? ` data-user-id="${esc(p.user.id)}"` : '';
      return `<div class="kd-presence-avatar kd-presence-avatar--${state}"${uid} style="background:${esc(p.user.color)}" title="${esc(p.user.name)} — ${_kdActivityLabel(age)}">${inner}</div>`;
    }).join('') + (peers.length > 6 ? `<div class="kd-presence-more">+${peers.length - 6}</div>` : '');
    _kdBindPresenceHovers();
  }
  // ── Miniperfil (hover nos avatares de presença) ─────────────────────
  /* Reusa o CSS .user-mini-card do style.css. Hover no avatar (350ms) abre;
     mouseleave fecha após 180ms de graça (permite mover mouse pro card).
     No CSS o card usa lucide icons — como não temos paintIcons() aqui,
     substituímos por SVGs inline nos mesmos tamanhos. */
  const _mp = { card: null, showTimer: null, hideTimer: null };
  function _kdBindPresenceHovers() {
    const stack = document.getElementById('kd-presence');
    if (!stack || stack._boundHover) return;
    stack._boundHover = true;
    stack.addEventListener('mouseover', (e) => {
      const a = e.target.closest('.kd-presence-avatar[data-user-id]');
      if (!a) return;
      clearTimeout(_mp.hideTimer);
      clearTimeout(_mp.showTimer);
      _mp.showTimer = setTimeout(() => _kdShowMiniProfile(a.dataset.userId, a), 350);
    });
    stack.addEventListener('mouseout', (e) => {
      const a = e.target.closest('.kd-presence-avatar[data-user-id]');
      if (!a) return;
      clearTimeout(_mp.showTimer);
      _mp.hideTimer = setTimeout(_kdCloseMiniProfile, 180);
    });
  }
  function _kdShowMiniProfile(userId, anchor) {
    _kdCloseMiniProfile();
    const u = KD.usersById?.get(userId);
    if (!u) return;

    const card = document.createElement('div');
    card.className = 'user-mini-card';
    card.setAttribute('role', 'tooltip');
    // Mouse dentro do card mantém aberto
    card.addEventListener('mouseenter', () => clearTimeout(_mp.hideTimer));
    card.addEventListener('mouseleave', () => { _mp.hideTimer = setTimeout(_kdCloseMiniProfile, 180); });

    const initial = (u.name || u.username || '?').charAt(0).toUpperCase();
    const bigAvatar = u.avatar
      ? `<div class="avatar user-mini-card-avatar"><img src="${esc(u.avatar)}" alt=""></div>`
      : `<div class="avatar user-mini-card-avatar" style="background:${esc(_colorForUser(u.id || u.username || 'anon'))}">${esc(initial)}</div>`;

    const position = (u.position || '').trim();
    const role = (u.role || (u.isAdmin ? 'Administrador' : 'Equipe') || '').trim();
    const metaParts = [position, role].filter(Boolean);
    const metaLine = metaParts.length
      ? metaParts.map(esc).join(' <span class="user-mini-card-sep">·</span> ')
      : '—';

    const iconAt    = '<svg class="ic-sm user-mini-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>';
    const iconMail  = '<svg class="ic-sm user-mini-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>';
    const iconPhone = '<svg class="ic-sm user-mini-card-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.902.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    const iconCopy  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

    const rows = [];
    if (u.username) rows.push({ icon: iconAt, label: 'Usuário', value: '@' + u.username });
    if (u.email)    rows.push({ icon: iconMail, label: 'E-mail', value: u.email, href: 'mailto:' + u.email });
    if (u.phone)    rows.push({ icon: iconPhone, label: 'Telefone', value: u.phone, href: 'tel:' + u.phone.replace(/[^\d+]/g, '') });
    const rowsHTML = rows.map(({icon, label, value, href}) => {
      const inner = href
        ? `<a class="user-mini-card-value user-mini-card-value--link" href="${esc(href)}">${esc(value)}</a>`
        : `<span class="user-mini-card-value">${esc(value)}</span>`;
      return `<div class="user-mini-card-row">
        ${icon}
        <div class="user-mini-card-field">
          <div class="user-mini-card-label">${esc(label)}</div>
          ${inner}
        </div>
        <button type="button" class="user-mini-card-copy" title="Copiar" data-copy="${esc(value)}">${iconCopy}</button>
      </div>`;
    }).join('');

    card.innerHTML = `
      <div class="user-mini-card-head">
        ${bigAvatar}
        <div class="user-mini-card-heading">
          <div class="user-mini-card-name">${esc(u.name || '—')}</div>
          <div class="user-mini-card-role">${metaLine}</div>
        </div>
      </div>
      <div class="user-mini-card-body">
        ${rowsHTML || '<div class="user-mini-card-empty">Sem contatos cadastrados.</div>'}
      </div>`;
    document.body.appendChild(card);

    // Botão de copiar
    card.querySelectorAll('.user-mini-card-copy').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const val = btn.getAttribute('data-copy') || '';
        if (!val || !navigator.clipboard) return;
        navigator.clipboard.writeText(val).then(() => toast('Copiado!')).catch(() => {});
      });
    });

    // Posiciona abaixo do anchor (flip pra cima se estourar)
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    card.style.position = 'fixed';
    card.style.visibility = 'hidden';
    card.style.left = '0px'; card.style.top = '0px';
    const cr = card.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (left + cr.width + 8 > vw) left = Math.max(8, vw - cr.width - 8);
    if (top + cr.height + 8 > vh) top = Math.max(8, rect.top - cr.height - gap);
    card.style.left = Math.max(8, left) + 'px';
    card.style.top  = Math.max(8, top) + 'px';
    card.style.visibility = '';
    _mp.card = card;
  }
  function _kdCloseMiniProfile() {
    if (_mp.card && _mp.card.parentNode) _mp.card.remove();
    _mp.card = null;
    clearTimeout(_mp.showTimer);
    clearTimeout(_mp.hideTimer);
  }
  // Fecha em scroll/resize/click fora (dentro fica o próprio card)
  window.addEventListener('scroll', _kdCloseMiniProfile, true);
  window.addEventListener('resize', _kdCloseMiniProfile);
  document.addEventListener('mousedown', (e) => {
    if (_mp.card && !_mp.card.contains(e.target) && !e.target.closest('.kd-presence-avatar')) _kdCloseMiniProfile();
  }, true);

  function _kdActivityLabel(ageMs) {
    if (ageMs < 60000) return 'ativo agora';
    const m = Math.round(ageMs / 60000);
    if (m < 60) return 'ativo há ' + m + 'min';
    const h = Math.round(m / 60);
    return 'ativo há ' + h + 'h';
  }
  function _clearPresence() {
    const el = document.getElementById('kd-presence');
    if (el) el.remove();
  }

  /* Tudo que depende do texto (contagem, índice, páginas, balões) roda
     agrupado depois que a pessoa para de digitar — nunca a cada tecla. */
  let _afterChangeT = null;
  function _kdAfterChange() {
    clearTimeout(_afterChangeT);
    _afterChangeT = setTimeout(() => {
      _afterChangeT = null;
      _kdUpdateWordCount(); _kdOutlineRefresh(); _kdRenderCommentBubbles(); _kdRulerRefresh();
    }, 180);
  }
  function scheduleSave() {
    if (KD.saveTimer) clearTimeout(KD.saveTimer);
    KD.saveTimer = setTimeout(flushSave, 800);
  }
  async function flushSave() {
    if (!KD.currentDoc || !KD.editor || KD.saving) return;
    const doc = KD.currentDoc;
    const content = KD.editor.getJSON();
    KD.saving = true;
    setStatus('saving', 'Salvando…');
    try {
      const r = await api('/writer/' + doc.id + '/content', 'PUT', { content });
      KD.lastSavedVersion = r.version;
      doc.version = r.version;
      doc.updatedAt = r.updatedAt;
      doc.content = content;
      doc._preview = jsonToText(content).slice(0, 220);
      KD.dirty = false;
      setStatus('saved', 'Salvo');
      // Time-machine: dispara contador de auto-snapshot
      try { KDH.tickOnSave && KDH.tickOnSave(); } catch {}
    } catch (e) {
      setStatus('error', 'Erro ao salvar');
    } finally { KD.saving = false; }
  }

  async function rename(newTitle) {
    if (!KD.currentDoc) return;
    const title = (newTitle || '').trim() || 'Sem título';
    if (title === KD.currentDoc.title) return;
    try {
      await api('/writer/' + KD.currentDoc.id, 'PATCH', { title });
      KD.currentDoc.title = title;
      const c = KD.docsList.find(x => x.id === KD.currentDoc.id);
      if (c) c.title = title;
      _kdSyncTitle();
    } catch (e) { toast(e.message || 'Falha ao renomear.', 'error'); }
  }
  window.kdRenameCurrent = rename;

  function confirmDelete() {
    if (!KD.currentDoc) return;
    kdConfirmModal(`Excluir "${KD.currentDoc.title || 'Sem título'}"?`,
      'Essa ação apaga o documento e o histórico dele. Não dá pra desfazer.',
      'Excluir', async (ok) => {
        if (!ok) return;
        try {
          await api('/writer/' + KD.currentDoc.id, 'DELETE');
          KD.docsList = KD.docsList.filter(x => x.id !== KD.currentDoc.id);
          toast('Documento excluído.');
          goList();
        } catch (e) { toast(e.message || 'Falha ao excluir.', 'error'); }
      });
  }
  window.kdConfirmDelete = confirmDelete;

  /* Modal de confirmação (substitui confirm() nativo). */
  function kdConfirmModal(title, body, okLabel, cb) {
    const backdrop = document.createElement('div');
    backdrop.className = 'kd-prompt-backdrop';
    backdrop.innerHTML = `
      <div class="kd-prompt-card">
        <div class="kd-prompt-title">${esc(title)}</div>
        ${body ? `<div class="kd-prompt-body">${esc(body)}</div>` : ''}
        <div class="kd-prompt-actions">
          <button type="button" class="kd-prompt-btn kd-prompt-cancel">Cancelar</button>
          <button type="button" class="kd-prompt-btn kd-prompt-ok kd-prompt-danger">${esc(okLabel || 'Confirmar')}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const close = (v) => { backdrop.remove(); cb(v); };
    backdrop.querySelector('.kd-prompt-cancel').onclick = () => close(false);
    backdrop.querySelector('.kd-prompt-ok').onclick = () => close(true);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
    });
  }

  function setStatus(state, text) {
    KD._status = state;
    const el = $('writer-topbar-status');
    el.classList.remove('is-saving', 'is-saved', 'is-error');
    if (state === 'saving') el.classList.add('is-saving');
    if (state === 'saved')  el.classList.add('is-saved');
    if (state === 'error')  el.classList.add('is-error');
    el.querySelector('.writer-status-text').textContent = text || '';
  }

  // ── Toolbar (mesma UI do app.js — dupla escrita por hora, ok) ──────────
  // A barra de ferramentas mora no editor-ui.js (montada uma vez só).
  function renderToolbar() { window.KDUI && window.KDUI.sync(); }
  function setBlock(v) {
    const ed = KD.editor; if (!ed) return;
    if (v === 'p') ed.chain().focus().setParagraph().run();
    else ed.chain().focus().toggleHeading({ level: Number(v.slice(1)) }).run();
  }
  function runAction(name, ev) {
    const ed = KD.editor; if (!ed) return;
    if (name === 'galleryPick') return kdGalleryOpen();
    if (name === 'commentSelection') return kdCommentSelectionStart();
    if (name === 'pickTextColor')   return _kdColorPickerOpen(ev, 'text');
    if (name === 'pickHighlight')   return _kdColorPickerOpen(ev, 'highlight');
    if (name === 'fontSizeUp')      return _kdFontSizeStep(1);
    if (name === 'fontSizeDown')    return _kdFontSizeStep(-1);
    if (name === 'toggleLink') {
      if (ed.isActive('link')) return ed.chain().focus().unsetLink().run();
      return kdPromptModal('Inserir link', 'https://', (url) => {
        if (!url) return;
        ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
      });
    }
    if (name === 'insertTable') return ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    // Botão de "imagem" agora abre o picker da galeria filtrado por imagens.
    // (URL bruta virou raro — quase sempre a imagem tá na Galeria; sem picker
    // sobrava o prompt() nativo que o sandbox do browser bloqueia.)
    if (name === 'insertImage') {
      kdGalleryOpen();
      // Aplica filtro "Imagens" no próximo tick
      setTimeout(() => {
        const sel = $('kd-gal-f-kind');
        if (sel) { sel.value = 'image'; kdGalleryRender(); }
      }, 50);
      return;
    }
    if (name === 'uploadFile') { _kdOpenFilePicker(); return; }
    ed.chain().focus()[name]().run();
  }

  /* Upload de arquivo direto do computador — abre <input type=file>, sobe via
     /api/uploads e insere no editor. Imagens viram <img>, outros viram
     kastorAttachment (card com ícone). */
  function _kdOpenFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = [...(input.files || [])];
      document.body.removeChild(input);
      files.forEach(_kdUploadAndInsert);
    });
    input.click();
  }

  /* Sobe UM arquivo via /api/uploads (XHR com progresso opcional) e insere
     no editor no cursor. Mostra toast de progresso e trata erros comuns. */
  async function _kdUploadAndInsert(file) {
    if (!file) return;
    if (file.size > 150 * 1024 * 1024) {
      toast('"' + file.name + '" excede 150 MB.', 'error');
      return;
    }
    const toastId = _kdShowUploadToast(file.name);
    try {
      const dataUri = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error || new Error('Falha na leitura'));
        r.readAsDataURL(file);
      });
      const resp = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: file.name, data: dataUri })
      });
      if (!resp.ok) {
        if (resp.status === 413) throw new Error('Arquivo grande demais pro proxy (413)');
        throw new Error('HTTP ' + resp.status);
      }
      const saved = await resp.json();
      const ed = KD.editor; if (!ed) return;
      const isImage = /^image\//i.test(saved.type || file.type || '');
      if (isImage) {
        ed.chain().focus().setImage({ src: saved.url, alt: saved.name || '' }).run();
      } else {
        // kastorAttachment node — card com ícone. Attrs seguem o esquema
        // definido em index.js.
        ed.chain().focus().insertContent({
          type: 'kastorAttachment',
          attrs: {
            attachmentId: 'up-' + Math.random().toString(36).slice(2, 10),
            name: saved.name,
            url:  saved.url,
            mime: saved.type || file.type || '',
            size: saved.size || file.size || 0,
            kind: 'file',
            isImage: false
          }
        }).run();
      }
    } catch (err) {
      toast('Falha no upload: ' + (err.message || 'erro'), 'error');
    } finally {
      _kdDismissToast(toastId);
    }
  }

  /* Toast de progresso "subindo…" — retorna id pra dismiss depois.
     Fallback: se app.js não tiver a função global toast(), só loga. */
  function _kdShowUploadToast(name) {
    if (typeof window.toast === 'function') {
      window.toast('Enviando "' + name + '"…', 'info');
    }
    return 't_' + Date.now();
  }
  function _kdDismissToast(id) {
    // O `toast()` do app.js auto-dismissa, então nada a fazer aqui por enquanto.
  }

  // ── Régua horizontal ─────────────────────────────────────────────
  const KD_PAPER_MM = 210;
  const KD_MARGIN_MM = 25.4;
  const KD_RULER_SNAP_MM = 5;   // snap fixo em 5mm

  /* Mede a largura da scrollbar vertical do browser e expõe em --kd-sbw.
     Sem isso, a scrollbar do .writer-editor-scroll desloca o "centro visual"
     do paper pra esquerda em relação ao centro da .kd-ruler-bar (que não tem
     scrollbar), quebrando o alinhamento em ~5-7px. Usar essa var como
     padding-right na ruler-bar reposiciona o centro dela pra bater com o
     centro do scroll. Re-medido no init do editor e em toggle do índice. */
  function _kdMeasureScrollbar() {
    const scroll = document.querySelector('.writer-editor-scroll');
    if (scroll && scroll.offsetWidth > 0) {
      const w = scroll.offsetWidth - scroll.clientWidth;
      document.documentElement.style.setProperty('--kd-sbw', Math.max(0, w) + 'px');
      return;
    }
    // Fallback quando ainda não montou: cria uma div oculta pra medir.
    const div = document.createElement('div');
    div.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;';
    document.body.appendChild(div);
    const w = div.offsetWidth - div.clientWidth;
    document.body.removeChild(div);
    document.documentElement.style.setProperty('--kd-sbw', Math.max(0, w) + 'px');
  }

  /* Régua: números em cm contados a partir da margem (como no Google Docs),
     traços a cada 2,5 mm e três marcadores — recuo da 1ª linha (em cima),
     recuo à esquerda e à direita (embaixo). */
  const KD_RULER_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'];
  const KD_MARKER_SVG = {
    down: '<svg width="13" height="10" viewBox="0 0 13 10"><path d="M1.5 1h10a.8.8 0 0 1 .6 1.3L7.1 8.6a.8.8 0 0 1-1.2 0L.9 2.3A.8.8 0 0 1 1.5 1Z"/></svg>',
    up:   '<svg width="13" height="10" viewBox="0 0 13 10"><path d="M1.5 9h10a.8.8 0 0 0 .6-1.3L7.1 1.4a.8.8 0 0 0-1.2 0L.9 7.7A.8.8 0 0 0 1.5 9Z"/></svg>'
  };
  const KD_MARKER_LABEL = { first: 'Recuo da primeira linha', left: 'Recuo à esquerda', right: 'Recuo à direita' };

  function _kdRulerInit() {
    const ruler = $('kd-ruler');
    if (!ruler || ruler._kdInit) return;
    ruler._kdInit = true;
    _kdMeasureScrollbar();
    ruler.innerHTML = '';
    // Traços e números num SVG só (nítido em qualquer zoom)
    const W = KD_PAPER_MM;
    const K = 96 / 25.4;                            // px por mm (CSS)
    let marks = '';
    // Posições contadas a partir da margem esquerda (0 = início do texto)
    for (let rel = -25; rel <= W - KD_MARGIN_MM + 0.01; rel += 2.5) {
      const mm = rel + KD_MARGIN_MM;
      if (mm < 1 || mm > W - 1) continue;
      const x = (mm * K).toFixed(1);
      const q = ((rel % 10) + 10) % 10;             // posição dentro do cm
      if (Math.abs(q) < 0.01 || Math.abs(q - 10) < 0.01) {
        const n = Math.abs(Math.round(rel / 10));
        if (n === 0) continue;                      // a própria margem fica sem número
        marks += `<text x="${x}" y="14.5" text-anchor="middle">${n}</text>`;
      } else {
        const h = Math.abs(q - 5) < 0.01 ? 7 : 3.5;
        marks += `<line x1="${x}" x2="${x}" y1="${11 - h / 2}" y2="${11 + h / 2}"/>`;
      }
    }
    // Desenhado em px CSS (a régua tem 210mm de largura = W * K px)
    const svg = `<svg class="kd-ruler-scale" viewBox="0 0 ${(W * K).toFixed(1)} 22" aria-hidden="true">${marks}</svg>`;
    ruler.insertAdjacentHTML('beforeend', `<div class="kd-ruler-margin is-l"></div><div class="kd-ruler-margin is-r"></div>${svg}`);
    const mkMarker = (side, shape) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.tabIndex = -1;
      el.className = 'kd-ruler-marker is-' + side;
      el.title = KD_MARKER_LABEL[side] + ' · clique duplo zera';
      el.setAttribute('aria-label', KD_MARKER_LABEL[side]);
      el.innerHTML = KD_MARKER_SVG[shape];
      ruler.appendChild(el);
      _kdRulerBindDrag(el, side);
      return el;
    };
    ruler._first = mkMarker('first', 'down');
    ruler._left  = mkMarker('left', 'up');
    ruler._right = mkMarker('right', 'up');
    ruler._tip = document.createElement('div');
    ruler._tip.className = 'kd-ruler-tooltip';
    ruler.appendChild(ruler._tip);
  }

  /* Bloco cujo recuo a régua mostra: o mais externo recuável que contém o
     cursor (lista/citação inteira, ou o parágrafo/título). */
  function _kdIndentTarget() {
    const sel = KD.editor?.state.selection;
    if (!sel) return null;
    const $f = sel.$from;
    for (let d = 1; d <= $f.depth; d++) {
      const n = $f.node(d);
      if (KD_RULER_TYPES.includes(n.type.name)) return n;
    }
    // Seleção de vários blocos (ou Ctrl+A): a régua mostra o primeiro bloco
    // da seleção e o arraste vale pra todos eles.
    let first = null;
    KD.editor.state.doc.nodesBetween(sel.from, sel.to, (n) => {
      if (first) return false;
      if (KD_RULER_TYPES.includes(n.type.name)) { first = n; return false; }
    });
    return first;
  }

  function _kdRulerRefresh() {
    const ruler = $('kd-ruler');
    if (!ruler || !KD.editor) return;
    _kdRulerInit();
    if (ruler.classList.contains('is-dragging')) return;
    const node = _kdIndentTarget();
    const a = node?.attrs || {};
    const l = Number(a.indentLeft || 0), r = Number(a.indentRight || 0), f = Number(a.firstLineIndent || 0);
    const firstOk = !!node && (node.type.name === 'paragraph' || node.type.name === 'heading');
    _kdRulerPlace('left', KD_MARGIN_MM + l);
    _kdRulerPlace('right', KD_PAPER_MM - KD_MARGIN_MM - r);
    _kdRulerPlace('first', KD_MARGIN_MM + l + f);
    ruler._first.hidden = !firstOk;
    ruler.classList.toggle('is-disabled', !node);
  }
  function _kdRulerPlace(side, mm) {
    const ruler = $('kd-ruler');
    const el = ruler && ruler['_' + side];
    if (!el) return;
    el.style.left = (mm / KD_PAPER_MM * 100) + '%';
    el.dataset.mm = String(mm);
  }

  function _kdRulerBindDrag(marker, side) {
    marker.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      if (!KD.editor || !['owner', 'editor'].includes(KD.myRole)) return;
      const key = side === 'left' ? 'indentLeft' : side === 'right' ? 'indentRight' : 'firstLineIndent';
      KD.editor.chain().focus().setBlockIndent({ [key]: 0 }).run();
      _kdRulerRefresh();
    });
    marker.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const ruler = $('kd-ruler');
      if (!ruler || !KD.editor || !['owner', 'editor'].includes(KD.myRole) || !_kdIndentTarget()) return;
      marker.setPointerCapture?.(ev.pointerId);
      const rect = ruler.getBoundingClientRect();
      const pxPerMm = rect.width / KD_PAPER_MM;
      const startLeft = parseFloat(ruler._left.dataset.mm);
      const startRight = parseFloat(ruler._right.dataset.mm);
      const startFirstRel = parseFloat(ruler._first.dataset.mm) - startLeft;
      ruler.classList.add('is-dragging');
      marker.classList.add('is-dragging');
      // Linha-guia vertical sobre a página
      const center = document.querySelector('.writer-editor-center');
      const guide = document.createElement('div');
      guide.className = 'kd-ruler-guide';
      center?.appendChild(guide);
      const cRect = center?.getBoundingClientRect();
      const tip = ruler._tip;
      let last = null;
      const move = (e) => {
        const raw = (e.clientX - rect.left) / pxPerMm;
        const step = e.altKey ? 0.5 : 2.5;
        // Encaixe medido a partir da margem (ou do recuo esquerdo, na 1ª linha),
        // pra os valores saírem redondos: 0,5 cm, 1 cm, 1,25 cm…
        const snapFrom = (base) => base + Math.round((raw - base) / step) * step;
        let mm = side === 'first' ? snapFrom(startLeft)
               : side === 'right' ? KD_PAPER_MM - KD_MARGIN_MM - Math.round((KD_PAPER_MM - KD_MARGIN_MM - raw) / step) * step
               : snapFrom(KD_MARGIN_MM);
        let patch, shown;
        if (side === 'left') {
          mm = Math.max(KD_MARGIN_MM, Math.min(mm, startRight - 20));
          patch = { indentLeft: +(mm - KD_MARGIN_MM).toFixed(1) };
          shown = mm - KD_MARGIN_MM;
          _kdRulerPlace('first', mm + startFirstRel);   // a 1ª linha acompanha
        } else if (side === 'right') {
          mm = Math.min(KD_PAPER_MM - KD_MARGIN_MM, Math.max(mm, startLeft + 20));
          patch = { indentRight: +(KD_PAPER_MM - KD_MARGIN_MM - mm).toFixed(1) };
          shown = KD_PAPER_MM - KD_MARGIN_MM - mm;
        } else {
          mm = Math.max(startLeft, Math.min(mm, startRight - 20));
          patch = { firstLineIndent: +(mm - startLeft).toFixed(1) };
          shown = mm - startLeft;
        }
        _kdRulerPlace(side, mm);
        const key = JSON.stringify(patch);
        if (key !== last) {                    // só aplica quando o valor muda
          last = key;
          KD.editor.commands.setBlockIndent(patch);
        }
        tip.textContent = KD_MARKER_LABEL[side] + ' · ' + (shown / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' cm';
        tip.style.left = (mm / KD_PAPER_MM * 100) + '%';
        if (cRect) guide.style.left = (rect.left + mm * pxPerMm - cRect.left) + 'px';
      };
      const up = () => {
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        marker.removeEventListener('pointercancel', up);
        ruler.classList.remove('is-dragging');
        marker.classList.remove('is-dragging');
        guide.remove();
        KD.editor?.commands.focus();
        _kdRulerRefresh();
      };
      marker.addEventListener('pointermove', move);
      marker.addEventListener('pointerup', up);
      marker.addEventListener('pointercancel', up);
      move(ev);
    });
  }

  /* ── Menu de contexto do editor ─────────────────────────────────────
     Substitui o menu nativo do browser dentro do paper. Itens sensíveis
     a seleção (recortar/copiar/excluir/comentar) ficam disabled quando
     não há nada selecionado. */
  function _kdBindContextMenu(mount) {
    if (!mount || mount._kdCtxBound) return;
    mount._kdCtxBound = true;
    mount.addEventListener('contextmenu', (ev) => {
      if (!KD.editor) return;
      ev.preventDefault();
      // Se clicou com direito em cima de uma <img>, mostra menu específico
      // com opções de imagem (redimensionar, baixar, remover, alinhar).
      const img = ev.target.closest('img.writer-image, img');
      if (img) {
        _kdImgSelect(img);
        _kdOpenImageContextMenu(ev.clientX, ev.clientY, img);
        return;
      }
      _kdOpenContextMenu(ev.clientX, ev.clientY);
    });
  }

  /* Menu de context específico pra imagens — reusa o CSS `.kd-context-*`
     do menu genérico mas com items diferentes. */
  function _kdOpenImageContextMenu(x, y, img) {
    _kdCloseContextMenu();
    const I = _kdImgIcons;
    const items = [
      { a: 'img-download', i: I.download, l: 'Baixar imagem' },
      { divider: true },
      { a: 'img-25',  l: 'Redimensionar: 25%' },
      { a: 'img-50',  l: 'Redimensionar: 50%' },
      { a: 'img-75',  l: 'Redimensionar: 75%' },
      { a: 'img-100', l: 'Redimensionar: 100%' },
      { divider: true },
      { a: 'img-align-left',   i: I.alignL, l: 'Alinhar à esquerda' },
      { a: 'img-align-center', i: I.alignC, l: 'Centralizar' },
      { a: 'img-align-right',  i: I.alignR, l: 'Alinhar à direita' },
      { divider: true },
      { a: 'img-alt', l: 'Editar texto alternativo…' },
      { a: 'img-remove', i: I.trash, l: 'Remover imagem', danger: true }
    ];
    const menu = document.createElement('div');
    menu.className = 'kd-context-menu';
    menu.innerHTML = items.map(it => {
      if (it.divider) return '<div class="kd-context-divider"></div>';
      const dangerClass = it.danger ? ' kd-context-item--danger' : '';
      const iconHtml = it.i || '<span style="width:14px;display:inline-block"></span>';
      return `<button type="button" class="kd-context-item${dangerClass}" data-a="${esc(it.a)}">
        ${iconHtml}<span class="kd-context-label">${esc(it.l)}</span>
      </button>`;
    }).join('');
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.left = (x + w > vw ? vw - w - 4 : x) + 'px';
    menu.style.top  = (y + h > vh ? vh - h - 4 : y) + 'px';
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('.kd-context-item[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      _kdCloseContextMenu();
      if (a === 'img-download') return _kdImgDownload(img);
      if (a === 'img-remove')   return _kdImgRemove(img);
      if (a.startsWith('img-align-')) return _kdImgSetAlign(img, a.replace('img-align-', ''));
      if (a.startsWith('img-') && /^img-\d+$/.test(a)) {
        const pct = parseInt(a.replace('img-', ''), 10);
        const paper = document.querySelector('.writer-editor-paper');
        const paperW = paper ? paper.clientWidth - 96 : 794;
        _kdImgSetWidth(img, Math.round(paperW * pct / 100));
        return;
      }
      if (a === 'img-alt') {
        const cur = img.getAttribute('alt') || '';
        const nv = window.prompt('Texto alternativo (alt) — descreve a imagem pra acessibilidade:', cur);
        if (nv == null) return;
        try {
          const ed = KD.editor;
          const pos = ed.view.posAtDOM(img, 0);
          const node = ed.state.doc.nodeAt(pos);
          if (node && node.type.name === 'image') {
            ed.chain().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: nv }); return true; }).run();
          }
        } catch {}
      }
    });
    const closeOnAny = (e) => { if (!menu.contains(e.target)) _kdCloseContextMenu(); };
    setTimeout(() => {
      document.addEventListener('click', closeOnAny);
      document.addEventListener('contextmenu', closeOnAny);
      document.addEventListener('scroll', _kdCloseContextMenu, true);
    }, 0);
    menu._cleanup = () => {
      document.removeEventListener('click', closeOnAny);
      document.removeEventListener('contextmenu', closeOnAny);
      document.removeEventListener('scroll', _kdCloseContextMenu, true);
    };
  }
  function _kdOpenContextMenu(x, y) {
    _kdCloseContextMenu();
    const sel = KD.editor?.state.selection;
    const hasSel = sel && !sel.empty;
    // SVGs 14x14
    const I = {
      cut:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
      copy:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      paste:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
      pastePl:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M9 12h6M9 16h4"/></svg>',
      del:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
      comment:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      link:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
    };
    const items = [
      { a: 'cut',            i: I.cut,     l: 'Recortar',            k: 'Ctrl+X',        needSel: true },
      { a: 'copy',           i: I.copy,    l: 'Copiar',              k: 'Ctrl+C',        needSel: true },
      { a: 'paste',          i: I.paste,   l: 'Colar',               k: 'Ctrl+V' },
      { a: 'paste-plain',    i: I.pastePl, l: 'Colar sem formatação',k: 'Ctrl+Shift+V' },
      { a: 'delete-selection', i: I.del,   l: 'Excluir',             danger: true,      needSel: true },
      { divider: true },
      { a: 'ctxComment',     i: I.comment, l: 'Comentar',            k: 'Ctrl+Alt+M',   needSel: true },
      { a: 'ctxLink',        i: I.link,    l: 'Inserir link',        k: 'Ctrl+K' }
    ];
    const menu = document.createElement('div');
    menu.className = 'kd-context-menu';
    menu.innerHTML = items.map(it => {
      if (it.divider) return '<div class="kd-context-divider"></div>';
      const disabled = (it.needSel && !hasSel) ? 'disabled' : '';
      const dangerClass = it.danger ? ' kd-context-item--danger' : '';
      return `<button type="button" class="kd-context-item${dangerClass}" data-a="${esc(it.a)}" ${disabled}>
        ${it.i}<span class="kd-context-label">${esc(it.l)}</span>${it.k ? `<span class="kd-context-shortcut">${esc(it.k)}</span>` : ''}
      </button>`;
    }).join('');
    document.body.appendChild(menu);
    // Posiciona: se estourar viewport, alinha à esquerda/topo
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    menu.style.left = (x + w > vw ? vw - w - 4 : x) + 'px';
    menu.style.top  = (y + h > vh ? vh - h - 4 : y) + 'px';
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('.kd-context-item[data-a]');
      if (!b || b.disabled) return;
      const a = b.dataset.a;
      _kdCloseContextMenu();
      if (a === 'ctxComment') { window.kdCommentSelectionStart && kdCommentSelectionStart(); return; }
      if (a === 'ctxLink')    { runAction('toggleLink', e); return; }
      const fn = MENUBAR_ACTIONS[a];
      if (fn) fn(e);
    });
    const closeOnAny = (e) => { if (!menu.contains(e.target)) _kdCloseContextMenu(); };
    setTimeout(() => {
      document.addEventListener('click', closeOnAny);
      document.addEventListener('contextmenu', closeOnAny);
      document.addEventListener('scroll', _kdCloseContextMenu, true);
    }, 0);
    menu._cleanup = () => {
      document.removeEventListener('click', closeOnAny);
      document.removeEventListener('contextmenu', closeOnAny);
      document.removeEventListener('scroll', _kdCloseContextMenu, true);
    };
  }
  function _kdCloseContextMenu() {
    document.querySelectorAll('.kd-context-menu').forEach(m => { m._cleanup && m._cleanup(); m.remove(); });
  }

  /* ══ Imagem inline: seleção, resize por drag, right-click menu ══════
     Clicar na imagem → adiciona classe .is-selected + mostra handles nas
     bordas pra resize por drag + toolbar flutuante com tamanhos preset.
     Right-click → menu com ações específicas (baixar, alt, %, remover).
     Persistência via extension KdImage (attrs.width no node). */

  let _kdSelectedImg = null;   // <img> DOM element atualmente selecionado
  let _kdHandles = [];         // handles ativos (removidos junto com o wrap)

  function _kdImgSelect(img) {
    _kdImgDeselect();
    if (!img) return;
    _kdSelectedImg = img;
    img.classList.add('kd-img-selected');
    _kdImgBuildHandles(img);
    _kdImgBuildToolbar(img);
    // Reposiciona em scroll/resize enquanto selecionada
    window.addEventListener('scroll', _kdImgReposition, true);
    window.addEventListener('resize', _kdImgReposition);
  }

  function _kdImgDeselect() {
    if (_kdSelectedImg) {
      _kdSelectedImg.classList.remove('kd-img-selected');
      _kdSelectedImg = null;
    }
    _kdHandles.forEach(h => h.remove());
    _kdHandles = [];
    document.querySelector('.kd-img-toolbar')?.remove();
    window.removeEventListener('scroll', _kdImgReposition, true);
    window.removeEventListener('resize', _kdImgReposition);
  }

  function _kdImgReposition() {
    if (!_kdSelectedImg) return;
    _kdImgPositionHandles(_kdSelectedImg);
    _kdImgPositionToolbar(_kdSelectedImg);
  }

  function _kdImgBuildHandles(img) {
    // 4 handles nos cantos. Uso `position: fixed` — reposiciona em scroll/resize.
    const corners = ['nw', 'ne', 'sw', 'se'];
    corners.forEach(corner => {
      const h = document.createElement('div');
      h.className = 'kd-img-handle kd-img-handle--' + corner;
      h.dataset.corner = corner;
      document.body.appendChild(h);
      _kdImgBindDrag(h, img, corner);
      _kdHandles.push(h);
    });
    _kdImgPositionHandles(img);
  }

  function _kdImgPositionHandles(img) {
    const r = img.getBoundingClientRect();
    _kdHandles.forEach(h => {
      const c = h.dataset.corner;
      const x = c.includes('e') ? r.right : r.left;
      const y = c.includes('s') ? r.bottom : r.top;
      h.style.left = (x - 5) + 'px';
      h.style.top  = (y - 5) + 'px';
    });
  }

  function _kdImgBindDrag(handle, img, corner) {
    handle.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const startX = ev.clientX;
      const startRect = img.getBoundingClientRect();
      const startW = startRect.width;
      const aspect = startRect.height / startW;
      const east = corner.includes('e');
      document.body.style.cursor = corner + '-resize';
      img.classList.add('is-resizing');

      const onMove = (e) => {
        const dx = e.clientX - startX;
        // W handles: drag pra ESQUERDA aumenta; E handles: drag pra DIREITA aumenta
        const delta = east ? dx : -dx;
        const newW = Math.max(40, Math.round(startW + delta));
        img.style.width = newW + 'px';
        img.style.height = 'auto';
        _kdImgPositionHandles(img);
        _kdImgPositionToolbar(img);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        img.classList.remove('is-resizing');
        _kdImgPersistSize(img);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* Grava o width no node do ProseMirror pra sobreviver a re-render/reload.
     Descobre a posição do node no doc via posAtDOM. */
  function _kdImgPersistSize(img) {
    const ed = KD.editor; if (!ed) return;
    const width = Math.round(img.getBoundingClientRect().width);
    try {
      const pos = ed.view.posAtDOM(img, 0);
      if (pos == null || pos < 0) return;
      ed.chain().command(({ tr }) => {
        const node = tr.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return false;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, width });
        return true;
      }).run();
    } catch (e) { console.warn('[kd-img persist]', e); }
  }

  function _kdImgSetWidth(img, width) {
    img.style.width = (typeof width === 'number' ? width + 'px' : width);
    img.style.height = 'auto';
    _kdImgPersistSize(img);
    _kdImgPositionHandles(img);
    _kdImgPositionToolbar(img);
  }
  function _kdImgSetAlign(img, align) {
    const ed = KD.editor; if (!ed) return;
    try {
      const pos = ed.view.posAtDOM(img, 0);
      if (pos == null || pos < 0) return;
      ed.chain().command(({ tr }) => {
        const node = tr.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return false;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, align });
        return true;
      }).run();
    } catch (e) { console.warn('[kd-img align]', e); }
  }

  /* Baixa a imagem em bytes via fetch → blob → download sintético.
     Usa attClickDownload do app.js quando disponível (mesma lógica dos anexos),
     senão faz fallback local. */
  async function _kdImgDownload(img) {
    const src = img.getAttribute('src') || '';
    const name = img.getAttribute('alt') || 'imagem';
    if (window.attClickDownload) {
      return window.attClickDownload({ preventDefault: () => {} }, src, name);
    }
    // Fallback simples
    try {
      const r = await fetch(src);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
    } catch (e) { console.warn('[kd-img download]', e); }
  }

  function _kdImgBuildToolbar(img) {
    const tb = document.createElement('div');
    tb.className = 'kd-img-toolbar';
    tb.innerHTML = `
      <button type="button" data-w="25" title="25%">25%</button>
      <button type="button" data-w="50" title="50%">50%</button>
      <button type="button" data-w="75" title="75%">75%</button>
      <button type="button" data-w="100" title="100%">100%</button>
      <div class="kd-img-toolbar-sep"></div>
      <button type="button" data-align="left" title="Alinhar à esquerda">${_kdImgIcons.alignL}</button>
      <button type="button" data-align="center" title="Centralizar">${_kdImgIcons.alignC}</button>
      <button type="button" data-align="right" title="Alinhar à direita">${_kdImgIcons.alignR}</button>
      <div class="kd-img-toolbar-sep"></div>
      <button type="button" data-a="download" title="Baixar imagem">${_kdImgIcons.download}</button>
      <button type="button" data-a="remove" class="kd-img-danger" title="Remover imagem">${_kdImgIcons.trash}</button>
    `;
    document.body.appendChild(tb);
    tb.addEventListener('mousedown', (e) => e.preventDefault());
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !_kdSelectedImg) return;
      const w = b.dataset.w;
      const al = b.dataset.align;
      const act = b.dataset.a;
      if (w) {
        // % da largura do conteúdo — usa clientWidth do paper como referência
        const paper = document.querySelector('.writer-editor-paper');
        const paperW = paper ? paper.clientWidth - 96 /* padding */ : 794;
        _kdImgSetWidth(_kdSelectedImg, Math.round(paperW * parseInt(w) / 100));
      } else if (al) {
        _kdImgSetAlign(_kdSelectedImg, al);
      } else if (act === 'download') {
        _kdImgDownload(_kdSelectedImg);
      } else if (act === 'remove') {
        _kdImgRemove(_kdSelectedImg);
      }
    });
    _kdImgPositionToolbar(img);
  }

  function _kdImgPositionToolbar(img) {
    const tb = document.querySelector('.kd-img-toolbar');
    if (!tb) return;
    const r = img.getBoundingClientRect();
    const tw = tb.offsetWidth;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - tb.offsetHeight - 8;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    if (y < 8) y = r.bottom + 8; // se não couber acima, coloca abaixo
    tb.style.left = x + 'px';
    tb.style.top  = y + 'px';
  }

  function _kdImgRemove(img) {
    const ed = KD.editor; if (!ed) return;
    try {
      const pos = ed.view.posAtDOM(img, 0);
      if (pos == null || pos < 0) return;
      const node = ed.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'image') return;
      ed.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
      _kdImgDeselect();
    } catch (e) { console.warn('[kd-img remove]', e); }
  }

  // Ícones da toolbar de imagem
  const _kdImgIcons = {
    alignL:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>',
    alignC:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>',
    alignR:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>',
    download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    trash:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>'
  };

  /* Bind: click numa img seleciona; click fora deseleciona.
     Called from editor mount setup (junto do context menu). */
  function _kdBindImageInteractions(mount) {
    if (!mount || mount._kdImgBound) return;
    mount._kdImgBound = true;
    mount.addEventListener('click', (ev) => {
      const img = ev.target.closest('img.writer-image, img');
      if (img && mount.contains(img)) {
        ev.preventDefault();
        ev.stopPropagation();
        _kdImgSelect(img);
      }
    });
    // Deseleciona ao clicar fora
    document.addEventListener('click', (ev) => {
      if (!_kdSelectedImg) return;
      if (ev.target.closest('.kd-img-handle, .kd-img-toolbar, .kd-context-menu')) return;
      if (ev.target === _kdSelectedImg) return;
      _kdImgDeselect();
    });
    // ESC deseleciona
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && _kdSelectedImg) _kdImgDeselect();
    });
  }

  /* ── Font size widget ────────────────────────────────────────────────
     Extension armazena como string ("14pt", "18px", "1.2em"). Trabalhamos
     tudo em `pt` por consistência com o default do editor (11pt = ~14.6px). */
  const KD_FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
  /* Extrai só o número do valor armazenado (pra mostrar limpo no input). */
  function _kdFmtFontSize(v) {
    const n = parseFloat(String(v || '11'));
    if (!isFinite(n) || n <= 0) return '11';
    // Se veio em px, converte pra pt (aproximado: 1pt = 4/3 px)
    if (/px$/i.test(String(v))) return String(Math.round(n * 3 / 4 * 10) / 10);
    return String(Math.round(n * 10) / 10);
  }
  function _kdCurrentFontSizePt() {
    const raw = KD.editor?.getAttributes('textStyle')?.fontSize || '11pt';
    const n = parseFloat(String(raw));
    if (!isFinite(n) || n <= 0) return 11;
    if (/px$/i.test(String(raw))) return n * 3 / 4;
    return n;
  }
  function _kdSetFontSize(pt) {
    if (!KD.editor) return;
    const clamped = Math.max(4, Math.min(200, Math.round(pt * 10) / 10));
    KD.editor.chain().focus().setFontSize(clamped + 'pt').run();
    // Sincroniza o input da toolbar — setFontSize não dispara re-render da tb
    // (é apenas doc update, não selection update), então atualizamos manual.
    const inp = document.querySelector('.writer-tb-fs-input');
    if (inp && document.activeElement !== inp) inp.value = String(clamped);
  }
  function _kdFontSizeApplyRaw(str) {
    const n = parseFloat(String(str || '').replace(',', '.'));
    if (!isFinite(n) || n <= 0) return;
    _kdSetFontSize(n);
  }
  function _kdFontSizeStep(delta) {
    _kdSetFontSize(_kdCurrentFontSizePt() + delta);
  }
  /* Menu de presets ancorado no INPUT — abre no focus. Item selecionado
     aplica + fecha; menu fecha em blur (a não ser que foco vá pra dentro dele). */
  function _kdFontSizeMenuOpenForInput(inp) {
    _kdFontSizeMenuClose();
    const wrap = inp.closest('.writer-tb-fontsize') || inp;
    const r = wrap.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'kd-fontsize-menu';
    menu.style.top  = (r.bottom + 4) + 'px';
    menu.style.left = r.left + 'px';
    menu.style.minWidth = r.width + 'px';
    const cur = Math.round(_kdCurrentFontSizePt());
    menu.innerHTML = KD_FONT_SIZES.map(s =>
      // tabindex="-1" pra clicar no item não roubar foco do input (previne blur)
      `<button type="button" tabindex="-1" class="kd-fontsize-item${s === cur ? ' is-current' : ''}" data-s="${s}">${s}</button>`
    ).join('');
    document.body.appendChild(menu);
    menu.addEventListener('mousedown', (e) => { e.preventDefault(); }); // não rouba foco
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('.kd-fontsize-item');
      if (!b) return;
      const size = Number(b.dataset.s);
      _kdSetFontSize(size);
      inp.value = String(size);
      _kdFontSizeMenuClose();
      inp.blur();
    });
  }
  function _kdFontSizeMenuClose() {
    document.querySelectorAll('.kd-fontsize-menu').forEach(m => m.remove());
  }

  /* ── Color picker (texto e destaque) ─────────────────────────────────
     Popover ancorado ao botão da toolbar com paleta pré-definida + input
     custom + botão de remover. Reusa pra text color e highlight — diferença
     é só qual comando do editor chama. */
  const KD_PALETTE = [
    // Neutros
    ['#000000','#525252','#8c8c8c','#c0c0c0','#e5e5e5','#ffffff'],
    // Reds
    ['#7a0000','#c53030','#e53e3e','#fc8181','#feb2b2','#fed7d7'],
    // Oranges
    ['#7a3a00','#dd6b20','#ed8936','#f6ad55','#fbd38d','#feebc8'],
    // Yellows
    ['#7a5a00','#d69e2e','#ecc94b','#f6e05e','#faf089','#fefcbf'],
    // Greens
    ['#22543d','#38a169','#48bb78','#68d391','#9ae6b4','#c6f6d5'],
    // Cyans
    ['#065666','#0987a0','#00b5d8','#4fd1c5','#81e6d9','#b2f5ea'],
    // Blues
    ['#1a365d','#2b6cb0','#3182ce','#63b3ed','#90cdf4','#bee3f8'],
    // Purples
    ['#44337a','#6b46c1','#805ad5','#b794f4','#d6bcfa','#e9d8fd'],
    // Pinks
    ['#702459','#b83280','#d53f8c','#ed64a6','#fbb6ce','#fed7e2'],
    // Brand roxo
    ['#3a007c','#5a00b4','#7a00ff','#9b3aff','#c184ff','#e5ccff']
  ];
  /* Cores recentes — por tipo (text/highlight), guardadas em localStorage,
     dedupe, mais recente primeiro, cap em 10. */
  function _kdRecentColors(kind) {
    try { return JSON.parse(localStorage.getItem('kastor-doc-recent-color-' + kind) || '[]'); }
    catch { return []; }
  }
  function _kdPushRecentColor(kind, color) {
    if (!color) return;
    const list = [color, ..._kdRecentColors(kind).filter(c => c !== color)].slice(0, 10);
    try { localStorage.setItem('kastor-doc-recent-color-' + kind, JSON.stringify(list)); } catch {}
  }

  function _kdColorPickerOpen(ev, kind) {
    ev && ev.stopPropagation();
    // Fecha popover anterior se houver
    document.querySelectorAll('.kd-color-popover').forEach(p => p.remove());
    const btn = ev.currentTarget || ev.target?.closest('button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'kd-color-popover';
    pop.style.top  = (r.bottom + 6) + 'px';
    pop.style.left = r.left + 'px';
    const currentColor = kind === 'text'
      ? (KD.editor.getAttributes('textStyle')?.color || '#000000')
      : (KD.editor.getAttributes('highlight')?.color || '#ffd400');
    // Transpõe a paleta: cada COLUNA vira uma família (Neutros, Reds, …).
    // Original é 10 famílias × 6 tons; renderiza como 6 tons (linhas) × 10 famílias (colunas).
    const _rows = KD_PALETTE[0].length;   // 6 tons
    const _cols = KD_PALETTE.length;      // 10 famílias
    const recents = _kdRecentColors(kind);
    pop.innerHTML = `
      <div class="kd-color-title">${kind === 'text' ? 'Cor do texto' : 'Cor de destaque'}</div>
      <div class="kd-color-grid">
        ${Array.from({ length: _rows }, (_, i) =>
          `<div class="kd-color-row">${
            Array.from({ length: _cols }, (_, j) => {
              const c = KD_PALETTE[j][i];
              return `<button type="button" class="kd-color-swatch" data-c="${c}" style="background:${c}" title="${c}"></button>`;
            }).join('')
          }</div>`
        ).join('')}
      </div>
      ${recents.length ? `
      <div class="kd-color-recent">
        <div class="kd-color-recent-label">Recentes</div>
        <div class="kd-color-recent-row">
          ${recents.map(c => `<button type="button" class="kd-color-swatch" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        </div>
      </div>` : ''}
      <div class="kd-color-actions">
        <label class="kd-color-custom">
          <span>Personalizada</span>
          <input type="color" class="kd-color-input" value="${esc(currentColor)}">
        </label>
        <button type="button" class="kd-color-remove">Remover ${kind === 'text' ? 'cor' : 'destaque'}</button>
      </div>
    `;
    document.body.appendChild(pop);
    const apply = (color) => {
      if (!KD.editor) return;
      const ed = KD.editor;
      if (kind === 'text') {
        color ? ed.chain().focus().setColor(color).run() : ed.chain().focus().unsetColor().run();
      } else {
        color ? ed.chain().focus().setHighlight({ color }).run() : ed.chain().focus().unsetHighlight().run();
      }
      // Só grava em recentes quando uma cor é aplicada (não em "remover")
      if (color) _kdPushRecentColor(kind, color);
      close();
    };
    const close = () => {
      pop.remove();
      document.removeEventListener('click', outside);
    };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('click', outside), 0);
    pop.addEventListener('click', (e) => {
      const s = e.target.closest('.kd-color-swatch');
      if (s) return apply(s.dataset.c);
      if (e.target.closest('.kd-color-remove')) return apply(null);
    });
    pop.querySelector('.kd-color-input').addEventListener('input', (e) => apply(e.target.value));
  }

  /* Mini-modal reusável pra pedir um input (substitui prompt() nativo, que
     o sandbox do desktop bloqueia). Callback recebe a string ou undefined. */
  function kdPromptModal(title, defaultValue, cb) {
    const backdrop = document.createElement('div');
    backdrop.className = 'kd-prompt-backdrop';
    backdrop.innerHTML = `
      <div class="kd-prompt-card">
        <div class="kd-prompt-title">${esc(title)}</div>
        <input class="kd-prompt-input" value="${esc(defaultValue || '')}" spellcheck="false">
        <div class="kd-prompt-actions">
          <button type="button" class="kd-prompt-btn kd-prompt-cancel">Cancelar</button>
          <button type="button" class="kd-prompt-btn kd-prompt-ok">Confirmar</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('.kd-prompt-input');
    input.focus(); input.select();
    const close = (val) => { backdrop.remove(); cb(val); };
    backdrop.querySelector('.kd-prompt-cancel').onclick = () => close(undefined);
    backdrop.querySelector('.kd-prompt-ok').onclick = () => close(input.value.trim() || undefined);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') close(input.value.trim() || undefined);
      if (e.key === 'Escape') close(undefined);
    });
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(undefined); });
  }

  // ── Export ────────────────────────────────────────────────────────────
  function exportMenu(ev) {
    ev?.stopPropagation();
    const doc = KD.currentDoc; const ed = KD.editor;
    if (!ed || !doc) return;
    // Menu popover ancorado ao botão que disparou
    const anchor = ev.currentTarget || ev.target;
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'kd-export-menu';
    menu.style.top  = (rect.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.innerHTML = `
      <button type="button" data-fmt="pdf">
        <span class="kd-export-fmt">PDF</span>
        <span class="kd-export-desc">Convertido pelo LibreOffice</span>
      </button>
      <button type="button" data-fmt="docx">
        <span class="kd-export-fmt">DOCX</span>
        <span class="kd-export-desc">Abrir no Word/Google Docs</span>
      </button>
      <button type="button" data-fmt="html">
        <span class="kd-export-fmt">HTML</span>
        <span class="kd-export-desc">Página estilizada</span>
      </button>
      <button type="button" data-fmt="txt">
        <span class="kd-export-fmt">TXT</span>
        <span class="kd-export-desc">Texto plano</span>
      </button>`;
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', outside); };
    const outside = (e) => { if (!menu.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('click', outside), 0);
    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-fmt]');
      if (!b) return;
      const fmt = b.dataset.fmt;
      close();
      // Autosave antes de exportar (garante que o server tem o content mais recente)
      if (KD.dirty) { toast('Salvando antes de exportar…'); await flushSave(); }
      toast('Exportando ' + fmt.toUpperCase() + '…');
      try {
        // Server responde com Content-Disposition: attachment — o browser baixa direto.
        // Fetch pra respeitar cookies e ter feedback de erro (link direto ignora falhas).
        const resp = await fetch('/api/writer/' + doc.id + '/export?format=' + encodeURIComponent(fmt), {
          credentials: 'same-origin'
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || 'Falha no export (' + resp.status + ')');
        }
        const blob = await resp.blob();
        const base = _kdSafeFilename(doc.title || 'documento');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = base + '.' + fmt;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
      } catch (err) {
        toast(err.message || 'Falha ao exportar.', 'error');
      }
    });
  }
  function dl(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }
  window.kdExportMenu = exportMenu;

  // ── Picker de Galeria ─────────────────────────────────────────────────
  /* Cache curto do /api/gallery — o payload é pesado (data URIs de imagens
     antigas + metadata). Refetcha a cada open (30s TTL). */
  const _GAL = { cache: null, cachedAt: 0, clients: [] };

  async function kdGalleryOpen() {
    if (!KD.editor) return;
    const modal = $('kd-gallery-modal');
    modal.hidden = false;
    // Popular filtro de squad
    const wsSel = $('kd-gal-f-ws');
    wsSel.innerHTML = '<option value="">Todos os squads</option>' +
      KD.workspaces.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');
    // Load com cache 30s
    if (!_GAL.cache || (Date.now() - _GAL.cachedAt) > 30000) {
      $('kd-gal-grid').innerHTML = '<div class="kd-gal-empty">Carregando galeria…</div>';
      try {
        // meta=1 — mais leve, sem base64
        _GAL.cache = await api('/gallery?meta=1');
        _GAL.cachedAt = Date.now();
      } catch (e) {
        $('kd-gal-grid').innerHTML = '<div class="kd-gal-empty">' + esc(e.message || 'Falha ao carregar.') + '</div>';
        return;
      }
    }
    // Popular filtro de cliente (deduplicado)
    const seen = new Set();
    _GAL.clients = [];
    for (const a of _GAL.cache) {
      if (a.clientId && !seen.has(a.clientId)) { seen.add(a.clientId); _GAL.clients.push({ id: a.clientId, name: a.clientName || '—' }); }
    }
    _GAL.clients.sort((a, b) => a.name.localeCompare(b.name));
    $('kd-gal-f-client').innerHTML = '<option value="">Todos os clientes</option>' +
      _GAL.clients.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    kdGalleryRender();
  }
  window.kdGalleryOpen = kdGalleryOpen;

  function kdGalleryClose() { const m = $('kd-gallery-modal'); if (m) m.hidden = true; }
  window.kdGalleryClose = kdGalleryClose;

  function _galKindOf(att) {
    const mime = String(att.type || '').toLowerCase();
    const ext  = (att.name || '').split('.').pop().toLowerCase();
    // Muitos anexos vieram com mime vazio no banco antigo — precisamos cair
    // sempre pra extensão pra detectar imagens (o preview inline depende disso).
    if (mime.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','avif','heic','heif'].includes(ext)) return 'image';
    if (mime.startsWith('video/') || ['mp4','webm','mov','mkv','avi'].includes(ext)) return 'video';
    if (mime.startsWith('audio/') || ['mp3','wav','ogg','m4a','flac'].includes(ext)) return 'audio';
    if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (['doc','docx','odt','rtf','txt','md'].includes(ext)) return 'doc';
    if (['ppt','pptx','key','odp'].includes(ext)) return 'slide';
    if (['xls','xlsx','csv','ods'].includes(ext)) return 'sheet';
    if (att.kind === 'link' || mime === 'text/uri-list') return 'link';
    return 'file';
  }

  function kdGalleryRender() {
    const grid = $('kd-gal-grid');
    if (!grid || !_GAL.cache) return;
    const q = ($('kd-gal-search').value || '').trim().toLowerCase();
    const ws = $('kd-gal-f-ws').value || '';
    const client = $('kd-gal-f-client').value || '';
    const kind = $('kd-gal-f-kind').value || '';

    let list = _GAL.cache.slice();
    if (ws)     list = list.filter(a => a.workspaceId === ws);
    if (client) list = list.filter(a => a.clientId === client);
    if (kind)   list = list.filter(a => _galKindOf(a) === kind);
    if (q) list = list.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.clientName || '').toLowerCase().includes(q) ||
      (a.projectName || '').toLowerCase().includes(q) ||
      (a.demandName || '').toLowerCase().includes(q)
    );
    // Sort: mais recente primeiro
    list.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

    if (!list.length) {
      grid.innerHTML = '<div class="kd-gal-empty">Nenhum arquivo encontrado com esses filtros.</div>';
      return;
    }
    grid.innerHTML = list.slice(0, 240).map(a => {
      const k = _galKindOf(a);
      const ext = (a.name || '').split('.').pop().toUpperCase().slice(0, 5) || 'FILE';
      const thumb = k === 'image' && a.url
        ? `<img src="${esc(a.url)}" alt="" loading="lazy">`
        : `<div class="kd-gal-thumb-ext">${esc(ext)}</div>`;
      const meta = [a.clientName, a.projectName].filter(Boolean).join(' · ');
      return `<div class="kd-gal-card" data-att-id="${esc(a.id)}">
        <div class="kd-gal-thumb">${thumb}</div>
        <div class="kd-gal-info">
          <div class="kd-gal-name" title="${esc(a.name || '')}">${esc(a.name || 'arquivo')}</div>
          <div class="kd-gal-sub">${esc(meta || _fmtSize(a.size))}</div>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.kd-gal-card').forEach(c => {
      c.addEventListener('click', () => {
        const a = _GAL.cache.find(x => x.id === c.dataset.attId);
        if (a) kdGalleryInsert(a);
      });
    });
  }
  window.kdGalleryRender = kdGalleryRender;

  function kdGalleryInsert(att) {
    const ed = KD.editor; if (!ed) return;
    const k = _galKindOf(att);
    // Anexos antigos guardam o path em `data` (campo legado); os novos em `url`.
    // Ambos são o mesmo /uploads/<file>. Prioriza url, fallback data.
    const src = att.url || (typeof att.data === 'string' && att.data.startsWith('/uploads/') ? att.data : '');
    ed.commands.insertKastorAttachment({
      attachmentId: att.id,
      name: att.name || '',
      mime: att.type || '',
      url: src,
      size: att.size || 0,
      kind: k,
      isImage: k === 'image'
    });
    kdGalleryClose();
    toast('Anexo inserido.');
  }
  function _fmtSize(bytes) {
    if (!bytes) return '—';
    const u = ['B','KB','MB','GB'];
    let i = 0; let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  // ── Comentários ancorados ─────────────────────────────────────────────
  /* Estado: threads carregadas do backend + flag "mostrar resolvidos".
     `pending` = thread nova ainda não salva (o mark foi colocado mas ninguém
     escreveu texto). Fica no painel esperando o usuário digitar. */
  const KDC = { threads: [], showResolved: false, activeThreadId: null, panelOpen: false, pending: null };

  async function kdCommentsLoad() {
    if (!KD.currentDoc) return;
    try {
      const q = KDC.showResolved ? '?all=1' : '';
      KDC.threads = await api('/writer/' + KD.currentDoc.id + '/comments' + q);
    } catch (e) {
      KDC.threads = [];
    }
    kdCommentsRender();
    kdCommentsSyncMarksResolvedState();
    kdCommentsUpdateBadge();
  }

  function kdCommentsUpdateBadge() {
    const badge = $('kd-topbar-comments-badge');
    if (!badge) return;
    const openCount = KDC.threads.filter(t => !t.resolvedAt).length + (KDC.pending ? 1 : 0);
    if (openCount > 0) { badge.hidden = false; badge.textContent = openCount; }
    else badge.hidden = true;
  }

  /* Aplica classe .is-resolved nos marks cuja thread foi resolvida. Também
     detecta "orphans" (thread existe no back mas o mark foi deletado do texto)
     e informa no painel. */
  function kdCommentsSyncMarksResolvedState() {
    if (!KD.editor) return;
    const mountedIds = new Set(_kdCurrentMarkThreadIds());
    // 1) Adiciona/remove classe .is-resolved nos <span> marks conforme back
    document.querySelectorAll('.kastor-comment-mark[data-thread-id]').forEach(el => {
      const tid = el.dataset.threadId;
      const t = KDC.threads.find(x => x.id === tid);
      el.classList.toggle('is-resolved', !!(t && t.resolvedAt));
    });
    // 2) Marca threads órfãs (thread ainda no back, mark sumiu do texto)
    for (const t of KDC.threads) t._orphan = !mountedIds.has(t.id) && !KDC.pending?.threadId === t.id;
  }
  function _kdCurrentMarkThreadIds() {
    if (!KD.editor) return [];
    const out = new Set();
    KD.editor.state.doc.descendants(node => {
      for (const m of node.marks || []) {
        if (m.type.name === 'kastorComment' && m.attrs.threadId) out.add(m.attrs.threadId);
      }
    });
    return Array.from(out);
  }

  function kdCommentsPanelToggle() {
    KDC.panelOpen = !KDC.panelOpen;
    $('kd-comments-panel').hidden = !KDC.panelOpen;
    if (KDC.panelOpen) { kdCommentsLoad(); }
    _kdRenderCommentBubbles();
  }
  function kdCommentsPanelClose() { KDC.panelOpen = false; $('kd-comments-panel').hidden = true; _kdRenderCommentBubbles(); }
  window.kdCommentsPanelToggle = kdCommentsPanelToggle;
  window.kdCommentsPanelClose  = kdCommentsPanelClose;

  function kdCommentsToggleResolved() {
    KDC.showResolved = !KDC.showResolved;
    $('kd-comments-showresolved').classList.toggle('is-active', KDC.showResolved);
    kdCommentsLoad();
  }
  window.kdCommentsToggleResolved = kdCommentsToggleResolved;

  /* Fluxo de criação: coloca mark com threadId novo, guarda em `pending`,
     abre painel focado no textarea. Se usuário cancela, tira o mark. */
  function kdCommentSelectionStart() {
    const ed = KD.editor;
    if (!ed) return;
    const { from, to, empty } = ed.state.selection;
    if (empty) { toast('Selecione um trecho de texto pra comentar.', 'error'); return; }
    const quoted = ed.state.doc.textBetween(from, to, ' ').slice(0, 300);
    const threadId = 'th_' + Math.random().toString(36).slice(2, 12);
    // Aplica mark no range
    ed.chain().focus().setKastorComment(threadId).run();
    KDC.pending = { threadId, quotedText: quoted };
    KDC.panelOpen = true;
    KDC.activeThreadId = threadId;
    $('kd-comments-panel').hidden = false;
    kdCommentsRender();
    setTimeout(() => {
      const ta = document.querySelector(`[data-pending="${threadId}"] textarea`);
      if (ta) ta.focus();
    }, 30);
  }
  window.kdCommentSelectionStart = kdCommentSelectionStart;

  function kdCommentsCancelPending() {
    if (!KDC.pending) return;
    const tid = KDC.pending.threadId;
    KD.editor.commands.unsetKastorCommentById(tid);
    KDC.pending = null;
    if (KDC.activeThreadId === tid) KDC.activeThreadId = null;
    kdCommentsRender();
    kdCommentsUpdateBadge();
  }
  window.kdCommentsCancelPending = kdCommentsCancelPending;

  async function kdCommentsSubmitPending(textareaEl) {
    if (!KDC.pending) return;
    const message = (textareaEl.value || '').trim();
    if (!message) { textareaEl.focus(); return; }
    const { threadId, quotedText } = KDC.pending;
    try {
      const t = await api('/writer/' + KD.currentDoc.id + '/comments', 'POST', { threadId, quotedText, message });
      KDC.threads.unshift(t);
      KDC.pending = null;
      kdCommentsRender();
      kdCommentsUpdateBadge();
    } catch (e) {
      toast(e.message || 'Falha ao criar comentário.', 'error');
    }
  }
  window.kdCommentsSubmitPending = kdCommentsSubmitPending;

  async function kdCommentsReply(threadId, textareaEl) {
    const message = (textareaEl.value || '').trim();
    if (!message) return;
    try {
      const t = await api('/writer/' + KD.currentDoc.id + '/comments/' + threadId + '/reply', 'POST', { message });
      const i = KDC.threads.findIndex(x => x.id === threadId);
      if (i >= 0) KDC.threads[i] = t;
      textareaEl.value = '';
      kdCommentsRender();
    } catch (e) { toast(e.message || 'Falha ao responder.', 'error'); }
  }
  window.kdCommentsReply = kdCommentsReply;

  async function kdCommentsResolve(threadId) {
    try {
      const t = await api('/writer/' + KD.currentDoc.id + '/comments/' + threadId + '/resolve', 'POST');
      const i = KDC.threads.findIndex(x => x.id === threadId);
      if (i >= 0) KDC.threads[i] = t;
      // Remove o mark do texto (evita highlight de resolvido)
      KD.editor.commands.unsetKastorCommentById(threadId);
      kdCommentsRender();
      kdCommentsUpdateBadge();
    } catch (e) { toast(e.message || 'Falha ao resolver.', 'error'); }
  }
  window.kdCommentsResolve = kdCommentsResolve;

  async function kdCommentsReopen(threadId) {
    try {
      const t = await api('/writer/' + KD.currentDoc.id + '/comments/' + threadId + '/reopen', 'POST');
      const i = KDC.threads.findIndex(x => x.id === threadId);
      if (i >= 0) KDC.threads[i] = t;
      kdCommentsRender();
      kdCommentsUpdateBadge();
    } catch (e) { toast(e.message || 'Falha ao reabrir.', 'error'); }
  }
  window.kdCommentsReopen = kdCommentsReopen;

  async function kdCommentsDelete(threadId) {
    kdConfirmModal('Excluir thread?', 'A conversa toda será perdida.', 'Excluir', async (ok) => {
      if (!ok) return;
      try {
        await api('/writer/' + KD.currentDoc.id + '/comments/' + threadId, 'DELETE');
        KDC.threads = KDC.threads.filter(x => x.id !== threadId);
        KD.editor.commands.unsetKastorCommentById(threadId);
        kdCommentsRender();
        kdCommentsUpdateBadge();
      } catch (e) { toast(e.message || 'Falha ao excluir.', 'error'); }
    });
  }
  window.kdCommentsDelete = kdCommentsDelete;

  function kdCommentsRender() {
    const list = $('kd-comments-list');
    if (!list) return;
    const count = KDC.threads.length + (KDC.pending ? 1 : 0);
    $('kd-comments-count').textContent = count;
    const parts = [];

    // Pending (nova thread em criação)
    if (KDC.pending) {
      parts.push(
        `<div class="kd-comment-thread is-active" data-pending="${esc(KDC.pending.threadId)}">
           ${KDC.pending.quotedText ? `<div class="kd-comment-quote">"${esc(KDC.pending.quotedText)}"</div>` : ''}
           <div class="kd-comment-reply">
             <textarea placeholder="Escreva seu comentário…" onkeydown="if(event.key==='Enter'&&(event.metaKey||event.ctrlKey))kdCommentsSubmitPending(this)"></textarea>
           </div>
           <div class="kd-comment-thread-actions">
             <button class="kd-comment-action-btn" onclick="kdCommentsCancelPending()">Cancelar</button>
             <button class="kd-comment-action-btn is-primary" onclick="kdCommentsSubmitPending(this.closest('.kd-comment-thread').querySelector('textarea'))">Comentar</button>
           </div>
         </div>`
      );
    }

    // Sem threads e sem pending
    if (KDC.threads.length === 0 && !KDC.pending) {
      parts.push(`<div class="kd-comment-empty">Sem comentários. Selecione um trecho do texto e clique no ícone de balão pra começar uma conversa.</div>`);
    }

    // Threads existentes
    for (const t of KDC.threads) {
      const isActive = KDC.activeThreadId === t.id;
      const isOrphan = t._orphan;
      const isResolved = !!t.resolvedAt;
      parts.push(
        `<div class="kd-comment-thread${isActive?' is-active':''}${isOrphan?' is-orphan':''}${isResolved?' is-resolved':''}" data-thread-id="${esc(t.id)}">
           ${t.quotedText ? `<div class="kd-comment-quote">"${esc(t.quotedText)}"</div>` : ''}
           ${t.messages.map(m => _kdRenderMsg(m)).join('')}
           ${isResolved
             ? `<div class="kd-comment-thread-actions">
                  <span style="flex:1;font-size:11px;color:var(--text-2)">Resolvida por ${esc(t.resolvedBy?.name || '—')} em ${esc(_kdFmtDateShort(t.resolvedAt))}</span>
                  <button class="kd-comment-action-btn" onclick="kdCommentsReopen('${esc(t.id)}')">Reabrir</button>
                </div>`
             : `<div class="kd-comment-reply">
                  <textarea placeholder="Responder…" onkeydown="if(event.key==='Enter'&&(event.metaKey||event.ctrlKey))kdCommentsReply('${esc(t.id)}', this)"></textarea>
                </div>
                <div class="kd-comment-thread-actions">
                  <button class="kd-comment-icon-btn kd-comment-icon-btn--danger" onclick="kdCommentsDelete('${esc(t.id)}')" title="Excluir thread" aria-label="Excluir">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                  <button class="kd-comment-icon-btn kd-comment-icon-btn--success" onclick="kdCommentsResolve('${esc(t.id)}')" title="Resolver" aria-label="Resolver">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                  <div style="flex:1"></div>
                  <button class="kd-comment-action-btn is-primary" onclick="kdCommentsReply('${esc(t.id)}', this.closest('.kd-comment-thread').querySelector('textarea'))">Responder</button>
                </div>`}
         </div>`
      );
    }
    list.innerHTML = parts.join('');
    _kdRenderCommentBubbles();
  }

  /* ── Balões flutuantes de comentário ────────────────────────────────
     Para cada thread com mark no DOM, cria um balão à direita do paper,
     alinhado verticalmente com a Y da primeira ocorrência do mark. Se dois
     balões se sobrepõem, o de baixo é empurrado pra não invadir o de cima. */
  function _kdRenderCommentBubbles() {
    const host = $('kd-comment-bubbles');
    if (!host || !KD.editor) return;
    // Se painel lateral aberto → esconde balões (evita duplicação visual)
    if (KDC.panelOpen) { host.innerHTML = ''; return; }
    // Coleta uma entrada por thread com seu Y natural (relativo ao scroll)
    const scroll = document.querySelector('.writer-editor-scroll');
    if (!scroll) return;
    const scrollRect = scroll.getBoundingClientRect();
    const scrollTop = scroll.scrollTop;
    const items = [];
    const seen = new Set();
    document.querySelectorAll('.kastor-comment-mark[data-thread-id]').forEach(el => {
      const tid = el.dataset.threadId;
      if (seen.has(tid)) return;
      const t = KDC.threads.find(x => x.id === tid);
      if (!t) return;
      // Só thread não-resolvida OU showResolved habilitado
      if (t.resolvedAt && !KDC.showResolved) return;
      seen.add(tid);
      const r = el.getBoundingClientRect();
      // Y relativo ao scroll = distância do mark ao topo do scroll + scrollTop
      const y = r.top - scrollRect.top + scrollTop;
      items.push({ thread: t, y });
    });
    // Ordena por Y ascendente
    items.sort((a, b) => a.y - b.y);
    // Render
    host.innerHTML = items.map(it => _kdBubbleHTML(it.thread, it.y)).join('');
    // Após montagem, aplica empilhamento (empurra pra baixo se sobrepõe)
    _kdStackBubbles();
    // Wire click nos balões
    host.querySelectorAll('.kd-comment-bubble').forEach(b => {
      b.addEventListener('click', (ev) => {
        // Se já expandido, não colapsa ao clicar dentro (só via botão externo)
        if (b.classList.contains('kd-comment-bubble--expanded')) return;
        // Colapsa todos + expande este
        const tid = b.dataset.threadId;
        _kdBubbleExpand(tid);
      });
    });
  }
  function _kdBubbleHTML(t, y) {
    const first = (t.messages && t.messages[0]) || null;
    const author = first?.author || {};
    const initial = (author.name || '?').charAt(0).toUpperCase();
    const avatar = author.avatar
      ? `<img src="${esc(author.avatar)}" alt="">`
      : esc(initial);
    const text = first?.body || first?.text || '(sem conteúdo)';
    const moreCount = Math.max(0, (t.messages?.length || 0) - 1);
    const resolvedClass = t.resolvedAt ? ' is-resolved' : '';
    return `<div class="kd-comment-bubble${resolvedClass}" data-thread-id="${esc(t.id)}" data-y="${Math.round(y)}" style="top:${Math.round(y)}px">
      <div class="kd-comment-bubble-head">
        <div class="kd-comment-bubble-avatar">${avatar}</div>
        <div class="kd-comment-bubble-author">${esc(author.name || 'Usuário')}</div>
        <div class="kd-comment-bubble-when">${esc(_kdFmtDateShort(first?.at))}</div>
      </div>
      <div class="kd-comment-bubble-text">${esc(text)}</div>
      ${moreCount > 0 ? `<div class="kd-comment-bubble-count">+${moreCount} resposta${moreCount > 1 ? 's' : ''}</div>` : ''}
    </div>`;
  }
  /* Empilhamento: bubble N não pode iniciar antes do fim do bubble N-1 + gap */
  function _kdStackBubbles() {
    const host = $('kd-comment-bubbles');
    if (!host) return;
    const bubbles = Array.from(host.children).sort((a, b) =>
      Number(a.dataset.y) - Number(b.dataset.y)
    );
    const gap = 8;
    let prevBottom = -Infinity;
    for (const b of bubbles) {
      const nat = Number(b.dataset.y);
      const top = Math.max(nat, prevBottom + gap);
      b.style.top = top + 'px';
      prevBottom = top + b.offsetHeight;
    }
  }
  /* Expande um balão pra edição inline (mensagens completas + reply + actions) */
  function _kdBubbleExpand(threadId) {
    const host = $('kd-comment-bubbles');
    if (!host) return;
    // Colapsa qualquer outro expandido
    host.querySelectorAll('.kd-comment-bubble--expanded').forEach(b => {
      const tid = b.dataset.threadId;
      if (tid !== threadId) _kdBubbleCollapse(b);
    });
    const b = host.querySelector('.kd-comment-bubble[data-thread-id="' + CSS.escape(threadId) + '"]');
    if (!b || b.classList.contains('kd-comment-bubble--expanded')) return;
    const t = KDC.threads.find(x => x.id === threadId);
    if (!t) return;
    b.classList.add('kd-comment-bubble--expanded', 'is-active');
    KDC.activeThreadId = threadId;
    b.innerHTML = _kdBubbleExpandedHTML(t);
    b.addEventListener('click', (e) => e.stopPropagation(), { once: false });
    _kdStackBubbles();
  }
  function _kdBubbleCollapse(b) {
    b.classList.remove('kd-comment-bubble--expanded', 'is-active');
    const tid = b.dataset.threadId;
    const t = KDC.threads.find(x => x.id === tid);
    if (!t) return;
    // Reinjeta HTML colapsado (usa mesma template)
    const y = Number(b.dataset.y);
    b.outerHTML = _kdBubbleHTML(t, y);
    // Reengancha click no novo elemento
    const newB = $('kd-comment-bubbles').querySelector('.kd-comment-bubble[data-thread-id="' + CSS.escape(tid) + '"]');
    if (newB) newB.addEventListener('click', () => _kdBubbleExpand(tid));
    _kdStackBubbles();
  }
  function _kdBubbleExpandedHTML(t) {
    const isResolved = !!t.resolvedAt;
    const msgs = (t.messages || []).map(m => {
      const initial = (m.author?.name || '?').charAt(0).toUpperCase();
      const av = m.author?.avatar ? `<img src="${esc(m.author.avatar)}" alt="">` : esc(initial);
      return `<div class="kd-comment-bubble-msg">
        <div class="kd-comment-bubble-head">
          <div class="kd-comment-bubble-avatar">${av}</div>
          <div class="kd-comment-bubble-author">${esc(m.author?.name || 'Usuário')}</div>
          <div class="kd-comment-bubble-when">${esc(_kdFmtDateShort(m.at))}</div>
        </div>
        <div class="kd-comment-bubble-text">${esc(m.body || m.text || '')}</div>
      </div>`;
    }).join('');
    const actions = isResolved
      ? `<div class="kd-comment-bubble-actions">
           <button class="kd-comment-action-btn" onclick="kdCommentsReopen('${esc(t.id)}');event.stopPropagation()">Reabrir</button>
         </div>`
      : `<div class="kd-comment-bubble-reply">
           <textarea placeholder="Responder…" onclick="event.stopPropagation()" onkeydown="event.stopPropagation();if(event.key==='Enter'&&(event.metaKey||event.ctrlKey))kdCommentsReply('${esc(t.id)}', this)"></textarea>
         </div>
         <div class="kd-comment-bubble-actions">
           <button class="kd-comment-icon-btn kd-comment-icon-btn--danger" onclick="kdCommentsDelete('${esc(t.id)}');event.stopPropagation()" title="Excluir thread" aria-label="Excluir">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
           </button>
           <button class="kd-comment-icon-btn kd-comment-icon-btn--success" onclick="kdCommentsResolve('${esc(t.id)}');event.stopPropagation()" title="Resolver" aria-label="Resolver">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
           </button>
           <div style="flex:1"></div>
           <button class="kd-comment-action-btn is-primary" onclick="event.stopPropagation();kdCommentsReply('${esc(t.id)}', this.closest('.kd-comment-bubble').querySelector('textarea'))">Responder</button>
         </div>`;
    return msgs + actions;
  }
  // Click fora dos balões → colapsa qualquer expandido
  document.addEventListener('click', (e) => {
    if (e.target.closest('.kd-comment-bubble, .kastor-comment-mark, [onclick*="kdComments"]')) return;
    const host = $('kd-comment-bubbles');
    if (!host) return;
    host.querySelectorAll('.kd-comment-bubble--expanded').forEach(b => _kdBubbleCollapse(b));
  });

  function _kdRenderMsg(m) {
    return `<div class="kd-comment-msg">
      <div class="kd-comment-avatar">${
        m.author?.avatar
          ? `<img src="${esc(m.author.avatar)}" alt="">`
          : esc((m.author?.name || '?').charAt(0).toUpperCase())
      }</div>
      <div class="kd-comment-msg-body">
        <div class="kd-comment-msg-head">
          <span class="kd-comment-msg-author">${esc(m.author?.name || 'Usuário')}</span>
          <span class="kd-comment-msg-when">${esc(_kdFmtDateShort(m.at))}</span>
        </div>
        <div class="kd-comment-msg-text">${esc(m.body || '')}</div>
      </div>
    </div>`;
  }

  function _kdFmtDateShort(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffH = (now - d) / 36e5;
      if (diffH < 1) return Math.max(1, Math.round(diffH * 60)) + 'min';
      if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    } catch { return ''; }
  }

  /* Click no mark do documento → destaca a thread correspondente no painel */
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest('.kastor-comment-mark');
    if (!el) return;
    const tid = el.dataset.threadId;
    if (!tid) return;
    KDC.activeThreadId = tid;
    if (!KDC.panelOpen) kdCommentsPanelToggle();
    kdCommentsRender();
    // Scroll o painel até a thread
    setTimeout(() => {
      const th = document.querySelector(`.kd-comment-thread[data-thread-id="${CSS.escape(tid)}"]`);
      if (th) th.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  });

  // ── Compartilhar (permissões) ─────────────────────────────────────────
  const KDS = { data: null, searchTimer: null };
  const ROLE_LABELS = { owner: 'Dono', editor: 'Editor', commenter: 'Comentarista', viewer: 'Leitor' };

  async function kdShareOpen() {
    if (!KD.currentDoc) return;
    $('kd-share-modal').hidden = false;
    $('kd-share-search').value = '';
    $('kd-share-suggest').hidden = true;
    await kdShareLoad();
  }
  window.kdShareOpen = kdShareOpen;
  function kdShareClose() { $('kd-share-modal').hidden = true; }
  window.kdShareClose = kdShareClose;

  async function kdShareLoad() {
    try {
      KDS.data = await api('/writer/' + KD.currentDoc.id + '/permissions');
    } catch (e) {
      toast(e.message || 'Falha ao carregar permissões.', 'error');
      KDS.data = null;
    }
    _kdShareRender();
  }

  function _kdShareRender() {
    const list = $('kd-share-list');
    const rest = $('kd-share-restricted');
    if (!KDS.data) { list.innerHTML = '<div class="kd-share-suggest-empty">—</div>'; return; }
    const isOwner = KDS.data.myRole === 'owner';
    rest.checked = !!KDS.data.restricted;
    rest.disabled = !isOwner;
    list.innerHTML = (KDS.data.permissions || []).map(p => _kdShareItem(p, isOwner)).join('') || '<div class="kd-share-suggest-empty">Nenhuma pessoa adicionada ainda.</div>';
    // Estado do link público
    const pubToggle  = $('kd-share-public-toggle');
    const pubLinkBox = $('kd-share-public-link');
    const pubUrlIn   = $('kd-share-public-url');
    if (pubToggle) {
      pubToggle.checked = !!KDS.data.publicShareEnabled;
      pubToggle.disabled = !isOwner;
    }
    if (KDS.data.publicShareEnabled && KDS.data.publicShareUrl) {
      pubLinkBox.hidden = false;
      pubUrlIn.value = location.origin + KDS.data.publicShareUrl;
      if (KD.currentDoc) KD.currentDoc._publicUrl = KDS.data.publicShareUrl;
    } else {
      pubLinkBox.hidden = true;
      pubUrlIn.value = '';
    }
    // Aprovação do cliente
    const apBox = $('kd-share-approval');
    if (apBox && KD.currentDoc) {
      const a = KD.currentDoc.approval;
      const st = a && KD_APPROVAL[a.status];
      apBox.querySelector('.kd-share-approval-status').innerHTML = st
        ? `<span class="kd-approval-badge ${st.cls}">${st.label}</span>${a.decidedBy ? ' <span class="kd-share-approval-by">por ' + esc(a.decidedBy) + '</span>' : ''}`
        : '';
      const btn = apBox.querySelector('[data-ap]');
      btn.textContent = a && a.status === 'pending' ? 'Cancelar pedido' : (a ? 'Pedir de novo' : 'Pedir aprovação');
      btn.dataset.ap = a && a.status === 'pending' ? 'cancel' : 'request';
      btn.disabled = !['owner', 'editor'].includes(KD.myRole);
    }
  }

  function _kdShareItem(p, canEdit) {
    // Dono é fixo em quem criou o doc (não pode ser alterado, nem promover
    // outros). O <select> só oferece editor/commenter/viewer.
    const roleSel = p.isOwner ? '<span class="kd-share-item-owner-tag">DONO</span>' :
      `<select ${canEdit ? '' : 'disabled'} onchange="kdShareChangeRole('${esc(p.id)}', this.value)">
        <option value="editor" ${p.role==='editor'?'selected':''}>Editor</option>
        <option value="commenter" ${p.role==='commenter'?'selected':''}>Comentarista</option>
        <option value="viewer" ${p.role==='viewer'?'selected':''}>Leitor</option>
      </select>
      ${canEdit ? `<button class="kd-share-remove" onclick="kdShareRemove('${esc(p.id)}')" title="Remover">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>` : ''}`;
    const avatarInner = p.avatar
      ? `<img src="${esc(p.avatar)}" alt="">`
      : esc((p.name || '?').charAt(0).toUpperCase());
    return `<div class="kd-share-item ${p.isOwner ? 'is-owner' : ''}">
      <div class="kd-share-item-avatar">${avatarInner}</div>
      <div class="kd-share-item-body">
        <div class="kd-share-item-name">${esc(p.name)}</div>
        <div class="kd-share-item-sub">${esc(p.email || p.username || '—')}</div>
      </div>
      <div class="kd-share-item-role">${roleSel}</div>
    </div>`;
  }

  async function kdShareChangeRole(userId, role) {
    try {
      const r = await api('/writer/' + KD.currentDoc.id + '/permissions', 'PATCH', { updates: [{ userId, role }] });
      KDS.data.permissions = r.permissions;
      _kdShareRender();
      toast('Permissão atualizada.');
    } catch (e) { toast(e.message || 'Falha ao atualizar.', 'error'); }
  }
  window.kdShareChangeRole = kdShareChangeRole;

  async function kdShareRemove(userId) {
    kdConfirmModal('Remover acesso?', 'Essa pessoa não vai mais conseguir abrir o documento.', 'Remover', async (ok) => {
      if (!ok) return;
      try {
        const r = await api('/writer/' + KD.currentDoc.id + '/permissions', 'PATCH', { remove: [userId] });
        KDS.data.permissions = r.permissions;
        _kdShareRender();
      } catch (e) { toast(e.message || 'Falha ao remover.', 'error'); }
    });
  }
  window.kdShareRemove = kdShareRemove;

  async function kdShareToggleRestricted(v) {
    try {
      const r = await api('/writer/' + KD.currentDoc.id + '/permissions', 'PATCH', { restricted: v });
      KDS.data.restricted = r.restricted;
      _kdShareRender();
    } catch (e) { toast(e.message || 'Falha ao atualizar.', 'error'); kdShareLoad(); }
  }
  window.kdShareToggleRestricted = kdShareToggleRestricted;

  async function kdSharePublicToggle(enable) {
    if (!KD.currentDoc) return;
    try {
      const r = enable
        ? await api('/writer/' + KD.currentDoc.id + '/public-link', 'POST')
        : await api('/writer/' + KD.currentDoc.id + '/public-link', 'DELETE');
      KDS.data.publicShareEnabled = !!r.enabled;
      KDS.data.publicShareUrl = r.url || null;
      _kdShareRender();
      toast(enable ? 'Link público gerado.' : 'Link público desativado.');
    } catch (e) {
      toast(e.message || 'Falha ao atualizar link público.', 'error');
      // Reverte visual do toggle se der ruim
      const t = $('kd-share-public-toggle'); if (t) t.checked = !enable;
    }
  }
  window.kdSharePublicToggle = kdSharePublicToggle;
  window.kdShareApproval = (btn) => btn.dataset.ap === 'cancel' ? _kdApprovalCancel() : _kdApprovalRequest();

  window.kdSharePublicCopy = function () {
    const inp = $('kd-share-public-url');
    if (!inp || !inp.value) return;
    try {
      navigator.clipboard.writeText(inp.value);
      toast('Link copiado.');
    } catch {
      inp.select();
      try { document.execCommand('copy'); toast('Link copiado.'); }
      catch { toast('Não consegui copiar. Selecione manualmente.', 'error'); }
    }
  };

  /* Autocomplete no input de busca: debounce 200ms, consulta /users-suggest */
  document.addEventListener('input', (ev) => {
    if (ev.target?.id !== 'kd-share-search') return;
    clearTimeout(KDS.searchTimer);
    KDS.searchTimer = setTimeout(() => _kdShareSearch(ev.target.value), 200);
  });
  document.addEventListener('click', (ev) => {
    const sugg = $('kd-share-suggest');
    if (!sugg || sugg.hidden) return;
    if (sugg.contains(ev.target) || ev.target?.id === 'kd-share-search') return;
    sugg.hidden = true;
  });

  async function _kdShareSearch(q) {
    const sugg = $('kd-share-suggest');
    if (!KD.currentDoc) return;
    try {
      const users = await api('/writer/' + KD.currentDoc.id + '/users-suggest?q=' + encodeURIComponent(q || ''));
      if (!users.length) {
        sugg.innerHTML = '<div class="kd-share-suggest-empty">Ninguém encontrado.</div>';
      } else {
        sugg.innerHTML = users.map(u =>
          `<div class="kd-share-suggest-item" data-user-id="${esc(u.id)}">
            <div class="kd-share-suggest-avatar">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc((u.name || '?').charAt(0).toUpperCase())}</div>
            <div class="kd-share-suggest-body">
              <div class="kd-share-suggest-name">${esc(u.name)}</div>
              <div class="kd-share-suggest-sub">${esc(u.email || u.username || '—')}</div>
            </div>
            ${u.inWorkspace ? '<span class="kd-share-suggest-ws-badge">SQUAD</span>' : ''}
          </div>`
        ).join('');
        sugg.querySelectorAll('.kd-share-suggest-item').forEach(el => {
          el.addEventListener('click', () => _kdShareAddPick(el.dataset.userId));
        });
      }
      sugg.hidden = false;
    } catch {}
  }

  async function _kdShareAddPick(userId) {
    const role = $('kd-share-add-role').value || 'editor';
    try {
      const r = await api('/writer/' + KD.currentDoc.id + '/permissions', 'PATCH', { add: [{ userId, role }] });
      KDS.data.permissions = r.permissions;
      _kdShareRender();
      $('kd-share-search').value = '';
      $('kd-share-suggest').hidden = true;
      toast('Pessoa adicionada.');
    } catch (e) { toast(e.message || 'Falha ao adicionar.', 'error'); }
  }

  // ── Time-machine (histórico de versões) ──────────────────────────────
  const KDH = { list: [], activeId: null, activeContent: null, autoSaveCount: 0, autoTimer: null, viewMode: 'diff', compareTo: 'prev' };

  /* ── Diff word-level via LCS ──
     Divide dois textos em "tokens" (palavras + whitespace + pontuação),
     encontra o LCS via DP e emite tuplas {op, text}:
       op = 0 → equal (comum)
       op = 1 → add   (só em `b`)
       op = -1 → remove (só em `a`)
     Suficiente pra highlight visual — não é semantic diff. */
  function _diffTokenize(str) {
    // Quebra em palavras, mantendo delimitadores (spaces/pontuação) como tokens
    return String(str || '').split(/(\s+|[.,;:!?()"'\[\]{}—–\-]+)/).filter(Boolean);
  }
  function _diffLCS(a, b) {
    const n = a.length, m = b.length;
    // Limita pra evitar N*M explosivo em docs grandes — 800*800 = 640k comparações
    if (n * m > 800 * 800) return null; // sinaliza fallback
    const dp = new Int32Array((n + 1) * (m + 1));
    const w = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ op: 0, text: a[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ op: -1, text: a[i] }); i++; }
      else { ops.push({ op: 1, text: b[j] }); j++; }
    }
    while (i < n) { ops.push({ op: -1, text: a[i++] }); }
    while (j < m) { ops.push({ op: 1, text: b[j++] }); }
    // Consolida sequências consecutivas do mesmo op
    const merged = [];
    for (const o of ops) {
      const last = merged[merged.length - 1];
      if (last && last.op === o.op) last.text += o.text;
      else merged.push({ ...o });
    }
    return merged;
  }

  /* Extrai texto plano de PM JSON, com quebras entre blocos pra o diff
     fazer sentido linha a linha (headings, parágrafos, list items). */
  function _pmJsonToPlainText(n) {
    if (!n) return '';
    if (typeof n === 'string') return n;
    if (n.type === 'text') return n.text || '';
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'horizontalRule') return '\n———\n';
    if (n.type === 'kastorAttachment') return `\n[anexo: ${n.attrs?.name || 'arquivo'}]\n`;
    if (n.type === 'image') return `\n[imagem]\n`;
    const kids = (n.content || []).map(_pmJsonToPlainText).join('');
    const isBlock = ['paragraph','heading','listItem','blockquote','codeBlock','tableRow'].includes(n.type);
    return isBlock ? '\n' + kids : kids;
  }

  /* Renderiza diff como HTML com <ins>/<del>. */
  function _renderDiffHTML(oldJson, newJson) {
    const oldText = _pmJsonToPlainText(oldJson).replace(/^\n+/, '');
    const newText = _pmJsonToPlainText(newJson).replace(/^\n+/, '');
    if (oldText === newText) {
      return '<div class="kd-diff-empty">Sem alterações entre essas versões.</div>';
    }
    const a = _diffTokenize(oldText);
    const b = _diffTokenize(newText);
    const ops = _diffLCS(a, b);
    if (!ops) {
      // Fallback pra docs muito grandes: comparação linha a linha
      return _renderDiffLineFallback(oldText, newText);
    }
    let stats = { add: 0, del: 0 };
    const parts = ops.map(o => {
      if (o.op === 0)  return esc(o.text);
      const words = o.text.trim().split(/\s+/).filter(Boolean).length;
      if (o.op === 1)  { stats.add += words; return `<ins>${esc(o.text)}</ins>`; }
      if (o.op === -1) { stats.del += words; return `<del>${esc(o.text)}</del>`; }
    }).join('');
    const summary = `<div class="kd-diff-summary"><span class="kd-diff-stat kd-diff-stat-add">+${stats.add} palavras</span><span class="kd-diff-stat kd-diff-stat-del">−${stats.del} palavras</span></div>`;
    return summary + `<pre class="kd-diff-body">${parts}</pre>`;
  }

  function _renderDiffLineFallback(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const setOld = new Set(oldLines);
    const setNew = new Set(newLines);
    const parts = [];
    for (const l of oldLines) if (!setNew.has(l) && l.trim()) parts.push(`<del>− ${esc(l)}</del>`);
    for (const l of newLines) if (!setOld.has(l) && l.trim()) parts.push(`<ins>+ ${esc(l)}</ins>`);
    if (!parts.length) return '<div class="kd-diff-empty">Sem alterações relevantes.</div>';
    return `<pre class="kd-diff-body">${parts.join('\n')}</pre>`;
  }

  async function kdHistoryOpen() {
    if (!KD.currentDoc) return;
    const modal = $('kd-history-modal');
    modal.hidden = false;
    await kdHistoryLoad();
    // Preview vazio no início
    _kdHistoryRenderPreview(null);
  }
  window.kdHistoryOpen = kdHistoryOpen;
  function kdHistoryClose() { $('kd-history-modal').hidden = true; KDH.activeId = null; KDH.activeContent = null; }
  window.kdHistoryClose = kdHistoryClose;

  async function kdHistoryLoad() {
    try {
      KDH.list = await api('/writer/' + KD.currentDoc.id + '/versions');
    } catch (e) { KDH.list = []; toast(e.message || 'Falha ao carregar histórico.', 'error'); }
    _kdHistoryRenderList();
  }

  function _kdHistoryRenderList() {
    const list = $('kd-history-list');
    if (!list) return;
    if (!KDH.list.length) {
      list.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-2);font-size:12.5px">Sem versões salvas ainda. Clique no ícone de salvar acima pra criar uma.</div>`;
      return;
    }
    // Grupo "Atual" no topo
    const cur = `<div class="kd-history-item is-current" onclick="_kdHistoryShowCurrent()">
      <div class="kd-history-item-title">Versão atual</div>
      <div class="kd-history-item-meta"><span class="kd-history-item-current-tag">AGORA</span> · edição em andamento</div>
    </div>`;
    const rows = KDH.list.map(s => {
      const isActive = KDH.activeId === s.id;
      const isAuto = s.isAuto;
      const label = s.label || 'Salvamento automático';
      const by = s.by?.name || '—';
      const when = _kdFmtDateFull(s.at);
      return `<div class="kd-history-item ${isActive?'is-active':''} ${isAuto?'is-auto':''}" data-sid="${esc(s.id)}" onclick="kdHistoryShow('${esc(s.id)}')">
        <div class="kd-history-item-title">${esc(label)}</div>
        <div class="kd-history-item-meta">
          ${isAuto ? '' : '<span class="kd-history-item-badge">MARCO</span>'}
          <span>${esc(by)}</span><span style="opacity:.5">·</span><span>${esc(when)}</span>
        </div>
      </div>`;
    }).join('');
    list.innerHTML = cur + rows;
  }

  function _kdFmtDateFull(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      if (sameDay) return 'Hoje, ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const y = new Date(now); y.setDate(y.getDate() - 1);
      if (d.toDateString() === y.toDateString()) return 'Ontem, ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  async function kdHistoryShow(sid) {
    KDH.activeId = sid;
    _kdHistoryRenderList();
    try {
      const s = await api('/writer/' + KD.currentDoc.id + '/versions/' + sid);
      KDH.activeContent = s.content;
      KDH.activeMeta = s;
      _kdHistoryRenderPreview(s);
    } catch (e) {
      toast(e.message || 'Falha ao carregar versão.', 'error');
    }
  }
  window.kdHistoryShow = kdHistoryShow;

  /* Retorna o conteúdo a comparar com base em `KDH.compareTo`.
     'prev' = versão salva imediatamente anterior na lista (mais antiga)
     'current' = conteúdo do editor no momento */
  async function _kdResolveCompareContent() {
    if (KDH.compareTo === 'current') return KD.editor?.getJSON() || null;
    // prev: a lista está ordenada mais-recente-primeiro; achamos o índice
    // do activeId, e pegamos o próximo (mais antigo).
    const idx = KDH.list.findIndex(x => x.id === KDH.activeId);
    if (idx < 0 || idx >= KDH.list.length - 1) return null; // não tem anterior
    const prev = KDH.list[idx + 1];
    try {
      const full = await api('/writer/' + KD.currentDoc.id + '/versions/' + prev.id);
      return full.content;
    } catch { return null; }
  }
  function kdHistorySetViewMode(mode) { KDH.viewMode = mode; if (KDH.activeMeta) _kdHistoryRenderPreview(KDH.activeMeta); }
  window.kdHistorySetViewMode = kdHistorySetViewMode;
  function kdHistorySetCompareTo(target) { KDH.compareTo = target; if (KDH.activeMeta) _kdHistoryRenderPreview(KDH.activeMeta); }
  window.kdHistorySetCompareTo = kdHistorySetCompareTo;

  function _kdHistoryShowCurrent() {
    KDH.activeId = null;
    KDH.activeContent = KD.editor.getJSON();
    _kdHistoryRenderList();
    _kdHistoryRenderPreview({ id: null, at: new Date().toISOString(), label: 'Versão atual (não salva)', by: KD.me ? { name: KD.me.name || KD.me.username } : null, isAuto: false, isCurrent: true });
  }
  window._kdHistoryShowCurrent = _kdHistoryShowCurrent;

  async function _kdHistoryRenderPreview(s) {
    const el = $('kd-history-preview');
    if (!s) { el.innerHTML = '<div class="kd-history-preview-empty">Selecione uma versão pra visualizar.</div>'; return; }
    const actions = s.isCurrent
      ? `<span style="font-size:12px;color:var(--text-2);align-self:center">Já é a versão atual</span>`
      : `<button class="kd-history-delete-btn" onclick="kdHistoryDelete('${esc(s.id)}')">Excluir</button>
         <button class="kd-history-restore-btn" onclick="kdHistoryRestore('${esc(s.id)}')">Restaurar essa versão</button>`;

    // Toggle Content ↔ Diff — só faz sentido pra versões salvas (não pra "atual")
    const mode = s.isCurrent ? 'content' : KDH.viewMode;
    const toggle = s.isCurrent ? '' : `
      <div class="kd-history-view-toggle">
        <div class="kd-history-view-tabs">
          <button class="kd-history-view-tab ${mode==='diff'?'is-active':''}" onclick="kdHistorySetViewMode('diff')">Diferenças</button>
          <button class="kd-history-view-tab ${mode==='content'?'is-active':''}" onclick="kdHistorySetViewMode('content')">Conteúdo</button>
        </div>
        ${mode === 'diff' ? `
        <div class="kd-history-compare-tabs">
          <span>vs</span>
          <button class="kd-history-compare-tab ${KDH.compareTo==='prev'?'is-active':''}" onclick="kdHistorySetCompareTo('prev')">versão anterior</button>
          <button class="kd-history-compare-tab ${KDH.compareTo==='current'?'is-active':''}" onclick="kdHistorySetCompareTo('current')">versão atual</button>
        </div>` : ''}
      </div>`;

    let body;
    if (mode === 'diff') {
      body = '<div class="kd-diff-loading">Calculando diferenças…</div>';
    } else {
      body = `<div class="kd-history-preview-content">${_pmToHtmlBasic(KDH.activeContent)}</div>`;
    }

    el.innerHTML = `
      <div class="kd-history-preview-head">
        <div>
          <div class="kd-history-preview-title">${esc(s.label || 'Salvamento automático')}</div>
          <div class="kd-history-preview-sub">${esc((s.by?.name || '—') + ' · ' + _kdFmtDateFull(s.at) + (s.size ? ' · ' + _fmtSize(s.size) : ''))}</div>
        </div>
        <div class="kd-history-preview-actions">${actions}</div>
      </div>
      ${toggle}
      <div id="kd-history-preview-body">${body}</div>`;

    if (mode === 'diff') {
      // async — busca a versão de comparação e roda o diff sem bloquear o render
      const compare = await _kdResolveCompareContent();
      const bodyEl = document.getElementById('kd-history-preview-body');
      if (!bodyEl) return;
      if (!compare) {
        const msg = KDH.compareTo === 'prev'
          ? 'Essa é a versão mais antiga — não há anterior pra comparar.'
          : 'Sem versão atual carregada.';
        bodyEl.innerHTML = `<div class="kd-diff-empty">${esc(msg)}</div>`;
        return;
      }
      // OldContent = compare (para "vs anterior") OU a versão selecionada (para "vs atual")
      // vs anterior: comparar `compare` (antigo) → `activeContent` (atual da versão selecionada)
      // vs atual:    comparar `activeContent` (versão selecionada) → `compare` (o "agora")
      let oldContent, newContent;
      if (KDH.compareTo === 'prev') { oldContent = compare;            newContent = KDH.activeContent; }
      else                          { oldContent = KDH.activeContent;  newContent = compare; }
      bodyEl.innerHTML = _renderDiffHTML(oldContent, newContent);
    }
  }

  /* Renderer básico do PM JSON pra HTML (só o essencial pra o preview).
     Não roda o editor Tiptap, não é editável. Suporta parágrafos, headings,
     listas, blockquote, tabelas simples, links, marks básicos e o node
     kastorAttachment (imagem inline + card). */
  function _pmToHtmlBasic(node) {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(_pmToHtmlBasic).join('');
    if (node.type === 'text') {
      let t = esc(node.text || '');
      const marks = node.marks || [];
      for (const m of marks) {
        if (m.type === 'bold' || m.type === 'strong') t = `<strong>${t}</strong>`;
        else if (m.type === 'italic' || m.type === 'em') t = `<em>${t}</em>`;
        else if (m.type === 'underline') t = `<u>${t}</u>`;
        else if (m.type === 'strike') t = `<s>${t}</s>`;
        else if (m.type === 'code') t = `<code>${t}</code>`;
        else if (m.type === 'link') t = `<a href="${esc(m.attrs?.href || '#')}" target="_blank" rel="noopener">${t}</a>`;
        else if (m.type === 'kastorComment') t = `<span class="kastor-comment-mark">${t}</span>`;
      }
      return t;
    }
    const kids = _pmToHtmlBasic(node.content || []);
    const align = node.attrs?.textAlign ? ` style="text-align:${esc(node.attrs.textAlign)}"` : '';
    switch (node.type) {
      case 'doc':          return kids;
      case 'paragraph':    return `<p${align}>${kids}</p>`;
      case 'heading':      { const lvl = Math.min(6, Math.max(1, Number(node.attrs?.level || 1))); return `<h${lvl}${align}>${kids}</h${lvl}>`; }
      case 'bulletList':   return `<ul>${kids}</ul>`;
      case 'orderedList':  return `<ol>${kids}</ol>`;
      case 'listItem':     return `<li>${kids}</li>`;
      case 'blockquote':   return `<blockquote>${kids}</blockquote>`;
      case 'codeBlock':    return `<pre><code>${kids}</code></pre>`;
      case 'horizontalRule': return `<hr>`;
      case 'hardBreak':    return `<br>`;
      case 'table':        return `<table>${kids}</table>`;
      case 'tableRow':     return `<tr>${kids}</tr>`;
      case 'tableHeader':  return `<th>${kids}</th>`;
      case 'tableCell':    return `<td>${kids}</td>`;
      case 'image':        return `<img src="${esc(node.attrs?.src || '')}" alt="${esc(node.attrs?.alt || '')}">`;
      case 'kastorAttachment': {
        const a = node.attrs || {};
        if (a.isImage && a.url) return `<div class="kastor-att-node"><img class="kastor-att-img" src="${esc(a.url)}" alt=""></div>`;
        const ext = (a.name || '').split('.').pop().toUpperCase().slice(0, 5);
        return `<div class="kastor-att-node"><a class="kastor-att-card" href="${esc(a.url || '#')}" target="_blank" rel="noopener"><div class="kastor-att-name">${esc(a.name || 'arquivo')}</div><div class="kastor-att-ext">${esc(ext)}</div></a></div>`;
      }
      default: return kids;
    }
  }

  async function kdHistorySavePrompt() {
    kdPromptModal('Nomear versão', 'Ex.: Antes da revisão do cliente', async (label) => {
      if (label === undefined) return;
      try {
        const s = await api('/writer/' + KD.currentDoc.id + '/versions', 'POST', { label: label || null });
        toast('Versão salva.');
        await kdHistoryLoad();
        kdHistoryShow(s.id);
      } catch (e) { toast(e.message || 'Falha ao salvar versão.', 'error'); }
    });
  }
  window.kdHistorySavePrompt = kdHistorySavePrompt;

  async function kdHistoryRestore(sid) {
    kdConfirmModal('Restaurar essa versão?',
      'O conteúdo atual será substituído. Uma cópia dele será salva automaticamente no histórico pra desfazer.',
      'Restaurar', async (ok) => {
        if (!ok) return;
        try {
          await api('/writer/' + KD.currentDoc.id + '/versions/' + sid + '/restore', 'POST');
          toast('Versão restaurada. Recarregando…');
          // Reload da página garante que o Y.Doc seja reidratado do zero
          // (server.yState foi limpo pra forçar re-sync do content novo)
          setTimeout(() => location.reload(), 400);
        } catch (e) { toast(e.message || 'Falha ao restaurar.', 'error'); }
      });
  }
  window.kdHistoryRestore = kdHistoryRestore;

  async function kdHistoryDelete(sid) {
    kdConfirmModal('Excluir versão?', 'A snapshot será removida definitivamente.', 'Excluir', async (ok) => {
      if (!ok) return;
      try {
        await api('/writer/' + KD.currentDoc.id + '/versions/' + sid, 'DELETE');
        toast('Versão excluída.');
        await kdHistoryLoad();
        _kdHistoryRenderPreview(null);
      } catch (e) { toast(e.message || 'Falha ao excluir.', 'error'); }
    });
  }
  window.kdHistoryDelete = kdHistoryDelete;

  /* Auto-snapshot: dispara a cada 20 saves do doc OU a cada 5min de atividade,
     enviando ?auto=1 (o server aplica dedupe se a última já foi <60s). */
  function _kdScheduleAutoSnapshot() {
    if (KDH.autoTimer) return;
    KDH.autoTimer = setTimeout(() => {
      KDH.autoTimer = null;
      if (!KD.currentDoc || !KD.editor) return;
      api('/writer/' + KD.currentDoc.id + '/versions?auto=1', 'POST').catch(()=>{});
    }, 5 * 60 * 1000);
  }
  // Chamado do flushSave depois de N saves
  KDH.tickOnSave = () => {
    KDH.autoSaveCount++;
    if (KDH.autoSaveCount % 20 === 0 && KD.currentDoc) {
      api('/writer/' + KD.currentDoc.id + '/versions?auto=1', 'POST').catch(()=>{});
    } else {
      _kdScheduleAutoSnapshot();
    }
  };

  // ── Atalhos globais de teclado ───────────────────────────────────────
  /* Ctrl/Cmd+S = "Salvar versão" (nomeada)
     Ctrl/Cmd+K = link (só se editor)
     Ctrl/Cmd+Alt+M = comentar seleção (se pode comentar)
     Ctrl+/ = idem (fallback)
     Esc = fecha modais/painéis */
  document.addEventListener('keydown', (ev) => {
    const meta = ev.ctrlKey || ev.metaKey;
    const inInput = ev.target && ['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName);
    // Esc: fecha em cascata
    if (ev.key === 'Escape') {
      // Prioridade: prompt/confirm modais > share > gallery > history > comments panel
      const cascade = ['.kd-prompt-backdrop', '#kd-share-modal:not([hidden])', '#kd-gallery-modal:not([hidden])', '#kd-history-modal:not([hidden])', '.kd-export-menu'];
      for (const sel of cascade) {
        const el = document.querySelector(sel);
        if (el) {
          if (sel === '.kd-prompt-backdrop') el.remove();
          else if (sel === '.kd-export-menu') el.remove();
          else el.hidden = true;
          ev.preventDefault();
          return;
        }
      }
      if (KDC.pending) { kdCommentsCancelPending(); return; }
      if (KDC.panelOpen && !inInput) { kdCommentsPanelClose(); return; }
      return;
    }
    if (!KD.editor) return;
    if (!meta) return;
    const k = ev.key.toLowerCase();
    // Ctrl+S — salvar versão
    if (k === 's' && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      if (KD.myRole === 'owner' || KD.myRole === 'editor') kdHistorySavePrompt();
      return;
    }
    // Ctrl+Alt+M ou Ctrl+/ — comentário na seleção
    if ((k === 'm' && ev.altKey) || k === '/') {
      const canComment = ['owner','editor','commenter'].includes(KD.myRole);
      if (!canComment) return;
      if (KD.editor.state.selection.empty) return;
      ev.preventDefault();
      kdCommentSelectionStart();
      return;
    }
  });

  // ── document.title sync ──────────────────────────────────────────────
  function _kdSyncTitle() {
    let t = KD.currentDoc?.title || '';
    // Trunca pra tab do browser não virar barra horizontal quilométrica
    if (t.length > 60) t = t.slice(0, 58).trim() + '…';
    document.title = t ? t + ' — reWork Docs' : 'reWork Docs';
  }

  // ── Word count + reading time (throttled) ────────────────────────────
  let _wordCountTimer = null;
  function _kdUpdateWordCount() {
    if (_wordCountTimer) return; // throttle 300ms
    _wordCountTimer = setTimeout(() => {
      _wordCountTimer = null;
      const wc = $('kd-word-count'); const rt = $('kd-read-time');
      if (!wc || !rt || !KD.editor) return;
      const text = KD.editor.getText().trim();
      const words = text ? text.split(/\s+/).length : 0;
      const chars = text.length;
      const minutes = Math.max(1, Math.round(words / 220)); // ~220 wpm leitura casual
      wc.textContent = words === 0 ? 'Vazio' :
        (words === 1 ? '1 palavra · 1 caractere' : `${words} palavras · ${chars} caracteres`);
      rt.textContent = words === 0 ? 'sem tempo estimado' :
        (minutes === 1 ? '~1 min de leitura' : `~${minutes} min de leitura`);
    }, 300);
  }

  // ── Menubar (Arquivo / Editar / Ver / Inserir / Formatar) ─────────────
  // Ações do menu Arquivo delegam pras funções já existentes. Menus não
  // populados por enquanto mostram toast "Em breve".
  const MENUBAR_ACTIONS = {
    novo:         () => _kdOpenTemplatesModal(KD.currentDoc ? { clientId: KD.currentDoc.clientId, projectId: KD.currentDoc.projectId } : null),
    duplicar:     () => _kdDuplicateDoc(),
    aprovacao:    () => _kdApprovalRequest(),
    vincular:     () => _kdLinkPick(document.getElementById('kd-doc-link')),
    'criar-demanda': () => _kdDemandFromSelection(),
    'salvar-versao': () => window.kdHistorySavePrompt && kdHistorySavePrompt(),
    compartilhar: () => window.kdShareOpen && kdShareOpen(),
    'baixar-pdf':  () => _kdDirectExport('pdf'),
    'baixar-docx': () => _kdDirectExport('docx'),
    'baixar-html': () => _kdDirectExport('html'),
    'baixar-txt':  () => _kdDirectExport('txt'),
    renomear:     () => { const t = $('writer-title-input'); if (t) { t.focus(); t.select(); } },
    lixeira:      () => window.kdConfirmDelete && kdConfirmDelete(),
    historico:    () => window.kdHistoryOpen && kdHistoryOpen(),
    imprimir:     () => window.print(),
    // ── Editar ────────────────────────────────────────────────────
    undo:         () => { KD.editor && KD.editor.chain().focus().undo().run(); },
    redo:         () => { KD.editor && KD.editor.chain().focus().redo().run(); },
    cut:          () => _kdEditClipboard('cut'),
    copy:         () => _kdEditClipboard('copy'),
    paste:        () => _kdEditPaste(false),
    'paste-plain':() => _kdEditPaste(true),
    'select-all': () => { KD.editor && KD.editor.chain().focus().selectAll().run(); },
    'delete-selection': () => { KD.editor && KD.editor.chain().focus().deleteSelection().run(); }
  };
  /* Arquivo > Fazer uma cópia: cria outro documento com o conteúdo atual
     e abre numa aba nova (o original continua aberto). */
  async function _kdDuplicateDoc() {
    const doc = KD.currentDoc;
    if (!doc || !KD.editor) return;
    try {
      const copy = await api('/writer', 'POST', {
        workspaceId: doc.workspaceId,
        title: 'Cópia de ' + (doc.title || 'Sem título'),
        content: KD.editor.getJSON()
      });
      KD.docsList.unshift(copy);
      window.open('/hub/docs/' + docSlug(copy), '_blank', 'noopener');
      toast('Cópia criada');
    } catch (e) { toast(e.message || 'Não foi possível copiar.', 'error'); }
  }
  /* Cut/copy via document.execCommand — funciona em qualquer contentEditable
     e é o jeito mais compatível pra levar seleção do editor pra clipboard. */
  function _kdEditClipboard(op) {
    if (!KD.editor) return;
    KD.editor.commands.focus();
    try {
      const ok = document.execCommand(op);
      if (!ok) throw new Error();
    } catch {
      toast('Não foi possível ' + (op === 'cut' ? 'recortar' : 'copiar') + '. Use o atalho de teclado.', 'error');
    }
  }
  /* Colar (formatado ou puro) via Clipboard API. A API exige `document.hasFocus()`
     e o menu que disparou a ação pode ter deslocado o foco pro item clicado —
     por isso reforçamos o foco no editor + esperamos alguns frames antes de ler.
     Se ainda falhar (permissão negada / doc sem foco), damos fallback com toast. */
  async function _kdEditPaste(plainOnly) {
    if (!KD.editor) return;
    // Passo 1: joga o foco pro editor várias vezes ao longo de alguns frames.
    // Ao longo do menu.remove() → item.click() → nova macrotask, o foco pode
    // ficar "no ar" por 1-2 rAFs; melhor esperar antes de ler o clipboard.
    KD.editor.commands.focus();
    try { window.focus(); } catch {}
    await new Promise(r => setTimeout(r, 30));
    KD.editor.commands.focus();
    await new Promise(r => setTimeout(r, 20));
    // Passo 2: se ainda não tem foco no documento, avisa.
    if (!document.hasFocus()) {
      toast('Clique no documento antes de colar (necessário pra permissão do sistema).', 'error');
      return;
    }
    try {
      if (plainOnly || !navigator.clipboard.read) {
        const t = await navigator.clipboard.readText();
        if (t) KD.editor.chain().focus().insertContent(t).run();
        return;
      }
      const items = await navigator.clipboard.read();
      for (const it of items) {
        if (it.types.includes('text/html')) {
          const blob = await it.getType('text/html');
          const html = await blob.text();
          KD.editor.chain().focus().insertContent(html).run();
          return;
        }
      }
      const t = await navigator.clipboard.readText();
      if (t) KD.editor.chain().focus().insertContent(t).run();
    } catch (e) {
      console.warn('[paste]', e);
      toast('Não foi possível colar. Use ' + (plainOnly ? 'Ctrl+Shift+V' : 'Ctrl+V') + '.', 'error');
    }
  }
  /* Dispara export direto sem abrir o popover — usado pelas entradas do
     submenu Arquivo > Baixar. Reusa toda a lógica de flush + fetch + blob
     download que já existe em `exportMenu`; só troca a UX (sem popover). */
  async function _kdDirectExport(fmt) {
    const doc = KD.currentDoc;
    if (!KD.editor || !doc) return;
    if (KD.dirty) { toast('Salvando antes de exportar…'); try { await flushSave(); } catch {} }
    toast('Exportando ' + fmt.toUpperCase() + '…');
    try {
      const resp = await fetch('/api/writer/' + doc.id + '/export?format=' + encodeURIComponent(fmt),
        { credentials: 'same-origin' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Falha no export (' + resp.status + ')');
      }
      const blob = await resp.blob();
      const base = _kdSafeFilename(doc.title || 'documento');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = base + '.' + fmt;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
    } catch (e) { toast(e.message || 'Falha ao exportar.', 'error'); }
  }
  /* Sanitiza título do doc pra nome de arquivo — MANTÉM espaços e acentos.
     Só remove caracteres proibidos por Windows/Mac/Linux (<>:"/\|?* e ctrls),
     colapsa espaços múltiplos e apara pontas. Se ficar vazio, cai pro fallback. */
  function _kdSafeFilename(t) {
    // Remove chars proibidos e chars de controle
    let s = String(t || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '');
    // Colapsa múltiplos espaços e apara pontas
    s = s.replace(/\s+/g, ' ').trim();
    // Windows não gosta de nome terminando em ponto ou espaço
    s = s.replace(/[. ]+$/, '');
    return s || 'documento';
  }
  let _kdMenubarOpenId = null;
  window.kdMenubarOpen = function (which, ev) {
    ev && ev.stopPropagation();
    const item = ev?.currentTarget;
    const dd = document.getElementById('kd-menubar-dd-' + which);
    // Menus ainda vazios — feedback rápido, não abre um dropdown vazio
    if (!dd) {
      toast('Menu "' + which.charAt(0).toUpperCase() + which.slice(1) + '" em desenvolvimento.');
      return;
    }
    // Se o mesmo já está aberto, fecha
    if (_kdMenubarOpenId === which) { _kdCloseMenubar(); return; }
    _kdCloseMenubar();
    _kdMenubarOpenId = which;
    // Atualiza estados condicionais antes de mostrar (ex: recortar/copiar/excluir
    // dependem de haver seleção)
    _kdMenubarSyncStates(which);
    // Posiciona o dropdown embaixo do item clicado
    const r = item.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.top  = (r.bottom + 4) + 'px';
    dd.hidden = false;
    item.classList.add('is-open');
  };
  /* Habilita/desabilita itens do menu conforme contexto do editor no momento
     de abrir. Itens marcados com data-needs-selection ficam disabled quando
     não há trecho selecionado. */
  function _kdMenubarSyncStates(which) {
    if (which !== 'editar') return;
    const dd = document.getElementById('kd-menubar-dd-editar');
    if (!dd) return;
    let hasSelection = false;
    try {
      const sel = KD.editor?.state.selection;
      hasSelection = sel && !sel.empty;
    } catch {}
    dd.querySelectorAll('[data-needs-selection]').forEach(b => {
      b.disabled = !hasSelection;
    });
  }
  function _kdCloseMenubar() {
    // Fecha qualquer submenu aberto junto
    document.querySelectorAll('.kd-menubar-dd-sub.is-open').forEach(s => s.classList.remove('is-open'));
    if (!_kdMenubarOpenId) return;
    const dd = document.getElementById('kd-menubar-dd-' + _kdMenubarOpenId);
    if (dd) dd.hidden = true;
    document.querySelectorAll('.kd-menubar-item.is-open').forEach(b => b.classList.remove('is-open'));
    _kdMenubarOpenId = null;
  }
  window.kdMenubarAction = function (action, ev) {
    const fn = MENUBAR_ACTIONS[action];
    _kdCloseMenubar();
    if (fn) { try { fn(ev); } catch (e) { console.error('menubar action', action, e); } }
  };
  /* Toggle click-based nos submenus (ex: Arquivo > Baixar). Não abre com hover:
     precisa clicar no item pra expandir, clicar de novo pra fechar. */
  window.kdMenubarToggleSub = function (which, ev) {
    ev && ev.stopPropagation();
    const sub = document.querySelector('.kd-menubar-dd-sub[data-sub="' + which + '"]');
    if (!sub) return;
    const wasOpen = sub.classList.contains('is-open');
    // Fecha outros subs abertos antes
    document.querySelectorAll('.kd-menubar-dd-sub.is-open').forEach(s => s.classList.remove('is-open'));
    if (!wasOpen) sub.classList.add('is-open');
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('.kd-menubar-item, .kd-menubar-dropdown')) return;
    _kdCloseMenubar();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _kdCloseMenubar(); });

  // ── Formato: "Sem páginas" (padrão) ou "Páginas (A4)" ─────────────────
  /* A paginação mora no bundle (extensão KdPages). Aqui: liga/desliga conforme
     o formato do documento e desenha as folhas quando o motor avisa quantas
     são. O formato é do documento (todo mundo vê igual). */
  function _kdLayoutOf(doc) { return doc && doc.layout === 'pages' ? 'pages' : 'pageless'; }
  function _kdApplyLayout() {
    const mode = _kdLayoutOf(KD.currentDoc);
    document.querySelector('.writer-editor-view')?.classList.toggle('is-pageless', mode !== 'pages');
    const ed = KD.editor;
    if (!ed || !ed.storage || !ed.storage.kdPages) return;
    ed.storage.kdPages.onLayout = _kdDrawSheets;
    ed.commands.setPagesEnabled(mode === 'pages');
  }
  function _kdDrawSheets({ pages, enabled, pageHeight, pageGap }) {
    const paper = document.querySelector('.writer-editor-paper');
    if (!paper) return;
    if (!enabled) {
      paper.style.minHeight = '';
      paper.querySelectorAll('.kd-page-label, .kd-page-sheet').forEach(n => n.remove());
      paper.classList.remove('has-sheets');
      return;
    }
    const H = pageHeight, G = pageGap;
    paper.style.minHeight = (pages * H + (pages - 1) * G) + 'px';
    const sheets = paper.querySelectorAll('.kd-page-sheet');
    for (let i = sheets.length; i < pages; i++) {
      const sh = document.createElement('div');
      sh.className = 'kd-page-sheet';
      sh.setAttribute('aria-hidden', 'true');
      paper.insertBefore(sh, paper.firstChild);
    }
    [...paper.querySelectorAll('.kd-page-sheet')].forEach((sh, i) => {
      if (i >= pages) { sh.remove(); return; }
      sh.style.top = (i * (H + G)) + 'px';
      sh.style.height = H + 'px';
    });
    const labels = [...paper.querySelectorAll('.kd-page-label')];
    for (let i = labels.length; i < pages - 1; i++) {
      const l = document.createElement('div');
      l.className = 'kd-page-label';
      paper.appendChild(l);
      labels.push(l);
    }
    labels.forEach((l, k) => {
      if (k >= pages - 1) { l.remove(); return; }
      l.textContent = 'Página ' + (k + 2);
      l.style.top = ((k + 1) * H + k * G + G / 2) + 'px';
    });
    paper.classList.add('has-sheets');
  }
  async function _kdSetLayout(mode) {
    const doc = KD.currentDoc;
    if (!doc || (mode !== 'pages' && mode !== 'pageless') || _kdLayoutOf(doc) === mode) return;
    doc.layout = mode;
    _kdApplyLayout();
    _kdRulerRefresh();
    if (['owner', 'editor'].includes(KD.myRole)) {
      try { await api('/writer/' + doc.id, 'PATCH', { layout: mode }); }
      catch (e) { toast(e.message || 'Não foi possível salvar o formato.', 'error'); }
    }
  }
  // Compat: o motor acompanha as mudanças sozinho (antes era por timer)
  function _kdRefreshPaging() {}
  // Impressão: o navegador pagina sozinho; a paginação da tela sai e volta depois
  window.addEventListener('beforeprint', () => { KD.editor?.commands.setPagesEnabled(false); });
  window.addEventListener('afterprint', () => _kdApplyLayout());
  window.__kdRepaginate = () => KD.editor?.commands.repaginate();

  // ── Índice (outline) — H1/H2/H3 do doc ────────────────────────────────
  // Painel lateral direito. Refresh throttled em cada onUpdate do editor,
  // e chamado uma vez na abertura do doc. Estado colapsado persiste em
  // localStorage por usuário.
  let _outlineTimer = null;
  function _kdOutlineRefresh() {
    if (_outlineTimer) return;
    _outlineTimer = setTimeout(() => {
      _outlineTimer = null;
      const list = $('kd-outline-list');
      if (!list || !KD.editor) return;
      const items = [];
      KD.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          items.push({
            level: Math.min(3, Math.max(1, node.attrs?.level || 1)),
            text: (node.textContent || '').trim(),
            pos: pos + 1  // dentro do heading, não antes dele
          });
        }
      });
      if (!items.length) {
        list.innerHTML = '<div class="kd-outline-empty">Adicione títulos (H1/H2/H3) pra ver o índice.</div>';
        return;
      }
      list.innerHTML = items.map((h, i) => {
        const label = h.text || '(sem título)';
        return `<button type="button" class="kd-outline-item kd-outline-l${h.level}" data-pos="${h.pos}" data-i="${i}" title="${esc(label)}">${esc(label)}</button>`;
      }).join('');
      list.querySelectorAll('.kd-outline-item').forEach(b => {
        b.addEventListener('click', () => {
          const pos = Number(b.dataset.pos);
          KD.editor.chain().focus().setTextSelection(pos).run();
          const dom = KD.editor.view.domAtPos(pos);
          const el = dom && (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement);
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }, 300);
  }
  window.kdOutlineToggle = function () {
    const panel = document.getElementById('kd-outline-panel');
    if (!panel) return;
    panel.classList.toggle('is-collapsed');
    try { localStorage.setItem('kastor-doc-outline-collapsed', panel.classList.contains('is-collapsed') ? '1' : '0'); } catch {}
  };
  // Aplica preferência salva quando o app arranca
  (function _kdOutlineInit() {
    try {
      if (localStorage.getItem('kastor-doc-outline-collapsed') === '1') {
        document.addEventListener('DOMContentLoaded', () => {
          const p = document.getElementById('kd-outline-panel');
          if (p) p.classList.add('is-collapsed');
        }, { once: true });
      }
    } catch {}
  })();

  // ── Vínculo com cliente/projeto + aprovação (cabeçalho do editor) ─────
  const KD_APPROVAL = {
    pending:  { label: 'Aguardando aprovação', cls: 'is-pending' },
    approved: { label: 'Aprovado', cls: 'is-approved' },
    changes:  { label: 'Ajustes pedidos', cls: 'is-changes' }
  };
  function _kdRenderDocMeta() {
    const doc = KD.currentDoc;
    const linkBtn = $('kd-doc-link'), apBtn = $('kd-approval-badge');
    if (!doc || !linkBtn || !apBtn) return;
    const canEditDoc = ['owner', 'editor'].includes(KD.myRole);
    const R = KD.refData || {};
    const cl = doc.clientId && (R.clients || []).find(x => x.id === doc.clientId);
    const pr = doc.projectId && (R.projects || []).find(x => x.id === doc.projectId);
    if (cl || pr) {
      linkBtn.hidden = false;
      linkBtn.classList.remove('is-empty');
      linkBtn.innerHTML = `<span class="kd-suggest-dot" style="background:${esc((pr || cl).color || '#7A00FF')}"></span>${esc(cl ? cl.name : '')}${pr ? `<span class="kd-tpl-for-sep">›</span>${esc(pr.name)}` : ''}`;
      linkBtn.title = canEditDoc ? 'Trocar cliente ou projeto' : 'Vinculado a este cliente/projeto';
    } else {
      linkBtn.hidden = !canEditDoc;
      linkBtn.classList.add('is-empty');
      linkBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Cliente ou projeto';
      linkBtn.title = 'Vincular este documento a um cliente ou projeto';
    }
    linkBtn.disabled = !canEditDoc;
    const ap = doc.approval && KD_APPROVAL[doc.approval.status];
    apBtn.hidden = !ap;
    if (ap) {
      apBtn.className = 'kd-approval-badge ' + ap.cls;
      apBtn.textContent = ap.label;
      apBtn.title = doc.approval.decidedBy ? ap.label + ' por ' + doc.approval.decidedBy : ap.label;
    }
  }
  async function _kdPatchDoc(body) {
    const doc = KD.currentDoc; if (!doc) return;
    const r = await api('/writer/' + doc.id, 'PATCH', body);
    doc.clientId = r.clientId; doc.projectId = r.projectId;
    const li = KD.docsList.find(d => d.id === doc.id); if (li) { li.clientId = r.clientId; li.projectId = r.projectId; }
    _kdRenderDocMeta();
  }
  function _kdLinkPick(anchor) {
    const doc = KD.currentDoc;
    if (!doc || !anchor || !window.KDUI) return;
    window.KDUI.pickEntity(anchor, {
      title: 'Vincular a…', allowClear: !!(doc.clientId || doc.projectId),
      current: doc.projectId ? { kind: 'project', id: doc.projectId } : doc.clientId ? { kind: 'client', id: doc.clientId } : null,
      onPick: async (it) => {
        try {
          if (!it) await _kdPatchDoc({ clientId: null, projectId: null });
          else if (it.kind === 'project') await _kdPatchDoc({ projectId: it.id });
          else await _kdPatchDoc({ clientId: it.id, projectId: null });
          toast(it ? 'Documento vinculado a ' + it.label : 'Vínculo removido');
        } catch (e) { toast(e.message || 'Não foi possível vincular.', 'error'); }
      }
    });
  }
  function _kdPublicUrlOf(doc) {
    return doc && doc._publicUrl ? location.origin + doc._publicUrl : null;
  }
  async function _kdApprovalRequest() {
    const doc = KD.currentDoc; if (!doc) return;
    try {
      const r = await api('/writer/' + doc.id + '/approval', 'POST', { action: 'request' });
      doc.approval = r.approval; doc.publicShareEnabled = r.publicShareEnabled; doc._publicUrl = r.url;
      _kdRenderDocMeta();
      const url = _kdPublicUrlOf(doc);
      try { await navigator.clipboard.writeText(url); toast('Link de aprovação copiado. Envie pro cliente.'); }
      catch { toast('Pedido de aprovação criado. Copie o link em Compartilhar.'); }
      if (!$('kd-share-modal').hidden) kdShareLoad();
    } catch (e) { toast(e.message || 'Não foi possível pedir aprovação.', 'error'); }
  }
  async function _kdApprovalCancel() {
    const doc = KD.currentDoc; if (!doc) return;
    try {
      const r = await api('/writer/' + doc.id + '/approval', 'POST', { action: 'cancel' });
      doc.approval = r.approval;
      _kdRenderDocMeta();
      toast('Pedido de aprovação cancelado');
      if (!$('kd-share-modal').hidden) kdShareLoad();
    } catch (e) { toast(e.message || 'Falha ao cancelar.', 'error'); }
  }
  function _kdApprovalMenu(anchor) {
    const doc = KD.currentDoc; if (!doc || !doc.approval || !window.KDUI) return;
    const a = doc.approval, ap = KD_APPROVAL[a.status] || {};
    const I = window.KDUI.icons;
    const canEditDoc = ['owner', 'editor'].includes(KD.myRole);
    const when = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    window.KDUI.openMenu(anchor, [
      { render: () => {
        const d = document.createElement('div');
        d.className = 'kd-approval-card';
        d.innerHTML = `<div class="kd-approval-card-status ${ap.cls || ''}">${esc(ap.label || '')}</div>
          <div class="kd-approval-card-sub">${a.status === 'pending'
            ? 'Pedido em ' + esc(when(a.requestedAt)) + '. O cliente responde pelo link público.'
            : esc((a.decidedBy || 'Cliente') + ' · ' + when(a.decidedAt))}</div>
          ${a.comment ? `<div class="kd-approval-card-comment">${esc(a.comment)}</div>` : ''}`;
        return d;
      } },
      { divider: true },
      { label: 'Copiar link do cliente', icon: I.link, run: async () => {
        let url = _kdPublicUrlOf(doc);
        if (!url) { try { const p = await api('/writer/' + doc.id + '/permissions'); url = p.publicShareUrl ? location.origin + p.publicShareUrl : null; } catch {} }
        if (url) navigator.clipboard?.writeText(url).then(() => toast('Link copiado'));
        else toast('Ative o link público em Compartilhar.', 'error');
      } },
      canEditDoc && a.status !== 'pending' && { label: 'Pedir aprovação de novo', icon: I.history, run: _kdApprovalRequest },
      canEditDoc && { label: a.status === 'pending' ? 'Cancelar pedido' : 'Tirar o selo', icon: I.close, danger: a.status === 'pending', run: _kdApprovalCancel }
    ], { align: 'left', className: 'kd-pop--approval' });
  }
  window.kdLinkPick = (el) => _kdLinkPick(el);
  window.kdApprovalMenu = (el) => _kdApprovalMenu(el);

  // ── Criar demanda a partir do texto ────────────────────────────────
  /* Seleção (ou o bloco do cursor) vira demanda: nome = primeira linha,
     descrição = o trecho com formatação, itens de lista → checklist.
     Depois insere a #referência da demanda logo após o trecho. */
  function _kdDemandFromSelection() {
    const ed = KD.editor, KW = window.KastorWriter;
    if (!ed || !window.KDUI) return;
    if (!['owner', 'editor'].includes(KD.myRole)) return;
    let { from, to, empty } = ed.state.selection;
    if (empty) {
      const $f = ed.state.selection.$from;
      const d = Math.max(1, $f.depth);
      from = $f.before(d); to = $f.after(d);
      ed.commands.setTextSelection({ from: from + 1, to: to - 1 });
    }
    const text = ed.state.doc.textBetween(from, to, '\n', ' ').trim();
    if (!text) { toast('Selecione o texto que vai virar demanda.', 'error'); return; }
    const firstLine = text.split('\n').map(t => t.trim()).find(Boolean) || '';
    const items = [];
    ed.state.doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'listItem' || node.type.name === 'taskItem') {
        const t = (node.firstChild ? node.firstChild.textContent : node.textContent).trim();
        if (t) items.push(t.slice(0, 500));
        return false;
      }
    });
    let html = '';
    try { html = KW.selectionHTML(ed); } catch {}
    const R = KD.refData || {};
    const doc = KD.currentDoc || {};
    let projectId = doc.projectId || ((R.projects || []).find(p => p.clientId && p.clientId === doc.clientId && p.active !== false) || {}).id || null;
    const useItems = items.length >= 2;
    // Trecho que é só uma lista: o nome vem do título do documento
    const nameGuess = (useItems && firstLine === items[0] ? (doc.title || firstLine) : firstLine).replace(/:\s*$/, '').slice(0, 140);
    const bd = window.KDUI.dialog('Criar demanda', `
      <form class="kd-dform" autocomplete="off">
        <label class="kd-dform-field"><span>Nome</span><input name="name" maxlength="200" required value="${esc(nameGuess)}"></label>
        <div class="kd-dform-row">
          <div class="kd-dform-field"><span>Projeto</span><button type="button" class="kd-dform-pick" data-pick></button></div>
          <label class="kd-dform-field kd-dform-field--sm"><span>Prazo</span><input type="date" name="deadline"></label>
        </div>
        ${useItems ? `<label class="kd-dform-check"><input type="checkbox" name="checklist" checked> Usar os ${items.length} itens da lista como checklist</label>` : ''}
        <div class="kd-dform-preview"><span>Descrição</span><div class="kd-dform-preview-body">${html || esc(text)}</div></div>
        <div class="kd-dform-actions">
          <button type="button" class="btn btn-ghost" data-close>Cancelar</button>
          <button type="submit" class="btn btn-primary">Criar demanda</button>
        </div>
      </form>`);
    const form = bd.querySelector('form');
    const pickBtn = form.querySelector('[data-pick]');
    const paint = () => {
      const pr = projectId && (R.projects || []).find(x => x.id === projectId);
      const cl = pr && (R.clients || []).find(x => x.id === pr.clientId);
      pickBtn.innerHTML = pr
        ? `<span class="kd-suggest-dot" style="background:${esc(pr.color || '#7A00FF')}"></span>${cl ? esc(cl.name) + '<span class="kd-tpl-for-sep">›</span>' : ''}${esc(pr.name)}`
        : '<span class="kd-tpl-for-empty">Escolha o projeto</span>';
    };
    paint();
    pickBtn.addEventListener('click', () => window.KDUI.pickEntity(pickBtn, {
      kinds: ['project'], title: 'Projeto da demanda', current: projectId ? { kind: 'project', id: projectId } : null,
      onPick: (it) => { if (it) { projectId = it.id; paint(); } }
    }));
    setTimeout(() => form.querySelector('[name="name"]').select(), 30);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = form.name.value.trim();
      if (!name) return;
      if (!projectId) { toast('Escolha o projeto da demanda.', 'error'); pickBtn.click(); return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true; btn.textContent = 'Criando…';
      try {
        const body = { name, projectId, description: html || esc(text) };
        if (form.deadline.value) body.deadline = form.deadline.value;
        if (useItems && form.checklist?.checked) body.checklist = items.map(t => ({ text: t }));
        const d = await api('/demands', 'POST', body);
        (KD.refData ||= { demands: [], clients: [], projects: [], flows: [] }).demands.unshift(d);
        bd.querySelector('[data-close]').click();
        // Referência logo depois do trecho
        const end = Math.min(to, ed.state.doc.content.size);
        const $e = ed.state.doc.resolve(end);
        const at = $e.parent.inlineContent ? end : Math.max(1, end - 1);
        ed.chain().focus().insertContentAt(at, [{ type: 'text', text: ' ' }, { type: 'kdRef', attrs: { kind: 'demand', refId: d.id, label: d.name } }]).run();
        toast('Demanda criada e ligada ao texto');
      } catch (e) {
        toast(e.message || 'Não foi possível criar a demanda.', 'error');
        btn.disabled = false; btn.textContent = 'Criar demanda';
      }
    });
  }

  // ── Ponte pro editor-ui.js ────────────────────────────────────────────
  KD.ui = {
    toast,
    prompt: (title, def, cb) => kdPromptModal(title, def, cb),
    comment: () => kdCommentSelectionStart(),
    gallery: (kind) => {
      kdGalleryOpen();
      if (kind) setTimeout(() => { const sel = $('kd-gal-f-kind'); if (sel) { sel.value = kind; kdGalleryRender(); } }, 50);
    },
    pickFile: (accept) => {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.style.display = 'none';
      if (accept) input.accept = accept;
      document.body.appendChild(input);
      input.addEventListener('change', () => { [...(input.files || [])].forEach(_kdUploadAndInsert); input.remove(); });
      input.click();
    },
    uploadFile: (f) => _kdUploadAndInsert(f),
    colorPicker: (ev, kind) => _kdColorPickerOpen(ev, kind),
    fontSizeStep: (d) => _kdFontSizeStep(d),
    fontSizeApply: (v) => _kdFontSizeApplyRaw(v),
    fontSizeMenuOpen: (inp) => _kdFontSizeMenuOpenForInput(inp),
    fontSizeMenuClose: () => _kdFontSizeMenuClose(),
    fmtFontSize: (v) => _kdFmtFontSize(v),
    action: (name) => window.kdMenubarAction(name),
    createDemand: () => _kdDemandFromSelection(),
    linkPick: (el) => _kdLinkPick(el),
    requestApproval: () => _kdApprovalRequest(),
    repaginate: () => { KD.editor?.commands.repaginate(); _kdRulerRefresh(); },
    layout: () => _kdLayoutOf(KD.currentDoc),
    setLayout: (m) => _kdSetLayout(m)
  };
  // Atalhos dos comandos "/" que precisam de coisas daqui
  window.kdEditorHooks = {
    uploadImage: () => KD.ui.pickFile('image/*'),
    gallery: () => KD.ui.gallery()
  };

  /* ── Referências da plataforma (#) ──────────────────────────────────
     Busca em demandas, clientes e projetos que vieram no bootstrap. O chip
     no texto pergunta o estado atual (etapa, cor) via kdRefResolve. */
  const _refNorm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const _refSlug = (name, id) => { const sl = slugify(name, 60); return sl ? sl + '-' + id : id; };
  function _refStage(d) {
    const flows = KD.refData?.flows || [];
    const f = flows.find(x => x.id === d.flowId) || flows.find(x => (x.stages || []).some(st => st.id === d.status));
    return f ? (f.stages || []).find(st => st.id === d.status) : null;
  }
  function _refInfo(kind, item) {
    const R = KD.refData || {};
    if (kind === 'demand') {
      const st = _refStage(item);
      const proj = (R.projects || []).find(p => p.id === item.projectId);
      return {
        kind, id: item.id, label: item.name || 'Demanda', kindLabel: 'Demanda',
        sub: proj ? proj.name : '', status: st ? st.label : '', color: st?.color || '#7A00FF',
        done: !!(st && st.done) || !!item.completedAt,
        href: '/demands/' + _refSlug(item.name, item.id), group: 'Demandas'
      };
    }
    if (kind === 'client') {
      return { kind, id: item.id, label: item.name || 'Cliente', kindLabel: 'Cliente', sub: item.segment || '', color: item.color || '#0ea5e9', href: '/clients/' + _refSlug(item.name, item.id), group: 'Clientes' };
    }
    const cl = (R.clients || []).find(c => c.id === item.clientId);
    return { kind, id: item.id, label: item.name || 'Projeto', kindLabel: 'Projeto', sub: cl ? cl.name : '', color: item.color || '#22c55e', href: '/projects/' + _refSlug(item.name, item.id), group: 'Projetos' };
  }
  window.kdRefResolve = (kind, id) => {
    const R = KD.refData; if (!R || !id) return null;
    const list = kind === 'demand' ? R.demands : kind === 'client' ? R.clients : R.projects;
    const it = (list || []).find(x => x.id === id);
    return it ? _refInfo(kind, it) : null;
  };
  window.kdRefItems = (query) => {
    const R = KD.refData; if (!R) return [];
    const q = _refNorm(query).trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    // 0 = nome igual, 1 = começa com, 2 = alguma palavra começa com, 3 = contém
    const score = (name) => {
      const n = _refNorm(name);
      if (!tokens.every(t => n.includes(t))) return -1;
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      if (tokens.every(t => n.split(/[^a-z0-9]+/).some(w => w.startsWith(t)))) return 2;
      return 3;
    };
    const openDemand = (d) => { const st = _refStage(d); return !(st && st.done) && !d.completedAt; };
    const group = (list, kind, n) => {
      let rows = (list || []).map(x => ({ x, sc: q ? score(x.name) : 1 })).filter(r => r.sc >= 0);
      if (kind === 'demand' && !q) rows = rows.filter(r => openDemand(r.x));
      rows.sort((a, b) => a.sc - b.sc
        || (kind === 'demand' ? (openDemand(b.x) - openDemand(a.x)) : 0)
        || (q ? String(a.x.name).localeCompare(String(b.x.name), 'pt-BR') : String(b.x.createdAt || '').localeCompare(String(a.x.createdAt || ''))));
      rows = rows.slice(0, n);
      return { best: rows.length ? rows[0].sc : 9, items: rows.map(r => _refInfo(kind, r.x)) };
    };
    // Grupos na ordem do melhor resultado de cada um (empate: demandas primeiro)
    const gs = [group(R.demands, 'demand', q ? 6 : 5), group(R.clients, 'client', q ? 4 : 3), group(R.projects, 'project', q ? 4 : 3)];
    return gs.map((g, i) => ({ ...g, i })).sort((a, b) => a.best - b.best || a.i - b.i).flatMap(g => g.items);
  };

  // ── Theme toggle ──────────────────────────────────────────────────────
  window.kdToggleTheme = function () {
    let cur = document.documentElement.getAttribute('data-theme');
    if (!cur) cur = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('kastor-theme', next); } catch {}
    syncBrandLogo();
  };

  // ── Flush no unload ───────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    // Rascunho intocado → apaga do server via sendBeacon (DELETE não roda
    // com beacon direto, então mandamos como POST pra endpoint compatível).
    if (_kdCurrentDocIsUntouched()) {
      try {
        // fetch keepalive é a forma correta pra DELETE em beforeunload
        fetch('/api/writer/' + KD.currentDoc.id, {
          method: 'DELETE', credentials: 'same-origin', keepalive: true
        });
      } catch {}
      return;
    }
    if (KD.dirty && KD.currentDoc && KD.editor) {
      try {
        navigator.sendBeacon(
          '/api/writer/' + KD.currentDoc.id + '/content',
          new Blob([JSON.stringify({ content: KD.editor.getJSON() })], { type: 'application/json' })
        );
      } catch {}
    }
  });

  boot();
})();
