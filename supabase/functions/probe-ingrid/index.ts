// TEMPORÁRIO — validação ao vivo (SSW ai.salex + plataforma romaneio). Remover.
import { obterSessao as sessaoSsw, readSswLancamentoEnv, resolverNumeroRemessaViaDanfe } from "../_shared/ssw-internal-client.ts";
import { obterSessao as sessaoRom, readRomaneioEnv, buscarFotosRomaneioPorTermo } from "../_shared/romaneio-interno-client.ts";

Deno.serve(async (req) => {
  const { nf, ctrc, remessa } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string; remessa?: string };
  const out: Record<string, unknown> = {};
  const env = Deno.env.toObject();
  try {
    const s = await sessaoSsw(readSswLancamentoEnv(env));
    out.ssw_login = "ok";
    if (nf) out.remessa_resolvida = await resolverNumeroRemessaViaDanfe(s, nf, ctrc);
  } catch (e) { out.ssw_erro = e instanceof Error ? e.message : String(e); }
  try {
    const sr = await sessaoRom(readRomaneioEnv(env));
    out.romaneio_login = "ok";
    const termo = remessa ?? (out.remessa_resolvida as { remessa?: string } | undefined)?.remessa;
    if (termo) {
      const b = await buscarFotosRomaneioPorTermo(sr, termo);
      out.romaneio_busca = { termo, encontrado: b.encontrado, docId: b.documento?.id ?? null, jpegs: b.jpegs.length, titulo: b.documento?.titulo ?? null };
    }
  } catch (e) { out.romaneio_erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
