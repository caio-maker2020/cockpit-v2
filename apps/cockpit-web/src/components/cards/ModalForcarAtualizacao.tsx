import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PreviewResp {
  ok?: boolean;
  preview?: boolean;
  oc_portal?: number | null;
  oc_anterior?: number | null;
  decisao?: string;
  state_alvo?: string;
  finalizadora?: boolean;
  sai_da_visao?: boolean;
  ja_atualizado?: boolean;
  error?: string;
}

interface Props {
  cardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Disparado quando o "Sim" é confirmado e a aplicação termina (sucesso/falha). */
  onDone?: () => void;
}

export function ModalForcarAtualizacao({ cardId, open, onOpenChange, onDone }: Props) {
  const qc = useQueryClient();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !supabase) return;
    let cancel = false;
    setPreview(null);
    setErro(null);
    setLoadingPreview(true);
    (async () => {
      const { data, error } = await supabase!.functions.invoke(
        "atualizar-card-via-portal-ssw",
        { body: { card_id: cardId, preview: true } },
      );
      if (cancel) return;
      setLoadingPreview(false);
      if (error || !data || data.ok === false) {
        setErro(error?.message ?? (data as PreviewResp | null)?.error ?? "Erro ao consultar SSW");
        return;
      }
      const pv = data as PreviewResp;
      setPreview(pv);
      // Já está sincronizado → não precisa confirmação
      if (pv.ja_atualizado) {
        toast.success(`Card já está sincronizado com o SSW (oc ${pv.oc_portal ?? "—"}).`);
        qc.invalidateQueries({ queryKey: ["card", cardId] });
        qc.invalidateQueries({ queryKey: ["cards"] });
        qc.invalidateQueries({ queryKey: ["conflitos"] });
        onOpenChange(false);
        onDone?.();
      }
    })();
    return () => {
      cancel = true;
    };
  }, [open, cardId, qc, onOpenChange, onDone]);

  async function confirmar() {
    if (!supabase) return;
    setAplicando(true);
    // (a) limpa flag + destrava (best-effort)
    await supabase.rpc("liberar_card_suspeito_lockado", { p_card_id: cardId });
    // (b) aplica
    const { data, error } = await supabase.functions.invoke(
      "atualizar-card-via-portal-ssw",
      { body: { card_id: cardId } },
    );
    setAplicando(false);

    if (error || !data || (data as { ok?: boolean }).ok === false) {
      toast.error(error?.message ?? (data as { error?: string } | null)?.error ?? "Erro ao atualizar");
      return;
    }

    const decisao = (data as { decisao?: string }).decisao;
    const msgs: Record<string, string> = {
      resolvido: "Card finalizado",
      transferido: "Card transferido para outro setor",
      aguardando_voce: "Card atualizado — aguarda sua validação",
      aguardando_cliente: "Card atualizado — aguarda cliente",
      ja_atualizado: "Card já estava atualizado",
    };
    toast.success(msgs[decisao ?? ""] ?? "Card atualizado");

    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["cards"] });
    qc.invalidateQueries({ queryKey: ["conflitos"] });
    qc.invalidateQueries({ queryKey: ["inbox"] });
    onOpenChange(false);
    onDone?.();
  }

  const oc = preview?.oc_portal ?? "—";

  const { titulo, corpo } = (() => {
    if (!preview) return { titulo: "Forçar atualização", corpo: "" };
    if (preview.finalizadora) {
      return {
        titulo: "Ocorrência finalizadora",
        corpo: `Trata-se de ocorrência finalizadora (oc ${oc}). Se você aprovar, o card será finalizado e sairá automaticamente da sua visão. Tem certeza?`,
      };
    }
    if (preview.sai_da_visao) {
      return {
        titulo: "Card sairá da sua visão",
        corpo: `A última ocorrência (oc ${oc}) não é de relacionamento. Se você aprovar, o card sairá da sua visão e seguirá o fluxo dessa ocorrência. Tem certeza?`,
      };
    }
    return {
      titulo: "Atualizar card",
      corpo: `A última ocorrência é oc ${oc}. O card será atualizado e seguirá em tratativa no Cockpit. Confirmar?`,
    };
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-[18px]">{titulo}</DialogTitle>
          {!loadingPreview && !erro && preview && !preview.ja_atualizado && (
            <DialogDescription className="text-[13px] leading-relaxed text-ink">
              {corpo}
            </DialogDescription>
          )}
        </DialogHeader>

        {loadingPreview && (
          <div className="flex items-center gap-2 py-4 font-mono text-[11px] uppercase tracking-widest text-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Consultando SSW…
          </div>
        )}

        {erro && (
          <div className="border-2 border-sal bg-sal/10 px-3 py-2 font-mono text-[11px] text-sal-deep">
            {erro}
          </div>
        )}

        {!loadingPreview && !erro && preview && !preview.ja_atualizado && (
          <div className="border border-rule bg-paper-deep/40 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
            oc anterior: <span className="text-ink">{preview.oc_anterior ?? "—"}</span>
            <span className="mx-2">→</span>
            oc atual: <span className="text-ink">{preview.oc_portal ?? "—"}</span>
            {preview.state_alvo && (
              <>
                <span className="mx-2">·</span>destino: <span className="text-ink">{preview.state_alvo}</span>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={aplicando}
            className="border-2 border-ink bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink hover:bg-paper-deep disabled:opacity-40"
          >
            {erro || preview?.ja_atualizado ? "Fechar" : "Não"}
          </button>
          {!erro && preview && !preview.ja_atualizado && (
            <button
              type="button"
              onClick={confirmar}
              disabled={aplicando || loadingPreview}
              className="inline-flex items-center gap-2 border-2 border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-paper hover:bg-sal disabled:opacity-40"
            >
              {aplicando && <Loader2 className="h-3 w-3 animate-spin" />}
              Sim, aplicar
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
