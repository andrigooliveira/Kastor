# Surface: Relatórios (/analytics/reports)

**Route:** `/analytics/reports` (sub-tab da página Análises)
**Mode:** Operate — visitor diagnostica gargalos por etapa no processo.
**Audience:** Gestor de operações. Quer, em 2s, saber ONDE tá o gargalo no funil de etapas.
**Job on surface:** encontrar as etapas mais problemáticas no período (tempo médio × frequência); comparar entre etapas; abrir demandas específicas se precisar drilldown.

## Signals (user brief)

- **Job:** Achar gargalos no processo
- **Sensação alvo:** Painel diagnóstico denso
- **Preservar:** 4 KPIs · Tempo médio por etapa · Filtros (Squad/Cliente/Projeto/Período)
- **Pode remover:** Horas apontadas por etapa/pessoa (info redundante, competia com o "Tempo médio")

## Direction contract

**THESIS:** Reports é AUDITORIA DIAGNÓSTICA POR ETAPA. Refuse 2 cards de "Tempo médio por etapa" + "Horas apontadas" side-by-side (info sobreposta em formatos diferentes). Consolida numa **tabela mine-v2 de etapas** com colunas comparáveis: Etapa · Tempo médio · Passagens · Retrabalho · **Score de gargalo**. Os 4 KPIs viram **linha tipográfica** no topo (padrão /capacity).

**OWN-WORLD:** Roxo Studio contínuo, mine-table-v2 aesthetic. Score de gargalo colorido semanticamente (vermelho ≥70 crítico / âmbar 40-70 atenção / verde <40 ok). Tempo médio com barra visual proporcional. Retrabalho em cor âmbar quando >0.

**STORY:** Gestor abre → linha KPI dá status geral (Lead time, Pontualidade, Retrabalho, Concluídas). Vai pra tabela e a primeira row já é a ETAPA MAIS PROBLEMÁTICA (ordenada por score desc). Se precisar drilldown, o bloco "Demandas mais lentas" embaixo abre demandas individuais.

**FIRST VIEWPORT (1366×728):**
- Topbar 56 + Sub-tabs 60 = 116
- Header title 44
- Filter bar 44
- KPI line 32 (com hairline embaixo)
- Section header 32 + Tabela (thead 32 + N×48 rows) = variável
- Total ≈ 500-600 pra ~6-7 etapas visíveis sem scroll na dobra

**FORM:** Dealt 3, 1, 6. Picked **#3 KPI line + tabela por etapa** com **coluna Score de #1**. Signature: Score de gargalo formula `0.7*avgHours_norm + 0.3*samples_norm × 100` — combina LENTIDÃO e FREQUÊNCIA numa métrica única acionável.

**FINISH:** implementado 2026-09-20. Cache-buster `?v=20260920reports`. Bloco "Horas apontadas" descontinuado. "Demandas mais lentas" mantido como drilldown secundário.
