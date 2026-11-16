/* ───────────────────────────────────────────────────────────────
   reWork Presentations — apresentações (decks) com edição em tempo real

   Página: /hub/presentations (public/slides.html + vendor/slides.bundle.js)
   API:    /api/decks/*
   Tempo real: /rt/decks/<id> (docs-rt.js, mesmo protocolo Yjs do Docs)

   Modelo
   ──────
   deck = { id, workspaceId, clientId, projectId, title, ownerId,
            theme: { bg, text, accent, font },
            slides: [ { id, bg, notes, elements: [ el ] } ],
            yState, version, favoritedBy[], publicShareToken,
            publicShareEnabled, createdAt, updatedAt, deletedAt }

   el = { id, type: 'text'|'image'|'shape', x, y, w, h, rot, opacity,
          text, fontSize, color, bold, italic, underline, align, valign, font,
          src, fit, radius, shape: 'rect'|'ellipse'|'line', fill, stroke, strokeW }

   Coordenadas num quadro fixo de 1920×1080 (16:9). O cliente escala.

   `yState` (Yjs) é a fonte de verdade enquanto alguém edita. `slides`/`theme`
   são o retrato em JSON que o editor manda de tempos em tempos (PUT /content):
   alimenta a lista, o link público e o PDF sem precisar abrir o Yjs.
   Sem `yState` (deck novo ou duplicado), o servidor monta o estado Yjs a
   partir do JSON na primeira conexão (buildYState).

   Acesso: membros do squad editam; quem criou e admins compartilham (link
   público). Freelancer não entra.
   ─────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const W = 1920, H = 1080;          // tamanho padrão do slide
const SIZE_MIN = 100, SIZE_MAX = 8000; // tamanho do slide (px)
const COORD = 16000;                    // limite de posição/tamanho dos elementos
const MAX_GUIDES = 100;
const MAX_SLIDES = 300;
const MAX_ELEMENTS = 200;
const TEXT_MAX = 20000;
const FONTS = ['geist', 'serif', 'mono', 'system'];
// Fonte: uma das de sempre ou uma própria da apresentação ("f:<id>")
const fontKey = (v, def) => (FONTS.includes(v) || (typeof v === 'string' && /^f:[a-z0-9]{6,40}$/i.test(v)) ? v : def);
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
const ID_RE = /^[a-z0-9_-]{1,40}$/i;

const DEFAULT_THEME = { bg: '#ffffff', text: '#18181b', accent: '#7a00ff', font: 'geist' };

const num = (v, min, max, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
};
const color = (v) => (typeof v === 'string' && COLOR_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const rid = () => Math.random().toString(36).slice(2, 10);

/* Imagem só de dentro do app (/uploads/…): o editor sobe o arquivo antes. */
function cleanSrc(v) {
  if (typeof v !== 'string') return '';
  if (/^\/uploads\/[\w.\-]+$/.test(v)) return v;
  return '';
}

function cleanElement(e) {
  if (!e || typeof e !== 'object') return null;
  const type = oneOf(e.type, ['text', 'image', 'shape'], null);
  if (!type) return null;
  const out = {
    id: ID_RE.test(String(e.id || '')) ? String(e.id) : rid(),
    type,
    x: num(e.x, -COORD, COORD, 0),
    y: num(e.y, -COORD, COORD, 0),
    w: num(e.w, 1, COORD, 400),
    h: num(e.h, 1, COORD, 200),
    rot: num(e.rot, -360, 360, 0),
    opacity: num(e.opacity, 0, 1, 1)
  };
  // Camadas: nome próprio, oculta e travada (só guarda quando tem)
  const name = str(e.name, 80).trim();
  if (name) out.name = name;
  if (e.hidden) out.hidden = true;
  if (e.locked) out.locked = true;
  // Grupo (camadas): id do grupo do slide
  if (ID_RE.test(String(e.groupId || ''))) out.groupId = String(e.groupId);
  // Sombra projetada (qualquer elemento)
  if (e.shadow && typeof e.shadow === 'object') {
    const sc = color(e.shadow.color);
    if (sc) out.shadow = { x: num(e.shadow.x, -500, 500, 0), y: num(e.shadow.y, -500, 500, 4), blur: num(e.shadow.blur, 0, 500, 8), spread: num(e.shadow.spread, -200, 200, 0), color: sc };
  }
  if (type === 'text') {
    out.text = str(e.text, TEXT_MAX);
    out.fontSize = num(e.fontSize, 4, 1200, 48);
    out.color = color(e.color);
    out.bold = !!e.bold;
    out.italic = !!e.italic;
    out.underline = !!e.underline;
    out.align = oneOf(e.align, ['left', 'center', 'right'], 'left');
    out.valign = oneOf(e.valign, ['top', 'middle', 'bottom'], 'top');
    out.font = fontKey(e.font, null);
    out.fill = color(e.fill);
    // Altura de linha (× tamanho da fonte) e espaçamento entre letras (px)
    if (e.lineHeight !== undefined && e.lineHeight !== null) out.lineHeight = num(e.lineHeight, 0.5, 5, 1.25);
    if (e.letterSpacing) out.letterSpacing = num(e.letterSpacing, -100, 500, 0);
    // Trechos com estilo próprio (negrito, cor, tamanho…); o texto é a soma deles
    if (Array.isArray(e.runs) && e.runs.length) {
      let total = 0;
      const runs = [];
      for (const r of e.runs.slice(0, 400)) {
        if (!r || typeof r.text !== 'string' || !r.text) continue;
        const t = r.text.slice(0, Math.max(0, TEXT_MAX - total));
        if (!t) break;
        total += t.length;
        const o = { text: t };
        if (typeof r.bold === 'boolean') o.bold = r.bold;
        if (typeof r.italic === 'boolean') o.italic = r.italic;
        if (typeof r.underline === 'boolean') o.underline = r.underline;
        if (r.color) { const c = color(r.color); if (c) o.color = c; }
        if (r.fontSize) o.fontSize = num(r.fontSize, 4, 1200, 48);
        if (r.font) { const f = fontKey(r.font, null); if (f) o.font = f; }
        runs.push(o);
      }
      if (runs.length > 1 && runs.map(r => r.text).join('') === out.text) out.runs = runs;
    }
  } else if (type === 'image') {
    out.src = cleanSrc(e.src);
    out.fit = oneOf(e.fit, ['cover', 'contain'], 'cover');
    out.radius = num(e.radius, 0, 540, 0);
  } else {
    out.shape = oneOf(e.shape, ['rect', 'ellipse', 'line'], 'rect');
    out.fill = color(e.fill);
    // Degradê (linear ou radial): pontos normalizados na caixa (0..1) e paradas
    const g = e.gradient;
    if (g && typeof g === 'object' && Array.isArray(g.stops)) {
      const stops = g.stops.slice(0, 16).map(st => ({ pos: num(st && st.pos, 0, 1, 0), color: color(st && st.color) })).filter(st => st.color);
      if (stops.length >= 2) {
        out.gradient = {
          type: g.type === 'radial' ? 'radial' : 'linear', stops,
          x1: num(g.x1, -5, 5, 0), y1: num(g.y1, -5, 5, 0.5), x2: num(g.x2, -5, 5, 1), y2: num(g.y2, -5, 5, 0.5),
          x3: num(g.x3, -5, 5, 0), y3: num(g.y3, -5, 5, 1)
        };
      }
    }
    out.stroke = color(e.stroke);
    out.strokeW = num(e.strokeW, 0, 80, 0);
    out.radius = num(e.radius, 0, 540, 0);
  }
  return out;
}

function cleanSlide(s) {
  if (!s || typeof s !== 'object') return null;
  const els = Array.isArray(s.elements) ? s.elements.slice(0, MAX_ELEMENTS).map(cleanElement).filter(Boolean) : [];
  // Grupos de camadas: [{ id, name }] — só os que têm elemento
  const used = new Set(els.map(e => e.groupId).filter(Boolean));
  const groups = (Array.isArray(s.groups) ? s.groups : []).slice(0, 100)
    .filter(g => g && ID_RE.test(String(g.id || '')) && used.has(String(g.id)))
    .map(g => ({ id: String(g.id), name: str(g.name, 80).trim() || 'Grupo' }));
  for (const e of els) if (e.groupId && !groups.some(g => g.id === e.groupId)) delete e.groupId;
  return {
    id: ID_RE.test(String(s.id || '')) ? String(s.id) : rid(),
    bg: color(s.bg),
    notes: str(s.notes, TEXT_MAX),
    groups,
    elements: els
  };
}

function cleanSlides(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SLIDES).map(cleanSlide).filter(Boolean);
}

function cleanTheme(t) {
  t = t && typeof t === 'object' ? t : {};
  return {
    bg: color(t.bg) || DEFAULT_THEME.bg,
    text: color(t.text) || DEFAULT_THEME.text,
    accent: color(t.accent) || DEFAULT_THEME.accent,
    font: fontKey(t.font, DEFAULT_THEME.font)
  };
}

/* Tamanho do slide (vale pra apresentação inteira) */
function cleanSize(v) {
  const n = (x, d) => { x = Math.round(Number(x)); return Number.isFinite(x) && x >= SIZE_MIN && x <= SIZE_MAX ? x : d; };
  v = v && typeof v === 'object' ? v : {};
  return { w: n(v.w, W), h: n(v.h, H) };
}
/* Guias soltas: [{ id, axis: 'x'|'y', pos }] */
function cleanGuides(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_GUIDES).filter(g => g && (g.axis === 'x' || g.axis === 'y')).map(g => ({
    id: ID_RE.test(String(g.id || '')) ? String(g.id) : rid(),
    axis: g.axis,
    pos: num(g.pos, -COORD, COORD, 0)
  }));
}
/* Grade de layout (margens, colunas, linhas). null = sem grade. */
function cleanGrid(g) {
  if (!g || typeof g !== 'object') return null;
  const i = (v, min, max, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
  /* Layout de guias como o do Photoshop: colunas e linhas (número, largura/
     altura — 0 = automática — e medianiz), margens nos quatro lados e
     colunas centralizadas. Aceita o formato antigo (marginX/marginY). */
  const mx = g.marginX, my = g.marginY;
  const out = {
    colsOn: g.colsOn !== undefined ? !!g.colsOn : i(g.cols, 0, 48, 0) > 0,
    cols: i(g.cols, 0, 48, 0), colW: i(g.colW, 0, 8000, 0), colGutter: i(g.colGutter, 0, 2000, 0),
    rowsOn: g.rowsOn !== undefined ? !!g.rowsOn : i(g.rows, 0, 48, 0) > 0,
    rows: i(g.rows, 0, 48, 0), rowH: i(g.rowH, 0, 8000, 0), rowGutter: i(g.rowGutter, 0, 2000, 0),
    marginOn: g.marginOn !== undefined ? !!g.marginOn : !!(mx || my),
    mt: i(g.mt !== undefined ? g.mt : my, 0, 4000, 0), mb: i(g.mb !== undefined ? g.mb : my, 0, 4000, 0),
    ml: i(g.ml !== undefined ? g.ml : mx, 0, 4000, 0), mr: i(g.mr !== undefined ? g.mr : mx, 0, 4000, 0),
    center: !!g.center
  };
  return (out.colsOn && out.cols) || (out.rowsOn && out.rows) || out.marginOn ? out : null;
}

/* Arquivos de /uploads usados no deck (pra servir no link público). */
function uploadsIn(deck) {
  const set = new Set();
  for (const s of deck.slides || []) for (const e of s.elements || []) {
    if (e.type === 'image' && typeof e.src === 'string' && e.src.startsWith('/uploads/')) set.add(e.src.slice(9));
  }
  return set;
}

/* Estado Yjs inicial montado do JSON — mesmo formato que o editor usa:
   Y.Map 'meta' { title }, Y.Map 'theme', Y.Array 'slides' de Y.Map
   { id, bg, notes, elements: Y.Array de Y.Map }. */
function buildYState(Y, deck) {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('title', deck.title || 'Sem título');
    meta.set('size', cleanSize(deck.size));
    meta.set('guides', cleanGuides(deck.guides));
    meta.set('grid', cleanGrid(deck.grid));
    const th = doc.getMap('theme');
    const theme = cleanTheme(deck.theme);
    for (const k of Object.keys(theme)) th.set(k, theme[k]);
    const arr = doc.getArray('slides');
    arr.push((deck.slides || []).map(s => {
      const m = new Y.Map();
      m.set('id', s.id);
      m.set('bg', s.bg || null);
      m.set('notes', s.notes || '');
      m.set('groups', s.groups || []);
      const els = new Y.Array();
      els.push((s.elements || []).map(e => {
        const em = new Y.Map();
        for (const k of Object.keys(e)) em.set(k, e[k]);
        return em;
      }));
      m.set('elements', els);
      return m;
    }));
  });
  return Y.encodeStateAsUpdate(doc);
}

/* Modelos pra criar apresentação. Coordenadas em 1920×1080. */
function tpl(slides) { return slides.map(s => cleanSlide(s)); }
const T = (text, x, y, w, h, extra) => ({ type: 'text', text, x, y, w, h, ...extra });
const BAR = (x, y, w, h, extra) => ({ type: 'shape', shape: 'rect', x, y, w, h, ...extra });
const TEMPLATES = {
  blank: () => tpl([{ elements: [
    T('Título da apresentação', 160, 380, 1600, 180, { fontSize: 104, bold: true }),
    T('Subtítulo ou data', 160, 580, 1600, 80, { fontSize: 40, opacity: 0.7 })
  ] }]),
  campanha: () => tpl([
    { elements: [
      BAR(160, 340, 120, 12, {}),
      T('Nome da campanha', 160, 390, 1600, 170, { fontSize: 112, bold: true }),
      T('Cliente · mês/ano', 160, 580, 1600, 70, { fontSize: 40, opacity: 0.7 })
    ] },
    { elements: [
      T('Objetivo', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      T('O que a campanha precisa alcançar e como vamos medir.\n\n• Meta principal\n• Indicador de sucesso\n• Prazo', 160, 300, 1500, 600, { fontSize: 44 })
    ] },
    { elements: [
      T('Público', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      BAR(160, 320, 760, 560, { radius: 24, opacity: 0.08 }),
      BAR(1000, 320, 760, 560, { radius: 24, opacity: 0.08 }),
      T('Quem é', 220, 370, 640, 70, { fontSize: 40, bold: true }),
      T('Perfil, interesses e onde está.', 220, 460, 640, 380, { fontSize: 36 }),
      T('O que precisa ouvir', 1060, 370, 640, 70, { fontSize: 40, bold: true }),
      T('Mensagem e tom.', 1060, 460, 640, 380, { fontSize: 36 })
    ] },
    { elements: [
      T('Estratégia e canais', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      T('• Canal 1 — papel na campanha\n• Canal 2 — papel na campanha\n• Canal 3 — papel na campanha', 160, 300, 1500, 600, { fontSize: 44 })
    ] },
    { elements: [
      T('Cronograma', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      BAR(160, 520, 1600, 8, { opacity: 0.25 }),
      ...[0, 1, 2, 3].map(i => ({ type: 'shape', shape: 'ellipse', x: 160 + i * 520, y: 500, w: 48, h: 48 })),
      ...['Semana 1', 'Semana 2', 'Semana 3', 'Semana 4'].map((t, i) => T(t + '\nEntrega', 160 + i * 520, 580, 420, 200, { fontSize: 36 }))
    ] },
    { elements: [
      T('Próximos passos', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      T('1. Aprovação do plano\n2. Produção dos criativos\n3. Publicação', 160, 300, 1500, 600, { fontSize: 44 })
    ] }
  ]),
  relatorio: () => tpl([
    { elements: [
      T('Relatório mensal', 160, 390, 1600, 170, { fontSize: 112, bold: true }),
      T('Cliente · mês/ano', 160, 580, 1600, 70, { fontSize: 40, opacity: 0.7 })
    ] },
    { elements: [
      T('Resumo do mês', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      ...[0, 1, 2].map(i => BAR(160 + i * 547, 320, 507, 360, { radius: 24, opacity: 0.08 })),
      ...['Entregas', 'Horas', 'Alcance'].map((t, i) => T(t, 210 + i * 547, 360, 420, 60, { fontSize: 36, opacity: 0.7 })),
      ...['00', '00h', '00 mil'].map((t, i) => T(t, 210 + i * 547, 440, 420, 160, { fontSize: 120, bold: true }))
    ] },
    { elements: [
      T('Destaques', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      T('• O que funcionou melhor\n• O que aprendemos\n• O que muda no próximo mês', 160, 300, 1500, 600, { fontSize: 44 })
    ] },
    { elements: [
      T('Plano do próximo mês', 160, 140, 1600, 110, { fontSize: 72, bold: true }),
      T('• Prioridade 1\n• Prioridade 2\n• Prioridade 3', 160, 300, 1500, 600, { fontSize: 44 })
    ] }
  ])
};

module.exports = function setupDecks(app, deps) {
  const {
    getDb, saveEntity, uid, nowISO, requireAuth, canAccessWs, tenancy, uploadsDir, orgPlan,
    fonts: fontLib
  } = deps;
  const MAX_FONTS = 12;
  const cleanFonts = (raw) => (Array.isArray(raw) ? raw : []).filter(x => x && x.id && x.family && typeof x.css === 'string')
    .map(x => ({ id: x.id, family: x.family, source: x.source === 'upload' ? 'upload' : 'google', css: x.css }));
  const decks = () => { const db = getDb(); if (!Array.isArray(db.decks)) db.decks = []; return db.decks; };
  // Resultado de importação (Figma) guardado no servidor: o navegador só
  // manda o id — slides, imagens e CSS das fontes não passam pela mão dele.
  const IMPORT_TTL = 30 * 60 * 1000;
  const imports = new Map();
  function registerImport(userId, data) {
    const now = Date.now();
    for (const [k, v] of imports) if (now - v.at > IMPORT_TTL) imports.delete(k);
    const id = uid() + uid();
    imports.set(id, { userId, at: now, data });
    return id;
  }
  function takeImport(id, userId) {
    const it = imports.get(id);
    if (!it || it.userId !== userId || Date.now() - it.at > IMPORT_TTL) return null;
    return it.data;
  }
  const findDeck = (id) => decks().find(d => d.id === id);

  function roleOf(user, deck) {
    if (!user || !deck || user.isFreelancer) return null;
    if (user.isAdmin || deck.ownerId === user.id) return 'owner';
    return canAccessWs(user, deck.workspaceId) ? 'editor' : null;
  }
  const canRead = (u, d) => !!d && !d.deletedAt && !!roleOf(u, d);
  const canShare = (u, d) => canRead(u, d) && roleOf(u, d) === 'owner';

  function linkFrom(user, body) {
    const db = getDb();
    const out = {};
    if ('projectId' in body) {
      const p = body.projectId ? (db.projects || []).find(x => x.id === body.projectId && !x.deletedAt) : null;
      if (body.projectId && (!p || !canAccessWs(user, p.workspaceId))) return { error: 'Projeto inválido' };
      out.projectId = p ? p.id : null;
      if (p && !('clientId' in body)) out.clientId = p.clientId || null;
    }
    if ('clientId' in body) {
      const c = body.clientId ? (db.clients || []).find(x => x.id === body.clientId && !x.deletedAt) : null;
      if (body.clientId && (!c || !canAccessWs(user, c.workspaceId))) return { error: 'Cliente inválido' };
      out.clientId = c ? c.id : null;
      if (!out.clientId) out.projectId = null;
    }
    if (out.projectId && out.clientId) {
      const p = (db.projects || []).find(x => x.id === out.projectId);
      if (p && p.clientId && p.clientId !== out.clientId) out.projectId = null;
    }
    return out;
  }

  function strip(d, user, { full = false } = {}) {
    const slides = d.slides || [];
    const out = {
      id: d.id,
      workspaceId: d.workspaceId,
      clientId: d.clientId || null,
      projectId: d.projectId || null,
      title: d.title || 'Sem título',
      ownerId: d.ownerId || null,
      theme: cleanTheme(d.theme),
      size: cleanSize(d.size),
      fonts: cleanFonts(d.fonts),
      slideCount: slides.length,
      favorite: !!(user && Array.isArray(d.favoritedBy) && d.favoritedBy.includes(user.id)),
      publicShareEnabled: !!d.publicShareEnabled,
      publicUrl: d.publicShareEnabled && d.publicShareToken ? '/hub/presentations/public/' + d.publicShareToken : null,
      myRole: user ? roleOf(user, d) : null,
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
      deletedAt: d.deletedAt || null
    };
    if (full) { out.slides = slides; out.version = d.version || 0; out.guides = cleanGuides(d.guides); out.grid = cleanGrid(d.grid); }
    else out.cover = slides[0] || null;
    return out;
  }

  const noFreelancer = (req, res, next) => (req.user && req.user.isFreelancer
    ? res.status(403).json({ error: 'Freelancer não tem acesso às apresentações' })
    : next());

  // Lista (sem slides; só a capa pra miniatura). trash=1 → Lixeira.
  app.get('/api/decks', requireAuth, noFreelancer, (req, res) => {
    const u = req.user;
    const trash = req.query.trash === '1';
    let list = decks().filter(d => trash ? (d.deletedAt && roleOf(u, d)) : canRead(u, d));
    if (req.query.clientId) list = list.filter(d => d.clientId === req.query.clientId);
    if (req.query.projectId) list = list.filter(d => d.projectId === req.query.projectId);
    res.json(list.map(d => strip(d, u)));
  });

  // Modelos (antes de /:id pra não cair nela).
  app.get('/api/decks/templates', requireAuth, noFreelancer, (req, res) => {
    res.json([
      { key: 'blank', name: 'Em branco', desc: 'Um slide de capa pra começar do zero.' },
      { key: 'campanha', name: 'Apresentação de campanha', desc: 'Objetivo, público, estratégia, cronograma e próximos passos.' },
      { key: 'relatorio', name: 'Relatório mensal', desc: 'Resumo em números, destaques e plano do próximo mês.' }
    ].map(t => ({ ...t, slides: TEMPLATES[t.key]() })));
  });

  app.get('/api/decks/:id', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    res.json(strip(d, req.user, { full: true }));
  });

  app.post('/api/decks', requireAuth, noFreelancer, (req, res) => {
    const u = req.user;
    const body = req.body || {};
    const wsId = String(body.workspaceId || '').trim();
    if (!wsId || !canAccessWs(u, wsId)) return res.status(400).json({ error: 'Squad inválido' });
    const link = linkFrom(u, body);
    if (link.error) return res.status(400).json({ error: link.error });
    const make = TEMPLATES[body.template] || TEMPLATES.blank;
    // Importação (Figma): slides, tamanho e fontes vêm do resultado guardado no servidor
    let imp = null;
    if (body.importId) {
      imp = takeImport(String(body.importId), u.id);
      if (!imp) return res.status(400).json({ error: 'A importação expirou. Importe de novo.' });
    }
    const now = nowISO();
    const d = {
      id: uid(),
      workspaceId: wsId,
      clientId: link.clientId || null,
      projectId: link.projectId || null,
      title: str(body.title, 200).trim() || (imp && imp.title) || 'Sem título',
      ownerId: u.id,
      theme: cleanTheme(body.theme),
      slides: imp ? cleanSlides(imp.slides) : make(),
      ...(imp ? { size: cleanSize(imp.size), fonts: cleanFonts(imp.fonts) } : {}),
      yState: null,
      version: 0,
      favoritedBy: [],
      createdAt: now,
      updatedAt: now,
      lastEditedBy: u.id
    };
    decks().push(d);
    saveEntity('decks', d);
    res.status(201).json(strip(d, u, { full: true }));
  });

  // Metadados: título e vínculo com cliente/projeto.
  app.patch('/api/decks/:id', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    const body = req.body || {};
    if (typeof body.title === 'string') d.title = body.title.slice(0, 200).trim() || 'Sem título';
    if ('clientId' in body || 'projectId' in body) {
      const link = linkFrom(req.user, body);
      if (link.error) return res.status(400).json({ error: link.error });
      if ('clientId' in link) d.clientId = link.clientId;
      if ('projectId' in link) d.projectId = link.projectId;
    }
    d.updatedAt = nowISO();
    saveEntity('decks', d);
    res.json(strip(d, req.user));
  });

  // Retrato em JSON mandado pelo editor (lista, link público e PDF).
  app.put('/api/decks/:id/content', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    const body = req.body || {};
    if (!Array.isArray(body.slides)) return res.status(400).json({ error: 'slides ausente' });
    d.slides = cleanSlides(body.slides);
    if (body.theme) d.theme = cleanTheme(body.theme);
    if (body.size) d.size = cleanSize(body.size);
    if ('guides' in body) d.guides = cleanGuides(body.guides);
    if ('grid' in body) d.grid = cleanGrid(body.grid);
    if (typeof body.title === 'string' && body.title.trim()) d.title = body.title.slice(0, 200).trim();
    d.version = (d.version || 0) + 1;
    d.updatedAt = nowISO();
    d.lastEditedBy = req.user.id;
    saveEntity('decks', d);
    res.json({ version: d.version, updatedAt: d.updatedAt });
  });

  app.post('/api/decks/:id/duplicate', requireAuth, noFreelancer, (req, res) => {
    const src = findDeck(req.params.id);
    if (!canRead(req.user, src)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    const now = nowISO();
    const d = {
      id: uid(),
      workspaceId: src.workspaceId,
      clientId: src.clientId || null,
      projectId: src.projectId || null,
      title: ((src.title || 'Sem título') + ' (cópia)').slice(0, 200),
      ownerId: req.user.id,
      theme: cleanTheme(src.theme),
      size: cleanSize(src.size),
      fonts: cleanFonts(src.fonts),
      guides: cleanGuides(src.guides),
      grid: cleanGrid(src.grid),
      slides: cleanSlides(JSON.parse(JSON.stringify(src.slides || []))),
      yState: null,
      version: 0,
      favoritedBy: [],
      createdAt: now,
      updatedAt: now,
      lastEditedBy: req.user.id
    };
    decks().push(d);
    saveEntity('decks', d);
    res.status(201).json(strip(d, req.user));
  });

  app.post('/api/decks/:id/favorite', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    const on = req.body && req.body.on !== undefined ? !!req.body.on : true;
    const set = new Set(Array.isArray(d.favoritedBy) ? d.favoritedBy : []);
    if (on) set.add(req.user.id); else set.delete(req.user.id);
    d.favoritedBy = [...set];
    saveEntity('decks', d);
    res.json({ favorite: on });
  });

  // Lixeira: excluir é reversível.
  app.delete('/api/decks/:id', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    d.deletedAt = nowISO();
    d.deletedBy = req.user.id;
    saveEntity('decks', d);
    res.json({ ok: true });
  });
  app.post('/api/decks/:id/restore', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!d || !d.deletedAt || !roleOf(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    d.deletedAt = null;
    d.deletedBy = null;
    d.updatedAt = nowISO();
    saveEntity('decks', d);
    res.json(strip(d, req.user));
  });

  /* Importação (Figma) dentro de uma apresentação aberta: junta as fontes
     (mesma família = a que já existe) e devolve os slides pro editor
     colocar no fim, com as fontes já trocadas pelos ids desta apresentação. */
  app.post('/api/decks/:id/import', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    const imp = takeImport(String((req.body || {}).importId || ''), req.user.id);
    if (!imp) return res.status(400).json({ error: 'A importação expirou. Importe de novo.' });
    const fonts = cleanFonts(d.fonts);
    const remap = {};
    for (const f of cleanFonts(imp.fonts)) {
      const same = fonts.find(x => x.family.toLowerCase() === f.family.toLowerCase());
      if (same) remap['f:' + f.id] = 'f:' + same.id;
      else if (fonts.length < MAX_FONTS) { fonts.push(f); remap['f:' + f.id] = 'f:' + f.id; }
      else remap['f:' + f.id] = null;
    }
    d.fonts = fonts;
    d.updatedAt = nowISO();
    saveEntity('decks', d);
    const slides = cleanSlides(imp.slides).map(sl => ({
      ...sl, elements: sl.elements.map(e => (e.font && e.font in remap ? { ...e, font: remap[e.font] } : e))
    }));
    res.json({ fonts, slides, size: cleanSize(imp.size) });
  });

  /* Fontes próprias da apresentação: { google: 'Roboto Slab' } ou
     { upload: { name, data }, family, weight, italic }. Mesma família enviada
     de novo (outro peso) entra na mesma fonte. */
  app.post('/api/decks/:id/fonts', requireAuth, noFreelancer, async (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    if (!fontLib) return res.status(503).json({ error: 'Fontes indisponíveis.' });
    const fonts = cleanFonts(d.fonts);
    const body = req.body || {};
    try {
      let entry;
      if (body.google) {
        const g = await fontLib.fetchGoogle(body.google);
        if (fonts.some(x => x.family.toLowerCase() === g.family.toLowerCase())) return res.status(409).json({ error: 'Essa fonte já está na apresentação.' });
        entry = { id: uid(), family: g.family, source: 'google', css: g.css };
      } else if (body.upload) {
        const { name, data } = body.upload;
        const ext = String(name || '').toLowerCase().split('.').pop();
        if (!fontLib.mime[ext]) return res.status(400).json({ error: 'Envie um arquivo de fonte .woff2, .woff, .ttf ou .otf.' });
        const buf = Buffer.from(String(data || '').split(',').pop(), 'base64');
        if (!buf.length || buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo de fonte vazio ou maior que 5 MB.' });
        const family = String(body.family || '').trim().replace(/\s+/g, ' ');
        if (!/^[\p{L}\p{N} _-]{1,60}$/u.test(family)) return res.status(400).json({ error: 'Dê um nome à fonte (letras, números, espaço ou hífen).' });
        const weight = [100, 200, 300, 400, 500, 600, 700, 800, 900].includes(Number(body.weight)) ? Number(body.weight) : 400;
        const style = body.italic ? 'italic' : 'normal';
        const fmt = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }[ext];
        const url = fontLib.save(buf, ext);
        const face = `@font-face { font-family: "${family}"; src: url(${url}) format("${fmt}"); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`;
        const same = fonts.find(x => x.source === 'upload' && x.family.toLowerCase() === family.toLowerCase());
        if (same) { same.css += '\n' + face; entry = same; }
        else entry = { id: uid(), family, source: 'upload', css: face };
      } else {
        return res.status(400).json({ error: 'Informe a fonte do Google ou o arquivo.' });
      }
      const next = fonts.some(x => x.id === entry.id) ? fonts : [...fonts, entry];
      if (next.length > MAX_FONTS) return res.status(400).json({ error: `Cada apresentação aceita até ${MAX_FONTS} fontes.` });
      d.fonts = next;
      d.updatedAt = nowISO();
      saveEntity('decks', d);
      res.json({ fonts: cleanFonts(d.fonts), added: entry.id });
    } catch (e) {
      res.status(400).json({ error: e.message || 'Não deu pra adicionar a fonte.' });
    }
  });
  // Tira a fonte da apresentação (os arquivos ficam: o nome é o hash, outro pode usar)
  app.delete('/api/decks/:id/fonts/:fid', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    d.fonts = cleanFonts(d.fonts).filter(x => x.id !== req.params.fid);
    d.updatedAt = nowISO();
    saveEntity('decks', d);
    res.json({ fonts: d.fonts });
  });

  /* Link público (leitura). Só quem criou ou admin liga/desliga. Desligar
     mantém o token: religar devolve o mesmo endereço. */
  app.post('/api/decks/:id/public-link', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    if (!canShare(req.user, d)) return res.status(403).json({ error: 'Só quem criou a apresentação ou um admin pode gerar o link público' });
    if (!d.publicShareToken) d.publicShareToken = (uid() + uid() + uid()).slice(0, 32);
    d.publicShareEnabled = true;
    saveEntity('decks', d);
    res.json({ enabled: true, url: '/hub/presentations/public/' + d.publicShareToken });
  });
  app.delete('/api/decks/:id/public-link', requireAuth, noFreelancer, (req, res) => {
    const d = findDeck(req.params.id);
    if (!canRead(req.user, d)) return res.status(404).json({ error: 'Apresentação não encontrada' });
    if (!canShare(req.user, d)) return res.status(403).json({ error: 'Só quem criou a apresentação ou um admin pode desligar o link público' });
    d.publicShareEnabled = false;
    saveEntity('decks', d);
    res.json({ enabled: false });
  });

  /* Público: sem login. Busca no cache de todas as organizações. */
  const publicDeck = (token) => {
    const t = String(token || '');
    if (t.length < 16) return null;
    const all = deps.getRawDb().decks || [];
    return all.find(d => d.publicShareToken === t && d.publicShareEnabled && !d.deletedAt) || null;
  };
  app.get('/api/decks/public/:token', (req, res) => {
    const d = publicDeck(req.params.token);
    if (!d) return res.status(404).json({ error: 'Apresentação não encontrada ou link desligado' });
    const base = '/api/decks/public/' + d.publicShareToken + '/file/';
    // Imagens de /uploads exigem login: no link público passam pela rota abaixo.
    const slides = (d.slides || []).map(s => ({
      ...s,
      notes: '',
      elements: (s.elements || []).map(e => (e.type === 'image' && e.src && e.src.startsWith('/uploads/')
        ? { ...e, src: base + encodeURIComponent(e.src.slice(9)) } : e))
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ id: d.id, title: d.title || 'Sem título', theme: cleanTheme(d.theme), size: cleanSize(d.size), fonts: cleanFonts(d.fonts), slides, updatedAt: d.updatedAt });
  });
  app.get('/api/decks/public/:token/file/:name', (req, res) => {
    const d = publicDeck(req.params.token);
    const name = path.basename(String(req.params.name || ''));
    if (!d || !uploadsIn(d).has(name) || !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name)) return res.status(404).end();
    const file = path.join(uploadsDir, name);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', 'sandbox');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  });

  /* Pro docs-rt.js (/rt/decks/<id>). */
  const rt = {
    canAccess(deckId, userId) {
      const raw = deps.getRawDb();
      const d = (raw.decks || []).find(x => x.id === deckId);
      const orgId = d && tenancy.wsOrgId(d.workspaceId);
      if (!orgId || orgPlan(tenancy.orgById(orgId)).readOnly) return false;
      return tenancy.run(orgId, () => {
        const user = (getDb().users || []).find(u => u.id === userId);
        return !!user && user.active !== false && deps.userAllowed(user) && canRead(user, d);
      });
    },
    loadInitialState(deckId, Y) {
      const d = (deps.getRawDb().decks || []).find(x => x.id === deckId);
      if (!d) return null;
      if (d.yState) { try { return Buffer.from(d.yState, 'base64'); } catch { return null; } }
      return buildYState(Y, d);
    },
    onPersist(deckId, bytes) {
      const d = (deps.getRawDb().decks || []).find(x => x.id === deckId);
      if (!d) return;
      d.yState = Buffer.from(bytes).toString('base64');
      d.updatedAt = nowISO();
      saveEntity('decks', d);
    }
  };

  return { rt, cleanSlides, cleanTheme, TEMPLATES, registerImport };
};
