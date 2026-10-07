// O adaptador de demonstração NUNCA entra na produção: só `carregarOpApi` o
// importa, por import dinâmico atrás de `import.meta.env.DEV` + a flag.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("modo demonstração isolado (ADR 0041, tela)", () => {
  it("só carregarOpApi (e testes) importam o adaptador demo", () => {
    const quem = arquivos(SRC)
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${join("operacao", "demo")}`))
      .filter((f) => /demo\/adaptadorDemo|demo\/dadosDemo/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(quem).toEqual([join("lib", "operacao", "carregarOpApi.ts")]);
  });

  it("o import é dinâmico e fica atrás de DEV + VITE_OPERACAO_DEMO", () => {
    const s = readFileSync(join(SRC, "lib/operacao/carregarOpApi.ts"), "utf8");
    expect(s).toMatch(/if \(import\.meta\.env\.DEV && import\.meta\.env\.VITE_OPERACAO_DEMO === "true"\) \{\s*promessa = import\("\.\/demo\/adaptadorDemo"\)/);
    expect(s).not.toMatch(/^import .*demo\//m);
  });

  it("o client do Supabase na demo aponta para endereço morto, nunca para o projeto real", () => {
    const s = readFileSync(join(SRC, "lib/supabase.ts"), "utf8");
    expect(s).toContain('const DEMO_OPERACAO = import.meta.env.DEV && import.meta.env.VITE_OPERACAO_DEMO === "true";');
    expect(s).toMatch(/DEMO_OPERACAO\s*\?\s*"http:\/\/127\.0\.0\.1:9"/);
  });
});
