# 0036 — Agente D+4 do extravio: a marcação ganha volta, e a reincidência recebe a 49 no mesmo dia (em observação)

Status: aceito — mergeado na master em 30/09 com autorização do Carlos (`e9c6b00`);
**publicado em produção em 30/09 às 19:44Z (16:44 BRT)**, também com autorização do
Carlos (`agente-extravio-d4` v17), **com as duas chaves da reincidência desligadas** por
ordem dele (registro em "Publicação")

## Contexto

A Larissa não recebeu dois extravios de CT-e de reversa (29/09):

- **NF 14877 (TUI380374-1):** extravio em 15/09. O agente agiu no dia certo (21/09,
  4 dias úteis), mas o SSW recusou a 49 (`http_status=429`). O executor reverteu o
  card para EXTRAVIO_MONITORADO e a marcação ficou `lancou`.
- **NF 787209 (JRA442006-3):** a 49 saiu em 16/09 e a Larissa tratou (oc 56). Em 23/09
  veio um **novo** extravio. O `sync-bastao` devolveu o card para Extravios (vindo de
  TRANSFERIDO, sem card_event) sem desfazer a marcação `lancou` de 16/09.

**Causa única:** o scan só olha `agente_extravio_status IS NULL`, e a marcação `lancou`
é gravada logo depois de `auto_aprovar_e_executar`, antes do resultado do executor.
Ela só é zerada no `agente-oc43-autonomo`. Um card marcado some do radar, tanto quando
a 49 falha quanto quando chega um ciclo novo.

**Não é regra de reversa.** A contagem de dias é a mesma para todo CT-e
(`bastao_data_ultima_ocorrencia` + `dias_uteis_entre`). Em 29/09, as duas situações
tinham 5 cards normais e 4 de reversa. O alarme INV-022 (DB) já acusava
`lancou_preso_em_extravio=5` e estava entre os FAIL antigos.

## Decisão

1. **A decisão é derivada dos dados a cada rodada**
   (`_shared/agente-extravio-reavaliacao.ts`, função pura). Não depende de outro
   fluxo zerar campo. É a mesma lição da trava de CCE (ADR 0035).
2. **A 49 falhou no SSW:** o agente tenta de novo na hora seguinte, até **3 vezes por
   ciclo**. A falha tem de ser do todo da última 49 do agente (`AcaoRevertidaPosFalha`
   com o mesmo `todo_id`). Esgotadas as tentativas, o card vai para **NÃO RODOU** com o
   motivo (`motivoFalhasSsw`), e a operadora vê.
3. **Ciclo novo** (o extravio atual é outro): o card volta à régua de sempre
   (cliente > operador > 4 dias úteis) e passa pela mesma pré-checagem SSW.
4. **Todo `AgenteExtravioLancou49` grava `data_extravio`.** É o que separa ciclo novo
   do mesmo ciclo (`ehCicloNovo`):
   - extravio **mais novo** que o tratado → ciclo novo;
   - igual → mesmo ciclo (a 49 imediata da reincidência nunca relança);
   - mais velho → Bastão atrasado.
   Lançamentos antigos, sem o campo, usam a data do dia da marcação. Isso vale porque o
   caminho antigo só lançava com 2 ou mais dias úteis de extravio.
5. **Upgrade: a reincidência recebe a 49 no mesmo dia**, sem esperar o limiar, em dois
   tipos (`classificarReincidencia`):
   - **"Achou e perdeu de novo"** (Carlos 29/09): extravio → 20 ("extravio localizado")
     → extravio (`ehReincidenciaAchouEPerdeu`).
   - **"Já tratado e extraviou de novo"** (Carlos 30/09): extravio → tratativa →
     extravio (`ehReincidenciaJaTratado`). Tratativa = `OCS_TRATATIVA_EXTRAVIO`:
     49 tratativa de relacionamento, 54 aguardando retorno do cliente pagador, 56 falta
     de informação operacional ou indevida, 59 pendência de documentação para
     ressarcimento, 33 reversão de perdas iniciada, 46 em análise de ressarcimento,
     42/47 ressarcimento finalizado. A **55** (autorizado seguir / entrega parcial)
     **não** conta. A **49 do próprio agente conta**: na NF 756245 a filial relançou a
     6 horas depois da 49 do agente, sem a carga andar, e o Carlos confirmou que também
     deve sair a 49.
   - Só movimento da carga entre os dois extravios (viagem, chegada na base), coleta
     (9) → transferência (6) sem tratativa e "06, 06" seguidos **não** contam. Uma
     coleta que foi tratada antes do novo extravio conta como "já tratado".
   - **Cada tipo tem a sua chave** (`deveLancarReincidencia`):
     `extravios_reincidencia_achou_perdeu_enabled` e
     `extravios_reincidencia_ja_tratado_enabled`. Um card que se encaixa nos dois tipos
     lança se qualquer um dos dois estiver ligado. Com a chave do "já tratado"
     desligada, a decisão é exatamente a do "achou e perdeu" sozinho.
   - **Os dois nascem em observação:** com a chave ausente ou OFF, o agente só anota em
     `agent_runs` (step `reincidencia`, com `achou_e_perdeu` e `ja_tratado` no output).
     Não lança e não toca no card: sem update e sem card_event.
   - Só lê o SSW de quem tem sinal de extravio anterior no Cockpit (proposta de
     extravio antes do dia do extravio atual, 49 já lançada ou outro card do mesmo
     CTRC), até 15 por hora, uma vez por (card, data do extravio). O "já tratado" não
     aumenta essas leituras: o filtro de quem é lido é o mesmo.
   - Espera quando a rodada principal já usou o SSW naquela hora, porque o 429 da NF
     14877 nasceu numa rodada cheia.
   - Ligar é um `UPDATE`/`INSERT` na chave (TIPO B, autorizado pelo Carlos), sem nova
     publicação. Vale para os extravios avaliados dali em diante: quem já foi anotado na
     observação segue a régua normal, então ligar não solta uma rajada de 49.

A **rodada principal** (cards sem marcação) segue **igual**: mesmo filtro, mesma régua,
mesma pré-checagem e mesmo envelope. Só deixou de terminar mais cedo quando não há
elegível, para as etapas novas rodarem.

## O que NÃO está coberto (resíduo consciente)

- **Primeiro extravio fora do alcance do Cockpit.** Se o primeiro extravio (e o 20 ou a
  tratativa) aconteceu sem o Cockpit ver (NF nunca importada), falta o sinal barato. O
  card segue a regra normal de dias. É conservador: nunca lança antes.
- **Mesmo extravio relançado.** Pelo histórico do SSW não dá para separar um extravio
  novo da mesma perda registrada de novo depois de uma tratativa (NF 756245). Pela
  decisão do Carlos, os dois recebem a 49 no mesmo dia. A observação mostra quantos são
  antes de ligar.
- **Marcação `nao_rodou` com ciclo novo** continua como está. O card já aparece para a
  operadora na coluna NÃO RODOU.
- **Reentrada silenciosa.** A volta de TRANSFERIDO para EXTRAVIO_MONITORADO no
  `sync-bastao` segue **sem card_event**. Isso fere a convenção 1. Fica fora desta
  mudança, para não mexer no `sync-bastao`. Recomendado em mudança própria.
- **Horário do "mesmo dia".** O agendador chama o agente de hora em hora, das 8h às 18h
  BRT, em dias úteis, mas a trava de horário comercial (`isHorarioComercialBRT`: 8h ≤
  hora < 18h) faz a chamada das 18h sair sem fazer nada. Na prática, a última rodada
  do dia é a das **17h**. Extravio lançado depois disso recebe a 49 na próxima rodada
  útil. (Corrigido em 01/10: o texto anterior dizia "até 18h"; a rodada das 18h de 30/09
  durou 0,9 s e não consultou a aba, contra 40,7 s da rodada das 17h.)
- **Prazo por cliente numa consulta só.** A observação busca os prazos de todos os
  clientes da aba numa única consulta, como a rodada principal já fazia, e um erro
  nessa consulta não é acusado (o prazo cai para o da operadora ou 4). Em 01/10 eram
  134 CNPJs (cerca de 2 KB), 5 vezes abaixo do tamanho em que uma lista longa já falhou
  calada. Se a aba crescer muito, dividir em lotes, como já é feito com os ids.
- **Sem modo autônomo** (`extravios_agente_autonomo_enabled` OFF), a reavaliação não
  relança nada.

## Consequências

- **Na primeira rodada após publicar** (replay só leitura em 30/09):
  - nova 49 em 179061, 312687 e 787209 (ciclo novo) e em 2387808 (nova tentativa),
    sempre depois da pré-checagem SSW;
  - 789631 espera o limiar;
  - a observação leria o SSW de 36 cards ao longo das primeiras rodadas (40 na
    medição de 30/09 à tarde).
  - 787209 e 179061 também se encaixam no "já tratado", mas já passaram do limiar e
    recebem a 49 pelo ciclo novo: a ampliação não muda a primeira rodada.
- **Impacto medido do "já tratado"** (replay com o código novo nos 307 históricos do
  SSW guardados no Cockpit, 30/09): 39 novos extravios depois de outro; 21 pelo
  "achou e perdeu", 25 com o "já tratado" (+4: NFs 383793 duas vezes, 817275,
  756245). Nenhum caso do "achou e perdeu" se perde.
- **Guard:** INV-163 (testes de regra e de fiação, provados por mutação: 38 de 38; os
  históricos possíveis de até 6 ocorrências conferidos contra a definição) e o bloco
  da Fase 8, que também trava a lista de tratativas.
- **INV-022 (DB)** passa a contar só o que está preso **no mesmo ciclo**. O ciclo novo
  esperando o limiar é legítimo e é medido pelo INV-163.

## Publicação

**30/09 — merge e publicação, ambos com autorização do Carlos.**

- **Merge:** `e9c6b00`, enviado ao GitHub. A Vercel republicou a tela às 19:05Z sem
  nenhuma mudança (nenhum arquivo da tela no pacote).
- **Antes do deploy:** master = GitHub; `deploy_pendente` listava só o
  `agente-extravio-d4`; as duas chaves da reincidência ausentes; modo autônomo ligado;
  pulso 17 s.
- **Deploy:** `agente-extravio-d4` v17 às 19:44Z (16:44 BRT). Ordem do Carlos: "pode
  publicar, mas n ligue as chaves". As chaves `extravios_reincidencia_achou_perdeu_enabled`
  e `extravios_reincidencia_ja_tratado_enabled` **não foram criadas**: ligar cada uma é
  ato separado, com nova ordem dele.
- **Depois do deploy:** `deploy_pendente` zerado; pulso 17 s.

**1ª rodada com o código novo (30/09, 17h BRT):** HTTP 200 em 40,7 s, 0 erros.

| NF | Operadora | Resultado |
|---|---|---|
| 787209 (âncora) | LARISSA | 49 aceita pelo SSW às 17h02 (ciclo novo) |
| 179061 | ISABELY | 49 aceita às 17h01 (ciclo novo) |
| 312687 | DUILIO | 49 aceita às 17h03 (ciclo novo) |
| 2387808 | DUILIO | 49 aceita às 17h02 (2ª tentativa; a 1ª falhou em 23/09) |
| 789631 | — | aguardando o limiar |

- As 4 com `AcaoExecutadaConfirmadaPeloSsw`; os cards foram para
  AGUARDANDO_VALIDACAO_HUMANA. Cada `AgenteExtravioLancou49` gravou `data_extravio`
  (16/09, 16/09, 23/09, 24/09).
- A rodada principal não tinha elegível nessa hora. A observação foi adiada de
  propósito: a reavaliação usou o SSW na mesma hora.
- **INV-163 (DB) passou a PASS:** `acima_do_teto=0`, `ciclo_novo_vencido=0`.
- **INV-022 (DB) segue com 2:** NFs 639815 e 559067. Os dois receberam a 49 do agente às
  8h de 30/09 (código antigo) e a 55 aprovada pela operadora às 8h22, ambas aceitas pelo
  SSW, e voltaram para a aba Extravios sem card_event. O agente acertou em não lançar
  outra 49 às 17h (mesmo extravio). **Hipótese não confirmada:** é a reentrada silenciosa
  do `sync-bastao` (resíduo acima).

**Rodadas seguintes:**

- **30/09, 18h:** o agente saiu na trava de horário comercial (0,9 s, nenhuma consulta à
  aba), como sempre foi.
- **01/10, 8h:** rodada principal com 29 elegíveis e 18 49 lançadas, 0 erros; observação
  adiada (SSW usado na hora).
