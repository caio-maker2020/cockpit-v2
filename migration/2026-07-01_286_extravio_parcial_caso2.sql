-- =============================================================================
-- Extravio parcial FASE 2 (Caso 2) — flag própria + template descrição/valor
--
-- Caio 2026-07-01 (NF 66193). NÃO aplicar sem nova auditoria Codex (emenda 6).
--
--   - extravio_parcial_caso2_enabled (OFF): liga o comportamento do Caso 2 —
--     (a) o agente-ressarcimento sugere "54 + e-mail pedindo descrição/valor"
--     (sub-caso Tier B-DV, manual, nunca autônomo) e (b) o executor MATERIALIZA a
--     2ª oc 33 de completude (texto do dossiê + romaneio reaproveitado + imagem se
--     estourar). Shadow: com a flag OFF nada disso roda.
--   - Template EXTRAVIO_PARCIAL_PEDIR_DESCRICAO_VALOR: e-mail que pede SÓ a
--     descrição dos itens e o valor (o romaneio já foi recebido na 1ª rodada).
--
-- Idempotente (ON CONFLICT). Sem coluna nova (dossiê vive em agent_state jsonb).
-- =============================================================================

INSERT INTO public.feature_flags (key, description, enabled) VALUES
  ('extravio_parcial_caso2_enabled',
   'Extravio parcial Caso 2 (NF 66193): liga o sub-caso Tier B-DV do agente-'
   'ressarcimento (sugere 54+e-mail pedindo descrição/valor, manual) + a '
   'materialização da 2ª oc 33 de completude no executor. OFF = shadow.',
   false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'EXTRAVIO_PARCIAL_PEDIR_DESCRICAO_VALOR',
  'Extravio parcial — pedir descrição e valor dos itens',
  'Caio 2026-07-01 (Fase 2, NF 66193): Caso 2 reaberto pós-devolução. Já temos o '
  'romaneio de coleta assinado; o Ressarcimento pediu (oc 49) a descrição dos itens '
  'e o valor a indenizar. Este e-mail pede SÓ essas 2 informações — NÃO pede o '
  'romaneio de novo. Rascunho para o Caio revisar.',
  'Extravio parcial — descrição e valor dos itens — NF {nf}',
  E'Olá {primeiro_nome},\n\n'
  || E'Sobre a NF {nf}: já recebemos o romaneio de coleta assinado, obrigado.\n\n'
  || E'Para darmos andamento ao processo de indenização dos itens extraviados, '
  || E'precisamos de duas informações dos itens faltantes:\n\n'
  || E'  1) Descrição dos itens (produto e quantidade)\n'
  || E'  2) Valor dos itens a serem ressarcidos\n\n'
  || E'Exemplo do formato que facilita:\n'
  || E'  item 1 - paracetamol: 30 unidades, R$ 300,00\n'
  || E'  item 2 - dipirona: 20 unidades, R$ 200,00\n\n'
  || E'Assim que recebermos a descrição e o valor, concluímos o processo junto ao '
  || E'time de Ressarcimento.\n\n'
  || E'Obrigado,\n{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome','nf','operadora_nome'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = true;
