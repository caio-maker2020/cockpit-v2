import { cn } from "@/lib/utils";

/**
 * Barra de KPIs read-only + o tile. Extraídos da barra de KPIs e do StatTile
 * aprovados do Inbox. Usados nas 3 telas — os números são derivados dos dados
 * já buscados por cada tela (nenhuma query nova).
 */
export function CockpitSummaryBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-3 border-b border-rule bg-paper px-6 py-4", className)}>
      {children}
    </div>
  );
}

type StatAccent = "sal" | "green" | "amber" | "ink" | "violet";

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
  const dot =
    accent === "sal"
      ? "bg-sal"
      : accent === "green"
        ? "bg-emerald-600"
        : accent === "amber"
          ? "bg-amber-500"
          : accent === "violet"
            ? "bg-violet-500"
            : "bg-ink";
  return (
    <div className="min-w-0 flex-1 rounded-md border border-rule bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-mute">
          {label}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="tabular font-mono text-[26px] font-semibold leading-none text-ink">
          {value}
        </span>
        {hint && <span className="text-[11px] font-medium text-ink-mute">{hint}</span>}
      </div>
    </div>
  );
}
