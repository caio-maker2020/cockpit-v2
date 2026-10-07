// =============================================================================
// Kanban da Operação — visão principal da /operacao (alternável com a lista).
// Mesmo kit do Inbox (CockpitBoard/CockpitColumn/CockpitCard). Ações no cartão:
// assumir e aceitar sugestão. Aceitar abre a MESMA prévia → confirmação do
// detalhe (useFluxoLancamento): o cartão nunca lança direto.
// =============================================================================
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, Hand, Lightbulb, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { CockpitBoard, CockpitCard, CockpitColumn, CockpitEmptyState, type Tone } from "@/components/cockpit";
import { useOpApi } from "@/contexts/OperacaoContext";
import { ehFalhaOp } from "@/lib/operacao/api";
import { mensagemErroOp } from "@/lib/operacao/erros";
import { tempoParadoMs, tomTempoParado } from "@/lib/operacao/fila";
import { ORDEM_COLUNAS_KANBAN_OP, agruparKanban, colunaPorId } from "@/lib/operacao/kanban";
import { rotuloSugestao, sugestaoLancavel } from "@/lib/operacao/sugestao";
import type { OpFilaLinha, OpSessao } from "@/lib/operacao/tipos";
import { cn } from "@/lib/utils";
import { ChipStatusLancamento, TempoParado } from "./ChipsOperacao";
import { useFluxoLancamento } from "./useFluxoLancamento";

const ESPINHA: Record<ReturnType<typeof tomTempoParado>, Tone> = { critico: "sal", atencao: "amber", ok: "none" };

function BotaoCartao({
  onClick,
  children,
  destaque,
  disabled,
  rotulo,
}: {
  onClick: () => void;
  children: React.ReactNode;
  destaque?: boolean;
  disabled?: boolean;
  rotulo: string;
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
        "inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-semibold transition-colors disabled:opacity-40",
        destaque ? "bg-sal text-white hover:bg-sal/90" : "border border-rule bg-surface text-ink-2 hover:bg-[var(--bg-subtle)]",
      )}
    >
      {children}
    </button>
  );
}

export function KanbanOperacao({
  linhas,
  agoraMs,
  sessao,
  codigosLiberados,
  selecionadoId,
  onAbrir,
}: {
  linhas: OpFilaLinha[];
  agoraMs: number;
  sessao: OpSessao | null;
  codigosLiberados: ReadonlySet<number> | null;
  selecionadoId: string | null;
  onAbrir: (id: string) => void;
}) {
  const api = useOpApi();
  const qc = useQueryClient();
  const fluxo = useFluxoLancamento();
  const [assumindo, setAssumindo] = useState<string | null>(null);
  const membro = sessao?.membro ?? null;
  const podeLancar = !!membro?.pode_lancar && !!sessao?.flags?.operacao_lancar_ssw;
  const grupos = agruparKanban(linhas);

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
    const erro = await fluxo.abrirPrevia(l.op_item_id, "sugestao", l.sugestao.codigo, l.sugestao.texto ?? "");
    if (erro) toast.error(erro);
  }

  return (
    <>
      <CockpitBoard className="min-h-[420px]">
        {ORDEM_COLUNAS_KANBAN_OP.map((id) => {
          const col = colunaPorId(id);
          const itens = grupos[id];
          return (
            <CockpitColumn key={id} tone={col.tom} title={col.titulo} count={itens.length}>
              <div data-testid={`coluna-${id}`} className="space-y-2.5">
                {itens.length === 0 ? (
                  <CockpitEmptyState glyph="—" text={col.vazio} />
                ) : (
                  itens.map((l) => {
                    const ms = tempoParadoMs(l, agoraMs);
                    const meu = !!membro && l.assumido_por === membro.id;
                    const lancavel = sugestaoLancavel(l.sugestao, codigosLiberados);
                    const ativo = l.lancamento_status === "fila" || l.lancamento_status === "lancando" || l.lancamento_status === "lancado";
                    return (
                      <CockpitCard
                        key={l.op_item_id}
                        spine={ESPINHA[tomTempoParado(ms)]}
                        onClick={() => onAbrir(l.op_item_id)}
                        className={cn(selecionadoId === l.op_item_id && "ring-2 ring-sal/40")}
                      >
                        <div data-testid={`cartao-${l.op_item_id}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-mono text-[13px] font-semibold text-ink-2">NF {l.nf ?? "—"}</div>
                              <div className="truncate font-mono text-[11px] text-ink-soft-2">CTRC {l.ctrc}</div>
                            </div>
                            <TempoParado ms={ms} compacto />
                          </div>
                          <div className="mt-1.5 line-clamp-2 text-[12px] text-ink-2">
                            <span className="font-mono font-semibold">oc {l.cod_ultima_ocorrencia ?? "—"}</span>
                            {l.descricao_oc ? ` · ${l.descricao_oc}` : ""}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-soft-2">
                            <span className="rounded-[5px] border border-rule px-1.5 font-mono text-[10px] font-semibold uppercase">
                              {l.unidade ?? "sem unidade"}
                            </span>
                            {l.cidade_destino && <span className="truncate">{l.cidade_destino}</span>}
                            {l.assumido_por_nome && (
                              <span className={cn("inline-flex items-center gap-1", meu && "font-semibold text-ink-2")}>
                                <UserRound className="h-3 w-3" aria-hidden />
                                {meu ? "com você" : l.assumido_por_nome}
                              </span>
                            )}
                            <ChipStatusLancamento status={l.lancamento_status} codigo={l.lancamento_codigo_oc} />
                          </div>

                          {l.sugestao && !ativo && (
                            <div
                              className="mt-2 rounded-md px-2 py-1.5 text-[11.5px]"
                              style={
                                lancavel
                                  ? { background: "rgba(112,72,232,0.10)", color: "#5B3CC4" }
                                  : { background: "var(--bg-subtle)", color: "var(--c-ink-mute)" }
                              }
                            >
                              <div className="flex items-start gap-1">
                                <Lightbulb className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                                <span className="font-semibold">{rotuloSugestao(l.sugestao)}</span>
                              </div>
                              {!lancavel && <div className="mt-0.5">Só registro: código ainda não liberado.</div>}
                            </div>
                          )}

                          {(membro && !meu && !ativo) || (l.sugestao && lancavel && !ativo && podeLancar) ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {membro && !meu && !ativo && (
                                <BotaoCartao
                                  rotulo={`Assumir NF ${l.nf ?? l.ctrc}`}
                                  onClick={() => assumir(l)}
                                  disabled={assumindo !== null}
                                >
                                  {assumindo === l.op_item_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Hand className="h-3 w-3" />}
                                  Assumir
                                </BotaoCartao>
                              )}
                              {l.sugestao && lancavel && !ativo && podeLancar && (
                                <BotaoCartao
                                  destaque
                                  rotulo={`Aceitar sugestão da NF ${l.nf ?? l.ctrc}`}
                                  onClick={() => aceitar(l)}
                                  disabled={fluxo.ocupado}
                                >
                                  {fluxo.carregandoPrevia === l.op_item_id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Eye className="h-3 w-3" />
                                  )}
                                  Aceitar sugestão
                                </BotaoCartao>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </CockpitCard>
                    );
                  })
                )}
              </div>
            </CockpitColumn>
          );
        })}
      </CockpitBoard>
      {fluxo.dialogo}
    </>
  );
}
