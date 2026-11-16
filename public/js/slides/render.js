/* Desenho dos slides — o mesmo código serve pro editor, miniaturas, modo
   apresentação, link público (DOM) e PDF (canvas).
   O quadro tem o tamanho da apresentação (padrão 1920×1080, em px); quem
   mostra escala com transform. */

export const SW = 1920, SH = 1080;
export const DEFAULT_SIZE = { w: SW, h: SH };
export const LINE_HEIGHT = 1.25;

/* Tamanho do slide da apresentação, sempre válido. */
export function sizeOf(raw) {
  const n = (v, d) => { v = Math.round(Number(v)); return Number.isFinite(v) && v >= 100 && v <= 8000 ? v : d; };
  const s = raw && typeof raw === 'object' ? raw : {};
  return { w: n(s.w, SW), h: n(s.h, SH) };
}

/* Fontes próprias das apresentações (Google ou arquivo): id → família.
   O CSS (@font-face apontando pra /docfonts) entra uma vez na página. */
const CUSTOM_FONTS = new Map();
export function registerFonts(fonts) {
  if (!Array.isArray(fonts) || !fonts.length) return;
  let style = document.getElementById('sl-deck-fonts');
  if (!style) { style = document.createElement('style'); style.id = 'sl-deck-fonts'; document.head.appendChild(style); }
  for (const f of fonts) {
    if (!f || !f.id || !f.family) continue;
    const had = CUSTOM_FONTS.get(f.id);
    CUSTOM_FONTS.set(f.id, f.family);
    const key = f.id + ':' + (f.css || '').length;
    if (had && style.dataset['k' + f.id] === key) continue;
    style.dataset['k' + f.id] = key;
    style.textContent += '\n' + (f.css || '');
  }
}
export const customFamily = (key) => (typeof key === 'string' && key.startsWith('f:') ? CUSTOM_FONTS.get(key.slice(2)) || null : null);
export function fontStack(key) {
  const fam = customFamily(key);
  if (fam) return `"${fam.replace(/"/g, '')}", 'Geist', system-ui, sans-serif`;
  return FONT_STACKS[key] || FONT_STACKS.geist;
}

export const FONT_STACKS = {
  geist: "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "'Geist Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
};
export const FONT_LABELS = { geist: 'Geist', serif: 'Serifada', mono: 'Mono', system: 'Sistema' };

export const DEFAULT_THEME = { bg: '#ffffff', text: '#18181b', accent: '#7a00ff', font: 'geist' };

export function themeOf(t) {
  return { ...DEFAULT_THEME, ...(t || {}) };
}

/* Cores efetivas (null = segue o tema). */
export function textColor(el, theme) { return el.color || theme.text; }
export function shapeFill(el, theme) { return el.fill === undefined || el.fill === null ? theme.accent : el.fill; }
export function lineColor(el, theme) { return el.stroke || el.fill || theme.accent; }
export function fontOf(el, theme) { return fontStack(el.font || theme.font); }
export function slideBg(slide, theme) { return (slide && slide.bg) || theme.bg; }

const JUSTIFY = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

/* Atualiza (ou monta) o nó de um elemento. `opts.editingId` deixa o texto
   em edição intocado; `opts.placeholder` mostra a dica em caixa vazia. */
export function paintElement(node, el, theme, opts = {}) {
  node.className = 'sl-el sl-el-' + el.type + (el.type === 'shape' ? ' sl-shape-' + (el.shape || 'rect') : '');
  node.dataset.id = el.id;
  const s = node.style;
  s.left = el.x + 'px';
  s.top = el.y + 'px';
  s.width = el.w + 'px';
  s.height = el.h + 'px';
  s.transform = el.rot ? `rotate(${el.rot}deg)` : '';
  s.opacity = el.opacity === undefined || el.opacity === 1 ? '' : String(el.opacity);
  // Camada oculta não aparece em lugar nenhum (editor, apresentação, link, PDF)
  s.display = el.hidden ? 'none' : '';
  // Sombra projetada: segue o contorno (elipse, cantos, transparência da imagem)
  const sh = el.shadow;
  const shadowCss = sh && sh.color ? `drop-shadow(${sh.x || 0}px ${sh.y || 0}px ${(sh.blur || 0) / 2}px ${sh.color})` : '';

  if (el.type === 'text') {
    s.justifyContent = JUSTIFY[el.valign] || 'flex-start';
    s.background = el.fill || '';
    // Caixa com fundo: a sombra é da caixa; sem fundo, é das letras
    s.filter = el.fill && shadowCss ? shadowCss : '';
    let inner = node.firstElementChild;
    if (!inner || !inner.classList.contains('sl-text')) {
      node.innerHTML = '';
      inner = document.createElement('div');
      inner.className = 'sl-text';
      node.appendChild(inner);
    }
    const is = inner.style;
    is.fontSize = (el.fontSize || 48) + 'px';
    is.color = textColor(el, theme);
    is.fontFamily = fontOf(el, theme);
    is.fontWeight = el.bold ? '700' : '400';
    is.fontStyle = el.italic ? 'italic' : 'normal';
    is.textDecoration = el.underline ? 'underline' : 'none';
    is.textAlign = el.align || 'left';
    is.lineHeight = String(el.lineHeight || LINE_HEIGHT);
    is.letterSpacing = el.letterSpacing ? el.letterSpacing + 'px' : '';
    is.textShadow = !el.fill && sh && sh.color ? `${sh.x || 0}px ${sh.y || 0}px ${(sh.blur || 0) / 2}px ${sh.color}` : '';
    if (opts.editingId !== el.id) {
      const empty = !el.text;
      inner.classList.toggle('is-empty', empty && !!opts.placeholder);
      if (!empty && Array.isArray(el.runs) && el.runs.length) {
        // Trechos com estilo próprio (vindos do Figma, por exemplo)
        const key = JSON.stringify(el.runs) + '|' + theme.font;
        if (inner._runsKey !== key) {
          inner._runsKey = key;
          inner.innerHTML = el.runs.map(r => {
            const st = [];
            if (r.bold !== undefined) st.push('font-weight:' + (r.bold ? 700 : 400));
            if (r.italic !== undefined) st.push('font-style:' + (r.italic ? 'italic' : 'normal'));
            if (r.underline !== undefined) st.push('text-decoration:' + (r.underline ? 'underline' : 'none'));
            if (r.color) st.push('color:' + r.color);
            if (r.fontSize) st.push('font-size:' + r.fontSize + 'px');
            if (r.font) st.push('font-family:' + fontStack(r.font).replace(/"/g, "'"));
            return `<span style="${st.join(';')}">${String(r.text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</span>`;
          }).join('');
        }
      } else {
        inner._runsKey = null;
        inner.textContent = empty && opts.placeholder ? 'Clique duas vezes para escrever' : (el.text || '');
      }
    }
  } else if (el.type === 'image') {
    s.borderRadius = (el.radius || 0) + 'px';
    let img = node.firstElementChild;
    if (el.src) {
      if (!img || img.tagName !== 'IMG') { node.innerHTML = ''; img = document.createElement('img'); img.alt = ''; img.draggable = false; node.appendChild(img); }
      if (img.getAttribute('src') !== el.src) img.setAttribute('src', el.src);
      img.style.objectFit = el.fit || 'cover';
      img.style.borderRadius = (el.radius || 0) + 'px';
    } else {
      node.innerHTML = '<div class="sl-img-empty">Imagem</div>';
    }
  } else {
    const shape = el.shape || 'rect';
    if (shape === 'line') {
      s.background = '';
      s.border = '';
      s.borderRadius = '';
      let ln = node.firstElementChild;
      if (!ln) { ln = document.createElement('div'); ln.className = 'sl-line'; node.appendChild(ln); }
      ln.style.height = Math.max(1, el.strokeW || 6) + 'px';
      ln.style.background = lineColor(el, theme);
    } else {
      node.innerHTML = '';
      s.background = el.gradient ? gradientCss(el.gradient, el.w, el.h) : (shapeFill(el, theme) || 'transparent');
      s.border = el.strokeW ? `${el.strokeW}px solid ${el.stroke || theme.text}` : '';
      s.borderRadius = shape === 'ellipse' ? '50%' : (el.radius || 0) + 'px';
    }
  }
  if (el.type !== 'text') s.filter = shadowCss;
  return node;
}

/* Texto em trechos (cada um com seu estilo) — base do elemento + overrides */
export function textRuns(el) {
  const base = { bold: !!el.bold, italic: !!el.italic, underline: !!el.underline, color: null, fontSize: el.fontSize || 48, font: null };
  if (Array.isArray(el.runs) && el.runs.length) return el.runs.map(r => ({ ...base, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== null)) }));
  return [{ ...base, text: el.text || '' }];
}

/* Monta/atualiza o quadro inteiro reaproveitando os nós. opts.size = {w,h}. */
export function paintSlide(canvas, slide, theme, opts = {}) {
  theme = themeOf(theme);
  const size = sizeOf(opts.size);
  canvas.classList.add('sl-canvas');
  canvas.style.width = size.w + 'px';
  canvas.style.height = size.h + 'px';
  canvas.style.background = slideBg(slide, theme);
  const els = (slide && slide.elements) || [];
  const existing = new Map();
  for (const n of Array.from(canvas.children)) if (n.dataset && n.dataset.id) existing.set(n.dataset.id, n);
  let prev = null;
  for (const el of els) {
    let node = existing.get(el.id);
    if (node) existing.delete(el.id);
    else node = document.createElement('div');
    paintElement(node, el, theme, opts);
    const want = prev ? prev.nextSibling : canvas.firstChild;
    if (want !== node) canvas.insertBefore(node, want);
    prev = node;
  }
  for (const n of existing.values()) n.remove();
  return canvas;
}

/* Miniatura: quadro escalado pra caber no contêiner (inteiro, centralizado). */
export function mountThumb(container, slide, theme, rawSize) {
  const size = sizeOf(rawSize);
  container.classList.add('sl-thumb-box');
  let scaler = container.querySelector(':scope > .sl-scale');
  if (!scaler) {
    container.innerHTML = '';
    scaler = document.createElement('div');
    scaler.className = 'sl-scale';
    const canvas = document.createElement('div');
    scaler.appendChild(canvas);
    container.appendChild(scaler);
  }
  scaler.style.width = size.w + 'px';
  scaler.style.height = size.h + 'px';
  paintSlide(scaler.firstChild, slide, theme, { size });
  const fit = () => {
    const cw = container.clientWidth, ch = container.clientHeight;
    if (!cw) return;
    const s = ch ? Math.min(cw / size.w, ch / size.h) : cw / size.w;
    const ox = (cw - size.w * s) / 2, oy = ch ? (ch - size.h * s) / 2 : 0;
    scaler.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
  };
  container._slFit = fit;
  fit();
  if (!container._slRO && window.ResizeObserver) {
    container._slRO = new ResizeObserver(() => container._slFit && container._slFit());
    container._slRO.observe(container);
  }
  return scaler.firstChild;
}

/* ── Canvas (PDF) ─────────────────────────────────────────────── */

function loadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function drawSlide(ctx, slide, theme, rawSize) {
  theme = themeOf(theme);
  const size = sizeOf(rawSize);
  ctx.save();
  ctx.fillStyle = slideBg(slide, theme);
  ctx.fillRect(0, 0, size.w, size.h);
  for (const el of (slide.elements || [])) {
    if (el.hidden) continue;
    ctx.save();
    ctx.globalAlpha = el.opacity === undefined ? 1 : el.opacity;
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    ctx.translate(cx, cy);
    if (el.rot) ctx.rotate(el.rot * Math.PI / 180);
    ctx.translate(-el.w / 2, -el.h / 2);
    if (el.type !== 'text') applyShadow(ctx, el.shadow);
    if (el.type === 'shape') {
      const shape = el.shape || 'rect';
      if (shape === 'line') {
        const t = Math.max(1, el.strokeW || 6);
        ctx.fillStyle = lineColor(el, theme);
        ctx.fillRect(0, el.h / 2 - t / 2, el.w, t);
      } else {
        if (shape === 'ellipse') { ctx.beginPath(); ctx.ellipse(el.w / 2, el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2); }
        else roundRect(ctx, 0, 0, el.w, el.h, el.radius || 0);
        const fill = el.gradient ? gradientCanvas(ctx, el.gradient, el.w, el.h) : shapeFill(el, theme);
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (el.strokeW) {
          ctx.save(); ctx.shadowColor = 'transparent'; ctx.clip();
          ctx.lineWidth = el.strokeW * 2;
          ctx.strokeStyle = el.stroke || theme.text;
          ctx.stroke();
          ctx.restore();
        }
      }
    } else if (el.type === 'image' && el.src) {
      const img = await loadImg(el.src);
      if (img) {
        // Recorta numa tela à parte e desenha o resultado: assim a sombra
        // segue o formato real (cantos, transparência do PNG/SVG)
        const k = 2; // nitidez da tela à parte (vetores ficam nítidos no PDF)
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.ceil(el.w * k)); off.height = Math.max(1, Math.ceil(el.h * k));
        const o = off.getContext('2d');
        o.scale(k, k);
        roundRect(o, 0, 0, el.w, el.h, el.radius || 0);
        o.clip();
        const iw = img.naturalWidth || el.w, ih = img.naturalHeight || el.h;
        const sc = (el.fit === 'contain' ? Math.min : Math.max)(el.w / iw, el.h / ih);
        const dw = iw * sc, dh = ih * sc;
        o.drawImage(img, (el.w - dw) / 2, (el.h - dh) / 2, dw, dh);
        ctx.drawImage(off, 0, 0, el.w, el.h);
      }
    } else if (el.type === 'text') {
      if (el.fill) {
        ctx.save(); applyShadow(ctx, el.shadow);
        ctx.fillStyle = el.fill; ctx.fillRect(0, 0, el.w, el.h);
        ctx.restore();
      } else applyShadow(ctx, el.shadow);
      drawRichText(ctx, el, theme);
    }
    ctx.restore();
  }
  ctx.restore();
}

function applyShadow(ctx, sh) {
  if (!sh || !sh.color) return;
  ctx.shadowColor = sh.color;
  ctx.shadowBlur = sh.blur || 0;
  ctx.shadowOffsetX = sh.x || 0;
  ctx.shadowOffsetY = sh.y || 0;
}

/* Texto com trechos de estilos diferentes, quebra de linha pela largura,
   altura de linha e espaçamento entre letras — igual ao que o slide mostra. */
function drawRichText(ctx, el, theme) {
  const mult = el.lineHeight || LINE_HEIGHT;
  const ls = el.letterSpacing || 0;
  if ('letterSpacing' in ctx) ctx.letterSpacing = ls + 'px';
  const tokens = [];
  for (const r of textRuns(el)) {
    const font = `${r.italic ? 'italic ' : ''}${r.bold ? 700 : 400} ${r.fontSize}px ${fontStack(r.font || el.font || theme.font)}`;
    const color = r.color || textColor(el, theme);
    for (const part of String(r.text).split(/(\n|[ \t]+)/)) {
      if (!part) continue;
      ctx.font = font;
      tokens.push({ text: part, nl: part === '\n', space: /^[ \t]+$/.test(part), font, color, size: r.fontSize, underline: r.underline, w: part === '\n' ? 0 : ctx.measureText(part).width });
    }
  }
  // Linhas
  const lines = [];
  let line = { items: [], w: 0, size: 0 };
  const push = () => { while (line.items.length && line.items[line.items.length - 1].space) line.w -= line.items.pop().w; lines.push(line); line = { items: [], w: 0, size: 0 }; };
  const add = (t) => { line.items.push(t); line.w += t.w; line.size = Math.max(line.size, t.size); };
  for (const t of tokens) {
    if (t.nl) { if (!line.size) line.size = t.size; push(); continue; }
    if (t.space && !line.items.length && lines.length) continue;
    if (!t.space && line.items.length && line.w + t.w > el.w + 0.5) push();
    if (!t.space && t.w > el.w) {
      // Palavra maior que a caixa: quebra por letra
      ctx.font = t.font;
      let chunk = '';
      for (const ch of t.text) {
        const nw = ctx.measureText(chunk + ch).width;
        if (nw > el.w && chunk) { add({ ...t, text: chunk, w: ctx.measureText(chunk).width }); push(); chunk = ch; } else chunk += ch;
      }
      if (chunk) add({ ...t, text: chunk, w: ctx.measureText(chunk).width });
      continue;
    }
    add(t);
  }
  if (line.items.length || !lines.length) { if (!line.size) line.size = el.fontSize || 48; push(); }
  const heights = lines.map(l => (l.size || el.fontSize || 48) * mult);
  const total = heights.reduce((a, b) => a + b, 0);
  let y = 0;
  if (el.valign === 'middle') y = (el.h - total) / 2;
  else if (el.valign === 'bottom') y = el.h - total;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((ln, i) => {
    const lh = heights[i];
    // Linha de base aproximada: meio da altura da linha + ~1/3 do corpo
    const base = y + lh / 2 + (ln.size || 48) * 0.34;
    let x = 0;
    if (el.align === 'center') x = (el.w - ln.w) / 2;
    else if (el.align === 'right') x = el.w - ln.w;
    for (const t of ln.items) {
      ctx.font = t.font;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, x, base);
      if (t.underline && !t.space) ctx.fillRect(x, base + t.size * 0.1, t.w, Math.max(1, t.size / 16));
      x += t.w;
    }
    y += lh;
  });
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/* ── Degradê ────────────────────────────────────────────────────
   g = { type: 'linear'|'radial', stops: [{ pos, color }], x1,y1 (início/centro),
   x2,y2 (fim/raio), x3,y3 (largura do radial) } — pontos de 0 a 1 na caixa,
   do jeito que o Figma descreve. */
export function gradientCss(g, w, h) {
  const stops = (pos) => g.stops.map(s => `${s.color} ${Math.round(pos(s.pos) * 10000) / 100}%`).join(', ');
  const p1 = { x: g.x1 * w, y: g.y1 * h }, p2 = { x: g.x2 * w, y: g.y2 * h };
  if (g.type === 'radial') {
    const rx = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const ry = Math.hypot((g.x3 - g.x1) * w, (g.y3 - g.y1) * h) || rx;
    return `radial-gradient(${Math.round(rx)}px ${Math.round(ry)}px at ${Math.round(p1.x)}px ${Math.round(p1.y)}px, ${stops(t => t)})`;
  }
  // CSS: a linha do degradê tem o ângulo e cobre a caixa toda. Projeta o
  // início e o fim do Figma nessa linha pra posicionar as paradas certinho.
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const ang = Math.atan2(dy, dx);                    // 0 = pra direita
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const L = Math.abs(w * ux) + Math.abs(h * uy) || 1;
  const t = (p) => ((p.x - w / 2) * ux + (p.y - h / 2) * uy) / L + 0.5;
  const t1 = t(p1), t2 = t(p2);
  const cssDeg = (ang * 180 / Math.PI + 90 + 360) % 360;
  return `linear-gradient(${Math.round(cssDeg * 100) / 100}deg, ${stops(s => t1 + s * (t2 - t1))})`;
}
export function gradientCanvas(ctx, g, w, h) {
  let gr;
  if (g.type === 'radial') {
    const r = Math.hypot((g.x2 - g.x1) * w, (g.y2 - g.y1) * h) || 1;
    gr = ctx.createRadialGradient(g.x1 * w, g.y1 * h, 0, g.x1 * w, g.y1 * h, r);
  } else {
    gr = ctx.createLinearGradient(g.x1 * w, g.y1 * h, g.x2 * w, g.y2 * h);
  }
  for (const s of g.stops) { try { gr.addColorStop(Math.max(0, Math.min(1, s.pos)), s.color); } catch {} }
  return gr;
}
