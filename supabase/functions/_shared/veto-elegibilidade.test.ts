// Guard das cercas do veto (etapa D, 25/08): cada trava do plano tem teste —
// se uma cerca sumir, ação autônoma executa onde não devia. Riscos 7/16/19/
// 22/24/35 cobertos aqui; multi-thread (16) e chave (52) vivem na RPC.
// Rodar: deno test supabase/functions/_shared/veto-elegibilidade.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  conteudoCompletoParaVeto,
  decidirElegibilidadeVeto,
  type CercasVeto,
} from "./veto-elegibilidade.ts";

const BASE: CercasVeto = {
  flagMasterOn: true,
  acaoAtivaNaEscada: true,
  acaoKey: "lancar_ocorrencia:21",
  proposta: { tool: "lancar_ocorrencia", args: { codigo_ssw: 21 } },
  temTodoPendente: true,
  operadorDonoId: "op-1",
  operadorNoPiloto: true,
  falhaRecenteNoCard: false,
  mesmaAcaoNoCicloAtual: false,
  vetadoPeloOperadorNoCiclo: false,
  clienteComExcecao: false,
  confianca: 0.9,
  pisoConfianca: 0.7,
};

Deno.test("caso feliz onda 1: 21 completa passa", () => {
  assertEquals(decidirElegibilidadeVeto(BASE), { elegivel: true });
});

Deno.test("flag master OFF barra tudo (risco 14 — deploy inerte)", () => {
  const r = decidirElegibilidadeVeto({ ...BASE, flagMasterOn: false });
  assertEquals(r, { elegivel: false, motivo: "flag_master_off" });
});

Deno.test("degrau da escada desligado barra a ação (ordem nominal por ação)", () => {
  const r = decidirElegibilidadeVeto({ ...BASE, acaoAtivaNaEscada: false });
  assertEquals(r, { elegivel: false, motivo: "acao_inativa_na_escada" });
});

Deno.test("card sem operador dono nunca executa sozinho (risco 21 — Gmail)", () => {
  const r = decidirElegibilidadeVeto({ ...BASE, operadorDonoId: null });
  assertEquals(r, { elegivel: false, motivo: "card_sem_operador_dono" });
});

Deno.test("extras proibidos barram (risco 24); cancelar_reentrega_24h é a exceção do Caio", () => {
  const comSkip = {
    ...BASE,
    proposta: { tool: "lancar_ocorrencia", args: { codigo_ssw: 21, extras: { skip_oc: true } } },
  };
  assertEquals(decidirElegibilidadeVeto(comSkip), { elegivel: false, motivo: "extra_proibido:skip_oc" });
  const comCancelamento = {
    ...BASE,
    proposta: {
      tool: "lancar_ocorrencia",
      args: { codigo_ssw: 21, extras: { cancelar_reentrega_24h: true, motivo_cancelamento: "cliente nao paga" } },
    },
  };
  assertEquals(decidirElegibilidadeVeto(comCancelamento), { elegivel: true });
});

Deno.test("e-mail sem template ou sem destinatário resolvido → manual (riscos 7/19, INV-041)", () => {
  const semNada = conteudoCompletoParaVeto("lancar_oc_e_enviar_email:54", {
    tool: "lancar_oc_e_enviar_email",
    args: { codigo_ssw: 54 },
  });
  assertEquals(semNada.completo, false);
  assertEquals(semNada.faltando, ["template_email", "destinatario_resolvido"]);
  const completo = conteudoCompletoParaVeto("lancar_oc_e_enviar_email:54", {
    tool: "lancar_oc_e_enviar_email",
    args: { codigo_ssw: 54, template_id: "RECUSA_SEM_RESSALVA", email_destino: "x@cliente.com" },
  });
  assertEquals(completo.completo, true);
});

Deno.test("PILOTO (Caio 26/08): operador fora do piloto fica 100% como hoje", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, operadorNoPiloto: false }),
    { elegivel: false, motivo: "operador_fora_do_piloto" },
  );
});

Deno.test("VETO do operador no ciclo barra re-agendamento — robô nunca insiste por cima do humano", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, vetadoPeloOperadorNoCiclo: true }),
    { elegivel: false, motivo: "vetado_pelo_operador_no_ciclo" },
  );
});

Deno.test("falha recente / mesma ação no ciclo / cliente exceção barram (riscos 22/35 + cerca)", () => {
  assertEquals(decidirElegibilidadeVeto({ ...BASE, falhaRecenteNoCard: true }).elegivel, false);
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, mesmaAcaoNoCicloAtual: true }),
    { elegivel: false, motivo: "mesma_acao_no_ciclo" },
  );
  assertEquals(decidirElegibilidadeVeto({ ...BASE, clienteComExcecao: true }).elegivel, false);
});

Deno.test("confiança abaixo do piso barra; sem confiança informada passa (piso é pra quem declara)", () => {
  assertEquals(decidirElegibilidadeVeto({ ...BASE, confianca: 0.5 }).elegivel, false);
  assertEquals(decidirElegibilidadeVeto({ ...BASE, confianca: null }).elegivel, true);
});

Deno.test("proposta sem tool/código nunca agenda (risco 7 — classe NF 158084)", () => {
  const r = conteudoCompletoParaVeto("lancar_ocorrencia:21", {} as never);
  assertEquals(r.completo, false);
});
