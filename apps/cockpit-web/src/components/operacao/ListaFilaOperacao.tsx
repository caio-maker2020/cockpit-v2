import { UserRound } from "lucide-react";
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
  onSelecionar,
}: {
  linhas: OpFilaLinha[];
  agoraMs: number;
  selecionadoId: string | null;
  meuMembroId: string | null;
  codigosLiberados?: ReadonlySet<number> | null;
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
                "relative grid w-full grid-cols-[auto,1fr] gap-x-3 gap-y-1 px-5 py-3 text-left transition-colors md:px-7",
                sel ? "bg-surface-alt" : "hover:bg-[var(--bg-subtle)]",
              )}
            >
              {sel && <span aria-hidden className="absolute left-0 top-0 h-full w-[3px] bg-sal" />}
              <div className="row-span-2 pt-0.5">
                <TempoParado ms={tempoParadoMs(l, agoraMs)} compacto />
              </div>

              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-[12.5px] font-semibold text-ink-2">NF {l.nf ?? "—"}</span>
                <span className="font-mono text-[11.5px] text-ink-soft-2">CTRC {l.ctrc}</span>
                <span className="min-w-0 truncate text-[12.5px] text-ink-2">
                  <span className="font-mono font-semibold">oc {l.cod_ultima_ocorrencia ?? "—"}</span>
                  {l.descricao_oc ? ` · ${l.descricao_oc}` : ""}
                </span>
                <span className="rounded-[5px] border border-rule px-1.5 font-mono text-[10px] font-semibold uppercase text-ink-soft-2">
                  {l.unidade ?? "sem unidade"}
                </span>
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-soft-2">
                <span className="min-w-0 truncate">
                  {l.destinatario ?? "Destinatário —"}
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
                    style={{ background: "rgba(109,40,217,0.12)", color: "#6D28D9" }}
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
