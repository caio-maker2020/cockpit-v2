// =============================================================================
// EstadoTratativaCard — a MEMÓRIA do card como FAIXA de 2 linhas (v2 validada
// pelo Caio 18/09: "está muito poluído" → fechada por padrão, uma frase +
// quem segura + há quanto tempo; TUDO o mais vive dentro do "detalhes").
// Renderiza SÓ quando cards.estado_tratativa existe (F1 populou).
// Ações do operador NUNCA editam o jsonb: viram card_events
// (EstadoCorrigidoPeloOperador / InformacaoExternaRegistrada) → trigger marca
// dirty → worker recomputa. Realtime de cards já re-renderiza.
// =============================================================================
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { Chip } from "@/components/cockpit/Chip";
import type { CardRow } from "@/lib/types";

interface Fato {
  id: string; fato: string; detalhe: string; tipo: string;
  fonte: { tipo: string; ref: string }; origem: string; em: string;
}
interface EstadoTratativa {
  schema_v: number; rev: number;
  situacao: string;
  ciclo_atual: { n: number; total: number };
  resumo: string | null;
  fatos_confirmados: Fato[];
  ja_feito_no_ciclo: Array<{ codigo_oc: number | null; em: string; resultado: string }>;
  aguardando: { quem: string; o_que: string; desde: string } | null;
  pendencias_dossie: string[];
  alertas: string[];
  atualizado_em: string;
}

const QUEM_ROTULO: Record<string, string> = {
  cliente: "o cliente",
  area_interna: "a área interna",
  operador: "o operador",
  ninguem: "ninguém",
};
const FONTE_ICONE: Record<string, string> = {
  ssw: "🚚", email: "✉", anexo: "📎", operador: "👤", sistema: "⚙",
};
const dt = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}` : "—";
const haQuanto = (iso: string): string => {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return "há menos de 1h";
  if (h < 48) return `há ${Math.round(h)}h`;
  return `há ${Math.round(h / 24)} dias`;
};

export default function EstadoTratativaCard({ card }: { card: CardRow }) {
  const estado = (card as unknown as { estado_tratativa?: EstadoTratativa | null }).estado_tratativa;
  const { operador } = useAuth();
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [infoAberta, setInfoAberta] = useState(false);
  const [infoTexto, setInfoTexto] = useState("");
  const [salvando, setSalvando] = useState(false);

  if (!estado || estado.schema_v !== 1) return null;

  // fix NF 1558007 (Caio 18/09): "oc55_sem_reentrega_aberta" virou flag interna
  // da cerca; estados antigos ainda a trazem em alertas — nunca exibir.
  const alertasVisiveis = estado.alertas.filter(
    (a) => a !== "oc55_sem_reentrega_aberta",
  );

  // frase da faixa: resumo do Haiku, ou fallback determinístico curto
  const frase = estado.resumo ??
    (estado.ja_feito_no_ciclo.length > 0
      ? `Neste ciclo já foi lançada a oc ${estado.ja_feito_no_ciclo[0]!.codigo_oc}.`
      : "Nenhuma ação executada neste ciclo ainda.");
  const espera = estado.aguardando
    ? `⏳ com ${QUEM_ROTULO[estado.aguardando.quem] ?? estado.aguardando.quem} ${haQuanto(estado.aguardando.desde)}`
    : null;

  const evento = async (event_type: string, payload: Record<string, unknown>, msg: string) => {
    if (!supabase || !operador) return;
    setSalvando(true);
    const { error } = await supabase.from("card_events").insert({
      card_id: card.id, event_type, event_version: 1,
      actor_type: "operator", actor_id: operador.id, payload,
    });
    setSalvando(false);
    if (error) { toast.error(error.message); return; }
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: ["card", card.id] });
  };

  return (
    <section className="mx-6 mt-3 rounded-[10px] border border-rule bg-paper">
      {/* faixa fechada: 2 linhas, sem chips, sem botões — só a frase */}
      <div className="flex items-start gap-2.5 px-3.5 py-2">
        <span className="text-[13px] leading-relaxed text-signal">✦</span>
        <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">
          {frase}
          {espera && <span className="ml-1.5 text-ink-mute">{espera}</span>}
        </span>
        <button
          type="button"
          className="shrink-0 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-mute hover:text-sal"
          onClick={() => setAberto((v) => !v)}
        >
          {aberto ? "fechar ▴" : "detalhes ▾"}
        </button>
      </div>

      {aberto && (
        <div className="border-t border-rule px-3.5 py-2.5">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
                Já feito neste ciclo ({estado.ciclo_atual.n}/{estado.ciclo_atual.total})
              </div>
              <ul className="mt-1 space-y-0.5">
                {estado.ja_feito_no_ciclo.length === 0 && (
                  <li className="text-[12.5px] text-ink-mute">nada ainda</li>
                )}
                {estado.ja_feito_no_ciclo.slice(0, 5).map((a, i) => (
                  <li key={i} className="text-[12.5px] text-ink-2">
                    <span className="font-mono font-semibold">oc {a.codigo_oc}</span>
                    <span className="text-ink-mute"> · {dt(a.em)} · {a.resultado}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-mute">
                Fatos (passe o mouse pra corrigir)
              </div>
              <ul className="mt-1 space-y-0.5">
                {estado.fatos_confirmados.slice(0, 6).map((f) => (
                  <li key={f.id} className="group flex items-start gap-1 text-[12.5px] text-ink-2">
                    <span title={`fonte: ${f.fonte.tipo} (${f.fonte.ref})`}>{FONTE_ICONE[f.fonte.tipo] ?? "•"}</span>
                    <span className="min-w-0 flex-1">
                      {f.detalhe}
                      {f.origem === "llm" && <span className="ml-1 font-mono text-[9px] uppercase text-ink-mute">(ia)</span>}
                    </span>
                    <button
                      type="button"
                      title="Remover este fato (correção)"
                      className="invisible font-mono text-[10px] text-signal group-hover:visible"
                      disabled={salvando}
                      onClick={() =>
                        void evento("EstadoCorrigidoPeloOperador",
                          { op: "remover_fato", fato_id: f.id, motivo: "corrigido pelo operador no card" },
                          "Fato removido — a memória recalcula em instantes.")}
                    >
                      ✕
                    </button>
                  </li>
                ))}
                {estado.fatos_confirmados.length === 0 && (
                  <li className="text-[12.5px] text-ink-mute">nenhum fato registrado</li>
                )}
              </ul>
            </div>
          </div>

          {(estado.pendencias_dossie.length > 0 || alertasVisiveis.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {estado.pendencias_dossie.map((p) => (
                <Chip key={p} tone="warning">{p.replace(/_/g, " ")}</Chip>
              ))}
              {alertasVisiveis.map((a) => (
                <Chip key={a} tone="crit">{a.replace(/_/g, " ")}</Chip>
              ))}
            </div>
          )}

          <div className="mt-2.5">
            <button
              type="button"
              className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-mute underline underline-offset-2 hover:text-sal"
              onClick={() => setInfoAberta((v) => !v)}
            >
              {infoAberta ? "fechar" : "+ informação de fora do sistema (telefone, presencial…)"}
            </button>
            {infoAberta && (
              <div className="mt-2 flex items-start gap-2">
                <textarea
                  rows={2}
                  className="min-h-[40px] w-full rounded-[8px] border border-rule bg-paper p-2 text-[13px] text-ink-2 focus:outline-none focus:ring-2 focus:ring-ink"
                  placeholder="Ex.: liguei pra base e a mercadoria já saiu pra entrega"
                  value={infoTexto}
                  onChange={(e) => setInfoTexto(e.target.value)}
                />
                <button
                  type="button"
                  className="shrink-0 rounded-[8px] bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper transition-colors hover:bg-ink disabled:opacity-40"
                  disabled={salvando || infoTexto.trim().length < 5}
                  onClick={() => {
                    void evento("InformacaoExternaRegistrada", { texto: infoTexto.trim() },
                      "Registrado — entra na memória do card como fonte sua.");
                    setInfoTexto(""); setInfoAberta(false);
                  }}
                >
                  Registrar
                </button>
              </div>
            )}
            <span className="ml-3 font-mono text-[9px] uppercase text-ink-mute">
              atualizado {dt(estado.atualizado_em)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
