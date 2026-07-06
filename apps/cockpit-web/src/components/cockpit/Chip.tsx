import { cn } from "@/lib/utils";

/**
 * Pill de sinal forte do card texto-primeiro. Extraído do KanbanCard aprovado
 * (tons crit/neutral) + positive/warning pras variações operacionais.
 */
export type ChipTone = "crit" | "neutral" | "positive" | "warning";

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: ChipTone;
  children: React.ReactNode;
}) {
  const map: Record<ChipTone, string> = {
    crit: "bg-signal-soft text-signal-strong",
    neutral: "bg-surface-alt text-ink-soft",
    positive: "bg-positive-soft text-positive",
    warning: "bg-warning-soft text-warning",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}
