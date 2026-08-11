# PR #27 — ajuste da opção 2 e o que a remedição revelou (11/08/2026)

Ordem do Caio: tirar da regra o ramo da oc 11 (já implementado desde 08/08) e manter só
oc 10 + oc 13. Ajuste **feito**. A remedição que veio junto, porém, derruba a justificativa
do PR.

## 1. O ajuste

Linha do bloco-âncora do `interpretador-resposta-cliente` passou de 3 ramos para 2:

| ramo | antes | agora |
|---|---|---|
| (a) oc 10, ressalva sem nitidez → 56 | ✔ | ✔ |
| (b) oc 11 fora do raio → 21 + cancelamento | ✔ | **removido** |
| (c) oc 13, insucesso inválido → 21 + cancelamento | ✔ | ✔ (virou "b") |

Motivo da remoção: os **14 casos** de card oc 11 em que o agente sugeriu 54 e o time lançou 21
são **todos anteriores a 08/08** — já capturados pela etapa-2 (`learning_log 77911966`). Manter
o ramo criaria duas formulações da mesma regra convivendo no mesmo prompt.

## 2. O veredito que abriu o PR não se reproduz

Mesma regra, mesma chave, mesmos parâmetros, rodadas diferentes:

| quando | regra | chave | padrão | controle | veredito |
|---|---|---|---|---|---|
| 11/08 (manhã) | 3 ramos | `sug56` | **+5** | +8,4 | MELHORA → abriu o PR |
| 11/08 (tarde) | 3 ramos | `sug56` | **+0** | +0 | **EMPATE** |
| 11/08 (tarde) | 2 ramos (ajustada) | `sug56` | +5 | **−8,3** | dano colateral |
| 11/08 (tarde) | 2 ramos (ajustada) | `sug54` ← chave certa | **−5** | −8,3 | **PIORA** |

### Causa — não é o juiz

`evals/replay-regras.ts` já usa `temperature: 0` (linha 199) e amostra ordenada
(`order=decidido_em.desc&limit=20`). O que mudou foi **a amostra**: entre as duas rodadas,
**1 caso novo** entrou no bolsão `sug56` (61 → 62). Como a amostra é dos 20 mais recentes,
entrou um e saiu outro.

**Com n=20, 1 caso = 5 pontos percentuais.** É exatamente a magnitude do efeito que decide
o veredito. Ou seja: nessa escala a ferramenta **não distingue sinal de ruído amostral**.

## 3. A medição direta (essa é estável)

Contagem, não amostra — janela 25/05 a 11/08, 1.538 decisões do interpretador:

| ramo | casos que a regra recuperaria | por mês |
|---|---|---|
| oc 10, sugeriu 54 → time lançou 56 | **7** | ~2,8 |
| oc 13, sugeriu 54 → time lançou 21 | **2** | ~0,8 |
| **contra-risco** (sugeriu 56 → time lançou 54) | **−4** | — |

Ganho líquido realista: **~5 casos em 2,5 meses (~2/mês)**.

## 4. Recomendação

**Não mergear o #27 como está.** O ganho medido diretamente é pequeno (~2 casos/mês) e o
replay — a ferramenta que deveria confirmá-lo — produz vereditos opostos para a mesma regra.
Aplicar agora seria decidir no ruído.

Duas correções que destravam, em ordem de valor:

1. **Consertar o replay antes de decidir qualquer melhoria nova.** Opções: subir o `--limit`
   (o bolsão `sug56` tem 62 casos; dá pra usar todos), rodar N vezes e reportar a faixa em vez
   de um número, e/ou congelar a janela (`decidido_em < data`) pra amostra parar de andar. Sem
   isso, **todo veredito de ±5 pts do loop de aprendizado é suspeito** — inclusive os que já
   usamos.
2. **Reformular a regra mirando o bolsão certo.** O alvo real é `oc_card=10, sugeriu 54 → time
   lançou 56` (7 casos). A regra hoje está escrita em prosa larga e o juiz a aplica em tudo —
   o mesmo padrão que reprovou as outras 3 regras da rodada do `/f6`.
