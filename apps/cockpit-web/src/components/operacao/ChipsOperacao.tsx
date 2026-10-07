import { Lightbulb } from "lucide-react";
import { Chip, type ChipTone } from "@/components/cockpit";
import {
  ROTULO_STATUS_LANCAMENTO,
  formatarDuracao,
  statusLancamentoTela,
  tomTempoParado,
  type StatusLancamentoTela,
} from "@/lib/operacao/fila";
import type { OpSugestao, StatusLancamentoOp } from "@/lib/operacao/tipos";
import { lerConfianca, textoConfianca } from "@/lib/operacao/sugestao";
import { cn } from "@/lib/utils";

const TOM_STATUS: Record<StatusLancamentoTela, ChipTone> = {
  sem_lancamento: "neutral",
  na_fila: "warning",
  lancando: "warning",
  lancado: "neutral",
  confirmado: "positive",
  nao_confirmado: "crit",
  erro: "crit",
};

export function ChipStatusLancamento({
  status,
  codigo,
  mostrarSemLancamento = false,
}: {
  status: StatusLancamentoOp | null;
  codigo?: number | null;
  mostrarSemLancamento?: boolean;
}) {
  const s = statusLancamentoTela(status);
  if (s === "sem_lancamento" && !mostrarSemLancamento) return null;
  return (
    <Chip tone={TOM_STATUS[s]}>
      {ROTULO_STATUS_LANCAMENTO[s]}
      {codigo != null && s !== "sem_lancamento" ? ` · oc ${codigo}` : ""}
    </Chip>
  );
}

export function ChipSugestao({ sugestao, lancavel }: { sugestao: OpSugestao | null; lancavel?: boolean }) {
  if (!sugestao) return null;
  const pode = lancavel ?? sugestao.lancavel !== false;
  const pct = lerConfianca(sugestao).pct;
  const explica = textoConfianca(sugestao);
  return (
    <span
      title={`${explica ?? ""}${sugestao.motivo ? ` · ${sugestao.motivo}` : ""}${pode ? "" : " (código ainda não liberado: só registro)"}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight",
        !pode && "bg-surface-alt text-ink-mute",
      )}
      // Violeta (o mesmo das tiles do kit): sugestão é oportunidade, não alarme — o vermelho é do alerta.
      style={pode ? { background: "rgba(112,72,232,0.12)", color: "#7048E8" } : undefined}
    >
      <Lightbulb className="h-3 w-3" aria-hidden />
      Sugestão: {sugestao.codigo}
      {pct != null && ` · ${pct}%`}
      {!pode && " · só registro"}
    </span>
  );
}

export function TempoParado({ ms, compacto = false }: { ms: number | null; compacto?: boolean }) {
  const tom = tomTempoParado(ms);
  return (
    <span
      className={cn(
        "tabular inline-flex min-w-[64px] items-center justify-center whitespace-nowrap rounded-md font-mono font-semibold",
        compacto ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-[12px]",
      )}
      style={{
        background: tom === "critico" ? "var(--signal-soft)" : tom === "atencao" ? "var(--warning-soft)" : "var(--bg-subtle)",
        color: tom === "critico" ? "var(--signal-strong)" : tom === "atencao" ? "var(--warning)" : "var(--c-ink-soft)",
      }}
      title="Parado desde a última ocorrência"
    >
      {formatarDuracao(ms)}
    </span>
  );
}
