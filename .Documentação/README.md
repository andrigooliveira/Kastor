# Kastor — Gestão de Demandas de Marketing

Referência técnica pra desenvolvedores. Pra usuários finais, ver [`LEIA-ME.txt`](LEIA-ME.txt). Pra deploy em produção, ver [`../DEPLOY.md`](../DEPLOY.md).

Aplicação web multiusuário pra gerenciar demandas, fluxos, projetos, horas e integrações de equipes de marketing. SPA monolítico, sem build step, com persistência local (SQLite) e integração one-way com Google Calendar.

---

## Índice

1. [Quick start](#quick-start)
2. [Tech stack](#tech-stack)
3. [Estrutura do projeto](#estrutura-do-projeto)
4. [Arquitetura](#arquitetura)
5. [Modelo de dados](#modelo-de-dados)
6. [Referência da API](#referência-da-api)
7. [Autenticação e segurança](#autenticação-e-segurança)
8. [Persistência (SQLite)](#persistência-sqlite)
9. [Google Calendar (one-way)](#google-calendar-one-way)
10. [Uploads e anexos](#uploads-e-anexos)
11. [E-mail e Discord](#e-mail-e-discord)
12. [Variáveis de ambiente](#variáveis-de-ambiente)
13. [Real-time (SSE)](#real-time-sse)
14. [Testes](#testes)
15. [Deploy](#deploy)
16. [Convenções](#convenções)
17. [Roadmap / Limitações](#roadmap--limitações)

---

## Quick start

```bash
# Pré-requisito: Node.js 22.5+ (precisa de node:sqlite e process.loadEnvFile built-in)
node --version   # esperado: v22.5+

# Instalação
npm install

# Rodar
npm start
```

Abrir [http://localhost:3000](http://localhost:3000) — login inicial: **admin / admin123** (trocar no primeiro acesso).

Testes: `npm test` (smoke tests, ~1s, sem dep de teste).

---

## Tech stack

| Camada | Tecnologia | Notas |
|---|---|---|
| Runtime | Node.js 22.5+ | Usa `node:sqlite`, `process.loadEnvFile`, `node:test` — tudo built-in |
| HTTP | Express 4 | Único framework de servidor |
| DB | SQLite via `node:sqlite` | WAL + busy_timeout 5s, sem dep externa |
| Auth storage | scrypt + AES-256-GCM | Em `secure-store.js`, criptografa `data/auth.enc` |
| Real-time | Server-Sent Events (SSE) | Rota `/api/stream`, sem WebSocket |
| E-mail | Nodemailer (SMTP) | Opcional — reset de senha, notificações |
| Google Calendar | googleapis + google-auth-library | OAuth 2.0 + Calendar API v3, integração read-only |
| PDF | jsPDF (vendor local) | Reports mensais gerados programaticamente |
| Frontend | HTML + CSS + JS vanilla | Sem framework, sem build |
| Ícones | Lucide (vendor local) | ~400KB |

Dependências em `package.json`: 4 produção (express, nodemailer, googleapis, google-auth-library). Lucide é vendorizado (`public/vendor/`).

---

## Estrutura do projeto

```
.
├── server.js                   # Express app — rotas + lógica de negócio (~4000 linhas)
├── db-store.js                 # Persistência SQLite
├── secure-store.js             # Credenciais criptografadas (auth.enc)
├── google-cal.js               # Integração Google Calendar (OAuth + sync)
├── package.json                # 4 deps de produção, 0 de dev
├── Dockerfile                  # Node 22-alpine + healthcheck TCP
├── docker-compose.yml          # Stack pra Docker Swarm (image do GHCR, replicas: 1)
├── .github/workflows/deploy.yml # CI/CD → build + push pra GHCR
├── .env.example                # Template das variáveis de ambiente
├── DEPLOY.md                   # Guia de produção (Swarm + Portainer + NPM)
├── .dockerignore, .gitignore   # Exclusões
├── data/                       # RUNTIME — gitignored
│   ├── kastor.db               # SQLite (WAL habilitado)
│   ├── auth.enc                # Credenciais criptografadas (scrypt)
│   ├── secret.bin              # Chave-mestra (só se FLUXO_SECRET não setado)
│   └── uploads/                # Anexos + avatares
├── public/                     # Frontend estático
│   ├── index.html              # Uma HTML só, com múltiplos "pages"
│   ├── css/style.css           # Tudo num arquivo, dark + light themes
│   ├── js/app.js               # SPA vanilla — router, render, state
│   ├── Kastor_*.svg            # Logos por tema
│   └── vendor/
│       ├── lucide.min.js       # Ícones
│       └── jspdf.umd.min.js    # Gerador de PDF pros relatórios
├── tests/smoke.test.js         # Smoke tests via node:test
└── .Documentação/              # Você tá aqui
```

---

## Arquitetura

**SPA monolítico com backend REST + SSE**. Cliente é vanilla JS puro, roteamento próprio via `pushState`, estado global via variáveis de módulo (não Redux/Vuex/etc).

```
┌──────────────────────────────────────────────────────┐
│  BROWSER                                             │
│  ┌────────────────────────────────────────────────┐ │
│  │  index.html (SPA)                              │ │
│  │  ├─ router (pushState + popstate)              │ │
│  │  ├─ SSE listener (/api/stream)                 │ │
│  │  ├─ fetch → /api/* (JSON)                      │ │
│  │  └─ jsPDF (relatórios mensais client-side)    │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                          ↓ HTTP
┌──────────────────────────────────────────────────────┐
│  server.js (Express)                                 │
│  ├─ auth (cookie httpOnly, scrypt, sessão em memória)│
│  ├─ CSP + security headers                           │
│  ├─ endpoints /api/* (CRUD + agregações)             │
│  ├─ SSE /api/stream (broadcastChange)                │
│  ├─ webhooks (Discord/Slack)                         │
│  └─ Google Calendar (OAuth + sync incremental)       │
└──────────────────────────────────────────────────────┘
                          ↓
      ┌───────────────────┴──────────────────┐
      ↓                                      ↓
┌───────────────┐                    ┌───────────────┐
│  db-store.js  │                    │ secure-store.js│
│  SQLite       │                    │  auth.enc      │
│  (entities)   │                    │  (scrypt)      │
└───────────────┘                    └───────────────┘
```

**Persistência híbrida**: uma única tabela `entities` (type, id, workspace_id, data JSON) guarda quase tudo. Só notificações e password_resets têm tabela dedicada. Isso mantém o schema flexível durante evolução rápida sem migrations.

**Sem transpiler, sem build step**. O que você escreve em `server.js` roda direto no Node. O que você escreve em `public/js/app.js` roda direto no browser.

---

## Modelo de dados

Entidades (chave em `ENTITY_TYPES` de `db-store.js`):

| Tipo | Descrição | Workspace-scoped? |
|---|---|---|
| `workspaces` | Squads/times isolados | — (global) |
| `users` | Usuários com login | — (global, mas cada user tem `workspaces: []`) |
| `clients` | Clientes da agência | ✓ |
| `projects` | Projetos por cliente | ✓ (herda de client) |
| `flows` | Fluxos com etapas (drag-and-drop) | ✓ |
| `demands` | Demandas (o produto principal) | ✓ |
| `schedules` | Blocos de trabalho na agenda | ✓ |
| `roles` | Funções (Designer, Copywriter, etc.) | — (global) |
| `templates` | Templates de demanda | ✓ |
| `webhooks` | Discord/Slack destinations | ✓ |
| `clientTemplates` | Templates de setup de cliente inteiro | — |
| `recurrings` | Demandas recorrentes (mensais) | ✓ |
| `listas` | Listas recorrentes (templates aplicáveis a projetos) | ✓ |
| `googleEvents` | Eventos do Google Calendar sincronizados | por userId (não workspace) |

**Modelo de responsável de demanda** (cadeia de resolução, mesma no backend e frontend):

1. `demand.ownerId` direto
2. `demand.stageResponsibles[stageId]` (override por instância)
3. `stage.responsibleId` (padrão do fluxo)
4. `stage.responsibleRole` → `project.roleAssignments[role]`
5. Fallback: `client.roleAssignments[role]`

Regra de herança projeto ↔ cliente: `project.roleAssignments` é **copiado** de `client.roleAssignments` na criação e evolui **independentemente** depois. Alterar o cliente NÃO propaga.

---

## Referência da API

Toda rota exige autenticação (cookie httpOnly), exceto `/api/login`, `/api/reset/*` e `/api/google/callback`.

**Auth**
- `POST /api/login` → `{ user, workspaces }`
- `POST /api/logout`
- `GET /api/me` → user atual (com `googleConnected: boolean`)
- `PUT /api/me` → atualizar perfil
- `POST /api/me/email/test` → envia email de teste
- `POST /api/reset/request` → dispara email de reset
- `POST /api/reset/confirm` → nova senha via token

**Workspaces / Users** (admin) → `/api/workspaces`, `/api/users` CRUD padrão

**Clientes** → `/api/clients` CRUD + `/api/clients/from-template` (criar cliente + projetos + fluxos de um golpe)

**Projetos** → `/api/projects` CRUD + `/api/projects/:id/duplicate`

**Fluxos** → `/api/flows` CRUD (admin) + `/api/flows/:id/duplicate`

**Demandas** → `/api/demands` CRUD + rotas específicas:
- `POST /api/demands/:id/comments` — comentários com menção
- `POST /api/demands/:id/time` — apontamento de horas
- `PUT /api/demands/:id/stage` — avançar/voltar etapa
- `POST /api/demands/:id/attachments` — anexo (data URI ou link)

**Agenda** → `/api/schedules` CRUD

**Recorrentes** → `/api/recurrings` CRUD + `/api/recurrings/:id/generate` (materializa demandas do mês)

**Listas** → `/api/listas` CRUD

**Webhooks** (admin) → `/api/webhooks` CRUD + `/api/webhooks/:id/test`

**Google Calendar**
- `GET /api/google/status` → `{ configured, connected, account, calendars, lastSyncAt }`
- `GET /api/google/auth` → 302 redirect pro Google OAuth
- `GET /api/google/callback` → callback do OAuth (não chamada direta)
- `POST /api/google/disconnect`
- `PUT /api/google/calendars` → salvar seleção de calendários
- `POST /api/google/refresh-calendars` → re-fetch da lista do Google
- `POST /api/google/sync` → sync incremental (usa syncToken)
- `GET /api/google/events?userId=&from=&to=` → eventos armazenados

**Real-time** → `GET /api/stream` (SSE keep-alive, heartbeat a cada 25s)

**Uploads** → `POST /api/uploads` (multipart) + `GET /uploads/:file` (autenticado)

---

## Autenticação e segurança

**Sessões** vivem em memória (`Map<token, {userId, expiresAt}>`), TTL padrão 30 dias (`KASTOR_SESSION_DAYS`). Restart do servidor invalida todas — trade-off consciente pra não depender de Redis.

**Cookie** `kastor_session` — `HttpOnly`, `Secure` quando atrás de HTTPS (detectado via `req.secure` OU `X-Forwarded-Proto: https`), `SameSite=Lax`.

**Credenciais** ficam em `data/auth.enc`:
- Formato: JSON com `{ username: { hash, salt, iterations, ... } }`
- Criptografado com AES-256-GCM
- Chave derivada de `FLUXO_SECRET` (env) via scrypt; fallback pra `data/secret.bin` se env não setada

**CSP** (Content Security Policy):
- `default-src 'self'`
- `script-src 'self' 'unsafe-inline'` — inline necessário pros `onclick=` no HTML
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
- `img-src 'self' data: blob:`
- `connect-src 'self'`

**Trust proxy** ativado (`app.set('trust proxy', 1)`) — obrigatório atrás de NPM/Traefik pra `req.secure` funcionar.

**Rate limit** por IP em rotas sensíveis (`/api/login`, `/api/reset/*`) via middleware caseiro.

---

## Persistência (SQLite)

**Uma tabela genérica** cobre 90% dos dados:

```sql
CREATE TABLE entities (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  workspace_id TEXT,
  data TEXT NOT NULL,      -- JSON serializado
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX idx_entities_type_ws ON entities (type, workspace_id);
```

**Tabelas dedicadas**:
- `notifications` — escrita frequente, filtragem por user
- `password_resets` — TTL diferente, cleanup periódico
- `kv` — flags simples (versão de schema, etc.)

**PRAGMAs** aplicados no boot:
- `busy_timeout=5000` — tolerância a lock em disco lento (Docker Swarm em volume remoto)
- `journal_mode=WAL` — reads concorrentes com writes
- `synchronous=NORMAL` — fsync a cada checkpoint, não a cada write
- `foreign_keys=ON`
- `temp_store=MEMORY`

**Dirty tracking**: cada mutação chama `saveEntity(type, entity)` que marca como sujo e agenda um flush em 30ms (batching de writes concorrentes numa transação única).

**Graceful shutdown** (SIGTERM/SIGINT):
1. Fecha SSE clients
2. `server.close()` (para de aceitar novas conexões)
3. `flushDirty()` (grava buffer pendente)
4. `store.close()` (fecha SQLite limpo)

Timeout hardkill de 15s como paraquedas.

---

## Google Calendar (one-way)

**OAuth 2.0** flow completo, guardado em `google-cal.js`. Escopos: `calendar.readonly` + `userinfo.email` + `userinfo.profile`.

**CSRF**: state token gerado por usuário, TTL 10min, em memória (`Map<state, {userId}>`).

**Sync engine**:
- **Full sync** (primeira vez): `timeMin` = 6 meses atrás, `timeMax` = 12 meses à frente, `singleEvents=true` (expande recorrências)
- **Incremental**: usa `syncToken` do Google — só delta
- **Refresh de token**: automático via `google-auth-library`; callback persiste os novos tokens

**Storage** em entidade `googleEvents` com id composto `${googleEventId}@${userId}` — permite mesmo evento em múltiplos usuários.

**UI**:
- Painel no perfil → conectar/desconectar + seleção de calendários
- Eventos aparecem em azul na agenda (`.agenda-block--google`)
- Read-only (sem drag/resize), click → modal com título + link "Abrir no Google Calendar"
- Algoritmo N-lane pra layout lado a lado quando há overlap com blocos da plataforma

**Sem sincronização reversa** — a plataforma **nunca** grava no Google.

---

## Uploads e anexos

- Endpoint `POST /api/uploads` (multipart)
- Limite 12MB, MIME types específicos (imagens, PDF, docs)
- Nome sanitizado + prefixo aleatório (evita colisão + path traversal)
- Salvo em `data/uploads/`
- Servido via `GET /uploads/:file` com `requireAuth` — sem autenticação retorna 401
- Referenciado nas demandas via `attachments: [{ kind: 'file' | 'link', ... }]`

Data URIs também suportados (pra anexar imagem colada do clipboard) — o server salva como arquivo.

---

## E-mail e Discord

**SMTP** via nodemailer — opcional, sem config nada quebra. Eventos que disparam email:
- Reset de senha
- Atribuição como responsável (opt-in por usuário em `emailPrefs`)
- Menção em comentário (opt-in)

**Discord**: webhooks por workspace, formato Discord embeds ou raw JSON. Configurado em `/integrations`. Eventos:
- Demanda criada, movida, concluída
- Comentário postado, menção

Preferências por usuário (email) e por webhook (Discord) — cada canal escolhe quais eventos quer.

---

## Variáveis de ambiente

Ver [`.env.example`](../.env.example) pra template completo. Resumo:

| Var | Obrigatória? | Descrição |
|---|---|---|
| `PORT` | não | Default 3000 |
| `KASTOR_DATA_DIR` | não | Onde SQLite + uploads vivem. Default `./data`. Em Docker: `/app/data` |
| `PUBLIC_URL` | sim em prod | URL pública sem barra final. Usada em emails de reset |
| `FLUXO_SECRET` | recomendada | 64 hex chars (`openssl rand -hex 32`). Se ausente, gera em `data/secret.bin` |
| `KASTOR_SESSION_DAYS` | não | TTL do cookie (default 30) |
| `SMTP_*` | opcional | Ativa envio de email |
| `GOOGLE_CLIENT_ID` | opcional | OAuth do Google Cloud |
| `GOOGLE_CLIENT_SECRET` | opcional | idem |
| `GOOGLE_REDIRECT_URI` | opcional | `<PUBLIC_URL>/api/google/callback` |

**Loading**: server.js chama `process.loadEnvFile('.env')` no boot (built-in do Node 22.5+). Em produção via Docker, env vars são injetadas pelo Portainer/Swarm — `.env` não existe dentro do container e o `loadEnvFile` falha silenciosamente. Sem problema.

---

## Real-time (SSE)

`GET /api/stream` mantém conexão HTTP aberta. Cada mutação chama `broadcastChange(entity, op, ctx)` que dispara `data: {...}\n\n` pra todos os clientes com acesso ao workspace afetado (exceto o que originou a mudança — evita render duplicado).

**Frontend** (`onSseMessage` em `app.js`):
- Coalesce: várias mudanças em 250ms viram 1 refetch
- Refetch a entidade afetada + `renderCurrent()`
- Se detail modal aberto, refresca ele também

**Heartbeat** a cada 25s pra evitar timeout do proxy (Nginx default 60s).

**Reconnect** é nativo do `EventSource` do browser — cai e volta sozinho.

---

## Testes

```bash
npm test
```

Smoke tests em `tests/smoke.test.js` cobrem:
- Auth (login, sessão, logout)
- Persistência (SQLite writes + reads)
- Headers de segurança (CSP, X-Frame-Options, etc.)
- Upload (multipart + tipo válido)
- Rate limit em /login

Sem mocha/jest/vitest — usa `node:test` built-in. Zero dep de teste.

---

## Deploy

Ver [`../DEPLOY.md`](../DEPLOY.md) pra guia completo (Docker Swarm + Portainer + Nginx Proxy Manager).

**Resumo do fluxo**:
1. Push na main → GitHub Actions builda Dockerfile + publica no GHCR
2. Portainer Stack aponta pro compose no repo, usa imagem do GHCR
3. Docker Swarm sobe com `replicas: 1` (obrigatório enquanto for SQLite)
4. NPM faz proxy reverso HTTPS pra `kastor:3000`
5. Volume `kastor_data` persiste banco + uploads no nó manager

**Não escale horizontalmente** enquanto for SQLite. Ver seção "Escalar horizontalmente" no DEPLOY.md pro roadmap de migração.

---

## Convenções

- **Comentários** só quando o "por que" não é óbvio no código. Não explique o "o que" — o nome da função já diz.
- **Toast padrão pt-BR** em todo lugar (`toast('Salvo!')` ou `toast('Erro: X', 'error')`).
- **Cache-buster**: `?v=YYYYMMDD[letra]` no `<script src>` e `<link href>` do `index.html`. Incrementa a cada mudança de JS/CSS.
- **IDs de rota**: URLs em inglês (`/clients`, `/demands`), UI em pt-BR. Convenção pra manter URLs curtas e SEO-friendly.
- **Naming**: snake_case pra CSS vars, camelCase pra JS, kebab-case pros classes CSS.
- **Sem lint tooling**: consistência via revisão manual. Pra automatizar, `npx prettier` funciona sem config.

---

## Roadmap / Limitações

**Limitações atuais**:
- `replicas: 1` no Swarm (SQLite) — sem HA horizontal
- Sessões em memória — restart do servidor desloga todo mundo
- Uploads no filesystem local — não sobrevivem a mover pra outro nó
- Google Calendar one-way — não escrevemos de volta no Google

**Próximos passos naturais** (quando escalar):
- Migrar SQLite → Postgres → suporta multi-writer
- Sessões → Redis
- Uploads → S3/MinIO
- Adicionar rate limiting mais robusto (agora é caseiro)
- Testes de integração além dos smoke
