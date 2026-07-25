-- 2026-07-25_312 — Reabrir proposta de melhoria (undo da fila F6) + retroativo
--
-- Incidente 24/07 (auditoria 25/07): a Isadora rejeitou SEM QUERER a proposta
-- "Melhorar o leitor de respostas do cliente" (regra do comprovante legível,
-- NFs 893551/1828915) 21s depois de responder a pergunta. O painel não tinha
-- confirmação nem undo, e revisar_learning_log (mig 197) só permite
-- aberto→{aprovado|rejeitado|observacao} — a correção era IMPOSSÍVEL pela UI.
--
-- Raiz atacada aqui (camada de dados):
--   1. RPC reabrir_learning_log — undo real: {aprovado|rejeitado}→aberto,
--      gestor-only, restrita a tipo='ajuste_sugerido' (a fila F6). Estados
--      terminais dos agentes (aplicado/revertido) seguem intocáveis.
--   2. Retroativo: reabre o ajuste 1683efd9 (rejeição acidental) pra proposta
--      voltar à fila "Melhorias aguardando aprovação" do Caio.
--
-- Dedup seguro: gerarAjustesDeRespostas deduplica por parent_id (qualquer
-- status), então reabrir a MESMA linha não gera proposta duplicada.
-- A parte de front (confirmação + trilha de revisadas + botão Reabrir) vai
-- na mesma branch: fix/aprendizado-melhorias-confirmacao-reabrir.
--
-- skill: supabase-postgres-best-practices — SECURITY DEFINER com search_path
-- fixo, REVOKE PUBLIC/anon, GRANT mínimo (authenticated + service_role),
-- checagem de papel dentro da função, UPDATE por PK com guarda de status.

BEGIN;

CREATE OR REPLACE FUNCTION public.reabrir_learning_log(
  p_id uuid,
  p_motivo text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operador_id uuid;
  v_papel text;
  v_log record;
BEGIN
  SELECT id, papel INTO v_operador_id, v_papel
  FROM public.operadores WHERE user_id = auth.uid() LIMIT 1;

  IF v_operador_id IS NULL THEN
    RAISE EXCEPTION 'Operador não encontrado pra auth.uid()=%', auth.uid()
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_papel <> 'gestor' THEN
    RAISE EXCEPTION 'Só gestor pode reabrir learning_log'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, status, tipo INTO v_log
  FROM public.learning_log WHERE id = p_id FOR UPDATE;

  IF v_log.id IS NULL THEN
    RAISE EXCEPTION 'learning_log % não encontrado', p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Undo só na fila F6; perguntas/relatórios/estados terminais ficam fora.
  IF v_log.tipo <> 'ajuste_sugerido' THEN
    RAISE EXCEPTION 'Só ajuste_sugerido pode ser reaberto (tipo=%)', v_log.tipo
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_log.status NOT IN ('aprovado', 'rejeitado') THEN
    RAISE EXCEPTION 'learning_log % em status=% (só aprovado/rejeitado reabrem)',
      p_id, v_log.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.learning_log
  SET status = 'aberto',
      revisado_por = v_operador_id,
      revisado_em = now(),
      motivo_decisao = left(
        'Reaberto no painel (era ' || v_log.status || ')' ||
        coalesce(': ' || nullif(trim(p_motivo), ''), ''), 500)
  WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status_anterior', v_log.status);
END;
$$;

COMMENT ON FUNCTION public.reabrir_learning_log IS
  'Undo da fila F6: gestor reabre ajuste_sugerido aprovado/rejeitado de volta pra aberto (incidente da rejeição acidental de 24/07). Terminais aplicado/revertido não reabrem.';

REVOKE ALL ON FUNCTION public.reabrir_learning_log(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reabrir_learning_log(uuid, text)
  TO authenticated, service_role;

-- ============================================================
-- Retroativo: reabre a proposta rejeitada sem querer em 24/07 12:50:59
-- (regra do comprovante legível — resposta e5664c0b da Isadora).
-- Guarda por id + status: se alguém já reabriu/decidiu, vira no-op.
-- ============================================================

UPDATE public.learning_log
SET status = 'aberto',
    motivo_decisao = 'Reaberto retroativamente (mig 312): rejeição de 24/07 12:50:59 foi clique acidental — auditoria 25/07'
WHERE id = '1683efd9-05a0-4e92-8c6a-87534f99cc9c'
  AND tipo = 'ajuste_sugerido'
  AND status = 'rejeitado';

COMMIT;
