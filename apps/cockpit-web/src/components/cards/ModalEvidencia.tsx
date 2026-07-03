import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  supabase,
  SUPABASE_FUNCTIONS_URL,
  SUPABASE_ANON_KEY_PUBLIC,
} from "@/lib/supabase";

interface ModalEvidenciaProps {
  cardId: string;
  codigoOc: number;
  open: boolean;
  onClose: () => void;
}

interface FotoManifestoItem {
  idx: number;
  oc_descricao?: string | null;
  foto_data?: string | null;
  foto_instrucao?: string | null;
}

interface FotoManifesto {
  ok: boolean;
  codigo_oc: number;
  fotos_total: number;
  incompleto?: boolean;
  fotos: FotoManifestoItem[];
}

async function callFotoOcCard(body: Record<string, unknown>) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token ?? SUPABASE_ANON_KEY_PUBLIC;
  return fetch(`${SUPABASE_FUNCTIONS_URL}/foto-oc-card`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY_PUBLIC,
    },
    body: JSON.stringify(body),
  });
}

export function ModalEvidencia({ cardId, codigoOc, open, onClose }: ModalEvidenciaProps) {
  const [idx, setIdx] = useState(0);
  const [manifesto, setManifesto] = useState<FotoManifesto | null>(null);
  const [manifestoErro, setManifestoErro] = useState<string | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Reset on open / target change + fetch manifest
  useEffect(() => {
    if (!open) return;
    setIdx(0);
    setManifesto(null);
    setManifestoErro(null);
    setErro(null);
    let cancelled = false;
    (async () => {
      try {
        const resp = await callFotoOcCard({
          card_id: cardId,
          codigo_oc: codigoOc,
          list: true,
        });
        if (cancelled) return;
        if (!resp.ok) {
          let err: { error?: string } = {};
          try { err = await resp.json(); } catch { /* ignore */ }
          if (err?.error === "oc_sem_foto") {
            setManifestoErro("Essa ocorrência não tem foto anexada no SSW ainda.");
          } else {
            setManifestoErro(`Não foi possível listar as fotos (${resp.status}).`);
          }
          return;
        }
        const data = (await resp.json()) as FotoManifesto;
        if (cancelled) return;
        if (!data?.fotos?.length) {
          setManifestoErro("Essa ocorrência não tem foto anexada no SSW ainda.");
          return;
        }
        setManifesto(data);
      } catch (e) {
        if (!cancelled) setManifestoErro((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cardId, codigoOc]);

  // Fetch current photo binary based on idx
  useEffect(() => {
    if (!open || !manifesto) return;
    const alvo = manifesto.fotos[idx];
    if (!alvo) return;
    let cancelled = false;
    setCarregando(true);
    setErro(null);
    (async () => {
      try {
        const resp = await callFotoOcCard({
          card_id: cardId,
          codigo_oc: codigoOc,
          idx: alvo.idx,
        });
        if (cancelled) return;
        if (!resp.ok) {
          let err: { error?: string } = {};
          try { err = await resp.json(); } catch { /* ignore */ }
          setErro(err?.error ?? `Não foi possível carregar a foto (${resp.status}).`);
          setCarregando(false);
          return;
        }
        const blob = await resp.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setImgUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setCarregando(false);
      } catch (e) {
        if (!cancelled) {
          setErro((e as Error).message);
          setCarregando(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cardId, codigoOc, idx, manifesto]);

  // Pré-carrega próxima
  useEffect(() => {
    if (!open || !manifesto) return;
    const proxima = manifesto.fotos[idx + 1];
    if (!proxima) return;
    callFotoOcCard({ card_id: cardId, codigo_oc: codigoOc, idx: proxima.idx }).catch(() => {});
  }, [open, idx, manifesto, cardId, codigoOc]);

  const fotosTotal = manifesto?.fotos_total ?? manifesto?.fotos.length ?? 0;
  const podeNavegar = fotosTotal > 1;
  const fotoAtual = manifesto?.fotos[idx] ?? null;
  const irAnterior = () => setIdx((i) => Math.max(0, i - 1));
  const irProxima = () =>
    setIdx((i) => Math.min(fotosTotal - 1, i + 1));

  // Teclado
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") irAnterior();
      else if (e.key === "ArrowRight") irProxima();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fotosTotal]);

  function handleOpenChange(o: boolean) {
    if (!o) {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      setImgUrl(null);
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-4 pr-8">
            <span>Evidência — oc={codigoOc}</span>
            {fotosTotal > 1 && (
              <span className="font-body text-xs font-normal text-ink-soft">
                Foto {idx + 1} de {fotosTotal}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {fotoAtual && (fotoAtual.foto_data || fotoAtual.foto_instrucao) && (
          <div className="mt-1 border-l-2 border-amber-300 pl-2 font-mono text-[11px] text-ink-soft">
            {fotoAtual.foto_data && (
              <span className="font-semibold text-ink">{fotoAtual.foto_data}</span>
            )}
            {fotoAtual.foto_data && fotoAtual.foto_instrucao && <span className="mx-2">·</span>}
            {fotoAtual.foto_instrucao && (
              <span title={fotoAtual.foto_instrucao}>
                {fotoAtual.foto_instrucao.length > 80
                  ? fotoAtual.foto_instrucao.slice(0, 80) + "…"
                  : fotoAtual.foto_instrucao}
              </span>
            )}
          </div>
        )}

        {manifesto?.incompleto && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            ⚠️ Pode haver fotos não carregadas — abrir no SSW para conferir.
          </div>
        )}

        {(manifestoErro || erro) && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {manifestoErro ?? erro}
          </div>
        )}

        {!manifestoErro && !manifesto && (
          <div className="flex items-center justify-center py-12 text-ink-soft">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Listando fotos…
          </div>
        )}

        {carregando && manifesto && !erro && (
          <div className="flex items-center justify-center py-12 text-ink-soft">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Carregando…
          </div>
        )}

        {imgUrl && !carregando && !erro && manifesto && (
          <div className="relative">
            <img
              src={imgUrl}
              alt={`Foto oc=${codigoOc} (${idx + 1})`}
              className="h-auto w-full rounded-md"
              onError={() => toast.error("Foto não disponível no SSW")}
            />
            {podeNavegar && (
              <>
                <button
                  type="button"
                  onClick={irAnterior}
                  disabled={idx === 0}
                  aria-label="Foto anterior"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white transition-opacity hover:bg-black/80 disabled:opacity-30"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={irProxima}
                  disabled={idx >= fotosTotal - 1}
                  aria-label="Próxima foto"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white transition-opacity hover:bg-black/80 disabled:opacity-30"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </div>
        )}

        {podeNavegar && (
          <div className="flex items-center justify-center gap-1.5 pt-1">
            {manifesto?.fotos.map((_, n) => (
              <button
                key={n}
                type="button"
                onClick={() => setIdx(n)}
                aria-label={`Foto ${n + 1}`}
                className={`h-2 w-2 rounded-full transition-colors ${
                  n === idx ? "bg-ink" : "bg-ink/30 hover:bg-ink/50"
                }`}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
