import { ReactNode } from "react";
import { SalLogo } from "@/components/SalLogo";

interface EmptyStateProps {
  decorative?: ReactNode;       // ex: "/00" ou um glyph
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  showLogo?: boolean;
}

export function EmptyState({
  decorative = "/00",
  title,
  description,
  action,
  showLogo = true,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div
        className="font-mono select-none leading-none"
        style={{
          fontSize: "clamp(64px, 9vw, 96px)",
          fontWeight: 500,
          opacity: 0.3,
          color: "var(--signal)",
          letterSpacing: "-0.02em",
        }}
        aria-hidden
      >
        {decorative}
      </div>
      <h3
        className="mt-8 font-display"
        style={{ color: "var(--c-ink)", fontSize: 22, fontWeight: 700, letterSpacing: "-0.015em" }}
      >
        {title}
      </h3>
      {description && (
        <p className="mt-2 font-body text-body" style={{ color: "var(--c-ink-mute)", maxWidth: 420 }}>
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
      {showLogo && (
        <div className="mt-12" style={{ opacity: 0.35 }}>
          <SalLogo size={14} />
        </div>
      )}
    </div>
  );
}
