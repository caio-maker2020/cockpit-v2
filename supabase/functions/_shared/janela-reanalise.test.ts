// INV-164 (Caio 01/10, NF 81446): a janela de elegibilidade dos agentes de
// análise (sugere-ocs-padrao, oc13-autonomo) é por updated_at (última
// MUDANÇA), nunca por created_at (nascimento). Guard anti-regressão por grep:
// se alguém reintroduzir `.gt("created_at", limite...)` na seleção, falha.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ARQUIVOS = [
  new URL("../agente-sugere-ocs-padrao/index.ts", import.meta.url),
  new URL("../agente-oc13-autonomo/index.ts", import.meta.url),
];

Deno.test("INV-164: agentes de análise filtram candidatos por updated_at, não por created_at", async () => {
  for (const url of ARQUIVOS) {
    const src = await Deno.readTextFile(url);
    assertEquals(
      /\.gt\("created_at",\s*limite/.test(src), false,
      `${url.pathname}: seleção por created_at reintroduzida — card reaberto >30d some da fila (NF 81446)`,
    );
    assert(
      /\.gt\("updated_at",\s*limiteAtualizacao\)/.test(src),
      `${url.pathname}: esperado filtro .gt("updated_at", limiteAtualizacao)`,
    );
    assertEquals(/limiteCriacao|CRIADO_HA_NO_MAX_HORAS/.test(src), false, `${url.pathname}: resíduo do corte antigo`);
  }
});
