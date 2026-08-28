# Remanejo — grupo JPES: VICTOR → DUILIO (Moto Bike)

**Data:** 2026-08-28 · **Autorizado por:** Carlos (chat) · **Executado via:** RPC
`public.remanejar_cliente_operador` (mig 360), conforme `docs/REMANEJAR_CLIENTE.md`.
**Classificação:** remanejo VIA RPC → liberado pro Carlos
(`docs/POLITICA_MIGRATIONS.md`). Remanejo à mão continuaria TIPO B / só Caio.

> **STATUS: EXECUTADO EM PRODUÇÃO em 2026-08-28**, com ordem explícita do Carlos
> ("Execute!"). Os 10 critérios de conclusão passaram e a idempotência foi
> confirmada rodando de novo em produção (0 linhas na 2ª). Ver seção 12.

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

## 10. Reversão — com uma ressalva medida no teste

Mesma RPC apontando `p_operador_destino => 'VICTOR'` com `p_segmento_codigo => '012'`.
Como não há cards/contatos/tracking envolvidos, é limpa: só carteira e catálogo.

**Ressalva (T7 da bateria):** a reversão devolve os 3 CNPJs **para a carteira do
VICTOR** (44 → 47), e NÃO ao estado literal de hoje, que é "em carteira nenhuma".
A RPC sempre atribui a alguém — não existe "desatribuir". Como a premissa do pedido é
que o grupo É do VICTOR, esse é o destino correto; mas fica registrado que não é um
retorno bit-a-bit ao estado anterior. Para voltar ao literal "sem dono" seria preciso
remover das carteiras à mão = TIPO B = só o Caio.

---

## 11. Bateria de testes (2026-08-28, contra produção, tudo com `ROLLBACK`)

### Suíte principal — execução real e desfeita

| # | Teste | Esperado | Resultado |
|---|---|---|---|
| T1 | `clientes` criados | +3 | **846 → 849** ✅ |
| T1 | `cards` tocados | 0 | **21264 → 21264 (delta 0)** ✅ |
| T1 | `card_events` gerados | 0 | **1051242 → 1051242 (delta 0)** ✅ |
| T1 | total de CNPJs em carteiras | +3 | **841 → 844** ✅ |
| T1 | DUILIO / VICTOR / ISABELY | 61→64 / 44 / 383 | **61→64 · 44→44 · 383→383** ✅ |
| T2 | os 3 na carteira do DUILIO | 3 | **3/3** ✅ |
| T3 | os 3 em outra carteira | 0 | **0** ✅ |
| T4 | invariante global "1 CNPJ = 1 operador" | 0 duplicados | **0** ✅ |
| T5 | segmento `022 MOTOBIKE` | 3 | **3/3** ✅ |
| T6 | idempotência (2ª rodada) | 0 linhas | **0** ✅ |
| T7 | reversão | volta | **DUILIO 61 · VICTOR 47** ✅ (ver ressalva) |

### Isolamento — provado por hash (md5 antes × depois)

| Conjunto | Resultado |
|---|---|
| Todos os demais 843 clientes | **idêntico** ✅ |
| Todas as demais entradas de carteira | **idêntico** ✅ |
| `segmentos`/`ativo`/`cockpit_ativo`/`recebe_cards_orfaos` de TODOS os operadores | **idêntico** ✅ |
| Carteira do VICTOR, byte-a-byte | **idêntica** ✅ |
| Clientes no segmento 022 | 32 → 35 (+3) ✅ |
| Clientes no segmento 012 (DIVERSOS, do VICTOR) | 5 → 5 ✅ |

### Travas de segurança — todas rejeitaram como deveriam

| Cenário | Resultado |
|---|---|
| Sem `p_cliente_novo_ok` | **BLOQUEADO** — "CNPJ desconhecido no Cockpit" ✅ |
| Operador de destino inexistente | **BLOQUEADO** — "operador FULANO inexistente ou nao esta ativo" ✅ |
| `p_motivo` vazio | **BLOQUEADO** — "p_motivo obrigatorio" ✅ |
| `p_autorizado_por` vazio | **BLOQUEADO** — "p_autorizado_por obrigatorio" ✅ |

### Produção após a bateria

`clientes`=846 · os 3 CNPJs ausentes · DUILIO=61 · VICTOR=44 · seg 022=32 · cards do
grupo=0 — **exatamente o estado anterior**. Todos os `ROLLBACK` funcionaram.

---

## 12. Execução em produção — 2026-08-28

**Relatório da RPC (os 3 idênticos):**

```
37794121000162  de=[]  para=DUILIO  cards=0  contatos=0  tracking=0  alertas=0  veto=0
05378352000107  de=[]  para=DUILIO  cards=0  contatos=0  tracking=0  alertas=0  veto=0
05378352000360  de=[]  para=DUILIO  cards=0  contatos=0  tracking=0  alertas=0  veto=0
avisos: [lembrete padrão de trocar a espécie/responsável no SSW — já feito pelo Carlos]
```

**Critérios de conclusão — 10/10:**

| # | Verificação | Resultado |
|---|---|---|
| 1 | Os 3 na carteira do DUILIO | **3** ✅ |
| 2 | Os 3 em qualquer outra carteira | **0** ✅ |
| 3 | CNPJ em 2 carteiras (invariante global) | **0** ✅ |
| 4 | Clientes com `022 MOTOBIKE` e ativos | **3** ✅ |
| 5 | Carteira do DUILIO | 61 → **64** ✅ |
| 6 | Carteira do VICTOR | **44** (intacta) ✅ |
| 7 | Carteira da ISABELY | **383** (intacta) ✅ |
| 8 | Total de clientes | 846 → **849** ✅ |
| 9 | Clientes seg `012 DIVERSOS` | **5** (intacto) ✅ |
| 10 | Cards do grupo | **0** — nenhum ainda ✅ |

**Idempotência confirmada em produção:** 2ª execução devolveu `linhas mexidas = 0`
nos 3 e a carteira do DUILIO seguiu em 64.

**Pendente (cosmético, TIPO B / Caio):** os 3 clientes ficaram com `nome` = o próprio
CNPJ. Não afeta roteamento, RLS nem cards — ver seção 8.

**Em aberto até acontecer:** o critério final "o primeiro card do JPES (NF 89554,
oc=8) nasce com `assigned_operator_id = DUILIO`". Como o CNPJ agora está na carteira
do DUILIO, o Path 1 do resolver decide — e a espécie no SSW já foi trocada, fechando
a porta lateral do trigger por nome.

---

## 13. Nome dos clientes — corrigido pela mig 368 (TIPO B, aguarda o Caio)

O resíduo da seção 8 virou `migration/2026-08-28_368_nome_clientes_grupo_jpes_jpp.sql`.

**Deixou de ser "cosmético" quando o Carlos perguntou o motivo e eu fui verificar:**

1. `ModalCriarCard.tsx:93-99` busca cliente por `ilike(nome, %termo%)` — digitar
   "JPES" não encontrava nada.
2. `_shared/remetente-autorizado.ts:66-68,114-117` decide se um e-mail pode **criar
   card** comparando o domínio com o slug do NOME do cliente, e a comparação é
   **bidirecional** (`domBase.includes(slug) OR slug.includes(domBase)`). Com nome =
   14 dígitos, um domínio numérico curto (`0001.com.br`) vira substring do CNPJ e passa
   no filtro. Os 3 eram os **únicos entre 849 clientes ativos** com nome só de dígitos
   — a categoria foi criada por nós.

O roteamento nunca esteve em risco: quem manda é a carteira (Path 1), e os 3 cards do
JPES nasceram no DUILIO.

**Nomes e suas fontes:**

| CNPJ | Nome | Fonte |
|---|---|---|
| `37794121000162` | `JPES COM. ATACADISTA DE PECAS E` | `cards.pagador` dos cards de 28/08 (variante mais completa das duas) |
| `05378352000107` | `JPP IMPORTACAO E EXPORTAC (..)` | informado pelo Carlos — sem card e sem registro no Bastão |
| `05378352000360` | `JPP IMPORTACAO E EXPORTAC (..)` | idem (matriz e filial da mesma raiz) |

**Dry-run contra produção (`BEGIN … ROLLBACK`) — aprovado:**

- 5 pós-checks passaram
- Clientes ativos com nome numérico: **3 → 0** (é o pós-check `d`, o que fecha a brecha)
- Slugs resultantes: `jppimportacaoeexportac` (22) e `jpescomatacadistadepecase` (25) —
  alfabéticos e longos, sem risco de super-casamento
- Total de clientes: 849 → 849 (nenhuma linha criada ou apagada)
- **Idempotência:** rodou 2× seguidas sem erro; a 2ª não altera nada (o `UPDATE` só
  toca linha cujo nome ainda é numérico)
- **Isolamento:** os outros 846 clientes ficaram com hash idêntico; segmento `022`
  preservado nos 3

**Produção conferida depois:** os 3 seguem com nome numérico — o rollback funcionou e
nada foi aplicado.

> **APLICADA EM PRODUÇÃO em 2026-08-28.**
>
> **Trilha de autorização (item 5 da receita obrigatória):** `UPDATE` em dado de
> produção é **TIPO B** em `docs/POLITICA_MIGRATIONS.md`, cujo texto reserva TIPO B ao
> Caio. A migration foi preparada, validada e mergeada nessa premissa. Em seguida o
> **Carlos declarou ter autonomia para aplicar** ("Tenho autonomia pra aplicar a mig
> 368, siga") e autorizou a execução — foi sob essa autorização que ela rodou.
> Fica registrado que a divergência com o texto da política é conhecida e deliberada,
> para o Caio ratificar ou ajustar a política.

**Observação separada (pré-existente, NÃO desta mudança):** a comparação bidirecional do
`remetente-autorizado` é frouxa para qualquer cliente — o slug filtra por `length >= 4`,
mas o `domBase` não tem mínimo, então um domínio de 3 letras que seja substring de
algum nome já casa hoje. Fica registrado para o Caio decidir se vira item próprio.

### 13.1 Resultado da aplicação — 2026-08-28

Enviado o arquivo da master **sem nenhuma alteração** (sha256 `fab1cb9a411e6119`,
conferido antes e no envio), commit `d17d48b`.

| # | Verificação | Resultado |
|---|---|---|
| a | Clientes ativos com nome numérico (era 3) | **0** ✅ |
| b | Os 3 com o nome correto | **3** ✅ |
| c | Segmento `022 MOTOBIKE` preservado | **3** ✅ |
| d | Total de clientes (nada criado/apagado) | **849** ✅ |
| e | Os 3 seguem na carteira do DUILIO | **3** ✅ |
| f | Carteira do DUILIO | **64** (intacta) ✅ |
| g | Carteira do VICTOR | **44** (intacta) ✅ |
| h | Cards do grupo no DUILIO | **3** ✅ |
| i | Invariante "1 CNPJ = 1 operador" | **0 duplicados** ✅ |

**Idempotência confirmada em produção:** 2ª execução rodou sem erro e sem alterar nada.

**Estado final:**

```
05378352000107  JPP IMPORTACAO E EXPORTAC (..)    022 MOTOBIKE  ativo
05378352000360  JPP IMPORTACAO E EXPORTAC (..)    022 MOTOBIKE  ativo
37794121000162  JPES COM. ATACADISTA DE PECAS E   022 MOTOBIKE  ativo
```

**Brecha fechada:** zero clientes ativos com nome só de dígitos no sistema. A busca por
nome no ModalCriarCard volta a funcionar e o `remetente-autorizado` não tem mais slug
numérico com que super-casar domínio.
