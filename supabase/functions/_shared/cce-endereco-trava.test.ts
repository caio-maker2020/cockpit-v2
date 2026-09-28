// Guard da trava de CCE de endereço (ADR 0035). Textos baseados nos casos
// reais medidos em 28/09, sem dado pessoal (repo público).
// Rodar com: deno test --no-check supabase/functions/_shared/cce-endereco-trava.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  agendarComTravaCce,
  CHAVES_REENTREGA,
  decidirCceEnderecoVigente,
  detectarCceNoEmail,
  ehChaveDeReentrega,
  EVENTO_CCE_SEGUROU,
  type MensagemDoCard,
  MOTIVO_CCE_ENDERECO,
  MOTIVO_VERIFICACAO_FALHOU,
  temContextoDeEndereco,
  textoEscritoPeloCliente,
} from "./cce-endereco-trava.ts";

const CITACAO_TEMPLATE_ENDERECO =
  "\r\n\r\nEm seg., 28 de set. de 2026 às 09:00, Operadora <operadora@salexpress.com.br> escreveu:\r\n" +
  "> Olá,\r\n> Não conseguimos localizar o endereço de entrega da NF 1.\r\n" +
  "> Caso necessário, solicitamos também o envio de uma CCe.\r\n";

const RESPOSTA_40484 = "Bom dia!\r\n\r\nSegue carta de correção em anexo,\r\n\r\nContato no local: (31) 90000-0000\r\n" +
  "https://maps.app.goo.gl/EXEMPLO\r\n\r\nConseguimos seguir com a entrega hoje?" + CITACAO_TEMPLATE_ENDERECO;

function msg(p: Partial<MensagemDoCard> & { id: string; recebidoEm: string }): MensagemDoCard {
  return { conteudo: "", assunto: null, anexos: [], ...p };
}

// ── detector ────────────────────────────────────────────────────────────────

Deno.test("detecta: NF 40484 — 'Segue carta de correção em anexo' com a citação do nosso e-mail", () => {
  const d = detectarCceNoEmail({ conteudo: RESPOSTA_40484, anexos: [] });
  assertEquals(d?.origem, "texto");
});

Deno.test("detecta: NF 381683 — 'cc-e' com hífen", () => {
  const d = detectarCceNoEmail({ conteudo: "Bom dia! Segue em anexo cc-e, conseguimos entregar em qual data?", anexos: [] });
  assertEquals(d?.origem, "texto");
});

Deno.test("detecta: NF 3912376 — CCE só no nome do anexo", () => {
  const d = detectarCceNoEmail({
    conteudo: "Bom dia! O endereço da nota é da cliente, mas ela atualizou aqui o endereço da oficina.",
    anexos: ["carta_correcao 3912376.pdf"],
  });
  assertEquals(d?.origem, "anexo");
});

Deno.test("detecta: nomes de anexo reais (-cce.pdf, dacce-, CCe colado no número, Carta Correção)", () => {
  for (
    const nome of [
      "1101103226083147483600066655004000312388195715306401 -cce.pdf",
      "dacce-11011020260917133956312609606659810009755500100111954711.pdf",
      "CCe31260910406295000235550010001172481002913525.pdf",
      "Carta Correção 78197.pdf",
      "CARTA DE CORRECAO NF.1647.pdf",
      "cce 1357598 (1).pdf",
    ]
  ) {
    assertEquals(detectarCceNoEmail({ conteudo: "Segue.", anexos: [nome] })?.origem, "anexo", nome);
  }
});

Deno.test("NÃO detecta: NF 670133 — só a NOSSA frase do template, citada", () => {
  const conteudo = "O endereço da clínica está correto!" + CITACAO_TEMPLATE_ENDERECO;
  assertEquals(detectarCceNoEmail({ conteudo, anexos: [] }), null);
});

Deno.test("NÃO detecta: frase do template colada SEM marcador de citação", () => {
  const conteudo = "O endereço está correto.\r\nCaso necessário, solicitamos também o envio de uma CCe.";
  assertEquals(detectarCceNoEmail({ conteudo, anexos: [] }), null);
  assert(!textoEscritoPeloCliente(conteudo).toLowerCase().includes("cce"));
});

Deno.test("NÃO detecta: identificadores que contêm 'cce' (cid, hash, nome de imagem)", () => {
  const conteudo = "Segue foto. [cid:0278c5cc-7224-4a22-abd5-8cce0e] ref 9cce12";
  assertEquals(detectarCceNoEmail({ conteudo, anexos: ["cced260a.png", "image001.png"] }), null);
});

Deno.test("NÃO detecta: e-mail vazio", () => {
  assertEquals(detectarCceNoEmail({ conteudo: "", anexos: [] }), null);
  assertEquals(detectarCceNoEmail({ conteudo: null, anexos: [] }), null);
});

// ── contexto de endereço ────────────────────────────────────────────────────

Deno.test("endereço: assunto do template PROBLEMAS_COM_ENDERECO ('Insucesso na entrega')", () => {
  assert(temContextoDeEndereco({
    textoCliente: "Segue a carta de correção.",
    assuntoMensagem: "Re: Insucesso na entrega — NF 1 — CLIENTE",
    assuntoNossoEmailAnterior: null,
  }));
});

Deno.test("endereço: assunto do NOSSO e-mail anterior quando a resposta vem com assunto neutro", () => {
  assert(temContextoDeEndereco({
    textoCliente: "Segue.",
    assuntoMensagem: "NF 1",
    assuntoNossoEmailAnterior: "[Sal Express] NF 1 — confirmar endereço de entrega",
  }));
});

Deno.test("endereço: 'DIVIRGÊNCIA CIDADE' (grafia real) e 'divergência de cidade'", () => {
  for (const a of ["DIVIRGÊNCIA CIDADE — NF 381683", "Divergência de cidade — NF 2"]) {
    assert(temContextoDeEndereco({ textoCliente: "", assuntoMensagem: a, assuntoNossoEmailAnterior: null }), a);
  }
});

Deno.test("endereço: palavra 'endereço' ou link de mapa no texto do cliente", () => {
  for (
    const t of [
      "Oficina mudou de endereço, segue a carta de correção.",
      "Segue anexo CCe. Link: https://www.google.com/maps/place/EXEMPLO",
      "Segue CCe, localização https://maps.app.goo.gl/EXEMPLO",
    ]
  ) {
    assert(temContextoDeEndereco({ textoCliente: t, assuntoMensagem: "Re: NF 1", assuntoNossoEmailAnterior: null }), t);
  }
});

Deno.test("NÃO é endereço: 'Recusa Total' sem sinal de endereço (NF 1119547 / 662585 seguem no automático)", () => {
  assertEquals(
    temContextoDeEndereco({
      textoCliente: "Seguir com a reentrega urgente no cliente, juntamente com a carta de correção anexo.",
      assuntoMensagem: "ENC: NF 1119547 - CLIENTE",
      assuntoNossoEmailAnterior: "Recusa Total — NF 1119547 — CLIENTE",
    }),
    false,
  );
});

Deno.test("NÃO é endereço: assinatura com rua/av./CEP não conta", () => {
  assertEquals(
    temContextoDeEndereco({
      textoCliente: "Segue a carta de correção dos volumes.\r\nEmpresa X — Av. Exemplo, 99 — Rua Y — CEP 30000-000",
      assuntoMensagem: "Re: Extravio parcial — NF 1",
      assuntoNossoEmailAnterior: "Extravio parcial — NF 1",
    }),
    false,
  );
});

// ── vigência (até a reentrega sair) ─────────────────────────────────────────

const CCE_18 = msg({
  id: "m-cce",
  recebidoEm: "2026-09-18T17:46:28Z",
  conteudo: "Boa tarde! Seguir com reentrega. Carta de correção, anexo. ENDEREÇO DE ENTREGA: AV EXEMPLO, 1",
  assunto: "Re: Insucesso na entrega — NF 3907402",
  anexos: ["carta_correcao 3907402.pdf"],
});
const COBRANCA_24 = msg({
  id: "m-cobranca",
  recebidoEm: "2026-09-24T18:52:28Z",
  conteudo: "Boa tarde! Precisamos que os e-mails sejam respondidos com brevidade. Autorizamos a entrega.",
  assunto: "Re: Insucesso na entrega — NF 3907402",
});

Deno.test("vigente: NF 3907402 — cobrança SEM CCE depois da CCE, sem 21 no meio → segura", () => {
  const v = decidirCceEnderecoVigente({ mensagens: [COBRANCA_24, CCE_18], enviados: [], ultima21SucessoEm: null });
  assertEquals(v?.mensagemId, "m-cce");
});

Deno.test("não vigente: a 21 saiu com sucesso DEPOIS da CCE → libera", () => {
  const v = decidirCceEnderecoVigente({
    mensagens: [COBRANCA_24, CCE_18],
    enviados: [],
    ultima21SucessoEm: "2026-09-20T10:00:00Z",
  });
  assertEquals(v, null);
});

Deno.test("vigente de novo: CCE nova DEPOIS da última 21", () => {
  const nova = msg({ ...CCE_18, id: "m-cce-2", recebidoEm: "2026-09-26T09:00:00Z" });
  const v = decidirCceEnderecoVigente({
    mensagens: [nova, COBRANCA_24, CCE_18],
    enviados: [],
    ultima21SucessoEm: "2026-09-20T10:00:00Z",
  });
  assertEquals(v?.mensagemId, "m-cce-2");
});

Deno.test("vigência usa o nosso e-mail ANTERIOR à mensagem, nunca um posterior", () => {
  const m = msg({ id: "m1", recebidoEm: "2026-09-10T12:00:00Z", conteudo: "Segue a CCe.", assunto: "Re: NF 1" });
  const depois = [{ enviadoEm: "2026-09-11T12:00:00Z", assunto: "Insucesso na entrega — NF 1" }];
  assertEquals(decidirCceEnderecoVigente({ mensagens: [m], enviados: depois, ultima21SucessoEm: null }), null);
  const antes = [{ enviadoEm: "2026-09-09T12:00:00Z", assunto: "Insucesso na entrega — NF 1" }];
  assertEquals(decidirCceEnderecoVigente({ mensagens: [m], enviados: antes, ultima21SucessoEm: null })?.mensagemId, "m1");
});

Deno.test("CCE de volume (NF 1115901) não vira etiqueta", () => {
  const m = msg({
    id: "m1",
    recebidoEm: "2026-09-16T12:00:00Z",
    conteudo: "Ref. essa devolução, cliente devolveu tudo certo (4 volumes conforme carta de correção).",
    assunto: "CLIENTE NF 1115901",
    anexos: ["dacce-1101102026091609060231260860665981000975550010011159011.pdf"],
  });
  const enviados = [{ enviadoEm: "2026-09-15T12:00:00Z", assunto: "Recusa Total — NF 1115901 — CLIENTE" }];
  assertEquals(decidirCceEnderecoVigente({ mensagens: [m], enviados, ultima21SucessoEm: null }), null);
});

// ── portão (agendarComTravaCce) com banco falso ─────────────────────────────

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>, erroEm?: string) {
  const consultas: string[] = [];
  const inserts: Linha[] = [];
  const cliente = {
    from(tabela: string) {
      consultas.push(tabela);
      let rows = [...(tabelas[tabela] ?? [])];
      const resultado = () =>
        erroEm === tabela ? { data: null, error: { message: "falha simulada" } } : { data: rows, error: null };
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
        order: (c: string, o?: { ascending?: boolean }) => (
          (rows = rows.sort((a, b) =>
            (String(a[c]) < String(b[c]) ? -1 : 1) * (o?.ascending === false ? -1 : 1)
          )), q
        ),
        limit: (n: number) => ((rows = rows.slice(0, n)), q),
        maybeSingle: () => {
          const r = resultado();
          return Promise.resolve(r.error ? r : { data: rows[0] ?? null, error: null });
        },
        insert: (p: Linha) => {
          inserts.push({ tabela, ...p });
          return Promise.resolve({ data: null, error: null });
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko),
      };
      return q;
    },
  };
  return { cliente, consultas, inserts };
}

const PILOTO_LIGADO: Record<string, Linha[]> = {
  feature_flags: [{ key: "acao_autonoma_veto_enabled", enabled: true }],
  acoes_autonomas_veto_config: [{ acao_key: "lancar_ocorrencia:21", ativa: true }],
  cards: [{ id: "card-1", assigned_operator_id: "op-felipe" }],
  acoes_autonomas_veto_operadores: [{ operador_id: "op-felipe", ativo: true }],
  acoes_executadas_ssw: [],
  email_anexos: [],
  cards_emails_outbound: [],
  card_events: [],
};

const MSG_CCE_40484: Linha = {
  id: "msg-40484",
  card_id: "card-1",
  canal: "email",
  recebido_em: "2026-09-28T12:42:24Z",
  conteudo: RESPOSTA_40484,
  assunto: "Re: Insucesso na entrega — NF 40484 — CLIENTE",
};

function entrada(acaoKey: string) {
  return {
    cardId: "card-1",
    agentName: "interpretador-resposta-cliente",
    acaoKey,
    ocCard: 54,
    ocSugerida: 21,
    confianca: 0.92,
  };
}

function agendadorEspiao() {
  const chamadas: unknown[] = [];
  return {
    chamadas,
    agendar: (_s: unknown, i: unknown) => {
      chamadas.push(i);
      return Promise.resolve({ agendou: true as const, agendamentoId: 1, executarEm: "x" });
    },
  };
}

Deno.test("portão: chave que não é 21 delega SEM nenhuma consulta a mais", async () => {
  for (const k of ["lancar_oc_e_enviar_email:54", "lancar_ocorrencia:56", "ignorar_e_aguardar:54", "lancar_oc33_solo_portal:33"]) {
    const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] });
    const esp = agendadorEspiao();
    const r = await agendarComTravaCce(db.cliente, entrada(k), esp);
    assertEquals(r.agendou, true, k);
    assertEquals(esp.chamadas.length, 1, k);
    assertEquals(db.consultas.length, 0, k);
  }
});

Deno.test("portão: NF 40484 no piloto — 21 SEGURADA, evento registrado, agendador NÃO chamado", async () => {
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  assertEquals(esp.chamadas.length, 0);
  const ev = db.inserts.filter((x) => x.tabela === "card_events");
  assertEquals(ev.length, 1);
  assertEquals(ev[0]!.event_type, EVENTO_CCE_SEGUROU);
  const payload = ev[0]!.payload as Record<string, unknown>;
  assertEquals(payload.mensagem_cce_id, "msg-40484");
  assertEquals(payload.acao_key, "lancar_ocorrencia:21");
  assertEquals("todo_id" in payload, false);
});

Deno.test("portão: evento não duplica para a mesma CCE + chave", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [MSG_CCE_40484],
    card_events: [{
      card_id: "card-1",
      event_type: EVENTO_CCE_SEGUROU,
      created_at: "2026-09-28T12:43:38Z",
      payload: { mensagem_cce_id: "msg-40484", acao_key: "lancar_ocorrencia:21" },
    }],
  });
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), agendadorEspiao());
  assertEquals(r.agendou, false);
  assertEquals(db.inserts.filter((x) => x.tabela === "card_events").length, 0);
});

Deno.test("portão: operador FORA do piloto — delega (idêntico a hoje) e nem lê os e-mails", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    acoes_autonomas_veto_operadores: [{ operador_id: "op-felipe", ativo: false }],
    messages_inbox: [MSG_CCE_40484],
  });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
  assertEquals(db.consultas.includes("messages_inbox"), false);
  assertEquals(db.inserts.length, 0);
});

Deno.test("portão: flag master OFF ou degrau inativo — delega e nem lê os e-mails", async () => {
  const cenarios: Array<Record<string, Linha[]>> = [
    { feature_flags: [{ key: "acao_autonoma_veto_enabled", enabled: false }] },
    { acoes_autonomas_veto_config: [{ acao_key: "lancar_ocorrencia:21", ativa: false }] },
  ];
  for (const extra of cenarios) {
    const db = bancoFalso({ ...PILOTO_LIGADO, ...extra, messages_inbox: [MSG_CCE_40484] });
    const esp = agendadorEspiao();
    await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
    assertEquals(esp.chamadas.length, 1);
    assertEquals(db.consultas.includes("messages_inbox"), false);
  }
});

Deno.test("portão: piloto SEM CCE — delega normalmente, sem evento", async () => {
  const semCce = { ...MSG_CCE_40484, conteudo: "O endereço da clínica está correto!" + CITACAO_TEMPLATE_ENDERECO };
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [semCce] });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r.agendou, true);
  assertEquals(esp.chamadas.length, 1);
  assertEquals(db.inserts.length, 0);
});

Deno.test("portão: 21 já lançada DEPOIS da CCE — delega (a etiqueta venceu)", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [MSG_CCE_40484],
    acoes_executadas_ssw: [{ card_id: "card-1", codigo_oc: 21, sucesso: true, iniciado_em: "2026-09-28T13:45:38Z" }],
  });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
});

Deno.test("portão: 21 que FALHOU não vence a etiqueta", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [MSG_CCE_40484],
    acoes_executadas_ssw: [{ card_id: "card-1", codigo_oc: 21, sucesso: false, iniciado_em: "2026-09-28T13:45:38Z" }],
  });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r.agendou, false);
  assertEquals(esp.chamadas.length, 0);
});

Deno.test("portão: erro ao ler os e-mails — segura a 21 (fail-safe) e não grava evento", async () => {
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] }, "messages_inbox");
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r, { agendou: false, motivo: MOTIVO_VERIFICACAO_FALHOU });
  assertEquals(esp.chamadas.length, 0);
  assertEquals(db.inserts.length, 0);
});

Deno.test("portão: CCE só no anexo de mensagem anterior (NF 3912376) — segura", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [{
      id: "m-anx",
      card_id: "card-1",
      canal: "email",
      recebido_em: "2026-09-23T15:31:00Z",
      conteudo: "Bom dia! Consegue priorizar essa entrega? Ela atualizou o endereço da oficina.",
      assunto: "Re: Insucesso na entrega — NF 3912376",
    }],
    email_anexos: [{ message_inbox_id: "m-anx", filename: "carta_correcao 3912376.pdf", origem: "inbound" }],
  });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r.agendou, false);
  assertEquals(esp.chamadas.length, 0);
});

Deno.test("contrato: nome do evento NÃO começa com 'Acao' (reconciliar_execucoes_presas usa LIKE 'Acao%')", () => {
  assertEquals(EVENTO_CCE_SEGUROU.startsWith("Acao"), false);
});

Deno.test("contrato: chaves da reentrega", () => {
  assertEquals([...CHAVES_REENTREGA].sort(), ["lancar_oc_e_enviar_email:21", "lancar_ocorrencia:21"]);
  assert(ehChaveDeReentrega("lancar_ocorrencia:21"));
  assertEquals(ehChaveDeReentrega("lancar_ocorrencia:54"), false);
  assertEquals(ehChaveDeReentrega(null), false);
});
