# Indicadores dos agentes — I1 (sugestão seguida) e I2 (entrada sem sugestão)

Caio, 06/10/2026. Dono da melhoria: **Duilio**. Fonte executável:
`scripts/sql/indicadores_agentes.sql` (só leitura, roda com `leitura_duilio`).

Dois objetivos, dois indicadores. Cada um com unidade, escopo, o que entra, o
que fica fora — pra que "melhorou" signifique a mesma coisa pra todo mundo.

---

## I1 — % de sugestões seguidas

**Pergunta:** quando o agente sugeriu, o operador fez o que ele sugeriu?

| Regra | Definição |
|---|---|
| **Unidade** | a **SUGESTÃO**, não o card. Um card recebe várias sugestões ao longo do ciclo (INV-168: cada entrada nova re-analisa) e **cada uma conta**. |
| **Sugestão** | um evento `AgenteOcsPadraoDecisao` (agente-padrão, ocs 10/11/19/35/49) ou `AgenteOc13Decisao` (oc 13). Uma rodada do agente = uma sugestão. |
| **Par** | a **1ª `AprovacaoOperador` depois da sugestão e antes da sugestão seguinte** do mesmo card. É o que o operador fez *tendo aquela sugestão na tela*. |
| **Seguida** | oc aprovada == oc proposta (`proposta_destacada`). |
| **Corrigida** | oc aprovada ≠ oc proposta. O operador é o gabarito (definição canônica de 13/08). |
| **%** | seguidas ÷ (seguidas + corrigidas). |
| **Fora do %, mas contadas** | **abstenção do agente** (rodou e não propôs — `proposta_destacada` nulo); **superada** (veio sugestão nova ou o card saiu antes de qualquer ação). |
| **Fonte da ação** | `proposta_payload` da aprovação (`args.codigo_ssw` → `args.codigo_ocorrencia` → `acao_key`). Cobertura: 8.718 de 8.731 aprovações em setembro (99,85%). |
| **Fora do escopo (por ora)** | interpretador de resposta do cliente (54/59) — sugere a cada mensagem, precisa de régua própria (I1b, a definir); agentes autônomos (49 extravio, 43) — executam, não sugerem. |

### Por que NÃO usar o placar oficial (`agent_feedback`) pra este indicador

A RPC `registrar_feedback_ocs_padrao_implicito` grava o par com idempotência por
**(card, oc do card, oc sugerida)** — não por decisão. Se o card volta na mesma
oc, o agente sugere a mesma coisa e o operador agora faz **diferente**, o 2º par
é descartado. Evidência (setembro): 391 cards tiveram ≥2 pares reais (894 pares);
o placar gravou 593 — **301 perdidos (34%)**. Caso NF 7481: 10/09 sugeriu 44 →
operador lançou 21; 11/09 sugeriu 44 → operador lançou 54; placar contou **uma**
correção. Resultado: o placar oficial roda ~8 pontos **otimista** (ver tabela).
Corrigir a RPC pra discriminar por ciclo é melhoria pendente (ver "Próximos passos").

### Como está (jul → out/2026)

| Mês | Sugestões emitidas | Abstenção do agente | Pares | Seguidas | Corrigidas | **% seguida (I1)** | Superadas sem ação | Placar oficial (otimista) |
|---|---|---|---|---|---|---|---|---|
| Jul | 3.650 | 838 | 2.236 | 1.509 | 727 | **67,5%** | 576 | 75,0% |
| Ago | 5.048 | 1.424 | 2.753 | 1.943 | 810 | **70,6%** | 871 | 78,9% |
| Set | 5.026 | 953 | 2.874 | 1.972 | 902 | **68,6%** | 1.199 | 76,7% |
| Out (1–5) | 836 | 165 | 423 | 283 | 140 | **66,9%** | 248 | 75,4% |

Linha de base pra mirar: **~68–70%**. Meta é do Caio/Duilio; o número é este.

**Onde o operador corrige (3 meses, por sugestão):** 54→44 (372), 54→55 (323),
56→54 (270), 54→21 (234), 54→56 (229), 21→54 (147), 59→33 (145), 59→54 (109).
A oc **54 sugerida indevidamente** é o maior bolsão: o operador troca por 44
(devolução), 55, 21 ou 56. Segundo: **56↔54** nos dois sentidos (o agente não
distingue bem "aguardando cliente" de "cliente já respondeu").

---

## I2 — % de entradas sem sugestão nenhuma

**Pergunta:** o card entrou em tratativa numa oc que o agente **deveria** analisar
— e ficou sem sugestão?

| Regra | Definição |
|---|---|
| **Unidade** | a **ENTRADA** do card (não o card): cada evento de `EVENTOS_NOVA_ENTRADA` (`BastaoCardImportado`, `CardReaberto`, `BastaoReabriuNFFonteRelacionamento`, `CardReabertoPorRespostaCliente`, `AgenteExtravioLancou49`, `AguardandoClienteOcMudou`, `OcComRegraChegouEmParaFazer`) com a oc **daquele momento** (vem no payload). "Nascer" = entrar. |
| **Escopo** | só entradas em oc **com agente de sugestão hoje**: 10, 11, 19, 35, 49 (padrão) e 13. |
| **Teve sugestão** | `AgenteOcsPadraoDecisao` com `proposta_destacada` ou `AgenteOc13Decisao` entre a entrada e a entrada seguinte (teto 48h). |
| **Sem sugestão — 4 classes** | **abstenção** (agente rodou e não propôs; na 49 = `caso_oc49: nao_reconhecido`, confiança 0); **falhou** (`AgenteOcsPadraoFalhou`); **suprimida sem evidência** (`SugestaoSuprimidaSemEvidencia`, INV-111 — correta por regra); **não rodou** (nenhum evento do agente). |
| **Agravante** | `sem_sugestao_e_operador_agiu`: o operador decidiu **às cegas**. É o subconjunto que dói. |
| **Fora do escopo (medido à parte)** | ocs com menu (`REGRAS_AUTO_ACAO`) mas **sem agente**: 20, 57, 8, 23, 26, 3, 17; 54/59 fora de resposta do cliente; 43 (autônoma). Essas entradas **não** contam como falha — contam como **backlog de regras**. Pra "zerar" de verdade, o backlog precisa virar escopo. |

**Distinção que importa:** "ter opções" ≠ "ter sugestão". `REGRAS_AUTO_ACAO`
cria as **opções** (todos) pra 8/10/11/13/19/20/23/26/35/43/49/54 — é o menu.
**Sugestão** é o agente de IA destacar uma opção (⭐). A oc 20 tem menu e não tem
agente: por isso fica fora do I2 e dentro do backlog.

### Como está (jul → out/2026)

| Mês | Entradas no escopo | Com sugestão | **% sem sugestão (I2)** | Abstenção | Falhou | Suprimida | Não rodou | Operador agiu sem sugestão |
|---|---|---|---|---|---|---|---|---|
| Jul | 2.451 | 1.727 | **29,5%** | 494 | 0 | 0 | 230 | 635 |
| Ago | 4.320 | 2.791 | **35,4%** | 966 | 0 | 2 | 561 | 1.121 |
| Set | 4.911 | 3.397 | **30,8%** | 748 | 2 | 3 | 761 | 1.186 |
| Out (1–5) | 763 | 571 | **25,2%** | 138 | 0 | 0 | 54 | 135 |

Outubro é pós-INV-168 (sugestão por entrada, em prod desde 05/10) — 5 dias,
ainda não é tendência. Contraprova do INV-168 = este número cair de forma
sustentada em outubro inteiro.

**Por oc (set + out):**

| oc | Entradas | % sem sugestão | Abstenção | Não rodou | Leitura |
|---|---|---|---|---|---|
| **49** | 2.863 | **48,2%** | 885 | 492 | o agente da 49 só reconhece 3 casos (extravio / cobrança retorno / devolução pós-56); **903 abstenções em set = `nao_reconhecido`**. É o maior alvo. |
| **13** | 292 | **45,5%** | 0 | 133 | o agente da 13 não roda em metade das entradas — investigar gatilho (foto? estado?). |
| 10 | 1.177 | 9,4% | 0 | 108 | |
| 19 | 402 | 6,7% | 0 | 27 | |
| 11 | 745 | 6,3% | 1 | 46 | |
| 35 | 195 | 4,6% | 0 | 9 | |

Sem a 49 e a 13, o I2 das ocs-núcleo (10/11/19/35) está em **~7–9%** — o
problema é concentrado, não difuso.

**Backlog (entradas em set em oc sem agente):** 20 → 2.695 · 57 → 2.134 ·
8 → 1.568 · 54 → 1.281 · 59 → 1.062 · 43 → 954 · 23 → 179 · 26 → 64. A oc 20
sozinha é mais entrada que 10+11+19+35 juntas.

---

## Como monitorar

- **Hoje:** `python3 scripts/dbq.py -f scripts/sql/indicadores_agentes.sql`
  (3 meses, ~6 min; o `SET statement_timeout` no topo é permitido ao role de
  leitura). Saída: I2 por mês e por oc, I1 por mês e por agente, top trocas.
- **Próximos passos (não feitos — precisam de OK do Caio, são migration):**
  1. **Corrigir a idempotência da RPC implícita** pra discriminar por ciclo/sugestão
     (hoje perde ~1/3 dos pares em cards com 2+ ciclos). Até lá o placar oficial
     e o painel que lê `agent_feedback` ficam ~8 pts otimistas.
  2. **Materializar I1/I2 por dia** (tabela alimentada por cron) pra virar painel
     sem a query de 6 min; o front lê a tabela.
  3. **Guard no `/verify-cockpit`**: a lista de ocs do escopo (10/11/19/35/49/13)
     neste arquivo e no script tem que bater com o escopo real do agente-padrão
     (`registrar_feedback_ocs_padrao_implicito` e processador) — ampliou um,
     amplia os três.

## Ressalvas honestas

- "Corrigida" = divergiu do humano. O humano erra também; o indicador mede
  **aderência**, não acerto absoluto.
- I1 ignora o interpretador (54/59). Ele é ~40% dos pares do placar antigo e tem
  aderência menor (62% em set) — precisa de régua própria antes de entrar.
- I2 usa teto de 48h entre entrada e sugestão. Cards que ficam dias parados e
  recebem sugestão depois contam como "sem sugestão" naquela entrada.
- Janela = mês da sugestão/entrada (horário de Brasília), não do card.
