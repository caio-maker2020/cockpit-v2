// GUARD INV-161 — as 3 portas que armam a oc 21 a partir de e-mail do cliente
// passam pela trava de CCE de endereço (ADR 0035, âncora NF 40484).
// Sobre o CÓDIGO-FONTE porque a regressão típica é uma chamada direta nova a
// agendarAcaoAutonomaSeElegivel, que nenhum teste de lógica pega. Este guard
// FALHA na master 92cd9fb (provado em 28/09).
// Rodar com: deno test --allow-read supabase/functions/_shared/cce-endereco-trava.fiacao.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAIZ = new URL("../../../", import.meta.url);

const PORTAS = [
  "supabase/functions/interpretador-resposta-cliente/index.ts",
  "supabase/functions/_shared/propostas-pos-resposta-cliente.ts",
  "supabase/functions/agente-sugere-ocs-padrao/index.ts",
];

async function ler(caminho: string): Promise<string> {
  return await Deno.readTextFile(new URL(caminho, RAIZ));
}

function semComentarios(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

for (const porta of PORTAS) {
  Deno.test(`INV-161: ${porta} importa a trava ESTATICAMENTE`, async () => {
    const src = semComentarios(await ler(porta));
    assert(
      /^import\s*\{[^}]*\bagendarComTravaCce\b[^}]*\}\s*from\s*"[./]+(_shared\/)?cce-endereco-trava\.ts";/m.test(src),
      `${porta}: import estático de agendarComTravaCce ausente. Import dinâmico não entra no ` +
        "pacote do deploy (incidente de 03/09).",
    );
  });

  Deno.test(`INV-161: ${porta} arma pela trava, nunca direto no agendador`, async () => {
    const src = semComentarios(await ler(porta));
    assert(/\bagendarComTravaCce\s*\(/.test(src), `${porta}: chamada a agendarComTravaCce ausente.`);
    assertEquals(
      /\bagendarAcaoAutonomaSeElegivel\s*\(/.test(src),
      false,
      `${porta}: chamada DIRETA a agendarAcaoAutonomaSeElegivel reabre a NF 40484 — a 21 com ` +
        "CCE de endereço volta a sair sozinha. Use agendarComTravaCce (ADR 0035).",
    );
  });
}

Deno.test("INV-161: a trava delega ao agendador de produção por padrão", async () => {
  const src = semComentarios(await ler("supabase/functions/_shared/cce-endereco-trava.ts"));
  assert(/deps:\s*DependenciasTrava\s*=\s*\{\s*agendar:\s*agendarAcaoAutonomaSeElegivel\s*\}/.test(src));
});
