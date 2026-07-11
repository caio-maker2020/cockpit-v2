-- 2026-06-29_281_reabertura_shadow_log.sql
-- PR3 (SHADOW) — auditoria da decisão de visibilidade NOVA (decidirVisibilidadePorSsw,
-- por IDENTIDADE) vs ATUAL (per-hora deployada), SEM AGIR sobre o card.
--
-- Tabela append-only, escrita SÓ por edge function (service_role) e SÓ quando a
-- flag `reabertura_shadow_enabled` está ON (default OFF). NÃO altera comportamento.
--
-- ⚠️ PREPARADA, NÃO APLICADA. Rodar só após autorização explícita do Caio.

create table if not exists public.reabertura_shadow_log (
  id                uuid primary key default gen_random_uuid(),
  card_id           uuid not null,           -- referência lógica a cards.id (sem FK: log desacoplado)
  nf                text,
  caller            text not null,           -- 'passA' | 'sweepInv019' | 'passG' | 'passH'
  decisao_atual     text,                    -- caminho deployado: 'reabrir' | 'suprimir' | 'indefinido'
  decisao_proposta  text not null,           -- nova: MOSTRAR_OPERADOR | AGUARDANDO_CLIENTE | MANTER_FORA_RELACIONAMENTO | INDEFINIDO_RETRY
  fonte_proposta    text,                    -- identidade | ordem | regra_54 | fora_escopo | sem_ssw | cache_stale | duvida_mostra
  oc_ssw            integer,                 -- oc mais recente real no SSW
  usuario_ssw       text,                    -- autor da oc mais recente (ai.salex × terceiro)
  indice_ssw        integer,                 -- posição da oc mais recente no histórico
  indice_lancamento integer,                 -- posição do último lançamento do Cockpit no histórico
  ssw_fresco        boolean,                 -- fonte foi SSW fresco (true) ou cache/indefinido (false)
  divergente        boolean not null default false, -- desfecho (operador vê?) difere entre atual e proposta
  criado_em         timestamptz not null default now()
);

comment on table public.reabertura_shadow_log is
  'PR3 shadow: decisao de visibilidade nova vs atual, SEM agir. Append-only, service_role, gated por flag reabertura_shadow_enabled (default OFF). Retencao 14 dias.';

-- Índices p/ os 2 padrões de consulta da análise do shadow:
--  (a) por card + recência (timeline de um card)
create index if not exists idx_reabertura_shadow_card
  on public.reabertura_shadow_log (card_id, criado_em desc);

--  (b) PARTIAL: a análise foca nas DIVERGÊNCIAS (fração pequena do total) →
--      índice menor/rápido (query-partial-indexes).
create index if not exists idx_reabertura_shadow_divergente
  on public.reabertura_shadow_log (criado_em desc)
  where divergente;

-- RLS: tabela INTERNA. Escrita/leitura só via service_role (que tem BYPASSRLS).
-- Habilita + força RLS e NÃO cria nenhuma policy → anon/authenticated (front
-- Lovable) ficam sem acesso. service_role (edge functions) continua gravando.
alter table public.reabertura_shadow_log enable row level security;
alter table public.reabertura_shadow_log force row level security;

-- Retenção (14 dias) — proposta via pg_cron, aplicar junto OU em migration própria:
-- select cron.schedule(
--   'reabertura_shadow_log_retencao',
--   '17 4 * * *',
--   $$ delete from public.reabertura_shadow_log where criado_em < now() - interval '14 days' $$
-- );
