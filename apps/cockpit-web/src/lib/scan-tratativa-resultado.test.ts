/**
 * Guard — NF 108141 (Duílio, 2026-07-27). Propriedade protegida: o botão "Já tem
 * tratativa? Buscar" NUNCA mostra erro quando o scan teve sucesso. Os códigos
 * `adotado`/`ja_decidido`/`card_terminal` (e qualquer código não mapeado) são
 * benignos — antes caíam no `default: toast.error("Resultado inesperado")` e o
 * operador achava que "deu erro e não puxou".
 */
import { describe, expect, it } from "vitest";
import { mensagemDoResultadoScan } from "./scan-tratativa-resultado";

describe("mensagemDoResultadoScan", () => {
  it("sugerido: sucesso, singular vs plural, com refresh", () => {
    expect(mensagemDoResultadoScan("sugerido", 1)).toEqual({
      tipo: "success",
      texto: "Tratativa encontrada — confira no painel.",
      refresh: true,
    });
    expect(mensagemDoResultadoScan("sugerido", 3).texto).toContain("3 tratativas");
  });

  // O CORAÇÃO DO BUG DA NF 108141: scan com sucesso (thread já adotada) não pode
  // virar toast de erro.
  it.each(["adotado", "ja_decidido"])(
    "%s: informativo com refresh, NUNCA erro",
    (r) => {
      const m = mensagemDoResultadoScan(r);
      expect(m.tipo).toBe("info");
      expect(m.tipo).not.toBe("error");
      expect(m.refresh).toBe(true);
    },
  );

  it("card_terminal: informativo, não erro, sem refresh", () => {
    const m = mensagemDoResultadoScan("card_terminal");
    expect(m.tipo).toBe("info");
    expect(m.refresh).toBe(false);
  });

  it("nenhum_candidato e descartado: informativo, sem refresh", () => {
    expect(mensagemDoResultadoScan("nenhum_candidato").tipo).toBe("info");
    expect(mensagemDoResultadoScan("descartado").tipo).toBe("info");
    expect(mensagemDoResultadoScan("nenhum_candidato").refresh).toBe(false);
  });

  it.each(["sem_credencial_gmail", "sem_operador", "sem_nf", "card_inexistente", "erro"])(
    "%s: erro real (esses continuam erro)",
    (r) => {
      expect(mensagemDoResultadoScan(r).tipo).toBe("error");
    },
  );

  it("código desconhecido ou undefined: neutro (info), nunca erro", () => {
    expect(mensagemDoResultadoScan("resultado_novo_qualquer").tipo).toBe("info");
    expect(mensagemDoResultadoScan(undefined).tipo).toBe("info");
    expect(mensagemDoResultadoScan("resultado_novo_qualquer").tipo).not.toBe("error");
  });
});
