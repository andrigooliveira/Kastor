# Kastor — Deploy em Docker Swarm (via Portainer)

Guia completo pra subir o Kastor num cluster Docker Swarm gerenciado pelo Portainer, com CI/CD automático pelo GitHub Actions e proxy reverso pra HTTPS.

**Arquitetura resumida:**

```
┌─────────────────────────────────────────────────────────────┐
│   GitHub (repo privado)                                     │
│   └─ push na main → GitHub Actions → build Dockerfile       │
│                                     ↓ publica imagem        │
└──────────────────────────────────────┼──────────────────────┘
                                       ↓
                              ghcr.io/<owner>/kastor:latest
                                       ↓
┌──────────────────────────────────────┼──────────────────────┐
│   VPS + Docker Swarm + Portainer     ↓                      │
│   ┌────────────────────────────────────────────────────┐   │
│   │  Nginx Proxy Manager (443)  ─→  kastor:3000        │   │
│   │  (HTTPS + Let's Encrypt)                           │   │
│   └────────────────────────────────────────────────────┘   │
│   Serviço "kastor" (replicas=1, node manager)              │
│   Volume: kastor_data (uploads + auth.enc)                  │
│   Banco: PostgreSQL externo (managed ou container)          │
└─────────────────────────────────────────────────────────────┘
```

---

## Pré-requisitos

- VPS com **Docker Swarm ativo** (`docker swarm init` já rodado) e **Portainer** apontando pra ele.
- **Nginx Proxy Manager** (ou Traefik) já rodando no cluster.
- **PostgreSQL** acessível — pode ser managed (Neon, Supabase, RDS, Railway, Render) ou um container próprio na mesma VPS. Basta ter a `DATABASE_URL`.
- Domínio/subdomínio apontando pra IP da VPS (ex.: `kastor.seudominio.com.br`).
- Conta GitHub (o repo pode ser privado).

---

## Passo 1 — Preparar o repositório

1. Cria um repo privado no GitHub chamado `kastor` (ou nome à sua escolha).
2. No projeto local:
   ```bash
   git init
   git add -A
   git commit -m "Setup inicial"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/kastor.git
   git push -u origin main
   ```
3. **Verifica no GitHub**: `.env` e `data/` **NÃO** aparecem no repo (o `.gitignore` bloqueia — confere na aba code do GitHub que essas pastas/arquivos estão ausentes).

---

## Passo 2 — Deixar o pipeline rodar

Assim que você deu push, o GitHub Actions dispara automaticamente:

1. Vai em `github.com/SEU-USUARIO/kastor/actions`
2. O workflow **"Build and Push to GHCR"** deve estar rodando (ou já concluído)
3. Aguarde ficar verde (~2-3 min no primeiro run)
4. Em `github.com/SEU-USUARIO?tab=packages` deve aparecer o pacote `kastor` (imagem publicada)

**Torna o pacote público OU dá acesso ao Swarm:**

- **Opção A (simples)**: pacote público — na página do pacote → **Package settings** → **Change visibility** → **Public**. Assim o Swarm baixa sem autenticação.
- **Opção B (privado)**: precisa criar um Personal Access Token (Settings → Developer settings → PAT → Fine-grained com escopo `read:packages`) e configurar `docker login ghcr.io` no nó Swarm. Mais seguro, mais chato.

Recomendo **Opção A** enquanto o app não é sensível — mesmo público, ninguém sabe da URL sem seu domínio.

---

## Passo 3 — Google Cloud (se for usar Google Calendar)

O redirect URI precisa incluir seu domínio de produção:

1. [console.cloud.google.com](https://console.cloud.google.com) → seu projeto → APIs & Services → Credentials
2. Abre o OAuth Client ID
3. Em **Authorized redirect URIs**, adiciona (não remove os anteriores):
   ```
   https://kastor.seudominio.com.br/api/google/callback
   ```
4. Salva.

Em modo **Testing**? Adiciona todos os emails da equipe em **Test users** no OAuth consent screen.

---

## Passo 4 — Portainer: subir a Stack

1. Portainer → **Stacks** → **Add stack**
2. **Name**: `kastor`
3. **Build method**: **Repository**
4. **Repository URL**: `https://github.com/SEU-USUARIO/kastor.git`
5. **Repository reference**: `refs/heads/main`
6. Se repo privado: Authentication com username + PAT
7. **Compose path**: `docker-compose.yml`
8. **Environment variables** (Advanced mode facilita colar em bloco):
   ```env
   HOST_PORT=8080
   PUBLIC_URL=https://kastor.seudominio.com.br
   GITHUB_REPOSITORY_OWNER=seu-usuario-github

   # OBRIGATÓRIO — connection string do Postgres.
   # Managed (Neon/Supabase/RDS/Railway/Render): geralmente exige ?sslmode=require
   DATABASE_URL=postgres://kastor:s3nh4@db.exemplo.com:5432/kastor?sslmode=require

   # Gera com: openssl rand -hex 32
   FLUXO_SECRET=cole-aqui-64-chars-hex

   KASTOR_SESSION_DAYS=30

   # Google Calendar (opcional)
   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxx
   GOOGLE_REDIRECT_URI=https://kastor.seudominio.com.br/api/google/callback

   # SMTP (opcional)
   SMTP_HOST=smtp.exemplo.com
   SMTP_PORT=587
   SMTP_USER=noreply@seudominio.com.br
   SMTP_PASS=senha-do-smtp
   SMTP_SECURE=false
   SMTP_FROM=Kastor <noreply@seudominio.com.br>
   ```

   > ⚠️ `GITHUB_REPOSITORY_OWNER` deve ser exatamente o dono do repo no GitHub (usuário ou organização). É o que preenche `ghcr.io/${GITHUB_REPOSITORY_OWNER}/kastor:latest` no compose. **Tudo em lowercase** — o GHCR não aceita maiúsculas.

9. **Deploy the stack**.
10. Aguarda ~30s. Em **Containers**, o `kastor.1.xxx` deve aparecer com status `running` e health `healthy`.

---

## Passo 5 — Nginx Proxy Manager

1. Abre o NPM (normalmente porta 81 da VPS)
2. **Hosts → Proxy Hosts → Add Proxy Host**
3. **Domain Names**: `kastor.seudominio.com.br`
4. **Scheme**: `http`
5. **Forward Hostname / IP**: `kastor` (nome do serviço no Swarm) OU o IP interno da VPS
6. **Forward Port**: `3000` (se usar nome) ou `8080` (se usar IP)
7. Marca **Block Common Exploits** e **Websockets Support**
8. Aba **SSL** → **Request a new SSL certificate** com Let's Encrypt → marca **Force SSL**
9. Save

**Networks compartilhadas**: se NPM está em outra Stack, o hostname `kastor` só resolve se ambos estiverem numa network `attachable`. Alternativa: usar IP interno da VPS + porta.

---

## Passo 6 — Restaurar dados (se está migrando de outro ambiente)

Com o serviço rodando:

1. Empurra o backup pra VPS:
   ```bash
   scp -r ~/kastor-backup-XXXX usuario@vps:/tmp/
   ```
2. Para o serviço (Swarm exige stop pra escrever no volume):
   ```bash
   docker service scale kastor_kastor=0
   ```
3. Localiza o volume:
   ```bash
   docker volume inspect kastor_kastor_data
   # anota o "Mountpoint"
   ```
4. Copia os dados:
   ```bash
   sudo cp -r /tmp/kastor-backup-XXXX/. /var/lib/docker/volumes/kastor_kastor_data/_data/
   ```
5. Sobe de novo:
   ```bash
   docker service scale kastor_kastor=1
   ```

---

## Passo 7 — Verificação

1. Abre `https://kastor.seudominio.com.br` — tela de login.
2. Loga como admin.
3. Confere:
   - Dashboard carrega dados
   - Agenda funciona
   - `/profile` → conectar Google Calendar → redirecionamento OK

---

## Fluxo de atualização (deploy contínuo)

1. `git push` na main
2. GitHub Actions builda + publica nova imagem em ~1-2 min
3. Portainer → Stack **kastor** → **Update the stack** → marca **Re-pull image and redeploy**
4. Swarm faz update com `start-first` (sobe o novo antes de derrubar o velho — Postgres externo aguenta ambos conectados)
5. Downtime próximo de zero (novo container passa healthcheck antes do velho cair)

Pra **rollback** rápido:
- Portainer → Stack → clica no serviço `kastor_kastor` → **Rollback the service** (Swarm mantém a imagem anterior automaticamente)

---

## Backup automático

Duas coisas pra fazer backup: o **banco** (crítico) e o **volume de uploads**.

### Banco de dados (Postgres) — prioridade #1

Se seu Postgres é managed (Neon, Supabase, RDS, Railway, Render), quase todos já fazem backup automático. **Confirme** no painel do provedor e teste um restore antes de confiar.

Se é self-hosted, cron no nó manager:

```bash
# Diário às 3AM — mantém 30 dias
0 3 * * * pg_dump "$DATABASE_URL" | gzip > /home/backup/kastor-db-$(date +\%F).sql.gz && \
  find /home/backup -name "kastor-db-*.sql.gz" -mtime +30 -delete
```

Restore:
```bash
gunzip < kastor-db-YYYY-MM-DD.sql.gz | psql "$DATABASE_URL"
```

### Uploads e auth.enc (volume Docker)

```bash
# Diário às 3:15AM — mantém 30 dias
15 3 * * * docker run --rm \
  -v kastor_kastor_data:/data \
  -v /home/backup/kastor:/backup \
  alpine tar czf /backup/kastor-uploads-$(date +\%F).tar.gz -C /data . && \
  find /home/backup/kastor -name "kastor-uploads-*.tar.gz" -mtime +30 -delete
```

Depois copia `/home/backup/kastor/` pra fora da VPS (Google Drive, S3, rsync pra outro servidor).

---

## Troubleshooting

| Sintoma | Causa | Fix |
|---|---|---|
| Container reinicia em loop | `FLUXO_SECRET` inválido | Confere que é hex de 64 chars sem espaços |
| Login falha logo após criar | Cookie `secure` bloqueado | Confere que proxy envia `X-Forwarded-Proto: https` (já cuidado por `trust proxy` no server) |
| Google Calendar não conecta | Redirect URI mismatch | Compara literal entre Portainer e Google Cloud (case-sensitive, sem barra final) |
| Sync do Google não pega eventos | syncToken expirou (30d inativo) | Clica "Sincronizar agora" no perfil — fallback pra full sync roda automático |
| Reset de senha por email não chega | SMTP não configurado | Testa em `/profile` → "Enviar teste" |
| Imagem não faz pull no Swarm | Pacote GHCR privado | Torna público (Package settings → Visibility → Public) OU `docker login ghcr.io` no nó manager |
| `Error: docker.errors: manifest not found` | `GITHUB_REPOSITORY_OWNER` errado ou pacote não existe ainda | Confere que o workflow rodou verde e que o owner é lowercase |
| Serviço fica em `pending` no Swarm | Nenhum nó atende à `placement.constraints: node.role == manager` | Confirma `docker node ls` — precisa de um manager. Em cluster single-node, o próprio nó é manager. |
| `ECONNREFUSED` no boot | `DATABASE_URL` errada ou Postgres inacessível da VPS | Testa `psql "$DATABASE_URL"` no nó manager. Se for managed, libera IP da VPS na allowlist do provedor. |
| `password authentication failed` | Credenciais na `DATABASE_URL` erradas | Confere user/senha no provedor. Copia a URL de novo (às vezes tem caractere especial que precisa de URL-encode). |
| `no pg_hba.conf entry for host` | Postgres self-hosted não aceita a origem | Adiciona regra em `pg_hba.conf` autorizando o IP/subnet da VPS |
| `sslmode not supported` | Provedor exige SSL mas a URL não pediu | Adiciona `?sslmode=require` no final da `DATABASE_URL` |

---

## Escalar horizontalmente (roadmap futuro)

Com Postgres externo o app é stateless quanto ao banco — várias réplicas podem escrever ao mesmo tempo sem conflito. Os limites que ainda amarram a `replicas: 1`:

1. **Uploads no volume local** — arquivos vivem no filesystem do nó fixado. Réplicas em outros nós não veem. Fix: mover pra S3/MinIO ou pra coluna `bytea` no próprio Postgres.
2. **Sessões em memória** — cada réplica tem seu Map de sessões. Login numa réplica não é reconhecido em outra. Fix: mover pra Redis.

Depois desses dois, é subir `replicas: 2+` no compose e configurar o NPM/Traefik pra balancear entre elas.

Esse trabalho é moderado (dias, não semanas). Sugestão: só encarar quando o app tiver 100+ usuários simultâneos ou SLA de disponibilidade formal.
