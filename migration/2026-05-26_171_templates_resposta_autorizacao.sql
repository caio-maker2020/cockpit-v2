-- =============================================================================
-- Cockpit v2 — Templates de RESPOSTA de confirmação ao cliente
--
-- Caio 2026-05-26: feature "responder cliente em 1 clique" junto com
-- lançamento de oc=21 (reentrega), oc=44 (devolução) ou oc=55 (entrega
-- parcial autorizada).
--
-- Quando o cliente RESPONDE autorizando uma das ações acima, o modal de
-- aprovação no Cockpit ganha um bloco "Responder cliente por email" com
-- texto pré-preenchido (estes templates) e editável pelo operador. 1
-- aprovação = lança a oc no SSW + envia email respondendo a thread Gmail
-- do cliente, evitando que o email final fique sem retorno.
--
-- Textos curtos por design (Caio): só confirmam que o processo seguirá,
-- sem assinatura formal. {saudacao} é placeholder editável pelo operador
-- no front (default "pessoal").
-- =============================================================================

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'RESPOSTA_AUTORIZA_REENTREGA',
  'Resposta — reentrega autorizada',
  'Confirma ao cliente que vamos seguir com a reentrega. Disparado junto com oc=21 pós-autorização.',
  'Re: NF {nf}',
  $$Ok {saudacao}, iremos seguir com a reentrega o mais rápido possível.$$,
  ARRAY['saudacao', 'nf'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'RESPOSTA_AUTORIZA_DEVOLUCAO',
  'Resposta — devolução autorizada',
  'Confirma ao cliente que vamos seguir com a devolução. Disparado junto com oc=44 pós-autorização.',
  'Re: NF {nf}',
  $$Ok {saudacao}, iremos seguir com a devolução conforme prazo acordado.$$,
  ARRAY['saudacao', 'nf'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();

INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'RESPOSTA_AUTORIZA_ENTREGA_PARCIAL',
  'Resposta — entrega parcial autorizada',
  'Confirma ao cliente que vamos seguir com a entrega parcial. Disparado junto com oc=55 pós-autorização.',
  'Re: NF {nf}',
  $$Ok {saudacao}, iremos seguir com a entrega parcial conforme combinado.$$,
  ARRAY['saudacao', 'nf'],
  true
)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  assunto = EXCLUDED.assunto,
  corpo_template = EXCLUDED.corpo_template,
  variaveis_esperadas = EXCLUDED.variaveis_esperadas,
  ativo = EXCLUDED.ativo,
  updated_at = now();
