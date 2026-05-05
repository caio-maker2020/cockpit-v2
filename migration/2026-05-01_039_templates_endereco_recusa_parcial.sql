-- ============================================================================
-- Cockpit v2 — Templates ENDERECO_INCORRETO + RECUSA_PARCIAL (stubs inativos)
-- Data: 2026-05-01
--
-- Stubs criados pra suportar as regras novas:
--   oc=11 (problemas com endereço)  → lançar 54 + email ENDERECO_INCORRETO
--   oc=35 (entrega com recusa parcial) → lançar 54 + email RECUSA_PARCIAL
--
-- Templates ficam inativos (ativo=false) até Larissa preencher o texto
-- final em Templates-Email-Larissa.docx. Enquanto inativos, sync-bastao
-- cria proposta em "modo sem_email" (só lançamento da oc, sem email).
-- ============================================================================

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'ENDERECO_INCORRETO',
  'Problema com endereço — solicitar confirmação',
  'Quando entrega não foi possível por problemas com endereço (incompleto, divergente, cliente não localizado). Cliente precisa confirmar endereço correto pra reentrega.',
  '[Sal Express] NF {nf} — confirmar endereço de entrega',
  E'Olá {primeiro_nome},\n\n' ||
  E'A entrega da NF {nf} não foi possível por divergência no endereço.\n\n' ||
  E'Pode confirmar o endereço correto pra reentrega? Se preferir, também posso autorizar a devolução.\n\n' ||
  E'Aguardo retorno.\n\n' ||
  E'{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'operadora_nome'],
  false
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'RECUSA_PARCIAL',
  'Recusa parcial — solicitar tratativa do restante',
  'Quando cliente recusou parcialmente a entrega no destino. Precisa decidir o que fazer com a parte recusada (devolver / nova tentativa / aguardar).',
  '[Sal Express] NF {nf} — recusa parcial da entrega',
  E'Olá {primeiro_nome},\n\n' ||
  E'A entrega da NF {nf} foi feita parcialmente — parte da carga foi recusada no destino.\n\n' ||
  E'Como prefere prosseguir com a parte recusada?\n' ||
  E'1) Devolver\n' ||
  E'2) Nova tentativa em outro endereço\n' ||
  E'3) Aguardar\n\n' ||
  E'Aguardo retorno.\n\n' ||
  E'{operadora_nome}\nSal Express — Relacionamento',
  ARRAY['primeiro_nome', 'nf', 'operadora_nome'],
  false
)
ON CONFLICT (id) DO NOTHING;
