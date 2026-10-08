// =============================================================================
// Gestão da Operação — para o gestor/gerente ver ONDE ESTÁ TRAVANDO de relance.
//
// Topo: a faixa da torre (agente leu → regras firmes → especialistas por setor →
// conselheiro → você confirma). Depois UMA lista curta: os gargalos filial × setor,
// cada um com a ação óbvia (abrir a nota mais antiga). O resto (críticas, faixas,
// setor × filial, ranking, regional, produtividade, indicadores) fica recolhido.
//
// Nada daqui grava: abrir nota leva à fila; o CSV só é baixado no navegador.
// Regras: lib/operacao/regua.ts e gestao.ts (portadas do Pendências, com arquivo:linha).
// =============================================================================
import { useMemo } from "react";
import { Download, FolderOpen } from "lucide-react";

import { linhasCargaParadaCsv, resumirGestao, SEM_FILIAL, DIAS_GARGALO } from "@/lib/operacao/gestao";
import { DIAS_INDICADOR_7, DIAS_INDICADOR_PRE_ENTREGA, MIN_DIAS_REGRA_AJUDA, MIN_DIAS_REGRA_CODIGO, SLA_SETORES } from "@/lib/operacao/regua";
import { nomeDoSetor, setorDoItem } from "@/lib/operacao/setores";
import type { OpFilaLinha } from "@/lib/operacao/tipos";
import { baixarTexto, hojeIso, n } from "@/lib/operacao/formatoTela";
import { EstadoOperacao } from "./EstadoOperacao";
import {
  AvisosConselheiro,
  Barras,
  BotaoPrincipal,
  BotaoSecundario,
  FaixaTorre,
  LinhaMetricas,
  Recolhivel,
  Rotulo,
  type AvisoCurto,
} from "./PecasTorre";

const plural = (v: number, um: string, varios: string) => `${n(v)} ${v === 1 ? um : varios}`;
const diasTxt = (d: number) => (d === 1 ? "1 dia útil" : `${n(d)} dias úteis`);
const fmt1 = (v: number | null) => (v == null ? "—" : v.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));

export interface GestaoOperacaoProps {
  linhas: OpFilaLinha[];
  agoraMs: number;
  papel: string;
  /** Setor do membro; null = todos (gerente/gestor). */
  setor: string | null;
  onAbrirNota: (id: string) => void;
  onFiltrarFilial?: (u: string) => void;
  demo: boolean;
}

export function GestaoOperacao({ linhas, agoraMs, papel, setor, onAbrirNota, onFiltrarFilial, demo }: GestaoOperacaoProps) {
  const doSetor = useMemo(() => (setor ? linhas.filter((l) => setorDoItem(l) === setor) : linhas), [linhas, setor]);
  const r = useMemo(() => resumirGestao(doSetor, agoraMs), [doSetor, agoraMs]);

  function baixar() {
    baixarTexto(`carga-parada-${hojeIso(agoraMs)}.csv`, linhasCargaParadaCsv(doSetor, agoraMs));
  }

  if (r.total === 0) {
    return <EstadoOperacao tipo="vazio" titulo="Nenhuma nota parada" texto={setor ? `Nada aberto no setor ${nomeDoSetor(setor)} agora.` : "A fila está vazia agora."} />;
  }

  const setoresComNota = r.porSetor.filter((s) => s.total > 0 && s.setor !== "NAO_IDENTIFICADO").length;
  const avisos: AvisoCurto[] = r.avisos.slice(0, 4).map((a) => ({
    id: a.id,
    tom: a.tom,
    titulo: a.titulo,
    detalhe: a.detalhe,
    acao:
      a.unidade && onFiltrarFilial
        ? { rotulo: `Ver ${a.unidade} na fila`, onClick: () => onFiltrarFilial(a.unidade!) }
        : a.itens[0]
          ? { rotulo: a.itens.length === 1 ? "Abrir a nota" : "Abrir a primeira", onClick: () => onAbrirNota(a.itens[0]!) }
          : null,
  }));

  const gargalos = r.gargalos.slice(0, 6);
  const primeiro = gargalos[0] ?? null;
  const totalParadas = r.gargalos.reduce((a, g) => a + g.paradas, 0);
  const semPrevisao = r.avisos.find((a) => a.id === "sem-previsao")?.itens ?? [];
  const temFaixas = r.faixas.some((f) => f.total > 0);
  const temIndicadores = r.indicadores.baseAcima7 + r.indicadores.basePreEntrega > 0;

  function irParaGargalos() {
    const el = document.getElementById("gargalos-titulo");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    (document.getElementById("gargalo-0") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  return (
    <div className="flex flex-col gap-5 px-4 pb-8 pt-5 md:px-6">
      {/* Topo: o agente e a faixa da torre */}
      <section aria-labelledby="gestao-titulo">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-mute">
          <span className="h-2 w-2 rounded-full bg-sal" aria-hidden />
          Gestão · {papel}
          {setor && <span>· setor {nomeDoSetor(setor)}</span>}
          {demo && <span style={{ color: "var(--signal-strong)" }}>· demonstração</span>}
        </div>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="gestao-titulo" className="text-[20px] font-semibold leading-tight text-ink-2" style={{ letterSpacing: "-0.01em", textWrap: "balance" }}>
              Onde a operação está travando
            </h2>
            <p className="mt-1 max-w-[62ch] text-[14px] leading-relaxed text-ink-soft-2" style={{ textWrap: "pretty" }}>
              {totalParadas === 0 ? (
                <>Nenhuma nota parada há mais de {diasTxt(DIAS_GARGALO)}</>
              ) : (
                <>
                  <strong className="font-semibold" style={{ color: "var(--signal-strong)" }}>
                    {plural(totalParadas, "parada", "paradas")}
                  </strong>{" "}
                  há mais de {diasTxt(DIAS_GARGALO)}
                </>
              )}
              {semPrevisao.length > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => onAbrirNota(semPrevisao[0]!)}
                    className="font-semibold underline decoration-rule-strong underline-offset-[3px] hover:decoration-ink"
                    style={{ color: "var(--warning)" }}
                  >
                    {plural(semPrevisao.length, "sem previsão", "sem previsão")}
                  </button>
                </>
              )}
              {r.criticas.length > 0 && <> · {plural(r.criticas.length, "crítica", "críticas")} (mais de 5 dias úteis)</>}.
            </p>
          </div>
          <BotaoSecundario onClick={baixar} rotulo="Baixar carga parada (CSV)">
            <Download className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Carga parada (CSV)</span>
          </BotaoSecundario>
        </div>
        <div className="mt-3">
          <FaixaTorre
            rotulo="Como a torre lê a gestão"
            onUltima={primeiro ? irParaGargalos : undefined}
            etapas={[
              { titulo: "O agente leu", valor: n(r.total), nota: r.total === 1 ? "nota" : "notas" },
              {
                titulo: "Regras firmes",
                valor: n(r.cargaParada.entram),
                nota: "carga parada",
                alerta: r.cargaParada.semPrevisao > 0 ? `${n(r.cargaParada.semPrevisao)} em dúvida` : null,
              },
              { titulo: "Especialistas", valor: n(setoresComNota), nota: setoresComNota === 1 ? "setor" : "setores", alerta: r.semSetor > 0 ? `${n(r.semSetor)} sem setor` : null },
              { titulo: "Conselheiro", valor: n(r.avisos.length), nota: r.avisos.length === 1 ? "aviso" : "avisos" },
              { titulo: "Você confirma", valor: n(r.gargalos.length), nota: r.gargalos.length === 1 ? "gargalo" : "gargalos" },
            ]}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* A lista que importa */}
        <section aria-labelledby="gargalos-titulo" className="min-w-0 scroll-mt-4 rounded-[16px] border border-rule bg-surface p-4">
          <Rotulo>Gargalos por filial e setor</Rotulo>
          <h3 id="gargalos-titulo" className="mt-1 text-[17px] font-semibold text-ink-2">
            Comece por aqui
          </h3>
          {gargalos.length === 0 ? (
            <p className="mt-3 rounded-[10px] bg-[var(--bg-subtle)] px-3 py-2.5 text-[12.5px] text-ink-soft-2">Nenhuma filial com nota parada há mais de {diasTxt(DIAS_GARGALO)}.</p>
          ) : (
            <ol className="mt-3 divide-y divide-[hsl(var(--rule))]">
              {gargalos.map((g, i) => {
                const nomeFilial = g.unidade === SEM_FILIAL ? "Sem filial" : g.unidade;
                const abrir = () => onAbrirNota(g.itens[0]!);
                const rotulo = `Abrir a nota mais antiga de ${nomeFilial}`;
                return (
                  <li key={`${g.unidade}|${g.setor}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {onFiltrarFilial && g.unidade !== SEM_FILIAL ? (
                          <button
                            type="button"
                            onClick={() => onFiltrarFilial(g.unidade)}
                            aria-label={`Ver ${g.unidade} na fila`}
                            className="text-[14px] font-semibold text-ink-2 underline decoration-rule-strong underline-offset-[3px] hover:decoration-ink"
                          >
                            {nomeFilial}
                          </button>
                        ) : (
                          <span className="text-[14px] font-semibold text-ink-2">{nomeFilial}</span>
                        )}
                        <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] font-medium text-ink-soft-2">{g.nomeSetor}</span>
                      </div>
                      <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft-2">
                        <strong className="tabular font-semibold text-ink-2">{n(g.paradas)}</strong> de {n(g.total)} paradas
                        {g.foraPrazo > 0 && (
                          <>
                            {" · "}
                            <span style={{ color: "var(--signal-strong)" }}>{n(g.foraPrazo)} fora do prazo do setor</span>
                          </>
                        )}
                        {" · "}a mais antiga há {diasTxt(g.maiorDias)}
                      </p>
                    </div>
                    <div id={i === 0 ? "gargalo-0" : undefined} tabIndex={-1} className="shrink-0 outline-none">
                      {i === 0 ? (
                        <BotaoPrincipal onClick={abrir} rotulo={rotulo}>
                          <FolderOpen className="h-4 w-4" aria-hidden /> Abrir a mais antiga
                        </BotaoPrincipal>
                      ) : (
                        <BotaoSecundario onClick={abrir} rotulo={rotulo}>
                          <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Abrir a mais antiga
                        </BotaoSecundario>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {r.gargalos.length > gargalos.length && (
            <p className="mt-3 text-[12px] text-ink-mute">E mais {plural(r.gargalos.length - gargalos.length, "gargalo menor", "gargalos menores")} em "Ver mais detalhes".</p>
          )}
        </section>

        <AvisosConselheiro avisos={avisos} />
      </div>

      {/* Detalhes: um só recolhível; dentro, só o que tem conteúdo */}
      <section aria-label="Detalhes" className="rounded-[16px] border border-rule bg-surface px-4">
        <Recolhivel titulo="Ver mais detalhes" resumo="críticas, setor × filial, regionais, quem trabalhou, régua">
          <div className="flex flex-col gap-5">
            {r.criticas.length > 0 && (
              <Bloco titulo="Cargas críticas" resumo={`${n(r.criticas.length)} há mais de 5 dias úteis`}>
                <ul className="divide-y divide-[hsl(var(--rule))]">
                  {r.criticas.slice(0, 50).map((c) => (
                    <li key={c.l.op_item_id}>
                      <button
                        type="button"
                        onClick={() => onAbrirNota(c.l.op_item_id)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 py-2 text-left text-[12.5px] hover:bg-[var(--bg-subtle)]"
                      >
                        <span className="min-w-0 truncate">
                          <strong className="font-semibold text-ink-2">NF {c.l.nf ?? c.l.ctrc}</strong>
                          <span className="text-ink-soft-2"> · {c.unidade} · {c.l.cod_ultima_ocorrencia ?? "sem oc"} {c.l.descricao_oc ? `· ${c.l.descricao_oc.toLowerCase()}` : ""}</span>
                        </span>
                        <span className="tabular font-semibold" style={{ color: "var(--signal-strong)" }}>
                          {diasTxt(c.dias ?? 0)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {r.criticas.length > 50 && <p className="mt-2 text-[12px] text-ink-mute">Mostrando 50 de {n(r.criticas.length)}.</p>}
              </Bloco>
            )}

            {temFaixas && (
              <Bloco titulo="Há quanto tempo estão paradas" resumo={r.semData ? `${n(r.semData)} sem data` : "dias úteis desde a última ocorrência"}>
                <Barras
                  itens={r.faixas.map((f) => ({
                    rotulo: f.rotulo,
                    valor: f.total,
                    cor: f.id === "8+" || Number(f.id) > 5 ? "var(--signal)" : Number(f.id) >= 3 ? "var(--warning)" : "var(--c-ink-disabled)",
                  }))}
                />
              </Bloco>
            )}

            <Bloco titulo="Setor × filial" resumo={`${n(r.porSetor.length)} setores · ${n(r.porFilial.length)} filiais`}>
              <MatrizSetorFilial r={r} onFiltrarFilial={onFiltrarFilial} />
            </Bloco>

            {r.rankingAtraso.some((f) => f.media > 0) && (
              <Bloco titulo="Filiais por atraso na previsão" resumo="dias corridos, média">
                <ul className="space-y-1 text-[12.5px]">
                  {r.rankingAtraso
                    .filter((f) => f.media > 0)
                    .slice(0, 15)
                    .map((f) => (
                      <li key={f.unidade} className="grid grid-cols-[minmax(0,1fr)_64px_72px] gap-2">
                        <span className="truncate text-ink-2">{f.unidade}</span>
                        <span className="tabular text-right text-ink-mute">{plural(f.total, "nota", "notas")}</span>
                        <span className="tabular text-right font-semibold text-ink-2">{fmt1(f.media)} d</span>
                      </li>
                    ))}
                </ul>
              </Bloco>
            )}

            <Bloco titulo="Por regional" resumo={`${n(r.porRegional.length)} regionais`}>
              <ul className="space-y-1.5 text-[12.5px]">
                {r.porRegional.map((g) => (
                  <li key={g.regional} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <span className="min-w-0">
                      <strong className="font-semibold text-ink-2">{g.regional}</strong>
                      <span className="text-ink-mute"> · {g.unidades.join(", ")}</span>
                    </span>
                    <span className="tabular text-ink-soft-2">
                      {n(g.total)} · <span style={{ color: g.paradas ? "var(--signal-strong)" : undefined }}>{n(g.paradas)} paradas</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Bloco>

            <Bloco titulo="Ocorrências mais comuns" resumo={`${n(r.porOcorrencia.length)} códigos`}>
              <ul className="space-y-1 text-[12.5px]">
                {r.porOcorrencia.slice(0, 10).map((o) => (
                  <li key={String(o.codigo)} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <span className="truncate text-ink-2">
                      <strong className="tabular font-semibold">{o.codigo ?? "—"}</strong> {o.descricao?.toLowerCase() ?? "sem descrição"}
                    </span>
                    <span className="tabular text-ink-soft-2">
                      {n(o.total)}
                      {o.paradas ? ` · ${n(o.paradas)} paradas` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Bloco>

            {r.produtividade.length > 0 && (
              <Bloco titulo="Quem trabalhou hoje" resumo={plural(r.produtividade.length, "pessoa", "pessoas")}>
                <ul className="space-y-1 text-[12.5px]">
                  {r.produtividade.map((p) => (
                    <li key={p.pessoa} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <span className="truncate font-semibold text-ink-2">{p.pessoa}</span>
                      <span className="tabular text-ink-soft-2">
                        {n(p.assumidas)} assumidas · {n(p.confirmados)} confirmados · {n(p.lancados)} lançados · {n(p.naFila)} na fila do SSW
                      </span>
                    </li>
                  ))}
                </ul>
              </Bloco>
            )}

            {temIndicadores && (
              <Bloco titulo="Indicadores da regra atual" resumo="estoque de hoje, não o ciclo">
                <LinhaMetricas
                  itens={[
                    { rotulo: `Operação com ${DIAS_INDICADOR_7}+ dias úteis`, valor: `${n(r.indicadores.acima7)} de ${n(r.indicadores.baseAcima7)}`, tom: r.indicadores.acima7 ? "critico" : "normal" },
                    {
                      rotulo: `Pré-entrega com ${DIAS_INDICADOR_PRE_ENTREGA}+ dias úteis`,
                      valor: `${n(r.indicadores.preEntregaAcima2)} de ${n(r.indicadores.basePreEntrega)}`,
                      tom: r.indicadores.preEntregaAcima2 ? "atencao" : "normal",
                    },
                  ]}
                />
                <p className="mt-2 text-[12px] leading-snug text-ink-mute" style={{ textWrap: "pretty" }}>
                  Regra atual (estoque): das notas abertas hoje, quantas passaram do limite. O indicador do ciclo (finalizadas no prazo) precisa do histórico de entregas, que esta tela não tem.
                </p>
              </Bloco>
            )}

            <Bloco titulo="Como a régua decide" resumo="regras do Pendências">
              <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-snug text-ink-soft-2">
                <li>Tempo parado conta em dias úteis desde a última ocorrência, sem sábado, domingo e feriado nacional.</li>
                <li>
                  Carga parada para cobrar: só com a previsão de entrega vencida. Pré-entrega (07, 13, 15, 21, 36, 39, 55) e informação faltante (56, 51, 52, 58) com {MIN_DIAS_REGRA_CODIGO}+ dia útil;
                  redespacho final (40) com 3+.
                </li>
                <li style={{ color: "var(--warning)" }}>
                  Dúvida para o dono: o código do Pendências usa {MIN_DIAS_REGRA_CODIGO} dia útil; a ajuda dele diz {MIN_DIAS_REGRA_AJUDA}. Esta tela segue o código.
                </li>
                <li>A fila não traz o tipo de documento: não dá para separar devolução e reversa como o Pendências faz.</li>
                <li>
                  Prazo por setor (dias úteis):{" "}
                  {Object.entries(SLA_SETORES)
                    .map(([s, v]) => `${nomeDoSetor(s)} ${v.prazo}/${v.critico}`)
                    .join(", ")}
                  . Agendamento não tem prazo próprio e usa 3/7.
                </li>
              </ul>
            </Bloco>
          </div>
        </Recolhivel>
      </section>
    </div>
  );
}

function Bloco({ titulo, resumo, children }: { titulo: string; resumo?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-[13px] font-semibold text-ink-2">{titulo}</h4>
        {resumo && <span className="text-[12px] text-ink-mute">{resumo}</span>}
      </div>
      {children}
    </section>
  );
}

function MatrizSetorFilial({ r, onFiltrarFilial }: { r: ReturnType<typeof resumirGestao>; onFiltrarFilial?: (u: string) => void }) {
  const filiais = r.porFilial.slice(0, 12);
  const setores = r.porSetor;
  const cel = new Map(r.matriz.map((c) => [`${c.unidade}|${c.setor}`, c]));
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[420px] text-[12px]">
        <thead>
          <tr className="text-ink-mute">
            <th className="px-1 py-1 text-left font-medium">Filial</th>
            {setores.map((s) => (
              <th key={s.setor} className="px-1 py-1 text-right font-medium">
                {s.nome}
              </th>
            ))}
            <th className="px-1 py-1 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {filiais.map((f) => (
            <tr key={f.unidade} className="border-t border-rule">
              <td className="px-1 py-1.5">
                {onFiltrarFilial && f.unidade !== SEM_FILIAL ? (
                  <button type="button" onClick={() => onFiltrarFilial(f.unidade)} className="font-semibold text-ink-2 underline decoration-rule-strong underline-offset-[3px] hover:decoration-ink">
                    {f.unidade}
                  </button>
                ) : (
                  <span className="font-semibold text-ink-2">{f.unidade}</span>
                )}
                <span className="ml-1 text-ink-mute">{f.regional}</span>
              </td>
              {setores.map((s) => {
                const c = cel.get(`${f.unidade}|${s.setor}`);
                return (
                  <td key={s.setor} className="tabular px-1 py-1.5 text-right text-ink-2">
                    {c ? (
                      <>
                        {n(c.total)}
                        {c.paradas > 0 && <span style={{ color: "var(--signal-strong)" }}> · {n(c.paradas)}</span>}
                      </>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}
                  </td>
                );
              })}
              <td className="tabular px-1 py-1.5 text-right font-semibold text-ink-2">{n(f.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11.5px] text-ink-mute">
        Total · <span style={{ color: "var(--signal-strong)" }}>paradas há mais de {diasTxt(DIAS_GARGALO)}</span>
        {r.porFilial.length > filiais.length ? `. Mostrando 12 de ${n(r.porFilial.length)} filiais.` : "."}
      </p>
    </div>
  );
}
