// TEMPORÁRIO — ciclo COMPLETO com o resolver de PRODUÇÃO + plataforma romaneio.
import { obterSessao, readSswLancamentoEnv, resolverNumeroRemessaViaDanfe } from "../_shared/ssw-internal-client.ts";
import { obterSessao as sessaoRom, readRomaneioEnv, buscarFotosRomaneioPorTermo } from "../_shared/romaneio-interno-client.ts";
Deno.serve(async (req) => {
  const { nf, ctrc } = await req.json().catch(() => ({})) as { nf?: string; ctrc?: string };
  const out: Record<string, unknown> = {};
  const env = Deno.env.toObject();
  const s = await obterSessao(readSswLancamentoEnv(env));
  out.resolver = await resolverNumeroRemessaViaDanfe(s, nf!, ctrc);
  if ((out.resolver as {ok?:boolean}).ok) {
    const termo = (out.resolver as {remessa:string}).remessa;
    const sr = await sessaoRom(readRomaneioEnv(env));
    const b = await buscarFotosRomaneioPorTermo(sr, termo);
    out.plataforma = { termo, encontrado: b.encontrado, docId: b.documento?.id ?? null, jpegs: b.jpegs.length, titulo: b.documento?.titulo ?? null };
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
