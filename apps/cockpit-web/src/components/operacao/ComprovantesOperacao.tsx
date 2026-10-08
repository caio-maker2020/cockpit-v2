// =============================================================================
// Comprovantes de entrega — quem cuida dos canhotos resolve a fila em 1–2 cliques.
//
// Uma lista de trabalho só, por base, da mais urgente para a menos
// (Vencida → Crítica → Atrasada → Em dia). Cada base tem UMA ação: "Cobrar" (baixa o
// CSV da base no navegador; vira "Cobrada HH:MM" só na memória da tela). Sem lote. Item REAL da fila (oc 12, comprovante retido) tem
// "Abrir na fila": lançar no SSW só pela prévia + confirmar de lá, nunca daqui, nada
// em lote. Placas, clientes e variação do mês ficam recolhidos.
//
// SÓ LEITURA, como no Pendências (ComprovantesEntrega.tsx:1178-1184).
// Fonte: a definir. Hoje: as notas da fila com oc 12 + (opcional) itens de
// demonstração passados em `comprovantes` (o componente não importa demo/: ver
// demoIsolamento.test.ts).
// =============================================================================
import { useMemo, useState } from "react";
import { Check, ChevronDown, Download, FolderOpen } from "lucide-react";

import {
  FAIXAS_IDADE,
  comprovantesDaFila,
  csvCobranca,
  excluidoDaLista,
  faixaIdade,
  idadeDias,
  kpis,
  porCliente,
  rankingPlacas,
  resumoPorBase,
  situacaoPorBase,
  type ComprovantePendente,
  type FaixaIdade,
} from "@/lib/operacao/comprovantes";
import { setorDoItem } from "@/lib/operacao/setores";
import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { cn } from "@/lib/utils";
import { baixarTexto, brl, hojeIso, n } from "@/lib/operacao/formatoTela";
import { EstadoOperacao } from "./EstadoOperacao";
import { AvisosConselheiro, BotaoSecundario, FaixaTorre, Recolhivel, Rotulo, type AvisoCurto } from "./PecasTorre";

const LIMITE_DETALHE = 500;

const COR_FAIXA: Record<FaixaIdade, { cor: string; bg: string }> = {
  vencida: { cor: "var(--signal-strong)", bg: "var(--signal-softer)" },
  critica: { cor: "var(--signal)", bg: "var(--signal-softer)" },
  atrasada: { cor: "var(--warning)", bg: "var(--warning-soft)" },
  em_dia: { cor: "var(--c-ink-soft)", bg: "var(--bg-subtle)" },
};
const ROTULO_FAIXA = Object.fromEntries(FAIXAS_IDADE.map((f) => [f.id, f.rotulo])) as Record<FaixaIdade, string>;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const plural = (v: number, um: string, varios: string) => `${n(v)} ${v === 1 ? um : varios}`;

export interface ComprovantesOperacaoProps {
  linhas: OpFilaLinha[];
  agoraMs: number;
  onAbrirNota: (id: string) => void;
  demo: boolean;
  /** Setor do membro; comprovante é da Operação (oc 12). null = todos. */
  setor: string | null;
  /** Comprovantes de outra fonte (hoje: os fictícios da demonstração, injetados por quem monta a tela). */
  comprovantes?: ComprovantePendente[];
}

function ChipFaixa({ f }: { f: FaixaIdade | null }) {
  if (!f) return <span className="text-[11px] text-ink-mute">sem data</span>;
  return (
    <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: COR_FAIXA[f].cor, background: COR_FAIXA[f].bg }}>
      {ROTULO_FAIXA[f]}
    </span>
  );
}

export function ComprovantesOperacao({ linhas, agoraMs, onAbrirNota, demo, setor, comprovantes }: ComprovantesOperacaoProps) {
  const [filtro, setFiltro] = useState<FaixaIdade | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  /** Bases já cobradas NESTA abertura da tela (só memória do componente; nada é gravado). */
  const [cobradas, setCobradas] = useState<Record<string, string>>({});

  const todos = useMemo(() => {
    const daFila = comprovantesDaFila(setor ? linhas.filter((l) => setorDoItem(l) === setor) : linhas);
    return [...daFila, ...(comprovantes ?? [])].filter((c) => !excluidoDaLista(c));
  }, [linhas, setor, comprovantes]);

  const k = useMemo(() => kpis(todos, agoraMs), [todos, agoraMs]);
  const visiveis = useMemo(() => (filtro ? todos.filter((c) => faixaIdade(idadeDias(c.data_entrega, agoraMs)) === filtro) : todos), [todos, filtro, agoraMs]);
  const bases = useMemo(() => resumoPorBase(visiveis, agoraMs), [visiveis, agoraMs]);
  const placas = useMemo(() => rankingPlacas(todos, agoraMs), [todos, agoraMs]);
  const clientes = useMemo(() => porCliente(todos, agoraMs), [todos, agoraMs]);
  const situacao = useMemo(() => situacaoPorBase(todos, agoraMs), [todos, agoraMs]);

  const notaFonte = (
    <p className="text-[12px] leading-snug text-ink-mute" style={{ textWrap: "pretty" }}>
      {comprovantes?.length
        ? "Demonstração: dados fictícios + notas reais com comprovante retido (oc 12). Nada é enviado."
        : "Notas reais com comprovante retido (oc 12). Nada é enviado."}
    </p>
  );

  if (todos.length === 0) {
    return (
      <div className="px-4 py-6 md:px-6">
        <EstadoOperacao tipo="vazio" titulo="Nenhum comprovante pendente" texto="Nenhuma nota da fila com comprovante retido (ocorrência 12) agora." compacto />
        <div className="mx-auto max-w-md text-center">{notaFonte}</div>
      </div>
    );
  }

  const piorando = situacao.filter((s) => s.situacao === "piorando");
  const placasVencidas = placas.filter((p) => p.vencidas >= 3);
  const avisos: AvisoCurto[] = [];
  if (k.porFaixa.vencida > 0) {
    const b = resumoPorBase(todos, agoraMs).find((x) => x.porFaixa.vencida > 0)!;
    avisos.push({
      id: "vencidas",
      tom: "critico",
      titulo: `${plural(k.porFaixa.vencida, "comprovante vencido", "comprovantes vencidos")} (16+ dias)`,
      detalhe: `${b.unidade} tem ${plural(b.porFaixa.vencida, "vencido", "vencidos")}. Escalone com a base.`,
      acao: { rotulo: `Cobrar ${b.unidade}`, onClick: () => baixarBase(b.unidade) },
    });
  }
  if (piorando.length > 0) {
    avisos.push({
      id: "piorando",
      tom: "atencao",
      titulo: `${plural(piorando.length, "base piorando", "bases piorando")} desde o mês passado`,
      detalhe: `${piorando
        .slice(0, 4)
        .map((s) => `${s.unidade} (${s.rotulo})`)
        .join(", ")}. Valor de mercadoria sem comprovante subiu.`,
    });
  }
  if (placasVencidas.length > 0) {
    avisos.push({
      id: "placas",
      tom: "atencao",
      titulo: `${plural(placasVencidas.length, "placa", "placas")} com 3+ comprovantes vencidos`,
      detalhe: `${placasVencidas
        .slice(0, 4)
        .map((p) => `${p.placa} (${p.baseTop})`)
        .join(", ")}. Cobre o motorista antes da próxima viagem.`,
    });
  }

  function baixarBase(unidade: string) {
    setCobradas((c) => ({ ...c, [unidade]: hhmm(Date.now()) }));
    baixarTexto(`cobranca-comprovantes-${unidade.toLowerCase().replace(/\s+/g, "-")}-${hojeIso(agoraMs)}.csv`, csvCobranca(todos, agoraMs, unidade));
  }

  let restante = LIMITE_DETALHE;

  return (
    <div className="flex flex-col gap-5 px-4 pb-8 pt-5 md:px-6">
      <section aria-labelledby="comprovantes-titulo">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-mute">
          <span className="h-2 w-2 rounded-full bg-sal" aria-hidden />
          Comprovantes de entrega · só leitura
          {demo && <span style={{ color: "var(--signal-strong)" }}>· demonstração</span>}
        </div>
        <h2 id="comprovantes-titulo" className="mt-2 text-[20px] font-semibold leading-tight text-ink-2" style={{ letterSpacing: "-0.01em", textWrap: "balance" }}>
          Canhotos que ainda não voltaram
        </h2>
        <div className="mt-1">{notaFonte}</div>
        <div className="mt-3">
          <FaixaTorre
            rotulo="Como a torre lê os comprovantes"
            etapas={[
              { titulo: "O agente leu", valor: n(k.pendencias), nota: "pendentes" },
              { titulo: "Regras firmes", valor: n(k.porFaixa.vencida + k.porFaixa.critica), nota: "vencidos ou críticos" },
              { titulo: "Especialistas", valor: n(resumoPorBase(todos, agoraMs).length), nota: "bases" },
              { titulo: "Conselheiro", valor: n(avisos.length), nota: avisos.length === 1 ? "aviso" : "avisos" },
              { titulo: "Você confirma", valor: n(resumoPorBase(todos, agoraMs).filter((b) => b.pior === "vencida" || b.pior === "critica").length), nota: "cobranças" },
            ]}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="lista-comprovantes" className="min-w-0 rounded-[16px] border border-rule bg-surface p-4">
          <Rotulo>Lista de trabalho por base</Rotulo>
          <h3 id="lista-comprovantes" className="mt-1 text-[17px] font-semibold text-ink-2">
            Do mais urgente para o menos
          </h3>
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por faixa">
            {[null, ...FAIXAS_IDADE.map((f) => f.id)].map((f) => {
              const ativo = filtro === f;
              const qtd = f ? k.porFaixa[f] : k.pendencias;
              return (
                <button
                  key={f ?? "todas"}
                  type="button"
                  aria-pressed={ativo}
                  onClick={() => setFiltro(f)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
                    ativo ? "border-ink bg-ink text-white" : "border-rule text-ink-soft-2 hover:bg-[var(--bg-subtle)]",
                  )}
                >
                  {f ? ROTULO_FAIXA[f] : "Todas"} <span className="tabular opacity-80">{n(qtd)}</span>
                </button>
              );
            })}
          </div>

          <ul className="mt-3 divide-y divide-[hsl(var(--rule))]">
            {bases.map((b) => {
              const expandida = aberta === b.unidade;
              const itens = b.itens.slice(0, Math.max(0, restante));
              if (expandida) restante -= itens.length;
              return (
                <li key={b.unidade} className="py-3 first:pt-0">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <button
                      type="button"
                      aria-expanded={expandida}
                      onClick={() => setAberta(expandida ? null : b.unidade)}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-ink-mute transition-transform duration-150", !expandida && "-rotate-90")} aria-hidden />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[14px] font-semibold text-ink-2">{b.unidade}</span>
                          {b.base && <span className="text-[12px] text-ink-mute">{b.base.toLowerCase()}</span>}
                          {b.tipo && <span className="text-[11px] text-ink-mute">· {b.tipo}</span>}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-soft-2">
                          {plural(b.qtd, "pendente", "pendentes")}
                          {b.pior && b.pior !== "em_dia" && (
                            <>
                              {" · "}
                              <strong className="font-semibold" style={{ color: COR_FAIXA[b.pior].cor }}>
                                {b.porFaixa[b.pior] === b.qtd && b.qtd > 1 ? "todas " : `${n(b.porFaixa[b.pior])} `}
                                {ROTULO_FAIXA[b.pior].toLowerCase()}
                                {b.porFaixa[b.pior] === 1 ? "" : "s"}
                              </strong>
                            </>
                          )}
                          {b.topPlacas.length > 0 && <> · placas {b.topPlacas.map((p) => `${p.placa} (${p.qtd})`).join(", ")}</>}
                        </span>
                      </span>
                    </button>
                    {cobradas[b.unidade] ? (
                      <BotaoSecundario onClick={() => baixarBase(b.unidade)} rotulo={`Base ${b.unidade} cobrada às ${cobradas[b.unidade]}. Baixar de novo`}>
                        <Check className="h-3.5 w-3.5" style={{ color: "var(--positive)" }} aria-hidden /> Cobrada {cobradas[b.unidade]}
                      </BotaoSecundario>
                    ) : (
                      <BotaoSecundario onClick={() => baixarBase(b.unidade)} rotulo={`Cobrar a base ${b.unidade} (baixa o CSV)`}>
                        <Download className="h-3.5 w-3.5" aria-hidden /> Cobrar
                      </BotaoSecundario>
                    )}
                  </div>
                  {expandida && (
                    <ul className="mt-2 space-y-1 pl-6">
                      {itens.map((c) => {
                        const d = idadeDias(c.data_entrega, agoraMs);
                        return (
                          <li key={`${c.origem}-${c.ctrc}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] px-2 py-1.5 text-[12.5px] hover:bg-[var(--bg-subtle)]">
                            <span className="min-w-0 flex-1">
                              <strong className="font-semibold text-ink-2">{c.nf ? `NF ${c.nf}` : c.ctrc}</strong>
                              <span className="text-ink-soft-2">
                                {" "}
                                · {c.cliente_pagador?.toLowerCase() ?? "sem cliente"}
                                {c.placa ? ` · ${c.placa}` : ""}
                              </span>
                              {d != null && (
                                <span className="tabular" style={{ color: faixaIdade(d) === "em_dia" ? "var(--c-ink-soft)" : COR_FAIXA[faixaIdade(d)!].cor }}>
                                  {" "}
                                  · {plural(d, "dia", "dias")} desde a entrega
                                </span>
                              )}
                            </span>
                            {c.origem === "fila" && c.op_item_id && (
                              <BotaoSecundario onClick={() => onAbrirNota(c.op_item_id!)} rotulo={`Abrir NF ${c.nf ?? c.ctrc} na fila`}>
                                <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Abrir na fila
                              </BotaoSecundario>
                            )}
                          </li>
                        );
                      })}
                      {b.itens.length > itens.length && (
                        <li className="px-2 text-[12px] text-ink-mute">
                          Mostrando {n(itens.length)} de {n(b.itens.length)}. A cobrança da base traz todos.
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <div className="flex flex-col gap-3">
          <AvisosConselheiro
            avisos={avisos}
            rodape={
              <>
                Pendente: frete <span className="tabular font-semibold text-ink-2">{brl(k.frete)}</span> · mercadoria{" "}
                <span className="tabular font-semibold text-ink-2">{brl(k.mercadoria)}</span>
              </>
            }
          />
        </div>
      </div>

      <section aria-label="Detalhes" className="rounded-[16px] border border-rule bg-surface px-4">
        <Recolhivel titulo="Placas com mais pendências" resumo={placas.length ? `${n(placas.length)} placas` : "nenhuma placa informada"}>
          <ul className="space-y-1 text-[12.5px]">
            {placas.slice(0, 20).map((p) => (
              <li key={p.placa} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <span className="truncate">
                  <strong className="tabular font-semibold text-ink-2">{p.placa}</strong>
                  <span className="text-ink-mute">
                    {" "}
                    · {p.baseTop}
                    {p.outrasBases ? ` +${p.outrasBases}` : ""}
                  </span>
                </span>
                <span className="tabular text-ink-soft-2">
                  {n(p.qtd)}
                  {p.vencidas ? <span style={{ color: "var(--signal-strong)" }}> · {n(p.vencidas)} vencidos</span> : null} · {brl(p.frete)}
                </span>
              </li>
            ))}
          </ul>
        </Recolhivel>
        <Recolhivel titulo="Por cliente pagador" resumo={`${n(clientes.length)} clientes`}>
          <ul className="space-y-1 text-[12.5px]">
            {clientes.slice(0, 20).map((c) => (
              <li key={c.cliente} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <span className="truncate text-ink-2">{c.cliente.toLowerCase()}</span>
                <span className="tabular text-ink-soft-2">
                  {n(c.qtd)} · {c.idadeMedia == null ? "—" : `${c.idadeMedia.toLocaleString("pt-BR")} d`} · {brl(c.mercadoria)}
                </span>
              </li>
            ))}
          </ul>
        </Recolhivel>
        <Recolhivel titulo="Bases desde o mês passado" resumo={piorando.length ? `${n(piorando.length)} piorando` : "nenhuma piorando"}>
          <ul className="space-y-1 text-[12.5px]">
            {situacao.map((s) => (
              <li key={s.unidade} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <span className="truncate font-semibold text-ink-2">{s.unidade}</span>
                <span
                  className="tabular font-semibold"
                  style={{ color: s.situacao === "piorando" ? "var(--signal-strong)" : s.situacao === "melhorando" ? "var(--positive)" : "var(--c-ink-soft)" }}
                >
                  {s.situacao === "piorando" ? "Piorando" : s.situacao === "melhorando" ? "Melhorando" : "Estável"} {s.rotulo !== "0%" ? s.rotulo : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11.5px] leading-snug text-ink-mute">Valor de mercadoria sem comprovante acumulado até o fim do mês passado × até hoje. Variação menor que 2% é estável.</p>
        </Recolhivel>
        <Recolhivel titulo="Como as faixas funcionam" resumo="dias desde a entrega">
          <ul className="space-y-1 text-[12.5px] leading-snug text-ink-soft-2">
            {[...FAIXAS_IDADE].reverse().map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-2">
                <ChipFaixa f={f.id} />
                <span className="tabular">{f.ate == null ? `${f.de}+ dias` : `${f.de === 0 ? 1 : f.de} a ${f.ate} dias`}</span>
                <span className="text-ink-mute">{f.significado}</span>
              </li>
            ))}
            <li className="pt-1 text-ink-mute">Entregue hoje conta como em dia. Comprovante com ocorrência de ressarcimento sai da lista: deixou de ser da base.</li>
          </ul>
        </Recolhivel>
      </section>
    </div>
  );
}
