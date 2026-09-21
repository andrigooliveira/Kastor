# Surface: Ritmo (/analytics/rhythm)

**Route:** `/analytics/rhythm` (sub-tab da página Análises)
**Mode:** Operate — visitor diagnostica gargalos por squad numa semana.
**Audience:** Gestor de operações. Quer, em 2s, saber quais squads estão devendo esta semana.
**Job on surface:** ver o quadro geral por squad; identificar quem está no ritmo, adiantado, ou atrasado; entender o volume (entregues/atrasadas/em aberto) sem precisar aprofundar em cada chart.

## Signals (user brief)

- **Job:** Diagnosticar gargalos por squad
- **Sensação alvo:** Painel de auditoria denso
- **Ruído a matar:** 4 problemas — chart gigante por squad, legenda pouco clara, subtitle prolixo, sem quadro geral
- **Preservar:** contagens (entregues/atrasadas/aberto), filtros (SQUADS/Período), badge de status por squad
- **Pode remover/repensar:** o burndown chart cheio por card

## Direction contract

**THESIS:** Ritmo é AUDITORIA POR SQUAD, não CHART POR SQUAD. Cada squad vira 1 row numa tabela lisa; refuse cards com burndown de 800×200; refuse subtitle explicativo de 3 linhas. A leitura tem de caber num olhar.

**OWN-WORLD:** Roxo Studio contínuo, mesma família da mine-table-v2 (dark-first, hairlines, tons sutis). Cores semânticas SÓ nos sinais que importam: status pill (verde no ritmo / âmbar / vermelho atrasado), atrasadas em vermelho quando > 0, delta ideal como pill compacto (vermelho pra cima, verde pra baixo).

**STORY:** Gestor abre → tabela mostra os N squads em N linhas. Status pill diz de imediato quem tá bem/mal; contadores dão volume; delta dá gravidade; sparkline 60×16 dá tendência sem virar hero. Se quiser aprofundar, drilldown por row (futuro).

**FIRST VIEWPORT (1366×728):**
- Topbar 56 + Sub-tabs 60 = 116
- Row 1 (Title compacto): 44 — "Ritmo por squad" 18/700 + subtitle 12/dim 1 linha
- Row 2 (Filter): 40 — SQUADS chips + rótulo `dd/mm → dd/mm` inline à direita + seletor Semana
- Row 3+ (Table): resto — thead 32 + N × 48 rows. 5 squads = 32 + 240 = 272px total. Cabe com folga em 728.

**FORM:** Dealt 5, 1, 7. Picked **#1 Table ranking por squad**. Sparkline signature: 60×16 SVG, real (colorido por status) + ideal (tracejado cinza).

**FINISH:** implementado 2026-09-20. Direction respeitado. Legenda inline abaixo da tabela. Cache-buster `?v=20260920rhythm`.
