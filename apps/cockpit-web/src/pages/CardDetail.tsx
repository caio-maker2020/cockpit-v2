import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, Focus } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/lib/supabase";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useModoFoco } from "@/hooks/useModoFoco";
import type { CardState, CardWithRelations } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  useCtrcOverrideStore,
  CTRC_BAIXADO_GUARD_RE,
} from "@/stores/useCtrcOverrideStore";

import { BannerEvidencia } from "@/components/cards/BannerEvidencia";
import { CardIdentification } from "@/components/cards/CardIdentification";
import { ConversationTabs } from "@/components/cards/ConversationTabs";
import { ProposedActions } from "@/components/cards/ProposedActions";
import { TratativaPendenteCard } from "@/components/cards/TratativaPendenteCard";
import { AcaoExecutadaPanel } from "@/components/cards/AcaoExecutadaPanel";

import { BannerSugestaoIA } from "@/components/cards/BannerSugestaoIA";
import { BannerBounceEmail } from "@/components/cards/BannerBounceEmail";
import { BannerMudancaSuspeitaEscopo } from "@/components/cards/BannerMudancaSuspeitaEscopo";
import { BannerEmailPreexistente } from "@/components/cards/BannerEmailPreexistente";
import { SugestaoIATopBox } from "@/components/cards/SugestaoIATopBox";
import { BannerAcaoAutonoma } from "@/components/cards/BannerAcaoAutonoma";
import { PainelDecisao } from "@/components/cards/PainelDecisao";
import { BannerEmailNaoEnviado } from "@/components/cards/BannerEmailNaoEnviado";

import { BotaoBuscarTratativa } from "@/components/cards/BotaoBuscarTratativa";

import { ModalForcarAtualizacao } from "@/components/cards/ModalForcarAtualizacao";



const SELECT_WITH_RELATIONS = `
  *,
  operador:operadores!cards_assigned_operator_id_fkey(nome,papel),
  ocorrencia:ocorrencias_dicionario!cards_cod_ultima_ocorrencia_fkey(descricao,responsabilidade)
`;

const STATE_PILL: Record<string, { label: string; bg: string; fg: string }> = {
  AGUARDANDO_VALIDACAO_HUMANA: { label: "Aguardando você", bg: "bg-sal", fg: "text-paper" },
  AGUARDANDO_CLIENTE: { label: "Aguardando cliente", bg: "bg-warn", fg: "text-ink" },
  AGUARDANDO_AGENTE: { label: "Para fazer", bg: "bg-paper-deep", fg: "text-ink" },
  AGUARDANDO_CONTEXTO: { label: "Aguardando contexto", bg: "bg-paper-deep", fg: "text-ink" },
  AGUARDANDO_VINCULACAO: { label: "Aguardando vinculação", bg: "bg-paper-deep", fg: "text-ink" },
  EM_TRIAGEM: { label: "Em triagem", bg: "bg-paper-deep", fg: "text-ink" },
  EXECUTANDO_ACAO: { label: "Em execução", bg: "bg-good", fg: "text-paper" },
  ACAO_EXECUTADA: { label: "Ação executada", bg: "bg-blue-500", fg: "text-paper" },
  EM_EXECUCAO_AUTOMATICA: { label: "Em execução automática", bg: "bg-good", fg: "text-paper" },
  TRATATIVA_PENDENTE: { label: "Tratativa pendente", bg: "bg-sal-deep", fg: "text-paper" },
  TRANSFERIDO: { label: "Transferido", bg: "bg-ink-soft", fg: "text-paper" },
  RESOLVIDO: { label: "Resolvido", bg: "bg-ink", fg: "text-paper" },
  CANCELADO: { label: "Cancelado", bg: "bg-rule-strong", fg: "text-paper" },
  BLOQUEADO_POR_ERRO: { label: "Bloqueado por erro", bg: "bg-sal", fg: "text-paper" },
  ESCALADO_HUMANO: { label: "Escalado", bg: "bg-sal", fg: "text-paper" },
  AGUARDANDO_TERCEIRO: { label: "Aguardando terceiro", bg: "bg-warn", fg: "text-ink" },
  RECEBIDO: { label: "Recebido", bg: "bg-paper-deep", fg: "text-ink" },
};

function BotaoVoltarToDo({ cardId }: { cardId: string }) {
  const qc = useQueryClient();
  const [carregando, setCarregando] = useState(false);

  async function handle() {
    if (!supabase) return;
    const { data: todoPendente } = await supabase
      .from("todos")
      .select("id")
      .eq("card_id", cardId)
      .eq("status", "pendente")
      .limit(1)
      .maybeSingle();

    if (!todoPendente) {
      toast.error("Sem todos pendentes — nada pra voltar");
      return;
    }

    const motivo = window.prompt("Motivo (opcional):") ?? "";
    if (
      !window.confirm(
        'Voltar card pra "Para Fazer"? As propostas pendentes serão canceladas.',
      )
    )
      return;

    setCarregando(true);
    const { data, error } = await supabase.functions.invoke(
      "voltar-para-to-do-com-rastreio",
      { body: { todo_id: (todoPendente as { id: string }).id, motivo } },
    );
    setCarregando(false);

    if (error || !data?.ok) {
      toast.error(error?.message ?? data?.error ?? "Erro ao voltar pra to-do");
      return;
    }

    toast.success(`Card voltou pra ${data.new_state ?? "to-do"}`);
    qc.invalidateQueries();
  }

  return (
    <button
      onClick={handle}
      disabled={carregando}
      className="border border-ink/20 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
      title="Cancela todas as propostas pendentes e move card pra Para Fazer"
    >
      {carregando ? "..." : "↶ voltar pra to-do"}
    </button>
  );
}

function BotaoAtualizarAgora({ cardId }: { cardId: string }) {
  const qc = useQueryClient();
  const [carregando, setCarregando] = useState(false);

  async function handleAtualizar() {
    if (!supabase) return;
    setCarregando(true);
    const { data, error } = await supabase.functions.invoke("atualizar-card-via-portal-ssw", {
      body: { card_id: cardId },
    });
    setCarregando(false);

    if (error || !data?.ok) {
      toast.error(error?.message ?? data?.error ?? "Erro ao atualizar");
      return;
    }

    if (data.no_action) {
      toast.info(data.motivo ?? `Card em ${data.state_atual} — atualização não aplicável.`);
    } else {
      const oc = data.oc_portal ?? data.oc_tracking ?? data.oc_bastao;
      const mensagemPorDecisao: Record<string, string> = {
        ja_atualizado: "Card já está atualizado — última ocorrência no SSW bate com o card.",
        resolvido: "Última ocorrência no SSW é finalizadora — card encerrado como RESOLVIDO.",
        transferido: `Última ocorrência (${oc}) é de outro setor — card movido pra TRANSFERIDO.`,
        aguardando_voce: `Ocorrência mudou pra ${oc} — card precisa da sua validação.`,
        aguardando_cliente: `Última ocorrência é ${oc} — card foi pra AGUARDANDO CLIENTE.`,
      };
      toast.success(
        mensagemPorDecisao[data.decisao as string] ?? "Card atualizado.",
      );
    }

    qc.invalidateQueries({ queryKey: ["cards"] });
    qc.invalidateQueries({ queryKey: ["card", cardId] });
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={handleAtualizar}
        disabled={carregando}
        className="border border-ink/20 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
      >
        {carregando ? "..." : "↻ Forçar Atualização"}
      </button>
      <span
        tabIndex={0}
        role="button"
        aria-label="O que é Forçar Atualização?"
        title={
          "O que é? Consulta o SSW agora pra confirmar a última ocorrência real dessa NF e decide o destino do card.\n\n" +
          "Pra que serve? Em vez de esperar o sync automático do Bastão (que pode demorar minutos), você força a leitura on-time (~3s) e o card move sozinho pra RESOLVIDO, TRANSFERIDO, AGUARDANDO VOCÊ ou AGUARDANDO CLIENTE conforme o que vier."
        }
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-ink/30 font-mono text-[9px] font-bold text-ink-soft hover:border-ink hover:text-ink"
      >
        ?
      </span>
    </span>
  );
}

function BotaoForcarAtualizacaoPortal({ cardId }: { cardId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="border border-rule-strong bg-sal px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-paper hover:bg-sal-deep"
        title="Consulta o SSW e decide o destino do card (preview antes de aplicar)."
      >
        ↻ Forçar atualização
      </button>
      <ModalForcarAtualizacao cardId={cardId} open={open} onOpenChange={setOpen} />
    </>
  );
}
function ToggleModoFoco() {
  const [ativo, setAtivo] = useModoFoco();
  return (
    <button
      type="button"
      onClick={() => setAtivo(!ativo)}
      aria-pressed={ativo}
      title={
        ativo
          ? "Modo foco ativo — blocos do topo recolhidos. Clique pra expandir."
          : "Recolher banner de conflito + sugestão IA pra trazer as abas pro alto"
      }
      className={cn(
        "inline-flex items-center gap-1 border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
        ativo
          ? "border-ink bg-ink text-paper"
          : "border-ink/20 text-ink-soft hover:border-ink hover:text-ink",
      )}
    >
      <Focus className="h-3 w-3" />
      Modo foco{ativo ? " ✓" : ""}
    </button>
  );
}

function CardStatePill({ state }: { state: CardState }) {
  const s = STATE_PILL[state] ?? { label: state, bg: "bg-rule", fg: "text-ink" };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[20px] border border-rule px-3 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em]",
        s.bg,
        s.fg,
      )}
    >
      {s.label}
    </span>
  );
}

function BannerAcaoFalhou({
  cardId,
  motivo,
}: {
  cardId: string;
  motivo: string;
}) {
  const forcar = useCtrcOverrideStore((s) => !!s.byCard[cardId]);
  const setForcar = useCtrcOverrideStore((s) => s.set);
  const resetForcar = useCtrcOverrideStore((s) => s.reset);
  const mostrarOverride = CTRC_BAIXADO_GUARD_RE.test(motivo);

  // Reset ao trocar de card
  useEffect(() => {
    return () => {
      resetForcar(cardId);
    };
  }, [cardId, resetForcar]);

  return (
    <div className="mx-6 mt-3 border-2 border-yellow-500 bg-yellow-100 px-3 py-2 text-xs text-yellow-900">
      <div className="mb-1 flex items-center gap-2 font-mono font-bold uppercase tracking-wider">
        Ação não foi executada — verifique
      </div>
      <div className="text-[11px] leading-snug">
        A última ação aprovada falhou no SSW. As opções de proposta foram
        restauradas — você pode escolher outra ação ou voltar pra to-do.
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-yellow-800">
          ver detalhe técnico
        </summary>
        <pre className="mt-1 whitespace-pre-wrap bg-yellow-50 p-1.5 text-[10px] text-yellow-900/80">
          {motivo}
        </pre>
      </details>

      {mostrarOverride && (
        <label className="mt-2 flex cursor-pointer items-start gap-2 border-2 border-amber-600 bg-amber-50 px-2.5 py-2 text-amber-950">
          <input
            type="checkbox"
            checked={forcar}
            onChange={(e) => setForcar(cardId, e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-red-600"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-red-700">
              CTRC baixado por devolução — lançar a ocorrência mesmo assim
            </span>
            <span className="text-[10px] leading-snug text-amber-900/90">
              Use só quando o CTRC foi baixado por devolução (oc 30) e a
              tratativa de ressarcimento segue em aberto. As validações de CTRC
              e NF continuam ativas.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

export default function CardDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: card, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["card", id],
    enabled: !!id && !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("cards")
        .select(SELECT_WITH_RELATIONS)
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as CardWithRelations | null;
    },
  });

  useRealtimeInvalidate("cards", ["card", id], id ? `id=eq.${id}` : undefined);

  // HISTÓRICO SEMPRE FRESCO ao abrir o card (Caio 26/08, NF 26033): o alerta
  // "OCORRÊNCIA MUDOU" só é confiável com o SSW de agora — não dá pra esperar
  // o lag do Bastão. Throttle de 10min (historico_ssw_atualizado_em) pra não
  // martelar o SSW; best-effort (falha = fica o histórico que tem); 1x por
  // abertura de card (ref).
  const qcDetail = useQueryClient();
  const refreshDisparadoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!supabase || !card?.id) return;
    if (refreshDisparadoRef.current === card.id) return;
    if (["TRANSFERIDO", "RESOLVIDO", "CANCELADO"].includes(card.state)) return;
    const atualizadoEm = (card as unknown as { historico_ssw_atualizado_em?: string | null })
      .historico_ssw_atualizado_em;
    const idadeMin = atualizadoEm
      ? (Date.now() - new Date(atualizadoEm).getTime()) / 60000
      : Infinity;
    if (idadeMin <= 10) return;
    refreshDisparadoRef.current = card.id;
    supabase.functions
      .invoke("puxar-historico-ssw-card", { body: { card_id: card.id } })
      .then(() => qcDetail.invalidateQueries({ queryKey: ["card", card.id] }))
      .catch(() => {/* best-effort — o alerta usa o histórico que houver */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, card?.state]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center font-display text-[14px] italic text-ink-soft">
        Carregando passagem…
      </div>
    );
  }

  // Erro de carga ≠ card inexistente. `maybeSingle` devolve null SEM erro
  // quando o card de fato não existe (aí "não encontrado" é correto). Quando
  // a query FALHA (rede/RLS/500), dizer "não encontrado" faria o operador
  // achar que a passagem sumiu. Separar os dois, e no erro oferecer retry.
  if (isError) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-rule bg-paper px-6 py-4">
          <Link
            to="/inbox"
            className="mb-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft hover:text-sal"
          >
            <ChevronLeft className="h-3 w-3" />
            Voltar
          </Link>
          <h1 className="font-display text-[20px] font-semibold text-danger">Erro ao carregar o card</h1>
          <p className="mt-1 font-display text-[13px] italic text-ink-soft">
            {(error as Error)?.message ?? "Falha na consulta."} Não quer dizer que o card sumiu; é erro de carga.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 rounded border border-danger/40 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-danger hover:bg-danger/10"
          >
            Tentar novamente
          </button>
        </header>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="flex h-full flex-col">
        <header className="border-b border-rule bg-paper px-6 py-4">
          <Link
            to="/inbox"
            className="mb-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft hover:text-sal"
          >
            <ChevronLeft className="h-3 w-3" />
            Voltar
          </Link>
          <h1 className="font-display text-[20px] font-semibold">Card não encontrado</h1>
        </header>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header com state pill */}
      <header className="border-b border-rule px-7 py-3.5">
        <Link
          to="/inbox"
          className="mb-1.5 inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] hover:underline"
          style={{ color: "var(--signal)" }}
        >
          <ChevronLeft className="h-3 w-3" />
          Voltar ao Inbox
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[24px] font-bold leading-tight text-ink-2">
                {card.empresa_cliente || "Cliente sem identificação"}
              </h1>
              {card.tipo_cte && (
                <span
                  className="rounded-[6px] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase"
                  style={
                    card.tipo_cte === "REVERSA" || card.tipo_cte === "DEVOLUCAO"
                      ? { background: "#FFECE3", color: "#D9480F" }
                      : { background: "var(--bg-muted)", color: "var(--c-ink-soft)" }
                  }
                >
                  {card.tipo_cte}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {card.nome_cliente && (
                <span className="text-[12px] text-ink-soft-2">{card.nome_cliente}</span>
              )}
              <span className="rounded-[6px] bg-muted-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
                NF {card.nf || "—"}
              </span>
              {card.ctrc && (
                <span className="rounded-[6px] bg-muted-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
                  CTRC {card.ctrc}
                </span>
              )}
              {card.qtde_volumes != null && (
                <span className="rounded-[6px] bg-muted-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
                  {card.qtde_volumes} VOL
                </span>
              )}
              {card.cod_ultima_ocorrencia != null && (
                <span className="rounded-[6px] bg-muted-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
                  OC {card.cod_ultima_ocorrencia}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ToggleModoFoco />
            <BotaoBuscarTratativa card={card as unknown as Parameters<typeof BotaoBuscarTratativa>[0]["card"]} />
            {(card.state === "AGUARDANDO_CLIENTE" ||
              card.state === "AGUARDANDO_VALIDACAO_HUMANA") && (
              <>
                <BotaoVoltarToDo cardId={card.id} />
                <BotaoForcarAtualizacaoPortal cardId={card.id} />
              </>
            )}
            {!(card.state === "AGUARDANDO_CLIENTE" ||
              card.state === "AGUARDANDO_VALIDACAO_HUMANA") && (
              <BotaoAtualizarAgora cardId={card.id} />
            )}
            <CardStatePill state={card.state} />
          </div>

        </div>
      </header>

      {/* 1 CARD = 1 DECISÃO (Caio 26/08): o PainelDecisao escolhe o vencedor
          pela tabela de prioridade e colapsa o resto — fim da pilha de banners. */}
      <PainelDecisao
        card={card}
        falhaExtra={card.acao_falhou_motivo
          ? <BannerAcaoFalhou cardId={card.id} motivo={card.acao_falhou_motivo} />
          : undefined}
      />


      {card.sem_chave_cte && (
        <div className="mx-7 mt-3 rounded-[12px] border px-3.5 py-2.5 text-xs" style={{ borderColor: "#F59F00", background: "#FFF4E0", color: "#C98A1B" }}>
          <div className="mb-1 flex items-center gap-2 font-mono font-bold uppercase tracking-wider">
            Chave CT-e ainda não disponível
          </div>
          <div className="text-[11px] leading-snug">
            O lançamento da ocorrência fica bloqueado até a chave aparecer. O sistema retenta automaticamente a cada sync.
          </div>
        </div>
      )}





      {/* 3 colunas — handoff 3a: 320 / 1fr / 400 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[320px_1fr_400px]">
        <div className="overflow-y-auto border-r border-rule bg-surface">
          <CardIdentification card={card} />
        </div>
        <div className="min-w-0 overflow-hidden border-r border-rule bg-surface">
          <ConversationTabs
            card={card}
            initialTab={
              (card as unknown as { mudanca_suspeita?: { tipo?: string; vista_em?: string | null } })
                .mudanca_suspeita?.tipo === "saiu_de_escopo" &&
              !(card as unknown as { mudanca_suspeita?: { vista_em?: string | null } }).mudanca_suspeita
                ?.vista_em
                ? "ssw"
                : undefined
            }
          />

        </div>
        <div className="overflow-y-auto bg-surface">
          {card.state === "TRATATIVA_PENDENTE" ? (
            <TratativaPendenteCard card={card} />
          ) : card.state === "ACAO_EXECUTADA" ? (
            <AcaoExecutadaPanel card={card as any} />
          ) : (
            <ProposedActions card={card} />
          )}
        </div>
      </div>
    </div>
  );
}
