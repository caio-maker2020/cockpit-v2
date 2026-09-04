# ADR 0025 — Ocorrência 55 automática para clientes com autorização permanente de seguir parcial

Data: 2026-09-03
Status: aceito (F1–F6 na branch `feature/55-automatica-duilio-felipe`; lançamento real só após shadow da F7)
Autor da regra: Caio (briefing `55_EXTRAVIOS E AVARIAS.txt`, 2026-09-03)

## Contexto

Alguns clientes autorizam, **em cadastro e de forma permanente**, que a carga siga para
entrega mesmo havendo **avaria (oc 08)** ou **extravio parcial (oc 06)**. Hoje o Cockpit
trata todos os clientes igual: pergunta antes de seguir.

O custo disso, medido em produção nos 4 CNPJs do escopo (F0, 2026-09-03):

- **oc 06** → card nasce em `EXTRAVIO_MONITORADO` com 5 propostas pendentes e fica parado
  até o operador agir ou até o `agente-extravio-d4` lançar a 49 no D+2 (FELIPE) / D+4 (DUILIO).
- **oc 08** → `REGRAS_AUTO_ACAO[8]` põe o card em `AGUARDANDO_VALIDACAO_HUMANA` + lock com
  4 propostas manuais. O rationale da regra diz textualmente *"Sem decisão automática"*.
- Havia **38 cards** desses clientes parados em `AGUARDANDO_CLIENTE` (54/59) no momento da
  medição — parte deles perguntando exatamente o que o cliente já autorizou em cadastro.

Ou seja: o fluxo trava perguntando algo cuja resposta já é conhecida.

## Decisão

Para uma **whitelist explícita de CNPJs**, o Cockpit lança a **oc 55** ("Autorizado para
seguir pra entrega / entrega parcial") de forma autônoma, sem perguntar ao cliente e sem
esperar o operador.

### Escopo (fechado)

| Gatilho | Condição | Ação |
|---|---|---|
| oc 06 | **sem sinal de extravio total** | lança **55** |
| oc 06 | **com sinal de extravio total** | fluxo atual (49) — **não** lança 55 |
| oc 08 | sempre | lança **55** |

CNPJs (Caio, 03/09) — carteira confirmada em produção na F0:

| CNPJ | Cliente | Operador |
|---|---|---|
| 13309775000195 | TOTALL DISTRIBUIDORA ATACADIST | DUILIO |
| 04098359000366 | GMI DISTRIBUIDORA LTDA | FELIPE |
| 04098359000102 | GMI DISTRIBUIDORA LTDA | FELIPE |
| 26013236000156 | DISTRIB MINEIRA DE FILTROS AUT | FELIPE |

### D1 — A chave é o CNPJ, não o operador

A autorização é do **cliente**. Se o cliente for remanejado de carteira
(`remanejar_cliente_operador`, mig 360) a regra vai junto. Cliente novo exige INSERT
explícito na tabela — nunca entra por herdar carteira de operador.

### D2 — "Sinal de extravio total" são DUAS condições, não uma

O briefing diz: *"se não conter extravio total na mensagem, será considerado parcial"*.
Aplicar isso ao pé da letra **classificaria errado 4 dos 23 cards de oc 06** da janela
medida (17%) — e 9 de 29 somando 06/09/16.

Motivo: a unidade frequentemente escreve **só o número de volumes faltantes**, sem a
palavra TOTAL. Quando esse número **é igual ao total de volumes da NF**, o extravio é
total, escrito como número. Casos reais colhidos na F0:

| NF | Instrução | Volumes da NF | Realidade |
|---|---|---|---|
| 29642 | `9` | 9 | extravio TOTAL |
| 29405 | `7 (SSWMOBILE)` | 7 | extravio TOTAL |
| 242255 | `3` | 3 | extravio TOTAL |
| 199462 | `2` | 2 | extravio TOTAL |
| 193347 | `1 (SSWMOBILE)` | 1 | extravio TOTAL |

Sob a regra literal, a NF 29642 (9 volumes, 9 extraviados) receberia uma 55 mandando a
operação "seguir a entrega" de uma carga que não existe mais.

**Portanto há sinal de extravio total quando QUALQUER uma for verdadeira:**

1. a mensagem contém `EXTRAVIO TOTAL` / `PERDA TOTAL` / `FALTA TOTAL` / `TOTAL`; **ou**
2. a quantidade lida na mensagem **>= a quantidade de volumes da NF**.

Isso preserva a intenção do briefing ("não alterar o fluxo atual de extravio total") e
mantém a inversão pedida apenas onde ela é segura.

### D2b — A leitura da quantidade passa pela limpeza FORTE (achado 03/09, tarde)

Descoberto ao auditar a terceira cópia do parser para decidir se dava pra consolidar.
As duas leituras **não são equivalentes**:

| | limpa o quê | quem usa |
|---|---|---|
| `limparInstrucao` (em `extravio-qtd-volumes`) | só `(SSWMOBILE)`, `GPS(...)`, `GPS` | `analisarExtravio` |
| `removerMarcadoresSswmobile` | tudo acima **+ comentários e tags HTML** (via `sanitizarTextoSsw`) **+** `Protocolo: N`, `SEFAZ-XX`, `cte.fazenda.gov.br` | `agente-sugere-ocs-padrao` |

O portal SSW devolve HTML inline na instrução — caso de produção **NF 1494821**:
`<!--...--><a href=# class=sra onclick=showMapaVeic(...)><u>GPS</u></a>`.

Medição direta:

| instrução | limpeza fraca | limpeza forte |
|---|---|---|
| `9 <!--x--><u>GPS</u>` | `null` | `{qtd:9}` |
| `5 Protocolo: 12345` | `null` | `{qtd:5}` |
| `5 SEFAZ-MG` | `null` | `{qtd:5}` |
| `1 V` | `null` | `null` |
| `F1 (SSWMOBILE)` | `null` | `null` |

Numa NF de 9 volumes, a leitura fraca devolve `null` → o D3 lê "ilegível" → **parcial** →
lança 55 num extravio **TOTAL**. É precisamente o modo de falha que o D2 existe pra impedir.

A assimetria é o ponto: `null` é **inofensivo** em `analisarExtravio` (lá `isTotal = !qtd`,
ou seja, nulo vira TOTAL — conservador) e **perigoso** aqui, porque o D3 inverte o default.
A mesma fraqueza muda de sinal ao mudar de contexto.

**Fix:** `lerQtdDaInstrucao()` aplica `removerMarcadoresSswmobile` antes do parser,
**só dentro de `seguir-parcial-auto.ts`**. `limparInstrucao` **não** foi tocado — ele serve
`analisarExtravio`, que roda para todos os 651 clientes, e mexer lá violaria a premissa
"nenhum outro cliente muda de comportamento". A limpeza forte não rouba os casos legítimos
do D3: `1 V`, `F1 (SSWMOBILE)` e `1 PROVAVELMENTE ERRO...` seguem ilegíveis e seguem parciais.

**Consolidar as três cópias continua descartado.** Provado agora que elas divergem: trocar
o forte pelo fraco em `agente-sugere-ocs-padrao` (ou o contrário em `extravio-qtd-volumes`)
mudaria classificação de total×parcial para todos os clientes — fora do escopo deste ADR.

### D3 — Ausência de informação legível = PARCIAL (só dentro da whitelist)

Hoje `analisarExtravio` (`_shared/extravio-enrichment.ts`) faz `const isTotal = !qtd || ...`
— mensagem ilegível vira TOTAL. Dentro da whitelist isso se inverte: ilegível → parcial → 55.
**Fora da whitelist o default TOTAL continua intacto**, para todos os clientes.

Casos reais que a F0 mostrou nessa faixa: `1 V` (NF de 6 volumes), `F1 (SSWMOBILE)`
(7 volumes) e `1 PROVAVELMENTE ERRO NO CARREGAMENTO OS 2 ESTAVA AQUI NA SEXTA` (2 volumes)
— todos parciais de verdade que o parser atual não consegue ler. A F4 ensina o parser a ler
esses formatos; o default invertido é a rede, não a estratégia.

### D4 — Autonomia total, sem janela de veto

Decisão do Caio (03/09). Não usa o trilho do ADR 0016 (janela de 60 min úteis) porque ele
atrasaria justamente o destravamento — e porque o DUILIO não está no piloto de veto.
Compensações obrigatórias: modo shadow antes de ligar (F7), flag master OFF por default,
ativação 1 CNPJ por vez, e pré-checagem SSW em todo lançamento.

### D5 — Pós-55 não abre trilha paralela

Decisão do Caio (03/09): o fluxo segue normal. Na entrega o cliente ressalva e a unidade
lança **19 / 10 / 35**, que reentram no Cockpit pelo caminho já existente
(`REGRAS_AUTO_ACAO` cobre as três; `uniq_cards_nf_active` exclui `TRANSFERIDO` desde a
mig 030, então a NF pode gerar card novo). O Cockpit **não** abre 33/49/59 por conta própria.

### D6 — A oc 55 passa a contar como "cliente ciente" após extravio

Consequência direta de D5, e correção de um bug latente.

`OCS_NOTIFICOU_APOS_EXTRAVIO = {20, 54, 59, 49}` em `_shared/recusa-por-extravio.ts`
**não inclui a 55**. Sem consertar isso, o card que volta com 19/10/35 dispararia
`recusaOriginadaDeExtravioNaoNotificada()` e o `agente-sugere-ocs-padrao` mostraria ao
operador o banner *"cliente ainda não notificado do extravio"* — falso para quem autorizou
em cadastro.

Isso também fecha uma divergência que **já existe hoje** entre dois módulos:
`_shared/extravio-parcial-regra.ts` tem `houve55AposExtravio()` documentada como *"sinal
objetivo de autorização prévia"*, enquanto `recusa-por-extravio.ts` ignora a 55. Os dois
discordam sobre o que a 55 significa.

Nesta rodada a correção entra **gated pela whitelist**. Generalizar para todos os clientes
é decisão separada do Caio.

### D7 — A regra R3 anti-veto (ADR 0022) cede à autorização em cadastro

`decidirParcialSemAutorizacao()` força "54 perguntando se pode seguir parcial ou devolver"
quando não há autorização no ciclo. Para CNPJ na whitelist a autorização é permanente:
a R3 não pergunta.

## Premissas assumidas (não estavam no briefing)

| Item | Assumido | Reversível? |
|---|---|---|
| Campo do CNPJ | `cnpj_pagador`, com match adicional em `cnpj_remetente` | sim, config |
| oc 09 e 16 | **fora do escopo** — só 06 | sim, config |
| oc 03 e 17 | **fora do escopo** — só 08 | sim, config |
| Retroativo | **não** até ordem explícita (é TIPO B) | — |
| Horário | 8h–17h30 BRT, seg–sex | sim, config |
| E-mail ao cliente | **não envia**; registra `card_event` | sim |
| Texto da Instrução SSW | `AUTORIZACAO PERMANENTE EM CADASTRO - SEGUIR PARCIAL` | sim |
| Front / UI | nada nesta rodada | — |

Nota da F0: existiam **8 cards ativos** desses clientes em `EXTRAVIO_MONITORADO` no momento
da medição (6 com oc 06, 2 com oc 09). Nenhum será tocado sem ordem de retroativo.

## Consequências

**Positivas:** ~23 cards de oc 06 e ~20 de oc 08 por semestre deixam de travar; a
divergência D6 entre dois módulos é fechada; a exceção fica auditável numa tabela própria,
no molde da `cliente_config_oc13`.

**Negativas / riscos aceitos:**

- Ocorrência lançada no SSW **não tem desfazer**. Mitigado por shadow + pré-checagem SSW +
  ativação gradual.
- O parser de quantidade continua imperfeito. Mitigado por D2 (a cerca que importa é
  `qtd >= volumes`, não a leitura fina) e pela suíte `extravio-qtd-volumes.test.ts`, criada na F4 — o parser rodou desde o ADR 0012 sem teste nenhum.
- Ligar os 4 CNPJs de uma vez geraria rajada — daí a ativação 1 a 1 (precedente: a mig 313
  avisou desse mesmo efeito ao ligar o FELIPE em D2).

## Guards anti-regressão

- **INV-141** — fora da whitelist, `analisarExtravio` mantém o default TOTAL; e a leitura da
  quantidade passa pela limpeza forte (`removerMarcadoresSswmobile`), nunca pela crua.
- **INV-142** — flag master e linhas da tabela nascem OFF / inativas.
- **INV-143** — `OCS_NOTIFICOU_APOS_EXTRAVIO` contém 55 (protege D6).
- Suíte `seguir-parcial-auto.test.ts` + testes de congelamento de `analisarExtravio`.
- Itens no `/verify-cockpit`, dentro da cerca de bloco de código da Fase 8.
- **Guards de deploy** em `.claude/deploy-guards.json` para os 3 arquivos da regra
  (`seguir-parcial-auto.ts`, `seguir-parcial-carregar.ts`, `agente-seguir-parcial-auto/index.ts`)
  — nenhum deles tinha proteção do deploy-gate até 03/09.

## Verificação executada (2026-09-03)

Deno instalado nesta máquina (`deno-portable/bin`, v2.9.6, no PATH do usuário — mesmo padrão do
`nodejs-portable` já existente), então as suítes canônicas rodaram de verdade.

**Suítes novas do projeto** — `seguir-parcial-auto`, `extravio-qtd-volumes`,
`seguir-parcial-carregar`: **36 passed, 0 failed**.

**Suítes pré-existentes que este trabalho tocou** — `recusa-por-extravio`,
`extravio-parcial-regra`, `recusa-parcial-precede-extravio`: **34 passed, 0 failed**.

**Regressão, medida contra a master limpa (`fdb4091`) num worktree separado:**

| `deno test supabase/functions/_shared/` | master | branch |
|---|---|---|
| passed | 1064 | 1108 (+44) |
| failed | 2 | 2 |
| quais | `regras-auto-acao.sem-email-54`, `tools-registrados-no-front` | as mesmas duas |

As 2 falhas são **pré-existentes na master** e não têm relação com este projeto — nenhum dos
dois arquivos, nem o módulo que eles testam, foi tocado aqui.

**Type check (`deno check`):** os 7 arquivos novos/movidos passam limpos. Os 2 arquivos grandes
editados (`agente-sugere-ocs-padrao`, `interpretador-resposta-cliente`) acusam 7 erros — as
**mesmas 7 mensagens, idênticas, na master limpa** (genéricos de `SupabaseClient` e `SswFoto`,
dívida antiga). Diff entre as duas listas: só o deslocamento de linha das inserções (+4 do
import, +7 do primeiro call site). **Nenhum erro de tipo novo.**

**Pendente antes do merge:** `/verify-cockpit` completo (advisors e estado de deploy pedem
acesso que não se resolve só com o Deno).

## Como aplicar a F7 (shadow) — ordem e pré-requisitos

Levantado em 03/09 ao preparar a aplicação. **Nada disso foi executado.**

**Ordem obrigatória** (a inversa quebra):

1. **mig 379** — tabela + flag mestra OFF + 4 CNPJs inativos. Não cria cron; pode ir antes do deploy.
2. **Deploy** de `agente-seguir-parcial-auto` (Supabase CLI — não está na máquina do Carlos).
3. **mig 380** — flag sombra + cron de 15 min. **Depois** do deploy: aplicada antes, o cron bate numa função inexistente a cada 15 min.
4. Ligar `seguir_parcial_auto_enabled` e **1 CNPJ** (`ativo=true`). Só aqui a sombra começa a produzir dados. Com a whitelist vazia de ativos o agente nem varre cards — o SELECT filtra por CNPJ ativo.

**As duas migrations são TIPO B**, não TIPO A como o cabeçalho original dizia:

| mig | motivo do classificador | risco real |
|---|---|---|
| 379 | `DROP de objeto` (`DROP TRIGGER/POLICY IF EXISTS`) | zero — objetos criados na própria migration, padrão drop-then-create |
| 380 | `cron.unschedule` | zero — guardado por `EXISTS`, idempotência |
| 380 | **`flag nascendo LIGADA`** | **legítimo** — a sombra nasce `true`; só é seguro porque a semântica é invertida (ON = não lança) |

Logo, exigem `--autorizado-por` declarado. A política também exige o commit **no master** antes de aplicar (produção nunca à frente do git).

**Pré-voo já executado (03/09):** dependências conferidas em produção — `public.set_updated_at()`, `public.feature_flags` (com unique em `key`), `pg_cron`, `pg_net` e o secret `cron_sync_bastao_key` **existem**; nada do projeto existe ainda no banco. **Dry-run (`BEGIN...ROLLBACK`) das duas rodou limpo contra produção**, smoke tests inline inclusive, e a verificação pós-rollback confirmou que nada persistiu.

**Dois buracos do trilho achados no caminho** (`scripts/dbq.py`, não corrigidos — são trilho compartilhado):
- `tem_commit_interno` só é checado dentro de `if dry_run:`. A **aplicação real não recusa** COMMIT interno — o trilho bloqueia o passo seguro e libera o perigoso.
- Com `--dry-run`, o ramo `if tipo == "B" and not dry_run` é pulado e o `elif tipo == "A"` não dispara: o dry-run de uma migration TIPO B **não imprime classificação nenhuma**. O silêncio é indistinguível de "sem problema" — foi o que quase me fez concluir TIPO A.

## Alternativas descartadas

- **Janela de veto (ADR 0016):** atrasa o destravamento; DUILIO fora do piloto.
- **Autonomia por fatia (`autonomia-fatias.ts`):** `OCS_SEGURAS_AUTONOMIA` não inclui 55 e o
  cofre é por acurácia agente×oc, não por cliente — eixo errado para esta regra.
- **Inverter o default total/parcial globalmente:** blast radius alto; muda template de
  e-mail, escolha 54×59 e dossiê de todos os clientes.
- **Chavear por operador (carteira do DUILIO/FELIPE):** onboarding de cliente novo ligaria a
  automação sem ninguém decidir.

## Ensaio da F7 — verificação de 2026-09-04 e correção do CNPJ escolhido

O shadow foi ligado em 03/09 às 17:44 no CNPJ 13309775000195 (TOTALL / DUILIO), pela
mig 381. Verificação em produção em 04/09 às 09h: **rodando e vazio**.

**O que está provado (não inferido):**

- Infra saudável: flag mestra ON, sombra ON, cron `agente-seguir-parcial-auto` (job 60)
  a cada 15 min com todas as execuções `succeeded`, função `v1` deployada 03/09 17:40.
  Ciclos 08:00 a 09:00 devolveram `{"sombra":true,"candidatos":0}`.
- **A query de candidatos funciona.** Rodada via `deno` + supabase-js contra produção,
  igual ao agente: devolve 2 cards pro CNPJ 26013236000156 e 0 pro 13309775000195. O
  `.in("agent_state->>cnpj_pagador", ...)` (filtro em campo JSON via PostgREST) **não**
  é furo de sintaxe — hipótese levantada e DESCARTADA com evidência.
- **A decisão funciona.** `decidirSeguirParcialAuto` aprova os 2 cards reais
  (NF 196195 = 1 de 3 vol; NF 200776 = 2 de 9 vol) com
  `texto_ssw = "AUTORIZACAO PERMANENTE EM CADASTRO - SEGUIR PARCIAL"`.
- **O estado que o agente procura existe.** oc 8 realmente para em
  `AGUARDANDO_VALIDACAO_HUMANA`: 2 cards de outros clientes nesse estado no momento da
  medição, e a NF 197840 ficou 56 min lá antes da aprovação do operador.
- Zero `card_events` e zero `agent_runs` do agente. Ele não decidiu nada ainda.

**Causa do vazio:** falta de matéria-prima, não defeito. Os 2 cards de oc 6 do DUILIO que
a mig 381 contou (NF 116861 e 116870) foram levados a `TRANSFERIDO` pelo
`sync-extravios-bastao` às 17:20 de 03/09 — o Bastão já mostrava oc 14 "Entrega iniciada"
e oc 12 "Comprovante retido", a operação seguiu sozinha. Isso foi **24 min antes** da flag
ligar.

### O erro de método: escolher o 1º CNPJ por carteira em vez de por volume

Chegadas medidas em 120 dias (`card_events`, `TodoPropostoAutomaticamente` regra `oc=8` e
entrada em `EXTRAVIO_MONITORADO` para oc 6):

| CNPJ | operador | cards oc 8 | cards oc 6 | última oc 8 |
|---|---|---|---|---|
| 26013236000156 | FELIPE | 35 | 21 | 02/09 |
| 13309775000195 | DUILIO | 9 | 5 | **03/08** |
| 04098359000366 | FELIPE | 4 | 5 | 26/08 |
| 04098359000102 | FELIPE | 1 | 0 | 31/07 |

O DUILIO é o **menor volume dos 4** e não recebe card de oc 8 há um mês. Ligar o shadow
só nele mantinha o ensaio vazio por semanas.

**Regra que fica:** o 1º CNPJ de um rollout em sombra se escolhe por **volume de chegada
medido**, não por carteira, ordem alfabética ou quem pediu primeiro. Um ensaio que não
recebe caso não é ensaio conservador, é ensaio inútil — e o pior é que ele *parece* verde.

**Correção aplicada (mig 382):** troca, não soma. 13309775000195 sai, 26013236000156
entra. Segue com **exatamente 1 CNPJ ativo**, honrando ao pé da letra a compensação do D4
("ativação 1 CNPJ por vez"). O DUILIO volta no go-live real ou quando chegar card novo.

### Critério explícito para SAIR da sombra

Enquanto `seguir_parcial_auto_sombra` estiver ON o agente decide e registra, mas não
lança. Sair da sombra exige, cumulativamente:

1. **>= 5 decisões `SeguirParcialAutoSimulado`** conferidas uma a uma contra o card e o
   histórico do SSW, sem nenhum falso positivo (nenhuma 55 que não deveria ser lançada);
2. **>= 1 caso de extravio total corretamente barrado**, ou seja, um
   `SeguirParcialAutoNaoAplicou` com motivo de sinal de total — é a rede da F4, e ela
   precisa ter sido exercitada de verdade, não só em teste;
3. **linha de autorização no cabeçalho desta seção** com o marcador literal
   `SAIDA DA SOMBRA AUTORIZADA`, dizendo quem decidiu, quando e sob qual evidência.

O item 3 não é burocracia: sem ele a saída da sombra é **um `UPDATE` de uma linha** que
ninguém revisa e que muda o agente de "grava" para "lança no SSW", onde não há desfazer.
O guard **INV-145** do `/verify-cockpit` recusa `sombra=OFF` com a mestra ON enquanto esse
marcador não existir no ADR.

### Como medir a sombra (e como NÃO medir)

Nos 4 CNPJs, em 90 dias, houve 19 cards de oc 8: em **18** o operador lançou a 55 na mão e
em 1 lançou a 56 — a automação replica o que Duílio e Felipe já fazem. Mas o card fica em
`AGUARDANDO_VALIDACAO_HUMANA` de 3 a 848 min (mediana ~38; 5 de 18 em <= 10 min). Com cron
de 15 min o agente **perde a corrida** em parte dos casos e devolve `operador_antecipou`.

Logo: **não medir a sombra por contagem absoluta de decisões**. A métrica é "das decisões
que ele gravou, quantas estavam certas". Contagem baixa é esperada e não é sinal de falha.

## SAIDA DA SOMBRA AUTORIZADA — 2026-09-04, Carlos

**Quem decidiu:** Carlos Alexandre de Jesus Botelho, ordem literal no chat de 04/09:
*"quero que ele já rode e lance automaticamente, sem quebrar e regredir nada. somente
para os cnpj mencionados."* Autonomia: `docs/POLITICA_MIGRATIONS.md`, TIPO B —
"Ligar/desligar flags e degraus de automação", revisão de 02/09 ("Autonomia total").
Aplicado pela **mig 383**.

**O que muda:** `seguir_parcial_auto_sombra` vai a **false**. A partir do próximo ciclo
de 15 min o agente **LANÇA a oc 55 no SSW de verdade**, sem aprovação humana, nos cards
de oc 06 parcial e oc 08 dos CNPJs autorizados. Também ativa os **4 CNPJs** de uma vez.

### O que NÃO foi cumprido — registrado de propósito

Esta seção existe porque o **INV-145** exige o marcador literal do título pra deixar a
sombra ser desligada. O ponto do guard é não deixar a saída acontecer em silêncio. Então
fica escrito o que a régua desta ADR pedia e o que havia de fato:

| condição de saída (definida em 04/09) | exigido | havia |
|---|---|---|
| decisões simuladas conferidas sem falso positivo | >= 5 | **1** |
| >= 1 extravio TOTAL corretamente barrado | 1 | **0** |
| autorização escrita | 1 | 1 (esta seção) |

A única decisão simulada (NF 200776, 2 de 9 volumes) estava **correta**. A recusa do
mesmo ciclo (NF 196195) foi por **SSW divergente**, não por sinal de total — logo não
conta pra 2ª condição.

**Também supera a compensação do D4 "ativação 1 CNPJ por vez"**, ligando os 4 juntos.
Justificativa medida no dia: o universo elegível dos 4 CNPJs somava **3 cards**
(NF 117057 DUILIO, NF 196195 e NF 200776 FELIPE), então "4 CNPJs" não produz o efeito
rajada que o D4 temia — produz 3 cards. Medição, não suposição.

**Risco aceito, dito com clareza:** ocorrência lançada no SSW **não tem desfazer**. A
base de evidência é 1 decisão conferida, não 5. Se a regra errar, o erro é visível pro
cliente e pra operação. O Carlos foi informado disso antes de reafirmar a ordem.

### O que continua protegendo (verificado antes de ligar, não presumido)

Nada foi afrouxado pra ligar o lançamento real:

1. **Whitelist fechada.** A tabela tem exatamente 4 linhas, os 4 CNPJs mencionados
   (conferido: `total_na_tabela=4, dos_4_mencionados=4`). O filtro por CNPJ está no
   próprio SELECT do agente — cliente fora da lista nunca é lido. Atende ao "somente
   para os cnpj mencionados" **por construção**, não por promessa.
2. **Pré-checagem SSW obrigatória** (camada 6), no mesmo ciclo, antes de todo
   lançamento. Já exercitada em card REAL: barrou a NF 196195 porque o SSW mostrava
   `oc 1 ENTREGUE` de 10/08/26. Sem ela o agente lançaria 55 em carga entregue.
3. **Sinal de extravio total** (camada 4) em duas condições OU — palavra TOTAL, **ou**
   quantidade lida >= volumes da NF. Fail-closed quando a quantidade é legível mas os
   volumes da NF são desconhecidos.
4. **Idempotência** (camada 7) por `(card_id, codigo_oc, ctrc)`, mais o envelope
   `lancarSswPortal` com o **guard do tripé** CTRC+NF+Localização antes do submit.
5. **Horário comercial** (camada 5): 8h-17h30, seg-sex.
6. **Teto de 50 cards por ciclo** e orçamento de tempo de 110s.
7. **Sem e-mail:** o todo do agente carrega `enviar_email: false`. O cliente não é
   notificado, conforme o briefing ("sem perguntar, sem notificar").
8. **Texto correto no SSW** (conferido no código hoje): `extras.texto_descricao` entra
   em `montarDescricaoSsw` como texto livre e **substitui** a descrição base, então a
   oc 55 chega ao SSW com `AUTORIZACAO PERMANENTE EM CADASTRO - SEGUIR PARCIAL`.
   Confirmado que os 3 cards têm CTRC preenchido, senão o executor abortaria no guard
   do tripé.

### Kill-switch (efeito no próximo ciclo de 15 min, sem deploy)

Voltar pra sombra (volta a decidir e gravar, sem lançar):

    UPDATE public.feature_flags SET enabled = true
     WHERE key = 'seguir_parcial_auto_sombra';

Desligar o agente inteiro:

    UPDATE public.feature_flags SET enabled = false
     WHERE key = 'seguir_parcial_auto_enabled';

