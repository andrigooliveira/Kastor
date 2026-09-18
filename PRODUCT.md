# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Usuários primários são **gestores** (coordenam squad, distribuem demandas, monitoram prazos, reportam pro cliente) e **executores** (designers, redatores, mídia, dev, etc. — recebem demanda, executam entrega, apontam horas). Ambos ficam com o reWork aberto durante todo o expediente e voltam a ele várias vezes por hora.

Papéis secundários que também logam mas com uso mais eventual: **admins** (donos da conta, gerenciam usuários, workspaces, integrações), **freelancers** (executores externos com escopo restrito às demandas atribuídas — a UI muta em freelancer mode), e **clientes externos** (via link público read-only ou aprovação de entregável — não têm login pleno).

## Product Purpose

reWork organiza a operação diária de times/agências de marketing digital: recebe demanda, encaminha pela cadeia de responsáveis certa, mede tempo gasto, e devolve pro cliente com histórico. O sucesso do produto é o time nunca precisar perguntar "em quem tá essa demanda agora?" ou "quantas horas gastamos com o cliente X esse mês?" — as duas respostas ficam a um scroll de distância.

## Positioning

Diferente de Trello/Asana/Monday (boards genéricos), o reWork trata cada demanda como uma **cadeia de etapas com responsáveis que rotacionam** — a etapa atual sabe quem é o dono agora, e mover pra próxima passa o bastão pra outra pessoa. Isso reflete o modelo real de trabalho em agência (briefing → planejamento → execução → revisão → aprovação → entrega), onde o responsável muda a cada mudança de contexto e não faz sentido ter um único "assignee" pra demanda inteira.

## Operating Context

- Time de marketing (in-house ou agência) trabalhando sob squads/áreas com backlog constante de demandas curtas e médias (posts, campanhas, relatórios, criativos).
- Ciclo diário: chega demanda → gestor tipifica e distribui → executor pega, executa, aponta horas → passa pra revisão → aprova → entrega ao cliente.
- Ritmo semanal com prazos duros (semana termina sexta, mês vira relatório).
- Ferramentas paralelas comuns no time: Google Workspace (Drive/Calendar), Discord/Slack, ferramentas de criação (Figma, Adobe, Canva).
- Cliente aprova entregas por link público OU pelo email de notificação — não abre o app.
- Deploy é auto-hospedado (Docker Swarm + Nginx Proxy Manager) — o cliente-empresa que compra o reWork provisiona sua própria stack.

## Capabilities and Constraints

**Capabilities principais:**
- **Demandas** com fluxos customizáveis (etapas encadeadas com responsável por etapa), drag-and-drop de etapas, prioridade, prazo por etapa e prazo final, apontamento de horas, briefing rich text, anexos até 150MB, comentários com @menção.
- **Clientes e projetos** com metadata (Drive, ativos, briefing padrão, pessoas por função — atendimento, criativo, mídia).
- **Squads (workspaces)** — multi-tenant: cada squad tem suas demandas, clientes, fluxos, membros; user pode pertencer a vários squads.
- **Dashboard** com KPIs, meu foco de hoje, paradas, demandas previstas, radar de projetos com atraso, demandas recentes (últimas 4 que passaram por mim e seguem ativas), donut de prioridade, atividade recente.
- **Agenda semanal** com drag-and-drop de blocos + eventos do Google Calendar lado a lado (read-only).
- **Relatórios mensais** de cliente/projeto exportáveis pra PDF (jsPDF client-side).
- **Recorrentes** — demandas mensais geradas a partir de moldes; **Listas de tarefas** — templates aplicáveis a projetos com snapshot isolado.
- **Galeria** — todos os anexos de todas as demandas acessíveis num explorer, com viewer nativo (PDF via pdf.js, DOCX via mammoth, PPTX renderer custom, imagens/vídeos inline).
- **reWork Docs** — editor colaborativo tipo Google Docs (TipTap + Yjs + WebSocket), com comentários ancorados, versões automáticas, permissões finas, templates de briefing/SOW/relatório/ata/one-pager, import DOCX/TXT via LibreOffice server-side.
- **reWork Hub** — portal com grid dos subprodutos (Docs por enquanto; Presentations planejado).
- **Command palette** (Ctrl+K) buscando clientes, demandas, projetos, listas, usuários.
- **Real-time via SSE** — mudanças de outros usuários refletem sem F5.
- **Notificações** por email (SMTP) e Discord (webhooks por-workspace com persona custom por cliente).
- **Integrações** — Google Calendar (OAuth one-way read), Google Chat, Meta (Instagram/Facebook via webhook).
- **Base de Conhecimento** — sistema tipo blog com posts categorizados, embeds (YouTube, Vimeo, Notion, Figma, Miro, etc).
- **Cofre** — password manager compartilhado por squad, credenciais criptografadas (AES-256-GCM).
- **Freelancer mode** — user marcado como freelancer só vê demandas atribuídas, UI reduzida.

**Constraints técnicos:**
- Stack: Node.js 18+ + Express + PostgreSQL (JSONB para maioria dos dados) + vanilla JS single-file (`app.js` ~40k linhas) + CSS variables (dark/light theme).
- Zero build step no runtime (o único bundle é `writer.bundle.js` do editor Docs via esbuild).
- Deploy assumindo Docker Swarm + Nginx Proxy Manager, single-replica no nó manager (uploads em volume local até migrar pra storage compartilhado).
- Limite atual: 150MB por anexo (`client_max_body_size` no NPM precisa acompanhar).
- Idioma: PT-BR em toda a UI + copy + notificações.

**Undecided/planejado:**
- reWork Presentations (subproduto planejado, ainda não iniciado).
- Migração pra multi-replica horizontal (bloqueada por volume de uploads local).

## Brand Commitments

- **Nome "reWork"** + subprodutos: **reWork Docs**, **reWork Hub**, **reWork Presentations** (planejado). Nome legado "Kastor" ainda aparece no repositório (`kastor.exe`, path de containers) mas está sendo removido gradualmente da UI.
- **Cor primária: `#7A00FF`** (roxo/violeta) — usada em accent, botões primários, seleção, mark de comentário, brand marks. Não muda mesmo em rebrand.
- **Logos**: `reworkhub_simbol.svg`, `reworkdocs_icone.svg`, `reWork_branco.svg`, `reWork_preto.svg`.
- **Vocabulário PT-BR obrigatório**: "Demandas" (não "Tasks"/"Cards"), "Fluxos" (não "Workflows"), "Squads" (contexto de time — não "Workspaces" na UI), "Etapa" (não "Column"/"Stage" traduzido). Copy sempre em PT-BR informal-profissional.
- **Toda a arquitetura de subprodutos** (Hub como portal + subprodutos como rotas standalone que reusam tokens do main CSS) é decisão estrutural, não experimento.

## Evidence on Hand

- Produto em produção real (deploy ativo pra clientes pagantes), sob domínio próprio do cliente.
- CI/CD funcional: `.github/workflows/deploy.yml` → build → GHCR → Portainer webhook → Swarm update.
- Documentação técnica em `.Documentação/README.md` (arquitetura, API, modelo de dados) e `.Documentação/LEIA-ME.txt` (guia pra usuário final PT-BR).
- SVGs de brand em `public/reWork_*.svg`, `public/reworkdocs_*.svg`, `public/reworkhub_*.svg`.
- CSS tokens consolidados em `public/css/style.css` (`--accent: #7A00FF`, `--text`, `--surface`, `--hairline`, etc.), suporte dark/light via `[data-theme]`.
- Base de código com ~15k linhas de server + ~40k linhas de client, indica maturidade e dependência de estabilidade — não é MVP.

## Product Principles

1. **A etapa atual é a unidade fundamental.** Toda tela deve deixar visível em qual etapa a demanda está e quem é o responsável agora. Se o user tem que clicar pra descobrir, o design falhou.
2. **PT-BR informal-profissional em todo lugar.** Nada de "assignee", "workflow", "workspace". A copy carrega a mesma identidade da marca.
3. **Real-time é padrão, não feature.** Mudança de outra pessoa aparece na tela sem F5. Interfaces novas devem se ligar ao SSE existente, não introduzir polling.
4. **Multi-tenant por squad é fundamento.** Toda listagem, filtro e widget respeita o squad ativo. Não existe visão "global" que quebre esse escopo, exceto pra admin.
5. **Anexos, docs e comentários são cidadãos de primeira classe.** Marketing é ofício de artefato — a UI trata upload, preview e discussão desses artefatos com o mesmo cuidado que dá à demanda em si.

## Accessibility & Inclusion

- Copy 100% em PT-BR.
- Alvo majoritário: usuários brasileiros (agências in-house de marketing digital).
- Suporte a dark/light theme via toggle explícito (não usa `prefers-color-scheme` só). Contraste no dark tem sido priorizado historicamente porque é o default de fato do time.
- Nenhum requisito de acessibilidade específico (WCAG-AA, etc.) foi estabelecido formalmente ainda — trabalho de compliance é undecided.
