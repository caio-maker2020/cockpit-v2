// Guard INV-085: link de evidência vale 30 dias (fonte única).
// Âncora: NF 1107188 (UNIAO QUIMICA) — cliente clicou 9 dias após o envio e o
// token de 7 dias já tinha morrido; Vercel ainda mascarava como "Erro
// temporário" (Caio 2026-08-19).
// Rodar: deno test supabase/functions/_shared/token-evidencia.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  novaExpiracaoTokenEvidencia,
  VALIDADE_TOKEN_EVIDENCIA_DIAS,
} from "./token-evidencia.ts";

Deno.test("validade é 30 dias — decisão do Caio 2026-08-19 (era 7)", () => {
  assertEquals(VALIDADE_TOKEN_EVIDENCIA_DIAS, 30);
});

Deno.test("expiração = agora + 30 dias exatos (caso da NF 1107188: 9 dias tem que estar vivo)", () => {
  const base = Date.parse("2026-08-10T13:19:17.778Z"); // criado_em real do token âncora
  const expira = Date.parse(novaExpiracaoTokenEvidencia(base));
  assertEquals(expira - base, 30 * 24 * 60 * 60 * 1000);
  // clique do cliente 9 dias depois — dentro do prazo novo
  const clique = base + 9 * 24 * 60 * 60 * 1000;
  assertEquals(clique < expira, true);
});
