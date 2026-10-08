// Filtro por FILIAL (unidade do SSW: VIT, MTC, MTZ…), à vista, com contagem. A escolha fica
// lembrada no navegador (usePersistentState, com try/catch). Operador de filial começa nas
// filiais dele; supervisão e gestão começam em "Todas".
import { cn } from "@/lib/utils";

export const FILIAL_PADRAO = "__padrao";
export const FILIAL_MINHAS = "__minhas";
/** null = todas; FILIAL_MINHAS = as do cadastro; FILIAL_PADRAO = ainda não escolheu; senão a sigla. */
export type EscolhaFilial = string | null;

function Chip({ ativo, onClick, children, testid }: { ativo: boolean; onClick: () => void; children: React.ReactNode; testid?: string }) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      data-testid={testid}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors active:scale-[0.97]",
        ativo ? "border-ink bg-ink text-white" : "border-rule bg-surface text-ink-soft-2 hover:text-ink-2",
      )}
    >
      {children}
    </button>
  );
}

const Conta = ({ v, ativo }: { v: number; ativo: boolean }) => (
  <span className={cn("tabular text-[12px]", ativo ? "text-white/75" : "text-ink-mute")}>{v.toLocaleString("pt-BR")}</span>
);

export function FiliaisOperacao({
  filiais,
  total,
  escolha,
  minhas,
  onEscolher,
}: {
  filiais: { unidade: string | null; total: number }[];
  total: number;
  escolha: string | null;
  minhas: string[] | null;
  onEscolher: (f: EscolhaFilial) => void;
}) {
  const totalMinhas = minhas ? filiais.filter((f) => f.unidade && minhas.includes(f.unidade)).reduce((a, f) => a + f.total, 0) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-[12.5px] font-semibold text-ink-2" id="filial-rotulo">
        Filial
      </span>
      <div role="group" aria-labelledby="filial-rotulo" className="-mr-4 flex min-w-0 flex-1 gap-1.5 overflow-x-auto pr-4 md:mr-0 md:pr-0">
        <Chip ativo={escolha == null} onClick={() => onEscolher(null)} testid="filial-todas">
          Todas <Conta v={total} ativo={escolha == null} />
        </Chip>
        {minhas && minhas.length > 0 && (
          <Chip ativo={escolha === FILIAL_MINHAS} onClick={() => onEscolher(FILIAL_MINHAS)} testid="filial-minhas">
            {minhas.length <= 3 ? `Minhas (${minhas.join(", ")})` : `Minhas ${minhas.length} filiais`} <Conta v={totalMinhas} ativo={escolha === FILIAL_MINHAS} />
          </Chip>
        )}
        {filiais.map((f) => {
          const id = f.unidade ?? "";
          const ativo = escolha === id;
          return (
            <Chip key={id || "sem"} ativo={ativo} onClick={() => onEscolher(id)} testid={`filial-${id || "sem"}`}>
              {f.unidade ?? "Sem filial"} <Conta v={f.total} ativo={ativo} />
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
