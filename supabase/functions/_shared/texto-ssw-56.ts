// =============================================================================
// texto-ssw-56.ts — gera a INSTRUÇÃO operacional que acompanha toda oc=56.
//
// PROBLEMA (Caio 2026-07-08): quando lançamos oc=56 ("falta info operacional"),
// a Operação não sabia EXATAMENTE o que faltava → devolvia oc=49 perguntando, ou
// respondia parcial → retrabalho + cliente penalizado. A interpretação do agente
// sobre a lacuna ficava só no banner (observacao_orquestrador, voltado pro
// operador do Relacionamento) e NUNCA ia pro SSW.
//
// Este helper converte a LACUNA que o agente já identificou numa frase objetiva,
// imperativa e VOLTADA PRA OPERAÇÃO (o que falta + o que fazer). O texto vai pro
// campo Instrução do portal SSW (via extras.texto_descricao → montarDescricaoSsw)
// e sempre pode ser editado pela operadora antes de aprovar.
//
// Determinístico de propósito (sem nova chamada de LLM): a lacuna já foi decidida
// pelos agentes; aqui só materializamos o texto — barato, testável e sem custo.
// Latin-1 safe (o executor sanitiza; evitamos emoji).
//
// LIMITE = 70 CHARS (Caio 2026-07-09). O texto vai pro campo `f6` do portal SSW
// (Informações complementares), que é a coluna "Instrução/Complemento" que a
// Operação LÊ — maxlength=70 (confirmado via diag-form-ocorrencia 2026-06-08).
// Acima de 70 o SSW corta na coluna e o resto (que iria pro `observ`) NÃO é lido
// pela Operação. Então a instrução TEM que caber em 70 pra aparecer inteira.
// O front (Lovable) também limita o textarea a 70 → o que a operadora escreve =
// exatamente o que entra no SSW. Ver [[project_texto_ssw_sugerido_oc56]].
// =============================================================================

export type Lacuna56 =
  // ocs padrão 10/11/19/35 (agente-sugere-ocs-padrao)
  | "sem_foto"                 // oc=10 SEM anexo de foto
  | "foto_insuficiente"        // foto anexada não comprova (ilegível / registro interno)
  | "sem_motivo"               // oc=10/19/35 sem ressalva nem motivo escrito
  | "gps_divergente"           // oc=11 GPS acima do threshold
  | "sem_gps"                  // oc=11 sem coordenada GPS na baixa
  // oc=13 (agente-oc13-autonomo) — subtipos de sugerir_56
  | "oc13_foto_ok_sem_descricao"
  | "oc13_sem_foto_com_descricao"
  | "oc13_foto_ok_descricao_porca"
  | "oc13_foto_porca_descricao_acionavel"
  // fallback pra QUALQUER outra oc=56 sem lacuna mapeada
  | "generico";

export interface TextoSsw56Ctx {
  codigoOc?: number | null;
  gpsMetros?: number | null;
  gpsThreshold?: number | null;
  /** Enriquecimento opcional: motivo_sugestao do interpretador de foto. */
  motivoInterpretador?: string | null;
}

/**
 * Limite HARD do texto = maxlength do campo `f6` do portal SSW (a coluna que a
 * Operação lê). Acima disso o SSW corta e a Operação não vê o resto.
 */
export const TEXTO_SSW_56_MAXLEN = 70;

// Textos ≤70 chars, essencial primeiro (lacuna + ação), pra caber inteiro no
// campo lido. NÃO enriquecer com motivo do interpretador (estouraria os 70).
const TEXTOS: Record<Lacuna56, (c: TextoSsw56Ctx) => string> = {
  sem_foto: () =>
    "Falta foto que comprove a tentativa. Anexar evidencia no SSW.",
  foto_insuficiente: () =>
    "Foto nao comprova a tentativa. Anexar evidencia legivel no SSW.",
  sem_motivo: () =>
    "Falta motivo escrito. Descreva o que ocorreu na entrega.",
  gps_divergente: (c) =>
    `GPS ${c.gpsMetros ?? "?"}m fora do endereco. Confirmar local e anexar foto.`,
  sem_gps: () =>
    "Sem GPS na baixa. Confirmar endereco da tentativa e anexar foto.",
  oc13_foto_ok_sem_descricao: () =>
    "Reentrega com foto sem motivo. Informe o motivo da nao-entrega.",
  oc13_sem_foto_com_descricao: () =>
    "Reentrega sem foto. Anexar evidencia da tentativa.",
  oc13_foto_ok_descricao_porca: () =>
    "Reentrega: motivo do motorista ilegivel. Reescreva o motivo real.",
  oc13_foto_porca_descricao_acionavel: () =>
    "Reentrega: foto nao comprova. Anexar evidencia legivel.",
  generico: (c) =>
    `Evidencia incompleta${c.codigoOc ? ` (oc=${c.codigoOc})` : ""}. Revisar foto e/ou motivo.`,
};

/**
 * Gera o texto operacional da oc=56 pra uma lacuna. SEMPRE ≤70 chars (limite do
 * campo lido no SSW) — corta como rede de segurança se a interpolação estourar.
 * @param lacuna Lacuna identificada pelo agente (fallback: "generico").
 * @param ctx Contexto pra interpolar (código da oc, GPS).
 */
export function gerarTextoSsw56(lacuna: Lacuna56, ctx: TextoSsw56Ctx = {}): string {
  const montar = TEXTOS[lacuna] ?? TEXTOS.generico;
  return montar(ctx).slice(0, TEXTO_SSW_56_MAXLEN);
}

// ---------------------------------------------------------------------------
// Re-derivação da lacuna a partir de um resultado JÁ SALVO (backfill).
//
// O caminho going-forward passa a lacuna EXATA no momento da decisão (mais
// preciso). Cards antigos (analisados antes do deploy) só têm o resultado
// persistido — aqui reconstruímos a lacuna best-effort a partir dele pra
// preencher retroativamente o texto sem re-rodar SSW/interpretador (caro).
// ---------------------------------------------------------------------------

/** Fonte única do mapa subtipo(oc=13) → lacuna. Usado pelo agente e pelo backfill. */
export const OC13_SUBTIPO_LACUNA: Record<string, Lacuna56> = {
  foto_ok_sem_descricao: "oc13_foto_ok_sem_descricao",
  sem_foto_com_descricao: "oc13_sem_foto_com_descricao",
  foto_ok_descricao_porca: "oc13_foto_ok_descricao_porca",
  foto_porca_descricao_acionavel: "oc13_foto_porca_descricao_acionavel",
};

export interface ResultadoPadrao56 {
  gps_distancia_metros?: number | null;
  gps_dentro_threshold?: boolean | null;
  foto_classificacao?: string | null;
  motivo_extraido?: string | null;
  observacao_orquestrador?: string | null;
}

/**
 * Re-deriva a lacuna de um resultado de ocs-padrão (10/11/19/35) já salvo.
 * Usa os mesmos discriminadores do agente: GPS (oc=11), keywords da observação
 * (oc=10 foto ausente/insuficiente) e ausência de motivo (10/19/35 sem ressalva).
 */
export function derivarLacuna56Padrao(
  res: ResultadoPadrao56,
  oc: number,
  gpsThreshold = 4000,
): { lacuna: Lacuna56; ctx: TextoSsw56Ctx } {
  const obs = res.observacao_orquestrador ?? "";
  // oc=11: GPS é o discriminador
  if (oc === 11) {
    if (res.gps_distancia_metros != null && res.gps_dentro_threshold === false) {
      return {
        lacuna: "gps_divergente",
        ctx: { codigoOc: 11, gpsMetros: res.gps_distancia_metros, gpsThreshold },
      };
    }
    return { lacuna: "sem_gps", ctx: { codigoOc: 11 } };
  }
  // oc=10: branch de foto (observação carrega "SEM ANEXO" / "insuficiente" /
  // "não conseguiu classificar" — strings do próprio agente).
  if (oc === 10 && /SEM ANEXO/i.test(obs)) {
    return { lacuna: "sem_foto", ctx: { codigoOc: 10, motivoInterpretador: res.motivo_extraido ?? null } };
  }
  if (oc === 10 && /insuficiente|n[ãa]o conseguiu classificar/i.test(obs)) {
    return { lacuna: "foto_insuficiente", ctx: { codigoOc: 10, motivoInterpretador: res.motivo_extraido ?? null } };
  }
  // 10/19/35 sem motivo escrito (branch "sem motivo consolidado")
  if (!res.motivo_extraido) {
    return { lacuna: "sem_motivo", ctx: { codigoOc: oc } };
  }
  return { lacuna: "generico", ctx: { codigoOc: oc } };
}

/** Re-deriva a lacuna de um resultado de oc=13 (sugerir_56) já salvo. */
export function derivarLacuna56Oc13(
  res: { subtipo?: string | null; motivo_extraido?: string | null },
): { lacuna: Lacuna56; ctx: TextoSsw56Ctx } {
  return {
    lacuna: OC13_SUBTIPO_LACUNA[res.subtipo ?? ""] ?? "generico",
    ctx: { codigoOc: 13, motivoInterpretador: res.motivo_extraido ?? null },
  };
}
