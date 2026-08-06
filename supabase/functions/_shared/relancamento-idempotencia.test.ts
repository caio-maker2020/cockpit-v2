// Guard de não-regressão — decisão de idempotência do envelope lancarSswPortal.
// Rodar: deno test supabase/functions/_shared/relancamento-idempotencia.test.ts
//
// Bug âncora NF 236391 (Caio 2026-08-06): oc=54 lançada com sucesso; depois
// entrou oc=21 externa (reentrega); revert ressuscitou o todo; a RE-APROVAÇÃO
// batia na linha sucesso=true do UNIQUE → idempotent_skip cego → "sucesso" sem
// chamar o SSW → guard de confirmação lia oc real=21≠54 → revert → ressuscita
// → loop eterno (2 ciclos em 1 minuto em produção).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidirIdempotenciaRelancamento,
  RELANCAMENTO_JANELA_SKIP_MS,
} from "./lancar-ssw-portal.ts";

const AGORA = Date.parse("2026-08-06T15:00:00Z");
const ANTIGO = new Date(AGORA - 2 * 60 * 60 * 1000).toISOString(); // 2h atrás
const RECENTE = new Date(AGORA - 60 * 1000).toISOString(); // 1min atrás

Deno.test("caso NF 236391: lançamento antigo + SSW mostra outra oc → RELANÇAR (mata o loop)", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: ANTIGO,
      agoraMs: AGORA,
      leituraOk: true,
      ocAtualSsw: 21,
      codigoSsw: 54,
    }),
    "relancar",
  );
});

Deno.test("duplo-clique / redelivery PGMQ (recente) → skip, mesmo com oc divergente", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: RECENTE,
      agoraMs: AGORA,
      leituraOk: true,
      ocAtualSsw: 21,
      codigoSsw: 54,
    }),
    "skip",
  );
});

Deno.test("oc pedida já é a última no SSW → skip (idempotência clássica)", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: ANTIGO,
      agoraMs: AGORA,
      leituraOk: true,
      ocAtualSsw: 54,
      codigoSsw: 54,
    }),
    "skip",
  );
});

Deno.test("leitura da verdade do SSW falhou → skip conservador (nunca duplicar às cegas)", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: ANTIGO,
      agoraMs: AGORA,
      leituraOk: false,
      ocAtualSsw: null,
      codigoSsw: 54,
    }),
    "skip",
  );
});

Deno.test("última oc do SSW sem código numérico (ex: 'CTRC EMITIDO PARA DEVOLUCAO') conta como divergente → relançar", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: ANTIGO,
      agoraMs: AGORA,
      leituraOk: true,
      ocAtualSsw: null,
      codigoSsw: 54,
    }),
    "relancar",
  );
});

Deno.test("finalizado_em nulo/inválido não conta como recente — decide pela verdade do SSW", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: null,
      agoraMs: AGORA,
      leituraOk: true,
      ocAtualSsw: 21,
      codigoSsw: 54,
    }),
    "relancar",
  );
});

Deno.test("borda da janela: exatamente no limite NÃO é recente", () => {
  assertEquals(
    decidirIdempotenciaRelancamento({
      finalizadoEm: new Date(AGORA - RELANCAMENTO_JANELA_SKIP_MS).toISOString(),
      agoraMs: AGORA,
      leituraOk: true,
      ocAtualSsw: 21,
      codigoSsw: 54,
    }),
    "relancar",
  );
});
