#!/usr/bin/env bash
# psql-shim.sh — substituto do psql quando ele não está instalado (Windows do
# Carlos). Aceita a mesma forma de chamada que o ritual usa
# (`$PSQL "$SUPABASE_DB_URL" -tA -c "..."` ou `-f arquivo.sql`) e delega ao
# scripts/dbq.py, que resolve credencial e backend (Management API).
exec python3 "$(dirname "$0")/dbq.py" "$@"
