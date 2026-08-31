// Guard INV-122 (respostas do Caio 31/08): casos da 49 ensinados pelo time.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clienteIsentoCustoExtra,
  contarSaidasParaEntrega,
  ehCasoCustoExtra,
  ehCasoTresTentativas,
  ehCobrancaDeRetornoAmpliada,
  extrairValorCusto,
} from "./oc49-casos-time.ts";

Deno.test("P1: detecção de 3 tentativas (fraseados reais)", () => {
  assertEquals(ehCasoTresTentativas("REALIZADAS 3 TENTATIVAS DE ENTREGA (24/08, 25/08 E 26/08) SEM SUCESSO"), true);
  assertEquals(ehCasoTresTentativas("TRES TENTATIVAS"), true);
  assertEquals(ehCasoTresTentativas("3 TENTATIVAS"), true);
  assertEquals(ehCasoTresTentativas("PRAZO DE PERDAS EXPIRADO"), false);
  assertEquals(ehCasoTresTentativas("1 TENTATIVA DE ENTREGA"), false);
});

Deno.test("P1: régua do Caio — conta oc 14 no histórico INTEIRO", () => {
  const h = (c: number) => ({ codigo: c });
  assertEquals(contarSaidasParaEntrega([h(14), h(13), h(14), h(11), h(14), h(49)]), 3);
  assertEquals(contarSaidasParaEntrega([h(14), h(13), h(49)]), 1);
  assertEquals(contarSaidasParaEntrega([]), 0);
});

Deno.test("P2: detecção de custo extra/dedicado", () => {
  assertEquals(ehCasoCustoExtra("CARRO DEDICADO 350,00"), true);
  assertEquals(ehCasoCustoExtra("NECESSARIO VEICULO EXCLUSIVO PARA ENTREGA"), true);
  assertEquals(ehCasoCustoExtra("CUSTO ADICIONAL ZONA RURAL"), true);
  assertEquals(ehCasoCustoExtra("AGUARDANDO RETORNO DO CLIENTE"), false);
});

Deno.test("P2: extração do valor", () => {
  assertEquals(extrairValorCusto("CARRO DEDICADO 350,00"), "350,00");
  assertEquals(extrairValorCusto("CUSTO EXTRA R$ 1.250,00 ZONA RURAL"), "1.250,00");
  assertEquals(extrairValorCusto("DEDICADO NECESSARIO"), null);
});

Deno.test("P2: OVD e FG isentos POR RAIZ (todas as filiais, com e sem máscara)", () => {
  assertEquals(clienteIsentoCustoExtra("76635689000192"), true);  // OVD matriz
  assertEquals(clienteIsentoCustoExtra("76635689002721"), true);  // OVD filial
  assertEquals(clienteIsentoCustoExtra("92664028002438"), true);  // FG filial
  assertEquals(clienteIsentoCustoExtra("92.664.028/0026-56"), true); // com máscara
  assertEquals(clienteIsentoCustoExtra("10854165000427"), false); // F E F não
  assertEquals(clienteIsentoCustoExtra(null), false);
});

Deno.test("P4: cobrança de retorno ampliada (fraseados MARIA/KAROLINE + originais)", () => {
  assertEquals(ehCobrancaDeRetornoAmpliada("COBRANDO RETORNO EM COMO PROCEDER COM O VOLUME RECUSADO"), true);
  assertEquals(ehCobrancaDeRetornoAmpliada("COMO PROCEDER COM O VOLUME"), true);
  assertEquals(ehCobrancaDeRetornoAmpliada("FALTA DE RETORNO"), true);
  assertEquals(ehCobrancaDeRetornoAmpliada("AGUARDANDO POSICAO DO CLIENTE"), true);
  assertEquals(ehCobrancaDeRetornoAmpliada("DESCRICAO E VALOR"), false);
});
