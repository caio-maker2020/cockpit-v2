# Lovable — Destacar a ação de romaneio (PRATI) como RECOMENDADA + avisar nas oc 33 genéricas

## Por que (caso real)

Cliente romaneio-interno (PRATI) tem um fluxo próprio: antes de lançar a **oc 33**, o
agente loga num portal interno, busca o **romaneio** da NF, baixa e anexa no SSW junto
da 33 (se não achar, anexa um print "romaneio não localizado"). Isso só roda se a
operadora aprovar a ação **"Email + Lançar oc 33 — Extravio Total (PRATI, romaneio
interno)"**.

**O problema:** essa opção aparece no meio/fim de uma lista com **4 caminhos genéricos
que também lançam a oc 33** ("Lançar oc 33 solo", "Email + oc 33", combo 33+44, oc 33
manual). Os rótulos são quase iguais ("oc 33…"). Resultado real: em **9 lançamentos de
oc 33 em cards PRATI, 0 passaram pelo romaneio** — a operadora sempre pegou um genérico
sem perceber que pulou a busca do romaneio (NFs 1002836, 1006605, 1007453, 1005069,
996860, 1012717, todas LARISSA).

A correção **não tira nenhuma opção** — só deixa gritante qual é a certa e avisa quando
a escolhida pula o romaneio.

## O que o backend já entrega (nada novo a chamar)

O front continua lendo os mesmos `todos` com `proposta_payload`. Agora o backend carimba
**3 campos novos** dentro de `proposta_payload` (deploy de `regras-auto-acao.ts`):

| Campo | Onde aparece | Tipo | Uso no front |
|---|---|---|---|
| `recomendada` | **só** no todo de romaneio (`tool === 'enviar_email_e_lancar_33_romaneio_interno'`) | `true` | destacar + subir pro topo |
| `motivo_recomendacao` | junto do `recomendada` | `string` | texto explicativo do destaque |
| `aviso_romaneio_interno` | em **cada** todo genérico que lança oc 33, num card de cliente romaneio-interno | `string` (já vem com ⚠️) | renderizar aviso na opção + no modal de aprovação |

Exemplos do conteúdo (já prontos, não reescrever):
- `motivo_recomendacao`: *"PRATI usa romaneio interno: esta ação busca o romaneio no portal e anexa na oc 33 automaticamente. Use esta — não as opções genéricas de oc 33."*
- `aviso_romaneio_interno`: *"⚠️ PRATI usa romaneio interno: esta opção lança a oc 33 SEM buscar/anexar o romaneio do portal. Para anexar o romaneio, use a ação recomendada 'Email + Lançar oc 33 — Extravio Total (romaneio interno)'."*

> Os campos só existem em cards de cliente romaneio-interno (hoje PRATI). Em todos os
> outros cards eles vêm `undefined` → render normal, sem mudança nenhuma.

## Mudança 1 — Ordenação + selo "RECOMENDADA" na lista de propostas

Na lista de ações propostas do card, antes de renderizar:

```ts
// sobe a recomendada pro topo
const propostasOrdenadas = [...todos].sort((a, b) => {
  const ra = a.proposta_payload?.recomendada ? 1 : 0;
  const rb = b.proposta_payload?.recomendada ? 1 : 0;
  return rb - ra; // recomendada primeiro
});
```

Para o todo com `proposta_payload.recomendada === true`, renderizar com destaque forte
(borda/realce + selo), e mostrar o `motivo_recomendacao` abaixo do título:

```
┌──────────────────────────────────────────────────────────────────┐
│ ⭐ RECOMENDADA                                                     │
│ 🗂️ Email + Lançar oc 33 — Extravio Total (PRATI, romaneio interno)│
│ PRATI usa romaneio interno: esta ação busca o romaneio no portal  │
│ e anexa na oc 33 automaticamente. Use esta — não as genéricas.    │
│                                              [ APROVAR AÇÃO → ]    │
└──────────────────────────────────────────────────────────────────┘
```

- O selo "⭐ RECOMENDADA" deve ser visualmente dominante (cor de destaque do tema,
  ex. verde/âmbar do Cockpit).
- `motivo_recomendacao` em fonte menor, abaixo do título.

## Mudança 2 — Aviso nas opções genéricas de oc 33

Para **qualquer** todo cujo `proposta_payload.aviso_romaneio_interno` exista, mostrar
o aviso de forma visível tanto **na lista** quanto **no modal de aprovação**:

```tsx
const aviso = todo.proposta_payload?.aviso_romaneio_interno;
if (aviso) {
  // banner âmbar/warning dentro do card da opção E no topo do modal de aprovação
  // <WarningBanner>{aviso}</WarningBanner>
}
```

Na lista (resumido, ícone ⚠️ + 1 linha) e no **modal de aprovação** dessas opções
(banner âmbar no topo, antes do botão CONFIRMAR), pra a operadora ler a consequência
**antes** de confirmar. Não bloqueia o submit — é informativo (decisão do Caio:
sinalizar, não travar).

## Como deve ficar a lista PRATI (oc 49) depois

```
1. ⭐ RECOMENDADA  🗂️ Email + Lançar oc 33 — Extravio Total (PRATI, romaneio interno)
                   ↳ busca e anexa o romaneio automaticamente

2.  Lançar oc 21 — Reentrega
3.  Lançar oc 54 + email — Aguardar cliente
4.  Lançar oc 55 — Autorizar entrega
5.  Lançar oc 44 — Devolução
6.  Lançar oc 56 — Falta info
7.  Lançar oc 41 — Informação complementar
8.  ⚠️ Lançar oc 33 (solo) — lança a 33 SEM o romaneio
9.  ⚠️ Email + oc 33 — lança a 33 SEM o romaneio
```

(As opções 8/9 e quaisquer outras que lancem 33 mostram o `aviso_romaneio_interno`.)

## Resumo

| Elemento | Valor |
|---|---|
| Fonte | `todos.proposta_payload` (mesma leitura de hoje, sem RPC nova) |
| Campo recomendada | `proposta_payload.recomendada === true` → selo + topo |
| Texto do destaque | `proposta_payload.motivo_recomendacao` |
| Campo aviso | `proposta_payload.aviso_romaneio_interno` (string com ⚠️) → banner âmbar na opção + no modal |
| Comportamento | Não remove nem bloqueia nada — só destaca a certa e avisa nas genéricas |
| Escopo | Só cards de cliente romaneio-interno (PRATI); demais cards inalterados |
