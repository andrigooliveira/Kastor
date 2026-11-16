/* ───────────────────────────────────────────────────────────────
   reWork Presentations — importar do Figma

   Cada pessoa conecta a própria conta com um token pessoal do Figma
   (Configurações › Segurança › Tokens de acesso pessoal, com leitura de
   arquivos). O token fica criptografado na conta (user.figma.tokenEnc) e
   nunca volta pro navegador.

   Fluxo:
     POST /api/figma/frames { url }  → quadros do arquivo (com miniatura)
     POST /api/figma/import { url, ids, mode, size } → converte e guarda o
       resultado por 30 min (importId). Quem usa:
         POST /api/decks { importId }          → apresentação nova
         POST /api/decks/:id/import { importId } → slides no fim da atual

   Conversão (modo "editável"): texto → caixa de texto, retângulo/elipse/
   linha com cor sólida → forma, preenchimento de imagem → imagem (o arquivo
   original), containers (frame, grupo, componente) → grupo de camadas.
   O que não tem equivalente (vetores, gradientes, sombras, máscaras,
   elementos girados) vira imagem renderizada pelo próprio Figma.
   Modo "imagem fiel": cada quadro vira uma imagem do slide inteiro.
   ─────────────────────────────────────────────────────────────── */
const API = 'https://api.figma.com/v1';
const MAX_FRAMES = 60;
const MAX_RASTERS = 400;

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* Link do Figma → { key, node } (node-id da URL vira "1:2") */
function parseFigmaUrl(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/figma\.com\/(?:file|design|slides|proto|board|deck)\/([A-Za-z0-9]{10,64})/);
  if (!m) return null;
  let node = null;
  try { const q = new URL(s).searchParams.get('node-id'); if (q) node = decodeURIComponent(q).replace(/-/g, ':'); } catch {}
  return { key: m[1], node };
}

const isContainer = (t) => ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'].includes(t);
const visibleList = (arr) => (Array.isArray(arr) ? arr.filter(f => f && f.visible !== false && (f.opacity === undefined || f.opacity > 0)) : []);
const to255 = (v) => Math.max(0, Math.min(255, Math.round((v || 0) * 255)));
function figmaColor(c, opacity = 1) {
  if (!c) return null;
  const a = Math.round((c.a === undefined ? 1 : c.a) * opacity * 100) / 100;
  if (a >= 0.995) return '#' + [c.r, c.g, c.b].map(v => to255(v).toString(16).padStart(2, '0')).join('');
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${Math.max(0, a)})`;
}
const solidOf = (paint) => (paint && paint.type === 'SOLID' ? figmaColor(paint.color, paint.opacity === undefined ? 1 : paint.opacity) : null);
/* Rotação/espelhamento: a matriz relativa não é identidade nas diagonais */
function isRotated(node) {
  const t = node.relativeTransform;
  if (!Array.isArray(t) || !t[0] || !t[1]) return !!(node.rotation && Math.abs(node.rotation) > 0.01);
  return Math.abs(t[0][1]) > 0.001 || Math.abs(t[1][0]) > 0.001 || t[0][0] < 0 || t[1][1] < 0;
}
const hasEffects = (node) => visibleList(node.effects).length > 0;

/* Quadros do arquivo: frames de primeiro nível de cada página (seções
   abertas) e slides do Figma Slides. */
function collectFrames(doc) {
  const out = [];
  const visit = (node, page) => {
    if (!node || node.visible === false || out.length >= 200) return;
    const t = node.type;
    if (t === 'SLIDE' || t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE') {
      const b = node.absoluteBoundingBox;
      if (b && b.width >= 20 && b.height >= 20) out.push({ id: node.id, name: node.name || 'Quadro', page, w: Math.round(b.width), h: Math.round(b.height) });
      return;
    }
    if (['SECTION', 'SLIDE_GRID', 'SLIDE_ROW', 'GROUP'].includes(t)) for (const c of node.children || []) visit(c, page);
  };
  for (const page of (doc.document && doc.document.children) || []) for (const c of page.children || []) visit(c, page.name);
  return out;
}

/* Converte quadros (nós completos do Figma, pedidos com geometry=paths pra vir
   o tamanho sem rotação) em slides do reWork. A ideia é trazer cada coisa
   como ela é:
     texto → caixa de texto (com trechos de estilo, altura de linha, espaçamento)
     retângulo/elipse/linha → forma (cor ou degradê, borda, cantos, sombra)
     preenchimento de imagem → imagem (o arquivo original)
     frame/grupo/componente → grupo de camadas (fundo vira forma)
     vetor, booleana, estrela, polígono e o que não tem equivalente
       (máscara, desfoque, sombra interna, cantos diferentes, tracejado…)
       → SVG exportado pelo Figma: continua vetor, nítido em qualquer zoom
   Rotação vira rotação (o tamanho vem de node.size, o centro da caixa).
   Devolve também o que buscar depois: vectors (SVG), rasters (PNG, só no
   modo imagem fiel), imageFills e famílias de fonte. */
function convertFrames(frames, target, { mode = 'editable', rid }) {
  const slides = [], vectors = [], rasters = [], imageFills = [], families = new Set(), warnings = new Set();
  for (const F of frames) {
    const fb = F.absoluteBoundingBox;
    if (!fb) continue;
    const s = Math.min(target.w / fb.width, target.h / fb.height);
    const ox = (target.w - fb.width * s) / 2, oy = (target.h - fb.height * s) / 2;
    const X = (x) => Math.round((x - fb.x) * s + ox), Y = (y) => Math.round((y - fb.y) * s + oy);
    const S = (v) => Math.max(1, Math.round(v * s));
    const slide = { id: rid(), bg: null, notes: '', groups: [], elements: [] };
    const push = (el) => { slide.elements.push(el); return el; };

    if (mode === 'image') {
      const el = push({ id: rid(), name: F.name || 'Slide', type: 'image', src: '', fit: 'cover', radius: 0, rot: 0, opacity: 1, x: Math.round(ox), y: Math.round(oy), w: S(fb.width), h: S(fb.height) });
      rasters.push({ nodeId: F.id, el });
      slides.push(slide);
      continue;
    }

    /* Caixa do elemento: sem rotação usa a caixa absoluta; girado usa o
       tamanho real (size) em volta do centro da caixa absoluta. */
    const boxOf = (node, angle) => {
      const b = node.absoluteBoundingBox;
      if (!angle || !node.size) return { x: X(b.x), y: Y(b.y), w: S(b.width), h: S(b.height), rot: 0 };
      const cx = (b.x + b.width / 2 - fb.x) * s + ox, cy = (b.y + b.height / 2 - fb.y) * s + oy;
      const w = node.size.x * s, h = node.size.y * s;
      return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), rot: Math.round(angle * 10) / 10 };
    };
    const vector = (node, gid, opacity) => {
      const b = node.absoluteRenderBounds || node.absoluteBoundingBox;
      if (!b) return;
      const el = push({ id: rid(), name: node.name || 'Vetor', type: 'image', src: '', fit: 'fill', radius: 0, rot: 0, opacity: r2(opacity), x: X(b.x), y: Y(b.y), w: S(b.width), h: S(b.height) });
      el.fit = 'contain';
      if (gid) el.groupId = gid;
      vectors.push({ nodeId: node.id, el });
    };
    const shadowOf = (node) => {
      const fx = visibleList(node.effects);
      if (!fx.length) return { ok: true, shadow: null };
      if (fx.length === 1 && fx[0].type === 'DROP_SHADOW') {
        const e = fx[0];
        return { ok: true, shadow: { x: Math.round((e.offset ? e.offset.x : 0) * s), y: Math.round((e.offset ? e.offset.y : 0) * s), blur: Math.round((e.radius || 0) * s), spread: Math.round((e.spread || 0) * s), color: figmaColor(e.color) } };
      }
      return { ok: false };
    };
    const gradientOf = (paint) => {
      if (!paint || !['GRADIENT_LINEAR', 'GRADIENT_RADIAL'].includes(paint.type)) return null;
      const h = paint.gradientHandlePositions || [];
      const stops = (paint.gradientStops || []).map(st => ({ pos: Math.max(0, Math.min(1, st.position)), color: figmaColor(st.color, paint.opacity === undefined ? 1 : paint.opacity) }));
      if (h.length < 2 || stops.length < 2) return null;
      return { type: paint.type === 'GRADIENT_RADIAL' ? 'radial' : 'linear', stops, x1: h[0].x, y1: h[0].y, x2: h[1].x, y2: h[1].y, x3: (h[2] || h[0]).x, y3: (h[2] || h[0]).y };
    };
    /* Preenchimento de forma: { fill, gradient } ou null se precisar de SVG */
    const shapePaint = (vf) => {
      if (!vf.length) return { fill: 'rgba(0, 0, 0, 0)' };
      if (vf.length > 1) return null;
      const p = vf[0];
      if (p.type === 'SOLID') return { fill: solidOf(p) };
      if (p.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(p.blendMode)) return null;
      const g = gradientOf(p);
      return g ? { fill: g.stops[0].color, gradient: g } : null;
    };
    const plainBlend = (node) => !node.blendMode || ['NORMAL', 'PASS_THROUGH'].includes(node.blendMode);
    const strokeOk = (node, vs) => vs.length === 0 || (vs.length === 1 && vs[0].type === 'SOLID' && !(node.strokeDashes && node.strokeDashes.length) && (!node.strokeAlign || node.strokeAlign === 'INSIDE'));
    const radiusOk = (node) => !node.rectangleCornerRadii || new Set(node.rectangleCornerRadii).size === 1;
    const imageFillOk = (p) => p.type === 'IMAGE' && p.imageRef && ['FILL', 'FIT'].includes(p.scaleMode || 'FILL') && !p.imageTransform && !p.filters && (p.rotation || 0) === 0;

    // Fundo do quadro: cor, imagem ou degradê (vira forma no fundo)
    const ff = visibleList(F.fills);
    for (const p of ff) {
      if (p.type === 'SOLID' && ff.length === 1) slide.bg = solidOf(p);
      else if (p.type === 'SOLID') push({ id: rid(), name: 'Fundo', type: 'shape', shape: 'rect', fill: solidOf(p), stroke: null, strokeW: 0, radius: 0, rot: 0, opacity: 1, x: Math.round(ox), y: Math.round(oy), w: S(fb.width), h: S(fb.height) });
      else if (p.type === 'IMAGE' && p.imageRef) {
        const el = push({ id: rid(), name: 'Fundo', type: 'image', src: '', fit: p.scaleMode === 'FIT' ? 'contain' : 'cover', radius: 0, rot: 0, opacity: r2(p.opacity === undefined ? 1 : p.opacity), x: Math.round(ox), y: Math.round(oy), w: S(fb.width), h: S(fb.height) });
        imageFills.push({ ref: p.imageRef, el });
      } else {
        const g = gradientOf(p);
        if (g) push({ id: rid(), name: 'Fundo', type: 'shape', shape: 'rect', fill: g.stops[0].color, gradient: g, stroke: null, strokeW: 0, radius: 0, rot: 0, opacity: 1, x: Math.round(ox), y: Math.round(oy), w: S(fb.width), h: S(fb.height) });
      }
    }

    const walk = (node, gid, parentAngle, parentOp) => {
      if (!node || node.visible === false || node.isMask) return;
      if (!node.absoluteBoundingBox) return;
      const t = node.type;
      const op = parentOp * (node.opacity === undefined ? 1 : node.opacity);
      const rt = node.relativeTransform;
      const own = Array.isArray(rt) && rt[0] && rt[1] ? Math.atan2(rt[1][0], rt[0][0]) * 180 / Math.PI : 0;
      const flipped = Array.isArray(rt) && rt[0] && rt[1] && (rt[0][0] * rt[1][1] - rt[0][1] * rt[1][0]) < 0;
      let angle = parentAngle + own;
      angle = ((angle + 540) % 360) - 180;
      if (Math.abs(angle) < 0.05) angle = 0;
      const vf = visibleList(node.fills), vs = visibleList(node.strokes);
      const sh = shadowOf(node);
      // Espelhado, efeito sem equivalente ou mistura de camadas: SVG
      if (flipped || !sh.ok || !plainBlend(node)) { vector(node, gid, op); return; }
      const base = { id: rid(), name: node.name || t, opacity: r2(op), ...boxOf(node, angle) };
      if (gid) base.groupId = gid;
      if (sh.shadow) base.shadow = sh.shadow;

      if (t === 'TEXT') {
        if (vf.length > 1 || (vf.length === 1 && vf[0].type !== 'SOLID')) { vector(node, gid, op); return; }
        const st = node.style || {};
        const caseOf = (txt, c) => (c === 'UPPER' ? txt.toUpperCase() : c === 'LOWER' ? txt.toLowerCase() : txt);
        const raw = String(node.characters || '');
        const text = caseOf(raw, st.textCase);
        if (st.fontFamily) families.add(st.fontFamily);
        const el = {
          ...base, type: 'text', text,
          fontSize: Math.max(4, Math.round((st.fontSize || 16) * s)),
          color: vf.length ? solidOf(vf[0]) : null,
          bold: (st.fontWeight || 400) >= 600, italic: !!st.italic, underline: st.textDecoration === 'UNDERLINE',
          align: { CENTER: 'center', RIGHT: 'right' }[st.textAlignHorizontal] || 'left',
          valign: { CENTER: 'middle', BOTTOM: 'bottom' }[st.textAlignVertical] || 'top',
          font: st.fontFamily ? 'fam:' + st.fontFamily : null, fill: null,
          lineHeight: lineHeightOf(st)
        };
        if (st.letterSpacing) el.letterSpacing = Math.round(st.letterSpacing * s * 10) / 10;
        // Trechos com estilo próprio (characterStyleOverrides + styleOverrideTable)
        const ovr = Array.isArray(node.characterStyleOverrides) ? node.characterStyleOverrides : [];
        if (ovr.some(Boolean)) {
          const table = node.styleOverrideTable || {};
          const runs = [];
          let cur = null;
          for (let i = 0; i < raw.length; i++) {
            const k = ovr[i] || 0;
            if (!cur || cur.k !== k) { cur = { k, text: '' }; runs.push(cur); }
            cur.text += raw[i];
          }
          el.runs = runs.map(r => {
            const o = r.k ? (table[r.k] || {}) : {};
            const m = { ...st, ...o };
            if (m.fontFamily) families.add(m.fontFamily);
            const rf = visibleList(o.fills || node.fills);
            const out = { text: caseOf(r.text, m.textCase) };
            if (o.fontWeight !== undefined) out.bold = m.fontWeight >= 600;
            if (o.italic !== undefined) out.italic = !!m.italic;
            if (o.textDecoration !== undefined) out.underline = m.textDecoration === 'UNDERLINE';
            if (o.fontSize !== undefined) out.fontSize = Math.max(4, Math.round(m.fontSize * s));
            if (o.fontFamily !== undefined) out.font = 'fam:' + m.fontFamily;
            if (o.fills && rf.length && rf[0].type === 'SOLID') out.color = solidOf(rf[0]);
            return out;
          });
          el.text = el.runs.map(r => r.text).join('');
        }
        // Texto de largura automática: folga pra fonte parecida não quebrar a linha
        if (st.textAutoResize === 'WIDTH_AND_HEIGHT' || node.textAutoResize === 'WIDTH_AND_HEIGHT') { const w = Math.round(el.w * 1.06) + 2; if (!angle) { if (el.align === 'center') el.x -= Math.round((w - el.w) / 2); else if (el.align === 'right') el.x -= w - el.w; } el.w = w; }
        push(el);
        return;
      }

      if (t === 'RECTANGLE' || t === 'ELLIPSE') {
        if (!strokeOk(node, vs) || (t === 'RECTANGLE' && !radiusOk(node))) { vector(node, gid, op); return; }
        const arc = node.arcData;
        if (t === 'ELLIPSE' && arc && (Math.abs((arc.endingAngle - arc.startingAngle) - Math.PI * 2) > 0.01 || arc.innerRadius > 0)) { vector(node, gid, op); return; }
        if (vf.length === 1 && vf[0].type === 'IMAGE') {
          if (t !== 'RECTANGLE' || !imageFillOk(vf[0]) || vs.length) { vector(node, gid, op); return; }
          const el = push({ ...base, type: 'image', src: '', fit: vf[0].scaleMode === 'FIT' ? 'contain' : 'cover', radius: node.cornerRadius ? S(node.cornerRadius) : 0 });
          if (vf[0].opacity !== undefined && vf[0].opacity < 1) el.opacity = r2(el.opacity * vf[0].opacity);
          imageFills.push({ ref: vf[0].imageRef, el });
          return;
        }
        const paint = shapePaint(vf);
        if (!paint) { vector(node, gid, op); return; }
        push({
          ...base, type: 'shape', shape: t === 'ELLIPSE' ? 'ellipse' : 'rect', ...paint,
          stroke: vs.length ? solidOf(vs[0]) : null, strokeW: vs.length ? S(node.strokeWeight || 1) : 0,
          radius: t === 'RECTANGLE' && node.cornerRadius ? S(node.cornerRadius) : 0
        });
        return;
      }

      if (t === 'LINE') {
        if (!vs.length || vs[0].type !== 'SOLID' || vs.length > 1 || (node.strokeDashes && node.strokeDashes.length) || (node.strokeCap && node.strokeCap !== 'NONE')) { vector(node, gid, op); return; }
        const w = S(node.strokeWeight || 1);
        const h = Math.max(8, w);
        const len = node.size ? Math.max(1, Math.round(node.size.x * s)) : base.w;
        // Linha: comprimento = largura; o centro fica no centro da caixa absoluta
        const b = node.absoluteBoundingBox;
        const cx = (b.x + b.width / 2 - fb.x) * s + ox, cy = (b.y + b.height / 2 - fb.y) * s + oy;
        push({ ...base, type: 'shape', shape: 'line', x: Math.round(cx - len / 2), y: Math.round(cy - h / 2), w: len, h, rot: Math.round(angle * 10) / 10, fill: null, stroke: solidOf(vs[0]), strokeW: w, radius: 0 });
        return;
      }

      if (isContainer(t)) {
        const kids = (node.children || []).filter(c => c.visible !== false);
        // Máscara dentro: o recorte só existe no SVG
        if (kids.some(c => c.isMask)) { vector(node, gid, op); return; }
        // Fundo do container (frame com cor, degradê, borda ou imagem)
        if (t !== 'GROUP' && t !== 'SECTION' && (vf.length || vs.length)) {
          const bgName = (node.name || 'Frame') + ' · fundo';
          if (!strokeOk(node, vs) || !radiusOk(node)) {
            // Borda tracejada/fora, cantos diferentes: fundo inteiro vira SVG
            // só se não tiver filhos; com filhos, fica a parte que dá
            if (!kids.length) { vector(node, gid, op); return; }
            warnings.add('Algumas bordas (tracejadas, por fora ou com cantos diferentes) ficaram simples.');
          }
          if (vf.length === 1 && vf[0].type === 'IMAGE' && imageFillOk(vf[0])) {
            const el = push({ ...base, id: rid(), name: bgName, type: 'image', src: '', fit: vf[0].scaleMode === 'FIT' ? 'contain' : 'cover', radius: node.cornerRadius ? S(node.cornerRadius) : 0 });
            imageFills.push({ ref: vf[0].imageRef, el });
          } else {
            const paint = shapePaint(vf);
            if (paint) push({ ...base, id: rid(), name: bgName, type: 'shape', shape: 'rect', ...paint, stroke: vs.length && vs[0].type === 'SOLID' ? solidOf(vs[0]) : null, strokeW: vs.length ? S(node.strokeWeight || 1) : 0, radius: node.cornerRadius ? S(node.cornerRadius) : 0 });
            else if (!kids.length) { vector(node, gid, op); return; }
            else warnings.add('Fundos com várias camadas de preenchimento ficaram com a de cima.');
          }
        } else if (sh.shadow && t === 'GROUP') {
          // Sombra de grupo vai pra cada filho (sem fundo próprio pra receber)
        }
        // O container de fora vira grupo de camadas (os de dentro entram nele)
        const g = gid || (t === 'SECTION' ? null : rid());
        const before = slide.elements.length;
        for (const c of kids) walk(c, g, angle, op);
        if (g && !gid) {
          const n = slide.elements.slice(before).filter(e => e.groupId === g).length;
          if (n >= 2) slide.groups.push({ id: g, name: node.name || 'Grupo' });
          else for (const e of slide.elements) if (e.groupId === g) delete e.groupId;
        }
        return;
      }
      // Vetor, operação booleana, estrela, polígono, seta…: SVG
      vector(node, gid, op);
    };
    for (const c of F.children || []) walk(c, null, 0, 1);
    slides.push(slide);
  }
  if (vectors.length > MAX_RASTERS) warnings.add(`Arquivo com muitos vetores: só os primeiros ${MAX_RASTERS} vieram.`);
  return { slides, vectors: vectors.slice(0, MAX_RASTERS), rasters, imageFills, families: [...families], warnings: [...warnings] };
}
const r2 = (v) => Math.round(v * 100) / 100;
/* Altura de linha do Figma → múltiplo do tamanho da fonte */
function lineHeightOf(st) {
  if (st.lineHeightUnit === 'FONT_SIZE_%' && st.lineHeightPercentFontSize) return r2(st.lineHeightPercentFontSize / 100);
  if (st.lineHeightUnit === 'PIXELS' && st.lineHeightPx && st.fontSize) return r2(st.lineHeightPx / st.fontSize);
  return 1.2; // "Auto" do Figma
}

module.exports = function setupFigma(app, deps) {
  const { getDb, requireAuth, auth, saveEntity, uid, nowISO, saveUploadFromDataUri, fonts: fontLib, registerImport } = deps;
  const doFetch = (...a) => (deps.fetchImpl || fetch)(...a);
  const userOf = (req) => (getDb().users || []).find(u => u.id === req.user.id) || req.user;
  const tokenOf = (user) => {
    const enc = user && user.figma && user.figma.tokenEnc;
    if (!enc) return null;
    try { return auth.decryptString(enc); } catch { return null; }
  };
  const noFreelancer = (req, res, next) => (req.user && req.user.isFreelancer ? res.status(403).json({ error: 'Freelancer não tem acesso às apresentações' }) : next());

  async function fapi(token, p) {
    let r;
    try { r = await doFetch(API + p, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(60000) }); }
    catch (e) { throw fail('Não deu pra falar com o Figma agora. Tente de novo em instantes.', 502); }
    if (r.status === 403 || r.status === 401) throw fail('O Figma recusou o acesso. Confira se o token tem permissão de leitura de arquivos e se a sua conta abre esse arquivo.', 403);
    if (r.status === 404) throw fail('Arquivo não encontrado no Figma. Confira o link.', 404);
    if (r.status === 429) throw fail('O Figma pediu pra esperar um pouco (limite de uso). Tente de novo em um minuto.', 429);
    if (!r.ok) throw fail('O Figma respondeu com erro ' + r.status + '.', 502);
    return r.json();
  }
  /* Renders do Figma em lotes: { nodeId: url } */
  async function renderUrls(token, key, ids, scale, format = 'png') {
    const out = {};
    const extra = format === 'svg' ? '&format=svg&svg_outline_text=true&svg_simplify_stroke=true&svg_include_id=false' : `&format=png&scale=${scale}`;
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const r = await fapi(token, `/images/${key}?ids=${encodeURIComponent(chunk.join(','))}${extra}`);
      if (r.err) throw fail('O Figma não conseguiu gerar as imagens: ' + r.err);
      Object.assign(out, r.images || {});
    }
    return out;
  }
  async function download(url) {
    const r = await doFetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('download ' + r.status);
    const type = (r.headers.get('content-type') || 'image/png').split(';')[0];
    return { buf: Buffer.from(await r.arrayBuffer()), type };
  }
  const needToken = (req) => {
    const t = tokenOf(userOf(req));
    if (!t) throw fail('Conecte sua conta do Figma primeiro.', 409);
    return t;
  };

  app.get('/api/figma/status', requireAuth, noFreelancer, (req, res) => {
    const f = userOf(req).figma;
    res.json(f && f.tokenEnc ? { connected: true, handle: f.handle || null, email: f.email || null, savedAt: f.savedAt || null } : { connected: false });
  });
  app.put('/api/figma/token', requireAuth, noFreelancer, async (req, res) => {
    const token = String((req.body || {}).token || '').trim();
    if (!/^[A-Za-z0-9_\-]{20,200}$/.test(token)) return res.status(400).json({ error: 'Cole o token pessoal do Figma (começa com figd_).' });
    try {
      const me = await fapi(token, '/me');
      const u = userOf(req);
      u.figma = { tokenEnc: auth.encryptString(token), handle: me.handle || null, email: me.email || null, savedAt: nowISO() };
      saveEntity('users', u);
      res.json({ connected: true, handle: u.figma.handle, email: u.figma.email, savedAt: u.figma.savedAt });
    } catch (e) {
      res.status(e.status === 403 ? 400 : (e.status || 400)).json({ error: e.status === 403 ? 'Token recusado pelo Figma. Confira se copiou inteiro e se ele ainda vale.' : e.message });
    }
  });
  app.delete('/api/figma/token', requireAuth, noFreelancer, (req, res) => {
    const u = userOf(req);
    delete u.figma;
    saveEntity('users', u);
    res.json({ connected: false });
  });

  // Quadros do arquivo, com miniatura (as URLs do Figma valem alguns dias)
  app.post('/api/figma/frames', requireAuth, noFreelancer, async (req, res) => {
    try {
      const token = needToken(req);
      const ref = parseFigmaUrl((req.body || {}).url);
      if (!ref) return res.status(400).json({ error: 'Cole o link de um arquivo do Figma (figma.com/design/…, /slides/… ou /file/…).' });
      let frames, name;
      if (ref.node) {
        const r = await fapi(token, `/files/${ref.key}/nodes?ids=${encodeURIComponent(ref.node)}&depth=2`);
        name = r.name;
        const n = r.nodes && r.nodes[ref.node] && r.nodes[ref.node].document;
        if (!n) return res.status(404).json({ error: 'Esse quadro não foi encontrado no arquivo.' });
        const fake = { document: { children: [{ name: '', children: [n] }] } };
        frames = collectFrames(fake);
        if (!frames.length) frames = collectFrames({ document: { children: [{ name: '', children: n.children || [] }] } });
      } else {
        const r = await fapi(token, `/files/${ref.key}?depth=4`);
        name = r.name;
        frames = collectFrames(r);
      }
      if (!frames.length) return res.status(404).json({ error: 'Nenhum quadro encontrado nesse arquivo.' });
      frames = frames.slice(0, 200);
      let thumbs = {};
      try {
        const big = Math.max(...frames.map(f => Math.max(f.w, f.h)));
        thumbs = await renderUrls(token, ref.key, frames.slice(0, 120).map(f => f.id), Math.min(0.5, 480 / big).toFixed(3));
      } catch {}
      res.json({ key: ref.key, name: name || 'Figma', frames: frames.map(f => ({ ...f, thumb: thumbs[f.id] || null })) });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });

  app.post('/api/figma/import', requireAuth, noFreelancer, async (req, res) => {
    try {
      const token = needToken(req);
      const body = req.body || {};
      const ref = parseFigmaUrl(body.url);
      if (!ref) return res.status(400).json({ error: 'Link do Figma inválido.' });
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^[\w:;-]{1,80}$/.test(x)).slice(0, MAX_FRAMES);
      if (!ids.length) return res.status(400).json({ error: 'Escolha pelo menos um quadro.' });
      const mode = body.mode === 'image' ? 'image' : 'editable';
      // geometry=paths: vem o tamanho real (size) dos elementos girados
      const r = await fapi(token, `/files/${ref.key}/nodes?ids=${encodeURIComponent(ids.join(','))}&geometry=paths`);
      const frames = ids.map(id => r.nodes && r.nodes[id] && r.nodes[id].document).filter(Boolean);
      if (!frames.length) return res.status(404).json({ error: 'Os quadros escolhidos não foram encontrados.' });
      // Tamanho: o do destino (slides numa apresentação aberta) ou o do primeiro quadro
      const fb = frames[0].absoluteBoundingBox || { width: 1920, height: 1080 };
      const clampSize = (v) => Math.max(100, Math.min(8000, Math.round(v)));
      const size = body.size && body.size.w && body.size.h
        ? { w: clampSize(body.size.w), h: clampSize(body.size.h) }
        : { w: clampSize(fb.width), h: clampSize(fb.height) };
      const conv = convertFrames(frames, size, { mode, rid: uid });
      const warnings = [...conv.warnings];
      // Renders (o que virou imagem): escala pra ficar nítido no tamanho do slide
      if (conv.rasters.length) {
        const scale = mode === 'image' ? Math.min(3, Math.max(1, size.w / fb.width * 1.5)).toFixed(2) : 2;
        const urls = await renderUrls(token, ref.key, [...new Set(conv.rasters.map(x => x.nodeId))], scale);
        let failed = 0;
        const cache = new Map();
        for (const it of conv.rasters) {
          const u = urls[it.nodeId];
          if (!u) { failed++; continue; }
          try {
            if (!cache.has(u)) {
              const d = await download(u);
              const saved = saveUploadFromDataUri(`data:${d.type};base64,${d.buf.toString('base64')}`, (it.el.name || 'figma').slice(0, 40) + '.png');
              cache.set(u, saved && saved.url);
            }
            it.el.src = cache.get(u) || '';
            if (!it.el.src) failed++;
          } catch { failed++; }
        }
        if (failed) warnings.push(`${failed} ${failed === 1 ? 'elemento não pôde' : 'elementos não puderam'} ser trazidos como imagem (o Figma não renderizou ou o armazenamento está cheio).`);
      }
      // Vetores e o que não tem equivalente: SVG do próprio Figma (continua
      // vetor). Se o Figma não gerar o SVG de algum, vem em PNG nítido.
      if (conv.vectors.length) {
        const ids2 = [...new Set(conv.vectors.map(x => x.nodeId))];
        let svgUrls = {};
        try { svgUrls = await renderUrls(token, ref.key, ids2, 1, 'svg'); } catch {}
        const missing = ids2.filter(id => !svgUrls[id]);
        let pngUrls = {};
        if (missing.length) { try { pngUrls = await renderUrls(token, ref.key, missing, 2); } catch {} }
        const cache = new Map();
        let failed = 0;
        for (const it of conv.vectors) {
          const u = svgUrls[it.nodeId] || pngUrls[it.nodeId];
          if (!u) { failed++; continue; }
          try {
            if (!cache.has(u)) {
              const d = await download(u);
              const isSvg = !!svgUrls[it.nodeId];
              const type = isSvg ? 'image/svg+xml' : (d.type || 'image/png');
              const saved = saveUploadFromDataUri(`data:${type};base64,${d.buf.toString('base64')}`, (it.el.name || 'vetor').slice(0, 40) + (isSvg ? '.svg' : '.png'));
              cache.set(u, saved && saved.url);
            }
            it.el.src = cache.get(u) || '';
            if (!it.el.src) failed++;
          } catch { failed++; }
        }
        if (failed) warnings.push(`${failed} ${failed === 1 ? 'elemento não pôde' : 'elementos não puderam'} ser trazidos (o Figma não gerou o arquivo ou o armazenamento está cheio).`);
      }
      // Preenchimentos de imagem: o arquivo original do Figma
      if (conv.imageFills.length) {
        const map = await fapi(token, `/files/${ref.key}/images`);
        const urls = (map.meta && map.meta.images) || {};
        const cache = new Map();
        for (const it of conv.imageFills) {
          const u = urls[it.ref];
          if (!u) continue;
          try {
            if (!cache.has(u)) {
              const d = await download(u);
              const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[d.type] || 'png';
              const saved = saveUploadFromDataUri(`data:${d.type};base64,${d.buf.toString('base64')}`, (it.el.name || 'imagem').slice(0, 40) + '.' + ext);
              cache.set(u, saved && saved.url);
            }
            it.el.src = cache.get(u) || '';
          } catch {}
        }
      }
      // Tira imagens que não vieram
      for (const sl of conv.slides) sl.elements = sl.elements.filter(e => e.type !== 'image' || e.src);
      // Fontes: as do Google entram na apresentação; as outras viram a do tema
      const fontsOut = [];
      const famKey = {};
      const BUILTIN = { geist: 'geist', 'geist mono': 'mono' };
      for (const fam of conv.families.slice(0, 12)) {
        if (BUILTIN[fam.toLowerCase()]) { famKey[fam] = BUILTIN[fam.toLowerCase()]; continue; }
        try {
          const g = await fontLib.fetchGoogle(fam);
          const id = uid();
          fontsOut.push({ id, family: g.family, source: 'google', css: g.css });
          famKey[fam] = 'f:' + id;
        } catch {
          famKey[fam] = null;
          warnings.push(`A fonte "${fam}" não está no Google Fonts: os textos dela ficaram com a fonte do tema (dá pra enviar o arquivo em Fontes).`);
        }
      }
      for (const sl of conv.slides) for (const e of sl.elements) if (e.type === 'text' && typeof e.font === 'string' && e.font.startsWith('fam:')) e.font = famKey[e.font.slice(4)] || null;
      const title = String(body.title || r.name || 'Do Figma').slice(0, 200);
      const importId = registerImport(req.user.id, { title, size, slides: conv.slides, fonts: fontsOut });
      res.json({ importId, title, size, slideCount: conv.slides.length, warnings });
    } catch (e) { res.status(e.status || 400).json({ error: e.message || 'Não deu pra importar do Figma.' }); }
  });

  return { parseFigmaUrl, collectFrames, convertFrames };
};
module.exports.parseFigmaUrl = parseFigmaUrl;
module.exports.collectFrames = collectFrames;
module.exports.convertFrames = convertFrames;
