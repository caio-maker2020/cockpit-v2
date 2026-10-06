/**
 * Guard — NF 1090092 UNIAO QUIMICA (Larissa, 2026-07-22).
 * Propriedade protegida: o clique deliberado na linha "🚫 SEM E-MAIL" SEMPRE
 * envia `confirmou_sem_email_deliberado=true` — é o ÚNICO escape que o guard
 * backend (prong gemeo_sem_email_vs_recomendacao_email) aceita. Sem isso, a
 * operadora fica presa: o erro manda usar a linha que ela já está usando.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extrasSemEmailComSegregacao, extrasSemEmailDeliberado } from "./extras-sem-email";

describe("extrasSemEmailDeliberado (linha 🚫 SEM E-MAIL)", () => {
  it("carrega o flag deliberado que o guard backend exige", () => {
    const extras = extrasSemEmailDeliberado();
    expect(extras.confirmou_sem_email_deliberado).toBe(true);
    expect(extras.skip_email).toBe(true);
    expect(extras.enviar_email).toBe(false);
  });

  it("o CALL-SITE da linha 🚫 SEM E-MAIL passa o helper pro onApprove (não basta o helper existir)", () => {
    // Guard do call-site: reverter ProposedActions pra `onApprove(todo)` sem
    // extras manteria o teste do helper verde e reintroduziria o loop de
    // bloqueio da NF 1090092. Este grep trava o ponto exato.
    const fonte = readFileSync(
      join(__dirname, "../components/cards/ProposedActions.tsx"),
      "utf-8",
    );
    expect(fonte).toContain("onApprove(todo, extrasSemEmailDeliberado())");
  });
});

// Carlos 2026-10-06 (Larissa/PRATI, ADR 0033 (a) emendado): a linha "SEM e-mail"
// de cliente que segrega abre painel e leva a marcação junto. O guard backend do
// gêmeo sem-email tem de continuar recebendo EXATAMENTE os mesmos 3 campos.
describe("extrasSemEmailComSegregacao (painel do gêmeo sem e-mail)", () => {
  it("leva os 3 campos deliberados de sempre + segregar_ctrc", () => {
    for (const segregar of [true, false]) {
      const extras = extrasSemEmailComSegregacao(segregar);
      expect(extras).toEqual({ ...extrasSemEmailDeliberado(), segregar_ctrc: segregar });
    }
  });

  it("segregar_ctrc é SEMPRE booleano — desmarcada vai false, nunca omitida", () => {
    const extras = extrasSemEmailComSegregacao(false);
    expect(Object.prototype.hasOwnProperty.call(extras, "segregar_ctrc")).toBe(true);
    expect(extras.segregar_ctrc).toBe(false);
    // valor estranho não vira true
    expect(extrasSemEmailComSegregacao("S" as unknown as boolean).segregar_ctrc).toBe(false);
  });

  it("o CALL-SITE do painel passa o helper pro onApprove", () => {
    const fonte = readFileSync(
      join(__dirname, "../components/cards/ProposedActions.tsx"),
      "utf-8",
    );
    expect(fonte).toContain("onApprove(t, extrasSemEmailComSegregacao(segregar))");
  });
});
