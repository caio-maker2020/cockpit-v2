-- =============================================================================
-- 2026-06-19_221_fortpel_excecao_oc13
--
-- Caio 2026-06-19: adiciona FORTPEL COMERCIO DE DESCARTAVEIS LTDA
-- (CNPJ 20102722000164, operador VICTOR) à lista de exceção oc=13.
--
-- Efeito: a partir do próximo sync-bastao, pendências oc=13 (entrega
-- impossibilitada: limitação cliente) desse pagador passam a virar card de
-- relacionamento no Cockpit e disparam as 4 propostas da regra oc=13
-- (21 reentrega / 54+email FALTA_DE_VOLUME / 56 falta info / 41 info compl.) —
-- mesmo comportamento dos outros 12 CNPJs já cadastrados (mig 121).
--
-- Caso âncora: NF 424382 (CTRC ARP220418-5) está em oc=13 no Bastão ("HORARIO
-- DE ALMOCO", 18/06) e hoje não aparece pro Victor.
--
-- Idempotente: ON CONFLICT reativa se já existir.
-- =============================================================================

INSERT INTO public.cliente_config_oc13 (cnpj_pagador, nome_cliente, ativo, observacao)
VALUES (
  '20102722000164',
  'FORTPEL COMERCIO DE DESCARTAVEIS LTDA',
  true,
  'Exceção oc=13: obriga notificar cliente antes de seguir'
)
ON CONFLICT (cnpj_pagador) DO UPDATE
  SET ativo = true,
      nome_cliente = EXCLUDED.nome_cliente,
      observacao = EXCLUDED.observacao,
      updated_at = now();
