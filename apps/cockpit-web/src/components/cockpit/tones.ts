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


/**
 * Pílula de header de coluna — handoff hifi (2a): cada status tem
 * fundo/borda/texto próprios; "sal-deep" é a coluna escura (Ação não
 * executada) com contagem coral. Fonte única pro CockpitColumn.
 */
export const pillHeader: Record<Tone, { bg: string; border: string; text: string; count?: string }> = {
  slate:      { bg: "#FFFFFF", border: "#C6CBD4", text: "#1B2430" },
  sal:        { bg: "#FDECEC", border: "#E03131", text: "#E03131" },
  "sal-deep": { bg: "#1B2430", border: "#1B2430", text: "#FFFFFF", count: "#FF8A80" },
  amber:      { bg: "#FFF4E0", border: "#F59F00", text: "#C98A1B" },
  emerald:    { bg: "#EBF9EE", border: "#37B24D", text: "#2B9A40" },
  sky:        { bg: "#EDF4FE", border: "#3B7DDD", text: "#3B7DDD" },
  violet:     { bg: "#F3F0FF", border: "#845EF7", text: "#7048E8" },
  indigo:     { bg: "#EDF4FE", border: "#3B7DDD", text: "#3B7DDD" },
  orange:     { bg: "#FFECE3", border: "#F76707", text: "#D9480F" },
  none:       { bg: "#FFFFFF", border: "#E8EAEF", text: "#4B5262" },
};
