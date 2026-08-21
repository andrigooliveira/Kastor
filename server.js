/* ───────────────────────────────────────────────────────────────
   reWork — Gestão de Demandas de Marketing  ·  Backend (v3)
   Node.js + Express + banco em arquivo (data/db.json)
   Credenciais ficam num arquivo criptografado separado (auth.enc).

   Novidades desta versão:
   • Workspaces (squads) com acesso por usuário
   • Fluxos vinculados a projeto (exclusivos) + duplicação
   • Etapas com responsável, prazo em dias e cor
   • Prazo da etapa começa a contar quando a demanda avança
   • Apontamento de horas por etapa/usuário
   • Comentários com menção (@usuário)
   ─────────────────────────────────────────────────────────────── */

// Node 22.5+ tem loadEnvFile nativo — carrega .env se existir. Ignora silenciosamente
// se o arquivo não estiver lá (ex: prod usa env vars diretamente do Docker/Portainer).
try {
  process.loadEnvFile('.env');
  console.log('[env] .env carregado');
} catch {
  console.log('[env] .env não encontrado (usando variáveis do sistema)');
}

const express    = require('express');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const nodemailer = require('nodemailer');
const auth       = require('./secure-store');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { createStore, ENTITY_TYPES } = require('./db-store');
const googleCal  = require('./google-cal');

const PORT    = process.env.PORT || 3000;
// KASTOR_DATA_DIR sobrescreve o diretório de uploads e do auth.enc.
// (O banco de dados agora fica no PostgreSQL — ver DATABASE_URL.)
const DATA_DIR = process.env.KASTOR_DATA_DIR || path.join(__dirname, 'data');

/* ─── BANCO ─── Persistência via PostgreSQL (driver `pg`).
   O objeto `db` em memória continua sendo a fonte de leitura/escrita do código.
   A cada mutação, markDirty()/scheduleFlush() fazem upsert incremental no
   Postgres (escreve só o que mudou via dirty-tracking, batched em transação).

   Configuração:
     - DATABASE_URL=postgres://user:pass@host:port/db
     - Alternativa: variáveis PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT. */
const store = createStore();
let db = null;
let _dirtyEntities = new Map(); // key: `${type}|${id}` → { type, entity|id, op: 'upsert'|'remove' }

function defaultDB() {
  const obj = { notifications: [] };
  for (const t of ENTITY_TYPES) obj[t] = [];
  return obj;
}

/* Flag "primeira instalação concluída" — impede que qualquer seed inicial
   (workspace "Geral", admin, fluxo padrão) recrie após o usuário ter modificado
   ou deletado o inicial. Setada uma vez, no fim do primeiro boot. */
async function isFirstInstall() { return !(await store.getKv('install:completed')); }
async function markInstallComplete() { await store.setKv('install:completed', new Date().toISOString()); }

/* ─── SOFT DELETE (com undo em ~10s no cliente + Lixeira de 30 dias) ───
   Marca a entidade com deletedAt em vez de remover. Listagens filtram out.
   O item fica recuperável na Lixeira (GET /api/trash) até `PurgeJob` removê-lo
   definitivamente após UNDO_PURGE_MS. Retenção de 30 dias: janela confortável
   pra desfazer sem lotar o banco com lixo antigo.
   Aplicado só em clients/projects/demands por enquanto — ações destrutivas
   que o usuário mais reclama de "sem querer". */
const UNDO_PURGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
function notDeleted(e) { return !e || !e.deletedAt; }
function softDelete(type, entity, userId) {
  entity.deletedAt = nowISO();
  entity.deletedBy = userId || null;
  saveEntity(type, entity);
}
function undelete(type, entity) {
  delete entity.deletedAt;
  delete entity.deletedBy;
  saveEntity(type, entity);
}
function runSoftDeletePurge() {
  const cutoff = Date.now() - UNDO_PURGE_MS;
  let purged = 0;
  for (const type of ['clients', 'projects', 'demands', 'flows', 'listas', 'clientTemplates', 'recurrings', 'tasks']) {
    const arr = db[type] || [];
    const toRemove = arr.filter(e => e.deletedAt && Date.parse(e.deletedAt) < cutoff);
    for (const e of toRemove) {
      removeEntity(type, e.id);
      purged++;
    }
    if (toRemove.length) {
      db[type] = arr.filter(e => !e.deletedAt || Date.parse(e.deletedAt) >= cutoff);
    }
  }
  if (purged > 0) console.log(`  [soft-delete-purge] ${purged} entidade(s) removida(s) definitivamente após ${UNDO_PURGE_MS / 86400000}d`);
}

async function loadDB() {
  // Cria schema (idempotente) — CREATE TABLE IF NOT EXISTS.
  await store.init();
  // Carrega cache em memória a partir do Postgres.
  db = await store.loadAllToCache();
  for (const t of ENTITY_TYPES) if (!Array.isArray(db[t])) db[t] = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];
  auth.load();
  const firstInstall = await isFirstInstall();
  migrate(firstInstall);
  seed(firstInstall);
  await markInstallComplete(); // idempotente — grava a flag no primeiro boot com esse código
  // Extrai anexos/avatares base64 que ainda estejam dentro das entidades
  // pra arquivos em data/uploads. Idempotente — não toca quem já está em URL.
  extractInlineBase64();
  await seedDemandTypes(); // popula a biblioteca de tipos a partir dos fluxos (1x)
  // Migração de folders legados do cofre — cria entidades a partir do campo
  // string `folder` que existia antes. Idempotente.
  try { _migrateLegacyPasswordFolders(); } catch (e) { console.warn('migrateLegacyPasswordFolders:', e.message); }
  await flushDirty(); // garante que entidades criadas no seed/migrate sejam persistidas
}

/* Semeia a biblioteca de tipos de demanda a partir dos tipos já usados nos fluxos.
   Roda só na 1ª vez (kv flag) — depois a lista é gerenciada manualmente, então
   tipos excluídos não voltam a ser re-semeados. */
async function seedDemandTypes() {
  if (await store.getKv('demandTypes:seeded')) return;
  if (!Array.isArray(db.demandTypes)) db.demandTypes = [];
  const existing = new Set(db.demandTypes.map(t => (t.name || '').toLowerCase()));
  const distinct = [...new Set((db.flows || []).map(f => String(f.demandType || '').trim()).filter(Boolean))];
  let added = 0;
  for (const name of distinct) {
    if (existing.has(name.toLowerCase())) continue;
    const t = { id: uid(), name, createdAt: nowISO() };
    db.demandTypes.push(t);
    saveEntity('demandTypes', t);
    existing.add(name.toLowerCase());
    added++;
  }
  await store.setKv('demandTypes:seeded', new Date().toISOString());
  if (added) console.log(`  [demand-types] ${added} tipo(s) semeado(s) a partir dos fluxos`);
}

/* Pós-migração: percorre entidades em memória, extrai data: URIs pra disco
   e troca pelo /uploads/<file>. Marca entidades alteradas como sujas.
   Chamado uma vez no boot — futuras escritas já chegam normalizadas. */
function extractInlineBase64() {
  let extracted = 0;
  const tryExtract = (parentName, owner, fieldName) => {
    const v = owner[fieldName];
    if (typeof v === 'string' && v.startsWith('data:')) {
      const saved = saveUploadFromDataUri(v, parentName);
      if (saved) { owner[fieldName] = saved.url; extracted++; return true; }
    }
    return false;
  };
  for (const u of (db.users || [])) {
    if (tryExtract(u.username + '-avatar', u, 'avatar')) markDirty('users', u);
  }
  for (const p of (db.projects || [])) {
    if (tryExtract(p.name + '-avatar', p, 'avatar')) markDirty('projects', p);
  }
  for (const d of (db.demands || [])) {
    let touched = false;
    for (const a of (d.attachments || [])) {
      if (tryExtract(d.name + '-' + a.name, a, 'data')) touched = true;
    }
    for (const c of (d.comments || [])) {
      for (const a of (c.attachments || [])) {
        if (typeof a.data === 'string' && a.data.startsWith('data:')) {
          const saved = saveUploadFromDataUri(a.data, a.name);
          if (saved) { a.data = saved.url; touched = true; extracted++; }
        }
      }
    }
    if (touched) markDirty('demands', d);
  }
  if (extracted > 0) console.log(`› Anexos extraídos pra disco: ${extracted}`);
}

/* Marca uma entidade como "suja" pra ser persistida no próximo flush.
   Hot paths podem chamar saveEntity diretamente pra ganhar latência. */
function markDirty(type, entityOrId, op = 'upsert') {
  const id = (op === 'remove') ? entityOrId : (entityOrId && entityOrId.id);
  if (!id) return;
  _dirtyEntities.set(`${type}|${id}`, { type, op, entity: op === 'upsert' ? entityOrId : null, id });
}
function saveEntity(type, entity)   { markDirty(type, entity, 'upsert'); scheduleFlush(); }
function removeEntity(type, id)     { markDirty(type, id, 'remove'); scheduleFlush(); }

let saveTimer = null;
function scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushDirty(); }, 30);
  if (saveTimer.unref) saveTimer.unref();
}
async function flushDirty() {
  if (_dirtyEntities.size === 0) return;
  const items = [..._dirtyEntities.values()];
  _dirtyEntities.clear();
  try {
    await store.applyBatch(items);
  } catch (e) {
    console.error('flushDirty falhou:', e.message);
    // Re-enqueue pra tentar de novo no próximo flush em vez de perder writes.
    // Se um item novo já veio pra mesma key nesse meio tempo, prevalece o novo.
    for (const it of items) {
      const key = `${it.type}|${it.entity?.id || it.id}`;
      if (!_dirtyEntities.has(key)) _dirtyEntities.set(key, it);
    }
  }
}

/* COMPAT: saveDB() era usado em todo lugar. Agora marca TODAS as entidades
   como sujas e flusha. Em hot paths, prefira saveEntity(type, e) — escreve
   só o que mudou. saveDB continua funcionando enquanto o código migra. */
function saveDB() {
  for (const t of ENTITY_TYPES) {
    for (const e of (db[t] || [])) markDirty(t, e, 'upsert');
  }
  scheduleFlush();
}

function uid() { return crypto.randomBytes(6).toString('hex'); }
function nowISO() { return new Date().toISOString(); }
// USA DATA LOCAL do server (setar TZ env pra alinhar com o time). ISO/UTC dava
// off-by-one à noite (Brasil UTC-3 às 22h já é dia+1 em UTC).
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _ymdOf(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(ymd, days) {
  const base = ymd ? new Date(ymd + 'T12:00:00') : new Date();
  base.setDate(base.getDate() + (Number(days) || 0));
  const dow = base.getDay();
  if (dow === 6) base.setDate(base.getDate() + 2); // sáb → seg
  if (dow === 0) base.setDate(base.getDate() + 1); // dom → seg
  return _ymdOf(base);
}

/* ─── MIGRAÇÃO de bases antigas ─── */
function migrate(firstInstall) {
  // Workspace padrão "Geral" — SÓ na primeira instalação. Depois, se o usuário
  // renomear ou deletar, ele NÃO volta no próximo boot.
  if (firstInstall && db.workspaces.length === 0) {
    db.workspaces.push({ id: uid(), name: 'Geral', color: '#7A00FF', createdAt: nowISO() });
  }
  const defWs = db.workspaces[0]?.id;

  db.users.forEach(u => {
    // Move senhas antigas (embutidas no usuário) para o cofre criptografado
    if (u.passHash && u.salt && !auth.hasPassword(u.id)) {
      auth._store().credentials[u.id] = { salt: u.salt, hash: u.passHash };
      auth.save();
    }
    delete u.passHash; delete u.salt;
    if (!Array.isArray(u.workspaces)) u.workspaces = db.workspaces.map(w => w.id);
  });
  // Tokens antigos que viviam no db.json
  if (Array.isArray(db.tokens)) {
    db.tokens.forEach(t => { if (t && t.token) auth._store().tokens.push(t); });
    auth.save();
    delete db.tokens;
  }

  if (!Array.isArray(db.clients)) db.clients = [];
  if (!Array.isArray(db.schedules)) db.schedules = [];
  if (!Array.isArray(db.clientTemplates)) db.clientTemplates = [];
  if (!Array.isArray(db.recurrings)) db.recurrings = [];
  if (!Array.isArray(db.listas)) db.listas = [];
  // tasks: itens de listas aplicadas a projetos (modelo novo, kind='todo').
  // Coexiste com recurrings antigos (listas sem kind continuam gerando recurrings).
  if (!Array.isArray(db.tasks)) db.tasks = [];
  db.projects.forEach(p => { if (!p.workspaceId) p.workspaceId = defWs; });

  // Migração: promover `project.client` (string) → entidade Client.
  // Cria 1 Client por valor único (workspaceId + nome case-insensitive).
  // Projetos sem cliente recebem um cliente fallback "Sem cliente" do workspace.
  const ensureClient = (wsId, name) => {
    const key = (name || '').trim();
    const lookup = key.toLowerCase() || '__sem_cliente__';
    let c = db.clients.find(x => x.workspaceId === wsId && (x.name || '').trim().toLowerCase() === lookup);
    if (c) return c;
    const isPlaceholder = !key;
    c = {
      id: uid(),
      workspaceId: wsId,
      name: isPlaceholder ? 'Sem cliente' : key,
      color: '#7A00FF',
      avatar: null,
      segment: '',
      driveFiles: '',
      brandAssets: '',
      guidelines: '',
      active: true,
      placeholder: isPlaceholder, // marcador interno do "Sem cliente" auto-gerado
      createdAt: nowISO()
    };
    db.clients.push(c);
    markDirty('clients', c, 'upsert');
    return c;
  };
  db.projects.forEach(p => {
    if (p.clientId) return; // já migrado
    const c = ensureClient(p.workspaceId, p.client);
    p.clientId = c.id;
    // Mantém o campo `client` (string) por compat — código antigo pode usar
    markDirty('projects', p, 'upsert');
  });
  db.flows.forEach(f => {
    if (f.clientId) return; // já migrado
    if (!f.client && !f.projectId) return; // fluxo "Geral" — sem cliente mesmo
    // Tenta resolver via projectId primeiro, depois via string client
    let c = null;
    if (f.projectId) {
      const proj = db.projects.find(p => p.id === f.projectId);
      if (proj?.clientId) c = db.clients.find(x => x.id === proj.clientId);
    }
    if (!c && f.client) c = ensureClient(f.workspaceId, f.client);
    if (c) {
      f.clientId = c.id;
      markDirty('flows', f, 'upsert');
    }
  });

  db.flows.forEach(f => {
    if (!f.workspaceId) f.workspaceId = defWs;
    if (f.projectId === undefined) f.projectId = null;
    if (f.demandType === undefined) f.demandType = '';
    if (f.icon === undefined) f.icon = null;
    // client: deriva do projectId se ainda não tiver. Fluxos sem projectId ficam
    // sem cliente (workspace-wide / "Geral"). Pra fluxos vinculados a projeto,
    // o cliente é herdado do projeto.
    if (f.client === undefined) {
      const proj = f.projectId ? db.projects.find(p => p.id === f.projectId) : null;
      f.client = proj?.client || null;
      markDirty('flows', f, 'upsert'); // persiste a migração imediato
    }
    (f.stages || []).forEach(s => {
      if (s.responsibleId === undefined) s.responsibleId = null;
      if (s.responsibleRole === undefined) s.responsibleRole = null;
      if (s.roleFilter === undefined) s.roleFilter = s.responsibleRole || null;
      if (s.deadlineDays === undefined) s.deadlineDays = null;
    });
    // Defaults aplicados às novas demandas que escolherem este fluxo
    if (f.defaultDescription === undefined) f.defaultDescription = '';
    if (!Array.isArray(f.defaultChecklist)) f.defaultChecklist = [];
  });
  db.demands.forEach(d => {
    if (!d.workspaceId) {
      const p = db.projects.find(x => x.id === d.projectId);
      d.workspaceId = p ? p.workspaceId : defWs;
    }
    if (d.description === undefined) d.description = '';
    if (!Array.isArray(d.timeEntries)) d.timeEntries = [];
    if (!Array.isArray(d.comments)) d.comments = [];
    if (!Array.isArray(d.attachments)) d.attachments = [];
    if (!Array.isArray(d.history)) d.history = [];
    if (!Array.isArray(d.checklist)) d.checklist = [];
    // Garante que comentários antigos tenham reactions
    if (Array.isArray(d.comments)) {
      d.comments.forEach(c => { if (!c.reactions || typeof c.reactions !== 'object') c.reactions = {}; });
    }
    if (!Array.isArray(d.stageHistory)) d.stageHistory = [];
    if (d.estimatedHours === undefined) d.estimatedHours = null;
    if (d.qtyPieces === undefined) d.qtyPieces = 0;
    if (d.qtyArts === undefined) d.qtyArts = 0;
    if (d.qtyVariations === undefined) d.qtyVariations = 0;
    // Quem executou os entregáveis (distinto do ownerId atual, que muda
    // conforme a demanda avança no fluxo). Se null, cai pra ownerId.
    if (d.deliverableUserId === undefined) d.deliverableUserId = null;
    if (d.recurrence === undefined) d.recurrence = null;
    if (d.priority === undefined || !Number.isInteger(d.priority)) d.priority = 3;
    if (d.stageEnteredAt === undefined) d.stageEnteredAt = d.createdAt || nowISO();
    if (d.stageDueDate === undefined) d.stageDueDate = d.deadline || null;
    delete d.duration; delete d.type;
  });

  // Deduplica funções já existentes (caso de boots anteriores que criaram cópias):
  // pra cada nome (case-insensitive), mantém a MAIS ANTIGA e remove o resto.
  // Usuários que apontavam pra cópias deletadas continuam funcionando — o campo
  // `role` é uma string livre, não FK.
  const seenRoles = new Map();
  const dupes = [];
  for (const r of db.roles) {
    const key = (r.name || '').trim().toLowerCase();
    if (!key) continue;
    if (seenRoles.has(key)) {
      const existing = seenRoles.get(key);
      const keep = (existing.createdAt || '') <= (r.createdAt || '') ? existing : r;
      const drop = keep === existing ? r : existing;
      dupes.push(drop.id);
      seenRoles.set(key, keep);
    } else {
      seenRoles.set(key, r);
    }
  }
  if (dupes.length) {
    db.roles = db.roles.filter(r => !dupes.includes(r.id));
    dupes.forEach(id => removeEntity('roles', id));
    console.log(`› Cleanup: ${dupes.length} função(ões) duplicada(s) removida(s)`);
  }

  // Webhooks são universais desde o rebranding — força workspaceId=null nos
  // registros antigos pra remover qualquer ambiguidade e evitar filtros por
  // squad em código legado.
  const totalHooks = (db.webhooks || []).length;
  let webhookMigrated = 0;
  (db.webhooks || []).forEach(h => {
    if (h.workspaceId != null) {
      h.workspaceId = null;
      markDirty('webhooks', h, 'upsert');
      webhookMigrated++;
    }
  });
  console.log(`› Webhooks: ${totalHooks} carregado(s) em cache · ${webhookMigrated} migrado(s) p/ universal · GET /api/webhooks devolve TODOS`);
}

/* ─── SEED inicial ─── */
function seed(firstInstall) {
  // Depois da primeira instalação, NENHUM seed roda de novo — mesmo que o
  // usuário tenha deletado o admin, o fluxo padrão ou o workspace inicial.
  if (!firstInstall) return;

  // Marca como dirty pra persistir IMEDIATAMENTE no Postgres.
  // Sem isso, se o container reinicia antes de qualquer ação do usuário,
  // o seed se perde e roda de novo no próximo boot (causando duplicação).
  if (db.workspaces.length > 0) markDirty('workspaces', db.workspaces[0], 'upsert');

  if (db.users.length === 0) {
    const id = uid();
    const wsAll = db.workspaces.map(w => w.id);
    const adminUser = {
      id, username: 'admin', name: 'Administrador', role: 'Coordenação',
      isAdmin: true, avatar: null, active: true, workspaces: wsAll, createdAt: nowISO()
    };
    db.users.push(adminUser);
    markDirty('users', adminUser, 'upsert');
    auth.setPassword(id, 'admin123');
    console.log('› Usuário inicial — login: admin | senha: admin123 (altere no Perfil)');
  }
  if (db.flows.length === 0 && db.workspaces.length > 0) {
    const ws = db.workspaces[0].id;
    const defaultFlow = {
      id: uid(), workspaceId: ws, projectId: null,
      name: 'Fluxo Padrão de Marketing', demandType: 'Social Media',
      stages: [
        { id: uid(), label: 'Backlog',       color: '#64748B', done: false, responsibleId: null, deadlineDays: null },
        { id: uid(), label: 'Em Copywrite',  color: '#38BDF8', done: false, responsibleId: null, deadlineDays: 2 },
        { id: uid(), label: 'Em Design',     color: '#A78BFA', done: false, responsibleId: null, deadlineDays: 3 },
        { id: uid(), label: 'Em Revisão',    color: '#F59E0B', done: false, responsibleId: null, deadlineDays: 1 },
        { id: uid(), label: 'Em Mídia Paga', color: '#7A00FF', done: false, responsibleId: null, deadlineDays: 1 },
        { id: uid(), label: 'Concluída',     color: '#22D3A5', done: true,  responsibleId: null, deadlineDays: null }
      ],
      createdAt: nowISO()
    };
    db.flows.push(defaultFlow);
    markDirty('flows', defaultFlow, 'upsert');
  }
}

/* ─── HELPERS ─── */
function publicUser(u) {
  if (!u) return null;
  // Nunca expõe tokens do Google — refresh_token é credencial de longa duração.
  // Devolve booleano + info da conta pra frontend saber que tá conectado.
  const { googleTokens, googleSyncTokens, ...rest } = u;
  rest.googleConnected = !!googleTokens;
  return rest;
}
function sanitizeDiscordId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 15 || digits.length > 22) return null;
  return digits;
}
function appBaseUrl(req) {
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, '');
  if (!req) return '';
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host') || '';
  return host ? `${proto}://${host}` : '';
}
function demandLinkFor(baseUrl, demandId) {
  if (!baseUrl || !demandId) return null;
  return `${baseUrl}/#demand-${demandId}`;
}

/* ─── E-MAIL (notificações por SMTP) ───
   Lê as credenciais SMTP de variáveis de ambiente. Se nenhuma estiver configurada,
   o envio simplesmente não acontece (sem erro). Cada usuário pode definir seu email
   em "Meu Perfil" e quais eventos deseja receber. */
const EMAIL_EVENT_LABELS = {
  assigned:       'Atribuído como responsável',
  stage_assigned: 'Responsável por etapa (auto-atribuição)',
  mention:        'Mencionado em comentário',
  watch_stage:    'Movimento de etapa em demanda que observo',
  watch_comment:  'Novo comentário em demanda que observo',
  daily_digest:   'Resumo diário (seg-sex, 8h) das minhas demandas',
};
function defaultEmailPrefs() {
  return { assigned: true, stage_assigned: true, mention: true, watch_stage: true, watch_comment: true, daily_digest: true };
}
function isValidEmail(e) {
  if (typeof e !== 'string') return false;
  const t = e.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) && t.length <= 200;
}
let _mailTransport;
function getMailTransport() {
  if (_mailTransport !== undefined) return _mailTransport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    _mailTransport = null;
    return null;
  }
  _mailTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: SMTP_SECURE === 'true' || Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Timeouts explícitos: sem isso, o nodemailer espera até ~10min por uma
    // conexão travada — o Cloudflare corta em ~100s e devolve 502 pro usuário
    // ANTES do server sequer logar a causa. Com esses tetos, a app falha em
    // no máximo 30s com a mensagem SMTP real (ETIMEDOUT/EAUTH/etc), o CF não
    // interfere e o toast mostra o motivo.
    connectionTimeout: 15000, // 15s pra abrir o TCP
    greetingTimeout:   15000, // 15s pro banner SMTP
    socketTimeout:     30000, // 30s teto num socket parado
  });
  return _mailTransport;
}
function mailEnabled() { return !!getMailTransport(); }
function fromAddress() {
  return process.env.SMTP_FROM || `reWork <${process.env.SMTP_USER || 'noreply@localhost'}>`;
}
async function sendEmail(to, subject, html, text) {
  const t = getMailTransport();
  if (!t || !to) return { sent: false, reason: !t ? 'smtp_not_configured' : 'no_recipient' };
  try {
    await t.sendMail({ from: fromAddress(), to, subject, html, text });
    return { sent: true };
  } catch (e) {
    console.error('[email] erro ao enviar:', e.message);
    return { sent: false, reason: e.message };
  }
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function buildEmailForNotification(type, ctx) {
  const { demand, project, owner, trigger, stageName, commentText, demandUrl } = ctx;
  const triggerLine = trigger ? `<p style="margin:8px 0;color:#555">Por <strong>${escHtml(trigger.name)}</strong></p>` : '';
  const projectLine = project ? `<p style="margin:0;color:#777;font-size:13px">${escHtml(project.name)}${project.client ? ` · ${escHtml(project.client)}` : ''}</p>` : '';
  const btn = demandUrl ? `<p style="margin:24px 0 8px"><a href="${demandUrl}" style="display:inline-block;background:#7A00FF;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Abrir no reWork →</a></p><p style="margin:0;color:#999;font-size:11px;word-break:break-all">${escHtml(demandUrl)}</p>` : '';
  let subject, headline, body;
  switch (type) {
    case 'assigned':
      subject = `[reWork] Você é o responsável: ${demand.name}`;
      headline = '🧑‍💼 Atribuído como responsável';
      body = `<p style="margin:0 0 8px">Você foi definido como responsável da demanda <strong>${escHtml(demand.name)}</strong>${stageName ? ` na etapa <strong>${escHtml(stageName)}</strong>` : ''}.</p>`;
      break;
    case 'stage_assigned':
      subject = `[reWork] Nova etapa para você: ${demand.name}`;
      headline = '📌 Responsável por nova etapa';
      body = `<p style="margin:0 0 8px">A demanda <strong>${escHtml(demand.name)}</strong> avançou para a etapa <strong>${escHtml(stageName || '—')}</strong> e você é o responsável.</p>`;
      break;
    case 'mention':
      subject = `[reWork] Mencionado em: ${demand.name}`;
      headline = '💬 Você foi mencionado';
      body = `<p style="margin:0 0 8px">${trigger ? `<strong>${escHtml(trigger.name)}</strong> mencionou você em <strong>${escHtml(demand.name)}</strong>:` : `Você foi mencionado em <strong>${escHtml(demand.name)}</strong>:`}</p><blockquote style="border-left:3px solid #7A00FF;padding:10px 14px;margin:12px 0;color:#444;background:#f5f3ff;border-radius:0 4px 4px 0">${escHtml((commentText || '').slice(0, 500))}</blockquote>`;
      break;
    case 'watch_stage':
      subject = `[reWork] Etapa avançou (você observa): ${demand.name}`;
      headline = '👀 Movimento em demanda que você observa';
      body = `<p style="margin:0 0 8px">A demanda <strong>${escHtml(demand.name)}</strong> avançou para a etapa <strong>${escHtml(stageName || '—')}</strong>.</p>`;
      break;
    case 'watch_comment':
      subject = `[reWork] Novo comentário (você observa): ${demand.name}`;
      headline = '👀 Novo comentário em demanda que você observa';
      body = `<p style="margin:0 0 8px">${trigger ? `<strong>${escHtml(trigger.name)}</strong> comentou em ` : 'Novo comentário em '}<strong>${escHtml(demand.name)}</strong>:</p><blockquote style="border-left:3px solid #7A00FF;padding:10px 14px;margin:12px 0;color:#444;background:#f5f3ff;border-radius:0 4px 4px 0">${escHtml((commentText || '').slice(0, 500))}</blockquote>`;
      break;
    default:
      return null;
  }
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f7f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;padding:28px 32px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
  <div style="font-size:13px;font-weight:700;color:#7A00FF;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px">reWork</div>
  <h2 style="margin:0 0 14px;font-size:20px;font-weight:700;color:#222">${headline}</h2>
  ${body}
  ${projectLine}
  ${triggerLine}
  ${btn}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0 16px">
  <p style="color:#999;font-size:11px;margin:0;line-height:1.6">Você recebe estes e-mails porque cadastrou seu endereço no reWork. Para ajustar suas preferências, vá em <strong>Meu Perfil → Notificações por e-mail</strong>.</p>
</div>
</body></html>`;
  const text = `${headline}\n\n${body.replace(/<[^>]+>/g, '').trim()}\n${project ? `\nProjeto: ${project.name}${project.client ? ' · ' + project.client : ''}` : ''}${trigger ? `\nPor: ${trigger.name}` : ''}${demandUrl ? `\n\nAbrir: ${demandUrl}` : ''}`;
  return { subject, html, text };
}
function wsIdsFor(user) {
  if (user.isAdmin) return db.workspaces.map(w => w.id);
  return Array.isArray(user.workspaces) ? user.workspaces : [];
}
function canAccessWs(user, wsId) {
  return user.isAdmin || (Array.isArray(user.workspaces) && user.workspaces.includes(wsId));
}

/* Parse minimal de Cookie: header → objeto { nome: valor }. Evita dep externa. */
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
const SESSION_COOKIE = 'kastor_session';
function buildSessionCookie(token, opts = {}) {
  const isHttps = !!opts.secure;
  // HttpOnly: bloqueia JS → mitiga XSS. SameSite=Lax: previne CSRF em navegação cross-site.
  // Max-Age alinhado ao TTL do token (30 dias por padrão).
  const days = Number(process.env.KASTOR_SESSION_DAYS) > 0 ? Number(process.env.KASTOR_SESSION_DAYS) : 30;
  const maxAge = days * 24 * 60 * 60;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps ? '; Secure' : ''}`;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function isHttpsRequest(req) {
  return req.secure || (req.headers['x-forwarded-proto'] || '').includes('https');
}

function requireAuth(req, res, next) {
  // Prioriza cookie httpOnly (novo). Fallback pra Authorization Bearer mantém
  // compat enquanto há sessões antigas; pode ser removido depois.
  const cookies = parseCookies(req);
  let token = cookies[SESSION_COOKIE] || null;
  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7);
  }
  const userId = auth.userIdForToken(token);
  const user = userId && db.users.find(u => u.id === userId && u.active !== false);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user; req.token = token;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Apenas administradores podem fazer isso' });
  next();
}
/* Moderador OU admin — usado em ações administrativas que NÃO envolvem
   editar usuários nem workspaces (essas seguem sendo `adminOnly` estrito).
   Moderador continua limitado ao conjunto de workspaces que o admin liberou. */
function modOrAdmin(req, res, next) {
  if (!req.user.isAdmin && !req.user.isModerator) return res.status(403).json({ error: 'Apenas moderadores ou administradores podem fazer isso' });
  next();
}

/* ─── NOTIFICAÇÕES ─── */
const NOTIFICATIONS_MAX_PER_USER = 500;
function notify(targetUserId, type, data, triggerUserId, baseUrl) {
  if (!targetUserId || targetUserId === triggerUserId) return; // não notifica a si mesmo
  const user = db.users.find(u => u.id === targetUserId && u.active !== false);
  if (!user) return;
  const n = {
    id: uid(), userId: targetUserId, type,
    demandId: data.demandId || null,
    demandName: data.demandName || '',
    fromUser: triggerUserId || null,
    stageName: data.stageName || null,
    commentText: data.commentText || null,
    read: false, createdAt: nowISO()
  };
  // Fire-and-forget: notify() é síncrono no chamador, mas a escrita no Postgres
  // é async — não bloqueia o response. Erro é logado, o request não quebra.
  store.insertNotification(n).catch(err => console.error('[notify] insert:', err.message));
  // Cap por usuário — remove as mais antigas.
  store.trimNotificationsFor(targetUserId, NOTIFICATIONS_MAX_PER_USER)
    .catch(err => console.error('[notify] trim:', err.message));
  // Email opcional — depende de SMTP configurado, do usuário ter email e do tipo estar nas prefs
  if (mailEnabled() && user.email && EMAIL_EVENT_LABELS[type]) {
    const prefs = user.emailPrefs || defaultEmailPrefs();
    if (prefs[type] !== false) {
      setImmediate(() => sendNotificationEmail(user, type, data, triggerUserId, baseUrl));
    }
  }
}
function sendNotificationEmail(user, type, data, triggerUserId, baseUrl) {
  const demand = data.demandId ? db.demands.find(d => d.id === data.demandId) : null;
  if (!demand) return;
  const project = demand.projectId ? db.projects.find(p => p.id === demand.projectId) : null;
  const trigger = triggerUserId ? db.users.find(u => u.id === triggerUserId) : null;
  const ctx = {
    demand, project, owner: user, trigger,
    stageName: data.stageName || null,
    commentText: data.commentText || null,
    demandUrl: demandLinkFor(baseUrl || process.env.PUBLIC_URL || '', demand.id),
  };
  const built = buildEmailForNotification(type, ctx);
  if (!built) return;
  sendEmail(user.email, built.subject, built.html, built.text);
}

/* ── WEBHOOKS ──
   Sistema de webhooks de saída. Cada workspace pode cadastrar webhooks que recebem
   eventos quando coisas acontecem (demanda criada, comentário adicionado, etc).
   Suporta formato "raw" (JSON puro) e "discord" (embed formatado pro Discord). */

const WEBHOOK_EVENTS = {
  'demand.created': 'Demanda criada',
  'demand.completed': 'Demanda concluída',
  'demand.stage_changed': 'Etapa avançada',
  'demand.assigned': 'Responsável alterado manualmente',
  'demand.stage_assigned': 'Responsável atribuído pela etapa',
  'demand.deadline_changed': 'Prazo alterado',
  'demand.priority_changed': 'Prioridade alterada',
  'comment.added': 'Comentário adicionado',
  'comment.mention': 'Menção em comentário',
  'checklist.completed': 'Item de checklist concluído',
};

// Cores para embeds do Discord (decimal) — alinhadas com a paleta reWork
const DISCORD_COLORS = {
  'demand.created':            7995647,  // #7A00FF accent
  'demand.completed':          3990432,  // #3CE3A0 success
  'demand.stage_changed':      7995647,  // #7A00FF accent
  'demand.assigned':           7995647,
  'demand.stage_assigned':     7995647,
  'demand.deadline_changed':  16099096,  // #F5A718 warn
  'demand.priority_changed':  15683664,  // #EF5050 danger
  'comment.added':             9741240,  // #94A3B8 text-dim (cinza neutro)
  'comment.mention':           7995647,
  'checklist.completed':       3990432,
};

const PRIORITY_LABELS = { 1: 'Imediato', 2: 'Alta', 3: 'Média', 4: 'Baixa' };

function priorityName(p) { return PRIORITY_LABELS[p] || 'Média'; }

function buildDiscordPayload(event, ctx) {
  // ctx = { demand, project, flow, stage, user, comment, item, prevStage, prevDeadline, appBaseUrl, etc }
  const d = ctx.demand;
  const p = ctx.project;
  const u = ctx.user;
  const projectLabel = p ? p.name + (p.client ? ` · ${p.client}` : '') : '—';
  const ownerMention = (ctx.owner && ctx.owner.discordId) ? `<@${ctx.owner.discordId}>` : null;
  const ownerName = ctx.owner ? ctx.owner.name : (d.ownerId ? '—' : 'Sem responsável');
  const ownerField = ownerMention ? `${ownerName} (${ownerMention})` : ownerName;
  const demandUrl = demandLinkFor(ctx.appBaseUrl, d.id);
  const baseFields = [
    { name: 'Projeto', value: projectLabel, inline: true },
    { name: 'Responsável', value: ownerField, inline: true },
    { name: 'Prioridade', value: priorityName(d.priority), inline: true },
  ];
  let title, description, color, extraFields = [];
  switch (event) {
    case 'demand.created':
      title = `📝 Nova demanda: ${d.name}`;
      description = (d.description || '').slice(0, 200) || 'Sem descrição';
      break;
    case 'demand.completed':
      title = `✅ Demanda concluída: ${d.name}`;
      description = `Concluída por ${u?.name || '—'}`;
      break;
    case 'demand.stage_changed':
      title = `➡️ Etapa avançada: ${d.name}`;
      description = `**${ctx.prevStage?.label || 'etapa anterior'}** → **${ctx.stage?.label || 'etapa atual'}**`;
      if (u) description += `\npor ${u.name}`;
      break;
    case 'demand.assigned':
      title = `👤 Responsável alterado: ${d.name}`;
      description = `Atribuída a **${ownerName}**${u ? ` por ${u.name}` : ''}`;
      break;
    case 'demand.stage_assigned':
      title = `📌 Nova etapa para você: ${d.name}`;
      description = `Etapa **${ctx.stage?.label || '—'}** — responsável: **${ownerName}**`;
      if (u && ctx.owner && u.id !== ctx.owner.id) description += `\nMovida por ${u.name}`;
      break;
    case 'demand.deadline_changed':
      title = `📅 Prazo alterado: ${d.name}`;
      description = `Novo prazo: **${d.deadline || 'sem prazo'}**`;
      break;
    case 'demand.priority_changed':
      title = `🚨 Prioridade alterada: ${d.name}`;
      description = `Agora: **${priorityName(d.priority)}**`;
      break;
    case 'comment.added':
      title = `💬 Novo comentário em: ${d.name}`;
      description = (ctx.comment?.text || '').slice(0, 400) || '_(comentário vazio)_';
      if (u) description = `**${u.name}** comentou:\n${description}`;
      break;
    case 'comment.mention':
      title = `📣 Menção em: ${d.name}`;
      description = (ctx.comment?.text || '').slice(0, 400);
      if (u) description = `**${u.name}** mencionou alguém:\n${description}`;
      break;
    case 'checklist.completed':
      title = `☑️ Checklist concluído em: ${d.name}`;
      description = `Item: **${ctx.item?.text || '—'}**`;
      if (u) description += `\npor ${u.name}`;
      break;
    default:
      title = `Evento: ${event}`;
      description = '';
  }
  const embedFields = baseFields.concat(extraFields);
  if (demandUrl) {
    embedFields.push({ name: 'Abrir demanda', value: `[Ver no reWork](${demandUrl})`, inline: false });
  }
  const embed = {
    title: title.slice(0, 256),
    description: description.slice(0, 4000),
    color: color || DISCORD_COLORS[event] || 6730854,
    fields: embedFields,
    timestamp: nowISO(),
    footer: { text: `reWork · ${event}` }
  };
  if (demandUrl) embed.url = demandUrl;
  const payload = { username: 'reWork', embeds: [embed] };
  // Ping do responsável conforme o evento:
  //  - demand.stage_assigned: SEMPRE pinga o novo responsável da etapa
  //  - demand.assigned: pinga em mudanças manuais
  //  - demand.created: pinga apenas se quem criou não é o próprio responsável
  const linkLine = demandUrl ? `\n${demandUrl}` : '';
  if (ownerMention && ctx.owner) {
    if (event === 'demand.stage_assigned') {
      const stageLabel = ctx.stage?.label ? ` **${ctx.stage.label}**` : '';
      payload.content = `${ownerMention} você é o responsável pela nova etapa${stageLabel} de **${d.name}**.${linkLine}`;
      payload.allowed_mentions = { users: [ctx.owner.discordId] };
    } else if (event === 'demand.assigned') {
      payload.content = `${ownerMention} você é o novo responsável por **${d.name}**.${linkLine}`;
      payload.allowed_mentions = { users: [ctx.owner.discordId] };
    } else if (event === 'demand.created' && ctx.owner.id !== u?.id) {
      payload.content = `${ownerMention} uma nova demanda foi criada com você como responsável.${linkLine}`;
      payload.allowed_mentions = { users: [ctx.owner.discordId] };
    }
  }
  // comment.mention: pinga os mencionados. Se o webhook tem alvo, pinga só ele.
  if (event === 'comment.mention' && Array.isArray(ctx.mentionedUsers)) {
    let toMention = ctx.mentionedUsers.filter(mu => mu.discordId);
    if (ctx.targetUserId) toMention = toMention.filter(mu => mu.id === ctx.targetUserId);
    if (toMention.length) {
      const mentionsStr = toMention.map(mu => `<@${mu.discordId}>`).join(' ');
      payload.content = `${mentionsStr} você foi mencionado em **${d.name}**.${linkLine}`;
      payload.allowed_mentions = { users: toMention.map(mu => mu.discordId) };
    }
  }
  return payload;
}

function buildRawPayload(event, ctx) {
  const demandUrl = demandLinkFor(ctx.appBaseUrl, ctx.demand?.id);
  return {
    event,
    timestamp: nowISO(),
    workspace: { id: ctx.demand?.workspaceId },
    demand: ctx.demand ? {
      id: ctx.demand.id, name: ctx.demand.name,
      status: ctx.demand.status, priority: ctx.demand.priority,
      projectId: ctx.demand.projectId, ownerId: ctx.demand.ownerId,
      deadline: ctx.demand.deadline,
      url: demandUrl,
    } : null,
    project: ctx.project ? { id: ctx.project.id, name: ctx.project.name, client: ctx.project.client || null } : null,
    user: ctx.user ? { id: ctx.user.id, name: ctx.user.name } : null,
    owner: ctx.owner ? { id: ctx.owner.id, name: ctx.owner.name, discordId: ctx.owner.discordId || null } : null,
    stage: ctx.stage ? { id: ctx.stage.id, label: ctx.stage.label } : null,
    prevStage: ctx.prevStage ? { id: ctx.prevStage.id, label: ctx.prevStage.label } : null,
    comment: ctx.comment ? { id: ctx.comment.id, text: ctx.comment.text } : null,
    item: ctx.item ? { id: ctx.item.id, text: ctx.item.text } : null,
  };
}

// Quando o webhook tem um targetUserId, decide se o evento é relevante para esse usuário.
// Eventos elegíveis: tornar-se responsável (criação, mudança manual, atribuição por etapa) e ser mencionado em comentário.
// Self-action é ignorada (se o próprio alvo é quem fez a ação, ele já sabe e não precisa de notificação).
function eventRelevantToTarget(event, ctx, targetUserId) {
  if (!targetUserId) return true;
  if (ctx.user && ctx.user.id === targetUserId) return false;
  if (event === 'demand.created' || event === 'demand.assigned' || event === 'demand.stage_assigned') {
    return !!(ctx.owner && ctx.owner.id === targetUserId);
  }
  if (event === 'comment.mention') {
    const mentioned = ctx.comment?.mentions || [];
    return mentioned.includes(targetUserId);
  }
  return false;
}

/* SSRF guard — bloqueia webhooks apontando pra rede interna ou metadata endpoints.
   Cobre: loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16 → IMDS AWS), IPs
   privados IPv4 (10.*, 172.16-31.*, 192.168.*), IPv6 unique-local (fc00::/7),
   hostnames sem ponto (ex.: "postgres", "localhost", "redis"). */
function isPrivateOrLocalHostname(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || !h.includes('.')) return true; // "localhost", "redis", "postgres"…
  // IPv4
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1]), parseInt(v4[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + IMDS AWS
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  // IPv6 abreviado
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}
function isSafeWebhookUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateOrLocalHostname(u.hostname)) return false;
    return true;
  } catch { return false; }
}

/* fetch com timeout via AbortController. Sem isso, um webhook lento segura
   uma conexão do pool pra sempre. 10s cobre 99% dos casos legítimos. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Roteamento por cliente/projeto. Um webhook sem filtro (clientId/projectId nulos)
// dispara pra todos os eventos do workspace — comportamento original. Quando tem
// filtro, precisa bater o cliente e/ou o projeto da demanda que gerou o evento.
function hookMatchesScope(hook, ctx) {
  if (!hook.clientId && !hook.projectId) return true;
  const project = ctx.project
    || (ctx.demand && ctx.demand.projectId ? db.projects.find(p => p.id === ctx.demand.projectId) : null);
  if (!project) return false; // filtro exige projeto, mas o evento não tem → não dispara
  if (hook.projectId && project.id !== hook.projectId) return false;
  if (hook.clientId && project.clientId !== hook.clientId) return false;
  return true;
}

async function triggerWebhook(event, ctx) {
  if (!ctx.demand) return;
  // Webhooks são UNIVERSAIS — disparam pra eventos de qualquer squad. O campo
  // workspaceId dos hooks antigos é ignorado de propósito (sem migração de dados).
  // O recorte fino continua via clientId/projectId (hookMatchesScope) e alvo.
  const hooks = (db.webhooks || []).filter(h =>
    h.active !== false &&
    Array.isArray(h.events) &&
    h.events.includes(event) &&
    hookMatchesScope(h, ctx) &&
    eventRelevantToTarget(event, ctx, h.targetUserId || null)
  );
  if (!hooks.length) return;
  for (const hook of hooks) {
    if (!isSafeWebhookUrl(hook.url)) {
      hook.lastError = 'URL bloqueada (rede interna, loopback ou protocolo inválido)';
      hook.lastStatus = 0;
      saveEntity('webhooks', hook);
      continue;
    }
    const hookCtx = { ...ctx, targetUserId: hook.targetUserId || null };
    const payload = hook.format === 'discord'
      ? buildDiscordPayload(event, hookCtx)
      : buildRawPayload(event, hookCtx);
    try {
      const resp = await fetchWithTimeout(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      hook.lastTriggered = nowISO();
      hook.lastStatus = resp.status;
      hook.lastError = resp.ok ? null : `HTTP ${resp.status}`;
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'timeout (>10s)' : String(e.message || e);
      hook.lastError = msg.slice(0, 200);
      hook.lastStatus = 0;
      console.error(`[webhook] erro ao disparar ${event} → ${hook.url}: ${msg}`);
    }
    saveEntity('webhooks', hook);
  }
}

// Atalho assíncrono para disparar sem bloquear a request
function fireWebhook(event, ctxBuilder) {
  setImmediate(async () => {
    try {
      const ctx = typeof ctxBuilder === 'function' ? ctxBuilder() : ctxBuilder;
      await triggerWebhook(event, ctx);
    } catch (e) {
      console.error('[webhook] erro no contexto:', e.message);
    }
  });
}

/* ─── APP ─── */
const app = express();
// Reverse proxy (Nginx Proxy Manager, Traefik, etc): confia no X-Forwarded-*
// pra req.secure/req.ip refletirem a origem real do usuário. Sem isso, cookies
// seguros não seriam emitidos e rate limits por IP contariam tudo como localhost.
app.set('trust proxy', 1);

/* Security headers — middleware caseiro, sem dep externa. Cobre o que helmet
   cobriria de mais relevante pra esse app. CSP permite inline porque temos
   inline onclick em vários lugares + scripts inline pra setup do tema; quando
   modularizar (ver notes/MODULARIZATION.md), pode endurecer. */
/* Providers permitidos em <iframe> na Base de Conhecimento. Cada entrada é
   uma origem completa; entradas com `*.` viram wildcard de subdomínio.
   MUDAR AQUI reflete no CSP `frame-src` (browser não carrega iframe fora
   dessa lista). Manter em sincronia com POST_IFRAME_HOST_ALLOWLIST em cima
   (que valida no sanitizer). */
const CSP_IFRAME_SRC = [
  "'self'",
  'https://www.youtube.com', 'https://youtube.com', 'https://www.youtube-nocookie.com',
  'https://player.vimeo.com', 'https://vimeo.com',
  'https://www.loom.com', 'https://loom.com',
  'https://docs.google.com', 'https://drive.google.com', 'https://sheets.google.com', 'https://lookerstudio.google.com',
  'https://*.notion.so', 'https://*.notion.site', 'https://notion.so',
  'https://miro.com', 'https://*.miro.com',
  'https://www.figma.com', 'https://figma.com',
  'https://airtable.com', 'https://*.airtable.com',
  'https://codepen.io',
  'https://codesandbox.io', 'https://*.codesandbox.io',
  'https://www.canva.com', 'https://*.canva.com',
  'https://onedrive.live.com', 'https://*.sharepoint.com'
].join(' ');
app.use((req, res, next) => {
  // Anti-clickjacking (não embed em iframe de terceiros)
  res.set('X-Frame-Options', 'SAMEORIGIN');
  // Bloqueia MIME sniffing — força o Content-Type declarado
  res.set('X-Content-Type-Options', 'nosniff');
  // Manda origem (sem path/query) pra requests cross-origin. YouTube, Loom,
  // Figma e outros exigem Referer pra servir embeds — `same-origin` puro
  // (que estava aqui antes) bloqueava tudo. `strict-origin-when-cross-origin`
  // é o default moderno dos browsers e não vaza URL específica.
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Bloqueia APIs sensíveis que não usamos
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // CSP: inline necessário pelo onclick=, fontes Google, imagens data:.
  // `frame-src` explícito com os providers da Base de Conhecimento — sem isso
  // o browser bloqueia YouTube/Loom/Figma/etc. antes mesmo de fazer o request.
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    // Clarity: script vem de www.clarity.ms, beacons/telemetria pra *.clarity.ms.
    "script-src 'self' 'unsafe-inline' https://www.clarity.ms https://*.clarity.ms",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' https:",
    "connect-src 'self' https://*.clarity.ms https://c.bing.com",
    `frame-src ${CSP_IFRAME_SRC}`,
    `child-src ${CSP_IFRAME_SRC}`,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  // HSTS só em HTTPS (sem efeito em http localhost)
  if (req.secure || (req.headers['x-forwarded-proto'] || '').includes('https')) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Limite generoso só onde realmente há upload (anexos/avatares); resto é 200kb.
// 75mb comporta arquivos até ~50MB depois do overhead do base64 (~33%) + metadados.
const jsonLg = express.json({ limit: '75mb' });
const jsonSm = express.json({ limit: '200kb' });
// Log de request leve: método, rota, status e duração das chamadas /api. Pula o
// SSE (/api/stream, conexão longa) e os health checks (ruído). Ajuda a debugar prod.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && req.path !== '/api/stream' && !req.path.startsWith('/api/health')) {
    const start = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.path} → ${res.statusCode} ${Date.now() - start}ms`));
  }
  next();
});
app.use((req, res, next) => {
  const isUpload = /^\/api\/(uploads|demands(\/[^/]+(\/comment)?)?$|me$|users(\/[^/]+)?$|projects(\/[^/]+)?$)/.test(req.path);
  return (isUpload ? jsonLg : jsonSm)(req, res, next);
});
// Static do SPA — sem cache em dev pra que mudanças em app.js/style.css/index.html
// apareçam imediatamente. Anexos (/uploads/*) continuam servidos pelo bloco abaixo.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

/* ── Uploads em disco ──
   Anexos (imagens em comentários, anexos de demanda, avatares) viram arquivos
   em data/uploads/<uid>-<name>. Antes ficavam serializados em base64 dentro
   do db.json — em escala isso explodia o tamanho do arquivo.

   Fluxo: cliente envia data URI base64 → server decodifica e grava no disco →
   responde com `{ url: '/uploads/<file>' }`. Cliente passa a referenciar essa
   URL nos campos de attachments/avatar do payload subsequente. */
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* Whitelist estrita de MIMEs. NÃO inclui:
   - text/html, application/xhtml+xml → XSS same-origin
   - image/svg+xml → pode carregar <script>
   - application/xml, text/xml → XXE em alguns viewers
   Extensão do arquivo é DERIVADA do MIME (não confiar em user input),
   evitando "envio evil.png com Content-Type text/html". */
const ALLOWED_MIME_EXT = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv':   'csv',
  'text/markdown': 'md',
};
// 25 MB por arquivo — cabe screenshots grandes e PDFs pequenos. O compress
// client-side reduz a maioria pra <2MB, mas prints/PNGs sem compress podem passar.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

function saveUploadFromDataUri(dataUri, originalName) {
  if (typeof dataUri !== 'string') return null;
  const m = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = ALLOWED_MIME_EXT[mime];
  if (!ext) return null; // MIME não permitido
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > UPLOAD_MAX_BYTES) return null;
  // Nome sanitizado + extensão FORÇADA pelo MIME (ignora extensão original).
  const rawBase = String(originalName || 'file').replace(/\.[a-z0-9]{1,10}$/i, '');
  const safeBase = rawBase.replace(/[^\w.\-]/g, '_').slice(0, 80) || 'file';
  const filename = uid() + '-' + safeBase + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return {
    url: '/uploads/' + filename,
    name: originalName || (safeBase + '.' + ext),
    type: mime,
    size: buf.length
  };
}

// Rate limit por USUÁRIO em endpoints caros/de escrita (protege contra abuso interno
// ou cliente em loop). Chave = user id (requer requireAuth antes); cai pro IP se anônimo.
// makeRateLimit/clientIp são function declarations (hoisted), então são chamáveis aqui.
const _rlByUser = req => (req.user && req.user.id) || clientIp(req);
const rateLimitBulk   = makeRateLimit(new Map(), 30, 'ações em massa',         _rlByUser);
const rateLimitUpload = makeRateLimit(new Map(), 60, 'uploads',                _rlByUser);
const rateLimitReport = makeRateLimit(new Map(), 40, 'consultas de relatório', _rlByUser);

// POST /api/uploads — aceita { name, type, data: 'data:image/...;base64,...' }
app.post('/api/uploads', (req, res, next) => requireAuth(req, res, next), rateLimitUpload, (req, res) => {
  const { name, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data (data URI base64) é obrigatório' });
  const saved = saveUploadFromDataUri(data, name);
  if (!saved) {
    return res.status(400).json({
      error: 'Arquivo inválido: tipo não permitido, tamanho maior que 10MB ou data URI mal formado.'
    });
  }
  res.json(saved);
});

// Serve /uploads/* — só pra usuários autenticados (cookie httpOnly). Listing desativado.
app.use('/uploads', requireAuth, express.static(UPLOADS_DIR, { index: false, dotfiles: 'deny' }));

/* ── HEALTH CHECK ──
   Liveness (/api/health): responde na hora, sem tocar no banco — é o que o
   orquestrador/load-balancer deve pollar pra detectar um processo travado.
   Readiness (/api/health/ready): pinga o Postgres; 503 se o banco estiver fora.
   Ambos públicos (sem requireAuth) — health check não deve depender de sessão. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: nowISO() });
});
app.get('/api/health/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

/* ── AUTENTICAÇÃO ── */
/* Rate limit em memória — 5 tentativas por minuto por IP.
   Usado em /api/login (falha zera em sucesso), /api/forgot-password e
   /api/reset-password (todas as tentativas contam). Em deploys multi-instância
   seria preciso migrar pra Redis, mas single-instance basta. */
const _loginAttempts = new Map(); // ip → { count, resetAt }
const _pwResetAttempts = new Map(); // ip → { count, resetAt }
const LOGIN_MAX_PER_MIN = 5;
const PWRESET_MAX_PER_MIN = 5;
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
}
/* Middleware genérico de rate limit por IP. `bucket` = Map local.
   Retorna 429 com Retry-After quando estoura; senão incrementa e chama next(). */
function makeRateLimit(bucket, max, label = 'requisições', keyFn = clientIp, windowMs = 60000) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let rec = bucket.get(key);
    if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + windowMs };
    if (rec.count >= max) {
      const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      bucket.set(key, rec);
      return res.status(429).json({ error: `Muitas ${label}. Aguarde ${retryAfter}s antes de tentar de novo.`, retryAfter });
    }
    rec.count++;
    bucket.set(key, rec);
    next();
  };
}
const rateLimitPwReset = makeRateLimit(_pwResetAttempts, PWRESET_MAX_PER_MIN, 'tentativas');
app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  let rec = _loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 60000 };
  if (rec.count >= LOGIN_MAX_PER_MIN) {
    const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    _loginAttempts.set(ip, rec);
    return res.status(429).json({ error: `Muitas tentativas. Aguarde ${retryAfter}s antes de tentar de novo.`, retryAfter });
  }
  const { username, password } = req.body || {};
  const user = db.users.find(u => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user || !auth.verifyPassword(user.id, password)) {
    rec.count++;
    _loginAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  if (user.active === false) {
    rec.count++;
    _loginAttempts.set(ip, rec);
    return res.status(403).json({ error: 'Usuário desativado. Fale com a coordenação.' });
  }
  // Sucesso: zera o contador desse IP
  _loginAttempts.delete(ip);
  const token = auth.addToken(user.id);
  // Cookie httpOnly: JS no browser não consegue ler — protege contra XSS.
  // O `token` no body é mantido por compat (clientes antigos podiam usar Bearer).
  res.set('Set-Cookie', buildSessionCookie(token, { secure: isHttpsRequest(req) }));
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  auth.removeToken(req.token);
  res.set('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

/* ─── ESQUECI A SENHA / RESET POR E-MAIL ───
   Fluxo: usuário pede reset por e-mail → token aleatório vai pro inbox →
   usuário clica → form de nova senha → POST /api/reset-password.

   Não vaza se o e-mail existe (sempre 200 ok) pra dificultar enumeração.
   Token expira em 1h, é uso único, e ao concluir invalida todas as
   sessões ativas daquele usuário (auth.dropTokensFor). */
app.post('/api/forgot-password', rateLimitPwReset, async (req, res) => {
  const { email } = req.body || {};
  if (!email || !isValidEmail(email)) return res.json({ ok: true });
  if (!mailEnabled()) {
    return res.status(503).json({ error: 'O servidor não tem SMTP configurado para enviar e-mails. Fale com a coordenação para que ela te ajude a redefinir a senha.' });
  }
  await store.cleanupResets();
  const user = db.users.find(u =>
    u.email && u.email.toLowerCase() === String(email).trim().toLowerCase() && u.active !== false
  );
  // Resposta uniforme — não revela se o e-mail está cadastrado.
  if (!user) return res.json({ ok: true });
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hora
  await store.insertReset({ token, userId: user.id, expiresAt, used: false, createdAt: nowISO() });
  const baseUrl = appBaseUrl(req);
  const link = `${baseUrl}/reset/${token}`;
  const subject = '[reWork] Redefinir sua senha';
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:540px;margin:24px auto;background:#fff;border-radius:12px;padding:28px 32px">
      <div style="font-size:13px;font-weight:700;color:#7A00FF;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px">reWork</div>
      <h2 style="margin:0 0 10px;font-size:20px;color:#222">Redefinir sua senha</h2>
      <p style="margin:0 0 14px;color:#555;font-size:14px;line-height:1.55">Olá ${escHtml(user.name)}, recebemos um pedido pra redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova:</p>
      <p style="margin:24px 0 8px"><a href="${link}" style="display:inline-block;background:#7A00FF;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Redefinir senha →</a></p>
      <p style="margin:0;color:#999;font-size:11px;word-break:break-all">${escHtml(link)}</p>
      <p style="margin:24px 0 0;color:#777;font-size:12px;line-height:1.55">Este link vale por <strong>1 hora</strong> e só pode ser usado uma vez. Se você não pediu esta redefinição, pode ignorar este e-mail — sua senha continua a mesma.</p>
    </div></body></html>`;
  const text = `Olá ${user.name}, abra este link em 1h pra redefinir sua senha:\n\n${link}\n\nSe não foi você, ignore.`;
  setImmediate(() => sendEmail(user.email, subject, html, text));
  res.json({ ok: true });
});
app.post('/api/reset-password', rateLimitPwReset, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || typeof newPassword !== 'string') return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
  await store.cleanupResets();
  const rec = await store.getReset(String(token));
  if (!rec || rec.used || rec.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Link inválido ou expirado. Solicite um novo reset.' });
  }
  const user = db.users.find(u => u.id === rec.userId && u.active !== false);
  if (!user) return res.status(400).json({ error: 'Usuário não encontrado.' });
  auth.setPassword(user.id, newPassword);
  await store.markResetUsed(String(token));
  // Invalida sessões ativas daquele usuário — força re-login com nova senha.
  if (typeof auth.dropTokensFor === 'function') auth.dropTokensFor(user.id);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const me = publicUser(req.user);
  if (me) me._smtpEnabled = mailEnabled();
  res.json(me);
});

app.put('/api/me', requireAuth, (req, res) => {
  const { name, role, avatar, currentPassword, newPassword, username, discordId, email, emailPrefs } = req.body || {};
  const u = req.user;
  if (typeof name === 'string' && name.trim()) u.name = name.trim();
  if (typeof role === 'string') u.role = role.trim();
  if (discordId !== undefined) {
    if (discordId === null || discordId === '') {
      u.discordId = null;
    } else {
      const did = sanitizeDiscordId(discordId);
      if (!did) return res.status(400).json({ error: 'ID do Discord inválido. Cole o ID numérico do usuário (15–22 dígitos).' });
      u.discordId = did;
    }
  }
  if (email !== undefined) {
    if (email === null || email === '') {
      u.email = null;
    } else if (isValidEmail(email)) {
      u.email = String(email).trim().toLowerCase();
    } else {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
  }
  if (emailPrefs && typeof emailPrefs === 'object') {
    const prev = u.emailPrefs || defaultEmailPrefs();
    const next = { ...prev };
    for (const k of Object.keys(EMAIL_EVENT_LABELS)) {
      if (typeof emailPrefs[k] === 'boolean') next[k] = emailPrefs[k];
    }
    u.emailPrefs = next;
  }
  if (typeof username === 'string' && username.trim()) {
    const trimmed = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(trimmed)) return res.status(400).json({ error: 'Usuário deve conter apenas letras, números, pontos, hífens e underlines' });
    if (trimmed.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });
    if (db.users.some(x => x.id !== u.id && x.username.toLowerCase() === trimmed)) return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
    u.username = trimmed;
  }
  if (avatar !== undefined) {
    if (!avatar) {
      u.avatar = null;
    } else if (String(avatar).startsWith('/uploads/')) {
      // Cliente já subiu via /api/uploads e está enviando a URL
      u.avatar = avatar;
    } else if (String(avatar).startsWith('data:image/')) {
      if (String(avatar).length > 1500000) return res.status(400).json({ error: 'Imagem muito grande' });
      // Compat: cliente antigo enviou base64 — extrai pro disco
      const saved = saveUploadFromDataUri(avatar, u.username + '-avatar');
      if (!saved) return res.status(400).json({ error: 'Imagem inválida' });
      u.avatar = saved.url;
    } else {
      return res.status(400).json({ error: 'Imagem inválida' });
    }
  }
  if (newPassword) {
    if (!auth.verifyPassword(u.id, currentPassword)) {
      return res.status(400).json({ error: 'Senha atual incorreta' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    }
    auth.setPassword(u.id, newPassword);
  }
  saveEntity('users', u);
  res.json(publicUser(u));
});

/* Ping de presença — cliente bate de minuto em minuto. Não loga histórico,
   apenas atualiza lastSeen pra que outros usuários vejam o dot verde. */
app.post('/api/me/ping', requireAuth, (req, res) => {
  req.user.lastSeen = nowISO();
  saveEntity('users', req.user);
  res.json({ ok: true, lastSeen: req.user.lastSeen });
});

app.post('/api/me/email/test', requireAuth, async (req, res) => {
  if (!mailEnabled()) return res.status(503).json({ error: 'SMTP não configurado no servidor. Defina as variáveis SMTP_HOST, SMTP_USER, SMTP_PASS antes de testar.' });
  if (!req.user.email) return res.status(400).json({ error: 'Cadastre um e-mail no seu perfil antes de testar.' });
  const result = await sendEmail(
    req.user.email,
    '[reWork] Teste de notificação por e-mail',
    `<!doctype html><html><body style="margin:0;background:#f7f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:540px;margin:24px auto;background:#fff;border-radius:12px;padding:28px 32px">
  <div style="font-size:13px;font-weight:700;color:#7A00FF;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px">reWork</div>
  <h2 style="margin:0 0 10px;font-size:20px;color:#222">✅ E-mail funcionando</h2>
  <p style="margin:0 0 8px;color:#444">Olá, ${escHtml(req.user.name)}! Este é um teste do canal de e-mails do reWork.</p>
  <p style="margin:0;color:#666;font-size:13px">A partir de agora, você pode receber notificações sobre demandas e menções neste endereço.</p>
</div></body></html>`,
    `Olá ${req.user.name}! Este é um teste do canal de e-mails do reWork.`
  );
  if (!result.sent) return res.status(502).json({ error: 'Falha ao enviar: ' + (result.reason || 'erro desconhecido') });
  res.json({ ok: true });
});

/* ── GOOGLE CALENDAR (integração one-way, read-only) ──
   Fase 1: OAuth + storage de tokens + listagem de calendários.
   Fase 2 (sync engine) e Fase 3 (render na agenda) virão em seguida. */

// Retorna estado da conexão do usuário — usado pela UI do perfil.
app.get('/api/google/status', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    configured: googleCal.isConfigured(),
    connected: !!u.googleTokens,
    account: u.googleAccount || null,
    calendars: u.googleCalendars || [],
    lastSyncAt: u.googleLastSyncAt || null
  });
});

// Inicia o flow — redireciona pra tela de consentimento do Google.
app.get('/api/google/auth', requireAuth, (req, res) => {
  if (!googleCal.isConfigured()) {
    return res.status(500).send(
      '<html><body style="font-family:system-ui;max-width:600px;margin:60px auto;padding:24px">' +
      '<h2>Google Calendar não configurado</h2>' +
      '<p>Defina <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e <code>GOOGLE_REDIRECT_URI</code> no arquivo <code>.env</code> do servidor.</p>' +
      '<p><a href="/profile">Voltar</a></p></body></html>'
    );
  }
  try {
    const state = googleCal.makeState(req.user.id);
    const url = googleCal.getAuthUrl(state);
    res.redirect(url);
  } catch (e) {
    console.error('[google/auth]', e);
    res.redirect('/profile?google=error&reason=' + encodeURIComponent(e.message));
  }
});

// Callback do Google — troca `code` por tokens, guarda no usuário, redireciona
// de volta pro perfil com feedback.
app.get('/api/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/profile?google=error&reason=' + encodeURIComponent(error));
  if (!code || !state) return res.redirect('/profile?google=error&reason=missing-params');
  const entry = googleCal.popState(String(state));
  if (!entry) return res.redirect('/profile?google=error&reason=invalid-state');
  const user = db.users.find(u => u.id === entry.userId);
  if (!user) return res.redirect('/profile?google=error&reason=user-not-found');
  try {
    const tokens = await googleCal.exchangeCode(String(code));
    if (!tokens.refresh_token) {
      // Google só dá refresh_token na primeira autorização (ou com prompt=consent
      // + access_type=offline, que já pedimos). Se ainda assim não veio, algo tá
      // errado — abortamos.
      return res.redirect('/profile?google=error&reason=no-refresh-token');
    }
    const account = await googleCal.getUserInfo(tokens);
    // Fetch inicial dos calendários — permite escolher já ao concluir a conexão.
    const calendars = await googleCal.listCalendars(tokens);
    user.googleTokens = tokens;
    user.googleAccount = account;
    // Auto-seleciona só o primary — outros ficam disponíveis pra o usuário marcar.
    user.googleCalendars = calendars.map(c => ({ ...c, selected: c.primary }));
    saveEntity('users', user);
    res.redirect('/profile?google=connected');
  } catch (e) {
    console.error('[google/callback]', e);
    res.redirect('/profile?google=error&reason=' + encodeURIComponent(e.message || 'unknown'));
  }
});

// Desconecta — revoga tokens no Google (best-effort) + apaga estado local.
app.post('/api/google/disconnect', requireAuth, async (req, res) => {
  const u = req.user;
  const tokens = u.googleTokens;
  delete u.googleTokens;
  delete u.googleAccount;
  delete u.googleCalendars;
  delete u.googleSyncTokens;
  delete u.googleLastSyncAt;
  saveEntity('users', u);
  if (tokens) googleCal.revokeTokens(tokens).catch(() => {});
  res.json({ ok: true });
});

// Salva quais calendários o usuário quer sincronizar.
// Body: { selections: { [calendarId]: boolean } }
app.put('/api/google/calendars', requireAuth, (req, res) => {
  const u = req.user;
  if (!u.googleTokens) return res.status(400).json({ error: 'Google Calendar não conectado' });
  const selections = req.body?.selections;
  if (!selections || typeof selections !== 'object') {
    return res.status(400).json({ error: 'Campo selections inválido' });
  }
  const cur = u.googleCalendars || [];
  u.googleCalendars = cur.map(c => ({ ...c, selected: !!selections[c.id] }));
  saveEntity('users', u);
  res.json({ calendars: u.googleCalendars });
});

// Faz sync incremental (ou full na primeira vez) de todos os calendários
// selecionados. Retorna contadores pro frontend saber se algo mudou.
// Pode ser chamado por trigger manual (botão) ou periódico (timer).
app.post('/api/google/sync', requireAuth, async (req, res) => {
  const u = req.user;
  if (!u.googleTokens) return res.status(400).json({ error: 'Google Calendar não conectado' });
  try {
    const r = await syncGoogleForUser(u);
    if (r.noSelection) return res.json({ ok: true, upserted: 0, deleted: 0, message: 'Nenhum calendário selecionado' });
    res.json({
      ok: true,
      upserted: r.upserted,
      deleted: r.deleted,
      lastSyncAt: u.googleLastSyncAt,
      errors: r.errors.length ? r.errors : undefined
    });
  } catch (e) {
    console.error('[google/sync] fatal:', e);
    res.status(500).json({ error: e.message || 'Falha ao sincronizar' });
  }
});

/* Roda o sync de UM usuário — extraído do handler HTTP pra reuso pelo job
   automático. Idempotente: `syncToken` do Google evita re-fazer trabalho. */
async function syncGoogleForUser(u) {
  const selected = (u.googleCalendars || []).filter(c => c.selected);
  if (!selected.length) return { upserted: 0, deleted: 0, errors: [], noSelection: true };
  const syncTokens = { ...(u.googleSyncTokens || {}) };
  const onTokenRefresh = (newTokens) => { u.googleTokens = newTokens; saveEntity('users', u); };
  let upserted = 0, deleted = 0;
  const errors = [];
  for (const calMeta of selected) {
    try {
      let { events, nextSyncToken, expired } = await googleCal.syncCalendar(
        u.googleTokens, calMeta.id, syncTokens[calMeta.id], onTokenRefresh
      );
      if (expired) {
        delete syncTokens[calMeta.id];
        const retry = await googleCal.syncCalendar(u.googleTokens, calMeta.id, null, onTokenRefresh);
        events = retry.events;
        nextSyncToken = retry.nextSyncToken;
      }
      if (nextSyncToken) syncTokens[calMeta.id] = nextSyncToken;
      for (const raw of events) {
        const compositeId = raw.id + '@' + u.id;
        if (raw.status === 'cancelled') {
          const idx = db.googleEvents.findIndex(e => e.id === compositeId);
          if (idx >= 0) {
            db.googleEvents.splice(idx, 1);
            markDirty('googleEvents', compositeId, 'remove');
            deleted++;
          }
          continue;
        }
        const normalized = googleCal.normalizeEvent(raw, calMeta.id, calMeta.backgroundColor, u.googleAccount?.email);
        if (!normalized.start) continue;
        const entity = { ...normalized, id: compositeId, userId: u.id, lastSyncedAt: nowISO() };
        const existing = db.googleEvents.find(e => e.id === compositeId);
        if (existing) Object.assign(existing, entity);
        else db.googleEvents.push(entity);
        markDirty('googleEvents', entity, 'upsert');
        upserted++;
      }
    } catch (e) {
      console.error(`[google/sync] user=${u.id} cal=${calMeta.id}:`, e.message);
      errors.push({ calendarId: calMeta.id, error: e.message });
    }
  }
  u.googleSyncTokens = syncTokens;
  u.googleLastSyncAt = nowISO();
  saveEntity('users', u);
  return { upserted, deleted, errors };
}

/* Job automático — a cada 5min sincroniza Google Calendar dos usuários
   ativos (lastSeen < 30min). Filtro protege quota: 150 usuários * 12 syncs/h
   = 1800/h no pico, cai bem quando ninguém tá logado.
   Sequencial (await no loop) pra não estourar rate limit da Google em
   picos simultâneos. */
const GOOGLE_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const GOOGLE_AUTO_SYNC_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
let _googleSyncRunning = false;
async function runGoogleAutoSync() {
  if (_googleSyncRunning) return; // reentrada bloqueada (tick anterior ainda rodando)
  _googleSyncRunning = true;
  const startedAt = Date.now();
  let synced = 0, skipped = 0;
  try {
    const now = Date.now();
    // Snapshot da lista pra evitar surpresa se db.users mudar durante o loop.
    const candidates = (db.users || []).filter(u => {
      if (!u.googleTokens) return false;
      if (!(u.googleCalendars || []).some(c => c.selected)) return false;
      const seen = u.lastSeen ? Date.parse(u.lastSeen) : 0;
      if (!Number.isFinite(seen)) return false;
      return (now - seen) <= GOOGLE_AUTO_SYNC_ACTIVE_WINDOW_MS;
    });
    for (const u of candidates) {
      try {
        const r = await syncGoogleForUser(u);
        synced++;
        if ((r.upserted + r.deleted) > 0) {
          console.log(`[google/auto] user=${u.username || u.id} +${r.upserted} -${r.deleted}`);
        }
      } catch (e) {
        console.error('[google/auto] user=' + u.id + ':', e.message);
      }
    }
    skipped = (db.users || []).length - candidates.length;
  } finally {
    _googleSyncRunning = false;
    const took = Date.now() - startedAt;
    if (synced > 0) console.log(`[google/auto] tick ${synced} sync, ${skipped} skipped, ${took}ms`);
  }
}
// 1º tick 2min após boot (dá tempo do banco carregar), depois a cada 5min.
const _googleAutoBoot = setTimeout(runGoogleAutoSync, 2 * 60 * 1000);
const _googleAutoInterval = setInterval(runGoogleAutoSync, GOOGLE_AUTO_SYNC_INTERVAL_MS);

// Lista eventos Google do usuário — filtra por range de datas pra render eficiente.
// Só devolve os próprios eventos (privacidade), exceto admin que pode ver de outros
// (útil se admin quiser abrir a agenda de outro usuário).
app.get('/api/google/events', requireAuth, (req, res) => {
  const targetUserId = req.query.userId || req.user.id;
  if (targetUserId !== req.user.id && !req.user.isAdmin) {
    // Vista de time da agenda: qualquer usuário pode ver eventos de colegas que
    // compartilham ao menos 1 workspace com ele (mesma regra do seletor de time,
    // que lista wsUsers()). Admins aparecem em qualquer workspace. Sem overlap → 403.
    const target = db.users.find(u => u.id === targetUserId);
    const myWs = wsIdsFor(req.user);
    const targetWs = target ? (target.isAdmin ? myWs : (target.workspaces || [])) : [];
    const shares = !!target && targetWs.some(w => myWs.includes(w));
    if (!shares) {
      return res.status(403).json({ error: 'Sem permissão pra ver eventos de outro usuário' });
    }
  }
  const from = req.query.from || null; // 'YYYY-MM-DD'
  const to   = req.query.to   || null;
  const all = (db.googleEvents || []).filter(e => e.userId === targetUserId);
  const filtered = all.filter(e => {
    // Overlap: mantém eventos cujo range (start..end) intersecta com [from..to].
    if (from && e.end && e.end.slice(0,10) < from) return false;
    if (to && e.start && e.start.slice(0,10) > to) return false;
    return true;
  });
  res.json(filtered);
});

// Agrega horas em reunião do Google Calendar num período — usado pelo dashboard.
// Filtros: from/to (YYYY-MM-DD, inclusive), userId (opcional), workspaceId (opcional).
// Sem userId: soma todos os usuários do(s) workspace(s) acessíveis pelo requester.
// Sem workspaceId: soma workspaces do requester (admin vê todos).
// Ignora eventos allDay e declinados (selfResponseStatus === 'declined').
app.get('/api/google/meeting-hours', requireAuth, (req, res) => {
  const from = req.query.from || null;
  const to   = req.query.to   || null;
  const userId = req.query.userId || null;
  const wsId = req.query.workspaceId || null;

  // Escopo de usuários: se userId veio, restringe a ele; senão, todos os users
  // dos workspaces acessíveis (ou do wsId, se veio).
  const accessibleWs = wsIdsFor(req.user);
  let scopeWsIds = accessibleWs;
  if (wsId) {
    if (!accessibleWs.includes(wsId)) return res.status(403).json({ error: 'Squad fora do escopo' });
    scopeWsIds = [wsId];
  }
  const wsSet = new Set(scopeWsIds);
  let allowedUserIds;
  if (userId) {
    if (userId !== req.user.id && !req.user.isAdmin) {
      const target = db.users.find(u => u.id === userId);
      const targetWs = target ? (target.isAdmin ? scopeWsIds : (target.workspaces || [])) : [];
      const shares = !!target && targetWs.some(w => wsSet.has(w));
      if (!shares) return res.status(403).json({ error: 'Sem permissão' });
    }
    allowedUserIds = new Set([userId]);
  } else {
    allowedUserIds = new Set(db.users
      .filter(u => u.active !== false && (u.isAdmin || (u.workspaces || []).some(w => wsSet.has(w))))
      .map(u => u.id));
  }

  let totalMinutes = 0;
  let count = 0;
  for (const ev of (db.googleEvents || [])) {
    if (!allowedUserIds.has(ev.userId)) continue;
    if (ev.allDay || !ev.start) continue;
    if (ev.selfResponseStatus === 'declined') continue;
    const startYmd = String(ev.start).slice(0, 10);
    const endYmd = ev.end ? String(ev.end).slice(0, 10) : startYmd;
    if (from && endYmd < from) continue;
    if (to && startYmd > to) continue;
    const s = new Date(ev.start);
    const e = ev.end ? new Date(ev.end) : new Date(s.getTime() + 15 * 60000);
    const durMin = Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000));
    if (!durMin) continue;
    totalMinutes += durMin;
    count++;
  }
  res.json({ totalMinutes, hours: totalMinutes / 60, count });
});

// Re-fetch da lista de calendários (útil se o usuário criou/removeu no Google).
app.post('/api/google/refresh-calendars', requireAuth, async (req, res) => {
  const u = req.user;
  if (!u.googleTokens) return res.status(400).json({ error: 'Google Calendar não conectado' });
  try {
    const fresh = await googleCal.listCalendars(u.googleTokens, (newTokens) => {
      u.googleTokens = newTokens;
      saveEntity('users', u);
    });
    // Preserva seleções existentes; novos calendários vêm desmarcados por padrão.
    const selMap = Object.fromEntries((u.googleCalendars || []).map(c => [c.id, !!c.selected]));
    u.googleCalendars = fresh.map(c => ({
      ...c,
      selected: c.id in selMap ? selMap[c.id] : !!c.primary
    }));
    saveEntity('users', u);
    res.json({ calendars: u.googleCalendars });
  } catch (e) {
    console.error('[google/refresh-calendars]', e);
    res.status(500).json({ error: e.message || 'Erro ao consultar Google' });
  }
});

/* ── WORKSPACES (admin) ── */
app.get('/api/workspaces', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  res.json(db.workspaces.filter(w => ids.includes(w.id)));
});

app.post('/api/workspaces', requireAuth, adminOnly, (req, res) => {
  const { name, color } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome do squad é obrigatório' });
  const w = { id: uid(), name: String(name).trim(), color: color || '#7A00FF', createdAt: nowISO() };
  db.workspaces.push(w);
  saveEntity('workspaces', w);
  // o admin que criou passa a ter acesso
  if (!req.user.workspaces.includes(w.id)) {
    req.user.workspaces.push(w.id);
    saveEntity('users', req.user);
  }
  res.status(201).json(w);
});

app.put('/api/workspaces/:id', requireAuth, adminOnly, (req, res) => {
  const w = db.workspaces.find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ error: 'Squad não encontrado' });
  const { name, color } = req.body || {};
  if (typeof name === 'string' && name.trim()) w.name = name.trim();
  if (color) w.color = color;
  saveEntity('workspaces', w);
  res.json(w);
});

app.delete('/api/workspaces/:id', requireAuth, adminOnly, (req, res) => {
  if (db.workspaces.length <= 1) return res.status(400).json({ error: 'É preciso manter pelo menos um workspace' });
  const hasProjects = db.projects.some(p => p.workspaceId === req.params.id);
  if (hasProjects) return res.status(409).json({ error: 'Este squad possui projetos. Mova ou exclua-os antes.' });
  const orphanFlows = db.flows.filter(f => f.workspaceId === req.params.id);
  db.workspaces = db.workspaces.filter(x => x.id !== req.params.id);
  db.flows = db.flows.filter(f => f.workspaceId !== req.params.id);
  removeEntity('workspaces', req.params.id);
  orphanFlows.forEach(f => removeEntity('flows', f.id));
  db.users.forEach(u => {
    if ((u.workspaces || []).includes(req.params.id)) {
      u.workspaces = u.workspaces.filter(id => id !== req.params.id);
      saveEntity('users', u);
    }
  });
  res.json({ ok: true });
});

/* ── USUÁRIOS ── */
app.get('/api/users', requireAuth, (req, res) => res.json(db.users.map(publicUser)));

app.post('/api/users', requireAuth, adminOnly, (req, res) => {
  const { username, password, name, role, position, isAdmin, isModerator, workspaces, discordId, email } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (!uname || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
  if (db.users.some(u => u.username.toLowerCase() === uname)) {
    return res.status(409).json({ error: 'Este nome de usuário já existe' });
  }
  let did = null;
  if (discordId) {
    did = sanitizeDiscordId(discordId);
    if (!did) return res.status(400).json({ error: 'ID do Discord inválido. Cole o ID numérico do usuário (15–22 dígitos).' });
  }
  let mail = null;
  if (email) {
    if (!isValidEmail(email)) return res.status(400).json({ error: 'E-mail inválido.' });
    mail = String(email).trim().toLowerCase();
  }
  const wsList = Array.isArray(workspaces) ? workspaces.filter(id => db.workspaces.some(w => w.id === id)) : [];
  const user = {
    id: uid(), username: uname, name: String(name || uname).trim(),
    role: String(role || '').trim(),
    position: String(position || '').trim() || null,
    isAdmin: !!isAdmin,
    // Moderador só faz sentido se não for admin (admin já tem tudo). Silenciosamente ignora.
    isModerator: !isAdmin && !!isModerator,
    avatar: null,
    active: true, workspaces: wsList, discordId: did, email: mail,
    emailPrefs: defaultEmailPrefs(), createdAt: nowISO()
  };
  db.users.push(user);
  auth.setPassword(user.id, password);
  saveEntity('users', user);
  res.status(201).json(publicUser(user));
});

app.put('/api/users/:id', requireAuth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { name, role, position, isAdmin, isModerator, active, password, workspaces, discordId, email } = req.body || {};
  if (typeof name === 'string' && name.trim()) u.name = name.trim();
  if (typeof role === 'string') u.role = role.trim();
  if (typeof position === 'string') u.position = position.trim() || null;
  if (Array.isArray(workspaces)) {
    u.workspaces = workspaces.filter(id => db.workspaces.some(w => w.id === id));
  }
  if (discordId !== undefined) {
    if (discordId === null || discordId === '') {
      u.discordId = null;
    } else {
      const did = sanitizeDiscordId(discordId);
      if (!did) return res.status(400).json({ error: 'ID do Discord inválido. Cole o ID numérico do usuário (15–22 dígitos).' });
      u.discordId = did;
    }
  }
  if (email !== undefined) {
    if (email === null || email === '') {
      u.email = null;
    } else if (isValidEmail(email)) {
      u.email = String(email).trim().toLowerCase();
    } else {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
  }
  if (typeof isAdmin === 'boolean') {
    if (!isAdmin && u.isAdmin && db.users.filter(x => x.isAdmin && x.active !== false).length <= 1) {
      return res.status(400).json({ error: 'É preciso manter pelo menos um administrador ativo' });
    }
    u.isAdmin = isAdmin;
    // Admin absorve moderador — não fazem sentido juntos.
    if (isAdmin) u.isModerator = false;
  }
  if (typeof isModerator === 'boolean' && !u.isAdmin) {
    u.isModerator = isModerator;
  }
  if (typeof active === 'boolean') {
    if (!active && u.isAdmin && db.users.filter(x => x.isAdmin && x.active !== false).length <= 1) {
      return res.status(400).json({ error: 'É preciso manter pelo menos um administrador ativo' });
    }
    u.active = active;
    if (!active) auth.dropTokensFor(u.id);
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    auth.setPassword(u.id, password);
  }
  saveEntity('users', u);
  res.json(publicUser(u));
});

/* ── FUNÇÕES (roles) ── */
app.get('/api/roles', requireAuth, (req, res) => res.json(db.roles));

app.post('/api/roles', requireAuth, modOrAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome da função é obrigatório' });
  const trimmed = String(name).trim();
  if (db.roles.some(r => r.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'Essa função já existe' });
  }
  const r = { id: uid(), name: trimmed, createdAt: nowISO() };
  db.roles.push(r);
  saveEntity('roles', r);
  res.status(201).json(r);
});

app.put('/api/roles/:id', requireAuth, modOrAdmin, (req, res) => {
  const r = db.roles.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Função não encontrada' });
  const { name } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    const trimmed = name.trim();
    if (db.roles.some(x => x.id !== r.id && x.name.toLowerCase() === trimmed.toLowerCase())) {
      return res.status(409).json({ error: 'Essa função já existe' });
    }
    const oldName = r.name;
    r.name = trimmed;
    // Atualiza usuários que tinham a função antiga
    db.users.forEach(u => {
      if (u.role === oldName) {
        u.role = trimmed;
        saveEntity('users', u);
      }
    });
  }
  saveEntity('roles', r);
  res.json(r);
});

app.delete('/api/roles/:id', requireAuth, modOrAdmin, (req, res) => {
  const r = db.roles.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Função não encontrada' });
  db.roles = db.roles.filter(x => x.id !== req.params.id);
  removeEntity('roles', req.params.id);
  res.json({ ok: true });
});

/* ── TIPOS DE DEMANDA (rótulo organizacional dos fluxos) ──
   Biblioteca leve de nomes. O fluxo guarda o tipo como string (flow.demandType);
   esta lista serve só pro combobox e pra gestão (renomear/excluir). Excluir um
   tipo apenas o tira da biblioteca — fluxos e demandas existentes mantêm o valor. */
function demandTypeUsage() {
  const usage = {};
  (db.flows || []).forEach(f => {
    const t = String(f.demandType || '').trim().toLowerCase();
    if (t) usage[t] = (usage[t] || 0) + 1;
  });
  return usage;
}
/* Garante que um tipo usado por um fluxo esteja na biblioteca (evita tipos órfãos
   quando o usuário digita direto e salva sem passar pelo "Adicionar"). */
function ensureDemandTypeExists(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  if (!Array.isArray(db.demandTypes)) db.demandTypes = [];
  if (db.demandTypes.some(t => t.name.toLowerCase() === trimmed.toLowerCase())) return;
  const t = { id: uid(), name: trimmed.slice(0, 60), createdAt: nowISO() };
  db.demandTypes.push(t);
  saveEntity('demandTypes', t);
}
app.get('/api/demand-types', requireAuth, (req, res) => {
  const usage = demandTypeUsage();
  res.json((db.demandTypes || []).map(t => ({
    id: t.id, name: t.name, createdAt: t.createdAt,
    usageCount: usage[(t.name || '').toLowerCase()] || 0
  })));
});
app.post('/api/demand-types', requireAuth, modOrAdmin, (req, res) => {
  const trimmed = String((req.body || {}).name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Nome do tipo é obrigatório' });
  if (trimmed.length > 60) return res.status(400).json({ error: 'Nome muito longo (máx. 60)' });
  if (!Array.isArray(db.demandTypes)) db.demandTypes = [];
  if (db.demandTypes.some(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'Esse tipo já existe' });
  }
  const t = { id: uid(), name: trimmed, createdAt: nowISO() };
  db.demandTypes.push(t);
  saveEntity('demandTypes', t);
  broadcastChange('demandType', 'create', { id: t.id, byUserId: req.user.id });
  res.status(201).json(t);
});
app.put('/api/demand-types/:id', requireAuth, modOrAdmin, (req, res) => {
  const t = (db.demandTypes || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Tipo não encontrado' });
  const trimmed = String((req.body || {}).name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'Nome do tipo é obrigatório' });
  if (trimmed.length > 60) return res.status(400).json({ error: 'Nome muito longo (máx. 60)' });
  if (db.demandTypes.some(x => x.id !== t.id && x.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'Esse tipo já existe' });
  }
  const oldName = t.name;
  t.name = trimmed;
  saveEntity('demandTypes', t);
  // Propaga o rename pros fluxos que usavam o nome antigo (conserta em todo lugar).
  let touched = 0;
  if (oldName !== trimmed) {
    db.flows.forEach(f => {
      if (String(f.demandType || '') === oldName) {
        f.demandType = trimmed;
        saveEntity('flows', f);
        broadcastChange('flow', 'update', { id: f.id, workspaceId: f.workspaceId, byUserId: req.user.id });
        touched++;
      }
    });
  }
  broadcastChange('demandType', 'update', { id: t.id, byUserId: req.user.id });
  res.json({ ...t, flowsUpdated: touched });
});
app.delete('/api/demand-types/:id', requireAuth, modOrAdmin, (req, res) => {
  const t = (db.demandTypes || []).find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Tipo não encontrado' });
  db.demandTypes = db.demandTypes.filter(x => x.id !== req.params.id);
  removeEntity('demandTypes', req.params.id);
  // Fluxos/demandas mantêm o valor string — não são alterados.
  broadcastChange('demandType', 'delete', { id: req.params.id, byUserId: req.user.id });
  res.json({ ok: true });
});
/* Limpa o campo `demandType` (setando '') em todos os fluxos cujo valor case
   exatamente com `name`. Usado pelo botão "Limpar" da seção "Tipos órfãos"
   no modal Gerenciar Tipos — dá cabo dos valores livres que sobraram nos
   fluxos e ficavam poluindo o filtro do Dashboard. */
app.post('/api/demand-types/orphans/clear', requireAuth, modOrAdmin, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });
  let touched = 0;
  db.flows.forEach(f => {
    if (notDeleted(f) && String(f.demandType || '') === name) {
      f.demandType = '';
      saveEntity('flows', f);
      broadcastChange('flow', 'update', { id: f.id, workspaceId: f.workspaceId, byUserId: req.user.id });
      touched++;
    }
  });
  res.json({ ok: true, cleared: touched });
});

/* ── CARGOS (posições dentro de uma área) ──
   Ortogonal a `roles` — usuário tem role/área (ex: Criação) + cargo (ex: Diretor
   de Arte). Cargos são globais, não vinculados a área específica (por enquanto). */
app.get('/api/positions', requireAuth, (req, res) => res.json(db.positions || []));

app.post('/api/positions', requireAuth, modOrAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome do cargo é obrigatório' });
  const trimmed = String(name).trim();
  if (!Array.isArray(db.positions)) db.positions = [];
  if (db.positions.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
    return res.status(409).json({ error: 'Esse cargo já existe' });
  }
  const p = { id: uid(), name: trimmed, createdAt: nowISO() };
  db.positions.push(p);
  saveEntity('positions', p);
  res.status(201).json(p);
});

app.put('/api/positions/:id', requireAuth, modOrAdmin, (req, res) => {
  if (!Array.isArray(db.positions)) db.positions = [];
  const p = db.positions.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Cargo não encontrado' });
  const { name } = req.body || {};
  if (typeof name === 'string' && name.trim()) {
    const trimmed = name.trim();
    if (db.positions.some(x => x.id !== p.id && x.name.toLowerCase() === trimmed.toLowerCase())) {
      return res.status(409).json({ error: 'Esse cargo já existe' });
    }
    const oldName = p.name;
    p.name = trimmed;
    // Propaga rename pros usuários que tinham esse cargo
    db.users.forEach(u => {
      if (u.position === oldName) { u.position = trimmed; saveEntity('users', u); }
    });
  }
  saveEntity('positions', p);
  res.json(p);
});

app.delete('/api/positions/:id', requireAuth, modOrAdmin, (req, res) => {
  if (!Array.isArray(db.positions)) db.positions = [];
  const p = db.positions.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Cargo não encontrado' });
  db.positions = db.positions.filter(x => x.id !== req.params.id);
  removeEntity('positions', req.params.id);
  res.json({ ok: true });
});

/* ── TEMPLATES DE DEMANDA (filtrados por workspace acessível) ── */
app.get('/api/templates', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  res.json(db.templates.filter(t => ids.includes(t.workspaceId)));
});

app.post('/api/templates', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Nome do template é obrigatório' });
  const ws = b.workspaceId && canAccessWs(req.user, b.workspaceId) ? b.workspaceId : wsIdsFor(req.user)[0];
  if (!ws) return res.status(400).json({ error: 'Squad inválido' });
  const t = {
    id: uid(),
    workspaceId: ws,
    name: String(b.name).trim(),
    description: sanitizeCommentHtml(String(b.description || '')),
    briefing: normalizeUrlSrv(b.briefing),
    projectId: b.projectId || null,
    flowId: b.flowId || null,
    ownerId: b.ownerId || null,
    estimatedHours: Number(b.estimatedHours) > 0 ? Math.round(Number(b.estimatedHours) * 100) / 100 : null,
    priority: [1,2,3,4].includes(Number(b.priority)) ? Number(b.priority) : 3,
    attachments: sanitizeAttachments(b.attachments),
    createdBy: req.user.id,
    createdAt: nowISO()
  };
  db.templates.push(t);
  saveEntity('templates', t);
  res.status(201).json(t);
});

app.put('/api/templates/:id', requireAuth, (req, res) => {
  const t = db.templates.find(x => x.id === req.params.id);
  if (!t || !canAccessWs(req.user, t.workspaceId)) return res.status(404).json({ error: 'Template não encontrado' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim();
  if (typeof b.description === 'string') t.description = sanitizeCommentHtml(b.description);
  if (typeof b.briefing === 'string') t.briefing = normalizeUrlSrv(b.briefing);
  if (b.projectId !== undefined) t.projectId = b.projectId || null;
  if (b.flowId !== undefined) t.flowId = b.flowId || null;
  if (b.ownerId !== undefined) t.ownerId = b.ownerId || null;
  if (b.estimatedHours !== undefined) t.estimatedHours = Number(b.estimatedHours) > 0 ? Math.round(Number(b.estimatedHours) * 100) / 100 : null;
  if (b.priority !== undefined) t.priority = [1,2,3,4].includes(Number(b.priority)) ? Number(b.priority) : 3;
  if (b.attachments !== undefined) t.attachments = sanitizeAttachments(b.attachments);
  saveEntity('templates', t);
  res.json(t);
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  const t = db.templates.find(x => x.id === req.params.id);
  if (!t || !canAccessWs(req.user, t.workspaceId)) return res.status(404).json({ error: 'Template não encontrado' });
  db.templates = db.templates.filter(x => x.id !== req.params.id);
  removeEntity('templates', req.params.id);
  res.json({ ok: true });
});

/* ── CLIENTES (entidade nova — pai dos projetos) ──
   Cada cliente pertence a um workspace, tem metadados (segmento, links de
   drive, diretrizes) e status ativo/desativado. Desativar cascateia pros
   projetos. Exclusão é protegida por digitação do nome no frontend. */
app.get('/api/clients', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  res.json(db.clients.filter(c => ids.includes(c.workspaceId) && notDeleted(c)));
});
app.get('/api/clients/:id', requireAuth, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !notDeleted(c)) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(c);
});

function buildClientPayload(body, base) {
  // Helper que monta um cliente a partir de body, preservando defaults sensatos.
  const c = base || {};
  if (typeof body.name === 'string' && body.name.trim()) c.name = body.name.trim();
  if (typeof body.color === 'string' && body.color.trim()) c.color = body.color;
  if (typeof body.segment === 'string') c.segment = body.segment.trim();
  if (typeof body.driveFiles === 'string') c.driveFiles = normalizeUrlSrv(body.driveFiles);
  if (typeof body.brandAssets === 'string') c.brandAssets = normalizeUrlSrv(body.brandAssets);
  if (typeof body.guidelines === 'string') c.guidelines = body.guidelines;
  // roleAssignments: aceita legado { [area]: userId } ou novo { [area]: { [cargo]: userId } }
  if (body.roleAssignments && typeof body.roleAssignments === 'object') {
    c.roleAssignments = sanitizeRoleAssignments(body.roleAssignments);
  }
  if (body.avatar !== undefined) {
    if (!body.avatar) c.avatar = null;
    else if (String(body.avatar).startsWith('/uploads/')) c.avatar = body.avatar;
    else if (String(body.avatar).startsWith('data:image/')) {
      const saved = saveUploadFromDataUri(body.avatar, (c.name || 'cliente') + '-avatar');
      c.avatar = saved ? saved.url : null;
    }
  }
  return c;
}

app.post('/api/clients', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório' });
  let wsId = b.workspaceId;
  if (!wsId || !canAccessWs(req.user, wsId)) wsId = wsIdsFor(req.user)[0];
  // Bloqueia duplicado dentro do mesmo workspace (case-insensitive)
  const exists = db.clients.some(c =>
    c.workspaceId === wsId && (c.name || '').trim().toLowerCase() === b.name.trim().toLowerCase()
  );
  if (exists) return res.status(409).json({ error: 'Já existe um cliente com esse nome neste squad.' });
  const c = buildClientPayload(b, {
    id: uid(),
    workspaceId: wsId,
    name: '',
    color: '#7A00FF',
    avatar: null,
    segment: '',
    driveFiles: '',
    brandAssets: '',
    guidelines: '',
    active: true,
    createdAt: nowISO()
  });
  db.clients.push(c);
  saveEntity('clients', c);
  broadcastChange('client', 'create', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  refreshEntityLinkTitles('clients', c, null, 'client');
  res.status(201).json(c);
});

app.put('/api/clients/:id', requireAuth, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId)) return res.status(404).json({ error: 'Cliente não encontrado' });
  const b = req.body || {};
  // Checa duplicidade se renomeou
  if (typeof b.name === 'string' && b.name.trim() && b.name.trim().toLowerCase() !== (c.name || '').trim().toLowerCase()) {
    const dup = db.clients.some(x =>
      x.id !== c.id && x.workspaceId === c.workspaceId &&
      (x.name || '').trim().toLowerCase() === b.name.trim().toLowerCase()
    );
    if (dup) return res.status(409).json({ error: 'Já existe outro cliente com esse nome neste squad.' });
  }
  // Move pra outro workspace? Permitido pra admins, com revalidação
  if (b.workspaceId && b.workspaceId !== c.workspaceId && canAccessWs(req.user, b.workspaceId)) {
    c.workspaceId = b.workspaceId;
  }
  // Snapshot dos links ANTES de sobrescrever (pra só refazer o título se a URL mudou).
  const prevLinks = { driveFiles: c.driveFiles, brandAssets: c.brandAssets, driveFilesTitle: c.driveFilesTitle, brandAssetsTitle: c.brandAssetsTitle };
  const prevName = c.name;
  buildClientPayload(b, c);
  // Cascade rename: projeto guarda o NOME do cliente denormalizado em `p.client`
  // (usado em filtros, listas, ordenação). Sem cascade, renomear o cliente não
  // atualiza a UI de demandas/dashboard até refetch manual da lista de projetos.
  let projectsAffected = false;
  if (typeof b.name === 'string' && b.name.trim() && c.name !== prevName) {
    db.projects.forEach(p => {
      if (p.clientId === c.id && p.client !== c.name) {
        p.client = c.name;
        saveEntity('projects', p);
        projectsAffected = true;
      }
    });
  }
  // Cascade: desativar cliente desativa todos os projetos vinculados
  if (typeof b.active === 'boolean') {
    const wasActive = c.active !== false;
    c.active = b.active;
    if (wasActive && !b.active) {
      db.projects.forEach(p => {
        if (p.clientId === c.id && p.active !== false) {
          p.active = false;
          saveEntity('projects', p);
          projectsAffected = true;
        }
      });
    }
  }
  // O `placeholder` (auto-criado pra órfãos) some quando o usuário edita o nome
  if (b.name && c.placeholder) delete c.placeholder;
  saveEntity('clients', c);
  broadcastChange('client', 'update', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  // Se projetos foram atualizados (rename cascade ou disable), avisa clientes
  // pra refetch — isso propaga o novo nome do cliente em listas e dashboard.
  if (projectsAffected) {
    broadcastChange('project', 'bulk', { workspaceId: c.workspaceId, byUserId: req.user.id });
  }
  refreshEntityLinkTitles('clients', c, prevLinks, 'client');
  res.json(c);
});

app.delete('/api/clients/:id', requireAuth, modOrAdmin, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !notDeleted(c)) return res.status(404).json({ error: 'Cliente não encontrado' });
  const linkedProjects = db.projects.filter(p => p.clientId === c.id && notDeleted(p));
  if (linkedProjects.length) {
    return res.status(409).json({
      error: `Este cliente tem ${linkedProjects.length} projeto(s) vinculado(s). Exclua ou mova os projetos antes.`
    });
  }
  softDelete('clients', c, req.user.id);
  broadcastChange('client', 'delete', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  res.json({ ok: true, undoable: true, purgeAt: Date.parse(c.deletedAt) + UNDO_PURGE_MS });
});
app.post('/api/clients/:id/undelete', requireAuth, (req, res) => {
  // Aceita entidade mesmo deletada — precisa achar pra restaurar.
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !c.deletedAt) return res.status(404).json({ error: 'Cliente não encontrado ou não estava excluído' });
  undelete('clients', c);
  broadcastChange('client', 'update', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  res.json(c);
});

/* ── MODELOS DE CLIENTE (onboarding em 1 clique) ──
   Um clientTemplate é um snapshot reutilizável de um cliente:
   metadados (segmento, diretrizes) + projetos + fluxos exclusivos.
   Não inclui demandas, agendamentos ou roleAssignments (sempre vazios
   no cliente novo). Aplicar um template cria todas as entidades de uma vez. */
app.get('/api/client-templates', requireAuth, (req, res) => {
  // Modelos são GLOBAIS: qualquer usuário autenticado vê a biblioteca inteira.
  // O workspaceId (quando presente em modelos antigos) é ignorado — o cliente
  // criado a partir do modelo é sempre no ws que o usuário escolher.
  res.json((db.clientTemplates || []).filter(notDeleted));
});

app.post('/api/client-templates', requireAuth, (req, res) => {
  const b = req.body || {};
  const sourceClientId = b.sourceClientId;
  const tplName = String(b.name || '').trim();
  if (!tplName) return res.status(400).json({ error: 'Dê um nome ao modelo.' });

  // MODO 2: criar modelo VAZIO. Modelos são globais — workspaceId nem é setado
  // (nem faz sentido; o modelo vira "biblioteca compartilhada").
  if (!sourceClientId) {
    const tpl = {
      id: uid(),
      workspaceId: null,
      name: tplName,
      color: (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) ? b.color : '#7A00FF',
      segment: '', driveFiles: '', brandAssets: '', guidelines: '',
      projects: [],
      createdAt: nowISO(),
      createdBy: req.user.id
    };
    db.clientTemplates.push(tpl);
    saveEntity('clientTemplates', tpl);
    return res.status(201).json(tpl);
  }

  // MODO 1 (original): snapshot de um cliente existente. Cliente segue sendo
  // workspace-scoped (autor precisa acessá-lo), mas o modelo resultante é global.
  const c = db.clients.find(x => x.id === sourceClientId);
  if (!c || !canAccessWs(req.user, c.workspaceId)) return res.status(404).json({ error: 'Cliente não encontrado.' });

  // Snapshot dos projetos do cliente (só ativos por default)
  const projs = db.projects
    .filter(p => p.clientId === c.id && p.active !== false)
    .map(p => {
      const flows = db.flows
        .filter(f => f.projectId === p.id)
        .map(f => ({
          name: f.name, demandType: f.demandType || '',
          // Stages sem id — geramos novos ao aplicar
          stages: (f.stages || []).map(s => ({
            label: s.label, color: s.color, done: !!s.done,
            roleFilter: s.roleFilter || null,
            responsibleRole: s.responsibleRole || null,
            deadlineDays: s.deadlineDays || null
          }))
        }));
      return {
        name: p.name, color: p.color,
        driveFiles: p.driveFiles || '', brandAssets: p.brandAssets || '',
        guidelines: p.guidelines || '', flows
      };
    });

  const tpl = {
    id: uid(),
    workspaceId: null, // modelos são globais
    name: tplName,
    color: c.color || '#7A00FF',
    segment: c.segment || '',
    driveFiles: c.driveFiles || '',
    brandAssets: c.brandAssets || '',
    guidelines: c.guidelines || '',
    projects: projs,
    createdAt: nowISO(),
    createdBy: req.user.id
  };
  db.clientTemplates.push(tpl);
  saveEntity('clientTemplates', tpl);
  res.status(201).json(tpl);
});

app.get('/api/client-templates/:id', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  res.json(t);
});

/* Edita metadados do modelo — nome, cor, guidelines, drive/brand assets.
   Pra edição de PROJETOS e FLUXOS do modelo, ver endpoints dedicados abaixo. */
app.put('/api/client-templates/:id', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim();
  if (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) t.color = b.color;
  if (typeof b.segment === 'string')    t.segment    = b.segment;
  if (typeof b.driveFiles === 'string') t.driveFiles = b.driveFiles;
  if (typeof b.brandAssets === 'string')t.brandAssets= b.brandAssets;
  if (typeof b.guidelines === 'string') t.guidelines = b.guidelines;
  saveEntity('clientTemplates', t);
  res.json(t);
});

/* Adiciona/edita/remove um PROJETO dentro do modelo. */
app.post('/api/client-templates/:id/projects', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome do projeto é obrigatório.' });
  if (!Array.isArray(t.projects)) t.projects = [];
  t.projects.push({
    name,
    color: (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) ? b.color : (t.color || '#7A00FF'),
    driveFiles: String(b.driveFiles || ''),
    brandAssets: String(b.brandAssets || ''),
    guidelines: String(b.guidelines || ''),
    flows: []
  });
  saveEntity('clientTemplates', t);
  res.json(t);
});
app.put('/api/client-templates/:id/projects/:pIdx', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const pIdx = parseInt(req.params.pIdx, 10);
  const ptpl = t.projects?.[pIdx];
  if (!ptpl) return res.status(400).json({ error: 'Projeto inválido.' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) ptpl.name = b.name.trim();
  if (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) ptpl.color = b.color;
  if (typeof b.driveFiles === 'string')  ptpl.driveFiles  = b.driveFiles;
  if (typeof b.brandAssets === 'string') ptpl.brandAssets = b.brandAssets;
  if (typeof b.guidelines === 'string')  ptpl.guidelines  = b.guidelines;
  saveEntity('clientTemplates', t);
  res.json(t);
});
app.delete('/api/client-templates/:id/projects/:pIdx', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const pIdx = parseInt(req.params.pIdx, 10);
  if (!Number.isInteger(pIdx) || pIdx < 0 || !Array.isArray(t.projects) || pIdx >= t.projects.length) {
    return res.status(400).json({ error: 'Projeto inválido.' });
  }
  t.projects.splice(pIdx, 1);
  saveEntity('clientTemplates', t);
  res.json(t);
});

/* Adiciona um FLUXO novo dentro de um projeto do modelo E replica esse fluxo
   em todos os clientes existentes que foram criados A PARTIR desse modelo
   (matching por client.fromClientTemplateId === template.id). O projeto
   correspondente no cliente é achado por NOME — se ninguém renomeou funciona. */
app.post('/api/client-templates/:id/projects/:pIdx/flows', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const pIdx = parseInt(req.params.pIdx, 10);
  if (!Number.isInteger(pIdx) || pIdx < 0 || !Array.isArray(t.projects) || pIdx >= t.projects.length) {
    return res.status(400).json({ error: 'Projeto inválido no modelo.' });
  }
  const ptpl = t.projects[pIdx];
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome do fluxo é obrigatório.' });
  const stages = Array.isArray(b.stages) ? sanitizeStages(b.stages.map(s => ({ ...s, id: uid() }))) : null;
  if (!stages) return res.status(400).json({ error: 'O fluxo precisa de pelo menos 2 etapas com nome.' });
  // Fluxo do modelo: área/responsibleRole é decisão de cliente (matriz Área×Cargo)
  // — modelo só guarda a forma. Icon persiste (lucide/URL/data URI extraído).
  const ftpl = {
    name,
    icon: sanitizeFlowIcon(b.icon, name),
    demandType: String(b.demandType || ''),
    // Stages guardadas SEM id nem responsibleRole — id novo por instância, área por cliente.
    stages: stages.map(s => ({ label: s.label, color: s.color, done: !!s.done,
      deadlineDays: s.deadlineDays || null })),
    defaultDescription: typeof b.defaultDescription === 'string' ? sanitizeCommentHtml(b.defaultDescription) : '',
    defaultChecklist: Array.isArray(b.defaultChecklist) ? sanitizeChecklistTemplate(b.defaultChecklist) : [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  if (!Array.isArray(ptpl.flows)) ptpl.flows = [];
  ptpl.flows.push(ftpl);
  saveEntity('clientTemplates', t);
  ensureDemandTypeExists(ftpl.demandType); // registra o tipo na biblioteca se for novo

  // REPLICAÇÃO: pra cada cliente criado desse modelo, procura projeto com o mesmo
  // nome e cria o fluxo lá. Se o projeto foi renomeado no cliente, skippa (log).
  const replicated = [];
  const skippedClients = [];
  const targetClients = db.clients.filter(c => c.fromClientTemplateId === t.id && notDeleted(c));
  for (const client of targetClients) {
    const proj = db.projects.find(p => p.clientId === client.id && p.name === ptpl.name && notDeleted(p));
    if (!proj) { skippedClients.push(client.id); continue; }
    const flow = {
      id: uid(), workspaceId: proj.workspaceId,
      // Fluxos pertencem ao CLIENTE, não ao projeto — projectId fica null.
      projectId: null,
      clientId: client.id, client: client.name,
      icon: ftpl.icon || null,
      name: ftpl.name, demandType: ftpl.demandType,
      defaultDescription: ftpl.defaultDescription || '',
      defaultChecklist: (ftpl.defaultChecklist || []).map(it => ({ text: it.text })),
      // Regenera stages com IDs novos por instância.
      stages: ftpl.stages.map(s => ({ ...s, id: uid() })),
      createdAt: nowISO()
    };
    db.flows.push(flow);
    saveEntity('flows', flow);
    replicated.push({ clientId: client.id, flowId: flow.id });
    broadcastChange('flow', 'create', { id: flow.id, workspaceId: proj.workspaceId, byUserId: req.user.id });
  }
  res.json({ template: t, replicatedIn: replicated.length, skippedClients: skippedClients.length });
});

/* Edita um fluxo existente dentro de um projeto do modelo. Aceita name,
   demandType, defaultDescription, defaultChecklist e stages completos.
   Edição do modelo NÃO propaga automaticamente pros clientes existentes —
   propagação é só na CRIAÇÃO de fluxos novos. Motivo: clientes podem ter
   customizado fluxos antigos e sobrescrever silenciosamente seria destrutivo. */
app.put('/api/client-templates/:id/projects/:pIdx/flows/:fIdx', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const pIdx = parseInt(req.params.pIdx, 10);
  const fIdx = parseInt(req.params.fIdx, 10);
  const ptpl = t.projects?.[pIdx];
  const ftpl = ptpl?.flows?.[fIdx];
  if (!ftpl) return res.status(400).json({ error: 'Fluxo inválido.' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) ftpl.name = b.name.trim().slice(0, 120);
  if (typeof b.demandType === 'string')      { ftpl.demandType = b.demandType.trim().slice(0, 60); ensureDemandTypeExists(ftpl.demandType); }
  if (typeof b.defaultDescription === 'string') ftpl.defaultDescription = sanitizeCommentHtml(b.defaultDescription);
  if (Array.isArray(b.defaultChecklist))       ftpl.defaultChecklist   = sanitizeChecklistTemplate(b.defaultChecklist);
  if (b.icon !== undefined) ftpl.icon = sanitizeFlowIcon(b.icon, ftpl.name);
  if (Array.isArray(b.stages)) {
    const clean = sanitizeStages(b.stages.map(s => ({ ...s, id: uid() })));
    if (!clean) return res.status(400).json({ error: 'O fluxo precisa de pelo menos 2 etapas com nome.' });
    // Grava SEM id nem responsibleRole — IDs são gerados por instância, área é decisão do cliente.
    ftpl.stages = clean.map(s => ({
      label: s.label, color: s.color, done: !!s.done,
      deadlineDays: s.deadlineDays || null
    }));
  }
  ftpl.updatedAt = nowISO(); // usado no sort "Última modificação" da tela de Modelos
  saveEntity('clientTemplates', t);
  res.json(t);
});

/* Duplica um fluxo dentro do MESMO projeto do modelo. Copia name + " - Cópia",
   icon, demandType, stages, description e checklist. Não replica em clientes
   vinculados — o usuário duplica pra editar antes de propagar. */
app.post('/api/client-templates/:id/projects/:pIdx/flows/:fIdx/duplicate', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const pIdx = parseInt(req.params.pIdx, 10);
  const fIdx = parseInt(req.params.fIdx, 10);
  const ptpl = t.projects?.[pIdx];
  const src = ptpl?.flows?.[fIdx];
  if (!src) return res.status(400).json({ error: 'Fluxo inválido.' });
  const copy = {
    name: (src.name || 'Fluxo').slice(0, 100) + ' - Cópia',
    icon: src.icon || null,
    demandType: src.demandType || '',
    // deep copy pra não compartilhar refs de arrays/objects entre original e cópia
    stages: (src.stages || []).map(s => ({ ...s })),
    defaultDescription: src.defaultDescription || '',
    defaultChecklist: (src.defaultChecklist || []).map(it => ({ text: it.text })),
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  ptpl.flows.push(copy);
  saveEntity('clientTemplates', t);
  res.json(t);
});
app.delete('/api/client-templates/:id/projects/:pIdx/flows/:fIdx', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const pIdx = parseInt(req.params.pIdx, 10);
  const fIdx = parseInt(req.params.fIdx, 10);
  const ptpl = t.projects?.[pIdx];
  if (!ptpl || !Array.isArray(ptpl.flows) || fIdx < 0 || fIdx >= ptpl.flows.length) {
    return res.status(400).json({ error: 'Fluxo inválido.' });
  }
  ptpl.flows.splice(fIdx, 1);
  saveEntity('clientTemplates', t);
  res.json(t);
});

app.delete('/api/client-templates/:id', requireAuth, (req, res) => {
  const t = db.clientTemplates.find(x => x.id === req.params.id);
  if (!t || !notDeleted(t)) return res.status(404).json({ error: 'Modelo não encontrado.' });
  softDelete('clientTemplates', t, req.user.id);
  res.json({ ok: true, undoable: true, purgeAt: Date.parse(t.deletedAt) + UNDO_PURGE_MS });
});

/* Aplica um template criando cliente + projetos + fluxos.
   Body: { templateId, name, workspaceId? }
   Tudo dentro de uma operação atômica do ponto de vista do request — se algo
   falhar no meio, abortamos e devolvemos o que foi criado pra rollback manual
   (raro, mas registrado pra debug). */
app.post('/api/clients/from-template', requireAuth, (req, res) => {
  const b = req.body || {};
  const tpl = db.clientTemplates.find(t => t.id === b.templateId);
  if (!tpl) return res.status(404).json({ error: 'Modelo não encontrado.' });
  // Modelo é global — o workspace do cliente vem SEMPRE do body (o switcher do
  // topbar); fallback pro primeiro workspace acessível se não veio explícito.
  const wsId = b.workspaceId && canAccessWs(req.user, b.workspaceId) ? b.workspaceId : wsIdsFor(req.user)[0];
  if (!wsId || !canAccessWs(req.user, wsId)) return res.status(403).json({ error: 'Sem acesso ao squad.' });
  const newName = String(b.name || '').trim();
  if (!newName) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
  // Bloqueia duplicidade
  if (db.clients.some(c => c.workspaceId === wsId && (c.name || '').trim().toLowerCase() === newName.toLowerCase())) {
    return res.status(409).json({ error: 'Já existe um cliente com esse nome neste squad.' });
  }

  const createdProjects = [];
  const createdFlows = [];
  const client = {
    id: uid(),
    workspaceId: wsId,
    name: newName,
    color: tpl.color || '#7A00FF',
    avatar: null,
    segment: tpl.segment || '',
    driveFiles: tpl.driveFiles || '',
    brandAssets: tpl.brandAssets || '',
    guidelines: tpl.guidelines || '',
    // Rastreamento pra replicar fluxos novos do modelo neste cliente depois.
    // Não é acoplamento forte: se o modelo for excluído, o cliente segue vivo.
    fromClientTemplateId: tpl.id,
    active: true,
    createdAt: nowISO()
  };
  db.clients.push(client);
  saveEntity('clients', client);

  for (const ptpl of (tpl.projects || [])) {
    const project = {
      id: uid(), workspaceId: wsId, name: ptpl.name,
      clientId: client.id, client: client.name,
      color: ptpl.color || client.color || '#7A00FF',
      avatar: null,
      driveFiles: ptpl.driveFiles || '',
      brandAssets: ptpl.brandAssets || '',
      guidelines: ptpl.guidelines || '',
      active: true, createdAt: nowISO()
    };
    db.projects.push(project);
    saveEntity('projects', project);
    createdProjects.push(project);

    for (const ftpl of (ptpl.flows || [])) {
      const stages = sanitizeStages((ftpl.stages || []).map(s => ({ ...s, id: uid() })));
      if (!stages) continue;
      const flow = {
        id: uid(), workspaceId: wsId, projectId: project.id,
        clientId: client.id, client: client.name,
        // Herda o ícone do fluxo no template (mesmo comportamento da rota de
        // replicação incremental — server.js:2349). O `null` hardcoded aqui
        // era um esquecimento antigo, os demais campos do template já vinham.
        icon: ftpl.icon || null,
        name: ftpl.name, demandType: ftpl.demandType || '',
        // Descrição e checklist padrão do template também estavam sendo perdidos
        // na criação inicial (só a replicação incremental copiava). Iguala aqui.
        defaultDescription: ftpl.defaultDescription || '',
        defaultChecklist: (ftpl.defaultChecklist || []).map(it => ({ text: it.text })),
        stages, createdAt: nowISO()
      };
      db.flows.push(flow);
      saveEntity('flows', flow);
      createdFlows.push(flow);
    }
  }

  broadcastChange('client', 'create', { id: client.id, workspaceId: wsId, byUserId: req.user.id });
  broadcastChange('project', 'create', { workspaceId: wsId, byUserId: req.user.id });
  broadcastChange('flow', 'create', { workspaceId: wsId, byUserId: req.user.id });

  res.status(201).json({
    client,
    counts: { projects: createdProjects.length, flows: createdFlows.length }
  });
});

/* ── PROJETOS (filtrados por workspace acessível) ── */
app.get('/api/projects', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  res.json(db.projects.filter(p => ids.includes(p.workspaceId) && notDeleted(p)));
});
app.get('/api/projects/:id', requireAuth, (req, res) => {
  const p = db.projects.find(x => x.id === req.params.id);
  if (!p || !canAccessWs(req.user, p.workspaceId) || !notDeleted(p)) return res.status(404).json({ error: 'Projeto não encontrado' });
  res.json(p);
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, client, clientId, color, avatar, driveFiles, brandAssets, guidelines, roleAssignments } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome do projeto é obrigatório' });
  // Cliente é obrigatório e tem que existir; workspace deriva do cliente.
  let clientEntity = null;
  if (clientId) {
    clientEntity = db.clients.find(c => c.id === clientId);
    if (!clientEntity) return res.status(400).json({ error: 'Cliente inválido. Cadastre o cliente na aba "Clientes" antes.' });
  } else if (client && String(client).trim()) {
    const cname = String(client).trim();
    clientEntity = db.clients.find(c => (c.name || '').toLowerCase() === cname.toLowerCase());
    if (!clientEntity) return res.status(400).json({ error: `Cliente "${cname}" não cadastrado. Crie em "Clientes" antes.` });
  } else {
    return res.status(400).json({ error: 'Selecione um cliente cadastrado pro projeto.' });
  }
  if (!canAccessWs(req.user, clientEntity.workspaceId)) {
    return res.status(403).json({ error: 'Sem acesso ao squad deste cliente.' });
  }
  let avatarUrl = null;
  if (avatar) {
    if (String(avatar).startsWith('/uploads/')) avatarUrl = avatar;
    else if (String(avatar).startsWith('data:image/')) {
      const saved = saveUploadFromDataUri(avatar, String(name).trim() + '-avatar');
      avatarUrl = saved ? saved.url : null;
    }
  }
  // roleAssignments: se veio explicitamente no body usa, senão copia do cliente.
  // Após criado, projeto é independente — edições no cliente NÃO se propagam.
  let initialAssigns = {};
  if (roleAssignments && typeof roleAssignments === 'object') {
    initialAssigns = sanitizeRoleAssignments(roleAssignments);
  } else if (clientEntity.roleAssignments && typeof clientEntity.roleAssignments === 'object') {
    // Deep clone pra não compartilhar referência do nested {cargo: uid} com o cliente
    initialAssigns = sanitizeRoleAssignments(clientEntity.roleAssignments);
  }
  const p = {
    id: uid(), workspaceId: clientEntity.workspaceId, name: String(name).trim(),
    clientId: clientEntity.id,
    client: clientEntity.name, // legacy field, mantém sincronizado
    color: color || '#7A00FF',
    avatar: avatarUrl,
    driveFiles: typeof driveFiles === 'string' ? normalizeUrlSrv(driveFiles) : '',
    brandAssets: typeof brandAssets === 'string' ? normalizeUrlSrv(brandAssets) : '',
    guidelines: typeof guidelines === 'string' ? guidelines : '',
    roleAssignments: initialAssigns,
    active: true, createdAt: nowISO()
  };
  db.projects.push(p);
  saveEntity('projects', p);
  broadcastChange('project', 'create', { id: p.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  refreshEntityLinkTitles('projects', p, null, 'project');
  res.status(201).json(p);
});

app.put('/api/projects/:id', requireAuth, (req, res) => {
  const p = db.projects.find(x => x.id === req.params.id);
  if (!p || !canAccessWs(req.user, p.workspaceId)) return res.status(404).json({ error: 'Projeto não encontrado' });
  const { name, client, clientId, color, active, workspaceId, avatar, driveFiles, brandAssets, guidelines, roleAssignments } = req.body || {};
  // Snapshot dos links ANTES de sobrescrever (só refaz o título se a URL mudou).
  const prevLinks = { driveFiles: p.driveFiles, brandAssets: p.brandAssets, driveFilesTitle: p.driveFilesTitle, brandAssetsTitle: p.brandAssetsTitle };
  if (typeof name === 'string' && name.trim()) p.name = name.trim();
  if (typeof driveFiles === 'string') p.driveFiles = normalizeUrlSrv(driveFiles);
  if (typeof brandAssets === 'string') p.brandAssets = normalizeUrlSrv(brandAssets);
  if (typeof guidelines === 'string') p.guidelines = guidelines;
  // roleAssignments: substituição integral (mesmo padrão do cliente).
  // Edição no projeto é INDEPENDENTE do cliente — não propaga.
  if (roleAssignments && typeof roleAssignments === 'object') {
    p.roleAssignments = sanitizeRoleAssignments(roleAssignments);
  }
  // Re-vincular a outro cliente (ou nenhum)
  if (clientId !== undefined) {
    if (!clientId) { p.clientId = null; p.client = ''; }
    else {
      const c = db.clients.find(x => x.id === clientId && x.workspaceId === p.workspaceId);
      if (!c) return res.status(400).json({ error: 'Cliente inválido' });
      p.clientId = c.id;
      p.client = c.name;
    }
  } else if (typeof client === 'string') {
    // Compat por nome: só aceita se o cliente JÁ existe.
    if (!client.trim()) {
      return res.status(400).json({ error: 'Selecione um cliente cadastrado pro projeto.' });
    }
    const c = db.clients.find(x => x.workspaceId === p.workspaceId && (x.name || '').toLowerCase() === client.trim().toLowerCase());
    if (!c) return res.status(400).json({ error: `Cliente "${client.trim()}" não cadastrado. Crie em "Clientes" antes.` });
    p.clientId = c.id;
    p.client = c.name;
  }
  if (color) p.color = color;
  if (typeof active === 'boolean') p.active = active;
  if (avatar !== undefined) {
    if (!avatar) p.avatar = null;
    else if (String(avatar).startsWith('/uploads/')) p.avatar = avatar;
    else if (String(avatar).startsWith('data:image/')) {
      const saved = saveUploadFromDataUri(avatar, p.name + '-avatar');
      p.avatar = saved ? saved.url : null;
    } else p.avatar = null;
  }
  if (workspaceId && canAccessWs(req.user, workspaceId)) {
    p.workspaceId = workspaceId;
    db.flows.forEach(f => { if (f.projectId === p.id) { f.workspaceId = workspaceId; saveEntity('flows', f); } });
    db.demands.forEach(d => { if (d.projectId === p.id) { d.workspaceId = workspaceId; saveEntity('demands', d); } });
  }
  saveEntity('projects', p);
  broadcastChange('project', 'update', { id: p.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  refreshEntityLinkTitles('projects', p, prevLinks, 'project');
  res.json(p);
});

app.delete('/api/projects/:id', requireAuth, modOrAdmin, (req, res) => {
  const p = db.projects.find(x => x.id === req.params.id);
  if (!p || !canAccessWs(req.user, p.workspaceId) || !notDeleted(p)) return res.status(404).json({ error: 'Projeto não encontrado' });
  const force = req.query.force === '1' || req.body?.force === true;
  const linkedDemands = db.demands.filter(d => d.projectId === req.params.id && notDeleted(d));
  if (linkedDemands.length && !force) {
    return res.status(409).json({ error: `Este projeto possui ${linkedDemands.length} demanda(s) vinculada(s).`, demands: linkedDemands.length });
  }
  // Soft delete em cascata: projeto + demandas vinculadas. Fluxos exclusivos ficam
  // como estão (não deletamos hard) — reaparecem se o projeto for restaurado.
  softDelete('projects', p, req.user.id);
  linkedDemands.forEach(d => softDelete('demands', d, req.user.id));
  broadcastChange('project', 'delete', { id: req.params.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  res.json({ ok: true, deleted: { demands: linkedDemands.length }, undoable: true, purgeAt: Date.parse(p.deletedAt) + UNDO_PURGE_MS });
});
app.post('/api/projects/:id/undelete', requireAuth, (req, res) => {
  const p = db.projects.find(x => x.id === req.params.id);
  if (!p || !canAccessWs(req.user, p.workspaceId) || !p.deletedAt) return res.status(404).json({ error: 'Projeto não encontrado ou não estava excluído' });
  // Restaura projeto + demandas que caíram junto na mesma janela (~5s)
  const projDelTs = Date.parse(p.deletedAt);
  undelete('projects', p);
  db.demands.forEach(d => {
    if (d.projectId === p.id && d.deletedAt && Math.abs(Date.parse(d.deletedAt) - projDelTs) < 5000) {
      undelete('demands', d);
    }
  });
  broadcastChange('project', 'update', { id: p.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  res.json(p);
});

/* Duplicar projeto (+ fluxo exclusivo) */
app.post('/api/projects/:id/duplicate', requireAuth, (req, res) => {
  const p = db.projects.find(x => x.id === req.params.id);
  if (!p || !canAccessWs(req.user, p.workspaceId)) return res.status(404).json({ error: 'Projeto não encontrado' });
  const copy = {
    id: uid(), workspaceId: p.workspaceId, name: p.name + ' - Cópia',
    client: p.client, color: p.color, active: true, createdAt: nowISO()
  };
  db.projects.push(copy);
  saveEntity('projects', copy);
  // duplica os fluxos exclusivos do projeto original
  db.flows.filter(f => f.projectId === p.id).forEach(f => {
    const nf = {
      id: uid(), workspaceId: f.workspaceId, projectId: copy.id,
      name: f.name, demandType: f.demandType,
      stages: f.stages.map(s => ({ ...s, id: uid() })),
      createdAt: nowISO()
    };
    db.flows.push(nf);
    saveEntity('flows', nf);
  });
  res.status(201).json(copy);
});

/* ── FLUXOS ── */
app.get('/api/flows', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  res.json(db.flows.filter(f => ids.includes(f.workspaceId) && notDeleted(f)));
});

/* GETs singulares — usados pelo SSE do cliente pra refetch pontual (não a lista inteira).
   Cada um valida acesso ao workspace da entidade. */
app.get('/api/flows/:id', requireAuth, (req, res) => {
  const f = db.flows.find(x => x.id === req.params.id);
  if (!f || !canAccessWs(req.user, f.workspaceId)) return res.status(404).json({ error: 'Fluxo não encontrado' });
  res.json(f);
});

/* Normaliza icon do fluxo (aceita lucide:X, URL /uploads, ou data URI que
   extrai pro disco). Retorna string pronta pra persistir ou null. */
function sanitizeFlowIcon(icon, nameHint) {
  if (!icon || typeof icon !== 'string') return null;
  if (icon.startsWith('/uploads/') || icon.startsWith('lucide:')) return icon;
  if (icon.startsWith('data:image/')) {
    const saved = saveUploadFromDataUri(icon, (nameHint || 'flow') + '-icon');
    return saved ? saved.url : null;
  }
  return null;
}

/* Normaliza roleAssignments aceitando os dois formatos:
   - Legado: { [area]: userId }                    (string)
   - Novo:   { [area]: { [cargo]: userId, ... } }  (matriz Área × Cargo)
   Descarta chaves/valores vazios e força userId a string. Se o valor for objeto
   mas ficar vazio, remove a área do mapa. */
function sanitizeRoleAssignments(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [role, val] of Object.entries(raw)) {
    const r = String(role || '').trim();
    if (!r) continue;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const inner = {};
      for (const [cargo, uid] of Object.entries(val)) {
        const c = String(cargo || '').trim();
        if (!c || !uid) continue;
        inner[c] = String(uid);
      }
      if (Object.keys(inner).length) out[r] = inner;
    } else if (val) {
      const s = String(val);
      // Descarta valores corrompidos por versão antiga que chamava String(obj) sobre { [cargo]: uid }
      if (s === '[object Object]') continue;
      out[r] = s;
    }
    // val falsy (null/'') → omitido, remove a área do mapa
  }
  return out;
}

/* Lista de itens default de checklist do fluxo. Cada item só tem text. */
function sanitizeChecklistTemplate(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(it => ({ text: String((it && it.text) || '').trim() }))
    .filter(it => it.text)
    .slice(0, 50);
}

function sanitizeStages(stages) {
  if (!Array.isArray(stages)) return null;
  const clean = stages.map(s => ({
    id: s.id || uid(),
    label: String(s.label || '').trim(),
    color: s.color || '#7A00FF',
    done: !!s.done,
    // roleFilter: função da etapa (UI usa pra filtrar o dropdown de responsável).
    // responsibleId (user específico) e responsibleRole ("padrão do cliente"
    // resolvido via client.roleAssignments) são mutuamente exclusivos. Se ambos vierem, role vence.
    roleFilter: s.roleFilter ? String(s.roleFilter).trim() : (s.responsibleRole ? String(s.responsibleRole).trim() : null),
    responsibleId: s.responsibleRole ? null : (s.responsibleId || null),
    responsibleRole: s.responsibleRole ? String(s.responsibleRole).trim() : null,
    // Cargo (opcional) — combinado com responsibleRole vira o par (área × cargo)
    // usado pra resolver via client.roleAssignments[area][cargo].
    responsiblePosition: s.responsiblePosition ? String(s.responsiblePosition).trim() : null,
    deadlineDays: Number(s.deadlineDays) > 0 ? Math.round(Number(s.deadlineDays)) : null
  })).filter(s => s.label);
  if (clean.length < 2) return null;
  if (!clean.some(s => s.done)) clean[clean.length - 1].done = true;
  return clean;
}

// Resolve o responsável de uma etapa pra uma demanda específica.
// Nova lógica (matriz Área × Cargo):
//   1. Etapa tem cargo → busca client.roleAssignments[area][cargo]
//   2. Sem match ou sem cargo → busca client.roleAssignments[area]:
//        - Se é string (legado) → usa direto
//        - Se é objeto (novo) → pega qualquer valor não vazio (fallback)
//   3. Projeto tem prioridade sobre cliente na primeira tentativa.
//   4. Se etapa só tem responsibleId → usa direto.
function _pickFromAssignment(assign, cargo) {
  if (!assign) return null;
  if (typeof assign === 'string') return assign; // legado (só área)
  if (typeof assign === 'object') {
    if (cargo && assign[cargo]) return assign[cargo];
    // fallback: pega o primeiro user não vazio da área
    for (const k of Object.keys(assign)) {
      if (assign[k]) return assign[k];
    }
  }
  return null;
}
function resolveStageOwner(stage, project) {
  if (!stage) return null;
  if (stage.responsibleRole) {
    const role = stage.responsibleRole;
    const cargo = stage.responsiblePosition || null;
    // Projeto tem prioridade — é copiado do cliente na criação mas evolui independente.
    if (project && project.roleAssignments) {
      const pu = _pickFromAssignment(project.roleAssignments[role], cargo);
      if (pu) return pu;
    }
    const c = project && project.clientId ? db.clients.find(x => x.id === project.clientId) : null;
    if (c && c.roleAssignments) {
      const cu = _pickFromAssignment(c.roleAssignments[role], cargo);
      if (cu) return cu;
    }
    return null;
  }
  return stage.responsibleId || null;
}

app.post('/api/flows', requireAuth, modOrAdmin, (req, res) => {
  const { name, stages, demandType, projectId, workspaceId, client, clientId, icon, applyToAll, defaultDescription, defaultChecklist } = req.body || {};
  const defaultDesc = typeof defaultDescription === 'string' ? sanitizeCommentHtml(defaultDescription) : '';
  const defaultChk = sanitizeChecklistTemplate(defaultChecklist);
  const clean = sanitizeStages(stages);
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome do fluxo é obrigatório' });
  if (!clean) return res.status(400).json({ error: 'O fluxo precisa de pelo menos 2 etapas com nome' });
  let ws = workspaceId && canAccessWs(req.user, workspaceId) ? workspaceId : wsIdsFor(req.user)[0];
  let proj = null;
  if (projectId) {
    proj = db.projects.find(p => p.id === projectId);
    if (!proj || !canAccessWs(req.user, proj.workspaceId)) return res.status(400).json({ error: 'Projeto inválido' });
    ws = proj.workspaceId;
  }
  // Resolve a entidade Client. Prioridade: clientId explícito → string client →
  // herda do projeto via clientId. Null = "Geral / workspace-wide".
  let clientEntity = null;
  if (clientId) {
    clientEntity = db.clients.find(c => c.id === clientId && c.workspaceId === ws);
  } else if (client && String(client).trim()) {
    const cname = String(client).trim();
    clientEntity = db.clients.find(c => c.workspaceId === ws && (c.name || '').toLowerCase() === cname.toLowerCase());
  } else if (proj?.clientId) {
    clientEntity = db.clients.find(c => c.id === proj.clientId);
  }
  const clientName = clientEntity?.name || null;
  // Icon aceita: URL pronta (/uploads/...), base64 (extrai pro disco)
  // ou string "lucide:nome-do-icone" (referência da biblioteca, sem upload).
  let iconUrl = null;
  if (typeof icon === 'string') {
    if (icon.startsWith('/uploads/') || icon.startsWith('lucide:')) iconUrl = icon;
    else if (icon.startsWith('data:image/')) {
      const saved = saveUploadFromDataUri(icon, String(name || 'flow').trim() + '-icon');
      iconUrl = saved ? saved.url : null;
    }
  }
  ensureDemandTypeExists(demandType); // registra o tipo na biblioteca se for novo
  // Se applyToAll=true com cliente, cria 1 fluxo pra CADA projeto ATIVO desse cliente.
  if (applyToAll && clientEntity) {
    const targets = db.projects.filter(p =>
      p.workspaceId === ws && p.active !== false && p.clientId === clientEntity.id
    );
    if (!targets.length) return res.status(400).json({ error: `Nenhum projeto ativo encontrado pro cliente "${clientName}".` });
    const created = [];
    for (const t of targets) {
      const f = {
        id: uid(), workspaceId: ws, projectId: t.id,
        clientId: clientEntity.id, client: clientName, icon: iconUrl,
        name: String(name).trim(), demandType: String(demandType || '').trim(),
        stages: sanitizeStages(stages),
        defaultDescription: defaultDesc, defaultChecklist: defaultChk,
        createdAt: nowISO()
      };
      db.flows.push(f);
      saveEntity('flows', f);
      created.push(f);
    }
    broadcastChange('flow', 'create', { workspaceId: ws, byUserId: req.user.id });
    return res.status(201).json({ created, count: created.length });
  }
  const f = {
    id: uid(), workspaceId: ws, projectId: proj ? proj.id : null,
    clientId: clientEntity ? clientEntity.id : null, client: clientName,
    icon: iconUrl,
    name: String(name).trim(), demandType: String(demandType || '').trim(),
    stages: clean,
    defaultDescription: defaultDesc, defaultChecklist: defaultChk,
    createdAt: nowISO()
  };
  db.flows.push(f);
  saveEntity('flows', f);
  broadcastChange('flow', 'create', { id: f.id, workspaceId: f.workspaceId, byUserId: req.user.id });
  res.status(201).json(f);
});

app.put('/api/flows/:id', requireAuth, modOrAdmin, (req, res) => {
  const f = db.flows.find(x => x.id === req.params.id);
  if (!f || !canAccessWs(req.user, f.workspaceId)) return res.status(404).json({ error: 'Fluxo não encontrado' });
  const { name, stages, demandType, projectId, client, clientId, icon, defaultDescription, defaultChecklist } = req.body || {};
  if (typeof name === 'string' && name.trim()) f.name = name.trim();
  if (typeof demandType === 'string') { f.demandType = demandType.trim(); ensureDemandTypeExists(f.demandType); }
  // Atualiza clientId (e mantém f.client em sincronia pelo nome da entidade)
  if (clientId !== undefined) {
    if (!clientId) { f.clientId = null; f.client = null; }
    else {
      const c = db.clients.find(x => x.id === clientId && x.workspaceId === f.workspaceId);
      if (!c) return res.status(400).json({ error: 'Cliente inválido' });
      f.clientId = c.id;
      f.client = c.name;
    }
  } else if (client !== undefined) {
    f.client = (typeof client === 'string' && client.trim()) ? client.trim() : null;
  }
  if (icon !== undefined) {
    if (!icon) f.icon = null;
    else if (typeof icon === 'string') {
      if (icon.startsWith('data:image/')) {
        // base64 → extrai pro disco (consistente com avatares)
        const saved = saveUploadFromDataUri(icon, (f.name || 'flow') + '-icon');
        f.icon = saved ? saved.url : null;
      } else if (icon.startsWith('/uploads/') || icon.startsWith('lucide:')) {
        f.icon = icon;
      }
    }
  }
  if (projectId !== undefined) {
    if (projectId) {
      const proj = db.projects.find(p => p.id === projectId);
      if (!proj || !canAccessWs(req.user, proj.workspaceId)) return res.status(400).json({ error: 'Projeto inválido' });
      f.projectId = proj.id; f.workspaceId = proj.workspaceId;
      // Sincroniza o client com o projeto se não foi explicitamente passado
      if (client === undefined && proj.client) f.client = proj.client;
    } else f.projectId = null;
  }
  if (stages) {
    const clean = sanitizeStages(stages);
    if (!clean) return res.status(400).json({ error: 'O fluxo precisa de pelo menos 2 etapas com nome' });
    f.stages = clean;
    const valid = new Set(clean.map(s => s.id));
    db.demands.forEach(d => {
      if (d.flowId === f.id && !valid.has(d.status)) {
        d.status = clean[0].id;
        d.completedAt = null;
        d.stageEnteredAt = nowISO();
        d.stageDueDate = resolveStageDueDate(clean[0], d, today());
      }
    });
  }
  if (typeof defaultDescription === 'string') f.defaultDescription = sanitizeCommentHtml(defaultDescription);
  if (defaultChecklist !== undefined) f.defaultChecklist = sanitizeChecklistTemplate(defaultChecklist);
  saveEntity('flows', f);
  // Se as stages mudaram, algumas demandas podem ter tido status/stageDueDate reassinalados no loop acima — persiste-as.
  if (stages) {
    db.demands.forEach(d => { if (d.flowId === f.id) saveEntity('demands', d); });
  }
  broadcastChange('flow', 'update', { id: f.id, workspaceId: f.workspaceId, byUserId: req.user.id });
  res.json(f);
});

app.delete('/api/flows/:id', requireAuth, modOrAdmin, (req, res) => {
  const f = db.flows.find(x => x.id === req.params.id);
  if (!f || !canAccessWs(req.user, f.workspaceId) || !notDeleted(f)) return res.status(404).json({ error: 'Fluxo não encontrado' });
  // Bloqueia só se houver demanda ATIVA (não deletada) apontando pra esse fluxo.
  // Demandas na lixeira NÃO bloqueiam — senão o fluxo ficaria preso por 30 dias por
  // causa de uma demanda que o usuário já excluiu e nem vê nas listagens. Mesmo
  // critério da exclusão de Projeto (usa notDeleted).
  if (db.demands.some(d => d.flowId === req.params.id && notDeleted(d))) {
    return res.status(409).json({ error: 'Este fluxo possui demandas vinculadas e não pode ser excluído.' });
  }
  softDelete('flows', f, req.user.id);
  broadcastChange('flow', 'delete', { id: req.params.id, workspaceId: f.workspaceId, byUserId: req.user.id });
  res.json({ ok: true, undoable: true, purgeAt: Date.parse(f.deletedAt) + UNDO_PURGE_MS });
});

/* Duplicar fluxo para outro projeto */
app.post('/api/flows/:id/duplicate', requireAuth, modOrAdmin, (req, res) => {
  const f = db.flows.find(x => x.id === req.params.id);
  if (!f || !canAccessWs(req.user, f.workspaceId)) return res.status(404).json({ error: 'Fluxo não encontrado' });
  const { projectId } = req.body || {};
  let ws = f.workspaceId, proj = null;
  if (projectId) {
    proj = db.projects.find(p => p.id === projectId);
    if (!proj || !canAccessWs(req.user, proj.workspaceId)) return res.status(400).json({ error: 'Projeto inválido' });
    ws = proj.workspaceId;
  }
  const copy = {
    id: uid(), workspaceId: ws, projectId: proj ? proj.id : null,
    name: f.name, demandType: f.demandType,
    stages: f.stages.map(s => ({ ...s, id: uid() })),
    createdAt: nowISO()
  };
  db.flows.push(copy);
  saveEntity('flows', copy);
  res.status(201).json(copy);
});

/* ── DEMANDAS ── */
app.get('/api/demands', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  res.json(db.demands.filter(d => ids.includes(d.workspaceId) && notDeleted(d)));
});

function stageById(flow, id) { return flow ? flow.stages.find(s => s.id === id) : null; }
/* Busca stage por ID considerando SÓ o fluxo (uso legado) OU o fluxo + as
   etapas adicionadas por instância (`d.stageAdditions`). Necessário no PUT
   e no bulk setStatus — o usuário pode avançar pra uma etapa que só existe
   nesta demanda. */
function stageByIdForDemand(flow, d, id) {
  if (!id) return null;
  const fromFlow = stageById(flow, id);
  if (fromFlow) return fromFlow;
  if (Array.isArray(d?.stageAdditions)) {
    return d.stageAdditions.find(s => s.id === id) || null;
  }
  return null;
}
/* Resolve o prazo (stageDueDate) de uma etapa quando ela entra em jogo (é
   aberta, retomada ou o fluxo é trocado). Ordem de precedência:
     1) `stageOverrides[id].deadlineDate` — âncora fixa (definida no editor
        "Etapas desta demanda"). Sobrepõe o SLA em dias.
     2) `stageOverrides[id].deadlineDays` — override do SLA em dias.
     3) `stage.deadlineDays` — SLA padrão do fluxo.
     4) null — sem prazo definido.
   `baseYmd` é a data-base pra somar dias (normalmente hoje quando avança). */
function resolveStageDueDate(stage, d, baseYmd) {
  if (!stage) return null;
  // Additions carregam a âncora na própria entrada (stage.deadlineDate).
  if (stage.deadlineDate) return stage.deadlineDate;
  const ov = (d?.stageOverrides && typeof d.stageOverrides === 'object') ? d.stageOverrides[stage.id] : null;
  if (ov && ov.deadlineDate) return ov.deadlineDate;
  const days = (ov && ov.deadlineDays !== undefined) ? ov.deadlineDays : stage.deadlineDays;
  // SLA null/0 em etapa NÃO-done → prazo = baseYmd (hoje ao avançar). Evita
  // que a etapa fique sem data marcada. Etapas done podem ficar sem prazo.
  if (days == null) return stage.done ? null : baseYmd;
  return addDays(baseYmd, days);
}

function normalizeUrlSrv(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return 'https://' + s;
}
/* Sanitiza HTML de comentário — allowlist estreita cobrindo o que o editor
   rich text emite (b/strong/i/em/u, listas, br, p, div, spans/mentions, links,
   imagens). Bloqueia scripts, handlers on*, javascript: URIs. Imagens em data:
   são materializadas em /uploads (mesmo padrão de sanitizeAttachments). */
const COMMENT_HTML_ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'p', 'div', 'br',
  'ol', 'ul', 'li',
  'a', 'span', 'img', 'code', 'pre', 'blockquote'
]);
const COMMENT_HTML_ATTR_ALLOWLIST = {
  a:    ['href', 'title', 'target', 'rel'],
  img:  ['src', 'alt', 'title', 'width', 'height'],
  span: ['class']
};
// 60 MB — teto do input BRUTO pro sanitizer (comentários + descrições).
// Cabe várias imagens grandes coladas; o sanitizer converte data URIs em /uploads,
// então o valor GRAVADO em disco/DB fica sempre em KB.
const COMMENT_HTML_MAX_LEN = 60 * 1024 * 1024;
function sanitizeCommentHtml(input) {
  let html = String(input == null ? '' : input);
  if (html.length > COMMENT_HTML_MAX_LEN) html = html.slice(0, COMMENT_HTML_MAX_LEN);
  // Remove blocos completos que nunca são seguros — mesmo antes do stripping.
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<(script|style|iframe|object|embed|link|meta)[\s\S]*?<\/\1>/gi, '');
  html = html.replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '');
  // Substitui data: em <img src="..."> por URL persistida em /uploads.
  html = html.replace(/<img\b([^>]*)>/gi, (_full, attrs) => {
    const srcMatch = /\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i.exec(attrs);
    const src = srcMatch ? (srcMatch[1] || srcMatch[2] || '') : '';
    let outSrc = '';
    if (/^data:image\//i.test(src)) {
      const saved = saveUploadFromDataUri(src, 'comment-image');
      if (saved) outSrc = saved.url;
    } else if (/^https?:\/\//i.test(src) || src.startsWith('/uploads/')) {
      outSrc = src;
    }
    if (!outSrc) return '';
    const altMatch = /\balt\s*=\s*"([^"]*)"/i.exec(attrs);
    const alt = altMatch ? altMatch[1] : '';
    return `<img src="${escAttr(outSrc)}" alt="${escAttr(alt)}">`;
  });
  // Walk pelas tags restantes com allowlist.
  html = html.replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)\/?>/g, (match, close, tag, rawAttrs) => {
    const t = tag.toLowerCase();
    if (!COMMENT_HTML_ALLOWED_TAGS.has(t)) return '';
    if (close) return `</${t}>`;
    if (t === 'img') return match; // já tratada acima
    return `<${t}${_sanitizeCommentAttrs(t, rawAttrs || '')}>`;
  });
  // Remove tags órfãs deixadas pelo passo anterior.
  return html.trim();
}
function _sanitizeCommentAttrs(tag, raw) {
  const allowed = COMMENT_HTML_ATTR_ALLOWLIST[tag];
  if (!allowed) return '';
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    if (name.startsWith('on')) continue; // paranoia — allowlist já bloqueia, mas fica explícito
    const val = m[2] !== undefined ? m[2] : m[3];
    if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) continue;
    if (tag === 'span' && name === 'class' && val !== 'mention') continue;
    if (tag === 'a' && name === 'target' && val !== '_blank') continue;
    if (tag === 'a' && name === 'rel' && !/^(noopener|noreferrer|(noopener\s+noreferrer))$/.test(val)) continue;
    out.push(` ${name}="${escAttr(val)}"`);
  }
  // Força rel="noopener noreferrer" em <a target="_blank">
  if (tag === 'a' && out.some(a => a.includes('target="_blank"')) && !out.some(a => a.includes('rel='))) {
    out.push(' rel="noopener noreferrer"');
  }
  return out.join('');
}
function escAttr(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
// Extrai texto puro do HTML pra rodar regex de menção e gerar preview.
function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}
function sanitizeAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 20).map(a => {
    if (a && a.kind === 'link') {
      return { id: a.id || uid(), kind: 'link', name: String(a.name || a.url || '').trim(), url: normalizeUrlSrv(a.url || a.name), addedAt: a.addedAt || nowISO() };
    }
    // Se ainda chegou base64 (cliente antigo), extrai pra disco e troca por URL.
    // Anexos novos já chegam aqui com data: '/uploads/<file>' (cliente subiu via /api/uploads).
    let data = String(a && a.data || '');
    if (data.startsWith('data:')) {
      const saved = saveUploadFromDataUri(data, a.name);
      if (saved) data = saved.url;
    }
    return { id: a.id || uid(), kind: 'file', name: String(a.name || 'arquivo'), type: String(a.type || ''), data, addedAt: a.addedAt || nowISO() };
  }).filter(a => a.kind === 'link' ? a.url : a.data);
}

/* ─── SANITIZER DA BASE DE CONHECIMENTO ───
   Estende o sanitizer de comentários: mesma allowlist + headings + tabelas +
   iframe com host whitelisted (YouTube, Vimeo, Loom, Google Docs/Slides/
   Sheets/Drive, Notion, Miro, Figma, Looker Studio, Airtable, CodePen,
   CodeSandbox). Anti-XSS mesma linha: sem script, sem handlers on-*, sem
   javascript: em href/src. Cap 1MB. */
const POST_HTML_MAX_LEN = 1_000_000;
const POST_HTML_ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's',
  'p', 'div', 'br', 'hr',
  'ol', 'ul', 'li',
  'a', 'span', 'img', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'iframe', 'figure', 'figcaption'
]);
const POST_HTML_ATTR_ALLOWLIST = {
  a:      ['href', 'title', 'target', 'rel'],
  img:    ['src', 'alt', 'title', 'width', 'height'],
  span:   ['class'],
  iframe: ['src', 'title', 'width', 'height', 'allowfullscreen', 'allow', 'loading', 'frameborder', 'referrerpolicy'],
  table:  ['class'],
  th:     ['colspan', 'rowspan'],
  td:     ['colspan', 'rowspan'],
  figure: ['class'], // pra preservar `class="post-embed"` (evita perder o wrapper no re-save)
  h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id']
};
// Sufixos de host permitidos pra <iframe src>. Match por endsWith('.'+suffix) OU exact.
const POST_IFRAME_HOST_ALLOWLIST = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be',
  'vimeo.com', 'player.vimeo.com',
  'loom.com',
  'docs.google.com', 'drive.google.com', 'sheets.google.com', 'lookerstudio.google.com',
  'notion.so', 'notion.site',
  'miro.com',
  'figma.com',
  'airtable.com',
  'codepen.io', 'codesandbox.io',
  'canva.com',
  'onedrive.live.com', 'sharepoint.com'
];
function _isAllowedIframeSrc(url) {
  try {
    const u = new URL(url, 'https://placeholder.local');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return POST_IFRAME_HOST_ALLOWLIST.some(sfx => host === sfx || host.endsWith('.' + sfx));
  } catch { return false; }
}
function sanitizePostHtml(input) {
  let html = String(input == null ? '' : input);
  if (html.length > POST_HTML_MAX_LEN) html = html.slice(0, POST_HTML_MAX_LEN);
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Blocos sempre inseguros — remove ANTES do walk.
  html = html.replace(/<(script|style|object|embed|link|meta|form|input|button|textarea|select)[\s\S]*?<\/\1>/gi, '');
  html = html.replace(/<(script|style|object|embed|link|meta|form|input|button|textarea|select)\b[^>]*\/?>/gi, '');
  // <img>: mesmo tratamento do comment (data: URI vira /uploads).
  html = html.replace(/<img\b([^>]*)>/gi, (_full, attrs) => {
    const srcMatch = /\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i.exec(attrs);
    const src = srcMatch ? (srcMatch[1] || srcMatch[2] || '') : '';
    let outSrc = '';
    if (/^data:image\//i.test(src)) {
      const saved = saveUploadFromDataUri(src, 'post-image');
      if (saved) outSrc = saved.url;
    } else if (/^https?:\/\//i.test(src) || src.startsWith('/uploads/')) {
      outSrc = src;
    }
    if (!outSrc) return '';
    const altMatch = /\balt\s*=\s*"([^"]*)"/i.exec(attrs);
    const alt = altMatch ? altMatch[1] : '';
    return `<img src="${escAttr(outSrc)}" alt="${escAttr(alt)}">`;
  });
  // Strip figures `.post-embed` que já vieram de sanitizes anteriores — evita
  // acumular `<figure><figure>...` a cada re-save de edição. Regex não faz
  // matching balanceado, então usa contador de <figure>/</figure> ao redor.
  html = _stripPostEmbedFigures(html);
  // <iframe>: só com src em host whitelisted. Substitui por wrapper responsivo.
  // Regex unificado: matcha `<iframe...>content</iframe>` OU `<iframe.../>`
  // OU `<iframe...>` sem close. Sem 2ª passada — evita re-processar o
  // <iframe> que acabamos de emitir dentro do wrapper novo.
  html = html.replace(
    /<iframe\b([^>]*?)(?:>[\s\S]*?<\/iframe>|\/>)/gi,
    (_full, attrs) => _sanitizeIframe(attrs)
  );
  // Walk das tags restantes.
  html = html.replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)\/?>/g, (match, close, tag, rawAttrs) => {
    const t = tag.toLowerCase();
    if (!POST_HTML_ALLOWED_TAGS.has(t)) return '';
    if (close) return `</${t}>`;
    if (t === 'img' || t === 'iframe') return match; // já tratados acima
    return `<${t}${_sanitizePostAttrs(t, rawAttrs || '')}>`;
  });
  return html.trim();
}
/* Remove wrappers `<figure class="post-embed">...<iframe/></figure>` do input
   (junto com qualquer <figcaption> interno). Extrai o <iframe> nu — o sanitize
   principal re-envelopa depois. Regex não faz balancing; conto <figure> abre/
   fecha manualmente pra pegar o par correto mesmo com nesting. */
function _stripPostEmbedFigures(html) {
  const re = /<figure\b[^>]*class="[^"]*\bpost-embed\b[^"]*"[^>]*>/gi;
  const out = [];
  let last = 0, m;
  while ((m = re.exec(html)) !== null) {
    out.push(html.slice(last, m.index));
    // Encontra o </figure> balanceado a partir do fim da opening tag
    let i = m.index + m[0].length;
    let depth = 1;
    const openRe = /<figure\b/gi, closeRe = /<\/figure>/gi;
    while (depth > 0 && i < html.length) {
      openRe.lastIndex = i; closeRe.lastIndex = i;
      const nextOpen = openRe.exec(html);
      const nextClose = closeRe.exec(html);
      if (!nextClose) break; // desbalanceado — deixa como está
      if (nextOpen && nextOpen.index < nextClose.index) { depth++; i = nextOpen.index + nextOpen[0].length; }
      else                                              { depth--; i = nextClose.index + nextClose[0].length; }
    }
    // Conteúdo entre a opening tag e o </figure> balanceado
    const inner = html.slice(m.index + m[0].length, i - '</figure>'.length);
    // Extrai só o iframe (com ou sem fechamento explícito) — descarta figcaption etc.
    const iframeMatch = inner.match(/<iframe\b[\s\S]*?<\/iframe>|<iframe\b[^>]*\/?>/i);
    out.push(iframeMatch ? iframeMatch[0] : '');
    last = i;
    re.lastIndex = i;
  }
  out.push(html.slice(last));
  return out.join('');
}
/* Decodifica entidades HTML — usado antes de re-escapar valores lidos do source
   via regex (senão dá double-encode: `&amp;` → `&amp;amp;`). */
function _decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ');
}
/* Converte URL de embed pra URL "humana" (a de assistir/abrir), pra usar como
   fallback quando o provider bloqueia o embed (comum em vídeos AO VIVO ou
   com "permitir incorporação" desativado pelo dono). */
function _embedToHumanUrl(embedSrc) {
  try {
    const u = new URL(embedSrc);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    // YouTube: /embed/VIDEO_ID → /watch?v=VIDEO_ID
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
      const m = u.pathname.match(/^\/embed\/([\w-]+)/);
      if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    }
    // Vimeo: player.vimeo.com/video/ID → vimeo.com/ID
    if (host === 'player.vimeo.com') {
      const m = u.pathname.match(/^\/video\/(\d+)/);
      if (m) return `https://vimeo.com/${m[1]}`;
    }
    // Loom: loom.com/embed/ID → loom.com/share/ID
    if (host === 'loom.com') {
      const m = u.pathname.match(/^\/embed\/([\w-]+)/);
      if (m) return `https://www.loom.com/share/${m[1]}`;
    }
    // Google Docs/Sheets/Slides: /preview → /view (só remove o /preview no fim)
    if (host === 'docs.google.com') return embedSrc.replace(/\/preview(\?.*)?$/, '/view$1');
    // Demais providers: retorna a própria src (é a página normal)
    return embedSrc;
  } catch { return embedSrc; }
}
function _sanitizeIframe(rawAttrs) {
  const srcMatch = /\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i.exec(rawAttrs || '');
  const rawSrc = srcMatch ? (srcMatch[1] || srcMatch[2] || '') : '';
  const src = _decodeHtmlEntities(rawSrc);
  if (!src || !_isAllowedIframeSrc(src)) return '';
  const titleMatch = /\btitle\s*=\s*"([^"]*)"|\btitle\s*=\s*'([^']*)'/i.exec(rawAttrs);
  const rawTitle = titleMatch ? (titleMatch[1] || titleMatch[2] || '') : '';
  const title = _decodeHtmlEntities(rawTitle) || 'Conteúdo incorporado';
  const fallbackUrl = _embedToHumanUrl(src);
  // Wrapper com aspect-ratio 16:9 responsivo + fallback link. `figcaption`
  // aparece sempre — se o embed carregar OK a pessoa ignora, se travar
  // (ex.: YouTube AO VIVO com "permitir incorporação" desativado pelo dono)
  // o link vira o caminho de saída.
  return `<figure class="post-embed">
    <iframe src="${escAttr(src)}" title="${escAttr(title)}" loading="lazy" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture; fullscreen"></iframe>
    <figcaption><a href="${escAttr(fallbackUrl)}" target="_blank" rel="noopener noreferrer">Abrir no serviço original ↗</a></figcaption>
  </figure>`;
}
function _sanitizePostAttrs(tag, raw) {
  const allowed = POST_HTML_ATTR_ALLOWLIST[tag];
  if (!allowed) return '';
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    if (name.startsWith('on')) continue;
    // Regex lê o valor JÁ HTML-encoded do source (ex.: `href="a&amp;b"` → val = `a&amp;b`).
    // Decodifica antes de re-encodar (escAttr) pra não acumular `&amp;amp;` a cada save.
    // Isso é crítico pra URLs com query strings (`?a=1&b=2`) — que somos praticamente
    // todos os embeds (Loom, Figma, YouTube com params, etc.).
    const val = _decodeHtmlEntities(m[2] !== undefined ? m[2] : m[3]);
    if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) continue;
    if (tag === 'a' && name === 'target' && val !== '_blank') continue;
    if (tag === 'a' && name === 'rel' && !/^(noopener|noreferrer|(noopener\s+noreferrer))$/.test(val)) continue;
    out.push(` ${name}="${escAttr(val)}"`);
  }
  if (tag === 'a' && out.some(a => a.includes('target="_blank"')) && !out.some(a => a.includes('rel='))) {
    out.push(' rel="noopener noreferrer"');
  }
  return out.join('');
}

/* Registra um evento no histórico da demanda */
const HISTORY_MAX_PER_DEMAND = 200;
function addHistory(d, userId, action, details) {
  if (!Array.isArray(d.history)) d.history = [];
  d.history.push({ id: uid(), userId, action, details: details || null, at: nowISO() });
  // Cap evita o histórico de uma demanda velha crescer indefinidamente
  // (cada PUT registra entries; em meses pode acumular milhares).
  if (d.history.length > HISTORY_MAX_PER_DEMAND) {
    d.history.splice(0, d.history.length - HISTORY_MAX_PER_DEMAND);
  }
}

/* Sanitização de configuração de recorrência.
   Modelo: repetir a cada `interval` unidades do `pattern` (dia/semana/mês).
   - weekly usa `weekDays` (múltiplos dias 0=Dom..6=Sáb); `weekDay` fica só p/ compat.
   - `startDate` é a âncora do intervalo (a partir de quando/de qual semana conta).
   - `paused` congela a geração sem perder a config. `createdBy` = quem configurou
     (usado na tela "Demandas Recorrentes", que mostra as do próprio usuário).
   Passar `existing` preserva createdBy/startDate/lastGeneratedDate em edições. */
function sanitizeRecurrence(r, existing) {
  if (!r || typeof r !== 'object' || !r.enabled) return null;
  const pattern = ['daily','weekly','monthly'].includes(r.pattern) ? r.pattern : 'weekly';
  const interval = Math.max(1, Math.min(365, Number.isFinite(Number(r.interval)) ? Math.floor(Number(r.interval)) : 1));
  let weekDays = Array.isArray(r.weekDays)
    ? [...new Set(r.weekDays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))]
    : [];
  if (!weekDays.length) {
    const wd = Number.isInteger(Number(r.weekDay)) ? Math.max(0, Math.min(6, Number(r.weekDay))) : 1;
    weekDays = [wd];
  }
  weekDays.sort((a, b) => a - b);
  return {
    enabled: true,
    pattern,
    interval,
    weekDays,
    weekDay: weekDays[0], // compat com leitura antiga
    monthDay: Number.isInteger(Number(r.monthDay)) ? Math.max(1, Math.min(28, Number(r.monthDay))) : 1,
    startDate: r.startDate || (existing && existing.startDate) || today(),
    endDate: r.endDate || null,
    lastGeneratedDate: r.lastGeneratedDate || (existing && existing.lastGeneratedDate) || null,
    paused: !!r.paused,
    createdBy: r.createdBy || (existing && existing.createdBy) || null
  };
}

app.post('/api/demands', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Nome da demanda é obrigatório' });
  const project = db.projects.find(p => p.id === b.projectId);
  if (!project || !canAccessWs(req.user, project.workspaceId)) return res.status(400).json({ error: 'Selecione um projeto válido' });
  // Fluxo pode ser de qualquer workspace acessível (fluxos pertencem ao CLIENTE
  // agora, não ao workspace). Prioriza: id explícito → mesmo cliente → geral.
  let flow = null;
  if (b.flowId) {
    const cand = db.flows.find(f => f.id === b.flowId);
    if (cand && canAccessWs(req.user, cand.workspaceId)) flow = cand;
  }
  if (!flow) {
    flow = db.flows.find(f => f.clientId === project.clientId && canAccessWs(req.user, f.workspaceId))
        || db.flows.find(f => f.workspaceId === project.workspaceId);
  }
  if (!flow) return res.status(400).json({ error: 'Nenhum fluxo disponível para este projeto' });
  const stage = stageById(flow, b.status) || flow.stages[0];
  // stageOverrides pode chegar no body da criação (wizard "Nova demanda") com
  // uma âncora `deadlineDate` — respeita se vier, senão calcula por SLA em dias.
  const bodyOv = (b.stageOverrides && typeof b.stageOverrides === 'object') ? b.stageOverrides[stage.id] : null;
  // Regra: se etapa não tem SLA (deadlineDays null/0) e não tem deadline geral,
  // vira HOJE — evita ficar com data em branco. Etapa "done" pode ficar sem data.
  const stageDue = (bodyOv && bodyOv.deadlineDate)
    || (stage.deadlineDays ? addDays(today(), stage.deadlineDays) : (b.deadline || (stage.done ? null : today())));
  // Defaults do fluxo: descrição se vazia + checklist se não veio nada explícito.
  // Frontend pode ter pré-populado, mas se o user deixou em branco aproveitamos
  // o padrão do fluxo (não força — se enviou string vazia, não substitui).
  const useDefaultDesc = (b.description === undefined || b.description === null)
    && (flow.defaultDescription && flow.defaultDescription.trim());
  // Sanitiza (transforma data: em /uploads, strip de tags perigosas, allowlist).
  // Aceita até 60 MB no bruto — cabe vários prints/screenshots grandes embutidos
  // como data URIs; sanitizer converte pra /uploads e o valor final fica em KB.
  // Depois de sanitizar, aplica cap de 500 KB no HTML final (texto + URLs curtas).
  const rawDesc = (useDefaultDesc ? String(flow.defaultDescription) : String(b.description || '')).slice(0, 60 * 1024 * 1024);
  const initialDesc = sanitizeCommentHtml(rawDesc).slice(0, 500 * 1024);
  // Checklist inicial: explicit list > flow.defaultChecklist > [].
  // Valida o responsável de um item de checklist: precisa ser usuário ativo com
  // acesso ao workspace do projeto; caso contrário vira null.
  const validChkOwner = v => {
    if (typeof v !== 'string' || !v) return null;
    const u = db.users.find(x => x.id === v && x.active !== false);
    return (u && canAccessWs(u, project.workspaceId)) ? u.id : null;
  };
  let initialChecklist = [];
  if (Array.isArray(b.checklist) && b.checklist.length) {
    initialChecklist = b.checklist
      .map(it => ({
        id: uid(),
        text: String((it && it.text) || '').trim().slice(0, 500),
        ownerId: validChkOwner(it && it.ownerId),
        done: false, doneBy: null, doneAt: null,
        createdBy: req.user.id, createdAt: nowISO()
      }))
      .filter(it => it.text);
  } else if (Array.isArray(flow.defaultChecklist) && flow.defaultChecklist.length) {
    initialChecklist = flow.defaultChecklist.map(it => ({
      id: uid(),
      text: String(it.text || '').trim().slice(0, 500),
      ownerId: validChkOwner(it && it.ownerId),
      done: false, doneBy: null, doneAt: null,
      createdBy: req.user.id, createdAt: nowISO()
    })).filter(it => it.text);
  }
  // ── Customização de etapas POR INSTÂNCIA (opcional, vem do step "cust" do wizard).
  // Filtra o que faz sentido: só stageIds válidos, users acessíveis, etc.
  const validStageIds = new Set(flow.stages.map(s => s.id));
  const initSkipped = Array.isArray(b.skippedStages)
    ? [...new Set(b.skippedStages.filter(id => typeof id === 'string' && validStageIds.has(id) && id !== stage.id))]
    : [];
  const initStageResp = {};
  if (b.stageResponsibles && typeof b.stageResponsibles === 'object') {
    for (const sid of Object.keys(b.stageResponsibles)) {
      if (!validStageIds.has(sid)) continue;
      const v = b.stageResponsibles[sid];
      if (v === null) { initStageResp[sid] = null; continue; }
      if (typeof v !== 'string' || !v) continue;
      const u = db.users.find(x => x.id === v && x.active !== false);
      if (u && canAccessWs(u, project.workspaceId)) initStageResp[sid] = u.id;
    }
  }
  const initStageLabels = {};
  if (b.stageLabels && typeof b.stageLabels === 'object') {
    for (const sid of Object.keys(b.stageLabels)) {
      if (!validStageIds.has(sid)) continue;
      const v = b.stageLabels[sid];
      if (typeof v !== 'string') continue;
      const trimmed = v.trim().slice(0, 80);
      const orig = flow.stages.find(s => s.id === sid);
      if (trimmed && orig && trimmed !== orig.label) initStageLabels[sid] = trimmed;
    }
  }
  // stageAdditions: etapas EXTRAS que existem só nessa demanda. Cada uma vira
  // um objeto shape-compatible com flow.stages (id/label/color/deadlineDays/done).
  const initStageAdditions = [];
  const clientAdditionIdMap = {}; // id do cliente → id gerado no server (pra remap do stageOrder)
  if (Array.isArray(b.stageAdditions)) {
    for (const s of b.stageAdditions) {
      if (!s || typeof s !== 'object') continue;
      const label = String(s.label || '').trim().slice(0, 80);
      if (!label) continue;
      const days = Number.isInteger(Number(s.deadlineDays)) && Number(s.deadlineDays) >= 0 ? Number(s.deadlineDays) : null;
      let respId = null;
      if (typeof s.responsibleId === 'string' && s.responsibleId) {
        const u = db.users.find(x => x.id === s.responsibleId && x.active !== false);
        if (u && canAccessWs(u, project.workspaceId)) respId = u.id;
      }
      const newId = uid();
      if (typeof s.id === 'string' && s.id) clientAdditionIdMap[s.id] = newId;
      // deadlineDate: âncora opcional (YYYY-MM-DD) — sobrepõe a soma por dias
      // ao avançar. Usado quando o usuário edita a data no editor de etapas.
      const dateAnchor = (typeof s.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.deadlineDate))
        ? s.deadlineDate : null;
      initStageAdditions.push({
        id: newId,
        label,
        color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#7A00FF',
        deadlineDays: days,
        deadlineDate: dateAnchor,
        responsibleId: respId,
        done: !!s.done
      });
    }
  }
  // stageOverrides: overrides de color/deadlineDays/done nas etapas ORIGINAIS do
  // fluxo (não altera o fluxo em si — só esta demanda vê). Formato:
  //   { stageId: { color?, deadlineDays?, done? } }
  const initStageOverrides = {};
  if (b.stageOverrides && typeof b.stageOverrides === 'object') {
    for (const sid of Object.keys(b.stageOverrides)) {
      if (!validStageIds.has(sid)) continue;
      const raw = b.stageOverrides[sid] || {};
      const out = {};
      if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)) out.color = raw.color;
      if (raw.deadlineDays === null) out.deadlineDays = null;
      else if (Number.isInteger(Number(raw.deadlineDays)) && Number(raw.deadlineDays) >= 0) out.deadlineDays = Number(raw.deadlineDays);
      // deadlineDate: âncora de data (YYYY-MM-DD) que sobrepõe o SLA em dias.
      // Se presente, a etapa termina naquela data; anteriores/próximas cascateiam
      // a partir dela. null = "sem âncora, usar SLA".
      if (typeof raw.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.deadlineDate)) out.deadlineDate = raw.deadlineDate;
      else if (raw.deadlineDate === null) out.deadlineDate = null;
      if (typeof raw.done === 'boolean') out.done = raw.done;
      if (Object.keys(out).length) initStageOverrides[sid] = out;
    }
  }
  // stageOrder: sequência final (originais + adicionadas) via IDs. Do lado do
  // cliente, IDs de additions são temporários — precisam ser remapeados pros IDs
  // definitivos gerados aqui (clientAdditionIdMap).
  let initStageOrder = null;
  if (Array.isArray(b.stageOrder) && b.stageOrder.length) {
    const remapped = b.stageOrder
      .map(id => clientAdditionIdMap[id] || id)
      .filter(id => validStageIds.has(id) || initStageAdditions.some(a => a.id === id));
    const seen = new Set();
    initStageOrder = [];
    for (const id of remapped) if (!seen.has(id)) { initStageOrder.push(id); seen.add(id); }
    if (!initStageOrder.length) initStageOrder = null;
  }

  // Recorrência: quem cria a demanda é o dono da recorrência (tela "Demandas Recorrentes").
  const initRecurrence = sanitizeRecurrence(b.recurrence);
  if (initRecurrence && !initRecurrence.createdBy) initRecurrence.createdBy = req.user.id;

  const d = {
    id: uid(), workspaceId: project.workspaceId, projectId: project.id,
    flowId: flow.id, name: String(b.name).trim().slice(0, 300),
    description: initialDesc, briefing: normalizeUrlSrv(b.briefing),
    deadline: b.deadline || null,
    estimatedHours: Number(b.estimatedHours) > 0 ? Math.round(Number(b.estimatedHours) * 100) / 100 : null,
    priority: [1,2,3,4].includes(Number(b.priority)) ? Number(b.priority) : 3,
    // Entregáveis (3 contagens distintas — performance/produtividade):
    //   qtyPieces  = peças únicas (ex.: 1 criativo + 1 carrossel = 2)
    //   qtyArts    = artes individuais (1 criativo + carrossel de 3 telas = 4)
    //   qtyVariations = exportações/variações (1 criativo em 3 formatos = 3)
    qtyPieces:     Number(b.qtyPieces) > 0 ? Math.floor(Number(b.qtyPieces)) : 0,
    qtyArts:       Number(b.qtyArts) > 0 ? Math.floor(Number(b.qtyArts)) : 0,
    qtyVariations: Number(b.qtyVariations) > 0 ? Math.floor(Number(b.qtyVariations)) : 0,
    deliverableUserId: b.deliverableUserId || null,
    status: stage.id,
    ownerId: b.ownerId || (initStageResp[stage.id] !== undefined ? initStageResp[stage.id] : null) || resolveStageOwner(stage, project) || null,
    stageEnteredAt: nowISO(), stageDueDate: stageDue,
    stageHistory: [{ stageId: stage.id, enteredAt: nowISO(), dueDate: stageDue }],
    timeEntries: [], comments: [], history: [],
    checklist: initialChecklist,
    attachments: sanitizeAttachments(b.attachments),
    recurrence: initRecurrence,
    // Customização inicial (só grava campos com conteúdo — economiza espaço em JSONB).
    ...(initSkipped.length ? { skippedStages: initSkipped } : {}),
    ...(Object.keys(initStageResp).length ? { stageResponsibles: initStageResp } : {}),
    ...(Object.keys(initStageLabels).length ? { stageLabels: initStageLabels } : {}),
    ...(Object.keys(initStageOverrides).length ? { stageOverrides: initStageOverrides } : {}),
    ...(initStageAdditions.length ? { stageAdditions: initStageAdditions } : {}),
    ...(initStageOrder ? { stageOrder: initStageOrder } : {}),
    createdAt: nowISO(),
    completedAt: stage.done ? nowISO() : null
  };
  addHistory(d, req.user.id, 'created', { demandName: d.name });
  if (d.ownerId) {
    addHistory(d, req.user.id, 'owner_set', { ownerId: d.ownerId });
  }
  db.demands.push(d);
  saveEntity('demands', d);
  // Notifica o responsável que recebeu a demanda
  if (d.ownerId && d.ownerId !== req.user.id) {
    notify(d.ownerId, 'assigned', { demandId: d.id, demandName: d.name, stageName: stage.label }, req.user.id, appBaseUrl(req));
  }
  const reqBase = appBaseUrl(req);
  fireWebhook('demand.created', () => ({
    demand: d, project, flow, stage, user: req.user,
    owner: db.users.find(u => u.id === d.ownerId),
    appBaseUrl: reqBase
  }));
  broadcastChange('demand', 'create', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.status(201).json(d);
});

function getDemand(req, res) {
  const d = db.demands.find(x => x.id === req.params.id);
  // notDeleted filtra soft-deleted — todas as rotas de mutação passam por aqui.
  if (!d || !canAccessWs(req.user, d.workspaceId) || !notDeleted(d)) { res.status(404).json({ error: 'Demanda não encontrada' }); return null; }
  return d;
}
// Helper pra reduzir boilerplate de SSE nas subrotinas de demanda
// (apontamentos, comentários, checklist). Sempre dispara 'demand' 'update'
// porque o cliente refetcha a demanda inteira, não a sub-entidade.
function emitDemand(req, d, op = 'update') {
  broadcastChange('demand', op, { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
}

// GET single demand — usado pelo frontend pra refrescar o modal de detalhe
// sem precisar re-baixar a lista inteira. Permite quase-realtime via poll.
app.get('/api/demands/:id', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  res.json(d);
});

app.put('/api/demands/:id', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const b = req.body || {};
  const fired = []; // eventos a disparar no final
  const wasCompleted = !!d.completedAt;
  if (typeof b.name === 'string' && b.name.trim() && b.name.trim().slice(0, 300) !== d.name) {
    const oldName = d.name;
    d.name = b.name.trim().slice(0, 300);
    addHistory(d, req.user.id, 'renamed', { from: oldName, to: d.name });
  }
  if (b.projectId !== undefined) {
    const project = db.projects.find(p => p.id === b.projectId);
    if (project && canAccessWs(req.user, project.workspaceId) && project.id !== d.projectId) {
      const oldId = d.projectId;
      d.projectId = project.id; d.workspaceId = project.workspaceId;
      addHistory(d, req.user.id, 'project_changed', { fromId: oldId, toId: project.id });
    }
  }
  if (typeof b.description === 'string') {
    // 60 MB pra caber múltiplos prints (data: URIs); sanitizeCommentHtml converte
    // pra /uploads e o final vira KB (texto + URLs curtas).
    const nextDesc = sanitizeCommentHtml(b.description.slice(0, 60 * 1024 * 1024)).slice(0, 500 * 1024);
    if (nextDesc !== d.description) {
      d.description = nextDesc;
      addHistory(d, req.user.id, 'description_changed', null);
    }
  }
  if (typeof b.briefing === 'string') {
    const newBrief = normalizeUrlSrv(b.briefing);
    if (newBrief !== d.briefing) {
      d.briefing = newBrief;
      addHistory(d, req.user.id, 'briefing_changed', { url: newBrief });
    }
  }
  if (b.attachments !== undefined) {
    const oldIds = (d.attachments || []).map(a => a.id);
    const newAtts = sanitizeAttachments(b.attachments);
    const newIds = newAtts.map(a => a.id);
    newAtts.filter(a => !oldIds.includes(a.id)).forEach(a => addHistory(d, req.user.id, 'attachment_added', { kind: a.kind, name: a.name }));
    (d.attachments || []).filter(a => !newIds.includes(a.id)).forEach(a => addHistory(d, req.user.id, 'attachment_removed', { kind: a.kind, name: a.name }));
    d.attachments = newAtts;
  }
  if (b.deadline !== undefined && (b.deadline || null) !== d.deadline) {
    const oldDeadline = d.deadline;
    d.deadline = b.deadline || null;
    addHistory(d, req.user.id, 'deadline_changed', { from: oldDeadline, to: d.deadline });
    fired.push('demand.deadline_changed');
  }
  if (b.estimatedHours !== undefined) {
    const newEst = Number(b.estimatedHours) > 0 ? Math.round(Number(b.estimatedHours) * 100) / 100 : null;
    if (newEst !== d.estimatedHours) {
      const oldEst = d.estimatedHours;
      d.estimatedHours = newEst;
      addHistory(d, req.user.id, 'estimated_hours_changed', { from: oldEst, to: newEst });
    }
  }
  // Entregáveis — editáveis a qualquer momento (inclusive depois de "concluída")
  for (const field of ['qtyPieces', 'qtyArts', 'qtyVariations']) {
    if (b[field] !== undefined) {
      const v = Number(b[field]) > 0 ? Math.floor(Number(b[field])) : 0;
      if (v !== d[field]) {
        const oldV = d[field];
        d[field] = v;
        addHistory(d, req.user.id, 'deliverables_changed', { field, from: oldV, to: v });
      }
    }
  }
  // Quem fez os entregáveis (separado do ownerId atual, que pode mudar no fluxo).
  // null = cai pro owner. Aceita string vazia como "limpar".
  if (b.deliverableUserId !== undefined) {
    const newVal = b.deliverableUserId || null;
    if (newVal !== d.deliverableUserId) {
      const oldVal = d.deliverableUserId;
      d.deliverableUserId = newVal;
      addHistory(d, req.user.id, 'deliverable_user_changed', { from: oldVal, to: newVal });
    }
  }
  if (b.priority !== undefined) {
    const newP = [1,2,3,4].includes(Number(b.priority)) ? Number(b.priority) : 3;
    if (newP !== d.priority) {
      const oldP = d.priority;
      d.priority = newP;
      addHistory(d, req.user.id, 'priority_changed', { from: oldP, to: newP });
      fired.push('demand.priority_changed');
    }
  }
  if (b.recurrence !== undefined) {
    const newRec = sanitizeRecurrence(b.recurrence, d.recurrence);
    if (newRec && !newRec.createdBy) newRec.createdBy = req.user.id;
    const wasEnabled = !!(d.recurrence && d.recurrence.enabled);
    const isEnabled = !!(newRec && newRec.enabled);
    d.recurrence = newRec;
    if (!wasEnabled && isEnabled) addHistory(d, req.user.id, 'recurrence_enabled', { pattern: newRec.pattern });
    else if (wasEnabled && !isEnabled) addHistory(d, req.user.id, 'recurrence_disabled', null);
    else if (wasEnabled && isEnabled) addHistory(d, req.user.id, 'recurrence_changed', { pattern: newRec.pattern });
  }
  if (b.ownerId !== undefined) {
    const prevOwner = d.ownerId;
    d.ownerId = b.ownerId || null;
    if (d.ownerId !== prevOwner) {
      addHistory(d, req.user.id, 'owner_changed', { fromId: prevOwner, toId: d.ownerId });
      // Sync bidirecional: se muda o responsável da demanda, atualiza também o
      // executor da etapa ATUAL em stageResponsibles — assim os dois campos
      // ficam sempre coerentes (a UI mostra o mesmo user nos dois lugares).
      if (d.status) {
        if (!d.stageResponsibles || typeof d.stageResponsibles !== 'object') d.stageResponsibles = {};
        d.stageResponsibles[d.status] = d.ownerId;
      }
      if (d.ownerId && d.ownerId !== req.user.id) {
        const flow = db.flows.find(f => f.id === d.flowId);
        const st = flow ? flow.stages.find(s => s.id === d.status) : null;
        notify(d.ownerId, 'assigned', { demandId: d.id, demandName: d.name, stageName: st?.label || null }, req.user.id, appBaseUrl(req));
      }
      fired.push('demand.assigned');
    }
  }
  if (b.kanbanOrder !== undefined) {
    const n = Number(b.kanbanOrder);
    if (Number.isFinite(n)) d.kanbanOrder = n;
    else if (b.kanbanOrder === null) d.kanbanOrder = null;
  }
  if (b.stageDueDate !== undefined && (b.stageDueDate || null) !== d.stageDueDate) {
    const oldDue = d.stageDueDate;
    d.stageDueDate = b.stageDueDate || null;
    const last = d.stageHistory[d.stageHistory.length - 1];
    if (last) last.dueDate = d.stageDueDate;
    addHistory(d, req.user.id, 'stage_due_changed', { from: oldDue, to: d.stageDueDate });
  }

  // troca de fluxo: reinicia na primeira etapa
  if (b.flowId && b.flowId !== d.flowId) {
    const flow = db.flows.find(f => f.id === b.flowId);
    if (!flow) return res.status(400).json({ error: 'Fluxo inválido' });
    const oldFlowId = d.flowId;
    const first = flow.stages[0];
    d.flowId = flow.id;
    d.status = first.id;
    d.completedAt = first.done ? nowISO() : null;
    d.stageEnteredAt = nowISO();
    d.stageDueDate = resolveStageDueDate(first, d, today());
    d.stageHistory = [{ stageId: first.id, enteredAt: nowISO(), dueDate: d.stageDueDate }];
    addHistory(d, req.user.id, 'flow_changed', { fromId: oldFlowId, toId: d.flowId });
  }

  // mudança de etapa (avançar/retroceder/dropdown)
  let stageChangeCtx = null;
  if (b.status && b.status !== d.status) {
    const flow = db.flows.find(f => f.id === d.flowId);
    // Considera etapas adicionadas por instância (stageAdditions), não só flow.stages.
    const stage = stageByIdForDemand(flow, d, b.status);
    if (!stage) return res.status(400).json({ error: 'Etapa inválida para este fluxo' });
    const oldStageId = d.status;
    const prevStage = stageByIdForDemand(flow, d, oldStageId);
    stageChangeCtx = { prevStage, stage };
    // fecha a etapa anterior no histórico
    const prev = d.stageHistory[d.stageHistory.length - 1];
    if (prev && !prev.leftAt) prev.leftAt = nowISO();
    d.status = stage.id;
    d.stageEnteredAt = nowISO();
    // o prazo da etapa começa a contar agora (independe de atraso anterior)
    d.stageDueDate = resolveStageDueDate(stage, d, today());
    d.stageHistory.push({ stageId: stage.id, enteredAt: nowISO(), dueDate: d.stageDueDate });
    addHistory(d, req.user.id, 'stage_changed', { fromId: oldStageId, toId: stage.id });
    fired.push('demand.stage_changed');
    // Responsável padrão da etapa assume a demanda (se configurado e sem override no payload).
    // Override por instância (d.stageResponsibles[stageId]) tem precedência sobre o padrão do fluxo.
    // Se a nova etapa não define responsável (autoOwner=null), LIMPA d.ownerId — evita herdar
    // o dono da etapa anterior (importante pra etapas terminais tipo "Concluída").
    if (b.ownerId === undefined) {
      const instOverride = (d.stageResponsibles && typeof d.stageResponsibles === 'object') ? d.stageResponsibles[stage.id] : undefined;
      const projForResolve = db.projects.find(p => p.id === d.projectId);
      const autoOwner = (instOverride !== undefined) ? instOverride : (resolveStageOwner(stage, projForResolve) || null);
      const prevOwner = d.ownerId;
      d.ownerId = autoOwner || null;
      if (d.ownerId !== prevOwner) {
        addHistory(d, req.user.id, 'owner_auto_assigned', { fromId: prevOwner, toId: d.ownerId, byStage: stage.id });
        if (d.ownerId && d.ownerId !== req.user.id) {
          notify(d.ownerId, 'stage_assigned', { demandId: d.id, demandName: d.name, stageName: stage.label }, req.user.id, appBaseUrl(req));
          fired.push('demand.stage_assigned');
        }
      }
    }
    // Notifica watchers da demanda sobre a mudança de etapa.
    notifyWatchers(d, 'watch_stage', { demandId: d.id, demandName: d.name, stageName: stage.label }, req.user.id, appBaseUrl(req));
    if (stage.done && !d.completedAt) d.completedAt = nowISO();
    if (!stage.done) d.completedAt = null;
  }
  saveEntity('demands', d);
  // Dispara webhooks acumulados
  const project = db.projects.find(p => p.id === d.projectId);
  const flow = db.flows.find(f => f.id === d.flowId);
  const owner = db.users.find(u => u.id === d.ownerId);
  const reqBase = appBaseUrl(req);
  fired.forEach(event => {
    const ctx = { demand: d, project, flow, user: req.user, owner, appBaseUrl: reqBase };
    if ((event === 'demand.stage_changed' || event === 'demand.stage_assigned') && stageChangeCtx) {
      ctx.stage = stageChangeCtx.stage;
      ctx.prevStage = stageChangeCtx.prevStage;
    }
    fireWebhook(event, ctx);
  });
  // Webhook de conclusão (separado, só dispara na transição "não concluído" → "concluído")
  if (!wasCompleted && d.completedAt) {
    fireWebhook('demand.completed', { demand: d, project, flow, user: req.user, owner, appBaseUrl: reqBase });
  }
  broadcastChange('demand', 'update', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.json(d);
});

app.delete('/api/demands/:id', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  softDelete('demands', d, req.user.id);
  broadcastChange('demand', 'delete', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.json({ ok: true, undoable: true, purgeAt: Date.parse(d.deletedAt) + UNDO_PURGE_MS });
});
app.post('/api/demands/:id/undelete', requireAuth, (req, res) => {
  const d = db.demands.find(x => x.id === req.params.id);
  if (!d || !canAccessWs(req.user, d.workspaceId) || !d.deletedAt) return res.status(404).json({ error: 'Demanda não encontrada ou não estava excluída' });
  undelete('demands', d);
  broadcastChange('demand', 'update', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.json(d);
});

/* ─── LIXEIRA (recuperação em 30 dias) ───
   Lista tudo que foi soft-deletado e ainda não purgado, dentro dos workspaces
   que o usuário acessa (modelos de cliente são globais → visíveis a todo mod/admin).
   Restaurar/limpar usam os endpoints genéricos abaixo.
   Acesso: moderador ou admin — quem pode excluir pode recuperar. */
// Modelos de cliente são globais (workspaceId null); pra eles, todo mod/admin acessa.
const trashAccessible = (user, type, e) => type === 'clientTemplates' ? true : canAccessWs(user, e.workspaceId);

app.get('/api/trash', requireAuth, modOrAdmin, (req, res) => {
  const userName   = id => (db.users.find(u => u.id === id) || {}).name || null;
  const wsName     = id => (db.workspaces.find(w => w.id === id) || {}).name || null;
  const clientName = id => { const c = db.clients.find(x => x.id === id); return c ? c.name : null; };
  const projName   = id => { const p = id && db.projects.find(x => x.id === id); return p ? p.name : null; };
  const enrich = (e, extra) => Object.assign({
    id: e.id,
    workspaceId: e.workspaceId,
    workspaceName: wsName(e.workspaceId),
    deletedAt: e.deletedAt,
    deletedByName: userName(e.deletedBy),
    purgeAt: Date.parse(e.deletedAt) + UNDO_PURGE_MS
  }, extra);

  // Mais recentes (excluídos por último) no topo.
  const byNewest = (a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt);

  const clients = db.clients
    .filter(c => c.deletedAt && canAccessWs(req.user, c.workspaceId))
    .map(c => enrich(c, { name: c.name || '(sem nome)' }))
    .sort(byNewest);

  const projects = db.projects
    .filter(p => p.deletedAt && canAccessWs(req.user, p.workspaceId))
    .map(p => enrich(p, { name: p.name || '(sem nome)', clientId: p.clientId, clientName: clientName(p.clientId) }))
    .sort(byNewest);

  // Demandas: oculta as que caíram em cascata com um projeto excluído — elas
  // voltam quando o projeto é restaurado, então listá-las aqui só confunde.
  const deletedProjectIds = new Set(db.projects.filter(p => p.deletedAt).map(p => p.id));
  const demands = db.demands
    .filter(d => d.deletedAt && canAccessWs(req.user, d.workspaceId) && !(d.projectId && deletedProjectIds.has(d.projectId)))
    .map(d => enrich(d, { name: d.name || '(sem nome)', projectName: projName(d.projectId), clientName: clientName((db.projects.find(x => x.id === d.projectId) || {}).clientId) }))
    .sort(byNewest);

  const flows = db.flows
    .filter(f => f.deletedAt && canAccessWs(req.user, f.workspaceId))
    .map(f => enrich(f, { name: f.name || '(sem nome)', projectName: projName(f.projectId) }))
    .sort(byNewest);

  const listas = db.listas
    .filter(l => l.deletedAt && canAccessWs(req.user, l.workspaceId))
    .map(l => enrich(l, { name: l.name || '(sem nome)', clientName: clientName(l.clientId), projectName: projName(l.projectId) }))
    .sort(byNewest);

  // Modelos de cliente: globais. Todo mod/admin vê a biblioteca de excluídos.
  const clientTemplates = (db.clientTemplates || [])
    .filter(t => t.deletedAt)
    .map(t => enrich(t, { name: t.name || '(sem nome)' }))
    .sort(byNewest);

  res.json({ clients, projects, demands, flows, listas, clientTemplates, purgeMs: UNDO_PURGE_MS });
});

/* Purga permanente de UMA entidade da lixeira. Cascatas:
   - projeto → leva as demandas que caíram junto (mesma janela de ~5s do restore);
   - lista   → as recorrentes vinculadas voltam a ficar "sem lista". */
const TRASH_SINGULAR = {
  clients: 'client', projects: 'project', demands: 'demand',
  flows: 'flow', listas: 'lista', clientTemplates: 'clientTemplate'
};
function purgeTrashEntity(type, e, byUserId) {
  if (type === 'projects') {
    const projDelTs = Date.parse(e.deletedAt);
    const isCascade = d => d.projectId === e.id && d.deletedAt && Math.abs(Date.parse(d.deletedAt) - projDelTs) < 5000;
    db.demands.filter(isCascade).forEach(d => removeEntity('demands', d.id));
    db.demands = db.demands.filter(d => !isCascade(d));
  }
  if (type === 'listas') {
    // Purga também os recorrentes vinculados (soft-deletados junto com a lista).
    const linked = db.recurrings.filter(r => r.listaId === e.id);
    linked.forEach(r => removeEntity('recurrings', r.id));
    db.recurrings = db.recurrings.filter(r => r.listaId !== e.id);
  }
  removeEntity(type, e.id);
  db[type] = (db[type] || []).filter(x => x.id !== e.id);
  broadcastChange(TRASH_SINGULAR[type], 'delete', { id: e.id, workspaceId: e.workspaceId, byUserId });
}

/* Restaurar da lixeira (genérico, todos os tipos). Reverte o soft-delete.
   Projeto restaura junto as demandas que caíram em cascata com ele. */
app.post('/api/trash/:type/:id/restore', requireAuth, modOrAdmin, (req, res) => {
  const type = req.params.type;
  if (!TRASH_SINGULAR[type]) return res.status(400).json({ error: 'Tipo inválido' });
  const e = (db[type] || []).find(x => x.id === req.params.id);
  if (!e || !trashAccessible(req.user, type, e) || !e.deletedAt) return res.status(404).json({ error: 'Item não encontrado na lixeira' });
  if (type === 'projects') {
    const projDelTs = Date.parse(e.deletedAt);
    undelete('projects', e);
    db.demands.forEach(d => {
      if (d.projectId === e.id && d.deletedAt && Math.abs(Date.parse(d.deletedAt) - projDelTs) < 5000) undelete('demands', d);
    });
  } else if (type === 'listas') {
    // Restaura a lista + os recorrentes que caíram em cascata com ela (mesma janela).
    const listaDelTs = Date.parse(e.deletedAt);
    undelete('listas', e);
    db.recurrings.forEach(r => {
      if (r.listaId === e.id && r.deletedAt && Math.abs(Date.parse(r.deletedAt) - listaDelTs) < 5000) {
        undelete('recurrings', r);
        broadcastChange('recurring', 'update', { id: r.id, workspaceId: r.workspaceId, byUserId: req.user.id });
      }
    });
  } else {
    undelete(type, e);
  }
  broadcastChange(TRASH_SINGULAR[type], 'update', { id: e.id, workspaceId: e.workspaceId, byUserId: req.user.id });
  res.json({ ok: true });
});

/* Purga permanente imediata — esvaziar da lixeira antes dos 30 dias.
   Irreversível: some do banco. Só age em item que JÁ está soft-deletado. */
app.delete('/api/trash/:type/:id', requireAuth, modOrAdmin, (req, res) => {
  const type = req.params.type;
  if (!TRASH_SINGULAR[type]) return res.status(400).json({ error: 'Tipo inválido' });
  const e = (db[type] || []).find(x => x.id === req.params.id);
  if (!e || !trashAccessible(req.user, type, e) || !e.deletedAt) return res.status(404).json({ error: 'Item não encontrado na lixeira' });
  purgeTrashEntity(type, e, req.user.id);
  res.json({ ok: true });
});

/* Limpar TODA uma lista da lixeira de uma vez. Segue os mesmos filtros do GET:
   só itens acessíveis; demandas em cascata de projetos excluídos ficam de fora. */
app.delete('/api/trash/:type', requireAuth, modOrAdmin, (req, res) => {
  const type = req.params.type;
  if (!TRASH_SINGULAR[type]) return res.status(400).json({ error: 'Tipo inválido' });
  let items = (db[type] || []).filter(e => e.deletedAt && trashAccessible(req.user, type, e));
  if (type === 'demands') {
    const deletedProjectIds = new Set(db.projects.filter(p => p.deletedAt).map(p => p.id));
    items = items.filter(d => !(d.projectId && deletedProjectIds.has(d.projectId)));
  }
  items.forEach(e => purgeTrashEntity(type, e, req.user.id));
  res.json({ ok: true, purged: items.length });
});

/* ── WATCHERS (Observar demanda) ──
   Usuário clica "Observar" no detalhe. Vira watcher, recebe notificações de
   mudança de etapa e novos comentários dessa demanda, mesmo sem ser responsável.
   POST /api/demands/:id/watch      → adiciona req.user aos watchers
   POST /api/demands/:id/unwatch    → remove
   O array `d.watchers` é criado on-demand. */
app.post('/api/demands/:id/watch', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  if (!Array.isArray(d.watchers)) d.watchers = [];
  if (!d.watchers.includes(req.user.id)) {
    d.watchers.push(req.user.id);
    saveEntity('demands', d);
    emitDemand(req, d);
  }
  res.json({ watching: true, count: d.watchers.length });
});
app.post('/api/demands/:id/unwatch', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  if (Array.isArray(d.watchers) && d.watchers.includes(req.user.id)) {
    d.watchers = d.watchers.filter(id => id !== req.user.id);
    saveEntity('demands', d);
    emitDemand(req, d);
  }
  res.json({ watching: false, count: (d.watchers || []).length });
});
/* Helper: notifica watchers da demanda pra um evento específico. Não notifica
   quem originou (trigger), nem o ownerId (que já é notificado pelo notify normal).
   Chamado dos handlers de stage change e comment. */
function notifyWatchers(demand, type, data, triggerUserId, baseUrl) {
  if (!demand || !Array.isArray(demand.watchers) || !demand.watchers.length) return;
  for (const uid of demand.watchers) {
    if (uid === triggerUserId) continue;
    if (uid === demand.ownerId) continue; // já foi notificado pelo notify padrão
    notify(uid, type, data, triggerUserId, baseUrl);
  }
}

/* Operações em lote sobre múltiplas demandas. Aceita { ids: [...], op, data }.
   ops suportadas:
     - setOwner   { ownerId|null }      → muda responsável
     - setStatus  { status }            → muda etapa (precisa que todas tenham fluxos compatíveis)
     - setPriority { priority: 1..4 }   → muda prioridade
     - delete                           → remove
   Retorna { updated, skipped, errors }. */
app.post('/api/demands/bulk', requireAuth, rateLimitBulk, (req, res) => {
  const { ids, op, data } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nenhuma demanda selecionada.' });
  if (!op || typeof op !== 'string') return res.status(400).json({ error: 'Operação não informada.' });
  const wsIds = (req.user.workspaces || []);
  const targets = db.demands.filter(d => ids.includes(d.id) && (req.user.isAdmin || wsIds.includes(d.workspaceId)));
  let updated = 0, skipped = 0;
  const errors = [];
  if (op === 'delete') {
    const wsIdForBroadcast = targets[0]?.workspaceId || null;
    // Soft delete — o cliente mostra "N demandas excluídas · Desfazer".
    // Retorna a lista de IDs pra o frontend poder chamar undelete de todos.
    targets.forEach(d => softDelete('demands', d, req.user.id));
    updated = targets.length;
    skipped = ids.length - updated;
    broadcastChange('demand', 'bulk', { workspaceId: wsIdForBroadcast, byUserId: req.user.id });
    return res.json({ updated, skipped, errors, undoable: true, deletedIds: targets.map(d => d.id) });
  }
  for (const d of targets) {
    try {
      if (op === 'setOwner') {
        const newOwner = data && data.ownerId ? String(data.ownerId) : null;
        if (newOwner !== d.ownerId) {
          const prevOwner = d.ownerId;
          d.ownerId = newOwner;
          addHistory(d, req.user.id, 'owner_changed', { fromId: prevOwner, toId: d.ownerId });
          if (d.ownerId && d.ownerId !== req.user.id) {
            const flow = db.flows.find(f => f.id === d.flowId);
            const st = flow ? flow.stages.find(s => s.id === d.status) : null;
            notify(d.ownerId, 'assigned', { demandId: d.id, demandName: d.name, stageName: st?.label || null }, req.user.id, appBaseUrl(req));
          }
          updated++;
        } else skipped++;
      } else if (op === 'setPriority') {
        const p = [1,2,3,4].includes(Number(data?.priority)) ? Number(data.priority) : 3;
        if (p !== d.priority) {
          const oldP = d.priority;
          d.priority = p;
          addHistory(d, req.user.id, 'priority_changed', { from: oldP, to: p });
          updated++;
        } else skipped++;
      } else if (op === 'setStatus') {
        const targetStageId = String(data?.status || '');
        const flow = db.flows.find(f => f.id === d.flowId);
        // Considera etapas adicionadas por instância também (stageAdditions).
        const stage = stageByIdForDemand(flow, d, targetStageId);
        let realStage;
        if (!stage) {
          // tenta casar por LABEL (kanban multi-fluxo agrupa por label) — inclui
          // adicionadas na busca por label.
          const wantLabel = String(data?.stageLabel || '').trim();
          const pool = flow ? [...flow.stages, ...(d.stageAdditions || [])] : (d.stageAdditions || []);
          const matchByLabel = wantLabel ? pool.find(s => s.label === wantLabel) : null;
          if (!matchByLabel) { skipped++; errors.push({ id: d.id, error: 'Etapa incompatível com o fluxo desta demanda.' }); continue; }
          realStage = matchByLabel;
        } else {
          realStage = stage;
        }
        if (realStage.id === d.status) { skipped++; continue; }
        const oldStageId = d.status;
        const prevStage = stageByIdForDemand(flow, d, oldStageId);
        const prev = d.stageHistory[d.stageHistory.length - 1];
        if (prev && !prev.leftAt) prev.leftAt = nowISO();
        d.status = realStage.id;
        d.stageEnteredAt = nowISO();
        d.stageDueDate = resolveStageDueDate(realStage, d, today());
        d.stageHistory.push({ stageId: realStage.id, enteredAt: nowISO(), dueDate: d.stageDueDate });
        addHistory(d, req.user.id, 'stage_changed', { fromId: oldStageId, toId: realStage.id });
        const wasCompleted = !!d.completedAt;
        if (realStage.done && !d.completedAt) d.completedAt = nowISO();
        if (!realStage.done) d.completedAt = null;
        // Auto-atribui responsável da nova etapa (mesma lógica do PUT individual).
        // Se etapa não define ninguém → limpa d.ownerId em vez de herdar da etapa anterior.
        const _bulkProj = db.projects.find(p => p.id === d.projectId);
        // Mesma resolução do PUT individual: override por instância (d.stageResponsibles)
        // tem precedência sobre o padrão do fluxo/projeto — senão o bulk reatribui
        // errado as demandas com responsável customizado por etapa.
        const _instOverride = (d.stageResponsibles && typeof d.stageResponsibles === 'object') ? d.stageResponsibles[realStage.id] : undefined;
        const stageOwner = ((_instOverride !== undefined) ? _instOverride : (resolveStageOwner(realStage, _bulkProj) || null)) || null;
        if (stageOwner !== d.ownerId) {
          const prevOwner = d.ownerId;
          d.ownerId = stageOwner;
          addHistory(d, req.user.id, 'owner_auto_assigned', { fromId: prevOwner, toId: d.ownerId, byStage: realStage.id });
          if (d.ownerId && d.ownerId !== req.user.id) {
            notify(d.ownerId, 'stage_assigned', { demandId: d.id, demandName: d.name, stageName: realStage.label }, req.user.id, appBaseUrl(req));
          }
        }
        // Watchers também recebem notificação de mudança de etapa (bulk).
        notifyWatchers(d, 'watch_stage', { demandId: d.id, demandName: d.name, stageName: realStage.label }, req.user.id, appBaseUrl(req));
        // Webhooks — mesmo conjunto de eventos do PUT individual.
        const owner = db.users.find(u => u.id === d.ownerId);
        const _bulkReqBase = appBaseUrl(req);
        fireWebhook('demand.stage_changed', () => ({
          demand: d, project: _bulkProj, flow, stage: realStage, prevStage, user: req.user, owner, appBaseUrl: _bulkReqBase
        }));
        if (!wasCompleted && d.completedAt) {
          fireWebhook('demand.completed', () => ({
            demand: d, project: _bulkProj, flow, user: req.user, owner, appBaseUrl: _bulkReqBase
          }));
        }
        updated++;
      } else if (op === 'setStageDue') {
        // Altera o prazo da ETAPA atual (stageDueDate) — é ele que dita o "prazo
        // efetivo" (effDue = stageDueDate || deadline) mostrado nas listas, no mapa
        // de prazos e no calendário. Aceita null/"" pra limpar OU YYYY-MM-DD.
        const dl = data?.date;
        if (dl !== null && dl !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(dl))) {
          skipped++; errors.push({ id: d.id, error: 'Data inválida.' }); continue;
        }
        const normDl = (dl === null || dl === '') ? null : String(dl);
        if (normDl !== d.stageDueDate) {
          const from = d.stageDueDate;
          d.stageDueDate = normDl;
          // Espelha na última entrada do stageHistory, como o PUT individual faz.
          const last = d.stageHistory && d.stageHistory[d.stageHistory.length - 1];
          if (last) last.dueDate = normDl;
          addHistory(d, req.user.id, 'stage_due_changed', { from, to: normDl });
          updated++;
        } else skipped++;
      } else if (op === 'setProject') {
        // Muda projeto (mesmo workspace). Bloqueia cross-workspace pra não
        // quebrar visibilidade/permissões.
        const newPid = data?.projectId ? String(data.projectId) : null;
        if (!newPid) { skipped++; errors.push({ id: d.id, error: 'Projeto obrigatório.' }); continue; }
        const proj = db.projects.find(p => p.id === newPid && (req.user.isAdmin || wsIds.includes(p.workspaceId)));
        if (!proj) { skipped++; errors.push({ id: d.id, error: 'Projeto inválido.' }); continue; }
        if (proj.workspaceId !== d.workspaceId) {
          skipped++; errors.push({ id: d.id, error: 'Projeto de outro squad.' }); continue;
        }
        if (newPid !== d.projectId) {
          const from = d.projectId;
          d.projectId = newPid;
          addHistory(d, req.user.id, 'project_changed', { from, to: newPid });
          updated++;
        } else skipped++;
      } else {
        errors.push({ id: d.id, error: 'Operação desconhecida.' });
        skipped++;
      }
    } catch (e) {
      errors.push({ id: d.id, error: e.message || 'Erro ao processar.' });
      skipped++;
    }
  }
  // Persistência incremental: só as demandas que efetivamente mudaram entram no batch.
  targets.forEach(d => saveEntity('demands', d));
  // Mudanças em lote: dispara um único evento "bulk" (frontend refetcha todas)
  broadcastChange('demand', 'bulk', { workspaceId: req.user.isAdmin ? null : wsIdsFor(req.user)[0], byUserId: req.user.id });
  res.json({ updated, skipped, errors });
});

/* Customização de etapas POR INSTÂNCIA — armazena, para esta demanda apenas:
   (a) skippedStages — IDs que devem ser puladas
   (b) stageResponsibles — override de responsável por etapa
   (c) stageOrder — ordem customizada das etapas (array de IDs)
   (d) stageLabels — override de rótulo por etapa
   O fluxo original permanece intacto. */
app.put('/api/demands/:id/skipped-stages', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const flow = db.flows.find(f => f.id === d.flowId);
  if (!flow) return res.status(400).json({ error: 'Fluxo da demanda não encontrado' });

  // ── stageAdditions: sincroniza etapas EXTRAS da demanda (novas + kept + rename).
  //    Body pode conter: novas (id começa com 'add-' ou id inexistente) e/ou existentes.
  //    Server gera IDs definitivos pras novas e remove qualquer existente omitida.
  const clientAdditionIdMap = {}; // id do cliente → id gerado no server (pra remap do stageOrder)
  let nextStageAdditions = Array.isArray(d.stageAdditions) ? d.stageAdditions.map(a => ({ ...a })) : [];
  if (Array.isArray(req.body?.stageAdditions)) {
    const existingById = new Map(nextStageAdditions.map(a => [a.id, a]));
    const rebuilt = [];
    for (const s of req.body.stageAdditions) {
      if (!s || typeof s !== 'object') continue;
      const label = String(s.label || '').trim().slice(0, 80);
      if (!label) continue;
      const days = Number.isInteger(Number(s.deadlineDays)) && Number(s.deadlineDays) >= 0 ? Number(s.deadlineDays) : null;
      let respId = null;
      if (typeof s.responsibleId === 'string' && s.responsibleId) {
        const u = db.users.find(x => x.id === s.responsibleId && x.active !== false);
        if (u && canAccessWs(u, d.workspaceId)) respId = u.id;
      }
      const color = typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#7A00FF';
      const dateAnchor = (typeof s.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.deadlineDate))
        ? s.deadlineDate : null;
      const done = !!s.done;
      const clientId = typeof s.id === 'string' ? s.id : '';
      // Se o cliente mandou um id que já existe na demanda → é UMA edição da existente.
      // Se não existe (ou não veio) → é uma NOVA addition; gera id server-side.
      if (clientId && existingById.has(clientId)) {
        const prev = existingById.get(clientId);
        rebuilt.push({ ...prev, label, color, deadlineDays: days, deadlineDate: dateAnchor, responsibleId: respId, done });
      } else {
        const newId = uid();
        if (clientId) clientAdditionIdMap[clientId] = newId;
        rebuilt.push({ id: newId, label, color, deadlineDays: days, deadlineDate: dateAnchor, responsibleId: respId, done });
      }
    }
    nextStageAdditions = rebuilt;
  }

  // Pool completo: etapas do fluxo + etapas adicionadas por instância (com as novas já dentro).
  // Sem isso, additions eram rejeitadas nas customizações (skip/rename/order/resp).
  const additionIds = nextStageAdditions.map(s => s.id);
  const validStageIds = new Set([...flow.stages.map(s => s.id), ...additionIds]);
  // Impede remover a etapa ATUAL da demanda via addition-remove.
  if (d.status && !validStageIds.has(d.status)) {
    return res.status(400).json({ error: 'Não é possível remover a etapa atual da demanda.' });
  }

  // ── skippedStages ──
  const raw = Array.isArray(req.body?.skippedStages) ? req.body.skippedStages : [];
  const skipped = [...new Set(raw.filter(id => typeof id === 'string' && validStageIds.has(id)))];
  if (skipped.includes(d.status)) {
    return res.status(400).json({ error: 'Não é possível desativar a etapa atual da demanda. Avance ou retroceda primeiro.' });
  }

  // ── stageResponsibles (mapa { stageId: userId|null } ) ──
  const rawResp = (req.body && typeof req.body.stageResponsibles === 'object' && req.body.stageResponsibles) || null;
  const stageResp = {};
  if (rawResp) {
    for (const sid of Object.keys(rawResp)) {
      if (!validStageIds.has(sid)) continue;
      const v = rawResp[sid];
      if (v === null) { stageResp[sid] = null; continue; }
      if (typeof v !== 'string' || !v) continue;
      const u = db.users.find(x => x.id === v && x.active !== false);
      if (!u || !canAccessWs(u, d.workspaceId)) continue;
      stageResp[sid] = u.id;
    }
  }

  // ── stageOrder (array de stage IDs na ordem desejada) ──
  // Remap: ids do cliente pra ids gerados no server (quando aplicável, additions novas).
  let stageOrder = null;
  if (Array.isArray(req.body?.stageOrder)) {
    const seen = new Set();
    stageOrder = [];
    for (const rawId of req.body.stageOrder) {
      if (typeof rawId !== 'string') continue;
      const id = clientAdditionIdMap[rawId] || rawId;
      if (validStageIds.has(id) && !seen.has(id)) {
        stageOrder.push(id);
        seen.add(id);
      }
    }
  }

  // ── stageLabels (mapa { stageId: labelString }, ignorando vazios e iguais ao fluxo) ──
  let stageLabels = null;
  if (req.body?.stageLabels && typeof req.body.stageLabels === 'object') {
    stageLabels = {};
    for (const sid of Object.keys(req.body.stageLabels)) {
      if (!validStageIds.has(sid)) continue;
      const v = req.body.stageLabels[sid];
      if (typeof v !== 'string') continue;
      const trimmed = v.trim().slice(0, 80);
      if (!trimmed) continue;
      // Original pode estar no fluxo OU nas etapas adicionadas por instância.
      const orig = flow.stages.find(s => s.id === sid) || (d.stageAdditions || []).find(s => s.id === sid);
      if (orig && trimmed !== orig.label) stageLabels[sid] = trimmed;
    }
  }

  // ── stageOverrides (mapa { stageId: { deadlineDays, deadlineDate, done } }) ──
  // Este editor aceita SLA (dias/data) E override de conclusão ("done"). Cor
  // continua sendo do fluxo (não faz sentido mudar por demanda). Só em etapas
  // do FLUXO — additions têm seus campos diretos no próprio objeto.
  let stageOverrides = null;
  if (req.body?.stageOverrides && typeof req.body.stageOverrides === 'object') {
    stageOverrides = {};
    const flowStageIds = new Set(flow.stages.map(s => s.id));
    for (const sid of Object.keys(req.body.stageOverrides)) {
      if (!flowStageIds.has(sid)) continue;
      const raw = req.body.stageOverrides[sid] || {};
      const orig = flow.stages.find(s => s.id === sid);
      const out = {};
      // Preserva cor pré-existente (esse editor não mexe em cor). Já `done` NÃO é
      // preservado do prev — o body agora é a fonte de verdade dele.
      const prev = (d.stageOverrides && d.stageOverrides[sid]) || {};
      if (prev.color !== undefined) out.color = prev.color;
      // done override — grava só se diferente do padrão do fluxo. undefined = sem override.
      if ('done' in raw) {
        if (typeof raw.done === 'boolean' && raw.done !== !!orig?.done) out.done = raw.done;
      } else if (prev.done !== undefined) {
        out.done = prev.done; // preserva se o body não veio com done
      }
      if ('deadlineDays' in raw) {
        const v = raw.deadlineDays;
        if (v === null || v === '') {
          // null explícito = "voltar pro padrão do fluxo" → só mantém se diferente
          // do fluxo original (senão o override é redundante — 0 chaves, remove).
          if (orig?.deadlineDays != null) out.deadlineDays = null;
        } else if (Number.isInteger(Number(v)) && Number(v) >= 0) {
          const n = Number(v);
          if (n !== (orig?.deadlineDays ?? null)) out.deadlineDays = n;
        }
      } else if (prev.deadlineDays !== undefined) {
        out.deadlineDays = prev.deadlineDays; // preserva se não veio no body
      }
      // deadlineDate: âncora de data que sobrepõe o SLA em dias na cascata.
      // Formato YYYY-MM-DD. null = remove âncora (volta pro modelo por dias).
      if ('deadlineDate' in raw) {
        const v = raw.deadlineDate;
        if (v === null || v === '') {
          // Só grava se havia âncora antes (senão é redundante).
          if (prev.deadlineDate) out.deadlineDate = null;
        } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
          out.deadlineDate = v;
        }
      } else if (prev.deadlineDate !== undefined) {
        out.deadlineDate = prev.deadlineDate;
      }
      if (Object.keys(out).length) stageOverrides[sid] = out;
    }
  }

  // Diffs para histórico
  const prevSkip = Array.isArray(d.skippedStages) ? d.skippedStages : [];
  const addedSkip = skipped.filter(id => !prevSkip.includes(id));
  const removedSkip = prevSkip.filter(id => !skipped.includes(id));
  const prevResp = (d.stageResponsibles && typeof d.stageResponsibles === 'object') ? d.stageResponsibles : {};
  const respChanged = [];
  const allRespKeys = new Set([...Object.keys(prevResp), ...Object.keys(stageResp)]);
  for (const sid of allRespKeys) {
    if (prevResp[sid] !== stageResp[sid]) respChanged.push({ stageId: sid, from: prevResp[sid] ?? null, to: stageResp[sid] ?? null });
  }
  const prevOrder = Array.isArray(d.stageOrder) ? d.stageOrder : [];
  const orderChanged = stageOrder !== null && (
    stageOrder.length !== prevOrder.length || stageOrder.some((id, i) => prevOrder[i] !== id)
  );
  const prevLabels = (d.stageLabels && typeof d.stageLabels === 'object') ? d.stageLabels : {};
  const labelChanges = [];
  if (stageLabels !== null) {
    const keys = new Set([...Object.keys(prevLabels), ...Object.keys(stageLabels)]);
    for (const sid of keys) {
      if (prevLabels[sid] !== stageLabels[sid]) {
        labelChanges.push({ stageId: sid, from: prevLabels[sid] || null, to: stageLabels[sid] || null });
      }
    }
  }

  // Diff dos overrides — SLA (deadlineDays), datas (deadlineDate) E done pra histórico
  const prevOverrides = (d.stageOverrides && typeof d.stageOverrides === 'object') ? d.stageOverrides : {};
  const slaChanges = [];
  const dateChanges = [];
  const doneChanges = [];
  if (stageOverrides !== null) {
    const keys = new Set([...Object.keys(prevOverrides), ...Object.keys(stageOverrides)]);
    for (const sid of keys) {
      const fromDays = prevOverrides[sid]?.deadlineDays ?? null;
      const toDays = stageOverrides[sid]?.deadlineDays ?? null;
      if (fromDays !== toDays) slaChanges.push({ stageId: sid, from: fromDays, to: toDays });
      const fromDate = prevOverrides[sid]?.deadlineDate ?? null;
      const toDate = stageOverrides[sid]?.deadlineDate ?? null;
      if (fromDate !== toDate) dateChanges.push({ stageId: sid, from: fromDate, to: toDate });
      const fromDone = prevOverrides[sid]?.done ?? null;
      const toDone = stageOverrides[sid]?.done ?? null;
      if (fromDone !== toDone) doneChanges.push({ stageId: sid, from: fromDone, to: toDone });
    }
  }

  d.skippedStages = skipped;
  d.stageResponsibles = stageResp;
  if (stageOrder !== null) d.stageOrder = stageOrder;
  if (stageLabels !== null) d.stageLabels = stageLabels;
  if (stageOverrides !== null) d.stageOverrides = stageOverrides;
  // Persiste stageAdditions se o body incluiu (rebuilt acima). Array vazio remove todas.
  if (Array.isArray(req.body?.stageAdditions)) {
    if (nextStageAdditions.length) d.stageAdditions = nextStageAdditions;
    else delete d.stageAdditions;
  }
  // Sync bidirecional: se o executor da etapa ATUAL mudou (via stageResponsibles
  // ou via addition.responsibleId), reflete em d.ownerId — os dois campos são
  // conceitualmente a mesma coisa quando a demanda está naquela etapa.
  if (d.status) {
    let curResp;
    if (Object.prototype.hasOwnProperty.call(d.stageResponsibles || {}, d.status)) {
      curResp = d.stageResponsibles[d.status];
    } else {
      const curAddition = (Array.isArray(d.stageAdditions) ? d.stageAdditions : []).find(a => a.id === d.status);
      if (curAddition) curResp = curAddition.responsibleId || null;
    }
    if (curResp !== undefined && curResp !== d.ownerId) {
      const prevOwner = d.ownerId;
      d.ownerId = curResp;
      addHistory(d, req.user.id, 'owner_changed', { fromId: prevOwner, toId: d.ownerId });
    }
    // Sync prazo: se o override de data (ou addition.deadlineDate) da etapa ATUAL
    // mudou, replica em d.stageDueDate — sem isso, editar a data pela tab Etapas
    // salva mas o input do footer continua com o valor antigo até refetch/navegação.
    let curDate = null;
    const ovForCur = d.stageOverrides?.[d.status];
    if (ovForCur && ovForCur.deadlineDate) curDate = ovForCur.deadlineDate;
    else {
      const curAdd = (Array.isArray(d.stageAdditions) ? d.stageAdditions : []).find(a => a.id === d.status);
      if (curAdd && curAdd.deadlineDate) curDate = curAdd.deadlineDate;
    }
    if (curDate && curDate !== d.stageDueDate) {
      const oldDue = d.stageDueDate;
      d.stageDueDate = curDate;
      const last = Array.isArray(d.stageHistory) ? d.stageHistory[d.stageHistory.length - 1] : null;
      if (last) last.dueDate = curDate;
      addHistory(d, req.user.id, 'stage_due_changed', { from: oldDue, to: curDate });
    }
  }
  // Safety net: limpa chaves órfãs em mapas por stageId — se uma addition foi
  // removida (e o client não limpou tudo), ainda temos garantia de coerência.
  const validIdsFinal = new Set([
    ...flow.stages.map(s => s.id),
    ...(Array.isArray(d.stageAdditions) ? d.stageAdditions.map(a => a.id) : [])
  ]);
  const cleanMap = obj => {
    if (!obj || typeof obj !== 'object') return obj;
    for (const k of Object.keys(obj)) if (!validIdsFinal.has(k)) delete obj[k];
    return obj;
  };
  cleanMap(d.stageResponsibles);
  cleanMap(d.stageLabels);
  cleanMap(d.stageOverrides);
  if (Array.isArray(d.skippedStages)) d.skippedStages = d.skippedStages.filter(id => validIdsFinal.has(id));
  if (Array.isArray(d.stageOrder)) d.stageOrder = d.stageOrder.filter(id => validIdsFinal.has(id));

  if (addedSkip.length || removedSkip.length || respChanged.length || orderChanged || labelChanges.length || slaChanges.length || dateChanges.length || doneChanges.length) {
    addHistory(d, req.user.id, 'stages_customized', {
      added: addedSkip, removed: removedSkip, responsibles: respChanged,
      orderChanged, labelChanges, slaChanges, dateChanges, doneChanges
    });
  }
  saveEntity('demands', d);
  res.json(d);
});

/* Apontamento de horas */
app.post('/api/demands/:id/time', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const b = req.body || {};
  const hours = Number(b.hours);
  if (!(hours > 0)) return res.status(400).json({ error: 'Informe as horas trabalhadas' });
  const entry = {
    id: uid(), userId: req.user.id, stageId: b.stageId || d.status,
    hours: Math.round(hours * 100) / 100,
    start: b.start || null, end: b.end || null,
    note: String(b.note || ''), createdAt: nowISO()
  };
  d.timeEntries.push(entry);
  addHistory(d, req.user.id, 'time_added', { hours: entry.hours, stageId: entry.stageId });
  saveEntity('demands', d);
  emitDemand(req, d);
  res.status(201).json(d);
});

app.put('/api/demands/:id/time/:entryId', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const e = d.timeEntries.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: 'Apontamento não encontrado' });
  if (e.userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Você só pode editar seus próprios apontamentos' });
  }
  const b = req.body || {};
  const hours = Number(b.hours);
  if (!(hours > 0)) return res.status(400).json({ error: 'Informe as horas trabalhadas' });
  const oldHours = e.hours;
  e.hours = Math.round(hours * 100) / 100;
  e.start = b.start || null;
  e.end = b.end || null;
  if (b.note !== undefined) e.note = String(b.note || '');
  e.editedAt = nowISO();
  addHistory(d, req.user.id, 'time_edited', { hours: e.hours, oldHours, stageId: e.stageId });
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

app.delete('/api/demands/:id/time/:entryId', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const e = d.timeEntries.find(x => x.id === req.params.entryId);
  if (e && e.userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Você só pode remover seus próprios apontamentos' });
  }
  if (e) addHistory(d, req.user.id, 'time_removed', { hours: e.hours, stageId: e.stageId });
  d.timeEntries = d.timeEntries.filter(x => x.id !== req.params.entryId);
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

/* Comentários com menção. `format`: 'html' (editor rich) ou 'text' (legacy). */
app.post('/api/demands/:id/comment', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const format = req.body?.format === 'html' ? 'html' : 'text';
  const rawText = String((req.body && req.body.text) || '');
  const text = format === 'html'
    ? sanitizeCommentHtml(rawText)
    : rawText.trim().slice(0, 10000);
  const attachments = sanitizeAttachments(req.body?.attachments).slice(0, 10);
  // Plain para extração de menções + validação de "vazio".
  const plain = format === 'html' ? stripHtmlToText(text) : text;
  if (!plain.trim() && !attachments.length && !/\<img\b/i.test(text)) {
    return res.status(400).json({ error: 'Escreva algo ou anexe um arquivo' });
  }
  // extrai menções @username válidas dentro do workspace
  const tokens = (plain.match(/@([a-zA-Z0-9._-]+)/g) || []).map(t => t.slice(1).toLowerCase());
  const mentions = db.users
    .filter(u => tokens.includes(u.username.toLowerCase()) && canAccessWs(u, d.workspaceId))
    .map(u => u.id);
  const c = { id: uid(), userId: req.user.id, text, format, mentions, attachments, reactions: {}, createdAt: nowISO(), editedAt: null };
  d.comments.push(c);
  addHistory(d, req.user.id, 'comment_added', { commentId: c.id, preview: plain.slice(0, 80) });
  // Notifica cada usuário mencionado
  const _mentionsBaseUrl = appBaseUrl(req);
  mentions.forEach(mid => {
    notify(mid, 'mention', { demandId: d.id, demandName: d.name, commentText: plain.slice(0, 120) }, req.user.id, _mentionsBaseUrl);
  });
  // Watchers recebem notificação de novo comentário — sem duplicar quem já foi mencionado.
  if (Array.isArray(d.watchers) && d.watchers.length) {
    const alreadyNotified = new Set(mentions);
    for (const uid of d.watchers) {
      if (uid === req.user.id || uid === d.ownerId || alreadyNotified.has(uid)) continue;
      notify(uid, 'watch_comment', { demandId: d.id, demandName: d.name, commentText: plain.slice(0, 120) }, req.user.id, _mentionsBaseUrl);
    }
  }
  saveEntity('demands', d);
  // Webhooks
  const project = db.projects.find(p => p.id === d.projectId);
  const flow = db.flows.find(f => f.id === d.flowId);
  const owner = db.users.find(u => u.id === d.ownerId);
  const reqBase = appBaseUrl(req);
  const mentionedUsers = mentions.map(id => {
    const mu = db.users.find(x => x.id === id);
    return mu ? { id: mu.id, name: mu.name, discordId: mu.discordId || null } : null;
  }).filter(Boolean);
  fireWebhook('comment.added', { demand: d, project, flow, user: req.user, owner, comment: c, mentionedUsers, appBaseUrl: reqBase });
  if (mentions.length) {
    fireWebhook('comment.mention', { demand: d, project, flow, user: req.user, owner, comment: c, mentionedUsers, appBaseUrl: reqBase });
  }
  emitDemand(req, d);
  res.status(201).json(d);
});

app.put('/api/demands/:id/comment/:cid', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const c = d.comments.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comentário não encontrado' });
  if (c.userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Você só pode editar seus próprios comentários' });
  }
  const format = req.body?.format === 'html' ? 'html' : (c.format === 'html' ? 'html' : 'text');
  const rawText = String((req.body && req.body.text) || '');
  const text = format === 'html'
    ? sanitizeCommentHtml(rawText)
    : rawText.trim().slice(0, 10000);
  const attachments = req.body?.attachments !== undefined
    ? sanitizeAttachments(req.body.attachments).slice(0, 10)
    : c.attachments;
  const plain = format === 'html' ? stripHtmlToText(text) : text;
  if (!plain.trim() && !(attachments && attachments.length) && !/\<img\b/i.test(text)) {
    return res.status(400).json({ error: 'O comentário não pode ficar vazio' });
  }
  c.text = text;
  c.format = format;
  c.attachments = attachments || [];
  c.editedAt = nowISO();
  // re-extrai menções (do texto puro)
  const tokens = (plain.match(/@([a-zA-Z0-9._-]+)/g) || []).map(t => t.slice(1).toLowerCase());
  c.mentions = db.users
    .filter(u => tokens.includes(u.username.toLowerCase()) && canAccessWs(u, d.workspaceId))
    .map(u => u.id);
  addHistory(d, req.user.id, 'comment_edited', { commentId: c.id });
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

app.delete('/api/demands/:id/comment/:cid', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const c = d.comments.find(x => x.id === req.params.cid);
  if (c && c.userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Você só pode remover seus próprios comentários' });
  }
  if (c) addHistory(d, req.user.id, 'comment_removed', { commentId: c.id });
  d.comments = d.comments.filter(x => x.id !== req.params.cid);
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

/* ── REAÇÕES EM COMENTÁRIOS ── */
const ALLOWED_REACTIONS = ['👍', '❤️', '👀', '✅', '🎉'];
app.post('/api/demands/:id/comment/:cid/react', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const c = d.comments.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comentário não encontrado' });
  const emoji = String((req.body && req.body.emoji) || '');
  if (!ALLOWED_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Emoji inválido' });
  if (!c.reactions || typeof c.reactions !== 'object') c.reactions = {};
  const arr = c.reactions[emoji] || [];
  const idx = arr.indexOf(req.user.id);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(req.user.id);
  if (arr.length === 0) delete c.reactions[emoji];
  else c.reactions[emoji] = arr;
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

/* ── CHECKLIST INTERNO ── */
app.post('/api/demands/:id/checklist', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Texto obrigatório' });
  if (!Array.isArray(d.checklist)) d.checklist = [];
  const item = {
    id: uid(), text,
    done: false, doneBy: null, doneAt: null,
    createdBy: req.user.id, createdAt: nowISO()
  };
  d.checklist.push(item);
  addHistory(d, req.user.id, 'checklist_added', { itemId: item.id, text });
  saveEntity('demands', d);
  emitDemand(req, d);
  res.status(201).json(d);
});
app.put('/api/demands/:id/checklist/:itemId', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const item = (d.checklist || []).find(x => x.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  const b = req.body || {};
  if (typeof b.text === 'string' && b.text.trim()) {
    item.text = b.text.trim().slice(0, 500);
    addHistory(d, req.user.id, 'checklist_edited', { itemId: item.id });
  }
  if (typeof b.done === 'boolean' && b.done !== item.done) {
    item.done = b.done;
    if (b.done) { item.doneBy = req.user.id; item.doneAt = nowISO(); }
    else { item.doneBy = null; item.doneAt = null; }
    addHistory(d, req.user.id, b.done ? 'checklist_checked' : 'checklist_unchecked', { itemId: item.id, text: item.text });
    if (b.done) {
      const project = db.projects.find(p => p.id === d.projectId);
      const flow = db.flows.find(f => f.id === d.flowId);
      const owner = db.users.find(u => u.id === d.ownerId);
      const reqBase = appBaseUrl(req);
      fireWebhook('checklist.completed', () => ({
        demand: d, project, flow, owner, user: req.user, item, appBaseUrl: reqBase
      }));
    }
  }
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});
app.delete('/api/demands/:id/checklist/:itemId', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const item = (d.checklist || []).find(x => x.id === req.params.itemId);
  if (item) addHistory(d, req.user.id, 'checklist_removed', { itemId: item.id, text: item.text });
  d.checklist = (d.checklist || []).filter(x => x.id !== req.params.itemId);
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

/* ── AGENDA / SCHEDULES ──
   Bloco = (userId, demandId, date YYYY-MM-DD, startMin, endMin).
   Minutos a partir da meia-noite — sem fuso horário, simples e robusto.
   Permissão: dono OU admin pode criar/editar/excluir; visualização é livre
   pra qualquer autenticado dentro do workspace. */
function getSchedule(id) { return db.schedules.find(s => s.id === id); }
function canEditSchedule(user, s) { return user.isAdmin || s.userId === user.id; }
function sanitizeScheduleBody(b) {
  const date = String(b.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? b.date : null;
  const startMin = Number.isInteger(Number(b.startMin)) ? Math.max(0, Math.min(1439, Number(b.startMin))) : null;
  const endMin = Number.isInteger(Number(b.endMin)) ? Math.max(1, Math.min(1440, Number(b.endMin))) : null;
  if (!date || startMin === null || endMin === null || endMin <= startMin) return null;
  return { date, startMin, endMin };
}
app.get('/api/schedules', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  const userId = req.query.userId || null;
  const from = req.query.from || null; // YYYY-MM-DD
  const to = req.query.to || null;
  const list = db.schedules.filter(s => {
    if (!ids.includes(s.workspaceId)) return false;
    if (userId && s.userId !== userId) return false;
    if (from && s.date < from) return false;
    if (to && s.date > to) return false;
    return true;
  });
  res.json(list);
});
app.get('/api/schedules/:id', requireAuth, (req, res) => {
  const s = db.schedules.find(x => x.id === req.params.id);
  if (!s || !canAccessWs(req.user, s.workspaceId)) return res.status(404).json({ error: 'Agendamento não encontrado' });
  res.json(s);
});
// Kinds válidos pros blocos livres — decide ícone/cor default no cliente.
const SCHEDULE_FREE_KINDS = ['meeting', 'focus', 'off', 'other'];
function sanitizeFreeBlockFields(b) {
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return null;
  const kind = SCHEDULE_FREE_KINDS.includes(b.kind) ? b.kind : 'other';
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : null;
  return { title, kind, color };
}
// Recorrência de blocos LIVRES — inspirada no seletor do Google Calendar.
// Formato:
//   pattern:    'daily' | 'weekly' | 'weekdays' | 'monthly-nth-weekday' | 'yearly'
//   interval:   inteiro >= 1 (a cada N dias/semanas/meses/anos)
//   byWeekday:  array de dow [0..6] (só usado quando pattern='weekly')
//   count:      1..MAX ocorrências (opcional)
//   until:      'YYYY-MM-DD' inclusive (opcional)
// Se nem count nem until vierem, usa MAX_HORIZON_DAYS como limite de segurança.
const RECURRENCE_PATTERNS = ['daily', 'weekly', 'weekdays', 'monthly-nth-weekday', 'yearly'];
const RECURRENCE_MAX_COUNT = 260;    // ~5 anos semanal, guarda contra runaway
const RECURRENCE_HORIZON_DAYS = 730; // 2 anos default quando "nunca termina"
function sanitizeRecurrence(r) {
  if (!r || typeof r !== 'object') return null;
  if (!RECURRENCE_PATTERNS.includes(r.pattern)) return null;
  const interval = Math.max(1, Math.min(365, Number.parseInt(r.interval, 10) || 1));
  const out = { pattern: r.pattern, interval };
  if (r.pattern === 'weekly') {
    const bwd = Array.isArray(r.byWeekday)
      ? [...new Set(r.byWeekday.map(x => Number.parseInt(x, 10)).filter(n => n >= 0 && n <= 6))].sort()
      : [];
    if (bwd.length) out.byWeekday = bwd;
  }
  if (r.count !== undefined && r.count !== null && r.count !== '') {
    const n = Math.max(1, Math.min(RECURRENCE_MAX_COUNT, Number.parseInt(r.count, 10) || 0));
    if (n) out.count = n;
  }
  if (typeof r.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.until)) {
    out.until = r.until;
  }
  return out;
}
// Expande uma recorrência em N datas 'YYYY-MM-DD' a partir de startYmd (inclusive).
// Respeita count/until; se nenhum, cap em RECURRENCE_HORIZON_DAYS a partir de start.
function expandRecurrenceDates(startYmd, rec) {
  const out = [];
  const start = new Date(startYmd + 'T12:00:00');
  const horizonEnd = new Date(start); horizonEnd.setDate(start.getDate() + RECURRENCE_HORIZON_DAYS);
  const untilDate = rec.until ? new Date(rec.until + 'T12:00:00') : null;
  const maxCount = rec.count || RECURRENCE_MAX_COUNT;
  const withinLimits = (d) => {
    if (out.length >= maxCount) return false;
    if (untilDate && d > untilDate) return false;
    if (!untilDate && d > horizonEnd) return false;
    return true;
  };
  const push = (d) => {
    if (!withinLimits(d)) return false;
    out.push(d.toISOString().slice(0, 10));
    return true;
  };
  const interval = rec.interval || 1;

  if (rec.pattern === 'daily') {
    let d = new Date(start);
    while (withinLimits(d)) {
      out.push(d.toISOString().slice(0, 10));
      d = new Date(d); d.setDate(d.getDate() + interval);
    }
  } else if (rec.pattern === 'weekdays') {
    // Atalho: todo dia útil (Seg–Sex), interval sempre 1.
    let d = new Date(start);
    while (withinLimits(d)) {
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
      d = new Date(d); d.setDate(d.getDate() + 1);
    }
  } else if (rec.pattern === 'weekly') {
    // Repete nos dias da semana escolhidos; sem seleção usa o dow do start.
    const byWeekday = (rec.byWeekday && rec.byWeekday.length) ? rec.byWeekday : [start.getDay()];
    // Ancora na segunda da semana do start pra iterar semana-a-semana consistente.
    const anchor = new Date(start);
    const startDow = start.getDay();
    anchor.setDate(start.getDate() - startDow); // domingo dessa semana
    let weekIdx = 0;
    while (true) {
      const weekStart = new Date(anchor); weekStart.setDate(anchor.getDate() + weekIdx * 7 * interval);
      let anyValid = false;
      for (const dow of byWeekday) {
        const d = new Date(weekStart); d.setDate(weekStart.getDate() + dow);
        if (d < start) continue;
        if (!withinLimits(d)) { anyValid = anyValid || (out.length < maxCount); continue; }
        out.push(d.toISOString().slice(0, 10));
        anyValid = true;
      }
      // Corta se estourou horizonte ou count ou não gerou nada nesta semana + já passou do horizonte
      const weekEndProbe = new Date(weekStart); weekEndProbe.setDate(weekStart.getDate() + 6);
      const beyondHorizon = untilDate ? (weekEndProbe > untilDate) : (weekEndProbe > horizonEnd);
      if (out.length >= maxCount) break;
      if (beyondHorizon) break;
      weekIdx++;
      if (weekIdx > 520) break; // guarda: 10 anos * interval
    }
  } else if (rec.pattern === 'monthly-nth-weekday') {
    // Ex: "primeira terça-feira do mês, a cada N meses". Deriva do start:
    // nth = ceil(dia / 7), dow = start.getDay().
    const dow = start.getDay();
    const nth = Math.ceil(start.getDate() / 7);
    let monthOffset = 0;
    while (true) {
      const y = start.getFullYear();
      const m = start.getMonth() + monthOffset * interval;
      const nthDate = _nthWeekdayOfMonth(y, m, dow, nth);
      if (!nthDate) { monthOffset++; if (monthOffset > 240) break; continue; }
      if (nthDate < start) { monthOffset++; continue; }
      if (!withinLimits(nthDate)) break;
      out.push(nthDate.toISOString().slice(0, 10));
      monthOffset++;
      if (monthOffset > 240) break; // 20 anos * interval
    }
  } else if (rec.pattern === 'yearly') {
    const day = start.getDate();
    const month = start.getMonth();
    let yearOffset = 0;
    while (true) {
      const d = new Date(start.getFullYear() + yearOffset * interval, month, day, 12, 0, 0);
      // Se o mês não tem esse dia (raro pra yearly, ex.: 29 fev), pula.
      if (d.getMonth() !== month) { yearOffset++; if (yearOffset > 100) break; continue; }
      if (d < start) { yearOffset++; continue; }
      if (!withinLimits(d)) break;
      out.push(d.toISOString().slice(0, 10));
      yearOffset++;
      if (yearOffset > 100) break;
    }
  }
  return out;
}
// Retorna o Date do N-ésimo `dow` do mês (ex.: 3ª terça). Se o mês não tiver
// essa ocorrência (ex.: 5ª sexta em fev), retorna null.
function _nthWeekdayOfMonth(year, month, dow, nth) {
  const first = new Date(year, month, 1, 12, 0, 0);
  const offset = (dow - first.getDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  const d = new Date(year, month, day, 12, 0, 0);
  if (d.getMonth() !== ((month % 12) + 12) % 12) return null;
  return d;
}
app.post('/api/schedules', requireAuth, (req, res) => {
  const b = req.body || {};
  const userId = b.userId || req.user.id;
  if (userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Só admins podem agendar pra outros usuários.' });
  }
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(400).json({ error: 'Usuário inválido' });
  const fields = sanitizeScheduleBody(b);
  if (!fields) return res.status(400).json({ error: 'Data e horários inválidos (endMin deve ser > startMin).' });

  // Duas variantes: bloco VINCULADO A DEMANDA (com demandId) ou LIVRE (com title).
  // Livre precisa de workspaceId explícito porque não herda de demanda.
  const isFree = !b.demandId;
  let s;
  if (isFree) {
    const free = sanitizeFreeBlockFields(b);
    if (!free) return res.status(400).json({ error: 'Título é obrigatório em blocos livres.' });
    const wsId = String(b.workspaceId || '');
    if (!wsId || !canAccessWs(req.user, wsId)) {
      return res.status(400).json({ error: 'Squad inválido pro bloco livre.' });
    }
    // Recorrência opcional: expande em N cópias, todas com o mesmo recurrenceGroupId
    // pra permitir edição/exclusão em série depois.
    const rec = sanitizeRecurrence(b.recurrence);
    if (rec) {
      const dates = expandRecurrenceDates(fields.date, rec);
      const recurrenceGroupId = uid();
      const created = [];
      for (const dt of dates) {
        const one = {
          id: uid(),
          workspaceId: wsId,
          userId,
          demandId: null,
          title: free.title,
          kind: free.kind,
          color: free.color,
          date: dt,
          startMin: fields.startMin,
          endMin: fields.endMin,
          stageColorSnapshot: null,
          recurrenceGroupId,
          recurrencePattern: rec.pattern,
          createdAt: nowISO(),
          createdBy: req.user.id
        };
        db.schedules.push(one);
        saveEntity('schedules', one);
        created.push(one);
      }
      broadcastChange('schedule', 'bulk', { workspaceId: wsId, byUserId: req.user.id });
      return res.status(201).json(created[0]);
    }
    s = {
      id: uid(),
      workspaceId: wsId,
      userId,
      demandId: null,
      title: free.title,
      kind: free.kind,
      color: free.color,
      ...fields,
      stageColorSnapshot: null,
      createdAt: nowISO(),
      createdBy: req.user.id
    };
  } else {
    const demand = db.demands.find(d => d.id === b.demandId);
    if (!demand) return res.status(400).json({ error: 'Demanda inválida' });
    if (!canAccessWs(req.user, demand.workspaceId)) return res.status(403).json({ error: 'Sem acesso ao workspace da demanda' });
    // Snapshot da cor da etapa atual da demanda no MOMENTO do agendamento.
    // Se a demanda depois mudar de etapa, o bloco na agenda continua com
    // a cor daquela etapa (o "estado" quando você planejou).
    const _flowForColor = db.flows.find(f => f.id === demand.flowId);
    const _stageForColor = _flowForColor ? _flowForColor.stages.find(st => st.id === demand.status) : null;
    const stageColorSnapshot = _stageForColor?.color || null;
    s = {
      id: uid(),
      workspaceId: demand.workspaceId,
      userId,
      demandId: demand.id,
      ...fields,
      stageColorSnapshot,
      createdAt: nowISO(),
      createdBy: req.user.id
    };
  }
  db.schedules.push(s);
  saveEntity('schedules', s);
  broadcastChange('schedule', 'create', { id: s.id, workspaceId: s.workspaceId, byUserId: req.user.id });
  res.status(201).json(s);
});
app.put('/api/schedules/:id', requireAuth, (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s || !canAccessWs(req.user, s.workspaceId)) return res.status(404).json({ error: 'Agendamento não encontrado' });
  if (!canEditSchedule(req.user, s)) return res.status(403).json({ error: 'Você só edita os próprios agendamentos.' });
  const b = req.body || {};
  // Troca demanda ou converte livre → demanda
  if (b.demandId && b.demandId !== s.demandId) {
    const d = db.demands.find(x => x.id === b.demandId);
    if (!d) return res.status(400).json({ error: 'Demanda inválida' });
    s.demandId = d.id;
    s.workspaceId = d.workspaceId;
    // Ao virar bloco vinculado, limpa campos exclusivos de livre.
    s.title = null; s.kind = null; s.color = null;
  }
  // Update campos do bloco livre (só faz sentido se s é livre, ou se está
  // sendo convertido demanda → livre passando b.demandId = null explicitamente).
  if (b.demandId === null || (!s.demandId && (b.title !== undefined || b.kind !== undefined || b.color !== undefined))) {
    const src = { title: b.title !== undefined ? b.title : s.title,
                  kind:  b.kind  !== undefined ? b.kind  : s.kind,
                  color: b.color !== undefined ? b.color : s.color };
    const free = sanitizeFreeBlockFields(src);
    if (!free) return res.status(400).json({ error: 'Título é obrigatório em blocos livres.' });
    s.demandId = null;
    s.title = free.title; s.kind = free.kind; s.color = free.color;
    s.stageColorSnapshot = null;
    if (b.workspaceId && canAccessWs(req.user, b.workspaceId)) s.workspaceId = b.workspaceId;
  }
  // Aceita mudança parcial (apenas data, só horário, etc) — só re-valida se vier
  if (b.date || b.startMin !== undefined || b.endMin !== undefined) {
    const merged = sanitizeScheduleBody({
      date: b.date || s.date,
      startMin: b.startMin !== undefined ? b.startMin : s.startMin,
      endMin: b.endMin !== undefined ? b.endMin : s.endMin
    });
    if (!merged) return res.status(400).json({ error: 'Data ou horários inválidos.' });
    s.date = merged.date; s.startMin = merged.startMin; s.endMin = merged.endMin;
  }
  saveEntity('schedules', s);
  broadcastChange('schedule', 'update', { id: s.id, workspaceId: s.workspaceId, byUserId: req.user.id });
  res.json(s);
});
app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: 'Agendamento não encontrado' });
  if (!canEditSchedule(req.user, s)) return res.status(403).json({ error: 'Você só remove os próprios agendamentos.' });
  const wsId = s.workspaceId;
  const scope = String(req.query.scope || 'one');
  // scope=series: exclui todos os blocos com mesmo recurrenceGroupId; futuros:
  // apenas os com data >= a data deste bloco.
  if ((scope === 'series' || scope === 'future') && s.recurrenceGroupId) {
    const gid = s.recurrenceGroupId;
    const cutoff = scope === 'future' ? s.date : null;
    const doomed = db.schedules.filter(x =>
      x.recurrenceGroupId === gid && canEditSchedule(req.user, x) &&
      (cutoff ? x.date >= cutoff : true));
    const ids = new Set(doomed.map(x => x.id));
    db.schedules = db.schedules.filter(x => !ids.has(x.id));
    doomed.forEach(x => removeEntity('schedules', x.id));
    broadcastChange('schedule', 'bulk', { workspaceId: wsId, byUserId: req.user.id });
    return res.json({ ok: true, deleted: doomed.length });
  }
  db.schedules = db.schedules.filter(x => x.id !== s.id);
  removeEntity('schedules', s.id);
  broadcastChange('schedule', 'delete', { id: s.id, workspaceId: wsId, byUserId: req.user.id });
  res.json({ ok: true });
});

/* ── RECURRINGS (demandas recorrentes mensais) ──
   Cada recurring é um "molde" que o usuário instancia mensalmente como demanda real.
   Não auto-gera: requer ação explícita do usuário (botão Gerar agora ou bulk
   "Gerar todas pendentes do mês"). Histórico em generations[{ym,demandId,createdAt}]
   permite re-gerar de meses passados (admin) e impede duplicata no mesmo mês. */
function getRecurring(id) { return db.recurrings.find(r => r.id === id); }
function canEditRecurring(user, r) {
  return user.isAdmin || r.createdBy === user.id;
}
function sanitizeRecurringBody(b, existing) {
  const cur = existing || {};
  const name = String(b.name ?? cur.name ?? '').trim();
  if (!name) return { error: 'Nome é obrigatório' };
  // projectId é opcional — no caso "Geral" (do painel), fica null.
  const projectIdRaw = (b.projectId !== undefined ? b.projectId : cur.projectId) || null;
  const project = projectIdRaw ? db.projects.find(p => p.id === projectIdRaw) : null;
  if (projectIdRaw && !project) return { error: 'Projeto inválido' };
  // clientId: explícito no body ou inferido do projeto
  const clientId = (b.clientId !== undefined ? b.clientId : cur.clientId) || project?.clientId || null;
  const clientEntity = clientId ? db.clients.find(c => c.id === clientId) : null;
  // listaId: valida ANTES pra poder usar como fonte de workspace (caso lista Geral sem cliente/projeto).
  let listaId = (b.listaId !== undefined ? b.listaId : cur.listaId) || null;
  const listaEntity = listaId ? db.listas.find(l => l.id === listaId) : null;
  if (listaId && !listaEntity) listaId = null;
  // Requer AO MENOS UM contexto: projeto, cliente OU lista
  if (!project && !clientEntity && !listaEntity) {
    return { error: 'Cliente, projeto ou lista obrigatório' };
  }
  const flow = db.flows.find(f => f.id === (b.flowId ?? cur.flowId));
  if (!flow) return { error: 'Fluxo não encontrado' };
  // Workspace efetivo: prioriza CLIENTE → projeto → lista → fluxo.
  // Motivo: se o cliente está no workspace X, todas as demandas dele devem
  // viver em X, mesmo que algum projeto tenha workspaceId inconsistente (drift).
  // Isso mantém a coluna de clientes e a filtragem por workspace consistentes.
  const workspaceId = clientEntity?.workspaceId || project?.workspaceId || listaEntity?.workspaceId || flow.workspaceId;
  if (!workspaceId) return { error: 'Não foi possível determinar o workspace' };
  const roleId = (b.roleId !== undefined ? b.roleId : cur.roleId) || null;
  const ownerId = (b.ownerId !== undefined ? b.ownerId : cur.ownerId) || null;
  const deliverableUserId = (b.deliverableUserId !== undefined ? b.deliverableUserId : cur.deliverableUserId) || null;
  const dayOfMonth = Number.isInteger(Number(b.dayOfMonth)) && Number(b.dayOfMonth) >= 1 && Number(b.dayOfMonth) <= 31
    ? Number(b.dayOfMonth) : (cur.dayOfMonth || null);
  // Se a lista pertence a outro workspace, invalida (segurança)
  if (listaEntity && listaEntity.workspaceId !== workspaceId) listaId = null;
  return {
    name,
    workspaceId,
    clientId, projectId: project?.id || null, flowId: flow.id,
    // demandType: chave PORTÁVEL do item entre clientes. Ao aplicar a lista em outro
    // cliente, resolvemos o fluxo daquele cliente por este tipo (não pelo flowId fixo).
    demandType: flow.demandType || null,
    roleId, ownerId, deliverableUserId, listaId,
    description: sanitizeCommentHtml(String(b.description ?? cur.description ?? '')),
    briefing: normalizeUrlSrv(b.briefing ?? cur.briefing ?? ''),
    priority: [1,2,3,4].includes(Number(b.priority ?? cur.priority)) ? Number(b.priority ?? cur.priority) : 3,
    qtyPieces:     Number(b.qtyPieces ?? cur.qtyPieces) > 0     ? Math.floor(Number(b.qtyPieces ?? cur.qtyPieces)) : 0,
    qtyArts:       Number(b.qtyArts ?? cur.qtyArts) > 0         ? Math.floor(Number(b.qtyArts ?? cur.qtyArts)) : 0,
    qtyVariations: Number(b.qtyVariations ?? cur.qtyVariations) > 0 ? Math.floor(Number(b.qtyVariations ?? cur.qtyVariations)) : 0,
    defaultChecklist: sanitizeChecklistTemplate(b.defaultChecklist !== undefined ? b.defaultChecklist : cur.defaultChecklist),
    attachments: sanitizeAttachments(b.attachments !== undefined ? b.attachments : cur.attachments),
    dayOfMonth,
    active: b.active !== undefined ? !!b.active : (cur.active !== undefined ? cur.active : true)
  };
}

app.get('/api/recurrings', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  const clientId = req.query.clientId || null;
  const projectId = req.query.projectId || null;
  const roleId = req.query.roleId || null;
  const userId = req.query.userId || null;
  const list = db.recurrings.filter(r => {
    if (!notDeleted(r)) return false;
    if (!ids.includes(r.workspaceId)) return false;
    if (clientId && r.clientId !== clientId) return false;
    if (projectId && r.projectId !== projectId) return false;
    if (roleId && r.roleId !== roleId) return false;
    if (userId && r.ownerId !== userId) return false;
    return true;
  });
  res.json(list);
});
app.get('/api/recurrings/:id', requireAuth, (req, res) => {
  const r = db.recurrings.find(x => x.id === req.params.id);
  if (!r || !canAccessWs(req.user, r.workspaceId)) return res.status(404).json({ error: 'Recorrência não encontrada' });
  res.json(r);
});

app.post('/api/recurrings', requireAuth, (req, res) => {
  const fields = sanitizeRecurringBody(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  if (!canAccessWs(req.user, fields.workspaceId)) return res.status(403).json({ error: 'Sem acesso ao workspace' });
  const r = {
    id: uid(),
    ...fields,
    generations: [],
    createdAt: nowISO(),
    createdBy: req.user.id,
    updatedAt: nowISO()
  };
  db.recurrings.push(r);
  saveEntity('recurrings', r);
  broadcastChange('recurring', 'create', { id: r.id, workspaceId: r.workspaceId, byUserId: req.user.id });
  res.status(201).json(r);
});

app.put('/api/recurrings/:id', requireAuth, (req, res) => {
  const r = getRecurring(req.params.id);
  if (!r || !canAccessWs(req.user, r.workspaceId)) return res.status(404).json({ error: 'Recorrente não encontrado' });
  if (!canEditRecurring(req.user, r)) return res.status(403).json({ error: 'Sem permissão pra editar este recorrente' });
  const fields = sanitizeRecurringBody(req.body || {}, r);
  if (fields.error) return res.status(400).json({ error: fields.error });
  if (!canAccessWs(req.user, fields.workspaceId)) return res.status(403).json({ error: 'Sem acesso ao workspace destino' });
  Object.assign(r, fields, { updatedAt: nowISO() });
  saveEntity('recurrings', r);
  broadcastChange('recurring', 'update', { id: r.id, workspaceId: r.workspaceId, byUserId: req.user.id });
  res.json(r);
});

app.delete('/api/recurrings/:id', requireAuth, (req, res) => {
  const r = getRecurring(req.params.id);
  if (!r) return res.status(404).json({ error: 'Recorrente não encontrado' });
  if (!canEditRecurring(req.user, r)) return res.status(403).json({ error: 'Sem permissão pra excluir este recorrente' });
  const wsId = r.workspaceId;
  db.recurrings = db.recurrings.filter(x => x.id !== r.id);
  removeEntity('recurrings', r.id);
  broadcastChange('recurring', 'delete', { id: r.id, workspaceId: wsId, byUserId: req.user.id });
  res.json({ ok: true });
});

// Gera demanda real a partir de um recorrente, marcando o mês como gerado.
// Body: { ym: 'YYYY-MM' } (default = mês corrente). Idempotente por (recurringId, ym).
app.post('/api/recurrings/:id/generate', requireAuth, (req, res) => {
  const r = getRecurring(req.params.id);
  if (!r || !canAccessWs(req.user, r.workspaceId)) return res.status(404).json({ error: 'Recorrente não encontrado' });
  if (!r.active) return res.status(400).json({ error: 'Recorrente inativo' });
  const ym = String(req.body?.ym || '').match(/^\d{4}-\d{2}$/) ? req.body.ym : new Date().toISOString().slice(0,7);
  const already = (r.generations || []).find(g => g.ym === ym);
  if (already) {
    const existing = db.demands.find(d => d.id === already.demandId);
    if (existing) return res.json({ ok: true, demand: existing, alreadyGenerated: true });
    // Demanda foi excluída — limpa o registro pra permitir nova geração
    r.generations = r.generations.filter(g => g.ym !== ym);
  }
  // Se o recorrente é "Geral" (sem projeto), usa como fallback um projeto ativo
  // do cliente NO MESMO WORKSPACE do recorrente — evita cair em projeto órfão
  // de outro workspace, que jogaria a demanda pro workspace errado.
  let project = r.projectId ? db.projects.find(p => p.id === r.projectId) : null;
  if (!project && r.clientId) {
    project = db.projects.find(p =>
      p.clientId === r.clientId && p.active !== false && p.workspaceId === r.workspaceId
    );
    // Último fallback: qualquer projeto do cliente (raro, só quando drift)
    if (!project) project = db.projects.find(p => p.clientId === r.clientId && p.active !== false);
  }
  const flow = db.flows.find(f => f.id === r.flowId);
  if (!project || !flow) return res.status(400).json({ error: 'Projeto ou fluxo do recorrente não existe mais' });
  const stage = flow.stages[0];
  if (!stage) return res.status(400).json({ error: 'Fluxo sem etapas' });
  // deadline = dia do mês solicitado (se dayOfMonth presente)
  const [y, m] = ym.split('-').map(Number);
  let deadline = null;
  if (r.dayOfMonth) {
    const lastDay = new Date(y, m, 0).getDate();
    const day = Math.min(r.dayOfMonth, lastDay);
    deadline = `${ym}-${String(day).padStart(2,'0')}`;
  }
  const stageDue = stage.deadlineDays ? addDays(today(), stage.deadlineDays) : deadline;
  const initialChecklist = (r.defaultChecklist || []).map(it => ({
    id: uid(), text: String(it.text || '').trim(),
    done: false, doneBy: null, doneAt: null,
    createdBy: req.user.id, createdAt: nowISO()
  })).filter(it => it.text);
  const d = {
    // workspaceId vem do RECORRENTE (não do projeto fallback) pra garantir
    // que a demanda apareça no workspace correto — mesmo se o projeto fallback
    // tiver workspaceId inconsistente por drift.
    id: uid(), workspaceId: r.workspaceId, projectId: project.id,
    flowId: flow.id, name: r.name,
    description: r.description || '',
    briefing: r.briefing || '',
    deadline,
    estimatedHours: null,
    priority: r.priority || 3,
    qtyPieces: r.qtyPieces || 0,
    qtyArts: r.qtyArts || 0,
    qtyVariations: r.qtyVariations || 0,
    deliverableUserId: r.deliverableUserId || null,
    status: stage.id,
    ownerId: r.ownerId || resolveStageOwner(stage, project) || null,
    stageEnteredAt: nowISO(), stageDueDate: stageDue,
    stageHistory: [{ stageId: stage.id, enteredAt: nowISO(), dueDate: stageDue }],
    timeEntries: [], comments: [], history: [],
    checklist: initialChecklist,
    attachments: (r.attachments || []).slice(),
    recurrence: null,
    createdAt: nowISO(),
    completedAt: null,
    recurringId: r.id,
    recurringYm: ym
  };
  addHistory(d, req.user.id, 'created', { demandName: d.name, fromRecurring: r.id });
  if (d.ownerId) addHistory(d, req.user.id, 'owner_set', { ownerId: d.ownerId });
  db.demands.push(d);
  if (d.ownerId && d.ownerId !== req.user.id) {
    notify(d.ownerId, 'assigned', { demandId: d.id, demandName: d.name, stageName: stage.label }, req.user.id, appBaseUrl(req));
  }
  // Marca como gerado
  r.generations = r.generations || [];
  r.generations.push({ ym, demandId: d.id, createdAt: nowISO(), createdBy: req.user.id });
  r.updatedAt = nowISO();
  saveEntity('recurrings', r);
  saveEntity('demands', d);
  const reqBase = appBaseUrl(req);
  fireWebhook('demand.created', () => ({
    demand: d, project, flow, stage, user: req.user,
    owner: db.users.find(u => u.id === d.ownerId),
    appBaseUrl: reqBase
  }));
  broadcastChange('demand', 'create', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  broadcastChange('recurring', 'update', { id: r.id, workspaceId: r.workspaceId, byUserId: req.user.id });
  res.status(201).json({ ok: true, demand: d, recurring: r });
});

/* ── LISTAS (agrupamento de recorrentes no painel Recorrentes) ──
   Cada lista é uma coleção nomeada dentro de (workspace, cliente, projeto).
   projectId=null significa "Geral" — nível cliente, sem projeto. */
function getLista(id) { return db.listas.find(l => l.id === id); }
function sanitizeListaBody(b, existing) {
  const cur = existing || {};
  const name = String(b.name ?? cur.name ?? '').trim();
  if (!name) return { error: 'Nome é obrigatório' };
  // kind: 'todo' = lista nova (to-do puro com items inline). null/undefined =
  // lista clássica (usa recurrings vinculados via listaId). Preserva o kind já
  // gravado; só define do body na criação.
  const kind = (b.kind === 'todo' || cur.kind === 'todo') ? 'todo' : null;
  const clientId = (b.clientId !== undefined ? b.clientId : cur.clientId) || null;
  const projectId = (b.projectId !== undefined ? b.projectId : cur.projectId) || null;
  // Workspace: prioriza projeto → cliente → workspaceId explícito do body → existing.
  // Cliente/projeto ambos opcionais (lista "geral" aplicável a todos os projetos).
  let workspaceId = cur.workspaceId || null;
  if (projectId) {
    const p = db.projects.find(x => x.id === projectId);
    if (!p) return { error: 'Projeto inválido' };
    workspaceId = p.workspaceId;
  }
  if (clientId) {
    const c = db.clients.find(x => x.id === clientId);
    if (!c) return { error: 'Cliente inválido' };
    workspaceId = workspaceId || c.workspaceId;
  }
  if (!workspaceId && b.workspaceId) workspaceId = b.workspaceId;
  if (!workspaceId) return { error: 'Workspace não pôde ser determinado' };
  const description = sanitizeCommentHtml(String(b.description ?? cur.description ?? ''));
  // sourceListaId: quando definido, marca essa lista como "aplicada" (snapshot de um template).
  // Listas com sourceListaId=null são templates originais (aparecem na aba Listas).
  // Listas com sourceListaId=X são instâncias aplicadas (não aparecem na aba Listas).
  const sourceListaId = (b.sourceListaId !== undefined ? b.sourceListaId : cur.sourceListaId) || null;
  // items: só entra em listas kind='todo'. Cada item = { id, name, demandType? }.
  // demandType (opcional) referencia a biblioteca universal de tipos de demanda
  // — usado ao gerar a demanda pra pré-selecionar o fluxo do tipo certo.
  let items = null;
  if (kind === 'todo') {
    const incoming = Array.isArray(b.items) ? b.items : (Array.isArray(cur.items) ? cur.items : []);
    const seen = new Set();
    items = [];
    for (const raw of incoming) {
      const nm = String(raw?.name ?? '').trim().slice(0, 200);
      if (!nm) continue;
      const id = (typeof raw?.id === 'string' && raw.id) ? raw.id : uid();
      if (seen.has(id)) continue;
      seen.add(id);
      const demandType = String(raw?.demandType ?? '').trim().slice(0, 60) || null;
      items.push({ id, name: nm, demandType });
    }
  }
  return {
    name, workspaceId, clientId: clientId || null, projectId: projectId || null,
    description, sourceListaId, kind,
    ...(items !== null ? { items } : {})
  };
}
app.get('/api/listas', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  const clientId = req.query.clientId || null;
  const projectId = req.query.projectId || null;
  const list = db.listas.filter(l => {
    if (!notDeleted(l)) return false;
    // Listas kind='todo' são GLOBAIS — visíveis pra qualquer usuário autenticado,
    // não importam clientId/projectId (elas nem têm). Listas legadas mantêm o
    // recorte por squad + cliente/projeto (comportamento original).
    if (l.kind === 'todo') return true;
    if (!ids.includes(l.workspaceId)) return false;
    if (clientId && l.clientId !== clientId) return false;
    if (projectId && l.projectId !== projectId) return false;
    return true;
  });
  res.json(list);
});
app.get('/api/listas/:id', requireAuth, (req, res) => {
  const l = db.listas.find(x => x.id === req.params.id);
  if (!l || !canAccessWs(req.user, l.workspaceId)) return res.status(404).json({ error: 'Lista não encontrada' });
  res.json(l);
});
app.post('/api/listas', requireAuth, (req, res) => {
  const fields = sanitizeListaBody(req.body || {});
  if (fields.error) return res.status(400).json({ error: fields.error });
  // Listas kind='todo' são globais — só as legadas checam acesso ao squad.
  if (fields.kind !== 'todo' && !canAccessWs(req.user, fields.workspaceId)) {
    return res.status(403).json({ error: 'Sem acesso ao workspace' });
  }
  const l = {
    id: uid(),
    ...fields,
    createdAt: nowISO(),
    createdBy: req.user.id,
    updatedAt: nowISO()
  };
  db.listas.push(l);
  saveEntity('listas', l);
  broadcastChange('lista', 'create', { id: l.id, workspaceId: l.workspaceId, byUserId: req.user.id });
  res.status(201).json(l);
});
app.put('/api/listas/:id', requireAuth, (req, res) => {
  const l = getLista(req.params.id);
  // kind='todo' é global — sempre visível/editável. Legada checa acesso ao squad.
  if (!l || (l.kind !== 'todo' && !canAccessWs(req.user, l.workspaceId))) {
    return res.status(404).json({ error: 'Lista não encontrada' });
  }
  const fields = sanitizeListaBody(req.body || {}, l);
  if (fields.error) return res.status(400).json({ error: fields.error });
  if (fields.kind !== 'todo' && !canAccessWs(req.user, fields.workspaceId)) {
    return res.status(403).json({ error: 'Sem acesso ao workspace destino' });
  }
  Object.assign(l, fields, { updatedAt: nowISO() });
  saveEntity('listas', l);
  broadcastChange('lista', 'update', { id: l.id, workspaceId: l.workspaceId, byUserId: req.user.id });
  res.json(l);
});
app.delete('/api/listas/:id', requireAuth, (req, res) => {
  const l = getLista(req.params.id);
  if (!l || !notDeleted(l)) return res.status(404).json({ error: 'Lista não encontrada' });
  // Global (kind='todo') = qualquer user autenticado pode excluir. Legada só do squad.
  if (l.kind !== 'todo' && !canAccessWs(req.user, l.workspaceId)) return res.status(403).json({ error: 'Sem acesso' });
  const isTodo = l.kind === 'todo';
  softDelete('listas', l, req.user.id);
  let deletedRecurrings = 0, deletedTasks = 0, deletedDemands = 0;

  if (isTodo) {
    // Lista NOVA: apaga (hard-delete) as tasks aplicadas dela + as demandas geradas.
    // Query param ?includeDemands=1 (default true) cascateia nas demandas.
    const includeDemands = req.query.includeDemands !== '0';
    const linkedTasks = (db.tasks || []).filter(t => t.listaSourceId === l.id);
    for (const t of linkedTasks) {
      if (includeDemands && t.demandId) {
        const d = db.demands.find(x => x.id === t.demandId && notDeleted(x));
        if (d) {
          softDelete('demands', d, req.user.id);
          broadcastChange('demand', 'delete', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
          deletedDemands++;
        }
      }
      db.tasks = db.tasks.filter(x => x.id !== t.id);
      removeEntity('tasks', t.id);
      deletedTasks++;
    }
    // Broadcast bulk de tasks (frontend refaz refetch da coleção).
    if (linkedTasks.length) broadcastChange('task', 'bulk', { workspaceId: l.workspaceId, byUserId: req.user.id });
  } else {
    // LEGADO: comportamento original — soft-delete dos recorrentes.
    const linked = db.recurrings.filter(r => r.listaId === l.id && notDeleted(r));
    linked.forEach(r => {
      softDelete('recurrings', r, req.user.id);
      broadcastChange('recurring', 'delete', { id: r.id, workspaceId: r.workspaceId, byUserId: req.user.id });
    });
    deletedRecurrings = linked.length;
  }

  broadcastChange('lista', 'delete', { id: l.id, workspaceId: l.workspaceId, byUserId: req.user.id });
  res.json({
    ok: true, undoable: !isTodo,
    deleted: { recurrings: deletedRecurrings, tasks: deletedTasks, demands: deletedDemands },
    purgeAt: Date.parse(l.deletedAt) + UNDO_PURGE_MS
  });
});

/* ── TAREFAS (kind='todo') ──
   Modelo simples de to-do: tarefa vive num projeto e pode virar demanda depois.
   Cada tarefa tem no máximo UMA demanda vinculada; se a demanda for excluída,
   o vínculo "libera" (frontend permite gerar de novo). Status visual (concluída,
   em andamento) é derivado da demanda vinculada — a tarefa em si não tem estado. */
app.get('/api/tasks', requireAuth, (req, res) => {
  const ids = wsIdsFor(req.user);
  const projectId = req.query.projectId || null;
  const list = (db.tasks || []).filter(t => {
    if (!ids.includes(t.workspaceId)) return false;
    if (projectId && t.projectId !== projectId) return false;
    return true;
  });
  res.json(list);
});
// Aplica uma lista (kind='todo') a um cliente E/OU projeto. Cria N tarefas.
// Aceita 3 formatos no body:
//   { listaId, projectId }              → tasks vinculadas ao projeto
//   { listaId, clientId }               → tasks vinculadas ao cliente, sem projeto
//   { listaId, clientId, projectId }    → equivalente ao 1º (projectId manda)
function _applyListaHandler(req, res) {
  const listaId = String(req.body?.listaId || '');
  const lista = db.listas.find(l => l.id === listaId && notDeleted(l));
  if (!lista) return res.status(404).json({ error: 'Lista não encontrada' });
  if (lista.kind !== 'todo') return res.status(400).json({ error: 'Só listas do tipo to-do podem ser aplicadas por aqui' });
  const projectIdIn = String(req.body?.projectId || '') || null;
  const clientIdIn = String(req.body?.clientId || '') || null;
  if (!projectIdIn && !clientIdIn) return res.status(400).json({ error: 'Informe clientId ou projectId de destino' });
  // Listas kind='todo' são GLOBAIS entre squads — não validamos squad da lista.
  // O que importa é o acesso do usuário ao squad de DESTINO (projeto/cliente).
  let project = null, client = null;
  if (projectIdIn) {
    project = db.projects.find(p => p.id === projectIdIn && notDeleted(p));
    if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });
    if (!canAccessWs(req.user, project.workspaceId)) return res.status(403).json({ error: 'Sem acesso ao squad do projeto' });
    client = project.clientId ? db.clients.find(c => c.id === project.clientId) : null;
  } else {
    client = db.clients.find(c => c.id === clientIdIn && notDeleted(c));
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
    if (!canAccessWs(req.user, client.workspaceId)) return res.status(403).json({ error: 'Sem acesso ao squad do cliente' });
  }
  const items = Array.isArray(lista.items) ? lista.items : [];
  if (!items.length) return res.status(400).json({ error: 'A lista está vazia' });
  const wsId = (project || client).workspaceId;
  const created = [];
  // applicationId único por chamada — mesmo se a lista for aplicada 2x no mesmo
  // projeto, cada aplicação vira um bloco separado no card (sem merge com a
  // aplicação anterior). É por ele que o agrupamento e delete-aplicação funcionam.
  const applicationId = uid();
  const nowIso = nowISO();
  // sortOrder incremental — inicia após o maior existente no MESMO escopo
  const sameScope = t => project ? t.projectId === project.id : (t.clientId === client.id && !t.projectId);
  const existing = (db.tasks || []).filter(sameScope);
  let cursor = existing.reduce((m, t) => Math.max(m, t.sortOrder || 0), 0);
  for (const it of items) {
    cursor += 10;
    const task = {
      id: uid(),
      workspaceId: wsId,
      projectId: project?.id || null,
      clientId: (project?.clientId) || client?.id || null,
      listaSourceId: lista.id,
      listaItemId: it.id,
      applicationId,
      appliedAt: nowIso,
      name: it.name,
      demandType: it.demandType || null, // usado ao gerar demanda pra pré-selecionar fluxo
      demandId: null,
      sortOrder: cursor,
      createdAt: nowIso,
      createdBy: req.user.id
    };
    db.tasks.push(task);
    saveEntity('tasks', task);
    created.push(task);
  }
  broadcastChange('task', 'bulk', { workspaceId: wsId, byUserId: req.user.id });
  res.status(201).json({ ok: true, created: created.length, applicationId, tasks: created });
}
app.post('/api/apply-lista', requireAuth, _applyListaHandler);
// Exclui SÓ uma aplicação (tasks + demandas geradas naquela chamada de apply).
// Preserva o template da lista. includeDemands=1 (default) cascateia nas demandas.
app.delete('/api/apply-lista/:applicationId', requireAuth, (req, res) => {
  const applicationId = String(req.params.applicationId || '');
  const affected = (db.tasks || []).filter(t => t.applicationId === applicationId);
  if (!affected.length) return res.status(404).json({ error: 'Aplicação não encontrada' });
  const wsId = affected[0].workspaceId;
  if (!canAccessWs(req.user, wsId)) return res.status(403).json({ error: 'Sem acesso ao squad' });
  const includeDemands = req.query.includeDemands !== '0';
  let deletedDemands = 0;
  for (const t of affected) {
    if (includeDemands && t.demandId) {
      const d = db.demands.find(x => x.id === t.demandId && notDeleted(x));
      if (d) {
        softDelete('demands', d, req.user.id);
        broadcastChange('demand', 'delete', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
        deletedDemands++;
      }
    }
    db.tasks = db.tasks.filter(x => x.id !== t.id);
    removeEntity('tasks', t.id);
  }
  broadcastChange('task', 'bulk', { workspaceId: wsId, byUserId: req.user.id });
  res.json({ ok: true, deleted: { tasks: affected.length, demands: deletedDemands } });
});
// Retro-compat: rota antiga → injeta projectId no body e reusa o handler.
app.post('/api/projects/:projectId/apply-lista', requireAuth, (req, res) => {
  req.body = { ...(req.body || {}), projectId: req.params.projectId };
  _applyListaHandler(req, res);
});
app.put('/api/tasks/:id', requireAuth, (req, res) => {
  const t = (db.tasks || []).find(x => x.id === req.params.id);
  if (!t || !canAccessWs(req.user, t.workspaceId)) return res.status(404).json({ error: 'Tarefa não encontrada' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 200);
  if (Number.isFinite(Number(b.sortOrder))) t.sortOrder = Number(b.sortOrder);
  saveEntity('tasks', t);
  broadcastChange('task', 'update', { id: t.id, workspaceId: t.workspaceId, byUserId: req.user.id });
  res.json(t);
});
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const t = (db.tasks || []).find(x => x.id === req.params.id);
  if (!t || !canAccessWs(req.user, t.workspaceId)) return res.status(404).json({ error: 'Tarefa não encontrada' });
  db.tasks = db.tasks.filter(x => x.id !== t.id);
  removeEntity('tasks', t.id);
  broadcastChange('task', 'delete', { id: t.id, workspaceId: t.workspaceId, byUserId: req.user.id });
  res.json({ ok: true });
});
// Vincula uma demanda a uma tarefa (chamado após criar a demanda a partir da
// tarefa). Valida que a demanda pertence ao mesmo projeto — evita link cruzado.
app.post('/api/tasks/:id/link-demand', requireAuth, (req, res) => {
  const t = (db.tasks || []).find(x => x.id === req.params.id);
  if (!t || !canAccessWs(req.user, t.workspaceId)) return res.status(404).json({ error: 'Tarefa não encontrada' });
  const demandId = String(req.body?.demandId || '');
  const d = db.demands.find(x => x.id === demandId);
  if (!d || !canAccessWs(req.user, d.workspaceId)) return res.status(404).json({ error: 'Demanda não encontrada' });
  if (d.projectId !== t.projectId) return res.status(400).json({ error: 'Demanda não pertence ao mesmo projeto' });
  t.demandId = d.id;
  saveEntity('tasks', t);
  broadcastChange('task', 'update', { id: t.id, workspaceId: t.workspaceId, byUserId: req.user.id });
  res.json(t);
});

/* ── WEBHOOKS ── */
// Webhooks são universais (valem pra todos os squads) — lista todos. Gate
// mod/admin: são só esses perfis que gerenciam a tela, e a lista expõe URLs.
// Payload NUNCA leva workspaceId — evita que cliente antigo tente inferir
// escopo de squad por esse campo (universalidade explícita no fio).
app.get('/api/webhooks', requireAuth, modOrAdmin, (req, res) => {
  // Anti-cache — nenhum proxy/browser deve reter esta resposta. GETs de webhook
  // são baratos e precisam refletir a verdade do momento.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const raw = db.webhooks || [];
  const list = raw.map(({ workspaceId, ...rest }) => rest);
  console.log(`[webhooks/get] user=${req.user.username} → ${list.length} webhook(s) (cache tem ${raw.length}; universais, sem filtro por squad)`);
  res.json(list);
});
function validateTargetUser(targetUserId) {
  if (!targetUserId) return { ok: true, value: null };
  const u = db.users.find(x => x.id === targetUserId);
  if (!u) return { ok: false, error: 'Usuário alvo não encontrado' };
  return { ok: true, value: u.id };
}
// Valida o par cliente/projeto do filtro do webhook. Ambos opcionais; se o projeto
// tem cliente definido, os dois precisam ser consistentes. Retorna os ids normalizados.
function validateWebhookScope(clientId, projectId) {
  let cId = null, pId = null;
  if (clientId) {
    const c = db.clients.find(x => x.id === clientId && notDeleted(x));
    if (!c) return { ok: false, error: 'Cliente do filtro não encontrado' };
    cId = c.id;
  }
  if (projectId) {
    const p = db.projects.find(x => x.id === projectId && notDeleted(x));
    if (!p) return { ok: false, error: 'Projeto do filtro não encontrado' };
    if (cId && p.clientId !== cId) return { ok: false, error: 'O projeto do filtro não pertence ao cliente selecionado' };
    pId = p.id;
    if (!cId && p.clientId) cId = p.clientId; // projeto define o cliente implicitamente
  }
  return { ok: true, clientId: cId, projectId: pId };
}
app.post('/api/webhooks', requireAuth, modOrAdmin, (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  if (!String(b.url || '').trim().startsWith('http')) return res.status(400).json({ error: 'URL inválida' });
  const validEvents = Array.isArray(b.events) ? b.events.filter(e => WEBHOOK_EVENTS[e]) : [];
  if (!validEvents.length) return res.status(400).json({ error: 'Selecione ao menos um evento' });
  const target = validateTargetUser(b.targetUserId || null);
  if (!target.ok) return res.status(400).json({ error: target.error });
  const scope = validateWebhookScope(b.clientId || null, b.projectId || null);
  if (!scope.ok) return res.status(400).json({ error: scope.error });
  // workspaceId do body é ignorado de propósito — webhooks são UNIVERSAIS.
  const h = {
    id: uid(), workspaceId: null,
    name: String(b.name).trim(),
    url: String(b.url).trim(),
    format: b.format === 'discord' ? 'discord' : 'raw',
    events: validEvents,
    targetUserId: target.value,
    clientId: scope.clientId,
    projectId: scope.projectId,
    active: b.active !== false,
    createdBy: req.user.id, createdAt: nowISO(),
    lastTriggered: null, lastStatus: null, lastError: null
  };
  db.webhooks.push(h);
  saveEntity('webhooks', h);
  const { workspaceId, ...rest } = h;
  res.status(201).json(rest);
});
app.put('/api/webhooks/:id', requireAuth, modOrAdmin, (req, res) => {
  const h = (db.webhooks || []).find(x => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'Webhook não encontrado' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) h.name = b.name.trim();
  if (typeof b.url === 'string' && b.url.trim().startsWith('http')) h.url = b.url.trim();
  if (b.format === 'discord' || b.format === 'raw') h.format = b.format;
  if (Array.isArray(b.events)) h.events = b.events.filter(e => WEBHOOK_EVENTS[e]);
  if (typeof b.active === 'boolean') h.active = b.active;
  if (b.targetUserId !== undefined) {
    const target = validateTargetUser(b.targetUserId || null);
    if (!target.ok) return res.status(400).json({ error: target.error });
    h.targetUserId = target.value;
  }
  if (b.clientId !== undefined || b.projectId !== undefined) {
    const nextClient = b.clientId !== undefined ? (b.clientId || null) : (h.clientId || null);
    const nextProject = b.projectId !== undefined ? (b.projectId || null) : (h.projectId || null);
    const scope = validateWebhookScope(nextClient, nextProject);
    if (!scope.ok) return res.status(400).json({ error: scope.error });
    h.clientId = scope.clientId;
    h.projectId = scope.projectId;
  }
  // Blindagem: mantém universal mesmo se algum código antigo tentar setar workspaceId.
  h.workspaceId = null;
  saveEntity('webhooks', h);
  const { workspaceId, ...rest } = h;
  res.json(rest);
});
app.delete('/api/webhooks/:id', requireAuth, modOrAdmin, (req, res) => {
  const h = (db.webhooks || []).find(x => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'Webhook não encontrado' });
  db.webhooks = db.webhooks.filter(x => x.id !== req.params.id);
  removeEntity('webhooks', req.params.id);
  res.json({ ok: true });
});
app.post('/api/webhooks/:id/test', requireAuth, modOrAdmin, async (req, res) => {
  const h = (db.webhooks || []).find(x => x.id === req.params.id);
  if (!h) return res.status(404).json({ error: 'Webhook não encontrado' });
  if (!isSafeWebhookUrl(h.url)) {
    h.lastError = 'URL bloqueada (rede interna, loopback ou protocolo inválido)';
    h.lastStatus = 0;
    saveEntity('webhooks', h);
    return res.status(400).json({ error: 'URL bloqueada: aponta pra rede interna, loopback ou usa protocolo não HTTP(S).' });
  }
  const fakeDemand = {
    id: 'test', name: '🧪 Teste do webhook do reWork',
    workspaceId: wsIdsFor(req.user)[0] || null, projectId: null, status: 'test',
    priority: 3, ownerId: req.user.id, description: 'Esta é uma mensagem de teste para validar a integração.'
  };
  const ctx = { demand: fakeDemand, project: null, user: req.user, owner: req.user, appBaseUrl: appBaseUrl(req) };
  try {
    const payload = h.format === 'discord' ? buildDiscordPayload('demand.created', ctx) : buildRawPayload('demand.created', ctx);
    const resp = await fetchWithTimeout(h.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    h.lastTriggered = nowISO();
    h.lastStatus = resp.status;
    h.lastError = resp.ok ? null : `HTTP ${resp.status}`;
    saveEntity('webhooks', h);
    if (!resp.ok) return res.status(502).json({ error: `Endpoint retornou HTTP ${resp.status}`, status: resp.status });
    res.json({ ok: true, status: resp.status });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout (>10s)' : String(e.message || e);
    h.lastError = msg.slice(0, 200);
    h.lastStatus = 0;
    saveEntity('webhooks', h);
    res.status(502).json({ error: 'Falha ao contatar o endpoint: ' + msg });
  }
});

/* ─── COFRE DE SENHAS ─────────────────────────────────────────────
   Cofre por-workspace. Cada entrada guarda { name, link, email, username } em
   claro e `passwordCipher` (AES-256-GCM via auth.encryptString). Acesso requer
   "destravar" o cofre digitando a própria senha da conta — o unlock é preso
   ao token de sessão, TTL 15min idle. Toda ação (view/create/update/delete)
   gera uma entry em passwordAudits (mod/admin veem tudo). */
const VAULT_UNLOCK_TTL_MS = 15 * 60 * 1000;
const _vaultUnlocked = new Map(); // token → expiresAt (ms) — legado (compat)
function _vaultUntil(token) {
  const until = _vaultUnlocked.get(token) || 0;
  if (until && until <= Date.now()) { _vaultUnlocked.delete(token); return 0; }
  return until;
}
function _vaultTouch(token) {
  const until = Date.now() + VAULT_UNLOCK_TTL_MS;
  _vaultUnlocked.set(token, until);
  return until;
}
function requireVaultUnlock(req, res, next) {
  if (!_vaultUntil(req.token)) return res.status(403).json({ error: 'vault_locked' });
  _vaultTouch(req.token); // sliding TTL — cada ação renova
  next();
}
/* ── Unlock POR PASTA ── Substitui o unlock global do cofre. Cada pasta
   requer autenticação separada com a senha da conta. TTL 15min sliding por
   pasta. Estado: `token → Map<folderId, expiresAt>`. */
const _folderUnlocked = new Map(); // token → Map(folderId → expiresAt ms)
function _folderUntil(token, folderId) {
  const m = _folderUnlocked.get(token);
  if (!m) return 0;
  const until = m.get(folderId) || 0;
  if (until && until <= Date.now()) { m.delete(folderId); return 0; }
  return until;
}
function _folderTouch(token, folderId) {
  let m = _folderUnlocked.get(token);
  if (!m) { m = new Map(); _folderUnlocked.set(token, m); }
  const until = Date.now() + VAULT_UNLOCK_TTL_MS;
  m.set(folderId, until);
  return until;
}
function _folderLock(token, folderId) {
  const m = _folderUnlocked.get(token);
  if (m) m.delete(folderId);
}
function requireFolderUnlock(folderId, req, res) {
  if (!folderId) { res.status(400).json({ error: 'folder_required' }); return false; }
  const until = _folderUntil(req.token, folderId);
  if (!until) { res.status(403).json({ error: 'folder_locked' }); return false; }
  _folderTouch(req.token, folderId); // sliding
  return true;
}
function _passwordListItem(p) {
  // Metadata pública — nunca inclui a senha em claro nem o cipher.
  const { passwordCipher, ...rest } = p;
  return rest;
}
function _logPasswordAudit(userId, passwordId, action, meta) {
  const audit = {
    id: uid(), userId, passwordId,
    action, // 'unlock' | 'lock' | 'view' | 'create' | 'update' | 'delete'
    meta: meta || null,
    createdAt: nowISO()
  };
  db.passwordAudits.push(audit);
  saveEntity('passwordAudits', audit);
}

app.post('/api/passwords/unlock', requireAuth, (req, res) => {
  const pw = String((req.body || {}).password || '');
  if (!pw) return res.status(400).json({ error: 'Senha obrigatória' });
  if (!auth.verifyPassword(req.user.id, pw)) {
    // Não loga tentativas falhas em passwordAudits pra não dar palco pra brute — só rate-limit.
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  const until = _vaultTouch(req.token);
  _logPasswordAudit(req.user.id, null, 'unlock', null);
  res.json({ ok: true, until, ttlMs: VAULT_UNLOCK_TTL_MS });
});
app.post('/api/passwords/lock', requireAuth, (req, res) => {
  if (_vaultUnlocked.has(req.token)) {
    _vaultUnlocked.delete(req.token);
    _logPasswordAudit(req.user.id, null, 'lock', null);
  }
  res.json({ ok: true });
});
app.get('/api/passwords/status', requireAuth, (req, res) => {
  const until = _vaultUntil(req.token);
  res.json({ unlocked: !!until, until, ttlMs: VAULT_UNLOCK_TTL_MS });
});

/* ─── PASTAS DO COFRE ───
   Modelo simplificado: TODAS as pastas são visíveis pra TODOS os usuários
   (sem whitelist, sem scope de workspace). Pra abrir uma pasta e ver as
   senhas dentro, o usuário autentica com a própria senha (unlock por pasta,
   TTL 15min sliding). Cada abertura + reveal fica registrado em audit.
   Auto-migração: passwords antigos com `folder: string` viram folder entities
   agrupados por (workspaceId, folder) na primeira leitura. */
function _folderVisibleTo(_folder, _user) {
  // Todos veem todas as pastas — o "acesso" real é via unlock por senha.
  return true;
}
function _migrateLegacyPasswordFolders() {
  if (!Array.isArray(db.passwordFolders)) db.passwordFolders = [];
  const legacyPws = (db.passwords || []).filter(p => notDeleted(p) && !p.folderId && (p.folder || '').trim());
  if (!legacyPws.length) return 0;
  // Agrupa por (workspaceId, folderName)
  const byKey = new Map();
  for (const p of legacyPws) {
    const key = p.workspaceId + ' ' + p.folder.trim();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  let created = 0;
  for (const [key, pws] of byKey) {
    const [wsId, name] = key.split(' ');
    // Se já existe folder com este nome no workspace, reusa (não duplica).
    let folder = (db.passwordFolders || []).find(f =>
      notDeleted(f) && f.workspaceId === wsId && f.name === name
    );
    if (!folder) {
      folder = {
        id: uid(),
        workspaceId: wsId,
        name,
        ownerId: pws[0].createdBy || null,
        memberIds: [], // legado: owner apenas. Owner pode adicionar membros depois.
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
      db.passwordFolders.push(folder);
      saveEntity('passwordFolders', folder);
      created++;
    }
    // Anexa passwords ao folder e limpa string legada
    for (const p of pws) {
      p.folderId = folder.id;
      p.folder = undefined;
      saveEntity('passwords', p);
    }
  }
  return created;
}
/* Cria uma pasta "Pessoal" pra usuários que não têm nenhuma acessível — evita
   ficarem sem opção pra criar uma senha nova. Idempotente. */
function _ensureUserPersonalFolder(user) {
  if (!Array.isArray(db.passwordFolders)) db.passwordFolders = [];
  const wsId = wsIdsFor(user)[0];
  if (!wsId) return null;
  const has = db.passwordFolders.find(f => notDeleted(f) && f.ownerId === user.id && f.workspaceId === wsId);
  if (has) return has;
  const folder = {
    id: uid(),
    workspaceId: wsId,
    name: 'Pessoal',
    ownerId: user.id,
    memberIds: [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  db.passwordFolders.push(folder);
  saveEntity('passwordFolders', folder);
  return folder;
}
function _passwordFolderItem(f, user) {
  const isOwner = f.ownerId === user.id;
  const memberCount = 1 + (Array.isArray(f.memberIds) ? f.memberIds.length : 0);
  return {
    id: f.id, workspaceId: f.workspaceId, name: f.name,
    ownerId: f.ownerId, memberIds: f.memberIds || [],
    isOwner, canEdit: isOwner || user.isAdmin,
    memberCount,
    createdAt: f.createdAt, updatedAt: f.updatedAt
  };
}
// Migração de folders legados — chamada depois que o db carrega (em loadDB).

// GET pastas — NÃO exige unlock nenhum. Todos veem todas as pastas.
app.get('/api/password-folders', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  if (!Array.isArray(db.passwordFolders)) db.passwordFolders = [];
  const list = db.passwordFolders
    .filter(f => notDeleted(f))
    .map(f => {
      const item = _passwordFolderItem(f, req.user);
      // Adiciona flag `unlocked` e `unlockedUntil` pra client saber estado.
      const until = _folderUntil(req.token, f.id);
      item.unlocked = !!until;
      item.unlockedUntil = until || null;
      item.entryCount = (db.passwords || []).filter(p => notDeleted(p) && p.folderId === f.id).length;
      return item;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
});
// Unlock por pasta — autentica com a senha da conta. TTL sliding 15min.
app.post('/api/password-folders/:id/unlock', requireAuth, (req, res) => {
  const folder = (db.passwordFolders || []).find(f => f.id === req.params.id && notDeleted(f));
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
  const pw = String((req.body || {}).password || '');
  if (!pw) return res.status(400).json({ error: 'Senha obrigatória' });
  if (!auth.verifyPassword(req.user.id, pw)) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  const until = _folderTouch(req.token, folder.id);
  _logPasswordAudit(req.user.id, folder.id, 'folder_unlock', { name: folder.name });
  res.json({ ok: true, folderId: folder.id, until, ttlMs: VAULT_UNLOCK_TTL_MS });
});
// Lock manual de uma pasta específica.
app.post('/api/password-folders/:id/lock', requireAuth, (req, res) => {
  const folder = (db.passwordFolders || []).find(f => f.id === req.params.id && notDeleted(f));
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
  _folderLock(req.token, folder.id);
  _logPasswordAudit(req.user.id, folder.id, 'folder_lock', { name: folder.name });
  res.json({ ok: true });
});
// Criar/editar/apagar pasta — só requer auth. Qualquer usuário pode criar.
app.post('/api/password-folders', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const wsId = b.workspaceId || wsIdsFor(req.user)[0] || null;
  const folder = {
    id: uid(),
    workspaceId: wsId,
    name,
    ownerId: req.user.id,
    memberIds: [], // Não é mais usado — mantido só pra compat com data existente.
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  if (!Array.isArray(db.passwordFolders)) db.passwordFolders = [];
  db.passwordFolders.push(folder);
  saveEntity('passwordFolders', folder);
  _logPasswordAudit(req.user.id, folder.id, 'folder_create', { name });
  res.status(201).json(_passwordFolderItem(folder, req.user));
});
app.put('/api/password-folders/:id', requireAuth, (req, res) => {
  const folder = (db.passwordFolders || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
  const isOwner = folder.ownerId === req.user.id;
  if (!isOwner && !req.user.isAdmin) return res.status(403).json({ error: 'Só o dono ou admin edita a pasta' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) folder.name = b.name.trim().slice(0, 60);
  folder.updatedAt = nowISO();
  saveEntity('passwordFolders', folder);
  _logPasswordAudit(req.user.id, folder.id, 'folder_update', { name: folder.name });
  res.json(_passwordFolderItem(folder, req.user));
});
app.delete('/api/password-folders/:id', requireAuth, (req, res) => {
  const folder = (db.passwordFolders || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
  const isOwner = folder.ownerId === req.user.id;
  if (!isOwner && !req.user.isAdmin) return res.status(403).json({ error: 'Só o dono ou admin remove a pasta' });
  const entriesInFolder = (db.passwords || []).filter(p => notDeleted(p) && p.folderId === folder.id);
  if (entriesInFolder.length > 0) {
    return res.status(400).json({ error: `Pasta tem ${entriesInFolder.length} entrada(s). Mova ou remova antes.` });
  }
  softDelete('passwordFolders', folder, req.user.id);
  _logPasswordAudit(req.user.id, folder.id, 'folder_delete', { name: folder.name });
  res.json({ ok: true });
});

// GET entradas — SEMPRE filtrado por folderId + exige a pasta destravada.
app.get('/api/passwords', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const folderId = String(req.query.folderId || '').trim();
  if (!folderId) return res.json([]); // Sem pasta selecionada = lista vazia.
  const folder = (db.passwordFolders || []).find(f => f.id === folderId && notDeleted(f));
  if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
  if (!requireFolderUnlock(folder.id, req, res)) return;
  const list = (db.passwords || [])
    .filter(p => notDeleted(p) && p.folderId === folderId)
    .map(_passwordListItem);
  _logPasswordAudit(req.user.id, folder.id, 'folder_view', { name: folder.name, count: list.length });
  res.json(list);
});
// Criar entrada — exige a pasta destravada.
app.post('/api/passwords', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const pwPlain = String(b.password || '');
  if (!pwPlain) return res.status(400).json({ error: 'Senha obrigatória' });
  const folderId = String(b.folderId || '').trim();
  if (!folderId) return res.status(400).json({ error: 'Escolha uma pasta' });
  const folder = (db.passwordFolders || []).find(f => f.id === folderId && notDeleted(f));
  if (!folder) return res.status(400).json({ error: 'Pasta inválida' });
  if (!requireFolderUnlock(folder.id, req, res)) return;
  const p = {
    id: uid(),
    workspaceId: folder.workspaceId,
    folderId,
    name,
    description: String(b.description || '').trim().slice(0, 500),
    link: String(b.link || '').trim(),
    email: String(b.email || '').trim(),
    username: String(b.username || '').trim(),
    passwordCipher: auth.encryptString(pwPlain),
    createdBy: req.user.id, createdAt: nowISO(),
    updatedBy: req.user.id, updatedAt: nowISO()
  };
  db.passwords.push(p);
  saveEntity('passwords', p);
  _logPasswordAudit(req.user.id, p.id, 'create', { name: p.name, folderId });
  res.status(201).json(_passwordListItem(p));
});
app.put('/api/passwords/:id', requireAuth, (req, res) => {
  const p = (db.passwords || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!p) return res.status(404).json({ error: 'Entrada não encontrada' });
  if (!requireFolderUnlock(p.folderId, req, res)) return;
  const b = req.body || {};
  const changed = [];
  if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== p.name) { p.name = b.name.trim(); changed.push('name'); }
  if (typeof b.description === 'string') { const v = b.description.trim().slice(0, 500); if (v !== (p.description || '')) { p.description = v; changed.push('description'); } }
  if (typeof b.link === 'string')     { const v = b.link.trim();     if (v !== p.link)     { p.link = v; changed.push('link'); } }
  if (typeof b.email === 'string')    { const v = b.email.trim();    if (v !== p.email)    { p.email = v; changed.push('email'); } }
  if (typeof b.username === 'string') { const v = b.username.trim(); if (v !== p.username) { p.username = v; changed.push('username'); } }
  if (typeof b.password === 'string' && b.password.length > 0) {
    p.passwordCipher = auth.encryptString(b.password);
    changed.push('password');
  }
  if (b.folderId && b.folderId !== p.folderId) {
    // Mover pra outra pasta: exige que a pasta destino também esteja destravada.
    if (!requireFolderUnlock(b.folderId, req, res)) return;
    const newFolder = (db.passwordFolders || []).find(f => f.id === b.folderId && notDeleted(f));
    if (!newFolder) return res.status(400).json({ error: 'Pasta destino inválida' });
    p.folderId = newFolder.id;
    p.workspaceId = newFolder.workspaceId;
    changed.push('folderId');
  }
  p.updatedBy = req.user.id;
  p.updatedAt = nowISO();
  saveEntity('passwords', p);
  _logPasswordAudit(req.user.id, p.id, 'update', { name: p.name, fields: changed });
  res.json(_passwordListItem(p));
});
app.delete('/api/passwords/:id', requireAuth, (req, res) => {
  const p = (db.passwords || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!p) return res.status(404).json({ error: 'Entrada não encontrada' });
  if (!requireFolderUnlock(p.folderId, req, res)) return;
  softDelete('passwords', p, req.user.id);
  _logPasswordAudit(req.user.id, p.id, 'delete', { name: p.name });
  res.json({ ok: true });
});
app.get('/api/passwords/:id/reveal', requireAuth, (req, res) => {
  const p = (db.passwords || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!p) return res.status(404).json({ error: 'Entrada não encontrada' });
  if (!requireFolderUnlock(p.folderId, req, res)) return;
  let plain = '';
  try { plain = auth.decryptString(p.passwordCipher); }
  catch (e) { return res.status(500).json({ error: 'Falha ao decifrar entrada (chave mestra pode ter mudado)' }); }
  _logPasswordAudit(req.user.id, p.id, 'view', { name: p.name });
  res.json({ password: plain });
});
/* ─── WebAuthn (Windows Hello / Touch ID / biometria / PIN) ───
   Alternativa rápida ao unlock por senha. O usuário registra 1+ credenciais
   (cada dispositivo/browser é uma cred). O finish da autenticação seta o
   mesmo flag de vault-unlocked que o unlock por senha — audit registra a
   fonte (`method: webauthn`).
   RP config: rpID vem do Host (sem porta); origin vem do header Origin
   (respeita http em dev e https em prod). Challenges vivem em memória,
   TTL 5min, one-time-use. */
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const _webauthnChallenges = new Map(); // userId → { challenge, kind: 'reg'|'auth', expiresAt }
function _stashChallenge(userId, kind, challenge) {
  _webauthnChallenges.set(userId, { challenge, kind, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
}
function _takeChallenge(userId, kind) {
  const c = _webauthnChallenges.get(userId);
  _webauthnChallenges.delete(userId); // one-time use
  if (!c || c.kind !== kind || c.expiresAt <= Date.now()) return null;
  return c.challenge;
}
function _webauthnRpConfig(req) {
  // Origin: header vindo do browser; se ausente (raro), compõe do request.
  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  const url = new URL(origin);
  const rpID = url.hostname; // localhost | rework.example.com
  return { origin, rpID, rpName: 'reWork' };
}
function _publicCredMeta(c) {
  const { publicKey, ...rest } = c;
  return rest;
}

app.get('/api/passwords/webauthn/credentials', requireAuth, (req, res) => {
  const list = auth.webauthnList(req.user.id).map(_publicCredMeta);
  res.json(list);
});
app.delete('/api/passwords/webauthn/credentials/:credId', requireAuth, (req, res) => {
  const ok = auth.webauthnRemove(req.user.id, req.params.credId);
  if (!ok) return res.status(404).json({ error: 'Credencial não encontrada' });
  res.json({ ok: true });
});
app.post('/api/passwords/webauthn/register/begin', requireAuth, async (req, res) => {
  const { rpID, rpName } = _webauthnRpConfig(req);
  const existing = auth.webauthnList(req.user.id).map(c => ({
    id: c.credentialID, transports: c.transports || undefined
  }));
  try {
    const options = await generateRegistrationOptions({
      rpName, rpID,
      userName: req.user.username || req.user.name || 'user',
      userDisplayName: req.user.name || req.user.username,
      userID: Buffer.from(req.user.id, 'utf8'),
      attestationType: 'none',
      excludeCredentials: existing,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      }
    });
    _stashChallenge(req.user.id, 'reg', options.challenge);
    res.json(options);
  } catch (e) {
    console.error('[webauthn/register/begin]', e);
    res.status(500).json({ error: 'Falha ao iniciar registro' });
  }
});
app.post('/api/passwords/webauthn/register/finish', requireAuth, async (req, res) => {
  const { origin, rpID } = _webauthnRpConfig(req);
  const challenge = _takeChallenge(req.user.id, 'reg');
  if (!challenge) return res.status(400).json({ error: 'Sessão de registro expirou. Tente de novo.' });
  const label = String((req.body || {}).label || 'Acesso').slice(0, 60);
  const kindRaw = String((req.body || {}).kind || 'biometric');
  const kind = kindRaw === 'pin' ? 'pin' : 'biometric'; // allowlist
  const response = (req.body || {}).response;
  if (!response) return res.status(400).json({ error: 'Resposta ausente' });
  try {
    const verification = await verifyRegistrationResponse({
      response, expectedChallenge: challenge,
      expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Registro não verificado' });
    }
    const info = verification.registrationInfo;
    auth.webauthnAdd(req.user.id, {
      credentialID: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64'),
      counter: info.credential.counter || 0,
      transports: info.credential.transports || null,
      name: label,
      kind,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      createdAt: nowISO(), lastUsedAt: null
    });
    res.json({ ok: true, credentialID: info.credential.id });
  } catch (e) {
    console.error('[webauthn/register/finish]', e);
    res.status(400).json({ error: e.message || 'Falha ao verificar registro' });
  }
});
app.post('/api/passwords/webauthn/auth/begin', requireAuth, async (req, res) => {
  const { rpID } = _webauthnRpConfig(req);
  const creds = auth.webauthnList(req.user.id);
  if (!creds.length) return res.status(404).json({ error: 'Nenhuma credencial registrada' });
  try {
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map(c => ({ id: c.credentialID, transports: c.transports || undefined })),
      userVerification: 'preferred'
    });
    _stashChallenge(req.user.id, 'auth', options.challenge);
    res.json(options);
  } catch (e) {
    console.error('[webauthn/auth/begin]', e);
    res.status(500).json({ error: 'Falha ao iniciar autenticação' });
  }
});
app.post('/api/passwords/webauthn/auth/finish', requireAuth, async (req, res) => {
  const { origin, rpID } = _webauthnRpConfig(req);
  const challenge = _takeChallenge(req.user.id, 'auth');
  if (!challenge) return res.status(400).json({ error: 'Sessão expirou. Tente de novo.' });
  const response = (req.body || {}).response;
  if (!response) return res.status(400).json({ error: 'Resposta ausente' });
  const cred = auth.webauthnFind(req.user.id, response.id);
  if (!cred) return res.status(404).json({ error: 'Credencial desconhecida' });
  try {
    const verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge,
      expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: cred.credentialID,
        publicKey: Buffer.from(cred.publicKey, 'base64'),
        counter: cred.counter || 0,
        transports: cred.transports || undefined
      }
    });
    if (!verification.verified) return res.status(400).json({ error: 'Assinatura inválida' });
    auth.webauthnUpdateCounter(req.user.id, cred.credentialID, verification.authenticationInfo.newCounter);
    // Novo modelo: se veio folderId no body, destrava só aquela pasta.
    // Sem folderId (legado): destrava o cofre global (compat com atalhos antigos).
    const folderId = String((req.body || {}).folderId || '').trim();
    if (folderId) {
      const folder = (db.passwordFolders || []).find(f => f.id === folderId && notDeleted(f));
      if (!folder) return res.status(404).json({ error: 'Pasta não encontrada' });
      const until = _folderTouch(req.token, folder.id);
      _logPasswordAudit(req.user.id, folder.id, 'folder_unlock', { method: 'webauthn', name: folder.name, credentialID: cred.credentialID });
      return res.json({ ok: true, folderId: folder.id, until, ttlMs: VAULT_UNLOCK_TTL_MS });
    }
    const until = _vaultTouch(req.token);
    _logPasswordAudit(req.user.id, null, 'unlock', { method: 'webauthn', credentialID: cred.credentialID, name: cred.name });
    res.json({ ok: true, until, ttlMs: VAULT_UNLOCK_TTL_MS });
  } catch (e) {
    console.error('[webauthn/auth/finish]', e);
    res.status(400).json({ error: e.message || 'Falha ao verificar assinatura' });
  }
});

/* ─── BASE DE CONHECIMENTO (posts) ───
   Posts com HTML sanitizado (permite iframes de domínios whitelist), tags
   normalizadas, autor + contributors auto-mantidos. Escopo per-squad como
   demais entidades (aparecem só nos squads que o user pertence). */
const POST_TAG_MAX_LEN = 40;
const POST_TAGS_MAX = 12;
const POST_TITLE_MAX = 180;
function _sanitizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const t = String(raw || '').trim().toLowerCase().slice(0, POST_TAG_MAX_LEN);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= POST_TAGS_MAX) break;
  }
  return out;
}
function _publicPost(p) {
  // Sem alteração — retorna o post cru. deletedAt é filtrado antes de sair.
  return p;
}
app.get('/api/posts', requireAuth, (req, res) => {
  const ids = new Set(wsIdsFor(req.user));
  const q = String(req.query.q || '').trim().toLowerCase();
  const tag = String(req.query.tag || '').trim().toLowerCase();
  const authorId = req.query.authorId || null;
  const list = (db.posts || [])
    .filter(p => notDeleted(p) && ids.has(p.workspaceId))
    .filter(p => !tag || (p.tags || []).includes(tag))
    .filter(p => !authorId || p.authorId === authorId)
    .filter(p => {
      if (!q) return true;
      const hay = (p.title || '').toLowerCase() + ' ' + stripHtmlToText(p.content || '').toLowerCase() + ' ' + (p.tags || []).join(' ');
      return hay.includes(q);
    })
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
    .map(_publicPost);
  res.json(list);
});
app.get('/api/posts/:id', requireAuth, (req, res) => {
  const p = (db.posts || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!p) return res.status(404).json({ error: 'Post não encontrado' });
  if (!canAccessWs(req.user, p.workspaceId)) return res.status(403).json({ error: 'Sem acesso' });
  res.json(_publicPost(p));
});
app.post('/api/posts', requireAuth, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, POST_TITLE_MAX);
  if (!title) return res.status(400).json({ error: 'Título obrigatório' });
  const wsId = b.workspaceId || wsIdsFor(req.user)[0];
  if (!wsId || !canAccessWs(req.user, wsId)) return res.status(403).json({ error: 'Sem acesso ao squad' });
  const now = nowISO();
  const p = {
    id: uid(),
    workspaceId: wsId,
    title,
    content: sanitizePostHtml(b.content || ''),
    tags: _sanitizeTags(b.tags),
    coverImage: typeof b.coverImage === 'string' && /^\/uploads\// .test(b.coverImage) ? b.coverImage : '',
    authorId: req.user.id,
    contributorIds: [],
    createdAt: now,
    updatedAt: now
  };
  db.posts.push(p);
  saveEntity('posts', p);
  broadcastChange('post', 'create', { id: p.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  res.status(201).json(_publicPost(p));
});
app.put('/api/posts/:id', requireAuth, (req, res) => {
  const p = (db.posts || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!p) return res.status(404).json({ error: 'Post não encontrado' });
  if (!canAccessWs(req.user, p.workspaceId)) return res.status(403).json({ error: 'Sem acesso' });
  // Todos com acesso ao squad podem editar — é knowledge base colaborativa.
  const b = req.body || {};
  if (typeof b.title === 'string') {
    const t = b.title.trim().slice(0, POST_TITLE_MAX);
    if (!t) return res.status(400).json({ error: 'Título obrigatório' });
    p.title = t;
  }
  if (typeof b.content === 'string') p.content = sanitizePostHtml(b.content);
  if (Array.isArray(b.tags)) p.tags = _sanitizeTags(b.tags);
  if (typeof b.coverImage === 'string') {
    p.coverImage = /^\/uploads\// .test(b.coverImage) ? b.coverImage : '';
  }
  if (b.workspaceId && b.workspaceId !== p.workspaceId) {
    if (!canAccessWs(req.user, b.workspaceId)) return res.status(403).json({ error: 'Sem acesso ao squad destino' });
    p.workspaceId = b.workspaceId;
  }
  // Contributors: adiciona editor se não é o autor e ainda não estava na lista.
  if (req.user.id !== p.authorId && !(p.contributorIds || []).includes(req.user.id)) {
    p.contributorIds = [...(p.contributorIds || []), req.user.id];
  }
  p.updatedAt = nowISO();
  saveEntity('posts', p);
  broadcastChange('post', 'update', { id: p.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  res.json(_publicPost(p));
});
app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const p = (db.posts || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!p) return res.status(404).json({ error: 'Post não encontrado' });
  if (!canAccessWs(req.user, p.workspaceId)) return res.status(403).json({ error: 'Sem acesso' });
  // Só autor ou admin/mod pode apagar (contributors não).
  const isAuthor = p.authorId === req.user.id;
  const isPrivileged = req.user.isAdmin || req.user.isModerator;
  if (!isAuthor && !isPrivileged) return res.status(403).json({ error: 'Apenas o autor ou moderadores podem excluir' });
  softDelete('posts', p, req.user.id);
  broadcastChange('post', 'delete', { id: p.id, workspaceId: p.workspaceId, byUserId: req.user.id });
  res.json({ ok: true });
});

app.get('/api/passwords/audit', requireAuth, modOrAdmin, (req, res) => {
  // Filtros opcionais: ?passwordId=... ?userId=... ?limit=200
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const pid = req.query.passwordId || null;
  const uid_q = req.query.userId || null;
  const list = (db.passwordAudits || [])
    .filter(a => (!pid || a.passwordId === pid) && (!uid_q || a.userId === uid_q))
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, limit);
  res.json(list);
});

/* ── TÍTULO DE LINK ──
   Resolve o <title>/og:title de uma URL pra guardar junto do link (campos
   Drive/Ativos de cliente e projeto) e exibir o nome da página no lugar da URL
   crua. Reusa o guard de SSRF e o fetch com timeout dos webhooks; segue redirects
   revalidando cada hop (pra youtu.be → youtube.com funcionar sem abrir brecha pra
   rede interna). Cache em memória por 24h evita refetch da mesma URL.

   Modelo: o título é resolvido UMA vez, ao salvar o cliente/projeto (em background,
   sem travar o save), e persistido em driveFilesTitle/brandAssetsTitle. Quando fica
   pronto, re-emite o broadcast → a tela recarrega via SSE e mostra o título sozinha.
   A visualização só lê o valor salvo, sem nenhum fetch. */
const linkTitleCache = new Map(); // url -> { title, ts }
const LINK_TITLE_TTL = 24 * 60 * 60 * 1000;
const LINK_TITLE_MAX_BYTES = 512 * 1024;

function decodeBasicEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } });
}
function extractPageTitle(html) {
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]*>/i);
  if (og) {
    const c = og[0].match(/content=["']([^"']*)["']/i);
    if (c && c[1].trim()) return decodeBasicEntities(c[1].replace(/\s+/g, ' ').trim()).slice(0, 200);
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return decodeBasicEntities(t[1].replace(/\s+/g, ' ').trim()).slice(0, 200);
  return null;
}
async function readCappedText(resp, maxBytes) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    return (await resp.text()).slice(0, maxBytes);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(Buffer.from(value)); total += value.length; }
    if (total >= maxBytes) { try { await reader.cancel(); } catch {} break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Segue redirects manualmente, revalidando o guard de SSRF a cada hop.
async function fetchHtmlSafe(startUrl, maxRedirects = 4) {
  let url = startUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!isSafeWebhookUrl(url)) return null;
    const resp = await fetchWithTimeout(url, {
      method: 'GET', redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; reWorkBot/1.0; +link-title)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    }, 6000);
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      try { url = new URL(loc, url).toString(); } catch { return null; }
      continue;
    }
    return resp;
  }
  return null; // redirects demais
}

// Resolve o título de UMA url (com cache de 24h). Retorna string ou null.
async function resolveLinkTitle(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(raw) || !isSafeWebhookUrl(raw)) return null;
  const cached = linkTitleCache.get(raw);
  if (cached && Date.now() - cached.ts < LINK_TITLE_TTL) return cached.title;
  let title = null;
  try {
    const resp = await fetchHtmlSafe(raw);
    if (resp && resp.ok) {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (!ct || ct.includes('text/html') || ct.includes('application/xhtml')) {
        const html = await readCappedText(resp, LINK_TITLE_MAX_BYTES);
        title = extractPageTitle(html);
      }
    }
  } catch { title = null; }
  linkTitleCache.set(raw, { title, ts: Date.now() });
  return title;
}

/* Atualiza driveFilesTitle/brandAssetsTitle da entidade em background. Só busca
   quando a URL mudou (URL igual mantém o título; URL vazia zera). Se algo mudou,
   re-salva e re-emite o broadcast pra tela pegar via SSE. `prev` = snapshot de
   { driveFiles, brandAssets, driveFilesTitle, brandAssetsTitle } de ANTES do save
   (null em criação → resolve tudo que tiver link). */
function refreshEntityLinkTitles(entityType, entity, prev, broadcastKind) {
  const fields = [['driveFiles', 'driveFilesTitle'], ['brandAssets', 'brandAssetsTitle']];
  const jobs = [];
  let syncChanged = false;
  for (const [uf, tf] of fields) {
    const url = (entity[uf] || '').trim();
    if (!url) { if (entity[tf] != null) { entity[tf] = null; syncChanged = true; } continue; }
    const sameUrl = prev && url === (prev[uf] || '').trim();
    if (sameUrl && prev[tf] !== undefined) { entity[tf] = prev[tf]; continue; } // URL inalterada
    jobs.push(resolveLinkTitle(url).then(t => {
      if (entity[tf] !== t) { entity[tf] = t; return true; }
      return false;
    }).catch(() => false));
  }
  if (!jobs.length) {
    if (syncChanged) saveEntity(entityType, entity);
    return;
  }
  Promise.all(jobs).then(results => {
    if (syncChanged || results.some(Boolean)) {
      saveEntity(entityType, entity);
      // Sem byUserId: o broadcast precisa chegar TAMBÉM a quem salvou (o título
      // ficou pronto depois da resposta do save; broadcastChange pula o originador).
      broadcastChange(broadcastKind, 'update', { id: entity.id, workspaceId: entity.workspaceId });
    }
  }).catch(() => {});
}

/* ── MÉTRICAS DE SLA ── */
// Resume um Set de nomes de fluxo em uma string humana. Um → o próprio nome.
// Poucos → junta com vírgula. Muitos → "N fluxos".
function _summarizeFlowNames(set) {
  const arr = [...(set || [])].filter(Boolean);
  if (!arr.length) return '—';
  if (arr.length === 1) return arr[0];
  if (arr.length <= 3) return arr.join(', ');
  return `${arr.length} fluxos`;
}
app.get('/api/reports/sla', requireAuth, rateLimitReport, (req, res) => {
  const ids = wsIdsFor(req.user);
  // Aceita 1..N workspaces em CSV (filtro de squads multi do front). Vazio = todos.
  const requested = String(req.query.workspaceId || '').split(',').map(s => s.trim()).filter(Boolean);
  const period = String(req.query.period || '30'); // dias, ou 'all'
  const clientId = String(req.query.clientId || '');
  const projectId = String(req.query.projectId || '');
  const flowId = String(req.query.flowId || '');

  if (requested.some(w => !ids.includes(w))) return res.status(403).json({ error: 'Sem acesso' });
  const wsFilter = requested.length ? requested : ids;

  // Período retroativo
  let startDate = null;
  if (period !== 'all') {
    const days = parseInt(period, 10) || 30;
    const d = new Date(); d.setDate(d.getDate() - days);
    startDate = d.toISOString().slice(0, 10);
  }

  // Demandas concluídas no período
  let demands = db.demands.filter(d => wsFilter.includes(d.workspaceId));
  if (clientId) {
    const projIds = new Set(db.projects.filter(p => p.clientId === clientId).map(p => p.id));
    demands = demands.filter(d => projIds.has(d.projectId));
  }
  if (projectId) demands = demands.filter(d => d.projectId === projectId);
  if (flowId) demands = demands.filter(d => d.flowId === flowId);

  const completed = demands.filter(d => d.completedAt && (!startDate || d.completedAt.slice(0,10) >= startDate));

  // Tempo médio total: criação até conclusão (em horas)
  const totalHours = completed.map(d => (new Date(d.completedAt) - new Date(d.createdAt)) / 3600000);
  const avgTotal = totalHours.length ? totalHours.reduce((a,b)=>a+b,0) / totalHours.length : 0;

  // Taxa de pontualidade: % concluídas dentro do deadline
  const withDeadline = completed.filter(d => d.deadline);
  const onTime = withDeadline.filter(d => d.completedAt.slice(0,10) <= d.deadline);
  const punctualityRate = withDeadline.length ? (onTime.length / withDeadline.length) * 100 : 0;

  // Taxa de retrabalho: demandas onde stageHistory teve etapa visitada mais de 1x (voltou)
  const reworked = demands.filter(d => {
    const sh = d.stageHistory || [];
    const counts = {};
    sh.forEach(s => { counts[s.stageId] = (counts[s.stageId] || 0) + 1; });
    return Object.values(counts).some(n => n > 1);
  });
  const reworkRate = demands.length ? (reworked.length / demands.length) * 100 : 0;

  // Tempo médio por etapa — UNIFICA etapas com mesmo NOME normalizado, mesmo
  // que sejam ids diferentes em fluxos/clientes distintos. Ex.: "Aprovação" no
  // fluxo A e no fluxo B viram uma barra só.
  const _normStageKey = (label) => String(label || '').trim().toLowerCase();
  const stageTimings = {}; // { normKey: { stageName, flowNames:Set, samples:[hours], stageColor } }
  demands.forEach(d => {
    const flow = db.flows.find(f => f.id === d.flowId);
    const sh = d.stageHistory || [];
    sh.forEach((s, i) => {
      if (!s.enteredAt) return;
      const endTs = s.leftAt || (i === sh.length - 1 && d.completedAt) || null;
      if (!endTs) return;
      const hours = (new Date(endTs) - new Date(s.enteredAt)) / 3600000;
      if (hours < 0) return;
      const stage = flow?.stages.find(x => x.id === s.stageId);
      const label = stage?.label || '(etapa removida)';
      const key = _normStageKey(label);
      if (!stageTimings[key]) {
        stageTimings[key] = {
          stageName: label,
          stageColor: stage?.color || '#7A00FF',
          flowNames: new Set(),
          samples: []
        };
      }
      if (flow?.name) stageTimings[key].flowNames.add(flow.name);
      stageTimings[key].samples.push(hours);
    });
  });
  const stageStats = Object.values(stageTimings).map(s => ({
    stageName: s.stageName,
    stageColor: s.stageColor,
    flowName: _summarizeFlowNames(s.flowNames),
    avgHours: s.samples.reduce((a,b)=>a+b,0) / s.samples.length,
    samples: s.samples.length
  })).sort((a,b) => b.avgHours - a.avgHours);

  // Tempo médio por tipo de demanda
  const typeTimings = {};
  completed.forEach(d => {
    const flow = db.flows.find(f => f.id === d.flowId);
    const type = flow?.demandType || 'Sem tipo';
    if (!typeTimings[type]) typeTimings[type] = { type, samples: [], count: 0 };
    typeTimings[type].samples.push((new Date(d.completedAt) - new Date(d.createdAt)) / 3600000);
    typeTimings[type].count++;
  });
  const typeStats = Object.values(typeTimings).map(t => ({
    type: t.type,
    count: t.count,
    avgHours: t.samples.reduce((a,b)=>a+b,0) / t.samples.length
  })).sort((a,b) => b.count - a.count);

  // Top demandas mais demoradas
  const slowest = completed
    .map(d => {
      const project = db.projects.find(p => p.id === d.projectId);
      return {
        id: d.id, name: d.name,
        projectName: project?.name || '—',
        hours: (new Date(d.completedAt) - new Date(d.createdAt)) / 3600000,
        completedAt: d.completedAt
      };
    })
    .sort((a,b) => b.hours - a.hours)
    .slice(0, 10);

  // ── Esforço apontado (timeEntries) — horas que os usuários LANÇARAM, distinto
  //    do tempo de calendário (entrada → saída da etapa). Respeita o período pela
  //    data do apontamento (createdAt). ──
  let effortTotal = 0, demandsWithLog = 0;
  // Também unifica por NOME normalizado — mesma etapa em fluxos diferentes vira
  // uma barra só.
  const effByStage = {}; // normKey -> { stageName, hours, demands:Set, flowNames:Set }
  const effByUser  = {}; // userId  -> { hours, entries }
  demands.forEach(d => {
    const entries = (d.timeEntries || []).filter(e =>
      Number(e.hours) > 0 && (!startDate || String(e.createdAt || '').slice(0,10) >= startDate));
    if (!entries.length) return;
    demandsWithLog++;
    const flow = db.flows.find(f => f.id === d.flowId);
    entries.forEach(e => {
      const h = Number(e.hours) || 0;
      effortTotal += h;
      const sid = e.stageId || '__none__';
      const stage = flow?.stages.find(x => x.id === sid);
      const label = stage?.label || (sid === '__none__' ? '(sem etapa)' : '(etapa removida)');
      const key = _normStageKey(label);
      if (!effByStage[key]) {
        effByStage[key] = {
          stageName: label,
          stageColor: stage?.color || '#7A00FF',
          flowNames: new Set(),
          hours: 0, demands: new Set()
        };
      }
      if (flow?.name) effByStage[key].flowNames.add(flow.name);
      effByStage[key].hours += h;
      effByStage[key].demands.add(d.id);
      if (!effByUser[e.userId]) effByUser[e.userId] = { userId: e.userId, hours: 0, entries: 0 };
      effByUser[e.userId].hours += h;
      effByUser[e.userId].entries++;
    });
  });
  const effortByStage = Object.values(effByStage).map(s => ({
    stageName: s.stageName, stageColor: s.stageColor,
    flowName: _summarizeFlowNames(s.flowNames),
    hours: s.hours, avgHours: s.hours / s.demands.size, demands: s.demands.size
  })).sort((a, b) => b.avgHours - a.avgHours);
  const effortByUser = Object.values(effByUser).map(u => {
    const user = db.users.find(x => x.id === u.userId);
    return { userId: u.userId, name: user?.name || '—', hours: u.hours, entries: u.entries };
  }).sort((a, b) => b.hours - a.hours);

  res.json({
    period,
    totals: {
      demandsTotal: demands.length,
      completedCount: completed.length,
      avgTotalHours: avgTotal,
      punctualityRate,
      reworkRate,
      reworkedCount: reworked.length,
    },
    stageStats,
    typeStats,
    slowest,
    effort: {
      totalHours: effortTotal,
      demandsWithLog,
      avgPerDemand: demandsWithLog ? effortTotal / demandsWithLog : 0,
      byStage: effortByStage,
      byUser: effortByUser
    }
  });
});

/* ── NOTIFICAÇÕES (por usuário) ── */
// Persistência direto no Postgres (tabela dedicada, INDEX(user_id, created_at)).
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    res.json(await store.listNotificationsFor(req.user.id, 100));
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar notificações' }); }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  // UPDATE com WHERE id=... AND user_id=... — se não bater, 404. Evita
  // vazar existência de IDs de outros usuários e evita buscar até 500 registros.
  try {
    const n = await store.markNotificationReadIfOwner(req.params.id, req.user.id);
    if (!n) return res.status(404).json({ error: 'Notificação não encontrada' });
    res.json(n);
  } catch (e) { res.status(500).json({ error: 'Erro ao marcar notificação' }); }
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await store.markAllNotificationsReadFor(req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erro ao marcar notificações' }); }
});

/* Apaga TODAS as notificações do usuário. Sem undo — quem clica em "Limpar
   notificações" tá dizendo que já leu/resolveu tudo e não quer mais o barulho. */
app.delete('/api/notifications', requireAuth, async (req, res) => {
  try {
    await store.deleteAllNotificationsFor(req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erro ao limpar notificações' }); }
});

/* ── AGENDADOR DE RECORRÊNCIA ──
   A cada hora, verifica demandas com recurrence.enabled que devem gerar nova instância hoje.
   A demanda "modelo" (parent) mantém sua configuração; cada instância gerada é uma demanda comum
   ligada via parentDemandId para rastreabilidade. */
function isRecurrenceDueToday(rec, ymd) {
  if (!rec || !rec.enabled || rec.paused) return false;
  const anchor = rec.startDate || ymd;
  if (ymd < anchor) return false;
  if (rec.endDate && ymd > rec.endDate) return false;
  if (rec.lastGeneratedDate === ymd) return false;
  const interval = Math.max(1, rec.interval || 1);
  const cur = new Date(ymd + 'T12:00:00');
  const start = new Date(anchor + 'T12:00:00');
  if (rec.pattern === 'daily') {
    const days = Math.round((cur - start) / 86400000);
    return days >= 0 && days % interval === 0;
  }
  if (rec.pattern === 'weekly') {
    const weekDays = (Array.isArray(rec.weekDays) && rec.weekDays.length) ? rec.weekDays : [rec.weekDay ?? 1];
    if (!weekDays.includes(cur.getDay())) return false;
    // Semanas decorridas desde a âncora, normalizando ambas ao domingo da semana.
    const sow = dt => { const x = new Date(dt); x.setDate(x.getDate() - x.getDay()); x.setHours(12, 0, 0, 0); return x; };
    const weeks = Math.round((sow(cur) - sow(start)) / (7 * 86400000));
    return weeks >= 0 && weeks % interval === 0;
  }
  if (rec.pattern === 'monthly') {
    if (cur.getDate() !== rec.monthDay) return false;
    const months = (cur.getFullYear() - start.getFullYear()) * 12 + (cur.getMonth() - start.getMonth());
    return months >= 0 && months % interval === 0;
  }
  return false;
}
function runRecurrenceJob() {
  const ymd = today();
  let count = 0;
  db.demands.slice().forEach(parent => {
    if (!parent.recurrence || !parent.recurrence.enabled) return;
    if (!notDeleted(parent)) return; // parent na lixeira não gera
    if (!isRecurrenceDueToday(parent.recurrence, ymd)) return;
    const project = db.projects.find(p => p.id === parent.projectId);
    if (!project || project.active === false || !notDeleted(project)) return;
    const flow = db.flows.find(f => f.id === parent.flowId);
    if (!flow || !notDeleted(flow) || !flow.stages || !flow.stages.length) return;
    // Etapa inicial respeita as puladas do modelo (mesma lógica da criação normal).
    const skipped = new Set(Array.isArray(parent.skippedStages) ? parent.skippedStages : []);
    const stage = flow.stages.find(s => !skipped.has(s.id)) || flow.stages[0];
    // Recorrente herda overrides do parent (deadlineDate/deadlineDays), então
    // resolve o due usando os mesmos overrides que serão copiados pra `copy`.
    const stageDue = resolveStageDueDate(stage, parent, ymd);
    const copy = {
      id: uid(),
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      flowId: parent.flowId,
      parentDemandId: parent.id,
      name: parent.name,
      description: parent.description || '',
      briefing: parent.briefing || '',
      deadline: stageDue,
      estimatedHours: parent.estimatedHours,
      priority: parent.priority || 3,
      // Entregáveis — clona as contagens e o atribuído (cópia fiel do modelo).
      qtyPieces: parent.qtyPieces || 0,
      qtyArts: parent.qtyArts || 0,
      qtyVariations: parent.qtyVariations || 0,
      deliverableUserId: parent.deliverableUserId || null,
      status: stage.id,
      ownerId: parent.ownerId || (parent.stageResponsibles && parent.stageResponsibles[stage.id]) || resolveStageOwner(stage, project) || null,
      stageEnteredAt: nowISO(), stageDueDate: stageDue,
      stageHistory: [{ stageId: stage.id, enteredAt: nowISO(), dueDate: stageDue }],
      timeEntries: [], comments: [], history: [],
      // Checklist herdado do modelo, com estado "feito" zerado.
      checklist: Array.isArray(parent.checklist)
        ? parent.checklist.map(it => ({ id: uid(), text: it.text, ownerId: it.ownerId || null, done: false, doneBy: null, doneAt: null, createdBy: parent.recurrence.createdBy || null, createdAt: nowISO() }))
        : [],
      attachments: (parent.attachments || []).map(a => ({ ...a, id: uid() })),
      // Customizações de etapa por instância — clonadas pra manter a demanda idêntica.
      ...(Array.isArray(parent.skippedStages) && parent.skippedStages.length ? { skippedStages: [...parent.skippedStages] } : {}),
      ...(parent.stageResponsibles ? { stageResponsibles: { ...parent.stageResponsibles } } : {}),
      ...(parent.stageLabels ? { stageLabels: { ...parent.stageLabels } } : {}),
      ...(parent.stageOverrides ? { stageOverrides: JSON.parse(JSON.stringify(parent.stageOverrides)) } : {}),
      ...(Array.isArray(parent.stageAdditions) && parent.stageAdditions.length ? { stageAdditions: parent.stageAdditions.map(a => ({ ...a })) } : {}),
      ...(Array.isArray(parent.stageOrder) && parent.stageOrder.length ? { stageOrder: [...parent.stageOrder] } : {}),
      recurrence: null,
      createdAt: nowISO(),
      completedAt: stage.done ? nowISO() : null
    };
    addHistory(copy, parent.recurrence.createdBy || 'system', 'created_from_recurrence', { parentId: parent.id, demandName: copy.name });
    if (copy.ownerId) {
      notify(copy.ownerId, 'assigned', { demandId: copy.id, demandName: copy.name, stageName: stage.label }, null);
    }
    db.demands.push(copy);
    saveEntity('demands', copy);
    parent.recurrence.lastGeneratedDate = ymd;
    saveEntity('demands', parent);
    count++;
  });
  if (count > 0) {
    console.log(`  [recorrência] ${count} demanda(s) gerada(s) automaticamente`);
  }
}
// Roda imediatamente ao subir + a cada hora. .unref() libera o event loop
// (process não fica preso por causa do interval — útil pra testes/scripts).
const _recBoot = setTimeout(runRecurrenceJob, 5000);
const _recInterval = setInterval(runRecurrenceJob, 60 * 60 * 1000);
if (_recBoot.unref) _recBoot.unref();
if (_recInterval.unref) _recInterval.unref();

/* ── GC DE UPLOADS ÓRFÃOS ──
   Varre data/uploads/ e apaga arquivos que nenhuma entidade referencia mais
   (avatar de user/cliente/projeto, icon de fluxo, attachment de demanda,
   attachment de comentário, template attachment, lista attachment).
   Só apaga arquivos com mtime > MIN_AGE_MS pra evitar apagar upload recém-
   criado que ainda não foi associado a nenhuma entidade (janela de segurança). */
function collectReferencedUploads() {
  const refs = new Set();
  const addIfLocal = (v) => {
    if (typeof v === 'string' && v.startsWith('/uploads/')) refs.add(v);
  };
  for (const u of (db.users || []))    addIfLocal(u.avatar);
  for (const c of (db.clients || []))  addIfLocal(c.avatar);
  for (const p of (db.projects || [])) addIfLocal(p.avatar);
  for (const f of (db.flows || []))    addIfLocal(f.icon);
  for (const d of (db.demands || [])) {
    for (const a of (d.attachments || [])) addIfLocal(a.url);
    for (const c of (d.comments || [])) {
      for (const a of (c.attachments || [])) addIfLocal(a.url);
    }
  }
  for (const t of (db.templates || [])) {
    for (const a of (t.attachments || [])) addIfLocal(a.url);
  }
  for (const r of (db.recurrings || [])) {
    for (const a of (r.attachments || [])) addIfLocal(a.url);
  }
  return refs;
}
function runUploadsGc() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h — evita apagar upload recém-criado
  const now = Date.now();
  const refs = collectReferencedUploads();
  let deleted = 0, bytesFreed = 0;
  let files;
  try { files = fs.readdirSync(UPLOADS_DIR); } catch { return; }
  for (const name of files) {
    if (name.startsWith('.')) continue;
    const url = '/uploads/' + name;
    if (refs.has(url)) continue;
    const full = path.join(UPLOADS_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs < MIN_AGE_MS) continue; // recente — deixa quieto
    try { fs.unlinkSync(full); deleted++; bytesFreed += stat.size; } catch (e) {
      console.warn(`[uploads-gc] falha ao apagar ${name}: ${e.message}`);
    }
  }
  if (deleted > 0) {
    console.log(`  [uploads-gc] ${deleted} arquivo(s) órfão(s) apagado(s) (${Math.round(bytesFreed / 1024)}KB liberados)`);
  }
}
// Roda 30 min após o boot e a cada 7 dias.
const _gcBoot = setTimeout(runUploadsGc, 30 * 60 * 1000);
const _gcInterval = setInterval(runUploadsGc, 7 * 24 * 60 * 60 * 1000);
if (_gcBoot.unref) _gcBoot.unref();
if (_gcInterval.unref) _gcInterval.unref();

// Purge de soft-deletes vencidos — roda 5 min após boot e depois a cada hora.
const _sdBoot = setTimeout(runSoftDeletePurge, 5 * 60 * 1000);
const _sdInterval = setInterval(runSoftDeletePurge, 60 * 60 * 1000);
if (_sdBoot.unref) _sdBoot.unref();
if (_sdInterval.unref) _sdInterval.unref();

/* ── DIGEST DIÁRIO DE E-MAIL ──
   Seg-sex, ~8h local. Pra cada usuário com email + opt-in daily_digest:
   - Demandas atrasadas
   - Vencendo hoje
   - Vencendo nos próximos 3 dias
   - Notificações não lidas
   Marca user._lastDigestSent = 'YYYY-MM-DD' pra não duplicar quando o interval
   dispara múltiplas vezes na mesma manhã. */
function digestBuildForUser(user) {
  const todayYmd = today();
  const in3days = addDays(todayYmd, 3);
  const myDemands = db.demands.filter(d =>
    notDeleted(d) && d.ownerId === user.id && !d.completedAt && canAccessWs(user, d.workspaceId)
  );
  const overdue = myDemands.filter(d => d.deadline && d.deadline < todayYmd);
  const dueToday = myDemands.filter(d => d.deadline === todayYmd);
  const dueSoon = myDemands.filter(d => d.deadline && d.deadline > todayYmd && d.deadline <= in3days);
  return { overdue, dueToday, dueSoon };
}
async function digestSendForUser(user, baseUrl) {
  const { overdue, dueToday, dueSoon } = digestBuildForUser(user);
  // Notificações não lidas (via store — não vive em db em memória)
  let unreadNotifs = [];
  try {
    const list = await store.listNotificationsFor(user.id, 50);
    unreadNotifs = list.filter(n => !n.read);
  } catch {}
  // Se não há NADA relevante, não envia — evita spam diário vazio.
  if (!overdue.length && !dueToday.length && !dueSoon.length && !unreadNotifs.length) return false;
  const url = baseUrl || process.env.PUBLIC_URL || '';
  const renderList = (items, empty) => items.length
    ? `<ul style="margin:8px 0 0;padding-left:18px;color:#333;font-size:14px;line-height:1.7">${items.slice(0, 12).map(d => {
        const client = (db.projects.find(p => p.id === d.projectId) || {}).client || '';
        const link = url ? `<a href="${url}/demands/${d.id}" style="color:#7A00FF;text-decoration:none">${escHtml(d.name)}</a>` : escHtml(d.name);
        const meta = [client, d.deadline].filter(Boolean).map(escHtml).join(' · ');
        return `<li>${link}${meta ? ` <span style="color:#888;font-size:12px">(${meta})</span>` : ''}</li>`;
      }).join('')}${items.length > 12 ? `<li style="color:#888;font-size:12px">…e mais ${items.length - 12}</li>` : ''}</ul>`
    : `<div style="color:#888;font-size:13px;margin-top:6px">${empty}</div>`;
  const notifBlock = unreadNotifs.length
    ? `<h3 style="margin:24px 0 6px;font-size:15px;color:#222">🔔 Notificações não lidas (${unreadNotifs.length})</h3>${renderList(unreadNotifs.map(n => ({ id: n.demandId || '', name: n.demandName || n.type })), '')}`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;padding:28px 32px">
      <div style="font-size:13px;font-weight:700;color:#7A00FF;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px">reWork · Resumo do dia</div>
      <h2 style="margin:0 0 18px;font-size:22px;color:#222">Bom dia, ${escHtml(user.name.split(' ')[0])} 👋</h2>
      <p style="margin:0 0 4px;color:#555;font-size:14px">Aqui está o que precisa da sua atenção hoje:</p>

      <h3 style="margin:24px 0 6px;font-size:15px;color:#EF4444">🔥 Em atraso (${overdue.length})</h3>
      ${renderList(overdue, 'Nada em atraso. Boa!')}

      <h3 style="margin:24px 0 6px;font-size:15px;color:#F59E0B">📅 Vencem hoje (${dueToday.length})</h3>
      ${renderList(dueToday, 'Nenhuma demanda com prazo pra hoje.')}

      <h3 style="margin:24px 0 6px;font-size:15px;color:#38BDF8">⏭️ Próximos 3 dias (${dueSoon.length})</h3>
      ${renderList(dueSoon, 'Sem demandas nos próximos 3 dias.')}

      ${notifBlock}

      <p style="margin:26px 0 0;color:#999;font-size:11px">Você recebe este resumo em dias úteis às 8h. Pra desativar, vá em <em>Meu Perfil → Notificações por e-mail</em>.</p>
    </div></body></html>`;
  const text = `Bom dia, ${user.name.split(' ')[0]}!\n\nEm atraso: ${overdue.length}\nVencem hoje: ${dueToday.length}\nPróximos 3 dias: ${dueSoon.length}\nNotificações não lidas: ${unreadNotifs.length}\n\nAbra: ${url}`;
  try {
    await sendEmail(user.email, `[reWork] Resumo do dia — ${overdue.length + dueToday.length} pra hoje`, html, text);
    return true;
  } catch (e) {
    console.error(`[digest] falha ao enviar pra ${user.email}: ${e.message}`);
    return false;
  }
}
async function runDailyDigest() {
  if (!mailEnabled()) return;
  const now = new Date();
  const dow = now.getDay(); // 0 dom .. 6 sáb
  if (dow === 0 || dow === 6) return; // só seg-sex
  const hour = now.getHours();
  if (hour < 8 || hour > 9) return; // janela de 8h-9h (tolera atraso do interval)
  const ymd = now.toISOString().slice(0, 10);
  let sent = 0, skipped = 0;
  for (const u of db.users) {
    if (!u.active || u.active === false) continue;
    if (!u.email) continue;
    const prefs = u.emailPrefs || defaultEmailPrefs();
    if (prefs.daily_digest === false) continue;
    if (u._lastDigestSent === ymd) { skipped++; continue; }
    const didSend = await digestSendForUser(u, process.env.PUBLIC_URL);
    if (didSend) sent++;
    // Marca sempre (mesmo se digestSendForUser retornou false por falta de conteúdo)
    // pra não reprocessar o mesmo user várias vezes na janela de 1h.
    u._lastDigestSent = ymd;
    saveEntity('users', u);
  }
  if (sent > 0) console.log(`  [digest] ${sent} resumo(s) enviado(s) · ${skipped} pulado(s)`);
}
// Roda a cada 15 min. runDailyDigest checa hora/dia/estado interno.
const _digestInterval = setInterval(runDailyDigest, 15 * 60 * 1000);
if (_digestInterval.unref) _digestInterval.unref();
// Uma checagem 2 min após boot pra pegar caso o servidor tenha subido às 8h.
const _digestBoot = setTimeout(runDailyDigest, 2 * 60 * 1000);
if (_digestBoot.unref) _digestBoot.unref();

/* ── REAL-TIME via Server-Sent Events ─────────────────────────────
   Cada cliente conectado mantém uma resposta HTTP aberta com
   `text/event-stream`. Mutations no app chamam broadcastChange(),
   que filtra por workspace acessível e ecoa um JSON pro frontend
   refetchar a entidade afetada. SSE > WebSocket aqui porque:
   - Unidirecional (servidor → cliente) é tudo que precisamos
   - HTTP/1.1 normal, atravessa proxies (Nginx Proxy Manager) sem upgrade
   - Reconnect automático no EventSource do browser */
const sseClients = new Map(); // userId → Set<res>
// Máximo de conexões SSE simultâneas por usuário. Múltiplas abas normais ficam
// abaixo disso; excesso vira sinal de abuso ou de EventSource que reconecta em
// loop sem fechar a antiga (bug de cliente). Fechar a mais antiga é seguro:
// o browser vai reabrir automaticamente e ler o estado atual via loadAll.
const SSE_MAX_PER_USER = 6;

app.get('/api/stream', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // desativa buffer do Nginx
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  const userId = req.user.id;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  const set = sseClients.get(userId);
  // Cap: se já está no limite, fecha a conexão mais antiga (a que entrou primeiro no Set).
  while (set.size >= SSE_MAX_PER_USER) {
    const oldest = set.values().next().value;
    if (!oldest) break;
    try { oldest.end(); } catch {}
    set.delete(oldest);
  }
  set.add(res);

  // Heartbeat a cada 25s pra evitar timeouts de proxy (Nginx default = 60s)
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(userId);
    }
  });
});

/* Envia evento pra todos os clientes que têm acesso ao workspace,
   exceto o usuário que originou a mudança (evita render duplicado).
   entity: 'demand'|'schedule'|'client'|'project'|'flow'|'comment'|'user'|'workspace'
   op:     'create'|'update'|'delete'
   ctx:    { id?, workspaceId?, byUserId } */
function broadcastChange(entity, op, ctx = {}) {
  if (sseClients.size === 0) return;
  const { id, workspaceId, byUserId } = ctx;
  const payload = JSON.stringify({ entity, op, id, workspaceId, ts: Date.now() });
  const line = `data: ${payload}\n\n`;
  for (const [userId, conns] of sseClients) {
    if (byUserId && userId === byUserId) continue;
    const user = db.users.find(u => u.id === userId);
    if (!user) continue;
    if (workspaceId && !canAccessWs(user, workspaceId)) continue;
    for (const res of conns) {
      try { res.write(line); } catch {}
    }
  }
}

/* ── FALLBACK ── */
// /api/* desconhecidos: devolve 404 JSON em vez de cair no SPA (que retornaria
// HTML com status 200 e quebraria clientes que esperam JSON).
app.all(/^\/api\/.*/, (req, res) => {
  res.status(404).json({ error: `Endpoint não encontrado: ${req.method} ${req.originalUrl}` });
});
// Demais rotas: serve o SPA pra deixar o roteamento client-side resolver
// (/dashboard, /demands/<id>, etc).
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Boot: aguarda loadDB (async por causa do Postgres) antes de aceitar tráfego.
// Exporta o app pra testes; auto-listen só quando executado direto.
const _boot = loadDB().catch(err => {
  console.error('[boot] falha ao carregar banco:', err.message);
  process.exit(1);
});

if (require.main === module) {
  _boot.then(() => {
    const server = app.listen(PORT, () => console.log(`\n  fluxo. rodando em  →  http://localhost:${PORT}\n`));
    setupGracefulShutdown(server);
  });
}

/* ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────
   Docker Swarm envia SIGTERM antes de matar o container. Precisamos:
   1. Parar de aceitar novas conexões HTTP
   2. Encerrar SSE streams abertos (senão o server.close() nunca resolve)
   3. Flush do buffer de writes pendentes + fechar pool do Postgres
   4. Sair com código 0

   Timeout de 15s como paraquedas — se algo travar, o kernel força kill
   via SIGKILL do Swarm (default 10s após SIGTERM). */
function setupGracefulShutdown(server) {
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} recebido — encerrando graciosamente…`);

    const hardKill = setTimeout(() => {
      console.error('[shutdown] timeout — força kill');
      process.exit(1);
    }, 15000);
    hardKill.unref();

    // 1) Encerra SSE clients — sem isso server.close() aguarda pra sempre
    //    (conexões keep-alive de SSE não terminam sozinhas).
    try {
      let closed = 0;
      for (const [, conns] of sseClients) {
        for (const res of conns) {
          try { res.end(); closed++; } catch {}
        }
      }
      sseClients.clear();
      if (closed) console.log(`[shutdown] ${closed} SSE clients encerrados`);
    } catch (e) { console.error('[shutdown] SSE:', e.message); }

    // 2) Para de aceitar novas conexões + espera as em voo terminarem
    await new Promise((resolve) => {
      server.close(() => {
        console.log('[shutdown] HTTP fechado');
        resolve();
      });
    });

    // 3) Flush do buffer de writes + fecha pool do Postgres
    try {
      await flushDirty(); // grava writes pendentes do buffer 30ms
      if (store && typeof store.close === 'function') {
        await store.close();
        console.log('[shutdown] Postgres pool fechado');
      }
    } catch (e) { console.error('[shutdown] Postgres:', e.message); }

    clearTimeout(hardKill);
    console.log('[shutdown] concluído');
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  // Rede de segurança: uma Promise rejeitada sem catch NÃO deve derrubar o server
  // (Node crasha por padrão). Loga e segue — uma promise solta não corrompe o estado.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  // Erro SÍNCRONO não capturado deixa o processo em estado indefinido: faz flush do
  // buffer de writes e sai com código 1 (o restart policy sobe um processo limpo).
  process.on('uncaughtException', async (err) => {
    console.error('[uncaughtException]', err);
    try { await flushDirty(); } catch {}
    process.exit(1);
  });
}
module.exports = app;
module.exports.ready = _boot;
