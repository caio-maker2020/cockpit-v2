# ADR 0017 — Automação da oc 43 v2: relançamento da última ocorrência

Data: 2026-08-28 · Decisor: Caio · Status: aprovado (plano validado no chat)

## Contexto
A automação da oc 43 (manutenção de perecível; Duílio 29/07) lançava uma oc 49
com carimbo genérico quando a ocorrência anterior era de problema — gerando
74 decisões/mês "não reconhecido" no agente da 49 (100% de fracasso de leitura,
caso âncora NF 289700) e mascarando a tratativa real.

## Decisão (regra v2)
Card entra em 43 → olha a última ocorrência imediatamente anterior (pulando 43s):
- **6/9/16 (extravio)** → NADA é lançado; card volta a `EXTRAVIO_MONITORADO`
  com o relógio contando da DATA DO EXTRAVIO ORIGINAL
  (`agent_state.extravio_retomado_pos43`; kanban e agente D4 honram — B4);
- **relacionamento + 13 + 31** → RELANÇA A MESMA oc, herdando a instrução
  original sanitizada + sufixo " — RELANCADA POS MANUTENCAO PERECIVEL (OC 43)";
  49 herda o texto da 49 original; 54/59 relançam SEM e-mail (B1-B3);
- **operacional/trânsito** → 55 (como antes);
- sem anterior / SSW moveu → sem ação (como antes).

## Exceção deliberada
Esta automação PODE relançar ocorrências de relacionamento (10/20/35/...).
A regra "Cockpit nunca lança oc de relacionamento" (INV-117) vale para o
agente de SUGESTÕES da 49 — não para este trilho. Não "consertar".

## Leitura de evidência
Relançamentos não carregam foto — a análise acha a foto da LINHA ORIGINAL por
construção (`verificar-evidencia` varre todas as linhas do código, NF 29326).

## Rollout
Flag `oc43_regra_v2_enabled` (mig 367): OFF = sombra (evento `Oc43SombraV2`
com v1×v2 por card, 24h de medição); ON = v2 assume. Guard INV-120.
