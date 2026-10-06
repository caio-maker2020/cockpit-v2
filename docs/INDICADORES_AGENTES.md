# Indicadores dos agentes — I1 (sugestão seguida) e I2 (entrada sem sugestão)

Caio, 06/10/2026. Dono da melhoria: **Duilio**. Fonte executável:
`scripts/sql/indicadores_agentes.sql` (só leitura, roda com `leitura_duilio`).

Dois objetivos, dois indicadores. Cada um com unidade, escopo, o que entra, o
que fica fora — pra que "melhorou" signifique a mesma coisa pra todo mundo.

---

## I1 — % de sugestões seguidas

**Pergunta:** quando o agente sugeriu uma ação, o operador executou essa ação?

**Vocabulário (fixo):** *análise* = o agente rodou no card; *sugestão* = o agente
**propôs uma ação** (`proposta_destacada` preenchida). Análise que não propôs nada
**não é sugestão** — é "entrada sem sugestão" e vai pro I2.

| Regra | Definição |
|---|---|
| **Unidade** | a **SUGESTÃO**, não o card. Um card recebe várias sugestões ao longo do ciclo (INV-168: cada entrada nova re-analisa) e **cada uma conta**. |
| **Sugestão** | `AgenteOcsPadraoDecisao` com `proposta_destacada` (ocs 10/11/19/35/49) ou `AgenteOc13Decisao` (oc 13). |
| **Com ação** | a **1ª `AprovacaoOperador` depois da sugestão e antes da sugestão seguinte** do mesmo card. Sugestão sem ação até a próxima sugestão (ou até o card sair) fica **fora do %**. |
| **Seguida** | oc aprovada == oc sugerida. O operador é o gabarito (definição canônica de 13/08). |
| **I1** | seguidas ÷ com ação. |
| **Fonte da ação** | `proposta_payload` da aprovação (`args.codigo_ssw` → `args.codigo_ocorrencia` → `acao_key`). 8.718 de 8.731 aprovações em set (99,85%). |
| **Fora por ora** | interpretador de resposta do cliente (54/59) — régua própria a definir; agentes autônomos (49 extravio, 43) — executam, não sugerem. |

### Como está (jul → out/2026)

**Setembro: 4.073 sugestões → 2.874 tiveram ação do operador → 1.972 a ação foi
igual à sugestão → I1 = 68,6%.**

| Mês | Sugestões | Com ação do operador | Ação igual à sugestão | **I1** | Placar oficial (otimista) |
|---|---|---|---|---|---|
| Jul | 2.812 | 2.236 | 1.509 | **67,5%** | 75,0% |
| Ago | 3.624 | 2.753 | 1.943 | **70,6%** | 78,9% |
| Set | 4.073 | 2.874 | 1.972 | **68,6%** | 76,7% |
| Out (1–5) | 671 | 423 | 283 | **66,9%** | 75,4% |

Linha de base: **~68–70%**. Derivado útil: **% de sugestões que viraram ação**
= com ação ÷ sugestões (set: 70,6%); o resto (1.199 em set) o operador não agiu
antes de o agente sugerir de novo ou de o card sair.

**Onde o operador corrige (3 meses):** 54→44 (372), 54→55 (323), 56→54 (270),
54→21 (234), 54→56 (229), 21→54 (147), 59→33 (145), 59→54 (109). A oc **54
sugerida indevidamente** é o maior bolsão; depois a confusão **56↔54**.

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

A cadeia, em setembro, pra não deixar dúvida sobre a unidade: **5.026 sugestões**
emitidas (rodadas do agente, não cards) → 953 foram abstenção (agente rodou e
não propôs) → **4.073 com proposta** → dessas, **2.874 tiveram ação do operador**
antes da sugestão seguinte (os *pares*) e 1.199 foram superadas sem ação →
dos 2.874 pares, **1.972 iguais à sugestão (68,6%)** e 902 diferentes.

| Mês | Sugestões emitidas | Abstenção do agente | Com proposta | Pares (teve ação) | Seguidas (ação = sugestão) | Corrigidas | **% seguida (I1)** | Superadas sem ação | Placar oficial (otimista) |
|---|---|---|---|---|---|---|---|---|
| Jul | 3.650 | 838 | 2.812 | 2.236 | 1.509 | 727 | **67,5%** | 576 | 75,0% |
| Ago | 5.048 | 1.424 | 3.624 | 2.753 | 1.943 | 810 | **70,6%** | 871 | 78,9% |
| Set | 5.026 | 953 | 4.073 | 2.874 | 1.972 | 902 | **68,6%** | 1.199 | 76,7% |
| Out (1–5) | 836 | 165 | 671 | 423 | 283 | 140 | **66,9%** | 248 | 75,4% |

Dois % derivados que também valem acompanhar: **% de sugestões que viraram
ação** = pares ÷ com proposta (set: 70,6%) e **% de abstenção** = abstenção ÷
emitidas (set: 19,0%).

Linha de base pra mirar: **~68–70%**. Meta é do Caio/Duilio; o número é este.

**Onde o operador corrige (3 meses, por sugestão):** 54→44 (372), 54→55 (323),
56→54 (270), 54→21 (234), 54→56 (229), 21→54 (147), 59→33 (145), 59→54 (109).
A oc **54 sugerida indevidamente** é o maior bolsão: o operador troca por 44
(devolução), 55, 21 ou 56. Segundo: **56↔54** nos dois sentidos (o agente não
distingue bem "aguardando cliente" de "cliente já respondeu").

---

## I2 — % de entradas sem sugestão nenhuma

**Pergunta:** o card entrou em tratativa e ficou sem nenhuma ação sugerida —
**com ou sem agente** (Caio 06/10: assim o Duilio pega a oc 20 pra tratar e
melhorar o número).

| Regra | Definição |
|---|---|
| **Unidade** | a **ENTRADA** do card (não o card): cada evento de `EVENTOS_NOVA_ENTRADA` (`BastaoCardImportado`, `CardReaberto`, `BastaoReabriuNFFonteRelacionamento`, `CardReabertoPorRespostaCliente`, `AgenteExtravioLancou49`, `AguardandoClienteOcMudou`, `OcComRegraChegouEmParaFazer`) com a oc **daquele momento** (vem no payload). "Nascer" = entrar. |
| **Escopo** | **TODAS** as entradas, qualquer oc. A coluna `tem_agente` separa quem já tem agente (10/11/19/35/49/13) de quem não tem. |
| **Teve sugestão** | `AgenteOcsPadraoDecisao` com `proposta_destacada`, `AgenteOc13Decisao` ou `InterpretadorRespostaClienteConcluido` com `oc_sugerida`, entre a entrada e a entrada seguinte (teto 48h). |
| **Sem sugestão — 5 causas** | **oc sem agente** (backlog de regras: 20, 57, 8, 23, 26, 54/59 fora de resposta, 43); **análise sem sugestão** (agente rodou e não propôs nada; na 49 = `caso_oc49: nao_reconhecido`); **falhou**; **suprimida sem evidência** (INV-111, correta por regra); **não rodou**. |
| **Prioridade** | `sem_sugestao_e_operador_agiu`: o operador decidiu **às cegas**. 57/54/59/43 têm milhares de entradas e ~zero ação do operador — inflam o % total mas não doem; a 20 e a 8 doem. |

**Distinção que importa:** "ter opções" ≠ "ter sugestão". `REGRAS_AUTO_ACAO`
cria as **opções** (todos) pra 8/10/11/13/19/20/23/26/35/43/49/54 — é o menu.
**Sugestão** é o agente de IA destacar uma opção (⭐). A oc 20 tem menu e não tem
agente.

### Como está (jul → out/2026) — todas as entradas

| Mês | Entradas | Com sugestão | **% sem sugestão (I2)** | oc sem agente | Análise sem sugestão | Não rodou | Falhou/suprimida | **Operador agiu sem sugestão** |
|---|---|---|---|---|---|---|---|---|
| Jul | 6.054 | 2.046 | **66,2%** | 3.421 | 411 | 176 | 0 | **1.988** |
| Ago | 11.594 | 3.446 | **70,3%** | 6.992 | 705 | 449 | 2 | **3.100** |
| Set | 14.886 | 4.104 | **72,4%** | 9.691 | 523 | 563 | 5 | **3.189** |
| Out (1–6) | 2.427 | 665 | **72,6%** | 1.615 | 103 | 44 | 0 | 474 |

Só no escopo **com agente** (10/11/19/35/49/13) o I2 é: jul 29,5% · ago 35,4% ·
set 30,8% · out 25,2%.

### Setembro por oc — onde atacar

| oc | Agente? | Entradas | % sem sugestão | Operador agiu sem sugestão | Leitura |
|---|---|---|---|---|---|
| **20** | não | 2.695 | 95,3% | **1.451** | maior bolsão de decisão às cegas. Tem menu, não tem agente. |
| **49** | sim | 2.513 | 35,2% | **651** | agente só reconhece 3 casos; 903 `nao_reconhecido`/mês. |
| **8** | não | 1.568 | 93,9% | **720** | 2º bolsão sem agente. |
| 57 | não | 2.140 | 100% | 2 | passiva — operador não age; não é prioridade. |
| 54 / 59 | interp. | 1.282 / 1.060 | 99% | 5 / 1 | aguardando cliente; a sugestão vem pelo interpretador quando ele responde. |
| 43 | autônoma | 954 | 99,2% | 57 | agente executa direto. |
| 23 | não | 177 | 88,7% | 120 | pequena, mas 2/3 às cegas. |
| **13** | sim | 256 | 37,5% | 65 | agente não roda em 1/3 das entradas (gatilho a investigar). |
| 10 / 11 / 19 / 35 | sim | 1.015 / 620 / 340 / 167 | 3–6% | 44 / 21 / 8 / 4 | núcleo saudável. |
| 26 | não | 64 | 68,8% | 38 | |

Ordem de ataque pelo "operador agiu às cegas" em set: **20 (1.451) → 8 (720) →
49 (651) → 23 (120) → 13 (65)**. Zerar 20 e 8 exige agente novo (regra de
negócio); 49 e 13 exigem ampliar o agente que já existe.

---

## INV-168 (sugestão por entrada) — primeiro parâmetro, 05–06/10

Deploy em 05/10. Dois dias úteis, o segundo parcial. **Não é tendência ainda.**

| Dia | Entradas c/ agente | % sem sugestão | Sugestões | % seguida | Re-análises por entrada nova |
|---|---|---|---|---|---|
| 28/09 | 222 | 23,9% | 204 | 71,2% | — |
| 29/09 | 237 | 21,5% | 248 | 70,6% | — |
| 30/09 | 170 | 18,2% | 182 | 76,0% | — |
| 01/10 | 221 | 24,0% | 246 | 68,9% | — |
| 02/10 | 189 | 14,3% | 218 | 69,8% | — |
| **05/10** | 217 | **11,5%** | 237 | 63,2% | **14** |
| 06/10 (parcial) | 124 | 27,4%* | 128 | 62,9%* | **16** |

\* dia em curso: entradas de hoje ainda vão receber sugestão e pares ainda vão
fechar — os dois números de 06/10 são imaturos por construção (regra das 48h).

Leitura: (a) a feature **está disparando** (`AnaliseInvalidadaPorNovaEntrada`:
14 e 16/dia — antes não existia); (b) no 1º dia fechado, I2 do escopo caiu pra
**11,5%** contra média de ~20% na semana anterior — sinal bom, uma amostra;
(c) I1 do dia caiu pra 63% — plausível que as re-análises peguem casos mais
difíceis (card que voltou), mas são 2 dias. Contraprova de verdade = semana
inteira de 06 a 10/10.

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
