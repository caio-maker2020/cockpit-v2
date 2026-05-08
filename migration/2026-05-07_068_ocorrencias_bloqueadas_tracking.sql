-- ============================================================================
-- Cockpit v2 — Ocorrências bloqueadas no tracking (face do cliente)
-- Data: 2026-05-07
--
-- Bug NF 573123 (Caio 2026-05-07): Bastão dizia oc=49, SSW Tracking
-- (`/api/trackingpag`) dizia oc=10, regra antiga "tracking ganha porque é
-- mais real-time" mantinha card em oc=10 indefinidamente. Causa: o tracking
-- é a página que o cliente vê, e o SSW BLOQUEIA certas ocorrências (49,
-- 56, 44, 33, 41, etc) pra não exibir histórico interno pro cliente.
-- Quando Bastão tem oc bloqueada, tracking mostra a oc anterior visível.
--
-- Fix: tabela editável (sem deploy) com a lista oficial de ocs bloqueadas.
-- sync-bastao carrega 1× por run; quando Bastão diz oc bloqueada, ignora
-- tracking e segue o Bastão direto.
--
-- Lista canônica enviada por Caio 2026-05-07 (31 ocorrências).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ocorrencias_bloqueadas_tracking (
  codigo_ssw int PRIMARY KEY,
  descricao text NOT NULL,
  motivo text,
  ativo boolean NOT NULL DEFAULT true,
  added_by text DEFAULT 'caio',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ocorrencias_bloqueadas_tracking IS
  'Caio 2026-05-07: ocorrências do SSW que NÃO aparecem no rastreio do '
  'cliente (api/trackingpag). Quando Bastão tem oc dessa lista, sync-bastao '
  'pula crosscheck com tracking — o tracking sempre mostraria a oc anterior, '
  'gerando falsa "divergência" que travava cards (ex: NF 573123 ficou em '
  'oc=10 mesmo com Bastão+SSW oficiais já em oc=49).';

COMMENT ON COLUMN public.ocorrencias_bloqueadas_tracking.codigo_ssw IS
  'Código SSW da ocorrência. Exatamente como aparece nos lançamentos SSW.';

COMMENT ON COLUMN public.ocorrencias_bloqueadas_tracking.ativo IS
  'Toggle pra desativar uma oc da regra sem deletar (auditoria).';

-- ----------------------------------------------------------------------------
-- População inicial: 31 ocorrências bloqueadas (Caio 2026-05-07)
-- ----------------------------------------------------------------------------
INSERT INTO public.ocorrencias_bloqueadas_tracking (codigo_ssw, descricao, motivo) VALUES
  ( 3, 'Avaria na coleta',                                  'avaria interna — cliente não vê'),
  ( 6, 'Extravio na transferência',                         'extravio interno — cliente não vê'),
  ( 8, 'Avaria na transferência',                           'avaria interna — cliente não vê'),
  ( 9, 'Extravio na coleta',                                'extravio interno — cliente não vê'),
  (15, 'Entrega impossib: limit. base op. entreg',          'restrição operacional interna'),
  (16, 'Extravio na entrega',                               'extravio interno — cliente não vê'),
  (17, 'Avaria na entrega',                                 'avaria interna — cliente não vê'),
  (18, 'Carga sinistrada',                                  'sinistro interno'),
  (20, 'Extravio localizado',                               'fluxo interno de localização'),
  (26, 'Conjunto de comprovantes incompletos',              'documentação interna'),
  (27, 'Custo extra',                                       'financeiro interno'),
  (33, 'Reversão de perdas iniciada',                       'fluxo interno de Perdas'),
  (34, 'CTRC complementar',                                 'documentação interna'),
  (36, 'Chegada na base para entrega',                      'movimentação interna'),
  (37, 'Entrega impossibilitada por problema no veículo',   'problema operacional'),
  (38, 'Problemas na transferência',                        'operacional interno'),
  (39, 'Entrega impossib: problemas com janela',            'janela de entrega — interno'),
  (40, 'Redespacho final',                                  'roteamento interno'),
  (41, 'Informação complementar',                           'oc administrativa'),
  (42, 'Ressarcimento finalizado - indenização devida',     'fluxo Perdas/Ressarcimento'),
  (43, 'Manutenção perecível realizada',                    'oc operacional'),
  (44, 'Retorno de carga',                                  'fluxo Devolução interno'),
  (45, 'Carga cubada',                                      'cubagem operacional'),
  (46, 'Em análise de ressarcimento',                       'fluxo Perdas'),
  (47, 'Ressarcimento finalizado - indenização indevida',   'fluxo Perdas'),
  (48, 'Inviabilidade de custo na transferência',           'operacional/financeiro'),
  (49, 'Tratativa de relacionamento',                       'oc do Cockpit — interno'),
  (50, 'Manifestação indevida',                             'oc administrativa'),
  (53, 'Devolução liberada',                                'fluxo Devolução'),
  (56, 'Falta de informação operacional ou indevida',       'oc do Cockpit — encaminha Operação'),
  (57, 'Falta de informação operacional / ocorrência indevida', 'oc administrativa interna')
ON CONFLICT (codigo_ssw) DO UPDATE
  SET descricao = EXCLUDED.descricao,
      motivo = EXCLUDED.motivo,
      updated_at = now();

-- ----------------------------------------------------------------------------
-- Trigger pra manter updated_at automático
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ocs_bloqueadas_updated_at ON public.ocorrencias_bloqueadas_tracking;
CREATE TRIGGER trg_ocs_bloqueadas_updated_at
  BEFORE UPDATE ON public.ocorrencias_bloqueadas_tracking
  FOR EACH ROW EXECUTE FUNCTION public.trg_set_updated_at();

GRANT SELECT ON public.ocorrencias_bloqueadas_tracking TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.ocorrencias_bloqueadas_tracking TO service_role;

-- ----------------------------------------------------------------------------
-- View de auditoria contínua
-- Mostra os últimos 7 dias de divergências resolvidas pra Caio inspecionar
-- se há ocs ainda não cadastradas que deveriam estar.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_divergencias_bastao_tracking_recentes AS
SELECT
  ce.created_at,
  c.nf,
  c.empresa_cliente,
  (ce.payload->>'oc_bastao')::int        AS oc_bastao,
  (ce.payload->>'oc_tracking_real')::int AS oc_tracking,
  (ce.payload->>'oc_anterior_card')::int AS oc_anterior_card,
   ce.payload->>'regra_aplicada'         AS regra_aplicada,
  (ce.payload->>'bastao_oc_bloqueada')::boolean AS bastao_oc_bloqueada,
  c.state    AS state_card_atual,
  c.cod_ultima_ocorrencia AS oc_card_atual
FROM public.card_events ce
JOIN public.cards c ON c.id = ce.card_id
WHERE ce.event_type = 'DivergenciaBastaoVsTrackingResolvida'
  AND ce.created_at > now() - interval '7 days'
ORDER BY ce.created_at DESC;

COMMENT ON VIEW public.vw_divergencias_bastao_tracking_recentes IS
  'Caio 2026-05-07: auditoria das últimas divergências Bastão vs Tracking. '
  'Filtrar por regra_aplicada=tracking_real_time AND oc_bastao não-cadastrada '
  'pra encontrar ocs bloqueadas que ainda não estão na tabela.';

GRANT SELECT ON public.vw_divergencias_bastao_tracking_recentes TO authenticated, service_role;
