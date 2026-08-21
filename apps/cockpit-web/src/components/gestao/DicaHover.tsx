// Tooltip real (CSS puro) — o title nativo do browser demora/não aparece em
// todo elemento; auditoria do Caio 21/08: "o ? não está funcionando".
import type { ReactNode } from "react";

export function DicaHover({ children, dica }: { children?: ReactNode; dica: ReactNode }) {
  return (
    <span className="group/dica relative inline-flex">
      {children ?? (
        <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-rule text-[10px] font-bold text-ink-mute group-hover/dica:border-sal group-hover/dica:text-sal">
          ?
        </span>
      )}
      <span className="pointer-events-none invisible absolute left-1/2 top-full z-50 mt-1.5 w-72 -translate-x-1/2 rounded-lg border border-rule bg-surface px-3 py-2.5 text-left text-[12px] font-normal normal-case leading-snug tracking-normal text-ink-soft-2 opacity-0 shadow-md-soft transition-opacity duration-150 group-hover/dica:visible group-hover/dica:opacity-100">
        {dica}
      </span>
    </span>
  );
}
