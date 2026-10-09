// =============================================================================
// A ÚNICA barra de topo da Operação (pedido do dono, 08/10: "olha a quantidade de coisa antes
// de chegar no card"). Uma linha no notebook, duas no celular:
//   [Trabalho | Torre]  [etapas do fluxo com contagem]  ·  N notas · lida às HH:MM
//   [Filial ▾] [busca] [Filtros] [⋯]
// As etapas SÃO a navegação das colunas. Filial com busca e contagem; filtros num popover (no
// celular, num painel de baixo); visões alternativas, espelho e atalhos no "⋯".
// =============================================================================
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownUp, Check, ChevronDown, Columns3, Keyboard, List, MoreHorizontal, Search, SlidersHorizontal, X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FILTROS_PADRAO, ROTULO_STATUS_LANCAMENTO, type FiltroStatus, type FiltroTempo, type FiltrosFila, type StatusLancamentoTela } from "@/lib/operacao/fila";
import { ETAPAS_FLUXO, type EtapaFluxoId } from "@/lib/operacao/torre";
import { cn } from "@/lib/utils";
import { FILIAL_MINHAS, type EscolhaFilial } from "./FiliaisOperacao";
import { nomeDoSetor } from "@/lib/operacao/setores";

export type VisaoOperacao = "fluxo" | "problema" | "andamento" | "lista";
/** Abas da Operação (ADR 0042): Trabalho | Gestão | Comprovantes | Torre. Gestão só para supervisão, gerente e gestor. */
export type AbaOperacao = "trabalho" | "gestao" | "comprovantes" | "torre";
const ROTULO_ABA: Record<AbaOperacao, string> = { trabalho: "Trabalho", gestao: "Gestão", comprovantes: "Comprovantes", torre: "Torre" };
/** Escolha de setor: null = todos os setores; "MEUS" = os setores do membro. */
export const SETOR_MEUS = "MEUS";

const n = (v: number) => v.toLocaleString("pt-BR");

/** Largura de celular, sem quebrar onde não há matchMedia (testes). */
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

const STATUS_OPCOES: StatusLancamentoTela[] = ["sem_lancamento", "na_fila", "lancando", "lancado", "confirmado", "nao_confirmado", "erro"];

/** Quantos filtros (fora a busca) estão valendo. */
export function filtrosAtivos(f: FiltrosFila): number {
  return [f.cidade != null, f.tipoCte != null, f.tempo !== "todos", f.oc != null, f.status !== "todos", f.comSugestao].filter(Boolean).length;
}

function PainelFiltros({
  filtros,
  onChange,
  ocs,
  cidades,
  tiposCte,
  direcao,
  onDirecao,
}: {
  filtros: FiltrosFila;
  onChange: (f: FiltrosFila) => void;
  ocs: { codigo: number; descricao: string | null }[];
  cidades: string[];
  /** Tipos de CT-e presentes na fila (Caio 08/10): NORMAL, DEVOLUCAO, REDESPACHO, REVERSA… */
  tiposCte: string[];
  direcao: "mais_parado" | "menos_parado";
  onDirecao: (d: "mais_parado" | "menos_parado") => void;
}) {
  const set = <K extends keyof FiltrosFila>(k: K, v: FiltrosFila[K]) => onChange({ ...filtros, [k]: v });
  const Rot = ({ children, htmlFor }: { children: React.ReactNode; htmlFor: string }) => (
    <label htmlFor={htmlFor} className="mb-1 block text-[12px] font-medium text-ink-soft-2">
      {children}
    </label>
  );
  return (
    <div className="space-y-3">
      <div>
        <Rot htmlFor="f-cidade">Cidade</Rot>
        <select id="f-cidade" aria-label="Filtrar por cidade" value={filtros.cidade ?? ""} onChange={(e) => set("cidade", e.target.value || null)} className={CAMPO}>
          <option value="">Todas as cidades</option>
          {cidades.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Rot htmlFor="f-tipo-cte">Tipo de CT-e</Rot>
        <select id="f-tipo-cte" aria-label="Filtrar por tipo de CT-e" value={filtros.tipoCte ?? ""} onChange={(e) => set("tipoCte", e.target.value || null)} className={CAMPO}>
          <option value="">Todos os tipos</option>
          {tiposCte.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Rot htmlFor="f-tempo">Parada há</Rot>
        <select id="f-tempo" aria-label="Filtrar por tempo parado" value={filtros.tempo} onChange={(e) => set("tempo", e.target.value as FiltroTempo)} className={CAMPO}>
          <option value="todos">Qualquer tempo</option>
          <option value="4h">4 h ou mais</option>
          <option value="24h">1 dia ou mais</option>
          <option value="72h">3 dias ou mais</option>
        </select>
      </div>
      <div>
        <Rot htmlFor="f-oc">Última ocorrência</Rot>
        <select
          id="f-oc"
          aria-label="Filtrar por ocorrência"
          value={filtros.oc ?? ""}
          onChange={(e) => set("oc", e.target.value === "" ? null : Number(e.target.value))}
          className={CAMPO}
        >
          <option value="">Todas</option>
          {ocs.map((o) => (
            <option key={o.codigo} value={o.codigo}>
              {o.descricao ? `${o.descricao.charAt(0)}${o.descricao.slice(1, 34).toLowerCase()} (${o.codigo})` : `Ocorrência ${o.codigo}`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Rot htmlFor="f-status">Andamento</Rot>
        <select id="f-status" aria-label="Filtrar por status do lançamento" value={filtros.status} onChange={(e) => set("status", e.target.value as FiltroStatus)} className={CAMPO}>
          <option value="todos">Qualquer andamento</option>
          {STATUS_OPCOES.map((s) => (
            <option key={s} value={s}>
              {ROTULO_STATUS_LANCAMENTO[s]}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        aria-pressed={filtros.comSugestao}
        onClick={() => set("comSugestao", !filtros.comSugestao)}
        className="flex w-full items-center justify-between rounded-[10px] border border-rule px-3 py-2 text-[13px] text-ink-2 hover:bg-[var(--bg-subtle)]"
      >
        Com sugestão
        <span className={cn("grid h-4 w-4 place-items-center rounded-[4px] border", filtros.comSugestao ? "border-ink bg-ink text-white" : "border-rule-strong")}>
          {filtros.comSugestao && <Check className="h-3 w-3" />}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDirecao(direcao === "mais_parado" ? "menos_parado" : "mais_parado")}
        className="flex w-full items-center gap-2 rounded-[10px] px-1 py-1 text-[13px] text-ink-soft-2 hover:text-ink-2"
      >
        <ArrowDownUp className="h-3.5 w-3.5" />
        {direcao === "mais_parado" ? "Mais parado primeiro" : "Menos parado primeiro"}
      </button>
      {filtrosAtivos(filtros) > 0 && (
        <button
          type="button"
          onClick={() => onChange({ ...FILTROS_PADRAO, busca: filtros.busca })}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-mute hover:text-ink-2"
        >
          <X className="h-3.5 w-3.5" /> Limpar filtros
        </button>
      )}
    </div>
  );
}

function SeletorFilial({
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
  const [aberto, setAberto] = useState(false);
  const [q, setQ] = useState("");
  const rotulo = escolha == null ? "Todas" : escolha === FILIAL_MINHAS ? "Minhas" : escolha || "Sem filial";
  const totalMinhas = minhas ? filiais.filter((f) => f.unidade && minhas.includes(f.unidade)).reduce((a, f) => a + f.total, 0) : 0;
  const lista = filiais.filter((f) => !q || (f.unidade ?? "sem filial").toLowerCase().includes(q.trim().toLowerCase()));
  const escolher = (f: EscolhaFilial) => {
    onEscolher(f);
    setAberto(false);
    setQ("");
  };
  const Item = ({ ativo, onClick, children, conta, testid }: { ativo: boolean; onClick: () => void; children: React.ReactNode; conta: number; testid: string }) => (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={ativo}
      onClick={onClick}
      className={cn("flex w-full items-center justify-between rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--bg-subtle)]", ativo && "bg-[var(--bg-subtle)] font-semibold")}
    >
      <span className="inline-flex items-center gap-2">
        <Check className={cn("h-3.5 w-3.5", ativo ? "opacity-100" : "opacity-0")} aria-hidden />
        {children}
      </span>
      <span className="tabular text-[12px] text-ink-mute">{n(conta)}</span>
    </button>
  );
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" className={BOTAO} aria-label={`Filial: ${rotulo}`} data-testid="filial-gatilho">
          <span className="text-ink-mute">Filial</span>
          <span className="font-semibold">{rotulo}</span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[248px] rounded-[12px] p-1.5">
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-mute" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar filial"
            aria-label="Buscar filial"
            className="h-8 w-full rounded-[8px] border border-rule bg-surface pl-8 pr-2 text-[16px] sm:text-[13px] focus-visible:border-ink focus-visible:outline-none"
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {!q && (
            <Item ativo={escolha == null} onClick={() => escolher(null)} conta={total} testid="filial-todas">
              Todas
            </Item>
          )}
          {!q && minhas && minhas.length > 0 && (
            <Item ativo={escolha === FILIAL_MINHAS} onClick={() => escolher(FILIAL_MINHAS)} conta={totalMinhas} testid="filial-minhas">
              {minhas.length <= 3 ? `Minhas (${minhas.join(", ")})` : `Minhas ${minhas.length} filiais`}
            </Item>
          )}
          {lista.map((f) => {
            const id = f.unidade ?? "";
            return (
              <Item key={id || "sem"} ativo={escolha === id} onClick={() => escolher(id)} conta={f.total} testid={`filial-${id || "sem"}`}>
                {f.unidade ?? "Sem filial"}
              </Item>
            );
          })}
          {lista.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-ink-mute">Nenhuma filial com esse nome.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Família do Caio (lib/operacao/familias.ts) como filtro rápido: textos exatos, contagem, "Todas" por padrão. */
function SeletorFamilia({
  familias,
  escolha,
  onEscolher,
}: {
  familias: { id: string; titulo: string; total: number }[];
  escolha: string | null;
  onEscolher: (f: string | null) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const total = familias.reduce((a, f) => a + f.total, 0);
  const rotulo = familias.find((f) => f.id === escolha)?.titulo ?? "Todas";
  const escolher = (f: string | null) => {
    onEscolher(f);
    setAberto(false);
  };
  const Item = ({ ativo, onClick, children, conta, testid }: { ativo: boolean; onClick: () => void; children: React.ReactNode; conta: number; testid: string }) => (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={ativo}
      onClick={onClick}
      className={cn("flex w-full items-center justify-between rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--bg-subtle)]", ativo && "bg-[var(--bg-subtle)] font-semibold", conta === 0 && !ativo && "opacity-50")}
    >
      <span className="inline-flex items-center gap-2">
        <Check className={cn("h-3.5 w-3.5", ativo ? "opacity-100" : "opacity-0")} aria-hidden />
        {children}
      </span>
      <span className="tabular text-[12px] text-ink-mute">{n(conta)}</span>
    </button>
  );
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" className={BOTAO} aria-label={`Família: ${rotulo}`} data-testid="familia-gatilho">
          <span className="text-ink-mute max-md:inline md:hidden min-[1700px]:inline">Família</span>
          <span className="max-w-[140px] truncate font-semibold">{rotulo === "Todas" ? <span className="max-md:inline md:hidden min-[1700px]:inline">Todas</span> : rotulo}{rotulo === "Todas" && <span className="hidden md:inline min-[1700px]:hidden">Família</span>}</span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] rounded-[12px] p-1.5">
        <Item ativo={escolha == null} onClick={() => escolher(null)} conta={total} testid="familia-todas">
          Todas
        </Item>
        {familias.map((f) => (
          <Item key={f.id} ativo={escolha === f.id} onClick={() => escolher(f.id)} conta={f.total} testid={`familia-${f.id}`}>
            {f.titulo}
          </Item>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function SeletorSetor({
  setores,
  total,
  escolha,
  meus,
  onEscolher,
}: {
  setores: { setor: string; total: number }[];
  total: number;
  escolha: string | null;
  meus: string[] | null;
  onEscolher: (s: string | null) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const rotulo = escolha == null ? "Todos" : escolha === SETOR_MEUS ? "Meus" : nomeDoSetor(escolha);
  const totalMeus = meus ? setores.filter((s) => meus.includes(s.setor)).reduce((a, s) => a + s.total, 0) : 0;
  const escolher = (s: string | null) => {
    onEscolher(s);
    setAberto(false);
  };
  const Item = ({ ativo, onClick, children, conta, testid }: { ativo: boolean; onClick: () => void; children: React.ReactNode; conta: number; testid: string }) => (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={ativo}
      onClick={onClick}
      className={cn("flex w-full items-center justify-between rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--bg-subtle)]", ativo && "bg-[var(--bg-subtle)] font-semibold")}
    >
      <span className="inline-flex items-center gap-2">
        <Check className={cn("h-3.5 w-3.5", ativo ? "opacity-100" : "opacity-0")} aria-hidden />
        {children}
      </span>
      <span className="tabular text-[12px] text-ink-mute">{n(conta)}</span>
    </button>
  );
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" className={BOTAO} aria-label={`Setor: ${rotulo}`} data-testid="setor-gatilho">
          <span className="text-ink-mute">Setor</span>
          <span className="font-semibold">{rotulo}</span>
          <ChevronDown className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[248px] rounded-[12px] p-1.5">
        <Item ativo={escolha == null} onClick={() => escolher(null)} conta={total} testid="setor-todos">
          Todos
        </Item>
        {meus && meus.length > 0 && (
          <Item ativo={escolha === SETOR_MEUS} onClick={() => escolher(SETOR_MEUS)} conta={totalMeus} testid="setor-meus">
            {meus.length <= 2 ? `Meus (${meus.map(nomeDoSetor).join(", ")})` : `Meus ${meus.length} setores`}
          </Item>
        )}
        {setores.map((s) => (
          <Item key={s.setor} ativo={escolha === s.setor} onClick={() => escolher(s.setor)} conta={s.total} testid={`setor-${s.setor}`}>
            {nomeDoSetor(s.setor)}
          </Item>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function BarraOperacao(p: {
  aba: AbaOperacao;
  onAba: (a: AbaOperacao) => void;
  /** Abas que esta pessoa vê, na ordem (Gestão só para supervisão/gerente/gestor). */
  abasVisiveis?: readonly AbaOperacao[];
  setores?: { setor: string; total: number }[];
  setor?: string | null;
  meusSetores?: string[] | null;
  onSetor?: (s: string | null) => void;
  contagens: Record<EtapaFluxoId, number>;
  etapaAtiva: EtapaFluxoId | null;
  onEtapa: (id: EtapaFluxoId) => void;
  /** "300 notas · lida às 02:54" (é o h1 da página, discreto). */
  titulo: React.ReactNode;
  filiais: { unidade: string | null; total: number }[];
  totalFiliais: number;
  filial: string | null;
  minhas: string[] | null;
  onFilial: (f: EscolhaFilial) => void;
  /** Famílias do Caio com contagem (filtro rápido ao lado da Filial). */
  familias?: { id: string; titulo: string; total: number }[];
  familia?: string | null;
  onFamilia?: (f: string | null) => void;
  filtros: FiltrosFila;
  onFiltros: (f: FiltrosFila) => void;
  ocs: { codigo: number; descricao: string | null }[];
  cidades: string[];
  tiposCte: string[];
  direcao: "mais_parado" | "menos_parado";
  onDirecao: (d: "mais_parado" | "menos_parado") => void;
  visao: VisaoOperacao;
  onVisao: (v: VisaoOperacao) => void;
  podeEspelho: boolean;
}) {
  const estreito = useEstreito();
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [menuAberto, setMenuAberto] = useState(false);
  const ativos = filtrosAtivos(p.filtros);
  const trabalho = p.aba === "trabalho";

  const painel = (
    <PainelFiltros filtros={p.filtros} onChange={p.onFiltros} ocs={p.ocs} cidades={p.cidades} tiposCte={p.tiposCte} direcao={p.direcao} onDirecao={p.onDirecao} />
  );

  const abas = (
    <div role="tablist" aria-label="Visões da Operação" className="inline-flex shrink-0 rounded-[10px] bg-[var(--bg-muted)] p-0.5">
      {(p.abasVisiveis ?? (["trabalho", "torre"] as const)).map((a) => (
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
          {ROTULO_ABA[a]}
        </button>
      ))}
    </div>
  );

  const etapas = (
    <nav aria-label="Etapas do fluxo" className="flex min-w-0 gap-0.5 overflow-x-auto">
      {ETAPAS_FLUXO.map((e) => {
        const v = p.contagens[e.id];
        const ativa = p.etapaAtiva === e.id;
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={ativa}
            data-testid={`faixa-${e.id}`}
            title={`${e.titulo}: ${e.dica}`}
            aria-label={`${e.titulo}: ${n(v)}`}
            onClick={() => p.onEtapa(e.id)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] transition-colors",
              ativa ? "bg-[var(--bg-muted)] text-ink-2" : "text-ink-soft-2 hover:bg-[var(--bg-subtle)] hover:text-ink-2",
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
    <div className={cn("relative shrink-0", estreito && !buscaAberta && !p.filtros.busca && "w-8")}>
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
            onChange={(e) => p.onFiltros({ ...p.filtros, busca: e.target.value })}
            onBlur={() => setBuscaAberta(false)}
            placeholder="Buscar NF, CTRC, cliente"
            aria-label="Buscar na fila"
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
        <PopoverContent align="end" className="w-[280px] rounded-[12px] p-3">
          {painel}
        </PopoverContent>
      </Popover>
    ));

  const VISOES: { id: VisaoOperacao; rotulo: string; icone: typeof List }[] = [
    { id: "fluxo", rotulo: "Fluxo da torre", icone: Columns3 },
    { id: "problema", rotulo: "Por família", icone: Columns3 },
    { id: "andamento", rotulo: "Por andamento", icone: Columns3 },
    { id: "lista", rotulo: "Lista", icone: List },
  ];
  const menu = (
    <Popover open={menuAberto} onOpenChange={setMenuAberto}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Mais opções" className={cn(BOTAO, "w-8 justify-center px-0")}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] rounded-[12px] p-1.5">
        {trabalho && (
          <>
            <div className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-mute">Ver as notas</div>
            {VISOES.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={p.visao === v.id}
                onClick={() => {
                  p.onVisao(v.id);
                  setMenuAberto(false);
                }}
                className={cn("flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--bg-subtle)]", p.visao === v.id && "font-semibold")}
              >
                <v.icone className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
                <span className="flex-1">{v.rotulo}</span>
                {p.visao === v.id && <Check className="h-3.5 w-3.5" aria-hidden />}
              </button>
            ))}
            <div className="my-1 border-t border-rule" />
          </>
        )}
        {p.podeEspelho && (
          <Link to="/operacao/espelho" className="flex w-full items-center rounded-[8px] px-2.5 py-1.5 text-[13px] hover:bg-[var(--bg-subtle)]" style={{ color: "var(--encaminhar)" }}>
            Espelho do Relacionamento
          </Link>
        )}
        <div className="mt-1 rounded-[8px] bg-[var(--bg-subtle)] px-2.5 py-2 text-[12px] text-ink-soft-2">
          <div className="mb-1 inline-flex items-center gap-1.5 font-semibold text-ink-2">
            <Keyboard className="h-3.5 w-3.5" aria-hidden /> Atalhos
          </div>
          <ul className="space-y-0.5">
            <li>
              <kbd className="rounded border border-rule bg-surface px-1">j</kbd> <kbd className="rounded border border-rule bg-surface px-1">k</kbd> próxima / anterior nota
            </li>
            <li>
              <kbd className="rounded border border-rule bg-surface px-1">Enter</kbd> abre a primeira · <kbd className="rounded border border-rule bg-surface px-1">Esc</kbd> fecha
            </li>
            <li>
              <kbd className="rounded border border-rule bg-surface px-1">c</kbd> confirma na prévia
            </li>
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );

  const filialUI = (
    <>
      <SeletorFilial filiais={p.filiais} total={p.totalFiliais} escolha={p.filial} minhas={p.minhas} onEscolher={p.onFilial} />
      {p.familias && p.onFamilia && <SeletorFamilia familias={p.familias} escolha={p.familia ?? null} onEscolher={p.onFamilia} />}
      {p.setores && p.onSetor && (
        <SeletorSetor setores={p.setores} total={p.setores.reduce((a, x) => a + x.total, 0)} escolha={p.setor ?? null} meus={p.meusSetores ?? null} onEscolher={p.onSetor} />
      )}
    </>
  );
  // As etapas do fluxo só fazem sentido onde há fila de trabalho (Trabalho e Torre).
  const mostraEtapas = p.aba === "trabalho" || p.aba === "torre";

  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-surface/95 backdrop-blur" aria-label="Barra da Operação">
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
          {/* Celular: Filial, Família e Setor juntos na segunda linha (rolam de lado); as etapas logo abaixo, sem sumir. */}
          <div className="mt-2 flex items-center gap-1.5 overflow-x-auto">{filialUI}</div>
          {mostraEtapas && <div className="mt-1.5 min-w-0">{etapas}</div>}
          <div className="mt-1 px-0.5">{p.titulo}</div>
        </div>
      ) : (
        <div className="flex h-14 items-center gap-3 px-4 md:px-6">
          {abas}
          <span className="h-5 w-px shrink-0 bg-rule" aria-hidden />
          <div className="min-w-0 flex-1">{mostraEtapas && etapas}</div>
          <div className="sr-only shrink-0 min-[1400px]:not-sr-only">{p.titulo}</div>
          {filialUI}
          {busca}
          {filtrosUI}
          {menu}
        </div>
      )}
    </header>
  );
}
