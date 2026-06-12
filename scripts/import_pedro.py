#!/usr/bin/env python3
"""
import_pedro.py — Importa clientes + contatos do operador PEDRO LOPES (segmento 001 AUTO PECAS).

Diferenças vs import_durafa.py:
- 60 linhas brutas no CSV ~/Downloads/EMAILS PEÇAS - Página1.csv → 51 contatos únicos após dedupe
- Campo EMAIL às vezes vem com múltiplos separados por " / " (linha VGA: 3 emails)
- 3 linhas tinham CNPJ errado (ASSIS/SUPPORT compartilhando CNPJ do CML); Caio corrigiu 2026-05-26
- CNPJs no Excel vieram sem zero à esquerda (memory feedback_excel_cnpj_float) → pad para 14 dígitos

Faz 4 coisas:
1. UPSERT em `clientes`
2. UPSERT em `tracking_credentials` (stub pra aba CADASTROS do Lovable)
3. INSERT em `contatos_cliente` (after DELETE idempotente)
4. UPDATE `operadores` SET carteira/segmentos WHERE nome='PEDRO LOPES'

Uso:
  set -a && source .env.local && set +a
  python3 scripts/import_pedro.py
"""

import json
import os
import sys

import requests


SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SEGMENTO_CODIGO = "001"
SEGMENTO_NOME = "AUTO PECAS"
OPERADOR_NOME = "PEDRO LOPES"

# Dados extraídos do CSV ~/Downloads/EMAILS PEÇAS - Página1.csv (2026-05-26).
# CNPJs padronizados pra 14 dígitos (Excel removeu zero à esquerda).
# Emails compostos (separados por " / ") já expandidos em registros individuais.
# CNPJs CORRIGIDOS pelo Caio 2026-05-26: ASSIS E ASSIS = 16517294000163, SUPPORT = 54264319000315.
# Formato: (cnpj_cpf, nome_empresa, [emails])
DADOS = [
    ("07571746003896", "MG VIDROS", ["autoglass@transpofrete.com.br", "ocorrencias.frete@transpofrete.com.br"]),
    ("42580092004830", "BR AUTO PARTS - JF", ["tainara.tolentino@brautoparts.com.br"]),
    ("42580092002543", "BR AUTO PARTS - UBERLANDIA", ["valcones.villela@brautoparts.com.br"]),
    ("42580092001229", "BR AUTO PARTS - BH", ["thiago.luciano@brautoparts.com.br"]),
    ("42580092004406", "BR AUTO PARTS - ES", ["lucas.vaz@brautoparts.com.br"]),
    ("42580092004325", "BR AUTO PARTS - VGA", [
        "jefferson.junior@brautoparts.com.br",
        "bianca.silva@brautoparts.com.br",
        "bruno.ferreira@brautoparts.com.br",
    ]),
    ("04098359000102", "GMI", ["logistica02@gmibh.com.br"]),
    ("04098359000366", "GMI", ["logistica02@gmibh.com.br"]),
    ("07395207000151", "UNIVERSAL AUTOMOTIVE", [
        "transporte@universalautomotive.com.br",
        "carolina.baatsck@universalautomotive.com.br",
        "leandro.rocha@universalautomotive.com.br",
    ]),
    ("66550054000210", "UNIVERSAL AUTOMOTIVE", [
        "transporte@universalautomotive.com.br",
        "carolina.baatsck@universalautomotive.com.br",
        "leandro.rocha@universalautomotive.com.br",
    ]),
    ("65773814000538", "NEWKAR MINAS", [
        "transporte@newkarminas.com.br",
        "transporte2@newkarminas.com.br",
        "supervisao@newkarminas.com.br",
    ]),
    ("26013236000156", "DMF AUTOMOTIVOS", ["controladoria@dmfautomotivos.com.br"]),
    ("04771370002399", "VESPOR", ["cav@vespor.com.br"]),
    ("04771370001406", "VESPOR", ["cav@vespor.com.br"]),
    ("04771370001074", "VESPOR", ["cav@vespor.com.br"]),
    ("04771370000345", "VESPOR", ["cav@vespor.com.br"]),
    ("38843249000727", "GEB", ["beatriz_admmg@gb.com.br", "sac@gb.com.br"]),
    ("55176358000323", "CHG", [
        "suelen.silva@chg.com.br",
        "transportesmg@chg.com.br",
        "adriele.paixao@chg.com.br",
    ]),
    # CML (25752353000179) pertence ao DURAFA (segmento 022 MOTOBIKE) — não incluir aqui.
    ("16517294000163", "ASSIS E ASSIS", [
        "loja@assiseassis.com.br",
        "distribuicao@assiseassis.com.br",
    ]),
    ("54264319000315", "SUPPORT DO BRASIL", ["jose.antonio@supportdobrasil.com.br"]),
    ("55831184000476", "BRUDOVAN", ["cd.mg@brudovan.com.br"]),
    ("08897417000291", "FURACAO", ["sacfw@furacao.com.br"]),
    ("08897417001778", "FURACAO", ["sacfw@furacao.com.br"]),
    ("61136701000651", "JAHU", ["douglas.barbosa@jahu.com.br"]),
    ("81676009001190", "ROLEMAR - CONTAGEM", [
        "vendas.contagem@rolemar.com",
        "contagem@rolemar.com",
    ]),
    ("81676009001433", "ROLEMAR - CONTAGEM", [
        "vendas.contagem@rolemar.com",
        "contagem@rolemar.com",
    ]),
    ("02222289000623", "POLIPECAS", [
        "luizaguiar@polipecas.com.br",
        "administrativobhz@polipecas.com.br",
    ]),
    ("01784496000528", "SOCIAL DISTRIBUIDORA", ["transporte@socialdistribuidora.com.br"]),
    ("06250329000359", "MACROLUB / RM SERVICOS", ["logistica@rmservicos.net"]),
    ("08237002000372", "SK AUTOMOTIVE", [
        "jose.hombert@skautomotive.com.br",
        "lucas.pedroso@skautomotive.com.br",
    ]),
    ("25909961000144", "LOJA DO BORRACHEIRO", ["fiscaludi@lojadoborracheiro.com"]),
    ("44337958000148", "IMPAR FORD", ["elias@imparford.com.br"]),
    ("05916095000101", "REDE ANCORA", ["robson.amorim@redeancora.com.br"]),
    ("45987005017678", "DPK / COMERCIAL AUTOMOTIVA (CELERELOG)", [
        "dpk.out@celerelog.com.br",
        "rsilva@celerelog.com.br",
    ]),
    ("45987005026588", "DPK / COMERCIAL AUTOMOTIVA (CELERELOG)", [
        "dpk.out@celerelog.com.br",
        "rsilva@celerelog.com.br",
    ]),
    ("45987005028360", "DPK / COMERCIAL AUTOMOTIVA (CELERELOG)", [
        "dpk.out@celerelog.com.br",
        "rsilva@celerelog.com.br",
    ]),
    ("41916347000166", "UNIFORT", ["julia.silva@unifort.com.br", "sac@unifort.com.br"]),
    ("18707422000167", "MARKA CHEVROLET", ["william@markachevrolet.com.br"]),
]


def montar():
    clientes_by_cnpj: dict[str, dict] = {}
    contatos: list[dict] = []
    seen_pair: set[tuple[str, str]] = set()
    for cnpj, nome, emails in DADOS:
        if len(cnpj) != 14 or not cnpj.isdigit():
            print(f"  ✕ CNPJ inválido (esperado 14 dígitos): {cnpj} ({nome})", file=sys.stderr)
            sys.exit(1)
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
            pair = (cnpj, email)
            if pair in seen_pair:
                continue
            seen_pair.add(pair)
            contatos.append({
                "tipo": "email",
                "identificador": email,
                "documento_cliente": cnpj,
                "nome_pessoa": nome,
                "ativo": True,
            })
    return list(clientes_by_cnpj.values()), contatos


def buscar_operador_id(nome: str) -> str:
    url = f"{SUPABASE_URL}/rest/v1/operadores?nome=eq.{nome.replace(' ', '%20')}&select=id"
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
        f"{url}?nome=eq.{OPERADOR_NOME.replace(' ', '%20')}",
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
