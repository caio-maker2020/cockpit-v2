# ADR 0002 — Card como agregado event-sourced

**Data:** 2026-04-28
**Status:** Aceito

## Contexto

No v1 (Cockpit Lovable), o card é uma linha na tabela `mensagens` que mistura:
- Conteúdo da mensagem original
- Estado do card
- Metadata (tipo, risco, NF, CTRC, pagador, etc.)
- Thread de mensagens embutida em jsonb (`mensagens_thread`)
- Status duplo (`status`, `status_problema`, `status_comunicacao`)

Mudanças de estado parcialmente registradas em `movimentacoes` (só transição de `status_problema`). Outros efeitos (envio de mensagem, lançamento SSW) só em `historico` ou `acoes`. Nada amarrado.

Para sistema com agentes autônomos lançando ocorrências e enviando mensagens sem humano, precisamos:

1. **Auditoria completa.** "Por que esse cliente recebeu essa mensagem?" tem que ter resposta exata em <1min.
2. **Replay.** Conseguir reconstruir estado do card pra debug ou pra rerodar agente em modo dry-run.
3. **Caminho pra remover validação humana.** Sem rastro estruturado, não dá pra medir taxa de acerto e bater o critério de auto-aprovação.

## Decisão

Adotar **event sourcing** pro card:

- `card_events` é a fonte da verdade (append-only, imutável).
- `cards` é projeção mantida via triggers ou aplicação.
- Toda transição de estado escreve evento.
- Toda ação externa (SSW, WhatsApp, e-mail) escreve linha em `audit_log` com `idempotency_key`.

## Alternativas consideradas

### Manter modelo do v1 (linha mutável)
- **Pró:** simples, conhecido, já existe.
- **Contra:** débito técnico vira pesadelo em 6 meses. Auditoria virou consulta a 4 tabelas. Replay impossível.
- **Rejeitada.**

### CQRS completo
- Separar comando e query, projeções múltiplas, etc.
- **Contra:** overkill pro tamanho do problema.
- **Rejeitada por agora**, mas o caminho fica aberto (event sourcing é pré-requisito).

## Consequências

**Aceitas:**
- Schema mais complexo no início (5+ tabelas em vez de 1).
- Lógica de aplicação tem que escrever eventos consistentemente — disciplina.
- Migração de dados do v1 fica **mais trabalhosa** (precisa transformar linhas em sequência de eventos sintéticos OU descartar histórico operacional).

**Ganhas:**
- Auditoria trivial: `SELECT * FROM card_events WHERE card_id = X ORDER BY created_at`.
- Debug de comportamento de agente: pego o input do step e replay.
- Métrica de taxa de aprovação por tipo de ação sai de query simples.
- Caminho claro pra auto-aprovação: feature flag + critério mensurável.

## Como aplicar (regras)

1. **Nunca atualizar `cards` sem evento.** Triggers garantem ou rejeitam.
2. **Eventos versionados** (`event_version` int) — schema de payload pode evoluir.
3. **Projeção determinística** — dado o mesmo log de eventos, projeção deve dar mesmo resultado.
4. **Adapters externos sempre escrevem `audit_log`** com `idempotency_key` única.
5. **Nunca delete eventos.** Cancelamento é evento de cancelamento, não delete.

## Gatilho pra reconsiderar

Não há gatilho razoável pra abandonar event sourcing depois de adotado — seria refactor traumático. Se a complexidade ficar pesada, considerar **simplificações** (menos tipos de evento, projeção mais agressiva) antes de abandonar o padrão.
