# O Agente de Extravio Parcial — explicação para o time

*Documento em linguagem simples, para quem não é técnico. Explica o que o agente faz, por que ele existe e o que muda no dia a dia.*

---

## Em uma frase

É um assistente automático que cuida das NFs em que **perdemos alguns volumes (não todos)**, garantindo que a gente peça ao cliente **as informações certas, na hora certa**, e que o caso **só vá para o time de Ressarcimento quando estiver realmente completo** — sem travar e sem abrir indenização pela metade.

---

## O problema que ele resolve

Quando uma carga chega ou é coletada **com falta de alguns volumes** (chamamos de **extravio parcial**), para abrir o processo de **indenização** o time de Ressarcimento precisa **sempre de 3 informações**:

1. **Romaneio de coleta assinado** — o comprovante de quais volumes foram coletados.
2. **Descrição dos itens que faltaram** — o que exatamente sumiu (ex.: "Paracetamol 500mg").
3. **Valor dos itens que faltaram** — quanto vale (ex.: "R$ 300,00").

O detalhe que complicava tudo: **essas 3 informações quase nunca chegam juntas.** O cliente manda o romaneio num e-mail hoje, a descrição e o valor em outro e-mail dias depois. Antes, o sistema não "lembrava" o que já tinha chegado. Resultado prático:

- O caso ia para o Ressarcimento **incompleto** → o Ressarcimento **devolvia** pedindo o que faltava → a tratativa **voltava para o começo**, às vezes várias vezes.
- Ou o e-mail que ia para o cliente **nem pedia** as informações certas — pedia coisa genérica ("querem seguir com a entrega ou devolver?") mesmo depois de a entrega já ter acontecido.

O agente foi criado para acabar com esse retrabalho.

---

## O que o agente faz, passo a passo (em linguagem de negócio)

**1. Reconhece que é um extravio parcial.**
Quando a NF aparece com falta de volumes (e não perda total), ele identifica que estamos nesse fluxo específico.

**2. Manda o e-mail certo para o cliente.**
Em vez de um e-mail genérico, ele sugere um e-mail que **já pede as 3 coisas** de uma vez: *"encaminhe o romaneio de coleta assinado + a descrição e o valor dos itens que faltaram"*. Isso encurta a conversa: o cliente sabe exatamente o que mandar.

**3. Vai "juntando" as informações conforme elas chegam.**
Como as 3 chegam fatiadas em e-mails diferentes, o agente mantém um **checklist do caso**: marca o que já veio e o que ainda falta. Uma informação que já chegou **nunca "some"** — mesmo que um e-mail posterior não a repita.

**4. Só libera passar para o Ressarcimento quando está completo.**
O caso só é encaminhado para a indenização **quando as 3 informações estão presentes**. Se faltar alguma, o agente **avisa o operador**: *"falta o romaneio"* (ou a descrição, ou o valor) — em vez de deixar o caso ir incompleto e voltar depois.

**5. Não pede duas vezes o que já foi recebido.**
Se o romaneio **já tinha chegado antes** (por exemplo, num e-mail de semanas atrás, ou porque o Ressarcimento já o aceitou), o agente **reconhece isso** e não fica pedindo de novo à toa. Ele só cobra o que realmente está faltando.

---

## Os dois caminhos possíveis

Todo extravio parcial cai em um de dois cenários:

**Caso 1 — O cliente fica com o que recebeu.**
A entrega foi feita com falta, o cliente aceita ficar com os volumes que chegaram. Aqui o cliente já sabe o que faltou, então o agente pede as 3 informações e, quando completas, abre a indenização daquele volume perdido.

**Caso 2 — O cliente não aceita e pede a devolução.**
A carga volta. Primeiro resolve-se a parte física (a devolução), e só **depois** — quando a carga retorna e se sabe exatamente o que faltou — é que o cliente informa descrição e valor para a indenização. O agente acompanha esse fluxo mais longo sem perder o histórico.

*(O Caso 2 está construído mas ainda em fase de validação — ver "status" no final.)*

---

## O que muda no dia a dia do operador (Relacionamento)

- **Menos retrabalho:** o caso deixa de "ir e voltar" do Ressarcimento por estar incompleto.
- **O botão e o e-mail certos:** quando o operador vai responder o cliente, a sugestão já vem com o texto que pede as 3 informações — não um texto genérico.
- **Avisos claros:** o operador vê o que ainda falta para poder fechar o caso ("falta romaneio").
- **Sem pedir o que já tem:** se o cliente já mandou o romaneio, o sistema não insiste nele.

---

## O que continua sendo decisão humana

O agente **sugere e organiza** — ele **não age sozinho** nos pontos sensíveis. O **operador valida e aprova** antes de qualquer ação com o cliente ou de encaminhar o caso ao Ressarcimento. Ou seja: o agente prepara o terreno e evita erros; a palavra final continua sendo da pessoa.

---

## Exemplos reais (traduzidos)

- **Caso onde faltou 1 de 14 volumes:** o cliente respondeu com a descrição ("Paracetamol 500mg, 5.000 comprimidos") e o valor ("R$ 300,00"), **mas não mandou o romaneio**. O agente reconhece que ainda falta o romaneio e **mantém o caso aguardando** — em vez de abrir a indenização incompleta.

- **Caso onde o romaneio já tinha chegado semanas antes:** o cliente respondeu com descrição e valor. O agente **lembra** que o romaneio já estava no e-mail anterior (e já tinha sido aceito pelo Ressarcimento) → **não pede o romaneio de novo** e trata o caso como pronto para completar.

- **Caso onde a entrega foi feita com falta:** antes, o e-mail sugerido perguntava "seguir parcial ou devolver?" — pergunta que não faz sentido depois de a entrega já ter acontecido, e que **não pedia** as informações do Ressarcimento. Agora o e-mail já pede **romaneio + descrição + valor**, que é o que o caso realmente precisa.

---

## Por que isso importa para a operação

- **Indenização mais rápida:** o Ressarcimento recebe o caso completo de primeira.
- **Cliente melhor atendido:** um pedido claro, uma vez só, em vez de várias idas e vindas.
- **Menos casos travados:** o sistema não deixa o caso ir pela metade nem cobra o que já tem.

---

## Status (transparência)

Isto está sendo **liberado em fases**, com acompanhamento:

- ✅ **No ar:** o e-mail correto para "entrega com falta" (pede romaneio + descrição + valor) e a correção que evita mandar o pedido errado.
- 🟡 **Em observação:** o "checklist das 3 informações" já está rodando em modo de acompanhamento (o sistema registra o que falta), e o bloqueio automático de abrir a indenização incompleta será ligado após um período de validação.
- 🟡 **Em validação:** o reconhecimento de romaneio já recebido antes e o fluxo completo do Caso 2 (devolução).

Nenhuma etapa sensível age sem validação do operador. O objetivo de todas as fases é o mesmo: **o cliente ser cobrado corretamente das 3 informações, e o caso nunca abrir a indenização pela metade.**

---

*Dúvidas sobre o funcionamento? Falar com o Caio.*
