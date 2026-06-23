// Testes da função pura cardEmEscopoProtegido (invariante "não sai sozinho").
// Rodar: deno test supabase/functions/_shared/escopo-relacionamento.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cardEmEscopoProtegido,
  flagConflitoOcSemMover,
  STATES_PROTEGIDOS_CONFLITO,
} from "./escopo-relacionamento.ts";

// ---------------------------------------------------------------------------
// Mock mínimo do supabase pro guard de flagConflitoOcSemMover.
// Reproduz as cadeias fluentes usadas pela função:
//   acoes_executadas_ssw: .select().eq().eq().eq().limit().maybeSingle()
//   card_events (guard 2): .select().eq().eq().eq().limit().maybeSingle()
//   cards:                  .update().eq()
//   card_events (flag):     .insert()
// ---------------------------------------------------------------------------
type MockOpts = {
  /** data devolvido pelo maybeSingle de acoes_executadas_ssw (UNIQUE sucesso=true). */
  acoesSswData?: unknown;
  /** data devolvido pelo maybeSingle de card_events (AcaoExecutadaConfirmadaPeloSsw). */
  cardEventConfirmData?: unknown;
  /** cards.acao_executada_em — não-nulo = ciclo ATIVO do lançamento (gate da supressão). */
  acaoExecutadaEm?: string | null;
};

function makeMockSupabase(opts: MockOpts) {
  const calls = { cardsUpdated: false, eventsInserted: [] as unknown[] };
  // deno-lint-ignore no-explicit-any
  const selectChain = (data: unknown): any => {
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data, error: null }),
    };
    return chain;
  };
  // deno-lint-ignore no-explicit-any
  const supabase: any = {
    from: (table: string) => {
      if (table === "acoes_executadas_ssw") return selectChain(opts.acoesSswData ?? null);
      if (table === "card_events") {
        return {
          select: () => selectChain(opts.cardEventConfirmData ?? null),
          insert: (row: unknown) => {
            calls.eventsInserted.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "cards") {
        return {
          // gate de ciclo: guard lê cards.acao_executada_em
          select: () => selectChain({ acao_executada_em: opts.acaoExecutadaEm ?? null }),
          update: () => ({
            eq: () => {
              calls.cardsUpdated = true;
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`mock: tabela inesperada ${table}`);
    },
  };
  return { supabase, calls };
}

type FlagArgs = Parameters<typeof flagConflitoOcSemMover>[1];
const baseArgs: FlagArgs = {
  cardId: "card-376924",
  deState: "AGUARDANDO_CLIENTE",
  deOc: 54,
  paraOc: 33,
  origemPass: "B_found",
  mudancaAtual: null,
};

Deno.test("AGUARDANDO_VALIDACAO_HUMANA (AGUARDANDO VOCÊ) → protegido", () => {
  assertEquals(cardEmEscopoProtegido("AGUARDANDO_VALIDACAO_HUMANA"), true);
});

Deno.test("AGUARDANDO_CLIENTE (oc=54) → protegido", () => {
  assertEquals(cardEmEscopoProtegido("AGUARDANDO_CLIENTE"), true);
});

Deno.test("AGUARDANDO_AGENTE (PARA FAZER) → NÃO protegido (sai natural)", () => {
  assertEquals(cardEmEscopoProtegido("AGUARDANDO_AGENTE"), false);
});

Deno.test("estados terminais/transientes/null → NÃO protegido", () => {
  assertEquals(cardEmEscopoProtegido("TRANSFERIDO"), false);
  assertEquals(cardEmEscopoProtegido("RESOLVIDO"), false);
  assertEquals(cardEmEscopoProtegido("ACAO_EXECUTADA"), false);
  assertEquals(cardEmEscopoProtegido("EXTRAVIO_MONITORADO"), false);
  assertEquals(cardEmEscopoProtegido(null), false);
  assertEquals(cardEmEscopoProtegido(undefined), false);
});

Deno.test("escopo protegido tem exatamente 2 estados (AGUARDANDO_AGENTE fora)", () => {
  assertEquals(STATES_PROTEGIDOS_CONFLITO.size, 2);
  assertEquals(STATES_PROTEGIDOS_CONFLITO.has("AGUARDANDO_AGENTE"), false);
});

// ---------------------------------------------------------------------------
// Guard INV-014 "não flaggar oc que o próprio Cockpit lançou" (Caio 2026-06-22;
// corrigido na RAIZ 2026-06-23). Roda os 2 sinais (acoes_executadas_ssw +
// AcaoExecutadaConfirmadaPeloSsw) SEMPRE — SEM gate de ciclo. `acao_executada_em`
// NÃO é mais lido pela função: era o furo — zerado na confirmação do Bastão, então
// re-flaggava em massa cards já confirmados/descansando.
// Âncoras do bug: NF 359849(44)/1017149(21)/3057294(56)/377696(21).
// ---------------------------------------------------------------------------
const CICLO_ATIVO = "2026-06-23T12:00:00Z"; // legado: a função não lê mais este campo

Deno.test("ciclo ATIVO + acoes_executadas_ssw → skipped_cockpit_lancou", async () => {
  const { supabase, calls } = makeMockSupabase({
    acaoExecutadaEm: CICLO_ATIVO,
    acoesSswData: { id: "acao-1" },
  });
  const r = await flagConflitoOcSemMover(supabase, baseArgs);
  assertEquals(r, "skipped_cockpit_lancou");
  assertEquals(calls.cardsUpdated, false); // não flaggou
  assertEquals(calls.eventsInserted.length, 0);
});

Deno.test("ciclo ATIVO + AcaoExecutadaConfirmadaPeloSsw (path-independent) → skipped_cockpit_lancou", async () => {
  // oc=33 lançada por caminho que (historicamente) pulava o envelope: acoes_
  // executadas_ssw VAZIO, mas card_events tem a confirmação do SSW.
  const { supabase, calls } = makeMockSupabase({
    acaoExecutadaEm: CICLO_ATIVO,
    acoesSswData: null,
    cardEventConfirmData: { id: "evt-confirm-33" },
  });
  const r = await flagConflitoOcSemMover(supabase, baseArgs);
  assertEquals(r, "skipped_cockpit_lancou");
  assertEquals(calls.cardsUpdated, false);
});

Deno.test("REGRESSÃO INV-014: card confirmado/descansando (acao_executada_em NULL) + oc lançada pelo Cockpit → skipped_cockpit_lancou (NUNCA vai pra CONFLITOS)", async () => {
  // ESTE era o bug (Caio 2026-06-23, NF 359849/44): o gate de ciclo desligava o
  // guard assim que o Bastão confirmava e zerava acao_executada_em → o card já
  // lançado por dentro (acoes_executadas_ssw + confirmação SSW) era re-flagado em
  // massa na aba CONFLITOS. Agora o guard roda SEMPRE → suprime independente do
  // ciclo. Regra inviolável do Caio: "ali não pode aparecer conflitos que vêm de
  // ocorrências que lançamos por dentro".
  const { supabase, calls } = makeMockSupabase({
    acaoExecutadaEm: null, // card já confirmado pelo Bastão / descansando (era o furo)
    acoesSswData: { id: "acao-44" },
    cardEventConfirmData: { id: "evt-confirm-44" },
  });
  const r = await flagConflitoOcSemMover(supabase, baseArgs);
  assertEquals(r, "skipped_cockpit_lancou");
  assertEquals(calls.cardsUpdated, false); // NÃO flaggou
  assertEquals(calls.eventsInserted.length, 0);
});

Deno.test("conflito REAL: nenhum registro de lançamento Cockpit → flagged", async () => {
  // oc lançada POR FORA (operação) — sem acoes_executadas_ssw nem confirmação SSW.
  const { supabase, calls } = makeMockSupabase({
    acaoExecutadaEm: CICLO_ATIVO,
    acoesSswData: null,
    cardEventConfirmData: null,
  });
  const r = await flagConflitoOcSemMover(supabase, baseArgs);
  assertEquals(r, "flagged");
  assertEquals(calls.cardsUpdated, true);
  assertEquals(calls.eventsInserted.length, 1);
});

Deno.test("idempotente: já flaggado pra mesma para_oc (vista_em null) → skipped_idempotente", async () => {
  const { supabase, calls } = makeMockSupabase({
    acaoExecutadaEm: null,
    acoesSswData: null,
    cardEventConfirmData: null,
  });
  const r = await flagConflitoOcSemMover(supabase, {
    ...baseArgs,
    mudancaAtual: { tipo: "saiu_de_escopo", para_oc: 33, vista_em: null },
  });
  assertEquals(r, "skipped_idempotente");
  assertEquals(calls.cardsUpdated, false); // não regrava
});
