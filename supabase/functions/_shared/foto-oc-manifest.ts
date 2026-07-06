// =============================================================================
// foto-oc-manifest — montagem PURA do manifesto de fotos de uma oc.
//
// Caio 2026-06-30 (NF 362406 LARISSA oc=49): 3ª recorrência do bug "card puxa só
// 1 foto de evidência". As 2 anteriores eram BACKEND (NF 357645 paginação,
// NF 355283 IA/anexo). Esta era FRONT: a galeria mostrava só a 1ª foto apesar do
// SSW ter 8 (paginadores `01..08`). Raiz: o front precisava ITERAR idx às cegas
// lendo o header `X-Fotos-Total`, ou embutia o viewer SSW cru (cujos paginadores
// `ajaxEnvia('FOT_N')` só funcionam dentro da sessão do portal — mortos no card).
//
// Fix de raiz: o backend entrega a LISTA COMPLETA das fotos num só objeto
// (manifesto). O front renderiza `manifesto.fotos.map(...)` — declarativo, não há
// "lembrar de iterar". Esta função é PURA (sem SSW/IO) pra ser testável e travar
// por teste a invariante: o manifesto SEMPRE lista TODAS as fotos, nunca trunca
// pra 1.
// =============================================================================

export interface FotoMetaItem {
  idx: number;
  oc_descricao: string;
  foto_data: string | null;
  foto_instrucao: string | null;
}

// Espelha (estruturalmente) `ListarFotosMetadataResult` do ssw-internal-client.
// Definido aqui (folha, sem imports de SSW) pra o módulo ser testável isolado e
// evitar import circular.
export type ListarFotosMetaLike =
  | { status: "ok"; fotos: FotoMetaItem[]; fotos_total: number; incompleto: boolean }
  | { status: "oc_nao_encontrada"; codigo_buscado: number; ocs_disponiveis: unknown }
  | { status: "oc_sem_foto"; codigo_buscado: number; descricao: string }
  | { status: "erro_ssw"; motivo: string };

export interface ManifestoFotosBody {
  ok: boolean;
  codigo_oc: number;
  /** Quantidade total de fotos. Por construção === fotos.length (nunca truncado). */
  fotos_total: number;
  /**
   * true => algum probe de paginação tracking_ent falhou e a contagem pode estar
   * subestimada. O front DEVE avisar a operadora ("pode haver fotos não
   * carregadas"), NUNCA mascarar 8→1 em silêncio.
   */
  incompleto: boolean;
  fotos: FotoMetaItem[];
  error?: string;
  descricao?: string;
  ocs_disponiveis?: unknown;
}

/**
 * Converte o resultado do `listarFotosDaOcMetadata` no corpo JSON + status HTTP
 * que o `foto-oc-card` (modo `list`) devolve pro front.
 *
 * INVARIANTE TRAVADA POR TESTE (NF 362406): no status "ok", `fotos_total` é
 * SEMPRE `resultado.fotos.length` e `body.fotos` carrega o array inteiro — o
 * manifesto nunca pode voltar 1 quando há N. Se algum dia alguém truncar pra
 * `[fotos[0]]`, o teste `foto-oc-manifest.test.ts` quebra.
 */
export function montarManifestoFotos(
  codigoOc: number,
  resultado: ListarFotosMetaLike,
): { body: ManifestoFotosBody; httpStatus: number } {
  if (resultado.status === "ok") {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        codigo_oc: codigoOc,
        fotos_total: resultado.fotos.length,
        incompleto: resultado.incompleto,
        fotos: resultado.fotos,
      },
    };
  }
  if (resultado.status === "oc_sem_foto") {
    return {
      httpStatus: 404,
      body: {
        ok: false,
        codigo_oc: codigoOc,
        fotos_total: 0,
        incompleto: false,
        fotos: [],
        error: "oc_sem_foto",
        descricao: resultado.descricao,
      },
    };
  }
  if (resultado.status === "oc_nao_encontrada") {
    return {
      httpStatus: 404,
      body: {
        ok: false,
        codigo_oc: codigoOc,
        fotos_total: 0,
        incompleto: false,
        fotos: [],
        error: "oc_nao_encontrada",
        ocs_disponiveis: resultado.ocs_disponiveis,
      },
    };
  }
  // erro_ssw
  return {
    httpStatus: 502,
    body: {
      ok: false,
      codigo_oc: codigoOc,
      fotos_total: 0,
      incompleto: false,
      fotos: [],
      error: "ssw_erro",
    },
  };
}
