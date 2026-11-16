/* Janela "Importar do Figma" — conectar a conta (token pessoal), colar o
   link, escolher os quadros e o modo, e importar como apresentação nova ou
   como slides no fim da apresentação aberta. */
import { api, esc, toast, openModal } from './util.js';
import { icon } from './icons.js';
import { S } from './store.js';

const HELP_URL = 'https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens';

/* intoDeck: { id, size, onSlides(slides, fonts) } pra importar na apresentação aberta */
export async function openFigmaImport({ intoDeck = null, presetUrl = '' } = {}) {
  const body = document.createElement('div');
  body.className = 'sl-fg';
  const footer = document.createElement('div');
  footer.className = 'sl-modal-actions sl-fg-foot';
  footer.innerHTML = `<span class="sl-fg-status" data-status></span><button type="button" class="btn btn-ghost" data-cancel>Cancelar</button><button type="button" class="btn btn-primary" data-go disabled>Importar</button>`;
  const m = openModal({ title: intoDeck ? 'Trazer slides do Figma' : 'Importar do Figma', body, footer, size: 'modal-lg' });
  footer.querySelector('[data-cancel]').onclick = () => m.close();
  const st = { status: null, file: null, picked: new Set(), mode: 'editable', busy: false, url: presetUrl };
  const $q = (s) => body.querySelector(s);

  const paint = () => {
    const s = st.status;
    body.innerHTML = `
      <section class="sl-fg-sec sl-fg-account">
        <img src="/figma.svg" alt="" width="18" height="27">
        ${s && s.connected ? `
          <div class="sl-fg-acc-text"><b>Conta do Figma conectada</b><span>${esc(s.handle ? '@' + s.handle : '')}${s.email ? ' · ' + esc(s.email) : ''}</span></div>
          <button type="button" class="btn btn-ghost btn-sm" data-retoken>Trocar token</button>
          <button type="button" class="btn btn-ghost btn-sm" data-disconnect>Desconectar</button>`
        : `
          <div class="sl-fg-acc-text"><b>Conecte sua conta do Figma</b><span>Com um token pessoal só de leitura. Ele fica criptografado na sua conta do reWork e só serve pra ler arquivos que você já abre no Figma.</span></div>`}
      </section>
      ${!s || !s.connected || st.retoken ? `
      <section class="sl-fg-sec sl-fg-token">
        <ol class="sl-fg-steps">
          <li>No Figma, clique no seu nome › <b>Configurações</b> › <b>Segurança</b> › <b>Tokens de acesso pessoal</b> › <b>Gerar novo token</b>.</li>
          <li>Em permissões, marque <b>File content: Read only</b> (o resto pode ficar sem acesso).</li>
          <li>Copie o token (começa com <code>figd_</code>) e cole aqui. <a href="${HELP_URL}" target="_blank" rel="noopener">Ajuda do Figma</a></li>
        </ol>
        <div class="sl-fg-row">
          <input class="form-control" type="password" autocomplete="off" spellcheck="false" placeholder="figd_…" data-token aria-label="Token pessoal do Figma">
          <button type="button" class="btn btn-primary" data-connect>Conectar</button>
        </div>
      </section>` : ''}
      <section class="sl-fg-sec" ${s && s.connected ? '' : 'hidden'}>
        <label class="form-label" for="sl-fg-url">Link do arquivo, da página ou do quadro</label>
        <div class="sl-fg-row">
          <input class="form-control" id="sl-fg-url" data-url placeholder="https://www.figma.com/design/…  ou  /slides/…" value="${esc(st.url)}">
          <button type="button" class="btn btn-ghost" data-fetch>${icon('search', 14)}<span>Buscar quadros</span></button>
        </div>
        <p class="sl-fg-hint">Vale arquivo do Figma Design (cada frame de primeiro nível vira um slide) e do Figma Slides. Com o link de um quadro, só ele aparece.</p>
      </section>
      <section class="sl-fg-sec sl-fg-result" data-result ${st.file ? '' : 'hidden'}></section>`;
    if (st.file) paintResult();
    bind();
    syncGo();
  };

  const paintResult = () => {
    const box = $q('[data-result]');
    const f = st.file;
    const n = st.picked.size;
    box.innerHTML = `
      <div class="sl-fg-filehead">
        <b>${esc(f.name)}</b><span>${f.frames.length} ${f.frames.length === 1 ? 'quadro' : 'quadros'}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-all>${n === f.frames.length ? 'Desmarcar todos' : 'Marcar todos'}</button>
      </div>
      <div class="sl-fg-grid">${f.frames.map((fr, i) => `
        <button type="button" class="sl-fg-frame${st.picked.has(fr.id) ? ' is-on' : ''}" data-frame="${esc(fr.id)}" aria-pressed="${st.picked.has(fr.id)}" title="${esc(fr.name)} · ${fr.w} × ${fr.h}">
          <span class="sl-fg-thumb" style="aspect-ratio:${fr.w} / ${fr.h}">${fr.thumb ? `<img src="${esc(fr.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>
          <span class="sl-fg-check">${icon('check', 12)}</span>
          <span class="sl-fg-fname"><span class="sl-fg-n">${i + 1}</span>${esc(fr.name)}</span>
          <span class="sl-fg-fmeta">${fr.page ? esc(fr.page) + ' · ' : ''}${fr.w} × ${fr.h}</span>
        </button>`).join('')}</div>
      <div class="sl-fg-mode">
        <span class="form-label">Como trazer</span>
        <div class="seg" role="group" aria-label="Modo">
          <button type="button" class="seg-btn${st.mode === 'editable' ? ' is-active' : ''}" data-mode="editable">Editável</button>
          <button type="button" class="seg-btn${st.mode === 'image' ? ' is-active' : ''}" data-mode="image">Imagem fiel</button>
        </div>
        <p class="sl-fg-hint">${st.mode === 'editable'
          ? 'Textos e formas viram camadas que dá pra editar; as camadas do Figma mantêm o nome e os grupos. Vetores, degradês, sombras e máscaras viram imagem. Fontes do Google Fonts entram sozinhas.'
          : 'Cada quadro vira uma imagem do slide inteiro, igualzinho ao Figma, mas sem editar o conteúdo.'}</p>
      </div>
      ${intoDeck ? `<p class="sl-fg-hint">Os slides entram no fim da apresentação aberta, no tamanho dela.</p>` : `
      <div class="form-grid sl-fg-dest">
        <div class="form-group full"><label class="form-label" for="sl-fg-title">Título</label><input class="form-control" id="sl-fg-title" data-title maxlength="200" value="${esc(f.name)}"></div>
        <div class="form-group" ${S.workspaces.length > 1 ? '' : 'hidden'}><label class="form-label" for="sl-fg-ws">Squad</label>
          <select class="form-control" id="sl-fg-ws" data-ws>${S.workspaces.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label" for="sl-fg-client">Cliente <span class="form-label-hint">opcional</span></label><select class="form-control" id="sl-fg-client" data-client></select></div>
      </div>`}`;
    if (!intoDeck) {
      const ws = $q('[data-ws]'), cl = $q('[data-client]');
      const fill = () => {
        const list = S.clients.filter(c => c.workspaceId === ws.value).sort((a, b) => a.name.localeCompare(b.name));
        cl.innerHTML = '<option value="">Nenhum</option>' + list.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      };
      fill(); ws.onchange = fill;
    }
  };

  const syncGo = () => {
    const go = footer.querySelector('[data-go]');
    const n = st.picked.size;
    go.disabled = st.busy || !st.file || !n;
    go.textContent = st.busy ? 'Importando…' : n ? `Importar ${n} ${n === 1 ? 'slide' : 'slides'}` : 'Importar';
  };
  const setStatus = (t) => { footer.querySelector('[data-status]').textContent = t || ''; };

  const bind = () => {
    const tok = $q('[data-token]');
    const connect = async () => {
      const v = (tok.value || '').trim();
      if (!v) { tok.focus(); return; }
      const b = $q('[data-connect]'); b.disabled = true; b.textContent = 'Conectando…';
      try { st.status = await api('/figma/token', 'PUT', { token: v }); st.retoken = false; toast('Conta do Figma conectada.'); paint(); setTimeout(() => $q('[data-url]')?.focus(), 30); }
      catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'Conectar'; }
    };
    if (tok) { tok.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); }); $q('[data-connect]').onclick = connect; setTimeout(() => tok.focus(), 50); }
    const re = $q('[data-retoken]'); if (re) re.onclick = () => { st.retoken = true; paint(); };
    const dc = $q('[data-disconnect]');
    if (dc) dc.onclick = async () => { try { st.status = await api('/figma/token', 'DELETE'); st.file = null; st.picked.clear(); toast('Conta do Figma desconectada. O token foi apagado.'); paint(); } catch (e) { toast(e.message, 'error'); } };
    const url = $q('[data-url]');
    const fetchFrames = async () => {
      st.url = url.value.trim();
      if (!st.url) { url.focus(); return; }
      const b = $q('[data-fetch]'); b.disabled = true; setStatus('Lendo o arquivo no Figma…');
      try {
        st.file = await api('/figma/frames', 'POST', { url: st.url });
        st.picked = new Set(st.file.frames.map(f => f.id));
        setStatus(''); paint();
      } catch (e) { setStatus(''); toast(e.message, 'error'); b.disabled = false; }
    };
    if (url) { url.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchFrames(); }); $q('[data-fetch]').onclick = fetchFrames; }
    const res = $q('[data-result]');
    if (res) res.onclick = (e) => {
      const fr = e.target.closest('[data-frame]');
      if (fr) { const id = fr.dataset.frame; if (st.picked.has(id)) st.picked.delete(id); else st.picked.add(id); fr.classList.toggle('is-on', st.picked.has(id)); fr.setAttribute('aria-pressed', st.picked.has(id)); syncGo(); res.querySelector('[data-all]').textContent = st.picked.size === st.file.frames.length ? 'Desmarcar todos' : 'Marcar todos'; return; }
      if (e.target.closest('[data-all]')) { st.picked = st.picked.size === st.file.frames.length ? new Set() : new Set(st.file.frames.map(f => f.id)); paintResult(); syncGo(); return; }
      const md = e.target.closest('[data-mode]');
      if (md) { st.mode = md.dataset.mode; const keep = { title: $q('[data-title]')?.value, ws: $q('[data-ws]')?.value, cl: $q('[data-client]')?.value }; paintResult(); if (keep.title != null) { $q('[data-title]').value = keep.title; $q('[data-ws]').value = keep.ws; $q('[data-ws]').onchange(); $q('[data-client]').value = keep.cl || ''; } }
    };
  };

  footer.querySelector('[data-go]').onclick = async () => {
    if (st.busy || !st.picked.size) return;
    st.busy = true; syncGo();
    const ids = st.file.frames.map(f => f.id).filter(id => st.picked.has(id));
    setStatus(`Trazendo ${ids.length} ${ids.length === 1 ? 'quadro' : 'quadros'} do Figma… pode levar até um minuto.`);
    try {
      const title = $q('[data-title]') ? $q('[data-title]').value.trim() : '';
      const imp = await api('/figma/import', 'POST', { url: st.url, ids, mode: st.mode, title, size: intoDeck ? intoDeck.size : null });
      if (intoDeck) {
        const r = await api('/decks/' + intoDeck.id + '/import', 'POST', { importId: imp.importId });
        m.close();
        intoDeck.onSlides(r.slides, r.fonts);
      } else {
        const d = await api('/decks', 'POST', {
          workspaceId: ($q('[data-ws]') || {}).value || (S.workspaces[0] || {}).id,
          clientId: ($q('[data-client]') || {}).value || null,
          title: title || imp.title, importId: imp.importId
        });
        m.close();
        S.nav.toDeck(d);
      }
      toast(`${imp.slideCount} ${imp.slideCount === 1 ? 'slide importado' : 'slides importados'} do Figma.`);
      if (imp.warnings && imp.warnings.length) showWarnings(imp.warnings);
    } catch (e) {
      st.busy = false; syncGo(); setStatus('');
      toast(e.message || 'Não deu pra importar do Figma.', 'error');
    }
  };

  try { st.status = await api('/figma/status'); } catch { st.status = { connected: false }; }
  paint();
}

function showWarnings(list) {
  const body = `<p class="sl-modal-text">A importação terminou. Alguns detalhes do Figma não têm equivalente aqui:</p>
    <ul class="sl-fg-warn">${list.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`;
  const footer = document.createElement('div');
  footer.className = 'sl-modal-actions';
  footer.innerHTML = '<button type="button" class="btn btn-primary" data-ok>Entendi</button>';
  const m = openModal({ title: 'Importado do Figma', body, footer });
  footer.querySelector('[data-ok]').onclick = () => m.close();
}
