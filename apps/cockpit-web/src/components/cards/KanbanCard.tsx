import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyToClipboard, initials, relativeShort } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import type { CardWithRelations } from "@/lib/types";
import { useTempoDesdeAcao } from "@/hooks/useTempoDesdeAcao";

interface Props {
  card: CardWithRelations;
  pendentes: number;
}

function CanalIcon({ canal }: { canal: string | null }) {
  const map: Record<string, string> = { email: "✉", whatsapp: "◉", sistema: "⌧" };
  return <span className="font-mono text-[11px]">{(canal && map[canal]) || "·"}</span>;
}

function RibbonTag({
  children,
  variant = "neutral",
}: {
  children: React.ReactNode;
  variant?: "auto" | "human" | "neutral";
}) {
  const styles =
    variant === "auto"
      ? "bg-ink text-paper"
      : variant === "human"
        ? "bg-paper-deep text-ink-soft border border-rule-strong"
        : "bg-paper text-ink-soft border border-rule";
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-widest",
        styles,
      )}
      style={{
        clipPath: "polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%)",
      }}
    >
      {children}
    </span>
  );
}

function LockBadge() {
  return (
    <span
      title="Travado: aguarda aprovação humana"
      className="inline-flex items-center gap-1 border border-warn bg-warn/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-ink"
    >
      🔒 Lock
    </span>
  );
}

export function KanbanCard({ card, pendentes }: Props) {
  const navigate = useNavigate();
  const isUrgent = card.risco === "alto";
  const isLocked = !!card.lock_aguardando_validacao;
  const isAuto = card.aprovacao_modo === "autonoma";
  const isHumano = card.aprovacao_modo === "humana";
  const isAcaoExecutada = card.state === "ACAO_EXECUTADA";
  const tempoAcao = useTempoDesdeAcao(isAcaoExecutada ? card.acao_executada_em ?? null : null);
  const responsavelNome = card.operador?.nome ?? null;
  const ocorrencia = card.ocorrencia;
  const codigoOco = card.cod_ultima_ocorrencia;
  const clienteRespondeu =
    !!card.cliente_respondeu_em && card.state === "AGUARDANDO_VALIDACAO_HUMANA";
  const possivelRespostaOutraThread =
    !clienteRespondeu &&
    (card as unknown as { possivel_resposta_outra_thread?: boolean })
      .possivel_resposta_outra_thread === true;
  const iaSug = card.ia_sugestao_oc_resposta;

  const hasAlertaOc = !!card.aviso_alteracao_oc;
  const cobradaNoWpp = !!card.aviso_alteracao_oc?.cobrada_no_wpp;
  const acaoFalhou = !!card.acao_falhou_motivo;

  const { data: cobrancas } = useQuery({
    queryKey: ["cobrancas-count", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { count } = await supabase!
        .from("messages_inbox")
        .select("id", { count: "exact", head: true })
        .eq("card_id", card.id);
      return count ?? 0;
    },
  });
  const cobrancaRepetida = (cobrancas ?? 0) > 1;

  const dias = (() => {
    const v = (card.agent_state as Record<string, unknown> | null)?.["dias_atraso"];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : null;
    return Number.isFinite(n as number) ? (n as number) : null;
  })();

  const handleCopy = async (e: React.MouseEvent, value: string | null, label: string) => {
    e.stopPropagation();
    if (!value) return;
    if (await copyToClipboard(value)) toast.success(`${label} copiado`);
  };

  return (
    <article
      onClick={() => navigate(`/cards/${card.id}`)}
      className={cn(
        "ticket-card relative cursor-pointer p-3 animate-stagger",
        pendentes > 0 && "border-l-[6px] border-l-sal",
        clienteRespondeu
          ? "border-l-4 border-l-orange-500 bg-orange-50/60"
          : possivelRespostaOutraThread
            ? "border-l-4 border-l-amber-500 bg-amber-50/40"
            : cobrancaRepetida
              ? "border-l-4 border-l-red-500 bg-red-50/40"
              : acaoFalhou
                ? "border-l-4 border-l-yellow-500 bg-yellow-100/60"
                : cobradaNoWpp
                  ? "border-l-4 border-l-amber-500 bg-amber-50/40"
                  : hasAlertaOc && "border-l-4 border-l-amber-400 bg-amber-50/40",
      )}
    >
      {clienteRespondeu && (
        <div className="-mx-3 -mt-3 mb-2 flex items-center justify-between gap-2 border-b-2 border-orange-500 bg-orange-500 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-paper">
          <span className="flex items-center gap-2">
            📬 cliente respondeu
            {(iaSug?.pendencias_resposta_cliente?.length ?? 0) > 0 && (
              <span
                title={iaSug!.pendencias_resposta_cliente!.join(" · ")}
                className="inline-flex items-center gap-0.5 border border-paper bg-orange-700 px-1 py-0 font-mono text-[9px] font-bold"
              >
                ⚠ {iaSug!.pendencias_resposta_cliente!.length}
              </span>
            )}
          </span>
          <span className="font-normal opacity-90">
            {relativeShort(card.cliente_respondeu_em)}
          </span>
        </div>
      )}
      {possivelRespostaOutraThread && (
        <div className="-mx-3 -mt-3 mb-2 flex items-center justify-between gap-2 border-b-2 border-amber-500 bg-amber-500 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-ink">
          <span>📨 possível resposta em outra thread · valide</span>
        </div>
      )}
      {cobrancaRepetida ? (
        <span
          className="absolute right-2 top-2 text-[13px] font-bold text-red-600"
          title={`Cliente cobrou ${cobrancas} vezes — atenção urgente`}
        >
          🔔
        </span>
      ) : acaoFalhou ? (
        <span
          className="absolute right-2 top-2 text-[13px] font-bold text-yellow-700 animate-pulse"
          title={`Ação não executada — verifique. Motivo: ${card.acao_falhou_motivo?.slice(0, 120)}`}
        >
          ❗
        </span>
      ) : hasAlertaOc ? (
        <span
          className="absolute right-2 top-2 text-[13px] text-amber-600"
          title="Última ocorrência foi alterada — clique pra revisar"
        >
          ⚠️
        </span>
      ) : null}
      {/* Top strip: NF + tags */}
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={(e) => handleCopy(e, card.nf, "NF")}
          className="flex items-baseline gap-1.5 hover:text-sal"
        >
          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">
            NF
          </span>
          <span className="tabular font-mono text-[14px] font-semibold text-ink">
            {card.nf || "———"}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {card.sem_chave_cte && (
            <span
              title="Sem chave CT-e — aguardando RPA"
              className="inline-flex items-center gap-0.5 border border-orange-300 bg-orange-50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-orange-900"
            >
              🔑 sem chave
            </span>
          )}
          {isLocked && <LockBadge />}
          {isAuto && <RibbonTag variant="auto">🤖 Auto</RibbonTag>}
          {isHumano && <RibbonTag variant="human">✋ Humano</RibbonTag>}
          {isUrgent && (
            <span
              className="inline-block h-2.5 w-2.5 rounded-full bg-sal animate-pulse-dot"
              title="Risco alto"
              aria-label="Risco alto"
            />
          )}
        </div>
      </div>

      {/* Linha decorativa (separa cabeçalho do corpo, estética bilhete) */}
      <div className="my-2 h-px bg-rule" />

      {/* Empresa */}
      <h3 className="font-display text-[15px] font-semibold leading-snug text-ink">
        {card.empresa_cliente || card.nome_cliente || "Cliente sem identificação"}
      </h3>

      {/* CTRC pequeno */}
      {card.ctrc && (
        <div className="mt-0.5 font-mono text-[10px] text-ink-soft">
          CTRC <span className="text-ink">{card.ctrc}</span>
        </div>
      )}

      {/* Ocorrência */}
      {(ocorrencia || codigoOco != null) && (
        <div className="mt-2 border-l-2 border-ink-soft pl-2">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">
              OC
            </span>
            <span className="tabular font-mono text-[12px] font-semibold text-ink">
              {codigoOco ?? "?"}
            </span>
          </div>
          {ocorrencia?.descricao && (
            <p className="font-display text-[12px] italic leading-snug text-ink-soft line-clamp-2">
              {ocorrencia.descricao}
            </p>
          )}
        </div>
      )}

      {cobradaNoWpp && (
        <div className="mt-2">
          <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-amber-900">
            📱 cobrada no wpp
          </span>
        </div>
      )}

      {isAcaoExecutada && tempoAcao && (
        <div
          className={cn(
            "mt-2 border px-2 py-1 font-mono text-[10px]",
            tempoAcao.bastaoAtrasado
              ? "border-red-500 bg-red-50 text-red-700 font-bold"
              : "border-blue-300 bg-blue-50 text-blue-800",
          )}
        >
          {tempoAcao.bastaoAtrasado ? "⚠ Bastão atrasado " : "⏱ Lançado "}
          {tempoAcao.label}
        </div>
      )}

      {clienteRespondeu && iaSug && (
        <div className="mt-2 border border-indigo-300 bg-indigo-50 px-2 py-1 font-mono text-[10px] text-indigo-900">
          🤖 IA sugere: oc {iaSug.oc_sugerida}{" "}
          <span className="opacity-70">
            ({Math.round((iaSug.confianca ?? 0) * 100)}%)
          </span>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-rule pt-2 font-mono text-[10px] text-ink-soft">
        <div className="flex items-center gap-2">
          <span className="tabular">{relativeShort(card.last_event_at ?? card.updated_at)}</span>
          <CanalIcon canal={card.canal_origem} />
          {dias != null && dias > 0 && (
            <span
              className={cn(
                "tabular",
                dias > 7 ? "text-sal font-semibold" : "text-warn",
              )}
            >
              {dias}d
            </span>
          )}
        </div>
        {responsavelNome ? (
          <span
            className="inline-flex items-center gap-1 truncate"
            title={responsavelNome}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center bg-ink font-mono text-[9px] font-bold text-paper">
              {initials(responsavelNome).charAt(0)}
            </span>
            <span className="truncate uppercase tracking-wider">{responsavelNome.split(" ")[0]}</span>
          </span>
        ) : (
          <span className="font-display text-[11px] italic text-rule-strong">sem dono</span>
        )}
      </div>
    </article>
  );
}
