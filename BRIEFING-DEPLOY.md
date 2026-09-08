# Briefing de deploy — o que configurar antes do próximo update

> **Escopo:** duas features novas que exigem **variáveis de ambiente** no
> Portainer antes de subirem em produção — **backup automático do Postgres**
> e **login com Discord (OAuth2)**. Nenhuma delas quebra o app se ficar
> configurada errada (o server degrada silenciosamente), mas nenhuma
> funciona sem as vars corretas.

---

## 1. Backup automático do Postgres

Sidecar `postgres-backup` no `docker-compose.yml` que roda `pg_dump` **todo
dia à 00:00** (America/Sao_Paulo), com rotação **7 diários + 4 semanais + 6
mensais**, gravando no volume `kastor_backups` fixado no nó manager.

### Variáveis a adicionar no Portainer

A imagem `prodrigestivill/postgres-backup-local` **não parseia a
`DATABASE_URL`** — precisa das partes separadas. Copie os mesmos valores
que você já tem dentro da `DATABASE_URL` da app.

| Variável | Obrigatória? | Exemplo | O que é |
|---|---|---|---|
| `DB_HOST` | **sim** | `db.exemplo.com` ou `postgres.internal` | Host do Postgres. Se for managed (Neon, Supabase, RDS…), pega no painel do provedor. |
| `DB_NAME` | **sim** | `kastor` | Nome do database. |
| `DB_USER` | **sim** | `kastor` | Usuário. |
| `DB_PASSWORD` | **sim** | `s3nh4-forte` | Senha. |
| `DB_EXTRA_OPTS` | opcional | `-Z9 --schema=public --blobs` | Flags extras passadas pro `pg_dump`. Default já cobre o caso comum (compressão máxima, só schema `public`, inclui blobs). Só mexa se sabe o que está fazendo. |

### Passo-a-passo no Portainer

1. **Stacks** → `kastor` → **Editor** (só pra confirmar que a versão do
   `docker-compose.yml` na branch main já tem o service `postgres-backup`).
2. **Environment variables** → adicionar as 4 vars acima
   (`DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) além das que já existem.
3. **Update the stack** → marcar **Re-pull image and redeploy**.
4. Aguardar ~30s. Em **Containers**, deve aparecer
   `kastor_postgres-backup.1.xxx` com status `running` e health `healthy`.

### Como validar que funcionou

Amanhã de manhã (após 00:00), no nó manager:

```bash
docker run --rm -v kastor_kastor_backups:/backups alpine ls -lh /backups/daily
```

Deve listar um `.sql.gz` com o timestamp do dump da noite. Se sim, tudo
certo. Se vier vazio, olhar os logs:

```bash
docker service logs kastor_postgres-backup --tail 200
```

### Restore (procedimento de emergência)

```bash
# 1. Lista dumps disponíveis
docker run --rm -v kastor_kastor_backups:/backups alpine ls /backups/daily

# 2. Restaura o mais recente (troque <arquivo>)
docker run --rm -v kastor_kastor_backups:/backups alpine \
  sh -c "gunzip -c /backups/daily/<arquivo>.sql.gz" | psql "$DATABASE_URL"
```

### O que este backup NÃO cobre

- ⚠️ **Backup local ≠ backup contra desastre.** Se a VPS pegar fogo, o
  volume `kastor_backups` vai junto. Depois plugar um `rclone` no cron do
  host empurrando o volume pra Google Drive/S3/outro servidor fecha o
  buraco. Não é urgente — é o próximo passo natural.
- **Uploads e `auth.enc`** — ficam no volume `kastor_data` e continuam
  precisando do backup manual descrito em `DEPLOY.md → "Uploads e
  auth.enc"`. Este sidecar cobre apenas o banco.

---

## 2. Login com Discord (OAuth2)

Botão "**Entrar com Discord**" na tela de login + botão "**Vincular com
Discord**" no perfil. Usuários que já têm `discordId` cadastrado (usam DMs
do bot hoje) conseguem entrar no dia 1 sem migração. Quem não tem, vincula
via botão no perfil.

**Modo dormente**: se as env vars não forem preenchidas, o app **esconde
os botões** e mantém apenas o input manual do snowflake no perfil (comportamento
atual). Zero risco de quebrar quem já usa hoje.

### Passo 1 — configurar OAuth no Discord Developer Portal

1. Abrir <https://discord.com/developers/applications> → escolher a **mesma
   application** que já hospeda o bot (não precisa criar app nova).
2. Menu lateral → **OAuth2** → **Redirects** → **Add Redirect** →
   colar exatamente:
   ```
   https://SEU-DOMINIO/api/auth/discord/callback
   ```
   Ex.: `https://rework.suamarca.com.br/api/auth/discord/callback`.
   **Cuidado:** tem que ser HTTPS, sem barra no final, exatamente igual ao
   valor da env var `DISCORD_OAUTH_REDIRECT_URI` (case-sensitive).
3. **Save Changes** no rodapé.
4. Ainda em **OAuth2**, na aba **Client information**, copiar:
   - **Client ID** (público, ok gravar em texto plano)
   - **Client Secret** — clicar em **Reset Secret** se nunca foi gerado
     antes. Copiar **imediatamente**; o Discord só mostra uma vez. Se
     perder, resetar de novo (invalida o anterior — cuidado se já estiver
     em uso em outro lugar).

### Passo 2 — variáveis a adicionar no Portainer

| Variável | Obrigatória? | Exemplo | O que é |
|---|---|---|---|
| `DISCORD_OAUTH_CLIENT_ID` | **sim** | `1234567890123456789` | Client ID copiado no passo 1.4. |
| `DISCORD_OAUTH_CLIENT_SECRET` | **sim** | `abc123...longo...def` | Client Secret copiado no passo 1.4. |
| `DISCORD_OAUTH_REDIRECT_URI` | **sim** | `https://rework.suamarca.com.br/api/auth/discord/callback` | URL exata do callback, HTTPS, sem barra final. Tem que bater com o que está no Discord Portal. |

### Passo 3 — deploy

1. Portainer → Stack `kastor` → **Environment variables** → adicionar as 3
   vars acima.
2. **Update the stack** → **Re-pull image and redeploy**.
3. Após redeploy, testar:
   - Abrir `https://SEU-DOMINIO/` em janela anônima. O botão "**Entrar com
     Discord**" deve aparecer abaixo do botão "Entrar", com o divisor
     "**OU**".
   - Clicar → deve ir pra tela de autorização do Discord → autorizar →
     voltar. Se sua conta já tem `discordId` cadastrado no reWork, **entra
     direto**. Se não, redireciona pro login com a mensagem "Nenhuma conta
     reWork está vinculada a esse Discord…" (esperado — vincule pelo
     perfil na próxima etapa).

### Fluxo pra usuários pré-existentes — 3 cenários

| Situação do usuário | O que ele vê / faz |
|---|---|
| **Já usa DMs do bot** (tem `discordId` cadastrado) | Vai na tela de login → "Entrar com Discord" → autoriza uma vez → dali em diante entra num clique. **Zero fricção.** |
| **Ainda não tem `discordId`** | Loga com usuário/senha normal → Perfil → aba **Integrações** → botão "**Vincular com Discord**" → autoriza no Discord → volta com toast "Discord vinculado com sucesso!". Dali em diante consegue entrar pelo botão da tela de login. |
| **Quer desvincular** | Perfil → Integrações → botão "**Desvincular**". Bloqueado se o user não tem senha (evita locked-out — precisa definir uma senha antes). |

### Considerações importantes

- **Segurança**: state CSRF de 16 bytes com TTL 10 min + rate-limit de 5
  starts/min por IP. Callback só emite sessão pra `discordId` que
  **já existe** em um user ativo — nunca cria conta fantasma.
- **Conflito**: se dois usuários tentarem vincular o mesmo `discordId`, o
  segundo vê "Esse Discord já está vinculado a outra conta reWork".
- **Trocar de conta Discord**: usuário troca de conta no Discord → o
  `discordId` muda → login para de funcionar. Fluxo é: entrar pela senha,
  perfil → "Trocar conta do Discord" (o botão muda de label quando já está
  vinculado).
- **Não conflita com o bot**: OAuth usa `scope=identify` (só o snowflake),
  e o bot continua rodando com `DISCORD_BOT_TOKEN` separado. As duas
  integrações são independentes.

### Rollback rápido

Se algo der ruim: apagar as 3 vars `DISCORD_OAUTH_*` no Portainer +
redeploy. Os botões somem, login com usuário/senha continua funcionando.

---

## Checklist de rollout (na ordem)

- [ ] **Backup**: adicionar `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
  no Portainer → redeploy → verificar container `postgres-backup` de pé.
- [ ] **Backup validação**: no dia seguinte, `ls /backups/daily` mostrando
  o primeiro dump.
- [ ] **Discord OAuth**: criar redirect URI no Discord Developer Portal.
- [ ] **Discord OAuth**: copiar Client ID + Reset Secret.
- [ ] **Discord OAuth**: adicionar `DISCORD_OAUTH_CLIENT_ID`,
  `DISCORD_OAUTH_CLIENT_SECRET`, `DISCORD_OAUTH_REDIRECT_URI` no Portainer
  → redeploy.
- [ ] **Discord OAuth validação**: em janela anônima, botão "Entrar com
  Discord" aparece na tela de login.
- [ ] **Discord OAuth validação**: entrar pelo Discord com um usuário que
  já tem `discordId` cadastrado — deve entrar direto.
- [ ] **Discord OAuth validação**: entrar pela senha com um usuário
  **sem** `discordId`, ir no perfil → Integrações → vincular via OAuth →
  toast de sucesso.
- [ ] **Discord OAuth validação (opcional)**: deslogar e reentrar pelo
  botão do Discord com esse usuário recém-vinculado.

---

## Resumo das vars novas (colar tudo de uma vez no Portainer)

```env
# ── Backup diário do Postgres (obrigatórias) ──────────────
DB_HOST=db.exemplo.com
DB_NAME=kastor
DB_USER=kastor
DB_PASSWORD=SUA-SENHA-DO-POSTGRES

# ── Login com Discord (obrigatórias pra habilitar) ────────
DISCORD_OAUTH_CLIENT_ID=1234567890123456789
DISCORD_OAUTH_CLIENT_SECRET=cole-o-secret-do-developer-portal
DISCORD_OAUTH_REDIRECT_URI=https://rework.suamarca.com.br/api/auth/discord/callback
```
