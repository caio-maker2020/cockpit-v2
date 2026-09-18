# Dashboard de clientes — link a partir do Cockpit (deep-link por cliente)

Data: 2026-09-18 · Pedido do Caio · Branch `feat/visao-clientes-dashboard-link`

## O que o Cockpit faz (já implementado)

- **Inbox** — botão vermelho **VISÃO GERAL DOS CLIENTES** abaixo da saudação abre
  `https://sal-express-dashboard.vercel.app/performance` em nova aba.
- **Card** — botão **VER NÚMEROS DO CLIENTE** no header abre a mesma página com
  dois parâmetros:

  | parâmetro | valor | origem no Cockpit |
  |---|---|---|
  | `q` | nome pra busca | `clientes.nome` pelo CNPJ pagador; fallback nome do card sem a abreviação SSW (`"ASTRA S/A. INDU A."` → `"ASTRA S/A. INDU"`) |
  | `cnpj` | CNPJ pagador, 14 dígitos | `cards.agent_state.cnpj_pagador` (100% dos cards dos últimos 30 dias têm) |

  Exemplo real (NF 2387303):
  `…/performance?q=ASTRA+S%2FA.+INDUSTRIA+E+COMERCIO&cnpj=50949528001232`

- Toast pós-clique com **Copiar senha** quando `VITE_DASHBOARD_CLIENTES_SENHA`
  está configurada (Vercel Preview + Production; nunca no repo).

Código: `apps/cockpit-web/src/lib/dashboard-clientes.ts` (puro, testado),
`components/cockpit/BotaoVisaoGeralClientes.tsx`,
`components/cards/BotaoVerNumerosCliente.tsx`. Guard: INV-157.

## O que FALTA no dashboard (repo separado — não está neste monorepo)

Medido em 18/09 contra o site publicado:

1. A página `/performance` **ignora a query string** — todo estado é `useState`
   local; não há `useSearchParams`.
2. O middleware de auth redireciona pra `/login?next=/performance` e **descarta a
   query** (`?q=…&cnpj=…` some). A página de login honra `next` (`router.push(next)`).
3. A busca `/api/clientes?q=` é por **nome** (CNPJ retorna vazio) e exige ≥ 3 chars.
4. Os grupos vêm como `{ agrupado, curva, segmento, cnpjs: [{cnpj, pagador}] }`.

### Patch proposto (Next.js App Router)

**a) middleware — preservar a query no `next`**

```ts
// middleware.ts
const next = req.nextUrl.pathname + req.nextUrl.search;   // era só pathname
url.searchParams.set("next", next);
```

**b) página `/performance` — auto busca → seleção → Analisar**

```tsx
"use client";
import { useSearchParams } from "next/navigation";
// ... dentro do componente da página:
const sp = useSearchParams();
const qInicial = sp.get("q")?.trim() ?? "";
const cnpjInicial = sp.get("cnpj")?.replace(/\D/g, "") ?? "";
const autoRodou = useRef(false);

// 1) semear o campo de busca com q (dispara o debounce já existente)
useEffect(() => { if (qInicial.length >= 3) setBusca(qInicial); }, [qInicial]);

// 2) quando os grupos chegarem, escolher o certo e analisar UMA vez
useEffect(() => {
  if (autoRodou.current || grupos.length === 0 || (!qInicial && !cnpjInicial)) return;
  const porCnpj = cnpjInicial
    ? grupos.find((g) => g.cnpjs.some((c) => c.cnpj === cnpjInicial))
    : undefined;
  const porNome = grupos.find((g) => g.agrupado.toUpperCase() === qInicial.toUpperCase());
  const escolhido = porCnpj ?? porNome ?? (grupos.length === 1 ? grupos[0] : undefined);
  if (!escolhido) return;           // ambíguo: deixa o operador escolher na lista
  autoRodou.current = true;
  setSelecionados([escolhido]);     // mesma função do clique na lista
  setBusca("");
  void analisar([escolhido]);       // mesma função do botão "Analisar"
}, [grupos, qInicial, cnpjInicial]);
```

Regra de desempate: **CNPJ do card manda** (garante que é o cliente daquele card);
nome exato em segundo; resultado único em terceiro; senão mostra a lista e o
operador confirma pelo nome (comportamento atual).

`useSearchParams` exige `<Suspense>` no App Router se a página for estática.

### Como validar depois do patch

1. Abrir um card no Cockpit → **Ver números do cliente** → deve cair direto na
   análise do cliente do card (NF 2387303 → "ASTRA S/A. INDUSTRIA E COMERCIO", 3 CNPJs).
2. Sair do dashboard (botão *Sair*) e repetir: login → volta pra análise do mesmo
   cliente (prova do item a).
3. Card com nome abreviado SSW e cliente fora da carteira do operador (RLS): `q`
   vai com o prefixo de 15 chars; ainda encontra o grupo pelo `cnpj`.
