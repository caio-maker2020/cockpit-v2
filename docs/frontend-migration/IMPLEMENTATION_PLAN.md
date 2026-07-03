# Plano de implementação — front próprio (por fases)

> **Data:** 2026-07-03. Baseado no plano aprovado. **Fase 0 = docs (este conjunto), gate antes de código.**
> **Honestidade de prazo:** paridade funcional total em 7 dias é agressiva por causa dos 3 God-components (`ProposedActions` 4223 ll., `ConversationTabs`, `BannerSugestaoIA`). Realista: **navegável + 2 fluxos-núcleo em ~1 semana**; **paridade 100% + hardening em ~2 semanas**.

## Regras invioláveis de execução
- **Não tocar backend** (migrations/RLS/RPC/edge) nesta migração. Necessidades → [BACKEND_PENDING.md](./BACKEND_PENDING.md).
- **Testes automáticos = read-only** (contrato + UI mockada + smoke). **Nenhum** teste automático chama `aprovar_e_executar`, responder e-mail, lançar ocorrência ou SSW.
- **Fluxos destrutivos = manual**, com card de teste controlado + aprovação explícita do Caio.
- **Baseline copiado primeiro** (referência operacional), estética SaaS+Sal vem na refatoração.
- Backend e novo front apontam pro **mesmo Supabase** → virada reversível por troca de URL.

## Fase 0 — Documentos (SEM código) ✅ concluída
Gerar os 7 docs em `docs/frontend-migration/` + 1 ADR em `docs/decisions/`. **Fase 0 apenas MAPEIA e EXPLICITA os gaps** de assinatura/retorno de RPC/edge — **não fecha, não inventa** (ver lista em CONTRATO §11 e BACKEND_PENDING). **PARAR pra revisão do Caio.**

> **Regra de gaps (consistente em todo o plano):** Fase 0 mapeia os gaps; **o fechamento acontece antes de criar cada módulo `src/api/`** (na Fase 2), lendo a fonte real (`index.ts`/`pg_get_functiondef`) — nunca no chute.

## Fase 1 — Baseline copiado + deployando (Dia 1)
1. Copiar o export pra `apps/cockpit-web/`.
2. Remover `lovable-tagger` (package.json + vite.config) e tags Lovable.
3. Mover URL+anon key pra `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (R4); `.env.example`.
4. `npm install`, `npm run build` local OK.
5. Projeto Vercel apontando "root directory" = `apps/cockpit-web/`; env vars; **preview URL**.
6. **Entregável:** URL Vercel que loga (Supabase) e navega as 13 rotas — paridade funcional, ainda com a cara antiga.
- **Sem** teste destrutivo. Smoke read-only manual.

## Fase 2 — Camada `src/api/` + fatias de risco (Dias 2–3)
0. **Gate de gaps (por módulo):** antes de encapsular cada RPC/edge, **fechar o gap daquele item** lendo a fonte real (`supabase/functions/<fn>/index.ts` / `pg_get_functiondef` da RPC) — assinatura, args e retorno confirmados. **Nunca chutar payload/retorno.** Lista de gaps em CONTRATO §11.
1. Criar `src/api/` — 1 módulo por domínio encapsulando as 19 RPCs + 15 edge, com input/output **Zod** (o "coração anti-regressão": contrato num lugar só, tipado).
2. Refatorar `ProposedActions` (4223 ll.) em componentes por OC/fluxo — **sem mudar comportamento** (paridade).
3. Refatorar `ConversationTabs` e `BannerSugestaoIA` (banner unificado).
4. Corrigir **R2** (allowlist super-admin Caio+Isadora + tratar 403) e **R4** (env). Isolar **R1** em módulo `// BACKEND-PENDING R1`.
5. Testes **camada 1–2** (contrato + UI mockada) nos componentes de risco.

## Fase 3 — Redesign SaaS+Sal + paridade fina (Dias 4–5)
1. Aplicar design system (SaaS-moderno + marca Sal) tela-a-tela, começando por **Inbox e Detalhe em paralelo** (escolha do Caio).
2. Storytelling híbrido na timeline (narrativa + expandir `card_events`).
3. Navegação por teclado no Inbox; mobile de triagem.
4. Conferir Indicadores / Extravios / Conflitos / Cadastros / Canc. Reentrega / Auditoria / Administração.
5. **Smoke E2E read-only** (Playwright, camada 3) em CI.

## Fase 4 — Hardening / piloto / go-live (Dias 6–7)
1. Varrer `PARITY_CHECKLIST.md` tela-a-tela **lado-a-lado com o Lovable**.
2. **Piloto Caio+Isadora** na URL Vercel (uso paralelo, mesmo Supabase).
3. Validar fluxos destrutivos **manualmente** com card de teste + aprovação do Caio.
4. Adicionar itens de front ao `/verify-cockpit`.
5. Checklist de go-live 100% → **virada** = trocar bookmark dos operadores. Rollback = voltar URL.

## Ordem de ataque por risco (dentro das fases)
1. Inbox + Detalhe (núcleo operacional — escolha do Caio).
2. `ProposedActions` / aprovar & executar (maior risco + maior valor).
3. Banners de IA (unificar).
4. Extravios / Conflitos / Canc. Reentrega (fluxos com RPC próprios).
5. Indicadores / Cadastros / Administração / Auditoria (menos hot-path; podem ser desktop-first no mobile).

## Riscos & mitigação
| Risco | Mitigação |
|---|---|
| God-components escondem regras sutis | refatorar preservando comportamento + teste UI mockado + lado-a-lado |
| `extras` de `aprovar_e_executar` divergir por OC | mapear cada extra; validar manual por OC com card de teste |
| Realtime filtrar errado → card some | testar com 2 operadores; conferir filtros de subscription |
| Invariantes de estado exibidos errado (INV-006/016/017) | checklist F; lado-a-lado |
| Prazo otimista | entregar navegável+núcleo em 1 semana; paridade total em ~2 |
