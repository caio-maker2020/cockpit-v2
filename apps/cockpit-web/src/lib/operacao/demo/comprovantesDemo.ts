// =============================================================================
// Comprovantes de entrega FICTÍCIOS para a demonstração (a fonte real ainda não existe
// no Cockpit; no Pendências vem das views de comprovantes de outro projeto Supabase).
// Determinístico: gerador congruente com semente fixa, datas relativas a `agoraMs`.
// Placas e clientes inventados. Nada aqui é dado da Sal.
//
// Isolamento (demoIsolamento.test.ts): só carregarOpApi pode importar demo/. A tela
// recebe estes itens por prop; a derivação da fila REAL (oc 12) mora em ../comprovantes.
// =============================================================================
import type { ComprovantePendente } from "../comprovantes";

export { comprovantesDaFila } from "../comprovantes";

const BASES: readonly { unidade: string; tipo: "filial" | "parceiro"; peso: number }[] = [
  { unidade: "VGA", tipo: "filial", peso: 14 },
  { unidade: "POA", tipo: "filial", peso: 11 },
  { unidade: "BHZ", tipo: "filial", peso: 10 },
  { unidade: "TKS", tipo: "filial", peso: 7 },
  { unidade: "PSO", tipo: "parceiro", peso: 6 },
  { unidade: "AJF", tipo: "filial", peso: 6 },
  { unidade: "AAX", tipo: "parceiro", peso: 6 },
];

const CLIENTES = [
  "ACME UTILIDADES LTDA",
  "BOA VISTA DISTRIBUIDORA",
  "CASA SERRANA COMERCIO",
  "DELTA FARMA DEMO",
  "ESTRELA DO SUL ALIMENTOS",
  "FICTICIA CALCADOS SA",
];

const OCS: readonly [number, string][] = [
  [1, "MERCADORIA ENTREGUE"],
  [1, "MERCADORIA ENTREGUE"],
  [1, "MERCADORIA ENTREGUE"],
  [12, "COMPROVANTE RETIDO PARA CONFERENCIA"],
];

/** LCG de Numerical Recipes, semente fixa: mesma lista em toda abertura. */
function gerador(semente: number) {
  let s = semente >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4_294_967_296;
  };
}

const LETRAS = "ABCDEFGHJKLMNPRSTUVWXYZ";

function placa(r: () => number): string {
  const l = () => LETRAS[Math.floor(r() * LETRAS.length)]!;
  const d = () => String(Math.floor(r() * 10));
  return `${l()}${l()}${l()}${d()}${l()}${d()}${d()}`;
}

/** ~60 comprovantes pendentes fictícios, com idades de 0 a ~45 dias e duas a três placas por base. */
export function gerarComprovantesDemo(agoraMs: number, quantidade = 60): ComprovantePendente[] {
  const r = gerador(20261008);
  const placasPorBase = new Map(BASES.map((b) => [b.unidade, [placa(r), placa(r), placa(r)]]));
  const pesoTotal = BASES.reduce((a, b) => a + b.peso, 0);
  const hoje = Math.floor((agoraMs - 3 * 3_600_000) / 86_400_000);
  const out: ComprovantePendente[] = [];
  for (let i = 0; i < quantidade; i++) {
    let x = r() * pesoTotal;
    const base = BASES.find((b) => (x -= b.peso) < 0) ?? BASES[0]!;
    const placas = placasPorBase.get(base.unidade)!;
    // Idade enviesada para o recente, com cauda longa (vencidas).
    const idade = Math.floor(Math.pow(r(), 1.8) * 46);
    const [oc, desc] = OCS[Math.floor(r() * OCS.length)]!;
    const frete = Math.round((80 + r() * 900) * 100) / 100;
    out.push({
      ctrc: `${base.unidade}${String(260000 + i * 37).padStart(6, "0")}-${1 + (i % 9)}`,
      nf: String(100000 + Math.floor(r() * 899999)),
      unidade: base.unidade,
      base_tipo: base.tipo,
      cliente_pagador: CLIENTES[Math.floor(r() * CLIENTES.length)]!,
      placa: r() < 0.06 ? null : placas[Math.floor(Math.pow(r(), 1.5) * placas.length)]!,
      data_entrega: new Date((hoje - idade) * 86_400_000).toISOString().slice(0, 10),
      ultima_oc: oc,
      descricao_oc: desc,
      valor_frete: frete,
      valor_mercadoria: Math.round(frete * (12 + r() * 40) * 100) / 100,
      origem: "demo",
    });
  }
  return out;
}
