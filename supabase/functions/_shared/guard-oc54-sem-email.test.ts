// Testes do Guard B (INV-027 backend, P0) — Caio 2026-07-06, NF 28002 (Larissa).
// "54 + e-mail" nunca vira "54 sem e-mail" sem confirmação deliberada.
// Rodar: deno test guard-oc54-sem-email.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { avaliarGuardOc54SemEmail, type AvaliarGuard54Input } from "./guard-oc54-sem-email.ts";

// Base: gêmeo "sem email" (lancar_ocorrencia) executando SEM e-mail.
function base(over: Partial<AvaliarGuard54Input> = {}): AvaliarGuard54Input {
  return {
    codigoSsw: 54,
    enviarEmail: false,
    skipOc: false,
    tool: "lancar_ocorrencia",
    skipEmail: false,
    confirmouSemEmailDeliberado: false,
    propostaDestacadaAcao: "lancar_oc_e_enviar_email:54",
    ...over,
  };
}

// ── Caso canônico NF 28002: recomendação "+email" + gêmeo sem_email => BLOQUEIA
Deno.test("NF 28002: recomendação +email + todo gêmeo sem email → bloqueia (prong gêmeo)", () => {
  const r = avaliarGuardOc54SemEmail(base());
  assertEquals(r.bloquear, true);
  assertEquals(r.prong, "gemeo_sem_email_vs_recomendacao_email");
});

// ── "54 + email" sem destinatário/template => o próprio todo tinha intenção de
//    e-mail mas não vai enviar => BLOQUEIA (nunca vira 54 sem email silenciosa).
Deno.test("tool +email sem e-mail válido → bloqueia (prong intenção)", () => {
  const r = avaliarGuardOc54SemEmail(base({ tool: "lancar_oc_e_enviar_email" }));
  assertEquals(r.bloquear, true);
  assertEquals(r.prong, "intencao_email_no_todo_sem_email_valido");
});

// ── Gêmeo sem-email + recomendação "+email": skipEmail sozinho NÃO é prova
//    suficiente de escolha deliberada, porque fronts antigos podem preencher isso
//    automaticamente por causa do próprio gêmeo. Só a flag dedicada libera.
Deno.test("gêmeo sem-email: skipEmail=true sem confirmação dedicada → ainda bloqueia", () => {
  const r = avaliarGuardOc54SemEmail(base({ skipEmail: true }));
  assertEquals(r.bloquear, true);
  assertEquals(r.prong, "gemeo_sem_email_vs_recomendacao_email");
});

// ── No TODO que era originalmente "+email", desmarcar o checkbox é uma escolha
//    explícita dentro do composer da própria ação completa.
Deno.test("todo +email: skipEmail=true (checkbox desmarcado) → NÃO bloqueia", () => {
  const r = avaliarGuardOc54SemEmail(base({ tool: "lancar_oc_e_enviar_email", skipEmail: true }));
  assertEquals(r.bloquear, false);
});

// ── Escolha deliberada via linha "🚫 SEM E-MAIL" (flag do front) => NÃO bloqueia.
Deno.test("confirmouSemEmailDeliberado=true → NÃO bloqueia", () => {
  const r = avaliarGuardOc54SemEmail(base({ confirmouSemEmailDeliberado: true }));
  assertEquals(r.bloquear, false);
});

// ── Recomendação legítima "sem email" (destacada NÃO é +email) => NÃO bloqueia.
Deno.test("recomendação sem-email legítima (destacada ≠ +email) → NÃO bloqueia", () => {
  const r = avaliarGuardOc54SemEmail(base({ propostaDestacadaAcao: "lancar_ocorrencia:54" }));
  assertEquals(r.bloquear, false);
});

Deno.test("sem recomendação destacada (null) + gêmeo → NÃO bloqueia (fail-open p/ prong 2)", () => {
  const r = avaliarGuardOc54SemEmail(base({ propostaDestacadaAcao: null }));
  assertEquals(r.bloquear, false);
});

// ── E-mail obrigatório vai sair (enviarEmail=true) => caminho normal, NÃO bloqueia.
Deno.test("enviarEmail=true → NÃO bloqueia (e-mail sairá junto da 54)", () => {
  const r = avaliarGuardOc54SemEmail(
    base({ enviarEmail: true, tool: "lancar_oc_e_enviar_email" }),
  );
  assertEquals(r.bloquear, false);
});

// ── skip_oc (só notificar, não lança oc) => fora de escopo, NÃO bloqueia.
Deno.test("skipOc=true → NÃO bloqueia (não lança oc no SSW)", () => {
  const r = avaliarGuardOc54SemEmail(base({ skipOc: true }));
  assertEquals(r.bloquear, false);
});

// ── oc ≠ 54 => guard não se aplica.
Deno.test("codigoSsw ≠ 54 → NÃO bloqueia", () => {
  const r = avaliarGuardOc54SemEmail(base({ codigoSsw: 21 }));
  assertEquals(r.bloquear, false);
});
