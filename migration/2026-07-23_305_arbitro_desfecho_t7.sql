-- 2026-07-23_305 — F3: Árbitro de Desfecho T+7 (fundação de dados)
-- Spec D1: "acerto" = concordância arbitrada por desfecho real. Cada par
-- sugestão×decisão com 7+ dias ganha um carimbo do que REALMENTE aconteceu
-- com o card — lido do banco (estado + eventos), ZERO chamada nova ao SSW.
--
-- Conservador por desenho: só afirma confirma_ia/confirma_operador quando o
-- card resolveu limpo; o resto é inconclusivo (honestidade > cobertura).

BEGIN;

CREATE TABLE public.desfechos_pares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fonte_tabela text NOT NULL,
  fonte_id uuid NOT NULL,
  card_id uuid REFERENCES public.cards(id) ON DELETE CASCADE,
  agent_name text NOT NULL,
  veredito_par text NOT NULL,
  oc_sugerida integer,
  oc_executada integer,
  decidido_em timestamptz NOT NULL,
  desfecho text NOT NULL CHECK (desfecho IN
    ('resolvido_limpo','reaberto','bounce','oc_nova','em_aberto','indefinido')),
  arbitro text NOT NULL CHECK (arbitro IN
    ('confirma_ia','confirma_operador','inconclusivo')),
  estado_card text,
  cod_ultima_ocorrencia integer,
  sinais jsonb,
  avaliado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fonte_tabela, fonte_id)
);

COMMENT ON TABLE public.desfechos_pares IS
  'Árbitro T+7 do Loop de Aprendizado: desfecho real do card 7+ dias após cada par sugestão×decisão. Escrito só pela edge arbitro-desfecho (service_role).';

CREATE INDEX idx_desfechos_pares_card ON public.desfechos_pares (card_id);
CREATE INDEX idx_desfechos_pares_agent
  ON public.desfechos_pares (agent_name, avaliado_em DESC);

ALTER TABLE public.desfechos_pares ENABLE ROW LEVEL SECURITY;
CREATE POLICY desfechos_pares_select_gestor ON public.desfechos_pares
  FOR SELECT TO authenticated
  USING ((SELECT public.current_operador_papel()) = 'gestor');
-- escrita: só service_role (sem policy de INSERT/UPDATE de propósito)

-- Fila do árbitro: pares com 7+ dias ainda sem carimbo
CREATE VIEW public.v_pares_sem_desfecho
WITH (security_invoker = on) AS
SELECT u.*
FROM public.v_agent_feedback_unificado u
LEFT JOIN public.desfechos_pares d
  ON d.fonte_tabela = u.fonte_tabela AND d.fonte_id = u.fonte_id
WHERE d.id IS NULL
  AND u.card_id IS NOT NULL
  AND u.decidido_em < now() - interval '7 days';

-- Sinal de Ouro + desfecho (consumo do painel/orquestrador daqui pra frente)
CREATE VIEW public.v_sinal_ouro_com_desfecho
WITH (security_invoker = on) AS
SELECT
  u.*,
  d.desfecho,
  d.arbitro,
  d.estado_card,
  d.avaliado_em AS desfecho_avaliado_em
FROM public.v_agent_feedback_unificado u
LEFT JOIN public.desfechos_pares d
  ON d.fonte_tabela = u.fonte_tabela AND d.fonte_id = u.fonte_id;

COMMIT;
