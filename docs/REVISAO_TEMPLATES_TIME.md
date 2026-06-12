# Revisão dos emails automáticos do Cockpit — Time Relacionamento

Oi! Esse documento é pra vocês revisarem os textos dos emails que o Cockpit dispara automaticamente.

**Como funciona:**

1. Pra cada email abaixo você vê **(a)** quando ele é enviado, **(b)** o texto atual.
2. Embaixo de cada um tem **três caixas pra preencher** (deixe em branco se estiver bom):
   - 📝 **Texto sugerido** — se quiserem trocar a redação
   - 📌 **Quando deveria disparar** — se acharem que a regra "quando dispara" não está certa
   - 💬 **Observações** — qualquer comentário
3. Quando terminarem, devolvam esse documento pro Caio. Ele atualiza tudo no sistema.

**Sobre as palavras entre `{ }`:**
São informações que o Cockpit preenche automaticamente no momento do envio. Por exemplo, `{nf}` vira o número da NF do caso. Mantenham essas marcações se reescreverem o texto. Lista completa no final do documento.

---

## ✉️ Emails de NOTIFICAÇÃO (avisar o cliente sobre o problema)

---

### 1️⃣ Recusa Total

**Quando dispara hoje:** entrega registrada como **RECUSA TOTAL** no SSW (ocorrência 10), com foto do destinatário e ressalva manuscrita legível dizendo o motivo da recusa.

**Assunto atual:** Recusa Total — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou integralmente a carga.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Para darmos continuidade, poderia, por gentileza, nos orientar quanto à tratativa: seguir com a devolução ou seguir para reentrega?
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem.
>
> Ficamos no aguardo para prosseguirmos.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 2️⃣ Recusa Parcial

**Quando dispara hoje:** ocorrência 35 no SSW (recusa de parte da carga), com ressalva clara de que o cliente devolveu parte do que recebeu (não é falta interna em caixa lacrada).

**Assunto atual:** Recusa Parcial — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou parte da carga.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Para darmos continuidade, poderia, por gentileza, nos orientar se podemos seguir para a devolução?
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem.
>
> Ficamos no aguardo para prosseguirmos.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 3️⃣ Recusa após entrega parcial

**Quando dispara hoje:** ocorrência 35 no SSW quando o cliente RECEBEU uma parte da carga e DEVOLVEU outra parte no mesmo ato.

**Assunto atual:** Recusa após entrega parcial — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Caso deseje, podemos compartilhar informações detalhadas da recusa (motivo registrado pelo destinatário, ressalva e demais comprovantes) pra avaliar a melhor tratativa.
>
> Ficamos no aguardo de sua orientação: seguir com a devolução, nova tentativa de entrega ou aguardar novas instruções?
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 4️⃣ Problemas com endereço

**Quando dispara hoje:** ocorrência 11 no SSW (insucesso na entrega) quando o GPS do motorista mostra que ele foi pra perto do endereço (até 4 km), mas o destinatário/endereço não foi localizado.

**Assunto atual:** Insucesso na entrega — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Ao realizarmos a tentativa de entrega referente à NF {nf}, não foi possível localizar o endereço informado. Poderia confirmar se o endereço está correto?
>
> Segue evidência registrada pelo motorista, que pode ser acessada através do link: {link_evidencia}
>
> Para darmos continuidade com a entrega, poderia, por gentileza, confirmar/corrigir os dados de endereço? Caso necessário, solicitamos também o envio de uma CCe.
>
> Ficamos no aguardo de sua orientação para prosseguirmos com a reentrega o quanto antes.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 5️⃣ Entregue com falta de volumes (pedir romaneio)

**Quando dispara hoje:** ocorrência 19 no SSW (entregue) quando há ressalva no canhoto indicando que faltou volume na entrega.

**Assunto atual:** Entrega parcial concluída — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Realizamos a entrega da NF {nf} no destino final com falta de {n_volumes_falta} volume(s). A ressalva foi coletada junto ao destinatário no momento da entrega.
>
> A evidência registrada pode ser acessada no link: {link_evidencia}
>
> Para darmos sequência ao processo de ressarcimento dos volumes faltantes, gentileza encaminhar o romaneio de coleta assinado da NF e a descrição/valor dos itens faltantes.
>
> Assim que recebermos, abrimos o processo de ressarcimento internamente.
>
> Ficamos no aguardo.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

## 📦 Emails de EXTRAVIO (volumes sumidos durante o transporte)

---

### 6️⃣ Extravio parcial (não sabemos quantos volumes ainda)

**Quando dispara hoje:** ocorrência 49 (relacionamento pós-prazo) quando identificamos que alguns volumes sumiram mas não temos a quantidade exata. Sem comparação com total da NF.

**Assunto atual:** Extravio Parcial — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Gostaria de informar o extravio de {n_volumes_falta} volume(s) referente(s) à NF {nf}.
>
> Podemos seguir com a entrega parcial, coletando a ressalva junto ao destinatário, e posteriormente compartilhar com vocês para a emissão de um novo pedido referente aos volumes faltantes. Caso os volumes sejam localizados, seguiremos com a devolução isenta. Ou, se preferirem, seguir com a devolução dos volumes atualmente em nossa posse?
>
> Ficamos no aguardo de sua orientação para prosseguirmos.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 7️⃣ Extravio parcial (com quantidade exata — ex: 3 de 10)

**Quando dispara hoje:** ocorrência 49 quando sabemos quantos volumes sumiram **e** quantos foram localizados. Mais detalhado que o anterior.

**Assunto atual:** Extravio parcial — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Identificamos que durante o transporte da NF {nf} houve extravio de {n_volumes_falta} de {qtde_volumes} volumes. Localizamos o restante.
>
> Para prosseguirmos, poderia nos orientar:
> (a) seguir com a entrega parcial dos volumes localizados, OU
> (b) realizar a devolução total?
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem caso aguardemos retorno por longo período.
>
> Atenciosamente,
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 8️⃣ Extravio total (busca interna concluída, pedir reposição)

**Quando dispara hoje:** ocorrência 49 quando todos os volumes sumiram e a busca interna esgotou. Pede reposição e romaneio.

**Assunto atual:** Extravio Total — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Gostaríamos de informar o extravio total referente à NF {nf}. As buscas internas já foram concluídas e os volumes não foram localizados.
>
> Para evitar impactos junto ao cliente, orientamos o envio de um novo pedido de reposição. Caso os volumes sejam localizados posteriormente, seguiremos automaticamente com a devolução dos mesmos, de forma isenta.
>
> Poderiam, por favor, nos enviar o romaneio de coleta assinado da NF?
>
> Seguimos acompanhando o caso com prioridade e permanecemos à disposição.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 9️⃣ Extravio total (pedir romaneio para indenização)

**Quando dispara hoje:** ocorrência 49 com extravio total, focado em iniciar processo de **indenização** (não reposição). Texto mais formal.

**Assunto atual:** Extravio total — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Lamentamos informar que todos os volumes da NF {nf} foram extraviados durante o transporte e não foram localizados dentro do prazo padrão de busca.
>
> Para darmos continuidade ao processo de indenização, solicitamos o envio do romaneio assinado e demais documentos pertinentes.
>
> Ficamos à disposição para esclarecimentos.
>
> Atenciosamente,
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

> 🤔 **Pergunta pro time:** os emails 8️⃣ e 9️⃣ se sobrepõem — ambos cobrem "extravio total". Faz sentido manter os dois ou unificar? Comentem na seção "Casos não cobertos" no final.

---

### 🔟 Notificação de Extravio Total (PRATI — sem pedir romaneio)

**Quando dispara hoje:** caso específico do cliente **PRATI** (já temos romaneio armazenado internamente). Não pedimos romaneio porque já temos. Só avisamos que vamos iniciar ressarcimento.

**Assunto atual:** Aviso Importante: Extravio Total NF {nf}

**Texto atual:**

> Prezado(a) {primeiro_nome},
>
> Identificamos extravio total da NF {nf} ({empresa}). Conforme nosso processo acordado em contrato, daremos andamento ao processo de ressarcimento via análise de perdas, com base no romaneio de coleta disponibilizado em nossos registros internos.
>
> Qualquer informação adicional ou contato do time de Perdas será encaminhado em separado.
>
> Atenciosamente,
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

## 🔔 Emails de COBRANÇA (cliente parou de responder)

> ⚠️ Esses emails estão **desativados em automático** desde 26/05/2026 (decisão Caio). Eles só disparam se a operadora acionar manualmente. Mas o texto continua aqui pra revisão, porque vamos reativar depois.

---

### 1️⃣1️⃣ Cobrança lembrete — 4 dias sem resposta

**Quando deveria disparar:** 4 dias depois da 1ª notificação ao cliente sem retorno.

**Assunto atual:** Aguardando retorno — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}. Até o momento, já se passaram 4 dias desde a nossa notificação, e seguimos no aguardo de sua orientação para continuidade.
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Pedimos, por gentileza, seu retorno para que possamos prosseguir com a tratativa.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 1️⃣2️⃣ Cobrança final — 8 dias sem resposta (armazenagem passa a vigorar)

**Quando deveria disparar:** 8 dias depois da 1ª notificação. Avisa que a cobrança de armazenagem começa a valer a partir desse momento.

**Assunto atual:** Aviso de cobrança de armazenagem — NF {nf}

**Texto atual:**

> Olá {primeiro_nome},
>
> Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}. Após 4 dias, realizamos a notificação sobre a possibilidade de cobrança de armazenagem e, neste momento, já se passaram 8 dias sem retorno para definição.
>
> Dessa forma, informamos que a cobrança de armazenagem passa a ser aplicada a partir de agora e será faturada ao final do desfecho da ocorrência, seja no momento da devolução ou da entrega efetiva.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Reforçamos a necessidade de seu retorno para prosseguirmos com a tratativa.
>
> {operadora_nome}
> Sal Express — Relacionamento

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

## 💬 Emails de RESPOSTA CURTA (cliente autorizou — confirmamos)

São respostas rápidas que disparam **na mesma thread de email** quando a operadora aprova a ação no Cockpit clicando em "Responder cliente por email".

---

### 1️⃣3️⃣ Cliente autorizou reentrega

**Quando dispara hoje:** ocorrência 21 aprovada com toggle "responder cliente" marcado.

**Assunto atual:** Re: NF {nf}

**Texto atual:**

> Ok {saudacao}, iremos seguir com a reentrega o mais rápido possível.

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 1️⃣4️⃣ Cliente autorizou devolução

**Quando dispara hoje:** ocorrência 44 aprovada com toggle "responder cliente" marcado.

**Assunto atual:** Re: NF {nf}

**Texto atual:**

> Ok {saudacao}, iremos seguir com a devolução conforme prazo acordado.

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

### 1️⃣5️⃣ Cliente autorizou entrega parcial

**Quando dispara hoje:** ocorrência 55 aprovada com toggle "responder cliente" marcado.

**Assunto atual:** Re: NF {nf}

**Texto atual:**

> Ok {saudacao}, iremos seguir com a entrega parcial conforme combinado.

📝 **Texto sugerido:**
```


```

📌 **Quando deveria disparar (se diferente de hoje):**
```


```

💬 **Observações:**
```


```

---

## 🆕 Casos NOVOS que vocês acham que deveriam ter email automático

Hoje só temos os 15 emails acima. Se vocês operam casos recorrentes que NÃO estão cobertos e que faz sentido virar email automático, descrevam aqui pra criarmos novos.

**Modelo pra preencher pra cada caso:**

- **Qual situação acontece:** (descrever o caso operacional)
- **Como o Cockpit poderia identificar essa situação:** (o que a IA precisa ver pra saber que é esse caso — ex: "ressalva diz 'caixa molhada'", "GPS mostra distância > 50km do CEP", etc.)
- **Texto que a gente quer enviar:** (rascunho do email, usando `{nf}`, `{primeiro_nome}` etc.)
- **Quem responde esse caso normalmente:** (Larissa/Duilio/Carlos/Operação?)

---

### Caso novo nº 1

**Qual situação acontece:**
```


```

**Como o Cockpit poderia identificar essa situação:**
```


```

**Texto que a gente quer enviar:**
```


```

**Quem responde:**
```


```

---

### Caso novo nº 2

**Qual situação acontece:**
```


```

**Como o Cockpit poderia identificar essa situação:**
```


```

**Texto que a gente quer enviar:**
```


```

**Quem responde:**
```


```

---

### Caso novo nº 3

**Qual situação acontece:**
```


```

**Como o Cockpit poderia identificar essa situação:**
```


```

**Texto que a gente quer enviar:**
```


```

**Quem responde:**
```


```

---

## 🚦 Mudanças nas REGRAS de quando os emails disparam

Hoje a regra automática é:

| Ocorrência SSW | Email default que sugere |
|---|---|
| 10 (recusa total) | Recusa Total |
| 11 (problemas endereço) | Problemas com endereço |
| 19 (entregue com falta) | Entregue com falta — pedir romaneio |
| 35 (recusa parcial) | Recusa Parcial |
| 49 (relacionamento) | Extravio Parcial (ou variações conforme caso) |
| Outras | Cobrança Lembrete |

**Vocês querem mudar alguma dessa lista?**

```
Ocorrência: ___
Hoje sugere: ___________________
Deveria sugerir: ___________________
Motivo: ___________________
```

```
Ocorrência: ___
Hoje sugere: ___________________
Deveria sugerir: ___________________
Motivo: ___________________
```

---

## ❓ Dúvidas/Sugestões gerais

Espaço pra qualquer comentário que não cabe nas seções acima:

```




```

---

## 📋 Referência rápida — palavras entre `{ }` que existem hoje

Quando reescreverem texto, podem usar essas palavras-código. O Cockpit substitui automaticamente:

| Quando vocês escrevem... | Vira no email enviado... |
|---|---|
| `{primeiro_nome}` | Primeiro nome do contato do cliente (ex: "Bianca") |
| `{nf}` | Número da NF (ex: "357224") |
| `{operadora_nome}` | Nome de quem enviou (ex: "LARISSA") |
| `{link_evidencia}` | Link único da foto da entrega |
| `{empresa}` | Razão social do cliente (ex: "RIOCLARENSE") |
| `{n_volumes_falta}` | Quantos volumes faltaram (número) |
| `{qtde_volumes}` | Total de volumes da NF (número) |
| `{saudacao}` | "Bom dia", "Boa tarde" ou "Boa noite" (automático por horário) |

Se precisar de uma palavra-código nova que ainda não existe, escrevam na seção "Dúvidas/Sugestões gerais" e o Caio cria.

---

## ✅ Como me devolver

Quando terminarem, é só passar esse documento de volta pro Caio. Ele lê, aplica as mudanças nos textos no sistema, e atualiza o documento de regras oficial do Cockpit pra refletir o que ficou definido.

**Quem preencheu:** ___________________
**Data:** ___ / ___ / 2026
