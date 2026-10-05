# 0037 — A sugestão do agente vale por ENTRADA do card, e o ciclo conta só entrada no Relacionamento

Status: proposto — branch `fix/sugestao-por-entrada-e-ciclos`, aguardando validação do
Caio para merge. Nada publicado.

## Contexto

Em 05/10 o Caio relatou cards sem sugestão do agente. A medição de 14 dias (por
aprovação do operador) mostrou que a falta se concentra na ocorrência REPETIDA no card:
96% com análise do ciclo na 1ª vez (156/162) contra 67% na repetição (39/58).

Causas provadas, independentes (detalhe e casos em INV-168):

1. INV-164 (corte por idade do card) — já corrigido em 01/10.
2. Teto vitalício de 3 tentativas do `agente-sugere-ocs-padrao`: o contador soma
   análises bem-sucedidas da vida inteira do card e nunca zera.
3. O Pass A do `sync-bastao` decidia a TRANSIÇÃO pela hora real do SSW e a GRAVAÇÃO da
   oc pela data (Porta 4, `<=`). No mesmo dia as duas discordavam e o card ficava em
   AGUARDANDO VOCÊ com a oc antiga gravada.

Junto, o Caio pediu um contador de ciclos no card da sugestão e ajustou a definição de
ciclo validada em 25/08.

## Decisão

**Sugestão por entrada.** A unidade passa a ser a ENTRADA do card em tratativa (abertura
de ciclo, ou volta dentro do ciclo — 54/59 respondida pela operação com oc nova). A
análise guardada é invalidada, com as tentativas zeradas, quando existe evento de entrada
posterior a ela ou quando o histórico mostra ocorrência do mesmo código mais nova que a
analisada (`oc_data_analisada`). Cada invalidação grava `AnaliseInvalidadaPorNovaEntrada`;
teto de 3 por card em 24h contra loop de custo.

**Porta 4.** Se a rodada moveu ou reabriu o card por causa da oc, a oc é gravada. Sem
transição, o eco por data continua preservando a oc do card (NF 306070).

**Ciclo** (Caio 05/10):

- abre na entrada/reabertura do card no Relacionamento com ocorrência de relacionamento
  (a oc 13 só para os clientes com a exceção — já é assim na importação);
- a ocorrência de extravio (6/9/16) NÃO abre ciclo;
- a 49 lançada pelo Cockpit no extravio monitorado ABRE ciclo, inclusive em card que já
  teve ciclo antes; a reabertura que o sync registra em seguida é a mesma entrada;
- reaberturas seguidas sem nenhuma ação executada no meio contam como UMA entrada;
- 54/59 respondida com oc nova, e resposta de cliente, são ETAPAS do mesmo ciclo.

**Tela.** Chip "Ciclo N · etapa M" abaixo da sugestão (PainelDecisao), com pop-up no
clique listando, por ciclo, o que trouxe o card, o que o agente sugeriu (ou que não
sugeriu) e o que foi lançado. Lê só `card_events`; sem migration.

## Consequências

- Mais re-análises de IA: uma por entrada repetida (ordem de dezenas por quinzena).
- A re-análise roda o caminho completo do agente (menu de propostas e janela de veto),
  com as cercas que já existem.
- O número de ciclo de cards de extravio muda nas listas da gestão e na Memória do Card
  (`estado_tratativa`), que usam a mesma biblioteca. Aberturas descartadas (extravio,
  reabertura repetida) só AMPLIAM a janela do "já feito neste ciclo"; a 49 autônoma
  como abertura corta a janela no lançamento dela, onde antes cortava na importação do
  extravio (não há ação do Cockpit entre os dois pontos no fluxo normal).
- Retroativo: nenhum UPDATE manual. Os cards hoje no teto são destravados pela própria
  regra na próxima entrada; em 05/10 não havia card preso em nenhuma das duas condições.

## Fora deste ADR

- A 49 "não reconhecida" (332 de 2.076 análises em 14 dias sem destaque, por desenho).
- Ocorrências 8/20/23/26: têm menu de opções, mas nenhum agente destaca recomendada.
- O vai-e-volta da oc 57 (causa não investigada; o contador só deixou de inflar).
