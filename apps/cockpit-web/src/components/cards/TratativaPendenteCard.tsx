import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { aprovarEExecutarComFeedback } from "@/lib/aprovarComFeedback";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import type { CardRow, TodoRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useCtrcOverrideStore } from "@/stores/useCtrcOverrideStore";
import {
  useTratativasEmail,
  getResponderParaEscolhido,
} from "@/hooks/useTratativasEmail";
import { EditarEmailModal } from "./EditarEmailModal";

export function TratativaPendenteCard({ card }: { card: CardRow }) {
  const qc = useQueryClient();
  const forcarCtrcBaixado = useCtrcOverrideStore((s) => !!s.byCard[card.id]);
  const { data: tratativasData } = useTratativasEmail(card.id);
  const travadoPorTratativa =
    !!tratativasData?.multiplas_tratativas && !tratativasData?.tratativa_escolhida;
  const responderParaEscolhido = getResponderParaEscolhido(tratativasData ?? null);
  const [confirming, setConfirming] = useState(false);
  const [loadingTodo, setLoadingTodo] = useState<string | null>(null);
  const [modalEmailTodo, setModalEmailTodo] = useState<TodoRow | null>(null);
  // Default vem da intenção da proposta original (tool === 'lancar_oc_e_enviar_email')
  const [enviarEmailMap, setEnviarEmailMap] = useState<Record<string, boolean>>({});

  const { data: todos } = useQuery({
    queryKey: ["todos-pendentes", card.id],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("todos")
        .select("*")
        .eq("card_id", card.id)
        .eq("status", "pendente")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TodoRow[];
    },
  });
  useRealtimeInvalidate("todos", ["todos-pendentes", card.id], `card_id=eq.${card.id}`);

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

  const aprovar = useMutation({
    mutationFn: async (vars: {
      todoId: string;
      extras?: Record<string, unknown>;
      _codigo?: number | null;
    }) => {
      if (!supabase) throw new Error("Sem conexão");
      if (travadoPorTratativa) {
        throw new Error("Escolha qual tratativa responder primeiro");
      }
      const params: Record<string, unknown> = { p_todo_id: vars.todoId };
      const extras: Record<string, unknown> = { ...(vars.extras ?? {}) };
      if (forcarCtrcBaixado) extras.forcar_lancamento_ctrc_baixado = true;
      if (responderParaEscolhido) {
        const atuais = (extras.email_destinatarios as string[] | undefined) ?? [];
        if (!atuais.length) {
          extras.email_destinatarios = [responderParaEscolhido];
        } else if (atuais[0] !== responderParaEscolhido) {
          extras.email_destinatarios = [
            responderParaEscolhido,
            ...atuais.filter((e) => e !== responderParaEscolhido),
          ];
        }
      }
      if (Object.keys(extras).length > 0) {
        params.p_extras = extras;
      }
      const { error } = await aprovarEExecutarComFeedback(params as any);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      const codigo = vars._codigo;
      const enviou = (vars.extras as any)?.enviar_email === true;
      if (codigo === 54 || codigo === 59) {
        toast.success(
          enviou ? `Lançando oc ${codigo} + enviando email…` : `Lançando oc ${codigo} (sem email).`,
        );
      } else {
        toast.success("Aprovado. Executando...");
      }
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
      qc.invalidateQueries({ queryKey: ["card", card.id] });
    },
    onError: (err: any) =>
      toast.error("Erro ao aprovar", { description: err?.message ?? "Tente novamente" }),
    onSettled: () => setLoadingTodo(null),
  });

  const naoImportante = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error("Sem conexão");
      const { error } = await supabase.rpc("marcar_card_nao_importante", {
        p_card_id: card.id,
        p_motivo: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Card marcado como não importante.");
      qc.invalidateQueries({ queryKey: ["cards"] });
      qc.invalidateQueries({ queryKey: ["card", card.id] });
    },
    onError: (err: any) =>
      toast.error("Erro ao marcar", { description: err?.message ?? "Tente novamente" }),
  });

  function handleNaoImportante() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setConfirming(false);
    naoImportante.mutate();
  }

  function handleAcompanhar() {
    toast.success("Mantendo card em acompanhamento.");
  }

  const todosPendentes = todos ?? [];
  const busy = aprovar.isPending || naoImportante.isPending || travadoPorTratativa;

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between border-b-2 border-ink pb-2">
        <h3 className="font-display text-[16px] font-semibold text-ink">Tratativa pendente</h3>
        <span className="border-2 border-sal-deep bg-sal-deep px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-paper">
          ⚠ Decisão
        </span>
      </div>

      {travadoPorTratativa && (
        <div className="flex items-start gap-2 border-2 border-yellow-500 bg-yellow-100 px-3 py-2 text-yellow-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-widest">
              Aprovação travada — escolha uma tratativa
            </div>
            <div className="mt-0.5 font-display text-[12px] leading-snug">
              Essa NF tem mais de uma tratativa por e-mail. Vá na aba{" "}
              <strong>Mensagens</strong> e selecione qual você vai responder.
            </div>
          </div>
        </div>
      )}

      {cobrancaRepetida && (
        <div className="border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider">
            🔔 Cliente cobrou {cobrancas} vezes sobre essa NF — atenção!
          </span>
        </div>
      )}

      <div
        className={cn(
          "border bg-paper p-4",
          cobrancaRepetida ? "border-l-4 border-l-red-500 border-ink/15" : "border-ink/15",
        )}
      >
        <div className="mb-3 flex items-baseline gap-2 truncate font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          <span className="font-semibold text-ink">NF {card.nf ?? "—"}</span>
          <span className="text-ink/30">·</span>
          <span className="truncate">{card.empresa_cliente ?? "—"}</span>
          <span className="text-ink/30">·</span>
          <span>oc {card.cod_ultima_ocorrencia ?? "—"}</span>
        </div>

        <div className="mb-3 border border-ink/15 bg-ink/5 px-3 py-2 text-xs">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink/60">
            última ocorrência
          </div>
          <div className="text-ink">
            oc <strong>{card.cod_ultima_ocorrencia ?? "—"}</strong> —{" "}
            {todosPendentes.length > 0
              ? "Cliente respondeu — escolha a próxima ação ou aguarde decisão dele."
              : "Cliente cobrou sobre essa NF que está fora do escopo do Relacionamento."}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {todosPendentes.map((t) => {
            const pl = (t.proposta_payload ?? {}) as any;
            const args = pl?.args ?? null;
            const codigoNum =
              args && typeof args === "object" && "codigo_ssw" in args
                ? Number((args as any).codigo_ssw)
                : null;
            const codigo = codigoNum != null ? String(codigoNum) : null;
            const propostaEnviaEmail = pl?.tool === "lancar_oc_e_enviar_email";
            const mostraCheckbox =
              codigoNum === 54 || codigoNum === 59 || propostaEnviaEmail;
            const enviarEmail =
              enviarEmailMap[t.id] ?? propostaEnviaEmail;
            const label = codigo ? `Aprovar e lançar ${codigo} →` : "Aprovar →";
            return (
              <div key={t.id} className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    // Bug fix: tool 'lancar_oc_e_enviar_email' PRECISA passar pelo modal
                    // de revisão antes do envio. Nunca aprovar direto.
                    if (propostaEnviaEmail && enviarEmail) {
                      setModalEmailTodo(t);
                      return;
                    }
                    setLoadingTodo(t.id);
                    const extras: Record<string, unknown> = {};
                    if (mostraCheckbox) {
                      extras.enviar_email = enviarEmail;
                      extras.skip_email = !enviarEmail;
                    }
                    aprovar.mutate({
                      todoId: t.id,
                      extras: Object.keys(extras).length ? extras : undefined,
                      _codigo: codigoNum,
                    });
                  }}
                  disabled={busy}
                  title={t.descricao ?? `Lançar oc ${codigo} no SSW`}
                  className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
                >
                  {loadingTodo === t.id ? "..." : label}
                </button>

                {mostraCheckbox && (
                  <label className="flex cursor-pointer items-center gap-1.5 border border-ink/15 bg-paper px-2 py-1">
                    <input
                      type="checkbox"
                      checked={enviarEmail}
                      onChange={(e) =>
                        setEnviarEmailMap((m) => ({ ...m, [t.id]: e.target.checked }))
                      }
                      disabled={busy}
                      className="h-3.5 w-3.5 accent-sal"
                    />
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink">
                      enviar email
                    </span>
                    {!enviarEmail && propostaEnviaEmail && (
                      <span className="font-mono text-[9px] text-orange-600">
                        ⚠ só lança {codigo}
                      </span>
                    )}
                    {enviarEmail && !propostaEnviaEmail && (
                      <span className="font-mono text-[9px] text-blue-600">
                        📧 +email
                      </span>
                    )}
                  </label>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">

          <button
            onClick={handleAcompanhar}
            disabled={busy}
            title="Mantém o card em acompanhamento. Decida depois."
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            ⚡ Acompanhar
          </button>
          <button
            onClick={handleNaoImportante}
            disabled={busy}
            title="Cancela o card. Some da plataforma."
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink disabled:opacity-40"
          >
            {naoImportante.isPending
              ? "..."
              : confirming
                ? "Confirmar? clique de novo"
                : "✕ Não importante"}
          </button>
        </div>
      </div>

      {modalEmailTodo && (
        <EditarEmailModal
          todoId={modalEmailTodo.id}
          iaCorpoSugerido={
            [10, 11, 19, 35].includes(card.cod_ultima_ocorrencia ?? 0) &&
            [54, 59].includes((card as any).analise_padrao_resultado?.proposta_destacada ?? 0)
              ? (card as any).analise_padrao_resultado?.corpo_email_sugerido ?? null
              : null
          }
          templateSugeridoIA={
            (card as any).analise_padrao_resultado?.template_email_sugerido ?? null
          }
          onClose={() => setModalEmailTodo(null)}
          onConfirm={(extras) => {
            const todoId = modalEmailTodo.id;
            const pl = (modalEmailTodo.proposta_payload ?? {}) as any;
            const args = pl?.args ?? null;
            const codigoNum =
              args && typeof args === "object" && "codigo_ssw" in args
                ? Number((args as any).codigo_ssw)
                : null;
            setLoadingTodo(todoId);
            setModalEmailTodo(null);
            aprovar.mutate({ todoId, extras, _codigo: codigoNum });
          }}
          submitting={aprovar.isPending}
        />
      )}
    </div>
  );
}

