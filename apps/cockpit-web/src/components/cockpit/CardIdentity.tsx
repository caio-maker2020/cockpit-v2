import { cn } from "@/lib/utils";

/**
 * Zona 1 do card (identidade): NF mono-semibold + CTRC mono-mute + slot à
 * direita. Extraída do KanbanCard aprovado. Aceita nós para NF/CTRC (o Inbox
 * passa botões copiáveis; Extravios/Conflitos passam texto) — a tipografia
 * padrão só é aplicada quando o valor é string/número.
 */
interface CardIdentityProps {
  nf: React.ReactNode;
  ctrc?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

export function CardIdentity({ nf, ctrc, right, className }: CardIdentityProps) {
  return (
    <div className={cn("flex items-baseline gap-2", className)}>
      {typeof nf === "string" || typeof nf === "number" ? (
        <span className="tabular font-mono text-[13px] font-semibold text-ink">{nf}</span>
      ) : (
        nf
      )}
      {ctrc != null &&
        (typeof ctrc === "string" || typeof ctrc === "number" ? (
          <span className="tabular font-mono text-[10px] text-ink-mute">{ctrc}</span>
        ) : (
          ctrc
        ))}
      {right != null && <span className="ml-auto flex items-center gap-2">{right}</span>}
    </div>
  );
}
