# ADR 0012 — Sync único do Cockpit (relacionamento + extravio + futuras categorias)

Data: 2026-06-18
Status: Aceito (Caio)

## Contexto

O Cockpit puxa pendências do Bastão. Até agora havia **dois syncs separados**:
- `sync-bastao` — puxa `cod_ultima_ocorrencia ∈ OCORRENCIAS_DE_RELACIONAMENTO`.
- `sync-extravios-bastao` — puxa `cod_ultima_ocorrencia ∈ {6,9,16}` (extravio), gated só Duilio.

### Problema (bug âncora NF 608372)

Os dois pulls são **disjuntos**. Quando a última oc de um card cruza a fronteira
relacionamento ↔ extravio, ele cai num **vão**: o sync que tinha o card para de
puxá-lo (a oc saiu do filtro dele) e o outro não o adota. Resultado real: NF
608372 ficou presa em `AGUARDANDO_CLIENTE` (oc 54) enquanto o SSW/Bastão já
apontavam oc 6 (extravio, mais recente) — invisível nas duas abas. Auditoria do
Caio encontrou 4 cards do Duilio nessa situação.

## Decisão

**Um único sync (`sync-bastao`) puxa TODAS as ocorrências "do Cockpit"**
(relacionamento + extravio, e no futuro operação/ressarcimento/etc.) e **separa
por regra**. `sync-extravios-bastao` é aposentado.

### Regra inviolável

> Todo card cuja última ocorrência (no Bastão) for "do Cockpit" — relacionamento
> OU extravio — TEM que aparecer, roteado pela regra daquela oc. O card segue
> sempre a sua última ocorrência.

### Por que um sync (e não N syncs reconciliando via SSW)

- Os syncs batem na **mesma fonte** (Bastão). Se um quebra, quebram juntos — o
  "isolamento de falha" do design de 2 syncs era ilusório (Caio, Risco 4).
- N syncs (operação, ressarcimento…) cada um reconciliando via SSW deixaria a
  plataforma pesada sem necessidade.
- Um pull único, separado por regra, escala pra novas categorias sem multiplicar
  risco nem código.

## Como os riscos foram endereçados

1. **Escopo/blast radius:** extravio passa a valer pros 5 operadores (front já
   testado). Flag `extravios_cockpit_enabled` vira kill-switch global.
2. **Premissa "oc não-relacionamento ⇒ TRANSFERIDO":** `stateFinalAposBastao`
   (fonte única, INV-008) ganha `oc ∈ {6,9,16} → EXTRAVIO_MONITORADO`. Enriquecimento
   (4+1 propostas, e-mail, agent_state) num helper compartilhado.
3. **Confiar no Bastão (oc stale/fora de ordem):** rota relacionamento→extravio
   passa pela **mesma janela pós-lançamento de 60min** (INV-003,
   `bastaoEhMesmoSnapshotDoLancamento`). Stale dentro da janela é ignorado; só
   vira "mudança suspeita" se, passada a janela, o extravio persistir.
4. **Mudança suspeita relacionamento→extravio** (erro de processo, sem
   intertravamento na empresa): a regra primária manda o card pra Extravios, MAS:
   - card em **laranja** + **banner no topo** ("Agente detectou mudança suspeita
     — NF XXXX"), que some quando o operador abre o card;
   - ações de correção: voltar via **oc 49**, **relançar 54 c/ e-mail**, e
     **lançar 54 SEM e-mail** (corrigir lançamento errado sem e-mailar o cliente);
   - **Respeita o lock existente:** se o card estava **lockado** em AGUARDANDO_VOCÊ
     (`AGUARDANDO_VALIDACAO_HUMANA`), ele **permanece lockado lá** (regra
     `alteracao_oc_durante_lock`, mig 196) + flag laranja; só **move pra Extravios
     quando o operador dá OK** (desbloqueia). Se não estava lockado
     (AGUARDANDO_CLIENTE), move direto com o flag.

## Consequências

- `sync-bastao` assume mais responsabilidade (e mais peso). Mitigação: o
  enriquecimento de extravio é barato e budgetado; quando o volume crescer,
  aplicar o mesmo orçamento de tempo da reconciliação (RECONC_BUDGET_MS).
- Invariantes preservadas: INV-003 (janela), INV-006 (oc54⟺AGUARDANDO_CLIENTE),
  INV-007 (ACAO_EXECUTADA), INV-008 (fonte única estendida, não duplicada).
- Reversível via flag (kill-switch desliga o ramo de extravio sem afetar
  relacionamento).
