# ADR 0013 — Front próprio (fora do Lovable): Vite SPA + Vercel + `apps/cockpit-web/`

Data: 2026-07-03
Status: Aceito
Âncora: dor do Caio — "bugs, quebras de código e interpretação da IA da Lovable" (confiabilidade, não estética)

> Nota de numeração: 0012 está reservado ao trabalho de falso-AVW/reabertura (memória `project_bug_b_falso_avh_deteccao_fase1`, branch não mergeada). Este ADR usa **0013** pra evitar colisão.

## Contexto

O Cockpit v2 tem backend 100% nosso (Supabase: DB, Auth, Realtime, pgmq, pg_cron, Edge Functions) e front no **Lovable** (no-code + IA). O Lovable virou fonte recorrente de **regressão**: a IA reintroduz bugs e reinterpreta requisitos a cada mudança (a pasta `prompts/lovable-*.md` tem ~100 correções, muitas "FIX de FIX"). A dor #1 do Caio é **confiabilidade**, não visual.

**Descoberta (fato):** o export do Lovable (`~/Downloads/frontend-cockpit 2`) é um app **Vite + React 18 + TypeScript + shadcn/ui + Tailwind + supabase-js + React Query + Zustand + react-router + Recharts** — stack **convencional e portável**, sem nada proprietário exceto o dev-dependency `lovable-tagger`. O front é um **cliente fino**: toda a lógica de negócio (RPCs, Edge Functions, RLS, realtime, event sourcing) já vive no backend.

## Decisão

Sair 100% do Lovable e construir front próprio, com:

1. **Stack:** **Vite + React + TypeScript + shadcn/ui + Tailwind + supabase-js + React Query** — a mesma do export.
   - *Por quê (vs Next.js):* SSR/RSC não agregam num app interno, autenticado, realtime e sem SEO — e atrapalham sessão Supabase/realtime (client-side). Next.js = runtime de servidor + custo de migração por zero benefício aqui.
2. **Hospedagem:** **Vercel** — preview por branch (habilita piloto em paralelo), rollback imutável, deploy estático trivial.
3. **Repositório:** **mesmo repo**, pasta **`apps/cockpit-web/`** (precedente: `vercel-monitor-capacidade/`, `vercel-r-evidencia/`). Não repo separado (dono único, single-tenant).
4. **Arranque:** **copiar o export como baseline funcional** → limpar Lovable → deployar → **refatorar por fatias** (componentes de risco primeiro). Export = referência **operacional/contrato**, não estética.
5. **Auth inalterado:** Supabase (senha + magic link).
6. **Backend intocado:** nenhuma migration/RLS/RPC/edge nesta migração. Pendências → `docs/frontend-migration/BACKEND_PENDING.md`.
7. **Testes não-destrutivos:** automático = contrato + UI mockada + smoke read-only. Mutações (`aprovar_e_executar`, e-mail, SSW) = **manual**, card de teste controlado + aprovação do Caio. Nunca em CI.
8. **Cutover por virada total:** operadores só mudam com **100% de paridade**. Os dois fronts falam com o **mesmo Supabase** → virada = trocar URL; rollback = voltar pro Lovable. Reversível.

## Consequências

**Positivas:** código nosso, tipado (`strict`), testado e revisado — fim da caixa-preta que regride. Camada `src/api/` tipada+Zod concentra o contrato Supabase (anti-regressão). Design SaaS-moderno + marca Sal, storytelling híbrido das tratativas, velocidade operacional. Deploy/rollback seguros.

**Custos/riscos:** 3 God-components (`ProposedActions` 4223 ll., `ConversationTabs`, `BannerSugestaoIA`) são o risco real de prazo — paridade total ~2 semanas (navegável+núcleo ~1). O front **mostra** estado: rotular/filtrar errado (INV-006/016/017) leva o operador a agir errado → mitigar com checklist + lado-a-lado + testes.

**Guards anti-regressão (convenção nº 8):**
- `docs/frontend-migration/` (7 docs) + este ADR.
- `PARITY_CHECKLIST.md` como gate de virada.
- Itens de front adicionados ao `/verify-cockpit`.
- Camada `src/api/` tipada + testes de contrato/UI mockada.

## Alternativas descartadas
- **Next.js:** SSR complica Supabase/realtime; sem ganho num app interno.
- **Repo separado:** overhead sem dono/time separado.
- **Rewrite do zero:** mais lento e mais arriscado que copiar baseline + refatorar por fatias.
- **Continuar no Lovable:** é a causa da dor (regressão por IA no-code).

## Relacionado
ADR 0001 (Supabase-only), ADR 0002 (event sourcing — R1 respeita), `docs/frontend-migration/*`.
