-- =============================================================================
-- 2026-08-21_346_atribuicao_operador_agent_feedback.sql
--
-- AUDITORIA DO CAIO (21/08, Gestão Agentes): "oc13 mostra 110 sugestões, mas
-- filtrando por operador só aparece o Duilio com 7 — TOTAL é a soma de cada
-- operador". Causa provada: agent_feedback.operador_id só estava preenchido em
-- ~5% das linhas — o feedback IMPLÍCITO (executor) nunca gravou QUEM aprovou
-- ('executor (implícito)'), e o trigger espelho só copiava NEW.corrigido_por.
-- O aprovador SEMPRE existiu em todos.approved_by: 5.051/5.053 atribuíveis.
--
-- 3 partes (raiz no passado E no futuro):
--   1. guard de mutação passa a permitir ENRIQUECER operador_id (só NULL→valor;
--      nunca trocar valor existente — append-only continua valendo);
--   2. trigger espelho resolve o aprovador via todos quando o legado não traz;
--   3. backfill das linhas históricas sem operador.
--
-- Linhas que continuarem NULL = auto-aprovação/autônomo (sem humano) — correto
-- ficarem fora da visão por operador.
--
-- SEM begin/commit interno (lição da mig 337). Idempotente.
-- =============================================================================

-- 1. ─── guard: enriquecimento de operador_id permitido (NULL → valor) ────────
create or replace function public.agent_feedback_guard_mutacao()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'agent_feedback é append-only (DELETE proibido)';
  end if;
  if (new.card_id, new.todo_id, new.agent_name, new.action_key_sugerida,
      new.oc_sugerida, new.oc_executada, new.veredito, new.origem,
      new.reason_code, new.reason_text, new.confianca,
      new.modo, new.created_at)
     is distinct from
     (old.card_id, old.todo_id, old.agent_name, old.action_key_sugerida,
      old.oc_sugerida, old.oc_executada, old.veredito, old.origem,
      old.reason_code, old.reason_text, old.confianca,
      old.modo, old.created_at) then
    raise exception 'agent_feedback: só desfecho_* e operador_id (enriquecimento) podem ser atualizados';
  end if;
  -- operador_id: aceita preencher quando estava NULL; trocar valor é proibido
  if old.operador_id is not null and new.operador_id is distinct from old.operador_id then
    raise exception 'agent_feedback: operador_id já atribuído não pode ser trocado';
  end if;
  return new;
end;
$$;

-- 2. ─── trigger espelho: resolve o aprovador quando o legado não traz ────────
-- Recria a função inteira (mesma lógica da mig 338 + o fallback via todos).
create or replace function public.fn_espelhar_feedback_agente()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_agent text;
  v_sug integer;
  v_exec integer;
  v_veredito text;
  v_origem text;
  v_oc_card integer;
  v_operador uuid;
begin
  if TG_TABLE_NAME = 'agente_ocs_padrao_feedback' then
    v_oc_card := new.codigo_oc_card;
    v_agent := 'agente-sugere-ocs-padrao';
    v_sug := case when (new.decisao_ia->>'proposta_destacada') ~ '^\d+$'
                  then (new.decisao_ia->>'proposta_destacada')::int end;
    v_veredito := case
      when new.tipo_feedback = 'caso_nao_reconhecido' then 'abstencao'
      when new.tipo_feedback like 'sugestao_certa%' then 'seguida'
      else 'corrigida' end;
    v_origem := case when new.tipo_feedback like '%implicita' then 'implicit' else 'explicit' end;

  elsif TG_TABLE_NAME = 'agente_oc13_feedback' then
    v_oc_card := 13;
    v_agent := 'agente-oc13-autonomo';
    v_sug := case when split_part(new.decisao_ia->>'proposta_destacada_acao', ':', 2) ~ '^\d+$'
                  then split_part(new.decisao_ia->>'proposta_destacada_acao', ':', 2)::int end;
    v_veredito := case
      when new.decisao_ia ? 'erro_msg' then 'abstencao'
      when new.tipo_feedback like 'sugestao_certa%' then 'seguida'
      else 'corrigida' end;
    v_origem := case when new.tipo_feedback like '%implicita' then 'implicit' else 'explicit' end;

  elsif TG_TABLE_NAME = 'interpretador_resposta_cliente_feedback' then
    v_oc_card := new.oc_card_no_momento;
    v_agent := public.agente_da_sugestao_resposta(new.decisao_ia);
    if v_agent is null then return new; end if;
    v_sug := new.oc_sugerida_pela_ia;
    v_veredito := case when new.tipo_feedback like 'acertou%' then 'seguida' else 'corrigida' end;
    v_origem := case when new.tipo_feedback like '%implicito' then 'implicit' else 'explicit' end;
  else
    return new;
  end if;

  v_exec := case when v_veredito = 'seguida' then v_sug else new.decisao_correta_codigo_ssw end;

  -- FIX 21/08 (auditoria do Caio): dono da decisão = quem APROVOU no card.
  -- corrigido_por quando existe (feedback explícito); senão a aprovação humana
  -- mais recente do card até o instante do feedback (janela +5min pra clock skew).
  v_operador := new.corrigido_por;
  if v_operador is null then
    select t.approved_by into v_operador
    from public.todos t
    where t.card_id = new.card_id
      and t.approved_by is not null
      and t.approved_at <= new.corrigido_em + interval '5 minutes'
    order by t.approved_at desc
    limit 1;
  end if;

  insert into public.agent_feedback (
    agent_name, card_id, oc_sugerida, oc_executada, veredito, origem, modo,
    confianca, reason_text, operador_id, created_at, oc_card
  ) values (
    v_agent, new.card_id, v_sug, v_exec, v_veredito, v_origem, 'sugestao',
    case when (new.decisao_ia->>'confianca') ~ '^[0-9.]+$'
         then (new.decisao_ia->>'confianca')::numeric end,
    new.motivo_correcao, v_operador, new.corrigido_em, v_oc_card
  )
  on conflict do nothing;

  return new;
end;
$$;

-- 3. ─── backfill: atribui o aprovador às linhas históricas sem operador ──────
update public.agent_feedback f
set operador_id = (
  select t.approved_by from public.todos t
  where t.card_id = f.card_id
    and t.approved_by is not null
    and t.approved_at <= f.created_at + interval '5 minutes'
  order by t.approved_at desc
  limit 1
)
where f.operador_id is null
  and exists (
    select 1 from public.todos t
    where t.card_id = f.card_id
      and t.approved_by is not null
      and t.approved_at <= f.created_at + interval '5 minutes'
  );

-- Pós-check (informativo)
select agent_name, count(*) as linhas, count(operador_id) as com_operador,
       round(100.0*count(operador_id)/count(*),1) as pct
from public.agent_feedback group by 1 order by 2 desc;
