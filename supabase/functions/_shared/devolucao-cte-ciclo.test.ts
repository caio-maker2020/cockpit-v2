// Guards do tick do ciclo. Duas famílias:
//  · a conta de dias ÚTEIS (feriado e fim de semana não contam);
//  · a máquina de estado — o que NÃO acontece importa tanto quanto o que acontece:
//    ciclo encerrado nunca é cobrado, e ciclo já entregue ao humano nunca vira spam.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CicloTick,
  type ConfigTick,
  decidirTickCiclo,
  diasUteisDecorridos,
  montarLembreteCte,
} from "./devolucao-cte-ciclo.ts";

const SEM_FERIADO: ReadonlySet<string> = new Set<string>();
const D = (iso: string) => new Date(iso);

// 2026-09-01 é uma TERÇA (conferido pelo dia da semana em BRT).
const TER = "2026-09-01T12:00:00-03:00";
const QUA = "2026-09-02T12:00:00-03:00";
const QUI = "2026-09-03T12:00:00-03:00";
const SEX = "2026-09-04T12:00:00-03:00";
const SAB = "2026-09-05T12:00:00-03:00";
const DOM = "2026-09-06T12:00:00-03:00";
const SEG = "2026-09-07T12:00:00-03:00";

// --- a conta de dias úteis --------------------------------------------------

Deno.test("mesmo dia = 0 dias úteis", () => {
  assertEquals(diasUteisDecorridos(D(TER), D("2026-09-01T23:00:00-03:00"), SEM_FERIADO), 0);
});

Deno.test("terça → quarta = 1; terça → quinta = 2", () => {
  assertEquals(diasUteisDecorridos(D(TER), D(QUA), SEM_FERIADO), 1);
  assertEquals(diasUteisDecorridos(D(TER), D(QUI), SEM_FERIADO), 2);
});

Deno.test("fim de semana NÃO conta: sexta → segunda = 1", () => {
  assertEquals(diasUteisDecorridos(D(SEX), D(SEG), SEM_FERIADO), 1);
  assertEquals(diasUteisDecorridos(D(SEX), D(SAB), SEM_FERIADO), 0);
  assertEquals(diasUteisDecorridos(D(SEX), D(DOM), SEM_FERIADO), 0);
});

Deno.test("FERIADO no meio não conta (reusa a tabela de feriados do projeto)", () => {
  // 02/09 (quarta) feriado ⇒ terça → quinta passa a valer 1, não 2.
  const comFeriado = new Set(["2026-09-02"]);
  assertEquals(diasUteisDecorridos(D(TER), D(QUI), comFeriado), 1);
});

Deno.test("data inválida ou invertida ⇒ 0 (nunca número negativo ou NaN)", () => {
  assertEquals(diasUteisDecorridos(D(QUI), D(TER), SEM_FERIADO), 0);
  assertEquals(diasUteisDecorridos(new Date("lixo"), D(TER), SEM_FERIADO), 0);
  assertEquals(diasUteisDecorridos(D(TER), new Date("lixo"), SEM_FERIADO), 0);
});

// --- a máquina de estado ----------------------------------------------------

const CFG: ConfigTick = {
  lembrete_dias_uteis: 2,
  lembretes_teto: 1,
  escalonar_dias_uteis: 2,
  vigia_dias_uteis: 5,
};

const BASE: CicloTick = {
  id: "c1",
  status: "aguardando_cte",
  aguardando_cte_desde: TER,
  cobrancas_feitas: 0,
  ultima_cobranca_em: null,
  escalonado_para_humano_em: null,
  alerta_parado_em: null,
  updated_at: TER,
  encerrado_em: null,
};

const tick = (c: Partial<CicloTick>, agoraIso: string) =>
  decidirTickCiclo({ ciclo: { ...BASE, ...c }, config: CFG, agora: D(agoraIso), feriados: SEM_FERIADO });

Deno.test("ciclo ENCERRADO nunca é cobrado (caso resolvido não recebe lembrete)", () => {
  const r = tick({ encerrado_em: QUA }, SEG);
  assertEquals(r.acao, "nada");
  assertEquals(r.motivo, "ciclo_encerrado");
});

Deno.test("ciclo já ESCALONADO nunca é cobrado nem alertado (insistir é spam)", () => {
  const r = tick({ escalonado_para_humano_em: QUA }, SEG);
  assertEquals(r.acao, "nada");
  assertEquals(r.motivo, "ja_escalonado_para_humano");
});

Deno.test("sem marco de espera NÃO cobra (cobrar sem saber desde quando é chute)", () => {
  const r = tick({ aguardando_cte_desde: null, ultima_cobranca_em: null }, SEG);
  assertEquals(r.acao, "nada");
  assertEquals(r.motivo, "sem_marco_de_espera");
});

Deno.test("cadência do Caio: 1 dia útil ⇒ espera; 2 dias úteis ⇒ COBRA", () => {
  assertEquals(tick({}, QUA).acao, "nada");
  assertEquals(tick({}, QUA).motivo, "aguardando_prazo_do_lembrete");
  const r = tick({}, QUI);
  assertEquals(r.acao, "cobrar");
  assertEquals(r.diasUteis, 2);
});

Deno.test("o prazo conta em dias ÚTEIS: marco na sexta não cobra na segunda", () => {
  // sexta → segunda = 1 dia útil, e o prazo é 2. Sem a conta de dias úteis,
  // 3 dias de calendário disparariam a cobrança cedo.
  assertEquals(tick({ aguardando_cte_desde: SEX, updated_at: SEX }, SEG).acao, "nada");
});

Deno.test("depois do lembrete, o relógio reinicia DO LEMBRETE", () => {
  // cobrança feita na quarta: quinta = 1 (espera), sexta = 2 ⇒ escalona.
  const c = { cobrancas_feitas: 1, ultima_cobranca_em: QUA };
  assertEquals(tick(c, QUI).acao, "nada");
  assertEquals(tick(c, QUI).motivo, "aguardando_prazo_de_escalonamento");
  const r = tick(c, SEX);
  assertEquals(r.acao, "escalonar");
  assertEquals(r.motivo, "teto_de_lembretes_sem_retorno");
});

Deno.test("TETO respeitado: nunca manda um 2º lembrete", () => {
  // Mesmo muito tempo depois, com o teto atingido a ação é escalonar, jamais cobrar.
  for (const quando of [SEX, SEG, "2026-09-30T12:00:00-03:00"]) {
    const r = tick({ cobrancas_feitas: 1, ultima_cobranca_em: QUA }, quando);
    assertEquals(r.acao === "cobrar", false, `cobrou 2ª vez em ${quando}`);
  }
});

Deno.test("teto ZERO: não cobra nunca, escalona direto no prazo", () => {
  const r = decidirTickCiclo({
    ciclo: { ...BASE, cobrancas_feitas: 0 },
    config: { ...CFG, lembretes_teto: 0 },
    agora: D(QUI),
    feriados: SEM_FERIADO,
  });
  assertEquals(r.acao, "escalonar");
});

// --- o vigia ----------------------------------------------------------------

Deno.test("VIGIA: ciclo aberto e parado 5 dias úteis vira alerta pra MARIA", () => {
  // status ≠ aguardando_cte ⇒ ramo do vigia. Da terça 01/09 até 08/09 (terça) = 5 dias úteis.
  const r = tick({ status: "oc56_lancada", updated_at: TER }, "2026-09-08T12:00:00-03:00");
  assertEquals(r.acao, "alertar_parado");
  assertStringIncludes(r.motivo, "oc56_lancada");
});

Deno.test("VIGIA não alerta antes do prazo", () => {
  const r = tick({ status: "aguardando_nfd", updated_at: TER }, SEX);
  assertEquals(r.acao, "nada");
  assertEquals(r.motivo, "com_movimento_recente");
});

Deno.test("VIGIA não repete o alerta todo dia (conta do ÚLTIMO alerta)", () => {
  // alertado na quinta: 3 dias úteis depois ainda não realerta.
  const r = tick(
    { status: "aguardando_nfd", updated_at: TER, alerta_parado_em: QUI },
    "2026-09-08T12:00:00-03:00",
  );
  assertEquals(r.acao, "nada");
});

Deno.test("VIGIA sem marco de movimento não alerta (não inventa atraso)", () => {
  const r = tick({ status: "aguardando_nfd", updated_at: null, alerta_parado_em: null }, SEG);
  assertEquals(r.acao, "nada");
  assertEquals(r.motivo, "sem_marco_de_movimento");
});

Deno.test("o ramo de cobrança e o do vigia NÃO se cruzam", () => {
  // aguardando_cte parado há muito: cobra/escalona, nunca "alertar_parado".
  const r = tick({ status: "aguardando_cte", updated_at: TER }, "2026-09-30T12:00:00-03:00");
  assertEquals(r.acao === "alertar_parado", false);
});

// --- o texto do lembrete ----------------------------------------------------

Deno.test("lembrete cita NF e CTRC e não vaza undefined", () => {
  const { subject, texto } = montarLembreteCte({ nf: "239883", ctrc: "SSP912725-9" });
  assertStringIncludes(subject, "239883");
  assertStringIncludes(texto, "239883");
  assertStringIncludes(texto, "SSP912725-9");
  assertEquals(texto.includes("undefined"), false);
});
