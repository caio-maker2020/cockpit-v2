# Data model — Cockpit v2

Schema event-sourced. `card_events` é fonte da verdade; `cards` é projeção.

## Princípios

1. **Eventos são imutáveis.** Nunca update/delete em `card_events`.
2. **Projeção é reconstruível.** Em qualquer momento, posso jogar fora `cards` e recriar pelo replay de `card_events`.
3. **Audit_log captura efeitos externos** (SSW, WhatsApp, e-mail). Eventos capturam mudanças internas de estado.
4. **RLS por papel real.** Operador vê só cards do seu carteira; gestor vê tudo; service_role faz tudo.

## Tabelas core

### `card_events` (fonte da verdade)
```sql
id              uuid pk
card_id         uuid (fk cards) -- NULL pra eventos de criação
event_type      text -- enum em texto: 'MensagemEntrante', 'ClassificacaoConcluida', etc.
event_version   int  -- versionamento do schema do payload
payload         jsonb
actor_type      text -- 'agent', 'operator', 'system'
actor_id        text -- nome do agente ou user_id do operador
created_at      timestamptz default now()

INDEX (card_id, created_at)
INDEX (event_type, created_at)
```

### `cards` (projeção)
```sql
id                      uuid pk
nf                      text
ctrc                    text
canal_origem            text -- 'whatsapp', 'email', 'sistema'
remetente_inicial       text
empresa_cliente         text
nome_cliente            text
pagador                 text
base_destino            text
responsavel_relacionamento text

state                   text -- estado da máquina
agent_state             jsonb -- mini-FSM do agente especialista
tipo                    text -- 'reentrega', 'devolucao', etc.
risco                   text -- 'alto', 'baixo'

assigned_agent          text
assigned_operator_id    uuid

last_event_id           uuid (fk card_events)
last_event_at           timestamptz
created_at              timestamptz
updated_at              timestamptz

INDEX (state, last_event_at)
INDEX (nf)
INDEX (ctrc)
INDEX (assigned_operator_id, state)
INDEX (responsavel_relacionamento, state)
UNIQUE (nf, state) WHERE state NOT IN ('RESOLVIDO', 'CANCELADO') -- garante 1 card ativo por NF
```

### `messages_inbox` (entrada bruta)
```sql
id              uuid pk
card_id         uuid (fk cards) -- NULL antes de vincular
canal           text
remetente       text
conteudo        text
raw_payload     jsonb -- payload original do webhook
recebido_em     timestamptz
processed_at    timestamptz
processing_status text -- 'pending', 'processed', 'failed'

INDEX (processing_status, recebido_em)
INDEX (card_id, recebido_em)
```

### `agent_runs` (histórico de execução de agente)
```sql
id              uuid pk
card_id         uuid (fk cards)
agent_name      text
step_name       text
input           jsonb
output          jsonb
model           text -- 'claude-haiku-4-5', 'claude-sonnet-4-6', etc.
tokens_in       int
tokens_out      int
duration_ms     int
status          text -- 'success', 'error', 'timeout'
error_message   text
started_at      timestamptz
finished_at     timestamptz

INDEX (card_id, started_at)
INDEX (agent_name, started_at)
INDEX (status, started_at) WHERE status != 'success'
```

### `audit_log` (efeitos externos)
```sql
id                  uuid pk
card_id             uuid (fk cards)
action_type         text -- 'lancar_ocorrencia', 'enviar_whatsapp', 'enviar_email'
actor_type          text -- 'agent', 'operator', 'system'
actor_id            text
external_system     text -- 'ssw', 'evolution', 'resend'
idempotency_key     text UNIQUE -- evita execução dupla
request_payload     jsonb
response_payload    jsonb
status              text -- 'success', 'failed'
external_id         text -- protocolo SSW, message_id WhatsApp, etc.
created_at          timestamptz

UNIQUE (idempotency_key)
INDEX (card_id, created_at)
INDEX (external_system, status, created_at)
```

### `pendencias` (follow-ups agendados)
```sql
id              uuid pk
card_id         uuid (fk cards)
titulo          text
data_agendada   timestamptz
status          text -- 'pendente', 'concluida', 'cancelada'
created_at      timestamptz
INDEX (status, data_agendada)
INDEX (card_id)
```

### `todos` (ações propostas pelo agente, aguardando validação)
```sql
id              uuid pk
card_id         uuid (fk cards)
action_id       uuid -- referência ao evento `AcaoPropostaPeloAgente`
descricao       text
proposta_payload jsonb -- o que o agente quer executar (qual tool, com que params)
status          text -- 'pendente', 'aprovado', 'rejeitado', 'executado', 'expirado'
approved_by     uuid (fk operadores)
approved_at     timestamptz
rejection_reason text
created_at      timestamptz
INDEX (card_id, status)
INDEX (status, created_at) WHERE status = 'pendente'
```

### `operadores`
```sql
id              uuid pk
user_id         uuid (fk auth.users) UNIQUE
nome            text
email           text
papel           text -- 'operador', 'gestor'
carteira        text[] -- lista de empresas/CNPJs que esse operador atende
ativo           boolean default true
created_at      timestamptz
```

### `feature_flags`
```sql
key             text pk
enabled         boolean
description     text
updated_at      timestamptz
updated_by      uuid (fk operadores)
```

Exemplos de chaves:
- `agent_reentrega_enabled`
- `agent_devolucao_enabled`
- `auto_approve_rastreamento`
- `test_filter_only_caio` (legado)

## Filas (pgmq)

```sql
SELECT pgmq.create('agent_intake');       -- mensagens recém-recebidas pra triagem
SELECT pgmq.create('agent_specialist');   -- cards prontos pro agente especialista
SELECT pgmq.create('agent_executor');     -- ações aprovadas pra executar
SELECT pgmq.create('dead_letter');        -- jobs que falharam várias vezes
```

## Tabelas legacy (read-only)

```
legacy.mensagens
legacy.movimentacoes
legacy.todos
legacy.pendencias
legacy.historico
legacy.acoes
legacy.contatos
legacy.operadores
```

Importadas do backup do v1. **Nunca** escrever. Servem como:
1. Dataset de eval (mensagens reais com classificações que a IA fez).
2. Migração de cards ativos durante cutover.

## RLS — estratégia

```sql
-- cards
CREATE POLICY "operador vê só sua carteira"
  ON cards FOR SELECT TO authenticated
  USING (
    assigned_operator_id = (SELECT id FROM operadores WHERE user_id = auth.uid())
    OR (SELECT papel FROM operadores WHERE user_id = auth.uid()) = 'gestor'
  );

-- card_events: operador lê eventos dos cards que vê
-- todos: idem
-- audit_log: só gestor lê via UI; operador não acessa direto
-- agent_runs: só gestor (operador não precisa)
```

Service role (Edge Functions) bypassa RLS.

## Indexes a criar depois (com volume real)

- GIN em `card_events.payload` se houver query frequente
- `pgvector` em `cards.embedding` pra KB / RAG (futuro)
- Particionamento de `card_events` por mês quando passar de 1M linhas
