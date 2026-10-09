// =============================================================================
// Trabalho do dia pelo MESMO fluxo da torre: Aguardando você (dúvida) → Com
// sugestão (firme) → Aguardar (firme) → Conselheiro alertou → Na fila do SSW /
// Lançada / Confirmada. A família vira etiqueta no cartão. Colunas vazias somem.
// Nenhum botão grava direto: "Ver prévia e confirmar" abre a MESMA prévia do
// detalhe (useFluxoLancamento); só o confirmar da prévia pede o lançamento.
// =============================================================================
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Clock, Eye, Forward, Hand, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Chip } from "@/components/cockpit";
import { dotClass } from "@/components/cockpit/tones";
import { useOpApi } from "@/contexts/OperacaoContext";
import { ehFalhaOp } from "@/lib/operacao/api";
import { mensagemErroOp } from "@/lib/operacao/erros";
import { familiaDaOc, familiaPorId } from "@/lib/operacao/familias";
import { tempoParadoMs } from "@/lib/operacao/fila";
import { acaoDaSugestao, frase, nivelCerteza, ROTULO_CERTEZA, sugereAguardar, sugereEncaminhar, textoAguardar, type NivelCerteza } from "@/lib/operacao/sugestao";
import { ETAPAS_FLUXO, agruparPorEtapa, type AvisoConselheiro, type EtapaFluxoId } from "@/lib/operacao/torre";
import type { OpFilaLinha, OpSessao } from "@/lib/operacao/tipos";
import { cn } from "@/lib/utils";
import { ChipStatusLancamento, TempoParado } from "./ChipsOperacao";
import { PAGINA_COLUNA } from "./KanbanOperacao";
import { useFluxoLancamento } from "./useFluxoLancamento";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

const COR_CERTEZA: Record<NivelCerteza, string> = { alta: "var(--positive)", media: "var(--warning)", baixa: "var(--signal)" };

function titulo(t: string | null | undefined): string {
  const s = (t ?? "").trim().toLowerCase();
  return s.replace(/(^|[\s/(-])([a-zà-ÿ])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

/** A sugestão em uma linha, na língua do operador. */
export function linhaDaSugestao(l: OpFilaLinha): string | null {
  const s = l.sugestao;
  if (!s || !acaoDaSugestao(s)) return null;
  if (sugereAguardar(s)) return textoAguardar(s);
  if (sugereEncaminhar(s)) return "Encaminhar ao Relacionamento";
  const t = (s.texto ?? "").trim();
  return t ? `Lançar ocorrência ${s.codigo}: ${frase(t)}` : `Lançar ocorrência ${s.codigo}`;
}

function Botao({
  onClick,
  children,
  rotulo,
  tipo = "secundario",
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  rotulo: string;
  tipo?: "principal" | "secundario" | "violeta";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={rotulo}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold transition-[background-color,opacity,transform] duration-150 active:scale-[0.96] disabled:opacity-40",
        tipo === "principal" && "bg-sal text-white hover:bg-sal/90",
        tipo === "violeta" && "text-white hover:opacity-90",
        tipo === "secundario" && "border border-rule bg-surface text-ink-2 hover:bg-[var(--bg-subtle)]",
      )}
      style={tipo === "violeta" ? { background: "var(--encaminhar-botao)" } : undefined}
    >
      {children}
    </button>
  );
}

export function KanbanFluxo({
  linhas,
  agoraMs,
  sessao,
  codigosLiberados,
  alertadas,
  avisoDaNota,
  etapaDestaque = null,
  selecionadoId,
  onAbrir,
}: {
  linhas: OpFilaLinha[];
  agoraMs: number;
  sessao: OpSessao | null;
  codigosLiberados: ReadonlySet<number> | null;
  alertadas: ReadonlySet<string>;
  /** O aviso do conselheiro de cada nota alertada: aparece no próprio cartão. */
  avisoDaNota?: ReadonlyMap<string, AvisoConselheiro>;
  /** Coluna que a faixa da torre acabou de apontar (realce breve). */
  etapaDestaque?: EtapaFluxoId | null;
  selecionadoId: string | null;
  onAbrir: (id: string) => void;
}) {
  const api = useOpApi();
  const qc = useQueryClient();
  const fluxo = useFluxoLancamento();
  const [assumindo, setAssumindo] = useState<string | null>(null);
  const [mostrar, setMostrar] = useState<Record<string, number>>({});
  const membro = sessao?.membro ?? null;
  const podeLancar = !!membro?.pode_lancar && !!sessao?.flags?.operacao_lancar_ssw;

  const g = agruparPorEtapa(linhas, alertadas, codigosLiberados);
  const cheias = ETAPAS_FLUXO.filter((e) => g[e.id].length > 0);

  async function assumir(l: OpFilaLinha) {
    if (!api) return;
    setAssumindo(l.op_item_id);
    try {
      const r = await api.assumir(l.op_item_id, false);
      if (ehFalhaOp(r)) toast.error(mensagemErroOp(r));
      else toast.success(`NF ${l.nf ?? l.ctrc} agora é sua.`);
      qc.invalidateQueries({ queryKey: ["op"] });
    } finally {
      setAssumindo(null);
    }
  }
  async function aceitar(l: OpFilaLinha) {
    if (!l.sugestao) return;
    const erro = await fluxo.abrirPrevia(l.op_item_id, "sugestao", l.sugestao.codigo as number, l.sugestao.texto ?? "");
    if (erro) toast.error(erro);
  }
  async function encaminhar(l: OpFilaLinha) {
    const erro = await fluxo.abrirPreviaEncaminhamento(l.op_item_id, "");
    if (erro) toast.error(erro);
  }
  async function desfazer(l: OpFilaLinha) {
    if (!l.encaminhamento_id) return;
    const erro = await fluxo.desfazerEncaminhamento(l.encaminhamento_id);
    if (erro) toast.error(erro);
  }

  // Função (não componente): o cartão não remonta a cada render e o foco do teclado fica.
  function cartao(l: OpFilaLinha, etapa: EtapaFluxoId) {
    const fam = familiaPorId(familiaDaOc(l.cod_ultima_ocorrencia));
    const ms = tempoParadoMs(l, agoraMs);
    // Relógio da família (Redespacho, 40): dias na oc; passou do limite → cobrar (Caio 08/10).
    const diasNaOc = ms != null ? Math.floor(ms / 86_400_000) : null;
    const cobrar = fam.alertaAposDias != null && diasNaOc != null && diasNaOc >= fam.alertaAposDias;
    const meu = !!membro && l.assumido_por === membro.id;
    const sug = linhaDaSugestao(l);
    const nivel = nivelCerteza(l.sugestao);
    const enc = sugereEncaminhar(l.sugestao);
    const nome = nf(l);
    return (
      <li key={l.op_item_id}>
        <div
          role="button"
          tabIndex={0}
          data-testid={`cartao-${l.op_item_id}`}
          onClick={() => onAbrir(l.op_item_id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onAbrir(l.op_item_id);
            }
          }}
          className={cn(
            "cursor-pointer rounded-[12px] border bg-surface p-3 text-left transition-[border-color,box-shadow] duration-150 hover:shadow-[0_2px_8px_rgba(27,36,48,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30",
            selecionadoId === l.op_item_id ? "border-ink shadow-[0_0_0_1px_hsl(var(--ink))]" : "border-rule",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium text-ink-soft-2">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass[fam.tom])} aria-hidden />
              <span className="truncate">{fam.titulo}</span>
            </span>
            <TempoParado ms={ms} compacto />
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-[14px] font-semibold text-ink-2">{nome}</span>
            {l.unidade && <span className="shrink-0 text-[11px] font-medium text-ink-mute">base {l.unidade}</span>}
          </div>
          {(l.destinatario || l.cidade_destino) && (
            <div className="truncate text-[12.5px] text-ink-soft-2" title={l.destinatario ?? undefined}>
              {[titulo(l.destinatario) || null, l.cidade_destino ? `${titulo(l.cidade_destino)}${l.uf_destino ? `/${l.uf_destino}` : ""}` : null].filter(Boolean).join(" · ")}
            </div>
          )}
          {l.descricao_oc && (
            <div className="mt-1 line-clamp-1 text-[12px] text-ink-mute" title={`Última ocorrência ${l.cod_ultima_ocorrencia ?? ""}`}>
              Última ocorrência: {frase(l.descricao_oc)}
            </div>
          )}
          {fam.alertaAposDias != null && diasNaOc != null && (
            <div data-testid="relogio-familia" className="mt-1.5">
              <Chip tone={cobrar ? "crit" : diasNaOc >= fam.alertaAposDias - 1 ? "warning" : "neutral"}>
                {cobrar
                  ? `Cobrar: ${diasNaOc} d sem movimento na oc ${l.cod_ultima_ocorrencia ?? "—"}`
                  : `oc ${l.cod_ultima_ocorrencia ?? "—"} há ${diasNaOc} d · limite ${fam.alertaAposDias} d`}
              </Chip>
            </div>
          )}

          {avisoDaNota?.get(l.op_item_id) && (
            <div
              data-testid="aviso-conselheiro-cartao"
              className="mt-2 flex items-start gap-1.5 rounded-[8px] px-2 py-1.5 text-[11.5px] leading-snug"
              style={
                avisoDaNota.get(l.op_item_id)!.tom === "critico"
                  ? { background: "var(--signal-softer)", color: "var(--signal-strong)" }
                  : { background: "var(--warning-soft)", color: "var(--warning-strong)" }
              }
            >
              <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">Conselheiro:</strong> {avisoDaNota.get(l.op_item_id)!.titulo.toLowerCase()}
              </span>
            </div>
          )}

          {etapa !== "enviada" && sug && (
            <div data-testid="sugestao-cartao" className="mt-2 flex items-start gap-1.5 border-t border-rule pt-2 text-[12px] leading-snug text-ink-2">
              {sugereAguardar(l.sugestao) ? <Clock className="mt-[2px] h-3.5 w-3.5 shrink-0 text-ink-mute" aria-hidden /> : <ArrowRight className="mt-[2px] h-3.5 w-3.5 shrink-0 text-ink-mute" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2">{sug}</span>
                {nivel && (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: COR_CERTEZA[nivel] }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: COR_CERTEZA[nivel] }} aria-hidden />
                    {ROTULO_CERTEZA[nivel]}
                  </span>
                )}
              </span>
            </div>
          )}

          {etapa === "enviada" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-rule pt-2 text-[12px]">
              {l.encaminhamento_id ? (
                <>
                  <span className="font-medium" style={{ color: "var(--encaminhar)" }}>
                    Encaminhamento agendado{l.encaminhamento_executar_apos ? ` para ${hhmm(l.encaminhamento_executar_apos)}` : ""}
                  </span>
                  {membro && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void desfazer(l);
                      }}
                      className="font-semibold text-ink-2 underline underline-offset-2"
                    >
                      Desfazer
                    </button>
                  )}
                </>
              ) : (
                <span data-testid="selo-andamento">
                  <ChipStatusLancamento status={l.lancamento_status} codigo={l.lancamento_codigo_oc} />
                </span>
              )}
            </div>
          )}

          {(l.assumido_por_nome || etapa === "pronta" || etapa === "duvida" || etapa === "conselheiro") && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {etapa === "pronta" && podeLancar && l.sugestao && (
                enc ? (
                  <Botao tipo="violeta" rotulo={`Encaminhar ao Relacionamento a NF ${l.nf ?? l.ctrc}`} onClick={() => encaminhar(l)} disabled={fluxo.ocupado}>
                    {fluxo.carregandoPrevia === l.op_item_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Forward className="h-3.5 w-3.5" />}
                    Ver prévia e encaminhar
                  </Botao>
                ) : (
                  <Botao tipo="principal" rotulo={`Aceitar sugestão da NF ${l.nf ?? l.ctrc}`} onClick={() => aceitar(l)} disabled={fluxo.ocupado}>
                    {fluxo.carregandoPrevia === l.op_item_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                    Ver prévia e confirmar
                  </Botao>
                )
              )}
              {(etapa === "duvida" || etapa === "conselheiro") && (
                <Botao tipo={etapa === "duvida" ? "principal" : "secundario"} rotulo={`Abrir e decidir a NF ${l.nf ?? l.ctrc}`} onClick={() => onAbrir(l.op_item_id)}>
                  Abrir e decidir
                </Botao>
              )}
              {membro && !meu && etapa !== "enviada" && etapa !== "segue" && (
                <Botao rotulo={`Assumir NF ${l.nf ?? l.ctrc}`} onClick={() => assumir(l)} disabled={assumindo !== null}>
                  {assumindo === l.op_item_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hand className="h-3.5 w-3.5" />}
                  Assumir
                </Botao>
              )}
              {l.assumido_por_nome && (
                <span className={cn("ml-auto inline-flex items-center gap-1 text-[11.5px] text-ink-mute", meu && "font-semibold text-ink-2")}>
                  <UserRound className="h-3 w-3" aria-hidden />
                  {meu ? "com você" : l.assumido_por_nome}
                </span>
              )}
            </div>
          )}
        </div>
      </li>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {cheias.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-ink-mute md:px-7">Nenhuma nota com esses filtros.</p>
        ) : (
          <div
            className="grid min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 pt-3 md:px-6"
            style={{ gridTemplateColumns: `repeat(${cheias.length}, minmax(268px, 1fr))` }}
          >
            {cheias.map((e) => {
              const itens = g[e.id];
              const limite = mostrar[e.id] ?? PAGINA_COLUNA;
              const vis = itens.slice(0, limite);
              const faltam = itens.length - vis.length;
              return (
                <section
                  key={e.id}
                  data-testid={`etapa-${e.id}`}
                  aria-label={e.titulo}
                  className={cn(
                    "flex min-h-0 scroll-ml-5 flex-col rounded-[16px] bg-[var(--bg-subtle)] p-2 transition-shadow duration-300",
                    etapaDestaque === e.id && "shadow-[0_0_0_2px_hsl(var(--ink))]",
                  )}
                >
                  <header className="rounded-[12px] border border-rule bg-surface px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="inline-flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: e.cor }} aria-hidden />
                        {e.titulo}
                      </h3>
                      <span className="tabular text-[13px] font-semibold text-ink-2">{itens.length.toLocaleString("pt-BR")}</span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-ink-mute">{e.dica}</p>
                  </header>
                  <ul className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
                    {vis.map((l) => (
                      cartao(l, e.id)
                    ))}
                    {faltam > 0 && (
                      <li>
                        <button
                          type="button"
                          onClick={() => setMostrar((m) => ({ ...m, [e.id]: limite + PAGINA_COLUNA }))}
                          className="w-full rounded-[10px] border border-dashed border-rule-strong py-2 text-[12px] font-medium text-ink-soft-2 hover:text-ink-2"
                        >
                          Ver mais {Math.min(PAGINA_COLUNA, faltam)} (faltam {faltam})
                        </button>
                      </li>
                    )}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {fluxo.dialogo}
    </>
  );
}

const nf = (l: OpFilaLinha) => (l.nf ? `NF ${l.nf}` : `CTRC ${l.ctrc}`);
