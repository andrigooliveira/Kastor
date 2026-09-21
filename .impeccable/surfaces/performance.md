# Surface: Performance de mídia (/performance)

**Route:** `/performance`
**Mode:** Operate — visitor audita performance de mídia paga por cliente/campanha.
**Audience:** Gestor de mídia. Bate os números do período por cliente, checa se está no orçamento e no CPL alvo.
**Job on surface:** ler CPL, ROI, invest, leads em uma dobra; comparar campanhas entre si; identificar gargalos por plataforma.

## Signals (user brief)

- **Job:** Auditar performance de mídia (CPL, ROI, invest, leads)
- **Sensação alvo:** Cockpit denso (máximo de info por dobra, poucas margens)
- **Preservar:** 6 KPIs com delta · 4 gráficos · Filtros (Squad/Cliente/Plataforma/Campanha/Período) · Toolbar de contexto
- **Ruído a matar:** Cards escuros com borda em torno dos gráficos · Toolbar de 5 dropdowns em linha densa

## Direction contract

**THESIS:** Performance é COCKPIT DE MÍDIA. Refuse os 6 cards de KPI com ícones circulares coloridos + os 4 cards escuros de gráficos com moldura pesada — a tela virava 10 caixas isoladas. KPI line tipográfica no topo (mesma linguagem da /capacity e /reports) + charts em sections com barra roxa 3px direto sobre o bg. Números em `tabular-nums` pra ler como planilha.

**OWN-WORLD:** Roxo Studio contínuo. KPI line = inline-flex com separadores verticais hairline entre items (padrão já estabelecido em /capacity). Section titles = barra roxa 3px + small caps + hint (padrão já estabelecido em /reports). Charts sem card box — direto sobre `--bg`, com título section-style em cima. Delta semanticamente colorido (verde up, vermelho down, muted flat), com inversão em CPL (menor = melhor).

**STORY:** Gestor abre → toolbar mostra "Squad · Cliente" e 5 filtros → KPI line dá o veredito de 6 métricas em uma olhada com deltas coloridos vs período anterior → grid 2×2 de charts em sections com barra roxa (Leads por campanha · Investxleads · CPL por campanha · Evolução) → tabela detalhada fecha o cockpit.

**FIRST VIEWPORT (1366×728):**
- Topbar 56
- Toolbar contexto+filtros ~80
- KPI line 60 (padding 14+14 + linha ~30)
- Section head 32 + chart body ~180 (× 2 linhas do grid) ≈ 480
- Total ≈ 700. Cabe.

**FORM:** Dealt 2, 4, 5. Picked **#5 (control room / trading terminal)**. Signature: **KPI line tipográfica sem cards + charts naked com section titles roxos** — a tela para de parecer "dashboard de blocos" e vira um extrato bancário legível.

**FINISH:** implementado 2026-09-21. Cache-buster `?v=20260921performance`. Direction respeitado — nenhuma função removida, todos os 6 KPIs + 4 charts + filtros preservados.
