// Guard INV-084 (extensão Carlos 2026-09-09): Subject sai íntegro e id fantasma
// nunca vira âncora. Âncoras: NF 7481 (BIOMEDICAL, espaço inicial), NF 783759 /
// 791899 (União Química, espaço triplo), NF 683869 (WURTH, In-Reply-To
// apontando pra Message-ID cockpit- que o Gmail reescreveu).
// Rodar: deno test supabase/functions/_shared/email-mime.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decodeSubjectRfc2047,
  ehMessageIdFantasma,
  encodeSubjectRfc2047,
  extrairMessageIdDosHeaders,
} from "./email-mime.ts";

Deno.test("ASCII imprimível vai sem codificar (máxima compatibilidade)", () => {
  const s = "RE: CPD 0842438 Entrega nao concluida - NF 684248";
  assertEquals(encodeSubjectRfc2047(s), s);
  assertEquals(encodeSubjectRfc2047(""), "");
});

Deno.test("não-ASCII vira encoded-words de até 75 chars, sem word única gigante", () => {
  const s = "RES: Rastreamento de carga de F E F DISTRIBUIDORA DE PRODUTO- Nota Fiscal 1   783759. — ação";
  const out = encodeSubjectRfc2047(s);
  const words = out.split("\r\n ");
  assert(words.length >= 2, `esperava múltiplas words, veio ${words.length}`);
  for (const w of words) {
    assert(w.length <= 75, `word com ${w.length} chars: ${w}`);
    assert(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w), `word malformada: ${w}`);
  }
});

Deno.test("round-trip preserva espaço triplo, espaço inicial, tab e em dash", () => {
  for (const s of [
    " Recusa Total — NF 7481 — EMBECTA  DISTRIB. DE MED. STA CRUZ LTDA", // NF 7481: espaço inicial + duplo
    "RES: Rastreamento de carga de F E F DISTRIBUIDORA DE PRODUTO- Nota Fiscal 1   783759.", // triplo
    "Re: Insucesso na entrega — NF 684813 CPD 1093872\tCLEITON EURIPEDES DE", // tab
    "Recusa Parcial — NF 55687 — INOVAÇÃO PET DISTRIBUIDORA EIRELI", // acentos
    "—", // 1 char multibyte
    "a".repeat(200) + "é" + " ".repeat(5) + "fim", // longo, quebra em várias words
  ]) {
    assertEquals(decodeSubjectRfc2047(encodeSubjectRfc2047(s)), s, `round-trip falhou: [${s}]`);
  }
});

Deno.test("quebra em fronteira de caractere UTF-8 (nunca parte um multibyte)", () => {
  const s = "—".repeat(60); // 60 × 3 bytes = 180 bytes → 4 words de 45 bytes
  const out = encodeSubjectRfc2047(s);
  const words = out.split("\r\n ");
  assertEquals(words.length, 4);
  assertEquals(decodeSubjectRfc2047(out), s);
});

Deno.test("ehMessageIdFantasma: só ids cockpit- (com ou sem brackets); reais passam", () => {
  assertEquals(ehMessageIdFantasma("cockpit-31b1e068-294e-4d0b-a411-97ad270740cb@salexpress.com.br"), true);
  assertEquals(ehMessageIdFantasma("<cockpit-31b1e068@salexpress.com.br>"), true);
  assertEquals(ehMessageIdFantasma("  <COCKPIT-abc@x>"), true);
  assertEquals(ehMessageIdFantasma("CA+uANJZuzEK4Uhs@mail.gmail.com"), false);
  assertEquals(ehMessageIdFantasma("<PAXPR10MB4930E143@PAXPR10MB4930.EURPRD10.PROD.OUTLOOK.COM>"), false);
  assertEquals(ehMessageIdFantasma(null), false);
  assertEquals(ehMessageIdFantasma(""), false);
});

Deno.test("extrairMessageIdDosHeaders: lê Message-ID real sem brackets, case-insensitive", () => {
  const headers = [
    { name: "Subject", value: "x" },
    { name: "Message-Id", value: "<CADqfTnE0Q-7H77oj@mail.gmail.com>" },
  ];
  assertEquals(extrairMessageIdDosHeaders(headers), "CADqfTnE0Q-7H77oj@mail.gmail.com");
  assertEquals(extrairMessageIdDosHeaders([{ name: "MESSAGE-ID", value: "abc@h" }]), "abc@h");
  assertEquals(extrairMessageIdDosHeaders([{ name: "Subject", value: "x" }]), null);
  assertEquals(extrairMessageIdDosHeaders([{ name: "Message-ID", value: "  " }]), null);
  assertEquals(extrairMessageIdDosHeaders(undefined), null);
});

// --- Carlos 2026-09-10 (achado da validação pré-merge) --------------------
// O round-trip acima usa o NOSSO decoder e por isso NÃO enxergava o buraco do
// atalho ASCII: quem lê o e-mail é um parser RFC 5322, e ele descarta o WSP
// colado ao ":" e o do fim da linha ANTES de decodificar. Um assunto ASCII com
// espaço na frente saía cru no header e chegava ao Exchange sem o espaço —
// assunto diferente = conversa nova, o MESMO bug que tirar o `.trim()`
// resolveu (NF 7481 BIOMEDICAL). Este helper imita esse parser.
function lerComoCliente(valorDoHeader: string): string {
  const corpo = valorDoHeader.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return decodeSubjectRfc2047(corpo);
}

Deno.test("assunto sobrevive ao PARSER do cliente, não só ao nosso decoder (NF 7481)", () => {
  for (
    const s of [
      " RES: Recusa Total — NF 7481 — EMBECTA", // espaço inicial + prefixo já presente
      " Recusa Total - NF 7481 - EMBECTA", // idem, tudo ASCII
      "\tRES: com tab na frente",
      "Assunto que termina com espaço ",
      "Assunto que termina com tab\t",
      "RES:  Rastreamento  NF 1   783759.", // espaços internos, ASCII puro
      "Re: Insucesso na entrega — NF 684813", // não-ASCII, caminho já coberto
      "Assunto comum sem nada de especial", // ASCII limpo segue indo cru
    ]
  ) {
    assertEquals(lerComoCliente(encodeSubjectRfc2047(s)), s, `parser do cliente alterou: [${s}]`);
  }
});

Deno.test("assunto com '=?' literal não é reinterpretado como encoded-word nossa", () => {
  const s = "Duvida sobre =?UTF-8?B?SGVsbG8=?= no anexo";
  const out = encodeSubjectRfc2047(s);
  assert(!out.startsWith("Duvida"), "deveria ter sido codificado, saiu cru");
  assertEquals(lerComoCliente(out), s);
});

Deno.test("ASCII limpo continua indo CRU (não regride a compatibilidade)", () => {
  const s = "RE: CPD 0842438 Entrega nao concluida - NF 684248";
  assertEquals(encodeSubjectRfc2047(s), s);
});
