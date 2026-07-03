import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Link2, Mail } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { useModoFoco } from "@/hooks/useModoFoco";

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

interface EmailPreexistenteRow {
  card_id: string;
  nf: string;
  state: string;
  assigned_operator_id: string;
  detectado_em: string;
  qtd_candidatos: number;
  contexto: "nascimento" | "card_em_espera";
  candidatos: Candidato[];
}

interface Props {
  cardId: string;
  nf: string | null | undefined;
  cardCreatedAt: string | null | undefined;
}

function fmtData(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  } catch {
    return "—";
  }
}

function CandidatoCard({
  cand,
  nf,
  cardCreatedAt,
  cardId,
  onAdotado,
  destacado,
}: {
  cand: Candidato;
  nf: string;
  cardCreatedAt: string | null | undefined;
  cardId: string;
  onAdotado: () => void;
  destacado: boolean;
}) {
  const [validado, setValidado] = useState(false);
  const [seguindo, setSeguindo] = useState(false);

  const antesDoCard =
    cand.iniciada_em &&
    cardCreatedAt &&
    new Date(cand.iniciada_em).getTime() < new Date(cardCreatedAt).getTime();

  const confianca = cand.nf_no_assunto ? "alta" : "média";

  async function handleSeguir() {
    if (!supabase || !validado || seguindo) return;
    setSeguindo(true);
    const { data, error } = await supabase.rpc("adotar_thread_preexistente", {
      p_card_id: cardId,
      p_gmail_thread_id: cand.gmail_thread_id,
    });
    setSeguindo(false);
    if (error || !(data as { ok?: boolean })?.ok) {
      toast.error(
        error?.message ??
          (data as { error?: string })?.error ??
          "Erro ao adotar thread",
      );
      return;
    }
    toast.success("Importando a conversa… (até ~2 min)");
    onAdotado();
  }

  return (
    <div
      className={
        destacado
          ? "border-2 border-indigo-500 bg-white px-3 py-2.5"
          : "border border-indigo-300 bg-white/70 px-3 py-2.5"
      }
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="border border-indigo-400 bg-indigo-50 px-1.5 py-0.5 font-mono font-bold uppercase tracking-wider text-indigo-800">
          confiança {confianca}
        </span>
        {antesDoCard && (
          <span className="border border-indigo-400 bg-indigo-50 px-1.5 py-0.5 font-mono uppercase tracking-wider text-indigo-800">
            iniciada antes do card
          </span>
        )}
        {cand.tem_sent_operador && (
          <span className="border border-good bg-good/10 px-1.5 py-0.5 font-mono uppercase tracking-wider text-good">
            ✓ você já respondeu
          </span>
        )}
      </div>

      <div className="mt-1.5 text-[12.5px] leading-snug text-ink">
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
        <div className="mt-0.5 font-mono text-[11px] text-ink-soft">
          {cand.qtd_mensagens} mensage{cand.qtd_mensagens === 1 ? "m" : "ns"} ·
          iniciada em {fmtData(cand.iniciada_em)}
        </div>
      </div>

      {cand.preview?.length > 0 && (
        <div className="mt-2 border-l-2 border-indigo-200 pl-2">
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            ▸ Prévia
          </div>
          <ul className="mt-1 space-y-1">
            {cand.preview.slice(0, 4).map((m, i) => (
              <li key={i} className="text-[11.5px] leading-snug text-ink">
                <span className="font-mono text-ink-mute">
                  {m.direcao === "inbound" ? "⟵" : "⟶"}{" "}
                  {m.direcao === "inbound" ? m.de ?? "—" : "você"}
                </span>{" "}
                <span className="text-ink-soft">"{m.snippet}"</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11.5px] text-ink">
        <input
          type="checkbox"
          checked={validado}
          onChange={(e) => setValidado(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 accent-indigo-600"
        />
        <span>
          Confirmo que este e-mail é da NF{" "}
          <span className="font-mono font-bold">{nf}</span>
        </span>
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSeguir}
          disabled={!validado || seguindo}
          className="border-2 border-ink bg-indigo-600 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-paper hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {seguindo ? "..." : "✓ Seguir nesta thread"}
        </button>
      </div>
    </div>
  );
}

export function BannerEmailPreexistente({ cardId, nf, cardCreatedAt }: Props) {
  const qc = useQueryClient();
  const [modoFoco] = useModoFoco();
  const [overrideExpanded, setOverrideExpanded] = useState<boolean | null>(null);
  const [verOutras, setVerOutras] = useState(false);
  const [acaoSecundaria, setAcaoSecundaria] = useState<"novo" | "depois" | null>(
    null,
  );
  const [adotado, setAdotado] = useState(false);

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
      return data as unknown as EmailPreexistenteRow | null;
    },
  });

  const candidatos = useMemo(
    () =>
      [...(data?.candidatos ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    [data],
  );

  if (!data || candidatos.length === 0) return null;
  // Variante card_em_espera é renderizada por <AvisoRespostaOutraThread/> dentro
  // da aba de RESPOSTA. Esse banner cobre só o contexto 'nascimento' (topo do card).
  if (data.contexto && data.contexto !== "nascimento") return null;

  const collapsed = overrideExpanded == null ? modoFoco : !overrideExpanded;
  const principal = candidatos[0];
  const outras = candidatos.slice(1);

  function invalidar() {
    qc.invalidateQueries({ queryKey: ["v_email_preexistente", cardId] });
  }

  async function handleDescartar() {
    if (!supabase) return;
    setAcaoSecundaria("novo");
    const { error } = await supabase.rpc("descartar_email_preexistente", {
      p_card_id: cardId,
    });
    setAcaoSecundaria(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sugestão descartada — siga compondo um e-mail novo.");
    invalidar();
  }

  async function handleDepois() {
    if (!supabase) return;
    setAcaoSecundaria("depois");
    const { error } = await supabase.rpc("marcar_email_preexistente_visto", {
      p_card_id: cardId,
    });
    setAcaoSecundaria(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.info("Ok — vamos te lembrar no próximo scan.");
    invalidar();
  }

  if (adotado) {
    return (
      <div className="mx-6 mt-3 flex items-center gap-3 border-l-[3px] border-indigo-500 bg-indigo-50 px-3 py-2 text-[12px] text-indigo-900">
        <Mail className="h-4 w-4 shrink-0 animate-pulse" />
        <span className="font-mono text-[11px] uppercase tracking-wider">
          Importando a conversa… (até ~2 min) — a thread vai aparecer na aba MENSAGENS.
        </span>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="mx-6 mt-3 flex items-center gap-3 border-l-[3px] border-indigo-500 bg-indigo-50 px-3 py-2">
        <Link2 className="h-4 w-4 shrink-0 text-indigo-600" />
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-wider text-indigo-900">
          🔗 E-mail anterior do cliente sobre a NF{" "}
          <strong>{nf ?? data.nf}</strong>
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
          aria-label="Expandir banner de e-mail anterior"
          onClick={() => setOverrideExpanded(true)}
          className="text-indigo-700 hover:text-indigo-900"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="mx-6 mt-3 border-l-[3px] border-indigo-500 bg-indigo-50/70 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-[14px] font-semibold uppercase tracking-wider text-indigo-900">
          <Link2 className="h-4 w-4" />
          🔗 Encontramos um e-mail anterior desse cliente sobre essa NF
        </h3>
        <button
          type="button"
          aria-label="Recolher banner"
          onClick={() => setOverrideExpanded(false)}
          className="shrink-0 text-indigo-700 hover:text-indigo-900"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2">
        <CandidatoCard
          cand={principal}
          nf={nf ?? data.nf}
          cardCreatedAt={cardCreatedAt}
          cardId={cardId}
          onAdotado={() => setAdotado(true)}
          destacado
        />
      </div>

      {outras.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setVerOutras((v) => !v)}
            className="font-mono text-[10px] uppercase tracking-widest text-indigo-700 underline hover:text-indigo-900"
          >
            {verOutras
              ? "esconder outras tratativas"
              : `ver outras ${outras.length} tratativa${outras.length === 1 ? "" : "s"}`}
          </button>
          {verOutras && (
            <div className="mt-2 space-y-2">
              {outras.map((c) => (
                <CandidatoCard
                  key={c.gmail_thread_id}
                  cand={c}
                  nf={nf ?? data.nf}
                  cardCreatedAt={cardCreatedAt}
                  cardId={cardId}
                  onAdotado={() => setAdotado(true)}
                  destacado={false}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-indigo-200 pt-2.5">
        <button
          type="button"
          onClick={handleDescartar}
          disabled={acaoSecundaria !== null}
          className="border-2 border-indigo-600 bg-white px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-indigo-800 hover:bg-indigo-50 disabled:opacity-40"
        >
          {acaoSecundaria === "novo" ? "..." : "Abrir e-mail novo"}
        </button>
        <button
          type="button"
          onClick={handleDepois}
          disabled={acaoSecundaria !== null}
          className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-indigo-700 hover:text-indigo-900 disabled:opacity-40"
        >
          {acaoSecundaria === "depois" ? "..." : "Depois"}
        </button>
      </div>
    </div>
  );
}
