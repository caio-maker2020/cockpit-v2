# Plano de implementação — Loop de Aprendizado dos Agentes (Agente Chefe)

Data: 2026-07-17 · Branch: `criacao-agente-chefe` (nada na main) · Status: **aguardando
validação do Caio — nenhuma fase roda sem ela**
Spec: `docs/superpowers/specs/2026-07-17-loop-aprendizado-agentes-design.md`

## Resultado da investigação de risco (evidência verificada)

**Fatos verificados:**

- Front próprio = Vite + React + shadcn em `apps/cockpit-web`, auth via
  `AuthContext.tsx` que já carrega `papel` do operador; deploy Vercel com
  `vercel.json` — push de branch gera **Preview Deployment** com URL própria,
  produção intocada.
- Migrations livres a partir da **299** (296–298 usadas hoje; 291–295 reservadas
  pro fluxo oc55 — commit `6f3003f`).
- `cards.historico_ssw` + `historico_ssw_atualizado_em` já existem e são
  alimentadas por crons — o árbitro T+7 **não precisa de nenhuma chamada nova ao
  SSW** (zero interferência no scraping operacional).
- As 9 RPCs `registrar_feedback_*` / `registrar_acerto_*` (SECURITY DEFINER) já
  existem — o popup grava por RPC nova no mesmo padrão, sem alterar
  `aprovar_e_executar`.
- O evento `TodoAutoCanceladoOcLancadaPorFora` já existe em `card_events` (2.059
  ocorrências) — o "fez por fora" é derivável por view, **sem tocar no
  sync-bastao** (4.081 linhas sem testes).
- `learning_log` já tem workflow de status, `parent_id` e campos de custo — as
  perguntas/respostas/relatórios do orquestrador entram nela por extensão de
  CHECK, sem tabela nova de fila.

**Onde o design original tocaria código quente — e o redesenho zero-toque:**

| Risco original | Redesenho que elimina o risco |
|---|---|
| Trigger/espelho nas 3 tabelas de feedback (INSERT quente do executor) | Nenhum trigger: `v_agent_feedback_unificado` = UNION view; `agent_feedback` só recebe sinais NOVOS (popup, T+7, cegos) |
| Editar vinculador pra ligar triador→card | Cron batch novo que casa `agent_runs.output` (NFs extraídas) × cards criados na janela — zero toque no fluxo de ingestão |
| Editar sync-bastao pro "fez por fora" | View sobre `card_events` (evento já existe) |
| Item novo dentro do `health-check` (771 L, sem testes) | Cron separado minúsculo `watchdog-aprendizado` (só lê learning_log e alerta) |
| T+7 puxando histórico do SSW | Lê `cards.historico_ssw` já armazenado; stale → veredito "indefinido" |
| Views de métrica atuais corrigidas in-place | Views novas `*_v2` (join por sugestão); painel novo usa as v2; as antigas ficam até o merge |

**Riscos residuais (os únicos toques em código existente, ambos adiados e pequenos):**

1. `redator-email-saida` e `sugerir-cobranca-ai`: ganhar um INSERT com try/catch
   (persistir texto sugerido). Funções de botão, fora do fluxo de aprovação.
   Falha do INSERT nunca bloqueia a resposta. → Fase 5, com teste.
2. Popup no fluxo de aprovação do front: único toque na rotina do operador.
   → Fase 4, atrás de flag por operador, gravação fire-and-forget (falha do
   feedback jamais bloqueia a aprovação).

Migrations novas: sempre com `BEGIN/COMMIT` (fugindo do padrão da casa de 277/287
sem transação), com skill `supabase-postgres-best-practices` invocada, RLS
gestor-only nas tabelas novas.

**Nota sobre o preview:** o Preview da Vercel usa o MESMO banco de produção
(leitura real — é o requisito "nasce com dados existentes"). A proteção é dupla:
rota só renderiza para papel gestor + allowlist de e-mail (fase de teste: só
`caio@salexpress.com.br`), e no servidor a RLS já restringe `learning_log` e views
a gestor. Requer push da branch pro GitHub (a main não é tocada por isso).

## Fases (cada uma termina com evidência + `/verify-cockpit`; a seguinte só começa com seu OK)

### Fase 0 — Fundação de dados (mig 299+; só aditiva, zero código quente)
`agent_feedback` (par universal p/ sinais novos), extensão do CHECK do
`learning_log` (tipos `pergunta`, `resposta_admin`, `relatorio_semanal`),
`motivo_bank` versionado (chips), `v_agent_feedback_unificado`, views de métrica
v2 (join por sugestão — números idênticos ao relatório Sinal de Ouro validado),
view "fez por fora". Teste: queries batem com os números validados em 17/07.

### Fase 1 — Orquestrador `agente-aprendizado` (edge nova + cron novo)
Read-only no operacional; escreve só em `learning_log`/`agent_feedback`. Rodada
diária (clusteriza divergências novas) + dominical (relatório de segunda).
Regras duras do §4.5 da spec. Custo logado + teto. `watchdog-aprendizado` junto
(atestado de vida desde o dia 1). **Estreia manual**: primeira rodada invocada à
mão sobre os dados existentes → 1º relatório + 3 perguntas gerados ANTES de
ligar cron. Teste: relatório nº 1 confere com os padrões conhecidos (oc13 55
casos, 56↔54 128, interp-54 181).

### Fase 2 — Painel "IA / Aprendizado" no front (preview Vercel, só seu login)
Rota nova em `apps/cockpit-web` gated por papel gestor + allowlist
(`caio@salexpress.com.br` na fase de teste). **Construção com a skill
`frontend-design` ativada** — visual de produto, não de IA genérica; linguagem
simples da spec §6 (4 campos, detalhe dobrado); dataviz seguindo a skill.
Conteúdo: placar por agente/célula, onde erra, fila de perguntas respondíveis em
1 clique, relatório de segunda, escada de autonomia. Deploy = push da branch →
URL de preview. Produção intocada. Teste: você navega tudo no preview; login de
operador comum não vê a rota.

### Fase 3 — Árbitro T+7 (edge nova + cron; read-only no operacional)
Carimba desfecho dos pares com ≥7 dias usando `historico_ssw` armazenado +
`card_events`. Sem chamadas SSW novas. Teste: amostra de 20 pares carimbados
conferida manualmente.

### Fase 4 — Popup de divergência (único toque no fluxo do operador)
Só após você validar o painel. Flag por operador (começa desligado pra todos;
liga primeiro num operador piloto). Chip obrigatório do `motivo_bank` + texto
opcional; RPC nova SECURITY DEFINER; fire-and-forget. Teste: aprovação funciona
idêntica com o feedback fora do ar.

### Fase 5 — Instrumentar os cegos
Batch matcher triador→card (cron novo). INSERT try/catch em
`redator-email-saida` e `sugerir-cobranca-ai` (com teste unitário cada).
"Fez por fora" já coberto pela view da Fase 0.

### Fase 6 — Agente de repositório (replay eval + PR)
Trava: só ativa após 2 semanas de watchdog verde. PRs apenas; merge é seu.

## Critério de merge na main
Tudo funcional no preview, validado por você, `/verify-cockpit` limpo, e **sua
ordem explícita**. Até lá, todo commit vive em `criacao-agente-chefe`.
