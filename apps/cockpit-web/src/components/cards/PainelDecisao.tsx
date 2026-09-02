// =============================================================================
// PainelDecisao — "1 CARD = 1 DECISÃO" (Caio 26/08). Substitui a PILHA de até
// 9 banners do CardDetail: renderiza EM DESTAQUE só o vencedor da tabela de
// prioridade (lib painelDecisao) e guarda o resto numa seção colapsada
// "outros avisos". Modo foco: só o vencedor, mais nada.
//
// Os banners existentes NÃO foram reescritos — continuam donos da própria
// lógica (queries, botões, RPCs); aqui só se decide QUEM aparece aberto.
// Banner novo no futuro: adicionar na tabela de prioridade da lib + um case
// aqui — nunca empilhar de novo.
// =============================================================================

import { useState, type ReactNode as React_ReactNode } from "react";
type ReactNode = React_ReactNode;
import type { CardRow, CardWithRelations } from "@/lib/types";
import { useModoFoco } from "@/hooks/useModoFoco";
import { escolherVencedor, outrosAvisos, type VencedorPainel } from "@/lib/painelDecisao";

import { BannerOcorrenciaMudou } from "./BannerOcorrenciaMudou";
import { BannerAcaoAutonoma } from "./BannerAcaoAutonoma";
import { BannerBounceEmail } from "./BannerBounceEmail";
import { BannerEmailNaoEnviado } from "./BannerEmailNaoEnviado";
import { SugestaoIATopBox } from "./SugestaoIATopBox";
import { BannerSugestaoIA } from "./BannerSugestaoIA";
import { BannerEmailPreexistente } from "./BannerEmailPreexistente";
import { BannerMudancaSuspeitaEscopo } from "./BannerMudancaSuspeitaEscopo";
import { BannerEvidencia } from "./BannerEvidencia";
// Devolução com CT-e (ADR 0018). Entra nos avisos de CONTEXTO, não na tabela de
// prioridade: a decisão do card é a proposta de oc 44, que renderiza na lista de
// ações. Autocontido (query própria), no mesmo padrão dos dois vizinhos.
import { BannerDevolucaoCte } from "./BannerDevolucaoCte";

/** Blocos por sinal — o vencedor renderiza este conjunto; os demais vão pros
 *  "outros". (Um sinal pode ter mais de um banner-irmão, ex.: falha = motivo
 *  da falha + bounce.) */
function BlocosDoSinal({ sinal, card, falhaExtra }: {
  sinal: Exclude<VencedorPainel, null>;
  card: CardWithRelations;
  falhaExtra?: ReactNode;
}) {
  switch (sinal) {
    case "oc_mudou":
      return <BannerOcorrenciaMudou card={card} />;
    case "acao_autonoma":
      return <BannerAcaoAutonoma card={card} />;
    case "falha":
      return (
        <>
          {falhaExtra}
          <BannerEmailNaoEnviado cardId={card.id} acaoFalhouMotivo={card.acao_falhou_motivo} />
          <BannerBounceEmail card={card} />
        </>
      );
    case "sugestao_resposta":
      return <SugestaoIATopBox card={card} />;
    case "sugestao_padrao":
      return <BannerSugestaoIA card={card as unknown as Parameters<typeof BannerSugestaoIA>[0]["card"]} />;
  }
}

export function PainelDecisao({ card, falhaExtra }: {
  card: CardWithRelations;
  /** Bloco extra do sinal de falha (ex.: BannerAcaoFalhou, componente local do CardDetail). */
  falhaExtra?: ReactNode;
}) {
  const [modoFoco] = useModoFoco();
  const [mostrarOutros, setMostrarOutros] = useState(false);

  const vencedor = escolherVencedor(card as CardRow);
  const nOutros = outrosAvisos(card as CardRow);

  const TODOS: Exclude<VencedorPainel, null>[] = [
    "oc_mudou", "acao_autonoma", "falha", "sugestao_resposta", "sugestao_padrao",
  ];
  const secundarios = TODOS.filter((s) => s !== vencedor);

  return (
    <div data-painel-decisao>
      {/* O VENCEDOR — a decisão do card, em destaque */}
      {vencedor && <BlocosDoSinal sinal={vencedor} card={card} falhaExtra={falhaExtra} />}

      {/* Avisos de contexto que independem de prioridade (leves, 1 linha) */}
      {!modoFoco && (
        <>
          <BannerMudancaSuspeitaEscopo
            cardId={card.id}
            mudanca={(card as unknown as { mudanca_suspeita?: Parameters<typeof BannerMudancaSuspeitaEscopo>[0]["mudanca"] }).mudanca_suspeita}
          />
          <BannerEvidencia card={card as unknown as Parameters<typeof BannerEvidencia>[0]["card"]} />
          <BannerDevolucaoCte cardId={card.id} />
        </>
      )}

      {/* OUTROS AVISOS — colapsados; modo foco esconde de vez */}
      {!modoFoco && (nOutros > 0 || !vencedor) && (
        <div className="mx-6 mt-2">
          <button
            type="button"
            onClick={() => setMostrarOutros((v) => !v)}
            className="border border-ink/20 bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-soft hover:border-ink hover:text-ink"
          >
            {mostrarOutros ? "▾ ocultar outros avisos" : `▸ outros avisos${nOutros > 0 ? ` (${nOutros})` : ""}`}
          </button>
          {mostrarOutros && (
            <div className="mt-2 border-l-2 border-ink/10 pl-1">
              {secundarios.map((s) => (
                <BlocosDoSinal key={s} sinal={s} card={card} falhaExtra={falhaExtra} />
              ))}
              <BannerEmailPreexistente
                cardId={card.id}
                nf={card.nf}
                cardCreatedAt={(card as unknown as { created_at?: string | null }).created_at}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
