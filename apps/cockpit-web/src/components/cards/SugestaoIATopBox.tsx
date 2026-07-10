import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useModoFoco } from "@/hooks/useModoFoco";
import type { CardRow, TodoRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EditarEmailModal } from "./EditarEmailModal";
import type { EmailPreexistenteSugerido } from "./BannerTratativaDetectada";


/**
 * Caixa roxa unificada "Sugestão da IA" — fica no TOPO do detalhe do card,
 * largura cheia (no lugar do antigo banner de tratativa detectada).
 *
 * Duas seções empilhadas:
 *   A) 📨 Tratativa detectada (só quando email_preexistente_sugerido.auto === true)
 *      - raciocínio do agente (nota_agente), assunto + participantes da thread,
 *        botão "Não é deste card — seguir em e-mail novo" (descartar).
 *   B) 🤖 Sugestão da IA (sempre que ia_sugestao_oc_resposta existir)
 *      - titulo (usa ia.titulo quando vier; nunca o default de oc 54 "cliente respondeu
 *        inconclusivo" pra contexto 'cobrou_antes_notificacao'),
 *      - confiança + motivo,
 *      - botão "Aprovar oc 54 + e-mail" (localiza proposta lancar_oc_e_enviar_email
 *        e abre o EditarEmailModal com o template sugerido).
 */
export function SugestaoIATopBox({ card }: { card: CardRow }) {
  const pre = (card as unknown as { email_preexistente_sugerido?: EmailPreexistenteSugerido | null })
    .email_preexistente_sugerido ?? null;
  const ia = card.ia_sugestao_oc_resposta;

  const [modoFoco] = useModoFoco();
  const [overrideExpanded, setOverrideExpanded] = useState<boolean | null>(null);

  const mostrarA = pre?.auto === true;
  const mostrarB = !!ia;
  if (!mostrarA && !mostrarB) return null;

  const collapsed = overrideExpanded == null ? modoFoco : !overrideExpanded;

  if (collapsed) {
    const titulo = mostrarA
      ? "Tratativa detectada + sugestão da IA"
      : "Sugestão da IA disponível";
    return (
      <div className="mx-6 mt-3 flex items-center gap-3 border-l-[3px] border-indigo-500 bg-indigo-50 px-3 py-2">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-wider text-indigo-900">
          {titulo}
        </div>
        <button
          type="button"
          onClick={() => setOverrideExpanded(true)}
          className="border border-indigo-400 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-indigo-800 hover:bg-indigo-100"
        >
          Ver
        </button>
        <button
          type="button"
          aria-label="Expandir caixa de sugestão da IA"
          onClick={() => setOverrideExpanded(true)}
          className="text-indigo-700 hover:text-indigo-900"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="mx-6 mt-3 borderborder-indigo-400 bg-indigo-50/80 text-indigo-950">
      <div className="flex items-center justify-end px-2 pt-1">
        <button
          type="button"
          aria-label="Recolher caixa de sugestão da IA"
          onClick={() => setOverrideExpanded(false)}
          className="text-indigo-700 hover:text-indigo-900"
          title="Recolher (modo foco)"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
      </div>
      {mostrarA && <SecaoTratativaDetectada cardId={card.id} pre={pre!} />}
      {mostrarA && mostrarB && <div className="mx-4 border-t border-indigo-300/70" />}
      {mostrarB && <SecaoSugestaoIA card={card} ia={ia!} />}
    </div>
  );
}


/* ============================================================================
 * Seção A — Tratativa detectada (raciocínio)
 * ========================================================================== */

function SecaoTratativaDetectada({
  cardId,
  pre,
}: {
  cardId: string;
  pre: EmailPreexistenteSugerido;
}) {
  const qc = useQueryClient();
  const [descartando, setDescartando] = useState(false);

  const principal =
    pre.candidatos?.find(
      (c) =>
        pre.thread_principal &&
        (c as { gmail_thread_id?: string }).gmail_thread_id === pre.thread_principal,
    ) ?? pre.candidatos?.[0];

  const chipEstado =
    pre.roteamento === "cliente_respondeu"
      ? { label: "CLIENTE RESPONDEU", cls: "border-good bg-good/15 text-good" }
      : pre.roteamento === "aguardando_voce"
        ? { label: "AGUARDANDO VOCÊ", cls: "border-sal bg-sal text-paper" }
        : null;

  async function descartar() {
    if (!supabase) return;
    if (
      !window.confirm(
        "Descartar a thread detectada? As mensagens importadas vão sumir e a tratativa volta a ser um e-mail novo.",
      )
    )
      return;
    setDescartando(true);
    const { data, error } = await supabase.rpc("descartar_email_preexistente", {
      p_card_id: cardId,
    });
    setDescartando(false);
    if (error || !(data as { ok?: boolean })?.ok) {
      toast.error(error?.message ?? "Erro ao descartar");
      return;
    }
    toast.success("Tratativa descartada — siga em um e-mail novo.");
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["tratativas-email", cardId] });
    qc.invalidateQueries({ queryKey: ["mensagens", cardId] });
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-700">
        <span>Tratativa detectada — o agente puxou a conversa do cliente</span>
        {chipEstado && (
          <span
            className={cn(
              "inline-flex items-center borderpx-2 py-0.5 font-mono text-[10px] font-bold tracking-wider",
              chipEstado.cls,
            )}
          >
            {chipEstado.label}
          </span>
        )}
      </div>

      {pre.nota_agente && (
        <p className="mt-1 font-display text-[12.5px] leading-snug text-ink/85">
          {pre.nota_agente}
        </p>
      )}

      {principal && (
        <div className="mt-2 border-l-2 border-indigo-400/60 pl-2 text-[12px]">
          {(principal as { assunto?: string }).assunto && (
            <div className="text-ink">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                Assunto:
              </span>{" "}
              <strong>{(principal as { assunto?: string }).assunto}</strong>
            </div>
          )}
          {Array.isArray((principal as { participantes?: string[] }).participantes) &&
            (principal as { participantes?: string[] }).participantes!.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  Participantes:
                </span>
                {(principal as { participantes?: string[] })
                  .participantes!.slice(0, 4)
                  .map((p, i) => (
                    <span
                      key={i}
                      className="border border-indigo-300 bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-indigo-900"
                    >
                      {p}
                    </span>
                  ))}
              </div>
            )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={descartar}
          disabled={descartando}
          className="border border-indigo-700/40 bg-white px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-indigo-900 hover:bg-indigo-100 disabled:opacity-40"
        >
          {descartando ? "..." : "Não é deste card — seguir em e-mail novo"}
        </button>
        <span className="font-display text-[11px] italic text-ink-soft">
          se descartar, a tratativa segue em um e-mail novo.
        </span>
      </div>
    </div>
  );
}

/* ============================================================================
 * Seção B — Sugestão da IA (ação)
 * ========================================================================== */

type IaSugestao = NonNullable<CardRow["ia_sugestao_oc_resposta"]>;

const OC_LABELS_BANNER: Record<number, string> = {
  21: "Reentrega solicitada",
  44: "Devolução / retorno de carga",
  54: "Re-lançar 54 (cliente respondeu inconclusivo)",
  55: "Autorizar entrega parcial",
  56: "Falta info operacional",
};

function tituloDefault(ia: IaSugestao): string {
  if (ia.sugere_combo_33_44) return "Lançar 33 + Lançar 44 — Ressarcimento";
  if (ia.sugere_oc33_solo) return "Lançar oc 33 — Reversão de Perdas (extravio total)";
  const oc = ia.oc_sugerida;
  const lbl = OC_LABELS_BANNER[oc] ?? `oc ${oc}`;
  return `Lançar oc ${oc} — ${lbl}`;
}

function SecaoSugestaoIA({ card, ia }: { card: CardRow; ia: IaSugestao }) {
  const qc = useQueryClient();
  const [modalTodoId, setModalTodoId] = useState<string | null>(null);
  const [modalTemplate, setModalTemplate] = useState<string | null>(null);
  const [submittingModal, setSubmittingModal] = useState(false);
  const [verOutras, setVerOutras] = useState(false);

  const {
    data: pendentes,
    isError: pendentesErro,
    refetch: refetchPendentes,
  } = useQuery({
    queryKey: ["todos-pendentes", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("todos")
        .select("id,proposta_payload,status")
        .eq("card_id", card.id)
        .eq("status", "pendente")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TodoRow[];
    },
  });

  const ehCobrouAntes = ia.contexto === "cobrou_antes_notificacao";
  // NUNCA usar o label default de oc 54 "cliente respondeu inconclusivo"
  // pra contexto cobrou_antes_notificacao — nesse caso o cliente criou a
  // conversa e nós ainda não notificamos.
  const tituloFinal =
    ia.titulo?.trim() ||
    (ehCobrouAntes && ia.oc_sugerida === 54
      ? "Notificar o extravio ao cliente — lançar oc 54 + e-mail"
      : tituloDefault(ia));

  const conf = Number(ia.confianca ?? 0);
  const pct = Math.round(conf * 100);
  const badge =
    conf >= 0.8
      ? { label: `ALTA (${pct}%) ✓`, cls: "border-good/40 bg-good/15 text-good" }
      : conf >= 0.5
        ? { label: `média (${pct}%)`, cls: "border-warn/50 bg-warn/15 text-ink" }
        : { label: `baixa (${pct}%)`, cls: "border-orange-400 bg-orange-100 text-orange-900" };

  // Match defensivo:
  // 1) PRIMEIRO por acao_key vindo de aviso_alteracao_oc.proposta_destacada_acao
  //    (string exata, ex: "lancar_oc_e_enviar_email:54").
  // 2) Senão, por (tool, codigo_ssw). Em empate, NUNCA preferir
  //    sem_email_explicito — preferir a versão que NOTIFICA (meta.modo === 'completo').
  const codigoAlvo = ia.acao_codigo_ssw ?? ia.oc_sugerida ?? 54;
  const destaqueAcaoKey: string | null =
    ((card as any).aviso_alteracao_oc?.tipo === "ia_sugestao_ocs_padrao"
      ? ((card as any).aviso_alteracao_oc?.proposta_destacada_acao as string | undefined)
      : undefined) ?? null;

  const lista = pendentes ?? [];
  let todoLancarOcEmail: TodoRow | undefined;
  if (destaqueAcaoKey) {
    todoLancarOcEmail = lista.find((t) => {
      const pl = (t.proposta_payload ?? {}) as any;
      return pl?.acao_key === destaqueAcaoKey;
    });
  }
  if (!todoLancarOcEmail) {
    const candidatos = lista.filter((t) => {
      const pl = (t.proposta_payload ?? {}) as any;
      return (
        pl?.tool === (ia.acao_tool ?? "lancar_oc_e_enviar_email") &&
        Number(pl?.args?.codigo_ssw) === Number(codigoAlvo)
      );
    });
    todoLancarOcEmail =
      candidatos.find((t) => ((t.proposta_payload as any)?.meta?.modo === "completo")) ??
      candidatos.find((t) => ((t.proposta_payload as any)?.meta?.sem_email_explicito !== true)) ??
      candidatos[0];
  }

  const outrasOpcoes = (pendentes ?? []).filter((t) => t.id !== todoLancarOcEmail?.id);

  function aprovarOc54Email() {
    if (!todoLancarOcEmail) {
      toast.warning(`Proposta oc=${codigoAlvo} + e-mail não está pendente`);
      // fallback: scroll na lista de propostas no painel direito
      const el = document.querySelector("[data-acoes-sugeridas]");
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const pl = (todoLancarOcEmail.proposta_payload ?? {}) as {
      args?: { template_id?: string | null };
    };
    setModalTemplate(ia.template_email_sugerido ?? pl?.args?.template_id ?? null);
    setModalTodoId(todoLancarOcEmail.id);
  }

  async function handleModalConfirm(extras: Record<string, unknown>) {
    if (!supabase || !modalTodoId) return;
    setSubmittingModal(true);
    const { error } = await supabase.rpc("aprovar_e_executar", {
      p_todo_id: modalTodoId,
      p_extras: extras,
    } as any);
    setSubmittingModal(false);
    if (error) {
      toast.error("Erro ao aprovar", { description: error.message });
      return;
    }
    toast.success(`✓ oc=${codigoAlvo} aprovada — e-mail enviando…`);
    setModalTodoId(null);
    qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    qc.invalidateQueries({ queryKey: ["card-events", card.id] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-1 flex items-start gap-2">
        <div className="flex flex-1 items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-700">
          <span className="text-indigo-500">{ehCobrouAntes ? "◐" : "◆"}</span>
          {ehCobrouAntes
            ? "Sugestão da IA · cliente cobrou antes da notificação"
            : "sugestão da IA"}
        </div>
        <FeedbackInterpretadorIA cardId={card.id} />
      </div>
      <div className="font-display text-[15px] font-semibold leading-tight text-ink">
        {tituloFinal}
      </div>
      <div className="mt-1.5">
        <span
          className={cn(
            "inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            badge.cls,
          )}
        >
          confiança: {badge.label}
        </span>
      </div>
      {ia.motivo && (
        <blockquote className="mt-2 border-l-2 border-indigo-400/60 pl-2 font-display text-[12px] italic leading-snug text-ink/80">
          "{ia.motivo}"
        </blockquote>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pendentesErro ? (
          // INV-016 no front: se a query de todos falha, a sugestão continua
          // aparecendo mas o botão sumiria/desabilitaria em silêncio ("ver
          // outras 0 opções"), fazendo o operador achar que não há ação. Erro
          // de carga NÃO pode virar "nada pra fazer". Estado explícito + retry.
          <div className="flex flex-wrap items-center gap-2 border border-orange-400 bg-orange-100 px-2.5 py-1.5 font-mono text-[10px] text-orange-900">
            <span className="font-bold uppercase tracking-wider">
              Falha ao carregar as ações desta sugestão
            </span>
            <span className="normal-case">A IA sugeriu algo, mas as ações não puderam ser lidas. Não quer dizer que não há ação.</span>
            <button
              type="button"
              onClick={() => refetchPendentes()}
              className="border border-orange-500 px-2 py-0.5 uppercase tracking-wider hover:bg-orange-200"
            >
              Tentar novamente
            </button>
          </div>
        ) : (
        <>
        {(() => {
          const pl = (todoLancarOcEmail?.proposta_payload ?? {}) as any;
          const ehCompleto = pl?.meta?.modo === "completo";
          const ehSemEmailExplicito = pl?.meta?.sem_email_explicito === true;
          const btnLabel = ehCompleto
            ? `✓ Aprovar oc ${codigoAlvo} — abrir editor`
            : `✓ Aprovar oc ${codigoAlvo}`;
          return (
            <>
              <button
                type="button"
                onClick={aprovarOc54Email}
                disabled={!todoLancarOcEmail || submittingModal}
                className="inline-flex items-center gap-2 bg-indigo-600 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  todoLancarOcEmail
                    ? ehCompleto
                      ? "Abrir editor de e-mail com o template sugerido"
                      : "Aprovar e lançar ação no SSW"
                    : `Proposta oc=${codigoAlvo} não está disponível`
                }
              >
                {submittingModal && <Loader2 className="h-3 w-3 animate-spin" />}
                {btnLabel}
              </button>
              {ehCompleto && (
                <span
                  className="borderborder-emerald-600 bg-emerald-50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-800"
                  title="Esta ação lança a oc e envia e-mail ao cliente"
                >
                  + e-mail ao cliente
                </span>
              )}
              {ehSemEmailExplicito && (
                <span
                  className="borderborder-amber-600 bg-amber-100 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-amber-900"
                  title="Esta ação lança a oc mas NÃO envia e-mail ao cliente"
                >
                  sem e-mail — cliente NÃO será notificado
                </span>
              )}
            </>
          );
        })()}
        <button
          type="button"
          onClick={() => setVerOutras((v) => !v)}
          className="font-mono text-[10px] uppercase tracking-wider text-indigo-700 transition-colors hover:text-indigo-900"
        >
          {verOutras
            ? "esconder outras opções"
            : `ver outras ${outrasOpcoes.length} opções →`}
        </button>
        </>
        )}
      </div>

      {verOutras && outrasOpcoes.length > 0 && (
        <div className="mt-2 border-t border-indigo-200 pt-2">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-ink-mute">
            Outras propostas pendentes
          </div>
          <ul className="space-y-1">
            {outrasOpcoes.map((t) => {
              const pl = (t.proposta_payload ?? {}) as {
                tool?: string;
                args?: { codigo_ssw?: number };
              };
              const oc = Number(pl?.args?.codigo_ssw ?? 0);
              return (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-2 border border-indigo-200 bg-white/70 px-2 py-1 text-[11px]"
                >
                  <span className="font-mono text-ink">
                    {pl?.tool ?? "—"} {oc ? `· oc ${oc}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.querySelector(`[data-todo-id="${t.id}"]`);
                      el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                    className="font-mono text-[10px] uppercase tracking-wider text-indigo-700 hover:text-indigo-900"
                  >
                    ver no painel →
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {modalTodoId && (
        <EditarEmailModal
          todoId={modalTodoId}
          templateSugeridoIA={modalTemplate}
          onClose={() => setModalTodoId(null)}
          onConfirm={handleModalConfirm}
          submitting={submittingModal}
        />
      )}
    </div>
  );
}

/* ============================================================================
 * Widget de feedback "IA acertou / IA errou" — interpretador_resposta_cliente
 * ========================================================================== */

type FeedbackRow = {
  id: string;
  tipo_feedback: string;
  motivo_correcao: string | null;
  decisao_correta_codigo_ssw: number | null;
  corrigido_em: string;
};

function FeedbackInterpretadorIA({ cardId }: { cardId: string }) {
  const qc = useQueryClient();
  const [modalAberto, setModalAberto] = useState(false);
  const [registrando, setRegistrando] = useState(false);

  const { data: feedback } = useQuery({
    queryKey: ["feedback-interpretador-ia", cardId],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("interpretador_resposta_cliente_feedback")
        .select("id, tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_em")
        .eq("card_id", cardId)
        .eq("origem", "explicito")
        .order("corrigido_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as FeedbackRow | null;
    },
  });

  async function marcarAcertou() {
    if (!supabase) return;
    setRegistrando(true);
    const { error } = await supabase.rpc("registrar_feedback_interpretador_resposta_ia" as any, {
      p_card_id: cardId,
      p_acertou: true,
      p_decisao_correta_codigo_ssw: null,
      p_motivo_correcao: null,
    } as any);
    setRegistrando(false);
    if (error) {
      toast.error("Não consegui registrar: " + error.message);
      return;
    }
    toast.success("✓ Feedback registrado");
    qc.invalidateQueries({ queryKey: ["feedback-interpretador-ia", cardId] });
  }

  const acertou = feedback?.tipo_feedback === "acertou_explicito";
  const errou = feedback?.tipo_feedback === "errou_explicito";

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5">
        {acertou ? (
          <span className="inline-flex items-center gap-1 border border-good/40 bg-good/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-good">
            ✓ você marcou: acertou
          </span>
        ) : errou ? (
          <span className="inline-flex items-center gap-1 border border-signal/40 bg-signal-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-signal">
            ✗ você marcou: errou
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={marcarAcertou}
              disabled={registrando}
              className="rounded border border-good/40 px-1.5 py-0.5 font-mono text-[10px] text-good hover:bg-good/15 disabled:opacity-40"
              title="A sugestão da IA está correta"
            >
              acertou
            </button>
            <button
              type="button"
              onClick={() => setModalAberto(true)}
              className="rounded border border-signal/40 px-1.5 py-0.5 font-mono text-[10px] text-signal hover:bg-signal-soft"
              title="A IA errou — registrar correção"
            >
              errou
            </button>
          </>
        )}
        {(acertou || errou) && (
          <button
            type="button"
            onClick={() => {
              if (errou) {
                setModalAberto(true);
              } else {
                // alterar do acertou -> abre modal pra registrar errou
                setModalAberto(true);
              }
            }}
            className="font-mono text-[10px] text-ink-soft underline underline-offset-2 hover:text-ink"
          >
            alterar →
          </button>
        )}
      </div>
      {modalAberto && (
        <ModalIaErrouInterpretador
          cardId={cardId}
          feedbackAtual={feedback ?? null}
          onClose={() => setModalAberto(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["feedback-interpretador-ia", cardId] });
            setModalAberto(false);
          }}
        />
      )}
    </>
  );
}

function ModalIaErrouInterpretador({
  cardId,
  feedbackAtual,
  onClose,
  onSaved,
}: {
  cardId: string;
  feedbackAtual: FeedbackRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [codigo, setCodigo] = useState<string>(
    feedbackAtual?.decisao_correta_codigo_ssw != null
      ? String(feedbackAtual.decisao_correta_codigo_ssw)
      : "",
  );
  const [motivo, setMotivo] = useState<string>(feedbackAtual?.motivo_correcao ?? "");
  const [enviando, setEnviando] = useState(false);

  const { data: ocs } = useQuery({
    queryKey: ["ocorrencias-dicionario"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("ocorrencias_dicionario")
        .select("codigo, descricao")
        .order("codigo");
      if (error) throw error;
      return (data ?? []) as { codigo: number; descricao: string }[];
    },
  });

  const habilitado = motivo.trim().length >= 10 && !enviando;

  async function salvar() {
    if (!supabase) return;
    setEnviando(true);
    const { error } = await supabase.rpc(
      "registrar_feedback_interpretador_resposta_ia" as any,
      {
        p_card_id: cardId,
        p_acertou: false,
        p_decisao_correta_codigo_ssw: codigo === "" ? null : Number(codigo),
        p_motivo_correcao: motivo.trim(),
      } as any,
    );
    setEnviando(false);
    if (error) {
      toast.error("Não foi possível registrar: " + error.message);
      return;
    }
    toast.success("Feedback registrado — vai melhorar a IA.");
    onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-md borderborder-ink bg-paper p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">
            IA errou — me ajude a melhorar
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>

        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          Qual oc seria a correta? (opcional)
        </label>
        <select
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          className="mb-3 w-full border border-ink/30 bg-paper px-2 py-1.5 text-sm"
        >
          <option value="">— não sei / não se aplica —</option>
          {(ocs ?? []).map((o) => (
            <option key={o.codigo} value={o.codigo}>
              {o.codigo} — {o.descricao}
            </option>
          ))}
        </select>

        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          O que a IA errou? / O que era o certo? * (mín 10 chars)
        </label>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={4}
          placeholder="Ex: Cliente só pediu pra aguardar, não confirmou endereço/data — não era pra sugerir reentrega (oc 21), era pra responder cobrando."
          className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-sm"
        />
        <div className="mt-1 text-right font-mono text-[10px] text-ink-soft">
          {motivo.trim().length} / 10 mín
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={salvar}
            disabled={!habilitado}
            className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper hover:bg-ink disabled:opacity-40"
          >
            {enviando ? "..." : "Salvar feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}
