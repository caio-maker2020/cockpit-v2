-- Caio 2026-05-12 (PRATI): cliente_config indexada por cnpj_pagador.
-- Permite ativar "processo de romaneio interno" pra clientes específicos sem
-- hardcode. PRATI é o primeiro caso: extravios totais/parciais (ocs 49/10/35)
-- viram uma proposta nova "Email + Lançar oc=33" que busca romaneio em
-- plataforma interna em vez de pedir pro cliente.

CREATE TABLE IF NOT EXISTS public.cliente_config (
  cnpj_pagador text PRIMARY KEY,                       -- só dígitos, sem máscara
  nome_cliente text NOT NULL,
  usa_romaneio_interno boolean NOT NULL DEFAULT false,
  template_email_extravio_total text,                  -- FK conceitual pra templates_email.id
  notes text,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cliente_config IS
  'Configurações específicas por cliente (cnpj_pagador). Override de fluxos padrão.';
COMMENT ON COLUMN public.cliente_config.usa_romaneio_interno IS
  'Se true, ocs 49/10/35 ganham proposta "Email + Lançar oc=33 via romaneio interno". Sem cobrar romaneio do cliente.';
COMMENT ON COLUMN public.cliente_config.template_email_extravio_total IS
  'ID do template em templates_email a usar pro email de notificação de extravio total.';

-- Template do email de extravio total (formal notification — cliente é informado
-- que o processo de ressarcimento já está em curso via romaneio interno)
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'EXTRAVIO_TOTAL_NOTIFICACAO',
  'Notificação de Extravio Total (com romaneio interno)',
  'Notifica formalmente o cliente sobre extravio total da NF — processo de indenização já iniciado via romaneio interno.',
  'Aviso Importante: Extravio Total NF {nf}',
  E'Prezado(a) {primeiro_nome},\n\nIdentificamos extravio total da NF {nf} ({empresa}). Conforme nosso processo acordado em contrato, daremos andamento ao processo de ressarcimento via análise de perdas, com base no romaneio de coleta disponibilizado em nossos registros internos.\n\nQualquer informação adicional ou contato do time de Perdas será encaminhado em separado.\n\nAtenciosamente,\n{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'empresa', 'operadora_nome'],
  true
)
ON CONFLICT (id) DO NOTHING;

-- Seed PRATI (CNPJ 73.856.593/0010-57 — só dígitos)
INSERT INTO public.cliente_config (cnpj_pagador, nome_cliente, usa_romaneio_interno, template_email_extravio_total, notes)
VALUES (
  '73856593001057',
  'PRATI',
  true,
  'EXTRAVIO_TOTAL_NOTIFICACAO',
  'Cliente envia romaneio via plataforma interna (operação Sal Express escaneia diariamente). NÃO pedir romaneio por email.'
)
ON CONFLICT (cnpj_pagador) DO UPDATE SET
  nome_cliente = EXCLUDED.nome_cliente,
  usa_romaneio_interno = EXCLUDED.usa_romaneio_interno,
  template_email_extravio_total = EXCLUDED.template_email_extravio_total,
  notes = EXCLUDED.notes,
  updated_at = now();

-- RLS: leitura via service_role (edge functions); usuários comuns não precisam ler
ALTER TABLE public.cliente_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY cliente_config_service_role ON public.cliente_config
  USING (true) WITH CHECK (true);
