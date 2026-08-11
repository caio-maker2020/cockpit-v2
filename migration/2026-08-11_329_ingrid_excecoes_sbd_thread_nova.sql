-- ============================================================================
-- 2026-08-11_329 — EXCEÇÕES DO ONBOARDING INGRID (Black & Decker + Dim/Nortel).
--
-- Plano aprovado 11/08. Três blocos independentes e idempotentes:
--   1. SBD na exceção da oc 13 (espelho O.V.D. — config pura, zero código)
--   2. Romaneio interno com ESCOPO e CHAVE DE BUSCA por cliente:
--        PRATI  → escopo 'sempre'   + chave 'nf'                (default, intacta)
--        SBD    → escopo 'so_parcial' + chave 'numero_remessa_danfe'
--      (parcial NÃO pode pedir romaneio ao cliente; total segue padrão 59+email)
--   3. Resposta em THREAD NOVA (Dimensional/Nortel via b2c): coluna de marcação
--      em contatos_cliente + flag master (nasce OFF; contatos marcados vêm da
--      planilha padrão na fase de seed)
--
-- NÃO ativa a Ingrid — ativação é migration própria, aplicada só no merge final.
-- ============================================================================

-- Bloco 1: SBD na exceção oc 13 ----------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO public.cliente_config_oc13 (cnpj_pagador, nome_cliente, ativo, observacao)
VALUES ('53296273003298', 'BLACK DECKER DO BRASIL LTDA', true,
        'Exceção oc=13 (Ingrid, 2026-08-11): card aparece no Cockpit e a operadora notifica o cliente antes de seguir — espelho O.V.D.')
ON CONFLICT (cnpj_pagador) DO UPDATE SET ativo = true, nome_cliente = EXCLUDED.nome_cliente;
COMMIT;

-- Bloco 2: escopo + chave de busca do romaneio interno ------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.cliente_config
  ADD COLUMN IF NOT EXISTS romaneio_escopo text NOT NULL DEFAULT 'sempre'
    CHECK (romaneio_escopo IN ('sempre', 'so_parcial')),
  ADD COLUMN IF NOT EXISTS romaneio_busca_chave text NOT NULL DEFAULT 'nf'
    CHECK (romaneio_busca_chave IN ('nf', 'numero_remessa_danfe'));

COMMENT ON COLUMN public.cliente_config.romaneio_escopo IS
  'sempre = trilho romaneio-interno em qualquer extravio (PRATI); so_parcial = só quando o card é extravio PARCIAL (SBD — no total pode pedir romaneio por e-mail, fluxo padrão). Caio 2026-08-11.';
COMMENT ON COLUMN public.cliente_config.romaneio_busca_chave IS
  'nf = busca na plataforma pela NF (PRATI); numero_remessa_danfe = resolve o Nº Remessa nos Dados Adicionais da NF-e (XML, tela 101>DANFEs) e busca por ele (SBD). Caio 2026-08-11.';

INSERT INTO public.cliente_config
  (cnpj_pagador, nome_cliente, usa_romaneio_interno, template_email_extravio_total,
   romaneio_escopo, romaneio_busca_chave, notes, ativo)
VALUES
  ('53296273003298', 'BLACK DECKER DO BRASIL LTDA', true, 'EXTRAVIO_TOTAL_NOTIFICACAO',
   'so_parcial', 'numero_remessa_danfe',
   'SBD/Ingrid 2026-08-11: extravio PARCIAL não pode pedir romaneio ao cliente — buscar na plataforma interna pelo Nº Remessa (Dados Adicionais da NF-e). Extravio TOTAL segue padrão (59 + e-mail pedindo romaneio). E-mail informativo do parcial sai igual PRATI (confirmado Caio).',
   true)
ON CONFLICT (cnpj_pagador) DO UPDATE SET
  usa_romaneio_interno = EXCLUDED.usa_romaneio_interno,
  template_email_extravio_total = EXCLUDED.template_email_extravio_total,
  romaneio_escopo = EXCLUDED.romaneio_escopo,
  romaneio_busca_chave = EXCLUDED.romaneio_busca_chave,
  notes = EXCLUDED.notes,
  ativo = true;

-- Guarda: PRATI intocada (escopo/chave nos defaults)
DO $g$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.cliente_config
    WHERE cnpj_pagador = '73856593001057'
      AND (romaneio_escopo <> 'sempre' OR romaneio_busca_chave <> 'nf')
  ) THEN
    RAISE EXCEPTION 'GUARDA: PRATI saiu dos defaults — zero regressão violada';
  END IF;
END $g$;
COMMIT;

-- Bloco 3: resposta em thread nova (Dimensional/Nortel) -----------------------
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.contatos_cliente
  ADD COLUMN IF NOT EXISTS responde_em_thread_nova boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.contatos_cliente.responde_em_thread_nova IS
  'Sistema do cliente responde SEMPRE em e-mail novo (sem In-Reply-To/thread) — ex.: b2c.srv.br do Dimensional/Nortel. O gmail-poll admite e-mail não-casado desses remetentes no pipeline (triador extrai NF do corpo → vinculador acha o card ativo). Caio 2026-08-11.';

INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('resposta_thread_nova_enabled', false,
        'Ingrid/Dim-Nortel: admite no pipeline e-mail não-casado de contato marcado responde_em_thread_nova (NF extraída do corpo). OFF = comportamento atual (descarte).')
ON CONFLICT (key) DO NOTHING;
COMMIT;
