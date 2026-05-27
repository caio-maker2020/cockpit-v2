# Lovable — Banner "Ver evidência" com galeria de múltiplas fotos

**Data:** 2026-05-27
**Backend:** já deployado.
- `foto-oc-card` aceita `body.idx` (0..N-1) e retorna headers `X-Fotos-Total` + `X-Idx-Atual`.
- `r-evidencia` (link público pro cliente) renderiza galeria HTML quando `fotos_total > 1`.
- SSW interno (`obterFotoDaOc`) já coleta o array de fotos por oc; agora baixa a foto pelo idx solicitado.

## Mudança no front

O modal/lightbox de "Ver evidência" (criado no prompt `lovable-banner-evidencia-inline-e-alerta-caixa-lacrada.md`) precisa:

1. **Pedir a 1ª foto** (`idx=0`)
2. **Ler header `X-Fotos-Total`** da resposta
3. **Se `> 1`**: mostrar setas ← → + contador "X de N" + pre-carregar próxima

### Implementação

```tsx
// src/components/cards/ModalEvidencia.tsx
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";

interface ModalEvidenciaProps {
  cardId: string;
  codigoOc: number;
  open: boolean;
  onClose: () => void;
}

export function ModalEvidencia({ cardId, codigoOc, open, onClose }: ModalEvidenciaProps) {
  const [idx, setIdx] = useState(0);
  const [fotosTotal, setFotosTotal] = useState<number | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setIdx(0);
    setFotosTotal(null);
  }, [open, cardId, codigoOc]);

  useEffect(() => {
    if (!open) return;
    setCarregando(true);
    setErro(null);

    (async () => {
      try {
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;
        const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/foto-oc-card`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ card_id: cardId, codigo_oc: codigoOc, idx }),
        });
        if (!resp.ok) {
          setErro(`Não foi possível carregar a foto (${resp.status})`);
          setCarregando(false);
          return;
        }
        // Headers customizados expostos via Access-Control-Expose-Headers
        const total = parseInt(resp.headers.get("X-Fotos-Total") ?? "1", 10);
        setFotosTotal(total);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        setImgUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setCarregando(false);
      } catch (err) {
        setErro(err instanceof Error ? err.message : String(err));
        setCarregando(false);
      }
    })();

    return () => {
      // Cleanup ao desmontar
    };
  }, [open, cardId, codigoOc, idx]);

  if (!open) return null;

  const podeNavegar = (fotosTotal ?? 1) > 1;
  const irAnterior = () => setIdx((i) => Math.max(0, i - 1));
  const irProxima = () => setIdx((i) => Math.min((fotosTotal ?? 1) - 1, i + 1));

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg rounded-lg max-w-3xl w-full p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-display text-h6">Evidência — oc={codigoOc}</h3>
          {fotosTotal != null && (
            <span className="text-caption font-mono text-ink-mute">
              Foto {idx + 1} de {fotosTotal}
            </span>
          )}
          <button onClick={onClose} className="text-ink-mute hover:text-ink">✕</button>
        </div>

        {erro && <p className="text-rose-700">{erro}</p>}
        {carregando && <p className="text-ink-mute italic">Carregando…</p>}

        {imgUrl && !carregando && (
          <div className="relative">
            <img
              src={imgUrl}
              alt={`Evidência ${idx + 1}`}
              className="w-full h-auto rounded-md border border-ink-mute/20"
            />
            {podeNavegar && (
              <>
                <button
                  onClick={irAnterior}
                  disabled={idx === 0}
                  aria-label="Foto anterior"
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-bg/90 hover:bg-bg border border-ink-mute/30 rounded-full w-10 h-10 disabled:opacity-30"
                >
                  ←
                </button>
                <button
                  onClick={irProxima}
                  disabled={idx === (fotosTotal ?? 1) - 1}
                  aria-label="Próxima foto"
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-bg/90 hover:bg-bg border border-ink-mute/30 rounded-full w-10 h-10 disabled:opacity-30"
                >
                  →
                </button>
              </>
            )}
          </div>
        )}

        {podeNavegar && (
          <div className="flex gap-1 justify-center mt-3">
            {Array.from({ length: fotosTotal ?? 0 }).map((_, n) => (
              <button
                key={n}
                onClick={() => setIdx(n)}
                aria-label={`Foto ${n + 1}`}
                className={`w-2 h-2 rounded-full ${n === idx ? "bg-ink" : "bg-ink-mute/40"}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

### Atalhos de teclado (opcional)

```tsx
useEffect(() => {
  if (!open) return;
  function handler(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") irAnterior();
    else if (e.key === "ArrowRight") irProxima();
    else if (e.key === "Escape") onClose();
  }
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [open, idx, fotosTotal]);
```

### Pré-carregamento da próxima foto

Pra UX mais fluida (sem flash carregando ao clicar →):

```tsx
useEffect(() => {
  if (!open || !fotosTotal || idx >= fotosTotal - 1) return;
  // Pre-fetch próxima — browser cacheia
  fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/foto-oc-card`, {
    method: "POST",
    headers: { /* ... mesmos headers */ },
    body: JSON.stringify({ card_id: cardId, codigo_oc: codigoOc, idx: idx + 1 }),
  }).catch(() => {});
}, [open, idx, fotosTotal]);
```

## Visual

```
┌─ Evidência — oc=35 ──────────────────────────── Foto 2 de 3  ✕ ┐
│                                                                  │
│   [←]                                                      [→]   │
│            [imagem em tamanho cheio]                             │
│                                                                  │
│                          ● ● ○                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Cenário: 1 foto só (caso comum)

- `fotosTotal === 1` → setas + dots não aparecem (modal igual ao atual)
- Contador "Foto 1 de 1" pode ser omitido se quiser (estética opcional)

## Cliente final (link {link_evidencia})

Sem mudança no Lovable — o backend `r-evidencia` JÁ renderiza galeria HTML quando `fotos_total > 1`. Cliente clica no link do email e vê todas as fotos numa página vertical (1 por <figure>).

## Validação

1. Card com oc=35 que tem 2 fotos no SSW → modal abre, mostra "Foto 1 de 2", setas + dots aparecem.
2. Clica → → foto 2 carrega, contador atualiza, seta → fica desabilitada.
3. Card com 1 foto só → sem setas, sem dots, igual modal atual.
4. Erro 404 (oc_sem_foto) → mostra mensagem na modal.
5. Cliente abre link {link_evidencia} de uma oc=35 com 3 fotos → vê página HTML com 3 imagens empilhadas verticalmente.

Cola no Lovable.
