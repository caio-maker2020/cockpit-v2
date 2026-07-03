import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { IndicadorCard } from "./IndicadorCard";

type MetricaPadraoRow = {
  dia: string;
  codigo_oc: 10 | 11 | 19 | 35;
  operador: string | null;
  proposta_destacada: 54 | 56 | null;
  total_sugestoes: number;
  acertos_total: number;
  erros_total: number;
  sem_feedback: number;
  acertos_explicitos: number;
  acertos_implicitos: number;
  erros_explicitos: number;
  erros_implicitos: number;
  pct_acerto_ia: number | null;
  // legados
  sugestoes_corrigidas?: number;
  corrigidas_explicitas?: number;
  corrigidas_implicitas?: number;
  acertos_confirmados?: number;
};

type FeedbackRow = {
  tipo_feedback: string;
  motivo_correcao: string | null;
  decisao_correta_codigo_ssw: number | null;
  corrigido_por_nome: string | null;
  corrigido_em: string;
  card_id: string;
  codigo_oc_card: number | null;
  cards: { nf: string | null } | null;
};

const TIPO_FEEDBACK_LABELS: Record<string, string> = {
  sugestao_errada_explicita: "Sugestão errada (operador clicou)",
  sugestao_errada_implicita: "Sugestão errada (operador aprovou outra)",
};

type PeriodoKey = "7d" | "30d" | "Tudo";
type OcFiltro = "Todas" | "10" | "11" | "19" | "35";

function dataInicioISO(p: PeriodoKey): string {
  if (p === "Tudo") return "2026-01-01";
  const dias = p === "7d" ? 7 : 30;
  return new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);
}

const num = (v: unknown) => (typeof v === "number" && !isNaN(v) ? v : 0);

export function IndicadorAcertoAgenteOcsPadrao() {
  const [periodo, setPeriodo] = useState<PeriodoKey>("7d");
  const [operador, setOperador] = useState<string>("Todos");
  const [ocFiltro, setOcFiltro] = useState<OcFiltro>("Todas");
  const [motivosAbertos, setMotivosAbertos] = useState(false);
  const [tabelaAberta, setTabelaAberta] = useState(false);

  const dataInicio = dataInicioISO(periodo);

  const { data: rows } = useQuery({
    queryKey: ["agente-ocs-padrao-metricas", dataInicio],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_agente_ocs_padrao_metricas")
        .select("*")
        .gte("dia", dataInicio)
        .order("dia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MetricaPadraoRow[];
    },
  });

  const { data: motivos } = useQuery({
    queryKey: ["agente-ocs-padrao-feedback", dataInicio],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("agente_ocs_padrao_feedback")
        .select(
          "tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_por_nome, corrigido_em, card_id, codigo_oc_card, cards(nf)",
        )
        .eq("tipo_feedback", "sugestao_errada_explicita")
        .gte("corrigido_em", dataInicio)
        .not("motivo_correcao", "is", null)
        .order("corrigido_em", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as FeedbackRow[];
    },
  });

  const operadores = useMemo(() => {
    const s = new Set<string>();
    (rows ?? []).forEach((r) => r.operador && s.add(r.operador));
    return ["Todos", ...Array.from(s).sort()];
  }, [rows]);

  const filtradas = useMemo(
    () =>
      (rows ?? []).filter((r) => {
        if (operador !== "Todos" && r.operador !== operador) return false;
        if (ocFiltro !== "Todas" && String(r.codigo_oc) !== ocFiltro) return false;
        return true;
      }),
    [rows, operador, ocFiltro],
  );

  const totalSug = filtradas.reduce((a, r) => a + num(r.total_sugestoes), 0);
  const acertos = filtradas.reduce((a, r) => a + num(r.acertos_total), 0);
  const erros = filtradas.reduce((a, r) => a + num(r.erros_total), 0);
  const semFb = filtradas.reduce((a, r) => a + num(r.sem_feedback), 0);
  const acertosExpl = filtradas.reduce((a, r) => a + num(r.acertos_explicitos), 0);
  const acertosImpl = filtradas.reduce((a, r) => a + num(r.acertos_implicitos), 0);
  const errosExpl = filtradas.reduce((a, r) => a + num(r.erros_explicitos), 0);
  const errosImpl = filtradas.reduce((a, r) => a + num(r.erros_implicitos), 0);

  const decisoes = acertos + erros;
  const pctAcerto =
    decisoes > 0 ? Math.round((1000 * acertos) / decisoes) / 10 : null;

  // Por grupo de OC (10+35 = RECUSA)
  const porOc = useMemo(() => {
    const acc: Record<string, { sug: number; acerto: number; erro: number }> = {
      recusa: { sug: 0, acerto: 0, erro: 0 },
      "19": { sug: 0, acerto: 0, erro: 0 },
      "11": { sug: 0, acerto: 0, erro: 0 },
    };
    filtradas.forEach((r) => {
      const key =
        r.codigo_oc === 10 || r.codigo_oc === 35 ? "recusa" : String(r.codigo_oc);
      if (!acc[key]) acc[key] = { sug: 0, acerto: 0, erro: 0 };
      acc[key].sug += num(r.total_sugestoes);
      acc[key].acerto += num(r.acertos_total);
      acc[key].erro += num(r.erros_total);
    });
    return acc;
  }, [filtradas]);

  const semDados = (rows ?? []).length === 0;

  const corPct =
    pctAcerto == null
      ? "text-ink-soft"
      : pctAcerto >= 90
        ? "text-emerald-600"
        : pctAcerto >= 70
          ? "text-amber-600"
          : "text-red-600";

  const motivosTop = (motivos ?? []).slice(0, 10);

  return (
    <IndicadorCard
      nome="acerto_agente_ocs_padrao"
      icone="🎯"
      titulo="Acerto Agente IA — Ocs Padrão (10/11/19/35)"
      subtitulo="Mede quantas sugestões da IA (oc=54+template ou oc=56) o operador corrigiu via 'IA errou' ou aprovando outra."
      resumoHeader={
        semDados ? (
          <span>Sem dados ainda — agente recém-deployado.</span>
        ) : (
          <span>
            % acerto:{" "}
            <strong className={corPct}>
              {pctAcerto != null ? `${pctAcerto.toFixed(1)}%` : "—"}
            </strong>
            {" · "}
            {totalSug} sugestões, {erros} erros, {semFb} sem decisão ({periodo})
          </span>
        )
      }
    >
      {/* Filtros */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            Período:
          </span>
          {(["7d", "30d", "Tudo"] as PeriodoKey[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriodo(p)}
              className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                periodo === p
                  ? "border-ink bg-ink text-paper"
                  : "border-ink/30 bg-paper text-ink hover:border-ink"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            Operador:
          </span>
          <select
            value={operador}
            onChange={(e) => setOperador(e.target.value)}
            className="border border-ink/30 bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          >
            {operadores.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            OC:
          </span>
          {(["Todas", "10", "11", "19", "35"] as OcFiltro[]).map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setOcFiltro(o)}
              className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                ocFiltro === o
                  ? "border-ink bg-ink text-paper"
                  : "border-ink/30 bg-paper text-ink hover:border-ink"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      {semDados ? (
        <div className="border border-dashed border-ink/30 bg-paper-deep/30 p-6 text-center text-[12px] text-ink-soft">
          Sem dados ainda — agente ativo há poucas horas. Volte em breve.
        </div>
      ) : (
        <>
          {/* 4 cards */}
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumCard
              label="% ACERTO"
              valor={pctAcerto != null ? `${pctAcerto.toFixed(1)}%` : "—"}
              valorClass={corPct}
              hint={`Decisões: ${decisoes} (acertos ${acertos} + erros ${erros}). Pendentes: ${semFb}.`}
            />
            <NumCard
              label="oc=10/35 (RECUSA)"
              valor={`${porOc.recusa.sug} / ${porOc.recusa.erro}`}
              subtitulo="sug / err"
            />
            <NumCard
              label="oc=19 (FALTA VOL)"
              valor={`${porOc["19"].sug} / ${porOc["19"].erro}`}
              subtitulo="sug / err"
            />
            <NumCard
              label="oc=11 (ENDEREÇO)"
              valor={`${porOc["11"].sug} / ${porOc["11"].erro}`}
              subtitulo="sug / err"
            />
          </div>

          {/* Detalhe acertos/erros */}
          <div className="mb-4 border-l-2 border-ink/15 pl-3 text-[11px] text-ink-soft">
            Detalhe: {acertosExpl} acertos explícitos (👍) · {acertosImpl} acertos
            implícitos
            <br />
            {errosExpl} erros explícitos (👎) · {errosImpl} erros implícitos
          </div>

          {/* Top motivos */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setMotivosAbertos((v) => !v)}
              className="flex w-full items-center justify-between border-b border-ink/15 pb-1 text-left"
            >
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                Top motivos de correção ({motivosTop.length})
              </span>
              {motivosAbertos ? (
                <ChevronUp className="h-3 w-3 text-ink-soft" />
              ) : (
                <ChevronDown className="h-3 w-3 text-ink-soft" />
              )}
            </button>
            {motivosAbertos && (
              <ul className="mt-2 space-y-2">
                {motivosTop.length === 0 && (
                  <li className="text-[11px] italic text-ink-soft">
                    Nenhuma correção textual no período.
                  </li>
                )}
                {motivosTop.map((m, i) => (
                  <li
                    key={i}
                    className="border-l-2 border-amber-400 bg-amber-50/40 p-2 text-[12px] text-ink"
                  >
                    <div className="italic">"{m.motivo_correcao}"</div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                      {(m.corrigido_por_nome ?? "—")}, oc={m.codigo_oc_card ?? "—"},{" "}
                      {TIPO_FEEDBACK_LABELS[m.tipo_feedback] ?? m.tipo_feedback},{" "}
                      {format(new Date(m.corrigido_em), "dd/MM HH:mm", {
                        locale: ptBR,
                      })}
                    </div>
                    <div className="font-mono text-[10px] text-ink-soft">
                      NF {m.cards?.nf ?? "—"} → operador escolheu: oc={" "}
                      {m.decisao_correta_codigo_ssw ?? "(outro — texto livre)"}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Tabela detalhada */}
          <div>
            <button
              type="button"
              onClick={() => setTabelaAberta((v) => !v)}
              className="flex w-full items-center justify-between border-b border-ink/15 pb-1 text-left"
            >
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                Tabela detalhada ({filtradas.length} linhas)
              </span>
              {tabelaAberta ? (
                <ChevronUp className="h-3 w-3 text-ink-soft" />
              ) : (
                <ChevronDown className="h-3 w-3 text-ink-soft" />
              )}
            </button>
            {tabelaAberta && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-ink/15 text-left font-mono uppercase tracking-wider text-ink-soft">
                      <th className="py-1 pr-3">Dia</th>
                      <th className="py-1 pr-3">OC</th>
                      <th className="py-1 pr-3">Operador</th>
                      <th className="py-1 pr-3">Destaque</th>
                      <th className="py-1 pr-3">Total</th>
                      <th className="py-1 pr-3">Acerto</th>
                      <th className="py-1 pr-3">Erro</th>
                      <th className="py-1 pr-3">Pend.</th>
                      <th className="py-1">% acerto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtradas.slice(0, 30).map((r, i) => (
                      <tr key={i} className="border-b border-ink/10 text-ink">
                        <td className="py-1 pr-3 font-mono">{r.dia}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.codigo_oc}</td>
                        <td className="py-1 pr-3">{r.operador ?? "—"}</td>
                        <td className="py-1 pr-3 tabular-nums">
                          {r.proposta_destacada ?? "—"}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {num(r.total_sugestoes)}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {num(r.acertos_total)}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {num(r.erros_total)}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {num(r.sem_feedback)}
                        </td>
                        <td className="py-1 tabular-nums">
                          {r.pct_acerto_ia != null
                            ? `${Number(r.pct_acerto_ia).toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </IndicadorCard>
  );
}

function NumCard({
  label,
  valor,
  subtitulo,
  hint,
  valorClass,
}: {
  label: string;
  valor: string;
  subtitulo?: string;
  hint?: string;
  valorClass?: string;
}) {
  return (
    <div title={hint} className="border border-ink/15 bg-paper p-3 text-center">
      <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-ink-soft">
        {label}
      </div>
      <div
        className={`mt-1 font-display text-[24px] font-bold leading-none ${valorClass ?? "text-ink"}`}
      >
        {valor}
      </div>
      {subtitulo && (
        <div className="mt-1 text-[10px] text-ink-soft">{subtitulo}</div>
      )}
    </div>
  );
}
