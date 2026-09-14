#!/usr/bin/env node
/* ═════════════════════════════════════════════════════════════════
   build-writer.js — bundla o editor Kastor Docs (Tiptap + deps)
                     em public/vendor/writer.bundle.js
   ─────────────────────────────────────────────
   Roda em dev quando eu quero regerar o bundle após mexer em
   public/js/writer/*. Em prod, é chamado ANTES do build-prod.js
   (que só minifica).

   Uso:
     node scripts/build-writer.js         # minified
     node scripts/build-writer.js --dev   # com sourcemap, sem minify

   Por que não usar CDN? A CSP restringe cdnjs a scripts globais,
   e os pacotes do Tiptap são ESM puros — precisam ser bundlados
   pra rodar em <script> comum. Self-hosted é o único caminho.
   ═════════════════════════════════════════════════════════════════ */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const dev = process.argv.includes('--dev');
const outfile = path.join(__dirname, '..', 'public', 'vendor', 'writer.bundle.js');

(async () => {
  const start = Date.now();
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'public', 'js', 'writer', 'index.js')],
    bundle: true,
    outfile,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    target: ['es2020'],
    format: 'iife',        // IIFE porque estamos em <script> tradicional
    globalName: '__KastorWriterBundle',
    logLevel: 'info',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' }
  });
  const size = fs.statSync(outfile).size;
  console.log(`✓ writer.bundle.js: ${(size / 1024).toFixed(1)} KB (${Date.now() - start}ms)${dev ? ' [dev]' : ''}`);
})().catch(e => { console.error('build-writer failed:', e); process.exit(1); });
