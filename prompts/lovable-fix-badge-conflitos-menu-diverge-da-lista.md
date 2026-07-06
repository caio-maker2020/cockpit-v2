# Lovable — FIX: badge "Conflitos" do menu lateral diverge da lista (23 vs 6)

## Problema
No menu lateral, o item **Conflitos** mostra um badge com **23**, mas ao abrir a aba a lista
(e o badge do título "⚠️ Conflitos") mostram **6**. Os dois números deveriam ser idênticos.

Confirmado no backend: **não existe nenhuma contagem que dê 23**. A fonte única e correta é a
view `v_cards_requer_atencao`, que retorna **6**. O 23 é um contador calculado/cacheado à parte
no front que NÃO decrementa quando um conflito é resolvido (operador clica "Forçar atualização",
card vira TRANSFERIDO/RESOLVIDO, etc.).

## Fonte da verdade (já existe — NÃO precisa de RPC/migração nova)
A lista da aba Conflitos e o badge do título já leem desta view:

- **View:** `v_cards_requer_atencao`
- **O que ela já filtra (backend, mig 229):**
  - `mudanca_suspeita->>'tipo' = 'saiu_de_escopo'`
  - `mudanca_suspeita->>'vista_em' IS NULL` (ainda não resolvido)
  - `state IN ('AGUARDANDO_VALIDACAO_HUMANA','AGUARDANDO_CLIENTE')` (só cards ainda no escopo
    protegido — cards já TRANSFERIDO/RESOLVIDO NÃO entram, de propósito)
- **Contagem atual:** 6.

> Importante: existem hoje ~10 cards já TRANSFERIDO com o flag `saiu_de_escopo` ainda pendurado.
> A view 229 já os exclui corretamente. O badge do menu NÃO pode contá-los.

## O que fazer no front
1. **O badge do menu lateral "Conflitos" deve usar EXATAMENTE a mesma fonte que a lista da aba**
   — ou seja, `count`/`length` do SELECT de `v_cards_requer_atencao` (mesma query, mesmos
   filtros, mesma RLS). NÃO usar uma segunda query/contador separado, nem um número derivado de
   eventos de detecção, nem um valor cacheado no mount do app.

2. **Refetch nos mesmos gatilhos da aba**, pra nunca driftar:
   - no load inicial do app;
   - a cada tick de SYNC / atualização realtime de `cards`;
   - **depois de "Forçar atualização"** de um conflito (a ação que resolve o card precisa
     re-disparar a contagem → o badge decrementa na hora).

3. **Regra de exibição:** mostrar o badge só quando `> 0`; quando `0`, esconder (sem badge).

## Critério de aceite
- Badge do menu lateral === badge do título "⚠️ Conflitos" === número de cards na lista, **sempre**.
- Após resolver/forçar um conflito, o badge do menu cai imediatamente (não fica preso no número
  antigo).
- Nenhum card em estado TRANSFERIDO/RESOLVIDO é contado.

## Não mexer
- Backend: a view `v_cards_requer_atencao` já está correta (retorna 6). Nada de RPC/migração.
- A lista e o badge do título já estão certos — só alinhar o badge do menu lateral à mesma fonte.
