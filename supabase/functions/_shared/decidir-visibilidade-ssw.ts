// =============================================================================
// decidir-visibilidade-ssw.ts — CONTRATO da função-mãe de visibilidade do card.
//
// ⚠️ STUB DELIBERADO (PR1 — escopo v3-LIMITED). O CORPO de
// `decidirVisibilidadePorSsw` (PR2) e de `estadoFinalParaDecisao` (PR4) NÃO está
// implementado nesta rodada. Os testes em `decidir-visibilidade-ssw.test.ts` já
// encodam o contrato e ficam VERMELHOS até o PR2/PR4 preencherem o corpo.
//
// Raiz NF 346896: o discriminador deployado compara a HORA da ocorrência no SSW
// (minuto cheio, relógio do SSW) com `acoes_executadas_ssw.iniciado_em` (segundos,
// relógio da edge). Skew de ~1-2 min escondia oc de Relacionamento nova de
// terceiro lançada no MESMO minuto da ação do Cockpit.
//
// Direção aprovada (Caio): Bastão é GATILHO, SSW é JUIZ. Sinal primário =
// IDENTIDADE (ai.salex × terceiro); ORDEM do SSW = reforço; HORA sai da decisão.
// Em dúvida → MOSTRAR. Nenhuma decisão de invisibilidade escapa desta função, e
// nenhum Relacionamento fica invisível sem prazo (a política de prazo vive no
// caller — ver `estadoFinalParaDecisao` + watchdog).
// =============================================================================

/** As 4 decisões EXPLÍCITAS (nada de reabrir/suprimir ambíguo). */
export type DecisaoVisibilidade =
  | "MOSTRAR_OPERADOR" // oc real mais recente = Relacionamento ≠54 de terceiro → AGUARDANDO VOCÊ
  | "AGUARDANDO_CLIENTE" // oc real mais recente = 54 → AGUARDANDO_CLIENTE (nunca "manter TRANSFERIDO")
  | "MANTER_FORA_RELACIONAMENTO" // topo não-relac OU a própria ação do Cockpit → não reabre
  | "INDEFINIDO_RETRY"; // sem SSW fresco / cache divergente / sem evidência → não decide, re-tenta com PRAZO

export type FonteDecisao =
  | "identidade"
  | "ordem"
  | "regra_54"
  | "fora_escopo"
  | "sem_ssw"
  | "cache_stale"
  | "duvida_mostra";

/** Uma linha do histórico SSW (mais-recente-primeiro). */
export interface OcorrenciaSsw {
  codigo: number | null;
  usuario: string | null;
  /** "DD/MM/YY HH:MM" — SÓ diagnóstico. NUNCA comparar com relógio do Cockpit. */
  data?: string | null;
}

export interface ArgsVisibilidade {
  /** Histórico SSW ordenado: índice 0 = ocorrência mais recente. */
  ocorrenciasSsw: OcorrenciaSsw[];
  /** Pertence ao conjunto de Relacionamento? (dicionário). */
  ehRelac: (oc: number) => boolean;
  /** Conta de lançamento do Cockpit = `ai.salex` (SSW_LANCAMENTO_USUARIO). */
  contaLancamentoCockpit: string;
  /** Código da última oc lançada pelo Cockpit (acoes_executadas_ssw) — reforço por ordem. */
  codigoUltimoLancamentoCockpit: number | null;
  /** false = fonte é cache stale/divergente → NUNCA esconder; em dúvida → INDEFINIDO_RETRY. */
  sswFresco: boolean;
}

export interface ResultadoVisibilidade {
  decisao: DecisaoVisibilidade;
  fonte: FonteDecisao;
  motivo: string;
  // diagnósticos p/ observabilidade (PR0) e shadow (PR3):
  ocMaisRecente: number | null;
  usuarioMaisRecente: string | null;
  indiceMaisRecente: number | null;
  indiceUltimoLancamentoCockpit: number | null;
}

/** Normaliza autor p/ comparação de identidade (lower + trim). Puro/testável. */
export function normalizarAutor(u: string | null | undefined): string {
  return (u ?? "").trim().toLowerCase();
}

/**
 * CONTRATO (corpo no PR2). Decide a visibilidade do card pela VERDADE DO SSW.
 *
 * Lógica aprovada (identidade → ordem → dúvida-mostra; SEM hora):
 *   1. Sem oc codificada no SSW  → INDEFINIDO_RETRY (fonte sem_ssw).
 *      Decisão que ESCONDERIA com `sswFresco=false` (cache stale divergente)
 *      → INDEFINIDO_RETRY (fonte cache_stale). Nunca esconder por cache stale.
 *   2. oc topo === 54            → AGUARDANDO_CLIENTE (independe do autor).
 *   3. !ehRelac(topo)            → MANTER_FORA_RELACIONAMENTO (fora_escopo).
 *   4. relac ≠54 — IDENTIDADE (normalizarAutor):
 *        autor === ai.salex      → MANTER_FORA_RELACIONAMENTO (é a nossa ação).
 *        autor terceiro conhecido→ MOSTRAR_OPERADOR (oc nova de terceiro).
 *   5. relac ≠54 + autor DESCONHECIDO/vazio → NUNCA esconder por código:
 *        há codigoUltimoLancamentoCockpit no topo a investigar
 *                                → INDEFINIDO_RETRY (+alerta; tenta resolver autor).
 *        senão                   → MOSTRAR_OPERADOR (dúvida mostra).
 *
 * NUNCA: comparar `data` SSW × `iniciado_em`; decidir pelo Bastão (só gatilho);
 * esconder por dúvida, por cache stale, ou por código-igual-com-autor-desconhecido.
 */
export function decidirVisibilidadePorSsw(args: ArgsVisibilidade): ResultadoVisibilidade {
  const { ocorrenciasSsw, ehRelac, contaLancamentoCockpit, codigoUltimoLancamentoCockpit, sswFresco } = args;

  // Ocorrência mais recente COM código (pula linhas sem código). Índice 0 = topo.
  const indiceMaisRecente = ocorrenciasSsw.findIndex((o) => o.codigo != null);
  const maisRecente = indiceMaisRecente >= 0 ? ocorrenciasSsw[indiceMaisRecente]! : null;
  const ocMaisRecente = maisRecente?.codigo ?? null;
  const usuarioMaisRecente = maisRecente?.usuario ?? null;

  // Posição (ordem) da última oc lançada pelo Cockpit no histórico SSW — reforço
  // só p/ desempate de ambiguidade (NUNCA comparação de horário).
  let indiceUltimoLancamentoCockpit: number | null = null;
  if (codigoUltimoLancamentoCockpit != null) {
    const i = ocorrenciasSsw.findIndex((o) => o.codigo === codigoUltimoLancamentoCockpit);
    indiceUltimoLancamentoCockpit = i >= 0 ? i : null;
  }

  const diag = {
    ocMaisRecente,
    usuarioMaisRecente,
    indiceMaisRecente: indiceMaisRecente >= 0 ? indiceMaisRecente : null,
    indiceUltimoLancamentoCockpit,
  };
  const r = (
    decisao: DecisaoVisibilidade,
    fonte: FonteDecisao,
    motivo: string,
  ): ResultadoVisibilidade => ({ decisao, fonte, motivo, ...diag });

  // 1. Sem ocorrência codificada no SSW → não decide; re-tenta (safeguard/prazo cobre).
  if (ocMaisRecente == null) {
    return r(
      "INDEFINIDO_RETRY",
      "sem_ssw",
      "SSW sem ocorrência codificada (indisponível ou só linhas sem código) — não decide.",
    );
  }

  // 2. Dado NÃO-FRESCO (cache stale/divergente do Bastão) → NUNCA decidir aqui:
  //    não esconder nem mover por dado não-confiável. Re-tenta com SSW fresco.
  if (!sswFresco) {
    return r(
      "INDEFINIDO_RETRY",
      "cache_stale",
      "Fonte SSW não-fresca (cache stale/divergente do Bastão) — não decide; re-tenta com SSW fresco.",
    );
  }

  // 3. oc 54 → AGUARDANDO_CLIENTE (independe do autor; nunca 'manter TRANSFERIDO').
  if (ocMaisRecente === 54) {
    return r("AGUARDANDO_CLIENTE", "regra_54", "Ocorrência mais recente do SSW é 54 → AGUARDANDO_CLIENTE.");
  }

  // 4. Fora do escopo de Relacionamento → não reabre (ex.: 56 Operação, 33 Perdas).
  if (!ehRelac(ocMaisRecente)) {
    return r(
      "MANTER_FORA_RELACIONAMENTO",
      "fora_escopo",
      `Ocorrência mais recente (${ocMaisRecente}) não é de Relacionamento — fora de escopo.`,
    );
  }

  // 5. Relacionamento ≠54 — IDENTIDADE primária (autor normalizado lower+trim).
  const autor = normalizarAutor(usuarioMaisRecente);
  const conta = normalizarAutor(contaLancamentoCockpit);
  if (autor !== "" && autor === conta) {
    return r(
      "MANTER_FORA_RELACIONAMENTO",
      "identidade",
      "Ocorrência de Relacionamento mais recente foi lançada pelo próprio Cockpit (ai.salex) — não reabre.",
    );
  }
  if (autor !== "") {
    return r(
      "MOSTRAR_OPERADOR",
      "identidade",
      "Ocorrência de Relacionamento ≠54 mais recente foi lançada por TERCEIRO — mostra ao operador.",
    );
  }

  // 6. Autor DESCONHECIDO — código igual NÃO é fingerprint forte: NUNCA esconde.
  //    Se o topo tem o MESMO código do último lançamento do Cockpit, é ambíguo
  //    (pode ser nossa ação sem autor parseado) → INDEFINIDO_RETRY (resolve autor).
  //    Senão, em dúvida → MOSTRA.
  if (codigoUltimoLancamentoCockpit != null && codigoUltimoLancamentoCockpit === ocMaisRecente) {
    return r(
      "INDEFINIDO_RETRY",
      "ordem",
      "Autor desconhecido e código == último lançamento do Cockpit: ambíguo — re-tenta resolver autor; NÃO esconde.",
    );
  }
  return r(
    "MOSTRAR_OPERADOR",
    "duvida_mostra",
    "Autor desconhecido e sem evidência de ser ação do Cockpit → em dúvida, MOSTRA.",
  );
}

// ---------------------------------------------------------------------------
// Mapeamento decisão → estado final + evento, POR CALLER. Contrato p/ PR1b;
// corpo no PR4. A política de PRAZO do INDEFINIDO_RETRY vive no caller (grava
// `agent_state.reabertura_indefinida_desde`, escala p/ MOSTRAR após o limite).
// ---------------------------------------------------------------------------
export type CallerVisibilidade = "passA" | "sweepInv019";

export interface EstadoFinal {
  /** state alvo; null = inalterado neste ciclo. */
  state: string | null;
  /** lock alvo; null = inalterado. */
  lock: boolean | null;
  /** evento a gravar; null = nenhum. */
  evento: string | null;
}

/**
 * CONTRATO (corpo no PR4). Ver tabela PR1b do plano v3:
 *   MOSTRAR_OPERADOR            → AGUARDANDO_VALIDACAO_HUMANA + lock; evento CardReaberto.
 *   AGUARDANDO_CLIENTE (passA)  → AGUARDANDO_CLIENTE (lock=false).
 *   AGUARDANDO_CLIENTE (sweep)  → inalterado (já está em AC).
 *   MANTER_FORA_RELACIONAMENTO  → inalterado; evento ReaberturaSuprimida.
 *   INDEFINIDO_RETRY            → inalterado; evento ReaberturaIndefinida (1ª vez).
 */
export function estadoFinalParaDecisao(
  decisao: DecisaoVisibilidade,
  caller: CallerVisibilidade,
): EstadoFinal {
  switch (decisao) {
    case "MOSTRAR_OPERADOR":
      // Ambos os callers: card aparece pro operador (AGUARDANDO VOCÊ).
      return { state: "AGUARDANDO_VALIDACAO_HUMANA", lock: true, evento: "CardReaberto" };
    case "AGUARDANDO_CLIENTE":
      // Pass A (card fora de AC) → move pra AC. Sweep INV-019 (card já em AC) → inalterado.
      return caller === "passA"
        ? { state: "AGUARDANDO_CLIENTE", lock: false, evento: null }
        : { state: null, lock: null, evento: null };
    case "MANTER_FORA_RELACIONAMENTO":
      // Não reabre; permanece no estado atual.
      return { state: null, lock: null, evento: "ReaberturaSuprimida" };
    case "INDEFINIDO_RETRY":
      // Não decide neste ciclo; a política de PRAZO (caller) cuida do escalonamento.
      return { state: null, lock: null, evento: "ReaberturaIndefinida" };
  }
}
