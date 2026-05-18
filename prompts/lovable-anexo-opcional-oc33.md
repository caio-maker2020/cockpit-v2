# Lovable — Tornar anexo de romaneio OPCIONAL nos modais de oc=33

**Data:** 2026-05-14
**Objetivo:** Relaxar validação de anexos em 2 modais existentes do Cockpit. Backend já está pronto e deployado — só falta o frontend.

---

## Contexto rápido

O Cockpit tem 2 modais que hoje exigem **anexar imagem do romaneio** antes de aprovar o lançamento de ocorrência 33 no SSW:

1. **Modal "Aprovar combo 33+44 — Reversão de Perdas + Devolução"** — Larissa clica na 6ª proposta do card (visível quando IA detecta padrão de ressarcimento: cliente respondeu autorizando devolução + Larissa pediu romaneio). Tem 2 blocos: Parte 1 (oc=33 com texto + imagens) e Parte 2 (oc=44 com volumes/motivo/filial).

2. **Modal "Aprovar oc=33 solo — Reversão de Perdas (sem devolução)"** — 7ª proposta do card. Usado quando Perdas precisa iniciar indenização mas cliente NÃO autorizou devolução. 1 bloco só (texto + imagens, sem volumes/motivo/filial).

Em ambos, hoje a validação client-side exige **pelo menos 1 imagem JPEG/PNG** antes de habilitar o botão "Aprovar e executar".

---

## A mudança

Caio (2026-05-14): em alguns casos não se aplica anexar romaneio (ex: ressarcimento sem retorno físico). Anexo passa a ser **opcional** nos dois modais.

| Item | Antes | Depois |
|---|---|---|
| Validação client-side dos anexos | `anexos.length >= 1` obrigatório. Botão "Aprovar e executar" desabilitado quando zero imagens | Sem validação bloqueante de anexos. Botão habilitado mesmo com zero imagens (outros campos obrigatórios do form seguem normalmente) |
| Erro vermelho "Anexe pelo menos 1 imagem" | Mostrado quando array vazio | Removido |
| Aviso quando submit sem imagens | Não tinha (era bloqueado antes) | Banner amarelo informativo logo acima do botão: "⚠️ Você está lançando oc=33 sem imagem anexa. Confirme que o caso não exige romaneio (ex: ressarcimento sem retorno físico)." |
| Payload enviado pro backend | `extras.anexos_ids` array com 1+ UUIDs obrigatório | `extras.anexos_ids` pode ser `[]` (array vazio) ou ausente — backend aceita |

---

## Modal 1 — Combo 33+44

Estrutura atual permanece igual (2 blocos numa tela única). Os outros campos do form **seguem obrigatórios** — só estou mexendo na regra de anexos.

### Bloco "Parte 1 — oc=33"
- **Texto pra Operação** (textarea até 70 chars) — opcional, segue como hoje
- **Imagens** — agora OPCIONAL:
  - Caminho A — anexos inbound do cliente: listar `email_anexos` filtrado por `card_id` E `origem='inbound'`. Checkbox/multi-select. PDFs convertidos via pdf.js → JPEG no browser (snippet abaixo). Larissa escolhe 0+.
  - Caminho B — upload manual: Larissa sobe N JPEG/PNG próprios. Até 10MB cada, total ≤ 20MB.
  - Pode combinar A + B, ou **enviar sem nenhum anexo**.
  - Quando array final estiver vazio, **NÃO** desabilitar o botão. Exibir banner amarelo.

### Bloco "Parte 2 — oc=44" (segue igual)
- **Quantidade de volumes** (number, obrigatório)
- **Motivo** (text, obrigatório)
- **Filial** (text curto, obrigatório — ex: "VGA", "BHZ")

### Submit (payload pro backend)
```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: comboTodoId,
  p_extras: {
    texto_descricao: textoOc33,           // até 70 chars, opcional
    anexos_ids: anexosSelecionados,       // [] permitido — pode ir vazio
    combo_44: {
      quantidade_volumes: volumes,
      motivo: motivoText,
      filial: filialText,
    },
  },
});
```

### Validação final do botão "Aprovar e executar"
Habilitado quando:
- Parte 2 — volumes, motivo, filial preenchidos ✅ (regra atual mantida)
- Parte 1 — texto e anexos **opcionais** (regra nova) ✅

---

## Modal 2 — oc=33 solo

Tela única, 1 bloco apenas.

- **Texto pra Operação** (textarea até 70 chars) — opcional (pode ficar vazio)
- **Imagens** — agora OPCIONAL (mesma regra do combo):
  - Caminho A — anexos inbound do cliente (filtro `origem='inbound'`, conversão PDF→JPEG via pdf.js)
  - Caminho B — upload manual
  - Pode enviar sem nenhum anexo
  - Banner amarelo quando array vazio

### Submit
```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: oc33SoloTodoId,
  p_extras: {
    texto_descricao: textoOc33,         // até 70 chars, opcional
    anexos_ids: anexosSelecionados,     // [] permitido
  },
});
```

### Validação final do botão "Aprovar e executar"
Habilitado SEMPRE (texto e anexos são ambos opcionais nesse modal — Larissa pode submeter modal praticamente vazio se for o caso). Banner amarelo aparece quando sem anexos.

---

## Snippet pdf.js → JPEG (referência — caso o componente atual não tenha)

```ts
import * as pdfjsLib from "pdfjs-dist";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/path/to/pdf.worker.js";

async function pdfParaJpegs(pdfBlob: Blob): Promise<File[]> {
  const arrayBuf = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  const arquivos: File[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob: Blob = await new Promise((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", 0.92)
    );
    arquivos.push(new File([blob], `pagina-${i}.jpg`, { type: "image/jpeg" }));
  }
  return arquivos;
}
```

Cada `File` resultante vai pelo fluxo de upload existente do Cockpit (mesma RPC/endpoint dos outros uploads do composer), retornando UUID que entra em `anexos_ids[]`.

---

## Banner amarelo (componente)

Posicionar logo acima do botão "Aprovar e executar" nos dois modais. Renderizar condicionalmente quando `anexosSelecionados.length === 0`.

```
┌──────────────────────────────────────────────────────────────────┐
│ ⚠️ Você está lançando oc=33 sem imagem anexa.                   │
│ Confirme que o caso não exige romaneio                          │
│ (ex: ressarcimento sem retorno físico).                          │
└──────────────────────────────────────────────────────────────────┘
```

Estilo: background amarelo claro (`bg-yellow-50` / `border-yellow-300` / texto `text-yellow-900`), ícone de aviso, padding moderado.

---

## Critério de aceite

1. **Combo 33+44** com 0 imagens + volumes/motivo/filial preenchidos → submit envia `anexos_ids: []` → backend retorna sucesso → card vai pra ACAO_EXECUTADA com cod_ultima=44
2. **oc=33 solo** com 0 imagens e texto vazio → submit envia `anexos_ids: []`, `texto_descricao: ""` → backend retorna sucesso → card vai pra ACAO_EXECUTADA com cod_ultima=33
3. Banner amarelo aparece quando array vazio, **mas não bloqueia** o submit
4. Quando há ≥1 anexo selecionado, comportamento idêntico ao atual (caminhos A/B, conversão PDF, upload, UUIDs em `anexos_ids[]`)
5. Mensagem de erro vermelha antiga ("Anexe pelo menos 1 imagem") foi removida completamente

---

## Garantia do backend (não precisa mexer — só pra você saber)

A edge function `executor` já foi deployada aceitando `anexos_ids=[]` ou ausente. Quando array vazio, o lançamento SSW pula o upload multipart e envia só o texto da ocorrência (mesma chamada que a oc=44 já fazia sem imagem). Cleanup de anexos pós-envio é no-op quando array vazio.
