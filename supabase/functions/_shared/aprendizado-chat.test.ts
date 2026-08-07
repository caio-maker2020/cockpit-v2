// deno test --allow-env supabase/functions/_shared/aprendizado-chat.test.ts
//
// Guards da Fase 1 do chat do agente-chefe (plano aprovado Caio 08/08).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  anexarImagensAoUltimoTurno,
  CHAT_MODEL,
  CHAT_TOOLS,
  historicoParaMensagens,
  mediaTypeDoPath,
  montarSystemPrompt,
  type MsgChatRow,
} from "./aprendizado-chat.ts";
import { montarAjusteDeResposta } from "./aprendizado-regras.ts";

Deno.test("PONTE CHAT→PROPOSTA: resposta registrada pelo chat VIRA ajuste (não é descartada)", () => {
  // montarAjusteDeResposta descarta opcao vazia (return null silencioso).
  // O registrar_aprendizado do chat grava opcao='Conversa com o agente-chefe'
  // exatamente pra passar por aqui — se alguém remover, este guard quebra.
  const candidato = montarAjusteDeResposta({
    chavePadrao: "agente-sugere-ocs-padrao:sug56",
    opcao: "Conversa com o agente-chefe",
    respostaResumo: "QUANDO a oc 11 tiver GPS acima de 4km, o certo é 21.",
    temImagens: false,
  });
  assert(candidato !== null, "resposta do chat NÃO pode ser descartada pelo modo ajustes");
  assertEquals(candidato!.agenteAlvo, "agente-sugere-ocs-padrao");
});

Deno.test("modelo é Opus (pedido explícito do Caio 08/08 — latência/assertividade)", () => {
  assert(CHAT_MODEL.includes("opus"), CHAT_MODEL);
});

Deno.test("ferramentas: só leitura + registrar_aprendizado — NUNCA SSW/deploy/cards", () => {
  const nomes = CHAT_TOOLS.map((t) => t.name);
  assertEquals(nomes.length, 5);
  assert(nomes.includes("rodar_replay"));
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

// ---------------------------------------------------------------------------
// Atualização Caio 08/08: foco na taxa + prints com visão
// ---------------------------------------------------------------------------

Deno.test("prompt tem a OBSESSÃO pela taxa: perguntas diretas + fechar regra", () => {
  const sp = montarSystemPrompt({
    nomeGestor: "Isadora",
    snapshotMetricas: "x",
    tipoSessao: "isadora_iniciou",
  });
  assert(sp.includes("PERGUNTA DIRETA"), "instrução de pergunta direta");
  assert(sp.includes("meta 95%"), "a meta guia a conversa");
  assert(sp.includes("Não seja passivo"), "ele puxa o pior bolsão mesmo num 'oi'");
  assert(sp.includes("EXCETO"), "persegue exceção antes de fechar regra");
  assert(sp.includes("PRINTS"), "instrução de analisar imagem recebida");
});

Deno.test("visão: prints do turno atual viram blocos na ÚLTIMA fala do usuário", () => {
  const base = historicoParaMensagens([
    m("gestor", "olha esse caso"),
    m("agente", "mostra"),
    m("gestor", "segue o print da tela do SSW"),
  ]);
  const out = anexarImagensAoUltimoTurno(base, [
    { media_type: "image/png", base64: "AAAA" },
  ]);
  const ultima = out[out.length - 1];
  assertEquals(ultima.role, "user");
  const blocos = ultima.content as Array<{ type: string; text?: string }>;
  assertEquals(blocos[0].type, "image");
  assertEquals(blocos[1].type, "text");
  assert(blocos[1].text!.includes("segue o print"));
  // e o histórico anterior fica intacto (só o turno atual carrega bytes)
  assertEquals(typeof out[0].content, "string");
});

Deno.test("visão: sem imagem = histórico intocado; última fala do agente = não anexa", () => {
  const base = historicoParaMensagens([m("gestor", "oi")]);
  assertEquals(anexarImagensAoUltimoTurno(base, []), base);
  const soAgente = [{ role: "assistant" as const, content: "oi" }];
  assertEquals(anexarImagensAoUltimoTurno(soAgente, [{ media_type: "image/png", base64: "A" }]), soAgente);
});

Deno.test("mediaTypeDoPath: extensões suportadas e rejeição do resto", () => {
  assertEquals(mediaTypeDoPath("chat/123-print.PNG"), "image/png");
  assertEquals(mediaTypeDoPath("chat/a.jpeg"), "image/jpeg");
  assertEquals(mediaTypeDoPath("chat/a.webp"), "image/webp");
  assertEquals(mediaTypeDoPath("chat/nota.pdf"), null, "pdf não é bloco de visão");
});

Deno.test("prompt de FORMATAÇÃO: markdown separadinho (tabelas, listas, parágrafos)", () => {
  const sp = montarSystemPrompt({ nomeGestor: "Isadora", snapshotMetricas: "x", tipoSessao: "isadora_iniciou" });
  assert(sp.includes("FORMATAÇÃO"), "seção de formatação");
  assert(sp.includes("TABELA markdown"), "tabela quando comparar números");
  assert(sp.includes("linha em branco"), "parágrafos separados");
  assert(sp.includes("NUNCA um bloco só gigante"), "anti-parede-de-texto");
});

Deno.test("mudanças aplicadas: prompt proíbe requestionar o resolvido", () => {
  const sp = montarSystemPrompt({
    nomeGestor: "Isadora",
    snapshotMetricas: "x",
    tipoSessao: "isadora_iniciou",
    mudancasAplicadas: "- desde 2026-08-07 [agente-sugere-ocs-padrao:sug56]: Padronização oc 11 pelo raio",
  });
  assert(sp.includes("NUNCA requestione"), "regra inviolável presente");
  assert(sp.includes("Padronização oc 11"), "a mudança aplicada aparece no contexto");
  assert(sp.includes("ADESÃO"), "casos pós-mudança viram assunto de adesão");
});

Deno.test("fluxo de fechamento: replay ANTES de registrar, e-mail com números", () => {
  const sp = montarSystemPrompt({ nomeGestor: "I", snapshotMetricas: "x", tipoSessao: "isadora_iniciou" });
  assert(sp.includes("rodar_replay"), "testa antes de registrar");
  assert(sp.includes("taxa_hoje_pct"), "registra com números");
  assert(sp.includes("recebe e-mail na hora"), "o Caio é avisado");
});

// ---------------------------------------------------------------------------
// Incidente 08/08 (teste prático da Isadora): replay achou 0 casos porque o
// agente passou a oc do CARD como oc sugerida. Guards da desambiguação.
// ---------------------------------------------------------------------------

Deno.test("rodar_replay tem os DOIS campos de ocorrência, sem ambiguidade", () => {
  const t = CHAT_TOOLS.find((x) => x.name === "rodar_replay");
  assert(t, "ferramenta existe");
  const props = (t!.input_schema as { properties: Record<string, { description?: string }> }).properties;
  assert("oc_do_card" in props, "precisa do filtro pela oc do card");
  assert("oc_sugerida_pela_ia" in props, "precisa do filtro pela oc sugerida");
  assert(!("oc_contexto" in props), "o nome ambíguo saiu do schema");
  assert(
    /NÃO é a ocorrência do card/i.test(props["oc_sugerida_pela_ia"].description ?? ""),
    "a descrição precisa separar explicitamente as duas",
  );
});

Deno.test("prompt manda LER a dica do replay e proíbe 'falta capacidade' sem repetir", () => {
  const sp = montarSystemPrompt({ nomeGestor: "I", snapshotMetricas: "x", tipoSessao: "isadora_iniciou" });
  assert(sp.includes("oc_do_card"), "o prompt explica qual campo é qual");
  assert(sp.includes("LEIA a dica"), "manda ler o diagnóstico");
  assert(sp.includes("falta capacidade"), "proíbe a conclusão errada do incidente");
});
