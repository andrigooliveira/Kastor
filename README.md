# Kastor

> Gestão de demandas de marketing — multiusuário, persistente, com integração Google Calendar.

Aplicação web pra organizar fluxos de criação, prazos, equipe, apontamento de horas, relatórios e entregas de times de marketing. Stack enxuta: **Node.js + Express + PostgreSQL + vanilla JS**. Zero build step, instalação em 2 comandos.

## Rodar localmente

Pré-requisito: **Node.js 18+** e um **PostgreSQL** acessível (local, Docker ou managed).

```bash
export DATABASE_URL="postgres://usuario:senha@localhost:5432/kastor"
npm install
npm start
```

Abrir [http://localhost:3000](http://localhost:3000) — login inicial: **admin / admin123** (troque no primeiro acesso).

## Testes

```bash
export TEST_DATABASE_URL="postgres://usuario:senha@localhost:5432/kastor_test"
npm test
```

Smoke tests via `node:test` built-in. Sem `TEST_DATABASE_URL`, os testes são pulados com aviso.

## Documentação

- **[`DEPLOY.md`](DEPLOY.md)** — guia de produção passo a passo (Docker Swarm + Portainer + Nginx Proxy Manager + GHCR)
- **[`.Documentação/README.md`](.Documentação/README.md)** — referência técnica completa (arquitetura, API, modelo de dados)
- **[`.Documentação/LEIA-ME.txt`](.Documentação/LEIA-ME.txt)** — guia pra usuário final (PT-BR)
- **[`.env.example`](.env.example)** — template de variáveis de ambiente

## Estrutura

```
.
├── server.js                    # Express app — rotas + lógica de negócio
├── db-store.js                  # Persistência PostgreSQL (via `pg`, JSONB)
├── secure-store.js              # Credenciais criptografadas (scrypt + AES-256-GCM)
├── google-cal.js                # Integração Google Calendar (OAuth + sync)
├── Dockerfile                   # Node 22-alpine + healthcheck TCP
├── docker-compose.yml           # Stack Docker Swarm (image do GHCR)
├── .github/workflows/deploy.yml # CI/CD → build + push pra GHCR
├── data/                        # Runtime (gitignored — uploads + auth.enc)
├── public/                      # Frontend (HTML/CSS/JS vanilla)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   ├── docs/                    # Manual do usuário (HTML)
│   └── vendor/                  # jsPDF + Lucide
├── tests/smoke.test.js
└── .Documentação/               # Docs completas
```

## Features principais

- **Demandas** com fluxos customizáveis, drag-and-drop de etapas, apontamento de horas, comentários com menção
- **Clientes e projetos** com metadata (drive, ativos, descrição), pessoas padrão por função
- **Dashboard** com KPIs, radar de projetos, próximos 7 dias, top responsáveis, throughput 12 semanas
- **Agenda semanal** com drag-and-drop de blocos + eventos do Google Calendar lado a lado (read-only)
- **Relatórios mensais** de cliente/projeto exportáveis pra PDF (jsPDF client-side)
- **Recorrentes e listas** — templates aplicáveis a projetos com snapshot isolado
- **Command palette** (⌘K) buscando clientes/demandas/projetos/listas/usuários
- **Real-time** via SSE — mudanças de outros usuários refletem sem F5
- **Notificações** por email (SMTP) e Discord (webhooks)

## Deploy

Roda em Docker Swarm gerenciado por Portainer com CI/CD via GitHub Actions publicando imagem no GHCR. Ver **[`DEPLOY.md`](DEPLOY.md)** pra guia completo.

Variáveis essenciais (todas em `.env.example`):

- `DATABASE_URL` — connection string do Postgres (formato `postgres://user:pass@host:port/db`)
- `FLUXO_SECRET` — chave hex 64 chars pra criptografia (`openssl rand -hex 32`)
- `PUBLIC_URL` — URL pública HTTPS
- `KASTOR_DATA_DIR` — em Docker, `/app/data` (uploads + auth.enc)

⚠️ **Persistência**:
- **Banco de dados** vive no PostgreSQL externo — backup é responsabilidade do provedor ou via `pg_dump`.
- **Uploads e `auth.enc`** vivem em `KASTOR_DATA_DIR`. Sem volume persistente, uploads somem a cada redeploy.

## Licença

Privado — sem licença pública declarada.
