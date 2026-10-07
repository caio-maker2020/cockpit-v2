#!/usr/bin/env bash
# Roda as migs 430/431 + os testes SQL da Operação num Postgres DESCARTÁVEL local
# (initdb em diretório temporário, só socket unix, sem TCP). NUNCA aponta para o
# banco do Cockpit. Uso: supabase/tests/operacao/rodar-local.sh
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d /tmp/opsql.XXXX)"
trap 'pg_ctl -D "$TMP/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
initdb -D "$TMP/data" -U postgres -A trust >/dev/null
pg_ctl -D "$TMP/data" -o "-c listen_addresses='' -k $TMP" -l "$TMP/log" start -w >/dev/null
P=(psql -h "$TMP" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${P[@]}" -f "$RAIZ/supabase/tests/operacao/stub-supabase.sql"
"${P[@]}" -f "$RAIZ/migration/2026-10-07_430_operacao_fila_e_lancamentos.sql"
"${P[@]}" -f "$RAIZ/migration/2026-10-07_431_operacao_separacao_rls.sql"
# reaplicar as duas tem de ser inofensivo (idempotência)
"${P[@]}" -f "$RAIZ/migration/2026-10-07_430_operacao_fila_e_lancamentos.sql"
"${P[@]}" -f "$RAIZ/migration/2026-10-07_431_operacao_separacao_rls.sql"
"${P[@]}" -f "$RAIZ/supabase/tests/operacao/operacao-separacao.test.sql"
"${P[@]}" -f "$RAIZ/supabase/tests/operacao/operacao-rpcs.test.sql"
# (os dois testes acima rodam sem a 415: o de vazão cria uma ponte mínima e a desfaz)
# ponte (415) e sugestão/encaminhamento (434–436, ADR 0041 D10/D11)
"${P[@]}" -f "$RAIZ/migration/2026-10-07_415_ponte_operacao.sql"
for m in 434_operacao_regras_sugestao 435_operacao_sugestao_ia_cache 436_operacao_encaminhar_relacionamento; do
  "${P[@]}" -f "$RAIZ/migration/2026-10-07_$m.sql"
  "${P[@]}" -f "$RAIZ/migration/2026-10-07_$m.sql"   # idempotência
done
"${P[@]}" -f "$RAIZ/supabase/tests/operacao/operacao-sugestao-encaminhar.test.sql"
echo "OK: migs 430/431/415/434–436 + testes SQL da Operação passaram no Postgres local descartável"
