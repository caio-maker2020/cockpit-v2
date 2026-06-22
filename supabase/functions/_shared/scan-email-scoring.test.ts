// Testes do scoring do scan de e-mail pré-existente.
// Rodar: deno test supabase/functions/_shared/scan-email-scoring.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assuntoContemNf,
  type CandidatoEmail,
  dominioVincula,
  normalizarNf,
  pontuarCandidato,
  selecionarSugestoes,
  slugDominio,
  slugNome,
  type VinculoCliente,
} from "./scan-email-scoring.ts";

const CARD_CREATED = "2026-06-16T12:00:00Z"; // card nasceu depois da thread

Deno.test("normalizarNf tira zeros à esquerda e não-dígitos", () => {
  assertEquals(normalizarNf("0030459"), "30459");
  assertEquals(normalizarNf("114668"), "114668");
  assertEquals(normalizarNf("1/30459"), "130459");
  assertEquals(normalizarNf(null), "");
});

Deno.test("assuntoContemNf casa NF mesmo com separadores", () => {
  assert(assuntoContemNf("DMDC // NFs: 30459 e 30460 _ HIPER CARIJOS", "30459"));
  assert(assuntoContemNf("Atraso 114668,114714", "114668"));
  assert(assuntoContemNf("nota 030459 pendente", "30459"));
  // não casa número diferente que contém a NF como substring
  assertEquals(assuntoContemNf("pedido 130459", "30459"), false);
  assertEquals(assuntoContemNf("Verificação de atraso", "30459"), false);
});

Deno.test("slug helpers", () => {
  assertEquals(slugNome("ALFAPARF MILANO LTDA"), "alfaparfmilano");
  assertEquals(slugDominio("alfaparfdbdc.com.br"), "alfaparfdbdc");
  assertEquals(slugDominio("dismatal.com.br"), "dismatal");
});

Deno.test("dominioVincula: exato e por slug do nome", () => {
  const vinc: VinculoCliente = {
    dominios: new Set(["dismatal.com.br"]),
    nomeSlugs: [slugNome("ALFAPARF MILANO")], // "alfaparfmilano"
  };
  // exato
  assert(dominioVincula("dismatal.com.br", vinc));
  // por slug: domínio "alfaparfdbdc" contém "alfaparf"... mas slug é "alfaparfmilano"
  // -> nenhum é substring do outro. Testa o caso de slug curto que casa:
  const vinc2: VinculoCliente = { dominios: new Set(), nomeSlugs: ["alfaparf"] };
  assert(dominioVincula("alfaparfdbdc.com.br", vinc2)); // base "alfaparfdbdc" inclui "alfaparf"
  // não vincula domínio de terceiro
  assertEquals(dominioVincula("gmail.com", vinc2), false);
  assertEquals(dominioVincula("outraempresa.com.br", vinc), false);
});

Deno.test("caso ALFAPARF (NF 30459): cliente abriu thread antes do card → passa", () => {
  const cand: CandidatoEmail = {
    gmail_thread_id: "t-alfaparf",
    assunto: "DMDC // NFs: 30459 e 30460 _ HIPER CARIJOS LTDA - 40 // Verificação de atraso",
    participantes_dominios: ["alfaparfdbdc.com.br"], // embarcador da carga
    iniciada_em: "2026-06-15T10:58:00Z",
    qtd_mensagens: 6,
    tem_sent_operador: true,
  };
  // vínculo via slug do REMETENTE do card (embarcador ALFAPARF)
  const vinc: VinculoCliente = { dominios: new Set(), nomeSlugs: ["alfaparf"] };
  const r = pontuarCandidato(cand, "30459", vinc, CARD_CREATED);
  assert(r.passou);
  assert(r.nf_no_assunto);
  // 50 (assunto) + 15 (antes) + 5 (slug) + 10 (sent) = 80
  assertEquals(r.score, 80);
});

Deno.test("caso OVD/Dismatal (NF 114668): cliente aparece no meio da thread → passa", () => {
  const cand: CandidatoEmail = {
    gmail_thread_id: "t-ovd",
    assunto: "Atraso 114668,114714",
    // base OVD + cliente Dismatal (apareceu como To no meio); operador já excluído
    participantes_dominios: ["ovd.com.br", "dismatal.com.br"],
    iniciada_em: "2026-06-22T11:34:00Z",
    qtd_mensagens: 6,
    tem_sent_operador: true,
  };
  // vínculo via destinatário/pagador do card (DISMATAL); OVD é base, não vincula
  const vinc: VinculoCliente = {
    dominios: new Set(["dismatal.com.br"]),
    nomeSlugs: [slugNome("DISMATAL")],
  };
  const r = pontuarCandidato(cand, "114668", vinc, "2026-06-22T13:00:00Z");
  assert(r.passou);
  assert(r.nf_no_assunto);
  // 50 + 15 (antes) + 10 (exato) + 10 (sent) = 85
  assertEquals(r.score, 85);
});

Deno.test("controle: MESMA NF mas cliente DIFERENTE → descarta (sem vínculo)", () => {
  const cand: CandidatoEmail = {
    gmail_thread_id: "t-outro",
    assunto: "NF 30459 - cobrança",
    participantes_dominios: ["empresaqualquer.com.br"], // não é parte do card
    iniciada_em: "2026-06-10T10:00:00Z",
    qtd_mensagens: 2,
    tem_sent_operador: false,
  };
  const vinc: VinculoCliente = { dominios: new Set(), nomeSlugs: ["alfaparf"] };
  const r = pontuarCandidato(cand, "30459", vinc, CARD_CREATED);
  assertEquals(r.passou, false);
  assertEquals(r.vinculo_ok, false);
  assertEquals(r.motivo_descartado, "sem_vinculo_cliente");
});

Deno.test("NF só no corpo (assunto genérico) mas com vínculo → passa, score menor", () => {
  const cand: CandidatoEmail = {
    gmail_thread_id: "t-corpo",
    assunto: "Verificação de atraso", // sem NF no assunto
    participantes_dominios: ["dismatal.com.br"],
    iniciada_em: "2026-06-15T10:00:00Z",
    qtd_mensagens: 3,
    tem_sent_operador: false,
  };
  const vinc: VinculoCliente = { dominios: new Set(["dismatal.com.br"]), nomeSlugs: [] };
  const r = pontuarCandidato(cand, "114668", vinc, CARD_CREATED);
  assert(r.passou);
  assertEquals(r.nf_no_assunto, false);
  // 25 (corpo) + 15 (antes) + 10 (exato) = 50
  assertEquals(r.score, 50);
});

Deno.test("selecionarSugestoes ordena por score e corta no topo", () => {
  const mk = (id: string, passou: boolean, score: number) => ({
    cand: {
      gmail_thread_id: id,
      assunto: "",
      participantes_dominios: [],
      iniciada_em: null,
      qtd_mensagens: 1,
      tem_sent_operador: false,
    } as CandidatoEmail,
    score: { passou, score, nf_no_assunto: false, vinculo_ok: passou },
  });
  const sel = selecionarSugestoes([mk("a", true, 50), mk("b", false, 99), mk("c", true, 80)], 3);
  assertEquals(sel.map((s) => s.cand.gmail_thread_id), ["c", "a"]); // b descartado
});
