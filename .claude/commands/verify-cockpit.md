---
description: Verificação completa pós-fix/feature no Cockpit v2 — checklist obrigatório antes de commit/deploy
---

# /verify-cockpit — Verificação Holística

Roda em sequência (não pula etapas, não termina cedo). Reporta cada fase como PASS/FAIL e produz um VERIFICATION REPORT no final.

## Fase 1 — Type check Deno das edge functions tocadas

```bash
# Pega arquivos modificados no working tree + último commit
cd "/Users/caiodevasconcelos/Documents/:code:cockpit-v2 /cockpit-v2-starter"
ARQUIVOS_TS=$(git diff --name-only HEAD~1 HEAD 2>/dev/null; git status --porcelain | awk '{print $2}') 
echo "$ARQUIVOS_TS" | grep -E 'supabase/functions/.*\.ts$' | sort -u | while read f; do
  echo "--- deno check $f ---"
  deno check "$f" 2>&1 | tail -10
done
```

Status: PASS se nenhum erro `error:` no output. FAIL se houver.

## Fase 2 — Cobertura de passes (regra crítica do Cockpit)

Quando o diff toca `sync-bastao/index.ts` OU `_shared/regras-auto-acao.ts` OU `_shared/bastao-rules.ts`:

```bash
# Confirma que TODOS os passes que mexem em state respeitam ACAO_EXECUTADA
grep -nE "ACAO_EXECUTADA|state.*=|releaseCard|update.*state" "supabase/functions/sync-bastao/index.ts" | head -40
```

Validar manualmente:
- Pass A: tem guarda `state === "ACAO_EXECUTADA"`? ✓/✗
- Pass A `voltouParaRelacionamento`: respeita janela `acao_executada_em` 60min? ✓/✗
- Pass B: filtra ACAO_EXECUTADA no SELECT? ✓/✗
- Pass B: early skip defensivo no loop? ✓/✗
- Pass C: não muda state (só `todos.status`)? ✓/✗
- Pass D: só mexe em `aviso_alteracao_oc`? ✓/✗
- Pass E: filtra state=AGUARDANDO_CLIENTE? ✓/✗
- Pass F: chave_cte resolver, não muda state? ✓/✗
- Pass G: opera só em state=ACAO_EXECUTADA, janela 30min "bastao_avancou"? ✓/✗
- atualizar-card-via-portal-ssw: ação manual deliberada? ✓/✗

Status: PASS se 10/10. FAIL se algum não-coberto.

## Fase 3 — Supabase Security Advisors

```bash
TOKEN="${SUPABASE_ACCESS_TOKEN:?defina SUPABASE_ACCESS_TOKEN no env}"
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.supabase.com/v1/projects/xjbycvscljqoqpjkmevb/advisors/security" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
lints = data.get('lints', [])
from collections import Counter
by_level = Counter(l['level'] for l in lints)
errors = [l for l in lints if l['level']=='ERROR']
print(f'Total: {len(lints)} | {dict(by_level)}')
if errors:
    print(f'NOVOS ERRORs ({len(errors)}):')
    for l in errors:
        print(f\"  - {l['name']}: {l['detail'][:100]}\")
else:
    print('0 ERRORs (baseline ok)')
"
```

Status: PASS se ERROR count = 0. FAIL se aumentou.

## Fase 4 — Retroativo aplicado (se fix tocou regra de produção)

Se o fix corrigiu bug que pode ter afetado cards já existentes:

1. Listar NFs afetadas (com query SQL específica do bug).
2. Confirmar que cada NF está em estado esperado pós-fix.
3. Confirmar evento `Retroativo*` registrado em `card_events`.

Status: PASS se aplicado. N/A se fix foi "só pra frente". FAIL se devia retroativo e não foi feito.

## Fase 5 — Memory updated

```bash
ls -lt /Users/caiodevasconcelos/.claude/projects/-Users-caiodevasconcelos-Documents--code-cockpit-v2-/memory/ | head -5
```

Pergunta-se:
- Bug significativo → memory file `project_*.md` criada?
- Comportamento sistêmico → memory `feedback_*.md` criada?
- MEMORY.md tem entry apontando pro novo memory file?

Status: PASS se sim. FAIL se fix foi merecedor e memory não veio.

## Fase 6 — Diff sanity

```bash
git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat
```

Pergunta-se:
- Só os arquivos esperados foram tocados?
- Algum arquivo .env / .secrets / token foi commitado por engano?
- LOC adicionada razoável pro escopo?

Status: PASS se sim.

## Fase 7 — Deploy state

```bash
# Lista edge functions deployadas mais recentes
TOKEN="${SUPABASE_ACCESS_TOKEN:?defina SUPABASE_ACCESS_TOKEN no env}"
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.supabase.com/v1/projects/xjbycvscljqoqpjkmevb/functions" \
  | python3 -c "
import sys, json
fns = json.load(sys.stdin)
recent = sorted(fns, key=lambda f: f.get('updated_at',''), reverse=True)[:5]
for f in recent:
    print(f\"  {f['slug']:40s} updated_at={f.get('updated_at','?')[:19]}  v={f.get('version','?')}\")
"
```

Status: PASS se edge functions afetadas pelo diff foram redeployadas (versão recente).

## Fase 8 — Invariantes Automatizados

**Quando rodar:** SEMPRE (mesmo que o diff não toque arquivos críticos — invariantes podem quebrar por mudança em código relacionado).

**Fonte canônica:** `docs/INVARIANTES_COCKPIT.md` — catálogo de INVs com comando de verificação cada.

Rodar o bloco abaixo e marcar PASS/FAIL por INV. Inclui o resultado consolidado no VERIFICATION REPORT.

```bash
cd "/Users/caiodevasconcelos/Documents/:code:cockpit-v2 /cockpit-v2-starter"
set -a; source .env.local; set +a
PSQL="/opt/homebrew/opt/libpq/bin/psql"

echo "=== Fase 8 — Invariantes Automatizados ==="

# INV-001: Sem novos callers do tracking público
COUNT=$(grep -RIn 'from.*"\.\..*ssw-tracking-client' supabase/functions/ 2>/dev/null \
  | grep -v "@deprecated\|//\|_shared/ssw-tracking-client.ts" | wc -l | tr -d ' ')
[ "$COUNT" -eq 0 ] && echo "INV-001: PASS" || echo "INV-001: FAIL ($COUNT callers ativos do tracking público)"

# INV-002: confirmar-acao-executada-ssw preserva snapshot Bastão
HITS=$(grep -E "bastao_oc_no_lancamento:\s*null|bastao_updated_at_no_lancamento:\s*null" \
  supabase/functions/_shared/confirmar-acao-executada-ssw.ts 2>/dev/null | wc -l | tr -d ' ')
[ "$HITS" -eq 0 ] && echo "INV-002: PASS" || echo "INV-002: FAIL (campos sendo limpos — bug NF 1075381 voltou)"

# INV-003 (reformulada 2026-05-14): Pass A guard por oc do lançamento + SELECT carrega snapshot
HITS=$(grep -c "bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts 2>/dev/null)
SELECT_OK=$(grep -E '\.select\([^)]*bastao_oc_no_lancamento' supabase/functions/sync-bastao/index.ts | wc -l | tr -d ' ')
DISCR_OK=$(grep -A 4 "const bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts | grep -c "p.cod_ultima_ocorrencia === bastaoOcNoLancamento")
if [ "$HITS" -ge 2 ] && [ "$SELECT_OK" -ge 1 ] && [ "$DISCR_OK" -ge 1 ]; then
  echo "INV-003: PASS"
else
  echo "INV-003: FAIL (guard=$HITS, SELECT=$SELECT_OK, discriminador_oc=$DISCR_OK)"
fi
# INV-003b: cards travados em loop ≤ 0
LOOP_COUNT=$(/opt/homebrew/Cellar/libpq/18.3/bin/psql "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and bastao_oc_no_lancamento is not null and cod_ultima_ocorrencia = bastao_oc_no_lancamento and acao_executada_em is null and bastao_synced_at > now() - interval '1 hour';" 2>/dev/null | tr -d ' ')
[ "$LOOP_COUNT" = "0" ] && echo "INV-003b: PASS" || echo "INV-003b: FAIL ($LOOP_COUNT cards em loop)"

# INV-004: Pass A preserva chaves críticas no agent_state
KEYS=$(grep -A 25 'agentStateExistente = ' supabase/functions/sync-bastao/index.ts \
  | grep -cE "chave_cte|propostas_recusadas_em|propostas_recusadas_para_oc|bastao_updated_at")
[ "$KEYS" -ge 4 ] && echo "INV-004: PASS" || echo "INV-004: FAIL (faltam preservações: encontradas $KEYS de 4)"

# INV-005: voltar-para-to-do-com-rastreio usa SSW interno
TEM_INTERNO=$(grep -c "buscarNFInterno" supabase/functions/voltar-para-to-do-com-rastreio/index.ts)
TEM_PUBLICO=$(grep -c "createSswTrackingClient" supabase/functions/voltar-para-to-do-com-rastreio/index.ts)
if [ "$TEM_INTERNO" -ge 1 ] && [ "$TEM_PUBLICO" -eq 0 ]; then
  echo "INV-005: PASS"
else
  echo "INV-005: FAIL (interno=$TEM_INTERNO, público=$TEM_PUBLICO)"
fi

# INV-006: oc=54 ⟺ AGUARDANDO_CLIENTE (SQL read-only contra produção)
VIOLAC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where cod_ultima_ocorrencia=54 and state != 'AGUARDANDO_CLIENTE' and cliente_respondeu_em is null and state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO');" 2>/dev/null)
[ "$VIOLAC" = "0" ] && echo "INV-006: PASS" || echo "INV-006: FAIL ($VIOLAC cards oc=54 em state errado)"

# INV-007: Pass B blindado contra ACAO_EXECUTADA
FILTRO=$(grep -A 5 'from("cards")' supabase/functions/sync-bastao/index.ts \
  | grep -c "RESOLVIDO,CANCELADO,TRANSFERIDO,TRATATIVA_PENDENTE,ACAO_EXECUTADA")
# Aceita formas usadas no código: ["state"] === "ACAO_EXECUTADA" e variantes
SKIP=$(grep -cE '\["state"\][[:space:]]*===[[:space:]]*"ACAO_EXECUTADA"' supabase/functions/sync-bastao/index.ts)
if [ "$FILTRO" -ge 1 ] && [ "$SKIP" -ge 1 ]; then
  echo "INV-007: PASS"
else
  echo "INV-007: FAIL (filtro=$FILTRO, early-skip=$SKIP)"
fi

# INV-008: stateFinalAposBastao é fonte única (info — baseline)
DUPLI=$(grep -RIn 'state.*=.*"\(TRANSFERIDO\|RESOLVIDO\|AGUARDANDO_CLIENTE\|AGUARDANDO_VALIDACAO_HUMANA\)"' supabase/functions/ 2>/dev/null \
  | grep -v "stateFinalAposBastao\|stateFinal\.state\|_shared/bastao-rules.ts\|//\|test\|describe\|TodoVoltadoParaToDo\|state_anterior" | wc -l | tr -d ' ')
echo "INV-008: INFO ($DUPLI atribuições literais oc→state fora do helper — baseline; subir muito = revisar)"

# INV-009: edge functions internas com verify_jwt=false
# Array (não string) — word splitting em variável string falha em alguns shells.
INTERNAS=(triador vinculador executor redator redator-email-saida sync-bastao audit-invariante cron-ia-resposta-pendentes gmail-poll-inbox processar-acoes-agendadas ingestor interpretador-resposta-cliente)
FALTANDO=""
for f in "${INTERNAS[@]}"; do
  # -F (fixed string) evita problemas de escape de '[' e '.' em shells diferentes
  if ! grep -A1 -F "[functions.$f]" supabase/config.toml 2>/dev/null | grep -q "verify_jwt = false"; then
    FALTANDO="$FALTANDO $f"
  fi
done
[ -z "$FALTANDO" ] && echo "INV-009: PASS" || echo "INV-009: FAIL (falta verify_jwt=false em:$FALTANDO)"

# INV-011: callers de temEvidenciaParaOc/verificarEvidenciaESinalizar passam ctrcEsperado
# (1) helper aceita ctrcEsperado (assinatura + propagação interna)
ASSINATURA=$(grep -c "ctrcEsperado" supabase/functions/_shared/verificar-evidencia.ts)
# (2) callers diretos do temEvidenciaParaOc (executor + revalidar-evidencia-card)
DIRECT_CALLS=$(grep -E "^[[:space:]]*await temEvidenciaParaOc\(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | wc -l | tr -d ' ')
DIRECT_COM_CTRC=$(grep -A 2 "await temEvidenciaParaOc(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | grep -cE "ctrcCard|ctrc.*\?\?\s*null")
# (3) callers de verificarEvidenciaESinalizar passando 6 args (com ctrc, ou null explícito)
INDIRECT_COM_CTRC=$(grep -B1 -A6 "verificarEvidenciaESinalizar(" supabase/functions/sync-bastao/index.ts supabase/functions/vinculador/index.ts 2>/dev/null | grep -cE "p\.ctrc[[:space:]]*\?\?[[:space:]]*null|, null\)\;")
if [ "$ASSINATURA" -ge 3 ] && [ "$DIRECT_CALLS" -ge 1 ] && [ "$DIRECT_COM_CTRC" -ge "$DIRECT_CALLS" ] && [ "$INDIRECT_COM_CTRC" -ge 3 ]; then
  echo "INV-011: PASS"
else
  echo "INV-011: FAIL (assinatura=$ASSINATURA, direct=$DIRECT_CALLS/$DIRECT_COM_CTRC com ctrc, indirect=$INDIRECT_COM_CTRC)"
fi

# INV-010: 54 em OCORRENCIAS_DE_RELACIONAMENTO
TEM_54_LIB=$(grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" lib/bastao-rules.ts | grep -E "\b54\b" | wc -l | tr -d ' ')
TEM_54_SHARED=$(grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" supabase/functions/_shared/bastao-rules.ts | grep -E "\b54\b" | wc -l | tr -d ' ')
if [ "$TEM_54_LIB" -ge 1 ] && [ "$TEM_54_SHARED" -ge 1 ]; then
  echo "INV-010: PASS"
else
  echo "INV-010: FAIL (lib=$TEM_54_LIB, shared=$TEM_54_SHARED — bug 2026-05-12 voltou)"
fi

echo "=== Fim Fase 8 ==="
```

**Status:** PASS = todos os INVs com PASS (INFO não bloqueia). FAIL = pelo menos 1 INV falhou; **bloqueia commit** até resolver.

**Quando um INV nunca-falhou aparece como FAIL pela 1ª vez:**
1. Investigar o caso real (bug introduzido ou apenas mudança benigna que o regex não acompanhou).
2. Se bug real → fix + retroativo + post-mortem.
3. Se regex está obsoleto → ajustar `docs/INVARIANTES_COCKPIT.md` (atualizar comando de verificação) E re-rodar.

**Quando criar novo INV:** todo bug post-mortem que cruza ≥ 2 arquivos críticos vira `INV-NNN` novo no catálogo. Atualizar também o lookup em `.claude/hooks/cockpit-critical-files.py`.

## Output final — VERIFICATION REPORT

Reúne tudo no formato:

```
VERIFICATION COCKPIT — <data/hora>
==================================
Tipo (Deno):    [PASS/FAIL]  (N arquivos checados, M erros)
Passes:         [PASS/FAIL]  (N/10 cobertos) [só se mexeu em sync-bastao/regras]
Advisors:       [PASS/FAIL]  (ERROR: X, WARN: Y)
Retroativo:     [PASS/N/A]   (NFs: ...)
Memory:         [PASS/FAIL]
Diff:           [PASS]       (X arquivos, +A -B LOC)
Deploy:         [PASS/PENDING] (funções recentes: ...)
Invariantes:    [PASS/FAIL]  (INVs falhando: INV-XXX, INV-YYY)  [Fase 8]

Overall:        [READY/NOT READY]

Issues a resolver:
1. ...
2. ...

Próximos passos sugeridos:
- ...
```

## Regras de execução

- **Não pular nenhuma fase**. Mesmo se Fase 1 falhar, rodar 2-7 e reportar tudo no final.
- **Não auto-corrigir** durante a verificação. Só reportar. Correção é decisão do Caio.
- **Não invocar outras skills automaticamente** — verification-loop é o último passo, não o primeiro.
- Se uma fase não se aplica (ex: não mexeu em SQL → Fase 3 advisors pode pular o "novos ERRORs"), marcar N/A e justificar.
