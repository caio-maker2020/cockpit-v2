# Template — contrato de agente do Cockpit

Use este contrato depois que o processo foi descrito em
`docs/PROCESS_DESIGN_TEMPLATE.md` e refinado com
`docs/PROCESS_INTERVIEW_GUIDE.md`.

Objetivo: transformar conhecimento operacional em um agente implementavel,
testavel, auditavel e preparado para autonomia gradual.

## 1. Identidade

- **Slug do agente:** `agente-...`
- **Dono operacional:** nome
- **Dono tecnico:** nome
- **Area:** Relacionamento / Extravio / Ressarcimento / etc.
- **Estado de rollout:** `draft | offline_eval | shadow | recommend | canary_auto | auto`

## 2. Missao

Uma frase:

> Este agente existe para...

Resultado esperado:

- reduzir tempo manual em...
- evitar erro...
- aumentar SLA...
- gerar acao...

## 3. Escopo

### Dentro do escopo

- gatilhos atendidos;
- ocorrencias SSW;
- tipos de card;
- clientes/segmentos;
- estados do card.

### Fora do escopo

- situacoes que o agente nunca deve tratar;
- clientes excecao;
- casos financeiros/juridicos;
- casos que sempre escalam para humano.

## 4. Gatilhos

| Gatilho | Fonte | Condicao exata | Exemplo |
|---|---|---|---|
|  | Bastao / SSW / e-mail / WhatsApp / cron |  |  |

## 5. Inputs necessarios

| Campo | Fonte | Obrigatorio? | Frescor maximo | O que fazer se faltar |
|---|---|---:|---|---|
| `nf` | `cards` | sim | atual | `nao_rodou: sem_nf` |
| `ctrc` | `cards` | sim | atual | `nao_rodou: sem_ctrc` |
|  |  |  |  |  |

## 6. Fontes de verdade

Ordene por autoridade:

1. SSW interno/portal para escrita ou ocorrencia atual.
2. Bastao para fila/espelho operacional.
3. `cards/card_events` para historico Cockpit.
4. E-mail/WhatsApp para intencao do cliente.

Regras de conflito:

- se SSW divergir do Bastao, vence...
- se card divergir do SSW, fazer...

## 7. Catalogo de decisoes

Cada decisao precisa ter `action_key` estavel.

| action_key | Descricao | Tool | OC | Exige humano? | Pode virar auto? |
|---|---|---|---:|---:|---:|
| `lancar_ocorrencia:21` |  |  | 21 | sim | talvez |
|  |  |  |  |  |  |

## 8. Guardrails

### Antes de sugerir

- regra;
- motivo;
- exemplo de bloqueio.

### Antes de executar

- idempotencia;
- validacao CTRC/NF;
- checagem SSW real-time;
- limite de repeticao;
- feature flag.

### Nunca fazer

- anti-padroes;
- frases proibidas;
- acoes proibidas;
- excecoes que sempre escalam.

## 9. Saida estruturada

```json
{
  "decision_type": "sugerir_acao|executar_autonomo|nao_rodou|escalar",
  "action_key": "tool:codigo",
  "tool": "nome_da_tool",
  "codigo_ssw": 54,
  "confidence": 0.0,
  "rationale_code": "motivo_curto",
  "rationale": "explicacao curta para auditoria",
  "args": {},
  "no_run_reason": null,
  "requires_human": true
}
```

## 10. Exemplos obrigatorios

Inclua pelo menos:

- 5 casos felizes;
- 5 casos em que o agente deve dizer `nao_rodou`;
- 5 casos em que deve sugerir acao diferente da obvia;
- 3 casos reais em que operador corrigiu a IA;
- 3 casos de dados ruins;
- 2 casos de cliente excecao.

Formato:

```json
{
  "name": "NF exemplo",
  "input": {},
  "expected": {},
  "why": "motivo operacional"
}
```

## 11. Evals

- Arquivo: `evals/<agent_slug>/cases.jsonl`
- Runner esperado:
  - decisao correta;
  - action_key correta;
  - no-run correto;
  - tool args corretos;
  - custo;
  - latencia.

Metas iniciais:

- decisao correta >= 90% no dev;
- falso positivo critico = 0;
- action_key correta >= 95% nos casos simples.

## 12. Telemetria obrigatoria

Todo agente deve registrar:

- `agent_runs`;
- evento de decisao em `card_events`;
- `todo` com `acao_key`, se houver proposta;
- `agent_feedback` ou feedback especifico legado;
- outcome de execucao externa;
- custo Anthropic, se usar LLM.

Campos minimos no evento:

- `agent_name`;
- `agent_version`;
- `mode`;
- `action_key`;
- `confidence`;
- `rationale_code`;
- `prompt_version`;
- `model`;
- `feature_flag`;
- `input_fingerprint`.

## 13. Rollout

1. **Offline eval:** roda contra casos fixos.
2. **Shadow:** decide, mas nao mostra ou nao age.
3. **Recommend:** cria proposta para operador aprovar.
4. **Canary auto:** auto em escopo pequeno.
5. **Auto:** autonomia com auditoria amostral.

Gates para avancar:

- N minimo avaliado;
- taxa de acerto;
- falha externa;
- custo;
- ausencia de erro critico;
- guard de teste implementado.

## 14. Feature flags

| Flag | Default | Quem liga | Criterio |
|---|---:|---|---|
| `agent.<slug>.enabled` | off | gestor | shadow ok |
| `autonomy.<slug>.<action_key>.<scope>` | off | Caio | gate aprovado |

## 15. Plano de rollback

- flag para desligar;
- evento a monitorar;
- query para listar acoes afetadas;
- como reverter ou corrigir card;
- responsavel de plantao.

## 16. Checklist de PR

- [ ] Contrato preenchido.
- [ ] Regras deterministicas em `_shared/<agent>-rules.ts`.
- [ ] Testes de regras.
- [ ] Edge Function usa `agent-runs-logger`.
- [ ] Eventos de decisao padronizados.
- [ ] `acao_key` estavel em todos.
- [ ] Feedback implicito mapeado.
- [ ] Feature flag criada.
- [ ] Prompt Lovable criado, se houver UI.
- [ ] Evals adicionados.
- [ ] ADR ou memoria criada para regra de negocio relevante.
