import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { diasUteisFechados, JANELA_PLACAR_UTEIS } from "@/lib/aprendizadoPlacar";
import {
  agregarPlacar,
  META_ACERTO_PCT,
  vereditoDoAgente,
  type LinhaErro,
  type LinhaPlacar,
  type OcDoAgente,
  type Veredito,
} from "@/lib/placarAgentes";
import { ChevronDown } from "lucide-react";
import { SecaoDobravel } from "@/components/aprendizado/SecaoDobravel";

// Placar dos agentes (Caio 2026-08-13). Uma pergunta só: de cada 100 ações
// sugeridas, quantas o operador fez EXATAMENTE igual? Divergência vira caso do
// loop. Fatia que passa de 95% com volume vira candidata a autônoma.
//
// Didático de propósito: o erro é explicado em frase ("quando o card está em
// oc 11 e ele sugere 56, o operador faz 54"), não em par de códigos. Quem nunca
// viu a métrica precisa entender na primeira leitura.
//
// Fonte: v_placar_agente / v_placar_agente_erros (mig 338). Sem a migration, o
// componente se cala em vez de quebrar a aba.

const AGENTE_AMIGAVEL: Record<string, string> = {
  "agente-sugere-ocs-padrao": "Sugestão de ocorrência",
  "interpretador-resposta-cliente": "Leitura da resposta do cliente",
  "agente-oc13-autonomo": "Exceções oc 13",
  "scan-email-pre-card": "Varredura de e-mail",
  "robo-intranet-wurth": "Robô da intranet Würth",
};

// Os agentes que NÃO têm placar, e por quê. É conhecimento estrutural (veio do
// inventário dos 49 agentes) — mantido em código de propósito: some daqui só
// quando o agente passar a registrar o par. Invisível é pior que ruim.
const SEM_PLACAR: Array<{ grupo: string; selo: string; tom: Veredito["tipo"]; texto: string }> = [
  {
    grupo: "Agem sozinhos",
    selo: "3 agentes",
    tom: "atencao",
    texto:
      "Extravio D+4, oc 43 e Ressarcimento 54 lançam sem aprovação — não existe decisão do operador pra comparar. Medimos pelo erro reportado.",
  },
  {
    grupo: "Oferece o menu",
    selo: "cobertura",
    tom: "pronto",
    texto:
      "O motor de propostas não escolhe uma ação, oferece as opções. A pergunta certa é se a ação do operador estava entre elas — e está, quase sempre.",
  },
  {
    grupo: "Não deixam rastro",
    selo: "os demais",
    tom: "pouco",
    texto:
      "Triador, redator de e-mail, leitor de foto, priorizador e outros: decidem todo dia, mas a sugestão não fica gravada de forma comparável — ou não termina numa ocorrência SSW.",
  },
];

const CLASSE_SELO: Record<Veredito["tipo"], string> = {
  pronto: "border-positive/30 bg-positive/10 text-positive",
  perto: "border-warn/30 bg-warn/10 text-warn",
  atencao: "border-signal/25 bg-signal-soft text-signal",
  pouco: "border-border text-ink-mute",
};

function Selo({ v }: { v: Veredito }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide ${CLASSE_SELO[v.tipo]}`}
    >
      {v.texto}
    </span>
  );
}

function Delta({ d }: { d: number | null }) {
  if (d === null) return <span className="font-mono text-[11px] text-ink-mute">sem base</span>;
  const cls = d > 0 ? "text-positive" : d < 0 ? "text-negative" : "text-ink-mute";
  return (
    <span className={`font-mono text-[11px] font-semibold tabular-nums ${cls}`}>
      {d > 0 ? "▲" : d < 0 ? "▼" : "="} {Math.abs(d).toFixed(1)}
    </span>
  );
}

/**
 * O detalhe que abre ao clicar no agente: performance de CADA ocorrência que ele
 * sugere e, quando erra, o que o operador fez no lugar. Cada linha vermelha é
 * literalmente uma pergunta pronta pro chat do agente-chefe.
 */
function DetalheOcs({ ocs }: { ocs: OcDoAgente[] }) {
  if (ocs.length === 0) {
    return (
      <p className="px-4 py-3 text-[12px] text-ink-mute">
        Sem quebra por ocorrência no período.
      </p>
    );
  }
  return (
    <div className="border-t border-border bg-bg-muted/40 px-4 py-3">
      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
        Por ocorrência sugerida · pior primeiro
      </p>
      <div className="space-y-2.5">
        {ocs.map((o) => {
          const v = vereditoDoAgente(o.pct, o.pares);
          return (
            <div key={o.oc} className="border-l-2 pl-3" style={{ borderColor: "var(--c-border)" }}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[12.5px] font-semibold text-ink">quando sugere oc {o.oc}</span>
                <span
                  className={`font-mono text-[13px] font-semibold tabular-nums ${
                    v.tipo === "pronto" ? "text-positive" : v.tipo === "pouco" ? "text-ink-mute" : "text-ink"
                  }`}
                >
                  {o.pct !== null ? `${o.pct}%` : "—"}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-ink-mute">
                  {o.seguidas} iguais · {o.corrigidas} diferentes
                </span>
                <Selo v={v} />
              </div>
              {o.divergencias.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {o.divergencias.map((d, i) => (
                    <li key={i} className="text-[12px] leading-snug text-ink-soft">
                      <span className="text-negative">↳</span>{" "}
                      {d.ocCard != null && (
                        <>
                          com o card em <b className="text-ink">oc {d.ocCard}</b>,{" "}
                        </>
                      )}
                      o operador fez <b className="text-ink">oc {d.ocExecutada}</b>{" "}
                      <span className="font-mono tabular-nums text-ink-mute">({d.n}×)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 border-t border-border pt-2 text-[11.5px] text-ink-mute">
        Cada linha dessas é uma pergunta pronta pro agente-chefe — leve pro chat abaixo.
      </p>
    </div>
  );
}

export function PlacarAgentes() {
  const placar = useQuery({
    queryKey: ["placar-agentes", "linhas"],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    retry: false, // view ausente (migration não aplicada) não fica repetindo
    queryFn: async (): Promise<LinhaPlacar[]> => {
      const desde = diasUteisFechados(JANELA_PLACAR_UTEIS * 2, new Date()).at(-1);
      const { data, error } = await supabase!
        .from("v_placar_agente")
        .select("dia, agent_name, fatia_oc_sugerida, seguidas, corrigidas, pares")
        .gte("dia", desde ?? "1970-01-01")
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as LinhaPlacar[];
    },
  });

  const erros = useQuery({
    queryKey: ["placar-agentes", "erros"],
    enabled: !!supabase,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<LinhaErro[]> => {
      const { data, error } = await supabase!
        .from("v_placar_agente_erros")
        .select("agent_name, oc_card, oc_sugerida, oc_executada, n")
        .order("n", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as LinhaErro[];
    },
  });

  const dados = useMemo(
    () => agregarPlacar(placar.data ?? [], erros.data ?? [], new Date()),
    [placar.data, erros.data],
  );
  const [aberto, setAberto] = useState<string | null>(null);

  if (placar.isError) return null; // migration ainda não aplicada
  if (placar.isLoading) {
    return <div className="mb-6 h-36 animate-pulse rounded-xl border border-border bg-bg-elevated" />;
  }
  if (dados.agentes.length === 0) return null;

  const g = dados.global;
  const faltam = g.pct !== null ? Math.round((META_ACERTO_PCT - g.pct) * 10) / 10 : null;

  return (
    <SecaoDobravel
      id="placar"
      titulo={`Placar dos agentes · ${JANELA_PLACAR_UTEIS} dias úteis`}
      resumo={g.pct !== null ? `${g.pct}%` : undefined}
      hint="o operador fez exatamente o que o agente sugeriu?"
    >
      {/* ---- O número, e o que ele significa em ações ---- */}
      <div className="mb-3 rounded-xl border border-border-strong bg-bg-elevated p-4">
        <p className="mb-2 text-[12px] text-ink-soft">
          De cada 100 ações sugeridas, quantas o operador fez <b className="text-ink">exatamente igual</b>?
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[42px] font-semibold leading-none tabular-nums text-ink">
                {g.pct !== null ? `${g.pct}%` : "—"}
              </span>
              <Delta d={g.delta} />
            </div>
          </div>
          <div className="min-w-[180px] flex-1">
            <div className="relative h-2 w-full rounded-full bg-bg-muted">
              <div
                className="h-full rounded-full bg-ink"
                style={{ width: `${Math.min(100, Math.max(1, g.pct ?? 0))}%` }}
              />
              <div
                className="absolute -top-1 bottom-[-4px] w-[2px] rounded bg-signal"
                style={{ left: `${META_ACERTO_PCT}%` }}
                aria-hidden
              />
            </div>
            <p className="mt-1 text-right font-mono text-[10px] font-semibold text-signal">
              meta {META_ACERTO_PCT}%
            </p>
          </div>
        </div>
        {faltam !== null && faltam > 0 && (
          <p className="mt-3 border-t border-border pt-3 text-[13px] text-ink-soft">
            Faltam <b className="text-ink">{faltam} pontos</b>. Na prática:{" "}
            <b className="text-ink">{dados.acoesParaMeta} ações por semana</b> em que o operador fez
            diferente do sugerido.
          </p>
        )}
      </div>

      {/* ---- Uma linha por agente ---- */}
      <div className="space-y-1.5">
        {dados.agentes.map((a) => {
          const v = vereditoDoAgente(a.pct, a.pares);
          const e = a.piorErro;
          return (
            <div key={a.agente} className="overflow-hidden rounded-xl border border-border bg-bg-elevated">
            <button
              type="button"
              onClick={() => setAberto((x) => (x === a.agente ? null : a.agente))}
              aria-expanded={aberto === a.agente}
              className="grid w-full grid-cols-[minmax(0,1fr),92px] items-center gap-3 px-4 py-3 text-left hover:bg-bg-muted/40"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">
                    {AGENTE_AMIGAVEL[a.agente] ?? a.agente}
                  </span>
                  <Selo v={v} />
                </div>
                {/* o erro em FRASE, não em par de códigos */}
                {e && e.oc_sugerida != null && e.oc_executada != null && (
                  <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                    Erra mais {e.oc_card != null ? <>quando o card está em <b className="text-ink">oc {e.oc_card}</b> e </> : null}
                    ele sugere <b className="text-ink">{e.oc_sugerida}</b> — o operador faz{" "}
                    <b className="text-ink">{e.oc_executada}</b> ({e.n}× no mês).
                  </p>
                )}
                <p className="mt-1 font-mono text-[11px] tabular-nums text-ink-mute">
                  {a.pares} ações · {a.seguidas} iguais · {a.corrigidas} diferentes
                </p>
                <div className="relative mt-2 h-1.5 w-full rounded-full bg-bg-muted">
                  <div
                    className={`h-full rounded-full ${v.tipo === "pronto" ? "bg-positive" : v.tipo === "pouco" ? "bg-ink-mute" : "bg-ink"}`}
                    style={{ width: `${Math.min(100, Math.max(1, a.pct ?? 0))}%` }}
                  />
                  <div
                    className="absolute -top-0.5 bottom-[-2px] w-[2px] rounded bg-signal"
                    style={{ left: `${META_ACERTO_PCT}%` }}
                    aria-hidden
                  />
                </div>
              </div>
              <div className="text-right">
                <div
                  className={`font-mono text-[22px] font-semibold leading-none tabular-nums ${
                    v.tipo === "pronto" ? "text-positive" : v.tipo === "pouco" ? "text-ink-mute" : "text-ink"
                  }`}
                >
                  {a.pct !== null ? `${a.pct}%` : "—"}
                </div>
                <div className="mt-1 flex items-center justify-end gap-1.5">
                  <Delta d={a.delta} />
                  <ChevronDown
                    className={`h-3 w-3 shrink-0 text-ink-mute transition-transform ${
                      aberto === a.agente ? "" : "-rotate-90"
                    }`}
                    aria-hidden
                  />
                </div>
              </div>
            </button>
            {aberto === a.agente && <DetalheOcs ocs={a.porOc} />}
            </div>
          );
        })}
      </div>

      {/* ---- O que já dá pra soltar ---- */}
      {dados.fatiasProntas.length > 0 && (
        <div className="mt-3 rounded-xl border border-positive/25 bg-positive/5 px-4 py-3">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-positive">
            O que já dá pra soltar
          </p>
          <p className="mt-1 text-[12px] text-ink-soft">
            Um agente pode estar mal no geral e ótimo numa situação específica — a autonomia é
            liberada na situação, não no agente inteiro.
          </p>
          <ul className="mt-2 space-y-1">
            {dados.fatiasProntas.map((f) => (
              <li key={`${f.agente}-${f.oc}`} className="text-[12.5px] text-ink-soft">
                <b className="text-ink">{AGENTE_AMIGAVEL[f.agente] ?? f.agente}</b> → sugerir{" "}
                <b className="text-ink">oc {f.oc}</b>{" "}
                <span className="font-mono tabular-nums text-ink-mute">
                  · {f.pct}% em {f.pares} ações
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Os agentes sem placar (invisível é pior que ruim) ---- */}
      <div className="mt-3 rounded-xl border border-dashed border-border px-4 py-3">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
          Agentes ainda sem placar
        </p>
        <p className="mt-1 text-[12px] text-ink-soft">
          Não estão em zero — estão sem medição. Cada grupo precisa de uma coisa diferente pra
          entrar aqui.
        </p>
        <div className="mt-2 space-y-2">
          {SEM_PLACAR.map((s) => (
            <div key={s.grupo}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-semibold text-ink">{s.grupo}</span>
                <Selo v={{ tipo: s.tom, texto: s.selo } as Veredito} />
              </div>
              <p className="text-[12px] leading-snug text-ink-mute">{s.texto}</p>
            </div>
          ))}
        </div>
      </div>
    </SecaoDobravel>
  );
}
