// deno test supabase/functions/_shared/oc11-raio-regras.test.ts
//
// Guards do processo "Padronização Ocorrência 11" (Isadora, 07/08/2026).
// Cada teste ancora uma exigência do desenho — se alguém mexer na regra e
// quebrar uma delas, a operação sente no SSW (reentrega cancelada errada ou
// aviso que não chega pro setor).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirOc11PeloRaio,
  montarTextoSswForaDoRaio,
  montarTextoSswSemGps,
  MOTIVO_CANCELAMENTO_FORA_DO_RAIO,
  MOTIVO_CANCELAMENTO_SEM_GPS,
  OC11_RAIO_PADRAO_METROS,
  TEXTO_SSW_BAIXA_DISTANTE,
} from "./oc11-raio-regras.ts";

/** Campo que o SETOR lê na coluna Instrução/Complemento do SSW (NF 59299). */
const SSW_F6_MAXLEN = 70;

Deno.test("o limite do processo é 4.000 m", () => {
  assertEquals(OC11_RAIO_PADRAO_METROS, 4000);
});

Deno.test("ATÉ 4.000 m → procedente: 54 com e-mail, SEM cancelar reentrega", () => {
  for (const metros of [0, 120, 1500, 3999, 4000]) {
    const d = decidirOc11PeloRaio(metros);
    assertEquals(d.proposta_destacada, 54, `${metros}m deveria ser 54`);
    assertEquals(d.cancelar_reentrega, false, `${metros}m não cancela reentrega`);
    assertEquals(d.template_email, "PROBLEMAS_COM_ENDERECO");
    assertEquals(d.gps_dentro_threshold, true);
  }
});

Deno.test("o limite é INCLUSIVO: 4.000 m ainda é procedente, 4.001 m já não é", () => {
  assertEquals(decidirOc11PeloRaio(4000).proposta_destacada, 54);
  assertEquals(decidirOc11PeloRaio(4001).proposta_destacada, 21);
});

Deno.test("ACIMA de 4.000 m → 21 + CANCELA reentrega + motivo registrado", () => {
  for (const metros of [4001, 8500, 23000]) {
    const d = decidirOc11PeloRaio(metros);
    assertEquals(d.proposta_destacada, 21, `${metros}m deveria ser 21`);
    assertEquals(d.cancelar_reentrega, true, `${metros}m TEM que cancelar a reentrega`);
    assertEquals(d.motivo_cancelamento, MOTIVO_CANCELAMENTO_FORA_DO_RAIO);
    assertEquals(d.gps_dentro_threshold, false);
    assertEquals(d.template_email, null, "não notifica cliente neste ramo");
  }
});

Deno.test("ÂNCORA (Caio 07/08): a frase exigida vai pro SSW, literal", () => {
  const d = decidirOc11PeloRaio(8500);
  assert(d.texto_ssw !== null, "tem que ter texto pro SSW");
  assert(
    d.texto_ssw!.includes(TEXTO_SSW_BAIXA_DISTANTE),
    `texto do SSW precisa conter a frase literal: ${d.texto_ssw}`,
  );
  assertEquals(TEXTO_SSW_BAIXA_DISTANTE, "BAIXA FEITA MUITO DISTANTE DO LOCAL DE ENTREGA, CORRIGIR");
});

Deno.test("a frase SOBREVIVE ao corte de 70 chars do campo que o setor LÊ (NF 59299)", () => {
  // Distâncias plausíveis, inclusive 5 dígitos (>10 km)
  for (const metros of [4001, 8500, 23000, 99999]) {
    const texto = montarTextoSswForaDoRaio(metros);
    const oQueOSetorVe = texto.slice(0, SSW_F6_MAXLEN);
    assert(
      oQueOSetorVe.includes(TEXTO_SSW_BAIXA_DISTANTE),
      `com ${metros}m o setor veria "${oQueOSetorVe}" — frase truncada`,
    );
  }
});

Deno.test("texto do SSW é ASCII puro (portal serve iso-8859-1 e engole UTF-8)", () => {
  const texto = montarTextoSswForaDoRaio(8500);
  assert(/^[\x20-\x7E]+$/.test(texto), `texto tem caractere não-ASCII: ${texto}`);
  assert(texto.length <= 500, "cabe no campo observ (500)");
});

Deno.test("a distância entra como contexto DEPOIS da frase (ordem importa)", () => {
  const texto = montarTextoSswForaDoRaio(8500);
  assert(texto.startsWith(TEXTO_SSW_BAIXA_DISTANTE), "a frase tem que vir primeiro");
  assert(texto.includes("8500M"), "a distância verificada precisa estar registrada");
});

Deno.test("SEM GPS (Caio 08/08) → mesma saída do fora-do-raio: 21 + cancela + avisa", () => {
  const d = decidirOc11PeloRaio(null);
  assertEquals(d.proposta_destacada, 21);
  assertEquals(d.cancelar_reentrega, true, "sem GPS TEM que cancelar a reentrega");
  assertEquals(d.motivo_cancelamento, MOTIVO_CANCELAMENTO_SEM_GPS);
  assert(
    d.texto_ssw !== null && d.texto_ssw.includes(TEXTO_SSW_BAIXA_DISTANTE),
    `a Operação precisa ler a frase-âncora também no sem-GPS: ${d.texto_ssw}`,
  );
  assertEquals(d.gps_dentro_threshold, null, "sem GPS não afirma dentro/fora");
  assertEquals(d.template_email, null, "não notifica cliente neste ramo");
});

Deno.test("SEM GPS: texto ASCII, frase sobrevive aos 70 chars e diz o contexto", () => {
  const texto = montarTextoSswSemGps();
  assert(/^[\x20-\x7E]+$/.test(texto), `não-ASCII: ${texto}`);
  assert(texto.slice(0, SSW_F6_MAXLEN).includes(TEXTO_SSW_BAIXA_DISTANTE));
  assert(texto.includes("SEM GPS"), "o setor precisa saber que o problema é ausência de GPS");
});

Deno.test("limite configurável não quebra a lógica (env override)", () => {
  assertEquals(decidirOc11PeloRaio(5000, 6000).proposta_destacada, 54);
  assertEquals(decidirOc11PeloRaio(7000, 6000).proposta_destacada, 21);
});

Deno.test("o raio verificado fica registrado na decisão (exigência do desenho)", () => {
  const dentro = decidirOc11PeloRaio(1500);
  const fora = decidirOc11PeloRaio(9000);
  assertEquals(dentro.gps_distancia_metros, 1500);
  assertEquals(fora.gps_distancia_metros, 9000);
  assert(dentro.motivo_extraido!.includes("1500"));
  assert(fora.motivo_extraido!.includes("9000"));
  assert(fora.observacao_orquestrador.includes("9000"));
});
