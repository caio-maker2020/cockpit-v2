import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { casaNoTextoDoCliente, separarTextoDoCliente } from "./texto-citado-email.ts";

// Corpo REAL de produção — NF 145307 / SOLUÇÃO PET (03/07/2026). O cliente diz
// que anexou o romaneio; a citação abaixo é o NOSSO e-mail pedindo o romaneio.
const NF145307 = `
Bom dia, 

Segue abaixo descrição e valores do produto avariado:
- 1 UNIDADE - GOLDEN FORM CAES AD CAR 15KG - R$ 196,99

Anexei no e-mail o romaneio de coleta assinado.

Obrigada.

Att, 
Izabela Felix

-----Mensagem original-----
De: Karol e Isabelly <sac@salexpress.com.br> 
Enviada em: terça-feira, 23 de junho de 2026 17:27
Para: comercial@solucaopetmg.com.br
Assunto: Entrega parcial concluída — NF 145307

Para darmos sequência ao processo de ressarcimento dos volumes faltantes, gentileza encaminhar o romaneio de coleta assinado da NF e a descrição/valor dos itens faltantes.

Ficamos no aguardo. Obrigado!
`;

const RE_PEDIDO_ROMANEIO = /(aguardo|aguardamos|encaminhar\s+o\s+romaneio|gentileza\s+enviar)/i;

Deno.test("separa o texto do cliente da citação do nosso e-mail (NF 145307)", () => {
  const r = separarTextoDoCliente(NF145307);
  assertEquals(r.temCitacao, true);
  assertEquals(r.textoCliente.includes("Anexei no e-mail o romaneio"), true);
  assertEquals(r.textoCliente.includes("encaminhar o romaneio"), false);
  assertEquals(r.textoCliente.includes("Ficamos no aguardo"), false);
  assertEquals(r.textoCitado.includes("encaminhar o romaneio"), true);
});

Deno.test("o pedido citado por NÓS não conta como pedido do cliente (raiz do bug)", () => {
  // No corpo inteiro o anti-pedido dispara — foi isso que vetou 381 de 424 msgs.
  assertEquals(RE_PEDIDO_ROMANEIO.test(NF145307), true);
  // Só no texto do cliente, não dispara.
  assertEquals(casaNoTextoDoCliente(RE_PEDIDO_ROMANEIO, NF145307), false);
});

Deno.test("Gmail PT/EN: 'Em ... escreveu:' e 'On ... wrote:' são marcadores", () => {
  const pt = "Segue o romaneio anexo.\n\nEm qua., 3 de jul. de 2026 às 14:41, Sal <s@x> escreveu:\n gentileza enviar o romaneio";
  assertEquals(separarTextoDoCliente(pt).textoCliente.trim(), "Segue o romaneio anexo.");
  const en = "Attached.\n\nOn Thu, Jul 3, 2026 at 2:41 PM Sal <s@x> wrote:\n please send";
  assertEquals(separarTextoDoCliente(en).textoCliente.trim(), "Attached.");
});

Deno.test("Outlook web: linha de underscores separa a citação (fixture NF 884446)", () => {
  const corpo = "Bom dia,\n\nPor favor considerar a ressalva.\n\n________________________________\nDe: SAC FW <x@y>\nEnviado: sexta-feira\nPara: Felipe";
  const r = separarTextoDoCliente(corpo);
  assertEquals(r.temCitacao, true);
  assertEquals(r.textoCliente.includes("De: SAC FW"), false);
});

Deno.test("linhas citadas com '>' são removidas", () => {
  const corpo = "Segue anexo.\n> gentileza encaminhar o romaneio\n> ficamos no aguardo";
  const r = separarTextoDoCliente(corpo);
  assertEquals(r.temCitacao, true);
  assertEquals(r.textoCliente.trim(), "Segue anexo.");
});

Deno.test("CONSERVADOR: sem marcador, devolve o corpo inteiro", () => {
  const corpo = "Segue o romaneio assinado em anexo.";
  const r = separarTextoDoCliente(corpo);
  assertEquals(r.temCitacao, false);
  assertEquals(r.textoCliente, corpo);
});

Deno.test("CONSERVADOR: corte que deixaria o cliente mudo NÃO corta", () => {
  // Top-posting vazio: a citação começa na 1ª linha. Cortar cegaria o detector.
  const corpo = "-----Mensagem original-----\nDe: Sal <s@x>\nEnviada em: hoje\nsegue o romaneio";
  const r = separarTextoDoCliente(corpo);
  assertEquals(r.temCitacao, false);
  assertEquals(r.textoCliente, corpo);
});

Deno.test("CONSERVADOR: 'De:' solto no texto do cliente não corta", () => {
  const corpo = "Boa tarde. De: acordo com o combinado, segue o romaneio assinado em anexo.";
  const r = separarTextoDoCliente(corpo);
  assertEquals(r.temCitacao, false);
  assertEquals(r.textoCliente.includes("romaneio assinado"), true);
});

Deno.test("corpo vazio/nulo não quebra", () => {
  assertEquals(separarTextoDoCliente(null).textoCliente, "");
  assertEquals(separarTextoDoCliente("").temCitacao, false);
  assertEquals(separarTextoDoCliente("   ").textoCliente, "");
});
