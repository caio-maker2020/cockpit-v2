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
ls -lt /Users/caiodevasconcelos/.claude/projects/-Users-caiodevasconcelos-Documents--code-cockpit-v2--cockpit-v2-starter/memory/ | head -5
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

# INV-SSW-LATIN1 (incidente 2026-07-06, NF 655782 oc=54 Duilio): sanitizarParaLatin1
# NÃO pode depender de byte NUL cru no fonte. O range latin-1 estava codificado
# como /[^<NUL>-ÿ]/ (NUL literal). Ferramenta que não preserva NUL removeu o byte,
# colapsando o range em [^-ÿ] (hífen literal) → apagava TODO caractere que não fosse
# '-'/'ÿ' → texto da oc chegou no SSW como "?????". Guard: sem NUL cru + regex escapado.
SSW_FILE="supabase/functions/_shared/ssw-internal-client.ts"
NUL_CRU=$(LC_ALL=C perl -0777 -ne 'my $n=()=/\x00/g; print $n' "$SSW_FILE" 2>/dev/null)
REGEX_OK=$(grep -Fc 'replace(/[^\x00-\xFF]/g' "$SSW_FILE" 2>/dev/null)
if [ "${NUL_CRU:-1}" -eq 0 ] && [ "${REGEX_OK:-0}" -ge 1 ]; then
  echo "INV-SSW-LATIN1: PASS"
else
  echo "INV-SSW-LATIN1: FAIL (nul_cru=$NUL_CRU regex_escapado=$REGEX_OK — sanitizarParaLatin1 frágil: texto do SSW pode virar '?????' de novo, como NF 655782)"
fi

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

# INV-012b (NF 362406, 2026-06-30): a galeria expõe o MANIFESTO (modo `list`) com
# TODAS as fotos numa só chamada, pro front renderizar declarativo e nunca mostrar
# só a 1ª. Guard: foto-oc-card wirado no montarManifestoFotos + teste do manifesto
# verde (trava que o manifesto não trunca pra 1).
INV12B_WIRED=$(grep -c "montarManifestoFotos" supabase/functions/foto-oc-card/index.ts 2>/dev/null | tr -d ' ')
INV12B_TEST=$(deno test --no-check supabase/functions/_shared/foto-oc-manifest.test.ts >/dev/null 2>&1 && echo ok || echo fail)
if [ "$INV12B_WIRED" -ge 1 ] && [ "$INV12B_TEST" = "ok" ]; then
  echo "INV-012b: PASS"
else
  echo "INV-012b: FAIL (foto-oc-card montarManifestoFotos=$INV12B_WIRED, teste manifesto=$INV12B_TEST — galeria deve servir manifesto com TODAS as fotos; bug NF 362406)"
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
# EXCLUI LAG (NF 175621): card que lançou 54 e o Bastão ainda mostra a oc anterior
# (data <= data do lançamento de 54) fica CERTO em AGUARDANDO_CLIENTE — não é violação.
INV19_STUCK=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c where c.state='AGUARDANDO_CLIENTE' and c.cod_ultima_ocorrencia in (3,8,10,11,17,19,20,23,26,28,35,43,49,52) and not exists (select 1 from acoes_executadas_ssw a where a.card_id=c.id and a.codigo_oc=54 and a.sucesso and (a.iniciado_em at time zone 'America/Sao_Paulo')::date >= c.bastao_data_ultima_ocorrencia);" 2>/dev/null | tr -d ' ')
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
# GUARD anti-regressão NF 362406 (Caio 2026-07-06): o sweep NÃO pode voltar a pular
# card por SNAPSHOT (bastao_oc_no_lancamento === cod_ultima_ocorrencia). Esse guard
# legado prendia PRA SEMPRE um 49 novo cujo número coincidia com o snapshot do
# lançamento (data já provava oc nova) → divergia do watchdog → alerta eterno. A
# autoridade é só `naoRebaixarComDesempateSsw` (guard #1, por data + SSW por hora).
INV19_SNAPSHOT_GUARD=$(grep -c "ocNova === bastaoOcNoLancamento" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV19_SNAPSHOT_GUARD:-0}" -ge 1 ]; then
  echo "INV-019 (snapshot): FAIL (sweep voltou a pular por bastao_oc_no_lancamento===cod_ultima_ocorrencia — regressão NF 362406; remover o guard de snapshot, autoridade é naoRebaixarComDesempateSsw)"
else
  echo "INV-019 (snapshot): PASS (sweep sem guard de snapshot; decide só por data/SSW)"
fi
if [ -z "$INV19_STUCK" ]; then
  echo "INV-019 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV19_STUCK" = "0" ]; then
  echo "INV-019 (DB): PASS"
else
  echo "INV-019 (DB): FAIL ($INV19_STUCK card(s) AGUARDANDO_CLIENTE com oc de relacionamento ≠54 travados — deveriam estar em AGUARDANDO VOCÊ; Pass A+sweep regrediram)"
fi
# INV-019 (RPC): a RPC ignorar_pendencias_resposta_cliente NÃO pode ter caminho que
# seta AGUARDANDO_CLIENTE sem checar cod_ultima_ocorrencia (bug NF 1119469, mig 287).
# A versão buggada NUNCA referenciava cod_ultima_ocorrencia; a corrigida decide o
# state pelo predicado do INV-019 e emite PendenciasRespostaIgnoradasMantidoEmAguardandoVoce.
# (a) fonte: a migration MAIS RECENTE que (re)define a RPC tem que carregar o guard;
# (b) DB: a função DEPLOYADA tem que referenciar o guard (pg_get_functiondef).
RPC_LATEST=$(grep -rl "CREATE OR REPLACE FUNCTION public.ignorar_pendencias_resposta_cliente" migration/ 2>/dev/null | sort | tail -1)
RPC_SRC_GUARD=$(grep -c "cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)" "$RPC_LATEST" 2>/dev/null | tr -d ' ')
RPC_SRC_EVT=$(grep -c "PendenciasRespostaIgnoradasMantidoEmAguardandoVoce" "$RPC_LATEST" 2>/dev/null | tr -d ' ')
if [ "${RPC_SRC_GUARD:-0}" -ge 1 ] && [ "${RPC_SRC_EVT:-0}" -ge 1 ]; then
  echo "INV-019 (RPC fonte): PASS (guard cod_ultima_ocorrencia + evento MantidoEmAguardandoVoce na mig mais recente: $RPC_LATEST)"
else
  echo "INV-019 (RPC fonte): FAIL (a mig mais recente da RPC ignorar_pendencias NÃO tem o guard INV-019 — regressão do bug NF 1119469; $RPC_LATEST)"
fi
RPC_DB_GUARD=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when pg_get_functiondef('public.ignorar_pendencias_resposta_cliente(uuid,text)'::regprocedure) ~ 'cod_ultima_ocorrencia' and pg_get_functiondef('public.ignorar_pendencias_resposta_cliente(uuid,text)'::regprocedure) ~ 'PendenciasRespostaIgnoradasMantidoEmAguardandoVoce' then 1 else 0 end;" 2>/dev/null | tr -d ' ')
if [ -z "$RPC_DB_GUARD" ]; then
  echo "INV-019 (RPC DB): SKIP (sem acesso ao DB local)"
elif [ "$RPC_DB_GUARD" = "1" ]; then
  echo "INV-019 (RPC DB): PASS (função deployada respeita o guard cod_ultima_ocorrencia=54)"
else
  echo "INV-019 (RPC DB): FAIL (ignorar_pendencias_resposta_cliente DEPLOYADA seta AGUARDANDO_CLIENTE sem checar cod_ultima_ocorrencia — bug NF 1119469 vivo em produção; aplicar mig 287)"
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

# INV-021: recusa/falta (oc 10/19/35) originada de extravio (6/9/16) não notificado.
# O agente-sugere-ocs-padrao detecta a sequência (detector puro em _shared/recusa-por-extravio.ts,
# testado) e decide via montarSugestaoRecusaPorExtravio. DIFERENÇA oc=19 x oc=35 (NF 179799):
#   - oc=19 (entregue COM falta = extraviado, nada a devolver) → SÓ notifica + romaneio,
#     mantém ENTREGUE_COM_FALTA_PEDIR_ROMANEIO, NUNCA pergunta devolução.
#   - oc=10/35 (recusa, volume físico parado) → RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR + pergunta destino.
# O interpretador-resposta-cliente exige romaneio+descrição+valor antes do combo 33+44. Bug NF 148558.
INV21_CODE=$(grep -c "recusaOriginadaDeExtravioNaoNotificada" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV21_SUG=$(grep -c "montarSugestaoRecusaPorExtravio" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
# Guard oc=19: a função pura NÃO pode oferecer devolução/nova entrega pra oc=19 (só notifica).
INV21_OC19=$(grep -A4 "codigoOc === 19" supabase/functions/_shared/recusa-por-extravio.ts 2>/dev/null | grep -c "perguntaDestino: false" | tr -d ' ')
INV21_TMPL=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from templates_email where id='RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR' and ativo and corpo_template ilike '%romaneio%' and corpo_template ilike '%valor%' and (corpo_template ilike '%devolu%' and (corpo_template ilike '%nova entrega%' or corpo_template ilike '%reentrega%'));" 2>/dev/null | tr -d ' ')
# Guard DB: dropdown da oc=19 no preview_email_todo NÃO pode listar o template de devolução.
INV21_DROP19=$($PSQL "$SUPABASE_DB_URL" -tA -c "with d as (select pg_get_functiondef('public.preview_email_todo(uuid,text)'::regprocedure) f) select case when (f ~ 'WHEN 19 THEN ARRAY\[''ENTREGUE_COM_FALTA_PEDIR_ROMANEIO''') and (f !~ 'WHEN 19 THEN ARRAY\[[^]]*RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR') then 1 else 0 end from d;" 2>/dev/null | tr -d ' ')
INV21_TEST=$(deno test supabase/functions/_shared/recusa-por-extravio.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV21_COMPLETUDE=$(grep -c "REGRA DE COMPLETUDE" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$INV21_TMPL" ]; then
  echo "INV-021: SKIP (sem acesso ao DB local — code=$INV21_CODE sug=$INV21_SUG oc19=$INV21_OC19 test=$INV21_TEST completude=$INV21_COMPLETUDE)"
elif [ "$INV21_CODE" -ge 1 ] && [ "$INV21_SUG" -ge 1 ] && [ "$INV21_OC19" -ge 1 ] && [ "$INV21_TMPL" = "1" ] && [ "$INV21_DROP19" = "1" ] && [ "$INV21_TEST" = "ok" ] && [ "$INV21_COMPLETUDE" -ge 1 ]; then
  echo "INV-021: PASS"
else
  echo "INV-021: FAIL (detector=$INV21_CODE, sugestao_pura=$INV21_SUG, oc19_so_notifica=$INV21_OC19, template_completo=$INV21_TMPL, dropdown_oc19_sem_devolucao=$INV21_DROP19, teste=$INV21_TEST, completude_interpretador=$INV21_COMPLETUDE — fluxo recusa-por-extravio regrediu; ver mig 254/267, NF 148558/179799)"
fi

# INV-021b: oc=35 tem UM template só = RECUSA_PARCIAL (mig 290, Caio 2026-07-06).
# ENTREGA_PARCIAL_APOS_FALTA_VOLUME foi consolidado/deprecado — nome enganoso
# ("FALTA_VOLUME" é semântica de oc=19/extravio, não de oc=35/recusa). Guards:
#   (a) DB: ENTREGA_PARCIAL_APOS_FALTA_VOLUME.ativo=false e RECUSA_PARCIAL.ativo=true
#   (b) DB: nenhum card ainda sugere o template deprecado (retroativo aplicado)
#   (c) código: a IA (templateMap + deduzirTemplateDoCluster) mapeia oc=35 → RECUSA_PARCIAL
INV21B_DEPR=$($PSQL "$SUPABASE_DB_URL" -tA -c "select case when (select not ativo from templates_email where id='ENTREGA_PARCIAL_APOS_FALTA_VOLUME') and (select ativo from templates_email where id='RECUSA_PARCIAL') then 1 else 0 end;" 2>/dev/null | tr -d ' ')
INV21B_CARDS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where analise_padrao_resultado->>'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME' or aviso_alteracao_oc->>'template_email_sugerido' = 'ENTREGA_PARCIAL_APOS_FALTA_VOLUME';" 2>/dev/null | tr -d ' ')
INV21B_CODE=$(grep -cE '35:\s*"RECUSA_PARCIAL"' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV21B_CLUSTER=$(grep -cE 'o\.codigo === 35\) return "RECUSA_PARCIAL"' supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$INV21B_DEPR" ]; then
  echo "INV-021b: SKIP (sem DB local — code=$INV21B_CODE cluster=$INV21B_CLUSTER)"
elif [ "$INV21B_DEPR" = "1" ] && [ "$INV21B_CARDS" = "0" ] && [ "$INV21B_CODE" -ge 1 ] && [ "$INV21B_CLUSTER" -ge 1 ]; then
  echo "INV-021b: PASS"
else
  echo "INV-021b: FAIL (depr_ativo_flags=$INV21B_DEPR, cards_com_deprecado=$INV21B_CARDS, templateMap_oc35=$INV21B_CODE, cluster_oc35=$INV21B_CLUSTER — oc=35 voltou a ter 2 templates / IA voltou pra ENTREGA_PARCIAL_APOS_FALTA_VOLUME; ver mig 290)"
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

# INV-023: card de relacionamento SEMPRE aponta, sem re-mostrar o já tratado. A decisão de
# VISIBILIDADE usa a VERDADE DO SSW POR IDENTIDADE (decidirVisibilidadePorSsw: ai.salex ×
# terceiro), NÃO por relógio (ADR 0011 supersede 0009 "por hora" — a comparação hora-SSW ×
# iniciado_em escondia oc de relacionamento nova de terceiro no mesmo minuto de uma ação do
# Cockpit; raiz NF 346896). Bounce-back (351193): SSW mais recente = nossa ação (ai.salex) →
# suprime. R2: card AGUARDANDO_CLIENTE cuja oc vira NÃO-relacionamento vai pra CONFLITOS
# (flagConflitoOcSemMover), não some. O caminho per-hora (decidirReaberturaPorSsw) segue no
# código atrás da flag reabertura_por_identidade_enabled=OFF (rollback) até o PR de cleanup.
INV23_WIRE=$(grep -c "decidirReaberturaCandidato\|candidatoReabertura" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV23_IDENTIDADE=$(grep -c "decidirVisibilidadePorSsw" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV23_R2=$(grep -c "flagConflitoOcSemMover\|cardEmEscopoProtegido" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
grep -q "contaLancamentoCockpit\|normalizarAutor" supabase/functions/_shared/decidir-visibilidade-ssw.ts 2>/dev/null && INV23_FUNC=ok || INV23_FUNC=fail
deno test --no-check --allow-net --allow-env supabase/functions/_shared/decidir-visibilidade-ssw.test.ts >/dev/null 2>&1 && INV23_TEST=ok || INV23_TEST=fail
INV23_BOUNCE=$($PSQL "$SUPABASE_DB_URL" -tA -c "
  with ult as (select distinct on (card_id) card_id, codigo_oc oc_lancada,
    (iniciado_em at time zone 'America/Sao_Paulo')::date data_lanc
    from acoes_executadas_ssw where sucesso=true order by card_id, iniciado_em desc)
  select count(*) from cards c join ult u on u.card_id=c.id
  where c.state='AGUARDANDO_VALIDACAO_HUMANA' and c.lock_aguardando_validacao=true
    and c.cliente_respondeu_em is null
    and coalesce(c.bastao_data_ultima_ocorrencia,'1900-01-01') < u.data_lanc
    and u.oc_lancada not in (10,11,17,19,20,23,26,28,35,43,49,52);" 2>/dev/null | tr -d ' ')
    -- < (estritamente antes) = bounce-back CLARO (lag). Mesmo-dia é decidido pela
    -- VERDADE DO SSW POR HORA (decidirReaberturaPorSsw) — não conta aqui.
if [ -z "$INV23_BOUNCE" ]; then
  echo "INV-023: SKIP (sem DB — wire=$INV23_WIRE identidade=$INV23_IDENTIDADE func=$INV23_FUNC r2=$INV23_R2 teste=$INV23_TEST)"
elif [ "$INV23_WIRE" -ge 2 ] && [ "$INV23_IDENTIDADE" -ge 2 ] && [ "$INV23_FUNC" = "ok" ] && [ "$INV23_R2" -ge 2 ] && [ "$INV23_TEST" = "ok" ] && [ "$INV23_BOUNCE" = "0" ]; then
  echo "INV-023: PASS"
else
  echo "INV-023: FAIL (wire=$INV23_WIRE identidade=$INV23_IDENTIDADE func=$INV23_FUNC r2=$INV23_R2 teste=$INV23_TEST bounce=$INV23_BOUNCE — raiz SSW-por-identidade NF 346896 / bounce-back 351193 / R2 CONFLITOS)"
fi

# INV-024: agente "relançar 54 por ressarcimento" (54→46→49). Detector exige 54 ANTES
# da 46 (cliente notificado) + 49 como última oc codificada; lançamento via envelope;
# autonomia gated. Bug que trava: relançar 54 sem o cliente nunca ter sido notificado,
# ou recomendar quando a 49 manda outra oc / diz "não procede".
INV24_DET=$(grep -c "detectarRessarcimentoRelancar54" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV24_ENVELOPE=$(grep -c "auto_aprovar_e_executar" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV24_54ANTES46=$(grep -c "i54" supabase/functions/_shared/ressarcimento-relancar-54.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/ressarcimento-relancar-54.test.ts >/dev/null 2>&1 && INV24_TEST=ok || INV24_TEST=fail
if [ "$INV24_DET" -ge 1 ] && [ "$INV24_ENVELOPE" -ge 1 ] && [ "$INV24_54ANTES46" -ge 1 ] && [ "$INV24_TEST" = "ok" ]; then
  echo "INV-024 (código): PASS"
else
  echo "INV-024 (código): FAIL (detector=$INV24_DET envelope=$INV24_ENVELOPE guard_54_antes_46=$INV24_54ANTES46 teste=$INV24_TEST — ver ADR 0008, NF 374609/775461)"
fi
INV24_SEM_MOTIVO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where ressarc54_status='nao_rodou' and coalesce(btrim(ressarc54_motivo),'')='';" 2>/dev/null | tr -d ' ')
if [ -z "$INV24_SEM_MOTIVO" ]; then
  echo "INV-024 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV24_SEM_MOTIVO" = "0" ]; then
  echo "INV-024 (DB): PASS"
else
  echo "INV-024 (DB): FAIL (nao_rodou_sem_motivo=$INV24_SEM_MOTIVO)"
fi
# INV-024b: o todo Tier A do agente de ressarcimento carrega
# extras.forcar_lancamento_ctrc_baixado=true (round-trip lança 54 sobre CTRC baixado;
# tripé dispensa SÓ localização, mantém CTRC+NF). Bug âncora NF 5631361: 4× bloqueio
# "CTRC ENTREGUE / BAIXADO". Guard = (a) agente usa o helper, (b) helper existe,
# (c) testes do helper + do tripé (flag NÃO burla CTRC/NF divergente) passam. mig n/a (edge).
INV24B_AGENTE=$(grep -c "aplicarForcarCtrcBaixado" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV24B_HELPER=$(grep -c "forcar_lancamento_ctrc_baixado" supabase/functions/_shared/forcar-lancamento-ctrc-baixado.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-read supabase/functions/_shared/forcar-lancamento-ctrc-baixado.test.ts supabase/functions/_shared/validar-tripe-ssw.test.ts >/dev/null 2>&1 && INV24B_TEST=ok || INV24B_TEST=fail
if [ "$INV24B_AGENTE" -ge 1 ] && [ "$INV24B_HELPER" -ge 1 ] && [ "$INV24B_TEST" = "ok" ]; then
  echo "INV-024b (código): PASS"
else
  echo "INV-024b (código): FAIL (agente_usa_helper=$INV24B_AGENTE helper=$INV24B_HELPER testes=$INV24B_TEST — agente parou de forçar CTRC baixado OU flag passou a burlar CTRC/NF; NF 5631361, ADR 0008)"
fi

# INV-026: agente-sugere-ocs-padrao — concluida ⇒ tem aviso. Nenhum card pode ficar
# em analise_padrao_status='concluida' SEM aviso_alteracao_oc (congelaria invisível,
# sem recomendação IA, e o cron nunca re-pegava 'concluida'). Code: cláusula de
# auto-cura no candidate-query; DB: zero cards nesse estado. Ver grupo ELEVA/AVANTE,
# NF 463457 + 6 órfãos (2026-06-26).
INV26_AUTOCURA=$(grep -c "analise_padrao_status.eq.concluida,aviso_alteracao_oc.is.null" supabase/functions/agente-sugere-ocs-padrao/index.ts)
[ "$INV26_AUTOCURA" -ge 1 ] && echo "INV-026 (código): PASS" || echo "INV-026 (código): FAIL (auto-cura concluida-sem-aviso sumiu do candidate-query — agente-sugere-ocs-padrao:240)"
INV26_PRESOS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and cod_ultima_ocorrencia in (10,11,19,35,49) and analise_padrao_status='concluida' and aviso_alteracao_oc is null;" 2>/dev/null | tr -d ' ')
if [ -z "$INV26_PRESOS" ]; then
  echo "INV-026 (DB): SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
elif [ "$INV26_PRESOS" = "0" ]; then
  echo "INV-026 (DB): PASS"
else
  echo "INV-026 (DB): FAIL ($INV26_PRESOS cards concluida SEM aviso — congelados sem sugestão IA; re-disparar POST agente-sugere-ocs-padrao {card_id})"
fi

# INV-027: identidade única de ação (acao_key) — "lançar 54 + e-mail" e "lançar 54
# SEM e-mail" são ações OPOSTAS. O banner destaca/vincula pela acao_key (==
# todo.proposta_payload.acao_key == card.analise_padrao_resultado.proposta_destacada_acao),
# NUNCA pelo número 54 (ambíguo entre as duas). Bug raiz: NF 463457 — banner
# mostrava "54 + e-mail (template)" e o clique acionava "54 SEM e-mail" (cliente
# nunca notificado). Code: acaoKey definido+usado + proposta_destacada_acao no
# agente + teste; DB: zero todos ativos (tool+codigo_ssw) SEM acao_key.
INV27_HELPER=$(grep -c "export function acaoKey" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV27_USO=$(grep -c "acao_key: acaoKey(" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV27_DESTACADA=$(grep -c "proposta_destacada_acao" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/regras-auto-acao.sem-email-54.test.ts >/dev/null 2>&1 && INV27_TEST=ok || INV27_TEST=fail
if [ "$INV27_HELPER" -ge 1 ] && [ "$INV27_USO" -ge 1 ] && [ "$INV27_DESTACADA" -ge 1 ] && [ "$INV27_TEST" = "ok" ]; then
  echo "INV-027 (código): PASS"
else
  echo "INV-027 (código): FAIL (helper=$INV27_HELPER uso=$INV27_USO destacada=$INV27_DESTACADA teste=$INV27_TEST — NF 463457, acao_key/proposta_destacada_acao)"
fi
INV27_SEM_KEY=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from todos where status in ('pendente','aprovado') and (proposta_payload->>'tool') is not null and (proposta_payload->'args'->>'codigo_ssw') is not null and not (proposta_payload ? 'acao_key');" 2>/dev/null | tr -d ' ')
# Trigger mig 284 = ponto único que garante acao_key em TODO insert (dos 18 fluxos
# que inserem todos, só regras-auto-acao gravava acao_key → 701 ativos sem chave,
# NF 27573). Se o trigger sumir, novos todos voltam a nascer sem acao_key.
INV27_TRG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_trigger where tgname='trg_todos_preencher_acao_key';" 2>/dev/null | tr -d ' ')
if [ -z "$INV27_SEM_KEY" ]; then
  echo "INV-027 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV27_SEM_KEY" = "0" ] && [ "$INV27_TRG" = "1" ]; then
  echo "INV-027 (DB): PASS"
elif [ "$INV27_TRG" != "1" ]; then
  echo "INV-027 (DB): FAIL (trigger trg_todos_preencher_acao_key ausente — reaplicar mig 284; sem ele novos todos nascem sem acao_key)"
else
  echo "INV-027 (DB): FAIL ($INV27_SEM_KEY todos ativos sem acao_key — reaplicar backfill mig 284 / conferir trigger)"
fi

# INV-027b (NF 1093446, 2026-07-01): TODO banner que recomenda "54 + e-mail" carrega
# proposta_destacada_acao (acao_key). O agente-oc13-autonomo (fluxo ia_sugestao_oc13)
# NÃO gravava → banner caía na 54 SEM e-mail. Code: oc13 grava a chave. DB: nenhum
# card ativo com banner "54+email" sem proposta_destacada_acao.
INV27B_OC13=$(grep -c "proposta_destacada_acao" supabase/functions/agente-oc13-autonomo/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV27B_OC13" -ge 1 ]; then
  echo "INV-027b (código): PASS"
else
  echo "INV-027b (código): FAIL (agente-oc13-autonomo não grava proposta_destacada_acao — banner cai na 54 sem-email; NF 1093446)"
fi
INV27B_SEM_ACAO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and (aviso_alteracao_oc->>'sugestao') ilike '%54%email%' and (aviso_alteracao_oc->>'proposta_destacada_acao') is null;" 2>/dev/null | tr -d ' ')
if [ -z "$INV27B_SEM_ACAO" ]; then
  echo "INV-027b (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV27B_SEM_ACAO" = "0" ]; then
  echo "INV-027b (DB): PASS"
else
  echo "INV-027b (DB): FAIL ($INV27B_SEM_ACAO cards com banner 54+email SEM proposta_destacada_acao — front cai na 54 sem-email; backfill + conferir agentes)"
fi

# INV-028: fila scan_email_pre_card sem loop/duplicação. Raiz NF 721938: surfar
# (gmail-poll) re-enfileirava o mesmo card a cada poll sem dedup → 2.235 msgs /
# 88 cards (1 card 459×), afogando births + botão "JÁ TEM TRATATIVA" em ~13h FIFO.
# Fix: enqueue ÚNICO com dedup (1 pendente/card) usado por surfar/birth/rescan/botão.
# Code: surfar/birth chamam enqueue_scan_email_pre_card (não enqueue_to_pgmq cru).
# DB: nenhum card aparece >3× na fila E queue_length sob teto são.
INV28_DEDUP=$(grep -c "enqueue_scan_email_pre_card" supabase/functions/_shared/scan-email-enqueue.ts 2>/dev/null | tr -d ' ')
INV28_CRU=$(grep -c "enqueue_to_pgmq" supabase/functions/_shared/scan-email-enqueue.ts 2>/dev/null | tr -d ' ')
if [ "$INV28_DEDUP" -ge 2 ] && [ "$INV28_CRU" = "0" ]; then
  echo "INV-028 (código): PASS"
else
  echo "INV-028 (código): FAIL (dedup_calls=$INV28_DEDUP enqueue_cru=$INV28_CRU — surfar/birth devem usar enqueue_scan_email_pre_card, nunca enqueue_to_pgmq cru; NF 721938)"
fi
INV28_MAXDUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select coalesce(max(n),0) from (select count(*) n from pgmq.q_scan_email_pre_card where message->>'card_id' is not null group by message->>'card_id') x;" 2>/dev/null | tr -d ' ')
INV28_LEN=$($PSQL "$SUPABASE_DB_URL" -tA -c "select queue_length from pgmq.metrics('scan_email_pre_card');" 2>/dev/null | tr -d ' ')
if [ -z "$INV28_MAXDUP" ]; then
  echo "INV-028 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV28_MAXDUP" -le 3 ] && [ "${INV28_LEN:-0}" -le 1000 ]; then
  echo "INV-028 (DB): PASS (max_dup/card=$INV28_MAXDUP, queue_len=$INV28_LEN)"
else
  echo "INV-028 (DB): FAIL (max_dup/card=$INV28_MAXDUP queue_len=$INV28_LEN — loop de re-enqueue voltou; checar surfar/dedup, NF 721938)"
fi

# INV-029: "Criar Card" manual (criar-card-manual) NÃO pode quebrar a reconciliação
# Bastão. O card manual nasce com agent_state.origem="manual" (NUNCA "email_ssw") e
# SEM carimbar bastao_*_no_lancamento — assim flui pelo caminho NORMAL do sync-bastao
# (49→AGUARDANDO VOCÊ, 41→CONFLITOS, resposta→CLIENTE RESPONDEU). O guard anti-reabertura
# do sync-bastao (escopado a origem==="email_ssw") NÃO pode passar a incluir "manual".
# Criação só com última oc de relacionamento (isOcorrenciaDeRelacionamentoCtx) + escolha
# de CTRC via escolherCtrcManual. NF-âncora 684385 (BUNZL/Victor), oc=10.
INV29_ORIGEM=$(grep -c 'origem: "manual"' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_NO_EMAILSSW=$(grep -cE 'origem:[[:space:]]*"email_ssw"' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_NO_SEED=$(grep -cE 'bastao_oc_no_lancamento|bastao_updated_at_no_lancamento' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_SELECTOR=$(grep -c 'escolherCtrcManual' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV29_GATE=$(grep -c 'isOcorrenciaDeRelacionamentoCtx' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
# o guard email_ssw do sync-bastao não pode referenciar "manual"
INV29_GUARD_LIMPO=$(grep -c 'origem"\] === "manual"' supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
# Erro SEMPRE claro: nenhuma resposta tratada pode ser não-2xx (senão o
# supabase.functions.invoke esconde a mensagem com "non-2xx status code"). NF 263243.
INV29_NAO2XX=$(grep -cE 'jsonResp\([^)]*,[[:space:]]*(400|401|403|405|500)\)' supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-net --allow-env supabase/functions/_shared/escolher-ctrc-manual.test.ts >/dev/null 2>&1 && INV29_TEST=ok || INV29_TEST=fail
if [ "$INV29_ORIGEM" -ge 1 ] && [ "$INV29_NO_EMAILSSW" = "0" ] && [ "$INV29_NO_SEED" = "0" ] && [ "$INV29_SELECTOR" -ge 1 ] && [ "$INV29_GATE" -ge 1 ] && [ "$INV29_GUARD_LIMPO" = "0" ] && [ "$INV29_NAO2XX" = "0" ] && [ "$INV29_TEST" = "ok" ]; then
  echo "INV-029 (código): PASS"
else
  echo "INV-029 (código): FAIL (origem_manual=$INV29_ORIGEM no_email_ssw=$INV29_NO_EMAILSSW no_seed_bastao=$INV29_NO_SEED selector=$INV29_SELECTOR gate=$INV29_GATE guard_sync_limpo=$INV29_GUARD_LIMPO nao2xx=$INV29_NAO2XX teste=$INV29_TEST — card manual quebrando reconciliação Bastão OU devolvendo erro não-2xx que esconde a mensagem; NF 684385/263243)"
fi
INV29_BAD=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where agent_state->>'origem'='manual' and state='AGUARDANDO_CLIENTE' and cod_ultima_ocorrencia is distinct from 54;" 2>/dev/null | tr -d ' ')
if [ -z "$INV29_BAD" ]; then
  echo "INV-029 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV29_BAD" = "0" ]; then
  echo "INV-029 (DB): PASS"
else
  echo "INV-029 (DB): FAIL ($INV29_BAD cards origem=manual em AGUARDANDO_CLIENTE com oc≠54 — card manual sendo especial-cased fora da regra oc54⟺AGUARDANDO_CLIENTE)"
fi

# INV-030: lista de ações sugeridas SEM opções duplicadas — no máx 1 todo ATIVO por
# (card_id, tool, codigo_ssw). Caio 2026-06-26/27: a mesma ação aparecia 2-6× ("54 +
# e-mail", "54 sem e-mail", oc 49) pq vários fluxos criam todos sem dedup transversal
# (inclusive extravio_cockpit SEM acao_key — NF 5948). Identidade do PAYLOAD (tool+cod),
# não do campo acao_key. Guard: índice único parcial uniq_todos_card_tool_cod_ativo
# (mig 278, substitui o por-acao_key da 277) — 2ª inserção falha (unique_violation) e
# os inserts tratam erro = no-op idempotente.
INV30_IDX=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from pg_index where indexrelid='uniq_todos_card_tool_cod_ativo'::regclass and indisvalid;" 2>/dev/null | tr -d ' ')
if [ -z "$INV30_IDX" ]; then
  echo "INV-030 (índice): SKIP (sem acesso ao DB local)"
elif [ "$INV30_IDX" = "1" ]; then
  echo "INV-030 (índice): PASS"
else
  echo "INV-030 (índice): FAIL (índice único uniq_todos_card_tool_cod_ativo ausente/inválido — mig 278)"
fi
INV30_DUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select card_id, proposta_payload->>'tool' tl, coalesce(proposta_payload->'args'->>'codigo_ssw','') cd from todos where status in ('pendente','aprovado') and (proposta_payload->>'tool') is not null group by 1,2,3 having count(*)>1) x;" 2>/dev/null | tr -d ' ')
if [ -z "$INV30_DUP" ]; then
  echo "INV-030 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV30_DUP" = "0" ]; then
  echo "INV-030 (DB): PASS"
else
  echo "INV-030 (DB): FAIL ($INV30_DUP cards com ação duplicada na lista — dedup quebrou, ver mig 278)"
fi

# INV-031: card NUNCA preso para sempre em EXECUTANDO_ACAO (causa raiz H8, NF 296312).
# aprovar_e_executar enfileira a ação SEM garantia de conclusão; se a mensagem do
# executor se perde, o card congela (só alerta de 30min, sem recuperação). Fix:
# watchdog reconciliar_execucoes_presas (cron 5min, threshold 15min) re-enfileira
# (só-SSW idempotente por-todo) OU reverte p/ humano (e-mail/null-stale/anti-loop,
# máx 2 tentativas) — NUNCA re-dispatch cego. + observabilidade no executor
# (mensagem lida vs concluída) pra confirmar o gatilho. mig 279.
INV31_OBS=$(grep -oE '"(mensagem_lida|processamento_iniciado|processamento_concluido|processamento_falhou_retry|processamento_falhou_final|mensagem_deletada|mensagem_arquivada_dlq)"' supabase/functions/executor/index.ts 2>/dev/null | sort -u | wc -l | tr -d ' ')
INV31_RECON=$(grep -c "reconciliar_execucoes_presas\|_reconciliar_decidir" migration/2026-06-29_279_watchdog_execucao_presa.sql 2>/dev/null | tr -d ' ')
INV31_LOCK=$(grep -c "pg_try_advisory_xact_lock" migration/2026-06-29_279_watchdog_execucao_presa.sql 2>/dev/null | tr -d ' ')
INV31_HEALTH=$(grep -c "reconciliar_execucoes_presas" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV31_OBS" -ge 7 ] && [ "$INV31_RECON" -ge 2 ] && [ "$INV31_LOCK" -ge 1 ] && [ "$INV31_HEALTH" -ge 1 ]; then
  echo "INV-031 (código): PASS"
else
  echo "INV-031 (código): FAIL (obs_eventos=$INV31_OBS/7 reconciliador=$INV31_RECON lock=$INV31_LOCK health=$INV31_HEALTH — watchdog execução presa / observabilidade regrediu; NF 296312, mig 279)"
fi
INV31_CRON=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cron.job where jobname='reconciliar-execucao-presa-every-5min';" 2>/dev/null | tr -d ' ')
# Decisão pura (assinatura: whitelisted, tem_email, acoes, tentativas, max, recent):
# só-SSW→reenfileirar · null-stale→reverter · email→reverter · não-whitelist→reverter.
INV31_DEC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select public._reconciliar_decidir(true,false,'[{\"sucesso\":true}]'::jsonb,0,2,10)||'|'||public._reconciliar_decidir(true,false,'[{\"sucesso\":null,\"idade_min\":120}]'::jsonb,0,2,10)||'|'||public._reconciliar_decidir(true,true,'[]'::jsonb,0,2,10)||'|'||public._reconciliar_decidir(false,false,'[]'::jsonb,0,2,10);" 2>/dev/null | tr -d ' ')
INV31_PRESOS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='EXECUTANDO_ACAO' and updated_at < now() - interval '30 min';" 2>/dev/null | tr -d ' ')
if [ -z "$INV31_CRON" ]; then
  echo "INV-031 (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV31_CRON" = "1" ] && [ "$INV31_DEC" = "reenfileirar|reverter|reverter|reverter" ] && [ "${INV31_PRESOS:-0}" = "0" ]; then
  echo "INV-031 (DB): PASS"
else
  echo "INV-031 (DB): FAIL (cron=$INV31_CRON decisao_pura=$INV31_DEC presos_30min=$INV31_PRESOS — watchdog não instalado / decidindo errado / card preso não reconciliado; NF 296312)"
fi
# INV-031b: reverter_acao_falhou RESPEITA a dedup do INV-030 (uniq_todos_card_tool_cod_ativo).
# Ressuscitar o gêmeo cancelado pra 'pendente' quando JÁ existe um ativo com a mesma
# identidade (card,tool,codigo_ssw) violava o índice e abortava a txn do reconciliador
# → cron reconciliar-execucao-presa em LOOP de falha 5/5min (NF 5631361, 2026-06-30).
# Guard: a função tem a guarda de dedup (NOT EXISTS + row_number) E a ÚLTIMA execução
# do cron NÃO é 'failed' (um loop ativo aparece aqui na hora). mig 283.
INV31B_GUARD=$(grep -c "row_number() OVER" migration/2026-06-30_283_reverter_acao_falhou_respeita_dedup.sql 2>/dev/null | tr -d ' ')
INV31B_NOTEXISTS=$(grep -c "NOT EXISTS" migration/2026-06-30_283_reverter_acao_falhou_respeita_dedup.sql 2>/dev/null | tr -d ' ')
if [ "${INV31B_GUARD:-0}" -ge 1 ] && [ "${INV31B_NOTEXISTS:-0}" -ge 1 ]; then
  echo "INV-031b (código): PASS"
else
  echo "INV-031b (código): FAIL (guarda dedup row_number=$INV31B_GUARD not_exists=$INV31B_NOTEXISTS removida de reverter_acao_falhou — volta a colidir com uniq_todos_card_tool_cod_ativo; NF 5631361, mig 283)"
fi
INV31B_ULT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select coalesce((select status from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='reconciliar-execucao-presa-every-5min' order by d.start_time desc limit 1),'sem_run');" 2>/dev/null | tr -d ' ')
if [ -z "$INV31B_ULT" ]; then
  echo "INV-031b (DB): SKIP (sem acesso ao DB local)"
elif [ "$INV31B_ULT" != "failed" ]; then
  echo "INV-031b (DB): PASS"
else
  echo "INV-031b (DB): FAIL (última execução do watchdog = failed — cron reconciliar-execucao-presa em LOOP de falha; abra o '⚠ N falhas' de hoje no monitor de capacidade; NF 5631361, mig 283)"
fi

# INV-032: pós-oc49 em EXTRAVIO precisa SOBREVIVER até a operadora agir (NF 705764,
# Larissa). 3 raízes independentes do mesmo card:
# (α) Pass D NÃO apaga o banner de recomendação do agente (aviso.tipo=
#     'ia_sugestao_ocs_padrao') quando a oc do Bastão é LAG de um lançamento do
#     Cockpit (ehLagDeLancamentoCockpit) → "54 + e-mail de extravio" sobrevive.
# (β) o todo "54 + e-mail" carrega o template QUE O AGENTE DECIDIU
#     (templateEmail54Override, ex EXTRAVIO_TOTAL_PEDIR_ROMANEIO), não o
#     FALTA_DE_VOLUME genérico da regra oc=49.
# (δ) card nascido de extravio (handleExtravioPendencia) enfileira o scan de e-mail
#     pré-existente (enfileirarScanEmailPreCard origem=extravio).
INV32_BANNER=$(grep -c "banner_ia_preservado" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
# Guard usa o predicado PURO passDDevePreservarBannerIaSugestao (preserva só em
# classe 'lag' = estritamente anterior; mesmo-dia 'ambiguo' NÃO preserva — refino).
INV32_GUARD=$(grep -A12 'ia_sugestao_ocs_padrao' supabase/functions/sync-bastao/index.ts 2>/dev/null | grep -c "passDDevePreservarBannerIaSugestao" | tr -d ' ')
INV32_PRED=$(grep -c "classe === \"lag\"" supabase/functions/_shared/lag-lancamento-54.ts 2>/dev/null | tr -d ' ')
INV32_TPL_RULE=$(grep -c "templateEmail54Override" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV32_TPL_AGENT=$(grep -c "templateEmail54Override" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
INV32_SCAN=$(grep -c 'origem: "extravio"' supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
INV32_TEST=$([ -f supabase/functions/_shared/regras-auto-acao.template-override-54.test.ts ] && echo 1 || echo 0)
INV32_TEST2=$(grep -c "passDDevePreservarBannerIaSugestao" supabase/functions/_shared/lag-lancamento-54.test.ts 2>/dev/null | tr -d ' ')
# (γ) Codex 2026-07-02 (NF 609867): oc=19 é PÓS-ENTREGA — default do 54+email deve
# ser ENTREGUE_COM_FALTA_PEDIR_ROMANEIO (pede romaneio+descrição/valor), não o
# FALTA_DE_VOLUME (pré-entrega, não pede nada). E o override tem de REPATCHAR o todo
# 54+email já existente (não só INSERT). E o executor resolve as variáveis do template
# (link_evidencia/n_volumes_falta) — nunca placeholder literal.
INV32_OC19DEF=$(grep -c 'enviar_email_template: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO"' supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV32_REPATCH=$(grep -c "repatcharTemplateEmail54Existente" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV32_RENDER=$(grep -cE "n_volumes_falta: nVolumesFalta|link_evidencia: linkEvidencia" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV32_BANNER:-0}" -ge 2 ] && [ "${INV32_GUARD:-0}" -ge 1 ] && [ "${INV32_PRED:-0}" -ge 1 ] && [ "${INV32_TPL_RULE:-0}" -ge 2 ] && [ "${INV32_TPL_AGENT:-0}" -ge 1 ] && [ "${INV32_SCAN:-0}" -ge 1 ] && [ "$INV32_TEST" = "1" ] && [ "${INV32_TEST2:-0}" -ge 3 ] && [ "${INV32_OC19DEF:-0}" -ge 1 ] && [ "${INV32_REPATCH:-0}" -ge 2 ] && [ "${INV32_RENDER:-0}" -ge 2 ]; then
  echo "INV-032 (código): PASS"
else
  echo "INV-032 (código): FAIL (banner_preserva=$INV32_BANNER guard=$INV32_GUARD pred_lag=$INV32_PRED tpl_regra=$INV32_TPL_RULE tpl_agente=$INV32_TPL_AGENT scan_extravio=$INV32_SCAN teste=$INV32_TEST teste_banner=$INV32_TEST2 oc19_default=$INV32_OC19DEF repatch=$INV32_REPATCH render_vars=$INV32_RENDER — pós-49 extravio regrediu: banner apagado pelo Pass D / template 54+email genérico / OU (NF 609867) oc=19 voltou a FALTA_DE_VOLUME / repatch do todo existente sumiu / executor não resolve link_evidencia|n_volumes_falta; NF 705764/609867)"
fi

# INV-033: banner "EMAIL BLOQUEADO" mostra razão SMTP LEGÍVEL, nunca blob hex
# (bug B, NF 575330 HDL LOGISTICA / Larissa). Raiz: extração de motivo/destinatário
# do bounce usava `/(550...)/` sobre o 1º text/plain e ignorava o part estruturado
# `message/delivery-status` → em NDR Microsoft/Exchange capturava diagnóstico hex.
# Fix: parse-bounce-ndr.ts lê delivery-status PRIMEIRO (Diagnostic-Code /
# Final-Recipient), com fallback GUARDADO contra hex (razão real tem letra > f).
INV33_PARSER=$([ -f supabase/functions/_shared/parse-bounce-ndr.ts ] && echo 1 || echo 0)
INV33_WIRE=$(grep -c "parseBounceNdr(flattenPartsDecoded" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
# O regex ingênuo antigo NÃO pode voltar a alimentar o payload do bounce.
INV33_NOOLD=$(grep -c 'motivoMatch = conteudoBounce.match(/(550' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV33_TEST=$(deno test --no-check supabase/functions/_shared/parse-bounce-ndr.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# Item 4a: idempotência por gmail_message_id (não re-processa o mesmo bounce).
INV33_IDEMP=$(grep -c 'payload->>gmail_message_id' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
# Item 4b: banner obsoleto quando há outbound posterior ao bounce.
INV33_STALE=$(grep -c 'BounceDetectadoIgnorado' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV33_OUTB=$(grep -c 'cards_emails_outbound' supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
# Parser forense da investigação A (guard próprio).
INV33_FORENSE=$(deno test --no-check supabase/functions/_shared/bounce-forensics.test.ts >/dev/null 2>&1 && echo ok || echo fail)
if [ "${INV33_PARSER:-0}" = "1" ] && [ "${INV33_WIRE:-0}" -ge 1 ] && [ "${INV33_NOOLD:-0}" -eq 0 ] && [ "$INV33_TEST" = "ok" ] && [ "${INV33_IDEMP:-0}" -ge 1 ] && [ "${INV33_STALE:-0}" -ge 1 ] && [ "${INV33_OUTB:-0}" -ge 1 ] && [ "$INV33_FORENSE" = "ok" ]; then
  echo "INV-033: PASS"
else
  echo "INV-033: FAIL (parser=$INV33_PARSER wire=$INV33_WIRE regex_antigo=$INV33_NOOLD teste=$INV33_TEST idemp=$INV33_IDEMP banner_obsoleto=$INV33_STALE outbound=$INV33_OUTB forense=$INV33_FORENSE — banner de bounce: hex / duplicado / stale pós re-envio; NF 575330 HDL)"
fi

# INV-034: extravio PARCIAL — oc 33 de COMPLETUDE exige romaneio + descrição +
# valor; combo 33+44 OPERACIONAL (Caso 2) exige só romaneio; extravio TOTAL não
# regride (só romaneio). Gate global (modo AVISADO) nos 2 finalizadores + enforce
# autoritativo no executor (flag extravio_parcial_gate_enforce). NF 66193 INOVAMED.
INV34_MOD=$([ -f supabase/functions/_shared/extravio-parcial-dossie.ts ] && echo 1 || echo 0)
INV34_TEST=$(deno test --no-check supabase/functions/_shared/extravio-parcial-dossie.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# Gate plugado nos DOIS finalizadores + no executor (enforce autoritativo).
INV34_PROP=$(grep -c "aplicarGateOc33Parcial\|decidirGateOc33\|gate_oc33" supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV34_REGRA=$(grep -c "decidirGateOc33\|gate_oc33\|ehExtravioParcial" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
INV34_EXEC=$(grep -c "gateOc33Enforce" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Corte-em-70 nos handlers de oc 33 NÃO pode voltar (descrição/valor truncava).
INV34_NO70=$(grep -c "texto33.slice(0, 70)\|oc33Texto = ((extras\[\"oc33_texto\"\] as string | undefined)?.trim() ?? \"\").slice(0, 70)" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Enforce autoritativo respeita a flag + o escape do operador.
INV34_FLAG=$(grep -c "extravio_parcial_gate_enforce" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34_FORCE=$(grep -c "forcar_oc33_dossie_incompleto" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Fase 2 (NF 66193): HOTFIX — interpretador NUNCA seleciona gmail_message_id como
# COLUNA de messages_inbox (não existe; fica em raw_payload). Deve ser 0.
INV34_HOTFIX=$(grep -c "recebido_em, gmail_message_id" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
# sync-bastao PRESERVA o dossiê em update/reabertura. Refatorado 2026-07-03:
# mesclarExtravioParcial → preservarExtravioParcial (_shared/preservar-extravio-
# parcial.ts); o check aceita os dois nomes (fix Caio 2026-07-17 — grep do nome
# antigo dava falso FAIL desde o refactor).
INV34_SYNCPRES=$(grep -cE "preservarExtravioParcial|mesclarExtravioParcial" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
# reprocessar-anexos ignora deletado_em como ativo (ressuscita) via decidirReuploadAnexo.
INV34_REPROC=$(grep -c "decidirReuploadAnexo" supabase/functions/reprocessar-anexos-mensagem/index.ts 2>/dev/null | tr -d ' ')
# Sub-caso Tier B-DV (Caso 2) no agente-ressarcimento + testes puros novos.
INV34_CASO2=$(grep -c "detectarPedirDescricaoValor" supabase/functions/agente-ressarcimento-relancar-54/index.ts 2>/dev/null | tr -d ' ')
INV34_REUSO=$(deno test --no-check supabase/functions/_shared/reuso-anexo.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# B-DV 54+email NUNCA vira 54 sem e-mail: guard autoritativo no executor.
INV34_BDVGUARD=$(grep -c "deveBloquear54PedirDescValor" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
# Seed HISTÓRICO do romaneio (Codex 2026-07-02, NF 575330): o dossiê NÃO pode
# marcar falso "faltando romaneio" quando o romaneio chegou ANTES do dossiê
# nascer. Interpretador semeia via montarSeedRomaneio; executor materializa a
# 2ª oc 33 POR FONTE (fonte="ssw" NÃO reanexa nem bloqueia) via decidirAcaoRomaneioCompletude.
INV34_SEED=$(grep -c "montarSeedRomaneio" supabase/functions/interpretador-resposta-cliente/index.ts 2>/dev/null | tr -d ' ')
INV34_FONTEGUARD=$(grep -c "decidirAcaoRomaneioCompletude" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV34_MOD:-0}" = "1" ] && [ "$INV34_TEST" = "ok" ] && [ "${INV34_PROP:-0}" -ge 1 ] && [ "${INV34_REGRA:-0}" -ge 1 ] && [ "${INV34_EXEC:-0}" -ge 1 ] && [ "${INV34_NO70:-0}" -eq 0 ] && [ "${INV34_FLAG:-0}" -ge 1 ] && [ "${INV34_FORCE:-0}" -ge 1 ] && [ "${INV34_HOTFIX:-0}" -eq 0 ] && [ "${INV34_SYNCPRES:-0}" -ge 1 ] && [ "${INV34_REPROC:-0}" -ge 1 ] && [ "${INV34_CASO2:-0}" -ge 1 ] && [ "$INV34_REUSO" = "ok" ] && [ "${INV34_BDVGUARD:-0}" -ge 1 ] && [ "${INV34_SEED:-0}" -ge 1 ] && [ "${INV34_FONTEGUARD:-0}" -ge 1 ]; then
  echo "INV-034: PASS"
else
  echo "INV-034: FAIL (mod=$INV34_MOD teste=$INV34_TEST prop=$INV34_PROP regra=$INV34_REGRA exec=$INV34_EXEC corte70=$INV34_NO70 flag=$INV34_FLAG force=$INV34_FORCE hotfix_gmail=$INV34_HOTFIX syncpres=$INV34_SYNCPRES reproc=$INV34_REPROC caso2=$INV34_CASO2 reuso=$INV34_REUSO bdvguard=$INV34_BDVGUARD seed=$INV34_SEED fonteguard=$INV34_FONTEGUARD — extravio parcial regrediu: gate/corte-em-70, OU Fase 2: select gmail_message_id inexistente voltou / sync-bastao não preserva dossiê / reprocessar-anexos não ressuscita / Tier B-DV sumiu / B-DV 54+email sem guard de destinatário, OU seed histórico do romaneio sumiu / executor não materializa por fonte; NF 66193/575330)"
fi

# INV-034b (Caio 2026-07-17, NF 135724 DUILIO): materialização UNIVERSAL da oc 33
# de completude + guard da conversão PDF. Regressões travadas: (a) executor voltar
# a curto-circuitar por anexo do operador (jaTemAnexo suprimia até o TEXTO de
# desc/valor — a NF 135724 saiu no SSW só com "Reversão de perdas iniciada.");
# (b) materialização voltar a ser só-Caso-2 (100% dos lançamentos reais são caso 1);
# (c) front perder o guard que impede scan JBIG2 quase-em-branco de subir pro SSW.
INV34B_MAT=$(grep -c "montarTextoOc33ComOperador" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_UNIV=$(grep -c "deveMaterializarCompletude" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_CURTO=$(grep -c "jaTemAnexo" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_FLAGNOVA=$(grep -c "extravio_parcial_materializacao_enabled" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_PDFMIME=$(grep -c "ehImagemMimeSsw" supabase/functions/executor/index.ts 2>/dev/null | tr -d ' ')
INV34B_GUARDF=$(grep -c "avaliarPaginaConvertida" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV34B_TEST=$(deno test --allow-all --no-check supabase/functions/_shared/extravio-parcial-dossie.test.ts 2>/dev/null | grep -q "0 failed" && echo ok || echo fail)
if [ "${INV34B_MAT:-0}" -ge 2 ] && [ "${INV34B_UNIV:-0}" -ge 2 ] && [ "${INV34B_CURTO:-0}" -eq 0 ] && [ "${INV34B_FLAGNOVA:-0}" -ge 2 ] && [ "${INV34B_PDFMIME:-0}" -ge 2 ] && [ "${INV34B_GUARDF:-0}" -ge 1 ] && [ "$INV34B_TEST" = "ok" ]; then
  echo "INV-034b: PASS"
else
  echo "INV-034b: FAIL (mat=$INV34B_MAT univ=$INV34B_UNIV curto_circuito=$INV34B_CURTO flag_nova=$INV34B_FLAGNOVA pdf_mime=$INV34B_PDFMIME guard_front=$INV34B_GUARDF teste=$INV34B_TEST — NF 135724 pode regredir: oc 33 de completude sem desc/valor no SSW, PDF cru como foto, ou conversão quebrada subindo calada)"
fi

# INV-035 (Caio 2026-07-20, NF 335713 MOTO FEST / 232346 DAMASIO, DUILIO):
# email_sem_oc (skip_oc = "notificar cliente por e-mail SEM lançar ocorrência") NÃO
# pode cancelar as propostas de lançamento (49/54/55) do card de extravio — elas
# seguem disponíveis pro operador lançar quando o cliente responder. Duas camadas:
# (a) código — alguma migration mantém o guard skip_oc no RPC aprovar_e_executar;
# (b) SQL — nenhum card EXTRAVIO_MONITORADO com email_sem_oc executado tem irmãs
# de lançamento auto-canceladas.
INV35_CODE=$(grep -rl "IF NOT v_skip_oc THEN" migration/ 2>/dev/null | wc -l | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then
  INV35_SQL="SKIP"
else
  INV35_SQL=$(psql "$SUPABASE_DB_URL" -tAc "select count(distinct c.id) from cards c join todos ex on ex.card_id=c.id and ex.status='executado' and (ex.proposta_payload#>>'{meta,acao}')='email_sem_oc' join todos irm on irm.card_id=c.id and irm.status='cancelado' and irm.rejection_reason='Auto-cancelado: outra opção foi aprovada no mesmo card' and (irm.proposta_payload#>>'{meta,origem}')='extravio_cockpit' and (irm.proposta_payload#>>'{meta,acao}')<>'email_sem_oc' where c.state='EXTRAVIO_MONITORADO';" 2>/dev/null | tr -d ' ')
fi
if [ "${INV35_CODE:-0}" -ge 1 ] && { [ "$INV35_SQL" = "SKIP" ] || [ "${INV35_SQL:-1}" = "0" ]; }; then
  echo "INV-035: PASS (code=$INV35_CODE sql=$INV35_SQL)"
else
  echo "INV-035: FAIL (code=$INV35_CODE sql=$INV35_SQL — email_sem_oc voltou a cancelar as propostas de lançamento do extravio; mig 299, NF 335713/232346)"
fi

# INV-036 (Caio 2026-07-21, onboarding KAROLINE/Larissa e futuros): invariantes de
# carteira que impedem "card sumindo/conflito" em qualquer reatribuição de operador.
#   (a) Nenhum CNPJ em 2+ carteiras de operadores ATIVOS ("1 CNPJ = 1 operador";
#       2 carteiras → resolver retorna ambíguo → card órfão, invisível exceto gestor).
#   (b) Nenhum card NÃO-terminal com assigned_operator_id apontando pra operador
#       inativo OU dormente (cockpit_ativo=false) → card invisível exceto gestor.
# Ambos são SQL (produção). Fonte: audit-card-routing 2026-06-27 + operador-resolver.ts.
if [ -z "$SUPABASE_DB_URL" ]; then
  echo "INV-036: SKIP (sem acesso ao DB local — rodar onde \$SUPABASE_DB_URL resolve)"
else
  INV36_DUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select cnpj from (select unnest(carteira) cnpj from operadores where ativo) t group by cnpj having count(*) > 1) d;" 2>/dev/null | tr -d ' ')
  INV36_ORFAO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c join operadores o on o.id=c.assigned_operator_id where c.state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO') and (o.ativo=false or o.cockpit_ativo=false);" 2>/dev/null | tr -d ' ')
  if [ "${INV36_DUP:-1}" = "0" ] && [ "${INV36_ORFAO:-1}" = "0" ]; then
    echo "INV-036: PASS (0 CNPJ em 2 carteiras ativas, 0 card vivo em operador dormente)"
  else
    echo "INV-036: FAIL (cnpj_em_2_carteiras=$INV36_DUP, cards_vivos_em_operador_dormente=$INV36_ORFAO — regressão de onboarding: card vira órfão/conflito; ver docs/operadoras/karoline/PLANO_ONBOARDING.md e operador-resolver.ts)"
  fi
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
