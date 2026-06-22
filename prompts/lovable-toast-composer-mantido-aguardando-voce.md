# Lovable — Composer de resposta ao cliente: avisar quando o card permanece em AGUARDANDO VOCÊ

## Contexto

No Cockpit, quando a operadora responde o cliente pelo **composer de e-mail** (dentro do card), o front chama a edge function `responder-email-cliente`.

Mudou uma regra no backend (invariante): a aba **AGUARDANDO CLIENTE só pode conter cards com a última ocorrência = 54**. Se a operadora responde o e-mail mas a última ocorrência do card **não é 54** (ex.: oc=19, 49, 20 — ocorrências de relacionamento ainda não lançadas no SSW), o card **NÃO** vai mais pra AGUARDANDO CLIENTE: ele **permanece em AGUARDANDO VOCÊ** (locked, com as propostas), porque a operadora ainda precisa **lançar a ocorrência de fato** pra tratar o caso. O e-mail é enviado normalmente nos dois casos.

## O que o backend agora retorna

A resposta da edge function `responder-email-cliente` ganhou 2 campos novos:

```json
{
  "ok": true,
  "gmail_message_id": "...",
  "thread_id": "...",
  "from": "...",
  "to": "...",
  "cc": ["..."],
  "permaneceu_em_aguardando_voce": true,   // NOVO — true quando oc≠54
  "cod_ultima_ocorrencia": 19              // NOVO — a última ocorrência do card
}
```

## O que fazer no front

No fluxo de sucesso do envio pelo composer (quando `ok === true`):

1. **Se `permaneceu_em_aguardando_voce === false`** (caso normal, oc=54):
   - Mantém o comportamento atual: toast de sucesso ("E-mail enviado") e o card sai da aba AGUARDANDO VOCÊ / vai pra AGUARDANDO CLIENTE.

2. **Se `permaneceu_em_aguardando_voce === true`** (oc≠54):
   - Mostrar um toast **de atenção** (cor de aviso, não erro), com texto:
     > **E-mail enviado.** Mas o card continua em **AGUARDANDO VOCÊ** porque a ocorrência **{cod_ultima_ocorrencia}** ainda precisa ser lançada no SSW. Responder o cliente não trata a ocorrência — escolha uma das propostas do card para lançá-la.
   - **NÃO** remover o card da aba AGUARDANDO VOCÊ otimisticamente. Fazer refresh/refetch do card para refletir que ele continua ali (locked, com as propostas pendentes).

## Observação

Não precisa de mudança de tabela/RPC/coluna — é só ler os 2 campos novos da resposta da function `responder-email-cliente` e ajustar o toast + o refresh do card. Nenhum outro fluxo muda.
