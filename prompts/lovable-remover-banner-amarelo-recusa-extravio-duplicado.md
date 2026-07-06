# Lovable — Remover o banner amarelo "Recusa originada de extravio" (duplicado)

## Problema
No detalhe do card, o bloco de **RECUSA ORIGINADA DE EXTRAVIO** (banner âmbar/amarelo,
standalone, com o ⚠️) está mostrando **exatamente o mesmo texto** que o card azul do agente
IA logo abaixo já mostra na linha "⚠️ CONFLITO DE CONTEXTO".

Os dois leem o MESMO campo do backend: `aviso_alteracao_oc.observacao_orquestrador`. O card
azul ainda é mais completo (traz o nome do template `RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR` no
título e os botões de ação). Então o banner amarelo é redundante.

Caso âncora: NF 3214 (F E F Distribuidora), CTRC BCN402540-7 — recusa oc=10 originada de
extravio oc=6.

## O que fazer
**Remover o banner amarelo standalone "Recusa originada de extravio"** do detalhe do card.

- É o bloco que hoje é renderizado quando
  `aviso_alteracao_oc.contexto_recusa_por_extravio === true` (criado no prompt
  `lovable-banner-recusa-por-extravio.md`). Apagar SÓ esse bloco de destaque âmbar.
- **NÃO** mexer no card azul do agente IA abaixo — ele continua mostrando a linha
  "⚠️ CONFLITO DE CONTEXTO ..." (que vem do mesmo `observacao_orquestrador`), o título
  "Lançar oc=54 + email — RECUSA_EXTRAVIO_DEVOLVER_OU_SEGUIR", a transcrição da ressalva e
  os botões. Toda a informação do amarelo já está nele.

## Não mexer (continuam valendo)
- O campo backend `contexto_recusa_por_extravio` / `observacao_orquestrador` continua existindo
  e sendo usado pelo card azul — não remover do payload, só não renderizar o banner amarelo.
- Nada de RPC nova, nada de backend. Mudança puramente visual (deletar 1 componente/bloco).

## Observação (edge case — só pra ter ciência, não bloqueia)
Se existir algum estado em que o card azul do agente NÃO aparece (ex.: ação já aprovada/
executada e a recomendação some) mas o card ainda tem `contexto_recusa_por_extravio === true`,
o operador deixaria de ver o aviso de conflito. Se quiser cobrir isso, dá pra manter uma
linha-resumo mínima do conflito só quando o card do agente não estiver renderizado. Mas pelo
fluxo normal (recomendação pendente = card azul presente) a remoção é segura.
