// deno test supabase/functions/_shared/arbitro-desfecho-regras.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classificarDesfecho } from "./arbitro-desfecho-regras.ts";

const ev = (t: string) => ({ event_type: t, created_at: "2026-07-20T12:00:00Z" });

Deno.test("seguida + card resolvido limpo → confirma a IA", () => {
  const r = classificarDesfecho(
    { veredito: "seguida", oc_sugerida: 44, oc_executada: null },
    { state: "RESOLVIDO", cod_ultima_ocorrencia: 44 },
    [],
  );
  assertEquals(r.desfecho, "resolvido_limpo");
  assertEquals(r.arbitro, "confirma_ia");
});

Deno.test("corrigida + card resolvido limpo → confirma o operador", () => {
  const r = classificarDesfecho(
    { veredito: "corrigida", oc_sugerida: 54, oc_executada: 21 },
    { state: "RESOLVIDO", cod_ultima_ocorrencia: 1 },
    [],
  );
  assertEquals(r.desfecho, "resolvido_limpo");
  assertEquals(r.arbitro, "confirma_operador");
});

Deno.test("reabertura pós-decisão → reaberto e inconclusivo (mesmo com estado fechado)", () => {
  const r = classificarDesfecho(
    { veredito: "corrigida", oc_sugerida: 54, oc_executada: 21 },
    { state: "RESOLVIDO", cod_ultima_ocorrencia: 21 },
    [ev("BastaoReabriuNFFonteRelacionamento")],
  );
  assertEquals(r.desfecho, "reaberto");
  assertEquals(r.arbitro, "inconclusivo");
});

Deno.test("bounce só conta quando a ação final era notificar (54)", () => {
  const comBounce54 = classificarDesfecho(
    { veredito: "seguida", oc_sugerida: 54, oc_executada: null },
    { state: "AGUARDANDO_CLIENTE", cod_ultima_ocorrencia: 54 },
    [ev("BounceDetectado")],
  );
  assertEquals(comBounce54.desfecho, "bounce");
  const bounceIrrelevante = classificarDesfecho(
    { veredito: "corrigida", oc_sugerida: 54, oc_executada: 21 },
    { state: "ACAO_EXECUTADA", cod_ultima_ocorrencia: 21 },
    [ev("BounceDetectado")],
  );
  assertEquals(bounceIrrelevante.desfecho, "em_aberto");
});

Deno.test("oc mudou depois da ação e card ativo → oc_nova (tratativa continuou)", () => {
  const r = classificarDesfecho(
    { veredito: "corrigida", oc_sugerida: 54, oc_executada: 21 },
    { state: "AGUARDANDO_VALIDACAO_HUMANA", cod_ultima_ocorrencia: 10 },
    [],
  );
  assertEquals(r.desfecho, "oc_nova");
  assertEquals(r.arbitro, "inconclusivo");
});

Deno.test("card sumido → indefinido; abstenção nunca vira confirmação", () => {
  assertEquals(
    classificarDesfecho(
      { veredito: "seguida", oc_sugerida: 54, oc_executada: null },
      null,
      [],
    ).desfecho,
    "indefinido",
  );
  const abst = classificarDesfecho(
    { veredito: "abstencao", oc_sugerida: null, oc_executada: null },
    { state: "RESOLVIDO", cod_ultima_ocorrencia: 1 },
    [],
  );
  assertEquals(abst.arbitro, "inconclusivo");
});
