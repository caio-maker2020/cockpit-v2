// =============================================================================
// Peças reutilizáveis das telas da Operação que seguem o fluxo da torre:
//   - FaixaTorre: a faixa de 5 etapas (agente lê → regras → especialistas → conselheiro → você);
//   - LinhaMetricas: números numa linha só, sem cartão por número;
//   - Recolhivel: detalhe atrás de um clique (o painel nasce fechado);
//   - AvisosConselheiro: lista curta de avisos com UMA ação cada;
//   - baixarTexto: baixa um CSV no navegador (não grava nada em lugar nenhum).
// Mesma linguagem visual da TorreOperacao: tokens ink/rule/surface, sem azul, números tabulares.
// =============================================================================
import { useId, useState } from "react";
import { AlertTriangle, ArrowRight, ChevronDown, Info, ShieldCheck } from "lucide-react";

import { n } from "@/lib/operacao/formatoTela";
import { cn } from "@/lib/utils";

export function Rotulo({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium text-ink-mute">{children}</div>;
}

// --------------------------------------------------------------------------- faixa da torre

export interface EtapaFaixa {
  titulo: string;
  valor: string;
  nota: string;
  /** Linha extra curta (ex.: "3 em dúvida"), em tom de atenção. */
  alerta?: string | null;
}

/**
 * A sequência da torre em 5 passos, encadeada com setas (cada camada passa para a próxima).
 * No celular vira uma lista vertical, um passo por linha. A última etapa (você) ganha o
 * destaque e, com `onUltima`, vira botão (rola até a lista de trabalho).
 */
export function FaixaTorre({ etapas, rotulo, onUltima }: { etapas: readonly EtapaFaixa[]; rotulo: string; onUltima?: () => void }) {
  return (
    <ol className="flex flex-col overflow-hidden rounded-[14px] border border-rule bg-surface sm:flex-row" aria-label={rotulo}>
      {etapas.map((e, i) => {
        const ultima = i === etapas.length - 1;
        const conteudo = (
          <>
            <span className="min-w-0 text-[12px] font-medium leading-tight text-ink-soft-2 sm:block sm:text-[11.5px]">{e.titulo}</span>
            <span className="ml-auto flex items-baseline gap-x-1 sm:ml-0 sm:mt-1">
              <span className="tabular text-[17px] font-semibold leading-none text-ink-2 sm:text-[22px]">{e.valor}</span>
              <span className="text-[11.5px] text-ink-mute">{e.nota}</span>
            </span>
            {e.alerta && (
              <span className="basis-full text-[11px] font-medium leading-tight sm:mt-1 sm:block" style={{ color: "var(--warning)" }}>
                {e.alerta}
              </span>
            )}
          </>
        );
        const caixa = cn(
          "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 px-3 py-2 text-left sm:block sm:px-3.5 sm:py-2.5",
          ultima && "bg-[var(--signal-softer)]",
        );
        return (
          <li key={e.titulo} className={cn("relative flex min-w-0 flex-1 items-stretch", i > 0 && "border-t border-rule sm:border-l sm:border-t-0")}>
            {ultima && onUltima ? (
              <button
                type="button"
                onClick={onUltima}
                className={cn(caixa, "transition-colors hover:bg-[var(--signal-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]")}
                style={{ boxShadow: "inset 0 0 0 1.5px var(--signal-border)" }}
              >
                {conteudo}
              </button>
            ) : (
              <div className={caixa}>{conteudo}</div>
            )}
            {!ultima && (
              <span
                className="absolute -right-[9px] top-1/2 z-10 hidden h-[18px] w-[18px] -translate-y-1/2 place-items-center rounded-full border border-rule bg-surface sm:grid"
                aria-hidden
              >
                <ArrowRight className="h-3 w-3 text-ink-mute" />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// --------------------------------------------------------------------------- métricas em linha

export interface Metrica {
  rotulo: string;
  valor: string;
  tom?: "normal" | "atencao" | "critico";
}

const COR_TOM = { normal: undefined, atencao: "var(--warning)", critico: "var(--signal-strong)" } as const;

export function LinhaMetricas({ itens }: { itens: readonly Metrica[] }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px]">
      {itens.map((m) => (
        <div key={m.rotulo} className="flex items-baseline gap-1.5">
          <dt className="text-ink-mute">{m.rotulo}</dt>
          <dd className="tabular font-semibold text-ink-2" style={{ color: COR_TOM[m.tom ?? "normal"] }}>
            {m.valor}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// --------------------------------------------------------------------------- recolhível

export function Recolhivel({
  titulo,
  resumo,
  children,
  inicial = false,
}: {
  titulo: string;
  /** Uma linha ao lado do título (ex.: "12 notas"). */
  resumo?: string;
  children: React.ReactNode;
  inicial?: boolean;
}) {
  const [aberto, setAberto] = useState(inicial);
  const id = useId();
  return (
    <section className="border-t border-rule first:border-t-0">
      <button
        type="button"
        aria-expanded={aberto}
        aria-controls={id}
        onClick={() => setAberto((a) => !a)}
        className="flex w-full items-center gap-2 py-3 text-left transition-colors hover:text-ink"
      >
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-ink-mute transition-transform duration-150", !aberto && "-rotate-90")} aria-hidden />
        <span className="text-[13.5px] font-semibold text-ink-2">{titulo}</span>
        {resumo && <span className="ml-auto truncate pl-3 text-[12px] text-ink-mute">{resumo}</span>}
      </button>
      {aberto && (
        <div id={id} className="pb-4 pl-6">
          {children}
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------- barras simples

export function Barras({ itens }: { itens: readonly { rotulo: string; valor: number; cor: string }[] }) {
  const max = Math.max(1, ...itens.map((i) => i.valor));
  return (
    <ul className="space-y-1.5">
      {itens.map((i) => (
        <li key={i.rotulo} className="grid grid-cols-[112px_minmax(0,1fr)_40px] items-center gap-2 text-[12px]">
          <span className="truncate text-ink-soft-2">{i.rotulo}</span>
          <span className="h-2 overflow-hidden rounded-full bg-[var(--bg-muted)]" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${i.valor ? Math.max(2, (i.valor / max) * 100) : 0}%`, background: i.cor }} />
          </span>
          <span className="tabular text-right font-semibold text-ink-2">{n(i.valor)}</span>
        </li>
      ))}
    </ul>
  );
}

// --------------------------------------------------------------------------- conselheiro

export interface AvisoCurto {
  id: string;
  tom: "critico" | "atencao" | "info";
  titulo: string;
  detalhe: string;
  acao?: { rotulo: string; onClick: () => void } | null;
}

const TOM_AVISO = {
  critico: { Icone: AlertTriangle, cor: "var(--signal-strong)", bg: "var(--signal-softer)", borda: "var(--signal-border)" },
  atencao: { Icone: AlertTriangle, cor: "var(--warning)", bg: "var(--warning-soft)", borda: "rgba(201,138,27,0.35)" },
  info: { Icone: Info, cor: "var(--c-ink-soft)", bg: "var(--bg-subtle)", borda: "var(--c-border)" },
} as const;

export function AvisosConselheiro({ avisos, vazio = "Nada fora do normal agora.", rodape }: { avisos: readonly AvisoCurto[]; vazio?: string; rodape?: React.ReactNode }) {
  return (
    <section aria-label="Conselheiro" className="rounded-[16px] border border-rule bg-surface p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-ink-2" aria-hidden />
        <h3 className="text-[15px] font-semibold text-ink-2">Conselheiro</h3>
      </div>
      {avisos.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-ink-soft-2">{vazio}</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {avisos.map((a) => {
            const t = TOM_AVISO[a.tom];
            return (
              <li key={a.id} className="rounded-[12px] border px-3 py-2.5" style={{ background: t.bg, borderColor: t.borda }}>
                <div className="flex items-start gap-2">
                  <t.Icone className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: t.cor }} aria-hidden />
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold leading-snug text-ink-2">{a.titulo}</div>
                    <p className="mt-0.5 text-[12px] leading-snug text-ink-soft-2" style={{ textWrap: "pretty" }}>
                      {a.detalhe}
                    </p>
                    {a.acao && (
                      <button
                        type="button"
                        onClick={a.acao.onClick}
                        className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold text-ink-2 underline decoration-rule-strong underline-offset-[3px] hover:decoration-ink"
                      >
                        {a.acao.rotulo}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rodape && <div className="mt-3 border-t border-rule pt-2.5 text-[12px] leading-snug text-ink-mute">{rodape}</div>}
    </section>
  );
}

// --------------------------------------------------------------------------- botões

export function BotaoPrincipal({ onClick, children, disabled, rotulo }: { onClick: () => void; children: React.ReactNode; disabled?: boolean; rotulo?: string }) {
  return (
    <button
      type="button"
      aria-label={rotulo}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] bg-sal px-3.5 text-[12.5px] font-semibold text-white transition-[background-color,transform] duration-150 hover:bg-sal/90 active:scale-[0.97] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function BotaoSecundario({ onClick, children, rotulo }: { onClick: () => void; children: React.ReactNode; rotulo?: string }) {
  return (
    <button
      type="button"
      aria-label={rotulo}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-rule bg-surface px-3 text-[12px] font-semibold text-ink-2 transition-[background-color,transform] duration-150 hover:bg-[var(--bg-subtle)] active:scale-[0.97]"
    >
      {children}
    </button>
  );
}
