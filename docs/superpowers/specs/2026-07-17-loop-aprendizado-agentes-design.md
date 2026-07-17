# Spec — Loop de Aprendizado dos Agentes IA (v1)

Data: 2026-07-17 · Status: em revisão pelo Caio · Origem: brainstorm Caio + Claude Code
(sessão de auditoria de observabilidade + relatório "Sinal de Ouro" de 13/07, validado
100% contra produção).

## 1. Objetivo

Fazer os agentes de IA do Cockpit ficarem certeiros a ponto de o operador tratar e
validar **apenas exceção**. Meta: **95% de acerto das sugestões, medido por célula**
(agente × ação × ocorrência × cliente), não só na média geral. Autonomia de execução
nunca é consequência automática da métrica: **só liga com ordem explícita do Caio**,
célula por célula. No runtime, agente sem certeza suficiente **não age — pede
validação do operador**.

## 2. Decisões tomadas (registro)

| # | Decisão | Escolha do Caio |
|---|---|---|
| D1 | Gabarito do "acerto" | Concordância com o operador, **arbitrada por desfecho real T+7** (divergências são julgadas pelo que aconteceu com o card no SSW; concordâncias auditadas por amostra contra carimbo) |
| D2 | Autonomia | Só por ordem do Caio, por célula. Orquestrador **recomenda** com dossiê. Runtime: confiança abaixo do limiar calibrado ou guardrail em dúvida → degrada pra sugestão |
| D3 | Escopo da meta | **Todos os agentes desde o início** — inclui instrumentar os hoje cegos (triador, redator de e-mail de saída, cobrança, "fez por fora") |
| D4 | Arquitetura | **C completo**: espinha Supabase + agente de repositório com replay eval e PR. Managed agent de junho aposentado (prompt aproveitado) |
| D5 | Linguagem | Tudo que aparece no Cockpit em linguagem simples, não técnica; detalhe técnico dobrado |
| D6 | Alcance de execução do loop | Identifica **todo e qualquer problema** e propõe solução; executa sozinho apenas prompt + caderno de casos (via PR com merge do Caio); árvore de decisão/regra/código: propõe com dossiê e **só executa após aval do Caio ou da Isadora**, como obra de engenharia normal |
| D7 | Nascimento | Orquestrador estreia **no dia 1 com os dados existentes** (sinal de ouro: 2.281+ pares, ~85/dia) — popup, T+7 e instrumentação enriquecem depois, não são pré-requisito |

## 3. O motor de perguntas (peça central)

"As perguntas são riqueza" (Caio). O produto primário do orquestrador não é o
diagnóstico — é a **pergunta profunda que destrava o próximo loop de melhoria**.

Contrato de cada pergunta:

- **Ancorada em evidência**: cita quantidade de casos, NFs-âncora reais e o padrão
  numérico ("55 vezes eu sugeri notificar o cliente e o operador lançou reentrega").
- **Diz o que destrava**: "se você me responder X, eu consigo propor Y".
- **Respondível em 1 clique** sempre que possível (opções), texto livre opcional.
- **Nunca repetida**: a resposta vira memória institucional (registro permanente que o
  orquestrador relê antes de gerar perguntas novas). Perguntas rejeitadas/ignoradas
  4 semanas não voltam com a mesma forma.
- **Sobre qualquer categoria de problema**: prompt, caderno de casos, árvore de
  decisão, regra de negócio, instrumentação faltando, comportamento de operador,
  cliente-exceção. Identificar problema fora do próprio alcance de execução é
  obrigação, não exceção.

Ciclo: pergunta gerada → respondida por Caio/Isadora no painel → resposta gravada →
proposta de melhoria referencia a resposta → aprovação → execução (pelo trilho do
tipo, ver §5) → impacto medido em 14 dias → registrado no relatório.

## 4. Fundação (construída uma vez, com validação do Caio em spec + plano)

Obra de engenharia nossa, não ação do loop. Componentes:

1. **Par universal `agent_feedback`** (append-only): toda decisão de agente vira par
   com agente, card, ação sugerida (action_key + oc), decisão final (seguida /
   corrigida para quê / rejeitada / absteve), confiança declarada, quem decidiu,
   origem do veredito (implícito, popup, desfecho, auditoria), modo (sugestão /
   shadow / autônomo). As 3 tabelas de feedback atuais continuam (compatibilidade);
   view unificada soma tudo.
2. **Instrumentação dos cegos**: (a) triador ganha elo classificação→card (vinculador
   grava de volta); (b) textos sugeridos por redator de e-mail de saída e cobrança
   passam a ser persistidos — métrica: % do texto que sobrevive à edição; (c) oc
   lançada por fora do Cockpit com sugestão viva vira par "corrigida".
3. **Árbitro de desfecho T+7** (cron diário): carimba cada par com o desfecho real do
   card (resolveu limpo / reabriu / bounce / oc nova) usando a infra existente de
   histórico; nas divergências declara quem tinha razão; audita amostra das
   concordâncias contra carimbo.
4. **Popup de divergência** (front próprio Vercel): dispara quando o operador aprova
   diferente da proposta destacada ou rejeita. **1 chip obrigatório** de motivo +
   texto opcional. Chips em tabela versionada: orquestrador propõe chip/pergunta
   nova, só entra na tela após aprovação de admin. Captura operador + proposta
   exata no ato (elimina atribuição por janela de 10 min).
5. **Orquestrador `agente-aprendizado`** (edge function em pg_cron): rodada diária
   (varre pares novos, clusteriza — SQL determinístico + 1 chamada Sonnet) e
   dominical (relatório de segunda). Regras duras herdadas do prompt do managed
   agent: nunca propor com <5 casos ou <70% mesma direção; nunca propor sem diff/
   mudança concreta; nunca declarar melhoria sem delta numérico; nunca re-propor o
   rejeitado; nunca inventar o porquê do operador. **Atestado de vida**: item no
   health-check — 7 dias sem linha nova no learning_log → alerta aos admins
   (lição da morte do loop de junho).
6. **Painel "IA / Aprendizado"** (front próprio): placar por agente/célula (separando
   acerto-quando-decide de cobertura), onde erra (trocas com link pro card), fila de
   aprovação da Isadora, perguntas da semana, relatório de segunda, escada de
   autonomia. Regras de redação do §6.
7. **Agente de repositório** (agendado, nuvem, acesso ao repo): pega ajustes de
   prompt/casos **já aprovados** na fila, roda **replay eval** (prompt novo
   reexecutado sobre os casos rotulados do sinal de ouro, gabarito = D1) e abre PR
   com laudo ("novo: X% no replay vs Y% do atual, sem regressão nas células
   fortes"). **Nunca faz merge** (merge é do Caio). Só toca arquivos de prompt/casos
   permitidos. Teto de custo. **Trava de sequência**: só ativa após 2 semanas de
   espinha comprovadamente viva no health-check.
8. **Calibração de confiança**: job que mede, por agente, se a confiança declarada
   (campo já gravado hoje e nunca usado) corresponde ao acerto real. É o que
   transforma "só age com 100% de certeza" (D2) em limiar auditável por célula.
9. **Escada de autonomia por célula**: manual → sugestão → shadow (decide em
   silêncio e compara com o operador por 2 semanas; padrão shadow já existente na
   casa) → autônomo. Transição = flag granular `autonomy.<agente>.<ação>.<escopo>`
   que só o Caio liga, mediante dossiê. Mesmo autônoma: confiança < limiar da célula
   ou guardrail em dúvida → degrada pra sugestão.

## 5. Contrato de operação do loop (envelope de execução)

| Tipo de melhoria | O loop pode... | Execução |
|---|---|---|
| Prompt de agente | identificar, perguntar, propor diff concreto | PR do agente de repositório com laudo de replay → aprovação Isadora → **merge só do Caio** |
| Caderno de casos de ouro (exemplos reais certo/errado injetados no prompt) | curar entradas/saídas | aprovação da Isadora no painel → mesmo trilho de PR |
| Chips/perguntas do popup | propor | aprovação de admin → só então aparece na tela |
| Árvore de decisão, regra de negócio, código, backend, instrumentação | **identificar, perguntar fundo, propor com dossiê** (casos, números, respostas colhidas, critério de aceite) | **somente após aval explícito do Caio ou da Isadora**; executada como tarefa de engenharia normal da casa (verify-cockpit, guard anti-regressão, memória) — nunca pelo loop sozinho |

Proibições absolutas: alterar código/backend por conta própria; escrever direto na
interface do operador; auto-merge; agir fora do teto de custo.

## 6. Linguagem no Cockpit (regra de redação)

Todo item visível tem 4 campos: **"o que aconteceu"** (2 frases simples), **"o que eu
sugiro"** (1 frase), **"o que preciso que você responda"** (1 clique quando possível),
**"ver detalhes"** (dobrado — payload técnico, diffs, queries). Números traduzidos
("de cada 10, 8 foram seguidas"); ocorrências pelo nome + código ("56 — falta de
informação operacional"). Relatório de segunda legível pela Isadora em 5 minutos.

## 7. Relatório de segunda (conteúdo fixo)

1. Números da semana vs anterior vs média de 4 semanas, por agente e pelas células
   que mais mudaram. 2. Impacto medido dos ajustes aplicados (14 dias antes/depois).
3. Padrões novos com evidência. 4. **As 3 perguntas da semana** (motor do §3).
5. Recomendações de autonomia com dossiê ("célula X pronta — decisão é sua").
6. O que está fora do alcance do loop aguardando decisão do Caio.

## 8. Dia 1 (D7)

O orquestrador estreia sobre os dados existentes. Primeiro relatório já conhecido em
essência (validado nesta investigação): os 3 padrões que concentram 57% dos erros —
oc13 "sugeri notificar, operador lançou reentrega" (55 casos), fronteira 56↔54 no
agente de ocorrências padrão (128 casos), interpretador sugerindo "aguardar cliente"
logo após resposta do cliente (181 casos) — cada um vira pergunta profunda na fila de
Caio/Isadora. Popup, T+7 e instrumentação dos cegos chegam depois e enriquecem o
loop já vivo.

## 9. Métricas oficiais

- **Acerto** = seguidas + divergências em que o desfecho confirmou a IA, sobre
  decisões avaliadas. **Abstenção não é erro** (falha técnica/abstenção sai do
  numerador de erro e entra em cobertura).
- **Cobertura** = decidiu / elegíveis. **Adoção** = operador usou o que a IA propôs.
- Meta 95% acompanhada por célula; placar geral é ponderado, informativo.
- Anti-gaming: se divergência cair sem desfecho melhorar → alerta de carimbo;
  monitorar % de chip "outro" (taxonomia ruim) e taxa de popup ignorado.

## 10. Riscos e contenções

| Risco | Contenção |
|---|---|
| Loop morre calado (repetir junho) | atestado de vida no health-check desde o dia 1 |
| Popup vira teatro / carimbo | assimetria mínima (1 toque), monitor anti-gaming, desfecho T+7 como auditor |
| Taxonomia muda e quebra série histórica | chips versionados; códigos estáveis |
| Agente de repositório desgovernado | sem merge, escopo de arquivos, teto de custo, trava de sequência |
| Custo LLM cego | estender log de custo (hoje 3 funções) a todas + teto mensal com alerta |
| Métrica global punida por célula ruim | placar por célula; oc13 tratado como proposta de mudança de árvore (trilho D6) |
| Operadores com critérios divergentes (32,5% vs 18,9% de correção) | sessão mensal de calibração: Isadora julga casos disputados às cegas; vira gabarito e alinhamento |

## 11. Fora de escopo v1

Fine-tuning / treino de modelo; IA de prioridades (desativada desde 16/06 — entra na
métrica se voltar); reviver o managed agent (aposentado; prompt aproveitado);
qualquer mudança multi-tenant; autonomia ligada sem ordem do Caio.
