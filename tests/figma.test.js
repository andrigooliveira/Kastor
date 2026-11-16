/* Importar do Figma (figma.js): leitura do link, quadros e conversão em slides.
   Sem rede: usa nós de exemplo no formato da API do Figma. */
const test = require('node:test');
const assert = require('node:assert');
const { parseFigmaUrl, collectFrames, convertFrames } = require('../figma');

test('figma: link, quadros e conversão', () => {
let n = 0; const rid = () => 'id' + (++n);
const I = [[1, 0, 0], [0, 1, 0]];
const bb = (x, y, w, h) => ({ x, y, width: w, height: h });
const solid = (r, g, b, a = 1) => ({ type: 'SOLID', color: { r, g, b, a } });

// Links
assert.deepStrictEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Deck?node-id=12-34&t=x'), { key: 'AbCdEf1234567890', node: '12:34' });
assert.deepStrictEqual(parseFigmaUrl('https://www.figma.com/slides/ZZZZZZZZZZZZ/x'), { key: 'ZZZZZZZZZZZZ', node: null });
assert.strictEqual(parseFigmaUrl('https://google.com'), null);

// Quadros: design (frame + seção) e slides
const doc = { document: { children: [
  { name: 'Página 1', children: [
    { id: '1:1', type: 'FRAME', name: 'Capa', absoluteBoundingBox: bb(0, 0, 1920, 1080) },
    { id: '1:2', type: 'SECTION', name: 'S', children: [{ id: '1:3', type: 'FRAME', name: 'Dentro', absoluteBoundingBox: bb(0, 2000, 1920, 1080) }] },
    { id: '1:4', type: 'TEXT', name: 'solto', absoluteBoundingBox: bb(0, 0, 10, 10) }
  ] },
  { name: 'Slides', children: [{ id: '2:1', type: 'SLIDE_GRID', children: [{ id: '2:2', type: 'SLIDE_ROW', children: [{ id: '2:3', type: 'SLIDE', name: 'Slide 1', absoluteBoundingBox: bb(0, 0, 1920, 1080) }] }] }] }
] } };
const fr = collectFrames(doc);
assert.deepStrictEqual(fr.map(f => f.id), ['1:1', '1:3', '2:3']);

// Conversão editável
const frame = {
  id: '1:1', type: 'FRAME', name: 'Capa', absoluteBoundingBox: bb(100, 100, 960, 540), fills: [solid(0.1, 0.1, 0.1)],
  children: [
    { id: 't', type: 'TEXT', name: 'Título', characters: 'Olá Figma', absoluteBoundingBox: bb(140, 140, 400, 60), relativeTransform: I,
      fills: [solid(1, 1, 1)], style: { fontFamily: 'Montserrat', fontSize: 40, fontWeight: 700, textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER', textCase: 'UPPER' } },
    { id: 'r', type: 'RECTANGLE', name: 'Card', absoluteBoundingBox: bb(140, 300, 200, 100), relativeTransform: I, fills: [solid(1, 0, 0, 0.5)], strokes: [solid(0, 0, 0)], strokeWeight: 2, cornerRadius: 12 },
    { id: 'e', type: 'ELLIPSE', name: 'Bola', absoluteBoundingBox: bb(400, 300, 50, 50), relativeTransform: I, fills: [solid(0, 1, 0)] },
    { id: 'l', type: 'LINE', name: 'Linha', absoluteBoundingBox: bb(140, 450, 300, 0), relativeTransform: I, strokes: [solid(0, 0, 1)], strokeWeight: 4 },
    { id: 'img', type: 'RECTANGLE', name: 'Foto', absoluteBoundingBox: bb(600, 140, 200, 200), relativeTransform: I, fills: [{ type: 'IMAGE', imageRef: 'abc', scaleMode: 'FILL' }] },
    { id: 'v', type: 'VECTOR', name: 'Logo', absoluteBoundingBox: bb(800, 400, 50, 50), absoluteRenderBounds: bb(798, 398, 54, 54), relativeTransform: I },
    { id: 'sh', type: 'RECTANGLE', name: 'Com sombra', absoluteBoundingBox: bb(600, 400, 100, 50), relativeTransform: I, fills: [solid(1, 1, 1)], effects: [{ type: 'DROP_SHADOW', visible: true, offset: { x: 0, y: 4 }, radius: 8, color: { r: 0, g: 0, b: 0, a: 0.25 } }] },
    { id: 'blur', type: 'RECTANGLE', name: 'Desfocado', absoluteBoundingBox: bb(600, 460, 100, 50), relativeTransform: I, fills: [solid(1, 1, 1)], effects: [{ type: 'LAYER_BLUR', visible: true, radius: 4 }] },
    { id: 'grad', type: 'RECTANGLE', name: 'Degradê', absoluteBoundingBox: bb(700, 140, 100, 100), relativeTransform: I, fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }] },
    { id: 'mix', type: 'TEXT', name: 'Misto', characters: 'Oi forte', absoluteBoundingBox: bb(140, 600, 300, 40), relativeTransform: I, fills: [solid(0, 0, 0)],
      style: { fontFamily: 'Inter', fontSize: 20, lineHeightUnit: 'PIXELS', lineHeightPx: 30, letterSpacing: 2 }, characterStyleOverrides: [0, 0, 0, 1, 1, 1, 1, 1], styleOverrideTable: { 1: { fontWeight: 700, fills: [solid(1, 0, 0)] } } },
    { id: 'g', type: 'GROUP', name: 'Grupo A', absoluteBoundingBox: bb(140, 480, 300, 40), relativeTransform: I, children: [
      { id: 'g1', type: 'TEXT', name: 'a', characters: 'A', absoluteBoundingBox: bb(140, 480, 20, 40), relativeTransform: I, fills: [solid(1, 1, 1)], style: { fontFamily: 'Inter', fontSize: 20 } },
      { id: 'g2', type: 'RECTANGLE', name: 'b', absoluteBoundingBox: bb(200, 480, 40, 40), relativeTransform: I, fills: [solid(1, 1, 0)] }
    ] },
    { id: 'rot', type: 'TEXT', name: 'Girado', characters: 'x', absoluteBoundingBox: bb(500, 500, 20, 20), size: { x: 14, y: 14 }, relativeTransform: [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0]], style: { fontFamily: 'Inter' } },
    { id: 'hid', type: 'TEXT', name: 'Oculto', visible: false, characters: 'x', absoluteBoundingBox: bb(0, 0, 1, 1) }
  ]
};
const c = convertFrames([frame], { w: 1920, h: 1080 }, { mode: 'editable', rid });
const sl = c.slides[0];
const by = (name) => sl.elements.find(e => e.name === name);
assert.strictEqual(sl.bg, '#1a1a1a');
const t = by('Título');
assert.strictEqual(t.text, 'OLÁ FIGMA'); assert.strictEqual(t.type, 'text');
assert.deepStrictEqual([t.x, t.y, t.h, t.fontSize, t.bold, t.align, t.valign, t.color, t.font], [80, 80, 120, 80, true, 'center', 'middle', '#ffffff', 'fam:Montserrat']);
const r = by('Card');
assert.deepStrictEqual([r.type, r.shape, r.fill, r.stroke, r.strokeW, r.radius, r.w, r.h], ['shape', 'rect', 'rgba(255, 0, 0, 0.5)', '#000000', 4, 24, 400, 200]);
assert.strictEqual(by('Bola').shape, 'ellipse');
assert.deepStrictEqual([by('Linha').shape, by('Linha').strokeW], ['line', 8]);
assert.strictEqual(by('Foto').type, 'image'); assert.strictEqual(c.imageFills[0].ref, 'abc');
assert.strictEqual(by('Logo').type, 'image'); assert.strictEqual(by('Logo').x, (798 - 100) * 2);
// Sombra projetada simples: forma com sombra (não vira imagem)
assert.deepStrictEqual([by('Com sombra').type, by('Com sombra').shadow], ['shape', { x: 0, y: 8, blur: 16, spread: 0, color: 'rgba(0, 0, 0, 0.25)' }]);
// Desfoque não tem equivalente: SVG
assert.strictEqual(by('Desfocado').type, 'image');
// Degradê nativo
assert.deepStrictEqual([by('Degradê').type, by('Degradê').gradient.type, by('Degradê').gradient.stops.map(x => x.color)], ['shape', 'linear', ['#ff0000', '#0000ff']]);
// Texto girado continua texto, com o tamanho real em volta do centro
const g = by('Girado');
assert.deepStrictEqual([g.type, g.rot, g.w, g.h, g.x, g.y], ['text', -45, 28, 28, 806, 806]);
// Trechos com estilo, altura de linha e espaçamento
const mx = by('Misto');
assert.deepStrictEqual(mx.runs, [{ text: 'Oi ' }, { text: 'forte', bold: true, color: '#ff0000' }]);
assert.deepStrictEqual([mx.lineHeight, mx.letterSpacing], [1.5, 4]);
assert.ok(!by('Oculto'));
assert.deepStrictEqual(sl.groups, [{ id: by('a').groupId, name: 'Grupo A' }]);
assert.strictEqual(by('b').groupId, by('a').groupId);
// Vetores e o que não tem equivalente vão como SVG; nada vira PNG no modo editável
assert.deepStrictEqual(c.vectors.map(x => x.nodeId).sort(), ['blur', 'v']);
assert.strictEqual(c.rasters.length, 0);
assert.deepStrictEqual(c.families.sort(), ['Inter', 'Montserrat']);
// Ordem: primeiro filho do Figma fica embaixo
assert.ok(sl.elements.indexOf(t) < sl.elements.indexOf(r));

// Modo imagem fiel
const ci = convertFrames([frame], { w: 1920, h: 1080 }, { mode: 'image', rid });
assert.strictEqual(ci.slides[0].elements.length, 1);
assert.deepStrictEqual(ci.rasters.map(x => x.nodeId), ['1:1']);

// Quadro de outra proporção: encaixa centralizado
const sq = convertFrames([{ ...frame, absoluteBoundingBox: bb(0, 0, 1000, 1000), children: [] }], { w: 1920, h: 1080 }, { mode: 'image', rid });
const e0 = sq.slides[0].elements[0];
assert.deepStrictEqual([e0.x, e0.y, e0.w, e0.h], [420, 0, 1080, 1080]);
});

/* Rotas (/api/figma/*) contra um Figma simulado: conectar, listar quadros,
   importar (renders, imagens de preenchimento e fontes) e desconectar. */
test('figma: rotas com o Figma simulado', async () => {
  const express = require('express');
  const setupFigma = require('../figma');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const user = { id: 'u1', name: 'Teste' };
  const saved = [], uploads = [], imports = [];
  const I = [[1, 0, 0], [0, 1, 0]];
  const bb = (x, y, w, h) => ({ x, y, width: w, height: h });
  const frame = (id, name) => ({
    id, type: 'FRAME', name, absoluteBoundingBox: bb(0, 0, 1920, 1080), fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [
      { id: id + 't', type: 'TEXT', name: 'Título', characters: 'Oi', absoluteBoundingBox: bb(100, 100, 400, 80), relativeTransform: I, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }], style: { fontFamily: 'Montserrat', fontSize: 64 } },
      { id: id + 'v', type: 'VECTOR', name: 'Logo', absoluteBoundingBox: bb(1700, 900, 100, 100), relativeTransform: I },
      { id: id + 'p', type: 'RECTANGLE', name: 'Foto', absoluteBoundingBox: bb(1000, 100, 800, 600), relativeTransform: I, fills: [{ type: 'IMAGE', imageRef: 'ref1', scaleMode: 'FILL' }] }
    ]
  });
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(String(url));
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, headers: { get: () => 'application/json' } });
    const u = String(url);
    if (u.startsWith('https://img/')) {
      const svg = u.endsWith('.svg');
      return { ok: true, status: 200, headers: { get: () => (svg ? 'image/svg+xml' : 'image/png') }, arrayBuffer: async () => (svg ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') : PNG) };
    }
    if ((opts.headers || {})['X-Figma-Token'] !== 'figd_token_valido_123456789') return json({ status: 403 }, 403);
    if (u.endsWith('/me')) return json({ handle: 'teste', email: 't@x.com' });
    if (/\/files\/KEY1234567890\?depth=4$/.test(u)) return json({ name: 'Deck do Figma', document: { children: [{ name: 'P1', children: [frame('1:1', 'Capa'), frame('1:2', 'Fim')] }] } });
    if (u.includes('/images/KEY1234567890?ids=')) {
      const ids = decodeURIComponent(u.match(/ids=([^&]+)/)[1]).split(',');
      const ext = u.includes('format=svg') ? '.svg' : '.png';
      return json({ images: Object.fromEntries(ids.map(id => [id, 'https://img/' + id + ext])) });
    }
    if (u.includes('/files/KEY1234567890/nodes?ids=')) {
      const ids = decodeURIComponent(u.match(/ids=([^&]+)/)[1]).split(',');
      return json({ name: 'Deck do Figma', nodes: Object.fromEntries(ids.map(id => [id, { document: frame(id, id === '1:1' ? 'Capa' : 'Fim') }])) });
    }
    if (u.endsWith('/files/KEY1234567890/images')) return json({ meta: { images: { ref1: 'https://img/ref1.png' } } });
    return json({ err: 'não simulado' }, 404);
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  setupFigma(app, {
    getDb: () => ({ users: [user] }),
    requireAuth: (req, res, next) => { req.user = user; next(); },
    auth: { encryptString: (s) => 'enc:' + s, decryptString: (s) => s.slice(4) },
    saveEntity: (t, e) => saved.push(t),
    uid: (() => { let n = 0; return () => 'x' + (++n).toString().padStart(11, '0'); })(),
    nowISO: () => '2026-11-16T00:00:00Z',
    saveUploadFromDataUri: (data, name) => { uploads.push(name); return { url: '/uploads/f' + uploads.length + '.png' }; },
    fonts: { fetchGoogle: async (fam) => { if (fam === 'Montserrat') return { family: 'Montserrat', css: '@font-face{}' }; throw new Error('não'); } },
    registerImport: (userId, data) => { imports.push(data); return 'imp1'; },
    fetchImpl
  });
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/figma';
  const call = async (p, method = 'GET', body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.deepStrictEqual((await call('/status')).body, { connected: false });
    assert.strictEqual((await call('/frames', 'POST', { url: 'https://www.figma.com/design/KEY1234567890/x' })).status, 409);
    const bad = await call('/token', 'PUT', { token: 'figd_token_errado_123456789' });
    assert.strictEqual(bad.status, 400);
    const ok = await call('/token', 'PUT', { token: 'figd_token_valido_123456789' });
    assert.strictEqual(ok.body.handle, 'teste');
    assert.strictEqual(user.figma.tokenEnc, 'enc:figd_token_valido_123456789');
    // O token nunca volta na resposta
    assert.ok(!JSON.stringify(ok.body).includes('figd_'));
    const fr = await call('/frames', 'POST', { url: 'https://www.figma.com/design/KEY1234567890/Deck' });
    assert.strictEqual(fr.body.name, 'Deck do Figma');
    assert.deepStrictEqual(fr.body.frames.map(f => [f.id, f.name, f.w, f.h, !!f.thumb]), [['1:1', 'Capa', 1920, 1080, true], ['1:2', 'Fim', 1920, 1080, true]]);
    const imp = await call('/import', 'POST', { url: 'https://www.figma.com/design/KEY1234567890/Deck', ids: ['1:1', '1:2'], mode: 'editable' });
    assert.strictEqual(imp.status, 200, JSON.stringify(imp.body));
    assert.deepStrictEqual([imp.body.importId, imp.body.slideCount, imp.body.size], ['imp1', 2, { w: 1920, h: 1080 }]);
    const data = imports[0];
    const els = data.slides[0].elements;
    assert.deepStrictEqual(els.map(e => [e.name, e.type]), [['Título', 'text'], ['Logo', 'image'], ['Foto', 'image']]);
    assert.ok(els.every(e => e.type !== 'image' || e.src.startsWith('/uploads/')));
    // O vetor veio como SVG; pediu os nós com tamanho real
    assert.ok(uploads.some(n => n === 'Logo.svg'));
    assert.ok(seen.some(x => x.includes('format=svg')) && seen.some(x => x.includes('geometry=paths')));
    assert.strictEqual(els[0].font, 'f:' + data.fonts[0].id);
    assert.strictEqual(data.fonts[0].family, 'Montserrat');
    // Mesma imagem de preenchimento nos dois quadros: baixa e guarda uma vez só
    assert.strictEqual(uploads.filter(n => n.startsWith('Foto')).length, 1);
    const off = await call('/token', 'DELETE');
    assert.deepStrictEqual(off.body, { connected: false });
    assert.ok(!user.figma);
  } finally { srv.close(); }
});
