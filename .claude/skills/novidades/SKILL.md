---
name: novidades
description: Atualiza o painel de Novidades do reWork (release-notes.json) com os commits que ainda não viraram nota. Use quando pedirem para atualizar as Novidades, as notas de atualização ou o changelog, e ao fazer commit de algo que o usuário vê.
---

# /novidades — notas do painel de Novidades

O painel de Novidades lê `release-notes.json` na raiz de `Arquivos/` (servido por `_loadReleaseNotes` em `server.js`; não precisa reiniciar). Cada entrada:

```json
{ "id": "AAAA-MM-DD-slug", "date": "AAAA-MM-DD", "title": "...", "highlights": ["..."] }
```

Campos opcionais: `"highlight": true` (destaque, para as novidades grandes), `"hideFor": ["freelancer"]` (esconde de freelancer: cobrança, organização, Docs), `"kind": "launch"` + `"launch": {...}` (apresentação de produto novo; veja a entrada `2026-09-24-rework-docs-beta`).

## Passo a passo

1. Rode `node scripts/release-notes-pending.js` (de `Arquivos/`). Ele lista os commits desde o último que mexeu em `release-notes.json`, já sem deploy/chore/ci etc., com o corpo de cada um.
2. Descarte o que o usuário não vê: console de superadmin, deploy, variáveis de ambiente, ajustes de build, testes. Se um commit desfaz parte de outro (ex.: "tira a trilha de progresso"), não conte o que saiu.
3. Agrupe por tema, não um commit por nota. Vários commits do mesmo assunto em dias próximos viram uma nota só, com a data do mais recente.
4. Escreva no tom das notas que já estão no arquivo:
   - Português do usuário final, sem termos técnicos (nada de WebP, service worker, endpoint, token, PWA).
   - Diga o que a pessoa consegue fazer e onde: "Em Perfil › Segurança, ...". Use os nomes que aparecem na tela.
   - Título curto e concreto; 3 a 8 itens em `highlights`, cada um com uma ou duas frases.
   - Frases completas com ponto final. Prefira dois-pontos e ponto a travessão.
5. Coloque as entradas novas no topo do array, da mais recente para a mais antiga, com `id` único. Mantenha a indentação de 2 espaços e não mexa nas entradas antigas.
6. Valide: `node -e "require('./release-notes.json')"` e rode o script de novo. Ele avisa que o arquivo tem alterações não commitadas; depois do commit, a lista deve ficar vazia.
7. Mostre ao usuário a lista de notas criadas (data, título) e o que ficou de fora e por quê.

## Junto com o commit

Ao commitar algo que o usuário vê (feat, fix visível, perf perceptível), escreva ou atualize a nota no mesmo commit, seguindo os passos 3 a 6. Se a novidade complementa uma nota do mesmo dia ou dos dias anteriores ainda não lançada, acrescente itens nela em vez de criar outra.

Commit sem nada para o usuário pode levar a linha `Novidades: não` no corpo da mensagem: o script deixa de listá-lo.
