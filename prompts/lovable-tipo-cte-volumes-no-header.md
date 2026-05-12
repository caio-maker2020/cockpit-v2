# Lovable — Adicionar TIPO CT-e e QUANTIDADE DE VOLUMES no header do card

## Contexto

A operadora pediu visibilidade rápida de 2 informações que hoje só aparecem na plataforma de pendência (Bastão), mas não no Cockpit:

1. **TIPO CT-e** (`NORMAL`, `REVERSA`, `DEVOLUCAO`, `COMPLEMENTAR`, etc.)
2. **Quantidade de volumes** da NF

Backend já está pronto:
- Novas colunas na tabela `cards`:
  - `tipo_cte text` (ex: `"NORMAL"`)
  - `qtde_volumes integer` (ex: `9`)
- Populadas automaticamente pelo `sync-bastao` (cron 5min) e pelo `vinculador` no momento da criação do card.
- Backfill retroativo já aplicado em todos os cards ativos.

---

## O que mudar no front

Hoje o header do card mostra (exemplo NF 917972):

```
┌────────────────────────────────────────────┐
│ BHZ386403-1                            ✕  │
│ NF 917972                                  │
└────────────────────────────────────────────┘
```

Passar a mostrar:

```
┌────────────────────────────────────────────┐
│ BHZ386403-1                            ✕  │
│ NORMAL · NF 917972 · 9 vol.                │
└────────────────────────────────────────────┘
```

### Layout sugerido — 1 linha compacta

Logo abaixo do CTRC, na mesma linha de "NF {nf}", concatenar:

```tsx
<div className="text-sm text-muted-foreground">
  {card.tipo_cte && <span>{card.tipo_cte}</span>}
  {card.tipo_cte && <span className="mx-1.5">·</span>}
  <span>NF {card.nf}</span>
  {card.qtde_volumes != null && (
    <>
      <span className="mx-1.5">·</span>
      <span>{card.qtde_volumes} vol.</span>
    </>
  )}
</div>
```

### Regras de exibição

- **`tipo_cte`**: exibir só se não for `null`. Cor padrão (sem badge especial). Quando for `REVERSA` ou `DEVOLUCAO`, pode destacar em laranja sutil pra Larissa identificar de relance — opcional.
- **`qtde_volumes`**: exibir como `{n} vol.` (singular: `1 vol.` mesmo, sem variação). Se `null`, omite.
- Separador: `·` (middle dot) com `mx-1.5` (padrão dos chips do Cockpit).
- Não criar nova "seção" — manter dentro da linha que já tem `NF {nf}`. O objetivo é informação adicional **sem poluir** o header.

### Onde aparece

Em **todos** os cards (qualquer aba: AGUARDANDO CLIENTE, AGUARDANDO VOCÊ, PARA FAZER, AÇÃO EXECUTADA, TRANSFERIDO).

---

## Query Supabase

Não precisa criar nova query — a tabela `cards` já é selecionada inteira no front. Apenas garantir que o tipo TypeScript do card inclua:

```ts
interface Card {
  // ... campos existentes
  tipo_cte: string | null;
  qtde_volumes: number | null;
}
```

Se houver um `select(...)` explícito que liste colunas, adicionar `tipo_cte, qtde_volumes` à lista.

---

## Resumo

| Campo | Tipo | Onde | Quando exibir |
|---|---|---|---|
| `card.tipo_cte` | string | Header, antes de NF | Sempre que não-null |
| `card.qtde_volumes` | int | Header, depois de NF | Sempre que não-null |

Layout segue padrão minimalista do Cockpit — 1 linha, separadores `·`, sem badges chamativos.
