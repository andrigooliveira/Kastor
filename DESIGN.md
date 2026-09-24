---
name: reWork
description: Central de Ateliê — precisão de dashboard com calor de estúdio criativo
colors:
  roxo-studio: "#7A00FF"
  roxo-studio-deep: "#5E00CC"
  roxo-studio-dim: "rgba(122,0,255,0.10)"
  bg-noturno: "#0c0c10"
  surface-carbono: "#17171c"
  surface-carbono-2: "#22222a"
  surface-carbono-3: "#2e2e38"
  bg-diurno: "#f5f5f8"
  surface-papel: "#ffffff"
  surface-papel-2: "#eeeef2"
  surface-papel-3: "#e4e4ea"
  text-alta: "#f5f5f7"
  text-alta-diurno: "#111114"
  text-media: "#b8b8b8"
  text-media-diurno: "#4a4a55"
  text-baixa: "#a1a1a1"
  text-baixa-diurno: "#6b6b74"
  hairline-noturno: "rgba(255,255,255,0.06)"
  hairline-diurno: "rgba(30,30,60,0.06)"
  sinal-sucesso: "#16a34a"
  sinal-aviso: "#b57100"
  sinal-perigo: "#e7000b"
  analitico-sky: "#2b7fff"
  analitico-cobalto: "#1447e6"
typography:
  display:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.75rem, 3vw, 2.25rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  2xl: "18px"
  pill: "999px"
components:
  button-primary:
    backgroundColor: "{colors.roxo-studio}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.roxo-studio}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-media}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  card-widget:
    backgroundColor: "{colors.surface-carbono}"
    rounded: "{rounded.lg}"
    padding: "16px 20px"
  chip-status:
    backgroundColor: "{colors.roxo-studio-dim}"
    textColor: "{colors.roxo-studio}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  input-default:
    backgroundColor: "{colors.surface-carbono-2}"
    textColor: "{colors.text-alta}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
---

# Design System: reWork

## Overview

**Creative North Star: "A Central de Ateliê"**

reWork é um dashboard tratado como estúdio. Metade Central de Operações: precisão de números, hierarquia clara, respeito ao ritmo de trabalho do gestor que abre 40 vezes por dia. Metade Ateliê de Marketing: calor no roxo, densidade que respira, personalidade no acabamento — os artefatos que o time produz (briefings, entregas, comentários) ocupam espaço com dignidade em vez de serem cards genéricos.

A base é dark-first — grande maioria dos usuários usa dark theme durante toda a jornada, e o produto foi construído nessa suposição. Light theme existe como toggle explícito e mantém a mesma linguagem, não é um afterthought, mas o dark é onde o produto respira melhor: os cinzas quentes carbono (`#17171c` → `#22222a` → `#2e2e38`) empilham como layers de estúdio, o roxo Studio (`#7A00FF`) tem impacto máximo, e a hierarquia vem por peso de texto + tom de fundo, não por linha divisória.

O produto **não é** um SaaS azul genérico com hero centralizado e três features iguais. Também **não é** um Google Docs / Notion neutro-branco onde a marca desaparece. É um ambiente de trabalho onde cada elemento tem função e onde o brand aparece com confiança nos momentos certos — não como decoração, como sinal.

**Key Characteristics:**
- Dark-first (com light theme igualmente polido)
- Densidade média-alta com respiro proporcional ao papel do widget
- Roxo Studio (`#7A00FF`) como sinal, não como fundo
- Hierarquia por tom + peso tipográfico, não por linhas
- Tátil no hover (elevação sutil), confiante no default (flat com camada tonal)

## Colors

Paleta dark-first construída sobre 4 cinzas carbono empilhados + roxo brand como sinal raro. Cores operacionais (sucesso/aviso/perigo) usadas com contenção; azuis analíticos ficam reservados aos charts.

### Primary
- **Roxo Studio** (`#7A00FF`): brand color. Usado em botões primários, seleção de item, hover ring, borda ativa de card, marca de comentário, badges de status ativo, ícone do subproduto. Aparece em ≤10% de qualquer tela renderizada — se ocupa mais, a hierarquia está errada.
- **Roxo Studio Deep** (`#5E00CC`): usado como cor de texto sobre superfícies claras onde o roxo puro perderia contraste (light theme, chip com fundo `roxo-studio-dim`). AA vs `#f5f5f8` = 8.2:1.
- **Roxo Studio Dim** (`rgba(122,0,255,0.10)`): fundo de chip/pill/tag quando o texto é roxo. Nunca usado como fundo de card — pequeno demais pra suportar bloco grande.

### Neutral (dark theme — o default)
- **Fundo Noturno** (`#0c0c10`): fundo global do app. Um preto quente, quase-preto, que não briga com o roxo.
- **Surface Carbono** (`#17171c`): fundo de card, sidebar, topbar, modal. É onde a maioria do conteúdo mora.
- **Surface Carbono 2** (`#22222a`): input, campo de textarea, secondary button. Uma camada acima do card.
- **Surface Carbono 3** (`#2e2e38`): hover state, track de progress bar, tab não selecionada. A camada mais externa da pilha.
- **Text Alta** (`#f5f5f7`): copy principal, títulos, values de KPI.
- **Text Média** (`#b8b8b8`): metadata, labels de eixo, hint de campo.
- **Text Baixa** (`#a1a1a1`): tempo relativo, footer, placeholder.
- **Hairline** (`rgba(255,255,255,0.06)`): divisor horizontal entre linhas de tabela/lista. Nunca borda de card (card usa tom).

### Neutral (light theme)
- **Fundo Diurno** (`#f5f5f8`): fundo global.
- **Surface Papel** (`#ffffff`), **Papel 2** (`#eeeef2`), **Papel 3** (`#e4e4ea`): mesma escala de camadas do dark, invertida.
- **Text Diurno** (`#111114`, `#4a4a55`, `#6b6b74`): equivalente ao dark.
- **Hairline Diurno** (`rgba(30,30,60,0.06)`): divisor com tint frio.

### Operational Signals
- **Sinal Sucesso** (`#16a34a`): entregas concluídas, prazo confortável, conexão real-time OK.
- **Sinal Aviso** (`#b57100`): atenção requerida, prazo apertado, etapa parada.
- **Sinal Perigo** (`#e7000b`): destrutivo (deletar), demanda vencida, erro. Sempre pareado com confirmação — nunca destrói sem perguntar.

### Analytical
- **Analítico Sky** (`#2b7fff`), **Analítico Cobalto** (`#1447e6`): usados exclusivamente em charts e visualizações de dados. **Não** entram em botões, hover, ou qualquer elemento interativo — o azul é sagrado dos charts pra o cérebro do gestor não confundir "está clicável" com "é um data point".

### Named Rules
**The Roxo Signal Rule.** O Roxo Studio aparece em no máximo 10% da área visível de qualquer tela. Se ele domina, a atenção do usuário se dispersa. Fluxos com muito estado ativo (uma linha por demanda em progresso) usam a bolinha colorida da etapa, não o roxo do brand.

**The Blue-Is-Data Rule.** Azul (`#2b7fff`, `#1447e6`) só existe em charts e visualizações de dados. Não colorimos botões, links ou hovers em azul — a marca não é BlueSaaS, e reservar o azul pros charts torna a leitura de dados mais rápida.

**The Tonal Layer Rule.** Elevação é comunicada por 3 camadas de cinza carbono (`--surface`, `--surface-2`, `--surface-3`), não por borda. Uma borda em card quebra a leitura vertical — se precisa destacar, muda o tom, não adiciona linha.

## Typography

**Family principal:** Geist (variable, `-apple-system` fallback, então SF Pro / Segoe UI / Roboto). Geist foi escolhida por precisão técnica sem parecer robótica, boa legibilidade em tamanhos pequenos (que dominam a UI), e presença sem barulho.

**Mono:** JetBrains Mono (`ui-monospace` fallback). Usada em IDs, timestamps de log, código, valores de token.

**Caráter:** direto, profissional, sem serifs. Zero decoração. Os pesos fazem o trabalho: 400 pra body, 600 pra title, 700 pra headline. O tracking negativo em títulos (`-0.02em` a `-0.005em`) traz densidade sem perder legibilidade.

### Hierarchy
- **Display** (peso 700, `clamp(1.75rem, 3vw, 2.25rem)`, line-height 1.15): saudação do dashboard ("Boa tarde, Andrigo!"), título hero em landing pages/onboarding.
- **Headline** (peso 700, 18px, line-height 1.25): título de widget (`Meu foco de hoje`, `Demandas recentes`), título de modal, nome de demanda no detail.
- **Title** (peso 600, 15px, line-height 1.35): título de card interno, nome de cliente/projeto, breadcrumb.
- **Body** (peso 400, 13px, line-height 1.55): copy principal, descrição de demanda, comentário. O core operacional da UI.
- **Label** (peso 700, 10px, letter-spacing 0.08em, UPPERCASE): section headers (`ETAPA ATUAL`, `RESPONSÁVEL`, `PRIORIDADE`), header de coluna de tabela, seção de sidebar.
- **Mono** (peso 500, 12px, line-height 1.4): IDs, timestamps, valores tabulares numéricos (usa também `font-variant-numeric: tabular-nums` no CSS pra alinhar dígitos).

### Named Rules
**The Numeric Tabular Rule.** Qualquer número que aparece em ranking ou em comparação vertical (KPI, tempo, contagem) usa `font-variant-numeric: tabular-nums`. Números que "pulam" horizontalmente durante scroll ou sort são anti-leitura.

**The Label Small-Caps Rule.** Labels de seção são sempre em 10px + weight 700 + letter-spacing 0.08em + UPPERCASE. Nunca aumente pra 12px "pra ficar mais legível" — o tamanho pequeno é o que separa metadata de conteúdo real.

## Layout

Grade fluida com `max-width: 1280px` para páginas de conteúdo, `max-width: 1080px` pra landing pages dos subprodutos (Docs, Hub). Sidebar fixa em 230px que colapsa pra 44px (só ícone) em telas menores ou pela vontade do usuário. Topbar sticky em 56px.

Densidade média-alta na main app (Demandas, Detail): as informações são tabulares e o gestor precisa ver bastante coisa numa vista. Densidade baixa nos subprodutos (Docs, Hub): quando a UI é conteúdo, ela respira.

**Grid de widgets do dashboard:** grid CSS de 2 colunas em desktop (~600px cada), 1 coluna em mobile. Widgets pequenos (2 tone-cores) se juntam em row de 2. Widgets grandes (feed, radar) ocupam linha inteira.

**Spacing rhythm:** múltiplos de 4px (4, 8, 12, 16, 20, 24, 32, 40). Padrão de card = 16-20px de padding interno, 8-12px entre elementos internos, 24px entre widgets. Não há token nomeado pra spacing — CSS usa valores literais e a convenção é a doutrina.

**Breakpoints:** móvel < 640px, tablet 640–1024px, desktop > 1024px. A maior parte da app assume desktop e usa media queries só pra quebrar o sidebar e reduzir densidade.

## Elevation & Depth

Sistema **híbrido: camada tonal como base + sombra sutil quando o estado exige**. A camada tonal (3 níveis de cinza carbono) é o mecanismo primário de profundidade — cards, inputs e hovers escrevem "acima do fundo" mudando de `--surface` para `--surface-2` para `--surface-3`. As sombras são reservadas pra quando o estado tem que gritar: modal, popover, overlay, elemento draggable levantado.

### Shadow Vocabulary
- **xs** (`0 1px 2px rgba(0,0,0,0.18)`): usado em input focused, chip elevado. Quase imperceptível.
- **sm** (`0 1px 3px rgba(0,0,0,0.20), 0 1px 2px rgba(0,0,0,0.12)`): dropdown, tooltip.
- **md** (`0 4px 12px rgba(0,0,0,0.24), 0 2px 4px rgba(0,0,0,0.14)`): card em hover, item de lista draggable levantado.
- **lg** (`0 12px 32px rgba(0,0,0,0.32), 0 4px 8px rgba(0,0,0,0.18)`): modal padrão, popover de menubar.
- **xl** (`0 24px 64px rgba(0,0,0,0.38), 0 8px 16px rgba(0,0,0,0.22)`): modal fullscreen, gallery viewer.
- **focus** (`0 0 0 4px var(--accent-dim)`): ring de foco de input/botão. Roxo dim, respeita a marca.

Light theme reduz as sombras pra ~40% da intensidade e adiciona tint frio (`rgba(30, 30, 60, ...)`) pra evitar sombras "cinza sujo" em papel.

### Named Rules
**The Flat-By-Default Rule.** Superfícies default são flat — camada tonal comunica hierarquia. Sombras só aparecem em resposta a estado: hover, focus, ou elevação semântica (modal, popover). Um card com sombra em estado default é ruído.

**The Glass Only For Chrome Rule.** O `backdrop-filter: blur()` (via `--glass` e `--surface-glass`) só entra em chrome (sidebar, topbar, modal overlay). Nunca em card de conteúdo — repintar o blur a cada frame de scroll criava jank e não trazia valor visual.

## Shapes

Sistema de raios em 7 passos, todos múltiplos aproximados de 4px, escalados pra caber o gesto certo em cada tamanho.

- **xs (4px):** ícones em chip pequenos, pill de tag numérica.
- **sm (6px):** botões padrão, inputs, checkbox. O default.
- **md (10px):** cards de widget do dashboard, dropdown.
- **lg (12px):** cards do Detail (`.detail-stage-card`), modal padrão.
- **xl (14px):** modal grande, gallery card, hero card do Hub.
- **2xl (18px):** raro — usado em cards de destaque hero.
- **pill (999px):** chips de status, badges, avatar, botão de ação com ícone único.

Bordas são raras. Onde existem, usam `--border` (dim de `--surface-3`) e são de 1px. Estados focused/active usam `--border-active` (`rgba(122,0,255,0.55)`) — nunca `--accent` puro, que é reservado pra fills.

### Named Rules
**The Gesture-First Radius Rule.** O raio segue o gesto: se você toca com a ponta do dedo (botão pequeno, chip), 6px basta. Se envolve uma área grande (card, modal), 12-14px pra parecer "colocado sobre" a superfície em vez de "recortado da" superfície.

## Components

### Buttons

- **Shape:** raio pequeno (`--radius-sm`, 6px), padding `8px 16px`, font size 13px, weight 600.
- **Primary (`.btn-primary`):** fundo `--accent` (`#7A00FF`), texto branco, sombra sutil (`0 1px 2px rgba(122,0,255,0.20)`) + inset highlight de 1px branco no topo pra dar dimensionalidade. Hover: `brightness(1.08)`. Ativo em ≤2 CTAs por tela.
- **Ghost (`.btn-ghost`):** transparente com borda `--border`, texto `--text-dim`. Hover: fundo `--surface-2` + borda `--border-active`. É o botão default pra ações secundárias.
- **Danger (`.btn-danger`):** transparente com borda `--danger-dim`, texto `--danger`. Hover: fundo `--danger-dim`. Sempre confirma antes de executar.
- **Sm modifier (`.btn-sm`):** padding `6px 11px`, font `11px`. Usado em toolbars densas.
- **Transição:** `transform` sob `--ease-spring`, tudo mais sob `--ease-out`. Botão primary tem um `::after` com radial gradient branco pra brilho sutil.

### Chips / Status Pills

- **Style:** fundo `--accent-dim` ou variante colorida (`--success-dim`, `--warn-dim`, `--danger-dim`), texto na cor forte correspondente (`--accent-text`, `--success`, etc.), raio `pill` (999px), padding `3px 10px`, tipo `label` (10px 700 uppercase).
- **State:** usado como badge (não interativo) OU como filtro (interativo, com cursor + hover). Filtros ativos ganham fundo mais forte + borda `--accent`.
- **Bolinha colorida antes do label:** convenção pra status/etapa — usa `background: var(--stage-color)` no CSS custom prop, permite personalização por instância.

### Cards / Containers

- **Widget (`.dash-widget`):** fundo `--surface-carbono` (`#17171c`), raio `lg` (12px), padding `16-20px`. Head interno (title + subtitle + optional icon), corpo. Sem borda default; hover mostra sutil scale + shadow.
- **Card de item de lista (`.dash-recent-row`, `.demand-att-item`):** flat, raio `md`, padding menor (`10px 12px`), fundo herdado do widget. Divisor entre items é hairline (`rgba(255,255,255,0.06)`) na base, nunca borda completa. Hover: fundo `mix(accent 6%, transparent)`.
- **Detail-stage-card:** card destacado com `--stage-color` variável (cor da etapa), background `mix(stage-color 12%, surface)`, borda 1px `mix(stage-color 35%, hairline)`, faixa vertical de 3px em `--stage-color` no lado esquerdo. Ícone + info + prazo alinhados em flex-wrap pra sobreviver a viewport estreito.
- **Padding interno:** widgets 16-20px, cards menores 8-14px. Nunca deixa borda "colada" no conteúdo.

### Inputs / Fields

- **Style:** fundo `--surface-2` (`#22222a`), borda 1px `--border` (que em dark theme é `--input`, `rgba(255,255,255,0.15)`), raio `sm` (6px), padding `8px 10px`, font body (13px).
- **Focus:** borda muda pra `--border-active` (roxo dim) + sombra `--shadow-focus` (`0 0 0 4px var(--accent-dim)`). O ring roxo é a assinatura visual do foco.
- **Error:** borda `--danger`, mensagem inline abaixo em `--danger` 12px.
- **Disabled:** opacidade 0.5, cursor `not-allowed`.

### Navigation (Sidebar)

- **Estrutura:** logo · seletor de squad (inicial colorida + nome) · "Buscar" (abre a paleta, Ctrl K) · itens · Documentação + engrenagem · rodapé com a pessoa (abre o menu de status), tema e recolher. Renderizado por `renderSidebarNav` em `app.js`, como `<a href>` reais.
- **Menu padrão** (`NAV_DEFAULT`): Início, Minhas Demandas, Demandas, Agenda, Clientes · Dashboards, Análises, Performance · Galeria, Base de conhecimento. Itens seguidos da mesma seção (`sec` em `NAV_CATALOG`) formam um bloco; o espaço entre blocos substitui títulos.
- **Personalizar menu** (`/menu`, `renderMenuPage`): à esquerda "Seu menu" na ordem (arrastar ou setas na alça; x tira), à direita todos os acessos que a pessoa pode ver, em cartões por seção com interruptor "no menu". Cada mudança salva sozinha em `me.navMenu` no servidor (`null` = padrão).
- **Pé fixo:** Documentação sempre visível; ao lado, a engrenagem discreta abre "Personalizar menu" e "Configurações" (o perfil). A engrenagem acende no perfil, no Personalizar menu e em telas que não estão no menu.
- **Item:** 34px de altura, ícone lucide 16px, label 13px weight 500, texto `--text-dim`, ícone `--text-muted`. Hover: fundo `--surface-2`.
- **Item ativo:** fundo `--accent-dim`, texto `--accent-text` weight 600, ícone `--accent`, barra de 3px em `--accent` na borda esquerda.
- **Contador:** Minhas Demandas mostra o total em aberto; fica vermelho quando há atrasada (recolhida: só o ponto vermelho).
- **Largura:** 236px aberta, 64px recolhida (só no desktop; ícones com rótulo ao lado no hover). No celular vira gaveta, sempre aberta.

### Signature: Etapa/Stage Card

Um card do detail-stage-card com cor dinâmica via CSS custom prop `--stage-color`. O componente muta cor de acordo com a etapa atual da demanda, mas mantém a mesma estrutura. É o momento onde o "brand" temporariamente vira "identidade daquela etapa" — reforça que a etapa é a unidade fundamental da UI (Princípio 1 do PRODUCT.md).

## Motion

Uma escala só, definida no bloco "SISTEMA DE MOVIMENTO (v2)" no fim do `style.css`.

- **Durações:** `--dur-1` 120ms (hover, press), `--dur-2` 200ms (popover, troca de aba, saídas), `--dur-3` 280ms (modal, página, toast), `--dur-4` 420ms (cascata de entrada).
- **Curvas:** entrada em `--ease-out`, saída em `--ease-in` e sempre mais curta que a entrada. `--ease-spring` fica pra `transform` de press/hover.
- **Distância:** 4-8px de deslocamento, escala mínima .98. Sem bounce.
- **Cascata:** só na entrada da página (`.page.is-entering`, ligada por `markPageEntering()` no `goPage`). Re-render por SSE ou filtro não reanima.
- **Loops:** só pra estado vivo de verdade (timer rodando, skeleton). Nada pulsando pra chamar atenção.
- **Saídas:** toasts recolhem com `dismissToast()`; modais encolhem pra .985 com fade.
- **Tema:** troca vira cross-fade via View Transitions.
- **Abas e segmentados:** um marcador por grupo desliza até a aba ativa (`initTabIndicators()`, lista em `TAB_IND_SETS`). Aba nova entra na lista, não ganha estilo próprio de ativo.
- **Números e barras:** contam do zero e crescem só na entrada da página (`animateCounters()`).
- **Conclusão:** demanda que cai numa etapa de conclusão (qualquer caminho) mostra o toast `celebrate` e o confete sai dele (`celebrateCompletion()`). Único momento com confete: comemoração que vira rotina perde a graça.
- **Comentário novo:** sobe com fundo roxo que se apaga (`.chat-comment.is-arriving`).
- **Prévia:** `/api/admin/motion-preview` (só admin) mostra tudo isso com o `style.css` real, em claro/escuro e câmera lenta.
- **`prefers-reduced-motion`:** desliga tudo.

## Do's and Don'ts

### Do:
- **Do** usar tom (`--surface-N`) pra hierarquia visual em vez de borda. Camada tonal é o mecanismo principal de profundidade — bordas quebram leitura vertical.
- **Do** usar o Roxo Studio (`#7A00FF`) como sinal raro (≤10% da tela). Em botão primary, chip ativo, hover ring, mark de comentário. Nunca como fundo de card.
- **Do** manter azul (`#2b7fff`, `#1447e6`) exclusivo pra charts. Não colorir botões/links em azul.
- **Do** usar `font-variant-numeric: tabular-nums` em qualquer coluna de números (KPI, ranking, tempo).
- **Do** aplicar `--shadow-focus` (roxo dim) em input focado — é a assinatura visual do foco.
- **Do** escrever labels de seção em `10px 700 uppercase 0.08em`. Diferencia hierarquia sem competir com conteúdo.
- **Do** usar bolinha colorida de `--stage-color` antes de labels de status/etapa. Comunica a etapa em ~2px sem consumir espaço.

### Don't:
- **Don't** colocar sombra em card default. Sombra só em hover, focus, ou estado semanticamente elevado (modal, popover). Card com sombra em rest é ruído.
- **Don't** parecer BlueSaaS: hero centralizado, três feature cards iguais, botão primário azul. Se algum PR começa a caminhar pra isso, é sinal de rota errada.
- **Don't** parecer Notion/Google Docs neutro-branco. O produto tem marca — o roxo aparece com confiança onde faz sentido, e não se esconde por conta de "neutralidade".
- **Don't** usar borda como divisor entre linhas de lista/tabela. Use hairline (`rgba(255,255,255,0.06)`) que "pertence" ao card.
- **Don't** aumentar labels de section pra 12px "pra ficar mais legível". O 10px é o que define eles como metadata, não como copy.
- **Don't** usar `backdrop-filter: blur` em card de conteúdo. Só em chrome (sidebar, topbar, modal overlay). Repinta a cada frame de scroll e gera jank.
- **Don't** traduzir vocabulário PT-BR. "Assignee", "workflow", "workspace" quebram a identidade. Use "Responsável", "Fluxo", "Squad".
- **Don't** introduzir uma família de fonte nova. Geist + JetBrains Mono cobrem tudo. Ver `Georgia`/`Helvetica`/`Calibri` no código é resquício de recibos/PDFs — não expandir pra UI.
