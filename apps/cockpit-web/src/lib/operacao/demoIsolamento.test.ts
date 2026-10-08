// O adaptador de demonstração NUNCA entra na produção: só `carregarOpApi` o
// importa, por import dinâmico atrás de condições que viram literais no build
// (`import.meta.env.DEV` + a flag, ou `MODE === "demo-v3"`). O build demo-v3 (a tela
// servida pelo site do roteirizador) busca a fila na API do v3 e NUNCA alcança o
// arquivo local demo/fila-real.json.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const RAIZ = resolve(SRC, "..");

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("modo demonstração isolado (ADR 0041, tela)", () => {
  it("só carregarOpApi (e testes) importam os módulos de demo/", () => {
    const quem = arquivos(SRC)
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${join("operacao", "demo")}`))
      .filter((f) => /["']\.{1,2}\/(?:[\w.]+\/)*demo\/|@\/lib\/operacao\/demo\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(quem).toEqual([join("lib", "operacao", "carregarOpApi.ts")]);
  });

  it("os imports são dinâmicos e ficam atrás de MODE demo-v3, ou de DEV + VITE_OPERACAO_DEMO", () => {
    const s = readFileSync(join(SRC, "lib/operacao/carregarOpApi.ts"), "utf8");
    expect(s).toMatch(/if \(import\.meta\.env\.MODE === "demo-v3"\) \{\s*promessa = import\("\.\/demo\/filaDoV3"\)/);
    expect(s).toMatch(
      /else if \(import\.meta\.env\.DEV && import\.meta\.env\.VITE_OPERACAO_DEMO === "true"\) \{\s*promessa = import\("\.\/demo\/fixtureLocal"\)/,
    );
    expect(s).not.toMatch(/^import .*demo\//m);
  });

  it("o client do Supabase na demo aponta para endereço morto, nunca para o projeto real", () => {
    const s = readFileSync(join(SRC, "lib/supabase.ts"), "utf8");
    expect(s).toMatch(
      /const DEMO_OPERACAO =\s*\(import\.meta\.env\.DEV && import\.meta\.env\.VITE_OPERACAO_DEMO === "true"\) \|\| import\.meta\.env\.MODE === "demo-v3";/,
    );
    expect(s).toMatch(/DEMO_OPERACAO\s*\?\s*"http:\/\/127\.0\.0\.1:9"/);
  });
});

describe("build demo-v3 (a tela no site do roteirizador)", () => {
  it("o arquivo local só é lido por fixtureLocal.ts, que o demo-v3 nunca importa", () => {
    const comGlob = arquivos(SRC)
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => /fila-real\.json/.test(readFileSync(f, "utf8")) && /import\.meta\.glob/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(comGlob).toEqual([join("lib", "operacao", "demo", "fixtureLocal.ts")]);
    for (const f of ["lib/operacao/demo/filaDoV3.ts", "lib/operacao/demo/adaptadorDemo.ts", "lib/operacao/demo/dadosDemo.ts"]) {
      expect(readFileSync(join(SRC, f), "utf8")).not.toMatch(/from ["']\.\/fixtureLocal|import\(["']\.\/fixtureLocal|import\.meta\.glob\(/);
    }
  });

  it("vite: base /operacao-cockpit/ só no modo demo-v3", () => {
    const s = readFileSync(join(RAIZ, "vite.config.ts"), "utf8");
    expect(s).toMatch(/base: mode === "demo-v3" \? "\/operacao-cockpit\/" : "\/"/);
  });

  it("o modo demo-v3 é o único jeito de ligar a demo num build", () => {
    const s = readFileSync(join(SRC, "lib/operacao/modoDemo.ts"), "utf8");
    expect(s).toMatch(/export const OPERACAO_DEMO_V3: boolean = import\.meta\.env\.MODE === "demo-v3";/);
    expect(s).toMatch(/\(import\.meta\.env\.DEV && import\.meta\.env\.VITE_OPERACAO_DEMO === "true"\) \|\| OPERACAO_DEMO_V3/);
  });

  it("o router usa o BASE_URL (basename /operacao-cockpit no demo-v3) e o portão da sessão do v3", () => {
    const s = readFileSync(join(SRC, "App.tsx"), "utf8");
    expect(s).toMatch(/<BrowserRouter basename=\{import\.meta\.env\.BASE_URL/);
    expect(s).toMatch(/OPERACAO_DEMO_V3 \? \(\s*<PortaoDemoV3>/);
  });
});
