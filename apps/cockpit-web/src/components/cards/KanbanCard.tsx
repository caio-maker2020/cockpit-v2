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
  const map: Record<string, string> = { email: "e-mail", whatsapp: "wpp", sistema: "sistema" };
  return (
    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
      {(canal && map[canal]) || "·"}
    </span>
  );
}

/** Único chip forte do card texto-primeiro: reservado pra cobrança repetida. */
function Chip({
  tone = "crit",
  children,
}: {
  tone?: "crit" | "neutral";
  children: React.ReactNode;
}) {
  const map: Record<"crit" | "neutral", string> = {
    crit: "bg-signal-soft text-signal-strong",
    neutral: "bg-surface-alt text-ink-soft",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight",
        map[tone],
      )}
    >
      {children}
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

  // Título = a ocorrência (o "problema") primeiro; cliente vira subtítulo.
  const titulo =
    ocorrencia?.descricao || card.empresa_cliente || card.nome_cliente || "Cliente sem identificação";
  const subtitulo = ocorrencia?.descricao
    ? card.empresa_cliente || card.nome_cliente || "—"
    : card.nome_cliente || null;

  // Trilho fino de estado à esquerda (sinal, não barra colorida cheia).
  const railClass = clienteRespondeu
    ? "border-l-2 border-l-indigo-500"
    : possivelRespostaOutraThread
      ? "border-l-2 border-l-amber-500"
      : cobrancaRepetida || acaoFalhou
        ? "border-l-2 border-l-sal"
        : pendentes > 0
          ? "border-l-2 border-l-sal"
          : "border-l-2 border-l-transparent";

  return (
    <article
      onClick={() => navigate(`/cards/${card.id}`)}
      className={cn("ticket-card group cursor-pointer p-2.5 animate-stagger", railClass)}
    >
      {/* Zona 1 — identidade: NF · CTRC · modo/lock · risco (texto, sem pills) */}
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={(e) => handleCopy(e, card.nf, "NF")}
          title="Copiar NF"
          className="tabular font-mono text-[13px] font-semibold text-ink hover:text-sal"
        >
          {card.nf || "———"}
        </button>
        {card.ctrc && (
          <button
            type="button"
            onClick={(e) => handleCopy(e, card.ctrc, "CTRC")}
            title="Copiar CTRC"
            className="tabular font-mono text-[10px] text-ink-mute hover:text-sal"
          >
            {card.ctrc}
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-ink-mute">
          {isLocked && <span className="text-warn">lock</span>}
          {isAuto && <span className="text-ink-soft">auto</span>}
          {isHumano && <span>humano</span>}
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              isUrgent ? "bg-sal animate-pulse-dot" : "bg-rule-strong",
            )}
            title={isUrgent ? "Risco alto" : "Risco baixo"}
            aria-label={isUrgent ? "Risco alto" : "Risco baixo"}
          />
        </span>
      </div>

      {/* Título = a ocorrência (o problema) */}
      <h3 className="mt-1.5 text-[13.5px] font-semibold leading-snug text-ink line-clamp-2">
        {titulo}
      </h3>

      {/* Cliente · oc · IA — tudo em texto, nada colorido */}
      <div className="mt-0.5 text-[11.5px] leading-snug text-ink-soft">
        {subtitulo && <span className="truncate">{subtitulo}</span>}
        {codigoOco != null && (
          <span className="font-mono text-[10px] text-ink-mute">
            {subtitulo ? " · " : ""}oc {codigoOco}
          </span>
        )}
        {(iaSug || clienteRespondeu) && (
          <span className="font-mono text-[10px] text-signal-strong"> · IA</span>
        )}
      </div>

      {/* Zona 2 — sinais como uma única linha de texto secundário; só cobrança vira chip forte */}
      {(() => {
        const sinais = [
          clienteRespondeu &&
            `respondeu ${relativeShort(card.cliente_respondeu_em)}${
              (iaSug?.pendencias_resposta_cliente?.length ?? 0) > 0
                ? ` · ${iaSug!.pendencias_resposta_cliente!.length} pend.`
                : ""
            }`,
          clienteRespondeu &&
            iaSug &&
            `IA oc ${iaSug.oc_sugerida} (${Math.round((iaSug.confianca ?? 0) * 100)}%)`,
          possivelRespostaOutraThread && "possível resposta em outra thread",
          acaoFalhou && "ação não executada",
          hasAlertaOc && "oc alterada",
          cobradaNoWpp && "cobrada no wpp",
          card.sem_chave_cte && "sem chave CT-e",
          isAcaoExecutada &&
            tempoAcao &&
            `${tempoAcao.bastaoAtrasado ? "Bastão atrasado " : "Lançado "}${tempoAcao.label}`,
        ].filter(Boolean) as string[];
        if (!cobrancaRepetida && sinais.length === 0) return null;
        return (
          <div className="mt-2 border-t border-rule pt-2">
            {cobrancaRepetida && (
              <div className="mb-1.5">
                <Chip tone="crit">cliente cobrou {cobrancas}×</Chip>
              </div>
            )}
            {sinais.length > 0 && (
              <p className="text-[11px] leading-relaxed text-ink-soft">{sinais.join("  ·  ")}</p>
            )}
          </div>
        );
      })()}

      {/* Zona 3 — rodapé meta: tempo · canal · dias · dono */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-rule pt-2 font-mono text-[10px] text-ink-mute">
        <div className="flex items-center gap-2">
          <span className="tabular">{relativeShort(card.last_event_at ?? card.updated_at)}</span>
          <CanalIcon canal={card.canal_origem} />
          {dias != null && dias > 0 && (
            <span className={cn("tabular", dias > 7 ? "font-semibold text-sal" : "text-warn")}>
              {dias}d
            </span>
          )}
        </div>
        {responsavelNome ? (
          <span className="inline-flex items-center gap-1 truncate" title={responsavelNome}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-ink font-mono text-[9px] font-bold text-paper">
              {initials(responsavelNome).charAt(0)}
            </span>
            <span className="truncate uppercase tracking-wider">{responsavelNome.split(" ")[0]}</span>
          </span>
        ) : (
          <span className="italic text-ink-disabled">sem dono</span>
        )}
      </div>
    </article>
  );
}
