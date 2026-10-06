-- =============================================================================
-- 2026-10-06_412_extravio_2_dias_avante_viarural_soma_medika.sql
--
-- Carlos 06/10 (chamado CH-20261006-JFV8): AVANTE SAUDE ANIMAL, VIA RURAL, SOMA
-- MG PROD HOSPIT e MEDIKA/HTS ganham a MESMA exceção de prazo de extravio da
-- PRATI (mig 313) e da ATLAS (mig 409): o agente-extravio-d4 lança a oc 49
-- ("prazo de perdas expirado", sem e-mail) após 2 DIAS ÚTEIS sem ocorrência
-- posterior ao extravio (6/9/16), em vez dos 4 do padrão. Entra também o 2º
-- CNPJ da PRATI (73856593000166), que nunca tinha sido cadastrado (decisão do
-- Carlos: coerência; zero cards com ele como pagador em 06/10).
--
-- SÓ O PRAZO (decisão do Carlos 06/10): as linhas nascem nos defaults —
-- usa_romaneio_interno=false, intranet_wurth=false, romaneio_busca_chave='nf',
-- template_email_extravio_total=null — então romaneio interno, intranet Würth e
-- busca por remessa continuam DESLIGADOS para esses CNPJs (inclusive o 2º da
-- PRATI). Segregação de CT-e (migs 407/408) é chaveada por lista própria
-- (cliente_config_segregacao_ctrc): ninguém daqui entra.
--
-- Leitores de cliente_config auditados em 06/10 (código + funções/views do
-- banco): agente-extravio-d4 (prazo — o único que muda), agente-sugere-ocs-
-- padrao/cce-wurth/robo-intranet-wurth/card_eh_intranet_wurth (intranet_wurth
-- = true), executor (romaneio_busca_chave = 'numero_remessa_danfe'),
-- interpretador/regras-auto-acao (usa_romaneio_interno = true [+ template]).
-- Com os defaults, todos dão o mesmo resultado de "cliente sem linha".
-- cliente_pode_segregar_ctrc e v_oc13_paradas leem tabelas próprias. Sem
-- trigger em cliente_config. O agente lê o prazo SEM filtrar `ativo`.
--
-- Régua: cliente > operadora > default (dias-autonomo-extravio.ts). As
-- operadoras desses clientes seguem em 4 para os demais clientes delas. CHECK
-- 2..30 respeitado (2 = piso). Guard: INV-170 (verify-cockpit, check de banco).
--
-- skill supabase-postgres-best-practices: aplicada manualmente (pacote não
-- instalado nesta máquina) — idempotente, sem DDL, sem RLS nova, PK existente.
--
-- TIPO B (dado de produção). Idempotente: ON CONFLICT só ajusta o prazo se a
-- linha já existir (nome/notas/demais campos ficam como estão). Sem
-- BEGIN/COMMIT (padrão do projeto; statement único é atômico). Não toca
-- cron/trigger/função.
-- Rollback (volta todos ao padrão de 4 dias úteis):
--   UPDATE public.cliente_config SET dias_autonomo_extravio = NULL, updated_at = now()
--    WHERE cnpj_pagador IN ('07932725000167','07932725000248','10406295000154',
--                           '10406295000235','12927876000167','66437831000133',
--                           '73856593000166');
-- =============================================================================

INSERT INTO public.cliente_config (cnpj_pagador, nome_cliente, dias_autonomo_extravio, notes)
VALUES
  ('07932725000167', 'AVANTE SAUDE ANIMAL LTDA', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.'),
  ('07932725000248', 'AVANTE SAUDE ANIMAL LTDA', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.'),
  ('10406295000154', 'VIA RURAL COMERCIO DE PRODUTOS AGROPECUARIOS LTDA', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.'),
  ('10406295000235', 'VIA RURAL COMERCIO DE PRODUTOS AGROPECUARIOS LTDA', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.'),
  ('12927876000167', 'SOMA MG PROD HOSPIT LTDA', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.'),
  ('66437831000133', 'HTS TEC SAUDE COM IMP EXP LTDA (MEDIKA)', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.'),
  ('73856593000166', 'PRATI', 2,
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): 2º CNPJ da PRATI, só o prazo de 2 dias úteis (coerência com o 73856593001057 da mig 313). Romaneio interno NÃO ligado aqui.')
ON CONFLICT (cnpj_pagador) DO UPDATE
  SET dias_autonomo_extravio = EXCLUDED.dias_autonomo_extravio,
      updated_at = now();
