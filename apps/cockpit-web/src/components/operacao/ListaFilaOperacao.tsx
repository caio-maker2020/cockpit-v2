import { AlertTriangle, UserRound } from "lucide-react";
import type { AvisoConselheiro } from "@/lib/operacao/torre";
import { familiaDaOc, familiaPorId } from "@/lib/operacao/familias";
import { frase } from "@/lib/operacao/sugestao";
import { dotClass } from "@/components/cockpit/tones";
import { cn } from "@/lib/utils";
import { sugestaoLancavel } from "@/lib/operacao/sugestao";
import { rotuloCidade, situacaoPrazo, tempoParadoMs } from "@/lib/operacao/fila";
import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { ChipStatusLancamento, ChipSugestao, TempoParado } from "./ChipsOperacao";

export function ListaFilaOperacao({
  linhas,
  agoraMs,
  selecionadoId,
  meuMembroId,
  codigosLiberados = null,
  avisoDaNota,
  onSelecionar,
}: {
  linhas: OpFilaLinha[];
  agoraMs: number;
  selecionadoId: string | null;
  meuMembroId: string | null;
  codigosLiberados?: ReadonlySet<number> | null;
  avisoDaNota?: ReadonlyMap<string, AvisoConselheiro>;
  onSelecionar: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-[var(--c-border)]" aria-label="Fila da Operação">
      {linhas.map((l) => {
        const prazo = situacaoPrazo(l, agoraMs);
        const cidade = rotuloCidade(l);
        const sel = l.op_item_id === selecionadoId;
        const meu = !!meuMembroId && l.assumido_por === meuMembroId;
        return (
          <li key={l.op_item_id}>
            <button
              type="button"
              onClick={() => onSelecionar(l.op_item_id)}
              aria-current={sel ? "true" : undefined}
              data-testid={`linha-${l.op_item_id}`}
              className={cn(
                "relative grid w-full grid-cols-[auto,1fr] gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30 md:px-7",
                sel ? "bg-surface-alt" : "hover:bg-[var(--bg-subtle)]",
              )}
            >
              {sel && <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-sal" />}
              <div className="row-span-2 pt-0.5">
                <TempoParado ms={tempoParadoMs(l, agoraMs)} compacto />
              </div>

              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="text-[13.5px] font-semibold text-ink-2">{l.nf ? `NF ${l.nf}` : `CTRC ${l.ctrc}`}</span>
                <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft-2">
                  <span className={cn("h-1.5 w-1.5 rounded-full", dotClass[familiaPorId(familiaDaOc(l.cod_ultima_ocorrencia)).tom])} aria-hidden />
                  {familiaPorId(familiaDaOc(l.cod_ultima_ocorrencia)).titulo}
                </span>
                {l.descricao_oc && <span className="min-w-0 truncate text-[12px] text-ink-mute">{frase(l.descricao_oc)}</span>}
                <span className="text-[11.5px] font-medium text-ink-mute">base {l.unidade ?? "sem filial"}</span>
                {avisoDaNota?.get(l.op_item_id) && (
                  <span className="inline-flex items-center gap-1 text-[11.5px] font-medium" style={{ color: "var(--warning-strong)" }}>
                    <AlertTriangle className="h-3 w-3" aria-hidden /> Conselheiro
                  </span>
                )}
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-soft-2">
                <span className="min-w-0 truncate">
                  {l.destinatario ?? "Sem destinatário"}
                  {cidade ? ` · ${cidade}` : ""}
                </span>
                {l.pagador && <span className="hidden min-w-0 truncate text-ink-mute lg:inline">Pagador: {l.pagador}</span>}
                <span style={{ color: prazo.atrasado ? "var(--signal-strong)" : undefined }}>{prazo.texto}</span>
                {l.assumido_por_nome && (
                  <span className={cn("inline-flex items-center gap-1", meu && "font-semibold text-ink-2")}>
                    <UserRound className="h-3 w-3" aria-hidden />
                    {meu ? "com você" : l.assumido_por_nome}
                  </span>
                )}
                <ChipSugestao sugestao={l.sugestao} lancavel={sugestaoLancavel(l.sugestao, codigosLiberados, l.cod_ultima_ocorrencia)} />
                <ChipStatusLancamento status={l.lancamento_status} codigo={l.lancamento_codigo_oc} />
                {l.encaminhamento_id && (
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ background: "var(--encaminhar-soft)", color: "var(--encaminhar)" }}
                  >
                    Encaminhamento agendado
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
