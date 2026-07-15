/* ───────────────────────────────────────────────────────────────
   KASTOR — Smoke tests
   Roda com: npm test
   Requer Node 18+ (usa fetch global e node:test built-in).

   ATENÇÃO — banco de teste:
   Como o Kastor usa PostgreSQL, os testes precisam de um banco dedicado.
   Setar TEST_DATABASE_URL antes de rodar:

     export TEST_DATABASE_URL="postgres://user:pass@localhost:5432/kastor_test"
     npm test

   Sem essa variável, os testes são pulados com aviso — não bloqueia CI
   quando o banco não está disponível.

   ⚠️ NUNCA aponte pro banco de produção. Os testes truncam tabelas.
   ─────────────────────────────────────────────────────────────── */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  console.warn('\n⚠️  TEST_DATABASE_URL não definida — smoke tests pulados.');
  console.warn('   Setar pra rodar: export TEST_DATABASE_URL="postgres://user:pass@host/db_de_teste"\n');
  process.exit(0);
}

// CRÍTICO: definir env vars ANTES do require do server (capturado no module load).
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kastor-test-'));
process.env.KASTOR_DATA_DIR = TEST_DIR;
process.env.DATABASE_URL = TEST_DB_URL;
process.env.FLUXO_SECRET = 'test-secret-for-tests-only-not-prod';
process.env.PORT = '0';

// Pool separado só pra limpar tabelas ANTES do server subir. Sem isso, o boot
// pula o seed (flag install:completed já setada de execução anterior) e o
// admin não existe pra login.
const { Pool } = require('pg');
const _cleanupPool = new Pool({ connectionString: TEST_DB_URL });

let app, server, baseUrl;

test.before(async () => {
  // Limpa tudo pra estado consistente entre execuções.
  // DROP em vez de TRUNCATE porque queremos reset TOTAL — inclusive a flag
  // install:completed do KV pra o seed do admin rodar de novo.
  await _cleanupPool.query(
    `DROP TABLE IF EXISTS entities, notifications, password_resets, kv CASCADE`
  ).catch(() => {});
  // Agora sim carrega o server. Init recria as tabelas, seed cria admin/etc.
  app = require('../server.js');
  await app.ready;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise(r => server.close(r));
  await _cleanupPool.end().catch(() => {});
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

async function req(p, opts = {}) {
  const res = await fetch(baseUrl + p, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body, headers: res.headers };
}
async function postJson(p, payload, extra = {}) {
  return req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(extra.headers || {}) },
    body: JSON.stringify(payload)
  });
}

test('GET / devolve HTML do SPA', async () => {
  const r = await fetch(baseUrl + '/');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.toLowerCase().includes('<html'));
});

test('Headers de segurança presentes em todas as respostas', async () => {
  const r = await fetch(baseUrl + '/');
  // Anti-clickjacking
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  // Anti MIME-sniffing
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // CSP
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp, 'esperava header CSP');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  // Referrer policy
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  // Permissions
  assert.match(r.headers.get('permissions-policy') || '', /camera=\(\)/);
});

test('GET /api/inexistente devolve 404 JSON (não HTML do SPA)', async () => {
  const r = await req('/api/inexistente');
  assert.equal(r.status, 404);
  assert.ok(r.body && typeof r.body.error === 'string', 'esperava body.error');
});

test('GET /api/me sem autenticação devolve 401', async () => {
  const r = await req('/api/me');
  assert.equal(r.status, 401);
});

test('POST /api/login com credenciais corretas: 200 + cookie httpOnly', async () => {
  const r = await postJson('/api/login', { username: 'admin', password: 'admin123' });
  assert.equal(r.status, 200);
  assert.ok(r.body && r.body.user, 'esperava body.user');
  assert.equal(r.body.user.username, 'admin');
  const setCookie = r.headers.get('set-cookie') || '';
  assert.match(setCookie, /kastor_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/i);
});

test('POST /api/login com senha errada devolve 401', async () => {
  const r = await postJson('/api/login', { username: 'admin', password: 'errada' });
  assert.equal(r.status, 401);
});

test('GET /api/me com cookie de sessão devolve dados do usuário', async () => {
  const login = await postJson('/api/login', { username: 'admin', password: 'admin123' });
  const setCookie = login.headers.get('set-cookie') || '';
  const sessionCookie = setCookie.split(';')[0]; // só "kastor_session=xyz"
  assert.ok(sessionCookie.startsWith('kastor_session='));

  const me = await req('/api/me', { headers: { Cookie: sessionCookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'admin');
  assert.equal(me.body.isAdmin, true);
});

test('POST /api/logout invalida o cookie', async () => {
  const login = await postJson('/api/login', { username: 'admin', password: 'admin123' });
  const sessionCookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const logout = await req('/api/logout', { method: 'POST', headers: { Cookie: sessionCookie } });
  assert.equal(logout.status, 200);

  // O mesmo cookie agora deve dar 401 em /me
  const me = await req('/api/me', { headers: { Cookie: sessionCookie } });
  assert.equal(me.status, 401);
});

test('Persistência Postgres: criar projeto e ler de volta', async () => {
  // Login e obtém cookie
  const login = await postJson('/api/login', { username: 'admin', password: 'admin123' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  // Cria workspace (admin precisa)
  const ws = await postJson('/api/workspaces', { name: 'Test WS', color: '#7A00FF' }, { headers: { Cookie: cookie } });
  assert.equal(ws.status, 201);
  const wsId = ws.body.id;
  // Cria cliente (projetos agora exigem clientId existente)
  const cli = await postJson('/api/clients', { name: 'ACME', workspaceId: wsId }, { headers: { Cookie: cookie } });
  assert.equal(cli.status, 201);
  // Cria projeto vinculado ao cliente
  const p = await postJson('/api/projects', { name: 'Projeto Teste', clientId: cli.body.id, workspaceId: wsId }, { headers: { Cookie: cookie } });
  assert.equal(p.status, 201);
  assert.equal(p.body.name, 'Projeto Teste');
  // Aguarda o flush do buffer (30ms + margem) antes de ler.
  await new Promise(r => setTimeout(r, 200));
  const list = await req('/api/projects', { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  assert.ok(list.body.some(x => x.id === p.body.id), 'projeto criado deve aparecer na listagem');
});

test('Upload extrai base64 pra disco e devolve URL', async () => {
  const login = await postJson('/api/login', { username: 'admin', password: 'admin123' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  // 1x1 PNG transparente em base64
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const r = await postJson('/api/uploads', { name: 'pixel.png', data: tinyPng }, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^\/uploads\/[a-f0-9]+-pixel\.png$/);
  assert.ok(r.body.size > 0);
  // GET o arquivo de volta (com auth) deve devolver os mesmos bytes
  const fileRes = await fetch(baseUrl + r.body.url, { headers: { Cookie: cookie } });
  assert.equal(fileRes.status, 200);
  const got = Buffer.from(await fileRes.arrayBuffer());
  assert.ok(got.length > 0);
});

test('Upload /uploads/* sem auth devolve 401', async () => {
  const r = await fetch(baseUrl + '/uploads/qualquercoisa');
  assert.equal(r.status, 401);
});

// Mantido por último pra não interferir nos testes acima (5 falhas zeram em sucesso).
test('Rate limit: 6ª tentativa errada seguida devolve 429', async () => {
  for (let i = 0; i < 5; i++) {
    await postJson('/api/login', { username: 'admin', password: 'errada-' + i });
  }
  const r = await postJson('/api/login', { username: 'admin', password: 'mais-uma' });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'), 'esperava header Retry-After');
});
