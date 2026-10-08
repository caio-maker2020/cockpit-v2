// Guard — a baixa do motorista (ADR 0040, INV-174) não encosta no que já roda.
//   1. ISOLAMENTO: nenhuma função existente importa o código da baixa — a única
//      exceção é o health-check, que importa só o vigia PURO (INV-058);
//   2. o envelope do Relacionamento (`lancarSswPortal`) não é usado nem tocado pela
//      baixa, e o envelope da baixa não é usado pelo Relacionamento;
//   3. nada da baixa escreve em cards/card_events (a baixa não tem card).
// Rodar: deno test --no-check --allow-read supabase/functions/_shared/baixa-motorista-isolamento.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const BASE = new URL("../", import.meta.url); // supabase/functions/

function ehDaBaixa(caminho: string): boolean {
  return caminho.includes("baixa-motorista") || caminho.includes("lancar-ssw-baixa") ||
    caminho.startsWith("ponte-baixa-entrega/") || caminho.startsWith("processar-baixas-motorista/");
}

async function* arquivosTs(dir: URL, rel = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const r = `${rel}${e.name}`;
    if (e.isDirectory) yield* arquivosTs(new URL(`${e.name}/`, dir), `${r}/`);
    else if (e.isFile && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) yield r;
  }
}

Deno.test("ISOLAMENTO: só o health-check (vigia puro) importa código da baixa", async () => {
  const violacoes: string[] = [];
  let vistos = 0;
  for await (const rel of arquivosTs(BASE)) {
    if (ehDaBaixa(rel)) continue;
    vistos++;
    const src = await Deno.readTextFile(new URL(rel, BASE));
    const imports = [...src.matchAll(/from\s+["']([^"']*(?:baixa-motorista|lancar-ssw-baixa)[^"']*)["']/g)].map((m) => m[1]!);
    for (const imp of imports) {
      if (rel === "health-check/index.ts" && imp === "../_shared/baixa-motorista-vigia.ts") continue;
      violacoes.push(`${rel} → ${imp}`);
    }
  }
  assert(vistos > 100, `varredura suspeita: só ${vistos} arquivos`);
  assertEquals(violacoes, []);
});

Deno.test("o vigia importado pelo health-check é puro (sem I/O, sem import)", async () => {
  const src = await Deno.readTextFile(new URL("_shared/baixa-motorista-vigia.ts", BASE));
  assertEquals(/^import /m.test(src), false);
  assertEquals(/fetch\(|supabase|Deno\./.test(src), false);
});

Deno.test("os dois envelopes não se cruzam", async () => {
  const baixa = await Deno.readTextFile(new URL("_shared/lancar-ssw-baixa.ts", BASE));
  const rel = await Deno.readTextFile(new URL("_shared/lancar-ssw-portal.ts", BASE));
  assertEquals(/lancar-ssw-portal/.test(baixa.replace(/\/\/.*$/gm, "")), false);
  assertEquals(/lancar-ssw-baixa|baixa_motorista/.test(rel), false);
});

Deno.test("a baixa não escreve em cards nem card_events (não tem card)", async () => {
  for (const arq of ["_shared/baixa-motorista-repo.ts", "_shared/baixa-motorista-worker.ts", "_shared/lancar-ssw-baixa.ts", "_shared/baixa-motorista-contrato.ts"]) {
    const src = await Deno.readTextFile(new URL(arq, BASE));
    const escritas = [...src.matchAll(/from\("(cards|card_events)"\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/g)];
    assertEquals(escritas.length, 0, arq);
    assertEquals(/from\("card_events"\)/.test(src), false, arq);
  }
});
