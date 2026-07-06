# Fase 1 — Relatório de medição confiável (roteamento de cards)

**2026-06-27 · read-only · nada alterado em produção.** Gerado por
[audit-card-routing.sql](audit-card-routing.sql) v2 (corrigido). Supersede os números de
segmento/invisibilidade de [AUDIT_CARD_ROUTING_2026-06-27.md](AUDIT_CARD_ROUTING_2026-06-27.md).

## Placar (944 cards ativos em escopo)

| Métrica | v1 (errado) | **v2 (corrigido)** | Observação |
|---|---:|---:|---|
| Invisíveis p/ operador comum | "12" | **4** | replica RLS real (assigned **ou** segmento_codigo=ANY(segmentos) **ou** pagador=ANY(carteira)) |
| Dono inativo | — | **1** | NF 1153 (DURAFA offboarded) — **não** é invisível (DUILIO a vê por segmento 022) |
| `segmento_codigo` NULO | — | **910** / 936 | rede de segurança por segmento ausente na maioria |
| Divergência **real** de segmento (código≠código) | "30" | **10** | os outros 20 eram falso-positivo |
| Falso-positivo (código igual, só rótulo difere) | (contado como divergente) | **20** | ex.: `022` vs `022 - MOTOBIKE` |
| `fix-orfaos-043-carteira-isa.sql` aplicado? | — | **APLICADO** | 8/8 CNPJs na carteira da ISA E KAROL |

Roteamento por carteira **íntegro**: 0 cards no operador ativo errado, 0 CNPJ em 2+ carteiras.

## O que mudou na medição (e por quê)
- **[C1] Divergência de segmento:** v1 comparava `segmento_codigo` (código, ex `022`) com o **rótulo** do Bastão (`022 - MOTOBIKE`) → inflava. v2 compara **código vs código** (3 dígitos). Real = 10; falso-positivo = 20.
- **[C2] Invisibilidade:** v1 marcava invisível só por `assigned` nulo/inativo. v2 replica a **RLS real** — card é visível se `assigned` ativo **OU** `segmento_codigo = ANY(segmentos)` (match exato, como a RLS) **OU** `pagador = ANY(carteira)` (morto: nome×CNPJ). Resultado honesto: **4** invisíveis.

## Cards REALMENTE invisíveis p/ operador comum (4) — só o gestor vê
Todos com `segmento_codigo` NULL **e** sem dono:

| NF | CTRC | CNPJ | Pagador | State | Dono correto |
|---|---|---|---|---|---|
| 5570657 | AMB219494-5 | 02415741000169 | DELIO ARAUJO | AGUARDANDO_CLIENTE | **ISA E KAROL** (CNPJ já na carteira; preso em `mudanca_suspeita`) |
| 206261 | APO300256-0 | 86392529000466 | SAL EXP. TRANSP | AVH | (decisão pendente — interno) |
| 206262 | APO300267-5 | 86392529000466 | SAL EXP. TRANSP | AVH | (decisão pendente — interno) |
| 2206263 | APO356106-2 | 86392529000466 | SAL EXP. TRANSP | EXTRAVIO_MONITORADO | (decisão pendente — interno) |

## Cards que exigem ação manual (não aplicada — Fase 1 é só medição)

| # | Card | Problema | Ação sugerida (precisa aprovação) |
|---|---|---|---|
| 1 | NF 5570657 (DELIO) | Invisível, sem dono | Reatribuição manual event-sourced p/ ISA (bloqueada antes pelo guard) **ou** destravar `mudanca_suspeita` |
| 2-4 | NF 206261/206262/2206263 (SAL EXP) | Invisíveis, sem dono | Decidir destino (transferir/encerrar/atribuir) — CNPJ interno, fora da carteira por decisão sua |
| 5 | NF 1153 (DURAFA) | Dono inativo (offboarded) | Reatribuir p/ DUILIO (segmento 022). Visível ao DUILIO hoje, mas dono não loga |
| 6-7 | NF 123456/123457 (COCKPIT) | Donos = operador-sistema; cara de teste ("DUILIO DE DEUS") | Confirmar e limpar |

## Divergência real de segmento (10) — não urgente
São cards onde `segmento_codigo` guarda o código do **dono** (gravado por migs 262-265) e o
Bastão classifica em **outro** segmento: 7× ATACADO UNIAO (ISA por carteira, Bastão 001/CAMILA) +
GOW (189137) + CICLOVIX (44331) + SOLUÇÃO PET (145627). A visibilidade funciona (dono vê); é item
de **revisão de cadastro de carteira**, não bug de código. Não mexer agora.
