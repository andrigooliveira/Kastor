/* ───────────────────────────────────────────────────────────────
   reWork — Verificador do design system (catraca de tokens)

   Conta, por arquivo, todo valor que foge das escalas do DESIGN.md
   (cor, tamanho/peso de fonte, raio, sombra, espaço, !important) e compara
   com tests/design-tokens.baseline.json. A contagem só pode cair:
   tests/design-tokens.test.js falha se qualquer valor aparecer mais vezes
   que no baseline.

   Uso:
     node scripts/design-tokens.js            resumo por arquivo e regra
     node scripts/design-tokens.js --top 15   + os valores mais frequentes
     node scripts/design-tokens.js --update   grava o baseline (recusa se piorou)
     node scripts/design-tokens.js --update --allow-increase   grava mesmo piorando
   ─────────────────────────────────────────────────────────────── */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'tests', 'design-tokens.baseline.json');

// CSS: análise por declaração. Script/HTML: só o que dá pra achar sem parser.
const CSS_FILES = [
  'public/css/style.css',
  'public/css/console.css',
  'public/css/docs-editor.css',
  'public/css/legal.css'
];
const LOOSE_FILES = [
  'public/js/app.js',
  'public/js/console.js',
  'public/js/boot.js',
  'public/index.html'
];

// Escalas (espelham os tokens do :root em style.css)
const SPACE_SCALE = new Set([0, 1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]);
const WEIGHTS = new Set(['400', '500', '600', '700', 'normal', 'bold', 'inherit']);
const RULES = ['color', 'font-size', 'font-weight', 'radius', 'shadow', 'spacing', 'important'];

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// Troca o miolo de (…)/comentários por espaços sem mexer nas quebras de linha,
// pra o índice continuar apontando pra linha certa.
const blank = (s) => s.replace(/[^\n]/g, ' ');

// Remove var(…) balanceado (inclusive o fallback) — o que sobra é literal.
function stripVars(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v.startsWith('var(', i)) {
      let depth = 0, j = i + 3;
      for (; j < v.length; j++) {
        if (v[j] === '(') depth++;
        else if (v[j] === ')' && --depth === 0) break;
      }
      out += ' ';
      i = j;
    } else out += v[i];
  }
  return out;
}

// Literais de cor num valor: hex, rgb/hsl sem var() dentro, white/black.
// Fallback de var(--x, #fff) conta: é código morto que esconde a cor real.
function colorLiterals(v) {
  const found = [];
  for (const m of v.matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push(m[0].toLowerCase());
  for (const m of v.matchAll(/\b(rgba?|hsla?)\(/gi)) {
    let depth = 0, j = m.index + m[1].length;
    for (; j < v.length; j++) {
      if (v[j] === '(') depth++;
      else if (v[j] === ')' && --depth === 0) break;
    }
    const fn = v.slice(m.index, j + 1);
    if (!/\(\s*var\(/.test(fn)) found.push(norm(fn).replace(/\s/g, ''));
  }
  for (const m of stripVars(v).matchAll(/(^|[\s,(])(white|black)\b/gi)) found.push(m[2].toLowerCase());
  return found;
}

const pxValues = (v) => [...stripVars(v).matchAll(/(-?\d*\.?\d+)(px|rem)\b/g)]
  .map((m) => ({ raw: m[0].replace('-', ''), px: Math.abs(parseFloat(m[1])) * (m[2] === 'rem' ? 16 : 1) }));

function checkDecl(prop, value, hit) {
  if (prop.startsWith('--')) return;            // definição de token
  const important = /!important/i.test(value);
  const v = value.replace(/!important/i, '').trim();
  if (important) hit('important', prop);

  for (const c of colorLiterals(v)) hit('color', c);

  if (prop === 'font-size' || prop === 'font') {
    const sizes = pxValues(prop === 'font' ? v.split('/')[0] : v);
    for (const s of sizes) hit('font-size', s.raw);
  }
  if (prop === 'font-weight' && !WEIGHTS.has(norm(stripVars(v)) || 'inherit')) hit('font-weight', norm(v));

  if (/^border(-[a-z]+)*-radius$/.test(prop)) {
    for (const s of pxValues(v)) if (s.px !== 0) hit('radius', s.raw);
  }
  if (prop === 'box-shadow') {
    const rest = stripVars(v).replace(/\b(none|inherit|initial|unset)\b|,/g, '').trim();
    if (rest) hit('shadow', norm(v).slice(0, 80));
  }
  if (/^(padding|margin)(-[a-z-]+)?$|^(row-|column-)?gap$/.test(prop)) {
    for (const s of pxValues(v)) if (!SPACE_SCALE.has(s.px)) hit('spacing', s.raw);
  }
}

function scanCss(text) {
  // comentários e url(…) (data URIs têm ';' e '#') viram espaço
  const src = text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, (m) => 'url(' + blank(m.slice(4, -1)) + ')');
  const lineAt = lineIndex(src);
  const out = [];
  // Segmento entre delimitadores; se termina em '{' é seletor/at-rule.
  const re = /[^{};]+(?=[{};])/g;
  let m;
  while ((m = re.exec(src))) {
    if (src[re.lastIndex] === '{') continue;
    const seg = m[0];
    const colon = seg.indexOf(':');
    if (colon < 0) continue;
    const prop = seg.slice(0, colon).trim().toLowerCase();
    if (!/^-?-?[a-z][a-z0-9-]*$/.test(prop)) continue;
    const line = lineAt(m.index + seg.search(/\S/));
    checkDecl(prop, seg.slice(colon + 1), (rule, key) => out.push({ rule, key, line }));
  }
  return out;
}

// JS/HTML: cor hex de 6/8 dígitos (3 dígitos confunde com âncora/id),
// rgb() literal e font-size em px/rem dentro de string de estilo.
function scanLoose(text) {
  const lineAt = lineIndex(text);
  const out = [];
  for (const m of text.matchAll(/#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g)) {
    out.push({ rule: 'color', key: m[0].toLowerCase(), line: lineAt(m.index) });
  }
  for (const m of text.matchAll(/\brgba?\((?!\s*var\()[^)]*\)/g)) {
    out.push({ rule: 'color', key: m[0].replace(/\s/g, '').toLowerCase(), line: lineAt(m.index) });
  }
  for (const m of text.matchAll(/font-size\s*:\s*(\d*\.?\d+(?:px|rem))/g)) {
    out.push({ rule: 'font-size', key: m[1], line: lineAt(m.index) });
  }
  return out;
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

// { arquivo: { regra: { valor: { count, lines[] } } } }
function scan() {
  const result = {};
  const files = [...CSS_FILES.map((f) => [f, scanCss]), ...LOOSE_FILES.map((f) => [f, scanLoose])];
  for (const [file, fn] of files) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const byRule = (result[file] = {});
    for (const { rule, key, line } of fn(fs.readFileSync(abs, 'utf8'))) {
      const e = ((byRule[rule] ||= {})[key] ||= { count: 0, lines: [] });
      e.count++;
      e.lines.push(line);
    }
  }
  return result;
}

const toCounts = (res) => {
  const out = {};
  for (const file of Object.keys(res).sort()) {
    out[file] = {};
    for (const rule of RULES) {
      if (!res[file][rule]) continue;
      out[file][rule] = Object.fromEntries(Object.entries(res[file][rule])
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([k, e]) => [k, e.count]));
    }
  }
  return out;
};

const loadBaseline = () => (fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files : {});

// Compara com o baseline. worse: valor que cresceu; better: valor que caiu.
function compare(res = scan(), base = loadBaseline()) {
  const worse = [], better = [];
  const files = new Set([...Object.keys(res), ...Object.keys(base)]);
  for (const file of files) {
    for (const rule of RULES) {
      const cur = res[file]?.[rule] || {};
      const old = base[file]?.[rule] || {};
      for (const key of new Set([...Object.keys(cur), ...Object.keys(old)])) {
        const now = cur[key]?.count || 0, was = old[key] || 0;
        if (now > was) worse.push({ file, rule, key, was, now, lines: cur[key].lines });
        else if (now < was) better.push({ file, rule, key, was, now });
      }
    }
  }
  return { worse, better };
}

const total = (byRule) => Object.values(byRule || {}).reduce((a, e) => a + (typeof e === 'number' ? e : e.count), 0);

function main(argv) {
  const res = scan();
  if (argv.includes('--update')) {
    const { worse } = compare(res);
    if (worse.length && fs.existsSync(BASELINE) && !argv.includes('--allow-increase')) {
      console.error(`Baseline não gravado: ${worse.length} valor(es) pioraram. Rode o teste pra ver onde, ou use --allow-increase.`);
      process.exit(1);
    }
    const body = { version: 1, note: 'Gerado por scripts/design-tokens.js --update. Só pode diminuir.', files: toCounts(res) };
    fs.writeFileSync(BASELINE, JSON.stringify(body, null, 2) + '\n');
    console.log(`Baseline gravado em ${path.relative(ROOT, BASELINE)}`);
    return;
  }
  const topIdx = argv.indexOf('--top');
  const top = topIdx >= 0 ? parseInt(argv[topIdx + 1], 10) || 10 : 0;
  const base = loadBaseline();
  let grand = 0;
  for (const file of Object.keys(res)) {
    console.log(`\n${file}`);
    for (const rule of RULES) {
      const n = total(res[file][rule]);
      if (!n) continue;
      grand += n;
      const was = total(base[file]?.[rule]);
      const delta = Object.keys(base).length ? `  (baseline ${was})` : '';
      const distinct = Object.keys(res[file][rule]).length;
      console.log(`  ${rule.padEnd(12)} ${String(n).padStart(5)}  ${String(distinct).padStart(4)} valores${delta}`);
      if (top) {
        Object.entries(res[file][rule]).sort((a, b) => b[1].count - a[1].count).slice(0, top)
          .forEach(([k, e]) => console.log(`      ${String(e.count).padStart(4)}  ${k}`));
      }
    }
  }
  console.log(`\nTotal fora do sistema: ${grand}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { scan, compare, scanCss, scanLoose, BASELINE };
