---
title: "Contexto pra IA interpretar resposta do cliente — Larissa / Tratativa de Problema de Entrega"
subtitle: "Documento pra construir a Opção B (autônoma)"
---

# Contexto pra IA interpretar resposta do cliente

A **Opção A** (MVP — está rodando hoje) considera qualquer mensagem do cliente
como "respondeu" — para o relógio dos 4 dias. Funciona, mas tem um buraco:
cliente que responde "ok obrigado" ou "vou verificar" para o relógio sem ter
respondido a pergunta de fato.

A **Opção B** é a IA entender o **contexto da pergunta original** e
classificar a resposta em 3 categorias:

| Categoria | Significado | O que o sistema faz |
|---|---|---|
| **resolveu** | Cliente respondeu o que era pedido | Move card pra AGUARDANDO_VALIDACAO_HUMANA com a info pra Larissa agir |
| **inconclusivo** | Respondeu mas não respondeu o ponto ("ok", "vou ver") | Mantém em AGUARDANDO_CLIENTE + relógio reinicia em 4d |
| **fora_de_topico** | Respondeu mas mudou de assunto (cobrança, dúvida nova) | Larissa decide manual |

Pra IA fazer isso bem, **preciso saber pra cada template**: qual era a
pergunta original, quais respostas válidas resolveriam, quais respostas
seriam inconclusivas. Esse documento é pra Larissa preencher pensando em
"como meu colega novato julgaria se essa resposta resolve ou não?".

**Templates abaixo correspondem aos 5 ativos no banco:**

1. FALTA_DE_VOLUME (oc=49)
2. PROBLEMAS_COM_ENDERECO (oc=11) ⭐ usa link de evidência
3. RECUSA_TOTAL (oc=10) ⭐ usa link de evidência
4. RECUSA_PARCIAL (oc=35) ⭐ usa link de evidência
5. COBRANCA_LEMBRETE (re-cobrança após 4d sem resposta)

---

## Template 1 — FALTA_DE_VOLUME

**Pergunta original que estamos fazendo**: "Falta(m) {n_volumes_falta} volumes
da NF {nf}. Como prefere prosseguir?"

**O que precisamos saber pra fechar a tratativa** (lista o mais detalhada possível):

> resposta (ex: "Cliente precisa escolher entre: 1) aguardar volumes serem localizados, 2) autorizar entrega parcial dos que chegaram, 3) recusar e pedir devolução total."):




**Exemplos de respostas que RESOLVEM** (frases reais que você já recebeu):

> resposta (3-5 exemplos, ex: "Pode entregar o parcial e o resto quando chegar", "Aguarda achar os volumes", "Devolve tudo")




**Exemplos de respostas INCONCLUSIVAS** (cliente responde mas não resolve):

> resposta (3-5 exemplos, ex: "Ok, obrigado", "Vou verificar com o financeiro", "Recebi seu email")




**Exemplos de respostas FORA DE TÓPICO** (cliente fala outra coisa):

> resposta (2-3 exemplos)




**Quando inconclusivo, sistema deve**: (escolha A ou B)

- [ ] **A**: Mandar nova mensagem pedindo esclarecimento (ex: "Pra eu seguir, preciso saber se autoriza entrega parcial ou prefere devolver. Pode me confirmar?")
- [ ] **B**: Voltar pra Larissa decidir o que fazer

> sua escolha:




---

## Template 2 — PROBLEMAS_COM_ENDERECO  ⭐ (com link de evidência)

**Pergunta original**: "A entrega da NF {nf} não foi possível por problemas
com endereço. Veja a evidência registrada pelo motorista: {link_evidencia}.
Pode confirmar o endereço correto pra reentrega?"

**O que precisamos saber pra fechar a tratativa**:

> resposta (ex: "Cliente precisa: 1) confirmar endereço correto OU 2) autorizar devolução OU 3) cancelar a NF"):




**Respostas que RESOLVEM**:

> resposta:




**Respostas INCONCLUSIVAS**:

> resposta:




**Respostas FORA DE TÓPICO**:

> resposta:




**Quando inconclusivo, sistema deve**:

- [ ] A: Pedir esclarecimento
- [ ] B: Voltar pra Larissa

> sua escolha:




---

## Template 3 — RECUSA_TOTAL  ⭐ (com link de evidência)

**Pergunta original**: "A entrega da NF {nf} foi recusada totalmente. Veja a
evidência (NFD) registrada: {link_evidencia}. Como prefere prosseguir? (1)
Devolver, (2) Tentar entregar em outro endereço, (3) Aguardar."

**O que precisamos saber pra fechar a tratativa**:

> resposta:




**Respostas que RESOLVEM**:

> resposta (ex: "Pode devolver", "Tenta entregar em [novo endereço]", "Aguarda mais 24h pra ver se libero recebimento")




**Respostas INCONCLUSIVAS**:

> resposta:




**Respostas FORA DE TÓPICO**:

> resposta:




**Quando inconclusivo, sistema deve**:

- [ ] A: Pedir esclarecimento
- [ ] B: Voltar pra Larissa

> sua escolha:




---

## Template 4 — RECUSA_PARCIAL  ⭐ (com link de evidência)

**Pergunta original**: "A entrega da NF {nf} foi feita parcialmente — parte
da carga foi recusada. Veja a evidência (NF com ressalva):
{link_evidencia}. Como prefere prosseguir com a parte recusada? (1)
Devolver, (2) Nova tentativa em outro endereço, (3) Aguardar."

**O que precisamos saber pra fechar a tratativa**:

> resposta:




**Respostas que RESOLVEM**:

> resposta:




**Respostas INCONCLUSIVAS**:

> resposta:




**Respostas FORA DE TÓPICO**:

> resposta:




**Quando inconclusivo, sistema deve**:

- [ ] A: Pedir esclarecimento
- [ ] B: Voltar pra Larissa

> sua escolha:




---

## Template 5 — COBRANCA_LEMBRETE

A pergunta aqui é a mesma do template original (estamos re-perguntando após
4 dias sem resposta). **Aplicar a mesma classificação do template original**
que disparou a cobrança.

Caso especial: cliente pode responder "Já respondi semana passada, viu?" —
isso é INCONCLUSIVO mas exige Larissa olhar o histórico (talvez a resposta
dele se perdeu no spam).

**Como o sistema deve tratar essa resposta tipo "já respondi"**?

> resposta (ex: "Marcar como inconclusivo + criar todo pra Larissa revisar histórico do email"):




---

## Casos especiais que a IA precisa identificar

Marca todos que aplicam ao seu dia a dia:

- [ ] **Auto-reply de férias** ("Estou de férias até X. Em caso de urgência..."): NÃO conta como resposta. Sistema tenta email secundário se houver.
- [ ] **Encaminhamento dentro da empresa do cliente** ("Encaminhei pro João do financeiro, ele responde"): conta como inconclusivo, mantém aguardando.
- [ ] **Resposta de bot anti-spam** ("Confirme que não é robô"): ignora, NÃO conta.
- [ ] **Resposta com várias NFs** (cliente fala da nossa NF mas também de outra): IA filtra a parte da resposta que é da nossa NF.
- [ ] **Outro caso comum**:

> resposta (descreva qualquer caso que você encontra com frequência):




---

## Sinalizadores fortes — palavras-chave pra IA detectar

Liste palavras/frases que, **quando aparecem na resposta do cliente**,
sinalizam claramente:

**Cliente AUTORIZOU prosseguir** (ex: "pode entregar", "autorizo", "liberado", "sim, segue"):

> resposta:




**Cliente RECUSOU / quer devolução** (ex: "devolva", "não quero", "cancela"):

> resposta:




**Cliente está PEDINDO MAIS INFORMAÇÃO** (ex: "qual era a NF?", "pode me confirmar valores?"):

> resposta:




---

## Observações finais

Quanto mais detalhe e exemplo real, melhor a IA aprende. Não inventa
exemplos — usa só os que você de verdade já recebeu.

Quando terminar, manda esse documento de volta pro Caio. Vou usar isso pra
calibrar o classificador de respostas (modelo Sonnet 4.6) e construir a
Opção B.
