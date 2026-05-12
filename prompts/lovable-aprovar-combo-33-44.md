# Lovable — Modal de aprovação do combo "LANÇAR 33 + LANÇAR 44"

## Contexto

A IA agora sugere combo 33+44 quando detecta padrão de ressarcimento (Larissa pediu romaneio + cliente autorizou devolução). O combo aparece como **6ª proposta no card** com `tool='lancar_combo_33_44'`. Backend já trata:
- Lança oc=33 (com texto + anexo do romaneio)
- Se sucesso → cria/enfileira automático segundo todo aprovado pra oc=44 (com volumes/motivo/filial)
- Se oc=33 falha → reverte normal
- Se oc=44 falha (parte 2) → card vai pra AVH+lock=true com aviso "oc=33 lançada protocolo X mas oc=44 falhou: ..."

**Significado das ocs:**
- **oc=33** = Reversão de perdas / início do processo de **indenização** pelo time de Perdas (precisa do romaneio)
- **oc=44** = autorização de **devolução** do volume físico

---

## Quando o modal aparece

Larissa clica em **"Lançar 33 + Lançar 44 (Ressarcimento)"** entre as propostas. O modal de aprovação é DIFERENTE dos outros: tem 2 blocos separados (um pra cada oc) numa tela só. Submit único.

---

## Layout do modal

```
┌──────────────────────────────────────────────────────────────────┐
│ Lançar 33 + Lançar 44 (Ressarcimento)                            │
│                                                                  │
│ 💡 IA sugere essa opção: {motivo_combo do ia_sugestao}           │
│                                                                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  Parte 1 — oc=33 (Reversão de perdas / Indenização)              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                  │
│ Texto pra Operação:                                              │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Cliente enviou o romaneio assinado autorizando devolução.  │  │
│ │ Iniciar processo de indenização.                           │  │
│ │                                                            │  │
│ └────────────────────────────────────────────────────────────┘  │
│ (até 500 chars)                                                  │
│                                                                  │
│ Romaneio (imagem do cliente):                                   │
│ ○ Usar anexo do cliente: Untitled_20260512_104420.pdf  [selec.] │
│ ○ Subir outro arquivo: [+ Adicionar imagem]                     │
│                                                                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  Parte 2 — oc=44 (Retorno de carga / Devolução)                  │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                                  │
│ Quantidade de volumes: [____]                                   │
│ Motivo: [____________________________________]                  │
│ Filial: [____]                                                  │
│                                                                  │
│ ⚠ A oc=44 só é lançada SE a oc=33 for confirmada no SSW.        │
│                                                                  │
│                          CANCELAR  [CONFIRMAR LANÇAR COMBO →]    │
└──────────────────────────────────────────────────────────────────┘
```

### Bloco "Parte 1 — oc=33"

**Texto pra Operação** (textarea, até 500 chars, opcional):
- Pré-preencher com sugestão do `card.ia_sugestao_oc_resposta.motivo_combo` se existir (Larissa edita).
- Se não, placeholder: "Ex: Cliente enviou romaneio assinado autorizando devolução. Iniciar processo de indenização."

**Romaneio (imagem)**:
- Se há anexos inbound do cliente (`email_anexos` filtrado por `card_id` E `origem='inbound'`), oferecer **escolher um** (radio button). O anexo escolhido vai como `anexo_id` no extras.
- Sempre permite **subir outro arquivo** (mesmo padrão do anexo emergencial — upload pro bucket `email_anexos` retorna UUID).
- Pelo menos um dos dois caminhos é obrigatório (operadora precisa enviar imagem pra oc=33).

### Bloco "Parte 2 — oc=44"

Mesmos campos da aprovação de oc=44 solo:
- **Quantidade de volumes** (number, obrigatório)
- **Motivo** (text, obrigatório)
- **Filial** (text curto, obrigatório, ex: "VGA", "BHZ")

### Submit

Validações:
- Parte 1: anexo selecionado/subido (qualquer um dos 2 caminhos). Texto opcional.
- Parte 2: 3 campos preenchidos.

Chamada:

```ts
const { data, error } = await supabase.functions.invoke('aprovar-e-executar-rpc-wrapper', {
  // OU chamar RPC diretamente via .rpc():
  body: {
    todo_id: comboTodoId,
    extras: {
      texto_descricao: textoOc33,        // pra oc=33
      anexo_id: anexoIdEscolhido,        // pra oc=33
      combo_44: {
        quantidade_volumes: volumesOc44,
        motivo: motivoOc44,
        filial: filialOc44,
      },
    },
  },
});
```

Backend RPC `aprovar_e_executar(p_todo_id, p_extras)` injeta `extras` em `proposta_payload.args.extras`. Executor (já deployado) lê `texto_descricao` + `anexo_id` pra oc=33 e `combo_44.*` pra preparar a oc=44.

### Toasts pós-submit

- **Sucesso (oc=33 ok + oc=44 enfileirada)**: `✓ Combo iniciado: oc=33 lançada (aguarde oc=44 ~30s)`
- **Falha oc=33**: `✕ Oc=33 falhou no SSW: <motivo>. Combo não prosseguiu.`
- **Falha oc=44 pós oc=33 ok**: card vai pra AVH com `acao_falhou_motivo` claro. Toast: `⚠ Oc=33 lançada (protocolo X) mas oc=44 falhou. Retentar só a oc=44 manualmente.`

---

## Onde aparece na UI

A 6ª opção "Lançar 33 + Lançar 44 (Ressarcimento)" aparece junto com as outras 5 propostas. Quando IA sugere combo (`card.ia_sugestao_oc_resposta.sugere_combo_33_44 === true`), destacar visualmente (ver `prompts/lovable-pendencias-ia-banner.md`).

Identificação da proposta combo na lista de todos:

```ts
const ehCombo = todo.proposta_payload?.tool === 'lancar_combo_33_44';
const tipoAcao = todo.proposta_payload?.meta?.tipo_acao; // === 'combo_33_44'
```

---

## Resumo

| Elemento | Mudança |
|---|---|
| Modal aprovação 6ª opção | Tela única com 2 blocos (oc=33 + oc=44) |
| Bloco oc=33 | Textarea + escolha anexo (cliente OU upload) |
| Bloco oc=44 | Volumes + motivo + filial (mesma regra solo) |
| Submit | `aprovar_e_executar` com extras `{texto_descricao, anexo_id, combo_44: {...}}` |
| Backend | Executor lança 33 → se OK enfileira 44; se 44 falha, AVH com aviso |
| Estado | EXECUTANDO_ACAO durante combo; ACAO_EXECUTADA só após oc=44 sucesso |

Anexos do cliente: ver `prompts/lovable-anexos-inbound-card.md` pra como buscar/exibir os anexos disponíveis.
