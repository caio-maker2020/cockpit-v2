# 0011 — Reabertura/visibilidade de card decide pela VERDADE DO SSW POR IDENTIDADE (ai.salex × terceiro)

Data: 2026-06-30
Status: aceito (no ar atrás da flag `reabertura_por_identidade_enabled`; validado ao vivo ~27h / 57 ciclos, 2026-06-29→30)
Supersede: **0009** (por HORA)

## Contexto

O ADR 0009 (INV-023) fazia a decisão "reabrir (oc nova) vs suprimir (a anterior lagando)"
comparando a **HORA** da ocorrência mais recente no SSW (`decidirReaberturaPorSsw`) com o
instante do último lançamento do Cockpit (`acoes_executadas_ssw.iniciado_em`).

**Raiz descoberta (NF 346896):** essa comparação mistura **dois relógios diferentes** — a
hora do SSW vem em **minuto cheio** (segundos = 0, relógio do servidor SSW) e o `iniciado_em`
vem em **segundos** (relógio da edge/Postgres). Com skew de ~1-2 min, uma oc de Relacionamento
**genuinamente nova de terceiro** lançada no mesmo minuto (ou logo antes) de uma ação do Cockpit
parecia "anterior lagando" → suprimida pra sempre → card invisível ao operador.

Caso âncora **NF 346896** (Larissa): SSW mostrava `oc=19 (marianep, 13:13)` acima de
`oc=56 (ai.salex, 13:12)`, mas `iniciado_em` da oc=56 = **13:14:01** → `13:13 < 13:14:01`
→ suprimir, 97× em 6 dias. O 346896 é relacionamento real de terceiro; ficou preso em
TRANSFERIDO (invisível). A auditoria de 41 cards no SSW confirmou que era o **único**
falso-positivo daquele momento.

## Decisão — a regra-mãe

> **Bastão é GATILHO, SSW é JUIZ.** A visibilidade do card é decidida pela **ocorrência real
> mais recente do SSW** e pela **IDENTIDADE de quem a lançou** — **nunca** por comparação de
> relógio.
>
> - oc mais recente = **54** → **AGUARDANDO_CLIENTE** (independe do autor).
> - oc mais recente = **não-Relacionamento** → mantém fora (não reabre).
> - oc mais recente = **Relacionamento ≠54** lançada pela **conta do Cockpit (`ai.salex`)**
>   → é a nossa própria ação (Bastão lagando atrás) → **não reabre** (mata bounce-back).
> - oc mais recente = **Relacionamento ≠54** lançada por **TERCEIRO** (operação/cliente)
>   → oc nova genuína → **MOSTRAR ao operador** (AGUARDANDO VOCÊ).
> - **em dúvida NÃO esconde:** autor desconhecido / SSW indisponível / cache stale
>   → `INDEFINIDO_RETRY` (não decide neste ciclo). Autor desconhecido + código igual ao
>   último lançamento do Cockpit **nunca** vira "manter fora" — código sozinho não é
>   fingerprint suficiente.
> - **prazo do INDEFINIDO_RETRY:** ~1h / 2 ciclos; depois, se o Bastão ainda aponta
>   Relacionamento ≠54, **escala pra MOSTRAR** (evento `ReaberturaPorIndefinidoExpirado`).
>   Nenhum Relacionamento fica invisível sem prazo.
> - **preferir falso-positivo controlado a Relacionamento invisível.**

`ai.salex` é a conta oficial única de lançamento do Cockpit (INV-013). Não há allowlist
histórica de contas — se um dia houver outra conta de lançamento, estender o sinal de identidade.

## Por que ataca a raiz

Elimina a comparação cross-clock. "A oc mais recente é **nossa** (`ai.salex`) ou de **terceiro**?"
responde os dois cenários (bounce-back × oc nova) sem relógio nem ambiguidade de código. O SSW é
real-time (lançamos direto nele), então a oc mais recente do SSW é a verdade. Empiricamente:
na auditoria dos 41 cards a regra de identidade classificou **41/41** corretamente.

## Implementação

- **Função pura:** `_shared/decidir-visibilidade-ssw.ts` (`decidirVisibilidadePorSsw`,
  4 decisões explícitas: `MOSTRAR_OPERADOR` / `AGUARDANDO_CLIENTE` /
  `MANTER_FORA_RELACIONAMENTO` / `INDEFINIDO_RETRY`; `estadoFinalParaDecisao` mapeia
  decisão→estado/evento por caller). SEM tempo nos inputs.
- **`descobrirUltimaOcSsw`** devolve `ocorrencias[]` com `usuario` (autor).
- **Integração (atrás da flag `reabertura_por_identidade_enabled`, default OFF):**
  `sync-bastao` — `decidirReaberturaCandidato` (Pass A) e `naoRebaixarComDesempateSsw`
  (sweep INV-019). Com flag OFF o caminho per-hora (0009) fica intacto (rollback imediato).
- **`classificarPorData` não esconde sozinho** com a flag ON: só "nova" decide sem SSW; o
  resto (inclusive "lag") passa pela função.
- **Política de prazo:** helper no caller via `card_events`
  (`ReaberturaIndefinida` → `ReaberturaPorIndefinidoExpirado`).
- **Shadow (0011-prep):** tabela `reabertura_shadow_log` + flag `reabertura_shadow_enabled`
  registrou decisão nova × atual sem agir; gate de rollout = zero `MOSTRAR` com autor `ai.salex`.
- **Guard:** `decidir-visibilidade-ssw.test.ts` (P1–P13 puros + mapeamento callers) +
  INV-023 no verify-cockpit.

## Cenário real (validação ao vivo)

- **346896** (raiz): reaberto manualmente (16:55) antes do deploy; era o único falso-positivo.
- **1086787** (prova viva, 2026-06-30 05:44): suprimido correto ontem (nossa oc=56); um terceiro
  (`anselmo`) lançou oc=49 → **reabriu sozinho** pra AGUARDANDO VOCÊ, propostas geradas, cliente
  respondeu. Suprime ação própria, reabre relacionamento novo de terceiro.
- **~27h / 57 ciclos:** 0 erro, 0 bounce-back, 0 bloqueador ai.salex, 0 card invisível.
  Ver `audits/MONITORAMENTO_REABERTURA_IDENTIDADE_2026-06-30.md`.

## Rollback / transição

Flag `reabertura_por_identidade_enabled=false` → volta ao per-hora (0009) em ≤60s, sem redeploy.
A lógica per-hora e o ramo OFF ficam no código por mais alguns dias (rollback imediato); a
remoção do código antigo será um **PR de cleanup separado** após mais estabilidade.

## R2 (coberto, intocado)

Card AGUARDANDO_CLIENTE cuja oc real vira NÃO-relacionamento → CONFLITOS
(`flagConflitoOcSemMover` via `cardEmEscopoProtegido`, Pass B). Este fix não toca esse caminho.
