// =============================================================================
// validar-tripe-ssw.ts — guard inviolável pré-submit no portal SSW
//
// Caio 2026-06-08: substitui o guard `validarChaveCteCorrespondeCtrcDoCard`
// (que dependia da tabela `nf_chave_cte`) por validação direta do HTML
// retornado pelo portal SSW na tela `act=O`.
//
// REGRA INVIOLÁVEL (CLAUDE.md): nenhum lançamento pode ser feito identificando
// o documento só por NF. Mesma NF pode aparecer em múltiplos CTRCs (cancelados,
// reentregas, complementares, finalizados). Bug âncora: NF 142371 OVD396328-4
// (ativo) vs OVD399372-8 (cancelado) — sem guard, executor lançou no cancelado.
//
// O que valida (Tier 1, sem fetch extra ao SSW):
//   1. CTRC retornado pelo SSW (label "CTRC:") bate caractere-a-caractere com
//      card.ctrc (normalizado: upper, sem espaços extras).
//   2. NF do CTRC retornada pelo SSW (label "Nota fiscal:") bate com card.nf
//      (normalização: zeros à esquerda + prefixo "N/" tolerados).
//   3. "Localização atual" NÃO contém keywords proibidas (ENTREGUE, BAIXADO,
//      FINALIZADO, CANCELADO, SUBSTITUIDO) que indicam CTRC encerrado.
//
// O que NÃO valida (Tier 2, decisão pendente Caio):
//   * CNPJ pagador — não exposto no form `act=O`. Validar exigiria fetch
//     adicional (ex: tela `/bin/ssw0203?seq_ctrc=X` ou outra com detalhe).
//     Pragmaticamente, como `buscarNFInterno(ctrcEsperado=card.ctrc)` já
//     garante o CTRC certo via NF, e CTRC pertence a 1 (pagador, NF) único
//     na prática, validar NF + CTRC + localização cobre o cenário NF 142371.
//
// Comportamento em falha:
//   - Retorna `{ ok: false, motivo, detalhe }`. Caller (envelope
//     `lancarSswPortal`) NÃO chama portal, registra card_event
//     `TripeRejeitadoPeloGuard` + audit_log + reverte card.
// =============================================================================

export type TripeValidacao =
  | { ok: true; ctrc_ssw: string; nf_ssw: string; localizacao: string }
  | {
      ok: false;
      motivo:
        | "ctrc_divergente"
        | "nf_divergente"
        | "ctrc_finalizado"
        | "parse_falhou";
      detalhe: string;
      extraido?: { ctrc_ssw?: string; nf_ssw?: string; localizacao?: string };
    };

const LOCALIZACAO_PROIBIDA = [
  "ENTREGUE",
  "BAIXADO",
  "FINALIZADO",
  "CANCELADO",
  "SUBSTITUIDO",
  "SUBSTITUÍDO",
];

export function validarTripeCtrcNfPagador(args: {
  cardCtrc: string;
  cardNf: string;
  htmlAtoO: string;
}): TripeValidacao {
  const ctrcSsw = extrairCtrcDoHtml(args.htmlAtoO);
  const nfSsw = extrairNfDoHtml(args.htmlAtoO);
  const localizacao = extrairLocalizacaoAtualDoHtml(args.htmlAtoO);

  if (!ctrcSsw || !nfSsw) {
    return {
      ok: false,
      motivo: "parse_falhou",
      detalhe:
        `Não consegui extrair CTRC e/ou NF do HTML do form act=O. ` +
        `ctrc_ssw=${ctrcSsw ?? "null"} nf_ssw=${nfSsw ?? "null"}. ` +
        `Layout do SSW pode ter mudado — verificar.`,
      extraido: { ctrc_ssw: ctrcSsw, nf_ssw: nfSsw, localizacao },
    };
  }

  const ctrcCardNorm = normalizarCtrc(args.cardCtrc);
  const ctrcSswNorm = normalizarCtrc(ctrcSsw);
  if (ctrcCardNorm !== ctrcSswNorm) {
    return {
      ok: false,
      motivo: "ctrc_divergente",
      detalhe:
        `CTRC do card (${ctrcCardNorm}) não bate com CTRC retornado pelo SSW ` +
        `(${ctrcSswNorm}). Bloqueio inviolável — abortando antes do submit.`,
      extraido: { ctrc_ssw: ctrcSsw, nf_ssw: nfSsw, localizacao },
    };
  }

  const nfCardNorm = normalizarNf(args.cardNf);
  const nfSswNorm = normalizarNf(nfSsw);
  if (nfCardNorm !== nfSswNorm) {
    return {
      ok: false,
      motivo: "nf_divergente",
      detalhe:
        `NF do card (${nfCardNorm}) não bate com NF do CTRC no SSW ` +
        `(${nfSswNorm}, raw="${nfSsw}"). Bloqueio inviolável.`,
      extraido: { ctrc_ssw: ctrcSsw, nf_ssw: nfSsw, localizacao },
    };
  }

  if (localizacao) {
    const upper = localizacao.toUpperCase();
    const proibida = LOCALIZACAO_PROIBIDA.find((k) => upper.includes(k));
    if (proibida) {
      return {
        ok: false,
        motivo: "ctrc_finalizado",
        detalhe:
          `Localização atual do CTRC contém "${proibida}" (raw="${localizacao}"). ` +
          `CTRC encerrado — não posso lançar oc. Provavelmente cliente já recebeu ` +
          `ou doc foi cancelado/substituído.`,
        extraido: { ctrc_ssw: ctrcSsw, nf_ssw: nfSsw, localizacao },
      };
    }
  }

  return {
    ok: true,
    ctrc_ssw: ctrcSsw,
    nf_ssw: nfSsw,
    localizacao: localizacao ?? "",
  };
}

// --- helpers internos ---

// Decoder mínimo (entities comuns do SSW iso-8859-1). Mantém só o necessário
// pros 3 campos extraídos. Replicação do decode do ssw-internal-client.ts —
// não importar pra evitar dep circular.
function decodeEntities(s: string): string {
  return s
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&atilde;/gi, "ã")
    .replace(/&otilde;/gi, "õ")
    .replace(/&ccedil;/gi, "ç")
    .replace(/&ecirc;/gi, "ê")
    .replace(/&acirc;/gi, "â")
    .replace(/&ocirc;/gi, "ô")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

function extrairCtrcDoHtml(html: string): string | null {
  // Padrão observado no portal (Caio 2026-06-08 diag NF 357645):
  //   <div class=texto ...>CTRC:</div>
  //   <A id="1" ... class=baselnk ... >APO287337-1</A>
  const m = html.match(
    /CTRC:<\/div>\s*<A\b[^>]*class=baselnk[^>]*>([^<]+)<\/A>/i,
  );
  if (!m) return null;
  return decodeEntities(m[1]!).trim();
}

function extrairNfDoHtml(html: string): string | null {
  // Padrão observado:
  //   <div class=texto ...>Nota&nbsp;fiscal:</div>
  //   <div class=data ...>1/000357645</div>
  const m = html.match(
    /Nota&nbsp;fiscal:<\/div>\s*<div\b[^>]*class=data[^>]*>([^<]+)<\/div>/i,
  );
  if (!m) return null;
  return decodeEntities(m[1]!).trim();
}

function extrairLocalizacaoAtualDoHtml(html: string): string | null {
  // Padrão observado:
  //   <div class=texto ...>Localiza&ccedil;&atilde;o&nbsp;&nbsp;atual:</div>
  //   <div class=data ...>CTRC ENTREGUE / BAIXADO</div>  (vermelho)
  const m = html.match(
    /Localiza&ccedil;&atilde;o[^<]*atual:<\/div>\s*<(?:div|A|span)\b[^>]*>([^<]+)<\/(?:div|A|span)>/i,
  );
  if (!m) return null;
  return decodeEntities(m[1]!).trim();
}

function normalizarCtrc(s: string): string {
  return (s ?? "").toUpperCase().replace(/\s+/g, "").trim();
}

function normalizarNf(s: string): string {
  // SSW devolve "1/000357645" (série/numero com zeros). Card grava "357645".
  // Normaliza removendo zeros à esquerda do número e prefixo "<série>/".
  const trimmed = (s ?? "").trim();
  // Pega só dígitos após o último "/" (ou string inteira se sem "/")
  const numStr = trimmed.includes("/")
    ? trimmed.substring(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  return numStr.replace(/^0+/, "") || "0";
}
