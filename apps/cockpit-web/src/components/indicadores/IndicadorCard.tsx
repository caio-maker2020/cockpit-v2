import { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { usePersistentState } from "@/hooks/usePersistentState";

interface Props {
  nome: string;
  icone: string;
  titulo: string;
  subtitulo?: string;
  resumoHeader: ReactNode;
  acoesHeader?: ReactNode;
  children: ReactNode;
}

/**
 * Card de indicador colapsável (1º nível). Persiste estado individualmente em
 * localStorage por `nome`. Inicia colapsado na 1ª visita.
 */
export function IndicadorCard({
  nome,
  icone,
  titulo,
  subtitulo,
  resumoHeader,
  acoesHeader,
  children,
}: Props) {
  const [expanded, setExpanded] = usePersistentState<boolean>(
    `indicador_${nome}_card_expanded`,
    false,
  );

  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left hover:bg-gray-50/60 transition-colors"
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[16px]">{icone}</span>
            <h2 className="font-display text-[15px] font-bold text-ink leading-tight">
              {titulo}
            </h2>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-soft leading-snug">
            {resumoHeader}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {acoesHeader && (
            <span onClick={(e) => e.stopPropagation()}>{acoesHeader}</span>
          )}
          <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" /> Recolher
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> Expandir
              </>
            )}
          </span>
        </div>
      </button>

      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-gray-200 p-5">
            {subtitulo && (
              <p className="mb-3 text-[12px] text-ink-soft">{subtitulo}</p>
            )}
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
