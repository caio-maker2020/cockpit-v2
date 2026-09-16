// =============================================================================
// pdi-ui — primitivos visuais do PDI, extraídos 1:1 do idioma REAL do Cockpit
// (Caio 16/09: "deixe exatamente igual e inspirado no cockpit... relances
// vermelhos, botões padronizados"). Fontes: .ticket-card (index.css),
// botões do ProposedActions (bg-sal/mono/uppercase; outline border-ink/30),
// chip selecionado "border-sal bg-sal text-paper" (ProposedActions:508),
// callout ✦ em signal-soft (padrão "Agente encontrou...").
// NUNCA usar Button do shadcn nesta aba — o padrão do Cockpit é este.
// =============================================================================
import { cn } from "@/lib/utils";

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

/** Botão primário do Cockpit — vermelho Sal, mono uppercase. */
export function BotaoSal({ className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cn(
        "rounded-[8px] bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    />
  );
}

/** Botão escuro (ação forte não-crítica). */
export function BotaoInk({ className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cn(
        "rounded-[8px] bg-ink px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-sal disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    />
  );
}

/** Botão secundário/outline do Cockpit. */
export function BotaoLinha({ className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cn(
        "rounded-[8px] border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
    />
  );
}

/** Chip de seleção: selecionado = vermelho Sal cheio (idioma ProposedActions). */
export function Escolha({ ativo, onClick, children }: {
  ativo: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors",
        ativo
          ? "border-sal bg-sal text-paper"
          : "border-rule bg-paper text-ink-soft hover:border-sal/60 hover:text-sal",
      )}
    >
      {children}
    </button>
  );
}

/** Cartão-papel do Cockpit (.ticket-card) com espinha opcional à esquerda. */
export function Cartao({ className, spineSal, children }: {
  className?: string; spineSal?: boolean; children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "ticket-card p-4",
        spineSal && "border-l-2 border-l-sal",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Rótulo de seção — micro mono uppercase, como nas telas do Cockpit. */
export function Rotulo({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn(
      "font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-ink-mute",
      className,
    )}>
      {children}
    </div>
  );
}

/** Callout vermelho-suave com ✦ — o mesmo relance do "Agente encontrou…". */
export function Callout({ titulo, children }: { titulo: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-[10px] bg-signal-soft px-3.5 py-3">
      <div className="text-[13px] font-semibold text-signal">✦ {titulo}</div>
      {children && <div className="mt-1.5 text-[13px] leading-snug text-ink-2">{children}</div>}
    </div>
  );
}

/** Chip mono de código/valor (NF-style). */
export function ChipCodigo({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[6px] bg-surface-alt px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-soft tabular">
      {children}
    </span>
  );
}
