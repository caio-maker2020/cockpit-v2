# ADR 0041 — A Operação no Cockpit: fila própria e lançamento no SSW pelo clique humano

Data: 2026-10-07
Status: proposto. Branch local `op/operacao` (base eb2d098 = master 178dcf8 + ponte v2).
Migrations `430`–`433` **não aplicadas** (nem dry-run); nenhuma edge deployada, nenhuma
flag ligada, nenhum secret criado, nenhum cron agendado. Tudo aguarda o time do Cockpit,
pelo trilho.
Guards: **INV-180 a INV-187** · `/verify-cockpit` Fase 8 (continuação 3)
Reabre: **0004** (Cockpit exclusivo do Relacionamento) e **0039 D1** (nenhum login da
Operação no Cockpit). Relacionados: 0002 (event sourcing do card), 0016 (veto), 0033
(ação irreversível é humana), 0038/0039 (ponte com o Roteirizador).
Separação RLS: `docs/OPERACAO-SEPARACAO-RLS.md`.

## Contexto

A 0004 fez do Cockpit a fila exclusiva do Relacionamento e deixou as outras áreas "em
ferramentas próprias, quando chegar a hora". A 0039 manteve isso: a Operação agiria por
um painel no Roteirizador, e o Cockpit receberia só **pedidos de máquina**. A 0039
escreveu a condição de reabertura: *"Se um dia a operação quiser fila ou tela dentro do
Cockpit, aí sim a 0004 precisa ser reaberta, em outro ADR."* Este é o ADR.

O dono decidiu (07/10):

1. **A Operação vê a fila dela e LANÇA ocorrências no SSW dentro do Cockpit.** O humano
   clica; o sistema grava pela conta de serviço `ai.salex`.
2. **"Relacionamento não precisa aparecer para a Operação, nem vice-versa."** Membros
   da Operação não leem cards, tratativas, clientes nem mensagens do Relacionamento;
   operadores do Relacionamento não leem a fila da Operação. Só o **gestor**
   (`operadores.papel = 'gestor'`) vê os dois. Nota com card ativo do Relacionamento
   simplesmente **não entra** na fila da Operação.
3. **Nada sai sem clique humano.** A sugestão do agente é de regras puras (sem LLM nesta
   fase); aceitar é **1 clique**, com confirmação do que será lançado.
4. **A Operação vem antes do Bastão novo.** A fila nasce da interface `BastaoClient`
   atual (Bastão Lovable), com responsável atual = Operação.

## Decisão

### D1 — A 0004 é reaberta só para a Operação; a 0039 D1 fica superada

- O Cockpit passa a ter **duas áreas**: Relacionamento (tudo o que existe) e Operação
  (tabelas `op_*`, RPCs `op_*`, tela a construir em `apps/cockpit-web`). Devolução,
  Ressarcimento, Perdas e Agendamento continuam fora (a 0004 vale para elas).
- A 0039 D1 ("ninguém da operação ganha login no Cockpit") deixa de valer: membros da
  Operação logam no mesmo projeto Supabase. O resto da 0039 continua: o painel do
  Roteirizador e a ponte seguem existindo e podem conviver com a tela da Operação no
  Cockpit. **As duas portas compartilham a vazão do SSW** (D7).
- A 0004 tinha rejeitado o "Cockpit unificado" por falta de RBAC por área. O RBAC
  agora existe e é mínimo: a área é decidida pela tabela em que a pessoa está
  (`operadores` = Relacionamento; `operacao_membros` = Operação), e a RLS separa (D2).
- O event sourcing do card (0002) não é estendido à Operação: `op_eventos` é um log
  **append-only simples** (trigger recusa UPDATE/DELETE/TRUNCATE), sem projeção
  reconstruível. `op_itens` é estado. Isso é deliberado: a fila da Operação é uma visão
  do Bastão, não um agregado de negócio do Cockpit.

### D2 — Separação dos dois lados (mig 431 e mig 430)

- **Relacionamento fechado para quem está fora de `operadores`:** policy RESTRICTIVE
  `sep_somente_relacionamento` em 58 tabelas do Relacionamento (inclusive as 22 que
  tinham `USING (true)` e a `cliente_config`, aberta a `PUBLIC`). Restrictive é AND:
  quem está em `operadores` não perde nada (provado em teste). Também:
  `operadores` deixa de aceitar auto-cadastro (só gestor insere; antes qualquer
  authenticated podia se inserir **como gestor**); 5 visões sem `security_invoker` e 17
  RPCs SECURITY DEFINER sem checagem de pessoa e fora do front são fechadas a
  anon/authenticated. Inventário e o que ficou pendente: `docs/OPERACAO-SEPARACAO-RLS.md`.
- **Operação fechada para o Relacionamento:** as tabelas `op_*` nascem com RLS cujo
  predicado só passa para membro ativo da Operação (pela unidade), supervisor da
  Operação ou gestor do Cockpit. Escrita só por RPC SECURITY DEFINER.
- `operadores.papel` **não muda**. O gestor do Cockpit é o mesmo; a Operação tem papéis
  próprios em `operacao_membros.papel_op` (`operador_op` | `supervisor_op`).
- **Pendente e bloqueante para a tela:** edges do Relacionamento chamáveis por qualquer
  usuário logado (P1 do doc: `atualizar-card-via-portal-ssw`, `puxar-historico-ssw-card`,
  `enviar-retificacao-evidencia`, `cobrar-cliente-aguardando`, `send-whatsapp-message`) e
  a RPC `resolver_email_cobranca_cliente`. Elas precisam conferir `operadores` antes de
  a `operacao_tela` ser ligada.

### D3 — Membros e papéis (`operacao_membros`)

| Campo | Regra |
|---|---|
| `user_id` | `auth.users`, UNIQUE |
| `papel_op` | `operador_op` vê as suas `unidades`; `supervisor_op` vê todas (inclusive item sem unidade) e pode assumir item de outro |
| `unidades` | siglas em maiúsculas (CHECK) |
| `pode_lancar` | nasce **false**: ver a fila não dá direito a lançar |
| `ativo` | inativo = como se não existisse |

Funções: `current_op_membro_id()`, `current_op_unidades()`, `eh_supervisor_op()`,
`op_eh_gestor()`, `op_flag(key)`, `op_pode_ver_unidade(unidade)`. A tabela nasce vazia;
o cadastro é pelo trilho (service_role), como o de `operadores` hoje.

### D4 — A fila nasce do Bastão (`materializar-fila-operacao`, mig 432)

- Fonte: o `BastaoClient` de hoje + **um método**, `fetchPendenciasDaOperacao`, num
  adaptador próprio (`_shared/bastao-operacao-client.ts`). O `bastao-client.ts` é espelho
  de `lib/` e está pinado byte a byte; não foi tocado. Quando o Bastão novo chegar, só o
  adaptador muda.
- "Da Operação" segue a hierarquia do `state_pelo_bastao` (mig 029): `responsavel_atual`
  do Bastão manda; vazio → `ocorrencias_dicionario.responsabilidade = 'Operação'`.
- **Nunca entra:** finalizadoras **1/30/32**, documentais **2/34** e **CTRC com card
  ativo** no Relacionamento. Item aberto cujo CTRC ganha card ativo, finaliza ou vira
  documental é **encerrado** com o motivo, e o pedido de lançamento que ainda estava na
  fila é cancelado.
- **Unidade** pela `op_regra_unidade_por_oc` (campo do Bastão por oc; regra específica
  vence a genérica). Nasce **vazia**: item sem unidade só aparece ao supervisor e ao
  gestor.
- **Guard anti-loop INV-040:** com 3+ itens ENCERRADOS do mesmo CTRC criados em 24 h o
  item não renasce (mesma decisão pura e mesmo limite do sync, importados de
  `guard-anti-loop-criacao.ts`), e a recusa vira evento `LoopMaterializacaoBloqueado`
  (1 por 24 h).
- **Fechamento seguro:** nada é encerrado por "sumiu do Bastão" quando a leitura veio
  incompleta, vazia, ou quando mais da metade da fila (com 20+ itens) sumiria numa
  rodada só. A lista de cards ativos é lida antes de planejar; se ela falhar, a rodada
  inteira para (fail-closed).
- Sem SSW. Um item aberto por CTRC (índice único parcial). Grava por
  `op_materializar_aplicar`, em lotes de 200, uma transação por lote.

### D5 — A lista de códigos que a Operação lança (`op_codigos_lancaveis`)

- **Nasce vazia.** Sem código ativo, nenhuma prévia passa (`codigo_nao_permitido`).
- **CHECK proíbe 49, 54, 59, 33, 44, 6, 9, 16:** a 49 é tratativa do Relacionamento
  (nunca pelo menu genérico), 54/59 são do cliente, 33/44 exigem documento
  (ressarcimento/devolução com CT-e), 6/9/16 são extravio (Perdas).
- Trigger: só código com responsabilidade `'Operação'` no dicionário.
- **41 e 56 exigem o texto da pessoa** (INV-046): CHECK na lista (`exige_texto`), CHECK
  em `op_lancamentos` (≥ 10 caracteres), recusa na prévia e cerca no envelope.
- `ativo = true` exige `pedido_por`, `autorizado_por` e `autorizado_em` (CHECK).
  **Dono da lista: Caio.** Cada código entra por migration TIPO B com `--autorizado-por`,
  com o critério escrito. Candidatos (não cadastrados): 14, 15, 36, 37, 39 (os da 0039).

### D6 — Sugestão por regras puras, em sombra

- `_shared/operacao-sugestao.ts`: tabela `REGRAS_SUGESTAO_OPERACAO` **vazia**, motor puro
  (primeira regra que casa), validação que recusa regra sem oc, regra que sugere código
  proibido e regra que sugere 41/56 (o texto é da pessoa).
- O materializador grava a sugestão no item (`op_itens.sugestao`) e o evento
  `SugestaoGerada`. **Nunca lança.** `lancavel = false` quando o código não está ativo na
  lista: fica só em sombra, para medir.
- Como uma regra entra: commit revisável com teste, versão nova em
  `VERSAO_REGRAS_SUGESTAO_OPERACAO`, e pedido da Operação registrado.

### D7 — O lançamento: prévia, clique, fila, envelope, confirmação

1. **Prévia** (`op_previa_lancamento`): relê a cerca inteira e devolve exatamente o que
   vai ao SSW — CTRC e NF **do item**, código, descrição, texto final
   (`<texto> (Operação <unidade> por <nome>)`) e a conta (`ai.salex`) — mais um **token**
   (`md5` de item, CTRC, NF, oc atual, código e texto).
2. **Clique** (`op_solicitar_lancamento` / `op_aceitar_sugestao`): trava o item, **relê
   a cerca de card ativo e a lista de códigos**, confere o token (mudou qualquer coisa →
   `previa_desatualizada`, nada grava), assume o item se estiver livre e grava a linha em
   `op_lancamentos` com quem pediu. Um lançamento ativo por item (índice único parcial):
   duplo clique, duas abas ou duas pessoas não lançam duas vezes.
3. **Worker** `processar-lancamentos-operacao` (cron 1 min, mig 433), serial:
   - vazão `op_reservar_lancamentos`: **2/min pedidos, teto 3 no SQL**, janela de 60 s,
     **o mesmo advisory lock da ponte** e contando também as reservas da ponte (a conta
     `ai.salex` é uma só — INV-159); quarentena de 30 min após login recusado, **na
     Operação ou na ponte**;
   - relê a cerca na hora (card ativo, código ativo, item aberto, NF);
   - **freio**: a flag `operacao_lancar_ssw` é relida imediatamente antes de cada ida ao
     SSW; desligada no meio, os reservados voltam à fila;
   - lança pelo envelope `lancarSswPortalOperacao` (D8).
4. **Prazos**: na fila há mais de 4 h → `erro` (expirado); reservado e não terminado em
   15 min → `erro` (`lancamento_interrompido`). **Nunca relança às cegas.**
5. **Confirmação**: o lançamento confirma pela **leitura seguinte da oc** (o
   materializador vê no Bastão a oc lançada → `confirmado_por = 'bastao'`). Só depois de
   **90 min** sem isso o worker pergunta ao SSW (`descobrirUltimaOcSsw`, conta de serviço),
   no máximo 1 leitura por rodada e espaçadas 30 min: última oc = a lançada, ou a lançada
   no histórico recente pela conta de serviço → `confirmado`; outra → `nao_confirmado`
   (uma pessoa confere); leitura falhou 3 vezes → `nao_confirmado`. A confirmação
   **nunca relança**.

### D8 — O envelope da Operação (`_shared/lancar-ssw-portal-operacao.ts`)

O envelope do Relacionamento exige card e grava `acoes_executadas_ssw` por card; a
Operação lança em CTRC **sem** card ativo. O envelope do Relacionamento tem **zero
diff** (pinado). O da Operação **compõe as mesmas peças**: `lancarOcorrenciaPortal`
(latin-1, Instrução ≤ 500), `validarTripeCtrcNfPagador` (CTRC + NF + localização, antes
do submit, **nunca dispensado**), `decidirIdempotenciaRelancamento` (importada, não
copiada), `readSswLancamentoEnv` (INV-013) e `op_acoes_executadas_ssw`
(`UNIQUE(op_item_id, codigo_oc, ctrc)`). Cercas antes de consumir a chave de
idempotência: código proibido e 41/56 sem texto. O guard do INV-013 no `/verify-cockpit`
passa a cobrir os dois envelopes.

### D9 — Flags (todas OFF) e a dupla trava

| Flag | Liga | OFF = |
|---|---|---|
| `operacao_fila` | o materializador | `skipped: flag_off`, nem o Bastão é lido |
| `operacao_tela` | a RLS dos membros em `op_itens` e as RPCs da tela | membro não vê nada; o gestor continua vendo (para conferir) |
| `operacao_lancar_ssw` | a prévia/pedido e o worker | nenhum pedido novo (`lancamento_desligado`); worker `skipped`; freio dentro do laço |

As edges novas exigem service_role por **capacidade** (`op_vigia_resumo`, só
service_role) — usuário logado ou anon recebem 401.

## Contrato com o front (o outro worker constrói a tela sobre isto)

| Chamada | Retorno |
|---|---|
| `rpc('op_minha_sessao')` | `{membro: {id, nome, email, papel_op, unidades[], pode_lancar} \| null, eh_gestor, eh_supervisor, flags: {operacao_tela, operacao_lancar_ssw, operacao_fila}}` |
| `from('op_v_fila').select(...)` | linhas: `op_item_id, ctrc, nf, unidade, status, cod_ultima_ocorrencia, descricao_oc, data_ultima_ocorrencia, instrucao_ultima_ocorrencia, pagador, destinatario, cidade_destino, uf_destino, previsao_entrega, atraso_original, qtd_volumes, assumido_por, assumido_por_nome, assumido_em, sugestao, sugestao_em, lancamento_id, lancamento_status, lancamento_codigo_oc, lancamento_solicitado_por_nome, lancamento_solicitado_em, materializado_em, updated_at` |
| `rpc('op_item_detalhe', {p_op_item_id})` | `{ok, item, descricao_oc, eventos[≤50], lancamentos[≤20], codigos_disponiveis[]}` ou `{ok:false, erro:'nao_encontrado'}` |
| `rpc('op_codigos_disponiveis')` | `[{codigo, descricao, exige_texto}]` |
| `rpc('op_assumir', {p_op_item_id, p_forcar?})` | `{ok, op_item_id, assumido_por, status}` ou `{ok:false, erro}` |
| `rpc('op_previa_lancamento', {p_op_item_id, p_codigo_oc, p_texto})` | `{ok:true, texto_ssw, confirmacao, previa:{op_item_id, ctrc, nf, unidade, oc_atual, codigo_oc, descricao_oc, texto_ssw, conta_ssw}}` ou `{ok:false, erro, motivo}` |
| `rpc('op_solicitar_lancamento', {p_op_item_id, p_codigo_oc, p_texto, p_confirmacao})` | `{ok:true, lancamento_id, status:'fila', previa}` ou `{ok:false, erro, motivo}` (`previa_desatualizada` traz a prévia nova) |
| `rpc('op_aceitar_sugestao', {p_op_item_id, p_confirmacao})` | idem (o front chama antes a prévia com `sugestao.codigo` e `sugestao.texto`) |
| `rpc('op_cancelar_lancamento', {p_lancamento_id})` | `{ok, lancamento_id, status:'cancelado'}` (só enquanto `fila`) |

Erros possíveis (`erro`): `nao_e_membro_da_operacao`, `lancamento_desligado`,
`tela_desligada`, `sem_permissao_de_lancar`, `item_fechado`, `fora_da_sua_unidade`,
`assumido_por_outro`, `tratativa_aberta_no_relacionamento`, `nota_finalizada`,
`sem_nf_para_tripe`, `codigo_proibido`, `codigo_nao_permitido`, `texto_obrigatorio`,
`texto_longo`, `ja_e_a_ultima_oc`, `lancamento_em_andamento`, `previa_desatualizada`,
`sem_sugestao`, `nao_e_seu`, `ja_saiu_da_fila`, `nao_encontrado`.

## Como ligar (pelo trilho, um passo por vez)

0. Revisar este ADR, `docs/OPERACAO-SEPARACAO-RLS.md`, rodar as suítes
   (`deno test --no-check --allow-read --allow-env supabase/functions/_shared/operacao-*.test.ts …`)
   e `supabase/tests/operacao/rodar-local.sh`.
1. **Mig 430** (TIPO B). Inerte.
2. **Pré-check** do doc de separação; **mig 431** (TIPO B, horário calmo; `lock_timeout`
   5 s — se falhar, reaplicar).
3. Fechar as pendências P1 do doc (edges e `resolver_email_cobranca_cliente`).
4. Deploy de `materializar-fila-operacao`, `processar-lancamentos-operacao` e do
   `health-check`. Mig 432 + prova de pulso (INV-156). Cadastrar 1–2 regras de unidade
   (TIPO B) e `operacao_fila` ON. Conferir com a Operação que a fila bate com o Bastão
   (e que nenhum CTRC com card ativo apareceu).
5. Cadastrar membros (`pode_lancar = false`) e `operacao_tela` ON. A Operação usa a fila
   só para ver.
6. Mig 433 + pulso. Primeiro código na lista (TIPO B, com dono), `pode_lancar` para 1
   pessoa, `operacao_lancar_ssw` ON em horário calmo; primeiro lançamento num CTRC de
   teste, com alguém olhando `op_lancamentos` e `op_acoes_executadas_ssw`. Medir a taxa
   orgânica de login antes (INV-159 c).

## Como desligar

- Na hora, sem deploy: `operacao_lancar_ssw` OFF (relida antes de cada lançamento; a
  fila espera e expira em 4 h), `operacao_tela` OFF, `operacao_fila` OFF.
- Um código: `UPDATE op_codigos_lancaveis SET ativo = false WHERE codigo = N` (TIPO B).
- Remover: `cron.unschedule` dos dois jobs; reversões no cabeçalho das migs 431 e 430.
- O que foi lançado no SSW não se desfaz.

## O que depende do Caio / da Sal

- **Caio:** aplicar as migs pelo trilho; pré-check; fechar as P1 da separação; dono da
  lista de códigos (cada código, com critério) e das regras de unidade; achado
  `operadores_update_self` (escalada a gestor).
- **Sal / Operação:** quem são os membros e as unidades de cada um; de qual campo do
  Bastão sai a unidade (por oc); quais códigos a Operação quer lançar (com o porquê de
  cada um ser fato da rota); que padrões querem ver sugeridos (regras); quem é supervisor.

## Consequências e riscos

- **Bastão:** a leitura da Operação é maior que a do Relacionamento (toda pendência com
  a Operação). Paginação de 1000, teto 50 mil linhas; rodada a cada 10 min. Medir o tempo
  da primeira rodada antes de encurtar o intervalo.
- **Vazão compartilhada:** a Operação conta as reservas da ponte; a RPC da ponte (mig
  415) ainda **não** conta as da Operação. Pior caso, com as duas portas ativas no mesmo
  minuto: 3 da ponte + o que sobrar para a Operação ≤ 3 → até 6/min se a ponte reservar
  depois. Correção (dono da ponte): somar `op_lancamentos` na `ponte_operacao_reservar_lancamentos`.
- **INV-014/CONFLITOS:** o lançamento da Operação vai em `op_acoes_executadas_ssw`, não em
  `acoes_executadas_ssw`. Como só acontece em CTRC sem card ativo, não há card para cair
  em CONFLITOS. Se um card nascer depois sobre esse CTRC, a oc aparece como "de fora";
  avaliar ler `op_acoes_executadas_ssw` no detector antes de ligar o lançamento.
- **Locks da 431:** CREATE POLICY em tabela quente; `lock_timeout` 5 s.
- **Typecheck:** `deno check` das edges novas acusa 9 erros **pré-existentes** em
  `lancar-ssw-portal.ts`/`validar-tripe-ssw.ts` (pinados; a ponte tem os mesmos).
