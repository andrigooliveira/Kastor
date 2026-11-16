/* Editor de apresentações (/hub/presentations/<slug>).

   Estado em Yjs, sincronizado por /rt/decks/<id> (docs-rt.js):
     meta   Y.Map   { title }
     theme  Y.Map   { bg, text, accent, font }
     slides Y.Array de Y.Map { id, bg, notes, elements: Y.Array de Y.Map }

   Toda mudança local passa por change(fn) com a origem LOCAL — é o que o
   desfazer acompanha e o que dispara o retrato em JSON pro servidor
   (PUT /api/decks/:id/content), usado pela lista, link público e PDF. */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { $, api, esc, rid, toast, openModal, openMenu, openPopover, closeMenu, avatarHTML, personColor, uploadImage, imageSize, fmtFull, readPref, savePref } from './util.js';
import { icon } from './icons.js';
import { SW, SH, paintSlide, mountThumb, themeOf, FONT_LABELS, FONT_STACKS, sizeOf, registerFonts, fontStack } from './render.js';
import { present, exportPdf, exportPptx } from './present.js';
import { S, clientName, projectName } from './store.js';
import { openFigmaImport } from './figma-ui.js';

const LOCAL = { local: true };
const NONE = 'rgba(0,0,0,0)';
const SNAP_PX = 6;          // distância (na tela) pra grudar nas guias
const MIN_SIZE = 12;

let E = null; // sessão do editor aberta

/* ── Modelos de slide ─────────────────────────────────────────── */
const T = (text, x, y, w, h, extra) => ({ id: rid(), type: 'text', text, x, y, w, h, rot: 0, opacity: 1, fontSize: 48, color: null, bold: false, italic: false, underline: false, align: 'left', valign: 'top', font: null, fill: null, ...extra });
const LAYOUTS = [
  { key: 'title-text', name: 'Título e texto', make: () => [T('', 160, 140, 1600, 110, { fontSize: 72, bold: true }), T('', 160, 300, 1600, 620, { fontSize: 40 })] },
  { key: 'title', name: 'Capa', make: () => [T('', 160, 380, 1600, 180, { fontSize: 104, bold: true }), T('', 160, 580, 1600, 80, { fontSize: 40, opacity: 0.7 })] },
  { key: 'section', name: 'Seção', make: () => [
    { id: rid(), type: 'shape', shape: 'rect', x: 160, y: 430, w: 120, h: 12, rot: 0, opacity: 1, fill: null, stroke: null, strokeW: 0, radius: 0 },
    T('', 160, 470, 1600, 160, { fontSize: 96, bold: true })] },
  { key: 'two-cols', name: 'Duas colunas', make: () => [T('', 160, 140, 1600, 110, { fontSize: 72, bold: true }), T('', 160, 300, 760, 620, { fontSize: 36 }), T('', 1000, 300, 760, 620, { fontSize: 36 })] },
  { key: 'image-text', name: 'Imagem e texto', make: () => [
    { id: rid(), type: 'image', src: '', x: 0, y: 0, w: 900, h: 1080, rot: 0, opacity: 1, fit: 'cover', radius: 0 },
    T('', 1020, 300, 740, 110, { fontSize: 64, bold: true }), T('', 1020, 440, 740, 460, { fontSize: 36 })] },
  { key: 'blank', name: 'Em branco', make: () => [] }
];

/* ── Y helpers ────────────────────────────────────────────────── */
function yEl(obj) {
  const m = new Y.Map();
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) m.set(k, obj[k]);
  return m;
}
function ySlide(s) {
  const m = new Y.Map();
  m.set('id', s.id);
  m.set('bg', s.bg || null);
  m.set('notes', s.notes || '');
  m.set('groups', s.groups || []);
  const a = new Y.Array();
  a.push((s.elements || []).map(yEl));
  m.set('elements', a);
  return m;
}
const slidesArr = () => E.yslides.toArray();
const slideIdx = (id) => slidesArr().findIndex(m => m.get('id') === id);
const slideM = (id) => slidesArr().find(m => m.get('id') === id) || null;
const elsArr = (sm) => (sm ? sm.get('elements').toArray() : []);
const elM = (sm, id) => elsArr(sm).find(m => m.get('id') === id) || null;
const curSlide = () => slideM(E.slideId);
const elJSON = (m) => m.toJSON();
function change(fn) { E.ydoc.transact(fn, LOCAL); }
// Fim de um gesto (arrastar, editar texto): o próximo vira outro passo do desfazer.
function endStep() { if (E && E.undo) E.undo.stopCapturing(); }
function freshIds(s) {
  const gm = new Map((s.groups || []).map(g => [g.id, rid()]));
  return {
    ...s, id: rid(),
    groups: (s.groups || []).map(g => ({ ...g, id: gm.get(g.id) })),
    elements: (s.elements || []).map(e => ({ ...e, id: rid(), groupId: e.groupId ? gm.get(e.groupId) : undefined }))
  };
}
function deckJSON() {
  return {
    title: E.ymeta.get('title') || E.deck.title, theme: themeOf(E.ytheme.toJSON()), slides: E.yslides.toJSON(),
    size: deckSize(), guides: deckGuides(), grid: deckGrid(), fonts: deckFonts()
  };
}

/* ── Abrir / fechar ──────────────────────────────────────────── */
export async function openEditor(id) {
  closeEditor();
  const root = $('sl-editor');
  root.innerHTML = `<div class="sl-ed-loading"><div class="sl-spinner"></div><span>Abrindo apresentação…</span></div>`;
  let deck;
  try { deck = await api('/decks/' + id); }
  catch (e) {
    if (e.message === '__unauth__') throw e;
    root.innerHTML = `<div class="sl-ed-loading"><span>${esc(e.message || 'Apresentação não encontrada.')}</span><a class="btn btn-ghost" href="/hub/presentations">Voltar pras apresentações</a></div>`;
    return;
  }
  document.title = (deck.title || 'Sem título') + ' — reWork Presentations';
  registerFonts(deck.fonts);
  const ydoc = new Y.Doc();
  E = {
    deck, ydoc,
    ymeta: ydoc.getMap('meta'), ytheme: ydoc.getMap('theme'), yslides: ydoc.getArray('slides'),
    slideId: null, sel: new Set(), editingId: null,
    synced: false, status: 'connecting', saveState: 'saved',
    thumbCache: new Map(), raf: 0, saveT: 0, titleT: 0, notesT: 0,
    scale: 1, guides: [], remote: new Map(), clipboard: null, readOnly: false,
    drag: null, hoverId: null, layerAnchor: null, renaming: false, layerDrag: false,
    closedGroups: new Set(), enteredGroup: null,
    showGuides: readPref('guides', '1') === '1', guideDrag: null,
    zoom: 'fit', panX: 0, panY: 0, fitScale: 1, spaceDown: false,
    listeners: []
  };
  buildShell(root);
  E.undo = new Y.UndoManager([E.yslides, E.ytheme, E.ymeta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
  E.undo.on('stack-item-added', (ev) => { ev.stackItem.meta.set('sel', { slide: E.slideId, ids: [...E.sel] }); });
  E.undo.on('stack-item-popped', (ev) => {
    const s = ev.stackItem.meta.get('sel');
    if (s && slideM(s.slide)) { E.slideId = s.slide; E.sel = new Set(s.ids.filter(i => elM(curSlide(), i))); }
    selChanged();
  });

  // Mostra o retrato do servidor enquanto conecta (só leitura)
  E.preview = deck;
  renderAll();

  const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/rt/decks';
  E.provider = new WebsocketProvider(wsBase, deck.id, ydoc, { maxBackoffTime: 5000 });
  const me = S.me || {};
  E.provider.awareness.setLocalStateField('user', { id: me.id, name: me.name || me.username || 'Alguém', avatar: me.avatar || null, color: personColor(me.id || me.username) });
  E.provider.on('status', ({ status }) => { E.status = status; paintStatus(); });
  E.provider.on('sync', (synced) => {
    if (!synced || E.synced) return;
    E.synced = true;
    E.preview = null;
    if (!E.yslides.length) {
      // Sala sem nada (não deveria acontecer: o servidor monta do JSON). Semeia.
      change(() => { E.yslides.push([ySlide({ id: rid(), elements: LAYOUTS[1].make() })]); });
    }
    if (!slideM(E.slideId)) E.slideId = slidesArr()[0].get('id');
    E.undo.clear();
    renderAll();
    paintStatus();
  });
  E.provider.awareness.on('change', () => { paintPresence(); scheduleRender(); });
  ydoc.on('afterTransaction', (tr) => {
    if (!E || tr.doc !== ydoc) return;
    const local = tr.origin === LOCAL || tr.origin === E.undo;
    if (local && tr.changed.size) scheduleSave();
    if (tr.changed.has(E.ymeta) && document.activeElement !== $('sl-ed-title')) {
      $('sl-ed-title').value = E.ymeta.get('title') || '';
    }
    const metaKeys = tr.changed.get(E.ymeta);
    if (metaKeys) {
      if (metaKeys.has('size')) E.thumbCache.clear();
      // Fonte nova de outra pessoa: busca a lista
      if (metaKeys.has('fontsRev') && !(tr.origin && tr.origin.fonts) && tr.origin !== LOCAL) refreshFonts();
    }
    scheduleRender();
  });
  window.addEventListener('beforeunload', onBeforeUnload);
  setTimeout(() => { if (E && !E.synced) paintStatus(); }, 4000);
}

export function closeEditor() {
  if (!E) return;
  flushSave();
  try { E.provider && E.provider.destroy(); } catch {}
  try { E.ydoc.destroy(); } catch {}
  for (const [t, ev, fn, o] of E.listeners) t.removeEventListener(ev, fn, o);
  window.removeEventListener('beforeunload', onBeforeUnload);
  cancelAnimationFrame(E.raf);
  closeMenu();
  E = null;
  $('sl-editor').innerHTML = '';
}

function onBeforeUnload(e) {
  if (E && E.saveState !== 'saved') { flushSave(); e.preventDefault(); e.returnValue = ''; }
}
function on(target, ev, fn, opts) { target.addEventListener(ev, fn, opts); E.listeners.push([target, ev, fn, opts]); }

/* ── Retrato em JSON pro servidor ─────────────────────────────── */
function scheduleSave() {
  E.saveState = 'dirty';
  paintStatus();
  clearTimeout(E.saveT);
  E.saveT = setTimeout(saveNow, 1500);
}
async function saveNow() {
  if (!E || !E.synced) return;
  clearTimeout(E.saveT);
  const ed = E;
  ed.saveState = 'saving'; paintStatus();
  try {
    const r = await api('/decks/' + ed.deck.id + '/content', 'PUT', deckJSON());
    if (E !== ed) return;
    ed.deck.updatedAt = r.updatedAt;
    if (ed.saveState === 'saving') ed.saveState = 'saved';
  } catch (e) {
    if (E !== ed) return;
    ed.saveState = 'error';
    clearTimeout(ed.saveT);
    ed.saveT = setTimeout(saveNow, 8000);
  }
  paintStatus();
}
function flushSave() {
  if (!E || !E.synced || E.saveState === 'saved') return;
  clearTimeout(E.saveT);
  try {
    // keepalive: sai mesmo se a página fechar
    fetch('/api/decks/' + E.deck.id + '/content', { method: 'PUT', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deckJSON()) });
  } catch {}
}

/* ── Casca ────────────────────────────────────────────────────── */
function buildShell(root) {
  const d = E.deck;
  root.innerHTML = `
  <header class="sl-ed-top">
    <a class="sl-ed-home" href="/hub/presentations" title="Voltar pras apresentações" aria-label="Voltar pras apresentações" data-nav-home>
      <img src="/reworkpresentations_icone.svg" alt="" width="28" height="28">
    </a>
    <div class="sl-ed-titlewrap">
      <input id="sl-ed-title" class="sl-ed-title" maxlength="200" value="${esc(d.title)}" aria-label="Título da apresentação" spellcheck="false">
      <div class="sl-ed-sub">
        <button type="button" class="sl-ed-link" id="sl-ed-link"></button>
        <span class="sl-ed-status" id="sl-ed-status" aria-live="polite"></span>
      </div>
    </div>
    <div class="sl-ed-presence" id="sl-ed-presence"></div>
    <div class="sl-ed-actions">
      <button type="button" class="btn btn-ghost" id="sl-ed-theme" title="Cores e fonte da apresentação">${icon('palette', 15)}<span>Tema</span></button>
      <button type="button" class="btn btn-ghost" id="sl-ed-share" title="Cliente, projeto e link público">${icon('link', 15)}<span>Compartilhar</span></button>
      <button type="button" class="btn btn-ghost sl-ed-iconbtn" id="sl-ed-pdf" title="Baixar (PDF ou PowerPoint)" aria-label="Baixar" aria-haspopup="menu">${icon('download', 15)}</button>
      <button type="button" class="btn btn-primary" id="sl-ed-play" title="Apresentar do slide atual">${icon('play', 14)}<span>Apresentar</span></button>
    </div>
  </header>
  <div class="sl-ed-toolbar" id="sl-ed-toolbar" role="toolbar" aria-label="Ferramentas"></div>
  <div class="sl-ed-body">
    <aside class="sl-ed-rail" aria-label="Slides">
      <div class="sl-panel-head"><span>Slides</span><span class="sl-side-count" id="sl-slides-count"></span>
        <button type="button" class="sl-panel-collapse" data-panel="rail" title="Recolher os slides" aria-label="Recolher os slides" aria-expanded="true">${icon('panelLeftClose', 16)}</button>
      </div>
      <div class="sl-ed-slides" id="sl-ed-slides"></div>
      <button type="button" class="sl-ed-add" id="sl-ed-add">${icon('plus', 15)}<span>Novo slide</span>${icon('down', 13, 'class="sl-ed-add-caret"')}</button>
    </aside>
    <main class="sl-ed-main">
      <div class="sl-ed-stagewrap" id="sl-ed-stagewrap">
        <div class="sl-ed-stage" id="sl-ed-stage">
          <div class="sl-scale" id="sl-ed-scale"><div id="sl-ed-canvas"></div></div>
          <div class="sl-gridlayer" id="sl-ed-grid"></div>
          <div class="sl-overlay" id="sl-ed-overlay"></div>
        </div>
        <div class="sl-guidelines" id="sl-ed-guidelines"></div>
        <canvas class="sl-ruler sl-ruler-x" id="sl-ruler-x" title="Arraste pra baixo pra criar uma guia horizontal"></canvas>
        <canvas class="sl-ruler sl-ruler-y" id="sl-ruler-y" title="Arraste pra direita pra criar uma guia vertical"></canvas>
        <button type="button" class="sl-ruler-corner" id="sl-ruler-corner" title="Esconder réguas e guias (Ctrl+;)" aria-label="Esconder réguas e guias">${icon('ruler', 12)}</button>
        <div class="sl-zoom" id="sl-zoom" role="group" aria-label="Zoom">
          <button type="button" class="sl-zoom-btn" data-zoom="out" title="Diminuir zoom (Ctrl −)" aria-label="Diminuir zoom">−</button>
          <button type="button" class="sl-zoom-val" id="sl-zoom-val" title="Opções de zoom" aria-haspopup="menu">100%</button>
          <button type="button" class="sl-zoom-btn" data-zoom="in" title="Aumentar zoom (Ctrl +)" aria-label="Aumentar zoom">+</button>
        </div>
        <div class="sl-ed-drop" id="sl-ed-drop" hidden>${icon('image', 28)}<span>Solte a imagem pra colocar no slide</span></div>
      </div>
      <div class="sl-ed-notes" id="sl-ed-notes-box">
        <button type="button" class="sl-ed-notes-label sl-notes-toggle" id="sl-notes-toggle" aria-expanded="true" aria-controls="sl-ed-notes" title="Recolher ou abrir as notas">${icon('down', 12)}${icon('notes', 13)}<span>Notas do apresentador</span><span class="sl-ed-notes-hint">aparecem só pra quem apresenta</span><span class="sl-notes-has" id="sl-notes-has" hidden>Este slide tem notas</span></button>
        <textarea id="sl-ed-notes" rows="2" placeholder="O que falar neste slide…"></textarea>
      </div>
    </main>
    <aside class="sl-ed-side" id="sl-ed-side" aria-label="Propriedades e camadas">
      <div class="sl-panel-head"><span>Design</span>
        <button type="button" class="sl-panel-collapse" data-panel="side" title="Recolher o painel" aria-label="Recolher o painel" aria-expanded="true">${icon('panelRightClose', 16)}</button>
      </div>
      <div class="sl-side-props" id="sl-side-props">
      <section class="sl-geo sl-sec" id="sl-geo" data-sec="geo" hidden>
          <div class="sl-side-head">${secToggle("geo", "Posição e tamanho")}<span class="sl-geo-lock" id="sl-geo-lock" hidden>${icon('lock', 12)}Travada</span></div>
          <div class="sl-geo-grid sl-sec-body">
            ${GEO.map(g => `<label class="sl-geo-f sl-geo-${g.k}" title="${g.title} — arraste o rótulo pros lados pra ajustar"><span class="sl-geo-l" data-scrub="${g.k}">${g.k === 'rot' ? icon('rotate', 12) : g.label}</span><input type="number" data-k="${g.k}" aria-label="${g.title}"></label>`).join('')}
          </div>
        </section>
          <section class="sl-frame sl-sec" id="sl-frame" data-sec="frame" hidden>
          <div class="sl-side-head">${secToggle("frame", "Slide")}<span class="sl-side-hint">vale pra todos os slides</span></div>
          <div class="sl-side-body sl-sec-body">
            <select class="sl-side-select" id="sl-frame-preset" aria-label="Tamanho pronto">
              ${SIZE_PRESETS.map(p => `<option value="${p.key}">${p.name} · ${p.w} × ${p.h}</option>`).join('')}
              <option value="custom">Personalizado</option>
            </select>
            <div class="sl-frame-dims">
              <label class="sl-geo-f" title="Largura do slide (px)"><span class="sl-geo-l">L</span><input type="number" id="sl-frame-w" min="100" max="8000" aria-label="Largura do slide"></label>
              <button type="button" class="sl-layer-btn is-on" id="sl-frame-swap" title="Trocar largura e altura (deitar/levantar)" aria-label="Trocar largura e altura">${icon('rotate', 13)}</button>
              <label class="sl-geo-f" title="Altura do slide (px)"><span class="sl-geo-l">A</span><input type="number" id="sl-frame-h" min="100" max="8000" aria-label="Altura do slide"></label>
              <span class="sl-frame-ratio" id="sl-frame-ratio"></span>
            </div>
            <label class="form-check sl-side-check"><input type="checkbox" id="sl-frame-scale" checked> Ajustar o conteúdo ao novo tamanho</label>
          </div>
        </section>
        <section class="sl-guides-sec sl-sec" id="sl-guides-sec" data-sec="guides" hidden>
          <div class="sl-side-head">${secToggle("guides", "Guias")}
            <button type="button" class="sl-layer-btn is-on sl-side-headbtn" id="sl-guides-eye" aria-pressed="true"></button>
          </div>
          <div class="sl-side-body sl-sec-body">
            <div class="sl-guides-list" id="sl-guides-list"></div>
            <div class="sl-guides-add">
              <button type="button" class="btn btn-ghost btn-sm" data-gadd="x" title="Guia vertical no meio do slide">${icon('plus', 12)}<span>Vertical</span></button>
              <button type="button" class="btn btn-ghost btn-sm" data-gadd="y" title="Guia horizontal no meio do slide">${icon('plus', 12)}<span>Horizontal</span></button>
              <button type="button" class="btn btn-ghost btn-sm sl-guides-clear" data-gclear title="Apagar todas as guias">Limpar</button>
            </div>
            <div class="sl-side-sub">${icon('grid', 12)}<span>Layout de guias</span></div>
            <select class="sl-side-select" id="sl-grid-preset" aria-label="Layout de guias pronto">
              ${GRID_PRESETS.map(p => `<option value="${p.key}">${p.name}</option>`).join('')}
              <option value="custom">Personalizado</option>
            </select>
            <div class="sl-lay" id="sl-grid-fields">
              <div class="sl-lay-pair">
                ${[['cols', 'Colunas', 'colW', 'Largura', 'colGutter'], ['rows', 'Linhas', 'rowH', 'Altura', 'rowGutter']].map(([n, label, size, sizeLabel, gut]) => `
                <fieldset class="sl-lay-group" data-group="${n}On">
                  <label class="sl-lay-check"><input type="checkbox" data-gb="${n}On"><span>${label}</span></label>
                  <label class="sl-lay-f" title="Quantas ${label.toLowerCase()}"><span>Número</span><input type="number" min="0" max="48" data-gk="${n}"></label>
                  <label class="sl-lay-f" title="${sizeLabel} de cada uma, em px. Vazio = divide o espaço por igual"><span>${sizeLabel}</span><input type="number" min="0" data-gk="${size}" placeholder="auto"></label>
                  <label class="sl-lay-f" title="Medianiz: espaço entre ${n === 'cols' ? 'as colunas' : 'as linhas'}, em px"><span>Medianiz</span><input type="number" min="0" data-gk="${gut}"></label>
                </fieldset>`).join('')}
              </div>
              <fieldset class="sl-lay-group" data-group="marginOn">
                <label class="sl-lay-check"><input type="checkbox" data-gb="marginOn"><span>Margem</span></label>
                <div class="sl-lay-margins">
                  ${[['mt', 'Superior'], ['ml', 'Esquerda'], ['mb', 'Inferior'], ['mr', 'Direita']].map(([k, l]) => `<label class="sl-lay-f" title="Margem ${l.toLowerCase()} (px)"><span>${l}</span><input type="number" min="0" data-gk="${k}"></label>`).join('')}
                </div>
              </fieldset>
              <label class="sl-lay-check sl-lay-center" title="Com largura de coluna fixa, o bloco de colunas fica no meio da área"><input type="checkbox" data-gb="center"><span>Centralizar colunas</span></label>
            </div>
          </div>
        </section>
      </div>
      <div class="sl-side-head sl-layers-head"><span>Camadas</span><span class="sl-side-count" id="sl-layers-count"></span>
        <div class="sl-layers-tools">
          <button type="button" class="sl-layer-btn" id="sl-ltool-group" title="Agrupar a seleção (Ctrl+G)" aria-label="Agrupar a seleção">${icon('group', 14)}</button>
          <button type="button" class="sl-layer-btn" id="sl-ltool-ungroup" title="Desagrupar (Ctrl+Shift+G)" aria-label="Desagrupar">${icon('ungroup', 14)}</button>
        </div>
      </div>
      <div class="sl-layers" id="sl-layers" role="tree" aria-label="Camadas do slide" aria-multiselectable="true"></div>
    </aside>
  </div>
  <input type="file" id="sl-ed-file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif" hidden>`;

  root.querySelector('[data-nav-home]').addEventListener('click', (e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); S.nav.toList(); } });
  const title = $('sl-ed-title');
  title.addEventListener('input', () => {
    const v = title.value;
    E.ydoc.transact(() => E.ymeta.set('title', v), { title: true });
    clearTimeout(E.titleT);
    E.titleT = setTimeout(() => { if (E) api('/decks/' + E.deck.id, 'PATCH', { title: v }).catch(() => {}); }, 800);
    document.title = (v || 'Sem título') + ' — reWork Presentations';
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') title.blur(); });
  title.addEventListener('blur', () => { if (!title.value.trim()) { title.value = 'Sem título'; title.dispatchEvent(new Event('input')); } });
  $('sl-ed-link').addEventListener('click', openShare);
  $('sl-ed-theme').addEventListener('click', openTheme);
  $('sl-ed-share').addEventListener('click', openShare);
  $('sl-ed-pdf').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { heading: 'Baixar' },
    { label: 'PDF', hint: '.pdf', icon: icon('download', 15), onClick: () => exportPdf(currentDeck()) },
    { label: 'PowerPoint', hint: '.pptx', icon: icon('presentation', 15), onClick: () => exportPptx(currentDeck()) }
  ], { align: 'right' }));
  $('sl-ed-play').addEventListener('click', () => startPresent(Math.max(0, currentSlides().findIndex(s => s.id === E.slideId))));
  $('sl-ed-add').addEventListener('click', (e) => openLayoutMenu(e.currentTarget));
  $('sl-ed-file').addEventListener('change', onFilePicked);
  const notes = $('sl-ed-notes');
  notes.addEventListener('input', () => {
    clearTimeout(E.notesT);
    const v = notes.value, sid = E.slideId;
    E.notesT = setTimeout(() => { const sm = slideM(sid); if (sm) change(() => sm.set('notes', v)); }, 350);
  });
  // Notas recolhíveis (cada pessoa guarda o seu jeito)
  const setNotesOpen = (open) => {
    $('sl-ed-notes-box').classList.toggle('is-collapsed', !open);
    $('sl-notes-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    paintNotesHint();
    requestAnimationFrame(fitStage);
  };
  setNotesOpen(readPref('notes', '1') === '1');
  $('sl-notes-toggle').addEventListener('click', () => {
    const open = $('sl-notes-toggle').getAttribute('aria-expanded') !== 'true';
    savePref('notes', open ? '1' : '0');
    setNotesOpen(open);
    if (open) notes.focus();
  });
  bindStage();
  bindZoom();
  bindRail();
  bindLayers();
  bindGeo();
  bindFrame();
  bindGuides();
  bindGuidesSec();
  bindSections();
  // Painéis da esquerda (slides) e da direita (design): recolhem pra uma faixa
  const PANELS = {
    rail: { cls: 'rail-collapsed', pref: 'rail', open: 'panelLeftOpen', close: 'panelLeftClose', label: 'os slides' },
    side: { cls: 'no-side', pref: 'layers', open: 'panelRightOpen', close: 'panelRightClose', label: 'o painel' }
  };
  const applyPanel = (key, open) => {
    const p = PANELS[key];
    root.classList.toggle(p.cls, !open);
    const b = root.querySelector(`[data-panel="${key}"]`);
    b.innerHTML = icon(open ? p.close : p.open, 16);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.title = (open ? 'Recolher ' : 'Abrir ') + p.label;
    b.setAttribute('aria-label', b.title);
    requestAnimationFrame(fitStage);
  };
  for (const key of Object.keys(PANELS)) applyPanel(key, readPref(PANELS[key].pref, '1') === '1');
  root.querySelectorAll('[data-panel]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.panel, open = b.getAttribute('aria-expanded') !== 'true';
    savePref(PANELS[key].pref, open ? '1' : '0');
    applyPanel(key, open);
  }));
  on(document, 'keydown', onKey);
  on(document, 'paste', onPaste);
  on(document, 'copy', onCopy);
  on(document, 'cut', (e) => { if (!E || !editable() || typingInField(e.target) || !E.sel.size) return; onCopy(e); deleteSelected(); });
  bindContextMenus();
  on(window, 'resize', fitStage);
  if (window.ResizeObserver) { const ro = new ResizeObserver(fitStage); ro.observe($('sl-ed-stagewrap')); E.listeners.push([{ removeEventListener: () => ro.disconnect() }, 'x', null]); }
  paintLinkLabel();
  paintStatus();
}

function currentSlides() { return E.preview ? E.preview.slides : E.yslides.toJSON(); }
function currentTheme() { return themeOf(E.preview ? E.preview.theme : E.ytheme.toJSON()); }
function currentDeck() { return E.preview ? E.preview : deckJSON(); }
const editable = () => E && E.synced && !E.readOnly;

/* ── Status, vínculo e presença ──────────────────────────────── */
function paintStatus() {
  const el = $('sl-ed-status'); if (!el || !E) return;
  let html, cls = '';
  if (!E.synced) {
    html = E.status === 'disconnected' ? `${icon('cloudOff', 12)}<span>Sem conexão — tentando de novo…</span>` : '<span>Conectando…</span>';
    cls = E.status === 'disconnected' ? 'is-warn' : '';
  } else if (E.status !== 'connected') {
    html = `${icon('cloudOff', 12)}<span>Sem conexão — o que você mudar sobe quando voltar</span>`; cls = 'is-warn';
  } else if (E.saveState === 'error') {
    html = `${icon('cloudOff', 12)}<span>Não deu pra salvar a cópia — tentando de novo</span>`; cls = 'is-warn';
  } else if (E.saveState === 'saved') {
    html = `${icon('check', 12)}<span>Salvo</span>`;
  } else html = '<span>Salvando…</span>';
  el.className = 'sl-ed-status ' + cls;
  el.innerHTML = html;
  el.title = E.deck.updatedAt ? 'Última cópia salva: ' + fmtFull(E.deck.updatedAt) : '';
  document.body.classList.toggle('sl-readonly', !editable());
}
function paintLinkLabel() {
  const d = E.deck;
  const where = [clientName(d.clientId), projectName(d.projectId)].filter(Boolean).join(' · ');
  const b = $('sl-ed-link');
  b.innerHTML = where ? `<span>${esc(where)}</span>` : '<span class="is-muted">Sem cliente</span>';
  b.title = where ? 'Trocar cliente/projeto' : 'Vincular a um cliente ou projeto';
  if (d.publicShareEnabled) b.innerHTML += `<span class="sl-ed-public">${icon('link', 11)}Link público</span>`;
}
function remoteStates() {
  const out = [];
  if (!E.provider) return out;
  const mine = E.provider.awareness.clientID;
  // A própria pessoa aberta em outra guia não conta como "outra pessoa"
  const meId = S.me && S.me.id;
  E.provider.awareness.getStates().forEach((st, cid) => { if (cid !== mine && st && st.user && st.user.id !== meId) out.push({ cid, ...st }); });
  return out;
}
function paintPresence() {
  const box = $('sl-ed-presence'); if (!box || !E) return;
  const seen = new Map();
  for (const st of remoteStates()) if (!seen.has(st.user.id)) seen.set(st.user.id, st);
  const list = [...seen.values()];
  const slides = currentSlides();
  box.innerHTML = list.slice(0, 5).map(st => {
    const n = slides.findIndex(s => st.sel && s.id === st.sel.slide);
    const u = S.usersById.get(st.user.id) || st.user;
    return `<button type="button" class="sl-presence" style="--pc:${esc(st.user.color)}" data-slide="${esc(st.sel ? st.sel.slide : '')}" title="${esc(st.user.name)}${n >= 0 ? ' · no slide ' + (n + 1) : ''} — clique pra ir até lá">${avatarHTML(u, 28)}</button>`;
  }).join('') + (list.length > 5 ? `<span class="sl-presence-more">+${list.length - 5}</span>` : '');
  box.querySelectorAll('[data-slide]').forEach(b => b.onclick = () => { if (b.dataset.slide && slideM(b.dataset.slide)) selectSlide(b.dataset.slide); });
}
function updateAwareness() {
  if (!E || !E.provider) return;
  E.provider.awareness.setLocalStateField('sel', { slide: E.slideId, ids: [...E.sel] });
}

/* ── Render ───────────────────────────────────────────────────── */
function scheduleRender() {
  if (!E || E.raf) return;
  E.raf = requestAnimationFrame(() => { if (!E) return; E.raf = 0; renderAll(); });
}
function renderAll() {
  if (!E) return;
  const slides = currentSlides();
  if (!slides.length) return;
  if (!slides.some(s => s.id === E.slideId)) {
    // O slide aberto sumiu (excluído por alguém): vai pro vizinho
    const old = E.lastOrder || [];
    const at = old.indexOf(E.slideId);
    E.slideId = (slides[Math.min(Math.max(at, 0), slides.length - 1)] || slides[0]).id;
    E.sel.clear(); E.editingId = null;
  }
  E.lastOrder = slides.map(s => s.id);
  const slide = slides.find(s => s.id === E.slideId);
  // Seleção só com o que ainda existe
  for (const id of [...E.sel]) if (!slide.elements.some(e => e.id === id)) E.sel.delete(id);
  if (E.editingId && !slide.elements.some(e => e.id === E.editingId)) E.editingId = null;
  const theme = currentTheme();
  paintSlide($('sl-ed-canvas'), viewSlide() || slide, theme, { editingId: E.editingId, placeholder: true, size: deckSize() });
  $('sl-ed-canvas').querySelectorAll('.sl-el-image .sl-img-empty').forEach(n => { n.textContent = 'Clique duas vezes para escolher a imagem'; });
  renderRail(slides, theme);
  fitStage();
  renderOverlay();
  syncToolbar();
  renderLayers();
  syncGeo();
  renderSideProps();
  paintPresence();
  const notes = $('sl-ed-notes');
  if (document.activeElement !== notes || notes.dataset.slide !== slide.id) { notes.value = slide.notes || ''; notes.dataset.slide = slide.id; }
  notes.disabled = !editable();
  paintNotesHint();
}
/* Notas recolhidas: avisa se o slide aberto tem notas */
function paintNotesHint() {
  const box = $('sl-ed-notes-box'), has = $('sl-notes-has');
  if (!box || !has || !E) return;
  const slide = currentSlides().find(s => s.id === E.slideId);
  has.hidden = !box.classList.contains('is-collapsed') || !(slide && (slide.notes || '').trim());
}

function fitStage() {
  if (!E) return;
  const wrap = $('sl-ed-stagewrap'); if (!wrap) return;
  const pad = 32, rl = showGuides() ? RULER : 0;
  const { w, h } = deckSize();
  const W = wrap.clientWidth, H = wrap.clientHeight;
  // "Ajustar à tela" (padrão) ou zoom fixo (1 = 100%, px reais do slide)
  const fitS = Math.max(0.02, Math.min((W - rl - pad * 2) / w, (H - rl - pad * 2) / h));
  E.fitScale = fitS;
  const s = E.zoom === 'fit' || !E.zoom ? fitS : E.zoom;
  E.scale = s;
  if (E.zoom === 'fit' || !E.zoom) {
    E.panX = rl + (W - rl - w * s) / 2;
    E.panY = rl + (H - rl - h * s) / 2;
  } else {
    // Sempre sobra um pedaço do slide à vista
    const keep = 80;
    E.panX = Math.min(W - keep, Math.max(keep - w * s, E.panX));
    E.panY = Math.min(H - keep, Math.max(keep - h * s, E.panY));
  }
  const st = $('sl-ed-stage');
  st.style.width = w * s + 'px';
  st.style.height = h * s + 'px';
  st.style.left = Math.round(E.panX) + 'px';
  st.style.top = Math.round(E.panY) + 'px';
  st.style.margin = '';
  paintZoom();
  const sc = $('sl-ed-scale');
  sc.style.width = w + 'px'; sc.style.height = h + 'px';
  sc.style.transform = `scale(${s})`;
  renderOverlay();
  renderGuides();
}

/* Trilho de miniaturas */
function renderRail(slides, theme) {
  const box = $('sl-ed-slides');
  const remote = remoteStates();
  const size = deckSize();
  const cnt = $('sl-slides-count'); if (cnt) cnt.textContent = slides.length;
  const themeKey = JSON.stringify(theme) + size.w + 'x' + size.h + deckFonts().length;
  const existing = new Map();
  box.querySelectorAll('.sl-rail-item').forEach(n => existing.set(n.dataset.id, n));
  let prev = null;
  slides.forEach((s, i) => {
    let item = existing.get(s.id);
    if (item) existing.delete(s.id);
    else {
      item = document.createElement('div');
      item.className = 'sl-rail-item';
      item.dataset.id = s.id;
      item.innerHTML = `<span class="sl-rail-num"></span><button type="button" class="sl-rail-thumb"><div class="sl-rail-canvas"></div></button><div class="sl-rail-dots"></div><button type="button" class="sl-rail-more" title="Ações do slide" aria-label="Ações do slide">${icon('more', 14)}</button>`;
      item.draggable = true;
    }
    item.querySelector('.sl-rail-num').textContent = i + 1;
    item.classList.toggle('is-active', s.id === E.slideId);
    item.querySelector('.sl-rail-thumb').setAttribute('aria-label', `Slide ${i + 1}`);
    item.querySelector('.sl-rail-thumb').setAttribute('aria-current', s.id === E.slideId ? 'true' : 'false');
    const key = themeKey + JSON.stringify(s);
    if (E.thumbCache.get(s.id) !== key || !item.querySelector('.sl-scale')) {
      E.thumbCache.set(s.id, key);
      item.querySelector('.sl-rail-thumb').style.aspectRatio = size.w + ' / ' + size.h;
      mountThumb(item.querySelector('.sl-rail-canvas'), s, theme, size);
    }
    const here = remote.filter(st => st.sel && st.sel.slide === s.id);
    item.querySelector('.sl-rail-dots').innerHTML = here.slice(0, 3).map(st => `<span class="sl-rail-dot" style="background:${esc(st.user.color)}" title="${esc(st.user.name)} está aqui"></span>`).join('');
    const want = prev ? prev.nextSibling : box.firstChild;
    if (want !== item) box.insertBefore(item, want);
    prev = item;
  });
  for (const n of existing.values()) { n.remove(); E.thumbCache.delete(n.dataset.id); }
  const act = box.querySelector('.sl-rail-item.is-active');
  if (act && E.scrollRail) { act.scrollIntoView({ block: 'nearest' }); E.scrollRail = false; }
}

function bindRail() {
  const box = $('sl-ed-slides');
  box.addEventListener('click', (e) => {
    const item = e.target.closest('.sl-rail-item'); if (!item) return;
    if (e.target.closest('.sl-rail-more')) { openSlideMenu(e.target.closest('.sl-rail-more'), item.dataset.id); return; }
    selectSlide(item.dataset.id);
  });
  box.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.sl-rail-item'); if (!item) return;
    e.preventDefault();
    openSlideMenu(item.querySelector('.sl-rail-more'), item.dataset.id);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const slides = currentSlides();
    const i = slides.findIndex(s => s.id === E.slideId) + (e.key === 'ArrowDown' ? 1 : -1);
    if (slides[i]) { selectSlide(slides[i].id); requestAnimationFrame(() => { const b = box.querySelector('.sl-rail-item.is-active .sl-rail-thumb'); if (b) b.focus(); }); }
  });
  // Arrastar pra reordenar
  let dragId = null;
  box.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.sl-rail-item');
    if (!item || !editable()) { e.preventDefault(); return; }
    dragId = item.dataset.id;
    item.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  });
  const clearMarks = () => box.querySelectorAll('.drop-before,.drop-after,.is-dragging').forEach(n => n.classList.remove('drop-before', 'drop-after', 'is-dragging'));
  box.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const item = e.target.closest('.sl-rail-item'); if (!item) return;
    e.preventDefault();
    const r = item.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    box.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
    item.classList.add(after ? 'drop-after' : 'drop-before');
  });
  box.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const item = e.target.closest('.sl-rail-item');
    if (item && item.dataset.id !== dragId) {
      const r = item.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const ids = currentSlides().map(s => s.id);
      let to = ids.indexOf(item.dataset.id) + (after ? 1 : 0);
      const from = ids.indexOf(dragId);
      if (from < to) to--;
      moveSlide(from, to);
    }
    clearMarks(); dragId = null;
  });
  box.addEventListener('dragend', () => { clearMarks(); dragId = null; });
}

function selectSlide(id) {
  if (!E || id === E.slideId) return;
  stopEditing();
  E.slideId = id;
  E.sel.clear();
  E.layerAnchor = null; E.hoverId = null; E.enteredGroup = null;
  E.scrollRail = true;
  updateAwareness();
  renderAll();
}

/* ── Operações de slide ──────────────────────────────────────── */
function openLayoutMenu(anchor) {
  if (!editable()) return;
  openMenu(anchor, [{ heading: 'Novo slide' }, ...LAYOUTS.map(l => ({ label: l.name, icon: icon('layout', 15), onClick: () => addSlide(l.key) })),
    '-', { label: 'Trazer do Figma…', icon: FIGMA_IC, onClick: figmaIntoDeck }]);
}
function addSlide(layout, at) {
  const l = LAYOUTS.find(x => x.key === layout) || LAYOUTS[0];
  const s = { id: rid(), bg: null, notes: '', elements: l.make().map(fitToDeck) };
  const i = at !== undefined ? at : slideIdx(E.slideId) + 1;
  change(() => E.yslides.insert(Math.max(0, Math.min(i, E.yslides.length)), [ySlide(s)]));
  E.slideId = s.id; E.sel.clear(); E.scrollRail = true;
  updateAwareness();
  renderAll();
}
function duplicateSlide(id) {
  const i = slideIdx(id); if (i < 0) return;
  const copy = freshIds(E.yslides.get(i).toJSON());
  change(() => E.yslides.insert(i + 1, [ySlide(copy)]));
  E.slideId = copy.id; E.sel.clear(); E.scrollRail = true;
  updateAwareness();
  renderAll();
}
function deleteSlide(id) {
  if (E.yslides.length <= 1) { toast('A apresentação precisa de pelo menos um slide.'); return; }
  const i = slideIdx(id); if (i < 0) return;
  const next = E.yslides.get(i + 1) || E.yslides.get(i - 1);
  change(() => E.yslides.delete(i, 1));
  if (E.slideId === id) { E.slideId = next.get('id'); E.sel.clear(); }
  updateAwareness();
  renderAll();
  toast('Slide excluído. Ctrl+Z desfaz.');
}
function moveSlide(from, to) {
  if (from === to || from < 0 || to < 0 || to >= E.yslides.length) return;
  const json = E.yslides.get(from).toJSON();
  change(() => { E.yslides.delete(from, 1); E.yslides.insert(to, [ySlide(json)]); });
  renderAll();
}
function openSlideMenu(anchor, id) {
  if (!editable()) return;
  const i = slideIdx(id), n = E.yslides.length;
  openMenu(anchor, [
    { label: 'Duplicar slide', icon: icon('copy', 15), onClick: () => duplicateSlide(id) },
    { label: 'Mover pra cima', icon: icon('front', 15), disabled: i === 0, onClick: () => moveSlide(i, i - 1) },
    { label: 'Mover pra baixo', icon: icon('back', 15), disabled: i === n - 1, onClick: () => moveSlide(i, i + 1) },
    { label: 'Apresentar daqui', icon: icon('play', 15), onClick: () => startPresent(i) },
    '-',
    { label: 'Excluir slide', icon: icon('trash', 15), danger: true, disabled: n <= 1, onClick: () => deleteSlide(id) }
  ]);
}

/* ── Elementos ───────────────────────────────────────────────── */
function insertElement(el, { edit = false } = {}) {
  const sm = curSlide(); if (!sm) return;
  change(() => sm.get('elements').push([yEl(el)]));
  E.sel = new Set([el.id]);
  updateAwareness();
  renderAll();
  if (edit) startEditing(el.id);
}
function addText() {
  if (!editable()) return;
  insertElement(fitToDeck(T('', 560, 460, 800, 120, { fontSize: 48 })), { edit: true });
}
function addShape(shape) {
  if (!editable()) return;
  const base = { id: rid(), type: 'shape', shape, rot: 0, opacity: 1, fill: null, stroke: null, strokeW: shape === 'line' ? 6 : 0, radius: 0 };
  const dims = shape === 'line' ? { x: 660, y: 520, w: 600, h: 40 } : shape === 'ellipse' ? { x: 810, y: 390, w: 300, h: 300 } : { x: 760, y: 390, w: 400, h: 300 };
  insertElement(fitToDeck({ ...base, ...dims }));
}
async function addImageFromFile(file, target) {
  if (!editable()) return;
  toast('Enviando imagem…', 'sticky');
  try {
    const src = await uploadImage(file);
    if (!E) return;
    const tm = target && elM(curSlide(), target);
    if (tm) { change(() => tm.set('src', src)); toast('Imagem trocada.'); renderAll(); return; }
    const { w, h } = await imageSize(src);
    const ds = deckSize();
    const sc = Math.min(1, (ds.w * 0.62) / w, (ds.h * 0.74) / h);
    const ew = Math.round(w * sc), eh = Math.round(h * sc);
    insertElement({ id: rid(), type: 'image', src, x: Math.round((ds.w - ew) / 2), y: Math.round((ds.h - eh) / 2), w: ew, h: eh, rot: 0, opacity: 1, fit: 'cover', radius: 0 });
    toast('Imagem adicionada.');
  } catch (e) { toast(e.message || 'Falha ao enviar a imagem.', 'error'); }
}
function pickImage(targetId) {
  E.fileTarget = targetId || null;
  const f = $('sl-ed-file'); f.value = ''; f.click();
}
function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  if (file) addImageFromFile(file, E.fileTarget);
  E.fileTarget = null;
}
function selectedMaps() {
  const sm = curSlide();
  return [...E.sel].map(id => elM(sm, id)).filter(Boolean);
}
function setProps(props, maps) {
  maps = maps || selectedMaps();
  if (!maps.length) return;
  // Estilo aplicado pela barra vale pro texto inteiro: tira o mesmo estilo
  // dos trechos (texto vindo do Figma com partes em negrito, cor…)
  const RUN_KEYS = ['bold', 'italic', 'underline', 'color', 'fontSize', 'font'];
  const runKeys = Object.keys(props).filter(k => RUN_KEYS.includes(k));
  change(() => {
    for (const m of maps) {
      for (const k of Object.keys(props)) m.set(k, props[k]);
      const runs = m.get('runs');
      if (runKeys.length && Array.isArray(runs)) {
        m.set('runs', runs.map(r => { const c = { ...r }; for (const k of runKeys) delete c[k]; return c; }));
      }
    }
  });
}
function deleteSelected() {
  const sm = curSlide(); if (!sm || !E.sel.size) return;
  const arr = sm.get('elements');
  change(() => {
    const ids = arr.toArray().map(m => m.get('id'));
    for (let i = ids.length - 1; i >= 0; i--) if (E.sel.has(ids[i])) arr.delete(i, 1);
  });
  E.sel.clear(); E.editingId = null;
  updateAwareness();
}
function duplicateSelected() {
  const sm = curSlide(); if (!sm || !E.sel.size) return;
  const index = new Map(elsArr(sm).map((m, i) => [m.get('id'), i]));
  const groups = sm.get('groups') || [];
  const gmap = new Map();
  const copies = selectedMaps().sort((p, q) => index.get(p.get('id')) - index.get(q.get('id'))).map(m => {
    const j = { ...m.toJSON(), id: rid(), x: m.get('x') + 40, y: m.get('y') + 40 };
    if (j.groupId) { if (!gmap.has(j.groupId)) gmap.set(j.groupId, rid()); j.groupId = gmap.get(j.groupId); }
    return j;
  });
  const newGroups = [...gmap].map(([o, nw]) => ({ id: nw, name: ((groups.find(g => g.id === o) || {}).name || 'Grupo') + ' (cópia)' }));
  change(() => { sm.get('elements').push(copies.map(yEl)); if (newGroups.length) sm.set('groups', [...groups, ...newGroups]); });
  E.sel = new Set(copies.map(c => c.id));
  updateAwareness();
}
function reorder(dir) {
  if (!E.sel.size) return;
  const order = layerOrder();
  const picked = order.filter(id => E.sel.has(id));
  const rest = order.filter(id => !E.sel.has(id));
  applyOrder(dir === 'front' ? picked.concat(rest) : rest.concat(picked));
}

/* ── Edição de texto ─────────────────────────────────────────── */
function startEditing(id) {
  if (!editable()) return;
  const m = elM(curSlide(), id); if (!m || m.get('type') !== 'text' || m.get('locked') || m.get('hidden')) return;
  endStep();
  E.editingId = id;
  E.sel = new Set([id]);
  updateAwareness();
  renderAll();
  const node = $('sl-ed-canvas').querySelector(`.sl-el[data-id="${CSS.escape(id)}"] .sl-text`);
  if (!node) return;
  node.classList.remove('is-empty');
  node.textContent = m.get('text') || '';
  if (Array.isArray(m.get('runs')) && m.get('runs').length) toast('Este texto tem partes com estilos diferentes. Se você mudar o texto, ele fica com um estilo só (Ctrl+Z desfaz).');
  try { node.contentEditable = 'plaintext-only'; } catch { node.contentEditable = 'true'; }
  if (node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
  node.spellcheck = true;
  node.focus();
  const r = document.createRange(); r.selectNodeContents(node);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  if (!m.get('text')) sel.collapseToEnd();
  let t = 0;
  const commit = () => {
    const sm = curSlide(); const em = sm && elM(sm, id);
    if (!em) return;
    const text = node.innerText.replace(/\n$/, '');
    // Cresce a caixa se o texto passar do fim
    const need = Math.ceil(node.scrollHeight);
    change(() => {
      if (em.get('text') !== text) {
        em.set('text', text);
        // Texto mudou: os trechos com estilo próprio deixam de bater com ele
        if (em.get('runs')) em.delete('runs');
      }
      if (need > em.get('h')) em.set('h', need);
    });
  };
  node.oninput = () => { clearTimeout(t); t = setTimeout(commit, 250); renderOverlay(); };
  node.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); node.blur(); }
    if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
      setProps({ [k]: !m.get(k) }, [m]);
    }
  };
  node.onblur = () => { clearTimeout(t); commit(); endStep(); node.contentEditable = 'false'; node.oninput = node.onkeydown = node.onblur = null; if (E && E.editingId === id) { E.editingId = null; renderAll(); } };
}
function stopEditing() {
  if (!E || !E.editingId) return;
  const node = $('sl-ed-canvas').querySelector(`.sl-el[data-id="${CSS.escape(E.editingId)}"] .sl-text`);
  if (node && document.activeElement === node) node.blur();
  E.editingId = null;
}

/* ── Palco: selecionar, mover, redimensionar, girar ──────────── */
function toSlide(ev) {
  const r = $('sl-ed-stage').getBoundingClientRect();
  return { x: (ev.clientX - r.left) / E.scale, y: (ev.clientY - r.top) / E.scale };
}
function bindStage() {
  const stage = $('sl-ed-stage');
  const wrap = $('sl-ed-stagewrap');
  stage.addEventListener('pointerdown', onStageDown);
  stage.addEventListener('pointermove', (e) => {
    if (!E || e.buttons || E.drag) return;
    const n = e.target.closest('#sl-ed-canvas .sl-el');
    const el = n && viewEl(n.dataset.id);
    if (!isFree(el)) { setHover(null); return; }
    setHover(el.groupId && hasGroup(el.groupId) && E.enteredGroup !== el.groupId ? 'g:' + el.groupId : el.id);
  });
  stage.addEventListener('pointerleave', () => { if (E && !E.drag) setHover(null); });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap && E && !E.editingId && E.sel.size) { E.sel.clear(); selChanged(); }
  });
  stage.addEventListener('dblclick', (e) => {
    if (!editable()) return;
    if (e.target.closest('[data-group-tag]')) { renameSelected(); return; }
    const n = e.target.closest('#sl-ed-canvas .sl-el'); if (!n) return;
    const m = elM(curSlide(), n.dataset.id); if (!m || m.get('locked')) return;
    const gid = m.get('groupId');
    if (gid && hasGroup(gid) && E.enteredGroup !== gid) {
      E.enteredGroup = gid; E.sel = new Set([n.dataset.id]); E.scrollLayer = true;
      if (E.closedGroups.has(gid)) E.closedGroups.delete(gid);
      selChanged();
      return;
    }
    if (m.get('type') === 'text') startEditing(n.dataset.id);
    else if (m.get('type') === 'image') pickImage(n.dataset.id);
  });
  // Soltar imagem no palco
  let dragDepth = 0;
  wrap.addEventListener('dragenter', (e) => { if (!editable() || ![...(e.dataTransfer.types || [])].includes('Files')) return; dragDepth++; $('sl-ed-drop').hidden = false; });
  wrap.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('sl-ed-drop').hidden = true; });
  wrap.addEventListener('dragover', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
  wrap.addEventListener('drop', (e) => {
    dragDepth = 0; $('sl-ed-drop').hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    addImageFromFile(f);
  });
}

/* Primeira camada livre debaixo do ponteiro (pula travadas, como no Figma) */
function pickBelow(e) {
  for (const n of document.elementsFromPoint(e.clientX, e.clientY)) {
    const el = n.closest && n.closest('#sl-ed-canvas .sl-el');
    if (el && isFree(viewEl(el.dataset.id))) return el;
  }
  return null;
}
function onStageDown(e) {
  if (!E || e.button !== 0) return;
  if (e.target.closest('[data-group-tag]')) { e.preventDefault(); return; }
  const handle = e.target.closest('[data-handle]');
  let elNode = e.target.closest('#sl-ed-canvas .sl-el');
  if (elNode && !isFree(viewEl(elNode.dataset.id))) elNode = pickBelow(e) || null;
  // Clique dentro do texto em edição: deixa o navegador cuidar
  if (elNode && elNode.dataset.id === E.editingId) return;
  if (!editable()) {
    if (elNode) { E.sel = new Set([elNode.dataset.id]); renderOverlay(); }
    return;
  }
  if (E.editingId) stopEditing();
  e.preventDefault();
  $('sl-ed-stage').focus({ preventScroll: true });
  const p0 = toSlide(e);
  const sm = curSlide();
  if (handle) {
    const id = handle.closest('[data-box]').dataset.box;
    const m = elM(sm, id); if (!m) return;
    if (handle.dataset.handle === 'rot') return dragRotate(e, m);
    return dragResize(e, m, handle.dataset.handle);
  }
  if (elNode) {
    const id = elNode.dataset.id;
    const cl = viewEl(id);
    // Clicou fora do grupo em que tinha entrado: sai dele
    if (E.enteredGroup && (!cl || cl.groupId !== E.enteredGroup)) E.enteredGroup = null;
    const unit = unitOf(id);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const all = unit.every(u => E.sel.has(u));
      for (const u of unit) { if (all) E.sel.delete(u); else E.sel.add(u); }
      E.layerAnchor = id; E.scrollLayer = true; selChanged();
      if (!E.sel.has(id)) return;
    } else if (!E.sel.has(id)) {
      E.sel = new Set(unit); E.layerAnchor = id; E.scrollLayer = true; selChanged();
    }
    return dragMove(e, p0);
  }
  // Fundo: seleção por área
  E.enteredGroup = null;
  if (E.sel.size) { E.sel.clear(); selChanged(); }
  dragMarquee(e, p0);
}

function track(e, onMove, onUp) {
  const id = e.pointerId;
  const move = (ev) => { if (ev.pointerId === id) onMove(ev); };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    onUp(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

/* Guias: bordas e centros do slide e dos outros elementos. */
function snapTargets(excludeIds) {
  const { w: dw, h: dh } = deckSize();
  const gt = guideSnapTargets();
  const xs = [0, dw / 2, dw, ...gt.xs], ys = [0, dh / 2, dh, ...gt.ys];
  for (const m of elsArr(curSlide())) {
    if (excludeIds.has(m.get('id')) || m.get('hidden')) continue;
    const x = m.get('x'), y = m.get('y'), w = m.get('w'), h = m.get('h');
    xs.push(x, x + w / 2, x + w); ys.push(y, y + h / 2, y + h);
  }
  return { xs, ys };
}
function snapAxis(edges, targets, tol) {
  let best = null;
  for (const t of targets) for (const ed of edges) {
    const d = t - ed;
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
  }
  return best;
}

/* Gesto em andamento (mover, redimensionar, girar, arrastar valor no painel):
   geometria ao vivo por id, desenhada por cima do Yjs. O envio a cada 90ms
   pro tempo real não repinta a partir de um valor atrasado — antes a caixa
   pulava pra trás e, ao mover, somava o deslocamento duas vezes. */
function liveEl(el) { const o = E.drag && E.drag.get(el.id); return o ? { ...el, ...o } : el; }
function viewSlide() {
  const s = currentSlides().find(x => x.id === E.slideId);
  return s ? { ...s, elements: s.elements.map(liveEl) } : null;
}
function paintStage(extra) {
  const s = viewSlide(); if (!s) return;
  paintSlide($('sl-ed-canvas'), s, currentTheme(), { editingId: E.editingId, placeholder: true, size: deckSize() });
  renderOverlay(extra);
  syncGeo();
}
function startGesture() { E.drag = new Map(); }
function commitGesture() {
  const d = E.drag; if (!d || !d.size) return;
  const sm = curSlide(); if (!sm) return;
  change(() => {
    for (const [id, g] of d) {
      const m = elM(sm, id); if (!m) continue;
      for (const k of Object.keys(g)) if (m.get(k) !== g[k]) m.set(k, g[k]);
    }
  });
}
function endGesture() {
  commitGesture();
  E.drag = null; E.guides = [];
  endStep();
  renderAll();
}
const isFree = (el) => !!el && !el.locked && !el.hidden;
const viewEl = (id) => { const s = viewSlide(); return s ? s.elements.find(e => e.id === id) : null; };

function dragMove(e, p0) {
  const start = selectedMaps().filter(m => !m.get('locked') && !m.get('hidden'))
    .map(m => ({ id: m.get('id'), x: m.get('x'), y: m.get('y'), w: m.get('w'), h: m.get('h') }));
  if (!start.length) return;
  const bx = Math.min(...start.map(s => s.x)), by = Math.min(...start.map(s => s.y));
  const bw = Math.max(...start.map(s => s.x + s.w)) - bx, bh = Math.max(...start.map(s => s.y + s.h)) - by;
  const targets = snapTargets(E.sel);
  let moved = false, last = 0;
  track(e, (ev) => {
    const p = toSlide(ev);
    let dx = p.x - p0.x, dy = p.y - p0.y;
    if (!moved) {
      if (Math.hypot(dx * E.scale, dy * E.scale) < 3) return;
      moved = true; startGesture();
    }
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    E.guides = [];
    if (!ev.altKey) {
      const tol = SNAP_PX / E.scale;
      const sx = snapAxis([bx + dx, bx + dx + bw / 2, bx + dx + bw], targets.xs, tol);
      const sy = snapAxis([by + dy, by + dy + bh / 2, by + dy + bh], targets.ys, tol);
      if (sx) { dx += sx.d; E.guides.push({ x: sx.at }); }
      if (sy) { dy += sy.d; E.guides.push({ y: sy.at }); }
    }
    for (const s of start) E.drag.set(s.id, { x: Math.round(s.x + dx), y: Math.round(s.y + dy) });
    paintStage();
    const now = performance.now();
    if (now - last > 90) { last = now; commitGesture(); }
  }, () => { if (moved) endGesture(); });
}

const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
function dragResize(e, m, h) {
  const [hx, hy] = HANDLES[h];
  const id = m.get('id');
  const s0 = { x: m.get('x'), y: m.get('y'), w: m.get('w'), h: m.get('h'), rot: m.get('rot') || 0 };
  const ratio = s0.w / s0.h;
  const keepRatio = m.get('type') === 'image' || (m.get('type') === 'shape' && m.get('shape') === 'ellipse');
  const p0 = toSlide(e);
  const rad = s0.rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const minH = m.get('type') === 'shape' && m.get('shape') === 'line' ? 8 : MIN_SIZE;
  let last = 0;
  startGesture();
  track(e, (ev) => {
    const p = toSlide(ev);
    const gx = p.x - p0.x, gy = p.y - p0.y;
    const lx = gx * cos + gy * sin, ly = -gx * sin + gy * cos;
    let w = Math.max(MIN_SIZE, s0.w + hx * lx), hh = Math.max(minH, s0.h + hy * ly);
    if (hx && hy && (keepRatio !== ev.shiftKey)) {
      if (Math.abs(w / s0.w) > Math.abs(hh / s0.h)) hh = w / ratio; else w = hh * ratio;
    }
    if (!hx) w = s0.w;
    if (!hy) hh = s0.h;
    const ox = hx * (w - s0.w) / 2, oy = hy * (hh - s0.h) / 2;
    const cx = s0.x + s0.w / 2 + ox * cos - oy * sin;
    const cy = s0.y + s0.h / 2 + ox * sin + oy * cos;
    const next = { x: Math.round(cx - w / 2), y: Math.round(cy - hh / 2), w: Math.round(w), h: Math.round(hh) };
    E.drag.set(id, next);
    paintStage({ tagId: id, tag: `${next.w} × ${next.h}` });
    const now = performance.now();
    if (now - last > 90) { last = now; commitGesture(); }
  }, () => endGesture());
}
function dragRotate(e, m) {
  const id = m.get('id');
  const cx = m.get('x') + m.get('w') / 2, cy = m.get('y') + m.get('h') / 2;
  let last = 0;
  startGesture();
  track(e, (ev) => {
    const p = toSlide(ev);
    let a = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
    if (ev.shiftKey) a = Math.round(a / 15) * 15;
    else for (const s of [0, 90, 180, 270, 360, -90]) if (Math.abs(a - s) < 4) a = s;
    a = ((a + 540) % 360) - 180;
    const rot = Math.round(a * 10) / 10;
    E.drag.set(id, { rot });
    paintStage({ tagId: id, tag: `${Math.round(rot)}°` });
    const now = performance.now();
    if (now - last > 90) { last = now; commitGesture(); }
  }, () => endGesture());
}
function dragMarquee(e, p0) {
  const box = document.createElement('div');
  box.className = 'sl-marquee';
  $('sl-ed-overlay').appendChild(box);
  // Travadas e ocultas ficam de fora, como no Figma
  const all = (viewSlide() || { elements: [] }).elements.filter(isFree);
  track(e, (ev) => {
    const p = toSlide(ev);
    const x = Math.min(p.x, p0.x), y = Math.min(p.y, p0.y), w = Math.abs(p.x - p0.x), h = Math.abs(p.y - p0.y);
    const s = E.scale;
    Object.assign(box.style, { left: x * s + 'px', top: y * s + 'px', width: w * s + 'px', height: h * s + 'px' });
    E.sel = expandToGroups(all.filter(r => r.x < x + w && r.x + r.w > x && r.y < y + h && r.y + r.h > y).map(r => r.id));
    renderOverlay({ keep: box });
    paintLayerState();
  }, () => { box.remove(); E.layerAnchor = null; selChanged(); });
}

/* Caixas de seleção (minhas, de quem está no mesmo slide e a de passar o mouse) */
function renderOverlay(extra = {}) {
  if (!E) return;
  const ov = $('sl-ed-overlay'); if (!ov) return;
  const s = E.scale;
  ov.querySelectorAll(':scope > :not(.sl-marquee)').forEach(n => n.remove());
  const slide = viewSlide();
  if (!slide) return;
  const byId = new Map(slide.elements.map(el => [el.id, el]));
  const frag = document.createDocumentFragment();
  const boxFor = (r, cls) => {
    const b = document.createElement('div');
    b.className = 'sl-box ' + cls;
    Object.assign(b.style, { left: r.x * s + 'px', top: r.y * s + 'px', width: r.w * s + 'px', height: r.h * s + 'px', transform: r.rot ? `rotate(${r.rot}deg)` : '' });
    return b;
  };
  // Outras pessoas
  for (const st of remoteStates()) {
    if (!st.sel || st.sel.slide !== E.slideId) continue;
    for (const id of st.sel.ids || []) {
      const r = byId.get(id); if (!r || r.hidden) continue;
      const b = boxFor(r, 'is-remote');
      b.style.setProperty('--pc', st.user.color);
      b.innerHTML = `<span class="sl-box-name">${esc(st.user.name.split(' ')[0])}</span>`;
      frag.appendChild(b);
    }
  }
  // Passar o mouse (no slide ou na lista de camadas)
  // Grupo: uma caixa em volta de todos (mouse em cima ou grupo selecionado)
  const bbox = (ids) => {
    const rs = ids.map(id => byId.get(id)).filter(r => r && !r.hidden);
    if (!rs.length) return null;
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
    return { x: x0, y: y0, w: Math.max(...rs.map(r => r.x + r.w)) - x0, h: Math.max(...rs.map(r => r.y + r.h)) - y0 };
  };
  if (E.hoverId && String(E.hoverId).startsWith('g:') && !E.drag) {
    const ids = groupMembersIds(E.hoverId.slice(2));
    const r = !ids.every(id => E.sel.has(id)) && bbox(ids);
    if (r) {
      const b = boxFor(r, 'is-hover-group');
      const g = viewGroups().get(E.hoverId.slice(2));
      if (g) b.innerHTML = `<span class="sl-group-tag is-ghost">${icon('group', 11)}<span>${esc(g.name)}</span></span>`;
      frag.appendChild(b);
    }
  }
  const sg = selectedGroup();
  if (sg) {
    const r = bbox(groupMembersIds(sg));
    if (r) {
      const b = boxFor(r, 'is-group');
      const g = viewGroups().get(sg);
      b.innerHTML = `<span class="sl-group-tag" data-group-tag="${esc(sg)}" title="Duplo clique pra renomear">${icon('group', 11)}<span>${esc(g ? g.name : 'Grupo')}</span></span>`;
      frag.appendChild(b);
    }
  }
  if (E.hoverId && !E.sel.has(E.hoverId) && !E.drag) {
    const r = byId.get(E.hoverId);
    if (r && !r.hidden) frag.appendChild(boxFor(r, 'is-hover'));
  }
  // Minha seleção
  const ids = [...E.sel];
  for (const id of ids) {
    const r = byId.get(id); if (!r || r.hidden) continue;
    const b = boxFor(r, 'is-mine' + (id === E.editingId ? ' is-editing' : '') + (r.locked ? ' is-locked' : ''));
    b.dataset.box = id;
    if (ids.length === 1 && editable() && id !== E.editingId && !r.locked) {
      const isLine = r.type === 'shape' && r.shape === 'line';
      const hs = isLine ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      b.innerHTML = hs.map(h => `<span class="sl-h sl-h-${h}" data-handle="${h}"></span>`).join('') + '<span class="sl-h-rotline"></span><span class="sl-h sl-h-rot" data-handle="rot" title="Girar (Shift: de 15 em 15°)"></span>';
    }
    if (extra.tagId === id && extra.tag) b.insertAdjacentHTML('beforeend', `<span class="sl-box-tag" style="transform:translateX(-50%) rotate(${-(r.rot || 0)}deg)">${esc(extra.tag)}</span>`);
    frag.appendChild(b);
  }
  // Guias de alinhamento
  for (const g of E.guides) {
    const l = document.createElement('div');
    l.className = 'sl-guide ' + (g.x !== undefined ? 'is-v' : 'is-h');
    if (g.x !== undefined) l.style.left = g.x * s + 'px'; else l.style.top = g.y * s + 'px';
    frag.appendChild(l);
  }
  ov.insertBefore(frag, extra.keep || null);
  drawRulers();
}

function setHover(id) {
  if (!E || E.hoverId === id) return;
  E.hoverId = id;
  renderOverlay();
  paintLayerState();
}

/* ── Camadas (painel da direita, como no Figma) ──────────────── */
function layerName(el) {
  if (el.name) return el.name;
  if (el.type === 'text') {
    const t = (el.text || '').trim().split('\n')[0].trim();
    return t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : 'Texto';
  }
  if (el.type === 'image') return 'Imagem';
  return { rect: 'Retângulo', ellipse: 'Elipse', line: 'Linha' }[el.shape || 'rect'] || 'Forma';
}
function layerIcon(el) {
  if (el.type === 'text') return 'type';
  if (el.type === 'image') return 'image';
  return { rect: 'square', ellipse: 'circle', line: 'line' }[el.shape || 'rect'] || 'square';
}
/* Ordem de cima pra baixo, como a lista mostra */
const layerOrder = () => (viewSlide() || { elements: [] }).elements.map(e => e.id).reverse();

/* ── Grupos ──────────────────────────────────────────────────────
   Cada slide guarda seus grupos ({ id, name }) e cada elemento aponta pro
   seu (groupId). Os membros ficam juntos na ordem das camadas. Clicar no
   slide pega o grupo inteiro; duplo clique entra no grupo e pega só um. */
const viewGroups = () => new Map(((viewSlide() || {}).groups || []).map(g => [g.id, g]));
const hasGroup = (gid) => !!gid && viewGroups().has(gid);
function groupMembersIds(gid) {
  const s = viewSlide(); if (!s || !gid) return [];
  return s.elements.filter(e => e.groupId === gid).map(e => e.id).reverse();
}
/* Clique no slide: o grupo inteiro, a não ser que esteja "dentro" dele */
function unitOf(id) {
  const el = viewEl(id);
  if (el && el.groupId && hasGroup(el.groupId) && E.enteredGroup !== el.groupId) return groupMembersIds(el.groupId);
  return [id];
}
function expandToGroups(ids) {
  const out = new Set();
  for (const id of ids) for (const u of unitOf(id)) out.add(u);
  return out;
}
/* Seleção é exatamente um grupo? (pra caixa do grupo e o Desagrupar) */
function selectedGroup() {
  const s = viewSlide(); if (!s || E.sel.size < 1) return null;
  const gids = new Set(s.elements.filter(e => E.sel.has(e.id)).map(e => e.groupId || ''));
  if (gids.size !== 1) return null;
  const gid = [...gids][0];
  if (!gid || !hasGroup(gid)) return null;
  const members = groupMembersIds(gid);
  return members.length === E.sel.size ? gid : null;
}
function nextGroupName(groups) {
  let n = 0;
  for (const g of groups) { const m = /^Grupo (\d+)$/.exec(g.name || ''); if (m) n = Math.max(n, Number(m[1])); }
  return 'Grupo ' + (n + 1);
}
/* Reescreve os elementos do slide (ordem e grupos) num passo só do desfazer */
function rewriteElements(fn) {
  const sm = curSlide(); if (!sm) return false;
  const arr = sm.get('elements');
  const all = arr.toArray().map(m => m.toJSON());
  const res = fn(all, (sm.get('groups') || []).slice());
  if (!res) return false;
  const used = new Set(res.els.map(e => e.groupId).filter(Boolean));
  const groups = res.groups.filter(g => used.has(g.id));
  for (const e of res.els) if (e.groupId && !groups.some(g => g.id === e.groupId)) delete e.groupId;
  change(() => { arr.delete(0, arr.length); arr.push(res.els.map(yEl)); sm.set('groups', groups); });
  endStep();
  return true;
}
/* Nova ordem (de cima pra baixo) e, se vier, novo grupo de alguns elementos */
function applyOrder(topFirst, groupChange) {
  rewriteElements((all, groups) => {
    const byId = new Map(all.map(e => [e.id, e]));
    const els = topFirst.slice().reverse().map(id => byId.get(id)).filter(Boolean).map(e => ({ ...e }));
    if (els.length !== all.length) return null;
    let changed = els.some((e, i) => e.id !== all[i].id);
    if (groupChange) for (const e of els) {
      if (!groupChange.has(e.id)) continue;
      const g = groupChange.get(e.id) || undefined;
      if ((e.groupId || undefined) !== g) { changed = true; if (g) e.groupId = g; else delete e.groupId; }
    }
    return changed ? { els, groups } : null;
  });
}
function groupSelection() {
  if (!editable()) return;
  const order = layerOrder();
  const ids = order.filter(id => E.sel.has(id));
  if (ids.length < 2) { toast('Selecione duas ou mais camadas pra agrupar.'); return; }
  const gid = rid();
  const at = order.slice(0, order.indexOf(ids[0])).filter(id => !E.sel.has(id)).length;
  const next = order.filter(id => !E.sel.has(id));
  next.splice(at, 0, ...ids);
  rewriteElements((all, groups) => {
    const byId = new Map(all.map(e => [e.id, e]));
    const els = next.slice().reverse().map(id => ({ ...byId.get(id) }));
    for (const e of els) if (E.sel.has(e.id)) e.groupId = gid;
    return { els, groups: [...groups, { id: gid, name: nextGroupName(groups) }] };
  });
  E.enteredGroup = null;
  E.closedGroups.delete(gid);
  selChanged();
}
function ungroupSelection() {
  if (!editable()) return;
  const s = viewSlide(); if (!s) return;
  const gids = new Set(s.elements.filter(e => E.sel.has(e.id) && e.groupId).map(e => e.groupId));
  if (!gids.size) { toast('Nada agrupado na seleção.'); return; }
  rewriteElements((all, groups) => ({
    els: all.map(e => { if (!gids.has(e.groupId)) return e; const c = { ...e }; delete c.groupId; return c; }),
    groups: groups.filter(g => !gids.has(g.id))
  }));
  E.enteredGroup = null;
  selChanged();
}

function renderLayers() {
  const box = $('sl-layers'); if (!box || !E) return;
  if (E.layerDrag || E.renaming) return;
  const slide = viewSlide(); if (!slide) return;
  const groups = new Map((slide.groups || []).map(g => [g.id, g]));
  const els = slide.elements.slice().reverse();
  $('sl-layers-count').textContent = els.length ? String(els.length) : '';
  if (!els.length) {
    box.dataset.html = '';
    box.innerHTML = '<div class="sl-layers-empty">Nada neste slide ainda. Use Texto, Imagem ou Forma na barra de cima.</div>';
    paintLayerTools();
    return;
  }
  const remote = new Map();
  for (const st of remoteStates()) if (st.sel && st.sel.slide === E.slideId) for (const id of st.sel.ids || []) remote.set(id, st.user);
  const ro = !editable();
  const btns = (locked, hidden, name) => `
      <button type="button" class="sl-layer-btn${locked ? ' is-on' : ''}" data-lact="lock" title="${locked ? 'Destravar' : 'Travar'}" aria-label="${locked ? 'Destravar' : 'Travar'} ${esc(name)}" aria-pressed="${!!locked}" ${ro ? 'disabled' : ''}>${icon(locked ? 'lock' : 'unlock', 13)}</button>
      <button type="button" class="sl-layer-btn${hidden ? ' is-on' : ''}" data-lact="eye" title="${hidden ? 'Mostrar' : 'Ocultar'}" aria-label="${hidden ? 'Mostrar' : 'Ocultar'} ${esc(name)}" aria-pressed="${!!hidden}" ${ro ? 'disabled' : ''}>${icon(hidden ? 'eyeOff' : 'eye', 13)}</button>`;
  const rowEl = (el, parent) => {
    const who = remote.get(el.id);
    const name = layerName(el);
    return `<div class="sl-layer${parent ? ' is-child' : ''}" data-id="${esc(el.id)}"${parent ? ` data-parent="${esc(parent)}"` : ''} role="treeitem" ${ro ? '' : 'draggable="true"'}>
      <span class="sl-layer-ic">${icon(layerIcon(el), 14)}</span>
      <span class="sl-layer-name${el.name ? '' : ' is-auto'}" title="${esc(name)}">${esc(name)}</span>
      ${who ? `<span class="sl-layer-who" style="background:${esc(who.color)}" title="${esc(who.name)} selecionou"></span>` : ''}
      ${btns(el.locked, el.hidden, name)}
    </div>`;
  };
  const rowGroup = (g, members) => {
    const open = !E.closedGroups.has(g.id);
    return `<div class="sl-layer is-group" data-gid="${esc(g.id)}" role="treeitem" aria-expanded="${open}" ${ro ? '' : 'draggable="true"'}>
      <button type="button" class="sl-layer-fold" data-lact="fold" aria-expanded="${open}" title="${open ? 'Fechar o grupo' : 'Abrir o grupo'}" aria-label="${open ? 'Fechar' : 'Abrir'} ${esc(g.name)}">${icon('down', 12)}</button>
      <span class="sl-layer-ic">${icon('group', 14)}</span>
      <span class="sl-layer-name" title="${esc(g.name)} · ${members.length} camadas">${esc(g.name)}</span>
      ${btns(members.every(m => m.locked), members.every(m => m.hidden), g.name)}
    </div>`;
  };
  let html = '';
  const seen = new Set();
  for (const el of els) {
    const g = el.groupId && groups.get(el.groupId);
    if (g) {
      if (!seen.has(g.id)) { seen.add(g.id); html += rowGroup(g, els.filter(e => e.groupId === g.id)); }
      if (!E.closedGroups.has(g.id)) html += rowEl(el, g.id);
    } else html += rowEl(el, null);
  }
  // Lista igual à de antes: só atualiza o destaque. Refazer as linhas a cada
  // clique quebrava o duplo clique (o segundo clique caía numa linha nova).
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  paintLayerState();
}
/* Só as classes (seleção, mouse, oculta, travada) — barato, roda no arraste */
function paintLayerState() {
  const box = $('sl-layers'); if (!box || !E) return;
  const slide = viewSlide(); if (!slide) return;
  const byId = new Map(slide.elements.map(e => [e.id, e]));
  box.querySelectorAll('.sl-layer[data-id]').forEach(row => {
    const el = byId.get(row.dataset.id); if (!el) return;
    const sel = E.sel.has(el.id);
    row.classList.toggle('is-sel', sel);
    row.classList.toggle('is-hover', E.hoverId === el.id);
    row.classList.toggle('is-hidden', !!el.hidden);
    row.classList.toggle('is-locked', !!el.locked);
    row.setAttribute('aria-selected', sel ? 'true' : 'false');
  });
  box.querySelectorAll('.sl-layer[data-gid]').forEach(row => {
    const gid = row.dataset.gid;
    const members = slide.elements.filter(e => e.groupId === gid);
    const sel = members.length && members.every(m => E.sel.has(m.id));
    row.classList.toggle('is-sel', !!sel);
    row.classList.toggle('is-hover', E.hoverId === 'g:' + gid);
    row.classList.toggle('is-hidden', members.every(m => m.hidden));
    row.classList.toggle('is-locked', members.every(m => m.locked));
    row.setAttribute('aria-selected', sel ? 'true' : 'false');
  });
  const act = box.querySelector('.sl-layer.is-sel');
  if (act && E.scrollLayer) { act.scrollIntoView({ block: 'nearest' }); E.scrollLayer = false; }
  paintLayerTools();
}
function paintLayerTools() {
  const g = $('sl-ltool-group'), u = $('sl-ltool-ungroup'); if (!g || !u || !E) return;
  const s = viewSlide();
  const ro = !editable();
  g.disabled = ro || E.sel.size < 2 || !!selectedGroup();
  u.disabled = ro || !(s && s.elements.some(e => E.sel.has(e.id) && e.groupId && hasGroup(e.groupId)));
}

/* Uma posição pra cima/baixo, mantendo a seleção junta */
function stepOrder(dir) {
  if (!E.sel.size) return;
  const order = layerOrder();
  const idx = order.map((id, i) => (E.sel.has(id) ? i : -1)).filter(i => i >= 0);
  if (dir === 'up') {
    if (idx[0] === 0) return;
    for (const i of idx) [order[i - 1], order[i]] = [order[i], order[i - 1]];
  } else {
    if (idx[idx.length - 1] === order.length - 1) return;
    for (const i of idx.reverse()) [order[i + 1], order[i]] = [order[i], order[i + 1]];
  }
  applyOrder(order);
}
function toggleLayerProp(ids, prop) {
  const sm = curSlide(); if (!sm || !ids.length) return;
  const maps = ids.map(id => elM(sm, id)).filter(Boolean);
  const on = !maps.every(m => m.get(prop));
  change(() => { for (const m of maps) m.set(prop, on); });
  endStep();
  if (prop === 'hidden' && on && maps.some(m => m.get('id') === E.editingId)) stopEditing();
}

function bindLayers() {
  const box = $('sl-layers');
  $('sl-ltool-group').addEventListener('click', groupSelection);
  $('sl-ltool-ungroup').addEventListener('click', ungroupSelection);
  // A área de cima (Posição, Slide, Guias) muda de altura com a seleção.
  // Enquanto o mouse está no painel, ela segura a altura pra lista não pular.
  const props = $('sl-side-props'), side = $('sl-ed-side');
  const holdProps = () => { if (!props.style.minHeight) props.style.minHeight = props.offsetHeight + 'px'; };
  side.addEventListener('mouseleave', () => { props.style.minHeight = ''; });
  box.addEventListener('pointerdown', holdProps);
  box.addEventListener('click', (e) => {
    if (!E) return;
    const row = e.target.closest('.sl-layer');
    if (!row) { if (e.target === box && E.sel.size) { E.sel.clear(); E.enteredGroup = null; selChanged(); } return; }
    const btn = e.target.closest('[data-lact]');
    const gid = row.dataset.gid;
    if (gid) {
      const members = groupMembersIds(gid);
      if (btn && btn.dataset.lact === 'fold') {
        if (E.closedGroups.has(gid)) E.closedGroups.delete(gid); else E.closedGroups.add(gid);
        renderLayers();
        return;
      }
      if (btn) { if (editable()) toggleLayerProp(members, btn.dataset.lact === 'eye' ? 'hidden' : 'locked'); return; }
      stopEditing();
      E.enteredGroup = null;
      if (e.ctrlKey || e.metaKey) {
        const all = members.every(id => E.sel.has(id));
        for (const id of members) { if (all) E.sel.delete(id); else E.sel.add(id); }
      } else E.sel = new Set(members);
      E.layerAnchor = members[0];
      selChanged();
      return;
    }
    const id = row.dataset.id;
    if (btn) {
      if (!editable()) return;
      // Ícone numa camada selecionada vale pra seleção inteira
      const ids = E.sel.has(id) ? [...E.sel] : [id];
      toggleLayerProp(ids, btn.dataset.lact === 'eye' ? 'hidden' : 'locked');
      return;
    }
    if (e.target.closest('input')) return;
    stopEditing();
    // Clicar numa camada de dentro do grupo "entra" no grupo
    E.enteredGroup = row.dataset.parent || null;
    const order = layerOrder();
    if (e.shiftKey && E.layerAnchor && order.includes(E.layerAnchor)) {
      const a = order.indexOf(E.layerAnchor), b = order.indexOf(id);
      E.sel = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) {
      if (E.sel.has(id)) E.sel.delete(id); else E.sel.add(id);
      E.layerAnchor = id;
    } else {
      E.sel = new Set([id]);
      E.layerAnchor = id;
    }
    selChanged();
  });
  // Duplo clique em qualquer ponto da linha (fora dos botões) renomeia
  box.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.sl-layer');
    if (!row || !editable() || e.target.closest('[data-lact], input')) return;
    const name = row.querySelector('.sl-layer-name'); if (!name) return;
    e.preventDefault();
    if (row.dataset.gid) renameGroup(row.dataset.gid, name);
    else renameLayer(row.dataset.id, name);
  });
  box.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.sl-layer');
    setHover(row ? (row.dataset.gid ? 'g:' + row.dataset.gid : row.dataset.id) : null);
  });
  box.addEventListener('mouseleave', () => setHover(null));
  // Arrastar: muda a ordem e entra/sai de grupos (a seleção vai junto)
  let dragIds = null, dragGroup = null;
  const clear = () => box.querySelectorAll('.drop-before,.drop-after,.drop-into,.is-dragging').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into', 'is-dragging'));
  /* Onde solta: { targetId, after, join } — join = grupo que os itens passam a ter */
  const placement = (row, clientY) => {
    const r = row.getBoundingClientRect();
    const after = clientY > r.top + r.height / 2;
    const gid = row.dataset.gid;
    if (gid) {
      const members = groupMembersIds(gid);
      if (!members.length) return null;
      if (after && !dragGroup && !E.closedGroups.has(gid)) return { targetId: members[0], after: false, join: gid, into: true };
      return after ? { targetId: members[members.length - 1], after: true, join: null } : { targetId: members[0], after: false, join: null };
    }
    let join = row.dataset.parent || null;
    let targetId = row.dataset.id;
    if (dragGroup && join) {
      // Grupo não entra em grupo: vai pra borda do grupo de destino
      const members = groupMembersIds(join);
      targetId = after ? members[members.length - 1] : members[0];
      join = null;
    }
    return { targetId, after, join };
  };
  box.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.sl-layer');
    if (!row || !editable() || E.renaming) { e.preventDefault(); return; }
    if (row.dataset.gid) {
      dragGroup = row.dataset.gid;
      dragIds = groupMembersIds(dragGroup);
      E.sel = new Set(dragIds);
    } else {
      dragGroup = null;
      const id = row.dataset.id;
      if (!E.sel.has(id)) { E.sel = new Set([id]); E.layerAnchor = id; }
      dragIds = layerOrder().filter(x => E.sel.has(x));
    }
    // Marca o arraste antes de repintar: a lista não pode ser refeita agora
    // (a linha arrastada sumiria e o navegador cancelaria o arraste)
    E.layerDrag = true;
    selChanged();
    paintLayerState();
    requestAnimationFrame(() => box.querySelectorAll('.sl-layer').forEach(r => {
      if ((r.dataset.id && E.sel.has(r.dataset.id)) || (dragGroup && r.dataset.gid === dragGroup)) r.classList.add('is-dragging');
    }));
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragIds[0] || ''); } catch {}
  });
  box.addEventListener('dragover', (e) => {
    if (!dragIds) return;
    const row = e.target.closest('.sl-layer'); if (!row) return;
    e.preventDefault();
    const p = placement(row, e.clientY);
    box.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
    if (!p) return;
    if (p.into) row.classList.add('drop-into');
    else row.classList.add(e.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 'drop-after' : 'drop-before');
  });
  box.addEventListener('drop', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    const row = e.target.closest('.sl-layer');
    const p = row && placement(row, e.clientY);
    E.layerDrag = false;
    if (p && !dragIds.includes(p.targetId)) {
      const rest = layerOrder().filter(x => !dragIds.includes(x));
      rest.splice(rest.indexOf(p.targetId) + (p.after ? 1 : 0), 0, ...dragIds);
      applyOrder(rest, dragGroup ? null : new Map(dragIds.map(id => [id, p.join])));
      if (p.join) E.closedGroups.delete(p.join);
    } else if (p && !dragGroup && dragIds.includes(p.targetId)) {
      // Soltou em cima de si mesmo, mas trocando de grupo (ex.: tirar do grupo)
      applyOrder(layerOrder(), new Map(dragIds.map(id => [id, p.join])));
    }
    clear(); dragIds = null; dragGroup = null; renderAll();
  });
  box.addEventListener('dragend', () => { clear(); dragIds = null; dragGroup = null; if (E) { E.layerDrag = false; renderAll(); } });
}

function renameGroup(gid, nameEl) {
  const g = viewGroups().get(gid); if (!g) return;
  E.renaming = true;
  $('sl-layers').dataset.html = ''; // a linha muda: refaz a lista no fim
  const inp = document.createElement('input');
  inp.className = 'sl-layer-input';
  inp.value = g.name;
  inp.maxLength = 80;
  inp.setAttribute('aria-label', 'Nome do grupo');
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    E.renaming = false;
    const v = inp.value.trim();
    const sm = curSlide();
    if (save && v && sm) {
      change(() => sm.set('groups', (sm.get('groups') || []).map(x => (x.id === gid ? { ...x, name: v } : x))));
      endStep();
    }
    renderAll();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}

function renameLayer(id, nameEl) {
  const el = viewEl(id); if (!el) return;
  E.renaming = true;
  $('sl-layers').dataset.html = ''; // a linha muda: refaz a lista no fim
  const inp = document.createElement('input');
  inp.className = 'sl-layer-input';
  inp.value = layerName(el);
  inp.maxLength = 80;
  inp.setAttribute('aria-label', 'Nome da camada');
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    E.renaming = false;
    if (save) {
      const v = inp.value.trim();
      const m = elM(curSlide(), id);
      // Nome vazio (ou igual ao automático) volta pro nome automático
      const auto = layerName({ ...el, name: null });
      if (m) { change(() => m.set('name', v && v !== auto ? v : null)); endStep(); }
    }
    renderAll();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}

/* Posição e tamanho (X, Y, L, A, giro) — digitar ou arrastar o rótulo */
const GEO = [
  { k: 'x', label: 'X', title: 'Posição horizontal' },
  { k: 'y', label: 'Y', title: 'Posição vertical' },
  { k: 'w', label: 'L', title: 'Largura' },
  { k: 'h', label: 'A', title: 'Altura' },
  { k: 'rot', label: '°', title: 'Rotação' }
];
function geoClamp(k, v) {
  v = Math.round(Number(v));
  if (!Number.isFinite(v)) return null;
  if (k === 'w' || k === 'h') return Math.max(k === 'h' ? 4 : MIN_SIZE, Math.min(16000, v));
  if (k === 'rot') return ((v % 360) + 540) % 360 - 180;
  return Math.max(-16000, Math.min(16000, v));
}
function syncGeo() {
  const box = $('sl-geo'); if (!box || !E) return;
  const one = E.sel.size === 1 ? viewEl([...E.sel][0]) : null;
  box.hidden = !one;
  if (!one) return;
  const lock = !editable() || one.locked;
  box.classList.toggle('is-locked', !!one.locked);
  $('sl-geo-lock').hidden = !one.locked;
  box.querySelectorAll('input[data-k]').forEach(inp => {
    const k = inp.dataset.k;
    if (document.activeElement !== inp) inp.value = Math.round(one[k] || 0);
    inp.disabled = lock;
  });
}
function bindGeo() {
  const box = $('sl-geo');
  const commit = (k, raw) => {
    const id = [...E.sel][0]; const m = id && elM(curSlide(), id);
    const v = geoClamp(k, raw);
    if (!m || v === null || m.get('locked')) { syncGeo(); return; }
    change(() => m.set(k, v)); endStep();
  };
  box.addEventListener('change', (e) => { const k = e.target.dataset.k; if (k) commit(k, e.target.value); });
  box.addEventListener('keydown', (e) => {
    if (e.target.tagName !== 'INPUT') return;
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); syncGeo(); e.target.blur(); }
  });
  // Arrastar o rótulo pros lados muda o valor (Shift: de 10 em 10)
  box.addEventListener('pointerdown', (e) => {
    const lab = e.target.closest('[data-scrub]'); if (!lab || !E || E.sel.size !== 1 || !editable()) return;
    const id = [...E.sel][0]; const m = elM(curSlide(), id);
    if (!m || m.get('locked')) return;
    e.preventDefault();
    const k = lab.dataset.scrub, v0 = m.get(k) || 0, x0 = e.clientX;
    let last = 0;
    startGesture();
    document.body.classList.add('sl-scrubbing');
    track(e, (ev) => {
      const v = geoClamp(k, v0 + (ev.clientX - x0) * (ev.shiftKey ? 10 : 1));
      if (v === null) return;
      E.drag.set(id, { [k]: v });
      paintStage();
      const now = performance.now();
      if (now - last > 90) { last = now; commitGesture(); }
    }, () => { document.body.classList.remove('sl-scrubbing'); endGesture(); });
  });
}

/* ── Barra de ferramentas ────────────────────────────────────── */
function selChanged() { updateAwareness(); renderAll(); }

function tbBtn(act, ic, title, extra = '') {
  return `<button type="button" class="sl-tb-btn" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon(ic, 16)}</button>`;
}
function colorBtn(act, title, kind) {
  return `<button type="button" class="sl-tb-btn sl-tb-color" data-act="${act}" data-kind="${kind}" title="${esc(title)}" aria-label="${esc(title)}"><span class="sl-tb-color-ic">${kind === 'text' ? '<b>A</b>' : kind === 'stroke' ? icon('square', 15) : kind === 'line' ? icon('line', 15) : '<span class="sl-tb-bucket"></span>'}</span><span class="sl-tb-swatch"></span></button>`;
}
function syncToolbar() {
  if (!E) return;
  const tb = $('sl-ed-toolbar'); if (!tb) return;
  const maps = selectedMaps();
  const types = [...new Set(maps.map(m => m.get('type') === 'shape' ? (m.get('shape') === 'line' ? 'line' : 'shape') : m.get('type')))];
  const kind = !maps.length ? 'none' : types.length === 1 ? types[0] : 'mixed';
  const sig = kind + '|' + maps.length + '|' + editable();
  if (tb.dataset.sig !== sig) { tb.dataset.sig = sig; buildToolbar(tb, kind, maps.length); }
  const ro = !editable();
  const u = tb.querySelector('[data-act="undo"]'); if (u) u.disabled = ro || !E.undo.undoStack.length;
  const r = tb.querySelector('[data-act="redo"]'); if (r) r.disabled = ro || !E.undo.redoStack.length;
  syncToolbarValues(tb, maps, kind);
}
function buildToolbar(tb, kind) {
  const ro = !editable();
  let html = `<div class="sl-tb-group">
      ${tbBtn('undo', 'undo', 'Desfazer (Ctrl+Z)')}
      ${tbBtn('redo', 'redo', 'Refazer (Ctrl+Shift+Z)')}
    </div><span class="sl-tb-sep"></span>
    <div class="sl-tb-group">
      <button type="button" class="sl-tb-btn sl-tb-labeled" data-act="text" title="Caixa de texto" ${ro ? 'disabled' : ''}>${icon('type', 16)}<span>Texto</span></button>
      <button type="button" class="sl-tb-btn sl-tb-labeled" data-act="image" title="Imagem (também dá pra colar ou arrastar)" ${ro ? 'disabled' : ''}>${icon('image', 16)}<span>Imagem</span></button>
      <button type="button" class="sl-tb-btn sl-tb-labeled" data-act="shape" title="Forma" ${ro ? 'disabled' : ''}>${icon('shapes', 16)}<span>Forma</span>${icon('down', 12)}</button>
    </div><span class="sl-tb-sep"></span>`;
  if (ro) html += '<span class="sl-tb-hint">Só leitura até conectar</span>';
  else if (kind === 'none') {
    html += `<div class="sl-tb-group">${colorBtn('bg', 'Fundo do slide', 'bg')}<span class="sl-tb-label">Fundo do slide</span></div>
      <span class="sl-tb-hint">Clique num elemento pra editar · arraste no fundo pra selecionar vários</span>`;
  } else {
    if (kind === 'text') {
      html += `<div class="sl-tb-group">
        <select class="sl-tb-select" data-act="font" title="Fonte" aria-label="Fonte">
          <option value="">Fonte do tema</option>
          <optgroup label="Padrão">${Object.keys(FONT_LABELS).map(k => `<option value="${k}" style="font-family:${esc(FONT_STACKS[k])}">${FONT_LABELS[k]}</option>`).join('')}</optgroup>
          ${deckFonts().length ? `<optgroup label="Desta apresentação">${deckFonts().map(f => `<option value="f:${esc(f.id)}" style="font-family:${esc(fontStack('f:' + f.id))}">${esc(f.family)}</option>`).join('')}</optgroup>` : ''}
          <option value="__add">+ Adicionar fonte…</option>
        </select>
        <div class="sl-tb-size">
          <button type="button" class="sl-tb-btn sl-tb-mini" data-act="size-" title="Diminuir fonte" aria-label="Diminuir fonte">−</button>
          <input type="number" class="sl-tb-num" data-act="size" min="8" max="400" title="Tamanho da fonte" aria-label="Tamanho da fonte">
          <button type="button" class="sl-tb-btn sl-tb-mini" data-act="size+" title="Aumentar fonte" aria-label="Aumentar fonte">+</button>
        </div>
      </div><span class="sl-tb-sep"></span>
      <div class="sl-tb-group">
        ${tbBtn('bold', 'bold', 'Negrito (Ctrl+B)')}${tbBtn('italic', 'italic', 'Itálico (Ctrl+I)')}${tbBtn('underline', 'underline', 'Sublinhado (Ctrl+U)')}
        ${colorBtn('color', 'Cor do texto', 'text')}${colorBtn('tfill', 'Fundo da caixa', 'fill')}
      </div><span class="sl-tb-sep"></span>
      <div class="sl-tb-group">
        ${tbBtn('align-left', 'alignLeft', 'Alinhar à esquerda')}${tbBtn('align-center', 'alignCenter', 'Centralizar')}${tbBtn('align-right', 'alignRight', 'Alinhar à direita')}
      </div><span class="sl-tb-sep"></span>
      <div class="sl-tb-group">
        ${tbBtn('valign-top', 'vTop', 'Texto no topo')}${tbBtn('valign-middle', 'vMiddle', 'Texto no meio')}${tbBtn('valign-bottom', 'vBottom', 'Texto embaixo')}
      </div><span class="sl-tb-sep"></span>`;
    } else if (kind === 'shape') {
      html += `<div class="sl-tb-group">
        ${colorBtn('fill', 'Preenchimento', 'fill')}${colorBtn('stroke', 'Cor da borda', 'stroke')}
        <select class="sl-tb-select sl-tb-select-sm" data-act="strokeW" title="Espessura da borda" aria-label="Espessura da borda">
          ${[0, 2, 4, 8, 12, 20].map(v => `<option value="${v}">${v ? 'Borda ' + v : 'Sem borda'}</option>`).join('')}
        </select>
        <label class="sl-tb-field" title="Arredondamento dos cantos"><span>Cantos</span><input type="number" class="sl-tb-num" data-act="radius" min="0" max="540" step="4"></label>
      </div><span class="sl-tb-sep"></span>`;
    } else if (kind === 'line') {
      html += `<div class="sl-tb-group">
        ${colorBtn('lcolor', 'Cor da linha', 'line')}
        <select class="sl-tb-select sl-tb-select-sm" data-act="lineW" title="Espessura" aria-label="Espessura da linha">
          ${[2, 4, 6, 10, 16, 24].map(v => `<option value="${v}">Espessura ${v}</option>`).join('')}
        </select>
      </div><span class="sl-tb-sep"></span>`;
    } else if (kind === 'image') {
      html += `<div class="sl-tb-group">
        <button type="button" class="sl-tb-btn sl-tb-labeled" data-act="replace" title="Trocar imagem">${icon('image', 16)}<span>Trocar</span></button>
        <div class="seg sl-tb-seg" role="group" aria-label="Encaixe">
          <button type="button" class="seg-btn" data-act="fit-cover" title="A imagem preenche a caixa (pode cortar)">Preencher</button>
          <button type="button" class="seg-btn" data-act="fit-contain" title="A imagem inteira aparece">Caber</button>
        </div>
        <label class="sl-tb-field" title="Arredondamento dos cantos"><span>Cantos</span><input type="number" class="sl-tb-num" data-act="radius" min="0" max="540" step="4"></label>
      </div><span class="sl-tb-sep"></span>`;
    }
    html += `<div class="sl-tb-group">
      <label class="sl-tb-field" title="Opacidade"><span>Opacidade</span><input type="range" class="sl-tb-range" data-act="opacity" min="10" max="100" step="5"></label>
    </div><span class="sl-tb-sep"></span>
    <div class="sl-tb-group">
      ${tbBtn('front', 'front', 'Trazer pra frente')}${tbBtn('back', 'back', 'Mandar pra trás')}
      ${tbBtn('dup', 'copy', 'Duplicar (Ctrl+D)')}${tbBtn('del', 'trash', 'Excluir (Delete)')}
    </div>`;
  }
  tb.innerHTML = html;
  if (!tb.dataset.bound) {
    tb.dataset.bound = '1';
    tb.addEventListener('click', onToolbarClick);
    tb.addEventListener('change', onToolbarChange);
    tb.addEventListener('input', (e) => { if (e.target.dataset.act === 'opacity') onToolbarChange(e); });
  }
}
function syncToolbarValues(tb, maps, kind) {
  const m = maps[0];
  const theme = currentTheme();
  const setOn = (act, on) => { const b = tb.querySelector(`[data-act="${act}"]`); if (b) { b.classList.toggle('is-on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  const swatch = (act, val, fallback) => {
    const b = tb.querySelector(`[data-act="${act}"] .sl-tb-swatch`); if (!b) return;
    const v = val === null || val === undefined ? fallback : val;
    b.style.background = v === NONE ? '' : v;
    b.classList.toggle('is-none', v === NONE);
    b.classList.toggle('is-theme', val === null || val === undefined);
  };
  if (kind === 'none') {
    const sm = curSlide();
    swatch('bg', sm ? sm.get('bg') : null, theme.bg);
    return;
  }
  if (!m) return;
  if (kind === 'text') {
    const f = tb.querySelector('[data-act="font"]'); if (f && document.activeElement !== f) f.value = m.get('font') || '';
    const sz = tb.querySelector('[data-act="size"]'); if (sz && document.activeElement !== sz) sz.value = m.get('fontSize') || 48;
    setOn('bold', m.get('bold')); setOn('italic', m.get('italic')); setOn('underline', m.get('underline'));
    for (const a of ['left', 'center', 'right']) setOn('align-' + a, (m.get('align') || 'left') === a);
    for (const a of ['top', 'middle', 'bottom']) setOn('valign-' + a, (m.get('valign') || 'top') === a);
    swatch('color', m.get('color'), theme.text);
    swatch('tfill', m.get('fill') || NONE, NONE);
  } else if (kind === 'shape') {
    swatch('fill', m.get('fill'), theme.accent);
    swatch('stroke', m.get('stroke'), theme.text);
    const w = tb.querySelector('[data-act="strokeW"]'); if (w) w.value = String(m.get('strokeW') || 0);
    const r = tb.querySelector('[data-act="radius"]');
    if (r) { r.value = m.get('radius') || 0; r.disabled = m.get('shape') === 'ellipse'; r.closest('.sl-tb-field').hidden = m.get('shape') === 'ellipse'; }
  } else if (kind === 'line') {
    swatch('lcolor', m.get('stroke'), theme.accent);
    const w = tb.querySelector('[data-act="lineW"]'); if (w) w.value = String(m.get('strokeW') || 6);
  } else if (kind === 'image') {
    tb.querySelectorAll('[data-act^="fit-"]').forEach(b => b.classList.toggle('is-active', b.dataset.act === 'fit-' + (m.get('fit') || 'cover')));
    const r = tb.querySelector('[data-act="radius"]'); if (r && document.activeElement !== r) r.value = m.get('radius') || 0;
  }
  const op = tb.querySelector('[data-act="opacity"]'); if (op && document.activeElement !== op) op.value = Math.round((m.get('opacity') ?? 1) * 100);
}
function onToolbarClick(e) {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled || !E) return;
  const a = b.dataset.act;
  const maps = selectedMaps();
  const m = maps[0];
  switch (a) {
    case 'undo': stopEditing(); E.undo.undo(); break;
    case 'redo': stopEditing(); E.undo.redo(); break;
    case 'text': addText(); break;
    case 'image': pickImage(); break;
    case 'replace': if (m) pickImage(m.get('id')); break;
    case 'shape': openMenu(b, [
      { label: 'Retângulo', icon: icon('square', 15), onClick: () => addShape('rect') },
      { label: 'Elipse', icon: icon('circle', 15), onClick: () => addShape('ellipse') },
      { label: 'Linha', icon: icon('line', 15), onClick: () => addShape('line') }
    ]); break;
    case 'bold': case 'italic': case 'underline': if (m) setProps({ [a]: !m.get(a) }); break;
    case 'align-left': case 'align-center': case 'align-right': setProps({ align: a.slice(6) }); break;
    case 'valign-top': case 'valign-middle': case 'valign-bottom': setProps({ valign: a.slice(7) }); break;
    case 'size-': case 'size+': {
      const steps = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 160, 200, 240, 300, 400];
      change(() => { for (const mm of maps) {
        const cur = mm.get('fontSize') || 48;
        const nx = a === 'size+' ? (steps.find(s => s > cur) || 400) : ([...steps].reverse().find(s => s < cur) || 8);
        mm.set('fontSize', nx);
      } });
      break;
    }
    case 'fit-cover': case 'fit-contain': setProps({ fit: a.slice(4) }); break;
    case 'color': colorPicker(b, m && m.get('color'), (v) => setProps({ color: v }), { themeLabel: 'Cor do tema', themeColor: currentTheme().text }); break;
    case 'tfill': colorPicker(b, m && (m.get('fill') || NONE), (v) => setProps({ fill: v === NONE ? null : v }), { allowNone: true, noTheme: true }); break;
    case 'fill': colorPicker(b, m && m.get('fill'), (v) => setProps({ fill: v }), { allowNone: true, themeLabel: 'Destaque do tema', themeColor: currentTheme().accent }); break;
    case 'stroke': colorPicker(b, m && m.get('stroke'), (v) => setProps({ stroke: v, ...(m && !m.get('strokeW') ? { strokeW: 4 } : {}) }), { themeLabel: 'Cor do texto do tema', themeColor: currentTheme().text }); break;
    case 'lcolor': colorPicker(b, m && m.get('stroke'), (v) => setProps({ stroke: v }), { themeLabel: 'Destaque do tema', themeColor: currentTheme().accent }); break;
    case 'bg': { const sm = curSlide(); colorPicker(b, sm && sm.get('bg'), (v) => { if (sm) change(() => sm.set('bg', v)); }, { themeLabel: 'Fundo do tema', themeColor: currentTheme().bg, applyAll: (v) => change(() => slidesArr().forEach(x => x.set('bg', v))) }); break; }
    case 'front': reorder('front'); break;
    case 'back': reorder('back'); break;
    case 'dup': duplicateSelected(); break;
    case 'del': deleteSelected(); break;
  }
}
function onToolbarChange(e) {
  const t = e.target; const a = t.dataset.act; if (!a || !E) return;
  if (a === 'font') {
    if (t.value === '__add') {
      const ids = [...E.sel];
      syncToolbar();
      openFonts({ onAdded: (key) => { const sm = curSlide(); const maps = ids.map(id => elM(sm, id)).filter(Boolean); if (maps.length) { setProps({ font: key }, maps); endStep(); } } });
      const m = selectedMaps()[0]; t.value = (m && m.get('font')) || '';
      return;
    }
    setProps({ font: t.value || null });
  }
  else if (a === 'size') { const v = Math.max(8, Math.min(400, Math.round(Number(t.value) || 48))); setProps({ fontSize: v }); }
  else if (a === 'strokeW') setProps({ strokeW: Number(t.value) || 0 });
  else if (a === 'lineW') setProps({ strokeW: Number(t.value) || 6 });
  else if (a === 'radius') setProps({ radius: Math.max(0, Math.min(540, Number(t.value) || 0)) });
  else if (a === 'opacity') setProps({ opacity: Math.max(0.1, Math.min(1, (Number(t.value) || 100) / 100)) });
}

/* Seletor de cor: tema, paleta curta, sem cor e personalizada. */
const PALETTE = ['#ffffff', '#f4f4f5', '#a1a1aa', '#52525b', '#27272a', '#000000', '#7a00ff', '#2563eb', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#db2777'];
function colorPicker(anchor, current, onPick, opts = {}) {
  const theme = currentTheme();
  const box = document.createElement('div');
  box.className = 'sl-colors';
  const cur = current === undefined ? null : current;
  const sw = (v, label, cls = '') => `<button type="button" class="sl-color ${cls}${(v === cur) ? ' is-on' : ''}" data-v="${v === null ? '' : esc(v)}" title="${esc(label)}" aria-label="${esc(label)}" style="${v && v !== NONE ? 'background:' + esc(v) : ''}"></button>`;
  const themeCols = [...new Set([theme.accent, theme.text, theme.bg])];
  box.innerHTML = `
    ${opts.noTheme ? '' : `<button type="button" class="sl-color-theme${cur === null ? ' is-on' : ''}" data-v=""><span class="sl-color sl-color-inline" style="background:${esc(opts.themeColor || theme.text)}"></span><span>${esc(opts.themeLabel || 'Cor do tema')}</span><span class="sl-color-theme-hint">muda junto com o tema</span></button>`}
    <div class="sl-colors-label">Cores do tema</div>
    <div class="sl-colors-grid">${themeCols.map(c => sw(c, c)).join('')}${opts.allowNone ? sw(NONE, 'Sem cor', 'is-none') : ''}</div>
    <div class="sl-colors-label">Paleta</div>
    <div class="sl-colors-grid">${PALETTE.map(c => sw(c, c)).join('')}</div>
    <label class="sl-colors-custom">${icon('pipette', 14)}<span>Personalizada</span><input type="color" value="${/^#[0-9a-f]{6}$/i.test(cur || '') ? esc(cur) : '#7a00ff'}"></label>
    ${opts.applyAll ? '<button type="button" class="btn btn-ghost btn-sm sl-colors-all">Usar em todos os slides</button>' : ''}`;
  let last = cur;
  const pick = (v) => { last = v; onPick(v); box.querySelectorAll('.is-on').forEach(n => n.classList.remove('is-on')); };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (b) { pick(b.dataset.v || null); closeMenu(); return; }
    if (e.target.closest('.sl-colors-all')) { opts.applyAll(last); closeMenu(); toast('Fundo aplicado em todos os slides.'); }
  });
  const inp = box.querySelector('input[type=color]');
  inp.addEventListener('input', () => pick(inp.value.toLowerCase()));
  openPopover(anchor, box);
}

/* ── Teclado, área de transferência ──────────────────────────── */
function typingInField(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
function onKey(e) {
  if (!E || document.querySelector('.sl-present, .sl-modal-overlay')) return;
  const mod = e.ctrlKey || e.metaKey;
  // Zoom do slide no lugar do zoom do navegador (vale até digitando)
  if (mod && !e.altKey && (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && !e.altKey && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) { e.preventDefault(); zoomStep(-1); return; }
  if (mod && !e.altKey && (e.key === '0' || e.code === 'Numpad0')) { e.preventDefault(); setZoom(1); return; }
  if (typingInField(e.target)) return;
  const k = e.key;
  if (e.shiftKey && !mod && (e.code === 'Digit1' || k === '!')) { e.preventDefault(); setZoom('fit'); return; }
  if (k === ' ' && !mod) { e.preventDefault(); if (!E.spaceDown) { E.spaceDown = true; $('sl-ed-stagewrap').classList.add('is-pan-ready'); } return; }
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (!editable()) return; stopEditing(); if (e.shiftKey) E.undo.redo(); else E.undo.undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); if (editable()) E.undo.redo(); return; }
  if (mod && k === ';') { e.preventDefault(); toggleGuides(); return; }
  if (k === 'F5' || (mod && k === 'Enter')) { e.preventDefault(); startPresent(Math.max(0, currentSlides().findIndex(s => s.id === E.slideId))); return; }
  if (!editable()) return;
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); E.sel = new Set(elsArr(curSlide()).filter(m => !m.get('locked') && !m.get('hidden')).map(m => m.get('id'))); selChanged(); return; }
  if (mod && k.toLowerCase() === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return; }
  if (mod && (k === ']' || k === '}')) { e.preventDefault(); if (e.shiftKey) reorder('front'); else stepOrder('up'); return; }
  if (mod && (k === '[' || k === '{')) { e.preventDefault(); if (e.shiftKey) reorder('back'); else stepOrder('down'); return; }
  if (mod && e.shiftKey && k.toLowerCase() === 'h' && E.sel.size) { e.preventDefault(); toggleLayerProp([...E.sel], 'hidden'); return; }
  if (mod && e.shiftKey && k.toLowerCase() === 'l' && E.sel.size) { e.preventDefault(); toggleLayerProp([...E.sel], 'locked'); return; }
  if (mod && k.toLowerCase() === 'd') { e.preventDefault(); if (E.sel.size) duplicateSelected(); else duplicateSlide(E.slideId); return; }
  if (k === 'Escape') { if (E.sel.size) { E.sel.clear(); E.enteredGroup = null; selChanged(); } return; }
  if (k === 'F2') { e.preventDefault(); renameSelected(); return; }
  if ((k === 'Delete' || k === 'Backspace') && E.sel.size) { e.preventDefault(); deleteSelected(); return; }
  if (k === 'Enter' && E.sel.size === 1) { const m = selectedMaps()[0]; if (m && m.get('type') === 'text') { e.preventDefault(); startEditing(m.get('id')); } return; }
  if (k.startsWith('Arrow') && E.sel.size) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1;
    const dx = k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0;
    const dy = k === 'ArrowUp' ? -st : k === 'ArrowDown' ? st : 0;
    change(() => { for (const m of selectedMaps()) { if (m.get('locked')) continue; m.set('x', m.get('x') + dx); m.set('y', m.get('y') + dy); } });
    return;
  }
  if ((k === 'PageDown' || k === 'PageUp') && !E.sel.size) {
    e.preventDefault();
    const slides = currentSlides(); const i = slides.findIndex(s => s.id === E.slideId) + (k === 'PageDown' ? 1 : -1);
    if (slides[i]) selectSlide(slides[i].id);
  }
}
function onCopy(e) {
  if (!E || typingInField(e.target) || !E.sel.size) return;
  E.clipboard = selectedMaps().map(elJSON);
  try { e.clipboardData.setData('text/plain', E.clipboard.filter(x => x.type === 'text').map(x => x.text).join('\n')); e.clipboardData.setData('application/x-rework-slides', JSON.stringify(E.clipboard)); e.preventDefault(); } catch {}
}
function onPaste(e) {
  if (!E || !editable() || typingInField(e.target)) return;
  const dt = e.clipboardData;
  const file = dt && [...dt.files || []].find(f => f.type.startsWith('image/'));
  if (file) { e.preventDefault(); addImageFromFile(file); return; }
  let els = null;
  try { const raw = dt.getData('application/x-rework-slides'); if (raw) els = JSON.parse(raw); } catch {}
  if (!els && E.clipboard) els = E.clipboard;
  if (els && els.length) {
    e.preventDefault();
    const copies = els.map(x => ({ ...x, id: rid(), x: x.x + 40, y: x.y + 40, groupId: undefined }));
    const sm = curSlide();
    change(() => sm.get('elements').push(copies.map(yEl)));
    E.sel = new Set(copies.map(c => c.id));
    E.clipboard = copies;
    selChanged();
    return;
  }
  const text = dt && dt.getData('text/plain');
  if (text && text.trim()) {
    e.preventDefault();
    const lines = text.split('\n').length;
    insertElement(T(text.slice(0, 20000), 360, 300, 1200, Math.min(900, 70 * lines), { fontSize: 40 }));
  }
}

/* ── Apresentar ──────────────────────────────────────────────── */
function startPresent(i) {
  stopEditing();
  present.onClose = (last) => {
    const slides = currentSlides();
    if (E && slides[last]) selectSlide(slides[last].id);
  };
  present(() => (E ? currentDeck() : null), i, { showNotes: true });
}

/* ── Tema ────────────────────────────────────────────────────── */
const PRESETS = [
  { name: 'Claro', bg: '#ffffff', text: '#18181b', accent: '#7a00ff', font: 'geist' },
  { name: 'Escuro', bg: '#111113', text: '#f4f4f5', accent: '#a259ff', font: 'geist' },
  { name: 'Papel', bg: '#f5f1ea', text: '#2b2621', accent: '#b4532a', font: 'serif' },
  { name: 'Grafite', bg: '#1f2328', text: '#e8e8e8', accent: '#f2b33d', font: 'geist' },
  { name: 'Roxo reWork', bg: '#7a00ff', text: '#ffffff', accent: '#ffffff', font: 'geist' },
  { name: 'Técnico', bg: '#fafafa', text: '#0f172a', accent: '#0e7490', font: 'mono' }
];
function openTheme() {
  if (!E) return;
  const before = currentTheme();
  const body = document.createElement('div');
  body.className = 'sl-theme';
  const paint = () => {
    const t = currentTheme();
    body.innerHTML = `
      <div class="sl-theme-presets">${PRESETS.map((p, i) => {
        const on = p.bg === t.bg && p.text === t.text && p.accent === t.accent && p.font === t.font;
        return `<button type="button" class="sl-theme-preset${on ? ' is-on' : ''}" data-preset="${i}" aria-pressed="${on}">
          <span class="sl-theme-sample" style="background:${p.bg};color:${p.text};font-family:${esc(FONT_STACKS[p.font])}"><b>Aa</b><span class="sl-theme-bar" style="background:${p.accent}"></span></span>
          <span class="sl-theme-name">${esc(p.name)}</span></button>`;
      }).join('')}</div>
      <div class="sl-theme-custom">
        <label class="sl-theme-field"><span>Fundo</span><input type="color" data-k="bg" value="${esc(t.bg)}"></label>
        <label class="sl-theme-field"><span>Texto</span><input type="color" data-k="text" value="${esc(t.text)}"></label>
        <label class="sl-theme-field"><span>Destaque</span><input type="color" data-k="accent" value="${esc(t.accent)}"></label>
        <div class="sl-theme-field"><span>Fonte</span>
          <div class="sl-theme-fonts" role="group" aria-label="Fonte">${fontChoices().map(c => `<button type="button" class="sl-theme-font${t.font === c.key ? ' is-on' : ''}" data-font="${esc(c.key)}" style="font-family:${esc(c.stack)}" aria-pressed="${t.font === c.key}">${esc(c.label)}</button>`).join('')}<button type="button" class="sl-theme-font is-add" data-addfont>${icon('plus', 12)}Adicionar fonte</button></div>
        </div>
      </div>
      <p class="sl-theme-note">O tema vale pra apresentação inteira. Textos e formas que usam "cor do tema" mudam junto; o que tem cor própria fica como está.</p>`;
  };
  const setTheme = (patch) => { change(() => { for (const k of Object.keys(patch)) E.ytheme.set(k, patch[k]); }); requestAnimationFrame(paint); };
  body.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) { const pr = PRESETS[Number(p.dataset.preset)]; setTheme({ bg: pr.bg, text: pr.text, accent: pr.accent, font: pr.font }); return; }
    if (e.target.closest('[data-addfont]')) { openFonts({ onAdded: (key) => setTheme({ font: key }) }); return; }
    const f = e.target.closest('[data-font]');
    if (f) setTheme({ font: f.dataset.font });
  });
  body.addEventListener('input', (e) => { const k = e.target.dataset.k; if (k) change(() => E.ytheme.set(k, e.target.value.toLowerCase())); });
  paint();
  const footer = document.createElement('div');
  footer.className = 'sl-modal-actions';
  footer.innerHTML = '<button type="button" class="btn btn-ghost" data-reset>Voltar ao que era</button><button type="button" class="btn btn-primary" data-ok>Pronto</button>';
  const m = openModal({ title: 'Tema da apresentação', body, footer, size: 'modal-md' });
  footer.querySelector('[data-ok]').onclick = () => m.close();
  footer.querySelector('[data-reset]').onclick = () => setTheme(before);
  if (!editable()) body.querySelectorAll('button, input').forEach(x => { x.disabled = true; });
}

/* ── Compartilhar: cliente/projeto e link público ────────────── */
function openShare() {
  if (!E) return;
  const d = E.deck;
  const canShare = d.myRole === 'owner';
  const body = document.createElement('div');
  body.className = 'sl-share';
  const clients = S.clients.filter(c => c.workspaceId === d.workspaceId).sort((a, b) => a.name.localeCompare(b.name));
  const wsName = (S.workspaces.find(w => w.id === d.workspaceId) || {}).name || '';
  body.innerHTML = `
    <section class="sl-share-sec">
      <h3 class="sl-share-h">Vínculo</h3>
      <p class="sl-share-p">A apresentação aparece pra todo o squad${wsName ? ' <b>' + esc(wsName) + '</b>' : ''}. Vincular a um cliente ou projeto ajuda a achar depois.</p>
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="sl-sh-client">Cliente</label><select class="form-control" id="sl-sh-client"><option value="">Nenhum</option>${clients.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label" for="sl-sh-project">Projeto</label><select class="form-control" id="sl-sh-project"></select></div>
      </div>
    </section>
    <section class="sl-share-sec">
      <h3 class="sl-share-h">Link público</h3>
      <p class="sl-share-p">Quem tiver o link vê a apresentação sem entrar no reWork (sem as notas do apresentador).${canShare ? '' : ' Só quem criou a apresentação ou um admin liga e desliga o link.'}</p>
      <label class="switch sl-share-switch"><input type="checkbox" id="sl-sh-public" ${d.publicShareEnabled ? 'checked' : ''} ${canShare ? '' : 'disabled'}><span class="switch-track"></span><span class="switch-label">Qualquer pessoa com o link pode ver</span></label>
      <div class="sl-share-url" id="sl-sh-url" ${d.publicShareEnabled && d.publicUrl ? '' : 'hidden'}>
        <input class="form-control" readonly id="sl-sh-url-input" value="${esc(d.publicUrl ? location.origin + d.publicUrl : '')}">
        <button type="button" class="btn btn-ghost" id="sl-sh-copy">${icon('copy', 14)}<span>Copiar</span></button>
        <a class="btn btn-ghost" id="sl-sh-openlink" target="_blank" rel="noopener" href="${esc(d.publicUrl || '#')}" title="Abrir o link público">${icon('open', 14)}</a>
      </div>
    </section>`;
  const cSel = body.querySelector('#sl-sh-client');
  const pSel = body.querySelector('#sl-sh-project');
  cSel.value = d.clientId || '';
  const fillProjects = () => {
    const ps = S.projects.filter(p => p.workspaceId === d.workspaceId && (!cSel.value || p.clientId === cSel.value)).sort((a, b) => a.name.localeCompare(b.name));
    pSel.innerHTML = '<option value="">Nenhum</option>' + ps.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    pSel.value = ps.some(p => p.id === d.projectId) ? d.projectId : '';
  };
  fillProjects();
  const saveLink = async (patch) => {
    try {
      const r = await api('/decks/' + d.id, 'PATCH', patch);
      d.clientId = r.clientId; d.projectId = r.projectId;
      cSel.value = d.clientId || ''; fillProjects();
      paintLinkLabel();
      toast('Vínculo salvo.');
    } catch (e) { toast(e.message, 'error'); }
  };
  cSel.onchange = () => saveLink({ clientId: cSel.value || null, projectId: null });
  pSel.onchange = () => saveLink({ projectId: pSel.value || null, ...(pSel.value ? {} : { clientId: cSel.value || null }) });
  if (!editable()) { cSel.disabled = true; pSel.disabled = true; }
  const pub = body.querySelector('#sl-sh-public');
  pub.onchange = async () => {
    pub.disabled = true;
    try {
      if (pub.checked) {
        const r = await api('/decks/' + d.id + '/public-link', 'POST');
        d.publicShareEnabled = true; d.publicUrl = r.url;
        body.querySelector('#sl-sh-url-input').value = location.origin + r.url;
        body.querySelector('#sl-sh-openlink').href = r.url;
        toast('Link público ligado.');
      } else {
        await api('/decks/' + d.id + '/public-link', 'DELETE');
        d.publicShareEnabled = false;
        toast('Link público desligado. Quem tinha o link não abre mais.');
      }
      body.querySelector('#sl-sh-url').hidden = !d.publicShareEnabled;
      paintLinkLabel();
    } catch (e) { pub.checked = !pub.checked; toast(e.message, 'error'); }
    pub.disabled = false;
  };
  body.querySelector('#sl-sh-copy').onclick = async () => {
    const v = body.querySelector('#sl-sh-url-input').value;
    try { await navigator.clipboard.writeText(v); toast('Link copiado.'); }
    catch { body.querySelector('#sl-sh-url-input').select(); document.execCommand('copy'); toast('Link copiado.'); }
  };
  openModal({ title: 'Compartilhar', body, size: 'modal-md' });
}

/* ══ Tamanho do slide ═══════════════════════════════════════════
   Vale pra apresentação inteira (meta 'size'). Ao trocar, dá pra escalar
   o conteúdo junto (proporcional, centralizado) ou manter as posições. */
const SIZE_PRESETS = [
  { key: '169', name: 'Apresentação 16:9', w: 1920, h: 1080 },
  { key: '43', name: 'Apresentação 4:3', w: 1440, h: 1080 },
  { key: '11', name: 'Quadrado 1:1', w: 1080, h: 1080 },
  { key: '45', name: 'Post retrato 4:5', w: 1080, h: 1350 },
  { key: '916', name: 'Stories 9:16', w: 1080, h: 1920 },
  { key: 'a4l', name: 'A4 paisagem', w: 1754, h: 1240 },
  { key: 'a4p', name: 'A4 retrato', w: 1240, h: 1754 }
];
function deckSize() { return sizeOf(E.preview ? E.preview.size : (E.ymeta.get('size') || E.deck.size)); }
function setDeckSize(nw, nh, scaleContent) {
  if (!editable()) return;
  nw = Math.round(nw); nh = Math.round(nh);
  if (!(nw >= 100 && nw <= 8000 && nh >= 100 && nh <= 8000)) { toast('Use de 100 a 8000 px em cada lado.', 'error'); syncFrame(); return; }
  const { w: ow, h: oh } = deckSize();
  if (nw === ow && nh === oh) return;
  const s = Math.min(nw / ow, nh / oh), ox = (nw - ow * s) / 2, oy = (nh - oh * s) / 2;
  const R = (v) => Math.round(v);
  change(() => {
    E.ymeta.set('size', { w: nw, h: nh });
    if (!scaleContent) return;
    for (const sm of slidesArr()) for (const m of elsArr(sm)) {
      m.set('x', R(m.get('x') * s + ox)); m.set('y', R(m.get('y') * s + oy));
      m.set('w', Math.max(1, R(m.get('w') * s))); m.set('h', Math.max(1, R(m.get('h') * s)));
      if (m.get('fontSize')) m.set('fontSize', Math.max(4, R(m.get('fontSize') * s)));
      if (m.get('strokeW')) m.set('strokeW', Math.max(1, R(m.get('strokeW') * s)));
      if (m.get('radius')) m.set('radius', R(m.get('radius') * s));
    }
    const gs = deckGuides();
    if (gs.length) E.ymeta.set('guides', gs.map(g => ({ ...g, pos: R(g.axis === 'x' ? g.pos * s + ox : g.pos * s + oy) })));
    const gr = gridFull(deckGrid());
    if (gr) { const o = { ...gr }; for (const k of ['mt', 'mb', 'ml', 'mr', 'colGutter', 'rowGutter', 'colW', 'rowH']) o[k] = R(gr[k] * s); E.ymeta.set('grid', o); }
  });
  endStep();
  E.thumbCache.clear();
  toast(`Slide em ${nw} × ${nh} px${scaleContent ? ', com o conteúdo ajustado' : ''}.`);
}
/* Elemento novo/modelo de slide: as medidas são de 1920×1080 → leva pro tamanho atual */
function fitToDeck(el) {
  const { w, h } = deckSize();
  if (w === SW && h === SH) return el;
  const sx = w / SW, sy = h / SH, s = Math.min(sx, sy);
  const out = { ...el, x: Math.round(el.x * sx), y: Math.round(el.y * sy), w: Math.round(el.w * sx), h: Math.round(el.h * sy) };
  if (el.fontSize) out.fontSize = Math.max(4, Math.round(el.fontSize * s));
  if (el.type === 'shape' && el.shape === 'ellipse') { const d = Math.min(out.w, out.h); out.w = d; out.h = d; }
  return out;
}
function syncFrame() {
  const box = $('sl-frame'); if (!box || !E) return;
  const { w, h } = deckSize();
  const p = SIZE_PRESETS.find(x => x.w === w && x.h === h);
  const sel = $('sl-frame-preset');
  if (document.activeElement !== sel) sel.value = p ? p.key : 'custom';
  for (const [id, v] of [['sl-frame-w', w], ['sl-frame-h', h]]) { const inp = $(id); if (document.activeElement !== inp) inp.value = v; inp.disabled = !editable(); }
  sel.disabled = !editable();
  $('sl-frame-ratio').textContent = ratioLabel(w, h);
}
function ratioLabel(w, h) {
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h);
  const a = w / d, b = h / d;
  return a <= 32 && b <= 32 ? `${a}:${b}` : (w / h).toFixed(2) + ':1';
}
function bindFrame() {
  const sel = $('sl-frame-preset');
  sel.addEventListener('change', () => {
    const p = SIZE_PRESETS.find(x => x.key === sel.value);
    if (p) setDeckSize(p.w, p.h, $('sl-frame-scale').checked);
    else $('sl-frame-w').focus();
  });
  for (const id of ['sl-frame-w', 'sl-frame-h']) {
    const inp = $(id);
    inp.addEventListener('change', () => setDeckSize(Number($('sl-frame-w').value), Number($('sl-frame-h').value), $('sl-frame-scale').checked));
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { syncFrame(); inp.blur(); } });
  }
  $('sl-frame-swap').addEventListener('click', () => { const { w, h } = deckSize(); setDeckSize(h, w, $('sl-frame-scale').checked); });
}

/* ══ Guias, grade e réguas ══════════════════════════════════════
   Guias soltas (meta 'guides': [{ id, axis: 'x'|'y', pos }]) e grade de
   layout (meta 'grid'), iguais em todos os slides. Mostrar ou não é escolha
   de cada pessoa (fica no navegador). Não saem na apresentação nem no PDF. */
const RULER = 20;
const deckGuides = () => (E.preview ? E.deck.guides : E.ymeta.get('guides')) || [];
const deckGrid = () => (E.preview ? E.deck.grid : E.ymeta.get('grid')) || null;
const showGuides = () => !!E && E.showGuides !== false;
/* Layout de guias como o "Novo layout de guia" do Photoshop: colunas e
   linhas (número, largura/altura — vazio = automática — e medianiz),
   margens nos quatro lados e colunas centralizadas. Medidas de 1920×1080
   nos modelos prontos: fitGrid leva pro tamanho do slide. */
const GRID_PRESETS = [
  { key: 'none', name: 'Sem layout', grid: null },
  { key: 'margin', name: 'Só margens', grid: { marginOn: true, mt: 120, mb: 120, ml: 160, mr: 160 } },
  { key: 'c12', name: '12 colunas', grid: { colsOn: true, cols: 12, colGutter: 24, marginOn: true, mt: 120, mb: 120, ml: 160, mr: 160 } },
  { key: 'c6', name: '6 colunas', grid: { colsOn: true, cols: 6, colGutter: 32, marginOn: true, mt: 120, mb: 120, ml: 160, mr: 160 } },
  { key: 'c2', name: '2 colunas', grid: { colsOn: true, cols: 2, colGutter: 80, marginOn: true, mt: 120, mb: 120, ml: 160, mr: 160 } },
  { key: 't3', name: 'Terços (3 × 3)', grid: { colsOn: true, cols: 3, rowsOn: true, rows: 3 } }
];
const GRID_DEFAULT = { colsOn: false, cols: 0, colW: 0, colGutter: 0, rowsOn: false, rows: 0, rowH: 0, rowGutter: 0, marginOn: false, mt: 0, mb: 0, ml: 0, mr: 0, center: false };
function gridFull(g) {
  if (!g) return null;
  // Formato antigo (marginX/marginY) vira margens nos quatro lados
  const o = { ...GRID_DEFAULT, ...g };
  if (g.marginX !== undefined && g.ml === undefined) { o.ml = o.mr = g.marginX; o.marginOn = !!(g.marginX || g.marginY); }
  if (g.marginY !== undefined && g.mt === undefined) { o.mt = o.mb = g.marginY; }
  if (g.colsOn === undefined) o.colsOn = o.cols > 0;
  if (g.rowsOn === undefined) o.rowsOn = o.rows > 0;
  delete o.marginX; delete o.marginY;
  return o;
}
/* Colunas [x0,x1], linhas [y0,y1] e a área das margens, em px do slide */
function gridBands() {
  const g = gridFull(deckGrid()); if (!g) return null;
  const { w, h } = deckSize();
  const m = g.marginOn ? g : { mt: 0, mb: 0, ml: 0, mr: 0 };
  const area = { x0: m.ml, x1: w - m.mr, y0: m.mt, y1: h - m.mb };
  const aw = area.x1 - area.x0, ah = area.y1 - area.y0;
  const cols = [], rows = [];
  const split = (n, size, gutter, start, avail, center) => {
    const out = [];
    if (!(n > 0) || avail <= 0) return out;
    const cell = size > 0 ? size : (avail - gutter * (n - 1)) / n;
    if (cell <= 0) return out;
    const total = n * cell + (n - 1) * gutter;
    const x = center && size > 0 ? start + (avail - total) / 2 : start;
    for (let i = 0; i < n; i++) { const a = x + i * (cell + gutter); out.push([a, a + cell]); }
    return out;
  };
  if (g.colsOn) cols.push(...split(g.cols, g.colW, g.colGutter, area.x0, aw, g.center));
  if (g.rowsOn) rows.push(...split(g.rows, g.rowH, g.rowGutter, area.y0, ah, g.center));
  return { g, cols, rows, w, h, area, margin: !!g.marginOn };
}
/* Todas as linhas do layout (sem repetir), pra desenhar e pra grudar */
function gridLines() {
  const b = gridBands(); if (!b) return { xs: [], ys: [] };
  const xs = new Set(), ys = new Set();
  if (b.margin) { xs.add(b.area.x0); xs.add(b.area.x1); ys.add(b.area.y0); ys.add(b.area.y1); }
  for (const [a, c] of b.cols) { xs.add(a); xs.add(c); }
  for (const [a, c] of b.rows) { ys.add(a); ys.add(c); }
  const r = (v) => Math.round(v * 100) / 100;
  return { xs: [...xs].map(r), ys: [...ys].map(r), b };
}
/* Onde as coisas grudam: guias soltas e as linhas do layout */
function guideSnapTargets() {
  const xs = [], ys = [];
  if (!showGuides()) return { xs, ys };
  for (const g of deckGuides()) (g.axis === 'x' ? xs : ys).push(g.pos);
  const l = gridLines();
  xs.push(...l.xs); ys.push(...l.ys);
  return { xs, ys };
}
/* Posição do palco dentro da área (pra réguas e guias) */
function stageBox() {
  const wrap = $('sl-ed-stagewrap'), st = $('sl-ed-stage');
  const wr = wrap.getBoundingClientRect(), sr = st.getBoundingClientRect();
  return { left: sr.left - wr.left, top: sr.top - wr.top, wr };
}
function renderGuides() {
  if (!E) return;
  const wrap = $('sl-ed-stagewrap'); if (!wrap) return;
  wrap.classList.toggle('has-rulers', showGuides());
  // Layout de guias: linhas dentro do palco (colunas com um véu bem leve, como referência)
  const layer = $('sl-ed-grid');
  const s = E.scale;
  if (layer) {
    let html = '';
    if (showGuides()) {
      const l = gridLines();
      if (l.b) {
        for (const [x0, x1] of l.b.cols) html += `<div class="sl-grid-col" style="left:${x0 * s}px;width:${(x1 - x0) * s}px"></div>`;
        for (const [y0, y1] of l.b.rows) html += `<div class="sl-grid-row" style="top:${y0 * s}px;height:${(y1 - y0) * s}px"></div>`;
        for (const x of l.xs) html += `<div class="sl-grid-line is-v" style="left:${x * s}px"></div>`;
        for (const y of l.ys) html += `<div class="sl-grid-line is-h" style="top:${y * s}px"></div>`;
      }
    }
    layer.innerHTML = html;
  }
  // Guias soltas (atravessam a área toda, como no Figma)
  const gl = $('sl-ed-guidelines');
  if (gl) {
    if (!showGuides()) { gl.innerHTML = ''; }
    else {
      const sb = stageBox();
      const ro = !editable();
      gl.innerHTML = deckGuides().map(g => {
        const isX = g.axis === 'x';
        const at = isX ? sb.left + g.pos * s : sb.top + g.pos * s;
        return `<div class="sl-gl ${isX ? 'is-v' : 'is-h'}${E.guideDrag && E.guideDrag.id === g.id ? ' is-drag' : ''}" data-guide="${esc(g.id)}" style="${isX ? 'left' : 'top'}:${at}px"${ro ? ' data-ro' : ''} title="${isX ? 'X' : 'Y'} ${Math.round(g.pos)} — arraste pra mover, arraste até a régua pra apagar"><span class="sl-gl-tag">${Math.round(g.pos)}</span></div>`;
      }).join('') + (E.guideDrag && E.guideDrag.isNew ? (() => {
        const g = E.guideDrag, isX = g.axis === 'x';
        const at = isX ? sb.left + g.pos * s : sb.top + g.pos * s;
        return `<div class="sl-gl ${isX ? 'is-v' : 'is-h'} is-drag" style="${isX ? 'left' : 'top'}:${at}px"><span class="sl-gl-tag">${Math.round(g.pos)}</span></div>`;
      })() : '');
    }
  }
  drawRulers();
}
function drawRulers() {
  if (!E || !showGuides()) return;
  const wrap = $('sl-ed-stagewrap');
  const cx = $('sl-ruler-x'), cy = $('sl-ruler-y');
  if (!cx || !cy) return;
  const sb = stageBox();
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, Hh = wrap.clientHeight;
  const cs = getComputedStyle(document.documentElement);
  const col = (v, d) => (cs.getPropertyValue(v).trim() || d);
  const bg = col('--surface', '#fff'), fg = col('--text-muted', '#888'), line = col('--hairline-strong', '#ccc'), acc = col('--accent', '#7a00ff');
  const s = E.scale;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const step = steps.find(v => v * s >= 56) || 2000;
  // Faixa da seleção (como no Figma)
  const sel = (viewSlide() || { elements: [] }).elements.filter(el => E.sel.has(el.id) && !el.hidden);
  const bbox = sel.length ? {
    x0: Math.min(...sel.map(e => e.x)), x1: Math.max(...sel.map(e => e.x + e.w)),
    y0: Math.min(...sel.map(e => e.y)), y1: Math.max(...sel.map(e => e.y + e.h))
  } : null;
  const prep = (c, w, h) => {
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.font = '500 10px Geist, system-ui, sans-serif';
    return ctx;
  };
  // Horizontal (em cima): mede X
  let ctx = prep(cx, W, RULER);
  if (bbox) { ctx.fillStyle = acc; ctx.globalAlpha = .18; ctx.fillRect(sb.left + bbox.x0 * s, 0, (bbox.x1 - bbox.x0) * s, RULER); ctx.globalAlpha = 1; }
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.textBaseline = 'top';
  const v0 = Math.floor((-sb.left / s) / step) * step, v1 = (W - sb.left) / s;
  for (let v = v0; v <= v1; v += step / 5) {
    const x = Math.round(sb.left + v * s) + .5;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, RULER - (major ? 8 : 4)); ctx.stroke();
    if (major) ctx.fillText(String(Math.round(v)), x + 3, 2);
  }
  ctx.fillStyle = line; ctx.fillRect(0, RULER - 1, W, 1);
  // Vertical (à esquerda): mede Y
  ctx = prep(cy, RULER, Hh);
  if (bbox) { ctx.fillStyle = acc; ctx.globalAlpha = .18; ctx.fillRect(0, sb.top + bbox.y0 * s, RULER, (bbox.y1 - bbox.y0) * s); ctx.globalAlpha = 1; }
  ctx.fillStyle = fg; ctx.strokeStyle = fg;
  const w0 = Math.floor((-sb.top / s) / step) * step, w1 = (Hh - sb.top) / s;
  for (let v = w0; v <= w1; v += step / 5) {
    const y = Math.round(sb.top + v * s) + .5;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    ctx.beginPath(); ctx.moveTo(RULER, y); ctx.lineTo(RULER - (major ? 8 : 4), y); ctx.stroke();
    if (major) { ctx.save(); ctx.translate(2, y - 3); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'top'; ctx.fillText(String(Math.round(v)), 0, 0); ctx.restore(); }
  }
  ctx.fillStyle = line; ctx.fillRect(RULER - 1, 0, 1, Hh);
}
function setGuides(list) {
  change(() => E.ymeta.set('guides', list));
  endStep();
}
/* Arrastar da régua cria; arrastar uma guia move; soltar na régua apaga */
function bindGuides() {
  const wrap = $('sl-ed-stagewrap');
  const start = (e, axis, existing) => {
    if (!editable() || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const wr = wrap.getBoundingClientRect();
    E.guideDrag = existing ? { ...existing } : { id: rid(), axis, pos: 0, isNew: true };
    const posFrom = (ev) => {
      const p = toSlide(ev);
      let v = Math.round(axis === 'x' ? p.x : p.y);
      // Gruda nas bordas, no centro e nos elementos do slide
      const t = snapTargets(new Set());
      const near = snapAxis([v], axis === 'x' ? t.xs : t.ys, SNAP_PX / E.scale);
      if (near && !ev.altKey) v = Math.round(v + near.d);
      return v;
    };
    const overRuler = (ev) => (axis === 'x' ? ev.clientX - wr.left < RULER : ev.clientY - wr.top < RULER)
      || ev.clientX < wr.left || ev.clientY < wr.top || ev.clientX > wr.right || ev.clientY > wr.bottom;
    let moved = !!existing;
    document.body.classList.add(axis === 'x' ? 'sl-dragging-col' : 'sl-dragging-row');
    track(e, (ev) => {
      moved = true;
      E.guideDrag.pos = posFrom(ev);
      E.guideDrag.remove = overRuler(ev);
      wrap.classList.toggle('is-guide-remove', !!E.guideDrag.remove);
      renderGuides();
    }, (ev) => {
      document.body.classList.remove('sl-dragging-col', 'sl-dragging-row');
      wrap.classList.remove('is-guide-remove');
      const g = E.guideDrag; E.guideDrag = null;
      const list = deckGuides().filter(x => x.id !== g.id);
      if (!moved || g.remove || overRuler(ev)) {
        if (!g.isNew) { setGuides(list); toast('Guia apagada.'); }
      } else {
        setGuides([...list, { id: g.id, axis: g.axis, pos: g.pos }]);
      }
      renderGuides(); renderSideProps();
    });
  };
  $('sl-ruler-x').addEventListener('pointerdown', (e) => start(e, 'y'));   // régua de cima → guia horizontal
  $('sl-ruler-y').addEventListener('pointerdown', (e) => start(e, 'x'));   // régua da esquerda → guia vertical
  $('sl-ed-guidelines').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-guide]'); if (!el) return;
    const g = deckGuides().find(x => x.id === el.dataset.guide);
    if (g) start(e, g.axis, g);
  });
  $('sl-ruler-corner').addEventListener('click', () => toggleGuides());
}
function toggleGuides(on) {
  E.showGuides = on === undefined ? !showGuides() : on;
  savePref('guides', E.showGuides ? '1' : '0');
  fitStage();
  renderSideProps();
  toast(E.showGuides ? 'Réguas e guias à mostra.' : 'Réguas e guias escondidas (continuam salvas).');
}

/* ══ Painel de baixo à direita ══════════════════════════════════
   Com algo selecionado: posição e tamanho. Sem seleção: o slide (tamanho)
   e as guias, como o Figma mostra o quadro quando nada está selecionado. */
function renderSideProps() {
  if (!E) return;
  const none = E.sel.size === 0;
  const fr = $('sl-frame'), gs = $('sl-guides-sec');
  if (fr) fr.hidden = !none;
  if (gs) gs.hidden = !none;
  if (none) { syncFrame(); paintGuidesSec(); }
}
function paintGuidesSec() {
  const box = $('sl-guides-sec'); if (!box || !E) return;
  const on = showGuides();
  const eye = $('sl-guides-eye');
  eye.innerHTML = icon(on ? 'eye' : 'eyeOff', 13);
  eye.title = on ? 'Esconder réguas e guias (Ctrl+;)' : 'Mostrar réguas e guias (Ctrl+;)';
  eye.setAttribute('aria-pressed', on ? 'true' : 'false');
  const ro = !editable();
  const list = $('sl-guides-list');
  if (!list.contains(document.activeElement)) {
    const gs = deckGuides().slice().sort((a, b) => (a.axis === b.axis ? a.pos - b.pos : a.axis === 'x' ? -1 : 1));
    list.innerHTML = gs.length ? gs.map(g => `<div class="sl-guide-row" data-gid="${esc(g.id)}">
        <label class="sl-geo-f"><span class="sl-geo-l" title="${g.axis === 'x' ? 'Guia vertical (posição X)' : 'Guia horizontal (posição Y)'}">${g.axis === 'x' ? 'X' : 'Y'}</span><input type="number" value="${Math.round(g.pos)}" data-gpos aria-label="Posição da guia" ${ro ? 'disabled' : ''}></label>
        <button type="button" class="sl-layer-btn is-on" data-gdel title="Apagar guia" aria-label="Apagar guia" ${ro ? 'disabled' : ''}>${icon('x', 13)}</button>
      </div>`).join('')
      : '<div class="sl-guides-empty">Arraste de uma régua pra criar uma guia, ou adicione com a posição exata.</div>';
  }
  const g = gridFull(deckGrid());
  // Layouts prontos são guardados já no tamanho do slide (fitGrid)
  const p = GRID_PRESETS.find(x => JSON.stringify(gridFull(x.grid && fitGrid(x.grid))) === JSON.stringify(g));
  const sel = $('sl-grid-preset');
  if (document.activeElement !== sel) sel.value = p ? p.key : 'custom';
  const v = g || GRID_DEFAULT;
  const fields = $('sl-grid-fields');
  fields.querySelectorAll('input[data-gb]').forEach(inp => { inp.checked = !!v[inp.dataset.gb]; inp.disabled = ro; });
  fields.querySelectorAll('[data-group]').forEach(fs => { fs.classList.toggle('is-off', !v[fs.dataset.group]); });
  fields.querySelectorAll('input[data-gk]').forEach(inp => {
    const k = inp.dataset.gk;
    const group = inp.closest('[data-group]');
    const on = !group || !!v[group.dataset.group];
    if (document.activeElement !== inp) inp.value = (k === 'colW' || k === 'rowH') && !v[k] ? '' : v[k];
    inp.disabled = ro || !on;
  });
  const center = fields.querySelector('[data-gb="center"]');
  center.disabled = ro || !v.colsOn;
  center.closest('label').classList.toggle('is-off', !v.colsOn);
  box.querySelectorAll('[data-gadd], #sl-grid-preset').forEach(b => { b.disabled = ro; });
}
function bindGuidesSec() {
  const box = $('sl-guides-sec');
  $('sl-guides-eye').addEventListener('click', () => toggleGuides());
  box.addEventListener('click', (e) => {
    const add = e.target.closest('[data-gadd]');
    if (add && editable()) {
      const axis = add.dataset.gadd;
      const { w, h } = deckSize();
      setGuides([...deckGuides(), { id: rid(), axis, pos: Math.round(axis === 'x' ? w / 2 : h / 2) }]);
      if (!showGuides()) toggleGuides(true);
      renderGuides(); paintGuidesSec();
      return;
    }
    const del = e.target.closest('[data-gdel]');
    if (del && editable()) {
      const id = del.closest('[data-gid]').dataset.gid;
      setGuides(deckGuides().filter(x => x.id !== id));
      renderGuides(); paintGuidesSec();
    }
    if (e.target.closest('[data-gclear]') && editable() && deckGuides().length) {
      setGuides([]); renderGuides(); paintGuidesSec(); toast('Guias apagadas. Ctrl+Z desfaz.');
    }
  });
  box.addEventListener('change', (e) => {
    if (!editable()) return;
    if (e.target.matches('[data-gpos]')) {
      const id = e.target.closest('[data-gid]').dataset.gid;
      const v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v)) { paintGuidesSec(); return; }
      setGuides(deckGuides().map(g => (g.id === id ? { ...g, pos: v } : g)));
      renderGuides();
    } else if (e.target.id === 'sl-grid-preset') {
      const p = GRID_PRESETS.find(x => x.key === e.target.value);
      const grid = p ? (p.grid ? gridFull(fitGrid(p.grid)) : null) : gridFull(deckGrid()) || gridFull(fitGrid({ colsOn: true, cols: 4, colGutter: 24, marginOn: true, mt: 120, mb: 120, ml: 120, mr: 120 }));
      change(() => E.ymeta.set('grid', grid)); endStep();
      if (grid && !showGuides()) toggleGuides(true);
      renderGuides(); paintGuidesSec();
    } else if (e.target.dataset.gk || e.target.dataset.gb) {
      const g = { ...(gridFull(deckGrid()) || GRID_DEFAULT) };
      if (e.target.dataset.gb) {
        const k = e.target.dataset.gb, on = e.target.checked;
        g[k] = on;
        // Ligar um grupo vazio já traz valores de partida (como o Photoshop)
        const s0 = fitGrid({ colGutter: 20, rowGutter: 20, mt: 80, mb: 80, ml: 80, mr: 80 });
        if (on && k === 'colsOn' && !g.cols) { g.cols = 4; g.colGutter = g.colGutter || s0.colGutter; }
        if (on && k === 'rowsOn' && !g.rows) { g.rows = 3; g.rowGutter = g.rowGutter || s0.rowGutter; }
        if (on && k === 'marginOn' && !(g.mt || g.mb || g.ml || g.mr)) Object.assign(g, { mt: s0.mt, mb: s0.mb, ml: s0.ml, mr: s0.mr });
      } else {
        g[e.target.dataset.gk] = Math.max(0, Math.round(Number(e.target.value) || 0));
      }
      const any = (g.colsOn && g.cols) || (g.rowsOn && g.rows) || g.marginOn;
      change(() => E.ymeta.set('grid', any ? g : null)); endStep();
      if (any && !showGuides()) toggleGuides(true);
      renderGuides(); paintGuidesSec();
    }
  });
  box.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); } });
}
/* Margens das grades prontas são de 1920×1080: acompanham o tamanho */
function fitGrid(g) {
  const { w, h } = deckSize();
  const s = Math.min(w / SW, h / SH);
  const out = { ...g };
  for (const k of ['mt', 'mb', 'ml', 'mr', 'colGutter', 'rowGutter', 'colW', 'rowH']) if (g[k] !== undefined) out[k] = Math.round((g[k] || 0) * s);
  return out;
}

/* ══ Fontes da apresentação ═════════════════════════════════════
   Google Fonts (o servidor baixa e guarda) ou arquivo. Valem no editor,
   na apresentação, no link público e no PDF. */
const deckFonts = () => (E && E.deck.fonts) || [];
function fontChoices() {
  return [
    ...Object.keys(FONT_LABELS).map(k => ({ key: k, label: FONT_LABELS[k], stack: FONT_STACKS[k] })),
    ...deckFonts().map(f => ({ key: 'f:' + f.id, label: f.family, stack: fontStack('f:' + f.id), custom: true }))
  ];
}
function applyDeckFonts(fonts, { broadcast = false } = {}) {
  E.deck.fonts = fonts || [];
  registerFonts(E.deck.fonts);
  const tb = $('sl-ed-toolbar'); if (tb) tb.dataset.sig = '';
  E.thumbCache.clear();
  if (broadcast) E.ydoc.transact(() => E.ymeta.set('fontsRev', Date.now()), { fonts: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (E) { E.thumbCache.clear(); renderAll(); } });
  renderAll();
}
/* Outra pessoa mexeu nas fontes: busca a lista nova */
async function refreshFonts() {
  try { const d = await api('/decks/' + E.deck.id); if (E) applyDeckFonts(d.fonts); } catch {}
}

const FONT_CATS = [['', 'Todas'], ['sans', 'Sem serifa'], ['serif', 'Serifa'], ['display', 'Display'], ['hand', 'Manuscrita'], ['mono', 'Monoespaçada']];
const FONT_CAT_LABEL = Object.fromEntries(FONT_CATS.filter(([k]) => k));
const FONT_WEIGHTS = [[300, 'Leve'], [400, 'Normal'], [500, 'Médio'], [600, 'Seminegrito'], [700, 'Negrito'], [800, 'Extranegrito']];
const FONT_PAGE = 60;
const _previewLoaded = new Set();
let _fontCatalog = null;
function fontCatalog() {
  if (!_fontCatalog) _fontCatalog = api('/fonts/google').catch(e => { _fontCatalog = null; throw e; });
  return _fontCatalog;
}
/* onAdded(fontKey): chamado quando entra uma fonte nova (ex.: aplicar no texto selecionado) */
function openFonts({ onAdded, tab } = {}) {
  if (!E) return;
  const canEdit = editable();
  const st = { tab: tab === 'upload' ? 'upload' : 'google', q: '', cat: '', sort: 'pop', shown: FONT_PAGE, list: [], filtered: [] };
  const body = document.createElement('div');
  body.className = 'sl-fp';
  body.innerHTML = `
    <div class="sl-fp-inuse" data-inuse></div>
    <div class="seg sl-fp-tabs" role="tablist" aria-label="Origem">
      <button type="button" class="seg-btn" data-tab="google">Google Fonts</button>
      <button type="button" class="seg-btn" data-tab="upload">Enviar arquivo</button>
    </div>
    <div class="sl-fp-pane" data-pane="google">
      <div class="sl-fp-bar">
        <div class="filter-input-wrap sl-fp-search">
          <svg class="filter-input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="search" class="filter-input filter-input--with-icon" data-q placeholder="Buscar fonte…" aria-label="Buscar fonte" autocomplete="off">
        </div>
        <select class="filter-select" data-sort aria-label="Ordenar">
          <option value="pop">Mais usadas</option><option value="trend">Em alta</option><option value="new">Mais novas</option><option value="az">Nome (A–Z)</option>
        </select>
      </div>
      <div class="seg sl-fp-cats" role="group" aria-label="Categoria">${FONT_CATS.map(([k, l]) => `<button type="button" class="seg-btn" data-cat="${k}">${l}</button>`).join('')}</div>
      <div class="sl-fp-list" data-list role="list"><div class="sl-fp-empty">Carregando fontes…</div></div>
      <div class="sl-fp-count" data-count></div>
    </div>
    <div class="sl-fp-pane" data-pane="upload" hidden>
      <form class="sl-fp-upload" data-upload>
        <label class="form-group full"><span class="form-label">Arquivo</span><input type="file" name="file" class="form-control" accept=".woff2,.woff,.ttf,.otf" required></label>
        <div class="form-grid">
          <label class="form-group"><span class="form-label">Nome da fonte</span><input type="text" name="family" class="form-control" maxlength="60" required placeholder="Ex.: Marca Sans"></label>
          <label class="form-group"><span class="form-label">Peso</span><select name="weight" class="form-control">${FONT_WEIGHTS.map(([w, l]) => `<option value="${w}"${w === 400 ? ' selected' : ''}>${l} (${w})</option>`).join('')}</select></label>
        </div>
        <label class="form-check"><input type="checkbox" name="italic"> Itálico</label>
        <p class="sl-fp-hint">.woff2, .woff, .ttf ou .otf, até 5 MB. Pra ter negrito de verdade, envie também o arquivo do peso Negrito com o mesmo nome.</p>
        <div><button type="submit" class="btn btn-primary">Enviar fonte</button></div>
      </form>
    </div>
    <p class="sl-fp-hint">As fontes ficam guardadas no reWork: quem abrir a apresentação (até pelo link público) não precisa ter nada instalado.</p>`;
  const footer = document.createElement('div');
  footer.className = 'sl-modal-actions';
  footer.innerHTML = '<button type="button" class="btn btn-primary" data-done>Concluir</button>';
  let io;
  const m = openModal({ title: 'Fontes da apresentação', body, footer, size: 'modal-md', onClose: () => io && io.disconnect() });
  footer.querySelector('[data-done]').onclick = () => m.close();
  const $q = (sel) => body.querySelector(sel);
  const listEl = $q('[data-list]');
  const inDeck = () => new Set(deckFonts().map(f => f.family.toLowerCase()));
  const paintInUse = () => {
    const fonts = deckFonts();
    $q('[data-inuse]').innerHTML = fonts.length
      ? '<span class="sl-fp-inuse-label">Nesta apresentação</span>' + fonts.map(f => `<span class="sl-fp-chip" style="font-family:${esc(fontStack('f:' + f.id))}">${esc(f.family)}${canEdit ? `<button type="button" data-del="${esc(f.id)}" title="Tirar da apresentação" aria-label="Tirar ${esc(f.family)} da apresentação">${icon('x', 11)}</button>` : ''}</span>`).join('')
      : '<span class="sl-fp-hint">Nenhuma fonte própria ainda. Escolha no Google Fonts ou envie um arquivo: elas aparecem no seletor de fonte e no tema.</span>';
  };
  const setFonts = (fonts, added) => {
    applyDeckFonts(fonts, { broadcast: true });
    paintInUse(); paintStates();
    if (added && onAdded) onAdded('f:' + added);
  };
  // Prévias: só das fontes que aparecem na lista
  let previewStyle = document.getElementById('sl-fp-previews');
  if (!previewStyle) { previewStyle = document.createElement('style'); previewStyle.id = 'sl-fp-previews'; document.head.appendChild(previewStyle); }
  const want = new Set();
  let pvTimer = null;
  const flushPreviews = async () => {
    const fams = [...want].filter(f => !_previewLoaded.has(f)).slice(0, 40);
    fams.forEach(f => want.delete(f));
    if (want.size) { clearTimeout(pvTimer); pvTimer = setTimeout(flushPreviews, 150); }
    if (!fams.length) return;
    fams.forEach(f => _previewLoaded.add(f));
    try {
      const r = await api('/fonts/google/previews', 'POST', { families: fams });
      previewStyle.textContent += Object.values(r.css || {}).join('\n') + '\n';
    } catch { fams.forEach(f => _previewLoaded.delete(f)); }
  };
  io = new IntersectionObserver((entries) => {
    entries.forEach(en => { if (en.isIntersecting) { want.add(en.target.dataset.fam); io.unobserve(en.target); } });
    clearTimeout(pvTimer); pvTimer = setTimeout(flushPreviews, 120);
  }, { root: listEl, rootMargin: '200px 0px' });
  const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const rowHTML = (f, have) => `<div class="sl-fp-row${have ? ' is-in' : ''}" role="button" tabindex="0" data-fam="${esc(f.f)}"${have ? ' aria-disabled="true"' : ''} title="${have ? 'Já está na apresentação' : 'Adicionar à apresentação'}">
      <div class="sl-fp-info">
        <span class="sl-fp-name" style="font-family:'kdpv ${esc(f.f)}', '${esc(f.f)}', var(--font-sans, sans-serif)">${esc(f.f)}</span>
        <span class="sl-fp-meta">${esc(FONT_CAT_LABEL[f.c] || '')} · ${f.w.length} ${f.w.length === 1 ? 'peso' : 'pesos'}${f.i ? ' · itálico' : ''}</span>
      </div>
      ${have ? `<span class="sl-fp-have">${icon('check', 14)}Na apresentação</span>` : `<span class="sl-fp-add">${icon('plus', 14)}Adicionar</span>`}
    </div>`;
  const renderList = () => {
    const have = inDeck();
    const slice = st.filtered.slice(0, st.shown);
    listEl.innerHTML = slice.length ? slice.map(f => rowHTML(f, have.has(f.f.toLowerCase()))).join('')
      : `<div class="sl-fp-empty">${st.list.length ? 'Nenhuma fonte com esse nome nessa categoria.' : 'Carregando fontes…'}</div>`;
    listEl.querySelectorAll('.sl-fp-row').forEach(r => { if (!_previewLoaded.has(r.dataset.fam)) io.observe(r); });
    $q('[data-count]').textContent = st.list.length ? `${st.filtered.length.toLocaleString('pt-BR')} ${st.filtered.length === 1 ? 'fonte' : 'fontes'}` : '';
  };
  const applyFilter = () => {
    const q = norm(st.q.trim());
    let l = st.list.filter(f => (!st.cat || f.c === st.cat) && (!q || norm(f.f).includes(q)));
    if (st.sort === 'trend') l = l.slice().sort((a, b) => a.t - b.t);
    else if (st.sort === 'new') l = l.slice().sort((a, b) => String(b.d).localeCompare(String(a.d)));
    else if (st.sort === 'az') l = l.slice().sort((a, b) => a.f.localeCompare(b.f));
    st.filtered = l; st.shown = FONT_PAGE;
    listEl.scrollTop = 0;
    renderList();
  };
  const paintStates = () => {
    const have = inDeck();
    listEl.querySelectorAll('.sl-fp-row').forEach(r => {
      const on = have.has(r.dataset.fam.toLowerCase());
      if (on !== r.classList.contains('is-in')) {
        const f = st.list.find(x => x.f === r.dataset.fam);
        if (f) { r.insertAdjacentHTML('afterend', rowHTML(f, on)); const nr = r.nextElementSibling; r.remove(); if (!_previewLoaded.has(f.f)) io.observe(nr); }
      }
    });
  };
  listEl.addEventListener('scroll', () => {
    if (st.shown >= st.filtered.length) return;
    if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 300) {
      const from = st.shown; st.shown += FONT_PAGE;
      const have = inDeck();
      listEl.insertAdjacentHTML('beforeend', st.filtered.slice(from, st.shown).map(f => rowHTML(f, have.has(f.f.toLowerCase()))).join(''));
      listEl.querySelectorAll('.sl-fp-row').forEach((r, i) => { if (i >= from && !_previewLoaded.has(r.dataset.fam)) io.observe(r); });
    }
  });
  const setTab = (t) => {
    st.tab = t;
    body.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.tab === t));
    body.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== t; });
    if (t === 'google') setTimeout(() => $q('[data-q]').focus(), 30);
  };
  const setCat = (c) => { st.cat = c; body.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('is-active', b.dataset.cat === c)); applyFilter(); };
  let qTimer = null;
  $q('[data-q]').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value; applyFilter(); }, 120); });
  $q('[data-sort]').addEventListener('change', (e) => { st.sort = e.target.value; applyFilter(); });
  async function addRow(row) {
    if (!canEdit || row.classList.contains('is-in') || row.classList.contains('is-busy')) return;
    const fam = row.dataset.fam;
    row.classList.add('is-busy');
    row.querySelector('.sl-fp-add').textContent = 'Adicionando…';
    try {
      const r = await api('/decks/' + E.deck.id + '/fonts', 'POST', { google: fam });
      setFonts(r.fonts || [], r.added); toast(`${fam} adicionada à apresentação.`);
    } catch (e) { row.classList.remove('is-busy'); renderList(); toast(e.message || 'Não deu pra adicionar a fonte.', 'error'); }
  }
  body.addEventListener('click', async (ev) => {
    const tb = ev.target.closest('[data-tab]'); if (tb) return setTab(tb.dataset.tab);
    const cat = ev.target.closest('[data-cat]'); if (cat) return setCat(cat.dataset.cat);
    const del = ev.target.closest('[data-del]');
    if (del && canEdit) {
      try { const r = await api('/decks/' + E.deck.id + '/fonts/' + del.dataset.del, 'DELETE'); setFonts(r.fonts || []); toast('Fonte tirada. Textos que usavam ela voltam pra fonte padrão.'); }
      catch (e) { toast(e.message || 'Não deu pra tirar a fonte.', 'error'); }
      return;
    }
    const row = ev.target.closest('.sl-fp-row'); if (row) addRow(row);
  });
  listEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('sl-fp-row')) { e.preventDefault(); addRow(e.target); }
  });
  const uForm = $q('[data-upload]');
  const busy = (on) => uForm.querySelectorAll('button, input, select').forEach(el => { el.disabled = on || !canEdit; });
  busy(false);
  uForm.file.addEventListener('change', () => {
    const f = uForm.file.files[0];
    if (f && !uForm.family.value) uForm.family.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_](regular|bold|italic|light|medium|semibold|black|\d+)$/i, '').replace(/[-_]+/g, ' ').trim();
  });
  uForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = uForm.file.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Arquivo maior que 5 MB.', 'error'); return; }
    busy(true);
    try {
      const data = await new Promise((ok, fail) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.onerror = fail; rd.readAsDataURL(f); });
      const r = await api('/decks/' + E.deck.id + '/fonts', 'POST', { upload: { name: f.name, data }, family: uForm.family.value.trim(), weight: Number(uForm.weight.value), italic: uForm.italic.checked });
      setFonts(r.fonts || [], r.added); uForm.reset(); toast('Fonte enviada.');
    } catch (e) { toast(e.message || 'Não deu pra enviar a fonte.', 'error'); }
    busy(false);
  });
  paintInUse();
  setCat('');
  setTab(st.tab);
  fontCatalog().then(list => { st.list = list; applyFilter(); })
    .catch(e => { listEl.innerHTML = `<div class="sl-fp-empty">${esc(e.message || 'Não deu pra carregar a lista do Google Fonts.')} Você ainda pode enviar um arquivo de fonte.</div>`; });
}

/* ══ Seções recolhíveis do painel (Posição, Slide, Guias) ════════
   Clique no título abre/fecha; cada pessoa tem o seu estado (navegador). */
function secToggle(key, label) {
  return `<button type="button" class="sl-sec-toggle" data-sec-toggle="${key}" aria-expanded="true" title="Recolher ou abrir">${icon('down', 12)}<span>${label}</span></button>`;
}
function setSection(key, open) {
  const sec = document.querySelector(`#sl-side-props [data-sec="${key}"]`); if (!sec) return;
  sec.classList.toggle('is-collapsed', !open);
  const b = sec.querySelector('[data-sec-toggle]');
  if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function bindSections() {
  for (const key of ['geo', 'frame', 'guides']) setSection(key, readPref('sec-' + key, '1') === '1');
  $('sl-side-props').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sec-toggle]'); if (!b) return;
    const key = b.dataset.secToggle;
    const open = b.getAttribute('aria-expanded') !== 'true';
    setSection(key, open);
    savePref('sec-' + key, open ? '1' : '0');
  });
}

/* ══ Zoom e navegação no palco ══════════════════════════════════
   Ctrl + roda (ou pinça no trackpad) amplia no ponto do mouse; Ctrl + / −
   em degraus; Ctrl 0 = 100%; Shift 1 = ajustar à tela. Com o slide maior
   que a área, a roda arrasta a vista (Shift: pros lados), e espaço + arrastar
   ou o botão do meio também. */
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const ZOOM_MIN = 0.05, ZOOM_MAX = 8;
function wrapPoint(ev) {
  const r = $('sl-ed-stagewrap').getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
function setZoom(z, anchor) {
  if (!E) return;
  if (z === 'fit') { E.zoom = 'fit'; fitStage(); return; }
  const wrap = $('sl-ed-stagewrap');
  const old = E.scale;
  const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const a = anchor || { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
  // O ponto do slide debaixo do mouse continua no mesmo lugar
  const px = (a.x - E.panX) / old, py = (a.y - E.panY) / old;
  E.zoom = nz;
  E.panX = a.x - px * nz;
  E.panY = a.y - py * nz;
  fitStage();
}
function zoomStep(dir, anchor) {
  const s = E.scale;
  const next = dir > 0 ? ZOOM_STEPS.find(v => v > s * 1.01) || ZOOM_MAX : [...ZOOM_STEPS].reverse().find(v => v < s * 0.99) || ZOOM_MIN;
  setZoom(next, anchor);
}
function paintZoom() {
  const v = $('sl-zoom-val'); if (!v || !E) return;
  v.textContent = Math.round(E.scale * 100) + '%';
  v.classList.toggle('is-fit', E.zoom === 'fit');
  v.title = E.zoom === 'fit' ? 'Ajustado à tela — clique pra outras opções' : 'Opções de zoom';
}
function startPan(e) {
  e.preventDefault(); e.stopPropagation();
  const wrap = $('sl-ed-stagewrap');
  if (E.zoom === 'fit') E.zoom = E.scale;
  const x0 = e.clientX, y0 = e.clientY, px = E.panX, py = E.panY;
  wrap.classList.add('is-panning');
  track(e, (ev) => { E.panX = px + ev.clientX - x0; E.panY = py + ev.clientY - y0; fitStage(); },
    () => wrap.classList.remove('is-panning'));
}
function bindZoom() {
  const wrap = $('sl-ed-stagewrap');
  wrap.addEventListener('wheel', (e) => {
    if (!E) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(E.scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), wrapPoint(e));
      return;
    }
    const { w, h } = deckSize();
    const bigger = w * E.scale > wrap.clientWidth - 40 || h * E.scale > wrap.clientHeight - 40;
    if (E.zoom === 'fit' || !bigger) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 32 : 1;
    E.panX -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
    E.panY -= (e.shiftKey ? 0 : e.deltaY) * k;
    fitStage();
  }, { passive: false });
  // Ctrl + roda fora do palco (trilho, painel) não dá zoom na página inteira
  on(document, 'wheel', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.target.closest && e.target.closest('#sl-editor') && !wrap.contains(e.target)) e.preventDefault();
  }, { passive: false });
  // Espaço + arrastar ou botão do meio: arrasta a vista (antes da seleção)
  wrap.addEventListener('pointerdown', (e) => {
    if (!E) return;
    if (e.button === 1 || (e.button === 0 && E.spaceDown)) startPan(e);
  }, true);
  on(document, 'keyup', (e) => { if (e.key === ' ' && E) { E.spaceDown = false; $('sl-ed-stagewrap').classList.remove('is-pan-ready'); } });
  on(window, 'blur', () => { if (E) { E.spaceDown = false; $('sl-ed-stagewrap')?.classList.remove('is-pan-ready'); } });
  $('sl-zoom').addEventListener('click', (e) => {
    const b = e.target.closest('[data-zoom]');
    if (b) { zoomStep(b.dataset.zoom === 'in' ? 1 : -1); return; }
    if (e.target.closest('#sl-zoom-val')) {
      const cur = E.zoom === 'fit' ? 'fit' : Math.round(E.scale * 100);
      openMenu($('sl-zoom-val'), [
        { label: 'Ajustar à tela', hint: 'Shift 1', active: cur === 'fit', onClick: () => setZoom('fit') },
        '-',
        ...[50, 100, 200, 400].map(p => ({ label: p + '%', hint: p === 100 ? 'Ctrl 0' : '', active: cur === p, onClick: () => setZoom(p / 100) })),
        '-',
        { label: 'Aumentar', hint: 'Ctrl +', onClick: () => zoomStep(1) },
        { label: 'Diminuir', hint: 'Ctrl −', onClick: () => zoomStep(-1) }
      ], { align: 'right', className: 'sl-zoom-menu' });
    }
  });
}

/* ══ Renomear (grupo ou camada) a partir do slide, do menu ou do F2 ══ */
function renameSelected() {
  if (!E || !editable()) return;
  const root = $('sl-editor');
  // Painel fechado: abre pra mostrar a lista
  if (root.classList.contains('no-side')) root.querySelector('[data-panel="side"]')?.click();
  const sg = selectedGroup();
  if (sg) {
    renderLayers();
    const n = $('sl-layers').querySelector(`.sl-layer[data-gid="${CSS.escape(sg)}"] .sl-layer-name`);
    if (n) { n.scrollIntoView({ block: 'nearest' }); renameGroup(sg, n); }
    return;
  }
  if (E.sel.size !== 1) { toast('Selecione uma camada ou um grupo pra renomear.'); return; }
  const id = [...E.sel][0];
  const el = viewEl(id);
  if (el && el.groupId) E.closedGroups.delete(el.groupId);
  renderLayers();
  const n = $('sl-layers').querySelector(`.sl-layer[data-id="${CSS.escape(id)}"] .sl-layer-name`);
  if (n) { n.scrollIntoView({ block: 'nearest' }); renameLayer(id, n); }
}

/* ══ Área de transferência interna (pro menu: copiar, recortar, colar) ══ */
function copySelection() {
  if (!E.sel.size) return;
  const sm = curSlide();
  const index = new Map(elsArr(sm).map((m, i) => [m.get('id'), i]));
  E.clipboard = selectedMaps().sort((p, q) => index.get(p.get('id')) - index.get(q.get('id'))).map(elJSON);
  // Também no sistema, pra colar em outra guia (quando o navegador deixa)
  try { navigator.clipboard.writeText(E.clipboard.filter(x => x.type === 'text').map(x => x.text).join('\n')); } catch {}
}
function cutSelection() { if (!editable() || !E.sel.size) return; copySelection(); deleteSelected(); }
function pasteElements(els, at) {
  if (!editable() || !els || !els.length) return;
  let dx = 40, dy = 40;
  if (at) {
    // Colar no ponto do clique: o canto de cima do conjunto vai pra lá
    const x0 = Math.min(...els.map(e => e.x)), y0 = Math.min(...els.map(e => e.y));
    dx = Math.round(at.x - x0); dy = Math.round(at.y - y0);
  }
  const copies = els.map(x => ({ ...x, id: rid(), x: x.x + dx, y: x.y + dy, groupId: undefined }));
  const sm = curSlide();
  change(() => sm.get('elements').push(copies.map(yEl)));
  endStep();
  E.sel = new Set(copies.map(c => c.id));
  if (!at) E.clipboard = copies;
  selChanged();
}

/* ══ Menu do botão direito ═══════════════════════════════════════
   No slide e na lista de camadas. Com algo embaixo do mouse, o menu é da
   seleção; no fundo, o menu é do slide. */
function openContextMenu(e, point) {
  e.preventDefault();
  closeMenu();
  const at = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) };
  const ro = !editable();
  const s = viewSlide(); if (!s) return;
  const selEls = s.elements.filter(el => E.sel.has(el.id));
  const sg = selectedGroup();
  const anyGrouped = selEls.some(el => el.groupId && hasGroup(el.groupId));
  const allHidden = selEls.length && selEls.every(el => el.hidden);
  const allLocked = selEls.length && selEls.every(el => el.locked);
  const hasClip = !!(E.clipboard && E.clipboard.length);
  const items = [];
  if (selEls.length) {
    const what = sg ? (viewGroups().get(sg) || {}).name || 'Grupo' : selEls.length === 1 ? layerName(selEls[0]) : `${selEls.length} camadas`;
    items.push({ heading: what });
    items.push(
      { label: 'Recortar', hint: 'Ctrl+X', icon: icon('scissors', 15), disabled: ro, onClick: cutSelection },
      { label: 'Copiar', hint: 'Ctrl+C', icon: icon('copy', 15), onClick: copySelection },
      { label: 'Colar', hint: 'Ctrl+V', icon: icon('clipboard', 15), disabled: ro || !hasClip, onClick: () => pasteElements(E.clipboard) },
      { label: 'Duplicar', hint: 'Ctrl+D', icon: icon('copy', 15), disabled: ro, onClick: duplicateSelected },
      '-',
      sg ? { label: 'Renomear grupo', hint: 'F2', icon: icon('pencil', 15), disabled: ro, onClick: renameSelected }
        : { label: 'Renomear camada', hint: 'F2', icon: icon('pencil', 15), disabled: ro || selEls.length !== 1, onClick: renameSelected },
      { label: 'Agrupar', hint: 'Ctrl+G', icon: icon('group', 15), disabled: ro || selEls.length < 2 || !!sg, onClick: groupSelection },
      { label: 'Desagrupar', hint: 'Ctrl+Shift+G', icon: icon('ungroup', 15), disabled: ro || !anyGrouped, onClick: ungroupSelection },
      '-',
      { label: 'Trazer pra frente', hint: 'Ctrl+Shift+]', icon: icon('front', 15), disabled: ro, onClick: () => reorder('front') },
      { label: 'Avançar uma', hint: 'Ctrl+]', icon: icon('front', 15), disabled: ro, onClick: () => stepOrder('up') },
      { label: 'Recuar uma', hint: 'Ctrl+[', icon: icon('back', 15), disabled: ro, onClick: () => stepOrder('down') },
      { label: 'Mandar pra trás', hint: 'Ctrl+Shift+[', icon: icon('back', 15), disabled: ro, onClick: () => reorder('back') },
      '-',
      { label: allHidden ? 'Mostrar' : 'Ocultar', hint: 'Ctrl+Shift+H', icon: icon(allHidden ? 'eye' : 'eyeOff', 15), disabled: ro, onClick: () => toggleLayerProp([...E.sel], 'hidden') },
      { label: allLocked ? 'Destravar' : 'Travar', hint: 'Ctrl+Shift+L', icon: icon(allLocked ? 'unlock' : 'lock', 15), disabled: ro, onClick: () => toggleLayerProp([...E.sel], 'locked') },
      ...(selEls.some(el => el.shadow) ? [{ label: 'Tirar sombra', icon: icon('x', 15), disabled: ro, onClick: () => { const sm = curSlide(); change(() => { for (const id of E.sel) { const m = elM(sm, id); if (m && m.get('shadow')) m.delete('shadow'); } }); endStep(); } }] : []),
      '-',
      { label: 'Excluir', hint: 'Delete', icon: icon('trash', 15), danger: true, disabled: ro, onClick: deleteSelected }
    );
  } else {
    const n = currentSlides().findIndex(x => x.id === E.slideId) + 1;
    items.push({ heading: `Slide ${n}` });
    items.push(
      { label: 'Colar aqui', hint: 'Ctrl+V', icon: icon('clipboard', 15), disabled: ro || !hasClip, onClick: () => pasteElements(E.clipboard, point) },
      { label: 'Selecionar tudo', hint: 'Ctrl+A', icon: icon('frame', 15), disabled: !s.elements.length, onClick: () => { E.sel = new Set(s.elements.filter(isFree).map(x => x.id)); selChanged(); } },
      '-',
      { label: 'Texto aqui', icon: icon('type', 15), disabled: ro, onClick: () => addTextAt(point) },
      { label: 'Imagem', icon: icon('image', 15), disabled: ro, onClick: () => pickImage() },
      { label: 'Novo slide depois deste', icon: icon('plus', 15), disabled: ro, onClick: () => addSlide('title-text') },
      { label: 'Trazer slides do Figma…', icon: FIGMA_IC, disabled: ro, onClick: figmaIntoDeck },
      '-',
      { label: showGuides() ? 'Esconder réguas e guias' : 'Mostrar réguas e guias', hint: 'Ctrl+;', icon: icon('ruler', 15), onClick: () => toggleGuides() },
      { label: 'Ajustar à tela', hint: 'Shift+1', icon: icon('maximize', 15), onClick: () => setZoom('fit') },
      { label: 'Zoom 100%', hint: 'Ctrl+0', icon: icon('search', 15), onClick: () => setZoom(1) }
    );
  }
  openMenu(at, items, { className: 'sl-ctx' });
}
function addTextAt(p) {
  if (!editable()) return;
  const el = fitToDeck(T('', 560, 460, 800, 120, { fontSize: 48 }));
  if (p) { el.x = Math.round(p.x); el.y = Math.round(p.y); }
  insertElement(el, { edit: true });
}
function bindContextMenus() {
  const wrap = $('sl-ed-stagewrap');
  wrap.addEventListener('contextmenu', (e) => {
    if (!E || e.target.closest('.sl-zoom, .sl-ruler, .sl-ruler-corner')) { e.preventDefault(); return; }
    stopEditing();
    let n = e.target.closest('#sl-ed-canvas .sl-el');
    if (n && !isFree(viewEl(n.dataset.id))) n = pickBelow(e);
    const tag = e.target.closest('[data-group-tag]');
    if (tag) {
      E.sel = new Set(groupMembersIds(tag.dataset.groupTag)); selChanged();
    } else if (n) {
      const id = n.dataset.id;
      // Botão direito fora da seleção: seleciona o que está embaixo (o grupo inteiro, se for)
      if (!E.sel.has(id)) { E.sel = new Set(unitOf(id)); selChanged(); }
    } else if (E.sel.size) {
      E.sel.clear(); E.enteredGroup = null; selChanged();
    }
    const st = $('sl-ed-stage').getBoundingClientRect();
    const inside = e.clientX >= st.left && e.clientX <= st.right && e.clientY >= st.top && e.clientY <= st.bottom;
    openContextMenu(e, inside ? toSlide(e) : null);
  });
  $('sl-layers').addEventListener('contextmenu', (e) => {
    if (!E) return;
    const row = e.target.closest('.sl-layer');
    if (!row) { e.preventDefault(); return; }
    if (row.dataset.gid) {
      const members = groupMembersIds(row.dataset.gid);
      if (!members.every(id => E.sel.has(id)) || E.sel.size !== members.length) { E.enteredGroup = null; E.sel = new Set(members); selChanged(); }
    } else if (!E.sel.has(row.dataset.id)) {
      E.enteredGroup = row.dataset.parent || null;
      E.sel = new Set([row.dataset.id]); selChanged();
    }
    openContextMenu(e, null);
  });
}

/* ══ Figma: slides no fim da apresentação aberta ═══════════════ */
const FIGMA_IC = '<img src="/figma.svg" alt="" width="10" height="15" style="margin:0 2px">';
function figmaIntoDeck() {
  if (!editable()) return;
  openFigmaImport({
    intoDeck: {
      id: E.deck.id, size: deckSize(),
      onSlides: (slides, fonts) => {
        if (!E || !slides || !slides.length) return;
        applyDeckFonts(fonts, { broadcast: true });
        const at = slideIdx(E.slideId) + 1;
        change(() => E.yslides.insert(at, slides.map(ySlide)));
        endStep();
        E.slideId = slides[0].id; E.sel.clear(); E.scrollRail = true;
        updateAwareness();
        renderAll();
      }
    }
  });
}
