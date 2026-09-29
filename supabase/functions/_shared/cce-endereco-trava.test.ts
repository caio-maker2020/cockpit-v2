// Guard da trava de CCE de endereço (ADR 0035). Textos baseados nos casos
// reais medidos em 28/09, sem dado pessoal (repo público): nomes, telefones,
// links e chaves de acesso de NF-e são fictícios — o detector só olha o padrão.
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
  ultima21NoHistoricoSsw,
} from "./cce-endereco-trava.ts";

const CITACAO_TEMPLATE_ENDERECO =
  "\r\n\r\nEm seg., 28 de set. de 2026 às 09:00, Operadora <operadora@exemplo.com.br> escreveu:\r\n" +
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

Deno.test("detecta: 'C.C.E' com pontos", () => {
  assertEquals(detectarCceNoEmail({ conteudo: "Segue a C.C.E. da nota com o endereço novo.", anexos: [] })?.origem, "texto");
});

Deno.test("detecta: NF 3912376 — CCE só no nome do anexo", () => {
  const d = detectarCceNoEmail({
    conteudo: "Bom dia! O endereço da nota é da cliente, mas ela atualizou aqui o endereço da oficina.",
    anexos: ["carta_correcao 3912376.pdf"],
  });
  assertEquals(d?.origem, "anexo");
});

Deno.test("detecta: formatos de nome de anexo vistos (-cce.pdf, dacce-, CCe + chave, Carta Correção)", () => {
  for (
    const nome of [
      "1101100000000000000000000000000000000000000000000001 -cce.pdf",
      "dacce-11011000000000000000000000000000000000000000000000000000000001.pdf",
      "CCe00000000000000000000000000000000000000000001.pdf",
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

Deno.test("NÃO detecta: NF 29819 — cliente repassou o NOSSO e-mail ACIMA do marcador de citação", () => {
  const conteudo = "Bom dia! Favor confirmar o endereço de entrega da NF 1.\r\n" +
    "Olá, ao realizarmos a tentativa de entrega da NF 1, não foi possível localizar o endereço.\r\n" +
    "Caso necessário, solicitamos também o envio de uma CCe." + CITACAO_TEMPLATE_ENDERECO;
  assertEquals(detectarCceNoEmail({ conteudo, anexos: [] }), null);
});

Deno.test("NÃO detecta: menção a CCE que está SÓ na citação (outra frase nossa, não a do template)", () => {
  const conteudo = "Ok, obrigado." +
    "\r\n\r\nEm seg., 28 de set. de 2026 às 09:00, Operadora <operadora@exemplo.com.br> escreveu:\r\n" +
    "> Favor emitir uma CCe para corrigir o endereço de entrega.\r\n";
  assertEquals(detectarCceNoEmail({ conteudo, anexos: [] }), null);
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

Deno.test("vigente: com duas CCEs sem 21 no meio, vale a MAIS RECENTE (é ela que vai no evento)", () => {
  const nova = msg({ ...CCE_18, id: "m-cce-2", recebidoEm: "2026-09-26T09:00:00Z" });
  const v = decidirCceEnderecoVigente({ mensagens: [CCE_18, nova], enviados: [], ultima21SucessoEm: null });
  assertEquals(v?.mensagemId, "m-cce-2");
});

Deno.test("vigência usa o nosso e-mail MAIS RECENTE antes da mensagem (é a ele que o cliente responde)", () => {
  const m = msg({ id: "m1", recebidoEm: "2026-09-10T12:00:00Z", conteudo: "Segue a CCe.", assunto: "Re: NF 1" });
  const enviados = [
    { enviadoEm: "2026-09-05T12:00:00Z", assunto: "Insucesso na entrega — NF 1" },
    { enviadoEm: "2026-09-09T12:00:00Z", assunto: "Recusa Total — NF 1" },
  ];
  assertEquals(decidirCceEnderecoVigente({ mensagens: [m], enviados, ultima21SucessoEm: null }), null);
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
    anexos: ["dacce-11011000000000000000000000000000000000000000000000000000000002.pdf"],
  });
  const enviados = [{ enviadoEm: "2026-09-15T12:00:00Z", assunto: "Recusa Total — NF 1115901 — CLIENTE" }];
  assertEquals(decidirCceEnderecoVigente({ mensagens: [m], enviados, ultima21SucessoEm: null }), null);
});

// ── 21 lançada direto no SSW (decisão 3 do Carlos, 28/09) ───────────────────

/** 29/09/26 12:00 em Brasília — relógio fixo para os testes puros. */
const AGORA_TESTE = Date.parse("2026-09-29T15:00:00Z");

Deno.test("histórico do SSW: pega a 21 MAIS RECENTE pela data do SSW (BRT → UTC)", () => {
  const historico = [
    { codigo: 54, data: "20/09/26 10:00" },
    { codigo: 21, data: "18/09/26 17:05" },
    { codigo: "21", data: "19/09/26 08:30" }, // código pode vir como texto
    { codigo: 11, data: "17/09/26 09:00" },
  ];
  assertEquals(ultima21NoHistoricoSsw(historico, AGORA_TESTE), "2026-09-19T11:30:00.000Z");
});

Deno.test("histórico do SSW: sem histórico, sem 21 ou 21 sem hora legível → null (a trava continua)", () => {
  assertEquals(ultima21NoHistoricoSsw(null, AGORA_TESTE), null);
  assertEquals(ultima21NoHistoricoSsw({ codigo: 21 }, AGORA_TESTE), null);
  assertEquals(ultima21NoHistoricoSsw([{ codigo: 54, data: "20/09/26 10:00" }], AGORA_TESTE), null);
  assertEquals(ultima21NoHistoricoSsw([{ codigo: 21, data: "18/09/26" }, { codigo: 21 }, null], AGORA_TESTE), null);
});

Deno.test("histórico do SSW: data que não existe no calendário ou no futuro é ignorada (dado ruim nunca solta)", () => {
  const valida = { codigo: 21, data: "18/09/26 17:05" };
  for (const ruim of ["31/02/26 10:00", "18/13/26 10:00", "01/10/26 10:00" /* futuro */]) {
    assertEquals(
      ultima21NoHistoricoSsw([valida, { codigo: 21, data: ruim }], AGORA_TESTE),
      "2026-09-18T20:05:00.000Z",
      ruim,
    );
  }
  // 31/04 não existe e viraria 01/05 (passado, mais novo que 01/03): tem de ser ignorada.
  assertEquals(
    ultima21NoHistoricoSsw([{ codigo: 21, data: "01/03/26 10:00" }, { codigo: 21, data: "31/04/26 10:00" }], AGORA_TESTE),
    "2026-03-01T13:00:00.000Z",
  );
  // Até 10 min à frente do relógio ainda vale (folga de relógio).
  assertEquals(ultima21NoHistoricoSsw([{ codigo: 21, data: "29/09/26 12:05" }], AGORA_TESTE), "2026-09-29T15:05:00.000Z");
});

Deno.test("vigência: 21 no SSW DEPOIS da CCE encerra; ANTES da CCE não encerra", () => {
  // CCE_18 chegou 17:46Z (14:46 BRT).
  const depois = decidirCceEnderecoVigente({
    mensagens: [CCE_18],
    enviados: [],
    ultima21SucessoEm: null,
    ultima21NoSswEm: "2026-09-18T20:05:00.000Z", // 17:05 BRT
  });
  assertEquals(depois, null);
  const antes = decidirCceEnderecoVigente({
    mensagens: [CCE_18],
    enviados: [],
    ultima21SucessoEm: null,
    ultima21NoSswEm: "2026-09-18T16:05:00.000Z", // 13:05 BRT, antes da CCE
  });
  assertEquals(antes?.mensagemId, "m-cce");
});

Deno.test("vigência: vale a reentrega MAIS NOVA entre a do Cockpit e a do SSW", () => {
  const nova = msg({ ...CCE_18, id: "m-cce-2", recebidoEm: "2026-09-26T09:00:00Z" });
  // 21 do Cockpit antiga (antes das duas CCEs), 21 do SSW entre as duas: vale a CCE nova.
  const v = decidirCceEnderecoVigente({
    mensagens: [nova, CCE_18],
    enviados: [],
    ultima21SucessoEm: "2026-09-10T10:00:00Z",
    ultima21NoSswEm: "2026-09-20T10:00:00Z",
  });
  assertEquals(v?.mensagemId, "m-cce-2");
  // A do Cockpit é a mais nova e passa das duas: encerra, mesmo com a do SSW velha.
  assertEquals(
    decidirCceEnderecoVigente({
      mensagens: [nova, CCE_18],
      enviados: [],
      ultima21SucessoEm: "2026-09-27T10:00:00Z",
      ultima21NoSswEm: "2026-09-10T10:00:00Z",
    }),
    null,
  );
});

Deno.test("vigência: data ilegível da 21 conta como 'não houve 21' (nunca solta a trava)", () => {
  for (const ruim of ["nao-e-data", ""]) {
    const v = decidirCceEnderecoVigente({
      mensagens: [CCE_18],
      enviados: [],
      ultima21SucessoEm: ruim,
      ultima21NoSswEm: ruim,
    });
    assertEquals(v?.mensagemId, "m-cce", JSON.stringify(ruim));
  }
});

Deno.test("contexto de endereço vem do cliente ou dos assuntos, NUNCA da citação", () => {
  // A citação traz o nosso e-mail ("localizar o endereço"), mas o assunto é
  // neutro e não há e-mail nosso registrado: CCE sem sinal de endereço segue
  // no automático (decisão 4 do Carlos).
  const m = msg({
    id: "m1",
    recebidoEm: "2026-09-28T12:00:00Z",
    conteudo: "Segue a CCe." + CITACAO_TEMPLATE_ENDERECO,
    assunto: "Re: NF 1",
  });
  assertEquals(decidirCceEnderecoVigente({ mensagens: [m], enviados: [], ultima21SucessoEm: null }), null);
});

// ── portão (agendarComTravaCce) com banco falso ─────────────────────────────

type Linha = Record<string, unknown>;

/** Aplica os apelidos do select do PostgREST ("assunto:raw_payload->>subject")
 *  — sem isso um apelido quebrado passaria nos testes. */
function aplicarApelidos(rows: Linha[], colunas: string): Linha[] {
  const apelidos = colunas.split(",").map((c) => c.trim().match(/^(\w+):(\w+)->>(\w+)$/)).filter((m) => !!m);
  if (apelidos.length === 0) return rows;
  return rows.map((r) => {
    const out: Linha = { ...r };
    for (const [, apelido, coluna, chave] of apelidos as RegExpMatchArray[]) {
      const json = r[coluna!] as Record<string, unknown> | null | undefined;
      out[apelido!] = json?.[chave!] ?? null;
    }
    return out;
  });
}

function bancoFalso(
  tabelas: Record<string, Linha[]>,
  opcoes: { erroEm?: string; erroEmSelect?: string; erroNoInsert?: boolean } = {},
) {
  const consultas: string[] = [];
  const filtrosIn: string[] = [];
  const inserts: Linha[] = [];
  const cliente = {
    from(tabela: string) {
      consultas.push(tabela);
      let rows = [...(tabelas[tabela] ?? [])];
      let colunas = "";
      const resultado = () =>
        opcoes.erroEm === tabela || (!!opcoes.erroEmSelect && colunas.includes(opcoes.erroEmSelect))
          ? { data: null, error: { message: "falha simulada" } }
          : { data: aplicarApelidos(rows, colunas), error: null };
      const q = {
        select: (c?: string) => ((colunas = c ?? ""), q),
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        in: (c: string, vs: unknown[]) => (
          filtrosIn.push(`${tabela}.${c}=${JSON.stringify(vs)}`), (rows = rows.filter((r) => vs.includes(r[c]))), q
        ),
        order: (c: string, o?: { ascending?: boolean }) => (
          (rows = rows.sort((a, b) =>
            (String(a[c]) < String(b[c]) ? -1 : 1) * (o?.ascending === false ? -1 : 1)
          )), q
        ),
        limit: (n: number) => ((rows = rows.slice(0, n)), q),
        maybeSingle: () => {
          const r = resultado();
          return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null });
        },
        insert: (p: Linha) => {
          if (opcoes.erroNoInsert) return Promise.resolve({ data: null, error: { message: "insert recusado" } });
          inserts.push({ tabela, ...p });
          return Promise.resolve({ data: null, error: null });
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko),
      };
      return q;
    },
  };
  return { cliente, consultas, filtrosIn, inserts };
}

const PILOTO_LIGADO: Record<string, Linha[]> = {
  feature_flags: [{ key: "acao_autonoma_veto_enabled", enabled: true }],
  acoes_autonomas_veto_config: [{ acao_key: "lancar_ocorrencia:21", ativa: true }],
  cards: [{ id: "card-1", assigned_operator_id: "op-piloto" }],
  acoes_autonomas_veto_operadores: [{ operador_id: "op-piloto", ativo: true }],
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
  raw_payload: { subject: "Re: Insucesso na entrega — NF 40484 — CLIENTE" },
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
  for (
    const k of [
      "lancar_oc_e_enviar_email:54",
      "lancar_ocorrencia:56",
      "ignorar_e_aguardar:54",
      "lancar_oc33_solo_portal:33",
      "ignorar_e_aguardar:21", // termina em :21 mas não é reentrega
    ]
  ) {
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
  // Anexos pedidos SÓ das mensagens lidas — sem o filtro, a consulta varreria a
  // tabela inteira e o limite de linhas do banco cortaria a lista em silêncio.
  assertEquals(db.filtrosIn, ['email_anexos.message_inbox_id=["msg-40484"]']);
});

Deno.test("portão: NF 3907402 — cobrança SEM CCE mais nova que a CCE, as duas no banco → segura", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [
      {
        id: "m-cce",
        card_id: "card-1",
        canal: "email",
        recebido_em: "2026-09-18T17:46:28Z",
        conteudo: "Boa tarde! Seguir com reentrega. Carta de correção, anexo. ENDEREÇO DE ENTREGA: AV EXEMPLO, 1",
        raw_payload: { subject: "Re: Insucesso na entrega — NF 3907402" },
      },
      {
        id: "m-cobranca",
        card_id: "card-1",
        canal: "email",
        recebido_em: "2026-09-24T18:52:28Z",
        conteudo: "Boa tarde! Precisamos que os e-mails sejam respondidos com brevidade. Autorizamos a entrega.",
        raw_payload: { subject: "Re: Insucesso na entrega — NF 3907402" },
      },
    ],
  });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  assertEquals(esp.chamadas.length, 0);
});

Deno.test("portão: variante com e-mail da 21 — sem degrau delega sem evento; com degrau ativo segura", async () => {
  const variante = "lancar_oc_e_enviar_email:21";
  const semDegrau = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] });
  const esp1 = agendadorEspiao();
  await agendarComTravaCce(semDegrau.cliente, entrada(variante), esp1);
  assertEquals(esp1.chamadas.length, 1);
  assertEquals(semDegrau.inserts.length, 0);

  const comDegrau = bancoFalso({
    ...PILOTO_LIGADO,
    acoes_autonomas_veto_config: [{ acao_key: variante, ativa: true }],
    messages_inbox: [MSG_CCE_40484],
  });
  const esp2 = agendadorEspiao();
  const r = await agendarComTravaCce(comDegrau.cliente, entrada(variante), esp2);
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  assertEquals(esp2.chamadas.length, 0);
});

Deno.test("portão: CCE que chegou por WhatsApp não conta (a trava é só de e-mail)", async () => {
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [{ ...MSG_CCE_40484, canal: "whatsapp" }] });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
});

Deno.test("portão: anexo NOSSO (saída) com nome de CCE não conta", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [{
      id: "m-x",
      card_id: "card-1",
      canal: "email",
      recebido_em: "2026-09-28T12:00:00Z",
      conteudo: "Bom dia, pode seguir.",
      raw_payload: { subject: "Re: Insucesso na entrega — NF 1" },
    }],
    email_anexos: [{ message_inbox_id: "m-x", filename: "cce 1.pdf", origem: "outbound" }],
  });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
});

Deno.test("portão: e-mail nosso de OUTRO card não dá contexto de endereço", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [{
      id: "m-neutra",
      card_id: "card-1",
      canal: "email",
      recebido_em: "2026-09-28T12:00:00Z",
      conteudo: "Segue a CCe.",
      raw_payload: { subject: "Re: NF 1" },
    }],
    cards_emails_outbound: [{ card_id: "card-2", subject: "Insucesso na entrega — NF 2", sent_at: "2026-09-27T12:00:00Z" }],
  });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
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
    acoes_autonomas_veto_operadores: [{ operador_id: "op-piloto", ativo: false }],
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

Deno.test("portão: erro em QUALQUER consulta da trava — segura a 21 (fail-safe) e não grava evento", async () => {
  for (
    const tabela of [
      "feature_flags",
      "acoes_autonomas_veto_config",
      "cards",
      "acoes_autonomas_veto_operadores",
      "acoes_executadas_ssw",
      "messages_inbox",
      "email_anexos",
      "cards_emails_outbound",
    ]
  ) {
    const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] }, { erroEm: tabela });
    const esp = agendadorEspiao();
    const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
    assertEquals(r, { agendou: false, motivo: MOTIVO_VERIFICACAO_FALHOU }, tabela);
    assertEquals(esp.chamadas.length, 0, tabela);
    assertEquals(db.inserts.length, 0, tabela);
    assert(db.consultas.includes(tabela), `${tabela} nem foi consultada — o cenário não testa nada`);
  }
});

const HISTORICO_21_DEPOIS_DA_40484 = [
  { codigo: 21, data: "28/09/26 11:30" }, // 14:30Z, depois da CCE (12:42Z)
  { codigo: 54, data: "27/09/26 16:00" },
];

Deno.test("portão: NF 39386 — 21 lançada direto no SSW depois da CCE → delega, sem evento", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    cards: [{ id: "card-1", assigned_operator_id: "op-piloto", historico_ssw: HISTORICO_21_DEPOIS_DA_40484 }],
    messages_inbox: [MSG_CCE_40484],
  });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r.agendou, true);
  assertEquals(esp.chamadas.length, 1);
  assertEquals(db.inserts.length, 0);
});

Deno.test("portão: 21 no SSW ANTES da CCE não encerra — segura", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    cards: [{
      id: "card-1",
      assigned_operator_id: "op-piloto",
      historico_ssw: [{ codigo: 21, data: "28/09/26 09:00" }], // 12:00Z, antes da CCE (12:42Z)
    }],
    messages_inbox: [MSG_CCE_40484],
  });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  const payload = db.inserts[0]!.payload as Record<string, unknown>;
  assertEquals(payload.historico_ssw_disponivel, true);
});

Deno.test("portão: sem histórico do SSW no card — segura e registra que o histórico não estava lá", async () => {
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  const payload = db.inserts[0]!.payload as Record<string, unknown>;
  assertEquals(payload.historico_ssw_disponivel, false);
});

Deno.test("portão: o histórico do SSW só é lido quando a trava seguraria (sem CCE, nenhuma leitura a mais)", async () => {
  const semCce = { ...MSG_CCE_40484, conteudo: "O endereço da clínica está correto!" + CITACAO_TEMPLATE_ENDERECO };
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [semCce] });
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), agendadorEspiao());
  assertEquals(db.consultas.filter((t) => t === "cards").length, 1); // só a do dono do card
});

Deno.test("portão: erro ao ler o histórico do SSW — segura como se não houvesse histórico, COM evento e aviso", async () => {
  const avisos: string[] = [];
  const warnOriginal = console.warn;
  console.warn = (...a: unknown[]) => void avisos.push(a.map(String).join(" "));
  try {
    const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] }, { erroEmSelect: "historico_ssw" });
    const esp = agendadorEspiao();
    const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
    assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
    assertEquals(esp.chamadas.length, 0);
    assertEquals(db.inserts.length, 1);
    assertEquals((db.inserts[0]!.payload as Record<string, unknown>).historico_ssw_disponivel, false);
    assert(avisos.some((a) => a.includes("histórico do SSW não lido")), `aviso ausente: ${JSON.stringify(avisos)}`);
  } finally {
    console.warn = warnOriginal;
  }
});

Deno.test("portão: histórico do SSW gravado mas VAZIO conta como 'sem histórico' no evento", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    cards: [{ id: "card-1", assigned_operator_id: "op-piloto", historico_ssw: [] }],
    messages_inbox: [MSG_CCE_40484],
  });
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), agendadorEspiao());
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  assertEquals((db.inserts[0]!.payload as Record<string, unknown>).historico_ssw_disponivel, false);
});

Deno.test("portão: card do piloto SEM nenhum e-mail — delega normalmente (a reanálise arma assim)", async () => {
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [] });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r.agendou, true);
  assertEquals(esp.chamadas.length, 1);
  assertEquals(db.inserts.length, 0);
});

Deno.test("portão: CCE só no card VIZINHO não segura a 21 deste card", async () => {
  const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [{ ...MSG_CCE_40484, id: "msg-outro", card_id: "card-2" }] });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
});

Deno.test("portão: só uma 21 DESTE card com sucesso encerra a CCE (oc 54 ou 21 de outro card não)", async () => {
  const depois = "2026-09-28T13:45:38Z";
  for (
    const acao of [
      { card_id: "card-1", codigo_oc: 54, sucesso: true, iniciado_em: depois },
      { card_id: "card-2", codigo_oc: 21, sucesso: true, iniciado_em: depois },
    ]
  ) {
    const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484], acoes_executadas_ssw: [acao] });
    const esp = agendadorEspiao();
    const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
    assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO }, JSON.stringify(acao));
    assertEquals(esp.chamadas.length, 0);
  }
});

Deno.test("portão: vale a 21 MAIS RECENTE — uma antes e outra depois da CCE → delega", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [MSG_CCE_40484],
    acoes_executadas_ssw: [
      { card_id: "card-1", codigo_oc: 21, sucesso: true, iniciado_em: "2026-09-20T10:00:00Z" },
      { card_id: "card-1", codigo_oc: 21, sucesso: true, iniciado_em: "2026-09-28T13:45:38Z" },
    ],
  });
  const esp = agendadorEspiao();
  await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(esp.chamadas.length, 1);
});

Deno.test("portão: endereço só no ASSUNTO do e-mail (lido pelo apelido raw_payload->>subject) — segura", async () => {
  const db = bancoFalso({
    ...PILOTO_LIGADO,
    messages_inbox: [{
      id: "m-assunto",
      card_id: "card-1",
      canal: "email",
      recebido_em: "2026-09-28T12:00:00Z",
      conteudo: "Bom dia! Segue a CCe.",
      raw_payload: { subject: "Re: Insucesso na entrega — NF 1 — CLIENTE" },
    }],
  });
  const esp = agendadorEspiao();
  const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
  assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
  assertEquals(esp.chamadas.length, 0);
});

Deno.test("portão: gravação do evento recusada — a 21 continua segurada e o erro vai para o log", async () => {
  const avisos: string[] = [];
  const warnOriginal = console.warn;
  console.warn = (...a: unknown[]) => void avisos.push(a.map(String).join(" "));
  try {
    const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] }, { erroNoInsert: true });
    const esp = agendadorEspiao();
    const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
    assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
    assertEquals(esp.chamadas.length, 0);
    assert(avisos.some((a) => a.includes("registro do evento falhou")), `aviso ausente: ${JSON.stringify(avisos)}`);
  } finally {
    console.warn = warnOriginal;
  }
});

Deno.test("portão: checagem de duplicidade falhou — a 21 continua segurada, sem evento, e o erro vai para o log", async () => {
  const avisos: string[] = [];
  const warnOriginal = console.warn;
  console.warn = (...a: unknown[]) => void avisos.push(a.map(String).join(" "));
  try {
    const db = bancoFalso({ ...PILOTO_LIGADO, messages_inbox: [MSG_CCE_40484] }, { erroEm: "card_events" });
    const esp = agendadorEspiao();
    const r = await agendarComTravaCce(db.cliente, entrada("lancar_ocorrencia:21"), esp);
    assertEquals(r, { agendou: false, motivo: MOTIVO_CCE_ENDERECO });
    assertEquals(db.inserts.length, 0);
    assert(avisos.some((a) => a.includes("checagem de duplicidade falhou")), `aviso ausente: ${JSON.stringify(avisos)}`);
  } finally {
    console.warn = warnOriginal;
  }
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
      raw_payload: { subject: "Re: Insucesso na entrega — NF 3912376" },
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
