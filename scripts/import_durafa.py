#!/usr/bin/env python3
"""
import_durafa.py — Importa clientes + contatos do operador DURAFA (segmento 022 MOTOBIKE).

Diferenças vs import_duilio.py:
- Dados embutidos no script (Caio passou foto da planilha — 28 CNPJs únicos)
- Algumas linhas SMA têm 2 emails (guilherme + larissa) → viram 2 contatos
- Segmento SSW = "022" (MOTOBIKE)

Faz 4 coisas:
1. UPSERT em `clientes` (28 CNPJs únicos)
2. UPSERT em `tracking_credentials` (stub pra aba CADASTROS do Lovable)
3. INSERT em `contatos_cliente` (after DELETE idempotente)
4. UPDATE `operadores` SET carteira/segmentos WHERE nome='DURAFA'

Uso:
  set -a && source .env.local && set +a
  python3 scripts/import_durafa.py
"""

import json
import os
import sys

import requests


SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SEGMENTO_CODIGO = "022"
SEGMENTO_NOME = "MOTOBIKE"
OPERADOR_NOME = "DURAFA"

# Dados extraídos da planilha enviada pelo Caio 2026-05-25.
# Formato: (cnpj_cpf, nome_empresa, [emails])
DADOS = [
    ("10288920000100", "CAIRU INDUSTRIA DE BICICLETAS", ["rma@ciclocairu.com.br"]),
    ("02513526000281", "CICLO CAIRU LTDA", ["rma@ciclocairu.com.br"]),
    ("02513526000109", "CICLO CAIRU LTDA", ["rma@ciclocairu.com.br"]),
    ("25752353000179", "COMERCIAL MINAS LAGOENSE LTDA", ["albert@cmlminas.com.br"]),
    ("01407607000153", "COMERCIAL MOTOCICLO S/A", ["talita.soares@motociclo.com.br"]),
    ("62172563000114", "DAMASIO DISTRIB MOTOPECAS UBERLAND LTDA", ["ana.paula@damasiomotopecas.com.br"]),
    ("34790420000130", "DAMASIO DISTRIBUIDORA DE MOTOP", ["ana.paula@damasiomotopecas.com.br"]),
    ("37950696000127", "HL DISTRIBUICAO MATRIZ", ["sac@hlmotobike.com.br"]),
    ("37950696000208", "HL DISTRIBUIDORA MOTO BIKE LTD", ["sac@hlmotobike.com.br"]),
    ("37950696000399", "HL DISTRIBUIDORA MOTO BIKE LTDA", ["sac@hlmotobike.com.br"]),
    ("61327045000402", "ISAPA IMPORTACAO E COMERCIO LTDA", ["giovanna.andrade@isapa.com.br"]),
    ("70963418000180", "LM BIKE COMERCIAL E DIST. LTDA", ["atendimento@lm2rodas.com.br"]),
    ("70963418000341", "LM COMERCIAL E DISTRIBUIDORA L", ["atendimento@lm2rodas.com.br"]),
    ("28578568000103", "LM MOTO CENTER COMERCIO E ACESSORIOS EIRELI", ["atendimento@lm2rodas.com.br"]),
    ("45406480000123", "MIX MOTO", ["sac@mixmoto.com.br"]),
    ("17339764000966", "MOTO ARTE COM PC AC PARA MOTOS", ["roberta.lage@motoarte.com"]),
    ("65304198000142", "NENA BIKE LTDA", ["sergio.marques@nenabike.com.br"]),
    ("25630302001650", "REAL MOTO PECAS LTDA", ["izabellaalmeida@greal.com.br"]),
    ("25630302002541", "REAL MOTO PECAS LTDA", ["izabellaalmeida@greal.com.br"]),
    ("25630302000760", "REAL MOTO PECAS LTDA FILIAL BR", ["izabellaalmeida@greal.com.br"]),
    ("35663915000404", "S2BS DISTRIB DE BICICLETAS", ["vitor.henrique@sensebike.com.br"]),
    ("35663915000242", "S2BS DISTRIBUIDORA DE BICICLET", ["vitor.henrique@sensebike.com.br"]),
    ("35663915000161", "S2BS DISTRIBUIDORA DE BICICLETAS E ACESSORIOS LTDA", ["vitor.henrique@sensebike.com.br"]),
    ("17077640000283", "SMA DISTRIBUIDORA DE MOTO PECA", ["guilherme.fernandes@nacionalmoto.com.br", "larissa.ferreira@nacionalmoto.com.br"]),
    ("17077640000100", "SMA DISTRIBUIDORA DE MOTO PECA LTDA - ME", ["guilherme.fernandes@nacionalmoto.com.br", "larissa.ferreira@nacionalmoto.com.br"]),
    ("17077640000364", "SMA DISTRIBUIDORA DE MOTO PECAS LTDA", ["guilherme.fernandes@nacionalmoto.com.br", "larissa.ferreira@nacionalmoto.com.br"]),
    ("03585187000120", "TOTAL MAXPARTS COMERCIAL LTDA", ["logistica@totalmax.com.br"]),
    ("03585187000554", "TOTAL MAXPARTS COMERCIAL LTDA", ["logistica@totalmax.com.br"]),
]


def montar():
    clientes_by_cnpj: dict[str, dict] = {}
    contatos: list[dict] = []
    for cnpj, nome, emails in DADOS:
        if cnpj not in clientes_by_cnpj:
            clientes_by_cnpj[cnpj] = {
                "cnpj_cpf": cnpj,
                "nome": nome,
                "segmento_codigo": SEGMENTO_CODIGO,
                "segmento_nome": SEGMENTO_NOME,
                "ativo": True,
            }
        for email in emails:
            email = email.strip().lower()
            if "@" not in email:
                continue
            contatos.append({
                "tipo": "email",
                "identificador": email,
                "documento_cliente": cnpj,
                "nome_pessoa": nome,
                "ativo": True,
            })
    return list(clientes_by_cnpj.values()), contatos


def buscar_operador_id(nome: str) -> str:
    url = f"{SUPABASE_URL}/rest/v1/operadores?nome=eq.{nome}&select=id"
    headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    res = requests.get(url, headers=headers, timeout=30)
    if not res.ok or not res.json():
        print(f"  ✕ Operador {nome} não encontrado", file=sys.stderr)
        sys.exit(1)
    return res.json()[0]["id"]


def deletar_contatos_do_operador(operador_id: str) -> int:
    url = f"{SUPABASE_URL}/rest/v1/contatos_cliente?operador_responsavel_id=eq.{operador_id}"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Prefer": "return=representation",
    }
    res = requests.delete(url, headers=headers, timeout=30)
    if not res.ok:
        print(f"  ✕ DELETE contatos falhou: HTTP {res.status_code} {res.text[:300]}", file=sys.stderr)
        sys.exit(1)
    return len(res.json()) if res.text else 0


def upsert(table: str, rows: list[dict], on_conflict: str | None = None) -> int:
    if not rows:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    if on_conflict:
        url += f"?on_conflict={on_conflict}"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    BATCH = 100
    inserted = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        res = requests.post(url, headers=headers, data=json.dumps(batch), timeout=30)
        if not res.ok:
            print(f"  ✕ Falhou batch {i} em {table}: HTTP {res.status_code} {res.text[:300]}", file=sys.stderr)
            sys.exit(1)
        inserted += len(batch)
    return inserted


def vincular_operador(clientes: list[dict]) -> tuple[list[str], list[str]]:
    cnpjs = sorted({c["cnpj_cpf"] for c in clientes})
    segmentos = sorted({c["segmento_codigo"] for c in clientes})
    url = f"{SUPABASE_URL}/rest/v1/operadores"
    headers = {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    res = requests.patch(
        f"{url}?nome=eq.{OPERADOR_NOME}",
        headers=headers,
        data=json.dumps({"carteira": cnpjs, "segmentos": segmentos}),
        timeout=30,
    )
    if not res.ok:
        print(f"  ✕ UPDATE {OPERADOR_NOME} falhou: HTTP {res.status_code} {res.text[:300]}", file=sys.stderr)
        sys.exit(1)
    return cnpjs, segmentos


def main():
    clientes, contatos = montar()
    print(f"→ {len(clientes)} clientes únicos, {len(contatos)} contatos email")

    operador_id = buscar_operador_id(OPERADOR_NOME)
    print(f"→ operador_id = {operador_id}")

    for c in contatos:
        c["operador_responsavel_id"] = operador_id

    print(f"\n→ UPSERT clientes ({len(clientes)})...")
    n = upsert("clientes", clientes)
    print(f"  ✓ {n}")

    # tracking_credentials precisa ser inserido via psql/service-role direto
    # porque a tabela não tem GRANT pra service_role via PostgREST.
    # Já feito manualmente — pular nesta run.
    print(f"\n→ tracking_credentials: pulado (rodar via psql se ainda não feito)")

    print(f"\n→ DELETE contatos antigos {OPERADOR_NOME}...")
    n_del = deletar_contatos_do_operador(operador_id)
    print(f"  ✓ {n_del}")

    print(f"\n→ INSERT contatos_cliente ({len(contatos)})...")
    n = upsert("contatos_cliente", contatos)
    print(f"  ✓ {n}")

    print(f"\n→ Vinculando {OPERADOR_NOME}...")
    cnpjs, segmentos = vincular_operador(clientes)
    print(f"  ✓ carteira = {len(cnpjs)} CNPJs, segmentos = {segmentos}")

    print("\n✦ Pronto. cockpit_ativo continua FALSE — ativar manualmente quando SSW validado + Gmail/Postmark configurados.")


if __name__ == "__main__":
    main()
