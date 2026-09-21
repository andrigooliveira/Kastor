# Surface: Detalhe de demanda (/demands/:id)

**Route:** `/demands/:id`
**Mode:** Operate — visitor entra pra ler o "caso" da demanda e agir (comentar, avançar etapa, apontar tempo).
**Audience:** Gestor/operador que abre uma demanda a partir do kanban, dashboard, calendário ou análise.
**Job on surface:** ler briefing/descrição, ver o estado atual (etapa, prazo, responsável), acompanhar comentários/atividade, e mover a demanda pra frente.

## Signals (user brief)

- **Job:** Briefing, descrição, comentários, etapas — não remover NENHUMA função existente
- **Sensação alvo:** Dossiê organizado com hierarquia clara
- **Preservar:** Painel direito com abas · Registrar tempo em destaque · Metadados completos no 1º viewport
- **Ruído a matar:** Card "Etapa atual" + prazo isolado (redundante com pipeline no topbar)

## Direction contract

**THESIS:** Detalhe de demanda é um DOSSIÊ, não uma coleção de cards soltos. Header identifica o "caso" (título + breadcrumb com squad/cliente/projeto/fluxo). Uma ribbon tipográfica compacta traz os metadados de estado em linha (prioridade · prazo da etapa · entrou · criada · concluída). Depois o corpo em sections com barra roxa 3px (Briefing/Descrição, Anexos, Apontamentos). Refuse: card `.detail-stage-card` (nome + prazo — info já no pipeline do topbar); grid `.detail-meta-row` de 4 datas soltas com ícones coloridos; empty states com box escuro grande.

**OWN-WORLD:** Roxo Studio contínuo. Ribbon = mesma linguagem da KPI line da /capacity (inline-flex com hairline vertical entre items). Section titles = mesma linguagem de /reports e /capacity (barra roxa 3px + small caps + hint). Empty states inline compactos (12px dim, sem box). Responsável mantido como bloco interativo próprio (owner-picker dropdown).

**STORY:** Gestor abre → header identifica em 2s (nome + breadcrumb) → responsável logo abaixo → ribbon dá contexto de estado em uma linha → corpo com briefing/descrição, anexos, apontamentos em sections separadas por hairline → painel direito mantém abas (Comentários/Checklist/Formulários/Atividade/Etapas) com Registrar tempo em destaque → footer com avançar etapa. Pipeline sempre no topbar.

**FIRST VIEWPORT (1366×728):**
- Topbar 56 (pipeline centralizado)
- Header dossiê 60 (título 20/700 + breadcrumb 11/muted)
- Responsável 60 (label + picker)
- Ribbon 50 (padding 12+12 + linha 24)
- Section Briefing 32 + conteúdo variável
- Section Anexos 32 + linha ou empty
- Section Apontamentos 32 + linha ou empty
- Painel direito 100% altura ao lado (~360px)
- Footer 60 (avançar etapa)
- Total ≈ 728. Cabe com folga.

**FORM:** Dealt 8, 3, 7. Picked **#8 (dossiê)**. Signature: **ribbon tipográfica de metadados** substituindo o grid solto de 4 datas + card etapa atual — mesma linguagem visual da KPI line da /capacity, criando família entre as telas.

**FINISH:** implementado 2026-09-21. Cache-buster `?v=20260921demand`. Direction respeitado — nenhuma função removida, todos os metadados no 1º viewport.
