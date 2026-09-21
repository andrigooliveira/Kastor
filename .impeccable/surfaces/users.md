# Surface: Quadro da equipe (/users)

**Route:** `/users`
**Mode:** Admin — visitor administra o org chart do time.
**Audience:** Admin/gestor. Bate o quadro completo: quem faz o quê, em qual squad/área/cargo, com qual permissão, ativo ou não.
**Job on surface:** auditar o quadro, cadastrar/editar/desativar pessoas, e manter a taxonomia (Áreas/Cargos) organizada.

## Signals (user brief)

- **Job:** Auditar quadro (quem faz o quê, em qual squad/área/cargo)
- **Sensação alvo:** Dossiê organizado com hierarquia clara
- **Preservar:** Tabela com 7 colunas · Sections Áreas/Cargos com contadores · Pills coloridos semanticamente
- **Ruído a matar:** Botões de ação em cada linha misturados com pills

## Direction contract

**THESIS:** /users é DOSSIÊ DO QUADRO. Header do time no topo com contadores tipográficos (N ativos · N desativados · N áreas · N cargos) + toolbar compacta (Ver desativados + Cadastrar usuário). Tabela mine-v2 com section-title barra roxa 3px + small caps + hint. Taxonomia embaixo em grid 2-col hairline-separated (Áreas + Cargos), cada uma com sua CTA de criação inline no head. Refuse cards escuros com moldura ao redor de cada bloco; refuse botões de ação inline por row (edit/desativar) — vira kebab (⋯) que abre dropdown.

**OWN-WORLD:** Roxo Studio contínuo. Section titles = mesma linguagem de /reports /performance /demand-detail (barra roxa 3px + small caps + hint). Tabela mine-v2 aesthetic. Pills semânticos preservados: permissão (Admin roxo, Moderador âmbar, Freelancer verde, Equipe muted), situação (Ativo success verde, Desativado muted). Squad chips com dot colorido. Kebab menu com `<details>` nativo — fecha ao clicar fora via listener global.

**STORY:** Admin abre → header dá o total do time em uma linha ("10 ativos · 1 desativados · 6 áreas · 6 cargos") → toolbar compacta com Ver desativados + Cadastrar usuário → filtro Squads em chips → tabela mostra o quadro completo com pills semânticos → kebab (⋯) na última coluna abre ações (Editar / Desativar / Reativar) → embaixo grid 2-col hairline-separated pra taxonomia editável.

**FIRST VIEWPORT (1366×728):**
- Topbar 56
- Header dossiê 60 (título + contador subtitle + actions)
- Squad filter 44
- Section head "Pessoas" 32 + thead 32 + N×44 rows ≈ 476 pra 10 rows
- Total ≈ 700. Cabe.

**FORM:** Dealt 2, 3, 4. Picked **#4 (directory dossier)**. Signature: **kebab menu na última coluna** substituindo os 2-3 icon buttons inline por row, e **taxonomia (Áreas + Cargos) em grid 2-col hairline-separated** substituindo dois cards escuros lado a lado.

**FINISH:** implementado 2026-09-21. Cache-buster `?v=20260921users`. Direction respeitado — todas as 7 colunas preservadas, pills semânticos preservados, taxonomia com contadores e CTAs de criação preservados.
