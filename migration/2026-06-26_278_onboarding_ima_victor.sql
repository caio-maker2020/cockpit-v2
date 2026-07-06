-- 2026-06-26_278_onboarding_ima_victor.sql
-- Onboarding do cliente IMA EQUIPAMENTOS DE PROTECAO INDIVIDUAL LTDA
-- (CNPJ 12463472000482) na carteira do operador VICTOR, pra habilitar o
-- "Criar Card" manual (e os ciclos normais do Bastão) pra esse cliente.
-- Caio 2026-06-26. NF-âncora 263243. Idempotente (pode rodar 2x sem efeito).
--
-- NOTA: sem contato (e-mail) cadastrado ainda. "Notificar cliente + oc 54"
-- por e-mail só funciona depois de inserir um contato em contatos_cliente
-- (a operadora pode preencher no modal de envio; o executor auto-cadastra).
--
-- RLS: clientes.clientes_select_por_carteira filtra SELECT por
-- current_operador_carteira() — IMA só fica visível pro Victor DEPOIS do
-- passo 2 (entrar na carteira dele). Insert aqui roda fora de RLS (psql/owner).

begin;

-- 1. Cliente em public.clientes (upsert idempotente).
insert into public.clientes (cnpj_cpf, nome, ativo)
values ('12463472000482', 'IMA EQUIPAMENTOS DE PROTECAO INDIVIDUAL LTDA', true)
on conflict (cnpj_cpf) do update
  set nome = excluded.nome,
      ativo = true,
      updated_at = now();

-- 2. CNPJ na carteira do VICTOR (array text[], sem duplicar).
update public.operadores
set carteira = case
      when '12463472000482' = any(carteira) then carteira
      else array_append(carteira, '12463472000482')
    end
where id = '8b847d17-b822-4561-87ca-950107e6dd76';

commit;
