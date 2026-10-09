import { Bot, Clock, Forward, Lightbulb } from "lucide-react";
import { Chip, type ChipTone } from "@/components/cockpit";
import {
  ROTULO_STATUS_LANCAMENTO,
  formatarDuracao,
  statusLancamentoTela,
  tomTempoParado,
  type StatusLancamentoTela,
} from "@/lib/operacao/fila";
import type { OpSugestao, StatusLancamentoOp } from "@/lib/operacao/tipos";
import { acaoDaSugestao, fonteDaSugestao, nivelCerteza, porQueSugestao, ROTULO_CERTEZA, rotuloSugestao, sugereAguardar, sugereEncaminhar } from "@/lib/operacao/sugestao";
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
  if (!sugestao || !acaoDaSugestao(sugestao)) return null;
  if (sugereAguardar(sugestao)) {
    // Aguardar: não é ação, é "nada a fazer agora" — sem botão, cor neutra.
    return (
      <span
        title={rotuloSugestao(sugestao)}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight"
        style={COR_AGUARDAR}
      >
        <Clock className="h-3 w-3" aria-hidden />
        Sugestão: aguardar
      </span>
    );
  }
  const encaminhar = sugereEncaminhar(sugestao);
  const pode = encaminhar || (lancavel ?? sugestao.lancavel !== false);
  const nivel = nivelCerteza(sugestao);
  const agente = fonteDaSugestao(sugestao) === "agente_ia";
  const Icone = agente ? Bot : encaminhar ? Forward : Lightbulb;
  return (
    <span
      title={`${rotuloSugestao(sugestao)}${porQueSugestao(sugestao) ? ` · ${porQueSugestao(sugestao)}` : ""}${pode ? "" : " (código ainda não liberado: só registro)"}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight",
        !pode && "bg-surface-alt text-ink-mute",
      )}
      // Vermelho Sal claro = lançar; violeta = encaminhar ao Relacionamento (a marca não usa azul).
      style={pode ? (encaminhar ? COR_ENCAMINHAR : COR_LANCAR) : undefined}
    >
      <Icone className="h-3 w-3" aria-hidden />
      {encaminhar ? "Sugestão: encaminhar" : `Sugestão: oc ${sugestao.codigo}`}
      {nivel && ` · ${ROTULO_CERTEZA[nivel]}`}
      {!pode && " · só registro"}
    </span>
  );
}

export const COR_LANCAR = { background: "var(--signal-soft)", color: "var(--signal-strong)" };
export const COR_AGUARDAR = { background: "var(--warning-soft)", color: "var(--warning-strong)" };
export const COR_ENCAMINHAR = { background: "var(--encaminhar-soft)", color: "var(--encaminhar)" };

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
