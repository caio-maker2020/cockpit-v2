import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, MailQuestion } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";

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
 * Aviso âmbar exibido ACIMA do compositor de resposta quando o backend detectou
 * uma resposta provável do cliente em OUTRA thread Gmail (contexto = 'card_em_espera').
 *
 * Ações:
 *  - Seguir nesta thread → adotar_thread_preexistente (importa histórico; o card
 *    transita para CLIENTE RESPONDEU naturalmente)
 *  - Não é verdadeira / descartar → descartar_email_preexistente (some o aviso)
 */
export function AvisoRespostaOutraThread({ cardId, nf }: Props) {
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
    toast.info("Aviso descartado — card segue aguardando cliente.");
    invalidar();
  }

  if (adotado) {
    return (
      <div className="flex items-center gap-3 border-l-[3px] border-amber-500 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
        <Mail className="h-4 w-4 shrink-0 animate-pulse" />
        <span className="font-mono text-[11px] uppercase tracking-wider">
          Importando a conversa… (~2 min) — em seguida vai aparecer aqui em MENSAGENS.
        </span>
      </div>
    );
  }

  return (
    <div className="border-l-[3px] border-amber-500 bg-amber-50 px-3 py-3">
      <h4 className="flex items-center gap-2 font-display text-[13px] font-semibold uppercase tracking-wider text-amber-900">
        <MailQuestion className="h-4 w-4" />
        📨 Detectamos uma possível resposta do cliente em outra thread
      </h4>
      <p className="mt-1 font-display text-[12px] italic text-amber-900/80">
        Confirme se é verdadeira e da NF{" "}
        <span className="font-mono not-italic font-bold">{nf ?? data.nf}</span>{" "}
        antes de seguir.
      </p>

      <div className="mt-2 border border-amber-300 bg-white/70 px-3 py-2 text-[12px] text-ink">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            Assunto:
          </span>{" "}
          <strong>{cand.assunto || "(sem assunto)"}</strong>
        </div>
        {cand.participantes.length > 0 && (
          <div className="mt-0.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              Participantes:
            </span>{" "}
            <span className="font-mono text-[11px]">
              {cand.participantes.join(", ")}
            </span>
          </div>
        )}
        {cand.preview?.length > 0 && (
          <ul className="mt-2 space-y-1 border-l-2 border-amber-200 pl-2">
            {cand.preview.slice(0, 3).map((m, i) => (
              <li key={i} className="text-[11.5px] leading-snug">
                <span className="font-mono text-ink-mute">
                  {m.direcao === "inbound" ? "⟵" : "⟶"}{" "}
                  {m.direcao === "inbound" ? m.de ?? "—" : "você"}
                </span>{" "}
                <span className="text-ink-soft">"{m.snippet}"</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11.5px] text-amber-900">
        <input
          type="checkbox"
          checked={validado}
          onChange={(e) => setValidado(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 accent-amber-600"
        />
        <span>
          Confirmo que esta thread é do cliente e da NF{" "}
          <span className="font-mono font-bold">{nf ?? data.nf}</span>
        </span>
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2">
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
    </div>
  );
}
