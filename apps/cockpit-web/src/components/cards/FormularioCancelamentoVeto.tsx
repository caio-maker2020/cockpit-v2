// =============================================================================
// FormularioCancelamentoVeto — o popup OBRIGATÓRIO do botão vermelho
// (Etapa E do plano 25/08). Confronta o operador com o RACIOCÍNIO do agente
// (não pergunta genérica), estrutura onde ele olhou (incl. telefone fora do
// Cockpit), se a informação existia dentro, e a exceção do cliente (alimenta
// a cerca). A "sugestão certa" NÃO é perguntada — a próxima ação do operador
// no card é capturada automaticamente (trigger mig 355).
// Perguntas extras por ação vêm do banco versionado (perguntas_extras_
// cancelamento) — busca resiliente. Validação local + revalidação na RPC.
// =============================================================================

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  OPCOES_ONDE_OLHOU,
  validarFormularioCancelamento,
  type RespostasCancelamento,
} from "@/lib/acaoAutonomaVeto";

interface PerguntaExtra {
  id: string;
  pergunta: string;
  tipo_resposta: "texto" | "opcoes" | "booleano";
  opcoes: string[] | null;
}

export function FormularioCancelamentoVeto({
  agendamentoId,
  acaoKey,
  motivoAgente,
  onClose,
  onCancelado,
}: {
  agendamentoId: number;
  acaoKey: string | null;
  motivoAgente: string | null;
  onClose: () => void;
  onCancelado: () => void;
}) {
  const [r, setR] = useState<RespostasCancelamento>({
    o_que_leu_errado: "",
    onde_olhou: [],
    info_existe_no_cockpit: "",
    onde_fora: "",
    excecao_cliente: null,
    excecao_qual: "",
    extras: {},
  });
  const [enviando, setEnviando] = useState(false);

  const { data: perguntasExtras = [] } = useQuery({
    queryKey: ["perguntas-extras-cancelamento", acaoKey],
    enabled: !!supabase && !!acaoKey,
    queryFn: async (): Promise<PerguntaExtra[]> => {
      try {
        const { data, error } = await supabase!
          .from("perguntas_extras_cancelamento")
          .select("id, pergunta, tipo_resposta, opcoes")
          .eq("acao_key", acaoKey!)
          .eq("ativa", true);
        if (error) return [];
        return (data ?? []) as PerguntaExtra[];
      } catch {
        return [];
      }
    },
  });

  function toggleOndeOlhou(id: string) {
    setR((prev) => ({
      ...prev,
      onde_olhou: prev.onde_olhou.includes(id)
        ? prev.onde_olhou.filter((x) => x !== id)
        : [...prev.onde_olhou, id],
    }));
  }

  async function enviar() {
    const erro = validarFormularioCancelamento(r);
    if (erro) {
      toast.error(erro);
      return;
    }
    for (const p of perguntasExtras) {
      if (!(r.extras?.[p.id] ?? "").trim()) {
        toast.error(`Responda: ${p.pergunta}`);
        return;
      }
    }
    if (!supabase) return;
    setEnviando(true);
    const { error } = await supabase.rpc("cancelar_acao_autonoma", {
      p_agendamento_id: agendamentoId,
      p_respostas: {
        o_que_leu_errado: r.o_que_leu_errado.trim(),
        onde_olhou: r.onde_olhou,
        info_existe_no_cockpit: r.info_existe_no_cockpit,
        onde_fora: (r.onde_fora ?? "").trim() || null,
        excecao_cliente: r.excecao_cliente,
        excecao_qual: (r.excecao_qual ?? "").trim() || null,
        extras: r.extras ?? {},
      },
    } as never);
    setEnviando(false);
    if (error) {
      toast.error("Falha ao cancelar: " + error.message);
      return;
    }
    onCancelado();
  }

  const labelInput =
    "mb-1 block font-mono text-[9px] uppercase tracking-wider text-ink-soft";
  const inputCls =
    "w-full border border-ink/30 bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto border border-ink/20 bg-paper shadow-xl">
        <div className="flex items-center justify-between border-b border-ink/10 bg-red-50 px-4 py-2.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-red-900">
            Cancelar ação autônoma
          </span>
          <button type="button" onClick={onClose} className="font-mono text-[12px] text-ink-soft hover:text-ink">
            ✕
          </button>
        </div>

        <div className="space-y-4 px-4 py-3">
          <p className="text-[11.5px] leading-snug text-ink-soft">
            Suas respostas treinam o robô — quanto mais exato, menos ele erra da próxima vez.
            A ação que você fizer em seguida neste card vira automaticamente “a correção”.
          </p>

          {/* 1 — confronta com o raciocínio do agente */}
          <div>
            <label className={labelInput}>
              1 · O agente sugeriu esta ação porque:
            </label>
            <div className="mb-1.5 border-l-2 border-violet-400 bg-violet-50/50 px-2 py-1.5 text-[11.5px] italic text-ink">
              {motivoAgente ?? "(motivo do agente indisponível)"}
            </div>
            <label className={labelInput}>
              O que ele leu errado? <span className="text-red-600">*</span>
            </label>
            <textarea
              value={r.o_que_leu_errado}
              onChange={(e) => setR({ ...r, o_que_leu_errado: e.target.value })}
              rows={2}
              maxLength={500}
              placeholder="Ex: Cliente só pediu pra aguardar, não confirmou endereço/data — não era pra liberar reentrega."
              className={cn(inputCls, "resize-y")}
              autoFocus
            />
          </div>

          {/* 2 — onde olhou */}
          <div>
            <label className={labelInput}>
              2 · Onde você olhou pra saber? <span className="text-red-600">*</span>
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {OPCOES_ONDE_OLHOU.map((o) => (
                <label
                  key={o.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 border px-2 py-1.5 text-[11.5px]",
                    r.onde_olhou.includes(o.id)
                      ? "border-ink bg-ink/[0.04] text-ink"
                      : "border-ink/20 text-ink-soft hover:border-ink/40",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={r.onde_olhou.includes(o.id)}
                    onChange={() => toggleOndeOlhou(o.id)}
                    className="accent-ink"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          {/* 3 — info existe dentro do Cockpit? */}
          <div>
            <label className={labelInput}>
              3 · A informação que o agente precisava existe DENTRO do Cockpit?{" "}
              <span className="text-red-600">*</span>
            </label>
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink">
                <input
                  type="radio"
                  name="info-cockpit"
                  checked={r.info_existe_no_cockpit === "sim_interpretou_errado"}
                  onChange={() => setR({ ...r, info_existe_no_cockpit: "sim_interpretou_errado" })}
                  className="accent-ink"
                />
                Sim — estava aqui, o agente interpretou errado
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink">
                <input
                  type="radio"
                  name="info-cockpit"
                  checked={r.info_existe_no_cockpit === "nao_so_fora"}
                  onChange={() => setR({ ...r, info_existe_no_cockpit: "nao_so_fora" })}
                  className="accent-ink"
                />
                Não — só existia fora do Cockpit
              </label>
              {r.info_existe_no_cockpit === "nao_so_fora" && (
                <input
                  value={r.onde_fora ?? ""}
                  onChange={(e) => setR({ ...r, onde_fora: e.target.value })}
                  placeholder="Onde? Ex: ligação com o cliente, sistema da filial…"
                  className={inputCls}
                />
              )}
            </div>
          </div>

          {/* 4 — exceção do cliente */}
          <div>
            <label className={labelInput}>
              4 · É uma exceção DESTE cliente? <span className="text-red-600">*</span>
            </label>
            <div className="flex gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink">
                <input
                  type="radio"
                  name="excecao"
                  checked={r.excecao_cliente === true}
                  onChange={() => setR({ ...r, excecao_cliente: true })}
                  className="accent-ink"
                />
                Sim
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink">
                <input
                  type="radio"
                  name="excecao"
                  checked={r.excecao_cliente === false}
                  onChange={() => setR({ ...r, excecao_cliente: false })}
                  className="accent-ink"
                />
                Não
              </label>
            </div>
            {r.excecao_cliente === true && (
              <input
                value={r.excecao_qual ?? ""}
                onChange={(e) => setR({ ...r, excecao_qual: e.target.value })}
                placeholder="Qual? Ex: este cliente exige autorização por telefone antes de qualquer reentrega."
                className={cn(inputCls, "mt-1.5")}
              />
            )}
          </div>

          {/* extras por ação (banco versionado) */}
          {perguntasExtras.map((p, idx) => (
            <div key={p.id}>
              <label className={labelInput}>
                {5 + idx} · {p.pergunta} <span className="text-red-600">*</span>
              </label>
              {p.tipo_resposta === "opcoes" && Array.isArray(p.opcoes) ? (
                <select
                  value={r.extras?.[p.id] ?? ""}
                  onChange={(e) => setR({ ...r, extras: { ...(r.extras ?? {}), [p.id]: e.target.value } })}
                  className={inputCls}
                >
                  <option value="">— escolha —</option>
                  {p.opcoes.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={r.extras?.[p.id] ?? ""}
                  onChange={(e) => setR({ ...r, extras: { ...(r.extras ?? {}), [p.id]: e.target.value } })}
                  className={inputCls}
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 border-t border-ink/10 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Voltar
          </button>
          <button
            type="button"
            onClick={enviar}
            disabled={enviando}
            className="bg-red-600 px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:bg-red-700 disabled:opacity-40"
          >
            {enviando ? "Cancelando…" : "Cancelar ação autônoma →"}
          </button>
        </div>
      </div>
    </div>
  );
}
