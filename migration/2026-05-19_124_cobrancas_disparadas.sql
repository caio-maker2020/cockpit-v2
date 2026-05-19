-- ============================================================================
-- Cockpit v2 — cobrancas_disparadas (audit log PRIORIDADES AI)
-- Data: 2026-05-19
--
-- Cada cobrança disparada via Cockpit gera 1 linha. Snapshot completo do
-- contato + texto + status pra:
--   - audit
--   - timeline no modal do card
--   - input do agente Monitor de Efetividade (texto + data → veredito)
--
-- RLS: SELECT escopa por operador via card_visivel_pelo_operador_atual.
-- INSERT: só service_role (edge function disparar-cobranca-escalonada).
-- ============================================================================

CREATE TABLE public.cobrancas_disparadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  papel text NOT NULL CHECK (papel IN (
    'gerente_base','coordenador_entrega','gerente_relacionamento')),
  canal text NOT NULL CHECK (canal IN ('email','whatsapp')),
  contato_escal_id uuid REFERENCES public.contatos_escalonamento(id),
  -- Snapshot do contato (caso a row em contatos_escalonamento mude depois)
  contato_nome text,
  contato_destino text,                        -- email ou telefone normalizado
  -- Mensagem
  texto_enviado text NOT NULL,
  assunto text,                                -- só email
  -- Status
  status text NOT NULL CHECK (status IN ('enviado','falhou')),
  erro text,
  -- Snapshot do card no momento da cobrança (pra Monitor avaliar efetividade)
  oc_no_disparo int,
  dias_parados_no_disparo numeric,
  -- IDs externos (idempotência futura + linking)
  evolution_message_id text,                   -- só whatsapp
  gmail_message_id text,                       -- só email
  -- Audit
  disparado_em timestamptz NOT NULL DEFAULT now(),
  disparado_por uuid REFERENCES public.operadores(id)
);

CREATE INDEX idx_cobrancas_card_disparado
  ON public.cobrancas_disparadas (card_id, disparado_em DESC);
CREATE INDEX idx_cobrancas_card_papel
  ON public.cobrancas_disparadas (card_id, papel, disparado_em DESC);
CREATE INDEX idx_cobrancas_disparado_em
  ON public.cobrancas_disparadas (disparado_em DESC);

ALTER TABLE public.cobrancas_disparadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY cobrancas_select
  ON public.cobrancas_disparadas
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cards c
      WHERE c.id = cobrancas_disparadas.card_id
        AND public.card_visivel_pelo_operador_atual(
          c.assigned_operator_id, c.pagador, c.segmento_codigo)
    )
  );

COMMENT ON TABLE public.cobrancas_disparadas IS
  'Audit log de cobranças escalonadas (PRIORIDADES AI). Cada disparo de '
  'cobrança via Cockpit gera 1 linha. INSERT só via edge disparar-cobranca-'
  'escalonada (service_role). RLS escopa SELECT pelo operador dono do card.';
