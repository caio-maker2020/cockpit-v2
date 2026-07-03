# Decisão de stack, repositório e hospedagem — front próprio

> **Data:** 2026-07-03. **Decisão de:** Caio (aprovada). Complementa o [ADR 0013](../decisions/0013-front-proprio-fora-do-lovable.md).

## Decisão
1. **Stack:** **Vite + React 18 + TypeScript + shadcn/ui + Tailwind + `@supabase/supabase-js` + React Query** (a mesma do export Lovable). Hospedagem na **Vercel**.
2. **Repositório:** **mesmo repo**, pasta **`apps/cockpit-web/`**.
3. **Arranque:** **copiar o export como baseline funcional**, limpar traços Lovable, deployar; **depois** refatorar por fatias (export = referência **operacional**, não estética).

## Por que Vite SPA (e não Next.js)
| Critério | Vite SPA (reaproveita export) ✅ | Next.js/Vercel | Outra (Remix/Svelte) |
|---|---|---|---|
| Velocidade pro MVP | Altíssima — export já é isso | Média (reescrever routing/data) | Baixa (rewrite total) |
| Supabase Auth/RLS/Realtime | Nativo (tudo client-side, sem pegadinha de sessão) | SSR complica sessão/realtime | Reintegrar tudo |
| E2E | Playwright fácil | Playwright ok | — |
| Deploy/rollback | Vercel estático + rollback imutável + preview por branch | 1ª classe | varia |
| Manutenção (Caio + IA) | Menor carga cognitiva (1 modelo mental) | Mais peças (server runtime, RSC) | Ecossistema novo |
| Complexidade | Baixa | Média/Alta | Alta |

**Racional (como CTO/sócio):** o front do Cockpit é um **cliente fino** — toda a lógica de negócio já vive no backend (RPCs, Edge Functions, RLS, realtime, event sourcing). Os pontos fortes do Next.js (SSR, RSC, API routes, SEO) **não agregam** num app interno, autenticado, realtime e sem SEO — e o SSR ainda **atrapalha** sessão Supabase e realtime (client-side). Next.js adicionaria runtime de servidor e custo de migração por **zero** benefício operacional aqui. O export já é Vite SPA → caminho mais rápido, mais barato e mais sustentável.

## Por que copiar baseline, depois refatorar (e não do zero)
A dor #1 do Caio é **"bugs/quebras/interpretação-errada da IA do Lovable"** — ou seja, **confiabilidade**, não estética. Estratégia:
1. **Copiar o export** pra `apps/cockpit-web/` → prova ponta-a-ponta que funciona (baixo risco de "não roda").
2. **Limpar Lovable** (`lovable-tagger`, tags), env vars, deploy Vercel.
3. **Refatorar por fatias**, dos componentes de risco pra fora: extrair camada `src/api/` tipada+Zod, quebrar os God-components (`ProposedActions` 4223 ll. etc.), adicionar testes. Cada linha passa por revisão humana/IA controlada — o oposto da caixa-preta do Lovable.

Isso troca a caixa-preta por código nosso **incrementalmente e de forma reversível**, sem parar a operação.

## Por que mesmo repo em `apps/cockpit-web/`
| Opção | Prós | Contras |
|---|---|---|
| **`apps/cockpit-web/`** ✅ | uma fonte de verdade (back+front); um clone; commits atômicos front+doc; precedente (`vercel-monitor-capacidade/`, `vercel-r-evidencia/` já no repo); Caio+IA navegam de um lugar | repo cresce; Vercel aponta "root dir" (trivial) |
| Repo separado | isolamento de CI/permissão | só compensa com time separado — não é o caso (dono único, single-tenant) |

**Analogia (não-técnico):** é "uma gaveta nova no mesmo arquivo", não um segundo escritório.

## Hospedagem: Vercel
- Já usada (2 projetos no repo). Vite estático = deploy trivial, **rollback imutável**, **preview por branch**.
- Preview por branch habilita o **piloto Caio+Isadora em URL real** enquanto operadores seguem no Lovable — os dois fronts falam com o **mesmo Supabase**.
- **Cutover = trocar o bookmark** dos operadores; **rollback = voltar a URL**. Sem migração de dados. Totalmente reversível.
- Hostinger serviria estático, mas não tem o workflow git + preview + rollback que torna a virada segura.
- Env na Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (tira o hardcode — R4).

## Não muda nesta migração
- Auth: **Supabase** (senha + magic link), igual.
- Backend: intocado (ver [BACKEND_PENDING.md](./BACKEND_PENDING.md) pros itens futuros).
