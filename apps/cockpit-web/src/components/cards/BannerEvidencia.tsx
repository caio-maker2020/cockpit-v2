import { AlertTriangle, CheckCircle, ExternalLink, Check } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";

interface BannerEvidenciaProps {
  card: {
    id: string;
    nf: string | null;
    cod_ultima_ocorrencia: number | null;
    evidencia_status: string | null;
    evidencia_diagnostico: string | null;
    evidencia_verificada_em: string | null;
  };
}

export function BannerEvidencia({ card }: BannerEvidenciaProps) {
  const [loading, setLoading] = useState(false);
  const qc = useQueryClient();

  const status = card.evidencia_status;

  // Badge verde discreto: IA validou OK
  if (status === "ok_com_foto_correlacionada") {
    return (
      <div className="mx-6 mt-3 inline-flex items-center gap-2 self-start border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">
        <CheckCircle className="h-3.5 w-3.5" />
        <span>
          IA validou: foto OK na linha da oc {card.cod_ultima_ocorrencia ?? "?"}
        </span>
      </div>
    );
  }

  // Banner amarelo: problema E não verificado ainda
  const visivel = status != null && card.evidencia_verificada_em == null;
  if (!visivel) return null;

  async function marcarVerificado() {
    setLoading(true);
    const { error } = await supabase
      .from("cards")
      .update({ evidencia_verificada_em: new Date().toISOString() })
      .eq("id", card.id);
    setLoading(false);
    if (error) {
      toast.error("Erro ao marcar verificado: " + error.message);
      return;
    }
    toast.success("Marcado como verificado");
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }

  const sswUrl = "https://ssw.inf.br/2/";

  return (
    <div className="mx-6 mt-3 rounded-md border border-yellow-400 bg-yellow-100 px-3 py-2 text-xs text-yellow-900">
      <div className="mb-1 flex items-center gap-2 font-mono font-bold uppercase tracking-wider">
        <AlertTriangle className="h-4 w-4" />
        IA — Validação de Evidência
      </div>
      <div className="text-[11px] leading-snug">
        {card.evidencia_diagnostico}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={sswUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 border border-yellow-700 bg-yellow-50 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-yellow-900 hover:bg-yellow-200"
        >
          <ExternalLink className="h-3 w-3" />
          Abrir SSW
        </a>
        <button
          onClick={marcarVerificado}
          disabled={loading}
          className="inline-flex items-center gap-1 border border-yellow-700 bg-yellow-50 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-yellow-900 hover:bg-yellow-200 disabled:opacity-40"
        >
          <Check className="h-3 w-3" />
          {loading ? "Salvando..." : "Marcar como verificado e ocultar"}
        </button>
      </div>
    </div>
  );
}
