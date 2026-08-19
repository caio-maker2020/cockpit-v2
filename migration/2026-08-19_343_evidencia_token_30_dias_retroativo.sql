-- =============================================================================
-- 2026-08-19_343_evidencia_token_30_dias_retroativo.sql
--
-- Caio 2026-08-19 (NF 1107188 UNIAO QUIMICA): cliente clicou no link de
-- evidência 9 dias após o envio e o token (7 dias) já tinha expirado —
-- "Erro temporário" na tela, demanda de reenvio pra operadora.
--
-- Decisão do Caio: validade de 30 dias (Opção A) + RETROATIVO pra toda
-- evidência ENVIADA NOS ÚLTIMOS 30 DIAS voltar a funcionar já — inclusive a
-- NF do exemplo (token 25b085f3-9675-4263-a30c-a48d9f922b22, criado 10/08).
--
-- Regra do retroativo: expira_em = criado_em + 30 dias, apenas pra tokens
-- criados na janela dos últimos 30 dias cujo prazo atual seja menor. Tokens
-- mais antigos que 30 dias continuam expirados (mesma regra dos novos).
-- Nada é encurtado (GREATEST protege token com prazo maior, se existir).
--
-- Código (mesmo PR): validade nova nasce em _shared/token-evidencia.ts
-- (fonte única, 30 dias) usada por executor / enviar-retificacao-evidencia /
-- email-teste-evidencia; r-evidencia responde JSON honesto no modo meta.
--
-- SEM begin/commit interno (lição da mig 337). Idempotente: re-rodar não
-- muda nada (expira_em já estará >= criado_em + 30d).
-- =============================================================================

update public.tokens_evidencia
set expira_em = greatest(expira_em, criado_em + interval '30 days')
where criado_em > now() - interval '30 days'
  and expira_em < criado_em + interval '30 days';

-- Pós-check (informativo): o token do caso âncora deve estar vivo de novo.
select id, nf, criado_em, expira_em, expira_em > now() as vivo
from public.tokens_evidencia
where id = '25b085f3-9675-4263-a30c-a48d9f922b22';
