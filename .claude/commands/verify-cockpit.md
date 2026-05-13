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
- atualizar-card-via-tracking: ação manual deliberada? ✓/✗

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
