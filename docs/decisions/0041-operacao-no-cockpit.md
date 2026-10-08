# ADR 0041 — A Operação no Cockpit: fila própria e lançamento no SSW pelo clique humano

Data: 2026-10-07
Status: proposto. Branch local `op/operacao` (base eb2d098 = master 178dcf8 + ponte v2).
Migrations `430`–`437` **não aplicadas** (nem dry-run); nenhuma edge deployada, nenhuma
flag ligada, nenhum secret criado, nenhum cron agendado. Tudo aguarda o time do Cockpit,
pelo trilho.
Guards: **INV-180 a INV-189** · `/verify-cockpit` Fase 8 (continuações 3 e 4)
Emenda de 07/10 (mesmo dia): **D10** (sugestão: regra → agente de IA; emenda do treino
real: "aguardar", 01, estado com instrução/pagador), **D11** (encaminhar ao
Relacionamento) e **D12** (por enquanto, encaminhar vai a um ESPELHO), migs `434`–`440`
(a 440 vem da faixa 440–449 da Operação).
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
3. **Nada sai sem clique humano.** A sugestão do agente era de regras puras (sem LLM na
   primeira fase; **D10** acrescenta o agente de IA quando nenhuma regra casa); aceitar é
   **1 clique**, com confirmação do que será lançado.
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
- **CHECK proíbe 49, 54, 59, 33, 44, 6, 9, 16 e 14:** a 14 (saída para entrega) nasce do romaneio e nunca é lançada à mão (Caio 08/10); a 49 é tratativa do Relacionamento
  (nunca pelo menu genérico), 54/59 são do cliente, 33/44 exigem documento
  (ressarcimento/devolução com CT-e), 6/9/16 são extravio (Perdas).
- Trigger: só código com responsabilidade `'Operação'` no dicionário.
- **41 e 56 exigem o texto da pessoa** (INV-046): CHECK na lista (`exige_texto`), CHECK
  em `op_lancamentos` (≥ 10 caracteres), recusa na prévia e cerca no envelope.
- `ativo = true` exige `pedido_por`, `autorizado_por` e `autorizado_em` (CHECK).
  **Dono da lista: Caio.** Cada código entra por migration TIPO B com `--autorizado-por`,
  com o critério escrito. Candidatos (não cadastrados): 14, 15, 36, 37, 39 (os da 0039).

### D6 — Sugestão por regras puras, em sombra (estendida pela D10)

- `_shared/operacao-sugestao.ts`: tabela `REGRAS_SUGESTAO_OPERACAO` **vazia**, motor puro
  (primeira regra que casa), validação que recusa regra sem oc, regra que sugere código
  proibido e regra que sugere 41/56 (o texto é da pessoa).
- O materializador grava a sugestão no item (`op_itens.sugestao`) e o evento
  `SugestaoGerada`. **Nunca lança.** `lancavel = false` quando o código não está ativo na
  lista: fica só em sombra, para medir.
- Como uma regra entra: commit revisável com teste, versão nova em
  `VERSAO_REGRAS_SUGESTAO_OPERACAO`, e pedido da Operação registrado.

### D10 — Sugestões: regra → agente (emenda de 07/10; INV-188)

Requisito do dono: *"o agente precisa sugerir a ocorrência quando não for regra fixa
específica"*. A sugestão passa a ter **três camadas**; a primeira que responde decide:

| Camada | Onde | Nasce | Decide quando |
|---|---|---|---|
| 0 — regra fixa | `REGRAS_SUGESTAO_OPERACAO` (código, commit revisável) | vazia | casa oc/unidade/horas paradas |
| 1 — regra aprendida | `op_regras_sugestao` (mig 434) | **vazia** | casa o estado e tem confiança ≥ 0,6 e casos ≥ 5 (abaixo disso vira só contexto do agente) |
| 2 — agente de IA | `_shared/operacao-agente-sugestao.ts` + `prompts/agente-operacao.md` | flag `operacao_sugestao_ia` OFF | nenhuma regra casou |

- **Regra aprendida** = `{estado → ação, código, texto, confiança, casos, base_regra}`;
  estado = `{oc, unidade?, dias_parado_min?}`. A carga é uma migration **TIPO B separada**,
  gerada a partir de `regras.json` (formato no cabeçalho da mig 434 e em
  `RegraAprendidaOperacao`); antes de gerar, `validarRegrasAprendidas(regras)` tem de
  devolver `[]`, e os CHECKs da tabela repetem a validação (proibidos, 41/56, a própria
  oc, encaminhar sem código, texto ≤ 70, confiança 0..1, código de responsabilidade
  'Operação' por trigger). O materializador lê a tabela a cada rodada (falha na leitura =
  segue só com as fixas; nunca para a fila).
- **Agente**: entrada = oc atual + descrição, instrução da última oc (≤ 500, tratada como
  dado), dias parado, unidade, cidade/UF, pagador, top-3 do histórico para a oc (camada 1,
  inclusive as fracas) e a lista de códigos da Operação (dicionário − proibidos − 41/56).
  Sem CTRC, NF ou CNPJ. Saída JSON `{acao, codigo, texto ≤ 70, confianca, justificativa}`
  com `acao ∈ {lancar_ocorrencia, encaminhar_relacionamento, sem_sugestao}`; o código
  acrescenta `base_regra: "agente_ia"`, `modelo`, `versao_prompt`. **Descarta**: JSON
  inválido ou cortado (sem reparo), código proibido, 41/56, código fora da lista da
  Operação, a própria oc, encaminhar com código, texto vazio/longo, confiança fora de 0..1.
  **Uma** tentativa (`complete`, não `completeJson`), timeout 15 s; falha = sem sugestão;
  nunca bloqueia a fila.
- **Modelo**: **`claude-haiku-5-5`** — **decisão do dono (07/10)**; família Haiku, como pede
  a convenção 7 do CLAUDE.md para classificação sobre lista fechada. Declarado no
  frontmatter do prompt e em `AGENTE_OPERACAO_MODEL`. Troca sem deploy por
  `OPERACAO_AGENTE_MODELO` (lista fechada: haiku-5-5, haiku-4-5, sonnet-4-6, opus-4-7;
  valor fora da lista = padrão). `anthropic-client.ts` não foi alterado: o agente tem o
  tipo próprio `ModeloAgenteOperacao` e o cliente só repassa o id. Custo: as tabelas de
  preço (`anthropic-usage-cost.ts`, `evals/_custo-evals.ts`) ainda não têm o Haiku 5.5 —
  o eval estima pelo preço do Sonnet (erra para cima) até alguém cadastrar o preço
  oficial. Mudar o prompt = subir `AGENTE_OPERACAO_VERSION`, rodar
  `evals/agente-operacao.ts` (o teste trava o espelho `.ts` = corpo do `.md`).
- **Custo**: só item **novo** ou com **oc nova**. Cache `op_sugestao_ia_cache` com chave
  `(op_item_id, cod_ultima_ocorrencia)`: toda chamada grava 1 linha (ok, sem sugestão,
  descartada ou falha) e a mesma (item, oc) nunca é paga de novo. Teto de 10 chamadas e
  90 s por rodada (cron de 10 min ⇒ ≤ 1.440 chamadas/dia no pior caso; Haiku ≈ US$ 0,003 por
  chamada de ~3k tokens). O backlog da primeira rodada drena em lotes.
- **Onde roda**: edge própria `sugerir-operacao` (cron da mig 437, 5 min depois do
  materializador), não dentro do materializador: a chamada externa não pode atrasar nem
  derrubar a fila. Antes de chamar, ela relê as regras: **casou regra → não chama**.
- **Gravação**: `op_gravar_sugestao_ia` revalida o contrato no banco
  (`op__sugestao_valida`: proibidos nunca entram, mesmo que o TS falhe), grava o cache e,
  só se o item está aberto, na **mesma oc** e **sem sugestão** (a de regra vence), escreve
  `op_itens.sugestao` + evento `SugestaoGerada`. O materializador **preserva** a sugestão do
  agente quando reescreve o item na mesma oc (o hash ignora a sugestão do agente, para não
  reescrever o item a cada rodada) e a descarta quando a oc muda.
- **Evals** (INV-167): `evals/agente-operacao.ts` — modo seco (padrão, sem API) passa as
  fixtures sintéticas (`evals/agente-operacao/casos-sinteticos.json`, com casos adversariais:
  injeção pedindo 49, código inventado, JSON quebrado, 41, texto longo) pela validação de
  verdade; `--ao-vivo` usa só `ANTHROPIC_API_KEY_EVALS` com `ContadorCusto` e
  `portaoDeCusto`; `--casos reais.jsonl` roda contra casos reais exportados pelo trilho
  (gabarito = o que a Operação fez a seguir), sem o script abrir banco.

#### Emenda D10 — treino real (07/10, W5: 300 notas reais + backtest de 30 dias; mig 439, prompt 1.1.0)

- **"aguardar"** entra no contrato v2 (aditivo): `acao = "aguardar"`, `codigo = null`,
  `lancavel = false`, `texto` = motivo, `reavaliar_em_horas` (1..720) e `reavaliar_em`
  (ISO). Sem botão de lançar: a tela mostra **"Aguardar: motivo"** e
  `op_aceitar_sugestao` recusa (`sugestao_e_aguardar`). Motivo: o prompt 1.0.0 mandou
  **135 notas oc 41 "comprovante no malote" para encaminhar**. O agente reavalia um
  "aguardar" vencido **no máximo 3 vezes** na mesma (item, oc) (`reavaliacoes` no cache).
- **Prompt 1.1.0**: regra explícita "comprovante em trânsito/malote não é tratativa →
  aguardar"; encaminhar **só** para passagem de bastão real (o próximo passo seria 49, 54,
  59, 33, 44, 46, 30, 53 ou 58); **01 nunca** (entrega é do motorista). A 01 também é
  barrada no TS (`OCS_NUNCA_SUGERIR`), no CHECK de `op_regras_sugestao` e em
  `op__sugestao_valida`. Evals: fixtures de aguardar/malote, 01 e a regressão do 1.0.0
  (o placar ganhou `encaminhou_o_que_era_aguardar`).
- **Estado da regra aprendida**: + `instrucao_padrao` (casa por **igualdade** depois de
  normalizar: maiúsculas, sem acento, espaços colapsados — `normalizarInstrucaoPadrao`) e
  `pagador_cnpj` (só dígitos, 14 ou 11). Hierarquia de especificidade: **pagador (8) +
  instrução (4) + unidade (2) + dias parado (1)**; empate → confiança, casos, id. Motivo:
  188 regras boas ficaram fora da carga (122 dependiam da instrução, 66 do pagador). O
  "top-3 do histórico" do agente agora só traz regras do mesmo estado (outra
  unidade/pagador/instrução não entra). Formato do `regras.json` no cabeçalho da mig 439.
- **Modelo — medido**: no treino, o agente com **Opus 5.5** custou **US$ 3,93 em 446
  chamadas** e **não bateu o histórico** (17% de acerto contra 24% do baseline sem regra).
  Decisão: o modelo continua **configurável** (`OPERACAO_AGENTE_MODELO`, lista fechada); o
  Opus 5.5 não entra na lista da edge enquanto não houver ganho sobre o histórico.
  **Decisão do dono (07/10): o padrão passa a ser o Haiku 5.5** (`claude-haiku-5-5`); medir
  com `evals/agente-operacao.ts --ao-vivo` contra o histórico antes de ligar a flag.

#### Emenda D10 — minerador do v3: modelo da instrução, condições extras e alternativa (07/10; mig 440)

Numeração: a faixa 434–439 desta frente acabou; a 440 é da faixa 440–449 que era da
Operação (aval do coordenador, 07/10).

- **`estado.instrucao_modelo`**: a instrução normalizada com todo token que contém dígito
  (números, datas, horas, códigos, placas, CTRC) trocado por `#`. Função pura exportada
  `modeloDaInstrucao(texto)` em `_shared/operacao-sugestao.ts`; **o minerador do v3 usa a
  MESMA função**. Algoritmo exato:
  1. `normalizarInstrucaoPadrao`: `texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
     .toUpperCase().replace(/\s+/g, " ").trim()` (vazio → `null`);
  2. `.replace(/[A-Z0-9]*[0-9][A-Z0-9]*/g, "#")` (`REGEX_TOKEN_COM_DIGITO`; a pontuação em
     volta fica);
  3. `.replace(/\s+/g, " ").trim()`.

  Ex.: "Malote 4521 - dia 03/10" → `MALOTE # - DIA #/#`; "agendado para 15/10 às 14:30" →
  `AGENDADO PARA #/# AS #:#`; "CTRC OVD396328-4" → `CTRC #-#`; "placa ABC1D23" → `PLACA #`.
  Idempotente. Casa por **igualdade** com `modeloDaInstrucao(instrução do item)`. É
  exclusiva com `instrucao_padrao` (CHECK), e a exata é mais específica.
- **Especificidade** (a mais específica casa primeiro): `pagador_cnpj` 32 +
  `instrucao_padrao` 16 **ou** `instrucao_modelo` 8 + `unidade` 4 + 1 por condição extra
  (`dias_parado_min`, `previsao_vencida`, `ocorrencias_anteriores_min`); empate →
  confiança, casos, id.
- **Condições extras**: `previsao_vencida` (true = a previsão de entrega já passou; false =
  ainda no prazo; item **sem** previsão não casa nenhum dos dois) e
  `ocorrencias_anteriores_min` (ocorrências da nota antes da atual; item sem o dado **não
  casa**). O Bastão de hoje não traz essa contagem: regras com essa condição ficam inertes
  até existir a fonte (pendência do minerador/Bastão).
- **`alternativa`** (só em `aguardar`): `{acao: lancar_ocorrencia|encaminhar_relacionamento,
  codigo|null, texto ≤ 70, confianca 0..1, casos ≥ 0, taxa_acao 0..1}` — o que a Operação
  fez quando **não** esperou. Copiada para `op_itens.sugestao.alternativa` (a tela pode
  mostrar "Aguardar: motivo — ou: <alternativa> (x% dos casos)"). Validada em
  `validarRegrasAprendidas` (`problemaAlternativa`), no CHECK `oprs_alternativa` e no
  trigger (código da Operação no dicionário; nunca proibido, 41/56 ou 01).

**Contrato do campo `op_itens.sugestao` (jsonb, versão 2)** — o front lê isto:

| Campo | Tipo | Notas |
|---|---|---|
| `versao_contrato` | `2` | |
| `acao` | `lancar_ocorrencia` \| `encaminhar_relacionamento` \| `aguardar` | define o botão; `aguardar` = sem botão, "Aguardar: motivo" |
| `fonte` | `regra_fixa` \| `regra_aprendida` \| `agente_ia` | mostrar "sugerido pelo agente" quando `agente_ia` |
| `base_regra` | texto | id da regra fixa, `base_regra` da aprendida, ou `agente_ia` |
| `regra_id` | texto | compat (`op_lancamentos.sugestao_regra_id`); `agente_ia` para o agente |
| `codigo` | inteiro \| `null` | `null` quando encaminhar ou aguardar; nunca 01 |
| `texto` | texto ≤ 70 | vai para a prévia |
| `motivo` | texto | por que (regra/histórico/justificativa) |
| `lancavel` | bool | código ATIVO em `op_codigos_lancaveis` agora; encaminhar = `false` |
| `confianca` | 0..1 \| `null` | regra fixa = `null` |
| `casos` | inteiro \| `null` | só regra aprendida |
| `oc_base` | inteiro | oc do item quando a sugestão nasceu |
| `versao_regras` | texto | |
| `modelo`, `versao_prompt`, `justificativa` | texto | só `agente_ia` |
| `reavaliar_em_horas`, `reavaliar_em` | inteiro 1..720, ISO | só `aguardar` |
| `alternativa` | `{acao, codigo, texto, confianca, casos, taxa_acao}` | só `aguardar` de regra aprendida |

Sugestões antigas (sem `versao_contrato`) continuam aceitas por `op_aceitar_sugestao`
(lê só `codigo`, `texto`, `regra_id`).

### D11 — Encaminhar ao Relacionamento (emenda de 07/10; INV-189)

Requisito do dono: *"se for de relacionamento, ele já deve encaminhar pro cockpit de
relacionamento"*. A regra ou o agente pode concluir que o próximo passo é do
Relacionamento (cliente a contatar, autorização de reentrega, devolução, indenização…):
a sugestão vem com `acao = "encaminhar_relacionamento"`, `codigo = null`, `motivo`,
`texto`. Encaminhar = a nota **sai da fila da Operação** e **vira card** no Cockpit do
Relacionamento.

**Caminho escolhido: (b) card primeiro, 49 depois — reusando o pedido
`devolver_ao_relacionamento` da ponte (0039 D2).** O encaminhamento grava um pedido em
`ponte_operacao_pedidos` com `origem = 'cockpit_operacao'` (mig 436); o worker
`processar-pedidos-operacao` cria o card a partir do Bastão (`decidirNascimentoCard`:
AGUARDANDO_VALIDACAO_HUMANA **+ lock**; guard INV-040; extravio, CNPJ fora do Cockpit e
nota entregue não viram card), grava `CardCriadoPorPedidoOperacao`/`DevolvidoPelaOperacao`
e **só então** lança a 49 pelo envelope do Relacionamento (vazão INV-159, flag
`ponte_operacao_lancar_ssw`; OFF = o card nasce com "a 49 não foi lançada").

**Por que não (a) "lançar a 49 e deixar o sync-bastao criar o card"**: confirmado no
código — `decidirVisibilidadePorSsw` (sync-bastao, caminho de reabertura) trata a oc de
Relacionamento mais recente lançada pela `ai.salex` como **ação do próprio Cockpit**
(`MANTER_FORA_RELACIONAMENTO`, fonte `identidade`). Nota da Operação costuma ter card
**encerrado** (ex.: TRANSFERIDO) no CTRC; a 49 nossa não o reabriria e a tratativa
sumiria do operador. Marcar a origem "operação" na 49 exigiria mexer na função-mãe de
visibilidade (pinada, usada por todo o Relacionamento) ou no texto do SSW como sinal —
frágil. Criar o card antes, ativo e com lock, não passa por essa decisão. Travado em
`operacao-encaminhar.test.ts`. Também não se criou um caminho novo de card (RPC própria):
o da ponte já tem as regras de nascimento, o INV-040, a atribuição e a idempotência
revisados.

- **1 clique (padrão)**: `op_previa_encaminhamento` mostra destino, texto e o texto exato
  da 49 (mesmo formato do `montarTextoSsw` da ponte); `op_encaminhar_relacionamento`
  confere o token e envia na hora. Cerca: membro ativo com `pode_lancar`, `operacao_tela`
  e **`ponte_operacao_pedidos`** ON (`encaminhar_desligado` senão), item aberto da unidade,
  não assumido por outro, sem card ativo, sem oc 1/30/32/2/34, sem extravio 6/9/16, 49 não
  é a última oc, sem lançamento em andamento, texto 3..400 (vazio = o da sugestão).
- **Automático (flag `operacao_encaminhar_auto`, OFF)**: a edge `sugerir-operacao`
  **agenda** (não envia) o encaminhamento de item **aberto e não assumido** cuja sugestão é
  de encaminhar, na mesma oc, com confiança ≥ limiar (`OPERACAO_ENCAMINHAR_AUTO_LIMIAR`,
  padrão 0,9, **piso 0,8** no TS e no SQL). Evento `EncaminhamentoAgendado` (confiança,
  limiar, fonte, prazo). **Janela de desfazer** (`OPERACAO_ENCAMINHAR_AUTO_JANELA_MIN`,
  padrão 30, piso 10): `op_desfazer_encaminhamento` enquanto `agendado`; desfeito numa oc,
  o agente não insiste nela. Vencida a janela, `op_encaminhamentos_promover` relê a cerca e
  envia; oc mudou ou cerca fechou → `cancelado` com o motivo; parado > 24 h (ponte OFF) →
  `expirado`. É exceção consciente à 0039 D2 ("pedido tem pessoa por trás"): por isso a
  flag própria, o piso, a janela e o autor `agente-operacao` no pedido.
- **Separação (D2)**: depois de enviado, o item fecha com motivo
  `encaminhado_relacionamento` e o evento `EncaminhadoAoRelacionamento` ("encaminhada ao
  Relacionamento às HH:MM"). O materializador não o traz de volta enquanto o pedido não
  termina (`op_ctrcs_encaminhamento_pendente`); depois, a cerca de card ativo cuida. A
  Operação lê só o status do pedido (`op_encaminhamentos_do_item`: status, categoria do
  resultado, oc lançada) — **nunca** o `card_id`; `ponte_operacao_pedidos` e `cards`
  continuam fechados a ela. Se o pedido for recusado (ex.: extravio), a nota volta à fila
  na rodada seguinte, como item novo.
- `op_aceitar_sugestao` recusa sugestão de encaminhamento (`sugestao_e_encaminhamento`):
  cada ação tem o seu botão.

### D12 — Por enquanto, o encaminhamento vai para um ESPELHO (emenda de 07/10; INV-189)

Decisão do dono: *"não quero que nada vá ao Cockpit Relacionamento de verdade por
enquanto; tem que ir para um espelho que não aparece na produção de verdade"*.

- **Modo** `operacao_encaminhar_modo` em `op_config` (mig 438): `'espelho'` (**padrão**; linha
  ausente ou valor inválido também é espelho, por `op_encaminhar_modo()`) ou `'real'`. O
  `'real'` só entra por **migration TIPO B com `--autorizado-por`**: CHECK exige
  `autorizado_por`, `autorizado_em` e `motivo`; ninguém além do dono do banco escreve em
  `op_config` (nem gestor, nem service_role). Não é uma `feature_flags` de propósito: flag
  boolean se liga por engano; o modo exige dono escrito.
- **Em espelho**, `op_encaminhar_relacionamento` e o automático **não** criam pedido na
  ponte, **não** criam card, **não** lançam 49 e **não** dependem de
  `ponte_operacao_pedidos`. `op__promover_encaminhamento` desvia ANTES de qualquer insert
  na ponte e grava em **`op_relacionamento_espelho`** o que o card teria: CTRC, NF, unidade,
  oc, texto, **texto exato da 49**, motivo (justificativa da sugestão), sugestão de origem,
  origem (manual/auto), confiança, quem, quando e `card_previsto` (state/lock que
  `decidirNascimentoCard` daria, pagador, destinatário, cidade, instrução), com status
  `recebido_no_espelho`. O encaminhamento fica `espelhado`; o item fecha com motivo
  `encaminhado_espelho` e evento `EncaminhadoAoEspelho` ("encaminhada ao espelho do
  Relacionamento às HH:MM"). A prévia diz `modo: 'espelho'` e o destino "ESPELHO do
  Relacionamento".
- **O espelho não aparece no Relacionamento real**: nenhuma view/RPC/kanban de cards lê a
  tabela (teste SQL varre `pg_views` e `pg_proc`: só funções `op_*` a citam); RLS: só o
  gestor do Cockpit e o `supervisor_op` leem; escrita só por RPC. O teste SQL prova que o
  operador do Relacionamento e o operador da Operação não leem, e que `cards`,
  `card_events`, `todos` e `ponte_operacao_pedidos` ficam idênticos — com a flag da ponte
  LIGADA.
- **Leitura/treino** (página "Espelho do Relacionamento", o front faz depois):
  `op_espelho_relacionamento_listar(p_limite?, p_status?)` e
  `op_espelho_relacionamento_avaliar(p_espelho_id, p_teria_aceitado, p_motivo?)` (recusa
  exige motivo ≥ 5; grava quem avaliou). As avaliações são o gabarito para as regras
  aprendidas e os evals (`--casos`).
- **Materializador**: a nota que foi ao espelho continua com a Operação no Bastão; para não
  voltar e ser re-encaminhada em loop, `op_ctrcs_no_espelho` (30 dias) a mantém fora da fila
  **na mesma oc**; oc nova = situação nova, ela volta.
- Passar para `'real'` = decisão do dono depois de ler o espelho (taxa de "teria aceitado"),
  pelo trilho, com os passos 11–12 de "Como ligar".

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
| `operacao_sugestao_ia` (mig 434) | o agente de IA (D10) | nenhuma chamada à Anthropic; só regras |
| `operacao_encaminhar_auto` (mig 436) | o agendamento automático de encaminhamento (D11) | encaminhar só pelo clique |
| `ponte_operacao_pedidos` (mig 418, da ponte) | o envio do encaminhamento (D11) | `encaminhar_desligado`; agendados esperam e expiram em 24 h |

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
| `rpc('op_previa_encaminhamento', {p_op_item_id, p_texto?})` (D11) | `{ok:true, texto, confirmacao, previa:{op_item_id, ctrc, nf, unidade, oc_atual, destino, texto, codigo_oc_ssw:49, texto_ssw_49, observacao}}` ou `{ok:false, erro, motivo}` |
| `rpc('op_encaminhar_relacionamento', {p_op_item_id, p_texto, p_confirmacao})` | `{ok:true, encaminhamento_id, status:'enviado', previa}` ou `{ok:false, erro, motivo}` |
| `rpc('op_desfazer_encaminhamento', {p_encaminhamento_id})` | `{ok, encaminhamento_id, status:'desfeito'}` ou `{ok:false, erro:'ja_enviado'\|…}` |
| `rpc('op_encaminhamentos_do_item', {p_op_item_id})` | `{ok, encaminhamentos:[{id, status, origem, texto, confianca, executar_apos, solicitado_por_nome, enviado_em, motivo_fim, created_at, pedido_status, pedido_resultado, ocorrencia_lancada}]}` |
| `op_v_fila` (recriada na 436) | + `encaminhamento_id, encaminhamento_origem, encaminhamento_executar_apos, encaminhamento_texto` (só o **agendado**: aviso "será encaminhada às HH:MM — Desfazer") |

Erros possíveis (`erro`): `nao_e_membro_da_operacao`, `lancamento_desligado`,
`tela_desligada`, `sem_permissao_de_lancar`, `item_fechado`, `fora_da_sua_unidade`,
`assumido_por_outro`, `tratativa_aberta_no_relacionamento`, `nota_finalizada`,
`sem_nf_para_tripe`, `codigo_proibido`, `codigo_nao_permitido`, `texto_obrigatorio`,
`texto_longo`, `ja_e_a_ultima_oc`, `lancamento_em_andamento`, `previa_desatualizada`,
`sem_sugestao`, `nao_e_seu`, `ja_saiu_da_fila`, `nao_encontrado`; e da D11:
`encaminhar_desligado`, `nota_em_extravio`, `encaminhamento_em_andamento`,
`sugestao_e_encaminhamento`, `ja_enviado`, `nao_enviado`; e da D12: `sem_acesso_ao_espelho`,
`decisao_obrigatoria`, `motivo_obrigatorio`; e da emenda do treino real: `sugestao_e_aguardar`. Em modo espelho, `op_encaminhar_relacionamento`
devolve `{ok:true, encaminhamento_id, status:'espelhado', modo:'espelho', previa}`.

| Chamada (D12, gestor ou supervisor_op) | Retorno |
|---|---|
| `rpc('op_espelho_relacionamento_listar', {p_limite?, p_status?})` | `{ok, modo, itens:[{id, ctrc, nf, unidade, oc_base, descricao_oc, texto, texto_49, motivo, origem, confianca, sugestao, solicitado_por_nome, recebido_em, card_previsto, status, teria_aceitado, avaliacao_motivo, avaliado_por_nome, avaliado_em}]}` |
| `rpc('op_espelho_relacionamento_avaliar', {p_espelho_id, p_teria_aceitado, p_motivo?})` | `{ok, id, status:'avaliado', teria_aceitado}` ou `{ok:false, erro}` |

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

### Ligar as sugestões do agente e o encaminhamento (D10/D11), depois do passo 6

7. **Migs 434, 435** (TIPO B, inertes); a **439** logo depois da 436 (aguardar, 01, estado
   com instrução/pagador). **Mig 436** exige a **418** aplicada (é o pedido
   da ponte) — se a ponte ainda não estiver no ar, aplicar a 418 inerte antes.
8. Carga das regras aprendidas: migration TIPO B gerada de `regras.json` (validada por
   `validarRegrasAprendidas`). Sem ela, tudo cai no agente.
9. Deploy de `sugerir-operacao` e do `materializar-fila-operacao` novo; **mig 437** +
   pulso (INV-156). Com as flags OFF a edge só promove agendados (nenhum).
10. Rodar `evals/agente-operacao.ts --ao-vivo` com a chave de evals (≤ 50 casos sem
    confirmação de custo) e, se houver export, `--casos reais.jsonl`. Ligar
    `operacao_sugestao_ia` e acompanhar `op_sugestao_ia_cache` (status, tokens) na primeira
    hora. Secret: `ANTHROPIC_API_KEY` já existe nas edges; `OPERACAO_AGENTE_MODELO`
    opcional.
11. **Mig 438**: o encaminhamento vai ao ESPELHO (D12) — sem ponte, sem card, sem 49.
    Encaminhar pelo clique já funciona assim, com `operacao_tela` ON. Só para o modo
    `'real'` (TIPO B autorizada): precisa de `ponte_operacao_pedidos` ON e do cron 419
    (worker da ponte). Testar num CTRC conhecido: o card nasce em AVH com lock, a Operação
    vê só "encaminhada às HH:MM". A 49 só sai com `ponte_operacao_lancar_ssw` ON.
12. `operacao_encaminhar_auto` só depois de medir a taxa de acerto das sugestões de
    encaminhamento aceitas pelo clique (decisão do dono, com limiar escrito).

## Como desligar

- Na hora, sem deploy: `operacao_lancar_ssw` OFF (relida antes de cada lançamento; a
  fila espera e expira em 4 h), `operacao_tela` OFF, `operacao_fila` OFF,
  `operacao_sugestao_ia` OFF (nenhuma chamada nova; as sugestões gravadas ficam até a oc
  mudar), `operacao_encaminhar_auto` OFF (agendados ainda podem ser desfeitos; os vencidos
  são enviados — para segurar tudo, `ponte_operacao_pedidos` OFF).
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
- **Dono (D10/D11):** a carga das regras aprendidas (regras.json → migration TIPO B); o
  modelo do agente; ligar `operacao_sugestao_ia`; o limiar e a janela do encaminhamento
  automático, e se `operacao_encaminhar_auto` liga (exceção à 0039 D2).

## Consequências e riscos

- **Bastão:** a leitura da Operação é maior que a do Relacionamento (toda pendência com
  a Operação). Paginação de 1000, teto 50 mil linhas; rodada a cada 10 min. Medir o tempo
  da primeira rodada antes de encurtar o intervalo.
- **Vazão compartilhada:** a Operação conta as reservas da ponte; a RPC da ponte (mig
  418) ainda **não** conta as da Operação. Pior caso, com as duas portas ativas no mesmo
  minuto: 3 da ponte + o que sobrar para a Operação ≤ 3 → até 6/min se a ponte reservar
  depois. Correção (dono da ponte): somar `op_lancamentos` na `ponte_operacao_reservar_lancamentos`.
- **INV-014/CONFLITOS:** o lançamento da Operação vai em `op_acoes_executadas_ssw`, não em
  `acoes_executadas_ssw`. Como só acontece em CTRC sem card ativo, não há card para cair
  em CONFLITOS. Se um card nascer depois sobre esse CTRC, a oc aparece como "de fora";
  avaliar ler `op_acoes_executadas_ssw` no detector antes de ligar o lançamento.
- **Locks da 431:** CREATE POLICY em tabela quente; `lock_timeout` 5 s.
- **Typecheck:** `deno check` das edges novas acusa 9 erros **pré-existentes** em
  `lancar-ssw-portal.ts`/`validar-tripe-ssw.ts` (pinados; a ponte tem os mesmos).
