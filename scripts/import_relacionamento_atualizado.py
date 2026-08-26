#!/usr/bin/env python3
"""
Gera migration/2026-07-23_307_relacionamento_atualizado.sql a partir de
data/relacionamento-atualizado-2026-07-23.xlsx (planilha "Relacionamento
Atualizado" do Caio, v2 de 2026-07-23 16:42 — gestor KAROL já renomeado pra
KAROLINE na fonte).

Decisões do Caio (2026-07-23, nesta ordem de coleta):
  1. "Karol" = KAROLINE (planilha corrigida na fonte); "Maria Eduarda" = MARIA
     (operadora dormente — cockpit_ativo permanece false).
  2. ADITIVO: CNPJs em carteira hoje que NÃO estão na planilha ficam onde estão.
  3. Carteiras de INGRID e MARIA entram JÁ, mesmo dormentes (padrão NORTEL:
     novos cards desses clientes ficam desatribuídos até elas ativarem).
  4. SAL EXP. TRANSPORTADORA (86392529000466) permanece na blacklist
     cnpjs_excluidos_cockpit — a linha dela NÃO entra em carteira/contato
     (só upsert no catálogo clientes). Implementado de forma genérica: qualquer
     CNPJ da planilha em blacklist ATIVA é pulado com NOTICE.
  5. E-mails: corrigir *.com.b → *.com.br (CASA VARGINHA, ALIANCA);
     bjorganizacoes@hotmail → @hotmail.com; strip de vírgula/espaço;
     valores sem '@' ("Interno ... VGA") não viram contato.
  6. Segmentos de roteamento seguem a planilha: LARISSA {018},
     KAROLINE {007,010}, MARIA {040,042}. INGRID fica carteira-only
     (014 continua roteando pro DUILIO — os dois dividem 014 por carteira).

Linha corrompida conhecida: UNIAO QUIMICA FARMACEUTICA NAC (gestor Larissa) —
Excel converteu a célula de CNPJ pra float 6.06e+27. Os 3 CNPJs da UNIAO
QUIMICA no banco (60665981000460/0541/0975) já estão com a LARISSA, que é o
gestor da planilha → linha é pulada sem perda.

!! NÃO REGERE POR CIMA DA 307 (Caio 2026-08-12) !!
A 307 já foi APLICADA em produção. O scripts/apply_migrations.py versiona por
sha256: se o conteúdo do arquivo mudar, ele ABORTA com DRIFT em toda rodada
seguinte (não re-aplica — trava o deploy inteiro). Se a planilha mudar e for
preciso refletir isso no banco, gere um arquivo de migration NOVO com o delta
(padrão migs 332 e 333), nunca reescreva este OUT.

Deltas posteriores à planilha, já aplicados por migration própria:
  • 46044053002582 ISABELY→INGRID e +53296273000191 na INGRID — mig 332.
  • 53628620000136 AGROLIFE ISABELY→JULIA, segmento 043 CURVA F→003
    DISTRIBUIDOR AGRO (faturamento acima de 30k tirou o cliente da Curva F)
    — mig 333. A planilha .xlsx JÁ foi corrigida na fonte; a linha 181 da 307
    continua dizendo ISABELY/043 de propósito (é o snapshot do que foi
    aplicado em 2026-07-23). Guard: âncora INV-048 no /verify-cockpit.
  • 5 CNPJs ISABELY→VICTOR/KAROLINE/FELIPE/DUILIO, todos saindo de 043 CURVA F
    porque passaram de 30k/mês — mig 359, Caio 2026-08-26:
        86368206000194 HENRIQUE DISTRIB. → VICTOR   006 DISTRIBUIDOR DE COSMETICOS
        09944371000368 SULMEDIC          → KAROLINE 010 DISTRIBUIDOR HOSPITALAR
        81676009001190 GIRANDO           → FELIPE   001 AUTO PECAS
        81676009001433 GIRANDO (C.)      → FELIPE   001 AUTO PECAS
        40279136000288 ATACADAO (B2)     → DUILIO   014 FERRAMENTAS E CONSTRUCAO
    A planilha .xlsx JÁ foi corrigida nas 4 linhas que existiam (152, 252, 253
    e 635). O SULMEDIC NÃO consta da planilha: pela regra ADITIVA nº 2 acima,
    CNPJ fora da planilha fica onde está — ele já estava na carteira da
    KAROLINE desde ~17/08 e a mig 359 só terminou a mudança (cards +
    segmento). As linhas desses CNPJs na 307 continuam dizendo ISABELY/043 de
    propósito (é o snapshot do que foi aplicado em 2026-07-23).
    A 359 tem uma camada que a 333 não tinha: DESARMA a janela de veto dos
    cards movidos. VICTOR/KAROLINE/DUILIO estão fora do piloto (mig 357) e o
    executor não recheca o piloto no vencimento — sem isso, ação armada sob a
    ISABELY dispararia sozinha na mão de quem nunca optou por ação autônoma.
    Guard: âncoras dos 5 CNPJs no INV-048 do /verify-cockpit.

Uso:  python3 scripts/import_relacionamento_atualizado.py
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import openpyxl

REPO = Path(__file__).resolve().parent.parent
XLSX = REPO / "data" / "relacionamento-atualizado-2026-07-23.xlsx"
OUT = REPO / "migration" / "2026-07-23_307_relacionamento_atualizado.sql"

GESTOR_MAP = {
    "Duilio": "DUILIO",
    "Felipe": "FELIPE",
    "Ingrid": "INGRID",
    "Isabely": "ISABELY",
    "Victor": "VICTOR",
    "Julia": "JULIA",
    "KAROLINE": "KAROLINE",
    "Larissa": "LARISSA",
    "Maria Eduarda": "MARIA",
}

# Correções pontuais aprovadas pelo Caio (2026-07-23) — match exato pós-strip.
EMAIL_FIXES = {
    "casaborracha@bol.com.b": "casaborracha@bol.com.br",
    "logistica@annel.com.b": "logistica@annel.com.br",
    "bjorganizacoes@hotmail": "bjorganizacoes@hotmail.com",
}

# Domínio público NÃO vira linha tipo='dominio' em contatos_cliente: o
# scan-email-pre-card usa esses domínios pra pontuar vínculo e-mail↔card, e
# domínio público casaria com qualquer remetente gmail/yahoo/etc (ruído).
DOMINIOS_PUBLICOS = (
    "gmail.com", "yahoo.com", "yahoo.com.br", "hotmail.com", "outlook.com",
    "bol.com.br", "uol.com.br", "terra.com.br", "icloud.com", "live.com",
)


def q(v: str | None) -> str:
    if v is None:
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def norm_email(raw: object) -> str | None:
    if raw is None:
        return None
    e = str(raw).strip().rstrip(",.").strip().lower()
    e = EMAIL_FIXES.get(e, e)
    if "@" not in e or e.startswith("@") or e.endswith("@"):
        return None  # "Interno setor de compras VGA", "Interno Sal VGA"
    return e


def norm_seg(raw: object) -> tuple[str | None, str | None]:
    if raw is None:
        return None, None
    s = str(raw).strip()
    code, _, nome = s.partition("-")
    code = code.strip()
    nome = nome.strip()
    if len(code) == 3 and code.isdigit() and nome:
        return code, nome
    return None, None


def main() -> None:
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    ws = wb.worksheets[0]
    raw = [r for r in list(ws.iter_rows(values_only=True))[1:]
           if any(v is not None and str(v).strip() != "" for v in r)]

    rows, skipped = [], []
    for r in raw:
        cnpj, nome, seg, gestor, resp, email, tel = (list(r) + [None] * 7)[:7]
        if not isinstance(cnpj, int):
            skipped.append((cnpj, nome, gestor))
            continue
        g = GESTOR_MAP.get(str(gestor).strip() if gestor else "")
        if g is None:
            raise SystemExit(f"gestor desconhecido na planilha: {gestor!r} ({nome})")
        seg_cod, seg_nome = norm_seg(seg)
        rows.append({
            "cnpj": str(cnpj).zfill(14),
            "nome": str(nome).strip(),
            "seg_cod": seg_cod,
            "seg_nome": seg_nome,
            "gestor": g,
            "resp": str(resp).strip() if resp else None,
            "email": norm_email(email),
            "tel": str(tel).strip() if tel else None,
        })

    dup = [c for c, n in Counter(x["cnpj"] for x in rows).items() if n > 1]
    if dup:
        raise SystemExit(f"CNPJ duplicado na planilha: {dup}")

    counts = Counter(x["gestor"] for x in rows)
    n_email = sum(1 for x in rows if x["email"])
    print(f"linhas válidas: {len(rows)} | puladas: {len(skipped)} | com e-mail: {n_email}")
    for s in skipped:
        print(f"  PULADA (CNPJ inválido no Excel): {s}")
    print("por gestor:", dict(sorted(counts.items())))

    values = ",\n".join(
        "  ({cnpj},{nome},{sc},{sn},{g},{resp},{email},{tel})".format(
            cnpj=q(x["cnpj"]), nome=q(x["nome"]), sc=q(x["seg_cod"]),
            sn=q(x["seg_nome"]), g=q(x["gestor"]), resp=q(x["resp"]),
            email=q(x["email"]), tel=q(x["tel"]),
        )
        for x in rows
    )
    guard_counts = " OR\n     ".join(
        f"(SELECT count(*) FROM _rel WHERE gestor={q(g)}) <> {n}"
        for g, n in sorted(counts.items())
    )
    dominios_pub = ", ".join(q(d) for d in DOMINIOS_PUBLICOS)
    operadores_alvo = ", ".join(q(g) for g in sorted(set(GESTOR_MAP.values())))

    sql = f"""-- =============================================================================
-- 2026-07-23_307 — Relacionamento Atualizado: carteiras, catálogo, contatos,
--                  tracking, segmentos e cards conforme planilha do Caio
-- =============================================================================
-- GERADO por scripts/import_relacionamento_atualizado.py a partir de
-- data/relacionamento-atualizado-2026-07-23.xlsx — NÃO editar à mão; edite o
-- gerador/planilha e regenere.
--
-- Fonte da verdade: planilha "Relacionamento Atualizado" (Caio 2026-07-23).
-- {len(rows)} CNPJs válidos (1 linha UNIAO QUIMICA pulada — célula corrompida no
-- Excel; os 3 CNPJs dela no banco já estão com a LARISSA, gestor da planilha).
--
-- DECISÕES DO CAIO (2026-07-23): ver cabeçalho do gerador. Resumo:
--   ADITIVO (CNPJs fora da planilha ficam onde estão); INGRID/MARIA entram
--   dormentes com carteira (novos cards desatribuídos até ativarem — padrão
--   NORTEL); blacklist ativa vence a planilha (SAL EXP fica fora de
--   carteira/contatos); segmentos LARISSA {{018}}, KAROLINE {{007,010}},
--   MARIA {{040,042}}.
--
-- VÍNCULO EM 4 CAMADAS (receita migs 288/300): carteira / contatos_cliente /
-- tracking_credentials / cards+card_events. Catálogo clientes vem ANTES dos
-- contatos (FK contatos_cliente.documento_cliente → clientes.cnpj_cpf).
--
-- Idempotente (re-run: carteiras/segmentos/tracking/cards no-op, sem evento
-- duplicado; contatos são rewrite escopado — recria as mesmas linhas).
-- skill: supabase-postgres-best-practices — set-based, transação única curta,
-- schema-qualified, sem SECURITY DEFINER novo.
-- =============================================================================
BEGIN;

-- 1. STAGING
CREATE TEMP TABLE _rel (
  cnpj text PRIMARY KEY, nome text NOT NULL, seg_cod text, seg_nome text,
  gestor text NOT NULL, responsavel text, email text, telefone text,
  blacklisted boolean NOT NULL DEFAULT false
) ON COMMIT DROP;

INSERT INTO _rel (cnpj, nome, seg_cod, seg_nome, gestor, responsavel, email, telefone) VALUES
{values};

-- Blacklist ativa vence a planilha (decisão 4): marca e NUNCA toca
-- carteira/contatos/tracking/cards desses CNPJs (catálogo pode).
UPDATE _rel r SET blacklisted = true
 WHERE EXISTS (SELECT 1 FROM public.cnpjs_excluidos_cockpit b
                WHERE b.cnpj_pagador = r.cnpj AND b.ativo);

-- 2. GUARDAS (abortam a transação inteira)
DO $$
DECLARE v_n int; v_falta text; v_conflito text; v_black text;
BEGIN
  SELECT count(*) INTO v_n FROM _rel;
  IF v_n <> {len(rows)} THEN
    RAISE EXCEPTION 'STOP G1: staging com % linhas (esperado {len(rows)})', v_n;
  END IF;

  IF {guard_counts} THEN
    RAISE EXCEPTION 'STOP G2: contagem por gestor divergente da planilha';
  END IF;

  SELECT string_agg(DISTINCT r.gestor, ', ') INTO v_falta
  FROM _rel r WHERE NOT EXISTS (SELECT 1 FROM public.operadores o WHERE o.nome = r.gestor);
  IF v_falta IS NOT NULL THEN
    RAISE EXCEPTION 'STOP G3: gestor sem operador correspondente: %', v_falta;
  END IF;

  -- G4: CNPJ da planilha em carteira de operador FORA do conjunto-alvo → abort
  SELECT string_agg(DISTINCT o.nome || ':' || r.cnpj, ', ') INTO v_conflito
  FROM _rel r JOIN public.operadores o ON r.cnpj = ANY (o.carteira)
  WHERE o.nome NOT IN ({operadores_alvo});
  IF v_conflito IS NOT NULL THEN
    RAISE EXCEPTION 'STOP G4: CNPJ em carteira de operador inesperado: %', v_conflito;
  END IF;

  SELECT string_agg(r.cnpj || ' (' || r.nome || ')', ', ') INTO v_black
  FROM _rel r WHERE r.blacklisted;
  IF v_black IS NOT NULL THEN
    RAISE NOTICE 'mig 307: blacklist vence a planilha, pulando carteira/contatos de: %', v_black;
  END IF;
  RAISE NOTICE 'mig 307 guardas OK: % linhas', v_n;
END $$;

-- 3. CATÁLOGO clientes (planilha vence nome/segmento; nunca desativa ninguém)
INSERT INTO public.clientes (cnpj_cpf, nome, segmento_codigo, segmento_nome, ativo)
SELECT cnpj, nome, seg_cod, seg_nome, true FROM _rel
ON CONFLICT (cnpj_cpf) DO UPDATE SET
  nome = EXCLUDED.nome, ativo = true,
  segmento_codigo = COALESCE(EXCLUDED.segmento_codigo, public.clientes.segmento_codigo),
  segmento_nome   = COALESCE(EXCLUDED.segmento_nome,   public.clientes.segmento_nome);

-- 4. CAMADA 1 — carteiras (1 CNPJ = 1 operador; aditivo fora da planilha)
-- 4a. remove cada CNPJ da carteira de quem NÃO é o gestor da planilha
UPDATE public.operadores o
   SET carteira = (
     SELECT coalesce(array_agg(x ORDER BY x), '{{}}')
     FROM unnest(o.carteira) x
     WHERE NOT EXISTS (SELECT 1 FROM _rel r
                        WHERE r.cnpj = x AND NOT r.blacklisted AND r.gestor <> o.nome))
 WHERE EXISTS (SELECT 1 FROM unnest(o.carteira) x
                JOIN _rel r ON r.cnpj = x AND NOT r.blacklisted AND r.gestor <> o.nome);

-- 4b. adiciona ao gestor da planilha (union dedup, ordenado)
UPDATE public.operadores o
   SET carteira = (
     SELECT array_agg(DISTINCT c ORDER BY c) FROM (
       SELECT unnest(o.carteira) AS c
       UNION
       SELECT r.cnpj FROM _rel r WHERE r.gestor = o.nome AND NOT r.blacklisted
     ) s)
 WHERE o.nome IN (SELECT DISTINCT gestor FROM _rel);

-- 5. Segmentos de roteamento (decisão 6). INGRID fica carteira-only de
-- propósito: 014 segue exclusivo do DUILIO no Path 3 do operador-resolver
-- (os dois dividem 014 por carteira; segmento na INGRID criaria ambiguidade).
UPDATE public.operadores SET segmentos = '{{018}}'::text[]     WHERE nome = 'LARISSA';
UPDATE public.operadores SET segmentos = '{{007,010}}'::text[] WHERE nome = 'KAROLINE';
UPDATE public.operadores SET segmentos = '{{040,042}}'::text[] WHERE nome = 'MARIA';

-- 6. CAMADA 2 — contatos_cliente
DO $$
DECLARE v_del int; v_email int; v_dom int; v_op int;
BEGIN
  -- 6a. rewrite escopado: só CNPJs com e-mail válido na planilha
  DELETE FROM public.contatos_cliente
   WHERE regexp_replace(documento_cliente, '\\D', '', 'g') IN
         (SELECT cnpj FROM _rel WHERE email IS NOT NULL AND NOT blacklisted);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  INSERT INTO public.contatos_cliente
    (documento_cliente, tipo, identificador, ordem, tipo_uso, nome_pessoa,
     observacao, ativo, operador_responsavel_id)
  SELECT r.cnpj, 'email', r.email, 1, 'geral', r.responsavel,
         CASE WHEN r.telefone IS NOT NULL AND r.telefone <> ''
              THEN 'tel: ' || r.telefone END,
         true, o.id
  FROM _rel r JOIN public.operadores o ON o.nome = r.gestor
  WHERE r.email IS NOT NULL AND NOT r.blacklisted;
  GET DIAGNOSTICS v_email = ROW_COUNT;

  -- 6b. domínio corporativo (público fica fora — ver gerador)
  INSERT INTO public.contatos_cliente
    (documento_cliente, tipo, identificador, ordem, tipo_uso, ativo, operador_responsavel_id)
  SELECT r.cnpj, 'dominio', split_part(r.email, '@', 2), 1, 'geral', true, o.id
  FROM _rel r JOIN public.operadores o ON o.nome = r.gestor
  WHERE r.email IS NOT NULL AND NOT r.blacklisted
    AND split_part(r.email, '@', 2) NOT IN ({dominios_pub});
  GET DIAGNOSTICS v_dom = ROW_COUNT;

  -- 6c. contatos pré-existentes dos demais CNPJs da planilha seguem o novo dono
  UPDATE public.contatos_cliente cc
     SET operador_responsavel_id = o.id
    FROM _rel r JOIN public.operadores o ON o.nome = r.gestor
   WHERE regexp_replace(cc.documento_cliente, '\\D', '', 'g') = r.cnpj
     AND NOT r.blacklisted
     AND cc.operador_responsavel_id IS DISTINCT FROM o.id;
  GET DIAGNOSTICS v_op = ROW_COUNT;

  RAISE NOTICE 'mig 307 contatos: del=%, email=%, dominio=%, reatribuidos=%',
    v_del, v_email, v_dom, v_op;
END $$;

-- 7. CAMADA 3 — tracking_credentials (senha existente é preservada)
DO $$
DECLARE v_upd int; v_new int;
BEGIN
  UPDATE public.tracking_credentials tc
     SET operador_responsavel_id = o.id, updated_by = o.id,
         notes = coalesce(tc.notes, '') || ' | mig 307'
    FROM _rel r JOIN public.operadores o ON o.nome = r.gestor
   WHERE tc.documento = r.cnpj AND NOT r.blacklisted
     AND tc.operador_responsavel_id IS DISTINCT FROM o.id;
  GET DIAGNOSTICS v_upd = ROW_COUNT;

  INSERT INTO public.tracking_credentials
    (documento, nome_amigavel, senha, notes, ativo, operador_responsavel_id, updated_by)
  SELECT r.cnpj, r.nome, '', 'mig 307 relacionamento atualizado', true, o.id, o.id
  FROM _rel r JOIN public.operadores o ON o.nome = r.gestor
  WHERE NOT r.blacklisted
    AND NOT EXISTS (SELECT 1 FROM public.tracking_credentials t WHERE t.documento = r.cnpj);
  GET DIAGNOSTICS v_new = ROW_COUNT;

  RAISE NOTICE 'mig 307 tracking: reatribuidos=%, novos=%', v_upd, v_new;
END $$;

-- 8. CAMADA 4 — cards ATIVOS → dono da planilha + card_events.
-- Só operadores ativos NO Cockpit: INGRID/MARIA (dormentes) ficam de fora de
-- propósito — cards existentes não mudam de mão pra operador que não pode agir.
DO $$
DECLARE v_cards int;
BEGIN
  WITH alvo AS (
    SELECT r.cnpj, o.id AS op_id, o.nome AS op_nome
    FROM _rel r JOIN public.operadores o ON o.nome = r.gestor
    WHERE NOT r.blacklisted AND o.ativo AND o.cockpit_ativo
  ), afet AS (
    SELECT c.id, c.responsavel_relacionamento AS resp_old,
           c.assigned_operator_id AS aid_old, a.op_id, a.op_nome, a.cnpj
    FROM public.cards c
    JOIN alvo a ON lpad(regexp_replace(c.agent_state->>'cnpj_pagador', '\\D', '', 'g'), 14, '0') = a.cnpj
    WHERE c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')
      AND c.assigned_operator_id IS DISTINCT FROM a.op_id
  ), upd AS (
    UPDATE public.cards c
       SET assigned_operator_id = a.op_id,
           responsavel_relacionamento = a.op_nome,
           segmento_codigo = NULL
      FROM afet a WHERE c.id = a.id
    RETURNING c.id, a.resp_old, a.aid_old, a.op_nome, a.cnpj
  )
  INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
  SELECT id, 'OperadorReatribuido', 'system', 'mig_307_relacionamento_atualizado',
    jsonb_build_object(
      'responsavel_anterior', resp_old, 'assigned_anterior', aid_old,
      'responsavel_novo', op_nome, 'cnpj_pagador', cnpj,
      'motivo', 'Planilha Relacionamento Atualizado 2026-07-23 (planilha=verdade; ativos only)')
  FROM upd;
  GET DIAGNOSTICS v_cards = ROW_COUNT;
  RAISE NOTICE 'mig 307 cards reatribuidos: %', v_cards;
END $$;

-- 9. PÓS-CHECKS (abortam a transação inteira se falhar)
DO $$
DECLARE v int;
BEGIN
  -- 9a. todo CNPJ da planilha (não-blacklist) está na carteira do gestor-alvo
  SELECT count(*) INTO v FROM _rel r
   WHERE NOT r.blacklisted
     AND NOT EXISTS (SELECT 1 FROM public.operadores o
                      WHERE o.nome = r.gestor AND r.cnpj = ANY (o.carteira));
  IF v > 0 THEN RAISE EXCEPTION 'STOP pós-check 9a: % CNPJs fora da carteira alvo', v; END IF;

  -- 9b. nenhum CNPJ da planilha sobrou em carteira errada
  SELECT count(*) INTO v FROM _rel r
    JOIN public.operadores o ON r.cnpj = ANY (o.carteira) AND o.nome <> r.gestor
   WHERE NOT r.blacklisted;
  IF v > 0 THEN RAISE EXCEPTION 'STOP pós-check 9b: % CNPJs em carteira errada', v; END IF;

  -- 9c. invariante global: nenhum CNPJ em duas carteiras
  SELECT count(*) INTO v FROM (
    SELECT c FROM (SELECT unnest(carteira) c FROM public.operadores) s
    GROUP BY c HAVING count(*) > 1) d;
  IF v > 0 THEN RAISE EXCEPTION 'STOP pós-check 9c: % CNPJs em mais de uma carteira', v; END IF;

  -- 9d. card ativo de CNPJ da planilha (dono cockpit-ativo) com dono errado
  SELECT count(*) INTO v
  FROM public.cards c
  JOIN _rel r ON lpad(regexp_replace(c.agent_state->>'cnpj_pagador', '\\D', '', 'g'), 14, '0') = r.cnpj
  JOIN public.operadores o ON o.nome = r.gestor AND o.ativo AND o.cockpit_ativo
  WHERE NOT r.blacklisted
    AND c.state NOT IN ('RESOLVIDO', 'CANCELADO', 'TRANSFERIDO')
    AND c.assigned_operator_id IS DISTINCT FROM o.id;
  IF v > 0 THEN RAISE EXCEPTION 'STOP pós-check 9d: % cards ativos com dono errado', v; END IF;

  -- 9e. todo CNPJ da planilha existe no catálogo clientes
  SELECT count(*) INTO v FROM _rel r
   WHERE NOT EXISTS (SELECT 1 FROM public.clientes cl WHERE cl.cnpj_cpf = r.cnpj);
  IF v > 0 THEN RAISE EXCEPTION 'STOP pós-check 9e: % CNPJs fora do catálogo clientes', v; END IF;

  RAISE NOTICE 'mig 307 pós-checks OK';
END $$;

COMMIT;
"""
    OUT.write_text(sql, encoding="utf-8")
    print(f"gerado: {OUT} ({len(sql.splitlines())} linhas)")


if __name__ == "__main__":
    sys.exit(main())
