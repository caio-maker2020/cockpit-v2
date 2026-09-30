# 0036 — Agente D+4 do extravio: a marcação ganha volta, e a reincidência "achou e perdeu de novo" (em observação)

Status: proposto — branch `fix/extravio-d4-marcacao-e-reincidencia`, **não mergeado**
(decisões do Carlos em 29/09; merge e publicação só com ordem dele)

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
5. **Upgrade "achou e perdeu de novo"** (Carlos 29/09): extravio → 20 ("extravio
   localizado") → extravio recebe a 49 **no mesmo dia**, sem esperar o limiar
   (`ehReincidenciaAchouEPerdeu`).
   - Extravio → tratativa → extravio (sem 20), coleta (9) → transferência (6) e
     "06, 06" seguidos **não** contam.
   - **Nasce em observação:** com a flag `extravios_reincidencia_imediata_enabled`
     ausente ou OFF, o agente só anota em `agent_runs` (step `reincidencia`). Não lança
     e não toca no card: sem update e sem card_event.
   - Só lê o SSW de quem tem sinal de extravio anterior no Cockpit (proposta de
     extravio antes do dia do extravio atual, 49 já lançada ou outro card do mesmo
     CTRC), até 15 por hora, uma vez por (card, data do extravio).
   - Espera quando a rodada principal já usou o SSW naquela hora, porque o 429 da NF
     14877 nasceu numa rodada cheia.
   - Ligar é um `UPDATE`/`INSERT` na flag (TIPO B, autorizado pelo Carlos), sem nova
     publicação.

A **rodada principal** (cards sem marcação) segue **igual**: mesmo filtro, mesma régua,
mesma pré-checagem e mesmo envelope. Só deixou de terminar mais cedo quando não há
elegível, para as etapas novas rodarem.

## O que NÃO está coberto (resíduo consciente)

- **Primeiro extravio fora do alcance do Cockpit.** Se o primeiro extravio + 20 aconteceu
  sem o Cockpit ver (NF nunca importada), falta o sinal barato. O card segue a regra
  normal de dias. É conservador: nunca lança antes.
- **Marcação `nao_rodou` com ciclo novo** continua como está. O card já aparece para a
  operadora na coluna NÃO RODOU.
- **Reentrada silenciosa.** A volta de TRANSFERIDO para EXTRAVIO_MONITORADO no
  `sync-bastao` segue **sem card_event**. Isso fere a convenção 1. Fica fora desta
  mudança, para não mexer no `sync-bastao`. Recomendado em mudança própria.
- **Horário do "mesmo dia".** O agente roda das 8h às 18h BRT, em dias úteis. Extravio
  lançado fora disso recebe a 49 na próxima rodada útil.
- **Sem modo autônomo** (`extravios_agente_autonomo_enabled` OFF), a reavaliação não
  relança nada.

## Consequências

- **Na primeira rodada após publicar** (replay só leitura em 30/09):
  - nova 49 em 179061, 312687 e 787209 (ciclo novo) e em 2387808 (nova tentativa),
    sempre depois da pré-checagem SSW;
  - 789631 espera o limiar;
  - a observação leria o SSW de 36 cards ao longo das primeiras rodadas.
- **Guard:** INV-163 (testes de regra e de fiação, provados por mutação: 19 de 19) e o
  bloco da Fase 8.
- **INV-022 (DB)** passa a contar só o que está preso **no mesmo ciclo**. O ciclo novo
  esperando o limiar é legítimo e é medido pelo INV-163.
