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

## Revisão adversarial pré-merge (2026-09-10)

Antes do merge o Carlos pediu validação completa. Rodamos 8 revisões
independentes sobre o diff (equivalência do `email-threading`, `gmail-sender`,
raio de impacto, executor+schema, captura de Thread-Index, corretude RFC do
`email-mime`, replay de 8 cenários com dados de produção, testes/guards), cada
achado passando por dois céticos com lentes distintas (código e impacto). O
achado mais importante foi metodológico: **o round-trip dos nossos testes usava
o NOSSO decoder**, então não enxergava o que um parser RFC 5322 de verdade faz
com o header. Usando o parser do Python como oráculo externo apareceram quatro
defeitos, corrigidos em `3fa069f`:

1. **O atalho ASCII comia espaço — regressão contra a master.** A decisão 3
   mandava ASCII puro sem codificar; mas o parser descarta o WSP colado ao ":"
   e o do fim da linha, então " RES: Recusa Total…" chegava
   "RES: Recusa Total…". Era a NF 7481 voltando pela porta dos fundos, depois
   de termos tirado o `.trim()` justamente pra evitá-la. A master não tinha o
   problema porque codificava tudo em base64. Cerca:
   `ASCII_AINDA_PRECISA_CODIFICAR_RE` (WSP nas pontas ou `=?`).
2. **`escolherAncoraThread` não cumpria a própria regra.** Com o inbound mais
   recente porém sem Message-ID real (22 de 20.007) ou com id fantasma, caía no
   `return` final e descartava o id REAL do nosso outbound. Ramo novo recua pro
   outbound; assunto e Thread-Index seguem vindo do inbound.
3. **Captura inerte no `buscar-cce-gmail`.** Faltava `gmail_thread_id` no
   `raw_payload`, e é por ele que `resolverThreadEspecifica` filtra — o
   Thread-Index capturado nunca seria lido. (`scan-email-pre-card` já gravava.)
4. **`INV84_TRIM` era tautológico.** Contava `.trim()` no corpo e exigia `<=1`;
   a versão certa tem 1 e a errada da master também tinha 1. Agora conta trim na
   **atribuição** e exige 0 — provado que dá FAIL contra a master.

Em `f681ae6`, fora do escopo original: `cobrar-cliente-aguardando` tinha cópia
local de `withAngleBrackets` sem filtro de fantasma e fallback
`?? gmail_message_id` (id interno do Gmail, nunca um header). Com 7.502
outbounds fantasma e 3.248 nulos de 12.890, ~83% das cobranças saíam com
In-Reply-To apontando pro nada. Passou a usar o helper do `_shared` e a não
inventar âncora.

Sobrevivem como conhecidos, sem ação agora:
- `enviar-resposta` (fila `respostas_envio`, sem uso no fluxo atual) e
  `enviar-retificacao-evidencia` ainda não usam o encoder novo.
- A janela não-atômica entre `send` e a persistência do outbound ficou um passo
  maior (o `messages.get`); num retry do PGMQ o risco de e-mail duplicado é o
  mesmo de antes, só que com janela maior. A idempotência por `todo_id`
  (`verificarEmailJaEnviado`) continua sendo a proteção.
- `subjectFinal` ignora o assunto que a operadora editou no EditarEmailModal
  quando o card tem thread aberta — pré-existente, não introduzido aqui.

## Validação executada

- Suíte Deno completa: **as mesmas 31 falhas na branch e na master**, conjunto
  idêntico, todas em arquivos que a branch não toca (`devolucao-cte-*`, `oc13`,
  `oc59`, `tools-registrados-no-front`); +18 testes novos passando.
- `deno check`: perfil de erros idêntico ao da master, arquivo por arquivo
  (executor 26, `buscar-cce-gmail` 2, `cobrar-cliente-aguardando` 1) — zero erro
  novo. `email-mime.ts` e `email-threading.ts` limpos.
- Fase 8 do `/verify-cockpit` rodada na branch **e** contra o código da master:
  **nenhum invariante falha só na branch**. INV-084 vai de FAIL (master) a PASS.
- Schema conferido em produção: `cards_emails_outbound.subject` e
  `message_id_header` são nullable e não existe coluna `subject_template` — o
  campo novo só entra no `payload` jsonb de `card_events`.
- Os testes novos foram provados **não-tautológicos**: falham quando rodados
  contra o código do commit anterior.
