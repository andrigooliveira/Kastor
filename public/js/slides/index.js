/* reWork Presentations — entrada da página standalone (public/slides.html).
   Rotas:
     /hub/presentations               lista
     /hub/presentations/<slug-id>     editor
     /hub/presentations/public/<tok>  apresentação pública (sem login)
   Bundle: node scripts/build-slides.js → public/vendor/slides.bundle.js */
import { $, api, esc, deckSlug, idFromSlug, avatarHTML, openMenu, autoEnhanceSelects } from './util.js';
import { icon } from './icons.js';
import { S } from './store.js';
import { showHome, forgetHome } from './home.js';
import { openEditor, closeEditor } from './editor.js';
import { paintSlide, mountThumb, themeOf, sizeOf, registerFonts } from './render.js';
import { present, exportPdf, exportPptx } from './present.js';

const BASE = '/hub/presentations';

function route() {
  const p = location.pathname.replace(/\/+$/, '') || BASE;
  const pub = p.match(/^\/hub\/presentations\/public\/([a-zA-Z0-9]+)$/);
  if (pub) return { view: 'public', token: pub[1] };
  const m = p.match(/^\/hub\/presentations\/([a-zA-Z0-9-]+)$/);
  if (m) return { view: 'editor', id: idFromSlug(m[1]) };
  return { view: 'list' };
}

S.nav = {
  toList() { history.pushState({}, '', BASE); render(); },
  toDeck(d) { history.pushState({}, '', BASE + '/' + deckSlug(d)); render(); }
};
window.addEventListener('popstate', () => render());

async function render() {
  const r = route();
  const app = $('sl-app');
  try {
    if (r.view === 'editor') {
      app.className = 'sl-app is-editor';
      await openEditor(r.id);
    } else {
      closeEditor();
      forgetHome();
      app.className = 'sl-app is-list';
      document.title = 'reWork Presentations';
      await showHome();
    }
  } catch (e) {
    if (e.message === '__unauth__') authWall('Sua sessão expirou. Entre de novo pra continuar.');
    else throw e;
  }
}

function authWall(msg) {
  $('sl-boot').hidden = true;
  $('sl-app').hidden = true;
  const w = $('sl-auth');
  w.hidden = false;
  if (msg) w.querySelector('p').textContent = msg;
}

function paintUser() {
  const me = S.me;
  const btn = $('sl-user');
  const u = S.usersById.get(me.id) || me;
  btn.innerHTML = avatarHTML(u, 32);
  btn.title = me.name || me.username || '';
  btn.onclick = () => {
    const dark = (document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
    openMenu(btn, [
      { heading: me.name || me.username || '' },
      { label: 'Voltar pro reWork', icon: icon('open', 15), onClick: () => { location.href = '/dashboard'; } },
      { label: dark ? 'Tema claro' : 'Tema escuro', icon: icon('palette', 15), onClick: () => {
        const t = dark ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem('kastor-theme', t); } catch {}
      } }
    ], { align: 'right' });
  };
}

function bindApps() {
  const btn = $('sl-apps');
  btn.onclick = () => {
    const m = document.createElement('div');
    openMenu(btn, [
      { label: 'reWork', icon: '<img src="/rework_icone.svg" alt="" width="18" height="18">', onClick: () => { location.href = '/dashboard'; } },
      { label: 'Docs', icon: '<img src="/reworkdocs_icone.svg" alt="" width="18" height="18">', onClick: () => window.open('/hub/docs', '_blank', 'noopener') },
      { label: 'Presentations', icon: '<img src="/reworkpresentations_icone.svg" alt="" width="18" height="18">', active: true, onClick: () => S.nav.toList() }
    ], { align: 'right' });
    return m;
  };
}

/* ── Link público ────────────────────────────────────────────── */
async function showPublic(token) {
  $('sl-boot').hidden = true;
  const app = $('sl-app');
  app.hidden = false;
  app.className = 'sl-app is-public';
  const root = $('sl-public');
  let deck;
  try {
    const r = await fetch('/api/decks/public/' + encodeURIComponent(token));
    deck = await r.json();
    if (!r.ok) throw new Error(deck.error || 'Apresentação não encontrada.');
  } catch (e) {
    root.innerHTML = `<div class="sl-pub-missing"><img src="/reworkpresentations_icone.svg" alt="" width="40" height="40"><h1>Link indisponível</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  document.title = deck.title + ' — reWork Presentations';
  const theme = themeOf(deck.theme);
  const size = sizeOf(deck.size);
  registerFonts(deck.fonts);
  let idx = 0;
  root.innerHTML = `
    <header class="sl-pub-top">
      <img src="/reworkpresentations_icone.svg" alt="" width="24" height="24">
      <h1 class="sl-pub-title">${esc(deck.title)}</h1>
      <div class="sl-pub-actions">
        <button type="button" class="btn btn-ghost" id="sl-pub-pdf" aria-haspopup="menu">${icon('download', 14)}<span>Baixar</span></button>
        <button type="button" class="btn btn-primary" id="sl-pub-play">${icon('maximize', 14)}<span>Tela cheia</span></button>
      </div>
    </header>
    <main class="sl-pub-main">
      <div class="sl-pub-stagewrap" id="sl-pub-wrap">
        <button type="button" class="sl-pub-nav is-prev" id="sl-pub-prev" aria-label="Slide anterior">${icon('left', 22)}</button>
        <div class="sl-pub-stage" id="sl-pub-stage"><div class="sl-scale" id="sl-pub-scale"><div id="sl-pub-canvas"></div></div></div>
        <button type="button" class="sl-pub-nav is-next" id="sl-pub-next" aria-label="Próximo slide">${icon('right', 22)}</button>
      </div>
      <div class="sl-pub-count" id="sl-pub-count" aria-live="polite"></div>
      <div class="sl-pub-strip" id="sl-pub-strip">${deck.slides.map((s, i) => `<button type="button" class="sl-pub-thumb" data-i="${i}" aria-label="Slide ${i + 1}"><div class="sl-pub-thumb-c"></div><span>${i + 1}</span></button>`).join('')}</div>
    </main>`;
  root.querySelectorAll('.sl-pub-thumb').forEach((b, i) => { const c = b.querySelector('.sl-pub-thumb-c'); c.style.aspectRatio = size.w + ' / ' + size.h; mountThumb(c, deck.slides[i], theme, size); });
  const fit = () => {
    const w = $('sl-pub-wrap');
    const s = Math.min((w.clientWidth - 120) / size.w, (w.clientHeight - 16) / size.h);
    const st = $('sl-pub-stage');
    st.style.width = size.w * s + 'px'; st.style.height = size.h * s + 'px';
    const sc = $('sl-pub-scale'); sc.style.width = size.w + 'px'; sc.style.height = size.h + 'px';
    sc.style.transform = `scale(${s})`;
  };
  const show = () => {
    if (!deck.slides.length) return;
    idx = Math.max(0, Math.min(idx, deck.slides.length - 1));
    paintSlide($('sl-pub-canvas'), deck.slides[idx], theme, { size });
    $('sl-pub-count').textContent = `${idx + 1} de ${deck.slides.length}`;
    $('sl-pub-prev').disabled = idx === 0;
    $('sl-pub-next').disabled = idx === deck.slides.length - 1;
    root.querySelectorAll('.sl-pub-thumb').forEach((b, i) => { b.classList.toggle('is-active', i === idx); if (i === idx) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    const act = root.querySelector('.sl-pub-thumb.is-active'); if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  $('sl-pub-prev').onclick = () => { idx--; show(); };
  $('sl-pub-next').onclick = () => { idx++; show(); };
  $('sl-pub-strip').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { idx = Number(b.dataset.i); show(); } };
  $('sl-pub-play').onclick = () => { present.onClose = (i) => { idx = i; show(); }; present(() => deck, idx, { showNotes: false }); };
  $('sl-pub-pdf').onclick = (e) => openMenu(e.currentTarget, [
    { label: 'PDF', hint: '.pdf', icon: icon('download', 15), onClick: () => exportPdf(deck) },
    { label: 'PowerPoint', hint: '.pptx', icon: icon('presentation', 15), onClick: () => exportPptx(deck) }
  ], { align: 'right' });
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.sl-present')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { idx++; show(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { idx--; show(); }
  });
  window.addEventListener('resize', fit);
  fit(); show();
}

/* ── Boot ────────────────────────────────────────────────────── */
async function boot() {
  const r = route();
  if (r.view === 'public') { showPublic(r.token); return; }
  try {
    S.me = await api('/me');
    if (S.me.isFreelancer) { authWall('Freelancers não têm acesso ao reWork Presentations.'); return; }
  } catch (e) {
    authWall(e.message === '__unauth__' ? 'Entre no reWork pra ver as apresentações.' : (e.message || 'Erro ao entrar.'));
    return;
  }
  try {
    const b = await api('/bootstrap');
    S.workspaces = b.workspaces || [];
    S.clients = b.clients || [];
    S.projects = b.projects || [];
  } catch {}
  try { const users = await api('/users'); S.usersById = new Map(users.map(u => [u.id, u])); } catch {}
  paintUser();
  bindApps();
  $('sl-boot').hidden = true;
  $('sl-app').hidden = false;
  render();
}

// Dropdowns no visual do app (a lista nativa do sistema não aceita estilo)
autoEnhanceSelects();
boot();
