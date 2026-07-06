import { cn } from "@/lib/utils";
import { dotClass, type Tone } from "./tones";

/**
 * Lane do cockpit (placa de estação). Extraída do KanbanColumn aprovado:
 * casca `bg-surface-alt/40` + header (ponto de estado + título + pill de
 * contagem) + realce de topo Sal quando crítico. O corpo é slotado (cards ou
 * CockpitEmptyState). Usada por Inbox e Extravios.
 */
interface CockpitColumnProps {
  tone: Tone;
  title: string;
  count: number;
  emphasize?: boolean;
  children: React.ReactNode;
}

export function CockpitColumn({
  tone,
  title,
  count,
  emphasize = false,
  children,
}: CockpitColumnProps) {
  return (
    <section className="flex h-full w-[300px] min-w-[280px] max-w-[330px] shrink-0 flex-col rounded-md border border-rule bg-surface-alt/40">
      <header
        className={cn(
          "flex items-center gap-2 px-3 pb-2.5 pt-3",
          emphasize && "border-t-2 border-t-sal rounded-t-md -mt-px",
        )}
      >
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            dotClass[tone],
            emphasize && "animate-pulse-soft",
          )}
        />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink">{title}</h2>
        <span className="tabular ml-auto rounded-full border border-rule bg-surface px-2 py-0.5 font-mono text-[10px] font-medium text-ink-soft">
          {count}
        </span>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-3">{children}</div>
    </section>
  );
}
