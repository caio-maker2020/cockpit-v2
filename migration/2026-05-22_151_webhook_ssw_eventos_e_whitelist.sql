-- =============================================================================
-- Webhook SSW2181 — infraestrutura de teste pequeno
--
-- Caio 2026-05-22: SSW Sistemas vai começar a enviar eventos via webservice
-- "SSW2181 - WebService Envio Ocorrências Padrão" (https://ssw.inf.br/ajuda/
-- webserviceOcorrencias.html). Sal Express vai solicitar ativação informando
-- URL do nosso receptor.
--
-- Estratégia faseada:
--   1. (HOJE) Edge `webhook-ssw-ocorrencias` recebe POST + responde 200 OK.
--      Loga TUDO em webhook_ssw_eventos pra auditoria.
--      Cria card SÓ pras NFs em webhook_ssw_test_nfs (whitelist).
--   2. (DEPOIS) Após validar com NFs específicas, expandir whitelist OU
--      remover filtro pra aceitar tudo.
--   3. (FUTURO) Desativar cron sync-bastao (webhook vira fonte primária).
--
-- 2 tabelas + RLS service-only (sem UI por enquanto, gerenciado via SQL).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Log de TODO evento recebido (auditável, mesmo NFs fora da whitelist)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_ssw_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocolo text NOT NULL UNIQUE,          -- gerado por nós, devolvido pro SSW
  cnpj_transportadora text NOT NULL,
  cnpj_pagador text,
  nf text,                                 -- nf.numeroNFe stringificado
  ctrc text,                               -- cte.serieDocumento + cte.numeroDocumento
  codigo_ocorrencia integer,
  descricao_ocorrencia text,
  data_hora_evento timestamptz,
  data_hora_envio timestamptz,             -- quando SSW disparou o POST
  recebido_em timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb NOT NULL,
  -- Resultado do processamento
  processado boolean NOT NULL DEFAULT false,
  na_whitelist boolean NOT NULL DEFAULT false,
  card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  card_acao text,                          -- 'criado' | 'atualizado' | 'ignorado_whitelist' | 'duplicado_protocolo' | 'erro'
  erro text,
  processado_em timestamptz
);

CREATE INDEX IF NOT EXISTS idx_webhook_ssw_eventos_recebido_em
  ON public.webhook_ssw_eventos(recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_ssw_eventos_nf
  ON public.webhook_ssw_eventos(nf, recebido_em DESC) WHERE nf IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_ssw_eventos_pendentes
  ON public.webhook_ssw_eventos(recebido_em DESC) WHERE NOT processado;

ALTER TABLE public.webhook_ssw_eventos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_ssw_eventos_service_only ON public.webhook_ssw_eventos;
CREATE POLICY webhook_ssw_eventos_service_only
  ON public.webhook_ssw_eventos
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.webhook_ssw_eventos IS
  'Log de todo POST recebido do SSW2181 (webservice ocorrências). Caio 2026-05-22: '
  'permite auditoria total mesmo de NFs fora da whitelist. protocolo UNIQUE evita '
  'duplicação (SSW pode reenviar em timeout).';

-- ----------------------------------------------------------------------------
-- 2. Whitelist de NFs que viram card (fase de teste)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_ssw_test_nfs (
  nf text PRIMARY KEY,
  motivo text,
  adicionado_por text,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_ssw_test_nfs_ativo
  ON public.webhook_ssw_test_nfs(ativo) WHERE ativo;

ALTER TABLE public.webhook_ssw_test_nfs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_ssw_test_nfs_service_only ON public.webhook_ssw_test_nfs;
CREATE POLICY webhook_ssw_test_nfs_service_only
  ON public.webhook_ssw_test_nfs
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.webhook_ssw_test_nfs IS
  'Whitelist de NFs que devem virar card via webhook SSW2181. Vazia ou ativo=false '
  '→ webhook só loga em webhook_ssw_eventos, sem criar card. Caio 2026-05-22: '
  'fase de teste pequeno antes de escalar pra todas NFs.';
