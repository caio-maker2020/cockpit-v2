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

**Texto pra Operação** (textarea, até **70 chars** — SSW limita f6, o texto vai como instrução visível):
- Pré-preencher com `card.ia_sugestao_oc_resposta.motivo_combo` (truncado a 70 chars). Larissa edita.
- Placeholder: "Ex: Romaneio anexo, cliente autorizou devolução"

**Imagens (1 ou mais — SSW SÓ aceita JPEG/PNG, NÃO aceita PDF)**:

- **Caminho A — usar anexos inbound do cliente**: listar `email_anexos` filtrado por `card_id` E `origem='inbound'`. Checkbox/multi-select por arquivo. Larissa escolhe 1+.
  - **Se o anexo é PDF**: conversão automática no browser via **pdf.js** + canvas → cada página vira 1 JPEG. Larissa vê preview e marca quais páginas anexar (default: todas). Pra cada página marcada, faz upload de 1 JPEG novo no bucket `email_anexos` (mesma RPC/endpoint dos outros uploads), coleta UUIDs e adiciona em `anexos_ids[]`.
  - **Se já é JPEG/PNG**: usa direto, ID entra em `anexos_ids`.
- **Caminho B — upload manual**: Larissa sobe N JPEG/PNG próprios (padrão atual do composer). Aceita JPEG/PNG até 10MB cada, total ≤ 20MB (limite SSW).
- Pode combinar A + B.
- **Validação obrigatória**: pelo menos 1 imagem JPEG/PNG no array final.

> ⚠️ Esta regra foi **relaxada em 2026-05-14** — anexo agora é opcional. Ver `prompts/lovable-anexo-opcional-oc33.md`.

#### Snippet de conversão pdf.js → JPEG (referência)

```ts
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/path/to/pdf.worker.js";

async function pdfParaJpegs(pdfBlob: Blob): Promise<File[]> {
  const arrayBuf = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  const jpegs: File[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    const blob: Blob = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.85),
    );
    jpegs.push(new File([blob], `pagina_${i}.jpg`, { type: "image/jpeg" }));
  }
  return jpegs;
}
```

Cada `File` resultante vai pelo fluxo de upload existente do Cockpit, retornando UUID que entra em `anexos_ids`.

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
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: comboTodoId,
  p_extras: {
    texto_descricao: textoOc33,            // pra oc=33 (até 70 chars)
    anexos_ids: [uuid1, uuid2, uuid3],     // N imagens JPEG/PNG pra oc=33
    combo_44: {
      quantidade_volumes: volumesOc44,
      motivo: motivoOc44,
      filial: filialOc44,
    },
  },
});
```

Backend executor (já deployado) detecta `tool='lancar_combo_33_44'`, NÃO usa WebAPI: loga no portal interno SSW (opção 101), lança oc=33 com texto + N imagens, e em sucesso lança oc=44 com texto agregado (volumes/motivo/filial).

### Toasts pós-submit

- **Combo OK (33 + 44 lançadas)**: `✓ Combo lançado no SSW (oc=33 + oc=44). Card foi pra "AÇÃO EXECUTADA".`
- **Falha oc=33**: `✕ Oc=33 falhou no SSW: <motivo>. Nenhuma oc foi lançada.`
- **Falha oc=44 pós oc=33 ok**: `⚠ Oc=33 lançada com sucesso, MAS oc=44 falhou. Retentar SOMENTE a oc=44 manualmente.` (Card vai pra AVH+lock=true com `acao_falhou_motivo` claro.)

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
