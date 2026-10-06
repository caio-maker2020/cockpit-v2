# Indicadores dos agentes — I1 e I2

Caio, 06/10/2026. Dono da melhoria: **Duilio**. Script: `scripts/sql/indicadores_agentes.sql`
(só leitura, roda com `leitura_duilio`). Só dois números. Sem outra régua.

## I1 — Das sugestões do agente, quantas o operador seguiu

- Conta **cada sugestão** (`AgenteOcsPadraoDecisao` com `proposta_destacada` / `AgenteOc13Decisao`). Um card pode ter várias — cada uma conta.
- **Seguiu** = a 1ª ação do operador depois da sugestão (e antes da próxima) lançou a mesma oc.
- Sugestão sem ação do operador até a próxima sugestão não entra.
- Três agentes: agente-padrão (`AgenteOcsPadraoDecisao`, ocs 10/11/19/35/49), agente-oc13 (`AgenteOc13Decisao`), interpretador de resposta do cliente (`InterpretadorRespostaClienteConcluido`, 54/59). Autônomos (49 extravio, 43) não sugerem — ficam fora.

| Agente | Jul | Ago | Set |
|---|---|---|---|
| agente-padrão (10/11/19/35/49) | 1.457 / 2.158 = **67,5%** | 1.908 / 2.733 = **69,8%** | 1.909 / 2.772 = **68,9%** |
| agente-oc13 | 62 / 102 = **60,8%** | 63 / 90 = **70,0%** | 86 / 125 = **68,8%** |
| interpretador (54/59) | 735 / 1.226 = **60,0%** | 1.189 / 1.979 = **60,1%** | 1.202 / 2.107 = **57,0%** |
| **I1 — total** | 2.254 / 3.486 = **64,7%** | 3.160 / 4.802 = **65,8%** | 3.197 / 5.004 = **63,9%** |

(seguidas / sugestões com ação do operador)

Onde o operador corrige (jul–set): 54→44 (372) · 54→55 (323) · 56→54 (270) · 54→21 (234) · 54→56 (229).

Não usar `v_placar_agente`/`agent_feedback` pra este número: a RPC implícita
dedupe por (card, oc, sugestão) e perde o 2º ciclo (set: 894 pares reais, 593
gravados) — mostra ~8 pts a mais. Corrigir a RPC = migration, pende OK.

## I2 — Das ações lançadas no Cockpit, quantas não tinham sugestão nenhuma

- Conta **cada ação aprovada** (`AprovacaoOperador`).
- **Sem sugestão** = `sugestao_vigente` vazio na hora de aprovar (nem agente, nem interpretador).
- Vale tudo: com ou sem agente, 55 inclusa.
- Existe desde 04/09 (mig 377 carimbou `sugestao_vigente`). Jul/ago não têm.

| Mês | Ações lançadas | Sem sugestão | **I2** |
|---|---|---|---|
| Set | 7.549 | 3.981 | **52,7%** |
| Out (1–6) | 1.529 | 806 | **52,7%** |

O que é lançado sem sugestão (set): 55 → 2.324 (58%) · 54 → 937 · 44 → 208 · 21 → 158 · 56 → 134.
Por onde entra o card que acaba com ação sem sugestão: ocs **20** e **8** (sem agente) e **49** (agente não reconhece o caso).

## INV-168 (sugestão por entrada, deploy 05/10)

Está disparando (`AnaliseInvalidadaPorNovaEntrada`: 14 em 05/10, 16 em 06/10).
Um dia fechado — sem parâmetro ainda. Medir de novo em 10/10 com a semana inteira.
