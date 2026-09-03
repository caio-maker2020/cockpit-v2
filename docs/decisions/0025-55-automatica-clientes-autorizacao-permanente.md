# ADR 0025 — Ocorrência 55 automática para clientes com autorização permanente de seguir parcial

Data: 2026-09-03
Status: aceito (F1–F3 na branch `feature/55-automatica-seguir-parcial`; lançamento real só após shadow da F7)
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
  `qtd >= volumes`, não a leitura fina) e pela suíte de testes da F4, que hoje não existe.
- Ligar os 4 CNPJs de uma vez geraria rajada — daí a ativação 1 a 1 (precedente: a mig 313
  avisou desse mesmo efeito ao ligar o FELIPE em D2).

## Guards anti-regressão

- **INV-141** — fora da whitelist, `analisarExtravio` mantém o default TOTAL.
- **INV-142** — flag master e linhas da tabela nascem OFF / inativas.
- **INV-143** — `OCS_NOTIFICOU_APOS_EXTRAVIO` contém 55 (protege D6).
- Suíte `seguir-parcial-auto.test.ts` + testes de congelamento de `analisarExtravio`.
- Itens no `/verify-cockpit`, dentro da cerca de bloco de código da Fase 8.

## Alternativas descartadas

- **Janela de veto (ADR 0016):** atrasa o destravamento; DUILIO fora do piloto.
- **Autonomia por fatia (`autonomia-fatias.ts`):** `OCS_SEGURAS_AUTONOMIA` não inclui 55 e o
  cofre é por acurácia agente×oc, não por cliente — eixo errado para esta regra.
- **Inverter o default total/parcial globalmente:** blast radius alto; muda template de
  e-mail, escolha 54×59 e dossiê de todos os clientes.
- **Chavear por operador (carteira do DUILIO/FELIPE):** onboarding de cliente novo ligaria a
  automação sem ninguém decidir.
