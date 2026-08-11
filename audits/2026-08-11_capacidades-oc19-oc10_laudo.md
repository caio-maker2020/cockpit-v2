# Laudo — capacidades novas do loop de aprendizado (11/08/2026)

Investigação feita ANTES de escrever código, por ordem do Caio ("sem erros, sem
regressão, seguindo 100% do ritual"). Fonte: `v_sinal_ouro_casos`, `cards.historico_ssw`,
`messages_inbox` em produção.

## Resumo executivo

| Capacidade | learning_log | Base nos dados | Decisão |
|---|---|---|---|
| A — oc 10: consultar e-mails da NF antes de sugerir | `f665c8f2` | **SIM** — 48 casos corrigidos p/ 44, 25 com e-mail prévio, 16 citando devolução | **implementar** |
| B — oc 19: ler todo o histórico da NF | `6564fe0a` | **NÃO** — nenhuma das 2 formulações tem sinal | **não implementar** (evidência abaixo) |

## Capacidade B — por que NÃO tem sinal

Bolsão real da conversa Isadora×agente-chefe: card `oc_card=19` + agente sugeriu `59`.
**189 casos: 171 seguidos (90,5%) e 18 corrigidos.**

Nota de método: a melhoria `6564fe0a` está gravada com `chave_padrao =
agente-sugere-ocs-padrao:sug19`, mas **`oc_sugerida=19` não existe** no sinal ouro — o
replay filtra por `oc_sugerida`, então essa chave aponta pra um bolsão vazio. A chave
correta seria `sug59`.

### Formulação 1 — "ressalva ilegível → 56" (âncora NF 2684827)

| | seguidos (59 aceito) | corrigidos |
|---|---|---|
| `foto_classificacao = destinatario_com_ressalva` | 170 | **18** |
| `foto_classificacao` nulo/ilegível | 1 | **0** |

**Todos os 18 corrigidos têm ressalva LEGÍVEL e lida com sucesso.** Não existe um único
caso de ressalva ilegível no bolsão. Os textos extraídos são indistinguíveis entre os dois
grupos:

- corrigido p/ 56: `"Falta 1 volume"`, `"Recebo 7 volumes. Faltou 1"`
- seguido em 59: `"Faltou 2 Volumes."`, `"RECEBI FALTANDO 01 VOLUME"`

Mesmo conteúdo, desfechos opostos. **O discriminante 56 × 59 não está no que o agente
enxerga.**

Sobre a NF 2684827 especificamente: o card **não é oc 19** — é `codigo_oc_card: 49`, caso
`devolucao_pos_56`, decidido por `decidirOc49`. O motivo saiu da instrução do motorista
(`"TRATATIVA DE RELACIONAMENTO PARA LIBERACAO DE CARG"`), com `tem_ressalva: false`. A
regra "oc 19 + ressalva ilegível" não pegaria esse caso nem se existisse.

### Formulação 2 — "oc 20 (localizado) no histórico → não é 59"

| grupo | casos | com oc 20 no `historico_ssw` |
|---|---|---|
| corrigidos | 18 | **0** |
| seguidos | 171 | **7** |

**Anti-correlacionada.** A oc 20 só aparece onde o 59 foi aceito. Implementar essa regra
desviaria 7 acertos e não recuperaria nenhum erro — regressão pura.

### Conclusão da B

A capacidade "ler todo o histórico" não é o gargalo: o histórico **já chega** ao agente
(`todasOcorrencias`, `index.ts:637`) e já alimenta 4 regras (linhas 913, 1218, 1236, 652).
O que falta é sinal, não dado. Enquanto o discriminante não for identificado, qualquer
regra escrita aqui é chute com 90,5% de acerto em risco.

**Próximo passo sugerido (não executado):** perguntar à Isadora o que ela olha ao decidir
56 × 59 em dois casos com a mesma ressalva — mostrando lado a lado NF 849954 (`"Falta 1
volume"` → time lançou 56) e NF 742946 (`"Veio faltando 1"` → time aceitou 59).

## Capacidade A — base confirmada

Bolsão: card `oc_card=10`, agente sugeriu 54 ou 56, time lançou **44**.

| métrica | valor |
|---|---|
| casos corrigidos p/ 44 | **48** |
| com algum e-mail no card antes da decisão | 25 |
| e-mail citando devolução/NFD/retorno | **16** |

Caso âncora: **NF 50540** — e-mail do cliente *"Solicito a devolução dessas NF 50661 /
50660 / ... / 50540"* recebido ANTES da decisão; o agente sugeriu 54/56 e o time lançou 44.
É exatamente o cenário que a Isadora descreveu.

Estado do código: `messages_inbox` tem **0 referências** no `agente-sugere-ocs-padrao` e nos
9 módulos `_shared/` que ele importa. A capacidade não existe — não é regressão, é lacuna.

**Risco a controlar:** oc 10 tem 805 casos `54` seguidos. O detector precisa ser estreito o
bastante pra não desviar esses. Calibração medida contra a base inteira antes de integrar.
