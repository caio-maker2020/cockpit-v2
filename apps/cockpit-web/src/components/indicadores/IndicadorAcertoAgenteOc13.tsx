import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ChevronDown, ChevronUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { IndicadorCard } from "./IndicadorCard";

/* ============================================================================
 * Acerto do agente-oc13 — lê o PLACAR OFICIAL (`v_placar_agente`, mig 338,
 * fonte única `agent_feedback`), filtrado por agent_name.
 *
 * INV-174 (Caio 2026-10-08): a view legada `v_agente_oc13_metricas` (mig 149)
 * filtrava `cards.cod_ultima_ocorrencia = 13` — o card sai da 13 no instante
 * em que o operador age, então a view devolvia 0 linhas (144 cards analisados
 * em 30 dias, nenhum ainda na 13) e o indicador mostrava "sem dados" com 121
 * pares gravados em setembro. O componente ainda lia colunas renomeadas na
 * mig 158 (`*_corrigidas` → `*_erradas`), o que daria NaN mesmo com linhas.
 * A view legada foi dropada (mig 415). Nenhum número é calculado aqui — só
 * soma o que o placar já consolidou.
 * ========================================================================== */

const AGENT_NAME = "agente-oc13-autonomo";

type PlacarRow = {
  dia: string;
  agent_name: string;
  fatia_oc_sugerida: number | null;
  modo: string | null;
  seguidas: number;
  corrigidas: number;
  abstencoes: number;
  pares: number;
  pct_acerto: number | null;
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
  sugestao_certa_explicita: "Sugestão certa (operador clicou)",
  sugestao_certa_implicita: "Sugestão seguida",
};

const FATIA_LABELS: Record<string, string> = {
  "21": "oc=21 + cancelar",
  "54": "oc=54 + e-mail",
  "56": "oc=56",
};

type PeriodoKey = "7d" | "30d" | "Tudo";

function dataInicioISO(p: PeriodoKey): string {
  if (p === "Tudo") return "2026-01-01";
  const dias = p === "7d" ? 7 : 30;
  return new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);
}

function pct(seguidas: number, pares: number): number | null {
  return pares > 0 ? Math.round((1000 * seguidas) / pares) / 10 : null;
}

export function IndicadorAcertoAgenteOc13() {
  const [periodo, setPeriodo] = useState<PeriodoKey>("30d");
  const [fatia, setFatia] = useState<string>("Todas");
  const [motivosAbertos, setMotivosAbertos] = useState(false);
  const [tabelaAberta, setTabelaAberta] = useState(false);

  const dataInicio = dataInicioISO(periodo);

  const { data: rows } = useQuery({
    queryKey: ["placar-agente-oc13", dataInicio],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("v_placar_agente")
        .select("*")
        .eq("agent_name", AGENT_NAME)
        .gte("dia", dataInicio)
        .order("dia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PlacarRow[];
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

  const fatias = useMemo(() => {
    const s = new Set<string>();
    (rows ?? []).forEach((r) => r.fatia_oc_sugerida != null && s.add(String(r.fatia_oc_sugerida)));
    return ["Todas", ...Array.from(s).sort()];
  }, [rows]);

  const filtradas = useMemo(
    () =>
      (rows ?? []).filter((r) =>
        fatia === "Todas" ? true : String(r.fatia_oc_sugerida) === fatia,
      ),
    [rows, fatia],
  );

  const totalSeguidas = filtradas.reduce((a, r) => a + (r.seguidas ?? 0), 0);
  const totalCorrigidas = filtradas.reduce((a, r) => a + (r.corrigidas ?? 0), 0);
  const totalAbstencoes = filtradas.reduce((a, r) => a + (r.abstencoes ?? 0), 0);
  const totalPares = filtradas.reduce((a, r) => a + (r.pares ?? 0), 0);
  const pctAcerto = pct(totalSeguidas, totalPares);

  // Por fatia (a unidade de autonomia — mig 338): 21 / 54 / 56.
  const porFatia = useMemo(() => {
    const m = new Map<string, { seguidas: number; corrigidas: number; pares: number }>();
    for (const r of rows ?? []) {
      const k = r.fatia_oc_sugerida == null ? "—" : String(r.fatia_oc_sugerida);
      const cur = m.get(k) ?? { seguidas: 0, corrigidas: 0, pares: 0 };
      cur.seguidas += r.seguidas ?? 0;
      cur.corrigidas += r.corrigidas ?? 0;
      cur.pares += r.pares ?? 0;
      m.set(k, cur);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

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
      subtitulo="Das sugestões do agente (21+cancelar, 54+e-mail, 56), quantas o operador seguiu. Fonte: placar oficial (agent_feedback). Autônomas ficam fora — o agente não se autoavalia."
      resumoHeader={
        semDados ? (
          <span>Sem pares no período.</span>
        ) : (
          <span>
            % seguidas: <strong className={corPct}>{pctAcerto != null ? `${pctAcerto}%` : "—"}</strong>
            {" · "}
            {totalPares} pares, {totalCorrigidas} corrigidas ({periodo})
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
            Sugestão:
          </span>
          <select
            value={fatia}
            onChange={(e) => setFatia(e.target.value)}
            className="border border-ink/30 bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          >
            {fatias.map((f) => (
              <option key={f} value={f}>
                {f === "Todas" ? "Todas" : (FATIA_LABELS[f] ?? `oc=${f}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {semDados ? (
        <div className="border border-dashed border-ink/30 bg-paper-deep/30 p-6 text-center text-[12px] text-ink-soft">
          Nenhum par "agente sugeriu · operador agiu" no período.
        </div>
      ) : (
        <>
          {/* 3 cards */}
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumCard
              label="% SEGUIDAS"
              valor={pctAcerto != null ? `${pctAcerto}%` : "—"}
              valorClass={corPct}
              hint={`Pares: ${totalPares}. Seguidas: ${totalSeguidas}. Corrigidas: ${totalCorrigidas}.`}
            />
            <NumCard
              label="SEGUIDAS / CORRIGIDAS"
              valor={`${totalSeguidas} / ${totalCorrigidas}`}
              subtitulo="Operador lançou a oc sugerida / lançou outra"
            />
            <NumCard
              label="ABSTENÇÕES"
              valor={`${totalAbstencoes}`}
              subtitulo="Agente não opinou (fora do %)"
            />
          </div>

          {/* Por fatia */}
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {porFatia.map(([k, v]) => {
              const p = pct(v.seguidas, v.pares);
              return (
                <NumCard
                  key={k}
                  label={FATIA_LABELS[k] ?? `oc=${k}`}
                  valor={p != null ? `${p}%` : "—"}
                  subtitulo={`${v.seguidas} seguidas / ${v.corrigidas} corrigidas`}
                />
              );
            })}
          </div>

          {/* Top motivos */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setMotivosAbertos((v) => !v)}
              className="flex w-full items-center justify-between border-b border-ink/15 pb-1 text-left"
            >
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                Motivos escritos pelo operador ({motivosTop.length})
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
                      <th className="py-1 pr-3">Sugestão</th>
                      <th className="py-1 pr-3">Seguidas</th>
                      <th className="py-1 pr-3">Corrigidas</th>
                      <th className="py-1 pr-3">Abstenções</th>
                      <th className="py-1">% seguidas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtradas.slice(0, 60).map((r, i) => (
                      <tr key={i} className="border-b border-ink/10 text-ink">
                        <td className="py-1 pr-3 font-mono">{r.dia}</td>
                        <td className="py-1 pr-3">
                          {r.fatia_oc_sugerida == null
                            ? "—"
                            : (FATIA_LABELS[String(r.fatia_oc_sugerida)] ?? `oc=${r.fatia_oc_sugerida}`)}
                        </td>
                        <td className="py-1 pr-3 tabular-nums">{r.seguidas}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.corrigidas}</td>
                        <td className="py-1 pr-3 tabular-nums">{r.abstencoes}</td>
                        <td className="py-1 tabular-nums">
                          {r.pct_acerto != null ? `${r.pct_acerto}%` : "—"}
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
