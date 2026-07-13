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
│   Volume: kastor_data (SQLite + uploads)                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Pré-requisitos

- VPS com **Docker Swarm ativo** (`docker swarm init` já rodado) e **Portainer** apontando pra ele.
- **Nginx Proxy Manager** (ou Traefik) já rodando no cluster.
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
4. Swarm faz update com `stop-first` (para o antigo antes de subir o novo — SQLite exige um writer por vez)
5. ~15s de downtime

Pra **rollback** rápido:
- Portainer → Stack → clica no serviço `kastor_kastor` → **Rollback the service** (Swarm mantém a imagem anterior automaticamente)

---

## Backup automático

Cron no nó manager:

```bash
# Diário às 3AM — mantém 30 dias
0 3 * * * docker run --rm \
  -v kastor_kastor_data:/data \
  -v /home/backup/kastor:/backup \
  alpine tar czf /backup/kastor-$(date +\%F).tar.gz -C /data . && \
  find /home/backup/kastor -name "kastor-*.tar.gz" -mtime +30 -delete
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
| `Database is locked` esporádico | Concorrência de writes num filesystem lento | `busy_timeout=5s` já cobre; se acontecer, é sinal pra migrar pra Postgres |

---

## Escalar horizontalmente (roadmap futuro)

Enquanto o banco for **SQLite**, `replicas: 1` é obrigatório — não tem como ter dois writers no mesmo arquivo. Se um dia precisar de HA (múltiplas réplicas atrás de load balancer):

1. Migrar `db-store.js` de SQLite pra Postgres/MySQL
2. Adicionar serviço de banco no compose (ou usar RDS/Cloud SQL)
3. Uploads: migrar `/app/data/uploads` pra S3 ou MinIO (volume local não é compartilhado entre réplicas em nós diferentes)
4. Sessões: migrar `secure-store.js` pra Redis se o mesmo problema aparecer

Esse trabalho é substancial (semanas, não dias). Sugestão: só encarar quando o app tiver 100+ usuários simultâneos ou SLA de disponibilidade formal.
