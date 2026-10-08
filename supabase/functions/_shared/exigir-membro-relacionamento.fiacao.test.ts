// GUARD INV-190 — as 5 edges P1 (docs/OPERACAO-SEPARACAO-RLS.md seção E)
// chamam exigirMembroRelacionamento ANTES de ler o corpo e de qualquer acesso
// a banco/serviço externo. Sobre o código-fonte: a regressão típica é alguém
// mover/remover a chamada, o que nenhum teste de lógica pega.
// Rodar: deno test --allow-read supabase/functions/_shared/exigir-membro-relacionamento.fiacao.test.ts
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAIZ = new URL("../../../", import.meta.url);
const EDGES = [
  "atualizar-card-via-portal-ssw",
  "puxar-historico-ssw-card",
  "enviar-retificacao-evidencia",
  "cobrar-cliente-aguardando",
  "send-whatsapp-message",
];

function semComentarios(src: string): string {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
}

for (const edge of EDGES) {
  Deno.test(`${edge}: porta do Relacionamento antes do corpo e do banco`, async () => {
    const src = semComentarios(
      await Deno.readTextFile(new URL(`supabase/functions/${edge}/index.ts`, RAIZ)),
    );
    assert(src.includes('from "../_shared/exigir-membro-relacionamento.ts"'), "import do helper");
    const handler = src.indexOf("serve(");
    const porta = src.indexOf("await exigirMembroRelacionamento(req", handler);
    assert(handler >= 0 && porta > handler, "chamada dentro do handler");
    assert(/if \(!porta\.ok\) return porta\.resposta;/.test(src), "resposta da porta devolvida");
    for (const depois of ["req.json(", ".from(\"", "sendGmailMessage(", "fetch("]) {
      const i = src.indexOf(depois, handler);
      if (i >= 0) assert(porta < i, `${depois} aparece antes da porta`);
    }
  });
}

Deno.test("send-whatsapp-message: operador_id do corpo conferido antes de resolver a instância", async () => {
  const src = semComentarios(
    await Deno.readTextFile(new URL("supabase/functions/send-whatsapp-message/index.ts", RAIZ)),
  );
  const alheio = src.indexOf("negarSeOperadorAlheio(porta.chamador, body.operador_id");
  const lookup = src.indexOf('.from("operadores")');
  assert(alheio > 0 && lookup > alheio, "negarSeOperadorAlheio antes do lookup do operador");
});
