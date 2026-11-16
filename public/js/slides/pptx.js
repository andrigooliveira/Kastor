/* Exportação em PowerPoint (.pptx) do reWork Presentations.
   Bundle à parte (vendor/slides-pptx.bundle.js), carregado só quando alguém
   pede o arquivo. Texto, formas e linhas saem editáveis; imagens embutidas;
   fundo e notas do apresentador também vão. Escala: 144 px = 1 polegada
   (1920 px → 13,33" = o 16:9 padrão do PowerPoint). */
import PptxGenJS from 'pptxgenjs';
import { sizeOf, themeOf, slideBg, textColor, shapeFill, lineColor, textRuns } from './render.js';

const PX_IN = 1 / 144;
const inch = (px) => px * PX_IN;
const pt = (px) => px * PX_IN * 72;  // 1 px = 0,5 pt

/* Família de fonte que vai no arquivo (precisa estar instalada em quem abre) */
const BUILTIN = { geist: 'Geist', serif: 'Georgia', mono: 'Consolas', system: 'Segoe UI' };
function fontFace(key, fonts) {
  if (typeof key === 'string' && key.startsWith('f:')) {
    const f = (fonts || []).find(x => 'f:' + x.id === key);
    if (f) return f.family;
  }
  return BUILTIN[key] || 'Geist';
}

/* '#rgb', '#rrggbb', '#rrggbbaa', 'rgb()', 'rgba()' → { hex: 'RRGGBB', a: 0..1 } */
function parseColor(v) {
  if (!v || typeof v !== 'string') return null;
  v = v.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { hex: h.slice(0, 6).toUpperCase(), a };
  }
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    const hex = [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { hex, a: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return null;
}
/* Sombra projetada → sombra do PowerPoint (pontos e graus) */
function shadowOf(sh, op) {
  const c = sh && parseColor(sh.color);
  if (!c) return undefined;
  const x = sh.x || 0, y = sh.y || 0;
  return { type: 'outer', color: c.hex, opacity: Math.max(0, Math.min(1, c.a * op)), blur: pt(sh.blur || 0), offset: pt(Math.hypot(x, y)), angle: Math.round(((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360) };
}
/* opacidade (0..1) → transparência do PowerPoint (0..100) */
const transp = (a) => Math.round(Math.max(0, Math.min(100, (1 - a) * 100)));

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
/* Imagem → data URI PNG/JPEG (o pptxgenjs embute o arquivo) */
async function imageData(src) {
  const img = await loadImage(src);
  if (!img || !img.naturalWidth) return null;
  try {
    const r = await fetch(src, { credentials: 'same-origin' });
    const blob = await r.blob();
    // SVG vai como vetor (o PowerPoint guarda também uma prévia em PNG)
    if (/^image\/(png|jpe?g|gif|svg\+xml)$/.test(blob.type)) {
      const data = await new Promise((ok, fail) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = fail; fr.readAsDataURL(blob); });
      return { data, w: img.naturalWidth, h: img.naturalHeight };
    }
  } catch {}
  // WebP, SVG, AVIF…: passa por um canvas e vira PNG
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return { data: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight };
}

export async function buildPptx(deck, { onProgress } = {}) {
  const size = sizeOf(deck.size);
  const theme = themeOf(deck.theme);
  const fonts = deck.fonts || [];
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'REWORK', width: inch(size.w), height: inch(size.h) });
  pptx.layout = 'REWORK';
  pptx.title = deck.title || 'Apresentação';
  pptx.company = 'reWork';
  const imgCache = new Map();
  const slides = deck.slides || [];
  for (let i = 0; i < slides.length; i++) {
    if (onProgress) onProgress(i + 1, slides.length);
    const sl = slides[i];
    const s = pptx.addSlide();
    const bg = parseColor(slideBg(sl, theme));
    if (bg) s.background = { color: bg.hex };
    for (const el of sl.elements || []) {
      if (el.hidden) continue;
      const op = el.opacity === undefined ? 1 : el.opacity;
      const box = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h), rotate: el.rot || 0 };
      if (el.type === 'text') {
        const fill = el.fill ? parseColor(el.fill) : null;
        if (!el.text && !(fill && fill.a > 0)) continue;
        const c = parseColor(textColor(el, theme)) || { hex: '000000', a: 1 };
        const size = pt(el.fontSize || 48);
        // Trechos com estilo próprio; quebra de linha vira parágrafo
        const parts = [];
        for (const run of textRuns(el)) {
          const rc = run.color ? parseColor(run.color) || c : c;
          const ro = {
            fontFace: fontFace(run.font || el.font || theme.font, fonts), fontSize: Math.round(pt(run.fontSize) * 10) / 10,
            color: rc.hex, transparency: transp(rc.a * op) || undefined,
            bold: !!run.bold, italic: !!run.italic, underline: run.underline ? { style: 'sng' } : undefined,
            charSpacing: el.letterSpacing ? Math.round(pt(el.letterSpacing) * 10) / 10 : undefined
          };
          const lines = String(run.text).split('\n');
          lines.forEach((t, i) => parts.push({ text: t, options: { ...ro, breakLine: i < lines.length - 1 } }));
        }
        s.addText(parts, {
          ...box,
          fontFace: fontFace(el.font || theme.font, fonts),
          fontSize: Math.round(size * 10) / 10,
          color: c.hex,
          align: el.align || 'left',
          valign: el.valign === 'middle' ? 'middle' : el.valign === 'bottom' ? 'bottom' : 'top',
          margin: 0,
          shadow: shadowOf(el.shadow, op),
          lineSpacing: Math.round(size * (el.lineHeight || 1.25) * 10) / 10,   // mesma altura de linha do slide
          wrap: true, fit: 'none',
          fill: fill && fill.a > 0 ? { color: fill.hex, transparency: transp(fill.a * op) || undefined } : undefined
        });
      } else if (el.type === 'image') {
        if (!el.src) continue;
        let img = imgCache.get(el.src);
        if (img === undefined) { img = await imageData(el.src); imgCache.set(el.src, img); }
        if (!img) continue;
        // Proporção real da imagem + caixa: o PowerPoint recorta (preencher) ou encaixa (caber)
        const ratio = img.h / img.w;
        s.addImage({
          data: img.data,
          x: box.x, y: box.y, w: box.w, h: box.w * ratio, rotate: box.rotate,
          sizing: { type: el.fit === 'contain' ? 'contain' : 'cover', w: box.w, h: box.h },
          shadow: shadowOf(el.shadow, op),
          transparency: transp(op) || undefined
        });
      } else if (el.type === 'shape') {
        const shape = el.shape || 'rect';
        if (shape === 'line') {
          const c = parseColor(lineColor(el, theme)) || { hex: '000000', a: 1 };
          s.addShape('line', {
            x: box.x, y: inch(el.y + el.h / 2), w: box.w, h: 0, rotate: box.rotate,
            line: { color: c.hex, width: pt(Math.max(1, el.strokeW || 6)), transparency: transp(c.a * op) || undefined },
            shadow: shadowOf(el.shadow, op)
          });
          continue;
        }
        const f = parseColor(shapeFill(el, theme));
        const st = el.strokeW ? parseColor(el.stroke || theme.text) : null;
        const opts = {
          ...box,
          fill: f && f.a > 0 ? { color: f.hex, transparency: transp(f.a * op) || undefined } : { type: 'none' },
          line: st ? { color: st.hex, width: pt(el.strokeW), transparency: transp(st.a * op) || undefined } : { type: 'none' },
          shadow: shadowOf(el.shadow, op)
        };
        if (shape === 'ellipse') s.addShape('ellipse', opts);
        else if (el.radius) s.addShape('roundRect', { ...opts, rectRadius: Math.min(inch(el.radius), box.w / 2, box.h / 2) });
        else s.addShape('rect', opts);
      }
    }
    if (sl.notes && sl.notes.trim()) s.addNotes(sl.notes);
  }
  const name = (deck.title || 'apresentacao').replace(/[\\/:*?"<>|]+/g, '').trim() || 'apresentacao';
  await pptx.writeFile({ fileName: name + '.pptx', compression: true });
}

if (typeof window !== 'undefined') window.ReworkPptx = { buildPptx, parseColor };
