// =============================================================================
// Tela do Relacionamento no padrão da torre (docs/RELACIONAMENTO-TELA.md):
//  - Trabalho (principal): barra única + colunas na ordem do fluxo, cartões logo abaixo.
//  - Torre: o resumo do turno, regras (firme × dúvida), especialistas por tipo de caso,
//    conselheiro e registro do turno.
// Só apresentação: os dados e as regras de coluna vêm do Inbox (produção) ou da
// demonstração (dados fictícios). Abrir o card é do chamador (rota real ou painel da demo).
// =============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, ShieldCheck, Users } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { usePersistentState } from "@/hooks/usePersistentState";
import {
  ETAPAS_REL,
  ROTULO_CERTEZA,
  avisosRel,
  colunasNaOrdem,
  etapaDaColuna,
  ordemDosCards,
  registroRel,
  resumirRel,
  type AvisoRel,
  type CardInbox,
  type EtapaRelId,
} from "@/lib/relacionamento/torre";
import { KANBAN_COLUMNS, type KanbanColumnId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BarraRelacionamento, type FiltrosRel, type SettersRel } from "./BarraRelacionamento";

const n = (v: number) => v.toLocaleString("pt-BR");
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/** O que cada coluna diz em uma linha (as regras são as do KANBAN_COLUMNS). */
const DICA_COLUNA: Record<KanbanColumnId, string> = {
  validacao: "O agente propôs a ação. Abra, confira e aprove ou recuse.",
  cliente_respondeu: "O cliente respondeu. Valide a resposta e siga o caso.",
  veto_janela: "O robô vai agir sozinho na hora marcada. Olhe, edite ou cancele.",
  veto_executada: "O robô agiu na última hora. Segunda conferência.",
  para_fazer: "O agente ainda está lendo o caso.",
  cliente: "Notificamos o cliente; o card volta quando ele responder.",
  acao_executada: "Lançada no SSW, esperando o Bastão confirmar.",
  executada: "Ação confirmada.",
  tratativa: "Tratativa pendente.",
};

/** Recados de coluna vazia (os do Inbox, Caio). */
const VAZIO_COLUNA: Record<KanbanColumnId, string> = {
  validacao: "Sem decisões pendentes agora.",
  cliente_respondeu: "Nenhum cliente respondeu ainda. Quando algum cliente responder por e-mail, o card aparece aqui.",
  veto_janela: "Nenhuma ação autônoma programada. Quando o robô programar uma ação, ela aparece aqui com a contagem regressiva.",
  veto_executada: "Nenhuma ação autônoma executada na última hora.",
  para_fazer: "Tudo em dia. Hora de respirar.",
  cliente: "Sem aguardar resposta de cliente.",
  acao_executada: "Sem ações aguardando Bastão.",
  executada: "Nenhuma ação confirmada hoje ainda.",
  tratativa: "Sem tratativas pendentes.",
};

export interface DadosTelaRel {
  cards: CardInbox[];
  grupos: Map<KanbanColumnId, CardInbox[]>;
  mostrarTrilho: boolean;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
  truncado: boolean;
  limite: number;
  stats: { ativos: number; resolvidosHoje: number; aguardandoSsw: number; slaRisco: number };
  saudacao: string;
  paradoMais1dUtil: (c: CardInbox) => boolean;
}

export function TelaRelacionamento({
  dados,
  filtros,
  setters,
  clientes,
  ocsDisponiveis,
  labelOc,
  isGestor,
  extrasMenu,
  renderCard,
  onAbrirCard,
  selecionadoExterno,
  painelDetalhe,
  onOrdem,
  demo = false,
}: {
  dados: DadosTelaRel;
  filtros: FiltrosRel;
  setters: SettersRel;
  clientes: string[];
  ocsDisponiveis: number[];
  labelOc: (c: number) => string;
  isGestor: boolean;
  extrasMenu?: React.ReactNode;
  renderCard: (card: CardInbox, ctx: { selecionado: boolean }) => React.ReactNode;
  onAbrirCard: (id: string, ordem: string[]) => void;
  /** Card aberto num painel ao lado (demonstração). */
  selecionadoExterno?: string | null;
  painelDetalhe?: React.ReactNode;
  /** Avisa a ordem do fluxo (para o clique no cartão levar a fila junto). */
  onOrdem?: (ordem: string[]) => void;
  demo?: boolean;
}) {
  const [aba, setAba] = usePersistentState<"trabalho" | "torre">("relacionamento.aba.v1", "trabalho");
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [etapaDestaque, setEtapaDestaque] = useState<EtapaRelId | null>(null);
  const sel = selecionadoExterno ?? selecionado;

  const colunas = useMemo(() => colunasNaOrdem(dados.mostrarTrilho), [dados.mostrarTrilho]);
  const ordem = useMemo(() => ordemDosCards(dados.grupos, colunas), [dados.grupos, colunas]);
  const resumo = useMemo(() => resumirRel(dados.grupos), [dados.grupos]);
  useEffect(() => {
    onOrdem?.(ordem);
  }, [ordem, onOrdem]);
  const todos = useMemo(() => colunas.flatMap((c) => dados.grupos.get(c) ?? []), [colunas, dados.grupos]);
  const avisos = useMemo(() => avisosRel(todos, dados.paradoMais1dUtil), [todos, dados.paradoMais1dUtil]);
  const eventos = useMemo(() => registroRel(todos), [todos]);

  const irPara = (id: string | null) => {
    if (!id) return;
    setSelecionado(id);
    requestAnimationFrame(() => document.querySelector(`[data-card-id="${id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
  };
  const irParaEtapa = (id: EtapaRelId) => {
    setAba("trabalho");
    setEtapaDestaque(id);
    const etapa = ETAPAS_REL.find((e) => e.id === id)!;
    const col = etapa.colunas.find((c) => (dados.grupos.get(c)?.length ?? 0) > 0);
    if (col) requestAnimationFrame(() => document.querySelector(`[data-testid="coluna-rel-${col}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "start" }));
  };
  useEffect(() => {
    if (!etapaDestaque) return;
    const t = setTimeout(() => setEtapaDestaque(null), 1600);
    return () => clearTimeout(t);
  }, [etapaDestaque]);

  // Atalhos: j/k próximo/anterior, Enter abre, Esc solta. Nunca em campo nem com janela aberta.
  const atalhos = useRef({ ordem, sel, irPara, onAbrirCard, aba });
  atalhos.current = { ordem, sel, irPara, onAbrirCard, aba };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog']")) return;
      const a = atalhos.current;
      if (a.aba !== "trabalho" || a.ordem.length === 0) return;
      const i = a.sel ? a.ordem.indexOf(a.sel) : -1;
      if (e.key === "j") {
        e.preventDefault();
        a.irPara(a.ordem[Math.min(i + 1, a.ordem.length - 1)] ?? null);
      } else if (e.key === "k") {
        e.preventDefault();
        a.irPara(a.ordem[Math.max(i - 1, 0)] ?? null);
      } else if (e.key === "Enter" && a.sel && (alvo === document.body || !alvo)) {
        // Só abre o que foi escolhido com j/k: Enter acidental não abre card nenhum.
        e.preventDefault();
        a.onAbrirCard(a.sel, a.ordem);
      } else if (e.key === "Escape") {
        setSelecionado(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const titulo = (
    <h1 className="whitespace-nowrap text-[12.5px] font-normal text-ink-mute" data-testid="contagem-rel">
      <span className="tabular font-semibold text-ink-2">{n(dados.stats.ativos)}</span> {dados.stats.ativos === 1 ? "card ativo" : "cards ativos"}
      {dados.isFetching && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
    </h1>
  );

  // Colunas vazias somem (a barra mostra 0), MENOS as que dependem de você e o trilho do piloto:
  // essas ficam sempre, com o recado do Caio de quando estão vazias (revisão do conselheiro, 08/10).
  const SEMPRE: KanbanColumnId[] = ["validacao", "cliente_respondeu", "veto_janela", "veto_executada"];
  const colunasCheias = colunas.filter((c) => SEMPRE.includes(c) || (dados.grupos.get(c)?.length ?? 0) > 0);
  const trilho = colunasCheias.filter((c) => c === "veto_janela" || c === "veto_executada");

  const coluna = (id: KanbanColumnId) => {
    const def = KANBAN_COLUMNS.find((c) => c.id === id)!;
    const etapa = ETAPAS_REL.find((e) => e.id === etapaDaColuna(id))!;
    const cards = dados.grupos.get(id) ?? [];
    return (
      <section
        key={id}
        data-testid={`coluna-rel-${id}`}
        aria-label={def.title}
        className={cn(
          "flex min-h-0 w-[300px] shrink-0 scroll-ml-5 flex-col rounded-[16px] bg-[var(--bg-subtle)] p-2 transition-shadow duration-300",
          etapaDestaque === etapa.id && "shadow-[0_0_0_2px_hsl(var(--ink))]",
        )}
      >
        <header className="rounded-[12px] border border-rule bg-surface px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
              <span className="h-2 w-2 rounded-full" style={{ background: etapa.cor }} aria-hidden />
              {def.title}
            </h2>
            <span className="tabular text-[13px] font-semibold text-ink-2">{n(cards.length)}</span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-mute">{DICA_COLUNA[id]}</p>
        </header>
        <ul className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
          {cards.length === 0 && (
            <li className="rounded-[12px] border border-dashed border-rule px-3 py-4 text-center text-[12.5px] leading-snug text-ink-mute">{VAZIO_COLUNA[id]}</li>
          )}
          {cards.map((c) => (
            <li
              key={c.id}
              data-card-id={c.id}
              className={cn("rounded-[14px] transition-shadow", sel === c.id && "shadow-[0_0_0_2px_hsl(var(--ink))]")}
            >
              {renderCard(c, { selecionado: sel === c.id })}
            </li>
          ))}
        </ul>
      </section>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BarraRelacionamento
        aba={aba}
        onAba={setAba}
        contagens={resumo.porEtapa}
        mostrarTrilho={dados.mostrarTrilho}
        etapaAtiva={etapaDestaque}
        onEtapa={irParaEtapa}
        titulo={titulo}
        filtros={filtros}
        setters={setters}
        clientes={clientes}
        ocsDisponiveis={ocsDisponiveis}
        labelOc={labelOc}
        isGestor={isGestor}
        extrasMenu={extrasMenu}
        demo={demo}
      />

      {aba === "torre" ? (
        <div role="tabpanel" aria-label="Torre" className="min-h-0 flex-1 overflow-y-auto">
          <TorreRel dados={dados} resumo={resumo} avisos={avisos} eventos={eventos} onEtapa={irParaEtapa} />
        </div>
      ) : (
        <div role="tabpanel" aria-label="Trabalho" className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {dados.truncado && (
              <div className="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-2 text-[12.5px] md:px-6" style={{ background: "var(--signal-softer)", color: "var(--signal-strong)" }}>
                <AlertCircle className="h-4 w-4 shrink-0" />
                Mostrando os {n(dados.limite)} cards de atividade mais recente. Pode haver mais (os mais antigos): use os filtros para alcançá-los.
              </div>
            )}
            {dados.isError ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[14px] text-ink-soft-2" role="alert">
                <AlertCircle className="h-5 w-5 text-sal" />
                Não deu para carregar os cards.
                <button onClick={() => dados.refetch()} className="rounded-[9px] border border-rule px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-[var(--bg-subtle)]">
                  Tentar de novo
                </button>
              </div>
            ) : dados.isLoading ? (
              <div className="flex flex-1 gap-3 overflow-hidden p-4 md:px-6">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-full w-[300px] shrink-0 rounded-[16px]" />
                ))}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 pt-3 md:px-6">
                {colunasCheias.map((c) => {
                  // O trilho autônomo fica numa moldura própria, no lugar dele na ordem do fluxo.
                  if (c === "veto_executada" && trilho.includes("veto_janela")) return null;
                  if (c === "veto_janela" || c === "veto_executada")
                    return (
                      <div
                        key="trilho"
                        className="flex min-h-0 shrink-0 flex-col rounded-[18px] border p-1.5"
                        style={{ borderColor: "rgba(109,40,217,0.35)", background: "rgba(109,40,217,0.04)" }}
                        data-testid="trilho-autonomo"
                      >
                        <div className="px-2 pb-1.5 pt-0.5 text-[12px] font-semibold" style={{ color: "#6D28D9" }}>
                          ⏱ Trilho autônomo · card com contagem = o robô vai agir · olhe, edite ou cancele
                        </div>
                        <div className="flex min-h-0 flex-1 gap-3">{trilho.map(coluna)}</div>
                      </div>
                    );
                  return coluna(c);
                })}
              </div>
            )}
          </div>
          {painelDetalhe}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- Aba Torre

const COR_CERTEZA = { alta: "var(--positive)", media: "var(--warning)", baixa: "var(--signal)" } as const;

function TorreRel({
  dados,
  resumo,
  avisos,
  eventos,
  onEtapa,
}: {
  dados: DadosTelaRel;
  resumo: ReturnType<typeof resumirRel>;
  avisos: AvisoRel[];
  eventos: ReturnType<typeof registroRel>;
  onEtapa: (id: EtapaRelId) => void;
}) {
  const totalCerteza = resumo.certeza.alta + resumo.certeza.media + resumo.certeza.baixa;
  const firmes = resumo.porEtapa.robo;
  const duvidas = resumo.porEtapa.voce;
  return (
    <div>
      <section aria-label="Resumo do turno" className="px-4 pb-5 pt-5 md:px-6">
        <div className="text-[12.5px] text-ink-mute">Agente principal</div>
        <h2 className="mt-1 text-[20px] font-semibold leading-tight text-ink-2" style={{ letterSpacing: "-0.01em" }}>
          {dados.saudacao}
        </h2>
        <p className="mt-1 max-w-[70ch] text-[14px] leading-relaxed text-ink-soft-2">
          <strong className="font-semibold" style={{ color: "var(--signal-strong)" }}>
            {n(duvidas)} {duvidas === 1 ? "card precisa" : "cards precisam"} de você
          </strong>
          , {n(firmes)} com o robô para agir, {n(resumo.porEtapa.agente)} com o agente e {n(resumo.porEtapa.cliente)} aguardando cliente.
        </p>
        <dl className="mt-4 grid max-w-[720px] grid-cols-2 overflow-hidden rounded-[14px] border border-rule sm:grid-cols-4">
          {[
            ["Cards ativos", dados.stats.ativos],
            ["Resolvidos hoje", dados.stats.resolvidosHoje],
            ["Aguardando SSW", dados.stats.aguardandoSsw],
            ["SLA em risco", dados.stats.slaRisco],
          ].map(([r, v], i) => (
            <div key={r as string} className={cn("px-4 py-3", i > 0 && "border-l border-rule", i === 2 && "max-sm:border-l-0 max-sm:border-t", i === 3 && "max-sm:border-t")}>
              <dt className="text-[12px] text-ink-mute">{r}</dt>
              <dd className="tabular mt-0.5 text-[22px] font-semibold leading-none text-ink-2">{n(v as number)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid items-start gap-5 px-4 pb-5 md:px-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
          <section aria-labelledby="regras-rel" className="rounded-[16px] border border-rule bg-surface p-4">
            <div className="text-[12px] font-medium text-ink-mute">Camada de decisão</div>
            <h3 id="regras-rel" className="mt-1 text-[16px] font-semibold text-ink-2">
              Regras do Relacionamento
            </h3>
            <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft-2">
              Regra firme: o robô age sozinho se ninguém vetar. Na dúvida, o agente propõe e você valida.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <button type="button" onClick={() => onEtapa("robo")} className="rounded-[12px] border border-rule p-3 text-left hover:bg-[var(--bg-subtle)]">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "#6D28D9" }}>
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Firme
                </div>
                <div className="tabular mt-1 text-[24px] font-semibold leading-none text-ink-2">{n(firmes)}</div>
                <div className="mt-1 text-[11.5px] text-ink-soft-2">robô vai agir</div>
              </button>
              <button type="button" onClick={() => onEtapa("voce")} className="rounded-[12px] border border-rule p-3 text-left hover:bg-[var(--bg-subtle)]">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
                  <Users className="h-3.5 w-3.5" aria-hidden /> Dúvida
                </div>
                <div className="tabular mt-1 text-[24px] font-semibold leading-none text-ink-2">{n(duvidas)}</div>
                <div className="mt-1 text-[11.5px] text-ink-soft-2">você valida</div>
              </button>
            </div>
            {totalCerteza > 0 && (
              <div className="mt-4">
                <div className="text-[12px] font-semibold text-ink-2">Certeza das sugestões do agente</div>
                <ul className="mt-2 space-y-2">
                  {(["alta", "media", "baixa"] as const).map((k) => (
                    <li key={k} className="grid grid-cols-[96px_minmax(0,1fr)_36px] items-center gap-2 text-[12px]">
                      <span className="text-ink-soft-2">{ROTULO_CERTEZA[k].replace("certeza", "Certeza")}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-[var(--bg-muted)]" aria-hidden>
                        <span className="block h-full rounded-full" style={{ width: `${(resumo.certeza[k] / totalCerteza) * 100}%`, background: COR_CERTEZA[k] }} />
                      </span>
                      <span className="tabular text-right font-semibold text-ink-2">{n(resumo.certeza[k])}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-labelledby="esp-rel">
            <div className="text-[12px] font-medium text-ink-mute">Agentes especialistas</div>
            <h3 id="esp-rel" className="mt-1 text-[16px] font-semibold text-ink-2">
              Um agente por tipo de caso
            </h3>
            <ul className="mt-3 grid grid-cols-2 gap-2.5 2xl:grid-cols-3">
              {resumo.especialistas.map((e) => (
                <li key={e.titulo} className="rounded-[14px] border border-rule bg-surface p-3.5">
                  <div className="flex flex-col-reverse items-start gap-1.5 sm:flex-row sm:justify-between">
                    <span className="text-[13.5px] font-semibold text-ink-2">{e.titulo}</span>
                    <span
                      className="whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                      style={
                        e.status === "precisa_voce"
                          ? { background: "var(--signal-soft)", color: "var(--signal-strong)" }
                          : { background: "var(--positive-soft)", color: "var(--positive)" }
                      }
                    >
                      {e.status === "precisa_voce" ? "Aguardando você" : "Em dia"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-1.5">
                    <span className="tabular text-[22px] font-semibold leading-none text-ink-2">{n(e.total)}</span>
                    <span className="text-[12px] text-ink-mute">{e.total === 1 ? "card" : "cards"}</span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-snug text-ink-soft-2">
                    {e.comVoce > 0 ? `${n(e.comVoce)} com você` : "Nada esperando você"}
                    {e.robo > 0 ? ` · ${n(e.robo)} com o robô` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside aria-labelledby="cons-rel" className="rounded-[16px] border border-rule bg-surface p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-ink-2" aria-hidden />
            <h3 id="cons-rel" className="text-[15px] font-semibold text-ink-2">
              Conselheiro
            </h3>
          </div>
          <p className="mt-0.5 text-[12.5px] text-ink-soft-2">Sinais que pedem atenção antes de aprovar. Também aparecem no próprio card.</p>
          {avisos.length === 0 ? (
            <p className="mt-3 rounded-[10px] bg-[var(--bg-subtle)] px-3 py-2.5 text-[12.5px] text-ink-soft-2">Nada fora do normal agora.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {avisos.map((a) => {
                const Icone = a.tom === "info" ? Info : AlertTriangle;
                return (
                  <li
                    key={a.id}
                    className="rounded-[12px] border px-3 py-2.5"
                    style={
                      a.tom === "critico"
                        ? { background: "var(--signal-softer)", borderColor: "var(--signal-border)" }
                        : a.tom === "atencao"
                          ? { background: "var(--warning-soft)", borderColor: "rgba(201,138,27,0.35)" }
                          : { background: "var(--bg-subtle)", borderColor: "var(--c-border)" }
                    }
                  >
                    <div className="flex items-start gap-2">
                      <Icone className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: a.tom === "critico" ? "var(--signal-strong)" : a.tom === "atencao" ? "var(--warning)" : "var(--c-ink-soft)" }} aria-hidden />
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold leading-snug text-ink-2">{a.titulo}</div>
                        <p className="mt-0.5 text-[12px] leading-snug text-ink-soft-2">{a.detalhe}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>

      <section aria-labelledby="reg-rel" className="border-t border-rule bg-[var(--bg-subtle)] px-4 py-5 md:px-6">
        <div className="text-[12px] font-medium text-ink-mute">Registro do turno</div>
        <h3 id="reg-rel" className="mt-1 text-[15px] font-semibold text-ink-2">
          O que aconteceu
        </h3>
        {eventos.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-soft-2">Nada registrado ainda.</p>
        ) : (
          <ol className="mt-3 grid gap-x-8 gap-y-2 lg:grid-cols-2">
            {eventos.map((e) => (
              <li key={e.id} className="grid grid-cols-[44px_10px_minmax(0,1fr)] items-baseline gap-2 text-[12.5px]">
                <time className="tabular text-[12px] text-ink-mute" dateTime={e.em}>
                  {hhmm(e.em)}
                </time>
                <span className={cn("h-1.5 w-1.5 rounded-full", e.tipo === "cliente" ? "bg-ink" : e.tipo === "robo" ? "bg-violet-600" : "bg-sal")} aria-hidden />
                <span className="leading-snug text-ink-soft-2">
                  <strong className="font-semibold text-ink-2">{e.quem}</strong> {e.texto}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
