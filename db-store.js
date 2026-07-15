/* ───────────────────────────────────────────────────────────────
   KASTOR — Camada de persistência PostgreSQL (via `pg`)

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
  'demands', 'roles', 'templates', 'webhooks', 'schedules', 'clientTemplates',
  'recurrings', 'listas', 'googleEvents'
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
    if (type === 'workspaces' || type === 'roles' || type === 'users') return null;
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
  async function markAllNotificationsReadFor(userId) {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [userId]);
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

  async function close() { await pool.end(); }

  return {
    init,
    transaction,
    upsert, upsertMany, remove, get, listByType, listByWorkspace,
    loadAllToCache, applyBatch,
    insertNotification, listNotificationsFor, markNotificationRead,
    markAllNotificationsReadFor, trimNotificationsFor,
    insertReset, getReset, markResetUsed, cleanupResets,
    getKv, setKv,
    close,
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
