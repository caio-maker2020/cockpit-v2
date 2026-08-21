import { cn } from "@/lib/utils";

/**
 * Barra de KPIs + tile — redesign hifi (handoff 2a): card branco radius 14,
 * sombra suave, label mono 9.5px espaçada, número 700 32px.
 */
export function CockpitSummaryBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-[14px] px-7 py-4", className)}>
      {children}
    </div>
  );
}

type StatAccent = "sal" | "green" | "amber" | "ink" | "violet";

const LABEL_COLOR: Record<StatAccent, string> = {
  sal: "#E03131",
  green: "#37B24D",
  amber: "#C98A1B",
  ink: "#8B93A3",
  violet: "#7048E8",
};

export function CockpitStatTile({
  label,
  value,
  accent = "ink",
  hint,
}: {
  label: string;
  value: number | string;
  accent?: StatAccent;
  hint?: string;
}) {
  return (
    <div className="ticket-card min-w-0 flex-1 px-[22px] py-4">
      <div
        className="truncate font-mono text-[9.5px] font-semibold uppercase tracking-[0.13em]"
        style={{ color: LABEL_COLOR[accent] }}
      >
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="tabular text-[32px] font-bold leading-none text-ink-2">{value}</span>
        {hint && <span className="text-[11px] font-medium text-ink-mute">{hint}</span>}
      </div>
    </div>
  );
}
