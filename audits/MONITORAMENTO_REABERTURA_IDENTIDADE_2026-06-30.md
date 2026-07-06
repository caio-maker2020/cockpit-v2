# Monitoramento — Reabertura por Identidade (correção NF 346896)

**Janela:** flag `reabertura_por_identidade_enabled` ligada em **2026-06-29 22:31 BRT** → relatório em **2026-06-30 22:35 BRT** (≈ **27h**, **57 ciclos** do cron server-side).
**Deploy:** `sync-bastao` v225 (commit `4616f21`, branch `shadow/sync-bastao-deploy-base`, base `654fa36` = estado deployado, sem 705764/Pass D, sem health-check).
**Flags no período:** `reabertura_por_identidade_enabled=true`, `reabertura_shadow_enabled=true` (shadow é no-op com identity ON — caminhos mutuamente exclusivos).

## Resultado por item

| # | Item | Resultado |
|---|---|---|
| 1 | sync_runs / errors_count | **57 runs, 0 com erro, soma errors_count=0** — todos `succeeded` |
| 2 | reaberturas reais por mudança de state (suprimido→visível) | **1** (NF 1086787, verificada correta — ver abaixo) |
| 3 | ReaberturaIndefinida / ReaberturaPorIndefinidoExpirado | **0 / 0** (política de prazo não precisou disparar; SSW esteve disponível) |
| 4 | bounce-back (reaberto→TRANSFERIDO em <1 ciclo) | **0** |
| 5 | bloqueador shadow MOSTRAR + usuario_ssw=ai.salex | **0** |
| 6 | cards ainda possivelmente invisíveis | **0** (nenhum TRANSFERIDO+relac suprimido nas últimas 12h; nada travado) |
| — | pool ambiente TRANSFERIDO+relac≠54 (total) | 530 (maioria supressão legítima; 0 ativos travados) |
| — | AguardandoClienteForcadoPorSsw (AC-fix) | **2** — ambos corretos (SSW mostrava oc=54 → card foi pra AGUARDANDO_CLIENTE) |

## Prova viva da correção — NF 1086787 (Larissa)
- 29/06 21:44: operadora lançou oc=56 (encaminhou Operação) → card TRANSFERIDO.
- 29/06 22:00–22:35: **suprimido corretamente** (SSW mais recente = nossa oc=56 por `ai.salex`).
- 30/06 05:44: terceiro (`anselmo`, operação) lançou **oc=49 relacionamento** (depois da nossa ação).
- Resultado: card **reabriu sozinho** → AGUARDANDO_VALIDACAO_HUMANA (visível), propostas geradas, cliente respondeu 11:41.
- SSW confirmado: `oc=49 anselmo (30/06 05:44)` acima de `oc=56 ai.salex (29/06 18:42)` → reopen **CORRETO**.

Comportamento exatamente o desejado: **suprime ação própria do Cockpit (Bastão lagando), reabre relacionamento novo de terceiro** — sem comparação de relógio (cross-clock eliminado).

## Casos AC-fix (AGUARDANDO_CLIENTE forçado por SSW=54)
- **804631** → AGUARDANDO_CLIENTE (oc=54) — correto.
- **145557** → forçado a AC (SSW=54) e depois progrediu pra devolução (oc=44 → TRANSFERIDO, fora de relacionamento) — correto, não é invisível.

## Observações / follow-ups não-bloqueantes
- **Observabilidade:** o caminho de reabertura do candidato **não emite** um evento `CardReaberto` explícito (o reopen aparece como `BastaoCardAtualizado` + transição de state). Recomenda-se adicionar um evento explícito de reabertura para métrica limpa.
- **Watchdog INV-023** (`checkTransferidoOcRelacionamentoSuprimido`) segue **não-deployado** (health-check fora desta rodada por decisão) → sem alerta automático; monitoramento foi manual.
- **Lógica antiga per-hora** (`decidirReaberturaPorSsw`) continua no código, atrás da flag OFF — candidata a remoção na fase de cleanup.
- **Shadow** pode ser desligado quando não for mais necessário (é no-op com identity ON).

## Recomendação final
**MANTER a flag `reabertura_por_identidade_enabled` LIGADA e avançar para a fase de cleanup/documentação.** Zero erros, zero bounce-back, zero bloqueador, zero card invisível em ~27h/57 ciclos, com prova viva de reabertura correta e supressão correta. **Não há motivo para rollback.**

## Rollback (se necessário no futuro)
```sql
update feature_flags set enabled=false where key='reabertura_por_identidade_enabled';
```
(efeito ≤60s, sem redeploy; volta ao caminho per-hora que segue intacto no código.)
