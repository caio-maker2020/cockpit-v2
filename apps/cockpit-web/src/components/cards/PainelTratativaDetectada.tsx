import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MailQuestion } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import EmailThread, { type EmailThreadMessage } from "./EmailThread";

interface PreviewMsg {
  direcao: "inbound" | "outbound";
  de: string | null;
  ts: string | null;
  snippet: string;
}

interface Candidato {
  gmail_thread_id: string;
  assunto: string;
  score: number;
  nf_no_assunto: boolean;
  iniciada_em: string | null;
  qtd_mensagens: number;
  tem_sent_operador: boolean;
  participantes: string[];
  preview: PreviewMsg[];
}

interface Row {
  card_id: string;
  nf: string;
  contexto: "nascimento" | "card_em_espera";
  qtd_candidatos: number;
  candidatos: Candidato[];
}

interface Props {
  cardId: string;
  nf: string | null | undefined;
}

/**
 * Painel "TRATATIVA DETECTADA EM OUTRA THREAD · NÃO CONFIRMADA" exibido no
 * topo da aba MENSAGENS quando v_email_preexistente retorna contexto =
 * 'card_em_espera'. Reusa o EmailThread (mesmos balões) — visualmente
 * diferenciado por borda âmbar tracejada e tag NÃO CONFIRMADA.
 */
export function PainelTratativaDetectada({ cardId, nf }: Props) {
  const qc = useQueryClient();
  const [validado, setValidado] = useState(false);
  const [adotado, setAdotado] = useState(false);
  const [acao, setAcao] = useState<"seguir" | "descartar" | null>(null);

  const { data } = useQuery({
    queryKey: ["v_email_preexistente", cardId],
    enabled: !!cardId && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_email_preexistente")
        .select("*")
        .eq("card_id", cardId)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Row | null;
    },
  });

  if (!data || data.contexto !== "card_em_espera") return null;
  const cand = [...(data.candidatos ?? [])].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  )[0];
  if (!cand) return null;

  function invalidar() {
    qc.invalidateQueries({ queryKey: ["v_email_preexistente", cardId] });
  }

  async function handleSeguir() {
    if (!supabase || !validado || acao) return;
    setAcao("seguir");
    const { data: ret, error } = await supabase.rpc("adotar_thread_preexistente", {
      p_card_id: cardId,
      p_gmail_thread_id: cand.gmail_thread_id,
    });
    setAcao(null);
    if (error || !(ret as { ok?: boolean })?.ok) {
      toast.error(
        error?.message ??
          (ret as { error?: string })?.error ??
          "Erro ao adotar thread",
      );
      return;
    }
    toast.success("Importando a conversa… (até ~2 min)");
    setAdotado(true);
  }

  async function handleDescartar() {
    if (!supabase || acao) return;
    setAcao("descartar");
    const { error } = await supabase.rpc("descartar_email_preexistente", {
      p_card_id: cardId,
    });
    setAcao(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.info("Painel descartado — card segue aguardando cliente.");
    invalidar();
  }

  // Converte preview[] em mensagens p/ o EmailThread (mesmos balões).
  const messages: EmailThreadMessage[] = (cand.preview ?? []).map((m, i) => {
    const isInbound = m.direcao === "inbound";
    const email = isInbound
      ? (m.de ?? "cliente@desconhecido")
      : "relacionamento@salexpress.com.br";
    return {
      id: `prev-${i}`,
      fromEmail: email,
      fromName: isInbound ? (m.de ?? "Cliente") : "Sal·Express",
      body: m.snippet ?? "",
      date: m.ts ?? new Date().toISOString(),
      side: isInbound ? "cli" : "sal",
    };
  });

  if (adotado) {
    return (
      <div className="mb-4 border-2 border-dashed border-amber-500 bg-amber-50 px-4 py-4">
        <div className="font-mono text-[11px] uppercase tracking-widest text-amber-900 animate-pulse">
          Importando a conversa… (~2 min) — em seguida os balões reais aparecerão abaixo.
        </div>
      </div>
    );
  }

  return (
    <section className="mb-5 border-2 border-dashed border-amber-500 bg-amber-50/40">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-dashed border-amber-400 bg-amber-100/60 px-4 py-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 font-display text-[13px] font-semibold uppercase tracking-wider text-amber-900">
            <MailQuestion className="h-4 w-4 shrink-0" />
            📨 Tratativa detectada em outra thread
            <span className="ml-1 inline-flex items-center border border-amber-600 bg-amber-200 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-amber-900">
              Não confirmada
            </span>
          </h4>
          <p className="mt-1 font-display text-[12px] italic text-amber-900/80">
            O cliente/base respondeu numa conversa separada da que notificamos. Confirme
            se é da NF{" "}
            <span className="font-mono not-italic font-bold">{nf ?? data.nf}</span>.
          </p>
          <div className="mt-1.5 text-[12px] text-ink">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              Assunto:
            </span>{" "}
            <strong>{cand.assunto || "(sem assunto)"}</strong>
          </div>
          {cand.participantes.length > 0 && (
            <div className="text-[12px] text-ink">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                Participantes:
              </span>{" "}
              <span className="font-mono text-[11px]">
                {cand.participantes.join(", ")}
              </span>
            </div>
          )}
        </div>
      </header>

      <div className="px-4 py-4">
        {messages.length > 0 ? (
          <EmailThread messages={messages} />
        ) : (
          <div className="font-display text-[12px] italic text-ink-soft">
            Sem prévia de mensagens.
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-amber-400 bg-amber-100/60 px-4 py-3">
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-amber-900">
          <input
            type="checkbox"
            checked={validado}
            onChange={(e) => setValidado(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-amber-600"
          />
          <span>
            Confirmo que é do cliente e da NF{" "}
            <span className="font-mono font-bold">{nf ?? data.nf}</span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSeguir}
            disabled={!validado || acao !== null}
            className="border-2 border-ink bg-amber-600 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-paper hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {acao === "seguir" ? "..." : "✓ Seguir nesta thread"}
          </button>
          <button
            type="button"
            onClick={handleDescartar}
            disabled={acao !== null}
            className="border-2 border-amber-700 bg-white px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-900 hover:bg-amber-100 disabled:opacity-40"
          >
            {acao === "descartar" ? "..." : "Não é verdadeira / descartar"}
          </button>
        </div>
      </footer>
    </section>
  );
}
