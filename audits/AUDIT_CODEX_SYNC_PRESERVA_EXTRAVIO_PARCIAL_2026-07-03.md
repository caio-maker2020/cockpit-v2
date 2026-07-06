# Auditoria Codex — Hotfix isolado: `sync-bastao` preserva `agent_state.extravio_parcial`

Data: 2026-07-03 · Status: **PREPARADO, NÃO DEPLOYADO** · Aguarda auditoria Codex + OK explícito do Caio.

## Objetivo único
Fazer o `sync-bastao` **parar de apagar** `agent_state.extravio_parcial` (o dossiê que o interpretador
popula). É só preservação de chave em `agent_state` — nada mais.

## Restrições respeitadas (Caio)
- Base = **ref limpo `74d7d1258079764ed44a14825e797c4b29570fdc`** (branch `hotfix/oc19-template-entregue`,
  que já tem o hotfix oc19 e está no ar). **Não** usei o working tree sujo.
- **Não** trouxe refactor de reabertura. **Não** mexi em regra de oc19, executor, interpretador,
  agente-sugere, agente-ressarcimento, flags, state, lock, todo.
- O módulo do dossiê (`extravio-parcial-dossie.ts`) **não existe** no ref limpo → **não** trouxe o módulo
  sujo; criei um **helper mínimo puro** (`preservar-extravio-parcial.ts`).

## Problema confirmado (por que existe)
- **Fato:** dos 17 cards que tiveram dossiê, só 9 sobrevivem — **8 sumiram**; 5 (175383, 6768, 28779,
  1119469, 156761) atualizados 19:29–19:32, após o deploy do `sync-bastao` HEAD (19:19). 28779/1119469
  *tinham* dossiê.
- **Confirmação de código:** o `sync-bastao` deployado (HEAD) tem **0** menções a `extravio_parcial` e
  reconstrói `agent_state` de snapshots frescos do Bastão que não incluem a chave → apaga o dossiê.

## Mudança (arquivos)
### NOVO — `supabase/functions/_shared/preservar-extravio-parcial.ts` (helper puro, mínimo)
```ts
function temExtravioParcial(state: Record<string, unknown> | null | undefined): boolean {
  const v = state?.["extravio_parcial"];
  return v != null && typeof v === "object";
}
export function preservarExtravioParcial(
  snapshot: Record<string, unknown>,
  existingAgentState: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (temExtravioParcial(snapshot)) return snapshot;                 // novo já tem → mantém o novo
  if (!temExtravioParcial(existingAgentState)) return snapshot;      // existente não tem → não muda
  return { ...snapshot, extravio_parcial: (existingAgentState as Record<string, unknown>)["extravio_parcial"] };
}
```
Não classifica caso, não avalia dossiê, não toca gate/oc33/state/lock/todo. Puro (não muta argumentos).

### ALTERADO — `supabase/functions/sync-bastao/index.ts` (+19 / −5)
Preserva a chave nos **2 sites que reconstroem `agent_state` de snapshot fresco** (os que dropavam):
- **`upsertCardFromPendencia`** (~l.2192, `agentStateNovo`) — **caminho relacionamento, o wipe CONFIRMADO**
  (AGUARDANDO_CLIENTE/AVH). Mesmo padrão da preservação de `chave_cte`/`propostas_recusadas` (INV-004).
- **`handleExtravioPendencia`** (~l.1135, `agentStateFinal`) — caminho extravio (borda: card com dossiê
  re-reportado como extravio). No-op para extravio comum.
- **Não** tocados: sites de INSERT (card novo, sem dossiê — l.1162/2592) e o site que já faz spread
  `...existingAgent` (l.1391, já preserva).

Diff verbatim do sync-bastao:
```diff
+import { preservarExtravioParcial } from "../_shared/preservar-extravio-parcial.ts";
@@ handleExtravioPendencia @@
-  const agentStateFinal: Record<string, unknown> = chaveExistente
+  const agentStateBaseExtravio: Record<string, unknown> = chaveExistente
     ? { ...snapshot, chave_cte: chaveExistente }
     : snapshot;
+  const agentStateFinal = preservarExtravioParcial(
+    agentStateBaseExtravio,
+    existing?.agent_state as Record<string, unknown> | undefined,
+  );
@@ upsertCardFromPendencia @@
-    const agentStateNovo: Record<string, unknown> = { ...novoSnapshot };
-    if (chaveCtePreservada) agentStateNovo["chave_cte"] = chaveCtePreservada;
-    if (...) agentStateNovo["propostas_recusadas_em"] = propostasRecusadasEm;
-    if (...) agentStateNovo["propostas_recusadas_para_oc"] = propostasRecusadasParaOc;
+    const agentStateBase: Record<string, unknown> = { ...novoSnapshot };
+    if (chaveCtePreservada) agentStateBase["chave_cte"] = chaveCtePreservada;
+    if (...) agentStateBase["propostas_recusadas_em"] = propostasRecusadasEm;
+    if (...) agentStateBase["propostas_recusadas_para_oc"] = propostasRecusadasParaOc;
+    const agentStateNovo = preservarExtravioParcial(agentStateBase, agentStateExistente);
```
(`agentStateNovo`/`agentStateFinal` seguem sendo as variáveis finais usadas no `agent_state:` do UPDATE — os
sites de escrita não mudaram.)

## Gates (todos verdes)
1. **worktree:** `/Users/caiodevasconcelos/hotfix-sync-preserva` · **branch:** `hotfix/sync-preserva-extravio-parcial` (base `74d7d12`).
2. **`git diff --stat HEAD`:** `sync-bastao/index.ts` (+19/−5) + 2 untracked (`preservar-extravio-parcial.ts` + `.test.ts`).
3. **Diff NÃO contém** `DecisaoReaberturaDetalhada` / `decidirReaberturaPorOrdemSsw` /
   `passDDevePreservarBannerIaSugestao` / `ultimoLancamentoCockpitInfo` → **0 cada**.
4. **Import novo no sync-bastao** = SÓ `preservar-extravio-parcial` (nenhum de reabertura).
5. **Teste do helper puro:** `preservar-extravio-parcial.test.ts` → **7/7 passed**; `deno check` do módulo → limpo.
6. **`deno check sync-bastao`:** **16 erros = baseline** (fricção de tipo pré-existente SupabaseClient/fotoPath);
   **TS2305/TS2724 = 0**; **0 erros citam o código novo** → hotfix não adiciona erro.
7. **Diff completo** exibido (acima).
8. **PARADO** — sem deploy até OK explícito.

## Critério de aceite (mapeado)
- ✅ Card com `agent_state.extravio_parcial` antes do sync **continua** com ele depois (helper copia a chave nos
  UPDATE de snapshot fresco). Testes 1–7 do helper cobrem: copia / mantém-o-novo / não-cria / null / não-objeto / puro / referência.
- ✅ Não cria todo, não muda state, não muda lock, não muda regra de ação (diff só toca a construção de `agent_state`).
- ✅ É só preservação de chave em `agent_state`.

## Perguntas para o Codex
1. A preservação nos 2 sites (`upsertCardFromPendencia` + `handleExtravioPendencia`) cobre **todos** os pontos
   onde o `sync-bastao` reconstrói `agent_state` de snapshot fresco? (INSERTs e o spread `...existingAgent` foram
   deixados de fora corretamente?)
2. A semântica "novo vence" (se o snapshot já tem `extravio_parcial`, mantém o novo) é a desejada? No `sync-bastao`
   o snapshot fresco nunca tem a chave, então na prática sempre cai no ramo "copia do existente" — OK?
3. Algum risco de o helper mascarar um caso legítimo de "limpar o dossiê" (ex.: card terminal / reset)? Hoje
   nenhum caminho seta `extravio_parcial=null` de propósito; confirmar.
4. INV-004: OK tratar `extravio_parcial` como mais uma chave preservada (par de `chave_cte`)?

## Não deployado
Nada foi para produção. Deploy (só `sync-bastao`, deste worktree, via gate + OK) fica para depois da auditoria.
```
supabase functions deploy sync-bastao --project-ref xjbycvscljqoqpjkmevb   # SÓ após aprovação
```
