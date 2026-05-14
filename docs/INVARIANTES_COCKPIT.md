# INVARIANTES_COCKPIT.md — Regras que NÃO podem ser violadas

Catálogo canônico de invariantes da arquitetura Cockpit v2. Cada invariante tem comando de verificação **executável** — não apenas descrição textual.

**Quando atualizar:** todo bug post-mortem que cruza ≥ 2 arquivos críticos vira novo `INV-NNN` aqui (regra durável).

**Como usar:**
- Operador editando arquivo crítico → hook PreToolUse exibe lista de INVs aplicáveis.
- `/verify-cockpit` Fase 8 executa cada INV e reporta PASS/FAIL.
- Bug em produção → procura INV violado. Se nenhum bate, escreve novo INV pro cenário.

---

## INV-001 — Bastão é INPUT canônico; SSW interno é SAÍDA

**Regra:** Cards entram no Cockpit via Bastão (sync periódico). Decisões de SAÍDA (TRANSFERIDO/RESOLVIDO/AGUARDANDO_CLIENTE/AVH) consultam SSW interno (opção 101). Tracking SSW público (`lib/ssw-tracking-client.ts`) está deprecated — sem novos callers.

**Arquivos:** todos os edge functions que decidem destino de card. Hot paths: `sync-bastao`, `voltar-para-to-do-com-rastreio`, `r-evidencia`, `executor`, `_shared/verificar-evidencia.ts`.

**Como verificar:**
```bash
grep -RIn 'from.*"\.\..*ssw-tracking-client' supabase/functions/ 2>/dev/null \
  | grep -v "@deprecated\|//\|_shared/ssw-tracking-client.ts" \
  | wc -l
# = 0 → PASS. > 0 → FAIL (novo caller do tracking público).
```

**Memory:** [project_ssw_interno_fonte_saida.md](memory/project_ssw_interno_fonte_saida.md), [project_tracking_publico_deprecated.md](memory/project_tracking_publico_deprecated.md)
**ADR:** [docs/decisions/0005-ssw-interno-fonte-canonica-saida.md](decisions/0005-ssw-interno-fonte-canonica-saida.md)
**Cenário real:** múltiplos bugs de latência RPA Bastão (NFs 26298, 64409, 422589, 1075381).

---

## INV-002 — `confirmar-acao-executada-ssw` PRESERVA snapshot Bastão pré-lançamento

**Regra:** ao mover card de ACAO_EXECUTADA → state final via SSW interno, o helper NÃO pode zerar `bastao_oc_no_lancamento` nem `bastao_updated_at_no_lancamento`. Esses 2 campos compõem a referência histórica que o Pass A do sync-bastao usa pra distinguir "Bastão re-importou mesmo snapshot" de "Bastão atualizou com nova tratativa".

**Arquivos:** `supabase/functions/_shared/confirmar-acao-executada-ssw.ts`.

**Como verificar:**
```bash
# Ausência de "bastao_oc_no_lancamento: null" e "bastao_updated_at_no_lancamento: null"
# dentro de updates do card.
grep -E "bastao_oc_no_lancamento:\s*null|bastao_updated_at_no_lancamento:\s*null" \
  supabase/functions/_shared/confirmar-acao-executada-ssw.ts | wc -l
# = 0 → PASS. > 0 → FAIL (campo sendo limpo — bug NF 1075381 voltou).
```

**Memory:** [feedback_bastao_oc_no_lancamento_guard.md](memory/feedback_bastao_oc_no_lancamento_guard.md)
**Cenário real:** NF 1075381 reabriu indevidamente em 2026-05-14 porque o helper limpava o snapshot, anulando a guarda do Pass A.

---

## INV-003 — Pass A `voltouParaRelacionamento` usa guard por OC do lançamento

**Regra (final 2026-05-14):** card que já passou por lançamento (`bastao_oc_no_lancamento != null`) e Bastão mostra a MESMA oc do lançamento → `bastaoEhMesmoSnapshotDoLancamento = true` → `voltouParaRelacionamento = false` → NO-OP completo (não muda state, não cria todo, não cancela nada).

Operação re-tratativa com oc DIFERENTE → guard libera → reabertura normal via `stateFinalAposBastao`. Re-tratativa com MESMA oc é caso raro tratado por outros canais (vinculador via email do cliente, ATUALIZAR AGORA manual da Larissa).

**Histórico:** versões anteriores tentaram tupla `(oc + updated_at)` (migration 095) e `pendencia_id` (migration 096). Ambas falharam porque o Bastão muda `updated_at` e `pendencia_id` várias vezes por hora sem mudança semântica de oc. Discriminador final = oc, alinhado com "SSW interno é prioridade absoluta sobre Bastão" (Caio 2026-05-14).

**Arquivos:** [sync-bastao/index.ts:706-718](../supabase/functions/sync-bastao/index.ts#L706-L718) (`upsertCardFromPendencia`).

**Como verificar:**
```bash
# (a) Guard existe
grep -c "bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts
# >= 2 (declaração + uso) → PASS

# (b) SELECT do Pass A carrega bastao_oc_no_lancamento (sem isso guard vira letra morta)
grep -E '\.select\([^)]*bastao_oc_no_lancamento' supabase/functions/sync-bastao/index.ts | head -1
# match → PASS, vazio → FAIL

# (c) Guard usa oc (não pendencia_id ou updated_at — discriminadores que falharam)
grep -A 4 "const bastaoEhMesmoSnapshotDoLancamento" supabase/functions/sync-bastao/index.ts \
  | grep -q "p.cod_ultima_ocorrencia === bastaoOcNoLancamento"
# match → PASS

# (d) Cards travados em loop (state=AVH+lock + oc=oc_no_lançamento + acao_executada_em IS NULL) ≤ 5
psql "$SUPABASE_DB_URL" -tA -c "select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and lock_aguardando_validacao=true and bastao_oc_no_lancamento is not null and cod_ultima_ocorrencia = bastao_oc_no_lancamento and acao_executada_em is null and bastao_synced_at > now() - interval '1 hour';"
# 0 → PASS (mais que isso = loop está acontecendo de novo)
```

**Memory:** [feedback_pass_a_select_completo.md](memory/feedback_pass_a_select_completo.md), [feedback_bastao_oc_no_lancamento_guard.md](memory/feedback_bastao_oc_no_lancamento_guard.md)
**Cenário real:** 2026-05-14 — 5 NFs (1005270, 177817, 1074810, 20958, 1006425) em loop de reabertura. Larissa retrabalhou cada uma múltiplas vezes antes do fix final.
**Cenário oposto (não pode bloquear):** Bastão mostra oc nova (ex: oc=49 após oc=20 do lançamento) — guard libera, card reabre pra Larissa rastrear.

---

## INV-004 — Pass A SEMPRE preserva campos críticos no `agent_state`

**Regra:** quando Pass A reescreve `agent_state` (UPDATE de card existente), PRECISA preservar `chave_cte`, `propostas_recusadas_em`, `propostas_recusadas_para_oc`, `bastao_updated_at`. Esses campos vêm de outros lugares (chave-cte-resolver, voltar-para-to-do-com-rastreio, snapshotFromPendencia) e são lidos por callers downstream.

**Arquivos:** `supabase/functions/sync-bastao/index.ts`.

**Como verificar:**
```bash
# Bloco de preservação no Pass A (em volta da declaração de agentStateNovo)
grep -A 25 'agentStateExistente = ' supabase/functions/sync-bastao/index.ts \
  | grep -E "chave_cte|propostas_recusadas_em|propostas_recusadas_para_oc|bastao_updated_at" \
  | wc -l
# >= 4 → PASS (todas as 4 chaves citadas no bloco).
```

**Memory:** [project_chave_cte_lookup_obrigatorio.md](memory/project_chave_cte_lookup_obrigatorio.md), [project_cooldown_recusa_sugestoes.md](memory/project_cooldown_recusa_sugestoes.md)
**Cenário real:** NF 422476 (chave_cte perdida); NFs 64409/422589 (cooldown propostas_recusadas perdido).

---

## INV-005 — `voltar-para-to-do-com-rastreio` consulta SSW interno (NÃO tracking público)

**Regra:** o botão "Recusar Ações Sugeridas" decide destino do card via `ssw-internal-client.obterSessao + buscarNFInterno + listarOcorrenciasNF`, não via cliente do tracking público.

**Arquivos:** `supabase/functions/voltar-para-to-do-com-rastreio/index.ts`.

**Como verificar:**
```bash
# Não pode importar createSswTrackingClient.
grep -q "createSswTrackingClient" supabase/functions/voltar-para-to-do-com-rastreio/index.ts
[ $? -ne 0 ] && echo PASS || echo FAIL
# DEVE importar buscarNFInterno.
grep -q "buscarNFInterno" supabase/functions/voltar-para-to-do-com-rastreio/index.ts
[ $? -eq 0 ] && echo PASS || echo FAIL
```

**Memory:** [project_ssw_interno_fonte_saida.md](memory/project_ssw_interno_fonte_saida.md)
**Cenário real:** loop voltar_para_to_do das NFs 64409/422589 (cooldown só foi suficiente após migração pro interno).

---

## INV-006 — oc=54 ⟺ state=AGUARDANDO_CLIENTE (exceto `cliente_respondeu_em != null`)

**Regra:** card com `cod_ultima_ocorrencia=54` precisa estar em state `AGUARDANDO_CLIENTE`, SALVO se `cliente_respondeu_em IS NOT NULL` (aí vai pra AVH+lock pra Larissa decidir).

**Arquivos:** `supabase/functions/sync-bastao/index.ts` (Pass A `forcaAguardandoClienteOc54`), `supabase/functions/_shared/transicao-aguardando-cliente.ts`.

**Como verificar (SQL contra produção, read-only):**
```sql
SELECT count(*)
FROM cards
WHERE cod_ultima_ocorrencia = 54
  AND state != 'AGUARDANDO_CLIENTE'
  AND cliente_respondeu_em IS NULL
  AND state NOT IN ('RESOLVIDO','CANCELADO','TRANSFERIDO');
-- = 0 → PASS. > 0 → FAIL (cards oc=54 em state errado).
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md)
**Cenário real:** bug 2026-05-12 removeu 54 do set OCORRENCIAS_DE_RELACIONAMENTO; Pass B moveu 49 cards de AGUARDANDO_CLIENTE pra TRANSFERIDO.

---

## INV-007 — state `ACAO_EXECUTADA` é blindado contra Pass B

**Regra:** Pass B (release de cards que saíram do Bastão) NUNCA pode mexer em card `state='ACAO_EXECUTADA'`. Card nesse state está aguardando confirmação SSW/Bastão; Pass G/H + executor-inline cuidam.

**Arquivos:** `supabase/functions/sync-bastao/index.ts` (`runPassB`).

**Como verificar:**
```bash
# Filtro do SELECT exclui ACAO_EXECUTADA.
grep -A 5 "from(\"cards\")" supabase/functions/sync-bastao/index.ts \
  | grep "RESOLVIDO,CANCELADO,TRANSFERIDO,TRATATIVA_PENDENTE,ACAO_EXECUTADA"
# != "" → PASS.
# Defesa em profundidade: early-skip explícito no loop.
grep "state === \"ACAO_EXECUTADA\"" supabase/functions/sync-bastao/index.ts | grep -i "continue"
# != "" → PASS adicional.
```

**Memory:** [project_loop_passb_passa_lock_travado.md](memory/project_loop_passb_passa_lock_travado.md), [project_acao_executada_state.md](memory/project_acao_executada_state.md)
**Cenário real:** NFs 692021, 20761 (Pass B movia ACAO_EXECUTADA → TRANSFERIDO durante latência RPA).

---

## INV-008 — `stateFinalAposBastao` é fonte única de mapeamento oc→state

**Regra:** toda transição oc→state final (RESOLVIDO/TRANSFERIDO/AGUARDANDO_CLIENTE/AVH) passa pelo helper canônico [`stateFinalAposBastao`](supabase/functions/_shared/bastao-rules.ts). Não duplicar a tabela em outros lugares (state hard-coded por oc).

**Arquivos:** `supabase/functions/_shared/bastao-rules.ts` define; demais leem.

**Como verificar:**
```bash
# Quem ATRIBUI state literal (TRANSFERIDO/RESOLVIDO/AGUARDANDO_CLIENTE) por oc:
grep -RIn 'state.*=.*"\(TRANSFERIDO\|RESOLVIDO\|AGUARDANDO_CLIENTE\|AGUARDANDO_VALIDACAO_HUMANA\)"' supabase/functions/ \
  | grep -v "stateFinalAposBastao\|stateFinal\.state\|_shared/bastao-rules.ts\|//\|test\|describe" \
  | wc -l
# Esse número é a baseline atual (alguns paths legacy permanecem). Validação humana:
# se aumentar muito sem justificativa, FAIL.
```

**Memory:** [project_ssw_interno_fonte_saida.md](memory/project_ssw_interno_fonte_saida.md)
**Cenário real:** transições inconsistentes entre Pass A/Pass G/voltar-para-to-do antes da consolidação.

---

## INV-009 — Edge functions internas têm `verify_jwt=false` no config.toml

**Regra:** funções chamadas só edge-to-edge (cron, pgmq consumer, invokeNext) PRECISAM ter `verify_jwt = false` no `supabase/config.toml`. Sem isso, gateway Supabase devolve 401 silencioso quando chamada com service_role.

**Arquivos:** `supabase/config.toml`.

**Como verificar:**
```bash
# Lista esperada de funções internas:
INTERNAS="triador vinculador executor redator redator-email-saida sync-bastao \
audit-invariante cron-ia-resposta-pendentes gmail-poll-inbox processar-acoes-agendadas \
ingestor interpretador-resposta-cliente"
for f in $INTERNAS; do
  grep -A1 "\[functions\.$f\]" supabase/config.toml | grep -q "verify_jwt = false"
  [ $? -eq 0 ] && echo "  $f: PASS" || echo "  $f: FAIL"
done
```

**Memory:** [feedback_interpretador_verify_jwt_false.md](memory/feedback_interpretador_verify_jwt_false.md)
**Cenário real:** NFs 62870/351954 ficaram em CLIENTE RESPONDEU sem sugestão IA por dias.

---

## INV-011 — Callers de `temEvidenciaParaOc` / `verificarEvidenciaESinalizar` PASSAM `ctrcEsperado` quando há card com ctrc

**Regra:** NFs com reentrega ou complementar têm múltiplos CTRCs no SSW. Sem `ctrcEsperado`, `buscarNFInterno` rejeita com "múltiplos CTRCs retornados — exige ctrcEsperado". O caller interpreta isso como "evidência ausente" — falso negativo. Quem tem `card.ctrc` (ou `pendencia.ctrc`) DEVE propagar pra esses helpers.

**Arquivos:**
- `supabase/functions/executor/index.ts` (chamada de `temEvidenciaParaOc` pré-email; SELECT do card inclui `ctrc`)
- `supabase/functions/revalidar-evidencia-card/index.ts` (idem)
- `supabase/functions/sync-bastao/index.ts` (chamada de `verificarEvidenciaESinalizar` em criação de card via Pass A; passa `p.ctrc`)
- `supabase/functions/vinculador/index.ts` (idem em criação via mensagem do cliente; passa `p.ctrc`)
- `supabase/functions/_shared/verificar-evidencia.ts` (helper canônico — aceita e propaga `ctrcEsperado`)

**Como verificar:**
```bash
# 1. temEvidenciaParaOc deve aceitar ctrcEsperado na assinatura.
grep -c "ctrcEsperado" supabase/functions/_shared/verificar-evidencia.ts
# >= 3 → PASS (declaração na assinatura + uso no buscarNFInterno + propagação em verificarEvidenciaESinalizar).

# 2. Callers DIRETOS de temEvidenciaParaOc passam 5 args.
DIRECT=$(grep -E "temEvidenciaParaOc\(" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null | grep -v "import\|//\|export" | wc -l | tr -d ' ')
COM_CTRC=$(grep -E "temEvidenciaParaOc\(.*,.*,.*,.*,.*\)" supabase/functions/executor/index.ts supabase/functions/revalidar-evidencia-card/index.ts 2>/dev/null \
  | grep -cE "ctrc|null")
# DIRECT == COM_CTRC → PASS.

# 3. verificarEvidenciaESinalizar callers (sync-bastao, vinculador) passam 6 args (ctrc no fim).
SINALIZAR=$(grep -B1 -A6 "verificarEvidenciaESinalizar(" supabase/functions/sync-bastao/index.ts supabase/functions/vinculador/index.ts 2>/dev/null | grep -cE "\.ctrc\s*\?\?\s*null|ctrc:")
# >= 3 chamadas reais → PASS (sync-bastao Pass A + vinculador 2x).
```

**Memory:** [feedback_multiplas_linhas_mesma_oc.md](memory/feedback_multiplas_linhas_mesma_oc.md)
**Cenário real:** NF 20761 oc=10 hoje (2026-05-14 10:46) — Larissa aprovou oc=54+email; executor consultou `temEvidenciaParaOc` sem ctrc; `buscarNFInterno` rejeitou; email bloqueado erradamente com motivo "scrape_indisponivel". Larissa precisou marcar `skip_evidencia=true` pra contornar.

---

## INV-010 — `54` está em `OCORRENCIAS_DE_RELACIONAMENTO`

**Regra:** o set de 15 ocs de Relacionamento DEVE conter o valor `54` (oc=54 é "Cliente"/`AGUARDANDO_CLIENTE`, mas precisa estar no set pra Pass B reconhecer "ainda no escopo do Cockpit").

**Arquivos:** `lib/bastao-rules.ts` e mirror `supabase/functions/_shared/bastao-rules.ts`.

**Como verificar:**
```bash
# Set declarado tem 54 explicitamente.
grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" lib/bastao-rules.ts | grep -E "\b54\b"
[ $? -eq 0 ] && echo PASS || echo FAIL
grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" supabase/functions/_shared/bastao-rules.ts | grep -E "\b54\b"
[ $? -eq 0 ] && echo PASS || echo FAIL
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md)
**Cenário real:** bug crítico Caio 2026-05-12 — removeu 54 do set por engano. Pass B passou a tratar oc=54 como fora de escopo e moveu **49 cards** AGUARDANDO_CLIENTE → TRANSFERIDO em horas. Foi reverter na hora.

---

## Mapa: arquivo → invariantes aplicáveis

Lookup que o hook PreToolUse usa quando dispara:

| Arquivo | Invariantes |
|---|---|
| `supabase/functions/_shared/confirmar-acao-executada-ssw.ts` | INV-002 |
| `supabase/functions/sync-bastao/index.ts` | INV-003, INV-004, INV-006, INV-007, INV-008, INV-011 |
| `supabase/functions/voltar-para-to-do-com-rastreio/index.ts` | INV-001, INV-005 |
| `supabase/functions/_shared/ssw-internal-client.ts` | INV-001 |
| `supabase/functions/interpretador-evidencia-foto/index.ts` | INV-001 |
| `supabase/functions/executor/index.ts` | INV-002 (escreve campos preservados pelo helper), INV-008, INV-011 |
| `supabase/functions/_shared/verificar-evidencia.ts` | INV-001, INV-011 |
| `supabase/functions/revalidar-evidencia-card/index.ts` | INV-011 |
| `lib/bastao-rules.ts`, `supabase/functions/_shared/bastao-rules.ts` | INV-010, INV-008 |
| `supabase/functions/_shared/regras-auto-acao.ts` | INV-004, INV-008 |
| `supabase/functions/_shared/transicao-aguardando-cliente.ts` | INV-006, INV-008 |
| `supabase/config.toml` | INV-009 |

---

## Histórico

- 2026-05-14 — versão inicial com 10 INVs, motivada pelo bug NF 1075381.
- 2026-05-14 (tarde) — INV-011 adicionado pós-bug NF 20761 (evidência ausente falso por múltiplos CTRCs sem ctrcEsperado).
