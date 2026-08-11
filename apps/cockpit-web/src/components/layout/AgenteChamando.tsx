// =============================================================================
// AgenteChamando — barra inferior + conversa lateral do agente (INV-067).
//
// Caio 2026-08-11: "O pop up deve ser conforme uma mensagem, na parte inferior
// dizendo: O agente está te chamando, você pode ter um card travado. E quando
// ele clica, abre simulando uma conversa ao lado com o agente mandando pra ele
// exatamente o que aconteceu, qual card pode estar travado, e o que causou.
// No final pede pra ele verificar e, se for o caso, mandar pro corretor oficial
// de bugs. Se clicar em LIDO, o negócio some."
//
// Só aparece pro DONO do card (RLS de alertas_operador) e some ao marcar LIDO.
// =============================================================================

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ChevronRight, ExternalLink, Send, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useRealtimeTable } from "@/hooks/useRealtimeTable";
import {
  type AlertaOperadorRow,
  montarConversa,
  pendentes,
  quandoRelativo,
  textoBarra,
} from "@/lib/alertas-operador";
import { Sheet, SheetContent } from "@/components/ui/sheet";

const QK = ["alertas-operador"] as const;

export function AgenteChamando() {
  const { operador } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [aberto, setAberto] = useState(false);
  const [indice, setIndice] = useState(0);

  const { data: alertas = [] } = useQuery({
    queryKey: QK,
    enabled: !!supabase && !!operador?.id,
    queryFn: async (): Promise<AlertaOperadorRow[]> => {
      const { data, error } = await supabase!
        .from("alertas_operador")
        .select("id, card_id, nf, tipo, titulo, relatorio, criado_em, lido_em, encaminhado_em")
        .is("lido_em", null)
        .order("criado_em", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as AlertaOperadorRow[];
    },
    staleTime: 30_000,
  });

  // Push do Supabase: o aviso aparece sem o operador dar refresh.
  useRealtimeTable({
    table: "alertas_operador",
    queryKeys: [QK],
    enabled: !!operador?.id,
  });

  const fila = useMemo(() => pendentes(alertas), [alertas]);
  const atual = fila[Math.min(indice, Math.max(0, fila.length - 1))] ?? null;
  const falas = useMemo(() => (atual ? montarConversa(atual) : []), [atual]);
  const agora = Date.now();

  const marcarLido = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase!.rpc("marcar_alerta_operador_lido", { p_alerta_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Ok! Não te aviso mais sobre esse card.");
      setIndice(0);
      qc.invalidateQueries({ queryKey: QK });
      if (fila.length <= 1) setAberto(false);
    },
    onError: (e: Error) => toast.error(`Não consegui marcar como lido: ${e.message}`),
  });

  const encaminhar = useMutation({
    mutationFn: async (id: string) => {
      // Edge function (não RPC direta): ela encaminha E dispara o e-mail com o
      // diagnóstico técnico pro corretor de bugs. A autorização continua no
      // banco — a function repassa o JWT do operador pra RPC.
      const { data, error } = await supabase!.functions.invoke("encaminhar-alerta-bug", {
        body: { alerta_id: id },
      });
      if (error) throw error;
      if (!(data as { ok?: boolean } | null)?.ok) {
        throw new Error((data as { error?: string } | null)?.error ?? "falha ao encaminhar");
      }
    },
    onSuccess: () => {
      toast.success("Enviado pro corretor de bugs. Obrigado — isso ajuda a corrigir na raiz.");
      setIndice(0);
      qc.invalidateQueries({ queryKey: QK });
      if (fila.length <= 1) setAberto(false);
    },
    onError: (e: Error) => toast.error(`Não consegui encaminhar: ${e.message}`),
  });

  if (fila.length === 0) return null;

  return (
    <>
      {/* ── Barra inferior: o chamado ─────────────────────────────────────── */}
      {!aberto && (
        <button
          type="button"
          onClick={() => {
            setIndice(0);
            setAberto(true);
          }}
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border px-4 py-2.5 shadow-lg transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2"
          style={{
            background: "var(--c-ink)",
            color: "var(--c-paper)",
            borderColor: "var(--c-border-strong)",
          }}
          aria-label="Abrir aviso do agente"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
          </span>
          <Bot className="h-4 w-4 shrink-0" aria-hidden />
          <span className="text-[13px] font-medium">{textoBarra(fila.length)}</span>
          <ChevronRight className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
        </button>
      )}

      {/* ── Conversa lateral ──────────────────────────────────────────────── */}
      <Sheet open={aberto} onOpenChange={setAberto}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
          {atual && (
            <>
              <header
                className="flex items-center gap-2.5 border-b px-4 py-3"
                style={{ borderColor: "var(--c-border)" }}
              >
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
                  style={{ background: "var(--c-ink)", color: "var(--c-paper)" }}
                >
                  <Bot className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 leading-tight">
                  <div className="truncate text-[13px] font-semibold text-ink">Agente do Cockpit</div>
                  <div className="truncate text-[11px] text-ink-mute">
                    {quandoRelativo(atual.criado_em, agora)}
                    {fila.length > 1 && ` · ${indice + 1} de ${fila.length}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setAberto(false)}
                  className="ml-auto rounded p-1 text-ink-mute hover:text-ink"
                  aria-label="Fechar"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>

              {/* Falas do agente */}
              <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
                {falas.map((f) => (
                  <div
                    key={f.id}
                    className="max-w-[92%] whitespace-pre-line rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-[13px] leading-relaxed"
                    style={{
                      background: f.enfase ? "var(--warning-soft)" : "var(--c-surface-alt)",
                      color: "var(--c-ink)",
                      border: f.enfase ? "1px solid var(--warning)" : "1px solid var(--c-border)",
                    }}
                  >
                    {f.texto}
                  </div>
                ))}

                {atual.card_id && (
                  <button
                    type="button"
                    onClick={() => {
                      setAberto(false);
                      navigate(`/cards/${atual.card_id}`);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-bg-subtle"
                    style={{ borderColor: "var(--c-border-strong)", color: "var(--c-ink)" }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    Abrir o card da NF {atual.nf ?? "—"}
                  </button>
                )}

                {atual.encaminhado_em && (
                  <div className="text-[11px] text-ink-mute">
                    Já encaminhado pro corretor de bugs {quandoRelativo(atual.encaminhado_em, agora)}.
                  </div>
                )}
              </div>

              {/* Ações */}
              <footer
                className="flex flex-col gap-2 border-t px-4 py-3"
                style={{ borderColor: "var(--c-border)" }}
              >
                <button
                  type="button"
                  disabled={encaminhar.isPending || !!atual.encaminhado_em}
                  onClick={() => encaminhar.mutate(atual.id)}
                  className="btn-flat inline-flex w-full items-center justify-center gap-2 bg-sal text-paper disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden />
                  {atual.encaminhado_em ? "Já enviado pro corretor" : "Aconteceu — mandar pro corretor de bugs"}
                </button>
                <button
                  type="button"
                  disabled={marcarLido.isPending}
                  onClick={() => marcarLido.mutate(atual.id)}
                  className="btn-flat inline-flex w-full items-center justify-center gap-2 bg-paper text-ink disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  LIDO
                </button>
                {fila.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setIndice((i) => (i + 1) % fila.length)}
                    className="text-[11px] text-ink-mute underline-offset-2 hover:underline"
                  >
                    Ver o próximo aviso
                  </button>
                )}
              </footer>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
