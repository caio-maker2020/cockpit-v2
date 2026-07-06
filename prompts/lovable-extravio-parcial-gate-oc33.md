# Lovable — Extravio parcial: banner "faltam descrição/valor" + oc 33 desabilitada

Contexto (backend já pronto): em **extravio parcial** a oc 33 (reversão de perdas /
handoff pro Ressarcimento) tem duas naturezas e só pode ser lançada quando o cliente
enviou as informações necessárias. O backend agora rastreia isso num **dossiê** e
**anota cada proposta de oc 33** com o resultado do gate. O front precisa refletir isso.

## O que muda no front

Para cada card, cada `todo` de proposta traz em `proposta_payload.meta.gate_oc33`
(quando o card é extravio parcial e a ação é uma oc 33). Shape:

```json
"meta": {
  "gate_oc33": {
    "natureza": "operacional" | "completude",
    "bloqueada": true | false,
    "faltando": ["romaneio de coleta assinado", "descrição dos itens", "valor dos itens"]
  }
}
```

Regras de renderização (só quando `meta.gate_oc33` existe):

1. **`bloqueada = true`** → renderizar o botão da oc 33 **desabilitado**, com um selo/aviso
   ao lado: **"Faltam: {faltando.join(", ")}"** (ex.: "Faltam: descrição dos itens, valor
   dos itens"). Tooltip: "O Ressarcimento só abre o processo com romaneio + descrição dos
   itens + valor dos itens. Cobre o que falta com o cliente antes de lançar a oc 33."
2. **`bloqueada = false`** → botão normal (habilitado).
3. **`natureza`**: use para o rótulo — `completude` = "Lançar oc 33 (indenização — precisa
   das 3 informações)"; `operacional` = "Lançar oc 33 + 44 (devolução — precisa do romaneio)".
   Destaque a ação **pela `acao_key` / natureza, NUNCA pelo número da oc** (mesma regra do
   banner 54+email vs sem-email — dois todos cod=33 são ações distintas).

## Forçar em caso excepcional (escape hatch)

Quando o botão está desabilitado (`bloqueada = true`) e a operadora **precisa** lançar
mesmo assim, ofereça uma ação secundária discreta ("Lançar mesmo assim" / checkbox
"Ignorar checagem de completude"). Ao aprovar por esse caminho, inclua nos `extras` do
`aprovar_e_executar`:

```json
"extras": { "forcar_oc33_dossie_incompleto": true, ... }
```

O executor aceita o override, grava auditoria (`card_event Oc33ForcadaDossieIncompleto`)
e lança. Sem esse flag, o executor recusa a oc 33 de completude com dossiê incompleto
(quando o enforce estiver ligado).

## Observações

- Extravio **total** e demais fluxos **não têm** `meta.gate_oc33` → nada muda (não
  desabilitar nada nesses casos).
- Enquanto o backend estiver em sombra (flag `extravio_parcial_gate_enforce` OFF), a
  anotação já chega — o front pode começar mostrando o aviso "Faltam: ..." mesmo sem
  desabilitar (informativo). Quando o Caio ligar o enforce, aí sim desabilite o botão.
  (Se preferir simplicidade, pode já desabilitar desde o começo — o backend só executa
  com o override de qualquer forma quando enforce estiver ON.)
- Campos de dossiê para eventual detalhamento na UI: o card emite `card_event`
  `DossieExtravioAtualizado` com `{ completo, faltando, caso }` a cada resposta do cliente.
