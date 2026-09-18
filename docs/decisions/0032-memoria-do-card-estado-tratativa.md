# 0032 — Memória do Card (estado_tratativa) + porteiro de sugestões

Data: 2026-09-17 · Status: aceita (Caio: "aprovado em branch separada, não faça
o merge sem meu aval") · Plano completo em `.claude/plans/` (sessão 17/09)

## Contexto

Cada análise remontava a história da NF do zero; o interpretador nunca refresca
`historico_ssw` (R2–R6 e o veto rodavam sobre cache velho); as famílias de veto
já mortas (repetir 54 no ciclo, pedir doc já recebido, 55 sem reentrega) são
todas "o agente não lembrou do que já aconteceu"; o operador reconstrói a
história mentalmente (NF 147831: 44h parada). Origem: palestra NVIDIA
(memória de curto prazo como objeto de estado) lida pelo Caio em 17/09.

## Decisão

`cards.estado_tratativa` (jsonb ≤6KB, coluna própria — NUNCA em `agent_state`,
que o sync-bastao sobrescreve): situação derivada, ciclo (port server-side de
`ciclosTratativa` — anti-drift com o front), `ja_feito_no_ciclo`, fatos com
FONTE clicável, aguardando, pendências do dossiê, alertas, resumo (Haiku).

- **D1** o estado DESCREVE, nunca prescreve (sem "próxima ação" dentro dele);
- **D2** fato `origem:llm` só pode FREAR autonomia, nunca liberar;
- **D3** contradição bloqueia só o ARMAR (trilho); no destaque vira anotação;
- **D5** projeção 100% recomputável; correções/info-externa do operador são
  `card_events` (`EstadoCorrigidoPeloOperador`, `InformacaoExternaRegistrada`)
  reaplicados no recompute — event sourcing intocado.

Atualização HÍBRIDA: trigger `project_card_event` marca dirty no MESMO update
(hub universal, cobre inclusive a RPC SQL de aprovação); worker cron 1/min
drena (claim SKIP LOCKED, Haiku só com texto novo, grava só se hash mudou);
`garantirEstadoFresco()` inline nos consumidores de decisão (interpretador,
oc49, veto-agendamento, vencimento) — elimina a corrida estado×sugestão, com
pino `estado_base_event_id` no agendamento e 2ª defesa no vencimento
(`devolver("estado_mudou")`).

Porteiro `validarSugestaoContraEstado` (lib pura): `repetiu_acao_no_ciclo`
(INV-094 generalizada), `pediu_doc_ja_recebido` (classe NF 1508990),
`oc55_sem_reentrega_aberta` (classe NF 26033). Cerca no trilho entre
`conteudo_incompleto` e `evidencia_nao_confirmada`; "R7" no interpretador =
anotação `contradicao_estado` no destaque.

Escada de flags (todas nascem OFF): `estado_tratativa_worker_enabled` →
`estado_tratativa_resumo_llm_enabled` → front (render-if-present) →
`estado_no_prompt_interpretador` / `estado_no_prompt_oc49` (bump
VERSAO_REGRAS_ANALISE ao ligar, horário calmo) / `estado_prompt_sombra_enabled`
(15% dos casos: par com/sem estado em `agent_runs`
agent_name=interpretador-sombra-estado) → `cerca_estado_enforce` (OFF =
log-only). Fase B (agente avaliador) só depois dos portões — desenho no plano.

## Portões (nada liga sem contraprova + ordem nominal)

F1: 7d de sombra, `ja_feito`×`acoes_executadas_ssw` divergência 0, leitura de
20 cards pelo Caio. F3: falso-positivo da cerca <5% em log-only + ≥30
divergências de prompt revisadas com com-estado vencendo. F4 (dieta): −40%
input tokens com taxa "seguida" estável.

## Consequências

+2 colunas em cards, +1 worker/cron, +1 chamada Haiku por card com texto novo
(custo alvo: centavos/dia, medido em `anthropic_usage_log`
function_name=estado-tratativa). Rollback por fase = flag OFF; trigger tem
migration de reversão trivial (corpo anterior está neste repo, mig 001).
