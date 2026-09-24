/* ═══════════════════════════════════════════════════════════════════════
   reWork Docs — interface do editor
   ─────────────────────────────────
   Tudo que fica em volta do texto: barra de ferramentas, menus (Arquivo…
   Ferramentas), menu flutuante da seleção, alça dos blocos, painel de link,
   buscar e substituir, barra de tabela e colar/arrastar arquivos.

   Regras pra não travar a digitação:
     - a barra é montada UMA vez; a cada seleção só trocamos classes/rótulos,
       agrupado num requestAnimationFrame;
     - nada aqui serializa o documento inteiro por tecla.

   Depende de window.KD (standalone.js) e window.KastorWriter (bundle).
   O standalone expõe as funções que já existiam lá em KD.ui.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ed = () => window.KD && window.KD.editor;
  const ui = () => (window.KD && window.KD.ui) || {};
  const canEdit = () => ['owner', 'editor'].includes(window.KD?.myRole);
  const canComment = () => ['owner', 'editor', 'commenter'].includes(window.KD?.myRole);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD = isMac ? '⌘' : 'Ctrl';
  const kbd = (s) => s.replace(/Mod/g, MOD).replace(/Alt/g, isMac ? '⌥' : 'Alt').replace(/Shift/g, isMac ? '⇧' : 'Shift');

  /* ── Ícones (traço 2, 24×24, mesma família do resto da plataforma) ── */
  const P = (d, w) => `<svg width="${w || 16}" height="${w || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    undo: P('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: P('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    bold: P('<path d="M14 12a4 4 0 0 0 0-8H6v8"/><path d="M15 20a4 4 0 0 0 0-8H6v8Z"/>'),
    italic: P('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
    underline: P('<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" y1="20" x2="20" y2="20"/>'),
    strike: P('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>'),
    code: P('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    sup: P('<path d="m4 19 8-8"/><path d="m12 19-8-8"/><path d="M20 12h-4c0-1.5.442-2 1.5-2.5S20 8.334 20 7.002c0-.472-.17-.93-.484-1.29a2.105 2.105 0 0 0-2.617-.436c-.42.239-.738.614-.899 1.06"/>'),
    sub: P('<path d="m4 5 8 8"/><path d="m12 5-8 8"/><path d="M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>'),
    color: P('<path d="m5 17 7-14 7 14"/><line x1="7.5" y1="12" x2="16.5" y2="12"/>'),
    highlight: P('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
    link: P('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    unlink: P('<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/>'),
    comment: P('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    image: P('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
    upload: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    clip: P('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    alignL: P('<line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/>'),
    alignC: P('<line x1="21" y1="6" x2="3" y2="6"/><line x1="17" y1="12" x2="7" y2="12"/><line x1="19" y1="18" x2="5" y2="18"/>'),
    alignR: P('<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="9" y2="12"/><line x1="21" y1="18" x2="7" y2="18"/>'),
    alignJ: P('<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/>'),
    spacing: P('<path d="M3 6h4M3 18h4M5 4v16"/><line x1="11" y1="6" x2="21" y2="6"/><line x1="11" y1="12" x2="21" y2="12"/><line x1="11" y1="18" x2="21" y2="18"/>'),
    ul: P('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
    ol: P('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
    task: P('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3.5 17 2 2 4-4"/><line x1="13" y1="8" x2="21" y2="8"/><line x1="13" y1="17" x2="21" y2="17"/>'),
    outdent: P('<polyline points="7 8 3 12 7 16"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="18" x2="11" y2="18"/>'),
    indent: P('<polyline points="3 8 7 12 3 16"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="6" x2="11" y2="6"/><line x1="21" y1="18" x2="11" y2="18"/>'),
    clear: P('<path d="M4 7V4h16v3"/><path d="M5 20h6"/><path d="M13 4 8 20"/><path d="m15 15 5 5"/><path d="m20 15-5 5"/>'),
    chevron: P('<polyline points="6 9 12 15 18 9"/>', 12),
    chevR: P('<polyline points="9 18 15 12 9 6"/>', 14),
    check: P('<polyline points="20 6 9 17 4 12"/>', 14),
    plus: P('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    grip: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>`,
    trash: P('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'),
    copy: P('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    up: P('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    down: P('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
    edit: P('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    external: P('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    search: P('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    close: P('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    table: P('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'),
    rowAbove: P('<rect x="3" y="12" width="18" height="9" rx="1"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="9" y1="5" x2="15" y2="5"/>'),
    rowBelow: P('<rect x="3" y="3" width="18" height="9" rx="1"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="9" y1="19" x2="15" y2="19"/>'),
    colLeft: P('<rect x="12" y="3" width="9" height="18" rx="1"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="5" y1="9" x2="5" y2="15"/>'),
    colRight: P('<rect x="3" y="3" width="9" height="18" rx="1"/><line x1="16" y1="12" x2="22" y2="12"/><line x1="19" y1="9" x2="19" y2="15"/>'),
    rowDel: P('<rect x="3" y="8" width="18" height="8" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/>'),
    colDel: P('<rect x="8" y="3" width="8" height="18" rx="1"/><line x1="12" y1="9" x2="12" y2="15"/>'),
    merge: P('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M13 9l3 3-3 3"/>'),
    header: P('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="3" y="3" width="18" height="6" fill="currentColor" stroke="none" opacity=".35"/>'),
    hr: P('<line x1="3" y1="12" x2="21" y2="12"/>'),
    page: P('<path d="M4 4h16v6H4zM4 14h16v6H4z" stroke-dasharray="2 2"/>'),
    quote: P('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
    callout: P('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
    cols: P('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>'),
    ref: P('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
    at: P('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
    date: P('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    file: P('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>'),
    download: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    share: P('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>'),
    history: P('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
    print: P('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
    save: P('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
    rename: P('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>'),
    cut: P('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>'),
    paste: P('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
    selectAll: P('<path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1"/>'),
    pages: P('<rect x="5" y="2" width="14" height="9" rx="1"/><rect x="5" y="13" width="14" height="9" rx="1"/>'),
    ruler: P('<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>'),
    outline: P('<line x1="8" y1="6" x2="21" y2="6"/><line x1="11" y1="12" x2="21" y2="12"/><line x1="14" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="10" cy="18" r="1"/>'),
    expand: P('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    count: P('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
    keyboard: P('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>'),
    type: P('<path d="M4 7V4h16v3M9 20h6M12 4v16"/>'),
    list: P('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>')
  };

  /* ═══ Menu flutuante genérico ═══════════════════════════════════════
     Itens: { label, icon, kbd, checked, disabled, danger, run, children,
              render (fn → Element), divider, header, labelStyle }.
     Teclado: ↑ ↓ andam, → abre submenu, ← volta, Enter executa, Esc fecha. */
  const menus = [];   // pilha de menus abertos (0 = raiz)
  let menuOnClose = null;

  function closeMenus(fromLevel = 0) {
    while (menus.length > fromLevel) {
      const m = menus.pop();
      m.el.remove();
      m.anchor?.classList.remove('is-open');
    }
    if (!menus.length && menuOnClose) { const f = menuOnClose; menuOnClose = null; f(); }
  }

  function openMenu(anchor, items, opts = {}) {
    const level = opts.level || 0;
    closeMenus(level);
    if (level === 0 && opts.onClose) menuOnClose = opts.onClose;
    const el = document.createElement('div');
    el.className = 'kd-pop' + (opts.className ? ' ' + opts.className : '');
    el.setAttribute('role', 'menu');
    const entry = { el, anchor, items, level, buttons: [] };
    items.filter(Boolean).forEach((it) => {
      if (it.divider) { el.insertAdjacentHTML('beforeend', '<div class="kd-pop-sep"></div>'); return; }
      if (it.header) { el.insertAdjacentHTML('beforeend', `<div class="kd-pop-head">${esc(it.header)}</div>`); return; }
      if (it.render) { const node = it.render(() => closeMenus()); el.appendChild(node); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kd-pop-item' + (it.danger ? ' is-danger' : '') + (it.checked ? ' is-checked' : '');
      b.setAttribute('role', 'menuitem');
      if (it.disabled) b.disabled = true;
      const hasCheckCol = items.some(x => x && x.checked !== undefined);
      b.innerHTML =
        (hasCheckCol ? `<span class="kd-pop-check">${it.checked ? I.check : ''}</span>` : '') +
        (it.icon ? `<span class="kd-pop-icon">${it.icon}</span>` : '') +
        `<span class="kd-pop-label"${it.labelStyle ? ` style="${esc(it.labelStyle)}"` : ''}>${esc(it.label)}</span>` +
        (it.kbd ? `<span class="kd-pop-kbd">${esc(kbd(it.kbd))}</span>` : '') +
        (it.children ? `<span class="kd-pop-sub">${I.chevR}</span>` : '');
      if (it.children) {
        b.setAttribute('aria-haspopup', 'true');
        const openSub = () => openMenu(b, it.children, { level: level + 1, side: true });
        b.addEventListener('mouseenter', () => { clearTimeout(entry.t); entry.t = setTimeout(openSub, 120); });
        b.addEventListener('click', (e) => { e.stopPropagation(); openSub(); });
        b._openSub = openSub;
      } else {
        b.addEventListener('mouseenter', () => { clearTimeout(entry.t); entry.t = setTimeout(() => closeMenus(level + 1), 150); });
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          closeMenus();
          try { it.run && it.run(e); } catch (err) { console.error('[menu]', it.label, err); }
        });
      }
      el.appendChild(b);
      entry.buttons.push(b);
    });
    el.addEventListener('mousedown', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
    document.body.appendChild(el);
    menus.push(entry);
    anchor?.classList.add('is-open');
    placePopover(el, anchor, opts.side ? 'right' : (opts.align || 'left'));
    if (opts.focus !== false && opts.keyboard) entry.buttons.find(b => !b.disabled)?.focus();
    return el;
  }

  /* Posiciona um popover fixo junto do âncora, sem sair da tela. */
  function placePopover(el, anchor, where) {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x, y;
    if (where === 'right') {
      x = r.right + 2; y = r.top - 5;
      if (x + w > innerWidth - 8) x = r.left - w - 2;
    } else {
      x = where === 'right-align' ? r.right - w : r.left; y = r.bottom + 4;
      if (y + h > innerHeight - 8 && r.top - h - 4 > 8) y = r.top - h - 4;
    }
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    y = Math.max(8, Math.min(y, innerHeight - h - 8));
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }

  document.addEventListener('mousedown', (e) => {
    if (!menus.length) return;
    if (e.target.closest('.kd-pop') || menus.some(m => m.anchor && m.anchor.contains(e.target))) return;
    closeMenus();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!menus.length) return;
    const top = menus[menus.length - 1];
    if (e.key !== 'Escape' && e.target.closest && e.target.closest('.kd-picker')) return;
    const btns = top.buttons.filter(b => !b.disabled);
    const idx = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const a = top.anchor; closeMenus(menus.length - 1); if (menus.length) a?.focus(); else ed()?.commands.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); (btns[(idx + 1) % btns.length] || btns[0])?.focus(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); (btns[(idx - 1 + btns.length) % btns.length] || btns[btns.length - 1])?.focus(); return; }
    if (e.key === 'ArrowRight' && document.activeElement?._openSub) {
      e.preventDefault(); document.activeElement._openSub();
      setTimeout(() => menus[menus.length - 1]?.buttons.find(b => !b.disabled)?.focus(), 0); return;
    }
    if (e.key === 'ArrowLeft' && menus.length > 1) { e.preventDefault(); const a = top.anchor; closeMenus(menus.length - 1); a?.focus(); }
  }, true);
  window.addEventListener('resize', () => closeMenus());

  /* ═══ Estado do editor (lido na sincronização) ══════════════════════ */
  const FONTS = [
    ['', 'Padrão'],
    ['Arial, sans-serif', 'Arial'],
    ['"Inter", sans-serif', 'Inter'],
    ['"Geist", sans-serif', 'Geist'],
    ['Georgia, serif', 'Georgia'],
    ['"Times New Roman", Times, serif', 'Times New Roman'],
    ['Verdana, sans-serif', 'Verdana'],
    ['"Trebuchet MS", sans-serif', 'Trebuchet MS'],
    ['"Courier New", Courier, monospace', 'Courier New'],
    ['"Roboto", sans-serif', 'Roboto'],
    ['"Open Sans", sans-serif', 'Open Sans']
  ];
  const STYLES = [
    { key: 'p',  label: 'Texto normal', kbd: 'Mod+Alt+0', css: 'font-size:13px' },
    { key: 'h1', label: 'Título 1', kbd: 'Mod+Alt+1', css: 'font-size:20px;font-weight:700' },
    { key: 'h2', label: 'Título 2', kbd: 'Mod+Alt+2', css: 'font-size:17px;font-weight:700' },
    { key: 'h3', label: 'Título 3', kbd: 'Mod+Alt+3', css: 'font-size:15px;font-weight:700' },
    { key: 'h4', label: 'Título 4', kbd: 'Mod+Alt+4', css: 'font-size:13.5px;font-weight:700' }
  ];
  const SPACINGS = [['1', 'Simples'], ['1.15', '1,15'], ['1.5', '1,5'], ['2', 'Duplo']];

  const cur = {
    style() {
      const e = ed(); if (!e) return 'p';
      for (let l = 1; l <= 4; l++) if (e.isActive('heading', { level: l })) return 'h' + l;
      return 'p';
    },
    align() {
      const e = ed(); if (!e) return 'left';
      for (const a of ['center', 'right', 'justify']) if (e.isActive({ textAlign: a })) return a;
      return 'left';
    },
    spacing() {
      const e = ed(); if (!e) return null;
      const $f = e.state.selection.$from;
      return $f.parent.attrs?.lineHeight || null;
    },
    font() { return ed()?.getAttributes('textStyle')?.fontFamily || ''; }
  };

  function setStyle(key) {
    const e = ed(); if (!e) return;
    if (key === 'p') e.chain().focus().setParagraph().run();
    else e.chain().focus().setNode('heading', { level: Number(key.slice(1)) }).run();
  }
  function setFont(v) {
    const e = ed(); if (!e) return;
    v ? e.chain().focus().setFontFamily(v).run() : e.chain().focus().unsetFontFamily().run();
  }
  function indent(dir) {
    const e = ed(); if (!e) return;
    const listType = e.isActive('taskItem') ? 'taskItem' : 'listItem';
    if (e.isActive('bulletList') || e.isActive('orderedList') || e.isActive('taskList')) {
      dir > 0 ? e.chain().focus().sinkListItem(listType).run() : e.chain().focus().liftListItem(listType).run();
      return;
    }
    const cur = Number(e.state.selection.$from.parent.attrs?.indentLeft || 0);
    e.chain().focus().setBlockIndent({ indentLeft: Math.max(0, cur + dir * 12.5) }).run();
  }
  function clearFormatting() {
    ed()?.chain().focus().unsetAllMarks().setParagraph().run();
  }

  /* ═══ Barra de ferramentas ═════════════════════════════════════════ */
  function tbBtn(cmd, icon, title, extra = '') {
    return `<button type="button" class="kd-tb-btn" data-cmd="${cmd}" title="${esc(kbd(title))}" aria-label="${esc(title.replace(/ \(.*\)$/, ''))}"${extra}>${icon}</button>`;
  }
  const SEP = '<span class="kd-tb-sep" aria-hidden="true"></span>';

  function buildToolbar() {
    const tb = $('writer-editor-toolbar');
    if (!tb || tb._kdBuilt) return;
    tb._kdBuilt = true;
    tb.setAttribute('role', 'toolbar');
    tb.setAttribute('aria-label', 'Formatação');
    tb.innerHTML = `
      <div class="kd-tb-group">
        ${tbBtn('undo', I.undo, 'Desfazer (Mod+Z)')}
        ${tbBtn('redo', I.redo, 'Refazer (Mod+Y)')}
      </div>${SEP}
      <div class="kd-tb-group">
        <button type="button" class="kd-tb-drop kd-tb-drop--style" data-cmd="styleMenu" title="Estilo do parágrafo"><span data-label="style">Texto normal</span>${I.chevron}</button>
        <button type="button" class="kd-tb-drop kd-tb-drop--font" data-cmd="fontMenu" title="Fonte"><span data-label="font">Padrão</span>${I.chevron}</button>
        <div class="kd-tb-size" title="Tamanho da fonte">
          <button type="button" class="kd-tb-size-btn" data-cmd="sizeDown" aria-label="Diminuir fonte">−</button>
          <input type="text" class="kd-tb-size-input writer-tb-fs-input" inputmode="decimal" aria-label="Tamanho da fonte" value="11">
          <button type="button" class="kd-tb-size-btn" data-cmd="sizeUp" aria-label="Aumentar fonte">+</button>
        </div>
      </div>${SEP}
      <div class="kd-tb-group">
        ${tbBtn('bold', I.bold, 'Negrito (Mod+B)', ' data-mark="bold"')}
        ${tbBtn('italic', I.italic, 'Itálico (Mod+I)', ' data-mark="italic"')}
        ${tbBtn('underline', I.underline, 'Sublinhado (Mod+U)', ' data-mark="underline"')}
        ${tbBtn('strike', I.strike, 'Tachado (Mod+Shift+S)', ' data-mark="strike"')}
        <button type="button" class="kd-tb-btn kd-tb-color" data-cmd="textColor" title="Cor do texto" aria-label="Cor do texto">${I.color}<span class="kd-tb-colorbar" data-colorbar="text"></span></button>
        <button type="button" class="kd-tb-btn kd-tb-color" data-cmd="highlight" title="Cor de destaque" aria-label="Cor de destaque">${I.highlight}<span class="kd-tb-colorbar" data-colorbar="highlight"></span></button>
        ${tbBtn('moreText', I.chevron, 'Mais opções de texto')}
      </div>${SEP}
      <div class="kd-tb-group">
        ${tbBtn('link', I.link, 'Link (Mod+K)', ' data-mark="link"')}
        ${tbBtn('comment', I.comment, 'Comentar (Mod+Alt+M)')}
        ${tbBtn('imageMenu', I.image, 'Inserir imagem')}
        ${tbBtn('tableMenu', I.table, 'Inserir tabela')}
      </div>${SEP}
      <div class="kd-tb-group">
        <button type="button" class="kd-tb-btn kd-tb-btn--caret" data-cmd="alignMenu" title="Alinhamento" aria-label="Alinhamento"><span data-label="align">${I.alignL}</span>${I.chevron}</button>
        ${tbBtn('spacingMenu', I.spacing, 'Espaçamento entre linhas')}
        ${tbBtn('bulletList', I.ul, 'Lista com marcadores (Mod+Shift+8)', ' data-node="bulletList"')}
        ${tbBtn('orderedList', I.ol, 'Lista numerada (Mod+Shift+7)', ' data-node="orderedList"')}
        ${tbBtn('taskList', I.task, 'Lista de tarefas (Mod+Shift+9)', ' data-node="taskList"')}
        ${tbBtn('outdent', I.outdent, 'Diminuir recuo (Shift+Tab)')}
        ${tbBtn('indent', I.indent, 'Aumentar recuo (Tab)')}
      </div>${SEP}
      <div class="kd-tb-group">
        ${tbBtn('clear', I.clear, 'Limpar formatação (Mod+\\)')}
      </div>
      <div class="kd-tb-spacer"></div>
      <div class="kd-tb-group">
        ${tbBtn('find', I.search, 'Buscar e substituir (Mod+H)')}
      </div>`;
    tb.addEventListener('mousedown', (e) => {
      // Botões não roubam o foco do texto (a seleção continua visível)
      if (e.target.closest('button') && !e.target.closest('input')) e.preventDefault();
    });
    tb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b || b.disabled) return;
      runToolbar(b.dataset.cmd, b, e);
    });
    // Tamanho da fonte — mesmo comportamento de antes (Enter aplica, menu de tamanhos no foco)
    const inp = tb.querySelector('.kd-tb-size-input');
    const apply = () => ui().fontSizeApply?.(inp.value);
    inp.addEventListener('change', apply);
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); apply(); inp.blur(); ed()?.commands.focus(); }
      else if (ev.key === 'Escape') { ui().fontSizeMenuClose?.(); inp.blur(); }
    });
    inp.addEventListener('focus', () => { inp.select(); ui().fontSizeMenuOpen?.(inp); });
    inp.addEventListener('blur', (ev) => {
      if (ev.relatedTarget && ev.relatedTarget.closest('.kd-fontsize-menu')) return;
      apply(); ui().fontSizeMenuClose?.();
    });
  }

  function runToolbar(cmd, btn, ev) {
    const e = ed(); if (!e) return;
    const c = () => e.chain().focus();
    switch (cmd) {
      case 'undo': return c().undo().run();
      case 'redo': return c().redo().run();
      case 'bold': return c().toggleBold().run();
      case 'italic': return c().toggleItalic().run();
      case 'underline': return c().toggleUnderline().run();
      case 'strike': return c().toggleStrike().run();
      case 'bulletList': return c().toggleBulletList().run();
      case 'orderedList': return c().toggleOrderedList().run();
      case 'taskList': return c().toggleTaskList().run();
      case 'outdent': return indent(-1);
      case 'indent': return indent(1);
      case 'clear': return clearFormatting();
      case 'sizeUp': return ui().fontSizeStep?.(1);
      case 'sizeDown': return ui().fontSizeStep?.(-1);
      case 'textColor': return ui().colorPicker?.({ currentTarget: btn, stopPropagation() {} }, 'text');
      case 'highlight': return ui().colorPicker?.({ currentTarget: btn, stopPropagation() {} }, 'highlight');
      case 'link': return linkEditor.openForSelection();
      case 'comment': return ui().comment?.();
      case 'find': return findPanel.open(true);
      case 'styleMenu':
        return openMenu(btn, STYLES.map(s => ({ label: s.label, labelStyle: s.css, kbd: s.kbd, checked: cur.style() === s.key, run: () => setStyle(s.key) })), { className: 'kd-pop--styles' });
      case 'fontMenu':
        return openMenu(btn, FONTS.map(([v, l]) => ({ label: l, labelStyle: v ? 'font-family:' + v : '', checked: cur.font() === v, run: () => setFont(v) })), { className: 'kd-pop--fonts' });
      case 'moreText':
        return openMenu(btn, textMoreItems());
      case 'alignMenu':
        return openMenu(btn, alignItems());
      case 'spacingMenu':
        return openMenu(btn, spacingItems());
      case 'imageMenu':
        return openMenu(btn, imageItems());
      case 'tableMenu':
        return openMenu(btn, [{ render: tableGridPicker }], { className: 'kd-pop--grid' });
    }
  }

  function textMoreItems() {
    const e = ed();
    return [
      { label: 'Código', icon: I.code, kbd: 'Mod+E', checked: !!e?.isActive('code'), run: () => e.chain().focus().toggleCode().run() },
      { label: 'Sobrescrito', icon: I.sup, kbd: 'Mod+.', checked: !!e?.isActive('superscript'), run: () => e.chain().focus().toggleSuperscript().run() },
      { label: 'Subscrito', icon: I.sub, kbd: 'Mod+,', checked: !!e?.isActive('subscript'), run: () => e.chain().focus().toggleSubscript().run() }
    ];
  }
  function alignItems() {
    const a = cur.align(), e = ed();
    return [
      { label: 'Esquerda', icon: I.alignL, kbd: 'Mod+Shift+L', checked: a === 'left', run: () => e.chain().focus().setTextAlign('left').run() },
      { label: 'Centro', icon: I.alignC, kbd: 'Mod+Shift+E', checked: a === 'center', run: () => e.chain().focus().setTextAlign('center').run() },
      { label: 'Direita', icon: I.alignR, kbd: 'Mod+Shift+R', checked: a === 'right', run: () => e.chain().focus().setTextAlign('right').run() },
      { label: 'Justificado', icon: I.alignJ, kbd: 'Mod+Shift+J', checked: a === 'justify', run: () => e.chain().focus().setTextAlign('justify').run() }
    ];
  }
  function spacingItems() {
    const s = cur.spacing(), e = ed();
    return SPACINGS.map(([v, l]) => ({ label: l, checked: (s || '1.15') === v, run: () => e.chain().focus().setLineHeight(v === '1.15' ? null : v).run() }));
  }
  function imageItems() {
    return [
      { label: 'Enviar do computador', icon: I.upload, run: () => ui().pickFile?.('image/*') },
      { label: 'Da Galeria', icon: I.clip, run: () => ui().gallery?.('image') },
      { label: 'Por URL…', icon: I.link, run: () => ui().prompt?.('URL da imagem', 'https://', (url) => { if (url) ed()?.chain().focus().setImage({ src: url }).run(); }) }
    ];
  }

  /* Grade 8×8 pra escolher o tamanho da tabela (igual ao Google Docs). */
  function tableGridPicker(close) {
    const wrap = document.createElement('div');
    wrap.className = 'kd-grid-picker';
    const N = 8;
    wrap.innerHTML = `<div class="kd-grid-cells">${Array.from({ length: N * N }, (_, i) => `<span data-r="${Math.floor(i / N) + 1}" data-c="${i % N + 1}"></span>`).join('')}</div><div class="kd-grid-label">Escolha o tamanho</div>`;
    const cells = wrap.querySelectorAll('span');
    const label = wrap.querySelector('.kd-grid-label');
    wrap.addEventListener('mouseover', (e) => {
      const s = e.target.closest('span[data-r]'); if (!s) return;
      const r = +s.dataset.r, c = +s.dataset.c;
      cells.forEach(x => x.classList.toggle('is-on', +x.dataset.r <= r && +x.dataset.c <= c));
      label.textContent = c + ' × ' + r;
    });
    wrap.addEventListener('click', (e) => {
      const s = e.target.closest('span[data-r]'); if (!s) return;
      close();
      ed()?.chain().focus().insertTable({ rows: +s.dataset.r, cols: +s.dataset.c, withHeaderRow: +s.dataset.r > 1 }).run();
    });
    return wrap;
  }

  /* Sincroniza a barra com a seleção — só classes e rótulos, num rAF. */
  let syncRaf = 0;
  function scheduleSync() {
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(() => { syncRaf = 0; syncToolbar(); bubble.update(); linkEditor.update(); tableBar.update(); });
  }
  function syncToolbar() {
    const tb = $('writer-editor-toolbar'), e = ed();
    if (!tb || !tb._kdBuilt || !e) return;
    tb.querySelectorAll('[data-mark]').forEach(b => b.classList.toggle('is-active', e.isActive(b.dataset.mark)));
    tb.querySelectorAll('[data-node]').forEach(b => b.classList.toggle('is-active', e.isActive(b.dataset.node)));
    const st = STYLES.find(s => s.key === cur.style());
    tb.querySelector('[data-label="style"]').textContent = st ? st.label : 'Texto normal';
    const f = FONTS.find(([v]) => v === cur.font());
    tb.querySelector('[data-label="font"]').textContent = f ? f[1] : (cur.font().split(',')[0].replace(/"/g, '') || 'Padrão');
    const al = cur.align();
    tb.querySelector('[data-label="align"]').innerHTML = { left: I.alignL, center: I.alignC, right: I.alignR, justify: I.alignJ }[al];
    const inp = tb.querySelector('.kd-tb-size-input');
    if (inp && document.activeElement !== inp) inp.value = ui().fmtFontSize ? ui().fmtFontSize(e.getAttributes('textStyle')?.fontSize || '11pt') : '11';
    tb.querySelector('[data-colorbar="text"]').style.background = e.getAttributes('textStyle')?.color || 'currentColor';
    tb.querySelector('[data-colorbar="highlight"]').style.background = e.getAttributes('highlight')?.color || 'transparent';
    let canUndo = true, canRedo = true;
    try { canUndo = e.can().undo(); canRedo = e.can().redo(); } catch {}
    tb.querySelector('[data-cmd="undo"]').disabled = !canUndo;
    tb.querySelector('[data-cmd="redo"]').disabled = !canRedo;
  }

  /* ═══ Menu da seleção (aparece sobre o texto selecionado) ═════════ */
  const bubble = {
    el: null,
    mouseDown: false,
    build() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'kd-bubble';
      el.hidden = true;
      el.innerHTML = `
        <button type="button" class="kd-bubble-drop" data-b="style"><span data-label="bstyle">Texto</span>${I.chevron}</button>
        <span class="kd-bubble-sep"></span>
        <button type="button" data-b="bold" data-mark="bold" title="Negrito">${I.bold}</button>
        <button type="button" data-b="italic" data-mark="italic" title="Itálico">${I.italic}</button>
        <button type="button" data-b="underline" data-mark="underline" title="Sublinhado">${I.underline}</button>
        <button type="button" data-b="strike" data-mark="strike" title="Tachado">${I.strike}</button>
        <span class="kd-bubble-sep"></span>
        <button type="button" data-b="link" data-mark="link" title="Link">${I.link}</button>
        <button type="button" data-b="color" title="Cor do texto">${I.color}</button>
        <button type="button" data-b="highlight" title="Destaque">${I.highlight}</button>
        <span class="kd-bubble-sep" data-comment-sep></span>
        <button type="button" class="kd-bubble-text" data-b="comment" title="Comentar">${I.comment}<span>Comentar</span></button>
        <button type="button" class="kd-bubble-text" data-b="demand" title="Transformar o trecho numa demanda">${I.plus}<span>Criar demanda</span></button>`;
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-b]'); if (!b) return;
        const x = ed(); if (!x) return;
        const k = b.dataset.b;
        if (k === 'bold') x.chain().focus().toggleBold().run();
        else if (k === 'italic') x.chain().focus().toggleItalic().run();
        else if (k === 'underline') x.chain().focus().toggleUnderline().run();
        else if (k === 'strike') x.chain().focus().toggleStrike().run();
        else if (k === 'link') linkEditor.openForSelection();
        else if (k === 'color') ui().colorPicker?.({ currentTarget: b, stopPropagation() {} }, 'text');
        else if (k === 'highlight') ui().colorPicker?.({ currentTarget: b, stopPropagation() {} }, 'highlight');
        else if (k === 'comment') { this.hide(); ui().comment?.(); }
        else if (k === 'demand') { this.hide(); ui().createDemand?.(); }
        else if (k === 'style') openMenu(b, STYLES.map(s => ({ label: s.label, labelStyle: s.css, checked: cur.style() === s.key, run: () => setStyle(s.key) })), { className: 'kd-pop--styles' });
        scheduleSync();
      });
      document.body.appendChild(el);
      this.el = el;
      document.addEventListener('mousedown', (e) => { if (e.target.closest('.ProseMirror')) { this.mouseDown = true; this.hide(); } });
      document.addEventListener('mouseup', () => { if (this.mouseDown) { this.mouseDown = false; setTimeout(() => this.update(), 0); } });
    },
    hide() { if (this.el) this.el.hidden = true; },
    update() {
      const e = ed();
      if (!this.el || !e) return;
      const sel = e.state.selection;
      const show = !sel.empty && !this.mouseDown && e.isFocused && !(window.KastorWriter?.NodeSelection && sel instanceof window.KastorWriter.NodeSelection) && !sel.$anchorCell
        && !e.isActive('codeBlock') && (canEdit() || canComment());
      if (!show) return this.hide();
      this.el.classList.toggle('is-comment-only', !canEdit());
      this.el.querySelector('[data-b="comment"]').hidden = !canComment();
      this.el.querySelector('[data-b="demand"]').hidden = !canEdit();
      this.el.querySelectorAll('[data-mark]').forEach(b => b.classList.toggle('is-active', e.isActive(b.dataset.mark)));
      const st = STYLES.find(s => s.key === cur.style());
      this.el.querySelector('[data-label="bstyle"]').textContent = st ? (st.key === 'p' ? 'Texto' : st.label) : 'Texto';
      this.el.hidden = false;
      const view = e.view;
      const a = view.coordsAtPos(sel.from), b = view.coordsAtPos(sel.to);
      const w = this.el.offsetWidth, h = this.el.offsetHeight;
      const top = Math.min(a.top, b.top);
      let x = (a.left + b.left) / 2 - w / 2;
      let y = top - h - 10;
      const area = document.querySelector('.writer-editor-scroll')?.getBoundingClientRect();
      if (area && y < area.top + 4) y = Math.max(a.bottom, b.bottom) + 10;
      x = Math.max(8, Math.min(x, innerWidth - w - 8));
      this.el.style.left = x + 'px'; this.el.style.top = y + 'px';
    }
  };

  /* ═══ Painel de link (editar / abrir / remover) ════════════════════ */
  const linkEditor = {
    el: null,
    editing: false,
    build() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'kd-linkpop';
      el.hidden = true;
      document.body.appendChild(el);
      el.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
      this.el = el;
    },
    hide() { if (this.el) { this.el.hidden = true; this.editing = false; } },
    place(pos) {
      const e = ed(); if (!e) return;
      const c = e.view.coordsAtPos(pos);
      const w = this.el.offsetWidth;
      this.el.style.left = Math.max(8, Math.min(c.left - 12, innerWidth - w - 8)) + 'px';
      this.el.style.top = (c.bottom + 8) + 'px';
    },
    /* Cursor dentro de um link → mostra o endereço com ações */
    update() {
      const e = ed();
      if (!this.el || !e || this.editing) return;
      const sel = e.state.selection;
      if (!sel.empty || !e.isActive('link') || !e.isFocused) return this.hide();
      const href = e.getAttributes('link').href || '';
      this.el.innerHTML = `
        <span class="kd-linkpop-icon">${I.link}</span>
        <a class="kd-linkpop-url" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(href)}">${esc(href.replace(/^https?:\/\//, ''))}</a>
        <span class="kd-linkpop-actions">
          <button type="button" data-l="copy" title="Copiar link">${I.copy}</button>
          ${canEdit() ? `<button type="button" data-l="edit" title="Editar link">${I.edit}</button><button type="button" data-l="remove" title="Remover link">${I.unlink}</button>` : ''}
        </span>`;
      this.el.onclick = (ev) => {
        const b = ev.target.closest('[data-l]'); if (!b) return;
        if (b.dataset.l === 'copy') { navigator.clipboard?.writeText(href).then(() => ui().toast?.('Link copiado')); }
        if (b.dataset.l === 'remove') { e.chain().focus().extendMarkRange('link').unsetLink().run(); this.hide(); }
        if (b.dataset.l === 'edit') { e.chain().extendMarkRange('link').run(); this.openForSelection(true); }
      };
      this.el.hidden = false;
      this.place(sel.from);
    },
    /* Ctrl+K / botão de link: formulário com URL (e texto, sem seleção) */
    openForSelection(fromExisting) {
      const e = ed(); if (!e || !canEdit()) return;
      this.build();
      const sel = e.state.selection;
      const href = e.getAttributes('link').href || '';
      const needsText = sel.empty && !e.isActive('link');
      this.editing = true;
      bubble.hide();
      this.el.innerHTML = `
        <form class="kd-linkform">
          ${needsText ? '<input class="kd-linkform-input" name="text" placeholder="Texto" autocomplete="off">' : ''}
          <input class="kd-linkform-input" name="url" placeholder="Cole ou digite um link" value="${esc(href)}" autocomplete="off" spellcheck="false">
          <button type="submit" class="btn btn-primary btn-sm">Aplicar</button>
        </form>`;
      this.el.hidden = false;
      this.place(sel.from);
      const form = this.el.querySelector('form');
      const urlIn = form.querySelector('[name="url"]');
      (form.querySelector('[name="text"]') || urlIn).focus();
      urlIn.select();
      form.onsubmit = (ev) => {
        ev.preventDefault();
        let url = urlIn.value.trim();
        const text = form.querySelector('[name="text"]')?.value.trim();
        this.editing = false; this.hide();
        if (!url) { if (href) e.chain().focus().extendMarkRange('link').unsetLink().run(); else e.commands.focus(); return; }
        if (!/^(https?:|mailto:|tel:|\/|#)/i.test(url)) url = 'https://' + url;
        if (needsText) {
          e.chain().focus().insertContent({ type: 'text', text: text || url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
        } else {
          e.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }
      };
      form.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); this.editing = false; this.hide(); e.commands.focus(); } };
      const outside = (ev) => {
        if (this.el.contains(ev.target)) return;
        document.removeEventListener('mousedown', outside, true);
        if (this.editing) { this.editing = false; this.hide(); }
      };
      setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    }
  };

  /* ═══ Buscar e substituir ══════════════════════════════════════════ */
  const findPanel = {
    el: null,
    build() {
      if (this.el) return;
      const host = document.querySelector('.writer-editor-center');
      if (!host) return;
      const el = document.createElement('div');
      el.className = 'kd-find';
      el.hidden = true;
      el.innerHTML = `
        <div class="kd-find-row">
          <span class="kd-find-icon">${I.search}</span>
          <input class="kd-find-input" data-f="term" placeholder="Buscar no documento" autocomplete="off" spellcheck="false">
          <span class="kd-find-count" data-f="count"></span>
          <button type="button" class="kd-find-btn" data-f="case" title="Diferenciar maiúsculas">Aa</button>
          <button type="button" class="kd-find-btn" data-f="prev" title="Anterior (Shift+Enter)">${I.up}</button>
          <button type="button" class="kd-find-btn" data-f="next" title="Próximo (Enter)">${I.down}</button>
          <button type="button" class="kd-find-btn" data-f="toggle" title="Substituir">${I.edit}</button>
          <button type="button" class="kd-find-btn" data-f="close" title="Fechar (Esc)">${I.close}</button>
        </div>
        <div class="kd-find-row" data-f="replaceRow" hidden>
          <span class="kd-find-icon"></span>
          <input class="kd-find-input" data-f="with" placeholder="Substituir por" autocomplete="off" spellcheck="false">
          <button type="button" class="btn btn-ghost btn-sm" data-f="one">Substituir</button>
          <button type="button" class="btn btn-ghost btn-sm" data-f="all">Substituir tudo</button>
        </div>`;
      host.appendChild(el);
      this.el = el;
      const q = (k) => el.querySelector(`[data-f="${k}"]`);
      q('term').addEventListener('input', () => this.search());
      q('term').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      });
      q('with').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.replace(false); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-f]'); if (!b) return;
        const k = b.dataset.f;
        if (k === 'next') this.step(1);
        if (k === 'prev') this.step(-1);
        if (k === 'close') this.close();
        if (k === 'one') this.replace(false);
        if (k === 'all') this.replace(true);
        if (k === 'toggle') this.showReplace(q('replaceRow').hidden);
        if (k === 'case') { b.classList.toggle('is-on'); this.search(); }
      });
    },
    showReplace(on) {
      const row = this.el.querySelector('[data-f="replaceRow"]');
      row.hidden = !on || !canEdit();
      this.el.querySelector('[data-f="toggle"]').classList.toggle('is-on', !row.hidden);
      if (!row.hidden) this.el.querySelector('[data-f="with"]').focus();
    },
    open(withReplace) {
      this.build(); if (!this.el) return;
      const e = ed();
      this.el.hidden = false;
      const term = this.el.querySelector('[data-f="term"]');
      const sel = e?.state.selection;
      if (sel && !sel.empty) {
        const t = e.state.doc.textBetween(sel.from, sel.to, ' ');
        if (t && t.length < 80 && !t.includes('\n')) term.value = t;
      }
      this.showReplace(!!withReplace && canEdit());
      this.el.querySelector('[data-f="toggle"]').hidden = !canEdit();
      term.focus(); term.select();
      this.search();
    },
    close() {
      if (!this.el || this.el.hidden) return;
      this.el.hidden = true;
      ed()?.commands.setSearchTerm('');
      ed()?.commands.focus();
    },
    search() {
      const e = ed(); if (!e || !this.el) return;
      const term = this.el.querySelector('[data-f="term"]').value;
      e.commands.setSearchTerm(term, this.el.querySelector('[data-f="case"]').classList.contains('is-on'));
      this.paint(true);
    },
    step(dir) { ed()?.commands.searchStep(dir); this.paint(true); },
    replace(all) {
      const e = ed(); if (!e || !canEdit()) return;
      const w = this.el.querySelector('[data-f="with"]').value;
      const n = e.storage.kdSearch.results.length;
      if (!n) return;
      all ? e.commands.replaceAll(w) : e.commands.replaceCurrent(w);
      if (all) ui().toast?.(n === 1 ? '1 ocorrência substituída' : n + ' ocorrências substituídas');
      this.paint(true);
    },
    paint(scroll) {
      const e = ed(); if (!e || !this.el) return;
      const st = e.storage.kdSearch;
      const n = st.results.length;
      const count = this.el.querySelector('[data-f="count"]');
      count.textContent = st.term ? (n ? (st.index + 1) + ' de ' + n : 'Nenhum resultado') : '';
      count.classList.toggle('is-empty', !!st.term && !n);
      if (scroll && n) requestAnimationFrame(() => {
        document.querySelector('.kd-find-hit.is-current')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  };

  /* ═══ Barra da tabela (aparece quando o cursor está numa tabela) ═══ */
  const tableBar = {
    el: null,
    build() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'kd-tablebar';
      el.hidden = true;
      const B = (k, icon, title) => `<button type="button" data-t="${k}" title="${title}">${icon}</button>`;
      el.innerHTML =
        B('addRowBefore', I.rowAbove, 'Inserir linha acima') + B('addRowAfter', I.rowBelow, 'Inserir linha abaixo') +
        B('addColumnBefore', I.colLeft, 'Inserir coluna à esquerda') + B('addColumnAfter', I.colRight, 'Inserir coluna à direita') +
        '<span class="kd-bubble-sep"></span>' +
        B('deleteRow', I.rowDel, 'Excluir linha') + B('deleteColumn', I.colDel, 'Excluir coluna') +
        '<span class="kd-bubble-sep"></span>' +
        B('mergeOrSplit', I.merge, 'Mesclar / dividir células') + B('toggleHeaderRow', I.header, 'Linha de cabeçalho') +
        '<span class="kd-bubble-sep"></span>' +
        B('deleteTable', I.trash, 'Excluir tabela');
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-t]'); if (!b) return;
        const x = ed(); if (!x) return;
        try { x.chain().focus()[b.dataset.t]().run(); } catch (err) { console.warn(err); }
        scheduleSync();
      });
      document.body.appendChild(el);
      this.el = el;
    },
    update() {
      const e = ed();
      if (!this.el || !e) return;
      if (!canEdit() || !e.isActive('table') || !e.isFocused) { this.el.hidden = true; return; }
      const $f = e.state.selection.$from;
      let dom = null;
      for (let d = $f.depth; d > 0; d--) {
        if ($f.node(d).type.name === 'table') { dom = e.view.nodeDOM($f.before(d)); break; }
      }
      if (!dom || dom.nodeType !== 1) { this.el.hidden = true; return; }
      const r = dom.getBoundingClientRect();
      const area = document.querySelector('.writer-editor-scroll')?.getBoundingClientRect();
      this.el.hidden = false;
      const h = this.el.offsetHeight;
      let y = r.top - h - 8;
      if (area && y < area.top + 4) y = area.top + 4;
      if (area && y > area.bottom - h) { this.el.hidden = true; return; }
      this.el.style.left = Math.max(8, r.left) + 'px';
      this.el.style.top = y + 'px';
      const merge = this.el.querySelector('[data-t="mergeOrSplit"]');
      let can = true; try { can = e.can().mergeOrSplit(); } catch {}
      merge.disabled = !can;
    }
  };

  /* ═══ Alça dos blocos (+ e ⋮⋮ à esquerda de cada bloco) ════════════
     Aparece com o mouse sobre um bloco de nível 1. "+" abre o menu "/"
     numa linha nova logo abaixo; "⋮⋮" abre ações do bloco e pode ser
     arrastado pra mover o bloco. */
  const handle = {
    el: null, pos: null, hideT: 0,
    build() {
      if (this.el) return;
      const el = document.createElement('div');
      el.className = 'kd-handle';
      el.hidden = true;
      el.innerHTML = `<button type="button" class="kd-handle-btn" data-h="add" title="Inserir bloco abaixo">${I.plus}</button>
        <button type="button" class="kd-handle-btn kd-handle-grip" data-h="menu" draggable="true" title="Arraste pra mover · clique pra opções">${I.grip}</button>`;
      el.addEventListener('mousedown', (e) => { if (e.target.closest('[data-h="add"]')) e.preventDefault(); });
      el.addEventListener('mouseenter', () => clearTimeout(this.hideT));
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-h]'); if (!b || this.pos == null) return;
        if (b.dataset.h === 'add') this.addBelow();
        else this.openMenu(b);
      });
      const grip = el.querySelector('[data-h="menu"]');
      grip.addEventListener('dragstart', (e) => this.dragStart(e));
      grip.addEventListener('dragend', () => { el.hidden = true; });
      document.body.appendChild(el);
      this.el = el;

      const scroll = document.querySelector('.writer-editor-scroll');
      if (!scroll) return;
      scroll.addEventListener('mousemove', (e) => this.onMove(e));
      scroll.addEventListener('mouseleave', (e) => {
        if (e.relatedTarget && this.el.contains(e.relatedTarget)) return;
        this.hideT = setTimeout(() => { if (!menus.length) this.el.hidden = true; }, 200);
      });
      scroll.addEventListener('scroll', () => { this.el.hidden = true; });
      document.addEventListener('keydown', () => { if (!menus.length && this.el) this.el.hidden = true; });
    },
    onMove(ev) {
      const e = ed();
      if (!e || !canEdit() || menus.length) return;
      const paper = document.querySelector('.writer-editor-paper');
      const pm = paper?.querySelector('.ProseMirror');
      if (!pm) return;
      const pr = pm.getBoundingClientRect();
      if (ev.clientY < pr.top || ev.clientY > pr.bottom) { this.el.hidden = true; return; }
      const hit = e.view.posAtCoords({ left: pr.left + 8, top: ev.clientY });
      if (!hit) return;
      const $p = e.state.doc.resolve(Math.min(hit.pos, e.state.doc.content.size));
      const start = $p.depth >= 1 ? $p.before(1) : (hit.inside >= 0 ? hit.inside : null);
      if (start == null) return;
      const node = e.state.doc.nodeAt(start);
      const dom = e.view.nodeDOM(start);
      if (!node || !dom || dom.nodeType !== 1) return;
      this.pos = start;
      const r = dom.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(dom).lineHeight) || 22;
      clearTimeout(this.hideT);
      this.el.hidden = false;
      this.el.style.left = (pr.left - this.el.offsetWidth - 10) + 'px';
      this.el.style.top = (r.top + Math.min(r.height, lh) / 2 - this.el.offsetHeight / 2) + 'px';
    },
    block() {
      const e = ed(); if (!e || this.pos == null) return null;
      const node = e.state.doc.nodeAt(this.pos);
      return node ? { e, node, pos: this.pos, end: this.pos + node.nodeSize } : null;
    },
    addBelow() {
      const b = this.block(); if (!b) return;
      const { e, node, pos, end } = b;
      if (node.type.name === 'paragraph' && node.content.size === 0) {
        e.chain().focus().setTextSelection(pos + 1).insertContent('/').run();
      } else {
        e.chain().focus().insertContentAt(end, { type: 'paragraph' }).setTextSelection(end + 1).insertContent('/').run();
      }
      this.el.hidden = true;
    },
    openMenu(anchor) {
      const b = this.block(); if (!b) return;
      const { e, node, pos, end } = b;
      const idx = e.state.doc.resolve(pos).index(0);
      const count = e.state.doc.childCount;
      const at = () => e.chain().focus().setTextSelection(pos + 1);
      const turnInto = node.isTextblock ? [
        { label: 'Texto', icon: I.type, run: () => at().setParagraph().run() },
        { label: 'Título 1', icon: '<b class="kd-pop-h">H1</b>', run: () => at().setNode('heading', { level: 1 }).run() },
        { label: 'Título 2', icon: '<b class="kd-pop-h">H2</b>', run: () => at().setNode('heading', { level: 2 }).run() },
        { label: 'Título 3', icon: '<b class="kd-pop-h">H3</b>', run: () => at().setNode('heading', { level: 3 }).run() },
        { label: 'Lista com marcadores', icon: I.ul, run: () => at().toggleBulletList().run() },
        { label: 'Lista numerada', icon: I.ol, run: () => at().toggleOrderedList().run() },
        { label: 'Lista de tarefas', icon: I.task, run: () => at().toggleTaskList().run() },
        { label: 'Citação', icon: I.quote, run: () => at().toggleBlockquote().run() },
        { label: 'Nota', icon: I.callout, run: () => at().setCallout({ variant: 'info' }).run() }
      ] : null;
      openMenu(anchor, [
        turnInto && { label: 'Transformar em', icon: I.type, children: turnInto },
        turnInto && { divider: true },
        { label: 'Criar demanda com este bloco', icon: I.plus, run: () => { e.chain().focus().setTextSelection({ from: pos + 1, to: end - 1 }).run(); ui().createDemand?.(); } },
        { label: 'Duplicar', icon: I.copy, kbd: '', run: () => e.chain().focus().insertContentAt(end, node.toJSON()).run() },
        { label: 'Mover para cima', icon: I.up, disabled: idx === 0, run: () => this.move(-1) },
        { label: 'Mover para baixo', icon: I.down, disabled: idx >= count - 1, run: () => this.move(1) },
        { divider: true },
        { label: 'Excluir', icon: I.trash, danger: true, run: () => e.chain().focus().deleteRange({ from: pos, to: end }).run() }
      ], { onClose: () => { this.el.hidden = true; } });
    },
    move(dir) {
      const b = this.block(); if (!b) return;
      const { e, node, pos, end } = b;
      const $p = e.state.doc.resolve(pos);
      const idx = $p.index(0);
      const tr = e.state.tr;
      if (dir < 0) {
        if (idx === 0) return;
        const prev = e.state.doc.child(idx - 1);
        tr.delete(pos, end).insert(pos - prev.nodeSize, node);
      } else {
        if (idx >= e.state.doc.childCount - 1) return;
        const next = e.state.doc.child(idx + 1);
        tr.delete(pos, end).insert(pos + next.nodeSize, node);
      }
      e.view.dispatch(tr.scrollIntoView());
      e.commands.focus();
    },
    dragStart(ev) {
      const b = this.block(); const KW = window.KastorWriter;
      if (!b || !KW?.NodeSelection) return;
      const { e, pos } = b;
      const view = e.view;
      const sel = KW.NodeSelection.create(view.state.doc, pos);
      view.dispatch(view.state.tr.setSelection(sel));
      const slice = sel.content();
      const dom = view.nodeDOM(pos);
      ev.dataTransfer.clearData();
      ev.dataTransfer.setData('text/html', dom?.outerHTML || '');
      ev.dataTransfer.setData('text/plain', b.node.textContent || '');
      ev.dataTransfer.effectAllowed = 'copyMove';
      if (dom) ev.dataTransfer.setDragImage(dom, 0, 0);
      view.dragging = { slice, move: true };
    }
  };

  /* ═══ Altura das linhas da tabela (arrastar a borda de baixo) ══════
     A largura das colunas já vem do Tiptap (columnResizing). A altura é
     nossa: perto da borda inferior de uma célula o cursor vira ↕, e o
     arraste grava `height` na linha ao soltar (prévia ao vivo no DOM). */
  const rowResize = {
    row: null, line: null, dragging: false,
    bind(mount) {
      if (!mount || mount._kdRows) return;
      mount._kdRows = true;
      const pm = () => mount.querySelector('.ProseMirror');
      this.line = document.createElement('div');
      this.line.className = 'kd-row-guide';
      this.line.hidden = true;
      document.body.appendChild(this.line);
      mount.addEventListener('mousemove', (e) => {
        if (this.dragging) return;
        const cell = canEdit() && e.target.closest && e.target.closest('td, th');
        const near = cell && (() => { const r = cell.getBoundingClientRect(); const d = r.bottom - e.clientY; return d <= 6 && d >= -4; })();
        // Canto direito é da coluna (Tiptap) — não disputa
        const colZone = cell && (cell.getBoundingClientRect().right - e.clientX) <= 6;
        if (near && !colZone) { this.row = cell.parentElement; pm()?.classList.add('kd-row-resize'); this.paint(); }
        else if (this.row) { this.row = null; pm()?.classList.remove('kd-row-resize'); this.line.hidden = true; }
      });
      mount.addEventListener('mouseleave', () => { if (!this.dragging && this.row) { this.row = null; pm()?.classList.remove('kd-row-resize'); this.line.hidden = true; } });
      mount.addEventListener('mousedown', (e) => {
        if (!this.row || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const rowEl = this.row;
        const startY = e.clientY;
        const startH = rowEl.getBoundingClientRect().height;
        this.dragging = true;
        document.body.classList.add('kd-row-resizing');
        const move = (ev) => {
          const h = Math.max(24, Math.round(startH + ev.clientY - startY));
          rowEl.style.height = h + 'px';
          this.paint();
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          this.dragging = false;
          document.body.classList.remove('kd-row-resizing');
          this.line.hidden = true;
          const x = ed(); if (!x) return;
          const h = Math.round(rowEl.getBoundingClientRect().height);
          try {
            const $p = x.state.doc.resolve(x.view.posAtDOM(rowEl, 0));
            for (let d = $p.depth; d > 0; d--) {
              const n = $p.node(d);
              if (n.type.name === 'tableRow') {
                x.view.dispatch(x.state.tr.setNodeMarkup($p.before(d), undefined, { ...n.attrs, height: h }));
                break;
              }
            }
          } catch (err) { console.warn('[linha da tabela]', err); }
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }, true);
    },
    paint() {
      if (!this.row) return;
      const tbl = this.row.closest('table');
      const r = this.row.getBoundingClientRect(), t = tbl ? tbl.getBoundingClientRect() : r;
      Object.assign(this.line.style, { left: t.left + 'px', width: t.width + 'px', top: (r.bottom - 1) + 'px' });
      this.line.hidden = false;
    }
  };

  /* ═══ Colar / arrastar arquivos pra dentro do texto ═══════════════ */
  function bindFileDrops(mount) {
    if (!mount || mount._kdFiles) return;
    mount._kdFiles = true;
    const files = (dt) => Array.from(dt?.files || []).filter(f => f && f.size >= 0);
    mount.addEventListener('paste', (e) => {
      if (!canEdit()) return;
      const list = files(e.clipboardData);
      if (!list.length) return;
      // HTML vindo do Word/Docs às vezes traz a imagem junto — só intercepta quando é só arquivo
      if (e.clipboardData.getData('text/html') && !list.every(f => /^image\//.test(f.type))) return;
      e.preventDefault(); e.stopPropagation();
      list.forEach(f => ui().uploadFile?.(f));
    }, true);
    mount.addEventListener('drop', (e) => {
      if (!canEdit()) return;
      const list = files(e.dataTransfer);
      if (!list.length) return;
      e.preventDefault(); e.stopPropagation();
      const x = ed();
      const hit = x?.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (hit) x.commands.setTextSelection(hit.pos);
      list.forEach(f => ui().uploadFile?.(f));
    }, true);
  }

  /* ═══ Menus do topo (Arquivo, Editar, Ver, Inserir, Formatar, Ferramentas) ═══ */
  const VIEW_KEY = 'kd-docs-view';
  // Preferências pessoais de exibição (o formato da página é do documento)
  const viewPrefs = (() => { try { return Object.assign({ ruler: true, outline: true }, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); } catch { return { ruler: true, outline: true }; } })();
  function applyView() {
    const v = document.querySelector('.writer-editor-view');
    if (!v) return;
    v.classList.toggle('no-ruler', !viewPrefs.ruler);
    v.classList.toggle('no-outline', !viewPrefs.outline);
  }
  function toggleView(k) {
    viewPrefs[k] = !viewPrefs[k];
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewPrefs)); } catch {}
    applyView();
    ui().repaginate?.();
  }

  function menuItems(which) {
    const e = ed(), A = (n) => () => ui().action?.(n);
    const editable = canEdit();
    const hasSel = !!e && !e.state.selection.empty;
    const c = () => e.chain().focus();
    switch (which) {
      case 'arquivo': return [
        { label: 'Novo documento', icon: I.file, run: A('novo') },
        { label: 'Fazer uma cópia', icon: I.copy, run: A('duplicar') },
        { divider: true },
        window.KD?.myRole === 'owner' && { label: 'Compartilhar', icon: I.share, run: A('compartilhar') },
        { label: 'Baixar', icon: I.download, children: [
          { label: 'PDF (.pdf)', run: A('baixar-pdf') },
          { label: 'Word (.docx)', run: A('baixar-docx') },
          { label: 'Página web (.html)', run: A('baixar-html') },
          { label: 'Texto simples (.txt)', run: A('baixar-txt') }
        ] },
        { divider: true },
        editable && { label: 'Vincular a cliente ou projeto', icon: I.ref, run: A('vincular') },
        editable && { label: 'Pedir aprovação do cliente', icon: I.check, run: A('aprovacao') },
        { divider: true },
        editable && { label: 'Renomear', icon: I.rename, run: A('renomear') },
        { label: 'Histórico de versões', icon: I.history, run: A('historico') },
        editable && { label: 'Salvar versão com nome', icon: I.save, kbd: 'Mod+S', run: A('salvar-versao') },
        { divider: true },
        { label: 'Imprimir', icon: I.print, kbd: 'Mod+P', run: A('imprimir') },
        window.KD?.myRole === 'owner' && { divider: true },
        window.KD?.myRole === 'owner' && { label: 'Mover para a lixeira', icon: I.trash, danger: true, run: A('lixeira') }
      ];
      case 'editar': return [
        { label: 'Desfazer', icon: I.undo, kbd: 'Mod+Z', disabled: !editable, run: () => c().undo().run() },
        { label: 'Refazer', icon: I.redo, kbd: 'Mod+Y', disabled: !editable, run: () => c().redo().run() },
        { divider: true },
        { label: 'Recortar', icon: I.cut, kbd: 'Mod+X', disabled: !hasSel || !editable, run: A('cut') },
        { label: 'Copiar', icon: I.copy, kbd: 'Mod+C', disabled: !hasSel, run: A('copy') },
        { label: 'Colar', icon: I.paste, kbd: 'Mod+V', disabled: !editable, run: A('paste') },
        { label: 'Colar sem formatação', icon: I.paste, kbd: 'Mod+Shift+V', disabled: !editable, run: A('paste-plain') },
        { divider: true },
        { label: 'Selecionar tudo', icon: I.selectAll, kbd: 'Mod+A', run: A('select-all') },
        { label: 'Excluir', icon: I.trash, disabled: !hasSel || !editable, run: A('delete-selection') },
        { divider: true },
        { label: 'Buscar e substituir', icon: I.search, kbd: 'Mod+H', run: () => findPanel.open(true) }
      ];
      case 'ver': return [
        { header: 'Formato do documento' },
        { label: 'Sem páginas', icon: I.list, checked: (ui().layout?.() || 'pageless') !== 'pages', disabled: !editable, run: () => ui().setLayout?.('pageless') },
        { label: 'Páginas (A4)', icon: I.pages, checked: ui().layout?.() === 'pages', disabled: !editable, run: () => ui().setLayout?.('pages') },
        { divider: true },
        { label: 'Mostrar régua', icon: I.ruler, checked: viewPrefs.ruler, run: () => toggleView('ruler') },
        { label: 'Mostrar índice', icon: I.outline, checked: viewPrefs.outline, run: () => toggleView('outline') },
        { divider: true },
        { label: document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia', icon: I.expand, run: () => {
          if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.();
        } }
      ];
      case 'inserir': return [
        { label: 'Imagem', icon: I.image, disabled: !editable, children: imageItems() },
        { label: 'Tabela', icon: I.table, disabled: !editable, children: [{ render: tableGridPicker }] },
        { label: 'Link', icon: I.link, kbd: 'Mod+K', disabled: !editable, run: () => linkEditor.openForSelection() },
        { label: 'Arquivo da Galeria', icon: I.clip, disabled: !editable, run: () => ui().gallery?.() },
        { label: 'Comentário', icon: I.comment, kbd: 'Mod+Alt+M', disabled: !hasSel || !canComment(), run: () => ui().comment?.() },
        { label: 'Demanda a partir do texto', icon: I.plus, disabled: !editable, run: () => ui().createDemand?.() },
        { divider: true },
        { label: 'Demanda, cliente ou projeto', icon: I.ref, kbd: '#', disabled: !editable, run: () => c().insertContent('#').run() },
        { label: 'Menção a pessoa', icon: I.at, kbd: '@', disabled: !editable, run: () => c().insertContent('@').run() },
        { label: 'Data de hoje', icon: I.date, disabled: !editable, run: () => c().insertContent(new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) + ' ').run() },
        { divider: true },
        { label: 'Linha divisória', icon: I.hr, disabled: !editable, run: () => c().setHorizontalRule().run() },
        { label: 'Quebra de página', icon: I.page, kbd: 'Mod+Enter', disabled: !editable, run: () => c().setPageBreak().run() },
        { label: 'Caixa de destaque', icon: I.callout, disabled: !editable, children: [
          { label: 'Nota', run: () => c().setCallout({ variant: 'info' }).run() },
          { label: 'Dica', run: () => c().setCallout({ variant: 'tip' }).run() },
          { label: 'Aviso', run: () => c().setCallout({ variant: 'warn' }).run() },
          { label: 'Importante', run: () => c().setCallout({ variant: 'danger' }).run() }
        ] },
        { label: 'Colunas', icon: I.cols, disabled: !editable, children: [
          { label: '2 colunas', run: () => c().setColumns(2).run() },
          { label: '3 colunas', run: () => c().setColumns(3).run() }
        ] },
        { label: 'Citação', icon: I.quote, disabled: !editable, run: () => c().toggleBlockquote().run() },
        { label: 'Bloco de código', icon: I.code, disabled: !editable, run: () => c().toggleCodeBlock().run() }
      ];
      case 'formatar': return [
        { label: 'Texto', icon: I.bold, disabled: !editable, children: [
          { label: 'Negrito', icon: I.bold, kbd: 'Mod+B', checked: !!e?.isActive('bold'), run: () => c().toggleBold().run() },
          { label: 'Itálico', icon: I.italic, kbd: 'Mod+I', checked: !!e?.isActive('italic'), run: () => c().toggleItalic().run() },
          { label: 'Sublinhado', icon: I.underline, kbd: 'Mod+U', checked: !!e?.isActive('underline'), run: () => c().toggleUnderline().run() },
          { label: 'Tachado', icon: I.strike, kbd: 'Mod+Shift+S', checked: !!e?.isActive('strike'), run: () => c().toggleStrike().run() },
          ...textMoreItems()
        ] },
        { label: 'Estilos de parágrafo', icon: I.type, disabled: !editable, children: STYLES.map(s => ({ label: s.label, labelStyle: s.css, kbd: s.kbd, checked: cur.style() === s.key, run: () => setStyle(s.key) })) },
        { label: 'Alinhar', icon: I.alignL, disabled: !editable, children: alignItems() },
        { label: 'Espaçamento entre linhas', icon: I.spacing, disabled: !editable, children: spacingItems() },
        { label: 'Listas', icon: I.list, disabled: !editable, children: [
          { label: 'Com marcadores', icon: I.ul, kbd: 'Mod+Shift+8', checked: !!e?.isActive('bulletList'), run: () => c().toggleBulletList().run() },
          { label: 'Numerada', icon: I.ol, kbd: 'Mod+Shift+7', checked: !!e?.isActive('orderedList'), run: () => c().toggleOrderedList().run() },
          { label: 'Tarefas', icon: I.task, kbd: 'Mod+Shift+9', checked: !!e?.isActive('taskList'), run: () => c().toggleTaskList().run() }
        ] },
        { label: 'Recuo', icon: I.indent, disabled: !editable, children: [
          { label: 'Aumentar recuo', icon: I.indent, kbd: 'Tab', run: () => indent(1) },
          { label: 'Diminuir recuo', icon: I.outdent, kbd: 'Shift+Tab', run: () => indent(-1) }
        ] },
        { divider: true },
        { label: 'Limpar formatação', icon: I.clear, kbd: 'Mod+\\', disabled: !editable, run: clearFormatting }
      ];
      case 'ferramentas': return [
        { label: 'Contagem de palavras', icon: I.count, kbd: 'Mod+Shift+C', run: showWordCount },
        { label: 'Buscar e substituir', icon: I.search, kbd: 'Mod+H', run: () => findPanel.open(true) },
        { divider: true },
        { label: 'Atalhos do teclado', icon: I.keyboard, run: showShortcuts }
      ];
    }
    return [];
  }

  function bindMenubar() {
    const bar = $('kd-menubar');
    if (!bar || bar._kdBound) return;
    bar._kdBound = true;
    const open = (btn, keyboard) => openMenu(btn, menuItems(btn.dataset.menu), { keyboard, className: 'kd-pop--menubar' });
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-menu]'); if (!b) return;
      if (b.classList.contains('is-open')) closeMenus(); else open(b, e.detail === 0);
    });
    // Com um menu aberto, passar o mouse em outro item troca de menu
    bar.addEventListener('mouseover', (e) => {
      const b = e.target.closest('[data-menu]');
      if (!b || !menus.length || !menus[0].anchor?.closest('#kd-menubar') || b.classList.contains('is-open')) return;
      open(b, false);
    });
  }

  /* ═══ Diálogos simples ════════════════════════════════════════════ */
  function dialog(title, bodyHTML) {
    const bd = document.createElement('div');
    bd.className = 'kd-dialog-backdrop';
    bd.innerHTML = `<div class="kd-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="kd-dialog-head"><div class="kd-dialog-title">${esc(title)}</div><button type="button" class="kd-icon-btn" data-close title="Fechar">${I.close}</button></div>
      <div class="kd-dialog-body">${bodyHTML}</div></div>`;
    const close = () => { bd.remove(); document.removeEventListener('keydown', onKey, true); ed()?.commands.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    bd.addEventListener('click', (e) => { if (e.target === bd || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(bd);
    return bd;
  }
  function showWordCount() {
    const e = ed(); if (!e) return;
    const stat = (text) => {
      const t = text.trim();
      return { words: t ? t.split(/\s+/).length : 0, chars: text.length, charsNoSpace: text.replace(/\s/g, '').length };
    };
    const all = stat(e.state.doc.textBetween(0, e.state.doc.content.size, '\n'));
    const sel = e.state.selection;
    const part = sel.empty ? null : stat(e.state.doc.textBetween(sel.from, sel.to, '\n'));
    let paragraphs = 0;
    e.state.doc.descendants(n => { if (n.isTextblock && n.textContent.trim()) paragraphs++; });
    const pages = document.querySelectorAll('.kd-page-sheet').length || 1;
    const n = (v) => v.toLocaleString('pt-BR');
    const row = (l, a, b) => `<tr><td>${l}</td>${part ? `<td>${n(b)}</td>` : ''}<td>${n(a)}</td></tr>`;
    dialog('Contagem de palavras', `<table class="kd-wc">
      ${part ? '<thead><tr><th></th><th>Seleção</th><th>Documento</th></tr></thead>' : ''}
      <tbody>
        ${ui().layout?.() === 'pages' ? row('Páginas', pages, '—') : ''}
        ${row('Palavras', all.words, part?.words)}
        ${row('Caracteres', all.chars, part?.chars)}
        ${row('Caracteres sem espaços', all.charsNoSpace, part?.charsNoSpace)}
        ${row('Parágrafos', paragraphs, '—')}
        ${row('Tempo de leitura', Math.max(1, Math.round(all.words / 220)) + ' min', '—')}
      </tbody></table>`);
  }
  function showShortcuts() {
    const groups = [
      ['Texto', [['Negrito', 'Mod+B'], ['Itálico', 'Mod+I'], ['Sublinhado', 'Mod+U'], ['Tachado', 'Mod+Shift+S'], ['Código', 'Mod+E'], ['Sobrescrito', 'Mod+.'], ['Subscrito', 'Mod+,'], ['Limpar formatação', 'Mod+\\'], ['Link', 'Mod+K']]],
      ['Parágrafo', [['Texto normal', 'Mod+Alt+0'], ['Título 1 a 4', 'Mod+Alt+1…4'], ['Lista numerada', 'Mod+Shift+7'], ['Lista com marcadores', 'Mod+Shift+8'], ['Lista de tarefas', 'Mod+Shift+9'], ['Alinhar à esquerda / centro', 'Mod+Shift+L / E'], ['Alinhar à direita / justificar', 'Mod+Shift+R / J']]],
      ['Documento', [['Comandos e blocos', '/'], ['Demanda, cliente ou projeto', '#'], ['Mencionar pessoa', '@'], ['Quebra de página', 'Mod+Enter'], ['Buscar', 'Mod+F'], ['Buscar e substituir', 'Mod+H'], ['Comentar seleção', 'Mod+Alt+M'], ['Salvar versão', 'Mod+S'], ['Contagem de palavras', 'Mod+Shift+C']]],
      ['Atalhos de escrita', [['Título 1, 2, 3', '# ## ###'], ['Lista', '- ou *'], ['Lista numerada', '1.'], ['Tarefa', '[ ]'], ['Citação', '>'], ['Linha divisória', '---'], ['Negrito / itálico', '**texto** / *texto*']]]
    ];
    dialog('Atalhos do teclado', `<div class="kd-keys">${groups.map(([g, list]) => `
      <section><h4>${g}</h4>${list.map(([l, k]) => `<div class="kd-keys-row"><span>${esc(l)}</span><kbd>${esc(kbd(k))}</kbd></div>`).join('')}</section>`).join('')}</div>`);
  }

  /* ═══ Atalhos globais ════════════════════════════════════════════ */
  document.addEventListener('keydown', (e) => {
    if (!ed() || !document.querySelector('.kd-app.is-editor')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); findPanel.open(false); return; }
    if (k === 'h' && !e.shiftKey && !e.altKey) { e.preventDefault(); findPanel.open(true); return; }
    if (k === 'k' && !e.shiftKey && !e.altKey && canEdit()) { e.preventDefault(); linkEditor.openForSelection(); return; }
    if (k === 'c' && e.shiftKey && !e.altKey) { e.preventDefault(); showWordCount(); return; }
    if (e.key === '\\' && canEdit()) { e.preventDefault(); clearFormatting(); return; }
  }, true);

  /* ═══ Seletor de cliente/projeto (vincular documento, modelos, demanda) ═══
     Popover com busca. `kinds` filtra os tipos; `onPick(item|null)`. */
  function pickEntity(anchor, { kinds = ['client', 'project'], title, onPick, allowClear, current } = {}) {
    closeMenus();
    const el = document.createElement('div');
    el.className = 'kd-pop kd-picker';
    el.innerHTML = `${title ? `<div class="kd-pop-head">${esc(title)}</div>` : ''}
      <div class="kd-picker-search">${I.search}<input type="text" placeholder="Buscar ${kinds.includes('client') ? 'cliente ou projeto' : 'projeto'}" autocomplete="off" spellcheck="false"></div>
      <div class="kd-picker-list"></div>
      ${allowClear ? `<div class="kd-pop-sep"></div><button type="button" class="kd-pop-item is-danger" data-clear><span class="kd-pop-icon">${I.close}</span><span class="kd-pop-label">Remover vínculo</span></button>` : ''}`;
    document.body.appendChild(el);
    menus.push({ el, anchor, items: [], level: 0, buttons: [] });
    anchor?.classList?.add('is-open');
    const input = el.querySelector('input');
    const list = el.querySelector('.kd-picker-list');
    let rows = [], active = 0;
    const draw = () => {
      const all = (window.kdRefItems ? window.kdRefItems(input.value) : []).filter(x => kinds.includes(x.kind));
      rows = all.slice(0, 40);
      active = Math.min(active, Math.max(0, rows.length - 1));
      let html = '', last = null;
      rows.forEach((r, i) => {
        if (r.group !== last) { html += `<div class="kd-picker-group">${esc(r.group)}</div>`; last = r.group; }
        const on = current && current.kind === r.kind && current.id === r.id;
        html += `<button type="button" class="kd-pop-item${i === active ? ' is-active' : ''}${on ? ' is-checked' : ''}" data-i="${i}">
          <span class="kd-suggest-dot" style="background:${esc(r.color || '#9ca3af')}"></span>
          <span class="kd-pop-label">${esc(r.label)}</span>${r.sub ? `<span class="kd-pop-kbd">${esc(r.sub)}</span>` : ''}</button>`;
      });
      list.innerHTML = html || '<div class="kd-suggest-empty">Nada encontrado</div>';
      list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (r) => { closeMenus(); try { onPick && onPick(r); } catch (e) { console.error(e); } };
    input.addEventListener('input', () => { active = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); active = Math.min(rows.length - 1, active + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); active = Math.max(0, active - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (rows[active]) choose(rows[active]); }
    });
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) choose(rows[+b.dataset.i]); });
    el.querySelector('[data-clear]')?.addEventListener('click', () => choose(null));
    draw();
    placePopover(el, anchor, 'left');
    setTimeout(() => input.focus(), 0);
    return el;
  }

  /* ═══ API usada pelo standalone.js ═════════════════════════════════ */
  window.KDUI = {
    /* Chamado a cada abertura de documento (depois de criar o editor). */
    mount() {
      buildToolbar();
      bindMenubar();
      bubble.build();
      linkEditor.build();
      tableBar.build();
      handle.build();
      findPanel.build();
      bindFileDrops(document.getElementById('writer-editor-mount'));
      rowResize.bind(document.getElementById('writer-editor-mount'));
      applyView();
      syncToolbar();
      const e = ed();
      if (e && !e._kdUiBound) {
        e._kdUiBound = true;
        e.on('selectionUpdate', scheduleSync);
        e.on('transaction', scheduleSync);
        e.on('focus', scheduleSync);
        e.on('blur', () => setTimeout(() => {
          const a = document.activeElement;
          if (a && (a.closest('.kd-bubble, .kd-linkpop, .kd-pop, .kd-color-popover, .kd-tablebar'))) return;
          bubble.hide(); tableBar.update(); if (!linkEditor.editing) linkEditor.hide();
        }, 120));
        e.on('update', () => { if (findPanel.el && !findPanel.el.hidden) findPanel.paint(false); });
      }
      const scroll = document.querySelector('.writer-editor-scroll');
      if (scroll && !scroll._kdUi) {
        scroll._kdUi = true;
        scroll.addEventListener('scroll', () => { bubble.update(); linkEditor.update(); tableBar.update(); }, { passive: true });
      }
    },
    sync: scheduleSync,
    isPageless: () => ui().layout?.() !== 'pages',
    closeMenus,
    openMenu,
    pickEntity,
    placePopover,
    dialog,
    icons: I,
    findOpen: (r) => findPanel.open(r),
    teardown() {
      closeMenus(); bubble.hide(); linkEditor.hide();
      if (tableBar.el) tableBar.el.hidden = true;
      if (handle.el) handle.el.hidden = true;
      if (findPanel.el) findPanel.el.hidden = true;
    }
  };
})();
