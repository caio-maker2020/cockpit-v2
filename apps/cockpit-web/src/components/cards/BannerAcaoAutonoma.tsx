// =============================================================================
// BannerAcaoAutonoma — o card do TRILHO AUTÔNOMO no detalhe (Etapa E, 25/08).
//
// Mostra: contagem regressiva (alvo absoluto do backend), a ação exata, a
// explicação didática ("pessoa de 15 anos"), o CONTEÚDO completo do que vai
// acontecer (texto SSW / template+destinatário do e-mail / anexos), e as 3
// escolhas do operador:
//   1. não fazer nada  → executa no fim da contagem;
//   2. EDITAR o texto  → RPC editar_acao_autonoma (contagem continua; hash
//      recalculado com a MESMA hashDaProposta do processador);
//   3. CANCELAR (vermelho) → FormularioCancelamentoVeto → RPC.
//
// Busca do espelho é RESILIENTE: antes da mig 353 aplicada nada renderiza e
// o detalhe segue exatamente como hoje (risco 1).
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { CardRow } from "@/lib/types";
import {
  emJanelaDeVeto,
  explicacaoDidatica,
  hashDaProposta,
  rotuloCountdown,
  urgenciaCountdown,
  type AcaoAutonomaEspelho,
} from "@/lib/acaoAutonomaVeto";
import { FormularioCancelamentoVeto } from "./FormularioCancelamentoVeto";
import { EditarEmailModal, type PreviewEmailRpcResponse } from "./EditarEmailModal";

interface TodoDaJanela {
  id: string;
  status: string;
  proposta_payload: {
    tool?: string;
    acao_key?: string;
    rationale?: string;
    args?: {
      codigo_ssw?: number;
      descricao?: string;
      template_id?: string | null;
      email_destino?: string | null;
      extras?: Record<string, unknown>;
    };
    meta?: {
      anexos_sugeridos?: Array<{ anexo_id: string; filename: string | null; motivo: string }>;
    };
  } | null;
}

const ROTULO_ACAO: Record<string, string> = {
  "lancar_ocorrencia:21": "Liberar reentrega (oc 21)",
  "lancar_ocorrencia:54": "Re-aguardar cliente (oc 54, sem e-mail)",
  "lancar_ocorrencia:55": "Autorizar entrega parcial (oc 55)",
  "lancar_ocorrencia:59": "Re-aguardar indenização (oc 59, sem e-mail)",
  "lancar_oc_e_enviar_email:54": "Lançar oc 54 + e-mail ao cliente",
  "lancar_oc_e_enviar_email:59": "Lançar oc 59 + e-mail ao cliente",
  "ignorar_e_aguardar:54": "Ignorar e continuar aguardando (oc 54)",
  "ignorar_e_aguardar:59": "Ignorar e continuar aguardando (oc 59)",
  "lancar_ocorrencia:56": "Pedir informação à Operação (oc 56, texto do agente)",
  "lancar_oc33_solo_portal:33": "Abrir indenização (oc 33) com os anexos listados",
};

/** MODO DEMONSTRAÇÃO (?demo_veto=1): renderiza o banner REAL com dados
 *  fictícios pro Caio validar o visual ANTES das migs — nada é gravado
 *  (o formulário abre de verdade, mas o enviar só mostra um toast). */
function espelhoDemo(): AcaoAutonomaEspelho {
  return {
    agendamento_id: -1,
    acao_key: "lancar_oc_e_enviar_email:54",
    executar_em: new Date(Date.now() + 42 * 60000).toISOString(),
    status: "pendente",
    hash_proposta: "demo",
    processed_at: null,
    cancelado_motivo: null,
  };
}
function previewEmailDemo(cardId: string): PreviewEmailRpcResponse {
  return {
    todo_id: "demo",
    card_id: cardId,
    nf: "123456 (exemplo)",
    codigo_ssw_proposta: 54,
    cod_ultima_ocorrencia_card: 10,
    email_destino: "logistica@clienteexemplo.com.br",
    template_atual: {
      id: "COBRANCA_LEMBRETE",
      nome: "Cobrança de lembrete",
      descricao: "Cliente ainda não respondeu a tratativa",
      assunto_renderizado: "[Sal Express] Re: NF 123456 — aguardando seu retorno",
      corpo_renderizado:
        "Olá Maria,\n\nTudo bem? Estou retomando o assunto da NF 123456 — ainda não recebi seu retorno sobre os dados da reentrega.\n\nPra eu seguir com a tratativa, preciso da confirmação do endereço e da data.\n\nAguardo um retorno seu.\n\nIsabely\nSal Express — Relacionamento",
      usa_link_evidencia: false,
    },
    templates_disponiveis: [
      { id: "COBRANCA_LEMBRETE", nome: "Cobrança de lembrete", descricao: "" },
    ],
  };
}

const TODO_DEMO: TodoDaJanela = {
  id: "demo",
  status: "pendente",
  proposta_payload: {
    tool: "lancar_oc_e_enviar_email",
    acao_key: "lancar_oc_e_enviar_email:54",
    rationale:
      "Cliente respondeu sem confirmar os dados da reentrega — manter aguardando e cobrar a informação que falta antes de liberar.",
    args: {
      codigo_ssw: 54,
      descricao: "AGUARDANDO RETORNO DO CLIENTE SOBRE ENDERECO DA REENTREGA",
      template_id: "COBRANCA_LEMBRETE",
      email_destino: "logistica@clienteexemplo.com.br",
    },
    meta: {},
  },
};

export function BannerAcaoAutonoma({ card }: { card: CardRow }) {
  const demo =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("demo_veto");
  const qc = useQueryClient();
  const [agora, setAgora] = useState(() => Date.now());
  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [mostrarEmail, setMostrarEmail] = useState(false);
  const [salvandoEmail, setSalvandoEmail] = useState(false);
  const [editandoTexto, setEditandoTexto] = useState<string | null>(null);
  const [salvandoEdicao, setSalvandoEdicao] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Espelho resiliente (coluna pode não existir antes da mig 353).
  const { data: espelhoReal } = useQuery({
    queryKey: ["acao-autonoma-espelho", card.id],
    enabled: !!supabase && !demo,
    refetchInterval: 60_000,
    queryFn: async (): Promise<AcaoAutonomaEspelho | null> => {
      try {
        const { data, error } = await supabase!
          .from("cards").select("acao_autonoma").eq("id", card.id).maybeSingle();
        if (error) return null;
        return ((data as { acao_autonoma?: AcaoAutonomaEspelho | null } | null)?.acao_autonoma) ?? null;
      } catch {
        return null;
      }
    },
  });

  const espelho = demo ? espelhoDemo() : espelhoReal;
  const ativo = emJanelaDeVeto(espelho);

  const { data: janelaReal } = useQuery({
    queryKey: ["acao-autonoma-janela", card.id, espelho?.agendamento_id ?? null],
    enabled: !!supabase && ativo && espelho != null && !demo,
    queryFn: async (): Promise<{ todoId: string | null; todo: TodoDaJanela | null }> => {
      const { data: ag } = await supabase!
        .from("acoes_agendadas").select("payload")
        .eq("id", espelho!.agendamento_id).maybeSingle();
      const todoId = ((ag as { payload?: { todo_id?: string } } | null)?.payload?.todo_id) ?? null;
      if (!todoId) return { todoId: null, todo: null };
      const { data: todo } = await supabase!
        .from("todos").select("id, status, proposta_payload").eq("id", todoId).maybeSingle();
      return { todoId, todo: (todo as TodoDaJanela | null) ?? null };
    },
  });

  const janela = demo ? { todoId: "demo", todo: TODO_DEMO } : janelaReal;
  const pl = janela?.todo?.proposta_payload ?? null;
  const acaoKey = espelho?.acao_key ?? null;
  const ehEmail = (acaoKey ?? "").includes("email");
  const textoSsw = pl?.args?.descricao ?? (pl?.args?.extras?.["texto_descricao"] as string | undefined) ?? null;
  const anexosSugeridos = pl?.meta?.anexos_sugeridos ?? [];
  const urg = urgenciaCountdown(espelho?.executar_em ?? null, agora);
  const codigoDaAcao = (() => {
    const n = Number((acaoKey ?? "").split(":").pop());
    return Number.isFinite(n) ? n : null;
  })();

  const motivoAgente = useMemo(() => {
    return (
      pl?.rationale ??
      (card as { aviso_alteracao_oc?: { motivo?: string } | null }).aviso_alteracao_oc?.motivo ??
      card.ia_sugestao_oc_resposta?.motivo ??
      null
    );
  }, [pl, card]);

  if (!ativo || !espelho) return null;

  async function salvarEdicaoTexto() {
    if (!supabase || editandoTexto == null || !janela?.todo) return;
    if (demo) {
      toast.info("Modo demonstração — a edição não foi gravada.");
      setEditandoTexto(null);
      return;
    }
    setSalvandoEdicao(true);
    // O hash é calculado sobre o payload FINAL exatamente como a RPC vai
    // salvá-lo (merge raso em args, meta intocado — mig 355). O processador
    // recomputa no vencimento com a MESMA função (paridade travada por teste);
    // qualquer divergência devolve pro humano — fail-safe, nunca às cegas.
    const plAtual = janela.todo.proposta_payload ?? {};
    const payloadFinal = {
      ...plAtual,
      args: { ...(plAtual.args ?? {}), descricao: editandoTexto },
    };
    const { error } = await supabase.rpc("editar_acao_autonoma", {
      p_agendamento_id: espelho!.agendamento_id,
      p_campo: "texto_descricao",
      p_args_patch: { descricao: editandoTexto },
      p_novo_hash: hashDaProposta(payloadFinal),
    } as never);
    setSalvandoEdicao(false);
    if (error) {
      toast.error("Falha ao salvar edição: " + error.message);
      return;
    }
    toast.success("Texto atualizado — a contagem continua e executa a versão editada.");
    setEditandoTexto(null);
    qc.invalidateQueries({ queryKey: ["acao-autonoma-janela", card.id] });
    qc.invalidateQueries({ queryKey: ["acao-autonoma-espelho", card.id] });
  }

  // Edição do E-MAIL na janela (INV-041 emendado: a janela É o olhar — o
  // operador lê e edita o e-mail COMPLETO; quem envia é o motor no vencimento).
  // As edições viajam pro MESMO canal da aprovação (args.extras — semântica
  // mig 226): texto_email_customizado/assunto_override/email_destinatarios/
  // template_id_override são honrados pelo executor.
  async function salvarEmailEditado(extras: Record<string, unknown>) {
    if (demo) {
      toast.info("Modo demonstração — o e-mail editado não foi gravado.");
      setMostrarEmail(false);
      return;
    }
    if (!supabase || !janela?.todo) return;
    setSalvandoEmail(true);
    const plAtual = janela.todo.proposta_payload ?? {};
    const extrasAntigos = ((plAtual.args as { extras?: Record<string, unknown> } | undefined)?.extras) ?? {};
    const extrasNovos = { ...extrasAntigos, ...extras };
    const payloadFinal = {
      ...plAtual,
      args: { ...(plAtual.args ?? {}), extras: extrasNovos },
    };
    const { error } = await supabase.rpc("editar_acao_autonoma", {
      p_agendamento_id: espelho!.agendamento_id,
      p_campo: "email",
      p_args_patch: { extras: extrasNovos },
      p_novo_hash: hashDaProposta(payloadFinal),
    } as never);
    setSalvandoEmail(false);
    if (error) {
      toast.error("Falha ao salvar o e-mail: " + error.message);
      return;
    }
    toast.success("E-mail atualizado — a contagem continua e o robô envia a versão editada.");
    setMostrarEmail(false);
    qc.invalidateQueries({ queryKey: ["acao-autonoma-janela", card.id] });
    qc.invalidateQueries({ queryKey: ["acao-autonoma-espelho", card.id] });
  }

  return (
    <div
      className={cn(
        "mx-6 mt-3 border-l-[3px] bg-paper",
        urg === "critica" ? "border-red-600" : urg === "alta" ? "border-amber-500" : "border-violet-500",
      )}
      data-banner-acao-autonoma
    >
      <div className="flex items-center justify-between gap-3 border-b border-ink/10 bg-violet-50/60 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-widest text-violet-900">
            ⏱ Ação autônoma
          </span>
          {/* A OCORRÊNCIA em destaque — é a informação nº 1 do banner */}
          {codigoDaAcao != null && (
            <span className="shrink-0 bg-violet-700 px-2 py-0.5 font-mono text-[13px] font-bold uppercase tracking-wider text-white">
              oc {codigoDaAcao}
            </span>
          )}
          <span className="truncate text-[14px] font-semibold leading-snug text-ink">
            {ROTULO_ACAO[acaoKey ?? ""] ?? acaoKey}
          </span>
          {demo && (
            <span className="shrink-0 border border-amber-500 bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest text-amber-900">
              demonstração — nada será executado
            </span>
          )}
        </div>
        <span
          className={cn(
            "border px-2 py-0.5 font-mono text-[11px] font-bold",
            urg === "critica"
              ? "border-red-500 bg-red-50 text-red-900"
              : urg === "alta"
                ? "border-amber-500 bg-amber-50 text-amber-900"
                : "border-violet-400 bg-white text-violet-900",
          )}
        >
          {rotuloCountdown(espelho.executar_em, agora)}
        </span>
      </div>

      <div className="space-y-2 px-4 py-3">
        <p className="text-[12.5px] leading-relaxed text-ink">{explicacaoDidatica(acaoKey)}</p>

        {motivoAgente && (
          <p className="text-[11.5px] leading-snug text-ink-soft">
            <span className="font-mono text-[9px] uppercase tracking-wider text-ink-mute">por quê: </span>
            {motivoAgente}
          </p>
        )}

        {/* Conteúdo completo do que vai acontecer (risco 7 — nada às cegas) */}
        <div className="space-y-1.5 border border-ink/10 bg-ink/[0.02] px-3 py-2">
          <div className="font-mono text-[9px] uppercase tracking-wider text-ink-mute">
            o que vai acontecer exatamente
          </div>
          {ehEmail && (
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink">
              <span>
                <span className="text-ink-soft">E-mail pra: </span>
                <span className="font-mono">{pl?.args?.email_destino ?? "—"}</span>
                <span className="text-ink-soft"> · template: </span>
                <span className="font-mono">{pl?.args?.template_id ?? "—"}</span>
              </span>
              <button
                type="button"
                onClick={() => setMostrarEmail(true)}
                className="border border-violet-400 bg-white px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-violet-900 hover:bg-violet-100"
              >
                ✉️ Ver / editar o e-mail completo
              </button>
            </div>
          )}
          {textoSsw != null && editandoTexto == null && (
            <div className="text-[11.5px] text-ink">
              <span className="text-ink-soft">Texto no SSW: </span>
              <span className="whitespace-pre-wrap">{textoSsw}</span>
            </div>
          )}
          {editandoTexto != null && (
            <div>
              <textarea
                value={editandoTexto}
                onChange={(e) => setEditandoTexto(e.target.value)}
                rows={3}
                maxLength={500}
                className="w-full resize-y border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink"
              />
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={salvarEdicaoTexto}
                  disabled={salvandoEdicao}
                  className="bg-ink px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper disabled:opacity-40"
                >
                  {salvandoEdicao ? "Salvando…" : "Salvar edição"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditandoTexto(null)}
                  className="border border-ink/30 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-ink"
                >
                  Descartar
                </button>
              </div>
            </div>
          )}
          {anexosSugeridos.length > 0 && (
            <div className="text-[11.5px] text-ink">
              <span className="text-ink-soft">Anexos que vão pro sistema: </span>
              {anexosSugeridos.map((a) => a.filename ?? a.anexo_id).join(" · ")}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-[10.5px] text-ink-mute">
            Certo? Não precisa fazer nada. Precisa de ajuste? Edite. Errado? Cancele.
          </div>
          <div className="flex gap-2">
            {textoSsw != null && editandoTexto == null && (
              <button
                type="button"
                onClick={() => setEditandoTexto(textoSsw)}
                className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:border-ink"
              >
                Editar texto
              </button>
            )}
            <button
              type="button"
              onClick={() => setMostrarFormulario(true)}
              className="bg-red-600 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:bg-red-700"
            >
              ✕ Cancelar ação autônoma
            </button>
          </div>
        </div>
      </div>

      {mostrarEmail && janela?.todoId && (
        <EditarEmailModal
          todoId={janela.todoId}
          modoJanelaVeto
          previewInicial={demo ? previewEmailDemo(card.id) : null}
          submitting={salvandoEmail}
          onClose={() => setMostrarEmail(false)}
          onConfirm={salvarEmailEditado}
        />
      )}

      {mostrarFormulario && (
        <FormularioCancelamentoVeto
          agendamentoId={espelho.agendamento_id}
          acaoKey={acaoKey}
          demo={demo}
          motivoAgente={motivoAgente}
          onClose={() => setMostrarFormulario(false)}
          onCancelado={() => {
            setMostrarFormulario(false);
            qc.invalidateQueries({ queryKey: ["acao-autonoma-espelho", card.id] });
            qc.invalidateQueries({ queryKey: ["card", card.id] });
            qc.invalidateQueries({ queryKey: ["inbox", "cards"] });
            toast.success("Ação autônoma cancelada. O card voltou pro fluxo normal — sua próxima ação vira o aprendizado do robô.");
          }}
        />
      )}
    </div>
  );
}
