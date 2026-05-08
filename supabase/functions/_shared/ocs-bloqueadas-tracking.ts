// =============================================================================
// ocs-bloqueadas-tracking — carrega a lista de ocs do SSW que NÃO aparecem no
// rastreio do cliente (api/trackingpag).
//
// Regra Caio 2026-05-07: quando Bastão tem oc dessa lista, sync-bastao/Pass E
// NÃO consulta tracking (sempre retornaria a oc anterior visível) e segue
// direto com a oc do Bastão.
//
// Lista é editável via SQL — operadora pode adicionar/remover sem deploy.
// Carregada 1× por run (cache na memória do Edge).
// =============================================================================

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type SupabaseClient = ReturnType<typeof createClient>;

export type OcsBloqueadasTracking = ReadonlySet<number>;

export async function loadOcsBloqueadasTracking(
  supabase: SupabaseClient,
): Promise<OcsBloqueadasTracking> {
  const { data, error } = await supabase
    .from("ocorrencias_bloqueadas_tracking")
    .select("codigo_ssw")
    .eq("ativo", true);

  if (error) {
    console.error(`[ocs-bloqueadas-tracking] load erro: ${error.message}`);
    return new Set<number>();
  }

  const codigos = (data ?? [])
    .map((r) => Number((r as Record<string, unknown>)["codigo_ssw"]))
    .filter((n) => Number.isFinite(n));
  return new Set<number>(codigos);
}
