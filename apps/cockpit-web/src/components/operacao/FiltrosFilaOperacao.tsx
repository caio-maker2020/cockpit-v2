import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  FILTROS_PADRAO,
  ROTULO_STATUS_LANCAMENTO,
  type FiltroStatus,
  type FiltroTempo,
  type FiltrosFila,
  type StatusLancamentoTela,
} from "@/lib/operacao/fila";

const SELECT =
  "h-9 max-w-[220px] rounded-[12px] border border-rule bg-surface px-3 font-mono text-[11px] uppercase tracking-wide text-ink-2";

const STATUS_OPCOES: StatusLancamentoTela[] = [
  "sem_lancamento",
  "na_fila",
  "lancando",
  "lancado",
  "confirmado",
  "nao_confirmado",
  "erro",
];

function Alternador({
  ativo,
  onClick,
  children,
  disabled,
  title,
}: {
  ativo: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-9 rounded-[12px] border px-3 font-mono text-[10.5px] uppercase tracking-widest transition-colors disabled:opacity-40",
        ativo ? "border-ink bg-ink text-white" : "border-rule bg-surface text-ink-soft-2 hover:text-ink-2",
      )}
    >
      {children}
    </button>
  );
}

export function FiltrosFilaOperacao({
  filtros,
  onChange,
  ocs,
  cidades,
  temUnidades,
}: {
  filtros: FiltrosFila;
  onChange: (f: FiltrosFila) => void;
  ocs: { codigo: number; descricao: string | null }[];
  cidades: string[];
  temUnidades: boolean;
}) {
  const set = <K extends keyof FiltrosFila>(k: K, v: FiltrosFila[K]) => onChange({ ...filtros, [k]: v });
  const algumAtivo = JSON.stringify({ ...filtros, busca: "" }) !== JSON.stringify({ ...FILTROS_PADRAO, busca: "" }) || !!filtros.busca;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-mute" />
        <Input
          value={filtros.busca}
          onChange={(e) => set("busca", e.target.value)}
          placeholder="Buscar NF, CTRC, pagador, destinatário…"
          aria-label="Buscar na fila"
          className="h-9 rounded-[12px] border border-rule bg-surface pl-8 font-mono text-[11.5px] focus-visible:border-sal focus-visible:ring-0"
        />
      </div>

      <Alternador
        ativo={filtros.minhasUnidades}
        onClick={() => set("minhasUnidades", !filtros.minhasUnidades)}
        disabled={!temUnidades}
        title={temUnidades ? "Só as unidades do seu cadastro" : "Seu cadastro não tem unidades"}
      >
        Minhas unidades
      </Alternador>

      <select
        aria-label="Filtrar por ocorrência"
        value={filtros.oc ?? ""}
        onChange={(e) => set("oc", e.target.value === "" ? null : Number(e.target.value))}
        className={SELECT}
      >
        <option value="">oc: todas</option>
        {ocs.map((o) => (
          <option key={o.codigo} value={o.codigo}>
            oc {o.codigo}
            {o.descricao ? ` · ${o.descricao.slice(0, 28)}` : ""}
          </option>
        ))}
      </select>

      <select
        aria-label="Filtrar por cidade"
        value={filtros.cidade ?? ""}
        onChange={(e) => set("cidade", e.target.value === "" ? null : e.target.value)}
        className={SELECT}
      >
        <option value="">Cidade: todas</option>
        {cidades.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select
        aria-label="Filtrar por tempo parado"
        value={filtros.tempo}
        onChange={(e) => set("tempo", e.target.value as FiltroTempo)}
        className={SELECT}
      >
        <option value="todos">Parado: qualquer</option>
        <option value="4h">Parado há 4 h+</option>
        <option value="24h">Parado há 24 h+</option>
        <option value="72h">Parado há 3 dias+</option>
      </select>

      <select
        aria-label="Filtrar por status do lançamento"
        value={filtros.status}
        onChange={(e) => set("status", e.target.value as FiltroStatus)}
        className={SELECT}
      >
        <option value="todos">Lançamento: todos</option>
        {STATUS_OPCOES.map((s) => (
          <option key={s} value={s}>
            {ROTULO_STATUS_LANCAMENTO[s]}
          </option>
        ))}
      </select>

      <Alternador ativo={filtros.comSugestao} onClick={() => set("comSugestao", !filtros.comSugestao)}>
        Com sugestão
      </Alternador>

      {algumAtivo && (
        <button
          type="button"
          onClick={() => onChange(FILTROS_PADRAO)}
          className="flex h-9 items-center gap-1 px-2 font-mono text-[10.5px] uppercase tracking-widest text-ink-mute hover:text-ink-2"
        >
          <X className="h-3 w-3" /> Limpar
        </button>
      )}
    </div>
  );
}
