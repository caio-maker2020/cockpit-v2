Lovable — FIX flag "NÃO LANÇOU OCORRÊNCIA (CTRC BAIXADO)" que fica grudada mesmo depois da oc ser lançada

## Sintoma (NF 919069, operadora Larissa)
O card mostra o aviso/flag **"NÃO LANÇOU OCORRÊNCIA PORQUE O CTRC ESTAVA BAIXADO"**, mas
a ocorrência **foi lançada** (a operadora usou o "forçar lançamento em CTRC baixado"): o
card moveu pra **AGUARDANDO CLIENTE** com a **oc 54** lançada. Mesmo assim a flag continua
aparecendo (grudada).

## Causa (confirmada no backend)
O backend está **correto e limpo**: depois do lançamento forçado dar certo, ele zerou o
campo de falha. Hoje:
- `cards.state = 'AGUARDANDO_CLIENTE'`, `cards.cod_ultima_ocorrencia = 54`
- **`cards.acao_falhou_motivo = NULL`** (não há falha ativa)
- `cards.aviso_alteracao_oc = NULL`

O problema é que **o front está derivando esse aviso dos EVENTOS históricos do card**
(`card_events.event_type = 'TripeRejeitadoPeloGuard'` / `'AcaoRevertidaPosFalha'`), que
ficaram registrados das tentativas que o guard rejeitou ANTES do override. Como existe um
evento de rejeição no histórico, o front mostra a flag — sem perceber que houve um
**sucesso depois** (`'LancamentoForcadoCtrcBaixado'` + `'AcaoExecutadaConfirmadaPeloSsw'`).

## Correção (só front)
A flag de "ação falhou / não lançou (CTRC baixado)" deve ser dirigida pelo **campo canônico
`cards.acao_falhou_motivo`**, NUNCA pela presença de um evento histórico de rejeição.

Regra:
- **`acao_falhou_motivo` é NULL** → não há falha ativa → **NÃO mostrar** a flag (mesmo que
  existam `TripeRejeitadoPeloGuard`/`AcaoRevertidaPosFalha` antigos no histórico).
- **`acao_falhou_motivo` tem texto** → mostrar a flag com esse texto (é o motivo real da
  última falha que ainda precisa de atenção).

```ts
// fonte ÚNICA da flag de falha:
const flagFalha = card.acao_falhou_motivo
  ? { mostrar: true, motivo: card.acao_falhou_motivo }
  : { mostrar: false };
```

> Por quê: o backend SEMPRE zera `acao_falhou_motivo` quando a ação dá certo — inclusive no
> caminho do override "forçar lançamento em CTRC baixado". Então esse campo é a verdade do
> "tem falha pendente agora?". Os eventos de rejeição são só histórico/auditoria — servem pra
> timeline, não pra decidir se há falha ativa.

## Se o front mostra os eventos numa timeline/histórico
Tudo bem manter `TripeRejeitadoPeloGuard` / `AcaoRevertidaPosFalha` aparecendo na **timeline
do card** (é histórico legítimo). O que não pode é virar **banner/flag de estado atual**.

## Critérios de aceite
- [ ] Card da NF 919069 (AGUARDANDO CLIENTE, oc 54, `acao_falhou_motivo` NULL) **não** mostra
      mais a flag "não lançou / CTRC baixado".
- [ ] Card que REALMENTE falhou e ainda não foi relançado (`acao_falhou_motivo` com texto)
      continua mostrando a flag normalmente.
- [ ] A timeline/histórico do card pode continuar listando os eventos de rejeição.
