/**
 * Guard — NF 1090092 UNIAO QUIMICA (Larissa, 2026-07-22).
 * Propriedade protegida: o clique deliberado na linha "🚫 SEM E-MAIL" SEMPRE
 * envia `confirmou_sem_email_deliberado=true` — é o ÚNICO escape que o guard
 * backend (prong gemeo_sem_email_vs_recomendacao_email) aceita. Sem isso, a
 * operadora fica presa: o erro manda usar a linha que ela já está usando.
 */
import { describe, expect, it } from "vitest";
import { extrasSemEmailDeliberado } from "./extras-sem-email";

describe("extrasSemEmailDeliberado (linha 🚫 SEM E-MAIL)", () => {
  it("carrega o flag deliberado que o guard backend exige", () => {
    const extras = extrasSemEmailDeliberado();
    expect(extras.confirmou_sem_email_deliberado).toBe(true);
    expect(extras.skip_email).toBe(true);
    expect(extras.enviar_email).toBe(false);
  });
});
