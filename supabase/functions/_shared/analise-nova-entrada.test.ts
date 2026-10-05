// Guard INV-168 (Caio 05/10): a análise do agente vale por ENTRADA do card.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EVENTOS_NOVA_ENTRADA, MAX_REANALISES_POR_ENTRADA_24H, motivoAnaliseVelha } from "./analise-nova-entrada.ts";
import { aberturasValidas, EVENTOS_ABERTURA_CICLO } from "./ciclos-tratativa.ts";

const base = {
  analiseEmIso: "2026-09-29T18:04:00Z",
  ultimaEntradaIso: null as string | null,
  ocDataAnalisada: null as string | null,
  historicoSsw: null,
  codigoOc: 49,
};

Deno.test("NF 807171 (real): reaberta com a MESMA oc 49 depois da análise → análise velha", () => {
  // análise 29/09 15:04 BRT; CardReaberto 02/10 09:01 BRT; teto de tentativas já em 3.
  assertEquals(
    motivoAnaliseVelha({ ...base, ultimaEntradaIso: "2026-10-02T12:01:33Z" }),
    "entrada_posterior",
  );
});

Deno.test("entrada ANTERIOR à análise (fluxo normal: entrou, analisou) → análise vale", () => {
  assertEquals(motivoAnaliseVelha({ ...base, ultimaEntradaIso: "2026-09-29T18:00:14Z" }), null);
});

Deno.test("sem evento de entrada e sem carimbo (análise legada) → não invalida", () => {
  assertEquals(motivoAnaliseVelha(base), null);
});

Deno.test("oc nova do MESMO código sem o card sair de AGUARDANDO VOCÊ → análise velha", () => {
  const historicoSsw = [
    { codigo: 49, data: "03/10/26 08:27" },
    { codigo: 54, data: "02/10/26 16:17" },
    { codigo: 49, data: "30/09/26 19:35" },
  ];
  assertEquals(
    motivoAnaliseVelha({ ...base, analiseEmIso: "2026-10-03T13:04:00Z", ocDataAnalisada: "30/09/26 19:35", historicoSsw }),
    "ocorrencia_mais_nova",
  );
  // mesma ocorrência já analisada → vale
  assertEquals(
    motivoAnaliseVelha({ ...base, analiseEmIso: "2026-10-03T13:04:00Z", ocDataAnalisada: "03/10/26 08:27", historicoSsw }),
    null,
  );
});

Deno.test("ocorrência mais nova de OUTRO código não conta (o check de oc diferente cuida disso)", () => {
  const historicoSsw = [{ codigo: 10, data: "04/10/26 09:00" }, { codigo: 49, data: "30/09/26 19:35" }];
  assertEquals(motivoAnaliseVelha({ ...base, ocDataAnalisada: "30/09/26 19:35", historicoSsw }), null);
});

Deno.test("entradas = aberturas de ciclo + volta dentro do ciclo; teto diário existe", () => {
  for (const e of EVENTOS_ABERTURA_CICLO) assertEquals(EVENTOS_NOVA_ENTRADA.includes(e), true);
  assertEquals(EVENTOS_NOVA_ENTRADA.includes("AguardandoClienteOcMudou"), true);
  assertEquals(MAX_REANALISES_POR_ENTRADA_24H, 3);
});

// ── Ciclos (mesmas regras travadas no front: ciclosTratativa.test.ts) ──
const T = (s: string) => new Date(s).getTime();
const ab = (iso: string, tipo = "CardReaberto", paraState: string | null = null) => ({ ts: T(iso), tipo, paraState });

Deno.test("ciclos: extravio 6/9/16 não abre; 49 autônoma abre e absorve a reabertura do sync", () => {
  assertEquals(EVENTOS_ABERTURA_CICLO.includes("ExtravioImportado"), false);
  assertEquals(EVENTOS_ABERTURA_CICLO.includes("AgenteExtravioLancou49"), true);
  const r = aberturasValidas(
    [ab("2026-10-01T12:00:00Z", "AgenteExtravioLancou49"), ab("2026-10-01T12:30:00Z")],
    [{ ts: T("2026-10-01T12:01:00Z"), codigo: 49 }],
  );
  assertEquals(r, [T("2026-10-01T12:00:00Z")]);
});

Deno.test("ciclos: reaberturas seguidas sem ação = 1 ciclo (oc 57); com ação = ciclo novo", () => {
  const seguidas = Array.from({ length: 90 }, (_, i) => ab(new Date(T("2026-09-05T12:00:00Z") + i * 8 * 3600_000).toISOString()));
  assertEquals(aberturasValidas(seguidas, []).length, 1);
  const r = aberturasValidas(
    [ab("2026-09-01T10:00:00Z", "BastaoCardImportado"), ab("2026-09-03T10:00:00Z"), ab("2026-09-05T10:00:00Z")],
    [{ ts: T("2026-09-02T10:00:00Z"), codigo: 21 }],
  );
  assertEquals(r.length, 2);
});
