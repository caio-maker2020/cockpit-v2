# Lovable — criar painel IA / Aprendizado de Agentes

## Objetivo

Criar no Cockpit uma area de gestor chamada **IA / Aprendizado** para enxergar:

- quais agentes estao acertando;
- onde estao errando;
- se o operador seguiu a sugestao ou fez outra coisa;
- quais acoes ja estao autonomas;
- quais agentes/acoes sao candidatos a autonomia.

Nao criar landing page. E uma tela operacional, densa, para gestor.

## Contexto de backend

Hoje ja existem estas fontes:

- `card_events`
- `todos`
- `agent_runs`
- `acoes_executadas_ssw`
- `cards_emails_outbound`
- `cards_auditoria`
- `v_auditoria_acoes_autonomas`
- `agente_oc13_feedback`
- `agente_ocs_padrao_feedback`
- `interpretador_resposta_cliente_feedback`
- `learning_log`

Se as views abaixo ainda nao existirem, preparar a tela para consumir quando
forem criadas:

- `v_agent_quality_daily`
- `v_agent_feedback_unificado`
- `v_agent_autonomy_candidates`
- `v_agent_execution_outcomes`

Enquanto essas views nao existirem, a tela pode usar as views especificas ja
existentes:

- `v_agente_oc13_metricas`
- `v_agente_ocs_padrao_metricas`
- `v_interpretador_resposta_metricas`
- `v_auditoria_acoes_autonomas`

## Navegacao

Adicionar uma entrada no menu lateral para gestores:

**IA / Aprendizado**

Visivel apenas para papel gestor.

## Layout

Tela operacional, sem hero e sem cards decorativos grandes.

Usar tabs:

1. **Placar**
2. **Erros**
3. **Autonomia**
4. **Auditoria**
5. **Learning Log**

## Tab Placar

Topo com filtros:

- periodo: 7 dias, 30 dias, mes atual;
- agente;
- operador;
- action_key/OC;
- modo: shadow, recomendacao, autonomo.

Cards compactos:

- decisoes IA;
- taxa de acerto;
- taxa de adocao;
- taxa de correcao;
- acoes autonomas;
- falhas externas;
- custo IA, se existir.

Tabela principal:

Colunas:

- Agente
- Acao / OC
- Decisoes
- Avaliadas
- Acertos
- Erros
- Sem feedback
- Aprovadas pelo operador
- Corrigidas pelo operador
- Autonomas
- Falha externa
- Status sugerido

Status sugerido:

- `bloqueado`
- `shadow`
- `recomenda`
- `candidato`
- `autonomo`

Usar cor discreta por status.

## Tab Erros

Lista de casos onde a IA errou ou operador escolheu acao diferente.

Colunas:

- data;
- agente;
- NF;
- CTRC;
- operador;
- sugerido;
- aprovado/correto;
- motivo;
- origem do feedback: explicito, implicito, auditoria, outcome;
- link/botao para abrir card.

Acoes:

- botao "Marcar para eval";
- botao "Abrir timeline".

## Tab Autonomia

Tabela de candidatos.

Colunas:

- agente;
- action_key;
- escopo;
- N avaliado;
- acerto;
- falha externa;
- erro critico;
- dias sem regressao;
- flag atual;
- recomendacao.

Regras visuais:

- candidato bom: acerto >= 95%, falha externa < 1%, erro critico 0;
- candidato fraco: acerto < 95% ou amostra baixa;
- bloqueado: erro critico > 0.

Nao ligar/desligar flag diretamente nesta primeira versao se nao houver RPC
segura. Mostrar apenas a flag atual e recomendacao.

## Tab Auditoria

Usar `v_auditoria_acoes_autonomas`.

Filtros:

- periodo;
- agente;
- operador;
- OC.

Colunas:

- data;
- agente;
- acao;
- NF;
- CTRC;
- operador;
- descricao;
- payload expandivel;
- abrir card.

## Tab Learning Log

Usar `learning_log`.

Colunas:

- data;
- agente;
- tipo;
- severidade;
- titulo;
- status;
- agente alvo;
- resumo;
- acao.

Se existir RPC `revisar_learning_log`, oferecer botoes:

- aprovar;
- rejeitar;
- observacao.

## UX

- Interface compacta, de backoffice.
- Nao usar textos explicando como usar a tela.
- Tabelas com ordenacao e busca.
- Badges pequenos para status.
- Payload JSON em accordion/expand, fechado por padrao.
- Skeleton/loading states.
- Empty states curtos.

## Criterio de aceite

- Gestor consegue responder em menos de 2 minutos:
  - qual agente mais errou;
  - onde operador mais corrigiu a IA;
  - quais acoes autonomas rodaram;
  - qual candidato pode ganhar autonomia;
  - quais padroes estao aguardando revisao no learning log.
