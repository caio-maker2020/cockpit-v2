# ADR 0033 — Segregar CTRC: ação irreversível pelo sistema, logo só humana

Data: 2026-09-21
Status: aceito (branch `segregar-ctrc-prati`; nada aplicado nem deployado — migration 407
e Edge Functions aguardam ordem do Carlos)
Autor da regra: Caio (pedido da PRATI, chat 21/09)
Guards: **INV-158** · migration `2026-09-21_407_cliente_config_segregacao_ctrc.sql`
Relacionados: ADR 0025 (whitelist de cliente para ação sem desfazer), ADR 0016 (janela de
veto), ADR 0023 (dossiê da 33)

## Contexto

A PRATI pediu poder **barrar a carga** junto com a ocorrência de cliente do card de
extravio. No portal SSW isso é o campo **"Segregar CTRC"** da tela 101 (opção
Ocorrências), marcado no **mesmo submit** da ocorrência — não é tela separada nem uma
segunda chamada.

O campo foi confirmado lendo o HTML real do form `act=O` (diagnóstico no CT-e de teste
AMB588507-8), **não por inferência**:

```html
<input name="f8" exc="1" id="8" value="N" maxlength="1" ...>
```

O outro campo S/N da **mesma** tela é o `f11` = "Resposta a um Fale Conosco". Trocar os
dois manda resposta de Fale Conosco e **não** segrega: falha silenciosa com cara de
sucesso. Por isso o campo está nomeado e comentado em `_shared/ssw-internal-client.ts`,
não escrito solto no submit.

O que "segregar" faz no SSW: bloqueia o CT-e para **transferência, movimentação e
entrega** (não romaneia). A carga para fisicamente.

**A assimetria que define este ADR:** marcar é uma linha no submit; **desmarcar não existe
no Cockpit**. A retirada da segregação é **manual, pelo operador, na opção 091 do SSW**.
Não há RPC, não há rollback, não há "cancelar ação" — o event sourcing do card registra
que aconteceu, e não desfaz nada no TMS.

Escopo fechado pelo Caio no chat de 21/09, verbatim: *"só PRATI, só oc 54/59, só ação
manual da operadora, somente nos cards de extravio"*.

Medição em produção na mesma data: CNPJ `73856593001057` tem 631 cards e 5 em extravio
(4 de oc 06 + 1 de oc 09); CNPJ `73856593000166` está cadastrado e ativo mas ainda sem
card — entra na whitelist preventivamente para o grupo não nascer pela metade (lição da
mig 387 / oc 13).

## Decisão

### D1 — O campo f8 vai no MESMO submit da ocorrência

A segregação não é ação própria: é um campo do formulário que o executor já envia. Sai
pelo envelope `lancarSswPortal` (`_shared/lancar-ssw-portal.ts`), que continua sendo a
única porta pro portal, com idempotência por `(card_id, codigo_oc, ctrc)` e o guard do
tripé CTRC+NF+Localização antes do submit — nada disso foi afrouxado.

Consequência boa: **não existe meia-ação**. Ou sai ocorrência + segregação, ou não sai
nada. Uma segunda chamada criaria o estado "ocorrência lançada e segregação perdida"
(ou o inverso), que ninguém saberia reconciliar — justamente numa ação sem desfazer.

### D2 — Cerca QUÁDRUPLA, fail-closed, em `_shared/segregacao-ctrc.ts`

`segregacaoPermitida()` é função pura e só devolve `true` quando **as quatro** condições
valem ao mesmo tempo:

| # | Condição | Onde vem |
|---|---|---|
| 1 | CNPJ pagador na **whitelist ativa** | `cliente_config_segregacao_ctrc` (mig 407), atrás da flag mestra |
| 2 | Ocorrência sendo lançada ∈ **{54, 59}** | `OCS_COM_SEGREGACAO` |
| 3 | O **card é de extravio** — oc ∈ {6, 9, 16, 49} | `OCS_CARD_EXTRAVIO` |
| 4 | **Aprovação humana comprovada** | `origemHumanaComprovada({leuTodo, regraAuto})` |

Qualquer falha — CNPJ inválido, oc fora do par, card que não é de extravio, whitelist
vazia, tabela ausente, erro de permissão, exceção no loader — devolve `false` e o portal
recebe o default `"N"`. **Fail-closed em todas as pontas.**

Dois pontos que a auditoria pré-merge do próprio 21/09 corrigiu, e que são o conteúdo
real da cerca:

- **(3) não estava no código.** A frase "somente nos cards de extravio" existia no pedido,
  no cabeçalho da migration e no texto da tela — e **não** na função. Um card da PRATI em
  RECUSA (oc 10/11/35) com proposta de 54 passava pela cerca e barrava a carga de uma
  recusa. O conjunto usa `{6, 9, 16}` (as ocorrências de extravio do SSW, iguais a
  `EXTRAVIO_OCS` em `agente-extravio-regras.ts`) **mais 49** ("PRAZO DE PERDAS EXPIRADO"),
  que o robô lança no D+4 e que é a última ocorrência do card exatamente no momento em que
  a operadora recebe a sugestão de 54/59 — o momento em que ela marca.
  A leitura usa **duas fontes** (`agent_state.cod_ultima_ocorrencia` **e**
  `cards.cod_ultima_ocorrencia`) e basta uma bater: o executor sobrescreve o campo do card
  a cada lançamento, então olhar só ele **bloquearia o fluxo real de extravio em
  silêncio** — o modo de falha oposto e igualmente ruim.

- **(4) era fail-OPEN.** O executor lia `todos.auto_approval_rule` ignorando o `error` do
  SELECT e colapsava três estados em "regra nula" = "foi humano": (a) todo humano de
  verdade, (b) erro de query/RLS/timeout, (c) todo inexistente. Em (b) e (c) não dá para
  **afirmar** que alguém olhou. `origemHumanaComprovada` separa os três: sem leitura
  provada do todo, não segrega. **Ausência de prova não é prova de ausência de robô.**

Recusa da cerca é **auditável**: `card_event` `SegregacaoCtrcRecusadaPelaCerca` com o
motivo discriminado (não leu o todo / aprovação automática / cliente ou oc inelegível).
Sucesso também deixa evento próprio. Sem isso viraria "não segregou e ninguém sabe por
quê".

### D3 — `segregar_ctrc` é flag de CONTROLE, nunca texto

Fica **fora** de `EXTRAS_PRA_DESCRICAO_SSW` (regra do Caio 2026-06-10, whitelist
explícita). Se entrasse, vazaria para a Instrução do SSW como `segregar_ctrc: true` —
o mesmo vazamento de `validar_evidencia: false` que já aconteceu.

### D4 — Kill-switch por feature flag, e tudo nasce OFF

`segregacao_ctrc_enabled` (mig 407) é o interruptor mestre, sem deploy. Com a flag OFF o
loader devolve conjunto vazio **antes** de consultar a whitelist: ninguém segrega, mesmo
whitelistado. Os 2 CNPJs da PRATI entram com `ativo = false`. Aplicar a migration **não
liga nada** — o smoke test inline da própria migration falha se algum CNPJ nascer ativo ou
se a flag nascer ON.

O front lê um único boolean pela RPC `cliente_pode_segregar_ctrc(cnpj)` (SECURITY DEFINER,
`search_path` fixo), porque a tabela é service-only. Isso é **visibilidade**, não
autonomia: mostrar a caixinha não segrega nada, e o executor revalida a cerca inteira de
qualquer jeito (INV-148 — visibilidade e autonomia são interruptores separados).

### D5 — Robô NUNCA segrega

Consequência direta da irreversibilidade, e a razão de a condição (4) existir. Nenhum
agente autônomo — `agente-extravio-d4`, `agente-ressarcimento`, `seguir-parcial-auto` ou
qualquer futuro — pode ligar o f8, porque todos aprovam com `auto_approval_rule`
preenchido. Não há flag que libere isso; a única forma seria mudar a cerca, e o INV-158
acusa.

## A regra geral que fica (o valor durável deste ADR)

> **Ação que o sistema não sabe desfazer não entra em autonomia.**

Não é sobre segregação. É o critério para qualquer capacidade nova:

1. **Existe caminho de volta DENTRO do Cockpit?** Se a resposta for "o operador desfaz à
   mão em outro sistema", a ação é **humana por construção** — não é candidata a
   autonomia, nem hoje nem com mais acurácia medida amanhã.
2. Ação irreversível pede **whitelist explícita de cliente**, não regra geral: o blast
   radius é o universo de quem está na lista (ADR 0025 chegou ao mesmo lugar por outro
   caminho — ocorrência no SSW não tem desfazer).
3. Ação irreversível pede **prova de origem humana**, não ausência de sinal de robô. Toda
   dúvida de leitura vira "não".
4. Ação irreversível pede **evento de recusa**, não só de sucesso: quem foi barrado
   precisa aparecer numa consulta.

Ponto de contraste deliberado: a oc 55 automática (ADR 0025) **é** autônoma e **também**
não tem desfazer no SSW. A diferença é quem paga o erro — uma 55 errada é uma ocorrência
errada no histórico, e uma segregação errada é **carga parada no armazém** até alguém
perceber e ir ao SSW retirar. O critério não é "tem desfazer?" isolado, é
**irreversibilidade × efeito físico**.

## O que ficou DELIBERADAMENTE de fora

Registrado porque "não implementado" e "esquecido" são indistinguíveis depois de três
meses — e porque os dois itens abaixo parecem bugs para quem ler o código sem este texto.

### (a) O gêmeo `meta.sem_email_explicito`

A tela tem duas variantes da mesma oc de cliente: a "54 + e-mail" (abre o composer, tem o
painel expandido, e é **onde a caixinha de segregar vive**) e a "54 SEM e-mail"
(`tool=lancar_ocorrencia` + `meta.sem_email_explicito=true`), que aprova **direto num
`window.confirm`**, sem painel e sem extras editáveis.

O gêmeo **não** oferece a marcação. Isso é escolha, não omissão: o `window.confirm` é uma
confirmação de "o cliente não será notificado", não uma tela onde a operadora escolhe
barrar carga. Enfiar a segregação ali significaria decidir uma ação irreversível num
diálogo nativo do browser, com um clique, sem ver o CTRC. Se algum dia a PRATI pedir
segregação sem e-mail, o caminho é **dar painel ao gêmeo**, não dar segregação ao confirm.

### (b) O combo 44 + 59

O fluxo `modal-combo-4459` lança duas ocorrências pelo mesmo modal. A 59 dele **não**
carrega a marcação. Motivo: o combo tem payload próprio e ordem própria de lançamento, e
misturar a segregação ali exigiria decidir em qual das duas o f8 entra e o que acontece
quando a primeira passa e a segunda falha — exatamente o estado intermediário que o D1
existe para não criar. Fica fora até haver pedido real.

### (c) Retroativo, desfazer e alarme de carga parada

Nada de retroativo (nenhum CT-e já lançado é segregado depois). Nenhuma automação de
retirada (opção 091 é RPA que não existe e não está pedida). Nenhum watchdog de "CT-e
segregado há N dias" — se a PRATI ligar a marcação de verdade, este é o primeiro candidato
a entrar, porque hoje a única memória de que a carga está barrada é o evento no card.

## Consequências

**Positivas**

- A PRATI passa a conseguir, em um clique da operadora e no mesmo submit, o que hoje é um
  pedido por e-mail para a operação fazer à mão no SSW.
- A exceção fica numa tabela dedicada, auditável e fácil de desmontar (molde das mig 379 /
  121), com `autorizado_por` e `autorizado_em` — a ordem de barrar carga tem dono.
- Nenhum outro cliente muda de comportamento: com a flag OFF e a whitelist vazia de ativos,
  o sistema é byte a byte o de hoje.

**Negativas / riscos aceitos**

- **Segregação indevida para a carga fisicamente**, e o conserto é humano, em outro
  sistema. Mitigado pelas quatro condições + evento de recusa + estreia com os dois CNPJs
  inativos.
- Mais um campo no submit do portal: um erro de nome (`f8` × `f11`) falha em silêncio com
  cara de sucesso. Mitigado pelo teste de submit que prova que `f8` só vira `"S"` quando
  marcado, e que `f11` não é tocado.
- A caixinha aparece na tela de quem estiver na whitelist mesmo em card que a cerca do
  backend vai recusar — o oposto do INV-152. Aceito nesta rodada porque a condição que o
  front não conhece (card de extravio) é a mesma que a recusa registra em evento; se
  aparecer recusa na prática, o front passa a filtrar pelas ocs do card.

## Como validar

```bash
deno test --allow-all --no-check supabase/functions/_shared/segregacao-ctrc*.test.ts
cd apps/cockpit-web && npx vitest run src/components/cards/EditarEmailModal.segregacao.test.tsx
```

E o bloco **INV-158** da Fase 8 do `/verify-cockpit`, que além dos testes cobra os dois
conjuntos ({54,59} e {6,9,16,49}), o import da cerca pelo executor, e — no banco — que
nenhum CNPJ esteja ativo sem `autorizado_por`, nem ativo ao mesmo tempo aqui e em
`cliente_config_seguir_parcial_auto` (ordens contraditórias: barrar a carga × deixar
seguir).
