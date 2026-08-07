// deno test --allow-env supabase/functions/_shared/aprendizado-chat.test.ts
//
// Guards da Fase 1 do chat do agente-chefe (plano aprovado Caio 08/08).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CHAT_MODEL,
  CHAT_TOOLS,
  historicoParaMensagens,
  montarSystemPrompt,
  type MsgChatRow,
} from "./aprendizado-chat.ts";

Deno.test("modelo é Opus (pedido explícito do Caio 08/08 — latência/assertividade)", () => {
  assert(CHAT_MODEL.includes("opus"), CHAT_MODEL);
});

Deno.test("ferramentas: só leitura + registrar_aprendizado — NUNCA SSW/deploy/cards", () => {
  const nomes = CHAT_TOOLS.map((t) => t.name);
  assertEquals(nomes.length, 4);
  assert(nomes.includes("registrar_aprendizado"));
  for (const n of nomes) {
    assert(!/ssw|lancar|deploy|aprovar|executar|card_update/i.test(n), `ferramenta suspeita: ${n}`);
  }
});

Deno.test("system prompt: linguagem simples, snapshot injetado, guardrails ditos", () => {
  const sp = montarSystemPrompt({
    nomeGestor: "Isadora",
    snapshotMetricas: "Agente de recusas: 64% seguidas (100 casos)",
    tipoSessao: "isadora_iniciou",
  });
  assert(sp.includes("Isadora"));
  assert(sp.includes("64% seguidas"), "snapshot precisa estar injetado (latência da 1ª resposta)");
  assert(sp.includes("não lança ocorrência"), "guardrail do que ele NÃO faz");
  assert(sp.includes("RESPOSTAS CURTAS"), "chat, não relatório");
  assert(!sp.includes("conduza"), "modo isadora_iniciou não leva a instrução de conduzir");
});

Deno.test("system prompt CHAT 2 (agente inicia): instrução de conduzir presente", () => {
  const sp = montarSystemPrompt({
    nomeGestor: "Isadora",
    snapshotMetricas: "x",
    tipoSessao: "agente_iniciou",
  });
  assert(sp.includes("conduza"));
});

// ---------------------------------------------------------------------------
// historicoParaMensagens — a API exige alternância user/assistant
// ---------------------------------------------------------------------------

const m = (papel: MsgChatRow["papel"], conteudo: string): MsgChatRow => ({ papel, conteudo });

Deno.test("histórico alterna papéis e funde consecutivas do mesmo lado", () => {
  const msgs = historicoParaMensagens([
    m("gestor", "oi"),
    m("gestor", "me mostra a oc 11"),
    m("agente", "claro, olhando..."),
    m("gestor", "e aí?"),
  ]);
  assertEquals(msgs.map((x) => x.role), ["user", "assistant", "user"]);
  assert(msgs[0].content.includes("oi") && msgs[0].content.includes("me mostra a oc 11"));
});

Deno.test("sessão aberta pelo agente (CHAT 2): prefixa user sintético pra API aceitar", () => {
  const msgs = historicoParaMensagens([
    m("agente", "Bom dia! Achei 12 descasamentos..."),
    m("gestor", "me conta"),
  ]);
  assertEquals(msgs[0].role, "user");
  assertEquals(msgs[1].role, "assistant");
  assertEquals(msgs[2].role, "user");
});

Deno.test("mensagens de sistema entram como [sistema] no lado user", () => {
  const msgs = historicoParaMensagens([
    m("gestor", "roda o teste"),
    m("sistema", "replay concluído: +10 pts"),
  ]);
  assertEquals(msgs.length, 1); // funde com a fala do gestor (mesmo lado)
  assert(msgs[0].content.includes("[sistema] replay concluído"));
});

Deno.test("histórico longo é cortado pelas mais recentes", () => {
  const rows: MsgChatRow[] = [];
  for (let i = 0; i < 80; i++) rows.push(m(i % 2 === 0 ? "gestor" : "agente", `msg ${i}`));
  const msgs = historicoParaMensagens(rows, 10);
  const texto = msgs.map((x) => x.content).join(" ");
  assert(!texto.includes("msg 0"), "antigas caem");
  assert(texto.includes("msg 79"), "recentes ficam");
});

Deno.test("mensagens vazias são ignoradas", () => {
  const msgs = historicoParaMensagens([m("gestor", "  "), m("gestor", "oi")]);
  assertEquals(msgs.length, 1);
  assertEquals(msgs[0].content, "oi");
});
