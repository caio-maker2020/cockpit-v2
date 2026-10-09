// =============================================================================
// Comprovantes de entrega — entregas feitas cujo canhoto ainda não foi escaneado.
//
// Fonte REAL (ADR 0042 D6): a edge `comprovantes-operacao`, que lê as views do Pendências
// já filtradas pelas unidades de quem está logado. Sem credencial ou com erro, a tela
// diz isso: não há dado fictício no modo real (só o adaptador de demonstração tem).
//
// Uma barra compacta (pendentes, % de pendência, frete, mercadoria, mediana de idade),
// os cartões por base do pior para o melhor e, em cada um, UMA ação principal: "Cobrar
// base" → confirmação → copia um texto pronto e baixa o CSV da base. Dentro da base, as
// notas agrupadas por placa. Nota que também está na fila com oc 12 tem "Abrir na fila"
// (lançar no SSW só pela prévia de lá, nunca daqui). Nada é enviado: sem WhatsApp, sem SSW.
// =============================================================================
import { useMemo, useState } from "react";
import { Check, ChevronDown, ClipboardCopy, Download, FolderOpen, Loader2, RefreshCw } from "lucide-react";

import {
  FAIXAS_IDADE,
  csvCobranca,
  dataBr,
  excluidoDaLista,
  faixaIdade,
  idadeDe,
  kpis,
  ligarComFila,
  resumoPorBase,
  textoCobranca,
  type FaixaIdade,
  type OpRespostaComprovantes,
  type ResumoBaseComprovante,
} from "@/lib/operacao/comprovantes";
import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { cn } from "@/lib/utils";
import { baixarTexto, brl, hojeIso, n } from "@/lib/operacao/formatoTela";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EstadoOperacao } from "./EstadoOperacao";
import { BotaoPrincipal, BotaoSecundario, LinhaMetricas, Recolhivel, type Metrica } from "./PecasTorre";

const LIMITE_ITENS_BASE = 200;

const COR_NIVEL = [
  { cor: "var(--c-ink-soft)", bg: "var(--bg-subtle)" },
  { cor: "var(--warning)", bg: "var(--warning-soft)" },
  { cor: "var(--signal)", bg: "var(--signal-softer)" },
  { cor: "var(--signal-strong)", bg: "var(--signal-softer)" },
] as const;
const FAIXA = Object.fromEntries(FAIXAS_IDADE.map((f) => [f.id, f])) as Record<FaixaIdade, (typeof FAIXAS_IDADE)[number]>;
const corDaFaixa = (f: FaixaIdade | null) => COR_NIVEL[f ? FAIXA[f].nivel : 0];
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const plural = (v: number, um: string, varios: string) => `${n(v)} ${v === 1 ? um : varios}`;
const nomeArquivo = (unidade: string, agoraMs: number) => `cobranca-comprovantes-${unidade.toLowerCase().replace(/\s+/g, "-")}-${hojeIso(agoraMs)}.csv`;

export interface ComprovantesOperacaoProps {
  /** A fila (já filtrada pela filial da barra): liga as notas com oc 12 ("Abrir na fila"). */
  linhas: OpFilaLinha[];
  agoraMs: number;
  onAbrirNota: (id: string) => void;
  demo: boolean;
  /** Resposta da OpApi.comprovantes(); undefined = ainda carregando. */
  resposta: OpRespostaComprovantes | undefined;
  carregando?: boolean;
  onTentarDeNovo?: () => void;
  /** Sigla escolhida na barra (null = todas as que a pessoa pode ver). */
  filial?: string | null;
}

function ChipFaixa({ f, qtd }: { f: FaixaIdade; qtd?: number }) {
  const c = corDaFaixa(f);
  return (
    <span className="tabular whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color: c.cor, background: c.bg }}>
      {qtd != null ? `${n(qtd)} · ` : ""}
      {FAIXA[f].rotulo}
    </span>
  );
}

function ErroComprovantes({ erro, motivo, onTentarDeNovo }: { erro: string; motivo?: string; onTentarDeNovo?: () => void }) {
  const [titulo, texto] =
    erro === "comprovantes_sem_credencial"
      ? ["Comprovantes sem credencial", "A leitura da fonte dos comprovantes ainda não foi configurada no servidor. Nenhum dado é mostrado até isso ser feito."]
      : erro === "sem_acesso"
        ? ["Sem acesso aos comprovantes", "Seu login não está cadastrado na Operação. Fale com a supervisão."]
        : erro === "tela_desligada"
          ? ["Tela da Operação desligada", "Os comprovantes aparecem quando a tela da Operação for ligada para os membros."]
          : ["Não deu para ler os comprovantes", motivo ? `A fonte respondeu: ${motivo}` : "A fonte dos comprovantes não respondeu agora."];
  const repetir = erro !== "comprovantes_sem_credencial" && erro !== "sem_acesso" && erro !== "tela_desligada";
  return (
    <EstadoOperacao tipo="erro" titulo={titulo} texto={texto} compacto>
      {repetir && onTentarDeNovo && (
        <BotaoSecundario onClick={onTentarDeNovo} rotulo="Tentar ler os comprovantes de novo">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Tentar de novo
        </BotaoSecundario>
      )}
    </EstadoOperacao>
  );
}

function DialogoCobranca({
  base,
  texto,
  onConfirmar,
  onFechar,
  copiado,
}: {
  base: ResumoBaseComprovante | null;
  texto: string;
  onConfirmar: () => void;
  onFechar: () => void;
  copiado: "nao" | "sim" | "falhou";
}) {
  return (
    <Dialog open={!!base} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent className="max-w-[620px] rounded-[16px]">
        <DialogHeader>
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-mute">Você confirma</div>
          <DialogTitle className="text-[19px]">Cobrar a base {base?.unidade}</DialogTitle>
          <DialogDescription>
            Copia o texto abaixo para você colar onde costuma cobrar a base e baixa o CSV com {base ? plural(base.qtd, "nota", "notas") : ""}. Nada é enviado daqui.
          </DialogDescription>
        </DialogHeader>
        <pre
          data-testid="texto-cobranca"
          className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded-[12px] border border-rule bg-[var(--bg-subtle)] px-4 py-3 text-[12.5px] leading-relaxed text-ink-2"
        >
          {texto}
        </pre>
        {copiado === "falhou" && (
          <p role="alert" className="text-[12.5px] font-medium" style={{ color: "var(--warning)" }}>
            O navegador não deixou copiar. Selecione o texto acima e copie à mão; o CSV foi baixado.
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onFechar}>
            Voltar
          </Button>
          <Button onClick={onConfirmar} className="bg-sal text-white hover:bg-sal/90">
            <ClipboardCopy className="mr-2 h-4 w-4" aria-hidden /> Copiar texto e baixar CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComprovantesOperacao({ linhas, agoraMs, onAbrirNota, demo, resposta, carregando, onTentarDeNovo, filial }: ComprovantesOperacaoProps) {
  const [filtro, setFiltro] = useState<FaixaIdade | null>(null);
  const [abertas, setAbertas] = useState<Record<string, boolean>>({});
  /** Bases cobradas NESTA abertura da tela (só memória; nada é gravado). */
  const [cobradas, setCobradas] = useState<Record<string, string>>({});
  const [cobrando, setCobrando] = useState<ResumoBaseComprovante | null>(null);
  const [copiado, setCopiado] = useState<"nao" | "sim" | "falhou">("nao");

  const ok = resposta?.ok === true ? resposta : null;
  const todos = useMemo(() => {
    if (!ok) return [];
    const daFilial = filial ? ok.linhas.filter((c) => c.unidade === filial) : ok.linhas;
    return ligarComFila(daFilial.filter((c) => !excluidoDaLista(c)), linhas);
  }, [ok, filial, linhas]);
  // Entregues só valem para o % quando a lista não foi recortada por filial na tela.
  const k = useMemo(() => kpis(todos, agoraMs, ok && !filial ? ok.entregues : null), [todos, agoraMs, ok, filial]);
  const visiveis = useMemo(() => (filtro ? todos.filter((c) => faixaIdade(idadeDe(c, agoraMs)) === filtro) : todos), [todos, filtro, agoraMs]);
  const bases = useMemo(() => resumoPorBase(visiveis, agoraMs), [visiveis, agoraMs]);
  const texto = useMemo(() => (cobrando ? textoCobranca(cobrando, agoraMs) : ""), [cobrando, agoraMs]);

  if (!resposta) {
    return <EstadoOperacao tipo="carregando" titulo="Lendo os comprovantes" texto="Buscando as entregas sem comprovante escaneado." compacto />;
  }
  if (resposta.ok === false) {
    return (
      <div className="px-4 py-6 md:px-6">
        <ErroComprovantes erro={resposta.erro} motivo={resposta.motivo} onTentarDeNovo={onTentarDeNovo} />
      </div>
    );
  }

  if (todos.length === 0) {
    const semUnidade = !resposta.escopo.todas && resposta.escopo.unidades.length === 0;
    return (
      <div className="px-4 py-6 md:px-6">
        <EstadoOperacao
          tipo="vazio"
          titulo={semUnidade ? "Seu cadastro não tem unidade" : "Nenhum comprovante pendente"}
          texto={
            semUnidade
              ? "Os comprovantes aparecem por unidade. Peça à supervisão para incluir as suas unidades no cadastro da Operação."
              : filial
                ? `Nenhuma entrega de ${filial} está sem comprovante escaneado.`
                : "Todas as entregas das suas unidades estão com o comprovante escaneado."
          }
          compacto
        />
      </div>
    );
  }

  function cobrar(b: ResumoBaseComprovante) {
    setCopiado("nao");
    setCobrando(b);
  }

  async function confirmarCobranca() {
    const b = cobrando;
    if (!b) return;
    baixarTexto(nomeArquivo(b.unidade, agoraMs), csvCobranca(todos, agoraMs, b.unidade));
    setCobradas((c) => ({ ...c, [b.unidade]: hhmm(Date.now()) }));
    try {
      if (!navigator.clipboard?.writeText) throw new Error("sem clipboard");
      await navigator.clipboard.writeText(textoCobranca(b, agoraMs));
      setCopiado("sim");
      setCobrando(null);
    } catch {
      setCopiado("falhou"); // a janela fica aberta com o texto para copiar à mão
    }
  }

  function exportarTudo() {
    baixarTexto(nomeArquivo(filial ?? "todas-as-bases", agoraMs), csvCobranca(todos, agoraMs));
  }

  const metricas: Metrica[] = [
    { rotulo: "Pendentes", valor: n(k.pendentes), tom: k.porFaixa["151+"] > 0 ? "critico" : undefined },
    { rotulo: "% de pendência", valor: k.percentual == null ? "—" : `${k.percentual.toLocaleString("pt-BR")}%` },
    { rotulo: "Frete", valor: brl(k.frete) },
    { rotulo: "Mercadoria", valor: brl(k.mercadoria) },
    { rotulo: "Mediana de idade", valor: k.medianaIdade == null ? "—" : `${k.medianaIdade.toLocaleString("pt-BR")} dias` },
  ];

  let restante = LIMITE_ITENS_BASE;

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-5 md:px-6">
      <section aria-labelledby="comprovantes-titulo" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-mute">
              <span className="h-2 w-2 rounded-full bg-sal" aria-hidden />
              Comprovantes de entrega · só leitura
              {resposta.ultimaAtualizacao && <span>· último escaneamento {dataBr(resposta.ultimaAtualizacao)}</span>}
              {demo && <span style={{ color: "var(--signal-strong)" }}>· demonstração (dados fictícios)</span>}
              {carregando && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-label="Atualizando" />}
            </div>
            <h2 id="comprovantes-titulo" className="mt-1.5 text-[20px] font-semibold leading-tight text-ink-2" style={{ letterSpacing: "-0.01em", textWrap: "balance" }}>
              Canhotos que ainda não voltaram
            </h2>
          </div>
          <BotaoSecundario onClick={exportarTudo} rotulo="Exportar tudo (CSV)">
            <Download className="h-3.5 w-3.5" aria-hidden /> Exportar tudo
          </BotaoSecundario>
        </div>

        <div className="rounded-[14px] border border-rule bg-surface px-4 py-3">
          <LinhaMetricas itens={metricas} />
          <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por idade">
            {[null, ...FAIXAS_IDADE.map((f) => f.id)].map((f) => {
              const ativo = filtro === f;
              const qtd = f ? k.porFaixa[f] : k.pendentes;
              if (f && qtd === 0) return null;
              return (
                <button
                  key={f ?? "todas"}
                  type="button"
                  aria-pressed={ativo}
                  onClick={() => setFiltro(ativo ? null : f)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
                    ativo ? "border-ink bg-ink text-white" : "border-rule text-ink-soft-2 hover:bg-[var(--bg-subtle)]",
                  )}
                >
                  {f ? FAIXA[f].rotulo : "Todas"} <span className="tabular opacity-80">{n(qtd)}</span>
                </button>
              );
            })}
          </div>
        </div>
        {copiado === "sim" && (
          <p role="status" className="text-[12.5px] font-medium text-ink-soft-2">
            <Check className="mr-1 inline h-3.5 w-3.5" style={{ color: "var(--positive)" }} aria-hidden />
            Texto copiado e CSV baixado. Cole o texto onde você cobra a base.
          </p>
        )}
      </section>

      <ul className="grid gap-3 xl:grid-cols-2" aria-label="Bases, da pior para a melhor">
        {bases.map((b) => {
          const aberta = !!abertas[b.unidade];
          const cor = corDaFaixa(b.pior);
          const topPlacas = b.placas.filter((p) => p.placa !== "Sem placa").slice(0, 3);
          return (
            <li key={b.unidade} className="min-w-0 rounded-[16px] border border-rule bg-surface p-4" style={{ borderLeft: `3px solid ${cor.cor}` }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[16px] font-semibold text-ink-2">{b.unidade}</span>
                    {b.base && <span className="text-[12.5px] text-ink-mute">{b.base.toLowerCase()}</span>}
                    {b.tipo && <span className="text-[11.5px] text-ink-mute">· {b.tipo}</span>}
                  </div>
                  <p className="mt-0.5 text-[13px] leading-snug text-ink-soft-2">
                    {plural(b.qtd, "pendente", "pendentes")}
                    {b.maisVelho != null && (
                      <>
                        {" · a mais antiga com "}
                        <strong className="tabular font-semibold" style={{ color: cor.cor }}>
                          {plural(b.maisVelho, "dia", "dias")}
                        </strong>
                      </>
                    )}
                    {" · "}
                    {brl(b.frete)} de frete
                  </p>
                </div>
                {cobradas[b.unidade] ? (
                  <BotaoSecundario onClick={() => cobrar(b)} rotulo={`Base ${b.unidade} cobrada às ${cobradas[b.unidade]}. Cobrar de novo`}>
                    <Check className="h-3.5 w-3.5" style={{ color: "var(--positive)" }} aria-hidden /> Cobrada {cobradas[b.unidade]}
                  </BotaoSecundario>
                ) : (
                  <BotaoPrincipal onClick={() => cobrar(b)} rotulo={`Cobrar base ${b.unidade}`}>
                    Cobrar base
                  </BotaoPrincipal>
                )}
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {[...FAIXAS_IDADE].reverse().map((f) => (b.porFaixa[f.id] > 0 ? <ChipFaixa key={f.id} f={f.id} qtd={b.porFaixa[f.id]} /> : null))}
              </div>
              {topPlacas.length > 0 && (
                <p className="mt-2 text-[12.5px] text-ink-soft-2">
                  Placas com mais pendências: <span className="tabular font-medium text-ink-2">{topPlacas.map((p) => `${p.placa} (${p.qtd})`).join(", ")}</span>
                </p>
              )}

              <button
                type="button"
                aria-expanded={aberta}
                onClick={() => setAbertas((a) => ({ ...a, [b.unidade]: !aberta }))}
                className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-soft-2 hover:text-ink"
              >
                <ChevronDown className={cn("h-4 w-4 transition-transform duration-150", !aberta && "-rotate-90")} aria-hidden />
                {aberta ? "Esconder as notas" : `Ver as notas de ${b.unidade}`}
              </button>

              {aberta && (
                <div className="mt-2 space-y-3">
                  {b.placas.map((p) => {
                    const itens = p.itens.slice(0, Math.max(0, restante));
                    restante -= itens.length;
                    if (itens.length === 0) return null;
                    return (
                      <div key={p.placa}>
                        <div className="text-[12px] font-semibold text-ink-2">
                          {p.placa} <span className="font-normal text-ink-mute">· {plural(p.qtd, "nota", "notas")}</span>
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {itens.map((c) => {
                            const d = idadeDe(c, agoraMs);
                            const cf = corDaFaixa(faixaIdade(d));
                            return (
                              <li key={`${c.ctrc}-${c.nf ?? ""}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] px-2 py-1.5 text-[12.5px] hover:bg-[var(--bg-subtle)]">
                                <span className="min-w-0 flex-1">
                                  <strong className="tabular font-semibold text-ink-2">{c.ctrc}</strong>
                                  <span className="text-ink-soft-2">
                                    {c.nf ? ` · NF ${c.nf}` : ""} · {c.cliente_pagador?.toLowerCase() ?? "sem cliente"}
                                    {c.data_entrega ? ` · entregue ${dataBr(c.data_entrega)}` : ""}
                                  </span>
                                  {d != null && (
                                    <span className="tabular font-medium" style={{ color: cf.cor }}>
                                      {" "}
                                      · {plural(d, "dia", "dias")}
                                    </span>
                                  )}
                                </span>
                                {c.op_item_id && (
                                  <BotaoSecundario onClick={() => onAbrirNota(c.op_item_id!)} rotulo={`Abrir ${c.nf ? `NF ${c.nf}` : c.ctrc} na fila`}>
                                    <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Abrir na fila
                                  </BotaoSecundario>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                  {restante <= 0 && (
                    <p className="px-2 text-[12px] text-ink-mute">A tela mostra até {n(LIMITE_ITENS_BASE)} notas abertas de uma vez. O CSV da base traz todas.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <section aria-label="Como ler" className="rounded-[16px] border border-rule bg-surface px-4">
        <Recolhivel titulo="Como ler esta tela" resumo="faixas e o % de pendência">
          <ul className="space-y-1.5 text-[12.5px] leading-snug text-ink-soft-2">
            <li className="flex flex-wrap gap-1.5">
              {FAIXAS_IDADE.map((f) => (
                <ChipFaixa key={f.id} f={f.id} />
              ))}
            </li>
            <li>Idade = dias corridos desde a entrega, contados no horário de Brasília.</li>
            <li>
              % de pendência = pendentes ÷ (pendentes + entregues com comprovante). É uma aproximação: as exclusões tiram notas só do lado das pendentes.
              {filial ? " Com uma filial escolhida na barra, o % não aparece." : ""}
            </li>
            <li>Ficam fora da lista: ocorrência de ressarcimento (deixou de ser da base) e CTRC em duplicidade na fonte.</li>
          </ul>
        </Recolhivel>
      </section>

      <DialogoCobranca base={cobrando} texto={texto} copiado={copiado} onConfirmar={() => void confirmarCobranca()} onFechar={() => setCobrando(null)} />
    </div>
  );
}
