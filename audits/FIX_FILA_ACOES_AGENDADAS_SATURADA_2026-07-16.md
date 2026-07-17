# FIX — Fila `acoes_agendadas` saturada: cancelamentos de reentrega parados

- **Data do diagnóstico:** 2026-07-16 (investigação read-only em produção)
- **Status:** DIAGNÓSTICO FECHADO ✅ · Fix implementado no repo em 2026-07-17 (ver adendo no fim) · **Migrations AINDA NÃO aplicadas em prod** ⏳
- **Sintoma reportado:** "várias reentregas não foram canceladas conforme agendamento"
- **Regra aplicada:** Diagnóstico antes de correção (CLAUDE.md)
- **Memória:** `project-fila-acoes-agendadas-saturada.md`

---

## 1. Resumo executivo

A automação de cancelamento de reentrega **nunca parou de rodar** — ela roda a cada
15 minutos e responde OK. O que aconteceu é **inanição de fila** (head-of-line
blocking): a cada rodada, a função `processar-acoes-agendadas` pega só as **200
pendências vencidas mais antigas**, e as 200 vagas estão 100% ocupadas por
**cobranças de e-mail que falham para sempre** ("cliente sem e-mail cadastrado") e
nunca saem da frente da fila. Os 15 cancelamentos de reentrega vencidos estão nas
posições **203–225** — a função nunca chega neles. O botão **"Forçar agora" também
está inutilizado**, porque recoloca a ação na fila com hora = agora, ou seja, atrás
das 200.

Ironia central: **esse mesmo entupimento já aconteceu em maio** e foi "resolvido"
pela mig 168 (26/05) — que desligou só **um** dos criadores de cobrança (o cron) e
cancelou as presas da época. O `executor` e o `enviar-resposta` continuaram criando
uma cobrança agendada (+4 dias) **a cada e-mail enviado ao cliente**. A fila
recresceu em silêncio por 7 semanas até cruzar o teto de 200 em ~11–12/07.

---

## 2. Sintoma observado

| O quê | Evidência |
|---|---|
| 15 cancelamentos de reentrega vencidos, parados, **zero tentativas** | `acoes_agendadas` ids 2245, 2278, 2282, 2298, 2331, 2342, 2369, 2370, 2379, 2380, 2384, 2386, 2388, 2415, 2244 — o mais antigo venceu **14/07 17:32 BRT** (NF 687166) |
| Vazão colapsou | Eventos `ReentregaCanceladaAutomaticamente`/dia: até 11/07 fluxo normal (1–34/dia); **12–14/07 = zero**; 15–16/07 = 1/dia |
| "Forçar agora" não funciona | Ação 2244 (NF 687187): operador forçou 16/07 **14:35 BRT** (`payload.forcado_em`), seguiu `pendente` com `tentativas=0` |

## 3. Comportamento esperado

24h após lançar oc=21 com o checkbox `cancelar_reentrega_24h`, o robô localiza o
CT-e complementar (opção 101), cancela via opção 450 e marca a ação como
`processado` — com atraso máximo de ~15 min (cadência definida na mig 163).

---

## 4. Evidências verificadas (produção, 16/07)

Todas as consultas abaixo foram rodadas em produção, somente leitura.

### 4.1 O agendador está saudável (não é o cron)

```
cron.job jobid=7 'processar-acoes-agendadas-daily' schedule='9-59/15 * * * *' active=t
cron.job_run_details: 730 execuções 09/07→16/07, TODAS 'succeeded'
```

### 4.2 A função roda e reporta o problema ela mesma

Corpos de resposta capturados em `net._http_response` (várias rodadas de 16/07):

```json
{ "pendentes_encontrados": 200, "processados": 0, "erros": [ ...200 itens... ] }
```

Os **200 erros são todos** `"Sem contato email pra <CLIENTE> — adiado"` (tipo
`cobranca_email`). Nenhuma menção a `cancelar_reentrega_ssw` — a função **nem vê**
essas ações.

### 4.3 Réplica exata da consulta da função (prova direta)

A função monta: `status=eq.pendente & executar_em=lte.now() & order=executar_em.asc
& limit=200` (`processar-acoes-agendadas/index.ts:54-60`). Replicado via PostgREST
com service role (leitura pura):

```
total linhas retornadas: 200
por tipo: {'cobranca_email': 200}
tem algum cancelar_reentrega_ssw? False
```

### 4.4 A fila real e as posições

```sql
-- 225 pendências vencidas no total; janela = 200 primeiras
-- posições dos cancelamentos de reentrega: 203, 212, 213, ..., 225
```

| Posição | Ação | Tipo | Venceu (BRT) |
|---|---|---|---|
| 1–202 (menos 8) | — | `cobranca_email` | 30/05 11:17 → 14/07 16:13 |
| **203** | 2245 | `cancelar_reentrega_ssw` | 14/07 17:32 |
| 212–224 | 2278…2415 | `cancelar_reentrega_ssw` | 15/07 → 16/07 |
| 225 | 2244 | `cancelar_reentrega_ssw` | 16/07 14:35 (resetada pelo Forçar agora) |

### 4.5 Por que as cobranças nunca saem da frente

O handler de `cobranca_email` **lançava exceção** quando o cliente não tem e-mail em
`contatos_cliente` (ou template inativo) e a ação **permanecia `pendente` com o
MESMO `executar_em`** (`processar-acoes-agendadas/index.ts:160` e `:185` no código
antigo). Diferente do handler de `cancelar_reentrega_ssw`, que reagenda +24h com
teto de 3 tentativas e estados terminais.

Acúmulo: **405 cobranças pendentes** (1 de maio + 80 de junho + 324 de julho; 115
criadas só nos últimos 2 dias). 210 já vencidas.

### 4.6 Quem cria as cobranças (a mig 168 não fechou todas as portas)

A mig 168 desligou o cron `cobranca-cliente-aguardando-daily` e cancelou as 34
presas da época. Mas **4 portas continuaram criando**:

| Porta | Onde | Como |
|---|---|---|
| Executor, e-mail enviado pelo Cockpit (inline) | `executor/index.ts:1290` | RPC `agendar_cobranca_email` D+4 |
| Executor, e-mail marcado como enviado manual (Gmail) | `executor/index.ts:1310` | RPC `agendar_cobranca_email` D+4 |
| Executor, relançamento de oc=54 | `executor/index.ts:1330` | **INSERT direto** em `acoes_agendadas` (não passa pelo RPC!) |
| enviar-resposta (2 paths) | `enviar-resposta/index.ts:280` e `:455` | RPC `agendar_cobranca_email` D+4 |

### 4.7 Efeito colateral em curso: spam de eventos

Cada rodada grava 1 evento `CobrancaAdiadaSemContato` **por cobrança presa** em
`card_events`: **~19.100/dia** desde 12/07 (200 falhas × 96 rodadas/dia). O spam
existe desde pelo menos 06/06 (7–9 mil/dia) — exatamente o desperdício de disco/IO
que motivou as migs 163 e 168.

### 4.8 Linha do tempo

```
26/05  mig 168 "desativa" cobrança automática (só o cron; 34 presas canceladas)
30/05  primeira cobrança da leva atual fica presa (vencida, sem e-mail)
jun    fila presa cresce ~2-3/dia (spam de eventos: 7-9k/dia)
10/07  fila vencida ≈ 40-90 → eventos 3,9k/dia (dado parcial do dia)
11-12/07  fila vencida CRUZA 200 → saturação total (eventos = 19,1k/dia ≈ 200×96)
12-14/07  vazão de cancelamentos automáticos = ZERO
14/07 17:32  vence a ação 2245 (NF 687166) — 1ª starved da lista atual
15-16/07  só 1 cancelamento/dia "vaza" (fila oscila na borda do teto)
16/07 14:35  operador clica "Forçar agora" na 2244 → nada acontece
```

### 4.9 Separação fato / inferência / hipótese

- **Fato verificado:** tudo em 4.1–4.7 (queries em produção + código lido).
- **Inferência:** a data da saturação (~11–12/07), deduzida do volume de eventos
  (19.170/dia = teto exato) e do colapso da vazão a partir de 12/07.
- **Hipótese (não confirmada, não bloqueia o fix):** os 2 cancelamentos que
  "vazaram" em 15 e 16/07 passaram porque cobranças obsoletas foram drenadas
  (card saiu de AGUARDANDO_CLIENTE → marcada `processado`), abrindo vaga
  momentânea abaixo do teto.

---

## 5. Causa raiz confirmada

**Inanição de fila por pendências eternas.** Duas condições somadas:

- **(A) Desenho do handler de cobrança:** ação que falha permanece `pendente` com
  `executar_em` imutável → fica para sempre **na frente** da fila ordenada por
  `executar_em ASC LIMIT 200`, roubando vaga de tudo que vence depois.
- **(B) Fonte aberta:** a "desativação" da mig 168 deixou 4 portas criando
  cobranças novas todo dia; a maioria falha para sempre (cliente sem e-mail em
  `contatos_cliente`), alimentando (A) até estourar o teto.

Dois sintomas (reentregas não canceladas + Forçar agora inútil), **uma causa só**.

---

## 6. Fix (implementado 2026-07-17 — ver adendo pro estado de deploy)

### Fase 0 — Destravamento imediato (migration de dados) 🔴 urgente

`migration/2026-07-17_297_destravar_fila_acoes_agendadas.sql` — cancelamento
administrativo de **todas** as `cobranca_email` pendentes (vencidas E futuras) com
evento `CobrancaAutomaticaCancelada` por card. Nunca recriar as canceladas.

**Efeito retroativo automático:** na rodada seguinte (≤15 min) os 15 cancelamentos
de reentrega vencidos entram na janela e rodam sozinhos (guards normais valem).

### Fase 1 — Raiz A: nenhuma pendência pode ser eterna (código)

`processarCobrancaEmail` controla o próprio status e **nunca** deixa a ação
`pendente` com `executar_em` no passado. Decisor puro em
`_shared/fila-acoes-agendadas.ts`: falha → reagenda +24h com `payload.tentativas++`;
teto de **5** tentativas → `precisa_acao`; evento `CobrancaAdiadaSem*` **só na 1ª
falha** (corta os ~19 mil eventos/dia).

> **INV-fila (= INV-039):** toda ação em `acoes_agendadas` que falha OU avança
> `executar_em` para o futuro OU muda para estado ≠ `pendente`. Proibido falhar
> e manter `executar_em` no passado.

### Fase 2 — Raiz B: fechar a fonte (código + flag) — **decisão de produto**

`migration/2026-07-17_298_flag_cobranca_automatica_rpc_choke.sql`:

1. Flag `cobranca_automatica_enabled` em `feature_flags`, **OFF**.
2. RPC `agendar_cobranca_email` é o choke point: flag OFF → no-op logado (cobre
   executor:1290/:1310 e enviar-resposta:280/:455); flag ON → **valida e-mail
   antes de agendar** (`resolver_email_cobranca_cliente` null → não cria a ação,
   grava `CobrancaNaoAgendadaSemContato`).
3. INSERT direto do executor (`relancamento_54`) convertido pro RPC
   (novo param `p_origem`).

**Decisão que só o Caio pode tomar:** manter cobrança desligada × reativar
(ligar a flag). O fix técnico suporta os dois.

### Fase 3 — Guards anti-regressão (convenção inegociável nº 8)

1. Alerta de saúde da fila no `audit-invariante` (vencidas ≥150 ou mais velha >2h
   → alert `fila_acoes_agendadas_saturada`, cooldown 6h).
2. INV-039 / INV-039b no `/verify-cockpit` (código + SQL de saúde da fila).
3. Teste `_shared/fila-acoes-agendadas.test.ts` (deno test) — falha nunca devolve
   "manter pendente onde está".
4. INV-039 no catálogo `docs/INVARIANTES_COCKPIT.md` + lookup do hook
   `cockpit-critical-files.py`.

### Fase 4 — Higiene

- Evento só na 1ª falha (Fase 1) → corta ~19 mil eventos/dia.
- Arquivamento dos eventos de spam já gravados: **decisão do Caio** (event
  sourcing é convenção nº 1) — não feito.

---

## 7. Ordem de deploy e cuidados

1. **Fase 0 primeiro e sozinha** (migration 297, sem deploy de código) —
   destrava produção em ≤15 min.
2. Migration 298 + deploy de código (executor + processar-acoes-agendadas +
   audit-invariante) **no mesmo passo** — o executor chama o RPC com `p_origem`,
   que só existe na 298.
3. **Árvore limpa obrigatória** no deploy (lição da regressão v130 / BOOT_ERROR
   sync-bastao); rodar boot-gate do `/verify-cockpit`.
4. ⚠️ Prod recebeu migs 292–296 (14-15/07, repo antigo) que NÃO estão neste repo.
   **Conferir numeração livre (297/298) e diff do executor contra produção antes
   de deployar** (`supabase functions download` se precisar).

## 8. Checklist de fechamento (regra "bug em produção")

| Item | Precisa? | Como |
|---|---|---|
| Retroativo | ✅ | Fase 0 destrava; as 15 rodam sozinhas. Conferir resultado individual depois |
| Teste anti-regressão | ✅ | `_shared/fila-acoes-agendadas.test.ts` |
| Migration | ✅ | 297 (dados) + 298 (flag + RPC) |
| Evento em `card_events` | ✅ | `CobrancaAutomaticaCancelada` por ação cancelada (297) |
| Memória / ADR | ✅ | Memória `project-fila-acoes-agendadas-saturada` (2026-07-17). ADR não necessário |
| Item `/verify-cockpit` | ✅ | INV-039 / INV-039b |

## 9. Riscos / blast radius

- **Fase 0:** mata de vez os lembretes de cobrança agendados — na prática já não
  funcionam. Reversível por decisão de produto (ligar a flag), nunca recriando as
  canceladas (regra da mig 168).
- **Destravamento:** as 15 ações vão chamar o SSW de verdade. Risco baixo: o
  handler valida tudo (filtro "nunca cancelar o CT-e NORMAL", já-cancelada →
  tratado, falha definitiva → precisa_acao, teto de 3 tentativas).
- **Fases 1–2:** mexem no executor (função crítica) → verify + deploy limpo.
  Blast radius restrito aos fluxos de cobrança e ao handler de ações agendadas;
  nada de tripé/lançamento SSW é tocado.

## 10. Como validar

```sql
-- 1. Janela voltou a enxergar os cancelamentos? (rodar logo após Fase 0)
SELECT tipo, count(*) FROM (
  SELECT tipo FROM acoes_agendadas
  WHERE status='pendente' AND executar_em <= now()
  ORDER BY executar_em ASC LIMIT 200) s GROUP BY tipo;
-- esperado: cancelar_reentrega_ssw presente; cobranca_email = 0

-- 2. As 15 saíram de pendente? (rodar ~30 min após Fase 0)
SELECT id, status, (payload->>'nf') AS nf,
       processed_at AT TIME ZONE 'America/Sao_Paulo' AS processada_brt
FROM acoes_agendadas
WHERE id IN (2245,2278,2282,2298,2331,2342,2369,2370,2379,2380,2384,2386,2388,2415,2244);
-- esperado: nenhum 'pendente' vencido

-- 3. Vazão voltou? (dias seguintes)
SELECT date_trunc('day', created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia, count(*)
FROM card_events WHERE event_type='ReentregaCanceladaAutomaticamente'
  AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1;

-- 4. Spam cessou?
SELECT count(*) FROM card_events
WHERE event_type IN ('CobrancaAdiadaSemContato','CobrancaAdiadaSemTemplate')
  AND created_at > now() - interval '1 hour';
-- esperado: 0

-- 5. Resumo da função saudável (net._http_response, última rodada)
-- esperado: pendentes_encontrados < 50, erros = []
```

## 11. Casos âncora e referências

- **NF 687166** (ação 2245) — 1ª starved, venceu 14/07 17:32 BRT.
- **NF 687187** (ação 2244) — "Forçar agora" 16/07 14:35 BRT ignorado pela saturação.
- **NF 806554 / DUILIO** — caso âncora anterior do handler (cenário "já cancelada").
- Migrations históricas: 035/036 (feature de cobrança), 105/107/108 (cancelamento
  reentrega + RPC Forçar agora), 142→159→163 (cadência do cron), **168 (1º
  entupimento — fix parcial que originou este)**, **297/298 (este fix)**.
- Docs: `docs/AUTOMACAO_COBRANCA.md` (estado da feature de cobrança).

---

## Adendo — Implementação (2026-07-17)

Implementado na branch `worktree-fix-fila-acoes-agendadas` (PR draft). Arquivos:

- `migration/2026-07-17_297_destravar_fila_acoes_agendadas.sql` (Fase 0 — **não aplicada**)
- `migration/2026-07-17_298_flag_cobranca_automatica_rpc_choke.sql` (Fase 2 — **não aplicada**)
- `supabase/functions/_shared/fila-acoes-agendadas.ts` + `.test.ts` (Fase 1 + guard)
- `supabase/functions/processar-acoes-agendadas/index.ts` (handler INV-fila)
- `supabase/functions/executor/index.ts` (INSERT direto → RPC, path relancamento_54)
- `supabase/functions/audit-invariante/index.ts` (alerta de saúde da fila)
- `.claude/commands/verify-cockpit.md` (INV-039/039b) · `docs/INVARIANTES_COCKPIT.md` · `.claude/hooks/cockpit-critical-files.py`

Aplicação em prod (migs + deploy das 3 functions) aguarda o go do Caio — ver §7.

### Revisão 2026-07-17 (pré-merge) — 10 achados corrigidos

Code review multi-agente (26 agentes, verificação adversarial) achou 10 defeitos;
todos corrigidos no mesmo dia na branch:

1. `marcar_retorno_inconclusivo` (mig 041) era a **5ª porta** — INSERT direto de
   cobranca_email pelo front. Reescrito na mig 298 pra usar o choke point.
2. `try/catch` do `supabase.rpc()` no executor era código morto (rpc devolve
   `{error}`, não lança) — 3 paths agora checam `{error}`.
3. Evento `Relancamento54Executado` afirmava reagendamento incondicional —
   payload agora reflete o retorno real do RPC (`cobranca_agendada` etc.).
4. Terminal `precisa_acao` era INVISÍVEL pra cobranca_email (consumidores
   filtram cancelar_reentrega_ssw) — trocado por `cancelado` + alert
   `cobranca_falha_definitiva` em `alerts`.
5. UPDATEs do handler ignoravam `{error}` — agora lançam (visível em
   summary.erros) em vez de falhar silencioso.
6. Paths de exceção (SELECT card / INSERT todo) violavam INV-fila — catch do
   loop faz best-effort de reagendamento/encerramento via o mesmo decisor.
7. Summary mascarava falha como processado — agora separa `processados`,
   `cobrancas_reagendadas`, `cobrancas_falha_definitiva`.
8. Validação de e-mail SÓ no agendamento matava a recuperação pós-cadastro de
   contato — RPC (flag ON) agenda sempre com marcador `sem_contato_no_agendamento`;
   a execução retenta com teto (decisão de implementação — Caio pode reverter
   pra recusa no agendamento se preferir).
9. `REVOKE ALL ... FROM PUBLIC, anon, authenticated` no RPC SECURITY DEFINER
   (EXECUTE default de PUBLIC tornava o GRANT cosmético).
10. Guard `.eq('status','pendente')` nos UPDATEs (não ressuscitar ação
    cancelada concorrentemente pelo vinculador).

### Revisão 2026-07-17 — 2ª rodada (sobre os fixes da 1ª)

Mais 10 achados reportados; corrigidos:

1. Best-effort do catch distingue falha pós-sucesso: `marcarCobrancaProcessada`
   lança com prefixo `[pos-sucesso]` e o catch NÃO reagenda (evita todo
   duplicado; próxima rodada marca via path obsoleto — self-healing).
2. UPDATEs guardados usam `.select("id")` — 0 linhas (cancelamento concorrente)
   → retorna `encerrada_concorrente` sem gravar evento/alerta falsos.
3. Inserts de `card_events`/`alerts` checam `{error}`; evento da 1ª falha tem
   flag `evento_primeira_falha_registrado` no payload (re-tenta se o insert
   falhou transiente).
4. Paths de exceção contam em `cobrancas_reagendadas`/`cobrancas_falha_definitiva`.
5. Dedup no RPC: 1 cobrança pendente por card (devolve a existente).
6. `p_origem` também nos paths inline/manual do executor (forense completa).
7. Grep do INV-039 virou co-ocorrência por arquivo (imune a chaining multi-linha).
8. Query de saúde da fila usa `count exact head:true` + 1 linha (era 1000 linhas
   a cada 5 min, capando a contagem).

**Não corrigidos (deliberado, documentado):**
- **Toast do front** (`apps/cockpit-web` ProposedActions): com flag OFF o
  "retorno inconclusivo" não agenda cobrança, mas o toast ainda promete
  "cobrança em 4 dias". O RPC já devolve `cobranca_agendada` — falta o front
  consumir. NÃO editado por exigir decisão de trilho (MODO LOVABLE × FRONT
  PRÓPRIO — o Lovable de produção pode ter o mesmo toast). Pendência pro Caio.
- **INV-fila nos paths de exceção do handler de reentrega**: design
  pré-existente (retry a cada 15 min é intencional pra falha transiente de SSW;
  reagendar +24h atrasaria cancelamentos legítimos). Alerta de saúde da fila
  cobre o cenário de acúmulo. Comentado no código.
