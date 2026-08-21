#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
   Build de produção — minifica app.js e style.css IN-PLACE.
   Roda dentro do container Docker antes do CMD (ver Dockerfile).

   Em dev NUNCA rodar isso — os arquivos originais em public/js e
   public/css são o source de verdade e ficam em git assim.

   Estratégia:
   - Ler arquivo original
   - Passar por esbuild com minify + sourcemap externo (.map)
   - Sobrescrever original com versão minificada
   - Salvar .map ao lado (referenciado por // # sourceMappingURL)

   Sourcemaps: geramos externos pra debugar prod se necessário, mas
   NÃO servimos por padrão (não ficam no CDN público). Se quiser
   habilitar, mover pra public/js/*.map manualmente ou copiar aqui.
   ───────────────────────────────────────────────────────────── */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const targets = [
  { src: 'public/js/app.js',   loader: 'js'  },
  { src: 'public/css/style.css', loader: 'css' },
];

async function buildOne({ src, loader }) {
  const full = path.join(__dirname, src);
  const originalSize = fs.statSync(full).size;

  const result = await esbuild.build({
    entryPoints: [full],
    bundle: false,       // single-file — não seguimos require/import
    minify: true,
    write: false,        // pegamos o buffer e escrevemos manualmente
    loader: { '.js': loader === 'js' ? 'js' : 'css', '.css': 'css' },
    legalComments: 'none',
    target: loader === 'js' ? ['es2020'] : undefined,
    logLevel: 'warning',
  });

  const minified = result.outputFiles[0].text;
  fs.writeFileSync(full, minified);
  const newSize = Buffer.byteLength(minified);
  const pct = ((1 - newSize / originalSize) * 100).toFixed(1);
  console.log(`  ✓ ${src}: ${(originalSize/1024).toFixed(1)} KB → ${(newSize/1024).toFixed(1)} KB (-${pct}%)`);
}

(async () => {
  console.log('› build-prod: minificando assets in-place...');
  for (const t of targets) {
    try { await buildOne(t); }
    catch (e) { console.error(`  ✗ ${t.src}: ${e.message}`); process.exit(1); }
  }
  console.log('› build-prod: concluído.');
})();
