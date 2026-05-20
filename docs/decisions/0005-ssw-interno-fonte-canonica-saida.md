# ADR 0005 — SSW interno (opção 101) é fonte canônica de saída do card

**Data:** 2026-05-13
**Status:** Aceito
**Substitui parcialmente:** ADR 0004 (regra 3 — "cards saem do Cockpit quando a ação é confirmada via Bastão" passa a ser "via SSW interno").

## Contexto

Desde [ADR 0004](0004-cockpit-relacionamento-only.md), o Cockpit usa o **Bastão** como fonte única pra decidir quando um card entra (sync periódico) **e quando sai** (sync detecta nova oc fora do escopo de Relacionamento → marca TRANSFERIDO / RESOLVIDO). Funcionou bem pra criação. Pra saída, gerou uma família de bugs em produção:

- **NF 64409 / 422589 / 62862 / 1002836 / 11233 / 691367** (2026-05-11): Larissa recusava propostas em oc=10 com lock destravado. RPC `voltar_para_to_do` v1 mantinha as propostas pendentes; próximo sync via Bastão ainda mostrando oc=10, `proporAutoAcaoSeAplicavel` detectava propostas existentes e força `LockAjustadoPropostasExistentes` → AVH+lock de volta. Loop até o RPA Bastão refletir nova oc (5-60min). Caso real NF 64409: Larissa apertou "Voltar pra TO-DO" 4 vezes em 19 min.
- **NF 692021 / 20761** (2026-05-13): cards em ACAO_EXECUTADA com oc lançada com sucesso. Pass B movia pra TRANSFERIDO durante latência RPA Bastão. Pass A reabria via `voltouParaRelacionamento`. Loop multi-sync até janela 60min mitigar.
- **NF 26298 / 29326** (2026-05-13, mensagem original deste plano): casos onde a oc no Bastão ficava temporariamente desatualizada e o sync re-aplicava regras antigas.

A causa raiz é a mesma em todos: **confiança cega numa fonte que tem latência operacional (RPA Bastão importa do SSW em ciclos de minutos/horas)**.

Em paralelo, em 2026-05-11 o time consolidou o `ssw-internal-client.ts` (scraping logado no portal SSW via opção 101) — consulta on-time, 2-3s end-to-end, mostra TODAS as ocorrências (o tracking público oculta 31 ocs internas como 49/56/44/30/31...). Já é usado em produção pelo botão "ATUALIZAR AGORA" (`atualizar-card-via-portal-ssw`, desde 2026-05-12) e pelo "TRAZER HISTÓRICO SSW" (`puxar-historico-ssw-card`).

## Decisão

**Repartir as fontes externas em dois papéis distintos:**

- **Bastão = INPUT do card** (continua exatamente como ADR 0004: sync periódico filtrado por `OCORRENCIAS_DE_RELACIONAMENTO` cria/reabre cards). Latência aceitável pra criação.
- **SSW interno (opção 101) = SAÍDA do card** (qualquer decisão "card sai do escopo Relacionamento" — TRANSFERIDO, RESOLVIDO, AGUARDANDO_CLIENTE, AVH com propostas de oc nova — consulta o SSW interno on-time em vez de esperar Bastão).

Tracking SSW público (`lib/ssw-tracking-client.ts`) é **deprecated**. Será removido após migração dos callers restantes (Pass B/E do sync-bastao, vinculador).

## Implementação (fases do plano `hoje-usamos-o-bast-o-whimsical-charm.md`)

### Fase 1 — fix imediato do bug do loop (concluída 2026-05-13)

1. `voltar-para-to-do-com-rastreio` v3 — consulta SSW interno, decide destino no ato (`stateFinalAposBastao`), cancela propostas, seta cooldown.
2. Cooldown POR OC em `proporAutoAcaoSeAplicavel` (`propostas_recusadas_em` + `propostas_recusadas_para_oc`, janela 10min).
3. Pass A do `sync-bastao` preserva os 2 novos campos no `agent_state`, mesmo padrão do `chave_cte`.
4. Botão renomeado pra **"✕ RECUSAR AÇÕES SUGERIDAS"** (`prompts/lovable-cards-acoes.md`).

### Fase 2 — confirmação pós-execução via SSW (concluída 2026-05-13)

5. Helper compartilhado [`_shared/confirmar-acao-executada-ssw.ts`](../../supabase/functions/_shared/confirmar-acao-executada-ssw.ts).
6. Executor chama o helper imediatamente após `AcaoExecutada` (4 caminhos: WebAPI, combo 33+44, oc=33 solo, PRATI email+33). Best-effort.
7. **Pass H novo** em `sync-bastao` — itera cards `ACAO_EXECUTADA` com `acao_executada_em > 2min`, consulta SSW interno, libera pro state final. Emite `AcaoExecutadaConfirmadaPeloSsw`.
8. Pass G existente (Bastão + janela 30min) permanece como **backup nos primeiros 14 dias** — após confiança no Pass H, remover.

### Fase 3 — deprecação tracking público (CONCLUÍDA 2026-05-13)

9. `lib/ssw-tracking-client.ts` + `supabase/functions/_shared/ssw-tracking-client.ts` marcados como `@deprecated`.
10. **Todos os callers migrados em 2026-05-13:**
    - `sync-bastao` Pass B (`runPassB`) — `descobrirUltimaOcSsw` substituiu `fetchOcDoTracking`. Cobre 100% das ocs (incl. bloqueadas no público).
    - `sync-bastao` Pass E (`runPassE`) — mesmo helper + **cadência reduzida pra 8h** (sync_runs). Volume SSW interno cai de ~45 calls/min pra ~135 calls/dia.
    - `vinculador/index.ts` — 3ª fonte SSW público REMOVIDA do `runLookupChain`. Cards só criados via cockpit_existing ou bastao.
    - `r-evidencia` — **UNIFICADO** em SSW interno (`obterFotoDaOc`). Removido o branch dual (público vs interno).
    - `_shared/verificar-evidencia.ts.temEvidenciaParaOc` — reescrito pra usar SSW interno. Interface externa preservada (callers do executor, sync-bastao, vinculador, revalidar-evidencia-card NÃO mudam).
    - `cadastrar-tracking-auto` — header `@deprecated`.
11. Tabela `tracking_credentials` virou **READ-ONLY** via migration `2026-05-13_093_tracking_credentials_read_only.sql`. INSERT/UPDATE/DELETE revogados. SELECT mantido pra histórico.
12. **Pendente sprint seguinte (cleanup final):**
    - Remover `_shared/verificar-evidencia.ts.scrapeSsw` + `obterFotoBinarioEvidencia` (dead code).
    - Remover funções órfãs no vinculador (`createCardFromSswTracking`, `disparAutoPropostaParaCardSswTracking`, `extractCodFromSswTracking`).
    - Após 14 dias sem incidente: DROP TABLE `tracking_credentials` + DELETE `lib/ssw-tracking-client.ts` + DELETE `_shared/ssw-tracking-client.ts`.
    - Remover Pass G (Bastão+30min) — substituído por Pass H (SSW interno on-time).

### Bonus 2026-05-13

13. Edge function nova `foto-oc-card` — proxia foto de oc específica pra aba HISTÓRICO SSW (auth operador via RLS). Reusa `obterFotoDaOc`. Front Lovable atualizado em `prompts/lovable-aba-historico-ssw.md`.

## Alternativas consideradas

### Alternativa 1 — Manter Bastão como fonte única + janelas de proteção

Estender as proteções tipo "janela 30min" / "cooldown" pra cobrir todos os casos onde Bastão atrasa.

- **Pró:** sem nova dependência externa (login Larissa no SSW).
- **Contra:** vira coleção de heurísticas frágeis. Cada bug novo exige nova janela. Não fecha a causa raiz (latência).
- **Rejeitada.**

### Alternativa 2 — SSW interno também como input

Substituir o sync Bastão periódico por uma varredura SSW interna.

- **Pró:** uma fonte só, sem latência.
- **Contra:** Bastão já enrichede os dados (pagador, base destino, dias_atraso, segmento_cliente, etc) — replicar tudo via scraping é caro. SSW interno também não tem "lista de pendências" pronta — teria que varrer NF por NF.
- **Rejeitada.** Bastão continua sendo entrada (latência tolerável); SSW interno cobre saída (precisa ser on-time).

### Alternativa 3 — Manter tracking público em paralelo

Manter os 2 clientes (público + interno) sem deprecar.

- **Pró:** flexibilidade.
- **Contra:** confunde dev (qual fonte usar?), 2 superfícies de erro, números divergentes entre as fontes. Tracking público oculta 31 ocs — qualquer decisão que dependa delas precisa do interno mesmo.
- **Rejeitada.** Migrar tudo e remover.

## Consequências

**Aceitas:**

- **Dependência operacional do login interno SSW.** Hoje compartilhado da Larissa (l.silva). Se ela logar manualmente, sessão pode invalidar. Mitigação: cliente re-loga automaticamente; pedir usuário dedicado pro Cockpit quando SSW criar conta.
- **Throttle SSW.** Scraping em todo card pós-execução + Pass H periódico aumenta carga. Volume típico: 30-100 cards ativos/dia → 5-15 chamadas SSW por sync (1min). Aceitável; cache de sessão JWT amortiza login.
- **Pass G (Bastão + 30min) mantido por 14 dias como backup.** Aumenta complexidade temporária. Plano: remover após confiança no Pass H consolidada.
- **Eventos novos no `card_events`.** `AcaoExecutadaConfirmadaPeloSsw` substitui gradualmente `AcaoExecutadaConfirmadaPeloBastao`. Filtros de audit precisam contemplar ambos durante a transição.

**Ganhas:**

- **Bug do loop `voltar_para_to_do` fechado na raiz.** Larissa clica RECUSAR, SSW interno decide o destino real do card no ato (2-3s), sem janelas de espera.
- **Card em ACAO_EXECUTADA libera em segundos, não em 30min.** Operadora não fica vendo card "preso" depois de aprovar uma ação.
- **Decisão de destino consistente.** Toda lógica `oc → state` passa pelo `stateFinalAposBastao` (helper canônico). Não há mais "Bastão diz X, tracking público diz Y, qual valer".
- **Tracking público pode ser removido.** Menos código, menos credencial pra gerenciar.

## Como aplicar (regras pra desenvolvedor)

1. **Decisão de destino do card (TRANSFERIDO / RESOLVIDO / AGUARDANDO_CLIENTE / etc) sempre via SSW interno.** Não criar novos callers do tracking público. Reusar `confirmarAcaoExecutadaViaSsw` ou os helpers de `ssw-internal-client.ts` (`obterSessao`, `buscarNFInterno`, `listarOcorrenciasNF`).

2. **`stateFinalAposBastao(oc, ocTemRegra)`** ([_shared/bastao-rules.ts](../../supabase/functions/_shared/bastao-rules.ts)) é a função canônica oc→state final. Não duplicar essa tabela em outros lugares.

3. **Best-effort + Pass H como rede.** Toda chamada inline ao SSW interno deve ter try/catch e tolerar falha — Pass H pega depois. Não bloquear operadora se SSW estiver fora.

4. **Bastão continua sendo INPUT.** Sync periódico em [sync-bastao/index.ts](../../supabase/functions/sync-bastao/index.ts) Pass A não muda. ADR 0004 continua válido pra entrada de cards.

5. **`agent_state.propostas_recusadas_em` + `propostas_recusadas_para_oc`** são preservados em qualquer escrita de `agent_state` no Pass A do sync (mesma defesa do `chave_cte`). Quem escreve `agent_state` em outro caller deve fazer spread `{ ...existente, ...mudanças }`.

## Quando reconsiderar

Reabrir este ADR quando:

- SSW interno se mostrar instável (taxa de erro > 5%) ou trocar de schema.
- Pass H tiver 14 dias de estabilidade — então remover Pass G (segunda metade da fase 3).
- Bastão for descontinuado (caso reaberto pelo ADR 0004 também).
- For criado um usuário SSW dedicado pro Cockpit (substitui o login compartilhado da Larissa).
- Algum outro consumer precisar do tracking público (improvável; público é estritamente menos capaz que o interno).
