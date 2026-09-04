-- =============================================================================
-- 2026-09-04_384 — flag do SEED v2 do romaneio (NASCE DESLIGADA / sombra)
-- =============================================================================
-- Carlos/Caio 2026-09-04, âncora NF 145307 SOLUÇÃO PET.
--
-- Diagnóstico medido em produção: o detector determinístico do romaneio roda o
-- filtro anti-pedido (RE_ROMANEIO_PEDIDO) no corpo INTEIRO da resposta. Como o
-- cliente responde CITANDO o nosso e-mail, e os templates que pedem o romaneio
-- (ENTREGUE_COM_FALTA_PEDIR_ROMANEIO, EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO,
-- RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR) contêm literalmente "encaminhar o
-- romaneio" e "aguardo", o fluxo normal se AUTO-VETAVA:
--   - 381 de 424 mensagens com sinal de envio (89,9%) vetadas por texto NOSSO;
--   - 0 recuperações do seed em 1.831 rodadas que terminaram "faltando romaneio";
--   - 49 cards com descrição+valor OK, romaneio ausente e anexo do cliente na
--     mão (DUILIO 16, JULIA 13, FELIPE 12, KAROLINE 3, VICTOR 3, MARIA 1,
--     LARISSA 1).
--
-- O v2 (a) roda os sinais SÓ no texto que o cliente escreveu, (b) aceita o nome
-- do arquivo ("romaneio*") como sinal e (c) aceita "minuta" como SINÔNIMO de
-- romaneio no corpo. Contrafactual medido: 43 -> ~139 mensagens reconhecidas.
--
-- (c) é a âncora NF 632603 / DUILIO 01/09 16h02: o cliente escreveu "Segue
-- minuta e descritivo dos itens" e anexou o PDF; o detector só conhecia a
-- palavra "romaneio", o dossiê ficou faltando:["romaneio de coleta assinado"] e
-- as DUAS propostas de oc 33 nasceram com gate_oc33.bloqueada = true. Provado
-- executando detectarRomaneioNoHistorico contra o corpo REAL: nem (a) nem (c)
-- destravam sozinhas — (a) sem (c) não acha sinal positivo; (c) sem (a) é
-- vetada pelo anti-pedido lendo a NOSSA frase citada. Alcance de (c) nos 695
-- cards com dossiê incompleto: 75 mensagens usam "minuta" em padrão de envio e
-- nunca dizem "romaneio" (24 cards; 50 delas com PDF/imagem inbound real).
-- "minuta" vale como romaneio de coleta assinado: confirmado pelo Carlos
-- em 2026-09-04. O sinônimo NÃO entra no filename (não foi medido).
--
-- ESTA MIGRATION NÃO MUDA COMPORTAMENTO. A flag nasce FALSE: o interpretador
-- calcula v1 e v2, DECIDE pelo v1 e grava card_event `SeedRomaneioAvaliado`
-- quando os dois divergem. Só depois do baseline de sombra (>= 7 dias + amostra
-- conferida pelo operador) é que se liga com um UPDATE separado (TIPO B).
--
-- TIPO A (aditiva, reversível, nasce OFF). Idempotente. Sem BEGIN/COMMIT.
-- Rollback: DELETE FROM public.feature_flags WHERE key = 'seed_romaneio_v2_enabled';
-- =============================================================================

INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'seed_romaneio_v2_enabled',
  false,
  'Seed do romaneio v2: aplica os sinais de envio/pedido SÓ ao texto do cliente (ignora a citação do nosso próprio e-mail), aceita filename "romaneio*" e aceita "minuta" como sinônimo de romaneio no corpo. OFF = sombra (calcula e registra SeedRomaneioAvaliado, mas decide pelo v1). Âncoras NF 145307 e NF 632603.'
)
ON CONFLICT (key) DO NOTHING;
