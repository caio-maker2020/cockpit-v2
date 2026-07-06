# Lovable — Lista de ações sugeridas: cada ação UMA vez (sem duplicar)

## Contexto
A lista de "ações sugeridas" do card mostrava a mesma ação repetida (ex.: "Lançar 54 + e-mail" aparecendo 2×, "54 sem e-mail" várias vezes, oc 49 duplicada). A causa principal era **duplicação no banco** (vários todos da mesma ação) — isso já foi corrigido no backend (dedup + índice único `uniq_todos_card_acao_key_ativo`: no máx 1 todo ativo por `card_id` + `acao_key`). Então a lista já deve vir sem duplicatas.

## Garantir no front (defensivo)
Mesmo com o banco limpo, o front deve renderizar **cada ação uma única vez** e não repetir a ação destacada na lista:

1. **Deduplicar por `acao_key`** ao renderizar a lista de ações: se vierem 2 todos com o mesmo `proposta_payload.acao_key`, mostrar só 1 (preferir status `aprovado`; senão o mais recente).
2. **Não repetir o destaque na lista:** a ação recomendada (a do banner, identificada por `card.analise_padrao_resultado.proposta_destacada_acao` OU `proposta_payload.recomendada === true`) aparece no destaque/topo **com selo** — NÃO renderizá-la de novo na lista abaixo. Cada `acao_key` aparece em UM lugar só.
3. **Estilo das opções 54** (manter o que já existe nos prints bons):
   - `meta.modo === 'completo'` → selo VERDE **"✉ + E-MAIL AO CLIENTE"**. **NÃO** decidir o selo pelo `tool`: o fluxo de extravio usa `tool === 'lancar_oc_e_enviar_email'` MESMO em ações SEM e-mail (ex.: "Lançar oc 49 — PRAZO DE PERDAS EXPIRADO" tem `modo='sem_email'` + `extras.enviar_email=false`). Decidir pelo tool faz a oc 49 mostrar "+ e-mail" errado. **Regra: o selo verde sai SÓ quando `meta.modo === 'completo'`; caso contrário, sem selo de e-mail.**
   - `meta.sem_email_explicito === true` → selo ÂMBAR **"🚫 SEM E-MAIL — CLIENTE NÃO SERÁ NOTIFICADO"** + texto "Lança só a oc no SSW; use quando o cliente já foi avisado por outro canal."
   - Não exibir versões antigas sem selo da MESMA ação (eram os duplicados).

## Critério de aceite
- Numa NF com oc 54, aparece **uma** opção "54 + e-mail" (verde) e **uma** "54 sem e-mail" (âmbar) — nunca repetidas, nunca a mesma ação em dois estilos.
- oc 49 (e demais) aparece **uma vez** só.
- A ação recomendada aparece só no destaque (com selo), não duplicada na lista.
