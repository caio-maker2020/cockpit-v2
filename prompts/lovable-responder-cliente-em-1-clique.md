# Lovable — Responder cliente em 1 clique (oc=21/44/55)

## Contexto

Hoje quando o cliente responde autorizando reentrega, devolução ou entrega parcial, o operador aprova a oc correspondente (21/44/55) no modal do card. A oc é lançada no SSW mas a thread Gmail do cliente fica sem retorno — o cliente fica sem confirmação de que o processo vai seguir.

A feature: o modal de aprovação dessas 3 ocs ganha um bloco "Responder cliente por email" com checkbox ON por default + textarea editável. 1 confirmação = lança a oc no SSW + envia email respondendo a thread.

Backend já está pronto (mig 171 + executor deployed). Falta só o front.

## Critérios de exibição do bloco

Mostrar o bloco "Responder cliente por email" no modal de aprovação SE TODAS:

1. `proposta_payload.args.codigo_ssw ∈ {21, 44, 55}`
2. `cards.cliente_respondeu_em != null` (cliente respondeu na thread)
3. Existe pelo menos 1 row em `messages_inbox` para esse `card_id` com `canal='email'` (pode pré-checar via query rápida ou simplesmente confiar no `cliente_respondeu_em`)

Se algum critério falhar, NÃO mostrar o bloco (mantém modal como hoje).

## UI

```
┌─────────────────────────────────────────────┐
│ [✓] Responder cliente por email             │
│                                             │
│ Assunto: Re: NF {nf}   (não editável)       │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ Ok pessoal, iremos seguir com a         │ │
│ │ reentrega o mais rápido possível.       │ │
│ │                                         │ │
│ └─────────────────────────────────────────┘ │
│   (editável pelo operador)                  │
│                                             │
│ Enviado em resposta à última mensagem do    │
│ cliente — mantém a mesma conversa Gmail.    │
└─────────────────────────────────────────────┘
```

- Checkbox marcado por DEFAULT (operador pode desmarcar).
- Textarea pré-preenchida com o texto do template correspondente, substituindo `{saudacao}` por `pessoal`:
  - oc=21 → template `RESPOSTA_AUTORIZA_REENTREGA`
  - oc=44 → template `RESPOSTA_AUTORIZA_DEVOLUCAO`
  - oc=55 → template `RESPOSTA_AUTORIZA_ENTREGA_PARCIAL`
- Buscar o texto via `supabase.from('templates_email').select('corpo_template').eq('id', <template_id>)`. Cache local depois do 1º fetch.
- Substituição local de `{saudacao}` → `pessoal` (front não precisa renderizar `{nf}` no corpo — o backend não usa o corpo do template direto, usa o que o operador editou).

## Payload de aprovação

Quando operador clica "Aprovar":

```ts
const respThread = checkboxMarcado
  ? { enviar: true, corpo: textareaValue.trim() }
  : { enviar: false };

await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: {
    // ... outros extras que já existem (anexos_ids, skip_email, etc.)
    responder_thread_cliente: respThread,
  },
});
```

A RPC `aprovar_e_executar` já mergeia `p_extras` em `proposta_payload.args.extras` automaticamente — não precisa mudança no backend além do que já foi feito.

## Comportamento backend (já implementado)

- Após a oc ser lançada com sucesso no SSW, o executor lê `extras.responder_thread_cliente`.
- Se `enviar=true` e `corpo` não-vazio: busca a última `messages_inbox` do card, monta In-Reply-To/References + threadId Gmail e envia via Gmail OAuth do operador respondendo a mesma conversa.
- Best-effort: se o envio do email falhar, oc segue lançada normalmente e o erro vai pra `card_events.event_type='RespostaConfirmacaoNaoEnviada'`. Operador pode responder manual pelo composer existente.
- Sucesso registra `card_events.event_type='RespostaConfirmacaoEnviada'` + linha em `cards_emails_outbound` (com `gmail_thread_id` pra rastrear).

## Smoke test

1. Card com oc=10/11/35 + cliente respondeu email autorizando reentrega.
2. Operador abre proposta oc=21, vê o bloco novo com texto "Ok pessoal, iremos seguir com a reentrega o mais rápido possível."
3. Operador aprova sem editar.
4. Verificar:
   - oc=21 lançada no SSW (`audit_log` linha nova com sucesso).
   - Card vai pra `ACAO_EXECUTADA`.
   - `card_events` tem `RespostaConfirmacaoEnviada` com `gmail_message_id` preenchido.
   - Cliente recebe email na mesma thread Gmail.
5. Repetir desmarcando o checkbox → oc é lançada mas nenhum email vai (sem `RespostaConfirmacao*` event).
