# ADR 0020 — Cobrança automática de cliente: removida de vez (produtor e consumidor)

Data: 2026-09-02
Status: Aceito (Caio: "a cobrança não pode voltar e não será automatizada")

## Contexto

A mig 168 (2026-05-26) "desativou a cobrança automática": desligou o cron
`cobranca-cliente-aguardando-daily` e cancelou 34 ações pendentes. Mas só o
produtor por cron morreu. Ficaram vivos:

- **Produtor no executor** (código de 05/05 e 08/05): após e-mail enviado
  inline com a oc, após "e-mail marcado como enviado manualmente", e após
  relançamento da 54, agendava `acoes_agendadas.tipo='cobranca_email'` D+4
  (rpc `agendar_cobranca_email` ou INSERT direto com origem `relancamento_54`).
- **Consumidor em processar-acoes-agendadas**: com e-mail de contato criava
  to-do "Reenviar cobrança" e movia o card pra validação humana; sem contato,
  gravava `CobrancaAdiadaSemContato`, lançava erro e a ação ficava pendente —
  retry a cada 5 min, pra sempre.

Medido em 02/09: 20 pendentes criadas de 27/08 a 02/09 (origem
`relancamento_54`), 14.542 eventos em 10 dias, 2.634 em 24h sobre 9 cards.
Nenhum e-mail de cobrança saiu sem humano (o caminho termina em proposta).

## Decisão

1. Executor deixa de agendar cobrança nos três caminhos. O evento
   `EmailMarcadoComoEnviadoManual` (auditoria) fica.
2. Processador perde o handler; qualquer `cobranca_email` remanescente é
   **cancelada** com motivo e evento, nunca processada.
3. Mig 375 cancela as pendentes (retroativo) com `CobrancaAutomaticaCancelada`
   por card, igual à 168.
4. Guard INV-137 no `/verify-cockpit`: zero callers no código, zero pendentes,
   zero eventos novos, nenhum cron ativo de cobrança.
5. A rpc `agendar_cobranca_email` fica no banco sem caller (inerte). Dropar é
   TIPO B destrutivo sem ganho; o guard cobre o retorno por código.
6. `sugerir-cobranca-ai` e `disparar-cobranca-escalonada` (botão manual
   "Cobrar X" da aba Prioridades, sem caller no front atual) não são
   re-deployadas. Retirada delas fica pra decisão à parte.

## Consequências

O to-do "Reenviar cobrança" deixa de existir. Se o time sentir falta, a
resposta não é religar isto — é desenhar de novo, com o Caio.
