-- ============================================================================
-- 2026-08-11_327 — RECONCILIADOR DE RESPOSTA DE CLIENTE PENDENTE (INV-067).
--
-- PROBLEMA (Caio 2026-08-11, NFs 306856/74790/439189/5726093 + 11 mais):
--   A decisão "esta resposta acorda o card?" é tomada UMA vez, no instante em
--   que o vinculador processa a mensagem, com o estado daquele momento. Se o
--   card estava num estado que não acorda, a resposta fica órfã PARA SEMPRE —
--   mesmo o card voltando a ficar ativo minutos depois. Três portas de entrada
--   confirmadas por evento: EXTRAVIO_MONITORADO, terminal-depois-reaberto, e
--   ação do operador que falhou e reverteu o card.
--   Medido em 60 dias: 6.879 respostas capturadas, 15 paradas em
--   AGUARDANDO_CLIENTE (a mais antiga há 54 dias) + 1 em AVH.
--
-- FIX NA RAIZ: a invariante "card acionável + resposta não tratada = card se
--   move" passa a ser verificada CONTINUAMENTE (cron 1min), em vez de uma vez
--   por mensagem. Independe de quem mudou o estado e de quando — e vale para
--   TODOS os ciclos, não só o primeiro.
--
-- Esta RPC é só o DETECTOR (read-only). Quem age é a edge function
-- cron-ia-resposta-pendentes, chamando _shared/acionar-resposta-cliente.ts
-- (mesma fonte única do vinculador — nunca duplicar o efeito).
--
-- Critério idêntico ao do monitor INV-042 no health-check (provado em produção
-- desde 23/07 sem falso positivo), com uma diferença: aqui ele AGE.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Estados em que o card é ACIONÁVEL. TRANSFERIDO/RESOLVIDO/CANCELADO ficam de
-- fora de propósito: é a premissa 2 do Caio (card tratado não ressuscita) —
-- 487+102+7 respostas nesses estados nos últimos 60d são silêncio CORRETO.
CREATE OR REPLACE FUNCTION public.cards_resposta_cliente_nao_acionada(
  p_limit          integer DEFAULT 20,
  p_grace_minutos  integer DEFAULT 5,    -- respeita o caminho normal do vinculador
  p_dias           integer DEFAULT 90    -- janela de varredura
)
RETURNS TABLE(
  id uuid,
  nf text,
  state text,
  capturada_em timestamptz,
  message_id uuid
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH cap AS (
    SELECT ce.card_id, max(ce.created_at) AS capturada_em
    FROM public.card_events ce
    WHERE ce.event_type = 'RespostaClienteCapturada'
      AND ce.created_at > now() - make_interval(days => GREATEST(1, LEAST(p_dias, 365)))
      AND ce.created_at < now() - make_interval(mins => GREATEST(0, LEAST(p_grace_minutos, 1440)))
    GROUP BY ce.card_id
  )
  SELECT c.id,
         c.nf,
         c.state,
         cap.capturada_em,
         (SELECT mi.id FROM public.messages_inbox mi
           WHERE mi.card_id = c.id
           ORDER BY mi.recebido_em DESC
           LIMIT 1) AS message_id
  FROM cap
  JOIN public.cards c ON c.id = cap.card_id
  WHERE c.state IN ('AGUARDANDO_CLIENTE', 'ACAO_EXECUTADA', 'AGUARDANDO_VALIDACAO_HUMANA')
    -- já processada: marcador do acionamento OU ação do operador depois
    AND NOT EXISTS (
      SELECT 1 FROM public.card_events x
      WHERE x.card_id = c.id
        AND x.event_type IN ('RetornoClienteEmAguardo', 'AprovacaoOperador', 'AcaoExecutada')
        AND x.created_at >= cap.capturada_em - interval '1 minute'
    )
    -- operadora respondeu por fora depois da captura = tratada (guard do INV-042)
    AND NOT EXISTS (
      SELECT 1 FROM public.cards_emails_outbound o
      WHERE o.card_id = c.id AND o.sent_at > cap.capturada_em
    )
  ORDER BY cap.capturada_em ASC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$function$;

REVOKE ALL ON FUNCTION public.cards_resposta_cliente_nao_acionada(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cards_resposta_cliente_nao_acionada(integer, integer, integer) TO service_role;

COMMENT ON FUNCTION public.cards_resposta_cliente_nao_acionada(integer, integer, integer) IS
  'INV-067: cards ACIONÁVEIS com resposta de cliente capturada e nunca acionada. Detector read-only do reconciliador (cron-ia-resposta-pendentes). Caio 2026-08-11.';

-- Flag master do reconciliador. OFF = modo SOMBRA (lista o que faria, não age)
-- — padrão shadow-first do projeto (agente-extravio-d4, oc43, gate 33).
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'reconciliador_resposta_pendente_enabled',
  false,
  'INV-067: aciona automaticamente card acionável com resposta de cliente não tratada. OFF = sombra (só lista).'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
