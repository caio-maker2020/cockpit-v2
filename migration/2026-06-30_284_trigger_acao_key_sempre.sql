-- =============================================================================
-- 2026-06-30_284 — acao_key SEMPRE presente em todo todo com tool+codigo_ssw
--                  (trigger de ponto único) + re-backfill dos ativos.
--
-- Caio 2026-06-30 (NF 27573, MED CENTER / LARISSA): operadora clica em
-- "Aprovar oc=54 + email" (deve NOTIFICAR o cliente) e aparece o pop-up
-- "...NÃO envia e-mail. O cliente NÃO será notificado." — a confirmação da
-- ação OPOSTA. Reabriu o INV-027 (NF 463457).
--
-- DUAS causas independentes provadas:
--   (1) FRONT: vincula o botão do banner pelo NÚMERO da oc (54), não pela
--       acao_key — cai no todo "sem e-mail". Fix = prompt Lovable
--       (prompts/lovable-FIX-banner-mais-email-dispara-confirmacao-sem-email.md).
--   (2) BACKEND (este arquivo): a mig 275 carimbou acao_key UMA vez, mas dos
--       18 fluxos que inserem todos só regras-auto-acao.ts grava acao_key.
--       extravio-enrichment, propostas-pos-resposta-cliente, vinculador,
--       sync-bastao, reconciliar-extravios-bastao, transicao-aguardando-cliente
--       etc. inserem SEM acao_key → 701 todos ativos pós-275 sem acao_key,
--       inclusive os PARES cod=54 (+email E sem-email) no MESMO card. Pra
--       esses o front não tem acao_key pra casar — nem o front corrigido
--       conseguiria distinguir. INV-027 (DB) está VERMELHO.
--
-- Fix de RAIZ (ponto único, deploy-free, à prova de fluxo novo): trigger
-- BEFORE INSERT/UPDATE que deriva acao_key = "<tool>:<codigo_ssw>" sempre que
-- tool E args.codigo_ssw existem e acao_key está AUSENTE. Reproduz exatamente
-- acaoKey(tool, cod) de _shared/regras-auto-acao.ts. Nunca sobrescreve quem já
-- tem (callers que gravam acao_key seguem mandando). Free-text sem oc fica de
-- fora (sem número pra colidir), igual à mig 275 e ao guard INV-027.
--
-- Guard de regressão: /verify-cockpit INV-027 (DB) = 0 todos ativos sem
-- acao_key (volta a PASS e fica) + checagem da existência do trigger.
-- Idempotente. Não altera schema (só comportamento + dados jsonb).
-- =============================================================================

BEGIN;

-- (1) Função do trigger: deriva acao_key quando ausente. SECURITY INVOKER
--     (default) — só mexe no NEW, não acessa tabela. search_path fixo (vazio):
--     jsonb_set/to_jsonb/operadores jsonb vivem em pg_catalog, sempre no path.
CREATE OR REPLACE FUNCTION public.todos_preencher_acao_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.proposta_payload IS NOT NULL
     AND (NEW.proposta_payload->>'tool') IS NOT NULL
     AND (NEW.proposta_payload->'args'->>'codigo_ssw') IS NOT NULL
     AND NOT (NEW.proposta_payload ? 'acao_key')
  THEN
    NEW.proposta_payload := jsonb_set(
      NEW.proposta_payload,
      '{acao_key}',
      to_jsonb(
        (NEW.proposta_payload->>'tool') || ':' ||
        (NEW.proposta_payload->'args'->>'codigo_ssw')
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

-- (2) Trigger: INSERT sempre; UPDATE só quando proposta_payload é reescrito
--     (evita disparar em cada mudança de status — perf). Self-healing pra
--     qualquer linha que reescreva o payload sem acao_key.
DROP TRIGGER IF EXISTS trg_todos_preencher_acao_key ON public.todos;
CREATE TRIGGER trg_todos_preencher_acao_key
  BEFORE INSERT OR UPDATE OF proposta_payload ON public.todos
  FOR EACH ROW
  EXECUTE FUNCTION public.todos_preencher_acao_key();

-- (3) Re-backfill dos ativos (pendente/aprovado) que nasceram sem acao_key
--     entre a mig 275 e agora. Mesma derivação do trigger e da mig 275.
--     WHERE bounded (status ativo) → não reescreve a tabela inteira.
UPDATE public.todos
SET proposta_payload = jsonb_set(
      proposta_payload,
      '{acao_key}',
      to_jsonb((proposta_payload->>'tool') || ':' || (proposta_payload->'args'->>'codigo_ssw'))
    )
WHERE status IN ('pendente', 'aprovado')
  AND (proposta_payload->>'tool') IS NOT NULL
  AND (proposta_payload->'args'->>'codigo_ssw') IS NOT NULL
  AND NOT (proposta_payload ? 'acao_key');

COMMIT;
