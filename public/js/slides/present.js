/* Modo apresentação (tela cheia) e exportação em PDF. */
import { paintSlide, drawSlide, themeOf, sizeOf, customFamily } from './render.js';
import { icon } from './icons.js';
import { esc, toast } from './util.js';

/* source() devolve { title, theme, slides } atual — no editor, a apresentação
   acompanha mudanças feitas por outras pessoas enquanto passa. */
export function present(source, start = 0, { showNotes = true } = {}) {
  let idx = Math.max(0, start);
  let notesOn = false;
  const ov = document.createElement('div');
  ov.className = 'sl-present';
  ov.tabIndex = -1;
  ov.innerHTML = `
    <div class="sl-present-stage"><div class="sl-present-scale"><div class="sl-present-canvas"></div></div></div>
    <div class="sl-present-notes" hidden></div>
    <div class="sl-present-bar" role="toolbar" aria-label="Controles da apresentação">
      <button type="button" class="sl-present-btn" data-act="prev" title="Slide anterior (←)" aria-label="Slide anterior">${icon('left', 18)}</button>
      <span class="sl-present-count" aria-live="polite"></span>
      <button type="button" class="sl-present-btn" data-act="next" title="Próximo slide (→ ou espaço)" aria-label="Próximo slide">${icon('right', 18)}</button>
      ${showNotes ? `<span class="sl-present-sep"></span><button type="button" class="sl-present-btn" data-act="notes" title="Mostrar notas do apresentador" aria-label="Notas do apresentador" aria-pressed="false">${icon('notes', 18)}<span>Notas</span></button>` : ''}
      <span class="sl-present-sep"></span>
      <button type="button" class="sl-present-btn" data-act="exit" title="Sair (Esc)" aria-label="Sair da apresentação">${icon('x', 18)}</button>
    </div>
    <div class="sl-present-progress"><span></span></div>`;
  document.body.appendChild(ov);
  const scale = ov.querySelector('.sl-present-scale');
  const canvas = ov.querySelector('.sl-present-canvas');
  const bar = ov.querySelector('.sl-present-bar');
  const notesEl = ov.querySelector('.sl-present-notes');
  const progress = ov.querySelector('.sl-present-progress span');

  const deck = () => source() || { slides: [] };
  function fit() {
    const stage = ov.querySelector('.sl-present-stage');
    const w = stage.clientWidth, h = stage.clientHeight;
    const sz = sizeOf(deck().size);
    scale.style.width = sz.w + 'px'; scale.style.height = sz.h + 'px';
    const s = Math.min(w / sz.w, h / sz.h);
    scale.style.transform = `translate(${(w - sz.w * s) / 2}px, ${(h - sz.h * s) / 2}px) scale(${s})`;
  }
  function show(animate) {
    const d = deck();
    const n = d.slides.length;
    if (!n) { close(); return; }
    idx = Math.max(0, Math.min(idx, n - 1));
    const slide = d.slides[idx];
    const paint = () => { paintSlide(canvas, slide, themeOf(d.theme), { size: d.size }); fit(); };
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      canvas.style.opacity = '0';
      setTimeout(() => { paint(); canvas.style.opacity = '1'; }, 90);
    } else paint();
    ov.querySelector('.sl-present-count').textContent = `${idx + 1} / ${n}`;
    ov.querySelector('[data-act="prev"]').disabled = idx === 0;
    ov.querySelector('[data-act="next"]').disabled = idx === n - 1;
    progress.style.width = ((idx + 1) / n * 100) + '%';
    const notes = (slide.notes || '').trim();
    notesEl.innerHTML = notes ? esc(notes).replace(/\n/g, '<br>') : '<span class="sl-present-notes-empty">Sem notas neste slide.</span>';
  }
  const go = (d) => { const before = idx; idx += d; idx = Math.max(0, Math.min(idx, deck().slides.length - 1)); if (idx !== before) show(true); };

  let hideT = null;
  function wake() {
    ov.classList.remove('is-idle');
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (!bar.matches(':hover')) ov.classList.add('is-idle'); }, 2500);
  }
  function onKey(e) {
    if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); idx = 0; show(true); }
    else if (e.key === 'End') { e.preventDefault(); idx = deck().slides.length - 1; show(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if ((e.key === 'n' || e.key === 'N') && showNotes) toggleNotes();
    wake();
  }
  function toggleNotes() {
    notesOn = !notesOn;
    notesEl.hidden = !notesOn;
    const b = ov.querySelector('[data-act="notes"]');
    if (b) { b.setAttribute('aria-pressed', notesOn ? 'true' : 'false'); b.classList.toggle('is-on', notesOn); }
    ov.classList.toggle('has-notes', notesOn);
    requestAnimationFrame(fit);
  }
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFs);
    window.removeEventListener('resize', fit);
    clearTimeout(hideT);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ov.remove();
    if (present.onClose) present.onClose(idx);
  }
  function onFs() { if (!document.fullscreenElement) close(); }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    e.stopPropagation();
    const a = b.dataset.act;
    if (a === 'prev') go(-1);
    else if (a === 'next') go(1);
    else if (a === 'notes') toggleNotes();
    else if (a === 'exit') close();
  });
  ov.querySelector('.sl-present-stage').addEventListener('click', (e) => {
    // Terço esquerdo volta; o resto avança
    const r = e.currentTarget.getBoundingClientRect();
    go(e.clientX - r.left < r.width / 3 ? -1 : 1);
  });
  ov.addEventListener('mousemove', wake);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', fit);
  if (ov.requestFullscreen) {
    ov.requestFullscreen().then(() => document.addEventListener('fullscreenchange', onFs)).catch(() => {});
  }
  ov.focus();
  requestAnimationFrame(() => { fit(); show(false); wake(); });
  return { close, goTo: (i) => { idx = i; show(false); } };
}

/* ── PDF ─────────────────────────────────────────────────────── */
let jspdfLoading = null;
function loadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (jspdfLoading) return jspdfLoading;
  jspdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jspdf.umd.min.js';
    s.onload = () => (window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('PDF indisponível')));
    s.onerror = () => { jspdfLoading = null; reject(new Error('Não deu pra carregar o gerador de PDF.')); };
    document.head.appendChild(s);
  });
  return jspdfLoading;
}

export async function exportPdf(deck) {
  const slides = deck.slides || [];
  if (!slides.length) { toast('A apresentação não tem slides.', 'error'); return; }
  const theme = themeOf(deck.theme);
  toast('Gerando PDF…', 'sticky');
  try {
    const JsPDF = await loadJsPdf();
    // Garante as fontes carregadas antes de desenhar no canvas
    if (document.fonts) {
      await Promise.all(['400', '700'].flatMap(w => [
        document.fonts.load(`${w} 48px Geist`), document.fonts.load(`italic ${w} 48px Geist`), document.fonts.load(`${w} 48px "Geist Mono"`),
        ...(deck.fonts || []).map(f => document.fonts.load(`${w} 48px "${customFamily('f:' + f.id) || f.family}"`))
      ])).catch(() => {});
    }
    const size = sizeOf(deck.size);
    // Página com a proporção do slide (1 pt = 2 px)
    const pw = size.w / 2, ph = size.h / 2, orient = pw >= ph ? 'landscape' : 'portrait';
    const pdf = new JsPDF({ orientation: orient, unit: 'pt', format: [pw, ph], compress: true });
    const cv = document.createElement('canvas');
    cv.width = size.w; cv.height = size.h;
    const ctx = cv.getContext('2d');
    for (let i = 0; i < slides.length; i++) {
      toast(`Gerando PDF… slide ${i + 1} de ${slides.length}`, 'sticky');
      ctx.clearRect(0, 0, size.w, size.h);
      await drawSlide(ctx, slides[i], theme, size);
      if (i > 0) pdf.addPage([pw, ph], orient);
      pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    }
    const name = (deck.title || 'apresentacao').replace(/[\\/:*?"<>|]+/g, '').trim() || 'apresentacao';
    pdf.save(name + '.pdf');
    toast('PDF pronto.');
  } catch (e) {
    toast(e.message || 'Falha ao gerar o PDF.', 'error');
  }
}

/* ── PowerPoint ─────────────────────────────────────────────────
   O gerador (pptxgenjs) vem num bundle à parte: só baixa quando pedem. */
let pptxLoading = null;
function loadPptx() {
  if (window.ReworkPptx) return Promise.resolve(window.ReworkPptx);
  if (pptxLoading) return pptxLoading;
  pptxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/slides-pptx.bundle.js?v=' + (document.querySelector('script[src*="slides.bundle.js"]')?.src.split('v=')[1] || '1');
    s.onload = () => (window.ReworkPptx ? resolve(window.ReworkPptx) : reject(new Error('PowerPoint indisponível')));
    s.onerror = () => { pptxLoading = null; reject(new Error('Não deu pra carregar o gerador de PowerPoint.')); };
    document.head.appendChild(s);
  });
  return pptxLoading;
}
export async function exportPptx(deck) {
  if (!(deck.slides || []).length) { toast('A apresentação não tem slides.', 'error'); return; }
  toast('Gerando PowerPoint…', 'sticky');
  try {
    const lib = await loadPptx();
    await lib.buildPptx(deck, { onProgress: (i, n) => toast(`Gerando PowerPoint… slide ${i} de ${n}`, 'sticky') });
    toast('PowerPoint pronto. Fontes que não estiverem instaladas em quem abrir viram uma parecida.');
  } catch (e) {
    toast(e.message || 'Falha ao gerar o PowerPoint.', 'error');
  }
}
