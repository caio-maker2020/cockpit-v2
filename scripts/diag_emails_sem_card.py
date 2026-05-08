#!/usr/bin/env python3
"""
diag_emails_sem_card.py — diagnóstico read-only de emails que não voltaram a card

Roda 4 buckets de query:

  A) messages_inbox sem card_id (últimos 7 dias)
  B) messages_inbox com processing_status `ignored_*` (últimos 7 dias)
  C) cards em AGUARDANDO_CLIENTE há > 24h sem cliente_respondeu_em
     porém com email outbound recente (= cliente provavelmente recebeu)
  D) cards com cliente_respondeu_em IS NOT NULL e state NÃO em
     AGUARDANDO_VALIDACAO_HUMANA (sanity — não devia existir)

Saída: tabela legível pelo terminal + JSON em /tmp/diag_emails_<timestamp>.json
pra análise posterior.

Uso:
    set -a && source .env.local && set +a
    python3 scripts/diag_emails_sem_card.py [--days 7]

Requer:
    SUPABASE_URL
    SUPABASE_ACCESS_TOKEN  (Management API token — read-only é suficiente)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests


def project_ref_from_url(url: str) -> str:
    return url.replace("https://", "").replace("http://", "").split(".")[0]


class MgmtClient:
    def __init__(self, project_ref: str, token: str):
        self.base = f"https://api.supabase.com/v1/projects/{project_ref}"
        self.token = token

    def query(self, sql: str):
        res = requests.post(
            f"{self.base}/database/query",
            json={"query": sql},
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            timeout=120,
        )
        if not res.ok:
            try:
                err = res.json().get("message", res.text)
            except Exception:
                err = res.text
            raise RuntimeError(f"HTTP {res.status_code}: {err}")
        return res.json()


def section(title: str):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def print_rows(rows, cols):
    if not rows:
        print("  (vazio)")
        return
    widths = {c: max(len(c), max(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("-" * len(header))
    for r in rows:
        print("  ".join(str(r.get(c, "") or "").ljust(widths[c]) for c in cols))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7, help="Janela em dias (default 7)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL")
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not url or not token:
        print("ERRO: defina SUPABASE_URL e SUPABASE_ACCESS_TOKEN no env", file=sys.stderr)
        sys.exit(2)

    client = MgmtClient(project_ref_from_url(url), token)
    days = args.days

    out = {}

    # A) inbox sem card_id
    section(f"A) messages_inbox sem card_id (últimos {days} dias)")
    sql_a = f"""
SELECT
  id,
  recebido_em,
  remetente,
  in_reply_to_header,
  processing_status,
  LEFT(COALESCE(assunto, ''), 60) AS assunto
FROM public.messages_inbox
WHERE card_id IS NULL
  AND recebido_em >= now() - interval '{days} days'
ORDER BY recebido_em DESC
LIMIT 100;
"""
    rows_a = client.query(sql_a)
    print(f"Total: {len(rows_a)}")
    print_rows(
        rows_a,
        ["recebido_em", "remetente", "processing_status", "in_reply_to_header", "assunto"],
    )
    out["A_inbox_sem_card"] = rows_a

    # B) processing_status ignored_*
    section(f"B) messages_inbox com processing_status ignored_* (últimos {days} dias)")
    sql_b = f"""
SELECT
  processing_status,
  COUNT(*) AS qtd,
  MIN(recebido_em) AS desde,
  MAX(recebido_em) AS ate
FROM public.messages_inbox
WHERE processing_status LIKE 'ignored_%'
  AND recebido_em >= now() - interval '{days} days'
GROUP BY processing_status
ORDER BY qtd DESC;
"""
    rows_b = client.query(sql_b)
    print_rows(rows_b, ["processing_status", "qtd", "desde", "ate"])
    out["B_ignored_buckets"] = rows_b

    # B') exemplos por bucket (até 5 cada)
    section("B') exemplos por bucket ignored_*")
    sql_b2 = f"""
SELECT
  processing_status,
  remetente,
  recebido_em,
  in_reply_to_header,
  LEFT(COALESCE(assunto, ''), 60) AS assunto
FROM public.messages_inbox
WHERE processing_status LIKE 'ignored_%'
  AND recebido_em >= now() - interval '{days} days'
ORDER BY processing_status, recebido_em DESC
LIMIT 50;
"""
    rows_b2 = client.query(sql_b2)
    print_rows(
        rows_b2,
        ["processing_status", "remetente", "recebido_em", "in_reply_to_header", "assunto"],
    )
    out["B2_ignored_exemplos"] = rows_b2

    # C) cards em AGUARDANDO_CLIENTE > 24h sem resposta porém com outbound
    section("C) cards em AGUARDANDO_CLIENTE >24h sem cliente_respondeu_em (com outbound enviado)")
    sql_c = f"""
SELECT
  c.id AS card_id,
  c.nf,
  c.cod_ultima_ocorrencia AS oc,
  c.state,
  c.acao_executada_em,
  c.cliente_respondeu_em,
  (
    SELECT MAX(o.sent_at)
    FROM public.cards_emails_outbound o
    WHERE o.card_id = c.id
  ) AS ultimo_outbound,
  (
    SELECT COUNT(*)
    FROM public.cards_emails_outbound o
    WHERE o.card_id = c.id
  ) AS qtd_outbound
FROM public.cards c
WHERE c.state = 'AGUARDANDO_CLIENTE'
  AND c.cliente_respondeu_em IS NULL
  AND c.acao_executada_em IS NOT NULL
  AND c.acao_executada_em < now() - interval '24 hours'
  AND c.acao_executada_em >= now() - interval '{days} days'
  AND EXISTS (
    SELECT 1 FROM public.cards_emails_outbound o
    WHERE o.card_id = c.id
  )
ORDER BY c.acao_executada_em DESC
LIMIT 100;
"""
    rows_c = client.query(sql_c)
    print(f"Total: {len(rows_c)}")
    print_rows(
        rows_c,
        ["nf", "oc", "acao_executada_em", "ultimo_outbound", "qtd_outbound", "card_id"],
    )
    out["C_aguardando_cliente_24h"] = rows_c

    # D) sanity: cliente_respondeu_em populado em state inesperado
    section("D) cards com cliente_respondeu_em mas state != AGUARDANDO_VALIDACAO_HUMANA")
    sql_d = f"""
SELECT
  id AS card_id,
  nf,
  state,
  cod_ultima_ocorrencia AS oc,
  cliente_respondeu_em,
  acao_executada_em
FROM public.cards
WHERE cliente_respondeu_em IS NOT NULL
  AND state <> 'AGUARDANDO_VALIDACAO_HUMANA'
  AND cliente_respondeu_em >= now() - interval '{days} days'
ORDER BY cliente_respondeu_em DESC
LIMIT 50;
"""
    rows_d = client.query(sql_d)
    print(f"Total: {len(rows_d)}")
    print_rows(rows_d, ["nf", "oc", "state", "cliente_respondeu_em", "acao_executada_em", "card_id"])
    out["D_resposta_em_state_estranho"] = rows_d

    # Resumo
    section("Resumo")
    print(f"  A) inbox sem card:              {len(rows_a)}")
    print(f"  B) buckets ignored_*:           {len(rows_b)}  ({sum(int(r.get('qtd', 0)) for r in rows_b)} mensagens)")
    print(f"  C) cards 24h sem resposta:      {len(rows_c)}")
    print(f"  D) state inesperado:            {len(rows_d)}")

    ts = int(time.time())
    out_path = Path(f"/tmp/diag_emails_{ts}.json")
    out_path.write_text(json.dumps(out, default=str, indent=2, ensure_ascii=False))
    print(f"\n  JSON salvo em: {out_path}")


if __name__ == "__main__":
    main()
