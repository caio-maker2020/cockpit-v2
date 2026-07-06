# Fase 1 — Fechamento (roteamento de cards Bastão/Cockpit)

**2026-06-27 · encerrada.** Contenção e medição confiável + correções pontuais aprovadas, caso a caso.
Não avançar para a Fase 2 (resolver/sync) — será execução separada.

---

## 1. Auditoria read-only final (placar)

Fonte: [audit-card-routing.sql](audit-card-routing.sql) v2 (réplica fiel da RLS real). Escopo = estados
ativos de relacionamento (944→941 cards após encerramentos).

| Métrica | Valor final | Confirmação |
|---|---:|---|
| Total ativos | 941 | — |
| **Invisíveis p/ operador comum** | **1** | só NF 2206263 (pendência operacional — ver §4) |
| **Sem dono** | **1** | o mesmo NF 2206263 |
| **Dono inativo** | **0** | ✅ (DURAFA removida) |
| **Dono errado (operador ativo)** | **0** | ✅ |
| **CNPJ em 2+ carteiras** | **0** | ✅ |

Início da Fase 1: 4 invisíveis + 1 dono inativo. Fim: 1 invisível (deliberado) + 0 dono inativo.

---

## 2. Cards e cadastros alterados (valores antigos → novos)

| # | Entidade | Campo | Antigo | Novo |
|---|---|---|---|---|
| 1 | Card NF **5570657** (DELIO) | assigned_operator_id | `NULL` | ISA E KAROL `f67db0fc…` |
| 1 | " | responsavel_relacionamento | `KAROL E ISA` | `ISA E KAROL` |
| 1 | " | state | `AGUARDANDO_CLIENTE` | **inalterado** |
| 2 | Card NF **1153** (DURAFA) | assigned_operator_id | DURAFA `c322f605…` | DUILIO `01b205c1…` |
| 2 | " | responsavel_relacionamento | `DURAFA` | `DUILIO` |
| 2 | " | state | `AGUARDANDO_CLIENTE` | **inalterado** |
| 3 | Operador **DURAFA** (demitida) | segmentos | `{022}` | `{}` |
| 3 | " | user_id | `ffe86db0…` | `NULL` |
| 3 | " | ativo / cockpit_ativo | false / false | inalterado (já off) |
| 4 | Operador **DUILIO** | carteira | 56 CNPJs | 57 (+`21464161000106`) |
| 5 | Card NF **206261** (SAL EXP) | state | `AGUARDANDO_VALIDACAO_HUMANA` | `CANCELADO` |
| 6 | Card NF **206262** (SAL EXP) | state | `AGUARDANDO_VALIDACAO_HUMANA` | `CANCELADO` |
| 7 | `cnpjs_excluidos_cockpit` | linha | (inexistente) | +`86392529000466` (ativo) |

Todas as alterações de card: **event-sourced** (`AssignedOperadorCorrigidoManualmente` /
`CardEncerradoCnpjExcluido`), em transação única, idempotentes (guard em `assigned`/`state`), com
SELECT antes/depois. Reversões registradas no histórico de execução e na memória do projeto.

### Durabilidade (não revertem no próximo sync)
- **5570657 / 1153:** CNPJ na carteira do dono → resolver concorda.
- **206261 / 206262:** CNPJ na blacklist → `sync-bastao` pula o CNPJ (`return "unchanged"`,
  [sync-bastao:1438](../supabase/functions/sync-bastao/index.ts#L1438)) → encerramento fixa.

---

## 3. Casos sem alteração
- **NF 123456 / 123457** (testes): já estavam terminais (RESOLVIDO/CANCELADO) — no-op.

---

## 4. Pendência por decisão operacional — NF 2206263

**NF 2206263** (SAL EXP, `EXTRAVIO_MONITORADO`, oc 6, `origem=extravio_perdas`) **permanece sem dono /
invisível ao operador comum por decisão sua (opção i)**: é card do kanban de **Extravios/Perdas**, não
da fila de Relacionamento. Motivo técnico: o fluxo de extravios **não honra** `cnpjs_excluidos_cockpit`,
então um encerramento aqui poderia ser revertido pelo reconciliador de extravios. Tratamento durável
exigiria mudança de código no fluxo de extravios (Fase posterior) — **fora do escopo da Fase 1**.

---

## 5. Confirmação de não-alteração de regra sensível

Verificado por `git status` (nada modificado) — **nesta Fase 1 NÃO foram alterados**:
- ❌ **RLS de cards** — nenhuma migration de RLS criada/alterada.
- ❌ **Trigger `cards_resolve_operator`** — intacta (continua ativa como estava).
- ❌ **`sync-bastao/index.ts`** — não modificado.
- ❌ **`operador-resolver.ts`, `vinculador`, `sync-prioridades-ai-do-bastao`** — não modificados.
- ❌ **Backfill amplo** — não realizado.

Alterações desta fase restritas a: (a) **dados pontuais** (4 casos aprovados) e (b) o **script/relatórios
de auditoria** em `audits/` (untracked). Nada de código de roteamento, RLS ou trigger.

---

## 6. Próximo passo (NÃO iniciado)
**Fase 2 — normalizar segmento no resolver** (`operador-resolver.ts`: aceitar `043` e `043 - CURVA F`),
com teste de regressão e validação pós-sync. É a raiz dos órfãos 043. Será aberta em **execução
separada**, com SQL/diff mostrado antes e parada para aprovação.
