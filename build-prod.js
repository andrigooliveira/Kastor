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

/* Reescreve o cache-buster do index.html e o SW_VERSION do sw.js com o SHA
   do commit atual (env BUILD_SHA). Objetivo: cada deploy gera URLs de asset
   novas automaticamente + o SW novo limpa TODOS os caches antigos.
   Sem esse passo, é preciso lembrar de bumpar `?v=` manualmente em cada mudança
   de css/js — errar isso deixa usuário com asset stale por horas. */
function rewriteCacheBusters(buildSha) {
  const version = buildSha || `dev-${Date.now()}`;
  // index.html — todas as ocorrências de ?v=<qualquer coisa> (letras/números/hífen)
  const indexPath = path.join(__dirname, 'public/index.html');
  const idxOrig = fs.readFileSync(indexPath, 'utf8');
  const idxNew  = idxOrig.replace(/\?v=[a-zA-Z0-9._-]+/g, `?v=${version}`);
  if (idxNew !== idxOrig) {
    fs.writeFileSync(indexPath, idxNew);
    console.log(`  ✓ public/index.html: cache-busters → ?v=${version}`);
  } else {
    console.log('  · public/index.html: nenhum cache-buster encontrado');
  }
  // sw.js — const SW_VERSION = '...';
  const swPath = path.join(__dirname, 'public/sw.js');
  const swOrig = fs.readFileSync(swPath, 'utf8');
  const swNew  = swOrig.replace(/const SW_VERSION\s*=\s*['"][^'"]+['"]\s*;/, `const SW_VERSION = '${version}';`);
  if (swNew !== swOrig) {
    fs.writeFileSync(swPath, swNew);
    console.log(`  ✓ public/sw.js: SW_VERSION → '${version}'`);
  } else {
    console.log('  · public/sw.js: SW_VERSION não encontrado (pattern não bateu)');
  }
}

(async () => {
  console.log('› build-prod: minificando assets in-place...');
  const buildSha = (process.env.BUILD_SHA || '').trim();
  if (buildSha) console.log(`  BUILD_SHA=${buildSha}`);
  else console.log('  BUILD_SHA vazio — usando fallback dev-<ts>');
  rewriteCacheBusters(buildSha);
  for (const t of targets) {
    try { await buildOne(t); }
    catch (e) { console.error(`  ✗ ${t.src}: ${e.message}`); process.exit(1); }
  }
  console.log('› build-prod: concluído.');
})();
