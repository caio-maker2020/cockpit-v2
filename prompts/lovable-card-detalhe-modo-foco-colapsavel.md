# Lovable — Detalhe do card: enxugar o topo (blocos colapsáveis + Modo Foco)

**Data:** 2026-06-22
**Escopo:** 100% frontend. NÃO mexe em backend — todos os dados já chegam no card.

## Problema (caso real — NF 1057283, UNIAO QUIMICA, LARISSA)

Quando um card tem **dois blocos pesados no topo ao mesmo tempo**, a tela fica
intransitável: o operador não consegue chegar no que importa (o **histórico SSW** e as
**mensagens**) sem rolar muito, e visualmente polui.

Os dois blocos que empilham:

1. **Banner vermelho de conflito** — "⚠️ ÚLTIMA OCORRÊNCIA SE ALTEROU NA ÚLTIMA ATUALIZAÇÃO"
   (vem de `cards.mudanca_suspeita`, `tipo='saiu_de_escopo'`). Ocupa ~130px.
2. **Card amarelo do agente IA** — "RECOMENDADO PELO AGENTE IA · OPERAÇÃO REVISA ANTES"
   (vem de `cards.aviso_alteracao_oc`, componente `BannerSugestaoIA`). Ocupa ~280px, mais o
   badge verde "IA validou: foto OK na linha da oc 35" e o aviso "RESSALVA MANUSCRITA".

Juntos jogam as abas (**MENSAGENS / RESPOSTA / EVENTOS / HISTÓRICO SSW**) e o painel
**Ações propostas** pra baixo da dobra. Além disso há **3 botões "FORÇAR ATUALIZAÇÃO"** na
tela (2 idênticos no header + 1 no banner) = ruído.

O operador pediu, literalmente: **conseguir trazer a parte de baixo (abas/histórico) pra cima,
e conseguir diminuir o "recomendado pelo agente".** Em resumo: **deixar leve.**

---

## Backend — nada a fazer

Tudo já chega no SELECT do card. Não criar tabela, RPC nem coluna. Fontes que esta tela usa:

| Bloco | Fonte | Condição de render |
|---|---|---|
| Banner de conflito | `cards.mudanca_suspeita` (jsonb: `tipo, de_oc, para_oc, vista_em`) | `tipo==='saiu_de_escopo' && !vista_em` |
| Card do agente IA | `cards.aviso_alteracao_oc` (jsonb: `tipo, sugestao, template, confianca, motivo_extraido, observacao`) | `tipo` ∈ sugestões IA (já mapeado no `BannerSugestaoIA`) |
| Badge de evidência | `cards.ia_sugestao_evidencia` / `evidencia_status` | como hoje |
| Abas | `historico_ssw`, `mensagens`, `eventos`, `resposta` | como hoje |
| Forçar atualização | edge `atualizar-card-via-portal-ssw` (preview + aplicar) + RPC `liberar_card_suspeito_lockado` | como em `lovable-aba-conflitos-forcar-atualizacao.md` |

---

## Solução — 3 mecanismos (do mais importante pro detalhe)

### A) Cada bloco pesado do topo vira COLAPSÁVEL, com strip compacta de 1 linha

Tanto o banner de conflito quanto o card do agente ganham um **chevron de recolher/expandir**.
Recolhido, cada um vira uma **faixa fina (~38px) de 1 linha** que preserva a informação-chave
e os botões de ação — sem o bloco gigante.

**Banner de conflito — expandido (igual hoje) vs recolhido:**
```
EXPANDIDO (atual):
┌──────────────────────────────────────────────────────────────── [▴] ┐
│ ⚠️ ÚLTIMA OCORRÊNCIA SE ALTEROU NA ÚLTIMA ATUALIZAÇÃO                 │
│ A ocorrência mudou de oc 35 → oc 56. Não é de relacionamento.        │
│ Verifique o histórico e decida.                                      │
│ [ Ver histórico SSW ]   [ ↻ Forçar atualização ]                     │
└──────────────────────────────────────────────────────────────────────┘

RECOLHIDO (faixa fina):
┌──────────────────────────────────────────────────────────────────────┐
│ ⚠️ oc 35 → 56 · não-relacionamento   [Histórico] [↻ Forçar]      [▾] │
└──────────────────────────────────────────────────────────────────────┘
```

**Card do agente IA — expandido (igual hoje) vs recolhido:**
```
EXPANDIDO (atual, só com padding mais enxuto):
┌──────────────────────────────────────────────────────── [▴ Recolher] ┐
│ ✦ RECOMENDADO PELO AGENTE IA · OPERAÇÃO REVISA ANTES                  │
│ Lançar oc=56 — Falta info operacional   [Confiança: média (75%)]      │
│ 📝 RESSALVA MANUSCRITA — IA não achou ressalva legível, revisar.      │
│ oc=35 sem motivo escrito… sugere oc=56 pra operação revisar.          │
│ [ ✓ Aprovar oc=56 ]   Ver outras opções →     ✓ IA acertou ·✗ errou  │
└──────────────────────────────────────────────────────────────────────┘

RECOLHIDO (faixa fina):
┌──────────────────────────────────────────────────────────────────────┐
│ ✦ IA: oc=56 (75%) — Falta info operacional   [✓ Aprovar oc=56]   [▾] │
└──────────────────────────────────────────────────────────────────────┘
```

Regras:
- O **badge verde "IA validou: foto OK…"** e o aviso **"RESSALVA MANUSCRITA"** fazem parte do
  bloco do agente — somem junto quando ele recolhe, aparecem quando expande.
- Recolher é **animado** (height/opacity, ~150ms), sem "pulo" de layout.
- Os botões de ação **continuam acessíveis na faixa fina** (não esconder o "Aprovar" nem o
  "Forçar" no recolhido) — recolher é pra ganhar espaço, não pra perder ação.

### B) "Modo Foco" no header — 1 clique recolhe TODO o topo e traz as abas pra cima

No header do card, ao lado das ações, um toggle:
```
[ ◱ Modo foco ]   (quando ativo: [ ◲ Modo foco ✓ ] em destaque sutil)
```
- **Ativar** = recolhe de uma vez o banner de conflito **e** o card do agente nas faixas finas →
  as abas (HISTÓRICO SSW / MENSAGENS…) sobem pra logo abaixo do header. É o "trazer a parte de
  baixo pra cima" que o operador pediu.
- **Desativar** = reexpande os dois.
- Os chevrons individuais (mecanismo A) continuam funcionando por cima — o operador pode estar
  em Modo Foco e expandir só o agente, por exemplo.

### C) Header + faixas finas ficam STICKY (grudam no topo ao rolar)

- O **header do card** (título, NF, VOL, CTRC, badge de estado, ações) vira `position: sticky`
  no topo da área de conteúdo.
- Quando um bloco está **recolhido**, sua faixa fina também gruda logo abaixo do header.
- Assim, rolando o histórico, o operador **nunca perde** o contexto (NF/CTRC), o alerta de
  conflito, nem os botões de ação. É o que mais "tira a poluição": a informação crítica vira
  uma régua fina fixa em vez de um muro.

---

## Persistência (localStorage)

- **Modo Foco é preferência GLOBAL do operador** (vale pra todos os cards), chave
  `cockpit:cardDetalhe:modoFoco` (`'1'`/`'0'`). Uma vez que o operador gostou de abrir enxuto,
  todo card abre enxuto. Default = `'0'` (compatível com hoje) — mas tende a virar `'1'` rápido.
- Os chevrons individuais sobrescrevem só na sessão do card atual; ao reabrir, voltam a seguir o
  Modo Foco global. (Não precisa persistir por-card; manter simples.)

---

## Consolidar os botões "FORÇAR ATUALIZAÇÃO" (parte da poluição)

Hoje há **3** na tela. Reduzir pra **2**, sem ambiguidade:
- **Header:** manter **UM** só botão `↻ Forçar atualização` (remover o duplicado idêntico).
  Estilo secundário/outline — só fica vermelho-cheio quando há `mudanca_suspeita` pendente.
- **Banner/faixa de conflito:** manter o `↻ Forçar` dele (é o CTA contextual do alerta).
- O `?` de ajuda e o `↰ Voltar pra to-do` continuam.

Ambos os "Forçar" disparam o **mesmo fluxo** já documentado em
`lovable-aba-conflitos-forcar-atualizacao.md` (preview `atualizar-card-via-portal-ssw` com
`{ card_id, preview:true }` → modal → no "Sim": `liberar_card_suspeito_lockado` +
`atualizar-card-via-portal-ssw`). **Não duplicar lógica** — extrair um único handler
`forcarAtualizacao(card_id)` e os dois botões chamam ele.

---

## Detalhe fino que melhora muito: aba certa por padrão

Quando o card tem `mudanca_suspeita.tipo==='saiu_de_escopo'`, o trabalho do operador é **ler o
histórico** pra decidir. Então:
- Ao abrir esse card, **pré-selecionar a aba `HISTÓRICO SSW`** (em vez de `MENSAGENS`).
- O botão **"Ver histórico SSW"** (do banner/faixa de conflito) só troca pra essa aba + dá um
  scroll suave até ela (já que com Modo Foco/sticky ela está logo abaixo).

---

## Tokens visuais (design system v3 — manter a linguagem)

- Fontes: corpo/título `Bricolage Grotesque` (`--font-body`), dados técnicos (NF, CTRC, oc, %)
  `JetBrains Mono` (`--font-mono`).
- Conflito: vermelho Sal `--signal #E11D2A` sobre `--signal-soft #FDE9EB`. Faixa fina recolhida =
  fundo `--signal-soft`, borda-esquerda 3px `--signal`, texto `--ink`.
- Agente IA: âmbar `--warning #B45309` sobre `--warning-soft #FBF1DA` (variante "OPERAÇÃO REVISA
  ANTES"). Faixa fina = mesmo tom, borda-esquerda 3px `--warning`.
- Badge "IA validou": `--positive #166534` sobre `--positive-soft #E2F1E5`.
- Chevrons / toggle Modo Foco: ícone discreto `--ink-mute #7A766E`, sem peso visual.
- Superfícies: card em `--bg-elevated #FFFFFF` sobre `--bg #F5F1EA`.
- **Apertar o respiro:** reduzir padding vertical dos blocos do topo (~16px → ~12px) e os gaps
  entre blocos. O objetivo declarado é **leveza**.

---

## Smoke test

1. NF 1057283 (UNIAO QUIMICA, LARISSA) — abrir o card. Conferir banner de conflito (oc 35→56) +
   card do agente (oc=56, 75%) renderizando.
2. Clicar **Modo Foco** → os dois viram faixas finas; abas sobem pra logo abaixo do header;
   `HISTÓRICO SSW` já selecionada. Recarregar a página → continua em Modo Foco (preferência global).
3. Com Modo Foco ON, clicar o chevron `[▾]` da faixa do agente → só ele expande; conflito segue fino.
4. Rolar o histórico → header + faixas finas grudam no topo (sticky); botões de ação visíveis.
5. Clicar **↻ Forçar** (header) e **↻ Forçar** (faixa de conflito) → ambos abrem o MESMO modal de
   preview (mesmo handler). Confirmar fluxo `atualizar-card-via-portal-ssw`.
6. Abrir um card SEM conflito e SEM sugestão IA → topo limpo como hoje; Modo Foco não muda nada
   visível (não há o que recolher); 1 só botão Forçar no header.

---

## Resumo de 1 linha

No detalhe do card, cada bloco pesado do topo (conflito `mudanca_suspeita` + agente
`aviso_alteracao_oc`) vira **colapsável** numa faixa fina, com **Modo Foco** (preferência global,
1 clique recolhe tudo e traz as abas pra cima) e **header+faixas sticky**; consolida os 3
"Forçar atualização" em 2 chamando um handler único; pré-seleciona `HISTÓRICO SSW` quando há
conflito. Zero mudança de backend.
