# Lovable — FIX: aba CLIENTE RESPONDEU só pra oc=54; oc≠54 com resposta vai pra AGUARDANDO VOCÊ

## Bug (NF 165296 — Julia)
O card NF 165296 está em **oc=49** (relacionamento — exige a operadora lançar/agir) e
apareceu na aba **CLIENTE RESPONDEU**. Deveria estar em **AGUARDANDO VOCÊ**.

Causa: a regra atual (prompt `lovable-aba-cliente-respondeu.md`, 2026-05-08) bucketiza
**só** por `cliente_respondeu_em != null`, ignorando a oc. Como o cliente respondeu à
thread enquanto o card estava em oc=49, ele caiu em CLIENTE RESPONDEU.

✅ Backend correto: `state='AGUARDANDO_VALIDACAO_HUMANA'`, `cliente_respondeu_em` setado
(o cliente respondeu mesmo) e `cod_ultima_ocorrencia=49`. É só a regra de aba do front.

## Regra refinada (Caio 2026-06-30)
Card respondido pelo cliente fica em **CLIENTE RESPONDEU apenas quando `cod_ultima_ocorrencia = 54`**
(o fluxo "notifiquei o cliente, aguardo o retorno dele"). Em **qualquer outra oc**
(49, 20, 35, …) a ação pendente é da operadora → **AGUARDANDO VOCÊ**, com um badge
indicando que o cliente respondeu (a resposta segue visível — INV-016).

As duas abas continuam **mutuamente exclusivas** (sem duplicação).

## Filtros (mudança nas DUAS queries)

### Aba "AGUARDANDO VOCÊ"
```ts
state === 'AGUARDANDO_VALIDACAO_HUMANA'
  && (cliente_respondeu_em == null || cod_ultima_ocorrencia !== 54)
```
Supabase:
```ts
.eq('state', 'AGUARDANDO_VALIDACAO_HUMANA')
.or('cliente_respondeu_em.is.null,cod_ultima_ocorrencia.neq.54')
```

### Aba "CLIENTE RESPONDEU"
```ts
state === 'AGUARDANDO_VALIDACAO_HUMANA'
  && cliente_respondeu_em != null
  && cod_ultima_ocorrencia === 54
```
Supabase:
```ts
.eq('state', 'AGUARDANDO_VALIDACAO_HUMANA')
.not('cliente_respondeu_em', 'is', null)
.eq('cod_ultima_ocorrencia', 54)
```

## Badge na aba AGUARDANDO VOCÊ
Para cards que caem em AGUARDANDO VOCÊ **com `cliente_respondeu_em != null`** (oc≠54),
manter o badge **`📬 cliente respondeu · há {tempo}`** no topo do card (mesmo visual
âmbar de hoje) — a resposta do cliente não pode sumir da vista (INV-016). A diferença é
só **em qual coluna** o card aparece.

## Critério de aceite
- NF 165296 (oc=49, respondeu) aparece em **AGUARDANDO VOCÊ** com badge "cliente respondeu".
- Cards oc=54 que o cliente respondeu continuam em **CLIENTE RESPONDEU**.
- Nenhum card aparece nas duas abas ao mesmo tempo.
- Os 6 cards oc≠54 hoje em CLIENTE RESPONDEU (NF 165296, 733819, 2680555, 112962, …)
  passam pra AGUARDANDO VOCÊ; os 12 oc=54 ficam.

## Referência
Refina `lovable-aba-cliente-respondeu.md` (a regra de 2026-05-08 bucketizava só por
`cliente_respondeu_em`; agora a oc=54 é o discriminador). Backend sem mudança.
