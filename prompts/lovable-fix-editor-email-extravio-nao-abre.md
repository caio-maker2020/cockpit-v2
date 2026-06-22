# PATCH Lovable — ação de e-mail de extravio NÃO abre o editor (confirma inline)

## Sintoma (print real — NF 114763, O.V.D. IMPORTAD A., operador DUILIO)
No detalhe do card, a proposta **"Notificar cliente por e-mail (sem lançar
ocorrência)"** (extravio) abre um bloco **enxuto** com só:
- checkbox "VALIDAR EVIDÊNCIA ANTES DE ENVIAR"
- botão "CONFIRMAR LANÇAMENTO"

→ O operador **não vê nem edita o template/assunto/corpo/destinatário** do e-mail
antes de enviar. Ele aprova "às cegas".

## Comportamento correto (já está na spec `lovable-aba-extravios.md` §4)
Essa proposta tem **`meta.tinha_intencao_email === true`** (e `meta.acao === 'email_sem_oc'`,
`meta.origem === 'extravio_cockpit'`). Pela regra crítica da spec:

> **A decisão de abrir o editor de e-mail é por `meta.tinha_intencao_email === true`,
> NUNCA pelo nome do tool.**

Logo, ao clicar **Aprovar** nessa proposta, o front DEVE **abrir o MESMO editor de
e-mail completo das tratativas de relacionamento** (o do print de relacionamento),
populado via `preview_email_todo(p_todo_id)`:
- **Destinatário(s)** (editável + adicionar manual)
- **Template** (dropdown)
- **Assunto** (editável, já sugerido)
- **Corpo do e-mail** (editável, já com o template + qtd de volumes preenchida)
- **Anexos** (manter)

E só ao confirmar NO EDITOR, chamar:
```
aprovar_e_executar(p_todo_id, {
  assunto_override: <assunto editado>,
  texto_email_customizado: <corpo editado>,
  email_destinatarios: [<destinatários>],
  validar_evidencia: false
})
```
(É exatamente o shape de `extras` que o backend já recebe hoje.)

## Discriminador (reafirmando — não regredir)
| `meta.tinha_intencao_email` | Ação | Comportamento ao Aprovar |
|---|---|---|
| `true` (`email_sem_oc`, `email_mais_54`) | abre **editor de e-mail** (`preview_email_todo`) → confirmar no editor → `aprovar_e_executar(todo_id, extras)` |
| `false` (`lancar_49`, `lancar_55`) | **NÃO** abre editor → `aprovar_e_executar(todo_id)` direto |

O bug atual é o INVERSO do bug antigo da oc 49: agora a `email_sem_oc` (que TEM
intenção de e-mail) está caindo no caminho de confirm-direto em vez de abrir o editor.

## Para proposta de extravio (`meta.origem === 'extravio_cockpit'`), enxugar o editor
(igual já especificado na spec — repetir aqui pra garantir):
- **REMOVER** o checkbox "Validar evidência antes de enviar" (extravio não tem
  evidência em sistema; sempre `validar_evidencia=false`). É justamente esse
  checkbox que está aparecendo solto no bloco enxuto — ele NÃO deve ficar à mostra.
- **REMOVER** o rodapé "Como funciona: ao confirmar, lança a oc…" (não se aplica a
  e-mail-sem-oc).
- Manter destinatários, template, assunto, corpo, anexos, e a opção "enviar como
  novo e-mail" (padrão DESmarcado).

## Backend — JÁ ESTÁ PRONTO (nada a fazer no backend; só pro contexto do front)
- `preview_email_todo(p_todo_id uuid, p_template_id_override text DEFAULT NULL)` →
  retorna destinatário, assunto, corpo e `template_sugerido_ia` pra popular o editor.
- `aprovar_e_executar(p_todo_id uuid, p_extras jsonb DEFAULT NULL)` → **mig 226
  (2026-06-22)**: agora faz **MERGE** dos extras (antes fazia REPLACE e apagava
  `skip_oc` → a ação de e-mail-sem-oc falhava com "codigo_ssw não fornecido").
  Pode mandar os `extras` do editor à vontade que o `skip_oc:true` interno é
  preservado.
- O card de extravio permanece/volta pra aba **EXTRAVIOS** no sucesso E na falha do
  e-mail (executor + mig 227) — **isso é 100% backend, o front não precisa fazer
  nada** pra "voltar pra Extravios"; é só consequência do `state`.

## Resumo de 1 linha
Para `meta.tinha_intencao_email === true`, **abrir o editor de e-mail completo
(`preview_email_todo`)** ao Aprovar — hoje a `email_sem_oc` está confirmando inline
sem deixar o operador ver/editar o template.
