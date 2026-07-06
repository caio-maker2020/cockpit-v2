-- =============================================================================
-- 2026-06-26_275 — Identidade única de ação (acao_key) + destaque preciso
--                  (proposta_destacada_acao). Backfill de TODOS os cards abertos.
--
-- Caio 2026-06-26 (NF 463457, JULIA / AVANTE SAUDE): "lançar 54 + e-mail" e
-- "lançar 54 SEM e-mail" são DUAS ações OPOSTAS. O banner mostrava a recomendada
-- "54 + e-mail (com template)" mas, como a recomendação trafegava só como NÚMERO
-- (proposta_destacada=54) e existem dois todos com codigo_ssw=54, o clique
-- acionava a "54 SEM e-mail" — cliente NUNCA notificado, mas o sistema entende
-- "54 lançada = cliente avisado, aguardando retorno". Risco grave de silêncio.
--
-- Fix de raiz (código): cada ação carrega proposta_payload.acao_key =
-- "<tool>:<codigo_ssw>" (sem colisão: com-email e sem-email diferem pelo tool);
-- o agente grava analise_padrao_resultado.proposta_destacada_acao (identidade
-- precisa). O front destaca/vincula o banner pela acao_key — nunca pelo número.
--
-- Este backfill carimba os DOIS campos nos dados já existentes pra a correção
-- valer retroativamente em todos os cards abertos. Idempotente (só toca linhas
-- sem o campo). NÃO altera schema — só dados (jsonb).
-- Guard de regressão: _shared/regras-auto-acao.sem-email-54.test.ts (INV-027).
-- =============================================================================

BEGIN;

-- (1) acao_key nos todos ATIVOS (pendente/aprovado) que ainda não têm.
--     Só carimba quando tool E codigo_ssw existem (free-text sem oc fica de fora).
--     WHERE bounded (status ativo) → não reescreve a tabela inteira.
UPDATE todos
SET proposta_payload = jsonb_set(
      proposta_payload,
      '{acao_key}',
      to_jsonb((proposta_payload->>'tool') || ':' || (proposta_payload->'args'->>'codigo_ssw'))
    )
WHERE status IN ('pendente', 'aprovado')
  AND (proposta_payload->>'tool') IS NOT NULL
  AND (proposta_payload->'args'->>'codigo_ssw') IS NOT NULL
  AND NOT (proposta_payload ? 'acao_key');

-- (2) proposta_destacada_acao nos cards com análise concluída e destaque setado.
--     Deriva a identidade precisa: 54 com template → "+ e-mail"; 54 sem template
--     → "sem e-mail"; 56 → lancar_ocorrencia:56. (proposta_destacada ∈ {54,56}.)
UPDATE cards
SET analise_padrao_resultado = jsonb_set(
      analise_padrao_resultado,
      '{proposta_destacada_acao}',
      to_jsonb(
        CASE
          WHEN (analise_padrao_resultado->>'proposta_destacada') = '54'
               AND COALESCE(analise_padrao_resultado->>'template_email_sugerido', '') <> ''
            THEN 'lancar_oc_e_enviar_email:54'
          WHEN (analise_padrao_resultado->>'proposta_destacada') = '54'
            THEN 'lancar_ocorrencia:54'
          WHEN (analise_padrao_resultado->>'proposta_destacada') = '56'
            THEN 'lancar_ocorrencia:56'
          ELSE NULL
        END
      )
    )
WHERE analise_padrao_status = 'concluida'
  AND (analise_padrao_resultado->>'proposta_destacada') IS NOT NULL
  AND NOT (analise_padrao_resultado ? 'proposta_destacada_acao');

COMMIT;
