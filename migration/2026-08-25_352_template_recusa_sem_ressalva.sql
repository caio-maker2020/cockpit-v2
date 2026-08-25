-- =============================================================================
-- 2026-08-25_352_template_recusa_sem_ressalva.sql
--
-- Template RECUSA_SEM_RESSALVA (Caio 2026-08-25, NF 234381): quando a oc 49
-- traz a informação de que o destinatário recusou SEM registrar a ressalva,
-- o e-mail ao pagador diz exatamente isso — o agente usava "recusa total"
-- genérica e a operadora tinha que voltar pra 56. Escolhido por
-- _shared/recusa-sem-ressalva.ts no caso devolucao_pos_56.
--
-- SEM begin/commit interno. Idempotente (on conflict do nothing).
-- =============================================================================

insert into public.templates_email
  (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
values (
  'RECUSA_SEM_RESSALVA',
  'Recusa no recebimento sem ressalva no canhoto',
  'Caio 2026-08-25 (NF 234381): destinatário recusou o recebimento e NÃO registrou a ressalva no canhoto — informar o pagador exatamente disso e pedir orientação. Usado pelo agente-sugere-ocs-padrao (caso devolucao_pos_56, classificador ehRecusaSemRessalva).',
  'Recusa no recebimento sem ressalva — NF {nf} — {empresa}',
  E'Olá {primeiro_nome},\n\nNa entrega da NF {nf}, o destinatário recusou o recebimento da mercadoria e não registrou a ressalva no canhoto.\n\nSegue a evidência registrada pela equipe de entrega, que pode ser acessada através do link: {link_evidencia}\n\nPoderiam nos orientar sobre o destino da mercadoria — devolução, nova tentativa de entrega ou outra instrução?\n\n{operadora_nome} Sal Express — Relacionamento',
  '{primeiro_nome,nf,operadora_nome,link_evidencia}',
  true
)
on conflict (id) do nothing;
