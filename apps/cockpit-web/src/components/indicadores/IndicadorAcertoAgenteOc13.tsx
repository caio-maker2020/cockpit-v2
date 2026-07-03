import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { IndicadorCard } from "./IndicadorCard";

type MetricaRow = {
  dia: string;
  operador: string | null;
  tipo_decisao_ia: "autonoma" | "sugerir_54_email" | "operador_antecipou";
  total_decisoes: number;
  total_autonomas: number;
  autonomas_corrigidas: number;
  total_sugestoes: number;
  sugestoes_corrigidas: number;
  pct_acerto_ia: number | null;
};

type FeedbackRow = {
  tipo_feedback: string;
  motivo_correcao: string | null;
  decisao_correta_codigo_ssw: number | null;
  corrigido_por_nome: string | null;
  corrigido_em: string;
  card_id: string;
  cards: { nf: string | null; responsavel_relacionamento: string | null } | null;
};

const TIPO_FEEDBACK_LABELS: Record<string, string> = {
  autonoma_errada: "Autônoma errada",
  sugestao_errada_explicita: "Sugestão errada (operador clicou)",
  sugestao_errada_implicita: "Sugestão errada (operador aprovou outra)",
};

type PeriodoKey = "7d" | "30d" | "Tudo";

function dataInicioISO(p: PeriodoKey): string {
  if (p === "Tudo") return "2026-01-01";
  const dias = p === "7d" ? 7 : 30;
  return new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);
}

export function IndicadorAcertoAgenteOc13() {
  const [periodo, setPeriodo] = useState<PeriodoKey>("7d");
  const [operador, setOperador] = useState<string>("Todos");
  const [motivosAbertos, setMotivosAbertos] = useState(false);
  const [tabelaAberta, setTabelaAberta] = useState(false);

  const dataInicio = dataInicioISO(periodo);

  const { data: rows } = useQuery({
    queryKey: ["agente-oc13-metricas", dataInicio],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_agente_oc13_metricas")
        .select("*")
        .gte("dia", dataInicio)
        .order("dia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MetricaRow[];
    },
  });

  const { data: motivos } = useQuery({
    queryKey: ["agente-oc13-feedback", dataInicio],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("agente_oc13_feedback")
        .select(
          "tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_por_nome, corrigido_em, card_id, cards(nf, responsavel_relacionamento)",
        )
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
      (rows ?? []).filter((r) =>
        operador === "Todos" ? true : r.operador === operador,
      ),
    [rows, operador],
  );

  const totalDecisoes = filtradas.reduce((a, r) => a + r.total_decisoes, 0);
  const totalAutonomas = filtradas.reduce((a, r) => a + r.total_autonomas, 0);
  const autonomasCorrigidas = filtradas.reduce(
    (a, r) => a + r.autonomas_corrigidas,
    0,
  );
  const totalSugestoes = filtradas.reduce((a, r) => a + r.total_sugestoes, 0);
  const sugestoesCorrigidas = filtradas.reduce(
    (a, r) => a + r.sugestoes_corrigidas,
    0,
  );
  const totalCorrigidas = autonomasCorrigidas + sugestoesCorrigidas;
  const pctAcerto =
    totalDecisoes > 0
      ? Math.round(100 * (1 - totalCorrigidas / totalDecisoes) * 10) / 10
      : null;

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
      nome="acerto_agente_oc13"
      icone="🎯"
      titulo="Acerto Agente IA oc=13"
      subtitulo="Mede quantas decisões da IA (autônomas e sugestões) o operador corrigiu via botão 'IA errou'."
      resumoHeader={
        semDados ? (
          <span>Sem dados ainda — agente recém-deployado.</span>
        ) : (
          <span>
            % acerto: <strong className={corPct}>{pctAcerto != null ? `${pctAcerto}%` : "—"}</strong>
            {" · "}
            {totalDecisoes} decisões, {totalCorrigidas} corrigidas ({periodo})
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
      </div>

      {semDados ? (
        <div className="border border-dashed border-ink/30 bg-paper-deep/30 p-6 text-center text-[12px] text-ink-soft">
          Sem dados ainda — agente ativo há poucas horas. Volte em breve.
        </div>
      ) : (
        <>
          {/* 3 cards */}
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumCard
              label="% ACERTO"
              valor={pctAcerto != null ? `${pctAcerto}%` : "—"}
              valorClass={corPct}
              hint={`Total decisões: ${totalDecisoes}. Corrigidas: ${totalCorrigidas}.`}
            />
            <NumCard
              label="AUTÔNOMAS"
              valor={`${totalAutonomas} / ${autonomasCorrigidas}`}
              subtitulo="Lançadas autônomas / Corrigidas"
            />
            <NumCard
              label="SUGESTÕES"
              valor={`${totalSugestoes} / ${sugestoesCorrigidas}`}
              subtitulo="Recomendadas / Operador escolheu outra"
            />
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
                      {(m.corrigido_por_nome ?? "—")},{" "}
                      {TIPO_FEEDBACK_LABELS[m.tipo_feedback] ?? m.tipo_feedback},{" "}
                      {format(new Date(m.corrigido_em), "dd/MM HH:mm", {
                        locale: ptBR,
                      })}
                    </div>
                    <div className="font-mono text-[10px] text-ink-soft">
                      NF {m.cards?.nf ?? "—"} → operador sugeriu oc={" "}
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
                      <th className="py-1 pr-3">Operador</th>
                      <th className="py-1 pr-3">Autônomas</th>
                      <th className="py-1 pr-3">Corrigidas</th>
                      <th className="py-1 pr-3">Sugestões</th>
                      <th className="py-1 pr-3">Corrigidas</th>
                      <th className="py-1">% acerto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtradas.slice(0, 30).map((r, i) => (
                      <tr
                        key={i}
                        className="border-b border-ink/10 text-ink"
                      >
                        <td className="py-1 pr-3 font-mono">{r.dia}</td>
                        <td className="py-1 pr-3">{r.operador ?? "—"}</td>
                        <td className="py-1 pr-3 tabular-nums">
                          {r.total_autonomas}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {r.autonomas_corrigidas}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {r.total_sugestoes}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">
                          {r.sugestoes_corrigidas}
                        </td>
                        <td className="py-1 tabular-nums">
                          {r.pct_acerto_ia != null ? `${r.pct_acerto_ia}%` : "—"}
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
    <div
      title={hint}
      className="border border-ink/15 bg-paper p-3 text-center"
    >
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
