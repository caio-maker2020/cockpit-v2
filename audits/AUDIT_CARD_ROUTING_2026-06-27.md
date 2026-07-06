# Auditoria READ-ONLY de roteamento de cards Bastão/Cockpit

**Data do snapshot:** 2026-06-27 ~13:20 BRT · **Escopo:** estados ativos de relacionamento
(`AGUARDANDO_CLIENTE`, `AGUARDANDO_VALIDACAO_HUMANA`, `AGUARDANDO_AGENTE`, `EXTRAVIO_MONITORADO`).
**Total de cards no escopo:** 946.

> **Garantia.** Nada foi alterado. Toda consulta roda em transação `READ ONLY`
> (`SET TRANSACTION READ ONLY`) — o Postgres aborta qualquer escrita. Não foi
> criada view/tabela/função, não se tocou em RLS nem em `sync-bastao`. O artefato
> re-rodável é [audit-card-routing.sql](audit-card-routing.sql):
> `psql "$SUPABASE_DB_URL" -f audits/audit-card-routing.sql`
>
> Atende ao **Passo 1 / P0** de [CARDS_BASTAO_REGRESSION_FOCUS.md](CARDS_BASTAO_REGRESSION_FOCUS.md) §6.

---

## 1. Placar (TL;DR)

| Categoria | Qtd | Severidade |
|---|---:|---|
| **Cards SEM dono que deveriam ter** (resolver não atribui) | **11** | 🔴 invisíveis (só gestor vê) |
| **Card em dono INATIVO** (DURAFA, offboarded) | **1** | 🔴 invisível (só gestor vê) |
| Cards no operador-sistema `COCKPIT` (parecem teste) | 2 | 🟡 revisar/limpar |
| **Dono ERRADO** (atribuído a operador ativo errado) | **0** | 🟢 |
| **Conflitos latentes** carteira × responsável/segmento do Bastão | ~28 | 🟡 revisar caso a caso |
| CNPJ em 2+ carteiras | **0** | 🟢 |
| **Gap sistêmico**: `segmento_codigo` ausente/divergente | **934 / 938** | 🟠 visibilidade por segmento morta |

**Veredito:** o roteamento por **carteira (CNPJ) está consistente** — 0 cards no operador ativo
errado, 0 CNPJ em duas carteiras. O risco real está em **3 quebras estruturais** que derrubam
todas as redes de segurança e deixam **12 cards visíveis só para o gestor**:

---

## 2. Como o roteamento funciona hoje (e onde quebra)

**Dono (`assigned_operator_id`)** é resolvido por [operador-resolver.ts:127-189](../supabase/functions/_shared/operador-resolver.ts#L127-L189),
cascata **exata**:

1. `cnpj_excluido` — CNPJ em `cnpjs_excluidos_cockpit(ativo)` → **sem dono**
2. `carteira_cnpj` — 1 operador `ativo + cockpit_ativo` com o CNPJ em `carteira` → **esse operador**
3. `carteira_dormente` — CNPJ pertence a operador `ativo` mas `cockpit_ativo=false` → **sem dono** (curto-circuito; não cai pra nome/segmento)
4. `responsavel_nome` — 1 operador ativo+cockpit cujo `nome` == responsável do Bastão → esse operador
5. `segmento` — 1 operador ativo+cockpit cujo `segmentos` contém o hint → esse operador
6. `nenhum` — **sem dono** (gestor revisa)

**Visibilidade (RLS)** em `cards` ([mig 242](../migration/)) é um OR de 4 predicados:
`papel='gestor'` · `assigned_operator_id = eu` · `pagador = ANY(carteira)` · `segmento_codigo = ANY(segmentos)`.

### As 3 quebras de raiz

- **[R1] Fallback de segmento está MORTO.** Os 5 call-sites passam o hint cru
  `segmentoCodigo: p.segmento_cliente` ([sync-bastao:1129](../supabase/functions/sync-bastao/index.ts#L1129), 2190, 2552; [vinculador:790](../supabase/functions/vinculador/index.ts#L790); sync-prioridades:143). Mas `p.segmento_cliente`
  é o **rótulo completo** (`"043 - CURVA F"`), enquanto `operadores.segmentos` guarda o **código**
  (`"043"`). O resolver faz `includes()` **exato** ([linha 179](../supabase/functions/_shared/operador-resolver.ts#L179)) → **nunca casa**.
  Consequência: **nenhum** card é atribuído por segmento. Quem não tem CNPJ em carteira nem nome
  batendo cai em "sem dono", mesmo com segmento óbvio (043 → ISA E KAROL).
- **[R2] `cards.segmento_codigo` quase nunca é gravado** (904 de 938 nulos, 30 divergentes). O
  predicado RLS de segmento é morto. Visibilidade por segmento não existe na prática.
- **[R3] `cards.pagador` é NOME, não CNPJ.** O predicado RLS `pagador = ANY(carteira)` compara
  nome contra lista de CNPJs → sempre falso.

**Efeito combinado:** R2 + R3 derrubam 2 dos 4 predicados de RLS. **A visibilidade do operador
depende SÓ de `assigned_operator_id`.** Logo, qualquer card com `assigned_operator_id` nulo ou
apontando para operador inativo fica **invisível para todos, exceto gestor** — sem rede de segmento
ou carteira para recuperá-lo.

---

## 3. Resumo por operador (Saída 2 do script)

| Dono atual | Atribuídos | OK (bate resolver) | Dono errado | Sem base no resolver | Dono inativo |
|---|---:|---:|---:|---:|---:|
| VICTOR | 222 | 222 | 0 | 0 | 0 |
| DUILIO | 215 | 215 | 0 | 0 | 0 |
| CAMILA | 163 | 163 | 0 | 0 | 0 |
| JULIA | 124 | 124 | 0 | 0 | 0 |
| LARISSA | 113 | 113 | 0 | 0 | 0 |
| ISA E KAROL | 95 | 95 | 0 | 0 | 0 |
| **— SEM DONO** | **11** | 0 | 0 | 0 | 0 |
| COCKPIT (sistema) | 2 | 0 | 0 | 2 | 0 |
| DURAFA (inativo) | 1 | 0 | 0 | 1 | 1 |

Todos os 6 operadores humanos ativos batem 100% com o resolver — **o que está atribuído está certo**.
O problema é o que **não** está atribuído (11) e o que ficou preso em conta errada (DURAFA + COCKPIT).

---

## 4. Cards SEM dono que deveriam aparecer (11) — 🔴 invisíveis exceto gestor

**Todos os 11 são segmento 043 (CURVA F) → dono correto = ISA E KAROL**, mas o resolver os deixa
órfãos porque a carteira da ISA não cobre o CNPJ **e** o fallback de segmento está morto **[R1]**.
Agravante: o Bastão manda `responsavel_relacionamento = "KAROL E ISA"`, que **também** não casa com
o nome do operador `"ISA E KAROL"` (ordem invertida) — o fallback por nome (Path 4) morre junto.

| NF | CTRC | CNPJ | Segmento | State | OC | Pagador |
|---|---|---|---|---|---:|---|
| 1023206 | AMB237719-5 | 09601946000188 | 043 | AVH | 49 | AUTO PCS MEC |
| 12635 | TBH387477-0 | 32768944000108 | 043 | AGUARDANDO_CLIENTE | 54 | MAXTURBO |
| 206261 | APO300256-0 | 86392529000466 | 043 | AVH | 49 | SAL EXP. TRANSP |
| 206262 | APO300267-5 | 86392529000466 | 043 | AVH | 49 | SAL EXP. TRANSP |
| 2206263 | APO356106-2 | 86392529000466 | 043 | EXTRAVIO_MONITORADO | 6 | SAL EXP. TRANSP |
| 28472 | TBH415441-0 | 31893116000120 | 043 | EXTRAVIO_MONITORADO | 9 | BHZ EPI |
| 30016 | TBH385104-4 | 06133273000190 | 043 | AVH | 49 | BRASQUIMICA |
| 4345 | AMB293782-4 | 18081748000121 | 043 | AVH | 20 | VETCLEAN |
| 453640 | ACW179856-1 | 55847057002409 | 043 | AGUARDANDO_CLIENTE | 54 | FORT LUB |
| 5570657 | AMB219494-5 | 02415741000169 | 043 | AGUARDANDO_CLIENTE | 54 | DELIO ARAUJO |
| 656363 | AMB311944-1 | 49816918000100 | 043 | AVH | 49 | DOUGLAS AUTO |

**Regra que causou:** `nenhum` (resolver) — raiz **[R1]** (segmento label×código) + variante de nome
"KAROL E ISA" ≠ "ISA E KAROL".
**Ação sugerida (NÃO aplicada):** atribuir à ISA E KAROL. Correção durável = consertar [R1] (passar
o código, não o rótulo) **ou** incluir os CNPJs na carteira da ISA.

---

## 5. Card em dono INATIVO + cards de teste

- **DURAFA — NF 1153** (CTRC AMB076360-8, CNPJ 21464161000106, segmento **022 MOTOBIKE**, oc 54,
  AGUARDANDO_CLIENTE). DURAFA está `ativo=false` (offboarded) → card **invisível exceto gestor**.
  Dono correto por segmento 022 = **DUILIO**, mas [R1] impede a reatribuição automática.
  **Ação:** reatribuir a DUILIO.
- **COCKPIT (sistema) — NF 123456 e 123457** (CTRC VG1000006/7, pagador "DUILIO DE DEUS", sem
  CNPJ/segmento). Têm cara de **dados de teste**. **Ação:** confirmar e limpar/atribuir.

---

## 6. Conflitos latentes: carteira × responsável/segmento do Bastão (~28) — 🟡 revisar

Estão atribuídos ao **dono de carteira (CNPJ)**, que **vence por regra de projeto** (carteira >
nome/segmento, fix NF 568107 NORTEL). Mas o Bastão classifica o cliente em **outro** operador. Não
são erros do resolver — são **possíveis erros de cadastro de carteira** (um cliente de um segmento
acabou na carteira de outro operador). Cada caso precisa de olho humano.

| Dono atual (carteira) | Bastão diz | Qtd | Exemplo (cliente / CNPJ) |
|---|---|---:|---|
| VICTOR | ISA E KAROL | ~18 | LOLLIPOPS COSMETICS / 24566797000904 · FRIORIO / 44039854000238 (ambos 043) |
| ISA E KAROL | CAMILA | 7 | ATACADO UNIAO / 12377080000188 (segmento 001 AUTO PEÇAS) |
| DUILIO | ISA E KAROL | 3 | TOTAL MAXPARTS / 03585187000120 · ASTRA / 50949528000180 (043) |
| VICTOR | LARISSA | 1 | — |

**Pergunta para o gestor:** esses CNPJs estão na carteira certa? Se LOLLIPOPS é da carteira do
VICTOR de propósito, está OK (a 043 é "full-pull por exceção", clientes nominais ainda podem ter
dono). Se não, é cadastro de carteira a corrigir.

---

## 7. Gap sistêmico: visibilidade por segmento morta (Saída 4) — 🟠

Dos **938** cards ativos com segmento vindo do Bastão: **904 com `segmento_codigo` NULL** e **30
divergentes** → só ~4 gravados. O predicado RLS de segmento **[R2]** é inerte. Combinado com o
predicado de carteira inerte **[R3]**, **a RLS hoje protege/expõe cards quase exclusivamente por
`assigned_operator_id`**. Não há rede de segurança: errou o `assigned_operator_id`, o card some para
o operador (vide os 12 cards das seções 4–5).

## 8. CNPJ em duas carteiras — 🟢 0

Nenhum CNPJ aparece em mais de uma carteira (entre todos os operadores, inclusive dormentes). A
regra "1 CNPJ = 1 operador" está íntegra no cadastro.

---

## 9. Recomendações (ordem segura — **nada aplicado aqui**)

1. **Imediato, baixo risco (dados):** atribuir os 11 órfãos 043 à ISA E KAROL; reatribuir NF 1153
   à DUILIO; resolver os 2 cards COCKPIT (teste?). São 14 cards, sem mudança de comportamento.
2. **Raiz [R1] (corrige a causa dos órfãos):** no resolver/sync, normalizar o hint de segmento para
   o **código** (`left/regex dos 3 dígitos`) antes do `includes()`, **ou** comparar por prefixo.
   Backar com teste (label "043 - CURVA F" deve casar com `{043}`). Validar antes/depois por operador.
3. **Normalizar nome do Bastão** ("KAROL E ISA" ↔ "ISA E KAROL") antes do Path 4, ou tratar como
   alias da ISA — senão o fallback por nome continua furado.
4. **[R2] Gravar `segmento_codigo`** no insert e no update do `sync-bastao` (e incluir no
   `precisaEscrever`), com o **código** extraído do rótulo — restaura a RLS por segmento.
5. **[R3] / RLS por CNPJ:** só depois, com relatório antes/depois por 2-3 dias, migrar o predicado
   de carteira para um `cnpj_pagador` canônico em `cards` (hoje o predicado por `pagador`-nome é morto).

**Não mexer agora (risco alto):** abrir o filtro do Bastão, remover a trigger antiga
`cards_resolve_operator`, ou trocar a RLS direto sem o relatório antes/depois (ver §7 de
[CARDS_BASTAO_REGRESSION_FOCUS.md](CARDS_BASTAO_REGRESSION_FOCUS.md)).

---

## 10. Como re-rodar

```bash
psql "$SUPABASE_DB_URL" -f audits/audit-card-routing.sql
```

Saídas: (1) divergências de dono + conflitos por card com ação sugerida; (2) matriz por operador;
(3) CNPJ em 2+ carteiras; (4) gap de `segmento_codigo`. Tudo `READ ONLY`.
