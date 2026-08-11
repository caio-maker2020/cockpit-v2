-- =============================================================================
-- 2026-08-11_325 — kill-switch da capacidade nova da oc 10 (learning_log
-- f665c8f2, regra da Isadora): o agente-sugere-ocs-padrao passa a consultar os
-- e-mails do card ANTES de decidir e, quando o cliente JÁ pediu/autorizou a
-- devolução, destaca 44 em vez de 54/56.
--
-- NASCE DESLIGADA de propósito. O deploy não muda comportamento nenhum; ligar é
-- decisão do Caio, por UPDATE, sem novo deploy:
--
--   UPDATE feature_flags SET enabled = true, updated_at = now()
--    WHERE key = 'oc10_devolucao_por_email_enabled';
--
-- Desligar tem o mesmo custo (enabled = false) — reversão instantânea, sem rollback
-- de código.
--
-- Calibração que justifica a regra (evals/calibrar-devolucao-oc10.ts, 11/08):
--   recall 18.8% (9 de 48 casos que o time corrigiu pra 44)
--   falso positivo 0.4% (3 de 805 casos que o agente já acerta com 54)
--   ganho líquido +6 casos
-- =============================================================================

INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'oc10_devolucao_por_email_enabled',
  false,
  'Liga a consulta de e-mails do card em oc 10 (recusa): quando o cliente JÁ pediu/autorizou a devolução por e-mail antes da análise, o agente destaca 44 (lancar_ocorrencia:44) em vez de 54/56, com o trecho verbatim do e-mail no banner. Regra aprendida com a Isadora (learning_log f665c8f2). Calibração 11/08: recall 18.8%, falso positivo 0.4%, ganho líquido +6. OFF = comportamento anterior, idêntico.'
)
ON CONFLICT (key) DO UPDATE
  SET description = EXCLUDED.description,
      updated_at  = now();
