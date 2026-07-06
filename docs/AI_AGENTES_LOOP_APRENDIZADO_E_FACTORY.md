# IA no Cockpit — loop de aprendizado e factory de agentes

Data da leitura: 2026-07-01

## Resumo executivo

O Cockpit ja tem a base certa para virar um sistema de agentes autonomos:
`card_events`, `todos`, `agent_runs`, `acoes_executadas_ssw`, snapshots de
auditoria e feature flags. O problema nao e ausencia de dados; e que o feedback
esta fragmentado por agente e ainda nao existe um placar unico que responda:

- quem sugeriu;
- qual acao exata foi sugerida;
- se o operador seguiu, ignorou ou escolheu outra coisa;
- se a execucao no SSW/e-mail deu certo;
- se o resultado posterior confirmou ou contradisse a decisao.

Minha recomendacao: criar uma camada chamada **Agent Learning Loop**, baseada
em views e uma tabela generica de feedback, e usar isso como gate para liberar
mais autonomia nos proximos 30 dias.

## Foto atual, baseada no repo e no banco

### O que ja existe

- `agent_runs`: historico tecnico de execucao dos agentes.
- `todos`: acoes propostas e aprovadas/rejeitadas.
- `card_events`: timeline canonica do card.
- `acoes_executadas_ssw`: resultado real de lancamentos SSW.
- `cards_auditoria` e `v_auditoria_acoes_autonomas`: snapshots de acoes 100%
  autonomas.
- Tabelas especificas de feedback:
  - `agente_oc13_feedback`
  - `agente_ocs_padrao_feedback`
  - `interpretador_resposta_cliente_feedback`
- `learning_log`: caderno para padroes, ajustes sugeridos e impacto medido.
- `anthropic_usage_log`: desenhado para medir custo, mas a migration marca
  que ainda nao estava aplicada em producao quando criada.

### Numeros observados nos ultimos 30 dias

Operacao:

| Metrica | Volume |
|---|---:|
| Lancamentos SSW com sucesso | 2.104 |
| Lancamentos SSW com falha | 27 |
| Lancamentos SSW pendentes | 1 |
| E-mails outbound | 1.957 |
| Cards resolvidos | 502 |

Eventos de agentes e propostas:

| Evento | Volume |
|---|---:|
| `TodoPropostoAutomaticamente` | 4.517 |
| `AprovacaoOperador` | 2.533 |
| `TodosConcorrentesCancelados` | 2.530 |
| `AgenteOcsPadraoDecisao` | 1.691 |
| `InterpretadorRespostaClienteConcluido` | 1.430 |
| `AgenteOc13Decisao` | 299 |
| `AutoAprovacaoPermitida` | 84 |
| `AgenteExtravioLancou49` | 42 |
| `RessarcRelancar54Lancou` | 30 |

Feedback dos ultimos 30 dias:

| Agente | Acertos | Erros | Leitura |
|---|---:|---:|---|
| `ocs_padrao` | 490 | 130 | Bom para achar bolsos de autonomia por OC/cliente, nao para ligar geral. |
| `interpretador_resposta` | 202 | 109 | Ainda fraco para autonomia direta; bom para melhorar prompt/regras. |
| `oc13` | 3 | 41 | Nao deveria ganhar autonomia pelo placar atual. |

Observacao: nos `ocs_padrao`, ha tambem 3 casos `caso_nao_reconhecido`.

## Diagnostico CTO

### 1. O dado mais valioso ja existe, mas nao esta normalizado

O feedback implicito e o ouro: quando o operador aprova a mesma sugestao, e
acerto; quando aprova outra acao, e erro/correcao. O executor ja faz isso para
alguns agentes, mas o modelo ainda e especifico por familia.

O proximo passo nao e criar outra tela de log. E criar uma semantica unica:

```
decisao do agente -> acao sugerida -> decisao do operador -> execucao -> resultado posterior
```

### 2. `todos.status` sozinho nao mede adocao

Ha muitos `cancelado` porque, quando o operador aprova uma proposta, propostas
concorrentes do mesmo card sao canceladas. Isso e correto operacionalmente, mas
nao significa que a IA errou.

Para medir adocao, a chave deve ser:

- proposta destacada pelo agente (`acao_key`, `proposta_destacada_acao`, ou
  equivalente);
- todo aprovado pelo operador;
- comparacao entre `acao_key` sugerida e `acao_key` aprovada.

### 3. Autonomia precisa de dois gates separados

Um agente pode decidir certo e executar mal. Ou executar bem uma decisao ruim.
O placar deve separar:

- **qualidade da decisao:** seguiu vs corrigiu, feedback explicito, auditoria;
- **confiabilidade da execucao:** SSW/e-mail ok, idempotencia, tripes, falhas,
  timeouts, retries;
- **qualidade do resultado:** card resolveu, reabriu, cliente respondeu
  negativamente, operador reportou erro.

## Loop de aprendizado pro Cockpit

### Camada 1 — capturar decisao

Toda decisao de agente deve gerar um evento padrao em `card_events`:

```json
{
  "agent_name": "agente-sugere-ocs-padrao",
  "agent_version": "2026-07-01",
  "mode": "shadow|recommend|auto",
  "decision_type": "sugerir_acao|nao_rodou|executar_autonomo",
  "action_key": "lancar_ocorrencia_e_email:54",
  "tool": "lancar_ocorrencia_e_email",
  "codigo_ssw": 54,
  "confidence": 0.86,
  "rationale_code": "cliente_precisa_responder",
  "guardrails_passed": ["ctrc_card", "nf_card", "acao_key_unica"],
  "prompt_version": "agente-x-v3",
  "model": "claude-haiku-4-5"
}
```

Para nao reescrever tudo agora, primeiro crie uma view `v_agent_decisions`
unificando os eventos ja existentes:

- `AgenteOcsPadraoDecisao`
- `AgenteOc13Decisao`
- `InterpretadorRespostaClienteConcluido`
- `TodoPropostoAutomaticamente`
- `AgenteExtravioLancou49`
- `RessarcRelancar54Lancou`
- futuros eventos de agente

### Camada 2 — capturar decisao do operador

Criar uma view `v_agent_operator_decisions` a partir de:

- `AprovacaoOperador`
- `AutoAprovacaoPermitida`
- `RejeicaoOperador`
- `TodosConcorrentesCancelados`
- `todos.approved_by`, `todos.approved_at`, `todos.auto_approval_rule`

Classificacao:

| Resultado | Regra |
|---|---|
| `seguida` | operador aprovou o mesmo `action_key` destacado pelo agente |
| `corrigida` | operador aprovou outro `action_key` |
| `rejeitada` | operador clicou rejeitar / reportar erro |
| `ignorada` | sem acao apos SLA definido |
| `auto_executada` | `auto_approval_rule IS NOT NULL` |
| `nao_rodou` | agente decidiu nao agir por guardrail |

### Camada 3 — feedback generico

Manter as tabelas antigas por compatibilidade, mas criar uma tabela generica
para os proximos agentes:

```sql
agent_feedback (
  id uuid primary key,
  card_id uuid not null,
  decision_event_id uuid,
  todo_id uuid,
  agent_name text not null,
  action_key text,
  source text not null,        -- explicit | implicit | audit | outcome
  verdict text not null,       -- correct | incorrect | partial | unsafe | no_data
  correct_action_key text,
  reason_code text,
  comment text,
  operator_id uuid,
  created_at timestamptz default now()
)
```

Criar tambem `v_agent_feedback_unificado` com `UNION ALL` das tabelas atuais:

- `agente_oc13_feedback`
- `agente_ocs_padrao_feedback`
- `interpretador_resposta_cliente_feedback`
- `agent_feedback`

### Camada 4 — resultado externo

Criar `v_agent_execution_outcomes` usando:

- `acoes_executadas_ssw`
- `cards_emails_outbound`
- `card_events` de confirmacao ou falha
- `audit_log`, se estiver sendo usado nesse caminho

Campos minimos:

- `agent_name`
- `card_id`
- `todo_id`
- `action_key`
- `external_system`
- `success`
- `error_category`
- `duration_to_confirm`
- `reopened_after`
- `operator_reported_error`

### Camada 5 — placar de qualidade

Criar `v_agent_quality_daily` com grao:

```
dia, agent_name, action_key, codigo_ssw, operador, pagador, mode
```

Metricas:

- propostas;
- decisoes com feedback;
- acertos;
- erros;
- sem feedback;
- taxa de adocao;
- taxa de correcao;
- taxa de execucao SSW/e-mail com sucesso;
- custo estimado;
- p50/p95 de latencia;
- acoes autonomas;
- erros reportados depois.

### Camada 6 — autonomia como produto controlado

Criar `v_agent_autonomy_candidates`:

Um grupo so aparece como candidato quando passar nos gates:

- minimo 50 decisoes avaliadas nos ultimos 30 dias;
- acerto >= 95% para acao operacional simples;
- acerto >= 98% para acao que comunica cliente;
- erro critico = 0 nos ultimos 14 dias;
- execucao externa >= 99% sucesso;
- no minimo 7 dias sem regressao;
- custo e latencia dentro do teto;
- guardrails explicitos existentes em teste.

Feature flag deve ser granular:

```
autonomy.<agent_name>.<action_key>.<scope>
```

Exemplos:

- `autonomy.ressarcimento_relancar54.tier_a.global`
- `autonomy.ocs_padrao.lancar_54_email.oc10.pagador_x`
- `autonomy.interpretador_resposta.lancar_56.operador_larissa`

## Painel recomendado no Cockpit

Nova area: **IA / Aprendizado**.

### Aba 1 — Placar

Cards:

- acerto geral;
- taxa de adocao;
- taxa de correcao;
- acoes autonomas;
- falhas de execucao;
- custo IA.

Tabela por agente:

- agente;
- decisoes;
- acerto;
- adocao;
- execucao ok;
- custo;
- status: `bloqueado`, `shadow`, `recomenda`, `candidato`, `autonomo`.

### Aba 2 — Onde a IA errou

Lista priorizada:

- agente;
- action_key sugerida;
- action_key aprovada;
- operador;
- NF/CTRC;
- motivo;
- link para card;
- botao "virar caso de eval".

### Aba 3 — Autonomia

Tabela de candidatos:

- agent/action;
- escopo;
- N avaliado;
- acerto;
- falhas;
- recomendacao: manter manual, shadow, liberar 10%, liberar 100%;
- flag atual;
- botao para abrir detalhes.

### Aba 4 — Auditoria autonomos

Usar `v_auditoria_acoes_autonomas`, mas com filtros por agente, operador,
resultado e erro reportado.

### Aba 5 — Learning log

Expor `learning_log` como fila de decisoes do Caio:

- padrao identificado;
- ajuste sugerido;
- aprovar/rejeitar;
- impacto medido depois.

## Plano de 30 dias

### Semana 1 — medir direito

- Criar `v_agent_decisions`.
- Criar `v_agent_feedback_unificado`.
- Criar `v_agent_quality_daily`.
- Garantir que todos os agentes chamem `startAgentRun/finishAgentRun`.
- Aplicar/ligar `anthropic_usage_log`, se ainda nao estiver em producao.
- Corrigir tokens nulos em `agent_runs` onde o wrapper ja consegue capturar.

Entrega da semana: painel SQL confiavel, mesmo antes do front.

### Semana 2 — fechar o loop operador -> IA

- Padronizar feedback implicito em `aprovar_e_executar` por `action_key`.
- Colocar botoes simples de feedback explicito nos banners de IA:
  "IA acertou", "IA errou", motivo curto.
- Motivos padronizados:
  - `contexto_insuficiente`
  - `acao_errada`
  - `cliente_excecao`
  - `email/template_errado`
  - `ssw_desatualizado`
  - `nao_deveria_ter_agido`
  - `outro`
- Criar botao "Adicionar aos evals".

Entrega da semana: toda correcao de operador vira dado.

### Semana 3 — gates de autonomia

- Criar `v_agent_autonomy_candidates`.
- Criar policy de autonomia por agent/action/scope.
- Rodar revisao dos ultimos 30 dias.
- Separar agentes em:
  - liberar agora;
  - shadow;
  - melhorar prompt/regra;
  - nunca automatizar.

Entrega da semana: lista objetiva de proximas acoes autonomas.

### Semana 4 — soltar autonomia com canary

- Liberar autonomia em 10% ou escopo pequeno onde os gates passam.
- Auditar 100% das primeiras 50 acoes.
- Depois cair para amostra de 20%, depois 5%.
- Qualquer erro critico desliga a flag.
- `learning_log` mede impacto antes/depois.

Entrega da semana: mais autonomia com controle de risco.

## Onde eu soltaria autonomia primeiro

Pelo que ja existe hoje, eu priorizaria:

1. **Ressarcimento relancar 54 Tier A**  
   Ja e deterministico, tem ADR forte, guardrails, flag e auditoria.

2. **Extravio D+4 oc49**  
   Ja tem pre-checagem SSW real-time e auditoria. Continuaria com rollout
   controlado e "nao rodou" visivel.

3. **Subconjuntos de `ocs_padrao` por OC/cliente/operador**  
   O placar agregado tem ~79% de acerto, entao nao e para ligar geral. Mas deve
   haver bolsos de 95%+ quando segmentar por `codigo_oc`, `pagador`,
   `operador` e `action_key`.

Eu nao soltaria autonomia ampla agora para:

- `interpretador_resposta`: ~65% de acerto implicito nos ultimos 30 dias.
- `oc13`: o feedback atual aponta muita correcao implicita.

## Agentes novos com melhor ROI

### 1. Agente de erros de e-mail/bounce

Objetivo: quando um e-mail falha ou volta bounce, sugerir/acionar canal
alternativo, contato correto ou WhatsApp.

Por que vale: reduz buraco operacional e melhora SLA sem mexer em decisao SSW
arriscada.

### 2. Agente de aging de oc54

Objetivo: cards em `AGUARDANDO_CLIENTE` sem resposta ha N dias recebem
cobranca correta, escalonamento ou encerramento conforme regra.

Por que vale: alto volume, regra progressiva, bom para shadow -> autonomia.

### 3. Agente de qualidade de dados do card

Objetivo: detectar CTRC divergente, NF sem chave, pagador errado, operador
incorreto, falta de contato, antes do operador sofrer no fluxo.

Por que vale: acao de baixo risco, pode ser autonomo para corrigir metadados ou
abrir alerta.

### 4. Agente de selecao de template/mensagem

Objetivo: escolher o melhor template e variaveis, mas manter aprovacao humana
para envio ate o placar passar.

Por que vale: melhora eficiencia sem autorizar decisao operacional sozinho.

### 5. Agente auditor semanal

Objetivo: sample de acoes, identifica clusters de erro, gera entradas em
`learning_log` e cria casos de eval.

Por que vale: transforma feedback em melhoria sistematica.

## Decisao importante

Nao recomendo fine-tuning ou "treino automatico" agora. O melhor retorno vem de:

1. capturar melhor o comportamento do operador;
2. transformar correcao em eval;
3. ajustar regra/prompt;
4. medir antes/depois;
5. liberar autonomia por feature flag granular.

Esse e o caminho mais barato, auditavel e seguro para os proximos 30 dias.
