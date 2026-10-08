# Separação Relacionamento × Operação — inventário de RLS, RPCs, visões e edges

ADR 0041 (D2) · mig `2026-10-07_431_operacao_separacao_rls.sql` · INV-180 · testes
`supabase/tests/operacao/operacao-separacao.test.sql` e `operacao-isolamento.test.ts`

> **Regra do dono:** "Relacionamento não precisa aparecer para a Operação, nem
> vice-versa." Membro da Operação não lê cards, tratativas, clientes nem mensagens.
> Operador do Relacionamento não lê `op_*`. Só o **gestor** (`operadores.papel =
> 'gestor'`) vê os dois lados.

## Por que existe este documento

Até a Operação entrar, todo `authenticated` do projeto era alguém do Relacionamento.
Várias policies foram escritas assim (`USING (true)` para `authenticated`), a
Supabase concede `EXECUTE` a `anon`/`authenticated` em toda função nova do schema
`public` (default privileges), e parte das edges não confere quem chama. Com membros
da Operação logando no **mesmo** projeto, cada um desses pontos vira vazamento.

## Como o inventário foi feito (e o limite dele)

- **Fonte:** o estado FINAL de `migration/` (436 arquivos), parseado por comando SQL:
  `CREATE/DROP POLICY`, `CREATE/DROP FUNCTION`, `GRANT/REVOKE`, `CREATE VIEW`.
  Função sem `REVOKE ... FROM authenticated` foi tratada como **executável** por
  authenticated (default privileges da Supabase, confirmados em produção pela mig 411:
  "56 funções de public são executáveis por PUBLIC e 127 são SECURITY DEFINER").
- **Limite:** este trabalho NÃO conectou no banco (regra da tarefa). Produção pode ter
  drift em relação a `migration/` (função trocada no painel, policy criada à mão). Antes
  de aplicar a 431, rodar o **pré-check** do fim deste documento e, para cada função
  marcada "conferir no corpo de produção", olhar `pg_get_functiondef`.

## A correção, em uma frase

A 431 cria `eh_membro_relacionamento()` e põe, em cada tabela do Relacionamento, uma
policy **RESTRICTIVE** `sep_somente_relacionamento` (`FOR ALL TO anon, authenticated
USING/WITH CHECK (eh_membro_relacionamento())`). Restrictive é **AND** com as
permissivas que já existem: para quem está em `operadores` o predicado é `true` e
**nada muda** (gestor, operador, carteira, `pode_executar`, tudo igual — provado no
teste SQL); para quem não está, nenhuma linha passa. O lado inverso (`op_*`) já nasce
fechado na RLS da mig 430.

### A. Policies que liberam linha para authenticated/PUBLIC sem olhar operadores (estado final de migration/)

| Tabela | Policy | Comando | Para | USING | Origem | Correção |
|---|---|---|---|---|---|---|
| `acoes_autonomas_veto_config` | `acoes_veto_config_select` | select | authenticated | `true` | 2026-08-25_353 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `acoes_autonomas_veto_operadores` | `veto_operadores_select` | select | authenticated | `true` | 2026-08-26_357 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `alertas_sla_oc21_oc14` | `alertas_select` | select | authenticated | `true` | 2026-05-18_112 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `analises_ia_indicadores` | `analises_ia_select_authenticated` | select | authenticated | `true` | 2026-05-18_109 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `anthropic_pricing` | `anthropic_pricing_select_auth` | select | authenticated | `true` | 2026-06-29_280 | mantida: referência (preço de modelo) |
| `cliente_config` | `cliente_config_service_role` | all | public | `true` | 2026-05-12_092 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `cobrancas_enviadas` | `cobrancas_select_authenticated` | select | authenticated | `true` | 2026-05-18_109 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `contatos_bases_ssw` | `contatos_bases_select` | select | authenticated | `true` | 2026-05-18_112 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `contatos_escalonamento` | `contatos_escal_modify` | all | authenticated | `true` | 2026-05-19_131 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `contatos_escalonamento` | `contatos_escal_select` | select | authenticated | `true` | 2026-05-19_123 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `erros_lancamento_ssw` | `erros_select_authenticated` | select | authenticated | `true` | 2026-05-18_109 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `fatias_autonomas` | `fatias_autonomas_select` | select | authenticated | `true` | 2026-08-13_340 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `feature_flags` | `ff_select_all` | select | authenticated | `true` | 2026-04-29_001 | mantida: referência (flags); a tela da Operação lê as dela por op_minha_sessao |
| `feriados` | `feriados_select` | select | authenticated | `true` | 2026-08-25_353 | mantida: referência (calendário) |
| `nf_chave_cte` | `nf_chave_cte_select_authenticated` | select | authenticated | `true` | 2026-04-29_017 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `ocorrencias_dexpara` | `dexpara_select_authenticated` | select | authenticated | `true` | 2026-04-29_019 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `ocorrencias_dicionario` | `ocorrencias_dicionario_select_all` | select | authenticated | `true` | 2026-04-29_008 | mantida: referência (catálogo de ocorrências), usado pela op_v_fila |
| `operadores` | `operadores_select_all` | select | authenticated | `true` | 2026-04-29_001 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `perguntas_extras_cancelamento` | `perguntas_extras_select` | select | authenticated | `true` | 2026-08-25_353 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `prioridades_ai_saidas` | `prioridades_ai_saidas_select_authenticated` | select | authenticated | `true` | 2026-05-20_141 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `scan_email_config` | `scan_email_config_read` | select | authenticated | `true` | 2026-06-23_237 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `sync_status_global` | `sync_status_global_select_public` | select | authenticated, anon | `true` | 2026-06-03_188 | mantida: status público lido por anon (monitor) |
| `templates_email` | `templates_email_select_authenticated` | select | authenticated | `true` | 2026-05-01_035 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `tempo_oc21_para_oc14` | `tempo_oc21_14_select` | select | authenticated | `true` | 2026-05-18_112 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `triador_sombra_haiku` | `triador_sombra_select` | select | authenticated | `true` | 2026-09-14_392 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `usuarios_ssw_perdas` | `usuarios_ssw_perdas_select` | select | authenticated | `true` | 2026-05-29_180 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `wurth_evidencias_intranet` | `wurth_evid_select` | select | authenticated | `true` | 2026-08-14_341 | **431**: RESTRICTIVE `sep_somente_relacionamento` |
| `wurth_retornos_processados` | `wurth_retornos_select` | select | authenticated | `true` | 2026-08-11_331 | **431**: RESTRICTIVE `sep_somente_relacionamento` |

### B. As demais tabelas do Relacionamento que a 431 cobre (policy já depende de `current_operador_*` / `card_visivel_pelo_operador_atual` — quase sempre 0 linha para quem está fora; `motivo_bank` abre as linhas `aprovado` a qualquer authenticated). Restrictive aqui é defesa em profundidade.

`acoes_agendadas`, `agent_feedback`, `agent_runs`, `agente_oc13_feedback`, `agente_ocs_padrao_feedback`, `alertas_operador`, `analises_prioridades_ai`, `anthropic_usage_log`, `aprendizado_chat_mensagens`, `aprendizado_chat_sessoes`, `audit_log`, `cancelamentos_acao_autonoma`, `card_events`, `cards`, `cards_auditoria`, `cards_emails_outbound`, `clientes`, `cobrancas_disparadas`, `contatos_cliente`, `desfechos_pares`, `divergencia_motivos`, `edicoes_acao_autonoma`, `email_anexos`, `interpretador_resposta_cliente_feedback`, `learning_log`, `managed_agent_tool_calls`, `marcadores_processo_operador`, `messages_inbox`, `motivo_bank`, `operador_credencial_eventos`, `pendencias`, `popup_divergencia_config`, `sugestoes_texto_ia`, `todos`, `tracking_credentials`, `voz_templates`

### C. RPCs SECURITY DEFINER executáveis por authenticated (grant explícito OU default privileges do Supabase)

Legenda da coluna *Checa pessoa*: **sim** = o corpo (último CREATE em migration/) usa `current_operador_*`/`operadores`/`auth.uid()` — recusa quem não é membro, **conferir no corpo de produção** (`pg_get_functiondef`) antes de dar como fechado; **não** = não olha quem chama.

| Função | anon | Checa pessoa | Escreve | Front/monitor | Origem | Correção |
|---|---|---|---|---|---|---|
| `acoes_negocio_periodo` | sim | não | não | sim | 2026-06-23_251 | **P3**: agregado sem dado de cliente, lido pelo monitor-capacidade com **anon**; fechar só depois de o monitor usar token (como monitor_tokens) |
| `adotar_thread_preexistente` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `agendar_cobranca_email` | sim | não | sim | não | 2026-05-01_035 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `agentes_periodo` | sim | não | não | sim | 2026-06-23_252 | **P3**: idem (monitor com anon) |
| `anthropic_usage_periodo` | sim | não | não | sim | 2026-06-29_281 | **P3**: idem (monitor com anon) |
| `aprovar_e_executar` | não | sim | sim | sim | 2026-09-03_378 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `assert_pode_executar` | sim | sim | não | não | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `automacoes_falhas_periodo` | sim | não | não | sim | 2026-06-30_282 | **P3**: idem (monitor com anon) |
| `automacoes_periodo` | sim | não | não | sim | 2026-06-23_250 | **P3**: idem (monitor com anon) |
| `buscar_tratativa_do_card` | não | sim | sim | não | 2026-06-26_276 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `cadastrar_cliente_completo` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `cancelar_acao_autonoma` | não | sim | sim | sim | 2026-08-25_355 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `cancelar_acoes_agendadas_do_card` | sim | não | não | não | 2026-05-01_035 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `card_eh_intranet_wurth` | sim | não | não | sim | 2026-08-13_335 | **P3**: devolve só booleano; guard no corpo quando houver REPLACE |
| `card_visivel_pelo_operador_atual` | sim | sim | não | não | 2026-04-30_025 | predicado de RLS: devolve nulo/false para quem não é membro |
| `cards_cliente_respondeu_sem_proposta` | sim | não | não | não | 2026-06-23_239 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `chat_aprendizado_toca_sessao` | sim | não | não | não | 2026-08-08_318 | trigger: não é chamável por RPC |
| `cliente_pode_segregar_ctrc` | sim | não | não | sim | 2026-09-21_407 | **P3**: devolve só booleano; guard no corpo quando houver REPLACE |
| `complementar_resposta_aprendizado` | não | sim | sim | não | 2026-08-04_317 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `consolidar_automacoes_diarias` | sim | não | sim | não | 2026-06-23_250 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `cron_jobs_recent_failures` | sim | não | não | não | 2026-05-01_033 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `current_operador_carteira` | sim | sim | não | não | 2026-04-30_025 | predicado de RLS: devolve nulo/false para quem não é membro |
| `current_operador_id` | sim | sim | não | sim | 2026-04-30_025 | predicado de RLS: devolve nulo/false para quem não é membro |
| `current_operador_papel` | sim | sim | não | não | 2026-04-29_001 | predicado de RLS: devolve nulo/false para quem não é membro |
| `current_operador_pode_executar` | sim | sim | não | não | 2026-08-10_324 | predicado de RLS: devolve nulo/false para quem não é membro |
| `current_operador_segmentos` | sim | sim | não | não | 2026-04-30_025 | predicado de RLS: devolve nulo/false para quem não é membro |
| `demover_fatias_abaixo_da_meta` | sim | não | não | não | 2026-08-13_340 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `desativar_cliente` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `descartar_email_preexistente` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `devolucao_cte_em_escopo` | sim | sim | não | não | 2026-09-01_373 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `dlq_resumo_cliente` | sim | não | não | não | 2026-06-23_239 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `editar_acao_autonoma` | não | sim | sim | sim | 2026-08-25_355 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `encaminhar_alerta_operador_bug` | não | sim | sim | não | 2026-08-11_328 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `enqueue_scan_email_pre_card` | não | não | não | não | 2026-06-26_276 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `enviar_resposta_cliente` | não | sim | sim | não | 2026-04-30_024 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `escolher_tratativa_email` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `extravios_atualizar_status` | não | sim | não | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `fatia_esta_autonoma` | sim | não | não | não | 2026-08-13_340 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `fn_captura_correcao_veto` | sim | não | não | não | 2026-08-25_355 | trigger: não é chamável por RPC |
| `fn_erro_lancamento_vira_par` | sim | não | sim | não | 2026-08-13_340 | trigger: não é chamável por RPC |
| `fn_espelhar_feedback_agente` | sim | não | sim | não | 2026-08-21_346 | trigger: não é chamável por RPC |
| `fn_espelho_acao_autonoma` | sim | não | não | não | 2026-08-25_353 | trigger: não é chamável por RPC |
| `fn_marcar_processo_correto` | sim | sim | sim | não | 2026-08-21_345 | trigger: não é chamável por RPC |
| `fn_todo_status_cancela_veto` | sim | não | não | não | 2026-08-25_354 | trigger: não é chamável por RPC |
| `forcar_cancelamento_reentrega` | sim | sim | sim | não | 2026-05-18_108 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `gestao_operadores_tratativas` | não | sim | não | sim | 2026-08-24_349 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `ignorar_pendencias_resposta_cliente` | não | sim | sim | sim | 2026-08-24_350 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `lancar_oc_emergencial_acao_executada` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `liberar_card_suspeito_lockado` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `lookup_chave_cte` | sim | não | não | não | 2026-06-09_195 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `lookup_chaves_cte_alternativas` | sim | não | não | não | 2026-06-09_195 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `lookup_codigo_api` | sim | não | não | não | 2026-06-09_195 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `marcar_alerta_operador_lido` | não | sim | sim | sim | 2026-08-11_328 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `marcar_cancelamento_tratado` | sim | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `marcar_card_nao_importante` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `marcar_email_preexistente_visto` | não | sim | não | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `marcar_mudanca_suspeita_vista` | não | sim | não | não | 2026-06-18_218 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `marcar_retorno_inconclusivo` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `meu_dashboard_agentes` | sim | sim | não | sim | 2026-08-21_347 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `meu_dashboard_operacao` | sim | sim | não | sim | 2026-08-21_344 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `minutos_desde_ultimo_pass_e` | não | não | não | não | 2026-06-19_220 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `minutos_desde_ultimo_sync_bastao` | sim | não | não | não | 2026-05-25_167 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `monitor_sombra_oc49` | sim | não | não | sim | 2026-08-31_371 | gate por token de monitor (monitor_tokens) |
| `monitor_sombra_veredito` | sim | não | não | sim | 2026-08-27_362 | gate por token de monitor (monitor_tokens) |
| `notificar_agente_oc43` | sim | não | não | não | 2026-07-31_315 | trigger: não é chamável por RPC |
| `painel_acoes_autonomas` | não | sim | não | sim | 2026-08-28_367 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `painel_capacidade` | sim | sim | não | sim | 2026-06-23_249 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `pdi_eh_caio` | sim | sim | não | não | 2026-09-16_399 | predicado de RLS: devolve nulo/false para quem não é membro |
| `pdi_liberar_frente` | não | sim | não | sim | 2026-09-16_399 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `pdi_participante` | sim | sim | não | não | 2026-09-16_399 | predicado de RLS: devolve nulo/false para quem não é membro |
| `pdi_validar_entrega` | não | não | sim | sim | 2026-09-16_399 | PDI: gate próprio (pdi_participante) — fora do escopo |
| `pdi_validar_todo` | não | não | sim | sim | 2026-09-16_399 | PDI: gate próprio (pdi_participante) — fora do escopo |
| `pgmq_queue_length` | sim | não | não | não | 2026-05-01_033 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `playbook_vetos_ler` | sim | não | não | sim | 2026-09-01_372 | gate por token de monitor (monitor_tokens) |
| `playbook_vetos_responder` | sim | não | sim | sim | 2026-09-01_372 | gate por token de monitor (monitor_tokens) |
| `preview_email_todo` | não | não | não | sim | 2026-08-10_320 | **P2**: monta o e-mail de um todo por id (a RLS não deixa listar ids); guard `eh_membro_relacionamento()` no corpo (REPLACE, TIPO B) |
| `promover_fatia_autonoma` | sim | sim | sim | sim | 2026-08-21_348 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `reabrir_learning_log` | não | sim | não | sim | 2026-07-25_312 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_acerto_oc13_ia` | sim | sim | sim | sim | 2026-05-22_159 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_acerto_ocs_padrao_ia` | sim | sim | sim | sim | 2026-05-22_159 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_feedback_interpretador_resposta_ia` | sim | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_feedback_oc13_ia` | sim | sim | sim | sim | 2026-05-22_159 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_feedback_oc49_caso_desconhecido` | sim | sim | sim | sim | 2026-06-16_205 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_feedback_oc49_v2` | não | sim | sim | sim | 2026-08-27_363 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_feedback_ocs_padrao_ia` | sim | sim | sim | sim | 2026-08-13_337 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_motivo_divergencia` | não | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `registrar_par_agente` | sim | não | sim | não | 2026-08-13_338 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `rejeitar_acao` | não | sim | sim | não | 2026-04-30_023 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `reportar_erro_agente_extravio` | não | sim | sim | sim | 2026-06-24_258 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `reportar_erro_lancamento` | sim | sim | sim | sim | 2026-08-10_324 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `reportar_erro_ressarc54` | não | sim | sim | sim | 2026-06-25_269 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `resolve_assigned_operator_from_name` | sim | sim | não | não | 2026-07-21_305 | trigger: não é chamável por RPC |
| `resolver_email_cobranca_cliente` | sim | não | não | sim | 2026-08-10_320 | **P1**: devolve o e-mail do cliente por CNPJ a QUALQUER authenticated (e anon); guard `eh_membro_relacionamento()` no corpo (REPLACE, TIPO B) antes de ligar a operacao_tela |
| `responder_pergunta_aprendizado` | não | sim | sim | sim | 2026-07-23_311 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `revisar_learning_log` | sim | sim | não | sim | 2026-06-10_197 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `status_ultimo_sync_bastao` | sim | não | não | sim | 2026-06-18_217 | **P3**: status do sync, sem dado de cliente |
| `teste_rel_estado` | não | sim | não | sim | 2026-09-14_393 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `teste_rel_painel` | não | sim | não | sim | 2026-09-15_397 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `teste_rel_perguntas_lista` | não | sim | não | sim | 2026-09-14_395 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `teste_rel_responder` | não | sim | sim | sim | 2026-09-14_393 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `tirar_snapshot_capacidade` | sim | sim | sim | não | 2026-06-23_245 | ok (checa a pessoa no corpo) — conferir no corpo de produção |
| `ultima_rodada_wurth` | sim | não | não | sim | 2026-08-13_336 | **P3**: status do robô, sem dado de cliente |
| `validar_sql_readonly` | sim | não | não | não | 2026-06-10_199 | **431**: REVOKE de anon/authenticated (+ GRANT service_role) |
| `voltar_para_to_do` | não | sim | sim | não | 2026-05-11_080 | ok (checa a pessoa no corpo) — conferir no corpo de produção |

Total: 104 funções.

### D. Visões que leem como o dono (sem `security_invoker`) — a RLS não vale nelas

| Visão | Origem | Usada pelo front? | Correção |
|---|---|---|---|
| `v_agent_feedback_unificado` | 339 | não (só a edge agente-aprendizado, service_role) | **431**: REVOKE SELECT de anon/authenticated |
| `v_agent_feedback_unificado_legado` | 339 | não | **431**: idem |
| `v_fatias_candidatas_autonomia` | 340 | não | **431**: idem |
| `v_placar_agente` | 338 | não | **431**: idem |
| `v_placar_agente_erros` | 338 | não | **431**: idem |

As demais visões do schema têm `security_invoker = true` (a RLS das tabelas de baixo
vale, e com a 431 ela fecha para quem não está em `operadores`). A nova `op_v_fila`
também nasce com `security_invoker = true`.

### E. Edge functions chamáveis por qualquer usuário logado (ou por qualquer um)

Levantado em `supabase/functions/*/index.ts` + `supabase/config.toml`. Toda função com
entrada no `config.toml` usa `verify_jwt = false`; sem entrada, o default `true` só
exige um JWT do projeto (qualquer usuário logado, e normalmente a anon key) — **não é
checagem de membro**. Atenção ao `_shared/trava-visualizacao.ts`
(`bloquearSeModoVisualizacao`): parece checar `operadores`, mas **deixa passar** quem
não tem linha ("Sem operador → passa").

**Chamadas pelo front e SEM conferir que a pessoa está em `operadores`** — um membro da
Operação (ou qualquer um, onde `verify_jwt = false`) consegue acionar:

| Edge | verify_jwt | O que faz | Prioridade |
|---|---|---|---|
| `atualizar-card-via-portal-ssw` | false | lê o SSW e mexe no card por qualquer `card_id` | **P1** |
| `puxar-historico-ssw-card` | false | histórico SSW de qualquer card | **P1** |
| `enviar-retificacao-evidencia` | true | manda e-mail ao cliente por qualquer `card_id` | **P1** |
| `cobrar-cliente-aguardando` | false | manda e-mail ao cliente (só o guard fail-open) | **P1** |
| `send-whatsapp-message` | false | manda WhatsApp; `operador_id` vem do corpo | **P1** |
| `criar-instancia-whatsapp` / `whatsapp-instance-status` | false | instância Evolution; `operador_id` do corpo | P2 |
| `redator` / `redator-email-saida` | false | rascunho por IA sobre card/mensagens (guard fail-open) | P2 |
| `agente-sugere-ocs-padrao` | false | roda o agente em qualquer `card_id` | P2 |
| `scan-email-pre-card` | false | varre Gmail para qualquer `scan_card_id` | P2 |
| `robo-intranet-wurth` | false | decodifica o JWT **sem verificar assinatura** | P2 |
| `analisar-indicador-erros-lancamento` | true | indicadores + IA (sem dado de card) | P3 |
| `enviar-cobranca-base` | true | caminho sem usuário aceita `operador_id_override` sem checar service_role | P2 |
| `alterar-especie-cliente(-lote)`, `revalidar-evidencia-card` | true | sem chamador no front; sem checagem | P3 |

Já seguras para a Operação **porque a RLS de `cards` esconde o card** de quem está fora
(se um dia `cards` ganhar policy para membros da Operação, elas abrem):
`cobrar-ressarcimento-wpp`, `executar-sugestao-evidencia`, `foto-oc-card`,
`interpretador-evidencia-foto`. Conferem `operadores` explicitamente:
`atualizar-extravios-todas`, `confirmar-dossie-oc33`, `criar-card-manual`,
`oauth-gmail-start`, `upload-anexo-email`, `encaminhar-alerta-bug` (via RPC),
`forcar-cancelamento-reentrega` (via RPC), `voltar-para-to-do-com-rastreio` (via RPC),
`agente-chefe-chat` (gestor).

Os workers de cron/pipeline com `verify_jwt = false` e sem gate (`executor`,
`sync-bastao`, `vinculador`, `enviar-resposta`, `processar-acoes-agendadas`,
`interpretador-resposta-cliente`…) dependem de não serem descobertos. Não é tema da
Operação, mas é o mesmo buraco.

**Correção proposta (não aplicada aqui — mexe em edge do Relacionamento, pinada pela
ponte em parte):** um helper único `exigirMembroRelacionamento(req)` em `_shared/`
(token do usuário → `operadores` por `user_id`, 403 se não houver; service_role passa
pelo probe de capacidade) chamado no topo de cada edge da lista P1/P2, e o
`bloquearSeModoVisualizacao` passando a recusar quem não tem linha. **Antes de ligar a
`operacao_tela` (ADR 0041, passo 5), as P1 precisam estar fechadas.**

**Bônus da 431:** o probe `ehChamadaServiceRole` (`_shared/service-auth.ts`, usado por
`cerebro-veto-dossie` e `converter-anexo-pdf`) testa a RPC
`cancelar_acoes_agendadas_do_card` presumindo que só o service_role a executa. A mig 411
mediu em produção grant explícito dela para anon/authenticated — ou seja, o probe hoje
**aceita qualquer usuário logado**. A 431 revoga essa RPC de anon/authenticated, e o
probe volta a significar "é service_role". Os chamadores conhecidos das duas edges são
internos (service_role). As edges novas da Operação usam um probe próprio
(`op_vigia_resumo`, só service_role desde a 430), que não depende da 431.

## O lado inverso: quem não é da Operação nem gestor não lê `op_*`

| Objeto | Quem lê | Escrita |
|---|---|---|
| `op_itens`, `op_v_fila` | membro: unidade dele e com `operacao_tela` ON; supervisor_op: todas (com a flag); gestor: tudo, sempre | só RPC |
| `op_eventos`, `op_lancamentos` | quem vê o item (EXISTS sobre `op_itens`, RLS em cascata) | só RPC |
| `op_codigos_lancaveis` | membro ativo ou gestor | migration TIPO B |
| `op_regra_unidade_por_oc`, `op_acoes_executadas_ssw` | supervisor_op ou gestor | migration / envelope |
| `operacao_membros` | a própria linha; supervisor_op; gestor | service_role (cadastro) |
| `op_materializacoes` | ninguém além do service_role | service_role |

Operador do Relacionamento (sem ser gestor) não passa em nenhum predicado — provado no
teste SQL ("Relacionamento leu op_itens" etc.).

## Pré-check antes de aplicar a 431 (rodar pelo trilho, leitura)

```sql
-- quem loga e NÃO está em operadores (perde o Relacionamento ao aplicar a 431)
select u.id, u.email, u.last_sign_in_at
  from auth.users u
 where not exists (select 1 from public.operadores o where o.user_id = u.id)
 order by u.last_sign_in_at desc nulls last;

-- policies vivas que não estão em migration/ (drift)
select tablename, policyname, roles, cmd, qual
  from pg_policies where schemaname = 'public' order by 1, 2;

-- quem executa as 17 RPCs que a 431 fecha (deve sobrar só postgres/service_role depois)
select p.oid::regprocedure, p.proacl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in (
   'agendar_cobranca_email','cancelar_acoes_agendadas_do_card','cards_cliente_respondeu_sem_proposta',
   'consolidar_automacoes_diarias','cron_jobs_recent_failures','demover_fatias_abaixo_da_meta',
   'dlq_resumo_cliente','enqueue_scan_email_pre_card','fatia_esta_autonoma','lookup_chave_cte',
   'lookup_chaves_cte_alternativas','lookup_codigo_api','minutos_desde_ultimo_pass_e',
   'minutos_desde_ultimo_sync_bastao','pgmq_queue_length','registrar_par_agente','validar_sql_readonly');
```

Se a primeira consulta trouxer alguém do Relacionamento, cadastrar em `operadores`
ANTES (ou ele perde o acesso). Contas de máquina que logam como usuário também
aparecem ali.

## Achado fora do escopo (P1 do Relacionamento)

`operadores_update_self` (mig 001) deixa todo operador fazer `UPDATE` da própria
linha — **inclusive `papel = 'gestor'`, `carteira` e `pode_executar`**. Não foi
corrigido aqui porque restringe quem JÁ está em operadores (fora da regra "só fechar
quem está de fora"). Correção sugerida: policy RESTRICTIVE `FOR UPDATE` com
`WITH CHECK (papel = (select current_operador_papel()) and pode_executar = (select
current_operador_pode_executar()))` — a função lê a linha antiga (snapshot do comando)
— ou mover o "desconectar Gmail" para RPC e tirar o UPDATE direto. Dono: Caio.

## Pendências e donos

| # | O quê | Dono | Quando |
|---|---|---|---|
| 1 | Pré-check acima + `pg_get_functiondef` das funções "conferir no corpo" | Caio/Carlos (trilho) | antes da 431 |
| 2 | Edges P1 da seção E com `exigirMembroRelacionamento` | Caio | antes de `operacao_tela` ON |
| 3 | `resolver_email_cobranca_cliente` (P1, seção C) com guard no corpo | Caio | antes de `operacao_tela` ON |
| 4 | Edges/RPCs P2/P3 | Caio | sem pressa |
| 5 | `operadores_update_self` (escalada a gestor) | Caio | já |
| 6 | Monitor-capacidade com anon (5 RPCs de período) → token | Caio | quando mexer no monitor |

## Como a separação é provada

- `supabase/tests/operacao/operacao-separacao.test.sql` (Postgres local descartável,
  `supabase/tests/operacao/rodar-local.sh`): com a sessão de cada tipo de pessoa
  (membro da Operação de duas unidades, supervisor, operador, gestor, sem papel, anon)
  conta o que cada um lê/escreve. Controle negativo: rodado SEM a 431, falha em
  "Operação leu contatos_escalonamento (USING true)".
- `operacao-isolamento.test.ts` (deno, estático): a 431 só cria policy RESTRICTIVE,
  só derruba policy dela, não concede nada, e cobre as tabelas centrais.
