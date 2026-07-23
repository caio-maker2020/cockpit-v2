-- =============================================================================
-- 2026-07-23_306 — Memória de avaliação por mensagem do gmail-poll (causa-2)
-- =============================================================================
-- Matheus 2026-07-23. Evidência de produção (gmail_polling_state): TODA caixa
-- fechava a rodada com `last_error: backlog: NNN msgs não processadas (budget)`
-- (sac 436, julia 427, larissa 410, auto.pecas 402, ferramentas 387, victor 348)
-- e `last_success_at` travado em junho — caixas sem rodada limpa há ~1 mês.
--
-- Causa raiz: cada mensagem NÃO-CASADA re-executa `getMensagemMetadata`
-- (roundtrip Gmail) a CADA rodada, porque nada lembra que ela já foi avaliada.
-- A query do poller é `-in:sent -in:drafts -in:chats newer_than:30d` (sem
-- is:unread), então tudo fica re-listado até envelhecer 30 dias. Com ~centenas
-- de msgs/caixa, a fatia de 25s (INV-043) nunca chega ao fim → backlog perpétuo.
--
-- Fix (flag OFF por padrão — Caio liga após validar): prefetch em lote dos ids
-- já avaliados e reuso do nf/domínio cacheados; late-binding do match no banco
-- é preservado (roda toda rodada), só o fetch no Gmail some. Ver ADR 0015 e
-- _shared/gmail-poll-batch.ts.
--
-- skill: supabase-postgres-best-practices (aplicada manualmente — o pacote não
-- está instalado neste ambiente): idempotente (IF NOT EXISTS / ON CONFLICT);
-- RLS habilitada com service_role-only (menor privilégio — nenhum operador
-- precisa ler isto); PK composta gera o índice do lookup em lote; índice
-- funcional no messages_inbox pro prefetch de ingeridos; sem SECURITY DEFINER,
-- sem função nova.
-- =============================================================================
BEGIN;

-- 1. Memória de avaliação: 1 linha por (caixa, mensagem) não-casada já avaliada.
--    A PK composta (operador_id, gmail_message_id) É o índice do prefetch
--    `where operador_id = $1 and gmail_message_id in (...)`.
CREATE TABLE IF NOT EXISTS public.gmail_poll_msg_avaliada (
  operador_id                  uuid NOT NULL REFERENCES public.operadores(id) ON DELETE CASCADE,
  gmail_message_id             text NOT NULL,
  gmail_thread_id              text,
  -- nf/domínio extraídos do subject/from na 1ª avaliação (imutáveis por
  -- mensagem). Reusados no match do fallback sem re-fetchar o Gmail. NULL =
  -- e-mail sem NF no subject (personal/não-casável por essa via).
  nf_extraida                  text,
  dominio_remetente            text,
  -- scan divergente é "daqui pra frente" (enqueue-once): marca que já foi
  -- enfileirado pra não repetir a cada rodada.
  scan_divergente_enfileirado  boolean NOT NULL DEFAULT false,
  primeira_avaliacao_em        timestamptz NOT NULL DEFAULT now(),
  ultima_avaliacao_em          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operador_id, gmail_message_id)
);

COMMENT ON TABLE public.gmail_poll_msg_avaliada IS
  'Memória de avaliação do gmail-poll-inbox por mensagem não-casada (causa-2, '
  'Matheus 2026-07-23). Evita re-fetch no Gmail da mesma msg a cada rodada. NÃO '
  'guarda conteúdo do e-mail — só nf/domínio derivados pro match do fallback. '
  'Gated por feature_flags(gmail_poll_memo_avaliacao_ativo). Ver ADR 0015.';

-- Índice pro cleanup por idade (rows envelhecem junto com a janela de 30d do
-- poller; um cron pode apagar > 35d sem perder nada).
CREATE INDEX IF NOT EXISTS idx_gmail_poll_msg_avaliada_idade
  ON public.gmail_poll_msg_avaliada(primeira_avaliacao_em);

-- RLS: só service_role (edge functions) lê/escreve. Sem policy p/ authenticated
-- = deny por padrão (menor privilégio).
ALTER TABLE public.gmail_poll_msg_avaliada ENABLE ROW LEVEL SECURITY;

-- 2. Índice funcional pro prefetch de ingeridos: messages_inbox guarda o
--    gmail_message_id dentro do jsonb raw_payload (não é coluna top-level).
--    Sem esse índice, o prefetch `raw_payload->>'gmail_message_id' in (...)`
--    seria seq scan por chunk.
CREATE INDEX IF NOT EXISTS idx_messages_inbox_gmail_msg_id
  ON public.messages_inbox ((raw_payload->>'gmail_message_id'))
  WHERE raw_payload->>'gmail_message_id' IS NOT NULL;

-- 3. Feature flag — DESLIGADA. Comportamento do poller fica byte-idêntico ao
--    atual até o Caio validar em produção e ligar em 1 clique.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES (
  'gmail_poll_memo_avaliacao_ativo',
  false,
  'Memória de avaliação por mensagem no gmail-poll: para de re-fetchar no Gmail a mesma msg não-casada toda rodada (drena o backlog que travava em budget). OFF = comportamento atual. Matheus 2026-07-23, causa-2 / ADR 0015.'
)
ON CONFLICT (key) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at  = now();

COMMIT;
