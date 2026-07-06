# Lovable — CORREÇÃO URGENTE: detalhe do card continua sem otimização

**Cole isto como a PRÓXIMA mensagem no chat do Lovable.** A mudança anterior **não teve
efeito visível nenhum** — abri o card e está idêntico. Rota afetada: **`/cards/:id`** (tela de
detalhe de um card, ex.: `/cards/1a3844d1-...`).

## O problema (com print em mãos)

Os **dois blocos do topo** do detalhe do card ocupam **mais de 50% da tela**, e a área de
trabalho de baixo (as abas **MENSAGENS / RESPOSTA / EVENTOS / HISTÓRICO SSW** + **Ações
propostas**) sobra como uma **faixa minúscula ilegível**. Os dois blocos são:

1. **Bloco VERMELHO** cujo título é **"⚠️ ÚLTIMA OCORRÊNCIA SE ALTEROU NA ÚLTIMA ATUALIZAÇÃO"**.
2. **Bloco da RECOMENDAÇÃO** cujo rótulo (eyebrow) é **"RECOMENDADO PELO AGENTE IA"** (o card
   com "Lançar oc=… + email", Confiança X%, e botões Aprovar / Expandir / Ver outras opções).

> Localize os blocos pelo **texto visível acima**, não por nome de componente interno. Se na
> mudança anterior você já criou um "colapsar/expandir", então o bug é que o **estado padrão
> ficou EXPANDIDO**. Esta correção é: **estado padrão = COLAPSADO**.

## A ÚNICA mudança que eu preciso (faça exatamente isto)

### 1. Os dois blocos abrem COLAPSADOS por padrão, como faixa de 1 linha (~40px de altura)

Cada bloco, colapsado, mostra só:
- Bloco 1 (vermelho): `⚠️ oc 19 → 33 · não-relacionamento` + botões `[Ver histórico SSW]`
  `[↻ Forçar atualização]` + chevron `[▾]`.
- Bloco 2 (recomendação): `✦ IA: oc=54 (85%) — ENTREGUE_COM_FALTA…` + botão `[✓ Aprovar oc=54+email]`
  + chevron `[▾]`.

Clicar no chevron `[▾]` expande aquele bloco pro conteúdo completo de hoje. `[▴]` recolhe de volta.
**Default = colapsado nos dois.**

### 2. O CORPO de baixo precisa PREENCHER o resto da altura da tela (isto é o que conserta o "sliver")

A página do detalhe deve ser um **flex column de altura 100%**:
```
┌ header do card (altura automática, sticky no topo) ────────────────┐
├ faixa do bloco 1 (colapsada, sticky) ─────────────────────────────┤
├ faixa do bloco 2 (colapsada, sticky) ─────────────────────────────┤
├ CORPO  → flex: 1 1 0; min-height: 0; overflow: hidden ────────────┤
│   [ Identificação ] [ Abas: Mensagens/Resposta/Eventos/Histórico ] [ Ações ]
│   ↑ o painel da aba ativa tem overflow-y: auto e rola INTERNAMENTE  │
└────────────────────────────────────────────────────────────────────┘
```
Regras CSS-chave (sem isso o conteúdo empurra a página e volta a espremer):
- Container da página: `display:flex; flex-direction:column; height:100vh` (ou a altura da área
  de conteúdo abaixo da topbar global).
- Header + as 2 faixas colapsadas: altura automática, `position:sticky; top:0`.
- **CORPO: `flex:1 1 0; min-height:0`** e o **painel da aba ativa** (onde aparece o HISTÓRICO
  SSW) com **`overflow-y:auto`** — assim o histórico longo rola **dentro do painel**, sem empurrar
  a página inteira pra baixo.

Resultado obrigatório: ao abrir o card, o **HISTÓRICO SSW aparece grande e legível** sem precisar
rolar a página; expandir uma faixa só empurra o conteúdo enquanto está aberta.

### 3. Toggle "Modo foco" no header + remover botão Forçar duplicado

- No header, adicionar um toggle **`◱ Modo foco`** que **expande/colapsa os dois blocos de uma
  vez**. Persistir em `localStorage['cockpit:cardDetalhe:modoFoco']`. **Default = ligado (colapsado).**
- No header existem **DOIS botões "FORÇAR ATUALIZAÇÃO" idênticos** — **manter só UM**.

## Não muda mais nada

Backend zero. Não tocar nos dados, nas RPCs, nas abas em si — só no **layout/estado padrão** dos
dois blocos do topo e na altura do corpo.

## Verificação (tem que ser VISIVELMENTE verdade depois da mudança — confira no preview)

Abrir a NF **696172** (MED CENTER COML A.):
1. Os dois blocos do topo aparecem como **duas faixas finas de 1 linha** (não os blocões de hoje).
2. A aba **HISTÓRICO SSW** ocupa a **maior parte da tela** e dá pra ler sem rolar a página.
3. Clicar `[▾]` na faixa da IA → expande só ela; `[▴]` recolhe.
4. Recarregar a página → continua colapsado (Modo foco persistido).
5. Só **1** botão "Forçar atualização" no header.

> Se você achar que "já está implementado", então o conserto é trocar o **estado inicial para
> colapsado** e aplicar o **flex-column com `overflow-y:auto` no painel da aba** — é isso que
> está faltando, porque na tela atual nada disso é visível.
