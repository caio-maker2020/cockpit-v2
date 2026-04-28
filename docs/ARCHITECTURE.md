# Arquitetura — Cockpit v2

## Princípios inegociáveis

1. **Card como agregado event-sourced.** Toda mudança de estado é evento. Estado atual é projeção dos eventos. Sem isso, não há auditoria nem caminho pra remover validação humana.
2. **Adapters externos com retry + idempotência.** Agente nunca fala com SSW/Evolution/Resend direto.
3. **Fila durável entre etapas.** Mensagem entrante e ação de agente atravessam pgmq.
4. **Validação humana é estado explícito.** Não é "campo `aprovado bool`". É transição de estado registrada.
5. **Prompts versionados em arquivo.** Mudança de prompt = commit + rodar evals.
6. **Determinismo onde der.** LLM decide *quando/se*, código decide *como*. Reduz custo e variância.

## Stack

| Camada | Tecnologia | Justificativa |
|---|---|---|
| UI do operador | Lovable (mantido por enquanto) | Já existe, funciona pro propósito interno. ADR 0001. |
| Banco / Auth / Realtime / Filas / Cron | Supabase (Postgres + pgmq + pg_cron + Edge Functions) | 1 provedor só, mínima superfície operacional. ADR 0001. |
| LLM | Claude (Anthropic API) via SDK direto | Sem LangChain/LangGraph — abstração leaky. SDK + roteamento de modelo. |
| WhatsApp | Evolution API em VPS dedicada | Uso interno; produção precisa de instância dedicada e backup. |
| E-mail saída | Resend | Substitui Apps Script (frágil, baixa observabilidade). |
| E-mail entrada | Postmark inbound webhook | Substitui Apps Script trigger. |
| TMS | SSW REST via `lib/ssw-client.ts` | Adapter próprio com retry + cache de token + idempotency key. |
| Pendências | Bastão (Supabase externo) | Espelho de ocorrências do SSW; mantido enquanto não houver fonte direta confiável. |

## Diagrama lógico

```
┌──────────────┐  ┌──────────┐  ┌──────────────┐
│ WhatsApp     │  │ E-mail   │  │ Bastão       │
│ (Evolution)  │  │(Postmark)│  │ (sync 20min) │
└──────┬───────┘  └─────┬────┘  └──────┬───────┘
       │ webhook        │ webhook       │ pg_cron
       ▼                ▼               ▼
       ┌──────────────────────────────────────┐
       │  Edge Function: ingestor             │
       │  → normaliza → publica em pgmq       │
       └──────────────────┬───────────────────┘
                          │ enqueue
                          ▼
                ┌──────────────────────┐
                │  pgmq: agent_intake  │
                └──────────┬───────────┘
                           │
                           ▼
       ┌──────────────────────────────────────┐
       │  Edge Function: triador (Haiku)      │
       │  → classifica tipo + risco           │
       │  → extrai NF/CTRC                    │
       │  → escreve card_events               │
       └──────────────────┬───────────────────┘
                          │
                          ▼
       ┌──────────────────────────────────────┐
       │  Edge Function: vinculador           │
       │  → 6 prioridades de dedup            │
       │  → vincula a card existente OU cria  │
       │  → publica em agent_specialist       │
       └──────────────────┬───────────────────┘
                          │ enqueue
                          ▼
                ┌──────────────────────────┐
                │  pgmq: agent_specialist  │
                └──────────┬───────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  ┌──────────┐       ┌──────────┐       ┌──────────┐
  │ Reentrega│       │ Devolução│       │  Avaria  │ ...
  │ (Sonnet) │       │ (Sonnet) │       │ (Sonnet) │
  └─────┬────┘       └────┬─────┘       └────┬─────┘
        │                 │                  │
        └─── tools: ssw-client, evolution-client, resend-client, kb ───┘
                          │
                          ▼
       ┌──────────────────────────────────────┐
       │  Card transitiona para:              │
       │  AGUARDANDO_VALIDACAO_HUMANA         │
       └──────────────────┬───────────────────┘
                          │ aparece no Lovable
                          ▼
                    ┌──────────────┐
                    │   Operador   │
                    │   aprova/    │
                    │   rejeita    │
                    └──────┬───────┘
                           │ aprova → publica em agent_executor
                           ▼
                ┌──────────────────────┐
                │  pgmq: agent_executor│
                └──────────┬───────────┘
                           ▼
       ┌──────────────────────────────────────┐
       │  Edge Function: executor             │
       │  → chama SSW/Evolution/Resend        │
       │  → registra audit_log                │
       │  → escreve card_events de fechamento │
       └──────────────────────────────────────┘
```

## Fluxo end-to-end (exemplo: cliente autoriza devolução)

1. Cliente responde e-mail "ok, podem devolver" → Postmark inbound → `ingestor`.
2. `ingestor` normaliza → enfileira em `agent_intake`.
3. `triador` classifica: `tipo=devolucao_autorizada`, `risco=baixo`. Escreve evento `MensagemRecebida`.
4. `vinculador` acha card existente da NF 26523 (prioridade NF). Escreve evento `MensagemAnexada`. Card transita pra `AGUARDANDO_AGENTE`.
5. Enfileira em `agent_specialist` com `agent=devolucao`.
6. `agente_devolucao` lê contexto do card, valida que autorização é legítima, propõe ação `lancar_ocorrencia_dev` + `notificar_cliente_inicio_processo`. Card → `AGUARDANDO_VALIDACAO_HUMANA`.
7. Operador vê no Lovable, aprova com 1 clique → evento `AcaoAprovada`. Enfileira em `agent_executor`.
8. `executor` chama SSW Adapter (idempotency key = `card_id:codigo:DEV`) → ocorrência lançada → protocolo retornado. Chama Resend pra enviar e-mail. Escreve `audit_log` + evento `AcaoExecutada`. Card → `AGUARDANDO_TERCEIRO` (esperando ocorrência DEV refletir no Bastão).
9. Sync Bastão (20min) detecta ocorrência DEV concluída → evento `OcorrenciaSSWConfirmada` → card → `RESOLVIDO`.

## Por que NÃO Inngest/Vercel agora

ADR 0001 detalha. TL;DR: 1 provedor (Supabase) reduz superfície operacional. Edge Function + pgmq + pg_cron cobre 90% do que precisamos. Workflows complexos quebram em steps curtos. Reconsiderar quando workflow precisar esperar dias por evento ou orquestração ficar grande.

## Observabilidade

- **Logs:** Supabase logs nativos (Edge Functions + Postgres).
- **Erros:** Sentry (frontend + Edge Functions).
- **Auditoria:** tabela `audit_log` consultável via SQL.
- **Workflow:** view materializada `agent_runs_summary` agregando `agent_runs` por agente/dia.
- **Métricas de produto:** view `metrics_daily` com tempo médio resposta, taxa aprovação, etc.

## Custo estimado (uso interno)

| Item | Mensal |
|---|---|
| Supabase Pro | $25 |
| Anthropic API (Haiku + Sonnet) | $50–200 (depende de volume) |
| Evolution VPS (Hetzner) | $8–20 |
| Resend (10k e-mails) | $20 |
| Postmark inbound | $15 |
| Sentry | $0 (free tier) |
| **Total** | **~$120–280** |
