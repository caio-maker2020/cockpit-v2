// Guard R2 anti-veto (playbook 02/09): cliente pede ressalva que JÁ existe →
// responder (54), nunca pedir de novo (56). Âncoras: NFs 898554/919288.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectarPedidoDeRessalva,
  ehRessalvaSemAssinatura,
  resolverRessalvaExistente,
} from "./resolver-pedido-ressalva.ts";

Deno.test("R2: detecta pedido de ressalva/comprovante (âncoras 898554/919288)", () => {
  assertEquals(detectarPedidoDeRessalva("Poderiam enviar a ressalva da entrega?"), true);
  assertEquals(detectarPedidoDeRessalva("Preciso do comprovante de entrega assinado"), true);
  assertEquals(detectarPedidoDeRessalva("Gostaria do canhoto por favor"), true);
  assertEquals(detectarPedidoDeRessalva("Qual foi a ressalva registrada?"), true);
  // envio ≠ pedido: quem anexa cai nas regras de combo/33
  assertEquals(detectarPedidoDeRessalva("Segue em anexo a ressalva solicitada"), false);
  // sem menção a ressalva/comprovante
  assertEquals(detectarPedidoDeRessalva("Podem devolver a mercadoria"), false);
  assertEquals(detectarPedidoDeRessalva("Autorizo a reentrega amanhã"), false);
});

Deno.test("R2: padrões de ressalva sem assinatura (decisão Caio 02/09)", () => {
  assertEquals(ehRessalvaSemAssinatura("CLIENTE SE RECUSOU A ASSINAR"), true);
  assertEquals(ehRessalvaSemAssinatura("CLIENTE NAO ASSINOU O CANHOTO"), true);
  assertEquals(ehRessalvaSemAssinatura("RECEBEDOR NÃO QUIS ASSINAR"), true);
  assertEquals(ehRessalvaSemAssinatura("MERCADORIA AVARIADA NA ENTREGA"), false);
});

Deno.test("R2: foto transcrita ganha (IA Vision já leu) → 54 respondendo", () => {
  const r = resolverRessalvaExistente({
    historico: [
      { codigo: 14, instrucao: "SAIDA PARA ENTREGA" },
      { codigo: 10, instrucao: "RECUSA TOTAL DA ENTREGA" },
    ],
    temRessalvaFoto: true,
    ressalvaTexto: "FALTOU 1 VOLUME ITEM XYZ",
  });
  assertEquals(r?.tipo, "foto_transcrita");
  assertEquals(r?.oc_origem, 10);
  assertEquals(r?.texto, "FALTOU 1 VOLUME ITEM XYZ");
});

Deno.test("R2: só texto sem-assinatura → resolve como manual (nunca veto)", () => {
  const r = resolverRessalvaExistente({
    historico: [
      { codigo: 13, instrucao: "CLIENTE NAO ASSINOU O COMPROVANTE" },
      { codigo: 54, instrucao: "AGUARDANDO RETORNO" },
    ],
    temRessalvaFoto: false,
    ressalvaTexto: null,
  });
  assertEquals(r?.tipo, "texto_sem_assinatura");
  assertEquals(r?.oc_origem, 13);
});

Deno.test("R2: nada encontrado → null (mantém a 56 de hoje)", () => {
  const r = resolverRessalvaExistente({
    historico: [{ codigo: 10, instrucao: "RECUSA TOTAL DA ENTREGA" }],
    temRessalvaFoto: false,
    ressalvaTexto: null,
  });
  assertEquals(r, null);
});
