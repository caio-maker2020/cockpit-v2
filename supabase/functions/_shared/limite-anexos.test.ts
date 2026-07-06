// Guard de não-regressão do bug NF 719250 (Duilio, 2026-06-23): o limite de
// anexos por card NÃO pode contar `origem='inbound'` (assinaturas/logos inline
// auto-capturados do e-mail do cliente). Se voltar a contar, o upload das
// páginas JPEG do PDF convertido falha com 400 → front "Falha ao converter PDF".
//
// Rodar: deno test supabase/functions/_shared/limite-anexos.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  limiteAnexosAtingido,
  MAX_ANEXOS_UPLOAD_POR_CARD,
  origemContaProLimite,
  queryAnexosQueContamProLimite,
} from "./limite-anexos.ts";

// --- predicado puro ---------------------------------------------------------

Deno.test("origemContaProLimite: inbound NÃO conta; o resto conta", () => {
  assertEquals(origemContaProLimite("inbound"), false, "inbound não pode consumir budget");
  assertEquals(origemContaProLimite(" inbound "), false, "trim — inbound com espaço também não conta");
  assertEquals(origemContaProLimite("outbound"), true);
  assertEquals(origemContaProLimite(null), true, "default da coluna é outbound");
  assertEquals(origemContaProLimite(undefined), true);
  assertEquals(origemContaProLimite(""), true);
});

// --- teto (>=) --------------------------------------------------------------

Deno.test("limiteAnexosAtingido: dispara em >= MAX, nunca abaixo", () => {
  assertEquals(MAX_ANEXOS_UPLOAD_POR_CARD, 20);
  assertEquals(limiteAnexosAtingido(MAX_ANEXOS_UPLOAD_POR_CARD - 1), false);
  assertEquals(limiteAnexosAtingido(MAX_ANEXOS_UPLOAD_POR_CARD), true);
  assertEquals(limiteAnexosAtingido(MAX_ANEXOS_UPLOAD_POR_CARD + 1), true);
  assertEquals(limiteAnexosAtingido(null), false);
  assertEquals(limiteAnexosAtingido(undefined), false);
});

// --- a query exclui inbound (o coração do fix) ------------------------------
// Mock chainável que grava cada método chamado. Sem rede/DB.

function spyClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "not", "gte", "lte"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return builder;
    };
  }
  const client = {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return builder;
    },
  };
  return { client, calls };
}

Deno.test("queryAnexosQueContamProLimite: SEMPRE filtra .neq('origem','inbound')", () => {
  const { client, calls } = spyClient();
  // deno-lint-ignore no-explicit-any
  queryAnexosQueContamProLimite(client as any, "card-719250");

  // tabela certa
  const from = calls.find((c) => c.method === "from");
  assertEquals(from?.args, ["email_anexos"]);

  // filtro de card
  const eqCard = calls.find((c) => c.method === "eq");
  assertEquals(eqCard?.args, ["card_id", "card-719250"]);

  // GUARD CENTRAL: inbound é excluído. Se este assert quebrar, o bug NF 719250
  // voltou (inbound voltaria a consumir o budget de upload).
  const neq = calls.find((c) => c.method === "neq");
  assert(neq, "a query DEVE chamar .neq() pra excluir origem");
  assertEquals(neq!.args, ["origem", "inbound"]);

  // só pendentes (não enviados / não deletados)
  const isCols = calls.filter((c) => c.method === "is").map((c) => c.args[0]);
  assert(isCols.includes("enviado_em"), "deve filtrar enviado_em is null");
  assert(isCols.includes("deletado_em"), "deve filtrar deletado_em is null");
});
