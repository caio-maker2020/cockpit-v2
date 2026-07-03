# Pendências de backend (detectadas na migração do front)

> **Regra:** esta migração **não altera backend**. Os itens abaixo são **riscos/pendências** achados ao mapear o contrato. Cada um tem decisão do Caio pendente. O novo front **reproduz o comportamento atual** (paridade) e **isola** o que for pra trocar depois.
> **Data:** 2026-07-03.

## R1 — Write direto em `card_events` + `cards` do browser (viola INV-002) 🔴
- **Fato:** `CardIdentification.tsx:492-506` (resolver/cancelar card manualmente) faz `insert` em `card_events` **e** `update` em `cards.state` **direto do browser**.
- **Por que é ruim:** viola event-sourcing (INV-002: `cards` é projeção; só muda via evento/trigger). Sem idempotência, sem validação server-side. É o único write de estado de card fora de RPC.
- **Fix futuro:** RPC `encerrar_card_manual(p_card_id, p_motivo)` / `cancelar_card(p_card_id, p_motivo)` (SECURITY DEFINER, grava evento + projeção do lado do banco).
- **Ação no front agora:** replicar o comportamento (paridade) mas **isolar numa única função** marcada `// BACKEND-PENDING R1` — troca trivial quando a RPC existir.
- **Blast radius do fix:** baixo (2 tipos de evento: `CardEncerradoManualmente`, `CardCancelado`). Exige guard `/verify-cockpit`.

## R2 — Gate de Administração por e-mail hardcoded (exclui Isadora) 🟠
- **Fato:** `AppSidebar.tsx:23` mostra Administração só se `user.email === 'caio@salexpress.com.br'`. O edge `admin-operadores` já libera **Caio + Isadora** (super-admins).
- **Consequência:** Isadora (2ª gestora/super-admin) **não vê** a aba no front.
- **NÃO fazer:** gatear por `papel === 'gestor'` — o edge só aceita super-admins → gestor comum tomaria **403**.
- **Fix no front (nesta migração, sem backend):** espelhar allowlist de super-admins (Caio + Isadora) pra mostrar a aba **e** tratar 403 do edge com mensagem clara.
- **Fix futuro (backend, ideal):** expor status super-admin ao front — campo em `operadores` (ex.: `is_super_admin bool`) ou RPC `sou_super_admin()` — pra o front não hardcodar allowlist. Decisão do Caio.

## R3 — Writes diretos em cadastros (RLS-gated) 🟡
- **Fato:** `contatos_escalonamento` (insert/update/delete) e `contatos_cliente` (insert) são escritos direto do browser (Cadastros).
- **Veredito:** aceitável — são cadastros RLS-gated por gestor, não estado de card. **Manter.**
- **Ação futura:** revisar as policies RLS dessas tabelas na fase de hardening (garantir que só gestor/dono escreve).

## R4 — URL + anon key hardcoded no client 🟡
- **Fato:** `lib/supabase.ts` tem URL e anon key em texto.
- **Veredito:** anon key é **publicável** (RLS protege) — não é vazamento crítico. Mas boa prática = env.
- **Fix no front (nesta migração):** mover pra `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (env Vercel) + `.env.example`. **Não** é backend.

## Gaps de contrato a fechar ANTES de codar cada módulo `src/api/` (Fase 2 — não são bugs; Fase 0 só mapeia, não inventa)
1. Retornos exatos: `marcar_email_preexistente_visto`, `liberar_card_suspeito_lockado`, `desativar_cliente`, `status_ultimo_sync_bastao`.
2. Overload real de `extravios_atualizar_status` (def achada = `()`, mas call site passa payload).
3. `rejeitar`/`voltar_para_to_do`: RPC ou edge `voltar-para-to-do-com-rastreio`?
4. Payloads exatos das 15 edge functions (ler cada `index.ts`).
5. Confirmar que Realtime está publicado em `cards`/`todos`/`card_events`.

## Fora de escopo desta migração (registrar, não fazer)
- Otimização de queries pesadas (contagem sidebar, Indicadores) — medir antes; se lento, virar índice/materialized view (usar skill `supabase-postgres-best-practices`).
- Qualquer nova RPC/coluna/policy só entra por decisão explícita do Caio + ADR próprio.
