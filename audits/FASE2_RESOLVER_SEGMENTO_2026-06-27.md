# Fase 2 — Normalização de segmento no resolver (raiz dos órfãos 043)

**2026-06-27 · código pronto, NÃO deployado.** Escopo: só `operador-resolver.ts` + teste.

## O que mudou
Raiz [R1]: os call-sites passam `segmentoCodigo: p.segmento_cliente` = RÓTULO (`"043 - CURVA F"`),
mas `operadores.segmentos` guarda o CÓDIGO (`"043"`). O match exato anterior
(`segmentos.includes(hint cru)`) nunca casava → atribuição por segmento morta → cards 043 sem
carteira/nome viravam órfãos invisíveis.

Correção **central no resolver** (sem tocar call-sites nem sync):
- Novo helper puro `normalizarCodigoSegmento(v)` — extrai o código de 3 dígitos do início
  (`/^\s*(\d{3})(?!\d)/`); aceita `"043"`, `"043 - CURVA F"`, `"  043 - curva f  "`; retorna `null`
  para `"Outros"`/vazio/`null`/2 ou 4 dígitos.
- Path 3 (segmento) passa a normalizar os **dois lados** (hint e `operadores.segmentos`).
- Helper test-only `__resetResolverCachesForTest()`.
- **Precedência inalterada**: carteira (CNPJ) > nome > segmento (Paths 1→2→3, retornos antecipados).

## Impacto esperado pós-deploy (intencional)
A atribuição por segmento volta a funcionar para TODOS os callers do resolver (sync-bastao,
vinculador, sync-prioridades, criar-card-manual). Cards hoje sem dono cujo segmento bate com um
operador ativo passam a receber dono no próximo ciclo. No sync existente, `precisaEscrever` dispara
porque o `responsavel_relacionamento` canônico passa a diferir do gravado → o card é reatribuído.

## Risco residual / validar pós-deploy
- Rodar `audits/audit-card-routing.sql` ANTES e DEPOIS do 1º sync: sem-dono e invisíveis devem cair;
  nenhum card pode mudar de dono onde carteira/nome deveriam ganhar.
- Conferir volume de reatribuições no 1º sync (não pode haver reatribuição em massa indevida).
- Por operador: contagem de visíveis não pode CAIR; pode SUBIR para donos de segmento.
- Segmento ambíguo (mesmo código em 2 operadores ativos) → card vai a `nenhum`. Hoje os segmentos
  são disjuntos (0 ambíguo), mas revalidar.

## NÃO alterado
sync-bastao, RLS, trigger `cards_resolve_operator`, dados de produção. Sem deploy.

## Guard de não-regressão
`supabase/functions/_shared/operador-resolver.test.ts` (12 testes) — `deno test` verde.
