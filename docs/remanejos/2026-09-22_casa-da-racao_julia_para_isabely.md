# Remanejo — CASA DA RAÇÃO VETERINÁRIA: JULIA → ISABELY (Curva F)

| campo | valor |
|---|---|
| CNPJ | `18977975000300` |
| Cliente | CASA DA RACAO VETERINARIA |
| De | **JULIA** (segmentos `003`, `005`) |
| Para | **ISABELY** (segmento `043` CURVA F, `recebe_cards_orfaos = true`) |
| Segmento | `003 DISTRIBUIDOR AGRO` → **`043 CURVA F`** |
| Motivo | Faturamento abaixo do corte da carteira da JULIA; cliente é Curva F |
| Autorizado por | **CARLOS** (chat, 2026-09-22) |
| Ferramenta | RPC `public.remanejar_cliente_operador` (mig 360) — **sem migration nova** |
| Status | **APLICADO em produção 2026-09-22**, 12/12 critérios + prova pela RLS |

---

## 1. Pedido

Carlos, 2026-09-22: *"O cliente CASA DA RAÇÃO hoje está com a Operadora Julia,
porém não tem o faturamento necessário para ser da operadora Julia. Transferir
para a operadora Isabely, que é a responsável por clientes de baixo faturamento."*

Mesma classe do remanejo LDI SAFETY de 2026-09-08: o cliente estava rotulado pelo
que **vende** (`003 DISTRIBUIDOR AGRO`) e não pelo que **fatura** (`043 CURVA F`).

## 2. Estado verificado ANTES (2026-09-22, produção, read-only)

| camada | quantidade | dono |
|---|---|---|
| `clientes` | 1 linha | segmento `003 DISTRIBUIDOR AGRO`, ativo |
| `operadores.carteira` | 1 CNPJ | **só JULIA** (sem duplicidade) |
| `cards` | **17** | **8 JULIA / 9 ISABELY** |
| `contatos_cliente` | 2 (por `documento_cliente`) | JULIA |
| `tracking_credentials` | 1 | JULIA |
| `acoes_agendadas` armadas | 0 | — |
| `alertas_operador` não lidos | 0 | — |
| `cnpjs_excluidos_cockpit` | não consta | — |

Raiz `18977975%`: **um único CNPJ** — não há filial para mover junto.

Estados dos 17 cards: 15 `TRANSFERIDO`, 1 `RESOLVIDO`, 1 `AGUARDANDO_CLIENTE`
(parado desde 31/07). **Nenhuma tratativa quente no momento da execução.**

Contagem feita por `agent_state->>'cnpj_pagador'` **e** `pagador` normalizados —
`cards.pagador` guarda o NOME do cliente, não o CNPJ (armadilha paga em 2026-09-08).

### 2.1 Por que o cliente já estava "pela metade"

Os 9 cards que já estavam na ISABELY são de junho/início de julho e carregavam
`responsavel_relacionamento = 'ISA E KAROL'` — nome que **não existe** em
`operadores`. O trigger `resolve_assigned_operator_from_name` não casou por nome e
caiu no fallback "nada fica órfão" (mig 305), que entrega à ISABELY
(`recebe_cards_orfaos`). De 08/07 em diante o SSW passou a dizer `JULIA`, o nome
casou, e os cards novos nasceram com ela. A RPC normalizou os 17 para `ISABELY`.

## 3. Pré-requisito humano — FEITO

Espécie/responsável trocada no SSW **antes** da execução (confirmado pelo Carlos no
chat). Sem isso, card novo sem dono volta pro operador antigo pelo trigger por nome
(caso SULMEDIC 17–19/08).

Observação de código: no caminho do `sync-bastao` o **Path 1 do
`operador-resolver.ts` (carteira-CNPJ) tem prioridade absoluta sobre o nome**, então
cards novos já nasceriam na ISABELY mesmo sem a troca no SSW. A troca fecha a porta
lateral do trigger de banco, que dispara quando `assigned_operator_id` chega nulo.

## 4. Por que o segmento tinha de ir junto (o ponto crítico)

A RLS de `cards` (mig 242) mostra o card por `assigned_operator_id` **OU**
`pagador ∈ carteira` **OU** `segmento_codigo ∈ segmentos`. A JULIA tem `003` nos
segmentos. Mover só a carteira deixaria o cliente **visível para os dois**. Por isso
o `003` virou `043`, que é o segmento da ISABELY — e os cards ficam com
`segmento_codigo = NULL` (convenção das migs 300/301/307/330/333/359).

## 5. Antecedente que esta troca reverte

`migration/2026-07-21_303_casa_racao_so_julia.sql` registra diretriz do Caio de
21/07: *"CASA DA RAÇÃO é da Julia. Pode deixar apenas nela."* Na época o CNPJ estava
em **duas** carteiras (ISA E KAROL + JULIA) e a mig 303 consolidou na JULIA.

Esta troca **reverte aquela decisão**, por critério novo (faturamento). Carlos foi
avisado do antecedente antes de autorizar e autorizou mesmo assim (política de
migrations: remanejo via RPC é autonomia declarada do Carlos).

**Não reescrever as migs 303 nem 307** — o `apply_migrations.py` versiona por
sha256 e passaria a abortar com DRIFT. O delta é este documento.

## 6. Comando executado

```sql
SELECT jsonb_pretty(public.remanejar_cliente_operador(
  p_cnpj             => '18977975000300',
  p_operador_destino => 'ISABELY',
  p_segmento_codigo  => '043',
  p_segmento_nome    => 'CURVA F',
  p_motivo           => 'Faturamento abaixo do corte da carteira da JULIA; cliente e Curva F (baixo faturamento)',
  p_autorizado_por   => 'CARLOS'
));
```

## 7. Dry-run (`BEGIN … ROLLBACK`, nada gravado)

```json
{ "de": ["JULIA"], "para": "ISABELY", "cnpj": "18977975000300",
  "cliente": "CASA DA RACAO VETERINARIA",
  "cards": 17, "contatos": 2, "tracking": 1, "alertas": 0, "veto_desarmado": 0,
  "avisos": ["Confira que a especie/responsavel ... JA FOI trocada no SSW ..."] }
```

Os 9 pós-checks passaram (nenhuma EXCEPTION). Números **idênticos** ao levantamento
da seção 2. O único aviso é o lembrete fixo do SSW — não houve aviso de segmento
fora de `operadores.segmentos`, confirmando que `043` é da ISABELY.

## 8. Execução em produção — 2026-09-22

Relatório devolvido **idêntico ao dry-run**: `de: ["JULIA"]`, cards 17, contatos 2,
tracking 1, alertas 0, veto_desarmado 0.

**Idempotência confirmada em produção:** 2ª execução devolveu `de: []`, `cards: 0`,
`contatos: 0`, `tracking: 0` — nada mexido, nenhum evento duplicado.

## 9. Validação pós-execução — 12/12

| # | critério | esperado | medido |
|---|---|---|---|
| 01 | cards da ISABELY | 17 | **17** ✅ |
| 02 | cards da JULIA | 0 | **0** ✅ |
| 03 | cards com `segmento_codigo` preenchido | 0 | **0** ✅ |
| 04 | `responsavel_relacionamento` ≠ ISABELY | 0 | **0** ✅ |
| 05 | `card_events` `OperadorReatribuido` hoje | 17 | **17** ✅ |
| 06 | contatos na ISABELY | 2 | **2** ✅ |
| 07 | tracking na ISABELY | 1 | **1** ✅ |
| 08 | segmento do cliente | `043 CURVA F` | **043 CURVA F** ✅ |
| 09 | CNPJ em N carteiras | 1 | **1** ✅ |
| 10 | dono na carteira | ISABELY | **ISABELY** ✅ |
| 11 | GLOBAL: CNPJs em 2+ carteiras | 0 | **0** ✅ |
| 12 | carteiras JULIA / ISABELY | 51 / 394 | **51 / 394** ✅ |

**Prova pela RLS — identidade real simulada** (`request.jwt.claims` com o `user_id`
verdadeiro + `role=authenticated`, policy rodando de verdade):

```
ISABELY enxerga 17 card(s) da CASA DA RACAO
JULIA   enxerga  0 card(s) da CASA DA RACAO
```

É esta linha que fecha o caso: a JULIA não vê mais nada do cliente — nem pela
carteira, nem pela porta do segmento, porque o `003` deixou de alcançá-lo.

## 10. Guards e o que NÃO foi afetado

- **INV-048** (`/verify-cockpit`): este CNPJ **não é âncora** do guard
  (`INV48_ANC` cobre 8 pares + carteira da MARIA). `INV48_DUP` continua 0
  (critério 11) e `INV48_SEG` / `INV48_BLK` não tocam neste cliente. **PASS
  preservado.**
- **Planilha** `data/relacionamento-atualizado-2026-07-23.xlsx` linha 508 continua
  dizendo `Julia` / `003`, e a linha 545 da mig 307 também — de propósito: é o
  retrato imutável de 23/07. Delta registrado no docstring de
  `scripts/import_relacionamento_atualizado.py` e neste documento.
- Nenhuma edge function, RPC, migration ou código de produção foi alterado.

## 11. Reversão

```sql
SELECT public.remanejar_cliente_operador(
  p_cnpj             => '18977975000300',
  p_operador_destino => 'JULIA',
  p_segmento_codigo  => '003',
  p_segmento_nome    => 'DISTRIBUIDOR AGRO',
  p_motivo           => '<motivo>',
  p_autorizado_por   => '<quem>');
```

**Não é bit-a-bit:** a RPC sempre atribui a alguém, então a reversão põe os 17 cards
na JULIA — inclusive os 9 que estavam na ISABELY por fallback antes desta troca.
O estado literal anterior (8 JULIA / 9 ISABELY) não é reconstruído.

## 12. Em aberto até acontecer

O critério final — "o próximo card da CASA DA RAÇÃO nasce direto na ISABELY" — só o
primeiro card novo confirma na prática. O Path 1 do resolver aponta ISABELY e o SSW
já foi trocado, então as duas portas estão fechadas.
