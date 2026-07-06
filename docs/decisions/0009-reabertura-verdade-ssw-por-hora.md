# 0009 — Reabertura de card pro relacionamento decide pela ORDEM do SSW; hora é fallback

Data: 2026-06-25
Status: aceito (no ar, validado ao vivo)

## Contexto

O sync-bastao decide se um card parado (TRANSFERIDO/etc, ou AGUARDANDO_CLIENTE) volta
pro relacionamento quando o Bastão sinaliza oc de relacionamento. O discriminador
"oc nova (reabre) vs lag do RPA (suprime)" comparava a **DATA** do Bastão
(`bastao_data_ultima_ocorrencia`, tipo `date`, sem hora) com a data do último lançamento
do Cockpit (`acoes_executadas_ssw.iniciado_em`). No mesmo dia colapsava em "suprime".

Com 50 filiais e 6000+ entregas/dia, **mesmo-dia é a NORMA** — a maioria dos cards tem
várias ocorrências por dia. Logo o discriminador por data era cego: escondia oc de
relacionamento genuinamente nova lançada no mesmo dia de um lançamento do Cockpit.
Caso âncora **NF 346778** (Cockpit lançou 33 às 09:23; Ressarcimento lançou 49 às 09:47
→ card sumiu de TRANSFERIDO, invisível no board). A tensão histórica (10415/351193 =
não re-mostrar tratado ↔ 346778/INV-019 = sempre visível) vinha justamente da fraqueza
do discriminador.

## Decisão

**Fonte de verdade = SSW** (o histórico tem a HORA de cada ocorrência, "DD/MM/YY HH:MM").
O Bastão (só data) é o **gatilho**; o SSW é o **decisor**. INV-023 (reescrito).

Função pura `decidirReaberturaPorOrdemSsw` (`_shared/lag-lancamento-54.ts`):
- SSW.oc mais recente é relacionamento ≠54 e está **acima** da última ocorrência
  lançada pelo Cockpit no próprio histórico SSW → **reabrir**.
- SSW.oc = 54 / não-relacionamento / própria oc lançada pelo Cockpit → **suprimir**.
- Se a última oc lançada pelo Cockpit não aparece no histórico, cai no fallback
  `decidirReaberturaPorSsw`: relacionamento provadamente anterior ao lançamento
  → suprime; posterior/sem hora parseável → reabre; SSW fora do ar → indefinido.

Refino 2026-06-29 (NF 346896): o Cockpit lançou 56, o SSW registrou a 56 às 13:12,
Operação lançou 19 às 13:13, mas `acoes_executadas_ssw.iniciado_em` ficou 13:14.
Comparar oc19 13:13 contra relógio interno 13:14 suprimia errado. A ordem SSW
agora vence o relógio interno.

### Custo (restrição explícita do Caio: SSW é caro em escala)
Amarrado ao **FLUXO (mudança do Bastão)**, nunca ao estoque. Três filtros antes da rede:
fast-path por data (`classificarPorData`) resolve os casos claros sem SSW; só mesmo-dia
consulta o SSW; cache em `historico_ssw` (<4h) só é aceito se a oc mais recente concorda
com a oc do Bastão. Cache divergente busca SSW fresco; sem tempo, fica indefinido em vez
de suprimir. `syncDeadlineExcedido` corta picos (→ indefinido/retry). Baseline já era
~450 consultas SSW/dia; adicional ≈ single digits/dia.

### Escopo
- TRANSFERIDO→relacionamento: `decidirReaberturaCandidato` substitui `ehLagDeLancamentoCockpit`.
- AGUARDANDO_CLIENTE→relacionamento ≠54: `naoRebaixarComDesempateSsw` passa a decidir por hora.
- Parser de hora consolidado em `_shared/ssw-data-hora.ts` (antes 2 cópias privadas).
- `descobrirUltimaOcSsw` devolve `dataBrtMs`/`dataRaw` (aditivo).

## Preserva (não regride)
- INV-003 (gate snapshot + safeguard 24h) intacto — só troquei a DECISÃO, não a seleção
  de candidato.
- INV-019 (3 camadas: Pass A + sweep + watchdog) intacto.
- R2: AGUARDANDO_CLIENTE → oc não-relacionamento → CONFLITOS (`flagConflitoOcSemMover`,
  Pass B) — caminho não tocado.

## Consequências
- Guard: `lag-lancamento-54.test.ts` + INV-023 no `/verify-cockpit` + este ADR.
- Validado ao vivo 2026-06-25: 346778 + 357224 reabriram; 24320/705486/705490
  seguiram suprimidos; bounce-back=0, INV-019=0. Reforçado em 2026-06-29 pela NF
  346896, que deve reabrir porque a oc19 está acima da 56 no SSW.
- Limite honesto: "mesma oc + mesma instrução + mesmo dia" (sem sinal de mudança) só é
  pego no dia seguinte (data muda) ou pelo safeguard 24h — raríssimo; fechar exigiria
  polling SSW por NF (o custo que evitamos).
