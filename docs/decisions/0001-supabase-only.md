# ADR 0001 — Backend 100% Supabase, sem Inngest/Vercel

**Data:** 2026-04-28
**Status:** Aceito

## Contexto

Para sistema de agentes autônomos precisamos de orquestração com workflows duráveis, retry, observabilidade. Inngest/Trigger.dev/Temporal resolvem isso com excelência. Mas adicionam mais 1 provedor (dashboard, chave, billing, conceitos) ao stack.

Caio (mantenedor único, sem time de dev) pediu pra estressar a opção de manter tudo no Supabase, alegando que múltiplos provedores aumentam complexidade operacional.

## Decisão

Backend 100% Supabase: Postgres + Auth + Realtime + Edge Functions + pgmq (Supabase Queues) + pg_cron.

Construímos mini-orquestrador interno com:
- `pgmq` pra filas duráveis entre etapas.
- Edge Functions curtas (≤150s) acionadas por cron (consumindo pgmq) ou por webhook.
- Workflows complexos quebrados em **steps**, cada step uma Edge Function que consome 1 mensagem da fila e enfileira a próxima.
- Estado dos workflows em tabelas (`agent_runs`, `cards.agent_state`).
- Retry e backoff implementados em código.

## Alternativas consideradas

### Inngest (recomendação técnica original)
- **Pró:** workflows duráveis prontos, dashboard de runs, eventos, retry, cron, observabilidade ótima.
- **Contra:** mais um provedor, mais um billing, mais um conceito pra Caio dominar.
- **Por que rejeitada agora:** custo cognitivo > benefício no MVP. O sistema do Caio cabe em Edge Functions de 150s + pgmq. Reconsiderar quando workflows precisarem esperar dias ou orquestração ficar grande.

### Trigger.dev / Temporal
- Mesma análise. Temporal especialmente: maduro mas pesado.

### Next.js + Vercel + Inngest
- Plano original. Recusado pelo mesmo motivo: 3 provedores em vez de 1.

## Consequências

**Aceitas:**
- ~300-500 linhas de código de orquestração serão escritas (não vêm de graça do framework).
- Sem dashboard nativo de "essa run falhou no step 3, retry em 30s" — vamos consultar tabela.
- Edge Function fria pode ter cold start de 1-2s em volume baixo.
- Limite de 150s é teto duro: workflow longo = quebrar em steps.

**Mitigadas:**
- Construir uma view materializada `agent_runs_summary` pra observabilidade básica.
- pg_cron tem granularidade de minuto — pra polling de fila tá ótimo.

## Gatilhos pra reconsiderar

Adotar Inngest se:
- Estamos mantendo >500 linhas só de "código de orquestração" (retry, timeout, dedupe, fan-out).
- Workflow precisa esperar **dias** por evento externo (durabilidade real).
- Temos >5 agentes e perdemos tempo debugando "qual rodou quando".
- Aparece necessidade de fan-out/fan-in (paralelizar 10 sub-tarefas e agregar resultado).

Quando reconsiderar, adicionar Inngest **só pra orquestração**, manter Supabase pra DB/Auth/Realtime.
