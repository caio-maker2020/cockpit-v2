# Mapa de agentes — Cockpit v2

Dois grupos: **verticais** (LLM raciocinando sobre tratativa) e **horizontais** (infra, em parte determinística).

## Princípios de design de agente

1. **Loop curto.** Cada invocação faz 1 step (≤150s, cabe em Edge Function). Steps são reenfileirados em pgmq.
2. **Tool-first.** Tools determinísticas (consultar_ssw, lancar_ocorrencia, etc.) são funções. LLM só decide *qual* usar e *quando*.
3. **Modelo certo pra tarefa.** Haiku 4.5 pra classificação simples; Sonnet 4.6 pro raciocínio do agente; Opus 4.7 só pra auditoria periódica e casos especiais.
4. **Saída sempre estruturada** (JSON schema). Sem parsing frágil.
5. **Idempotência.** Toda ação tem `idempotency_key` derivada de `(card_id, tipo_acao, params_hash)`.
6. **Validação humana é padrão.** Auto-aprovação por feature flag por tipo de ação, depois de medição.

## Agentes verticais

### 1. Triador
- **Gatilho:** mensagem em `pgmq.agent_intake`
- **Modelo:** Haiku 4.5
- **Input:** texto da mensagem + canal + remetente + histórico 24h
- **Tools:** nenhuma (classificação pura)
- **Output:** `{ tipo, risco, resumo, descricao_problema, nfs[], ctrcs[], nome_cliente, empresa_cliente, requer_acompanhamento }`
- **Próximo:** publica evento `ClassificacaoConcluida`, enfileira em `agent_intake_vincular`

### 2. Vinculador
- **Gatilho:** mensagem classificada
- **Modelo:** Haiku 4.5 (só pra fallback de "thread match")
- **Tools:** `find_card_by_ctrc`, `find_card_by_nf`, `find_card_by_email_domain`, `find_card_by_contact`, `find_card_by_recent_sender`
- **Lógica:** 6 prioridades de dedup (ver `lib/dedup-rules.ts`)
- **Output:** `card_id` (existente) ou cria novo
- **Próximo:** card transita pra `AGUARDANDO_AGENTE`, enfileira no agente especialista correto

### 3. Rastreamento
- **Gatilho:** card `tipo=rastreamento`
- **Modelo:** Sonnet 4.6
- **Tools:** `consultar_ssw_status(nf)`, `traduzir_status_para_cliente`
- **Output:** mensagem proposta de resposta
- **Validação humana:** padrão SIM. **Candidato a auto-aprovação** após coleta de baseline (>97% aprovação em 30d).

### 4. Reentrega ⭐ (primeiro a ser implementado)
- **Gatilho:** card `tipo=reentrega`
- **Modelo:** Sonnet 4.6
- **Tools:** `consultar_ssw_status`, `lancar_ocorrencia(21)`, `agendar_pendencia(D+1)`, `enviar_resposta_cliente`
- **Mini-FSM:** `aguardando_confirmacao_endereco` → `endereco_confirmado` → `aguardando_lancamento_21` → `ocorrencia_21_lancada` → `aguardando_followup_d+1`
- **Output:** ocorrência 21 lançada + cliente notificado + pendência D+1 agendada
- **Validação humana:** padrão SIM no MVP.

### 5. Devolução
- **Gatilho:** card `tipo=devolucao` ou autorização recebida
- **Modelo:** Sonnet 4.6
- **Tools:** `validar_autorizacao_devolucao`, `lancar_ocorrencia(DEV)`, `iniciar_processo_devolucao`, `enviar_resposta_cliente`
- **Output:** processo de devolução aberto + cliente notificado
- **Validação humana:** SIM. Devolução é caro pra errar.

### 6. Avaria
- **Gatilho:** card `tipo=avaria`
- **Modelo:** Sonnet 4.6
- **Tools:** `coletar_evidencias` (extrai fotos do WA), `classificar_gravidade`, `verificar_seguro`, `abrir_processo_avaria`, `escalar_humano`
- **Decisão de escalada:** se gravidade alta OU houver seguro envolvido → escala automaticamente
- **Validação humana:** SEMPRE (mesmo após maturação). Risco financeiro alto.

### 7. Extravio
- **Gatilho:** card `tipo=extravio`
- **Modelo:** Sonnet 4.6
- **Tools:** `buscar_em_filiais_ssw`, `consultar_motorista`, `escalar_humano`
- **Decisão:** se não localizado em N tentativas → escala
- **Validação humana:** SIM.

### 8. Inversão
- **Gatilho:** card `tipo=inversao`
- **Modelo:** Sonnet 4.6
- **Tools:** `cruzar_nfs_proximas`, `identificar_par_invertido`, `lancar_ocorrencia_correcao`, `notificar_ambos_clientes`
- **Validação humana:** SIM.

### 9. Cobrança / Indenização
- **Gatilho:** SLA estourado OU ocorrência específica
- **Modelo:** Sonnet 4.6
- **Tools:** `calcular_indenizacao`, `montar_demonstrativo`, `notificar_responsavel`
- **Validação humana:** SEMPRE (financeiro).

## Agentes horizontais (infra)

### Ingestor
- **Tipo:** Edge Function (sem LLM)
- **Função:** Recebe webhooks (Evolution, Postmark inbound), normaliza payload, publica em `pgmq.agent_intake`. Aplica fix do 9º dígito brasileiro em telefones WhatsApp.

### Notificador
- **Tipo:** Edge Function (sem LLM)
- **Função:** Envia mensagem ao cliente via canal correto (Evolution ou Resend), com retry, idempotency key, e registro em `audit_log`.

### SSW Adapter
- **Tipo:** lib (`lib/ssw-client.ts`), sem LLM
- **Função:** Cliente HTTP do SSW com cache de token (1h), retry exponencial, idempotency key por (card_id, codigo, params), normalização de erros.

### Auditor (periódico)
- **Tipo:** Edge Function chamada por pg_cron diário
- **Modelo:** Opus 4.7
- **Função:** Sample 5% das ações executadas pelos agentes na semana, avalia qualidade, propõe ajustes de prompt ou regras de auto-aprovação.
- **Output:** relatório em tabela `auditor_findings` + alertas se taxa de erro >2%.

### Knowledge Base (RAG)
- **Tipo:** lib (não é agente em si — é tool consultável)
- **Função:** Busca casos similares no histórico de cards resolvidos. Embeddings em pgvector. Agentes especialistas chamam quando precisam de precedente.

## Tabela: validação humana por agente

| Agente | Padrão MVP | Caminho pra auto-aprovação |
|---|---|---|
| Triador | n/a (não age) | n/a |
| Vinculador | n/a (não age) | n/a |
| Rastreamento | SIM | Auto após >300 ações + >97% aprovação |
| Reentrega | SIM | Auto possível após maturação |
| Devolução | SIM | **Não automatiza** — alto custo de erro |
| Avaria | SIM | **Não automatiza** — risco financeiro |
| Extravio | SIM | **Não automatiza** — risco operacional |
| Inversão | SIM | **Não automatiza** — afeta 2 clientes |
| Cobrança | SIM | **Não automatiza** — financeiro |

Resumo: longo prazo, **rastreamento e parte da reentrega** são candidatos a auto. Os demais sempre passam por humano.
