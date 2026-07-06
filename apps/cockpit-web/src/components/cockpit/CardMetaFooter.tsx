import { cn } from "@/lib/utils";

/**
 * Zona 3 do card (rodapé meta): `border-t` hairline + mono 10px mute,
 * itens à esquerda separados por espaço, bloco opcional à direita.
 * Extraída do KanbanCard aprovado.
 */
interface CardMetaFooterProps {
  left: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

export function CardMetaFooter({ left, right, className }: CardMetaFooterProps) {
  return (
    <div
      className={cn(
        "mt-2.5 flex items-center justify-between gap-2 border-t border-rule pt-2 font-mono text-[10px] text-ink-mute",
        className,
      )}
    >
      <div className="flex items-center gap-2">{left}</div>
      {right != null ? <div className="flex items-center gap-2">{right}</div> : <span />}
    </div>
  );
}
