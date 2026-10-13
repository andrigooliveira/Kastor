/* ───────────────────────────────────────────────────────────────
   reWork — Protótipos (prototypes.js), sem banco
   Roda com: npm test (ou node --test tests/prototypes.test.js)

   Sobe o módulo num express vazio, com dependências falsas, e confere o que
   não pode quebrar: o isolamento da prévia (CSP sandbox em toda resposta),
   nada de caminho do usuário no disco, o prazo do link e a troca de token.
   A ligação com o resto do servidor (sessão, plano, armazenamento) fica no
   smoke.test.js.
   ─────────────────────────────────────────────────────────────── */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kastor-proto-'));
const db = { prototypes: [], clients: [{ id: 'c1', orgId: 'org_a', name: 'Cliente' }] };
const state = { trial: false };
const user = { id: 'u1', isFreelancer: false };
let server, base, api;

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  api = require('../prototypes')(app, {
    getDb: () => db, dataDir, saveEntity() {}, removeEntity() {},
    uid: () => crypto.randomBytes(6).toString('hex'), nowISO: () => new Date().toISOString(),
    requireAuth: (req, res, next) => { req.user = user; req.org = { id: 'org_a' }; next(); },
    blockFreelancer: (req, res, next) => next(),
    canAccessWs: (u, ws) => ws === 'ws1',
    sessionUser: (req) => (/sess=1/.test(req.headers.cookie || '') ? user : null),
    tenancy: { run: (orgId, fn) => fn(), orgActive: () => true, orgOf: (type, e) => e.orgId },
    orgPlan: () => ({ trial: state.trial, fileBytes: 25 * 1024 * 1024 }),
    storageLimitError: () => null, fmtBytes: (n) => `${n} B`,
    clientIp: (req) => req.headers['x-ip'] || '10.0.0.1', appBaseUrl: () => 'http://rework.test'
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

async function call(method, p, body, headers) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const csp = (r) => r.headers.get('content-security-policy') || '';
async function upload(id, files) {
  const up = (await call('POST', `/api/prototypes/${id}/upload`, {})).body.uploadId;
  const results = [];
  for (const [p, data] of files) results.push(await call('POST', `/api/prototypes/${id}/upload/${up}/file`, { path: p, data: b64(data) }));
  return { up, results, finish: () => call('POST', `/api/prototypes/${id}/upload/${up}/finish`, {}) };
}

let proto, token, firstVersionDir;

test('Envio: só tipos de site, sem caminho do usuário no disco', async () => {
  assert.equal((await call('POST', '/api/prototypes', { name: 'X', workspaceId: 'outra-equipe' })).status, 400);
  proto = (await call('POST', '/api/prototypes', { name: 'LP de teste', clientId: 'c1', workspaceId: 'ws1' })).body;
  assert.equal(proto.hasFiles, false);
  assert.equal((await call('POST', `/api/prototypes/${proto.id}/link`, { days: 7 })).status, 400, 'sem arquivos não gera link');

  const u = await upload(proto.id, [
    ['index.html', '<h1>oi</h1><script src="js/main.js"></script>'],
    ['css/Style.css', 'body{color:red}'],
    ['js/main.js', 'console.log(1)'],
    ['sobre/index.html', '<h1>sobre</h1>'],
    ['../../etc/passwd.html', 'x'],
    ['.env', 'x'],
    ['virus.exe', 'x'],
    ['a.php', 'x'],
    ['index.html', 'repetido']
  ]);
  assert.deepEqual(u.results.map(r => r.status), [200, 200, 200, 200, 400, 400, 400, 400, 400]);
  const done = await u.finish();
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.entry, 'index.html');
  assert.equal(done.body.fileCount, 4);
  firstVersionDir = path.join(dataDir, 'prototypes', proto.id, u.up);
  assert.deepEqual(fs.readdirSync(firstVersionDir).sort(), ['0', '1', '2', '3'], 'no disco, só nomes numéricos');
  token = done.body.url.split('/p/')[1];
  assert.match(token, /^[a-f0-9]{32}$/);
});

test('Sem link externo: de fora não abre; a equipe vê por chave temporária', async () => {
  assert.equal((await call('GET', `/p/${token}`)).status, 410);
  assert.equal((await call('GET', `/p/${token}/f/index.html`)).status, 410);
  const shell = await call('GET', `/p/${token}`, null, { Cookie: 'sess=1' });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Sem link externo/);
  const src = /<iframe src="([^"]+)"/.exec(shell.text)[1];
  assert.match(src, /\/i\/[0-9a-z]+-[a-f0-9]{32}\/index\.html$/);
  const file = await call('GET', src);
  assert.equal(file.status, 200);
  assert.match(csp(file), /^sandbox allow-scripts/);
  assert.equal((await call('GET', src.replace(/-[a-f0-9]{4}/, '-0000'))).status, 410, 'chave adulterada');
});

test('Link externo: teto de dias, plano de teste fica de fora', async () => {
  state.trial = true;
  const blocked = await call('POST', `/api/prototypes/${proto.id}/link`, { days: 7 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'plan');
  state.trial = false;
  const l = (await call('POST', `/api/prototypes/${proto.id}/link`, { days: 90 })).body;
  const ms = Date.parse(l.link.expiresAt) - Date.now();
  assert.ok(ms > (api.LINK_MAX_DAYS - 0.01) * 864e5 && ms <= api.LINK_MAX_DAYS * 864e5, 'pedir 90 dias dá o máximo');
  assert.equal(l.link.active, true);
});

test('Prévia pública: faixa com o prazo e arquivos sempre isolados', async () => {
  const shell = await call('GET', `/p/${token}`);
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Este link expira <span id="when">dia \d\d\/\d\d às \d\d:\d\d<\/span>/);
  assert.ok(shell.text.includes(`<iframe src="/p/${token}/f/index.html" sandbox="allow-scripts`));
  assert.match(csp(shell), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('x-robots-tag'), 'noindex, nofollow');

  for (const [u, type] of [['index.html', 'text/html'], ['css/Style.css', 'text/css'], ['css/style.css', 'text/css'], ['js/main.js', 'text/javascript'], ['sobre/', 'text/html']]) {
    const r = await call('GET', `/p/${token}/f/${u}`);
    assert.equal(r.status, 200, u);
    assert.ok(r.headers.get('content-type').startsWith(type), u);
    assert.match(csp(r), /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; form-action 'none'; connect-src 'self'/, u);
    assert.ok(!csp(r).includes('allow-same-origin'), u);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', u);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', u);
  }
  // fetch de dentro da prévia com cabeçalho extra: o preflight tem que passar.
  const pre = await call('OPTIONS', `/p/${token}/f/js/main.js`, null, { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-extra' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'x-extra');
  const dir = await call('GET', `/p/${token}/f/sobre`);
  assert.equal(dir.status, 302);
  assert.ok(dir.headers.get('location').endsWith('/f/sobre/'));
  // Nome do arquivo no disco e subida de pasta: nada sai, e o erro também vem isolado.
  for (const bad of ['nao-existe.css', '0', '1', 'css/0', '..%2f..%2f..%2fpackage.json', '..%5c..%5cserver.js']) {
    const r = await call('GET', `/p/${token}/f/${bad}`);
    assert.equal(r.status, 404, bad);
    assert.match(csp(r), /^sandbox/, bad);
  }
  // Vídeo no Safari só toca com Range.
  const part = await fetch(`${base}/p/${token}/f/index.html`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '<h1>');
});

test('Baixar: vários arquivos saem num zip com a pasta; um arquivo só sai como ele é', async () => {
  const r = await fetch(`${base}/api/prototypes/${proto.id}/download`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="lp-de-teste.zip"');
  const JSZip = require('../public/vendor/jszip.min.js');
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()), { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).filter(n => !zip.files[n].dir).sort(), ['lp-de-teste/css/Style.css', 'lp-de-teste/index.html', 'lp-de-teste/js/main.js', 'lp-de-teste/sobre/index.html']);
  assert.equal(await zip.file('lp-de-teste/css/Style.css').async('string'), 'body{color:red}');
  assert.equal(await zip.file('lp-de-teste/index.html').async('string'), '<h1>oi</h1><script src="js/main.js"></script>');

  const solo = (await call('POST', '/api/prototypes', { name: 'Página única', workspaceId: 'ws1' })).body;
  assert.equal((await call('GET', `/api/prototypes/${solo.id}/download`)).status, 404, 'sem arquivos');
  await (await upload(solo.id, [['pagina.html', '<p>só eu</p>']])).finish();
  const one = await fetch(`${base}/api/prototypes/${solo.id}/download`);
  assert.equal(one.headers.get('content-disposition'), 'attachment; filename="pagina-unica.html"');
  assert.equal(one.headers.get('content-security-policy'), 'sandbox');
  assert.equal(await one.text(), '<p>só eu</p>');
  assert.equal((await call('DELETE', `/api/prototypes/${solo.id}`)).status, 200);
});

test('Token que não existe: 404 e limite de tentativas por IP', async () => {
  const ip = { 'x-ip': '10.0.0.99' };
  assert.equal((await call('GET', '/p/' + '0'.repeat(32), null, ip)).status, 404);
  let last;
  for (let i = 0; i < 45; i++) last = await call('GET', '/p/' + 'ab'.repeat(16), null, ip);
  assert.equal(last.status, 429);
  assert.equal((await call('GET', `/p/${token}`, null, ip)).status, 200, 'link válido não entra no limite');
});

test('Prazo vencido: de fora some, a equipe continua vendo', async () => {
  const p = db.prototypes[0];
  const real = p.link.expiresAt;
  p.link.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('GET', `/p/${token}`)).status, 410);
  assert.equal((await call('GET', `/p/${token}/f/index.html`)).status, 410);
  const shell = await call('GET', `/p/${token}`, null, { Cookie: 'sess=1' });
  assert.equal(shell.status, 200);
  assert.match(shell.text, /O link externo expirou/);
  assert.equal((await call('GET', '/api/prototypes')).body.items[0].link.active, false);
  p.link.expiresAt = real;
});

test('Novo envio troca a versão; envio sem .html não troca nada', async () => {
  const u = await upload(proto.id, [['home.html', 'nova']]);
  const done = await u.finish();
  assert.equal(done.body.entry, 'home.html');
  assert.ok(!fs.existsSync(firstVersionDir), 'versão anterior apagada');
  assert.deepEqual(api.orgUsage('org_a'), { bytes: 4, files: 1 });
  const bad = await upload(proto.id, [['a.css', 'x']]);
  assert.equal((await bad.finish()).status, 400);
  assert.equal(db.prototypes[0].version, u.up);
  assert.equal((await call('GET', `/p/${token}/f/home.html`)).status, 200);
});

test('Desativar o link troca o token; excluir apaga os arquivos', async () => {
  const off = await call('DELETE', `/api/prototypes/${proto.id}/link`);
  assert.equal(off.body.link, null);
  assert.notEqual(off.body.url.split('/p/')[1], token);
  assert.equal((await call('GET', `/p/${token}`)).status, 404, 'o endereço antigo deixa de existir');
  assert.equal((await call('DELETE', `/api/prototypes/${proto.id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'prototypes', proto.id)));
  assert.equal(db.prototypes.length, 0);
});
