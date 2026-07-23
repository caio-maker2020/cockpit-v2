// =============================================================================
// sugestao-texto-registro.ts — F5: persistência best-effort do texto que a IA
// sugeriu (redator-email-saida / sugerir-cobranca-ai).
//
// Regra da casa: telemetria NUNCA derruba o fluxo principal — o insert é
// try/catch e falha vira console.warn. Montagem do registro é pura/testável.
// Rodar testes: deno test supabase/functions/_shared/sugestao-texto-registro.test.ts
// =============================================================================

const MAX_TEXTO = 20_000;
const MAX_ASSUNTO = 500;

export interface SugestaoTextoInput {
  cardId: string | null | undefined;
  tipo: "email_saida" | "cobranca";
  texto: string | null | undefined;
  assunto?: string | null;
  codigoSsw?: number | string | null;
  papel?: string | null;
  canal?: string | null;
  modelo?: string | null;
}

export function montarRegistroSugestaoTexto(
  i: SugestaoTextoInput,
): Record<string, unknown> | null {
  const texto = (i.texto ?? "").trim();
  if (!i.cardId || !texto) return null;
  const codigo = Number(i.codigoSsw);
  return {
    card_id: i.cardId,
    tipo: i.tipo,
    codigo_ssw: Number.isFinite(codigo) && codigo > 0 ? codigo : null,
    papel: i.papel ?? null,
    canal: i.canal ?? null,
    assunto_sugerido: (i.assunto ?? "").trim().slice(0, MAX_ASSUNTO) || null,
    texto_sugerido: texto.slice(0, MAX_TEXTO),
    modelo: i.modelo ?? null,
  };
}

// Client mínimo (mesmo padrão do anthropic-usage-logger — facilita fake)
interface InsertableClient {
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }> };
}

/** Best-effort: nunca lança. */
export async function salvarSugestaoTexto(
  supabase: unknown,
  input: SugestaoTextoInput,
): Promise<void> {
  try {
    const row = montarRegistroSugestaoTexto(input);
    if (!row) return;
    const { error } = await (supabase as InsertableClient)
      .from("sugestoes_texto_ia")
      .insert(row);
    if (error) console.warn("[sugestao-texto] insert falhou (segue):", error);
  } catch (e) {
    console.warn("[sugestao-texto] falhou (segue):", e);
  }
}
