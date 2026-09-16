// INV-155 (Carlos 2026-09-16) — a tela só oferece o pop-up onde o servidor
// aceita, e a prévia mostra exatamente o que o setor vai ler.
// Rodar: npx vitest run src/lib/confirmacaoOc33.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decidirPerguntaOc33,
  JANELA_SETOR,
  limparTexto,
  MAX_DESCRICAO,
  MAX_VALOR,
  PISO_TEXTO,
  previaDoSetor,
  ROTULO_CONFIRMACAO,
} from "./confirmacaoOc33";

const cardCom = (dossie: unknown, caso: string | null = "1") => ({
  agent_state: { extravio_parcial: { caso, dossie } },
});

/** Caso-âncora NF 431734: romaneio chegou, descrição e valor não. */
const NF431734 = {
  romaneio: { presente: true },
  descricao: { presente: false },
  valor: { presente: false },
};

const base = {
  natureza: "completude" as const,
  bloqueada: true,
  card: cardCom(NF431734),
  temAnexoNoCard: true,
};

describe("decidirPerguntaOc33 — quando a tela pergunta", () => {
  it("NF 431734: pergunta descrição E valor", () => {
    const d = decidirPerguntaOc33(base);
    expect(d.perguntar).toBe(true);
    expect(d.alvos).toEqual(["descricao", "valor"]);
    expect(d.rotulos).toEqual(["descrição dos itens", "valor dos itens"]);
  });

  it("só o que falta entra: valor já no dossiê não é perguntado", () => {
    const d = decidirPerguntaOc33({
      ...base,
      card: cardCom({ ...NF431734, valor: { presente: true } }),
    });
    expect(d.alvos).toEqual(["descricao"]);
  });
});

describe("decidirPerguntaOc33 — os limites que o Carlos fixou", () => {
  it("SEM ROMANEIO não pergunta: sem ele o SSW reverte a 33 (NF 660746)", () => {
    const d = decidirPerguntaOc33({
      ...base,
      card: cardCom({ ...NF431734, romaneio: { presente: false } }),
    });
    expect(d.perguntar).toBe(false);
    expect(d.motivo).toBe("falta_romaneio");
  });

  it("combo 33+44 (operacional) está fora desta rodada", () => {
    expect(decidirPerguntaOc33({ ...base, natureza: "operacional" }).motivo)
      .toBe("natureza_operacional");
  });

  it("card sem anexo do cliente não pergunta — fluxo segue como hoje", () => {
    expect(decidirPerguntaOc33({ ...base, temAnexoNoCard: false }).motivo)
      .toBe("card_sem_anexo");
  });

  it("carimbo ausente/false não pergunta — a parede já deixa passar", () => {
    expect(decidirPerguntaOc33({ ...base, bloqueada: false }).motivo).toBe("nao_bloqueada");
  });

  it("card sem dossiê (extravio total / card comum) não pergunta", () => {
    expect(decidirPerguntaOc33({ ...base, card: { agent_state: null } }).motivo)
      .toBe("sem_dossie");
    // e o pop-up NUNCA aparece em card que não é de extravio parcial
    expect(decidirPerguntaOc33({ ...base, card: { agent_state: {} } }).perguntar).toBe(false);
  });

  it("dossiê já completo não pergunta", () => {
    const d = decidirPerguntaOc33({
      ...base,
      card: cardCom({ romaneio: { presente: true }, descricao: { presente: true }, valor: { presente: true } }),
    });
    expect(d.motivo).toBe("nada_faltando");
  });
});

describe("previaDoSetor — o que o Ressarcimento vai ler", () => {
  it("caso-âncora cabe inteiro na janela de 70", () => {
    const p = previaDoSetor({
      alvos: ["descricao", "valor"],
      descricao: "DINITRATO ISOSSORBIDA 10MG - 12 UN",
      valor: "R$ 1.488,00",
    });
    expect(p.texto).toBe("Itens: DINITRATO ISOSSORBIDA 10MG - 12 UN | Valor: R$ 1.488,00");
    expect(p.cortado).toBe(false);
    expect(p.completo).toBe(true);
    expect(p.janela).toBe(p.texto);
  });

  it("acusa o corte quando passa de 70", () => {
    const p = previaDoSetor({
      alvos: ["descricao", "valor"],
      descricao: "A".repeat(MAX_DESCRICAO),
      valor: "R$ 1.488,00",
    });
    expect(p.cortado).toBe(true);
    expect(p.janela).toHaveLength(JANELA_SETOR);
  });

  it("o que já está no dossiê aparece junto do que ela digita", () => {
    const p = previaDoSetor({
      alvos: ["descricao"],
      descricao: "Paracetamol 30un",
      valor: "ignorado — não é alvo",
      jaNoDossie: { valor: "R$ 300,00" },
    });
    expect(p.texto).toBe("Itens: Paracetamol 30un | Valor: R$ 300,00");
  });

  it("SIM em branco não completa — ela digita (opção 'a' do Carlos)", () => {
    for (const t of ["", "   ", "x", "ab"]) {
      expect(previaDoSetor({ alvos: ["descricao"], descricao: t, valor: "" }).completo).toBe(false);
    }
    expect(previaDoSetor({ alvos: ["descricao"], descricao: "abc", valor: "" }).completo).toBe(true);
  });

  it("normaliza igual ao servidor: sem quebra de linha, sem espaço duplo", () => {
    // Espaço duplo racha thread no Outlook; \n não sobrevive ao latin-1 do SSW.
    expect(limparTexto("  DINITRATO   10MG\n\n12 UN  ", MAX_DESCRICAO)).toBe("DINITRATO 10MG 12 UN");
  });
});

// ---------------------------------------------------------------------------
// ANTI-DRIFT: este arquivo é ESPELHO. Se o backend mudar e ninguém mudar aqui,
// a tela passa a oferecer o que o servidor recusa (ou a esconder o que ele
// aceita) — e ninguém percebe, porque as duas metades continuam "funcionando".
// ---------------------------------------------------------------------------
describe("espelho do backend", () => {
  const raiz = resolve(__dirname, "../../../../supabase/functions/_shared");
  const conf = readFileSync(resolve(raiz, "oc33-confirmacao-operador.ts"), "utf-8");
  const dossie = readFileSync(resolve(raiz, "extravio-parcial-dossie.ts"), "utf-8");

  it("os tetos e o piso são os mesmos", () => {
    expect(conf).toContain(`export const PISO_TEXTO_CONFIRMACAO = ${PISO_TEXTO};`);
    expect(conf).toContain(`export const LIMITE_DESCRICAO_CONFIRMACAO = ${MAX_DESCRICAO};`);
    expect(conf).toContain(`export const LIMITE_VALOR_CONFIRMACAO = ${MAX_VALOR};`);
  });

  it("a janela do setor é a mesma", () => {
    expect(dossie).toContain(`export const JANELA_VISIVEL_SSW = ${JANELA_SETOR};`);
  });

  it("os rótulos são os mesmos", () => {
    expect(dossie).toContain(`descricao: "${ROTULO_CONFIRMACAO.descricao}"`);
    expect(dossie).toContain(`valor: "${ROTULO_CONFIRMACAO.valor}"`);
  });

  it("o backend monta o texto com os MESMOS rótulos curtos e o mesmo separador", () => {
    expect(dossie).toContain("partes.push(`Itens: ${d}`)");
    expect(dossie).toContain("partes.push(`Valor: ${v}`)");
    expect(dossie).toContain('return partes.join(" | ")');
  });

  it("o backend recusa na MESMA ordem, com os MESMOS motivos", () => {
    for (const m of [
      'return recusa("sem_dossie")',
      'return recusa("nao_bloqueada")',
      'return recusa("natureza_operacional")',
      'return recusa("falta_romaneio")',
      'return recusa("nada_faltando")',
      'return recusa("card_sem_anexo")',
    ]) {
      expect(conf).toContain(m);
    }
  });

  it("a evidência da operadora continua sendo fonte='operador' e monotônica", () => {
    expect(conf).toContain('fonte: "operador" as const');
    expect(dossie).toContain('export type FonteEvidencia = "corpo" | "anexo" | "ssw" | "operador";');
    // se isto sumir, um SIM errado passaria a ser reversível e a tela mentiria
    // no aviso "não volta atrás"
    expect(dossie).toContain("next.descricao = { ...next.descricao, ...recebidas.descricao, presente: true }");
  });
});
