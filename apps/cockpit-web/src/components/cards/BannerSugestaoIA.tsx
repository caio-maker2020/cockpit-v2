import { useEffect, useState, Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles, Check, ChevronDown, ChevronUp, Image as ImageIcon, AlertTriangle } from "lucide-react";
import { supabase, SUPABASE_FUNCTIONS_URL, SUPABASE_ANON_KEY_PUBLIC } from "@/lib/supabase";
import type { CardRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useModoFoco } from "@/hooks/useModoFoco";
import { BannerInline54Composer } from "./BannerInline54Composer";
import { ModalEvidencia } from "./ModalEvidencia";
import { EditarEmailModal } from "./EditarEmailModal";
import { ModalAprovarOc44 } from "./ProposedActions";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";


/* ============================================================================
 * Banner unificado de sugestão IA — agentes oc=13 + ocs padrão (10/11/19/35)
 * Visual: mesma família indigo do BannerSugestaoIa (cliente respondeu).
 * Substitui BannerAgenteOc13 + BannerAgenteOcsPadrao.
 * ========================================================================== */

const TEMPLATE_LABELS: Record<string, string> = {
  RECUSA_TOTAL: "Recusa total",
  RECUSA_PARCIAL: "Recusa parcial",
  FALTA_DE_VOLUME: "Falta de volume",
  PROBLEMAS_COM_ENDERECO: "Problemas com endereço",
};

const SUBTIPO_LABELS_AUTONOMO: Record<string, string> = {
  fora_horario_comercial: "Fora do horário comercial (seg-sex 8h-18h)",
  sem_foto: "Sem foto anexada",
  foto_destinatario_sem_motivo: "Foto no destinatário sem motivo escrito",
  local_fechado_sem_justificativa: "Local fechado sem justificativa",
  foto_nao_comprova: "Foto não comprova a tentativa",
};

const CATEGORIA_ERRO_LABELS: Record<string, string> = {
  timeout_anthropic: "Timeout na IA Anthropic",
  ssw_offline: "Portal SSW offline ou lento",
  foto_corrompida: "Foto corrompida ou ausente no SSW",
  json_invalido: "Resposta da IA não veio em JSON válido",
  card_sem_credencial_ssw: "Sem credenciais SSW pro operador deste card",
  historico_sem_oc13: "Histórico SSW não tem linha oc=13",
  historico_sem_oc: "Histórico SSW não tem a oc esperada",
  erro_desconhecido: "Erro desconhecido",
};

const OPCOES_OC = [
  { v: "21", l: "21 — REENTREGA SOLICITADA" },
  { v: "54", l: "54 — AGUARDANDO POSICIONAMENTO DO CLIENTE" },
  { v: "56", l: "56 — FALTA INFO OPERACIONAL" },
  { v: "41", l: "41 — INFORMAÇÃO COMPLEMENTAR" },
  { v: "outro", l: "Outro (texto livre)" },
];

const OCS_PADRAO = [10, 11, 19, 35];

type Variant = "info" | "warning" | "success" | "danger";

export function BannerSugestaoIA({ card }: { card: CardRow }) {
  const oc = card.cod_ultima_ocorrencia;
  const ehOc13 = oc === 13;
  const ehOcsPadrao = oc != null && OCS_PADRAO.includes(oc);
  const aviso = card.aviso_alteracao_oc;
  const ehOc49 = oc === 49 && aviso?.tipo === "ia_sugestao_ocs_padrao";
  const ehRessarc54 = aviso?.tipo === "ressarcimento_relancar_54";

  // ---------- agente "relançar 54 por ressarcimento" ----------
  // Reusa o MESMO componente RECOMENDADO PELO AGENTE IA das ocs padrão.
  if (ehRessarc54) {
    return <BannerRessarc54 card={card} />;
  }

  if (!ehOc13 && !ehOcsPadrao && !ehOc49) return null;

  // ---------- oc=13 ----------
  if (ehOc13 && card.analise_oc13_status) {
    return <BannerOc13 card={card} />;
  }

  // ---------- ocs padrão ----------
  if (ehOcsPadrao && card.analise_padrao_status) {
    return <BannerOcsPadrao card={card} />;
  }

  // ---------- oc=49 (árvore de 4 ramos + catch-all) ----------
  if (ehOc49) {
    return <BannerOc49 card={card} />;
  }

  return null;
}

/* ============================================================================
 * Agente "relançar 54 por ressarcimento" — reusa Shell + PrimaryAction padrão
 * ========================================================================== */
function BannerRessarc54({ card }: { card: CardRow }) {
  const aviso = card.aviso_alteracao_oc!;
  const tier = (aviso as any).tier as "A" | "B" | undefined;
  const confianca = aviso.confianca ?? null;
  const observacao = aviso.observacao_orquestrador ?? null;
  const oc46 = (aviso as any).oc46_data as string | undefined;
  const oc54 = (aviso as any).oc54_data as string | undefined;

  return (
    <Shell variant="info">
      <div className="flex items-center gap-2">
        <Eyebrow>Recomendado pelo Agente IA · Ressarcimento</Eyebrow>
        {tier && (
          <span className="inline-flex items-center border border-indigo-400/70 bg-white/60 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-indigo-800">
            tier {tier}
          </span>
        )}
      </div>
      <Title>
        Lançar oc=54 (sem e-mail) — reiteração do ressarcimento
      </Title>
      <Confianca confianca={confianca} />
      {observacao && (
        <p className="mt-3 font-display text-[13px] leading-snug text-ink whitespace-pre-line">
          {observacao}
        </p>
      )}
      {(oc46 || oc54) && (
        <p className="mt-1 font-mono text-[10px] text-ink-mute">
          {oc46 && <>oc 46: {oc46}</>}
          {oc46 && oc54 && " · "}
          {oc54 && <>oc 54 original: {oc54}</>}
        </p>
      )}
      <Actions>
        <PrimaryAction
          label="✓ Aprovar oc=54 (sem e-mail)"
          codigoSsw={54}
          acaoKey="lancar_ocorrencia:54"
          template={null}
          motivo={null}
          cardId={card.id}
          directApprove
        />
        <SecondaryAction label="Ver outras opções →" />
        <FeedbackBotoes
          card={card}
          rpcAcerto="registrar_acerto_ocs_padrao_ia"
          rpcErro="reportar_erro_ressarc54"
          decisaoLabel="Relançar oc=54 sem e-mail (ressarcimento)"
          erroMotivoOnly
        />
      </Actions>
    </Shell>
  );
}

/* ============================================================================
 * oc=13
 * ========================================================================== */

function BannerOc13({ card }: { card: CardRow }) {
  const status = card.analise_oc13_status!;
  const r = card.analise_oc13_resultado;
  const tentativas = card.analise_oc13_tentativas ?? 0;

  // Analisando / aguardando retry
  if (status === "pendente" || status === "analisando" || (status === "falhou" && !r)) {
    return (
      <Shell variant="info" loading>
        <Eyebrow>Agente IA analisando evidência da oc=13</Eyebrow>
        <Title>Aguardando análise da foto + histórico</Title>
        <Note>tentativa {Math.max(tentativas, 1)}/3</Note>
      </Shell>
    );
  }

  if (status === "falhou" && r && (r.tentativa ?? 0) < (r.max_tentativas ?? 3)) {
    return (
      <Shell variant="info" loading>
        <Eyebrow>Agente IA — próxima tentativa em ~10min</Eyebrow>
        <Title>Análise temporariamente indisponível</Title>
        <Note>
          Última falha:{" "}
          {CATEGORIA_ERRO_LABELS[r.categoria ?? "erro_desconhecido"] ?? r.categoria}
          {" "}· próxima tentativa {(r.tentativa ?? 0) + 1}/{r.max_tentativas ?? 3}
        </Note>
      </Shell>
    );
  }

  if (status === "falhou" && r && (r.tentativa ?? 0) >= (r.max_tentativas ?? 3)) {
    return (
      <Shell variant="danger">
        <Eyebrow>Agente IA falhou ({r.tentativa}/{r.max_tentativas} tentativas)</Eyebrow>
        <Title>Análise automática indisponível — aprove manualmente</Title>
        <Note>
          Categoria:{" "}
          {CATEGORIA_ERRO_LABELS[r.categoria ?? "erro_desconhecido"] ?? r.categoria}
        </Note>
        {r.erro_msg && (
          <details className="mt-2 font-mono text-[11px] text-ink-mute">
            <summary className="cursor-pointer">Detalhe técnico</summary>
            <code className="mt-1 block break-all">{r.erro_msg}</code>
          </details>
        )}
      </Shell>
    );
  }

  if (status !== "concluida" || !r) return null;

  // Ação autônoma já executada
  if (r.decisao === "autonoma") {
    return (
      <Shell variant="success">
        <Eyebrow>Ação autônoma · Executada pelo Agente IA</Eyebrow>
        <Title>oc=21 lançada · cancelamento de reentrega agendado +24h</Title>
        {r.subtipo && (
          <Note>
            Sub-tipo: {SUBTIPO_LABELS_AUTONOMO[r.subtipo] ?? r.subtipo}
          </Note>
        )}
        {r.motivo_cancelamento && <Quote>{r.motivo_cancelamento}</Quote>}
        <Confianca confianca={r.confianca} />
        <Actions>
          <FeedbackBotoes card={card} rpcAcerto="registrar_acerto_oc13_ia" rpcErro="registrar_feedback_oc13_ia" tipoFeedback="autonoma_errada" decisaoLabel="Autônoma — oc=21 + cancel" />
        </Actions>
      </Shell>
    );
  }

  // Sugere oc=54+email
  if (r.decisao === "sugerir_54_email") {
    const tplLabel = r.template_email_sugerido
      ? (TEMPLATE_LABELS[r.template_email_sugerido] ?? r.template_email_sugerido)
      : null;
    return (
      <Shell variant="info">
        <Eyebrow>Recomendado pelo Agente IA</Eyebrow>
        <Title>
          Lançar oc=54 + email{tplLabel ? ` — ${tplLabel}` : ""}
        </Title>
        <Confianca confianca={r.confianca} />
        <IaEvidenciaResumo card={card} fallback={r.motivo_extraido} />

        <Actions>
          <PrimaryAction
            label="✓ Aprovar oc=54+email"
            codigoSsw={54}
            template={r.template_email_sugerido ?? null}
            motivo={r.motivo_extraido ?? null}
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes card={card} rpcAcerto="registrar_acerto_oc13_ia" rpcErro="registrar_feedback_oc13_ia" tipoFeedback="sugestao_errada_explicita" decisaoLabel="Recomendou oc=54+email" />
        </Actions>
      </Shell>
    );
  }

  // Sugere oc=21 + cancelamento de reentrega — operador valida
  if (r.decisao === "sugerir_21_cancel") {
    const observacao =
      (card.aviso_alteracao_oc as any)?.observacao ??
      (r.motivo_cancelamento ? `Motivo do cancelamento: ${r.motivo_cancelamento}` : null);
    return (
      <Shell variant="warning">
        <Eyebrow>Recomendado pelo Agente IA · valide antes de executar</Eyebrow>
        <Title>Lançar oc=21 + cancelar reentrega</Title>
        <Confianca confianca={r.confianca} />
        <IaEvidenciaResumo card={card} fallback={r.motivo_extraido} />
        {observacao && <Note>{observacao}</Note>}
        <Actions>
          <PrimaryAction
            label="✓ Aprovar oc=21 + cancelar"
            codigoSsw={21}
            template={null}
            motivo={r.motivo_extraido ?? null}
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_oc13_ia"
            rpcErro="registrar_feedback_oc13_ia"
            tipoFeedback="sugestao_errada_explicita"
            decisaoLabel="Recomendou oc=21 + cancelar reentrega"
          />
        </Actions>
      </Shell>
    );
  }

  // Sugere oc=56 — operação revisa antes de cliente
  if (r.decisao === "sugerir_56") {
    return (
      <Shell variant="warning">
        <Eyebrow>Recomendado pelo Agente IA · Operação revisa antes de cliente</Eyebrow>
        <Title>Lançar oc=56 — Falta info operacional</Title>
        <Confianca confianca={r.confianca} />
        <IaEvidenciaResumo card={card} fallback={r.motivo_extraido} />
        <Actions>
          <PrimaryAction
            label="✓ Aprovar oc=56"
            codigoSsw={56}
            template={null}
            motivo={r.motivo_extraido ?? null}
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_oc13_ia"
            rpcErro="registrar_feedback_oc13_ia"
            tipoFeedback="sugestao_errada_explicita"
            decisaoLabel="Recomendou oc=56"
          />
        </Actions>
      </Shell>
    );
  }

  return null;
}

/* ============================================================================
 * ocs padrão 10/11/19/35
 * ========================================================================== */

function BannerOcsPadrao({ card }: { card: CardRow }) {
  const status = card.analise_padrao_status!;
  const r = card.analise_padrao_resultado;
  const tentativas = card.analise_padrao_tentativas ?? 0;
  const oc = card.cod_ultima_ocorrencia;

  if (status === "pendente" || status === "analisando" || (status === "falhou" && !r)) {
    return (
      <Shell variant="info" loading>
        <Eyebrow>Agente IA analisando evidência da oc={oc}</Eyebrow>
        <Title>Aguardando análise</Title>
        <Note>tentativa {Math.max(tentativas, 1)}/3</Note>
      </Shell>
    );
  }

  if (status === "falhou" && r) {
    const max = r.max_tentativas ?? 3;
    const tent = r.tentativa ?? tentativas;
    if (tent >= max) {
      return (
        <Shell variant="danger">
          <Eyebrow>Agente IA falhou ({tent}/{max} tentativas)</Eyebrow>
          <Title>Análise automática indisponível — aprove manualmente</Title>
          <Note>
            Categoria:{" "}
            {CATEGORIA_ERRO_LABELS[r.categoria ?? "erro_desconhecido"] ?? r.categoria}
          </Note>
          {r.erro_msg && (
            <details className="mt-2 font-mono text-[11px] text-ink-mute">
              <summary className="cursor-pointer">Detalhe técnico</summary>
              <code className="mt-1 block break-all">{r.erro_msg}</code>
            </details>
          )}
        </Shell>
      );
    }
    return (
      <Shell variant="info" loading>
        <Eyebrow>Agente IA — próxima tentativa em ~10min</Eyebrow>
        <Title>Análise temporariamente indisponível</Title>
        <Note>
          Última falha:{" "}
          {CATEGORIA_ERRO_LABELS[r.categoria ?? "erro_desconhecido"] ?? r.categoria}
          {" "}· tentativa {tent + 1}/{max}
        </Note>
      </Shell>
    );
  }

  if (status !== "concluida" || !r) return null;

  // Sugere oc de CLIENTE (54 tratativa / 59 indenização — separação Caio 2026-07-13).
  // O agente-sugere-ocs-padrao destaca 54 OU 59 conforme o template (romaneio → 59).
  // Identifica a variante (com/sem e-mail) pelo acao_key (proposta_destacada_acao).
  if (r.proposta_destacada === 54 || r.proposta_destacada === 59) {
    const ocDest = r.proposta_destacada;
    const tplLabel = r.template_email_sugerido
      ? (TEMPLATE_LABELS[r.template_email_sugerido] ?? r.template_email_sugerido)
      : null;
    const acaoDestacada =
      (r as any).proposta_destacada_acao ??
      (card.aviso_alteracao_oc as any)?.proposta_destacada_acao ??
      `lancar_oc_e_enviar_email:${ocDest}`;
    const ehSemEmail = acaoDestacada === `lancar_ocorrencia:${ocDest}`;
    const tituloAcao = ehSemEmail
      ? `Lançar oc=${ocDest} (sem e-mail) — não notifica o cliente`
      : `Lançar oc=${ocDest} + email${tplLabel ? ` — ${tplLabel}` : ""}`;
    const labelBotao = ehSemEmail
      ? `✓ Aprovar oc=${ocDest} (sem e-mail)`
      : `✓ Aprovar oc=${ocDest}+email`;
    return (
      <>

      <Shell variant="info">
        <ExpandableHeader
          cardId={card.id}
          eyebrow="Recomendado pelo Agente IA"
          render={(expanded, toggle) => (
            <>
              <Title>{tituloAcao}</Title>
              <Confianca confianca={r.confianca} />
              {r.observacao_orquestrador && (
                <p className="mt-3 font-display text-[13px] leading-snug text-ink">
                  {r.observacao_orquestrador}
                </p>
              )}
              <RessalvaOuMotivo card={card} oc={oc} r={r} hideMotivoQuote={!!r.observacao_orquestrador} />
              <AlertaCaixaLacrada aviso={card.aviso_alteracao_oc} />
              {expanded && !ehSemEmail && (
                <BannerInline54Composer
                  card={card}
                  codigoOc={ocDest}
                  templateSugeridoIA={r.template_email_sugerido ?? null}
                />
              )}
              <Actions>
                {(!expanded || ehSemEmail) && (
                  <PrimaryAction
                    label={labelBotao}
                    codigoSsw={ocDest}
                    acaoKey={acaoDestacada}
                    template={ehSemEmail ? null : (r.template_email_sugerido ?? null)}
                    motivo={r.motivo_extraido ?? null}
                    cardId={card.id}
                    directApprove
                  />
                )}
                <VerEvidenciaButton card={card} />
                {!ehSemEmail && <ExpandToggleButton expanded={expanded} onClick={toggle} />}
                <SecondaryAction label="Ver outras opções →" />
                <FeedbackBotoes card={card} rpcAcerto="registrar_acerto_ocs_padrao_ia" rpcErro="registrar_feedback_ocs_padrao_ia" decisaoLabel={ehSemEmail ? `Recomendou oc=${ocDest} sem e-mail` : `Recomendou oc=${ocDest}+${tplLabel ?? "template"}`} />
              </Actions>
            </>
          )}
        />
      </Shell>
      </>
    );
  }


  // Sugere oc=56
  if (r.proposta_destacada === 56) {
    return (
      <>

      <Shell variant="warning">
        <Eyebrow>Recomendado pelo Agente IA · Operação revisa antes</Eyebrow>
        <Title>Lançar oc=56 — Falta info operacional</Title>
        <Confianca confianca={r.confianca} />
        <RessalvaOuMotivo card={card} oc={oc} r={r} />
        {r.observacao_orquestrador && <Note>{r.observacao_orquestrador}</Note>}
        <Actions>
          <PrimaryAction label="✓ Aprovar oc=56" codigoSsw={56} template={null} motivo={r.motivo_extraido ?? null} />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes card={card} rpcAcerto="registrar_acerto_ocs_padrao_ia" rpcErro="registrar_feedback_ocs_padrao_ia" decisaoLabel="Recomendou oc=56" />
        </Actions>
      </Shell>
      </>
    );
  }

  return null;
}


/* ============================================================================
 * oc=49 — TRATATIVA RELACIONAMENTO (árvore de 4 ramos + catch-all)
 * Lê de card.aviso_alteracao_oc (campos populados pelo agente-sugere-ocs-padrao)
 * ========================================================================== */

const TEMPLATE_LABELS_OC49: Record<string, string> = {
  EXTRAVIO_PARCIAL: "EXTRAVIO_PARCIAL",
  EXTRAVIO_TOTAL_PEDIR_ROMANEIO: "EXTRAVIO_TOTAL_PEDIR_ROMANEIO",
  RECUSA_TOTAL: "RECUSA_TOTAL",
  ENTREGUE_COM_FALTA_PEDIR_ROMANEIO: "ENTREGUE_COM_FALTA_PEDIR_ROMANEIO",
  ENTREGA_PARCIAL_APOS_FALTA_VOLUME: "ENTREGA_PARCIAL_APOS_FALTA_VOLUME",
};

function formatHoraCurta(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function BannerOc49({ card }: { card: CardRow }) {
  const aviso = card.aviso_alteracao_oc!;
  const caso = aviso.caso_oc49;
  const confianca = aviso.confianca ?? null;
  const motivo = aviso.motivo_extraido ?? null;
  const observacao = aviso.observacao_orquestrador ?? null;
  // INV-027: o botão "+ e-mail" precisa casar EXATAMENTE com o todo destacado
  // pelo backend, nunca cair em fallback por codigo_ssw=54 (que pode pescar
  // o todo OPOSTO "sem e-mail"). Default seguro: lancar_oc_e_enviar_email:54.
  const acaoDestacada =
    (aviso as any).proposta_destacada_acao ?? "lancar_oc_e_enviar_email:54";

  // 1. Extravio total → sugere oc=54 + email EXTRAVIO_TOTAL_PEDIR_ROMANEIO
  if (caso === "extravio_total") {
    const tpl = aviso.template_email_sugerido ?? "EXTRAVIO_TOTAL_PEDIR_ROMANEIO";
    return (
      <Shell variant="info">
        <Eyebrow>Recomendado pelo Agente IA · Extravio total detectado</Eyebrow>
        <Title>Lançar oc=54 + email {TEMPLATE_LABELS_OC49[tpl] ?? tpl}</Title>
        <Confianca confianca={confianca} />
        {motivo && <Quote>{motivo}</Quote>}
        {observacao && <Note>{observacao}</Note>}
        <Actions>
          <PrimaryAction
            label="✓ Aprovar oc=54 + email"
            codigoSsw={54}
            acaoKey={acaoDestacada}
            template={tpl}
            motivo={motivo}
            cardId={card.id}
            directApprove
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_ocs_padrao_ia"
            rpcErro="registrar_feedback_ocs_padrao_ia"
            decisaoLabel="oc=49 extravio total → oc=54 + EXTRAVIO_TOTAL_PEDIR_ROMANEIO"
          />
        </Actions>
      </Shell>
    );
  }

  // 2. Extravio parcial → sugere oc=54 + EXTRAVIO_PARCIAL com pílula de qtd
  if (caso === "extravio_parcial") {
    const qtdExt = aviso.qtd_volumes_extraviados ?? null;
    const qtdNf = aviso.qtd_volumes_nf ?? null;
    const suspeita = qtdExt != null && qtdNf != null && qtdExt >= qtdNf;
    const tpl = aviso.template_email_sugerido ?? "EXTRAVIO_PARCIAL";
    return (
      <Shell variant={suspeita ? "warning" : "info"}>
        <Eyebrow>Recomendado pelo Agente IA · Extravio parcial detectado</Eyebrow>
        <Title>Lançar oc=54 + email {TEMPLATE_LABELS_OC49[tpl] ?? tpl}</Title>
        {qtdExt != null && (
          <div className="mt-2">
            <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 font-mono text-[11px] text-amber-900">
              {qtdExt} de {qtdNf ?? "?"} volumes extraviados
            </span>
          </div>
        )}
        <Confianca confianca={confianca} />
        {motivo && <Quote>{motivo}</Quote>}
        {observacao && <Note>{observacao}</Note>}
        {suspeita && (
          <div className="mt-3 rounded-r-md border-l-4 border-amber-400 bg-amber-50 p-2 text-[12px] text-amber-800">
            Qtd extraviada ({qtdExt}) é maior ou igual ao total da NF ({qtdNf}).
            Confira a oc=6 anterior no histórico SSW antes de enviar.
          </div>
        )}
        <Actions>
          <PrimaryAction
            label="✓ Aprovar oc=54 + email"
            codigoSsw={54}
            acaoKey={acaoDestacada}
            template={tpl}
            motivo={motivo}
            cardId={card.id}
            directApprove
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_ocs_padrao_ia"
            rpcErro="registrar_feedback_ocs_padrao_ia"
            decisaoLabel="oc=49 extravio parcial → oc=54 + EXTRAVIO_PARCIAL"
          />
        </Actions>
      </Shell>
    );
  }

  // 3. Extravio sem qtd → agente cobrou WPP do ressarcimento; aguarda retorno
  if (caso === "extravio_sem_qtd") {
    const cobrada = !!aviso.cobrada_no_wpp;
    return (
      <Shell variant={cobrada ? "warning" : "danger"}>
        <Eyebrow>
          {cobrada
            ? `Time de ressarcimento cobrado via WhatsApp · ${formatHoraCurta(aviso.cobrada_em)}`
            : "Atenção — cobrar manualmente"}
        </Eyebrow>
        <Title>
          {cobrada
            ? "Aguardando retorno do ressarcimento"
            : "Extravio detectado sem qtd de volumes extraviados"}
        </Title>
        <Confianca confianca={confianca} />
        {motivo && <Quote>{motivo}</Quote>}
        {observacao && <Note>{observacao}</Note>}
        <Actions>
          <ReanalisarButton cardId={card.id} />
          <VerEvidenciaButton card={card} />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_ocs_padrao_ia"
            rpcErro="registrar_feedback_ocs_padrao_ia"
            decisaoLabel="oc=49 extravio sem qtd → aguardando ressarcimento"
          />
        </Actions>
      </Shell>
    );
  }

  // 4. Cobrança de retorno → reusa thread original via enviar-retificacao-evidencia
  if (caso === "cobranca_retorno") {
    return (
      <Shell variant="info">
        <Eyebrow>Recomendado pelo Agente IA · Cobrança de retorno</Eyebrow>
        <Title>Cobrar cliente na mesma thread</Title>
        <Confianca confianca={confianca} />
        {motivo && <Quote>{motivo}</Quote>}
        {observacao && <Note>{observacao}</Note>}
        <Actions>
          <CobrarRetornoButton
            cardId={card.id}
            textoPrefixo={aviso.texto_prefixo_sugerido ?? ""}
            codOc={aviso.cod_ocorrencia_para_token ?? null}
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_ocs_padrao_ia"
            rpcErro="registrar_feedback_ocs_padrao_ia"
            decisaoLabel="oc=49 cobrança de retorno → cobrar na thread original"
          />
        </Actions>
      </Shell>
    );
  }

  // 5. Devolução pós oc=56 → sugere oc=54 + template do cluster original
  if (caso === "devolucao_pos_56") {
    const tpl = aviso.template_email_sugerido ?? null;
    return (
      <Shell variant="info">
        <Eyebrow>Recomendado pelo Agente IA · Devolução pós oc=56</Eyebrow>
        <Title>
          Lançar oc=54{tpl ? ` + email ${TEMPLATE_LABELS_OC49[tpl] ?? tpl}` : " + email"}
        </Title>
        <Confianca confianca={confianca} />
        {motivo && <Quote>{motivo}</Quote>}
        {observacao && <Note>{observacao}</Note>}
        <Actions>
          <PrimaryAction
            label="✓ Aprovar oc=54 + email"
            codigoSsw={54}
            acaoKey={acaoDestacada}
            template={tpl}
            motivo={motivo}
            cardId={card.id}
            directApprove
          />
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
          <FeedbackBotoes
            card={card}
            rpcAcerto="registrar_acerto_ocs_padrao_ia"
            rpcErro="registrar_feedback_ocs_padrao_ia"
            decisaoLabel={`oc=49 devolução pós oc=56 → oc=54 + ${tpl ?? "template"}`}
          />
        </Actions>
      </Shell>
    );
  }

  // 6. Catch-all → operador escolhe manual + ensina o agente
  if (caso === "nao_reconhecido") {
    return (
      <Shell variant="warning">
        <Eyebrow>Agente IA não reconheceu o caso</Eyebrow>
        <Title>Operador escolhe manual</Title>
        {motivo && <Quote>{motivo}</Quote>}
        {observacao && <Note>{observacao}</Note>}
        <FormFeedbackCasoDesconhecido cardId={card.id} />
        <Actions>
          <VerEvidenciaButton card={card} />
          <SecondaryAction label="Ver outras opções →" />
        </Actions>
      </Shell>
    );
  }

  return null;
}

function ReanalisarButton({ cardId }: { cardId: string }) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  async function reanalisar() {
    if (!supabase) return;
    setLoading(true);
    const { error } = await supabase
      .from("cards")
      .update({
        analise_padrao_status: null,
        analise_padrao_resultado: null,
        analise_padrao_tentativas: 0,
      } as never)
      .eq("id", cardId);
    setLoading(false);
    if (error) {
      toast.error("Não consegui re-analisar: " + error.message);
      return;
    }
    toast.success("✓ Re-análise solicitada — o agente vai rodar de novo");
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }
  return (
    <button
      type="button"
      onClick={reanalisar}
      disabled={loading}
      className="inline-flex items-center gap-2 rounded-md border border-ink/30 bg-paper px-3 py-1.5 font-body text-[12px] text-ink-soft hover:border-ink hover:text-ink disabled:opacity-50"
    >
      {loading && <Loader2 className="h-3 w-3 animate-spin" />}
      Re-analisar quando ressarcimento responder
    </button>
  );
}

function CobrarRetornoButton({
  cardId,
  textoPrefixo,
  codOc,
}: {
  cardId: string;
  textoPrefixo: string;
  codOc: number | null;
}) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  async function cobrar() {
    if (!supabase) return;
    setLoading(true);
    const { data, error } = await supabase.functions.invoke(
      "enviar-retificacao-evidencia",
      {
        body: {
          card_id: cardId,
          texto_prefixo: textoPrefixo,
          cod_ocorrencia: codOc,
        },
      },
    );
    setLoading(false);
    if (error) {
      toast.error(`Não consegui enviar: ${error.message}`);
      return;
    }
    const link = (data as { link_evidencia?: string } | null)?.link_evidencia;
    toast.success(
      link
        ? `✓ Cobrança enviada na thread original. Link: ${link}`
        : "✓ Cobrança enviada na thread original",
    );
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["card-events", cardId] });
  }
  return (
    <button
      type="button"
      onClick={cobrar}
      disabled={loading}
      className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 font-body text-[13px] font-medium text-paper transition-colors hover:bg-ink-soft active:scale-[0.98] disabled:opacity-50"
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      ✓ Cobrar de novo agora
    </button>
  );
}

function FormFeedbackCasoDesconhecido({ cardId }: { cardId: string }) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);

  async function submit() {
    if (texto.trim().length < 10) {
      toast.warning(
        "Conte pra IA com pelo menos 10 caracteres o que era esse caso",
      );
      return;
    }
    if (!supabase) return;
    setEnviando(true);
    const { error } = await supabase.rpc(
      "registrar_feedback_oc49_caso_desconhecido" as never,
      {
        p_card_id: cardId,
        p_explicacao: texto.trim(),
      } as never,
    );
    setEnviando(false);
    if (error) {
      toast.error(`Não consegui registrar: ${error.message}`);
      return;
    }
    setEnviado(true);
    toast.success(
      "✓ Feedback registrado — o agente vai aprender pra próximas oc=49",
    );
    qc.invalidateQueries({ queryKey: ["card", cardId] });
  }

  if (enviado) {
    return (
      <p className="mt-3 font-mono text-[12px] text-positive">
        ✓ Obrigado! Caio vai analisar o padrão.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <label className="block font-mono text-[11px] uppercase tracking-wider text-ink-soft">
        Conte pro agente: qual era o caso real dessa oc=49?
      </label>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        placeholder="Ex: cliente está pedindo nova tentativa de entrega na semana que vem"
        rows={2}
        className="w-full rounded border border-ink/30 bg-paper px-3 py-2 text-[13px] focus:border-ink focus:outline-none"
        minLength={10}
      />
      <button
        type="button"
        onClick={submit}
        disabled={enviando || texto.trim().length < 10}
        className="inline-flex items-center gap-2 rounded bg-ink px-3 py-1.5 font-mono text-[11px] text-paper hover:bg-ink-soft disabled:opacity-50"
      >
        {enviando ? "Enviando..." : "Ensinar o agente"}
      </button>
    </div>
  );
}



/* ============================================================================
 * Primitives (shell visual)
 * ========================================================================== */

const VARIANT_STYLES: Record<Variant, { box: string; accent: string; eyebrow: string }> = {
  info:    { box: "bg-indigo-50 border-indigo-200 border-l-indigo-500",   accent: "border-indigo-400/60", eyebrow: "text-indigo-700" },
  warning: { box: "bg-amber-50 border-amber-200 border-l-amber-500",      accent: "border-amber-400/60", eyebrow: "text-amber-800" },
  success: { box: "bg-emerald-50 border-emerald-200 border-l-emerald-500",accent: "border-emerald-400/60",eyebrow: "text-emerald-700" },
  danger:  { box: "bg-rose-50 border-rose-200 border-l-rose-500",         accent: "border-rose-400/60",  eyebrow: "text-rose-700" },
};

const VariantCtx = { current: "info" as Variant };

function Shell({
  variant,
  loading,
  children,
}: {
  variant: Variant;
  loading?: boolean;
  children: React.ReactNode;
}) {
  VariantCtx.current = variant;
  const s = VARIANT_STYLES[variant];

  const [modoFoco] = useModoFoco();
  // Override só dentro deste card: null = segue Modo Foco global
  const [overrideExpanded, setOverrideExpanded] = useState<boolean | null>(null);
  useEffect(() => {
    setOverrideExpanded(null);
  }, [modoFoco]);
  const collapsed = !loading && (overrideExpanded == null ? modoFoco : !overrideExpanded);

  if (collapsed) {
    // Faixa fina: mostra Eyebrow + Title + Actions (mantém botões acessíveis)
    const arr = Children.toArray(children);
    const titleEl = arr.find((c) => isValidElement(c) && c.type === Title);
    const eyebrowEl = arr.find((c) => isValidElement(c) && c.type === Eyebrow);
    const actionsEl = arr.find((c) => isValidElement(c) && c.type === Actions);
    const titleText =
      isValidElement(titleEl) && titleEl.props && (titleEl.props as { children?: ReactNode }).children
        ? (titleEl.props as { children: ReactNode }).children
        : "Sugestão do Agente IA";
    const eyebrowText =
      isValidElement(eyebrowEl) && eyebrowEl.props && (eyebrowEl.props as { children?: ReactNode }).children
        ? (eyebrowEl.props as { children: ReactNode }).children
        : "Agente IA";

    return (
      <div className={cn("mx-6 mt-3 flex items-center gap-3 rounded-md border border-l-4 px-3 py-2", s.box)}>
        <Sparkles className={cn("h-4 w-4 shrink-0", s.eyebrow)} strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate font-mono text-[9px] uppercase tracking-[0.08em]", s.eyebrow)}>
            {eyebrowText}
          </p>
          <p className="truncate text-[13px] font-medium text-ink">{titleText}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actionsEl}</div>
        <button
          type="button"
          aria-label="Expandir sugestão IA"
          onClick={() => setOverrideExpanded(true)}
          className="text-ink-mute hover:text-ink"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn("mx-6 mt-3 rounded-md border border-l-4 p-5 relative", s.box)}>
      {!loading && (
        <button
          type="button"
          aria-label="Recolher sugestão IA"
          onClick={() => setOverrideExpanded(false)}
          className="absolute right-3 top-3 text-ink-mute hover:text-ink"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
      )}
      <div className="flex items-start gap-3">
        <div className={cn("mt-0.5 shrink-0", s.eyebrow)}>
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Sparkles className="h-5 w-5" strokeWidth={2} />
          )}
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}


function Eyebrow({ children }: { children: React.ReactNode }) {
  const s = VARIANT_STYLES[VariantCtx.current];
  return (
    <p className={cn("font-mono text-[10px] font-medium uppercase tracking-[0.08em]", s.eyebrow)}>
      {children}
    </p>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-1 font-display text-[18px] font-semibold leading-tight text-ink">
      {children}
    </h3>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[12px] text-ink-mute">{children}</p>;
}

function Quote({ children }: { children: React.ReactNode }) {
  const s = VARIANT_STYLES[VariantCtx.current];
  return (
    <blockquote
      className={cn(
        "mt-3 border-l-2 pl-3 font-display text-[13px] italic leading-snug text-ink-soft",
        s.accent,
      )}
    >
      "{children}"
    </blockquote>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 flex flex-wrap items-center gap-3">{children}</div>;
}

function Confianca({ confianca }: { confianca?: number | null }) {
  if (confianca == null) return null;
  const pct = Math.round(confianca * 100);
  const cfg =
    pct >= 80
      ? { label: `alta (${pct}%) ✓`, cls: "bg-emerald-100 text-emerald-800" }
      : pct >= 50
        ? { label: `média (${pct}%)`, cls: "bg-amber-100 text-amber-800" }
        : { label: `baixa (${pct}%) — confirme antes`, cls: "bg-rose-100 text-rose-800" };
  return (
    <span
      className={cn(
        "mt-2 inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px]",
        cfg.cls,
      )}
    >
      Confiança: {cfg.label}
    </span>
  );
}

/* ============================================================================
 * Ações
 * ========================================================================== */

function PrimaryAction({
  label,
  codigoSsw,
  acaoKey,
  template,
  motivo,
  cardId,
  directApprove,
  preferSemEmail,
}: {
  label: string;
  codigoSsw: number;
  acaoKey?: string;
  template: string | null;
  motivo: string | null;
  cardId?: string;
  directApprove?: boolean;
  preferSemEmail?: boolean;
}) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [modalTodoId, setModalTodoId] = useState<string | null>(null);
  const [modalTemplateSugerido, setModalTemplateSugerido] = useState<string | null>(null);
  const [submittingModal, setSubmittingModal] = useState(false);
  // Modal de devolução (oc=44 standalone OU combo 33+44)
  const [modal44TodoId, setModal44TodoId] = useState<string | null>(null);
  const [modal44ComboMode, setModal44ComboMode] = useState(false);
  const [submittingModal44, setSubmittingModal44] = useState(false);


  async function aprovarDireto() {
    if (!supabase || !cardId) return;
    setLoading(true);
    // Localiza o todo pendente correspondente
    const { data: todos, error: errTodos } = await supabase
      .from("todos")
      .select("id, proposta_payload")
      .eq("card_id", cardId)
      .eq("status", "pendente");
    if (errTodos) {
      setLoading(false);
      toast.error("Erro localizando proposta", { description: errTodos.message });
      return;
    }
    // REGRA INEGOCIÁVEL: quando o banner passa acaoKey, casar EXATAMENTE
    // por proposta_payload.acao_key (string). Nunca casar dois todos com mesmo
    // codigo_ssw — "54 + e-mail" e "54 SEM e-mail" são ações OPOSTAS.
    let match: any = null;
    if (acaoKey) {
      // Quando o banner aponta acao_key, casamos EXATAMENTE por ele.
      // Nunca cair em fallback por codigo_ssw — "54+e-mail" e "54 sem e-mail"
      // são ações OPOSTAS com o mesmo número.
      match = (todos ?? []).find((t: any) => {
        const pl = (t.proposta_payload ?? {}) as any;
        return pl?.acao_key === acaoKey;
      });
      if (!match) {
        setLoading(false);
        toast.warning(`Ação "${acaoKey}" não está mais pendente`);
        return;
      }
    } else {
      const matchFn = (t: any) => {
        const pl = (t.proposta_payload ?? {}) as any;
        if (codigoSsw === 33 && pl?.tool === "lancar_combo_33_44") return true;
        return Number(pl?.args?.codigo_ssw) === codigoSsw;
      };
      const candidatos = (todos ?? []).filter(matchFn);
      // Sem acao_key: preferimos NOTIFICAR (meta.modo='completo') a menos
      // que o chamador peça explicitamente preferSemEmail.
      if (preferSemEmail) {
        match =
          candidatos.find((t: any) => {
            const pl = (t.proposta_payload ?? {}) as any;
            return pl?.meta?.sem_email_explicito === true || pl?.tool === "lancar_ocorrencia";
          }) ?? candidatos[0];
      } else {
        match =
          candidatos.find((t: any) => {
            const pl = (t.proposta_payload ?? {}) as any;
            return pl?.meta?.modo === "completo" || pl?.tool === "lancar_oc_e_enviar_email";
          }) ??
          candidatos.find((t: any) => {
            const pl = (t.proposta_payload ?? {}) as any;
            return pl?.meta?.sem_email_explicito !== true;
          }) ??
          candidatos[0];
      }
    }
    if (!match) {
      setLoading(false);
      toast.warning(`Proposta oc=${codigoSsw} não está mais pendente`);
      return;
    }
    const pl = ((match as any).proposta_payload ?? {}) as any;
    // BUG FIX (NF 59299 Larissa 23/06): oc=44 (devolução) SEMPRE precisa de
    // quantidade_volumes + motivo. Backend bloqueia se vier sem. Abre modal
    // de devolução em vez de aprovar direto. Vale para 44 solo e combo 33+44.
    const ehCombo3344 = pl?.tool === "lancar_combo_33_44";
    const ehOc44 = Number(pl?.args?.codigo_ssw) === 44;
    if (ehOc44 || ehCombo3344) {
      setLoading(false);
      setModal44ComboMode(ehCombo3344);
      setModal44TodoId((match as any).id);
      return;
    }
    // Decisão "abre composer x confirma sem-email" vem do TODO RESOLVIDO,
    // nunca do número da oc. Modo completo (ou tool de envio) abre o editor.
    const ehCompleto =
      pl?.meta?.modo === "completo" || pl?.tool === "lancar_oc_e_enviar_email";
    const ehSemEmailExplicito = pl?.meta?.sem_email_explicito === true;
    if (ehCompleto) {
      setLoading(false);
      setModalTemplateSugerido(template ?? null);
      setModalTodoId((match as any).id);
      return;
    }
    // CONFIRMAÇÃO obrigatória para ação deliberada "lançar oc SEM notificar".
    if (ehSemEmailExplicito) {
      const codigo = Number(pl?.args?.codigo_ssw) || codigoSsw;
      const ok = window.confirm(
        `Esta ação lança a oc ${codigo} no SSW mas NÃO envia e-mail. O cliente NÃO será notificado. Confirmar?`,
      );
      if (!ok) {
        setLoading(false);
        return;
      }
    }


    toast.info(`Aprovando oc=${codigoSsw} com defaults da IA…`);
    const { error } = await supabase.rpc("aprovar_e_executar", {
      p_todo_id: (match as any).id,
    } as any);
    setLoading(false);
    if (error) {
      toast.error("Erro ao aprovar", { description: error.message });
      return;
    }
    toast.success(`✓ oc=${codigoSsw} aprovada — em execução`);
    qc.invalidateQueries({ queryKey: ["todos-pendentes", cardId] });
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["card-events", cardId] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }

  function dispatchScroll() {
    window.dispatchEvent(
      new CustomEvent("aprovar-sugestao-ia", {
        detail: { codigoSsw, acaoKey, template, motivo },
      }),
    );
  }


  async function handleModalConfirm(extras: Record<string, unknown>) {
    if (!supabase || !modalTodoId) return;
    setSubmittingModal(true);
    const { error } = await supabase.rpc("aprovar_e_executar", {
      p_todo_id: modalTodoId,
      p_extras: extras,
    } as any);
    setSubmittingModal(false);
    if (error) {
      toast.error("Erro ao aprovar", { description: error.message });
      return;
    }
    toast.success(`✓ oc=${codigoSsw} aprovada — email enviando…`);
    setModalTodoId(null);
    qc.invalidateQueries({ queryKey: ["todos-pendentes", cardId] });
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["card-events", cardId] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }

  async function handleModal44Confirm(extras: Record<string, unknown>) {
    if (!supabase || !modal44TodoId) return;
    setSubmittingModal44(true);
    // Combo 33+44 espera os dados da 44 aninhados em combo_44.
    // oc=44 solo manda os campos diretos em extras.
    const payloadExtras = modal44ComboMode ? { combo_44: extras } : extras;
    const { error } = await supabase.rpc("aprovar_e_executar", {
      p_todo_id: modal44TodoId,
      p_extras: payloadExtras,
    } as any);
    setSubmittingModal44(false);
    if (error) {
      toast.error("Erro ao aprovar", { description: error.message });
      return;
    }
    toast.success(
      modal44ComboMode
        ? "✓ Combo 33+44 aprovado — em execução"
        : "✓ oc=44 aprovada — em execução",
    );
    setModal44TodoId(null);
    qc.invalidateQueries({ queryKey: ["todos-pendentes", cardId] });
    qc.invalidateQueries({ queryKey: ["card", cardId] });
    qc.invalidateQueries({ queryKey: ["card-events", cardId] });
    qc.invalidateQueries({ queryKey: ["cards"] });
  }

  return (
    <>
      <button
        type="button"
        onClick={directApprove ? aprovarDireto : dispatchScroll}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 font-body text-[13px] font-medium text-paper transition-colors hover:bg-ink-soft active:scale-[0.98] disabled:opacity-50"
      >
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {label}
      </button>
      {modalTodoId && (
        <EditarEmailModal
          todoId={modalTodoId}
          templateSugeridoIA={modalTemplateSugerido}
          onClose={() => setModalTodoId(null)}
          onConfirm={handleModalConfirm}
          submitting={submittingModal}
        />
      )}
      {modal44TodoId && (
        <ModalAprovarOc44
          titulo={
            modal44ComboMode
              ? "Aprovar combo 33+44 — dados da devolução (oc 44)"
              : "Aprovar e lançar oc 44 — retorno de carga"
          }
          onClose={() => setModal44TodoId(null)}
          onConfirm={handleModal44Confirm}
          submitting={submittingModal44}
        />
      )}
    </>
  );
}


function ExpandableHeader({
  cardId,
  eyebrow,
  render,
}: {
  cardId: string;
  eyebrow: string;
  render: (expanded: boolean, toggle: () => void) => React.ReactNode;
}) {
  const [expanded, setExpanded] = usePersistentState<boolean>(
    `ia-banner-expand-${cardId}`,
    false,
  );
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Eyebrow>{eyebrow}</Eyebrow>
      </div>
      {render(expanded, () => setExpanded((v) => !v))}
    </>
  );
}

function ExpandToggleButton({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-ink/30 bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-ink/5"
    >
      {expanded ? (
        <>
          <ChevronUp className="h-3 w-3" /> Recolher
        </>
      ) : (
        <>
          <ChevronDown className="h-3 w-3" /> Expandir
        </>
      )}
    </button>
  );
}

function SecondaryAction({ label }: { label: string }) {
  function scroll() {
    const el = document.querySelector("[data-acoes-sugeridas]");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <button
      type="button"
      onClick={scroll}
      className="text-[12px] text-ink-soft underline underline-offset-4 hover:text-ink"
    >
      {label}
    </button>
  );
}

/* ============================================================================
 * Feedback (IA acertou / IA errou)
 * ========================================================================== */

function FeedbackBotoes({
  card,
  rpcAcerto,
  rpcErro,
  tipoFeedback,
  decisaoLabel,
  erroMotivoOnly,
}: {
  card: CardRow;
  rpcAcerto: string;
  rpcErro: string;
  tipoFeedback?: string;
  decisaoLabel: string;
  erroMotivoOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [acertou, setAcertou] = useState(false);
  const [modalAberto, setModalAberto] = useState(false);
  const [registrando, setRegistrando] = useState(false);

  async function registrarAcerto() {
    if (!supabase) return;
    setRegistrando(true);
    const { error } = await supabase.rpc(rpcAcerto as any, {
      p_card_id: card.id,
      p_observacao: null,
    });
    setRegistrando(false);
    if (error) {
      toast.error("Não consegui registrar: " + error.message);
      return;
    }
    setAcertou(true);
    toast.success("✓ Feedback registrado — vai alimentar o indicador de acerto da IA");
    qc.invalidateQueries({ queryKey: ["agente-metricas"] });
    qc.invalidateQueries({ queryKey: ["card", card.id] });
  }

  return (
    <>
      <div className="ml-auto flex items-center gap-2">
        {acertou ? (
          <span className="inline-flex items-center gap-1 rounded px-2 py-1 font-mono text-[11px] text-positive">
            <Check className="h-3 w-3" /> registrado
          </span>
        ) : (
          <button
            type="button"
            onClick={registrarAcerto}
            disabled={registrando}
            className="rounded px-2 py-1 font-mono text-[11px] text-positive hover:bg-positive-soft disabled:opacity-40"
            title="A sugestão da IA está correta"
          >
            ✓ IA acertou
          </button>
        )}
        <span className="text-ink-mute">·</span>
        <button
          type="button"
          onClick={() => setModalAberto(true)}
          className="rounded px-2 py-1 font-mono text-[11px] text-ink-mute hover:bg-signal-soft hover:text-signal"
          title="A IA errou — registrar correção"
        >
          ⌐ IA errou
        </button>
      </div>
      {modalAberto && (
        erroMotivoOnly ? (
          <ModalIaErrouMotivo
            card={card}
            rpc={rpcErro}
            decisaoLabel={decisaoLabel}
            onClose={() => setModalAberto(false)}
          />
        ) : (
          <ModalIaErrou
            card={card}
            rpc={rpcErro}
            tipoFeedback={tipoFeedback}
            decisaoLabel={decisaoLabel}
            onClose={() => setModalAberto(false)}
          />
        )
      )}
    </>
  );
}

function ModalIaErrouMotivo({
  card,
  rpc,
  decisaoLabel,
  onClose,
}: {
  card: CardRow;
  rpc: string;
  decisaoLabel: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const habilitado = motivo.trim().length >= 10 && !enviando;

  async function enviar() {
    if (!supabase) return;
    setEnviando(true);
    const { error } = await supabase.rpc(rpc as any, {
      p_card_id: card.id,
      p_motivo: motivo.trim(),
    } as any);
    setEnviando(false);
    if (error) {
      toast.error("Não foi possível registrar: " + error.message);
      return;
    }
    toast.success("Feedback registrado — vai abastecer o indicador de acerto da IA.");
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    qc.invalidateQueries({ queryKey: ["agente-metricas"] });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-md borderborder-ink bg-paper p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">
            Você acha que a IA decidiu errado neste card?
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="mb-3 border border-ink/15 bg-paper-deep/40 px-2 py-1.5 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
            Decisão da IA:
          </span>{" "}
          {decisaoLabel}
        </div>
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          Por que a IA errou? * (mín 10 chars)
        </label>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={4}
          placeholder="Ex: ressarcimento não pediu relançar — era só atualização interna."
          className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-sm"
        />
        <div className="mt-1 text-right font-mono text-[10px] text-ink-soft">
          {motivo.trim().length} / 10 mín
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={enviar}
            disabled={!habilitado}
            className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper hover:bg-ink disabled:opacity-40"
          >
            {enviando ? "..." : "Enviar feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalIaErrou({
  card,
  rpc,
  tipoFeedback,
  decisaoLabel,
  onClose,
}: {
  card: CardRow;
  rpc: string;
  tipoFeedback?: string;
  decisaoLabel: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [opcao, setOpcao] = useState("");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const habilitado = opcao && motivo.trim().length >= 10 && !enviando;

  async function enviar() {
    if (!supabase) return;
    setEnviando(true);
    const codigo = opcao === "outro" ? null : Number(opcao);
    const params: Record<string, unknown> = {
      p_card_id: card.id,
      p_decisao_correta_codigo_ssw: codigo,
      p_motivo_correcao: motivo.trim(),
    };
    // p_tipo_feedback removido (mig 192) — agora computado no banco.
    void tipoFeedback;
    const { error } = await supabase.rpc(rpc as any, params as any);
    setEnviando(false);
    if (error) {
      toast.error("Não foi possível registrar: " + error.message);
      return;
    }
    toast.success("Feedback registrado — vai abastecer o indicador de acerto da IA.");
    qc.invalidateQueries({ queryKey: ["card", card.id] });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-md borderborder-ink bg-paper p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">
            Você acha que a IA decidiu errado neste card?
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-sm text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="mb-3 border border-ink/15 bg-paper-deep/40 px-2 py-1.5 text-xs">
          <span className="font-mono text-[10px] uppercase tracking-wider opacity-70">
            Decisão da IA:
          </span>{" "}
          {decisaoLabel}
        </div>

        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          Qual era a decisão correta? *
        </label>
        <select
          value={opcao}
          onChange={(e) => setOpcao(e.target.value)}
          className="mb-3 w-full border border-ink/30 bg-paper px-2 py-1.5 text-sm"
        >
          <option value="">Selecione</option>
          {OPCOES_OC.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>

        <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          Por que a IA errou? * (mín 10 chars)
        </label>
        <textarea
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={4}
          placeholder="Ex: tinha ressalva escrita na foto e a IA não detectou."
          className="w-full border border-ink/30 bg-paper px-2 py-1.5 text-sm"
        />
        <div className="mt-1 text-right font-mono text-[10px] text-ink-soft">
          {motivo.trim().length} / 10 mín
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            className="border border-ink/30 bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={enviar}
            disabled={!habilitado}
            className="bg-sal px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-paper hover:bg-ink disabled:opacity-40"
          >
            {enviando ? "..." : "Enviar feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Alerta caixa lacrada (oc=35) + Botão "Ver evidência" inline
 * ========================================================================== */

function AlertaCaixaLacrada({
  aviso,
}: {
  aviso: CardRow["aviso_alteracao_oc"];
}) {
  if (!aviso?.alerta_caixa_lacrada) return null;
  return (
    <div className="mb-3 mt-3 rounded-r-md border-l-4 border-amber-400 bg-amber-50 px-4 py-2">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        Evidência indica caixa lacrada
      </p>
      <p className="mt-1 text-[12px] text-amber-700">
        {aviso.alerta_caixa_lacrada_motivo ??
          "IA detectou indicação de falta de itens em embalagem íntegra."}
      </p>
      <p className="mt-1 text-[12px] italic text-amber-700">
        Pode não haver devolução real — apenas ressarcimento dos itens faltantes.
        Revise o template e o corpo do email antes de aprovar (você pode editar manualmente).
      </p>
    </div>
  );
}

function VerEvidenciaButton({ card }: { card: CardRow }) {
  const [open, setOpen] = useState(false);

  const codigoOc = card.cod_ultima_ocorrencia;
  const temUrl = !!card.aviso_alteracao_oc?.evidencia_foto_url;
  if (!temUrl || codigoOc == null) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-ink/30 bg-paper px-3 py-1.5 font-body text-[12px] text-ink-soft transition-colors hover:border-ink hover:text-ink"
      >
        <ImageIcon className="h-3.5 w-3.5" />
        Ver evidência
      </button>
      <ModalEvidencia
        cardId={card.id}
        codigoOc={codigoOc}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/* ============================================================================
 * Bloco "Transcrição da ressalva" — destaque pras ocs que dependem de manuscrito
 * ========================================================================== */

const OCS_COM_RESSALVA = [10, 19, 35];

/**
 * Bloco rico de evidência (resumo da foto + transcrição manuscrita).
 * Lê de card.ia_sugestao_evidencia[String(oc)].analise.
 * Usado pelo banner oc=13 (e qualquer outro que tenha analise rica disponível).
 */
function IaEvidenciaResumo({
  card,
  fallback,
}: {
  card: CardRow;
  fallback?: string | null;
}) {
  const oc = card.cod_ultima_ocorrencia;
  const ev = oc != null
    ? card.ia_sugestao_evidencia?.[String(oc)]?.analise ?? null
    : null;

  const resumo = ev?.resumo_situacao?.trim() || null;
  const ressalva = ev?.ressalva_texto?.trim() || null;

  // Sem evidência rica → cai pro fallback (motivo bruto), pra não regredir.
  if (!resumo && !ressalva) {
    return fallback ? <Quote>{fallback}</Quote> : null;
  }

  return (
    <div className="mt-3 space-y-3">
      {resumo && (
        <p className="font-display text-[13px] leading-snug text-ink">
          {resumo}
        </p>
      )}
      {ressalva && (
        <div className="rounded-r-md border-l-4 border-amber-400 bg-amber-50/60 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-base" aria-hidden>📝</span>
            <span className="font-display text-[10px] font-semibold uppercase tracking-wide text-amber-900">
              Transcrição da ressalva (lida da foto pela IA Vision)
            </span>
          </div>
          <blockquote className="border-l-2 border-amber-300 pl-3 font-mono text-[13px] leading-relaxed text-ink">
            “{ressalva}”
          </blockquote>
        </div>
      )}
    </div>
  );
}


function RessalvaOuMotivo({
  card,
  oc,
  r,
  hideMotivoQuote,
}: {
  card: CardRow;
  oc: number | null;
  r: NonNullable<CardRow["analise_padrao_resultado"]>;
  hideMotivoQuote?: boolean;
}) {
  const motivo = r.motivo_extraido?.trim() ?? null;
  const mostrarBloco = oc != null && OCS_COM_RESSALVA.includes(oc);

  if (!mostrarBloco) {
    return motivo && !hideMotivoQuote ? <Quote>{motivo}</Quote> : null;
  }

  const ressalvaTexto = r.ressalva_texto?.trim() ?? null;
  const temRessalva = r.tem_ressalva === true && !!ressalvaTexto;

  return (
    <div className="mt-3 rounded-r-md border-l-4 border-amber-400 bg-amber-50/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-base" aria-hidden>📝</span>
        <span className="font-display text-[10px] font-semibold uppercase tracking-wide text-amber-900">
          {temRessalva
            ? "Transcrição da ressalva (lida da foto pela IA Vision)"
            : "Ressalva manuscrita"}
        </span>
      </div>

      {temRessalva ? (
        <blockquote className="border-l-2 border-amber-300 pl-3 font-mono text-[13px] leading-relaxed text-ink">
          “{ressalvaTexto}”
        </blockquote>
      ) : motivo ? (
        <p className="pl-3 text-[13px] italic text-ink-mute">
          Sem ressalva manuscrita identificada. Motivo lido da instrução do motorista:
          <br />“{motivo}”
        </p>
      ) : (
        <p className="pl-3 text-[13px] text-rose-700">
          ⚠️ A IA não encontrou ressalva manuscrita legível na foto. Recomenda revisar manualmente.
        </p>
      )}

      <div className="mt-2 pl-3">
        <VerFotoOriginalLink card={card} />
      </div>
    </div>
  );
}

function VerFotoOriginalLink({ card }: { card: CardRow }) {
  const [open, setOpen] = useState(false);
  const codigoOc = card.cod_ultima_ocorrencia;
  const temUrl = !!card.aviso_alteracao_oc?.evidencia_foto_url;
  if (!temUrl || codigoOc == null) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-[11px] text-amber-900 underline decoration-dotted underline-offset-4 hover:text-amber-700"
      >
        🖼 Ver foto original
      </button>
      <ModalEvidencia
        cardId={card.id}
        codigoOc={codigoOc}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
