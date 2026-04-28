---
prompt: lovable-cockpit-foundation
version: 0.1.0
tool: lovable
purpose: Prompt inicial pra construir o Cockpit v2 (UI dos operadores) no Lovable, conectado ao Supabase v2 (event-sourced).
status: rascunho — iterar com follow-ups depois do primeiro build.
---

# Prompt pra colar no Lovable (v0.1.0)

Copie tudo abaixo desta linha e cole no Lovable. Conecte primeiro o projeto ao
Supabase v2 (URL + anon key na configuração de Supabase do Lovable) — ele vai
detectar o schema sozinho.

---

## CONTEXTO DO PRODUTO

Estou construindo o **Cockpit v2** da **Sal Express**, transportadora B2B em
MG e ES. É um sistema interno (nada multi-tenant, nada de venda externa) onde
um time de ~10 operadores gerencia tratativas de carga (NF) recebidas via
WhatsApp, e-mail e do TMS SSW.

A diferença grande pro Cockpit v1 é que **agentes de IA propõem ações; o
operador valida**. O operador não digita mais a resposta nem clica em "lançar
ocorrência" no SSW — ele vê o card com a ação proposta pelo agente, lê o
porquê, e clica **Aprovar** ou **Rejeitar**.

A UI que você vai construir é o "console" desses operadores: ver cards
entrando, abrir o card, ver mensagens trocadas, ver to-dos propostos pelos
agentes, e validar.

## ARQUITETURA QUE VOCÊ PRECISA SABER

- **O backend é Supabase event-sourced.** Existe uma tabela `card_events` que
  é a **fonte da verdade** (append-only, imutável). A tabela `cards` é uma
  **projeção** — estado atual de cada caso. **Nunca dê UPDATE direto em
  `cards.state`** pela UI. Mudanças de estado acontecem via INSERT em
  `card_events`, que tem trigger que atualiza `cards.last_event_at`.
  Validação humana (Aprovar/Rejeitar) é INSERT em `card_events` com
  `event_type='AprovacaoOperador'` ou `'RejeicaoOperador'`, e depois UPDATE
  em `todos` mudando o status.
- **Realtime:** use Supabase Realtime na tabela `cards` pra lista atualizar
  sozinha quando entra mensagem nova. Use Realtime em `todos` pra side panel
  do card de detalhe atualizar quando agente propõe nova ação.
- **RLS já está configurada.** A policy de SELECT em `cards` filtra por
  `assigned_operator_id` (operador comum vê só os dele) ou libera tudo (se
  papel for `gestor`). Você não precisa replicar isso no front — só fazer as
  queries normais que o Supabase aplica RLS.
- **Auth:** Supabase Auth com email + senha. Toda rota da app exige usuário
  logado. Login simples.
- **Botões de ação NÃO chamam APIs externas direto.** Eles fazem 2 coisas:
  (1) INSERT em `card_events` com o evento de aprovação/rejeição; (2) UPDATE
  em `todos` mudando o status. Quem efetivamente liga no SSW / WhatsApp /
  e-mail é uma Edge Function ("executor") que será criada depois — ela lê
  uma fila e age. Você não precisa criar essa Edge Function agora; sua UI
  só precisa garantir que o evento de aprovação foi gravado corretamente.

## SCHEMA DO SUPABASE (LEIA AS COLUNAS — ELE VAI DETECTAR AUTOMÁTICO)

Tabelas relevantes pra UI (já existem no Supabase v2):

- **`operadores`** — usuários do cockpit. Colunas: `id`, `user_id` (FK auth),
  `nome`, `email`, `papel` ('operador' | 'gestor'), `carteira` (text[]),
  `ativo`. Cada operador tem 1 row aqui ligado a 1 `auth.users`.
- **`cards`** — projeção de cada caso. Colunas mais usadas:
  `id`, `nf`, `ctrc`, `canal_origem` ('whatsapp'|'email'|'sistema'),
  `empresa_cliente`, `nome_cliente`, `pagador`, `base_destino`,
  `responsavel_relacionamento`, `state` (14 estados — ver lista abaixo),
  `agent_state` (jsonb), `tipo` (rastreamento|reentrega|devolucao|avaria|
  extravio|inversao|cobranca|outros), `risco` ('alto'|'baixo'),
  `assigned_agent`, `assigned_operator_id`, `last_event_at`, `created_at`,
  `updated_at`.
- **`card_events`** — log imutável. Colunas: `id`, `card_id`, `event_type`
  (string), `event_version`, `payload` (jsonb), `actor_type`
  ('agent'|'operator'|'system'), `actor_id`, `created_at`.
- **`messages_inbox`** — mensagens brutas de WhatsApp/email. Colunas:
  `id`, `card_id`, `canal`, `remetente`, `conteudo`, `recebido_em`,
  `processing_status`.
- **`todos`** — ações propostas pelos agentes, aguardando validação humana.
  Colunas: `id`, `card_id`, `action_id`, `descricao` (texto que o operador
  lê — ex.: "Lançar ocorrência 21 no SSW"), `proposta_payload` (jsonb com
  detalhes do que vai ser executado), `status`
  ('pendente'|'aprovado'|'rejeitado'|'executado'|'expirado'), `approved_by`,
  `approved_at`, `rejection_reason`, `created_at`.
- **`audit_log`** — efeitos externos (SSW, WhatsApp, e-mail). Read-only pra
  UI; só mostrar pra gestor na tela de auditoria.
- **`pendencias`** — follow-ups agendados. Colunas: `id`, `card_id`,
  `titulo`, `data_agendada`, `status`.
- **`feature_flags`** — toggles de agentes e auto-aprovação. `key`,
  `enabled`, `description`. Só gestor altera.

**Estados possíveis do card** (campo `state`):
`RECEBIDO`, `EM_TRIAGEM`, `AGUARDANDO_VINCULACAO`, `AGUARDANDO_CONTEXTO`,
`AGUARDANDO_AGENTE`, `EM_EXECUCAO_AUTOMATICA`,
`AGUARDANDO_VALIDACAO_HUMANA`, `EXECUTANDO_ACAO`, `AGUARDANDO_CLIENTE`,
`AGUARDANDO_TERCEIRO`, `BLOQUEADO_POR_ERRO`, `ESCALADO_HUMANO`, `RESOLVIDO`,
`CANCELADO`.

O estado mais importante pra UI é `AGUARDANDO_VALIDACAO_HUMANA` — esses são
os cards que o operador precisa olhar primeiro.

## TELAS A CONSTRUIR

### Tela 1 — Login

- Tela simples com email + senha.
- Supabase Auth (signInWithPassword).
- Após login, redireciona pra `/inbox`.
- "Esqueci a senha" → email de reset (Supabase nativo).
- Sem cadastro público (operadores são criados pelo gestor).

### Tela 2 — Inbox (rota raiz após login)

A tela mais importante. É onde o operador vive.

**Layout:**
- Sidebar esquerda fixa com navegação: **Inbox**, **Resolvidos**,
  **Pendências** (do tab de pendencias agendadas), **Auditoria** (só
  gestor), **Configurações** (só gestor). No rodapé da sidebar: nome do
  operador logado + botão Sair.
- Área central: **lista de cards**.
- Topo da área central: filtros + busca.

**Filtros (em chips ou toolbar)**:
- **Estado:** dropdown com os 14 estados, multi-select. Default: todos exceto
  `RESOLVIDO` e `CANCELADO`.
- **Tipo:** dropdown multi-select (rastreamento, reentrega, devolução,
  avaria, extravio, inversão, cobrança, outros).
- **Risco:** chip de toggle (Alto / Baixo / Todos).
- **Atribuição:** "Meus cards" (default) | "Todos" (gestor) | "Sem dono".
- **Busca:** campo de texto que busca por NF, CTRC, empresa, nome cliente.
- **Toggle:** "Apenas aguardando validação humana" — destaca os cards onde
  `state = 'AGUARDANDO_VALIDACAO_HUMANA'`.

**Lista de cards (tabela ou cards visuais — prefiro tabela densa):**

Cada linha mostra:
- **Indicador de estado** (badge colorido — verde pra estados ok, amarelo
  pra aguardando, vermelho pra bloqueado/escalado, azul pra em execução,
  cinza pra resolvido).
- **Indicador de risco** (ponto vermelho se `risco='alto'`, ponto cinza se
  baixo).
- **NF / CTRC** (em destaque, fonte mono).
- **Empresa / Cliente** (segunda linha, menor).
- **Tipo** (chip pequeno colorido por tipo).
- **Resumo** (1 linha truncada — se tiver `agent_state.resumo` ou último
  evento de tipo `ClassificacaoConcluida`, mostra ele).
- **Última atividade** (`last_event_at` em formato relativo: "há 5min", "há
  2h", "ontem").
- **Operador atribuído** (nome do operador ou "—").
- **Indicador de to-dos pendentes**: se `todos` tem rows com
  `status='pendente'` pro card, mostra um badge com contador (ex: "2
  ações"). Esses são os mais urgentes.

**Realtime:** assina `cards` e `todos` via Supabase Realtime. Quando entra
linha nova ou muda `state`, a lista atualiza sem refresh.

**Ordenação default:** cards com to-dos pendentes primeiro, depois por
`last_event_at` desc.

**Click na linha:** abre Tela 3 (Detalhe do card) na URL `/cards/<id>`.

### Tela 3 — Detalhe do card

Quando o operador clica num card. Layout em 3 colunas (ou 2 + drawer em
mobile).

**Coluna 1 (esquerda, ~25% largura) — Identificação**
- Empresa / Cliente
- NF, CTRC (mono, copiável)
- Pagador, base destino, dias atraso
- Responsável relacionamento
- Canal de origem (whatsapp/email/sistema)
- Estado atual + badge
- Tipo + risco
- Botões secundários: **Atribuir a mim** (UPDATE
  `assigned_operator_id`), **Reatribuir** (gestor), **Marcar resolvido
  manual** (gestor — INSERT card_event 'CardEncerradoManualmente'),
  **Cancelar card** (gestor — só se for falso positivo).

**Coluna 2 (centro, ~45% largura) — Conversa + linha do tempo**

Tab navegação no topo:
- **Mensagens** (default) — thread de `messages_inbox` filtrada por
  `card_id`. Bolhas estilo chat:
  - Mensagens recebidas (do cliente) à esquerda, fundo cinza claro.
  - Mensagens enviadas (operador/agente) à direita, fundo verde claro
    (dá pra inferir pela `actor_type` em `card_events.payload` ou
    cruzando com `audit_log`).
  - Cada mensagem mostra canal (ícone WhatsApp ou e-mail), remetente,
    timestamp, conteúdo.
  - Embaixo: caixa de composição manual — operador digita resposta, escolhe
    canal (whatsapp/email — default = canal do card), clica **Enviar**.
    Enviar = INSERT em `card_events` com `event_type='RespostaManualEnviada'`
    + payload com texto/canal/destinatário. Não chama API direto. (Edge
    Function executor processa depois.)
- **Eventos** — lista de `card_events` desse card, ordem cronológica
  decrescente. Cada evento: ícone (por actor_type), tipo, payload em JSON
  formatado, timestamp. Esta tab é a **auditoria visual** — onde o operador
  vê tudo que rolou.
- **Histórico SSW** — última ocorrência registrada (lê de `card_events`
  filtrando `event_type='OcorrenciaSSWConfirmada'` ou similar) + status
  atual da carga (do `agent_state.contexto_ssw` se existir).

**Coluna 3 (direita, ~30% largura) — Ações sugeridas**

Esta é a coluna mais importante do produto. Lista de `todos` filtrados
por `card_id` AND `status='pendente'`, ordenados por `created_at`.

Cada to-do é um cartão com:
- **Descrição grande no topo** (ex.: "Lançar ocorrência 21 no SSW —
  reentrega solicitada pelo cliente")
- **Quem propôs** (ex.: "Proposto por agente Reentrega há 2min")
- **Detalhes da ação** (renderiza `proposta_payload` jsonb de forma
  legível — ver "renderização de payload" abaixo).
- **Rationale do agente** se vier no payload (frase explicativa).
- **2 botões grandes:** ✅ **Aprovar e executar** e ❌ **Rejeitar**.
- **Rejeitar** abre modal pedindo `rejection_reason` (text obrigatório).

**Comportamento do clique em Aprovar:**
1. INSERT em `card_events`:
   - `card_id` = id do card
   - `event_type` = 'AprovacaoOperador'
   - `payload` = `{ "todo_id": "<id>", "action_id": "<action_id>" }`
   - `actor_type` = 'operator'
   - `actor_id` = id do operador (do `auth.uid()` resolvido pra
     `operadores.id`)
2. UPDATE em `todos`:
   - `status` = 'aprovado'
   - `approved_by` = id do operador
   - `approved_at` = now()
3. Mostrar toast "Ação aprovada — em execução" e remover o to-do da lista
   visível (ou mover pra seção "Em execução" abaixo).

**Comportamento do clique em Rejeitar:**
1. Modal com `rejection_reason` obrigatório.
2. INSERT em `card_events`:
   - `event_type` = 'RejeicaoOperador'
   - `payload` = `{ "todo_id": "<id>", "motivo": "<texto>" }`
3. UPDATE em `todos`:
   - `status` = 'rejeitado'
   - `rejection_reason` = texto
4. Toast "Ação rejeitada" e some da lista.

**Renderização de `proposta_payload`:** o jsonb pode ter formatos diferentes
dependendo do agente. Renderize de forma genérica:
- Se tem chave `tool` (ex.: 'lancar_ocorrencia'), mostre como label da ação.
- Se tem chave `args`, exibe os args como tabela chave→valor.
- Se tem `texto` (mensagem proposta ao cliente), mostre num quote box
  destacado pra operador conferir antes de aprovar.
- Sempre tenha um expander "Ver JSON cru" pra operador avançado.

**Embaixo da coluna 3:** seção colapsada **"Histórico de ações"** — todos
desse card com `status != 'pendente'` (aprovados, rejeitados, executados,
expirados). Útil pra ver o que já foi feito.

### Tela 4 — Pendências (sidebar)

Lista de `pendencias` (follow-ups agendados). Ordenado por `data_agendada`
asc. Filtros: status (pendente/concluída/cancelada), data (hoje/amanhã/esta
semana). Click numa pendência → vai pro card relacionado (Tela 3). Botão
"Marcar concluída" (UPDATE `pendencias.status = 'concluida'`).

### Tela 5 — Auditoria (só gestor)

Tabela densa de `audit_log`. Filtros: external_system (ssw/evolution/resend),
status (success/failed), card_id (busca), action_type, range de data.
Cada linha: timestamp, sistema, action_type, status (verde/vermelho),
external_id (protocolo/message_id), card_id (link). Click expande payload de
request/response.

### Tela 6 — Configurações (só gestor)

3 sub-abas:

1. **Feature flags** — lista todas as rows de `feature_flags`. Toggle
   liga/desliga. Mostra `description`. UPDATE direto na tabela quando
   liga/desliga (RLS já restringe a gestor).
2. **Operadores** — lista de `operadores`. CRUD: convidar novo (envia magic
   link via Supabase Auth), editar (nome, papel, carteira), ativar/desativar
   (`ativo` boolean).
3. **Estatísticas** (futuro — placeholder por enquanto): contadores básicos
   — cards abertos, taxa de aprovação, tempo médio até primeira resposta.

## DECISÕES DE DESIGN VISUAL

- **Densidade alta.** Operador trabalha rápido. Tabela com linhas finas, não
  cards grandes na inbox.
- **Tipografia:** sans-serif moderna (Inter ou similar). Mono pra
  NF/CTRC/idempotency_key.
- **Cor:** paleta neutra (cinzas) + acentos:
  - Verde = ok / aprovado / sucesso
  - Amarelo = aguardando
  - Vermelho = bloqueado / risco alto / rejeitado
  - Azul = em execução / em andamento
  - Roxo = ações de IA (chip de "proposto por agente X")
- **Dark mode:** opcional, deixa pra depois.
- **Mobile:** funciona, mas a UX prioritária é desktop. Operador usa em
  monitor 1080p ou maior.
- **Empty states:** se não tiver cards, mostra "Nenhum card aguardando —
  bom trabalho!" com ilustração suave. Não vazio.

## NÃO FAÇA

- **Não crie tabelas novas no Supabase.** O schema está pronto. Se sentir
  falta de algum campo, comente em vez de inserir DDL.
- **Não use mocks pra cards/todos.** Conecte no Supabase real desde o
  primeiro render. A app sem dados reais não tem valor.
- **Não dê UPDATE direto em `cards.state`** pela UI. Sempre via INSERT em
  `card_events` (a projeção atualiza sozinha). Exceções razoáveis: campos
  como `assigned_operator_id` podem ser UPDATE direto — não são parte da
  máquina de estado.
- **Não chame APIs externas (SSW, Evolution, Resend).** A UI só lê/escreve
  Supabase. Edge Functions backend cuidam de chamadas externas (a serem
  criadas depois).
- **Não invente lógica de classificação ou agente** na UI. Triador,
  vinculador, agentes especialistas são backend (Edge Functions a serem
  criadas). UI é puro CRUD + visualização + aprovação.
- **Não exponha `audit_log`, `agent_runs`, `feature_flags`** pra papel
  `operador`. Só `gestor` vê (RLS já bloqueia, mas não mostre os links na
  sidebar pro operador).

## TECNOLOGIA

- **Supabase JS client v2** (`@supabase/supabase-js`).
- **Realtime:** Supabase Realtime channels nas tabelas `cards` e `todos`.
- **Auth:** Supabase Auth (email + senha).
- **State:** React Query (TanStack Query) pra cache de queries +
  invalidação. Subscrições Realtime invalidam queries.
- **Routing:** React Router (rotas: `/login`, `/inbox`, `/cards/:id`,
  `/pendencias`, `/auditoria`, `/configuracoes`).
- **Tailwind** pra estilização.
- **shadcn/ui** ou similar pra componentes (table, dialog, dropdown, badge).
- **Icons:** Lucide.

## ROTEIRO DE IMPLEMENTAÇÃO

Faça nesta ordem (uma tela funcionando antes de seguir pra próxima):

1. Login + auth.
2. Inbox com lista de cards (filtros + busca, sem realtime ainda).
3. Detalhe do card — coluna esquerda (identificação) + tab Mensagens.
4. Coluna direita do detalhe — to-dos com Aprovar/Rejeitar funcionando
   (testar inserindo manualmente uma row em `todos` no Supabase Studio).
5. Realtime no inbox e nos to-dos.
6. Tab Eventos no detalhe.
7. Composição manual de resposta.
8. Pendências.
9. Auditoria (gestor).
10. Configurações (gestor).

## DADOS DE TESTE

Use o Supabase Studio pra inserir manualmente:
- 1 row em `cards` com `state='AGUARDANDO_VALIDACAO_HUMANA'`,
  `tipo='reentrega'`, NF/CTRC fictícios.
- 2-3 rows em `messages_inbox` pra esse `card_id`.
- 1 row em `todos` com `status='pendente'`,
  `descricao='Lançar ocorrência 21 no SSW'`,
  `proposta_payload={"tool":"lancar_ocorrencia","args":{"codigo":"21","nf":"26523","descricao":"Reentrega solicitada"}}`.

Esse mínimo já dá pra você testar o fluxo Aprovar/Rejeitar sem o backend
estar pronto.

## PERGUNTAS QUE PODEM SURGIR — RESPOSTAS

- **"E se eu precisar criar um card manualmente pelo cockpit?"** Funciona,
  mas é exceção. Botão "+ Novo card" no canto superior direito da Inbox
  abre form simples (NF, CTRC, empresa, conteúdo da primeira mensagem,
  canal). Submit cria card via INSERT em `messages_inbox` (canal='sistema',
  conteudo do form), Edge Function processa depois. **Adiar pra fase 2.**
- **"E o Bastão (outro Supabase com pendências)?"** Não conecta no
  Bastão direto pelo Lovable. Uma Edge Function backend sincroniza Bastão
  → cards do Cockpit a cada 20min (igual o `monitor-ocorrencias` do v1).
  Pra UI, Bastão é invisível.
- **"Ações que dependem de fluxo (ex.: agente Reentrega gera 3 to-dos
  encadeados)?"** Cada to-do é independente do ponto de vista da UI. O
  agente backend é quem gera o próximo to-do após o anterior ser
  aprovado/executado. UI só renderiza os pendentes do momento.

---

Construa **a Tela 1 (Login) e a Tela 2 (Inbox) com filtros e dados reais
do Supabase, sem realtime ainda**. Quando terminar isso, me chama no chat
do Lovable que a gente itera pra Tela 3 (Detalhe do card) — que é a parte
mais delicada.
