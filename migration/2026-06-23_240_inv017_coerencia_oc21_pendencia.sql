-- ============================================================================
-- Cockpit v2 — INV-017: a sugestão do interpretador NÃO pode contradizer as
-- pendências que ela mesma detectou.
-- Data: 2026-06-23
--
-- Caso âncora (NF 16480, SUPER INDUSTRIA C. / Caffeine Army): o cliente
-- respondeu "está alinhando nova tentativa de entrega e pediu para aguardar
-- confirmação". O interpretador-resposta-cliente gravou em
-- `cards.ia_sugestao_oc_resposta`:
--   { oc_sugerida: 21, confianca: 0.72,
--     pendencias_resposta_cliente: ["Cliente não confirmou novo endereço ou
--       data para a reentrega", "Cliente não respondeu sobre a ressalva..."] }
-- O front renderiza DOIS banners a partir desse mesmo JSONB: "🤖 SUGESTÃO DA
-- IA — Lançar oc 21" (roxo) e "⚠ IA detectou pendências — responder cliente"
-- (laranja). Contradição: oc=21 = reentrega CONFIRMADA; se o cliente só pediu
-- pra aguardar, a ação certa é manter aguardando (54) + responder cobrando,
-- NUNCA lançar a reentrega.
--
-- FIX EM 2 PARTES (a regra de verdade vive no edge):
--   1. edge `interpretador-resposta-cliente` + `_shared/regras-interpretador-
--      resposta.ts` (guard determinístico `reconciliarSugestaoInterpretador`,
--      testado em `regras-interpretador-resposta.test.ts`): oc=21 + pendência
--      aberta + NÃO sem_pagar → rebaixa pra 54 ANTES de persistir.
--   2. Esta migration: aplica o MESMO rebaixamento, retroativo, aos cards já
--      gravados (feedback_sempre_retroativo_pos_fix). Determinístico — espelha
--      o guard, sem LLM.
--
-- Event sourcing (CLAUDE.md #1): todo card ajustado ganha card_event
-- `SugestaoOc21RebaixadaPorPendencia` com a decisão crua da IA preservada.
--
-- skill: supabase-postgres-best-practices — UPDATE one-off, seletivo (oc=21 +
-- pendência), totalmente qualificado em public.*, transação curta, sem função
-- nova / índice / RLS novos.
-- ============================================================================

WITH afetados AS (
  SELECT
    c.id,
    c.ia_sugestao_oc_resposta AS s
  FROM public.cards c
  WHERE c.ia_sugestao_oc_resposta IS NOT NULL
    AND (c.ia_sugestao_oc_resposta->>'oc_sugerida') = '21'
    AND jsonb_array_length(
          COALESCE(c.ia_sugestao_oc_resposta->'pendencias_resposta_cliente', '[]'::jsonb)
        ) > 0
    -- Exceção da feature reentrega-sem-pagar (Caio 2026-05-18): aval explícito
    -- mantém 21. Em rows antigas o campo não existe → COALESCE false → elegível.
    AND COALESCE(
          (c.ia_sugestao_oc_resposta->>'cliente_autorizou_reentrega_sem_pagar')::boolean,
          false
        ) = false
),
atualizados AS (
  UPDATE public.cards c
  SET ia_sugestao_oc_resposta =
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  a.s,
                  '{oc_sugerida}', '54'::jsonb, true
                ),
                '{confianca}',
                to_jsonb(LEAST(COALESCE((a.s->>'confianca')::numeric, 0), 0.5)),
                true
              ),
              '{instrucao_reentrega_sugerida}', '""'::jsonb, true
            ),
            '{rebaixado_de_oc21_por_pendencia}', 'true'::jsonb, true
          ),
          '{motivo}',
          to_jsonb(
            'Cliente ainda não confirmou os dados da reentrega (ver pendências) — manter aguardando e responder cobrando antes de lançar oc 21. [retroativo INV-017; IA havia sugerido oc 21]'::text
          ),
          true
        )
  FROM afetados a
  WHERE c.id = a.id
  RETURNING c.id, a.s AS sugestao_crua
)
INSERT INTO public.card_events (card_id, event_type, actor_type, actor_id, payload)
SELECT
  u.id,
  'SugestaoOc21RebaixadaPorPendencia',
  'system',
  'migration_240_inv017',
  jsonb_build_object(
    'oc_sugerida_ia', 21,
    'oc_sugerida_final', 54,
    'retroativo', true,
    'confianca_ia', (u.sugestao_crua->>'confianca'),
    'pendencias', u.sugestao_crua->'pendencias_resposta_cliente',
    'motivo_ia_cru', u.sugestao_crua->>'motivo'
  )
FROM atualizados u;
