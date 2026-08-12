// TEMPORÁRIO — valida a PLATAFORMA DE ROMANEIO com os números do print do Caio.
import { obterSessao, readRomaneioEnv, buscarFotosRomaneioPorTermo, buscarRomaneiosPorNf } from "../_shared/romaneio-interno-client.ts";
Deno.serve(async (req) => {
  const { termos } = await req.json().catch(() => ({})) as { termos?: string[] };
  const out: Record<string, unknown> = {};
  try {
    const s = await obterSessao(readRomaneioEnv(Deno.env.toObject()));
    out.login = "ok";
    const res: Record<string, unknown> = {};
    for (const t of (termos ?? ["1262024921", "1261962099"])) {
      const docs = await buscarRomaneiosPorNf(s, t); // busca crua por termo
      res[t] = { docs: docs.length, titulos: docs.slice(0, 3).map((d) => ({ id: d.id, titulo: d.titulo, fotos: d.fotos.length })) };
    }
    out.buscas = res;
  } catch (e) { out.erro = e instanceof Error ? e.message : String(e); }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
