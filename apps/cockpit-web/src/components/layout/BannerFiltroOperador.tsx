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
    <div className="flex items-center justify-between border-b border-amber-300 bg-amber-100 px-6 py-2 text-amber-900">
      <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest">
        <Filter className="h-3.5 w-3.5" />
        Vendo apenas: <strong className="font-semibold">{operadorNome ?? operadorId}</strong>
      </span>
      <button
        type="button"
        onClick={limpar}
        className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-widest text-amber-900 underline-offset-4 hover:underline"
      >
        <X className="h-3 w-3" />
        Limpar filtro
      </button>
    </div>
  );
}
