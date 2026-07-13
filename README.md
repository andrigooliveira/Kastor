# Kastor

> Gestão de demandas de marketing — multiusuário, persistente, com integração Google Calendar.

Aplicação web pra organizar fluxos de criação, prazos, equipe, apontamento de horas, relatórios e entregas de times de marketing. Stack enxuta: **Node.js + Express + SQLite + vanilla JS**. Zero build step, instalação em 2 comandos.

## Rodar localmente

Pré-requisito: **Node.js 22.5+** (usa `node:sqlite` e `process.loadEnvFile` built-in).

```bash
npm install
npm start
```

Abrir [http://localhost:3000](http://localhost:3000) — login inicial: **admin / admin123** (troque no primeiro acesso).

## Testes

```bash
npm test
```

Smoke tests via `node:test` built-in. Sem dep externa.

## Documentação

- **[`DEPLOY.md`](DEPLOY.md)** — guia de produção passo a passo (Docker Swarm + Portainer + Nginx Proxy Manager + GHCR)
- **[`.Documentação/README.md`](.Documentação/README.md)** — referência técnica completa (arquitetura, API, modelo de dados)
- **[`.Documentação/LEIA-ME.txt`](.Documentação/LEIA-ME.txt)** — guia pra usuário final (PT-BR)
- **[`.env.example`](.env.example)** — template de variáveis de ambiente

## Estrutura

```
.
├── server.js                    # Express app — rotas + lógica de negócio
├── db-store.js                  # Persistência SQLite (WAL + busy_timeout)
├── secure-store.js              # Credenciais criptografadas (scrypt + AES-256-GCM)
├── google-cal.js                # Integração Google Calendar (OAuth + sync)
├── Dockerfile                   # Node 22-alpine + healthcheck TCP
├── docker-compose.yml           # Stack Docker Swarm (image do GHCR, replicas: 1)
├── .github/workflows/deploy.yml # CI/CD → build + push pra GHCR
├── data/                        # Runtime (gitignored — banco + uploads + secrets)
├── public/                      # Frontend (HTML/CSS/JS vanilla)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
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

Variáveis essenciais (todas as opcionais em `.env.example`):

- `FLUXO_SECRET` — chave hex 64 chars pra criptografia (`openssl rand -hex 32`)
- `PUBLIC_URL` — URL pública HTTPS
- `KASTOR_DATA_DIR` — em Docker, `/app/data`

⚠️ **Persistência**: banco + uploads vivem em `KASTOR_DATA_DIR`. Sem volume persistente, os dados somem a cada redeploy.

## Licença

Privado — sem licença pública declarada.
