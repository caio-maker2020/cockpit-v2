-- =============================================================================
-- 2026-10-06_412_extravio_2_dias_avante_viarural_soma_medika.sql
--
-- Carlos 06/10 (chamado CH-20261006-JFV8): AVANTE SAUDE ANIMAL, VIA RURAL, SOMA
-- MG PROD HOSPIT e MEDIKA/HTS ganham a MESMA exceção de prazo de extravio da
-- PRATI (mig 313) e da ATLAS (mig 409): o agente-extravio-d4 lança a oc 49
-- ("prazo de perdas expirado", sem e-mail) após 2 DIAS ÚTEIS sem ocorrência
-- posterior ao extravio (6/9/16), em vez dos 4 do padrão.
--
-- (1) OS 4 CLIENTES NOVOS — SÓ O PRAZO (decisão do Carlos 06/10): as linhas
-- nascem nos defaults — usa_romaneio_interno=false, intranet_wurth=false,
-- romaneio_busca_chave='nf', template_email_extravio_total=null — então
-- romaneio interno, intranet Würth e busca por remessa continuam DESLIGADOS
-- para eles. Se a linha já existir, só o prazo muda.
--
-- (2) O 2º CNPJ DA PRATI (73856593000166) — A MESMA REGRA DA PRATI (decisão do
-- Carlos 06/10: "deve entrar na mesma regra atual da PRATI"): a linha COPIA a
-- configuração do 73856593001057 (romaneio interno pela plataforma da Sal com o
-- template EXTRAVIO_TOTAL_NOTIFICACAO, escopo 'sempre', busca por 'nf', prazo
-- de 2 dias, intranet desligada), no mesmo molde da Würth (4 CNPJs) e da Black
-- & Decker (2 CNPJs), que já têm a linha repetida por CNPJ. As demais regras da
-- PRATI já valiam para os dois CNPJs: oc 13 (cliente_config_oc13, mig 387),
-- segregação (cliente_config_segregacao_ctrc, mig 408) e carteira (os dois na
-- carteira da mesma operadora). Zero cards com este CNPJ como pagador em 06/10:
-- nenhum efeito imediato; um card que apareça já recebe o tratamento da PRATI.
-- A busca no portal de romaneio é pela NF (romaneio-interno-client.ts), não
-- pelo CNPJ.
--
-- (3) ESCALONAMENTO DO RESSARCIMENTO (Carlos 06/10: "pode incluir"): toda lista
-- de contatos_escalonamento que cobre o 73856593001057 passa a cobrir também o
-- 73856593000166 (hoje: 1 analista do time_ressarcimento, lista de 426 CNPJs).
-- Único leitor automático: cobrar-ressarcimento-wpp, acionado por BOTÃO da
-- operadora (sem cron) — sem a inclusão, o botão num card deste CNPJ daria
-- erro ("nenhum analista cobre o CNPJ"; não há contato global cadastrado).
--
-- Segregação de CT-e (migs 407/408) é chaveada por lista própria: nenhum dos 4
-- clientes novos entra.
--
-- Leitores de cliente_config auditados em 06/10 (código + funções/views do
-- banco): agente-extravio-d4 (prazo), agente-sugere-ocs-padrao/cce-wurth/robo-
-- intranet-wurth/card_eh_intranet_wurth (intranet_wurth = true), executor
-- (romaneio_busca_chave = 'numero_remessa_danfe'), interpretador/regras-auto-
-- acao (usa_romaneio_interno = true [+ template]). Para os 4 novos, com os
-- defaults, todos dão o mesmo resultado de "cliente sem linha"; para o 2º CNPJ
-- da PRATI, o mesmo resultado do 1º. cliente_pode_segregar_ctrc e
-- v_oc13_paradas leem tabelas próprias. Sem trigger em cliente_config. O
-- agente lê o prazo SEM filtrar `ativo`.
--
-- Régua: cliente > operadora > default (dias-autonomo-extravio.ts). As
-- operadoras desses clientes seguem em 4 para os demais clientes delas. CHECK
-- 2..30 respeitado (2 = piso). Guard: INV-170 (verify-cockpit, check de banco:
-- lista do 2º dia + os 2 CNPJs da PRATI com as mesmas regras em cliente_config,
-- oc 13, segregação e escalonamento).
--
-- skill supabase-postgres-best-practices: aplicada manualmente (pacote não
-- instalado nesta máquina) — idempotente, sem DDL, sem RLS nova, PK existente.
--
-- TIPO B (dado de produção). Quatro statements, cada um atômico e idempotente
-- (o dbq roda um por transação; rodar de novo dá o mesmo resultado). Sem
-- BEGIN/COMMIT (padrão do projeto). Não toca cron/trigger/função (o trigger
-- contatos_escal_set_updated_at só carimba updated_at). O DO final é guarda:
-- reprova a aplicação se o 2º CNPJ da PRATI não ficou com as mesmas regras do 1º.
-- Rollback:
--   (1) volta os 4 clientes ao padrão de 4 dias úteis:
--   UPDATE public.cliente_config SET dias_autonomo_extravio = NULL, updated_at = now()
--    WHERE cnpj_pagador IN ('07932725000167','07932725000248','10406295000154',
--                           '10406295000235','12927876000167','66437831000133');
--   (2) tira o 2º CNPJ da PRATI da configuração (volta a "cliente sem linha"):
--   DELETE FROM public.cliente_config WHERE cnpj_pagador = '73856593000166';
--   (3) tira o 2º CNPJ da PRATI das listas de escalonamento:
--   UPDATE public.contatos_escalonamento
--      SET cnpjs_pagador = array_remove(cnpjs_pagador, '73856593000166')
--    WHERE '73856593000166' = ANY (cnpjs_pagador);
-- =============================================================================

-- (1) Os 4 clientes novos: só o prazo de 2 dias úteis.
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
   'Mig 412 (Carlos 06/10, CH-20261006-JFV8): extravio → 49 em 2 dias úteis, igual PRATI/ATLAS. Só o prazo: sem romaneio interno, sem intranet, sem segregação.')
ON CONFLICT (cnpj_pagador) DO UPDATE
  SET dias_autonomo_extravio = EXCLUDED.dias_autonomo_extravio,
      updated_at = now();

-- (2) O 2º CNPJ da PRATI: cópia da configuração do 1º (a mesma regra da PRATI).
INSERT INTO public.cliente_config (
  cnpj_pagador, nome_cliente, usa_romaneio_interno, template_email_extravio_total,
  notes, ativo, dias_autonomo_extravio, romaneio_escopo, romaneio_busca_chave, intranet_wurth)
SELECT '73856593000166', p.nome_cliente, p.usa_romaneio_interno, p.template_email_extravio_total,
       'Mig 412 (Carlos 06/10, CH-20261006-JFV8): 2º CNPJ da PRATI na MESMA regra da PRATI — cópia da configuração do 73856593001057 (romaneio interno, prazo de 2 dias úteis). ' || coalesce(p.notes, ''),
       p.ativo, p.dias_autonomo_extravio, p.romaneio_escopo, p.romaneio_busca_chave, p.intranet_wurth
  FROM public.cliente_config p
 WHERE p.cnpj_pagador = '73856593001057'
ON CONFLICT (cnpj_pagador) DO UPDATE
  SET nome_cliente                  = EXCLUDED.nome_cliente,
      usa_romaneio_interno          = EXCLUDED.usa_romaneio_interno,
      template_email_extravio_total = EXCLUDED.template_email_extravio_total,
      notes                         = EXCLUDED.notes,
      ativo                         = EXCLUDED.ativo,
      dias_autonomo_extravio        = EXCLUDED.dias_autonomo_extravio,
      romaneio_escopo               = EXCLUDED.romaneio_escopo,
      romaneio_busca_chave          = EXCLUDED.romaneio_busca_chave,
      intranet_wurth                = EXCLUDED.intranet_wurth,
      updated_at                    = now();

-- (3) Escalonamento do Ressarcimento: quem cobre o 1º CNPJ cobre o 2º.
UPDATE public.contatos_escalonamento
   SET cnpjs_pagador = array_append(cnpjs_pagador, '73856593000166')
 WHERE '73856593001057' = ANY (cnpjs_pagador)
   AND NOT ('73856593000166' = ANY (cnpjs_pagador));

-- (4) Guarda: os dois CNPJs da PRATI têm de sair daqui com a MESMA regra.
DO $g$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.cliente_config a
      JOIN public.cliente_config b ON b.cnpj_pagador = '73856593000166'
     WHERE a.cnpj_pagador = '73856593001057'
       AND (a.usa_romaneio_interno, a.template_email_extravio_total, a.ativo,
            a.dias_autonomo_extravio, a.romaneio_escopo, a.romaneio_busca_chave, a.intranet_wurth)
           IS NOT DISTINCT FROM
           (b.usa_romaneio_interno, b.template_email_extravio_total, b.ativo,
            b.dias_autonomo_extravio, b.romaneio_escopo, b.romaneio_busca_chave, b.intranet_wurth)
  ) THEN
    RAISE EXCEPTION 'GUARDA mig 412: o 2º CNPJ da PRATI não ficou com a mesma regra do 1º (cliente_config)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.contatos_escalonamento
     WHERE coalesce('73856593001057' = ANY (cnpjs_pagador), false)
        <> coalesce('73856593000166' = ANY (cnpjs_pagador), false)
  ) THEN
    RAISE EXCEPTION 'GUARDA mig 412: lista de escalonamento com só um dos CNPJs da PRATI';
  END IF;
END
$g$;
