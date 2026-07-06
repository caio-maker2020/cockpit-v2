import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { spineClass, type Tone } from "./tones";

/**
 * Casca ÚNICA de card do cockpit — `.ticket-card` (papel elevado + hairline +
 * hover) + espinha de prioridade à esquerda + clique. Extraída do
 * `article.ticket-card` do KanbanCard aprovado. As 3 telas usam esta casca;
 * o conteúdo (identidade/título/meta) é slotado por cada tela.
 *
 * - `to`   → renderiza <Link> (navegação declarativa, ex.: Conflitos).
 * - `onClick` → renderiza <div> clicável (ex.: Inbox/Extravios via navigate()).
 *   Botões internos que não devem navegar param a propagação (stopPropagation),
 *   comportamento já existente em KanbanCard (copiar NF) e BotaoReportarErroAgente.
 */
interface CockpitCardProps {
  spine?: Tone;
  to?: string;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}

export function CockpitCard({
  spine = "none",
  to,
  onClick,
  className,
  children,
}: CockpitCardProps) {
  const cls = cn(
    "ticket-card group block cursor-pointer p-2.5 animate-stagger border-l-2",
    spineClass[spine],
    className,
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <div onClick={onClick} className={cls}>
      {children}
    </div>
  );
}
