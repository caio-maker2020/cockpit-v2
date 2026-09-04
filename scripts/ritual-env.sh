#!/usr/bin/env bash
# ritual-env.sh — preâmbulo PORTÁTIL do /verify-cockpit e do ritual de deploy.
#
# Uso (dentro de qualquer bloco bash do ritual):
#     cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh
#
# O que faz, em qualquer máquina (macOS, Linux, Windows/Git Bash) e shell (bash/zsh):
#   1. Carrega o primeiro .env.local achado (raiz do checkout, raiz do checkout
#      principal quando é worktree, ou diretório pai) SEM sobrescrever variáveis
#      já exportadas e sem imprimir segredo.
#   2. Define PSQL: o `psql` do PATH, ou o do homebrew, ou — se não houver psql —
#      o shim `scripts/psql-shim.sh`, que delega ao `scripts/dbq.py` (Management
#      API). Os invariantes chamam `$PSQL "$SUPABASE_DB_URL" -tA -c "..."` e
#      não precisam saber qual dos três está por trás.
#   3. Exporta CLAUDE_PROJECT_DIR (o deploy-gate usa) e REPO_ROOT.
#
# Por que existe (2026-09-02): o ritual fazia `cd` num caminho fixo do Mac do
# Caio e usava /opt/homebrew/opt/libpq/bin/psql. No Windows do Carlos tudo isso
# virava SKIP silencioso. Ver docs/RITUAL_DEPLOY.md.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export REPO_ROOT
export CLAUDE_PROJECT_DIR="$REPO_ROOT"

_ritual_load_env() {
  local f
  for f in "$REPO_ROOT/.env.local" \
           "$(dirname "$(git rev-parse --git-common-dir 2>/dev/null || echo "$REPO_ROOT/.git")")/.env.local" \
           "$(dirname "$REPO_ROOT")/.env.local"; do
    if [ -f "$f" ]; then
      # só as chaves que ainda não existem no ambiente
      while IFS= read -r linha || [ -n "$linha" ]; do
        linha="${linha%$'\r'}"
        case "$linha" in ''|'#'*) continue;; esac
        linha="${linha#export }"
        local k="${linha%%=*}" v="${linha#*=}"
        k="$(echo "$k" | tr -d '[:space:]')"
        [ -z "$k" ] && continue
        v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
        # sem ${!k}: é bash-only e estoura "bad substitution" no zsh (Mac do Caio)
        if [ -z "$(printenv "$k" 2>/dev/null)" ]; then export "$k=$v"; fi
      done < "$f"
      RITUAL_ENV_FILE="$f"
      export RITUAL_ENV_FILE
      return 0
    fi
  done
  return 1
}
_ritual_load_env || true

if command -v psql >/dev/null 2>&1; then
  PSQL="$(command -v psql)"
elif [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL=/opt/homebrew/opt/libpq/bin/psql
else
  PSQL="$REPO_ROOT/scripts/psql-shim.sh"
  chmod +x "$PSQL" 2>/dev/null || true
fi

# 2b. PSQL não pode conter ESPAÇO (Carlos 2026-09-04, INV-146).
#
# Defeito real medido hoje: o checkout do Carlos é ".../COCKPIT ATUALIZADO", logo
# PSQL virava ".../COCKPIT ATUALIZADO/scripts/psql-shim.sh". Os ~60 call sites da
# Fase 8 chamam `$PSQL "$SUPABASE_DB_URL" -tA -c "..."` com o **$PSQL SEM aspas**;
# o shell faz word splitting e tenta executar ".../01_odim.claude/COCKPIT".
# Erro: "No such file or directory" — engolido pelo `2>/dev/null` de cada check.
#
# O estrago NÃO é cosmético: a saída vazia não cai no ramo SKIP (que testa
# `-z "$SUPABASE_DB_URL"`, e essa está definida), cai na comparação de valor. Medido
# na íntegra: 19 invariantes reportaram **FAIL** com os campos de banco vazios
# (INV-035/036/037/038/040/042/043/044/046/047/048/052/055/057/064/067/068/070/072).
# Ou seja: /verify-cockpit ficava permanentemente vermelho nesta máquina, por
# motivo falso, bloqueando todo commit — e um verify que sempre falha é um verify
# que ninguém lê. Mesma classe do INV-144 (cp1252): o trilho quebrando no Windows.
#
# Correção na RAIZ (aqui, 1 lugar) em vez de aspas em ~60 call sites: publica um
# lançador equivalente num diretório SEM espaço e aponta PSQL pra ele. Continua
# sendo um caminho ABSOLUTO e EXECUTÁVEL, porque vários checks fazem
# `[ ! -x "$PSQL" ]` pra decidir SKIP — um PSQL que fosse só nome de comando
# mandaria justamente esses pro SKIP.
case "$PSQL" in
  *" "*)
    for _ritual_dir in "${TMPDIR:-}" /tmp "$HOME"; do
      case "$_ritual_dir" in ''|*" "*) continue;; esac
      [ -d "$_ritual_dir" ] && [ -w "$_ritual_dir" ] || continue
      _ritual_bin="$_ritual_dir/cockpit-ritual-bin"
      mkdir -p "$_ritual_bin" 2>/dev/null || continue
      _ritual_psql="$_ritual_bin/psql-ritual.sh"
      printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$PSQL" > "$_ritual_psql" 2>/dev/null || continue
      chmod +x "$_ritual_psql" 2>/dev/null || true
      [ -x "$_ritual_psql" ] || continue
      PSQL="$_ritual_psql"
      break
    done
    unset _ritual_dir _ritual_bin _ritual_psql
    ;;
esac
export PSQL

# Diagnóstico curto (sem segredo): o ritual imprime isto no começo de cada fase.
echo "ritual-env: repo=$REPO_ROOT psql=${PSQL##*/} env=${RITUAL_ENV_FILE:-NENHUM} db_url=$([ -n "${SUPABASE_DB_URL:-}" ] && echo sim || echo NAO) access_token=$([ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && echo sim || echo NAO)"
