# Fase 2 — Plano de deploy controlado (NÃO deployado)

**2026-06-27.** Normalização de segmento no resolver. Estimativa de impacto feita ANTES do deploy.

## 1. Funções a redeployar (importam `operador-resolver.ts` de fato)
Confirmado por `import` real (não comentário). `bastao-rules.ts` só cita em comentário → **não** bundla.

1. `criar-card-manual`
2. `vinculador`
3. `sync-prioridades-ai-do-bastao`
4. `sync-bastao` ← maior volume / principal driver de reatribuição

(O resolver vive em `_shared/`; cada função o **bundla no deploy** — por isso as 4 precisam redeploy.)

## 2. Validação ANTES (read-only, já executada)
- Baseline: **942 ativos · 1 invisível · 1 sem-dono** (só 2206263 SAL EXP, blacklisted).
- Simulação fiel do novo resolver no banco:
  - sem-dono que ganham dono por segmento: **0**
  - cards com dono que mudariam: **0**
  - cards que perderiam dono: **0**
  - segmentos ambíguos (mesmo código em >1 operador ativo): **0**
- **Blast radius imediato = ~0** (Fase 1 já resolveu os órfãos por dados; valor da Fase 2 é preventivo).

## 3. Ordem de deploy (menor risco → maior)
1. `criar-card-manual` → 2. `vinculador` → 3. `sync-prioridades-ai-do-bastao` → 4. `sync-bastao` (por último).
Comandos (a rodar só após aprovação):
```
supabase functions deploy criar-card-manual
supabase functions deploy vinculador
supabase functions deploy sync-prioridades-ai-do-bastao
supabase functions deploy sync-bastao
```
Antes: commitar a mudança do resolver (rastreabilidade). Guard: `deno test operador-resolver.test.ts` verde.

## 4. Validação DEPOIS (1º sync pós-deploy)
- Re-rodar `audits/audit-card-routing.sql` e comparar com a baseline:
  - sem-dono e invisíveis **não podem subir**; podem cair (esperado ~0 mudança agora).
  - **0** cards com dono trocando para segmento onde carteira/nome deveriam ganhar.
- Conferir contagem de **reatribuições** no 1º run do `sync-bastao` (esperado ~0; spike = investigar).
- Por operador: visíveis **não podem cair**.

## 5. Critério de rollback
- **Gatilho:** spike inesperado de reatribuições no 1º sync; qualquer card com dono legítimo
  (carteira/nome) virando dono por segmento; operador relatando card sumindo/aparecendo errado;
  aumento de sem-dono/invisíveis.
- **Ação:** restaurar o `operador-resolver.ts` anterior (`git checkout`/revert) e redeployar as 4
  funções. Mudança isolada no resolver → rollback limpo. (Dados não são tocados pela Fase 2; não há
  rollback de dados.)

## 6. Sinais para monitorar no 1º sync
- Nº de cards reatribuídos por run (deve ficar ~0).
- `via='segmento'` aparecendo nos eventos/logs de atribuição (novo; conferir se cada caso é legítimo).
- Sem-dono total (deve permanecer ≈1, o SAL EXP).
- Nenhum card com `conflito carteira×responsável` (ex.: LOLLIPOPS/VICTOR) mudando de dono.
- Primeiro card 043 NOVO sem carteira → deve nascer com dono (ISA E KAROL), não órfão (prova do fix).

## NÃO alterado nesta etapa
Sem deploy. Sem SQL de escrita. Sync-bastao/RLS/trigger/dados intactos. Só leitura + este plano.
