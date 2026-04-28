// AUTO-MIRROR de /lib/bastao-rules.ts — não edite direto.
// Atualize /lib/bastao-rules.ts e copie aqui antes do deploy.
// (Lib/ vive em TypeScript estrito Bun-testável; _shared/ é pra Deno runtime.)

export const OCORRENCIAS_DE_RELACIONAMENTO: ReadonlySet<number> = new Set([
  3, 8, 10, 11, 17, 19, 20, 23, 26, 28, 35, 43, 49, 52, 54, 58,
]);

export const BASTAO_TEST_FILTER_OPERATOR: string | null = "LARISSA";

export const VERIFICATION_TIMEOUT_MINUTES = 90;
export const SYNC_INTERVAL_MINUTES = 5;

export function isOcorrenciaDeRelacionamento(codigo: number | null | undefined): boolean {
  if (codigo == null) return false;
  return OCORRENCIAS_DE_RELACIONAMENTO.has(codigo);
}
