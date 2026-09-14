-- =============================================================================
-- 2026-09-14_396 — teste do Relacionamento: Q25 reescrita + 5 perguntas novas
-- (Caio 14/09, antes da liberação pro time — 0 respostas na tabela no momento
-- da troca, conferido). Gabaritos das 6 chegam amanhã (Caio); frentes das
-- novas são PROVISÓRIAS até lá. Total passa de 25 → 30.
-- Novas entram no FIM da fila (ordem 26-30) pra não bagunçar quem estiver no
-- meio do teste. TIPO A. Sem BEGIN.
-- =============================================================================

-- Q25 (exibida como pergunta 9): cenário do dedicado/CT-e complementar
UPDATE public.teste_rel_perguntas
   SET pergunta = 'Uma tratativa de entrega dedicada está em andamento. O cliente pagador ainda não autorizou, mas você sabe que, se mandar, resolve o problema do cliente que está cobrando — e a entrega já está atrasada. A base não aceita seguir sem o CT-e complementar emitido, e o cliente ainda não autorizou. O que você faz?'
 WHERE id = 25;

INSERT INTO public.teste_rel_perguntas (id, ordem, frente, pergunta) VALUES
 (26, 26, 'aberta',           'Detalhe, com o seu conhecimento, TODO o processo de extravio total e parcial e todas as possibilidades de tratativa.'),
 (27, 27, 'tecnica_conflito', 'O custos / gerente de filial te passou um e-mail falando que não irá seguir com a carga do cliente para a rota a não ser que você repasse um complementar de R$ X,00. O que você faz?'),
 (28, 28, 'tecnica_conflito', 'Você entendeu que o complementar é devido e, ao repassar para o cliente pagador, ele disse que não vai pagar porque já está pagando o frete. Como você age?'),
 (29, 29, 'comportamento',    'Um cliente grande te chamou pedindo para fazer um valor especial para um frete específico, ou solicitando um frete cortesia. Como você trata, e por quê?'),
 (30, 30, 'tecnica_padrao',   'Você recebeu um e-mail de um cliente contestando uma cobrança de TDE. Qual o fluxo a ser seguido?')
ON CONFLICT (id) DO UPDATE
  SET ordem = EXCLUDED.ordem, frente = EXCLUDED.frente,
      pergunta = EXCLUDED.pergunta, ativa = true;
