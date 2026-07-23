# 0015 — Memória de avaliação por mensagem no gmail-poll (causa-2)

Data: 2026-07-23
Status: Aceito (flag OFF por padrão — ligar após validação em produção)
Autor: Matheus

## Contexto

O `gmail-poll-inbox` lista, a cada rodada de 5 min, todas as mensagens de
`-in:sent -in:drafts -in:chats newer_than:30d` (até 500/caixa, **sem** filtro
`is:unread` — removido em 2026-05-15 porque operador abria a msg antes do poll).
Mensagem que **não casa** com um card retorna sem ser marcada de forma alguma,
então permanece na lista e é **re-avaliada do zero toda rodada**, por 30 dias.

Cada re-avaliação de mensagem não-casada dispara `getMensagemMetadata`
(roundtrip ao Gmail) para tentar o fallback NF+domínio e o scan divergente.

### Evidência de produção (2026-07-23, `gmail_polling_state`)

- **`history_id` NULL em todas as 10 caixas** — o sync incremental que o schema
  previu (migration `2026-05-06_060`) nunca foi ligado.
- **Toda caixa fecha a rodada com `last_error: "backlog: NNN msgs não
  processadas (budget)"`**: sac 436, julia 427, larissa 410, auto.pecas 402,
  ferramentas 387, victor 348, karoline 160.
- **`last_success_at` travado em junho** para larissa/ferramentas/victor/
  auto.pecas — caixas sem uma rodada limpa há ~1 mês.

O rodízio justo (INV-043) impediu starvation total, mas o backlog não drena: a
fatia de 25s/caixa nunca alcança o fim de uma lista de ~centenas re-mastigadas.

## Decisão

Adicionar uma **memória de avaliação por mensagem** (`gmail_poll_msg_avaliada`)
para não re-fetchar no Gmail a mesma mensagem não-casada a cada rodada.

Por rodada, com a flag `gmail_poll_memo_avaliacao_ativo` ligada, o poller faz
prefetch em lote (padrão do PR #24) de:
1. `gmail_message_id`s já ingeridos em `messages_inbox` → pula sem fetch;
2. `gmail_message_id`s já avaliados sem match (memo) → **reusa nf/domínio
   cacheados** e re-roda **só o match no banco**, sem fetch ao Gmail.

O scan divergente vira **enqueue-once** (só na 1ª avaliação; o helper é "daqui
pra frente").

## Por que NÃO o `history_id` (users.history.list)

Era o "fix profundo" sugerido. Rejeitado por ora porque **muda o conjunto de
mensagens listadas** (delta desde o último `historyId`), o que carrega risco de
regressão na captura de resposta de cliente (o `messageAdded` é visto uma vez;
mensagem cliente-iniciada que só casa depois de um outbound posterior poderia
ser perdida) — e não pode ser validado neste ambiente. A memória de avaliação
ataca a mesma raiz (falta de memória entre rodadas) **preservando byte-a-byte o
comportamento de match atual** — só remove o fetch redundante.

## Consequências / garantias anti-regressão

- **Flag OFF por padrão**: `memo undefined` ⇒ caminho byte-idêntico ao atual.
  Rollback é 1 clique.
- **Late-binding preservado**: match por thread (prefetch) e por NF+domínio
  (query no banco) rodam TODA rodada, inclusive em re-avaliação.
- **Prefetch blindado**: se cair, a rodada segue sem memo (comportamento atual).
- **Privacidade**: a tabela guarda só nf/domínio derivados — nunca conteúdo.
- **Guards**: `gmail-poll-batch.test.ts` (helpers puros) + item no
  `/verify-cockpit`. Migration `2026-07-23_306`.
- **Follow-up**: cron de limpeza de linhas > 35d (índice
  `idx_gmail_poll_msg_avaliada_idade` já criado). O `history_id` continua na
  mesa como otimização futura, agora sem ser caminho crítico de captura.

## Como validar (Caio, pós-deploy)

1. Deploy da função (deploy-gate) com a migration 306 aplicada.
2. Ligar `gmail_poll_memo_avaliacao_ativo`.
3. Observar em `gmail_polling_state`: `last_error` de backlog encolhendo e
   `last_success_at` voltando a avançar (rodada completa) nas caixas pesadas.
4. Confirmar que nenhuma resposta de cliente deixou de ser capturada no A/B.
