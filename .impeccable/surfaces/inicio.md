---
version: 1
slug: "inicio"
primary_target: "inicio"
related_targets: []
---

# Surface: Início (dashboard home)

**Route/target:** `/dashboard` (or `/`) — the greeting home the sidebar's "Início" opens.
**Mode:** Operate — visitor completes a task (identify what to do now, then act).
**Audience:** Gestor de projetos + Executor. Same person opens this 40+ times per day, both roles share this surface.
**Job on surface:** ler o dia em 2 segundos e agir no primeiro item que interessa. Não relatório, não analytics: ação. Real-time updates via SSE keep this surface accurate through the day.
**Preserve (from user):** todos os widgets/dados atuais permanecem acessíveis, densidade alta desktop, SSE real-time, vocabulário PT-BR (Demandas/Fluxos/Squads/Etapa/Responsável).

## Direction contract

**THESIS:** A Início é uma leitura vertical em 2 colunas paralelas. Coluna esquerda é AGORA (o que resolvo hoje), coluna direita é PRÓXIMOS DIAS (o que vem). Recusa o grid de widgets iguais que dispersa atenção — cada widget do sistema atual é diluído dentro do fluxo da coluna certa, não flutua como card autônomo. Recusa também o hero-tela-cheia: a densidade operacional continua alta, mas organizada em 2 correntes contínuas em vez de 8 caixas.

**OWN-WORLD:** Dark-first Roxo Studio (`#7A00FF` aparece apenas em: item que espera VOCÊ agora, contadores hoje quando > 0 inline nos section titles, comentários direcionados @você, focus ring). Fundo global `#0c0c10`. As 2 colunas são separadas por hairline vertical `rgba(255,255,255,0.06)`, nunca borda. Dentro de cada coluna: fundo `#17171c` (surface carbono), items dentro são flat com hairline horizontal entre eles (não card individual), hover troca fundo do item pra `#22222a` (surface carbono-2). Tipografia: section titles ("AGORA", "PRÓXIMOS DIAS") em Geist 700 20px letter-spacing -0.01em — são o **heading próprio da coluna**, não kicker sobre outro heading. Subsections ("Foco de hoje", "Paradas") em Geist 600 14px com count inline `tabular-nums` à direita quando > 0. Body 13px 400. Nada de shadow em default — só em hover subtle (`0 1px 2px rgba(0,0,0,0.18)`).

**STORY:** Usuário abre e vê 2 correntes verticais. À esquerda ele lê primeiro (55%vw dominante): kicker uppercase "AGORA" + strip inline dos 3 contadores tabular-nums (Focos hoje / Paradas / Prazos hoje) sob a kicker, depois lista scrollable de items priorizados por urgência real (vencido > vence hoje > vence esta semana > outros). Cada item é 1 linha clicável (não drill-down): nome demanda, etapa, respons., timestamp relativo. Click abre detail em overlay. À direita (45%vw): kicker "PRÓXIMOS DIAS" + tabs internas (Previstas / Radar / Atividade / Horas) que trocam o conteúdo scrollable abaixo. A crença que ele forma: "em 2 segundos sei o próximo passo". A ação: clica direto no item da esquerda, resolve, volta e o item some (real-time SSE atualiza a lista).

**FIRST VIEWPORT (composição exata, viewport ~1440×900):**
- **Topbar existente 56px** (sidebar + topbar reWork globais, intocados).
- **Row 1 — Greeting compacto** (padding 28px 40px 16px): "Boa tarde, Andrigo" em Geist 700 clamp(24px, 3vw, 32px), letter-spacing -0.02em. Nenhuma subline.
- **Row 2 — 2 colunas full-height** (grid 55%/45%, cada coluna scroll independente):
  - **Coluna Esquerda:**
    - Column heading: **AGORA** em Geist 700 20px letter-spacing -0.01em, cor `#f5f5f7`. Este é o HEADING próprio da coluna, sem kicker acima. Padding 20px 32px 12px. Borda-baixo hairline `rgba(255,255,255,0.06)`.
    - Subseção `Foco de hoje` (title 14px 600 + count inline direita quando > 0 em Roxo Studio tabular-nums) → lista items horizontais (padding 12px 20px, hairline entre linhas, hover fundo carbono-2, tempo relativo à direita em tabular-nums).
    - Subseção `Paradas` (title 14px 600 + count inline, quando existe) → items com badge de dias parado.
    - Subseção `Comentários @você` (title 14px 600 + count inline, quando existe) → items com preview 1 linha + timestamp relativo.
    - Todo scroll interno; sticky subsection headers.
  - **Coluna Direita:**
    - Column heading: **PRÓXIMOS DIAS** em Geist 700 20px, mesmo tratamento do "AGORA".
    - Tab strip horizontal abaixo: `Previstas · Radar · Atividade · Horas`. Tab ativa: underline 2px Roxo Studio + text `#f5f5f7`. Tabs inativas: `#a1a1a1`.
    - Content abaixo troca conforme tab (mantém widgets existentes reformatados pra fit vertical estreito).
    - Scroll interno.
- **Separador entre colunas:** 1px `rgba(255,255,255,0.06)`, vai do topo do row 2 até o footer.
- **Ausência intencional de KPI strip hero:** counters entram inline nas subsection headers, jamais em hero-metric template. Craft-floor's refusal respeitada.

**FORM:** Dealt indices 4/6/2 (index 4 leads). User locked #2 (Split vertical Hoje/Semana) from my grounded 7-candidate list. Position #2 in my resonance ranking. Seed key: `4d1c9247`. Signature interaction: item da esquerda que troca de estado (via SSE) faz "slide-up-out" com 180ms ease-out enquanto o próximo item da fila sobe — o real-time é sentido, não interrompe.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
