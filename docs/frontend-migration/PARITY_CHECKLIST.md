# Parity Checklist — virar do Lovable pro front próprio

> **Uso:** conferir tela-a-tela contra o Lovable ANTES da virada total. Só vira quando **tudo** marcado. Teste-ouro = **lado-a-lado** (mesma conta, mesmo card, mesmo comportamento).
> **Regra de teste:** automático = read-only (contrato + UI mockada + smoke). Mutação = manual, com card de teste controlado + aprovação do Caio. Ver [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## A. Fundações
- [ ] Login Supabase: senha + magic link + esqueci senha (`recuperar-senha-operador`) + logout.
- [ ] `ProtectedRoute` bloqueia rotas sem sessão.
- [ ] `operador` resolvido de `operadores` por `user_id`; `papel`/carteira carregados.
- [ ] RLS: operador vê só os seus cards; gestor vê tudo (testar com 2 contas).
- [ ] Env vars (`VITE_SUPABASE_*`) — sem chave hardcoded (R4).
- [ ] Realtime habilitado: `cards`, `todos`, `card_events` atualizam a UI ao vivo (debounce 1s).
- [ ] Header: logo Sal + relógio de sync (`status_ultimo_sync_bastao`) + usuário + sair.
- [ ] Sidebar: 8 itens + badges (AVH, conflitos, canc.reentrega) + Administração p/ super-admin.

## B. Telas (13 rotas)
- [ ] `/inbox` — lista/kanban; filtros; busca (NF/CTRC/empresa); badges; ordenação; realtime.
- [ ] `/cards/:id` — detalhe com 4 abas (Mensagens/Propostas/Histórico SSW/Eventos) + banners.
- [ ] `/resolvidos` — cards resolvidos/cancelados.
- [ ] `/conflitos` — `v_cards_requer_atencao`; forçar atualização; badge bate com a lista.
- [ ] `/extravios` — kanban D1–D5 (`v_extravios_kanban`); dias úteis inteiros; mudar status; reportar erro agente.
- [ ] `/cancelamentos-reentrega` (+ `/:acao_id`) — lista + detalhe; marcar tratado/inconclusivo; badge precisa-ação.
- [ ] `/auditoria` — ações autônomas (extravio, ressarc54); só 100% autônomas.
- [ ] `/indicadores` — acerto IA oc13, ocs-padrão; erros de lançamento; tempo oc21→oc14; feedback IA.
- [ ] `/cadastros` — clientes / contatos / escalonamento (CRUD RLS-gated).
- [ ] `/administracao` — gestão de operadores (edge `admin-operadores`); **Isadora vê**; 403 tratado.
- [ ] `/configuracoes` — configurações.
- [ ] `NotFound` — catch-all.

## C. Detalhe do card — componentes
- [ ] Identificação (NF, CTRC, pagador, estado, operador).
- [ ] Resolver/Cancelar manual (⚠️ isolar R1 em módulo backend-pending).
- [ ] Aba Mensagens: thread de e-mail + composer (responder, CC, template, anexos, Cmd+Enter).
- [ ] Aba Propostas (`ProposedActions`): aprovar & executar (com/sem e-mail); rejeitar; lançar oc; combos; extras por OC.
- [ ] Aba Histórico SSW: timeline de ocorrências; ver foto; reportar erro.
- [ ] Aba Eventos: timeline híbrida (narrativa + expandir `card_events`).
- [ ] Banners: sugestão IA, evidência, bounce e-mail, e-mail preexistente, mudança suspeita, tratativa detectada.

## D. Modais (7)
- [ ] Criar card manual (`criar-card-manual`: escolher CTRC, dedup NF).
- [ ] Editar e-mail (`preview_email_todo` + `EditarEmailModal`; anti-duplo-clique).
- [ ] Evidência/galeria (multi-foto, metadata).
- [ ] Reportar erro de lançamento (`reportar_erro_lancamento`).
- [ ] Lançar emergencial (`lancar_oc_emergencial_acao_executada`).
- [ ] Forçar atualização SSW (`atualizar-card-via-tracking`/`liberar_card_suspeito_lockado`).

## E. Ações críticas (paridade de comportamento — validar MANUAL c/ card de teste)
- [ ] `aprovar_e_executar(p_todo_id, p_extras)` — **extras idênticos por OC** (skip_evidencia, forçar CTRC baixado, template override); card muda de coluna; evento em `card_events`.
- [ ] Responder cliente (`responder-email-cliente`) — e-mail sai correto.
- [ ] Rejeitar / voltar-pra-todo.
- [ ] Ignorar pendências (`ignorar_pendencias_resposta_cliente`) — respeita INV-019.
- [ ] Adotar/descartar e-mail preexistente.
- [ ] Marcar cancelamento tratado/inconclusivo.
- [ ] Feedback IA (acertou/errou) grava.
- [ ] Lançar oc / emergencial → SSW (só card de teste).

## F. Invariantes (o front MOSTRA estado — não pode rotular/filtrar errado)
- [ ] oc=54 ⟺ AGUARDANDO_CLIENTE (INV-006) exibido certo.
- [ ] Cliente respondeu → AVH+lock com botões visíveis (INV-016).
- [ ] Extravios ⟺ oc∈{6,9,16}, só na aba Extravios (INV-017); dias úteis inteiros.
- [ ] Nenhum card "some" indevidamente (realtime/subscription).

## G. Qualidade / não-regressão
- [ ] Testes contrato (assinaturas RPC/edge mapeadas em `src/api/`).
- [ ] Testes UI mockados (Vitest) nos componentes de risco.
- [ ] Smoke E2E read-only (Playwright) verde; **nenhum teste destrutivo em CI**.
- [ ] Sem erro no console; sem chave hardcoded.
- [ ] `/verify-cockpit` com itens de front, passando.

## H. Mobile (go-live)
- [ ] 375px: abrir card, aprovar, rejeitar, responder.
- [ ] Indicadores/Cadastros/Admin usáveis sem quebrar (desktop-first ok).

## I. Go-live
- [ ] Piloto Caio+Isadora ≥1 dia lado-a-lado, sem divergência.
- [ ] Plano de rollback confirmado (voltar bookmark pro Lovable).
