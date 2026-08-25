-- =============================================================================
-- 2026-08-25_351_template_local_fechado_oc13.sql
--
-- Template novo TENTATIVA_ENTREGA_LOCAL_FECHADO (Caio 2026-08-25, NF 153826):
-- o agente oc13 mandava 100% das sugestões 54+email com o template de
-- "problemas com endereço" (195/195 em 30d; 79 eram feriado/fechado/ausente)
-- — cliente recebia "problema com seu endereço" quando o motivo era feriado
-- municipal. Uso APENAS no fluxo da oc 13 (clientes validados em exceção),
-- por ordem do Caio; fecho "Podemos reentregar?" também por ordem dele.
--
-- SEM begin/commit interno. Idempotente (on conflict do nothing).
-- =============================================================================

insert into public.templates_email
  (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
values (
  'TENTATIVA_ENTREGA_LOCAL_FECHADO',
  'Tentativa de entrega — local fechado / feriado (oc 13)',
  'oc=13 (clientes de exceção) — Caio 2026-08-25 (NF 153826): tentativa de entrega com estabelecimento fechado (feriado, fora de expediente, destinatário ausente). Termina com "Podemos reentregar?" por ordem do Caio. Escolhido por _shared/oc13-template-email.ts.',
  'Tentativa de entrega — NF {nf} — {empresa}',
  E'Olá {primeiro_nome},\n\nRealizamos a tentativa de entrega da NF {nf}, porém o estabelecimento estava fechado no momento da visita (feriado local ou fora do horário de funcionamento).\n\nSegue a evidência registrada pelo motorista, que pode ser acessada através do link: {link_evidencia}\n\nPodemos reentregar?\n\n{operadora_nome} Sal Express — Relacionamento',
  '{primeiro_nome,nf,operadora_nome,link_evidencia}',
  true
)
on conflict (id) do nothing;
