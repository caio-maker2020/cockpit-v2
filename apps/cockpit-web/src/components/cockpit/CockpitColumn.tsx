import { cn } from "@/lib/utils";
import { pillHeader, type Tone } from "./tones";

/**
 * Lane do cockpit — redesign hifi (handoff 2a): header é uma PÍLULA colorida
 * por status (radius 12, 600 12.5px) com a contagem dentro; a coluna em si é
 * transparente sobre o fundo branco. O corpo é slotado (cards ou empty state).
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
  const pill = pillHeader[tone];
  return (
    <section className="flex h-full w-[300px] min-w-[280px] max-w-[330px] shrink-0 flex-col">
      <header
        className={cn(
          "mb-2.5 flex items-center justify-between rounded-[12px] border px-[14px] py-[10px]",
          emphasize && "animate-pulse-soft",
        )}
        style={{ background: pill.bg, borderColor: pill.border, color: pill.text }}
      >
        <h2 className="text-[12.5px] font-semibold">{title}</h2>
        <span
          className="tabular font-mono text-[12px] font-bold"
          style={{ color: pill.count ?? pill.text }}
        >
          {count}
        </span>
      </header>

      <div className="flex-1 space-y-2.5 overflow-y-auto pb-3 pr-0.5">{children}</div>
    </section>
  );
}
