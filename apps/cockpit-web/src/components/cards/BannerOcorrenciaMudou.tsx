// =============================================================================
// BannerOcorrenciaMudou — a faixa VERMELHA "OCORRÊNCIA MUDOU" + RE-ANALISAR JÁ
// (Caio 26/08, caso NF 26033: a oc 13 chegou no SSW no meio da tratativa e a
// operadora quase agiu com contexto velho).
//
// RE-ANALISAR JÁ:
//   1. invoca atualizar-card-via-portal-ssw — o MOTOR DE DESTINO existente:
//      oc fora de relacionamento → TRANSFERIDO (regras de sempre; propostas
//      canceladas → o trigger do veto mata o agendamento junto); finalizadora
//      → RESOLVIDO; relacionamento → AVH/AGUARDANDO_CLIENTE;
//   2. se o card FICOU em relacionamento (AVH), re-roda o agente ocs-padrão
//      ({card_id}) — nova proposta destacada; o agendador do veto SUBSTITUI o
//      agendamento antigo (AcaoAutonomaSubstituida) com decisão fresca.
// Clique = contexto velho morre na hora; resultado chega em segundos via
// realtime. Contrato de latência: ~10–20s (pior caso ~40s com foto).
// =============================================================================

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import type { CardRow } from "@/lib/types";
import { detectarOcorrenciaMudou } from "@/lib/ocorrenciaMudou";

export function BannerOcorrenciaMudou({ card }: { card: CardRow }) {
  const qc = useQueryClient();
  const [reanalisando, setReanalisando] = useState(false);

  const alerta = detectarOcorrenciaMudou(card);
  // Card já fora do fluxo ativo não precisa da faixa (nada a decidir aqui).
  if (!alerta) return null;
  if (["TRANSFERIDO", "RESOLVIDO", "CANCELADO"].includes(card.state)) return null;

  async function reanalisarJa() {
    if (!supabase) return;
    setReanalisando(true);
    try {
      // 1. destino pelas regras (o mesmo motor do "Forçar Atualização")
      const { data, error } = await supabase.functions.invoke("atualizar-card-via-portal-ssw", {
        body: { card_id: card.id },
      });
      if (error || data?.ok === false) {
        toast.error(error?.message ?? data?.error ?? "Falha ao re-analisar");
        return;
      }
      const decisao = (data?.decisao as string | undefined) ?? null;
      const oc = data?.oc_portal ?? data?.oc_tracking ?? data?.oc_bastao ?? alerta!.ocSsw;
      if (decisao === "transferido") {
        toast.success(`Ocorrência ${oc} é de outro setor — card movido pra TRANSFERIDO (regra de sempre).`, { duration: 8000 });
      } else if (decisao === "resolvido") {
        toast.success(`Ocorrência ${oc} é finalizadora — card encerrado como RESOLVIDO.`, { duration: 8000 });
      } else if (decisao === "aguardando_cliente") {
        toast.success(`Card atualizado pra oc ${oc} — foi pra AGUARDANDO CLIENTE.`);
      } else {
        // 2. seguiu em relacionamento → re-análise do agente (proposta fresca;
        // o trilho autônomo substitui o agendamento velho sozinho)
        toast.info(`Card atualizado pra oc ${oc} — re-analisando a sugestão…`);
        const { error: agErr } = await supabase.functions.invoke("agente-sugere-ocs-padrao", {
          body: { card_id: card.id },
        });
        if (agErr) {
          toast.warning("Card atualizado, mas a re-análise do agente falhou — as ações atuais podem estar defasadas: revise antes de aprovar.");
        } else {
          toast.success("Re-análise concluída — sugestões e contagem atualizadas.");
        }
      }
      qc.invalidateQueries({ queryKey: ["card", card.id] });
      qc.invalidateQueries({ queryKey: ["todos-pendentes", card.id] });
      qc.invalidateQueries({ queryKey: ["acao-autonoma-espelho", card.id] });
      qc.invalidateQueries({ queryKey: ["inbox", "cards"] });
      qc.invalidateQueries({ queryKey: ["cards"] });
    } finally {
      setReanalisando(false);
    }
  }

  return (
    <div
      className="mx-6 mt-3 flex items-center justify-between gap-3 border-l-4 border-red-600 bg-red-50 px-4 py-3"
      data-banner-oc-mudou
    >
      <div className="min-w-0">
        <div className="font-mono text-[11px] font-bold uppercase tracking-widest text-red-800">
          ⚠️ Ocorrência mudou
        </div>
        <div className="mt-0.5 text-[13px] font-semibold leading-snug text-red-950">
          O card diz oc {alerta.ocCard} — o SSW já está em{" "}
          <span className="bg-red-600 px-1.5 py-0.5 font-mono text-white">oc {alerta.ocSsw}</span>{" "}
          ({alerta.descricaoSsw || "sem descrição"}, {alerta.dataSsw}).
        </div>
        <div className="mt-0.5 text-[11.5px] text-red-900/80">
          Revise antes de agir — as sugestões e ações abaixo podem estar defasadas.
        </div>
      </div>
      <button
        type="button"
        onClick={reanalisarJa}
        disabled={reanalisando}
        className="shrink-0 bg-red-600 px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-white hover:bg-red-700 disabled:opacity-50"
      >
        {reanalisando ? "Re-analisando…" : "⟳ Re-analisar já"}
      </button>
    </div>
  );
}
