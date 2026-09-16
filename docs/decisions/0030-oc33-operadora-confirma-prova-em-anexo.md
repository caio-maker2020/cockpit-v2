# ADR 0030 — A operadora pode confirmar que a prova veio em anexo

**Data:** 2026-09-16
**Decisor:** Carlos Botelho
**Status:** aceito, atrás da flag `popup_confirma_dossie_oc33_enabled` (nasce FALSE)
**Relacionados:** ADR 0023 (as 3 provas da oc 33), ADR 0029 (o agente lê o anexo),
INV-150, INV-152, INV-154, INV-155, migrations 365 / 399 / 400

---

## Contexto

A oc 33 de completude (extravio parcial caso 1) exige três provas: romaneio de
coleta assinado, descrição dos itens e valor dos itens. A trava está na RPC
`aprovar_e_executar` (mig 365) e lê um carimbo no to-do
(`proposta_payload.meta.gate_oc33.bloqueada`).

A rodada anterior (ADR 0029 / INV-154) fez o agente **abrir** o conteúdo dos
anexos — PDF, JPG e PNG — inclusive de mensagens anteriores do card. Isso resolve
quando a máquina **consegue** ler. Sobra o caso em que ela não consegue: PDF
escaneado torto, foto ruim, planilha (fora daquela rodada). Nesses cards a
informação existe, a operadora está olhando para ela na tela, e não havia
saída nenhuma: o botão ficava cinza e o robô seguia cobrando um cliente que já
tinha respondido.

## Decisão

Palavras do Carlos, 2026-09-16:

> "a opção tem q estar liberado desde q ela confirme q o dossiê está completo e
> anexado / qdo ela tentar lançar neste caso deve abrir um popup questionando que
> a descrição de itens não foi identificada e questionando se o cliente informou
> via anexo ELA MARCA SIM / se ela marcar, libera lançar a 33 confirmando que o
> dossiê está completo / se ela marcar NÃO, não libera a 33 pois o dossiê está
> incompleto"

E, perguntado se ela marca só SIM ou digita o conteúdo, ele escolheu **(a): ela
digita**.

## A consequência que fechou o desenho

Chegamos a considerar três formas de o SIM aterrissar: virar prova no dossiê,
virar liberação registrada à parte, ou apenas destravar o botão. **Duas delas não
se sustentam**, e isso foi verificado, não suposto:

O carimbo é recalculado a partir do dossiê em **três lugares** —
`propostas-pos-resposta-cliente.ts:518`, `regras-auto-acao.ts:1392` e o repatch
do `interpretador-resposta-cliente/index.ts:1217`. Uma confirmação que mexesse
apenas no carimbo seria desfeita pela próxima mensagem do cliente, **em
silêncio**: o botão voltaria a ficar cinza e a operadora digitaria de novo sem
nunca entender o motivo.

Ou seja: a regra que o Carlos escreveu — o SIM confirma que o **dossiê** está
completo — não era uma entre três opções. Era a única.

## O que fica de fora (limites explícitos)

- **Romaneio não é perguntado.** Sem ele o SSW reverte a 33 (NF 660746). Card sem
  romaneio continua bloqueado, e o pop-up nem aparece.
- **Combo 33+44** (natureza operacional) fora desta rodada.
- **Não libera execução autônoma.** `veto-elegibilidade.ts:68` lê o mesmo carimbo,
  então o robô continua barrado. Libera o **botão**, como ele determinou desde
  15/09.
- **Card sem anexo do cliente não pergunta** — não há o que ter vindo "em anexo".
- **SIM em branco não vale.** Piso de 3 caracteres. Um SIM vazio produz exatamente
  a oc 33 que o Ressarcimento devolveu 20 dias depois cobrando "DESCRIÇÃO E
  VALOR".

## Irreversibilidade — conhecida, não acidental

`mergeEvidencia` é monotônico: `presente` nunca volta para `false`. Um SIM errado
marca o card como completo **para sempre** e a Sal para de cobrar aquele cliente.

Foi decidido assumir isso em vez de inventar um caminho de desfazer, porque
tornar a evidência reversível mudaria o comportamento de todo o dossiê, não só
deste caso. As contrapartidas:

- a evidência carrega `fonte: "operador"`, `operador_id` e `visto_em`;
- um `card_event` `Oc33DossieConfirmadoPeloOperador` é gravado **antes** da
  escrita, com o texto e o autor;
- a tela avisa, em amarelo, que não volta atrás;
- o NÃO também é registrado (`Oc33ConfirmacaoOperadorRecusada`) — é assim que se
  mede quantas vezes o anexo realmente não tinha a informação.

## A cerca contra o modelo

`FonteEvidencia` ganhou o valor `"operador"`. O caminho do LLM
(`montarEvidenciasRecebidas`) emite `"corpo"` e `"anexo"` como literais no
código — não existe caminho pelo qual o modelo se declare confirmado por um
humano. A cerca é estrutural, e o INV-155 verifica que continua assim.

## Alcance

Medido em 16/09: **38 cards** com to-do de oc 33 aberto, romaneio já validado e
só descrição/valor faltando (Karoline 8, Felipe 8, Maria 7, Duilio 6, Isabely 4,
Ingrid 2, Victor 2, Larissa 1). Os outros ~460 cards travados também não têm
romaneio — este pop-up **não** os resolve, e foi dito assim ao Carlos antes de
ele autorizar.

## Os 70 caracteres

O campo `f6` da tela 101 do portal SSW tem `maxlength=70` e é a coluna
"Instrução/Complemento" que o setor de Ressarcimento lê; o que passa disso vai
para o campo `observ` (500) e ninguém vê. Por isso o pop-up mostra a **prévia
exata** do que o setor vai ler, montada pelo mesmo caminho que gera o texto real
(`mergeEvidencia` → `montarTextoDescricaoValor`), e marca em vermelho o que não
chega. Sem a prévia ela escreveria um texto caprichado e o Ressarcimento
receberia meio item.

## Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Mexer só no carimbo | Desfeito pela próxima mensagem do cliente, em silêncio (três recarimbadores). |
| Liberação registrada à parte, dossiê segue incompleto | Cria uma segunda porta que toda regra futura teria de lembrar; o robô voltaria a cobrar documento de card já ressarcido. |
| Só destravar o botão, sem texto | Repete as 3 oc 33 que saíram sem descrição/valor e voltaram do Ressarcimento. |
| Perguntar também sobre romaneio | Sem romaneio o SSW reverte. Não é questão de confiança na operadora — é o TMS que recusa. |

## Como validar

- `deno test --no-check --allow-all supabase/functions/_shared/oc33-confirmacao-operador.test.ts` (19)
- `npx vitest run src/lib/confirmacaoOc33.test.ts` (19) e `src/lib/gateOc33Carimbo.test.ts`
- bloco **INV-155** no `/verify-cockpit`
- flag `popup_confirma_dossie_oc33_enabled` ligada por UPDATE separado (TIPO B)
