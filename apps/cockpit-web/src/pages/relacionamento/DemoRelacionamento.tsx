// =============================================================================
// Demonstração do Relacionamento (build `--mode demo-rel`, /relacionamento-cockpit/).
// DADOS FICTÍCIOS em memória: a MESMA tela do Inbox (TelaRelacionamento + KanbanCard),
// com um painel de card simplificado no lugar do card real (que precisa do banco).
// Aprovar abre a prévia → "c" confirma → o card vai para "Enviadas" → abre o próximo.
// Nada vai ao Cockpit real nem ao SSW.
// =============================================================================
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Clock, Send, X } from "lucide-react";
import { toast } from "sonner";

import { KanbanCard } from "@/components/cards/KanbanCard";
import { TelaRelacionamento } from "@/components/relacionamento/TelaRelacionamento";
import type { DonoFiltro, TipoCteFiltro } from "@/components/relacionamento/BarraRelacionamento";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { SalLogo } from "@/components/SalLogo";
import { OC_DEMO, cardsDemoRel } from "@/lib/relacionamento/demo/dadosDemoRel";
import { ROTULO_CERTEZA, agruparInbox, avisosRel, nivelDaConfianca, rotuloTipo, type CardInbox } from "@/lib/relacionamento/torre";
import { ALL_TIPOS, type CardRisco, type CardTipo } from "@/lib/types";
import { cn } from "@/lib/utils";

const COR_CERTEZA = { alta: "var(--positive)", media: "var(--warning)", baixa: "var(--signal)" } as const;
const relativo = (iso: string) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 0) return `em ${Math.abs(min)} min`;
  if (min < 60) return `há ${min} min`;
  const hh = Math.floor(min / 60);
  return hh < 24 ? `há ${hh} h` : `há ${Math.floor(hh / 24)} d`;
};

export default function DemoRelacionamento() {
  const [cards, setCards] = useState<CardInbox[]>(() => cardsDemoRel());
  const [aberto, setAberto] = useState<string | null>(null);
  const [ordem, setOrdem] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [cliente, setCliente] = useState("");
  const [ocs, setOcs] = useState<number[]>([]);
  const [risco, setRisco] = useState<CardRisco | "todos">("todos");
  const [tipos, setTipos] = useState<CardTipo[]>(ALL_TIPOS);
  const [tipoCte, setTipoCte] = useState<TipoCteFiltro>("todos");
  const [dono, setDono] = useState<DonoFiltro>("todos");

  const visiveis = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return cards.filter(
      (c) =>
        (!t || [c.nf, c.ctrc, c.empresa_cliente].some((v) => (v ?? "").toLowerCase().includes(t))) &&
        (!cliente || c.empresa_cliente === cliente) &&
        (ocs.length === 0 || (c.cod_ultima_ocorrencia != null && ocs.includes(c.cod_ultima_ocorrencia))) &&
        (risco === "todos" || c.risco === risco) &&
        (tipos.length === ALL_TIPOS.length || (c.tipo != null && tipos.includes(c.tipo))) &&
        (tipoCte === "todos" || c.tipo_cte === tipoCte) &&
        (dono === "todos" || (dono === "sem_dono" ? !c.assigned_operator_id : c.assigned_operator_id === "op-Larissa")),
    );
  }, [cards, busca, cliente, ocs, risco, tipos, tipoCte, dono]);
  const grupos = useMemo(() => agruparInbox(visiveis, null), [visiveis]);
  const clientes = useMemo(() => [...new Set(cards.map((c) => c.empresa_cliente!).filter(Boolean))].sort(), [cards]);
  const ocsDisp = useMemo(() => [...new Set(cards.map((c) => c.cod_ultima_ocorrencia!).filter((x) => x != null))].sort((a, b) => a - b), [cards]);
  const parado = (c: CardInbox) => Date.now() - Date.parse(c.last_event_at ?? c.updated_at) > 34 * 3_600_000;
  const avisos = useMemo(() => avisosRel(visiveis, parado), [visiveis]);

  const card = aberto ? cards.find((c) => c.id === aberto) ?? null : null;
  const i = aberto ? ordem.indexOf(aberto) : -1;
  const abrir = (id: string, o: string[]) => {
    if (o.length) setOrdem(o);
    setAberto(id);
  };
  const proximo = (depoisDe: string) => {
    const j = ordem.indexOf(depoisDe);
    const prox = ordem.slice(j + 1)[0] ?? null;
    setAberto(prox);
  };

  const atualizar = (id: string, f: (c: CardInbox) => CardInbox) => setCards((cs) => cs.map((c) => (c.id === id ? f(c) : c)));

  return (
    <div className="flex h-[calc(100vh-24px)] flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule px-4 md:px-6">
        <SalLogo size={16} />
        <span className="rounded-full bg-[var(--bg-muted)] px-2.5 py-0.5 text-[12.5px] font-semibold text-ink-2">Relacionamento</span>
        <span className="ml-auto text-[12px] text-ink-mute">Logada como Larissa (fictícia)</span>
      </header>
      <div className="min-h-0 flex-1">
        <TelaRelacionamento
          dados={{
            cards: visiveis,
            grupos,
            mostrarTrilho: true,
            isLoading: false,
            isError: false,
            isFetching: false,
            refetch: () => undefined,
            truncado: false,
            limite: 1000,
            stats: {
              ativos: visiveis.length,
              resolvidosHoje: 12,
              aguardandoSsw: grupos.get("acao_executada")?.length ?? 0,
              slaRisco: visiveis.filter((c) => c.risco === "alto").length,
            },
            saudacao: `Bom dia, Larissa. ${(grupos.get("validacao")?.length ?? 0) + (grupos.get("cliente_respondeu")?.length ?? 0)} cards aguardam sua ação.`,
            paradoMais1dUtil: parado,
          }}
          filtros={{ busca, cliente, ocs, risco, tipos, tipoCte, dono }}
          setters={{ setBusca, setCliente, setOcs, setRisco, setTipos, setTipoCte, setDono }}
          clientes={clientes}
          ocsDisponiveis={ocsDisp}
          labelOc={(c) => OC_DEMO[c] ?? ""}
          isGestor
          renderCard={(c) => <KanbanCard card={c} pendentes={c.pendentes_count} onAbrir={(id) => abrir(id, ordem)} />}
          onAbrirCard={abrir}
          onOrdem={setOrdem}
          demo
          selecionadoExterno={aberto}
          painelDetalhe={
            card && (
              <PainelCardDemo
                key={card.id}
                card={card}
                aviso={avisos.find((a) => a.tom !== "info" && a.cards.includes(card.id)) ?? null}
                posicao={i >= 0 ? `${i + 1} de ${ordem.length}` : null}
                onAnterior={i > 0 ? () => setAberto(ordem[i - 1]!) : undefined}
                onProximo={i >= 0 && i < ordem.length - 1 ? () => setAberto(ordem[i + 1]!) : undefined}
                onFechar={() => setAberto(null)}
                onAprovado={(oc) => {
                  atualizar(card.id, (c) => ({
                    ...c,
                    state: "ACAO_EXECUTADA",
                    aprovacao_modo: "humana",
                    acao_executada_em: new Date().toISOString(),
                    cod_ultima_ocorrencia: oc,
                    acao_autonoma: null,
                    pendentes_count: 0,
                  }));
                  toast.success(`NF ${card.nf}: ocorrência ${oc} registrada (demonstração, nada foi ao SSW).`);
                  proximo(card.id);
                }}
                onRecusado={(motivo) => {
                  atualizar(card.id, (c) => ({ ...c, state: "AGUARDANDO_AGENTE", aprovacao_modo: null, ia_sugestao_oc_resposta: null, pendentes_count: 0 }));
                  toast.success(`Proposta recusada: “${motivo}”. O agente refaz (demonstração).`);
                  proximo(card.id);
                }}
                onCancelarRobo={() => {
                  atualizar(card.id, (c) => ({ ...c, acao_autonoma: null, aprovacao_modo: null, pendentes_count: 1 }));
                  toast.success("Ação do robô cancelada: o card volta para você (demonstração).");
                }}
              />
            )
          }
        />
      </div>
    </div>
  );
}

function PainelCardDemo({
  card,
  aviso,
  posicao,
  onAnterior,
  onProximo,
  onFechar,
  onAprovado,
  onRecusado,
  onCancelarRobo,
}: {
  card: CardInbox;
  aviso: ReturnType<typeof avisosRel>[number] | null;
  posicao: string | null;
  onAnterior?: () => void;
  onProximo?: () => void;
  onFechar: () => void;
  onAprovado: (oc: number) => void;
  onRecusado: (motivo: string) => void;
  onCancelarRobo: () => void;
}) {
  const [previa, setPrevia] = useState(false);
  const [recusando, setRecusando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const ia = card.ia_sugestao_oc_resposta;
  const nivel = nivelDaConfianca(ia?.confianca);
  const robo = card.acao_autonoma?.status === "pendente";
  const validar = card.state === "AGUARDANDO_VALIDACAO_HUMANA" && !robo;
  const ocProposta = ia?.oc_sugerida ?? null;

  const Fato = ({ r, children }: { r: string; children: React.ReactNode }) => (
    <div className="min-w-0">
      <div className="text-[11.5px] text-ink-mute">{r}</div>
      <div className="mt-0.5 break-words text-[13.5px] text-ink-2">{children}</div>
    </div>
  );

  return (
    <aside
      className="fixed inset-0 z-30 flex flex-col overflow-y-auto bg-surface lg:static lg:z-auto lg:w-[460px] lg:shrink-0 lg:border-l lg:border-rule"
      aria-label="Card aberto"
      data-testid="painel-card-demo"
    >
      <div className="sticky top-0 z-10 border-b border-rule bg-surface/95 px-5 pb-3 pt-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onFechar} aria-label="Voltar ao trabalho" className="-ml-1.5 grid h-8 w-8 place-items-center rounded-[8px] text-ink-mute hover:bg-[var(--bg-subtle)] lg:hidden">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="text-[12px] font-medium text-ink-soft-2">{rotuloTipo(card.tipo)}</span>
          <div className="ml-auto flex items-center gap-0.5">
            {posicao && <span className="tabular mr-1 text-[12px] text-ink-mute">{posicao}</span>}
            <button type="button" onClick={onAnterior} disabled={!onAnterior} aria-label="Card anterior (k)" className="grid h-8 w-8 place-items-center rounded-[8px] text-ink-soft-2 hover:bg-[var(--bg-subtle)] disabled:opacity-30">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={onProximo} disabled={!onProximo} aria-label="Próximo card (j)" className="grid h-8 w-8 place-items-center rounded-[8px] text-ink-soft-2 hover:bg-[var(--bg-subtle)] disabled:opacity-30">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={onFechar} aria-label="Fechar" className="hidden h-8 w-8 place-items-center rounded-[8px] text-ink-mute hover:bg-[var(--bg-subtle)] lg:grid">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <h2 className="mt-1 text-[21px] font-semibold leading-tight text-ink-2">{card.empresa_cliente}</h2>
        <div className="text-[12.5px] text-ink-soft-2">
          NF {card.nf} · CTRC {card.ctrc} · base {card.base_destino}
        </div>
      </div>

      {aviso && (
        <div className="px-5 pt-4">
          <div className="flex items-start gap-2 rounded-[12px] border px-3 py-2.5" style={{ background: "var(--warning-soft)", borderColor: "rgba(201,138,27,0.35)" }}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--warning)" }} aria-hidden />
            <div className="text-[12.5px] leading-snug">
              <div className="font-semibold text-ink-2">Conselheiro: {aviso.titulo.charAt(0).toLowerCase() + aviso.titulo.slice(1)}</div>
              <p className="mt-0.5 text-ink-soft-2">{aviso.detalhe}</p>
            </div>
          </div>
        </div>
      )}

      <section className="border-b border-rule px-5 py-4">
        <h3 className="mb-3 text-[14px] font-semibold text-ink-2">O que a torre propõe</h3>
        {robo && card.acao_autonoma?.executar_em ? (
          <div className="rounded-[14px] border p-3.5" style={{ borderColor: "rgba(109,40,217,0.35)", background: "rgba(109,40,217,0.04)" }}>
            <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "#6D28D9" }}>
              <Clock className="h-3.5 w-3.5" aria-hidden /> Regra firme · o robô vai agir {relativo(card.acao_autonoma.executar_em)}
            </div>
            <p className="mt-1.5 text-[13.5px] text-ink-2">Se ninguém vetar, o robô lança a ocorrência combinada e avisa o cliente.</p>
            <Button variant="outline" className="mt-3" onClick={onCancelarRobo}>
              Cancelar e decidir eu mesma
            </Button>
          </div>
        ) : validar ? (
          <div className="rounded-[14px] border border-rule p-3.5" data-testid="proposta-demo">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] font-medium">
              <span className="text-ink-soft-2">Dúvida · o agente propõe, você valida</span>
              {nivel && (
                <span className="inline-flex items-center gap-1.5" style={{ color: COR_CERTEZA[nivel] }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: COR_CERTEZA[nivel] }} />
                  {ROTULO_CERTEZA[nivel]}
                </span>
              )}
            </div>
            <div className="mt-2 text-[14px] font-semibold text-ink-2">
              {ocProposta != null ? `Lançar a ocorrência ${ocProposta} · ${OC_DEMO[ocProposta] ?? ""}` : "O agente ainda não tem proposta: decida pelo histórico."}
            </div>
            {ia?.motivo && <p className="mt-1 text-[12.5px] text-ink-soft-2">Por quê: {ia.motivo}</p>}
            {card.acao_falhou_motivo && <p className="mt-1 text-[12.5px]" style={{ color: "var(--signal-strong)" }}>Última tentativa: {card.acao_falhou_motivo}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {ocProposta != null && (
                <Button className="bg-sal text-white hover:bg-sal/90" onClick={() => setPrevia(true)}>
                  Aprovar e ver prévia
                </Button>
              )}
              <Button variant="outline" onClick={() => setRecusando((v) => !v)}>
                Recusar
              </Button>
            </div>
            {recusando && (
              <div className="mt-3 space-y-2">
                <label htmlFor="motivo-recusa" className="block text-[12.5px] font-medium text-ink-2">
                  Por que recusa? (vai para o agente aprender)
                </label>
                <Textarea id="motivo-recusa" rows={2} value={motivo} onChange={(e) => setMotivo(e.target.value)} className="text-[13px]" />
                <Button size="sm" disabled={motivo.trim().length < 5} onClick={() => onRecusado(motivo.trim())}>
                  Confirmar recusa
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="rounded-[10px] bg-[var(--bg-subtle)] px-3 py-2.5 text-[13px] text-ink-soft-2">
            Nada para você decidir agora: {card.state === "AGUARDANDO_CLIENTE" ? "aguardando o cliente responder." : card.state === "ACAO_EXECUTADA" ? "ação lançada, esperando o Bastão confirmar." : "o agente está analisando o caso."}
          </p>
        )}
      </section>

      <section className="px-5 py-4">
        <h3 className="mb-3 text-[14px] font-semibold text-ink-2">O card</h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div className="col-span-2">
            <Fato r="Última ocorrência">
              {card.ocorrencia?.descricao} <span className="text-ink-mute">({card.cod_ultima_ocorrencia})</span>
            </Fato>
          </div>
          <Fato r="Canal">{card.canal_origem === "whatsapp" ? "WhatsApp" : "E-mail"}</Fato>
          <Fato r="Risco">{card.risco === "alto" ? "Alto" : "Baixo"}</Fato>
          <Fato r="Volumes">{card.qtde_volumes}</Fato>
          <Fato r="Com quem">{card.operador?.nome ?? "Sem dono"}</Fato>
          {card.cliente_respondeu_em && <Fato r="Cliente respondeu">{relativo(card.cliente_respondeu_em)}</Fato>}
          <Fato r="Última atividade">{relativo(card.last_event_at ?? card.updated_at)}</Fato>
        </div>
      </section>

      <Dialog open={previa} onOpenChange={setPrevia}>
        <DialogContent
          className="max-w-[540px] rounded-[16px]"
          onKeyDown={(e) => {
            if (e.key === "c" && !(e.target as HTMLElement).closest("input, textarea") && ocProposta != null) {
              e.preventDefault();
              setPrevia(false);
              onAprovado(ocProposta);
            }
          }}
        >
          <DialogHeader>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-mute">Você confirma</div>
            <DialogTitle className="text-[19px]">Confira o que vai para o SSW</DialogTitle>
            <DialogDescription>Demonstração: ao confirmar, o card muda só nesta tela. Nada vai ao SSW nem ao cliente.</DialogDescription>
          </DialogHeader>
          <dl className="rounded-[12px] border border-rule bg-[var(--bg-subtle)] px-4 py-1 text-[13.5px]" data-testid="previa-rel-demo">
            {[
              ["Ocorrência", `oc ${ocProposta} · ${ocProposta != null ? OC_DEMO[ocProposta] ?? "" : ""}`],
              ["NF", card.nf],
              ["CTRC", card.ctrc],
              ["Cliente", card.empresa_cliente],
              ["Texto", ia?.motivo ?? "—"],
            ].map(([r, v]) => (
              <div key={r as string} className="grid grid-cols-[110px,1fr] gap-3 border-b border-rule py-2 last:border-b-0">
                <dt className="text-[12px] text-ink-mute">{r}</dt>
                <dd className="text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11.5px] text-ink-mute">
            Atalhos: <kbd className="rounded border border-rule px-1">c</kbd> confirma · <kbd className="rounded border border-rule px-1">Esc</kbd> volta sem gravar.
          </p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setPrevia(false)}>
              Voltar
            </Button>
            <Button
              className={cn("bg-sal text-white hover:bg-sal/90")}
              onClick={() => {
                setPrevia(false);
                if (ocProposta != null) onAprovado(ocProposta);
              }}
            >
              <Send className="mr-2 h-4 w-4" />
              Confirmar e lançar oc {ocProposta}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
