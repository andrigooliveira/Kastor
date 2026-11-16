/* Utilitários do reWork Presentations: API, toast, modal, menus, datas. */

export const $ = (id) => document.getElementById(id);
export const LOCALE = (window.I18N && window.I18N.locale) || 'pt-BR';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function rid() {
  return Math.random().toString(36).slice(2, 10);
}

export async function api(path, method, body) {
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

export function toast(msg, type) {
  let el = $('sl-toast');
  if (!el) { el = document.createElement('div'); el.id = 'sl-toast'; el.className = 'sl-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'sl-toast show' + (type === 'error' ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'sl-toast'; }, type === 'sticky' ? 60000 : 3200);
}

export function fmtDate(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    const now = new Date();
    if (dt.toDateString() === now.toDateString()) return 'hoje, ' + dt.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (dt.toDateString() === y.toDateString()) return 'ontem';
    return dt.toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: dt.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  } catch { return ''; }
}
export function fmtFull(iso) {
  try { return new Date(iso).toLocaleString(LOCALE, { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 60).replace(/-+$/, '');
}
export function deckSlug(d) {
  const s = slugify(d.title || 'apresentacao');
  return s ? s + '-' + d.id : d.id;
}
export function idFromSlug(slug) {
  const m = String(slug || '').match(/(?:^|-)([0-9a-f]{12})$/i);
  return m ? m[1] : slug;
}

/* Degradê do avatar — mesma lista e ordem do AVATAR_GRADIENTS do app.js. */
const AVATAR_PAIRS = [
  ['#FF6B6B', '#C92A2A'], ['#F8A055', '#D14A1F'], ['#FFB84D', '#B8860B'], ['#FFD93D', '#E07B00'],
  ['#8BC34A', '#2E7D32'], ['#4ECDC4', '#1B9E96'], ['#44BCD8', '#0277B6'], ['#6FA8DC', '#1A5490'],
  ['#4A6FE3', '#2E3B8E'], ['#7A6BE8', '#3F2DA5'], ['#9C6FE8', '#6128D7'], ['#C77DFF', '#7A00FF'],
  ['#E6A0E0', '#A93FA8'], ['#F472B6', '#BE185D'], ['#FB7185', '#9F1239'], ['#94A3B8', '#475569']
];
function avatarIdx(seed) {
  const key = String(seed || '?');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) >>> 0;
  return h % AVATAR_PAIRS.length;
}
export function avatarGradient(seed) {
  const [a, b] = AVATAR_PAIRS[avatarIdx(seed)];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}
/* Cor sólida da pessoa (contorno da seleção remota, etiqueta do nome). */
export function personColor(seed) {
  return AVATAR_PAIRS[avatarIdx(seed)][1];
}
export function avatarHTML(user, size) {
  const name = (user && (user.name || user.username)) || '?';
  const st = size ? `width:${size}px;height:${size}px;` : '';
  if (user && user.avatar) return `<span class="avatar sl-avatar" style="${st}background-image:url('${esc(user.avatar)}');background-size:cover;background-position:center" title="${esc(name)}"></span>`;
  return `<span class="avatar sl-avatar" style="${st}background:${avatarGradient(user && user.id || name)};color:#fff" title="${esc(name)}">${esc(name.trim().charAt(0).toUpperCase())}</span>`;
}

/* Modal no padrão da plataforma (.modal-overlay/.modal do style.css). */
export function openModal({ title, body, footer, size = 'modal-sm', onClose }) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay sl-modal-overlay';
  ov.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-header">
        <span class="modal-title">${esc(title)}</span>
        <button type="button" class="modal-close" aria-label="Fechar" data-close>${'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'}</button>
      </div>
      <div class="modal-body"></div>
      ${footer ? '<div class="modal-footer"></div>' : ''}
    </div>`;
  const bodyEl = ov.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (footer) { const f = ov.querySelector('.modal-footer'); if (typeof footer === 'string') f.innerHTML = footer; else f.appendChild(footer); }
  const prevFocus = document.activeElement;
  const close = () => {
    ov.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => ov.remove(), 180);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  // Esc com um menu/lista aberto fecha só o menu
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.sl-menu')) { e.stopPropagation(); close(); } };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('open'));
  setTimeout(() => { const f = ov.querySelector('[autofocus], input, .sl-dd, button:not([data-close])'); if (f) f.focus(); }, 60);
  return { el: ov, body: bodyEl, close };
}

export function confirmModal({ title, text, ok = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const footer = document.createElement('div');
    footer.className = 'sl-modal-actions';
    footer.innerHTML = `<button type="button" class="btn btn-ghost" data-no>Cancelar</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(ok)}</button>`;
    const m = openModal({ title, body: `<p class="sl-modal-text">${esc(text)}</p>`, footer, onClose: () => { if (!done) resolve(false); } });
    footer.querySelector('[data-no]').onclick = () => m.close();
    footer.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); m.close(); };
    setTimeout(() => footer.querySelector('[data-yes]').focus(), 80);
  });
}

/* Menu flutuante simples: itens { label, icon, onClick, danger, disabled } ou '-'. */
let _openMenu = null;
export function closeMenu() {
  if (_openMenu) { _openMenu.remove(); _openMenu = null; document.removeEventListener('mousedown', _menuOutside, true); document.removeEventListener('keydown', _menuKey, true); }
}
function _menuOutside(e) { if (_openMenu && !_openMenu.contains(e.target)) closeMenu(); }
function _menuKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); return; }
  // Setas andam pelos itens; Home/End vão pro primeiro/último
  if (!_openMenu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [..._openMenu.querySelectorAll('.sl-menu-item:not([disabled])')];
  if (!items.length) return;
  e.preventDefault(); e.stopPropagation();
  const i = items.indexOf(document.activeElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
  items[next].focus();
}
export function openMenu(anchor, items, { align = 'left', className = '', onClose, minWidth } = {}) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'sl-menu ' + className;
  if (minWidth) m.style.minWidth = minWidth + 'px';
  if (onClose) { const rm = m.remove.bind(m); m.remove = () => { rm(); onClose(); }; }
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sl-menu-sep'; m.appendChild(s); continue; }
    if (it.heading) { const h = document.createElement('div'); h.className = 'sl-menu-heading'; h.textContent = it.heading; m.appendChild(h); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sl-menu-item' + (it.danger ? ' is-danger' : '') + (it.active ? ' is-active' : '');
    b.setAttribute('role', 'menuitem');
    b.disabled = !!it.disabled;
    b.innerHTML = (it.icon || '') + `<span${it.style ? ` style="${esc(it.style)}"` : ''}>${esc(it.label)}</span>` + (it.hint ? `<span class="sl-menu-hint">${esc(it.hint)}</span>` : '');
    if (it.indent) b.classList.add('is-indent');
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  // Nunca maior que a tela (rola por dentro se precisar)
  m.style.maxHeight = (innerHeight - 16) + 'px';
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = r.top - mh - 6 >= 8 ? r.top - mh - 6 : Math.max(8, innerHeight - 8 - mh);
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  _openMenu = m;
  setTimeout(() => {
    document.addEventListener('mousedown', _menuOutside, true);
    document.addEventListener('keydown', _menuKey, true);
    const f = m.querySelector('.sl-menu-item.is-active:not([disabled])') || m.querySelector('.sl-menu-item:not([disabled])');
    if (f) { f.focus({ preventScroll: true }); if (f.classList.contains('is-active')) f.scrollIntoView({ block: 'nearest' }); }
  }, 0);
  return m;
}

/* Popover com conteúdo livre ancorado num botão. */
export function openPopover(anchor, content, { align = 'left', onClose } = {}) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'sl-menu sl-popover';
  if (typeof content === 'string') m.innerHTML = content; else m.appendChild(content);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  _openMenu = m;
  const origRemove = m.remove.bind(m);
  m.remove = () => { origRemove(); if (onClose) onClose(); };
  setTimeout(() => {
    document.addEventListener('mousedown', _menuOutside, true);
    document.addEventListener('keydown', _menuKey, true);
  }, 0);
  return m;
}

export function readPref(k, def) { try { return localStorage.getItem('rework-slides-' + k) || def; } catch { return def; } }
export function savePref(k, v) { try { localStorage.setItem('rework-slides-' + k, v); } catch {} }

export function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Não deu pra ler o arquivo.'));
    r.readAsDataURL(file);
  });
}
export async function uploadImage(file) {
  if (!file || !/^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/i.test(file.type)) throw new Error('Escolha uma imagem PNG, JPG, GIF, WEBP ou SVG.');
  if (file.size > 25 * 1024 * 1024) throw new Error('Imagem maior que 25 MB.');
  const data = await fileToDataUri(file);
  const r = await api('/uploads', 'POST', { name: file.name, data });
  return r.url;
}
export function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
    img.onerror = () => resolve({ w: 800, h: 600 });
    img.src = src;
  });
}

/* ══ Dropdown próprio ═══════════════════════════════════════════
   A lista do <select> nativo é desenhada pelo sistema (branca, destaque
   azul) e não aceita estilo. Cada <select> do Presentations ganha um botão
   e uma lista no visual dos menus; o <select> continua sendo a fonte de
   verdade (value, change, disabled, hidden), então nenhum código muda. */
const DD = Symbol('slDropdown');
const DD_CHEVRON = '<svg class="sl-dd-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const DD_CHECK = '<svg class="sl-dd-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const SEL_PROTO = HTMLSelectElement.prototype;
const SEL_VALUE = Object.getOwnPropertyDescriptor(SEL_PROTO, 'value');
const SEL_INDEX = Object.getOwnPropertyDescriptor(SEL_PROTO, 'selectedIndex');

export function enhanceSelect(sel) {
  if (!sel || sel[DD] || sel.multiple || sel.size > 1) return;
  sel[DD] = true;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const paint = () => {
    // Mesmas classes de tamanho do select (form-control, filter-select…)
    btn.className = 'sl-dd ' + [...sel.classList].filter(c => c !== 'sl-dd-native').join(' ');
    const o = sel.options[SEL_INDEX.get.call(sel)];
    btn.innerHTML = `<span class="sl-dd-label"${o && o.getAttribute('style') ? ` style="${esc(o.getAttribute('style'))}"` : ''}>${esc(o ? o.textContent : '')}</span>${DD_CHEVRON}`;
    btn.disabled = sel.disabled;
    btn.hidden = sel.hidden;
    const label = sel.getAttribute('aria-label') || sel.title || '';
    if (label) btn.setAttribute('aria-label', label + (o ? ': ' + o.textContent : ''));
    if (sel.title) btn.title = sel.title;
  };
  // value/selectedIndex mudados por código também atualizam o botão
  Object.defineProperty(sel, 'value', { configurable: true, get() { return SEL_VALUE.get.call(this); }, set(v) { SEL_VALUE.set.call(this, v); paint(); } });
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return SEL_INDEX.get.call(this); }, set(v) { SEL_INDEX.set.call(this, v); paint(); } });
  new MutationObserver(paint).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'class', 'title'] });
  sel.addEventListener('change', paint);
  sel.classList.add('sl-dd-native');
  sel.after(btn);
  // <label for="…"> passa a abrir o dropdown
  if (sel.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(sel.id)}"]`)) l.htmlFor = '';

  const pick = (value) => {
    if (SEL_VALUE.get.call(sel) === value) return;
    SEL_VALUE.set.call(sel, value);
    paint();
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const open = () => {
    if (btn.disabled) return;
    const items = [];
    const cur = SEL_VALUE.get.call(sel);
    const add = (o, indent) => items.push({
      label: o.textContent, style: o.getAttribute('style') || '', indent,
      icon: o.value === cur ? DD_CHECK : '<span class="sl-dd-check"></span>',
      active: o.value === cur, disabled: o.disabled, onClick: () => pick(o.value)
    });
    for (const child of sel.children) {
      if (child.tagName === 'OPTGROUP') {
        if (items.length) items.push('-');
        items.push({ heading: child.label });
        for (const o of child.children) if (!o.hidden) add(o, true);
      } else if (child.tagName === 'OPTION' && !child.hidden) {
        // Opção depois de um grupo ganha uma linha antes
        if (items.length && items[items.length - 1].indent) items.push('-');
        add(child, false);
      }
    }
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('is-open');
    openMenu(btn, items, {
      className: 'sl-dd-menu', minWidth: btn.offsetWidth,
      onClose: () => { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-open'); btn._closedAt = Date.now(); }
    });
  };
  // Clicar no botão com a lista aberta só fecha
  btn.addEventListener('click', () => { if (Date.now() - (btn._closedAt || 0) < 250) return; open(); });
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); open(); }
  });
  paint();
  return btn;
}

/* Liga o dropdown em todo <select> que aparecer no app e nas janelas */
export function autoEnhanceSelects(root = document.body) {
  const scan = (node) => {
    if (!(node instanceof Element)) return;
    const list = node.matches('select') ? [node] : node.querySelectorAll('select');
    for (const s of list) if (s.closest('#sl-app, .sl-modal-overlay')) enhanceSelect(s);
  };
  scan(root);
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) scan(n); })
    .observe(root, { childList: true, subtree: true });
}
