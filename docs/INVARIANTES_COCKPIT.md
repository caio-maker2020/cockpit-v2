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

## INV-003 — Pass A `voltouParaRelacionamento` usa guard por OC do lançamento + safeguard 24h

**Regra (final 2026-05-23):** card que já passou por lançamento (`bastao_oc_no_lancamento != null`) e Bastão mostra a MESMA oc do lançamento → `bastaoEhMesmoSnapshotDoLancamento = true` → `voltouParaRelacionamento = false` → NO-OP completo (não muda state, não cria todo, não cancela nada).

**SAFEGUARD INVIOLÁVEL (Caio 2026-05-23):** se passou >24h desde `bastao_updated_at_no_lancamento` E Bastão ainda sinaliza oc de relacionamento → REABRE incondicionalmente. Invariante "oc de relacionamento SEMPRE no Cockpit" tem precedência absoluta. Não introduz o loop antigo da mig 095 porque o intervalo é DIÁRIO, não por update RPA (geralmente 15-60min).

Operação re-tratativa com oc DIFERENTE → guard libera → reabertura normal via `stateFinalAposBastao`. Re-tratativa com MESMA oc + <24h é caso raro tratado por outros canais (vinculador via email do cliente, ATUALIZAR AGORA manual da Larissa). >24h: safeguard libera incondicionalmente.

**Histórico:** versões anteriores tentaram tupla `(oc + updated_at)` (migration 095) e `pendencia_id` (migration 096). Ambas falharam porque o Bastão muda `updated_at` e `pendencia_id` várias vezes por hora sem mudança semântica de oc. Discriminador final = oc + safeguard temporal 24h (Caio 2026-05-23 após NFs 286697/47187/1005069/756800/693706 perdidas eternamente).

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
# Filtro do SELECT de runPassB exclui ACAO_EXECUTADA. Busca direta pelo
# .not("state","in",...) — robusta a comentários entre from("cards") e o filtro
# (o -A 5 antigo quebrou quando ADR 0005 inseriu comentários, 2026-06-18).
grep -E '\.not\("state",[[:space:]]*"in",.*ACAO_EXECUTADA' supabase/functions/sync-bastao/index.ts
# != "" → PASS.
# Defesa em profundidade: early-skip explícito no loop.
grep -E '\["state"\][[:space:]]*===[[:space:]]*"ACAO_EXECUTADA"' supabase/functions/sync-bastao/index.ts
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

**Arquivos:** `lib/bastao-rules.ts` (Set literal hardcoded) e `supabase/functions/_shared/bastao-rules.ts` (desde 2026-06-16 carrega o set do dicionário `ocorrencias_dicionario` em cold start e **força** `set.add(54)` independente da planilha — ver [[feedback_bastao_rules_lookup_dicionario_dinamico]]).

**Como verificar:**
```bash
# lib/: Set literal contém 54.
grep -A 2 "OCORRENCIAS_DE_RELACIONAMENTO" lib/bastao-rules.ts | grep -E "\b54\b"
[ $? -eq 0 ] && echo PASS || echo FAIL
# shared/: 54 forçado via set.add(54) (carga dinâmica do dicionário; não é mais Set literal).
grep -E "set\.add\(54\)" supabase/functions/_shared/bastao-rules.ts
[ $? -eq 0 ] && echo PASS || echo FAIL
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md)
**Cenário real:** bug crítico Caio 2026-05-12 — removeu 54 do set por engano. Pass B passou a tratar oc=54 como fora de escopo e moveu **49 cards** AGUARDANDO_CLIENTE → TRANSFERIDO em horas. Foi reverter na hora.

---

## INV-012 — Consumidores de evidência (IA / email / classificação) usam `obterTodasFotosDaOc`, NUNCA `obterFotoDaOc`

**Regra:** uma ocorrência no SSW pode ter **N fotos** (paginação `01/02/03` no viewer + múltiplas linhas do mesmo código). Qualquer caller que **consuma o conjunto de evidências** (análise de IA Vision, anexo de email ao cliente, classificação automática) DEVE usar `obterTodasFotosDaOc` (baixa todas numa sessão). `obterFotoDaOc` (uma foto por `idx`) é **exclusivo da galeria paginada** — o front itera os idx via header `X-Fotos-Total`. Copiar `obterFotoDaOc(idx:0)` pra um fluxo de evidência = puxar só a 1ª foto = decisão tomada sobre evidência incompleta.

**Arquivos:** definição em `supabase/functions/_shared/ssw-internal-client.ts`. Whitelist autorizada a chamar `obterFotoDaOc`: **somente** `foto-oc-card/index.ts` e `r-evidencia/index.ts` (galeria). Qualquer outro chamador é violação.

**Como verificar:**
```bash
# Nenhum 'await obterFotoDaOc(' fora das 2 telas de galeria.
VIOL=$(grep -RIn "await obterFotoDaOc(" supabase/functions/ 2>/dev/null \
  | grep -vE "foto-oc-card/index\.ts|r-evidencia/index\.ts" | wc -l | tr -d ' ')
[ "$VIOL" -eq 0 ] && echo "INV-012: PASS" || echo "INV-012: FAIL ($VIOL caller(s) fora da galeria — usar obterTodasFotosDaOc)"
```

**Memory:** [feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md](memory/feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md), [feedback_paginadores_tracking_ent_ssw_viewer.md](memory/feedback_paginadores_tracking_ent_ssw_viewer.md)
**Cenário real:** NF 357645 (2026-06-05) corrigiu só a galeria; IA e anexo de email **nunca** iteraram — sempre olhavam a foto 01. NF 355283 oc=49 ALTHAIA (2026-06-18): a IA validou evidência vendo só a caixa, ignorando a 2ª foto (DANFE de devolução, que mudaria a oc). Sintoma reincidente porque cada novo fluxo de evidência copiava o `idx:0`. Raiz: `obterTodasFotosDaOc` centralizou o "todas as fotos".

---

## INV-013 — Lançamento de oc no SSW SEMPRE pela conta de serviço `ai.salex` (`readSswLancamentoEnv`)

**Regra:** TODO caller de `lancarOcorrenciaPortal` resolve a sessão SSW via `readSswLancamentoEnv` (conta única `ai.salex`, secrets `SSW_LANCAMENTO_*`), **independente do operador do card**. São 6 pontos: o envelope `lancarSswPortal` (`_shared/lancar-ssw-portal.ts`, usado por executor/sync-bastao/agente-oc13-autonomo) e as 4 tools de oc=33 no `executor/index.ts` (`lancar_oc33_solo_portal`, `lancar_combo_33_44`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`). Resolução por-operador (`loadSswInternalEnvForCard` / `readSswInternalEnv(env, nome)`) fica **só pra LEITURA** (foto, histórico, `descobrirUltimaOcSsw`). `readSswLancamentoEnv` **não tem fallback de conta**: faltando secret → THROW (lançamento aborta e reverte o card), nunca loga como outro operador.

**Arquivos:** definição em `supabase/functions/_shared/ssw-internal-client.ts`. Callers de lançamento: `_shared/lancar-ssw-portal.ts` + `executor/index.ts`.

**Como verificar:**
```bash
# Nenhuma sessão de LANÇAMENTO pode vir de readSswInternalEnv/loadSswInternalEnvForCard.
# (a) executor: toda sessão que alimenta lancarOcorrenciaPortal usa readSswLancamentoEnv
VIOL1=$(grep -RIn "readSswInternalEnv(Deno.env.toObject())" supabase/functions/executor/index.ts 2>/dev/null | wc -l | tr -d ' ')
# (b) envelope: resolve credencial de submit por readSswLancamentoEnv (não por-operador)
#     conta só CHAMADAS reais (open paren) — menções em comentário não violam.
VIOL2=$(grep -c "loadSswInternalEnvForCard(" supabase/functions/_shared/lancar-ssw-portal.ts 2>/dev/null | tr -d ' ')
{ [ "$VIOL1" -eq 0 ] && [ "$VIOL2" -eq 0 ]; } && echo "INV-013: PASS" || echo "INV-013: FAIL (executor=$VIOL1 readSswInternalEnv, envelope=$VIOL2 loadSswInternalEnvForCard — usar readSswLancamentoEnv)"
# Teste unitário: deno test supabase/functions/_shared/ssw-lancamento-env.test.ts
```

**Memory:** [project_lancamento_ssw_sempre_conta_ai_salex.md](memory/project_lancamento_ssw_sempre_conta_ai_salex.md)
**Cenário real:** NF 651244 / card d11717f9 (2026-06-22): Duilio **aprovou** a oc=33 no Cockpit, mas o SSW registrou o lançamento como **Larissa** — a tool `lancar_oc33_solo_portal` usava `readSswInternalEnv(env)` sem operador → credencial legada `SSW_INTERNAL_*` (= Larissa). As ocs padrão (54/21/...) saíam certas pelo envelope por-operador (Duilio), mascarando o desvio só na família oc=33. Fix: unificar todos os lançamentos na conta de serviço `ai.salex`.

> Atualização 2026-06-23 (NF 376924): as 4 tools de oc=33/44 do executor (`lancar_oc33_solo_portal`, `lancar_combo_33_44`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`) **não chamam mais `lancarOcorrenciaPortal` direto** — passam pelo envelope `lancarSswPortal` (adapter `lancarOcViaEnvelope`). Logo o ponto único de lançamento virou o **envelope** (ver INV-014). `lancarOcorrenciaPortal`/`obterSessao`/`readSswLancamentoEnv` não são mais importados pelo `executor/index.ts`.

---

## INV-014 — Card NUNCA aparece em CONFLITOS se a oc geradora foi lançada PELO Cockpit (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-23, inviolável):** `flagConflitoOcSemMover` (`_shared/escopo-relacionamento.ts`) **NÃO** grava `mudanca_suspeita` tipo `saiu_de_escopo` se a `para_oc` foi lançada pelo próprio Cockpit (em QUALQUER momento, com sucesso). Os 2 sinais abaixo rodam **SEMPRE, sem gate de ciclo**. Se o Cockpit lançou aquela oc, **não é conflito**. "Lançado pelo Cockpit" = QUALQUER um de DOIS sinais path-independent:
- **(a)** linha em `acoes_executadas_ssw` com `codigo_oc = para_oc` e `sucesso = true` (registro autoritativo do envelope `lancarSswPortal`); OU
- **(b)** card_event `AcaoExecutadaConfirmadaPeloSsw` com `payload->>'oc_ssw' = para_oc` (emitido por TODO lançamento confirmado pelo SSW — executor-inline / Pass H — qualquer que seja o handler).

**⚠️ Furo corrigido na RAIZ (Caio 2026-06-23):** uma versão anterior gateou os 2 sinais atrás de `emCicloAtivoDoLancamento` (= `cards.acao_executada_em != null`, "ciclo ativo"). Mas esse campo é **ZERADO assim que o Bastão confirma** o lançamento e o card volta a descansar (AGUARDANDO_CLIENTE — estado normal da maioria). Resultado: TODO card já confirmado perdia a proteção e era **re-flagado em massa** na aba CONFLITOS (NF 359849/44, 1017149/21, 3057294/56, 377696/21 — 4 falso-positivos + retrabalho). **Correção:** os 2 sinais rodam SEMPRE; `acao_executada_em` não é mais lido. **Tradeoff aceito:** se a operação reabrir o card e relançar a MESMA oc por fora num ciclo novo, NÃO flagga (suprime por número de oc). Decisão do Caio: zero falso-positivo > pegar esse caso raro ("ali não pode aparecer conflitos que vêm de ocorrências que lançamos por dentro"). Pra distinguir o caso raro no futuro: comparar a data da ocorrência no SSW com `acoes_executadas_ssw.finalizado_em`.

O sinal (b) é a **rede de segurança**: cobre caminhos de lançamento que (historicamente, ou por regressão futura) não gravem em `acoes_executadas_ssw`. Falha de qualquer checagem NÃO bloqueia (conservador: mostra o conflito; operador FORÇA e o SSW revalida).

**Pré-requisito raiz (INV-013):** TODO lançamento passa pelo envelope `lancarSswPortal` → grava em `acoes_executadas_ssw`. Os 5 callers de oc=33/44 do executor foram migrados pro envelope (2026-06-23). Enquanto INV-013 valer, o sinal (a) sozinho já basta; (b) protege contra desvio.

**Arquivos:** `_shared/escopo-relacionamento.ts` (`flagConflitoOcSemMover`); chamado por `sync-bastao/index.ts` (Pass B branches found/!current + reconciliação `A_reconc`).

**Como verificar:**
```bash
# Guard consulta os DOIS sinais SEMPRE — e o gate de ciclo (furo) NÃO existe mais.
G1=$(grep -c "acoes_executadas_ssw" supabase/functions/_shared/escopo-relacionamento.ts)
G2=$(grep -c "AcaoExecutadaConfirmadaPeloSsw" supabase/functions/_shared/escopo-relacionamento.ts)
G3=$(grep -c "emCicloAtivoDoLancamento" supabase/functions/_shared/escopo-relacionamento.ts)  # DEVE ser 0
{ [ "$G1" -ge 1 ] && [ "$G2" -ge 1 ] && [ "$G3" -eq 0 ]; } && echo "INV-014: PASS (2 sinais, sem gate de ciclo)" || echo "INV-014: FAIL"
# Teste unitário (guard 1 acoes_executadas_ssw + guard 2 AcaoExecutadaConfirmadaPeloSsw + conflito real):
#   deno test supabase/functions/_shared/escopo-relacionamento.test.ts
# Auditoria em produção (deve dar 0): card flaggado cuja para_oc foi confirmada pelo Cockpit
#   SELECT count(*) FROM cards c WHERE c.mudanca_suspeita->>'tipo'='saiu_de_escopo'
#     AND EXISTS (SELECT 1 FROM card_events e WHERE e.card_id=c.id
#       AND e.event_type='AcaoExecutadaConfirmadaPeloSsw'
#       AND (e.payload->>'oc_ssw')::int=(c.mudanca_suspeita->>'para_oc')::int);
```

**Memory:** [project_conflitos_nunca_oc_lancada_pelo_cockpit.md](memory/project_conflitos_nunca_oc_lancada_pelo_cockpit.md)
**Cenário real:** NF 376924 + 53948 (2026-06-22): oc=33 reversão lançada pela Larissa via Cockpit (`lancar_oc33_solo_portal`), mas o caminho pulava o envelope → sem registro em `acoes_executadas_ssw` → guard cego → flaggou `54→33`. Agravante: `forcaAguardandoClienteOc54` arrastou o card de `33/TRANSFERIDO` de volta pra `54/AGUARDANDO_CLIENTE` com Bastão atrasado (ver INV-003/INV-006), re-armando o escopo protegido. Fix: (1) migrar os 5 callers pro envelope; (2) guard ganha sinal (b); (3) guard pós-lançamento no `forcaAguardandoClienteOc54`.

---

## INV-015 — Limite de anexos por card conta SÓ uploads do operador (NUNCA `origem='inbound'`)

**Regra (Caio 2026-06-23):** o teto de anexos PENDENTES por card em `upload-anexo-email` (`MAX_ANEXOS_UPLOAD_POR_CARD = 20`) existe pra bound o que o **operador sobe** (vai pro SSW) — `origem='outbound'` (default da coluna). Anexos `origem='inbound'` são **auto-capturados** dos e-mails do cliente (imagens inline de assinatura/logo + PDFs do romaneio) e **não consomem o budget**. A query de contagem DEVE filtrar `.neq("origem","inbound")`. Sem isso, um card com muitos inbound bloqueia 100% dos uploads — inclusive cada página JPEG do PDF que o front converte no browser → upload 400 → supabase-js "Edge Function returned a non-2xx status code" → front "Falha ao converter PDF → JPEG".

**Arquivos:** lógica em `supabase/functions/_shared/limite-anexos.ts` (`queryAnexosQueContamProLimite`, `limiteAnexosAtingido`, `origemContaProLimite`); consumida por `supabase/functions/upload-anexo-email/index.ts`.

**Como verificar:**
```bash
# A query do limite EXCLUI inbound (o coração do fix NF 719250).
G=$(grep -c '\.neq("origem", "inbound")' supabase/functions/_shared/limite-anexos.ts)
USA=$(grep -c "queryAnexosQueContamProLimite" supabase/functions/upload-anexo-email/index.ts)
{ [ "$G" -ge 1 ] && [ "$USA" -ge 1 ]; } && echo "INV-015: PASS" || echo "INV-015: FAIL (filtro inbound=$G, uso na edge=$USA)"
# Teste unitário: deno test supabase/functions/_shared/limite-anexos.test.ts
# Auditoria em produção (cards travados que NÃO deveriam): deve ser ~0 considerando só outbound.
#   SELECT count(*) FROM (SELECT card_id, count(*) FILTER (WHERE origem<>'inbound') ob
#     FROM email_anexos WHERE enviado_em IS NULL AND deletado_em IS NULL GROUP BY card_id) t
#   WHERE t.ob >= 20;
```

**Memory:** [feedback_limite_anexos_nao_conta_inbound.md](memory/feedback_limite_anexos_nao_conta_inbound.md)
**Cenário real:** NF 719250 / card c53dbfda (2026-06-23): Duilio não conseguia converter 2 PDFs (romaneio) pra JPEG no modal da oc=33. O card tinha **29 anexos pendentes, TODOS inbound** (27 imagens inline de assinatura — 165 bytes a 4 KB — + os 2 PDFs), 0 outbound. 29 ≥ 20 → todo upload de JPEG convertido voltava 400. **18 cards** estavam bloqueados pela mesma causa; todos destravam contando só outbound. Raiz era débito conhecido (comentário "Refactor de origem (não contar inbound) fica pra depois" no código desde 2026-05-22).

---

## INV-016 — Cliente respondeu → SEMPRE visível no Cockpit com as ações (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-23):** quando o cliente responde uma tratativa, o card **TEM** que (a) pular pra aba correta (CLIENTE RESPONDEU / AGUARDANDO VOCÊ — `cliente_respondeu_em != null` + `state=AGUARDANDO_VALIDACAO_HUMANA`) e (b) ter as **propostas pendentes** (botões de ação). A criação de propostas é **determinística (sem LLM)** e vive na fonte única `_shared/propostas-pos-resposta-cliente.ts`. Falha transitória de LLM (triador/interpretador 529) **NÃO PODE** deixar o card sem ação. Defesa em 3 camadas:
1. **Caminho primário:** vinculador (pós-classificação) e scan-email-pre-card (adoção de thread) chamam `atualizarPropostasAposRespostaCliente` — scan-email chama **direto**, sem depender do re-enqueue→triador.
2. **Auto-cura de fila:** `reprocessar-dlq` drena mensagens de cliente presas no `dead_letter` de volta pras filas (backoff via `_reprocess_attempt`, cap 4). **Sem cron próprio** — disparado por `invokeNext` dentro do `cron-ia-resposta-pendentes` (o apagão de 2026-06-23 teve thundering herd de cron como causa #2; não somamos worker slot).
3. **Rede de segurança:** `cron-ia-resposta-pendentes` (1min) recria propostas pra qualquer card em CLIENTE RESPONDEU sem `todos` pendentes (RPC `cards_cliente_respondeu_sem_proposta`), e emite `PropostasRecuperadasPeloCron`. `health-check` alerta o Caio (DLQ de cliente presa + rede de segurança acionada).

**Arquivos:** `_shared/propostas-pos-resposta-cliente.ts` (fonte única), `vinculador/index.ts`, `scan-email-pre-card/index.ts`, `cron-ia-resposta-pendentes/index.ts`, `reprocessar-dlq/index.ts`, `health-check/index.ts`.

**Como verificar (código — caminho determinístico está wired):**
```bash
# scan-email-pre-card E cron-ia-resposta-pendentes DEVEM chamar a fonte única.
# = 2 → PASS. < 2 → FAIL (alguém voltou a depender só do vinculador/LLM).
grep -lR "atualizarPropostasAposRespostaCliente" \
  supabase/functions/scan-email-pre-card/index.ts \
  supabase/functions/cron-ia-resposta-pendentes/index.ts 2>/dev/null | wc -l
```

**Como verificar (runtime — nenhum card preso):**
```sql
-- DEVE retornar 0. > 0 → card em CLIENTE RESPONDEU sem botões (regra violada).
SELECT count(*) FROM public.cards_cliente_respondeu_sem_proposta(200);
```

**Memory:** [project_inv016_cliente_respondeu_sempre_visivel.md](memory/project_inv016_cliente_respondeu_sempre_visivel.md)
**Cenário real:** NF 761583 (F E F DISTRIBUI A1), 2026-06-23. Anthropic 529 (14:18–14:57 UTC) derrubou o triador → 13 respostas de clientes no `dead_letter` → vinculador nunca rodou → 761583 ficou "CLIENTE RESPONDEU + IA sugeriu oc 44 + ZERO botões"; outros 5 cards (AGUARDANDO_CLIENTE) nem apareceram como respondidos. Não havia reprocessamento de DLQ nem rede de segurança de propostas (só de `ia_sugestao`).

---

## Mapa: arquivo → invariantes aplicáveis

Lookup que o hook PreToolUse usa quando dispara:

| Arquivo | Invariantes |
|---|---|
| `supabase/functions/_shared/confirmar-acao-executada-ssw.ts` | INV-002 |
| `supabase/functions/sync-bastao/index.ts` | INV-003, INV-004, INV-006, INV-007, INV-008, INV-011, INV-014 |
| `supabase/functions/_shared/escopo-relacionamento.ts` | INV-014 |
| `supabase/functions/voltar-para-to-do-com-rastreio/index.ts` | INV-001, INV-005 |
| `supabase/functions/_shared/ssw-internal-client.ts` | INV-001, INV-012, INV-013 |
| `supabase/functions/_shared/lancar-ssw-portal.ts` | INV-013 |
| `supabase/functions/interpretador-evidencia-foto/index.ts` | INV-001, INV-012 |
| `supabase/functions/executar-sugestao-evidencia/index.ts` | INV-012 |
| `supabase/functions/foto-oc-card/index.ts`, `supabase/functions/r-evidencia/index.ts` | INV-012 (galeria — únicas autorizadas a `obterFotoDaOc`) |
| `supabase/functions/executor/index.ts` | INV-002 (escreve campos preservados pelo helper), INV-008, INV-011, INV-013 |
| `supabase/functions/_shared/verificar-evidencia.ts` | INV-001, INV-011 |
| `supabase/functions/revalidar-evidencia-card/index.ts` | INV-011 |
| `lib/bastao-rules.ts`, `supabase/functions/_shared/bastao-rules.ts` | INV-010, INV-008 |
| `supabase/functions/_shared/regras-auto-acao.ts` | INV-004, INV-008 |
| `supabase/functions/_shared/transicao-aguardando-cliente.ts` | INV-006, INV-008 |
| `supabase/functions/_shared/limite-anexos.ts`, `supabase/functions/upload-anexo-email/index.ts` | INV-015 |
| `supabase/functions/_shared/propostas-pos-resposta-cliente.ts` (fonte única) | INV-016 |
| `supabase/functions/scan-email-pre-card/index.ts`, `supabase/functions/cron-ia-resposta-pendentes/index.ts`, `supabase/functions/reprocessar-dlq/index.ts` | INV-016 |
| `supabase/functions/vinculador/index.ts` | INV-011, INV-016 |
| `supabase/config.toml` | INV-009 |

---

## Histórico

- 2026-05-14 — versão inicial com 10 INVs, motivada pelo bug NF 1075381.
- 2026-05-14 (tarde) — INV-011 adicionado pós-bug NF 20761 (evidência ausente falso por múltiplos CTRCs sem ctrcEsperado).
- 2026-06-18 — INV-012 adicionado pós-bug NF 355283 oc=49 (IA + anexo de email puxavam só a 1ª foto; raiz: `obterTodasFotosDaOc` + whitelist de `obterFotoDaOc` só pra galeria).
- 2026-06-22 — INV-013 adicionado pós-bug NF 651244 (Duilio aprovou oc=33, SSW registrou Larissa). Lançamento unificado na conta de serviço `ai.salex` via `readSswLancamentoEnv`.
- 2026-06-23 — INV-014 adicionado pós-bug NF 376924 + 53948 (oc=33 reversão lançada pelo Cockpit virou CONFLITOS). Guard `flagConflitoOcSemMover` ganhou 2º sinal (`AcaoExecutadaConfirmadaPeloSsw`, path-independent) + os 5 callers de oc=33/44 do executor migrados pro envelope `lancarSswPortal` + guard pós-lançamento no `forcaAguardandoClienteOc54`. REGRA INVIOLÁVEL: oc lançada pelo Cockpit nunca é conflito.
- 2026-06-23 — INV-015 adicionado pós-bug NF 719250 (Duilio não convertia PDF→JPEG no modal oc=33). O limite de anexos por card contava `origem='inbound'` (assinaturas/logos inline auto-capturados); card com 29 inbound bloqueava todo upload. Limite passou a contar só uploads do operador (outbound), centralizado em `_shared/limite-anexos.ts`. 18 cards destravados.
- 2026-06-23 — INV-016 adicionado pós-bug NF 761583 (Anthropic 529 derrubou o triador → 13 respostas de clientes no `dead_letter` → cards em CLIENTE RESPONDEU sem botões / nem apareciam). Criação de propostas extraída pra `_shared/propostas-pos-resposta-cliente.ts` (fonte única, determinística); scan-email-pre-card cria direto; novo `reprocessar-dlq` (cron 2min) auto-cura mensagens presas; `cron-ia-resposta-pendentes` ganhou rede de segurança de propostas; health-check alerta o Caio. REGRA INVIOLÁVEL: cliente respondeu → SEMPRE visível no Cockpit com as ações.
- 2026-06-23 (noite) — INV-014 corrigido na RAIZ: o gate de ciclo (`emCicloAtivoDoLancamento` = `acao_executada_em != null`), adicionado mais cedo no mesmo dia, desligava os 2 sinais assim que o Bastão confirmava o lançamento → re-flag em massa de cards já confirmados (NF 359849/44, 1017149/21, 3057294/56, 377696/21). Gate removido (2 sinais rodam SEMPRE); 4 falso-positivos limpos retroativo; test antigo "CASO 2 → FLAGGED" (que codificava o bug) invertido pro guard de regressão. Tradeoff: caso raro de relançamento-por-fora-em-ciclo-novo não é mais pego (decisão do Caio: zero falso-positivo).
