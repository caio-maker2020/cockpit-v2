import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";

// VER EVIDÊNCIA da R1 Würth (Caio 2026-08-14): prova de que na data da consulta
// NÃO havia retorno da NF na intranet posterior à ocorrência-gatilho. Mostra os
// metadados legíveis (datas, logins, linhas de ciclo anterior rotuladas) + o
// snapshot HTML da consulta num iframe sandbox (signed URL do bucket privado
// wurth_evidencias — policy de SELECT pra authenticated na mig 341).

interface EvidenciaRow {
  id: string;
  nf: string;
  consultado_em: string;
  logins_usados: string[];
  gatilho_oc: number | null;
  gatilho_ts: string;
  data_54_ts: string | null;
  linhas_total: number;
  linhas_da_nf: Array<{ dataSolucao?: string; solucao?: string; obs?: string }>;
  veredicto: string;
  html_path: string | null;
}

function fmtBrt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ModalEvidenciaIntranetWurth({
  evidenciaId,
  open,
  onClose,
}: {
  evidenciaId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["wurth-evidencia", evidenciaId],
    enabled: !!supabase && open,
    queryFn: async () => {
      const { data: row, error: err } = await supabase!
        .from("wurth_evidencias_intranet")
        .select("*")
        .eq("id", evidenciaId)
        .maybeSingle();
      if (err) throw err;
      if (!row) throw new Error("evidência não encontrada");
      const ev = row as unknown as EvidenciaRow;
      let htmlUrl: string | null = null;
      if (ev.html_path) {
        const { data: signed } = await supabase!.storage
          .from("wurth_evidencias")
          .createSignedUrl(ev.html_path, 300);
        htmlUrl = signed?.signedUrl ?? null;
      }
      return { ev, htmlUrl };
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            Evidência — intranet Würth sem retorno
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 py-6 text-[12px] text-ink-mute">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando evidência…
          </div>
        )}
        {error != null && (
          <p className="py-4 text-[12px] text-signal-strong">
            Falha ao carregar a evidência: {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && (
          <div className="space-y-3 text-[12px] text-ink">
            <div className="rounded-md border border-rule bg-surface px-3 py-2 leading-relaxed">
              <p>
                Consulta feita em <strong>{fmtBrt(data.ev.consultado_em)}</strong> (logins:{" "}
                {data.ev.logins_usados.join(" + ") || "—"}) — a consulta inteira retornou{" "}
                {data.ev.linhas_total} linha(s).
              </p>
              <p className="mt-1">
                Para a NF <strong>{data.ev.nf}</strong>:{" "}
                <strong className="text-warning">
                  nenhum retorno da Würth posterior à oc {data.ev.gatilho_oc ?? "?"} de{" "}
                  {fmtBrt(data.ev.gatilho_ts)}
                </strong>
                {data.ev.data_54_ts ? ` (54 lançada em ${fmtBrt(data.ev.data_54_ts)})` : ""}.
              </p>
            </div>

            {data.ev.linhas_da_nf.length > 0 && (
              <div className="rounded-md border border-rule bg-surface-alt px-3 py-2">
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  linhas antigas da NF (ciclo anterior — não contam como retorno)
                </p>
                {data.ev.linhas_da_nf.map((l, i) => (
                  <p key={i} className="text-[11.5px] text-ink-soft">
                    {l.dataSolucao ?? "?"} · {l.solucao ?? "?"}
                    {l.obs ? ` — “${l.obs}”` : ""}
                  </p>
                ))}
              </div>
            )}

            {data.htmlUrl ? (
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  snapshot da consulta (como a intranet respondeu naquele momento)
                </p>
                <iframe
                  src={data.htmlUrl}
                  sandbox=""
                  title="Snapshot da consulta na intranet Würth"
                  className="h-[45vh] w-full rounded-md border border-rule bg-white"
                />
              </div>
            ) : (
              <p className="text-[11px] italic text-ink-mute">
                Snapshot HTML indisponível — os metadados acima são a evidência registrada.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
