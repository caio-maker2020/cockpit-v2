// =============================================================================
// Regional → bases. Cópia de src/lib/regionais.ts do Pendências
// (tatiana-kelly/pendency-tracker @a884368, linhas 17-69), com os comentários de
// quem confirmou cada base. Lá também é "fonte única do front" e o ETL guarda outra
// cópia (etl/notas-ciclo/src/unidades.js).
//
// A fila da Operação traz a SIGLA da unidade no SSW (VGA, BHZ…); a base sai do seed
// de siglas do Pendências (unidadesPendencias.ts) e a regional sai daqui.
// Mudou lá, muda aqui: são cópias congeladas no mesmo commit (ADR 0042, D-2).
// =============================================================================

export const REGIONAL_BASES: Readonly<Record<string, readonly string[]>> = {
  Daiene: [
    "OURO BRANCO",
    "PONTE NOVA",
    "BARBACENA",
    "SANTO ANTONIO DO AMPARO",
    "JUIZ DE FORA",
    "CATAGUASES",
    "MONTES CLAROS",
    "CURVELO",
    // Corinto atende Corinto, Pirapora e Diamantina, vizinhas de Curvelo (gestão, 18/09/2026).
    "CORINTO",
    // Janaúba, Salinas e Jaíba: confirmadas pela gestão em 21/09/2026.
    "JANAUBA",
    "SALINAS",
    "JAIBA",
    // Januária: a gestão não citou; a planilha marca AJN no grupo A.
    "JANUARIA",
    // Formiga: base nova, grupo A da planilha (21/09/2026).
    "FORMIGA",
  ],
  Geraldo: ["DIVINOPOLIS", "PASSOS", "ARAXA", "UBERABA", "FRUTAL", "UBERLANDIA", "ITURAMA", "ITUIUTABA", "PATOS DE MINAS"],
  Gil: [
    "JOÃO MONLEVADE",
    "IPATINGA",
    "GOV. VALADARES",
    "TEOFILO OTONI",
    "ITAOBIM",
    "ARACUAI",
    "MANHUACU",
    // Reduto (parceiro de Manhuaçu) e Rio Casca: gestão, 21/09/2026, as duas com o Gil interino.
    // A planilha de siglas ainda marca Rio Casca no grupo B (Geraldo).
    "REDUTO",
    "RIO CASCA",
  ],
  Bruno: ["BELO HORIZONTE", "VARGINHA", "POUSO ALEGRE", "ESPIRITO SANTO", "LINHARES"],
  // Ribeirão Preto confirmada pela gestão em 21/09/2026.
  Isabella: ["TRANSCHERRER", "ALEJO", "RIBEIRAO PRETO"],
};

export const REGIONAL_ORDEM = ["Daiene", "Geraldo", "Gil", "Bruno", "Isabella"] as const;

/** Bases sem regional conhecida (vazia em a884368). Base fora do mapa aparece como "Sem regional", nunca some. */
export const BASES_SEM_REGIONAL: readonly string[] = [];

export const SEM_REGIONAL = "Sem regional";

// Diferença consciente: lá a busca é exata; aqui ignora acento e caixa ("JOÃO MONLEVADE").
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
const POR_BASE = new Map<string, string>();
for (const [reg, bases] of Object.entries(REGIONAL_BASES)) for (const b of bases) POR_BASE.set(norm(b), reg);

export function regionalDaBase(base: string | null | undefined): string | null {
  return base ? POR_BASE.get(norm(base)) ?? null : null;
}
