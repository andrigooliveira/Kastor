# ────────────────────────────────────────────────────────────────
# Kastor — Dockerfile de produção
#
# Multi-stage não faz sentido aqui: não temos passo de build (JS/CSS
# são servidos direto de public/). Uma stage single-purpose enxuta.
#
# Base: Node 18+ (banco é PostgreSQL externo — driver `pg`).
# Uso 22-alpine pra imagem pequena (~180MB) e consistência entre ambientes.
# ────────────────────────────────────────────────────────────────
FROM node:22-alpine

# Alpine não vem com o /home/node populado; roda como root simplifica volumes
# de dados (uploads/auth.enc mount) sem se preocupar com uid/gid.
WORKDIR /app

# Copia manifests primeiro pra Docker cachear a camada de dependências —
# só reinstala quando package*.json muda de verdade.
COPY package*.json ./

# --omit=dev pula devDependencies (não temos, mas vale o hábito).
# --no-audit e --no-fund reduzem noise no log de build.
RUN npm install --omit=dev --no-audit --no-fund

# Copia o resto do projeto. .dockerignore filtra o que NÃO deve entrar
# (node_modules local, .env, data/, .git, etc — ver .dockerignore).
COPY . .

# Diretório de dados persistidos. Docker Compose monta um volume nomeado
# aqui pra uploads dos usuários e auth.enc sobreviverem a `docker compose down`.
# O banco de dados fica em Postgres EXTERNO (ver DATABASE_URL).
RUN mkdir -p /app/data && chmod 755 /app/data

# Porta interna do container. O host mapeia pra outra porta via compose
# (default 8080 pra não bater com Chatwoot). Não é a porta pública!
EXPOSE 3000

# Healthcheck simples: TCP na porta 3000. HTTP GET / falha (redireciona sem
# auth), então TCP é mais barato e serve pra Portainer marcar unhealthy quando
# o processo morre.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('net').createConnection(3000).on('connect', () => process.exit(0)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
