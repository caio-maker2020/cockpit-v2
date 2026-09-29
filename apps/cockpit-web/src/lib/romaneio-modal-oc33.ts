// Situação do romaneio do dossiê nos modais da oc 33 (33 sozinha e 33+44).
//
// Carlos 29/09 (NF 435297, Karoline): relançar a 33 depois de uma 26 era
// impossível. A 1ª 33 envia o romaneio e o apaga do bucket no mesmo minuto;
// a lista do modal só mostra anexo vivo (auditoria 25/07, NF 158084) e o
// guard exigia o arquivo pelo NOME — o aviso mandava "selecione-o na lista"
// um arquivo que a própria lista escondia.
//
// Regra (a trava continua valendo, só deixa de pedir o impossível):
//   - romaneio na lista            → exige selecionar (mensagem de sempre);
//   - apagado + 33 SOZINHA + imagem → segue: o executor busca de novo no
//     e-mail do cliente (materializarOc33Completude → reanexarEvidenciaDoDossie)
//     e, se não achar, REVERTE sem lançar (fail-closed);
//   - apagado + 33+44              → continua barrando: processarComboPortal33_44
//     NÃO materializa, a 33 sairia sem romaneio (o erro da NF 158084);
//   - apagado + PDF                → continua barrando: o executor não converte PDF;
//   - a busca já falhou neste card → continua barrando, com o caminho manual
//     (sem isso a operadora aprovaria→reverteria em loop).

import { anexosCobremRomaneio } from "./romaneio-cobertura";

/**
 * Mesmos tipos que o executor aceita como foto do SSW.
 * ESPELHO de `ehImagemMimeSsw` em supabase/functions/_shared/extravio-parcial-dossie.ts
 * (guard em romaneio-modal-oc33.test.ts). Aceitar aqui um tipo que o executor
 * recusa faria a 33 sozinha seguir e ser revertida.
 */
export const MIMES_IMAGEM_SSW: readonly string[] = ["image/jpeg", "image/jpg", "image/pjpeg", "image/png"];

/** Evento que o executor grava quando não consegue reanexar uma evidência. */
export const EVENTO_REBUSCA_FALHOU = "Oc33CompletudeReanexoFalhou";

export type RomaneioDoDossie = {
  filename: string;
  mime_type: string | null;
  /** Quando o dossiê viu o romaneio — falha de busca anterior a isso é de outro arquivo. */
  visto_em: string | null;
};

export type FalhaDeRebusca = { created_at: string; payload: unknown };

export type SituacaoRomaneio =
  | { tipo: "nao_exigido" }
  | { tipo: "na_lista"; filename: string }
  | { tipo: "rebusca_no_email"; filename: string }
  | { tipo: "anexar_manual"; filename: string; motivo: "combo" | "pdf" | "rebusca_falhou" };

/** Romaneio exigido pelo dossiê (fonte=anexo), com a data em que foi visto. */
export function romaneioDoDossie(card: {
  agent_state?: Record<string, unknown> | null;
}): RomaneioDoDossie | null {
  const ep = card.agent_state?.["extravio_parcial"] as
    | {
        caso?: string;
        dossie?: {
          romaneio?: {
            presente?: boolean;
            fonte?: string;
            filename?: string | null;
            mime_type?: string | null;
            visto_em?: string | null;
          };
        };
      }
    | undefined;
  if (!ep || (ep.caso !== "1" && ep.caso !== "2")) return null;
  const r = ep.dossie?.romaneio;
  if (!r?.presente || r.fonte !== "anexo" || !r.filename) return null;
  return { filename: r.filename, mime_type: r.mime_type ?? null, visto_em: r.visto_em ?? null };
}

/** A busca do romaneio no e-mail já falhou para ESTE romaneio? */
export function rebuscaDoRomaneioJaFalhou(
  falhas: ReadonlyArray<FalhaDeRebusca>,
  vistoEm: string | null,
): boolean {
  const desde = vistoEm ? Date.parse(vistoEm) : NaN;
  return falhas.some((f) => {
    const quando = Date.parse(f.created_at);
    if (Number.isFinite(desde) && Number.isFinite(quando) && quando < desde) return false;
    const faltando = (f.payload as { faltando?: unknown } | null)?.faltando;
    return Array.isArray(faltando) && faltando.some((x) => String(x).startsWith("romaneio"));
  });
}

export function situacaoRomaneioNoModal(args: {
  romaneio: RomaneioDoDossie | null;
  /** Nomes dos anexos que o modal oferece (só os vivos). */
  nomesNaLista: ReadonlyArray<string | null | undefined>;
  modal: "solo" | "combo";
  falhasDeRebusca: ReadonlyArray<FalhaDeRebusca>;
  /**
   * false enquanto a lista de anexos (ou o histórico de falhas) não carregou,
   * ou se a consulta falhou: sem saber o que a lista tem, vale a regra de
   * antes de 29/09 — exige o romaneio selecionado.
   */
  carregado: boolean;
}): SituacaoRomaneio {
  const { romaneio, nomesNaLista, modal, falhasDeRebusca, carregado } = args;
  if (!romaneio) return { tipo: "nao_exigido" };
  const filename = romaneio.filename;
  if (!carregado) return { tipo: "na_lista", filename };
  if (anexosCobremRomaneio(nomesNaLista, filename)) return { tipo: "na_lista", filename };
  if (modal === "combo") return { tipo: "anexar_manual", filename, motivo: "combo" };
  if (!MIMES_IMAGEM_SSW.includes((romaneio.mime_type ?? "").toLowerCase())) {
    return { tipo: "anexar_manual", filename, motivo: "pdf" };
  }
  if (rebuscaDoRomaneioJaFalhou(falhasDeRebusca, romaneio.visto_em)) {
    return { tipo: "anexar_manual", filename, motivo: "rebusca_falhou" };
  }
  return { tipo: "rebusca_no_email", filename };
}

export type DecisaoConfirmar =
  | { tipo: "seguir" }
  | { tipo: "bloquear"; titulo: string; descricao: string };

const TEXTO_MANUAL =
  "Salve esse arquivo do e-mail do cliente e anexe em \"+ Adicionar arquivo\", sem mudar o nome.";

/** Explicação para a operadora quando o romaneio já não está na lista (null nos outros casos). */
export function avisoRomaneioIndisponivel(s: SituacaoRomaneio): string | null {
  if (s.tipo === "rebusca_no_email") {
    return `O romaneio "${s.filename}" já foi enviado ao SSW na 33 anterior e não fica mais guardado aqui. Ao confirmar, o sistema busca esse arquivo de novo no e-mail do cliente e anexa junto. Se não conseguir, nada é lançado e você é avisada.`;
  }
  if (s.tipo !== "anexar_manual") return null;
  const base = `O romaneio "${s.filename}" já foi enviado ao SSW na 33 anterior e não fica mais guardado aqui.`;
  if (s.motivo === "combo") return `${base} Na 33+44 o sistema não busca o arquivo sozinho. ${TEXTO_MANUAL}`;
  if (s.motivo === "rebusca_falhou") {
    return `${base} O sistema já tentou buscar de novo no e-mail do cliente e não conseguiu. ${TEXTO_MANUAL}`;
  }
  return `${base} Ele é PDF, e esta tela ainda não consegue anexá-lo de novo. Peça ajuda ao suporte do Cockpit informando a NF.`;
}

/**
 * Decide o clique em "Confirmar". Só passa sem o romaneio selecionado no caso
 * `rebusca_no_email` — é o executor quem garante o arquivo (ou reverte).
 */
export function decidirConfirmacaoRomaneio(
  s: SituacaoRomaneio,
  nomesSelecionados: ReadonlyArray<string | null | undefined>,
): DecisaoConfirmar {
  if (s.tipo === "nao_exigido" || s.tipo === "rebusca_no_email") return { tipo: "seguir" };
  if (anexosCobremRomaneio(nomesSelecionados, s.filename)) return { tipo: "seguir" };
  if (s.tipo === "na_lista") {
    // Texto de antes de 29/09, sem mudança.
    return {
      tipo: "bloquear",
      titulo: `Anexe o romaneio do dossiê: "${s.filename}"`,
      descricao:
        "A oc 33 de completude exige o romaneio anexado. Selecione-o na lista (PDF é convertido pra JPEG automaticamente) — sem ele o SSW reverte o lançamento.",
    };
  }
  return {
    tipo: "bloquear",
    titulo: `Anexe o romaneio do dossiê: "${s.filename}"`,
    descricao: avisoRomaneioIndisponivel(s) ?? TEXTO_MANUAL,
  };
}
