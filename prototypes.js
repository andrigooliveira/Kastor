/* ───────────────────────────────────────────────────────────────
   reWork — Protótipos (sites estáticos pra aprovação)

   A equipe sobe uma pasta (HTML, CSS, JS, imagens, fontes) e o reWork a
   serve num link próprio: /p/<token>. O cliente abre no navegador, no
   celular ou no computador, sem conta e sem baixar nada.

   Segurança — o protótipo é HTML de terceiros servido no domínio do app:
     - Todo arquivo sai com `Content-Security-Policy: sandbox allow-scripts`
       (sem allow-same-origin): o navegador trata a página como outra
       origem. O JS dela roda, mas não lê a API nem usa a sessão de quem
       abre (o cookie é SameSite=Lax e não acompanha chamadas de lá).
       NUNCA sirva um arquivo daqui sem esse cabeçalho.
     - Formulários e chamadas de rede pra fora ficam bloqueados (página
       falsa não consegue coletar o que a pessoa digita).
     - Os arquivos vão pro disco com nome numérico (0, 1, 2…); o caminho
       original só existe no manifesto. Nada que o usuário digita vira
       caminho no servidor.
     - Só tipos de site entram (TYPES); nada de executável ou zip.

   Link externo: vale no máximo LINK_MAX_DAYS dias. Depois disso /p/<token>
   só abre pra quem está logado e tem acesso à equipe do protótipo. A faixa
   no topo da prévia diz até quando o link vale. Desativar o link troca o
   token (o endereço antigo deixa de existir).

   Disco: DATA_DIR/prototypes/<id>/<versão>/<n>. Cada envio é uma versão
   nova; ao terminar, a anterior é apagada. O peso conta no armazenamento
   do plano (orgUsage).
   ─────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MB = 1024 * 1024;
const LINK_MAX_DAYS = 7;
const MAX_FILES = 400;
const FILE_MAX = 25 * MB;
const PROJECT_MAX = 150 * MB;
const NAME_MAX = 80;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const KEY_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_MAX_PER_MIN = 40;

const TEXT = '; charset=utf-8';
const TYPES = {
  html: 'text/html' + TEXT, htm: 'text/html' + TEXT, css: 'text/css' + TEXT,
  js: 'text/javascript' + TEXT, mjs: 'text/javascript' + TEXT,
  json: 'application/json' + TEXT, map: 'application/json' + TEXT, webmanifest: 'application/manifest+json' + TEXT,
  txt: 'text/plain' + TEXT, vtt: 'text/vtt' + TEXT,
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf'
};
const extOf = (p) => (String(p).match(/\.([A-Za-z0-9]{1,12})$/) || [])[1]?.toLowerCase() || '';
const isHtml = (p) => /\.html?$/i.test(p);

/* Caminho relativo dentro do site ("css/style.css"). Só serve de chave no
   manifesto — nunca vira caminho no disco. */
function cleanPath(raw) {
  const parts = String(raw || '').normalize('NFC').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.length > 12) return null;
  for (const s of parts) {
    if (s === '..' || s[0] === '.' || s.length > 120 || /[\x00-\x1f<>:"|?*]/.test(s)) return null;
  }
  const rel = parts.join('/');
  return rel.length > 300 ? null : rel;
}

/* ── ZIP mínimo (sem dependência) ──
   Escreve um arquivo por vez na resposta: cabeçalho local + dados (deflate,
   ou sem compressão quando não compensa) e, no fim, o diretório central.
   Nomes em UTF-8 (bit 11). Sem zip64: um protótipo tem no máximo 150 MB. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) >>> 0 : (buf) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const deflateRaw = (buf) => new Promise((resolve, reject) => zlib.deflateRaw(buf, (err, out) => (err ? reject(err) : resolve(out))));
async function writeZip(out, entries, when) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = e.data.length ? await deflateRaw(e.data) : e.data;
    const method = packed.length < e.data.length ? 8 : 0;
    const body = method ? packed : e.data;
    const meta = Buffer.alloc(26);
    meta.writeUInt16LE(20, 0);            // versão pra extrair
    meta.writeUInt16LE(0x0800, 2);        // nomes em UTF-8
    meta.writeUInt16LE(method, 4);
    meta.writeUInt16LE(time, 6);
    meta.writeUInt16LE(date, 8);
    meta.writeUInt32LE(crc32(e.data), 10);
    meta.writeUInt32LE(body.length, 14);
    meta.writeUInt32LE(e.data.length, 18);
    meta.writeUInt16LE(name.length, 22);
    meta.writeUInt16LE(0, 24);            // sem campo extra
    const sig = Buffer.alloc(4); sig.writeUInt32LE(0x04034b50, 0);
    out.write(Buffer.concat([sig, meta, name, body]));
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);              // versão que criou
    meta.copy(cd, 6);                     // mesmos campos do cabeçalho local (até o tamanho do extra)
    cd.writeUInt32LE(offset, 42);         // comentário, disco e atributos ficam zerados
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  out.end(Buffer.concat([cdBuf, end]));
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
const FILE_CSP = `sandbox ${SANDBOX}; form-action 'none'; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'`;

module.exports = function setupPrototypes(app, deps) {
  const db = new Proxy({}, { get: (_, key) => deps.getDb()[key] });
  const { dataDir, saveEntity, removeEntity, uid, nowISO, requireAuth, blockFreelancer, canAccessWs, sessionUser, tenancy, orgPlan, storageLimitError, fmtBytes, clientIp, appBaseUrl } = deps;
  const rootDir = path.join(dataDir, 'prototypes');
  fs.mkdirSync(rootDir, { recursive: true });
  const list = () => db.prototypes || [];
  const protoDir = (p) => path.join(rootDir, p.id);
  const versionDir = (p, v) => path.join(protoDir(p), v || p.version);
  const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const newToken = () => crypto.randomBytes(16).toString('hex');

  /* ── Link externo ── */
  const linkActive = (p) => !!(p.version && p.link && Date.parse(p.link.expiresAt) > Date.now());
  const publicUrl = (req, p) => `${appBaseUrl(req)}/p/${p.token}`;

  /* Prévia interna (sem link externo): a moldura confere a sessão e entrega
     os arquivos por um caminho com chave temporária. Os arquivos em si não
     recebem o cookie (página isolada), então a chave vai na URL. A chave
     morre no restart do servidor; recarregar a prévia gera outra. */
  const KEY = crypto.randomBytes(32);
  const sign = (token, exp) => crypto.createHmac('sha256', KEY).update(`${token}.${exp}`).digest('hex').slice(0, 32);
  const makeKey = (token) => { const exp = (Date.now() + KEY_TTL_MS).toString(36); return `${exp}-${sign(token, exp)}`; };
  function keyValid(token, key) {
    const m = /^([0-9a-z]{6,12})-([a-f0-9]{32})$/.exec(String(key || ''));
    if (!m || parseInt(m[1], 36) < Date.now()) return false;
    return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(token, m[1])));
  }

  /* ── Formato de saída ── */
  function view(req, p) {
    const files = p.files || [];
    return {
      id: p.id, name: p.name, clientId: p.clientId || null, workspaceId: p.workspaceId,
      entry: p.entry || null, pages: files.filter(f => isHtml(f.path)).map(f => f.path),
      fileCount: files.length, bytes: p.bytes || 0, hasFiles: !!p.version,
      url: publicUrl(req, p),
      link: p.link ? { active: linkActive(p), expiresAt: p.link.expiresAt } : null,
      createdBy: p.createdBy || null, createdAt: p.createdAt, updatedAt: p.updatedAt
    };
  }

  /* ── App: equipe ── */
  const guard = [requireAuth, blockFreelancer];
  const mine = (req) => list().filter(p => p.orgId === req.org.id && canAccessWs(req.user, p.workspaceId));
  const findMine = (req) => mine(req).find(p => p.id === req.params.id) || null;
  const notFound = (res) => res.status(404).json({ error: 'Protótipo não encontrado.' });
  function readMeta(req, b, current) {
    const name = String(b.name ?? current?.name ?? '').trim().slice(0, NAME_MAX);
    if (name.length < 2) return { error: 'Dê um nome ao protótipo.', field: 'name' };
    let clientId = b.clientId === undefined ? (current?.clientId || null) : (b.clientId || null);
    if (clientId && !(db.clients || []).some(c => c.id === clientId && !c.deletedAt && tenancy.orgOf('clients', c) === req.org.id)) clientId = null;
    return { name, clientId };
  }

  app.get('/api/prototypes', guard, (req, res) => {
    res.json({
      items: mine(req).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(p => view(req, p)),
      limits: { linkMaxDays: LINK_MAX_DAYS, maxFiles: MAX_FILES, fileBytes: Math.min(FILE_MAX, orgPlan(req.org).fileBytes), projectBytes: PROJECT_MAX, types: Object.keys(TYPES) },
      canShare: !orgPlan(req.org).trial
    });
  });

  app.post('/api/prototypes', guard, (req, res) => {
    const b = req.body || {};
    const meta = readMeta(req, b);
    if (meta.error) return res.status(400).json(meta);
    const workspaceId = String(b.workspaceId || '');
    if (!canAccessWs(req.user, workspaceId)) return res.status(400).json({ error: 'Escolha a equipe do protótipo.', field: 'workspaceId' });
    const now = nowISO();
    const p = {
      id: uid(), orgId: req.org.id, workspaceId, name: meta.name, clientId: meta.clientId,
      token: newToken(), version: null, entry: null, files: [], bytes: 0, link: null,
      createdBy: req.user.id, createdAt: now, updatedAt: now
    };
    db.prototypes.push(p);
    saveEntity('prototypes', p);
    res.status(201).json(view(req, p));
  });

  app.put('/api/prototypes/:id', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    const b = req.body || {};
    const meta = readMeta(req, b, p);
    if (meta.error) return res.status(400).json(meta);
    if (b.entry !== undefined) {
      const f = (p.files || []).find(x => x.path === b.entry && isHtml(x.path));
      if (!f) return res.status(400).json({ error: 'Página inicial inválida.', field: 'entry' });
      p.entry = f.path;
    }
    // Trocar de equipe: só pra uma em que a pessoa também tem acesso.
    if (b.workspaceId !== undefined && b.workspaceId !== p.workspaceId) {
      const workspaceId = String(b.workspaceId || '');
      if (!canAccessWs(req.user, workspaceId)) return res.status(400).json({ error: 'Escolha uma equipe em que você tem acesso.', field: 'workspaceId' });
      p.workspaceId = workspaceId;
    }
    p.name = meta.name; p.clientId = meta.clientId; p.updatedAt = nowISO();
    saveEntity('prototypes', p);
    res.json(view(req, p));
  });

  app.delete('/api/prototypes/:id', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    dropUploadsOf(p.id);
    rmDir(protoDir(p));
    const i = db.prototypes.indexOf(p);
    if (i >= 0) db.prototypes.splice(i, 1);
    removeEntity('prototypes', p.id);
    indexCache.delete(p.id);
    res.json({ deleted: true });
  });

  /* ── Envio dos arquivos: start → file (um por chamada) → finish ──
     O navegador lê a pasta (ou abre o zip) e manda arquivo por arquivo. Os
     arquivos caem numa pasta de versão nova; só no finish ela passa a valer. */
  const uploads = new Map(); // uploadId → { protoId, userId, dir, files, bytes, at }
  function dropUpload(id) {
    const u = uploads.get(id);
    if (!u) return;
    uploads.delete(id);
    rmDir(u.dir);
  }
  function dropUploadsOf(protoId) { for (const [id, u] of uploads) if (u.protoId === protoId) dropUpload(id); }
  function findUpload(req, p) {
    const u = uploads.get(String(req.params.uploadId || ''));
    return u && u.protoId === p.id && u.userId === req.user.id ? u : null;
  }

  app.post('/api/prototypes/:id/upload', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    for (const [id, u] of uploads) if (Date.now() - u.at > UPLOAD_TTL_MS) dropUpload(id);
    dropUploadsOf(p.id);
    const uploadId = crypto.randomBytes(8).toString('hex');
    const dir = versionDir(p, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    uploads.set(uploadId, { protoId: p.id, userId: req.user.id, dir, files: [], bytes: 0, at: Date.now() });
    res.status(201).json({ uploadId });
  });

  app.post('/api/prototypes/:id/upload/:uploadId/file', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    const u = findUpload(req, p);
    if (!u) return res.status(410).json({ error: 'Este envio expirou. Comece de novo.' });
    const b = req.body || {};
    const rel = cleanPath(b.path);
    if (!rel) return res.status(400).json({ error: `Nome de arquivo inválido: ${String(b.path || '').slice(0, 80)}` });
    if (!TYPES[extOf(rel)]) return res.status(400).json({ error: `Tipo de arquivo não aceito num protótipo: ${rel}`, code: 'type' });
    if (u.files.some(f => f.path === rel)) return res.status(400).json({ error: `Arquivo repetido: ${rel}` });
    if (u.files.length >= MAX_FILES) return res.status(400).json({ error: `Um protótipo pode ter até ${MAX_FILES} arquivos.`, code: 'count' });
    const buf = Buffer.from(String(b.data || '').replace(/^data:[^,]*,/, ''), 'base64');
    const fileMax = Math.min(FILE_MAX, orgPlan(req.org).fileBytes);
    if (buf.length > fileMax) return res.status(413).json({ error: `${rel} tem ${fmtBytes(buf.length)}. O limite por arquivo é ${fmtBytes(fileMax)}.`, code: 'file_limit' });
    if (u.bytes + buf.length > PROJECT_MAX) return res.status(413).json({ error: `Um protótipo pode ter até ${fmtBytes(PROJECT_MAX)} no total.`, code: 'project_limit' });
    const full = storageLimitError(req.org, u.bytes + buf.length);
    if (full) return res.status(507).json({ error: full, code: 'storage_limit' });
    const n = u.files.length;
    fs.writeFileSync(path.join(u.dir, String(n)), buf);
    u.files.push({ path: rel, size: buf.length, n });
    u.bytes += buf.length;
    u.at = Date.now();
    res.json({ files: u.files.length, bytes: u.bytes });
  });

  app.post('/api/prototypes/:id/upload/:uploadId/finish', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    const u = findUpload(req, p);
    if (!u) return res.status(410).json({ error: 'Este envio expirou. Comece de novo.' });
    const pages = u.files.filter(f => isHtml(f.path)).map(f => f.path);
    if (!pages.length) { dropUpload(req.params.uploadId); return res.status(400).json({ error: 'A pasta precisa ter pelo menos um arquivo .html.', code: 'no_html' }); }
    // Página inicial: a mesma de antes, se continuar existindo; senão o
    // index.html da raiz; senão o .html mais perto da raiz.
    const depth = (x) => x.split('/').length;
    const entry = (p.entry && pages.includes(p.entry) && p.entry)
      || pages.find(x => /^index\.html?$/i.test(x))
      || pages.slice().sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
    const old = p.version;
    uploads.delete(req.params.uploadId);
    p.version = req.params.uploadId; p.files = u.files; p.bytes = u.bytes; p.entry = entry; p.updatedAt = nowISO();
    saveEntity('prototypes', p);
    if (old) rmDir(versionDir(p, old));
    indexCache.delete(p.id);
    res.json(view(req, p));
  });

  /* Baixar os arquivos: um arquivo só sai como ele é; mais de um, num .zip
     com a pasta do site dentro (dá pra subir o mesmo zip de volta). */
  app.get('/api/prototypes/:id/download', guard, async (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    const files = p.files || [];
    if (!p.version || !files.length) return res.status(404).json({ error: 'Este protótipo ainda não tem arquivos.' });
    const slug = String(p.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'prototipo';
    const dir = versionDir(p);
    const attach = (name, type) => {
      res.set('Content-Type', type);
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', 'sandbox');
      res.set('Cache-Control', 'private, no-store');
    };
    try {
      if (files.length === 1) {
        attach(`${slug}.${extOf(files[0].path) || 'html'}`, 'application/octet-stream');
        return res.send(await fs.promises.readFile(path.join(dir, String(files[0].n))));
      }
      const entries = [];
      for (const f of files) entries.push({ name: `${slug}/${f.path}`, data: await fs.promises.readFile(path.join(dir, String(f.n))) });
      attach(`${slug}.zip`, 'application/zip');
      await writeZip(res, entries, new Date(p.updatedAt || Date.now()));
    } catch (e) {
      console.error('[prototypes] download:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Não foi possível montar o download.' });
      else res.destroy();
    }
  });

  /* Gera ou renova o link externo (no máximo LINK_MAX_DAYS dias). */
  app.post('/api/prototypes/:id/link', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    if (!p.version) return res.status(400).json({ error: 'Envie os arquivos antes de gerar o link.' });
    if (orgPlan(req.org).trial) return res.status(403).json({ error: 'No período de teste o protótipo abre só para quem está logado no reWork. O link externo entra junto com um plano.', code: 'plan' });
    const days = Math.min(LINK_MAX_DAYS, Math.max(1, Math.floor(Number((req.body || {}).days)) || LINK_MAX_DAYS));
    const now = Date.now();
    p.link = { expiresAt: new Date(now + days * 864e5).toISOString(), createdAt: new Date(now).toISOString(), createdBy: req.user.id };
    p.updatedAt = nowISO();
    saveEntity('prototypes', p);
    res.json(view(req, p));
  });

  /* Desativa o link e troca o token: o endereço antigo deixa de existir. */
  app.delete('/api/prototypes/:id/link', guard, (req, res) => {
    const p = findMine(req);
    if (!p) return notFound(res);
    p.link = null; p.token = newToken(); p.updatedAt = nowISO();
    saveEntity('prototypes', p);
    res.json(view(req, p));
  });

  /* ── Prévia: /p/<token> (moldura) e /p/<token>/(f|i/<chave>)/<arquivo> ── */
  const misses = new Map(); // ip → { count, resetAt } — só conta token que não existe
  function byToken(req, res) {
    const token = req.params[0];
    const p = list().find(x => x.token === token && tenancy.orgActive(x.orgId));
    if (p) return p;
    const ip = clientIp(req), now = Date.now();
    let rec = misses.get(ip);
    if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 60000 };
    rec.count++;
    misses.set(ip, rec);
    if (misses.size > 5000) for (const [k, v] of misses) if (now > v.resetAt) misses.delete(k);
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (rec.count > MISS_MAX_PER_MIN) { res.status(429).type('text/plain; charset=utf-8').send('Muitas tentativas. Aguarde um minuto.'); return null; }
    messagePage(res, 404, 'Link não encontrado', 'Confira o endereço ou peça um link novo para quem te enviou.');
    return null;
  }
  function canView(req, p) {
    const user = sessionUser(req);
    return !!user && tenancy.run(p.orgId, () => !user.isFreelancer && canAccessWs(user, p.workspaceId));
  }

  const PAGE_CSS = `*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f0f12;color:#f4f4f6;display:flex;flex-direction:column;height:100dvh}
.bar{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;padding:8px max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left));padding-top:max(8px,env(safe-area-inset-top));background:#17171c;border-bottom:1px solid #2a2a33;font-size:13px}
.bar b{font-weight:600}.bar .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 140px}
.bar .tag{color:#a5a5b4}.bar .exp{display:inline-flex;align-items:center;gap:6px;color:#f4f4f6;white-space:nowrap}
.bar .exp.is-off{color:#fbbf24}.bar svg{width:14px;height:14px;flex:none}
iframe{flex:1;width:100%;border:0;background:#fff}
.msg{margin:auto;padding:32px 24px;max-width:420px;text-align:center}.msg h1{font-size:20px;margin:0 0 8px}.msg p{margin:0;color:#a5a5b4}`;
  const CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
  function pageHead(res, status, title, extraCsp) {
    const nonce = crypto.randomBytes(12).toString('base64');
    res.status(status);
    res.set('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'${extraCsp || ''}`);
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    res.type('html');
    return { nonce, head: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>${escHtml(title)}</title><link rel="icon" href="/favicon.png"><style nonce="${nonce}">${PAGE_CSS}</style></head>` };
  }
  function messagePage(res, status, title, text) {
    const { head } = pageHead(res, status, title);
    res.send(`${head}<body><div class="msg"><h1>${escHtml(title)}</h1><p>${escHtml(text)}</p></div></body></html>`);
  }
  // Data no fuso de Brasília; o navegador troca pelo fuso de quem abre.
  const whenFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function whenText(iso) {
    const parts = Object.fromEntries(whenFmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return `dia ${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
  }

  app.get(/^\/p\/([a-f0-9]{32})\/?$/, (req, res) => {
    const p = byToken(req, res);
    if (!p) return;
    const active = linkActive(p);
    if (!active && !canView(req, p)) {
      return messagePage(res, 410, 'Este link expirou', 'O prazo para ver este protótipo acabou. Peça um link novo para quem te enviou.');
    }
    if (!p.version) return messagePage(res, 404, 'Protótipo sem arquivos', 'Envie os arquivos pelo reWork para ver a prévia.');
    const entry = p.entry.split('/').map(encodeURIComponent).join('/');
    const src = active ? `/p/${p.token}/f/${entry}` : `/p/${p.token}/i/${makeKey(p.token)}/${entry}`;
    const exp = active ? p.link.expiresAt : null;
    const status = active
      ? `<span class="exp">${CLOCK}<span>Este link expira <span id="when">${whenText(exp)}</span></span></span>`
      : `<span class="exp is-off">${CLOCK}<span>${p.link ? 'O link externo expirou' : 'Sem link externo'}. Só a equipe vê esta prévia.</span></span>`;
    const { nonce, head } = pageHead(res, 200, `${p.name} · Prévia`, "; frame-src 'self'");
    const script = exp ? `<script nonce="${nonce}">(function(){var e=new Date(${JSON.stringify(exp)}),w=document.getElementById('when'),p=function(n){return String(n).padStart(2,'0')};if(w)w.textContent='dia '+p(e.getDate())+'/'+p(e.getMonth()+1)+' às '+p(e.getHours())+':'+p(e.getMinutes());var ms=e-Date.now();setTimeout(function(){location.reload()},Math.max(1000,Math.min(ms+1000,2147000000)))})();</script>` : '';
    res.send(`${head}<body><div class="bar"><span class="name"><span class="tag">Prévia · </span><b>${escHtml(p.name)}</b></span>${status}</div><iframe src="${escHtml(src)}" sandbox="${SANDBOX}" referrerpolicy="no-referrer" title="${escHtml(p.name)}"></iframe>${script}</body></html>`);
  });

  /* Manifesto indexado por caminho (exato e sem diferenciar maiúsculas: site
     feito no Windows costuma errar a caixa e funcionar lá). */
  const indexCache = new Map(); // id → { version, exact, lower }
  function fileIndex(p) {
    let c = indexCache.get(p.id);
    if (!c || c.version !== p.version) {
      c = { version: p.version, exact: new Map(), lower: new Map() };
      for (const f of p.files || []) { c.exact.set(f.path, f); c.lower.set(f.path.toLowerCase(), f); }
      indexCache.set(p.id, c);
    }
    return c;
  }
  const lookup = (p, rel) => { const c = fileIndex(p); return c.exact.get(rel) || c.lower.get(rel.toLowerCase()) || null; };
  function sendFile(req, res, p, rest) {
    // O sandbox vale pra TODA resposta daqui, inclusive erro.
    res.set('Content-Security-Policy', FILE_CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Access-Control-Allow-Origin', '*'); // página isolada: fontes e módulos JS pedem CORS
    res.set('Cache-Control', 'private, no-cache');
    const miss = () => res.status(404).type('text/plain; charset=utf-8').send('Arquivo não encontrado');
    if (!p.version) return miss();
    let rel = String(rest || '').normalize('NFC').replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let f = lookup(p, rel);
    if (!f && lookup(p, rel + '/index.html')) return res.redirect(302, req.path + '/');
    if (!f && !extOf(rel)) f = lookup(p, rel + '.html');
    if (!f || !/^\d+$/.test(String(f.n))) return miss();
    res.set('Content-Type', TYPES[extOf(f.path)] || 'application/octet-stream');
    res.sendFile(String(f.n), { root: versionDir(p), cacheControl: false, dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) miss(); });
  }

  /* Preflight: pra página isolada, a própria pasta é "outra origem". Um fetch
     com cabeçalho extra (ou um antivírus que embrulha o fetch) pergunta antes. */
  app.options(/^\/p\/[a-f0-9]{32}\/(?:f|i\/[0-9a-z-]{20,60})\/.*$/, (req, res) => {
    res.set('Content-Security-Policy', FILE_CSP);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD');
    res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.set('Access-Control-Max-Age', '600');
    res.status(204).end();
  });

  app.get(/^\/p\/([a-f0-9]{32})\/f\/(.*)$/, (req, res) => {
    const p = byToken(req, res);
    if (!p) return;
    if (!linkActive(p)) { res.set('Content-Security-Policy', FILE_CSP); return res.status(410).type('text/plain; charset=utf-8').send('Este link expirou.'); }
    sendFile(req, res, p, req.params[1]);
  });
  app.get(/^\/p\/([a-f0-9]{32})\/i\/([0-9a-z-]{20,60})\/(.*)$/, (req, res) => {
    const p = byToken(req, res);
    if (!p) return;
    if (!keyValid(p.token, req.params[1])) { res.set('Content-Security-Policy', FILE_CSP); return res.status(410).type('text/plain; charset=utf-8').send('Prévia expirada. Recarregue a página.'); }
    sendFile(req, res, p, req.params[2]);
  });

  /* ── Pro resto do servidor ── */
  // Boot: apaga envio que ficou pela metade (servidor reiniciou no meio). Só
  // mexe em protótipo que existe no banco; pasta desconhecida fica onde está.
  function cleanOrphans() {
    for (const p of list()) {
      let versions = [];
      try { versions = fs.readdirSync(protoDir(p)); } catch { continue; }
      for (const v of versions) if (v !== p.version && !uploads.has(v)) rmDir(versionDir(p, v));
    }
  }
  function orgUsage(orgId) {
    let bytes = 0, files = 0;
    for (const p of list()) if (p.orgId === orgId) { bytes += p.bytes || 0; files += (p.files || []).length; }
    return { bytes, files };
  }
  // Exclusão definitiva da organização: as entidades saem pelo purgeOrg; aqui vão os arquivos.
  function purgeOrg(orgId) {
    for (const p of list()) if (p.orgId === orgId) { dropUploadsOf(p.id); rmDir(protoDir(p)); indexCache.delete(p.id); }
  }
  return { orgUsage, purgeOrg, cleanOrphans, LINK_MAX_DAYS };
};
