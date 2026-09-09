# ADR 0028 — Threading de e-mail com Outlook/Exchange: Message-ID real, âncora sem fantasma, assunto byte-a-byte

- **Status:** aceito (implementado na branch `fix/email-thread-outlook`; merge só com autorização do Carlos)
- **Data:** 2026-09-09
- **Autores:** Carlos (decisão), Claude (diagnóstico e implementação)
- **Relacionados:** INV-084 (verify-cockpit), fix 2026-08-18 (`f7c4d9d`, assunto fiel + Thread-Index), memória `gmail-reescreve-message-id-outlook-thread`

## Contexto

BBIOMEDICAL, BR PARTS, NORTEL/SONEPAR e WURTH relataram que respostas enviadas pelo
Cockpit chegam no Outlook como **conversa nova**, fora da thread original. O fix de
18/08 (não empilhar "Re:" e ecoar `Thread-Index`) estava em produção e funciona na
maioria dos casos, mas a queixa persistiu.

## Evidências (banco de produção + cópia real em Enviados, 09/09)

1. **O Gmail API reescreve o `Message-ID`.** O `gmail-sender` gerava
   `cockpit-<uuid>@salexpress.com.br` e gravava em
   `cards_emails_outbound.message_id_header`. No fio (raw do Gmail) a mensagem sai
   com `<CA...@mail.gmail.com>`. Prova em massa: desde 18/08, 0 de 6.933 inbounds
   têm `In-Reply-To` começando com `cockpit-`; 286 têm `cockpit-` só dentro de
   `References` (o cliente copia a nossa cadeia). Todo In-Reply-To montado com o id
   fantasma apontava para uma mensagem inexistente.
2. **Com `Thread-Index` ecoado o Exchange mantém a conversa**: 171 de 175 respostas
   do composer e 69 de 73 do executor (medido pelo prefixo de 22 bytes do
   `Thread-Index` da resposta seguinte do mesmo remetente).
3. **Sem âncora nenhuma → conversa nova.** Cenário WURTH (NF 683869, 682643): o
   executor manda o 2º/3º e-mail proativo na mesma thread sem o cliente ter
   respondido. Sai In-Reply-To fantasma, sem Thread-Index (não há inbound),
   assunto "Re: Insucesso…"; o gateway da Wurth prefixa "[EXTERNAL] " e o tópico
   deixa de bater. 130 envios nessa situação desde 18/08 (13 para a Wurth); mais
   300 com inbound cujo Thread-Index não foi capturado.
4. **Assunto alterado racha a conversa.** `garantirPrefixoReply` fazia `trim()`.
   NF 7481 (BIOMEDICAL): cliente mandou " Recusa Total — …" (espaço inicial), nós
   devolvemos "Re: Recusa Total — …" e o Outlook dela abriu conversa nova. Em 7 de 7
   respostas com espaço duplo/triplo no assunto o cliente devolveu com espaço
   simples e conversa nova (o colapso é do lado Exchange; o fio confirma que o
   Gmail preserva os espaços).
5. `scan-email-pre-card` não gravava `thread_index` (592/592 inbounds sem).
6. O Subject saía numa única encoded-word RFC 2047 de 128+ chars (limite é 75).

## Decisão

1. **Nunca gerar Message-ID próprio.** Após o `send`, ler o Message-ID real via
   `messages.get?format=metadata` e persistir em `message_id_header`. Falha na
   leitura → `null` (o envio já saiu; o próximo e-mail ancora no inbound).
2. **Ids `cockpit-…` são fantasmas e nunca viram header.** `withAngleBrackets` e
   `normalizeReferencesHeader` os descartam. A âncora do In-Reply-To passa a ser a
   mensagem mais recente da thread com id real (`escolherAncoraThread`, função
   pura), e o `Thread-Index` vem do último inbound **dessa** thread.
3. **Assunto byte-a-byte.** Sem `trim()`; só prefixa "Re: " quando não há prefixo
   algum. Subject codificado em encoded-words de até 75 chars, em fronteira de
   caractere UTF-8, dobradas com CRLF+SP; ASCII puro vai sem codificar.
4. **Thread-Index capturado em todo escritor de `messages_inbox`**
   (`gmail-poll-inbox`, `scan-email-pre-card`, `buscar-cce-gmail`; o `ingestor`
   Postmark já expõe o header em `raw_payload.Headers`).
5. **Executor grava o assunto realmente enviado** em `card_events` e em
   `cards_emails_outbound` (`subject_template` preserva o do template).
6. **Sem retroativo agora.** As 2.753 linhas com id fantasma ficam; a regra 2 já
   as ignora. Reavaliar em uma semana pela consulta de validação; se necessário,
   job TIPO B só nos cards abertos.

## Consequências

- Uma chamada Gmail extra por envio (`messages.get`), best-effort.
- O vinculador passa a conseguir casar `message_id_header` real (hoje nunca casa).
- Casos fora do nosso controle continuam existindo: cliente que edita o assunto,
  encaminha ("ENC:"), responde de caixa que não tem a mensagem original, ou cujo
  gateway insere marcador no assunto quando não há Thread-Index para ancorar.
- `enviar-resposta` (consumidor da fila `respostas_envio`, sem uso pelo fluxo atual)
  não foi alterado: ainda codifica o Subject do jeito antigo e não manda headers de
  thread. Se voltar a ser usado, deve migrar para `sendGmailMessage`.

## Validação

- Guard INV-084 estendido no `/verify-cockpit`; testes `email-mime.test.ts` e
  `email-threading.test.ts` (22 casos, âncoras NF 7481, 683869, 783759).
- Pós-deploy: consulta de continuidade do prefixo de 22 bytes do `Thread-Index` na
  resposta seguinte do cliente, diária por uma semana. Meta: zero conversa nova
  quando o cliente não mudou o assunto.
- Cenário WURTH: dois e-mails proativos seguidos na mesma thread devem chegar na
  mesma conversa.
