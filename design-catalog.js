/* ───────────────────────────────────────────────────────────────
   reWork — Catálogo do design system (design-system.html)

   Servido (só admin) em /api/admin/design-system. A página carrega o
   style.css REAL e monta os componentes com as funções REAIS do app.js
   (emptyState, kpiTiles, avatarHTML, toast…), recortadas pelo nome a cada
   request — funciona também no app.js minificado de produção, que mantém os
   nomes globais. Se uma função mudar de nome, tests/design-tokens.test.js
   acusa antes da página quebrar.
   ─────────────────────────────────────────────────────────────── */
const fs = require('node:fs');
const path = require('node:path');

// Ordem importa: cada uma só usa as que vêm antes.
const CATALOG_HELPERS = [
  'esc', 'hexDim', 'PRIORITIES', 'priorityPill',
  'STATUS_META', 'statusOf', 'presenceClassFor',
  'AVATAR_GRADIENTS', '_avatarGradientCache', 'avatarGradient', 'avatarHTML',
  'EMPTY_ICONS', 'emptyState', 'emptyMini', 'kpiTiles', 'skeletonMetrics',
  'TOAST_ICONS', 'toast', 'dismissToast', 'paintIcons'
];

// Pula string, template (com ${…} aninhado), comentário e regex a partir de
// js[i]; devolve o índice do último caractere consumido, ou -1 se não é nenhum.
function skipLiteral(js, i, prevSig) {
  const c = js[i], n = js[i + 1];
  if (c === '/' && n === '/') { const e = js.indexOf('\n', i); return e < 0 ? js.length - 1 : e; }
  if (c === '/' && n === '*') { const e = js.indexOf('*/', i + 2); return e < 0 ? js.length - 1 : e + 1; }
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < js.length; j++) {
      if (js[j] === '\\') j++;
      else if (js[j] === c || js[j] === '\n') return j;
    }
    return js.length - 1;
  }
  if (c === '`') {
    for (let j = i + 1; j < js.length; j++) {
      if (js[j] === '\\') j++;
      else if (js[j] === '`') return j;
      else if (js[j] === '$' && js[j + 1] === '{') j = matchClose(js, j + 1);
    }
    return js.length - 1;
  }
  // Regex: '/' onde não cabe divisão (depois de operador ou abertura).
  if (c === '/' && (!prevSig || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig))) {
    let cls = false;
    for (let j = i + 1; j < js.length; j++) {
      if (js[j] === '\\') j++;
      else if (js[j] === '[') cls = true;
      else if (js[j] === ']') cls = false;
      else if (js[j] === '/' && !cls) return j;
      else if (js[j] === '\n') return -1;
    }
  }
  return -1;
}

// js[open] é '(' '[' ou '{'; devolve o índice do fechamento correspondente.
function matchClose(js, open) {
  let depth = 0, prev = '';
  for (let i = open; i < js.length; i++) {
    const end = skipLiteral(js, i, prev);
    if (end >= 0) { i = end; prev = 'x'; continue; }
    const c = js[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

// Fim do inicializador que começa em `from`: ',' ou ';' fora de qualquer par.
function initEnd(js, from) {
  let prev = '=';
  for (let i = from; i < js.length; i++) {
    const end = skipLiteral(js, i, prev);
    if (end >= 0) { i = end; prev = 'x'; continue; }
    const c = js[i];
    if ('([{'.includes(c)) { i = matchClose(js, i); if (i < 0) return -1; prev = ')'; continue; }
    if (c === ';' || c === ',' || c === '}') return i;
    if (!/\s/.test(c)) prev = c;
  }
  return js.length;
}

// Minificado: o esbuild junta as declarações (`const a=1,esc=s=>…,b=[…];`).
// Percorre o topo do arquivo e acha `nome=` dentro de uma lista const/let/var.
function extractFromDeclList(js, name) {
  const decl = new RegExp(`^\\s*${name.replace(/\$/g, '\\$')}\\s*=(?!=)`);
  let depth = 0, prev = '', inDecl = false;
  for (let i = 0; i < js.length; i++) {
    const end = skipLiteral(js, i, prev);
    if (end >= 0) { i = end; prev = 'x'; continue; }
    const c = js[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0) {
      let at = -1;
      if (c === ';') inDecl = false;
      else if (c === ',' && inDecl) at = i + 1;
      else if (/[clv]/.test(c) && !/[\w$]/.test(js[i - 1] || '')) {
        const kw = /^(const|let|var)\s/.exec(js.slice(i, i + 6));
        if (kw) { inDecl = true; at = i + kw[1].length; }
      }
      if (at >= 0) {
        const m = decl.exec(js.slice(at, at + name.length + 8));
        if (m) {
          const from = at + m[0].length, stop = initEnd(js, from);
          return stop < 0 ? null : `const ${name} = ${js.slice(from, stop).trim()};`;
        }
      }
    }
    if (!/\s/.test(c)) prev = c;
  }
  return null;
}

// Recorta a declaração de topo `function nome(…){…}` ou `const nome = …;`.
function extractDecl(js, name) {
  const re = new RegExp(`(^|[;}\\n])\\s*(function ${name}\\s*\\(|const ${name}\\s*=)`);
  const m = re.exec(js);
  if (!m) return extractFromDeclList(js, name);
  const start = m.index + m[1].length + (m[0].length - m[1].length - m[2].length);
  if (m[2].startsWith('function')) {
    const parenEnd = matchClose(js, js.indexOf('(', start));
    const body = js.indexOf('{', parenEnd);
    const end = matchClose(js, body);
    return end < 0 ? null : js.slice(start, end + 1);
  }
  // const: até o ';' (ou quebra de linha sem continuação) fora de qualquer par.
  let prev = '=';
  for (let i = start + m[2].length; i < js.length; i++) {
    const end = skipLiteral(js, i, prev);
    if (end >= 0) { i = end; prev = 'x'; continue; }
    const c = js[i];
    if ('([{'.includes(c)) { i = matchClose(js, i); if (i < 0) return null; prev = ')'; continue; }
    if (c === ';' || c === ',') return js.slice(start, i).trim() + ';';
    if (c === '\n' && /[\w)\]}'"`]/.test(prev) && !/^\s*[.?:+\-*/&|=]/.test(js.slice(i + 1, i + 40))) {
      return js.slice(start, i).trim() + ';';
    }
    if (!/\s/.test(c)) prev = c;
  }
  return null;
}

function catalogHelpers(js) {
  const out = [], missing = [];
  for (const name of CATALOG_HELPERS) {
    const code = extractDecl(js, name);
    if (code) out.push(code); else missing.push(name);
  }
  return { code: out.join('\n'), missing };
}

module.exports = function designCatalog(app, { requireAuth }) {
  app.get('/api/admin/design-system', requireAuth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).send('Apenas administradores.');
    fs.readFile(path.join(__dirname, 'design-system.html'), 'utf8', (err, html) => {
      if (err) return res.status(500).type('text/plain').send(err.message);
      let helpers = { code: '', missing: CATALOG_HELPERS };
      try { helpers = catalogHelpers(fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8')); } catch {}
      // </script> dentro do código recortado fecharia a tag antes da hora.
      const code = helpers.code.replace(/<\/script/gi, '<\\/script');
      res.set('Cache-Control', 'no-store').type('html').send(html
        .replace('__TS__', Date.now())
        .replace('/*__APP_HELPERS__*/', () => code)
        .replace('"__MISSING_HELPERS__"', () => JSON.stringify(helpers.missing)));
    });
  });

  // DESIGN.md sem o frontmatter (os tokens em YAML), pra tela Dev Tools.
  app.get('/api/admin/design-doc', requireAuth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Apenas administradores.' });
    fs.readFile(path.join(__dirname, 'DESIGN.md'), 'utf8', (err, md) => {
      if (err) return res.status(500).json({ error: err.message });
      const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      res.set('Cache-Control', 'no-store').json({ markdown: body });
    });
  });
};
module.exports.extractDecl = extractDecl;
module.exports.catalogHelpers = catalogHelpers;
module.exports.CATALOG_HELPERS = CATALOG_HELPERS;
