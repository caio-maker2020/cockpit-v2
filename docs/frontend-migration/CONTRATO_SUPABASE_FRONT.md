# Contrato Supabase do Front — Cockpit v2

> **Fonte:** grep do `src/` do export (call sites reais: `.from`, `.rpc`, `functions.invoke`, `.channel`) + `CREATE FUNCTION` reais em `migration/*.sql` + folders em `supabase/functions/`.
> **Regra desta fase:** NÃO alterar backend. Este doc mapeia o contrato pro novo front **reproduzir 100%**. Contratos ruins/inseguros → [BACKEND_PENDING.md](./BACKEND_PENDING.md), não corrigir agora.
> **Data:** 2026-07-03.

## 1. Cliente Supabase
- URL: `https://xjbycvscljqoqpjkmevb.supabase.co` (project ref `xjbycvscljqoqpjkmevb`).
- Anon key: hardcoded em `lib/supabase.ts` (publicável; RLS protege). **Mover pra `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`** (env Vercel) — R4.
- `createClient(..., { auth: { persistSession, autoRefreshToken, detectSessionInUrl } })`.

## 2. RPCs chamadas pelo front (19) — assinaturas reais
> Todas `SECURITY DEFINER` no backend (checam `current_operador_id()`/papel internamente). Retorno padrão `jsonb {ok, resultado, ...}` salvo indicado.

| RPC | Assinatura real (migration) | Retorno | Tela / uso |
|---|---|---|---|
| `aprovar_e_executar` | `(p_todo_id uuid, p_extras jsonb DEFAULT NULL)` | jsonb | **núcleo** — aprovar ação do agente; `extras` carrega skip_evidencia, forçar CTRC baixado, template override etc. **DESTRUTIVA.** |
| `preview_email_todo` | `(p_todo_id uuid, p_template_id_override text DEFAULT NULL)` | jsonb | pré-visualizar e-mail antes de enviar (read-only) |
| `ignorar_pendencias_resposta_cliente` | `(p_card_id uuid, p_motivo text DEFAULT NULL)` | jsonb | botão "ignorar e seguir" (respeita INV-019) |
| `listar_tratativas_email_do_card` | `(p_card_id uuid)` | jsonb | listar threads de e-mail do card (read-only) |
| `escolher_tratativa_email` | `(p_card_id uuid, p_thread_id text DEFAULT NULL)` | jsonb | vincular card a thread |
| `adotar_thread_preexistente` | `(p_card_id uuid, p_gmail_thread_id text)` | jsonb | adotar e-mail preexistente |
| `descartar_email_preexistente` | `(p_card_id uuid)` | jsonb | descartar candidato de e-mail |
| `marcar_email_preexistente_visto` | `(p_card_id uuid)` | (confirmar) | marcar banner visto |
| `marcar_cancelamento_tratado` | `(p_acao_id bigint, p_motivo text DEFAULT NULL)` | void | canc. reentrega tratado |
| `marcar_retorno_inconclusivo` | `(p_card_id uuid, p_motivo text DEFAULT NULL)` | jsonb | marcar retorno inconclusivo |
| `marcar_card_nao_importante` | `(p_card_id uuid, p_motivo text DEFAULT NULL)` | jsonb | despriorizar card |
| `liberar_card_suspeito_lockado` | `(p_card_id uuid)` | (confirmar) | destravar card em conflito |
| `lancar_oc_emergencial_acao_executada` | `(p_card_id uuid, p_codigo_ssw int, p_texto_descricao text DEFAULT NULL, p_anexo_id uuid DEFAULT NULL)` | jsonb | lançar oc emergencial. **DESTRUTIVA (SSW).** |
| `extravios_atualizar_status` | há def `()` — call site passa payload → confirmar overload | jsonb | mudar status extravio |
| `reportar_erro_lancamento` | `(p_card_id uuid, p_codigo_oc_errada int, p_codigo_oc_correta int, p_descricao_oc_errada text DEFAULT NULL, p_data_oc_errada text DEFAULT NULL, p_base_responsavel text DEFAULT NULL, p_usuario_responsavel text DEFAULT NULL, p_motivo text DEFAULT NULL, p_motivo_categoria text DEFAULT 'OC_DIFERENTE')` | bigint | reportar erro de lançamento |
| `registrar_feedback_interpretador_resposta_ia` | `(p_card_id uuid, p_acertou boolean, p_decisao_correta_codigo_ssw int DEFAULT NULL, p_motivo_correcao text DEFAULT NULL)` | uuid | feedback IA acertou/errou |
| `cadastrar_cliente_completo` | `(p_documento text, p_nome text, p_senha_tracking text DEFAULT NULL, p_contatos jsonb DEFAULT '[]', p_operador_responsavel_id uuid DEFAULT NULL, p_notes text DEFAULT NULL)` | jsonb | cadastro de cliente |
| `desativar_cliente` | `(p_documento text)` | (confirmar) | desativar cliente |
| `status_ultimo_sync_bastao` | `()` | jsonb/int | saúde do sync Bastão (header) |

> **`rejeitar`/`voltar_para_to_do`:** o call site aparece via fluxo; existe edge `voltar-para-to-do-com-rastreio` — confirmar se é RPC ou edge na Fase 1.

## 3. Edge Functions chamadas do browser (15) — todas confirmadas como folder em `supabase/functions/`
> Auth: JWT do usuário no header (a maioria cria `supabaseUser` com o token e checa `auth.getUser()`); `admin-operadores` checa e-mail super-admin server-side; `recuperar-senha-operador` usa service role internamente. Payloads exatos a pinar na Fase 1 (camada `src/api/`).

| Edge fn | Uso | Tipo | Confirmado |
|---|---|---|---|
| `criar-card-manual` | criar card manual (NF+pagador, escolher CTRC) | mutação | payload a confirmar |
| `responder-email-cliente` | responder cliente. **DESTRUTIVA (e-mail).** | mutação | usa `auth.getUser()` |
| `redator` | (re)gerar texto de resposta | IA | `{ card_id, force = false }` |
| `redator-email-saida` | gerar e-mail de saída | IA | — |
| `upload-anexo-email` | upload de anexo (bucket `email_anexos`) | storage | multipart |
| `executar-sugestao-evidencia` | executar sugestão de evidência. **DESTRUTIVA.** | mutação | usa `supabaseUser` |
| `puxar-historico-ssw-card` | puxar histórico SSW do card | leitura SSW | usa card |
| `atualizar-card-via-tracking` | forçar atualização via tracking | mutação | — |
| `atualizar-extravios-todas` | atualizar todos extravios | mutação | — |
| `forcar-cancelamento-reentrega` | cancelar reentrega. **DESTRUTIVA.** | mutação | wrapa RPC `forcar_cancelamento_reentrega` |
| `cobrar-cliente-aguardando` | cobrança cliente aguardando. **DESTRUTIVA.** | mutação | — |
| `enviar-cobranca-base` | disparar cobrança de base. **DESTRUTIVA.** | mutação | usa `auth.getUser()` |
| `admin-operadores` | gerenciar operadores | admin | checa super-admin (Caio+Isadora) → 403 senão |
| `oauth-gmail-start` | iniciar OAuth Gmail | oauth | — |
| `recuperar-senha-operador` | esqueci senha (envia código) | auth | anon; service role interno |

> **NÃO chamar do browser** (cron/fila/webhook): triador, sync-bastao, sync-extravios-bastao, gmail-poll-inbox, executor, ingestor, vinculador, agente-*, processar-*, webhook-*, reprocessar-dlq, etc.

## 4. Tabelas lidas diretamente
`cards`, `card_events`, `todos`, `operadores`, `messages_inbox`, `email_anexos`, `cards_emails_outbound`, `contatos_cliente`, `contatos_escalonamento`, `clientes`, `tracking_credentials`, `templates_email`, `ocorrencias_dicionario`, `acoes_agendadas`, `erros_lancamento_ssw`, `agente_oc13_feedback`, `agente_ocs_padrao_feedback`, `interpretador_resposta_cliente_feedback`.

## 5. Views (`v_*`) lidas
`v_cards_requer_atencao` (Conflitos + badge), `v_email_preexistente`, `v_cancelamentos_reentrega` (+ badge), `v_extravios_kanban`, `v_card_events_legivel`, `v_agente_extravio_auditoria`, `v_agente_extravio_metricas`, `v_ressarc54_auditoria`, `v_ressarc54_metricas`, `v_agente_oc13_metricas`, `v_agente_ocs_padrao_metricas`, `v_indicador_erros_lancamento_base`.

## 6. Escritas diretas do browser (⚠️ auditar)
| Tabela | Operação | Onde | Veredito |
|---|---|---|---|
| `card_events` + `cards` | `insert` + `update state` | `CardIdentification.tsx:492-506` (resolver/cancelar manual) | **R1 — viola INV-002 (event sourcing).** Isolar em módulo `// BACKEND-PENDING R1`; virar RPC no futuro. |
| `contatos_escalonamento` | insert/update/delete | Cadastros (gestor) | RLS-gated; aceitável (R3 — revisar RLS). |
| `contatos_cliente` | insert | Cadastros | RLS-gated; aceitável (R3). |

**Regra dura:** nenhum outro write direto em `cards`/`card_events`/`todos`. Toda mutação de estado passa por RPC/edge.

## 7. Realtime
Padrão único: `useRealtimeInvalidate(table, queryKey, filter?)` → subscribe `postgres_changes` (event `*`, schema `public`) → `qc.invalidateQueries(queryKey)` com **debounce 1s** (fix apagão 2026-06-23). Tabelas assinadas: **`cards`, `card_events`, `todos`**. Canais nomeados avulsos: `extravios-kanban`, `auditoria-autonomas`.

## 8. Storage
Bucket **`email_anexos`** (privado). Upload via edge `upload-anexo-email` (não `storage.from()` no browser). Fotos de evidência via edge `foto-oc-card`/URL. Downloads por signed URL.

## 9. Papéis / RLS por tela
- `operador` resolvido de `operadores` (`id,user_id,nome,email,papel,carteira,ativo`) por `user_id = auth.uid()`.
- RLS filtra `cards` (e derivados) por operador; gestor vê tudo.
- Administração: gate real no edge `admin-operadores` (super-admins Caio+Isadora). Front deve espelhar allowlist + tratar 403 (R2).

## 10. Matriz Tela → Dados → Fonte → Permissão → Ação → Risco
| Tela/Fluxo | Dados | Fonte | Permissão | Ação | Risco |
|---|---|---|---|---|---|
| Login | sessão, operador | Auth + `operadores` | pública→auth | login | Baixo |
| Inbox | cards + contagem | `cards` (RLS) + realtime | operador | filtrar/abrir | contagem escala? índice |
| Detalhe | card/eventos/todos/emails/anexos | `cards`,`card_events`,`todos`,`messages_inbox`,`email_anexos` | RLS | aprovar/responder/lançar | **Alto** |
| Aprovar&executar | todo | RPC `aprovar_e_executar` | SECURITY DEFINER | aprovar | Alto (destrutiva) |
| Resolver/Cancelar | — | write direto `card_events`+`cards` | RLS | encerrar | **R1** |
| E-mail preexistente | candidatos | `v_email_preexistente` + RPCs | RLS | adotar/descartar | Médio |
| Conflitos | atenção | `v_cards_requer_atencao` + edge | RLS | forçar SSW | Médio |
| Extravios | kanban | `v_extravios_kanban` + RPC | RLS | mudar status | Médio |
| Canc. reentrega | lista/detalhe | `v_cancelamentos_reentrega` + RPCs/edge | RLS | tratar/inconclusivo | Médio |
| Indicadores | métricas | `v_*_metricas` + feedback tables | gestor/op | ver/feedback | query pesada? medir |
| Cadastros | clientes/contatos | tabelas (+writes RLS) | RLS/gestor | CRUD | R3 |
| Administração | operadores | edge `admin-operadores` | super-admin | gerenciar | R2 |

## 11. Gaps a fechar ANTES de codar cada módulo `src/api/` (Fase 2)
> Fase 0 (este doc) só **mapeia** os gaps. O **fechamento** é per-módulo, lendo a fonte real — **não inventar** retorno/payload.
1. Retornos exatos de `marcar_email_preexistente_visto`, `liberar_card_suspeito_lockado`, `desativar_cliente`, `status_ultimo_sync_bastao`.
2. Overload real de `extravios_atualizar_status` (call site passa args; def encontrada é `()`).
3. `rejeitar`/`voltar_para_to_do`: RPC ou edge `voltar-para-to-do-com-rastreio`?
4. Payloads exatos das 15 edge functions (ler cada `index.ts`).
5. Confirmar publicação de realtime nas tabelas `cards`/`todos`/`card_events` (Supabase Realtime habilitado).
