import { ReactNode } from "react";
import { Sparkles, X } from "lucide-react";

export type AiBannerVariant =
  | "suggestion"   // signal — sugestão pra operador
  | "autonomous"   // ai amber — IA já executou
  | "analyzing"    // signal soft — IA processando
  | "failed"       // warning — falhou
  | "warning";     // warning — evidência incompleta etc

interface AiBannerProps {
  variant: AiBannerVariant;
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  metrics?: Array<{ label: string; value: string }>;
  primaryAction?: { label: string; onClick: () => void; loading?: boolean; disabled?: boolean };
  secondaryAction?: { label: string; onClick: () => void };
  children?: ReactNode;
}

const variantConfig: Record<AiBannerVariant, { color: string; soft: string; defaultEyebrow: string }> = {
  suggestion: { color: "var(--signal)", soft: "var(--signal-soft)", defaultEyebrow: "Agente operacional · Recomendação" },
  autonomous: { color: "var(--signal)", soft: "var(--bg-subtle)", defaultEyebrow: "Ação autônoma · Executada" },
  analyzing:  { color: "var(--signal)", soft: "var(--bg-subtle)", defaultEyebrow: "Agente analisando" },
  failed:     { color: "var(--warning)", soft: "var(--warning-soft)", defaultEyebrow: "Agente falhou" },
  warning:    { color: "var(--warning)", soft: "var(--warning-soft)", defaultEyebrow: "Atenção" },
};

export function AiBanner({
  variant,
  eyebrow,
  title,
  description,
  metrics,
  primaryAction,
  secondaryAction,
  children,
}: AiBannerProps) {
  const cfg = variantConfig[variant];

  return (
    <section
      className="animate-ai-banner relative w-full rounded-md p-5"
      style={{
        background: cfg.soft,
        borderLeft: `3px solid ${cfg.color}`,
      }}
    >
      <header className="flex items-center gap-2 font-mono uppercase" style={{ color: cfg.color, fontSize: 11, letterSpacing: "0.08em", fontWeight: 500 }}>
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
        <span>{eyebrow ?? cfg.defaultEyebrow}</span>
        {variant === "analyzing" && (
          <span className="ml-1 inline-flex items-center gap-1" aria-hidden>
            <span className="ai-pulse-dot inline-block h-1 w-1 rounded-full" style={{ background: cfg.color }} />
            <span className="ai-pulse-dot inline-block h-1 w-1 rounded-full" style={{ background: cfg.color }} />
            <span className="ai-pulse-dot inline-block h-1 w-1 rounded-full" style={{ background: cfg.color }} />
          </span>
        )}
      </header>

      <h3
        className="mt-2 font-display"
        style={{ color: "var(--c-ink)", fontSize: 22, fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.2 }}
      >
        {title}
      </h3>

      {description && (
        <div
          className="mt-2 font-body text-body-lg"
          style={{ color: "var(--c-ink-soft)", maxWidth: 680 }}
        >
          {description}
        </div>
      )}

      {metrics && metrics.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-caption" style={{ color: "var(--c-ink-soft)" }}>
          {metrics.map((m, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <span style={{ color: "var(--c-ink-mute)" }}>{m.label}</span>
              <span style={{ color: "var(--c-ink)" }}>{m.value}</span>
              {i < metrics.length - 1 && <span style={{ color: "var(--c-border-strong)" }}>·</span>}
            </span>
          ))}
        </div>
      )}

      {children && <div className="mt-3">{children}</div>}

      {(primaryAction || secondaryAction) && (
        <footer className="mt-4 flex items-center justify-between gap-3">
          {secondaryAction ? (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-body text-caption font-medium transition-colors hover:bg-bg-subtle"
              style={{ color: "var(--c-ink-mute)" }}
            >
              <X className="h-3.5 w-3.5" />
              {secondaryAction.label}
            </button>
          ) : <span />}

          {primaryAction ? (
            <button
              type="button"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.loading}
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 font-body text-body font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]"
              style={{ background: "var(--c-ink)", color: "var(--bg)" }}
            >
              {primaryAction.loading && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {primaryAction.label}
            </button>
          ) : null}
        </footer>
      )}
    </section>
  );
}
