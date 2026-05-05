#!/usr/bin/env python3
"""
apply_migrations.py — versionador de migrations do Cockpit

Como funciona:
  1. Lê todos os arquivos `migration/*.sql` em ordem alfabética
  2. Pra cada arquivo, calcula sha256 do conteúdo
  3. Compara com `public.schema_migrations`:
       - Já aplicada com mesmo sha → pula
       - Já aplicada com sha diferente → ABORTA (drift)
       - Não aplicada → aplica + registra
  4. Saída: "X aplicadas, Y já estavam aplicadas, Z erros"

Uso:
    set -a && source .env.local && set +a
    python3 scripts/apply_migrations.py [--baseline]

Flags:
    --baseline    Marca TODAS as migrations existentes como aplicadas SEM rodar.
                  Use uma vez só pra registrar o estado atual do banco.
                  (Migration 032 é exceção: ela cria a tabela e é aplicada
                  de verdade mesmo no modo baseline.)

Requer no env:
    SUPABASE_URL
    SUPABASE_ACCESS_TOKEN  (Management API token)
"""

import argparse
import hashlib
import os
import sys
import time
from pathlib import Path

import requests


REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_DIR = REPO_ROOT / "migration"
BOOTSTRAP_MIGRATION = "2026-05-01_032_schema_migrations.sql"


def sha256_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def project_ref_from_url(supabase_url: str) -> str:
    # https://xjbycvscljqoqpjkmevb.supabase.co → xjbycvscljqoqpjkmevb
    host = supabase_url.replace("https://", "").replace("http://", "")
    return host.split(".")[0]


class MgmtClient:
    def __init__(self, project_ref: str, access_token: str):
        self.project_ref = project_ref
        self.token = access_token
        self.base = f"https://api.supabase.com/v1/projects/{project_ref}"

    def query(self, sql: str):
        url = f"{self.base}/database/query"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }
        res = requests.post(url, json={"query": sql}, headers=headers, timeout=120)
        if not res.ok:
            try:
                err = res.json().get("message", res.text)
            except Exception:
                err = res.text
            raise RuntimeError(f"HTTP {res.status_code}: {err}")
        return res.json()


def fetch_applied(client: MgmtClient) -> dict[str, str]:
    """Retorna {filename: sha256} pra todas as migrations já registradas."""
    try:
        rows = client.query(
            "SELECT filename, sha256 FROM public.schema_migrations"
        )
    except RuntimeError as e:
        # Tabela ainda não existe — retorna vazio (vai ser criada por 032)
        if "does not exist" in str(e) or "schema_migrations" in str(e):
            return {}
        raise
    return {r["filename"]: r["sha256"] for r in rows}


def register_applied(
    client: MgmtClient,
    filename: str,
    sha: str,
    duration_ms: int,
    applied_by: str = "apply_migrations.py",
) -> None:
    sql = f"""
INSERT INTO public.schema_migrations (filename, sha256, applied_by, duration_ms)
VALUES (
  $${filename}$$,
  $${sha}$$,
  $${applied_by}$$,
  {duration_ms}
)
ON CONFLICT (filename) DO UPDATE
  SET sha256 = EXCLUDED.sha256,
      applied_at = now(),
      applied_by = EXCLUDED.applied_by,
      duration_ms = EXCLUDED.duration_ms;
"""
    client.query(sql)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="Marcar todas migrations existentes como aplicadas sem rodar.",
    )
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    access_token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not supabase_url or not access_token:
        print("✕ SUPABASE_URL e SUPABASE_ACCESS_TOKEN obrigatórios no env.", file=sys.stderr)
        sys.exit(1)

    project_ref = project_ref_from_url(supabase_url)
    client = MgmtClient(project_ref, access_token)

    files = sorted(p for p in MIGRATION_DIR.glob("*.sql"))
    if not files:
        print(f"✕ Nenhum *.sql em {MIGRATION_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"→ {len(files)} arquivos em migration/")
    print(f"→ Project: {project_ref}")
    print(f"→ Modo: {'BASELINE (registra sem rodar)' if args.baseline else 'aplicar pendentes'}")
    print()

    applied_existing = fetch_applied(client)

    # No modo baseline, primeiro aplica a 032 (cria a tabela). Depois registra
    # todas as outras como aplicadas sem rodar.
    if args.baseline and BOOTSTRAP_MIGRATION not in applied_existing:
        bootstrap_path = MIGRATION_DIR / BOOTSTRAP_MIGRATION
        if not bootstrap_path.exists():
            print(f"✕ Bootstrap migration não achada: {bootstrap_path}", file=sys.stderr)
            sys.exit(1)
        print(f"  → bootstrap: aplicando {BOOTSTRAP_MIGRATION}")
        sql = bootstrap_path.read_text()
        sha = sha256_of(sql)
        t0 = time.time()
        client.query(sql)
        duration = int((time.time() - t0) * 1000)
        register_applied(client, BOOTSTRAP_MIGRATION, sha, duration, "baseline")
        applied_existing[BOOTSTRAP_MIGRATION] = sha
        print(f"     ✓ aplicada em {duration}ms\n")

    aplicadas_agora = 0
    ja_aplicadas = 0
    drift = []

    for path in files:
        name = path.name
        sql = path.read_text()
        sha = sha256_of(sql)

        prev_sha = applied_existing.get(name)

        if prev_sha == sha:
            ja_aplicadas += 1
            continue

        if prev_sha is not None and prev_sha != sha:
            drift.append((name, prev_sha[:12], sha[:12]))
            continue

        # Não aplicada ainda
        if args.baseline:
            print(f"  → registrando {name} (baseline, sem rodar)")
            register_applied(client, name, sha, 0, "baseline")
            aplicadas_agora += 1
            continue

        # Modo normal: aplica e registra
        print(f"  → aplicando {name}...")
        t0 = time.time()
        try:
            client.query(sql)
        except RuntimeError as e:
            print(f"     ✕ falhou: {e}", file=sys.stderr)
            sys.exit(1)
        duration = int((time.time() - t0) * 1000)
        register_applied(client, name, sha, duration)
        aplicadas_agora += 1
        print(f"     ✓ aplicada em {duration}ms")

    print()
    print(f"  ja aplicadas: {ja_aplicadas}")
    print(f"  aplicadas agora: {aplicadas_agora}")
    if drift:
        print(f"\n  ⚠ DRIFT detectado em {len(drift)} arquivo(s):")
        for name, prev, curr in drift:
            print(f"     {name}: registrada com sha={prev}, conteúdo atual sha={curr}")
        print("     Resolução: ou reverter o arquivo, ou aplicar uma migration nova.")
        sys.exit(2)


if __name__ == "__main__":
    main()
