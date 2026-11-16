#!/usr/bin/env node
/* ═════════════════════════════════════════════════════════════════
   build-slides.js — bundla o reWork Presentations (Yjs + editor)
                     em public/vendor/slides.bundle.js
   ─────────────────────────────────────────────
   Rodar depois de mexer em public/js/slides/* e trocar o ?v= do
   bundle em public/slides.html. Em produção o Dockerfile roda de novo.

   Uso:
     node scripts/build-slides.js         # minificado
     node scripts/build-slides.js --dev   # com sourcemap, sem minificar
   ═════════════════════════════════════════════════════════════════ */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const dev = process.argv.includes('--dev');
const outfile = path.join(__dirname, '..', 'public', 'vendor', 'slides.bundle.js');

(async () => {
  const start = Date.now();
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'public', 'js', 'slides', 'index.js')],
    bundle: true,
    outfile,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    target: ['es2020'],
    format: 'iife',
    logLevel: 'info',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' }
  });
  const size = fs.statSync(outfile).size;
  console.log(`✓ slides.bundle.js: ${(size / 1024).toFixed(1)} KB (${Date.now() - start}ms)${dev ? ' [dev]' : ''}`);
  // Exportação PowerPoint: bundle à parte, só baixa quando alguém pede o .pptx
  const pptxOut = path.join(__dirname, '..', 'public', 'vendor', 'slides-pptx.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'public', 'js', 'slides', 'pptx.js')],
    bundle: true, outfile: pptxOut, minify: !dev, sourcemap: dev ? 'inline' : false,
    target: ['es2020'], format: 'iife', logLevel: 'warning', legalComments: 'none',
    platform: 'browser',
    // pptxgenjs tem caminhos de Node (fs, https) que o navegador nunca usa
    external: ['fs', 'https', 'http', 'path', 'os', 'image-size', 'node:fs', 'node:https', 'node:path', 'node:os', 'node:fs/promises', 'fs/promises'],
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' }
  });
  console.log(`✓ slides-pptx.bundle.js: ${(fs.statSync(pptxOut).size / 1024).toFixed(1)} KB`);
})().catch(e => { console.error('build-slides failed:', e); process.exit(1); });
