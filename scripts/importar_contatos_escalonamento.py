#!/usr/bin/env python3
"""
importar_contatos_escalonamento.py — importa contatos da base pra
public.contatos_escalonamento usado em PRIORIDADES AI (cobrança escalonada).

Fonte: data/contatos-escalonamento-bases.csv (commitado no projeto;
Caio atualiza e roda o script de novo quando precisa).

REGRA CRÍTICA DE BASE:
  cards.base_destino aparece em DOIS formatos em prod:
    a) nome de cidade em MAIÚSCULO sem acento — ARACUAI, BELO HORIZONTE,
       GOV. VALADARES, JOÃO MONLEVADE...
    b) sigla SSW de 3 letras — BCN, BHE, BHZ, IPE, UDI, VGA, VIX...
  Cada contato é cadastrado em N linhas pra cobrir ambos: 1 com CIDADE
  normalizada + 1 por SIGLA (coluna SIGLA da planilha, separada por '/').

NORMALIZAÇÃO de telefone: remove tudo que não é dígito.

NORMALIZAÇÃO de cargo:
  'GERENTE DE BASE'         → gerente_base
  'COORDENADOR DE ENTREGA'  → coordenador_entrega
  outros                    → erro, opera só na taxonomia do CHECK constraint

IDEMPOTÊNCIA: usa ON CONFLICT (cargo, base, telefone) DO NOTHING via
índice único parcial criado on-the-fly se ainda não existir.

Uso:
  set -a && source .env.local && set +a
  python3 scripts/importar_contatos_escalonamento.py --dry-run
  python3 scripts/importar_contatos_escalonamento.py --apply
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import unicodedata
from pathlib import Path
from typing import Iterable

import requests


SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "contatos-escalonamento-bases.csv"

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

CARGO_MAP = {
    "GERENTE DE BASE": "gerente_base",
    "COORDENADOR DE ENTREGA": "coordenador_entrega",
    # extensões manuais aqui se a planilha trouxer variações
}

# Mapeamento CIDADE (planilha normalizada) → forma canônica usada em
# cards.base_destino. Quando a planilha tem typo ou formato diferente, o
# cadastro precisa cobrir ambas as variantes pra o lookup encontrar.
#
# Conferido em 2026-05-23 contra `SELECT DISTINCT base_destino FROM cards`:
CIDADE_CANONICA: dict[str, str] = {
    "CATAGUASE":                "CATAGUASES",
    "GOVERNADOR VALADERES":     "GOV. VALADARES",
    "JOAO MOLEVADE":            "JOÃO MONLEVADE",
    "MANHACO":                  "MANHUACU",
    "BELO HORIZONTE/CONTAGEM":  "BELO HORIZONTE",
    "ESPIRITO SANTO/CARIACICA": "ESPIRITO SANTO",
    "ESPIRITO SANTOS/VIANA":    "ESPIRITO SANTO",
    # Adicione mais aqui conforme apareçam divergências.
}


def strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)
    )


def norm_cidade(s: str) -> str:
    """MAIÚSCULO sem acento, trim. Mantém pontuação ('GOV. VALADARES')."""
    return strip_accents(s).upper().strip()


def norm_telefone(s: str) -> str | None:
    """Só dígitos. Esperado 12-13 dígitos (55 + DDD + número)."""
    digits = "".join(ch for ch in s if ch.isdigit())
    if not digits:
        return None
    if len(digits) < 12 or len(digits) > 13:
        return None
    return digits


def norm_email(s: str) -> str | None:
    s = s.strip()
    if not s or s in ("#", "-"):
        return None
    s = s.removeprefix("mailto:").strip()
    if "@" not in s or " " in s:
        return None
    return s.lower()


def norm_cargo(s: str) -> str:
    chave = s.strip().upper()
    if chave not in CARGO_MAP:
        raise ValueError(f"cargo desconhecido: {s!r} — adicione em CARGO_MAP")
    return CARGO_MAP[chave]


def expandir_siglas(sigla_raw: str) -> list[str]:
    """'AIB/JIB/JAU/SFC/SLI/UAI/MOC' → ['AIB','JIB',...]. Vazio se sem sigla."""
    if not sigla_raw:
        return []
    return [s.strip().upper() for s in sigla_raw.split("/") if s.strip()]


def gerar_linhas(row: dict) -> list[dict]:
    """Pra cada linha do CSV, produz N rows pra inserir (cidade + siglas)."""
    nome = row["NOME"].strip()
    if not nome:
        return []
    cargo = norm_cargo(row["CARGO"])
    telefone = norm_telefone(row["CONTATO"])
    if telefone is None:
        print(f"  ! telefone inválido pra {nome!r}: {row['CONTATO']!r}", file=sys.stderr)
        return []
    email = norm_email(row["E-MAIL"])
    cidade = norm_cidade(row["CIDADE"]) if row["CIDADE"] else None
    siglas = expandir_siglas(row["SIGLA"])
    obs = row.get("Observação", "").strip() or None

    bases: list[str] = []
    if cidade:
        bases.append(cidade)
        # se a cidade tem forma canônica no banco diferente da normalizada
        # da planilha (typo, sufixo, formato), inclui as duas formas pra
        # garantir match no lookup (cards podem usar qualquer uma).
        canonica = CIDADE_CANONICA.get(cidade)
        if canonica and canonica != cidade:
            bases.append(canonica)
    bases.extend(siglas)
    # unidade também pode aparecer como base_destino em cards
    unidade_raw = row.get("UNIDADE", "")
    for u in expandir_siglas(unidade_raw):  # UNIDADE pode ser "ARI/ITB", "SPM/APM"
        if u not in bases:
            bases.append(u)

    bases = list(dict.fromkeys(bases))  # dedup mantendo ordem

    linhas = []
    for base in bases:
        linhas.append({
            "nome": nome,
            "cargo": cargo,
            "telefone": telefone,
            "email": email,
            "base": base,
            "ativo": True,
            "observacao": obs,
        })
    return linhas


def ler_csv(path: Path) -> Iterable[dict]:
    with path.open(encoding="utf-8") as f:
        reader = csv.reader(f)
        rows = list(reader)
    # Header está na linha 2 (índice 1), conteúdo da linha 3+ (índice 2+)
    header = [c.strip() for c in rows[1]]
    for line_idx, row in enumerate(rows[2:], start=3):
        if not row or not any(c.strip() for c in row):
            continue
        # CSV tem coluna vazia inicial — alinha pelo header
        if len(row) < len(header):
            row += [""] * (len(header) - len(row))
        record = dict(zip(header, row))
        record["_line"] = line_idx
        yield record


def garantir_indice_unico(verbose: bool) -> None:
    """Cria índice único parcial (cargo, base, telefone) WHERE ativo
    se ainda não existir. Permite ON CONFLICT DO NOTHING idempotente."""
    sql = """
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contatos_escal_cargo_base_telefone
      ON public.contatos_escalonamento (cargo, base, telefone)
      WHERE ativo;
    """
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/rpc/exec_sql",
        headers=HEADERS,
        json={"sql": sql},
        timeout=30,
    )
    if r.status_code == 404:
        if verbose:
            print("  ! RPC exec_sql não existe — crie o índice manualmente:")
            print(sql)
        return
    r.raise_for_status()
    if verbose:
        print("  ✓ índice único garantido (cargo, base, telefone)")


def buscar_existentes() -> set[tuple[str, str, str]]:
    """Retorna set de (cargo, base, telefone) já cadastrados."""
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/contatos_escalonamento",
        headers=HEADERS,
        params={"select": "cargo,base,telefone", "ativo": "eq.true"},
        timeout=30,
    )
    r.raise_for_status()
    return {(row["cargo"], row["base"] or "", row["telefone"] or "") for row in r.json()}


def insert_batch(rows: list[dict]) -> None:
    """Insere em lotes de 50 com Prefer: resolution=ignore-duplicates."""
    headers = {**HEADERS, "Prefer": "return=minimal,resolution=ignore-duplicates"}
    LOTE = 50
    for i in range(0, len(rows), LOTE):
        chunk = rows[i:i + LOTE]
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/contatos_escalonamento",
            headers=headers,
            json=chunk,
            timeout=60,
        )
        if r.status_code >= 400:
            print(f"\nERRO no lote {i // LOTE}:", r.status_code, r.text[:500], file=sys.stderr)
            r.raise_for_status()
        print(f"  ✓ lote {i // LOTE + 1}: {len(chunk)} linhas")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="aplica de verdade (default: dry-run)")
    args = ap.parse_args()
    aplicar = args.apply

    print(f"Lendo {CSV_PATH}")
    if not CSV_PATH.exists():
        print(f"ERRO: arquivo não encontrado: {CSV_PATH}", file=sys.stderr)
        sys.exit(1)

    todas: list[dict] = []
    rejeitadas = 0
    for row in ler_csv(CSV_PATH):
        try:
            linhas = gerar_linhas(row)
        except ValueError as e:
            print(f"  ! linha {row['_line']}: {e}", file=sys.stderr)
            rejeitadas += 1
            continue
        if not linhas:
            rejeitadas += 1
            continue
        todas.extend(linhas)

    print(f"\n{len(todas)} linhas geradas a partir do CSV  ({rejeitadas} linhas rejeitadas)")

    # Dedup interno por (cargo, base, telefone) — caso CSV repita
    vistos: dict[tuple[str, str, str], dict] = {}
    for ln in todas:
        chave = (ln["cargo"], ln["base"], ln["telefone"])
        # primeira ocorrência prevalece; preserva email/obs do primeiro
        vistos.setdefault(chave, ln)
    todas = list(vistos.values())
    print(f"{len(todas)} linhas únicas após dedup interno")

    # Compara com existentes
    existentes = buscar_existentes()
    novas = [ln for ln in todas if (ln["cargo"], ln["base"], ln["telefone"]) not in existentes]
    ja_existe = len(todas) - len(novas)
    print(f"  {ja_existe} já cadastradas")
    print(f"  {len(novas)} novas a inserir")

    if novas:
        print("\nPreview das 10 primeiras novas linhas:")
        for ln in novas[:10]:
            print(f"  {ln['cargo']:25s} base={ln['base']:20s} {ln['nome']:30s} {ln['telefone']}")

    # Bases por cargo
    print("\nDistribuição final (todas linhas, incluindo já existentes):")
    por_cargo_base: dict[tuple[str, str], int] = {}
    for ln in todas:
        chave = (ln["cargo"], ln["base"])
        por_cargo_base[chave] = por_cargo_base.get(chave, 0) + 1
    for (cargo, base), n in sorted(por_cargo_base.items()):
        print(f"  {cargo:25s} {base:30s} {n}")

    if not aplicar:
        print("\n[dry-run] — passe --apply pra inserir de verdade")
        return

    if not novas:
        print("\nNada a inserir.")
        return

    print(f"\nInserindo {len(novas)} linhas em public.contatos_escalonamento...")
    insert_batch(novas)
    print(f"\n✓ {len(novas)} contatos inseridos.")


if __name__ == "__main__":
    main()
