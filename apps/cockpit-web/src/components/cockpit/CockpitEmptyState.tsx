/**
 * Estado vazio do cockpit — glifo calmo + texto itálico. Extraído do
 * EmptyState aprovado do Inbox (generalizado: recebe glyph/text). Usado nas
 * lanes e listas das 3 telas.
 */
interface CockpitEmptyStateProps {
  glyph: string;
  text: string;
}

export function CockpitEmptyState({ glyph, text }: CockpitEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <span className="font-display text-[32px] text-rule-strong">{glyph}</span>
      <p className="mt-2 font-display text-[12px] italic leading-snug text-ink-soft">{text}</p>
    </div>
  );
}
