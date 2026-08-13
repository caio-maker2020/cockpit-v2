-- =============================================================================
-- 2026-08-13_340_fase5_autonomia_por_fatia.sql
--
-- FASE 5 (Caio 2026-08-13): "fazer os 95% ser autônomo e 5% ainda passar por
-- validação". Esta migration entrega o PLANO DE CONTROLE dessa decisão —
-- e NÃO promove nada. Nenhuma fatia nasce autônoma; promover é ato humano
-- explícito (INSERT deliberado, registrado com quem e por quê).
--
-- POR QUE POR FATIA, NUNCA PELO NÚMERO GLOBAL (medido em produção):
--   interpretador-resposta-cliente ... 67,6% no geral
--     └─ quando sugere oc 44 ......... 94,5% em 711 casos  ← quase pronto
--     └─ quando sugere oc 56 ......... 50,7%               ← nunca liberar
--   agente-sugere-ocs-padrao ......... 80,5% no geral
--     └─ card em oc 49 .............. 100%
--     └─ card em oc 11 .............. 68,4%
-- Pelo número global você não libera o que já está pronto nem bloqueia o que
-- está ruim. A fatia é a unidade certa de decisão.
--
-- COMPONENTES
--   1. `fatias_autonomas` — registro explícito do que É autônomo (+ kill-switch)
--   2. `v_fatias_candidatas_autonomia` — o que JÁ PODERIA ser (decisão apoiada)
--   3. `fatia_esta_autonoma(...)` — o guard que o agente consulta antes de agir
--   4. `demover_fatias_abaixo_da_meta()` — despromove sozinho quem cair
--   5. Gabarito dos AUTÔNOMOS: erro reportado vira 'corrigida' no placar
--
-- PRÉ-REQUISITO: migs 338 e 339 aplicadas.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. O REGISTRO — só está autônomo o que estiver aqui com ativa=true
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.fatias_autonomas (
  id              uuid primary key default gen_random_uuid(),
  agent_name      text not null,
  oc_card         integer,          -- null = qualquer oc de origem
  oc_sugerida     integer not null, -- a ação que passa a ser autônoma
  ativa           boolean not null default true,
  -- prova que sustentou a promoção (congelada no momento da decisão)
  pct_na_promocao numeric,
  pares_na_promocao integer,
  promovida_em    timestamptz not null default now(),
  promovida_por   uuid references public.operadores(id),
  motivo          text,
  -- despromoção (kill-switch)
  demovida_em     timestamptz,
  motivo_democao  text
);

create unique index if not exists fatias_autonomas_uk
  on public.fatias_autonomas (agent_name, coalesce(oc_card, -1), oc_sugerida)
  where ativa;

alter table public.fatias_autonomas enable row level security;

drop policy if exists fatias_autonomas_select on public.fatias_autonomas;
create policy fatias_autonomas_select on public.fatias_autonomas
  for select to authenticated using (true);

grant select on public.fatias_autonomas to authenticated;
grant select, insert, update on public.fatias_autonomas to service_role;

comment on table public.fatias_autonomas is
  'Registro explícito das fatias (agente × oc do card × oc sugerida) liberadas '
  'pra ação autônoma. Vazia = nada autônomo. Promover é ato humano; despromover '
  'é automático quando o acerto cai (demover_fatias_abaixo_da_meta). Caio 2026-08-13.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CANDIDATAS — o que já bate o critério e ainda não foi promovido
--
-- Critérios (mais rígidos que os do painel, porque aqui a ação sai sem humano):
--   • ≥ 95% de acerto
--   • ≥ 50 pares na janela (o painel exibe a partir de 30)
--   • janela de 30 dias e atividade nos últimos 7 (não promove fatia morta)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_fatias_candidatas_autonomia as
with base as (
  select
    af.agent_name,
    af.oc_card,
    af.oc_sugerida,
    count(*) filter (where af.veredito = 'seguida')   as seguidas,
    count(*) filter (where af.veredito = 'corrigida') as corrigidas,
    max(af.created_at)                                as ultimo_par
  from public.agent_feedback af
  where af.created_at >= now() - interval '30 days'
    and af.veredito in ('seguida','corrigida')
    and af.oc_sugerida is not null
    and af.modo = 'sugestao'   -- autônomo não se auto-promove
  group by 1,2,3
)
select
  b.agent_name,
  b.oc_card,
  b.oc_sugerida,
  b.seguidas,
  b.corrigidas,
  b.seguidas + b.corrigidas as pares,
  round(100.0 * b.seguidas / nullif(b.seguidas + b.corrigidas, 0), 1) as pct_acerto,
  b.ultimo_par
from base b
where b.seguidas + b.corrigidas >= 50
  and round(100.0 * b.seguidas / nullif(b.seguidas + b.corrigidas, 0), 1) >= 95
  and b.ultimo_par >= now() - interval '7 days'
  and not exists (
    select 1 from public.fatias_autonomas fa
    where fa.ativa
      and fa.agent_name = b.agent_name
      and coalesce(fa.oc_card, -1) = coalesce(b.oc_card, -1)
      and fa.oc_sugerida = b.oc_sugerida
  );

comment on view public.v_fatias_candidatas_autonomia is
  'Fatias que JÁ batem o critério de autonomia (≥95%, ≥50 pares em 30d, ativa '
  'nos últimos 7d) e ainda não foram promovidas. É lista de decisão — promover '
  'continua sendo ato humano. Caio 2026-08-13.';

grant select on public.v_fatias_candidatas_autonomia to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. O GUARD — todo agente consulta antes de agir sozinho
--    Default é FALSE: sem registro explícito, nada é autônomo.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fatia_esta_autonoma(
  p_agent_name  text,
  p_oc_card     integer,
  p_oc_sugerida integer
) returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM public.fatias_autonomas fa
    WHERE fa.ativa
      AND fa.agent_name = p_agent_name
      AND fa.oc_sugerida = p_oc_sugerida
      AND (fa.oc_card IS NULL OR fa.oc_card = p_oc_card)
  );
$function$;

revoke all on function public.fatia_esta_autonoma(text, integer, integer) from public;
grant execute on function public.fatia_esta_autonoma(text, integer, integer) to authenticated, service_role;

comment on function public.fatia_esta_autonoma(text, integer, integer) is
  'Guard de autonomia: o agente pergunta antes de auto-aprovar. FALSE por '
  'default — o que não está registrado passa por validação humana. Caio 2026-08-13.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. KILL-SWITCH — despromove sozinho quem cair
--
-- Histerese de propósito: promove com ≥95, despromove abaixo de 90. Sem isso a
-- fatia ficaria oscilando na fronteira a cada dia.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.demover_fatias_abaixo_da_meta(
  p_piso numeric default 90
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_demovidas int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT fa.id, fa.agent_name, fa.oc_card, fa.oc_sugerida,
           round(100.0 * count(*) filter (where af.veredito='seguida')
                 / nullif(count(*) filter (where af.veredito in ('seguida','corrigida')),0), 1) as pct,
           count(*) filter (where af.veredito in ('seguida','corrigida')) as pares
    FROM public.fatias_autonomas fa
    JOIN public.agent_feedback af
      ON af.agent_name = fa.agent_name
     AND af.oc_sugerida = fa.oc_sugerida
     AND (fa.oc_card IS NULL OR af.oc_card = fa.oc_card)
     AND af.created_at >= now() - interval '14 days'
    WHERE fa.ativa
    GROUP BY fa.id, fa.agent_name, fa.oc_card, fa.oc_sugerida
    HAVING count(*) filter (where af.veredito in ('seguida','corrigida')) >= 20
       AND round(100.0 * count(*) filter (where af.veredito='seguida')
                 / nullif(count(*) filter (where af.veredito in ('seguida','corrigida')),0), 1) < p_piso
  LOOP
    UPDATE public.fatias_autonomas
       SET ativa = false,
           demovida_em = now(),
           motivo_democao = format('acerto caiu pra %s%% em %s pares (piso %s%%)', r.pct, r.pares, p_piso)
     WHERE id = r.id;
    v_demovidas := v_demovidas + 1;
  END LOOP;
  RETURN v_demovidas;
END;
$function$;

revoke all on function public.demover_fatias_abaixo_da_meta(numeric) from public;
grant execute on function public.demover_fatias_abaixo_da_meta(numeric) to service_role;

comment on function public.demover_fatias_abaixo_da_meta(numeric) is
  'Kill-switch: tira a autonomia de fatia cujo acerto caiu abaixo do piso (90%) '
  'em 14 dias com ao menos 20 pares. Histerese evita oscilar na fronteira dos '
  '95%. Rodar no cron diário. Caio 2026-08-13.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. GABARITO DOS AUTÔNOMOS — quem age sozinho não tem decisão de operador
--
-- Pela definição canônica (operador é a verdade) não existe par pra ação
-- autônoma: ninguém escolheu nada pra comparar. Mas existe UM sinal humano
-- honesto — o erro reportado (`erros_lancamento_ssw`, com a oc errada E a
-- correta). Ele vira 'corrigida' com origem='audit'.
--
-- Ausência de reporte NÃO vira acerto: seria dar nota a si mesmo. Por isso o
-- placar dos autônomos mostra "N ações · M erros reportados", não um %.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_erro_lancamento_vira_par()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_agente text;
BEGIN
  -- Só interessa erro de lançamento que veio de ação AUTÔNOMA de agente.
  SELECT t.auto_approval_rule INTO v_agente
  FROM public.todos t
  WHERE t.card_id = NEW.card_id
    AND t.auto_approval_rule IS NOT NULL
    AND (t.proposta_payload->'args'->>'codigo_ssw')::int = NEW.codigo_oc_errada
  ORDER BY t.created_at DESC
  LIMIT 1;

  IF v_agente IS NULL THEN
    RETURN NEW;  -- lançamento humano: não é erro de agente
  END IF;

  INSERT INTO public.agent_feedback (
    agent_name, card_id, oc_sugerida, oc_executada, oc_card,
    veredito, origem, modo, reason_text, operador_id, created_at
  ) VALUES (
    v_agente, NEW.card_id, NEW.codigo_oc_errada, NEW.codigo_oc_correta, NEW.codigo_oc_errada,
    'corrigida', 'audit', 'autonomo', NEW.motivo, NEW.reportado_por, NEW.created_at
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

drop trigger if exists trg_erro_lancamento_vira_par on public.erros_lancamento_ssw;
create trigger trg_erro_lancamento_vira_par after insert on public.erros_lancamento_ssw
  for each row execute function public.fn_erro_lancamento_vira_par();

comment on function public.fn_erro_lancamento_vira_par() is
  'Gabarito dos agentes autônomos: erro de lançamento reportado sobre uma ação '
  'auto-aprovada vira "corrigida" (origem=audit, modo=autonomo) no placar. '
  'Ausência de reporte NÃO vira acerto. Caio 2026-08-13.';
