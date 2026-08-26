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
  idadeSugestaoHoras: null,
  clienteComExcecao: false,
  confianca: 0.9,
  pisoConfianca: 0.7,
  ocDoCard: 49,
  evidenciaStatus: null,
};

// ── Cerca de evidência (Caio 26/08, NF 382389) ──────────────────────────────
const EMAIL_54: Partial<CercasVeto> = {
  acaoKey: "lancar_oc_e_enviar_email:54",
  proposta: {
    tool: "lancar_oc_e_enviar_email",
    args: { codigo_ssw: 54, template_id: "PROBLEMAS_COM_ENDERECO", email_destino: "x@y.com" },
  },
};

Deno.test("evidência: oc 10 + email sem status → manual (robô exige certeza)", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 10, evidenciaStatus: null } as CercasVeto),
    { elegivel: false, motivo: "evidencia_nao_confirmada" },
  );
});

Deno.test("evidência: oc 35 + email com ok_sem_btn_foto → manual", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 35, evidenciaStatus: "ok_sem_btn_foto" } as CercasVeto),
    { elegivel: false, motivo: "evidencia_nao_confirmada" },
  );
});

Deno.test("evidência: oc 10 + email ambíguo → manual (skip é decisão do operador)", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 10, evidenciaStatus: "ambiguo_foto_em_outra_oc" } as CercasVeto),
    { elegivel: false, motivo: "evidencia_nao_confirmada" },
  );
});

Deno.test("evidência: oc 10 + email com foto correlacionada → passa", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 10, evidenciaStatus: "ok_com_foto_correlacionada" } as CercasVeto),
    { elegivel: true },
  );
});

Deno.test("evidência: oc 11 + email SEM foto → PASSA (Caio 26/08: na 11 manda o GPS/raio, não foto — NF 382389)", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 11, evidenciaStatus: "ok_sem_btn_foto" } as CercasVeto),
    { elegivel: true },
  );
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 11, evidenciaStatus: null } as CercasVeto),
    { elegivel: true },
  );
});

Deno.test("evidência: oc 49 + email sem status → passa (cerca só nas 10/11/35)", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ...EMAIL_54, ocDoCard: 49, evidenciaStatus: null } as CercasVeto),
    { elegivel: true },
  );
});

Deno.test("evidência: oc 35 SEM e-mail → passa (só ação com e-mail exige foto)", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, ocDoCard: 35, evidenciaStatus: "ok_sem_btn_foto" } as CercasVeto),
    { elegivel: true },
  );
});

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

Deno.test("56 autônoma exige texto no CANAL DO EXECUTOR (extras) — boilerplate de args.descricao NÃO conta (NFs 133103/797315)", () => {
  const semTexto = conteudoCompletoParaVeto("lancar_ocorrencia:56", {
    tool: "lancar_ocorrencia", args: { codigo_ssw: 56 },
  });
  assertEquals(semTexto.completo, false);
  assertEquals(semTexto.faltando, ["texto_56"]);
  // o caso REAL do 1º dia: descricao boilerplate do menu, extras vazio → barra
  const soBoilerplate = conteudoCompletoParaVeto("lancar_ocorrencia:56", {
    tool: "lancar_ocorrencia",
    args: { codigo_ssw: 56, descricao: "Cliente questionou evidência/imagem — encaminha pra Operação corrigir" },
  });
  assertEquals(soBoilerplate.completo, false);
  const comTexto = conteudoCompletoParaVeto("lancar_ocorrencia:56", {
    tool: "lancar_ocorrencia",
    args: { codigo_ssw: 56, extras: { texto_descricao: "CLIENTE QUESTIONA A FOTO — VERIFICAR" } },
  });
  assertEquals(comTexto.completo, true);
});

Deno.test("33 SOLO autônoma exige anexos traduzidos + dossiê ok (Caio 26/08)", () => {
  const semAnexos = conteudoCompletoParaVeto("lancar_oc33_solo_portal:33", {
    tool: "lancar_oc33_solo_portal", args: { codigo_ssw: 33 },
  });
  assertEquals(semAnexos.completo, false);
  assertEquals(semAnexos.faltando, ["anexos_33"]);
  const dossieBloqueado = conteudoCompletoParaVeto("lancar_oc33_solo_portal:33", {
    tool: "lancar_oc33_solo_portal",
    args: { codigo_ssw: 33, extras: { anexos_ids: ["a1"] } },
    meta: { gate_oc33: { bloqueada: true } },
  });
  assertEquals(dossieBloqueado.completo, false);
  assertEquals(dossieBloqueado.faltando, ["dossie_incompleto"]);
  const ok = conteudoCompletoParaVeto("lancar_oc33_solo_portal:33", {
    tool: "lancar_oc33_solo_portal",
    args: { codigo_ssw: 33, extras: { anexos_ids: ["a1"] } },
    meta: { gate_oc33: { bloqueada: false } },
  });
  assertEquals(ok.completo, true);
});

Deno.test("cerca da sugestão velha (NF 26033): >4h não agenda; fresca/null passa", () => {
  assertEquals(
    decidirElegibilidadeVeto({ ...BASE, idadeSugestaoHoras: 20 }),
    { elegivel: false, motivo: "sugestao_velha_precisa_reanalise" },
  );
  assertEquals(decidirElegibilidadeVeto({ ...BASE, idadeSugestaoHoras: 3.5 }), { elegivel: true });
  assertEquals(decidirElegibilidadeVeto({ ...BASE, idadeSugestaoHoras: null }), { elegivel: true });
});
