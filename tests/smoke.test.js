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
process.env.CONSOLE_SETUP_TOKEN = 'setup-token-de-teste';
process.env.CONSOLE_RECOVERY_TOKEN = 'recuperacao-servidor-de-teste';
// Prazo do e-mail já passou; só vale quando há envio de e-mail (sem SMTP nos
// testes, só no teste do vínculo, que liga um envio falso).
process.env.EMAIL_REQUIRED_AFTER = '2020-01-01T00:00:00Z';

// Pool separado só pra limpar tabelas ANTES do server subir. Sem isso, o boot
// pula o seed (flag install:completed já setada de execução anterior) e o
// admin não existe pra login.
const { Pool } = require('pg');
const _cleanupPool = new Pool({ connectionString: TEST_DB_URL });

let app, server, baseUrl;

const crypto = require('node:crypto');
const LEGACY_TOKEN = 'legacy'.padEnd(48, '0');
/* Grava um auth.enc no formato antigo (mesma cifra do secure-store) e o
   usuário admin direto na tabela entities. */
async function seedLegacyInstall() {
  const { createStore } = require('../db-store');
  const st = createStore({ connectionString: TEST_DB_URL });
  await st.init();
  await st.upsert('users', {
    id: 'admin0legacy', username: 'admin', name: 'Administrador', role: 'Coordenação',
    isAdmin: true, avatar: null, active: true, workspaces: [], email: 'admin@exemplo.com',
    createdAt: new Date().toISOString()
  });
  await st.close();
  const key = crypto.scryptSync(process.env.FLUXO_SECRET, 'fluxo-auth-store', 32);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('admin123', salt, 64).toString('hex');
  const payload = {
    credentials: { admin0legacy: { salt, hash } },
    tokens: [{ token: LEGACY_TOKEN, userId: 'admin0legacy', createdAt: new Date().toISOString(), expiresAt: Date.now() + 864e5 }],
    webauthn: {}
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  fs.writeFileSync(path.join(TEST_DIR, 'auth.enc'), Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64'));
}

test.before(async () => {
  // Limpa tudo pra estado consistente entre execuções.
  // DROP em vez de TRUNCATE porque queremos reset TOTAL — inclusive a flag
  // install:completed do KV pra o seed do admin rodar de novo.
  await _cleanupPool.query(
    `DROP TABLE IF EXISTS entities, notifications, password_resets, kv,
       auth_credentials, auth_sessions, auth_webauthn CASCADE`
  ).catch(() => {});
  // Simula uma base de produção ANTES da migração de credenciais: o admin
  // existe no banco e a senha + uma sessão ativa vivem no data/auth.enc
  // antigo. O boot tem que importar os dois pro Postgres.
  await seedLegacyInstall();
  // Agora sim carrega o server. Init cria as tabelas novas e importa o auth.enc.
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
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
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

async function loginCookie(username, password) {
  const r = await postJson('/api/login', { username, password });
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const flushed = () => new Promise(r => setTimeout(r, 250));

test('Migração: sessão antiga do auth.enc continua valendo', async () => {
  const me = await req('/api/me', { headers: { Cookie: 'kastor_session=' + LEGACY_TOKEN } });
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'admin');
});

test('Sessões e senhas ficam no Postgres, sem o token em texto', async () => {
  const cookie = await loginCookie('admin', 'admin123');
  const token = cookie.split('=')[1];
  const sha = crypto.createHash('sha256').update(token).digest('hex');
  // A gravação da sessão é assíncrona (fila): espera até 3s pela linha.
  let s;
  for (let i = 0; i < 30; i++) {
    s = await _cleanupPool.query('SELECT user_id, data FROM auth_sessions WHERE token_hash = $1', [sha]);
    if (s.rows.length) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].user_id, 'admin0legacy');
  const plain = await _cleanupPool.query("SELECT count(*)::int n FROM auth_sessions WHERE token_hash = $1 OR data::text LIKE $2", [token, '%' + token + '%']);
  assert.equal(plain.rows[0].n, 0, 'token em texto não pode estar no banco');
  const c = await _cleanupPool.query('SELECT secret FROM auth_credentials WHERE user_id = $1', ['admin0legacy']);
  assert.equal(c.rows.length, 1);
  assert.ok(!/^[a-f0-9]{128}$/.test(c.rows[0].secret), 'hash da senha deve estar cifrado');
});

test('Login aceita o e-mail da conta', async () => {
  const r = await postJson('/api/login', { username: 'ADMIN@exemplo.com', password: 'admin123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'admin');
});

test('Convite: criar, abrir, aceitar e entrar', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const H = { headers: { Cookie: admin } };
  const ws = await postJson('/api/workspaces', { name: 'Squad Convite' }, H);
  assert.equal(ws.status, 201);

  // Validações de criação
  let r = await postJson('/api/invites', { email: 'nao-e-email', kind: 'equipe', workspaces: [ws.body.id] }, H);
  assert.equal(r.status, 400);
  r = await postJson('/api/invites', { email: 'nova@exemplo.com', kind: 'equipe', workspaces: [] }, H);
  assert.equal(r.status, 400, 'sem squad não pode');
  r = await postJson('/api/invites', { email: 'admin@exemplo.com', kind: 'equipe', workspaces: [ws.body.id] }, H);
  assert.equal(r.status, 409, 'e-mail de conta existente');

  r = await postJson('/api/invites', { email: 'Nova.Pessoa@Exemplo.com', name: 'Nova Pessoa', kind: 'equipe', role: 'Criação', workspaces: [ws.body.id] }, H);
  assert.equal(r.status, 201);
  assert.equal(r.body.invite.email, 'nova.pessoa@exemplo.com');
  assert.equal(r.body.emailSent, false, 'sem SMTP no teste');
  const link = r.body.link;
  const token = link.split('/convite/')[1];
  assert.ok(token && token.length >= 20);

  const dup = await postJson('/api/invites', { email: 'nova.pessoa@exemplo.com', kind: 'equipe', workspaces: [ws.body.id] }, H);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'invite_pending');

  const list = await req('/api/invites', H);
  assert.equal(list.status, 200);
  assert.ok(list.body.invites.some(i => i.email === 'nova.pessoa@exemplo.com' && i.status === 'pending'));
  assert.ok(!JSON.stringify(list.body).includes(token), 'lista não expõe o token');

  const again = await req(`/api/invites/${r.body.invite.id}/link`, H);
  assert.equal(again.body.link, link, 'admin recupera o mesmo link');

  // Público
  const pub = await req('/api/invites/public/' + token);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.email, 'nova.pessoa@exemplo.com');
  assert.equal(pub.body.inviterName, 'Administrador');
  assert.deepEqual(pub.body.squads, ['Squad Convite']);
  assert.equal(pub.body.suggestedUsername, 'nova.pessoa');
  assert.equal((await req('/api/invites/public/' + 'x'.repeat(32))).status, 404);

  const acc = (body) => postJson(`/api/invites/public/${token}/accept`, body);
  assert.equal((await acc({ name: 'Nova', username: 'nova.pessoa', password: 'curta', acceptTerms: true })).status, 400);
  assert.equal((await acc({ name: 'Nova', username: 'admin', password: 'senha-forte-1', acceptTerms: true })).status, 409);
  assert.equal((await acc({ name: 'Nova', username: 'A B', password: 'senha-forte-1', acceptTerms: true })).status, 400);
  assert.equal((await acc({ name: 'Nova', username: 'nova.pessoa', password: 'senha-forte-1' })).status, 400, 'termos');

  const ok = await acc({ name: 'Nova Pessoa', username: 'nova.pessoa', password: 'senha-forte-1', acceptTerms: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
  const me = await req('/api/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, 'nova.pessoa@exemplo.com');
  assert.equal(me.body.role, 'Criação');
  assert.deepEqual(me.body.workspaces, [ws.body.id]);
  assert.equal(me.body.isAdmin, false);
  assert.ok(me.body.emailVerifiedAt);

  // Link usado não serve de novo; o convite sai da lista
  const used = await req('/api/invites/public/' + token);
  assert.equal(used.status, 410);
  assert.equal(used.body.status, 'accepted');
  assert.equal((await acc({ name: 'X', username: 'outra.pessoa', password: 'senha-forte-1', acceptTerms: true })).status, 410);
  const list2 = await req('/api/invites', H);
  assert.ok(!list2.body.invites.some(i => i.email === 'nova.pessoa@exemplo.com'));

  // Entra pelo e-mail; quem não é admin não convida
  const c2 = await loginCookie('nova.pessoa@exemplo.com', 'senha-forte-1');
  const forbidden = await postJson('/api/invites', { email: 'x@exemplo.com', kind: 'equipe', workspaces: [ws.body.id] }, { headers: { Cookie: c2 } });
  assert.equal(forbidden.status, 403);

  // Perfil não troca o e-mail digitando (só com senha + link)
  const clash = await req('/api/me', { method: 'PUT', headers: { Cookie: c2, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@exemplo.com' }) });
  assert.equal(clash.status, 400);
});

test('Convite cancelado não abre', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const H = { headers: { Cookie: admin } };
  const r = await postJson('/api/invites', { email: 'cancelado@exemplo.com', kind: 'admin' }, H);
  assert.equal(r.status, 201);
  const token = r.body.link.split('/convite/')[1];
  const del = await req('/api/invites/' + r.body.invite.id, { method: 'DELETE', headers: { Cookie: admin } });
  assert.equal(del.status, 200);
  const pub = await req('/api/invites/public/' + token);
  assert.equal(pub.status, 410);
  assert.equal(pub.body.status, 'revoked');
});

test('Cadastro manual: e-mail repetido é recusado e senha curta também', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const H = { headers: { Cookie: admin } };
  let r = await postJson('/api/users', { username: 'repetido', password: 'senha-forte-1', name: 'R', email: 'admin@exemplo.com' }, H);
  assert.equal(r.status, 409);
  r = await postJson('/api/users', { username: 'curtinha', password: '123456', name: 'C' }, H);
  assert.equal(r.status, 400);
});

test('Trocar a senha no perfil encerra as outras sessões', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const other = await loginCookie('admin', 'admin123');
  const put = await req('/api/me', { method: 'PUT', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin123', newPassword: 'admin12345' }) });
  assert.equal(put.status, 200);
  assert.equal((await req('/api/me', { headers: { Cookie: admin } })).status, 200, 'sessão atual continua');
  assert.equal((await req('/api/me', { headers: { Cookie: other } })).status, 401, 'outra sessão cai');
  // Volta a senha pros testes seguintes
  const back = await req('/api/me', { method: 'PUT', headers: { Cookie: admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin12345', newPassword: 'admin123' }) });
  assert.equal(back.status, 200);
});

/* ── reWork Console ── */
function totpAt(secretB32, step) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const ch of secretB32.replace(/\s/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const nowStep = () => Math.floor(Date.now() / 30000);
let consoleCookie = null, consoleSecret = null, recoveryCodes = [];

test('Console: página separada e fechada sem login', async () => {
  const page = await fetch(baseUrl + '/console');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<meta name="robots" content="noindex/);
  const sub = await fetch(baseUrl + '/console/entrar');
  assert.equal(sub.status, 200);
  assert.match(sub.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal((await req('/api/console/overview')).status, 401);
  assert.equal((await req('/api/console/status')).body.setupNeeded, false);
});

let defaultConsoleCookie = null;
test('Console: acesso padrão admin/admin123 entra sem verificação em duas etapas', async () => {
  // Outro IP: o login do console aceita 5 tentativas por minuto por IP.
  const IP = { headers: { 'X-Forwarded-For': '10.7.7.7' } };
  assert.equal((await postJson('/api/console/login', { email: 'admin', password: 'errada' }, IP)).status, 401);
  const l = await postJson('/api/console/login', { email: 'admin', password: 'admin123' }, IP);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.step, 'done');
  assert.equal(l.body.admin.twoFactorExempt, true);
  defaultConsoleCookie = (l.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await req('/api/console/me', { headers: { Cookie: defaultConsoleCookie } })).status, 200);
  // Sem app, não há códigos de recuperação pra gerar
  assert.equal((await req('/api/console/me/recovery-codes', { method: 'POST', headers: { Cookie: defaultConsoleCookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('Console: superadmin pessoal é convidado e ativa com o app autenticador', async () => {
  const H = { Cookie: defaultConsoleCookie, 'Content-Type': 'application/json' };
  const inv = await req('/api/console/admins', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Root', email: 'root@exemplo.com' }) });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = inv.body.link.split('/console/ativar/')[1];
  assert.equal((await postJson('/api/console/activate/' + token, { password: 'curta' })).status, 400);
  const act = await postJson('/api/console/activate/' + token, { password: 'senha-muito-forte' });
  assert.equal(act.status, 200);
  assert.equal(act.body.step, 'enroll');
  assert.match(act.body.qr, /^<svg/);
  consoleSecret = act.body.secret.replace(/\s/g, '');
  assert.equal((await postJson('/api/console/login/verify', { ticket: act.body.ticket, code: '000000' })).status, 400);
  const v = await postJson('/api/console/login/verify', { ticket: act.body.ticket, code: totpAt(consoleSecret, nowStep()) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.recoveryCodes.length, 10, 'cadastro do app entrega 10 códigos de recuperação');
  assert.match(v.body.recoveryCodes[0], /^[a-z0-9]{4}-[a-z0-9]{4}$/);
  recoveryCodes = v.body.recoveryCodes;
  const sc = v.headers.get('set-cookie') || '';
  assert.match(sc, /rework_console=/);
  assert.match(sc, /SameSite=Strict/);
  consoleCookie = sc.split(';')[0];
  assert.equal((await req('/api/console/me', { headers: { Cookie: consoleCookie } })).status, 200);
  // O acesso padrão pode ser desativado (e deixa de entrar)
  const list = await req('/api/console/admins', { headers: { Cookie: consoleCookie } });
  const def = list.body.items.find(a => a.isDefaultAccount);
  const off = await req('/api/console/admins/' + def.id, { method: 'PATCH', headers: { Cookie: consoleCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
  assert.equal(off.status, 200);
  assert.equal((await postJson('/api/console/login', { email: 'admin', password: 'admin123' }, { headers: { 'X-Forwarded-For': '10.7.7.7' } })).status, 401);
  assert.equal((await req('/api/console/me', { headers: { Cookie: defaultConsoleCookie } })).status, 401, 'sessão do acesso padrão cai');
});

test('Console: sessões do reWork e do console não se misturam', async () => {
  const rw = await loginCookie('admin', 'admin123');
  assert.equal((await req('/api/console/me', { headers: { Cookie: rw } })).status, 401, 'sessão do reWork não abre o console');
  assert.equal((await req('/api/me', { headers: { Cookie: consoleCookie } })).status, 401, 'sessão do console não abre o reWork');
  // Superadmin não entra no reWork com a mesma senha
  assert.equal((await postJson('/api/login', { username: 'root@exemplo.com', password: 'senha-muito-forte' })).status, 401);
});

test('Console: entrar pede senha e código, e o código não pode ser reusado', async () => {
  assert.equal((await postJson('/api/console/login', { email: 'root@exemplo.com', password: 'errada-errada' })).status, 401);
  const l = await postJson('/api/console/login', { email: 'ROOT@exemplo.com', password: 'senha-muito-forte' });
  assert.equal(l.status, 200);
  assert.equal(l.body.step, 'totp');
  // O passo usado no cadastro já foi consumido: código antigo é recusado
  const reused = await postJson('/api/console/login/verify', { ticket: l.body.ticket, code: totpAt(consoleSecret, nowStep() - 1) });
  assert.equal(reused.status, 400);
  const ok = await postJson('/api/console/login/verify', { ticket: l.body.ticket, code: totpAt(consoleSecret, nowStep() + 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('Console: código de recuperação substitui o celular uma vez só', async () => {
  const l1 = await postJson('/api/console/login', { email: 'root@exemplo.com', password: 'senha-muito-forte' });
  const ok = await postJson('/api/console/login/verify', { ticket: l1.body.ticket, code: recoveryCodes[0].toUpperCase() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.usedRecovery, true);
  assert.equal(ok.body.admin.recoveryLeft, 9);
  const l2 = await postJson('/api/console/login', { email: 'root@exemplo.com', password: 'senha-muito-forte' });
  assert.equal((await postJson('/api/console/login/verify', { ticket: l2.body.ticket, code: recoveryCodes[0] })).status, 400, 'código usado não vale de novo');
  assert.equal((await postJson('/api/console/login/verify', { ticket: l2.body.ticket, code: 'abcd-efgh' })).status, 400);
});

test('Console: gerar códigos novos e trocar senha pedem o código do app', async () => {
  const H = { Cookie: consoleCookie, 'Content-Type': 'application/json' };
  // O código do passo seguinte já foi usado no teste anterior: espera a
  // próxima janela de 30s pra ter um código novo (o reuso é recusado).
  await new Promise(r => setTimeout(r, 30000 - (Date.now() % 30000) + 100));
  const bad = await req('/api/console/me/recovery-codes', { method: 'POST', headers: H, body: JSON.stringify({ code: '000000' }) });
  assert.equal(bad.status, 400);
  const gen = await req('/api/console/me/recovery-codes', { method: 'POST', headers: H, body: JSON.stringify({ code: totpAt(consoleSecret, nowStep() + 1) }) });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  assert.equal(gen.body.recoveryCodes.length, 10);
  // Os antigos deixam de valer
  const l = await postJson('/api/console/login', { email: 'root@exemplo.com', password: 'senha-muito-forte' });
  assert.equal((await postJson('/api/console/login/verify', { ticket: l.body.ticket, code: recoveryCodes[1] })).status, 400);
  recoveryCodes = gen.body.recoveryCodes;
  const wrongPw = await req('/api/console/me/password', { method: 'POST', headers: H, body: JSON.stringify({ current: 'errada', password: 'outra-senha-bem-forte', code: '123456' }) });
  assert.equal(wrongPw.status, 400);
  assert.equal(wrongPw.body.field, 'current');
});

test('Console: esqueci a senha sem e-mail configurado avisa', async () => {
  const r = await postJson('/api/console/forgot', { email: 'root@exemplo.com' });
  assert.equal(r.status, 200);
  assert.equal(r.body.emailEnabled, false);
});

test('Console: recuperação pelo servidor vale uma vez e redefine o acesso', async () => {
  assert.equal((await req('/api/console/status')).body.recoveryEnabled, true);
  assert.equal((await postJson('/api/console/recover', { token: 'errado-errado-errado', email: 'root@exemplo.com' })).status, 403);
  assert.equal((await postJson('/api/console/recover', { token: 'recuperacao-servidor-de-teste', email: 'ninguem@exemplo.com' })).status, 404);
  const r = await postJson('/api/console/recover', { token: 'recuperacao-servidor-de-teste', email: 'root@exemplo.com' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = r.body.link.split('/console/ativar/')[1];
  assert.equal((await postJson('/api/console/recover', { token: 'recuperacao-servidor-de-teste', email: 'root@exemplo.com' })).status, 410, 'mesmo valor não vale duas vezes');
  // Sessões antigas caem; o link cria senha nova e pede o app de novo
  assert.equal((await req('/api/console/me', { headers: { Cookie: consoleCookie } })).status, 401);
  const act = await postJson('/api/console/activate/' + token, { password: 'senha-nova-muito-forte' });
  assert.equal(act.status, 200);
  assert.equal(act.body.step, 'enroll');
  consoleSecret = act.body.secret.replace(/\s/g, '');
  const v = await postJson('/api/console/login/verify', { ticket: act.body.ticket, code: totpAt(consoleSecret, nowStep()) });
  assert.equal(v.status, 200);
  assert.equal(v.body.recoveryCodes.length, 10);
  consoleCookie = (v.headers.get('set-cookie') || '').split(';')[0];
  const audit = await req('/api/console/audit', { headers: { Cookie: consoleCookie } });
  assert.ok(audit.body.items.some(e => e.action === 'server_recovery'));
});

test('Lista de espera: formulário público e revisão no console', async () => {
  const H = { headers: { Cookie: consoleCookie } };
  const base = { name: 'Paula Reis', email: 'paula@agencia.com', company: 'Agência Norte', teamSize: '6-15', consent: true, elapsedMs: 8000 };
  assert.equal((await postJson('/api/access-requests', { ...base, email: 'nao-e-email' })).status, 400);
  assert.equal((await postJson('/api/access-requests', { ...base, consent: false })).status, 400);
  assert.equal((await postJson('/api/access-requests', { ...base, email: 'robo@spam.com', company_site: 'x' })).status, 201, 'isca responde ok');
  assert.equal((await postJson('/api/access-requests', base)).status, 201);
  assert.equal((await postJson('/api/access-requests', { ...base, message: 'segunda vez' })).status, 201);
  const list = await req('/api/console/access-requests', H);
  assert.equal(list.status, 200);
  assert.ok(!list.body.items.some(r => r.email === 'robo@spam.com'), 'robô não é gravado');
  const mine = list.body.items.filter(r => r.email === 'paula@agencia.com');
  assert.equal(mine.length, 1, 'reenvio atualiza o mesmo pedido');
  assert.equal(mine[0].submissions, 2);
  const p = await req('/api/console/access-requests/' + mine[0].id, { method: 'PATCH', headers: { ...H.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'approved', note: 'Ligar na segunda.' }) });
  assert.equal(p.status, 200);
  assert.equal(p.body.status, 'approved');
  assert.equal(p.body.notes.length, 2);
  const ov = await req('/api/console/overview', H);
  assert.equal(ov.status, 200);
  assert.equal(ov.body.waitlist.counts.approved, 1);
  assert.equal(ov.body.series.created.length, 30);
  const audit = await req('/api/console/audit', H);
  assert.ok(audit.body.items.some(e => e.action === 'request_status'));
});

/* ── Organizações: isolamento entre duas organizações ── */
const J = (cookie) => ({ Cookie: cookie, 'Content-Type': 'application/json' });
const call = (method, p, cookie, body) => req(p, { method, headers: J(cookie), body: body !== undefined ? JSON.stringify(body) : undefined });
let betaCookie = null, wsiDemandId = null, betaOrgId = null;

test('Organizações: migração cria a WSI com o dono e o seletor', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const me = await req('/api/me', { headers: { Cookie: admin } });
  assert.equal(me.body.org.name, 'WSI');
  assert.equal(me.body.isOwner, true, 'o admin mais antigo vira dono');
  assert.equal(me.body.orgs.length, 1);
  assert.equal(me.body.orgRole, 'owner');
});

test('Organizações: aprovar pedido no console cria a organização e convida o dono', async () => {
  const pedido = { name: 'Bia Souza', email: 'bia@beta.com', company: 'Agência Beta', teamSize: '1-5', consent: true, elapsedMs: 5000 };
  // Outro IP: o formulário tem limite de 5 pedidos a cada 10 min por IP.
  assert.equal((await postJson('/api/access-requests', pedido, { headers: { 'X-Forwarded-For': '10.9.9.9' } })).status, 201);
  const list = await req('/api/console/access-requests', { headers: { Cookie: consoleCookie } });
  const r = list.body.items.find(x => x.email === 'bia@beta.com');
  const c = await call('POST', `/api/console/access-requests/${r.id}/create-org`, consoleCookie, { name: 'Beta' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.request.status, 'approved');
  assert.equal(c.body.org.name, 'Beta');
  betaOrgId = c.body.org.id;
  assert.equal((await call('POST', `/api/console/access-requests/${r.id}/create-org`, consoleCookie, { name: 'Beta 2' })).status, 409, 'não cria duas vezes');
  const token = c.body.link.split('/convite/')[1];
  const pub = await req('/api/invites/public/' + token);
  assert.equal(pub.body.orgName, 'Beta');
  assert.equal(pub.body.access, 'Dono da organização');
  const acc = await postJson(`/api/invites/public/${token}/accept`, { name: 'Bia Souza', username: 'bia.souza', password: 'senha-da-bia-1', acceptTerms: true });
  assert.equal(acc.status, 201, JSON.stringify(acc.body));
  betaCookie = (acc.headers.get('set-cookie') || '').split(';')[0];
  const me = await req('/api/me', { headers: { Cookie: betaCookie } });
  assert.equal(me.body.org.name, 'Beta');
  assert.equal(me.body.isOwner, true);
  const orgs = await req('/api/console/orgs', { headers: { Cookie: consoleCookie } });
  assert.equal(orgs.body.items.find(o => o.id === betaOrgId).owner.name, 'Bia Souza');
});

test('Organizações: nada da WSI aparece na Beta (e vice-versa)', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const boot = (await req('/api/bootstrap', { headers: { Cookie: admin } })).body;
  const flow = boot.flows[0];
  const proj = boot.projects[0];
  const d = await call('POST', '/api/demands', admin, { name: 'Demanda secreta da WSI', projectId: proj.id, flowId: flow.id });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  wsiDemandId = d.body.id;

  const beta = (await req('/api/bootstrap', { headers: { Cookie: betaCookie } })).body;
  assert.deepEqual(beta.workspaces.map(w => w.name), ['Geral']);
  assert.equal(beta.users.length, 1, 'só a própria dona');
  assert.equal(beta.demands.length, 0);
  assert.equal(beta.clients.length, 0);
  assert.equal(beta.projects.length, 0);
  assert.ok(!JSON.stringify(beta).includes('Demanda secreta'), 'nenhum rastro da WSI');
  assert.ok(!beta.workspaces.some(w => boot.workspaces.some(x => x.id === w.id)));

  assert.equal((await call('GET', '/api/demands/' + wsiDemandId, betaCookie)).status, 404);
  assert.equal((await call('PUT', '/api/demands/' + wsiDemandId, betaCookie, { name: 'hackeada' })).status, 404);
  assert.equal((await call('DELETE', '/api/demands/' + wsiDemandId, betaCookie)).status, 404);
  assert.equal((await call('POST', '/api/demands', betaCookie, { name: 'x', projectId: proj.id, flowId: flow.id })).status, 400);
  const wsiAdminId = boot.users.find(u => u.username === 'admin').id;
  assert.equal((await call('PUT', '/api/users/' + wsiAdminId, betaCookie, { name: 'hackeado' })).status, 404);
  assert.equal((await call('PUT', '/api/workspaces/' + boot.workspaces[0].id, betaCookie, { name: 'x' })).status, 404);
  const users = (await req('/api/users', { headers: { Cookie: betaCookie } })).body;
  assert.equal(users.length, 1);
  assert.equal((await req('/api/demands', { headers: { Cookie: betaCookie } })).body.length, 0);

  // A WSI também não vê a Beta
  const again = (await req('/api/bootstrap', { headers: { Cookie: admin } })).body;
  assert.ok(!again.users.some(u => u.username === 'bia.souza'));
  assert.ok(!again.workspaces.some(w => beta.workspaces.some(x => x.id === w.id)));
});

test('Organizações: conta existente entra numa segunda organização e troca entre elas', async () => {
  // A dona da Beta convida o admin da WSI como Equipe
  const betaBoot = (await req('/api/bootstrap', { headers: { Cookie: betaCookie } })).body;
  const inv = await call('POST', '/api/invites', betaCookie, { email: 'admin@exemplo.com', kind: 'equipe', workspaces: [betaBoot.workspaces[0].id] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = inv.body.link.split('/convite/')[1];
  const pub = await req('/api/invites/public/' + token);
  assert.equal(pub.body.accountExists, true);
  assert.equal((await postJson(`/api/invites/public/${token}/join`, { password: 'errada', acceptTerms: true })).status, 401);
  const j = await postJson(`/api/invites/public/${token}/join`, { password: 'admin123', acceptTerms: true });
  assert.equal(j.status, 201, JSON.stringify(j.body));
  const cookie = (j.headers.get('set-cookie') || '').split(';')[0];
  let me = (await req('/api/me', { headers: { Cookie: cookie } })).body;
  assert.equal(me.org.name, 'Beta', 'entra direto na organização do convite');
  assert.equal(me.isAdmin, false, 'na Beta é Equipe');
  assert.equal(me.orgs.length, 2);
  // Equipe não convida nem exclui demanda dos outros
  assert.equal((await call('POST', '/api/invites', cookie, { email: 'x@y.com', kind: 'equipe', workspaces: [betaBoot.workspaces[0].id] })).status, 403);
  // Troca pra WSI: volta a ser dono e vê a demanda secreta
  const sw = await call('POST', '/api/orgs/switch', cookie, { orgId: me.orgs.find(o => o.name === 'WSI').id });
  assert.equal(sw.status, 200);
  me = (await req('/api/me', { headers: { Cookie: cookie } })).body;
  assert.equal(me.org.name, 'WSI');
  assert.equal(me.isOwner, true);
  assert.equal((await call('GET', '/api/demands/' + wsiDemandId, cookie)).status, 200);
  assert.equal((await call('POST', '/api/orgs/switch', cookie, { orgId: 'org_inexistente' })).status, 404);
  // A dona da Beta não pode mudar a senha de quem também está em outra organização
  const wsiAdminInBeta = (await req('/api/users', { headers: { Cookie: betaCookie } })).body.find(u => u.username === 'admin');
  assert.ok(wsiAdminInBeta, 'agora aparece na Beta');
  assert.equal((await call('PUT', '/api/users/' + wsiAdminInBeta.id, betaCookie, { password: 'senha-nova-123' })).status, 403);
});

test('Permissões: equipe só exclui o que criou; moderador exclui do squad', async () => {
  const admin = await loginCookie('admin', 'admin123');
  await call('POST', '/api/orgs/switch', admin, { orgId: (await req('/api/me', { headers: { Cookie: admin } })).body.orgs.find(o => o.name === 'WSI').id });
  const boot = (await req('/api/bootstrap', { headers: { Cookie: admin } })).body;
  const ws = boot.projects[0].workspaceId;
  const flowWs = boot.flows[0].workspaceId;
  const mk = async (username, kind) => {
    const u = await call('POST', '/api/users', admin, { username, password: 'senha-forte-1', name: username, workspaces: [ws, flowWs], isModerator: kind === 'mod' });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    return loginCookie(username, 'senha-forte-1');
  };
  const eq = await mk('pessoa.equipe', 'equipe');
  const mod = await mk('pessoa.mod', 'mod');
  const del = await call('DELETE', '/api/demands/' + wsiDemandId, eq);
  assert.equal(del.status, 403, 'equipe não exclui demanda de outra pessoa');
  const mine = await call('POST', '/api/demands', eq, { name: 'Minha demanda', projectId: boot.projects[0].id, flowId: boot.flows[0].id });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal((await call('DELETE', '/api/demands/' + mine.body.id, eq)).status, 200, 'exclui a que criou');
  // Moderador convida só Equipe/Freelancer nos squads dele
  assert.equal((await call('POST', '/api/invites', mod, { email: 'novo.adm@exemplo.com', kind: 'admin' })).status, 400);
  assert.equal((await call('POST', '/api/invites', mod, { email: 'novo.eq@exemplo.com', kind: 'equipe', workspaces: [ws] })).status, 201);
  assert.equal((await call('DELETE', '/api/demands/' + wsiDemandId, mod)).status, 200, 'moderador exclui do squad');
  // Admin não mexe no dono
  const ownerId = boot.users.find(u => u.username === 'admin').id;
  const adm2 = await call('POST', '/api/users', admin, { username: 'outro.admin', password: 'senha-forte-1', name: 'Outro Admin', isAdmin: true });
  assert.equal(adm2.status, 201);
  const a2 = await loginCookie('outro.admin', 'senha-forte-1');
  assert.equal((await call('PUT', '/api/users/' + ownerId, a2, { isAdmin: false })).status, 403);
});

test('Organização: ajustes, exportação e quem pode mudar', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const me = (await req('/api/me', { headers: { Cookie: admin } })).body;
  await call('POST', '/api/orgs/switch', admin, { orgId: me.orgs.find(o => o.name === 'WSI').id });
  let r = await call('PUT', '/api/org', admin, { settings: { dailyHours: 6 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.dailyHours, 6);
  assert.equal((await call('PUT', '/api/org', admin, { settings: { dailyHours: 30 } })).status, 400);
  // Moderador não convida quando a organização desliga
  assert.equal((await call('PUT', '/api/org', admin, { settings: { modsCanInvite: false } })).status, 200);
  const mod = await loginCookie('pessoa.mod', 'senha-forte-1');
  const boot = (await req('/api/bootstrap', { headers: { Cookie: admin } })).body;
  assert.equal((await call('POST', '/api/invites', mod, { email: 'mais.um@exemplo.com', kind: 'equipe', workspaces: [boot.projects[0].workspaceId] })).status, 403);
  assert.equal((await call('PUT', '/api/org', mod, { settings: { dailyHours: 7 } })).status, 403, 'moderador não muda ajustes');
  // Admin que não é dono não muda nome
  const a2 = await loginCookie('outro.admin', 'senha-forte-1');
  assert.equal((await call('PUT', '/api/org', a2, { name: 'Outro nome' })).status, 403);
  // Exportação: só da organização ativa, sem cofre de senhas
  const ex = await fetch(baseUrl + '/api/org/export', { headers: { Cookie: admin } });
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-disposition') || '', /attachment; filename="rework-wsi-/);
  const data = await ex.json();
  assert.equal(data.organization.name, 'WSI');
  assert.ok(!('passwords' in data));
  assert.ok(!data.people.some(p => p.username === 'bia.souza'), 'ninguém de outra organização');
  assert.equal((await fetch(baseUrl + '/api/org/export', { headers: { Cookie: mod } })).status, 403);
  // Jornada por dia: seg–qui 9h–18h30 e sex 9h–16h, com 1h de intervalo
  const week = [1, 2, 3, 4].map(day => ({ day, on: true, start: '09:00', end: '18:30', breakMinutes: 60 }))
    .concat([{ day: 5, on: true, start: '09:00', end: '16:00', breakMinutes: 60 }, { day: 6, on: false }, { day: 0, on: false }]);
  r = await call('PUT', '/api/org', admin, { settings: { schedule: { mode: 'custom', week } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.schedule.mode, 'custom');
  assert.equal(r.body.settings.weeklyHours, 40);
  const fri = r.body.settings.schedule.week.find(w => w.day === 5);
  assert.equal(fri.hours, 6);
  assert.equal(r.body.settings.schedule.week.find(w => w.day === 1).hours, 8.5);
  assert.equal(r.body.settings.schedule.week.find(w => w.day === 6).on, false);
  assert.equal((await call('PUT', '/api/org', admin, { settings: { schedule: { mode: 'custom', week: [{ day: 1, on: true, start: '18:00', end: '09:00' }] } } })).status, 400);
  assert.equal((await call('PUT', '/api/org', admin, { settings: { schedule: { mode: 'custom', week: [{ day: 1, on: false }] } } })).status, 400, 'pelo menos um dia');
  await call('PUT', '/api/org', admin, { settings: { dailyHours: 8, modsCanInvite: true, schedule: { mode: 'simple' } } });
});

test('Nomes de etapa: lista padrão, moderador edita, equipe não', async () => {
  const admin = await loginCookie('admin', 'admin123');
  let org = (await req('/api/org', { headers: { Cookie: admin } })).body;
  assert.ok(org.settings.stagePresets.length >= 10, 'começa com a lista sugerida');
  assert.ok(org.settings.stagePresets.some(p => p.label === 'Criação'));
  const mod = await loginCookie('pessoa.mod', 'senha-forte-1');
  const eq = await loginCookie('pessoa.equipe', 'senha-forte-1');
  const list = [{ label: 'Briefing', color: '#0EA5E9' }, { label: 'Criação', color: '#7A00FF' }, { label: 'Aprovação do cliente', color: '#F97316' }];
  assert.equal((await call('PUT', '/api/org/stage-presets', eq, { presets: list })).status, 403, 'equipe não edita');
  assert.equal((await call('PUT', '/api/org/stage-presets', mod, { presets: [...list, { label: 'criação' }] })).status, 400, 'nome repetido');
  assert.equal((await call('PUT', '/api/org/stage-presets', mod, { presets: [] })).status, 400);
  const r = await call('PUT', '/api/org/stage-presets', mod, { presets: list });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.settings.stagePresets.map(p => p.label), ['Briefing', 'Criação', 'Aprovação do cliente']);
  org = (await req('/api/org', { headers: { Cookie: eq } })).body;
  assert.equal(org.settings.stagePresets.length, 3, 'todo mundo recebe a lista nova');
});

test('Fluxos: etapa de conclusão não tem responsável', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const boot = (await req('/api/bootstrap', { headers: { Cookie: admin } })).body;
  const someone = boot.users.find(u => u.active !== false).id;
  const f = await call('POST', '/api/flows', admin, {
    name: 'Fluxo com conclusão', workspaceId: boot.workspaces[0].id,
    stages: [
      { label: 'Produção', responsibleId: someone },
      { label: 'Concluída', done: true, responsibleId: someone, responsibleRole: 'Criação' }
    ]
  });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  const done = f.body.stages.find(s => s.done);
  assert.equal(done.responsibleId, null);
  assert.equal(done.responsibleRole, null);
  assert.equal(f.body.stages.find(s => !s.done).responsibleId, someone);
  // Demanda que chega na conclusão fica sem responsável
  const proj = boot.projects.find(p => p.workspaceId === boot.workspaces[0].id) || boot.projects[0];
  const d = await call('POST', '/api/demands', admin, { name: 'Vai concluir', projectId: proj.id, flowId: f.body.id, stageResponsibles: { [done.id]: someone } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.ok(!d.body.stageResponsibles || !d.body.stageResponsibles[done.id], 'não guarda responsável na conclusão');
  const moved = await call('PUT', '/api/demands/' + d.body.id, admin, { status: done.id });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.ownerId, null);
  assert.ok(moved.body.completedAt);
});

test('E-mail: vincular pede senha e link, e passado o prazo a conta sem e-mail só vê a confirmação', async () => {
  const admin = await loginCookie('admin', 'admin123');
  const boot = (await req('/api/bootstrap', { headers: { Cookie: admin } })).body;
  const created = await call('POST', '/api/users', admin, { username: 'sem.email', password: 'senha-forte-1', name: 'Sem Email', workspaces: [boot.workspaces[0].id] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const c = await loginCookie('sem.email', 'senha-forte-1');
  // Conta com e-mail cadastrado pelo admin (ainda não confirmado)
  assert.equal((await call('POST', '/api/users', admin, { username: 'com.email', password: 'senha-forte-1', name: 'Com Email', email: 'com.email@exemplo.com', workspaces: [boot.workspaces[0].id] })).status, 201);
  const c3 = await loginCookie('com.email', 'senha-forte-1');
  const outbox = [];
  app._test.setMailTransport({ sendMail: async (m) => { outbox.push(m); } });
  const tokenOf = (m) => (String(m.text).match(/confirmar-email\/([A-Za-z0-9_-]+)/) || [])[1];
  const tiny = 'data:text/plain;base64,' + Buffer.from('oi').toString('base64');
  try {
    let me = (await req('/api/me', { headers: { Cookie: c } })).body;
    assert.equal(me.emailVerified, false);
    assert.equal(me.emailRequired, true, 'prazo passou');
    const blocked = await call('POST', '/api/uploads', c, { name: 'a.txt', data: tiny });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'email_required');
    // Acesso restrito: nem leitura, só o necessário pra confirmar
    const bootBlocked = await req('/api/bootstrap', { headers: { Cookie: c } });
    assert.equal(bootBlocked.status, 403);
    assert.equal(bootBlocked.body.code, 'email_required');
    assert.equal((await req('/api/demands', { headers: { Cookie: c } })).status, 403);
    assert.equal((await call('PUT', '/api/me', c, { name: 'Outro nome' })).status, 403);
    assert.equal((await req('/api/me', { headers: { Cookie: c } })).status, 200);
    assert.equal((await call('POST', '/api/me/email', c, { email: 'sem.email@exemplo.com' })).status, 400, 'pede a senha');
    assert.equal((await call('POST', '/api/me/email', c, { email: 'sem.email@exemplo.com', password: 'errada' })).status, 400);
    assert.equal((await call('POST', '/api/me/email', c, { email: 'admin@exemplo.com', password: 'senha-forte-1' })).status, 409, 'e-mail de outra conta');
    let r = await call('POST', '/api/me/email', c, { email: 'Sem.Email@Exemplo.com', password: 'senha-forte-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.email, null, 'só muda depois do link');
    assert.equal(r.body.user.pendingEmail.email, 'sem.email@exemplo.com');
    assert.ok(!JSON.stringify(r.body).includes('tokenHash'));
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].to, 'sem.email@exemplo.com');
    const token = tokenOf(outbox[0]);
    assert.ok(token);
    const users = (await req('/api/users', { headers: { Cookie: admin } })).body;
    assert.ok(!JSON.stringify(users).includes('tokenHash'), 'lista de pessoas não vaza o pedido');
    // Confirmar (sem login) vincula; o link não vale duas vezes
    assert.equal((await postJson('/api/email/confirm', { token })).status, 200);
    assert.equal((await postJson('/api/email/confirm', { token })).status, 410);
    me = (await req('/api/me', { headers: { Cookie: c } })).body;
    assert.equal(me.email, 'sem.email@exemplo.com');
    assert.equal(me.emailVerified, true);
    assert.equal(me.emailRequired, false);
    assert.equal((await call('POST', '/api/uploads', c, { name: 'a.txt', data: tiny })).status, 200, 'volta a gravar');
    assert.equal((await req('/api/bootstrap', { headers: { Cookie: c } })).status, 200, 'e a ler');
    assert.equal((await call('PUT', '/api/me', c, { email: 'x@exemplo.com' })).status, 400, 'não troca digitando');
    await loginCookie('sem.email@exemplo.com', 'senha-forte-1');
    // Trocar: link pro novo e aviso pro antigo; cancelar invalida o link
    outbox.length = 0;
    r = await call('POST', '/api/me/email', c, { email: 'novo.email@exemplo.com', password: 'senha-forte-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await flushed();
    assert.deepEqual(outbox.map(m => m.to).sort(), ['novo.email@exemplo.com', 'sem.email@exemplo.com']);
    const t2 = tokenOf(outbox.find(m => m.to === 'novo.email@exemplo.com'));
    assert.equal((await call('POST', '/api/me/email/cancel', c, {})).body.user.pendingEmail, null);
    assert.equal((await postJson('/api/email/confirm', { token: t2 })).status, 410);
    assert.equal((await req('/api/me', { headers: { Cookie: c } })).body.email, 'sem.email@exemplo.com');
    // Confirmar o e-mail que já está na conta dispensa a senha
    outbox.length = 0;
    assert.equal((await call('POST', '/api/me/email', c3, { email: 'com.email@exemplo.com' })).status, 200);
    assert.equal((await postJson('/api/email/confirm', { token: tokenOf(outbox[0]) })).status, 200);
    assert.equal((await req('/api/me', { headers: { Cookie: c3 } })).body.emailVerified, true);
    // Admin não troca o e-mail de quem já tem
    const sem = users.find(u => u.username === 'sem.email');
    assert.equal((await call('PUT', '/api/users/' + sem.id, admin, { email: 'outro@exemplo.com' })).status, 403);
  } finally {
    app._test.setMailTransport(undefined);
  }
});

test('Duas etapas: código por e-mail obrigatório, app autenticador e recuperação', async () => {
  const outbox = [];
  app._test.setMailTransport({ sendMail: async (m) => { outbox.push(m); } });
  const codeOf = (m) => (String(m && m.text).match(/(\d{6})/) || [])[1];
  const lastCode = () => codeOf([...outbox].reverse().find(m => /código de acesso/i.test(m.subject)));
  const login = (username, password = 'senha-forte-1') => postJson('/api/login', { username, password });
  const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
  // Entra passando pelo código do e-mail
  async function loginWithCode(username, password) {
    const lg = await login(username, password);
    assert.equal(lg.status, 200, JSON.stringify(lg.body));
    assert.equal(lg.body.twoFactor && lg.body.twoFactor.method, 'email', 'e-mail confirmado = código obrigatório');
    const ok = await postJson('/api/login/2fa', { ticket: lg.body.twoFactor.ticket, code: lastCode() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    return cookieOf(ok);
  }
  try {
    // E-mail confirmado: o código por e-mail já vem ligado, sem ativar nada
    let lg = await login('sem.email');
    assert.equal(lg.body.twoFactor.method, 'email');
    assert.ok(!cookieOf(lg), 'sem sessão antes do código');
    assert.ok(!lg.body.user);
    const t1 = lg.body.twoFactor.ticket;
    const code = lastCode();
    assert.ok(code);
    assert.equal((await postJson('/api/login/2fa', { ticket: t1, code: code === '111111' ? '222222' : '111111' })).status, 400);
    let ok = await postJson('/api/login/2fa', { ticket: t1, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    let c = cookieOf(ok);
    assert.ok(c);
    assert.equal((await postJson('/api/login/2fa', { ticket: t1, code })).status, 410, 'o ticket vale uma vez');
    let me = (await req('/api/me', { headers: { Cookie: c } })).body;
    assert.equal(me.twoFactor.method, 'email');
    assert.equal(me.twoFactor.app, false);
    // Não dá pra desligar o código por e-mail nem "ativar" ele de novo
    assert.equal((await call('POST', '/api/me/2fa/disable', c, { password: 'senha-forte-1' })).status, 400);
    assert.equal((await call('POST', '/api/me/2fa/start', c, { method: 'email', password: 'senha-forte-1' })).status, 400);
    // App autenticador (opcional) substitui o e-mail
    assert.equal((await call('POST', '/api/me/2fa/start', c, { method: 'totp', password: 'errada' })).status, 400);
    let r = await call('POST', '/api/me/2fa/start', c, { method: 'totp', password: 'senha-forte-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.qr, /<svg/);
    const secret = r.body.secret.replace(/\s/g, '');
    assert.equal((await call('POST', '/api/me/2fa/confirm', c, { code: '000000' })).status, 400);
    const s0 = nowStep(); // fixa o passo: evita falhar na virada dos 30s
    r = await call('POST', '/api/me/2fa/confirm', c, { code: totpAt(secret, s0) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.recoveryCodes.length, 10);
    assert.equal(r.body.user.twoFactor.method, 'totp');
    assert.ok(!/secretEnc|"hash"/.test(JSON.stringify(r.body)), 'nada de segredo na resposta');
    const rc = r.body.recoveryCodes;
    // Login com o app (o código já usado no cadastro não vale de novo)
    outbox.length = 0;
    lg = await login('sem.email@exemplo.com');
    assert.equal(lg.body.twoFactor.method, 'totp');
    assert.equal(outbox.filter(m => /código de acesso/i.test(m.subject)).length, 0, 'com o app, não manda e-mail');
    assert.equal((await postJson('/api/login/2fa', { ticket: lg.body.twoFactor.ticket, code: totpAt(secret, s0) })).status, 400, 'código reusado');
    ok = await postJson('/api/login/2fa', { ticket: lg.body.twoFactor.ticket, code: totpAt(secret, s0 + 1) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Código de recuperação vale uma vez só
    lg = await login('sem.email');
    ok = await postJson('/api/login/2fa', { ticket: lg.body.twoFactor.ticket, code: rc[0], recovery: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.usedRecovery, true);
    assert.equal(ok.body.user.twoFactor.recoveryLeft, 9);
    lg = await login('sem.email');
    assert.equal((await postJson('/api/login/2fa', { ticket: lg.body.twoFactor.ticket, code: rc[0], recovery: true })).status, 400);
    // Admin tira o app de quem perdeu o celular: volta o código por e-mail
    const admin = await loginWithCode('admin', 'admin123');
    const sem = (await req('/api/users', { headers: { Cookie: admin } })).body.find(u => u.username === 'sem.email');
    assert.equal(sem.twoFactorMethod, 'totp');
    assert.ok(!JSON.stringify(sem).includes('secretEnc'));
    assert.equal((await call('POST', `/api/users/${sem.id}/2fa/reset`, admin, {})).status, 200);
    await loginWithCode('sem.email');
  } finally {
    app._test.setMailTransport(undefined);
  }
  // Sem envio de e-mail no servidor, fica só a senha (ninguém fica trancado)
  const plain = await login('sem.email');
  assert.ok(!plain.body.twoFactor);
  assert.ok(cookieOf(plain));
});

test('Planos: limites de pessoas e de armazenamento definidos no console', async () => {
  const put = (body) => call('PUT', `/api/console/orgs/${betaOrgId}/plan`, consoleCookie, body);
  // Nasce no Teste; os 14 dias começaram quando a dona aceitou o convite
  const beta = (await req('/api/console/orgs', { headers: { Cookie: consoleCookie } })).body.items.find(o => o.id === betaOrgId);
  assert.equal(beta.usage.plan.id, 'teste');
  assert.ok(beta.usage.plan.trialEndsAt);
  assert.equal(beta.usage.plan.trialDaysLeft, 14);
  assert.equal(beta.usage.plan.users, 5);
  // Beta tem 2 pessoas (Bia e o admin da WSI). Personalizado: 3 pessoas, ~1 MB.
  let r = await put({ planId: 'custom', users: 3, storageGb: 0.001 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.usage.plan.users, 3);
  assert.equal(r.body.usage.seats.members, 2);
  assert.equal((await put({ planId: 'custom', users: -1 })).status, 400);
  assert.equal((await put({ planId: 'ouro' })).status, 400);
  const ws = (await req('/api/bootstrap', { headers: { Cookie: betaCookie } })).body.workspaces[0].id;
  const i1 = await call('POST', '/api/invites', betaCookie, { email: 'terceira@beta.com', kind: 'equipe', workspaces: [ws] });
  assert.equal(i1.status, 201, JSON.stringify(i1.body));
  const i2 = await call('POST', '/api/invites', betaCookie, { email: 'quarta@beta.com', kind: 'equipe', workspaces: [ws] });
  assert.equal(i2.status, 403);
  assert.equal(i2.body.code, 'seat_limit');
  assert.match(i2.body.error, /limite de 3 pessoas/);
  assert.equal((await call('POST', '/api/users', betaCookie, { username: 'manual.beta', password: 'senha-forte-1', name: 'Manual', workspaces: [ws] })).status, 403, 'cadastro manual também conta');
  const org = (await req('/api/org', { headers: { Cookie: betaCookie } })).body;
  assert.equal(org.usage.seats.used, 3, '2 pessoas + 1 convite');
  assert.equal(org.usage.plan.name, 'Personalizado');
  // O limite baixou depois do convite: o aceite é barrado
  await put({ planId: 'custom', users: 2, storageGb: 0.001 });
  const pub = await req('/api/invites/public/' + i1.body.link.split('/convite/')[1]);
  assert.equal(pub.status, 403);
  assert.equal(pub.body.status, 'seat_limit');
  // Armazenamento: o 2º arquivo de 600 KB passa do limite
  const file = 'data:application/octet-stream;base64,' + Buffer.alloc(600 * 1024, 7).toString('base64');
  const up1 = await call('POST', '/api/uploads', betaCookie, { name: 'a.bin', data: file });
  assert.equal(up1.status, 200, JSON.stringify(up1.body));
  const up2 = await call('POST', '/api/uploads', betaCookie, { name: 'b.bin', data: file });
  assert.equal(up2.status, 507);
  assert.equal(up2.body.code, 'storage_limit');
  // Plano de catálogo usa os limites dele
  // Limite por arquivo (Personalizado com 1 MB por arquivo)
  await put({ planId: 'custom', fileMb: 1 });
  const big = 'data:application/octet-stream;base64,' + Buffer.alloc(1200 * 1024, 7).toString('base64');
  const up3 = await call('POST', '/api/uploads', betaCookie, { name: 'grande.bin', data: big });
  assert.equal(up3.status, 413);
  assert.equal(up3.body.code, 'file_limit');
  assert.equal((await call('POST', '/api/uploads', betaCookie, { name: 'b.bin', data: file })).status, 200);
  r = await put({ planId: 'agencia' });
  assert.equal(r.body.usage.plan.users, 30);
  assert.equal(r.body.usage.plan.storageGb, 30);
  assert.equal(r.body.usage.plan.fileMb, 100);
  assert.equal((await call('POST', '/api/uploads', betaCookie, { name: 'b.bin', data: file })).status, 200);
  const audit = (await req('/api/console/audit', { headers: { Cookie: consoleCookie } })).body.items;
  assert.ok(audit.some(e => e.action === 'org_plan_changed'));
});

test('Teste grátis vencido: a organização fica só para consulta', async () => {
  const put = (body) => call('PUT', `/api/console/orgs/${betaOrgId}/plan`, consoleCookie, body);
  let r = await put({ planId: 'teste', trialDays: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.usage.plan.readOnly, true);
  const me = (await req('/api/me', { headers: { Cookie: betaCookie } })).body;
  assert.equal(me.org.planInfo.readOnly, true);
  assert.equal((await req('/api/bootstrap', { headers: { Cookie: betaCookie } })).status, 200, 'lê normalmente');
  const w = await call('PUT', '/api/org', betaCookie, { name: 'Beta Nova' });
  assert.equal(w.status, 403);
  assert.equal(w.body.code, 'read_only');
  assert.equal((await call('POST', '/api/invites', betaCookie, { email: 'x@beta.com', kind: 'equipe' })).status, 403);
  assert.equal((await call('POST', '/api/me/ping', betaCookie, {})).status !== 403, true, 'o que é da própria pessoa continua');
  // Reabrir o teste por mais 3 dias libera de novo
  r = await put({ planId: 'teste', trialDays: 3 });
  assert.equal(r.body.usage.plan.readOnly, false);
  assert.equal(r.body.usage.plan.trialDaysLeft, 3);
  assert.equal((await call('PUT', '/api/org', betaCookie, { name: 'Beta' })).status, 200);
});

test('Organização excluída: some na hora, fica 30 dias, restaura e apaga de vez', async () => {
  const H = { headers: { Cookie: consoleCookie } };
  const wsi = (await req('/api/console/orgs', H)).body.items.find(o => o.name === 'WSI');
  assert.equal((await call('POST', `/api/console/orgs/${wsi.id}/delete`, consoleCookie, { confirm: 'WSI' })).status, 400, 'a principal não sai');
  assert.equal((await call('POST', `/api/console/orgs/${betaOrgId}/delete`, consoleCookie, { confirm: 'Outra' })).status, 400, 'nome errado');
  let r = await call('POST', `/api/console/orgs/${betaOrgId}/delete`, consoleCookie, { confirm: 'beta', reason: 'teste' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.daysLeft, 30);
  // Quem só está na Beta perde o acesso na hora
  assert.equal((await req('/api/me', { headers: { Cookie: betaCookie } })).status, 401);
  const lg = await postJson('/api/login', { username: 'bia.souza', password: 'senha-da-bia-1' });
  assert.equal(lg.status, 403);
  assert.match(lg.body.error, /não está mais disponível/);
  // Quem também está na WSI continua, só com a WSI
  const admin = await loginCookie('admin', 'admin123');
  assert.deepEqual((await req('/api/me', { headers: { Cookie: admin } })).body.orgs.map(o => o.name), ['WSI']);
  // Console: sai da lista, entra nas excluídas, backup disponível
  const list = (await req('/api/console/orgs', H)).body;
  assert.ok(!list.items.some(o => o.id === betaOrgId));
  assert.ok(list.deleted.some(o => o.id === betaOrgId && o.reason === 'teste'));
  const bk = await fetch(baseUrl + `/api/console/orgs/${betaOrgId}/export`, H);
  assert.equal(bk.status, 200);
  const data = await bk.json();
  assert.equal(data.organization.name, 'Beta');
  assert.ok(data.people.some(p => p.username === 'bia.souza'));
  // Restaurar devolve tudo
  assert.equal((await call('POST', `/api/console/orgs/${betaOrgId}/restore`, consoleCookie)).status, 200);
  await loginCookie('bia.souza', 'senha-da-bia-1');
  // Apagar de vez: só excluída, com o nome
  assert.equal((await call('DELETE', `/api/console/orgs/${betaOrgId}`, consoleCookie, { confirm: 'Beta' })).status, 404);
  await call('POST', `/api/console/orgs/${betaOrgId}/delete`, consoleCookie, { confirm: 'Beta' });
  assert.equal((await call('DELETE', `/api/console/orgs/${betaOrgId}`, consoleCookie, { confirm: 'x' })).status, 400);
  r = await call('DELETE', `/api/console/orgs/${betaOrgId}`, consoleCookie, { confirm: 'Beta' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.items > 0);
  assert.equal(r.body.accounts, 1, 'só a conta da Bia (o admin segue na WSI)');
  assert.equal((await postJson('/api/login', { username: 'bia.souza', password: 'senha-da-bia-1' })).status, 401, 'conta apagada');
  await loginCookie('admin', 'admin123');
  assert.equal((await req(`/api/console/orgs/${betaOrgId}`, H)).status, 404);
  await flushed();
  const left = await _cleanupPool.query("SELECT type FROM entities WHERE data->>'orgId' = $1 OR id = $1", [betaOrgId]);
  assert.deepEqual(left.rows.map(x => x.type), ['accessRequests'], 'da Beta só sobra o pedido da lista de espera (histórico)');
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
