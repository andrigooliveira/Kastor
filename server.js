/* ───────────────────────────────────────────────────────────────
   reWork — Gestão de Demandas de Marketing  ·  Backend (v3)
   Node.js + Express + banco em arquivo (data/db.json)
   Credenciais ficam num arquivo criptografado separado (auth.enc).

   Novidades desta versão:
   • Workspaces (equipes) com acesso por usuário
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

const express     = require('express');
const compression = require('compression');
const crypto     = require('crypto');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const { spawn }  = require('child_process');
const nodemailer = require('nodemailer');
const auth       = require('./secure-store');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { createStore, ENTITY_TYPES } = require('./db-store');
const { createTenancy } = require('./tenancy');
const totp = require('./totp');
const googleCal  = require('./google-cal');
const discordBot = require('./discord-bot');
const discordOAuth = require('./discord-oauth');
const googleLogin = require('./google-login');
const emailTpl   = require('./email-templates');

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
/* `rawDb` é o cache em memória com TODAS as organizações. O código usa `db`,
   que dentro de uma requisição autenticada só enxerga a organização ativa
   (ver tenancy.js). Fora de requisição (boot, jobs) `db` vê tudo. */
let rawDb = null;
let consoleApi = null; // platform-console.js (montado mais abaixo)
const tenancy = createTenancy({ getRaw: () => rawDb, onMemberChange: (m) => saveEntity('memberships', m) });
const db = tenancy.db;
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
  for (const type of ['clients', 'projects', 'demands', 'flows', 'listas', 'clientTemplates', 'recurrings', 'tasks', 'formTemplates', 'formResponses', 'dashboards']) {
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
  rawDb = await store.loadAllToCache();
  for (const t of ENTITY_TYPES) if (!Array.isArray(db[t])) db[t] = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];
  // Senhas e sessões: Postgres (importa o data/auth.enc antigo na 1ª vez).
  await auth.init(store);
  const firstInstall = await isFirstInstall();
  migrate(firstInstall);
  seed(firstInstall);
  await markInstallComplete(); // idempotente — grava a flag no primeiro boot com esse código
  // Extrai anexos/avatares base64 que ainda estejam dentro das entidades
  // pra arquivos em data/uploads. Idempotente — não toca quem já está em URL.
  extractInlineBase64();
  backfillAttachmentSizes();
  await loadAdminDiscordDefaults(); // carrega defaults de DM do Discord (KV)
  await seedDemandTypes(); // popula a biblioteca de tipos a partir dos fluxos (1x)
  // Migração de folders legados do cofre — cria entidades a partir do campo
  // string `folder` que existia antes. Idempotente.
  try { _migrateLegacyPasswordFolders(); } catch (e) { console.warn('migrateLegacyPasswordFolders:', e.message); }
  migrateOrgs();
  clearDoneStageOwners();
  if (consoleApi) consoleApi.ensureDefaultAdmin();
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

// Termos de sugestão de fluxo aprendidos do histórico — ver learnFlowTerms().
const FLOW_LEARN_SOURCE_TYPES = new Set(['demands', 'flows', 'clients', 'projects']);
let _flowLearnCache = new Map(); // orgId → { terms, computedAt }

/* Marca uma entidade como "suja" pra ser persistida no próximo flush.
   Hot paths podem chamar saveEntity diretamente pra ganhar latência. */
function markDirty(type, entityOrId, op = 'upsert') {
  const id = (op === 'remove') ? entityOrId : (entityOrId && entityOrId.id);
  if (!id) return;
  _dirtyEntities.set(`${type}|${id}`, { type, op, entity: op === 'upsert' ? entityOrId : null, id });
  if (FLOW_LEARN_SOURCE_TYPES.has(type)) _flowLearnCache.clear();
}
function saveEntity(type, entity) {
  stampOrg(type, entity);
  markDirty(type, entity, 'upsert');
  // Permissões/squads do usuário moram no vínculo com a organização ativa.
  if (type === 'users' && entity && rawDb) { const m = tenancy.memberFor(entity); if (m) markDirty('memberships', m, 'upsert'); }
  scheduleFlush();
}
/* Item novo criado dentro de uma organização, sem squad: pertence a ela. */
function stampOrg(type, e) {
  const org = tenancy.currentOrgId();
  if (!org || !e || typeof e !== 'object' || tenancy.UNSCOPED.has(type) || type === 'users' || type === 'organizations') return;
  if (!e.orgId && !e.workspaceId) e.orgId = org;
}
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

/* ─── ORGANIZAÇÕES: migração da instalação de uma empresa só ───
   Idempotente. Na primeira vez: cria a organização (ORG_NAME, padrão "WSI"),
   põe nela todas as equipes e itens "da instalação", e cria o vínculo de cada
   pessoa com exatamente as permissões de hoje. O dono é ORG_OWNER (usuário
   ou e-mail) ou, sem ele, o admin ativo mais antigo — dá pra trocar depois
   no console. Em todo boot: liga os campos calculados dos usuários. */
function migrateOrgs() {
  const r = rawDb;
  for (const k of ['organizations', 'memberships']) if (!Array.isArray(r[k])) r[k] = [];
  let org = r.organizations.find(o => o.isDefault) || r.organizations[0];
  if (!org) {
    const firstWs = (r.workspaces || []).map(w => w.createdAt).filter(Boolean).sort()[0];
    org = {
      id: 'org_' + uid(), name: String(process.env.ORG_NAME || 'WSI').trim().slice(0, 80) || 'WSI',
      logo: null, ownerId: null, status: 'active', isDefault: true,
      createdAt: firstWs || nowISO(), createdBy: 'migration'
    };
    r.organizations.push(org);
    markDirty('organizations', org, 'upsert');
    console.log(`  [orgs] organização "${org.name}" criada com os dados atuais`);
  }
  let stamped = 0, created = 0;
  for (const w of (r.workspaces || [])) if (!w.orgId) { w.orgId = org.id; markDirty('workspaces', w, 'upsert'); stamped++; }
  for (const t of ENTITY_TYPES) {
    if (tenancy.UNSCOPED.has(t) || ['users', 'workspaces', 'memberships', 'organizations'].includes(t)) continue;
    for (const e of (r[t] || [])) {
      if (e && !e.orgId && !e.workspaceId) { e.orgId = org.id; markDirty(t, e, 'upsert'); stamped++; }
    }
  }
  for (const u of (r.users || [])) {
    if (tenancy.membershipsOf(u.id).length) continue;
    const role = u.isAdmin ? 'admin' : u.isModerator ? 'mod' : u.isFreelancer ? 'free' : 'equipe';
    const m = {
      id: uid(), orgId: org.id, userId: u.id, role,
      workspaces: Array.isArray(u.workspaces) ? u.workspaces.slice() : [],
      area: u.role || '', position: u.position || null, active: u.active !== false,
      createdAt: u.createdAt || nowISO(), invitedBy: null
    };
    r.memberships.push(m);
    markDirty('memberships', m, 'upsert');
    created++;
  }
  if (!org.ownerId) {
    const userOf = (m) => r.users.find(u => u.id === m.userId);
    const cands = r.memberships.filter(m => m.orgId === org.id && m.active !== false);
    const want = String(process.env.ORG_OWNER || '').trim().toLowerCase();
    let pick = want ? cands.find(m => { const u = userOf(m); return u && (String(u.username).toLowerCase() === want || String(u.email || '').toLowerCase() === want); }) : null;
    if (!pick) pick = cands.filter(m => m.role === 'admin').sort((a, b) => String(userOf(a)?.createdAt || '').localeCompare(String(userOf(b)?.createdAt || '')))[0];
    if (pick) {
      pick.role = 'owner';
      org.ownerId = pick.userId;
      markDirty('memberships', pick, 'upsert');
      markDirty('organizations', org, 'upsert');
      console.log(`  [orgs] dono de "${org.name}": ${userOf(pick)?.name || pick.userId}`);
    }
  }
  (r.users || []).forEach(u => tenancy.attachUser(u));
  if (created || stamped) console.log(`  [orgs] ${created} vínculo(s) criado(s), ${stamped} item(ns) ligados à organização`);
}

/* Etapa de conclusão não tem responsável: limpa o que ficou nos fluxos antigos. */
function clearDoneStageOwners() {
  let n = 0;
  for (const f of (rawDb.flows || [])) {
    let changed = false;
    for (const st of (f.stages || [])) {
      if (st.done && (st.responsibleId || st.responsibleRole || st.roleFilter || st.responsiblePosition)) {
        st.responsibleId = null; st.responsibleRole = null; st.roleFilter = null; st.responsiblePosition = null;
        changed = true;
      }
    }
    if (changed) { markDirty('flows', f, 'upsert'); n++; }
  }
  if (n) console.log(`  [fluxos] responsável removido da etapa de conclusão em ${n} fluxo(s)`);
}

/* Cria o vínculo de um usuário novo (cadastro manual ou convite) e liga os
   campos calculados. Lê as permissões dos campos antigos do objeto, se houver. */
function adoptUser(user, orgId, opts = {}) {
  const role = opts.role || (user.isAdmin ? 'admin' : user.isModerator ? 'mod' : user.isFreelancer ? 'free' : 'equipe');
  const m = {
    id: uid(), orgId, userId: user.id, role,
    workspaces: Array.isArray(opts.workspaces) ? opts.workspaces.slice() : (Array.isArray(user.workspaces) ? user.workspaces.slice() : []),
    area: opts.area !== undefined ? String(opts.area || '') : (user.role || ''),
    position: opts.position !== undefined ? (opts.position || null) : (user.position || null),
    active: true, createdAt: nowISO(), invitedBy: opts.invitedBy || null
  };
  rawDb.memberships.push(m);
  markDirty('memberships', m, 'upsert');
  tenancy.attachUser(user);
  return m;
}
const allUsers = () => (rawDb && rawDb.users) || [];

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
    if (u.passHash && u.salt) auth.importLegacyCredential(u.id, u.salt, u.passHash);
    delete u.passHash; delete u.salt;
    if (!Array.isArray(u.workspaces)) u.workspaces = db.workspaces.map(w => w.id);
  });
  // Tokens antigos que viviam no db.json
  if (Array.isArray(db.tokens)) {
    db.tokens.forEach(t => auth.importLegacyToken(t));
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
function publicUser(u, opts) {
  if (!u) return null;
  // Nunca expõe tokens do Google — refresh_token é credencial de longa duração.
  // Também remove knownIps e releaseNotesSeenIds (metadados internos, sem uso
  // no frontend). Devolve booleano + info da conta pra frontend saber que tá conectado.
  // quickReplies (respostas prontas) e navMenu (menu lateral personalizado) são
  // pessoais: só voltam pro próprio usuário.
  // reminders/demandSeen/timeGapDismissed: estado pessoal com rota própria.
  const { googleTokens, googleSyncTokens, knownIps, releaseNotesSeenIds, quickReplies, reminders, demandSeen, timeGapDismissed, mentionDismissed, heldNotifs, navMenu, emailChange, twoFactor, twoFactorSetup, onboardingPendingAt, googleLogin: gLogin, ...rest } = u;
  rest.googleConnected = !!googleTokens;
  rest.twoFactorMethod = twoFactorMethodOf(u);
  rest.emailVerified = !!(u.email && u.emailVerifiedAt);
  // Permissões e squads vêm do vínculo com a organização ativa.
  rest.isAdmin = !!u.isAdmin; rest.isModerator = !!u.isModerator; rest.isFreelancer = !!u.isFreelancer;
  rest.isOwner = !!u.isOwner; rest.orgRole = u.orgRole || null;
  rest.workspaces = Array.isArray(u.workspaces) ? u.workspaces.slice() : [];
  rest.role = u.role || ''; rest.position = u.position || null; rest.active = u.active !== false;
  if (opts && opts.self) {
    rest.quickReplies = Array.isArray(quickReplies) ? quickReplies : null;
    rest.navMenu = Array.isArray(navMenu) ? navMenu : null;
    // Vínculo de e-mail: prazo, troca aguardando o link e se já está bloqueando.
    const pending = emailChange && Date.parse(emailChange.expiresAt) > Date.now() ? emailChange : null;
    rest.pendingEmail = pending ? { email: pending.email, expiresAt: pending.expiresAt, sentAt: pending.sentAt } : null;
    rest.emailDeadline = EMAIL_DEADLINE;
    rest.emailRequired = emailEnforced() && !emailLinked(u);
    rest.hasPassword = auth.hasPassword(u.id);
    // Conta nova vinda de convite: mostra a tela de primeiros passos (foto,
    // telefone, Google Agenda, Discord) até a pessoa concluir ou pular.
    rest.onboardingPending = !!onboardingPendingAt;
    // Entrar com Google: só o e-mail da conta vinculada (o sub fica no servidor).
    rest.googleLogin = gLogin && gLogin.sub ? { email: gLogin.email || null, linkedAt: gLogin.linkedAt || null } : null;
    const tfMethod = twoFactorMethodOf(u);
    rest.twoFactor = tfMethod ? {
      method: tfMethod,
      app: tfMethod === 'totp',
      enabledAt: tfMethod === 'totp' ? twoFactor.enabledAt : (u.emailVerifiedAt || null),
      recoveryLeft: tfMethod === 'totp' ? (twoFactor.recovery || []).filter(c => !c.usedAt).length : 0
    } : null;
  }
  return rest;
}
/* ── IDENTIDADE ──
   Regras de conta compartilhadas por cadastro manual, convite e perfil. */
const PASSWORD_MIN = 8;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const USERNAME_RULE = 'O nome de usuário precisa ter de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.';
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
/* E-mail vinculado = cadastrado E confirmado pelo link. Até o prazo, quem não
   tem só vê o aviso no Início; depois do prazo, a conta continua entrando
   (usuário, e-mail ou Discord), mas a API só responde o necessário pra tela
   de confirmação — nada do app abre até vincular. Sem SMTP o prazo não é
   cobrado (ninguém conseguiria confirmar). */
const EMAIL_DEADLINE = new Date(process.env.EMAIL_REQUIRED_AFTER || '2026-09-30T23:59:59-03:00').toISOString();
const EMAIL_CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const emailLinked = (u) => !!(u && u.email && u.emailVerifiedAt);
const emailEnforced = () => mailEnabled() && Date.now() > Date.parse(EMAIL_DEADLINE);
const EMAIL_GATE_ALLOWED = [
  ['GET', /^\/api\/me$/],
  ['POST', /^\/api\/me\/email(\/cancel)?$/],
  ['POST', /^\/api\/logout$/]
];
function emailBlock(user, method, reqPath) {
  if (!emailEnforced() || emailLinked(user)) return false;
  return !EMAIL_GATE_ALLOWED.some(([m, re]) => m === method && re.test(reqPath));
}
/* Conta (ativa ou não) que já usa esse e-mail — o e-mail identifica a pessoa. */
function userByEmail(email, exceptId) {
  const e = normEmail(email);
  if (!e) return null;
  return allUsers().find(u => u.id !== exceptId && u.email && u.email.toLowerCase() === e) || null;
}
function usernameTaken(username, exceptId) {
  const n = String(username || '').trim().toLowerCase();
  return allUsers().some(u => u.id !== exceptId && String(u.username || '').toLowerCase() === n);
}
/* Sugestão de nome de usuário a partir do e-mail (ou do nome), sem acento
   e sem colidir com os existentes: ana.lima, ana.lima2… */
function suggestUsername(email, name) {
  const src = String(email || '').split('@')[0] || String(name || '');
  let base = src.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.').replace(/[._-]{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 28);
  if (base.length < 3) base = (base + 'usuario').slice(0, 28);
  let cand = base, i = 1;
  while (usernameTaken(cand)) cand = `${base}${++i}`;
  return cand;
}
/* Metadados da sessão (lista de sessões ativas / auditoria). */
function sessionMeta(req) {
  return { ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) };
}
/* Abre a sessão (cookie httpOnly) e devolve o token. */
function startSession(req, res, user) {
  const token = auth.addToken(user.id, sessionMeta(req));
  res.set('Set-Cookie', buildSessionCookie(token, { secure: isHttpsRequest(req) }));
  return token;
}
/* Registra o IP no histórico do usuário (auditoria). Guarda os últimos 20. */
function recordLoginIp(user, ip) {
  if (!Array.isArray(user.knownIps)) user.knownIps = [];
  if (user.knownIps.includes(ip)) return;
  user.knownIps.push(ip);
  if (user.knownIps.length > 20) user.knownIps = user.knownIps.slice(-20);
  saveEntity('users', user);
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
/* Link da demanda no app: /<id-da-org>/demands/<id>. Sem organização
   conhecida, cai no /demands/<id> (o app completa com a organização atual). */
function demandLinkFor(baseUrl, demandId) {
  if (!baseUrl || !demandId) return null;
  const d = (rawDb.demands || []).find(x => x.id === demandId);
  const orgId = d ? tenancy.wsOrgId(d.workspaceId) : null;
  return `${baseUrl}${orgId ? '/' + orgId : ''}/demands/${demandId}`;
}

/* Deriva uma versão curta e estável a partir do path do avatar. Usado como
   `?v=` na URL pública — muda quando o cliente troca o avatar (o arquivo é
   novo), invalidando o cache do Discord/browser. Dígitos no filename já são
   únicos por upload; se não houver, cai pra hash simples do path. */
function _avatarVersion(avatarPath) {
  if (!avatarPath) return '0';
  const digits = String(avatarPath).replace(/\D/g, '');
  if (digits) return digits.slice(-10);
  let h = 0;
  for (const c of avatarPath) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return String(Math.abs(h));
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
  daily_digest:   'Resumo diário das minhas demandas',
  reminder:       'Lembretes que eu agendei',
};
function defaultEmailPrefs() {
  return { assigned: true, stage_assigned: true, mention: true, watch_stage: true, watch_comment: true, daily_digest: true, reminder: true };
}

/* ── DISCORD DM PREFS ──
   Mesmo modelo do e-mail: por evento, ligado/desligado. Mas com duas camadas:
     1) HARDCODED default (fallback final se KV vazio) — @mention on, resto off
     2) ADMIN default (KV `discordAdminDefaults`) — admin do time altera pra
        aplicar a todos que ainda não personalizaram
     3) USER override (u.discordPrefs) — vence tudo, chave por chave (parcial)
   effectiveDiscordPref(user, event) resolve na ordem 3 → 2 → 1. */
const DISCORD_EVENT_LABELS = {
  assigned:       'Atribuído como responsável',
  stage_assigned: 'Responsável por etapa (auto-atribuição)',
  mention:        'Mencionado em comentário',
  watch_stage:    'Movimento de etapa em demanda que observo',
  watch_comment:  'Novo comentário em demanda que observo',
  daily_digest:   'Resumo diário das minhas demandas',
  reminder:       'Lembretes que eu agendei',
};
// Nota: daily_digest é AGENDADO, não é chamado via notify(). Fica no map só
// pra aparecer na UI de prefs e ser consultado por effectiveDiscordPref no
// runDailyBotDMDigest. notify() nunca é invocado com type='daily_digest'.
const DISCORD_HARDCODED_DEFAULTS = {
  assigned: false, stage_assigned: false, mention: true, watch_stage: false, watch_comment: false, daily_digest: true,
  reminder: true, // a pessoa agendou pra ser lembrada — faz sentido chegar onde ela está
};
let _adminDiscordDefaultsCache = null;
async function loadAdminDiscordDefaults() {
  const raw = await store.getKv('discordAdminDefaults');
  if (!raw) { _adminDiscordDefaultsCache = { ...DISCORD_HARDCODED_DEFAULTS }; return; }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    _adminDiscordDefaultsCache = { ...DISCORD_HARDCODED_DEFAULTS, ...parsed };
  } catch { _adminDiscordDefaultsCache = { ...DISCORD_HARDCODED_DEFAULTS }; }
}
/* Padrões por organização (org.discordDefaults). A organização original usa
   o valor antigo (kv global) enquanto não salvar um próprio. */
function getAdminDiscordDefaults() {
  const org = tenancy.orgById(tenancy.currentOrgId()) || (rawDb && (rawDb.organizations || []).find(o => o.isDefault));
  if (org && org.discordDefaults) return { ...DISCORD_HARDCODED_DEFAULTS, ...org.discordDefaults };
  if (!org || org.isDefault) return _adminDiscordDefaultsCache || { ...DISCORD_HARDCODED_DEFAULTS };
  return { ...DISCORD_HARDCODED_DEFAULTS };
}
async function saveAdminDiscordDefaults(next) {
  const clean = {};
  for (const k of Object.keys(DISCORD_EVENT_LABELS)) {
    if (typeof next[k] === 'boolean') clean[k] = next[k];
  }
  const org = tenancy.orgById(tenancy.currentOrgId());
  if (org) { org.discordDefaults = clean; saveEntity('organizations', org); return; }
  _adminDiscordDefaultsCache = { ...DISCORD_HARDCODED_DEFAULTS, ...clean };
  await store.setKv('discordAdminDefaults', JSON.stringify(_adminDiscordDefaultsCache));
}
/* Bot do Discord e webhook do n8n são da instalação: por enquanto só a
   organização original (WSI) usa. */
function installationOrgOnly(req, res, next) {
  if (req.org && req.org.isDefault) return next();
  return res.status(403).json({ error: 'Esta integração ainda não está disponível para a sua organização.' });
}
function effectiveDiscordPref(user, event) {
  if (!DISCORD_EVENT_LABELS[event]) return false;
  const userPrefs = (user && user.discordPrefs) || {};
  if (typeof userPrefs[event] === 'boolean') return userPrefs[event];
  const admin = getAdminDiscordDefaults();
  return admin[event] !== false; // fallback = admin default (que já herda do hardcoded)
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
  // Desenvolvimento: SMTP_HOST=log não manda nada, só escreve o e-mail no log
  // (pra testar confirmação e códigos de acesso sem servidor de e-mail).
  if (SMTP_HOST === 'log' && process.env.NODE_ENV !== 'production') {
    _mailTransport = { sendMail: async (m) => { console.log(`
[email:log] para ${m.to} · ${m.subject}
${m.text}
`); } };
    return _mailTransport;
  }
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
const escHtml = emailTpl.escHtml;
// Visual dos e-mails: email-templates.js (pré-visualização em /api/admin/email-preview).
function buildEmailForNotification(type, ctx) { return emailTpl.notification(type, ctx); }
/* Constrói payload de DM Discord (embed) pra uma notificação. Análogo ao
   buildEmailForNotification mas menor — DM não tem headline+body+footer,
   só embed com title/description/fields/url. */
function buildDiscordDMForNotification(type, ctx) {
  const { demand, project, trigger, stageName, commentText, demandUrl } = ctx;
  const projSub = project ? `${project.name}${project.client ? ' · ' + project.client : ''}` : null;
  const triggerName = trigger ? trigger.name : null;
  const clip = (s, n) => { s = String(s || '').replace(/<[^>]+>/g,'').trim(); return s.length > n ? s.slice(0, n-1) + '…' : s; };
  const COLORS = { assigned: 0x7A00FF, stage_assigned: 0x2b7fff, mention: 0xF5A718, watch_stage: 0xa1a1a1, watch_comment: 0xa1a1a1, reminder: 0xF5A718 };
  let title, description = '';
  switch (type) {
    case 'assigned':
      title = `🧑‍💼 Você é o responsável: ${demand.name}`;
      description = `Você foi definido como responsável${stageName ? ` na etapa **${stageName}**` : ''}.`;
      break;
    case 'stage_assigned':
      title = `📌 Nova etapa para você: ${demand.name}`;
      description = `A demanda avançou para a etapa **${stageName || '—'}** e você é o responsável.`;
      break;
    case 'mention':
      title = `💬 Mencionado em: ${demand.name}`;
      description = `${triggerName ? `**${triggerName}** mencionou você:\n` : ''}> ${clip(commentText, 300)}`;
      break;
    case 'watch_stage':
      title = `👀 Etapa avançou: ${demand.name}`;
      description = `Nova etapa: **${stageName || '—'}**.`;
      break;
    case 'reminder':
      title = `⏰ Lembrete: ${demand.name}`;
      description = commentText ? `> ${clip(commentText, 300)}` : 'Você pediu pra ser lembrado desta demanda.';
      break;
    case 'watch_comment':
      title = `👀 Novo comentário: ${demand.name}`;
      description = `${triggerName ? `**${triggerName}** comentou:\n` : ''}> ${clip(commentText, 300)}`;
      break;
    default: return null;
  }
  const fields = [];
  if (projSub) fields.push({ name: 'Projeto', value: projSub, inline: true });
  const embed = {
    title,
    description,
    color: COLORS[type] || 0x7A00FF,
    fields: fields.length ? fields : undefined,
    footer: { text: 'reWork' },
    timestamp: new Date().toISOString(),
  };
  if (demandUrl) embed.url = demandUrl;
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

/* Acesso a squads: vem do vínculo da pessoa com a organização DONA do squad.
   Dentro de uma requisição, só equipes da organização ativa contam. */
function canAccessWs(user, wsId) {
  if (!user || !wsId) return false;
  const orgId = tenancy.wsOrgId(wsId);
  if (!orgId || !tenancy.orgActive(orgId)) return false;
  const cur = tenancy.currentOrgId();
  if (cur && cur !== orgId) return false;
  const m = tenancy.memberIn(user.id, orgId);
  if (!m || m.active === false) return false;
  return m.role === 'owner' || m.role === 'admin' || (Array.isArray(m.workspaces) && m.workspaces.includes(wsId));
}
function wsIdsFor(user) {
  if (!user) return [];
  const cur = tenancy.currentOrgId();
  const orgIds = cur ? [cur] : tenancy.activeMemberships(user.id).map(m => m.orgId);
  return (rawDb.workspaces || []).filter(w => orgIds.includes(w.orgId) && canAccessWs(user, w.id)).map(w => w.id);
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
  const session = auth.sessionForToken(token);
  const user = session && allUsers().find(u => u.id === session.userId);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  // Organização ativa: a pedida pela aba (X-Org-Id, que vem da URL
  // /<id-da-org>/…), se a pessoa tiver vínculo ativo nela; senão a da sessão;
  // senão a última usada; senão a mais antiga. O cabeçalho não mexe na sessão
  // — duas abas em organizações diferentes convivem.
  const ms = tenancy.activeMemberships(user.id);
  if (!ms.length) return res.status(401).json({ error: 'Sua conta não faz parte de nenhuma organização ativa.', code: 'no_org' });
  const wanted = String(req.headers['x-org-id'] || '').trim();
  const sessOrg = session.data && session.data.orgId;
  let m = (wanted && ms.find(x => x.orgId === wanted)) || ms.find(x => x.orgId === sessOrg) || tenancy.primaryMembership(user);
  if (!m || m.active === false) m = ms[0];
  if (!sessOrg || (!wanted && sessOrg !== m.orgId)) auth.setSessionData(token, { orgId: m.orgId });
  tenancy.run(m.orgId, () => {
    // Freelancer: bloqueia globalmente mutações fora da whitelist. Endpoints
    // permitidos ainda aplicam checks internos (freelancerHasDemandAccess,
    // ownership em comentários/checklist/time, e limite de campos no PUT).
    if (user.isFreelancer && !freelancerCanMutate(req.method, req.path)) {
      return res.status(403).json({ error: 'Freelancers não têm permissão para essa ação' });
    }
    if (readOnlyBlock(tenancy.orgById(m.orgId), req.method, req.path)) {
      return res.status(403).json({ error: READ_ONLY_ERROR, code: 'read_only' });
    }
    if (emailBlock(user, req.method, req.path)) {
      return res.status(403).json({ error: 'Confirme um e-mail na sua conta para continuar usando o reWork.', code: 'email_required' });
    }
    req.user = user; req.token = token;
    req.org = tenancy.orgById(m.orgId); req.membership = m;
    next();
  });
}

/* Whitelist de rotas que um freelancer pode acessar via método mutante (POST/PUT/DELETE/PATCH).
   GET/HEAD/OPTIONS passam livre — a filtragem por demanda é feita nas próprias rotas.
   Cobre: alterar etapa da demanda (PUT /demands/:id — com guard interno de campos),
   comentar, apontar horas, checklist, watch/unwatch, perfil próprio e notificações. */
const FREELANCER_ALLOWED_MUTATIONS = [
  { m: 'PUT',    re: /^\/api\/demands\/[^/]+$/ },
  { m: 'POST',   re: /^\/api\/demands\/[^/]+\/comment$/ },
  { m: 'PUT',    re: /^\/api\/demands\/[^/]+\/comment\/[^/]+$/ },
  { m: 'DELETE', re: /^\/api\/demands\/[^/]+\/comment\/[^/]+$/ },
  { m: 'POST',   re: /^\/api\/demands\/[^/]+\/comment\/[^/]+\/react$/ },
  { m: 'POST',   re: /^\/api\/demands\/[^/]+\/time$/ },
  { m: 'PUT',    re: /^\/api\/demands\/[^/]+\/time\/[^/]+$/ },
  { m: 'DELETE', re: /^\/api\/demands\/[^/]+\/time\/[^/]+$/ },
  { m: 'POST',   re: /^\/api\/demands\/[^/]+\/checklist$/ },
  { m: 'PUT',    re: /^\/api\/demands\/[^/]+\/checklist\/[^/]+$/ },
  { m: 'DELETE', re: /^\/api\/demands\/[^/]+\/checklist\/[^/]+$/ },
  { m: 'POST',   re: /^\/api\/demands\/[^/]+\/watch$/ },
  { m: 'POST',   re: /^\/api\/demands\/[^/]+\/unwatch$/ },
  { m: 'PUT',    re: /^\/api\/me$/ },
  { m: 'POST',   re: /^\/api\/me(\/.*)?$/ },
  { m: 'POST',   re: /^\/api\/logout$/ },
  { m: 'POST',   re: /^\/api\/orgs\/switch$/ },
  { m: 'POST',   re: /^\/api\/uploads$/ },
  { m: 'PUT',    re: /^\/api\/notifications(\/.*)?$/ },
  { m: 'DELETE', re: /^\/api\/notifications(\/.*)?$/ },
];
function freelancerCanMutate(method, path) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return FREELANCER_ALLOWED_MUTATIONS.some(r => r.m === method && r.re.test(path));
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
/* Bloqueia freelancers — usado em endpoints que criam/editam entidades globais
   (clientes, projetos, fluxos, workspaces, usuários, etc). Freelancer só interage
   com as demandas em que está: avança etapas e comenta. */
function blockFreelancer(req, res, next) {
  if (req.user.isFreelancer) return res.status(403).json({ error: 'Freelancers não têm permissão para essa ação' });
  next();
}
/* Verifica se um freelancer tem vínculo com a demanda: é o responsável atual,
   OU foi responsável em alguma etapa (stageResponsibles / stageAdditions), OU criou. */
function freelancerHasDemandAccess(user, d) {
  if (!user || !d) return false;
  if (d.ownerId === user.id) return true;
  if (d.createdBy === user.id) return true;
  if (d.stageResponsibles && typeof d.stageResponsibles === 'object') {
    for (const v of Object.values(d.stageResponsibles)) {
      if (v === user.id) return true;
    }
  }
  if (Array.isArray(d.stageAdditions) && d.stageAdditions.some(s => s && s.responsibleId === user.id)) return true;
  if (Array.isArray(d.watchers) && d.watchers.includes(user.id)) return true;
  return false;
}
function canAccessDemand(user, d) {
  if (!d || !canAccessWs(user, d.workspaceId)) return false;
  if (user.isFreelancer) return freelancerHasDemandAccess(user, d);
  return true;
}

/* ─── NOTIFICAÇÕES ─── */
const NOTIFICATIONS_MAX_PER_USER = 500;
/* ── AUSÊNCIA (férias, folga) ──
   u.away = { from, to, substituteId } — datas YYYY-MM-DD, inclusivas.
   Enquanto fora: e-mail/Discord ficam pausados (o sino continua recebendo),
   etapas que cairiam com a pessoa vão pro substituto e quem a menciona é avisado. */
function isAway(u, ymd = today()) {
  const a = u && u.away;
  return !!(a && a.from && a.to && a.from <= ymd && ymd <= a.to);
}
// Responsável automático de etapa: se estiver fora, passa pro substituto
// (segue a cadeia, no máx. 3 saltos; sem substituto fica com a própria pessoa).
function awaySubstitute(userId) {
  let id = userId;
  for (let i = 0; i < 3 && id; i++) {
    const u = db.users.find(x => x.id === id);
    if (!u || !isAway(u)) return id;
    const sub = u.away.substituteId;
    const su = sub && sub !== userId && db.users.find(x => x.id === sub && x.active !== false);
    if (!su) return id;
    id = sub;
  }
  return id;
}

/* ── STATUS PESSOAL ──
   u.status = { kind: 'focus'|'meeting'|'custom', text, until (ISO|null), since }.
   Expira sozinho (until). "Focado" segura e-mail e Discord: o aviso vai pro
   sino na hora e entra em u.heldNotifs; quando o foco acaba, sai UM resumo
   por canal (flushHeldNotifications). */
const STATUS_KINDS = ['focus', 'meeting', 'custom'];
function activeStatus(u, now = Date.now()) {
  const st = u && u.status;
  if (!st || !STATUS_KINDS.includes(st.kind)) return null;
  if (st.until && Date.parse(st.until) <= now) return null;
  return st;
}
function isFocused(u) { const st = activeStatus(u); return !!(st && st.kind === 'focus'); }
const HELD_MAX = 60;
const HELD_LABELS = { assigned: 'Você é o responsável', stage_assigned: 'Nova etapa pra você', mention: 'Menção',
  watch_stage: 'Etapa avançou', watch_comment: 'Novo comentário', reminder: 'Lembrete', reaction: 'Reação', time_gap: 'Sem apontamento' };
function holdNotification(user, type, data, triggerUserId, baseUrl) {
  if (!Array.isArray(user.heldNotifs)) user.heldNotifs = [];
  user.heldNotifs.push({
    type, demandId: data.demandId || null, demandName: data.demandName || '',
    stageName: data.stageName || null, triggerUserId: triggerUserId || null,
    baseUrl: baseUrl || null, at: nowISO(),
  });
  if (user.heldNotifs.length > HELD_MAX) user.heldNotifs = user.heldNotifs.slice(-HELD_MAX);
  saveEntity('users', user);
}
function flushHeldNotifications(user) {
  const held = Array.isArray(user.heldNotifs) ? user.heldNotifs : [];
  if (!held.length) return;
  user.heldNotifs = [];
  saveEntity('users', user);
  if (isAway(user)) return; // de férias: fica só no sino, como qualquer aviso
  const base = (held.find(h => h.baseUrl) || {}).baseUrl || process.env.PUBLIC_URL || '';
  const toItem = h => {
    const who = h.triggerUserId && db.users.find(x => x.id === h.triggerUserId);
    return {
      name: h.demandName || HELD_LABELS[h.type] || h.type,
      href: base && h.demandId ? demandLinkFor(base, h.demandId) : null,
      meta: [HELD_LABELS[h.type] || h.type, h.stageName, who && who.name].filter(Boolean).join(' · '),
    };
  };
  const firstName = (user.name || '').split(/\s+/)[0] || user.name || '';
  // Cada canal respeita as preferências da pessoa, aviso por aviso.
  if (mailEnabled() && user.email) {
    const prefs = user.emailPrefs || defaultEmailPrefs();
    const items = held.filter(h => EMAIL_EVENT_LABELS[h.type] && prefs[h.type] !== false).map(toItem);
    if (items.length) {
      const { subject, html, text } = emailTpl.heldSummary({ firstName, items, baseUrl: base });
      Promise.resolve(sendEmail(user.email, subject, html, text)).catch(e => console.warn('[held] e-mail:', e.message));
    }
  }
  if (discordBot.isEnabled() && user.discordId) {
    const items = held.filter(h => DISCORD_EVENT_LABELS[h.type] && effectiveDiscordPref(user, h.type)).map(toItem);
    if (items.length) {
      const lines = items.slice(0, 10).map(it => `• ${it.href ? `[**${it.name}**](${it.href})` : `**${it.name}**`} — ${it.meta}`).join('\n')
        + (items.length > 10 ? `\n_…e mais ${items.length - 10}_` : '');
      discordBot.sendDM(user.discordId, { embeds: [{
        title: items.length === 1 ? '1 aviso enquanto você estava focado' : `${items.length} avisos enquanto você estava focado`,
        description: lines, color: 0x7A00FF, footer: { text: 'reWork · fim do foco' }, timestamp: nowISO(),
      }] }).catch(e => console.warn('[held] discord:', e.message));
    }
  }
}
// Foco que expirou sozinho (until) também solta o resumo — checa a cada minuto.
const _heldFlushInterval = setInterval(() => {
  for (const u of db.users) {
    if (Array.isArray(u.heldNotifs) && u.heldNotifs.length && !isFocused(u)) flushHeldNotifications(u);
  }
}, 60 * 1000);
if (_heldFlushInterval.unref) _heldFlushInterval.unref();

/* ── HORÁRIO DO RESUMO DIÁRIO ── por pessoa: { hour (5-22), days [0-6] }. */
const DEFAULT_DIGEST_SCHEDULE = { hour: 8, days: [1, 2, 3, 4, 5] };
function digestScheduleOf(u) {
  const sc = u && u.digestSchedule;
  return sc && Number.isInteger(sc.hour) && Array.isArray(sc.days) && sc.days.length ? sc : DEFAULT_DIGEST_SCHEDULE;
}
// Janela de 2h a partir da hora escolhida (tolera o intervalo de 15 min e reboot).
function digestDueNow(u, now = new Date()) {
  const sc = digestScheduleOf(u);
  if (!sc.days.includes(now.getDay())) return false;
  const h = now.getHours();
  return h >= sc.hour && h <= sc.hour + 1;
}
function digestScheduleLabel(u) {
  const sc = digestScheduleOf(u);
  const d = [...sc.days].sort((a, b) => a - b);
  const NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  let days;
  if (d.join() === '1,2,3,4,5') days = 'nos dias úteis';
  else if (d.length === 7) days = 'todos os dias';
  else {
    const names = d.map(i => NAMES[i]);
    days = names.length === 1 ? `${d[0] === 0 || d[0] === 6 ? 'todo' : 'toda'} ${names[0]}` : names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1] + ',';
  }
  return `${days} às ${sc.hour}h`;
}
const _greetFor = h => (h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite');

function notify(targetUserId, type, data, triggerUserId, baseUrl) {
  if (!targetUserId || targetUserId === triggerUserId) return; // não notifica a si mesmo
  const user = db.users.find(u => u.id === targetUserId && u.active !== false);
  if (!user) return;
  const nDemand = data.demandId ? (rawDb.demands || []).find(x => x.id === data.demandId) : null;
  const n = {
    id: uid(), userId: targetUserId, type,
    orgId: (nDemand && tenancy.wsOrgId(nDemand.workspaceId)) || tenancy.currentOrgId() || null,
    demandId: data.demandId || null,
    demandName: data.demandName || '',
    fromUser: triggerUserId || null,
    stageName: data.stageName || null,
    commentText: data.commentText || null,
    ...(data.emoji ? { emoji: data.emoji } : {}),
    read: false, createdAt: nowISO()
  };
  // Fire-and-forget: notify() é síncrono no chamador, mas a escrita no Postgres
  // é async — não bloqueia o response. Erro é logado, o request não quebra.
  store.insertNotification(n).catch(err => console.error('[notify] insert:', err.message));
  // Cap por usuário — remove as mais antigas.
  store.trimNotificationsFor(targetUserId, NOTIFICATIONS_MAX_PER_USER)
    .catch(err => console.error('[notify] trim:', err.message));
  // Broadcast SSE pro user alvo — refetch imediato do badge no cliente,
  // sem esperar o poll de 5min. Se cliente não está conectado por SSE
  // (mobile em background, tab fechada), pega no próximo poll ou no next boot.
  broadcastToUser(targetUserId, 'notification', 'create');
  // Fora (férias/folga): só o sino. E-mail e Discord voltam quando ela voltar.
  if (isAway(user)) return;
  // Focada: só o sino agora; e-mail e Discord saem num resumo quando o foco acabar.
  if (isFocused(user)) { holdNotification(user, type, data, triggerUserId, baseUrl); return; }
  // Email opcional — depende de SMTP configurado, do usuário ter email e do tipo estar nas prefs
  if (mailEnabled() && user.email && EMAIL_EVENT_LABELS[type]) {
    const prefs = user.emailPrefs || defaultEmailPrefs();
    if (prefs[type] !== false) {
      setImmediate(() => sendNotificationEmail(user, type, data, triggerUserId, baseUrl));
    }
  }
  // Discord DM opcional — bot habilitado + user com discordId + pref efetiva ligada
  if (discordBot.isEnabled() && user.discordId && DISCORD_EVENT_LABELS[type] && effectiveDiscordPref(user, type)) {
    setImmediate(() => sendNotificationDiscordDM(user, type, data, triggerUserId, baseUrl));
  }
}

/* Wrapper que monta ctx igual ao email e chama o bot. Fire-and-forget. */
function sendNotificationDiscordDM(user, type, data, triggerUserId, baseUrl) {
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
  const payload = buildDiscordDMForNotification(type, ctx);
  if (!payload) return;
  discordBot.sendDM(user.discordId, payload).catch(e => console.warn('[discord-dm]', e.message));
}
// Etapa pro cartão do e-mail: a citada no aviso (pelo nome) ou a atual da demanda.
function emailStageOf(d, label) {
  const flow = db.flows.find(f => f.id === d.flowId);
  const all = [...((flow && flow.stages) || []), ...(Array.isArray(d.stageAdditions) ? d.stageAdditions : [])];
  const st = label ? all.find(x => x.label === label) : stageByIdForDemand(flow, d, d.status);
  return st ? { label: st.label, color: st.color } : (label ? { label } : null);
}
function sendNotificationEmail(user, type, data, triggerUserId, baseUrl) {
  const demand = data.demandId ? db.demands.find(d => d.id === data.demandId) : null;
  if (!demand) return;
  const project = demand.projectId ? db.projects.find(p => p.id === demand.projectId) : null;
  const trigger = triggerUserId ? db.users.find(u => u.id === triggerUserId) : null;
  const base = baseUrl || process.env.PUBLIC_URL || '';
  const ctx = {
    demand, project, owner: user, trigger,
    stageName: data.stageName || null,
    stage: emailStageOf(demand, data.stageName),
    due: demand.stageDueDate || demand.deadline || null,
    commentText: data.commentText || null,
    demandUrl: demandLinkFor(base, demand.id),
    baseUrl: base,
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

// Atalho assíncrono para disparar sem bloquear a request. Dispara AMBOS:
// webhooks legados (POST HTTP externo) e bindings de canal do bot Discord
// (postar embed via bot). Cada saída trata o mesmo `ctx`, então call sites
// não precisam saber que existem 2 canais de saída.
function fireWebhook(event, ctxBuilder) {
  setImmediate(async () => {
    try {
      const ctx = typeof ctxBuilder === 'function' ? ctxBuilder() : ctxBuilder;
      await Promise.all([
        triggerWebhook(event, ctx),
        triggerBotChannelBindings(event, ctx),
      ]);
    } catch (e) {
      console.error('[fireWebhook] erro:', e.message);
    }
  });
}

/* Dispara bindings de canal do bot Discord — cliente → canal com eventos
   opt-in. Match: bind.clientId === project.clientId E event está em
   bind.events. Silencioso se bot desabilitado ou sem bind pro cliente.

   Envio:
     - Se binding tem webhookId+webhookToken (criado no POST/PUT), usa o
       webhook do canal e sobrescreve username+avatar_url pro NOME e FOTO
       do cliente (persona por-cliente). Foto vem de client.avatar
       transformada em URL absoluta via ctx.appBaseUrl.
     - Fallback: send como bot (identidade global do bot) se o webhook não
       foi criado (permissão MANAGE_WEBHOOKS ausente, canal privado, etc.) */
async function triggerBotChannelBindings(event, ctx) {
  if (!discordBot.isEnabled()) return;
  if (!ctx.demand || !ctx.project) return;
  const clientId = ctx.project.clientId;
  if (!clientId) return;
  const binds = (db.discordChannels || []).filter(b =>
    b.active !== false &&
    b.clientId === clientId &&
    Array.isArray(b.events) &&
    b.events.includes(event)
  );
  if (!binds.length) return;
  const basePayload = buildDiscordPayload(event, ctx);
  const client = db.clients.find(c => c.id === clientId);
  const baseUrl = ctx.appBaseUrl || process.env.PUBLIC_URL || '';
  // Discord baixa a URL sem sessão — precisa apontar pra rota pública
  // (/api/public/client-avatar/:id), não pra /uploads (que exige auth).
  // `?v=` invalida cache do Discord quando o avatar do cliente muda.
  const avatarUrl = (client && client.avatar && baseUrl)
    ? (/^https?:\/\//i.test(client.avatar)
        ? client.avatar
        : `${baseUrl.replace(/\/+$/, '')}/api/public/client-avatar/${client.id}?v=${_avatarVersion(client.avatar)}`)
    : null;
  const username = client?.name || 'reWork';
  for (const b of binds) {
    try {
      let ok = false;
      if (b.webhookId && b.webhookToken) {
        // Persona do cliente via webhook
        const personaPayload = { ...basePayload, username, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) };
        ok = await discordBot.sendViaWebhook(b.webhookId, b.webhookToken, personaPayload);
      } else {
        // Fallback: identidade do bot
        ok = await discordBot.sendChannelMessage(b.channelId, basePayload);
      }
      b.lastTriggered = nowISO();
      b.lastStatus = ok ? 200 : 0;
      b.lastError = ok ? null : 'Discord recusou a mensagem';
    } catch (e) {
      b.lastError = String(e.message || e).slice(0, 200);
      b.lastStatus = 0;
    }
    saveEntity('discordChannels', b);
  }
}

/* ─── APP ─── */
const app = express();
// Reverse proxy (Nginx Proxy Manager, Traefik, etc): confia no X-Forwarded-*
// pra req.secure/req.ip refletirem a origem real do usuário. Sem isso, cookies
// seguros não seriam emitidos e rate limits por IP contariam tudo como localhost.
app.set('trust proxy', 1);

/* Compressão gzip/deflate — reduz app.js (1.12MB) e style.css (434KB) em
   ~75% na transmissão. Pula:
     - /api/stream (SSE): compressão bufferiza chunks e quebra o realtime.
     - /uploads/*: arquivos binários (imagens/PDFs) já vêm comprimidos.
   O middleware avalia Accept-Encoding do cliente e o Content-Type da resposta
   automaticamente — texto/JSON/JS/CSS ganham gzip; binários passam direto. */
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/stream') return false;
    if (req.path.startsWith('/uploads/')) return false;
    return compression.filter(req, res);
  },
  threshold: 1024
}));

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
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' https: blob:",
    // Kastor Docs realtime abre ws:/wss: no MESMO host — 'self' já cobre em
    // navegadores modernos, mas explicitamos ws://* wss://* pra garantir
    // compatibilidade e evitar surpresas em CSP report-only.
    "connect-src 'self' ws: wss: https://*.clarity.ms https://c.bing.com",
    // pdf.js sobe um Web Worker (usa blob: quando o worker é servido cross-origin).
    "worker-src 'self' blob:",
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
// 210mb comporta arquivos até ~150MB depois do overhead do base64 (~33%) + metadados.
const jsonLg = express.json({ limit: '210mb' });
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
  const isUpload = /^\/api\/(uploads|demands(\/[^/]+(\/comment)?)?$|me$|users(\/[^/]+)?$|projects(\/[^/]+)?$|writer\/import$)/.test(req.path);
  return (isUpload ? jsonLg : jsonSm)(req, res, next);
});
/* Static do SPA — política de cache diferenciada:
   - HTML: no-cache (revalida sempre → pega novos ?v= dos assets)
   - JS/CSS: immutable, max-age=1yr (temos cache-buster ?v=... no HTML;
     mudar o cache-buster = URL nova = cache miss → sempre pega a versão certa)
   - Fontes/imagens: 30 dias
   Assim depois do primeiro load só o HTML (~40KB gzip) trafega em cada visita.
   Em dev, exporte NO_STATIC_CACHE=1 pra desabilitar cache e ver mudanças na hora. */
const NO_CACHE_STATIC = process.env.NO_STATIC_CACHE === '1';
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  // `extensions: ['html']` permite acessar /termos → termos.html sem sufixo.
  // Se o path bater com um arquivo .html, serve; senão passa pro próximo
  // middleware (SPA fallback via app.get catch-all).
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (NO_CACHE_STATIC) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return;
    }
    if (/\.html$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
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

/* Tipos "inline-safe": servidos com o MIME real e abertos no browser (prévia).
   Qualquer outro tipo também é ACEITO no upload, mas /uploads o serve sempre
   como download (attachment + octet-stream + CSP sandbox + nosniff) — HTML,
   SVG, XML etc. nunca são renderizados na origem do app (XSS). SVG mantém o
   MIME de imagem pra funcionar em <img> (contexto que nunca executa script).
   Pros tipos daqui, a extensão é DERIVADA do MIME, evitando "evil.png com
   Content-Type text/html". */
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
  'video/mp4':  'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav':  'wav',
  'audio/ogg':  'ogg',
  'audio/mp4':  'm4a',
};
const INLINE_SAFE_EXT = new Set([...Object.values(ALLOWED_MIME_EXT), 'jpeg']);
// 150 MB por arquivo — cabe apresentações grandes com mídia, PDFs longos e
// vídeos curtos. O compress client-side reduz a maioria pra <2MB, mas prints/
// PNGs sem compress podem passar. Cliente checa 150MB também.
// IMPORTANTE: `jsonLg` (limite do express.json em /api/uploads e /api/demands)
// precisa ser >= UPLOAD_MAX_BYTES * 1.4 pra caber o overhead de base64 (~33%)
// mais metadados; ver `express.json({ limit: '210mb' })` abaixo.
const UPLOAD_MAX_BYTES = 150 * 1024 * 1024;

// Mapa reverso: extensão → MIME canônico. Usado no fallback quando o browser
// não manda um MIME reconhecível (comum em pptx/xlsx/docx no Windows, que
// vêm como application/x-zip-compressed ou vazio porque são ZIPs por baixo).
const EXT_TO_MIME = Object.entries(ALLOWED_MIME_EXT).reduce((acc, [m, e]) => {
  if (!acc[e]) acc[e] = m; // primeiro MIME que bate — os modernos vêm primeiro no allowlist
  return acc;
}, {});

// Peso em bytes de um arquivo servido de /uploads (0 se não achar). basename
// impede sair da pasta de uploads.
function uploadSizeOf(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return 0;
  try { return fs.statSync(path.join(UPLOADS_DIR, path.basename(url.split('?')[0]))).size; } catch { return 0; }
}

// Anexos gravados antes de o peso ser salvo — preenche 1x a partir do disco.
function backfillAttachmentSizes() {
  let filled = 0;
  for (const d of db.demands) {
    let touched = false;
    for (const a of d.attachments || []) {
      if (a.kind === 'link' || a.size > 0) continue;
      const size = uploadSizeOf(a.data);
      if (size > 0) { a.size = size; touched = true; filled++; }
    }
    if (touched) markDirty('demands', d);
  }
  if (filled) console.log(`› Peso preenchido em ${filled} anexo(s)`);
}

function saveUploadFromDataUri(dataUri, originalName) {
  if (typeof dataUri !== 'string') return null;
  // `[^;]*` (não `+`) pra aceitar data URIs sem MIME (`data:;base64,...`) —
  // alguns browsers mandam assim quando não identificam o tipo do arquivo.
  const m = dataUri.match(/^data:([^;]*);base64,(.+)$/);
  if (!m) return null;
  let mime = (m[1] || '').toLowerCase();
  let ext = ALLOWED_MIME_EXT[mime];
  // Fora dos tipos conhecidos (ou MIME estranho, ex.: pptx como
  // application/x-zip-compressed), a extensão vem do nome original — só
  // [a-z0-9], então não há como injetar caminho. Sem extensão: .bin. O serve
  // de /uploads trata qualquer extensão fora de INLINE_SAFE_EXT como download.
  if (!ext) {
    const nameMatch = String(originalName || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/);
    const nameExt = nameMatch ? nameMatch[1] : null;
    ext = nameExt || 'bin';
    if (!mime && EXT_TO_MIME[ext]) mime = EXT_TO_MIME[ext];
  }
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > UPLOAD_MAX_BYTES) return null;
  // Dentro de uma organização: respeita o armazenamento do plano.
  const upOrgId = tenancy.currentOrgId();
  if (upOrgId) {
    const upOrg = tenancy.orgById(upOrgId);
    if (buf.length > orgPlan(upOrg).fileBytes || storageLimitError(upOrg, buf.length)) return null;
  }
  // Nome sanitizado + extensão FORÇADA (garante que browser reconheça o file
  // no /uploads/ estático via mime lookup por extensão).
  const rawBase = String(originalName || 'file').replace(/\.[a-z0-9]{1,10}$/i, '');
  const safeBase = rawBase.replace(/[^\w.\-]/g, '_').slice(0, 80) || 'file';
  const filename = uid() + '-' + safeBase + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  if (upOrgId) noteOrgUpload(upOrgId, buf.length);
  return {
    url: '/uploads/' + filename,
    name: originalName || (safeBase + '.' + ext),
    type: mime || EXT_TO_MIME[ext] || 'application/octet-stream',
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
  // 507 (e não 413): o 413 o cliente lê como limite do proxy.
  const incoming = Math.floor((String(data).length - String(data).indexOf(',') - 1) * 0.75);
  const plan = orgPlan(req.org);
  if (incoming > plan.fileBytes) {
    return res.status(413).json({ error: `Arquivo maior que ${fmtBytes(plan.fileBytes)}, o limite por arquivo do plano ${plan.name}.`, code: 'file_limit' });
  }
  const full = storageLimitError(req.org, incoming);
  if (full) return res.status(507).json({ error: full, code: 'storage_limit' });
  const saved = saveUploadFromDataUri(data, name);
  if (!saved) {
    return res.status(400).json({
      error: 'Arquivo inválido: vazio, maior que 150 MB ou data URI mal formado.'
    });
  }
  res.json(saved);
});

// Serve /uploads/* — só pra usuários autenticados (cookie httpOnly). Listing desativado.
// Query `?dl=1&name=<original>` força o browser a baixar (Content-Disposition:
// attachment) com o nome ORIGINAL do arquivo (preservando espaços/acentos via
// RFC 5987). Sem essa flag, serve inline (comportamento default do express.static).
// Isso resolve corrupção percebida em PPTX/PDF: sem attachment header + com
// mime type incomum (ex.: pptx = application/vnd.openxmlformats-...), alguns
// browsers/plugins tentam abrir inline e re-interpretam o binário. Forçando
// attachment + Content-Type explícito, o download vem 1:1 com o disco.
app.use('/uploads', requireAuth, (req, res, next) => {
  const fileExt = path.extname(req.path).slice(1).toLowerCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!INLINE_SAFE_EXT.has(fileExt)) {
    // Tipo que o browser poderia executar/renderizar (html, svg, xml, js…) ou
    // desconhecido: nunca abre na origem do app — sempre baixa, em sandbox.
    // SVG mantém o MIME de imagem pra funcionar em <img> (lá nunca roda script).
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Content-Type', fileExt === 'svg' ? 'image/svg+xml' : 'application/octet-stream');
    if (req.query.dl !== '1') res.setHeader('Content-Disposition', 'attachment');
  }
  if (req.query.dl === '1') {
    const rawName = String(req.query.name || '').slice(0, 255) || path.basename(req.path);
    // Tira caracteres proibidos em nomes de arquivo (Windows + geral).
    const cleanName = rawName.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/[. ]+$/g, '');
    const asciiFallback = cleanName.replace(/[^\x20-\x7e]/g, '_') || 'download';
    // RFC 5987: filename* aceita UTF-8 (acentos/emojis); filename (ASCII) é fallback.
    const encoded = encodeURIComponent(cleanName);
    res.setHeader('Content-Disposition',
      `attachment; filename="${asciiFallback.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`);
    // Content-Type explícito pela extensão do arquivo REAL no disco — evita que
    // o mime lookup do send/express tropeçe em extensões incomuns.
    const mime = INLINE_SAFE_EXT.has(fileExt) ? (EXT_TO_MIME[fileExt] || 'application/octet-stream') : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    // Sem cache pra downloads (o arquivo em si já é imutável pelo hash no nome,
    // mas com Content-Disposition dinâmico pelo nome, cachear é confuso).
    res.setHeader('Cache-Control', 'private, no-cache');
  }
  next();
}, express.static(UPLOADS_DIR, { index: false, dotfiles: 'deny' }), (req, res, next) => {
  // Não achou: se o GC tinha levado pra lixeira, devolve e repete o pedido.
  let name = '';
  try { name = path.basename(decodeURIComponent(req.path)); } catch {}
  if (restoreUploadFromTrash(name)) return res.redirect(307, req.originalUrl);
  // 404 de verdade. Sem isso o pedido caía no fallback do SPA e voltava 200 com
  // o index.html — que o download salvava com o nome e o tipo do anexo
  // ("Apresentação.pptx" com HTML dentro = arquivo "corrompido").
  res.removeHeader('Content-Disposition');
  res.removeHeader('Cache-Control');
  res.status(404).type('text/plain; charset=utf-8').send('Arquivo não encontrado');
});

/* Avatar público de cliente — rota SEM auth, usada por:
   - Bot do Discord (baixa a imagem pra usar como avatar da persona por-cliente
     no webhook do canal). Sem auth aqui = 401 = ícone genérico do Discord.
   - Dashboard público read-only (a página de link compartilhado carrega direto
     no browser do stakeholder, que não tem sessão do reWork).
   Retorna apenas a foto — nenhum outro dado do cliente. */
app.get('/api/public/client-avatar/:clientId', (req, res) => {
  const id = String(req.params.clientId || '');
  if (!/^[a-f0-9]{6,64}$/i.test(id)) return res.status(404).end();
  const c = db.clients.find(x => x.id === id && notDeleted(x));
  if (!c || !c.avatar) return res.status(404).end();
  // Se o avatar já é uma URL absoluta (raro, mas suportado), redireciona.
  if (/^https?:\/\//i.test(c.avatar)) return res.redirect(302, c.avatar);
  // Path interno /uploads/xxx — resolve dentro de UPLOADS_DIR (guard de path traversal).
  const rel = String(c.avatar).replace(/^\/+/, '').replace(/^uploads\/+/, '');
  const safe = path.basename(rel);
  const full = path.join(UPLOADS_DIR, safe);
  if (!full.startsWith(UPLOADS_DIR) || !fs.existsSync(full)) return res.status(404).end();
  const ext = path.extname(safe).slice(1).toLowerCase();
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // Rota sem auth: SVG aberto direto no browser não pode executar script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  fs.createReadStream(full).pipe(res);
});

/* ── HEALTH CHECK ──
   Liveness (/api/health): responde na hora, sem tocar no banco — é o que o
   orquestrador/load-balancer deve pollar pra detectar um processo travado.
   Readiness (/api/health/ready): pinga o Postgres; 503 se o banco estiver fora.
   Ambos públicos (sem requireAuth) — health check não deve depender de sessão. */
/* BUILD_SHA vem do env (setado no Dockerfile via ARG do GitHub Actions).
   É o identificador da build atual — se o cliente detectar que mudou desde
   o load da página, sabe que o server foi atualizado e oferece um reload. */
const BUILD_SHA = String(process.env.BUILD_SHA || 'dev').slice(0, 40);
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: nowISO(), build: BUILD_SHA });
});
app.get('/api/health/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

/* ─── MARKETING (n8n webhook + view Performance) ───
   Ingest é público mas gated por token estático (env MARKETING_WEBHOOK_TOKEN),
   pois o n8n não tem sessão. Payload esperado:
     { rows: [{ clientId, platform, campaign, date, spend, leads, cpl, ... }, ...] }
   Campos são normalizados (numeric coercion + trim). Dia repetido → upsert. */
const MARKETING_TOKEN = String(process.env.MARKETING_WEBHOOK_TOKEN || '').trim();
function _mktNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _mktStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}
function _mktDate(v) {
  if (!v) return null;
  // Aceita 'YYYY-MM-DD', ISO com hora, ou epoch. Sempre serializa como 'YYYY-MM-DD'.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}
app.post('/api/marketing/ingest', express.json({ limit: '5mb' }), async (req, res) => {
  if (!MARKETING_TOKEN) {
    return res.status(503).json({ error: 'MARKETING_WEBHOOK_TOKEN não configurado no server' });
  }
  const token = String(req.headers['x-marketing-token'] || '').trim();
  if (token !== MARKETING_TOKEN) return res.status(401).json({ error: 'Token inválido' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Body precisa de { rows: [...] }' });
  if (rows.length > 5000) return res.status(413).json({ error: 'Lote máximo: 5000 rows' });

  const normalized = [];
  const errors = [];
  const validClientIds = new Set(db.clients.map(c => c.id));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const clientId = _mktStr(r.clientId);
    const platform = _mktStr(r.platform);
    const campaign = _mktStr(r.campaign);
    const date = _mktDate(r.date);
    if (!clientId || !platform || !campaign || !date) {
      errors.push({ index: i, reason: 'clientId/platform/campaign/date obrigatórios' });
      continue;
    }
    if (!validClientIds.has(clientId)) {
      errors.push({ index: i, reason: `clientId ${clientId} não existe` });
      continue;
    }
    normalized.push({
      client_id: clientId,
      platform,
      campaign,
      date,
      spend: _mktNum(r.spend),
      avg_daily: _mktNum(r.avgDaily ?? r.avg_daily),
      leads: _mktNum(r.leads),
      cpl: _mktNum(r.cpl),
      impressions: _mktNum(r.impressions),
      reach: _mktNum(r.reach),
      clicks: _mktNum(r.clicks),
      cpm: _mktNum(r.cpm),
      cpc: _mktNum(r.cpc),
      profile_visits: _mktNum(r.profileVisits ?? r.profile_visits),
      new_followers: _mktNum(r.newFollowers ?? r.new_followers),
      proj_spend_campaign: _mktNum(r.projSpendCampaign ?? r.proj_spend_campaign),
      proj_leads_campaign: _mktNum(r.projLeadsCampaign ?? r.proj_leads_campaign),
      monthly_budget: _mktNum(r.monthlyBudget ?? r.monthly_budget),
      proj_spend_account: _mktNum(r.projSpendAccount ?? r.proj_spend_account),
      proj_leads_account: _mktNum(r.projLeadsAccount ?? r.proj_leads_account),
      alert_status: _mktStr(r.alertStatus ?? r.alert_status),
      alert_analysis: _mktStr(r.alertAnalysis ?? r.alert_analysis),
      raw: r
    });
  }
  if (!normalized.length) {
    return res.status(400).json({ error: 'Nenhuma linha válida', errors });
  }
  try {
    const { inserted, updated } = await store.upsertMarketingSnapshots(normalized);
    res.json({ ok: true, inserted, updated, skipped: errors.length, errors });
  } catch (e) {
    console.error('[marketing/ingest] erro:', e.message);
    res.status(500).json({ error: 'Falha ao gravar snapshots' });
  }
});

/* Lê snapshots de um cliente num período. Retorna rows achatadas + o cliente
   pra facilitar render no frontend. Filtro de permissão: admin OU membro de
   um workspace que contém esse cliente. */
/* Config do webhook — admin ou moderador. Devolve o token pra colar no n8n.
   Não trafega o token pra usuários comuns. */
app.get('/api/marketing/webhook-config', requireAuth, modOrAdmin, installationOrgOnly, (req, res) => {
  res.json({ token: MARKETING_TOKEN || '', endpoint: '/api/marketing/ingest' });
});

app.get('/api/marketing/performance', requireAuth, async (req, res) => {
  const clientId = String(req.query.clientId || '').trim();
  const workspaceId = String(req.query.workspaceId || '').trim();
  const start = _mktDate(req.query.start);
  const end = _mktDate(req.query.end);
  if (!clientId && !workspaceId) return res.status(400).json({ error: 'clientId ou workspaceId obrigatório' });
  if (!start || !end) return res.status(400).json({ error: 'start/end obrigatórios (YYYY-MM-DD)' });

  let ids = [];
  let scope = null;
  if (clientId) {
    // Modo cliente único: valida existência + acesso ao workspace do cliente.
    const client = db.clients.find(c => c.id === clientId);
    if (!client || !notDeleted(client)) return res.status(404).json({ error: 'Cliente não encontrado' });
    if (!canAccessWs(req.user, client.workspaceId)) {
      return res.status(403).json({ error: 'Sem acesso a esse cliente' });
    }
    // Squad opcional: se veio junto, precisa bater — protege contra query manual estranha.
    if (workspaceId && workspaceId !== client.workspaceId) {
      return res.status(400).json({ error: 'workspaceId não corresponde ao cliente' });
    }
    ids = [clientId];
    scope = { kind: 'client', client: { id: client.id, name: client.name, workspaceId: client.workspaceId } };
  } else {
    // Modo squad: agrega todos os clientes ativos daquele workspace que o user pode ver.
    if (!canAccessWs(req.user, workspaceId)) {
      return res.status(403).json({ error: 'Sem acesso a essa equipe' });
    }
    const clientsInWs = db.clients.filter(c => c.workspaceId === workspaceId && notDeleted(c) && c.active !== false);
    ids = clientsInWs.map(c => c.id);
    scope = { kind: 'workspace', workspaceId, clientCount: clientsInWs.length };
  }

  try {
    const rows = ids.length ? await store.listMarketingSnapshots(ids, start, end) : [];
    res.json({ scope, rows, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[marketing/performance] erro:', e.message);
    res.status(500).json({ error: 'Falha ao ler snapshots' });
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
app.post('/api/login', async (req, res) => {
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
  // Entra com o nome de usuário ou com o e-mail da conta. Bases antigas podem
  // ter o mesmo e-mail em duas contas: vale a que tiver essa senha.
  const ident = String(username || '').trim().toLowerCase();
  const candidates = ident ? db.users.filter(u =>
    String(u.username || '').toLowerCase() === ident || (u.email && u.email.toLowerCase() === ident)
  ) : [];
  const user = candidates.find(u => auth.verifyPassword(u.id, password)) || null;
  if (!user) {
    rec.count++;
    _loginAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  if (!tenancy.activeMemberships(user.id).length) {
    rec.count++;
    _loginAttempts.set(ip, rec);
    // Vínculo ainda ativo, mas numa organização excluída/suspensa.
    const closed = tenancy.membershipsOf(user.id).some(m => m.active !== false && !tenancy.orgActive(m.orgId));
    return res.status(403).json({ error: closed
      ? 'A organização da sua conta não está mais disponível no reWork. Fale com o dono da organização.'
      : 'Seu acesso está desativado. Fale com a coordenação da sua equipe.' });
  }
  // Sucesso: zera o contador desse IP
  _loginAttempts.delete(ip);
  // Verificação em duas etapas: a senha certa só libera o segundo passo.
  if (twoFactorOn(user)) {
    const t = await startTwoFactorTicket(req, user, 'password');
    if (t.error) return res.status(t.status || 500).json({ error: t.error });
    return res.json({ twoFactor: t.public });
  }
  recordLoginIp(user, ip);
  // Cookie httpOnly: JS no browser não consegue ler — protege contra XSS.
  // O `token` no body é mantido por compat (clientes antigos podiam usar Bearer).
  const token = startSession(req, res, user);
  res.json({ token, user: publicUser(user, { self: true }) });
});

/* ─── VERIFICAÇÃO EM DUAS ETAPAS ───
   Dois níveis:
     - "email" (obrigatório): toda conta com e-mail confirmado recebe um código
       de 6 dígitos a cada login — liga sozinho quando o e-mail é confirmado
       (sem SMTP no servidor, fica só a senha);
     - "totp" (opcional, mais forte): app autenticador (Google Authenticator,
       1Password…), com 10 códigos de recuperação de uso único. Enquanto
       ativo, substitui o código por e-mail; desativar volta pro e-mail.
   Só o app fica gravado na conta (u.twoFactor); o e-mail sai do vínculo.
   Login (senha ou Discord) → ticket em memória (10 min, 5 tentativas) →
   /api/login/2fa confere o código e aí sim abre a sessão. Segredo do app
   fica cifrado com a chave mestra; códigos (e-mail e recuperação), só o hash. */
const TWOFA_TICKET_TTL_MS = 10 * 60 * 1000;
const TWOFA_MAX_ATTEMPTS = 5;
const TWOFA_RESEND_COOLDOWN_MS = 30 * 1000;
const _twoFaTickets = new Map(); // ticket → { userId, method, codeHash, exp, attempts, sends, lastSentAt, via }
setInterval(() => { const t = Date.now(); for (const [k, v] of _twoFaTickets) if (v.exp < t) _twoFaTickets.delete(k); }, 60 * 1000).unref();
function twoFactorMethodOf(u) {
  if (!u) return null;
  if (u.twoFactor && u.twoFactor.method === 'totp' && u.twoFactor.secretEnc) return 'totp';
  return emailLinked(u) && mailEnabled() ? 'email' : null;
}
const twoFactorOn = (u) => !!twoFactorMethodOf(u);
const emailCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const codeHash = (salt, code) => totp.sha256('2fa:' + salt + ':' + String(code || '').replace(/\D/g, ''));
function maskEmail(e) {
  const [name, dom] = String(e || '').split('@');
  if (!dom) return '';
  const shown = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, Math.min(6, name.length - shown.length)))}@${dom}`;
}
async function sendLoginCode(req, user, code) {
  const baseUrl = appBaseUrl(req);
  const m = emailTpl.loginCode({ name: user.name, code, baseUrl, ip: clientIp(req) });
  return sendEmail(user.email, m.subject, m.html, m.text);
}
/* Cria o ticket do segundo passo (e manda o código, se for por e-mail). */
async function startTwoFactorTicket(req, user, via) {
  const method = twoFactorMethodOf(user);
  if (method === 'email' && (!user.email || !mailEnabled())) {
    return { status: 503, error: 'Não conseguimos mandar o código de acesso por e-mail agora. Fale com um administrador da sua organização.' };
  }
  for (const [k, v] of _twoFaTickets) if (v.userId === user.id) _twoFaTickets.delete(k);
  const ticket = crypto.randomBytes(24).toString('base64url');
  const rec = { userId: user.id, method, codeHash: null, exp: Date.now() + TWOFA_TICKET_TTL_MS, attempts: 0, sends: 0, lastSentAt: 0, via };
  if (method === 'email') {
    const code = emailCode();
    rec.codeHash = codeHash(ticket, code);
    const sent = await sendLoginCode(req, user, code);
    if (!sent || !sent.sent) return { status: 502, error: 'Não conseguimos mandar o código de acesso agora. Tente de novo em alguns minutos.' };
    rec.sends = 1; rec.lastSentAt = Date.now();
  }
  _twoFaTickets.set(ticket, rec);
  return { ticket, public: twoFactorTicketPublic(ticket, rec, user) };
}
function twoFactorTicketPublic(ticket, rec, user) {
  return {
    ticket, method: rec.method,
    emailHint: rec.method === 'email' ? maskEmail(user.email) : null,
    recoveryLeft: rec.method === 'totp' ? ((user.twoFactor && user.twoFactor.recovery) || []).filter(c => !c.usedAt).length : 0,
    expiresAt: new Date(rec.exp).toISOString()
  };
}
/* Confere um código contra o método da conta. `extra` = recovery (bool). */
function checkTwoFactorCode(user, rec, ticket, code, useRecovery) {
  const tf = user.twoFactor;
  if (useRecovery) {
    if (!tf) return false;
    const h = totp.sha256('rc:' + totp.normRecovery(code));
    const rc = (tf.recovery || []).find(c => !c.usedAt && totp.safeEqual(c.hash, h));
    if (!rc) return false;
    rc.usedAt = nowISO();
    return 'recovery';
  }
  if (rec.method === 'email') return !!rec.codeHash && totp.safeEqual(rec.codeHash, codeHash(ticket, code));
  if (rec.method === 'totp' && tf) {
    let secret = null;
    try { secret = auth.decryptString(tf.secretEnc); } catch {}
    const step = secret ? totp.totpVerify(secret, code, tf.lastStep) : null;
    if (step === null) return false;
    tf.lastStep = step;
    return true;
  }
  return false;
}
const rateLimitTwoFa = makeRateLimit(new Map(), 15, 'tentativas');
app.get('/api/login/2fa/:ticket', rateLimitTwoFa, (req, res) => {
  const rec = _twoFaTickets.get(String(req.params.ticket));
  const user = rec && rec.exp > Date.now() && allUsers().find(u => u.id === rec.userId);
  if (!user || !twoFactorOn(user)) return res.status(410).json({ error: 'Esta etapa de acesso expirou. Entre de novo.' });
  res.json(twoFactorTicketPublic(req.params.ticket, rec, user));
});
app.post('/api/login/2fa', rateLimitTwoFa, (req, res) => {
  const { ticket, code, recovery } = req.body || {};
  const rec = _twoFaTickets.get(String(ticket || ''));
  if (!rec || rec.exp <= Date.now()) return res.status(410).json({ error: 'O código expirou. Entre de novo para receber outro.', code: 'expired' });
  const user = allUsers().find(u => u.id === rec.userId);
  if (!user || !twoFactorOn(user) || !tenancy.activeMemberships(user.id).length) { _twoFaTickets.delete(ticket); return res.status(410).json({ error: 'Entre de novo.', code: 'expired' }); }
  if (recovery && rec.method !== 'totp') return res.status(400).json({ error: 'Esta conta não usa códigos de recuperação.' });
  const ok = checkTwoFactorCode(user, rec, ticket, code, !!recovery);
  if (!ok) {
    rec.attempts++;
    if (rec.attempts >= TWOFA_MAX_ATTEMPTS) { _twoFaTickets.delete(ticket); return res.status(429).json({ error: 'Muitas tentativas erradas. Entre de novo.', code: 'expired' }); }
    return res.status(400).json({ error: recovery ? 'Código de recuperação inválido ou já usado.' : 'Código incorreto. Confira e tente de novo.', attemptsLeft: TWOFA_MAX_ATTEMPTS - rec.attempts });
  }
  _twoFaTickets.delete(ticket);
  saveEntity('users', user); // passo do app / código de recuperação usado
  recordLoginIp(user, clientIp(req));
  const token = startSession(req, res, user);
  res.json({ token, user: publicUser(user, { self: true }), usedRecovery: ok === 'recovery' });
});
app.post('/api/login/2fa/resend', rateLimitTwoFa, async (req, res) => {
  const ticket = String((req.body || {}).ticket || '');
  const rec = _twoFaTickets.get(ticket);
  if (!rec || rec.exp <= Date.now()) return res.status(410).json({ error: 'Esta etapa expirou. Entre de novo.', code: 'expired' });
  if (rec.method !== 'email') return res.status(400).json({ error: 'Use o código do app autenticador.' });
  const wait = rec.lastSentAt + TWOFA_RESEND_COOLDOWN_MS - Date.now();
  if (wait > 0) return res.status(429).json({ error: `Aguarde ${Math.ceil(wait / 1000)}s para pedir outro código.`, retryAfter: Math.ceil(wait / 1000) });
  if (rec.sends >= 5) return res.status(429).json({ error: 'Muitos códigos pedidos. Entre de novo mais tarde.' });
  const user = allUsers().find(u => u.id === rec.userId);
  if (!user) return res.status(410).json({ error: 'Entre de novo.', code: 'expired' });
  const code = emailCode();
  rec.codeHash = codeHash(ticket, code);
  rec.attempts = 0;
  rec.exp = Date.now() + TWOFA_TICKET_TTL_MS;
  const sent = await sendLoginCode(req, user, code);
  if (!sent || !sent.sent) return res.status(502).json({ error: 'Não conseguimos mandar o código agora. Tente de novo em alguns minutos.' });
  rec.sends++; rec.lastSentAt = Date.now();
  res.json({ ok: true, expiresAt: new Date(rec.exp).toISOString() });
});

/* Ativar / desativar no perfil. Sempre pede a senha (se a conta tem uma). */
function checkOwnPassword(u, password) {
  return !auth.hasPassword(u.id) || auth.verifyPassword(u.id, password);
}
function twoFactorNotice(req, u, enabled, method) {
  if (!u.email || !mailEnabled()) return;
  const m = emailTpl.twoFactorNotice({ name: u.name, enabled, method, baseUrl: appBaseUrl(req) });
  setImmediate(() => sendEmail(u.email, m.subject, m.html, m.text));
}
const rateLimitTwoFaSetup = makeRateLimit(new Map(), 10, 'tentativas', req => 'u:' + (req.user?.id || clientIp(req)), 10 * 60 * 1000);
app.post('/api/me/2fa/start', requireAuth, rateLimitTwoFaSetup, async (req, res) => {
  const u = req.user;
  const { method, password } = req.body || {};
  // O código por e-mail já vem ligado com o e-mail confirmado: aqui só o app.
  if (method !== 'totp') return res.status(400).json({ error: 'O código por e-mail já fica ativo quando o e-mail é confirmado. Aqui você só ativa o app autenticador.' });
  if (!checkOwnPassword(u, password)) return res.status(400).json({ error: 'Senha incorreta.', field: 'password' });
  const enr = await totp.totpEnrollment('reWork', u.email || u.username);
  u.twoFactorSetup = { method, secretEnc: auth.encryptString(enr.secret), expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(), attempts: 0 };
  saveEntity('users', u);
  res.json({ method, secret: enr.secretGrouped, otpauth: enr.otpauth, qr: enr.qr });
});
app.post('/api/me/2fa/confirm', requireAuth, rateLimitTwoFaSetup, (req, res) => {
  const u = req.user;
  const setup = u.twoFactorSetup;
  if (!setup || Date.parse(setup.expiresAt) <= Date.now()) return res.status(410).json({ error: 'O cadastro expirou. Comece de novo.' });
  const code = String((req.body || {}).code || '');
  let secret = null;
  try { secret = auth.decryptString(setup.secretEnc); } catch {}
  const step = secret ? totp.totpVerify(secret, code, null) : null;
  const ok = step !== null;
  const secretEnc = setup.secretEnc;
  if (!ok) {
    setup.attempts = (setup.attempts || 0) + 1;
    if (setup.attempts >= TWOFA_MAX_ATTEMPTS) { delete u.twoFactorSetup; saveEntity('users', u); return res.status(429).json({ error: 'Muitas tentativas erradas. Comece de novo.' }); }
    saveEntity('users', u);
    return res.status(400).json({ error: 'Código incorreto. Confira e tente de novo.' });
  }
  const recoveryCodes = totp.newRecoveryCodes();
  const tf = {
    method: 'totp', enabledAt: nowISO(), secretEnc, lastStep: step,
    recovery: recoveryCodes.map(c => ({ hash: totp.sha256('rc:' + totp.normRecovery(c)), usedAt: null }))
  };
  u.twoFactor = tf;
  delete u.twoFactorSetup;
  saveEntity('users', u);
  twoFactorNotice(req, u, true, tf.method);
  res.json({ ok: true, user: publicUser(u, { self: true }), recoveryCodes });
});
app.post('/api/me/2fa/disable', requireAuth, rateLimitTwoFaSetup, (req, res) => {
  const u = req.user;
  if (twoFactorMethodOf(u) !== 'totp') return res.status(400).json({ error: 'O código por e-mail é obrigatório e não pode ser desligado.' });
  if (!checkOwnPassword(u, (req.body || {}).password)) return res.status(400).json({ error: 'Senha incorreta.', field: 'password' });
  delete u.twoFactor; delete u.twoFactorSetup;
  saveEntity('users', u);
  twoFactorNotice(req, u, false, 'totp');
  res.json({ ok: true, user: publicUser(u, { self: true }) });
});
app.post('/api/me/2fa/recovery-codes', requireAuth, rateLimitTwoFaSetup, (req, res) => {
  const u = req.user;
  if (twoFactorMethodOf(u) !== 'totp') return res.status(400).json({ error: 'Os códigos de recuperação são do app autenticador.' });
  if (!checkOwnPassword(u, (req.body || {}).password)) return res.status(400).json({ error: 'Senha incorreta.', field: 'password' });
  const codes = totp.newRecoveryCodes();
  u.twoFactor.recovery = codes.map(c => ({ hash: totp.sha256('rc:' + totp.normRecovery(c)), usedAt: null }));
  saveEntity('users', u);
  res.json({ ok: true, recoveryCodes: codes, user: publicUser(u, { self: true }) });
});

/* Marca o tour de boas-vindas como visto — chamado pelo frontend depois
   do usuário completar ou pular o tour. Idempotente. */
app.post('/api/me/tour-complete', requireAuth, (req, res) => {
  const user = req.user;
  if (!user.hasSeenTour) {
    user.hasSeenTour = true;
    user.tourSeenAt = nowISO();
    saveEntity('users', user);
  }
  res.json({ ok: true, hasSeenTour: true });
});

/* Primeiros passos (conta criada por convite) concluídos ou pulados. */
app.post('/api/me/onboarding/done', requireAuth, (req, res) => {
  const user = req.user;
  if (user.onboardingPendingAt) {
    delete user.onboardingPendingAt;
    user.onboardingDoneAt = nowISO();
    saveEntity('users', user);
  }
  res.json({ ok: true, user: publicUser(user, { self: true }) });
});

/* ─── RELEASE NOTES / NOTAS DE ATUALIZAÇÃO ─────────────────────────────
   Fonte: release-notes.json na raiz do projeto (versionado no git).
   Devs adicionam entradas antes do deploy. Estrutura de cada entrada:
     { id: 'slug-unico', date: 'YYYY-MM-DD', title, highlights: [] }
   Cache em memória com refresh no filestamp — evita re-ler o arquivo a
   cada request mas pega mudanças pós-deploy sem restart.

   Regras de exibição pro usuário:
   - Rate limit: 1x por dia (user.releaseNotesShownAt = YYYY-MM-DD).
   - Só entradas com id NÃO em user.releaseNotesSeenIds.
   - Ordenadas por data desc, cap em 5.
   - Se hoje já mostrou (mesma data em shownAt), retorna vazio. */
const RELEASE_NOTES_PATH = path.join(__dirname, 'release-notes.json');
let _releaseNotesCache = { data: [], mtime: 0 };
function _loadReleaseNotes() {
  try {
    const st = fs.statSync(RELEASE_NOTES_PATH);
    if (st.mtimeMs === _releaseNotesCache.mtime) return _releaseNotesCache.data;
    const raw = fs.readFileSync(RELEASE_NOTES_PATH, 'utf8');
    const arr = JSON.parse(raw);
    _releaseNotesCache = { data: Array.isArray(arr) ? arr : [], mtime: st.mtimeMs };
  } catch { _releaseNotesCache = { data: [], mtime: 0 }; }
  return _releaseNotesCache.data;
}
function _todayYmd() { return new Date().toISOString().slice(0, 10); }
/* Entrada pro cliente: "launch" (apresentação de produto) leva o bloco extra;
   hideFor esconde de um tipo de conta (ex.: freelancer não usa o Docs). */
function _releaseNoteOut(n) {
  return {
    id: n.id, date: n.date, title: n.title, highlight: !!n.highlight,
    highlights: Array.isArray(n.highlights) ? n.highlights : [],
    ...(n.kind === 'launch' && n.launch ? { kind: 'launch', launch: n.launch } : {})
  };
}
function _releaseNoteVisible(n, user) {
  const hide = Array.isArray(n.hideFor) ? n.hideFor : [];
  if (hide.includes('freelancer') && user.isFreelancer) return false;
  return true;
}

app.get('/api/me/release-notes', requireAuth, (req, res) => {
  const user = req.user;
  const today = _todayYmd();
  // Rate limit: já viu hoje → nada pendente.
  if (user.releaseNotesShownAt === today) return res.json({ notes: [] });
  const all = _loadReleaseNotes();
  const seen = new Set(user.releaseNotesSeenIds || []);
  const pending = all
    .filter(n => n && n.id && !seen.has(n.id) && _releaseNoteVisible(n, user))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 10)
    .map(_releaseNoteOut);
  res.json({ notes: pending });
});

/* Lista completa de notas — sem rate limit, sem filtro de seen. Usado pelo
   botão "Ver novidades" no perfil pra o usuário revisitar o histórico. */
app.get('/api/release-notes/all', requireAuth, (req, res) => {
  const all = _loadReleaseNotes();
  const sorted = all
    .filter(n => n && n.id && _releaseNoteVisible(n, req.user))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map(_releaseNoteOut);
  res.json({ notes: sorted });
});

/* Marca notas como vistas + registra data pra rate limit diário. Idempotente. */
/* Botão "Novidades" da barra lateral: guarda a novidade mais recente que a
   pessoa já abriu por ali (o ponto some até sair uma nova). */
app.post('/api/me/news-seen', requireAuth, (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id.slice(0, 80) : '';
  if (id && req.user.newsSeenId !== id) { req.user.newsSeenId = id; saveEntity('users', req.user); }
  res.json({ ok: true });
});
app.post('/api/me/release-notes-seen', requireAuth, (req, res) => {
  const user = req.user;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string').slice(0, 50) : [];
  if (!Array.isArray(user.releaseNotesSeenIds)) user.releaseNotesSeenIds = [];
  let changed = false;
  for (const id of ids) {
    if (!user.releaseNotesSeenIds.includes(id)) {
      user.releaseNotesSeenIds.push(id);
      changed = true;
    }
  }
  // Cap defensivo: guarda últimos 200 ids.
  if (user.releaseNotesSeenIds.length > 200) {
    user.releaseNotesSeenIds = user.releaseNotesSeenIds.slice(-200);
    changed = true;
  }
  const today = _todayYmd();
  if (user.releaseNotesShownAt !== today) {
    user.releaseNotesShownAt = today;
    changed = true;
  }
  if (changed) saveEntity('users', user);
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  auth.removeToken(req.token);
  res.set('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

/* ─── LOGIN COM DISCORD (OAuth2) ───
   Dois modos:
     login → start público. Callback resolve user por discordId; se existe,
             emite sessão. Se não existe, redireciona pro login com erro
             (nunca cria conta fantasma — cadastro é interno pela equipe).
     link  → start autenticado. Callback grava u.discordId no user logado.
             Rejeita se aquele discordId já pertence a outro user.

   Rate-limit próprio (5 starts/min por IP) — mesmo padrão do /login.
   State CSRF gerenciado no discord-oauth.js (TTL 10min, single-use).
   Redirects sempre pra origem confiável (mesma app), nunca pra URL do query.

   Falhas caem em / ou /profile com ?discord=error&reason=<slug>, e o
   frontend decodifica isso pra mensagem amigável. */
const _discordOAuthAttempts = new Map(); // ip → { count, resetAt }
const rateLimitDiscordOAuth = makeRateLimit(_discordOAuthAttempts, 5, 'tentativas');

app.get('/api/auth/discord/status', (req, res) => {
  res.json({ configured: discordOAuth.isConfigured() });
});

app.get('/api/auth/discord/start', rateLimitDiscordOAuth, (req, res) => {
  if (!discordOAuth.isConfigured()) {
    return res.redirect('/?discord=error&reason=not-configured');
  }
  try {
    const state = discordOAuth.makeState('login', null);
    return res.redirect(discordOAuth.getAuthUrl(state));
  } catch (e) {
    console.error('[discord-oauth/start]', e.message);
    return res.redirect('/?discord=error&reason=' + encodeURIComponent(e.message));
  }
});

app.get('/api/auth/discord/link/start', requireAuth, rateLimitDiscordOAuth, (req, res) => {
  if (!discordOAuth.isConfigured()) {
    return res.redirect('/profile?discord=error&reason=not-configured');
  }
  try {
    const state = discordOAuth.makeState('link', req.user.id, req.query.ret === 'onboarding' ? 'onboarding' : null);
    return res.redirect(discordOAuth.getAuthUrl(state));
  } catch (e) {
    console.error('[discord-oauth/link]', e.message);
    return res.redirect('/profile?discord=error&reason=' + encodeURIComponent(e.message));
  }
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error)  return res.redirect('/?discord=error&reason=' + encodeURIComponent(String(error)));
  if (!code || !state) return res.redirect('/?discord=error&reason=missing-params');
  const entry = discordOAuth.popState(String(state));
  if (!entry) return res.redirect('/?discord=error&reason=invalid-state');

  let profile;
  try {
    profile = await discordOAuth.exchangeCodeForProfile(String(code));
  } catch (e) {
    console.error('[discord-oauth/callback]', e.message);
    const back = entry.mode === 'link' && entry.ret !== 'onboarding' ? '/profile' : '/';
    return res.redirect(back + '?discord=error&reason=' + encodeURIComponent('exchange-failed'));
  }

  if (entry.mode === 'link') {
    const back = entry.ret === 'onboarding' ? '/' : '/profile'; // primeiros passos voltam pro /
    const user = db.users.find(u => u.id === entry.userId && u.active !== false);
    if (!user) return res.redirect('/?discord=error&reason=user-not-found');
    const clash = db.users.find(u => u.id !== user.id && u.discordId === profile.id);
    if (clash) {
      return res.redirect(back + '?discord=error&reason=' + encodeURIComponent('already-linked'));
    }
    user.discordId = profile.id;
    saveEntity('users', user);
    return res.redirect(back + '?discord=linked');
  }

  // mode = 'login' — resolve user por discordId
  const user = db.users.find(u => u.discordId === profile.id && u.active !== false);
  if (!user) {
    return res.redirect('/?discord=error&reason=' + encodeURIComponent('no-account'));
  }
  // Entrar pelo Discord não pede o código da verificação em duas etapas: a
  // conta do Discord já é o segundo fator (decisão de produto).
  recordLoginIp(user, clientIp(req));
  startSession(req, res, user);
  return res.redirect('/?discord=logged-in');
});

/* Desvincula o discordId do próprio usuário. Bloqueia se o user NÃO tem
   senha configurada — desvincular deixaria a conta sem nenhum método de
   login (chave só via Discord). Freelancer sem senha SÓ é criado com
   discord vinculado, então esse guard evita locked-out acidental. */
app.post('/api/me/discord/unlink', requireAuth, (req, res) => {
  const u = req.user;
  if (!u.discordId) return res.json({ ok: true });
  if (!auth.hasPassword(u.id)) {
    return res.status(400).json({
      error: 'Você não tem senha cadastrada — desvincular o Discord te deixaria sem nenhum método de login. Defina uma senha primeiro em "Alterar senha" logo acima, e depois volte aqui.'
    });
  }
  u.discordId = null;
  saveEntity('users', u);
  res.json({ ok: true, user: publicUser(u, { self: true }) });
});

/* ─── ENTRAR COM GOOGLE (OpenID Connect) ───
   Mesmo desenho do Discord: 'login' (start público) e 'link' (start com
   sessão, no Perfil). A conta Google fica em u.googleLogin = { sub, email,
   linkedAt }; o sub é o id fixo da conta Google.
   No login, sem vínculo ainda, vale o e-mail: se o Google diz que o e-mail
   é verificado e ele bate com o e-mail CONFIRMADO de uma conta reWork, o
   vínculo é feito na hora. Nunca cria conta (cadastro é por convite).
   Sem código da verificação em duas etapas (igual ao Discord): a conta
   Google já faz esse papel.
   Falhas voltam pra / ou /profile com ?google-login=error&reason=<slug>. */
const _googleLoginAttempts = new Map(); // ip → { count, resetAt }
const rateLimitGoogleLogin = makeRateLimit(_googleLoginAttempts, 5, 'tentativas');

app.get('/api/auth/google/status', (req, res) => {
  res.json({ configured: googleLogin.isConfigured() });
});

app.get('/api/auth/google/start', rateLimitGoogleLogin, (req, res) => {
  if (!googleLogin.isConfigured()) return res.redirect('/?google-login=error&reason=not-configured');
  try {
    return res.redirect(googleLogin.getAuthUrl(googleLogin.makeState('login', null)));
  } catch (e) {
    console.error('[google-login/start]', e.message);
    return res.redirect('/?google-login=error&reason=start-failed');
  }
});

app.get('/api/auth/google/link/start', requireAuth, rateLimitGoogleLogin, (req, res) => {
  if (!googleLogin.isConfigured()) return res.redirect('/profile?aba=security&google-login=error&reason=not-configured');
  try {
    return res.redirect(googleLogin.getAuthUrl(googleLogin.makeState('link', req.user.id)));
  } catch (e) {
    console.error('[google-login/link]', e.message);
    return res.redirect('/profile?aba=security&google-login=error&reason=start-failed');
  }
});

function googleLoginOwner(sub) {
  return db.users.find(u => u.googleLogin && u.googleLogin.sub === sub) || null;
}

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const entry = state ? googleLogin.popState(String(state)) : null;
  const back = entry && entry.mode === 'link' ? '/profile?aba=security&' : '/?';
  const fail = (reason) => res.redirect(back + 'google-login=error&reason=' + encodeURIComponent(reason));
  // Cancelou na tela do Google: volta sem alarde.
  if (error) return fail(error === 'access_denied' ? 'cancelled' : 'google-error');
  if (!code || !state) return fail('missing-params');
  if (!entry) return fail('invalid-state');

  let profile;
  try {
    profile = await googleLogin.exchangeCodeForProfile(String(code));
  } catch (e) {
    console.error('[google-login/callback]', e.message);
    return fail('exchange-failed');
  }

  if (entry.mode === 'link') {
    const user = db.users.find(u => u.id === entry.userId && u.active !== false);
    if (!user) return fail('user-not-found');
    const owner = googleLoginOwner(profile.sub);
    if (owner && owner.id !== user.id) return fail('already-linked');
    user.googleLogin = { sub: profile.sub, email: profile.email, linkedAt: nowISO() };
    saveEntity('users', user);
    return res.redirect('/profile?aba=security&google-login=linked');
  }

  // mode = 'login': conta já vinculada, senão o e-mail confirmado.
  let user = googleLoginOwner(profile.sub);
  if (user && user.active === false) user = null;
  if (!user && profile.email && profile.emailVerified) {
    const matches = db.users.filter(u => u.active !== false && emailLinked(u) && normEmail(u.email) === profile.email && !(u.googleLogin && u.googleLogin.sub));
    if (matches.length > 1) return fail('ambiguous');
    if (matches.length === 1) {
      user = matches[0];
      user.googleLogin = { sub: profile.sub, email: profile.email, linkedAt: nowISO() };
      saveEntity('users', user);
    }
  }
  if (!user) return fail('no-account');
  if (!tenancy.activeMemberships(user.id).length) {
    const closed = tenancy.membershipsOf(user.id).some(m => m.active !== false && !tenancy.orgActive(m.orgId));
    return fail(closed ? 'org-closed' : 'no-access');
  }
  // Como no Discord, entrar pelo Google não pede o código da verificação em
  // duas etapas: a própria conta Google faz esse papel.
  recordLoginIp(user, clientIp(req));
  startSession(req, res, user);
  return res.redirect('/?google-login=logged-in');
});

/* Desvincula a conta Google. Sem senha (e sem Discord), a pessoa ficaria
   sem como entrar: pede pra definir uma senha antes. */
app.post('/api/me/google-login/unlink', requireAuth, (req, res) => {
  const u = req.user;
  if (!u.googleLogin) return res.json({ ok: true, user: publicUser(u, { self: true }) });
  if (!auth.hasPassword(u.id) && !u.discordId) {
    return res.status(400).json({ error: 'Sua conta não tem senha: desvincular o Google te deixaria sem como entrar. Defina uma senha primeiro.' });
  }
  delete u.googleLogin;
  saveEntity('users', u);
  res.json({ ok: true, user: publicUser(u, { self: true }) });
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
  const { subject, html, text } = emailTpl.resetPassword({ name: user.name, link, baseUrl });
  setImmediate(() => sendEmail(user.email, subject, html, text));
  res.json({ ok: true });
});
app.post('/api/reset-password', rateLimitPwReset, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || typeof newPassword !== 'string') return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
  if (newPassword.length < PASSWORD_MIN) return res.status(400).json({ error: `A nova senha deve ter pelo menos ${PASSWORD_MIN} caracteres.` });
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

/* ─── VÍNCULO DE E-MAIL ───
   Vincular, confirmar o atual ou trocar: o link vai pro endereço (novo) e o
   e-mail da conta só muda quando a pessoa abre o link. Trocar pede a senha;
   confirmar o e-mail que já está na conta, não. O token só existe no link —
   guardamos o SHA-256. */
const rateLimitEmailLink = makeRateLimit(new Map(), 6, 'envios', req => 'u:' + (req.user?.id || clientIp(req)), 60 * 60 * 1000);
app.post('/api/me/email', requireAuth, rateLimitEmailLink, async (req, res) => {
  const u = req.user;
  const { email, password } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Confira o e-mail. Ele precisa ter o formato nome@empresa.com.', field: 'email' });
  const next = normEmail(email);
  const current = normEmail(u.email);
  if (next === current && emailLinked(u)) return res.status(400).json({ error: 'Esse já é o e-mail confirmado da sua conta.', field: 'email' });
  const isChange = !!current && next !== current;
  // Confirmar o próprio e-mail atual dispensa a senha; vincular/trocar, não.
  // Conta sem senha (entra só pelo Discord): a sessão já é a prova de quem é.
  if (next !== current && auth.hasPassword(u.id)) {
    if (!auth.verifyPassword(u.id, password)) return res.status(400).json({ error: 'Senha incorreta.', field: 'password' });
  }
  if (userByEmail(next, u.id)) return res.status(409).json({ error: 'Esse e-mail já está em outra conta do reWork. Use outro ou peça ajuda ao suporte.', field: 'email' });
  if (!mailEnabled()) return res.status(503).json({ error: 'O envio de e-mails não está ativo no servidor. Fale com um administrador.' });
  const token = crypto.randomBytes(24).toString('base64url');
  u.emailChange = { email: next, tokenHash: auth.hashToken(token), expiresAt: new Date(Date.now() + EMAIL_CONFIRM_TTL_MS).toISOString(), sentAt: nowISO() };
  saveEntity('users', u);
  const baseUrl = appBaseUrl(req);
  const mail = emailTpl.emailConfirm({ name: u.name, email: next, link: `${baseUrl}/confirmar-email/${token}`, baseUrl, isChange });
  const sent = await sendEmail(next, mail.subject, mail.html, mail.text);
  // Troca de um e-mail já confirmado: avisa o endereço antigo.
  if (isChange && emailLinked(u)) {
    const n = emailTpl.emailChangeNotice({ name: u.name, newEmail: next, baseUrl });
    setImmediate(() => sendEmail(u.email, n.subject, n.html, n.text));
  }
  if (!sent || !sent.sent) return res.status(502).json({ error: 'Não conseguimos enviar o e-mail agora. Tente de novo em alguns minutos.' });
  res.json({ ok: true, user: publicUser(u, { self: true }) });
});
app.post('/api/me/email/cancel', requireAuth, (req, res) => {
  if (req.user.emailChange) { delete req.user.emailChange; saveEntity('users', req.user); }
  res.json({ ok: true, user: publicUser(req.user, { self: true }) });
});
/* Público: o link do e-mail. Não precisa estar logado (pode abrir em outro
   aparelho) — o token prova que a pessoa recebeu no endereço. */
const rateLimitEmailConfirm = makeRateLimit(new Map(), 20, 'tentativas');
app.post('/api/email/confirm', rateLimitEmailConfirm, (req, res) => {
  const token = String((req.body || {}).token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(400).json({ error: 'Link inválido. Confira se ele veio completo.' });
  const h = auth.hashToken(token);
  const u = allUsers().find(x => x.emailChange && x.emailChange.tokenHash === h);
  if (!u) return res.status(410).json({ error: 'Este link já foi usado ou foi substituído por um mais novo.' });
  if (Date.parse(u.emailChange.expiresAt) <= Date.now()) return res.status(410).json({ error: 'Este link venceu (vale 24 horas). Peça um novo no seu perfil.' });
  const next = u.emailChange.email;
  if (userByEmail(next, u.id)) return res.status(409).json({ error: 'Esse e-mail acabou de ser vinculado a outra conta. Use outro endereço.' });
  u.email = next;
  u.emailVerifiedAt = nowISO();
  delete u.emailChange;
  saveEntity('users', u);
  res.json({ ok: true, email: next, name: u.name });
});

app.get('/api/me', requireAuth, (req, res) => {
  const me = publicUser(req.user, { self: true });
  // A aba abriu numa organização (URL): ela vira a "última usada" — é pra lá
  // que vão os links sem organização e as abas novas.
  const sess = auth.sessionForToken(req.token);
  if (sess && (!sess.data || sess.data.orgId !== req.org.id)) {
    auth.setSessionData(req.token, { orgId: req.org.id });
    if (req.user.lastOrgId !== req.org.id) { req.user.lastOrgId = req.org.id; saveEntity('users', req.user); }
  }
  if (me) {
    me._smtpEnabled = mailEnabled();
    me.org = orgPublic(req.org, req.membership.role);
    me.orgs = myOrgs(req.user);
  }
  res.json(me);
});

app.put('/api/me', requireAuth, (req, res) => {
  const { name, role, avatar, currentPassword, newPassword, username, discordId, email, emailPrefs, discord, phone, discordPrefs, quickReplies, accentTheme, away, status, digestSchedule, navMenu } = req.body || {};
  const u = req.user;
  if (typeof name === 'string' && name.trim()) u.name = name.trim();
  if (typeof role === 'string') u.role = role.trim();
  // Nome de usuário do Discord — puramente pra exibição no mini-card (não é o
  // snowflake ID, que fica em `discordId` e é usado pela integração de bot).
  // Aceita @usuario, usuario#0000, ou usuario — normalizamos só truncando.
  if (discord !== undefined) {
    const raw = (discord === null ? '' : String(discord)).trim().slice(0, 40);
    u.discord = raw || null;
  }
  // Telefone — só string, sem validação estrita (formatos internacionais variam).
  if (phone !== undefined) {
    const raw = (phone === null ? '' : String(phone)).trim().slice(0, 30);
    u.phone = raw || null;
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
  // E-mail só muda pelo fluxo com senha + link de confirmação (/api/me/email).
  if (email !== undefined && normEmail(email) !== normEmail(u.email)) {
    return res.status(400).json({ error: 'Para vincular ou trocar o e-mail, use "Trocar e-mail" no perfil: pedimos a sua senha e mandamos um link de confirmação.', field: 'email' });
  }
  if (emailPrefs && typeof emailPrefs === 'object') {
    const prev = u.emailPrefs || defaultEmailPrefs();
    const next = { ...prev };
    for (const k of Object.keys(EMAIL_EVENT_LABELS)) {
      if (typeof emailPrefs[k] === 'boolean') next[k] = emailPrefs[k];
    }
    u.emailPrefs = next;
  }
  // discordPrefs — parcial: chaves undefined caem no admin default. null explícito
  // remove o override daquela chave (volta a usar o default do time).
  if (discordPrefs && typeof discordPrefs === 'object') {
    const prev = u.discordPrefs || {};
    const next = { ...prev };
    for (const k of Object.keys(DISCORD_EVENT_LABELS)) {
      if (discordPrefs[k] === null) delete next[k];
      else if (typeof discordPrefs[k] === 'boolean') next[k] = discordPrefs[k];
    }
    u.discordPrefs = next;
  }
  if (typeof username === 'string' && username.trim()) {
    const trimmed = username.trim().toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(trimmed)) return res.status(400).json({ error: 'Usuário deve conter apenas letras, números, pontos, hífens e underlines' });
    if (trimmed.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });
    if (allUsers().some(x => x.id !== u.id && x.username.toLowerCase() === trimmed)) return res.status(409).json({ error: 'Esse nome de usuário já está em uso' });
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
    if (String(newPassword).length < PASSWORD_MIN) {
      return res.status(400).json({ error: `A nova senha deve ter pelo menos ${PASSWORD_MIN} caracteres` });
    }
    auth.setPassword(u.id, newPassword);
    // Troca de senha encerra as outras sessões (fica só esta).
    auth.dropTokensFor(u.id, req.token);
  }
  // Tema de cor (cor de destaque). null/'' = roxo padrão.
  if (accentTheme !== undefined) {
    const a = String(accentTheme || '');
    if (a && !['azul', 'ciano', 'rosa', 'laranja', 'grafite'].includes(a)) return res.status(400).json({ error: 'Tema de cor inválido' });
    u.accentTheme = a || null;
  }
  // Ausência (férias/folga). null = volta a estar disponível.
  if (away !== undefined) {
    if (!away) u.away = null;
    else {
      const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
      const from = ymd(away.from), to = ymd(away.to);
      if (!from || !to) return res.status(400).json({ error: 'Informe as datas de saída e de volta' });
      if (to < from) return res.status(400).json({ error: 'A data final não pode ser antes da inicial' });
      if (to < today()) return res.status(400).json({ error: 'O período já terminou' });
      if (to > addDays(today(), 366)) return res.status(400).json({ error: 'Período máximo de um ano' });
      const subId = away.substituteId ? String(away.substituteId) : null;
      if (subId && (subId === u.id || !db.users.some(x => x.id === subId && x.active !== false))) {
        return res.status(400).json({ error: 'Substituto inválido' });
      }
      u.away = { from, to, substituteId: subId };
    }
  }
  // Status pessoal (Focado / Em reunião / texto livre). null = limpa.
  if (status !== undefined) {
    if (!status) u.status = null;
    else {
      const kind = String(status.kind || '');
      if (!STATUS_KINDS.includes(kind)) return res.status(400).json({ error: 'Status inválido' });
      const text = kind === 'custom' ? String(status.text || '').trim().slice(0, 60) : null;
      if (kind === 'custom' && !text) return res.status(400).json({ error: 'Escreva o status' });
      let until = null;
      if (status.until) {
        const t = Date.parse(status.until);
        if (!Number.isFinite(t) || t <= Date.now()) return res.status(400).json({ error: 'O horário de término já passou' });
        if (t > Date.now() + 7 * 864e5) return res.status(400).json({ error: 'Duração máxima de 7 dias' });
        until = new Date(t).toISOString();
      }
      u.status = { kind, text, until, since: nowISO() };
    }
    // Saiu do foco: solta o que ficou segurado.
    if (!isFocused(u) && Array.isArray(u.heldNotifs) && u.heldNotifs.length) setImmediate(() => flushHeldNotifications(u));
  }
  // Horário do resumo diário. null = volta pro padrão (dias úteis, 8h).
  if (digestSchedule !== undefined) {
    if (!digestSchedule) u.digestSchedule = null;
    else {
      const hour = Number(digestSchedule.hour);
      if (!Number.isInteger(hour) || hour < 5 || hour > 22) return res.status(400).json({ error: 'Horário inválido' });
      const days = [...new Set((Array.isArray(digestSchedule.days) ? digestSchedule.days : []).map(Number))]
        .filter(x => Number.isInteger(x) && x >= 0 && x <= 6).sort((a, b) => a - b);
      if (!days.length) return res.status(400).json({ error: 'Escolha pelo menos um dia' });
      u.digestSchedule = { hour, days };
    }
  }
  // Respostas prontas dos comentários: lista de textos curtos (null = volta
  // pras sugestões padrão do cliente).
  if (quickReplies !== undefined) {
    u.quickReplies = Array.isArray(quickReplies)
      ? quickReplies.map(t => String(t || '').trim().slice(0, 500)).filter(Boolean).slice(0, 30)
      : null;
  }
  // Menu lateral personalizado: chaves de página, na ordem (null = menu padrão).
  // O cliente ignora chaves que não conhece ou que a pessoa não pode ver.
  if (navMenu !== undefined) {
    u.navMenu = Array.isArray(navMenu)
      ? [...new Set(navMenu.map(String))].filter(k => /^[a-zA-Z]{1,40}$/.test(k)).slice(0, 40)
      : null;
  }
  saveEntity('users', u);
  res.json(publicUser(u, { self: true }));
});

/* Ping de presença — cliente bate de minuto em minuto. Não loga histórico,
   apenas atualiza lastSeen pra que outros usuários vejam o dot verde. */
// Buckets de 5min por userId — cada ping marca o bucket atual. Só em memória,
// serve pra derivar "tempo ativo na semana" (nº de buckets * 5min).
const _activityBuckets = new Map(); // userId → Set<bucketNumber>
const ACTIVITY_BUCKET_MS = 5 * 60 * 1000;
function _touchActivityBucket(userId) {
  const bucket = Math.floor(Date.now() / ACTIVITY_BUCKET_MS);
  let set = _activityBuckets.get(userId);
  if (!set) { set = new Set(); _activityBuckets.set(userId, set); }
  set.add(bucket);
}
function _activeMinutesInWindow(userId, ms) {
  const set = _activityBuckets.get(userId);
  if (!set || !set.size) return 0;
  const minBucket = Math.floor((Date.now() - ms) / ACTIVITY_BUCKET_MS);
  let count = 0;
  for (const b of set) {
    if (b >= minBucket) count++;
  }
  return count * 5;
}
// Poda buckets velhos a cada 30min pra não vazar memória.
setInterval(() => {
  const cutoff = Math.floor((Date.now() - 8 * 24 * 60 * 60 * 1000) / ACTIVITY_BUCKET_MS);
  for (const [uid, set] of _activityBuckets) {
    for (const b of set) if (b < cutoff) set.delete(b);
    if (!set.size) _activityBuckets.delete(uid);
  }
}, 30 * 60 * 1000);

app.post('/api/me/ping', requireAuth, (req, res) => {
  req.user.lastSeen = nowISO();
  _touchActivityBucket(req.user.id);
  saveEntity('users', req.user);
  res.json({ ok: true, lastSeen: req.user.lastSeen });
});

app.post('/api/me/email/test', requireAuth, async (req, res) => {
  if (!mailEnabled()) return res.status(503).json({ error: 'SMTP não configurado no servidor. Defina as variáveis SMTP_HOST, SMTP_USER, SMTP_PASS antes de testar.' });
  if (!req.user.email) return res.status(400).json({ error: 'Cadastre um e-mail no seu perfil antes de testar.' });
  const t = emailTpl.testEmail({ name: req.user.name, baseUrl: appBaseUrl(req) });
  const result = await sendEmail(req.user.email, t.subject, t.html, t.text);
  if (!result.sent) return res.status(502).json({ error: 'Falha ao enviar: ' + (result.reason || 'erro desconhecido') });
  res.json({ ok: true });
});

/* ── PRÉ-VISUALIZAÇÃO DOS E-MAILS (admin) ──
   Galeria com todos os modelos preenchidos com dados de exemplo. Relê o
   email-templates.js a cada acesso: editou o visual, dá F5 — sem reiniciar. */
function _freshEmailTpl() {
  const file = require.resolve('./email-templates');
  delete require.cache[file];
  return require('./email-templates');
}
function _emailPreviewSamples(req) {
  return _freshEmailTpl().previewSamples(appBaseUrl(req), req.user);
}
app.get('/api/admin/email-preview', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Apenas administradores.');
  let samples;
  try { samples = _emailPreviewSamples(req).map(x => ({ key: x.key, label: x.label, subject: x.build().subject })); }
  catch (e) { return res.status(500).type('text/plain').send('Erro no email-templates.js:\n\n' + (e.stack || e.message)); }
  const cards = samples.map(x => `
    <section class="card" id="${escHtml(x.key)}">
      <header>
        <div><strong>${escHtml(x.label)}</strong><span>${escHtml(x.subject)}</span></div>
        <nav>
          <a href="/api/admin/email-preview/${encodeURIComponent(x.key)}" target="_blank">Abrir sozinho</a>
          <button onclick="sendMe('${escHtml(x.key)}', this)">Enviar pra mim</button>
        </nav>
      </header>
      <iframe src="/api/admin/email-preview/${encodeURIComponent(x.key)}?scheme=light" loading="lazy" onload="fit(this)"></iframe>
    </section>`).join('');
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>E-mails · reWork</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;background:#18181b;color:#e4e4e7;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .top{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 20px;background:#18181bee;border-bottom:1px solid #27272a}
  .top h1{font-size:15px;margin:0 auto 0 0}
  .top small{color:#a1a1aa}
  .seg{display:flex;border:1px solid #3f3f46;border-radius:8px;overflow:hidden}
  .seg button{background:none;border:0;color:#a1a1aa;padding:6px 12px;cursor:pointer;font:inherit}
  .seg button.on{background:#7A00FF;color:#fff}
  main{display:flex;flex-direction:column;align-items:center;gap:28px;padding:24px 16px 60px}
  .card{width:100%;max-width:var(--w,720px);transition:max-width .2s}
  .card header{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:flex-end;margin-bottom:8px}
  .card header span{display:block;color:#a1a1aa;font-size:12px;margin-top:2px}
  .card nav{display:flex;gap:8px}
  .card nav a,.card nav button{font:inherit;font-size:12px;color:#d4d4d8;background:#27272a;border:1px solid #3f3f46;border-radius:6px;padding:5px 10px;text-decoration:none;cursor:pointer}
  .card nav button:disabled{opacity:.6;cursor:default}
  iframe{display:block;width:100%;height:400px;border:1px solid #27272a;border-radius:10px;background:transparent}
</style></head><body>
<div class="top">
  <h1>Pré-visualização dos e-mails <small>· edite email-templates.js e dê F5</small></h1>
  <div class="seg" id="w">
    <button data-w="720" class="on">Desktop</button><button data-w="390">Celular</button>
  </div>
  <div class="seg" id="scheme">
    <button data-s="light" class="on">Claro</button><button data-s="dark">Escuro</button>
  </div>
</div>
<main>${cards}</main>
<script>
  function fit(f){try{f.style.height='0px';f.style.height=f.contentDocument.documentElement.scrollHeight+'px'}catch(e){}}
  document.getElementById('w').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    document.querySelectorAll('#w button').forEach(x=>x.classList.toggle('on',x===b));
    document.documentElement.style.setProperty('--w',b.dataset.w+'px');
    setTimeout(()=>document.querySelectorAll('iframe').forEach(fit),250);
  });
  document.getElementById('scheme').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    document.querySelectorAll('#scheme button').forEach(x=>x.classList.toggle('on',x===b));
    document.querySelectorAll('iframe').forEach(f=>{f.src=f.src.split('?')[0]+'?scheme='+b.dataset.s});
  });
  async function sendMe(key,btn){
    btn.disabled=true;const old=btn.textContent;btn.textContent='Enviando…';
    try{
      const r=await fetch('/api/admin/email-preview/'+encodeURIComponent(key)+'/send',{method:'POST',credentials:'same-origin'});
      const j=await r.json().catch(()=>({}));
      btn.textContent=r.ok?'Enviado pra '+j.to:(j.error||'Falhou');
    }catch(e){btn.textContent='Falhou'}
    setTimeout(()=>{btn.textContent=old;btn.disabled=false},4000);
  }
</script></body></html>`);
});
app.get('/api/admin/email-preview/:key', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Apenas administradores.');
  let sample;
  try { sample = _emailPreviewSamples(req).find(x => x.key === req.params.key); }
  catch (e) { return res.status(500).type('text/plain').send(e.stack || e.message); }
  if (!sample) return res.status(404).send('Modelo não encontrado');
  // Força o tema na prévia (sem isso seguiria o tema do sistema operacional).
  const scheme = req.query.scheme === 'dark' ? 'dark' : req.query.scheme === 'light' ? 'light' : null;
  const html = sample.build().html;
  res.type('html').send(scheme ? html.replace('<html', `<html data-rw-scheme="${scheme}"`) : html);
});
// Prévia do sistema de movimento (motion-preview.html). Lido do disco a cada
// request e com o style.css sem cache: editou o CSS, F5 mostra o novo.
app.get('/api/admin/motion-preview', requireAuth, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Apenas administradores.');
  fs.readFile(path.join(__dirname, 'motion-preview.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).type('text/plain').send(err.message);
    // O confete da prévia é a função real do app.js, recortada pelo nome e
    // pelo par de chaves (funciona também no app.js minificado de produção,
    // que mantém os nomes globais), pra prévia nunca divergir da plataforma.
    let confetti = '';
    try {
      const js = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf8');
      const a = js.indexOf('function spawnConfetti(');
      const open = a >= 0 ? js.indexOf('{', js.indexOf(')', a)) : -1;
      if (open > 0) {
        let depth = 0;
        for (let i = open; i < js.length; i++) {
          if (js[i] === '{') depth++;
          else if (js[i] === '}' && --depth === 0) { confetti = js.slice(a, i + 1); break; }
        }
      }
    } catch {}
    res.set('Cache-Control', 'no-store').type('html')
      .send(html.replace('__TS__', Date.now()).replace('/*__CONFETTI_JS__*/', () => confetti));
  });
});
app.post('/api/admin/email-preview/:key/send', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Apenas administradores' });
  if (!mailEnabled()) return res.status(503).json({ error: 'SMTP não configurado' });
  if (!req.user.email) return res.status(400).json({ error: 'Cadastre seu e-mail no perfil' });
  const sample = _emailPreviewSamples(req).find(x => x.key === req.params.key);
  if (!sample) return res.status(404).json({ error: 'Modelo não encontrado' });
  const b = sample.build();
  const r = await sendEmail(req.user.email, '[Prévia] ' + b.subject, b.html, b.text || b.subject);
  if (!r.sent) return res.status(502).json({ error: 'Falha: ' + (r.reason || 'erro') });
  res.json({ ok: true, to: req.user.email });
});

/* ── DISCORD BOT (integração híbrida com webhooks) ──
   Bot serve pra 3 coisas complementares aos webhooks:
     1) Resolver discordId → username (mini-card de contato)
     2) Enviar DM privada de notificações (opt-in por evento)
     3) [futuro] slash commands
   Habilitação: env DISCORD_BOT_TOKEN. Sem token, os endpoints ainda
   existem mas retornam 503 (cliente detecta e esconde a UI). */

// Resolve discordId → { username, global_name, avatar_url }. Cache 24h.
app.get('/api/discord/user/:id', requireAuth, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  const id = String(req.params.id || '').trim();
  if (!/^\d{15,22}$/.test(id)) return res.status(400).json({ error: 'ID inválido.' });
  const data = await discordBot.getUser(id);
  if (!data) return res.status(404).json({ error: 'Usuário não encontrado ou bot sem acesso.' });
  res.json(data);
});

// Config: retorna se o bot tá habilitado, defaults do admin e prefs do próprio user.
app.get('/api/discord/config', requireAuth, (req, res) => {
  res.json({
    enabled: discordBot.isEnabled(),
    labels: DISCORD_EVENT_LABELS,
    adminDefaults: getAdminDiscordDefaults(),
    userPrefs: req.user.discordPrefs || {},
  });
});

// Admin edita os defaults do time (KV). Não afeta users que já personalizaram.
app.put('/api/discord/admin-defaults', requireAuth, adminOnly, async (req, res) => {
  const body = req.body || {};
  await saveAdminDiscordDefaults(body);
  res.json({ ok: true, adminDefaults: getAdminDiscordDefaults() });
});

// Apaga TODAS as mensagens que o bot enviou nas DMs com o próprio user.
// Discord não expõe delete no menu de DM (bot != usuário) — este endpoint
// faz por API. Rate-limited a ~4/s. Retorna { deleted, scanned }.
app.post('/api/me/discord/clear-dms', requireAuth, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  if (!req.user.discordId) return res.status(400).json({ error: 'Cadastre seu ID do Discord no perfil antes.' });
  const result = await discordBot.clearBotDMs(req.user.discordId);
  if (result.error) return res.status(502).json({ error: 'Falha ao limpar DMs: ' + result.error });
  res.json(result);
});

// Dispara o resumo diário na DM do próprio user AGORA (ignora hora/idempotência).
// Usa `sendDiscordDMDigestForUser` — mesma função do cron das 8h.
app.post('/api/me/discord/digest', requireAuth, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  if (!req.user.discordId) return res.status(400).json({ error: 'Cadastre seu ID do Discord no perfil antes.' });
  const result = await sendDiscordDMDigestForUser(req.user);
  if (result === 'empty') return res.json({ ok: false, note: 'Nada pra reportar hoje (nenhuma atrasada, nada vencendo hoje/próximos 3 dias, sem notif não lida). Comportamento normal — evita DM diária vazia.' });
  if (!result) return res.status(502).json({ error: 'O Discord recusou a mensagem. Confira se você aceita mensagens diretas de membros do servidor e se o seu ID do Discord está certo.' });
  res.json({ ok: true });
});

// Envia um DM de teste pro próprio user — pra validar setup (discordId + bot).
app.post('/api/me/discord/test', requireAuth, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado no servidor.' });
  if (!req.user.discordId) return res.status(400).json({ error: 'Cadastre seu ID do Discord no perfil antes de testar.' });
  const ok = await discordBot.sendDM(req.user.discordId, {
    embeds: [{
      title: '✅ reWork conectado',
      description: `Olá, **${req.user.name}**! Este é um teste do canal de DM do bot reWork.\n\nA partir de agora você pode receber notificações privadas aqui.`,
      color: 0x7A00FF,
      footer: { text: 'reWork' },
    }],
  });
  if (!ok) return res.status(502).json({ error: 'Falha ao enviar DM. Provavelmente o bot ainda não está no seu servidor Discord (sem guild em comum, o Discord bloqueia DM por spam). Convide o bot pelo OAuth2 URL Generator no Developer Portal (scope: bot). Também verifique que você permite DMs de membros do server (Configurações do Discord → Privacidade e Segurança).' });
  res.json({ ok: true });
});

/* ── DISCORD BOT — client-channel bindings ──
   Admin escolhe cliente → guild+canal → quais eventos disparam.
   Bindings persistidos em `discordChannels`. Cache dos guilds/canais é
   in-memory no bot helper (5min TTL). */

// Lista os guilds em que o bot está — pra popular o dropdown na UI.
app.get('/api/discord/guilds', requireAuth, adminOnly, installationOrgOnly, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  const guilds = await discordBot.listGuilds();
  res.json(guilds);
});

// Canais de texto de um guild — dropdown do canal na UI.
app.get('/api/discord/guilds/:guildId/channels', requireAuth, adminOnly, installationOrgOnly, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  const channels = await discordBot.listGuildChannels(req.params.guildId);
  res.json(channels);
});

// Lista bindings (todos podem ver — pra render de badge no card do cliente
// no futuro; admin gerencia). Enriquece com nome do cliente e do canal.
// Strip `webhookToken` das respostas — é secret, cliente só precisa saber
// se tem persona ativa (via `hasWebhook`). Reduz superfície se localStorage
// ou cookie vaza.
function publicBinding(b) {
  const { webhookToken, ...rest } = b;
  return { ...rest, hasWebhook: !!webhookToken };
}

app.get('/api/discord/client-channels', requireAuth, (req, res) => {
  const binds = (db.discordChannels || []).map(publicBinding);
  res.json(binds);
});

app.post('/api/discord/client-channels', requireAuth, adminOnly, installationOrgOnly, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  const { clientId, guildId, channelId, channelName, events, active } = req.body || {};
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return res.status(400).json({ error: 'Cliente inválido.' });
  if (!guildId || !/^\d{15,22}$/.test(String(guildId))) return res.status(400).json({ error: 'Guild ID inválido.' });
  if (!channelId || !/^\d{15,22}$/.test(String(channelId))) return res.status(400).json({ error: 'Channel ID inválido.' });
  if (!Array.isArray(events) || !events.length) return res.status(400).json({ error: 'Escolha ao menos 1 evento.' });
  const validEvents = events.filter(e => WEBHOOK_EVENTS[e]);
  if (!validEvents.length) return res.status(400).json({ error: 'Eventos inválidos.' });
  // Cria webhook no canal pra habilitar persona por cliente (username +
  // avatar_url por mensagem). Falha silenciosa: se bot não tem
  // MANAGE_WEBHOOKS, binding ainda é criado mas envia como identidade do bot.
  const hook = await discordBot.createChannelWebhook(channelId, `reWork · ${client.name}`);
  const b = {
    id: uid(),
    clientId,
    guildId: String(guildId),
    channelId: String(channelId),
    channelName: channelName || null,
    events: validEvents,
    active: active !== false,
    webhookId: hook?.id || null,
    webhookToken: hook?.token || null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    lastTriggered: null,
    lastStatus: null,
    lastError: hook ? null : 'Bot sem permissão MANAGE_WEBHOOKS — persona do cliente indisponível, mensagens vão como bot.',
  };
  if (!Array.isArray(db.discordChannels)) db.discordChannels = [];
  db.discordChannels.push(b);
  saveEntity('discordChannels', b);
  res.status(201).json(publicBinding(b));
});

app.put('/api/discord/client-channels/:id', requireAuth, adminOnly, async (req, res) => {
  const b = (db.discordChannels || []).find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Binding não encontrado.' });
  const { clientId, guildId, channelId, channelName, events, active } = req.body || {};
  const oldChannelId = b.channelId;
  if (clientId !== undefined) {
    if (!db.clients.some(c => c.id === clientId)) return res.status(400).json({ error: 'Cliente inválido.' });
    b.clientId = clientId;
  }
  if (guildId !== undefined) {
    if (!/^\d{15,22}$/.test(String(guildId))) return res.status(400).json({ error: 'Guild ID inválido.' });
    b.guildId = String(guildId);
  }
  if (channelId !== undefined) {
    if (!/^\d{15,22}$/.test(String(channelId))) return res.status(400).json({ error: 'Channel ID inválido.' });
    b.channelId = String(channelId);
  }
  if (channelName !== undefined) b.channelName = channelName || null;
  if (Array.isArray(events)) {
    const valid = events.filter(e => WEBHOOK_EVENTS[e]);
    if (!valid.length) return res.status(400).json({ error: 'Escolha ao menos 1 evento.' });
    b.events = valid;
  }
  if (typeof active === 'boolean') b.active = active;
  // Se o canal mudou, recria o webhook (o antigo fica órfão no canal antigo
  // — deletamos ele) porque webhook é vinculado ao canal.
  if (b.channelId !== oldChannelId) {
    if (b.webhookId && b.webhookToken) {
      discordBot.deleteChannelWebhook(b.webhookId, b.webhookToken).catch(() => {});
    }
    const client = db.clients.find(c => c.id === b.clientId);
    const hook = await discordBot.createChannelWebhook(b.channelId, `reWork · ${client?.name || 'Kastor'}`);
    b.webhookId = hook?.id || null;
    b.webhookToken = hook?.token || null;
    b.lastError = hook ? null : 'Bot sem permissão MANAGE_WEBHOOKS no novo canal — mensagens vão como bot.';
  }
  b.updatedAt = nowISO();
  saveEntity('discordChannels', b);
  res.json(publicBinding(b));
});

app.delete('/api/discord/client-channels/:id', requireAuth, adminOnly, (req, res) => {
  const idx = (db.discordChannels || []).findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Binding não encontrado.' });
  const [removed] = db.discordChannels.splice(idx, 1);
  // Cleanup do webhook criado no Discord — fire-and-forget, se falhar tudo bem
  // (usuário pode remover manualmente na config do canal).
  if (removed.webhookId && removed.webhookToken) {
    discordBot.deleteChannelWebhook(removed.webhookId, removed.webhookToken).catch(() => {});
  }
  removeEntity('discordChannels', removed.id);
  res.json({ ok: true });
});

// Envia uma mensagem de teste pro canal do binding — usado pelo botão
// "Testar canal" na UI. Rota admin, dispara embed simples.
app.post('/api/discord/client-channels/:id/test', requireAuth, adminOnly, async (req, res) => {
  if (!discordBot.isEnabled()) return res.status(503).json({ error: 'Discord bot não configurado.' });
  const b = (db.discordChannels || []).find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Binding não encontrado.' });
  const client = db.clients.find(c => c.id === b.clientId);
  const baseUrl = appBaseUrl(req);
  // Mesma lógica do triggerBotChannelBindings — rota pública sem auth.
  const avatarUrl = (client?.avatar && baseUrl)
    ? (/^https?:\/\//i.test(client.avatar)
        ? client.avatar
        : `${baseUrl.replace(/\/+$/, '')}/api/public/client-avatar/${client.id}?v=${_avatarVersion(client.avatar)}`)
    : null;
  const testEmbed = {
    embeds: [{
      title: '✅ Canal conectado ao reWork',
      description: `Notificações sobre o cliente **${client?.name || '—'}** vão aparecer aqui.`,
      color: 0x7A00FF,
      fields: [{ name: 'Eventos', value: b.events.join(', ') || '—', inline: false }],
      footer: { text: 'reWork' },
      timestamp: new Date().toISOString(),
    }],
  };
  let ok = false;
  if (b.webhookId && b.webhookToken) {
    // Envia com a persona do cliente
    const persona = { ...testEmbed, username: client?.name || 'reWork', ...(avatarUrl ? { avatar_url: avatarUrl } : {}) };
    ok = await discordBot.sendViaWebhook(b.webhookId, b.webhookToken, persona);
  } else {
    ok = await discordBot.sendChannelMessage(b.channelId, testEmbed);
  }
  b.lastTriggered = nowISO();
  b.lastStatus = ok ? 200 : 0;
  b.lastError = ok ? null : 'Falha ao enviar (bot sem permissão no canal ou webhook expirou).';
  saveEntity('discordChannels', b);
  if (!ok) return res.status(502).json({ error: 'Falha ao enviar. Verifique que o bot tem permissão no canal.' });
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
    const state = googleCal.makeState(req.user.id, req.query.ret === 'onboarding' ? 'onboarding' : null);
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
  const entry = state ? googleCal.popState(String(state)) : null;
  // Conexão iniciada nos primeiros passos volta pra lá (a tela abre no /).
  const back = entry && entry.ret === 'onboarding' ? '/' : '/profile';
  if (error) return res.redirect(back + '?google=error&reason=' + encodeURIComponent(error));
  if (!code || !state) return res.redirect(back + '?google=error&reason=missing-params');
  if (!entry) return res.redirect(back + '?google=error&reason=invalid-state');
  const user = db.users.find(u => u.id === entry.userId);
  if (!user) return res.redirect(back + '?google=error&reason=user-not-found');
  try {
    const tokens = await googleCal.exchangeCode(String(code));
    if (!tokens.refresh_token) {
      // Google só dá refresh_token na primeira autorização (ou com prompt=consent
      // + access_type=offline, que já pedimos). Se ainda assim não veio, algo tá
      // errado — abortamos.
      return res.redirect(back + '?google=error&reason=no-refresh-token');
    }
    const account = await googleCal.getUserInfo(tokens);
    // Fetch inicial dos calendários — permite escolher já ao concluir a conexão.
    const calendars = await googleCal.listCalendars(tokens);
    user.googleTokens = tokens;
    user.googleAccount = account;
    // Auto-seleciona só o primary — outros ficam disponíveis pra o usuário marcar.
    user.googleCalendars = calendars.map(c => ({ ...c, selected: c.primary }));
    saveEntity('users', user);
    res.redirect(back + '?google=connected');
  } catch (e) {
    console.error('[google/callback]', e);
    res.redirect(back + '?google=error&reason=' + encodeURIComponent(e.message || 'unknown'));
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
    if (!accessibleWs.includes(wsId)) return res.status(403).json({ error: 'Equipe fora do escopo' });
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

/* Retorna versão "leve" da demanda pra listas/dashboard/analytics — remove
   os campos que só são exibidos na página de detalhe (rich text, comments,
   anexos, briefing, history). Cliente re-hidrata com GET /api/demands/:id
   quando o user abre a demanda (showDetail → refreshDetailDemand). */
function stripDemandForList(d) {
  const { description, comments, attachments, briefing, history, ...rest } = d;
  return { ...rest, lastOwnerId: lastOwnerIdOf(d) };
}

/* Etapa final (Concluída/Cancelada) limpa o ownerId, mas listas e exportação
   ainda precisam saber quem foi o último responsável — vem do histórico. */
function lastOwnerIdOf(d) {
  if (d.ownerId) return d.ownerId;
  const h = Array.isArray(d.history) ? d.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const { action, details } = h[i];
    if (!details || !/^owner_/.test(action)) continue;
    const id = details.toId || details.fromId || details.ownerId;
    if (id) return id;
  }
  return null;
}

/* ── Conversão PPTX/DOCX/XLSX → PDF via LibreOffice ──
   Rodamos `soffice --headless --convert-to pdf` num tmpdir. Cache por
   sha1(caminho + mtime + size) — arquivo idempotente. Resultado streamado
   como application/pdf, que o cliente exibe via pdf.js (mesmo viewer do PDF).
   Requer LibreOffice instalado. Se falhar, o cliente cai no renderer client-side. */
const PPTX_PDF_CACHE_DIR = path.join(os.tmpdir(), 'kastor-office-pdf');
try { fs.mkdirSync(PPTX_PDF_CACHE_DIR, { recursive: true }); } catch {}
function findSoffice() {
  if (process.env.SOFFICE_PATH && fs.existsSync(process.env.SOFFICE_PATH)) return process.env.SOFFICE_PATH;
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  // Linux/Mac: assume no PATH
  return 'soffice';
}
const _conversionInFlight = new Map(); // cacheKey → Promise<pdfPath>
app.get('/api/office-as-pdf', requireAuth, async (req, res) => {
  const src = String(req.query.path || '');
  // Security: só /uploads/…, sem `..`, extensões office suportadas.
  if (!src.startsWith('/uploads/') || src.includes('..')) return res.status(400).json({ error: 'bad path' });
  const ext = (src.split('.').pop() || '').toLowerCase();
  if (!['pptx','ppt','docx','doc','xlsx','xls'].includes(ext)) return res.status(400).json({ error: 'unsupported' });
  const localPath = path.join(__dirname, 'public', src);
  if (!fs.existsSync(localPath)) return res.status(404).json({ error: 'not found' });
  const stat = fs.statSync(localPath);
  const cacheKey = crypto.createHash('sha1').update(localPath + ':' + stat.mtimeMs + ':' + stat.size).digest('hex');
  const cachedPdf = path.join(PPTX_PDF_CACHE_DIR, cacheKey + '.pdf');
  if (fs.existsSync(cachedPdf)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return fs.createReadStream(cachedPdf).pipe(res);
  }
  // Deduplica conversões simultâneas do mesmo arquivo.
  let pending = _conversionInFlight.get(cacheKey);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      let workDir;
      try {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kastor-office-'));
      } catch (e) { return reject(e); }
      const soffice = findSoffice();
      const proc = spawn(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', workDir, localPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Isola o profile do LibreOffice num tmpdir — evita lock de instância única.
        env: { ...process.env, HOME: workDir, TMPDIR: workDir }
      });
      let stderrBuf = '';
      proc.stderr.on('data', d => { stderrBuf += d.toString(); });
      proc.on('error', (err) => {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        reject(new Error('LibreOffice não encontrado. Instale LibreOffice ou defina SOFFICE_PATH. (' + err.message + ')'));
      });
      proc.on('exit', (code) => {
        if (code !== 0) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
          return reject(new Error('LibreOffice exit ' + code + ' — ' + stderrBuf.slice(0, 400)));
        }
        try {
          const files = fs.readdirSync(workDir).filter(f => f.toLowerCase().endsWith('.pdf'));
          if (!files.length) throw new Error('Sem PDF gerado');
          fs.copyFileSync(path.join(workDir, files[0]), cachedPdf);
        } catch (e) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
          return reject(e);
        }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        resolve(cachedPdf);
      });
    }).finally(() => { _conversionInFlight.delete(cacheKey); });
    _conversionInFlight.set(cacheKey, pending);
  }
  try {
    await pending;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(cachedPdf).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Conversão genérica de HTML → PDF/DOCX/ODT via LibreOffice ──
   Escreve o HTML num arquivo temp e roda `soffice --convert-to <fmt>`. Mesmo
   isolamento de profile + dedupe do office-as-pdf, mas com cache dinâmico
   por (sha1(html) + fmt) — igual gera o mesmo output determinístico.
   Usado pelo /api/writer/:id/export pra PDF/DOCX. */
const DOC_EXPORT_CACHE_DIR = path.join(os.tmpdir(), 'kastor-doc-export');
try { fs.mkdirSync(DOC_EXPORT_CACHE_DIR, { recursive: true }); } catch {}
const _exportInFlight = new Map();
async function convertHtmlWithSoffice(html, fmt) {
  const validFmts = { pdf: 'pdf', docx: 'docx:MS Word 2007 XML', odt: 'odt' };
  if (!validFmts[fmt]) throw new Error('Formato não suportado: ' + fmt);
  const cacheKey = crypto.createHash('sha1').update(html + ':' + fmt).digest('hex');
  const outPath = path.join(DOC_EXPORT_CACHE_DIR, cacheKey + '.' + fmt);
  if (fs.existsSync(outPath)) return outPath;
  let pending = _exportInFlight.get(cacheKey);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      let workDir;
      try { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kastor-doc-')); }
      catch (e) { return reject(e); }
      const htmlPath = path.join(workDir, 'source.html');
      try { fs.writeFileSync(htmlPath, html, 'utf8'); }
      catch (e) { return reject(e); }
      const soffice = findSoffice();
      // Alguns filters aceitam "docx:MS Word 2007 XML" — o soffice permite via --convert-to.
      const proc = spawn(soffice, ['--headless', '--norestore', '--convert-to', validFmts[fmt], '--outdir', workDir, htmlPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: workDir, TMPDIR: workDir }
      });
      let stderrBuf = '';
      proc.stderr.on('data', d => { stderrBuf += d.toString(); });
      proc.on('error', (err) => {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        reject(new Error('LibreOffice não encontrado. (' + err.message + ')'));
      });
      proc.on('exit', (code) => {
        if (code !== 0) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
          return reject(new Error('LibreOffice exit ' + code + ' — ' + stderrBuf.slice(0, 400)));
        }
        try {
          const files = fs.readdirSync(workDir).filter(f => f.toLowerCase().endsWith('.' + fmt));
          if (!files.length) throw new Error('LibreOffice não gerou o arquivo esperado');
          fs.copyFileSync(path.join(workDir, files[0]), outPath);
        } catch (e) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
          return reject(e);
        }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        resolve(outPath);
      });
    }).finally(() => _exportInFlight.delete(cacheKey));
    _exportInFlight.set(cacheKey, pending);
  }
  return pending;
}

/* ── PM JSON → HTML "portable" (server-side) ──
   Não é o mesmo _pmToHtmlBasic do client (que só produz fragment). Aqui geramos
   um HTML COMPLETO com CSS embutido pra ficar bonito no PDF/DOCX gerado.
   Usa fontes já instaladas no container (DejaVu, Liberation) — sem web fonts. */
function _serverEscHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function pmJsonToText(n) {
  if (!n) return '';
  if (Array.isArray(n)) return n.map(pmJsonToText).join('');
  if (n.type === 'text') return n.text || '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'horizontalRule') return '\n———\n';
  if (n.type === 'kastorAttachment') return `\n[anexo: ${n.attrs?.name || 'arquivo'}]\n`;
  if (n.type === 'image') return '\n[imagem]\n';
  const kids = (n.content || []).map(pmJsonToText).join('');
  const isBlock = ['paragraph','heading','listItem','blockquote','codeBlock','tableRow'].includes(n.type);
  return isBlock ? kids + '\n' : kids;
}
function pmJsonToFragment(n) {
  if (!n) return '';
  if (Array.isArray(n)) return n.map(pmJsonToFragment).join('');
  if (n.type === 'text') {
    let t = _serverEscHtml(n.text || '');
    for (const m of (n.marks || [])) {
      if (m.type === 'bold' || m.type === 'strong') t = `<strong>${t}</strong>`;
      else if (m.type === 'italic' || m.type === 'em') t = `<em>${t}</em>`;
      else if (m.type === 'underline') t = `<u>${t}</u>`;
      else if (m.type === 'strike') t = `<s>${t}</s>`;
      else if (m.type === 'code') t = `<code>${t}</code>`;
      else if (m.type === 'link') t = `<a href="${_serverEscHtml(m.attrs?.href || '#')}">${t}</a>`;
    }
    return t;
  }
  const kids = pmJsonToFragment(n.content || []);
  const alignAttr = n.attrs?.textAlign ? ` style="text-align:${_serverEscHtml(n.attrs.textAlign)}"` : '';
  switch (n.type) {
    case 'doc':          return kids;
    case 'paragraph':    return `<p${alignAttr}>${kids || '&nbsp;'}</p>`;
    case 'heading':      { const lvl = Math.min(6, Math.max(1, Number(n.attrs?.level || 1))); return `<h${lvl}${alignAttr}>${kids}</h${lvl}>`; }
    case 'bulletList':   return `<ul>${kids}</ul>`;
    case 'orderedList':  return `<ol>${kids}</ol>`;
    case 'listItem':     return `<li>${kids}</li>`;
    case 'blockquote':   return `<blockquote>${kids}</blockquote>`;
    case 'codeBlock':    return `<pre><code>${kids}</code></pre>`;
    case 'horizontalRule': return '<hr>';
    case 'hardBreak':    return '<br>';
    case 'table':        return `<table>${kids}</table>`;
    case 'tableRow':     return `<tr>${kids}</tr>`;
    case 'tableHeader':  return `<th>${kids}</th>`;
    case 'tableCell':    return `<td>${kids}</td>`;
    case 'image':        return `<img src="${_serverEscHtml(n.attrs?.src || '')}" alt="${_serverEscHtml(n.attrs?.alt || '')}">`;
    case 'kastorAttachment': {
      const a = n.attrs || {};
      // Pra PDF/DOCX incluir a imagem real: se `url` for /uploads/…, precisamos
      // servir com URL absoluta OU file:// path pra o LibreOffice fetchar.
      // Como não temos host no server, resolvemos pra file:// se possível.
      let src = a.url || '';
      if (src.startsWith('/uploads/')) {
        const local = path.join(__dirname, 'public', src);
        if (fs.existsSync(local)) src = 'file://' + local.replace(/\\/g, '/');
      }
      if (a.isImage && src) {
        return `<p><img src="${_serverEscHtml(src)}" alt="${_serverEscHtml(a.name || '')}" style="max-width:100%"></p>`;
      }
      // Card compacto pra PDF: só o nome + extensão
      const ext = (a.name || '').split('.').pop().toUpperCase().slice(0, 5);
      return `<p style="border:1px solid #ccc;padding:6px 10px;border-radius:6px;background:#f7f7f7"><strong>${_serverEscHtml(a.name || 'arquivo')}</strong> <span style="color:#888;font-size:11px">${_serverEscHtml(ext)}</span></p>`;
    }
    default: return kids;
  }
}
function pmJsonToPortableHtml(doc, meta = {}) {
  const title = meta.title || 'Documento';
  const body = pmJsonToFragment(doc);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${_serverEscHtml(title)}</title>
<style>
  @page { size: A4; margin: 20mm 22mm; }
  body { font-family: "Liberation Sans", "DejaVu Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
  h1 { font-size: 22pt; font-weight: 700; margin: 18pt 0 8pt; }
  h2 { font-size: 16pt; font-weight: 700; margin: 14pt 0 6pt; }
  h3 { font-size: 13pt; font-weight: 700; margin: 12pt 0 4pt; }
  p  { margin: 5pt 0; }
  ul, ol { margin: 6pt 0; padding-left: 22pt; }
  li { margin: 2pt 0; }
  blockquote { border-left: 3pt solid #7A00FF; padding: 4pt 12pt; margin: 8pt 0; color: #555; background: #f7f0ff; }
  code { background: #f0f0f0; padding: 1pt 3pt; border-radius: 2pt; font-family: "DejaVu Sans Mono", Consolas, monospace; font-size: 10pt; }
  pre { background: #f0f0f0; padding: 8pt 12pt; border-radius: 4pt; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  a  { color: #7A00FF; text-decoration: underline; }
  hr { border: 0; border-top: 1pt solid #ddd; margin: 12pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th, td { border: 1pt solid #ccc; padding: 6pt 8pt; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 700; }
  img { max-width: 100%; height: auto; }
</style>
</head><body>
${body}
</body></html>`;
}

// GET /api/writer/:id/export?format=pdf|docx|html|txt
app.get('/api/writer/:id/export', requireAuth, async (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const format = String(req.query.format || 'pdf').toLowerCase();
  const validFmts = new Set(['pdf', 'docx', 'html', 'txt']);
  if (!validFmts.has(format)) return res.status(400).json({ error: 'Formato inválido: ' + format });
  const baseName = (doc.title || 'documento').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'documento';
  const filename = baseName + '.' + format;

  try {
    if (format === 'txt') {
      const txt = pmJsonToText(doc.content || {});
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(txt);
    }
    if (format === 'html') {
      const html = pmJsonToPortableHtml(doc.content || {}, { title: doc.title });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(html);
    }
    // pdf / docx via LibreOffice
    const html = pmJsonToPortableHtml(doc.content || {}, { title: doc.title });
    const outPath = await convertHtmlWithSoffice(html, format);
    const mime = format === 'pdf' ? 'application/pdf'
                : format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(outPath).pipe(res);
  } catch (e) {
    console.error('[writer/export]', e.message);
    res.status(500).json({ error: e.message || 'Falha ao exportar' });
  }
});

/* Import inverso: recebe DOCX/DOC/ODT via multipart ou base64 e devolve HTML.
   TXT/HTML/MD são retornados direto (sem passar por LibreOffice — economiza
   segundos por arquivo). O client então usa editor.commands.setContent(html)
   pra converter em ProseMirror doc.
   Whitelist estrita de MIMEs — extensão .html direta seria vetor de XSS
   armazenado (se algum handler renderizasse como HTML rich sem sanitizar).
   Retorna { html: '...' } ou { error }. */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const IMPORT_MIME_EXT = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html'
};
const IMPORT_EXT_TO_MIME = Object.entries(IMPORT_MIME_EXT).reduce((acc, [m, e]) => (acc[e] || (acc[e] = m), acc), {});

async function convertOfficeDocToHtml(inputPath) {
  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kastor-import-out-'));
    const soffice = findSoffice();
    // Filtro `html` puro — usa o writer_html_Export default do LibreOffice
    // que existe em qualquer distribuição. O filtro `html:XHTML Writer File`
    // não existe em todas as versões (falhava em Alpine com "unknown filter").
    // O HTML gerado é passado pelo _cleanImportedHtml pra ficar consumível.
    const proc = spawn(soffice, ['--headless', '--norestore', '--convert-to', 'html', '--outdir', outDir, inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: outDir, TMPDIR: outDir }
    });
    let stderrBuf = '', stdoutBuf = '';
    proc.stdout.on('data', d => { stdoutBuf += d.toString(); });
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });
    proc.on('error', (err) => {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
      reject(new Error('LibreOffice não encontrado: ' + err.message));
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        const msg = (stderrBuf || stdoutBuf).trim().slice(0, 400) || 'sem stderr';
        return reject(new Error('LibreOffice exit ' + code + ': ' + msg));
      }
      try {
        const files = fs.readdirSync(outDir).filter(f => /\.html?$/i.test(f));
        if (!files.length) throw new Error('LibreOffice não gerou HTML');
        let html = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        resolve(html);
      } catch (e) {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        reject(e);
      }
    });
  });
}

/* Extrai só o BODY do HTML gerado pelo LibreOffice + remove estilos inline
   redundantes que atrapalham (font-family soffice-default etc). O client
   ainda passa por setContent que roda o schema-parser do Tiptap. */
function _cleanImportedHtml(html) {
  if (!html) return '';
  // Só a parte dentro de <body>...</body>
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = m ? m[1] : html;
  // Remove classes/styles verbose gerados pelo soffice
  body = body.replace(/\sclass="[^"]*"/gi, '');
  body = body.replace(/\sstyle="[^"]*"/gi, '');
  body = body.replace(/<font[^>]*>/gi, '').replace(/<\/font>/gi, '');
  // Colapsa múltiplos <br> em quebras razoáveis
  body = body.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  return body.trim();
}

app.post('/api/writer/import', requireAuth, jsonLg, async (req, res) => {
  const { name, data } = req.body || {};
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'data (data URI base64) é obrigatório' });
  const m = data.match(/^data:([^;]*);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'data URI inválido' });
  let mime = (m[1] || '').toLowerCase();
  let ext = IMPORT_MIME_EXT[mime];
  // Fallback pela extensão do nome — mesmo padrão do sanitizeAttachments.
  if (!ext && name) {
    const nm = String(name).toLowerCase().match(/\.([a-z0-9]{1,10})$/);
    const nameExt = nm ? nm[1] : null;
    if (nameExt && IMPORT_EXT_TO_MIME[nameExt]) { ext = nameExt; mime = IMPORT_EXT_TO_MIME[nameExt]; }
  }
  if (!ext) return res.status(400).json({ error: 'Formato não suportado. Aceita: DOCX, DOC, ODT, RTF, TXT, MD, HTML' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > IMPORT_MAX_BYTES) return res.status(400).json({ error: 'Arquivo vazio ou maior que 50 MB' });

  try {
    // Formatos de texto puro: retorna direto (envolvido em <p>).
    if (ext === 'txt') {
      const txt = buf.toString('utf8');
      const html = txt.split(/\r?\n\r?\n+/).map(p => '<p>' + _serverEscHtml(p).replace(/\r?\n/g, '<br>') + '</p>').join('');
      return res.json({ html, source: ext });
    }
    if (ext === 'md') {
      // Sem parser Markdown server-side aqui — vira <pre> pro user editar.
      const txt = buf.toString('utf8');
      return res.json({ html: '<pre>' + _serverEscHtml(txt) + '</pre>', source: ext });
    }
    if (ext === 'html') {
      const raw = buf.toString('utf8');
      return res.json({ html: _cleanImportedHtml(raw), source: ext });
    }
    // DOCX/DOC/ODT/RTF: passa por LibreOffice
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kastor-import-'));
    const inputPath = path.join(workDir, 'input.' + ext);
    fs.writeFileSync(inputPath, buf);
    try {
      const html = await convertOfficeDocToHtml(inputPath);
      res.json({ html: _cleanImportedHtml(html), source: ext });
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    console.error('[writer/import]', e.message);
    res.status(500).json({ error: e.message || 'Falha ao importar' });
  }
});

/* ── Galeria de anexos — endpoint que agrega attachments de TODAS as demandas
   acessíveis pro usuário (respeitando workspaces/freelancer). Retorna binário
   (data) junto — assim a galeria fica confiável entre reloads sem precisar
   abrir cada demanda pra carregar seus attachments.

   Query params opcionais:
     ?meta=1  → devolve só metadados (sem `data`) pra painéis "explorer"
                que fazem preview sob demanda. Recomendo pra listas grandes.
                Sem esse flag, devolve TUDO — cuidado com payload grande. */
app.get('/api/gallery', requireAuth, (req, res) => {
  const u = req.user;
  const ids = wsIdsFor(u);
  const inWs = (obj) => ids.includes(obj.workspaceId);
  const metaOnly = req.query.meta === '1';

  let visibleDemands = db.demands.filter(d => inWs(d) && notDeleted(d));
  if (u.isFreelancer) {
    visibleDemands = visibleDemands.filter(d => freelancerHasDemandAccess(u, d));
  }
  const projectsById = new Map((db.projects || []).map(p => [p.id, p]));
  const clientsById = new Map((db.clients || []).map(c => [c.id, c]));
  const out = [];
  for (const d of visibleDemands) {
    const proj = d.projectId ? projectsById.get(d.projectId) : null;
    const client = proj?.clientId ? clientsById.get(proj.clientId) : null;
    const base = {
      demandId: d.id,
      demandName: d.name,
      workspaceId: d.workspaceId || null,
      projectId: d.projectId || null,
      projectName: proj?.name || '',
      clientId: proj?.clientId || null,
      clientName: client?.name || proj?.client || '',
      addedAt: d.updatedAt || d.createdAt || ''
    };
    (d.attachments || []).forEach(a => {
      const item = {
        ...base,
        // Data do upload (gravada no anexo); a da demanda só se o anexo não tiver.
        addedAt: a.addedAt || base.addedAt,
        id: a.id,
        kind: a.kind || 'file',
        name: a.name || '',
        type: a.type || '',
        size: a.size || 0,
        // Anexos antigos guardam o path do arquivo no campo `data` (era base64 e
        // foi migrado pra /uploads/<id> in-place, mas o field name ficou). Usa
        // como fallback do url pra que a Galeria (e o Kastor Docs) consigam
        // sempre resolver o arquivo.
        url: a.url || (typeof a.data === 'string' && a.data.startsWith('/uploads/') ? a.data : null)
      };
      // Só inclui `data` (base64) quando não é metaOnly — é o pesado.
      if (!metaOnly && a.data) item.data = a.data;
      out.push(item);
    });
    // Comentários também podem ter anexos.
    (d.comments || []).forEach(c => {
      (c.attachments || []).forEach(a => {
        const item = {
          ...base,
          addedAt: a.addedAt || c.at || c.createdAt || base.addedAt,
          id: a.id,
          kind: a.kind || 'file',
          name: a.name || '',
          type: a.type || '',
          size: a.size || 0,
          url: a.url || null
        };
        if (!metaOnly && a.data) item.data = a.data;
        out.push(item);
      });
    });
  }
  res.json(out);
});

/* ───────────────────────────────────────────────────────────────
   Kastor Docs — editor colaborativo interno (Fase 0/1: single-user)

   Modelo: writerDocument = { id, workspaceId, title, icon, ownerId,
   permissions:[{userId, role}], content (ProseMirror JSON), archived,
   createdAt, updatedAt, deletedAt? }

   Escopo por workspace (mesmo padrão de gallery/clients). Freelancer
   não vê a página (freelancer-hide na nav) — mas ainda blindamos aqui.
   Colaboração em tempo real (Yjs + WS) entra em Fase 2 — não altera
   este contrato, só adiciona endpoint /api/writer/:id/token e serviço RT.
   ─────────────────────────────────────────────────────────────── */
/* Permissões finas: role hierarchy
     owner    → tudo (compartilhar, apagar, editar meta)
     editor   → edita conteúdo, comenta, exporta
     commenter→ só comenta, exporta, lê
     viewer   → só lê e exporta
   Doc.restricted (default false): quando true, SÓ users em permissions[]
   têm acesso — o filtro por workspace deixa de valer pra outsiders. */
const WRITER_ROLE_RANK = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
function _writerRoleOf(user, doc) {
  if (!user || !doc) return null;
  if (user.isAdmin) return 'owner';
  if (doc.ownerId === user.id) return 'owner';
  const entry = (doc.permissions || []).find(p => p.userId === user.id);
  if (entry) return entry.role || 'viewer';
  // Sem entry: acesso "padrão" = editor pra membros do workspace
  // (a menos que o doc esteja restrito, aí sem role vira nada)
  if (doc.restricted) return null;
  if (canAccessWs(user, doc.workspaceId)) return 'editor';
  return null;
}
function writerCanRead(user, doc)   { if (!doc || doc.deletedAt) return false; return !!_writerRoleOf(user, doc); }
function writerCanComment(user, doc){ const r = _writerRoleOf(user, doc); return r && WRITER_ROLE_RANK[r] >= WRITER_ROLE_RANK.commenter; }
function writerCanWrite(user, doc)  {
  if (!doc || doc.deletedAt) return false;
  if (user.isFreelancer) return false;
  const r = _writerRoleOf(user, doc);
  return r && WRITER_ROLE_RANK[r] >= WRITER_ROLE_RANK.editor;
}
function writerCanShare(user, doc)  { return _writerRoleOf(user, doc) === 'owner'; }

/* Preview curto (~180 chars) extraído do PM JSON — usado em thumbnails/lists. */
function _writerContentPreview(content) {
  if (!content) return '';
  const text = pmJsonToText(content).replace(/\s+/g, ' ').trim();
  return text.length > 180 ? text.slice(0, 178).trimEnd() + '…' : text;
}
/* "Snapshot" visual: HTML dos primeiros nodes do doc, renderizado no cliente
   como capa mini estilo Google Docs. Pega blocos suficientes pra encher
   uma folha em miniatura (~20), o overflow é cortado no CSS. Trocamos imagens
   pesadas por placeholder pra o thumb não puxar bytes do bucket. */
function _writerContentThumb(content) {
  if (!content || !Array.isArray(content.content)) return '';
  const nodes = content.content.slice(0, 20);
  // Sanitiza:
  // - image/kastorAttachment → placeholder (não puxa bytes pesados)
  // - remove marks 'link' (o thumb já mora dentro de <a>, HTML não aceita
  //   <a> aninhado — o browser fecharia o wrapper externo e o card ficaria
  //   vazio, mostrando só o bg do surface)
  const sanitize = (n) => {
    if (!n || typeof n !== 'object') return n;
    if (n.type === 'image' || n.type === 'kastorAttachment') {
      return { type: 'paragraph', content: [{ type: 'text', text: '▭' }] };
    }
    let out = n;
    if (Array.isArray(n.marks) && n.marks.length) {
      const marks = n.marks.filter(m => m && m.type !== 'link');
      out = marks.length !== n.marks.length ? { ...n, marks } : n;
    }
    if (Array.isArray(out.content)) {
      out = { ...out, content: out.content.map(sanitize) };
    }
    return out;
  };
  const subset = { type: 'doc', content: nodes.map(sanitize) };
  return pmJsonToFragment(subset);
}
function stripWriterDoc(doc, { includeContent = false, user = null } = {}) {
  if (!doc) return null;
  const out = {
    id: doc.id,
    workspaceId: doc.workspaceId,
    title: doc.title || 'Sem título',
    icon: doc.icon || null,
    ownerId: doc.ownerId || null,
    restricted: !!doc.restricted,
    archived: !!doc.archived,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    // Vínculo com o trabalho na plataforma (opcional)
    clientId: doc.clientId || null,
    projectId: doc.projectId || null,
    // Pedido de aprovação do cliente pelo link público
    approval: doc.approval || null,
    // Formato: 'pageless' (bloco contínuo, padrão) ou 'pages' (folhas A4)
    layout: doc.layout === 'pages' ? 'pages' : 'pageless',
    publicShareEnabled: !!doc.publicShareEnabled,
    // Ajuda o cliente a decidir se abre em read-only, esconde botões, etc.
    myRole: user ? _writerRoleOf(user, doc) : null,
    // Preview do texto (linha) — fallback quando o thumbHTML tá vazio
    preview: _writerContentPreview(doc.content),
    // Snapshot visual (HTML dos primeiros ~6 blocos) — vira "capa" no card
    thumbHTML: _writerContentThumb(doc.content)
  };
  if (includeContent) {
    out.content = doc.content || null;
    out.version = doc.version || 0;
  }
  return out;
}

/* Valida clientId/projectId vindos do cliente: precisam existir e estar num
   equipe que o usuário acessa. Projeto define o cliente se ele não vier. */
function _writerLinkFrom(user, body) {
  const out = {};
  if ('projectId' in body) {
    const p = body.projectId ? db.projects.find(x => x.id === body.projectId && notDeleted(x)) : null;
    if (body.projectId && (!p || !canAccessWs(user, p.workspaceId))) return { error: 'Projeto inválido' };
    out.projectId = p ? p.id : null;
    if (p && !('clientId' in body)) out.clientId = p.clientId || null;
  }
  if ('clientId' in body) {
    const c = body.clientId ? db.clients.find(x => x.id === body.clientId && notDeleted(x)) : null;
    if (body.clientId && (!c || !canAccessWs(user, c.workspaceId))) return { error: 'Cliente inválido' };
    out.clientId = c ? c.id : null;
  }
  // Projeto de outro cliente não fica vinculado junto
  if (out.projectId && out.clientId) {
    const p = db.projects.find(x => x.id === out.projectId);
    if (p && p.clientId && p.clientId !== out.clientId) out.projectId = null;
  }
  return out;
}

/* Aviso no sino sobre um documento (aprovação do cliente). O item guarda
   docId/docTitle; o app abre o documento ao clicar. */
function notifyDoc(targetUserId, type, data) {
  const user = db.users.find(u => u.id === targetUserId && u.active !== false);
  if (!user) return;
  const nDoc = (rawDb.writerDocuments || []).find(x => x.id === data.docId);
  const n = {
    id: uid(), userId: targetUserId, type,
    orgId: (nDoc && tenancy.wsOrgId(nDoc.workspaceId)) || tenancy.currentOrgId() || null,
    demandId: null, demandName: data.docTitle || '',
    docId: data.docId, docTitle: data.docTitle || '',
    fromUser: null, fromName: data.fromName || null,
    commentText: data.commentText || null,
    read: false, createdAt: nowISO()
  };
  store.insertNotification(n).catch(err => console.error('[notifyDoc] insert:', err.message));
  store.trimNotificationsFor(targetUserId, NOTIFICATIONS_MAX_PER_USER).catch(() => {});
  broadcastToUser(targetUserId, 'notification', 'create');
}

// GET /api/writer — lista docs do workspace (metadata; sem content)
app.get('/api/writer', requireAuth, (req, res) => {
  const u = req.user;
  if (u.isFreelancer) return res.status(403).json({ error: 'Freelancer não tem acesso' });
  // Lista qualquer doc onde o user tem role (workspace-editor implícito OU
  // permission explícita — cobre também docs restritos compartilhados de
  // outros squads).
  const { clientId, projectId, lite } = req.query;
  let docs = (db.writerDocuments || []).filter(d => !d.deletedAt && writerCanRead(u, d));
  if (clientId) docs = docs.filter(d => d.clientId === clientId);
  if (projectId) docs = docs.filter(d => d.projectId === projectId);
  // lite=1: sem prévia/miniatura (listas dentro da plataforma)
  const list = docs.map(d => {
    const o = stripWriterDoc(d, { user: u });
    if (lite) { delete o.thumbHTML; delete o.preview; }
    return o;
  });
  res.json(list);
});

// GET /api/writer/:id — metadata + content
app.get('/api/writer/:id', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  res.json(stripWriterDoc(doc, { includeContent: true, user: req.user }));
});

// POST /api/writer — cria novo doc
app.post('/api/writer', requireAuth, express.json({ limit: '2mb' }), (req, res) => {
  const u = req.user;
  if (u.isFreelancer) return res.status(403).json({ error: 'Freelancer não pode criar documentos' });
  const wsId = String(req.body?.workspaceId || '').trim();
  if (!wsId || !canAccessWs(u, wsId)) return res.status(400).json({ error: 'workspaceId inválido' });
  const link = _writerLinkFrom(u, req.body || {});
  if (link.error) return res.status(400).json({ error: link.error });
  const now = nowISO();
  const doc = {
    id: uid(),
    workspaceId: wsId,
    clientId: link.clientId || null,
    projectId: link.projectId || null,
    title: String(req.body?.title || 'Sem título').slice(0, 200),
    icon: req.body?.icon ? String(req.body.icon).slice(0, 8) : null,
    ownerId: u.id,
    permissions: [{ userId: u.id, role: 'owner' }],
    content: req.body?.content || null,
    version: 0,
    archived: false,
    createdAt: now,
    updatedAt: now
  };
  if (!Array.isArray(db.writerDocuments)) db.writerDocuments = [];
  db.writerDocuments.push(doc);
  saveEntity('writerDocuments', doc);
  res.json(stripWriterDoc(doc, { includeContent: true, user: u }));
});

// PATCH /api/writer/:id — atualiza metadata (title, icon, archived)
app.patch('/api/writer/:id', requireAuth, express.json({ limit: '512kb' }), (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  if (typeof req.body?.title === 'string') doc.title = req.body.title.slice(0, 200);
  if (typeof req.body?.icon === 'string' || req.body?.icon === null) {
    doc.icon = req.body.icon ? String(req.body.icon).slice(0, 8) : null;
  }
  if (typeof req.body?.archived === 'boolean') doc.archived = req.body.archived;
  if (req.body?.layout === 'pages' || req.body?.layout === 'pageless') doc.layout = req.body.layout;
  if (req.body && ('clientId' in req.body || 'projectId' in req.body)) {
    const link = _writerLinkFrom(req.user, req.body);
    if (link.error) return res.status(400).json({ error: link.error });
    if ('clientId' in link) doc.clientId = link.clientId;
    if ('projectId' in link) doc.projectId = link.projectId;
    if ('clientId' in req.body && !link.clientId) doc.projectId = null;   // sem cliente, sem projeto
  }
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json(stripWriterDoc(doc, { user: req.user }));
});

// PUT /api/writer/:id/content — autosave do conteúdo (PM JSON).
// Retorna { version, updatedAt } pra o cliente saber que ficou salvo.
app.put('/api/writer/:id/content', requireAuth, express.json({ limit: '10mb' }), (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const content = req.body?.content;
  if (content == null || typeof content !== 'object') {
    return res.status(400).json({ error: 'content ausente ou inválido' });
  }
  doc.content = content;
  doc.version = (doc.version || 0) + 1;
  doc.updatedAt = nowISO();
  doc.lastEditedBy = req.user.id;
  saveEntity('writerDocuments', doc);
  res.json({ version: doc.version, updatedAt: doc.updatedAt });
});

/* ── Permissões finas (compartilhamento) ───────────────────────
   Retorna users com role explícita (permissions[]) + user info enriquecido.
   Só quem tem role 'owner' pode alterar permissões. */
function _writerEnrichPermUser(userId, users) {
  const u = users.find(x => x.id === userId);
  return u
    ? { id: u.id, name: u.name || u.username || 'Usuário', username: u.username, email: u.email || null, avatar: u.avatar || null, isFreelancer: !!u.isFreelancer }
    : { id: userId, name: 'Usuário removido', username: null, email: null, avatar: null };
}

// GET /api/writer/:id/permissions — retorna {restricted, owner, permissions[]}
app.get('/api/writer/:id/permissions', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const perms = (doc.permissions || []).map(p => ({
    ..._writerEnrichPermUser(p.userId, db.users),
    role: p.role || 'viewer',
    isOwner: p.userId === doc.ownerId
  }));
  res.json({
    ownerId: doc.ownerId,
    restricted: !!doc.restricted,
    workspaceId: doc.workspaceId,
    myRole: _writerRoleOf(req.user, doc),
    permissions: perms,
    publicShareEnabled: !!doc.publicShareEnabled,
    publicShareUrl: doc.publicShareEnabled ? _writerPublicUrl(doc) : null
  });
});

// PATCH /api/writer/:id/permissions — só owner. Body: { restricted?, add?, updates?, remove? }
//   add:    [{ userId, role }]  — adiciona users (não pode duplicar)
//   updates:[{ userId, role }]  — muda role
//   remove: [userId, ...]       — tira users
app.patch('/api/writer/:id/permissions', requireAuth, express.json({ limit: '128kb' }), (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanShare(req.user, doc)) return res.status(403).json({ error: 'Só o dono pode alterar permissões' });

  if (!Array.isArray(doc.permissions)) doc.permissions = [];
  if (typeof req.body?.restricted === 'boolean') doc.restricted = req.body.restricted;

  // Owner é FIXO em quem criou o doc — nunca pode ser promovido/transferido
  // via este endpoint. Só editor/commenter/viewer podem ser adicionados/mudados.
  const ASSIGNABLE_ROLES = new Set(['viewer', 'commenter', 'editor']);

  // Add — user precisa existir + pertencer ao workspace (freelancer bloqueado)
  for (const it of (req.body?.add || [])) {
    if (!it?.userId || !ASSIGNABLE_ROLES.has(it.role)) continue;
    const u = db.users.find(x => x.id === it.userId && x.active !== false);
    if (!u) continue;
    if (u.isFreelancer) continue;
    if (it.userId === doc.ownerId) continue; // owner já é dono, não vira "editor"
    if (doc.permissions.find(p => p.userId === it.userId)) continue; // já tem
    doc.permissions.push({ userId: it.userId, role: it.role });
  }
  // Updates — nunca mexe no papel do owner (nem pra tirar, nem pra reafirmar)
  for (const it of (req.body?.updates || [])) {
    if (!it?.userId || !ASSIGNABLE_ROLES.has(it.role)) continue;
    if (it.userId === doc.ownerId) continue;
    const p = doc.permissions.find(x => x.userId === it.userId);
    if (p) p.role = it.role;
  }
  // Remove
  for (const uid of (req.body?.remove || [])) {
    if (uid === doc.ownerId) continue; // não remove o dono
    doc.permissions = doc.permissions.filter(p => p.userId !== uid);
  }
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json({
    ownerId: doc.ownerId,
    restricted: !!doc.restricted,
    permissions: (doc.permissions || []).map(p => ({ ..._writerEnrichPermUser(p.userId, db.users), role: p.role, isOwner: p.userId === doc.ownerId }))
  });
});

/* ── Link público (leitura) ──────────────────────────────
   Só o dono pode gerar/revogar. Quem tem o link consegue abrir o doc
   em modo somente-leitura, mesmo sem estar autenticado. */
function _writerPublicUrl(doc) {
  return doc.publicShareToken ? '/hub/docs/public/' + doc.publicShareToken : null;
}

app.post('/api/writer/:id/public-link', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanShare(req.user, doc)) return res.status(403).json({ error: 'Só o dono pode gerar link público' });
  if (!doc.publicShareToken) doc.publicShareToken = (uid() + uid()).replace(/-/g, '').slice(0, 32);
  doc.publicShareEnabled = true;
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json({ enabled: true, token: doc.publicShareToken, url: _writerPublicUrl(doc) });
});

app.delete('/api/writer/:id/public-link', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanShare(req.user, doc)) return res.status(403).json({ error: 'Só o dono pode revogar link público' });
  doc.publicShareEnabled = false;
  // Mantém o token no banco pra reativação preservar o mesmo link, se o dono quiser.
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json({ enabled: false });
});

/* ── Aprovação do cliente ─────────────────────────────────────────────
   POST /api/writer/:id/approval { action: 'request' | 'cancel' }
   Pedir aprovação liga o link público (é por ele que o cliente decide). */
app.post('/api/writer/:id/approval', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const action = req.body?.action;
  if (action === 'cancel') {
    doc.approval = null;
  } else if (action === 'request') {
    if (!doc.publicShareToken) doc.publicShareToken = (uid() + uid()).replace(/-/g, '').slice(0, 32);
    doc.publicShareEnabled = true;
    doc.approval = { status: 'pending', requestedAt: nowISO(), requestedBy: req.user.id, version: doc.version || 0 };
  } else {
    return res.status(400).json({ error: 'Ação inválida' });
  }
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json({ approval: doc.approval, publicShareEnabled: !!doc.publicShareEnabled, url: doc.publicShareEnabled ? _writerPublicUrl(doc) : null });
});

/* POST /api/writer/public/:token/approval { decision: 'approved'|'changes', name, comment }
   Sem login: quem tem o link responde. Só vale enquanto há pedido pendente. */
const rateLimitDocApproval = makeRateLimit(new Map(), 10, 'respostas');
app.post('/api/writer/public/:token/approval', rateLimitDocApproval, express.json({ limit: '32kb' }), (req, res) => {
  const t = String(req.params.token || '');
  const doc = (db.writerDocuments || []).find(d => t.length >= 8 && d.publicShareToken === t && d.publicShareEnabled && !d.deletedAt);
  if (!doc) return res.status(404).json({ error: 'Documento não encontrado ou link revogado' });
  if (!doc.approval || doc.approval.status !== 'pending') return res.status(409).json({ error: 'Este documento não está aguardando aprovação' });
  const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'changes' ? 'changes' : null;
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const comment = String(req.body?.comment || '').trim().slice(0, 2000);
  if (!decision) return res.status(400).json({ error: 'Decisão inválida' });
  if (!name) return res.status(400).json({ error: 'Informe seu nome' });
  if (decision === 'changes' && !comment) return res.status(400).json({ error: 'Conte o que precisa ser ajustado' });
  doc.approval = { ...doc.approval, status: decision, decidedAt: nowISO(), decidedBy: name, comment: comment || null };
  if (!Array.isArray(doc.approvalHistory)) doc.approvalHistory = [];
  doc.approvalHistory.push({ ...doc.approval });
  doc.approvalHistory = doc.approvalHistory.slice(-50);
  saveEntity('writerDocuments', doc);
  // Avisa quem pediu e o dono
  const targets = new Set([doc.approval.requestedBy, doc.ownerId].filter(Boolean));
  for (const uidT of targets) {
    notifyDoc(uidT, decision === 'approved' ? 'doc_approved' : 'doc_changes', {
      docId: doc.id, docTitle: doc.title || 'Sem título', fromName: name, commentText: comment || null
    });
  }
  res.json({ approval: { status: doc.approval.status, decidedAt: doc.approval.decidedAt, decidedBy: name, comment: doc.approval.comment } });
});

// GET /api/writer/public/:token — pega o doc via token (viewer-only, sem auth)
app.get('/api/writer/public/:token', (req, res) => {
  const t = String(req.params.token || '');
  if (!t || t.length < 8) return res.status(404).json({ error: 'Link inválido' });
  const doc = (db.writerDocuments || []).find(d =>
    d.publicShareToken === t && d.publicShareEnabled && !d.deletedAt
  );
  if (!doc) return res.status(404).json({ error: 'Documento não encontrado ou link revogado' });
  res.json({
    id: doc.id,
    title: doc.title || 'Sem título',
    icon: doc.icon || null,
    workspaceId: doc.workspaceId,
    ownerId: doc.ownerId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    myRole: 'viewer',
    isPublic: true,
    layout: doc.layout === 'pages' ? 'pages' : 'pageless',
    approval: doc.approval ? {
      status: doc.approval.status, decidedAt: doc.approval.decidedAt || null,
      decidedBy: doc.approval.decidedBy || null, comment: doc.approval.comment || null
    } : null,
    content: doc.content || null,
    version: doc.version || 0
  });
});

// GET /api/writer/:id/users-suggest?q= — autocomplete pra o modal de share.
// Devolve top-N users (não-freelancer) que casam com o query, com preferência
// pra membros do workspace do doc. Máx 12 resultados.
app.get('/api/writer/:id/users-suggest', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const q = String(req.query.q || '').trim().toLowerCase();
  const already = new Set((doc.permissions || []).map(p => p.userId));
  const list = (db.users || [])
    .filter(u => u.active !== false && !u.isFreelancer && !already.has(u.id))
    .map(u => ({
      id: u.id, name: u.name || u.username || 'Usuário', username: u.username,
      email: u.email || null, avatar: u.avatar || null,
      inWorkspace: Array.isArray(u.workspaces) && u.workspaces.includes(doc.workspaceId)
    }));
  const filtered = q
    ? list.filter(u => (u.name || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
    : list;
  // Ordena: membros do workspace primeiro, depois alfabético
  filtered.sort((a, b) => (b.inWorkspace - a.inWorkspace) || a.name.localeCompare(b.name));
  res.json(filtered.slice(0, 12));
});

/* ── Versionamento (time-machine) ──────────────────────────────
   Snapshots vivem em writerDocument.snapshots[]:
     { id, at, byId, label?, size, content (PM JSON) }
   Auto: cliente aciona /versions?auto=1 a cada ~20 saves ou 5min. Server
   dedupe: se o última snapshot foi < 60s atrás E não tem label, ignora.
   Poda: limite de 50 snapshots automáticas por doc — as com label ficam.
   ─────────────────────────────────────────────────────────────── */
const WRITER_SNAPSHOT_AUTO_CAP = 50;
const WRITER_SNAPSHOT_AUTO_DEDUP_MS = 60 * 1000;
function stripWriterSnapshotMeta(s, users) {
  if (!s) return null;
  const u = users.find(x => x.id === s.byId);
  return {
    id: s.id,
    at: s.at,
    label: s.label || null,
    isAuto: !s.label,
    size: s.size || 0,
    by: u ? { id: u.id, name: u.name || u.username || 'Usuário', avatar: u.avatar || null } : { id: s.byId, name: 'Usuário', avatar: null }
  };
}

// GET /api/writer/:id/versions — lista de snapshots (metadata)
app.get('/api/writer/:id/versions', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const list = (doc.snapshots || [])
    .slice()
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
    .map(s => stripWriterSnapshotMeta(s, db.users));
  res.json(list);
});

// GET /api/writer/:id/versions/:sid — snapshot com content (pra preview/restore)
app.get('/api/writer/:id/versions/:sid', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const s = (doc.snapshots || []).find(x => x.id === req.params.sid);
  if (!s) return res.status(404).json({ error: 'Versão não encontrada' });
  const meta = stripWriterSnapshotMeta(s, db.users);
  res.json({ ...meta, content: s.content || null });
});

// POST /api/writer/:id/versions — cria snapshot. Body: { label?, content? }
// Se content vem no body, usa; senão usa doc.content atual (típico do "salvar versão" manual).
// Query `?auto=1` sinaliza snapshot automática (aplica dedupe + poda).
app.post('/api/writer/:id/versions', requireAuth, express.json({ limit: '10mb' }), (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const isAuto = req.query.auto === '1';
  const content = req.body?.content || doc.content;
  if (!content) return res.status(400).json({ error: 'Documento sem conteúdo pra versionar' });
  if (!Array.isArray(doc.snapshots)) doc.snapshots = [];

  // Dedupe: snapshot auto seguidas em <60s ignora
  if (isAuto) {
    const last = doc.snapshots[doc.snapshots.length - 1];
    if (last && !last.label && (Date.now() - Date.parse(last.at || 0) < WRITER_SNAPSHOT_AUTO_DEDUP_MS)) {
      return res.json({ skipped: true, reason: 'dedup', keeping: stripWriterSnapshotMeta(last, db.users) });
    }
  }

  const size = JSON.stringify(content).length;
  const s = {
    id: uid(),
    at: nowISO(),
    byId: req.user.id,
    label: req.body?.label ? String(req.body.label).slice(0, 120) : null,
    size,
    content
  };
  doc.snapshots.push(s);

  // Poda: mantém até WRITER_SNAPSHOT_AUTO_CAP automáticas (as com label são preservadas)
  const auto = doc.snapshots.filter(x => !x.label);
  if (auto.length > WRITER_SNAPSHOT_AUTO_CAP) {
    const toRemove = new Set(auto.slice(0, auto.length - WRITER_SNAPSHOT_AUTO_CAP).map(x => x.id));
    doc.snapshots = doc.snapshots.filter(x => !toRemove.has(x.id));
  }

  doc.updatedAt = s.at;
  saveEntity('writerDocuments', doc);
  res.json(stripWriterSnapshotMeta(s, db.users));
});

// POST /api/writer/:id/versions/:sid/restore — restaura o conteúdo pra essa versão.
// ATENÇÃO: cria uma snapshot automática do estado ATUAL antes de restaurar,
// pra o restore ser reversível.
app.post('/api/writer/:id/versions/:sid/restore', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const target = (doc.snapshots || []).find(x => x.id === req.params.sid);
  if (!target) return res.status(404).json({ error: 'Versão não encontrada' });
  if (!Array.isArray(doc.snapshots)) doc.snapshots = [];

  // Snapshot do estado atual antes do restore (rótulo indica reversibilidade)
  if (doc.content) {
    doc.snapshots.push({
      id: uid(),
      at: nowISO(),
      byId: req.user.id,
      label: 'Antes de restaurar versão de ' + new Date(target.at).toLocaleString('pt-BR'),
      size: JSON.stringify(doc.content).length,
      content: doc.content
    });
  }
  // Aplica o conteúdo da snapshot alvo como conteúdo atual
  doc.content = target.content;
  doc.version = (doc.version || 0) + 1;
  doc.updatedAt = nowISO();
  // Invalida o yState — clientes conectados vão reconectar e receber o novo
  // conteúdo. Em Fase 2 (colab) isso força re-sync limpo.
  doc.yState = null;
  saveEntity('writerDocuments', doc);
  res.json({ ok: true, version: doc.version, updatedAt: doc.updatedAt, restoredFrom: stripWriterSnapshotMeta(target, db.users) });
});

// DELETE /api/writer/:id/versions/:sid — remove uma snapshot (só admin ou dono do doc)
app.delete('/api/writer/:id/versions/:sid', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  if (doc.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Só o dono ou admin pode remover versões' });
  const before = (doc.snapshots || []).length;
  doc.snapshots = (doc.snapshots || []).filter(x => x.id !== req.params.sid);
  if (doc.snapshots.length === before) return res.status(404).json({ error: 'Versão não encontrada' });
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json({ ok: true });
});

/* ── Comentários ───────────────────────────────────────────────
   Threads vivem dentro do writerDocument.threads[]:
     { id, createdBy, createdAt, resolvedAt?, resolvedBy?, quotedText,
       messages: [{ id, authorId, at, body }] }
   O mark `kastorComment` no PM guarda apenas `threadId` — a resolução
   é feita aqui (removendo o mark ao resolver).
   ─────────────────────────────────────────────────────────────── */
function stripWriterThread(t, users) {
  if (!t) return null;
  const enrichAuthor = (id) => {
    const u = users.find(x => x.id === id);
    return u ? { id: u.id, name: u.name || u.username || 'Usuário', avatar: u.avatar || null } : { id, name: 'Usuário', avatar: null };
  };
  return {
    id: t.id,
    createdBy: enrichAuthor(t.createdBy),
    createdAt: t.createdAt,
    resolvedAt: t.resolvedAt || null,
    resolvedBy: t.resolvedBy ? enrichAuthor(t.resolvedBy) : null,
    quotedText: t.quotedText || '',
    messages: (t.messages || []).map(m => ({
      id: m.id, at: m.at, body: m.body || '',
      author: enrichAuthor(m.authorId)
    }))
  };
}

// GET /api/writer/:id/comments — lista threads (padrão: só não-resolvidas; ?all=1 pra tudo)
app.get('/api/writer/:id/comments', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanRead(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  const showAll = req.query.all === '1';
  const threads = (doc.threads || [])
    .filter(t => showAll || !t.resolvedAt)
    .map(t => stripWriterThread(t, db.users));
  res.json(threads);
});

// POST /api/writer/:id/comments — cria thread nova (body: threadId, quotedText, message)
app.post('/api/writer/:id/comments', requireAuth, express.json({ limit: '128kb' }), (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  // commenter também pode criar comentários (sem editar o texto)
  if (!writerCanComment(req.user, doc)) return res.status(403).json({ error: 'Sem permissão pra comentar' });
  const threadId = String(req.body?.threadId || '').trim();
  const message  = String(req.body?.message || '').trim();
  if (!threadId || !message) return res.status(400).json({ error: 'threadId e message obrigatórios' });
  if (!Array.isArray(doc.threads)) doc.threads = [];
  if (doc.threads.find(t => t.id === threadId)) return res.status(409).json({ error: 'threadId já existe' });
  const now = nowISO();
  const t = {
    id: threadId,
    createdBy: req.user.id,
    createdAt: now,
    quotedText: String(req.body?.quotedText || '').slice(0, 500),
    messages: [{ id: uid(), authorId: req.user.id, at: now, body: message.slice(0, 8000) }]
  };
  doc.threads.push(t);
  doc.updatedAt = now;
  saveEntity('writerDocuments', doc);
  res.json(stripWriterThread(t, db.users));
});

// POST /api/writer/:id/comments/:tid/reply — adiciona mensagem
app.post('/api/writer/:id/comments/:tid/reply', requireAuth, express.json({ limit: '128kb' }), (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanComment(req.user, doc)) return res.status(403).json({ error: 'Sem permissão pra comentar' });
  const t = (doc.threads || []).find(x => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'Thread não encontrada' });
  const body = String(req.body?.message || '').trim();
  if (!body) return res.status(400).json({ error: 'message obrigatória' });
  const now = nowISO();
  const msg = { id: uid(), authorId: req.user.id, at: now, body: body.slice(0, 8000) };
  t.messages = t.messages || [];
  t.messages.push(msg);
  doc.updatedAt = now;
  saveEntity('writerDocuments', doc);
  res.json(stripWriterThread(t, db.users));
});

// POST /api/writer/:id/comments/:tid/resolve — marca resolvida (idempotente)
app.post('/api/writer/:id/comments/:tid/resolve', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanComment(req.user, doc)) return res.status(403).json({ error: 'Sem permissão pra comentar' });
  const t = (doc.threads || []).find(x => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'Thread não encontrada' });
  t.resolvedAt = nowISO();
  t.resolvedBy = req.user.id;
  doc.updatedAt = t.resolvedAt;
  saveEntity('writerDocuments', doc);
  res.json(stripWriterThread(t, db.users));
});

// POST /api/writer/:id/comments/:tid/reopen — desfaz o resolve
app.post('/api/writer/:id/comments/:tid/reopen', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanComment(req.user, doc)) return res.status(403).json({ error: 'Sem permissão pra comentar' });
  const t = (doc.threads || []).find(x => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'Thread não encontrada' });
  delete t.resolvedAt; delete t.resolvedBy;
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json(stripWriterThread(t, db.users));
});

// DELETE /api/writer/:id/comments/:tid — remove thread (só o criador ou admin)
app.delete('/api/writer/:id/comments/:tid', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanComment(req.user, doc)) return res.status(403).json({ error: 'Sem permissão pra comentar' });
  const idx = (doc.threads || []).findIndex(x => x.id === req.params.tid);
  if (idx < 0) return res.status(404).json({ error: 'Thread não encontrada' });
  const t = doc.threads[idx];
  if (t.createdBy !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Só o autor ou um admin pode excluir' });
  doc.threads.splice(idx, 1);
  doc.updatedAt = nowISO();
  saveEntity('writerDocuments', doc);
  res.json({ ok: true });
});

// DELETE /api/writer/:id — soft delete
app.delete('/api/writer/:id', requireAuth, (req, res) => {
  const doc = (db.writerDocuments || []).find(d => d.id === req.params.id);
  if (!writerCanWrite(req.user, doc)) return res.status(404).json({ error: 'Documento não encontrado' });
  doc.deletedAt = nowISO();
  doc.deletedBy = req.user.id;
  saveEntity('writerDocuments', doc);
  res.json({ ok: true });
});

/* Bootstrap consolidado: retorna em UMA resposta o que o cliente pedia em
   16 GETs paralelos no boot (workspaces, users, clients, projects, flows,
   demands, roles, templates, schedules, client-templates, recurrings,
   listas, positions, demand-types, tasks, webhooks). Em conexões lentas,
   isso economiza 15 RTTs — cada um custa 100-500ms sob 4G. O payload
   consolidado ainda comprime melhor que 16 respostas pequenas (dicionário
   de brotli/gzip reaproveita chaves repetidas entre coleções).
   Mantém os endpoints individuais funcionando pra refetches pontuais
   (SSE reage a mudança de UM tipo → refetch só daquele tipo). */
app.get('/api/bootstrap', requireAuth, (req, res) => {
  const u = req.user;
  const ids = wsIdsFor(u);
  const inWs = (obj) => ids.includes(obj.workspaceId);

  // demand-types tem cálculo de usageCount
  const dtUsage = demandTypeUsage();
  const demandTypes = (db.demandTypes || []).map(t => ({
    id: t.id, name: t.name, createdAt: t.createdAt,
    usageCount: dtUsage[(t.name || '').toLowerCase()] || 0
  }));

  // webhooks só pra mod/admin (mesma regra do endpoint individual)
  const canSeeWebhooks = u.isAdmin || u.isModerator;
  const webhooks = canSeeWebhooks
    ? (db.webhooks || []).map(({ workspaceId, ...rest }) => rest)
    : [];

  // Freelancer só vê as demandas em que está — e só os clientes/projetos/fluxos
  // referenciados por essas demandas (o resto do sistema fica invisível).
  let visibleDemands = db.demands.filter(d => inWs(d) && notDeleted(d));
  let visibleClientIds = null, visibleProjectIds = null, visibleFlowIds = null;
  if (u.isFreelancer) {
    visibleDemands = visibleDemands.filter(d => freelancerHasDemandAccess(u, d));
    visibleProjectIds = new Set(visibleDemands.map(d => d.projectId).filter(Boolean));
    visibleFlowIds    = new Set(visibleDemands.map(d => d.flowId).filter(Boolean));
    const projList = db.projects.filter(p => visibleProjectIds.has(p.id));
    visibleClientIds = new Set(projList.map(p => p.clientId).filter(Boolean));
  }
  const clientOK  = c => visibleClientIds  ? visibleClientIds.has(c.id)  : true;
  const projectOK = p => visibleProjectIds ? visibleProjectIds.has(p.id) : true;
  const flowOK    = f => visibleFlowIds    ? visibleFlowIds.has(f.id)    : true;

  res.json({
    workspaces:      db.workspaces.filter(w => ids.includes(w.id)),
    users:           visibleUsersFor(u).map(x => publicUser(x)),
    clients:         db.clients.filter(c => inWs(c) && notDeleted(c) && clientOK(c)),
    projects:        db.projects.filter(p => inWs(p) && notDeleted(p) && projectOK(p)),
    flows:           db.flows.filter(f => inWs(f) && notDeleted(f) && flowOK(f)),
    // Stripped: description/comments/attachments/briefing/history só chegam
    // quando o user abre a demanda (~70% menor no wire, escala melhor).
    demands:         visibleDemands.map(stripDemandForList),
    roles:           db.roles,
    templates:       (db.templates || []).filter(inWs),
    // Schedules: só 4 semanas ao redor de hoje (2 anteriores incluindo semana
    // corrente + 1 depois + buffer). O cliente lazy-loada semanas fora desse
    // range via GET /api/schedules?from&to (dedupe por id).
    schedules:       (db.schedules || []).filter(s => {
      if (!inWs(s)) return false;
      const from = addDays(today(), -14);
      const to   = addDays(today(),  14);
      return s.date >= from && s.date <= to;
    }),
    clientTemplates: (db.clientTemplates || []).filter(notDeleted),
    recurrings:      (db.recurrings || []).filter(r => notDeleted(r) && inWs(r)),
    listas:          (db.listas || []).filter(l => notDeleted(l) && (l.kind === 'todo' || inWs(l))),
    positions:       db.positions || [],
    demandTypes,
    tasks:           (db.tasks || []).filter(inWs),
    webhooks,
    discordChannels: canSeeWebhooks ? (db.discordChannels || []).map(publicBinding) : [],
    // Universais: qualquer autenticado vê todos os templates/dashboards.
    formTemplates:   (db.formTemplates || []).filter(notDeleted),
    dashboards:      (db.dashboards    || []).filter(notDeleted).map(publicDashboard),
    // Responses ficam escopadas: só respostas dos squads em que o user está.
    formResponses:   (db.formResponses || []).filter(r => notDeleted(r) && inWs(r)),
    // Informa ao cliente o range de schedules já carregados — pra saber
    // quando lazy-fetchar semanas fora dessa janela.
    _scheduleRange: { from: addDays(today(), -14), to: addDays(today(), 14) },
  });
});

app.post('/api/workspaces', requireAuth, adminOnly, (req, res) => {
  const { name, color } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nome da equipe é obrigatório' });
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
  if (!w) return res.status(404).json({ error: 'Equipe não encontrada' });
  const { name, color } = req.body || {};
  if (typeof name === 'string' && name.trim()) w.name = name.trim();
  if (color) w.color = color;
  saveEntity('workspaces', w);
  res.json(w);
});

app.delete('/api/workspaces/:id', requireAuth, adminOnly, (req, res) => {
  if (db.workspaces.length <= 1) return res.status(400).json({ error: 'É preciso manter pelo menos um workspace' });
  const hasProjects = db.projects.some(p => p.workspaceId === req.params.id);
  if (hasProjects) return res.status(409).json({ error: 'Esta equipe possui projetos. Mova ou exclua-os antes.' });
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
/* Freelancer vê só quem aparece nas demandas dele (e ele mesmo). */
function visibleUsersFor(user) {
  if (!user.isFreelancer) return db.users;
  const ids = new Set([user.id]);
  for (const d of db.demands) {
    if (!notDeleted(d) || !freelancerHasDemandAccess(user, d)) continue;
    [d.ownerId, d.createdBy, ...Object.values(d.stageResponsibles || {}), ...(d.watchers || []),
      ...(d.comments || []).map(c => c.userId), ...(d.timeEntries || []).map(e => e.userId)].forEach(id => id && ids.add(id));
  }
  return db.users.filter(u => ids.has(u.id));
}
app.get('/api/users', requireAuth, (req, res) => res.json(visibleUsersFor(req.user).map(u => publicUser(u))));

app.post('/api/users', requireAuth, adminOnly, (req, res) => {
  const { username, password, name, role, position, isAdmin, isModerator, isFreelancer, workspaces, discordId, email } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (!uname || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  const seatErr = seatLimitError(req.org);
  if (seatErr) return res.status(403).json({ error: seatErr, code: 'seat_limit' });
  if (String(password).length < PASSWORD_MIN) return res.status(400).json({ error: `A senha deve ter pelo menos ${PASSWORD_MIN} caracteres` });
  if (allUsers().some(u => u.username.toLowerCase() === uname)) {
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
    mail = normEmail(email);
    if (userByEmail(mail)) return res.status(409).json({ error: 'Esse e-mail já está em uso por outra conta.' });
  }
  const wsList = Array.isArray(workspaces) ? workspaces.filter(id => db.workspaces.some(w => w.id === id)) : [];
  const user = {
    id: uid(), username: uname, name: String(name || uname).trim(),
    role: String(role || '').trim(),
    position: String(position || '').trim() || null,
    isAdmin: !!isAdmin,
    // Moderador só faz sentido se não for admin (admin já tem tudo). Silenciosamente ignora.
    isModerator: !isAdmin && !!isModerator,
    // Freelancer é excludente com admin/moderador — silenciosamente ignora se veio junto.
    isFreelancer: !isAdmin && !isModerator && !!isFreelancer,
    avatar: null,
    active: true, workspaces: wsList, discordId: did, email: mail,
    emailPrefs: defaultEmailPrefs(), createdAt: nowISO()
  };
  db.users.push(user);
  adoptUser(user, req.org.id, { invitedBy: req.user.id });
  auth.setPassword(user.id, password);
  saveEntity('users', user);
  // Conta criada à mão pra quem tinha convite pendente: o convite perde o sentido.
  if (mail) closeInvitesFor(mail, req.user.id);
  res.status(201).json(publicUser(user));
});

app.put('/api/users/:id', requireAuth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { name, role, position, isAdmin, isModerator, isFreelancer, active, password, workspaces, discordId, email } = req.body || {};
  if (u.isOwner && !req.user.isOwner) return res.status(403).json({ error: 'Só o dono edita a conta do dono da organização.' });
  if (u.isOwner && active === false) return res.status(400).json({ error: 'Transfira a organização para outra pessoa antes de desativar o dono.' });
  if (active === true && u.active === false) {
    const seatErr = seatLimitError(req.org);
    if (seatErr) return res.status(403).json({ error: seatErr, code: 'seat_limit' });
  }
  // A conta pode estar em outras organizações: senha e e-mail são da pessoa.
  // E-mail é da pessoa: só ela troca (perfil, com senha e link). O admin
  // pode, no máximo, sugerir um pra quem ainda não tem — fica a confirmar.
  if (email !== undefined && u.email && normEmail(email) !== normEmail(u.email)) {
    return res.status(403).json({ error: 'O e-mail é da própria pessoa: ela troca no perfil, com a senha e um link de confirmação.' });
  }
  const otherOrgs = tenancy.membershipsOf(u.id).some(m => m.orgId !== req.org.id);
  if (otherOrgs && (password || (email !== undefined && normEmail(email) !== normEmail(u.email)))) {
    return res.status(403).json({ error: 'Essa pessoa também faz parte de outras organizações: senha e e-mail só ela muda (no perfil ou em "Esqueci minha senha").' });
  }
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
  if (email !== undefined && !u.email && email) {
    if (!isValidEmail(email)) return res.status(400).json({ error: 'E-mail inválido.' });
    const next = normEmail(email);
    if (userByEmail(next, u.id)) return res.status(409).json({ error: 'Esse e-mail já está em uso por outra conta.' });
    u.email = next;
    u.emailVerifiedAt = null; // a pessoa confirma pelo aviso no Início
  }
  if (typeof isAdmin === 'boolean') {
    if (!isAdmin && u.isAdmin && db.users.filter(x => x.isAdmin && x.active !== false).length <= 1) {
      return res.status(400).json({ error: 'É preciso manter pelo menos um administrador ativo' });
    }
    u.isAdmin = isAdmin;
    // Admin absorve moderador/freelancer — não fazem sentido juntos.
    if (isAdmin) { u.isModerator = false; u.isFreelancer = false; }
  }
  if (typeof isModerator === 'boolean' && !u.isAdmin) {
    u.isModerator = isModerator;
    if (isModerator) u.isFreelancer = false;
  }
  if (typeof isFreelancer === 'boolean' && !u.isAdmin && !u.isModerator) {
    u.isFreelancer = isFreelancer;
  }
  if (typeof active === 'boolean') {
    if (!active && u.isAdmin && db.users.filter(x => x.isAdmin && x.active !== false).length <= 1) {
      return res.status(400).json({ error: 'É preciso manter pelo menos um administrador ativo' });
    }
    u.active = active;
    if (!active) auth.dropTokensFor(u.id);
  }
  if (password) {
    if (String(password).length < PASSWORD_MIN) return res.status(400).json({ error: `A senha deve ter pelo menos ${PASSWORD_MIN} caracteres` });
    auth.setPassword(u.id, password);
  }
  saveEntity('users', u);
  res.json(publicUser(u));
});

/* Admin tira a verificação em duas etapas de quem perdeu o celular/acesso.
   Mesma regra da senha: não mexe no dono (a não ser o próprio dono) nem em
   quem também está em outra organização. */
app.post('/api/users/:id/2fa/reset', requireAuth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (u.isOwner && !req.user.isOwner) return res.status(403).json({ error: 'Só o dono mexe na conta do dono da organização.' });
  if (tenancy.membershipsOf(u.id).some(m => m.orgId !== req.org.id)) return res.status(403).json({ error: 'Essa pessoa também faz parte de outras organizações: peça ajuda ao suporte do reWork.' });
  if (twoFactorMethodOf(u) !== 'totp') return res.json(publicUser(u));
  delete u.twoFactor; delete u.twoFactorSetup;
  saveEntity('users', u);
  twoFactorNotice(req, u, false, 'totp');
  res.json(publicUser(u));
});

/* ── CONVITES ──
   Admin (ou moderador, com limites) convida por e-mail pra organização ativa;
   a pessoa abre /convite/<token> e:
     - sem conta: escolhe nome de usuário e senha;
     - com conta no reWork (outra organização): confirma a senha e ganha o
       vínculo com esta organização.
   O token só existe no link: guardamos o SHA-256 (pra achar o convite) e uma
   cópia cifrada (pro admin copiar o link de novo). Vale 7 dias; reenviar
   renova o prazo. Aceitar confirma o e-mail. O convite de DONO só sai do
   console (organização nova aprovada na lista de espera). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_KINDS = { owner: 'Dono da organização', admin: 'Administrador', mod: 'Moderador', equipe: 'Membro', free: 'Freelancer' };
const _invitePublicAttempts = new Map();
const rateLimitInvitePublic = makeRateLimit(_invitePublicAttempts, 20, 'tentativas');
const _inviteSends = new Map();
const rateLimitInviteSend = makeRateLimit(_inviteSends, 40, 'convites', req => 'u:' + (req.user?.id || clientIp(req)), 60 * 60 * 1000);

function inviteStatus(inv) {
  if (inv.acceptedAt) return 'accepted';
  if (inv.revokedAt) return 'revoked';
  if (!inv.expiresAt || Date.parse(inv.expiresAt) <= Date.now()) return 'expired';
  return 'pending';
}
// Público (sem organização ativa): procura em todas as organizações.
function inviteByToken(token) {
  if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(String(token))) return null;
  const h = auth.hashToken(token);
  return (rawDb.invites || []).find(i => i.tokenHash === h) || null;
}
function inviteToken(inv) {
  try { return auth.decryptString(inv.tokenEnc) || null; } catch { return null; }
}
function inviteLinkFor(req, token) { return `${appBaseUrl(req)}/convite/${token}`; }
function inviteSquadNames(inv) {
  if (inv.kind === 'admin' || inv.kind === 'owner') return [];
  return (inv.workspaces || []).map(id => (rawDb.workspaces || []).find(w => w.id === id)?.name).filter(Boolean);
}
function publicInvite(inv) {
  const by = allUsers().find(u => u.id === inv.invitedBy);
  return {
    id: inv.id, email: inv.email, name: inv.name || '',
    kind: inv.kind, role: inv.role || '', position: inv.position || null,
    workspaces: inv.workspaces || [],
    invitedBy: inv.invitedBy || null, invitedByName: by ? by.name : (inv.invitedByName || null),
    createdAt: inv.createdAt, expiresAt: inv.expiresAt,
    lastSentAt: inv.lastSentAt || null, sendCount: inv.sendCount || 0,
    status: inviteStatus(inv)
  };
}
/* Valida os campos do convite. Moderador só convida Membro/Freelancer pros
   equipes dele. */
function inviteFieldsFrom(body, inviter) {
  const b = body || {};
  const email = normEmail(b.email);
  if (!email || !isValidEmail(email)) return { error: 'Informe um e-mail válido.' };
  const kind = ['admin', 'mod', 'equipe', 'free'].includes(b.kind) ? b.kind : 'equipe';
  let workspaces = Array.isArray(b.workspaces) ? [...new Set(b.workspaces)].filter(id => db.workspaces.some(w => w.id === id)) : [];
  if (inviter && !inviter.isAdmin) {
    if (kind !== 'equipe' && kind !== 'free') return { error: 'Moderadores convidam só como Membro ou Freelancer.' };
    const mine = new Set(inviter.workspaces || []);
    if (workspaces.some(id => !mine.has(id))) return { error: 'Você só pode liberar equipes em que você está.' };
  }
  if (kind !== 'admin' && !workspaces.length) return { error: 'Escolha pelo menos uma equipe para a pessoa acessar.' };
  if (kind === 'admin') workspaces = [];
  return {
    email, kind, workspaces,
    name: String(b.name || '').trim().slice(0, 120),
    role: String(b.role || '').trim().slice(0, 80),
    position: String(b.position || '').trim().slice(0, 80) || null
  };
}
function newInviteRecord(fields, orgId, invitedBy) {
  const token = crypto.randomBytes(24).toString('base64url');
  const inv = {
    id: uid(), orgId, ...fields,
    tokenHash: auth.hashToken(token), tokenEnc: auth.encryptString(token),
    invitedBy: invitedBy || null, createdAt: nowISO(),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    lastSentAt: null, sendCount: 0
  };
  return { inv, token };
}
async function sendInviteEmail(req, inv, token) {
  if (!mailEnabled()) return { sent: false, reason: 'smtp_not_configured' };
  const by = allUsers().find(u => u.id === inv.invitedBy);
  const org = tenancy.orgById(inv.orgId);
  const baseUrl = appBaseUrl(req);
  const { subject, html, text } = emailTpl.invite({
    name: inv.name, inviter: by?.name || inv.invitedByName, org: org?.name, access: INVITE_KINDS[inv.kind],
    squads: inviteSquadNames(inv), link: inviteLinkFor(req, token), expiresAt: inv.expiresAt, baseUrl, isOwner: inv.kind === 'owner'
  });
  return sendEmail(inv.email, subject, html, text);
}
/* Fecha convites abertos pra um e-mail na organização ativa (conta criada
   por outro caminho). */
function closeInvitesFor(email, byUserId) {
  const e = normEmail(email);
  for (const inv of db.invites) {
    if (inv.email === e && !inv.acceptedAt && !inv.revokedAt) {
      inv.revokedAt = nowISO(); inv.revokedBy = byUserId || null; inv.tokenEnc = null;
      saveEntity('invites', inv);
    }
  }
}
/* Moderador vê e mexe só nos convites que ele mesmo criou. */
const canManageInvite = (user, inv) => user.isAdmin || inv.invitedBy === user.id;

app.get('/api/invites', requireAuth, modOrAdmin, (req, res) => {
  const list = db.invites
    .filter(i => { const st = inviteStatus(i); return (st === 'pending' || st === 'expired') && i.kind !== 'owner' && canManageInvite(req.user, i); })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(publicInvite);
  // Lugares do plano (pessoas ativas + convites pendentes da organização toda),
  // mostrados no Quadro da equipe.
  const plan = orgPlan(req.org);
  res.json({ invites: list, emailEnabled: mailEnabled(), seats: { ...orgSeats(req.org.id), limit: plan.users, planName: plan.name } });
});

app.post('/api/invites', requireAuth, modOrAdmin, rateLimitInviteSend, async (req, res) => {
  if (!req.user.isAdmin && !orgSettings(req.org).modsCanInvite) return res.status(403).json({ error: 'Nesta organização só administradores convidam pessoas.' });
  const f = inviteFieldsFrom(req.body, req.user);
  if (f.error) return res.status(400).json({ error: f.error });
  const existing = userByEmail(f.email);
  const already = existing && tenancy.memberIn(existing.id, req.org.id);
  if (already) {
    return res.status(409).json({
      error: already.active === false
        ? 'Essa pessoa já fez parte da organização e está desativada. Reative na lista em vez de convidar.'
        : 'Essa pessoa já faz parte da organização.',
      code: 'already_member', userId: existing.id
    });
  }
  const open = db.invites.find(i => i.email === f.email && inviteStatus(i) === 'pending');
  if (open) return res.status(409).json({ error: 'Já existe um convite pendente para esse e-mail. Use "Reenviar" na lista de convites.', code: 'invite_pending', inviteId: open.id });
  const seatErr = seatLimitError(req.org);
  if (seatErr) return res.status(403).json({ error: seatErr, code: 'seat_limit' });
  // Convite vencido pro mesmo e-mail sai da lista — o novo substitui.
  closeInvitesFor(f.email, req.user.id);
  const { inv, token } = newInviteRecord(f, req.org.id, req.user.id);
  db.invites.push(inv);
  const mail = await sendInviteEmail(req, inv, token);
  if (mail.sent) { inv.lastSentAt = nowISO(); inv.sendCount = 1; }
  saveEntity('invites', inv);
  res.status(201).json({ invite: publicInvite(inv), link: inviteLinkFor(req, token), emailSent: !!mail.sent, emailError: mail.sent ? null : mail.reason });
});

/* Reenvia o e-mail e renova o prazo (serve também pra convite vencido). */
app.post('/api/invites/:id/resend', requireAuth, modOrAdmin, rateLimitInviteSend, async (req, res) => {
  const inv = db.invites.find(i => i.id === req.params.id);
  if (!inv || inv.acceptedAt || inv.revokedAt || !canManageInvite(req.user, inv)) return res.status(404).json({ error: 'Convite não encontrado.' });
  const existing = userByEmail(inv.email);
  if (existing && tenancy.memberIn(existing.id, inv.orgId)) return res.status(409).json({ error: 'Essa pessoa já faz parte da organização.' });
  // Vencido volta a ocupar um lugar ao ser renovado.
  if (inviteStatus(inv) === 'expired') {
    const seatErr = seatLimitError(req.org);
    if (seatErr) return res.status(403).json({ error: seatErr, code: 'seat_limit' });
  }
  let token = inviteToken(inv);
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    inv.tokenHash = auth.hashToken(token); inv.tokenEnc = auth.encryptString(token);
  }
  inv.expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const mail = await sendInviteEmail(req, inv, token);
  if (mail.sent) { inv.lastSentAt = nowISO(); inv.sendCount = (inv.sendCount || 0) + 1; }
  saveEntity('invites', inv);
  res.json({ invite: publicInvite(inv), link: inviteLinkFor(req, token), emailSent: !!mail.sent, emailError: mail.sent ? null : mail.reason });
});

app.get('/api/invites/:id/link', requireAuth, modOrAdmin, (req, res) => {
  const inv = db.invites.find(i => i.id === req.params.id);
  if (!inv || inviteStatus(inv) !== 'pending' || !canManageInvite(req.user, inv)) return res.status(404).json({ error: 'Convite não encontrado ou vencido.' });
  const token = inviteToken(inv);
  if (!token) return res.status(410).json({ error: 'Não foi possível recuperar o link. Reenvie o convite.' });
  res.json({ link: inviteLinkFor(req, token) });
});

app.delete('/api/invites/:id', requireAuth, modOrAdmin, (req, res) => {
  const inv = db.invites.find(i => i.id === req.params.id);
  if (!inv || inv.acceptedAt || inv.revokedAt || !canManageInvite(req.user, inv)) return res.status(404).json({ error: 'Convite não encontrado.' });
  inv.revokedAt = nowISO(); inv.revokedBy = req.user.id; inv.tokenEnc = null;
  saveEntity('invites', inv);
  res.json({ ok: true });
});

/* Público: dados pra tela de aceite. Não expõe nada além do próprio convite. */
function inviteGate(inv) {
  if (!inv) return { code: 404, body: { status: 'invalid', error: 'Convite não encontrado. Confira se o link está completo.' } };
  const st = inviteStatus(inv);
  if (st === 'accepted') return { code: 410, body: { status: st, error: 'Este convite já foi aceito. Entre com seu e-mail e senha.' } };
  if (st === 'revoked') return { code: 410, body: { status: st, error: 'Este convite foi cancelado. Peça um novo para quem te convidou.' } };
  if (st === 'expired') return { code: 410, body: { status: st, error: 'Este convite venceu. Peça para quem te convidou reenviar.' } };
  if (!tenancy.orgActive(inv.orgId)) return { code: 410, body: { status: 'invalid', error: 'Esta organização não está mais disponível.' } };
  if (orgPlan(tenancy.orgById(inv.orgId)).readOnly) {
    return { code: 403, body: { status: 'read_only', error: 'Esta organização está só para consulta no momento (o teste grátis acabou). Fale com quem te convidou.' } };
  }
  // O convite já ocupa um lugar; aqui só barra se o limite baixou depois dele.
  if (inv.kind !== 'owner') {
    const plan = orgPlan(tenancy.orgById(inv.orgId));
    if (plan.users != null && orgSeats(inv.orgId).members >= plan.users) {
      return { code: 403, body: { status: 'seat_limit', error: 'Esta organização chegou ao limite de pessoas do plano. Peça para quem te convidou liberar um lugar e tente de novo.' } };
    }
  }
  const u = userByEmail(inv.email);
  const m = u && tenancy.memberIn(u.id, inv.orgId);
  if (m) return { code: 409, body: { status: 'account_exists', error: 'Você já faz parte desta organização. Entre com sua conta.' } };
  return null;
}
app.get('/api/invites/public/:token', rateLimitInvitePublic, (req, res) => {
  const inv = inviteByToken(req.params.token);
  const gate = inviteGate(inv);
  if (gate) return res.status(gate.code).json(gate.body);
  const by = allUsers().find(u => u.id === inv.invitedBy);
  const org = tenancy.orgById(inv.orgId);
  const existing = userByEmail(inv.email);
  res.json({
    status: 'pending', email: inv.email, name: inv.name || '',
    orgName: org ? org.name : null, orgLogo: org ? (org.logo || null) : null,
    inviterName: by ? by.name : (inv.invitedByName || null), inviterAvatar: by ? (by.avatar || null) : null,
    access: INVITE_KINDS[inv.kind], squads: inviteSquadNames(inv),
    expiresAt: inv.expiresAt, passwordMin: PASSWORD_MIN,
    // Já tem conta no reWork (em outra organização): só confirma a senha.
    accountExists: !!existing,
    existingName: existing ? existing.name : null,
    suggestedUsername: existing ? null : suggestUsername(inv.email, inv.name)
  });
});

const INVITE_ROLE = { owner: 'owner', admin: 'admin', mod: 'mod', equipe: 'equipe', free: 'free' };
/* Liga a pessoa à organização do convite, fecha o convite e abre a sessão já
   nessa organização. */
function joinFromInvite(req, res, inv, user, opts = {}) {
  const m = adoptUser(user, inv.orgId, {
    role: INVITE_ROLE[inv.kind] || 'equipe',
    workspaces: (inv.workspaces || []).filter(id => tenancy.wsOrgId(id) === inv.orgId),
    area: inv.role || '', position: inv.position || null, invitedBy: inv.invitedBy || null
  });
  if (inv.kind === 'owner') {
    const org = tenancy.orgById(inv.orgId);
    if (org) { org.ownerId = user.id; startTrialIfPending(org); saveEntity('organizations', org); }
  }
  user.lastOrgId = inv.orgId;
  if (!user.emailVerifiedAt) user.emailVerifiedAt = nowISO();
  saveEntity('users', user);
  inv.acceptedAt = nowISO(); inv.acceptedUserId = user.id; inv.tokenEnc = null;
  saveEntity('invites', inv);
  if (!opts.noSession) {
    recordLoginIp(user, clientIp(req));
    const token = startSession(req, res, user);
    auth.setSessionData(token, { orgId: inv.orgId });
  }
  // Avisa quem convidou (só no sino), dentro da organização do convite.
  if (inv.invitedBy) tenancy.run(inv.orgId, () => notify(inv.invitedBy, 'invite_accepted', { demandName: user.name }, user.id, appBaseUrl(req)));
  return m;
}

app.post('/api/invites/public/:token/accept', rateLimitInvitePublic, (req, res) => {
  const inv = inviteByToken(req.params.token);
  const gate = inviteGate(inv);
  if (gate) return res.status(gate.code).json(gate.body);
  if (userByEmail(inv.email)) return res.status(409).json({ error: 'Esse e-mail já tem conta no reWork. Confirme sua senha para entrar na organização.', code: 'use_existing' });
  const { name, username, password, acceptTerms } = req.body || {};
  const nm = String(name || '').trim().slice(0, 120);
  if (!nm) return res.status(400).json({ error: 'Informe seu nome.', field: 'name' });
  const un = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(un)) return res.status(400).json({ error: USERNAME_RULE, field: 'username' });
  if (usernameTaken(un)) return res.status(409).json({ error: 'Esse nome de usuário já está em uso. Escolha outro.', field: 'username' });
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return res.status(400).json({ error: `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`, field: 'password' });
  if (password.length > 200) return res.status(400).json({ error: 'Senha longa demais.', field: 'password' });
  if (acceptTerms !== true) return res.status(400).json({ error: 'Aceite os Termos de Serviço e a Política de Privacidade para continuar.', field: 'terms' });
  const now = nowISO();
  const user = {
    id: uid(), username: un, name: nm, avatar: null,
    discordId: null, email: inv.email, emailVerifiedAt: now,
    emailPrefs: defaultEmailPrefs(), createdAt: now,
    invitedBy: inv.invitedBy || null, inviteId: inv.id, termsAcceptedAt: now,
    onboardingPendingAt: now
  };
  rawDb.users.push(user);
  auth.setPassword(user.id, password);
  joinFromInvite(req, res, inv, user);
  res.status(201).json({ user: tenancy.run(inv.orgId, () => publicUser(user, { self: true })) });
});

/* Conta existente entrando numa organização nova: confirma a senha. */
app.post('/api/invites/public/:token/join', rateLimitInvitePublic, (req, res) => {
  const inv = inviteByToken(req.params.token);
  const gate = inviteGate(inv);
  if (gate) return res.status(gate.code).json(gate.body);
  const user = userByEmail(inv.email);
  if (!user) return res.status(409).json({ error: 'Esse e-mail ainda não tem conta. Crie sua conta pelo convite.', code: 'use_new' });
  const { password, acceptTerms } = req.body || {};
  if (!auth.verifyPassword(user.id, password)) return res.status(401).json({ error: 'Senha incorreta.', field: 'password' });
  if (acceptTerms !== true) return res.status(400).json({ error: 'Aceite os Termos de Serviço e a Política de Privacidade para continuar.', field: 'terms' });
  if (!user.termsAcceptedAt) user.termsAcceptedAt = nowISO();
  // Com verificação em duas etapas, entra na organização mas faz o login normal.
  const needs2fa = twoFactorOn(user);
  joinFromInvite(req, res, inv, user, { noSession: needs2fa });
  res.status(201).json({ user: tenancy.run(inv.orgId, () => publicUser(user, { self: true })), loginRequired: needs2fa });
});

/* ── ORGANIZAÇÕES (lado do app) ── */

/* Planos e limites.
   Cada organização guarda org.plan = { id, users, storageGb }. Os planos do
   catálogo trazem os limites prontos; "Personalizado" usa os números
   gravados na própria organização (null = sem limite) — é o caminho do
   Enterprise. Organização sem plano (as de antes dos planos) conta como
   Personalizado sem limites.
   Pessoas: vínculos ativos + convites pendentes (freelancer também conta).
   Armazenamento: arquivos enviados (/uploads) que algum item da organização
   usa — anexos, imagens de comentários, avatares de clientes, logo…
   Régua: ~1 GB por pessoa, pensada pra um servidor só (disco e memória).

   Teste: organização nova (lista de espera) nasce no plano Teste; os 14 dias
   contam a partir de quando o dono aceita o convite. Vencido, a organização
   fica só pra consulta (lê tudo, não grava nada) até o console mudar o plano. */
const GB = 1024 ** 3, MB = 1024 ** 2;
const TRIAL_DAYS = 14;
const PLANS = [
  { id: 'teste', name: 'Teste', users: 5, storageGb: 2, fileMb: 25, trial: true },
  { id: 'essencial', name: 'Essencial', users: 5, storageGb: 5, fileMb: 25 },
  { id: 'equipe', name: 'Equipe', users: 15, storageGb: 15, fileMb: 50 },
  { id: 'agencia', name: 'Agência', users: 30, storageGb: 30, fileMb: 100 },
  { id: 'custom', name: 'Personalizado', users: null, storageGb: null, fileMb: null }
];
const planById = (id) => PLANS.find(p => p.id === id) || null;
function orgPlan(org) {
  const saved = (org && org.plan) || {};
  const base = planById(saved.id) || planById('custom');
  const custom = base.id === 'custom';
  const users = custom ? (Number(saved.users) > 0 ? Math.floor(Number(saved.users)) : null) : base.users;
  const storageGb = custom ? (Number(saved.storageGb) > 0 ? Number(saved.storageGb) : null) : base.storageGb;
  // Sem limite próprio, vale o teto do servidor (UPLOAD_MAX_BYTES).
  const fileMb = custom ? (Number(saved.fileMb) > 0 ? Math.min(Number(saved.fileMb), UPLOAD_MAX_BYTES / MB) : null) : base.fileMb;
  const trialEndsAt = base.trial ? (saved.trialEndsAt || null) : null;
  const left = trialEndsAt ? Date.parse(trialEndsAt) - Date.now() : null;
  return {
    id: base.id, name: base.name, users, storageGb, storageBytes: storageGb == null ? null : Math.round(storageGb * GB),
    fileMb, fileBytes: fileMb == null ? UPLOAD_MAX_BYTES : Math.round(fileMb * MB),
    trial: !!base.trial, trialEndsAt,
    trialDaysLeft: left == null ? null : Math.max(0, Math.ceil(left / 864e5)),
    readOnly: left != null && left <= 0
  };
}
// O relógio do teste começa quando o dono entra (o convite pode esperar dias).
function startTrialIfPending(org) {
  if (!org || !org.plan || org.plan.id !== 'teste' || org.plan.trialEndsAt) return false;
  org.plan.trialStartedAt = nowISO();
  org.plan.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString();
  return true;
}
/* Organização só pra consulta (teste vencido): GET passa; mutação só as da
   própria pessoa (perfil, sair, trocar de organização, notificações). */
const READ_ONLY_ALLOWED = /^\/api\/(me(\/.*)?|logout|orgs\/switch|notifications(\/.*)?|presence(\/.*)?|google(\/.*)?)$/;
function readOnlyBlock(org, method, reqPath) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (!org || !orgPlan(org).readOnly) return false;
  return !READ_ONLY_ALLOWED.test(reqPath);
}
const READ_ONLY_ERROR = 'O teste grátis desta organização acabou. Os dados continuam aqui, só para consulta, até a organização escolher um plano.';
function orgSeats(orgId) {
  const members = (rawDb.memberships || []).filter(m => m.orgId === orgId && m.active !== false).length;
  const pending = (rawDb.invites || []).filter(i => i.orgId === orgId && inviteStatus(i) === 'pending').length;
  return { members, pending, used: members + pending };
}
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}
/* Arquivos: nome único por upload e conteúdo que não muda → o peso pode ficar
   em cache. Zero não entra (o arquivo pode aparecer depois / voltar da lixeira). */
const _uploadBytes = new Map();
function _uploadFileBytes(name) {
  if (_uploadBytes.has(name)) return _uploadBytes.get(name);
  let n = 0;
  try { n = fs.statSync(path.join(UPLOADS_DIR, name)).size; } catch {}
  if (n) _uploadBytes.set(name, n);
  return n;
}
const UPLOAD_REF_RE = /\/uploads\/([A-Za-z0-9_.\-]+)/g;
/* Arquivos que cada organização usa: Map orgId → Set(nomes). Contas de pessoa
   (avatar) ficam de fora — são da pessoa, não da organização. */
function uploadRefsByOrg() {
  const out = new Map();
  for (const [type, list] of Object.entries(rawDb || {})) {
    if (!Array.isArray(list) || type === 'users') continue;
    if (tenancy.UNSCOPED.has(type) && type !== 'organizations') continue;
    for (const e of list) {
      const orgId = type === 'organizations' ? e.id : tenancy.orgOf(type, e);
      if (!orgId) continue;
      let json;
      try { json = JSON.stringify(e); } catch { continue; }
      if (!json || !json.includes('/uploads/')) continue;
      let set = out.get(orgId);
      if (!set) out.set(orgId, set = new Set());
      for (const m of json.matchAll(UPLOAD_REF_RE)) set.add(m[1]);
    }
  }
  return out;
}
let _orgStorage = { at: 0, byOrg: new Map() };
const ORG_STORAGE_TTL_MS = 10 * 60 * 1000;
function orgStorageAll(force) {
  if (!force && Date.now() - _orgStorage.at < ORG_STORAGE_TTL_MS) return _orgStorage.byOrg;
  const byOrg = new Map();
  for (const [orgId, names] of uploadRefsByOrg()) {
    let bytes = 0, files = 0;
    for (const n of names) { const b = _uploadFileBytes(n); if (b) { bytes += b; files++; } }
    byOrg.set(orgId, { bytes, files });
  }
  _orgStorage = { at: Date.now(), byOrg };
  return byOrg;
}
const orgStorage = (orgId) => orgStorageAll().get(orgId) || { bytes: 0, files: 0 };
// Upload recém-feito ainda não está em nenhum item: soma na hora pro limite valer.
function noteOrgUpload(orgId, bytes) {
  const byOrg = orgStorageAll();
  const cur = byOrg.get(orgId) || { bytes: 0, files: 0 };
  byOrg.set(orgId, { bytes: cur.bytes + bytes, files: cur.files + 1 });
}
function orgUsage(org) {
  const st = orgStorage(org.id);
  return { plan: orgPlan(org), seats: orgSeats(org.id), storage: { bytes: st.bytes, files: st.files } };
}
/* Mensagem de limite (ou null). `extra` = quantos lugares a ação vai ocupar. */
function seatLimitError(org, extra = 1) {
  if (!org) return null;
  const plan = orgPlan(org);
  if (plan.users == null) return null;
  const s = orgSeats(org.id);
  if (s.used + extra <= plan.users) return null;
  const pend = s.pending ? `, contando ${s.pending} ${s.pending === 1 ? 'convite pendente' : 'convites pendentes'}` : '';
  return `A organização chegou ao limite de ${plan.users} pessoas do plano ${plan.name}${pend}. Desative alguém, cancele um convite ou fale com o suporte do reWork para aumentar o limite.`;
}
function storageLimitError(org, incomingBytes) {
  if (!org) return null;
  const plan = orgPlan(org);
  if (plan.storageBytes == null) return null;
  const used = orgStorage(org.id).bytes;
  if (used + (incomingBytes || 0) <= plan.storageBytes) return null;
  return `Sem espaço: a organização já usa ${fmtBytes(used)} dos ${fmtBytes(plan.storageBytes)} do plano ${plan.name}. Apague arquivos que não usa mais ou fale com o suporte do reWork para aumentar o limite.`;
}

/* Exclusão definitiva (console, 30 dias depois de excluir ou "apagar agora"):
   tira do banco tudo o que é da organização, os vínculos, os convites, o sino
   dela e os arquivos que só ela usava. Quem não faz parte de mais nenhuma
   organização tem a conta apagada junto (senha, sessões, chaves de acesso). */
function purgeOrg(org) {
  const orgId = org.id;
  const r = rawDb;
  const refs = uploadRefsByOrg();
  const mine = refs.get(orgId) || new Set();
  const keep = new Set();
  for (const [id, set] of refs) if (id !== orgId) set.forEach(n => keep.add(n));
  for (const u of r.users || []) {
    let json = '';
    try { json = JSON.stringify(u); } catch {}
    for (const m of json.matchAll(UPLOAD_REF_RE)) keep.add(m[1]);
  }
  // Calcula tudo antes de remover: é o squad que diz a organização de cada item.
  const doomed = [];
  for (const t of ENTITY_TYPES) {
    if (t === 'users' || t === 'organizations' || tenancy.UNSCOPED.has(t) || !Array.isArray(r[t])) continue;
    const gone = new Set(r[t].filter(e => tenancy.orgOf(t, e) === orgId));
    if (gone.size) doomed.push([t, gone]);
  }
  const memberIds = new Set((r.memberships || []).filter(m => m.orgId === orgId).map(m => m.userId));
  let items = 0;
  for (const [t, gone] of doomed) {
    r[t] = r[t].filter(e => !gone.has(e));
    gone.forEach(e => removeEntity(t, e.id));
    items += gone.size;
  }
  let accounts = 0;
  for (const userId of memberIds) {
    const u = (r.users || []).find(x => x.id === userId);
    if (!u) continue;
    if (tenancy.membershipsOf(userId).length) {
      if (u.lastOrgId === orgId) { u.lastOrgId = null; saveEntity('users', u); }
      continue;
    }
    r.users = r.users.filter(x => x !== u);
    removeEntity('users', userId);
    auth.removeCredentials(userId);
    try { auth.webauthnRemoveAll(userId); } catch {}
    store.deleteAllNotificationsFor(userId).catch(() => {});
    accounts++;
  }
  store.deleteNotificationsForOrg(orgId).catch(e => console.warn('[orgs] limpar notificações:', e.message));
  let files = 0;
  for (const n of mine) {
    if (keep.has(n)) continue;
    for (const dir of [UPLOADS_DIR, UPLOADS_TRASH_DIR]) {
      try { fs.unlinkSync(path.join(dir, n)); files++; } catch {}
    }
    _uploadBytes.delete(n);
  }
  // Pedido da lista de espera que originou a organização fica (histórico).
  for (const req of (r.accessRequests || []).filter(x => x.orgId === orgId)) {
    req.orgPurgedAt = nowISO(); req.orgNameAtPurge = org.name;
    saveEntity('accessRequests', req);
  }
  r.organizations = (r.organizations || []).filter(o => o !== org);
  removeEntity('organizations', orgId);
  _orgStorage.at = 0;
  console.log(`  [orgs] "${org.name}" apagada de vez: ${items} item(ns), ${accounts} conta(s), ${files} arquivo(s)`);
  return { items, accounts, files };
}
/* Ajustes da organização (com padrões).
   Jornada: modo "simple" (horas por dia, seg–sex) ou "custom" (cada dia da
   semana com início/término/intervalo próprios; as horas saem da conta).
   Guardado como schedule.week = { "1": {start,end,breakMinutes}, … } só com
   os dias de trabalho (0=dom … 6=sáb). O formato anterior (days + um
   horário único) é lido e convertido. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const _mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
function _dayHours(d) { return Math.max(0, (_mins(d.end) - _mins(d.start) - (Number(d.breakMinutes) || 0)) / 60); }
function _storedWeek(sc) {
  if (sc.week && typeof sc.week === 'object') return sc.week;
  // formato anterior: mesmos horários pros dias escolhidos
  if (Array.isArray(sc.days) && sc.days.length && HHMM_RE.test(sc.start) && HHMM_RE.test(sc.end)) {
    return Object.fromEntries(sc.days.map(d => [String(d), { start: sc.start, end: sc.end, breakMinutes: Number(sc.breakMinutes) || 0 }]));
  }
  return null;
}
/* Nomes de etapa pré-definidos (seletor nos fluxos, modelos de cliente,
   personalização e detalhes da demanda). Cada organização tem a sua lista;
   moderadores e admins editam. "Personalizado" continua livre pra todos.
   done = nome de etapa de conclusão (escolher marca a etapa como final). */
const DEFAULT_STAGE_PRESETS = [
  ['A fazer', '#64748B'],
  ['Elaboração de Pauta', '#6366F1'],
  ['Direcionamento de Conteúdo', '#0EA5E9'],
  ['Direcionamento', '#38BDF8'],
  ['[Aprovação] Pauta', '#F59E0B'],
  ['Conteúdo', '#3B82F6'],
  ['[Aprovação Interna] Conteúdo', '#F59E0B'],
  ['[Aprovação Externa] Conteúdo', '#F97316'],
  ['[Ajuste] Conteúdo', '#EF4444'],
  ['Criação', '#2563EB'],
  ['[Aprovação Interna] Criação', '#F59E0B'],
  ['[Aprovação Externa] Criação', '#F97316'],
  ['[Ajuste] Criação', '#DC2626'],
  ['[Revisão] Conteúdo', '#EC4899'],
  ['[Criação] Fechamento de Arquivo', '#1D4ED8'],
  ['Migração e Integração', '#14B8A6'],
  ['Configuração de Tag Manager', '#0D9488'],
  ['Desenvolvimento', '#06B6D4'],
  ['Blueprint', '#8B5CF6'],
  ['Programar Postagens', '#10B981'],
  ['Veiculação', '#22C55E'],
  ['Conferência', '#F43F5E'],
  ['Validação', '#E11D48'],
  ['Concluída', '#22D3A5', true],
  ['Cancelada', '#9CA3AF', true]
].map(([label, color, done], i) => ({ id: 'sp' + (i + 1), label, color, done: !!done }));
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STAGE_PRESETS_MAX = 60;
function validStagePresets(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const seen = new Set();
  const out = [];
  for (const p of list.slice(0, STAGE_PRESETS_MAX)) {
    const label = String((p && p.label) || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: /^[\w-]{1,40}$/.test(String(p.id || '')) ? String(p.id) : 'sp' + crypto.randomBytes(4).toString('hex'), label, color: HEX_COLOR_RE.test(p.color) ? p.color : '#7A00FF', done: !!p.done });
  }
  return out.length ? out : null;
}
function orgSettings(org) {
  const st = (org && org.settings) || {};
  const dh = Number(st.dailyHours);
  const simpleHours = dh >= 1 && dh <= 16 ? dh : 8;
  const sc = st.schedule || {};
  const stored = sc.mode === 'custom' ? _storedWeek(sc) : null;
  const custom = !!(stored && Object.keys(stored).length);
  const week = WEEK_ORDER.map(day => {
    const d = custom ? stored[String(day)] : null;
    if (custom && d && HHMM_RE.test(d.start) && HHMM_RE.test(d.end)) {
      const breakMinutes = Number(d.breakMinutes) || 0;
      return { day, on: true, start: d.start, end: d.end, breakMinutes, hours: Math.round(_dayHours({ ...d, breakMinutes }) * 100) / 100 };
    }
    if (!custom && day >= 1 && day <= 5) return { day, on: true, start: null, end: null, breakMinutes: null, hours: simpleHours };
    return { day, on: false, start: null, end: null, breakMinutes: null, hours: 0 };
  });
  const on = week.filter(d => d.on);
  const weeklyHours = Math.round(on.reduce((a, d) => a + d.hours, 0) * 100) / 100;
  return {
    // Média por dia de trabalho (compatível com quem ainda lê um número só).
    dailyHours: custom ? Math.round((weeklyHours / Math.max(1, on.length)) * 100) / 100 : simpleHours,
    weeklyHours,
    modsCanInvite: st.modsCanInvite !== false,
    stagePresets: validStagePresets(st.stagePresets) || DEFAULT_STAGE_PRESETS,
    schedule: { mode: custom ? 'custom' : 'simple', week, simpleHours }
  };
}
function orgPublic(org, role) {
  return {
    id: org.id, name: org.name, logo: org.logo || null, ownerId: org.ownerId || null, createdAt: org.createdAt, role: role || null,
    settings: orgSettings(org),
    planInfo: (({ id, name, trial, trialEndsAt, trialDaysLeft, readOnly, fileBytes }) => ({ id, name, trial, trialEndsAt, trialDaysLeft, readOnly, fileBytes }))(orgPlan(org)),
    ...(role === 'owner' || role === 'admin' ? { usage: orgUsage(org) } : {}),
    // O que está disponível nesta organização (bot e n8n são da instalação original).
    integrations: {
      discord: !!org.isDefault && discordBot.isEnabled(),
      performance: !!org.isDefault,
      email: mailEnabled(),
      google: googleCal.isConfigured()
    }
  };
}
function myOrgs(user) {
  return tenancy.activeMemberships(user.id)
    .map(m => ({ m, org: tenancy.orgById(m.orgId) }))
    .filter(x => x.org)
    .sort((a, b) => a.org.name.localeCompare(b.org.name, 'pt-BR'))
    .map(x => orgPublic(x.org, x.m.role));
}
app.get('/api/orgs', requireAuth, (req, res) => {
  res.json({ current: req.org.id, items: myOrgs(req.user) });
});
app.post('/api/orgs/switch', requireAuth, (req, res) => {
  const orgId = String((req.body || {}).orgId || '');
  const m = tenancy.activeMemberships(req.user.id).find(x => x.orgId === orgId);
  if (!m) return res.status(404).json({ error: 'Organização não encontrada.' });
  auth.setSessionData(req.token, { orgId });
  req.user.lastOrgId = orgId;
  saveEntity('users', req.user);
  res.json({ ok: true, org: orgPublic(tenancy.orgById(orgId), m.role) });
});
app.get('/api/org', requireAuth, (req, res) => {
  const owner = allUsers().find(u => u.id === req.org.ownerId);
  res.json({ ...orgPublic(req.org, req.membership.role), ownerName: owner ? owner.name : null });
});
/* Configurações da organização: só o dono. */
app.put('/api/org', requireAuth, (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'Só o dono muda as configurações da organização.' });
  const { name, logo, settings } = req.body || {};
  if (settings && typeof settings === 'object') {
    const next = { ...(req.org.settings || {}) };
    if (settings.dailyHours !== undefined) {
      const dh = Math.round(Number(settings.dailyHours) * 2) / 2;
      if (!(dh >= 1 && dh <= 16)) return res.status(400).json({ error: 'A jornada precisa ficar entre 1 e 16 horas por dia.', field: 'dailyHours' });
      next.dailyHours = dh;
    }
    if (typeof settings.modsCanInvite === 'boolean') next.modsCanInvite = settings.modsCanInvite;
    if (settings.schedule && typeof settings.schedule === 'object') {
      const sc = settings.schedule;
      if (sc.mode === 'simple') {
        next.schedule = { ...(next.schedule || {}), mode: 'simple' };
      } else if (sc.mode === 'custom') {
        const DAY_NAME = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
        const list = Array.isArray(sc.week) ? sc.week : [];
        const week = {};
        for (const d of list) {
          const day = Number(d && d.day);
          if (!Number.isInteger(day) || day < 0 || day > 6 || !d.on) continue;
          const nm = DAY_NAME[day];
          if (!HHMM_RE.test(d.start) || !HHMM_RE.test(d.end)) return res.status(400).json({ error: `Informe o início e o término de ${nm}.`, field: 'week', day });
          if (_mins(d.end) <= _mins(d.start)) return res.status(400).json({ error: `Em ${nm}, o término precisa ser depois do início.`, field: 'week', day });
          const brk = Number(d.breakMinutes) || 0;
          if (brk < 0 || brk > 240) return res.status(400).json({ error: `O intervalo de ${nm} precisa ficar entre 0 e 4 horas.`, field: 'week', day });
          const hours = _dayHours({ start: d.start, end: d.end, breakMinutes: brk });
          if (hours < 0.5 || hours > 16) return res.status(400).json({ error: `A jornada de ${nm} precisa ficar entre 30 min e 16 horas.`, field: 'week', day });
          week[String(day)] = { start: d.start, end: d.end, breakMinutes: brk };
        }
        if (!Object.keys(week).length) return res.status(400).json({ error: 'Deixe pelo menos um dia de trabalho ligado.', field: 'week' });
        next.schedule = { mode: 'custom', week };
      }
    }
    req.org.settings = next;
  }
  if (name !== undefined) {
    const nm = String(name || '').trim().slice(0, 80);
    if (nm.length < 2) return res.status(400).json({ error: 'O nome precisa ter pelo menos 2 caracteres.', field: 'name' });
    req.org.name = nm;
  }
  if (logo !== undefined) {
    if (logo && !/^\/uploads\/[\w.-]+$/.test(String(logo))) return res.status(400).json({ error: 'Logo inválido.' });
    req.org.logo = logo || null;
  }
  req.org.updatedAt = nowISO();
  saveEntity('organizations', req.org);
  res.json(orgPublic(req.org, req.membership.role));
});
/* Lista de nomes de etapa: moderadores e admins. */
app.put('/api/org/stage-presets', requireAuth, modOrAdmin, (req, res) => {
  const raw = (req.body || {}).presets;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'Lista inválida.' });
  if (raw.length > STAGE_PRESETS_MAX) return res.status(400).json({ error: `No máximo ${STAGE_PRESETS_MAX} nomes.` });
  const names = raw.map(p => String((p && p.label) || '').trim().toLowerCase()).filter(Boolean);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return res.status(400).json({ error: `O nome "${dup}" aparece duas vezes.` });
  if (raw.some(p => !String((p && p.label) || '').trim())) return res.status(400).json({ error: 'Todo nome precisa de um texto.' });
  const list = validStagePresets(raw);
  if (!list) return res.status(400).json({ error: 'Deixe pelo menos um nome na lista.' });
  req.org.settings = { ...(req.org.settings || {}), stagePresets: list };
  req.org.updatedAt = nowISO();
  saveEntity('organizations', req.org);
  res.json(orgPublic(req.org, req.membership.role));
});

/* Exportar os dados da organização (dono e admins). Não inclui o cofre de
   senhas, credenciais nem dados pessoais de outras organizações. */
const ORG_EXPORT_SKIP = new Set(['passwords', 'passwordAudits', 'passwordFolders', 'googleEvents', 'invites', 'memberships', 'users']);
function buildOrgExport(org, exportedBy) {
  return tenancy.run(org.id, () => {
    const out = {
      exportedAt: nowISO(), exportedBy,
      organization: { id: org.id, name: org.name, createdAt: org.createdAt, settings: orgSettings(org), plan: orgPlan(org) },
      people: db.users.map(u => ({
        id: u.id, name: u.name, username: u.username, email: u.email || null,
        access: u.orgRole, area: u.role || '', position: u.position || null,
        squads: (u.workspaces || []).slice(), active: u.active !== false
      }))
    };
    for (const t of ENTITY_TYPES) {
      if (ORG_EXPORT_SKIP.has(t) || tenancy.UNSCOPED.has(t) || t === 'organizations') continue;
      const list = db[t];
      if (Array.isArray(list) && list.length) out[t] = list.filter(notDeleted);
    }
    return out;
  });
}
const orgExportFilename = (org) => {
  const slug = String(org.name || 'organizacao').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'organizacao';
  return `rework-${slug}-${today()}.json`;
};
app.get('/api/org/export', requireAuth, (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'Só o dono exporta os dados da organização.' });
  res.set('Content-Disposition', `attachment; filename="${orgExportFilename(req.org)}"`);
  res.type('application/json').send(JSON.stringify(buildOrgExport(req.org, req.user.name), null, 2));
});

/* Transferir a posse: o dono atual vira administrador. */
app.post('/api/org/transfer', requireAuth, (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'Só o dono pode transferir a organização.' });
  const target = tenancy.memberIn(String((req.body || {}).userId || ''), req.org.id);
  if (!target || target.active === false) return res.status(404).json({ error: 'Escolha uma pessoa ativa da organização.' });
  if (target.userId === req.user.id) return res.status(400).json({ error: 'Você já é o dono.' });
  if (!auth.verifyPassword(req.user.id, (req.body || {}).password)) return res.status(400).json({ error: 'Senha incorreta.', field: 'password' });
  req.membership.role = 'admin';
  target.role = 'owner';
  target.workspaces = [];
  req.org.ownerId = target.userId;
  saveEntity('memberships', req.membership);
  saveEntity('memberships', target);
  saveEntity('organizations', req.org);
  res.json({ ok: true });
});

/* Organização nova (console → lista de espera aprovada): squad "Geral", fluxo
   padrão e convite de DONO pro e-mail do pedido. */
function defaultFlowStages() {
  return [
    { id: uid(), label: 'Backlog',     color: '#64748B', done: false, responsibleId: null, deadlineDays: null },
    { id: uid(), label: 'Em produção', color: '#7A00FF', done: false, responsibleId: null, deadlineDays: 3 },
    { id: uid(), label: 'Em revisão',  color: '#F59E0B', done: false, responsibleId: null, deadlineDays: 1 },
    { id: uid(), label: 'Aprovação',   color: '#38BDF8', done: false, responsibleId: null, deadlineDays: 2 },
    { id: uid(), label: 'Concluída',   color: '#22D3A5', done: true,  responsibleId: null, deadlineDays: null }
  ];
}
async function createOrgWithOwner(req, { name, ownerEmail, ownerName, requestId, createdBy }) {
  const now = nowISO();
  const org = { id: 'org_' + uid(), name: String(name).trim().slice(0, 80), logo: null, ownerId: null, status: 'active', createdAt: now, createdBy: createdBy || 'console', fromRequestId: requestId || null };
  rawDb.organizations.push(org);
  saveEntity('organizations', org);
  const ws = { id: uid(), orgId: org.id, name: 'Geral', color: '#7A00FF', createdAt: now };
  rawDb.workspaces.push(ws);
  saveEntity('workspaces', ws);
  const flow = { id: uid(), workspaceId: ws.id, projectId: null, clientId: null, client: null, icon: null, name: 'Fluxo padrão', demandType: 'Geral', stages: defaultFlowStages(), defaultDescription: '', defaultChecklist: [], createdAt: now };
  rawDb.flows.push(flow);
  saveEntity('flows', flow);
  const dt = { id: uid(), orgId: org.id, name: 'Geral', createdAt: now };
  rawDb.demandTypes.push(dt);
  saveEntity('demandTypes', dt);
  const { inv, token } = newInviteRecord({ email: normEmail(ownerEmail), kind: 'owner', workspaces: [], name: String(ownerName || '').trim().slice(0, 120), role: '', position: null }, org.id, null);
  inv.invitedByName = 'Equipe reWork';
  rawDb.invites.push(inv);
  const mail = await sendInviteEmail(req, inv, token);
  if (mail.sent) { inv.lastSentAt = nowISO(); inv.sendCount = 1; }
  saveEntity('invites', inv);
  return { org, link: inviteLinkFor(req, token), emailSent: !!mail.sent };
}

/* ── reWork CONSOLE (/console) + lista de espera (/acesso) ──
   Painel da plataforma com contas e sessão próprias — ver platform-console.js. */
consoleApi = require('./platform-console')(app, {
  getDb: () => rawDb, tenancy, createOrgWithOwner, store, auth, saveEntity, removeEntity, uid, nowISO, notDeleted,
  plans: PLANS, orgPlan, orgUsage, buildOrgExport, orgExportFilename, purgeOrg, fmtBytes, TRIAL_DAYS, uploadMaxMb: UPLOAD_MAX_BYTES / MB,
  makeRateLimit, clientIp, parseCookies, isHttpsRequest, isValidEmail,
  mailEnabled, sendEmail, emailTpl, appBaseUrl,
  uploadsDir: UPLOADS_DIR, buildSha: BUILD_SHA, publicDir: path.join(__dirname, 'public'),
  integrations: () => ({
    smtp: mailEnabled(),
    discordBot: discordBot.isEnabled(),
    discordLogin: discordOAuth.isConfigured(),
    googleLogin: googleLogin.isConfigured(),
    google: googleCal.isConfigured()
  })
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
  if (!ws) return res.status(400).json({ error: 'Equipe inválida' });
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

/* ── FORMULÁRIOS (fase 2) ──
   formTemplates são definições reutilizáveis: cada um tem um array `fields`
   com {id, label, type, required, options?}. As respostas (formResponses) vão
   em rota separada. Templates só admin cria/edita/deleta (delete é soft pra
   preservar referência das respostas antigas). */
const FORM_FIELD_TYPES = ['text', 'number', 'select', 'multiselect'];
function sanitizeFormFields(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIds = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const label = String(f.label || '').trim();
    if (!label) continue;
    const type = FORM_FIELD_TYPES.includes(f.type) ? f.type : 'text';
    // ID vem do cliente pra sobreviver a renames; se não veio ou colide, gera.
    let id = typeof f.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(f.id) ? f.id : uid();
    if (seenIds.has(id)) id = uid();
    seenIds.add(id);
    const field = { id, label, type, required: !!f.required };
    if (type === 'select' || type === 'multiselect') {
      const opts = Array.isArray(f.options) ? f.options : [];
      field.options = opts.map(o => {
        if (typeof o === 'string') return { value: o, label: o };
        const value = String(o?.value ?? '').trim();
        const optLabel = String(o?.label ?? value).trim();
        return value ? { value, label: optLabel || value } : null;
      }).filter(Boolean);
    }
    out.push(field);
  }
  return out;
}

app.get('/api/form-templates', requireAuth, (req, res) => {
  // Formulários são UNIVERSAIS — visíveis a todos autenticados independente do squad.
  // O workspaceId no template é meramente informativo (onde foi criado).
  res.json((db.formTemplates || []).filter(notDeleted));
});

app.post('/api/form-templates', requireAuth, adminOnly, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome do formulário é obrigatório' });
  const ws = b.workspaceId && canAccessWs(req.user, b.workspaceId) ? b.workspaceId : wsIdsFor(req.user)[0];
  if (!ws) return res.status(400).json({ error: 'Equipe inválida' });
  const fields = sanitizeFormFields(b.fields);
  const t = {
    id: uid(),
    workspaceId: ws,
    name,
    description: String(b.description || '').trim(),
    fields,
    createdBy: req.user.id,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  if (!Array.isArray(db.formTemplates)) db.formTemplates = [];
  db.formTemplates.push(t);
  saveEntity('formTemplates', t);
  broadcastChange('formTemplate', 'create', { id: t.id, workspaceId: t.workspaceId, byUserId: req.user.id });
  res.status(201).json(t);
});

app.put('/api/form-templates/:id', requireAuth, adminOnly, (req, res) => {
  const t = (db.formTemplates || []).find(x => x.id === req.params.id && notDeleted(x));
  // Universal: admin de qualquer squad pode editar.
  if (!t) return res.status(404).json({ error: 'Formulário não encontrado' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim();
  if (typeof b.description === 'string') t.description = b.description.trim();
  if (b.fields !== undefined) t.fields = sanitizeFormFields(b.fields);
  t.updatedAt = nowISO();
  saveEntity('formTemplates', t);
  broadcastChange('formTemplate', 'update', { id: t.id, workspaceId: t.workspaceId, byUserId: req.user.id });
  res.json(t);
});

app.delete('/api/form-templates/:id', requireAuth, adminOnly, (req, res) => {
  const t = (db.formTemplates || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!t) return res.status(404).json({ error: 'Formulário não encontrado' });
  softDelete('formTemplates', t, req.user.id);
  broadcastChange('formTemplate', 'delete', { id: t.id, workspaceId: t.workspaceId, byUserId: req.user.id });
  res.json({ ok: true });
});

/* ── RESPOSTAS DE FORMULÁRIOS ──
   Qualquer usuário da equipe pode preencher. Deletar só o autor ou admin.
   Sem PUT no MVP: pra "corrigir" uma resposta, o usuário deleta e resubmete
   (mantém a auditoria simples). Values são validados contra os fields do
   template atual — se o template mudou depois, campos ausentes viram null. */
function sanitizeResponseValues(template, rawValues) {
  const values = {};
  const missingRequired = [];
  const errors = [];
  for (const f of (template.fields || [])) {
    const raw = rawValues?.[f.id];
    const isEmpty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
    if (isEmpty) {
      if (f.required) missingRequired.push(f.label);
      values[f.id] = f.type === 'multiselect' ? [] : null;
      continue;
    }
    if (f.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) { errors.push(`Campo "${f.label}" precisa ser numérico`); values[f.id] = null; }
      else values[f.id] = n;
    } else if (f.type === 'text') {
      values[f.id] = String(raw).slice(0, 4000);
    } else if (f.type === 'select') {
      const allowed = new Set((f.options || []).map(o => o.value));
      const v = String(raw);
      values[f.id] = allowed.has(v) ? v : null;
      if (!allowed.has(v)) errors.push(`Opção inválida em "${f.label}"`);
    } else if (f.type === 'multiselect') {
      const allowed = new Set((f.options || []).map(o => o.value));
      const arr = Array.isArray(raw) ? raw : [raw];
      values[f.id] = arr.map(String).filter(v => allowed.has(v));
    } else {
      values[f.id] = null;
    }
  }
  return { values, missingRequired, errors };
}

app.get('/api/form-responses', requireAuth, (req, res) => {
  // Responses seguem escopadas por squad da DEMANDA (não do template) — user só
  // enxerga respostas de demandas nos squads dele. Standalone (sem demandId)
  // usa o workspaceId no próprio registro.
  const ids = wsIdsFor(req.user);
  let list = (db.formResponses || []).filter(r => notDeleted(r) && ids.includes(r.workspaceId));
  if (req.query.demandId)   list = list.filter(r => r.demandId === req.query.demandId);
  if (req.query.templateId) list = list.filter(r => r.templateId === req.query.templateId);
  res.json(list);
});

app.post('/api/form-responses', requireAuth, (req, res) => {
  const b = req.body || {};
  const template = (db.formTemplates || []).find(t => t.id === b.templateId && notDeleted(t));
  if (!template) return res.status(404).json({ error: 'Formulário não encontrado' });
  // Universal: qualquer user autenticado pode usar o template. workspaceId da
  // resposta vem da DEMANDA (não do template) — templates cross-squad são a norma.
  let demandId = null;
  let workspaceId = null;
  if (b.demandId) {
    const d = (db.demands || []).find(x => x.id === b.demandId);
    if (!d) return res.status(400).json({ error: 'Demanda inválida' });
    if (!canAccessWs(req.user, d.workspaceId)) return res.status(403).json({ error: 'Sem acesso à equipe da demanda' });
    demandId = d.id;
    workspaceId = d.workspaceId;
  } else {
    // Standalone: mantém no squad do template (compat) e valida acesso.
    workspaceId = template.workspaceId;
    if (workspaceId && !canAccessWs(req.user, workspaceId)) return res.status(403).json({ error: 'Sem acesso a esta equipe' });
  }
  const { values, missingRequired, errors } = sanitizeResponseValues(template, b.values);
  if (missingRequired.length) return res.status(400).json({ error: `Campos obrigatórios: ${missingRequired.join(', ')}` });
  if (errors.length) return res.status(400).json({ error: errors[0] });
  const r = {
    id: uid(),
    workspaceId,
    templateId: template.id,
    demandId,
    values,
    submittedBy: req.user.id,
    submittedAt: nowISO()
  };
  if (!Array.isArray(db.formResponses)) db.formResponses = [];
  db.formResponses.push(r);
  saveEntity('formResponses', r);
  broadcastChange('formResponse', 'create', { id: r.id, workspaceId: r.workspaceId, demandId: r.demandId, byUserId: req.user.id });
  res.status(201).json(r);
});

app.delete('/api/form-responses/:id', requireAuth, (req, res) => {
  const r = (db.formResponses || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!r || !canAccessWs(req.user, r.workspaceId)) return res.status(404).json({ error: 'Resposta não encontrada' });
  if (r.submittedBy !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Sem permissão pra excluir esta resposta' });
  softDelete('formResponses', r, req.user.id);
  broadcastChange('formResponse', 'delete', { id: r.id, workspaceId: r.workspaceId, demandId: r.demandId, byUserId: req.user.id });
  res.json({ ok: true });
});

/* ── DASHBOARDS ──
   Painéis com widgets sobre respostas de formulários. Admin e moderador criam
   e editam (todos visualizam). A agregação mora no client; o server só valida
   a estrutura (sanitizeDashboardWidgets, abaixo). */
const DASHBOARD_GRID_COLS = 12;
/* Grid layout: x/y 0-indexed; w em colunas (1..12), h em linhas de 56px
   (1..40). Se ausente, deixa null e o cliente posiciona no fim. */
function sanitizeWidgetLayout(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number.isInteger(raw.x) ? raw.x : null;
  const y = Number.isInteger(raw.y) ? raw.y : null;
  const w = Number.isInteger(raw.w) ? raw.w : null;
  const h = Number.isInteger(raw.h) ? raw.h : null;
  if (x === null || y === null || w === null || h === null) return null;
  return {
    x: Math.max(0, Math.min(DASHBOARD_GRID_COLS - 1, x)),
    y: Math.max(0, y),
    w: Math.max(1, Math.min(DASHBOARD_GRID_COLS - x, w)),
    h: Math.max(1, Math.min(40, h))
  };
}
/* ── DASHBOARDS v2 (só formulários) ──
   Widget = { id, title, templateId, viz, metrics[], groupBy, seriesBy, bucket,
   orientation, limit, layout }.
     viz      number | bar | line | table
     metrics  1-4 × { agg: count|sum|avg|min|max, fieldId? (campo numérico), label? }
     groupBy  categorias (barras) ou linhas (tabela)
     seriesBy uma série por valor (barras/linha) ou colunas (tabela); usa só a 1ª métrica
   Dimensões: workspace, client, project, submittedBy, owner, flow, stage, month,
   week, field:<id>. Widgets no formato antigo (chartType) são convertidos aqui,
   na leitura e na gravação; os de fonte demanda/horas saem (fora do escopo). */
const DV_VIZ = ['number', 'bar', 'line', 'table'];
const DV_AGGS = ['count', 'sum', 'avg', 'min', 'max'];
const DV_BUCKETS = ['auto', 'day', 'week', 'month'];
const DV_ORIENT = ['auto', 'horizontal', 'vertical'];
const DV_DIM_RE = /^(workspace|client|project|submittedBy|owner|flow|stage|month|week|field:[a-z0-9_-]{1,40})$/i;
const DV_ID_RE = /^[a-z0-9_-]{1,40}$/i;
const _dvDim = v => (typeof v === 'string' && DV_DIM_RE.test(v) ? v : null);
function _dvMetric(m) {
  if (!m || typeof m !== 'object') return null;
  const agg = DV_AGGS.includes(m.agg) ? m.agg : 'count';
  const fieldId = agg !== 'count' && typeof m.fieldId === 'string' && DV_ID_RE.test(m.fieldId) ? m.fieldId : null;
  if (agg !== 'count' && !fieldId) return null;
  const label = String(m.label || '').trim().slice(0, 60);
  return { agg, ...(fieldId ? { fieldId } : {}), ...(label ? { label } : {}) };
}
// Formato antigo → v2. Dimensões antigas viram as novas; o que não tem par cai.
const _DV_LEGACY_DIMS = { clientName: 'client', projectName: 'project', workspaceName: 'workspace', submitterName: 'submittedBy', flowName: 'flow', month: 'month', week: 'week' };
const _dvLegacyDim = v => (typeof v === 'string' ? (v.startsWith('field:') ? v : (_DV_LEGACY_DIMS[v] || null)) : null);
function _dvLegacyMetric(metric, aggregate, label) {
  if (typeof metric === 'string' && metric.startsWith('field:')) {
    return { agg: aggregate === 'avg' ? 'avg' : 'sum', fieldId: metric.slice(6), label };
  }
  return { agg: 'count', label };
}
function migrateLegacyDashboardWidget(w) {
  const src = w.source || {};
  if ((src.kind || 'form') !== 'form' || !src.templateId) return null;
  const base = { id: w.id, title: w.title, templateId: src.templateId, layout: w.layout };
  const ct = w.chartType;
  if (ct === 'kpi') {
    const series = Array.isArray(w.kpiSeries) && w.kpiSeries.length
      ? w.kpiSeries.map(x => ({ agg: x.aggregate || 'count', fieldId: x.fieldId, label: x.label }))
      : [{ agg: w.kpiAggregate || 'count', fieldId: src.fieldId }];
    return { ...base, viz: 'number', metrics: series };
  }
  if (ct === 'bar' || ct === 'barh' || ct === 'pie') {
    return { ...base, viz: 'bar', metrics: [{ agg: 'count' }],
      groupBy: src.fieldId ? 'field:' + src.fieldId : null,
      seriesBy: w.groupByFieldId ? 'field:' + w.groupByFieldId : null,
      orientation: ct === 'barh' ? 'horizontal' : ct === 'bar' ? 'vertical' : 'auto' };
  }
  if (ct === 'line') {
    return { ...base, viz: 'line', metrics: [{ agg: w.lineAggregate || 'count', fieldId: src.fieldId }],
      seriesBy: w.groupByFieldId ? 'field:' + w.groupByFieldId : null, bucket: w.lineBucket };
  }
  if (ct === 'timeline') {
    const tl = w.timeline || {};
    return { ...base, viz: 'line', bucket: tl.bucket, seriesBy: _dvLegacyDim(tl.splitBy),
      metrics: (tl.metrics || []).map(m => _dvLegacyMetric(m.metric, m.aggregate, m.label)) };
  }
  if (ct === 'pivot' || ct === 'heatmap') {
    const pv = w.pivot || {};
    return { ...base, viz: 'table', groupBy: _dvLegacyDim(pv.rowDim), seriesBy: _dvLegacyDim(pv.colDim),
      metrics: [_dvLegacyMetric(pv.metric, pv.aggregate)] };
  }
  if (ct === 'combo') {
    const cb = w.combo || {};
    return { ...base, viz: 'table', groupBy: _dvLegacyDim(cb.primary),
      metrics: [_dvLegacyMetric(cb.bar?.metric, cb.bar?.aggregate), _dvLegacyMetric(cb.line?.metric, cb.line?.aggregate)] };
  }
  return null; // scatter e afins não têm equivalente
}
function sanitizeDashboardWidgets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (let w of raw.slice(0, 40)) {
    if (!w || typeof w !== 'object') continue;
    if (!w.viz && w.chartType) w = migrateLegacyDashboardWidget(w);
    if (!w || typeof w.templateId !== 'string' || !DV_ID_RE.test(w.templateId)) continue;
    let id = typeof w.id === 'string' && DV_ID_RE.test(w.id) ? w.id : uid();
    if (seen.has(id)) id = uid();
    seen.add(id);
    const metrics = (Array.isArray(w.metrics) ? w.metrics : []).map(_dvMetric).filter(Boolean).slice(0, 4);
    const widget = {
      id,
      title: String(w.title || '').trim().slice(0, 120),
      templateId: w.templateId,
      viz: DV_VIZ.includes(w.viz) ? w.viz : 'bar',
      metrics: metrics.length ? metrics : [{ agg: 'count' }],
      groupBy: _dvDim(w.groupBy),
      seriesBy: _dvDim(w.seriesBy),
      bucket: DV_BUCKETS.includes(w.bucket) ? w.bucket : 'auto',
      orientation: DV_ORIENT.includes(w.orientation) ? w.orientation : 'auto',
      limit: Number.isInteger(w.limit) && w.limit >= 0 && w.limit <= 50 ? w.limit : 10,
    };
    const layout = sanitizeWidgetLayout(w.layout);
    if (layout) widget.layout = layout;
    out.push(widget);
  }
  return out;
}
// Filtros fixos do dashboard: { dims: { [dim]: [valores] } }.
function sanitizeDashboardFilters(raw) {
  const dims = {};
  const src = raw && typeof raw === 'object' && raw.dims && typeof raw.dims === 'object' ? raw.dims : {};
  for (const k of Object.keys(src).slice(0, 20)) {
    if (!_dvDim(k) || k === 'month' || k === 'week') continue;
    const vals = (Array.isArray(src[k]) ? src[k] : []).map(v => String(v).slice(0, 120)).filter(Boolean).slice(0, 50);
    if (vals.length) dims[k] = vals;
  }
  return { dims };
}
const _dvTemplateId = v => (typeof v === 'string' && DV_ID_RE.test(v) ? v : null);
/* Grade v2 (d.grid === 2): linhas de 56px. Dashboards antigos usavam linhas
   de ~212px; cada uma vira 4 das novas (mesma altura na tela). */
function _dvGridWidgets(d) {
  const ws = Array.isArray(d.widgets) ? d.widgets : [];
  if (d.grid === 2) return ws;
  return ws.map(w => (w && w.layout && Number.isInteger(w.layout.h)
    ? { ...w, layout: { ...w.layout, y: w.layout.y * 4, h: w.layout.h * 4 } } : w));
}
const publicDashboard = d => ({ ...d, grid: 2, widgets: sanitizeDashboardWidgets(_dvGridWidgets(d)), fixedFilters: sanitizeDashboardFilters(d.fixedFilters) });

app.get('/api/dashboards', requireAuth, (req, res) => {
  // Dashboards são UNIVERSAIS — visíveis a todos autenticados. Widgets no
  // formato antigo saem convertidos (a gravação converte de vez).
  res.json((db.dashboards || []).filter(notDeleted).map(publicDashboard));
});

app.post('/api/dashboards', requireAuth, modOrAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome do dashboard é obrigatório' });
  const ws = b.workspaceId && canAccessWs(req.user, b.workspaceId) ? b.workspaceId : wsIdsFor(req.user)[0];
  if (!ws) return res.status(400).json({ error: 'Equipe inválida' });
  const d = {
    id: uid(),
    workspaceId: ws,
    name,
    description: String(b.description || '').trim(),
    templateId: _dvTemplateId(b.templateId),
    fixedFilters: sanitizeDashboardFilters(b.fixedFilters),
    widgets: sanitizeDashboardWidgets(b.widgets),
    grid: 2,
    createdBy: req.user.id,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  if (!Array.isArray(db.dashboards)) db.dashboards = [];
  db.dashboards.push(d);
  saveEntity('dashboards', d);
  broadcastChange('dashboard', 'create', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.status(201).json(publicDashboard(d));
});

app.put('/api/dashboards/:id', requireAuth, modOrAdmin, (req, res) => {
  const d = (db.dashboards || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!d) return res.status(404).json({ error: 'Dashboard não encontrado' });
  const b = req.body || {};
  if (typeof b.name === 'string' && b.name.trim()) d.name = b.name.trim();
  if (typeof b.description === 'string') d.description = b.description.trim();
  if (b.templateId !== undefined) d.templateId = _dvTemplateId(b.templateId);
  if (b.fixedFilters !== undefined) d.fixedFilters = sanitizeDashboardFilters(b.fixedFilters);
  // Sempre regrava widgets e grade no formato v2 (converte os antigos na primeira
  // edição). O cliente já manda os widgets na grade nova.
  d.widgets = sanitizeDashboardWidgets(b.widgets !== undefined ? b.widgets : _dvGridWidgets(d));
  d.grid = 2;
  d.updatedAt = nowISO();
  saveEntity('dashboards', d);
  broadcastChange('dashboard', 'update', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.json(publicDashboard(d));
});

app.delete('/api/dashboards/:id', requireAuth, modOrAdmin, (req, res) => {
  const d = (db.dashboards || []).find(x => x.id === req.params.id && notDeleted(x));
  if (!d) return res.status(404).json({ error: 'Dashboard não encontrado' });
  softDelete('dashboards', d, req.user.id);
  broadcastChange('dashboard', 'delete', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
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
  if (exists) return res.status(409).json({ error: 'Já existe um cliente com esse nome nesta equipe.' });
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
    if (dup) return res.status(409).json({ error: 'Já existe outro cliente com esse nome nesta equipe.' });
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

/* ── LINKS PÚBLICOS DE CLIENTE (read-only) ──
   Cada cliente pode ter N tokens que dão acesso público (sem login) a uma
   página read-only com o pipeline de demandas dele. Token = 32 bytes hex,
   URL-safe, não-adivinhável. Cada link tem `active`; revogar = active=false.
   Nunca deletamos histórico — auditoria.
   Formato: c.publicLinks = [{ id, token, label, active, createdAt, createdBy }] */
function _cliPublicLinks(c) { return Array.isArray(c.publicLinks) ? c.publicLinks : (c.publicLinks = []); }

app.get('/api/clients/:id/public-links', requireAuth, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !notDeleted(c)) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(_cliPublicLinks(c));
});

app.post('/api/clients/:id/public-links', requireAuth, blockFreelancer, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !notDeleted(c)) return res.status(404).json({ error: 'Cliente não encontrado' });
  const label = String((req.body && req.body.label) || '').trim().slice(0, 60);
  const link = {
    id: uid(),
    token: crypto.randomBytes(24).toString('hex'), // 48 hex chars → ~192 bits
    label,
    active: true,
    createdAt: nowISO(),
    createdBy: req.user.id
  };
  _cliPublicLinks(c).push(link);
  saveEntity('clients', c);
  broadcastChange('client', 'update', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  res.status(201).json(link);
});

app.put('/api/clients/:id/public-links/:linkId', requireAuth, blockFreelancer, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !notDeleted(c)) return res.status(404).json({ error: 'Cliente não encontrado' });
  const link = _cliPublicLinks(c).find(l => l.id === req.params.linkId);
  if (!link) return res.status(404).json({ error: 'Link não encontrado' });
  const b = req.body || {};
  if (typeof b.active === 'boolean') link.active = b.active;
  if (typeof b.label === 'string') link.label = b.label.trim().slice(0, 60);
  saveEntity('clients', c);
  broadcastChange('client', 'update', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  res.json(link);
});

app.delete('/api/clients/:id/public-links/:linkId', requireAuth, blockFreelancer, (req, res) => {
  const c = db.clients.find(x => x.id === req.params.id);
  if (!c || !canAccessWs(req.user, c.workspaceId) || !notDeleted(c)) return res.status(404).json({ error: 'Cliente não encontrado' });
  const arr = _cliPublicLinks(c);
  const idx = arr.findIndex(l => l.id === req.params.linkId);
  if (idx === -1) return res.status(404).json({ error: 'Link não encontrado' });
  arr.splice(idx, 1);
  saveEntity('clients', c);
  broadcastChange('client', 'update', { id: c.id, workspaceId: c.workspaceId, byUserId: req.user.id });
  res.json({ ok: true });
});

/* ── ROTA PÚBLICA (sem auth) ── retorna snapshot read-only pra página pública.
   Filtramos campos sensíveis: nada de comentários internos, apontamentos, histórico
   ou responsáveis. Só o essencial pra o cliente enxergar o pipeline dele. */
app.get('/api/public/client/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: 'Link inválido' });
  let hitClient = null, hitLink = null;
  for (const c of db.clients) {
    if (!notDeleted(c)) continue;
    const link = (c.publicLinks || []).find(l => l.token === token && l.active);
    if (link) { hitClient = c; hitLink = link; break; }
  }
  if (!hitClient) return res.status(404).json({ error: 'Link inválido ou revogado' });
  const projectIds = db.projects.filter(p => p.clientId === hitClient.id && notDeleted(p)).map(p => p.id);
  const projectsPublic = db.projects
    .filter(p => projectIds.includes(p.id))
    .map(p => ({ id: p.id, name: p.name }));
  const demandsPublic = db.demands
    .filter(d => projectIds.includes(d.projectId) && notDeleted(d))
    .map(d => {
      const flow = db.flows.find(f => f.id === d.flowId);
      const stage = flow && flow.stages && flow.stages.find(s => s.id === d.status);
      return {
        id: d.id,
        name: d.name,
        projectId: d.projectId,
        stageName: stage ? stage.label : '',
        stageDone: !!(stage && stage.done),
        deadline: d.deadline || null,
        completedAt: d.completedAt || null,
        createdAt: d.createdAt || null,
        priority: d.priority || 3
      };
    });
  res.json({
    client: {
      id: hitClient.id,
      name: hitClient.name,
      color: hitClient.color || '#7A00FF',
      // Aponta pra rota pública — o browser do stakeholder não tem sessão do reWork
      // pra baixar /uploads/... (401). URL absoluta com ?v= pra invalidar cache.
      avatar: hitClient.avatar
        ? (/^https?:\/\//i.test(hitClient.avatar)
            ? hitClient.avatar
            : `/api/public/client-avatar/${hitClient.id}?v=${_avatarVersion(hitClient.avatar)}`)
        : null
    },
    projects: projectsPublic,
    demands: demandsPublic,
    generatedAt: nowISO()
  });
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
  if (!wsId || !canAccessWs(req.user, wsId)) return res.status(403).json({ error: 'Sem acesso à equipe.' });
  const newName = String(b.name || '').trim();
  if (!newName) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
  // Bloqueia duplicidade
  if (db.clients.some(c => c.workspaceId === wsId && (c.name || '').trim().toLowerCase() === newName.toLowerCase())) {
    return res.status(409).json({ error: 'Já existe um cliente com esse nome nesta equipe.' });
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
    return res.status(403).json({ error: 'Sem acesso à equipe deste cliente.' });
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

/* ── SUGESTÃO DE FLUXO — termos aprendidos do histórico ──
   Palavras (e pares de palavras seguidas) de títulos que aparecem muito num tipo
   de fluxo e pouco nos outros viram termos daquele fluxo. Roda sobre TODAS as
   demandas (todas as equipes) pra que equipe nova já herde o que as outras
   ensinaram; a resposta só leva os termos, nunca títulos.
   - Agrupa pelo NOME do fluxo: cópias em clientes diferentes somam.
   - Ignora fluxos curinga (Personalizado), que misturam de tudo.
   - Nome de cliente/projeto não entra ("BRZ", "Gênova" aparecem em qualquer fluxo).
   - Termo precisa aparecer em 2+ projetos — senão nome de campanha ("Saldão")
     viraria palavra-chave.
   Listas de palavras espelham _FS_STOP/_FS_GENERIC e o conceito "personalizado"
   em public/js/app.js — mantenha em sincronia. */
const FLOW_LEARN_MIN_COUNT = 2;
const FLOW_LEARN_MIN_PRECISION = 0.75;
const FLOW_LEARN_MIN_PROJECTS = 2;
const FLOW_LEARN_STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas', 'para', 'pra', 'com', 'a', 'o', 'os', 'as', 'um', 'uma', 'por']);
const FLOW_LEARN_GENERIC = new Set(['novo', 'novos', 'nova', 'novas', 'fluxo', 'fluxos', 'demanda', 'demandas', 'geral', 'padrao', 'digital',
  'digitais', 'offline', 'online', 'material', 'materiais', 'campanha', 'campanhas', 'marketing', 'criacao', 'conteudo', 'conteudos',
  'pagina', 'paginas', 'visual', 'visuais', 'servico', 'servicos', 'projeto', 'projetos', 'ajuste', 'ajustes', 'midia', 'midias',
  'sociais', 'social', 'peca', 'pecas', 'arte', 'artes', 'disparo', 'disparos', 'cliente', 'clientes', 'interno', 'interna',
  'externo', 'externa', 'outros', 'diversos', 'tipo', 'lancamento', 'lancamentos']);
const FLOW_LEARN_WILDCARD_FLOWS = new Set(['personalizado', 'personalizada', 'personalizados', 'personalizdo', 'avulso', 'avulsa',
  'outros', 'geral', 'custom', 'diversos']);

const _flKey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const _flSingular = w => (w.length > 3 ? w.replace(/s$/, '') : w);

function learnFlowTerms({ demands, flows, clients, projects }) {
  const flowKeyById = new Map(flows.filter(notDeleted).map(f => [f.id, _flKey(f.name)]));
  const ignore = new Set();
  [...clients, ...projects].forEach(e => _flKey(e.name).split(' ').forEach(t => {
    ignore.add(t);
    ignore.add(_flSingular(t));
  }));
  const titleTerms = title => {
    const kept = _flKey(title).split(' ').map(t => {
      if (t.length < 2 || /^\d+$/.test(t) || FLOW_LEARN_STOP.has(t) || FLOW_LEARN_GENERIC.has(t)) return null;
      const s = _flSingular(t);
      return ignore.has(t) || ignore.has(s) ? null : s;
    });
    const out = new Set();
    kept.forEach((t, i) => {
      if (!t) return;
      out.add(t);
      if (kept[i + 1]) out.add(t + ' ' + kept[i + 1]);
    });
    return out;
  };
  // termo → { total, byKey: Map(flowKey → { count, projects }) }
  const stats = new Map();
  for (const d of demands) {
    if (!notDeleted(d)) continue;
    const key = flowKeyById.get(d.flowId);
    if (!key || FLOW_LEARN_WILDCARD_FLOWS.has(key)) continue;
    for (const term of titleTerms(d.name)) {
      if (!stats.has(term)) stats.set(term, { total: 0, byKey: new Map() });
      const st = stats.get(term);
      st.total++;
      if (!st.byKey.has(key)) st.byKey.set(key, { count: 0, projects: new Set() });
      const g = st.byKey.get(key);
      g.count++;
      g.projects.add(d.projectId);
    }
  }
  const terms = {};
  stats.forEach((st, term) => st.byKey.forEach((g, key) => {
    const precision = g.count / st.total;
    if (g.count < FLOW_LEARN_MIN_COUNT || precision < FLOW_LEARN_MIN_PRECISION || g.projects.size < FLOW_LEARN_MIN_PROJECTS) return;
    (terms[key] ||= []).push([term, precision >= 0.9 && g.count >= 3 ? 3 : 2]);
  }));
  return terms;
}

app.get('/api/flow-suggest/learned', requireAuth, (req, res) => {
  // Aprendido só com os dados da organização ativa — cache separado por organização.
  let cached = _flowLearnCache.get(req.org.id);
  if (!cached) {
    cached = { terms: learnFlowTerms(db), computedAt: nowISO() };
    _flowLearnCache.set(req.org.id, cached);
  }
  res.json(cached);
});

/* Etapas que demandas parecidas costumam desativar — mesmo tipo de fluxo (nome),
   título com 2+ palavras em comum e 50%+ de sobreposição, de TODAS as equipes.
   Palavras de ação ("ajuste", "reenvio") contam aqui: são elas que dizem que a
   demanda é pequena e pula etapas. Sugere a etapa se 60%+ das parecidas (mín. 2)
   desativaram. Etapas são casadas pelo rótulo — cada cliente tem sua cópia do fluxo. */
const SKIP_SUGGEST_MIN_SIMILAR = 2;
const SKIP_SUGGEST_MIN_SHARE = 0.6;
const SKIP_SUGGEST_MIN_OVERLAP = 0.5;
const _flTitleTokens = title => new Set(_flKey(title).split(' ')
  .filter(t => t.length >= 2 && !/^\d+$/.test(t) && !FLOW_LEARN_STOP.has(t))
  .map(_flSingular));

function suggestStageSkips(flow, title) {
  const tokens = _flTitleTokens(title);
  const empty = { similar: 0, labels: [] };
  if (tokens.size < 2) return empty;
  const key = _flKey(flow.name);
  const flowsById = new Map(db.flows.map(f => [f.id, f]));
  let similar = 0;
  const counts = new Map(); // rótulo normalizado → { label, count }
  for (const d of db.demands) {
    if (!notDeleted(d)) continue;
    const f = flowsById.get(d.flowId);
    if (!f || _flKey(f.name) !== key) continue;
    const other = _flTitleTokens(d.name);
    let shared = 0;
    tokens.forEach(t => { if (other.has(t)) shared++; });
    if (shared < 2 || shared / Math.max(tokens.size, other.size) < SKIP_SUGGEST_MIN_OVERLAP) continue;
    similar++;
    for (const sid of d.skippedStages || []) {
      const st = f.stages.find(s => s.id === sid) || (d.stageAdditions || []).find(s => s.id === sid);
      if (!st?.label) continue;
      const lk = _flKey(st.label);
      if (!counts.has(lk)) counts.set(lk, { label: st.label, count: 0 });
      counts.get(lk).count++;
    }
  }
  if (similar < SKIP_SUGGEST_MIN_SIMILAR) return { similar, labels: [] };
  return { similar, labels: [...counts.values()].filter(c => c.count / similar >= SKIP_SUGGEST_MIN_SHARE) };
}

app.get('/api/flow-suggest/stage-skips', requireAuth, (req, res) => {
  const flow = db.flows.find(f => f.id === req.query.flowId && notDeleted(f));
  if (!flow || !canAccessWs(req.user, flow.workspaceId)) return res.json({ similar: 0, labels: [] });
  res.json(suggestStageSkips(flow, String(req.query.title || '').slice(0, 300)));
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
  // Etapa de conclusão não tem responsável (senão a demanda "concluída" cai
  // no colo de alguém e gera aviso à toa).
  clean.forEach(s => { if (s.done) Object.assign(s, NO_STAGE_OWNER); });
  return clean;
}
const NO_STAGE_OWNER = { roleFilter: null, responsibleId: null, responsibleRole: null, responsiblePosition: null };

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
  if (!stage || stage.done) return null;
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
  const list = db.demands.filter(d => ids.includes(d.workspaceId) && notDeleted(d));
  if (req.user.isFreelancer) {
    return res.json(list.filter(d => freelancerHasDemandAccess(req.user, d)));
  }
  res.json(list);
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

/* Responsável da demanda e executor da etapa atual são o mesmo dado visto de
   dois lugares; idem prazo da etapa (footer) e data-âncora da etapa atual na
   tab Etapas. Estes helpers espelham o lado "demanda" no lado "etapa". */
function syncCurrentStageResponsible(d) {
  if (!d.status) return;
  const flow = db.flows.find(f => f.id === d.flowId);
  if (stageByIdForDemand(flow, d, d.status)?.done) return;
  if (!d.stageResponsibles || typeof d.stageResponsibles !== 'object') d.stageResponsibles = {};
  d.stageResponsibles[d.status] = d.ownerId || null;
}
function syncCurrentStageDueAnchor(d) {
  if (!d.status) return;
  const addition = (Array.isArray(d.stageAdditions) ? d.stageAdditions : []).find(a => a.id === d.status);
  if (addition) { addition.deadlineDate = d.stageDueDate || null; return; }
  if (!d.stageOverrides || typeof d.stageOverrides !== 'object') d.stageOverrides = {};
  const ov = { ...(d.stageOverrides[d.status] || {}) };
  if (d.stageDueDate) ov.deadlineDate = d.stageDueDate;
  else delete ov.deadlineDate;
  if (Object.keys(ov).length) d.stageOverrides[d.status] = ov;
  else delete d.stageOverrides[d.status];
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
    // Largura definida ao redimensionar no editor — só número em px, limitado.
    const wMatch = /(?:^|\s)width\s*=\s*["']?(\d{1,4})["']?/i.exec(attrs);
    const width = wMatch ? Math.min(4000, Math.max(16, Number(wMatch[1]))) : null;
    return `<img src="${escAttr(outSrc)}" alt="${escAttr(alt)}"${width ? ` width="${width}"` : ''}>`;
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
// Teto de anexos por entidade. Acima disso a rota RECUSA (tooManyAttachments) —
// antes a lista era cortada em silêncio e o anexo novo sumia depois de "salvo".
const ATTACHMENTS_MAX = 200;
function tooManyAttachments(res, arr) {
  if (!Array.isArray(arr) || arr.length <= ATTACHMENTS_MAX) return false;
  res.status(400).json({ error: `Limite de ${ATTACHMENTS_MAX} anexos atingido.` });
  return true;
}
function sanitizeAttachments(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, ATTACHMENTS_MAX).map(a => {
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
    const size = uploadSizeOf(data) || (Number(a.size) > 0 ? Math.round(Number(a.size)) : 0);
    return { id: a.id || uid(), kind: 'file', name: String(a.name || 'arquivo'), type: String(a.type || ''), data, ...(size ? { size } : {}), addedAt: a.addedAt || nowISO() };
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
    // Largura definida ao redimensionar no editor — só número em px, limitado.
    const wMatch = /(?:^|\s)width\s*=\s*["']?(\d{1,4})["']?/i.exec(attrs);
    const width = wMatch ? Math.min(4000, Math.max(16, Number(wMatch[1]))) : null;
    return `<img src="${escAttr(outSrc)}" alt="${escAttr(alt)}"${width ? ` width="${width}"` : ''}>`;
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
  if (tooManyAttachments(res, b.attachments)) return;
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
      if (flow.stages.find(x => x.id === sid)?.done) continue; // conclusão: sem responsável
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
      if (!s.done && typeof s.responsibleId === 'string' && s.responsibleId) {
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
    status: stage.id,
    ownerId: b.ownerId || awaySubstitute((initStageResp[stage.id] !== undefined ? initStageResp[stage.id] : null) || resolveStageOwner(stage, project) || null),
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
    createdBy: req.user.id,
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
  if (req.user.isFreelancer && !freelancerHasDemandAccess(req.user, d)) {
    res.status(404).json({ error: 'Demanda não encontrada' }); return null;
  }
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
  if (tooManyAttachments(res, b.attachments)) return;
  // Freelancer só pode mudar a etapa (avançar/retroceder) e a ordem no kanban.
  // Qualquer outro campo no body é bloqueado — evita edição indireta de descrição,
  // prazo, prioridade, responsável, etc.
  if (req.user.isFreelancer) {
    const ALLOWED = new Set(['status', 'kanbanOrder']);
    for (const k of Object.keys(b)) {
      if (!ALLOWED.has(k)) return res.status(403).json({ error: 'Freelancers só podem avançar/retroceder etapas desta demanda' });
    }
  }
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
    let newAtts = sanitizeAttachments(b.attachments);
    // Com a base (ids que o cliente tinha ao abrir o form), aplica só a
    // diferença sobre a lista ATUAL: tira o que ele removeu e acrescenta o que
    // ele pôs — anexo que outra pessoa adicionou no meio tempo continua.
    if (Array.isArray(b.attachmentsBaseIds)) {
      const base = new Set(b.attachmentsBaseIds.map(String));
      const sent = new Set(newAtts.map(a => a.id));
      const kept = (d.attachments || []).filter(a => !(base.has(a.id) && !sent.has(a.id)));
      const keptIds = new Set(kept.map(a => a.id));
      newAtts = kept.concat(newAtts.filter(a => !keptIds.has(a.id)));
    }
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
      syncCurrentStageResponsible(d);
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
    syncCurrentStageDueAnchor(d);
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
    const ownerBeforeStage = d.ownerId;
    // fecha a etapa anterior no histórico
    const prev = d.stageHistory[d.stageHistory.length - 1];
    if (prev && !prev.leftAt) prev.leftAt = nowISO();
    d.status = stage.id;
    d.stageEnteredAt = nowISO();
    // o prazo da etapa começa a contar agora (independe de atraso anterior)
    d.stageDueDate = resolveStageDueDate(stage, d, today());
    d.stageHistory.push({ stageId: stage.id, enteredAt: nowISO(), dueDate: d.stageDueDate });
    addHistory(d, req.user.id, 'stage_changed', { fromId: oldStageId, toId: stage.id });
    // Responsável padrão da etapa assume a demanda (se configurado e sem override no payload).
    // Override por instância (d.stageResponsibles[stageId]) tem precedência sobre o padrão do fluxo.
    // Se a nova etapa não define responsável (autoOwner=null), LIMPA d.ownerId — evita herdar
    // o dono da etapa anterior (importante pra etapas terminais tipo "Concluída").
    if (b.ownerId === undefined) {
      const instOverride = (d.stageResponsibles && typeof d.stageResponsibles === 'object') ? d.stageResponsibles[stage.id] : undefined;
      const projForResolve = db.projects.find(p => p.id === d.projectId);
      const autoOwner = stage.done ? null : awaySubstitute((instOverride !== undefined) ? instOverride : (resolveStageOwner(stage, projForResolve) || null));
      const prevOwner = d.ownerId;
      d.ownerId = autoOwner || null;
      if (d.ownerId !== prevOwner) {
        addHistory(d, req.user.id, 'owner_auto_assigned', { fromId: prevOwner, toId: d.ownerId, byStage: stage.id });
      }
    }
    // Avisos (responsável, observadores, canal) só depois que a demanda para na etapa.
    scheduleStageNotify(d, { prevStage, userId: req.user.id, baseUrl: appBaseUrl(req), ownerBefore: ownerBeforeStage, ownerExplicit: b.ownerId !== undefined });
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

/* ── AVISOS DE MUDANÇA DE ETAPA COM ESPERA ──
   Responsável da etapa, observadores e webhooks (canal do Discord) só são
   avisados depois que a demanda fica STAGE_NOTIFY_DELAY_MS na etapa nova.
   Mudou de novo nesse intervalo (avançar 2 seguidas, clique errado): o aviso
   pendente é trocado e só a etapa final avisa — "de" continua sendo a etapa
   de antes da 1ª mudança. Voltou pra etapa de onde saiu: ninguém é avisado.
   (Reinício do servidor dentro da janela perde o aviso pendente.) */
const STAGE_NOTIFY_DELAY_MS = 60 * 1000;
const _pendingStageNotify = new Map(); // demandId → entrada pendente
function scheduleStageNotify(d, { prevStage, userId, baseUrl, ownerBefore, ownerExplicit }) {
  const cur = _pendingStageNotify.get(d.id);
  if (cur) clearTimeout(cur.timer);
  const entry = {
    // Início da sequência: preservado entre mudanças seguidas.
    fromStageId: cur ? cur.fromStageId : (prevStage ? prevStage.id : null),
    prevStage: cur ? cur.prevStage : prevStage,
    ownerBefore: cur ? cur.ownerBefore : ownerBefore,
    ownerExplicit: !!ownerExplicit || !!(cur && cur.ownerExplicit),
    stageId: d.status, userId, baseUrl
  };
  entry.timer = setTimeout(() => fireStageNotify(d.id, entry), STAGE_NOTIFY_DELAY_MS);
  if (entry.timer.unref) entry.timer.unref();
  _pendingStageNotify.set(d.id, entry);
}
function fireStageNotify(demandId, entry) {
  if (_pendingStageNotify.get(demandId) !== entry) return;
  _pendingStageNotify.delete(demandId);
  const d = db.demands.find(x => x.id === demandId);
  if (!d || !notDeleted(d) || d.status !== entry.stageId) return;
  if (entry.fromStageId === d.status) return; // voltou pra onde estava
  const flow = db.flows.find(f => f.id === d.flowId);
  const stage = stageByIdForDemand(flow, d, d.status);
  if (!stage) return;
  const data = { demandId: d.id, demandName: d.name, stageName: stage.label };
  // Responsável só é avisado se a etapa trouxe OUTRA pessoa (e não foi quem mexeu,
  // nem quando o responsável foi escolhido na mão no mesmo salvamento).
  const ownerChanged = d.ownerId && d.ownerId !== entry.ownerBefore && !entry.ownerExplicit;
  if (ownerChanged && d.ownerId !== entry.userId) notify(d.ownerId, 'stage_assigned', data, entry.userId, entry.baseUrl);
  notifyWatchers(d, 'watch_stage', data, entry.userId, entry.baseUrl);
  const ctx = {
    demand: d, project: db.projects.find(p => p.id === d.projectId), flow, stage, prevStage: entry.prevStage,
    user: db.users.find(u => u.id === entry.userId) || null,
    owner: db.users.find(u => u.id === d.ownerId) || null,
    appBaseUrl: entry.baseUrl
  };
  fireWebhook('demand.stage_changed', ctx);
  if (ownerChanged) fireWebhook('demand.stage_assigned', ctx);
}

/* Anexos um a um. O PUT acima troca a lista INTEIRA pela que o cliente mandou —
   se duas pessoas anexam juntas (ou uma tela está desatualizada), o anexo da
   outra some. Aqui o servidor só acrescenta/remove o item pedido sobre a lista
   ATUAL dele, então nada de ninguém é sobrescrito. */
app.post('/api/demands/:id/attachments', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  if (req.user.isFreelancer) return res.status(403).json({ error: 'Freelancers não podem alterar anexos' });
  const incoming = Array.isArray(req.body?.attachments) ? req.body.attachments : [req.body?.attachment].filter(Boolean);
  if (!incoming.length) return res.status(400).json({ error: 'Nenhum anexo enviado' });
  const current = d.attachments || [];
  if (tooManyAttachments(res, current.concat(incoming))) return;
  const ids = new Set(current.map(a => a.id));
  // Id repetido (retry do mesmo envio) não duplica.
  const added = sanitizeAttachments(incoming).filter(a => !ids.has(a.id));
  if (!added.length) return res.json(d);
  added.forEach(a => addHistory(d, req.user.id, 'attachment_added', { kind: a.kind, name: a.name }));
  d.attachments = current.concat(added);
  saveEntity('demands', d);
  broadcastChange('demand', 'update', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.json(d);
});
app.delete('/api/demands/:id/attachments/:attId', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  if (req.user.isFreelancer) return res.status(403).json({ error: 'Freelancers não podem alterar anexos' });
  const att = (d.attachments || []).find(a => a.id === req.params.attId);
  // Já removido por outra pessoa: devolve o estado atual (idempotente).
  if (!att) return res.json(d);
  d.attachments = d.attachments.filter(a => a.id !== att.id);
  addHistory(d, req.user.id, 'attachment_removed', { kind: att.kind, name: att.name });
  saveEntity('demands', d);
  broadcastChange('demand', 'update', { id: d.id, workspaceId: d.workspaceId, byUserId: req.user.id });
  res.json(d);
});

/* Excluir demanda: moderador e acima excluem qualquer uma do squad; a equipe
   só as que ela mesma criou. */
const canDeleteDemand = (user, d) => user.isAdmin || user.isModerator || d.createdBy === user.id;
app.delete('/api/demands/:id', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  if (!canDeleteDemand(req.user, d)) return res.status(403).json({ error: 'Você só pode excluir demandas que você criou.' });
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
    const deletable = targets.filter(d => canDeleteDemand(req.user, d));
    deletable.forEach(d => softDelete('demands', d, req.user.id));
    updated = deletable.length;
    skipped = ids.length - updated;
    broadcastChange('demand', 'bulk', { workspaceId: wsIdForBroadcast, byUserId: req.user.id });
    if (deletable.length < targets.length) errors.push('Algumas demandas não foram excluídas: você só pode excluir as que criou.');
    return res.json({ updated, skipped, errors, undoable: true, deletedIds: deletable.map(d => d.id) });
  }
  for (const d of targets) {
    try {
      if (op === 'setOwner') {
        const newOwner = data && data.ownerId ? String(data.ownerId) : null;
        if (newOwner !== d.ownerId) {
          const prevOwner = d.ownerId;
          d.ownerId = newOwner;
          syncCurrentStageResponsible(d);
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
        const ownerBeforeStage = d.ownerId;
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
        const stageOwner = realStage.done ? null : awaySubstitute(((_instOverride !== undefined) ? _instOverride : (resolveStageOwner(realStage, _bulkProj) || null)) || null);
        if (stageOwner !== d.ownerId) {
          const prevOwner = d.ownerId;
          d.ownerId = stageOwner;
          addHistory(d, req.user.id, 'owner_auto_assigned', { fromId: prevOwner, toId: d.ownerId, byStage: realStage.id });
        }
        // Avisos com espera, igual ao PUT individual.
        const owner = db.users.find(u => u.id === d.ownerId);
        const _bulkReqBase = appBaseUrl(req);
        scheduleStageNotify(d, { prevStage, userId: req.user.id, baseUrl: _bulkReqBase, ownerBefore: ownerBeforeStage });
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
          syncCurrentStageDueAnchor(d);
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
          skipped++; errors.push({ id: d.id, error: 'Projeto de outra equipe.' }); continue;
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
      if (!s.done && typeof s.responsibleId === 'string' && s.responsibleId) {
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
  if (e.userId !== req.user.id && !req.user.isAdmin && !req.user.isModerator) {
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
  if (e && e.userId !== req.user.id && !req.user.isAdmin && !req.user.isModerator) {
    return res.status(403).json({ error: 'Você só pode remover seus próprios apontamentos' });
  }
  if (e) addHistory(d, req.user.id, 'time_removed', { hours: e.hours, stageId: e.stageId });
  d.timeEntries = d.timeEntries.filter(x => x.id !== req.params.entryId);
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});

/* Comentários com menção. `format`: 'html' (editor rich) ou 'text' (legacy). */
/* ── FRASES RECORRENTES (autocompletar com Tab no comentário) ──
   Aprende, por usuário, as SEQUÊNCIAS que ele repete no começo das linhas dos
   próprios comentários — não a linha inteira: "Ajustes feitos, troquei a cor"
   e "Ajustes feitos: alterei o título" contam os dois pra "Ajustes feitos".
   Cada linha soma 1 pra cada prefixo de palavras dela (até PHRASE_MAX_WORDS);
   link vira {link} (o cliente completa até ali e a pessoa cola o link).
   Caixa, acento e pontuação no fim da palavra não diferenciam; a forma
   sugerida é a que ele mais escreveu.
   Entra com PHRASE_MIN_COUNT usos e sai se não foi escrita nos últimos
   PHRASE_TTL_MS (vício abandonado some sozinho). Entre um prefixo e um mais
   longo com a MESMA contagem, fica só o longo (o curto não acrescenta nada). */
const PHRASE_MIN_COUNT = 5;
const PHRASE_MAX_WORDS = 12;
const PHRASE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PHRASE_URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
function commentPhraseTokenKey(tok) {
  return tok.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!?,;:…]+$/u, '');
}
function learnCommentPhrases(userId, now = Date.now()) {
  const groups = new Map(); // key → { count, lastAt, words, variants: Map<texto, n> }
  for (const d of db.demands) {
    for (const c of d.comments || []) {
      if (c.userId !== userId) continue;
      const at = Date.parse(c.createdAt) || 0;
      const plain = c.format === 'html' ? stripHtmlToText(c.text) : String(c.text || '');
      const seen = new Set(); // mesma sequência em 2 linhas do comentário conta 1x
      for (const line of plain.split('\n')) {
        const toks = line.replace(PHRASE_URL_RE, '{link}').trim().split(/\s+/).filter(Boolean).slice(0, PHRASE_MAX_WORDS);
        const keys = toks.map(commentPhraseTokenKey);
        for (let k = 2; k <= toks.length; k++) {
          const text = toks.slice(0, k).join(' ');
          // Precisa de texto de verdade além de link/pontuação.
          if (text.replace(/\{link\}/g, '').replace(/[^\p{L}\p{N}]/gu, '').length < 3) continue;
          const key = keys.slice(0, k).join(' ');
          if (seen.has(key)) continue;
          seen.add(key);
          let g = groups.get(key);
          if (!g) groups.set(key, g = { count: 0, lastAt: 0, words: k, variants: new Map() });
          g.count++;
          if (at > g.lastAt) g.lastAt = at;
          g.variants.set(text, (g.variants.get(text) || 0) + 1);
        }
      }
    }
  }
  const alive = [...groups].filter(([, g]) => g.count >= PHRASE_MIN_COUNT && now - g.lastAt <= PHRASE_TTL_MS);
  // Fechado: descarta o prefixo se um mais longo que começa com ele tem a mesma contagem.
  const kept = alive.filter(([key, g]) => !alive.some(([k2, g2]) => g2.words > g.words && g2.count === g.count && k2.startsWith(key + ' ')));
  return kept
    // Vírgula/dois-pontos no fim é emenda do resto da frase — a pessoa escolhe a pontuação.
    .map(([, g]) => ({ text: [...g.variants].sort((x, y) => y[1] - x[1])[0][0].replace(/[,;:]+$/, ''), count: g.count, lastAt: new Date(g.lastAt).toISOString() }))
    .sort((x, y) => y.count - x.count || y.text.length - x.text.length)
    .slice(0, 40);
}
/* ── LEMBRAR DEPOIS ──
   Lembretes pessoais por demanda, guardados no próprio usuário (u.reminders).
   runRemindersJob dispara na hora via notify(type 'reminder') — sino, e-mail
   e DM do Discord conforme as preferências — e tira o lembrete da lista. */
const REMINDERS_MAX = 100;
function reminderView(r) {
  const d = db.demands.find(x => x.id === r.demandId);
  return { ...r, demandName: d ? d.name : '(demanda removida)' };
}
app.get('/api/me/reminders', requireAuth, (req, res) => {
  res.json((req.user.reminders || []).map(reminderView));
});
app.post('/api/demands/:id/reminders', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const at = Date.parse(req.body?.at);
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'Data do lembrete inválida' });
  if (at < Date.now() - 60 * 1000) return res.status(400).json({ error: 'Escolha um horário no futuro' });
  if (at > Date.now() + 366 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'Lembrete pode ser de no máximo 1 ano' });
  const u = req.user;
  if (!Array.isArray(u.reminders)) u.reminders = [];
  if (u.reminders.length >= REMINDERS_MAX) return res.status(400).json({ error: `Limite de ${REMINDERS_MAX} lembretes pendentes` });
  const r = {
    id: uid(), demandId: d.id, at: new Date(at).toISOString(),
    note: String(req.body?.note || '').trim().slice(0, 300),
    baseUrl: appBaseUrl(req), createdAt: nowISO()
  };
  u.reminders.push(r);
  saveEntity('users', u);
  res.status(201).json(reminderView(r));
});
app.delete('/api/me/reminders/:rid', requireAuth, (req, res) => {
  const u = req.user;
  const before = (u.reminders || []).length;
  u.reminders = (u.reminders || []).filter(r => r.id !== req.params.rid);
  if (u.reminders.length !== before) saveEntity('users', u);
  res.json({ ok: true });
});
function runRemindersJob() {
  const now = Date.now();
  for (const u of db.users || []) {
    if (!Array.isArray(u.reminders) || !u.reminders.length || u.active === false) continue;
    const due = u.reminders.filter(r => Date.parse(r.at) <= now);
    if (!due.length) continue;
    u.reminders = u.reminders.filter(r => Date.parse(r.at) > now);
    saveEntity('users', u);
    for (const r of due) {
      const d = db.demands.find(x => x.id === r.demandId && notDeleted(x));
      if (!d) continue;
      notify(u.id, 'reminder', { demandId: d.id, demandName: d.name, commentText: r.note || null }, null, r.baseUrl || process.env.PUBLIC_URL);
    }
  }
}
const _remindersInterval = setInterval(runRemindersJob, 30 * 1000);
if (_remindersInterval.unref) _remindersInterval.unref();

/* ── NOVIDADES DESDE A ÚLTIMA VISITA ──
   Guarda quando cada pessoa abriu cada demanda pela última vez (u.demandSeen,
   só as DEMAND_SEEN_MAX mais recentes). Abrir devolve a visita ANTERIOR — o
   cliente destaca o que outras pessoas fizeram depois dela. */
const DEMAND_SEEN_MAX = 400;
app.post('/api/demands/:id/seen', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const u = req.user;
  const seen = (u.demandSeen && typeof u.demandSeen === 'object') ? u.demandSeen : {};
  const prev = seen[d.id] || null;
  delete seen[d.id];
  seen[d.id] = nowISO(); // reinserir = vai pro fim (ordem de inserção = recência)
  const keys = Object.keys(seen);
  if (keys.length > DEMAND_SEEN_MAX) keys.slice(0, keys.length - DEMAND_SEEN_MAX).forEach(k => delete seen[k]);
  u.demandSeen = seen;
  saveEntity('users', u);
  res.json({ prev });
});

/* ── MENÇÕES ESPERANDO RESPOSTA ──
   Comentários dos últimos 30 dias que mencionam a pessoa (direto ou pela área)
   e que ela ainda não respondeu: sem comentário dela depois naquela demanda,
   sem reação dela no comentário e sem ter dispensado. Demandas concluídas saem. */
const PENDING_MENTION_DAYS = 30;
function pendingMentionsFor(user) {
  const since = Date.now() - PENDING_MENTION_DAYS * 864e5;
  const dismissed = new Set(Array.isArray(user.mentionDismissed) ? user.mentionDismissed : []);
  const out = [];
  for (const d of db.demands) {
    if (!notDeleted(d) || d.completedAt || !canAccessWs(user, d.workspaceId)) continue;
    const comments = Array.isArray(d.comments) ? d.comments : [];
    let myLast = 0;
    for (const c of comments) if (c.userId === user.id) myLast = Math.max(myLast, Date.parse(c.createdAt) || 0);
    for (const c of comments) {
      if (c.userId === user.id || !Array.isArray(c.mentions) || !c.mentions.includes(user.id)) continue;
      const at = Date.parse(c.createdAt) || 0;
      if (at < since || myLast > at) continue;
      if (Object.values(c.reactions || {}).some(arr => Array.isArray(arr) && arr.includes(user.id))) continue;
      const key = d.id + ':' + c.id;
      if (dismissed.has(key)) continue;
      const plain = (c.format === 'html' ? stripHtmlToText(c.text || '') : String(c.text || '')).replace(/\s+/g, ' ').trim();
      const project = db.projects.find(p => p.id === d.projectId);
      out.push({
        key, demandId: d.id, demandName: d.name, commentId: c.id, fromUserId: c.userId,
        preview: plain.slice(0, 160), createdAt: c.createdAt, client: project?.client || '',
        viaRole: (c.roleMentions || [])[0] || null,
      });
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
app.get('/api/me/pending-mentions', requireAuth, (req, res) => {
  res.json(pendingMentionsFor(req.user));
});
app.post('/api/me/pending-mentions/dismiss', requireAuth, (req, res) => {
  const key = String(req.body?.key || '');
  if (!/^[\w-]+:[\w-]+$/.test(key)) return res.status(400).json({ error: 'Chave inválida' });
  const list = Array.isArray(req.user.mentionDismissed) ? req.user.mentionDismissed : [];
  if (!list.includes(key)) list.push(key);
  req.user.mentionDismissed = list.slice(-300);
  saveEntity('users', req.user);
  res.json({ ok: true });
});
// "Visto": quando cada pessoa mencionada nesta demanda abriu ela pela última vez.
app.get('/api/demands/:id/mention-seen', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const ids = new Set();
  (d.comments || []).forEach(c => (c.mentions || []).forEach(id => ids.add(id)));
  const out = {};
  ids.forEach(id => {
    const u = db.users.find(x => x.id === id);
    out[id] = (u && u.demandSeen && u.demandSeen[d.id]) || null;
  });
  res.json(out);
});

/* ── ETAPAS ENTREGUES SEM APONTAMENTO ──
   "Entregou" = moveu a demanda PRA FRENTE saindo da etapa X (histórico
   stage_changed com ele como autor) nos últimos TIME_GAP_WINDOW_DAYS, SENDO o
   executor da etapa X (quem só ajustou/avançou etapa de outra pessoa — ex.:
   quem monta as etapas da demanda — não tem o que apontar ali).
   Pendência = não tem nenhum apontamento dele na etapa X dessa demanda.
   Some quando ele aponta ou dispensa ("não precisa"). */
const TIME_GAP_WINDOW_DAYS = 30;
function stageIndexIn(flow, d, stageId) {
  const order = Array.isArray(d.stageOrder) && d.stageOrder.length ? d.stageOrder : (flow?.stages || []).map(s => s.id);
  return order.indexOf(stageId);
}
function stageLabelIn(flow, d, stageId) {
  const custom = d.stageLabels && d.stageLabels[stageId];
  if (custom) return custom;
  const st = (flow?.stages || []).find(s => s.id === stageId) || (d.stageAdditions || []).find(s => s.id === stageId);
  return st ? st.label : 'Etapa';
}
// Executor de uma etapa: o definido na demanda (inclui etapas criadas nela e
// trocas manuais), senão o padrão do fluxo (pessoa ou cargo no projeto/cliente).
function stageResponsibleOf(d, flow, stageId) {
  const st = stageByIdForDemand(flow, d, stageId);
  if (st && st.done) return null;
  const inst = (d.stageResponsibles && typeof d.stageResponsibles === 'object') ? d.stageResponsibles[stageId] : undefined;
  if (inst !== undefined) return inst || null;
  const stage = stageByIdForDemand(flow, d, stageId);
  return resolveStageOwner(stage, db.projects.find(p => p.id === d.projectId)) || null;
}
function timeGapsFor(user) {
  const since = Date.now() - TIME_GAP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const dismissed = new Set(user.timeGapDismissed || []);
  const out = new Map(); // demandId:stageId → gap (fica a entrega mais recente)
  for (const d of db.demands) {
    if (!notDeleted(d) || !canAccessWs(user, d.workspaceId)) continue;
    const flow = db.flows.find(f => f.id === d.flowId);
    for (const h of d.history || []) {
      if (h.action !== 'stage_changed' || h.userId !== user.id || !h.details) continue;
      const at = Date.parse(h.at) || 0;
      if (at < since) continue;
      const { fromId, toId } = h.details;
      if (!fromId) continue;
      const fi = stageIndexIn(flow, d, fromId), ti = stageIndexIn(flow, d, toId);
      if (fi >= 0 && ti >= 0 && ti < fi) continue; // retrocedeu: não é entrega
      if (stageResponsibleOf(d, flow, fromId) !== user.id) continue; // etapa de outra pessoa
      const key = d.id + ':' + fromId;
      if (dismissed.has(key)) continue;
      if ((d.timeEntries || []).some(e => e.userId === user.id && e.stageId === fromId)) continue;
      const prev = out.get(key);
      if (prev && Date.parse(prev.deliveredAt) >= at) continue;
      const project = db.projects.find(p => p.id === d.projectId);
      out.set(key, {
        key, demandId: d.id, demandName: d.name, stageId: fromId,
        stageLabel: stageLabelIn(flow, d, fromId), deliveredAt: h.at,
        client: project ? (project.client || '') : ''
      });
    }
  }
  return [...out.values()].sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt));
}
app.get('/api/me/time-gaps', requireAuth, (req, res) => {
  res.json(timeGapsFor(req.user));
});
app.post('/api/me/time-gaps/dismiss', requireAuth, (req, res) => {
  const key = String(req.body?.key || '');
  if (!/^[\w-]+:[\w-]+$/.test(key)) return res.status(400).json({ error: 'Pendência inválida' });
  const u = req.user;
  const list = Array.isArray(u.timeGapDismissed) ? u.timeGapDismissed : [];
  if (!list.includes(key)) list.push(key);
  u.timeGapDismissed = list.slice(-500);
  saveEntity('users', u);
  res.json({ ok: true });
});
/* Aviso diário (seg-sex, a partir das 17h no horário do servidor) no sino,
   se a pessoa tiver pendências. 1x por dia. Clicar leva pro Início. */
function runTimeGapNotifyJob() {
  const now = new Date();
  const dow = now.getDay();
  if (dow === 0 || dow === 6 || now.getHours() < 17) return;
  const ymd = today();
  for (const u of db.users || []) {
    if (u.active === false || u._lastTimeGapNotify === ymd || isAway(u)) continue;
    const gaps = timeGapsFor(u);
    u._lastTimeGapNotify = ymd;
    saveEntity('users', u);
    if (!gaps.length) continue;
    const n = {
      id: uid(), userId: u.id, type: 'time_gap', demandId: null, demandName: '',
      fromUser: null, stageName: null,
      commentText: gaps.length === 1
        ? `1 etapa entregue sem apontamento: ${gaps[0].demandName} · ${gaps[0].stageLabel}`
        : `${gaps.length} etapas entregues sem apontamento`,
      read: false, createdAt: nowISO()
    };
    store.insertNotification(n).catch(err => console.error('[time-gap] insert:', err.message));
    store.trimNotificationsFor(u.id, NOTIFICATIONS_MAX_PER_USER).catch(() => {});
    broadcastToUser(u.id, 'notification', 'create');
  }
}
const _timeGapInterval = setInterval(runTimeGapNotifyJob, 15 * 60 * 1000);
if (_timeGapInterval.unref) _timeGapInterval.unref();

app.get('/api/me/comment-phrases', requireAuth, (req, res) => {
  res.json(learnCommentPhrases(req.user.id));
});

/* ── MENÇÕES ──
   @usuario ou @area (nome da área sem acento, com hífen: "Mídias Digitais"
   → @midias-digitais). A área avisa quem a ocupa no projeto da demanda
   (roleAssignments do projeto; sem a área lá, os do cliente). */
const roleSlug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function roleMembersFor(d, areaName) {
  const key = String(areaName || '').toLowerCase();
  const pick = ra => {
    if (!ra || typeof ra !== 'object') return [];
    const k = Object.keys(ra).find(x => x.toLowerCase() === key);
    const v = k ? ra[k] : null;
    if (!v) return [];
    return typeof v === 'string' ? [v] : Object.values(v).filter(Boolean);
  };
  const project = db.projects.find(p => p.id === d.projectId);
  let ids = pick(project && project.roleAssignments);
  if (!ids.length && project && project.clientId) ids = pick((db.clients.find(c => c.id === project.clientId) || {}).roleAssignments);
  return [...new Set(ids)];
}
function extractMentions(plain, d) {
  const tokens = (String(plain || '').match(/@([a-zA-Z0-9._-]+)/g) || []).map(t => t.slice(1).toLowerCase());
  const ids = new Set(db.users
    .filter(u => tokens.includes(u.username.toLowerCase()) && canAccessWs(u, d.workspaceId))
    .map(u => u.id));
  const roleMentions = [];
  for (const r of db.roles || []) {
    const slug = roleSlug(r.name);
    if (!slug || !tokens.includes(slug)) continue;
    roleMentions.push(r.name);
    roleMembersFor(d, r.name).forEach(id => {
      const u = db.users.find(x => x.id === id && x.active !== false);
      if (u && canAccessWs(u, d.workspaceId)) ids.add(id);
    });
  }
  return { mentions: [...ids], roleMentions };
}

app.post('/api/demands/:id/comment', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const format = req.body?.format === 'html' ? 'html' : 'text';
  const rawText = String((req.body && req.body.text) || '');
  const text = format === 'html'
    ? sanitizeCommentHtml(rawText)
    : rawText.trim().slice(0, 10000);
  // Recusa em vez de cortar: antes o 11º anexo em diante sumia sem aviso.
  if (Array.isArray(req.body?.attachments) && req.body.attachments.length > 10) return res.status(400).json({ error: 'Máximo de 10 anexos por comentário.' });
  const attachments = sanitizeAttachments(req.body?.attachments);
  // Plain para extração de menções + validação de "vazio".
  const plain = format === 'html' ? stripHtmlToText(text) : text;
  if (!plain.trim() && !attachments.length && !/\<img\b/i.test(text)) {
    return res.status(400).json({ error: 'Escreva algo ou anexe um arquivo' });
  }
  // extrai menções (@usuario e @area) válidas dentro do workspace
  const { mentions, roleMentions } = extractMentions(plain, d);
  const c = { id: uid(), userId: req.user.id, text, format, mentions, attachments, reactions: {}, createdAt: nowISO(), editedAt: null };
  if (roleMentions.length) c.roleMentions = roleMentions;
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
    // Quem está fora não é pingado no canal (volta a ser quando retornar).
    return mu ? { id: mu.id, name: mu.name, discordId: (!isAway(mu) && mu.discordId) || null } : null;
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
  if (Array.isArray(req.body?.attachments) && req.body.attachments.length > 10) return res.status(400).json({ error: 'Máximo de 10 anexos por comentário.' });
  const attachments = req.body?.attachments !== undefined
    ? sanitizeAttachments(req.body.attachments)
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
  const _m = extractMentions(plain, d);
  c.mentions = _m.mentions;
  if (_m.roleMentions.length) c.roleMentions = _m.roleMentions; else delete c.roleMentions;
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
// Qualquer emoji (um só — com modificador de tom, ZWJ ou bandeira). Nada de texto.
const REACTION_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]*$/u;
function isReactionEmoji(e) { return typeof e === 'string' && e.length <= 24 && REACTION_EMOJI_RE.test(e); }
// Toggle rápido (tira/põe) não gera uma notificação por clique: 1 por
// comentário + pessoa + emoji a cada REACTION_NOTIFY_COOLDOWN_MS.
const REACTION_NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const _reactionNotified = new Map();
app.post('/api/demands/:id/comment/:cid/react', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const c = d.comments.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Comentário não encontrado' });
  const emoji = String((req.body && req.body.emoji) || '');
  if (!isReactionEmoji(emoji)) return res.status(400).json({ error: 'Emoji inválido' });
  if (!c.reactions || typeof c.reactions !== 'object') c.reactions = {};
  const arr = c.reactions[emoji] || [];
  const idx = arr.indexOf(req.user.id);
  if (idx >= 0) arr.splice(idx, 1);
  else arr.push(req.user.id);
  if (arr.length === 0) delete c.reactions[emoji];
  else c.reactions[emoji] = arr;
  saveEntity('demands', d);
  emitDemand(req, d);
  // Avisa o autor do comentário quando alguém REAGE (não ao tirar a reação).
  if (idx < 0 && c.userId && c.userId !== req.user.id) {
    const key = `${c.id}:${req.user.id}:${emoji}`;
    const last = _reactionNotified.get(key) || 0;
    if (Date.now() - last > REACTION_NOTIFY_COOLDOWN_MS) {
      _reactionNotified.set(key, Date.now());
      const plain = (c.format === 'html' ? stripHtmlToText(c.text) : String(c.text || '')).replace(/\s+/g, ' ').trim();
      notify(c.userId, 'reaction', { demandId: d.id, demandName: d.name, emoji, commentText: plain.slice(0, 140) }, req.user.id, appBaseUrl(req));
    }
  }
  res.json(d);
});

/* ── CHECKLIST INTERNO ── */
app.post('/api/demands/:id/checklist', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  // `texts` (lista colada, até 50) ou `text` (um item).
  const b = req.body || {};
  const texts = (Array.isArray(b.texts) ? b.texts : [b.text])
    .map(t => String(t || '').trim().slice(0, 500)).filter(Boolean).slice(0, 50);
  if (!texts.length) return res.status(400).json({ error: 'Texto obrigatório' });
  if (!Array.isArray(d.checklist)) d.checklist = [];
  for (const text of texts) {
    const item = {
      id: uid(), text,
      done: false, doneBy: null, doneAt: null,
      createdBy: req.user.id, createdAt: nowISO()
    };
    d.checklist.push(item);
    addHistory(d, req.user.id, 'checklist_added', { itemId: item.id, text });
  }
  saveEntity('demands', d);
  emitDemand(req, d);
  res.status(201).json(d);
});
// Nova ordem do checklist (arrastar). Ids fora da lista mantêm a ordem no fim.
app.put('/api/demands/:id/checklist-order', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ error: 'Ordem inválida' });
  const list = Array.isArray(d.checklist) ? d.checklist : [];
  const pos = new Map(ids.map((id, i) => [id, i]));
  d.checklist = list
    .map((it, i) => ({ it, k: pos.has(it.id) ? pos.get(it.id) : ids.length + i }))
    .sort((a, b) => a.k - b.k).map(x => x.it);
  saveEntity('demands', d);
  emitDemand(req, d);
  res.json(d);
});
app.put('/api/demands/:id/checklist/:itemId', requireAuth, (req, res) => {
  const d = getDemand(req, res); if (!d) return;
  const item = (d.checklist || []).find(x => x.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item não encontrado' });
  if (req.user.isFreelancer && item.createdBy !== req.user.id) {
    return res.status(403).json({ error: 'Freelancers só podem editar itens de checklist que criaram' });
  }
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
  if (item && req.user.isFreelancer && item.createdBy !== req.user.id) {
    return res.status(403).json({ error: 'Freelancers só podem remover itens de checklist que criaram' });
  }
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
      return res.status(400).json({ error: 'Equipe inválida pro bloco livre.' });
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
    roleId, ownerId, listaId,
    description: sanitizeCommentHtml(String(b.description ?? cur.description ?? '')),
    briefing: normalizeUrlSrv(b.briefing ?? cur.briefing ?? ''),
    priority: [1,2,3,4].includes(Number(b.priority ?? cur.priority)) ? Number(b.priority ?? cur.priority) : 3,
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
    status: stage.id,
    ownerId: r.ownerId || awaySubstitute(resolveStageOwner(stage, project) || null),
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
    if (!canAccessWs(req.user, project.workspaceId)) return res.status(403).json({ error: 'Sem acesso à equipe do projeto' });
    client = project.clientId ? db.clients.find(c => c.id === project.clientId) : null;
  } else {
    client = db.clients.find(c => c.id === clientIdIn && notDeleted(c));
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
    if (!canAccessWs(req.user, client.workspaceId)) return res.status(403).json({ error: 'Sem acesso à equipe do cliente' });
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
  if (!canAccessWs(req.user, wsId)) return res.status(403).json({ error: 'Sem acesso à equipe' });
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
  console.log(`[webhooks/get] user=${req.user.username} → ${list.length} webhook(s) (cache tem ${raw.length}; universais, sem filtro por equipe)`);
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
   demais entidades (aparecem só nas equipes que o user pertence). */
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
  if (!wsId || !canAccessWs(req.user, wsId)) return res.status(403).json({ error: 'Sem acesso à equipe' });
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
    if (!canAccessWs(req.user, b.workspaceId)) return res.status(403).json({ error: 'Sem acesso à equipe destino' });
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

  // Período retroativo, ou intervalo escolhido no calendário (period=custom&from&to)
  let startDate = null, endDate = null;
  const ymdQ = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  if (period === 'custom') {
    startDate = ymdQ(req.query.from);
    endDate = ymdQ(req.query.to);
  } else if (period !== 'all') {
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

  const completed = demands.filter(d => d.completedAt && (!startDate || d.completedAt.slice(0,10) >= startDate)
    && (!endDate || d.completedAt.slice(0,10) <= endDate));

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
  const effByClient = {}; // clientId -> { name, hours, demands:Set }
  demands.forEach(d => {
    const entries = (d.timeEntries || []).filter(e =>
      Number(e.hours) > 0 && (!startDate || String(e.createdAt || '').slice(0,10) >= startDate)
       && (!endDate || String(e.createdAt || '').slice(0,10) <= endDate));
    if (!entries.length) return;
    demandsWithLog++;
    const flow = db.flows.find(f => f.id === d.flowId);
    const proj = db.projects.find(p => p.id === d.projectId);
    const client = proj ? db.clients.find(c => c.id === proj.clientId) : null;
    const clientKey = client?.id || '__none__';
    const clientName = client?.name || 'Sem cliente';
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
      if (!effByClient[clientKey]) effByClient[clientKey] = { clientId: clientKey, name: clientName, hours: 0, demands: new Set() };
      effByClient[clientKey].hours += h;
      effByClient[clientKey].demands.add(d.id);
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
  const effortByClient = Object.values(effByClient).map(c => ({
    clientId: c.clientId, name: c.name, hours: c.hours, demands: c.demands.size
  })).sort((a, b) => b.hours - a.hours);

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
      byUser: effortByUser,
      byClient: effortByClient
    }
  });
});

/* ── NOTIFICAÇÕES (por usuário) ── */
// Persistência direto no Postgres (tabela dedicada, INDEX(user_id, created_at)).
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const list = await store.listNotificationsFor(req.user.id, 100);
    res.json(list.filter(n => !n.orgId || n.orgId === req.org.id));
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
    if (!tenancy.orgActive(tenancy.orgOf('demands', parent))) return; // organização excluída/suspensa
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
   Referência = qualquer "/uploads/<arquivo>" em QUALQUER campo de QUALQUER
   entidade em memória (anexo em `data` ou `url`, <img> de rich text, avatar,
   ícone, doc do Writer…). Varrer o JSON inteiro é de propósito: um campo novo
   que guarde upload nunca vira "órfão" por esquecimento. (A versão anterior só
   olhava `a.url`, e anexos de arquivo ficam em `a.data` — eram apagados.)
   Nunca apaga direto: move pra uploads/.trash/ (não é servido, dotfiles deny)
   e só esvazia a lixeira depois de UPLOADS_TRASH_KEEP_MS. Se o arquivo voltar
   a ser referenciado ou for pedido em /uploads, ele volta sozinho. */
const UPLOADS_TRASH_DIR = path.join(UPLOADS_DIR, '.trash');
const UPLOADS_TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
function collectReferencedUploads() {
  const refs = new Set();
  const re = /\/uploads\/([A-Za-z0-9_.\-]+)/g;
  for (const list of Object.values(db || {})) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      let json;
      try { json = JSON.stringify(e); } catch { continue; }
      if (!json || !json.includes('/uploads/')) continue;
      for (const m of json.matchAll(re)) refs.add(m[1]);
    }
  }
  return refs;
}
// Tira um arquivo da lixeira de volta pra uploads/ (true se restaurou).
function restoreUploadFromTrash(name) {
  if (!name || name.startsWith('.') || name !== path.basename(name)) return false;
  const from = path.join(UPLOADS_TRASH_DIR, name);
  const to = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  try { fs.renameSync(from, to); console.log(`  [uploads-gc] ${name} restaurado da lixeira`); return true; }
  catch (e) { console.warn(`[uploads-gc] falha ao restaurar ${name}: ${e.message}`); return false; }
}
function runUploadsGc() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  // Banco não carregado (ou vazio) faria TUDO parecer órfão — não arrisca.
  if (!db || !Array.isArray(db.demands) || !db.demands.length) return;
  const MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24h — upload recém-criado ainda sem entidade
  const now = Date.now();
  const refs = collectReferencedUploads();
  let moved = 0, restored = 0, purged = 0;
  let files;
  try { files = fs.readdirSync(UPLOADS_DIR); } catch { return; }
  for (const name of files) {
    if (name.startsWith('.') || refs.has(name)) continue;
    const full = path.join(UPLOADS_DIR, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs < MIN_AGE_MS) continue;
    try {
      fs.mkdirSync(UPLOADS_TRASH_DIR, { recursive: true });
      const dest = path.join(UPLOADS_TRASH_DIR, name);
      fs.renameSync(full, dest);
      // mtime = hora que entrou na lixeira (conta os 30 dias a partir daqui).
      fs.utimesSync(dest, new Date(), new Date());
      moved++;
    } catch (e) {
      console.warn(`[uploads-gc] falha ao mover ${name} pra lixeira: ${e.message}`);
    }
  }
  let trash = [];
  try { trash = fs.readdirSync(UPLOADS_TRASH_DIR); } catch {}
  for (const name of trash) {
    if (refs.has(name)) { if (restoreUploadFromTrash(name)) restored++; continue; }
    const full = path.join(UPLOADS_TRASH_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && now - stat.mtimeMs > UPLOADS_TRASH_KEEP_MS) { fs.unlinkSync(full); purged++; }
    } catch {}
  }
  if (moved || restored || purged) {
    console.log(`  [uploads-gc] ${moved} órfão(s) na lixeira, ${restored} restaurado(s), ${purged} apagado(s) após 30 dias`);
  }
}
/* Diagnóstico no boot: referências a /uploads cujo arquivo não existe no disco
   (nem na lixeira). Não conserta nada — só deixa visível no log. */
function logMissingUploads() {
  if (!db) return;
  const missing = [...collectReferencedUploads()].filter(name =>
    !fs.existsSync(path.join(UPLOADS_DIR, name)) && !fs.existsSync(path.join(UPLOADS_TRASH_DIR, name)));
  if (missing.length) {
    console.warn(`  [uploads] ${missing.length} arquivo(s) referenciado(s) sem arquivo no disco. Ex.: ${missing.slice(0, 5).join(', ')}`);
  }
}
const _missingBoot = setTimeout(logMissingUploads, 15 * 1000);
if (_missingBoot.unref) _missingBoot.unref();
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
  // Prazo efetivo = prazo da etapa atual (o que o time usa), com o prazo final
  // de reserva — mesma regra do app (effDue). Antes só olhava d.deadline, que
  // quase nunca é preenchido: o resumo saía vazio e não era enviado.
  const due = d => (d.stageDueDate || d.deadline || '').slice(0, 10);
  const overdue = myDemands.filter(d => due(d) && due(d) < todayYmd);
  const dueToday = myDemands.filter(d => due(d) === todayYmd);
  const dueSoon = myDemands.filter(d => due(d) && due(d) > todayYmd && due(d) <= in3days);
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
  const toItem = d => {
    const st = emailStageOf(d);
    return {
      name: d.name,
      href: url ? demandLinkFor(url, d.id) : null,
      client: (db.projects.find(p => p.id === d.projectId) || {}).client || '',
      stageLabel: st && st.label, stageColor: st && st.color,
      due: (d.stageDueDate || d.deadline || '').slice(0, 10),
    };
  };
  const NOTIF_SHORT = { assigned: 'Responsável', stage_assigned: 'Nova etapa', mention: 'Menção', watch_stage: 'Etapa avançou',
    watch_comment: 'Novo comentário', reminder: 'Lembrete', reaction: 'Reação', time_gap: 'Sem apontamento' };
  const sched = digestScheduleOf(user);
  const { subject, html } = emailTpl.digest({
    firstName: user.name.split(' ')[0], baseUrl: url, todayYmd: today(),
    hour: sched.hour, scheduleLabel: digestScheduleLabel(user),
    overdue: overdue.map(toItem), dueToday: dueToday.map(toItem), dueSoon: dueSoon.map(toItem),
    unread: unreadNotifs.map(n => ({ name: n.demandName || NOTIF_SHORT[n.type] || n.type, meta: n.demandName ? NOTIF_SHORT[n.type] || '' : '',
      href: url && n.demandId ? demandLinkFor(url, n.demandId) : null })),
  });
  const text = `${_greetFor(sched.hour)}, ${user.name.split(' ')[0]}!\n\nEm atraso: ${overdue.length}\nVencem hoje: ${dueToday.length}\nPróximos 3 dias: ${dueSoon.length}\nNotificações não lidas: ${unreadNotifs.length}\n\nAbra: ${url}`;
  try {
    await sendEmail(user.email, subject, html, text);
    return true;
  } catch (e) {
    console.error(`[digest] falha ao enviar pra ${user.email}: ${e.message}`);
    return false;
  }
}
async function runDailyDigest() {
  if (!mailEnabled()) return;
  const now = new Date();
  const ymd = today();
  let sent = 0, skipped = 0;
  for (const u of db.users) {
    if (!u.active || u.active === false) continue;
    if (!u.email) continue;
    if (isAway(u)) continue;
    const prefs = u.emailPrefs || defaultEmailPrefs();
    if (prefs.daily_digest === false) continue;
    if (!digestDueNow(u, now)) continue; // dia e hora escolhidos pela pessoa
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

/* ── DIGEST DIÁRIO DE DM DISCORD ──
   Seg-sex, ~8h local. Pra cada usuário com discordId + effectiveDiscordPref
   `daily_digest` ligado, o bot manda uma DM com o resumo do dia dele:
   - Demandas atrasadas
   - Vencendo hoje
   - Vencendo nos próximos 3 dias
   - Notificações não lidas
   Reusa `digestBuildForUser` (mesma lógica do digest de e-mail). Se nada
   relevante pro user, não envia. Idempotência: `user._lastDiscordDigestSent`. */
async function sendDiscordDMDigestForUser(user) {
  if (!discordBot.isEnabled() || !user.discordId) return false;
  const { overdue, dueToday, dueSoon } = digestBuildForUser(user);
  let unreadNotifs = [];
  try {
    const list = await store.listNotificationsFor(user.id, 50);
    unreadNotifs = list.filter(n => !n.read);
  } catch {}
  // 'empty' = nada a reportar (não envia); true = enviada; false = o Discord recusou.
  if (!overdue.length && !dueToday.length && !dueSoon.length && !unreadNotifs.length) return 'empty';
  const baseUrl = process.env.PUBLIC_URL || '';
  const fmt = (d) => {
    const proj = db.projects.find(p => p.id === d.projectId);
    const url = baseUrl ? demandLinkFor(baseUrl, d.id) : null;
    const line = url ? `[**${d.name}**](${url})` : `**${d.name}**`;
    const meta = [proj?.client, proj?.name].filter(Boolean).join(' · ');
    return meta ? `• ${line} — ${meta}` : `• ${line}`;
  };
  const clip = (items, n) => items.slice(0, n).map(fmt).join('\n') +
    (items.length > n ? `\n_…e mais ${items.length - n}_` : '');
  const fields = [];
  if (overdue.length)  fields.push({ name: `🔥 Em atraso (${overdue.length})`,     value: clip(overdue, 8),  inline: false });
  if (dueToday.length) fields.push({ name: `📅 Vencem hoje (${dueToday.length})`,  value: clip(dueToday, 8), inline: false });
  if (dueSoon.length)  fields.push({ name: `⏭️ Próximos 3 dias (${dueSoon.length})`, value: clip(dueSoon, 8),  inline: false });
  if (unreadNotifs.length) fields.push({ name: `🔔 Notificações não lidas`, value: String(unreadNotifs.length), inline: true });
  const firstName = (user.name || '').split(/\s+/)[0] || user.name || '';
  const payload = {
    embeds: [{
      title: `${digestScheduleOf(user).hour < 12 ? '☀️ ' : ''}${_greetFor(digestScheduleOf(user).hour)}, ${firstName}!`,
      description: `Aqui está o resumo do dia — ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}.`,
      color: overdue.length ? 0xEF5050 : 0x7A00FF,
      fields,
      footer: { text: 'reWork · resumo diário' },
      timestamp: new Date().toISOString(),
    }],
  };
  const ok = await discordBot.sendDM(user.discordId, payload);
  if (!ok) console.warn(`[discord-dm-digest] Discord recusou a DM de ${user.username} (DMs bloqueadas ou ID inválido?)`);
  return ok;
}
async function runDailyBotDMDigest() {
  if (!discordBot.isEnabled()) return;
  const now = new Date();
  const ymd = today();
  let sent = 0, skipped = 0;
  for (const u of db.users) {
    if (u.active === false) continue;
    if (!u.discordId) continue;
    if (isAway(u)) continue;
    if (!effectiveDiscordPref(u, 'daily_digest')) continue;
    if (!digestDueNow(u, now)) continue; // dia e hora escolhidos pela pessoa
    if (u._lastDiscordDigestSent === ymd) { skipped++; continue; }
    let result = false;
    try {
      result = await sendDiscordDMDigestForUser(u);
      if (result === true) sent++;
    } catch (e) {
      console.warn(`[discord-dm-digest] falha ${u.username}:`, e.message);
    }
    // Marca o dia quando enviou ou quando não havia nada. Se o Discord recusou,
    // não marca: o próximo ciclo (15 min) tenta de novo dentro da janela.
    if (result === true || result === 'empty') {
      u._lastDiscordDigestSent = ymd;
      saveEntity('users', u);
    }
  }
  if (sent > 0) console.log(`  [discord-dm-digest] ${sent} DM(s) enviada(s) · ${skipped} pulada(s)`);
}
// Mesmo padrão do digest de e-mail — 15min interval + 2min após boot.
const _ddDigestInterval = setInterval(runDailyBotDMDigest, 15 * 60 * 1000);
if (_ddDigestInterval.unref) _ddDigestInterval.unref();
const _ddDigestBoot = setTimeout(runDailyBotDMDigest, 2 * 60 * 1000);
if (_ddDigestBoot.unref) _ddDigestBoot.unref();

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

/* Envia evento SSE pra UM usuário específico (não broadcast por workspace).
   Usado por notificações que são pessoais — cada notif é do usuário-alvo,
   ninguém mais precisa saber. Substitui o polling agressivo de 30s. */
function broadcastToUser(userId, entity, op, extra = {}) {
  const conns = sseClients.get(userId);
  if (!conns || !conns.size) return;
  const payload = JSON.stringify({ entity, op, ...extra, ts: Date.now() });
  const line = `data: ${payload}\n\n`;
  for (const res of conns) {
    try { res.write(line); } catch {}
  }
}

/* ─── PRESENÇA AO VIVO ────────────────────────────────────────────
   Rastreia quem está com a demanda aberta AGORA. Piggyback no SSE já
   existente: cliente manda heartbeat (POST) a cada 15s enquanto olha
   a demanda; servidor broadcast SSE 'presence' pros outros usuários do
   mesmo workspace quando a lista muda; sweeper de 15s remove ausentes
   (30s sem heartbeat = removido).
   Sem WebSocket novo, sem servidor adicional — só um Map em memória. */
const presenceMap = new Map(); // key: `${kind}:${id}` → Map<userId, {ts, wsId}>
const PRESENCE_STALE_MS = 30000;
const PRESENCE_SWEEP_MS = 15000;

function _presenceKey(kind, id) { return `${kind}:${id}`; }

function _presenceUsersFor(kind, id) {
  const set = presenceMap.get(_presenceKey(kind, id));
  if (!set) return [];
  const arr = [];
  for (const [userId, meta] of set) {
    const u = db.users.find(x => x.id === userId);
    if (!u || u.active === false) continue;
    arr.push({
      id: u.id,
      name: u.name || u.username || 'Usuário',
      avatar: u.avatar || null,
      color: u.color || null,
      ts: meta.ts
    });
  }
  return arr;
}

function _broadcastPresence(kind, id, workspaceId) {
  if (sseClients.size === 0) return;
  const users = _presenceUsersFor(kind, id);
  const payload = JSON.stringify({ entity: 'presence', kind, id, users, ts: Date.now() });
  const line = `data: ${payload}\n\n`;
  for (const [userId, conns] of sseClients) {
    const user = db.users.find(u => u.id === userId);
    if (!user) continue;
    if (workspaceId && !canAccessWs(user, workspaceId)) continue;
    for (const res of conns) { try { res.write(line); } catch {} }
  }
}

// Sweeper: remove entradas velhas e emite update quando algo mudou.
setInterval(() => {
  const now = Date.now();
  const dirty = []; // { kind, id, wsId }
  for (const [key, set] of presenceMap) {
    let changed = false;
    for (const [userId, meta] of set) {
      if (now - meta.ts > PRESENCE_STALE_MS) { set.delete(userId); changed = true; }
    }
    if (changed) {
      const [kind, id] = key.split(':');
      let wsId = null;
      if (kind === 'demand') { const d = db.demands.find(x => x.id === id); wsId = d?.workspaceId || null; }
      dirty.push({ kind, id, wsId });
    }
    if (set.size === 0) presenceMap.delete(key);
  }
  for (const { kind, id, wsId } of dirty) _broadcastPresence(kind, id, wsId);
}, PRESENCE_SWEEP_MS);

app.post('/api/presence/:kind/:id/heartbeat', requireAuth, (req, res) => {
  const { kind, id } = req.params;
  if (kind !== 'demand') return res.status(400).json({ error: 'kind inválido' });
  const demand = db.demands.find(x => x.id === id);
  if (!demand) return res.status(404).json({ error: 'Demanda não encontrada.' });
  if (!canAccessWs(req.user, demand.workspaceId)) return res.status(403).json({ error: 'Sem acesso a esta demanda.' });
  const key = _presenceKey(kind, id);
  if (!presenceMap.has(key)) presenceMap.set(key, new Map());
  const set = presenceMap.get(key);
  const isNew = !set.has(req.user.id);
  set.set(req.user.id, { ts: Date.now(), wsId: demand.workspaceId });
  const users = _presenceUsersFor(kind, id);
  // Só faz broadcast quando entra alguém novo (evita spam de renders).
  if (isNew) _broadcastPresence(kind, id, demand.workspaceId);
  res.json({ users });
});

app.delete('/api/presence/:kind/:id', requireAuth, (req, res) => {
  const { kind, id } = req.params;
  const key = _presenceKey(kind, id);
  const set = presenceMap.get(key);
  if (set && set.delete(req.user.id)) {
    if (set.size === 0) presenceMap.delete(key);
    const demand = db.demands.find(x => x.id === id);
    _broadcastPresence(kind, id, demand?.workspaceId || null);
  }
  res.json({ ok: true });
});

/* Endpoints admin-only pra agregação de dados de usuários. Cru sobre o
   que já existe (SSE, presence, history/comments/timeEntries em cada
   demanda). publicUser() já filtra googleTokens/knownIps. */
function _godmodeReversePresence() {
  // Se um user aparece em várias entradas do presenceMap (múltiplas abas),
  // vence a de heartbeat mais recente.
  const out = new Map();
  for (const [key, set] of presenceMap) {
    if (!key.startsWith('demand:')) continue;
    const demandId = key.slice(7);
    for (const [uid, meta] of set) {
      const cur = out.get(uid);
      if (!cur || meta.ts > cur.since) out.set(uid, { demandId, since: meta.ts });
    }
  }
  return out;
}

function _godmodeStatsFor(userId) {
  // Contagens rápidas. Iteração linear em db.demands — ok pra escala
  // atual (centenas de demandas). Se crescer, indexar por ownerId etc.
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  let activeDemands = 0, createdThisMonth = 0, watchedCount = 0, doneThisWeek = 0;
  let hoursThisWeek = 0, commentsThisMonth = 0, activityThisWeek = 0;
  // Cycle time — soma e conta demandas concluídas com createdAt válido.
  let cycleMsSum = 0, cycleCount = 0;
  // Atraso — denominador só demandas com prazo definido.
  let demandsWithDeadline = 0, demandsLate = 0;
  for (const d of db.demands) {
    if (d.deletedAt) continue;
    if (d.ownerId === userId) {
      if (!d.completedAt) activeDemands++;
      if (d.completedAt && Date.parse(d.completedAt) > weekAgo) doneThisWeek++;
      // Cycle time só faz sentido em concluídas.
      if (d.completedAt && d.createdAt) {
        const diff = Date.parse(d.completedAt) - Date.parse(d.createdAt);
        if (Number.isFinite(diff) && diff >= 0) { cycleMsSum += diff; cycleCount++; }
      }
      // Atrasos: demanda tem prazo? já venceu (aberta) OU foi concluída depois?
      const deadline = d.stageDueDate || d.deadline || null;
      if (deadline) {
        demandsWithDeadline++;
        const deadlineTs = Date.parse(deadline.slice(0, 10) + 'T23:59:59');
        if (d.completedAt) {
          if (Date.parse(d.completedAt) > deadlineTs) demandsLate++;
        } else if (now > deadlineTs) {
          demandsLate++;
        }
      }
    }
    if (d.createdBy === userId && d.createdAt && Date.parse(d.createdAt) > monthAgo) createdThisMonth++;
    if (Array.isArray(d.watchers) && d.watchers.includes(userId)) watchedCount++;
    if (Array.isArray(d.timeEntries)) {
      for (const t of d.timeEntries) {
        if (t.userId !== userId) continue;
        const ts = t.date ? Date.parse(t.date) : (t.createdAt ? Date.parse(t.createdAt) : 0);
        if (ts > weekAgo) hoursThisWeek += Number(t.hours) || 0;
      }
    }
    if (Array.isArray(d.comments)) {
      for (const c of d.comments) {
        if (c.userId !== userId) continue;
        const ts = Date.parse(c.createdAt || c.at || 0);
        if (ts > monthAgo) commentsThisMonth++;
      }
    }
    if (Array.isArray(d.history)) {
      for (const h of d.history) {
        if (h.userId !== userId) continue;
        const ts = Date.parse(h.at || 0);
        if (ts > weekAgo) activityThisWeek++;
      }
    }
  }
  const activeMinutes = _activeMinutesInWindow(userId, 7 * 24 * 60 * 60 * 1000);
  return {
    activeDemands, createdThisMonth, watchedCount, doneThisWeek,
    hoursThisWeek: Math.round(hoursThisWeek * 100) / 100,
    commentsThisMonth, activityThisWeek,
    // Cycle time médio em ms; frontend formata em h/d.
    avgCycleMs: cycleCount > 0 ? Math.round(cycleMsSum / cycleCount) : null,
    cycleSampleCount: cycleCount,
    // % atraso — 0..100. Null quando não tem base pra calcular (sem prazos).
    latePercent: demandsWithDeadline > 0 ? Math.round((demandsLate / demandsWithDeadline) * 100) : null,
    lateCount: demandsLate,
    deadlineCount: demandsWithDeadline,
    // Horas ativas na semana (buckets de 5min de /me/ping).
    activeHoursThisWeek: Math.round((activeMinutes / 60) * 10) / 10
  };
}

function _godmodeRecentActivity(userId, limit = 40) {
  // Junta history + comments + timeEntries do user em ordem cronológica desc.
  const events = [];
  for (const d of db.demands) {
    if (d.deletedAt) continue;
    const dLabel = d.name || '(sem título)';
    for (const h of (d.history || [])) {
      if (h.userId !== userId) continue;
      events.push({ at: h.at, kind: 'history', action: h.action, details: h.details, demandId: d.id, demandName: dLabel });
    }
    for (const c of (d.comments || [])) {
      if (c.userId !== userId) continue;
      const at = c.createdAt || c.at;
      if (!at) continue;
      const raw = String(c.text || c.body || '');
      const preview = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
      events.push({ at, kind: 'comment', preview, demandId: d.id, demandName: dLabel });
    }
    for (const t of (d.timeEntries || [])) {
      if (t.userId !== userId) continue;
      const at = t.createdAt || (t.date ? t.date + 'T00:00:00Z' : null);
      if (!at) continue;
      events.push({ at, kind: 'time', hours: t.hours, note: t.description || t.note || null, demandId: d.id, demandName: dLabel });
    }
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return events.slice(0, limit);
}

app.get('/api/admin/godmode/overview', requireAuth, adminOnly, (req, res) => {
  const now = Date.now();
  const presenceByUser = _godmodeReversePresence();
  const users = db.users.map(u => {
    const pub = publicUser(u);
    const online = sseClients.has(u.id) && sseClients.get(u.id).size > 0;
    const tabCount = online ? sseClients.get(u.id).size : 0;
    const viewing = presenceByUser.get(u.id) || null;
    let viewingDetail = null;
    if (viewing) {
      const d = db.demands.find(x => x.id === viewing.demandId);
      viewingDetail = {
        demandId: viewing.demandId,
        demandName: d ? d.name : '(demanda removida)',
        workspaceId: d ? d.workspaceId : null,
        since: new Date(viewing.since).toISOString()
      };
    }
    return {
      id: pub.id,
      name: pub.name,
      username: pub.username,
      email: pub.email,
      avatar: pub.avatar,
      color: pub.color || null,
      role: pub.role || null,
      isAdmin: !!pub.isAdmin,
      isModerator: !!pub.isModerator,
      isFreelancer: !!pub.isFreelancer,
      active: pub.active !== false,
      workspaces: pub.workspaces || [],
      lastSeen: pub.lastSeen || null,
      createdAt: pub.createdAt || null,
      online, tabCount, viewing: viewingDetail,
      stats: _godmodeStatsFor(u.id)
    };
  });
  users.sort((a, b) => {
    // Online primeiro, dentro do mesmo grupo, por lastSeen desc.
    if (a.online !== b.online) return a.online ? -1 : 1;
    const la = a.lastSeen ? Date.parse(a.lastSeen) : 0;
    const lb = b.lastSeen ? Date.parse(b.lastSeen) : 0;
    return lb - la;
  });
  res.json({
    generatedAt: new Date(now).toISOString(),
    totals: {
      users: users.length,
      online: users.filter(u => u.online).length,
      inDemand: users.filter(u => u.viewing).length
    },
    users
  });
});

app.get('/api/admin/godmode/user/:id', requireAuth, adminOnly, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  const pub = publicUser(u);
  const online = sseClients.has(u.id) && sseClients.get(u.id).size > 0;
  const tabCount = online ? sseClients.get(u.id).size : 0;
  const presenceByUser = _godmodeReversePresence();
  const viewing = presenceByUser.get(u.id) || null;
  let viewingDetail = null;
  if (viewing) {
    const d = db.demands.find(x => x.id === viewing.demandId);
    viewingDetail = {
      demandId: viewing.demandId,
      demandName: d ? d.name : '(removida)',
      workspaceId: d ? d.workspaceId : null,
      since: new Date(viewing.since).toISOString()
    };
  }
  const assigned = db.demands
    .filter(d => !d.deletedAt && d.ownerId === u.id && !d.completedAt)
    .map(d => ({ id: d.id, name: d.name, workspaceId: d.workspaceId, deadline: d.deadline || null, stageDueDate: d.stageDueDate || null, status: d.status || null }));
  const watched = db.demands
    .filter(d => !d.deletedAt && Array.isArray(d.watchers) && d.watchers.includes(u.id))
    .map(d => ({ id: d.id, name: d.name, workspaceId: d.workspaceId }));
  const createdRecent = db.demands
    .filter(d => !d.deletedAt && d.createdBy === u.id)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, 20)
    .map(d => ({ id: d.id, name: d.name, workspaceId: d.workspaceId, createdAt: d.createdAt || null }));
  res.json({
    user: {
      id: pub.id, name: pub.name, username: pub.username, email: pub.email, avatar: pub.avatar,
      role: pub.role || null, phone: pub.phone || null, discord: pub.discord || null, discordId: pub.discordId || null,
      isAdmin: !!pub.isAdmin, isModerator: !!pub.isModerator, isFreelancer: !!pub.isFreelancer,
      active: pub.active !== false,
      color: pub.color || null,
      workspaces: pub.workspaces || [],
      lastSeen: pub.lastSeen || null,
      createdAt: pub.createdAt || null,
      googleConnected: !!pub.googleConnected,
      knownIpCount: Array.isArray(u.knownIps) ? u.knownIps.length : 0
    },
    presence: { online, tabCount, viewing: viewingDetail },
    stats: _godmodeStatsFor(u.id),
    recentActivity: _godmodeRecentActivity(u.id, 40),
    assignedDemands: assigned,
    watchedDemands: watched,
    createdRecent
  });
});

/* ── FALLBACK ── */
// /api/* desconhecidos: devolve 404 JSON em vez de cair no SPA (que retornaria
// HTML com status 200 e quebraria clientes que esperam JSON).
app.all(/^\/api\/.*/, (req, res) => {
  res.status(404).json({ error: `Endpoint não encontrado: ${req.method} ${req.originalUrl}` });
});
// Rota pública read-only: /public/client/<token> — serve a página standalone.
// O token é validado pelo JS da própria página via /api/public/client/:token.
app.get(/^\/public\/client\/[a-f0-9]{48}$/i, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'public-client.html'));
});
// reWork Hub — home standalone dos subprodutos (Docs, Presentations, etc).
// Portal separado da plataforma principal, acessado pelo ícone do topbar.
app.get(/^\/hub\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hub.html'));
});

// reWork Docs — página standalone, INDEPENDENTE da plataforma (abre em outra
// guia, tem shell próprio, sem sidebar/topbar do app). A auth ainda é checada
// pelo JS via /api/writer/... (o cookie de sessão é enviado pelo browser).
//   URL pública: /hub/docs, /hub/docs/<slug-id>  (o Docs é um subproduto do Hub)
//   API interna: /api/writer/* (mantém "writer" nas rotas do servidor pra não
//     misturar com a documentação; a URL pública "docs" é o produto).
//   Documentação/manual foi realocada pra /help/*.
// /hub/docs               → landing
// /hub/docs/<slug>        → editor privado
// /hub/docs/public/<tok>  → viewer público (leitura, sem auth)
app.get(/^\/hub\/docs(?:\/(?:public\/[a-zA-Z0-9]+|[a-zA-Z0-9-]+))?\/?$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'writer.html'));
});
// Redirect legado — links antigos pra /docs continuam funcionando.
app.get(/^\/docs(\/(?:public\/[a-zA-Z0-9]+|[a-zA-Z0-9-]+))?\/?$/, (req, res) => {
  res.redirect(301, '/hub/docs' + (req.params[0] || ''));
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

// Runtime de colaboração do Docs (setado no boot) — o shutdown salva as salas.
let _docsRt = null;
if (require.main === module) {
  _boot.then(async () => {
    const server = app.listen(PORT, () => console.log(`\n  fluxo. rodando em  →  http://localhost:${PORT}\n`));
    setupGracefulShutdown(server);
    // Kastor Docs — WebSocket runtime pra colab realtime. Pluga no MESMO
    // http.Server que o Express usa (compartilha a porta, sem processo extra).
    try {
      const docsRt = require('./docs-rt.js');
      _docsRt = await docsRt.setup(server, {
        // Autentica via cookie de sessão (mesmo do Express)
        authenticate(req) {
          const cookies = parseCookies(req);
          const token = cookies[SESSION_COOKIE] || null;
          const uid = token && auth.userIdForToken(token);
          if (!uid) return null;
          const user = db.users.find(u => u.id === uid && u.active !== false);
          if (!user || user.isFreelancer) return null;
          return uid;
        },
        // Autoriza acesso ao doc — mesmo escopo do REST
        async canAccess(docId, userId) {
          const doc = (rawDb.writerDocuments || []).find(d => d.id === docId);
          const orgId = doc && tenancy.wsOrgId(doc.workspaceId);
          if (!orgId || orgPlan(tenancy.orgById(orgId)).readOnly) return false;
          return tenancy.run(orgId, () => {
            const user = db.users.find(u => u.id === userId);
            if (user && emailEnforced() && !emailLinked(user)) return false;
            return !!user && user.active !== false && writerCanRead(user, doc);
          });
        },
        // Carrega snapshot Yjs prévio (base64 em db)
        async loadInitialState(docId) {
          const doc = (db.writerDocuments || []).find(d => d.id === docId);
          if (!doc || !doc.yState) return null;
          try { return Buffer.from(doc.yState, 'base64'); } catch { return null; }
        },
        // Persiste update — só ambos os estados avançam juntos (yState + content).
        // O client ainda faz PUT /content pra manter PM JSON pra viewer/export
        // (é fonte de verdade da lista + preview + export não-colab).
        onPersist(docId, updateBytes) {
          const doc = (db.writerDocuments || []).find(d => d.id === docId);
          if (!doc) return;
          doc.yState = Buffer.from(updateBytes).toString('base64');
          doc.updatedAt = nowISO();
          saveEntity('writerDocuments', doc);
        }
      });
      console.log('  Kastor Docs realtime  →  ws://localhost:' + PORT + '/rt/docs/<id>');
    } catch (e) {
      console.error('[docs-rt] falha ao inicializar:', e.message);
    }
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

    // 1b) Salva o estado dos documentos abertos (colaboração em tempo real).
    //     Sem isso um deploy perde até 30s de edição e docs novos voltam vazios.
    try { if (_docsRt && _docsRt.persistAll) { _docsRt.persistAll(); console.log('[shutdown] documentos salvos'); } }
    catch (e) { console.error('[shutdown] docs:', e.message); }

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
      await auth.flush(); // senhas/sessões pendentes
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
    try { await auth.flush(); } catch {}
    process.exit(1);
  });
}
module.exports = app;
module.exports.ready = _boot;
// Só pros testes: troca o envio de e-mail por um falso (undefined = volta ao .env).
module.exports._test = { setMailTransport(t) { _mailTransport = t; } };
