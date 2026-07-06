# Auditoria Codex — Etapa 0: ref limpo da feature de dossiê + seed (SEM deploy)

Data: 2026-07-06 · Status: **EXTRAÍDO, NÃO DEPLOYADO.** Aguarda auditoria Codex.
Worktree: `/Users/caiodevasconcelos/hotfix-extravio-feature` · Branch: `hotfix/extravio-parcial-feature` · Base: `41ab943`.

## Objetivo
Reproduzir num ref LIMPO (commitado) a feature de extravio parcial que roda em prod suja — **Camadas A (Fase 1
dossiê) + B (seed histórico)** — sem WIP/reabertura/front/anthropic-usage. **Camadas C (gate/enforce no executor)
e D (Caso 2) ficaram FORA** (ver emenda 5).

## Commits (4, vs base `41ab943`)
| Hash | Commit | Conteúdo |
|---|---|---|
| `2799a24` | `feat(dossie): add partial loss dossier module` | `_shared/extravio-parcial-dossie.ts` (+`.test`, 54 testes) — módulo **monolítico** (A+B+C+D puros; C/D inertes sem wiring) |
| `636ce68` | `feat(dossie): wire dossier + historical romaneio seed in interpreter` | interpretador Fase 1 **+ seed** (combinados — ver deviation) |
| `4d85d3f` | `feat(dossie): annotate oc33 gate metadata` | `_shared/propostas-pos-resposta-cliente.ts` (finalizer `gate_oc33`) |
| `370b2af` | `docs(dossie): add ADR 0011` | ADR |

Diff total: **5 arquivos, +1716/−16.**

## Resolução das emendas
1. **`regras-auto-acao` FORA (justificado):** a anotação `gate_oc33` chega aos todos por 2 caminhos que ENTRAM
   nesta extração — o re-patch de todos ativos no interpretador (Blocker 4) + o finalizer `propostas-pos-resposta-cliente`.
   O gate via `regras-auto-acao` seria um 3º site redundante; não está na fonte limpa e está emaranhado com
   oc19/repatch (já na base `41ab943`). Confirmação p/ Codex: o gate metadata **existe** (interpretador + propostas), não some.
2. **Deploy real dos `_shared` (mapeado):**
   - `extravio-parcial-dossie.ts` bundlado por: `interpretador-resposta-cliente` (ENTRA), `executor` (deferido C/D), `agente-ressarcimento-relancar-54` (deferido D).
   - `propostas-pos-resposta-cliente.ts` bundlado por: **`cron-ia-resposta-pendentes`, `scan-email-pre-card`, `vinculador`** → estes 3 precisam redeploy p/ a anotação de gate valer.
3. **Caso 2 (D) FORA:** `agente-ressarcimento`, `reprocessar-anexos`, `agente-sugere`, `reuso-anexo`, `jpeg-sintetico`
   e o wiring Caso 2 no executor **não entraram**. O módulo carrega as funções Caso 2 (monolítico) mas **inertes**
   (sem wiring; gated por `caso2_enabled=OFF`).
4. **Interpretador — anthropic-usage EXCLUÍDO (foram 3 remoções, não 2):** import `makeUsageRecorder` (L23) +
   `onUsage:` (L234-237) + **`meta: {cardId, messageId}` na chamada `completeJson` (L325)**. Descoberta: o
   `anthropic-client.ts` da base NÃO aceita `meta` (o WIP suportava) → sem a 3ª remoção dava `TS2353`. Fase 1 +
   seed mantidos; `deno check` interpretador = **0 erro local**.
5. **Executor DEFERIDO (evidência):** `decidirAcaoRomaneioCompletude` (blindagem `fonte:"ssw"`) é chamada **só
   dentro de `materializarOc33Completude`** (materializer da 2ª oc33 = **Caso 2**, gated por `caso2_enabled`). E
   `decidirGateOc33` olha **só `presente`, não `fonte`** → o gate trata `fonte:"ssw"` corretamente **sem** blindagem.
   Logo, para Fase 1 + seed (enforce OFF, caso2 OFF) a blindagem/materializer **não rodam e não são necessárias**;
   "blindagem sem materializer" seria código morto. O executor (gate/enforce + Caso 2) vira uma extração dedicada
   na etapa de **enforcement/Caso 2**.
6. **Repatch B/C do `agente-sugere` = dívida separada** (não entrou nesta extração; já está deployado sujo — registrar limpeza à parte).

## Deviations da ordem sugerida (explícitas)
- **Commits 2 e 5 combinados** (interpretador Fase 1 + seed num commit só). Motivo: separar hunks do MESMO arquivo
  exige staging interativo (`git add -p`), indisponível aqui; a separação manual seria propensa a erro. O **conteúdo
  final é limpo** (Fase 1 + seed, sem anthropic-usage). Se o Codex exigir a separação, dá pra refazer.
- **Commit 4 (executor) não feito** — deferido por evidência (emenda 5).
- **Guards `verify-cockpit`/INVARIANTES não entraram:** o check INV-034 referencia partes deferidas (executor
  `gateOc33Enforce`, Caso 2 `reuso-anexo`/`detectarPedirDescricaoValor`) → rodaria FAIL num ref parcial. Entra com
  o executor/Caso 2. O guard imediato é o **módulo test (54)** + `deno check`.

## Gates (todos verdes)
- `rg` proibidos no diff INTEIRO = **0** cada: `DecisaoReaberturaDetalhada`, `decidirReaberturaPorOrdemSsw`,
  `passDDevePreservarBannerIaSugestao`, `ultimoLancamentoCockpitInfo`, `makeUsageRecorder`, `anthropic-usage`.
- **sync-bastao tocado = 0.**
- `deno test extravio-parcial-dossie.test.ts` = **54 passed**.
- `deno check` interpretador + propostas = **0 erro local** (0 TS2305/2724, 0 novo).

## Functions a deployar POR CAMADA (quando aprovado)
- **A+B (operação assistida + seed):** `interpretador-resposta-cliente` (dossiê Fase 1 + seed + módulo) **+**
  `vinculador` + `scan-email-pre-card` + `cron-ia-resposta-pendentes` (os 3 que bundlam o finalizer `propostas`).
  *(Front Lovable "faltam X" = passo à parte.)*
- **C (enforcement):** deploy do `executor` (gate) — **extração dedicada** — depois flip `gate_enforce=ON`.
- **D (Caso 2):** `agente-ressarcimento` + `reprocessar-anexos` + `executor` (materializer) + `agente-sugere` — depois flip `caso2_enabled=ON`.

## Confirmações explícitas
- ✅ `gate_enforce` **OFF** · ✅ `caso2_enabled` **OFF** · ✅ **nenhuma** mudança no `sync-bastao` · ✅ **nenhuma**
  mudança de reabertura · ✅ **nenhum** deploy · ✅ working tree sujo **não usado** (extração via worktree limpo).

## Pergunta ao Codog
1. OK combinar interpretador Fase 1 + seed num commit, dada a limitação de staging? Ou exigem separação?
2. OK deferir o executor inteiro (gate + Caso 2) para uma extração dedicada, dado que é inerte p/ operação assistida
   e a blindagem é Caso-2-only?
3. OK a anotação de gate vir só de interpretador+propostas (sem `regras-auto-acao`)?
