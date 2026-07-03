import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import type { CardWithRelations } from "@/lib/types";

function formatDataHora(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function BannerBounceEmail({ card }: { card: CardWithRelations }) {
  const qc = useQueryClient();

  if (!card.ultimo_bounce_em || card.cliente_respondeu_em) return null;

  async function dispensar() {
    const { error } = await supabase
      .from("cards")
      .update({ ultimo_bounce_em: null, ultimo_bounce_payload: null })
      .eq("id", card.id);
    if (error) {
      toast.error(`Não consegui dispensar: ${error.message}`);
      return;
    }
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    qc.invalidateQueries({ queryKey: ["cards"] });
    toast.success("Aviso dispensado");
  }

  const destinatario = card.ultimo_bounce_payload?.destinatario ?? "destino";
  const motivo = card.ultimo_bounce_payload?.motivo_smtp;

  return (
    <div className="mx-6 mt-3 border border-amber-400 bg-amber-50 px-3 py-2 text-amber-900">
      <div className="flex items-start gap-2">
        <span className="font-mono text-lg font-bold leading-none text-amber-600">!</span>
        <div className="flex-1 text-xs">
          <div className="mb-1 font-mono font-bold uppercase tracking-wider">
            Email bloqueado pelo servidor do cliente
          </div>
          <div className="leading-snug">
            O servidor de <span className="font-semibold">{destinatario}</span> rejeitou
            o email enviado em {formatDataHora(card.ultimo_bounce_em)}.
            {motivo && (
              <div className="mt-1 font-mono text-[11px] text-amber-800">
                {motivo}
              </div>
            )}
          </div>
          <div className="mt-1 leading-snug">
            O cliente pode ter recebido em outro endereço (quarentena, spam, alias).
            Confirme recebimento por outro canal antes de aguardar resposta.
          </div>
          <button
            onClick={dispensar}
            className="mt-2 text-xs underline text-amber-900 hover:text-amber-700"
          >
            Já confirmei — dispensar aviso
          </button>
        </div>
      </div>
    </div>
  );
}
