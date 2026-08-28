/* ───────────────────────────────────────────────────────────────
   reWork — Camada de persistência PostgreSQL (via `pg`)

   Modelo híbrido:
     - Tabela genérica `entities` guarda cada entidade como (type, id, workspace_id, JSONB)
       com índice em (type, workspace_id). Listagens por workspace ficam O(log n).
     - Tabela `notifications` é dedicada (escrita frequente, busca por usuário).
     - Tabela `password_resets` separada por mesmo motivo.
     - Tabela `kv` pra flags simples (versão de schema, install:completed, etc.).

   Por que assim e não tabelas por entidade?
     - Schema permanece flexível enquanto o código ainda evolui.
     - Servidor continua operando entidades como objetos JS, sem ORM.
     - Migração futura pra colunas dedicadas em hot paths é localizada.

   Conexão:
     - Lê `DATABASE_URL` do ambiente (formato postgres://user:pass@host:port/db).
     - Alternativa: passar { connectionString, ssl, max } pra createStore.
     - Sem DATABASE_URL nem overrides, `pg` cai nos padrões PG* (PGHOST, PGUSER, …).
   ─────────────────────────────────────────────────────────────── */
const { Pool } = require('pg');

const ENTITY_TYPES = [
  'workspaces', 'users', 'clients', 'projects', 'flows',
  'demands', 'roles', 'positions', 'templates', 'webhooks', 'schedules', 'clientTemplates',
  'recurrings', 'listas', 'demandTypes', 'googleEvents', 'tasks',
  'passwords', 'passwordFolders', 'passwordAudits', 'posts',
  'discordChannels',
  'formTemplates', 'formResponses', 'dashboards'
];

function createStore(config = {}) {
  const pool = new Pool({
    connectionString: config.connectionString || process.env.DATABASE_URL,
    ssl: config.ssl !== undefined ? config.ssl : sslFromEnv(),
    max: config.max || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });

  // Log de erros de conexões ociosas — sem isso, um erro em conexão idle
  // do pool derruba o processo (default do Node em unhandled 'error').
  pool.on('error', err => console.error('[pg pool] erro em conexão idle:', err.message));

  /* ── SCHEMA ──
     CREATE TABLE IF NOT EXISTS é idempotente — seguro rodar todo boot. */
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS entities (
        type          TEXT   NOT NULL,
        id            TEXT   NOT NULL,
        workspace_id  TEXT,
        data          JSONB  NOT NULL,
        updated_at    BIGINT NOT NULL,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_type_ws
        ON entities (type, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type_updated
        ON entities (type, updated_at DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        id          TEXT   PRIMARY KEY,
        user_id     TEXT   NOT NULL,
        data        JSONB  NOT NULL,
        is_read     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notif_user_created
        ON notifications (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notif_user_read
        ON notifications (user_id, is_read);

      CREATE TABLE IF NOT EXISTS password_resets (
        token       TEXT   PRIMARY KEY,
        user_id     TEXT   NOT NULL,
        expires_at  BIGINT NOT NULL,
        used        BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pwreset_expires
        ON password_resets (expires_at);

      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT
      );

      /* Snapshots diários de marketing por (client, platform, campaign, date).
         Ingestão via webhook do n8n. Cada linha = fotografia do dia.
         Guarda métricas em colunas dedicadas (queries por período/agregação
         ficam SQL puro) e o payload cru em raw pra evolução futura de campos
         sem migração. Índice (client_id, date) cobre o padrão de leitura
         principal: "todos os snapshots de X entre A e B". */
      CREATE TABLE IF NOT EXISTS marketing_snapshots (
        client_id           TEXT   NOT NULL,
        platform            TEXT   NOT NULL,
        campaign            TEXT   NOT NULL,
        date                DATE   NOT NULL,
        spend               NUMERIC,
        avg_daily           NUMERIC,
        leads               NUMERIC,
        cpl                 NUMERIC,
        impressions         NUMERIC,
        reach               NUMERIC,
        clicks              NUMERIC,
        cpm                 NUMERIC,
        cpc                 NUMERIC,
        profile_visits      NUMERIC,
        new_followers       NUMERIC,
        proj_spend_campaign NUMERIC,
        proj_leads_campaign NUMERIC,
        monthly_budget      NUMERIC,
        proj_spend_account  NUMERIC,
        proj_leads_account  NUMERIC,
        alert_status        TEXT,
        alert_analysis      TEXT,
        raw                 JSONB,
        ingested_at         BIGINT NOT NULL,
        PRIMARY KEY (client_id, platform, campaign, date)
      );
      CREATE INDEX IF NOT EXISTS idx_mkt_client_date
        ON marketing_snapshots (client_id, date DESC);
    `);
  }

  /* ── TRANSAÇÃO ──
     Reserva uma conexão do pool, roda a callback em transação. Faz rollback
     em caso de erro. A callback recebe um cliente `pg` conectado. */
  async function transaction(cb) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await cb(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  // ── ENTIDADES ──
  // Extrator de workspace_id pra cada tipo. Entidades globais devolvem null.
  function workspaceIdOf(type, entity) {
    if (!entity) return null;
    // Tipos globais: não têm workspaceId no índice — visíveis a todos os usuários.
    // clientTemplates são compartilhados entre workspaces (por design de UX).
    if (type === 'workspaces' || type === 'roles' || type === 'users' ||
        type === 'positions' || type === 'clientTemplates' || type === 'demandTypes') return null;
    return entity.workspaceId || null;
  }

  async function upsert(type, entity, client) {
    if (!entity || !entity.id) throw new Error('upsert: entity sem id');
    const wsId = workspaceIdOf(type, entity);
    const runner = client || pool;
    await runner.query(
      `INSERT INTO entities (type, id, workspace_id, data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (type, id) DO UPDATE
         SET workspace_id = EXCLUDED.workspace_id,
             data         = EXCLUDED.data,
             updated_at   = EXCLUDED.updated_at`,
      [type, entity.id, wsId, JSON.stringify(entity), Date.now()]
    );
  }

  async function upsertMany(type, list) {
    if (!list || !list.length) return;
    await transaction(async client => {
      for (const entity of list) await upsert(type, entity, client);
    });
  }

  async function remove(type, id, client) {
    const runner = client || pool;
    await runner.query('DELETE FROM entities WHERE type = $1 AND id = $2', [type, id]);
  }

  async function get(type, id) {
    const r = await pool.query(
      'SELECT data FROM entities WHERE type = $1 AND id = $2',
      [type, id]
    );
    // pg já parseia jsonb — data vem como objeto, não string.
    return r.rows.length ? r.rows[0].data : null;
  }

  async function listByType(type) {
    const r = await pool.query('SELECT data FROM entities WHERE type = $1', [type]);
    return r.rows.map(row => row.data);
  }

  async function listByWorkspace(type, wsId) {
    const r = await pool.query(
      'SELECT data FROM entities WHERE type = $1 AND workspace_id = $2',
      [type, wsId]
    );
    return r.rows.map(row => row.data);
  }

  // Carrega todas as entidades pra um objeto compatível com o `db` em memória
  // que o restante do código já espera (chaves: workspaces, users, demands, etc).
  async function loadAllToCache() {
    const out = { notifications: [] }; // notifications viajam por endpoint dedicado
    // Uma query por tipo — poderia virar UMA query com todos os tipos, mas
    // o custo em boot é irrelevante frente à clareza.
    for (const t of ENTITY_TYPES) out[t] = await listByType(t);
    return out;
  }

  // Aplica um lote de operações (upserts e removes) em UMA transação.
  // Usado pelo flushDirty no server pra batchar writes concorrentes.
  async function applyBatch(items) {
    if (!items || !items.length) return;
    await transaction(async client => {
      for (const it of items) {
        if (it.op === 'upsert') await upsert(it.type, it.entity, client);
        else await remove(it.type, it.id, client);
      }
    });
  }

  // ── NOTIFICAÇÕES ──
  async function insertNotification(n) {
    await pool.query(
      `INSERT INTO notifications (id, user_id, data, is_read, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [n.id, n.userId, JSON.stringify(n), !!n.read, Date.parse(n.createdAt) || Date.now()]
    );
  }
  async function listNotificationsFor(userId, limit = 100) {
    const r = await pool.query(
      `SELECT id, data, is_read FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return r.rows.map(row => {
      const obj = row.data;
      obj.read = !!row.is_read;
      return obj;
    });
  }
  async function markNotificationRead(id) {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1', [id]);
  }
  /* Marca UMA notificação como lida, mas só se pertencer ao usuário informado.
     Retorna a notificação (com read=true) ou null se não achou / não é do usuário.
     Evita o padrão "busca 500 pra validar 1 id" com uma query só. */
  async function markNotificationReadIfOwner(id, userId) {
    const r = await pool.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING id, data, is_read`,
      [id, userId]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const obj = row.data;
    obj.read = !!row.is_read;
    return obj;
  }
  async function markAllNotificationsReadFor(userId) {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [userId]);
  }
  async function deleteAllNotificationsFor(userId) {
    await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  }
  async function trimNotificationsFor(userId, keep) {
    // Mantém as `keep` notificações mais recentes, apaga o resto.
    await pool.query(
      `DELETE FROM notifications
       WHERE id IN (
         SELECT id FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         OFFSET $2
       )`,
      [userId, keep]
    );
  }

  // ── PASSWORD RESETS ──
  async function insertReset(rec) {
    await pool.query(
      `INSERT INTO password_resets (token, user_id, expires_at, used, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [rec.token, rec.userId, rec.expiresAt, !!rec.used, Date.parse(rec.createdAt) || Date.now()]
    );
  }
  async function getReset(token) {
    const r = await pool.query(
      'SELECT user_id, expires_at, used FROM password_resets WHERE token = $1',
      [token]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { userId: row.user_id, expiresAt: Number(row.expires_at), used: !!row.used };
  }
  async function markResetUsed(token) {
    await pool.query('UPDATE password_resets SET used = TRUE WHERE token = $1', [token]);
  }
  async function cleanupResets() {
    await pool.query(
      'DELETE FROM password_resets WHERE used = TRUE OR expires_at < $1',
      [Date.now()]
    );
  }

  // ── KV simples (flags de instalação, versão de schema, etc.) ──
  async function getKv(k) {
    const r = await pool.query('SELECT v FROM kv WHERE k = $1', [k]);
    return r.rows.length ? r.rows[0].v : null;
  }
  async function setKv(k, v) {
    await pool.query(
      `INSERT INTO kv (k, v) VALUES ($1, $2)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [k, String(v)]
    );
  }

  async function ping() { await pool.query('SELECT 1'); }
  async function close() { await pool.end(); }

  // ── MARKETING SNAPSHOTS ──
  // Colunas gravadas por upsertMarketingSnapshots (ordem importa: casa com o
  // array de valores montado abaixo). Manter sincronizado com o CREATE TABLE.
  const MKT_COLS = [
    'client_id','platform','campaign','date','spend','avg_daily','leads','cpl',
    'impressions','reach','clicks','cpm','cpc','profile_visits','new_followers',
    'proj_spend_campaign','proj_leads_campaign','monthly_budget',
    'proj_spend_account','proj_leads_account','alert_status','alert_analysis',
    'raw','ingested_at'
  ];
  async function upsertMarketingSnapshots(rows) {
    if (!rows || !rows.length) return { inserted: 0, updated: 0 };
    // Batch UPSERT via multi-row INSERT ... ON CONFLICT. Uma tx só, evitando
    // N round-trips. Postgres retorna xmax=0 quando inseriu, !=0 quando update.
    const now = Date.now();
    const values = [];
    const params = [];
    let p = 1;
    for (const r of rows) {
      const rowParams = [
        r.client_id, r.platform, r.campaign, r.date,
        r.spend, r.avg_daily, r.leads, r.cpl,
        r.impressions, r.reach, r.clicks, r.cpm, r.cpc,
        r.profile_visits, r.new_followers,
        r.proj_spend_campaign, r.proj_leads_campaign, r.monthly_budget,
        r.proj_spend_account, r.proj_leads_account,
        r.alert_status, r.alert_analysis,
        r.raw ? JSON.stringify(r.raw) : null,
        now
      ];
      const placeholders = rowParams.map((_, i) => {
        // raw é JSONB — precisa de cast explícito.
        if (i === 22) return `$${p + i}::jsonb`;
        return `$${p + i}`;
      });
      values.push(`(${placeholders.join(',')})`);
      params.push(...rowParams);
      p += rowParams.length;
    }
    const updateSet = MKT_COLS
      .filter(c => !['client_id','platform','campaign','date'].includes(c))
      .map(c => `${c} = EXCLUDED.${c}`).join(',\n             ');
    const sql = `
      INSERT INTO marketing_snapshots (${MKT_COLS.join(',')})
      VALUES ${values.join(',')}
      ON CONFLICT (client_id, platform, campaign, date) DO UPDATE
        SET ${updateSet}
      RETURNING (xmax = 0) AS inserted
    `;
    const r = await pool.query(sql, params);
    let inserted = 0, updated = 0;
    for (const row of r.rows) row.inserted ? inserted++ : updated++;
    return { inserted, updated };
  }
  async function listMarketingSnapshots(clientIdOrIds, startDate, endDate) {
    // startDate/endDate: string ISO 'YYYY-MM-DD'. Ambos inclusivos.
    // clientIdOrIds: string única OU array de ids (query multi-cliente do squad).
    const ids = Array.isArray(clientIdOrIds) ? clientIdOrIds : [clientIdOrIds];
    if (!ids.length) return [];
    const r = await pool.query(
      `SELECT ${MKT_COLS.join(',')} FROM marketing_snapshots
       WHERE client_id = ANY($1) AND date >= $2 AND date <= $3
       ORDER BY date ASC, platform ASC, campaign ASC`,
      [ids, startDate, endDate]
    );
    return r.rows.map(row => {
      // Postgres devolve DATE como Date object — normaliza pra 'YYYY-MM-DD'
      // (fuso-safe: usa componentes UTC pra evitar shift no serialize).
      const d = row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date);
      const num = v => v === null || v === undefined ? null : Number(v);
      return {
        clientId: row.client_id,
        platform: row.platform,
        campaign: row.campaign,
        date: d,
        spend: num(row.spend),
        avgDaily: num(row.avg_daily),
        leads: num(row.leads),
        cpl: num(row.cpl),
        impressions: num(row.impressions),
        reach: num(row.reach),
        clicks: num(row.clicks),
        cpm: num(row.cpm),
        cpc: num(row.cpc),
        profileVisits: num(row.profile_visits),
        newFollowers: num(row.new_followers),
        projSpendCampaign: num(row.proj_spend_campaign),
        projLeadsCampaign: num(row.proj_leads_campaign),
        monthlyBudget: num(row.monthly_budget),
        projSpendAccount: num(row.proj_spend_account),
        projLeadsAccount: num(row.proj_leads_account),
        alertStatus: row.alert_status,
        alertAnalysis: row.alert_analysis
      };
    });
  }

  return {
    init,
    transaction,
    upsert, upsertMany, remove, get, listByType, listByWorkspace,
    loadAllToCache, applyBatch,
    insertNotification, listNotificationsFor, markNotificationRead, markNotificationReadIfOwner,
    markAllNotificationsReadFor, deleteAllNotificationsFor, trimNotificationsFor,
    insertReset, getReset, markResetUsed, cleanupResets,
    getKv, setKv,
    upsertMarketingSnapshots, listMarketingSnapshots,
    ping, close,
    _pool: pool // exposto pra inspeção em testes
  };
}

/* SSL padrão: se DATABASE_URL contém "sslmode=require" ou termina em provedor
   conhecido (Neon, Supabase, RDS, etc.), liga SSL sem verificar CA (comum em
   dev e em managed services onde o cert é confiável mas não está na store).
   Passe `ssl: false` explicitamente pra desligar em prod on-premise. */
function sslFromEnv() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return false;
  if (/sslmode=require|sslmode=verify/i.test(url)) return { rejectUnauthorized: false };
  if (/\.(neon\.tech|supabase\.co|rds\.amazonaws\.com|render\.com|railway\.app)/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

module.exports = { createStore, ENTITY_TYPES };
