// =============================================================================
// TORRE DE AGENTES (Matheus 08/10) — ranking de quem acerta mais/menos,
// evolução semana a semana (sempre dizendo "em relação a quando"), fluxo
// agente → operador → autonomia, ficha + regras e o log da evolução.
// Só apresentação, no design system do Cockpit (ticket-card + tokens).
// Os números vêm prontos da página (mesmas views da mig 344).
// =============================================================================
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { AGENTES_CATALOGO, agenteAmigavel } from "@/lib/agentesCatalogo";
import type { FaixaConfianca, FatiaDrill, LinhaRanking, PontoSemana, TotaisPlacar } from "@/lib/gestaoAgentes";

const FAIXA: Record<FaixaConfianca, { rotulo: string; cor: string; fundo: string }> = {
  firme: { rotulo: "firme", cor: "var(--positive)", fundo: "var(--positive-soft)" },
  atencao: { rotulo: "atenção", cor: "var(--warning)", fundo: "var(--warning-soft)" },
  fraco: { rotulo: "fraco", cor: "var(--signal)", fundo: "var(--signal-soft)" },
  sem_dado: { rotulo: "sem dado", cor: "var(--c-ink-mute)", fundo: "var(--bg-subtle)" },
};
const faixaDe = (v: number | null, meta: number): FaixaConfianca =>
  v == null ? "sem_dado" : v >= meta ? "firme" : v >= 80 ? "atencao" : "fraco";

// cores das linhas por agente — só tokens do Cockpit
const CORES_LINHA = ["var(--signal)", "var(--positive)", "var(--warning)", "hsl(var(--kanban-new))", "var(--negative)", "hsl(var(--kanban-action))"];

const pct = (v: number | null) => (v != null ? `${v}%` : "—");
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function Rotulo({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-mute">{children}</div>;
}

function Chip({ faixa }: { faixa: FaixaConfianca }) {
  const f = FAIXA[faixa];
  return (
    <span className="rounded-[20px] px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em]"
      style={{ background: f.fundo, color: f.cor }}>{f.rotulo}</span>
  );
}

function BarraPct({ v, meta }: { v: number | null; meta: number }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-subtle">
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, v ?? 0)}%`, background: FAIXA[faixaDe(v, meta)].cor }} />
      <div className="absolute top-0 h-full w-px bg-ink" style={{ left: `${meta}%` }} title={`meta ${meta}%`} />
    </div>
  );
}

function Delta({ d }: { d: number | null }) {
  if (d == null) return <span className="text-ink-mute">—</span>;
  const cor = d > 0.5 ? "var(--positive)" : d < -0.5 ? "var(--signal)" : "var(--c-ink-mute)";
  const seta = d > 0.5 ? "▲" : d < -0.5 ? "▼" : "▬";
  return <span className="font-semibold" style={{ color: cor }}>{seta} {d > 0 ? "+" : ""}{d} pts</span>;
}

/** "▼ −2,7 pts · 61% (22/09–30/09) → 58,3% (01/10–08/10)" — o delta nunca aparece sem o "em relação a quando". */
function DeltaComJanela({ r }: { r: LinhaRanking }) {
  if (r.delta == null || !r.janelaAntes || !r.janelaDepois) {
    return <span className="text-ink-mute">sem dado nas duas metades da janela</span>;
  }
  return (
    <span>
      <Delta d={r.delta} />
      <span className="text-ink-mute">
        {" "}· {pct(r.pctAntes)} em {ddmm(r.janelaAntes.de)}–{ddmm(r.janelaAntes.ate)} → {pct(r.pctDepois)} em {ddmm(r.janelaDepois.de)}–{ddmm(r.janelaDepois.ate)}
      </span>
    </span>
  );
}

export interface EventoTorre { quando: string; quem: string; texto: string; tom?: "ok" | "ruim" | "neutro" }

export function TorreAgentes({
  ranking, semanas, totais, totaisManter, meta, minPares, selecionado, onSelecionar,
  autonomas, piorTrocaDe, melhorFatiaDe, eventos,
}: {
  ranking: LinhaRanking[];
  semanas: Map<string, PontoSemana[]>;
  totais: TotaisPlacar;
  totaisManter: TotaisPlacar;
  meta: number;
  minPares: number;
  selecionado: string;
  onSelecionar: (agente: string) => void;
  autonomas: Array<{ agent_name: string; oc_card: number | null; oc_sugerida: number; ativa: boolean }>;
  piorTrocaDe: (agente: string) => FatiaDrill | undefined;
  melhorFatiaDe: (agente: string) => FatiaDrill | undefined;
  eventos: EventoTorre[];
}) {
  const ativas = autonomas.filter((a) => a.ativa);
  const sinalizadas = autonomas.filter((a) => !a.ativa);
  const foco = ranking.find((r) => r.agent_name === selecionado) ?? ranking.find((r) => r.pares >= minPares);
  const info = foco ? AGENTES_CATALOGO[foco.agent_name] : undefined;
  const pior = foco ? piorTrocaDe(foco.agent_name) : undefined;
  const melhor = foco ? melhorFatiaDe(foco.agent_name) : undefined;
  const autDoFoco = foco ? autonomas.filter((a) => a.agent_name === foco.agent_name) : [];

  // evolução semanal: uma linha por agente com volume + "Todos" tracejado
  const comVolume = ranking.filter((r) => r.pares >= minPares);
  const todasSemanas = (semanas.get("__todos") ?? []).map((p) => p.semana);
  const dadosGrafico = todasSemanas.map((sem) => {
    const linha: Record<string, string | number | null> = { semana: ddmm(sem) };
    linha.__todos = semanas.get("__todos")?.find((p) => p.semana === sem)?.pct ?? null;
    for (const r of comVolume) linha[r.agent_name] = semanas.get(r.agent_name)?.find((p) => p.semana === sem)?.pct ?? null;
    return linha;
  });

  return (
    <div className="mb-6 space-y-4">
      {/* pulso */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { r: "Acerto global", v: pct(totais.pctAcerto), cor: FAIXA[faixaDe(totais.pctAcerto, meta)].cor, sub: `${totais.seguidas} de ${totais.pares} seguidas` },
          { r: "Sugestões medidas", v: totais.pares.toLocaleString("pt-BR"), sub: "pares agente × operador" },
          { r: "Corrigidas", v: totais.corrigidas.toLocaleString("pt-BR"), cor: totais.corrigidas ? "var(--signal)" : undefined, sub: "operador fez outra oc" },
          { r: "Sugeriu aguardar", v: totaisManter.pares.toLocaleString("pt-BR"), sub: "fora do %" },
          { r: "Autonomia", v: `${ativas.length} ⚡`, sub: `${sinalizadas.length} sinalizada(s) aguardando Caio` },
        ].map((k) => (
          <div key={k.r} className="ticket-card px-5 py-4">
            <Rotulo>{k.r}</Rotulo>
            <div className="mt-1 text-[28px] font-bold leading-none tabular text-ink-2" style={k.cor ? { color: k.cor } : undefined}>{k.v}</div>
            <div className="mt-1 text-[12px] text-ink-soft-2">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          {/* ranking */}
          <div className="ticket-card px-4 py-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[14px] font-bold text-ink-2">Ranking — quem mais acerta → quem menos acerta</div>
              <Rotulo>clique pra abrir a ficha</Rotulo>
            </div>
            <div className="space-y-1.5">
              {ranking.map((r) => {
                const amostraFraca = r.pares < minPares;
                const ativo = foco?.agent_name === r.agent_name;
                return (
                  <button
                    key={r.agent_name}
                    onClick={() => onSelecionar(r.agent_name)}
                    className="block w-full rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-muted-2"
                    style={{
                      background: ativo ? "var(--signal-softer, var(--bg-subtle))" : "var(--bg-subtle)",
                      outline: ativo ? "1.5px solid var(--signal)" : undefined,
                      opacity: amostraFraca ? 0.6 : 1,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-7 shrink-0 font-mono text-[12px] font-bold tabular text-ink-mute">#{r.posicao}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-2 md:w-52 md:flex-none">{agenteAmigavel(r.agent_name)}</span>
                      <span className="hidden flex-1 md:block"><BarraPct v={r.pctAcerto} meta={meta} /></span>
                      <span className="w-14 shrink-0 text-right font-mono text-[13px] font-bold tabular" style={{ color: FAIXA[r.faixa].cor }}>{pct(r.pctAcerto)}</span>
                      <span className="hidden w-24 shrink-0 text-right font-mono text-[11px] tabular text-ink-mute md:block">
                        {r.seguidas}/{r.pares}{amostraFraca ? " · amostra" : ""}
                      </span>
                      <span className="hidden shrink-0 md:block"><Chip faixa={r.faixa} /></span>
                    </div>
                    <div className="mt-1 pl-10 font-mono text-[10.5px]"><DeltaComJanela r={r} /></div>
                  </button>
                );
              })}
              {ranking.length === 0 && <p className="py-4 text-center text-[13px] text-ink-mute">Sem pares no período/filtros.</p>}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-2 font-mono text-[10px] text-ink-mute">
              <span><span style={{ color: "var(--positive)" }}>■</span> firme ≥{meta}%</span>
              <span><span style={{ color: "var(--warning)" }}>■</span> atenção ≥80%</span>
              <span><span style={{ color: "var(--signal)" }}>■</span> fraco &lt;80%</span>
              <span>▲▼ = 2ª metade da janela vs 1ª (datas ao lado)</span>
              <span>esmaecido = &lt;{minPares} pares</span>
            </div>
          </div>

          {/* evolução semanal */}
          <div className="ticket-card px-4 py-4">
            <div className="mb-1 text-[14px] font-bold text-ink-2">Está melhorando? — acerto semana a semana</div>
            <p className="mb-3 text-[12px] text-ink-soft-2">
              Cada ponto é a semana (seg→dom) que começa na data do eixo. Tracejado = todos os agentes juntos.
            </p>
            {dadosGrafico.length > 1 ? (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={dadosGrafico} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="var(--c-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="semana" tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--c-ink-mute)" }} />
                  <Tooltip
                    formatter={(v: number, nome: string) => [v != null ? `${v}%` : "—", nome === "__todos" ? "Todos" : agenteAmigavel(nome)]}
                    labelFormatter={(s) => `Semana de ${s}`}
                  />
                  <Legend formatter={(nome: string) => (nome === "__todos" ? "Todos" : agenteAmigavel(nome))} wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={meta} stroke="var(--positive)" strokeDasharray="4 4"
                    label={{ value: `meta ${meta}%`, fontSize: 10, fill: "var(--positive)", position: "insideTopRight" }} />
                  <Line dataKey="__todos" stroke="var(--c-ink)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                  {comVolume.map((r, i) => (
                    <Line key={r.agent_name} dataKey={r.agent_name} stroke={CORES_LINHA[i % CORES_LINHA.length]}
                      strokeWidth={foco?.agent_name === r.agent_name ? 3 : 1.5} dot={{ r: 2.5 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-4 text-center text-[13px] text-ink-mute">Precisa de pelo menos 2 semanas na janela — escolha 30 ou 90 dias.</p>
            )}

            {/* tabela semana × agente: o número exato e a variação vs a semana anterior */}
            {todasSemanas.length > 1 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse font-mono text-[11px] tabular">
                  <thead>
                    <tr className="text-ink-mute">
                      <th className="py-1 pr-3 text-left font-normal">agente</th>
                      {todasSemanas.map((s) => <th key={s} className="px-2 py-1 text-right font-normal">sem {ddmm(s)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[{ agent_name: "__todos" }, ...comVolume].map((r) => {
                      const pts = semanas.get(r.agent_name) ?? [];
                      return (
                        <tr key={r.agent_name} className="border-t border-rule">
                          <td className="py-1.5 pr-3 text-left font-sans text-[12px] font-semibold text-ink-2">
                            {r.agent_name === "__todos" ? "Todos" : agenteAmigavel(r.agent_name)}
                          </td>
                          {todasSemanas.map((s, i) => {
                            const p = pts.find((x) => x.semana === s);
                            const ant = i > 0 ? pts.find((x) => x.semana === todasSemanas[i - 1]) : undefined;
                            const d = p?.pct != null && ant?.pct != null ? Math.round((p.pct - ant.pct) * 10) / 10 : null;
                            return (
                              <td key={s} className="px-2 py-1.5 text-right" title={p ? `${p.seguidas}/${p.pares} seguidas` : "sem pares"}>
                                <div className="font-bold" style={{ color: FAIXA[faixaDe(p?.pct ?? null, meta)].cor }}>{pct(p?.pct ?? null)}</div>
                                <div className="text-[9.5px]">{d != null ? <Delta d={d} /> : <span className="text-ink-mute">{p ? `${p.pares} pares` : ""}</span>}</div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-1.5 text-[10.5px] text-ink-mute">▲▼ abaixo de cada % = variação contra a semana anterior. Passe o mouse pra ver seguidas/pares.</p>
              </div>
            )}
          </div>

        </div>

        {/* lateral */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="ticket-card px-4 py-4">
            <Rotulo>Ficha do agente</Rotulo>
            {foco ? (
              <>
                <div className="mt-1 text-[15px] font-bold text-ink-2">{agenteAmigavel(foco.agent_name)}</div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[28px] font-bold leading-none tabular" style={{ color: FAIXA[foco.faixa].cor }}>{pct(foco.pctAcerto)}</span>
                  <Chip faixa={foco.faixa} />
                </div>
                <div className="mt-1.5 font-mono text-[10.5px] leading-relaxed"><DeltaComJanela r={foco} /></div>
                {info && (
                  <div className="mt-3 space-y-1.5 text-[12px] text-ink-soft-2">
                    <p><strong className="text-ink-2">Faz:</strong> {info.oQueFaz}</p>
                    <p><strong className="text-ink-2">Sugere:</strong> {info.oQueSugere}</p>
                  </div>
                )}
                <div className="mt-3 space-y-1.5 border-t border-rule pt-2.5 text-[12px] text-ink-soft-2">
                  {melhor && (
                    <p><strong style={{ color: "var(--positive)" }}>Onde mais acerta:</strong> card em oc {melhor.oc_card ?? "—"} → sugere {melhor.oc_sugerida} · {pct(melhor.pctSeguidas)} de {melhor.pares}</p>
                  )}
                  {pior && (
                    <p><strong style={{ color: "var(--signal)" }}>Onde mais erra:</strong> card em oc {pior.oc_card ?? "—"} → sugere {pior.oc_sugerida}, operador faz {pior.oc_executada} · {pior.n}×</p>
                  )}
                  <p><strong className="text-ink-2">Autonomia:</strong> {autDoFoco.length
                    ? autDoFoco.map((a) => `${a.ativa ? "⚡" : "◌"} ${a.oc_card ?? "*"}→${a.oc_sugerida}`).join(" · ")
                    : "nenhuma fatia ainda"}</p>
                </div>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-ink-mute">Clique num agente do ranking.</p>
            )}
          </div>

          <div className="ticket-card px-4 py-4">
            <Rotulo>Regras da medição</Rotulo>
            <ul className="mt-2 space-y-1.5 text-[12px] text-ink-soft-2">
              <li>• O operador é a verdade: fez o sugerido = acerto; fez outra oc = correção.</li>
              <li>• % soma contadores do período — nunca média de médias.</li>
              <li>• "Sugeriu aguardar" (card já em 54/59 e sugere a mesma) fica fora do %.</li>
              <li>• Fatia pronta pra autonomia: ≥{meta}% seguidas e ≥50 pares.</li>
              <li>• Sinalizar não liga nada: só roda sozinha após validação expressa do Caio.</li>
              <li>• Ranking só compara quem tem ≥{minPares} pares na janela.</li>
            </ul>
          </div>

          <div className="ticket-card px-4 py-4">
            <Rotulo>Log da evolução</Rotulo>
            <div className="mt-2 space-y-2">
              {eventos.slice(0, 8).map((e, i) => (
                <div key={i} className="text-[12px]">
                  <div className="font-mono text-[10px] text-ink-mute">{e.quando} · {e.quem}</div>
                  <div style={{ color: e.tom === "ok" ? "var(--positive)" : e.tom === "ruim" ? "var(--signal)" : undefined }} className="text-ink-2">{e.texto}</div>
                </div>
              ))}
              {eventos.length === 0 && <p className="text-[12px] text-ink-mute">Sem eventos na janela.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
