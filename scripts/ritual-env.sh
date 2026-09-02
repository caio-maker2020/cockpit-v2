#!/usr/bin/env bash
# ritual-env.sh — preâmbulo PORTÁTIL do /verify-cockpit e do ritual de deploy.
#
# Uso (dentro de qualquer bloco bash do ritual):
#     cd "$(git rev-parse --show-toplevel)"; source scripts/ritual-env.sh
#
# O que faz, em qualquer máquina (macOS, Linux, Windows/Git Bash):
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
        if [ -z "${!k:-}" ]; then export "$k=$v"; fi
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
export PSQL

# Diagnóstico curto (sem segredo): o ritual imprime isto no começo de cada fase.
echo "ritual-env: repo=$REPO_ROOT psql=${PSQL##*/} env=${RITUAL_ENV_FILE:-NENHUM} db_url=$([ -n "${SUPABASE_DB_URL:-}" ] && echo sim || echo NAO) access_token=$([ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && echo sim || echo NAO)"
