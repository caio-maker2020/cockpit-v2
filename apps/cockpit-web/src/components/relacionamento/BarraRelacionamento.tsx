// =============================================================================
// A ÚNICA barra de topo do Relacionamento (mesmo molde da Operação, ≤ 56 px):
//   [Trabalho | Torre]  [etapas do fluxo com contagem]  · N cards  [Meus cards ▾] [busca] [Filtros] [⋯]
// As etapas são a navegação das colunas. TODOS os filtros que o Inbox já tinha continuam
// (cliente, ocorrências, risco, tipo, CT-e, dono) — só mudaram de lugar ("nada pode sumir").
// =============================================================================
import { useEffect, useState } from "react";
import { Check, ChevronDown, Keyboard, MoreHorizontal, Search, SlidersHorizontal, X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ETAPAS_REL, type EtapaRelId } from "@/lib/relacionamento/torre";
import { ALL_TIPOS, type CardRisco, type CardTipo } from "@/lib/types";
import { cn } from "@/lib/utils";

export type DonoFiltro = "meus" | "todos" | "sem_dono";
export type TipoCteFiltro = "todos" | "NORMAL" | "DEVOLUCAO" | "REVERSA";

export interface FiltrosRel {
  busca: string;
  cliente: string;
  ocs: number[];
  risco: CardRisco | "todos";
  tipos: CardTipo[];
  tipoCte: TipoCteFiltro;
  dono: DonoFiltro;
}

export interface SettersRel {
  setBusca: (v: string) => void;
  setCliente: (v: string) => void;
  setOcs: (v: number[]) => void;
  setRisco: (v: CardRisco | "todos") => void;
  setTipos: (v: CardTipo[]) => void;
  setTipoCte: (v: TipoCteFiltro) => void;
  setDono: (v: DonoFiltro) => void;
}

const n = (v: number) => v.toLocaleString("pt-BR");
const ROT_TIPO: Record<CardTipo, string> = {
  rastreamento: "Rastreamento",
  reentrega: "Reentrega",
  devolucao: "Devolução",
  avaria: "Avaria",
  extravio: "Extravio",
  inversao: "Inversão",
  cobranca: "Cobrança",
  outros: "Outros",
};

function useEstreito(): boolean {
  const [e, setE] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 767px)");
    const f = () => setE(mq.matches);
    f();
    mq.addEventListener?.("change", f);
    return () => mq.removeEventListener?.("change", f);
  }, []);
  return e;
}

const CAMPO = "h-9 w-full rounded-[10px] border border-rule bg-surface px-2.5 text-[13px] text-ink-2 focus-visible:border-ink focus-visible:outline-none";
const BOTAO =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-rule bg-surface px-2.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-[var(--bg-subtle)] data-[state=open]:bg-[var(--bg-subtle)]";

export function filtrosAtivosRel(f: FiltrosRel): number {
  return [!!f.cliente, f.ocs.length > 0, f.risco !== "todos", f.tipos.length < ALL_TIPOS.length, f.tipoCte !== "todos"].filter(Boolean).length;
}

function Rot({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[12px] font-medium text-ink-soft-2">{children}</div>;
}

function Caixa({ marcado }: { marcado: boolean }) {
  return (
    <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border", marcado ? "border-ink bg-ink text-white" : "border-rule-strong")}>
      {marcado && <Check className="h-3 w-3" />}
    </span>
  );
}

function PainelFiltros({
  f,
  s,
  clientes,
  ocsDisponiveis,
  labelOc,
}: {
  f: FiltrosRel;
  s: SettersRel;
  clientes: string[];
  ocsDisponiveis: number[];
  labelOc: (c: number) => string;
}) {
  const [buscaOc, setBuscaOc] = useState("");
  const ocs = ocsDisponiveis.filter((c) => !buscaOc || String(c).includes(buscaOc) || labelOc(c).toLowerCase().includes(buscaOc.toLowerCase()));
  return (
    <div className="space-y-3.5">
      <div>
        <Rot>Cliente</Rot>
        <select aria-label="Filtrar por cliente" value={f.cliente} onChange={(e) => s.setCliente(e.target.value)} className={CAMPO}>
          <option value="">Todos os clientes</option>
          {clientes.map((c) => (
            <option key={c} value={c}>
              {c.slice(0, 40)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Rot>Risco</Rot>
        <div className="inline-flex w-full rounded-[10px] bg-[var(--bg-muted)] p-0.5" role="group" aria-label="Risco">
          {(["todos", "alto", "baixo"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={f.risco === r}
              onClick={() => s.setRisco(r)}
              className={cn("h-7 flex-1 rounded-[8px] text-[12.5px] font-medium", f.risco === r ? "bg-surface text-ink-2 shadow-[0_1px_2px_rgba(27,36,48,0.12)]" : "text-ink-soft-2")}
            >
              {r === "todos" ? "Qualquer" : r === "alto" ? "Alto" : "Baixo"}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Rot>Última ocorrência {f.ocs.length > 0 && <span className="text-ink-mute">· {f.ocs.length} escolhida{f.ocs.length > 1 ? "s" : ""}</span>}</Rot>
        <input
          value={buscaOc}
          onChange={(e) => setBuscaOc(e.target.value)}
          placeholder="Buscar por código ou descrição"
          aria-label="Buscar ocorrência"
          className={cn(CAMPO, "h-8 text-[16px] sm:text-[13px]")}
        />
        <div className="mt-1 max-h-40 overflow-y-auto rounded-[10px] border border-rule">
          {ocs.length === 0 ? (
            <p className="px-2.5 py-2 text-[12.5px] text-ink-mute">Nenhuma ocorrência.</p>
          ) : (
            ocs.map((c) => {
              const marcado = f.ocs.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => s.setOcs(marcado ? f.ocs.filter((x) => x !== c) : [...f.ocs, c].sort((a, b) => a - b))}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-subtle)]"
                >
                  <Caixa marcado={marcado} />
                  <span className="min-w-0 flex-1 truncate">{labelOc(c) || `Ocorrência ${c}`}</span>
                  <span className="tabular text-ink-mute">{c}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
      <div>
        <Rot>Tipo de caso</Rot>
        <div className="grid grid-cols-2 gap-1">
          {ALL_TIPOS.map((t) => {
            const marcado = f.tipos.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => s.setTipos(marcado ? f.tipos.filter((x) => x !== t) : [...f.tipos, t])}
                className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-left text-[12.5px] hover:bg-[var(--bg-subtle)]"
              >
                <Caixa marcado={marcado} />
                {ROT_TIPO[t]}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Rot>CT-e</Rot>
        <select aria-label="Filtrar por tipo de CT-e" value={f.tipoCte} onChange={(e) => s.setTipoCte(e.target.value as TipoCteFiltro)} className={CAMPO}>
          <option value="todos">Todos</option>
          <option value="NORMAL">Normal</option>
          <option value="DEVOLUCAO">Devolução</option>
          <option value="REVERSA">Reversa</option>
        </select>
      </div>
      {filtrosAtivosRel(f) > 0 && (
        <button
          type="button"
          onClick={() => {
            s.setCliente("");
            s.setOcs([]);
            s.setRisco("todos");
            s.setTipos(ALL_TIPOS);
            s.setTipoCte("todos");
          }}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-mute hover:text-ink-2"
        >
          <X className="h-3.5 w-3.5" /> Limpar filtros
        </button>
      )}
    </div>
  );
}

function SeletorDono({ dono, onDono, isGestor }: { dono: DonoFiltro; onDono: (d: DonoFiltro) => void; isGestor: boolean }) {
  const [aberto, setAberto] = useState(false);
  const opcoes: { id: DonoFiltro; rotulo: string }[] = [
    { id: "meus", rotulo: "Meus cards" },
    { id: "sem_dono", rotulo: "Sem dono" },
    ...(isGestor ? [{ id: "todos" as const, rotulo: "Todos" }] : []),
  ];
  const atual = opcoes.find((o) => o.id === dono)?.rotulo ?? "Meus cards";
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" className={BOTAO} aria-label={`Dono: ${atual}`} data-testid="dono-gatilho">
          <span className="font-semibold">{atual}</span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[200px] rounded-[12px] p-1.5">
        {opcoes.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              onDono(o.id);
              setAberto(false);
            }}
            className={cn("flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--bg-subtle)]", dono === o.id && "font-semibold")}
          >
            <Check className={cn("h-3.5 w-3.5", dono === o.id ? "opacity-100" : "opacity-0")} aria-hidden />
            {o.rotulo}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function BarraRelacionamento(p: {
  aba: "trabalho" | "torre";
  onAba: (a: "trabalho" | "torre") => void;
  contagens: Record<EtapaRelId, number>;
  mostrarTrilho: boolean;
  etapaAtiva: EtapaRelId | null;
  onEtapa: (id: EtapaRelId) => void;
  titulo: React.ReactNode;
  filtros: FiltrosRel;
  setters: SettersRel;
  clientes: string[];
  ocsDisponiveis: number[];
  labelOc: (c: number) => string;
  isGestor: boolean;
  /** Itens extras do "⋯" (ex.: visão geral dos clientes). */
  extrasMenu?: React.ReactNode;
  /** Demonstração: a prévia tem o atalho "c" (no card real, a aprovação é a de sempre). */
  demo?: boolean;
}) {
  const estreito = useEstreito();
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);
  const ativos = filtrosAtivosRel(p.filtros);
  const trabalho = p.aba === "trabalho";
  const etapasVisiveis = ETAPAS_REL.filter((e) => e.id !== "robo" || p.mostrarTrilho);

  const painel = <PainelFiltros f={p.filtros} s={p.setters} clientes={p.clientes} ocsDisponiveis={p.ocsDisponiveis} labelOc={p.labelOc} />;

  const abas = (
    <div role="tablist" aria-label="Visões do Relacionamento" className="inline-flex shrink-0 rounded-[10px] bg-[var(--bg-muted)] p-0.5">
      {(["trabalho", "torre"] as const).map((a) => (
        <button
          key={a}
          role="tab"
          type="button"
          aria-selected={p.aba === a}
          onClick={() => p.onAba(a)}
          className={cn(
            "h-7 rounded-[8px] px-3 text-[13px] font-semibold transition-colors",
            p.aba === a ? "bg-surface text-ink-2 shadow-[0_1px_2px_rgba(27,36,48,0.12)]" : "text-ink-soft-2 hover:text-ink-2",
          )}
        >
          {a === "trabalho" ? "Trabalho" : "Torre"}
        </button>
      ))}
    </div>
  );

  const etapas = (
    <nav aria-label="Etapas do fluxo" className="flex min-w-0 gap-0.5 overflow-x-auto">
      {etapasVisiveis.map((e) => {
        const v = p.contagens[e.id];
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={p.etapaAtiva === e.id}
            data-testid={`etapa-barra-${e.id}`}
            title={`${e.titulo}: ${e.dica}`}
            aria-label={`${e.titulo}: ${n(v)}`}
            onClick={() => p.onEtapa(e.id)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] transition-colors",
              p.etapaAtiva === e.id ? "bg-[var(--bg-muted)] text-ink-2" : "text-ink-soft-2 hover:bg-[var(--bg-subtle)] hover:text-ink-2",
              v === 0 && "opacity-50",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: e.cor }} aria-hidden />
            {e.curto}
            <span className="tabular font-semibold text-ink-2">{n(v)}</span>
          </button>
        );
      })}
    </nav>
  );

  const busca = trabalho && (
    <div className="relative shrink-0">
      {estreito && !buscaAberta && !p.filtros.busca ? (
        <button type="button" aria-label="Abrir busca" onClick={() => setBuscaAberta(true)} className={cn(BOTAO, "w-8 justify-center px-0")}>
          <Search className="h-4 w-4" />
        </button>
      ) : (
        <>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-mute" />
          <input
            autoFocus={estreito && buscaAberta}
            value={p.filtros.busca}
            onChange={(e) => p.setters.setBusca(e.target.value)}
            onBlur={() => setBuscaAberta(false)}
            placeholder="Buscar NF, CTRC, cliente"
            aria-label="Buscar cards"
            className="h-8 w-[168px] rounded-[9px] border border-rule bg-surface pl-8 pr-2 text-[16px] transition-[width] duration-150 focus:w-[240px] focus-visible:border-ink focus-visible:outline-none sm:text-[13px]"
          />
        </>
      )}
    </div>
  );

  const botaoFiltros = (
    <button type="button" className={BOTAO} aria-label={`Filtros${ativos ? ` (${ativos})` : ""}`}>
      <SlidersHorizontal className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Filtros</span>
      {ativos > 0 && <span className="tabular rounded-full bg-ink px-1.5 text-[11px] font-semibold text-white">{ativos}</span>}
    </button>
  );

  const filtrosUI =
    trabalho &&
    (estreito ? (
      <>
        <span onClick={() => setFiltrosAbertos(true)}>{botaoFiltros}</span>
        <Sheet open={filtrosAbertos} onOpenChange={setFiltrosAbertos}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-[16px]">
            <SheetHeader>
              <SheetTitle>Filtros</SheetTitle>
            </SheetHeader>
            <div className="mt-3">{painel}</div>
          </SheetContent>
        </Sheet>
      </>
    ) : (
      <Popover open={filtrosAbertos} onOpenChange={setFiltrosAbertos}>
        <PopoverTrigger asChild>{botaoFiltros}</PopoverTrigger>
        <PopoverContent align="end" className="max-h-[80vh] w-[300px] overflow-y-auto rounded-[12px] p-3">
          {painel}
        </PopoverContent>
      </Popover>
    ));

  const menu = (
    <Popover open={menuAberto} onOpenChange={setMenuAberto}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Mais opções" className={cn(BOTAO, "w-8 justify-center px-0")}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] rounded-[12px] p-1.5">
        {p.extrasMenu && <div className="mb-1">{p.extrasMenu}</div>}
        <div className="rounded-[8px] bg-[var(--bg-subtle)] px-2.5 py-2 text-[12px] text-ink-soft-2">
          <div className="mb-1 inline-flex items-center gap-1.5 font-semibold text-ink-2">
            <Keyboard className="h-3.5 w-3.5" aria-hidden /> Atalhos
          </div>
          <ul className="space-y-0.5">
            <li>
              <kbd className="rounded border border-rule bg-surface px-1">j</kbd> <kbd className="rounded border border-rule bg-surface px-1">k</kbd> próximo / anterior card
            </li>
            <li>
              <kbd className="rounded border border-rule bg-surface px-1">Enter</kbd> abre o card · <kbd className="rounded border border-rule bg-surface px-1">Esc</kbd> solta
            </li>
            {p.demo && (
              <li>
                <kbd className="rounded border border-rule bg-surface px-1">c</kbd> confirma na prévia
              </li>
            )}
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );

  const dono = trabalho && <SeletorDono dono={p.filtros.dono} onDono={p.setters.setDono} isGestor={p.isGestor} />;

  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-surface/95 backdrop-blur" aria-label="Barra do Relacionamento">
      {estreito ? (
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {abas}
            <div className="ml-auto flex items-center gap-1.5">
              {busca}
              {filtrosUI}
              {menu}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {dono}
            <div className="min-w-0 flex-1">{etapas}</div>
          </div>
          <div className="mt-1 px-0.5">{p.titulo}</div>
        </div>
      ) : (
        <div className="flex h-14 items-center gap-3 px-4 md:px-6">
          {abas}
          <span className="h-5 w-px shrink-0 bg-rule" aria-hidden />
          <div className="min-w-0 flex-1">{etapas}</div>
          <div className="sr-only shrink-0 min-[1400px]:not-sr-only">{p.titulo}</div>
          {dono}
          {busca}
          {filtrosUI}
          {menu}
        </div>
      )}
      <ChipsAtivos f={p.filtros} s={p.setters} labelOc={p.labelOc} />
    </header>
  );
}

/** Filtros que estão valendo (ficam lembrados entre visitas): à vista, com ×, para nada "sumir". */
function ChipsAtivos({ f, s, labelOc }: { f: FiltrosRel; s: SettersRel; labelOc: (c: number) => string }) {
  const chips: { k: string; t: string; tirar: () => void }[] = [];
  if (f.cliente) chips.push({ k: "cli", t: f.cliente, tirar: () => s.setCliente("") });
  for (const oc of f.ocs) chips.push({ k: `oc${oc}`, t: `${labelOc(oc) || "Ocorrência"} (${oc})`, tirar: () => s.setOcs(f.ocs.filter((x) => x !== oc)) });
  if (f.risco !== "todos") chips.push({ k: "risco", t: `Risco ${f.risco}`, tirar: () => s.setRisco("todos") });
  if (f.tipos.length < ALL_TIPOS.length)
    chips.push({ k: "tipos", t: f.tipos.length ? f.tipos.map((t) => ROT_TIPO[t]).join(", ") : "Nenhum tipo marcado (mostra todos)", tirar: () => s.setTipos(ALL_TIPOS) });
  if (f.tipoCte !== "todos") chips.push({ k: "cte", t: `CT-e ${f.tipoCte.toLowerCase()}`, tirar: () => s.setTipoCte("todos") });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-rule px-4 py-1.5 md:px-6" data-testid="filtros-ativos">
      <span className="text-[12px] text-ink-mute">Filtrando:</span>
      {chips.map((c) => (
        <span key={c.k} className="inline-flex max-w-[260px] items-center gap-1 rounded-full bg-[var(--bg-muted)] py-0.5 pl-2.5 pr-1 text-[12px] text-ink-2">
          <span className="truncate">{c.t}</span>
          <button type="button" onClick={c.tirar} aria-label={`Tirar filtro ${c.t}`} className="grid h-4 w-4 place-items-center rounded-full hover:bg-surface">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
