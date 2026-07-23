// =============================================================================
// sugerir-cobranca-ai — gera texto IA de cobrança escalonada (preview no modal)
//
// Caio 2026-05-19 (PRIORIDADES AI):
// Operador clica botão "Cobrar X" → modal abre → este endpoint gera texto
// + assunto via Sonnet 4.6 → operador revisa/edita → submete via
// `disparar-cobranca-escalonada` (que pode chamar este de novo se texto_final ausente).
//
// Input:  { card_id, papel, canal }
// Output: { ok, assunto, texto, rationale, dias_uteis_parados, contato_nome,
//           contato_destino, oc_origem }
//
// NÃO envia nada. Só gera + retorna pro front. Stateless (sem cache aqui).
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  gerarTextoCobrancaEscalonada,
  type Papel,
  type Canal,
} from "../_shared/gerar-texto-cobranca-escalonada.ts";
import { salvarSugestaoTexto } from "../_shared/sugestao-texto-registro.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface InputBody {
  card_id?: string;
  papel?: Papel;
  canal?: Canal;
}

function humanizarPapel(p: Papel): string {
  if (p === "gerente_base") return "Gerente da Base";
  if (p === "coordenador_entrega") return "Coordenador de Entrega";
  return "Gerente de Relacionamento";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST esperado" }, 405);

  try {
    const env = Deno.env.toObject();
    const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = (await req.json().catch(() => null)) as InputBody | null;
    if (!body?.card_id || !body?.papel || !body?.canal) {
      return json({ ok: false, error: "card_id, papel, canal obrigatórios" }, 400);
    }
    if (!["gerente_base", "coordenador_entrega", "gerente_relacionamento"].includes(body.papel)) {
      return json({ ok: false, error: "papel inválido" }, 400);
    }
    if (!["email", "whatsapp"].includes(body.canal)) {
      return json({ ok: false, error: "canal inválido" }, 400);
    }

    // Carrega card via v_prioridades_ai (oc=13/21 ativa). Se não estiver
    // (ex.: oc=54 lançada e card saiu da view), faz fallback pra `cards`
    // direto pra suportar disparo manual de cobrança via INBOX.
    const { data: prioRow } = await supabase
      .from("v_prioridades_ai")
      .select("*")
      .eq("card_id", body.card_id)
      .maybeSingle();

    type PrioShape = {
      oc_origem?: number;
      nf?: string;
      ctrc?: string | null;
      empresa_cliente?: string | null;
      base?: string | null;
      base_destino?: string | null;
      dias_uteis_parados?: number | null;
    };

    let prio: PrioShape | null = prioRow as PrioShape | null;

    if (!prio) {
      const { data: cardRow } = await supabase
        .from("cards")
        .select("nf, ctrc, empresa_cliente, base_destino")
        .eq("id", body.card_id)
        .maybeSingle();
      const row = cardRow as {
        nf: string; ctrc: string | null; empresa_cliente: string | null;
        base_destino: string | null;
      } | null;
      if (!row) {
        return json({ ok: false, error: "card_nao_encontrado", card_id: body.card_id }, 404);
      }
      prio = {
        oc_origem: 21, // só pra direcionar prompt — não é persistido
        nf: row.nf,
        ctrc: row.ctrc,
        empresa_cliente: row.empresa_cliente,
        base: row.base_destino,
        base_destino: row.base_destino,
        dias_uteis_parados: null,
      };
    }

    const ocOrigem = (prio.oc_origem ?? 21) as 13 | 21;
    if (ocOrigem !== 13 && ocOrigem !== 21) {
      return json({ ok: false, error: `oc_origem inesperada: ${ocOrigem}` }, 400);
    }

    // Lookup contato pra captar nome destinatário.
    // Quando base é null/undefined, restringe ao subconjunto global —
    // `.or('base.eq.,base.is.null')` é rejeitado pelo PostgREST com 400 e
    // quebrava a função silenciosamente (textarea em branco).
    const rawBaseSug = prio.base ?? prio.base_destino ?? null;
    const baseSug = rawBaseSug ? rawBaseSug.trim().toUpperCase() : null;
    const queryContatos = supabase
      .from("contatos_escalonamento")
      .select("nome, telefone, email, base")
      .eq("cargo", body.papel)
      .eq("ativo", true);
    const { data: contatos } = baseSug
      ? await queryContatos.or(`base.ilike.${baseSug},base.is.null`)
      : await queryContatos.is("base", null);

    const contato = (contatos ?? []).sort((a, b) => {
      const aGlobal = a.base == null ? 1 : 0;
      const bGlobal = b.base == null ? 1 : 0;
      return aGlobal - bGlobal; // match exato primeiro
    })[0] ?? null;

    const contatoDestino = body.canal === "email"
      ? (contato?.email ?? null)
      : (contato?.telefone ?? null);

    // Histórico de cobranças anteriores neste card
    const { data: cobAnt } = await supabase
      .from("cobrancas_disparadas")
      .select("papel, canal, disparado_em, contato_nome")
      .eq("card_id", body.card_id)
      .order("disparado_em", { ascending: true });

    // Resolve nome operador autenticado (pra assinatura)
    const auth = req.headers.get("Authorization") ?? "";
    const userJwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let operadorNome = "Operador";
    if (userJwt) {
      const supabaseAuth = createClient(env["SUPABASE_URL"]!, env["SUPABASE_ANON_KEY"]!, {
        global: { headers: { Authorization: auth } },
      });
      const { data: u } = await supabaseAuth.auth.getUser(userJwt);
      if (u?.user) {
        const { data: op } = await supabase
          .from("operadores")
          .select("nome")
          .eq("user_id", u.user.id)
          .maybeSingle();
        operadorNome = (op as { nome?: string } | null)?.nome ?? "Operador";
      }
    }

    const out = await gerarTextoCobrancaEscalonada(env, {
      papel: body.papel,
      canal: body.canal,
      oc_origem: ocOrigem,
      nf: prio.nf ?? "",
      ctrc: prio.ctrc ?? null,
      base: baseSug,
      empresa_cliente: prio.empresa_cliente ?? null,
      dias_uteis_parados: Number(prio.dias_uteis_parados ?? 0),
      contato_destinatario_nome: contato?.nome ?? null,
      contato_destinatario_cargo_humanizado: humanizarPapel(body.papel),
      operador_nome: operadorNome,
      cobrancas_anteriores: (cobAnt ?? []).map((c) => ({
        papel: c.papel as Papel,
        canal: c.canal as Canal,
        disparado_em: c.disparado_em as string,
        contato_nome: (c.contato_nome ?? null) as string | null,
      })),
    });

    // F5 Loop de Aprendizado: persiste a sugestão (best-effort — nunca
    // bloqueia a resposta). Comparação: cobrancas_disparadas.texto_enviado.
    await salvarSugestaoTexto(supabase, {
      cardId: body.card_id,
      tipo: "cobranca",
      texto: out.texto,
      assunto: out.assunto,
      papel: body.papel,
      canal: body.canal,
      modelo: out.modelo ?? null,
    });

    return json({
      ok: true,
      assunto: out.assunto,
      texto: out.texto,
      rationale: out.rationale,
      dias_uteis_parados: prio.dias_uteis_parados ?? null,
      contato_nome: contato?.nome ?? null,
      contato_destino: contatoDestino,
      oc_origem: ocOrigem,
      papel: body.papel,
      canal: body.canal,
      modelo: out.modelo,
    }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("sugerir-cobranca-ai fatal:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
