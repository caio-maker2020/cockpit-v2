# Lovable — Modal de aprovação da oc 33 SOLO (sem oc=44 em seguida)

## Contexto

Já existe a 6ª opção combo 33+44 entre as propostas pós-resposta cliente. Agora há também uma **7ª opção: "Lançar oc 33 (sem 44)"** — usada quando Perdas precisa iniciar processo de indenização mas o cliente não autorizou devolução (ou há outra tratativa logística pro volume).

Identificação da proposta:

```ts
const ehOc33Solo =
  todo.proposta_payload?.tool === 'lancar_oc33_solo_portal';
const tipoAcao = todo.proposta_payload?.meta?.tipo_acao; // === 'oc33_solo'
```

Backend já está pronto. O executor recebe `tool='lancar_oc33_solo_portal'`, loga no portal interno SSW (opção 101) e lança a oc=33 com texto + N imagens (mesmo caminho do combo, sem encadear oc=44).

---

## Modal de aprovação

Quando Larissa clica em **"Lançar 33 (sem 44)"** entre as propostas, abrir um modal **mais simples que o combo** — só o bloco da oc=33:

```
┌──────────────────────────────────────────────────────────────────┐
│ Lançar oc 33 — Reversão de Perdas (com romaneio, sem 44)        │
│                                                                  │
│ Texto pra Operação:                                              │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Cliente NÃO autorizou devolução; iniciar processo de       │  │
│ │ indenização. Volume será tratado por outro fluxo.          │  │
│ └────────────────────────────────────────────────────────────┘  │
│ (até 70 chars — SSW f6)                                          │
│                                                                  │
│ Romaneio (imagens — 1+):                                        │
│ ○ Anexo do cliente: Untitled_...pdf  [selec.]                   │
│ ○ Upload novo: [+ Adicionar imagem]                             │
│                                                                  │
│ ⚠ SSW só renderiza JPEG/PNG. PDFs são convertidos por página   │
│   antes do upload (pdf.js no browser).                          │
│                                                                  │
│                          CANCELAR  [CONFIRMAR LANÇAR oc 33 →]    │
└──────────────────────────────────────────────────────────────────┘
```

### Campos

**Texto pra Operação** (textarea, **até 70 chars** — SSW limita f6):

- Pré-preencher com sugestão genérica: *"Reversão de perdas iniciada. Cliente notificado."*
- Larissa edita.
- Validação: opcional (pode ficar vazio).

**Imagens** (mesmo fluxo do modal combo):

- **Caminho A — anexos inbound do cliente**: listar `email_anexos` filtrado por `card_id` E `origem='inbound'`. Checkbox/multi-select.
  - Se PDF: converter via pdf.js + canvas → 1 JPEG por página. Reaproveitar snippet do prompt do combo ([prompts/lovable-aprovar-combo-33-44.md](prompts/lovable-aprovar-combo-33-44.md)).
- **Caminho B — upload manual**: Larissa sobe N JPEG/PNG. Até 10MB cada, total ≤ 20MB.
- **Validação obrigatória**: pelo menos 1 imagem JPEG/PNG no array final.

### Submit

```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: oc33SoloTodoId,
  p_extras: {
    texto_descricao: textoOc33,         // até 70 chars
    anexos_ids: [uuid1, uuid2, ...],    // N imagens JPEG/PNG
  },
});
```

Backend (`executor → processarOc33SoloPortal`) detecta `tool='lancar_oc33_solo_portal'`, loga no portal SSW, lança oc=33 com texto + N imagens. Em sucesso, card vai pra **ACAO_EXECUTADA** com `cod_ultima_ocorrencia=33`.

### Toasts pós-submit

- **Sucesso**: `✓ oc=33 lançada no SSW (portal). Card foi pra "AÇÃO EXECUTADA".`
- **Falha**: `✕ oc=33 falhou no SSW: <motivo>.`

---

## Onde aparece na UI

A 7ª opção "Lançar oc 33 (sem 44)" aparece junto com as outras 6 propostas (41, 55, 21, 33+44, 54, 56, 44).

Identificação:

```ts
const ehCombo3344 = todo.proposta_payload?.meta?.tipo_acao === 'combo_33_44';
const ehOc33Solo  = todo.proposta_payload?.meta?.tipo_acao === 'oc33_solo';
```

**Diferenciação visual:**
- 33+44 (combo): label "Lançar 33 + 44 (Ressarcimento)" — chama atenção que vai encadear devolução
- 33 solo: label "Lançar 33 (sem 44)" — explicita que NÃO vai encadear

---

## Reaproveitamento

O modal pode (deve) reusar o **bloco Parte 1 do modal combo 33+44** — copiar/extrair como componente. Só não renderizar o Bloco Parte 2 (volumes/motivo/filial) nem o aviso "⚠ A oc=44 só é lançada SE...".

Snippet de conversão PDF→JPEG idêntico ao combo:

```ts
import * as pdfjsLib from "pdfjs-dist";
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
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.85));
    jpegs.push(new File([blob], `pagina_${i}.jpg`, { type: "image/jpeg" }));
  }
  return jpegs;
}
```

---

## Resumo

| Elemento | Valor |
|---|---|
| Modal | 1 bloco apenas (texto + imagens) |
| Tool | `lancar_oc33_solo_portal` |
| Extras submit | `{ texto_descricao, anexos_ids }` |
| Estado final sucesso | `ACAO_EXECUTADA`, cod_ultima=33 |
| Diferencia do combo | meta.tipo_acao=`oc33_solo` (combo é `combo_33_44`) |
