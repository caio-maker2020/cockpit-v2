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
- LOC adicionada razoável pro escopo?

### 6.1 — Guard de segredos (automatizado, NÃO é pergunta manual)

Era item de checklist manual ("algum .env foi commitado por engano?") e por isso
não travava nada. Caso-âncora 2026-08-06: o arquivo de segredos chegou da nuvem
como `env.download`, nome que o `.gitignore` da época não cobria — ficou untracked,
a um `git add .` de publicar service_role key, PAT, senha do Postgres,
`ANTHROPIC_API_KEY` e senha do SSW no repo **público**
`github.com/caio-maker2020/cockpit-v2`.

```bash
# (a) hook instalado? Sem isso as duas camadas de proteção não rodam.
test "$(git config core.hooksPath)" = ".githooks" \
  && echo "OK hooksPath" || { echo "FAIL: rode  git config core.hooksPath .githooks"; }
test -x .githooks/pre-commit && echo "OK hook executável" || echo "FAIL: chmod +x .githooks/pre-commit"

# (b) o hook realmente bloqueia? (auto-teste — não confiar que "está lá")
printf 'k=sk-ant-api03-%s\n' "$(printf 'A%.0s' {1..30})" > .verify_secret_probe.txt
git add -f .verify_secret_probe.txt 2>/dev/null
bash .githooks/pre-commit >/dev/null 2>&1 \
  && echo "FAIL: hook NÃO bloqueou segredo de teste" || echo "OK hook bloqueia"
git restore --staged .verify_secret_probe.txt 2>/dev/null; rm -f .verify_secret_probe.txt

# (c) nenhum segredo em arquivo rastreado, em NENHUM commit do histórico
for p in 'sk-ant-api03-' 'sbp_[a-f0-9]\{40\}' 'postgresql://postgres[^ ]*:[^@ ]*@'; do
  n=$(git log --all --oneline -S "$p" --pickaxe-regex 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] && echo "OK histórico limpo: $p" || { echo "FAIL: $n commit(s) com $p"; git log --all --oneline -S "$p" --pickaxe-regex | head -5; }
done

# (d) nenhum arquivo de ambiente rastreado (exceto os .env.example).
#     Regex ancorada no NOME do arquivo de propósito: um `grep 'env'` solto no
#     caminho acusa `supabase/functions/enviar-resposta/` e `EnvBanner.tsx`.
git ls-files | grep -iE '(^|/)(\.env([^/]*)?|env(\.[^/]*)?|[^/]+\.env)$' \
  | grep -v '\.env\.example$' \
  && echo "FAIL: arquivo de ambiente rastreado acima" || echo "OK nenhum env rastreado"
```

Status: PASS só se (a), (b), (c) e (d) derem OK.
Se (c) falhar, **rotacionar a credencial** antes de qualquer coisa — reescrever
histórico não desfaz exposição de um repo público.

## Fase 7 — Deploy state

### 7.0 — Sanidade do deploy-gate (rodar ANTES de qualquer deploy)

Um gate que bloqueia deploy legítimo é tão ruim quanto um que não bloqueia nada:
some a confiança nele e alguém passa a usar `DEPLOY_GATE_ACK=1` por reflexo.
Caso-âncora 2026-08-06: em máquina Windows o hook lia o manifest com o encoding
do locale (cp1252), o marcador `Separação 54/59` virava mojibake e **100% dos
deploys eram bloqueados** por falso positivo. Este check pega a volta disso.

```bash
export CLAUDE_PROJECT_DIR="$PWD"
H=.claude/hooks/cockpit-deploy-gate.py
T=$(mktemp -d)
# O gate casa com a substring literal `functions deploy` no comando. Se ela
# aparecer aqui, o hook dispara sobre o PRÓPRIO teste e o check nunca roda
# (acontece de verdade quando o /verify-cockpit é executado via Bash).
# Montar por variável mantém a substring fora do texto do comando.
D=dep; D="${D}loy"
printf '{"tool_name":"Bash","tool_input":{"command":"supabase functions %s executor"}}' "$D" > "$T/ok.json"
printf '{"tool_name":"Bash","tool_input":{"command":"supabase functions %s atualizar-card-via-tracking"}}' "$D" > "$T/proibida.json"

python3 "$H" < "$T/ok.json" >/dev/null 2>&1
[ $? -eq 0 ] && echo "OK gate libera deploy legítimo" || echo "FAIL: falso positivo — gate bloqueia deploy válido (checar encoding=utf-8 no hook)"

python3 "$H" < "$T/proibida.json" >/dev/null 2>&1
[ $? -eq 2 ] && echo "OK gate bloqueia função proibida" || echo "FAIL: gate deixou passar função proibida"

# Todo marcador do manifest tem de existir no fonte, lendo AMBOS em utf-8.
python3 - <<'PY'
import json
man = json.load(open('.claude/deploy-guards.json', encoding='utf-8'))
ruim = 0
for arq, marcadores in man.get('guards', {}).items():
    try:
        src = open(arq, encoding='utf-8', errors='replace').read()
    except FileNotFoundError:
        print(f"FAIL: manifest aponta arquivo inexistente: {arq}"); ruim += 1; continue
    for m in marcadores:
        if m not in src:
            print(f"FAIL: marcador ausente: {m!r} em {arq}"); ruim += 1
print("OK todos os marcadores do manifest presentes" if not ruim else f"{ruim} problema(s)")
PY
rm -rf "$T"
```

Status: PASS só se as três linhas derem OK.

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
# Limiar configurável (Duílio 2026-07-28, mig 313): o agente resolve o dia de
# lançamento por card (cliente > operador > 4), NÃO mais coluna_kanban="D4" fixa.
# Guard: usa resolverDiasAutonomoExtravio + o D4 hardcoded sumiu + teste do
# limiar passa. Regressão que trava: voltar o "D4" fixo (ignora FELIPE=2/PRATI=2).
INV22_LIMIAR=$(grep -c "resolverDiasAutonomoExtravio" supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
INV22_NOD4=$(grep -c '"coluna_kanban", "D4"' supabase/functions/agente-extravio-d4/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/dias-autonomo-extravio.test.ts >/dev/null 2>&1 && INV22_LIMIAR_TEST=ok || INV22_LIMIAR_TEST=fail
if [ "$INV22_REGRA" -ge 2 ] && [ "$INV22_NOHAS" -eq 0 ] && [ "$INV22_ENVELOPE" -ge 1 ] && [ "$INV22_DIRETO" -eq 0 ] && [ "$INV22_SKIP" -ge 1 ] && [ "$INV22_TEST" = "ok" ] && [ "${INV22_LIMIAR:-0}" -ge 1 ] && [ "${INV22_NOD4:-1}" -eq 0 ] && [ "$INV22_LIMIAR_TEST" = "ok" ]; then
  echo "INV-022 (código): PASS (limiar=$INV22_LIMIAR nod4=$INV22_NOD4 limiar_test=$INV22_LIMIAR_TEST)"
else
  echo "INV-022 (código): FAIL (regra=$INV22_REGRA noHas=$INV22_NOHAS envelope=$INV22_ENVELOPE direto=$INV22_DIRETO skip=$INV22_SKIP teste=$INV22_TEST limiar=$INV22_LIMIAR nod4_deve_ser_0=$INV22_NOD4 limiar_test=$INV22_LIMIAR_TEST)"
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
# Monitor do INV-023 (alerta zumbi NF 371705, 2026-08-07): health-check usa o módulo
# compartilhado com a lista COMPLETA de saídas do INDEFINIDO_RETRY + teste âncora.
INV23_MON_USO=$(grep -c "acharIndefinidosPresos\|EVENTOS_MONITOR_INDEFINIDO" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
INV23_MON_SAIDAS=$(grep -c "AguardandoClienteOcMudou" supabase/functions/_shared/inv023-indefinido-preso.ts 2>/dev/null | tr -d ' ')
deno test --no-check --allow-env supabase/functions/_shared/inv023-indefinido-preso.test.ts >/dev/null 2>&1 && INV23_MON_TEST=ok || INV23_MON_TEST=fail
if [ "${INV23_MON_USO:-0}" -ge 2 ] && [ "${INV23_MON_SAIDAS:-0}" -ge 1 ] && [ "$INV23_MON_TEST" = "ok" ]; then
  echo "INV-023 (monitor): PASS (uso=$INV23_MON_USO saidas=$INV23_MON_SAIDAS test=$INV23_MON_TEST)"
else
  echo "INV-023 (monitor): FAIL (uso=$INV23_MON_USO saidas=$INV23_MON_SAIDAS test=$INV23_MON_TEST — monitor de indefinido preso deve usar _shared/inv023-indefinido-preso com todas as saídas; alerta zumbi NF 371705)"
fi
INV23_BOUNCE=$($PSQL "$SUPABASE_DB_URL" -tA -c "
  with ult as (select distinct on (card_id) card_id, codigo_oc oc_lancada,
    (iniciado_em at time zone 'America/Sao_Paulo')::date data_lanc
    from acoes_executadas_ssw where sucesso=true order by card_id, iniciado_em desc)
  select count(*) from cards c join ult u on u.card_id=c.id
  where c.state='AGUARDANDO_VALIDACAO_HUMANA' and c.lock_aguardando_validacao=true
    and c.cliente_respondeu_em is null
    and coalesce(c.bastao_data_ultima_ocorrencia,'1900-01-01') < u.data_lanc
    and u.oc_lancada not in (10,11,17,19,20,23,26,28,35,43,49,52);" 2>/dev/null | tr -d ' ')
    # < (estritamente antes) = bounce-back CLARO (lag). Mesmo-dia é decidido pela
    # VERDADE DO SSW POR HORA (decidirReaberturaPorSsw) — não conta aqui.
    # (comentário em `#`: com `--` eram linhas bash inválidas e abortavam a Fase 8 após o INV-022)
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

# INV-037 (Caio 2026-07-21, onboarding Karoline): auto-encaminhamento da resposta
# do cliente pra caixa Gmail do NOVO dono quando o card foi reatribuído. Blindado
# (nunca derruba o poll) + flag + dedup. Três camadas:
#   (a) código: o gmail-poll-inbox CHAMA encaminharRespostaSeReatribuido (hook vivo);
#   (b) teste: a decisão pura deveEncaminhar (só reatribuído + flag on) passa;
#   (c) DB: feature flag + tabela de idempotência existem.
INV37_HOOK=$(grep -c "await encaminharRespostaSeReatribuido(" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/encaminhar-email-reatribuido.test.ts >/dev/null 2>&1 && INV37_TEST=ok || INV37_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV37_DB="SKIP"
else
  INV37_DB=$($PSQL "$SUPABASE_DB_URL" -tAc "select case when exists(select 1 from feature_flags where key='email_forward_reatribuido_ativo') and exists(select 1 from information_schema.tables where table_name='emails_encaminhados_operador') then 'ok' else 'faltando' end;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV37_HOOK:-0}" -ge 1 ] && [ "$INV37_TEST" = "ok" ] && { [ "$INV37_DB" = "ok" ] || [ "$INV37_DB" = "SKIP" ]; }; then
  echo "INV-037: PASS (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB)"
else
  echo "INV-037: FAIL (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB — auto-forward de card reatribuido regrediu; mig 302, _shared/encaminhar-email-reatribuido.ts, gmail-poll-inbox hook)"
fi

# INV-037 (Caio 2026-07-21, onboarding Karoline): auto-encaminhamento da resposta
# do cliente pra caixa Gmail do NOVO dono quando o card foi reatribuído. Blindado
# (nunca derruba o poll) + flag + dedup. Três camadas:
#   (a) código: o gmail-poll-inbox CHAMA encaminharRespostaSeReatribuido (hook vivo);
#   (b) teste: a decisão pura deveEncaminhar (só reatribuído + flag on) passa;
#   (c) DB: feature flag + tabela de idempotência existem.
INV37_HOOK=$(grep -c "await encaminharRespostaSeReatribuido(" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/encaminhar-email-reatribuido.test.ts >/dev/null 2>&1 && INV37_TEST=ok || INV37_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV37_DB="SKIP"
else
  INV37_DB=$($PSQL "$SUPABASE_DB_URL" -tAc "select case when exists(select 1 from feature_flags where key='email_forward_reatribuido_ativo') and exists(select 1 from information_schema.tables where table_name='emails_encaminhados_operador') then 'ok' else 'faltando' end;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV37_HOOK:-0}" -ge 1 ] && [ "$INV37_TEST" = "ok" ] && { [ "$INV37_DB" = "ok" ] || [ "$INV37_DB" = "SKIP" ]; }; then
  echo "INV-037: PASS (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB)"
else
  echo "INV-037: FAIL (hook=$INV37_HOOK test=$INV37_TEST db=$INV37_DB — auto-forward de card reatribuido regrediu; mig 302, _shared/encaminhar-email-reatribuido.ts, gmail-poll-inbox hook)"
fi

# INV-037 (Caio 2026-07-21, NF 292727 KAROLINE / 143905 DUILIO): separação 54/59
# no FRONT PRÓPRIO. A oc 59 (RETORNO INDENIZAÇÃO, split da 54 — regra deployada
# 14/07, memória regra-oc59-separacao-54-59) é "aguardando cliente" igual à 54:
# respondida vai pra coluna CLIENTE RESPONDEU. Regressões travadas:
# (a) kanban voltar a hardcodar `=== 54` nas colunas (o bug original);
# (b) OCS_AGUARDANDO_CLIENTE sumir/perder a 59;
# (c) front perder o combo 44+59 (proposta ficava invisível + aprovação sem
#     volumes/motivo falhava no executor);
# (d) teste kanban-oc59 sumir ou falhar.
INV37_CONST=$(grep -c "OCS_AGUARDANDO_CLIENTE" apps/cockpit-web/src/lib/types.ts 2>/dev/null | tr -d ' ')
INV37_59=$(grep -c "54, 59" apps/cockpit-web/src/lib/types.ts 2>/dev/null | tr -d ' ')
INV37_HARD=$(sed -n '/id: "validacao"/,/id: "acao_executada"/p' apps/cockpit-web/src/lib/types.ts 2>/dev/null | grep -c "== 54" | tr -d ' ')
INV37_COMBO=$(grep -c "lancar_combo_44_59" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV37_TEST=$(cd apps/cockpit-web 2>/dev/null && npx vitest run src/lib/kanban-oc59.test.ts --reporter=basic >/dev/null 2>&1 && echo ok || echo fail)
# (e) BACKEND: atualizar-card-via-portal-ssw trata oc 59 como aguardando-cliente
# (hotfix 21/07 — regressão real: função re-deployada do master pré-59 mandava
# card 59 pra TRANSFERIDO no Forçar Atualização; NF 292727/25416). Se este grep
# zerar, o hotfix foi perdido (ex.: regularização removeu sem trazer OCS_CLIENTE).
INV37_BACK=$(grep -c "ehOc59Cliente" supabase/functions/atualizar-card-via-portal-ssw/index.ts 2>/dev/null | tr -d ' ')
if [ "${INV37_CONST:-0}" -ge 2 ] && [ "${INV37_59:-0}" -ge 1 ] && [ "${INV37_HARD:-0}" -eq 0 ] && [ "${INV37_COMBO:-0}" -ge 3 ] && [ "$INV37_TEST" = "ok" ] && [ "${INV37_BACK:-0}" -ge 4 ]; then
  echo "INV-037: PASS"
else
  echo "INV-037: FAIL (const=$INV37_CONST lista54_59=$INV37_59 hardcode54_colunas=$INV37_HARD combo4459=$INV37_COMBO teste=$INV37_TEST backend_atualizar_card=$INV37_BACK — separação 54/59 regrediu no front: card 59 respondido vai voltar a ficar preso em 'Aguardando você'; NF 292727/143905)"
fi

# INV-038 (Caio 2026-07-21, rename ISA E KAROL→ISABELY / CAMILA→FELIPE, migs 304/305):
# drift de NOME de operador entre Cockpit e Bastão + "nada fica órfão". O match
# do resolver (Path 2) e do trigger cards_resolve_operator é por igualdade de
# operadores.nome; quando o Bastão renomeia e o Cockpit não (ou vice-versa),
# card fora de carteira vira órfão invisível. Desde a mig 305, cascata esgotada
# cai no operador com recebe_cards_orfaos=true (ISABELY). Checks:
#   (a) SQL: 0 cards NÃO-terminais com responsavel_relacionamento preenchido e
#       assigned_operator_id NULL (órfão de resolução — sintoma dos 2 cards
#       ISABELY em 2026-07-21);
#   (b) SQL: 0 cards NÃO-terminais cujo responsavel_relacionamento não bate com
#       nome de operador ATIVO (texto velho pós-rename → some de filtro por
#       nome, assinatura de e-mail errada);
#   (c) SQL: exatamente 1 operador-fallback ativo+cockpit_ativo (se ISABELY for
#       desativada sem repassar a flag, o fallback morre em silêncio e os
#       órfãos voltam);
#   (d) código: operador-resolver.test.ts passa (fallback_orfao + precedência +
#       dormente/blacklist preservados + normalizarCodigoSegmento).
deno test supabase/functions/_shared/operador-resolver.test.ts >/dev/null 2>&1 && INV38_TEST=ok || INV38_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV38_ORFAO=SKIP; INV38_STALE=SKIP; INV38_FB=SKIP
else
  INV38_ORFAO=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO') and responsavel_relacionamento is not null and length(trim(responsavel_relacionamento))>0 and assigned_operator_id is null;" 2>/dev/null | tr -d ' ')
  INV38_STALE=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c where c.state not in ('RESOLVIDO','CANCELADO','TRANSFERIDO') and c.responsavel_relacionamento is not null and length(trim(c.responsavel_relacionamento))>0 and not exists (select 1 from operadores o where o.ativo and upper(o.nome)=upper(trim(c.responsavel_relacionamento)));" 2>/dev/null | tr -d ' ')
  INV38_FB=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where recebe_cards_orfaos and ativo and cockpit_ativo;" 2>/dev/null | tr -d ' ')
fi
if [ "$INV38_TEST" = "ok" ] && { [ "$INV38_ORFAO" = "SKIP" ] || { [ "${INV38_ORFAO:-1}" = "0" ] && [ "${INV38_STALE:-1}" = "0" ] && [ "${INV38_FB:-0}" = "1" ]; }; }; then
  echo "INV-038: PASS (test=$INV38_TEST, 0 órfão de resolução, 0 nome defasado, 1 operador-fallback)"
else
  echo "INV-038: FAIL (test=$INV38_TEST orfaos_resolucao=$INV38_ORFAO nome_defasado=$INV38_STALE operador_fallback=$INV38_FB — drift de nome Cockpit×Bastão ou fallback morto; ver migs 304/305, operador-resolver.ts Paths 2-4, trigger cards_resolve_operator)"
fi

# INV-039 (Caio 2026-07-21): DEPLOY-GATE ativo. Um lote de 19 funções deployado
# de commit desatualizado regrediu o vinculador (3ª regressão pré-59 do dia).
# O hook cockpit-deploy-gate.py BLOQUEIA: checkout atrás do origin/master, working
# tree sujo em supabase/, marcador crítico ausente (deploy-guards.json) e função
# proibida. Este INV confere que o mecanismo segue armado (payload montado por
# concatenação pra não disparar o gate deste próprio script).
INV39_HOOK=$(test -f .claude/hooks/cockpit-deploy-gate.py && echo 1 || echo 0)
INV39_REG=$(grep -c "cockpit-deploy-gate" .claude/settings.json 2>/dev/null | tr -d ' ')
INV39_MANIF=$(python3 -c "import json; m=json.load(open('.claude/deploy-guards.json')); print(len(m.get('guards',{})))" 2>/dev/null)
INV39_CMD="supabase functions ""dep""loy atualizar-card-via-tracking"
INV39_BLOQ=$(printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$INV39_CMD" | python3 .claude/hooks/cockpit-deploy-gate.py >/dev/null 2>&1; [ $? -eq 2 ] && echo ok || echo fail)
if [ "$INV39_HOOK" = "1" ] && [ "${INV39_REG:-0}" -ge 1 ] && [ "${INV39_MANIF:-0}" -ge 5 ] && [ "$INV39_BLOQ" = "ok" ]; then
  echo "INV-039: PASS (deploy-gate armado: hook+settings+manifest($INV39_MANIF guards)+bloqueio funcional)"
else
  echo "INV-039: FAIL (hook=$INV39_HOOK settings=$INV39_REG manifest=$INV39_MANIF bloqueio=$INV39_BLOQ — deploy-gate desarmado: risco de regressão por deploy desatualizado voltou)"
fi

# INV-040 (Caio 2026-07-21, NF 2084 — 74 cards fabricados em rajada 14-15/07):
# loop de fabricação do sync × UNIQUE parcial. Card que NASCE/vira terminal sai
# do uniq_cards_nf_active e o ciclo seguinte recria — 1 card por ciclo (~30min)
# enquanto a pendência durar no Bastão (30 cards nasceram DIRETO em TRANSFERIDO
# com evento único BastaoCardImportado; a alternância de CTRC AMB↔TTO encerrava
# o card ativo a cada ciclo). Guard: bloquearCriacaoSeLoopDetectado
# (_shared/guard-anti-loop-criacao.ts) bloqueia criação com ≥3 cards TERMINAIS
# da NF criados em 24h + emite LoopCriacaoCardDetectado (dedupe 24h, fail-open).
# Dossiê: audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md. Checks:
#   (a) código: guard importado + chamado nos 2 pontos de criação do sync
#       (handleExtravioPendencia e upsertCardFromPendencia) — ≥3 ocorrências;
#   (b) código: guard-anti-loop-criacao.test.ts passa (4ª criação em 24h
#       bloqueada + evento de anomalia + dedupe + fail-open);
#   (c) SQL: nenhuma NF com >3 cards criados nas últimas 24h (rajada ativa
#       em produção = guard furado ou caminho de criação novo sem guard).
INV40_GREP=$(grep -c "bloquearCriacaoSeLoopDetectado" supabase/functions/sync-bastao/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/guard-anti-loop-criacao.test.ts >/dev/null 2>&1 && INV40_TEST=ok || INV40_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV40_RAJADA=SKIP
else
  INV40_RAJADA=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select nf from cards where created_at >= now() - interval '24 hours' and nf is not null group by nf having count(*) > 3) t;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV40_GREP:-0}" -ge 3 ] && [ "$INV40_TEST" = "ok" ] && { [ "$INV40_RAJADA" = "SKIP" ] || [ "${INV40_RAJADA:-1}" = "0" ]; }; then
  echo "INV-040: PASS (guard=$INV40_GREP ocorrências no sync, test=$INV40_TEST, NFs em rajada 24h=$INV40_RAJADA)"
else
  echo "INV-040: FAIL (guard=$INV40_GREP test=$INV40_TEST rajada_24h=$INV40_RAJADA — guard anti-loop ausente/removido do sync-bastao OU NF fabricando >3 cards/24h em produção; dossiê audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md)"
fi

# INV-041 (Caio 2026-07-22, NF 556392 FELIPE + NF 51712 ISABELY): aprovação com
# e-mail NUNCA às cegas + aval de evidência acessível + airbag armado.
# O botão ⭐ RECOMENDADA aprovava direto com extras=null → operador não via a
# janela de edição e o aval "enviar sem evidência" (ocs 10/11/35) ficava
# inacessível (executor bloqueava sem saída). 2ª regressão desse aval (1ª na
# era Lovable). E sem ErrorBoundary, crash de render = tela branca morta sem
# stack. Checks:
#   (a) decisão pura decidir-clique-aprovacao.ts existe + ProposedActions usa
#       (import + onClick do ⭐ RECOMENDADA) — ≥2 ocorrências;
#   (b) decidir-clique-aprovacao.test.ts passa (e-mail→modal, combo→modal,
#       sem-email→direto, payload nulo);
#   (c) aval skip_evidencia gateado por [10, 11, 35] nas DUAS superfícies de
#       e-mail: EditarEmailModal E BannerInline54Composer;
#   (d) airbag: main.tsx envolve <App /> com <ErrorBoundary>.
INV41_DEC=$(test -f apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts && echo 1 || echo 0)
INV41_USO=$(grep -c "decidirCliqueAprovacao" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
(cd apps/cockpit-web && npx vitest run src/lib/decidir-clique-aprovacao.test.ts) >/dev/null 2>&1 && INV41_TEST=ok || INV41_TEST=fail
INV41_MODAL=$(grep -c "\[10, 11, 35\]" apps/cockpit-web/src/components/cards/EditarEmailModal.tsx 2>/dev/null | tr -d ' ')
INV41_COMP=$(grep -cE "skip_evidencia|\[10, 11, 35\]" apps/cockpit-web/src/components/cards/BannerInline54Composer.tsx 2>/dev/null | tr -d ' ')
INV41_AIRBAG=$(grep -c "<ErrorBoundary>" apps/cockpit-web/src/main.tsx 2>/dev/null | tr -d ' ')
if [ "$INV41_DEC" = "1" ] && [ "${INV41_USO:-0}" -ge 2 ] && [ "$INV41_TEST" = "ok" ] && [ "${INV41_MODAL:-0}" -ge 2 ] && [ "${INV41_COMP:-0}" -ge 2 ] && [ "${INV41_AIRBAG:-0}" -ge 1 ]; then
  echo "INV-041: PASS (decisão=$INV41_DEC uso=$INV41_USO test=$INV41_TEST modal=$INV41_MODAL composer=$INV41_COMP airbag=$INV41_AIRBAG)"
else
  echo "INV-041: FAIL (decisão=$INV41_DEC uso=$INV41_USO test=$INV41_TEST modal=$INV41_MODAL composer=$INV41_COMP airbag=$INV41_AIRBAG — aprovação às cegas OU aval de evidência OU airbag regrediu; ver docs/INVARIANTES_COCKPIT.md INV-041)"
fi

# INV-042 (Caio 2026-07-23, NF 73220 LARISSA — premissa final):
#   1. resposta + card ATIVO → move, SEMPRE;
#   2. TRANSFERIDO/RESOLVIDO = tratado → anexa SEM mover (nunca reabre);
#      se a NF tem card ativo, a resposta é roteada pra ele;
#   3. card novo criado depois entra na premissa 1.
# Caso âncora: romaneio da 73220 mudo 7 dias. Checks:
#   (a) fonte única _shared/acionamento-resposta-cliente.ts existe;
#   (b) vinculador usa nos DOIS caminhos (import + thread + nf ≥3 ocorrências);
#   (c) testes da fonte única passam (terminal→reabre, AVH preservado, etc);
#   (d) watchdog checkRespostaClienteEngolida armado no health-check
#       (definição + registro na lista de checks);
#   (e) SQL: nenhuma resposta engolida AGORA em produção (RespostaClienteCapturada
#       >20min com card ainda terminal sem carimbo).
INV42_FONTE=$(test -f supabase/functions/_shared/acionamento-resposta-cliente.ts && echo 1 || echo 0)
INV42_USO=$(grep -c "decidirAcionamentoPorRespostaCliente" supabase/functions/vinculador/index.ts 2>/dev/null | tr -d ' ')
# Corrida do TRANSFERIDO transitório (Duílio 2026-07-28, NFs 1494200/174873/20219):
# o vinculador PRECISA passar acaoCockpitRecente (ação SSW recente = card ainda no
# fluxo) nos DOIS call-sites que podem engolir — senão resposta legítima em card
# transiente-TRANSFERIDO (Bastão ainda não sincronizou a oc 54) vira muda de novo.
INV42_TRANSITORIO=$(grep -c "acaoCockpitRecente" supabase/functions/vinculador/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/acionamento-resposta-cliente.test.ts >/dev/null 2>&1 && INV42_TEST=ok || INV42_TEST=fail
INV42_WD=$(grep -c "checkRespostaClienteEngolida" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then
  INV42_ENG=SKIP
else
  # Correção Caio 23/07 (2ª rodada): critério é "resposta MUDA", não o estado —
  # inclui AGUARDANDO_CLIENTE (NF 73220 destravada na mão saiu de TRANSFERIDO
  # mas a resposta seguia muda). Guard: outbound da operadora posterior à
  # captura = fluxo legítimo de revert, não conta.
  # Critério POR EVENTO (executor zera cliente_respondeu_em → carimbo não
  # distingue engolida de tratada), SÓ CARDS ATIVOS (premissa 2: silêncio em
  # terminal é correto). Exclusões: processada depois (RetornoClienteEmAguardo/
  # ação) e outbound da operadora depois.
  INV42_ENG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events e join cards c on c.id=e.card_id where e.event_type='RespostaClienteCapturada' and e.created_at > now() - interval '24 hours' and e.created_at < now() - interval '20 minutes' and c.state in ('AGUARDANDO_CLIENTE','ACAO_EXECUTADA') and not exists (select 1 from card_events p where p.card_id=c.id and p.event_type in ('RetornoClienteEmAguardo','AprovacaoOperador','AcaoExecutada') and p.created_at >= e.created_at - interval '1 minute') and not exists (select 1 from cards_emails_outbound o where o.card_id=c.id and o.sent_at > e.created_at);" 2>/dev/null | tr -d ' ')
fi
if [ "$INV42_FONTE" = "1" ] && [ "${INV42_USO:-0}" -ge 3 ] && [ "${INV42_TRANSITORIO:-0}" -ge 3 ] && [ "$INV42_TEST" = "ok" ] && [ "${INV42_WD:-0}" -ge 2 ] && { [ "$INV42_ENG" = "SKIP" ] || [ "${INV42_ENG:-1}" = "0" ]; }; then
  echo "INV-042: PASS (fonte=$INV42_FONTE uso=$INV42_USO transitorio=$INV42_TRANSITORIO test=$INV42_TEST watchdog=$INV42_WD engolidas_24h=$INV42_ENG)"
else
  echo "INV-042: FAIL (fonte=$INV42_FONTE uso=$INV42_USO test=$INV42_TEST watchdog=$INV42_WD engolidas_24h=$INV42_ENG — reabertura por resposta de cliente regrediu OU há resposta muda em produção; ver docs/INVARIANTES_COCKPIT.md INV-042)"
fi

# INV-043 (Caio 2026-07-23, NF 389040 DUILIO): camada de CAPTURA viva — toda
# caixa Gmail com credencial tem rodada de leitura recente. Classe cega pro
# INV-042 (que só enxerga após RespostaClienteCapturada). Caso âncora: rodízio
# do gmail-poll v60 lia embed como array → 7/9 caixas com zero leituras →
# resposta do cliente parada NO GMAIL (capturas/dia DUILIO: 43 → 1). Checks:
#   (a) fonte única do rodízio existe e o gmail-poll usa (lastPollAtDoEmbed +
#       ordenarPorDefasagem, >=2 ocorrências) + fatia por caixa presente;
#   (b) testes do rodízio passam (embed OBJETO ordena; DUILIO antes de JULIA);
#   (c) watchdog checkCaixaGmailSemPoll armado no health-check;
#   (d) SQL: nenhuma caixa com credencial sem rodada há >2h.
INV43_USO=$(grep -cE "lastPollAtDoEmbed|ordenarPorDefasagem" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV43_FATIA=$(grep -c "FATIA_POR_CAIXA_MS" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/gmail-poll-batch.test.ts >/dev/null 2>&1 && INV43_TEST=ok || INV43_TEST=fail
INV43_WD=$(grep -c "checkCaixaGmailSemPoll" supabase/functions/health-check/index.ts 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then
  INV43_FAM=SKIP
else
  INV43_FAM=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores o left join gmail_polling_state g on g.operador_id=o.id where o.gmail_oauth_credentials is not null and (g.last_poll_at is null or g.last_poll_at < now() - interval '2 hours');" 2>/dev/null | tr -d ' ')
fi
if [ "${INV43_USO:-0}" -ge 2 ] && [ "${INV43_FATIA:-0}" -ge 2 ] && [ "$INV43_TEST" = "ok" ] && [ "${INV43_WD:-0}" -ge 2 ] && { [ "$INV43_FAM" = "SKIP" ] || [ "${INV43_FAM:-1}" = "0" ]; }; then
  echo "INV-043: PASS (rodizio=$INV43_USO fatia=$INV43_FATIA test=$INV43_TEST watchdog=$INV43_WD famintas_2h=$INV43_FAM)"
else
  echo "INV-043: FAIL (rodizio=$INV43_USO fatia=$INV43_FATIA test=$INV43_TEST watchdog=$INV43_WD famintas_2h=$INV43_FAM — rodízio/fatia do gmail-poll regrediu OU caixa faminta em produção; ver docs/INVARIANTES_COCKPIT.md INV-043)"
fi

# INV-044 (Matheus 2026-07-23, causa-2 / ADR 0015): memória de avaliação por
# mensagem — o poller NÃO pode voltar a re-fetchar no Gmail toda msg não-casada
# a cada rodada (backlog perpétuo: sac 436/julia 427/larissa 410; last_success
# travado em junho). Checks:
#   (a) helpers puros existem e o gmail-poll usa (mapaMemoAvaliacao +
#       setDeGmailMessageIds importados/usados, >=2 ocorrências);
#   (b) a otimização é FLAG-GATED (flagMemoAvaliacaoOn presente) → OFF = byte
#       idêntico ao anterior, garantia anti-regressão de captura;
#   (c) testes dos helpers do memo passam (mapaMemoAvaliacao/setDeGmailMessageIds);
#   (d) a flag existe como row em feature_flags (SQL — não exige estar ligada).
INV44_USO=$(grep -cE "mapaMemoAvaliacao|setDeGmailMessageIds" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV44_FLAG=$(grep -c "flagMemoAvaliacaoOn" supabase/functions/gmail-poll-inbox/index.ts 2>/dev/null | tr -d ' ')
INV44_TEST=$(grep -cE "mapaMemoAvaliacao|setDeGmailMessageIds" supabase/functions/_shared/gmail-poll-batch.test.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/gmail-poll-batch.test.ts >/dev/null 2>&1 && INV44_TESTOK=ok || INV44_TESTOK=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV44_ROW=SKIP
else
  INV44_ROW=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from feature_flags where key='gmail_poll_memo_avaliacao_ativo';" 2>/dev/null | tr -d ' ')
fi
if [ "${INV44_USO:-0}" -ge 2 ] && [ "${INV44_FLAG:-0}" -ge 2 ] && [ "$INV44_TESTOK" = "ok" ] && [ "${INV44_TEST:-0}" -ge 2 ] && { [ "$INV44_ROW" = "SKIP" ] || [ "${INV44_ROW:-0}" -ge 1 ]; }; then
  echo "INV-044: PASS (uso=$INV44_USO flag=$INV44_FLAG test=$INV44_TESTOK guard_test=$INV44_TEST flag_row=$INV44_ROW)"
else
  echo "INV-044: FAIL (uso=$INV44_USO flag=$INV44_FLAG test=$INV44_TESTOK guard_test=$INV44_TEST flag_row=$INV44_ROW — memória de avaliação do gmail-poll regrediu OU perdeu o gate de flag; ver ADR 0015 / migration 306)"
fi

# INV-044 (Caio 2026-07-23, print FELIPE + tela branca NF 556392/Bug A): o app
# NUNCA pode ser traduzível pelo navegador. Google Tradutor reescreve nós de
# texto por fora do React → NotFoundError removeChild ao desmontar (bug
# clássico React#11538); lang="en" num app pt-BR era o convite. Prova: print
# do FELIPE com o texto do airbag REESCRITO ("quebrou"→"CORTE", "pra"→"para").
INV44_LANG=$(grep -c 'lang="pt-BR"' apps/cockpit-web/index.html 2>/dev/null | tr -d ' ')
INV44_NOTR=$(grep -cE 'translate="no"|name="google" content="notranslate"' apps/cockpit-web/index.html 2>/dev/null | tr -d ' ')
if [ "${INV44_LANG:-0}" -ge 1 ] && [ "${INV44_NOTR:-0}" -ge 2 ]; then
  echo "INV-044: PASS (lang pt-BR=$INV44_LANG, notranslate=$INV44_NOTR)"
else
  echo "INV-044: FAIL (lang=$INV44_LANG notranslate=$INV44_NOTR — app voltou a ser traduzível; classe removeChild/tela-branca reaberta; ver docs/INVARIANTES_COCKPIT.md INV-044)"
fi

# INV-045 (Caio 2026-07-23, NF 814961 DUILIO): anexo não-suportado FORA da
# seleção dos modais oc=33. A ratoeira era: pré-seleção cega do 1º anexo (gif
# de assinatura) + checkbox desabilitado (impossível desmarcar) + validação
# bloqueante ("Remova: X") = beco sem saída. Checks:
#   (a) fonte única lib/anexos-ssw-elegiveis.ts existe + ProposedActions usa
#       (import + 2 pré-seleções = >=3 ocorrências);
#   (b) testes passam (âncora: 1º anexo gif → pré-seleciona o PDF);
#   (c) pré-seleção cega extinta (zero `anexosInbound[0].id`);
#   (d) validação não bloqueia mais (zero `Remova:` no arquivo).
INV45_USO=$(grep -c "primeiroAnexoSuportadoSsw" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
(cd apps/cockpit-web && npx vitest run src/lib/anexos-ssw-elegiveis.test.ts) >/dev/null 2>&1 && INV45_TEST=ok || INV45_TEST=fail
INV45_CEGA=$(grep -c "anexosInbound\[0\].id" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV45_MURO=$(grep -c "Remova:" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
if [ "${INV45_USO:-0}" -ge 3 ] && [ "$INV45_TEST" = "ok" ] && [ "${INV45_CEGA:-1}" = "0" ] && [ "${INV45_MURO:-1}" = "0" ]; then
  echo "INV-045: PASS (uso=$INV45_USO test=$INV45_TEST preselecao_cega=$INV45_CEGA muro=$INV45_MURO)"
else
  echo "INV-045: FAIL (uso=$INV45_USO test=$INV45_TEST preselecao_cega=$INV45_CEGA muro=$INV45_MURO — ratoeira do anexo não-suportado voltou; ver docs/INVARIANTES_COCKPIT.md INV-045)"
fi

# INV-046 (Caio 2026-07-23, NF 62566 LARISSA): oc 41/56 NUNCA lança sem o
# texto do operador — 3ª regressão da classe aprovação-às-cegas. 3 camadas:
#   (a) front: rota abrir-input na fonte única (⭐ RECOMENDADA abre o painel
#       de texto existente) + teste;
#   (b) backend fail-closed: camposObrigatoriosAusentes exige texto_descricao
#       pra 41/56 (executor bloqueia com erro visível) + teste;
#   (c) SQL: nenhuma aprovação de 41/56 nas últimas 24h com extras sem texto.
INV46_FRONT=$(grep -cE "abrir-input|OCS_COM_INPUT_OBRIGATORIO" apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts 2>/dev/null | tr -d ' ')
INV46_ROTA=$(grep -c "abrir-input" apps/cockpit-web/src/components/cards/ProposedActions.tsx 2>/dev/null | tr -d ' ')
INV46_BACK=$(grep -cE "OCS_TEXTO_OBRIGATORIO|texto_descricao" supabase/functions/_shared/descricao-ssw.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/descricao-ssw.test.ts >/dev/null 2>&1 && INV46_TEST=ok || INV46_TEST=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV46_MUDAS=SKIP
else
  INV46_MUDAS=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from card_events where event_type='AprovacaoOperador' and created_at > now() - interval '24 hours' and payload->'proposta_payload'->>'acao_key' in ('lancar_ocorrencia:41','lancar_ocorrencia:56') and coalesce(trim(payload->'extras'->>'texto_descricao'),'') = '';" 2>/dev/null | tr -d ' ')
fi
if [ "${INV46_FRONT:-0}" -ge 3 ] && [ "${INV46_ROTA:-0}" -ge 1 ] && [ "${INV46_BACK:-0}" -ge 3 ] && [ "$INV46_TEST" = "ok" ] && { [ "$INV46_MUDAS" = "SKIP" ] || [ "${INV46_MUDAS:-1}" = "0" ]; }; then
  echo "INV-046: PASS (front=$INV46_FRONT rota=$INV46_ROTA back=$INV46_BACK test=$INV46_TEST aprovacoes_sem_texto_24h=$INV46_MUDAS)"
else
  echo "INV-046: FAIL (front=$INV46_FRONT rota=$INV46_ROTA back=$INV46_BACK test=$INV46_TEST sem_texto_24h=$INV46_MUDAS — 41/56 voltou a lançar sem texto; ver docs/INVARIANTES_COCKPIT.md INV-046)"
fi

# INV-047 (Caio 2026-07-23, NF 1100040 LARISSA): extravio parcial com trilha
# de indenização destaca 59; e o par 59+email SEMPRE no cardápio das regras
# de tratativa (49/26/23/43). Checks:
#   (a) helper temContextoIndenizacao existe + agente-sugere usa (>=2);
#   (b) testes do helper (âncora 1100040 + anti-falso-positivo);
#   (c) regras têm >=5 entradas codigo_ssw_proposto: 59 (19 + as 4 da família).
INV47_USO=$(grep -c "temContextoIndenizacao" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/contexto-indenizacao.test.ts >/dev/null 2>&1 && INV47_TEST=ok || INV47_TEST=fail
INV47_PAR=$(grep -c "codigo_ssw_proposto: 59," supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
#   (d) repatch converte o TRILHO completo na re-análise 54↔59 (NF 1100040:
#       destaque :59 com todo :54 = 'ação não está mais pendente');
#   (e) FORÇAR ATUALIZAÇÃO re-dispara o agente (decisão nunca fica em cache).
INV47_TRILHO=$(grep -c "mudouTrilho" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
deno test --allow-env supabase/functions/_shared/repatch-trilho.test.ts >/dev/null 2>&1 && INV47_RTEST=ok || INV47_RTEST=fail
INV47_REDISPARO=$(grep -c "agente-sugere-ocs-padrao" supabase/functions/atualizar-card-via-portal-ssw/index.ts 2>/dev/null | tr -d ' ')
#   (f) invalidação AUTOMÁTICA por versão de regra (Caio 23/07: 'sem trabalho
#       manual') — VERSAO_REGRAS_ANALISE carimbada + check (d) no cron.
INV47_VERSAO=$(grep -c "VERSAO_REGRAS_ANALISE" supabase/functions/agente-sugere-ocs-padrao/index.ts 2>/dev/null | tr -d ' ')
#   (g) 4 OPÇÕES invioláveis (Caio 23/07): card AVH com oc 49 tem as 4
#       acao_keys ativas (54±email, 59±email); override aposentado (identidade)
#       e repatch nunca converte. Detector do relançamento testado.
INV47_APOSENTADA=$(grep -c "APOSENTADA" supabase/functions/_shared/regras-auto-acao.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/contexto-indenizacao.test.ts >/dev/null 2>&1 && INV47_RELANCE=ok || INV47_RELANCE=fail
if [ -z "$SUPABASE_DB_URL" ]; then
  INV47_4OP=SKIP
else
  INV47_4OP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from cards c where c.state='AGUARDANDO_VALIDACAO_HUMANA' and c.cod_ultima_ocorrencia=49 and (select count(distinct t.proposta_payload->>'acao_key') from todos t where t.card_id=c.id and t.status in ('pendente','aprovado') and t.proposta_payload->>'acao_key' in ('lancar_oc_e_enviar_email:54','lancar_ocorrencia:54','lancar_oc_e_enviar_email:59','lancar_ocorrencia:59')) < 4;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV47_USO:-0}" -ge 2 ] && [ "$INV47_TEST" = "ok" ] && [ "${INV47_PAR:-0}" -ge 5 ] && [ "${INV47_TRILHO:-0}" -ge 0 ] && [ "$INV47_RTEST" = "ok" ] && [ "${INV47_REDISPARO:-0}" -ge 1 ] && [ "${INV47_VERSAO:-0}" -ge 3 ] && [ "${INV47_APOSENTADA:-0}" -ge 1 ] && [ "$INV47_RELANCE" = "ok" ] && { [ "$INV47_4OP" = "SKIP" ] || [ "${INV47_4OP:-1}" = "0" ]; }; then
  echo "INV-047: PASS (uso=$INV47_USO test=$INV47_TEST par59=$INV47_PAR rtest=$INV47_RTEST redisparo=$INV47_REDISPARO versao=$INV47_VERSAO aposentada=$INV47_APOSENTADA relance=$INV47_RELANCE cards_49_sem_4opcoes=$INV47_4OP)"
else
  echo "INV-047: FAIL (uso=$INV47_USO test=$INV47_TEST par59=$INV47_PAR rtest=$INV47_RTEST redisparo=$INV47_REDISPARO versao=$INV47_VERSAO aposentada=$INV47_APOSENTADA relance=$INV47_RELANCE 49_sem_4op=$INV47_4OP — 4-opções/relançamento/versão regrediu; ver docs/INVARIANTES_COCKPIT.md INV-047)"
fi

# INV-048 (Caio 2026-07-23, planilha "Relacionamento Atualizado" / mig 307):
# carteiras e roteamento por segmento seguem a planilha. Regressões que este
# guard trava: (a) CNPJ em 2 carteiras (quebra "1 CNPJ = 1 operador");
# (b) segmentos revertidos (LARISSA voltou a ter 007/010, KAROLINE/MARIA
# perderam os seus); (c) âncoras de carteira desfeitas (DIAGNOSTICA voltou pra
# LARISSA; NORTEL saiu da INGRID; MARIA perdeu a carteira dormente);
# (d) SAL EXP (blacklist ativa) entrou em carteira. Fonte auditável:
# data/relacionamento-atualizado-2026-07-23.xlsx + gerador em
# scripts/import_relacionamento_atualizado.py.
INV48_XLSX=$([ -f data/relacionamento-atualizado-2026-07-23.xlsx ] && echo 1 || echo 0)
if [ -z "$SUPABASE_DB_URL" ]; then
  INV48_DUP=SKIP; INV48_SEG=SKIP; INV48_ANC=SKIP; INV48_BLK=SKIP
else
  INV48_DUP=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select c from (select unnest(carteira) c from operadores) s group by c having count(*)>1) d;" 2>/dev/null | tr -d ' ')
  INV48_SEG=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where (nome='LARISSA' and segmentos='{018}') or (nome='KAROLINE' and segmentos='{007,010}') or (nome='MARIA' and segmentos='{040,042}');" 2>/dev/null | tr -d ' ')
  INV48_ANC=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where (nome='KAROLINE' and '11462456000270'=any(carteira)) or (nome='INGRID' and '46044053005417'=any(carteira)) or (nome='MARIA' and coalesce(array_length(carteira,1),0)>=23);" 2>/dev/null | tr -d ' ')
  INV48_BLK=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from operadores where '86392529000466'=any(carteira);" 2>/dev/null | tr -d ' ')
fi
if [ "$INV48_XLSX" = "1" ] && { [ "$INV48_DUP" = "SKIP" ] || { [ "${INV48_DUP:-1}" = "0" ] && [ "${INV48_SEG:-0}" = "3" ] && [ "${INV48_ANC:-0}" = "3" ] && [ "${INV48_BLK:-1}" = "0" ]; }; }; then
  echo "INV-048: PASS (xlsx=$INV48_XLSX dup_carteira=$INV48_DUP segmentos=$INV48_SEG/3 ancoras=$INV48_ANC/3 blacklist_fora=$INV48_BLK)"
else
  echo "INV-048: FAIL (xlsx=$INV48_XLSX dup_carteira=$INV48_DUP segmentos=$INV48_SEG/3 ancoras=$INV48_ANC/3 blacklist_fora=$INV48_BLK — carteiras/segmentos divergiram da planilha Relacionamento Atualizado 2026-07-23; ver migration/2026-07-23_307_relacionamento_atualizado.sql)"
fi

# INV-049 (Caio 2026-07-24, incidente divergInfo): o front TEM typecheck real
# no caminho até produção. Contexto: 'tsc --noEmit' sem -p checa ZERO arquivos
# (tsconfig raiz é solution-style com files:[]) — foi assim que o popup F4
# renderizado no componente errado (ReferenceError: divergInfo) chegou em
# produção e travou TODOS os operadores. Regressões que este guard trava:
# (a) gate removido do script build (Vercel voltaria a deployar código que o
# TypeScript rejeita); (b) script typecheck apontando pro tsconfig vazio;
# (c) erro de tipo real no src (o check roda de verdade, não é grep).
# NUNCA aceitar 'tsc --noEmit' sem -p como evidência de tipos OK.
INV49_GATE=$(grep -c '"build": "npm run typecheck && vite build"' apps/cockpit-web/package.json)
INV49_CFG=$(grep -c '"typecheck": "tsc --noEmit -p tsconfig.app.json"' apps/cockpit-web/package.json)
if (cd apps/cockpit-web && npx tsc --noEmit -p tsconfig.app.json >/dev/null 2>&1); then INV49_TSC=0; else INV49_TSC=1; fi
if [ "$INV49_GATE" = "1" ] && [ "$INV49_CFG" = "1" ] && [ "$INV49_TSC" = "0" ]; then
  echo "INV-049: PASS (gate_no_build=$INV49_GATE cfg_real=$INV49_CFG erros_tsc=$INV49_TSC)"
else
  echo "INV-049: FAIL (gate_no_build=$INV49_GATE cfg_real=$INV49_CFG erros_tsc=$INV49_TSC — typecheck do front removido/furado ou erro de tipo no src; ver docs/INVARIANTES_COCKPIT.md INV-049)"
fi

# INV-050 (Caio 2026-07-24, NFs 158084 DUILIO + 1094294 LARISSA): o item
# ⭐ RECOMENDADA roteia pra JANELA que a ação exige, e o popup F4 só dispara
# contra a sugestão VIGENTE. Regressões que este guard trava: (a) rota
# modal-oc33-solo removida do decidirCliqueAprovacao (⭐ volta a aprovar oc33
# às cegas com anexos_ids=[] → executor reverte); (b) roteador ⭐ sem handler
# pros destinos de modal; (c) beco do painel: ramo ⭐ voltando a early-return
# incondicional (clique em 41/44/55/56 recomendada não abre nada); (d) endosso
# da sugestão vigente removido do detector (popup falso contra banner velho,
# suja o dataset do loop F5).
INV50_ROTA=$(grep -c '"modal-oc33-solo"' apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts)
INV50_HANDLER=$(grep -c 'destino === "modal-oc33-solo"' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV50_PAINEL=$(grep -c 'requerInput && isExpandido' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV50_ENDOSSO=$(grep -c 'sugere_oc33_solo' apps/cockpit-web/src/lib/divergencia.ts)
INV50_ORIGEM=$(grep -c 'vinculador_pos_resposta_cliente' apps/cockpit-web/src/lib/divergencia.ts)
INV50_TEST=$(grep -c '158084' apps/cockpit-web/src/lib/divergencia.test.ts apps/cockpit-web/src/lib/decidir-clique-aprovacao.test.ts | awk -F: '{s+=$2} END {print (s>=2) ? 2 : s}')
if [ "${INV50_ROTA:-0}" -ge 1 ] && [ "${INV50_HANDLER:-0}" -ge 1 ] && [ "${INV50_PAINEL:-0}" -ge 1 ] && [ "${INV50_ENDOSSO:-0}" -ge 1 ] && [ "${INV50_ORIGEM:-0}" -ge 1 ] && [ "${INV50_TEST:-0}" -ge 2 ]; then
  echo "INV-050: PASS (rota=$INV50_ROTA handler=$INV50_HANDLER painel=$INV50_PAINEL endosso=$INV50_ENDOSSO origem=$INV50_ORIGEM testes_ancora=$INV50_TEST/2)"
else
  echo "INV-050: FAIL (rota=$INV50_ROTA handler=$INV50_HANDLER painel=$INV50_PAINEL endosso=$INV50_ENDOSSO origem=$INV50_ORIGEM testes_ancora=$INV50_TEST/2 — recomendada↔janela ou divergência-vigente regrediu; ver docs/INVARIANTES_COCKPIT.md INV-050)"
fi

# INV-051 (Caio 2026-07-25, rejeição acidental da Isadora 24/07): decisão
# humana na fila de melhorias F6 é sempre CONFIRMADA, VISÍVEL e REVERSÍVEL.
# Contexto: proposta do comprovante legível rejeitada sem querer 21s após a
# resposta; card dizia "aguardando SUA aprovação" pro próprio autor; fila só
# mostra aberto e revisar_learning_log só permite aberto→final → correção
# impossível, revisões invisíveis pro Caio. Regressões que este guard trava:
# (a) confirmação do Rejeitar removida (volta o 1-clique acidental);
# (b) rótulo "aguardando sua aprovação" de volta (induz o autor a decidir);
# (c) trilha de revisadas/Reabrir removida (decisão de outro gestor invisível
# e sem undo); (d) testes puros de INV-051 quebrados (podeReabrir deixando
# terminais aplicado/revertido reabrirem, etc.).
INV51_CONFIRM=$(grep -c 'confirmandoRejeicao' apps/cockpit-web/src/pages/Aprendizado.tsx)
INV51_ROTULO_RUIM=$(grep -c 'aguardando sua aprova' apps/cockpit-web/src/pages/Aprendizado.tsx)
INV51_TRILHA=$(grep -c 'reabrir_learning_log' apps/cockpit-web/src/pages/Aprendizado.tsx)
INV51_RPC=$(grep -c "tipo <> 'ajuste_sugerido'" migration/2026-07-25_312_reabrir_learning_log_e_retroativo.sql)
if (cd apps/cockpit-web && npx vitest run src/lib/melhorias.test.ts >/dev/null 2>&1); then INV51_TEST=0; else INV51_TEST=1; fi
if [ "${INV51_CONFIRM:-0}" -ge 2 ] && [ "${INV51_ROTULO_RUIM:-1}" = "0" ] && [ "${INV51_TRILHA:-0}" -ge 1 ] && [ "${INV51_RPC:-0}" -ge 1 ] && [ "$INV51_TEST" = "0" ]; then
  echo "INV-051: PASS (confirm=$INV51_CONFIRM rotulo_enganoso=$INV51_ROTULO_RUIM trilha_reabrir=$INV51_TRILHA rpc_restrita=$INV51_RPC testes=$INV51_TEST)"
else
  echo "INV-051: FAIL (confirm=$INV51_CONFIRM rotulo_enganoso=$INV51_ROTULO_RUIM trilha_reabrir=$INV51_TRILHA rpc_restrita=$INV51_RPC testes=$INV51_TEST — fila F6 voltou a ser 1-clique irreversível/invisível; ver docs/INVARIANTES_COCKPIT.md INV-051)"
fi

# INV-052 (Caio 2026-07-25, auditoria ultracode — onda 1): os 5 fixes que
# travavam operação. Regressões que este guard trava: (a) regra da oc no
# acionamento removida (terminal transitório volta a engolir resposta —
# NFs 150431/174438); (b) isenção do relançamento pós-resposta removida
# (sync volta a comer 100% dos relançamentos); (c) cobertura do romaneio por
# filename removida (assinatura PNG volta a lançar oc33 sem romaneio);
# (d) filtro deletado_em das queries dos modais removido (anexo morto volta
# ao cardápio); (e) guards de idempotência do scan removidos (loop de
# re-adoção NF 2549 volta). + SQL vivo: resposta muda em card ativo = 0.
INV52_OC=$(grep -c 'ocPertenceAoCockpit' supabase/functions/_shared/acionamento-resposta-cliente.ts)
INV52_RELANC=$(grep -c 'ehPropostaPosRespostaMesmaOc' supabase/functions/sync-bastao/index.ts)
INV52_ROM=$(grep -c 'anexosCobremRomaneio' supabase/functions/executor/index.ts)
INV52_DEL=$(grep -c '"deletado_em", null' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV52_SCAN=$(grep -c 'ja_decidido' supabase/functions/scan-email-pre-card/index.ts)
INV52_TEST=$(grep -c '150431' supabase/functions/_shared/acionamento-resposta-cliente.test.ts)
if [ -z "$SUPABASE_DB_URL" ]; then INV52_MUDAS=SKIP; else
  INV52_MUDAS=$($PSQL "$SUPABASE_DB_URL" -tA -c "WITH m AS (SELECT e.card_id, max(e.created_at) mute_em FROM card_events e WHERE e.event_type='RespostaClienteEmCardTransferido' AND e.created_at > now() - interval '24 hours' GROUP BY 1) SELECT count(*) FROM m JOIN cards c ON c.id=m.card_id WHERE c.state NOT IN ('TRANSFERIDO','RESOLVIDO','CANCELADO') AND NOT EXISTS (SELECT 1 FROM card_events r WHERE r.card_id=m.card_id AND r.event_type='RetornoClienteEmAguardo' AND r.created_at > m.mute_em);" 2>/dev/null | tr -d ' ')
fi
if [ "${INV52_OC:-0}" -ge 2 ] && [ "${INV52_RELANC:-0}" -ge 2 ] && [ "${INV52_ROM:-0}" -ge 2 ] && [ "${INV52_DEL:-0}" -ge 2 ] && [ "${INV52_SCAN:-0}" -ge 2 ] && [ "${INV52_TEST:-0}" -ge 1 ] && { [ "$INV52_MUDAS" = "SKIP" ] || [ "${INV52_MUDAS:-1}" = "0" ]; }; then
  echo "INV-052: PASS (oc=$INV52_OC relanc=$INV52_RELANC rom=$INV52_ROM del=$INV52_DEL scan=$INV52_SCAN test=$INV52_TEST mudas_24h=$INV52_MUDAS)"
else
  echo "INV-052: FAIL (oc=$INV52_OC relanc=$INV52_RELANC rom=$INV52_ROM del=$INV52_DEL scan=$INV52_SCAN test=$INV52_TEST mudas_24h=$INV52_MUDAS — onda 1 da auditoria 25/07 regrediu; ver docs/INVARIANTES_COCKPIT.md INV-052)"
fi

# INV-053 (Caio 2026-07-25, auditoria — onda 2): conversão JBIG2 ligada e
# aprovação nunca às cegas em NENHUMA superfície. Regressões: (a) wasmUrl
# removido do getDocument (scans JBIG2 voltam ao contorno manual) ou assets
# public/pdfjs-wasm dessincronizados do pacote (teste pdfjs-wasm-sync);
# (b) popup F4 voltando a registrar motivo ANTES da aprovação; (c) gêmeo
# sem-email voltando ao ⭐ genérico; (d) ProposalCard/TopBox aprovando sem
# rotear pela fonte única decidirCliqueAprovacao.
INV53_WASM=$(grep -c 'wasmUrl' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_ASSETS=$(ls apps/cockpit-web/public/pdfjs-wasm/ 2>/dev/null | wc -l | tr -d ' ')
INV53_POS=$(grep -c 'motivoDivergencia' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_GEMEO=$(grep -c 'ehGemeoSemEmailDestacado' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_PCARD=$(grep -c 'decidirCliqueAprovacao(payload' apps/cockpit-web/src/components/cards/ProposedActions.tsx)
INV53_TOPBOX=$(grep -c 'decidirCliqueAprovacao' apps/cockpit-web/src/components/cards/SugestaoIATopBox.tsx)
INV53_MEMO=$(grep -c 'metadataFalhou' supabase/functions/gmail-poll-inbox/index.ts)
if [ "${INV53_WASM:-0}" -ge 2 ] && [ "${INV53_ASSETS:-0}" -ge 5 ] && [ "${INV53_POS:-0}" -ge 3 ] && [ "${INV53_GEMEO:-0}" -ge 2 ] && [ "${INV53_PCARD:-0}" -ge 1 ] && [ "${INV53_TOPBOX:-0}" -ge 2 ] && [ "${INV53_MEMO:-0}" -ge 2 ]; then
  echo "INV-053: PASS (wasm=$INV53_WASM assets=$INV53_ASSETS pos=$INV53_POS gemeo=$INV53_GEMEO pcard=$INV53_PCARD topbox=$INV53_TOPBOX memo=$INV53_MEMO)"
else
  echo "INV-053: FAIL (wasm=$INV53_WASM assets=$INV53_ASSETS pos=$INV53_POS gemeo=$INV53_GEMEO pcard=$INV53_PCARD topbox=$INV53_TOPBOX memo=$INV53_MEMO — onda 2 da auditoria 25/07 regrediu; ver docs/INVARIANTES_COCKPIT.md INV-053)"
fi

# INV-054 (Caio 2026-07-25, auditoria — onda 3): sweep nunca atropela
# validação humana + rótulos honestos + F4 robusto.
INV54_LOCK=$(grep -c 'lock_aguardando_validacao"\] === true' supabase/functions/sync-bastao/index.ts)
INV54_TPL=$(grep -c 'ENTREGUE_COM_FALTA_PEDIR_ROMANEIO: ' apps/cockpit-web/src/components/cards/BannerSugestaoIA.tsx)
INV54_CHIP=$(grep -c 'Outro motivo (detalhe abaixo)' apps/cockpit-web/src/components/cards/DivergenciaMotivoDialog.tsx)
if [ "${INV54_LOCK:-0}" -ge 1 ] && [ "${INV54_TPL:-0}" -ge 1 ] && [ "${INV54_CHIP:-0}" -ge 1 ]; then
  echo "INV-054: PASS (lock=$INV54_LOCK tpl=$INV54_TPL chip=$INV54_CHIP)"
else
  echo "INV-054: FAIL (lock=$INV54_LOCK tpl=$INV54_TPL chip=$INV54_CHIP — onda 3 da auditoria 25/07 regrediu)"
fi

# INV-055 (Caio 2026-07-26, incidente de custo 4x num domingo): card com
# resposta de cliente NUNCA fica sem interpretação, e falha de leitura NUNCA
# vira loop infinito. Contexto: maxTokens=700 < resposta legítima do schema →
# JSON cortado → retry com o MESMO teto → 268 falhas → card sem sugestão →
# a fila de pendentes o devolvia a cada 5 min → 899 chamadas Anthropic sobre
# 11 mensagens ($31 num domingo). Regressões que este guard trava:
# (a) teto do interpretador voltando pra <=700 (trunca de novo);
# (b) retry sem dobrar o teto quando stop_reason=max_tokens (retry condenado);
# (c) reparo de JSON truncado removido (leitura parcial vira card órfão);
# (d) breaker por (card,mensagem) removido (loop infinito volta);
# (e) fallback determinístico removido (card fica "sem nada" — o que o Caio
#     proibiu explicitamente: não basta jogar pro operador).
INV55_TETO=$(grep -cE 'maxTokens: 1[0-9]{3}' supabase/functions/interpretador-resposta-cliente/index.ts)
INV55_RETRY=$(grep -c 'TETO_MAX_TOKENS_RETRY' supabase/functions/_shared/anthropic-client.ts)
INV55_REPARO=$(grep -c 'repararJsonTruncado' supabase/functions/_shared/anthropic-client.ts)
INV55_BREAKER=$(grep -c 'deveDesistirDoLlm' supabase/functions/interpretador-resposta-cliente/index.ts)
INV55_FALLBACK=$(grep -c 'montarSugestaoDegradada' supabase/functions/interpretador-resposta-cliente/index.ts)
if deno test --allow-env --no-check \
     supabase/functions/_shared/interpretador-degradacao.test.ts \
     supabase/functions/_shared/anthropic-client.test.ts >/dev/null 2>&1; then INV55_TEST=ok; else INV55_TEST=fail; fi
# DB: nenhuma mensagem sendo remoída (teto generoso: 10 chamadas na mesma msg/24h)
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV55_LOOP=$("$PSQL" "$SUPABASE_DB_URL" -tAc "SELECT count(*) FROM (SELECT message_id FROM anthropic_usage_log WHERE function_name='interpretador-resposta-cliente' AND created_at > now() - interval '24 hours' AND message_id IS NOT NULL GROUP BY message_id HAVING count(*) > 10) x;" 2>/dev/null | tr -d ' ')
else
  INV55_LOOP="SKIP"
fi
if [ "${INV55_TETO:-0}" -ge 1 ] && [ "${INV55_RETRY:-0}" -ge 1 ] && [ "${INV55_REPARO:-0}" -ge 2 ] && [ "${INV55_BREAKER:-0}" -ge 1 ] && [ "${INV55_FALLBACK:-0}" -ge 1 ] && [ "$INV55_TEST" = "ok" ] && { [ "$INV55_LOOP" = "SKIP" ] || [ "${INV55_LOOP:-1}" = "0" ]; }; then
  echo "INV-055: PASS (teto=$INV55_TETO retry=$INV55_RETRY reparo=$INV55_REPARO breaker=$INV55_BREAKER fallback=$INV55_FALLBACK testes=$INV55_TEST msgs_remoidas_24h=$INV55_LOOP)"
else
  echo "INV-055: FAIL (teto=$INV55_TETO retry=$INV55_RETRY reparo=$INV55_REPARO breaker=$INV55_BREAKER fallback=$INV55_FALLBACK testes=$INV55_TEST msgs_remoidas_24h=$INV55_LOOP — interpretador voltou a truncar/reprocessar em loop ou card pode ficar sem interpretação; ver docs/INVARIANTES_COCKPIT.md INV-055)"
fi

# INV-057 (Caio 2026-07-26, incidente da fila de adoção): thread pré-existente
# é importada UMA vez por card. Regressões que este guard trava: (a) trava
# decidirAdocaoThread removida do processarAdocaoJob (volta a re-importar a
# cada job repetido — 15.052 jobs/59 cards, NF 166229 105x/dia, IA 6x);
# (b) dreno dos repetidos removido (fila de adoção volta a levar ~21 dias);
# (c) SQL vivo: nenhuma thread importada 2x no MESMO card em 24h.
INV57_TRAVA=$(grep -c 'decidirAdocaoThread' supabase/functions/scan-email-pre-card/index.ts)
INV57_DRENO=$(grep -c 'ADOCAO_DRENO_MS' supabase/functions/scan-email-pre-card/index.ts)
INV57_TEST=$(grep -c '166229' supabase/functions/_shared/adocao-thread.test.ts 2>/dev/null | tr -d ' ')
if [ -z "$SUPABASE_DB_URL" ]; then INV57_REIMPORT=SKIP; else
  INV57_REIMPORT=$($PSQL "$SUPABASE_DB_URL" -tA -c "select count(*) from (select card_id, payload->>'gmail_thread_id' t from card_events where event_type='ThreadPreexistenteImportada' and created_at > now() - interval '24 hours' group by 1,2 having count(*) > 1) d;" 2>/dev/null | tr -d ' ')
fi
if [ "${INV57_TRAVA:-0}" -ge 2 ] && [ "${INV57_DRENO:-0}" -ge 2 ] && [ "${INV57_TEST:-0}" -ge 1 ] && { [ "$INV57_REIMPORT" = "SKIP" ] || [ "${INV57_REIMPORT:-1}" = "0" ]; }; then
  echo "INV-057: PASS (trava=$INV57_TRAVA dreno=$INV57_DRENO teste=$INV57_TEST reimportadas_24h=$INV57_REIMPORT)"
else
  echo "INV-057: FAIL (trava=$INV57_TRAVA dreno=$INV57_DRENO teste=$INV57_TEST reimportadas_24h=$INV57_REIMPORT — adoção voltou a re-importar thread; ver docs/INVARIANTES_COCKPIT.md INV-057)"
fi

# INV-058 (Caio 2026-07-26): TODA fila de trabalho tem vigia. O watchdog do
# health-check olhava só agent_executor/respostas_envio — scan_email_pre_card
# acumulou 94.084 msgs em 13 dias invisível. Regressão que este guard trava:
# fila sumindo da lista FILAS_VIGIADAS.
INV58_VIGIA=$(grep -c 'FILAS_VIGIADAS' supabase/functions/health-check/index.ts)
INV58_SCAN=$(grep -c 'fila: "scan_email_pre_card"' supabase/functions/health-check/index.ts)
INV58_ADOCAO=$(grep -c 'fila: "importar_thread_adotada"' supabase/functions/health-check/index.ts)
if [ "${INV58_VIGIA:-0}" -ge 2 ] && [ "${INV58_SCAN:-0}" -ge 1 ] && [ "${INV58_ADOCAO:-0}" -ge 1 ]; then
  echo "INV-058: PASS (vigia=$INV58_VIGIA scan=$INV58_SCAN adocao=$INV58_ADOCAO)"
else
  echo "INV-058: FAIL (vigia=$INV58_VIGIA scan=$INV58_SCAN adocao=$INV58_ADOCAO — fila de trabalho sem vigia; ver docs/INVARIANTES_COCKPIT.md INV-058)"
fi

# INV-059 (Duílio 2026-07-27, NF 22232): criar-card-manual com última oc FORA de
# relacionamento (ex.: 31 agendamento) só cria COM justificativa explícita do
# operador — nunca abre criação silenciosa fora de padrão. Checks:
#   (a) o gate usa a decisão pura decidirGateCriacaoManual (fonte única testada);
#   (b) o teste do helper passa (relacionamento sem motivo; fora-padrão exige motivo);
#   (c) auditoria: o backend grava fora_de_padrao no evento CardCriadoManualmente;
#   (d) front: ModalCriarCard oferece o motivo e reenvia motivo_fora_padrao.
INV59_GATE=$(grep -c "decidirGateCriacaoManual" supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
INV59_AUDIT=$(grep -c "fora_de_padrao" supabase/functions/criar-card-manual/index.ts 2>/dev/null | tr -d ' ')
deno test supabase/functions/_shared/gate-criacao-card-manual.test.ts >/dev/null 2>&1 && INV59_TEST=ok || INV59_TEST=fail
INV59_FRONT=$(grep -c "motivo_fora_padrao\|pode_forcar_com_motivo" apps/cockpit-web/src/components/cards/ModalCriarCard.tsx 2>/dev/null | tr -d ' ')
if [ "${INV59_GATE:-0}" -ge 1 ] && [ "${INV59_AUDIT:-0}" -ge 1 ] && [ "$INV59_TEST" = "ok" ] && [ "${INV59_FRONT:-0}" -ge 2 ]; then
  echo "INV-059: PASS (gate=$INV59_GATE audit=$INV59_AUDIT test=$INV59_TEST front=$INV59_FRONT)"
else
  echo "INV-059: FAIL (gate=$INV59_GATE audit=$INV59_AUDIT test=$INV59_TEST front=$INV59_FRONT — criar-card-manual fora de padrão sem justificativa/auditoria OU front sem o fluxo do motivo; ver _shared/gate-criacao-card-manual.ts, NF 22232)"
fi

# INV-060 (Duílio 2026-07-29, NF 303061): extravio PARCIAL no trilho de
# indenização (oc 59) oferece a oc 55 (seguir parcial) como OPÇÃO. Era só do
# menu do 54 → operador em card 59 ficava sem como escolher quando o cliente
# autorizava seguir com o parcial. Checks: (a) menu do 59 inclui propSeguir55
# gated por ehParcial; (b) whitelist do trilho 59 mantém cod===55 (não cancela).
INV60_MENU=$(grep -c 'ehParcial ? \[propSeguir55\]' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV60_WL=$(grep -c '(ehParcial && cod === 55)' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
if [ "${INV60_MENU:-0}" -ge 1 ] && [ "${INV60_WL:-0}" -ge 1 ]; then
  echo "INV-060: PASS (menu59_com_55=$INV60_MENU whitelist55=$INV60_WL)"
else
  echo "INV-060: FAIL (menu59_com_55=$INV60_MENU whitelist55=$INV60_WL — oc 55 saiu do menu do trilho 59 parcial; operador sem 'seguir parcial'; NF 303061, propostas-pos-resposta-cliente.ts)"
fi

# INV-061 (Duílio 2026-07-29): agente-oc43-autonomo. Card em oc 43 lança 49 se a
# oc IMEDIATAMENTE ANTERIOR no SSW ∈ {3,6,8,9,10,11,13,16,17,18,19,20,23,31,35},
# senão 55; sem anterior / SSW já saiu de 43 → NÃO lança (deixa AVH manual).
# Checks: (a) testes da lógica pura verdes; (b) whitelist com as 15 ocs;
# (c) lançamento SÓ via auto_aprovar_e_executar (envelope/executor); (d) agente
# NÃO chama SSW direto (convenção #2 — nada de lancarSswPortal/lancarOcorrenciaPortal
# no agente); (e) rollout shadow-first (2 flags separadas).
INV61_TEST=$(deno test --no-check supabase/functions/_shared/oc43-regras.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV61_WL=$(grep -c '3, 6, 8, 9, 10, 11, 13, 16, 17, 18, 19, 20, 23, 31, 35' supabase/functions/_shared/oc43-regras.ts 2>/dev/null | tr -d ' ')
INV61_ENV=$(grep -c 'auto_aprovar_e_executar' supabase/functions/agente-oc43-autonomo/index.ts 2>/dev/null | tr -d ' ')
# chamada REAL (com paren), não menção em comentário; e sem import direto do envelope
INV61_NODIRECT=$(grep -cE 'lancarSswPortal\(|lancarOcorrenciaPortal\(|from .*lancar-ssw-portal' supabase/functions/agente-oc43-autonomo/index.ts 2>/dev/null | tr -d ' ')
INV61_SHADOW=$(grep -c 'oc43_agente_autonomo_enabled' supabase/functions/agente-oc43-autonomo/index.ts 2>/dev/null | tr -d ' ')
if [ "$INV61_TEST" = "ok" ] && [ "${INV61_WL:-0}" -ge 1 ] && [ "${INV61_ENV:-0}" -ge 1 ] && [ "${INV61_NODIRECT:-1}" -eq 0 ] && [ "${INV61_SHADOW:-0}" -ge 1 ]; then
  echo "INV-061: PASS (test=$INV61_TEST whitelist=$INV61_WL envelope=$INV61_ENV chamada_direta=$INV61_NODIRECT shadow=$INV61_SHADOW)"
else
  echo "INV-061: FAIL (test=$INV61_TEST whitelist=$INV61_WL envelope=$INV61_ENV chamada_direta=$INV61_NODIRECT shadow=$INV61_SHADOW — agente oc43 deve decidir 49/55 pela oc anterior, lançar SÓ via auto_aprovar_e_executar e nunca chamar o SSW direto; Duílio 2026-07-29)"
fi

# INV-062 (Larissa 2026-08-05, NF 1102187): extravio TOTAL escalado p/ oc 49/54
# (âncora≠59) — o menu pós-resposta MANTÉM/REVIVE o 59+email de indenização
# (template EXTRAVIO_TOTAL_PEDIR_ROMANEIO do override 54→59), em vez de cancelar
# como obsoleto. Gate ehExtravioTotal (presença durável do todo 59+template) →
# INERTE pra card não-total. Checks: (a) testes puros verdes; (b) whitelist mantém
# 59 em total; (c) helper de revive presente (def + call).
INV62_TEST=$(deno test --no-check supabase/functions/_shared/oc59-extravio-total.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV62_WL=$(grep -c 'ehExtravioTotal && cod === 59' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
INV62_REVIVE=$(grep -c 'escolher59IndenizacaoParaReviver' supabase/functions/_shared/propostas-pos-resposta-cliente.ts 2>/dev/null | tr -d ' ')
if [ "$INV62_TEST" = "ok" ] && [ "${INV62_WL:-0}" -ge 1 ] && [ "${INV62_REVIVE:-0}" -ge 2 ]; then
  echo "INV-062: PASS (test=$INV62_TEST whitelist59=$INV62_WL revive=$INV62_REVIVE)"
else
  echo "INV-062: FAIL (test=$INV62_TEST whitelist59=$INV62_WL revive=$INV62_REVIVE — menu pós-resposta deve manter/reviver o 59+email em extravio total; NF 1102187)"
fi

# INV-063 (Caio 2026-08-06, incidente l.silva + NF 236391): TODO acesso SSW
# pela conta de serviço ai.salex (leitura E lançamento); idempotent_skip só
# com verdade do SSW (nunca skip cego em sucesso=true).
INV63_TEST_CRED=$(deno test --no-check supabase/functions/_shared/ssw-credencial-unica.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV63_TEST_RELANC=$(deno test --no-check supabase/functions/_shared/relancamento-idempotencia.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# loadSswInternalEnvForCard NÃO pode voltar a consultar o banco (resolução por operador)
INV63_DBLOOKUP=$(sed -n '/export async function loadSswInternalEnvForCard/,/^}/p' supabase/functions/_shared/ssw-internal-client.ts | grep -c "\.from(" | tr -d ' ')
# branch sucesso===true do envelope decide via helper (definição + uso = >=2)
INV63_DECIDIR=$(grep -c "decidirIdempotenciaRelancamento" supabase/functions/_shared/lancar-ssw-portal.ts | tr -d ' ')
if [ "$INV63_TEST_CRED" = "ok" ] && [ "$INV63_TEST_RELANC" = "ok" ] && [ "${INV63_DBLOOKUP:-1}" -eq 0 ] && [ "${INV63_DECIDIR:-0}" -ge 2 ]; then
  echo "INV-063: PASS (cred=$INV63_TEST_CRED relanc=$INV63_TEST_RELANC dblookup=$INV63_DBLOOKUP decidir=$INV63_DECIDIR)"
else
  echo "INV-063: FAIL (cred=$INV63_TEST_CRED relanc=$INV63_TEST_RELANC dblookup=$INV63_DBLOOKUP decidir=$INV63_DECIDIR — credencial única ai.salex + relançamento pela verdade do SSW; incidente 2026-08-06)"
fi

# INV-064 (Caio 2026-08-10, onboarding MARIA + AGV): contato por REMETENTE.
# A RPC resolver_email_cobranca_cliente tem 3º arg p_cnpj_remetente: com remetente
# a linha específica vence; SEM remetente NUNCA pode voltar linha específica
# (AGV não tem contato geral → NULL força escolha no modal). Âncora estrutural
# (sem PII no repo): pagador AGV Vinhedo + remetente ZOETIS → e-mail @agv.com.br;
# mesmo pagador SEM remetente → NULL. Valor exato do contato: mig 322 / banco.
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV64_COM=$(psql "$SUPABASE_DB_URL" -At -c "SELECT coalesce(public.resolver_email_cobranca_cliente('02905424001879','logistico','01770356000177'),'NULL');" 2>/dev/null)
  INV64_SEM=$(psql "$SUPABASE_DB_URL" -At -c "SELECT coalesce(public.resolver_email_cobranca_cliente('02905424001879','logistico',NULL),'NULL');" 2>/dev/null)
  # callers backend passam o remetente CRU (nunca o colapso null→pagador)
  INV64_CRU=$(grep -c "cnpj_remetente" supabase/functions/_shared/regras-auto-acao.ts | tr -d ' ')
  case "$INV64_COM" in *@agv.com.br) INV64_COM_OK=ok ;; *) INV64_COM_OK=fail ;; esac
  if [ "$INV64_COM_OK" = "ok" ] && [ "$INV64_SEM" = "NULL" ] && [ "${INV64_CRU:-0}" -ge 1 ]; then
    echo "INV-064: PASS (com_remetente=dominio_agv sem_remetente=$INV64_SEM cru=$INV64_CRU)"
  else
    echo "INV-064: FAIL (com_remetente=$INV64_COM_OK sem_remetente=$INV64_SEM cru=$INV64_CRU — resolver por remetente AGV; onboarding MARIA 2026-08-10)"
  fi
else
  echo "INV-064: SKIP (sem SUPABASE_DB_URL)"
fi

# INV-065 (Caio 2026-08-10, trava modo visualização): João/Isadora veem tudo
# e não executam NADA (cards + cadastros; Aprendizado fica livre). 3 camadas:
# flags no banco, guard nos 17 RPCs SECURITY DEFINER, helper nas 10 edge
# functions mutantes. service_role/cron nunca trava.
INV65_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/trava-visualizacao.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV65_EDGE=$(grep -rl "bloquearSeModoVisualizacao" supabase/functions --include="index.ts" | wc -l | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV65_COL=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM information_schema.columns WHERE table_name='operadores' AND column_name='pode_executar';" 2>/dev/null)
  if [ "${INV65_COL:-0}" -eq 0 ]; then
    echo "INV-065: SKIP (mig 324 ainda não aplicada — coluna pode_executar ausente)"
  else
    INV65_FLAGS=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM operadores WHERE pode_executar=false AND lower(email) IN ('joao.penha@salexpress.com.br','isadora.baldoni@salexpress.com.br');" 2>/dev/null)
    INV65_RPCS=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosrc LIKE '%assert_pode_executar%' AND proname <> 'assert_pode_executar';" 2>/dev/null)
    if [ "$INV65_TEST" = "ok" ] && [ "${INV65_FLAGS:-0}" -eq 2 ] && [ "${INV65_RPCS:-0}" -ge 17 ] && [ "${INV65_EDGE:-0}" -ge 10 ]; then
      echo "INV-065: PASS (test=$INV65_TEST flags=$INV65_FLAGS rpcs=$INV65_RPCS edge=$INV65_EDGE)"
    else
      echo "INV-065: FAIL (test=$INV65_TEST flags=$INV65_FLAGS rpcs=$INV65_RPCS edge=$INV65_EDGE — trava modo visualização João/Isadora; mig 324)"
    fi
  fi
else
  echo "INV-065: SKIP (sem SUPABASE_DB_URL; código: test=$INV65_TEST edge=$INV65_EDGE)"
fi

# INV-066 (Caio 2026-08-11, NFs 306856/74790/439189/5726093 + 11): resposta de
# cliente em card ACIONÁVEL nunca fica muda. O efeito do acionamento é FONTE
# ÚNICA (_shared/acionar-resposta-cliente.ts) usada por vinculador E
# reconciliador — duplicar o bloco recria o bug do INV-042.
INV66_TEST=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/acionar-resposta-cliente.test.ts >/dev/null 2>&1 && echo ok || echo fail)
# nenhum caller pode escrever cliente_respondeu_em fora da fonte única
INV66_VAZOU=$(grep -rl "cliente_respondeu_em: new Date()" supabase/functions --include="*.ts" | grep -v "_shared/acionar-resposta-cliente.ts" | wc -l | tr -d ' ')
# os 2 callers usam o helper
INV66_CALLERS=$(grep -rl "acionarRespostaCliente" supabase/functions --include="index.ts" | wc -l | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV66_RPC=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM pg_proc WHERE proname='cards_resposta_cliente_nao_acionada';" 2>/dev/null)
  INV66_PEND=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM public.cards_resposta_cliente_nao_acionada(200, 30, 90);" 2>/dev/null)
else
  INV66_RPC="skip"; INV66_PEND="skip"
fi
if [ "$INV66_TEST" = "ok" ] && [ "${INV66_VAZOU:-1}" -eq 0 ] && [ "${INV66_CALLERS:-0}" -ge 2 ] && \
   { [ "$INV66_RPC" = "skip" ] || { [ "${INV66_RPC:-0}" -ge 1 ] && [ "${INV66_PEND:-1}" -eq 0 ]; }; }; then
  echo "INV-066: PASS (test=$INV66_TEST vazou=$INV66_VAZOU callers=$INV66_CALLERS rpc=$INV66_RPC pendentes=$INV66_PEND)"
else
  echo "INV-066: FAIL (test=$INV66_TEST vazou=$INV66_VAZOU callers=$INV66_CALLERS rpc=$INV66_RPC pendentes=$INV66_PEND — resposta de cliente muda em card acionável; ver acionar-resposta-cliente.ts)"
fi

# INV-067 (Caio 2026-08-11): o OPERADOR fica ciente. Se sobrar resposta de
# cliente sem acionamento (o reconciliador falhou), o dono do card é avisado por
# e-mail E por aviso dentro do Cockpit — nunca só o gestor.
INV67_CORE=$(cd supabase/functions && deno test --allow-all --no-check --quiet _shared/fiscal-resposta-cliente.test.ts >/dev/null 2>&1 && echo ok || echo fail)
INV67_FRONT=$( (cd apps/cockpit-web && npx vitest run src/lib/alertas-operador.test.ts >/dev/null 2>&1) && echo ok || echo fail)
# fiscal existe, usa o MESMO detector do reconciliador e a barra está no layout
INV67_DETECTOR=$(grep -c "cards_resposta_cliente_nao_acionada" supabase/functions/fiscal-resposta-cliente/index.ts | tr -d ' ')
INV67_BARRA=$(grep -c "AgenteChamando" apps/cockpit-web/src/components/layout/AppLayout.tsx | tr -d ' ')
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  INV67_TAB=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_name='alertas_operador';" 2>/dev/null)
  INV67_CRON=$(psql "$SUPABASE_DB_URL" -At -c "SELECT count(*) FROM cron.job WHERE jobname='fiscal-resposta-cliente-every-15min';" 2>/dev/null)
else
  INV67_TAB="skip"; INV67_CRON="skip"
fi
if [ "$INV67_CORE" = "ok" ] && [ "$INV67_FRONT" = "ok" ] && [ "${INV67_DETECTOR:-0}" -ge 1 ] && [ "${INV67_BARRA:-0}" -ge 1 ] && \
   { [ "$INV67_TAB" = "skip" ] || { [ "${INV67_TAB:-0}" -ge 1 ] && [ "${INV67_CRON:-0}" -ge 1 ]; }; }; then
  echo "INV-067: PASS (core=$INV67_CORE front=$INV67_FRONT detector=$INV67_DETECTOR barra=$INV67_BARRA tabela=$INV67_TAB cron=$INV67_CRON)"
else
  echo "INV-067: FAIL (core=$INV67_CORE front=$INV67_FRONT detector=$INV67_DETECTOR barra=$INV67_BARRA tabela=$INV67_TAB cron=$INV67_CRON — operador precisa ser avisado de card travado; fiscal INV-066)"
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
