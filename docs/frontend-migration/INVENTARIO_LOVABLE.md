# Inventário do front atual (export Lovable)

> **Fonte:** código real do export em `~/Downloads/frontend-cockpit 2` (idêntico a `~/Downloads/frontend-cockpit`).
> **Status:** Fase 0 (descoberta). Verificado por leitura direta do `src/`, não reconstruído de prompts.
> **Data:** 2026-07-03.

## Stack real do export
Vite 5 + React 18 + TypeScript + shadcn/ui (Radix) + Tailwind 3 + `@supabase/supabase-js` 2 + `@tanstack/react-query` 5 + `zustand` 5 + `react-router-dom` 6 + `recharts` + `react-hook-form`+`zod` + `sonner` (toasts) + `embla-carousel` (galeria) + `pdfjs-dist` (PDF) + `date-fns` 3 + `next-themes`. Único traço proprietário: dev-dependency `lovable-tagger` (remover). ~20k linhas de app + 52 primitives shadcn em `components/ui/`.

## Rotas (react-router — `src/App.tsx`)
Pública: `/login`. Protegidas (dentro de `ProtectedRoute` + `AppLayout`):
`/inbox` (default; `/` redireciona pra cá), `/cards/:id`, `/resolvidos`, `/auditoria`, `/cadastros`, `/cancelamentos-reentrega`, `/cancelamentos-reentrega/:acao_id`, `/indicadores`, `/extravios`, `/conflitos`, `/administracao`, `/configuracoes`. Catch-all → `NotFound`.
*(Existem `pages/Index.tsx` e `pages/Placeholder.tsx` no repo, mas não são rotas ativas.)*

## Navegação (sidebar — `components/layout/AppSidebar.tsx`)
1. `/inbox` — **Tratativas de Relacionamento** (badge = nº AVH+bloqueado+escalado do operador)
2. `/conflitos` — **⚠️ Conflitos** (badge = `v_cards_requer_atencao`)
3. `/extravios` — **Extravios**
4. `/auditoria` — **Auditoria**
5. `/cancelamentos-reentrega` — **Canc. Reentrega** (badge = `v_cancelamentos_reentrega` status `precisa_acao`)
6. `/indicadores` — **Indicadores**
7. `/cadastros` — **Cadastros**
8. `/configuracoes` — **Configurações**
9. `/administracao` — **Administração** — **hoje gated por e-mail hardcoded `caio@salexpress.com.br`** (`AppSidebar.tsx:23`) → ver [BACKEND_PENDING.md](./BACKEND_PENDING.md) R2 (Isadora não vê).

## Telas × complexidade (linhas de código)
| Página | Linhas | Papel |
|---|---:|---|
| `Indicadores.tsx` | 1157 | dashboards de métricas (IA acerto, erros, tempo oc21/oc14) |
| `Inbox.tsx` | 839 | kanban/lista principal de tratativas |
| `Cadastros.tsx` | 653 | clientes / contatos / escalonamento |
| `CardDetail.tsx` | 494 | detalhe do card (orquestra os componentes de card) |
| `CancelamentoReentregaDetalhe.tsx` | 403 | detalhe de cancelamento de reentrega |
| `Extravios.tsx` | 353 | kanban de extravios (D1–D5) |
| `CancelamentosReentrega.tsx` | 348 | lista de cancelamentos |
| `Auditoria.tsx` | 319 | trilha de ações autônomas |
| `Login.tsx` | 300 | auth (senha + magic link + esqueci senha) |
| `Administracao.tsx` | 279 | gestão de operadores (edge `admin-operadores`) |
| `Conflitos.tsx` | 162 | cards com mudança suspeita de escopo |
| `Configuracoes.tsx` | 151 | configurações |
| `Resolvidos.tsx` | 114 | cards resolvidos/cancelados |

## Componentes de card (`components/cards/` — 30 arquivos, coração operacional)
**Os 3 "monstros" (maior risco de migração):**
- `ProposedActions.tsx` — **4223 linhas** — motor de ações propostas/aprovação (todas as OCs, aprovar/rejeitar, combos, extras).
- `ConversationTabs.tsx` — 1836 — abas do detalhe (Mensagens / Propostas / Histórico SSW / Eventos).
- `BannerSugestaoIA.tsx` — 1827 — sistema de banners de sugestão da IA.

**Demais:** `SugestaoIATopBox` (730), `EditarEmailModal` (626), `CardIdentification` (553 — inclui resolver/cancelar card), `EmailThread` (481), `BannerInline54Composer` (472), `ModalCriarCard` (391), `BannerEmailPreexistente` (381), `TratativaPendenteCard` (332), `KanbanCard` (302), `ModalEvidencia` (288), `ModalReportarErroLancamento` (259), `AnexosUploader`, `HistoricoEventosCard`, `AcaoExecutadaPanel`, `CardChips`, `ResponderThreadClienteBlock`, `PainelTratativaDetectada`, `AvisoRespostaOutraThread`, `TratativasEmailMultiplas`, `BotaoBuscarTratativa`, `BannerEvidencia`, `BannerBounceEmail`, `BannerEmailNaoEnviado`, `BannerMudancaSuspeitaEscopo`, `BannerTratativaDetectada`, `ModalLancarEmergencial`, `ModalForcarAtualizacao`.

## Outros componentes
- `layout/`: `AppLayout`, `AppHeader`, `AppSidebar`, `BannerFiltroOperador`, `FiltroOperadorAdmin`.
- `indicadores/`: `IndicadorAcertoAgenteOc13`, `IndicadorAcertoAgenteOcsPadrao`, `IndicadorCard`.
- `cadastros/`: `ClientesTab`, `ContatosTab`, `EscalonamentoTab`.
- `auditoria/`: `AgenteExtravioSection`, `AgenteRessarc54Section`.
- `extravios/`: `BotaoReportarErroAgente`.
- `auth/`: `ProtectedRoute`. `contexts/`: `AuthContext`.
- `ui/`: 52 primitives shadcn.

## Modais (7)
Criar card manual (`ModalCriarCard`), editar e-mail (`EditarEmailModal`), evidência/galeria (`ModalEvidencia`), reportar erro de lançamento (`ModalReportarErroLancamento`), lançar emergencial (`ModalLancarEmergencial`), forçar atualização SSW (`ModalForcarAtualizacao`), resolver/cancelar card (dialog em `CardIdentification`).

## Detalhe do card — seções
1. **Identificação** (`CardIdentification`): NF, CTRC, pagador, estado, operador; ações de resolver/cancelar (⚠️ hoje escreve direto — ver R1).
2. **Banners de IA** (topo): sugestão (`BannerSugestaoIA`/`SugestaoIATopBox`), evidência, bounce de e-mail, e-mail preexistente, mudança suspeita de escopo, tratativa detectada.
3. **Abas** (`ConversationTabs`): **Mensagens** (`EmailThread` + composer) · **Propostas** (`ProposedActions`) · **Histórico SSW** · **Eventos** (`HistoricoEventosCard`).
4. **Ações propostas** (`ProposedActions`): aprovar & executar (com/sem e-mail), rejeitar/voltar-pra-todo, lançar oc, combos, checkboxes de extras.

## Ações críticas do operador
Aprovar & executar (com/sem e-mail) · rejeitar / voltar-pra-todo · responder cliente · lançar oc (várias) · ignorar pendências · adotar/descartar e-mail preexistente · marcar cancelamento tratado/inconclusivo · reportar erro de lançamento · feedback IA (acertou/errou) · criar card manual · resolver/cancelar manual · forçar atualização SSW · lançar emergencial.

## Estados vazio / loading / erro
React Query (`staleTime 30s`, `retry 1`, `refetchOnWindowFocus false`); toasts via `sonner`; skeletons/empty states presentes por tela (a **padronizar** no novo design system — hoje variam).

## Perfis de usuário
- **Operador:** RLS por `assigned_operator_id` / carteira / segmento (vê só os seus cards).
- **Gestor** (`operadores.papel = 'gestor'`): RLS total.
- **Super-admin** (Caio + Isadora): acesso à Administração — gate real no edge `admin-operadores` (server-side). Front hoje só mostra a aba pro `caio@` (bug R2).

## Camada de dados / realtime / stores
- **Hooks:** `useRealtimeInvalidate` (subscribe `postgres_changes` → invalida React Query, debounce 1s), `useRealtimeTable`, `useTratativasEmail`, `useTemplatesEmail`, `useTempoDesdeAcao`, `useModoFoco`, `usePersistentState`, `use-toast`.
- **Stores zustand:** `useFiltroOperadorStore` (admin filtra por operador), `useCtrcOverrideStore`.
- **Auth:** `AuthContext` — Supabase `signInWithPassword` + `signInWithOtp` (magic link) + `signOut`; resolve `operador` de `operadores` por `user_id = auth.uid()`.

## Dependências Supabase (resumo — detalhe em CONTRATO_SUPABASE_FRONT.md)
19 RPCs · 15 Edge Functions chamadas do browser · ~18 tabelas · ~15 views `v_*` · realtime em `cards`/`todos`/`card_events` · bucket `email_anexos` (via edge).
