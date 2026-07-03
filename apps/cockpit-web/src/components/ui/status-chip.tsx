import { ReactNode } from "react";

export type StatusTone = "neutral" | "signal" | "warning" | "positive" | "negative" | "ai";

const TONE_MAP: Record<StatusTone, { color: string; soft: string }> = {
  neutral:  { color: "var(--c-ink-mute)", soft: "var(--bg-subtle)" },
  signal:   { color: "var(--signal)",     soft: "var(--signal-soft)" },
  warning:  { color: "var(--warning)",    soft: "var(--warning-soft)" },
  positive: { color: "var(--positive)",   soft: "var(--positive-soft)" },
  negative: { color: "var(--negative)",   soft: "var(--negative-soft)" },
  ai:       { color: "var(--ai)",         soft: "var(--ai-soft)" },
};

// Map de estado do card → tone
const STATE_TONE: Record<string, StatusTone> = {
  AGUARDANDO_AGENTE: "neutral",
  AGUARDANDO_VALIDACAO_HUMANA: "signal",
  AGUARDANDO_CLIENTE: "warning",
  EXECUTANDO_ACAO: "signal",
  ACAO_EXECUTADA: "positive",
  TRANSFERIDO: "neutral",
  RESOLVIDO: "positive",
  CANCELADO: "negative",
  BLOQUEADO_POR_ERRO: "negative",
  ESCALADO_HUMANO: "warning",
};

interface StatusChipProps {
  state?: string;
  tone?: StatusTone;
  label?: ReactNode;
  pulse?: boolean;
  className?: string;
}

export function StatusChip({ state, tone, label, pulse, className = "" }: StatusChipProps) {
  const resolvedTone: StatusTone = tone ?? (state ? STATE_TONE[state] ?? "neutral" : "neutral");
  const cfg = TONE_MAP[resolvedTone];
  const text = label ?? (state ? state.replace(/_/g, " ") : "");

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-body text-micro uppercase ${className}`}
      style={{
        background: cfg.soft,
        color: cfg.color,
        borderColor: cfg.color,
        borderWidth: 1,
        borderStyle: "solid",
      }}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${pulse ? "animate-pulse-dot" : ""}`}
        style={{ background: cfg.color }}
        aria-hidden
      />
      {text}
    </span>
  );
}
