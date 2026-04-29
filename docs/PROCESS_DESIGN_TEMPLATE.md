# Template — Desenho de processo pra virar agente de IA

**Pra que serve este documento**

Cada agente de IA do Cockpit faz hoje o trabalho que uma operadora faz manualmente.
Pra eu (sistema/Claude) construir um agente que decide e age **igual a operadora**,
preciso entender exatamente o que ela faz, na ordem que faz, olhando onde olha,
decidindo como decide.

Este template é pra ser preenchido pela operadora **mais experiente em cada
processo** (ex.: a Larissa pra reentrega, alguém de avaria pra avaria, etc.).
Não é pra inventar processo ideal — é pra **descrever o real, como acontece hoje**.

**Não tenha medo de escrever demais.** Quanto mais detalhe, melhor o agente fica.
Quanto mais "óbvio" pra você o passo, mais provável que o sistema esqueça se
você não escrever.

---

## Como preencher

1. **1 documento por processo.** Reentrega é um doc. Devolução é outro. Cobrança
   de base é outro. Não misture.
2. **Use linguagem natural**, sem formato técnico. Como se explicasse pra um
   colega novo da operação.
3. **Cole exemplos reais.** Mensagens que você mandou de verdade pro cliente,
   prints de tela, nomes de empresas reais. Anonimiza CPF se quiser, mas
   mantém estrutura.
4. **Sem fluxograma.** Se quiser desenhar, ok, mas o que importa é a narrativa
   escrita.
5. **Marque dúvidas.** Se algum passo você faz "automático" e não sabe explicar
   por quê, escreve assim mesmo: "faço X mas não sei explicar — só sei que dá
   certo". Isso me ajuda a fazer perguntas depois.

**Tempo estimado pra preencher 1 processo:** 1h-1h30 (sentado, escrevendo direto,
com prints abertos do SSW pra consultar).

---

# === TEMPLATE — copie e preencha pra cada processo ===

## 1. Nome do processo

(Ex.: Reentrega, Devolução autorizada, Cobrança de base, Avaria com seguro)

> _**Quem é o dono desse processo:**_ <nome da operadora que mais entende>
>
> _**Áreas envolvidas:**_ Relacionamento / Devolução / Operação / etc.

## 2. Resumo em 1 frase

O que esse processo faz, em uma frase só, sem jargão.

> _Exemplo: "Garantir que uma carga que falhou na 1ª tentativa de entrega seja entregue de novo, mantendo o cliente informado."_

## 3. Quando esse processo COMEÇA (trigger)

O que faz a operadora **começar** a trabalhar nesse caso? Marque com **X** o
que se aplica e detalhe abaixo.

- [ ] Cliente manda WhatsApp falando algo específico
- [ ] Cliente manda email
- [ ] Pendência aparece no Bastão (qual oc?)
- [ ] Pendência aparece no SSW (qual oc?)
- [ ] SLA estourou (quanto tempo?)
- [ ] Outro operador encaminha
- [ ] Comando de gestor
- [ ] Outro: _______

**Detalhamento:**

> Como você reconhece que esse caso é desse processo? Que palavras-chave/sinais
> aparecem na mensagem do cliente? Que campo/filtro indica isso no SSW?
>
> _Exemplo Reentrega: "Cliente fala 'ninguém estava em casa', 'tentaram entregar', 'pode tentar de novo amanhã'. Ou: oc 54 no SSW com instrução 'cliente ausente'."_

## 4. Onde você OLHA (fontes de informação)

Liste **todos** os sistemas/telas/ferramentas que você acessa pra entender e
tratar esse caso. Pra cada um, fale **o que clica/filtra/lê**.

### 4.1 SSW
- **Qual tela:** _________
- **Filtros aplicados:** _________
- **Campos que olha:** _________ (NF, CTRC, remetente, destinatário, oc atual, etc.)
- **Print/screenshot:** [se possível, anexar]

### 4.2 WhatsApp / Evolution
- **Qual instância:** _________
- **Histórico que consulta:** _________
- **Contatos cadastrados:** _________

### 4.3 Email
- **Qual caixa:** _________
- **Pasta/filtro:** _________

### 4.4 Bastão (plataforma de pendências)
- **Qual filtro:** _________ (ex.: oc 54 da minha carteira)
- **Campos que olha:** _________

### 4.5 Outros (planilhas, sistemas internos, agenda, etc.)
- _________

## 5. Como você DECIDE o que fazer (heurísticas)

Liste **todas** as perguntas que você se faz mentalmente quando bate o olho num
caso novo, e o que decide pra cada resposta. Quanto mais perguntas, melhor.

> Não pule pergunta achando que "é óbvio". O agente não tem nada óbvio.

**Modelo:**

### Pergunta 1: _________

- **Como descobre:** onde olha pra responder
- **Se SIM:** o que faz / pra onde escala
- **Se NÃO:** o que faz

### Pergunta 2: _________

- **Como descobre:**
- **Se SIM:**
- **Se NÃO:**

(repetir pra todas as perguntas)

> _Exemplo Reentrega:_
>
> _Pergunta 1: "Cliente confirmou novo endereço/horário ou só pediu reentregar?"_
> _- Como descobre: lê a mensagem dele._
> _- Se confirmou: lança oc 21 e responde "ok, vamos tentar de novo"._
> _- Se só pediu: pergunto "mesmo endereço? que horário melhor?" antes de lançar._
>
> _Pergunta 2: "É a segunda ou terceira reentrega na mesma carga?"_
> _- Como descobre: olho histórico de oc no SSW._
> _- Se 1ª/2ª: trato normal._
> _- Se 3ª+: aviso o cliente que precisa retirar na base ou autorizar devolução._

## 6. AÇÕES que você executa (passo a passo cronológico)

Lista **na ordem que faz**, com o **sistema** onde faz cada uma. Pode estimar
**quanto tempo leva** cada passo (em minutos).

| # | Ação | Onde faz | Tempo aprox. | Observação |
|---|---|---|---|---|
| 1 | Abre tela X | SSW | 10s | filtra por NF |
| 2 | Confere campo Y | SSW | 20s | se Y for vazio, faço Z |
| 3 | Manda mensagem padrão pra cliente | WhatsApp | 1min | template abaixo |
| ... | | | | |

## 7. MENSAGENS/TEXTOS padrão que você usa

Cole **exemplos reais** das mensagens que você manda. Inclua variações pra
clientes diferentes (cliente bravo, cliente educado, cliente que mandou áudio,
etc.).

> _**Importante:** preserve assinatura, tom, emojis se usa. Quero replicar exato._

### Template 1: _Confirmação de reentrega_
```
Olá <nome>! Confirmando a reentrega da NF <X> amanhã pela manhã,
mesmo endereço. Qualquer alteração nos avise. Att, equipe Sal Express.
```

### Template 2: _Cliente quer mudar endereço_
```
...
```

### Template 3: _Cliente pra escalar (ameaça Procon, etc.)_
```
...
```

(Quantas variações usar — todas. Cole bastante.)

## 8. Casos especiais / variações

Situações que **fogem do fluxo principal** e como você lida.

> _Exemplo Reentrega:_
> _- Cliente diz que mudou de número de celular: peço pra confirmar pelo email cadastrado antes de seguir._
> _- Carga com produto perecível: trato com prioridade alta, contato motorista direto._
> _- Cliente fala "cancela e devolve pra mim": muda pro processo Devolução, escalo pra área X._

- Caso A: _________ → faço _________
- Caso B: _________ → faço _________
- Caso C: _________ → faço _________

## 9. Quando você considera o caso FECHADO

Critérios objetivos pra você marcar/considerar concluído:

- [ ] Cliente confirmou recebimento
- [ ] SSW marcou oc X
- [ ] Outro: _________

## 10. Quando você NÃO trata sozinha (escalada)

Critérios pra parar de tratar e passar pra outra pessoa/área:

| Situação | Pra onde escala | O que escreve no encaminhamento |
|---|---|---|
| Cliente ameaça Procon/jurídico | Gestor relacionamento | "Cliente X ameaçou Procon na NF Y. Mandei <print>. Acompanhe." |
| Carga sumiu | Perdas | ... |
| Cliente quer indenização | Ressarcimento | ... |
| ... | ... | ... |

## 11. Frequência e volume

- **Quantos casos desse tipo você trata por dia?** _________
- **Tempo médio por caso (atendimento ativo, fora espera de cliente):** _________
- **Pico (horário ou dia da semana):** _________
- **% que resolve sozinha (não escala):** _________ %

## 12. O que mais te dá problema

O que dá retrabalho, atrito, demora? O que você gostaria que fosse automático?

> _Não filtre. Tudo que te chateia diariamente vale escrever._

- _________
- _________
- _________

## 13. Glossário interno

Palavras/siglas que vocês usam internamente e alguém de fora não entenderia:

| Termo | O que significa |
|---|---|
| Bastão | _________ |
| Acompanhamento | _________ |
| Carteira | _________ |
| ... | ... |

## 14. Dúvidas, ambiguidades, perguntas

Coisas que você faz mas não sabe explicar **bem** ou tem dúvida sobre regra
oficial. Marque aqui — eu pergunto pra esclarecer depois.

- _________
- _________

---

# === EXEMPLO PARCIAL — REENTREGA (já preenchido como referência) ===

> Use esse exemplo só como **referência de profundidade esperada**. Não copie
> palavras — o seu jeito de descrever vale mais.

## 1. Nome do processo
**Reentrega** _(reentrega solicitada pelo cliente após 1ª tentativa frustrada)_

## 2. Resumo em 1 frase
Garantir nova tentativa de entrega de uma carga depois que o motorista não
conseguiu entregar na primeira ida, mantendo o cliente informado.

## 3. Quando começa
- [X] Cliente manda WhatsApp falando "ninguém estava em casa", "podem tentar de novo", "tentaram entregar mas..."
- [X] Cliente manda email com mesmo conteúdo
- [X] Pendência oc 54 no Bastão (cliente pagador foi avisado e ainda não respondeu — eu cobro depois)

Na maioria das vezes começa pelo WhatsApp do cliente. O cliente NÃO costuma
falar "quero reentrega" — fala "tentaram, mas eu não estava".

## 4. Onde olho
**SSW (módulo de carga):**
- Filtra por NF
- Olho: oc atual, base atual, motorista designado, histórico de oc, observação última
- Print: [tela de detalhe da NF, igual a que mandei pro Claude antes]

**WhatsApp:**
- Instância sal-express
- Histórico: olho últimos dias da conversa pra ver se já tinha tido tentativa antes

**Bastão:**
- Filtro: oc 54 + minha carteira (Larissa)
- Olho: data da última oc 54, prazo de retorno, dias atraso

## 5. Decisões

**Pergunta 1: Cliente confirmou novo endereço/horário ou só falou "tenta de novo"?**
- Como descubro: leio a mensagem inteira.
- Se confirmou (ex.: "amanhã pela manhã, mesmo endereço"): lanço oc 21 imediato.
- Se só pediu: respondo "mesmo endereço? que horário melhor?" e espero confirmação antes de lançar.

**Pergunta 2: Já é a segunda ou terceira reentrega da mesma carga?**
- Como descubro: olho histórico SSW (filtro oc 21 anterior).
- Se 1ª: trato normal.
- Se 2ª: trato normal mas aviso "será a 2ª tentativa, se não der retiraremos na base".
- Se 3ª: NÃO lanço oc 21. Aviso cliente que precisa retirar na base ou autorizar devolução. Escalo pro gestor se cliente recusar.

**Pergunta 3: Carga é perecível ou alto valor?**
- Como descubro: campo "tipo de mercadoria" no CTRC.
- Se sim: trato com prioridade alta, ligo pro motorista pessoalmente além de lançar oc.

**Pergunta 4: Cliente está bravo/agressivo?**
- Como descubro: tom da mensagem. Palavras como "absurdo", "Procon", "vou processar".
- Se sim: respondo com mais cuidado, escalo cópia pro gestor, evito automatizar.
- Se não: fluxo normal.

## 6. Ações em ordem

| # | Ação | Onde | Tempo |
|---|---|---|---|
| 1 | Bate o olho no histórico WhatsApp | WA | 30s |
| 2 | Abre NF no SSW | SSW | 30s |
| 3 | Confere oc atual + histórico oc | SSW | 1min |
| 4 | Se precisa, pergunta endereço/horário pro cliente | WA | 1min |
| 5 | Espera confirmação cliente (variável) | — | 5min-2h |
| 6 | Lança oc 21 no SSW | SSW painel | 1min |
| 7 | Responde cliente "ok, lançado, amanhã alguém entrega" | WA | 30s |
| 8 | Agendo follow-up pra D+1 (verificar se motorista saiu) | Agenda | 20s |
| 9 | No D+1, abro a NF e vejo se oc 14 (entrega iniciada) apareceu | SSW | 30s |

## 7. Mensagens

**Confirmação:**
```
Olá! Confirmando a reentrega da NF <NF> amanhã pela manhã, mesmo endereço.
Caso precise alterar, nos avise. Atenciosamente, equipe Sal Express.
```

**Pedindo confirmação:**
```
Oi! Vou organizar a reentrega aqui. Pode confirmar o endereço de entrega
e qual período é melhor (manhã/tarde)? Obrigada!
```

**Cliente bravo:**
```
<nome>, entendo a sua frustração. Já estou tratando pessoalmente. Vou
lançar a reentrega para amanhã e te aviso assim que o motorista sair.
Qualquer coisa, fala comigo direto neste WhatsApp.
```

## 8. Casos especiais
- Cliente quer mudar endereço de entrega: peço autorização do pagador (quem emitiu a NF) antes de mudar.
- Cliente diz que mudou número de celular: peço pra mandar email pelo cadastrado pra confirmar identidade.
- Carga vai pra cidade diferente da NF original: escalo pro gestor.

## 9. Caso fechado quando
- Oc 14 (entrega realizada) aparece no SSW.
- E cliente confirmou recebimento (WhatsApp/email).

## 10. Escalada
| Situação | Pra onde |
|---|---|
| 3ª reentrega negada | Gestor + cliente decide entre devolução/retirada |
| Cliente ameaça Procon | Gestor + cópia jurídico |
| Carga perecível com >2 dias parada | Avisa gestor + começa processo de devolução |
| Pagador (cliente) não autoriza nova tentativa | Inicio processo Devolução |

## 11. Volume
- ~15 reentregas/dia atendidas.
- Tempo médio ativo: 5min/caso (sem contar espera de cliente).
- Pico: segunda de manhã (cargas que tentaram entregar sexta).

## 12. Problemas
- Quando cliente não responde por 24h+ e a carga fica acumulando custo.
- Quando motorista pousa numa cidade errada e ninguém me avisa.
- Quando o cliente mistura várias NFs na mesma mensagem.

## 13. Glossário
| Termo | Significa |
|---|---|
| Bastão | sistema interno de pendências (não é o SSW; é separado) |
| Tratativa | atendimento ativo de um caso (oposto de "encerrado") |
| Carteira | conjunto de clientes que cada operadora atende |
| Pousar | ficar parada numa base (sem dar saída) |
| Dar saída | sair pra entrega (oc 14 no SSW) |

## 14. Dúvidas
- Quando cliente fala "tô quase chegando aí busca" — interpretar como retirada na base ou tentativa de mudança de endereço? **Não tenho regra fixa.**
- Quando passar 1 reentrega pra outra operadora? Hoje fica com quem pegou primeiro.
