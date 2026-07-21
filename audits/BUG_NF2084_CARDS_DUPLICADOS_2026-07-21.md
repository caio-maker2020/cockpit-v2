# BUG — NF 2084: 75 cards duplicados (loop de fabricação pelo sync)

> Dossiê de handoff (Claude Opus, 2026-07-21 ~21h30). Diagnóstico PARCIAL — mecânica
> evidenciada mas não 100% confirmada; a sessão que pegar isso deve fechar a
> confirmação antes de corrigir. Contexto completo: memória `regra-oc59-separacao-54-59`
> e docs/BOAS-PRATICAS-git-deploy.md (regressões pré-59 de 14-21/07).

## Sintoma observado
A NF **2084** tem **75 cards** na tabela `cards` (2 CTRCs distintos): 1 original de
26/05 + **17 criados em 14/07** + **57 criados em 15/07** (rajada compatível com o
ciclo de 5 min do sync). Todos em estado terminal hoje (RESOLVIDO/TRANSFERIDO);
30 deles TRANSFERIDO com oc 59. Nenhum card ativo da NF no momento do dossiê.

## Comportamento esperado
No máximo **1 card ativo por NF** (garantido por `uniq_cards_nf_active`) e cards
terminais não deveriam se multiplicar — re-ocorrência legítima cria no máximo 1 novo.

## Evidências verificadas (2026-07-21)
- `select count(*) from cards where nf='2084'` → **75**; criação concentrada em
  14-15/07 (17 + 57); canais só `sistema`.
- Criadores (primeiro evento de cada card): `BastaoCardImportado` (43) e
  `ExtravioImportado` (32) — **ambos actor `sync-bastao`**.
- Schema: `uniq_cards_nf_active` é UNIQUE **parcial** — só vale para
  `state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO')`. Card terminal SAI do UNIQUE.
- Timing: 14-15/07 = exatamente a janela em que o backfill em massa lançou a oc 59
  (351 cards) e as funções deployadas pré-59 roteavam **oc 59 → TRANSFERIDO**
  (regressão corrigida em 21/07 — ver memória).

## Hipóteses consideradas
- **H1 (mecânica provável, ~90%):** loop de fabricação — a pendência da NF 2084
  seguia no Bastão com oc 59; o sync pré-59 criava o card e (ele ou o roteamento)
  o mandava pra **TRANSFERIDO** (terminal) → o card saía do UNIQUE parcial → no
  ciclo seguinte o sync via "NF com pendência e sem card ativo" → **criava outro**
  → TRANSFERIDO de novo → repete a cada ~5 min. 57 cards num dia bate com isso.
- **H2:** duplicação por 2 CTRCs (encerrar-por-troca-de-CTRC em loop) — os 2 CTRCs
  distintos podem ter alimentado ping-pong. Pode ser fator agravante da H1.

## Hipóteses descartadas
- Criação manual/operador (canais 100% `sistema`, actor 100% sync-bastao).
- Bug ativo HOJE: **hipótese não confirmada, mas improvável** — o sync-bastao foi
  redeployado pós-59 em 21/07 (`stateFinal(59)=AGUARDANDO_CLIENTE`, card fica ativo
  e o UNIQUE segura). A rajada PAROU em 15/07. Ainda assim, CONFIRMAR (ver abaixo).

## Causa raiz (a confirmar pela sessão que corrigir)
**H1 = fato quase fechado, falta a prova final:** reconstituir com `card_events`
de 2-3 cards da rajada (sequência criação→transferido→novo card ~5min depois) e
conferir se a pendência 2084 constava no Bastão nesses dias. Estrutural: o
**UNIQUE parcial não protege contra loop criação→terminal→recriação**.

## Fix proposto (3 camadas — raiz, não sintoma)
1. **Guard anti-loop no sync** (raiz): antes de criar card pra uma NF, se já
   existem ≥N cards TERMINAIS da mesma NF criados nas últimas 24h (ex.: N=3),
   NÃO criar — logar + card_event de anomalia (`LoopCriacaoCardDetectado`) num
   card existente. Protege contra QUALQUER regressão futura de roteamento, não
   só a da 59 (a causa específica de 14-15/07 já foi corrigida em 21/07).
2. **Limpeza dos dados**: manter o card mais recente/correto da NF 2084 (checar a
   oc real no SSW — se 59 ativa, o sync pós-59 já deve ter criado 1 ativo em
   AGUARDANDO_CLIENTE; senão criar/validar) e marcar os ~74 duplicados —
   sugestão: `CANCELADO` + `card_event` `DuplicadoLimpezaNf2084` (NÃO deletar —
   event sourcing). Verificar se outras NFs têm o mesmo padrão:
   `select nf, count(*) from cards group by nf having count(*) > 5 order by 2 desc;`
3. **Guard permanente**: item novo no `/verify-cockpit` (INV-040?): "nenhuma NF
   com >3 cards criados em 24h" (query de produção) + teste do guard anti-loop.

## Riscos / blast radius
- A limpeza é só-dados (terminais → CANCELADO): risco baixo, mas rodar a query de
  "outras NFs" antes — se o padrão for amplo, dimensionar antes de cancelar em massa.
- O guard anti-loop toca o `sync-bastao` (função mais crítica do sistema): mudança
  mínima, com teste; **deploy só via deploy-gate** (checkout atualizado, master).
- NÃO mexer no UNIQUE parcial (mudá-lo pra incluir terminais quebraria re-ocorrência
  legítima de NF — comportamento desejado documentado no handleExtravioPendencia).

## Como validar
1. Prova da mecânica: timeline de 2-3 cards da rajada (criação→TRANSFERIDO→novo).
2. Pós-limpeza: `select count(*) from cards where nf='2084'` → 1-2 legítimos +
   canceladas auditáveis; nenhuma outra NF com padrão de rajada.
3. Guard: simular pendência que re-cria (teste unitário do ramo) → 4ª criação em
   24h bloqueada + evento de anomalia.
4. `/verify-cockpit` INV novo: PASS.

## Checklist de fechamento (convenção nº 8)
- [ ] Teste anti-regressão do guard anti-loop
- [ ] card_events de limpeza (auditável)
- [ ] Item no /verify-cockpit
- [ ] Memória atualizada (mecânica confirmada + números finais)
- [ ] Sem migration necessária (a menos que opte por índice/constraint novo — aí skill supabase-postgres-best-practices)
