# Lovable — Aprovação de oc=21 (REENTREGA): textarea de instrução + anexo de imagem

## Contexto

Hoje, ao aprovar uma proposta de oc=44 (RETORNO DE CARGA), Larissa preenche os campos `Volumes`, `Motivo`, `Filial` que vão concatenados na descrição da oc lançada no SSW pra orientar a operação.

Caio (2026-05-11) quer **a mesma experiência pra oc=21 (REENTREGA SOLICITADA)**, mas com 2 mudanças:

1. **Um único campo livre de texto** (em vez dos 3 campos da oc=44), porque o conteúdo da instrução de reentrega é variável (novo endereço, novo contato, melhor horário, observação específica do cliente).
2. **Opcional: 1 imagem anexa**, que vai pra dentro da ocorrência no SSW como evidência (foto de comprovante de novo endereço, print de mensagem do cliente, etc.). Mesmo padrão da oc=33 / oc emergencial.

A imagem **vai SÓ pro SSW** — não vai pro cliente por email. Reentrega é mensagem pra operação, não pro cliente.

## Bonus IA: sugestão automática de instrução

Quando o agente IA processa a resposta do cliente e sugere `oc=21`, ele agora também devolve um campo `instrucao_reentrega_sugerida` (string até 250 chars) extraído do email do cliente. O front deve **pré-preencher a textarea com esse texto** — Larissa edita/aprova.

Exemplo real:

> Cliente respondeu: "Podem reentregar amanhã na Rua das Flores 123. Falar com Maria, telefone 11999999999."

IA retorna:
```json
{
  "oc_sugerida": 21,
  "confianca": 0.92,
  "motivo": "Cliente autorizou reentrega com endereço e contato específicos.",
  "instrucao_reentrega_sugerida": "Novo endereço: Rua das Flores 123. Contato: Maria 11999999999."
}
```

Front renderiza textarea pré-preenchida com `"Novo endereço: Rua das Flores 123. Contato: Maria 11999999999."`. Larissa pode editar antes de aprovar.

Se cliente NÃO mencionou nada novo (ex: só "podem entregar de novo"), a IA retorna `instrucao_reentrega_sugerida: ""` (string vazia). Front mostra textarea vazia e Larissa preenche manualmente (ou deixa vazia se não tiver instrução específica).

---

## A mudança no modal de aprovação da oc=21

```
┌────────────────────────────────────────────────────────┐
│  21  Reentrega solicitada                              │
│                                                         │
│  Instrução pra operação (opcional):                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Novo endereço: Rua das Flores 123.               │  │
│  │ Contato: Maria 11999999999.                      │  │
│  │                                                  │  │
│  └──────────────────────────────────────────────────┘  │
│  Sugerido pela IA. Edite ou apague se necessário.      │
│                                                         │
│  Imagem anexa (opcional):                              │
│  [+ Adicionar imagem]                                  │
│  (JPEG/PDF — vai dentro da oc no SSW)                  │
│                                                         │
│                            CANCELAR  [CONFIRMAR →]     │
└────────────────────────────────────────────────────────┘
```

### Comportamentos

- **Textarea pré-preenchida com `card.ia_sugestao_oc_resposta.instrucao_reentrega_sugerida`** se existir E `card.ia_sugestao_oc_resposta.oc_sugerida === 21`.
- **Se não houver sugestão IA**: textarea vazia. Mostrar placeholder "Ex: novo endereço, contato, melhor horário..."
- **Botão "Adicionar imagem"**: mesmo fluxo do anexo emergencial (mig 073 — sobe arquivo pro bucket `email_anexos`, retorna `anexo_id` UUID).
- **Validação**: textarea aceita até 250 chars. Imagem até 10MB (JPEG/PDF).
- **Quando marcar "Sugerido pela IA"**: texto cinza italic abaixo da textarea, só se a IA sugeriu (não mostrar se Larissa começou em branco).

### Contrato técnico (backend)

A RPC `aprovar_e_executar(p_todo_id, p_extras)` recebe:

```json
{
  "texto_descricao": "Novo endereço: Rua das Flores 123. Contato: Maria 11999999999.",
  "anexo_id": "uuid-do-anexo-no-bucket-email_anexos"
}
```

Ambos opcionais. Se Larissa não preenche nada, manda sem extras (ou só com `texto_descricao: ""`).

Executor já tem o código pra receber esses 2 campos (linhas ~339 e ~585) — substitui a descrição base da oc=21 pelo `texto_descricao` e injeta a imagem no SSW como `imagem` (base64) quando o anexo está presente.

---

## Resumo

| Elemento | Mudança |
|---|---|
| Modal oc=21 | Adicionar textarea "Instrução pra operação" + botão "Adicionar imagem" |
| Pré-preenchimento | `card.ia_sugestao_oc_resposta.instrucao_reentrega_sugerida` (se houver E oc_sugerida=21) |
| Validações | Textarea ≤ 250 chars; imagem ≤ 10MB JPEG/PDF |
| Imagem | Vai SÓ pro SSW (não vai por email pro cliente) |
| Texto de ajuda | "Sugerido pela IA. Edite ou apague se necessário." (só quando IA sugeriu) |

Nada mais muda. Sem este preenchimento, oc=21 lança no SSW com descrição padrão (sem instrução).
