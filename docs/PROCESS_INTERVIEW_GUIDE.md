# Guia de entrevista — extrair processo de operadora experiente

**Pra que serve**

Complementa o `PROCESS_DESIGN_TEMPLATE.md`. Tem coisa que a operadora **faz
mas não escreve**: heurísticas inconscientes, casos extremos, atalhos
informais, motivos pra fazer algo. Entrevista guiada captura o que escrito
deixou passar.

**Como usar**

- Reserva 30-45min com a operadora dona do processo.
- Pode gravar (Loom, áudio, transcrição automática). Avisa que é pra usar
  na construção do agente, não pra avaliar performance dela.
- Já leu o template preenchido por ela antes da entrevista. As perguntas
  abaixo focam **no que faltou** ou **no que ela escreveu vagamente**.
- Sem julgamento. "Eu faço chutando às vezes" é resposta válida e útil.

---

## Bloco 1 — Entendimento real (10min)

**1.1.** Conta a história de **um caso de hoje** desse processo. Do início
ao fim, na ordem. Pode pular detalhe que já está no doc, mas conta o que
não estava lá.

**1.2.** E o caso **mais difícil** que pegou esse mês? Por que foi difícil?
O que aprendeu?

**1.3.** Se você tivesse que treinar uma pessoa nova **em 30 minutos**, o que
diria de mais importante? O que **NÃO** está no manual mas é essencial?

## Bloco 2 — Heurísticas inconscientes (10min)

**2.1.** Olha pro caso de hoje (do bloco 1). Lista de tudo que você
**pensou e descartou** sem agir. Coisas tipo "ia ligar pro motorista mas vi
que ele tava na rota errada e desisti". Por que cada decisão?

**2.2.** Quando você **pula uma etapa** do "fluxo padrão"? Em que situações?
Por que pula?

**2.3.** O que faz você **decidir rapidamente** que tem que escalar pro
gestor? Não a regra escrita — o feeling. Que sinal te alerta?

## Bloco 3 — Comunicação com cliente (10min)

**3.1.** Liga uns 3 prints aleatórios das suas conversas com cliente desse
processo nesta semana. Pra cada print:
- Por que respondeu desse jeito (não outro)?
- Se o cliente fosse diferente, mudaria a resposta? Como?

**3.2.** Como você **adapta o tom** entre clientes diferentes? Como
identifica que precisa adaptar?

**3.3.** O que você **nunca diz** pro cliente nesse processo? (Frases
proibidas, pra não ter dor de cabeça depois.)

## Bloco 4 — Sistemas e atalhos (10min)

**4.1.** Mostra a tela do SSW agora, no caso de hoje. Aponta com o dedo
**onde olha primeiro, segundo, terceiro**. Por que essa ordem?

**4.2.** Tem algum "truque" no SSW que economiza tempo? (Atalhos, filtros
salvos, ordem de cliques específica, etc.)

**4.3.** Se um sistema cair (SSW, Bastão, WhatsApp), o que você faz como
plano B? Continua atendendo? Como?

## Bloco 5 — Erros e cantos escuros (5min)

**5.1.** Em que parte desse processo **você já errou** antes? O que aprendeu?

**5.2.** Tem caso específico que **você nunca consegue resolver bem**?
Como contorna?

**5.3.** Se você fosse fazer esse processo **sem o sistema atual**, faria
diferente? O que o sistema te força a fazer que não é ideal?

---

## Pra mim depois (Caio / Claude)

- Transcrição da entrevista vira input pra ajustar o `PROCESS_DESIGN_TEMPLATE.md` da operadora.
- Heurísticas do bloco 2 viram regras explícitas no prompt do agente.
- Frases do bloco 3 viram templates de mensagem.
- Atalhos do bloco 4 ajudam a priorizar quais campos o agente lê primeiro.
- Erros do bloco 5 viram **anti-padrões** no prompt ("não faça X").
