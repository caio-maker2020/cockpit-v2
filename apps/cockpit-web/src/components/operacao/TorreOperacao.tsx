// =============================================================================
// Torre da Operação — as camadas da torre de agentes, para o OPERADOR:
// agente principal (topo), regras da Sal (firme × dúvida), especialistas por
// família, conselheiro (lateral), e o registro do turno (rodapé). Tudo derivado
// da fila (lib/operacao/torre.ts). Nenhum botão daqui grava: os cliques só
// focam a fila de trabalho logo abaixo; gravar continua sendo a prévia + confirmar.
// =============================================================================
import { AlertTriangle, ArrowRight, CheckCircle2, Info, MousePointerClick, ShieldCheck, Users, X } from "lucide-react";

import { dotClass } from "@/components/cockpit/tones";
import { familiaPorId } from "@/lib/operacao/familias";
import type { AvisoConselheiro, EventoTurno, FocoTorre, ResumoTorre } from "@/lib/operacao/torre";
import { cn } from "@/lib/utils";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const n = (v: number) => v.toLocaleString("pt-BR");

function Rotulo({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium text-ink-mute">{children}</div>;
}

// --------------------------------------------------------------------------- 1. Agente principal

export function AgentePrincipal({
  resumo,
  papel,
  avisos,
  children,
}: {
  resumo: ResumoTorre;
  papel: string;
  avisos: number;
  children?: React.ReactNode;
}) {
  const comVoce = resumo.duvidas + resumo.semSugestao;
  const etapas: { titulo: string; valor: string; nota: string; ativa?: boolean }[] = [
    { titulo: "Agente lê a fila", valor: n(resumo.total), nota: resumo.total === 1 ? "nota" : "notas", ativa: true },
    { titulo: "Regras da Sal", valor: n(resumo.firmesAcao + resumo.firmesAguardar), nota: "firmes" },
    { titulo: "Especialistas", valor: n(resumo.especialistas.filter((e) => e.total > 0).length), nota: "trabalhando" },
    { titulo: "Conselheiro", valor: n(avisos), nota: avisos === 1 ? "aviso" : "avisos" },
    { titulo: "Você confirma", valor: n(comVoce + resumo.firmesAcao), nota: "com você" },
  ];
  return (
    <section aria-label="Resumo do turno" className="px-4 pb-5 pt-5 md:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-mute">
        <span className="relative inline-flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sal opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-sal" />
        </span>
        Agente principal · {papel}
        {children}
      </div>
      <div className="mt-2 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,620px)] xl:items-end">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold leading-tight text-ink-2" style={{ letterSpacing: "-0.01em", textWrap: "balance" }}>
            Como a torre está trabalhando agora
          </h2>
          {resumo.total > 0 && (
            <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-ink-soft-2" style={{ textWrap: "pretty" }}>
              {resumo.lidaEm ? `Li a fila às ${hhmm(resumo.lidaEm)}. ` : ""}
              <strong className="font-semibold text-ink-2">{n(resumo.firmesAcao)}</strong> prontas para 1 clique,{" "}
              <strong className="font-semibold text-ink-2">{n(resumo.firmesAguardar)}</strong> seguem sozinhas e{" "}
              <strong className="font-semibold" style={{ color: "var(--signal-strong)" }}>
                {n(comVoce)} precisam de você
              </strong>
              . {resumo.paradasMais1d > 0 ? `${n(resumo.paradasMais1d)} estão paradas há mais de 1 dia.` : ""}
            </p>
          )}
        </div>
        {/* A sequência da torre: é ordem de verdade (cada camada passa para a próxima). */}
        <ol className="grid grid-cols-5 overflow-hidden rounded-[14px] border border-rule bg-surface" aria-label="Como a torre trabalha">
          {etapas.map((e, i) => (
            <li key={e.titulo} className={cn("relative min-w-0 px-2.5 py-2.5 sm:px-3.5", i > 0 && "border-l border-rule", i === etapas.length - 1 && "bg-[var(--signal-softer)]")}>
              <div className="flex items-center gap-1 text-[10.5px] font-medium leading-tight text-ink-soft-2 sm:text-[11.5px]">
                <span className="min-w-0">{e.titulo}</span>
                {i < etapas.length - 1 && <ArrowRight className="hidden h-3 w-3 shrink-0 text-ink-mute sm:block" aria-hidden />}
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-1">
                <span className="tabular text-[18px] font-semibold leading-none text-ink-2 sm:text-[22px]">{e.valor}</span>
                <span className="text-[10.5px] text-ink-mute sm:text-[11.5px]">{e.nota}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------- 2. Regras da Sal

const COR_CERTEZA = {
  alta: { barra: "var(--positive)", rotulo: "Certeza alta" },
  media: { barra: "var(--warning)", rotulo: "Certeza média" },
  baixa: { barra: "var(--signal)", rotulo: "Certeza baixa" },
} as const;

export function RegrasDaSal({ resumo, foco, onFoco }: { resumo: ResumoTorre; foco: FocoTorre; onFoco: (f: FocoTorre) => void }) {
  const firmes = resumo.firmesAcao + resumo.firmesAguardar;
  const duvida = resumo.duvidas + resumo.semSugestao;
  const totalCerteza = resumo.certeza.alta + resumo.certeza.media + resumo.certeza.baixa;
  const ativo = (id: "firme" | "duvida") => foco?.tipo === "decisao" && foco.id === id;
  return (
    <section aria-labelledby="regras-titulo" className="rounded-[16px] border border-rule bg-surface p-4 shadow-[0_1px_2px_rgba(27,36,48,0.04)]">
      <Rotulo>Camada de decisão</Rotulo>
      <h2 id="regras-titulo" className="mt-1 text-[17px] font-semibold text-ink-2">
        Regras da Sal
      </h2>
      <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft-2" style={{ textWrap: "pretty" }}>
        Regra firme, aprendida com o histórico da Sal: a nota já vem pronta. Na dúvida, o agente analisa ou pergunta a você.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <button
          type="button"
          aria-pressed={ativo("firme")}
          onClick={() => onFoco(ativo("firme") ? null : { tipo: "decisao", id: "firme" })}
          className={cn(
            "rounded-[12px] border p-3 text-left transition-[border-color,background-color] duration-150 hover:bg-[var(--bg-subtle)] active:scale-[0.98]",
            ativo("firme") ? "border-ink bg-[var(--bg-subtle)]" : "border-rule",
          )}
        >
          <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--positive)" }}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Firme
          </div>
          <div className="tabular mt-1 text-[24px] font-semibold leading-none text-ink-2">{n(firmes)}</div>
          <div className="mt-1 text-[11.5px] leading-snug text-ink-soft-2">
            {n(resumo.firmesAcao)} para 1 clique · {n(resumo.firmesAguardar)} seguem sozinhas
          </div>
        </button>
        <button
          type="button"
          aria-pressed={ativo("duvida")}
          onClick={() => onFoco(ativo("duvida") ? null : { tipo: "decisao", id: "duvida" })}
          className={cn(
            "rounded-[12px] border p-3 text-left transition-[border-color,background-color] duration-150 hover:bg-[var(--bg-subtle)] active:scale-[0.98]",
            ativo("duvida") ? "border-ink bg-[var(--bg-subtle)]" : "border-rule",
          )}
        >
          <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
            <Users className="h-3.5 w-3.5" aria-hidden /> Dúvida
          </div>
          <div className="tabular mt-1 text-[24px] font-semibold leading-none text-ink-2">{n(duvida)}</div>
          <div className="mt-1 text-[11.5px] leading-snug text-ink-soft-2">
            {resumo.semSugestao > 0 ? `${n(resumo.semSugestao)} sem regra · ` : ""}você decide
          </div>
        </button>
      </div>

      {totalCerteza > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-semibold text-ink-2">Certeza das sugestões</div>
          <ul className="mt-2 space-y-2">
            {(["alta", "media", "baixa"] as const).map((k) => {
              const v = resumo.certeza[k];
              const w = totalCerteza ? Math.max(v > 0 ? 2 : 0, (v / totalCerteza) * 100) : 0;
              return (
                <li key={k} className="grid grid-cols-[96px_minmax(0,1fr)_40px] items-center gap-2 text-[12px]">
                  <span className="text-ink-soft-2">{COR_CERTEZA[k].rotulo}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-[var(--bg-muted)]" aria-hidden>
                    <span className="block h-full rounded-full" style={{ width: `${w}%`, background: COR_CERTEZA[k].barra }} />
                  </span>
                  <span className="tabular text-right font-semibold text-ink-2">{n(v)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------- 3. Especialistas

const STATUS_ESPECIALISTA = {
  livre: { rotulo: "Livre", bg: "var(--bg-subtle)", cor: "var(--c-ink-soft)" },
  trabalhando: { rotulo: "Em dia", bg: "var(--positive-soft)", cor: "var(--positive)" },
  precisa_voce: { rotulo: "Aguardando você", bg: "var(--signal-soft)", cor: "var(--signal-strong)" },
} as const;

export function Especialistas({ resumo, foco, onFoco }: { resumo: ResumoTorre; foco: FocoTorre; onFoco: (f: FocoTorre) => void }) {
  return (
    <section aria-labelledby="especialistas-titulo">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <Rotulo>Agentes especialistas</Rotulo>
          <h2 id="especialistas-titulo" className="mt-1 text-[17px] font-semibold text-ink-2">
            Um agente por tipo de problema
          </h2>
        </div>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-2.5 2xl:grid-cols-3">
        {resumo.especialistas.map((e) => {
          const f = familiaPorId(e.id);
          const st = STATUS_ESPECIALISTA[e.status];
          const ativo = foco?.tipo === "familia" && foco.id === e.id;
          const partes = [
            { v: e.prontas, cor: "var(--positive)", nome: "prontas" },
            { v: e.aguardando, cor: "var(--c-ink-disabled)", nome: "seguem sozinhas" },
            { v: e.duvidas, cor: "var(--signal)", nome: "com você" },
            { v: e.emAndamento, cor: "var(--warning)", nome: "em andamento" },
          ];
          return (
            <li key={e.id}>
              <button
                type="button"
                aria-pressed={ativo}
                disabled={e.total === 0}
                onClick={() => onFoco(ativo ? null : { tipo: "familia", id: e.id })}
                data-testid={`especialista-${e.id}`}
                className={cn(
                  "flex h-full w-full flex-col rounded-[14px] border bg-surface p-3.5 text-left transition-[border-color,box-shadow] duration-150 hover:shadow-[0_2px_8px_rgba(27,36,48,0.08)] active:scale-[0.99] disabled:cursor-default disabled:opacity-60 disabled:hover:shadow-none",
                  ativo ? "border-ink shadow-[0_0_0_1px_hsl(var(--ink))]" : "border-rule",
                )}
              >
                <div className="flex flex-col-reverse items-start gap-1.5 sm:flex-row sm:justify-between sm:gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass[f.tom])} aria-hidden />
                    <span className="min-w-0 text-[13px] font-semibold leading-tight text-ink-2 sm:text-[13.5px]">{e.titulo}</span>
                  </div>
                  <span className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ background: st.bg, color: st.cor }}>
                    {st.rotulo}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="tabular text-[22px] font-semibold leading-none text-ink-2">{n(e.total)}</span>
                  <span className="text-[12px] text-ink-mute">{e.total === 1 ? "nota" : "notas"}</span>
                </div>
                <p className="mb-2.5 mt-1.5 text-[12px] leading-snug text-ink-soft-2" style={{ textWrap: "pretty" }}>
                  {e.frase}
                </p>
                {e.total > 0 && (
                  <span className="mt-auto flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-muted)] pt-0" aria-label={partes.filter((p) => p.v).map((p) => `${p.v} ${p.nome}`).join(", ")}>
                    {partes.map((p) => (p.v > 0 ? <span key={p.nome} style={{ width: `${(p.v / e.total) * 100}%`, background: p.cor }} /> : null))}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-mute" aria-hidden>
        {[
          ["var(--positive)", "pronta para 1 clique"],
          ["var(--c-ink-disabled)", "segue sozinha"],
          ["var(--signal)", "com você"],
          ["var(--warning)", "em andamento"],
        ].map(([cor, t]) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-3 rounded-full" style={{ background: cor }} />
            {t}
          </span>
        ))}
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------- 4. Conselheiro + 5. Você confirma

const TOM_AVISO = {
  critico: { Icone: AlertTriangle, cor: "var(--signal-strong)", bg: "var(--signal-softer)", borda: "var(--signal-border)" },
  atencao: { Icone: AlertTriangle, cor: "var(--warning)", bg: "var(--warning-soft)", borda: "rgba(201,138,27,0.35)" },
  info: { Icone: Info, cor: "var(--c-ink-soft)", bg: "var(--bg-subtle)", borda: "var(--c-border)" },
} as const;

export function Conselheiro({
  avisos,
  foco,
  onFoco,
  demo,
}: {
  avisos: AvisoConselheiro[];
  foco: FocoTorre;
  onFoco: (f: FocoTorre) => void;
  demo: boolean;
}) {
  return (
    <aside aria-labelledby="conselheiro-titulo" className="flex flex-col gap-3">
      <section className="rounded-[16px] border border-rule bg-surface p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-ink-2" aria-hidden />
          <h2 id="conselheiro-titulo" className="text-[15px] font-semibold text-ink-2">
            Conselheiro
          </h2>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-soft-2">Revisa antes de gravar e avisa o que se repete.</p>
        {avisos.length === 0 ? (
          <p className="mt-3 rounded-[10px] bg-[var(--bg-subtle)] px-3 py-2.5 text-[12.5px] text-ink-soft-2">Nada fora do normal agora.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {avisos.map((a) => {
              const t = TOM_AVISO[a.tom];
              const ativo = foco?.tipo === "itens" && foco.rotulo === a.titulo;
              return (
                <li key={a.id} className="rounded-[12px] border px-3 py-2.5" style={{ background: t.bg, borderColor: ativo ? "hsl(var(--ink))" : t.borda }}>
                  <div className="flex items-start gap-2">
                    <t.Icone className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: t.cor }} aria-hidden />
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold leading-snug text-ink-2">{a.titulo}</div>
                      <p className="mt-0.5 text-[12px] leading-snug text-ink-soft-2" style={{ textWrap: "pretty" }}>
                        {a.detalhe}
                      </p>
                      <button
                        type="button"
                        onClick={() => onFoco(ativo ? null : { tipo: "itens", ids: a.itens, rotulo: a.titulo })}
                        className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold text-ink-2 underline decoration-rule-strong underline-offset-[3px] hover:decoration-ink"
                      >
                        {ativo ? "Mostrar todas" : a.itens.length === 1 ? "Ver a nota" : `Ver as ${n(a.itens.length)} notas`}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="voce-titulo" className="rounded-[16px] border p-4" style={{ background: "var(--signal-softer)", borderColor: "var(--signal-border)" }}>
        <div className="flex items-center gap-2">
          <MousePointerClick className="h-4 w-4" style={{ color: "var(--signal-strong)" }} aria-hidden />
          <h2 id="voce-titulo" className="text-[15px] font-semibold text-ink-2">
            De volta a você
          </h2>
        </div>
        <ol className="mt-2 space-y-1.5 text-[12.5px] leading-snug text-ink-soft-2">
          <li>
            <strong className="font-semibold text-ink-2">1.</strong> Abra a nota e leia a sugestão e o porquê.
          </li>
          <li>
            <strong className="font-semibold text-ink-2">2.</strong> Veja a prévia: é exatamente o que vai ser gravado.
          </li>
          <li>
            <strong className="font-semibold text-ink-2">3.</strong> Confirme. Sem o seu clique, nada é gravado.
          </li>
        </ol>
        {demo && (
          <p className="mt-2.5 border-t pt-2.5 text-[11.5px] leading-snug" style={{ borderColor: "var(--signal-border)", color: "var(--signal-strong)" }}>
            Demonstração: a confirmação fica só neste navegador. Nada vai ao SSW nem ao Relacionamento.
          </p>
        )}
      </section>
    </aside>
  );
}

// --------------------------------------------------------------------------- foco ativo

export function FaixaFoco({ foco, onLimpar, visiveis }: { foco: FocoTorre; onLimpar: () => void; visiveis: number }) {
  if (!foco) return null;
  const rotulo =
    foco.tipo === "familia"
      ? `Agente de ${familiaPorId(foco.id).titulo.toLowerCase()}`
      : foco.tipo === "itens"
        ? foco.rotulo
        : foco.id === "firme"
          ? "Sugestões firmes"
          : foco.id === "duvida"
            ? "Dúvidas para você decidir"
            : "Sem regra";
  return (
    <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full border border-ink bg-ink px-3 py-1 text-[12px] text-white" data-testid="foco-torre">
      <span className="truncate">
        Mostrando: <strong className="font-semibold">{rotulo}</strong> · {n(visiveis)}
      </span>
      <button type="button" onClick={onLimpar} className="-mr-1 rounded-full p-0.5 hover:bg-white/15" aria-label="Mostrar a fila toda">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------- 6. Registro do turno

const COR_EVENTO = { operador: "bg-ink", agente: "bg-sal", sistema: "bg-rule-strong" } as const;

export function RegistroDoTurno({ eventos }: { eventos: EventoTurno[] }) {
  return (
    <section aria-labelledby="registro-titulo" className="border-t border-rule bg-[var(--bg-subtle)] px-5 py-5 md:px-7">
      <Rotulo>Registro do turno</Rotulo>
      <h2 id="registro-titulo" className="mt-1 text-[15px] font-semibold text-ink-2">
        O que aconteceu
      </h2>
      {eventos.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-soft-2">Nada registrado neste turno ainda.</p>
      ) : (
        <ol className="mt-3 grid gap-x-8 gap-y-2 lg:grid-cols-2">
          {eventos.map((e) => (
            <li key={e.id} className="grid grid-cols-[44px_10px_minmax(0,1fr)] items-baseline gap-2 text-[12.5px]">
              <time className="tabular font-mono text-[11.5px] text-ink-mute" dateTime={e.em}>
                {hhmm(e.em)}
              </time>
              <span className={cn("h-1.5 w-1.5 translate-y-[-1px] rounded-full", COR_EVENTO[e.tipo])} aria-hidden />
              <span className="leading-snug text-ink-soft-2">
                <strong className="font-semibold text-ink-2">{e.quem}</strong> {e.texto}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
