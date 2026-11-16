/* Tela inicial do Presentations (/hub/presentations): lista, filtros,
   favoritos, lixeira e criação a partir de modelo. */
import { $, api, esc, toast, fmtDate, fmtFull, openModal, openMenu, confirmModal, readPref, savePref } from './util.js';
import { icon, iconFilled } from './icons.js';
import { mountThumb, registerFonts } from './render.js';
import { openFigmaImport } from './figma-ui.js';
import { S, clientName, projectName, userName } from './store.js';

const H = {
  list: [],
  trash: [],
  trashMode: false,
  q: '',
  client: '',
  project: '',
  sort: readPref('sort', 'updated'),
  loaded: false
};

export async function showHome() {
  const root = $('sl-home');
  if (!root.dataset.ready) { root.dataset.ready = '1'; bindToolbar(); }
  if (!H.loaded) renderSkeleton();
  await load();
  renderFilters();
  render();
  const qs = new URLSearchParams(location.search);
  if (qs.has('novo')) {
    history.replaceState({}, '', '/hub/presentations');
    openNewDeck({ clientId: qs.get('cliente') || '', projectId: qs.get('projeto') || '' });
  }
}

async function load() {
  try {
    const [list, trash] = await Promise.all([api('/decks'), api('/decks?trash=1')]);
    H.list = list; H.trash = trash; H.loaded = true;
  } catch (e) {
    if (e.message === '__unauth__') throw e;
    toast(e.message || 'Falha ao carregar as apresentações.', 'error');
  }
}

function renderSkeleton() {
  $('sl-grid').innerHTML = Array.from({ length: 4 }).map(() => '<div class="sl-card sl-card-skeleton"><div class="sl-card-thumb"></div><div class="sl-card-info"><span></span><span></span></div></div>').join('');
}

function bindToolbar() {
  $('sl-search').addEventListener('input', (e) => { H.q = e.target.value; render(); });
  $('sl-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; H.q = ''; render(); } });
  $('sl-f-client').addEventListener('change', (e) => { H.client = e.target.value; H.project = ''; renderFilters(); render(); });
  $('sl-f-project').addEventListener('change', (e) => { H.project = e.target.value; render(); });
  $('sl-f-sort').value = H.sort;
  $('sl-f-sort').addEventListener('change', (e) => { H.sort = e.target.value; savePref('sort', H.sort); render(); });
  $('sl-trash-btn').addEventListener('click', () => toggleTrash());
  $('sl-new-btn').addEventListener('click', () => openNewDeck());
  $('sl-figma-btn').addEventListener('click', () => openFigmaImport());
  ['sl-grid', 'sl-fav-grid'].forEach(id => $(id).addEventListener('click', onGridClick));
}

function toggleTrash(on) {
  H.trashMode = on === undefined ? !H.trashMode : on;
  const b = $('sl-trash-btn');
  b.classList.toggle('active', H.trashMode);
  b.setAttribute('aria-pressed', H.trashMode ? 'true' : 'false');
  render();
}

function renderFilters() {
  const src = H.list.concat(H.trash);
  const cIds = [...new Set(src.map(d => d.clientId).filter(Boolean))];
  const clients = cIds.map(id => ({ id, name: clientName(id) })).filter(c => c.name).sort((a, b) => a.name.localeCompare(b.name));
  const cs = $('sl-f-client');
  cs.innerHTML = '<option value="">Todos os clientes</option>' + clients.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  cs.value = H.client;
  cs.classList.toggle('filtering', !!H.client);
  const pIds = [...new Set(src.filter(d => !H.client || d.clientId === H.client).map(d => d.projectId).filter(Boolean))];
  const projects = pIds.map(id => ({ id, name: projectName(id) })).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));
  const ps = $('sl-f-project');
  ps.innerHTML = '<option value="">Todos os projetos</option>' + projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  ps.value = H.project;
  ps.classList.toggle('filtering', !!H.project);
  ps.hidden = !projects.length;
  cs.hidden = !clients.length;
}

function filtered(list) {
  const q = H.q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let out = list.filter(d => {
    if (H.client && d.clientId !== H.client) return false;
    if (H.project && d.projectId !== H.project) return false;
    if (q) {
      const hay = (d.title + ' ' + clientName(d.clientId) + ' ' + projectName(d.projectId)).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by = H.sort;
  out = out.slice().sort((a, b) => by === 'title' ? a.title.localeCompare(b.title)
    : by === 'created' ? String(b.createdAt).localeCompare(String(a.createdAt))
    : String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

function render() {
  const trash = H.trashMode;
  $('sl-trash-note').hidden = !trash;
  const tc = $('sl-trash-count');
  tc.hidden = !H.trash.length;
  tc.textContent = H.trash.length;
  const list = filtered(trash ? H.trash : H.list);
  const favs = trash ? [] : list.filter(d => d.favorite);
  $('sl-fav-section').hidden = !favs.length;
  $('sl-main-title').textContent = trash ? 'Lixeira' : (favs.length ? 'Todas as apresentações' : 'Apresentações');
  paintGrid($('sl-fav-grid'), favs, false);
  const grid = $('sl-grid');
  if (!list.length) {
    const filteredOut = (trash ? H.trash : H.list).length > 0;
    grid.innerHTML = `<div class="sl-empty">
      <div class="sl-empty-icon">${icon(trash ? 'trash' : 'presentation', 28)}</div>
      <div class="sl-empty-title">${trash ? 'Lixeira vazia' : filteredOut ? 'Nada encontrado' : 'Nenhuma apresentação ainda'}</div>
      <p>${trash ? 'Apresentações excluídas aparecem aqui e podem ser restauradas.' : filteredOut ? 'Tente outra busca ou limpe os filtros.' : 'Comece de um modelo de campanha, relatório ou em branco. Todo o squad pode editar junto.'}</p>
      ${!trash && !filteredOut ? `<button type="button" class="btn btn-primary" data-new>${icon('plus', 14)}<span>Nova apresentação</span></button>` : ''}
    </div>`;
    const nb = grid.querySelector('[data-new]'); if (nb) nb.onclick = () => openNewDeck();
    return;
  }
  paintGrid(grid, list, trash);
}

function paintGrid(grid, list, trash) {
  grid.innerHTML = list.map(d => {
    const client = clientName(d.clientId);
    const project = projectName(d.projectId);
    const where = [client, project].filter(Boolean).join(' · ');
    const when = trash ? 'excluída ' + fmtDate(d.deletedAt) : 'editada ' + fmtDate(d.updatedAt);
    return `<article class="sl-card" data-id="${esc(d.id)}">
      <button type="button" class="sl-card-thumb" data-open aria-label="Abrir ${esc(d.title)}" ${trash ? 'disabled' : ''}>
        <div class="sl-card-canvas"></div>
        <span class="sl-card-count">${d.slideCount} ${d.slideCount === 1 ? 'slide' : 'slides'}</span>
        ${d.publicShareEnabled ? `<span class="sl-card-public" title="Link público ligado">${icon('link', 12)}</span>` : ''}
      </button>
      <div class="sl-card-info">
        <div class="sl-card-text">
          <div class="sl-card-title" title="${esc(d.title)}">${esc(d.title)}</div>
          <div class="sl-card-meta" title="${esc(fmtFull(trash ? d.deletedAt : d.updatedAt))}">${where ? `<span class="sl-card-where">${esc(where)}</span><span aria-hidden="true">·</span>` : ''}<span>${esc(when)}</span></div>
        </div>
        ${trash
          ? `<button type="button" class="btn btn-ghost btn-sm" data-restore>${icon('restore', 13)}<span>Restaurar</span></button>`
          : `<button type="button" class="sl-icon-btn sl-star${d.favorite ? ' is-on' : ''}" data-star title="${d.favorite ? 'Tirar dos favoritos' : 'Favoritar'}" aria-pressed="${d.favorite}" aria-label="Favorito">${d.favorite ? iconFilled('star', 15) : icon('star', 15)}</button>
             <button type="button" class="sl-icon-btn" data-more title="Mais ações" aria-label="Mais ações">${icon('more', 16)}</button>`}
      </div>
    </article>`;
  }).join('');
  grid.querySelectorAll('.sl-card').forEach(card => {
    const d = list.find(x => x.id === card.dataset.id);
    if (d) registerFonts(d.fonts);
    if (d && d.cover) mountThumb(card.querySelector('.sl-card-canvas'), d.cover, d.theme, d.size);
    else if (d) card.querySelector('.sl-card-canvas').style.background = (d.theme && d.theme.bg) || '#fff';
  });
}

async function onGridClick(e) {
  const card = e.target.closest('.sl-card'); if (!card) return;
  const id = card.dataset.id;
  const d = H.list.find(x => x.id === id) || H.trash.find(x => x.id === id);
  if (!d) return;
  if (e.target.closest('[data-open]')) { S.nav.toDeck(d); return; }
  if (e.target.closest('[data-star]')) {
    const on = !d.favorite;
    d.favorite = on; render();
    try { await api('/decks/' + id + '/favorite', 'POST', { on }); } catch (err) { d.favorite = !on; render(); toast(err.message, 'error'); }
    return;
  }
  if (e.target.closest('[data-restore]')) {
    try {
      const r = await api('/decks/' + id + '/restore', 'POST');
      H.trash = H.trash.filter(x => x.id !== id);
      H.list.unshift({ ...d, ...r, cover: d.cover });
      render(); toast('Apresentação restaurada.');
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    openMenu(more, [
      { label: 'Abrir', icon: icon('open', 15), onClick: () => S.nav.toDeck(d) },
      { label: 'Abrir em nova guia', icon: icon('open', 15), onClick: () => window.open('/hub/presentations/' + d.id, '_blank', 'noopener') },
      { label: 'Duplicar', icon: icon('copy', 15), onClick: () => duplicate(d) },
      '-',
      { label: 'Mover pra lixeira', icon: icon('trash', 15), danger: true, onClick: () => trashDeck(d) }
    ], { align: 'right' });
  }
}

async function duplicate(d) {
  try {
    const r = await api('/decks/' + d.id + '/duplicate', 'POST');
    H.list.unshift({ ...r, cover: d.cover });
    render(); toast('Cópia criada.');
  } catch (e) { toast(e.message, 'error'); }
}

async function trashDeck(d) {
  const ok = await confirmModal({ title: 'Mover pra lixeira?', text: `"${d.title}" sai da lista de todo o squad. Dá pra restaurar pela Lixeira.`, ok: 'Mover pra lixeira', danger: true });
  if (!ok) return;
  try {
    await api('/decks/' + d.id, 'DELETE');
    H.list = H.list.filter(x => x.id !== d.id);
    H.trash.unshift({ ...d, deletedAt: new Date().toISOString() });
    render(); toast('Movida pra lixeira.');
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Nova apresentação ───────────────────────────────────────── */
let _templates = null;
export async function openNewDeck(pre = {}) {
  if (!S.workspaces.length) { toast('Você precisa estar em um squad pra criar apresentações.', 'error'); return; }
  const body = document.createElement('div');
  body.className = 'sl-new';
  body.innerHTML = `
    <div class="sl-new-templates" role="radiogroup" aria-label="Modelo"><div class="sl-new-loading">Carregando modelos…</div></div>
    <div class="form-grid sl-new-fields">
      <div class="form-group full"><label class="form-label" for="sl-new-title">Título</label>
        <input class="form-control" id="sl-new-title" maxlength="200" placeholder="Ex.: Campanha de Black Friday"></div>
      <div class="form-group" ${S.workspaces.length > 1 ? '' : 'hidden'}><label class="form-label" for="sl-new-ws">Squad</label>
        <select class="form-control" id="sl-new-ws">${S.workspaces.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="sl-new-client">Cliente <span class="form-label-hint">opcional</span></label>
        <select class="form-control" id="sl-new-client"></select></div>
      <div class="form-group"><label class="form-label" for="sl-new-project">Projeto <span class="form-label-hint">opcional</span></label>
        <select class="form-control" id="sl-new-project"></select></div>
    </div>`;
  const footer = document.createElement('div');
  footer.className = 'sl-modal-actions';
  footer.innerHTML = `<button type="button" class="btn btn-ghost" data-cancel>Cancelar</button><button type="button" class="btn btn-primary" data-create>Criar apresentação</button>`;
  const m = openModal({ title: 'Nova apresentação', body, footer, size: 'modal-md' });
  footer.querySelector('[data-cancel]').onclick = () => m.close();

  let tpl = 'blank';
  const wsSel = body.querySelector('#sl-new-ws');
  const cSel = body.querySelector('#sl-new-client');
  const pSel = body.querySelector('#sl-new-project');
  const fillLinks = () => {
    const ws = wsSel.value;
    const clients = S.clients.filter(c => c.workspaceId === ws).sort((a, b) => a.name.localeCompare(b.name));
    const cur = cSel.value || pre.clientId || '';
    cSel.innerHTML = '<option value="">Nenhum</option>' + clients.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    cSel.value = clients.some(c => c.id === cur) ? cur : '';
    const projects = S.projects.filter(p => p.workspaceId === ws && (!cSel.value || p.clientId === cSel.value)).sort((a, b) => a.name.localeCompare(b.name));
    const curP = pSel.value || pre.projectId || '';
    pSel.innerHTML = '<option value="">Nenhum</option>' + projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    pSel.value = projects.some(p => p.id === curP) ? curP : '';
  };
  // Squad do cliente/projeto pré-escolhido
  const preWs = (S.projects.find(p => p.id === pre.projectId) || S.clients.find(c => c.id === pre.clientId) || {}).workspaceId;
  if (preWs && S.workspaces.some(w => w.id === preWs)) wsSel.value = preWs;
  fillLinks();
  wsSel.onchange = () => { cSel.value = ''; pSel.value = ''; fillLinks(); };
  cSel.onchange = () => { pSel.value = ''; fillLinks(); };
  pSel.onchange = () => {
    const p = S.projects.find(x => x.id === pSel.value);
    if (p && p.clientId && cSel.value !== p.clientId) { cSel.value = p.clientId; fillLinks(); pSel.value = p.id; }
  };

  const box = body.querySelector('.sl-new-templates');
  try {
    if (!_templates) _templates = await api('/decks/templates');
    box.innerHTML = _templates.map((t, i) => `
      <button type="button" class="sl-tpl${i === 0 ? ' is-active' : ''}" role="radio" aria-checked="${i === 0}" data-tpl="${esc(t.key)}">
        <div class="sl-tpl-thumb"></div>
        <div class="sl-tpl-name">${esc(t.name)}</div>
        <div class="sl-tpl-desc">${esc(t.desc)} <span class="sl-tpl-count">${t.slides.length} ${t.slides.length === 1 ? 'slide' : 'slides'}</span></div>
      </button>`).join('');
    box.querySelectorAll('.sl-tpl').forEach(b => {
      const t = _templates.find(x => x.key === b.dataset.tpl);
      mountThumb(b.querySelector('.sl-tpl-thumb'), t.slides[0], null);
      b.onclick = () => {
        tpl = t.key;
        box.querySelectorAll('.sl-tpl').forEach(x => { x.classList.toggle('is-active', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
      };
    });
  } catch (e) { box.innerHTML = `<div class="sl-new-loading">${esc(e.message)}</div>`; }

  const create = async () => {
    const btn = footer.querySelector('[data-create]');
    btn.disabled = true;
    try {
      const d = await api('/decks', 'POST', {
        workspaceId: wsSel.value,
        title: body.querySelector('#sl-new-title').value.trim() || (tpl === 'blank' ? 'Sem título' : (_templates.find(x => x.key === tpl) || {}).name),
        template: tpl,
        clientId: cSel.value || null,
        projectId: pSel.value || null
      });
      m.close();
      S.nav.toDeck(d);
    } catch (e) { btn.disabled = false; toast(e.message, 'error'); }
  };
  footer.querySelector('[data-create]').onclick = create;
  body.querySelector('#sl-new-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  setTimeout(() => body.querySelector('#sl-new-title').focus(), 80);
}

export function forgetHome() { H.loaded = false; }
export { userName };
