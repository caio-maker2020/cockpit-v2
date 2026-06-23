# Lovable — "54 + email" quando o cliente não tem e-mail cadastrado: exigir destinatário no modal

## Contexto (o que mudou no backend)

Antes, quando o pagador **não tinha e-mail cadastrado**, a opção "Lançar oc 54 + email"
era **rebaixada** pra "54 sem email" e a operadora perdia a chance de notificar o
cliente. Agora o backend **mantém a opção "54 + email"** mesmo sem contato — só que
**sem destinatário pré-preenchido**. A operadora informa o e-mail no modal e:

1. o e-mail é enviado normalmente (template do oc) e a oc 54 é lançada no SSW;
2. o backend **auto-cadastra** esse e-mail em `contatos_cliente` → nos **próximos**
   cards desse cliente a opção já vem com o destinatário preenchido.

Caso âncora: NF 59354, pagador MEDH DISTRIBUIDORA (CNPJ 18917657000183), oc=20.

## Como identificar essas propostas (todos)

A proposta vem da tabela `todos`, em `proposta_payload`:

- `proposta_payload.tool === "lancar_oc_e_enviar_email"` **E**
- `proposta_payload.meta?.precisa_email_destino === true`
  - (equivalente: `proposta_payload.args.email_destino` ausente/vazio)
- `proposta_payload.args.template_id` → template do e-mail (ex.: `"FALTA_DE_VOLUME"`,
  `"RECUSA_TOTAL"`, `"PROBLEMAS_COM_ENDERECO"`, `"RECUSA_PARCIAL"`)
- `descricao` termina com `(informe o e-mail do cliente no envio)`

Quando `precisa_email_destino` é `true`, **não há destinatário** — o composer **deve
EXIGIR** que a operadora digite pelo menos 1 e-mail antes de aprovar.

> Observação: continua existindo, lado a lado, a opção **"Lançar SÓ oc 54 (sem email)"**
> (`proposta_payload.meta.sem_email_explicito === true`, `tool === "lancar_ocorrencia"`).
> Essa lança a oc sem notificar — usar quando o cliente já foi avisado por outro canal.
> NÃO pedir e-mail nessa.

## Comportamento esperado no modal de e-mail (composer)

1. Abrir o composer normalmente (assunto/corpo do template já renderizam pelo backend).
2. Campo **"Para" (destinatário)**:
   - quando `precisa_email_destino === true`: começa **vazio**, com placeholder/aviso
     **"Cliente sem e-mail cadastrado — informe o destinatário"**;
   - permitir 1+ e-mails (o 1º vira TO, os demais CC);
   - **validação obrigatória**: bloquear o botão "Aprovar e enviar" enquanto não houver
     pelo menos 1 e-mail válido (`regex` simples de e-mail). Mensagem de erro clara.
3. Demais campos (assunto, corpo, anexos) seguem como já são hoje.

## Como aprovar (RPC)

Usar a RPC existente (via `supabase.rpc`, nunca `fetch`):

```ts
await supabase.rpc("aprovar_e_executar", {
  p_todo_id: todo.id,
  p_extras: {
    email_destinatarios: emailsDigitados, // string[] — [0] = TO, demais = CC
    // (opcionais já suportados) assunto_override, texto_email_customizado,
    // template_id_override, anexos_ids
  },
});
```

O backend (`executor`) lê `extras.email_destinatarios`, envia o e-mail **antes** de
lançar a oc 54 (atomicidade: se o e-mail falha, a oc não é lançada) e cadastra o
e-mail do TO em `contatos_cliente` pros próximos cards.

## Critérios de aceite

- [ ] Card de oc relacionamento de cliente **sem e-mail cadastrado** mostra a opção
      **"Lançar oc 54 + email"** (não some, não vira só "sem email").
- [ ] Ao clicar nela, o composer **exige** o destinatário; não dá pra aprovar vazio.
- [ ] Aprovando com o e-mail digitado: e-mail sai + oc 54 lançada; no **próximo** card
      do mesmo cliente o destinatário já vem preenchido (auto-cadastro).
- [ ] A opção "Lançar SÓ oc 54 (sem email)" continua disponível e **não** pede e-mail.
