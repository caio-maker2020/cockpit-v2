# Lovable — Modal de "Lançar 54 + email" em oc=20 com dropdown de template

**Data:** 2026-05-15
**Backend:** já deployado (regra `oc=20` em `regras-auto-acao.ts` + executor já suporta `extras.template_id_override`).

## Contexto

O Cockpit hoje cria propostas automáticas para cards baseado na última ocorrência (`cod_ultima_ocorrencia`). Cards em **oc=20 (extravio localizado)** agora têm 2 propostas (era 1):

1. **"Lançar oc 55 — autorizar seguir entrega"** (já existia, sem mudança)
2. **"Lançar oc 54 + email pro cliente — operadora escolhe template"** (NOVA)

A nova proposta vem do backend com `tool='lancar_oc_e_enviar_email'`, `args.codigo_ssw=54`, `args.template_id='FALTA_DE_VOLUME'` (template default).

## A mudança no frontend

Quando Larissa clicar pra aprovar a proposta **"Lançar oc 54 + email"** **especificamente em um card com `cod_ultima_ocorrencia=20`**, o modal de aprovação deve mostrar um **dropdown** com 4 opções de template. Larissa escolhe qual usar. O template selecionado vai no payload como `extras.template_id_override`.

**Importante:** essa mudança aplica-se SÓ a cards com `cod_ultima_ocorrencia=20`. Os modais das mesmas propostas em oc=10/11/35/49/19/54 seguem com template fixo como hoje (sem dropdown).

### Identificação da proposta

A proposta a ser tratada com dropdown tem:
- `cod_ultima_ocorrencia` do card == `20`
- `proposta_payload.tool` == `"lancar_oc_e_enviar_email"`
- `proposta_payload.args.codigo_ssw` == `54`

### Layout do modal

```
┌──────────────────────────────────────────────────────────────┐
│ Aprovar — Lançar oc 54 + email pro cliente                   │
│                                                              │
│ Card: NF 351954 • Cliente: ALTHAIA                           │
│ Última ocorrência no Bastão: 20 (extravio localizado)        │
│                                                              │
│ Template de email:                                           │
│ ┌────────────────────────────────────────────────────────┐   │
│ │ FALTA_DE_VOLUME                                     ▼  │   │ ← dropdown
│ └────────────────────────────────────────────────────────┘   │
│                                                              │
│ Destinatários (já preenchidos pelo Bastão):                  │
│ • allyson.dias@althaia.com.br                                │
│ • bianca.borges@althaia.com.br                               │
│                                                              │
│ [Preview do email vai re-renderizar ao trocar template]      │
│                                                              │
│ Assunto (editável): EXTRAVIO COLETA TOTAL NF ... — ALTHAIA   │
│ Corpo (editável): Olá, Bom Dia ...                           │
│                                                              │
│                             [ Cancelar ]  [ Aprovar e executar ]
└──────────────────────────────────────────────────────────────┘
```

### Conteúdo do dropdown

4 opções fixas, **nessa ordem**, com label legível:

| Valor enviado (`template_id_override`) | Label exibido no dropdown |
|---|---|
| `FALTA_DE_VOLUME` | Falta de volume (default — aguardando retorno do cliente) |
| `RECUSA_TOTAL` | Recusa total |
| `PROBLEMAS_COM_ENDERECO` | Problemas com endereço |
| `RECUSA_PARCIAL` | Recusa parcial |

**Default:** `FALTA_DE_VOLUME` (pré-selecionado quando modal abre).

### Comportamento ao trocar template

Quando Larissa muda o dropdown, o front re-renderiza o preview do email chamando o mesmo endpoint que renderiza nas outras ocs (não precisa criar um novo — reusa o componente existente que monta preview a partir de `template_id`). Se o seu projeto Lovable não tem esse componente reutilizável, basta NÃO renderizar preview ao trocar e deixar que o executor renderize na hora do envio. O essencial é o template_id_override ir no payload.

### Submit (RPC `aprovar_e_executar`)

```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: {
    // CAMPO NOVO:
    template_id_override: templateSelecionadoNoDropdown, // string: "FALTA_DE_VOLUME" | "RECUSA_TOTAL" | "PROBLEMAS_COM_ENDERECO" | "RECUSA_PARCIAL"

    // Campos que já existem nos modais atuais de "Lançar 54 + email":
    assunto_override: assuntoEditado,           // string opcional
    texto_email_customizado: corpoEditado,      // string opcional
    email_destinatarios: destinatariosArray,    // string[]
    enviar_email: true,
    skip_email: false,
    validar_evidencia: false,
    anexos_ids: anexosSelecionados,             // [] permitido
  },
});
```

`template_id_override` é a única chave nova. As demais (`assunto_override`, `texto_email_customizado`, etc) já são suportadas pelo backend nos outros modais de 54+email e seguem iguais.

## Critério de aceite

1. Em um card com `cod_ultima_ocorrencia=20`, abrir a proposta "Lançar oc 54 + email pro cliente" → modal abre com dropdown pré-selecionado em "Falta de volume"
2. Trocar dropdown pra "Recusa total" → submeter → conferir no DevTools → Network que o body do RPC inclui `template_id_override: "RECUSA_TOTAL"`
3. Verificar que o email enviado pelo cliente tem assunto/corpo do template RECUSA_TOTAL (não FALTA_DE_VOLUME)
4. Mesmas propostas em cards com `cod_ultima_ocorrencia` diferente de 20 (ex: 10, 11, 35, 49, 19, 54) **NÃO** mostram dropdown — comportamento atual preservado

## Garantia do backend (não precisa mexer)

- A regra `oc=20` foi atualizada em `supabase/functions/_shared/regras-auto-acao.ts` pra incluir a 2ª proposta de 54+email com `enviar_email_template: "FALTA_DE_VOLUME"` (default).
- O executor (`supabase/functions/executor/index.ts:457` e `1692`) já lê `extras.template_id_override` e usa esse valor em vez do template original quando presente. Suporte existente desde 2026-05-06.
- Edge functions `sync-bastao`, `vinculador` e `voltar-para-to-do-com-rastreio` já foram redeployadas com a nova regra.
- Os cards atuais em oc=20 vão ganhar a nova proposta na próxima rodada do `sync-bastao` (cadência 30min) quando o Bastão atualizar o card.
