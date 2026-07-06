# Fase 2 — Resultado do deploy controlado (2026-06-29)

**Status: ✅ FASE 2 FINALIZADA EM PRODUÇÃO.** Deploy controlado da normalização de segmento no
`operador-resolver.ts` via release limpa (Opção D), sem levar WIP de outras frentes.

## Método (Opção D)
Release limpa em **worktree separado** a partir do HEAD `654fa36` (branch `release/fase2-resolver-segmento`),
aplicando **só o patch da Fase 2**. NÃO deployado a partir do working tree principal (sujo).

## Arquivos incluídos na release (commit `aaf0398`)
- `supabase/functions/_shared/operador-resolver.ts` (+45/−5 — helper `normalizarCodigoSegmento` + Path 3)
- `supabase/functions/_shared/operador-resolver.test.ts` (12 testes)
- `audits/FASE2_RESOLVER_SEGMENTO_2026-06-27.md`, `audits/FASE2_PLANO_DEPLOY_2026-06-27.md`
- **Fora (confirmado SEM diff no worktree):** `extravio-enrichment.ts`, `regras-auto-acao.ts`, `scan-email-enqueue.ts` (WIP de outras frentes ficou no HEAD). `criar-card-manual` NÃO deployada (untracked/fora de escopo).

## Comandos executados (resumo)
```bash
# pré-flight: confirmado CLI logado e projeto Cockpit-V2 (xjbycvscljqoqpjkmevb) linked:true (== .env.local)
git worktree add -b release/fase2-resolver-segmento /Users/caiodevasconcelos/cockpit-v2-fase2-release 654fa36
git diff HEAD -- .../operador-resolver.ts > /tmp/fase2-resolver.patch && git -C "$REL" apply /tmp/fase2-resolver.patch
cp .../operador-resolver.test.ts "$REL/..."; cp .../audits/FASE2_*.md "$REL/audits/"
# isolamento OK: status só Fase 2; diff HEAD dos 3 WIP = vazio
deno test .../operador-resolver.test.ts           # 12 passed
deno check .../operador-resolver.ts .../*.test.ts # exit 0
# deploy (token via .env.local, --project-ref explícito), do worktree:
supabase functions deploy sync-prioridades-ai-do-bastao --project-ref xjbycvscljqoqpjkmevb
supabase functions deploy vinculador               --project-ref xjbycvscljqoqpjkmevb
supabase functions deploy sync-bastao              --project-ref xjbycvscljqoqpjkmevb
git -C "$REL" add <4 arquivos> && git commit   # aaf0398 (escopado, sem git add .)
git worktree remove "$REL"
```
> Nota: a 1ª tentativa de deploy falhou (`Access token not provided`) porque o comando não tinha
> `SUPABASE_ACCESS_TOKEN` no env — **nada foi deployado nessa tentativa** (falha total, sem estado
> parcial). Resolvido sourçando `.env.local` antes do deploy.

## Funções deployadas (nesta ordem, no projeto `xjbycvscljqoqpjkmevb` / Cockpit-V2)
1. ✅ `sync-prioridades-ai-do-bastao`
2. ✅ `vinculador`
3. ✅ `sync-bastao`
(Log confirmou bundle do `_shared` na versão do HEAD — ex.: `scan-email-enqueue.ts` sem o WIP.)

## Resultado dos testes
`deno test` → **12 passed / 0 failed**. `deno check` → **exit 0**.

## Baseline (antes) × Resultado (depois do 1º sync)
| Métrica | Antes | Depois |
|---|---:|---:|
| total ativos | 900 | 899¹ |
| **invisível p/ operador comum** | 1 | **1** (não subiu) |
| **sem-dono** | 1 | **1** (não subiu) |
| **dono-errado** | 0 | **0** |
| **dono-inativo** | 0 | **0** |
| **CNPJ em 2+ carteiras** | 0 | **0** |

¹ −1 = churn normal do sync (1 card finalizado/transferido), não efeito da Fase 2.

## Houve reatribuição?
**Não houve reatribuição em massa indevida.** 1º sync: `created:0`, `updated:97` (churn normal de
oc/data/`bastao_synced_at`), `errors:[]`. Eventos de troca de dono nos últimos 10 min:
`CardReatribuido/OperadorReatribuido/AssignedOperador.../CardDesatribuido` = **0**.
`dono-errado=0` confirma que **nenhuma regra por carteira/nome foi sobrescrita por segmento**.
Coerente com a simulação pré-deploy (0 ganhos por segmento / 0 mudanças — a Fase 1 já resolvera os
órfãos por dados; a Fase 2 é **preventiva** para cards futuros).

## Rollback
**Não foi necessário** (nenhuma métrica piorou). Plano, se preciso: restaurar `operador-resolver.ts`
anterior (HEAD `654fa36`) e redeployar as mesmas 3 funções do mesmo worktree.

## Riscos residuais
- **Preventivo, não retroativo:** o efeito (atribuir por segmento) só aparece em cards FUTUROS sem
  carteira/nome. Sinal a observar nos próximos dias: 1º card 043 novo sem carteira deve nascer com
  dono (ISA E KAROL) em vez de órfão. Re-rodar `audits/audit-card-routing.sql` periodicamente.
- **Fonte deployada não está em `master`:** o código vive na branch `release/fase2-resolver-segmento`
  (commit `aaf0398`) e no working tree principal (não-commitado). Recomendo merge/cherry-pick escopado
  para `master` quando o working tree for organizado (fora do escopo desta tarefa).
- `segmento_codigo` (coluna RLS) continua não gravado pelo sync — isso é **Fase 3** ([R2]), NÃO iniciada.

## Confirmação
**Fase 2 está FINALIZADA em produção.** Não se mexeu em RLS, trigger, dados (SQL de escrita),
backfill, nem em `criar-card-manual`. Não se avançou para Fase 3.
