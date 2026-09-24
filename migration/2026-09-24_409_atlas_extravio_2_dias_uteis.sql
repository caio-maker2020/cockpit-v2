-- =============================================================================
-- 2026-09-24_409_atlas_extravio_2_dias_uteis.sql
--
-- Caio 24/09: ATLAS S.A. (CNPJ 89723837000849, carteira INGRID) ganha a MESMA
-- exceção de prazo de extravio da PRATI (mig 313): o agente-extravio-d4 lança
-- a oc 49 ("prazo de perdas expirado") após 2 DIAS ÚTEIS sem ocorrência
-- posterior ao extravio (6/9/16), em vez dos 4 do padrão — a Ingrid notifica
-- o cliente 2 dias antes. Régua: cliente > operadora > default (dias-autonomo-
-- extravio.ts). CHECK 2..30 respeitado (2 = piso).
--
-- Efeitos colaterais auditados (8 leitores de cliente_config): todos filtram
-- pelo próprio campo e a linha nasce nos defaults — usa_romaneio_interno=false,
-- intranet_wurth=false, template_email_extravio_total=null — logo só o robô do
-- extravio muda. Segregação de CT-e (migs 407/408) é chaveada por lista
-- própria: Atlas NÃO entra.
--
-- TIPO B (dado de produção). Idempotente: ON CONFLICT só ajusta o prazo se a
-- linha já existir. Sem BEGIN/COMMIT (padrão do projeto). Não toca cron/trigger.
-- Rollback: UPDATE public.cliente_config SET dias_autonomo_extravio = NULL
--           WHERE cnpj_pagador = '89723837000849';
-- =============================================================================

INSERT INTO public.cliente_config (cnpj_pagador, nome_cliente, dias_autonomo_extravio, notes)
VALUES (
  '89723837000849',
  'ATLAS S.A.',
  2,
  'Mig 409 (Caio 24/09): extravio → 49 em 2 dias úteis, igual PRATI. Sem romaneio interno, sem intranet, sem segregação.'
)
ON CONFLICT (cnpj_pagador) DO UPDATE
  SET dias_autonomo_extravio = EXCLUDED.dias_autonomo_extravio,
      updated_at = now();
