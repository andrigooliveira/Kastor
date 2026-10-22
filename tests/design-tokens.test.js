/* ───────────────────────────────────────────────────────────────
   reWork — Catraca do design system, sem banco
   Roda com: npm test (ou node --test tests/design-tokens.test.js)

   Valor fora das escalas do DESIGN.md (cor, fonte, raio, sombra, espaço,
   !important) só pode diminuir. O baseline guarda quantas vezes cada valor
   aparece em cada arquivo; aparecer mais vezes, ou um valor novo, falha.
   Melhorou? `node scripts/design-tokens.js --update` aperta o baseline.
   ─────────────────────────────────────────────────────────────── */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scan, compare, scanCss, BASELINE } = require('../scripts/design-tokens');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

test('nenhum valor fora do sistema aumentou', () => {
  assert.ok(fs.existsSync(BASELINE), `falta ${rel(BASELINE)} — rode node scripts/design-tokens.js --update`);
  const { worse } = compare(scan());
  const msg = worse.map((w) => {
    const lines = w.lines.slice(0, 8).join(', ') + (w.lines.length > 8 ? '…' : '');
    return `  ${w.file} · ${w.rule} · ${w.key}: ${w.was} → ${w.now} (linhas ${lines})`;
  }).join('\n');
  assert.equal(worse.length, 0,
    `Valores fora das escalas do DESIGN.md aumentaram:\n${msg}\n` +
    'Use o token (var(--fs-*), var(--space-*), var(--radius-*), var(--shadow-*), cor semântica).');
});

test('baseline está apertado (melhoria registrada)', () => {
  const { better } = compare(scan());
  const msg = better.slice(0, 20).map((b) => `  ${b.file} · ${b.rule} · ${b.key}: ${b.was} → ${b.now}`).join('\n');
  assert.equal(better.length, 0,
    `Valores fora do sistema diminuíram — boa! Registre com:\n  node scripts/design-tokens.js --update\n${msg}`);
});

// O catálogo (/api/admin/design-system) monta os componentes com funções
// recortadas do app.js. Renomear uma delas quebraria a página em silêncio.
test('catálogo acha as funções do app.js, inclusive minificado', () => {
  const { catalogHelpers } = require('../design-catalog');
  const esbuild = require('esbuild');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const prod = esbuild.transformSync(src, { loader: 'js', minify: true, target: 'es2020' }).code;
  for (const [label, js] of [['app.js', src], ['app.js minificado', prod]]) {
    const { code, missing } = catalogHelpers(js);
    assert.deepEqual(missing, [], `${label}: não achei ${missing.join(', ')} — atualize CATALOG_HELPERS em design-catalog.js`);
    assert.doesNotThrow(() => new Function(code), `${label}: o recorte não compila`);
  }
  const html = fs.readFileSync(path.join(ROOT, 'design-system.html'), 'utf8');
  for (const mark of ['/*__APP_HELPERS__*/', '"__MISSING_HELPERS__"', '__TS__']) assert.ok(html.includes(mark), `design-system.html sem ${mark}`);
});

test('o verificador reconhece token e literal', () => {
  const css = [
    '.a:hover { color: var(--text); padding: 8px var(--space-3); border-radius: var(--radius-sm); }',
    '.b { color: #fff; font-size: 12.5px; padding: 14px; border-radius: 8px; }',
    '.c { box-shadow: var(--shadow-md), var(--ring-active); font-weight: 650; width: 1px !important; }',
    '.d { --x: #123456; background: rgba(var(--accent-rgb), .1); color: var(--danger, #ef4444); }',
    '/* .e { color: #000; } */ .f { background: url("data:image/svg+xml;utf8,<svg fill=\'%23fff\'/>"); }',
    '@media (max-width: 640px) { .g { font-size: var(--fs-sm); margin: -4px 0; } }'
  ].join('\n');
  const hits = scanCss(css).map((h) => `${h.line}:${h.rule}:${h.key}`).sort();
  assert.deepEqual(hits, [
    '2:color:#fff', '2:font-size:12.5px', '2:radius:8px', '2:spacing:14px',
    '3:font-weight:650', '3:important:width',
    '4:color:#ef4444'
  ].sort());
});
