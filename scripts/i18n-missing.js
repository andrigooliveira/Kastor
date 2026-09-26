/* ─────────────────────────────────────────────────────────────
   reWork — frases de interface sem tradução

   Varre o código (JS + HTML) atrás do texto em português que aparece na tela
   e lista o que ainda não está em public/i18n/en.js. Rode depois de mexer em
   telas, e-mails ou mensagens de erro:

     npm i --no-save acorn acorn-walk parse5
     node scripts/i18n-missing.js            # lista o que falta
     node scripts/i18n-missing.js --json     # idem, em JSON (chave + onde aparece)

   A chave é o texto em português com espaços normalizados; partes variáveis
   (${...} num template) viram {0}, {1}… Acrescente em public/i18n/en.js
   "chave": "tradução". A lista tem ruído (nomes de classe, termos técnicos,
   texto só do console): o que não é interface, ignore. No navegador,
   localStorage['rework-i18n-debug'] = '1' + I18N.missing() mostra o que
   apareceu na tela sem tradução.
   ───────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
let acorn, walk, parse5;
try { acorn = require('acorn'); walk = require('acorn-walk'); parse5 = require('parse5'); }
catch (e) { console.error('Instale antes: npm i --no-save acorn acorn-walk parse5'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const JS_FILES = ['public/js/app.js', 'public/js/boot.js', 'public/js/acesso.js', 'public/js/writer/editor-ui.js', 'public/js/writer/index.js',
  'public/js/writer/standalone.js', 'server.js', 'email-templates.js', 'billing.js', 'support.js', 'docs-rt.js', 'google-cal.js', 'google-login.js', 'discord-oauth.js'];
const HTML_FILES = ['public/index.html', 'public/writer.html', 'public/hub.html', 'public/acesso.html', 'public/public-client.html'];

const HOLE = '\u0001';
const MAXV = 48;
const TEXT_ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tip', 'data-tooltip', 'data-title', 'data-label', 'data-placeholder', 'data-empty', 'label', 'data-confirm'];

const catalog = new Map(); // key -> { k, pat, n, src:Set }
const dropped = new Map();
function addDropped(key, src) { if (!dropped.has(key)) dropped.set(key, new Set()); if (dropped.get(key).size < 30) dropped.get(key).add(src); }
function add(key, src) {
  if (!key) return;
  let e = catalog.get(key);
  if (!e) { e = { k: key, pat: /\{\d+\}/.test(key), n: 0, src: new Set() }; catalog.set(key, e); }
  e.n++;
  if (e.src.size < 4) e.src.add(src);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', rarr: '→', larr: '←', times: '×', bull: '•', copy: '©' };
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === '#') { const c = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return String.fromCodePoint(c); }
    return ENT[g.toLowerCase()] !== undefined ? ENT[g.toLowerCase()] : m;
  });
}
const norm = (s) => s.replace(/[\s\u00a0]+/g, ' ').trim();

// Tem cara de texto de interface?
const PT_WORDS = new Set(('de da do das dos para por com sem não nao uma um que em no na nos nas ao aos à às você voce seu sua seus suas este esta isso essa esse ' +
  'mais menos já ja ainda agora hoje ontem amanhã amanha semana mês mes ano dia dias horas hora minutos todos todas nenhum nenhuma ' +
  'é e ou se quando onde como qual quem aqui ali pelo pela pelos pelas até ate foi ser está estao estão tem têm vai').split(' '));
function looksText(s, htmlCtx) {
  if (!/[A-Za-zÀ-ÿ]/.test(s)) return false;
  const plain = s.replace(/\{\d+\}/g, '').trim();
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(plain)) return false;
  if (/^(https?:|\/|\.\/|#|mailto:|data:|javascript:)/i.test(plain) && !/\s/.test(plain)) return false;
  if (/[{};]\s*$/.test(plain) && /:/.test(plain) && !htmlCtx) return false; // css
  if (/^[\w.-]+\.(js|css|png|svg|jpg|json|html|woff2?)$/i.test(plain)) return false;
  const accent = /[À-ÿ]/.test(plain);
  if (accent) return true;
  const words = plain.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  if (words.some(w => PT_WORDS.has(w)) && /\s/.test(plain)) return true;
  if (htmlCtx) return /[A-Za-z]{2,}/.test(plain) && !/^[a-z0-9_-]+$/.test(plain) || /^[a-zà-ÿ]{3,}$/.test(plain);
  // literal solto: exige cara de frase (Maiúscula inicial ou espaços)
  if (/^[A-ZÀ-Ý][a-zà-ÿ]+(\s|$|[,:;.!?])/.test(plain)) return true;
  if (/\{\d+\}/.test(s) && words.some(w => PT_WORDS.has(w))) return true;
  if (/\s/.test(plain) && /^[a-zà-ÿ]/.test(plain) && words.length >= 2 && !/[_=<>\[\]()]/.test(plain)) return true;
  return false;
}

// Separa um "variant" serializado (texto com HOLE) em segmentos de texto.
function segmentsOf(serial, htmlish) {
  const out = [];
  if (!htmlish) { out.push({ s: serial, html: false }); return out; }
  const re = /<\/?[a-zA-Z!][^<>]*>/g;
  let last = 0, m;
  while ((m = re.exec(serial))) {
    out.push({ s: serial.slice(last, m.index), html: true });
    const tag = m[0];
    const ar = new RegExp('\\s(' + TEXT_ATTRS.join('|') + ')\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'gi');
    let a;
    while ((a = ar.exec(tag))) out.push({ s: a[3] !== undefined ? a[3] : a[4], html: true, attr: true });
    last = m.index + tag.length;
  }
  out.push({ s: serial.slice(last), html: true });
  return out;
}
function emitSerial(serial, src, forceHtml) {
  const htmlish = forceHtml || /<\/?[a-zA-Z][^<>]*>/.test(serial) || /&[a-z]+;/.test(serial);
  for (const seg of segmentsOf(serial, htmlish)) {
    let s = seg.html ? decode(seg.s) : seg.s;
    s = norm(s);
    if (!s || s === HOLE) continue;
    // Tira holes das pontas (ícones, etc.) — registra as duas formas
    const forms = new Set([s]);
    const stripped = norm(s.replace(new RegExp('^(' + HOLE + '\\s*)+'), '').replace(new RegExp('(\\s*' + HOLE + ')+$'), ''));
    if (stripped) forms.add(stripped);
    for (const f of forms) {
      let i = 0;
      const key = f.replace(new RegExp(HOLE, 'g'), () => `{${i++}}`);
      // Padrões genéricos demais (pouco texto fixo) são descartados.
      if (/\{\d+\}/.test(key)) {
        const lit = key.replace(/\{\d+\}/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '');
        if (lit.length < 3) { if (lit.length && /^(de|da|do|às|as|em|e|à|a|o|no|na|se|h|ou|por)$/i.test(lit) || /[À-ÿ]/.test(lit)) addDropped(key, src); continue; }
      }
      if (!looksText(key, seg.html)) continue;
      add(key, src);
    }
  }
}

/* ── JS ── */
function lit(s) { return [[{ l: s }]]; }
const holeV = () => [[{ h: 1 }]];
function concat(a, b) {
  const out = [];
  for (const x of a) for (const y of b) out.push(x.concat(y));
  return out;
}
function isStringy(node) {
  if (!node) return false;
  switch (node.type) {
    case 'Literal': return typeof node.value === 'string';
    case 'TemplateLiteral': return true;
    case 'BinaryExpression': return node.operator === '+' && (isStringy(node.left) || isStringy(node.right));
    case 'ConditionalExpression': return isStringy(node.consequent) || isStringy(node.alternate);
    case 'LogicalExpression': return isStringy(node.right) || isStringy(node.left);
    default: return false;
  }
}
let pendingRoots = [];
function variants(node) {
  if (!node) return holeV();
  switch (node.type) {
    case 'Literal': return typeof node.value === 'string' ? lit(node.value) : holeV();
    case 'TemplateLiteral': {
      let acc = [[]];
      node.quasis.forEach((q, i) => {
        acc = concat(acc, lit(q.value.cooked == null ? q.value.raw : q.value.cooked));
        if (i < node.expressions.length) {
          let v = isStringy(node.expressions[i]) ? variants(node.expressions[i]) : holeV();
          if (acc.length * v.length > MAXV) { pendingRoots.push(node.expressions[i]); v = holeV(); }
          acc = concat(acc, v);
        }
      });
      return acc;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+' || !isStringy(node)) return holeV();
      const a = variants(node.left);
      let b = variants(node.right);
      if (a.length * b.length > MAXV) { pendingRoots.push(node.right); b = holeV(); }
      return concat(a, b);
    }
    case 'ConditionalExpression': {
      if (!isStringy(node)) return holeV();
      const r = variants(node.consequent).concat(variants(node.alternate));
      if (r.length > MAXV) { pendingRoots.push(node.consequent, node.alternate); return holeV(); }
      return r;
    }
    case 'LogicalExpression': {
      if (!isStringy(node)) return holeV();
      if (node.operator === '&&') return lit('').concat(variants(node.right));
      return variants(node.left).concat(variants(node.right));
    }
    default: return holeV();
  }
}
function serialize(seq) { return seq.map(p => (p.h ? HOLE : p.l)).join(''); }

const SKIP_CALLEE = /^(console\.\w+|require|querySelector|querySelectorAll|getElementById|addEventListener|removeEventListener|getItem|setItem|removeItem|getAttribute|setAttribute|removeAttribute|hasAttribute|toggleAttribute|closest|matches|add|remove|toggle|contains|createElement|RegExp|dispatchEvent|Event|CustomEvent|fetch|api|apiFetch|postMessage|getPropertyValue|setProperty|markDirty|saveEntity|removeEntity|log|warn|debug|startsWith|endsWith|includes|split|indexOf|replace|replaceAll|padStart|localeCompare|set|get|has|delete|on|emit|toLocaleDateString|toLocaleTimeString|toLocaleString|Intl\.\w+|audit)$/;
function calleeName(c) {
  if (!c) return '';
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression') {
    const o = c.object.type === 'Identifier' ? c.object.name + '.' : '';
    const p = c.property.name || (c.property.value || '');
    return (o && /^console$|^Intl$/.test(c.object.name) ? o : '') + p;
  }
  return '';
}
function processJs(code, file, lineOffset = 0) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true }); }
  catch (e) {
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
    catch (e2) { console.error('parse fail', file, e2.message); return; }
  }
  const roots = [];
  walk.fullAncestor(ast, (node, _st, ancestors) => {
    if (!isStringy(node) || (node.type !== 'Literal' && node.type !== 'TemplateLiteral' && node.type !== 'BinaryExpression' && node.type !== 'ConditionalExpression' && node.type !== 'LogicalExpression')) return;
    // É raiz? (o pai não é um combinador de string)
    const parent = ancestors[ancestors.length - 2];
    if (parent) {
      if (parent.type === 'TemplateLiteral') return;
      if (parent.type === 'BinaryExpression' && parent.operator === '+' && isStringy(parent)) return;
      if (parent.type === 'ConditionalExpression' && parent.test !== node && isStringy(parent)) return;
      if (parent.type === 'LogicalExpression' && isStringy(parent)) return;
      // contextos de código
      if (parent.type === 'BinaryExpression' && /^(===|!==|==|!=|in|instanceof)$/.test(parent.operator)) return;
      if (parent.type === 'SwitchCase' && parent.test === node) return;
      if (parent.type === 'Property' && parent.key === node) return;
      if (parent.type === 'MemberExpression' && parent.property === node) return;
      if (parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration') return;
      if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
        const cn = calleeName(parent.callee);
        if (SKIP_CALLEE.test(cn) && parent.arguments[0] === node) return;
        if (/^console\./.test(cn)) return;
      }
      if (parent.type === 'TaggedTemplateExpression') return;
    }
    // Dentro de console.*(...) em qualquer nível
    for (const a of ancestors) if (a.type === 'CallExpression' && /^console\./.test(calleeName(a.callee))) return;
    roots.push(node);
  });
  const seen = new Set();
  const handle = (node) => {
    if (seen.has(node)) return; seen.add(node);
    pendingRoots = [];
    const vs = variants(node);
    const src = `${file}:${(node.loc ? node.loc.start.line : 0) + lineOffset}`;
    for (const seq of vs) emitSerial(serialize(seq), src, false);
    const more = pendingRoots; pendingRoots = [];
    for (const n of more) if (isStringy(n)) handle(n);
  };
  for (const r of roots) handle(r);
}

/* ── HTML ── */
function processHtml(html, file) {
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
  const visit = (node) => {
    if (node.nodeName === 'script') {
      const txt = (node.childNodes || []).map(c => c.value || '').join('');
      const type = (node.attrs || []).find(a => a.name === 'type');
      if (txt.trim() && (!type || /javascript|module/.test(type.value))) processJs(txt, file, (node.sourceCodeLocation ? node.sourceCodeLocation.startLine - 1 : 0));
      return;
    }
    if (node.nodeName === 'style') return;
    if (node.attrs) for (const a of node.attrs) {
      if (TEXT_ATTRS.includes(a.name) || (a.name === 'value' && node.nodeName === 'input' && (node.attrs.find(x => x.name === 'type') || {}).value !== 'hidden')) {
        const s = norm(a.value);
        if (looksText(s, true)) add(s, `${file}:${node.sourceCodeLocation ? node.sourceCodeLocation.startLine : 0}`);
      }
      if (a.name === 'content' && node.nodeName === 'meta') {
        const nm = (node.attrs.find(x => x.name === 'name' || x.name === 'property') || {}).value || '';
        if (/description|title/.test(nm)) { const s = norm(a.value); if (looksText(s, true)) add(s, `${file}:meta`); }
      }
      // handlers inline: onclick="..." com strings
      if (/^on[a-z]+$/.test(a.name) && /['"`]/.test(a.value)) processJs(a.value, file, node.sourceCodeLocation ? node.sourceCodeLocation.startLine - 1 : 0);
    }
    if (node.nodeName === '#text') {
      const s = norm(node.value);
      if (looksText(s, true)) add(s, `${file}:${node.sourceCodeLocation ? node.sourceCodeLocation.startLine : 0}`);
    }
    if (node.nodeName === 'title') {
      const s = norm((node.childNodes || []).map(c => c.value || '').join(''));
      if (looksText(s, true)) add(s, `${file}:title`);
      return;
    }
    const kids = node.content ? node.content.childNodes : node.childNodes;
    if (kids) for (const c of kids) visit(c);
  };
  visit(doc);
}

for (const f of JS_FILES) processJs(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
for (const f of HTML_FILES) processHtml(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);

const dict = require(path.join(ROOT, 'public/i18n/en.js'));
const missing = [...catalog.values()].filter(e => !dict[e.k]).map(e => ({ k: e.k, src: [...e.src] }));
if (process.argv.includes('--json')) console.log(JSON.stringify(missing, null, 1));
else {
  for (const e of missing) console.log(`${e.src[0]}	${e.k}`);
  console.error(`
${missing.length} de ${catalog.size} frases sem tradução em public/i18n/en.js`);
}
