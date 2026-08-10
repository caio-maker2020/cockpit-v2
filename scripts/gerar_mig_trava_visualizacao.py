#!/usr/bin/env python3
"""Gera migration/2026-08-10_324_trava_visualizacao_gestor.sql.

Trava "modo visualização" (Caio 10/08): João e Isadora veem tudo (RLS gestor)
mas NÃO executam ações de card nem cadastros. Aprendizado fica livre (validam
melhorias — é o papel deles no loop). A trava é server-side:

  1. operadores.pode_executar (default true; João/Isadora = false)
  2. Guard `assert_pode_executar()` injetado como 1ª linha dos 17 RPCs de
     mutação SECURITY DEFINER que o front chama (RLS não os alcança)
  3. Policies RESTRICTIVE de escrita nas 4 tabelas com write direto do front

As definições dos RPCs são lidas do banco AO GERAR (pg_get_functiondef) —
rodar de novo se algum RPC mudar antes de aplicar. service_role/cron nunca
são travados (auth.uid() null → coalesce true).
"""
import os
import subprocess
import sys

RPCS_TRAVADOS = [
    # ações de card
    "aprovar_e_executar",
    "escolher_tratativa_email",
    "ignorar_pendencias_resposta_cliente",
    "adotar_thread_preexistente",
    "descartar_email_preexistente",
    "extravios_atualizar_status",
    "lancar_oc_emergencial_acao_executada",
    "liberar_card_suspeito_lockado",
    "marcar_cancelamento_tratado",
    "marcar_card_nao_importante",
    "marcar_email_preexistente_visto",
    "marcar_retorno_inconclusivo",
    "registrar_feedback_interpretador_resposta_ia",
    "registrar_motivo_divergencia",
    "reportar_erro_lancamento",
    # cadastros
    "cadastrar_cliente_completo",
    "desativar_cliente",
]
# Aprendizado fica FORA de propósito: reabrir_learning_log,
# responder_pergunta_aprendizado, revisar_learning_log.

GUARD_LINE = "  PERFORM public.assert_pode_executar();  -- trava modo visualização (mig 324)\n"
DB_URL = os.environ.get("SUPABASE_DB_URL")
if not DB_URL:
    sys.exit("SUPABASE_DB_URL não definido (source .env.local)")


def functiondef(nome: str) -> str:
    out = subprocess.run(
        ["psql", DB_URL, "-At", "-c",
         "SELECT pg_get_functiondef(p.oid) FROM pg_proc p "
         "WHERE p.pronamespace='public'::regnamespace AND p.proname=%s"
         % ("'" + nome + "'")],
        capture_output=True, text=True, check=True).stdout.strip()
    if not out.startswith("CREATE OR REPLACE FUNCTION"):
        sys.exit(f"{nome}: definição inesperada")
    return out


def injetar_guard(nome: str, ddl: str) -> str:
    if "assert_pode_executar" in ddl:
        sys.exit(f"{nome}: guard já presente — abortando (idempotência é do REPLACE)")
    corpo_ini = ddl.index("$function$")
    pos = ddl.find("\nBEGIN\n", corpo_ini)
    if pos < 0:
        sys.exit(f"{nome}: não achei o BEGIN externo")
    pos += len("\nBEGIN\n")
    return ddl[:pos] + GUARD_LINE + ddl[pos:]


partes: list[str] = []
for nome in RPCS_TRAVADOS:
    ddl = injetar_guard(nome, functiondef(nome))
    partes.append(f"-- ── {nome}: guard injetado como 1ª linha do corpo ──\n{ddl};\n")

sql_rpcs = "\n".join(partes)

MIG = f"""-- ============================================================================
-- 2026-08-10_324 — TRAVA MODO VISUALIZAÇÃO (João Penha + Isadora Baldoni).
--
-- Decisões do Caio (10/08): os dois veem TUDO (RLS gestor intacta) mas não
-- executam ações de card nem cadastros. Aprendizado LIVRE pros dois (chat +
-- fila de melhorias). Caio (gestor) segue com pode_executar=true.
--
-- Camadas: coluna + helpers → guard nos 17 RPCs SECURITY DEFINER → policies
-- RESTRICTIVE de escrita (writes diretos do front). service_role nunca trava
-- (auth.uid() null → coalesce true) — crons/agentes intactos.
-- Gerado por scripts/gerar_mig_trava_visualizacao.py a partir do banco.
-- ============================================================================

-- TRANSAÇÕES CURTAS, não uma só: transação única deadlockava com os crons
-- (segurava operadores esperando cards ↔ cron segurando cards lendo operadores).
-- Cada bloco é idempotente — se um falhar por lock, re-rodar o arquivo cura.

-- Bloco 1: coluna + flags + helpers (locks só em operadores) -----------------
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.operadores
  ADD COLUMN IF NOT EXISTS pode_executar boolean NOT NULL DEFAULT true;

UPDATE public.operadores SET pode_executar = false
WHERE lower(email) IN ('joao.penha@salexpress.com.br',
                       'isadora.baldoni@salexpress.com.br');

CREATE OR REPLACE FUNCTION public.current_operador_pode_executar()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT pode_executar FROM public.operadores WHERE user_id = auth.uid() LIMIT 1),
    true);  -- sem operador (service_role/cron) → nunca trava
$$;

CREATE OR REPLACE FUNCTION public.assert_pode_executar()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'MODO_VISUALIZACAO: seu usuário é somente visualização — ações bloqueadas'
      USING ERRCODE = 'P0403';
  END IF;
END $$;

COMMIT;

-- Bloco 2: guard nos 17 RPCs de mutação (locks só em pg_proc) ----------------
BEGIN;
SET LOCAL lock_timeout = '5s';
{sql_rpcs}
COMMIT;

-- Bloco 3: policies RESTRICTIVE de escrita — cards e card_events são quentes,
-- cada tabela na sua transação curta. Não toca as policies existentes (zero
-- regressão de visibilidade); RESTRICTIVE faz AND com as permissivas.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS trava_visualizacao_upd ON public.cards;
CREATE POLICY trava_visualizacao_upd ON public.cards AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING ((SELECT public.current_operador_pode_executar()));
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS trava_visualizacao_ins ON public.card_events;
CREATE POLICY trava_visualizacao_ins ON public.card_events AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.current_operador_pode_executar()));
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY IF EXISTS trava_visualizacao_ins ON public.contatos_cliente;
DROP POLICY IF EXISTS trava_visualizacao_upd ON public.contatos_cliente;
DROP POLICY IF EXISTS trava_visualizacao_del ON public.contatos_cliente;
CREATE POLICY trava_visualizacao_ins ON public.contatos_cliente AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_upd ON public.contatos_cliente AS RESTRICTIVE
  FOR UPDATE TO authenticated USING ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_del ON public.contatos_cliente AS RESTRICTIVE
  FOR DELETE TO authenticated USING ((SELECT public.current_operador_pode_executar()));

DROP POLICY IF EXISTS trava_visualizacao_ins ON public.contatos_escalonamento;
DROP POLICY IF EXISTS trava_visualizacao_upd ON public.contatos_escalonamento;
DROP POLICY IF EXISTS trava_visualizacao_del ON public.contatos_escalonamento;
CREATE POLICY trava_visualizacao_ins ON public.contatos_escalonamento AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_upd ON public.contatos_escalonamento AS RESTRICTIVE
  FOR UPDATE TO authenticated USING ((SELECT public.current_operador_pode_executar()));
CREATE POLICY trava_visualizacao_del ON public.contatos_escalonamento AS RESTRICTIVE
  FOR DELETE TO authenticated USING ((SELECT public.current_operador_pode_executar()));
COMMIT;

-- Bloco final: asserts (só leitura + GUC local) -------------------------------
BEGIN;
DO $t$
DECLARE v_joao uuid; v_maria uuid; v_pegou boolean := false;
BEGIN
  SELECT user_id INTO v_joao  FROM operadores WHERE lower(email)='joao.penha@salexpress.com.br';
  SELECT user_id INTO v_maria FROM operadores WHERE nome='MARIA';
  IF v_joao IS NULL OR v_maria IS NULL THEN RAISE EXCEPTION 'ASSERT: operadores ausentes'; END IF;

  -- João (visualização) → false; RPC deve abortar com P0403
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_joao)::text, true);
  IF public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'ASSERT: João deveria estar travado';
  END IF;
  BEGIN
    PERFORM public.marcar_card_nao_importante(gen_random_uuid());
  EXCEPTION WHEN sqlstate 'P0403' THEN v_pegou := true;
  END;
  IF NOT v_pegou THEN RAISE EXCEPTION 'ASSERT: RPC não travou pro João'; END IF;

  -- Maria (operadora) → true (zero regressão)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_maria)::text, true);
  IF NOT public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'ASSERT: Maria NÃO pode ser travada';
  END IF;

  -- service_role / cron (sem uid) → true (crons intactos)
  PERFORM set_config('request.jwt.claims', NULL, true);
  IF NOT public.current_operador_pode_executar() THEN
    RAISE EXCEPTION 'ASSERT: sem uid deveria passar (cron)';
  END IF;

  RAISE NOTICE 'ASSERTS OK: João travado (P0403), Maria livre, cron livre';
END $t$;

COMMIT;
"""

destino = os.path.join(os.path.dirname(__file__), "..",
                       "migration", "2026-08-10_324_trava_visualizacao_gestor.sql")
with open(destino, "w", encoding="utf-8") as f:
    f.write(MIG)
print(f"gerada: {os.path.normpath(destino)} ({len(RPCS_TRAVADOS)} RPCs com guard)")
