/**
 * Tons semânticos compartilhados do cockpit — fonte única de cor de ponto (dot)
 * e de espinha (border-left) usada por colunas e cards nas 3 telas
 * (Inbox / Extravios / Conflitos). Extraído do KanbanColumn + KanbanCard aprovados.
 */
export type Tone =
  | "slate"
  | "sal"
  | "sal-deep"
  | "amber"
  | "emerald"
  | "sky"
  | "violet"
  | "indigo"
  | "orange"
  | "none";

/** Ponto de estado no header da coluna / risco no card. */
export const dotClass: Record<Tone, string> = {
  slate: "bg-slate-400",
  sal: "bg-sal",
  "sal-deep": "bg-sal-deep",
  amber: "bg-amber-500",
  emerald: "bg-emerald-600",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  indigo: "bg-indigo-500",
  orange: "bg-orange-500",
  none: "bg-rule-strong",
};

/** Espinha fina de prioridade à esquerda do card (sinal, não barra cheia). */
export const spineClass: Record<Tone, string> = {
  slate: "border-l-slate-400",
  sal: "border-l-sal",
  "sal-deep": "border-l-sal-deep",
  amber: "border-l-amber-500",
  emerald: "border-l-emerald-600",
  sky: "border-l-sky-500",
  violet: "border-l-violet-500",
  indigo: "border-l-indigo-500",
  orange: "border-l-orange-500",
  none: "border-l-transparent",
};
