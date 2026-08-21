-- =============================================================================
-- 2026-08-21_345_marcadores_processo_operador.sql
--
-- Máquina de Visão FASE 3 (M1): quando a Isadora responde uma pergunta do
-- agente-chefe com "O processo está correto — o operador é que está errando",
-- isso vira um MARCADOR visível na Gestão Operadores (o problema não é o
-- agente; é adesão ao processo). Detecção por trigger no learning_log
-- (a RPC responder_pergunta_aprendizado grava detalhes.opcao — mig 311),
-- rótulo padronizado em aprendizado-regras.ts (OPCAO_PROCESSO_CORRETO_ROTULO).
--
-- SEM begin/commit interno (lição da mig 337). Idempotente.
-- =============================================================================

create table if not exists public.marcadores_processo_operador (
  id uuid primary key default gen_random_uuid(),
  learning_log_id uuid not null references public.learning_log(id) on delete cascade,
  agente_alvo text,
  chave_padrao text,
  titulo_pergunta text,
  validado_por text,           -- nome de quem respondeu (Isadora)
  criado_em timestamptz not null default now(),
  -- fechamento manual pela gestão quando o alinhamento com o time acontecer
  resolvido_em timestamptz,
  resolvido_obs text,
  unique (learning_log_id)
);

comment on table public.marcadores_processo_operador is
  'Gestão Operadores: casos em que a Isadora validou que o PROCESSO está certo e o operador está errando (resposta padronizada do M1 do Aprendizado). Fase 3, 21/08.';

alter table public.marcadores_processo_operador enable row level security;

drop policy if exists marcadores_select_gestor on public.marcadores_processo_operador;
create policy marcadores_select_gestor on public.marcadores_processo_operador
  for select to authenticated
  using (public.current_operador_papel() = 'gestor');

drop policy if exists marcadores_update_gestor on public.marcadores_processo_operador;
create policy marcadores_update_gestor on public.marcadores_processo_operador
  for update to authenticated
  using (public.current_operador_papel() = 'gestor')
  with check (public.current_operador_papel() = 'gestor');

create index if not exists idx_marcadores_processo_abertos
  on public.marcadores_processo_operador (criado_em desc)
  where resolvido_em is null;

-- Trigger: resposta_admin com a opção padronizada → marcador.
create or replace function public.fn_marcar_processo_correto()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_pergunta record;
begin
  if new.tipo <> 'resposta_admin' then
    return new;
  end if;
  -- rótulo padronizado (novo) OU o rótulo antigo do default (compat)
  if not (
    coalesce(new.detalhes->>'opcao', '') ilike '%processo está correto%operador%errando%'
    or coalesce(new.detalhes->>'opcao', '') ilike '%time é que está corrigindo errado%'
  ) then
    return new;
  end if;

  select l.agente_alvo, l.titulo, l.detalhes->>'chave_padrao' as chave_padrao
    into v_pergunta
  from public.learning_log l
  where l.id = new.parent_id;

  insert into public.marcadores_processo_operador
    (learning_log_id, agente_alvo, chave_padrao, titulo_pergunta, validado_por)
  values (
    new.id,
    coalesce(new.agente_alvo, v_pergunta.agente_alvo),
    coalesce(new.detalhes->>'chave_padrao', v_pergunta.chave_padrao),
    v_pergunta.titulo,
    (select o.nome from public.operadores o where o.id = new.revisado_por)
  )
  on conflict (learning_log_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_marcar_processo_correto on public.learning_log;
create trigger trg_marcar_processo_correto
  after insert on public.learning_log
  for each row execute function public.fn_marcar_processo_correto();

grant select on public.marcadores_processo_operador to authenticated, service_role;
