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

# Guards unitários de regras-auto-acao (romaneio interno + gêmeo "54 sem email")
deno test supabase/functions/_shared/regras-auto-acao.romaneio.test.ts \
          supabase/functions/_shared/regras-auto-acao.sem-email-54.test.ts --allow-env 2>&1 | tail -8
```

Status dos guards: PASS se ambos os arquivos de teste = `ok | N passed | 0 failed`. O
`sem-email-54` trava a regressão da opção "lançar só oc 54 sem email" (gêmeo
`meta.sem_email_explicito` ao lado da 54+email; idempotente; fallback sem_email não duplica).

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
# INV-003b: cards travados em loop ≤ 0 (check SQL — precisa de DB)
LOOP_COUNT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and bastao_oc_no_lancamento is not null and cod_ultima_ocorrencia = bastao_oc_no_lancamento and acao_executada_em is null and bastao_synced_at > now() - interval '1 hour';" 2>/dev/null | tr -d ' ')
if [ -z "$LOOP_COUNT" ]; then
  echo "INV-003b: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$LOOP_COUNT" = "0" ]; then
  echo "INV-003b: PASS"
else
  echo "INV-003b: FAIL ($LOOP_COUNT cards em loop)"
fi

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
VIOLAC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where cod_ultima_ocorrencia=54 and state != 'AGUARDANDO_CLIENTE' and cliente_respondeu_em is null and state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO');" 2>/dev/null | tr -d ' ')
if [ -z "$VIOLAC" ]; then
  echo "INV-006: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$VIOLAC" = "0" ]; then
  echo "INV-006: PASS"
else
  echo "INV-006: FAIL ($VIOLAC cards oc=54 em state errado)"
fi

# INV-007: Pass B blindado contra ACAO_EXECUTADA
# Busca direta pelo .not("state","in",...ACAO_EXECUTADA...) — robusta a comentários
# entre from("cards") e o filtro (ADR 0005 inseriu comentários e quebrou o -A 5).
FILTRO=$(grep -cE '\.not\("state",[[:space:]]*"in",.*ACAO_EXECUTADA' supabase/functions/sync-bastao/index.ts)
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
# Sem âncora ^await: as chamadas são `const x = await temEvidenciaParaOc(`.
DIRECT_CALLS=$(grep -E "await temEvidenciaParaOc\(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | wc -l | tr -d ' ')
DIRECT_COM_CTRC=$(grep -A 2 "await temEvidenciaParaOc(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | grep -cE "ctrcCard|ctrc.*\?\?\s*null")
# (3) callers de verificarEvidenciaESinalizar passando 6 args (com ctrc, ou null explícito)
INDIRECT_COM_CTRC=$(grep -B1 -A6 "verificarEvidenciaESinalizar(" supabase/functions/sync-bastao/index.ts supabase/functions/vinculador/index.ts 2>/dev/null | grep -cE "p\.ctrc[[:space:]]*\?\?[[:space:]]*null|, null\)\;")
if [ "$ASSINATURA" -ge 3 ] && [ "$DIRECT_CALLS" -ge 1 ] && [ "$DIRECT_COM_CTRC" -ge "$DIRECT_CALLS" ] && [ "$INDIRECT_COM_CTRC" -ge 3 ]; then
  echo "INV-011: PASS"
else
  echo "INV-011: FAIL (assinatura=$ASSINATURA, direct=$DIRECT_CALLS/$DIRECT_COM_CTRC com ctrc, indirect=$INDIRECT_COM_CTRC)"
fi

# INV-010: 54 em OCORRENCIAS_DE_RELACIONAMENTO
# lib/ ainda é Set literal hardcoded → grep no Set. shared/ virou carga dinâmica
# do dicionário (2026-06-16) e força 54 via `set.add(54)` independente da planilha.
TEM_54_LIB=$(grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" lib/bastao-rules.ts | grep -E "\b54\b" | wc -l | tr -d ' ')
TEM_54_SHARED=$(grep -cE "set\.add\(54\)" supabase/functions/_shared/bastao-rules.ts)
if [ "$TEM_54_LIB" -ge 1 ] && [ "$TEM_54_SHARED" -ge 1 ]; then
  echo "INV-010: PASS"
else
  echo "INV-010: FAIL (lib=$TEM_54_LIB, shared=$TEM_54_SHARED — bug 2026-05-12 voltou)"
fi

# INV-012: consumidores de evidência usam obterTodasFotosDaOc; obterFotoDaOc só na galeria
# (foto-oc-card, r-evidencia). Qualquer outro 'await obterFotoDaOc(' = puxa só a 1ª foto.
VIOL_FOTO=$(grep -RIn "await obterFotoDaOc(" supabase/functions/ 2>/dev/null \
  | grep -vE "foto-oc-card/index\.ts|r-evidencia/index\.ts" | wc -l | tr -d ' ')
if [ "$VIOL_FOTO" -eq 0 ]; then
  echo "INV-012: PASS"
else
  echo "INV-012: FAIL ($VIOL_FOTO caller(s) de obterFotoDaOc fora da galeria — usar obterTodasFotosDaOc; bug NF 355283)"
  grep -RIn "await obterFotoDaOc(" supabase/functions/ 2>/dev/null | grep -vE "foto-oc-card/index\.ts|r-evidencia/index\.ts"
fi

# INV-013: lançamento de oc no SSW SEMPRE via readSswLancamentoEnv (conta ai.salex).
# Nenhuma sessão de submit pode vir de readSswInternalEnv (executor) nem de
# loadSswInternalEnvForCard (envelope). bug NF 651244: oc=33 saiu como Larissa.
INV13_EXEC=$(grep -c "readSswInternalEnv(Deno.env.toObject())" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV13_ENV=$(grep -c "loadSswInternalEnvForCard(" supabase/functions/_shared/lancar-ssw-portal.ts 2>/dev/null | tr -d ' ')
if [ "$INV13_EXEC" -eq 0 ] && [ "$INV13_ENV" -eq 0 ]; then
  echo "INV-013: PASS"
else
  echo "INV-013: FAIL (executor=$INV13_EXEC readSswInternalEnv, envelope=$INV13_ENV loadSswInternalEnvForCard — lançamento deve usar readSswLancamentoEnv; bug NF 651244)"
fi

# INV-015: limite de anexos por card NÃO conta origem='inbound'
# bug NF 719250: card com 29 inbound (assinaturas/logos inline) bloqueava upload
# de TODO JPEG convertido do PDF → front "Falha ao converter PDF → JPEG".
INV15_FILTRO=$(grep -c '\.neq("origem", "inbound")' supabase/functions/_shared/limite-anexos.ts 2>/dev/null | tr -d ' ')
INV15_USA=$(grep -c "queryAnexosQueContamProLimite" supabase/functions/upload-anexo-email/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV15_FILTRO" -ge 1 ] && [ "$INV15_USA" -ge 1 ]; then
  echo "INV-015: PASS"
else
  echo "INV-015: FAIL (filtro inbound=$INV15_FILTRO, uso na edge=$INV15_USA — limite voltou a contar inbound; bug NF 719250)"
fi

# INV-018: RLS de cards/todos avalia contexto do operador 1x/query (InitPlan), não 1x/linha.
# Causa-raiz do apagão 2026-06-23: as policies chamavam card_visivel_pelo_operador_atual(...)
# POR LINHA (todos = 58% da CPU, board 40s). Mig 242 inlinou com (SELECT current_operador_*()).
# Regressão = alguma policy de cards/todos voltar a chamar a função no qual/with_check.
INV18_PERROW=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_policies where tablename in ('cards','todos') and (coalesce(qual,'')||coalesce(with_check,'')) like '%card_visivel_pelo_operador_atual%';" 2>/dev/null | tr -d ' ')
INV18_CACHED=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_policies where tablename='cards' and qual like '%current_operador_id%';" 2>/dev/null | tr -d ' ')
if [ -z "$INV18_PERROW" ]; then
  echo "INV-018: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$INV18_PERROW" = "0" ] && [ "$INV18_CACHED" -ge 1 ]; then
  echo "INV-018: PASS"
else
  echo "INV-018: FAIL (per-row=$INV18_PERROW policies chamam card_visivel_pelo_operador_atual; cached=$INV18_CACHED — RLS per-row do apagão 2026-06-23 voltou; ver mig 242)"
fi

# INV-017: aba EXTRAVIOS — card só fica enquanto oc∈{6,9,16}; saída pela verdade do
# Bastão por NF (NÃO SSW) sob gate de frescor; sumiu+fresco→RESOLVIDO.
INV17_DEC=$(grep -c "decidirDestinoExtravio" supabase/functions/_shared/reconciliar-extravios-bastao.ts 2>/dev/null | tr -d ' ')
INV17_GATE=$(grep -c "bastaoConfirmadoFresco" supabase/functions/_shared/reconciliar-extravios-bastao.ts 2>/dev/null | tr -d ' ')
INV17_FRESH=$(grep -c "fetchBastaoMaxUpdatedAt" supabase/functions/sync-extravios-bastao/index.ts 2>/dev/null | tr -d ' ')
INV17_SSW=$(grep -rl "descobrirUltimaOcSsw\|reconciliar-extravios-ssw" supabase/functions/sync-extravios-bastao/ supabase/functions/_shared/reconciliar-extravios-bastao.ts 2>/dev/null | wc -l | tr -d ' ')
if [ "$INV17_DEC" -ge 1 ] && [ "$INV17_GATE" -ge 1 ] && [ "$INV17_FRESH" -ge 1 ] && [ "$INV17_SSW" -eq 0 ]; then
  echo "INV-017 (código): PASS"
else
  echo "INV-017 (código): FAIL (decidir=$INV17_DEC gate=$INV17_GATE fresh=$INV17_FRESH ssw_no_part1=$INV17_SSW)"
fi
# INV-017b: teste do reconciliador (gate de frescor + sumiu→RESOLVIDO + roteamento).
# --no-check: a chamada a proporAutoAcaoSeAplicavel tem TS2345 latente da supabase-js
# (idêntico a atualizar-card-via-portal-ssw; deploy também não typecheca). O teste RODA.
deno test --no-check --allow-net --allow-env supabase/functions/_shared/extravio-routing.test.ts supabase/functions/_shared/reconciliar-extravios-bastao.test.ts >/dev/null 2>&1 \
  && echo "INV-017b (testes): PASS" || echo "INV-017b (testes): FAIL (deno test extravio-routing + reconciliar-extravios-bastao)"
# INV-017c: nenhum card EXTRAVIO_MONITORADO com oc fora de {6,9,16} (DB).
INV17_OCFORA=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='EXTRAVIO_MONITORADO' and coalesce(cod_ultima_ocorrencia,0) not in (6,9,16);" 2>/dev/null | tr -d ' ')
if [ -z "$INV17_OCFORA" ]; then
  echo "INV-017c: SKIP (sem acesso ao DB local)"
elif [ "$INV17_OCFORA" = "0" ]; then
  echo "INV-017c: PASS"
else
  echo "INV-017c: FAIL ($INV17_OCFORA card(s) EXTRAVIO_MONITORADO com oc fora de extravio — regra inviolável da aba violada)"
fi
# INV-017d: dias_uteis da aba EXTRAVIOS é SEMPRE inteiro (não existe "2.78 dias úteis").
# Regrediu 2x: mig 256 "reproduz mig 215" mas usou timestamp-com-hora + round(,2) →
# fração. Fonte da regra: dias_uteis_entre com AMBOS os lados ::date (midnight a midnight).
INV17_FRAC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from v_extravios_kanban where dias_uteis <> floor(dias_uteis);" 2>/dev/null | tr -d ' ')
if [ -z "$INV17_FRAC" ]; then
  echo "INV-017d: SKIP (sem acesso ao DB local)"
elif [ "$INV17_FRAC" = "0" ]; then
  echo "INV-017d: PASS"
else
  echo "INV-017d: FAIL ($INV17_FRAC card(s) com dias_uteis fracionário na v_extravios_kanban — a view voltou a usar timestamp-com-hora; ver mig 215, usar ::date dos 2 lados)"
fi

# INV-019: nenhum card AGUARDANDO_CLIENTE com oc de RELACIONAMENTO ≠54 (DB).
# AGUARDANDO_CLIENTE só pode conter oc=54. Quando a oc real vira outra oc de
# relacionamento (49/20/11/19/35/10/...), o card tem que ir pra AGUARDANDO VOCÊ
# (AVH+lock) — Pass A, ramo restaurado 2026-06-24 (NF 175621). Regressão raiz:
# Pass E desligado em 2026-06-22 deixou esse ramo órfão → 52 cards travados.
# (out-of-escopo segue em AGUARDANDO_CLIENTE + CONFLITOS via Pass B — não conta aqui.)
INV19_STUCK=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_CLIENTE' and cod_ultima_ocorrencia in (3,8,10,11,17,19,20,23,26,28,35,43,49,52);" 2>/dev/null | tr -d ' ')
# As 3 camadas TÊM que existir no código (barra remoção silenciosa de qualquer uma):
#  1) Pass A move na hora; 2) sweep auto-cura no sync-bastao; 3) watchdog no health-check (processo separado).
INV19_PASSA=$(grep -c "aguardandoClienteVirouOutraRelacionamento" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV19_SWEEP=$(grep -c "selfHealAguardandoClienteOcRelacionamento" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV19_WATCHDOG=$(grep -c "checkAguardandoClienteOcRelacionamento" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV19_PASSA" -lt 1 ] || [ "$INV19_SWEEP" -lt 2 ] || [ "$INV19_WATCHDOG" -lt 2 ]; then
  echo "INV-019 (código): FAIL (passA=$INV19_PASSA sweep=$INV19_SWEEP watchdog=$INV19_WATCHDOG — alguma das 3 camadas foi removida; PRECISA aprovação do Caio)"
else
  echo "INV-019 (código): PASS (3 camadas presentes)"
fi
if [ -z "$INV19_STUCK" ]; then
  echo "INV-019 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV19_STUCK" = "0" ]; then
  echo "INV-019 (DB): PASS"
else
  echo "INV-019 (DB): FAIL ($INV19_STUCK card(s) AGUARDANDO_CLIENTE com oc de relacionamento ≠54 travados — deveriam estar em AGUARDANDO VOCÊ; Pass A+sweep regrediram)"
fi

# INV-020: saudação de e-mail NUNCA usa o nome da empresa/marca. resolver_primeiro_nome_email
# (fonte única — preview/executor/cobranca) descarta nome_pessoa cujo 1º token é um token do
# nome da empresa do card (ACÁCIA/IBITURUNA/SINERGIA...). Bug NF 345282 "Olá Acácia," (mig 253).
INV20_FOLD=$(grep -c "_fold_accents\|é um TOKEN do nome da empresa" migration/2026-06-24_253_saudacao_nome_pessoa_nao_e_marca_da_empresa.sql 2>/dev/null | tr -d ' ')
INV20_LEAK=$($PSQL "$SUPABASE_DB_URL" -tA -c "
  with r as (
    select c.identificador, cl.nome as empresa,
           public.resolver_primeiro_nome_email(c.identificador, cl.nome) as nome
    from contatos_cliente c join clientes cl on cl.cnpj_cpf=c.documento_cliente
    where c.tipo='email' and c.nome_pessoa is not null and btrim(c.nome_pessoa)<>''
  )
  select count(*) from r
  where nome <> '' and length(public._fold_accents(nome))>=3
    and public._fold_accents(empresa) ~ ('(^|[^a-z])'||public._fold_accents(nome)||'([^a-z]|$)');" 2>/dev/null | tr -d ' ')
if [ -z "$INV20_LEAK" ]; then
  echo "INV-020: SKIP (sem acesso ao DB local — guard de código fold=$INV20_FOLD)"
elif [ "$INV20_FOLD" -ge 1 ] && [ "$INV20_LEAK" = "0" ]; then
  echo "INV-020: PASS"
else
  echo "INV-020: FAIL (fold_guard=$INV20_FOLD, contatos com marca vazando na saudação=$INV20_LEAK — bug 'Olá Acácia' NF 345282 voltou; ver mig 253)"
fi

# INV-021: recusa (oc 10/19/35) originada de extravio (6/9/16) não notificado → e-mail combinado.
# O agente-sugere-ocs-padrao detecta a sequência (detector puro em _shared/recusa-por-extravio.ts,
# testado) e troca pro template RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR + banner de conflito. O
# interpretador-resposta-cliente exige romaneio+descrição+valor antes do combo 33+44. Bug NF 148558.
INV21_CODE=$(grep -c "recusaOriginadaDeExtravioNaoNotificada" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV21_TMPL=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from templates_email where id='RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR' and ativo and corpo_template ilike '%romaneio%' and corpo_template ilike '%valor%' and (corpo_template ilike '%devolu%' and (corpo_template ilike '%nova entrega%' or corpo_template ilike '%reentrega%'));" 2>/dev/null | tr -d ' ')
INV21_TEST=$(deno test supabase/functions/_shared/recusa-por-extravio.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV21_COMPLETUDE=$(grep -c "REGRA DE COMPLETUDE" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$INV21_TMPL" ]; then
  echo "INV-021: SKIP (sem acesso ao DB local — code=$INV21_CODE test=$INV21_TEST completude=$INV21_COMPLETUDE)"
elif [ "$INV21_CODE" -ge 1 ] && [ "$INV21_TMPL" = "1" ] && [ "$INV21_TEST" = "ok" ] && [ "$INV21_COMPLETUDE" -ge 1 ]; then
  echo "INV-021: PASS"
else
  echo "INV-021: FAIL (detector=$INV21_CODE, template_completo=$INV21_TMPL, teste=$INV21_TEST, completude_interpretador=$INV21_COMPLETUDE — fluxo recusa-por-extravio NF 148558 regrediu; ver mig 254)"
fi

# INV-022: agente de extravio SÓ lança a oc 49 após pré-checagem SSW (última oc ∈ {6,9,16}).
# Regra pura podeAgenteLancar49 usada nos 2 modos; lançamento via envelope (não direto);
# reconciliador PART 1 pula nao_rodou. Bug que trava: lançar 49 em cima de oc já lançada.
INV22_REGRA=$(grep -c "podeAgenteLancar49" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_NOHAS=$(grep -c "EXTRAVIO_OCS.has" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_ENVELOPE=$(grep -c "auto_aprovar_e_executar" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_DIRETO=$(grep -c "lancarOcorrenciaPortal" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_SKIP=$(grep -c "agente_extravio_status.*nao_rodou" supabase/functions/sync-extravios-bastao/index.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/agente-extravio-regras.test.ts >/dev/null 2>&1 && INV22_TEST=ok || INV22_TEST=fail
if [ "$INV22_REGRA" -ge 2 ] && [ "$INV22_NOHAS" -eq 0 ] && [ "$INV22_ENVELOPE" -ge 1 ] && [ "$INV22_DIRETO" -eq 0 ] && [ "$INV22_SKIP" -ge 1 ] && [ "$INV22_TEST" = "ok" ]; then
  echo "INV-022 (código): PASS"
else
  echo "INV-022 (código): FAIL (regra=$INV22_REGRA noHas=$INV22_NOHAS envelope=$INV22_ENVELOPE direto=$INV22_DIRETO skip=$INV22_SKIP teste=$INV22_TEST)"
fi
INV22_LANCOU_PRESO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where agente_extravio_status='lancou' and state='EXTRAVIO_MONITORADO';" 2>/dev/null | tr -d ' ')
INV22_SEM_MOTIVO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where agente_extravio_status='nao_rodou' and coalesce(btrim(agente_extravio_motivo),'')='';" 2>/dev/null | tr -d ' ')
if [ -z "$INV22_LANCOU_PRESO" ]; then
  echo "INV-022 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV22_LANCOU_PRESO" = "0" ] && [ "$INV22_SEM_MOTIVO" = "0" ]; then
  echo "INV-022 (DB): PASS"
else
  echo "INV-022 (DB): FAIL (lancou_preso_em_extravio=$INV22_LANCOU_PRESO, nao_rodou_sem_motivo=$INV22_SEM_MOTIVO)"
fi

echo "=== Fim Fase 8 ==="
```

**Status:** PASS = todos os INVs com PASS. **INFO** (baseline) e **SKIP** (check de DB sem `$SUPABASE_DB_URL` local) NÃO bloqueiam. FAIL = pelo menos 1 INV rodou e falhou; **bloqueia commit** até resolver. Os INVs com SKIP (003b, 006) devem rodar verdes num ambiente com acesso ao DB antes de deploy de mudança em sync-bastao.

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
