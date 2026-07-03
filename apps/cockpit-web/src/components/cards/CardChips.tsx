import { cn } from "@/lib/utils";
import type { CardState, CardRisco, CardTipo } from "@/lib/types";
import { stateBadgeClasses, stateTone, tipoChipClasses } from "@/lib/format";

export function StateBadge({
  state,
  risco,
  size = "sm",
}: {
  state: CardState;
  risco?: CardRisco | null;
  size?: "sm" | "lg";
}) {
  const tone = stateTone(state, risco);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md font-medium whitespace-nowrap",
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2.5 py-1 text-[13px]",
        stateBadgeClasses(tone),
      )}
    >
      {state.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function RiscoDot({ risco }: { risco: CardRisco | null }) {
  if (risco === "alto") {
    return (
      <span
        title="Risco alto"
        className="inline-block h-2 w-2 rounded-full bg-status-block"
      />
    );
  }
  return (
    <span
      title="Risco baixo"
      className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
    />
  );
}

export function TipoChip({ tipo }: { tipo: CardTipo | null }) {
  if (!tipo) return <span className="text-muted-foreground text-[12px]">—</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        tipoChipClasses(tipo),
      )}
    >
      {tipo}
    </span>
  );
}
