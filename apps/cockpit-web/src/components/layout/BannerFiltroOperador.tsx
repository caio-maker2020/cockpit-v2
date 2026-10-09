import { Filter, X } from "lucide-react";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";

/**
 * Banner fixo amarelo, abaixo do header, indicando filtro global ativo.
 * Some quando filtroOperadorId = null.
 */
export function BannerFiltroOperador() {
  const { operadorId, operadorNome, limpar } = useFiltroOperadorStore();
  if (!operadorId) return null;

  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center justify-between gap-3 border-b px-4 text-[12.5px] md:px-6"
      style={{ background: "var(--warning-soft)", borderColor: "var(--c-border)", color: "var(--c-ink)" }}
    >
      <span className="flex min-w-0 items-center gap-2 truncate">
        <Filter className="h-3.5 w-3.5 shrink-0" aria-hidden style={{ color: "var(--warning)" }} />
        <span className="truncate">Vendo apenas <strong className="font-semibold">{operadorNome ?? operadorId}</strong></span>
      </span>
      <button
        type="button"
        onClick={limpar}
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
        Limpar filtro
      </button>
    </div>
  );
}
