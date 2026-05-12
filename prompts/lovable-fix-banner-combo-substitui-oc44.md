# Lovable — FIX: banner "Sugestão da IA" mostra combo quando combo é sugerido (não 2 sugestões)

## Problema atual

No card NF 919304 a UI está renderizando **2 sugestões simultâneas**:
1. Banner superior: "Sugestão da IA — Lançar oc 44 (95%)" com botão `[APROVAR OC 44]`
2. Lista de ações: destaque na 6ª opção "Lançar 33 + Lançar 44 (Ressarcimento)" com ⭐

A Larissa vê dois caminhos recomendados diferentes. A regra é: **a IA sugere UMA coisa só**.

## Fix

No componente que renderiza o banner "Sugestão da IA" (topo da coluna direita), trocar a lógica de renderização pra:

```ts
const ia = card.ia_sugestao_oc_resposta;
const ehComboSugerido = ia?.sugere_combo_33_44 === true;

// Banner principal — UMA renderização condicional
let bannerTitulo, bannerMotivo, bannerBotaoLabel, bannerOnClick;

if (ehComboSugerido) {
  bannerTitulo = "Lançar 33 + Lançar 44 — Ressarcimento";
  bannerMotivo = ia.motivo_combo;  // texto específico do combo
  bannerBotaoLabel = "Aprovar Combo 33+44";
  bannerOnClick = () => abrirModalCombo33_44(card.todos.find(t => t.proposta_payload?.tool === "lancar_combo_33_44"));
} else {
  // Comportamento atual: banner mostra a oc solo sugerida
  bannerTitulo = `Lançar oc ${ia.oc_sugerida} — ${descricaoCurta(ia.oc_sugerida)}`;
  bannerMotivo = ia.motivo;
  bannerBotaoLabel = `Aprovar oc ${ia.oc_sugerida}`;
  bannerOnClick = () => abrirAprovacaoOc(ia.oc_sugerida);
}
```

## Visual esperado (NF 919304 hoje)

Antes (errado — 2 sugestões):
```
[Banner topo: Lançar oc 44 (95%) — Aprovar OC 44]
[Lista: ⭐ Lançar 33 + 44 (Ressarcimento)]
```

Depois (correto — 1 sugestão):
```
[Banner topo: Lançar 33 + 44 — Ressarcimento (95%) — Aprovar Combo 33+44]
[Lista: ⭐ Lançar 33 + 44 (Ressarcimento)  <- continua destacada como reforço visual]
```

## Resumo do fix

- Quando `card.ia_sugestao_oc_resposta.sugere_combo_33_44 === true`:
  - Banner principal **MUDA** pra mostrar o combo (título, motivo, botão)
  - Botão do banner abre o modal de aprovação do combo (mesmo modal da Mudança 3 do prompt anterior)
- Quando `false` ou ausente:
  - Banner mostra a oc solo sugerida (comportamento atual mantido)

A 6ª proposta na lista continua com destaque ⭐ — mas é só **reforço visual**, não um caminho paralelo de aprovação. O botão de ação é o do banner superior.
