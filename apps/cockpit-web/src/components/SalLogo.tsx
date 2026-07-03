interface SalLogoProps {
  size?: number;
  subtag?: string | null;
  className?: string;
}

/**
 * Sal·Express wordmark. Bricolage Grotesque bold + ponto vermelho separador.
 */
export function SalLogo({ size = 18, subtag, className = "" }: SalLogoProps) {
  return (
    <div className={`inline-flex flex-col leading-none ${className}`}>
      <span
        className="font-display"
        style={{
          fontSize: `${size}px`,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color: "var(--c-ink)",
          lineHeight: 1,
        }}
      >
        Sal
        <span
          aria-hidden
          className="sal-dot inline-block"
          style={{
            color: "var(--signal)",
            fontWeight: 800,
            padding: "0 0.05em",
          }}
        >
          ·
        </span>
        Express
      </span>
      {subtag ? (
        <span
          className="font-mono"
          style={{
            marginTop: 4,
            fontSize: 10,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: "var(--c-ink-mute)",
            lineHeight: 1,
          }}
        >
          {subtag}
        </span>
      ) : null}
    </div>
  );
}
