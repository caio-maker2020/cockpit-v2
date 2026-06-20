# ADR 0006 — CTRC é a identidade do card (não a NF)

**Data:** 2026-06-20
**Status:** Aceito (Caio)
**Relacionado:** [ADR 0005 — SSW interno fonte canônica de saída](0005-ssw-interno-fonte-canonica-saida.md); memory `feedback_ctrc_e_identidade_do_card_nao_nf`; regra crítica do CLAUDE.md ("lançamento SSW SEMPRE pelo CTRC do card").

## Contexto

Uma NF gera **vários CT-es ao longo da vida**: entrega original → reentrega →
devolução → complementar/subcontrato. Cada CT-e é uma tratativa distinta. O CT-e
anterior, ao ser finalizado/baixado, **encerra junto com a tratativa dele**.

O `sync-bastao` casava pendência ↔ card **por NF** (`prefetchedByNf`) e o índice
`uniq_cards_nf_active` força **1 card ativo por NF**. Consequência: quando a NF
ganhava um CT-e novo (ex.: devolução), o sync **colava a ocorrência do CT-e novo
no card do CT-e velho** (já baixado). Card "Frankenstein": `ctrc` = CT-e de
entrega finalizado + `cod_ultima_ocorrencia` = oc do CT-e de devolução.

### Risco / bug âncora

Lançar ocorrência usa SEMPRE o `card.ctrc` (regra crítica do CLAUDE.md). Com o
CTRC errado (CT-e baixado/complementar), o SSW rejeita com **"DOCUMENTO BAIXADO
OU ENTREGUE"** — exatamente o pesadelo que a regra do tripé existe pra evitar.

Diagnóstico (2026-06-20): **9 cards ativos** com `card.ctrc ≠ ctrc da pendência
do Bastão`, em vários clientes, abrangendo CT-e de **devolução** (oc 6/23/49) e
**complementar/subcontrato** ("SUBC FORM CTRC", oc 54). Âncora INOVAMED/LARISSA:
NF 66783 card aponta CT-e de entrega APO278963-9 (baixado, oc 30) enquanto a
pendência viva está no CT-e de devolução AMP310619-5 (oc 23).

Regra de negócio confirmada pelo Caio: **o tipo de CT-e (devolução/complementar)
NÃO muda a responsabilidade da ocorrência.** O setor de Devolução cuida só do
administrativo do CT-e (emissão, cobrança de frete, rastreamento). As ocorrências
no CT-e seguem as regras-padrão de responsabilidade → CT-e de devolução com oc de
relacionamento é o **Relacionamento** que trata.

## Decisão

**O CTRC é a identidade do card.** Quando o Bastão passa a apontar a pendência de
uma NF pra um CTRC diferente do que está no card, o CT-e anterior encerrou: o card
antigo **finaliza** (RESOLVIDO) e nasce um **card novo** pro CTRC novo. A
ocorrência do card novo segue a responsabilidade padrão dela.

### Implementação (versão CONTIDA — não re-arquiteta o sistema)

Helper `encerrarCardAntigoSeCtrcMudou` no dispatch do Pass A (`sync-bastao`),
rodando ANTES de `upsertCardFromPendencia`/`handleExtravioPendencia`. Quando
`normalize(pendência.ctrc) ≠ normalize(card.ctrc)` pra mesma NF:

1. Cancela propostas pendentes do card antigo.
2. Marca o card antigo como **RESOLVIDO** + evento `CardEncerradoPorTrocaDeCtrc`.
3. **Remove o card do `prefetchedByNf`** → o handler vê "sem card existente" e
   **cria um card novo** pro `p.ctrc` (reusa toda a lógica de criação existente).

Por que contida:

- **Mantém "1 card ativo por NF"** (o velho vira RESOLVIDO antes do novo nascer).
  `vinculador`/`gmail-poll`/RPCs/front que assumem isso **seguem válidos**, sem
  mexer no índice `uniq_cards_nf_active` (RESOLVIDO já sai do índice → o INSERT do
  card novo pra mesma NF não viola).
- Não toca em `OCORRENCIAS_DE_RELACIONAMENTO`, `stateFinalAposBastao` (INV-008),
  nem nas guardas de reabertura.

### Guardas (não-regressão)

- Só dispara com **ambos os CTRCs presentes e diferentes** (normalizado upper+trim).
- **Pula card em execução** (`EXECUTANDO_ACAO`/`EM_EXECUCAO_AUTOMATICA`/
  `ACAO_EXECUTADA`) — INV-007, não interrompe o executor; tenta no próximo sync.
- **Pula CNPJ excluído** do Cockpit.
- Card já terminal só recebe o evento + sai do prefetch (não reabre o CT-e velho
  via Camada 5a).
- `vinculador` pega o card **mais recente** por NF → resposta do cliente cai no
  card novo (CTRC correto).

## Alternativa rejeitada (por ora)

Re-key completo NF→CTRC (UNIQUE por CTRC, múltiplos cards ativos por NF). Mais
"puro", mas blast radius enorme (vinculador, gmail-poll, RPCs, front todos
assumem 1 card por NF). Reconsiderar só se aparecer caso legítimo de 2 CT-es
ativos simultâneos pra mesma NF.

## Consequências

- Cards de devolução/complementar/subcontrato com oc de relacionamento são
  tratados corretamente, com o CTRC certo → fim do risco "DOCUMENTO BAIXADO".
- Oscilação de CTRC no Bastão (A→B→A) geraria linhas RESOLVIDO no histórico (não
  cards ativos duplicados — o índice garante 1 ativo/NF). CTRC é identificador
  estável, então o risco é teórico; monitorar `CardEncerradoPorTrocaDeCtrc`.
- Retroativo: os 9 cards driftados se auto-corrigem no próximo sync após o deploy
  (card antigo → RESOLVIDO, card novo criado pro CTRC certo).
