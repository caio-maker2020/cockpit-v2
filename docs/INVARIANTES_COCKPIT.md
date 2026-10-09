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
# (o -A 5 antigo quebrou quando o ADR 0012 (sync único) inseriu comentários, 2026-06-18).
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

## INV-012b — Galeria do card serve o MANIFESTO (modo `list`) com TODAS as fotos; front renderiza declarativo

**Regra:** a 3ª recorrência do "card puxa só 1 foto" (NF 362406, 2026-06-30) foi no **FRONT**, não no backend — o backend já servia as 8 fotos (`X-Fotos-Total=8`), mas o front mostrava só a 1ª (dependia de iterar idx às cegas pelo header, ou embutia o viewer cru do SSW cujos paginadores `01..08` (`ajaxEnvia('FOT_N')`) só funcionam dentro da sessão do portal). Fix de raiz: `foto-oc-card` ganhou o **modo `list`** (`{ card_id, codigo_oc, list:true }`) que devolve o **manifesto JSON** com a metadata de TODAS as fotos (`fotos_total`, `incompleto`, `fotos:[{idx,…}]`). O front renderiza `manifesto.fotos.map(...)` — não há "lembrar de iterar". A montagem é a função PURA `montarManifestoFotos` (`_shared/foto-oc-manifest.ts`), que **nunca trunca pra 1** (`fotos_total === fotos.length` por construção). O sinal `incompleto:true` (probe de paginação falhou) faz o front avisar em vez de mascarar 8→1.

**Arquivos:** `supabase/functions/_shared/foto-oc-manifest.ts` (puro), `supabase/functions/_shared/ssw-internal-client.ts` (`listarFotosDaOcMetadata` + `incompleto` em `coletarFotosDaOc`), `supabase/functions/foto-oc-card/index.ts` (modo `list`).

**Como verificar:**
```bash
# foto-oc-card wirado no manifesto + teste do manifesto verde.
grep -q "montarManifestoFotos" supabase/functions/foto-oc-card/index.ts && \
deno test --no-check supabase/functions/_shared/foto-oc-manifest.test.ts >/dev/null 2>&1 && \
echo "INV-012b: PASS" || echo "INV-012b: FAIL"
```

**Memory:** [feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md](memory/feedback_obter_todas_fotos_da_oc_nunca_so_a_primeira.md)
**Cenário real:** NF 362406 oc=49 LARISSA (2026-06-30): SSW com 8 fotos (`01..08`), card mostrava 1. Sonda read-only ao `foto-oc-card` provou `X-Fotos-Total=8` estável (8/8) com binários distintos → backend OK, defeito no front. Prompt: `prompts/lovable-galeria-evidencia-iterar-todas-fotos.md`.

---

## INV-013 — Lançamento de oc no SSW SEMPRE pela conta de serviço `ai.salex` (`readSswLancamentoEnv`)

**Regra:** TODO caller de `lancarOcorrenciaPortal` resolve a sessão SSW via `readSswLancamentoEnv` (conta única `ai.salex`, secrets `SSW_LANCAMENTO_*`), **independente do operador do card**. São 6 pontos: o envelope `lancarSswPortal` (`_shared/lancar-ssw-portal.ts`, usado por executor/sync-bastao/agente-oc13-autonomo) e as 4 tools de oc=33 no `executor/index.ts` (`lancar_oc33_solo_portal`, `lancar_combo_33_44`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`). Resolução por-operador (`loadSswInternalEnvForCard` / `readSswInternalEnv(env, nome)`) fica **só pra LEITURA** (foto, histórico, `descobrirUltimaOcSsw`). `readSswLancamentoEnv` **não tem fallback de conta**: faltando secret → THROW (lançamento aborta e reverte o card), nunca loga como outro operador.

**Arquivos:** definição em `supabase/functions/_shared/ssw-internal-client.ts`. Callers de lançamento: `_shared/lancar-ssw-portal.ts` + `executor/index.ts` + `_shared/lancar-ssw-portal-operacao.ts` (envelope da Operação, ADR 0041 / INV-181 — ampliado em 2026-10-07: o guard também exige `readSswLancamentoEnv` e proíbe `loadSswInternalEnvForCard(`/`readSswInternalEnv(` nele).

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

> Atualização 2026-10-07 (ADR 0040, baixa do motorista): **segundo ponto de lançamento**, o envelope `lancarSswBaixa` (`_shared/lancar-ssw-baixa.ts`, sem card). A sessão do portal sai de `obterSessao(readSswLancamentoEnv(env))`; nunca `readSswInternalEnv`/`loadSswInternalEnvForCard`. No canal `webapi` (`ocorrenciaParceiro`, credencial `SSW_USERNAME`) nada é enviado se `SSW_USERNAME` ≠ `SSW_LANCAMENTO_USUARIO` (`credencialWebApiEhDaContaDeServico`). Guard do INV-013 no `/verify-cockpit` cobre os dois envelopes.

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

## INV-017 — Card em EXTRAVIO_MONITORADO ⟺ oc atual ∈ {6,9,16}; saída pela verdade do BASTÃO por NF (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-24):** a aba EXTRAVIOS mostra **só extravios**. Um card só fica em `state='EXTRAVIO_MONITORADO'` enquanto a ocorrência ATUAL é 6/9/16. A SAÍDA é decidida pela verdade do **Bastão consultado POR NF** (não pelo filtro de ocorrência), porque o RPA faz full-refresh e RETÉM a NF com a oc nova enquanto pendente; só larga quando FINALIZA. Cada ciclo, `sync-extravios-bastao` pega as NFs dos cards da aba, faz `fetchPendenciasByNfs` e roteia via `decidirDestinoExtravio` (delega a `stateFinalAposBastao` — INV-008):
- Bastão mostra oc ∈ {6,9,16} → fica (regrava `bastao_data_ultima_ocorrencia` → nova fotografia);
- Bastão mostra oc ∉ {6,9,16} → SAI roteado (20→AGUARDANDO VOCÊ, 33/operação→TRANSFERIDO, 1/30/32→RESOLVIDO);
- **NF AUSENTE do Bastão → finalizou → RESOLVIDO** — MAS só sob o **GATE DE FRESCOR**.

**GATE DE FRESCOR INVIOLÁVEL:** só age se `max(updated_at)` do Bastão for recente (`fetchBastaoMaxUpdatedAt` ≤ `EXTRAVIOS_BASTAO_FRESH_MIN`, default 20min). Bastão velho/down → NÃO faz NADA (senão "NF ausente" seria dado velho, não finalização). **SSW NÃO é usado no PART 1** — fica pro conflito (oc lançada pelo Cockpit e o Bastão volta com outra → máquina de ACAO_EXECUTADA/`atualizar-card-via-portal-ssw`) e pra pré-checagem do agente (PART 2). Cards com lançamento do Cockpit < 60min (`acao_executada_em`) são pulados.

**Arquivos:** `_shared/extravio-routing.ts` (decisão pura `decidirDestinoExtravio` + testes), `_shared/reconciliar-extravios-bastao.ts` (saída via Bastão por NF + sumiu→RESOLVIDO sob frescor), `sync-extravios-bastao/index.ts` (gate de frescor + entrypoint cron), `_shared/bastao-client.ts` (`fetchBastaoMaxUpdatedAt`, `fetchPendenciasByNfs`).

**Como verificar:**
```bash
# (a) Decisão pura testada (6/9/16 fica; 20→AVH; 33→TRANSFERIDO; 1/30/32→RESOLVIDO; 54→AC).
deno test supabase/functions/_shared/extravio-routing.test.ts    # 8 passed → PASS

# (b) Reconciliador usa a fonte única (decidirDestinoExtravio) + Bastão (NÃO SSW) + gate de frescor.
grep -c "decidirDestinoExtravio" supabase/functions/_shared/reconciliar-extravios-bastao.ts   # >=1
grep -c "bastaoConfirmadoFresco"  supabase/functions/_shared/reconciliar-extravios-bastao.ts   # >=1
grep -c "fetchBastaoMaxUpdatedAt" supabase/functions/sync-extravios-bastao/index.ts            # >=1
grep -rc "descobrirUltimaOcSsw\|reconciliar-extravios-ssw" supabase/functions/sync-extravios-bastao/ supabase/functions/_shared/reconciliar-extravios-bastao.ts  # = 0 (SSW fora do PART 1)

# (c) Cron de reconciliação agendado (mig 255).
psql "$SUPABASE_DB_URL" -tA -c "select count(*) from cron.job where jobname='sync-extravios-bastao';"  # = 1
```

**Como verificar (SQL produção, read-only):**
```sql
-- DURO: nenhum card EXTRAVIO_MONITORADO com oc local fora de {6,9,16}.
SELECT count(*) FROM cards
WHERE state='EXTRAVIO_MONITORADO' AND coalesce(cod_ultima_ocorrencia,0) NOT IN (6,9,16);
-- = 0 → PASS.

-- OPERACIONAL: cards não acumulam dias indefinidamente. Sem sync há > 40min com Bastão
-- fresco = reconciliador parado (cron 10min; staying card recebe synced_at a cada ciclo).
SELECT count(*) FROM cards
WHERE state='EXTRAVIO_MONITORADO' AND bastao_synced_at < now() - interval '40 minutes';
-- baixo/estável → PASS. Crescente → investigar reconciliador (NÃO o Bastão).
```

**Memory:** [project_extravios_regra_inviolavel_saida_e_reconciliador.md](memory/project_extravios_regra_inviolavel_saida_e_reconciliador.md)
**Cenário real:** 2026-06-24 — cards travados em EXTRAVIO_MONITORADO/oc=6 com a oc real já mudada (NF 43973 oc 20→1 congelada 121h, 277008/21519 entregues, 650967 oc 33). Raiz: a saída estava delegada ao pull FILTRADO por ocorrência; NF que muda pra fora do filtro sumia do pull e o card congelava (runPassB exclui EXTRAVIO_MONITORADO; cron dedicado aposentado mig 219). Validado empiricamente que o Bastão RETÉM a NF com a oc nova (33/49/14/5/53) e só some quando finaliza (1/30/32) → consultar o Bastão por NF é a fonte barata e correta; SSW vira exceção. (1ª versão usou reconciliador SSW por órfão/staleness — substituída por Bastão-por-NF + gate de frescor por ser mais barata, sem risco de estampida de SSW pós-falha, e sem confundir "saiu do relatório" com "update falhou".)

---

## INV-019 — Card AGUARDANDO_CLIENTE cuja oc vira RELACIONAMENTO ≠54 → AGUARDANDO VOCÊ (não pode ficar travado)

**Regra (Caio 2026-06-24):** `AGUARDANDO_CLIENTE` só contém oc=54. Quando a oc real (Bastão) de um card AGUARDANDO_CLIENTE vira **outra oc DE RELACIONAMENTO ≠54** (49/20/11/19/35/10/...), o card TEM que ir pra **AGUARDANDO VOCÊ** (`AGUARDANDO_VALIDACAO_HUMANA` + lock) pro operador tratar. Mover pra AGUARDANDO VOCÊ **não** fere INV "card não sai sozinho" — continua no Cockpit, só troca de aba. O ramo **out-of-escopo** (oc fora de relacionamento) é o OUTRO ramo: fica em AGUARDANDO_CLIENTE + aponta em **CONFLITOS** (Pass B `flagConflitoOcSemMover`) — esse não é coberto por este INV.

**Arquivos:** `supabase/functions/sync-bastao/index.ts` (Pass A `aguardandoClienteVirouOutraRelacionamento` — state + `effState`); `migration/2026-07-02_287_ignorar_pendencias_respeita_inv019.sql` (RPC do operador). Complementa INV-006.

**Raiz da regressão:** o Pass E (dono dessa transição) foi DESLIGADO em 2026-06-22 pela invariante "não sai sozinho", mas só o ramo out-of-escopo→CONFLITOS foi reassumido (Pass B). O ramo in-escopo (relacionamento≠54) ficou órfão → cards congelavam em AGUARDANDO_CLIENTE, invisíveis (nem AGUARDANDO VOCÊ nem CONFLITOS, pois Pass A limpa `mudanca_suspeita` pra oc de relacionamento). Restaurado no Pass A em 2026-06-24.

**4ª porta de entrada (bug NF 1119469, 2026-07-02, mig 287):** a RPC `ignorar_pendencias_resposta_cliente` (botão "IGNORAR E SEGUIR" do banner de pendências IA) fazia `UPDATE cards SET state='AGUARDANDO_CLIENTE'` **incondicionalmente** — nunca lia `cod_ultima_ocorrencia`. Toda vez que o operador ignorava pendências num card de relacionamento ≠54 (oc 19/49/20/...), a própria RPC CRIAVA a violação de INV-019 (card 98338d77, oc=19, Duilio). Fix: a RPC decide o state pelo **mesmo predicado do /verify-cockpit** (relacionamento ≠54 e não-lag pós-54 → fica em AVH+lock; emite `PendenciasRespostaIgnoradasMantidoEmAguardandoVoce` `regra=INV-019`; oc=54/lag/out-of-escopo → AGUARDANDO_CLIENTE). Era o único caminho de escrita de state que ignorava o guard `oc=54 ⟺ AGUARDANDO_CLIENTE`. Guard no `/verify-cockpit`: `INV-019 (RPC fonte)` + `INV-019 (RPC DB)` via `pg_get_functiondef`. Teste: `supabase/tests/ignorar-pendencias-inv019.test.sql`.

**Como verificar (SQL produção, read-only):**
```sql
-- exclui LAG pós-lançamento de 54 (card lançou 54, Bastão ainda mostra a oc anterior).
SELECT count(*) FROM cards c
WHERE c.state='AGUARDANDO_CLIENTE'
  AND c.cod_ultima_ocorrencia IN (3,8,10,11,17,19,20,23,26,28,35,43,49,52)
  AND NOT EXISTS (
    SELECT 1 FROM acoes_executadas_ssw a
    WHERE a.card_id=c.id AND a.codigo_oc=54 AND a.sucesso
      AND (a.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date >= c.bastao_data_ultima_ocorrencia);
-- = 0 → PASS. > 0 → FAIL (oc de relacionamento ≠54 travada em AGUARDANDO_CLIENTE).
```

**Memory:** [project_aguardando_cliente_state.md](memory/project_aguardando_cliente_state.md), [project_inv019_aguardando_cliente_oc_relacionamento_vai_pra_voce.md](memory/project_inv019_aguardando_cliente_oc_relacionamento_vai_pra_voce.md)
**Cenário real:** NF 175621 (COMPROMISSO) ficou em AGUARDANDO_CLIENTE com oc=49 desde 2026-06-19; varredura achou 52 cards travados (39 oc=49 + 20/11/19/35/10 + 1 oc=30). Last `AguardandoClienteOcMudou` parou em 2026-06-22 05:00 (data do desligamento do Pass E). Backfill: 51 relacionamento→AGUARDANDO VOCÊ, oc=30→RESOLVIDO.

---

## INV-022 — Agente de extravio SÓ lança a oc 49 após pré-checagem SSW com última oc ∈ {6,9,16} (REGRA INVIOLÁVEL)

**Regra (Caio 2026-06-24, PART 2):** o agente autônomo `agente-extravio-d4` lança a oc 49 ("PRAZO DE PERDAS EXPIRADO") em cards de extravio com ≥4 dias úteis. **ANTES de TODO lançamento** (modo execute E modo autônomo) ele CONFERE no SSW interno a última ocorrência real via `listarOcorrenciasNF`; só lança se `podeAgenteLancar49(ocReal)` = true (oc ∈ {6,9,16} → nada lançado pós-extravio). Qualquer outra oc — ou SSW indisponível (`null`) — → **NÃO lança**, marca `agente_extravio_status='nao_rodou'` com `motivo` explicado e o card vai pra coluna AUTÔNOMO NÃO RODOU pro operador verificar/reportar. O reconciliador do PART 1 (`sync-extravios-bastao`) PULA cards `nao_rodou` (não auto-move; INV-017). Toda ação vira `card_event` + snapshot em `cards_auditoria` (`motivo='extravio_oc49_autonomo'`, filtro próprio na AUDITORIA) com RLS por operador. Lançamento via envelope `lancarSswPortal` (idempotência + tripé, INV-013/014). Autonomia gateada pela flag global `extravios_agente_autonomo_enabled` (Caio liga após validar o lote).

**Arquivos:** `_shared/agente-extravio-regras.ts` (`podeAgenteLancar49` + testes), `agente-extravio-d4/index.ts` (scan/execute, pré-checagem em ambos), `sync-extravios-bastao/index.ts` (pula `nao_rodou`), `cards` colunas `agente_extravio_*` (mig 256), auditoria (mig 258), flag (mig 259).

**Como verificar:**
```bash
# (a) Regra pura testada (6/9/16→lança; resto/null→não).
deno test --no-check supabase/functions/_shared/agente-extravio-regras.test.ts   # 4 passed

# (b) O agente usa a regra pura nos DOIS modos (scan + execute) — sem .has inline.
grep -c "podeAgenteLancar49" supabase/functions/agente-extravio-d4/index.ts        # >= 2
grep -c "EXTRAVIO_OCS.has"   supabase/functions/agente-extravio-d4/index.ts        # = 0

# (c) Lançamento via envelope (auto_aprovar_e_executar → executor → lancarSswPortal), NÃO direto.
grep -c "auto_aprovar_e_executar" supabase/functions/agente-extravio-d4/index.ts   # >= 1
grep -c "lancarOcorrenciaPortal"  supabase/functions/agente-extravio-d4/index.ts   # = 0

# (d) Reconciliador PART 1 pula nao_rodou.
grep -c "agente_extravio_status.*nao_rodou" supabase/functions/sync-extravios-bastao/index.ts  # >= 1
```

**Como verificar (SQL produção, read-only):**
```sql
-- DURO: nenhum card com a oc 49 lançada pelo agente que ainda esteja EXTRAVIO_MONITORADO
-- (lançou → tem que ter saído pra AGUARDANDO VOCÊ).
SELECT count(*) FROM cards WHERE agente_extravio_status='lancou' AND state='EXTRAVIO_MONITORADO'
  AND bastao_data_ultima_ocorrencia < ((agente_extravio_checado_em - interval '3 hours')::date);
-- = 0 → PASS. (2026-09-30, INV-163: só o preso NO MESMO ciclo; ciclo novo esperando o limiar é medido no INV-163.)

-- Todo card nao_rodou tem motivo explicado (o agente SEMPRE explica).
SELECT count(*) FROM cards WHERE agente_extravio_status='nao_rodou' AND coalesce(trim(agente_extravio_motivo),'')='';
-- = 0 → PASS.
```

**Memory:** [project_agente_extravio_autonomo_d4.md](memory/project_agente_extravio_autonomo_d4.md)
**ADR:** [docs/decisions/0007-agente-extravio-autonomo-d4.md](decisions/0007-agente-extravio-autonomo-d4.md)
**Cenário real:** 2026-06-24 — 1ª validação NF 1090036 (Larissa): agente conferiu SSW (oc ainda 6), lançou a 49 via envelope, card → AGUARDANDO VOCÊ em 10s com as propostas da oc 49; leftover de extravio canceladas. Risco que a regra trava: lançar a 49 "em cima" de uma oc que já localizou/devolveu (ex: oc 20 lançada pós-extravio antes do D+4) — geraria oc duplicada/errada e estresse com o cliente.

---

## INV-023 — Visibilidade decide pela VERDADE DO SSW POR IDENTIDADE (ai.salex × terceiro), NÃO por relógio (REGRA INVIOLÁVEL)

**Regra-mãe (Caio 2026-06-30, raiz NF 346896; supersede a versão "por HORA" do ADR 0009):** **Bastão é GATILHO, SSW é JUIZ.** Quando um card parado (TRANSFERIDO/etc, ou AGUARDANDO_CLIENTE) tem o Bastão sinalizando oc de relacionamento, a visibilidade é decidida pela **ocorrência mais recente real do SSW + a IDENTIDADE de quem a lançou** — **NUNCA** por comparação de relógio (a versão por HORA misturava hora-SSW em minuto cheio × `iniciado_em` em segundos, skew ~1-2 min → escondia oc de relacionamento nova de terceiro lançada no mesmo minuto de uma ação do Cockpit; NF 346896: oc 19 marianep 13:13 acima de oc 56 ai.salex 13:12, mas iniciado_em 13:14:01 → suprimida 97×).

**Decisão (`decidirVisibilidadePorSsw`, 4 valores explícitos):** oc topo **54** → `AGUARDANDO_CLIENTE` (independe do autor). Topo **não-relacionamento** → `MANTER_FORA_RELACIONAMENTO`. Topo **relac ≠54 por `ai.salex`** (conta oficial do Cockpit, INV-013) → `MANTER_FORA` (nossa ação, Bastão lagando → mata bounce-back). Topo **relac ≠54 por TERCEIRO** → `MOSTRAR_OPERADOR` (AGUARDANDO VOCÊ). **Em dúvida NÃO esconde:** autor desconhecido / SSW indisponível / cache stale → `INDEFINIDO_RETRY`; **autor desconhecido + código igual ao último lançamento nunca vira "manter fora"** (código sozinho não é fingerprint). **Prazo do INDEFINIDO_RETRY** ~1h/2 ciclos → depois escala pra `MOSTRAR` (evento `ReaberturaPorIndefinidoExpirado`) — nenhum Relacionamento fica invisível sem prazo. **Preferir falso-positivo controlado a Relacionamento invisível.** SEM comparação `data` SSW × `iniciado_em`.

**R2 (coberto, intocado):** card AGUARDANDO_CLIENTE cuja oc vira NÃO-relacionamento → CONFLITOS (`flagConflitoOcSemMover` via `cardEmEscopoProtegido`, Pass B), não some. Este fix não toca esse caminho.

**Implementação:** `_shared/decidir-visibilidade-ssw.ts` (`decidirVisibilidadePorSsw` + `estadoFinalParaDecisao` + `normalizarAutor`) + `descobrirUltimaOcSsw` devolve `ocorrencias[]` com `usuario` (autor) + sync-bastao (`decidirReaberturaCandidato` no candidatoReabertura; `naoRebaixarComDesempateSsw` no sweep INV-019) **atrás da flag `reabertura_por_identidade_enabled` (default OFF)**. Com flag OFF o caminho per-hora (0009, `decidirReaberturaPorSsw`) fica INTACTO = rollback imediato por flag. Guard: `decidir-visibilidade-ssw.test.ts` (P1–P13 puros + mapeamento callers) + INV-023 no verify-cockpit. Shadow (`reabertura_shadow_log` / flag `reabertura_shadow_enabled`) validou nova × atual antes de ligar. Ver ADR 0011.

> **Atualização 2026-08-07 (alerta zumbi NF 371705):** o MONITOR do INV-023 (`checkReaberturaIndefinidaPresa`, health-check) rastreava a entrada no `INDEFINIDO_RETRY` mas só conhecia 4 eventos de saída — um card que saiu do limbo pelo SWEEP INV-019 (`AguardandoClienteOcMudou`), foi tratado (oc 56 confirmada) e transferido re-disparou o mesmo email de hora em hora por 13h. A decisão vive agora em `_shared/inv023-indefinido-preso.ts` (`acharIndefinidosPresos` + `EVENTOS_SAIDA_INDEFINIDO` completa). Regra: TODO caminho novo de saída do INDEFINIDO_RETRY entra em `EVENTOS_SAIDA_INDEFINIDO`; `BastaoCardAtualizado` NUNCA entra (dispara sem mudança de estado — silenciaria card genuinamente preso). Guard: `inv023-indefinido-preso.test.ts` (7 casos, âncora NF 371705) + check no verify-cockpit.

**Cenário real:** 2026-06-30 — **NF 1086787** (prova viva): suprimido correto (nossa oc=56) → terceiro `anselmo` lançou oc=49 05:44 → **reabriu sozinho** pra AGUARDANDO VOCÊ, cliente respondeu. **NF 346896** (raiz): terceiro (marianep) lançou oc=19 acima da nossa oc=56 → antes escondido pela comparação de relógio, agora MOSTRA por identidade. Validado ~27h/57 ciclos: 0 erro, 0 bounce-back, 0 bloqueador ai.salex, 0 card invisível (`audits/MONITORAMENTO_REABERTURA_IDENTIDADE_2026-06-30.md`). Risco que a regra trava: oc de relacionamento nova de terceiro sumir do operador (346896) E re-mostrar ação nossa já tratada (bounce-back 351193) — as DUAS.

---

## INV-034 — Extravio PARCIAL: oc 33 de COMPLETUDE exige romaneio + descrição + valor (extravio TOTAL não regride)

**Regra.** Duas naturezas de oc 33 (handoff pro Ressarcimento):
- **COMPLETUDE de indenização** — só pode ser lançada com as **3 evidências** (romaneio + descrição dos itens + valor dos itens). É a única oc 33 do Caso 1 (extravio parcial entregue, pós-oc 19) e a 2ª do Caso 2 (pós-devolução).
- **OPERACIONAL (combo com 44)** — Caso 2 (devolução): sai **só com romaneio**, destrava a devolução física. NÃO marca indenização completa.
- **Extravio TOTAL** — inalterado: a oc 33 exige só o romaneio (`ehExtravioParcial=false` → gate no-op).

**Onde vive.** Dossiê das 3 evidências em `cards.agent_state.extravio_parcial.dossie`, populado pelo `interpretador-resposta-cliente` (LLM classifica `evidencias_recebidas`; evidência ao SSW vem da FONTE ORIGINAL — anexo do cliente ou trecho VERBATIM do corpo, nunca paráfrase). Módulo puro `_shared/extravio-parcial-dossie.ts` (`avaliarDossie`, `classificarOc33`, `decidirGateOc33`, `mergeEvidencia`, `ehExtravioParcial`). Gate global (modo AVISADO — anota `meta.gate_oc33`, não remove a proposta) nos DOIS finalizadores: `_shared/propostas-pos-resposta-cliente.ts` e `_shared/regras-auto-acao.ts`. Enforce AUTORITATIVO no `executor/index.ts` (`gateOc33Enforce`, lê o dossiê VIVO na hora de lançar): recusa a oc 33 de completude com dossiê incompleto (e o combo operacional sem romaneio) **só quando a flag `extravio_parcial_gate_enforce` = ON** e o operador não forçou via `extras.forcar_oc33_dossie_incompleto`. Também: os handlers de oc 33 passam o texto ao SSW com `.slice(0,500)` (era 70 — truncava descrição/valor); `lancarOcorrenciaPortal` divide em f6(70)+observ(500).

**Rollout.** Shadow-first: `extravio_parcial_dossie_enabled=ON` (popula dossiê + telemetria `DossieExtravioAtualizado`/`Oc33BloqueadaDossieIncompleto`), `extravio_parcial_gate_enforce=OFF` (só observa) — mig 285.

**Guard:** `_shared/extravio-parcial-dossie.test.ts` (21 testes) + INV-034 no verify-cockpit.

**Cenário real:** 2026-07-01 — NF 66193 INOVAMED / Larissa. Extravio parcial: o agente sugeria/lançava a oc 33 (handoff pro Ressarcimento) sem garantir as 3 informações; cliente mandava só o romaneio e o processo de indenização abria incompleto. Risco que a regra trava: (a) oc 33 de completude com dossiê furado; (b) regredir o extravio total (que só precisa de romaneio); (c) o corte-em-70 voltar e truncar a descrição/valor no SSW.

---

## INV-038 — Nome de operador é CHAVE de matching Cockpit×Bastão; rename tem que ser dos DOIS lados + cards ativos

**Regra.** O match do dono do card é carteira-CNPJ primeiro, mas o fallback (Path 2 do `operador-resolver.ts` e o trigger `cards_resolve_operator`, mig 007) é **igualdade case-insensitive com `operadores.nome`**. Consequências invioláveis:
- (a) **0 cards não-terminais com `responsavel_relacionamento` preenchido e `assigned_operator_id` NULL** — órfão de resolução = nome que o Bastão manda não existe em `operadores` (drift de rename).
- (b) **0 cards não-terminais cujo `responsavel_relacionamento` não bate com nome de operador ATIVO** — texto defasado pós-rename: some dos filtros por nome (`cron-sync-prioridades-ai`, full-pull Curva F) e assina e-mail com nome errado.
- Rename de operador = migration que muda `operadores.nome` **E** o texto dos cards ativos (com `card_events`), nunca só um dos dois.
- **"Nada fica órfão" (Caio 2026-07-21, mig 305):** cascata esgotada (carteira → nome → segmento sem match) cai no operador com `operadores.recebe_cards_orfaos=true` (hoje ISABELY; índice único garante máx. 1) — Path 4 `fallback_orfao` do `operador-resolver.ts` + fallback no trigger `cards_resolve_operator` (que também canoniza o texto do card). O fallback **NÃO** se aplica a `carteira_dormente`, `cnpjs_excluidos_cockpit` (blacklist) nem a ambíguo — curtos-circuitos deliberados que continuam null (dormente/blacklist) ou acusados pelo INV-036 (ambíguo). Deve existir **exatamente 1** operador-fallback ativo.
- **Segmento é normalizado** (`normalizarCodigoSegmento`): o Bastão manda rótulo (`"043 - CURVA F"`); comparar cru com `segmentos={043}` nunca casa (era a 2ª causa do órfão de 2026-07-21 — a implementação da "Fase 2" existia só como teste no master e foi completada junto com a mig 305).
- **Secret de leitura SSW não deriva mais só do nome:** `operadores.ssw_secret_prefix` (NULL = deriva do nome como sempre) — rename de operador não pode trocar a conta SSW silenciosamente. ISABELY → `'ISA_E_KAROL'` → `SSW_INTERNAL_ISA_E_KAROL_*` (mesma conta padrão de sempre). `loadSswInternalEnvForCard` resolve o operador canônico (por id) ANTES do texto do card.

**Guard:** INV-038 no verify-cockpit (3 checks SQL + `operador-resolver.test.ts`). Receitas: `migration/2026-07-21_304_rename_isa_karol_isabely_camila_felipe.sql` + `migration/2026-07-21_305_fallback_orfao_isabely_ssw_prefix.sql`.

**Cenário real:** 2026-07-21 — Bastão renomeou ISA E KAROL→ISABELY e CAMILA→FELIPE às 17:00 UTC; o Cockpit ficou pra trás por algumas horas e produziu 2 cards ativos órfãos 'ISABELY' (invisíveis pra operação, únicos órfãos ativos do sistema) + filtros por nome no Bastão retornando vazio pros dois. Mig 304 alinhou (rename + 402 cards ativos + 2 órfãos resolvidos). No mesmo dia o Bastão mandou responsável `"KAROL"` (pessoa fora do Cockpit, ≠ KAROLINE — confirmado pelo Caio) → sem fallback, viraria órfão de novo; mig 305 fecha a classe inteira.

---

## INV-040 — Sync NUNCA fabrica cards em loop: ≥3 terminais da NF criados em 24h bloqueia criação

**Regra.** O `uniq_cards_nf_active` é **parcial de propósito** (re-ocorrência legítima de NF cria card novo; NÃO mexer no índice). Consequência: ele não protege contra o loop **criação→terminal→recriação** — se uma regressão de roteamento fizer o card nascer/virar terminal no mesmo ciclo, o sync seguinte vê "NF sem card ativo" e cria outro, 1 por ciclo (~30 min), pra sempre. Guard obrigatório nos **2 pontos de criação** do sync-bastao (`handleExtravioPendencia` e `upsertCardFromPendencia`): `bloquearCriacaoSeLoopDetectado` (`_shared/guard-anti-loop-criacao.ts`) — com ≥3 cards TERMINAIS (RESOLVIDO/CANCELADO/TRANSFERIDO) da NF criados nas últimas 24h, NÃO cria; loga + `card_event` `LoopCriacaoCardDetectado` no card mais recente (dedupe 1/24h). Fail-open: erro de banco no guard nunca bloqueia criação legítima. Caminho de criação NOVO no sync = obrigatório chamar o guard.

**Guard:** INV-040 no verify-cockpit (grep ≥3 ocorrências no sync + `guard-anti-loop-criacao.test.ts` + SQL "nenhuma NF com >3 cards criados em 24h") + marcador `bloquearCriacaoSeLoopDetectado` no `.claude/deploy-guards.json`.

**Cenário real:** 2026-07-14/15 — NF 2084: 74 cards fabricados em rajada (1 por ciclo de ~30 min). O roteamento pré-59 (deployado na época) fazia o card oc=59 **nascer direto em TRANSFERIDO** (30 cards com evento único `BastaoCardImportado`, `created_at`=`updated_at` ao milissegundo); o Bastão alternava a NF entre 2 CTRCs (AMB=oc59 relacionamento ↔ TTO=oc20 extravio), então `encerrarCardAntigoSeCtrcMudou` encerrava o card ativo a cada ciclo e o par era recriado no ciclo seguinte. Mesma classe em datas anteriores: NFs 23657 (66 cards 07-08/07), 339024 (42 cards 30/06-01/07), 137344 (42 cards 07-08/07). Dossiê: `audits/BUG_NF2084_CARDS_DUPLICADOS_2026-07-21.md`.

---

## INV-041 — Aprovação com e-mail NUNCA às cegas + aval de evidência acessível + airbag global

**Regra.** (1) Ação que envia e-mail (`lancar_oc_e_enviar_email`, `enviar_email_e_lancar_33_romaneio_interno`, `enviar_email_livre_e_lancar_oc33_portal`) **nunca** é aprovada sem passar por uma janela de edição: o botão "aprovar ação →" do item ⭐ RECOMENDADA decide via `decidirCliqueAprovacao` (`apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts`) — e-mail/romaneio-interno → `EditarEmailModal`, e-mail livre+oc33 → modal próprio (`emailOc33ModalTodo`), combo 44+59 → modal do combo, demais → direto. (Ampliado 2026-07-22 tarde — Larissa, PRATI NF 1025518: romaneio-interno aprovava direto no `confirm()` nativo sem opção de editar o e-mail.) (2) O aval "Não validar evidência" (`extras.skip_evidencia`) pra ocs de validação forçada `{10, 11, 35}` existe em **TODAS** as superfícies que enviam e-mail: `EditarEmailModal` E `BannerInline54Composer` (espelhos exatos — mesma condição `[10, 11, 35].includes(cod_ultima_ocorrencia_card)` vinda do RPC `preview_email_todo`). (3) `main.tsx` envolve `<App />` com `<ErrorBoundary>` (+ `window.onerror`/`unhandledrejection` com prefixo `[cockpit-crash]`): crash de render vira tela de erro com stack visível, nunca tela branca morta.

**Guard:** INV-041 no verify-cockpit (arquivo+uso do decidir-clique + `decidir-clique-aprovacao.test.ts` + grep das duas superfícies skip_evidencia + grep `<ErrorBoundary>` no main).

**Cenário real:** 2026-07-22 — NF 51712 (ISABELY, oc=11): botão ⭐ RECOMENDADA aprovou com `extras=null` → executor bloqueou com "Evidencia ausente" e reverteu, 5 batidas em 30min, operador sem saída (o checkbox só existia no modal, que nunca abria). NF 556392 (FELIPE): clique em aprovar → tela 100% branca sem stack (sem ErrorBoundary, gatilho incapturável); operadores contornavam aprovando oc=41 → cliente NÃO recebia pedido de romaneio (dano silencioso). 2ª regressão do aval de evidência na história do projeto (1ª na era Lovable — prompts `lovable-restaurar-nao-validar-evidencia`).

---

## INV-042 — Premissa da resposta de cliente (Caio 2026-07-23): card ATIVO se move; terminal não ressuscita

**Regra (as 3 premissas do Caio).** (1) Resposta real de cliente (não-bounce; filtro no gmail-poll, NF 5826) + card **ATIVO** no Cockpit → o card **SE MOVE, sempre** (AVH + lock + carimbo + propostas pós-resposta + interpretador). (2) Card `TRANSFERIDO`/`RESOLVIDO` = alguém tratou → resposta **anexa SEM mover** (evento `RespostaClienteEmCardTransferido`); se a NF tiver **outro card ativo**, a resposta é **roteada pra ele** (evento `MensagemRoteadaParaCardAtivo`; o lookup por NF do vinculador também prefere card ativo). (3) Card novo criado depois pelas regras de negócio entra na premissa 1. Fonte única da decisão: `decidirAcionamentoPorRespostaCliente` (`_shared/acionamento-resposta-cliente.ts`) — usada nos DOIS caminhos do vinculador; nunca reimplementar inline (a divergência entre os 2 caminhos criou o buraco original). Detecção de violação sempre POR EVENTO, nunca por carimbo (executor zera `cliente_respondeu_em`). `EXTRAVIO_MONITORADO`/`CANCELADO` fora deliberadamente (INV-017). 3ª camada: watchdog `checkRespostaClienteEngolida` (health-check, só cards ativos, e-mail ≤2h).

**Guard:** INV-042 no verify-cockpit (fonte única + uso ≥3 no vinculador + `acionamento-resposta-cliente.test.ts` — inclui anti-regressão "terminal NUNCA volta a acionar" — + watchdog ≥2 + SQL "nenhuma resposta muda em card ATIVO em 24h").

**Cenário real:** 2026-07-16→23 — NF 73220 (LARISSA/LEONE): oc 59 lançada 08:42; confirmador pré-59 (regressão de deploy 13-21/07, corrigida na regularização de 22/07) classificou 59 como "outras" → card TRANSFERIDO às 08:42 (evento com `state_novo:'TRANSFERIDO'`). Cliente respondeu COM O ROMANEIO às 09:56 → vinculador anexou e ficou MUDO (thread path ignorava terminal; ramo de reabertura por NF suspenso em 12/05 apostando no "sync reabre" — aposta anulada pelo guard de identidade ADR 0011: **83 supressões em 7 dias**). 2ª resposta 22/07 idem. Karoline destravou na mão (FORÇAR ATUALIZAÇÃO 23/07). Escala: 52 confirmações pré-59 mandaram oc 54/59 pra TRANSFERIDO; ~22 ainda presos; 15+ NFs com respostas engolidas (uma com 18). Retroativo: `audits/retroativo-respostas-engolidas-e-oc59-transferido-2026-07-23.sql`.

---

## INV-043 — Camada de captura viva: toda caixa Gmail com credencial tem rodada de leitura

**Regra.** O gmail-poll roda a cada 5min com orçamento global (100s) e **fatia por caixa** (25s) sobre a ordenação **mais-defasada-primeiro** — fonte única `lastPollAtDoEmbed`+`ordenarPorDefasagem` (`_shared/gmail-poll-batch.ts`), tolerante ao formato do embed do PostgREST (OBJETO na relação 1-pra-1; ler `[0]` como array foi o bug). Nenhuma caixa pode monopolizar a rodada; ciclo completo das 9 caixas fecha em ≤3 rodadas (~15min). Caixa com credencial sem rodada há >2h = violação. Esta é a camada que o INV-042 não enxerga: ele detecta "capturada e não processada"; o INV-043 detecta "**nunca capturada** — resposta parada no Gmail". 3ª camada: watchdog `checkCaixaGmailSemPoll` (health-check, e-mail ≤2h).

**Guard:** INV-043 no verify-cockpit (uso da fonte única + fatia + testes do rodízio com caso âncora + watchdog + SQL "nenhuma caixa faminta >2h").

**Cenário real:** 2026-07-23 — deploy do PR #24 (sequencial+orçamento) às 08:29 expôs a ordenação que nunca funcionou: embed objeto lido como array → empate universal → KAROLINE+JULIA comiam os 100s toda rodada → 7/9 caixas com ZERO leituras. Capturas/dia do DUILIO: 43 → 1. NF 389040: resposta do cliente ficou parada na caixa `ferramentas.construcao@` desde 10:28, invisível pra TODAS as camadas (sem RespostaClienteCapturada, INV-042 cego). Sob o v59 o paralelismo mascarava (progresso parcial com worker-kill — 69 mortes/6h, NF 1504049). Latente documentado: re-mastigação de msgs não-casadas <7d (dreno lento; fix profundo = checkpoint/history_id do PR #24).

---

## INV-044 — O app nunca é traduzível pelo navegador (lang pt-BR + notranslate)

**Regra.** `apps/cockpit-web/index.html` declara `lang="pt-BR"`, `translate="no"` e `<meta name="google" content="notranslate">`. Motivo: o Google Tradutor do Chrome reescreve os nós de texto POR FORA do React; na primeira remoção de nó (fechar modal ao aprovar, redesenhar lista) o React não encontra o filho onde o deixou → `NotFoundError: removeChild` (bug clássico React#11538). O `lang="en"` num app 100% pt-BR era o convite à auto-tradução.

**Guard:** INV-044 no verify-cockpit (grep dos 3 marcadores no index.html).

**Cenário real:** 2026-07-23 — FELIPE aprovava comandos e caía na tela do airbag com `removeChild`. A prova estava no próprio print: o texto do NOSSO airbag veio REESCRITO ("Algo quebrou nesta tela"→"ALGO CORTE NESTA TELA", "pra"→"para") = tradutor ativo mutando o DOM. Fecha também o **Bug A histórico** (tela branca NF 556392, mesmo operador): antes do airbag o crash derrubava a árvore inteira sem rastro; a 1ª captura do airbag identificou o gatilho. Pilha 100% react-dom, zero manipulação direta de DOM no código (verificado).

---

## INV-045 — Anexo não-suportado FORA da seleção (modais oc=33)

**Regra.** Arquivo que o SSW não aceita (nem imagem JPEG/PNG nem PDF) fica fora do universo de seleção dos modais de oc=33 (solo e combo 33+44): (1) a pré-seleção marca o primeiro anexo **SUPORTADO** via fonte única `primeiroAnexoSuportadoSsw` (`lib/anexos-ssw-elegiveis.ts`), nunca o primeiro da lista; (2) não-suportado é linha **informativa sem checkbox**; (3) a validação do confirmar **ignora** não-suportados (console.warn), nunca bloqueia. As três peças juntas eliminam a categoria "inválido dentro da seleção" — sem ela, não existe estado travado.

**Guard:** INV-045 no verify-cockpit (uso ≥3 + testes com âncora + zero pré-seleção cega + zero muro "Remova:").

**Cenário real:** 2026-07-23 — NF 814961 (DUILIO/O.V.D.): 1º anexo do cliente era `image001.gif` (logo de assinatura, 8 KB). Pré-seleção cega marcou; checkbox desabilitado (`disabled={!ehImg && !ehPdf}` — feito pra impedir marcar, também impedia desmarcar); confirmar bloqueava com "SSW só aceita JPEG/PNG/PDF. Remova: image001.gif". Operador preso. Padrão copiado nos 2 modais.

---

## INV-046 — oc 41/56 NUNCA lança sem o texto do operador (3 camadas)

**Regra.** 41 (informação complementar) e 56 (falta info operacional) existem POR CAUSA do texto do operador que vai direto pro SSW. (1) Front: `decidirCliqueAprovacao` roteia `lancar_ocorrencia` de `OCS_COM_INPUT_OBRIGATORIO` (41/44/55/56) pra rota `abrir-input` — o ⭐ RECOMENDADA ABRE o painel expandido existente (que valida obrigatoriedade), nunca aprova direto. (2) Backend fail-closed: `camposObrigatoriosAusentes` (`_shared/descricao-ssw.ts`) exige `extras.texto_descricao` pra 41/56 — front atropelado vira erro visível no executor, nunca lançamento mudo. (3) SQL vivo: nenhuma aprovação de 41/56 sem texto em 24h. 3ª regressão da classe aprovação-às-cegas (INV-041 fechou e-mail; esta fecha input).

**Guard:** INV-046 no verify-cockpit. **Cenário real:** 2026-07-23 — NF 62566 (LARISSA/MEDH): ⭐ RECOMENDADA aprovou a 56 com `extras: null` (provado no AprovacaoOperador) → oc saiu pro SSW com a descrição genérica da proposta, sem o texto dela.

---

## INV-047 — Extravio parcial com trilha de indenização destaca 59; par 59+email sempre no cardápio

**Regra.** (1) `decidirOc49` caso extravio_parcial consulta `temContextoIndenizacao` (`_shared/contexto-indenizacao.ts`): oc 59 no histórico (sinal forte) ou instrução com ROMANEIO (explícito) → destaca 59 via template `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` (já no set `TEMPLATES_INDENIZACAO_59` — fonte única do destaque). "VALOR"/"DESCRIÇÃO" sozinhos não contam (anti-falso-positivo). (2) As regras da família tratativa (49/26/23/43) têm SEMPRE o par completo da 59 (com e sem e-mail) — a operadora decide mesmo quando o agente destacar outra.

(3) Re-análise que **muda o trilho** (54↔59) converte o todo clicável COMPLETO — `repatcharTemplateEmail54Existente` troca codigo_ssw + acao_key + template (não só template; senão destaque :59 aponta pra todo :54 = "ação não está mais pendente"). (4) **FORÇAR ATUALIZAÇÃO re-dispara o agente** pras ocs cobertas ({10,11,19,35,49}) — a decisão do banner nunca fica em cache. (5) **Invalidação automática por VERSÃO de regra** (`VERSAO_REGRAS_ANALISE` — BUMP obrigatório a cada mudança na lógica de decisão): o cron invalida análises `concluida` de cards com banner VIVO (AVH/AGUARDANDO_AGENTE/AGUARDANDO_CLIENTE) cuja versão carimbada difere → re-análise automática pós-deploy, **sem o operador clicar em nada** (regra do Caio 23/07: "sem esse trabalho manual"). TRANSFERIDO fica fora (banner morto — 425 cards, custo de IA sem valor). (6) **REGRA DAS 4 OPÇÕES (Caio 23/07)**: card com oc 49 tem SEMPRE `54±email` e `59±email` ativas — o agente sugere, a OPERADORA decide, e a escolha alimenta o loop de aprendizado. Consequências estruturais: `aplicarOverrideCodigoCliente` APOSENTADA (identidade — converter 54→59 comia a opção 54+email) e o repatch mira o todo do trilho destacado trocando SÓ o template (nunca converte; ausente → proporAutoAcao cria pelo par nativo). (7) **Relançamento 59 SEM e-mail**: histórico no formato `49←[46...]←59` (indenização recobrando o que JÁ foi pedido — o e-mail foi junto da 59 anterior) → caso `relancamento_indenizacao`, destaque `lancar_ocorrencia:59` (template nulo), banner "Relançar oc=59 (sem e-mail) — cliente já cobrado". Detector puro `ehRelancamento59SemEmail` (cadeia quebrada por qualquer outra oc → fluxo normal 59+email).

**Guard:** INV-047 no verify-cockpit (6 checks). **Cenário real:** 2026-07-23 — NF 1100040 (LARISSA/UNIAO QUIMICA): histórico 59 ("aguardando romaneio + descrição/valor") → 46 → 49 "AG DESCRICAO E VALOR"; agente destacou 54+EXTRAVIO_PARCIAL e o cardápio só tinha o gêmeo sem-email da 59. 2ª rodada no MESMO dia: fix deployado mas "não pegou" na tela — FORÇAR não re-rodava o agente (cache) e, re-rodado por trás, o repatch só trocou o template (todo :54 com destaque :59). Lição: retroativo de cards pré-existentes é PARTE do fix.

---

## INV-049 — O front TEM typecheck real no caminho até produção

**Regra.** (1) O script `build` do `apps/cockpit-web` roda `npm run typecheck && vite build` — a Vercel FALHA o deploy em erro de tipo (falha segura: a versão anterior continua servindo, em vez de crashar na mão do operador). (2) O script `typecheck` aponta pro config REAL: `tsc --noEmit -p tsconfig.app.json`. **Armadilha nomeada:** o `tsconfig.json` raiz é solution-style (`"files": []` + references) — `npx tsc --noEmit` SEM `-p` checa zero arquivos e sempre sai 0. NUNCA aceitar esse comando como evidência de "tsc OK". (3) Estado (useState/useRef) e o JSX que o consome moram no MESMO componente — o typecheck (TS2304) é a trava mecânica disso.

**Guard:** INV-049 no verify-cockpit (gate no build + config real + tsc rodando de fato). **Cenário real:** 2026-07-24 — commit `a37100f` (F4 popup de divergência) renderizou `DivergenciaMotivoDialog` dentro de `ValidacaoHumanaList` usando `divergInfo`/`divergResolver` que vivem no `ProposedActions` → `ReferenceError: divergInfo is not defined` em TODA abertura de card, TODOS os operadores travados na primeira manhã pós-deploy. O erro era um TS2304 trivial que atravessou merge + build + deploy porque nenhuma etapa checava tipos — e os "tsc OK" históricos eram o comando vazio.

---

## INV-050 — ⭐ RECOMENDADA roteia pra janela da ação; popup F4 diverge só da sugestão VIGENTE

**Regra.** (1) `decidirCliqueAprovacao` tem rota pra TODA ação com janela própria — incl. `modal-oc33-solo` e `modal-combo-3344` (modal de anexos com conversão PDF→JPEG) — e o roteador ⭐ mapeia cada destino pro setter do modal correspondente. Ação com janela NUNCA cai em `aprovar-direto`. (2) Quando a recomendada exige input (41/44/55/56) e está expandida (rota `abrir-input`), o ramo ⭐ cai no render normal com o painel aberto — o clique sempre tem efeito visível. (3) `detectarDivergencia` só acusa divergência quando NENHUMA sugestão viva do card endossa a ação aprovada: todo `recomendada=true`, todo nascido do fluxo pós-resposta (`meta.origem = 'vinculador_pos_resposta_cliente'` — camada mais nova por definição, cobre cards com `ia_sugestao_oc_resposta` nulo), interpretador (`ia_sugestao_oc_resposta`: `oc_sugerida`/`sugere_oc33_solo`/`sugere_combo_33_44`/`sugere_combo_44_59`), ou mesmo código em variante ±email (regra das 4 opções — prerrogativa da operadora). Gêmeo sem-email do MENU comum (meta `modo='sem_email'`, sem origem pós-resposta) segue divergindo — é o aprendizado legítimo. Aprovar a ⭐ que a própria UI mostra NUNCA abre popup.

**Guard:** INV-050 no verify-cockpit (rota + handler + painel + endosso + testes-âncora). **Cenário real:** 2026-07-24 — NF 158084 (DUILIO): ⭐ "Lançar 33" aprovou às cegas (`anexos_ids=[]`) → executor reverteu por completude; e o popup F4 disparou contra o banner VELHO (59+email de antes da resposta do cliente) — motivo digitado pelo operador: "Sugeriu 33 eu aprovei lançar 33 e apareceu o pop up - errado" (23 popups/22 cards no dia). NF 1094294 (LARISSA): ⭐ 56 clicada → rota `abrir-input` setava `expandidoId`, mas o ramo ⭐ fazia early-return sem painel → clique morto, aprovação nunca chegou ao banco.

---

## INV-052 — Onda 1 da auditoria 25/07: resposta nunca engolida + oc33 sem loop + fila drenada

**Regra.** (1) **Regra da oc no acionamento** (Caio 25/07, verbatim no código): quem define "está no cockpit" é a OCORRÊNCIA — estado terminal + oc de relacionamento/cliente (`ocPertenceAoCockpit`) → resposta ACIONA (terminal transitório do confirmador não engole resposta); oc fora do escopo → anexa sem mover (tratado de verdade, ex. 158084 oc=46). (2) **Relançamento pós-resposta é isento do auto-cancel** (`ehPropostaPosRespostaMesmaOc`): a proposta mira a MESMA oc por construção — "lançada por fora" nunca vale pra ela. (3) **Romaneio coberto por FILENAME** (`anexosCobremRomaneio`, _shared + espelho front): anexo do operador SÓ pula o bloco do romaneio se for o próprio arquivo ou páginas convertidas `<base>_pN.jpg`; assinatura PNG não vale; modais barram confirmação sem o romaneio exigido pelo dossiê nomeando o arquivo. (4) **Modais oc33 só oferecem anexo vivo** (`.is('deletado_em', null)`). (5) **Scan idempotente + dreno**: card terminal ou sinal já decidido/tratativa escolhida → skip (nunca clobbera decisão nem re-adota); consumo em loop com RUN_BUDGET_MS.

**Guard:** INV-052 no verify-cockpit (5 greps + teste-âncora + SQL vivo "resposta muda em card ativo = 0"). **Cenário real:** 24-25/07 — NFs 150431/174438 (+4) com resposta engolida por TRANSFERIDO transitório; 158084 2× aprovar→reverter (romaneio) e 134/134 relançamentos comidos pelo sync; NF 2549 com a mesma thread re-importada 44× (loop VIVO durante a auditoria); fila scan com 94k/27 dias. Retroativos executados: 7 cards destravados (RetroativoRespostaDestravada) + 27 relançamentos restaurados (RetroativoTodoRestaurado).

---

## INV-053 — Onda 2 da auditoria 25/07: conversão JBIG2 ligada + aprovação nunca às cegas em NENHUMA superfície

**Regra.** (1) `convertPdfBlobToJpegFiles` passa `wasmUrl` (assets em `public/pdfjs-wasm/`, nomes sem hash, espelho byte-a-byte do pdfjs-dist instalado — teste `pdfjs-wasm-sync`); o guard NF-135724 é rede de segurança, não muro. (2) Popup F4 só COLETA o motivo; o registro roda DEPOIS do `aprovar_e_executar` OK (NF 1094098: 4 motivos órfãos pra 1 aprovação); sugestão cuja acao_key não existe no cardápio pendente não popa (NF 1122403). (3) Gêmeo sem-email SEMPRE renderiza pelo ramo próprio (confirm deliberado + rótulo honesto com a oc real), mesmo destacado. (4) `ProposalCard` (cards fora de AVH) e `SugestaoIATopBox` roteiam pela fonte única `decidirCliqueAprovacao` — ação com janela nunca aprova direto dessas superfícies. (5) Botão confirmar do painel expandido usa lock GLOBAL (`aprovacaoEmVoo`). (6) gmail-poll não memoiza falha transitória como "sem NF".

**Guard:** INV-053 no verify-cockpit (7 checks). **Cenário real:** 24-25/07 — PDF JBIG2 da 158084 (contorno manual desnecessário: o decoder já estava instalado, só desligado); TopBox morto em 14/15 cards; 634 todos oc33/combo expostos a aprovação às cegas fora de AVH; NFs 101182/343285 com ⭐ mentindo "com email".

---

## INV-057 — Thread pré-existente é importada UMA vez por card

**Regra.** `processarAdocaoJob` decide por `decidirAdocaoThread` (fonte única, `_shared/adocao-thread.ts`) ANTES de tocar o Gmail: pula quando o card já tem ESSA thread como `tratativa_email_escolhida` (sinal gravado pela própria adoção — idempotência natural), quando o card está em estado terminal, ou quando faltam card/thread. Thread DIFERENTE segue adotando (o operador pode trocar a tratativa). Como job repetido passa a custar 1 leitura, o laço drena os repetidos em série (`ADOCAO_DRENO_MS`) enquanto a adoção real (Gmail + anexos + IA) permanece 1 por ciclo.

**Guard:** INV-057 no verify-cockpit (trava + dreno + teste-âncora + SQL vivo "nenhuma thread importada 2x no mesmo card em 24h"). **Cenário real:** 2026-07-26 — fila de adoção com **15.052 jobs para 59 cards** (campeão 2.504); NF 166229 re-importada **105x em um dia** (105 movimentações do card, 105 recriações de proposta, 111 chamadas de IA); custo de IA do dia 6x o normal; no ritmo do cron (1 job/2min) o desperdício duraria ~21 dias. Cadeia da causa: produtor enfileira 1 scan por e-mail sem dedup (raiz antiga) + o dreno do INV-052 (25/07) converteu 13 dias de backlog represado em adoções reais de uma vez (gatilho). Lição: ao destravar uma fila, medir o que ela ALIMENTA, não só o que ela acumula.

---

## INV-058 — Toda fila de trabalho tem vigia (e drenar represa exige medir a jusante)

**Regra.** `checkPgmqAcumulada` (health-check) percorre `FILAS_VIGIADAS` — lista com limite por fila — e alerta o Caio quando qualquer uma passa do limite. Fila nova de trabalho ENTRA na lista junto com o consumidor. Regra irmã, aprendida na dor: **ao destravar/drenar uma fila represada, medir o que ela ALIMENTA antes** (o dreno converte represamento em trabalho real de uma vez).

**Guard:** INV-058 no verify-cockpit. **Cenário real:** 2026-07-26 — `scan_email_pre_card` acumulou **94.084 mensagens em 13 dias** sem nenhum alerta (o vigia só olhava `agent_executor` e `respostas_envio`); o dreno do INV-052 (25/07) converteu esse backlog em **15.052 jobs de adoção** que re-importaram threads centenas de vezes (NF 166229: 105x em um dia, custo de IA 6x o normal). Diagnóstico mediu que o produtor NÃO estava mais duplicando (a memória de avaliação do gmail-poll, 23/07, já havia fechado a torneira) — por isso a correção foi vigia + trava de idempotência (INV-057), não dedup por RPC.


> Atualização 2026-10-07 (ADR 0040): fila que é TABELA (não pgmq) também tem vigia. A da baixa do motorista (`baixas_motorista`) é vigiada por `checkFilaBaixasMotorista` (decisão pura em `_shared/baixa-motorista-vigia.ts`): parada >30 min com lançamento ligado, esperando com lançamento desligado (vai expirar), `lancando` travado >20 min, 3+ erros em 2 h. Guard: INV-058 conta o check.
---

## INV-061 — Agente oc 43: 49 vs 55 pela oc anterior, lançamento só via envelope, shadow-first

**Regra.** Card em oc 43 ("manutenção perecível realizada" — Relacionamento) é automatizado por `agente-oc43-autonomo`. O agente consulta o SSW ao vivo (`listarOcorrenciasNF`, pois a oc anterior NÃO está no card — `historico_ssw=null`), acha a oc IMEDIATAMENTE anterior à 43 e decide via `decidirOc43DoHistorico`: anterior ∈ `OCS_ANTERIOR_LANCA_49` = {3,6,8,9,10,11,13,16,17,18,19,20,23,31,35} → **oc 49**; qualquer outra → **oc 55**; sem oc anterior (43 é a 1ª) → **não lança** (deixa AVH manual). **Guard pós-43 (Duílio 2026-07-31):** a decisão é pela oc ANTES da 43; se DEPOIS da 43 o SSW virou PROBLEMA (∈ whitelist) ou já FINALIZOU (entregue/baixado, `OCS_FINALIZADORAS_POS43`={1,30,32}) → não lança (`bloqueiaPos43`). **Trânsito normal depois da 43** (5=viagem/7=chegada/14=entrega iniciada/40=redespacho) **NÃO bloqueia** — lança a 55 assim mesmo e o tripé barra só os entregues no submit (perecível entrega rápido, o card nasce estále). O lançamento é SEMPRE via `auto_aprovar_e_executar` → executor → envelope `lancarSswPortal` (tripé CTRC+NF+localização + idempotência) — o agente **nunca** chama o SSW direto (convenção #2). Rollout **shadow-first**: `oc43_cockpit_enabled` (roda) separado de `oc43_agente_autonomo_enabled` (lança); em shadow só marca `agente_oc43_status='recomendado'` + `card_event`. oc 55 é responsabilidade **Operação** — o Cockpit lança oc de Operação autônomo aqui (registro deliberado de blast radius).

**Guard:** INV-061 no verify-cockpit (testes da lógica pura + whitelist + envelope + não-chamada-direta + shadow) e `_shared/oc43-regras.test.ts` (11 casos). **Cenário real:** 2026-07-29 — a oc 43 caía em AVH travado com 8 botões manuais (`REGRAS_AUTO_ACAO[43]`, que gera 55 mas NÃO gera 49); a operação lançava 49/55 na mão dependendo do que veio antes. Duílio pediu a automação. Casos-âncora: NF 467507 / 287906 (os 2 cards vivos em AVH oc 43 no dia). Backlog vivo pequeno (~3-5/dia); mig 314 (colunas `agente_oc43_*` + flags + cron 10min).

---

## INV-062 — Extravio total escalado oferece 59 no menu pós-resposta (âncora≠59)

**Regra.** Extravio TOTAL que escalou pra oc 49/54 ("PRAZO PERDAS EXPIRADO") cai no trilho TRATATIVA do menu pós-resposta (`trilhoIndenizacao = anchorOc===59` → false), que por padrão não oferece o 59 de indenização. Como o desfecho de extravio total É indenização (59, pedir romaneio), o menu **mantém/revive** o 59+email (template `EXTRAVIO_TOTAL_PEDIR_ROMANEIO`) que o override 54→59 já criou. **Sinal de "extravio total"** (durável, sobrevive à sobrescrita do agent_state na escalada): a presença de QUALQUER todo oc 59 com esse template — só o override de total cria isso, então o gate `ehExtravioTotal` é **inerte** pra qualquer card que não seja extravio total. Não revive se já houver 59+email ativo (índice único `uniq_todos_card_tool_cod_ativo`).

**Guard:** INV-062 no verify-cockpit + `oc59-extravio-total.test.ts` (helpers puros `ehExtravioTotalPorTodos59` / `escolher59IndenizacaoParaReviver`). **Cenário real:** 2026-08-05, NF 1102187 UNIAO QUIMICA (LARISSA) — banner IA recomendava "oc 59 + email" (extravio total) mas o menu (âncora 49) não oferecia 59 lançável; os 59 do override foram cancelados pela escalada + "obsoleta após resposta". Relacionado a [[INV-060]] (mesmo arquivo, mesma família da separação 54/59).

**ATUALIZADO 2026-09-09 (ADR 0027, INV-149).** A garantia deste INV continua valendo, mas quem a entrega mudou: o portão da whitelist deixou de ser "é extravio total?" e passou a ser **"tem pendência de documento em aberto?"** (`temPendenciaDocumento59`, os três templates `..._PEDIR_ROMANEIO`). O total é **subconjunto** disso, então o 59 de extravio total segue sobrevivendo ao menu — agora junto com o 59 de card PARCIAL, que era o bug do Caso 1 (NF 75249). A **revivência** (bloco 3b) segue gated por `ehExtravioTotalPorTodos59`, estreita e inalterada.

Duas mudanças no comando de verificação, ambas necessárias: (a) `--allow-read` na chamada do `deno test`, porque a suíte ganhou o guard de FONTE do INV-149 e sem a permissão o deno aborta com `NotCapable` — o INV-062 acusaria "menu regrediu" por motivo falso (mesma armadilha registrada nos comentários do INV-126 e do INV-133); (b) o grep saiu do NOME do sinal para a ESTRUTURA da whitelist (`&& cod === 59 && !ehCombo4459`), senão cobrar o nome antigo daria FAIL numa mudança que **amplia** a proteção. Quem crava qual sinal gateia o quê é o [[INV-149]].

---

## INV-063 — TODO acesso SSW (leitura E lançamento) pela conta de serviço; idempotent_skip só com verdade do SSW

**Regra (Caio 2026-08-06).** (a) **Credencial única:** `readSswInternalEnv` resolve SEMPRE `SSW_LANCAMENTO_*` (conta de serviço `ai.salex`), ignorando operador; `loadSswInternalEnvForCard` não consulta mais `cards`/`operadores` (curto-circuito). A cadeia por-operador/legado (`SSW_INTERNAL_<NOME>_*` / `SSW_INTERNAL_*`) é fallback SÓ de dev/test. **NUNCA reintroduzir resolução por login pessoal de operador** — supersede a frase do INV-013 "resolução por-operador fica pra leitura". (b) **Relançamento:** no envelope `lancarSswPortal`, hit no UNIQUE com `sucesso=true` NÃO é skip cego — `decidirIdempotenciaRelancamento` consulta a última oc real do SSW: skip só se recente (<10min, duplo-clique/redelivery PGMQ), sem-verdade (conservador), ou oc pedida já no topo; senão RELANÇA (re-aprovação de todo ressuscitado após oc externa é intenção nova).

**Arquivos:** `supabase/functions/_shared/ssw-internal-client.ts` (readSswInternalEnv / loadSswInternalEnvForCard), `supabase/functions/_shared/lancar-ssw-portal.ts` (decidirIdempotenciaRelancamento).

**Como verificar:**
```bash
# (a) loadSswInternalEnvForCard não pode voltar a consultar o banco
VIOL1=$(sed -n '/export async function loadSswInternalEnvForCard/,/^}/p' supabase/functions/_shared/ssw-internal-client.ts | grep -c "\.from(" | tr -d ' ')
# (b) skip cego não pode voltar: o branch sucesso===true precisa decidir via helper
VIOL2=$(grep -c "decidirIdempotenciaRelancamento" supabase/functions/_shared/lancar-ssw-portal.ts | tr -d ' ')
{ [ "$VIOL1" -eq 0 ] && [ "$VIOL2" -ge 2 ]; } && echo "INV-063: PASS" || echo "INV-063: FAIL (loadForCard .from=$VIOL1 deve ser 0; decidir=$VIOL2 deve ser >=2)"
# Testes unitários:
# deno test supabase/functions/_shared/ssw-credencial-unica.test.ts
# deno test supabase/functions/_shared/relancamento-idempotencia.test.ts
```

**Cenário real (2 causas independentes no mesmo dia, 2026-08-06):** (a) o login pessoal `l.silva` — fallback legado de leitura pros operadores sem secret (JULIA/FELIPE/KAROLINE/LARISSA) e credencial fixa do `atualizar-card-via-portal-ssw` — parou de autenticar no SSW ~11h-12h30 BRT (200 com só cookie `remember`): 639 `AgenteOcsPadraoFalhou` em 4h30, "Edge Function returned a non-2xx status code" no Forçar Atualização (todos os cards) e no Trazer Histórico/aprovações dos 4 operadores. Quem tinha secret próprio (DUILIO/VICTOR/ISABELY) seguiu funcionando — a divisão provou a causa. Mitigação imediata: secrets legados repontados pra ai.salex. (b) NF 236391: oc=54 lançada com sucesso → oc=21 externa por cima → revert ressuscitou o todo → re-aprovação batia na linha `sucesso=true` → `idempotent_skip` afirmava sucesso sem chamar o SSW → guard de confirmação (oc real 21≠54) revertia → loop eterno (2 ciclos/min em produção).

---

## Mapa: arquivo → invariantes aplicáveis

Lookup que o hook PreToolUse usa quando dispara:

| Arquivo | Invariantes |
|---|---|
| `supabase/functions/_shared/confirmar-acao-executada-ssw.ts` | INV-002 |
| `supabase/functions/sync-bastao/index.ts` | INV-003, INV-004, INV-006, INV-007, INV-008, INV-011, INV-014, INV-019, INV-023, INV-040 |
| `supabase/functions/_shared/guard-anti-loop-criacao.ts` (guard anti-loop de fabricação) | INV-040 |
| `supabase/functions/_shared/decidir-visibilidade-ssw.ts` (por identidade, ADR 0011) | INV-023 |
| `supabase/functions/_shared/inv023-indefinido-preso.ts` (monitor indefinido preso) | INV-023 |
| `supabase/functions/_shared/lag-lancamento-54.ts`, `supabase/functions/_shared/ssw-data-hora.ts` (per-hora, ADR 0009 superseded — atrás da flag OFF) | INV-023 |
| `supabase/functions/_shared/escopo-relacionamento.ts` | INV-014 |
| `supabase/functions/_shared/operador-resolver.ts`, `migration/2026-04-29_007_operadores_seed_e_trigger.sql` + `migration/2026-07-21_305_fallback_orfao_isabely_ssw_prefix.sql` (trigger `cards_resolve_operator` + fallback), `loadSswInternalEnvForCard` em `_shared/ssw-internal-client.ts` (`ssw_secret_prefix`) | INV-038 |
| `supabase/functions/voltar-para-to-do-com-rastreio/index.ts` | INV-001, INV-005 |
| `supabase/functions/_shared/ssw-internal-client.ts` | INV-001, INV-012, INV-013, INV-063, INV-178 |
| `supabase/functions/_shared/lancar-ssw-portal.ts` | INV-013, INV-063 |
| `supabase/functions/_shared/lancar-ssw-baixa.ts`, `_shared/baixa-motorista-*.ts`, `ponte-baixa-entrega/`, `processar-baixas-motorista/`, `migration/2026-10-07_420_baixa_motorista.sql` | INV-013, INV-058, INV-176, INV-177, INV-178, INV-179 |
| `supabase/functions/interpretador-evidencia-foto/index.ts` | INV-001, INV-012 |
| `supabase/functions/executar-sugestao-evidencia/index.ts` | INV-012 |
| `supabase/functions/foto-oc-card/index.ts`, `supabase/functions/r-evidencia/index.ts` | INV-012 (galeria — únicas autorizadas a `obterFotoDaOc`) |
| `supabase/functions/executor/index.ts` | INV-002 (escreve campos preservados pelo helper), INV-008, INV-011, INV-013, INV-034 (`gateOc33Enforce`) |
| `supabase/functions/_shared/verificar-evidencia.ts` | INV-001, INV-011 |
| `supabase/functions/revalidar-evidencia-card/index.ts` | INV-011 |
| `lib/bastao-rules.ts`, `supabase/functions/_shared/bastao-rules.ts` | INV-010, INV-008 |
| `supabase/functions/_shared/regras-auto-acao.ts` | INV-004, INV-008, INV-034 |
| `supabase/functions/_shared/extravio-parcial-dossie.ts` (dossiê + gate, fonte única), `supabase/functions/interpretador-resposta-cliente/index.ts` (popula dossiê), `supabase/functions/_shared/propostas-pos-resposta-cliente.ts` (gate) | INV-034 |
| `supabase/functions/_shared/transicao-aguardando-cliente.ts` | INV-006, INV-008 |
| `supabase/functions/_shared/limite-anexos.ts`, `supabase/functions/upload-anexo-email/index.ts` | INV-015 |
| `supabase/functions/_shared/oc43-regras.ts`, `supabase/functions/agente-oc43-autonomo/index.ts` | INV-061 |
| `supabase/functions/_shared/gmail-reader.ts` (`extrairAnexos`/`selecionarAnexosParaSalvar`), `supabase/functions/gmail-poll-inbox/index.ts`, `supabase/functions/reprocessar-anexos-mensagem/index.ts` | INV-025 |
| `supabase/functions/_shared/propostas-pos-resposta-cliente.ts` (fonte única) | INV-016 |
| `supabase/functions/scan-email-pre-card/index.ts`, `supabase/functions/cron-ia-resposta-pendentes/index.ts`, `supabase/functions/reprocessar-dlq/index.ts` | INV-016 |
| `supabase/functions/vinculador/index.ts` | INV-011, INV-016 |
| `supabase/functions/_shared/extravio-routing.ts`, `supabase/functions/_shared/reconciliar-extravios-bastao.ts`, `supabase/functions/sync-extravios-bastao/index.ts`, `supabase/functions/_shared/bastao-client.ts` | INV-017 |
| `supabase/functions/sync-bastao/index.ts` (Pass A `aguardandoClienteVirouOutraRelacionamento` + sweep `selfHealAguardandoClienteOcRelacionamento`), `supabase/functions/health-check/index.ts` (watchdog `checkAguardandoClienteOcRelacionamento`) | INV-019 |
| `supabase/config.toml` | INV-009 |
| `supabase/functions/sync-roteirizador-ponte/index.ts`, `supabase/functions/_shared/roteirizador-ponte-client.ts`, `_shared/roteirizador-eventos-rotear.ts`, `_shared/sync-roteirizador-ponte-core.ts`, `_shared/compromisso-reentrega-ponte.ts`, `_shared/consultar-rota-roteirizador.ts`, `migration/2026-10-07_417_ponte_roteirizador.sql` | INV-160 |
| `apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (botão ⭐ RECOMENDADA) | INV-041 |
| `apps/cockpit-web/src/components/cards/EditarEmailModal.tsx`, `apps/cockpit-web/src/components/cards/BannerInline54Composer.tsx` (aval skip_evidencia ocs 10/11/35) | INV-041 |
| `apps/cockpit-web/src/main.tsx`, `apps/cockpit-web/src/components/ErrorBoundary.tsx` (airbag) | INV-041 |
| `apps/cockpit-web/index.html` (lang pt-BR + notranslate) | INV-044 |
| `apps/cockpit-web/src/lib/anexos-ssw-elegiveis.ts` (fonte única), `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (2 modais oc=33) | INV-045 |
| `apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts` (rota abrir-input), `supabase/functions/_shared/descricao-ssw.ts` (texto obrigatório 41/56) | INV-046 |
| `apps/cockpit-web/package.json` (gate typecheck no build), `apps/cockpit-web/tsconfig.app.json`, `apps/cockpit-web/src/lib/types.ts` (tipos espelham o banco) | INV-049 |
| `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (DivergenciaMotivoDialog mora no dono do estado divergInfo) | INV-049 |
| `apps/cockpit-web/src/lib/decidir-clique-aprovacao.ts` (rotas modal-oc33-solo/modal-combo-3344), `apps/cockpit-web/src/lib/divergencia.ts` (endosso da sugestão vigente) | INV-050 |
| `apps/cockpit-web/src/pages/Aprendizado.tsx` (confirmação no Rejeitar + trilha de revisadas), `apps/cockpit-web/src/lib/melhorias.ts` (podeReabrir/nasceuDaMinhaResposta), `migration/2026-07-25_312_reabrir_learning_log_e_retroativo.sql` (RPC reabrir) | INV-051 |
| `supabase/functions/_shared/anthropic-client.ts` (retry com teto dobrado + `repararJsonTruncado`), `supabase/functions/_shared/interpretador-degradacao.ts` (breaker + sugestão determinística), `supabase/functions/interpretador-resposta-cliente/index.ts` (maxTokens compatível com o schema) | INV-055 |
| `supabase/functions/_shared/contexto-indenizacao.ts`, `supabase/functions/agente-sugere-ocs-padrao/index.ts` (caso parcial), `supabase/functions/_shared/regras-auto-acao.ts` (par 59 nas regras 49/26/23/43) | INV-047 |
| `supabase/functions/_shared/acionamento-resposta-cliente.ts` (fonte única), `supabase/functions/vinculador/index.ts` (2 caminhos), `supabase/functions/health-check/index.ts` (`checkRespostaClienteEngolida`) | INV-042 |
| `supabase/functions/_shared/gmail-poll-batch.ts` (rodízio: `lastPollAtDoEmbed`/`ordenarPorDefasagem`), `supabase/functions/gmail-poll-inbox/index.ts` (fatia por caixa), `supabase/functions/health-check/index.ts` (`checkCaixaGmailSemPoll`) | INV-043 |
| `supabase/functions/_shared/cce-endereco-trava.ts` (trava, fonte única), `supabase/functions/interpretador-resposta-cliente/index.ts`, `supabase/functions/_shared/propostas-pos-resposta-cliente.ts`, `supabase/functions/agente-sugere-ocs-padrao/index.ts` (as 3 portas; no hook só entram a trava e o `propostas-pos`, e as duas portas grandes ficam com o guard de fiação) | INV-161 |
| `apps/cockpit-web/src/lib/romaneio-modal-oc33.ts` (regra, fonte única), `apps/cockpit-web/src/components/cards/ProposedActions.tsx` (modais `ModalOc33Solo` e `ModalCombo3344`), `supabase/functions/executor/index.ts` (premissa: `processarOc33SoloPortal` materializa e reverte; `processarComboPortal33_44` NÃO materializa) | INV-162 |
| `supabase/functions/_shared/agente-extravio-reavaliacao.ts` (decisão pura: nova tentativa, ciclo novo, reincidência "achou e perdeu" e "já tratado", cada uma com a sua chave), `supabase/functions/agente-extravio-d4/index.ts` (etapas `runReavaliacaoMarcados` e `runReincidenciaImediata`; todo `AgenteExtravioLancou49` grava `data_extravio`) | INV-163 |
| `supabase/functions/_shared/lancar-ssw-portal-operacao.ts` (envelope da Operação, ADR 0041) | INV-013, INV-046, INV-063, INV-181 |
| `supabase/functions/_shared/operacao-lancamentos-worker.ts`, `supabase/functions/processar-lancamentos-operacao/index.ts`, `migration/2026-10-07_430_operacao_fila_e_lancamentos.sql` (RPCs de reserva/confirmação) | INV-159, INV-184, INV-185, INV-186 |
| `supabase/functions/_shared/operacao-materializar.ts`, `supabase/functions/_shared/bastao-operacao-client.ts`, `supabase/functions/materializar-fila-operacao/index.ts` | INV-040, INV-182 |
| `supabase/functions/_shared/operacao-sugestao.ts` (tabela de regras) | INV-183, INV-185 |
| `migration/2026-10-07_431_operacao_separacao_rls.sql`, `docs/OPERACAO-SEPARACAO-RLS.md` | INV-180 |
| `supabase/functions/_shared/operacao-vigia.ts`, `supabase/functions/health-check/index.ts` (`checkOperacaoFila`) | INV-058, INV-186 |
| `supabase/functions/_shared/operacao-comum.ts`, `migration/2026-10-07_432_*.sql`, `migration/2026-10-07_433_*.sql` | INV-187 |
| `supabase/functions/_shared/operacao-sugestao.ts` (camadas 0/1), `supabase/functions/_shared/operacao-agente-sugestao.ts`, `supabase/functions/_shared/operacao-sugerir-ia.ts`, `supabase/functions/sugerir-operacao/index.ts`, `prompts/agente-operacao.md` (+ espelho `_shared/prompts/agente-operacao.ts`), `migration/2026-10-07_434_*.sql`, `migration/2026-10-07_435_*.sql`, `migration/2026-10-07_437_*.sql`, `migration/2026-10-07_439_*.sql`, `migration/2026-10-07_440_*.sql` | INV-167, INV-185, INV-188 |
| `migration/2026-10-07_436_operacao_encaminhar_relacionamento.sql`, `migration/2026-10-07_438_operacao_espelho_relacionamento.sql`, `supabase/functions/_shared/operacao-materializar.ts` (`ctrcsEncaminhamentoPendente`, `espelhoOcPorCtrc`) | INV-040, INV-180, INV-185, INV-189 |

## INV-141 — A inversão "ilegível = parcial" vive SÓ dentro da whitelist (REGRA INVIOLÁVEL)

**Regra (Caio 2026-09-03, ADR 0025):** `analisarExtravio` trata instrução ilegível como **extravio TOTAL** (conservador) e isso vale para **todos os clientes**. A inversão pedida no briefing da oc 55 automática — ausência de sinal de total = parcial — existe **exclusivamente** dentro de `seguir-parcial-auto.ts`, atrás do gate de CNPJ. Inverter o default global mudaria template de e-mail, escolha 54×59 e dossiê de 651 clientes de uma vez.

**Além disso:** "sinal de extravio total" são **duas** condições em OU — (1) a palavra TOTAL/PERDA TOTAL/FALTA TOTAL, **ou** (2) quantidade lida ≥ volumes da NF. Só a (1), como diz o briefing ao pé da letra, classificaria errado 4 de 23 cards de oc 06 medidos (17%): a unidade escreve só o número. Âncora: **NF 29642, instrução `9`, NF de 9 volumes** — extravio total que receberia uma 55 mandando entregar carga inexistente.

**E mais (2026-09-03, achado auditando a 3a cópia do parser):** a leitura da quantidade tem de passar pela limpeza **FORTE** (`removerMarcadoresSswmobile`) antes do parser. O repo tem dois níveis de limpeza e eles **não** são equivalentes: `limparInstrucao` (dentro de `extravio-qtd-volumes`) tira só `(SSWMOBILE)`/`GPS`; `removerMarcadoresSswmobile` chama `sanitizarTextoSsw` (que remove **comentários e tags HTML** — caso de produção NF 1494821, o portal devolve `<!--...--><a href=# onclick=showMapaVeic(...)><u>GPS</u></a>`) e ainda limpa `Protocolo: N`, `SEFAZ-XX` e `cte.fazenda.gov.br`. `agente-sugere-ocs-padrao` já usava a forte; este módulo usava a fraca. Isso é inofensivo em `analisarExtravio` (lá `qtd` nulo vira TOTAL, conservador) e **perigoso aqui**, porque o D3 inverte o default: nulo vira parcial e lança 55. Medido: `9 <!--x--><u>GPS</u>` devolve `null` na fraca e `{qtd:9}` na forte — numa NF de 9 volumes, a fraca lançaria 55 num extravio TOTAL. A limpeza forte **não** rouba os casos legítimos do D3 (`1 V`, `F1 (SSWMOBILE)`, `1 PROVAVELMENTE ERRO...`): esses continuam ilegíveis e seguem parciais. `limparInstrucao` **não** foi alterado — ele serve `analisarExtravio`, que roda para todos os clientes.

**Arquivos:** `_shared/seguir-parcial-auto.ts` (decisão pura + gate), `_shared/extravio-qtd-volumes.ts` (parser extraído, fonte única), `_shared/extravio-enrichment.ts` (default TOTAL preservado + re-export).

**Como verificar:**
```bash
grep -c 'const isTotal = !qtd ||' supabase/functions/_shared/extravio-enrichment.ts   # >= 1 (default global intacto)
grep -c 'cnpj_fora_da_whitelist' supabase/functions/_shared/seguir-parcial-auto.ts    # >= 1 (gate existe)
grep -c 'removerMarcadoresSswmobile' supabase/functions/_shared/seguir-parcial-auto.ts # >= 2 (limpeza FORTE)
grep -cE 'extrairQtdVolumes\(instrucao' supabase/functions/_shared/seguir-parcial-auto.ts # == 0 (nunca a leitura crua)
deno test --no-check --allow-net --allow-env supabase/functions/_shared/seguir-parcial-auto.test.ts
deno test supabase/functions/_shared/extravio-qtd-volumes.test.ts
```

---

## INV-142 — Nada da oc 55 automática nasce LIGADO, e falha nunca abre o portão

**Regra (ADR 0025):** três estados iniciais são obrigatórios e o smoke test das migrations os trava: flag mestra `seguir_parcial_auto_enabled` **OFF** (mig 379), modo sombra `seguir_parcial_auto_sombra` **ON** (mig 380 — sombra ON = decide e registra, **não lança**), e as 4 linhas do seed com `ativo=false`. O loader `seguir-parcial-carregar.ts` **nunca lança**: erro de flag, tabela ausente, RLS ou exceção crua devolvem `CONTEXTO_INERTE`. A sombra é fail-safe ao contrário das demais — ausência ou erro significam sombra **ON**; só sai dela com a linha existindo e `enabled=false` explícito.

**Por quê:** o loader é chamado de dentro de caminhos que rodam pra TODOS os clientes (`agente-sugere-ocs-padrao`, `interpretador-resposta-cliente`). Uma exceção ali derrubaria a análise de cards que não têm nada a ver com o projeto. E ocorrência lançada no SSW não tem desfazer.

**Arquivos:** `migration/2026-09-03_377_*.sql`, `migration/2026-09-03_378_*.sql`, `_shared/seguir-parcial-carregar.ts`, `agente-seguir-parcial-auto/index.ts`.

**Como verificar:**
```bash
grep -c "false, 'Caio (briefing 03/09)'" migration/2026-09-03_379_cliente_config_seguir_parcial_auto.sql  # >= 4
grep -c "porKey.get(FLAG_SEGUIR_PARCIAL_SOMBRA) !== false" supabase/functions/_shared/seguir-parcial-carregar.ts  # >= 1
grep -c "return CONTEXTO_INERTE" supabase/functions/_shared/seguir-parcial-carregar.ts  # >= 3
deno test --no-check --allow-net --allow-env supabase/functions/_shared/seguir-parcial-carregar.test.ts
```

**Como verificar (SQL produção, read-only):**
```sql
-- Nenhum CNPJ ativo sem que alguém tenha ligado de propósito.
SELECT cnpj_pagador, nome_cliente, ativo FROM cliente_config_seguir_parcial_auto ORDER BY 1;
-- Sombra ON enquanto não houver conferência das decisões simuladas.
SELECT key, enabled FROM feature_flags WHERE key LIKE 'seguir_parcial_auto%';
```

---

## INV-143 — A oc 55 conta como "cliente ciente" apenas sob opt-in explícito (ADR 0025 D6)

**Regra:** `OCS_NOTIFICOU_APOS_EXTRAVIO` continua `{20, 49, 54, 59}` para todos os callers. A oc 55 só entra na conta quando o caller passa `clienteAutorizaSeguirParcial: true` — e só passa quando o CNPJ está na whitelist ativa. Espelho: a R3 (`decidirParcialSemAutorizacao`) só se cala com `autorizacaoPermanenteDoCliente: true`.

**Por quê:** depois da 55 automática o cliente ressalva na entrega e volta 19/10/35. O único sinal no histórico é a 55 — sem o opt-in, `recusaOriginadaDeExtravioNaoNotificada` concluiria "não avisamos" e mostraria ao operador o banner **falso** "cliente ainda não notificado do extravio". E sem o espelho da R3, o Cockpit lançaria a 55 de um lado enquanto mandava e-mail perguntando "posso seguir parcial?" do outro — duas vozes contraditórias na mesma NF.

Fecha também uma incoerência **pré-existente**: `extravio-parcial-regra.ts` (`houve55AposExtravio`) já tratava 55-pós-extravio como autorização, enquanto `recusa-por-extravio.ts` a ignorava.

**Arquivos:** `_shared/recusa-por-extravio.ts`, `_shared/extravio-parcial-regra.ts`, `agente-sugere-ocs-padrao/index.ts` (2 call sites), `interpretador-resposta-cliente/index.ts` (1 call site).

**Como verificar:**
```bash
grep -c 'OCS_NOTIFICOU_APOS_EXTRAVIO = new Set<number>(\[20, 54, 59, 49\])' supabase/functions/_shared/recusa-por-extravio.ts  # >= 1
grep -c 'clienteAutorizaSeguirParcial' supabase/functions/agente-sugere-ocs-padrao/index.ts       # >= 2
grep -c 'autorizacaoPermanenteDoCliente' supabase/functions/interpretador-resposta-cliente/index.ts  # >= 1
deno test --no-check --allow-net --allow-env supabase/functions/_shared/recusa-por-extravio.test.ts supabase/functions/_shared/extravio-parcial-regra.test.ts
```


---

## INV-144 — O trilho sobrevive a saída não-ASCII em console cp1252 (Windows)

> Numerado **INV-140 até 03/09/2026**. Renumerado porque a mig 377 do Caio usou o 140 no mesmo dia; o dele ficou com o número original. Nenhum outro arquivo referenciava o 140, então a troca é local ao `/verify-cockpit`.

**Regra (Carlos 2026-09-02, ADR 0019):** `scripts/dbq.py` e `scripts/deploy_pendente.py` têm de imprimir acento e emoji sem estourar em console cp1252. O helper `forcar_saida_utf8()` é obrigatório e tem de ser **chamado**, não só existir.

**Por quê:** no `dbq.py` o print vem **depois** do SQL rodar. Um `UnicodeEncodeError` ali sai com exit 1 **com a migration já aplicada** — o operador lê traceback, conclui "falhou" e reaplica.

**Arquivos:** `scripts/dbq.py`, `scripts/deploy_pendente.py`.

**Como verificar:** o check é de **comportamento** (força cp1252 e imprime fora da tabela), não de texto — grep de nome de função passaria com a função vazia.
```bash
PYTHONIOENCODING=cp1252 python3 -c "import sys; sys.path.insert(0,'scripts')
from dbq import forcar_saida_utf8
forcar_saida_utf8()
print('Devolucao — acao ✅')"
```

**Lacuna conhecida:** `.claude/hooks/cockpit-deploy-gate.py` tem a **mesma** classe de defeito (a mensagem de bloqueio sai com mojibake em cp1252) e **não** está coberto por este invariante. Só cosmético — o exit code está certo — mas é dívida aberta.

---

## INV-147 — Pouca tinta não reprova conversão de PDF; o operador confere a página

**Regra (Carlos 2026-09-08, ADR 0026):** no front, página convertida com pouca tinta **não** pode ser reprovada sozinha. Só há bloqueio duro quando (a) o pdf.js avisou que desistiu de desenhar a imagem (`dependent image isn't ready`), ou (b) a folha está praticamente sem tinta (`< PISO_PAGINA_SEM_TINTA`, 0,5%). Na faixa 0,5%–2% o modal mostra a **prévia** e o operador decide. E **uma** página reprovada nunca derruba o PDF inteiro.

**Por quê:** o piso de 2% tratava "pouca tinta" como "conversão perdida". Medido em 08/09 com PDFium (motor que decodifica JBIG2), nos arquivos reais de produção:

| Arquivo | Página | Tinta | Realidade (inspecionada) |
|---|---|---|---|
| `10803714.pdf` (União Química / Larissa) | 1 | 6,41% | ok |
| `10803714.pdf` | 2 | **1,37%** | **legível** — Documento de Transporte, placa manuscrita SEM-7B68, código de barras |
| `Scanned_from_a_Lexmark….pdf` (AGV / Maria) | 4 | **1,23%** | **legível** — ficha de agendamento, placa e motorista à mão |
| `minuta assinada.pdf` (quebra CALADA no pdf.js: 0,38%) | 1 | 2,53% | ok com decodificador bom |
| `NF 135724.pdf` (âncora da ADR 0014) | 1 | 6,16% | ok |

**Contraprova no motor real do front (pdf.js, 08/09)** — harness replicando o `convertPdfBlobToJpegFiles` (legacy + `wasmUrl` + canvas 2.5 + mesmo predicado): pág. 1 do `10803714` = **6,34%** (passa), pág. 2 = **1,35%** (confirma), Lexmark pág. 4 = **1,22%** (confirma), `minuta assinada` = **2,48%** (passa), `NF 135724` = **6,03%** (passa). Os dois motores concordam dentro de **0,15 pp**, e o resultado reproduz o print da produção (pág. 1 passa, pág. 2 reprova).

O piso de 2% **não** foi mexido; mudou a consequência dele. O corte de 0,5% separa "barrar" de "perguntar pro humano", não de "aceitar calado" — e está calibrado em duas classes MEDIDAS com o pdf.js: **decodificador desligado** (rodando sem o wasm, `Jbig2Error: JBig2 failed to initialize`) dá 0,42% e 0,10%; **conteúdo legítimo** dá 1,22% e 1,35%. O piso fica entre 0,42% e 1,22%.

**Premissa corrigida:** o `minuta assinada.pdf` que a ADR 0014 registrou quebrando *calado* a 0,38% **não reproduz mais** — aquela medição é de 17/07 e o `wasmUrl` entrou em 25/07, depois dela. Não usar o 0,38% como âncora viva. O cenário real que o piso protege hoje é os assets de `public/pdfjs-wasm/` deixarem de ser servidos.

**Assimetria deliberada:** `_shared/pdf-conversao-guard.ts` (servidor) mantém o piso como **bloqueio duro**, porque roda em conversão autônoma do romaneio, sem humano pra olhar a prévia. Mesmo limiar, política diferente, de propósito.

**Arquivos:** `apps/cockpit-web/src/lib/pdfConversaoGuard.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx`, `supabase/functions/_shared/pdf-conversao-guard.ts`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/pdfConversaoGuard.test.ts
deno test --no-check --allow-read supabase/functions/_shared/pdf-conversao-guard.test.ts
```

**Dívida aberta (medida, não resolvida):** o PDFium do `converter-anexo-pdf` renderiza corretamente os arquivos que o pdf.js perde. O fallback certo pro sinal (a) é mandar o arquivo pra ele — hoje impossível pelo front porque a edge é `service role only`. Enquanto isso, o contorno segue sendo print/foto.

---

## INV-148 — Na oc 13, VISIBILIDADE e AUTONOMIA são interruptores separados

**Regra (Carlos 2026-09-08, ADR 0026):** em `cliente_config_oc13`, `ativo` decide se o card **aparece** pro operador (lido pelo `sync-bastao` / `bastao-client`) e `autonomo_ativo` decide se o **agente age** (lido só pelo `agente-oc13-autonomo`, com `!== false`). Um jamais pode ser usado no lugar do outro. Cliente novo nasce visível e **sem** robô (`DEFAULT false`, mig 386).

**Por quê:** era um interruptor só. Incluir um CNPJ pra o card aparecer ligava, no mesmo ato, um agente que lança **oc 21 + cancela reentrega** por `auto_aprovar_e_executar`, sem aprovação por card — e que agenda a ação destacada numa **janela de veto de 60 min** que pode disparar e-mail pro cliente. Medido em 08/09: 962 decisões do agente (669 sugerir 54+e-mail, 141 sugerir 21+cancel, 129 sugerir 56, **23 autônomas**), **1.379** oc 21 lançadas com sucesso, flag `acao_autonoma_veto_enabled` **ligada** e a LARISSA habilitada em `acoes_autonomas_veto_operadores`.

Isso contraria a regra do negócio (Carlos, verbatim 08/09): **"o cliente sempre precisa ser notificado antes e somente com a autorização deles é possível seguir."**

**Caso âncora — NF 1037746 / CTRC PRT562381-2 (PRATI DONADUZZI, Larissa):** oc 13 lançada 28/08 15:36, nunca virou card, descoberta só porque o cliente cobrou. A pendência existia no Bastão com `responsavel_relacionamento=LARISSA`; o pagador `73856593001057` não estava na exceção. A Prati já tivera **14** cards de oc 13, todos terminando em TRANSFERIDO. Fix: entra com `ativo=true, autonomo_ativo=false` (mig 387) — aparece, mas nada age sem o cliente autorizar.

**Contra-regra:** o inverso também é bug. Se o `sync-bastao` passar a filtrar por `autonomo_ativo`, o cliente com robô desligado volta a ficar invisível — o bug original, invertido. O guard testa as duas direções.

**Arquivos:** `migration/2026-09-08_385/386/387_*.sql`, `supabase/functions/agente-oc13-autonomo/index.ts`, `supabase/functions/_shared/bastao-client.ts`, `supabase/functions/sync-bastao/index.ts`.

**Como verificar:**
```bash
deno test --no-check --allow-read supabase/functions/_shared/oc13-visibilidade-vs-autonomia.test.ts
# e no banco, depois das migrations:
python3 scripts/dbq.py -tA -c "select nome_cliente, cnpj_pagador, ativo, autonomo_ativo from cliente_config_oc13 order by 1,2;"
```

**O que NÃO fazer:** pôr a oc 13 como Relacionamento no dicionário. Mediria ~120 cards caindo de uma vez em todas as carteiras (contagem do Bastão em 08/09).

## INV-149 — O 59 sobrevive por PENDÊNCIA DE DOCUMENTO, não por "é extravio total?"

**Regra (Carlos 2026-09-09, ADR 0027):** no menu pós-resposta do trilho tratativa (âncora≠59), um to-do de oc 59 **pendente/aprovado** cujo template é um dos três `..._PEDIR_ROMANEIO` (`TEMPLATES_59_PEDIDO_DOCUMENTO`) NUNCA é cancelado como "obsoleto". O critério é **pendência de documento em aberto** — não a natureza do extravio.

**A ASSIMETRIA É A REGRA, não um detalhe:**

| Caminho | Sinal | Alcance |
|---|---|---|
| **Preservar** 59 pendente (whitelist `ehDaListaNova`) | `temPendenciaDocumento59` — 3 templates, só `pendente`/`aprovado` | largo |
| **Ressuscitar** 59 cancelado (bloco 3b) | `ehExtravioTotalPorTodos59` — só `EXTRAVIO_TOTAL_PEDIR_ROMANEIO` | estreito, inalterado |

**Por que a revivência NÃO foi alargada:** mexeria em **3307 cards abertos** de uma vez, e um 59 revivido pode ser auto-aprovado pela janela de veto — medido em 09/09: **75** to-dos de 59 com `auto_approval_rule = veto_janela:agente-sugere-ocs-padrao:lancar_oc_e_enviar_email:59`. Isso é e-mail ao cliente **sem clique do operador**. Preservar um pendente que o próprio sistema acabou de propor não tem esse risco.

**Caso âncora — NF 75249 / CTRC APO563879-8 (LEONE COMERCIO, Karol):** oc 19 (entrega com falta de volumes = **parcial**). `REGRAS_AUTO_ACAO[19]` propôs `[33, 59, 55, 56]` em 03/09 **22:01:31**; o cliente respondeu e o menu pós-resposta **cancelou o 59 às 22:07:07**, pondo "re-lançar 54" no lugar. Os 59 do card carregam `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` e `EXTRAVIO_PARCIAL_DEVOLVER_PEDIR_ROMANEIO` — **zero** com o template de total, então o portão antigo (`ehExtravioTotalPorTodos59`) era falso.

**Templates DE FORA de propósito** (são notificação, não pedido de documento): `EXTRAVIO_PARCIAL` (456), `RECUSA_TOTAL` (22), `RECUSA_PARCIAL` (13), `TENTATIVAS_ESGOTADAS` (2) e os 7159 sem template (gêmeos sem e-mail). Incluí-los ofereceria 59 em card sem pendência documental.

**Contra-regra:** o inverso também é bug. Se alguém trocar a whitelist de volta pro sinal estreito, o 59 de card parcial volta a ser cancelado — o guard tem um teste de **fonte** que falha nesse caso.

**Arquivos:** `supabase/functions/_shared/propostas-pos-resposta-cliente.ts`.

**Como verificar:**
```bash
deno test --no-check --allow-all supabase/functions/_shared/oc59-extravio-total.test.ts
```

**O que NÃO fazer:** colapsar `todos59Total` e `todos59PedidoDoc` numa variável só. A query traz os três templates; a partição por template é o que mantém a revivência estreita.

---

## INV-150 — A 33 bloqueada DIZ o que falta, e o espelho do dossiê não pode divergir

**Regra (Carlos 2026-09-09, ADR 0027):** quando o dossiê de extravio parcial está incompleto, a linha da oc 33 no card mostra **o que falta** (`falta romaneio de coleta assinado`, `falta descrição dos itens + valor dos itens`). O gate real **não muda** — segue no executor, e segue bloqueando. Isto é rótulo, não portão.

**Por quê:** o relato chegou como "o sistema não sugere a oc 33". A 33 **estava** sugerida — os to-dos existiam em `pendente` e apareciam na tela. O que travava era a execução, e o motivo só aparecia **depois** de abrir o modal: a linha mostrava "LANÇAR →" como se estivesse pronta. Medido nos dois cards do relato:

| NF | romaneio | descrição | valor |
|---|---|---|---|
| 350882 | **false** | true | true |
| 431734 | true | **false** | **false** |

Mesmo portão, peça faltante diferente. E **162 cards abertos de 10 operadores** estavam no mesmo estado (DUILIO 37, FELIPE 34, KAROLINE 17, MARIA 17, VICTOR 16, INGRID 13, JULIA 12, LARISSA 9, ISABELY 6, CAMILA 1) — não era da Karol.

**O bloqueio é DELIBERADO e não se toca** (ADR 0023, incidente NF 158084): sem romaneio o SSW **reverte** a 33 em loop.

**ESPELHO obrigatório:** `apps/cockpit-web/src/lib/dossie33Faltando.ts` espelha `supabase/functions/_shared/extravio-parcial-dossie.ts` (`ROTULO_EVIDENCIA`, `avaliarDossie`, `decidirGateOc33`, `classificarOc33`) — mesma disciplina do `romaneio-cobertura.ts`. O teste do front **lê o fonte do backend** e falha se os rótulos ou as três checagens `presente` mudarem lá sem mudar aqui. Sem isso o espelho vira detector descalibrado e a tela passa a mentir sobre o que falta.

**Fallback conservador:** sem `caso === "2"` comprovado, toda 33 é tratada como **completude** (exige as 3) — igual ao backend. `null` (card sem dossiê) significa "não sei" e a UI **não afirma nada**; nunca vira "está liberado".

**Arquivos:** `apps/cockpit-web/src/lib/dossie33Faltando.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx`, espelhando `supabase/functions/_shared/extravio-parcial-dossie.ts`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/dossie33Faltando.test.ts
```

**O que NÃO fazer:** transformar o rótulo em gate no front (desabilitar o botão). O operador pode ter motivo pra forçar (`extras.forcar_oc33_dossie_incompleto`), e duplicar o portão no front cria dois lugares pra divergir.

---

## INV-151 — O card mostra a ESPERA DO OPERADOR, nunca `last_event_at`

**Regra (Carlos 2026-09-10):** o relógio do rodapé do card de kanban é **há quanto tempo o card espera o operador**, lido de `v_operador_fila_agora` (`na_fila_desde`) — a mesma fonte que a tela de Gestão usa em "Parados há mais de 1 dia útil". `last_event_at` só sobrevive como **fallback** para card fora da view.

**Por quê:** o relato chegou como "delay na leitura da ocorrência 49 — lançada em 28/08, só apareceu em 10/09". A ingestão estava **certa** e foi medida: mediana de **0,95 h** do SSW ao card na oc 49 (73 casos), idêntica às ocs 8/10/11/20/43; 88,4% no mesmo dia; e nenhuma pendência de relacionamento no Bastão com ocorrência anterior a ontem. Os dois casos-âncora entraram no Cockpit em 57 min (NF 350796, oc 19 de `alejo`) e no mesmo dia (NF 2079912, oc 49 lançada **pelo próprio Cockpit** via `ai.salex`).

O que quebrava era a **apresentação**. `KanbanCard` exibia `relativeShort(card.last_event_at ?? card.updated_at)`, e o trigger `project_card_event` reescreve `last_event_at` a cada `card_event`, sem allowlist:

| evento | share dos card_events (30d) | é atividade do operador? |
|---|---|---|
| `HistoricoSswPuxado` | 13,5% (36.715) | não — refresh interno de cache do SSW |
| `BastaoCardAtualizado` | 9,8% (26.536) | não |

Em **27,2%** dos cards de "Aguardando você" o relógio exibido era definido por ruído de sistema. Medido na fila inteira (211 cards): **36 (17%)** mostravam menos da metade da espera real, subestimativa média de 9,1 h e pior caso de **345 h**.

| NF | operador | oc | espera real | horas úteis | UI mostrava |
|---|---|---|---|---|---|
| **350796** | KAROLINE | 19 | **364 h** | 109 | **19 h** |
| 350882 | KAROLINE | 59 | 212 h | 62 | 19 h |
| 922956 | FELIPE | 54 | 195 h | 60 | 24 h |

A NF 350796 era o pior caso do sistema: parada desde 26/08 com 5 to-dos `pendente`, anunciando "há 17h" porque um `HistoricoSswPuxado` de 09/09 20:21 resetou o campo. O operador leu "chegou agora".

**Fail-open obrigatório:** sem linha na view (outras colunas do board, query falhou) o rodapé volta a `last_event_at` e o card renderiza **exatamente** como antes. A prop `espera` do `KanbanCard` é opcional de propósito — `Resolvidos.tsx` não passa e não muda.

**O que NÃO mudou de propósito:** a ordenação. As duas filas do operador já estavam em `OLDEST_FIRST` (por `bastao_data_ultima_ocorrencia`, mais antigo primeiro) — mexer nisso seria risco sem ganho. E **nenhum chip novo**: o card tem teto de 2 sinais (des-poluição, Caio 26/08); o próprio relógio destacado é o aviso de esquecido.

**Arquivos:** `apps/cockpit-web/src/lib/esperaNaFila.ts`, `apps/cockpit-web/src/components/cards/KanbanCard.tsx`, `apps/cockpit-web/src/pages/Inbox.tsx`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/esperaNaFila.test.ts
```
O guard foi **provado contra a master**: `contaminado=1` lá (FAIL), `0` aqui (PASS). O teste usa os números reais da NF 350796 e falha se alguém reintroduzir `last_event_at` no rodapé.

**Fora de escopo, registrado:** o teto de 1.000 cards do Inbox contra **1.927 ativos** — 927 não renderizam na visão "Todos". Não é escolha do front: é o `max_rows` do PostgREST (`supabase/config.toml`). A tela já avisa quando trunca.

---

## INV-152 — A tela nunca oferece oc 33 que a parede vai recusar

**Regra (Carlos 2026-09-11):** quando `proposta_payload.meta.gate_oc33.bloqueada = true`, o botão de lançar a 33 **nasce desabilitado** e a linha **diz o motivo**. A fonte do `disabled` é o **CARIMBO** — o mesmo campo que `aprovar_e_executar` lê —, **nunca** o espelho do dossiê vivo (`dossie33Faltando.ts`). E o modal de anexos só fecha quando a aprovação **passa**.

**Por quê:** o relato chegou como *"a operadora marca os anexos e eles não seguem pro SSW"* (NF 436268, CTRC AMP589740-8, KAROLINE). A hipótese foi **medida e descartada**: não há defeito no caminho dos anexos — 404 lançamentos de oc 33 **com imagem** em 60 dias, o último no próprio dia da investigação, até 15 anexos num só. O que acontece é que **a aprovação inteira é recusada antes**: a parede da mig 365 (reescrita até a 378) dispara `OC33_DOSSIE_INCOMPLETO` **antes** da linha que grava `args.extras`, e como é `RAISE EXCEPTION` a transação volta atrás inteira. Confirmado no banco: o todo `5d3432d0` da NF 436268 tem `extras` **sem `anexos_ids`**, só com o texto que o agente sugeriu.

O bloqueio é **deliberado e não se toca** (ADR 0023; NF 660746: 33 incompleta abriu indenização e voltou 20 dias depois cobrando 46→49 "DESCRIÇÃO E VALOR"). O defeito era a tela **oferecer o caminho**: botão aceso, modal abrindo, PDF sendo convertido e subido — pra só então recusar e descartar tudo.

**Não era da Karol** (medição de 11/09, todos `pendente` com carimbo bloqueante):

| operadora | cards | operadora | cards |
|---|---|---|---|
| DUILIO | 34 | INGRID | 15 |
| FELIPE | 31 | LARISSA | 10 |
| **KAROLINE** | **20** | ISABELY | 8 |
| VICTOR | 18 | JULIA | 5 |
| MARIA | 15 | | |

**Por que o CARIMBO e não o dossiê vivo:** os dois **divergem**. Medido em 11/09 nos todos pendentes de oc 33 com dossiê incompleto: 301 com `bloqueada=true`, mas **26 sem carimbo nenhum** e **3 com `bloqueada=false`**. Nesses 29 a parede **deixa passar** (e `extravio_parcial_gate_enforce` está OFF desde 02/07, então o executor também não barra). Desabilitar pelo espelho apagaria botão que o banco aceita — a tela inventando política que o backend não tem. Aqui a tela só **promete o que o banco cumpre**. (Os 29 são um buraco **separado e ainda aberto**, fora do escopo por decisão do Carlos em 11/09.)

**Botão apagado TEM que ter motivo escrito.** O ramo ★ Recomendada era o único dos 6 sem o `AvisoDossie33Banner` — apagá-lo sem o aviso deixaria a ação cinza e **muda**, pior que o bug original, porque a operadora perderia até o erro que tinha pra ler.

**O que NÃO mudou de propósito:** nenhum caminho de "forçar lançamento" foi criado. A saída continua sendo **COMPLETAR** o dossiê (decisão de 04/09), nunca **FORÇAR**. E o combo 44+59 não é oc 33: fica fora da regra, com paridade explícita ao `faltaDossie33`.

**Arquivos:** `apps/cockpit-web/src/lib/gateOc33Carimbo.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/gateOc33Carimbo.test.ts
```
Guard **provado contra a master**: lá `botoes=0`, `aviso=5`, `fecha_no_sucesso=0` (FAIL); aqui `8`, `6`, `3` (PASS).

## INV-153 — Aprovação recusada pela parede deixa rastro (e passa na RLS)

**Regra (Carlos 2026-09-11):** toda aprovação recusada por `aprovar_e_executar` grava um `card_event` **`AprovacaoRecusadaNaParede`**, com `actor_type='operator'` e **`actor_id` = id do operador**, fora da transação que morreu. O payload registra o código da recusa, o carimbo e **quantos anexos estavam marcados**.

**Por quê:** `RAISE EXCEPTION` desfaz a transação inteira — nem o `AprovacaoOperador` sobrevive — e o front só mostrava `toast.error("Erro ao aprovar")` e esquecia. Medição de 11/09: **903** eventos `Oc33BloqueadaDossieIncompleto` no banco, **todos** de `regras_auto_acao` montando proposta, **zero** de operadora clicando. A pergunta "quantas vezes a Karol bateu nessa parede?" **não tinha resposta** — e por isso 156 cards de 9 operadoras ficaram presos por meses sem ninguém medir. O relato chegou por reclamação, não por métrica, exatamente como no INV-147.

**A armadilha da RLS, pela segunda vez:** `card_events_insert_operator` exige `actor_id = current_operador_id()::text` **e** o card ser do operador. Foi aqui que a telemetria do conversor de PDF ficou **cega** em 08/09 (mandava a string fixa `"front-conversao-pdf"`; todo insert era recusado e engolido pelo `catch`). Por isso `montarEventoAprovacaoRecusada` devolve **`null` sem `operadorId`** em vez de montar um evento que o banco vai rejeitar em silêncio.

**O que NÃO se registra:** desistência da própria operadora (cancelou o popup de divergência) — não houve parede. A constante que marca isso tem **fonte única** no lib; era um `const` solto dentro do componente, e duas verdades divergindo fariam o lado errado gravar "desisti" como se fosse recusa do banco.

**Best-effort inviolável:** falhar a gravação **nunca** pode atrapalhar a operadora — ela já levou o erro real na tela.

**Arquivos:** `apps/cockpit-web/src/lib/aprovacaoRecusadaEvento.ts`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx`.

**Como verificar:**
```bash
cd apps/cockpit-web && npx vitest run src/lib/aprovacaoRecusadaEvento.test.ts
```
Guard **provado contra a master**: lá `wired=0` e `operador=0` (FAIL); aqui `1` e `1` (PASS).

## INV-158 — Segregar CTRC só sai com as QUATRO condições; o Cockpit não desfaz

**Regra (Caio 2026-09-21, pedido da PRATI · ADR 0033):** o campo **`f8` = "Segregar CTRC"** da tela 101 do SSW só vai como `"S"` quando **as quatro** condições valem **ao mesmo tempo**, avaliadas por `segregacaoPermitida()` em `supabase/functions/_shared/segregacao-ctrc.ts`:

| # | Condição | Fonte |
|---|---|---|
| 1 | CNPJ pagador **ativo** na whitelist, com a flag mestra ON | `cliente_config_segregacao_ctrc` + `segregacao_ctrc_enabled` (mig 407) |
| 2 | Ocorrência lançada ∈ **{54, 59}** | `OCS_COM_SEGREGACAO` |
| 3 | Card é de **extravio** — oc ∈ **{6, 9, 16}**, ou **49 lançada pelo robô do extravio** (`agente_extravio_status='lancou'`). Até 06/10 era {6, 9, 16, 49} — ver INV-169 | `OCS_CARD_EXTRAVIO` + `ehCardDeExtravioComprovado` |
| 4 | **Aprovação humana comprovada** | `origemHumanaComprovada({leuTodo, regraAuto})` |

Qualquer falha — CNPJ inválido, oc fora do par, card que não é de extravio, whitelist vazia, tabela ausente, erro de permissão, exceção no loader — devolve `false` e o portal recebe o default `"N"`. **Fail-closed nas quatro pontas.**

**Por quê:** segregar bloqueia o CT-e para transferência, movimentação e entrega — a carga **para fisicamente**. E a retirada é **manual, na opção 091 do SSW**: **o Cockpit não desfaz**. É a única ação do fluxo sem volta pelo sistema. Daí a condição (4): **robô nunca segrega**, porque não há como cancelar o que ele fizer errado. Regra geral derivada no ADR 0033: *ação que o sistema não sabe desfazer não entra em autonomia*.

**As duas condições que a auditoria pré-merge do próprio 21/09 acrescentou** (e que são o conteúdo real deste INV):

- **(3) não existia no código.** A frase "somente nos cards de extravio" estava no pedido, no cabeçalho da migration e no texto da tela — e **não** na função. Um card da PRATI em RECUSA (oc 10/11/35) com proposta de 54 passava pela cerca e barrava a carga de uma recusa. A leitura usa **as duas fontes** (`agent_state.cod_ultima_ocorrencia` **e** `cards.cod_ultima_ocorrencia`) e basta uma bater: o executor **sobrescreve** o campo do card a cada lançamento, então olhar só ele bloquearia o fluxo real de extravio em silêncio — o modo de falha oposto e igualmente ruim. O 49 ("PRAZO DE PERDAS EXPIRADO") está no conjunto porque é a última ocorrência do card exatamente quando a operadora recebe a sugestão de 54/59.
- **(4) era fail-OPEN.** O executor lia `todos.auto_approval_rule` ignorando o `error` do SELECT e colapsava três estados em "regra nula" = "foi humano": (a) todo humano, (b) erro de query/RLS/timeout, (c) todo inexistente. Em (b) e (c) não dá para **afirmar** que alguém olhou. **Ausência de prova não é prova de ausência de robô.**

**Flag de CONTROLE, nunca texto:** `segregar_ctrc` fica **fora** de `EXTRAS_PRA_DESCRICAO_SSW` — se entrasse, vazaria pra Instrução do SSW como `segregar_ctrc: true`, igual ao vazamento de `validar_evidencia: false` de 10/06.

**Kill-switch:** `segregacao_ctrc_enabled` desliga tudo **sem deploy** e é avaliada **antes** da whitelist no `carregarCnpjsSegregacao`. Tudo nasce OFF: flag `enabled=false` e os 2 CNPJs da PRATI com `ativo=false`. Aplicar a mig 407 não liga nada.

**Não confundir `f8` com `f11`:** o outro campo S/N da mesma tela é "Resposta a um Fale Conosco". Trocar os dois responde um Fale Conosco indevido e **não** segrega — falha silenciosa com cara de sucesso.

**Recusa é auditável:** a cerca que barra grava `card_event` `SegregacaoCtrcRecusadaPelaCerca` com o motivo discriminado. Sem isso vira "não segregou e ninguém sabe por quê".

**Trava cruzada permanente:** um CNPJ **não pode** estar ativo ao mesmo tempo em `cliente_config_segregacao_ctrc` e em `cliente_config_seguir_parcial_auto` — são ordens contraditórias (barrar a carga × deixar a carga seguir). E CNPJ ativo sem `autorizado_por` é ordem de barrar carga sem dono. Os dois casos são checados no banco pelo bloco da Fase 8.

**Arquivos:** `supabase/functions/_shared/segregacao-ctrc.ts`, `supabase/functions/executor/index.ts` (gate), `supabase/functions/_shared/lancar-ssw-portal.ts`, `supabase/functions/_shared/ssw-internal-client.ts` (`f8`), `migration/2026-09-21_407_cliente_config_segregacao_ctrc.sql`, `apps/cockpit-web/src/components/cards/ProposedActions.tsx` + `EditarEmailModal.tsx`.

**Como verificar:**
```bash
deno test --allow-all --no-check supabase/functions/_shared/segregacao-ctrc*.test.ts
cd apps/cockpit-web && npx vitest run src/components/cards/EditarEmailModal.segregacao.test.tsx \n  src/components/cards/ProposedActions.segregacao.test.ts
```
Mais o bloco **INV-158** da Fase 8 do `/verify-cockpit`, que cobra os dois conjuntos, o import da cerca pelo executor (não reimplementar) e os dois checks de banco.

**ADR:** [docs/decisions/0033-segregacao-ctrc-acao-irreversivel-so-humana.md](decisions/0033-segregacao-ctrc-acao-irreversivel-so-humana.md)


## Histórico

- 2026-05-14 — versão inicial com 10 INVs, motivada pelo bug NF 1075381.
- 2026-05-14 (tarde) — INV-011 adicionado pós-bug NF 20761 (evidência ausente falso por múltiplos CTRCs sem ctrcEsperado).
- 2026-06-18 — INV-012 adicionado pós-bug NF 355283 oc=49 (IA + anexo de email puxavam só a 1ª foto; raiz: `obterTodasFotosDaOc` + whitelist de `obterFotoDaOc` só pra galeria).
- 2026-06-22 — INV-013 adicionado pós-bug NF 651244 (Duilio aprovou oc=33, SSW registrou Larissa). Lançamento unificado na conta de serviço `ai.salex` via `readSswLancamentoEnv`.
- 2026-06-23 — INV-014 adicionado pós-bug NF 376924 + 53948 (oc=33 reversão lançada pelo Cockpit virou CONFLITOS). Guard `flagConflitoOcSemMover` ganhou 2º sinal (`AcaoExecutadaConfirmadaPeloSsw`, path-independent) + os 5 callers de oc=33/44 do executor migrados pro envelope `lancarSswPortal` + guard pós-lançamento no `forcaAguardandoClienteOc54`. REGRA INVIOLÁVEL: oc lançada pelo Cockpit nunca é conflito.
- 2026-06-23 — INV-015 adicionado pós-bug NF 719250 (Duilio não convertia PDF→JPEG no modal oc=33). O limite de anexos por card contava `origem='inbound'` (assinaturas/logos inline auto-capturados); card com 29 inbound bloqueava todo upload. Limite passou a contar só uploads do operador (outbound), centralizado em `_shared/limite-anexos.ts`. 18 cards destravados.
- 2026-06-23 — INV-016 adicionado pós-bug NF 761583 (Anthropic 529 derrubou o triador → 13 respostas de clientes no `dead_letter` → cards em CLIENTE RESPONDEU sem botões / nem apareciam). Criação de propostas extraída pra `_shared/propostas-pos-resposta-cliente.ts` (fonte única, determinística); scan-email-pre-card cria direto; novo `reprocessar-dlq` (cron 2min) auto-cura mensagens presas; `cron-ia-resposta-pendentes` ganhou rede de segurança de propostas; health-check alerta o Caio. REGRA INVIOLÁVEL: cliente respondeu → SEMPRE visível no Cockpit com as ações.
- 2026-06-23 (noite) — INV-014 corrigido na RAIZ: o gate de ciclo (`emCicloAtivoDoLancamento` = `acao_executada_em != null`), adicionado mais cedo no mesmo dia, desligava os 2 sinais assim que o Bastão confirmava o lançamento → re-flag em massa de cards já confirmados (NF 359849/44, 1017149/21, 3057294/56, 377696/21). Gate removido (2 sinais rodam SEMPRE); 4 falso-positivos limpos retroativo; test antigo "CASO 2 → FLAGGED" (que codificava o bug) invertido pro guard de regressão. Tradeoff: caso raro de relançamento-por-fora-em-ciclo-novo não é mais pego (decisão do Caio: zero falso-positivo).
- 2026-06-24 — INV-019 adicionado pós-bug NF 175621 (COMPROMISSO, oc=49 presa 5 dias em AGUARDANDO_CLIENTE; 52 cards no total). Raiz: o Pass E (dono da transição relacionamento→AGUARDANDO VOCÊ) foi desligado em 2026-06-22 e o ramo ficou órfão — enforcement acoplado a UM código sumiu em silêncio. Custo: 39 NFs oc=49 sem tratativa (operador não via, agentes não rodavam). Fix em 3 camadas que tornam o desligamento silencioso impossível: (1) Pass A move na hora (`aguardandoClienteVirouOutraRelacionamento`); (2) sweep auto-cura sempre-ligado e desacoplado dentro do sync-bastao (`selfHealAguardandoClienteOcRelacionamento`); (3) watchdog em PROCESSO SEPARADO no health-check (`checkAguardandoClienteOcRelacionamento`, e-mail pro Caio se algum card violar >15min). + probe de código no /verify-cockpit (falha se qualquer camada for removida) + hook de arquivo crítico exige aprovação do Caio. REGRA INVIOLÁVEL: oc de relacionamento ≠54 NUNCA fica preso em AGUARDANDO_CLIENTE.
- 2026-06-25 — INV-025 adicionado pós-bug NF 1486931 (CAMILA). A assinatura da cliente (`image001.jpg`, 138KB, image/jpeg) foi capturada como "o anexo da cliente": passou allowlist de MIME + limite de 10MB (a premissa do fix de 2026-05-29 de que logo de assinatura é "165-4KB típico" não vale — banners de assinatura passam fácil dos 100KB). Raiz: `extrairAnexos` capturava todo part com `attachmentId`+`filename` sem distinguir imagem embutida no corpo de anexo real. Fix: `extrairAnexos` agora classifica `inlineNoCorpo` (lê `Content-Disposition: inline` + `Content-ID` referenciado via `cid:` no HTML) e `selecionarAnexosParaSalvar` (fonte única, usada por `gmail-poll-inbox` E `reprocessar-anexos-mensagem`) ignora os inline **só quando coexiste um anexo real** — espelha o "N anexos" do próprio Gmail. Sem anexo real (foto colada no corpo, NF 647384) a imagem inline continua sendo salva → não regride. Bônus: dedup intra-card por `filename+size` (a mesma NF-e PDF veio 3× de mensagens da thread que a citavam). Guard: `_shared/gmail-anexos-classificacao.test.ts` (7 testes). REGRA INVIOLÁVEL: imagem de assinatura/logo embutida no corpo nunca é salva como anexo do cliente quando há anexo real.
- 2026-06-24 — INV-017 adicionado pós-bug de cards travados na aba EXTRAVIOS (NF 43973 oc 20→1 congelada 121h, 277008/21519 entregues, 650967 oc 33). A decisão de SAIR da aba estava delegada ao pull FILTRADO do Bastão; quando a NF mudava pra fora do filtro ela sumia do pull e não havia reconciliador (runPassB exclui EXTRAVIO_MONITORADO; cron dedicado aposentado na mig 219). Fix: `decidirDestinoExtravio` (fonte única via `stateFinalAposBastao`) + reconciliação pela verdade do **Bastão consultado POR NF** (`reconciliar-extravios-bastao.ts` + `fetchPendenciasByNfs`) sob **gate de frescor** (`fetchBastaoMaxUpdatedAt`) — provado que o Bastão retém a NF com a oc nova e só some ao finalizar (1/30/32 → RESOLVIDO). `sync-extravios-bastao` reescrito pra reconcile-only + cron 10min (mig 255, sem pull → sem dup). SSW só no conflito/agente. (1ª versão usou reconciliador SSW por órfão/staleness — substituída por Bastão-por-NF, mais barata e sem estampida de SSW.) REGRA INVIOLÁVEL: trocou a oc, o card some da aba.
- 2026-07-22 — INV-041 adicionado pós-bugs NF 556392 (FELIPE, tela branca ao aprovar) + NF 51712 (ISABELY, oc=11 sem aval de evidência). Raiz comum: botão ⭐ RECOMENDADA aprovava DIRETO com extras=null, pulando a janela de edição inteira (template, destinatários, aval skip_evidencia das ocs 10/11/35 → executor bloqueava sem saída). Fix: `decidirCliqueAprovacao` (função pura + 5 testes) roteia e-mail→modal / combo→modal-4459 / resto→direto; aval espelhado no `BannerInline54Composer`; `ErrorBoundary` global + `[cockpit-crash]` no console/localStorage (tela branca vira tela de erro com stack — gatilho residual será capturado na próxima ocorrência). De carona: rótulos "oc=54" hardcoded dos 3 ramos caso_oc49 e do composer agora espelham a oc destacada real (54/59). REGRA INVIOLÁVEL: ação com e-mail nunca aprova às cegas.
- 2026-07-23 — INV-042 adicionado pós-bug NF 73220 (LARISSA/LEONE — romaneio respondido MUDO 7 dias). Duas causas independentes provadas: (1) confirmador pré-59 (regressão de deploy 13-21/07, já corrigida) mandou card com oc 59 recém-lançada pra TRANSFERIDO (`state_novo` no evento); (2) buraco de design: resposta de cliente em card terminal era engolida — thread path ignorava, ramo de reabertura por NF suspenso em 12/05, e o fallback "sync reabre" morre no guard de identidade ADR 0011 quando a última oc é nossa (83 supressões em 7 dias). Fix: fonte única `decidirAcionamentoPorRespostaCliente` + reabertura nos 2 caminhos do vinculador + evento `CardReabertoPorRespostaCliente` + watchdog `checkRespostaClienteEngolida` + retroativo em `audits/`. REGRA INVIOLÁVEL: resposta real de cliente nunca é muda — card terminal reabre.
- 2026-07-23 (tarde) — INV-042 REFINADO pelo Caio no mesmo dia (premissa final): reabrir terminal ressuscitava tratativa TRATADA — regra vira (1) card ATIVO se move sempre; (2) terminal anexa sem mover, roteando pra card ativo da NF quando existir (lookup por NF também prefere ativo); (3) card novo entra na premissa 1. Retroativo re-escopado na mesma tarde: 232 reaberturas de terminais REVERTIDAS cirurgicamente (evento `RetroativoRevertidoPorEscopo` por card), 5 mantidas (origem AGUARDANDO_CLIENTE, incl. a 73220 → proposta oc 33). Lições permanentes: detecção por EVENTO (nunca por carimbo — executor zera), dedupe por NF antes de reabrir (uniq_cards_nf_active), 1 mensagem = 1 decisão.
- 2026-07-24 — INV-049 adicionado pós-incidente `divergInfo` (TODOS os operadores travados na abertura de card). Raiz dupla: (1) commit `a37100f` (F4 popup de divergência, 23/07) renderizou `DivergenciaMotivoDialog` dentro de `ValidacaoHumanaList` com estado que vive no `ProposedActions` → `ReferenceError` em toda renderização; (2) ZERO typecheck no caminho até produção — `tsc --noEmit` sem `-p` checa nada (tsconfig raiz solution-style `files:[]`, todos os "tsc OK" históricos eram vácuos) e `vite build` não checa tipos. Fix: dialog movido pro dono do estado + gate `typecheck` no script build (Vercel falha o deploy em erro de tipo — falha segura) + 3 tipos mentirosos do `types.ts` corrigidos contra o banco (CardState sem EXTRAVIO_MONITORADO/212 cards, caso_oc49 sem relancamento_indenizacao e recusa_parcial_precede_extravio, proposta_destacada sem 59). Saldo positivo: airbag do INV-041 transformou tela branca em stack legível — diagnóstico em minutos. REGRA INVIOLÁVEL: nada chega ao build de produção sem typecheck real.
- 2026-07-24 (tarde) — INV-050 adicionado pós-bugs NF 158084 (DUILIO) + NF 1094294 (LARISSA), primeira manhã real de 3 estreias (popup F4 funcional + piloto ligado 23/07 20:33 + rota abrir-input). Três causas independentes provadas: (a) `decidirCliqueAprovacao` sem rota pra oc33-solo/combo-33+44 → ⭐ aprovou às cegas com `anexos_ids=[]` e o executor reverteu (fail-closed segurou — nada errado no SSW); (b) ramo ⭐ com early-return incondicional → rota `abrir-input` setava `expandidoId` que ninguém renderizava (clique morto na 56 recomendada — era a contraprova pendente da NF 62566, que chegou e REPROVOU); (c) `detectarDivergencia` sem arbitragem de recência → popup falso contra banner velho (23 popups/22 cards, motivo do próprio operador: "Sugeriu 33 eu aprovei lançar 33 e apareceu o pop up - errado"). Fix: rotas+handlers novos, ⭐ cai no render normal quando input expandido, divergência só sem endosso de NENHUMA camada viva. REGRA INVIOLÁVEL: aprovar a ⭐ que a UI mostra nunca abre popup nem aprova às cegas. Expurgo (ordem do Caio, mesmo dia): 3 `divergencia_motivos` deletados pelo critério mecânico do detector novo (nunca por texto); 22 mantidos como aprendizado legítimo. O expurgo expôs o gap `meta.origem='vinculador_pos_resposta_cliente'` com interp nulo (2 dos 3 falso-positivos) → regra de endosso por origem adicionada + contra-caso do gêmeo sem-email do menu preservado como divergência real.
- 2026-07-25 — INV-051 adicionado pós-incidente da fila de melhorias F6 (24/07): a Isadora rejeitou SEM QUERER a proposta "Melhorar o leitor de respostas do cliente" (regra do comprovante legível, NFs 893551/1828915) 21s depois de responder a pergunta — e não conseguiu corrigir. Raiz (3 fragilidades somadas): (a) card rotulado "aguardando SUA aprovação" mostrado ao próprio autor da resposta segundos depois de responder; (b) Aprovar/Rejeitar 1-clique, adjacentes, sem confirmação; (c) sem undo em NENHUMA camada — a fila só mostra `status='aberto'` (o card some no clique) e `revisar_learning_log` (mig 197) só permite aberto→final. Consequência: as revisões da Isadora ficaram invisíveis pro Caio, que só viu as 2 propostas "Alinhar o TIME" restantes. Fix: Rejeitar em 2 passos + rótulo neutro + aviso anti-eco quando a proposta nasceu da resposta do gestor logado + trilha "propostas já revisadas" (quem decidiu o quê, quando) com botão Reabrir via RPC `reabrir_learning_log` (mig 312, gestor-only, restrita a `ajuste_sugerido` aprovado/rejeitado — terminais aplicado/revertido intocáveis) + retroativo reabrindo o ajuste 1683efd9. REGRA INVIOLÁVEL: decisão humana na fila F6 é sempre confirmada, visível e reversível.
- 2026-09-03 (tarde) — **INV-141 reforçado + INV-140 do Carlos renumerado para INV-144.** Ao auditar a TERCEIRA cópia do parser (a dívida registrada de manhã) para decidir se dava pra consolidar, descobriu-se que ela **não** é equivalente: `agente-sugere-ocs-padrao` limpa com `removerMarcadoresSswmobile` (que remove comentários/tags HTML via `sanitizarTextoSsw`, mais `Protocolo:`/`SEFAZ`), enquanto `seguir-parcial-auto` usava só o `limparInstrucao` fraco. Medido: `9 <!--x--><u>GPS</u>` → fraco devolve `null`, forte devolve `{qtd:9}`. Numa NF de 9 volumes o fraco lançaria 55 num extravio TOTAL — exatamente o modo de falha que o D2 existe pra impedir. A fraqueza é inofensiva em `analisarExtravio` (nulo→TOTAL, conservador) e perigosa aqui porque o D3 inverte o default. Fix: `lerQtdDaInstrucao()` aplica a limpeza forte **só dentro do módulo** — `limparInstrucao` NÃO foi tocado, porque serve `analisarExtravio` de todos os 651 clientes. Consolidar as três cópias segue **descartado**: trocar o forte pelo fraco (ou vice-versa) em `agente-sugere-ocs-padrao` mudaria classificação para todos. Também adicionados guards de deploy (`.claude/deploy-guards.json`) para os 3 arquivos da 55 automática, que não tinham nenhum.
- 2026-09-03 — INV-141/142/143 adicionados junto com o ADR 0025 (oc 55 automática pra clientes com autorização permanente de seguir parcial: 4 CNPJs, 1 do DUILIO e 3 do FELIPE). NÃO nasceram de bug em produção — nasceram de uma medição feita ANTES de codar. A regra do briefing ("se a mensagem não disser 'extravio total', é parcial") foi confrontada com 180 dias de instruções reais desses clientes e classificaria errado 4 de 23 cards de oc 06 (17%): a unidade escreve SÓ O NÚMERO de volumes faltantes, sem a palavra TOTAL, e quando esse número é igual ao total de volumes da NF o extravio é total. Âncora NF 29642 (instrução `9`, NF de 9 volumes) receberia uma 55 mandando a operação entregar carga que não existe mais. Daí o INV-141 (a inversão vive só dentro da whitelist; sinal de total = palavra OU qtd>=volumes). A investigação achou de quebra: (a) `OCS_NOTIFICOU_APOS_EXTRAVIO` sem a 55, que faria o card de volta (19/10/35) exibir banner falso "cliente não notificado" — INV-143, que fecha uma divergência pré-existente com `houve55AposExtravio`; (b) `extravio-enrichment` arrastando `bastao-rules`, que faz query em TOP-LEVEL AWAIT, impedindo teste puro — parser extraído pra `extravio-qtd-volumes.ts` (que desde o ADR 0012 nunca tivera teste, apesar de decidir total×parcial); (c) uma TERCEIRA cópia do mesmo parser em `agente-sugere-ocs-padrao` (dívida registrada). INV-142 trava o estado inicial: flag OFF, sombra ON, seed inativo, loader fail-closed — porque ocorrência no SSW não tem desfazer. REGRA INVIOLÁVEL: extravio total nunca vira 55, e cliente fora da whitelist nunca muda de comportamento.
- 2026-07-26 — INV-055 adicionado pós-incidente de custo (domingo sem operação: $39,34 vs $8/dia, 4x). Causa raiz ÚNICA em cadeia, provada no `anthropic_usage_log` + `card_events`: `maxTokens: 700` no interpretador era MENOR que a resposta legítima do próprio schema (3 `trecho_verbatim` de evidência + motivo + motivo_combo) → 289 respostas bateram exatamente em 700 = cortadas no meio → JSON inválido → `completeJson` repetia com o MESMO teto (retry condenado, cortava igual) → 268 `InterpretadorRespostaClienteFalhou` (0 em todos os dias anteriores) → o card não recebia `ia_sugestao_oc_resposta` → `cron-ia-resposta-pendentes` seleciona exatamente "respondeu mas sem sugestão" e o devolvia a cada 5 min, sem limite de tentativas → 899 chamadas Anthropic sobre 11 mensagens (82 por mensagem; NF 164346 sozinha: 326 chamadas, 137 falhas, das 07:03 às 17:11). Amplificador: a onda 3 de 25/07 passou o `scan-email-pre-card` a drenar a fila em loop de 45s (backlog de 94k), realimentando as mesmas mensagens. Fix em 4 camadas: (1) teto 1800 + limites de tamanho explícitos no prompt; (2) retry que DOBRA o teto quando `stop_reason=max_tokens` (remove a causa em vez de repeti-la); (3) `repararJsonTruncado` salva o maior prefixo válido — os campos de decisão vêm primeiro no schema — entrando com confiança ≤0,5 e pendência visível; (4) breaker `MAX_FALHAS_LLM` por (card, mensagem): esgotado, aplica sugestão DETERMINÍSTICA conservadora (mantém 54/59 do trilho, zero ação automática em SSW) pela MESMA estrutura do fluxo normal, então o card segue com banner, propostas e to-dos, marcado `leitura_degradada`. REGRA INVIOLÁVEL: card com resposta de cliente nunca fica sem interpretação e sem ações — e falha de leitura nunca vira loop infinito de custo. Regra do Caio (verbatim): "Não podemos deixar o card sem interpretar, sem ações, e sem nada. (…) Não adianta só jogar para o operador fazer."
- 2026-09-08 — **INV-147 e INV-148 adicionados junto com o ADR 0026** (correção 08.09, dois bugs da operadora LARISSA). Nenhum dos dois foi diagnosticado por leitura de código: os dois foram MEDIDOS. (a) O bloqueio do PDF no 33+44 não era falha de conversão — renderizei as páginas com PDFium e OLHEI: as páginas reprovadas a 1,37% e 1,23% estavam legíveis (documento de transporte com placa manuscrita; ficha de agendamento). O piso de 2% de tinta estava reprovando conversão boa, e uma página reprovada derrubava o PDF inteiro — a página 1, a 6,41%, ia pro lixo junto. De quebra descobriu-se que a telemetria `ConversaoPdfBloqueadaGuard` do front NUNCA gravou: o `actor_id` era a string `"front-conversao-pdf"` e a RLS `card_events_insert_operator` exige `actor_id = current_operador_id()`, então todo insert era recusado e engolido pelo `catch`. Os 2 únicos eventos do banco vinham do servidor. A ADR 0014 mandava contar bloqueios por 2–4 semanas pra decidir o conversor server-side, e o contador estava cego desde o começo — por isso o bug chegou por reclamação de operadora, não por métrica. (b) A NF 1037746 não entrou nas pendências porque a oc 13 está fora do escopo e o pagador não estava na exceção: o sistema seguiu a regra, a regra é que estava errada pro cliente. Ao preparar o fix apareceu a armadilha que virou o INV-148: a tabela da exceção era um interruptor só pra "aparecer" e pra "robô agir", então corrigir a visibilidade ligaria um agente que lança oc 21 e cancela reentrega sem autorização do cliente — o oposto da regra do negócio. REGRA INVIOLÁVEL: sinal fraco de qualidade (pouca tinta) pede olho humano, nunca reprova sozinho; e visibilidade nunca liga autonomia.
- 2026-09-09 — **INV-149 e INV-150 adicionados junto com o ADR 0027** (correção 09.09, dois casos da operadora KAROL). A hipótese do relato — "a existência de uma 33 anterior bloqueou a nova sugestão" — foi MEDIDA e **descartada**: a dedup usa `STATUS_ATIVOS = {pendente, aprovado}` e nunca consulta o histórico do SSW; `executando`/`cancelado` não ocupam o código (liberado de propósito desde a NF 2148226); o índice único de to-dos cobre só pendente/aprovado; e a idempotência do SSW é `(card_id, codigo_oc, ctrc, **todo_id**)`, então to-do novo não bate nela. Mais: **a 33 estava sendo sugerida nos dois cards** — aparece nas telas do relato e o banco confirma (350882 com 2 to-dos de 33 `pendente` desde 19/08; 431734 com 9 `pendente` desde 03/09). Eram dois bugs de causas independentes, e nenhuma era a do relato. (a) O 59 da NF 75249 nasceu correto pela regra da oc 19 e foi **cancelado 6 minutos depois** pelo menu pós-resposta, porque o portão só perdoava extravio TOTAL — num card parcial (template `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`) o sinal era falso e o 59 virava "obsoleto". (b) A 33 aparecia mas o executor a barrava por dossiê incompleto, com o motivo escondido atrás do modal. Erro de medição corrigido no caminho, que vale registrar: a primeira sonda buscou o template em `args.template_email` e devolveu 0 pra tudo — o campo real é `args.template_id`, o mesmo que o código consulta; o "0" era artefato da sonda, não evidência. REGRA INVIOLÁVEL: ocorrência que existe por pendência de documento sobrevive enquanto a pendência existir; e ação bloqueada sempre diz por quê na própria linha, sem obrigar o operador a abrir o modal pra descobrir.
- 2026-09-10 — **INV-151 adicionado.** O relato chegou como "delay na leitura da ocorrência 49" e a premissa foi MEDIDA e **descartada**: mediana de 0,95 h do SSW ao card na oc 49 (73 casos), mesmo perfil das ocs 8/10/11/20/43, 88,4% no mesmo dia, e zero pendência de relacionamento no Bastão com ocorrência anterior a ontem. Os prints do próprio relato foram o oráculo externo: o do SSW mostrava oc **19** (não 49) na NF 350796, e o da NF 2079912 mostrava 28/08 09:00 por `ai.salex` — a 49 foi lançada **pelo próprio Cockpit** (`agente-extravio-d4`). Os dois cards entraram no Cockpit em 57 min e no mesmo dia. O bug real era de APRESENTAÇÃO: o rodapé do card exibia `last_event_at`, que o trigger `project_card_event` reescreve a cada `card_event` — `HistoricoSswPuxado` (refresh interno de cache) sozinho é 13,5% dos eventos em 30d e `BastaoCardAtualizado` mais 9,8%, definindo o relógio de 27,2% dos cards de "Aguardando você". A NF 350796 estava parada na fila desde 26/08 (364 h brutas / 109 h úteis, o pior caso do sistema, 5 to-dos `pendente`) e anunciava "há 17h" porque um `HistoricoSswPuxado` de 09/09 20:21 resetou o campo — 36 dos 211 cards da fila mostravam menos da metade da espera real. Fix front-only (MODO FRONT PRÓPRIO): o relógio passa a ler `na_fila_desde` de `v_operador_fila_agora`, a mesma fonte da tela de Gestão, com fallback para o comportamento antigo. A ordenação NÃO foi tocada (as duas filas já estavam em `OLDEST_FIRST`) e nenhum chip novo foi criado (teto de 2 sinais no card). REGRA INVIOLÁVEL: o card nunca exibe como "tempo de espera" um campo que o sistema reescreve sozinho — card esquecido não pode se disfarçar de novo.
- 2026-09-11 — **INV-152 e INV-153 adicionados** (correção 11.09, NF 436268 / KAROLINE). O relato chegou como *"a operadora marca os anexos e eles não seguem pro SSW"* e a hipótese foi **medida e descartada**: o caminho dos anexos está íntegro — **404 lançamentos de oc 33 com imagem em 60 dias**, o último no próprio dia da investigação, até 15 anexos num só. O que quebra é anterior: a parede de `aprovar_e_executar` recusa a aprovação **inteira** (`OC33_DOSSIE_INCOMPLETO`) **antes** da linha que grava `args.extras`, e como é `RAISE EXCEPTION` a transação volta atrás — a seleção de anexos é descartada junto. Confirmado no banco: o todo `5d3432d0` da NF 436268 tem `extras` **sem `anexos_ids`**. No card, `valor` e `romaneio` estavam presentes e só faltava `descricao`. Também descartadas: falha de formato (a armadilha do anexo não-suportado foi corrigida em 23/07, INV-045) e problema local da operadora (**156 cards de 9 operadoras** no mesmo estado — DUILIO 34, FELIPE 31, KAROLINE 20). Achado colateral que virou o INV-153: a recusa **não deixava rastro nenhum** — 903 eventos `Oc33BloqueadaDossieIncompleto`, todos do robô, **zero** de operadora clicando — e a RLS `card_events_insert_operator` é a mesma que cegou a telemetria do PDF em 08/09. Dois buracos **medidos e deliberadamente deixados fora** por decisão do Carlos em 11/09: (a) a NF-e dos itens extraviados não é aceita como "descrição dos itens" (140 cards travados por isso, 21 deles **já com o anexo no card**); (b) 29 todos de oc 33 em cards de dossiê incompleto **sem carimbo bloqueante**, que a parede deixa passar com `extravio_parcial_gate_enforce` OFF desde 02/07. REGRA INVIOLÁVEL: a tela nunca oferece ação que o banco já decidiu recusar, botão apagado sempre diz por quê, e recusa de parede sempre deixa rastro medível.
- 2026-09-17 — **INV-155 adicionado junto com o ADR 0032** (Memória do Card — `cards.estado_tratativa`, branch feat/estado-tratativa). NÃO nasceu de bug: nasceu do desenho anti-regressão do plano aprovado pelo Caio. As travas, todas com teste puro em `_shared/estado-tratativa.test.ts` (9 casos): (a) `rev` monotônica com trava otimista no persist — corrida entre worker e recompute inline nunca regride a memória (o vigente vence); (b) recompute é idempotente (mesmas fontes ⇒ mesmo `hash_fontes`) e NUNCA insere `card_events` (loop de projeção impossível por construção); (c) jsonb capado a 6KB (`estadoDentroDoTeto` encolhe antes de gravar — realtime da tabela cards não incha); (d) fato `origem:"llm"` só pode FREAR autonomia, nunca liberar (D2 — alucinação no pior caso deixa o sistema MAIS manual); (e) o estado vive em coluna própria porque `agent_state` é SOBRESCRITO pelo snapshot do sync-bastao (só chave_cte/extravio_parcial têm preservação) — chave nova lá dentro morre no próximo sync; (f) `EVENTOS_ABERTURA_CICLO` existe em DUAS cópias (front `ciclosTratativa.ts` × `_shared/ciclos-tratativa.ts`, limitação de import) — check de drift: `grep -A7 "EVENTOS_ABERTURA_CICLO" apps/cockpit-web/src/lib/ciclosTratativa.ts supabase/functions/_shared/ciclos-tratativa.ts` deve listar os MESMOS 5 eventos nos dois arquivos; (g) cerca `contradiz_estado` sem estado (null/schema desconhecido) devolve `{ok:true}` — sem memória, o sistema é EXATAMENTE o de hoje. REGRA INVIOLÁVEL: a memória do card descreve e nunca prescreve; contradição com ela bloqueia só o AUTÔNOMO (o destaque ganha anotação, nunca some); e o jsonb é projeção descartável — na dúvida, recomputa do event log.
- 2026-09-18 — **INV-156: FALSO incidente "24h de Cockpit morto" — e as regras de pulso que ficaram.** O que pareceu acontecer: pg_cron morto desde 18/09 13:16-13:22 UTC, zero eventos, zero e-mails, zero IA por 24h, sem alarme. O que REALMENTE aconteceu (reinvestigação no mesmo dia, 18/09 ~13:30 UTC): o agente (Claude) se confundiu de data após compactação de contexto e passou a acreditar que era 19/09; todas as consultas de verificação usavam cortes em "2026-09-19..." (data FUTURA) e voltavam vazias — e o vazio foi lido como sistema morto. A ação 4573 "pendente há 24h" estava na verdade DENTRO da janela de veto normal (executar_em 18/09 11:01 BRT). Contraprova que refutou o apagão: (a) varredura de gaps no cron.job_run_details em 30h — ZERO janelas paradas >5min; (b) card_events em TODAS as horas de 17-18/09 (volumes normais, 800-1.800/h no horário comercial); (c) cards novos em todas as horas; (d) worker atualizar-estado-tratativa 62 execuções ok / 0 falhas nas 2h seguintes. Custo do falso alarme: um restart DESNECESSÁRIO da instância de produção via Management API (interrupção ≤2min, sem perda de dados) e uma narrativa falsa gravada em CLAUDE.md/INV/memória (corrigida neste texto). LIÇÕES (valem mesmo com o alarme sendo falso): (1) ancorar QUALQUER consulta temporal em now()/intervalos relativos, nunca em data absoluta digitada de cabeça — data absoluta pós-compactação é suspeita até provar o contrário; (2) antes de declarar sistema morto, medir o GAP diretamente (lead() sobre start_time), não a ausência de linhas depois de um corte; (3) antes de reiniciar produção, exigir DUAS evidências independentes com cortes relativos. PROTEÇÕES PERMANENTES (mantidas — o risco de um pg_cron morto sem alarme é real): (a) watchdog EXTERNO `.github/workflows/pulso-cockpit.yml` (GitHub Actions, */10min, secret SUPABASE_DB_URL, usa now()-max(start_time) — imune a erro de calendário; testado verde via workflow_dispatch em 18/09); NUNCA remover; (b) regra CLAUDE.md: migration que toca cron/trigger/worker só concluída com prova de pulso; (c) Fase 7.5 no /verify-cockpit. Remédio padrão se o pulso parar DE VERDADE: restart da instância (POST /v1/projects/<ref>/restart) — não perde dados.
- 2026-09-21 — **INV-158 adicionado junto com o ADR 0033** (marcação "Segregar CTRC" — campo `f8` da tela 101 — pedida pela PRATI, branch `segregar-ctrc-prati`). NÃO nasceu de bug em produção: nasceu da auditoria pré-merge do próprio dia, que achou DUAS brechas numa cerca que existia justamente porque a ação não tem desfazer. (a) O escopo "somente cards de extravio" estava escrito no pedido, no cabeçalho da migration e no texto da tela, e **não** no código — um card da PRATI em RECUSA (oc 10/11/35) com proposta de 54 passava e barrava a carga de uma recusa; o conjunto virou `OCS_CARD_EXTRAVIO = {6,9,16,49}` lido pelas DUAS fontes (`agent_state` e `cards`), porque o executor sobrescreve `cards.cod_ultima_ocorrencia` a cada lançamento e olhar só ele bloquearia o fluxo real de extravio em silêncio. (b) A prova de origem humana era fail-OPEN: o SELECT em `todos.auto_approval_rule` ignorava o `error` e colapsava três estados em "regra nula" = "foi humano" (todo humano / erro de RLS-timeout / todo inexistente), então `origemHumanaComprovada` passou a exigir leitura provada do todo. Segregar bloqueia o CT-e para transferência, movimentação e entrega e a retirada é MANUAL na opção 091 do SSW — **o Cockpit não desfaz**, é a única ação do fluxo sem volta pelo sistema. Daí a cerca QUÁDRUPLA (whitelist de cliente + oc ∈ {54,59} + card de extravio + aprovação humana comprovada), o kill-switch `segregacao_ctrc_enabled` avaliado ANTES da whitelist, e tudo nascendo OFF (mig 407: flag `enabled=false`, 2 CNPJs da PRATI `ativo=false`, smoke test inline que recusa o contrário). Ficaram DELIBERADAMENTE de fora, e estão registrados no ADR: o gêmeo `meta.sem_email_explicito` (aprova num `window.confirm`, sem painel — ação irreversível não se decide em diálogo de browser) e o combo 44+59 (payload próprio; misturar criaria o estado "uma passou, a outra falhou" que o mesmo-submit existe pra impedir). REGRA INVIOLÁVEL: **ação que o sistema não sabe desfazer não entra em autonomia** — robô nunca segrega; e um CNPJ jamais fica ativo ao mesmo tempo em `cliente_config_segregacao_ctrc` e `cliente_config_seguir_parcial_auto`, que são ordens contraditórias (barrar a carga × deixar seguir).

## INV-158 — Vencimento da janela de veto devolve por MOTIVO, nunca por movimento
- 2026-09-22 — O trilho autônomo ZEROU em 21-22/09 (98 armadas, 0 execuções, 78 devoluções "a memória do card mudou durante a janela"). Causa: a 2ª defesa do vencimento (plano 17/09) devolvia quando `estado_base_event_id` do pino divergia do atual — e, com a Memória do Card ligada (18/09), o estado recomputa a cada evento (sync horário, histórico, e-mail), então TODO card ativo "muda" em 60min: a condição virou devolução universal e os pilotos voltaram a aprovar tudo na mão sem saber por quê. REGRA INVIOLÁVEL: no vencimento, a devolução acontece SÓ quando (a) a CERCA reprova com o estado FRESCO (contradiz_estado:* — repetição, doc já recebido, 55 sem reentrega), ou (b) o mundo mudou de verdade (oc do card mudou, dono saiu do piloto, to-do sumiu, cliente respondeu, destaque mudou). Avanço de rev/base_event_id da memória é ANOTAÇÃO de auditoria (log), jamais gatilho de devolução. Quem re-introduzir "estado mudou ⇒ devolver" mata o trilho de novo em silêncio — conferir a série `acoes_agendadas` (status×motivo por semana) antes e depois de qualquer mudança nessa região. Fix: branch fix/vencimento-nao-devolve-por-rev; contraprova esperada = execuções voltando ao patamar ~85% das armadas na semana seguinte ao deploy.

## INV-084 (AMPLIADO 2026-09-22) — Message-ID real em TODO caminho de envio
- 2026-09-22 — O bug do Outlook (reply vira conversa nova) voltou pela TERCEIRA via: o fix de 18/08 cobriu prefixo+Thread-Index; o do Carlos (09-10/09) cobriu a âncora real do Message-ID (o Gmail reescreve o header — o id cockpit-<uuid> nunca existiu) e gravou `message_id_header` pós-envio — MAS só nos caminhos do executor/scan. Os 3 caminhos de resposta manual ficaram de fora do INSERT: `responder-email-cliente` (88% dos manuais sem o header em 14d — a aba Resposta, exatamente o que Sonepar/AGV/Würth recebem), `cobrar-cliente-aguardando` e `enviar-retificacao-evidencia`. Consequência: a 1ª resposta encadeia (ancora no inbound do cliente), a 2ª em diante nasce com References furadas → conversa nova no Outlook. REGRA INVIOLÁVEL: todo INSERT/UPSERT em `cards_emails_outbound` vindo de caminho de ENVIO persiste `message_id_header` (o sender compartilhado JÁ devolve `messageIdHeader` — é só não jogar fora). Verificação viva: fill-rate por caminho ≥95% —
  `select (todo_id is not null) as via_executor, count(*) filter (where coalesce(message_id_header,'')='')::float/count(*) as pct_sem from cards_emails_outbound where sent_at > now()-interval '7 days' group by 1;`
  Classe-padrão do projeto: "fix aplicado em N-1 dos N caminhos" — em bug de e-mail/threading, SEMPRE auditar TODOS os escritores de cards_emails_outbound (grep) antes de declarar coberto.

## INV-159 — A credencial única do SSW (ai.salex) NUNCA recebe rajada de login
- 2026-09-24 — INCIDENTE CAUSADO PELO PRÓPRIO AGENTE (Claude): um backfill de histórico da base Varginha invocou `puxar-historico-ssw-card` 1.702× com 4 em paralelo (~65 logins/min — cada chamada faz login novo no portal). Após ~650 chamadas em 10 min o SSW bloqueou a credencial: "Usuário bloqueado até 12:48h por uso indevido" — e TODOS os robôs de produção (executor, vinculador, agentes, puxadas) ficaram ~1h sem SSW (falhas caem pro humano via reverter_acao_falhou — sem lançamento errado, sem perda; mas 1h de trilho cego). A estimativa "4 em paralelo = carga normal do robô" comparou com o TOTAL diário (~1.800/dia ≈ 1,25/min) e ignorou a taxa por minuto: a rajada foi ~50× o orgânico. REGRA INVIOLÁVEL: (a) nenhum job em lote pode abrir sessão no SSW acima de ~10 logins/min nem correr em paralelo com a credencial compartilhada; (b) backfill de histórico só com SESSÃO REUTILIZADA (1 login, N consultas) e ritmo ≤ orgânico, ou em credencial dedicada de leitura; (c) antes de qualquer varredura no SSW, medir a taxa/min orgânica (card_events HistoricoSswPuxado por minuto) e provar que o plano fica abaixo dela; (d) se o SSW bloquear: NÃO trocar senha, NÃO reiniciar nada — esperar o horário do desbloqueio, monitorar `AcaoFalhou` com "login falhou", e re-aprovar as ações que caíram pro humano. Verificação viva: `select date_trunc('minute',created_at), count(*) from card_events where event_type='HistoricoSswPuxado' and created_at>now()-interval '1 hour' group by 1 order by 2 desc limit 3;` — nenhum minuto acima de ~15.

## INV-161 — Reentrega (oc 21) com CCE de endereço vigente NUNCA sai pela janela de veto
- 2026-09-28 — Âncora NF 40484 (FELIPE, TSD): o cliente mandou "Segue carta de correção em anexo" e a 21 saiu sozinha 1h depois, sem correção do endereço no SSW. Na NF 3907402, a CCE veio em 18/09 e uma cobrança SEM CCE em 24/09 soltou a 21 — a entrega falhou de novo. Em 30 dias foram 10 reentregas com CCE real saindo sozinhas. REGRA (Carlos 28/09, ADR 0035): nas 3 portas que armam a 21 a partir de e-mail do cliente (`interpretador-resposta-cliente`, `propostas-pos-resposta-cliente`, `agente-sugere-ocs-padrao`) toda armação passa por `agendarComTravaCce` (`_shared/cce-endereco-trava.ts`) — NUNCA por chamada direta a `agendarAcaoAutonomaSeElegivel`. A trava vale enquanto houver e-mail com CCE de ENDEREÇO depois da última reentrega, que é a mais nova entre a 21 com sucesso em `acoes_executadas_ssw` e a 21 do histórico do SSW gravado no card (`cards.historico_ssw`, do CTRC do card, pela data digitada no lançamento via `parseSswDataHoraBrt` — o SSW recusa data futura, então ela nunca é posterior ao lançamento real; data impossível/futura é ignorada; lido só quando a trava já seguraria; o histórico expira em 24h e, se não estiver lá ou der erro, a trava continua — nunca usar a hora em que o Cockpit viu a 21, porque uma 21 lançada antes da CCE e vista depois soltaria a trava); CCE de volume/pedido/produto e CCE sem sinal de endereço seguem no automático. A detecção lê só o texto escrito pelo cliente (a nossa frase de template "solicitamos também o envio de uma CCe" volta citada e gerava 11 falsos positivos) e o nome do anexo. O evento `CceEnderecoSegurouAutonomo` nunca pode ser renomeado para começar com "Acao" (`reconciliar_execucoes_presas` usa `LIKE 'Acao%'`). Residuo consciente: robo-intranet-wurth, agente-oc13-autonomo e scripts/backfill-veto-agendamentos.ts NÃO passam pela trava — quem ligar a Ingrid no piloto ou rodar o backfill tem de rever isso antes. São os ÚNICOS arquivos (fora testes, a definição e a própria trava) que podem citar `agendarAcaoAutonomaSeElegivel`: o guard de fiação varre `supabase/functions` e `scripts` por lista de exceções, e arquivo novo que arme ação autônoma direto (inclusive por apelido ou `import * as`) reprova. Furos conhecidos (ADR 0035, "O que NÃO está coberto"): e-mail em conversa NOVA ligado pelo número da NF (o vinculador chama o interpretador antes de ligar a mensagem ao card); 21 já agendada não é desarmada nem reconferida no vencimento, o que inclui as 21 armadas antes da publicação. O evento marca "passou nas 3 cercas de sistema e havia CCE vigente", não "a 21 teria saído" (cerca de 12% não sairiam por outra cerca). `VERSAO_REGRAS_ANALISE` NÃO sobe de propósito, porque reanalisaria todos os cards; o FAIL do INV-128 sobre este diff é alarme falso. Guard: `cce-endereco-trava.fiacao.test.ts` (FALHA na master 92cd9fb) + `cce-endereco-trava.test.ts` (provado por mutação) + bloco INV-161 da Fase 8 do `/verify-cockpit`. Verificação viva após publicar: `select count(*) from card_events where event_type='CceEnderecoSegurouAutonomo' and created_at > now() - interval '7 days';` (esperado 2–4 CCEs distintas por semana; replay de 60 dias = 13 em 93 armações do interpretador, 0 em 58 da reanálise).

## INV-162 — Relançar a oc 33 nunca exige o romaneio que a própria lista escondeu
- 2026-09-29 — Âncora NF 435297 (KAROLINE, CTRC AMP561683-2): a 1ª 33 (03/09) levou o romaneio `WhatsApp Image 2026-09-02 at 17.54.29.jpeg` ao SSW e `finalizarAnexosPosEnvio` o apagou do bucket no mesmo minuto; o dossiê continuou apontando para ele. Depois de uma oc 26 do backoffice (23/09) o card voltou e a Karoline tentou relançar a 33 pelo menos nove vezes (cada tentativa deixou gravada uma conversão da NF-e): o modal só lista anexo vivo (`.is("deletado_em", null)`, auditoria 25/07) e o guard de 25/07 (commit 8b07747, NF 158084) exigia o romaneio pelo NOME ("selecione-o na lista") — pedia o impossível. Nenhuma tentativa chegou ao servidor (recusa da tela não deixa evento). Medido em 29/09: 7 cards com 33 pendente e romaneio apagado, todos com a 33 já lançada. REGRA (Carlos 29/09, ADR 0023 adendo 29/09): a decisão mora em `apps/cockpit-web/src/lib/romaneio-modal-oc33.ts` (`situacaoRomaneioNoModal` + `decidirConfirmacaoRomaneio`). Romaneio na lista e não marcado → barra com o texto de sempre. Romaneio apagado → só a **33 SOZINHA** segue sem ele, e só se for imagem do SSW (`MIMES_IMAGEM_SSW`, espelho de `ehImagemMimeSsw`) e a busca ainda não tiver falhado neste card desde que o romaneio foi visto (`Oc33CompletudeReanexoFalhou` com `faltando` começando por "romaneio"); aí o executor busca de novo no e-mail (`materializarOc33Completude` → `reanexarEvidenciaDoDossie` → `reprocessar-anexos-mensagem`) e REVERTE sem lançar se não achar. A **33+44 continua barrando** (com o caminho manual explicado): `processarComboPortal33_44` NÃO materializa, então liberar o combo lançaria a 33 sem romaneio — o erro da NF 158084. PDF apagado e busca que já falhou também continuam barrando. Lista ou histórico carregando/com erro → regra de antes (a consulta passou a lançar o erro em vez de devolver lista vazia). Caminho manual que sempre vale: subir a MESMA imagem com o MESMO nome em "+ Adicionar arquivo" (o sanitizador `storage-key` preserva espaço, ponto, hífen e parênteses). Prova: na busca de julho, os 7 arquivos trazidos de volta do Gmail tinham exatamente o tamanho do original (o casamento `acharAnexoDoDossie` é por nome+tamanho+tipo); o caminho específico da busca do ROMANEIO em imagem nunca tinha rodado em produção (os 2 `Oc33CompletudeReanexoFalhou` são o PDF da NF 158084) — a primeira execução real fica para a validação com card controlado. Furo conhecido: romaneio em PDF apagado não tem saída pela tela (o executor não converte PDF e o upload do modal só aceita imagem). Backend intocado. Guard: `romaneio-modal-oc33.test.ts` (20, com matriz de 800 casos provando que fora da busca no e-mail bloqueia exatamente quando a regra antiga bloqueava) + `ProposedActions.romaneio-ja-enviado.test.ts` (8, fiação dos 2 modais + premissas do executor; os 4 de fiação FALHAM na master 0a62545) + bloco INV-162 da Fase 8 do `/verify-cockpit` (FALHA na master). 16 de 16 mutações reprovadas. Verificação viva após publicar: `select count(*) from card_events where event_type='Oc33CompletudeReanexoFalhou' and created_at > now() - interval '7 days';` (esperado 0; cada falha é um card em que a busca não achou o arquivo e a operadora foi mandada para o caminho manual).

## INV-163 — A marcação do agente de extravio tem volta: 49 que falhou tenta de novo e ciclo novo volta a contar
- 2026-09-30 — Âncoras NF 14877 (TUI380374-1, LARISSA, reversa) e NF 787209 (JRA442006-3, LARISSA, reversa). O `agente-extravio-d4` só olhava `agente_extravio_status IS NULL`, e a marcação `lancou`, gravada logo depois de `auto_aprovar_e_executar` (antes do resultado do executor), nunca era desfeita. Resultado: (1) a 49 que o SSW recusou (NF 14877: 429 em 21/09) voltava para Extravios marcada e ninguém tentava de novo; (2) o novo extravio depois de um ciclo tratado (NF 787209: 49 em 16/09, extravio de novo em 23/09) não era contado. **NÃO é regra de reversa**: a contagem de dias é a mesma para todo CT-e (5 normais e 4 reversas nas duas situações em 29/09). REGRA (Carlos 29/09, ADR 0036): a decisão é DERIVADA dos dados a cada rodada, em `_shared/agente-extravio-reavaliacao.ts` (`decidirReavaliacaoAgente`, `ehCicloNovo`, `classificarReincidencia` = `ehReincidenciaAchouEPerdeu` + `ehReincidenciaJaTratado`, `deveLancarReincidencia`). Sem marcação → a regra de antes, inalterada. A 49 falhou (`AcaoRevertidaPosFalha` com o `todo_id` da última 49 do agente) e ainda não saiu → nova tentativa, até **3 por ciclo**; esgotadas, o card vai para NÃO RODOU com `motivoFalhasSsw`. Ciclo novo → régua de sempre (cliente > operador > 4 dias úteis) + pré-checagem SSW. Todo `AgenteExtravioLancou49` grava `data_extravio`: extravio atual MAIS NOVO que o tratado = ciclo novo; igual = mesmo ciclo (a 49 imediata nunca relança); mais velho = Bastão atrasado. Lançamentos antigos (sem o campo) usam a data do dia da marcação, válido porque o caminho antigo só lançava com ≥ 2 dias úteis. Upgrade: a reincidência recebe a 49 no mesmo dia, sem esperar o limiar, em DOIS tipos, cada um com a SUA chave — "achou e perdeu de novo" (Carlos 29/09: extravio → 20 "extravio localizado" → extravio; chave `extravios_reincidencia_achou_perdeu_enabled`) e "já tratado e extraviou de novo" (Carlos 30/09: extravio → tratativa → extravio; tratativas = `OCS_TRATATIVA_EXTRAVIO` {49, 54, 56, 59, 33, 46, 42, 47}, a 55 NÃO conta, a 49 do próprio agente conta — NF 756245; chave `extravios_reincidencia_ja_tratado_enabled`). "06, 06" seguidos, só movimento da carga entre os extravios e coleta→transferência sem tratativa NÃO contam. Os dois **nascem em OBSERVAÇÃO**: com a chave ausente/OFF, só anota em `agent_runs` (step `reincidencia`, com `achou_e_perdeu` e `ja_tratado` no output), sem lançar nem tocar no card. Ligar vale para os extravios avaliados dali em diante: quem já foi anotado na observação segue a régua normal (não sai rajada de 49 ao ligar). Replay nos 307 históricos do SSW guardados no Cockpit (30/09), com o código novo: 39 novos extravios; 21 pelo "achou e perdeu", 25 com o "já tratado" (+4: NFs 383793 duas vezes, 817275, 756245); nenhum caso da regra anterior perdido. Só lê o SSW de quem tem sinal de extravio anterior no Cockpit, até 15 por hora, uma vez por (card, data do extravio), e espera quando a rodada principal já usou o SSW. A rodada principal (cards sem marcação) segue igual; só deixou de terminar mais cedo. Guard: `agente-extravio-reavaliacao.test.ts` (39, com a conferência de TODOS os 299.592 históricos possíveis de até 6 ocorrências contra a definição do "já tratado" e a prova de que, com a chave do "já tratado" desligada, a decisão é idêntica à anterior) + `agente-extravio-reavaliacao.fiacao.test.ts` (7, FALHA contra o agente da master 610c7f5 e contra o da véspera 76d9e31); 38 de 38 mutações reprovadas (uma equivalente trocada); bloco INV-163 da Fase 8 do `/verify-cockpit` (inclui a lista de tratativas). Suíte Deno: branch 1432 passed / 2 failed × master 1386 / 2, as mesmas 2 falhas antigas. A INV-022 (DB) passa a contar só o que está preso NO MESMO ciclo: ciclo novo esperando o limiar é legítimo e é medido aqui. Furos conhecidos (ADR 0036): reentrada TRANSFERIDO → EXTRAVIO_MONITORADO no `sync-bastao` continua sem card_event; `nao_rodou` com ciclo novo fica como está (já visível); primeiro extravio que o Cockpit nunca viu não gera sinal (segue a regra normal). Verificação viva após publicar: bloco INV-163 (DB) = `acima_do_teto=0` e `ciclo_novo_vencido=0`; observação: `select count(*) filter (where output->>'achou_e_perdeu'='true') as achou_e_perdeu, count(*) filter (where output->>'ja_tratado'='true') as ja_tratado from agent_runs where agent_name='agente-extravio-d4' and step_name='reincidencia' and output->>'reincidente'='true';`.

## INV-164 — Card reaberto nunca fica sem re-análise do agente
- 2026-10-01 — NF 81446 (Alucel, Ingrid): card de oc 11 na fila SEM sugestão. A análise existia, mas era de 10/08 (versão 2026-08-08a, GPS de OUTRA 11); o card viveu um ciclo (54 em 11/09 → TRANSFERIDO 25/09 → REABERTO 29/09 com 11 nova) e nunca foi re-analisado: a seleção de candidatos e a varredura de stale do `agente-sugere-ocs-padrao` cortavam por `created_at > now()-30d` (NASCIMENTO do card) — card com >30 dias de vida ficava invisível pra sempre, mesmo com oc nova e to-dos pendentes. Classe: 9 cards em AVH com análise de versão velha (8 com >30d). Mesmo padrão no `agente-oc13-autonomo`. REGRA INVIOLÁVEL: a janela de elegibilidade dos agentes de análise é por `updated_at` (última MUDANÇA), nunca por `created_at`; a análise SEMPRE re-puxa o histórico SSW ao vivo antes de decidir (já era assim — a reabertura é coberta por consequência). Guard: `_shared/janela-reanalise.test.ts` (grep nos 2 agentes; rodar com `--allow-read`). Verificação viva: `select count(*) from cards where state='AGUARDANDO_VALIDACAO_HUMANA' and analise_padrao_status='concluida' and coalesce(analise_padrao_resultado->>'versao_regras','') <> '<VERSAO_REGRAS_ANALISE atual>' and updated_at > now()-interval '30 days';` → 0 após uma rodada do cron.

## INV-166 — Conversa do lado do cliente nunca vira 56 lançada sozinha
- 2026-10-02 — NF 1042798 (PRATI, CTRC PRT611953-1; relato da operadora ao Carlos; nomes abaixo fictícios, LGPD). Em 29/09 16:32 a Ana (PRATI) respondeu a todos pedindo "@Bruno [PRATI], enviar a evidência de erro cliente para não gerar RC — não podemos aceitar a imagem abaixo como evidência". Era conversa INTERNA do cliente ("a imagem abaixo" = print do Bruno). O interpretador, que NÃO recebia De/Para/Cc, casou "não aceita a imagem" com a definição da 56, escreveu "SOLICITAR À OPERAÇÃO/EQUIPE COMERCIAL..." (confiança 0,82) e a janela de veto lançou a 56 sozinha às 08:19 de 30/09 (agendamento 5154). A operadora corrigiu com 49 "OCOR LANCADA INCORRETAMENTE". Medição de 60 dias: 644 leituras finais 56, 63 lançadas sozinhas; o sinal das menções seguraria 17 delas, 3 que tinham saído sozinhas (esta, NF 895809 Autoglass→"@Ocorrências Frete" — também interna — e NF 911810, legítima). REGRA INVIOLÁVEL: (1) o interpretador recebe o bloco "QUEM ESCREVEU ESTA RESPOSTA E PARA QUEM" (`_shared/participantes-email.ts`) e devolve `pedido_dirigido_a` (a quem se dirigem os PEDIDOS/CONTESTAÇÕES do texto novo); a seção (e) do prompt vale SÓ para a 56 — para qualquer outra decisão o destinatário não importa; (2) leitura `outra_pessoa` + 56 → aguardar (54/59), texto da 56 descartado, card NÃO volta sozinho ao terminal e nem esse aguardar arma a janela (`_shared/conversa-interna-cliente.ts`, último elo depois de R2–R5); (3) sinal DETERMINÍSTICO (`soMencionaQuemNaoEDaSal`: o texto novo só marca com "@Nome<mailto:>" quem não é da Sal e não fala com a Sal pelo nome) → a 56 fica como sugerida mas NÃO sai sozinha — existe porque o modelo acertou a âncora numa rodada e errou na outra (variação natural ~12%); (4) tudo que não é 56 fica EXATAMENTE como hoje, sugestão e autônomo. PROIBIDO: (a) prompt dizendo "outra pessoa = nada a fazer" — o 1º ensaio virou em 54 decisões legítimas ("@Paula, segue o romaneio em anexo"; autorização no histórico citado, NFs 50769/8087/287903/245154); (b) segurar no autônomo ações não-56 por leitura "outra_pessoa" — tirava 16 de 90 decisões legítimas do automático sem evitar erro; (c) regra na DEFINIÇÃO da 56 — deixava o modelo com receio de 56 legítima (NF 906427 "não consigo abrir a ressalva"); (d) regex de "@colega" decidindo oc. Campo ausente e sem menções = comportamento de hoje. Guards: `conversa-interna-cliente.test.ts`, `participantes-email.test.ts`, `veto-elegibilidade.test.ts` e `conversa-interna-fiacao.test.ts` (grep nos 3 elos; provado FAIL contra a master; rodar com `--allow-read`). Ensaio A/B: `evals/replay-conversa-interna.ts` (dataset fora do repo). card_event: `SugestaoContidaPorConversaDoCliente`. Verificação viva: Fase 7.9 do `/verify-cockpit` → 0.
## INV-167 — Eval/script local NUNCA roda com a chave de produção da Anthropic, e todo lote caro mostra o custo ANTES
- 2026-10-02 — 5 recargas de US$10 na conta Anthropic no mesmo dia; o console mostrou ~10M tokens de Sonnet 4.6 entre 12:50 e 13:27 UTC que NÃO estavam em `anthropic_usage_log` nem deixaram rastro em `agent_runs`, `card_events`, `cron`, logs de invocação das edges (ClickHouse) ou `pg_net`. Origem (relatório do Carlos, com saída dos scripts): um ensaio A/B de prompt (`evals/replay-conversa-interna.ts` + `ruido56.ts`, correção da NF 1042798 — autônomo da Larissa lendo tratativa interna do cliente como nossa) fez **1.083 chamadas diretas a `claude-sonnet-4-6`** com `--env-file=.env.local`, ou seja, com a **chave de PRODUÇÃO** (a mesma do secret das edges — sha256 batem), sem gravar consumo e sem pedir OK. ≈ US$35. O Claude Code dele estava na assinatura (Team) — não foi o agente, foi o script. Diagnóstico do Claude ANTES do relatório errou a mecânica duas vezes (primeiro "Cockpit normal", depois "Claude Code pela chave via ritual-env") e acertou só o lugar: máquina do Carlos, chave de produção, fora do backend. Três furos → três cercas: (1) **chave separada**: `lib/anthropic-client.ts`, `evals/replay-regras.ts`, `evals/chat-agente-chefe-smoke.ts`, `evals/replay-conversa-interna.ts` (o próprio ensaio do incidente — importava o client das edges e nem citava a variável, por isso o guard (b2) olha o import e não só o nome) e qualquer script novo leem **`ANTHROPIC_API_KEY_EVALS`** via `evals/_custo-evals.ts::lerChaveEvals` e RECUSAM com explicação quando só `ANTHROPIC_API_KEY` está no ambiente; a chave de produção vive só no secret do Supabase (`.env.example` documenta); (2) **custo visível**: `ContadorCusto` soma o `usage` de cada resposta e imprime o total em US$ no fim; (3) **portão**: acima de 50 chamadas o eval só roda com `--confirmar-custo <USD>` numérico ≥ estimativa (10k in/300 out por chamada, erra pra cima) — `replay-regras` com defaults e `--rodadas 3` = 1.260 chamadas ≈ US$43, exatamente a escala do incidente; (4) `scripts/ritual-env.sh` **não exporta** `ANTHROPIC_API_KEY` (nada do ritual precisa dela; um agente aberto nesse shell herdaria a chave). Fechou também o último ponto cego do backend: `agente-ressarcimento-relancar-54` (Haiku, sem cron) ganhou `onUsage`. REGRA (CLAUDE.md): script local que chama a Anthropic = chave de evals + portão de custo; >50 chamadas = estimar e pedir OK ao Caio antes de rodar — "não avisei que era a chave de produção" não acontece de novo. Dívida conhecida (WARN na Fase 7.8): 5 edges ainda sem `onUsage` (`cerebro-veto-dossie`, `agente-monitor-efetividade-ai`, `analisar-indicador-erros-lancamento`, `redator-email-saida`, `redator`) — todas de clique/semanais, sem cron frequente. Pendem ações no console (Caio): criar `ANTHROPIC_API_KEY_EVALS` com teto próprio, limite de gasto no workspace, e decidir a rotação da chave de produção (sem evidência de vazamento; está em `.env.local` de 2+ máquinas). Guard: `evals/_custo-evals.test.ts` (8) + Fase 7.8 do `/verify-cockpit` (a-d). Verificação viva: console da Anthropic por chave — a de evals concentra todo ensaio; a de produção fica ~US$15/dia, lisa, igual a `select date(created_at), round(sum(estimated_cost_usd)::numeric,2) from anthropic_usage_log group by 1 order by 1 desc limit 7;`.

## INV-168 — Toda ENTRADA do card em ocorrência com regra ganha sugestão nova, e o ciclo conta só entrada no Relacionamento
- 2026-10-05 — Relato do Caio: cards sem sugestão do agente. Medição (14 dias, por aprovação): na 1ª vez da ocorrência no card 96% tinham análise do ciclo (156/162); com a ocorrência REPETIDA, só 67% (39/58). Três causas independentes, cada uma provada com card próprio: (1) INV-164, já corrigido em 01/10 (14 das 17 faltas anteriores); (2) **teto vitalício** — `analise_padrao_tentativas` somava análises bem-sucedidas da vida inteira e a seleção exige `< 3`; a mesma oc que volta (10→54→10) não é pega pelo check de oc diferente e dependia só da auto-cura "concluída + aviso nulo", que esbarra no teto (NF 807171: teto em 3 desde 29/09, reaberta com 49 em 02/10 09:01, aprovada 14:08 sem análise; NF 2509611: teto em 5–7); (3) **Porta 4 × transição no mesmo dia** — o Pass A movia o card pra AGUARDANDO VOCÊ pela HORA do SSW, mas a Porta 4 (INV-096) preservava a oc antiga pela DATA (`<=`): card em AVH com oc 54 gravada, invisível pro agente (NF 10856904: 54 às 11:03 e 49 às 19:35 de 30/09, "card=54, Bastão=49" 39 sincronizações seguidas; NF 9207: 80; 30 de 261 entradas em 14 dias). REGRAS INVIOLÁVEIS: (a) a análise do agente vale por ENTRADA — evento de entrada posterior à análise, ou ocorrência do mesmo código mais nova que a carimbada em `oc_data_analisada`, invalida e ZERA as tentativas (`_shared/analise-nova-entrada.ts`; evento `AnaliseInvalidadaPorNovaEntrada`; teto anti-loop de 3 por card em 24h); (b) se a rodada do Pass A moveu/reabriu o card por causa de uma oc, essa oc É gravada (`devePreservarOcDoCard`) — sem transição, a Porta 4 segue preservando (NF 306070 intacta); (c) **ciclo** (definição de 25/08, ajustada pelo Caio em 05/10): abre só na entrada/reabertura no Relacionamento com oc de relacionamento; a ocorrência de EXTRAVIO (6/9/16 — `ExtravioImportado`) NÃO abre; a 49 lançada pelo Cockpit (`AgenteExtravioLancou49`) abre, inclusive em card que já teve ciclo; reaberturas seguidas sem ação executada no meio são UMA entrada (oc 57: ~90 reaberturas/card em 30 dias); 54/59 respondida com oc nova e resposta de cliente são ETAPAS do mesmo ciclo (`aberturasValidas`, duas cópias — front e `_shared`). Chip "Ciclo N · etapa M" + pop-up no painel da sugestão (`CiclosChip`, `lib/historicoCiclos.ts`). Guards: `_shared/analise-nova-entrada.test.ts`, `_shared/lag-lancamento-54.test.ts` (3 casos INV-168), `apps/cockpit-web/src/lib/ciclosTratativa.test.ts`, `historicoCiclos.test.ts`, Fase 7.10 do `/verify-cockpit`. ADR 0037.

## INV-169 — 54/59 que poderia segregar é da operadora (o robô não lança), e 49 sozinha não é extravio
- 2026-10-06 — Relato da operadora Larissa (PRATI) ao Carlos: "a função de segregar não aparece nas tratativas". Investigação só de leitura: NÃO havia bloqueio nem erro de tela (flag `segregacao_ctrc_enabled` ON, 2 CNPJs ativos, RPC `cliente_pode_segregar_ctrc` respondendo, `cnpj_pagador` nos 33 cards dela, a caixa já tinha ido no payload 4x) — e ZERO segregações desde a ativação de 22/09. O que tirava a caixa dela, por desenho: (1) a janela de veto executou SOZINHA 23 ações de 54/59 da PRATI entre 22/09 e 06/10 (20 na variante "+ e-mail", a que tem a caixa; 12 em card com 49 — 10 com extravio comprovado), 7 delas antes da primeira ação do dia da operadora (o lote do `agente-sugere-ocs-padrao` agenda ~08h05 e executa 09h00–09h20); a D5 do ADR 0033 impedia o robô de SEGREGAR, nada impedia o robô de LANÇAR — e lançar consome a única chance de segregar; a memória de 22/09 mandava reabrir a decisão se a autonomia sobre 54/59 da PRATI mudasse, e ela mudou sem ninguém reabrir; (2) o gêmeo "SEM e-mail" não tinha a caixa (ADR 0033 (a)) — o Carlos esclareceu que segregar não depende do e-mail. E (3) o Carlos apontou que **a 49 não é extravio**: no dicionário ela é "Tratativa de relacionamento"; extravio é 6/9/16. A 49 tinha entrado em `OCS_CARD_EXTRAVIO` em 21/09 como atalho (o robô do extravio lança uma 49 no D+4), e qualquer 49 de relacionamento passava por card de extravio (2 dos 6 cards abertos da PRATI com 49 sem extravio comprovado: NF 1036215 e 1037313). REGRAS INVIOLÁVEIS: (a) **se a ação, aprovada por humano, poderia segregar, o robô não lança** — `segregacaoReservadaAoHumano` é a MESMA `segregacaoPermitida` com origem humana suposta (sem cópia), checada no AGENDADOR (`veto-agendamento` → cerca `segregacao_reservada_a_operadora` em `decidirElegibilidadeVeto`, depois do piloto) E no VENCIMENTO (`processar-acoes-agendadas` devolve antes do `auto_aprovar_e_executar_veto`); (b) **na dúvida, reserva**: card ilegível ou whitelist ilegível → a ação fica com a operadora (`carregarWhitelistSegregacaoComStatus` separa "segregação desligada" de "não consegui ler"; o loader do executor colapsa os dois em vazio, certo lá e errado aqui); (c) "aguardar" e qualquer ação que não seja 54/59 nunca são reservados, sem custo de leitura; outros clientes e PRATI fora de extravio ficam como hoje; (d) **49 só é extravio com a prova do robô**: `OCS_CARD_EXTRAVIO = {6,9,16}` (paridade com `EXTRAVIO_OCS` travada por teste) e a 49 conta só com `cards.agente_extravio_status = 'lancou'` (`roboDoExtravioLancou49`, campo OBRIGATÓRIO `oc49LancadaPeloRoboDoExtravio` na cerca) — vale para o executor e para a reserva; (e) a linha "SEM e-mail" de cliente que segrega + 54/59 abre `ModalSemEmailSegregacao` (aviso do confirm + CT-e à vista + caixa desmarcada) e manda `extrasSemEmailComSegregacao` (os 3 campos deliberados de sempre + `segregar_ctrc` SEMPRE booleano); demais clientes seguem no `window.confirm`; (f) fatias de autonomia (`autonomia-fatias.ts`, 54/59 em `OCS_SEGURAS_AUTONOMIA`) ficaram FORA da reserva porque a flag `autonomia_fatias_enabled` está OFF — se ela ligar com a segregação ativa, o bloco INV-169 do `/verify-cockpit` reprova e esta decisão tem de ser reaberta ANTES. PROIBIDO: desligar a escada `acoes_autonomas_veto_config` das 54/59 para "resolver" (tiraria o robô de TODOS os clientes); pôr a caixa no `window.confirm`; tratar 49 sem prova como extravio. Kill-switch herdado: desligar `segregacao_ctrc_enabled` devolve as 54/59 ao robô E some a caixa, sem deploy. Resíduos aceitos: 49 lançada à mão após extravio não prova extravio (segregação recusada, robô pode agir); `agente_extravio_status='lancou'` persiste no card. Guards: `_shared/segregacao-ctrc-reserva.test.ts` (regra pura, leitor com status, decisão async), `_shared/segregacao-ctrc-reserva-fiacao.test.ts` (agendador + vencimento, sem comentários), `segregacao-ctrc.test.ts` (bloco "49 não é extravio"), `segregacao-ctrc-executor.test.ts` (INV-segregação-9), `veto-elegibilidade.test.ts`, front `ModalSemEmailSegregacao.test.tsx`, `extras-sem-email.test.ts`, `ProposedActions.segregacao.test.ts`; 11 mutações no backend e 8 no front, todas pegas. Bloco INV-169 da Fase 8 do `/verify-cockpit` (inclui o check de banco das fatias). ADR 0033, Adendo 06/10 (D6–D8). Verificação viva: `select count(*) from acoes_agendadas aa join cards c on c.id=aa.card_id where aa.tipo='executar_acao_autonoma' and aa.status='processado' and aa.created_at > '<publicação>' and c.agent_state->>'cnpj_pagador' in (select cnpj_pagador from cliente_config_segregacao_ctrc where ativo) and (aa.payload->>'acao_key') ~ '^lancar.*:(54|59)$' and ((aa.payload->>'oc_card')::int in (6,9,16) or ((aa.payload->>'oc_card')::int = 49 and c.agente_extravio_status='lancou'));` → 0 (usa a oc do card NO AGENDAMENTO: depois do lançamento o campo do card já vale 54/59).

## INV-170 — Cliente colocado no 2º dia útil do extravio não volta ao 4º em silêncio
- 2026-10-06 — Chamado CH-20261006-JFV8 (Carlos): AVANTE SAUDE ANIMAL, VIA RURAL, SOMA MG PROD HOSPIT e MEDIKA/HTS entram na regra da 49 do extravio no 2º DIA ÚTIL, "igual à PRATI". Validado antes (só leitura): desde 30/09, quando a data do extravio passou a ir no evento, os 11 `AgenteExtravioLancou49` de PRATI/ATLAS saíram no 2º dia útil, os do operador com 2 dias em 22 de 24 (2 no 3º), e os 74 do padrão no 4º; os 621 lançamentos da 49 do robô em 30 dias foram SEM e-mail (a "notificação" do chamado é a 49 "PRAZO DE PERDAS EXPIRADO" no SSW, e o card volta para a operadora). Extravio = só 6/9/16 no `ocorrencias_dicionario` (59 códigos; 18 = sinistro/Ressarcimento, 19 = falta de volumes, 20 = extravio localizado ficam fora). Achado: o 2º CNPJ da PRATI (73856593000166) nunca tinha sido cadastrado em `cliente_config` (zero cards com ele como pagador) — entra com a MESMA regra da PRATI (Carlos 06/10: "deve entrar na mesma regra atual da PRATI"): a linha é cópia da do 73856593001057 (romaneio interno pela plataforma da Sal + template `EXTRAVIO_TOTAL_NOTIFICACAO` + prazo de 2 dias), como já é com a Würth (4 CNPJs) e a Black & Decker (2); oc 13, segregação e carteira já valiam para os dois CNPJs; e (Carlos 06/10, "pode incluir") a lista de escalonamento do Ressarcimento que cobre o 1º CNPJ passa a cobrir o 2º — o único leitor automático, `cobrar-ressarcimento-wpp`, é botão da operadora, e sem a inclusão daria erro "nenhum analista cobre o CNPJ" (não há contato global). REGRA: o prazo é DADO, não código — `cliente_config.dias_autonomo_extravio = 2` (régua cliente > operadora > 4 de `dias-autonomo-extravio.ts`, lida pelo `agente-extravio-d4` na rodada principal E na reavaliação, sem filtrar `ativo`). Para os 4 clientes novos é SÓ O PRAZO: as linhas deles nascem nos defaults (romaneio interno, intranet Würth e busca por remessa desligados; segregação usa lista própria) — os 9 leitores de `cliente_config` (código + funções/views do banco) dão o mesmo resultado de "cliente sem linha". As operadoras desses clientes seguem no 4º dia para os demais clientes delas. A contagem pula sábado/domingo mas NÃO pula feriado (igual à PRATI desde 28/07; esta mudança não altera isso). A trava de segurança INV-020 continua: a 49 só sai se o SSW ainda mostrar o extravio como última ocorrência. Lista viva (9 CNPJs): PRATI 73856593001057 + 73856593000166, ATLAS 89723837000849, Avante 07932725000167 + 07932725000248, Via Rural 10406295000154 + 10406295000235, Soma 12927876000167, Medika/HTS 66437831000133. Cliente novo no 2º dia = migration de dado no molde da 409/412 + CNPJ no bloco INV-170 no mesmo ato. Guard: bloco INV-170 da Fase 8 do `/verify-cockpit` (check de banco: `fora_do_2o_dia` = 0 e `prati_divergente` = 0 — os dois CNPJs da PRATI com a mesma regra em `cliente_config`, `cliente_config_oc13`, `cliente_config_segregacao_ctrc` e `contatos_escalonamento`, porque a regra é do cliente e não do estabelecimento; e o agente ainda lê o prazo do cliente nas 2 consultas) — reprovava antes da mig 412 (7 fora, PRATI divergente em 2 regras), passa com a 412 aplicada em ensaio e reprova se só um CNPJ da PRATI mudar em qualquer das 4 regras (provado uma a uma, e duas juntas = 2). A própria mig 412 tem guarda (DO) que recusa a aplicação se o 2º CNPJ não ficar igual ao 1º na configuração ou no escalonamento. Simulação antes de aplicar (só leitura, 06/10): só os cards desses CNPJs mudam de dia (24: 1 na rodada seguinte, 7 em 07/10, 16 em 08/10); os outros 324 extravios abertos ficam no mesmo dia. Verificação viva: `select count(*) from card_events e join cards c on c.id=e.card_id where e.event_type='AgenteExtravioLancou49' and c.agent_state->>'cnpj_pagador' in ('07932725000167','07932725000248','10406295000154','10406295000235','12927876000167','66437831000133') and e.payload->>'reavaliacao' is null and (e.payload->>'data_extravio')::date >= '<dia da aplicação>' and dias_uteis_entre((e.payload->>'data_extravio')::date::timestamptz, (e.created_at at time zone 'America/Sao_Paulo')::date::timestamptz)::int <> 2;` → 0 (extravio anterior à aplicação sai na primeira rodada, já passado do prazo; um 3º dia isolado só se a rodada estourou o tempo ou o SSW recusou — o operador com 2 dias teve 2 em 24).

## INV-171 — Registro em card_events só com o autor que o banco aceita (agent/operator/system)
- 2026-10-07 — NF 1115331 (CTRC PDV455099-4, UNIAO QUIMICA), relato da operadora da carteira Indústria Farmacêutica em 06/10: "erro ao lançar a 033" — o cliente tinha mandado romaneio, NFD e carta de débito. Investigação só de leitura: DUAS causas independentes, as duas nascidas em 15–17/09 (ADR 0030/0031), atrás da trava CORRETA da mig 365 (27/08: a 33 de extravio parcial só sai com dossiê completo — 35/semana caíram para 4 na semana seguinte; não desfazer). (1) O aviso "o cliente mandou em anexo?" (`confirmar-dossie-oc33`) gravava `actor_type: "human"`, e o CHECK `card_events_actor_type_check` (mig 001, 29/04) só aceita agent/operator/system: o SIM devolvia 500 ("Não foi possível confirmar") e o NÃO engolia o erro. ZERO `Oc33DossieConfirmadoPeloOperador`/`Oc33ConfirmacaoOperadorRecusada` desde a ligação (17/09 11:54); erro de servidor da função em 06/10 9h–10h e 07/10 8h–9h; a 33 da 1115331 saiu à mão no SSW (06/10 09:35) só com "REVERSAO DE PERDAS INICIADA". Mesmo defeito em `criar-card-manual` (118 cards manuais, nenhum `CardCriadoManualmente`) e na RPC do banco `liberar_card_suspeito_lockado` (mig 218, regravada na 324; a mig 233 de 22/06 corrigiu o mesmo "human" em outras RPCs e deixou esta anotada "fora de escopo"; nenhum `MudancaSuspeitaLiberadaPeloOperador` — o "Forçar atualização" chama em best-effort e a atualização seguinte limpa a marca, então só o registro se perde). (2) O robô reabria em TODA leitura os arquivos que o dossiê já cita (romaneio e valor aceitos), que tomavam as 2 vagas de PDF: a NFD (40KB, com a descrição dos itens) ficou de fora nas 2 leituras de 05/10. Corrigido com `jaAbertos` em `anexos-leitura.ts` (nunca aberto vai na frente; limites iguais). Medido: das 602 leituras desde 17/09, só 93 (27 cards) tinham corte por vaga; das 44 provas achadas em anexo, 42 na 1ª abertura e a única por releitura (NF 840881) tinha vaga sobrando. REGRA: autor em `card_events` = `operator` (operadora), `agent` (robô/edge) ou `system` — nunca "human"/"user"; falha ao gravar o registro de uma ação da operadora não pode sumir em silêncio. Prova no banco (07/10, dry-run BEGIN/ROLLBACK): 'operator' aceito, 'human' recusado com 23514; nada persistiu. Guard: bloco INV-171 da Fase 8 do `/verify-cockpit` — `codigo_fora` (actor_type literal fora da lista em `supabase/functions` e no front, testes fora) = 0; `lista_banco` = agent,operator,system (se o CHECK mudar, revisar o guard); `funcoes_banco_fora` (função do banco que grava em card_events com 'human'/'humano'/'user'/'usuario', fora da exceção conhecida) = 0; `excecao_conhecida` = `liberar_card_suspeito_lockado`, só informativa — Carlos 07/10: "por hora não vamos mexer nisso" (trocar só a palavra LIGARIA o destravamento da etapa 1 do "Forçar atualização", que nunca rodou; hoje a etapa 2 faz o trabalho e só se perde o registro de quem liberou). Provado: master de 07/10 `codigo_fora=3` (FAIL), branch PASS (0/0, exceção=1). Testes: `_shared/anexos-leitura.test.ts` (7 novos, nomes de arquivo fictícios; os 3 que provam a correção FALHAM contra a master). ADR 0030 e 0031, adendos de 07/10.

## INV-172 — Página convertida que já está pendente no mesmo to-do não gasta outra vaga do teto de anexos
- 2026-10-07 — NF 941225 (CTRC BHZ448126-7), chamado do Carlos: o modal "Lançar oc 33 (sem 44)" dava "Limite de 20 anexos enviados por você neste card" já na 1ª página, com o dossiê completo e a trava da 33 liberada (`gate_oc33.bloqueada=false`). Investigação só de leitura: as 20 vagas (`_shared/limite-anexos.ts`, INV-015) estavam ocupadas por CÓPIAS — 16 = o mesmo PDF de 4 páginas convertido e subido 4 vezes em 27/08 17:25–17:27 (dossiê ainda sem a descrição; a parede da mig 365 recusava) + 4 em 28/09 (a 3ª página já bateu no teto). Causa: os modais da oc 33 (sozinha e 33+44) sobem TODAS as páginas a cada clique em Confirmar, ANTES do `aprovar_e_executar`; a recusa desfaz a aprovação mas o upload (outra chamada) fica pendente, e o cache do modal só evitava reconverter, não re-subir. Nada limpava: `cleanup_email_anexos_orfaos` (mig 063) nunca foi agendada (mig 373) e NÃO pode ser — não filtra origem e apagaria anexo do cliente. Medido em 07/10: 124 cópias exatas em 26 cards (3 no teto: 941225, 119865, 240766). Corrigido: `upload-anexo-email` + `_shared/reaproveitar-upload.ts` — quando o front PEDE (`reaproveitar_identico=1`, só `uploadFileAsAnexo` das páginas convertidas), ANTES do teto procura anexo pendente do mesmo card + to-do + nome + tamanho, compara os BYTES e devolve o existente; qualquer dúvida sobe cópia nova como antes. Opt-in porque o modal "e-mail + oc 33" usa o mesmo to-do nos dois AnexosUploader e o executor apaga os anexos do e-mail ANTES de carregar os da 33. Teto de 20 inalterado. Mig 413 (TIPO B, dado): baixa (`deletado_em`) nas cópias exatas (mesmo eTag do Storage), mantendo a mais recente; só outbound pendente, `preservar=false` (INV-124), to-do pendente/cancelado, cópia >24h; registro em `audit_log` (não em card_events, para não mexer no relógio do card). Ensaio BEGIN/ROLLBACK 07/10: 124 cópias, 26 cards, 941225 de 20 para 6 vagas, 0 inbound e 0 preservado tocados; 2ª rodada não faz nada. Guard: bloco INV-172 da Fase 8 do `/verify-cockpit` — `reuso_antes_do_teto`=1, `opt_in`>=1, `front_pede`>=1, `outros_pedem`=0, `escopo_query`=2, `limpeza_24h_agendada`=0, `copias_info` só informativo. Provado: master de 07/10 FAIL (reuso_antes_do_teto=0), branch PASS. Testes: `_shared/reaproveitar-upload.test.ts` (13, nomes fictícios).

## INV-173 — Cliente que exige autorização antes da reentrega: oc 13 visível e robô desligado
- 2026-10-08 — Chamado CH-20261008-OBY6 (carteira AGRO/VET): VIA RURAL e J.A AGRO UBE "não autorizam emitir reentregas automáticas sem antes a operadora notificar eles via e-mail e solicitar como proceder"; pedido: toda oc 13 deles cair na fila da operadora responsável com a opção de notificar o cliente + oc 54. Investigação só de leitura (master 15d0b1c): o fluxo já existia (exceção `cliente_config_oc13`, ADR 0026/INV-148 — a PRATI já está assim desde 08/09), mas os CNPJs não estavam na lista: a oc 13 deles não passava por nenhuma das consultas do `fetchPendenciasDoCockpit` e só virava card se o cliente escrevesse. Caso âncora: NF 118031 / CTRC ACW640889-3 (VIA RURAL), extravio que virou oc 13 em 25/09 e foi para TRANSFERIDO pela reconciliação dos extravios, sem chegar à fila. Medido: os 4 CNPJs do grupo (VIA RURAL 10406295000235, 10406295000154 e 10406295000669 — o 3º sem card, incluído porque a regra é do cliente, Carlos 08/10 "autorizado inserir" — e JA 29997296000572) são da mesma operadora (219 de 219 cards em 30 dias), todos com e-mail cadastrado; a operadora não está em `acoes_autonomas_veto_operadores`; 0 oc 13 abertas no Bastão (aplicar não cria card de imediato); o único card existente com oc 13 (NF 118031, TRANSFERIDO) não é movido por nenhum passo do sync — só sai da view `v_oc13_paradas`, que ninguém lê no app. Mig 414 (TIPO B, só dado): 4 linhas `ativo=true, autonomo_ativo=false`, `ON CONFLICT DO NOTHING` + guarda DO que reprova se algum dos 4 não terminar visível e sem robô (não sobrescreve linha anterior; pede olho humano). Sem código, sem deploy. Com o robô desligado o card nasce em AGUARDANDO_VALIDACAO_HUMANA com as 5 opções da exceção (21, 54 + e-mail `LIMITACAO_CLIENTE`, 56, 41, 54 sem e-mail) e nada sai sem a operadora aprovar; a ordem das opções NÃO muda (Carlos 08/10: "deixe como está" — destacar a 54 seria código e valeria para todos os clientes da exceção). REGRA: cliente que exige ser notificado e autorizar antes da reentrega = `ativo=true` (aparece) + `autonomo_ativo=false` (robô nunca age); a regra é do cliente, então TODOS os CNPJs do grupo entram juntos. Guard: bloco INV-173 da Fase 8 do `/verify-cockpit` — check de banco `fora_da_regra` = 0 para a lista viva (PRATI 73856593001057 + 73856593000166, VIA RURAL 10406295000235 + 10406295000154 + 10406295000669, JA 29997296000572) e o agente ainda lê `autonomo_ativo !== false`; `sem_robo_sem_registro` só informativo. Provado em ensaio BEGIN/ROLLBACK (08/10, nada persistiu): sem a 414 `fora_da_regra=4` (FAIL), com a 414 = 0 (PASS); robô ligado num CNPJ = 1; linha da JA apagada = 1; PRATI com robô = 5; linha anterior com robô ligado → a guarda da 414 aborta. Cliente novo com essa regra: migration no molde da 387/414 + CNPJ no bloco INV-173 no mesmo ato.

## INV-174 — A oc 13 é medida de ponta a ponta (agente não reanalisa concluído · sugestão chega ao carimbo · indicador lê o placar)
- 2026-10-08 — Duilio relatou que "a oc 13 não está sendo medida porque os dados não estão sendo armazenados". Investigação só de leitura (master 55c1d86): os pares EXISTEM — `agente_oc13_feedback` 82 seguidas + 39 corrigidas em set/26, espelhados em `agent_feedback`/`v_placar_agente` (121 pares). Três causas independentes, cada uma provada por código e dado: (1) a view legada `v_agente_oc13_metricas` (mig 149), fonte do indicador "Acerto Agente IA oc=13", filtra `cards.cod_ultima_ocorrencia = 13` — o card sai da 13 no instante em que o operador age → 0 linhas em 7d/30d/set (144 cards analisados em 30 dias, nenhum ainda na 13); o front ainda lia colunas renomeadas na mig 158 (`*_corrigidas` → `*_erradas`), NaN mesmo com linhas. (2) o carimbo `sugestao_vigente` (mig 378) lê `aviso_alteracao_oc.proposta_destacada` e `.proposta_destacada_acao`; o agente-oc13 nunca escrevia o número e mandava acao_key NULA no ramo 21+cancelar → 22/22 aprovações pós-`sugerir_21_cancel` de setembro com carimbo `{}` (contadas no I2 como "ação sem sugestão"); mais 14/91 (54+e-mail) e 3/13 (56) vazios por banner apagado por outro processo (hipótese não confirmada). (3) o filtro `.or()` de seleção do agente tinha `and(analise_oc13_atualizado_em.lt.X)` SOLTO (precedência) desde o commit de nascimento 79cc39c (21/05): todo card concluído era reanalisado a cada 10 min até o teto de 3 → 2,6–2,8 `AgenteOc13Decisao` por card em TODOS os meses (set: 349 eventos/135 cards; 393 runs/147 cards), decisão nunca mudou (0/114), e a re-análise que FALHAVA sobrescrevia a análise boa com `erro_msg` → a RPC via erro na aprovação e não gravava o par (22 pares perdidos em set mesmo após a mig 337). Antes da mig 337 (13/08) a RPC só gravava ERRO do ramo 54+e-mail — mai–ago tinham só "corrigidas" (jun: 0 seguidas gravadas, 20 reais). Fix (branch `fix/oc13-medicao-completa`): `_shared/oc13-sugestao-aviso.ts` = fonte única do destaque (número + acao_key nos 3 ramos, `analise_oc13_resultado` do ramo 21 segue SEM acao_key pra não mudar o popup F4) e do filtro (`and(status.eq.analisando, relógio)` agrupado, igual ao agente-padrão); agente usa os dois; `IndicadorAcertoAgenteOc13.tsx` lê `v_placar_agente` filtrado por `agente-oc13-autonomo` (período + fatia 21/54/56 + abstenções; filtro por operador saiu — o placar não agrupa por operador); mig 415 (TIPO A) dropa a view legada; mig 416 (TIPO B, só dado) reconstrói o passado a partir de `card_events`: 153 pares (94 seguidas, 59 corrigidas; mai 2 · jun 45 · jul 59 · ago 21 · set 22 · out 4 — só com `AcaoExecutada sucesso=true` do mesmo to-do, só aprovação humana, só onde não há par) inseridos em `agente_oc13_feedback` com `corrigido_por_nome='retroativo mig 416 (eventos)'` e marcador `decisao_ia.retroativo`, e 39 carimbos `{}` (set 34 · out 5) preenchidos com `agente_oc`/`agente_acao_key`/`reconstruido` — o guard append-only `card_events_no_update` é desligado só dentro de um DO atômico, o UPDATE é por id a partir de temp table pré-calculada (lock de milissegundos) e uma guarda final aborta se o trigger ficar desligado. Ensaio BEGIN/ROLLBACK 08/10: INSERT 153, 39 carimbos, placar jun 29,6% / jul 49,5% / ago 67,7% / set 63,6%; 2ª rodada no mesmo ensaio = 0 inserts, 0 updates. Fora do escopo (decisão do Caio pendente, mesmo achado do agente-padrão em 06/10): dedupe da RPC por (card, oc sugerida) perde o 2º ciclo com a mesma sugestão (oc13 set: ≤5 pares); estender o popup F4 ao ramo 21. Guard: bloco INV-174 da Fase 8 do `/verify-cockpit` — código (`filtro`≥1, `solto`=0, `destaque`≥1, `front_legado`=0, `front_placar`≥1, teste `oc13-sugestao-aviso.test.ts` ok) + banco nas últimas 24h contadas a partir do último deploy do agente (`deploy_pendente --json` → `deploy_em`; sem API cai em 24h): `view_legada`=0, `eventos_por_card_24h`≤1,5, `carimbo_vazio_pos_oc13_24h`=0. APLICADO 08/10 (~15:15–15:25 BRT): PR #43 mergeado (b2e9688), agente v67 deployado, mig 416 em duas rodadas (a 1ª gravou os 153 pares e parou no DO porque o `dbq` aplica em autocommit e a temp table `ON COMMIT DROP` sumiu — trigger ficou ligado; corrigida pra temp table comum, 2ª rodada preencheu os 39 carimbos), mig 415 aplicada com `--autorizado-por` (o classificador do dbq trata DROP VIEW como TIPO B). Contraprova: 153 pares, 39 carimbos, 0 carimbo vazio pós-oc13, trigger append-only ligado, view ausente, `deploy_pendente` zerado, pulso do cron 30 s.

## INV-160 — A ponte do Roteirizador só ACRESCENTA: nunca cria card, nunca muda state, nunca bloqueia a tratativa
- 2026-09-24 — ADR 0038 (lado do Cockpit da ponte Roteirizador ↔ Cockpit; mig 417 NÃO aplicada, flags OFF). REGRA: (a) o sync `sync-roteirizador-ponte` só grava card_events `RoteirizadorAlertaRota`/`RoteirizadorContextoRota` em card ATIVO do CTRC (fora de RESOLVIDO/CANCELADO/TRANSFERIDO) — nunca `INSERT` em `cards`, nunca `update` de `state`/`cod_ultima_ocorrencia` (card nasce do Bastão ou de mensagem de cliente — INV-001/ADR 0004/INV-040); (b) idempotência pela PK `(evento_id, ctrc)` + RPC atômica `ponte_roteirizador_registrar_linha`; cursor só avança com a página inteira gravada; (c) CTRC SEMPRE do card (regra crítica do SSW vale pra ponte): consulta e compromisso recebem `card.ctrc`, nunca CTRC de busca por NF; (d) o compromisso roda DEPOIS do sucesso da oc 21, fora do envelope `lancarSswPortal`, com data só de campo estruturado (`extras.data_reentrega`) e nunca lança; (e) consulta/compromisso/sync com flag OFF ou env ausente = comportamento de hoje, byte a byte. Guard: INV-160 no `/verify-cockpit` (5 suítes deno + grep: sync não escreve em `cards`, compromisso recebe `ctrcCard`, helper não importa o envelope SSW).
- 2026-09-25 — ESCOPO (ADR 0039): vale para o sync, a consulta e o compromisso da v1. O pedido `devolver_ao_relacionamento` da ponte v2 PODE criar card (só pelo worker, só com dado do Bastão) e é regido pelo INV-175. O sync da v1 continua sem nunca criar card nem mudar state.

## INV-175 — Pedido da operação: clique de pessoa identificada, fila com vazão, SSW só pelo envelope
- 2026-09-25 — ADR 0039 (ponte v2 / Painel da Operação; migs 418/419 NÃO aplicadas, flags `ponte_operacao_leitura`/`ponte_operacao_pedidos`/`ponte_operacao_lancar_ssw` OFF). É o primeiro caminho em que o Roteirizador ORIGINA uma escrita no SSW (o Cockpit continua o único que escreve). REGRA: (a) todo pedido traz `solicitadoPor` com id e nome de PESSOA; identidade de automação (sistema/agente/bot/robô/IA/cron/roteirizador…) é 422 — pedido de agente não existe; (b) o POST `ponte-pedido-operacao` NUNCA fala com SSW nem Bastão (só banco); SSW só pelo worker `processar-pedidos-operacao` via `lancarSswPortal` (idempotência + tripé + conta de serviço), com CTRC e NF DO CARD; (c) vazão contada NO BANCO (RPC `ponte_operacao_reservar_lancamentos`: advisory lock, janela global de 60 s, 2/min pedidos, TETO 3/min no SQL, um por vez), quarentena de 30 min depois de `sessao_invalida`, FREIO DE EMERGÊNCIA (`ponte_operacao_lancar_ssw`) relido dentro do laço imediatamente antes de cada chamada ao SSW; (d) idempotência: `pedidoId` = PK, reserva atômica (no máximo 1 execução), lançamento interrompido vira `erro` e NUNCA é relançado às cegas, duplicidade (outro pedido 12 h / envelope em voo 15 min / sucesso 10 min) = recusado, dúvida = não lança; (e) lista de códigos de `lancar_ocorrencia` nasce VAZIA, só fato da rota (trigger: responsabilidade 'Operação'; CHECK sem 49/54/59), ativo exige `pedido_por` + `autorizado_por`; a 49 entra só por `devolver`; (f) card nasce de pedido só em `devolver`, só com Bastão, nunca em entregue/extravio/CNPJ excluído/NF com card ativo de outro CTRC, e passa pelo guard INV-040 com a MESMA decisão do sync (`excedeuLimiteLoopCriacao` + `LIMITE_TERMINAIS_24H` importados de `guard-anti-loop-criacao.ts`, aqui fail-closed), e nasce em AVH+lock (ou AGUARDANDO_CLIENTE para 54/59); card existente nunca muda de state por pedido; (g) `ponte-tratativas` é LEITURA PURA, por CTRC (nunca NF); (i) emendas de 25/09: auth só por `PONTE_OPERACAO_TOKEN` (o `ROTEIRIZADOR_PONTE_TOKEN` da v1 não abre a v2; sem ele, 503); `nf` do pedido é conferida contra a do card e a do Bastão (divergência = recusa) e só entra no tripé quando o card não tem NF — a NF e o CTRC do card nunca são trocados; `pedidoId` reusado com outro conteúdo = 409 sem executar; (h) flags OFF = nada do que já roda muda (snapshot da v1 + pino byte a byte de executor/envelope/sync/agentes/prompts + isolamento de imports). Guard: INV-175 no `/verify-cockpit` (5 suítes deno + grep: POST sem SSW/Bastão, worker sem cliente SSW direto, leitura sem escrita, teto 3 na RPC).
- 2026-10-07 — RENUMERAÇÃO no rebase sobre o master 178dcf8: este invariante nasceu como INV-161 na branch da ponte, mas o master já tinha o INV-161 (CCE de endereço, ADR 0035-trava-cce). Pelo mesmo motivo: ADR 0034→0038 e 0035→0039 (só os da ponte), migs 410/411/412 → 417/418/419. Nenhuma regra mudou.
- 2026-10-08 — RENUMERAÇÃO no merge do master 6c56a78: o master criou INV-173 (oc 13 VIA RURAL/JA) e INV-174 (medição da oc 13) e aplicou as migs 414/415/416 dele. Os NOSSOS INV-173..177 viraram INV-175..179 e as migs da ponte 414/415/416 viraram 417/418/419. Nenhuma regra mudou.

## INV-180 — Relacionamento e Operação não se enxergam; só o gestor vê os dois
- 2026-10-07 — ADR 0041 D2 (migs 430/431 NÃO aplicadas). Decisão do dono: "Relacionamento não precisa aparecer para a Operação, nem vice-versa". REGRA: (a) quem NÃO está em `operadores` não lê nem escreve tabela do Relacionamento — policy RESTRICTIVE `sep_somente_relacionamento` (`TO anon, authenticated`, predicado `eh_membro_relacionamento()`) em 58 tabelas, inclusive as 22 com `USING (true)` e a `cliente_config` aberta a PUBLIC; restrictive é AND, então quem está em `operadores` não perde nada; (b) `operadores` não aceita auto-cadastro (INSERT só gestor) — antes qualquer authenticated se inseria como gestor; (c) visão sem `security_invoker` e RPC SECURITY DEFINER sem checagem de pessoa não ficam abertas a authenticated (431 fechou 5 visões e 17 RPCs fora do front); (d) quem não é membro ativo da Operação nem gestor não lê `op_*` (RLS da 430; o membro só vê a unidade dele e só com `operacao_tela` ON); (e) nota com card ATIVO do Relacionamento não entra na fila da Operação (INV-182) e não pode ser lançada pela Operação (cerca na prévia, no pedido e no worker). Pendências que BLOQUEIAM ligar a `operacao_tela`: edges P1 sem checagem de `operadores` e `resolver_email_cobranca_cliente` (`docs/OPERACAO-SEPARACAO-RLS.md`). Guard: INV-180 no `/verify-cockpit` (estático da 431 + `operacao-isolamento.test.ts` + teste SQL de separação no Postgres descartável quando houver initdb/psql). Achado fora do escopo, P1: `operadores_update_self` deixa o operador virar gestor.

## INV-181 — A Operação só chega ao SSW pelo envelope dela, que compõe as peças do Relacionamento
- 2026-10-07 — ADR 0041 D8. REGRA: todo lançamento da Operação passa por `lancarSswPortalOperacao` (`_shared/lancar-ssw-portal-operacao.ts`): cercas antes de consumir a chave (código proibido; 41/56 sem texto), idempotência em `op_acoes_executadas_ssw` com `UNIQUE(op_item_id, codigo_oc, ctrc)` ANTES do SSW, decisão de relançamento = `decidirIdempotenciaRelancamento` IMPORTADA do envelope do Relacionamento (não copiada), sessão SÓ por `readSswLancamentoEnv` (INV-013), tripé CTRC + NF + localização dentro do `lancarOcorrenciaPortal` e NUNCA dispensado (sem `permitirLocalizacaoBaixada`), CTRC e NF do item (gravados do Bastão). O envelope do Relacionamento (`lancar-ssw-portal.ts`) tem ZERO diff (pino da ponte). Nem o worker nem a edge importam `ssw-internal-client` ou o envelope do Relacionamento. Guard: INV-181 + INV-013 ampliado no `/verify-cockpit`; `lancar-ssw-portal-operacao.test.ts`.

## INV-182 — A fila da Operação nasce do Bastão e nunca mostra nota do Relacionamento, finalizada ou documental
- 2026-10-07 — ADR 0041 D4. REGRA: `planejarMaterializacao` (pura) só cria item para pendência cuja responsabilidade é da Operação (hierarquia do `state_pelo_bastao`: `responsavel_atual` manda, vazio → dicionário), e NUNCA para oc 1/30/32, 2/34 ou CTRC com card ATIVO; item aberto que cai numa dessas é encerrado com motivo e o pedido na fila é cancelado. Guard anti-loop INV-040 com a MESMA decisão do sync (`excedeuLimiteLoopCriacao` + `LIMITE_TERMINAIS_24H` importados). Fechamento seguro: leitura incompleta, Bastão vazio ou mais da metade da fila sumindo de uma vez NÃO encerram nada; sem a lista de cards ativos a rodada para (fail-closed). Um item aberto por CTRC (índice único parcial). Guard: INV-182 no `/verify-cockpit`; `operacao-materializar.test.ts`.

## INV-183 — A lista de códigos da Operação nasce vazia, sem tratativa, e 41/56 só com o texto da pessoa
- 2026-10-07 — ADR 0041 D5. REGRA: `op_codigos_lancaveis` nasce VAZIA; CHECK proíbe 49/54/59/33/44/6/9/16; trigger exige responsabilidade 'Operação' no dicionário; `ativo` exige `pedido_por` + `autorizado_por` + `autorizado_em`; código entra só por migration TIPO B com `--autorizado-por` (dono: Caio). 41/56 em TRÊS camadas (como o INV-046): CHECK `exige_texto` + CHECK em `op_lancamentos` (≥ 10 caracteres), recusa na prévia/pedido (`texto_obrigatorio`), cerca do envelope antes da idempotência. A sugestão por regra nunca sugere 41/56 nem código proibido (validação da tabela). Guard: INV-183 no `/verify-cockpit`; teste SQL + `operacao-sugestao.test.ts`.

## INV-184 — A conta ai.salex é uma só: a Operação e a ponte dividem a vazão
- 2026-10-07 — ADR 0041 D7 / INV-159. REGRA: `op_reservar_lancamentos` tem TETO 3 no SQL (`least(greatest(coalesce(p_limite_por_minuto, 0), 0), 3)`), usa o MESMO advisory lock da ponte (`hashtext('ponte_operacao_ssw_vazao')`), conta na janela de 60 s as reservas da Operação E da ponte (quando `ponte_operacao_pedidos` existe), e entra em quarentena de 30 min com `sessao_invalida` de qualquer uma das duas. O worker lança UM POR VEZ e relê `operacao_lancar_ssw` imediatamente antes de cada ida ao SSW (freio). Parâmetros iguais aos da ponte (teste de paridade). Furo conhecido: a RPC da ponte ainda não conta `op_lancamentos` (dono da ponte). Guard: INV-184 no `/verify-cockpit`; `operacao-paridade-ponte-operacao.test.ts` + worker + SQL.

## INV-185 — Nada da Operação sai sem o clique de uma pessoa sobre a prévia
- 2026-10-07 — ADR 0041 D6/D7 / ADR 0033. REGRA: linha em `op_lancamentos` só nasce por `op_solicitar_lancamento`/`op_aceitar_sugestao`, com `auth.uid()` de membro ATIVO com `pode_lancar`, e com o TOKEN da prévia (`op__token`: item, CTRC, NF, oc atual, código, texto) — se qualquer coisa mudou entre a prévia e o clique, nada grava (`previa_desatualizada`). A sugestão é regra pura gravada em SOMBRA (`op_itens.sugestao`) e nunca vira lançamento sozinha; a tabela de regras nasce vazia. O worker não cria lançamento, não escolhe código e não escreve texto. Funções internas (`op__*`) e de worker não são executáveis por authenticated. Guard: INV-185 no `/verify-cockpit`; teste SQL (token errado, texto trocado, duplo clique, Relacionamento pedindo).

## INV-186 — A Operação nunca relança às cegas; confirma pela oc seguinte e só pergunta ao SSW depois de 90 min
- 2026-10-07 — ADR 0041 D7. REGRA: reservado e não terminado em 15 min → `erro` (`lancamento_interrompido`), nunca volta à fila; fila > 4 h → `erro` (expirado). Confirmação: o materializador confirma quando o Bastão mostra a oc lançada; só depois de 90 min (piso no SQL: `greatest(coalesce(p_timeout_min, 90), 90)`) o worker lê o SSW (`descobrirUltimaOcSsw`, conta de serviço, 1 por rodada, espaçadas 30 min, 3 tentativas). Resultado: `confirmado` ou `nao_confirmado` (pessoa confere) — a confirmação NUNCA relança. Vigia no health-check (`checkOperacaoFila` → `op_vigia_resumo`, INV-058): fila parada, travado, sem confirmação 6 h, não confirmado, login recusado, materializador atrasado. Guard: INV-186 no `/verify-cockpit`; worker + vigia + SQL.

## INV-187 — A Operação nasce inerte e isolada
- 2026-10-07 — ADR 0041 D9. REGRA: flags `operacao_fila`/`operacao_tela`/`operacao_lancar_ssw` nascem OFF (smoke da 430 aborta se não); lista de códigos, regras de unidade e membros nascem vazios; crons SÓ nas migs 432/433 (separadas, aplicadas na hora de ligar); nenhuma função do Relacionamento importa código da Operação (só o health-check, e só o vigia puro); as edges novas exigem service_role por capacidade (`ehServiceRoleOperacao` → `op_vigia_resumo`); a 430 não altera tabela existente; a 431 só acrescenta policy RESTRICTIVE e REVOKE. Guard: INV-187 no `/verify-cockpit`; `operacao-isolamento.test.ts` + pino da ponte (envelope, cliente SSW, tripé, bastao-client byte a byte).

## INV-188 — Sugestão da Operação: regra primeiro, agente só quando nenhuma regra casa, e nunca lança
- 2026-10-07 — ADR 0041 D10 (migs 434/435/437 NÃO aplicadas). Requisito do dono: "o agente precisa sugerir a ocorrência quando não for regra fixa específica". REGRA: três camadas, a primeira que responde decide — (0) regra fixa no código (`REGRAS_SUGESTAO_OPERACAO`, vazia), (1) regra APRENDIDA (`op_regras_sugestao`, nasce vazia; só decide com confiança ≥ 0,6 e casos ≥ 5; carga por migration TIPO B gerada de regras.json validado por `validarRegrasAprendidas`), (2) AGENTE DE IA (`operacao-agente-sugestao.ts`, prompt versionado `prompts/agente-operacao.md`, Haiku 5.5 por padrão — decisão do dono 07/10 —, override `OPERACAO_AGENTE_MODELO` em lista fechada: haiku-5-5, haiku-4-5, sonnet-4-6, opus-4-7). O agente: UMA chamada (`complete`, nunca `completeJson`), timeout 15 s, saída validada — JSON inválido/cortado, código proibido (49/54/59/33/44/6/9/16), 41/56, código fora da responsabilidade 'Operação', a própria oc, texto > 70 ou confiança fora de 0..1 → DESCARTADO; falha/timeout → sem sugestão; nada bloqueia a fila. Custo: só item novo ou com oc nova — cache `op_sugestao_ia_cache` por (op_item_id, oc), inclusive para falha; teto de 10 chamadas e 90 s por rodada; flag `operacao_sugestao_ia` OFF. O banco revalida o contrato (`op__sugestao_valida`) e só grava em item aberto, na mesma oc e sem sugestão de regra. A sugestão do agente sobrevive à reescrita do item na mesma oc e some quando a oc muda. Aceitar continua sendo prévia + clique (INV-185). Evals: `evals/agente-operacao.ts` (seco = sem API; ao vivo só com `ANTHROPIC_API_KEY_EVALS`, INV-167). Guard: INV-188 no `/verify-cockpit`; `operacao-agente-sugestao.test.ts` (fetch falso), `operacao-sugerir-ia.test.ts`, `operacao-sugestao.test.ts`, `evals/agente-operacao.test.ts`, teste SQL.

## INV-189 — Encaminhar ao Relacionamento = card primeiro (pedido devolver da ponte), 49 depois; a Operação nunca vê o card
- 2026-10-07 — ADR 0041 D11 (mig 436 NÃO aplicada; depende da 418). Requisito do dono: "se for de relacionamento, ele já deve encaminhar pro cockpit de relacionamento". REGRA: encaminhar NUNCA é "lançar a 49 e esperar o sync-bastao criar o card" — com card encerrado no CTRC, a 49 da `ai.salex` cai em `decidirVisibilidadePorSsw` como ação do próprio Cockpit (MANTER_FORA, fonte identidade) e a tratativa some (travado em `operacao-encaminhar.test.ts`). O encaminhamento vira pedido `devolver_ao_relacionamento` da ponte (`origem = 'cockpit_operacao'`): o worker cria o card do Bastão em AGUARDANDO_VALIDACAO_HUMANA + lock (`decidirNascimentoCard`, INV-040, extravio/CNPJ/entregue barrados) e só então lança a 49 pelo envelope do Relacionamento. Padrão = 1 clique (`op_previa_encaminhamento` + `op_encaminhar_relacionamento` com token). Flag `operacao_encaminhar_auto` (OFF): agenda sozinho só sugestão de encaminhamento com confiança ≥ limiar (piso 0,8) em item NÃO assumido, com evento `EncaminhamentoAgendado`, janela de desfazer (piso 10 min, `op_desfazer_encaminhamento` enquanto agendado) e sem insistir na mesma oc depois de desfeito; na hora de enviar relê a cerca e cancela se a oc mudou. Nada é enviado com `ponte_operacao_pedidos` OFF. Depois de enviado, o item fecha com o evento "encaminhada ao Relacionamento às HH:MM" e o materializador não o traz de volta enquanto o pedido não termina; nenhuma RPC/tabela legível pela Operação devolve o card. Guard: INV-189 no `/verify-cockpit`; `operacao-encaminhar.test.ts` + `operacao-sugestao-encaminhar.test.sql`.
- 2026-10-07 — EMENDA (ADR 0041 D12, mig 438; o INV-189 já era desta frente, por isso a emenda e não um número novo). Decisão do dono: nada vai ao Relacionamento real por enquanto. REGRA: `operacao_encaminhar_modo` (em `op_config`, não em `feature_flags`) nasce `'espelho'` e `op_encaminhar_modo()` devolve `'espelho'` para linha ausente ou valor inválido; `'real'` só por migration TIPO B (CHECK exige `autorizado_por`, `autorizado_em`, `motivo`; nem gestor nem service_role escrevem em `op_config`). Em espelho, `op__promover_encaminhamento` desvia ANTES de qualquer insert em `ponte_operacao_pedidos`: grava `op_relacionamento_espelho` (o que o card teria, incl. texto da 49 e state previsto), fecha o item com `encaminhado_espelho` + evento "encaminhada ao espelho do Relacionamento às HH:MM", e não depende da flag da ponte. O espelho só é lido por gestor e `supervisor_op` (RLS + `op_espelho_relacionamento_listar`/`_avaliar`); nenhuma view/função fora de `op_*` o cita. O materializador não traz de volta, na mesma oc, a nota que foi ao espelho. Guard: INV-189 no `/verify-cockpit` (bloco espelho); `operacao-espelho.test.sql` (cards/card_events/todos/ponte idênticos com a flag da ponte LIGADA; Relacionamento e operador_op não leem) + `operacao-encaminhar.test.ts` (supabase falso que falha em escrita na ponte/cards).
- 2026-10-07 — EMENDA do INV-188 (treino real W5; mig 439; prompt 1.1.0). REGRA: a sugestão pode ser `aguardar` (sem código, nunca lançável, com motivo e `reavaliar_em_horas` 1..720; `op_aceitar_sugestao` recusa com `sugestao_e_aguardar`; reavaliação do agente ≤ 3 por item + oc). 01 nunca é sugerida (`OCS_NUNCA_SUGERIR` no TS; CHECK de `op_regras_sugestao`; `op__sugestao_valida`). Encaminhar só para passagem de bastão real (prompt). Estado da regra aprendida: `instrucao_padrao` por igualdade normalizada (maiúsculas, sem acento, espaços colapsados) e `pagador_cnpj` (só dígitos); especificidade pagador 8 > instrução 4 > unidade 2 > dias 1. Modelo: Opus 5.5 custou US$ 3,93/446 chamadas e acertou 17% contra 24% do histórico — o dono escolheu o Haiku 5.5 como padrão (07/10); medir contra o histórico antes de ligar. Guard: INV-188 no `/verify-cockpit` (bloco 439); `operacao-aguardar.test.sql`, `operacao-sugestao.test.ts`, `operacao-agente-sugestao.test.ts`, `evals/agente-operacao.test.ts`.
- 2026-10-07 — EMENDA do INV-188 (minerador do v3; mig 440, da faixa 440–449 da Operação). REGRA: `estado.instrucao_modelo` = `modeloDaInstrucao(texto)` (normalizar → `/[A-Z0-9]*[0-9][A-Z0-9]*/g` → `#` → colapsar espaços), casada por igualdade, exclusiva com `instrucao_padrao`; o minerador usa a MESMA função exportada. Especificidade: pagador 32 > instrução exata 16 > modelo 8 > unidade 4 > +1 por condição extra (`dias_parado_min`, `previsao_vencida`, `ocorrencias_anteriores_min`). Condição sem o dado do item não casa (conservador). `alternativa` só em `aguardar`, validada no TS, no CHECK e no trigger, e copiada para a sugestão. Guard: `operacao-sugestao.test.ts` (exemplos reais da regex, regex literal travada) + `operacao-regras-modelo.test.sql`.

## INV-176 — Baixa do motorista: sem card, o CTRC vem da BAIXA e só vai ao SSW com o tripé
- 2026-10-07 — ADR 0040 (ponte v3 / baixa do motorista; migs 420/421 NÃO aplicadas, flags `baixa_motorista_receber`/`baixa_motorista_lancar_ssw` OFF). É a ÚNICA exceção à regra "o CTRC correto é SEMPRE o do card": a baixa não tem card. REGRA: (a) o CTRC e a NF vêm da baixa (romaneio do Roteirizador) e NUNCA de busca por NF; o detalhe é buscado COM o CTRC da baixa (`buscarNFInterno(..., {ctrcEsperado})`) e divergência é recusa, nunca "outro CTRC"; (b) o tripé CTRC + NF + Localização atual (`validarTripeCtrcNfPagador`) roda ANTES do submit nos DOIS canais (portal101: callback do act=O; webapi: tela do CTRC, fail-closed se o layout não casar); (c) SSW só pelo envelope `lancarSswBaixa`, chamado só pelo worker `processar-baixas-motorista`; o POST `ponte-baixa-entrega` nunca fala com SSW, Bastão nem Roteirizador; (d) a baixa não escreve em `cards`/`card_events` e nenhuma função existente importa o código dela (só o health-check importa o vigia puro); (e) contrato: 202/200/409/422/503/401, `baixaId` = PK, mesmo id com outro conteúdo = 409 sem executar. Guard: INV-176 no `/verify-cockpit` (grep + 3 suítes deno, incluindo isolamento).

## INV-177 — Fila da baixa: vazão no banco, quarentena, freio, verdade do SSW antes de gravar, nunca relança
- 2026-10-07 — ADR 0040. REGRA: (a) vazão contada NO BANCO (`baixa_motorista_reservar`: advisory lock próprio, janela global de 60 s, 2/min, TETO 3 no SQL) com os MESMOS parâmetros da ponte v2 (importados de `ponte-operacao-worker.ts`, não copiados); (b) quarentena de 30 min depois de login recusado (`ultima_categoria='sessao_invalida'`), a baixa volta à fila sem gastar tentativa (INV-159 d); (c) freio `baixa_motorista_lancar_ssw` relido dentro do laço imediatamente antes de cada ida ao SSW; OFF = as baixas ESPERAM (não são descartadas); (d) antes de gravar o envelope lê as ocorrências do CTRC (`descobrirUltimaOcSsw`, mesma sessão): a 01 já lá = `ja_no_ssw` sem gravar; insucesso em nota entregue/encerrada = recusado; (e) reserva atômica (no máximo 1 execução por baixa); falha ANTES do submit volta à fila (3 tentativas); o SSW recusou o submit ou caiu NO MEIO = `erro`, NUNCA relançado; `lancando` > 15 min = `erro` "conferir no SSW"; (f) insucesso antes de entrega na reserva; prazo = fim do dia seguinte ao ocorrido (São Paulo); (g) evidência baixada do Roteirizador e conferida (sha256 + mime + assinatura) ANTES do SSW — divergiu, recusado; (h) vigia no health-check (`checkFilaBaixasMotorista`, INV-058). Guard: INV-177 no `/verify-cockpit`.

## INV-178 — Hora real na ocorrência, nunca futura, e sem mudar o lançamento do Relacionamento
- 2026-10-07 — ADR 0040. `lancarOcorrenciaPortal` ganhou `dataHoraEvento?: Date` (f4/f5): limitada a agora − 2 min; data inválida = nada enviado. SEM o parâmetro o submit é byte a byte o de antes (provado contra o arquivo base em 8 cenários na construção; travado por `ssw-internal-client-data-hora-evento.test.ts` + `segregacao-ctrc-submit.test.ts`). Na WebAPI, `dataHoraEvento` no formato `yyyy-mm-ddThh:mm:ss:mmm-03:00`, com o mesmo limite. Guard: INV-178.

## INV-179 — A baixa nasce inerte e com dono; insucesso só da Operação
- 2026-10-07 — ADR 0040. Mig 420: flags OFF; `baixa_motorista_config.canal` NULL (mudar exige `autorizado_por`/`autorizado_em`, CHECK); lista fechada de insucesso `baixa_motorista_codigos` VAZIA, nunca 01/49/54/59, trigger exige responsabilidade 'Operação' no `ocorrencias_dicionario`; piloto `baixa_motorista_piloto` VAZIO; ativo exige quem pediu + quem autorizou. A 01 da entrega é implícita (nunca entra na lista). MOTIVO do "só Operação": oc de Relacionamento lançada pela `ai.salex` é lida por `decidirVisibilidadePorSsw` como ação do próprio Cockpit (MANTER_FORA) e a tratativa ficaria invisível ao operador. Guard: INV-179.

## INV-191 — O registro do dossiê guarda o que o robô leu × o que a prova aceitou
- 2026-10-09 — Chamado CH-20261007-B8VZ, NF 387252 (CTRC APO608437-1, SOMA MG). O cliente mandou o romaneio em anexo e, no CORPO do e-mail, a descrição do item e o valor. O interpretador escreveu no motivo "as 3 evidências estão presentes", mas o dossiê gravou só romaneio e valor, e a 33 ficou travada por "descrição dos itens". Investigação só de leitura: o corpo salvo estava limpo e nenhum código apaga a descrição entre o modelo e `montarEvidenciasRecebidas` — sobram (a) o modelo omitiu a chave ou (b) copiou com outras palavras e a prova literal (`corpoContemTrecho`) recusou. Qual dos dois = HIPÓTESE NÃO CONFIRMADA: `DossieExtravioAtualizado` só guardava `Object.keys(recebidas)` e a resposta do modelo não ficava em lugar nenhum. 30 dias: 7 cards com o motivo dizendo "mandou descrição no corpo" e o dossiê sem ela; em 2 a 33 foi lançada direto no SSW. REGRA: o evento `DossieExtravioAtualizado` leva `diagnostico_evidencias` — por evidência, o que o modelo devolveu (texto cortado em 200) e FATOS medidos com as MESMAS funções da prova: `trecho_no_corpo`, `palavras_no_corpo` (achadas/total — separa "reescreveu" de "inventou"), `anexo_casou`, `aceita`, além de `modelo_devolveu_bloco` e `corpo_chars`. O módulo (`_shared/diagnostico-evidencias-dossie.ts`) é puro e SÓ OBSERVA: quem decide continua sendo `montarEvidenciasRecebidas`, com o mesmo objeto de opções (`optsProvaEvidencias`); o cálculo roda em try/catch e falha vira `{erro}` no campo, nunca derruba a leitura. `extravio-parcial-dossie.ts` NÃO mudou (mexer nele pediria 17 funções no deploy). Sem custo de IA (nenhuma chamada nova). Como usar: no próximo caso, `select payload->'diagnostico_evidencias'->'descricao' from card_events where event_type='DossieExtravioAtualizado' and card_id=...`. Guard: `diagnostico-evidencias-dossie.test.ts` (11 casos, dados fictícios; o de fiação FALHA contra a master) + bloco INV-191 do `/verify-cockpit` (master: evento=0 → FAIL).
