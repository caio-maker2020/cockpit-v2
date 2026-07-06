# ADR 0007 — Agente autônomo de extravio D+4 (lançar oc 49)

**Data:** 2026-06-24
**Status:** Aceito (autonomia gateada por flag, default OFF)

## Contexto

Hoje um humano monitora os extravios (oc 6/9/16) e, quando um chega a **4 dias úteis
sem nenhuma ocorrência lançada depois**, lança a oc 49 ("PRAZO DE PERDAS EXPIRADO") no
SSW. É manual, falha, perde rastreabilidade e gera estresse com o cliente. A aba EXTRAVIOS
(PART 1, INV-017) já mantém a visão correta; faltava automatizar o lançamento.

O risco central: **lançar a 49 "em cima" de algo que já aconteceu** (o extravio foi
localizado/devolvido entre o lançamento e o D+4) — geraria ocorrência duplicada/errada.

## Decisão

Criar o agente `agente-extravio-d4` (cron horário comercial BRT) com estas regras:

1. **Pré-checagem SSW obrigatória antes de TODO lançamento** (`podeAgenteLancar49`: última
   oc real ∈ {6,9,16}). Escrita exige verdade real-time — o Bastão atrasa. Se já tem oc
   pós-extravio → **NÃO lança**, marca `nao_rodou` com motivo explicado → coluna AUTÔNOMO
   NÃO RODOU (substitui a D5) pro operador verificar/reportar.
2. **Lançamento via envelope** `lancarSswPortal` (idempotência + tripé, INV-013/014), nunca
   direto. Card vai pra AGUARDANDO VOCÊ em ~10s (executor inline, não espera o Bastão).
3. **Validação = Caio aprova um LOTE** (modo `execute`), não os operadores. Sombra =
   `scan` recomenda; Caio valida; depois liga a flag global `extravios_agente_autonomo_enabled`.
   "Contador de acertos" = track-record na AUDITORIA, não gate automático.
4. **Auditoria por operador:** card_events (RLS por card) + snapshot em `cards_auditoria`
   com `motivo='extravio_oc49_autonomo'` (filtro próprio, não mistura com oc13/oc56) +
   RLS de `cards_auditoria` corrigido (era `USING(true)`).

## Alternativas descartadas

- **Contador de acertos automático (10x por operador)** (como oc13): descartado — Caio
  achou confuso pro operador; preferiu validar o lote ele mesmo e depois ligar a flag.
- **Mover o card sozinho quando acha oc no SSW** (em vez de NÃO RODOU): descartado — Caio
  quer o operador vendo/reportando antes (coluna NÃO RODOU).
- **Lançar sem pré-checagem confiando no PART 1/Bastão:** descartado — escrita exige
  real-time; o Bastão atrasa e poderia lançar em cima de uma localização recente.

## Consequências

- Guard: INV-022 (`_shared/agente-extravio-regras.ts` + testes + verify-cockpit + DB).
- Autonomia reversível: flag OFF a qualquer momento; reportes de erro na AUDITORIA sinalizam.
- Reusa: envelope, executor inline, `cards_auditoria`, `agent-runs-logger`, kanban (PART 1).
- Migrations 256-259; edge `agente-extravio-d4`. Ver memory `project_agente_extravio_autonomo_d4`.
