# Remanejo — grupo JPES: VICTOR → DUILIO (Moto Bike)

**Data:** 2026-08-28 · **Autorizado por:** Carlos (chat) · **Executado via:** RPC
`public.remanejar_cliente_operador` (mig 360), conforme `docs/REMANEJAR_CLIENTE.md`.
**Classificação:** remanejo VIA RPC → liberado pro Carlos
(`docs/POLITICA_MIGRATIONS.md`). Remanejo à mão continuaria TIPO B / só Caio.

> **STATUS: PREPARADO, AINDA NÃO EXECUTADO.** A chamada de produção foi barrada
> pelo gate de permissões do ambiente do Carlos (escrita em dado de produção).
> O dry-run abaixo já rodou e passou. Ver "Como executar".

---

## 1. Pedido

Transferir 3 CNPJs do grupo JPES do operador **VICTOR** (segmento 012 DIVERSOS)
para **DUILIO**, com segmento correto **Moto Bike**.

| CNPJ | Formatado |
|---|---|
| `37794121000162` | 37.794.121/0001-62 |
| `05378352000107` | 05.378.352/0001-07 |
| `05378352000360` | 05.378.352/0003-60 |

## 2. Estado verificado ANTES (2026-08-28, produção)

**Os 3 CNPJs não existem no Cockpit.** Varredura em `clientes`, `operadores.carteira`
(todas), `cards` (por `agent_state->>'cnpj_pagador'` e por `pagador`),
`contatos_cliente`, `tracking_credentials`, `cnpjs_excluidos_cockpit` e na planilha
`data/relacionamento-atualizado-2026-07-23.xlsx` — **zero ocorrências**, inclusive
buscando pelas raízes `05378352` e `37794121` e em 3 formatos (14 dígitos, sem zero
à esquerda, com máscara).

**No Bastão (fonte das pendências):**

- `37794121000162` = **JPES COM. ATACA C.**, `responsavel_relacionamento = VICTOR`,
  **22 pendências** atualizadas em 2026-08-28 16:45. Confirma a premissa do pedido.
  Ocorrências presentes: 5, 6, 7, 8, 14, 15, 38 — **só a oc 8 (NF 89554) está no
  escopo de Relacionamento** (`ocorrencias_dicionario`: 3,8,10,11,17,19,20,23,26,28,
  35,43,49,57). Por isso o cliente ainda não gerou card: 21 das 22 pendências são
  de Operação/Perdas.
- `05378352000107` e `05378352000360`: **não existem no Bastão** em nenhum papel
  (pagador, remetente, destinatário), em nenhum formato.

**Dígitos verificadores:** os 3 CNPJs são matematicamente **válidos** — não é erro
de digitação nos números. Carlos confirmou em 2026-08-28 que são do mesmo grupo e
estão corretos; é essa confirmação que sustenta o uso de `p_cliente_novo_ok`.

**Operadores:** VICTOR (`ativo`, `cockpit_ativo`, segmentos 006,008,011,012,013,020,041,
carteira 44) · DUILIO (`ativo`, `cockpit_ativo`, segmentos **014,022**, carteira 61).
**Ambos FORA do piloto do veto** (hoje FELIPE, ISABELY, LARISSA) — sem ação autônoma
armada em jogo.

**Segmento:** "Moto Bike" = **`022 MOTOBIKE`** no catálogo, e o DUILIO já tem `022`
em `operadores.segmentos`. Nenhum segmento novo é criado.

## 3. Pré-requisito humano — FEITO

Espécie/responsável do grupo **já trocada no SSW** por Carlos (confirmado em
2026-08-28). Sem isso o trigger `resolve_assigned_operator_from_name` (migs 007/305),
que casa card novo por NOME e não olha carteira, devolveria cards novos pro VICTOR —
foi o que aconteceu com o SULMEDIC entre 17 e 19/08.

## 4. Automações que poderiam sobrescrever o novo responsável

Cascata do `_shared/operador-resolver.ts`:

| Ordem | Regra | Neste caso |
|---|---|---|
| Path 0 | blacklist `cnpjs_excluidos_cockpit` | não se aplica |
| **Path 1** | **CNPJ na carteira** (prioridade absoluta) | **é o que garante o resultado** |
| Path 2 | nome do Bastão (`responsavel_relacionamento`) | é o que mandaria HOJE (diria VICTOR) — neutralizado pela troca no SSW + Path 1 |
| Path 3 | segmento | reforço: `022` aponta DUILIO |
| Path 4 | fallback órfão (ISABELY) | só se tudo falhar |

Trigger `resolve_assigned_operator_from_name`: porta lateral real, coberta pela
troca no SSW (item 3).

## 5. Como executar

```sql
SELECT c AS cnpj,
       public.remanejar_cliente_operador(
         p_cnpj             => c,
         p_operador_destino => 'DUILIO',
         p_segmento_codigo  => '022',
         p_segmento_nome    => 'MOTOBIKE',
         p_motivo           => 'Grupo JPES e do segmento Moto Bike: sai do VICTOR (012 DIVERSOS) para o DUILIO (022 MOTOBIKE). Confirmado por Carlos 2026-08-28; especie/responsavel ja trocada no SSW.',
         p_autorizado_por   => 'CARLOS',
         p_cliente_novo_ok  => true
       ) AS relatorio
  FROM unnest(ARRAY['37794121000162','05378352000107','05378352000360']) AS c;
```

`p_cliente_novo_ok => true` é obrigatório aqui: a RPC recusa CNPJ que não exista em
`clientes`/carteira/`cards` (proteção anti-digitação). Os 3 batem nessa trava por
serem desconhecidos do Cockpit. A justificativa do escape está na seção 2.

## 6. Dry-run (RODADO E APROVADO — `BEGIN … ROLLBACK`, nada gravado)

Resultado idêntico para os 3 CNPJs:

```json
{"de": [], "para": "DUILIO", "cards": 0, "contatos": 0, "tracking": 0,
 "alertas": 0, "veto_desarmado": 0, "autorizado_por": "CARLOS",
 "avisos": ["Confira que a especie/responsavel do cliente JA FOI trocada no SSW ..."]}
```

`de: []` confirma que não saem de carteira nenhuma. Os 9 pós-checks internos da RPC
passaram (nenhuma EXCEPTION). Zero cards/contatos/tracking/alertas a mover — coerente
com a seção 2.

## 7. Efeito esperado

Não é "mover carga acumulada" — é **registrar a titularidade antes do primeiro card**:

- `clientes`: 3 linhas criadas com `segmento_codigo='022'`, `segmento_nome='MOTOBIKE'`
- `operadores.carteira`: DUILIO **61 → 64**; nenhuma outra carteira muda (`de: []`)
- `cards` / `contatos_cliente` / `tracking_credentials` / `alertas_operador` /
  `acoes_agendadas`: **0 linhas** — não há nada ainda
- A partir daí, todo card novo desses CNPJs nasce no DUILIO pelo Path 1

**Urgência:** a pendência oc=8 (NF 89554) do JPES está viva desde 2026-08-28 16:44.
Executar antes de ela virar card faz o card **nascer** no DUILIO; depois, seria um
card para mover.

## 8. Resíduo conhecido (cosmético, NÃO se autocorrige)

A RPC cria a linha em `clientes` usando `v_nome`, que cai pro **próprio CNPJ** quando
o cliente é desconhecido (não há `clientes.nome` nem `cards.pagador` pra herdar). Os 3
nascerão com `nome = '<cnpj>'` em vez de "JPES COM. ATACA C.".

**Não se corrige sozinho:** `_shared/registrar-contato-cliente.ts:57-61` só faz INSERT
quando o cliente falta — **nunca UPDATE do nome**. Nenhuma outra edge function escreve
em `clientes`.

Corrigir exige `UPDATE public.clientes SET nome = ...` = **TIPO B** →
decisão/execução do Caio. Não impacta roteamento, RLS nem cards; é só exibição.

## 9. Validação pós-execução (critérios de conclusão)

- [ ] Relatório JSON dos 3 sem erro; campo `avisos` lido
- [ ] Os 3 CNPJs na carteira do DUILIO e **em nenhuma outra**
- [ ] `clientes.segmento_codigo = '022'` nos 3
- [ ] Invariante global "1 CNPJ = 1 operador" preservada em todo o sistema
- [ ] Re-execução devolve relatório zerado (idempotência)
- [ ] **Critério final:** o primeiro card do JPES (NF 89554, oc=8) nasce com
      `assigned_operator_id = DUILIO` sem intervenção

## 10. Reversão

Mesma RPC apontando `p_operador_destino => 'VICTOR'` com o segmento anterior. Como
não há cards/contatos/tracking envolvidos, a reversão é limpa: só carteira e catálogo.
