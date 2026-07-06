# Plano de Acao de Risco em Producao

Este plano transforma as auditorias tecnicas em uma ordem pratica de execucao para um sistema que ja esta em producao, com 12 operadores usando diariamente.

O foco desta versao e reduzir regressao operacional em cards:

- cards que deveriam aparecer e nao aparecem;
- cards que deveriam se mover e nao se movem;
- cards que nao deveriam se mover, mas se movem;
- riscos ligados a Bastao, carteira, segmento, responsavel de relacionamento e `assigned_operator_id`.

O objetivo nao e "bloquear producao". O objetivo e reduzir risco real sem quebrar o que ja funciona.

## 1. Resumo executivo para nao tecnico

### Situacao atual

O sistema esta operando em producao, mas a regra que decide "qual operador deve ver cada card" ainda nao esta segura o suficiente.

O retorno do Claude confirmou o nucleo da suspeita:

- o resolver de operador compara segmento de forma exata;
- varios fluxos passam segmento completo, como `043 - CURVA F`, mas operadores guardam apenas `043`;
- por isso, a atribuicao por segmento esta praticamente morta no codigo atual;
- o `sync-bastao` nao grava `segmento_codigo` de forma confiavel;
- correcoes por SQL ajudam casos atuais, mas nao resolvem a causa-raiz;
- ainda existe risco estrutural de cards sumirem, ficarem parados ou mudarem de dono de forma inesperada.

Tambem houve uma correcao importante de entendimento: a visibilidade por segmento nao esta 100% morta. Ela funciona para cards que ja tem `segmento_codigo` gravado como codigo puro, por exemplo `022`. O problema e que a maioria dos cards ativos ainda nao tem esse campo preenchido ou mantido pelo sync. Portanto, a operacao depende demais de `assigned_operator_id`.

### Riscos realmente perigosos agora

Os riscos mais perigosos para a operacao atual sao:

- card novo chegar do Bastao com segmento, mas ficar sem operador porque o codigo compara `043 - CURVA F` contra `043`;
- card mudar no Bastao, mas o sync nao atualizar dono/segmento porque `precisaEscrever` nao enxerga todas as mudancas relevantes;
- card ficar invisivel para operador comum quando `assigned_operator_id` esta nulo e `segmento_codigo` tambem esta nulo;
- correcoes manuais de carteira resolverem um caso de hoje, mas o mesmo tipo de problema voltar com outro cliente;
- trigger antiga preencher dono por nome em algum caminho alternativo e contradizer a regra moderna;
- mudanca grande em RLS, trigger ou `sync-bastao` causar regressao em cascata.

### O que pode esperar

Pode esperar:

- refatorar o `sync-bastao/index.ts` inteiro;
- trocar toda a RLS de cards de uma vez;
- remover trigger antiga sem teste e relatorio antes/depois;
- redesenhar completamente carteira, Bastao e segmentos;
- mudar a identidade principal de cards por NF/CTRC;
- reorganizar migrations antigas.

Essas coisas podem ser importantes, mas nao devem ser o primeiro movimento com operadores usando o sistema.

### Estrategia de correcao

A estrategia mais segura e:

1. Primeiro medir corretamente quais cards estao invisiveis, presos ou com dono incoerente.
2. Corrigir dados atuais apenas onde houver evidencia clara.
3. Corrigir a raiz pequena no codigo: normalizacao de segmento no resolver.
4. Depois corrigir o `sync-bastao` para gravar `segmento_codigo` e detectar mudanca real de dono/segmento.
5. So depois mexer em RLS, trigger antiga e refatoracoes maiores.

## 2. Lista priorizada de acoes

### P0 - Corrigir imediatamente

#### [Corrigir auditoria de roteamento de cards antes de usar como placar]

Prioridade: P0
Tradução simples: antes de decidir se o sistema melhorou, precisamos medir certo quais cards estao invisiveis ou com dono errado.
Por que isso importa: a auditoria atual e util, mas o Claude confirmou que ela superestima divergencia de segmento em um ponto.
O que pode acontecer se ignorar: a equipe pode corrigir o problema errado, assustar com numero falso ou deixar passar card realmente invisivel.
Impacta os operadores hoje?: SIM
Chance de acontecer: alta
Impacto se acontecer: alto
Esforço para corrigir: baixo
Risco da correção quebrar algo: baixo
Arquivos envolvidos: `audits/audit-card-routing.sql`, `audits/AUDIT_CARD_ROUTING_2026-06-27.md`.
Ação recomendada: ajustar a auditoria para comparar `segmento_codigo` com o codigo extraido do rotulo do Bastao, por exemplo comparar `022` com `left('022 - MOTOBIKE', 3)`, e considerar a RLS por segmento na flag de invisibilidade.
Como validar sem quebrar produção: rodar somente consultas read-only e comparar amostras manualmente: cards com `segmento_codigo='022'` e Bastao `022 - MOTOBIKE` nao devem aparecer como divergentes.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica.

#### [Confirmar e tratar cards realmente invisiveis hoje]

Prioridade: P0
Tradução simples: encontrar os cards que operador comum nao consegue ver e resolver esses casos sem mexer em regra grande.
Por que isso importa: se um card importante nao aparece para ninguem alem de gestor, ele pode ficar sem acao operacional.
O que pode acontecer se ignorar: cliente fica sem retorno, card para, prazo estoura e operador so descobre por reclamacao.
Impacta os operadores hoje?: SIM
Chance de acontecer: média
Impacto se acontecer: alto
Esforço para corrigir: baixo
Risco da correção quebrar algo: baixo
Arquivos envolvidos: `audits/audit-card-routing.sql`, `audits/fix-orfaos-043-carteira-isa.sql`, tabela `cards`, tabela `operadores`.
Ação recomendada: confirmar se os 8 CNPJs do script da ISA E KAROL ja estao aplicados em producao; listar os cards ainda invisiveis; tratar apenas casos confirmados com ajuste de carteira ou atribuicao pontual aprovado.
Como validar sem quebrar produção: antes/depois read-only por card: `assigned_operator_id`, `responsavel_relacionamento`, `segmento_codigo`, operador esperado e se operador comum consegue enxergar.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica, desde que qualquer SQL de alteracao seja pequeno, revisado e com backup logico da lista afetada.

#### [Normalizar segmento no resolver de operador]

Prioridade: P0
Tradução simples: fazer o sistema entender que `043 - CURVA F` significa segmento `043`.
Por que isso importa: hoje o Bastao manda o rotulo completo, mas o cadastro dos operadores guarda so o codigo. Isso faz a regra por segmento falhar silenciosamente.
O que pode acontecer se ignorar: cliente novo fora da carteira pode cair sem operador; cards podem nao aparecer; a equipe continua corrigindo sintomas manualmente.
Impacta os operadores hoje?: SIM
Chance de acontecer: alta
Impacto se acontecer: alto
Esforço para corrigir: baixo
Risco da correção quebrar algo: médio
Arquivos envolvidos: `supabase/functions/_shared/operador-resolver.ts`, `supabase/functions/sync-bastao/index.ts`, `supabase/functions/vinculador/index.ts`, `supabase/functions/sync-prioridades-ai-do-bastao/index.ts`.
Ação recomendada: centralizar no resolver uma funcao que extraia o codigo de 3 digitos do segmento recebido. O resolver deve aceitar tanto `043` quanto `043 - CURVA F`. Adicionar teste cobrindo esse caso.
Como validar sem quebrar produção: teste automatizado com `segmentoCodigo='043 - CURVA F'`; rodar auditoria read-only antes/depois; conferir que cards sem carteira passam a ter operador esperado por segmento apenas quando nao houver regra de carteira/nome mais forte.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica, mas o deploy deve ser controlado e validado logo apos o proximo sync.

#### [Criar monitor diario de cards invisiveis, presos e com dono incoerente]

Prioridade: P0
Tradução simples: criar uma checagem diaria para avisar se algum card sumiu da visao dos operadores ou ficou parado.
Por que isso importa: hoje a regressao pode ser percebida tarde, quando um operador ou cliente reclama.
O que pode acontecer se ignorar: o mesmo problema volta e ninguem percebe rapido.
Impacta os operadores hoje?: SIM
Chance de acontecer: alta
Impacto se acontecer: alto
Esforço para corrigir: baixo
Risco da correção quebrar algo: baixo
Arquivos envolvidos: `audits/audit-card-routing.sql`, `supabase/functions/audit-invariante/index.ts`, possiveis queries de dashboard.
Ação recomendada: transformar as consultas corrigidas em rotina diaria: cards sem dono esperado, cards com dono inativo, cards invisiveis exceto gestor, cards em estado operacional parado e cards cujo Bastao indica responsavel/segmento diferente do Cockpit.
Como validar sem quebrar produção: rodar por 3 dias em modo observacao, sem auto-corrigir nada, e comparar com percepcao dos operadores.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica.

### P1 - Corrigir nesta semana

#### [Gravar `segmento_codigo` no `sync-bastao`]

Prioridade: P1
Tradução simples: salvar no card o codigo do segmento que veio do Bastao, em vez de deixar essa informacao perdida ou so dentro de um JSON.
Por que isso importa: a visibilidade por segmento depende de `cards.segmento_codigo`. Se esse campo fica nulo, a regra de seguranca por segmento nao ajuda.
O que pode acontecer se ignorar: cards com `assigned_operator_id` nulo ficam invisiveis; cards que poderiam aparecer por segmento nao aparecem; auditorias continuam inconsistentes.
Impacta os operadores hoje?: SIM
Chance de acontecer: alta
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: médio
Arquivos envolvidos: `supabase/functions/sync-bastao/index.ts`, `supabase/functions/_shared/operador-resolver.ts`, migrations que criaram/backfillaram `segmento_codigo`.
Ação recomendada: no insert e update de cards pelo `sync-bastao`, gravar `segmento_codigo` como codigo puro de 3 digitos extraido de `p.segmento_cliente`.
Como validar sem quebrar produção: em staging ou branch, simular pendencia com `segmento_cliente='043 - CURVA F'` e confirmar `segmento_codigo='043'`; em producao, primeiro rodar relatorio antes/depois em amostra.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica, mas nao deve ser combinado com refatoracao grande.

#### [Fazer `precisaEscrever` detectar mudanca de dono e segmento]

Prioridade: P1
Tradução simples: quando o Bastao indicar que o card mudou de dono ou segmento, o sync precisa perceber e salvar.
Por que isso importa: hoje `assigned_operator_id` e `segmento_codigo` nao sao comparados diretamente. O dono usa um proxy pelo nome, que funciona em varios casos, mas tem furo de borda.
O que pode acontecer se ignorar: card deveria mudar de operador e nao muda; card deveria atualizar segmento e fica com dado velho; uma correcao manual pode nunca ser corrigida pelo sync.
Impacta os operadores hoje?: SIM
Chance de acontecer: média
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: médio
Arquivos envolvidos: `supabase/functions/sync-bastao/index.ts`.
Ação recomendada: incluir na decisao de escrita comparacoes explicitas de `assigned_operator_id`, `segmento_codigo` e `responsavel_relacionamento`, preservando os bloqueios ja existentes para estados protegidos.
Como validar sem quebrar produção: criar teste/fixture onde `responsavel_relacionamento` esta igual, mas `assigned_operator_id` esta errado; o sync deve corrigir. Criar outro onde apenas `segmento_codigo` mudou; o sync deve gravar.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica, mas precisa teste antes do deploy.

#### [Backfill controlado de `segmento_codigo` existente]

Prioridade: P1
Tradução simples: preencher o segmento dos cards antigos que hoje estao sem esse campo.
Por que isso importa: mesmo corrigindo o sync para cards novos, os cards antigos continuam com visibilidade fragil se nao forem atualizados.
O que pode acontecer se ignorar: a melhora vale so para cards futuros; cards atuais continuam dependendo quase so do dono direto.
Impacta os operadores hoje?: SIM
Chance de acontecer: alta
Impacto se acontecer: médio
Esforço para corrigir: médio
Risco da correção quebrar algo: médio
Arquivos envolvidos: migrations futuras, `cards.agent_state`, `cards.segmento_codigo`, `audits/audit-card-routing.sql`.
Ação recomendada: fazer backfill apenas de `segmento_codigo` nulo usando o codigo extraido de `agent_state->>'segmento_cliente'`; antes de executar, gerar relatorio com quantidade por segmento e amostra de cards.
Como validar sem quebrar produção: comparar contagem de cards visiveis por operador antes/depois; nao alterar `assigned_operator_id` nessa mesma migration.
Pode fazer agora?: SIM
Se não, por quê?: Pode ser feito nesta semana, mas nao junto com mudanca de RLS.

#### [Documentar e testar precedencia de dono do card]

Prioridade: P1
Tradução simples: deixar claro quem ganha quando Bastao, carteira, segmento e nome do responsavel discordam.
Por que isso importa: boa parte das regressões nasce quando uma regra pequena muda sem saber qual outra regra ela sobrepoe.
O que pode acontecer se ignorar: um card pode ir para o operador errado; correcao de carteira pode desfazer regra de segmento; Bastao pode sobrescrever ajuste manual.
Impacta os operadores hoje?: SIM
Chance de acontecer: média
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: baixo
Arquivos envolvidos: `supabase/functions/_shared/operador-resolver.ts`, `supabase/functions/_shared/bastao-rules.ts`, testes novos em `_shared`.
Ação recomendada: criar testes de regressao para a ordem: responsavel por nome/canonicalizacao, carteira CNPJ, segmento, sem dono. Incluir casos de conflito como `KAROL E ISA` vs `ISA E KAROL`.
Como validar sem quebrar produção: testes rodam fora de producao e devem provar o comportamento esperado antes de mexer em RLS ou trigger.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica.

### P2 - Planejar proximas semanas

#### [Revisar trigger legada `cards_resolve_operator`]

Prioridade: P2
Tradução simples: existe uma regra antiga no banco que pode preencher dono de card por fora do resolver moderno.
Por que isso importa: qualquer caminho que mexa em `responsavel_relacionamento` e deixe `assigned_operator_id` vazio pode ser afetado pela trigger.
O que pode acontecer se ignorar: card pode ser atribuido por nome antigo, operador inativo ou regra diferente da regra usada pelo sync.
Impacta os operadores hoje?: SIM
Chance de acontecer: baixa
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: alto
Arquivos envolvidos: migrations antigas que criam `cards_resolve_operator`, tabela `cards`, tabela `operadores`.
Ação recomendada: primeiro mapear quando a trigger dispara em producao. Depois decidir se ela deve ser removida, alterada para respeitar a regra moderna ou mantida apenas como fallback auditado.
Como validar sem quebrar produção: criar relatorio de cards cujo dono foi preenchido pela trigger; criar teste de insert/update com `responsavel_relacionamento` e `assigned_operator_id=null`.
Pode fazer agora?: NAO
Se não, por quê?: mexe em comportamento invisivel do banco e pode quebrar fluxos alternativos.

#### [Revisar RLS de cards por CNPJ do pagador]

Prioridade: P2
Tradução simples: a regra de carteira deveria usar CNPJ, mas parte da RLS compara carteira com `pagador`, que parece ser nome.
Por que isso importa: o predicado por carteira fica morto ou pouco confiavel; a protecao real depende de dono direto e segmento.
O que pode acontecer se ignorar: visibilidade continua frágil e dificil de explicar; novos casos fora do padrao podem sumir ou vazar.
Impacta os operadores hoje?: SIM
Chance de acontecer: média
Impacto se acontecer: alto
Esforço para corrigir: alto
Risco da correção quebrar algo: alto
Arquivos envolvidos: `migration/2026-06-23_242_rls_perf_initplan_cards_todos.sql`, migrations 262-265, tabela `cards`, tabela `operadores`.
Ação recomendada: criar ou confirmar campo canonico de CNPJ do pagador, gerar relatorio antes/depois por operador e so entao ajustar RLS.
Como validar sem quebrar produção: comparar para cada operador quantos cards ele ve hoje e quantos veria com a regra nova; validar amostras com operadores-chave.
Pode fazer agora?: NAO
Se não, por quê?: muda quem enxerga cards em producao. Precisa relatorio e homologacao.

#### [Adicionar lock global no `sync-bastao`]

Prioridade: P2
Tradução simples: impedir duas sincronizacoes grandes rodando ao mesmo tempo e mexendo nos mesmos cards.
Por que isso importa: duas execucoes concorrentes podem tomar decisoes diferentes sobre o mesmo card.
O que pode acontecer se ignorar: card reabre e fecha em sequencia, atribuicao muda indevidamente, estado fica incoerente.
Impacta os operadores hoje?: SIM
Chance de acontecer: baixa
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: médio
Arquivos envolvidos: `supabase/functions/sync-bastao/index.ts`, tabela `sync_runs`, possivel migration para lock.
Ação recomendada: usar advisory lock ou tabela de lock transacional; se ja existir sync rodando, nova execucao deve sair sem alterar nada.
Como validar sem quebrar produção: disparar duas execucoes simultaneas em staging e confirmar que uma delas nao processa.
Pode fazer agora?: NAO
Se não, por quê?: precisa testar bem para nao impedir sync legitimo.

#### [Criar testes minimos de regressao para cards/Bastao]

Prioridade: P2
Tradução simples: colocar testes automaticos exatamente nos pontos que fazem card sumir ou mover errado.
Por que isso importa: sem testes, cada correcao no Bastao vira aposta.
O que pode acontecer se ignorar: corrigir um caso da ISA e quebrar DUILIO, CAMILA, VICTOR ou outro segmento sem perceber.
Impacta os operadores hoje?: NAO
Chance de acontecer: alta
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: baixo
Arquivos envolvidos: `supabase/functions/_shared/operador-resolver.ts`, `supabase/functions/sync-bastao/index.ts`, `lib/*.test.ts`, possiveis fixtures.
Ação recomendada: testes para segmento com rotulo completo, carteira ganha de segmento quando aplicavel, nome/canonicalizacao, assigned dessincronizado, segmento nulo, estado protegido e card sem dono.
Como validar sem quebrar produção: testes rodam local/CI e nao tocam dados reais.
Pode fazer agora?: SIM
Se não, por quê?: Nao se aplica.

### P3 - Apenas monitorar por enquanto

#### [Refatorar `sync-bastao` inteiro]

Prioridade: P3
Tradução simples: o arquivo e grande demais, mas mexer nele inteiro agora e perigoso.
Por que isso importa: ele controla grande parte do ciclo de vida dos cards.
O que pode acontecer se ignorar: manutencao continua dificil; mudancas pequenas seguem arriscadas.
Impacta os operadores hoje?: SIM
Chance de acontecer: média
Impacto se acontecer: alto
Esforço para corrigir: alto
Risco da correção quebrar algo: alto
Arquivos envolvidos: `supabase/functions/sync-bastao/index.ts`.
Ação recomendada: nao refatorar agora. Fazer fixes pequenos com teste e auditoria antes/depois. Separar em passes menores somente depois de estabilizar.
Como validar sem quebrar produção: qualquer refatoracao futura deve preservar snapshots de entrada/saida e passar nos testes de regressao.
Pode fazer agora?: NAO
Se não, por quê?: risco alto de regressao em producao ativa.

#### [Trocar RLS de cards inteira de uma vez]

Prioridade: P3
Tradução simples: nao mudar de uma vez a regra que decide quem enxerga cada card.
Por que isso importa: RLS errada pode esconder cards de operadores ou mostrar cards para quem nao deve.
O que pode acontecer se ignorar: incidente direto na operacao: operador perde fila, gestor ve tudo mas operador nao, ou dados vazam para carteira errada.
Impacta os operadores hoje?: SIM
Chance de acontecer: média
Impacto se acontecer: crítico
Esforço para corrigir: alto
Risco da correção quebrar algo: alto
Arquivos envolvidos: migrations de RLS de `cards`, funcoes `current_operador_*`, tabela `operadores`.
Ação recomendada: manter como plano posterior. Antes, corrigir segmento, medir visibilidade e gerar comparativo por operador.
Como validar sem quebrar produção: somente com relatorio antes/depois e teste RLS por papel, carteira e segmento.
Pode fazer agora?: NAO
Se não, por quê?: alto risco de sumir card em producao.

#### [Remover trigger antiga sem rede de teste]

Prioridade: P3
Tradução simples: nao remover uma regra antiga do banco enquanto nao sabemos todos os caminhos que dependem dela.
Por que isso importa: a trigger pode estar mascarando falhas em criadores de card que nao setam dono explicitamente.
O que pode acontecer se ignorar: card novo pode passar a nascer sem operador; fluxo manual ou legado pode parar.
Impacta os operadores hoje?: SIM
Chance de acontecer: baixa
Impacto se acontecer: alto
Esforço para corrigir: médio
Risco da correção quebrar algo: alto
Arquivos envolvidos: migrations antigas de `cards_resolve_operator`, funcoes que inserem/atualizam cards.
Ação recomendada: primeiro medir e testar; depois substituir por comportamento explicito no codigo.
Como validar sem quebrar produção: logs/auditoria de disparo da trigger e teste de todos os criadores de card.
Pode fazer agora?: NAO
Se não, por quê?: pode quebrar fluxos alternativos silenciosamente.

#### [Mudar identidade principal de cards por NF/CTRC]

Prioridade: P3
Tradução simples: existe uma discussao importante sobre o que torna um card unico, mas mudar isso agora pode baguncar dados existentes.
Por que isso importa: NF e CTRC aparecem como identificadores em partes diferentes do sistema.
O que pode acontecer se ignorar: casos raros podem ficar bloqueados ou exigir self-heal.
Impacta os operadores hoje?: SIM
Chance de acontecer: baixa
Impacto se acontecer: alto
Esforço para corrigir: alto
Risco da correção quebrar algo: alto
Arquivos envolvidos: migrations de `cards`, `supabase/functions/sync-bastao/index.ts`, `supabase/functions/executor/index.ts`.
Ação recomendada: monitorar casos reais primeiro; desenhar migracao com plano de rollback.
Como validar sem quebrar produção: criar relatorio de NFs com multiplos CTRCs antes de alterar indice ou regra.
Pode fazer agora?: NAO
Se não, por quê?: muda regra central de dados em producao.

## 3. Plano de execucao em ordem

### Fase 1 - Contencao e medicao confiavel

Objetivo: saber exatamente quais cards estao invisiveis, presos ou com dono incoerente antes de mexer em regra sensivel.

Tarefas:

1. Corrigir `audits/audit-card-routing.sql` para nao comparar codigo com rotulo completo.
2. Rodar auditoria read-only corrigida.
3. Listar cards realmente invisiveis para operador comum.
4. Confirmar se `audits/fix-orfaos-043-carteira-isa.sql` ja foi aplicado no banco.
5. Gerar lista de cards que precisam de ajuste pontual de dados.
6. Criar rotina diaria read-only de monitoramento.

Ordem das tarefas: 1, 2, 3, 4, 5, 6.

Critério de aceite: existe um relatorio confiavel com cards invisiveis, cards com dono inativo, cards sem dono esperado e cards com conflito Bastao/carteira/segmento.

Risco reduzido: agir em cima de numero errado, corrigir card errado, deixar card invisivel passar.

O que NÃO mexer agora: RLS de cards, trigger antiga, refatoracao do `sync-bastao`, backfill amplo sem relatorio.

### Fase 2 - Correcao pequena da causa-raiz do segmento

Objetivo: fazer o resolver entender segmento vindo do Bastao tanto como codigo quanto como rotulo completo.

Tarefas:

1. Criar helper de normalizacao no `operador-resolver.ts`.
2. Aceitar `043`, `043 - CURVA F` e valores com espaco.
3. Adicionar teste automatizado para segmento com rotulo completo.
4. Adicionar teste para precedencia: nome/carteira antes de segmento, se essa for a regra esperada.
5. Deploy controlado.
6. Rodar auditoria read-only apos o primeiro sync.

Ordem das tarefas: 1, 2, 3, 4, 5, 6.

Critério de aceite: `segmentoCodigo='043 - CURVA F'` resolve operador com segmento `043`; nenhum caso de carteira/nome passa a ser sobrescrito indevidamente por segmento.

Risco reduzido: card novo fora da carteira ficar sem operador por falha silenciosa de segmento.

O que NÃO mexer agora: mudar todos os call sites se a normalizacao central no resolver resolver o problema; nao abrir allowlist ampla do Bastao; nao mudar RLS junto.

### Fase 3 - Persistencia correta no `sync-bastao`

Objetivo: garantir que o sync salve e atualize os campos que a visibilidade usa.

Tarefas:

1. No insert do `sync-bastao`, gravar `segmento_codigo` como codigo puro.
2. No update do `sync-bastao`, atualizar `segmento_codigo` quando o Bastao mudar segmento.
3. Fazer `precisaEscrever` comparar `assigned_operator_id` diretamente.
4. Fazer `precisaEscrever` comparar `segmento_codigo`.
5. Manter protecoes de estados que nao devem ser movidos automaticamente.
6. Criar fixtures cobrindo dono dessincronizado e segmento dessincronizado.

Ordem das tarefas: 1, 2, 3, 4, 5, 6.

Critério de aceite: card novo ja nasce com `segmento_codigo`; card antigo atualiza segmento quando o Bastao mudar; card com `assigned_operator_id` errado e `responsavel_relacionamento` igual pode ser corrigido pelo sync.

Risco reduzido: card que deveria mover nao move; card que deveria aparecer por segmento nao aparece.

O que NÃO mexer agora: reescrever passes do sync, alterar fechamento/reabertura de estados, mudar regra de RLS no mesmo deploy.

### Fase 4 - Backfill e validacao operacional

Objetivo: corrigir dados antigos com o minimo de risco.

Tarefas:

1. Gerar relatorio de cards ativos com `segmento_codigo` nulo e `agent_state.segmento_cliente` presente.
2. Gerar amostra por segmento e operador.
3. Executar backfill apenas de `segmento_codigo` nulo, usando codigo extraido do Bastao.
4. Nao alterar `assigned_operator_id` nesse mesmo passo.
5. Comparar visibilidade por operador antes/depois.
6. Manter monitoramento diario por 7 dias.

Ordem das tarefas: 1, 2, 3, 4, 5, 6.

Critério de aceite: queda grande de cards com `segmento_codigo` nulo; nenhuma queda inesperada de cards visiveis por operador; operadores-chave validam amostras.

Risco reduzido: cards antigos continuarem fragilizados mesmo apos corrigir codigo.

O que NÃO mexer agora: backfill de dono em massa, troca de RLS por CNPJ, remocao de trigger.

### Fase 5 - Regras de permissao e trigger

Objetivo: resolver fragilidades restantes sem tirar card da fila dos operadores.

Tarefas:

1. Gerar relatorio de como a RLS atual decide visibilidade: gestor, assigned, carteira, segmento.
2. Projetar RLS por CNPJ canonico do pagador.
3. Comparar visibilidade atual vs nova por operador.
4. Mapear disparos da trigger `cards_resolve_operator`.
5. Decidir se trigger sera removida, endurecida ou mantida como fallback auditado.
6. So aplicar mudanca apos testes RLS.

Ordem das tarefas: 1, 2, 3, 4, 5, 6.

Critério de aceite: qualquer mudanca de RLS ou trigger vem com relatorio antes/depois e teste por papel/carteira/segmento.

Risco reduzido: card sumir por permissao, vazamento de card para operador errado, conflito entre banco e codigo.

O que NÃO mexer agora: RLS inteira em um unico deploy sem comparativo; trigger sem saber quem depende dela.

### Fase 6 - Refatoracoes seguras

Objetivo: melhorar manutencao sem arriscar operacao diaria.

Tarefas:

1. Separar `sync-bastao` em passes menores.
2. Separar regras de resolucao de operador de regras de movimento de estado.
3. Centralizar regras de negocio duplicadas.
4. Redesenhar identidade de cards NF/CTRC com migracao controlada.
5. Criar baseline de migrations.

Ordem das tarefas: 1, 2, 3, 4, 5.

Critério de aceite: cada refatoracao preserva snapshots de entrada/saida e passa nos testes de regressao.

Risco reduzido: manutencao arriscada e regressao em cascata.

O que NÃO mexer agora: reescrita completa em uma unica entrega.

## 4. Tabela final

| Ordem | Prioridade | Item | Por que importa | Acao | Risco da correcao | Como validar |
|---:|---|---|---|---|---|---|
| 1 | P0 | Corrigir auditoria de roteamento | Evita tomar decisao com numero falso | Ajustar comparacao de segmento codigo vs rotulo | Baixo | Rodar read-only e validar amostras |
| 2 | P0 | Tratar cards invisiveis atuais | Evita card parado fora da fila | Confirmar SQL aplicado e ajustar casos pontuais | Baixo | Antes/depois por card e operador |
| 3 | P0 | Normalizar segmento no resolver | Corrige causa-raiz de segmento morto | Aceitar `043` e `043 - CURVA F` | Medio | Teste automatizado + auditoria apos sync |
| 4 | P0 | Monitor diario de cards | Detecta regressao cedo | Consultas para invisiveis, presos e incoerentes | Baixo | Rodar 3 dias sem auto-correcao |
| 5 | P1 | Gravar `segmento_codigo` | Restaura rede de seguranca por segmento | Insert/update do sync salvam codigo puro | Medio | Fixture com `043 - CURVA F` vira `043` |
| 6 | P1 | Comparar dono/segmento em `precisaEscrever` | Card que deveria mover passa a mover | Comparar `assigned_operator_id` e `segmento_codigo` | Medio | Teste de dono dessincronizado |
| 7 | P1 | Backfill de `segmento_codigo` | Corrige cards antigos | Preencher nulos pelo codigo do Bastao | Medio | Relatorio antes/depois por operador |
| 8 | P1 | Testar precedencia de dono | Evita regressao por regra escondida | Testes nome/carteira/segmento/sem dono | Baixo | Suite local/CI |
| 9 | P2 | Revisar trigger antiga | Evita conflito banco vs codigo | Mapear disparos e decidir futuro | Alto | Teste insert/update + relatorio |
| 10 | P2 | RLS por CNPJ canonico | Corrige carteira fragil | Criar comparativo antes/depois | Alto | Validacao por operador-chave |
| 11 | P2 | Lock do `sync-bastao` | Evita corrida de sync | Advisory lock ou lock transacional | Medio | Duas execucoes simultaneas em staging |
| 12 | P2 | Testes Bastao/cards | Evita regressao recorrente | Fixtures dos cenarios criticos | Baixo | Testes passam fora de producao |
| 13 | P3 | Refatorar sync inteiro | Importante, mas arriscado agora | Adiar ate ter testes e snapshots | Alto | Snapshots antes/depois |
| 14 | P3 | Trocar RLS inteira | Pode sumir cards | Adiar ate comparativo completo | Alto | Testes RLS e relatorio |
| 15 | P3 | Remover trigger sem teste | Pode quebrar fluxo legado | Medir antes de remover | Alto | Auditoria de disparos |
| 16 | P3 | Identidade NF/CTRC | Regra central de dados | Monitorar e desenhar migracao | Alto | Relatorio de NFs com multiplos CTRCs |

## 5. Recomendações finais

### O que eu deveria pedir para o Claude Code corrigir primeiro?

Primeiro pedido:

> Corrija `audits/audit-card-routing.sql` para medir corretamente cards invisiveis e divergencia real de segmento. Nao altere producao. Rode apenas leitura e gere relatorio antes/depois.

Segundo pedido:

> Corrija `supabase/functions/_shared/operador-resolver.ts` para normalizar `segmentoCodigo`, aceitando tanto `043` quanto `043 - CURVA F`. Adicione testes de regressao. Nao refatore `sync-bastao`.

Terceiro pedido:

> Ajuste `supabase/functions/sync-bastao/index.ts` para gravar `segmento_codigo` no insert/update e para `precisaEscrever` comparar `assigned_operator_id` e `segmento_codigo`. Mudanca pequena, com testes, sem alterar RLS.

### O que NÃO devo mandar ele refatorar agora?

Nao mandar agora:

- refatorar `sync-bastao/index.ts` inteiro;
- trocar toda a RLS de cards;
- remover a trigger `cards_resolve_operator`;
- fazer backfill de dono em massa;
- abrir carteira/allowlist do Bastao de forma ampla;
- alterar identidade de cards por NF/CTRC;
- misturar correcao de segmento, RLS, trigger e refatoracao no mesmo deploy.

### Quais mudanças são perigosas demais para fazer sem teste?

Sao perigosas sem teste:

- qualquer mudanca em RLS de `cards`;
- remocao ou alteracao da trigger `cards_resolve_operator`;
- mudanca em `precisaEscrever`;
- backfill de `assigned_operator_id`;
- lock global do `sync-bastao`;
- refatoracao de passes do `sync-bastao`;
- qualquer regra que altere estados protegidos ou cards em atendimento humano.

### Qual seria a sequência mais segura para reduzir risco sem parar a operação?

A sequencia mais segura e:

1. Corrigir a auditoria para medir certo.
2. Confirmar e resolver cards invisiveis atuais com ajustes pequenos.
3. Corrigir normalizacao de segmento no resolver com teste.
4. Monitorar o primeiro sync apos deploy.
5. Corrigir persistencia de `segmento_codigo` no `sync-bastao`.
6. Fazer `precisaEscrever` enxergar mudanca real de dono/segmento.
7. Backfill controlado de `segmento_codigo`.
8. So depois discutir RLS por CNPJ e trigger antiga.
9. Refatoracoes grandes ficam por ultimo.

## 6. Veredito operacional

O problema e de dados e codigo ao mesmo tempo.

SQL pontual resolve casos atuais, mas nao resolve definitivamente. Se aparecer cliente novo com segmento vindo como rotulo completo, ou se o Bastao mudar responsavel/segmento em um caso nao coberto por carteira, o risco volta.

E necessario corrigir o resolver e o `sync-bastao`. A ordem segura nao e fazer uma grande reforma; e fazer tres movimentos pequenos e medidos:

1. medir corretamente;
2. normalizar segmento no resolver;
3. persistir e comparar `segmento_codigo`/`assigned_operator_id` no sync.

Esse e o caminho com melhor relacao entre reducao de risco e chance baixa de quebrar o que os 12 operadores ja usam hoje.
