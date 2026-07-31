# Escalando o reWork horizontalmente (HA / múltiplas instâncias)

> **TL;DR** — Hoje o reWork roda em **1 instância** (`docker-compose.yml`: `replicas: 1`),
> e isso é **adequado** pra escala de time. Só invista neste guia quando tiver um
> motivo concreto: uptime crítico, muitos usuários simultâneos, ou rolling deploy
> sem janela de queda.
>
> **A boa notícia:** como já usamos **Postgres**, dá pra escalar **sem adicionar
> Redis** — usando `LISTEN/NOTIFY` do próprio Postgres pra sincronizar cache e o SSE
> entre as instâncias.

---

## 1. Por que hoje é single-instance

O código foi desenhado com **estado em processo**. Com 2+ instâncias, esses pontos
quebram (cada instância tem sua própria cópia):

| Estado em processo | Onde | O que quebra com N instâncias |
|---|---|---|
| **`db` em memória** (demands, projects, flows…) | `server.js` — objeto `db`, lido/escrito por todo handler | Write na instância A **não aparece** na B até um reload. **Bloqueador central.** |
| **Fan-out do SSE** | `server.js` — `sseClients` (Map) + `broadcastChange()` | Uma mudança só chega aos clients conectados **àquela** instância. Tempo real fura. |
| **Rate-limit** | `server.js` — `_loginAttempts`, `_pwResetAttempts`, buckets por-usuário (`rateLimitBulk/Upload/Report`) | Limite vira "por instância" → efetivamente N× mais frouxo. |
| **Sessões / auth** | `secure-store.js` — `auth.enc` em disco local | Cada instância tem seu arquivo. Login em A pode não valer em B; hashes/tokens dessincronizam. |
| **Uploads** | `server.js` — `UPLOADS_DIR` (`data/uploads/`) em disco local | Anexo enviado via A não é servível pela B. (Já anotado no `docker-compose.yml`.) |

O caminho de persistência já é forte e ajuda muito: **toda mutação** passa por
`saveEntity()/removeEntity()` → `markDirty()` → `flushDirty()` (debounce 30ms) →
`UPSERT` na tabela `entities` (JSONB) do Postgres (`db-store.js`). Ou seja: **o
Postgres já é a fonte de verdade durável** — o `db` em memória é só um cache de
leitura rápida. Isso é o que torna o plano abaixo viável.

---

## 2. Arquitetura alvo (Postgres LISTEN/NOTIFY, sem Redis)

```
        ┌─────────────┐        ┌─────────────┐
 client │ Instância A │        │ Instância B │ client
   ●────┤  db(cache)  │        │  db(cache)  ├────●
   ●────┤  SSE local  │        │  SSE local  ├────●
        └──────┬──────┘        └──────┬──────┘
               │  UPSERT + NOTIFY     │ LISTEN
               ▼                      ▼
        ┌──────────────────────────────────┐
        │  PostgreSQL  (entities + NOTIFY)  │  ← fonte de verdade
        └──────────────────────────────────┘
```

Fluxo de uma escrita:
1. Instância A recebe o request, aplica no `db` local e persiste (`flushDirty`).
2. A emite `NOTIFY kastor_changes, '{type,id,op,workspaceId,byUserId}'`.
3. **Todas** as instâncias (incl. A) escutam via `LISTEN kastor_changes`.
4. Ao receber a notificação, cada instância:
   - Recarrega **aquele** registro do Postgres pro seu `db` em memória (ou remove, se `op=delete`).
   - Faz `broadcastChange()` pros seus clients SSE locais (pulando o originador via `byUserId`, como já é feito hoje).

Resultado: cache consistente entre instâncias + SSE global, reaproveitando o
`broadcastChange` que já existe.

---

## 3. Passo a passo (ordem de risco crescente)

### Fase 0 — Storage compartilhado (pré-requisito)
Antes de subir `replicas > 1`:
- **Uploads:** mover `data/uploads/` pra storage compartilhado — **S3/MinIO** (recomendado)
  ou NFS. `saveUploadFromDataUri()` e a rota `express.static('/uploads')` passam a
  ler/gravar do bucket. Alternativa mais simples de curto prazo: um único volume NFS
  montado em todas as instâncias.
- **`auth.enc`:** mover as credenciais/tokens do arquivo pra uma **tabela no Postgres**
  (`secure-store.js` vira um store Postgres em vez de arquivo). É pequeno e isolado —
  bom primeiro item real de código. Mantém o AES-GCM, só troca o meio de persistência.

### Fase 1 — Rate-limit compartilhado *(baixo risco)*
- Opção simples: **manter em memória e aceitar o limite aproximado** (com N instâncias
  atrás de um LB round-robin, cada uma vê ~1/N do tráfego — o limite fica N× mais
  frouxo, mas ainda barra abuso grosseiro). Aceitável pra começar.
- Opção correta: mover os buckets pra Postgres (tabela `rate_limits` com `INSERT … ON
  CONFLICT` + janela por timestamp) ou Redis, se já tiver. O `makeRateLimit()` já foi
  generalizado (aceita `keyFn`/`windowMs`) — só trocar o `Map` por um backend.

### Fase 2 — Sessões *(baixo risco)*
- Depende da Fase 0 (auth no Postgres). Uma vez que tokens/credenciais estão no
  Postgres, `requireAuth` (`userIdForToken`) já funciona igual em qualquer instância.

### Fase 3 — O núcleo: cache-sync + SSE via LISTEN/NOTIFY *(maior esforço)*
1. **Canal de notificação.** No `flushDirty()` (`db-store.js`/`server.js`), após o
   `COMMIT`, emitir `NOTIFY kastor_changes, <json com {type,id,op,workspaceId,byUserId}>`
   pra cada item do batch. (Payload do NOTIFY tem limite de ~8000 bytes — mande só os
   metadados, nunca a entidade inteira.)
2. **Listener por instância.** No boot, abrir **uma conexão dedicada** (fora do pool)
   e `LISTEN kastor_changes`. No handler `notification`:
   - `op === 'remove'/'delete'` → tirar do `db[type]` local.
   - `op === 'upsert'/'update'` → `store.get(type, id)` e substituir/inserir no `db[type]`.
   - Chamar `broadcastChange(type, op, {id, workspaceId, byUserId})` pros clients locais.
3. **Evitar eco redundante.** A própria instância que escreveu também recebe o NOTIFY;
   como o `db` dela já está atualizado, o re-`get` é idempotente. O `broadcastChange`
   já pula o originador via `byUserId` — mantém esse comportamento.
4. **Reconexão do listener.** Se a conexão de LISTEN cair, reconectar **e** fazer um
   `loadAllToCache()` (full reload) pra não perder invalidções ocorridas offline.

### Fase 4 — Flip `replicas > 1` + testes
- `docker-compose.yml`: subir `replicas` pra 2, tirar a `placement.constraints` que
  fixa no nó do volume (agora o storage é compartilhado).
- Rolling deploy: `order: start-first` já está configurado.

---

## 4. Checklist de teste multi-instância

Suba 2 instâncias atrás de um LB (round-robin) e valide:

- [ ] Criar uma demanda na **A** → aparece na **B** em < 1s (via SSE, sem reload).
- [ ] Editar etapa na **A** → o card muda em tempo real num client conectado à **B**.
- [ ] Excluir na **A** → some na **B**.
- [ ] Upload na **A** → o anexo abre num client servido pela **B**.
- [ ] Login na **A** → requests roteados pra **B** continuam autenticados.
- [ ] Derrubar a **A** no meio de um uso → clients reconectam SSE na **B** sem perder estado.
- [ ] Rate-limit: martelar `/demands/bulk` alternando instâncias → ainda barra (ainda
      que mais frouxo, se ficar em memória).
- [ ] Matar a conexão de LISTEN de uma instância → ela reconecta e ressincroniza o cache.

---

## 5. Estimativa de esforço / quando fazer

| Fase | Esforço aprox. | Isolamento |
|---|---|---|
| 0 — storage (uploads + auth) | médio | alto (auto-contido) |
| 1 — rate-limit | baixo | alto |
| 2 — sessões | baixo | depende da 0 |
| 3 — LISTEN/NOTIFY (núcleo) | **alto** | precisa de teste cuidadoso |
| 4 — flip + testes | médio | — |

**Recomendação:** não faça HA "por precaução". Uma instância bem cuidada — com o
**health check** e o **guard de `unhandledRejection`** que já foram adicionados, mais
o `restart_policy` do Swarm — cobre com folga a escala de uma equipe. Reavalie quando
tiver um gatilho real (SLA de uptime, pico de usuários simultâneos, ou deploy sem
janela). Quando esse dia chegar, a Fase 3 (LISTEN/NOTIFY) é o coração — o resto é
encanamento.

---

*Escrito como parte da revisão de backend. Referências de código: `server.js`
(`db`, `broadcastChange`, `sseClients`, `flushDirty`, `makeRateLimit`, `UPLOADS_DIR`),
`db-store.js` (tabela `entities`, `flushDirty`/`applyBatch`), `secure-store.js`
(`auth.enc`).*
