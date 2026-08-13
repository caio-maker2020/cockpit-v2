-- =============================================================================
-- 2026-08-13_338_fase1_placar_fonte_unica.sql
--
-- FASE 1 do placar de agentes (Caio 2026-08-13): UMA fonte pra todo agente.
--
-- Hoje cada agente mensurável tem tabela própria (`agente_ocs_padrao_feedback`,
-- `agente_oc13_feedback`, `interpretador_resposta_cliente_feedback`) e a view
-- `v_agent_feedback_unificado` costura as 3 com um UNION ALL escrito à mão.
-- Plugar o 4º agente exige tabela nova + RPC nova + editar o UNION — por isso
-- 46 dos 49 agentes nunca foram medidos.
--
-- `public.agent_feedback` já existe desde a mig 299 (17/07) com EXATAMENTE o
-- schema certo — `agent_name`, `todo_id`, `oc_sugerida`, `oc_executada`,
-- `veredito`, `origem`, `modo`, `confianca`, `desfecho` — e **zero linhas**:
-- ninguém nunca escreveu nela. Esta migration a coloca em uso.
--
-- O QUE ESTA MIGRATION FAZ
--   1. Índice único → idempotência do par (agente, card, todo, sugestão, origem).
--   2. RPC ÚNICA `registrar_par_agente(...)` — o contrato que qualquer agente usa.
--   3. Dual-write por TRIGGER: toda linha nova nas 3 tabelas legadas é
--      espelhada em agent_feedback (cobre implícito E explícito).
--      Nada é removido — a aba Aprendizado e os chats seguem lendo a view antiga
--      sem enxergar diferença. O corte é feito depois, com dado nos dois lados.
--   4. Backfill do histórico das 3 tabelas (preserva data e origem).
--   5. View `v_placar_agente` — dia × agente × fatia, já no vocabulário final.
--
-- DEFINIÇÃO CANÔNICA: operador é a verdade.
--   sugeriu X · operador fez X → 'seguida'   (ACERTO)
--   sugeriu X · operador fez Y → 'corrigida' (ERRO)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Idempotência do par
--    Discriminador é o `todo_id` (a unidade real de decisão do operador). Sem
--    ele, cai no par (card, sugestão) — pior, mas não duplica.
-- ─────────────────────────────────────────────────────────────────────────────
create unique index if not exists agent_feedback_par_uk
  on public.agent_feedback (
    agent_name,
    card_id,
    coalesce(todo_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(oc_sugerida, -1),
    origem
  );

-- Placar consulta sempre por janela de tempo + agente.
create index if not exists agent_feedback_agente_data_idx
  on public.agent_feedback (agent_name, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. O CONTRATO — uma RPC pra qualquer agente
--
-- Chamar no ponto em que o humano decide (aprovação que chega ao SSW). Calcula
-- o veredito sozinha: igual = seguida, diferente = corrigida. Idempotente.
-- Retorna NULL quando não há par (sem sugestão) — nunca inventa veredito.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.registrar_par_agente(
  p_agent_name   text,
  p_card_id      uuid,
  p_oc_sugerida  integer,
  p_oc_executada integer,
  p_todo_id      uuid    default null,
  p_origem       text    default 'implicit',
  p_modo         text    default 'sugestao',
  p_action_key   text    default null,
  p_confianca    numeric default null,
  p_reason_text  text    default null,
  p_operador_id  uuid    default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_id uuid;
  v_veredito text;
BEGIN
  IF p_agent_name IS NULL OR p_card_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Sem sugestão não há par: o agente não opinou, então não pode acertar nem
  -- errar. Vira abstenção (fica fora do denominador do placar).
  IF p_oc_sugerida IS NULL THEN
    v_veredito := 'abstencao';
  ELSIF p_oc_executada IS NULL THEN
    RETURN NULL;  -- operador ainda não agiu: par incompleto, não registra
  ELSIF p_oc_sugerida = p_oc_executada THEN
    v_veredito := 'seguida';
  ELSE
    v_veredito := 'corrigida';
  END IF;

  INSERT INTO public.agent_feedback (
    agent_name, card_id, todo_id, action_key_sugerida,
    oc_sugerida, oc_executada, veredito, origem, modo,
    confianca, reason_text, operador_id
  ) VALUES (
    p_agent_name, p_card_id, p_todo_id, p_action_key,
    p_oc_sugerida, p_oc_executada, v_veredito,
    coalesce(p_origem, 'implicit'), coalesce(p_modo, 'sugestao'),
    p_confianca, p_reason_text, p_operador_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

revoke all on function public.registrar_par_agente(text, uuid, integer, integer, uuid, text, text, text, numeric, text, uuid) from public;
grant execute on function public.registrar_par_agente(text, uuid, integer, integer, uuid, text, text, text, numeric, text, uuid) to service_role;

comment on function public.registrar_par_agente(text, uuid, integer, integer, uuid, text, text, text, numeric, text, uuid) is
  'Contrato único do placar: grava o par "agente sugeriu X · operador fez Y" em '
  'agent_feedback. Igual=seguida, diferente=corrigida, sem sugestão=abstenção. '
  'Idempotente pelo índice agent_feedback_par_uk. Caio 2026-08-13 (Fase 1).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. ATRIBUIÇÃO — de quem é a sugestão gravada em `ia_sugestao_oc_resposta`?
--
-- BUG ENCONTRADO (Caio 2026-08-13): essa coluna é escrita por VÁRIOS agentes,
-- mas a RPC de feedback atribuía TUDO ao interpretador. Medido em produção:
-- 120 das 1.746 linhas (6,9%) do "interpretador" eram de outros agentes —
-- 40 do robô da intranet Würth e 80 do scan-email-pre-card.
--
-- Efeito duplo do conserto: (a) o interpretador para de levar culpa/crédito
-- alheio; (b) robo-intranet-wurth e scan-email-pre-card viram agentes
-- MENSURÁVEIS de graça, sem escrever uma linha de código novo neles.
--
-- `nascimento` e `extravio_total_romaneio_interno` NÃO são sugestão de agente —
-- são marcadores de fluxo (criar-card-manual e executor) e ficam fora do placar.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.agente_da_sugestao_resposta(p_decisao jsonb)
returns text
language sql
immutable
as $function$
  SELECT CASE p_decisao->>'contexto'
    WHEN 'intranet_wurth'            THEN 'robo-intranet-wurth'
    WHEN 'cobrou_antes_notificacao'  THEN 'scan-email-pre-card'
    WHEN 'card_em_espera'            THEN 'scan-email-pre-card'
    WHEN 'nascimento'                THEN NULL   -- criação de card, não sugestão
    WHEN 'extravio_total_romaneio_interno' THEN NULL  -- marcador de fluxo
    ELSE 'interpretador-resposta-cliente'
  END;
$function$;

comment on function public.agente_da_sugestao_resposta(jsonb) is
  'Fonte única de atribuição da sugestão em cards.ia_sugestao_oc_resposta — a '
  'coluna é escrita por vários agentes e o placar precisa saber de quem é. '
  'NULL = não é sugestão de agente (marcador de fluxo). Caio 2026-08-13.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DUAL-WRITE por TRIGGER (não por reescrita das RPCs)
--
-- Toda linha nova nas 3 tabelas legadas é espelhada em agent_feedback. Optei
-- por trigger e não por editar as RPCs porque: (a) cobre também as RPCs
-- EXPLÍCITAS (botões "IA acertou/errou"), que não foram tocadas; (b) não
-- duplica corpo de função; (c) some sozinho quando as tabelas legadas saírem.
-- O mapeamento é o MESMO do backfill abaixo — uma regra só.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_espelhar_feedback_agente()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_agent text;
  v_sug int;
  v_exec int;
  v_veredito text;
  v_origem text;
BEGIN
  IF TG_TABLE_NAME = 'agente_ocs_padrao_feedback' THEN
    v_agent := 'agente-sugere-ocs-padrao';
    v_sug   := nullif(NEW.decisao_ia->>'proposta_destacada','')::int;
    v_veredito := CASE
      WHEN NEW.tipo_feedback = 'caso_nao_reconhecido' THEN 'abstencao'
      WHEN NEW.tipo_feedback LIKE 'sugestao_certa%'   THEN 'seguida'
      ELSE 'corrigida' END;
    v_origem := CASE WHEN NEW.tipo_feedback LIKE '%implicita' THEN 'implicit' ELSE 'explicit' END;

  ELSIF TG_TABLE_NAME = 'agente_oc13_feedback' THEN
    v_agent := 'agente-oc13-autonomo';
    v_sug := coalesce(
      nullif(split_part(NEW.decisao_ia->>'proposta_destacada_acao', ':', 2), '')::int,
      CASE NEW.decisao_ia->>'decisao'
        WHEN 'sugerir_54_email'  THEN 54
        WHEN 'sugerir_21_cancel' THEN 21
        WHEN 'sugerir_56'        THEN 56 END);
    v_veredito := CASE
      WHEN NEW.decisao_ia ? 'erro_msg'              THEN 'abstencao'
      WHEN NEW.tipo_feedback LIKE 'sugestao_certa%' THEN 'seguida'
      ELSE 'corrigida' END;
    v_origem := CASE WHEN NEW.tipo_feedback LIKE '%implicita' THEN 'implicit' ELSE 'explicit' END;

  ELSIF TG_TABLE_NAME = 'interpretador_resposta_cliente_feedback' THEN
    -- a coluna ia_sugestao_oc_resposta tem vários donos: atribui pelo contexto
    v_agent := public.agente_da_sugestao_resposta(NEW.decisao_ia);
    IF v_agent IS NULL THEN RETURN NEW; END IF;  -- marcador de fluxo, não é par
    v_sug   := NEW.oc_sugerida_pela_ia;
    v_veredito := CASE WHEN NEW.tipo_feedback LIKE 'acertou%' THEN 'seguida' ELSE 'corrigida' END;
    v_origem := CASE WHEN NEW.tipo_feedback LIKE '%implicito' THEN 'implicit' ELSE 'explicit' END;
  ELSE
    RETURN NEW;
  END IF;

  v_exec := CASE WHEN v_veredito = 'seguida' THEN v_sug ELSE NEW.decisao_correta_codigo_ssw END;

  INSERT INTO public.agent_feedback (
    agent_name, card_id, oc_sugerida, oc_executada, veredito, origem, modo,
    confianca, reason_text, operador_id, created_at
  ) VALUES (
    v_agent, NEW.card_id, v_sug, v_exec, v_veredito, v_origem, 'sugestao',
    CASE WHEN (NEW.decisao_ia->>'confianca') ~ '^[0-9.]+$'
         THEN (NEW.decisao_ia->>'confianca')::numeric END,
    NEW.motivo_correcao, NEW.corrigido_por, NEW.corrigido_em
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

drop trigger if exists trg_espelhar_ocs_padrao on public.agente_ocs_padrao_feedback;
create trigger trg_espelhar_ocs_padrao after insert on public.agente_ocs_padrao_feedback
  for each row execute function public.fn_espelhar_feedback_agente();

drop trigger if exists trg_espelhar_oc13 on public.agente_oc13_feedback;
create trigger trg_espelhar_oc13 after insert on public.agente_oc13_feedback
  for each row execute function public.fn_espelhar_feedback_agente();

drop trigger if exists trg_espelhar_interpretador on public.interpretador_resposta_cliente_feedback;
create trigger trg_espelhar_interpretador after insert on public.interpretador_resposta_cliente_feedback
  for each row execute function public.fn_espelhar_feedback_agente();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BACKFILL do histórico das 3 tabelas → fonte única
--    Preserva data (`created_at`) e origem originais. Idempotente pelo índice.
-- ─────────────────────────────────────────────────────────────────────────────

-- 3a. agente-sugere-ocs-padrao
insert into public.agent_feedback (
  agent_name, card_id, oc_sugerida, oc_executada, veredito, origem, modo,
  confianca, reason_text, operador_id, created_at
)
select
  'agente-sugere-ocs-padrao',
  f.card_id,
  nullif(f.decisao_ia->>'proposta_destacada','')::int,
  case
    when f.tipo_feedback like 'sugestao_certa%' then nullif(f.decisao_ia->>'proposta_destacada','')::int
    else f.decisao_correta_codigo_ssw
  end,
  case
    when f.tipo_feedback = 'caso_nao_reconhecido' then 'abstencao'
    when f.tipo_feedback like 'sugestao_certa%'   then 'seguida'
    else 'corrigida'
  end,
  case when f.tipo_feedback like '%implicita' then 'implicit' else 'explicit' end,
  'sugestao',
  case when (f.decisao_ia->>'confianca') ~ '^[0-9.]+$' then (f.decisao_ia->>'confianca')::numeric end,
  f.motivo_correcao,
  f.corrigido_por,
  f.corrigido_em
from public.agente_ocs_padrao_feedback f
on conflict do nothing;

-- 3b. agente-oc13-autonomo (mesmo mapeamento de código da mig 337)
insert into public.agent_feedback (
  agent_name, card_id, oc_sugerida, oc_executada, veredito, origem, modo,
  confianca, reason_text, operador_id, created_at
)
select
  'agente-oc13-autonomo',
  f.card_id,
  coalesce(
    nullif(split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2), '')::int,
    case f.decisao_ia->>'decisao'
      when 'sugerir_54_email'  then 54
      when 'sugerir_21_cancel' then 21
      when 'sugerir_56'        then 56
    end
  ) as oc_sug,
  case
    when f.tipo_feedback like 'sugestao_certa%' then coalesce(
      nullif(split_part(f.decisao_ia->>'proposta_destacada_acao', ':', 2), '')::int,
      case f.decisao_ia->>'decisao'
        when 'sugerir_54_email'  then 54
        when 'sugerir_21_cancel' then 21
        when 'sugerir_56'        then 56
      end)
    else f.decisao_correta_codigo_ssw
  end,
  case
    when f.decisao_ia ? 'erro_msg'              then 'abstencao'
    when f.tipo_feedback like 'sugestao_certa%' then 'seguida'
    else 'corrigida'
  end,
  case when f.tipo_feedback like '%implicita' then 'implicit' else 'explicit' end,
  'sugestao',
  case when (f.decisao_ia->>'confianca') ~ '^[0-9.]+$' then (f.decisao_ia->>'confianca')::numeric end,
  f.motivo_correcao,
  f.corrigido_por,
  f.corrigido_em
from public.agente_oc13_feedback f
on conflict do nothing;

-- 3c. interpretador-resposta-cliente
insert into public.agent_feedback (
  agent_name, card_id, oc_sugerida, oc_executada, veredito, origem, modo,
  confianca, reason_text, operador_id, created_at
)
select
  public.agente_da_sugestao_resposta(f.decisao_ia),
  f.card_id,
  f.oc_sugerida_pela_ia,
  case when f.tipo_feedback like 'acertou%' then f.oc_sugerida_pela_ia
       else f.decisao_correta_codigo_ssw end,
  case when f.tipo_feedback like 'acertou%' then 'seguida' else 'corrigida' end,
  case when f.tipo_feedback like '%implicito' then 'implicit' else 'explicit' end,
  'sugestao',
  case when (f.decisao_ia->>'confianca') ~ '^[0-9.]+$' then (f.decisao_ia->>'confianca')::numeric end,
  f.motivo_correcao,
  f.corrigido_por,
  f.corrigido_em
from public.interpretador_resposta_cliente_feedback f
where public.agente_da_sugestao_resposta(f.decisao_ia) is not null
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. O PLACAR — dia × agente × fatia
--    `fatia` = a unidade de autonomia (Fase 5): promove-se por fatia, nunca
--    pelo número global (o ocs-padrao tem 100% na oc 49 e 68% na oc 11).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_placar_agente as
select
  (created_at at time zone 'America/Sao_Paulo')::date as dia,
  agent_name,
  oc_sugerida as fatia_oc_sugerida,
  modo,
  count(*) filter (where veredito = 'seguida')   as seguidas,
  count(*) filter (where veredito = 'corrigida') as corrigidas,
  count(*) filter (where veredito = 'abstencao') as abstencoes,
  count(*) filter (where veredito in ('seguida','corrigida')) as pares,
  round(
    100.0 * count(*) filter (where veredito = 'seguida')
    / nullif(count(*) filter (where veredito in ('seguida','corrigida')), 0)
  , 1) as pct_acerto
from public.agent_feedback
group by 1, 2, 3, 4;

comment on view public.v_placar_agente is
  'Placar dos agentes por dia/agente/fatia. pct_acerto = seguidas/(seguidas+corrigidas); '
  'abstenção fica fora do denominador. Fonte: agent_feedback. Caio 2026-08-13.';

grant select on public.v_placar_agente to authenticated, service_role;
