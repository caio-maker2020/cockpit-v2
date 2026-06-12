# Lovable — ModalEvidencia: mostrar data + instrução de cada foto (multi-linha SSW)

**Data:** 2026-05-28
**Backend:** já deployado (`foto-oc-card` propaga novos headers).

## Contexto

Quando o SSW tem **múltiplas linhas da mesma oc** (ex: NF 696530 oc=10 lançada 2x — POE 25/05 19:35 + POA 26/05 14:37), cada linha pode ter foto distinta. O backend agora agrega TODAS as fotos das múltiplas linhas no mesmo `fotos_total`, e o `idx` percorre todas.

Antes: `fotos_total=1` (só pegava a 1ª linha) — operador via mesma foto duas vezes.
Agora: `fotos_total=2` (ou mais) — `idx=0` é a 1ª foto da 1ª linha, `idx=1` é a 1ª foto da 2ª linha, etc.

A galeria do `ModalEvidencia` já funciona via `idx` (← →). O fix básico **já está completo só com o deploy backend** — operador agora vê as 2 fotos distintas em vez da mesma duas vezes.

**Esta mudança é UX extra:** mostrar a **data + instrução** da linha SSW de origem de cada foto, pra operador entender de qual lançamento veio.

## Dados disponíveis (novos headers)

A edge `foto-oc-card` agora expõe em cada resposta:

```
X-Fotos-Total: 2
X-Idx-Atual: 0
X-Foto-Data: 26/05/26 14:37
X-Foto-Instrucao: FOTO%20DO%20VOLUME%20E%20ETIQUETA   ← URI-encoded
Access-Control-Expose-Headers: X-Fotos-Total, X-Idx-Atual, X-Foto-Data, X-Foto-Instrucao
```

`X-Foto-Data` e `X-Foto-Instrucao` são **opcionais** — podem vir vazios pra ocs com 1 só linha SSW (compat retro).

## Componente a alterar

[src/components/cards/ModalEvidencia.tsx](src/components/cards/ModalEvidencia.tsx) (criado no prompt `lovable-banner-evidencia-galeria-multifoto.md`).

### Mudança 1 — capturar headers e guardar no state

No `useEffect` que faz `fetch` da foto, depois de `setFotosTotal(total)`:

```tsx
const total = parseInt(resp.headers.get("X-Fotos-Total") ?? "1", 10);
setFotosTotal(total);

// NOVO — Caio 2026-05-28: metadata da linha SSW de origem
const fotoData = resp.headers.get("X-Foto-Data") ?? null;
const fotoInstrucaoRaw = resp.headers.get("X-Foto-Instrucao") ?? null;
const fotoInstrucao = fotoInstrucaoRaw ? decodeURIComponent(fotoInstrucaoRaw) : null;
setFotoMeta({ data: fotoData, instrucao: fotoInstrucao });
```

State novo:

```tsx
const [fotoMeta, setFotoMeta] = useState<{ data: string | null; instrucao: string | null } | null>(null);
```

### Mudança 2 — limpar metadata ao trocar idx (antes do novo fetch)

No `useEffect` que dispara fetch quando `idx` muda:

```tsx
useEffect(() => {
  if (!open) return;
  setCarregando(true);
  setErro(null);
  setFotoMeta(null);   // ← NOVO: limpa enquanto carrega a próxima
  // ... resto igual
}, [open, cardId, codigoOc, idx]);
```

### Mudança 3 — renderizar header com metadata

Logo abaixo do header `<h3>Evidência — oc={codigoOc}</h3>`, adicionar bloco condicional:

```tsx
{fotoMeta && (fotoMeta.data || fotoMeta.instrucao) && (
  <div className="text-caption text-ink-mute font-mono mt-1 border-l-2 border-amber-300 pl-2">
    {fotoMeta.data && (
      <span className="font-semibold text-ink-soft">{fotoMeta.data}</span>
    )}
    {fotoMeta.data && fotoMeta.instrucao && <span className="mx-2">·</span>}
    {fotoMeta.instrucao && (
      <span title={fotoMeta.instrucao}>
        {fotoMeta.instrucao.length > 80
          ? fotoMeta.instrucao.slice(0, 80) + "…"
          : fotoMeta.instrucao}
      </span>
    )}
  </div>
)}
```

### Resultado visual

```
┌─ Evidência — oc=10 ──────────────────────── Foto 1 de 2  ✕ ┐
│ │ 26/05/26 14:37 · FOTO DO VOLUME E ETIQUETA              │
│                                                              │
│   [←]                                                  [→]   │
│            [imagem]                                          │
│                                                              │
│                       ● ○                                    │
└──────────────────────────────────────────────────────────────┘
```

Ao clicar → (idx=1):

```
┌─ Evidência — oc=10 ──────────────────────── Foto 2 de 2  ✕ ┐
│ │ 25/05/26 19:35 · RECUSA TOTAL DA ENTREGA (SSWMOBILE) GPS… │
│                                                              │
│   [←]                                                  [→]   │
│            [outra imagem]                                    │
│                                                              │
│                       ○ ●                                    │
└──────────────────────────────────────────────────────────────┘
```

## Validação

1. Abrir NF 696530 (LARISSA, oc=10) → modal Evidência
2. Header da foto 1 mostra: `26/05/26 14:37 · FOTO DO VOLUME E ETIQUETA`
3. → navegar pra foto 2: header muda pra `25/05/26 19:35 · RECUSA TOTAL DA ENTREGA (SSWMOBILE) GPS…`
4. As imagens são genuinamente diferentes (não a mesma duas vezes)
5. Cards com 1 foto só (caso comum) seguem funcionando: o bloco da metadata não aparece se `fotoMeta` for null/vazio

## Por que isso importa

Quando o motorista relança a oc no SSWMOBILE (acidental ou intencional), o SSW guarda os 2 lançamentos. Cada um pode ter foto distinta (ex: 1 do volume + 1 do GPS do local). Operadora precisa ver as 2 pra montar o motivo correto pro cliente — antes só via 1.

Caio 2026-05-28 (NF 696530 LARISSA): *"no historico ssw aparece 2 ocorrencias 10. duas evidencias diferentes em cada ocorrencia... mas no cockpit as duas fotos aparecem iguais"*.

Cola no Lovable.
