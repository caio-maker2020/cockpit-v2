-- =============================================================================
-- 2026-10-08_414_oc13_via_rural_ja_visibilidade.sql
-- VIA RURAL (3 CNPJs) e J.A AGRO UBE entram na oc 13: VISIBILIDADE, sem robô
-- =============================================================================
-- Chamado CH-20261008-OBY6 (08/10, carteira AGRO/VET): os clientes VIA RURAL e
-- JA "não autorizam emitir reentregas automáticas sem antes a operadora
-- notificar eles via e-mail e solicitar como proceder". Pedido: toda oc 13
-- desses clientes cair no Cockpit da operadora responsável, com a opção de
-- notificar o cliente + oc 54 sugerida.
--
-- ## AUTORIZAÇÃO
--
-- Carlos, 08/10, literal no chat, em resposta ao relatório da investigação (que
-- propôs exatamente isto e perguntou (1) se o 3º CNPJ do grupo VIA RURAL entra
-- e (2) se a 54 deveria ganhar destaque): "1. Autorizado inserir; 2. Deixe
-- como está. Abra a branch; Commit o progresso; Nao merge sem minha
-- autorização." → os 4 CNPJs entram; a ordem das opções do card NÃO muda.
-- APLICAÇÃO em produção só depois do merge autorizado.
-- Autonomia: docs/POLITICA_MIGRATIONS.md, TIPO B, revisão 02/09 = "o Caio ou o
-- Carlos" autorizam, com a autorização DECLARADA aqui, no --autorizado-por e
-- no commit.
--
-- ## O QUE FOI MEDIDO (08/10, master 15d0b1c — não é suposição)
--
--   • Os 4 CNPJs NÃO estão em cliente_config_oc13 → a oc 13 deles não passa
--     nem pela 1ª consulta do fetchPendenciasDoCockpit (oc 13 é Operação no
--     dicionário, ADR 0004) nem pela 2ª (oc 13 só dos CNPJs da exceção). Card
--     só nascia se o cliente escrevesse.
--   • Caso âncora: NF 118031 / CTRC ACW640889-3 (VIA RURAL 10406295000235) —
--     extravio que virou oc 13 em 25/09; a reconciliação dos extravios o mandou
--     para TRANSFERIDO (ExtravioReconciliadoViaBastao, oc_bastao 13) e ele
--     nunca chegou à fila da operadora. Em 08/10 o Bastão já não lista essa NF.
--   • Carteira: os 4 CNPJs são da mesma operadora (contatos_cliente) e 100%
--     dos cards deles dos últimos 30 dias foram para ela (219 de 219). Os 4 têm
--     e-mail cadastrado → a 54 + e-mail tem destino.
--   • A operadora NÃO está em acoes_autonomas_veto_operadores → nenhuma ação
--     sai sozinha pela janela de veto de 60 min nos cards dela.
--
-- ## REGRA DO NEGÓCIO (a mesma da PRATI, mig 387, ADR 0026, INV-148)
--
--   ativo = true           → o card APARECE na fila da operadora;
--   autonomo_ativo = false → o agente-oc13-autonomo NÃO age (sem oc 21 nem
--                            cancelamento de reentrega sem o cliente
--                            autorizar). É também o DEFAULT da coluna (mig
--                            386); fica explícito aqui de propósito.
--
-- Com o robô desligado o card nasce em AGUARDANDO_VALIDACAO_HUMANA com as 5
-- opções de sempre da exceção (regras-auto-acao.ts, REGRAS_AUTO_ACAO[13]):
-- 21 reentrega, 54 + e-mail LIMITACAO_CLIENTE ("como deseja prosseguir: nova
-- tentativa, agendamento ou outra instrução?"), 56, 41 e o gêmeo "54 sem
-- e-mail". Nada é lançado sem a operadora aprovar. Ordem das opções inalterada
-- (decisão do Carlos 08/10: "deixe como está").
--
-- O 3º CNPJ (10406295000669, VIARURAL COMERCIO DE PRODUTOS) entra porque a
-- regra é do CLIENTE, não do estabelecimento (precedente: os 2 da PRATI). Hoje
-- não tem nenhum card; se um dia embarcar, já cai na mesma regra.
--
-- ## BLAST RADIUS (medido 08/10)
--
--   • Bastão: 0 pendências abertas com oc 13 para os 4 CNPJs → aplicar NÃO
--     cria card nenhum de imediato. Só as próximas oc 13 viram card (sync a
--     cada 30 min, cron 27).
--   • Cards existentes: o único com oc 13 é a NF 118031 (TRANSFERIDO). Nada o
--     move: o Pass A só trata pendência presente no Bastão; o Pass B pula
--     TRANSFERIDO; os 3 self-heals (órfãos da PARA FAZER, AVH presos,
--     AGUARDANDO_CLIENTE do INV-019) não selecionam esse estado/oc; o Pass D só
--     mexe no aviso de oc alterada. Efeito único: a NF sai da view
--     v_oc13_paradas (que exclui CNPJ da exceção desde a mig 136) — nenhuma
--     edge nem o front leem essa view.
--   • Extravio que vire oc 13: a reconciliação dos extravios continua mandando
--     para TRANSFERIDO (ela não lê esta tabela) e o sync-bastao REABRE no ciclo
--     seguinte (candidatoReabertura usa isOcorrenciaDeRelacionamentoCtx com a
--     exceção). Os dois não disputam: a reconciliação só lê
--     EXTRAVIO_MONITORADO. Até hoje 257 extravios viraram oc 13, nenhum de
--     cliente da exceção (caminho pelo código, ainda sem caso real).
--   • Leitores de cliente_config_oc13 auditados: sync-bastao (+ bastao-client),
--     agente-oc13-autonomo (lê autonomo_ativo → ignora estes 4),
--     regras-auto-acao, criar-card-manual (espelho do sync), backfill-propostas-oc
--     (manual, sem cron), view v_oc13_paradas. Trigger da tabela: só
--     cliente_config_oc13_set_updated_at. Outras regras desses clientes
--     (extravio no 2º dia, mig 412 / INV-170) moram em cliente_config — não
--     mudam.
--
-- ## TIPO E EXECUÇÃO
--
-- TIPO B (INSERT em tabela que muda o que o sync-bastao puxa). O classificador
-- do dbq.py pode marcar A (seed de cliente_config*, ver ADR 0026) — passar
-- --autorizado-por mesmo assim. Sem BEGIN/COMMIT interno (política 13/08).
-- ON CONFLICT DO NOTHING: se alguém tiver cadastrado um destes CNPJs antes da
-- aplicação, a linha dele NÃO é sobrescrita — a GUARDA abaixo reprova e pede
-- olho humano. Qualquer estado parcial é seguro (toda linha inserida nasce
-- visível e com o robô desligado).
--
-- Guard permanente: INV-173 (verify-cockpit, check de banco: todo CNPJ de
-- cliente que exige autorização na oc 13 — PRATI, VIA RURAL, JA — com
-- ativo=true e autonomo_ativo=false).
--
-- skill supabase-postgres-best-practices: não instalada nesta máquina; regras
-- aplicadas à mão — idempotente (ON CONFLICT), CNPJ com 14 dígitos (CHECK
-- cliente_config_oc13_cnpj_digits), PK existente, schema-qualified, sem DDL,
-- RLS intocada.
--
-- Reversão (tira da fila de novo; robô já está desligado):
--   DELETE FROM public.cliente_config_oc13
--    WHERE cnpj_pagador IN ('10406295000235','10406295000154','10406295000669','29997296000572');
--   (ou UPDATE ... SET ativo = false, que preserva o registro)
-- =============================================================================

INSERT INTO public.cliente_config_oc13 (cnpj_pagador, nome_cliente, ativo, autonomo_ativo, observacao)
VALUES
  ('10406295000235', 'VIA RURAL COM DE PROD AGRO LTD', true, false,
   'Mig 414 (Carlos 08/10, CH-20261008-OBY6): cliente nao autoriza reentrega sem ser notificado antes. oc 13 aparece pra operadora da carteira; robo DESLIGADO de proposito. Caso ancora NF 118031 / CTRC ACW640889-3.'),
  ('10406295000154', 'VIA RURAL COMERCIO DE PRODUTOS AGROPECUARIOS LTDA', true, false,
   'Mig 414 (Carlos 08/10, CH-20261008-OBY6): mesmo grupo VIA RURAL — a regra e do cliente. oc 13 aparece pra operadora da carteira; robo DESLIGADO de proposito.'),
  ('10406295000669', 'VIARURAL COMERCIO DE PRODUTOS', true, false,
   'Mig 414 (Carlos 08/10, CH-20261008-OBY6): 3o CNPJ do grupo VIA RURAL (sem card em 08/10) — a regra e do cliente. Robo DESLIGADO de proposito.'),
  ('29997296000572', 'J.A AGRO UBE', true, false,
   'Mig 414 (Carlos 08/10, CH-20261008-OBY6): cliente nao autoriza reentrega sem ser notificado antes. oc 13 aparece pra operadora da carteira; robo DESLIGADO de proposito.')
ON CONFLICT (cnpj_pagador) DO NOTHING;

-- Guarda: os 4 CNPJs têm de sair daqui visíveis e com o robô desligado.
DO $g$
DECLARE
  v_fora int;
BEGIN
  SELECT count(*) INTO v_fora
    FROM unnest(ARRAY['10406295000235','10406295000154','10406295000669','29997296000572']) e(cnpj)
    LEFT JOIN public.cliente_config_oc13 c ON c.cnpj_pagador = e.cnpj
   WHERE c.cnpj_pagador IS NULL
      OR c.ativo IS NOT TRUE
      OR c.autonomo_ativo IS NOT FALSE;
  IF v_fora > 0 THEN
    RAISE EXCEPTION 'GUARDA mig 414: % CNPJ(s) de VIA RURAL/JA fora da regra (precisa ativo=true e autonomo_ativo=false) — havia linha anterior? conferir antes de seguir', v_fora;
  END IF;
END
$g$;

-- Conferência esperada: 21 linhas; 15 com robô ligado; 6 sem robô (PRATI 2 +
-- VIA RURAL 3 + JA 1).
--   select nome_cliente, cnpj_pagador, ativo, autonomo_ativo
--     from public.cliente_config_oc13 order by autonomo_ativo, nome_cliente, cnpj_pagador;
