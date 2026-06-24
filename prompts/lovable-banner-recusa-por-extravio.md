# Lovable — Banner "⚠️ Recusa por extravio" no detalhe do card

## Contexto
Quando uma recusa/falta no destino (oc 10/19/35) foi **causada por um extravio anterior**
(oc 6/9/16) que o cliente ainda não foi notificado, o agente (`agente-sugere-ocs-padrao`)
detecta a sequência e já sugere o e-mail **combinado** (perguntar devolução x reentrega +
pedir romaneio/descrição/valor). O operador precisa VER esse conflito de contexto destacado,
porque a recusa "comum" e a "recusa por extravio" pedem tratativas diferentes.

Caso âncora: NF 148558 (oc=6 → entrega → oc=10 "não recebe faltando volume"). Validado ao
vivo na NF 30264.

## De onde vêm os dados (backend já entrega — NÃO precisa de RPC nova)
Tudo já está gravado em `cards.aviso_alteracao_oc` (JSONB), no mesmo objeto que o front já
lê pra mostrar o card do agente / sugestão de ocs padrão (`tipo = 'ia_sugestao_ocs_padrao'`).
Campos NOVOS desse objeto:

- `contexto_recusa_por_extravio` (boolean | null) — quando `true`, mostrar o banner.
- `extravio_anterior_oc` (number | null) — a oc do extravio que originou a recusa (ex: 6).
- `extravio_anterior_data` (string | null) — data/hora do extravio no SSW (ex: "19/06/26 10:43").
- `observacao_orquestrador` (string) — já existe; nesse caso vem com o texto
  "⚠️ CONFLITO DE CONTEXTO: a recusa (oc=NN) foi originada de um extravio anterior...".
- `template_email_sugerido` (string) — já existe; nesse caso = `RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR`.

## O que fazer no front
No componente de detalhe do card (onde já aparece o card do agente / banner de sugestão IA),
quando `aviso_alteracao_oc.contexto_recusa_por_extravio === true`, renderizar um bloco de
destaque ACIMA da sugestão de e-mail:

- Estilo: chip/banner de ALERTA (âmbar/amarelo), ícone ⚠️, mais forte que o aviso comum.
- Título: **"Recusa originada de extravio"**.
- Texto: usar `observacao_orquestrador` diretamente (já vem pronto e explicativo). Se quiser
  uma linha-resumo própria, montar:
  `"A recusa (oc {codigo_oc_card}) veio de um extravio anterior (oc {extravio_anterior_oc} em {extravio_anterior_data}) ainda não notificado ao cliente. O e-mail sugerido já pede devolução×reentrega E romaneio/descrição/valor pra ressarcimento."`
- Não precisa botão novo: o template combinado (`RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR`) já vem
  selecionado por padrão no modal de e-mail e já aparece no dropdown (backend cuidou disso).

## Aba CONFLITOS / resposta incompleta (já existe — só conferir)
Quando o cliente responde, o `interpretador-resposta-cliente` agora exige romaneio + descrição
+ valor antes de sugerir o combo 33+44. Se vier incompleto, ele preenche
`pendencias_resposta_cliente` (array de strings) com o que falta pra abrir a oc=33
(ex: "Cliente autorizou devolução mas não enviou romaneio/descrição/valor — falta pra oc=33").
Esse array **já é renderizado** hoje no bloco de pendências da resposta do cliente — só
garantir que continua aparecendo (nenhuma mudança nova necessária aqui).

## Importante
- Não inventar texto: priorizar `observacao_orquestrador` (vem do agente, já em PT-BR).
- O banner é puramente informativo/visual — toda a lógica (detecção, template, completude)
  é backend. Não duplicar regra no front.
