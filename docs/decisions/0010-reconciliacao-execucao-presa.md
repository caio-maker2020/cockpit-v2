# ADR 0010 — Reconciliação de execução presa (card preso em EXECUTANDO_ACAO)

Data: 2026-06-29
Status: Aceito
Âncora: NF 296312 (oc 33 aprovada 28/06, nunca executada, ~2 dias presa em EXECUTANDO_ACAO)

## Contexto

`aprovar_e_executar` (RPC, mig 038/226) move o card para `EXECUTANDO_ACAO` e
enfileira a mensagem do executor (`pgmq.send('agent_executor', ...)`) **na mesma
transação**. O executor consome a fila e finaliza o card (`ACAO_EXECUTADA`) ou
falha (DLQ + `reverter_acao_falhou`).

**Causa raiz confirmada (H8):** o estado `EXECUTANDO_ACAO` e a execução real
estão desacoplados por uma fila *at-least-once*, **sem garantia de conclusão nem
reconciliação**. O DLQ só cobre erro **dentro** de um `processOne` que roda e
lança — NÃO cobre "mensagem lida mas não processada / perdida". Se a mensagem se
perde (gatilho transiente, raro: ~1 em 1.891 aprovações; mecanismo H6/H7 **não
confirmado** porque a mensagem e os logs do executor de 28/06 já não existem), o
card **congela para sempre**. O único monitor era o health-check, que apenas
**alerta** após 30min — sem auto-recuperação.

## Decisão

Tratar a **classe** de falha (não o gatilho não-confirmado) com duas camadas:

### 1. Observabilidade no executor (confirmar o gatilho na próxima ocorrência)
Logs estruturados por `msg_id/todo_id/card_id/read_ct/tool`: `mensagem_lida`,
`processamento_iniciado`, `processamento_concluido`, `processamento_falhou_retry`,
`processamento_falhou_final`, `mensagem_deletada`, `mensagem_arquivada_dlq`.
Um `msg_id` em `mensagem_lida` sem `processamento_concluido`/`falhou_*` = mensagem
perdida. **Sem mudança de comportamento.**

### 2. Reconciliador conservador (`reconciliar_execucoes_presas`, mig 279)
Batch RPC `SECURITY DEFINER` chamada por **pg_cron a cada 5min** (v1 é 100% SQL —
sem edge/HTTP; verificação SSW via HTTP fica para v2). Advisory lock transacional
(`pg_try_advisory_xact_lock`) evita runs concorrentes.

**NÃO é re-dispatch cego.** Candidato = card `EXECUTANDO_ACAO` + todo `aprovado` +
`approved_at` > 15min (threshold = 10× a latência normal) + cooldown de
re-enfileiramento. Decisão por **evidência** (não pelo status — o executor só sai
de `aprovado` após sucesso SSW/e-mail, então `aprovado` é candidato, não prova):

- **só-SSW, sem `sucesso=null`** (ex.: combo parcial oc33-feita/oc44-ausente) →
  **re-enfileira a MESMA mensagem/`todo_id`** → idempotência por-todo do envelope
  resolve (true=skip, false=retry, ausente=lança). Completa sem duplicar.
- **`acoes_executadas_ssw.sucesso=null` recente** → **aguarda** (em voo).
- **`sucesso=null` stale** (zumbi) → **reverte p/ humano** (não re-enfileira cego:
  o envelope abortaria e re-aprovar duplicaria a parte já lançada de um combo).
- **qualquer possibilidade de e-mail** (analisa o payload inteiro, não só o tool)
  → **reverte p/ humano** (v1 conservador; e-mail é idempotente por-todo, mas v1
  não auto-reenvia).
- **evento terminal existe / anti-loop (>2 re-enfileiramentos)** → **reverte**.

Reverter usa `reverter_acao_falhou` (ressuscita todos→pendente, card→AGUARDANDO
VOCÊ + `acao_falhou_motivo` com aviso de possível execução parcial).

card_events: `ExecucaoPresaDetectada` (só quando age — anti-spam),
`ExecucaoReenfileirada`, `ExecucaoRevertidaPorWatchdog`, `ExecucaoReconciliada`.

## Consequências

- Card preso em EXECUTANDO_ACAO passa a **auto-curar** em ≤ ~20min (cron 5min +
  threshold 15min) sem intervenção humana — para o caso 296312, sem nem chamar o time.
- Segurança contra duplicidade garantida pela idempotência **por-todo** do envelope
  (SSW) e do e-mail (`verificarEmailJaEnviado(todo_id)`); o reconciliador re-enfileira
  o **mesmo** `todo_id`.
- O gatilho transiente (H6/H7) continua **não confirmado** — a observabilidade vai
  cravá-lo na próxima ocorrência. Esta decisão trata a classe, não o gatilho.
- health-check: texto do alerta corrigido (a causa é executor/reconciliador, não Pass C).
- Guard: `_reconciliar_decidir` (função pura testável) + teste de integração
  (`supabase/tests/reconciliar-execucao-presa.test.sql`, ROLLBACK) + verify-cockpit **INV-031**.

## Alternativas descartadas
- **Re-dispatch cego de toda mensagem perdida** — risco de duplicar oc no SSW
  (viola idempotência) e re-enviar e-mail. Descartado.
- **Só observabilidade, sem reconciliador** — deixaria a classe de falha aberta
  (decisão explícita do Caio: H8 confirmada já justifica corrigir agora).
- **Edge function + verificação SSW síncrona em v1** — adia o fechamento da classe;
  os casos que exigiriam HTTP revertem p/ humano em v1 (sem perda de segurança).

## Arquivos
`migration/2026-06-29_279_watchdog_execucao_presa.sql` ·
`supabase/functions/executor/index.ts` (observabilidade) ·
`supabase/functions/health-check/index.ts` (texto) ·
`supabase/tests/reconciliar-execucao-presa.test.sql` ·
`.claude/commands/verify-cockpit.md` (INV-031).
