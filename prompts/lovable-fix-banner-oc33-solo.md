# Lovable — FIX: banner "Sugestão da IA" cobre também oc=33 SOLO (extravio total)

## Contexto

A IA do interpretador agora distingue 3 cenários de indenização (Caio 2026-05-12):

1. `sugere_combo_33_44 = true` → recomenda combo 33+44 (ressarcimento com devolução).
2. `sugere_oc33_solo = true` → recomenda oc=33 solo (extravio total — sem devolução).
3. Ambos `false` → banner mostra a oc solo sugerida normalmente (44/21/56/54).

Os 2 booleans são **mutuamente exclusivos** (back garante: se IA marcar ambos, força combo=false).

## O que mudar no banner

Estender a lógica do banner principal (descrito em [prompts/lovable-fix-banner-combo-substitui-oc44.md](prompts/lovable-fix-banner-combo-substitui-oc44.md)) pra cobrir o caso oc33_solo:

```ts
const ia = card.ia_sugestao_oc_resposta;
const ehComboSugerido = ia?.sugere_combo_33_44 === true;
const ehOc33SoloSugerido = ia?.sugere_oc33_solo === true;

let bannerTitulo, bannerMotivo, bannerBotaoLabel, bannerOnClick;

if (ehComboSugerido) {
  bannerTitulo = "Lançar 33 + Lançar 44 — Ressarcimento";
  bannerMotivo = ia.motivo_combo;
  bannerBotaoLabel = "Aprovar Combo 33+44";
  bannerOnClick = () => abrirModalCombo33_44(
    card.todos.find(t => t.proposta_payload?.tool === "lancar_combo_33_44")
  );
} else if (ehOc33SoloSugerido) {
  bannerTitulo = "Lançar oc 33 — Reversão de Perdas (extravio total)";
  bannerMotivo = ia.motivo_combo;  // mesmo campo é reusado pra justificar oc33_solo
  bannerBotaoLabel = "Aprovar oc 33 (sem 44)";
  bannerOnClick = () => abrirModalOc33Solo(
    card.todos.find(t => t.proposta_payload?.tool === "lancar_oc33_solo_portal")
  );
} else {
  // Banner mostra a oc solo sugerida (44/21/56/54)
  bannerTitulo = `Lançar oc ${ia.oc_sugerida} — ${descricaoCurta(ia.oc_sugerida)}`;
  bannerMotivo = ia.motivo;
  bannerBotaoLabel = `Aprovar oc ${ia.oc_sugerida}`;
  bannerOnClick = () => abrirAprovacaoOc(ia.oc_sugerida);
}
```

## Modal de aprovação reusado

Quando Larissa clica em "Aprovar oc 33 (sem 44)" no banner, **abrir o modal de oc=33 solo** já criado em [prompts/lovable-aprovar-oc33-solo.md](prompts/lovable-aprovar-oc33-solo.md) — 1 bloco com textarea + escolha de anexo.

O todoId a passar é o do todo com `proposta_payload.tool === "lancar_oc33_solo_portal"` (sempre existe entre as 7 propostas pós-resposta cliente, criado pelo vinculador).

## Reforço visual na lista de propostas

Mesma regra do combo: a 7ª proposta "Lançar oc 33 (sem 44)" também ganha ⭐ destaque quando `sugere_oc33_solo=true`.

```ts
const propostaDestacada = (todo: Todo) => {
  const tipoAcao = todo.proposta_payload?.meta?.tipo_acao;
  if (ehComboSugerido && tipoAcao === 'combo_33_44') return true;
  if (ehOc33SoloSugerido && tipoAcao === 'oc33_solo') return true;
  return false;
};
```

## Visual esperado (NF 607458 — caso âncora extravio total)

```
[Banner topo: Lançar oc 33 — Reversão de Perdas (extravio total) (95%)
              Aprovar oc 33 (sem 44)]
[Lista de 7 propostas:
   1. Lançar oc 21 — Reentrega
   2. Lançar oc 44 — Devolução
   3. Lançar oc 54 — Re-aguardar
   4. Lançar oc 56 — Falta info
   5. Lançar 33 + 44 — Ressarcimento
   6. ⭐ Lançar oc 33 — Reversão de Perdas (extravio total)
   ...
]
```

## Por que importa

Cenário NF 607458: extravio TOTAL (toda a NF perdida, 0 volumes a devolver). IA antiga sugeriu combo 33+44 — errado, porque oc=44 (devolução) não se aplica a algo que não existe mais. IA nova com a regra de extravio total sugere oc=33 solo.

Se o banner ignorar `sugere_oc33_solo`, Larissa continua vendo a sugestão antiga (44 ou combo) e desperdiça oc=44.

## Backend (já no ar)

- [supabase/functions/interpretador-resposta-cliente/index.ts](supabase/functions/interpretador-resposta-cliente/index.ts): SYSTEM_PROMPT atualizado, schema aceita `oc_sugerida=33`, persiste `sugere_oc33_solo`.
- Mutual exclusion garantida no back (se IA marcar ambos, força combo=false).

## Resumo

Adicionar **um terceiro caminho** no if/else do banner principal: `ehOc33SoloSugerido` → título "extravio total", botão "Aprovar oc 33 (sem 44)", abre modal de [aprovar-oc33-solo](prompts/lovable-aprovar-oc33-solo.md). Reforço visual ⭐ na 7ª proposta da lista quando flag está ativa.
