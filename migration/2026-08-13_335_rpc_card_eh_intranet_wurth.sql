-- =============================================================================
-- 2026-08-13_335_rpc_card_eh_intranet_wurth.sql
--
-- Fix da causa raiz (Caio 2026-08-13): o botão "Buscar intranet Würth" NUNCA
-- aparecia. O front (role `authenticated`) não consegue ler `cliente_config` —
-- a tabela é service-role only (policy RESTRICTIVE `cliente_config_service_only`
-- com qual=false p/ {anon,authenticated} + sem GRANT de SELECT). A query de
-- visibilidade do botão (`ehIntranetWurth`) falhava com `permission denied` →
-- ficava no default `false` → botão escondido pra TODOS (provado com
-- `set role authenticated; select ... from cliente_config` = permission denied).
--
-- Fix RAIZ sem enfraquecer a trava da tabela: dar ao front um canal MÍNIMO —
-- um único boolean por CNPJ, via RPC SECURITY DEFINER (não abre a tabela nem
-- expõe a lista de CNPJs/colunas sensíveis como `notes`/templates). Mesmo padrão
-- do `status_ultimo_sync_bastao` (mig 217).
-- =============================================================================

create or replace function public.card_eh_intranet_wurth(p_cnpj text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select intranet_wurth
       from public.cliente_config
      where cnpj_pagador = regexp_replace(coalesce(p_cnpj, ''), '\D', '', 'g')
        and ativo),
    false);
$$;

revoke all on function public.card_eh_intranet_wurth(text) from public;
grant execute on function public.card_eh_intranet_wurth(text) to authenticated, service_role;

comment on function public.card_eh_intranet_wurth(text) is
  'Front: o card cujo CNPJ pagador é dado tem retorno via intranet Würth? '
  'Expõe só um boolean (cliente_config é service-only — mig 335). Caio 2026-08-13.';
