// =============================================================================
// criar-card-manual — criação MANUAL de card pelo operador, na hora, para uma
// NF que ainda NÃO venceu prazo (logo, ainda não apareceu no Bastão).
// Caio 2026-06-26. Ver plano e CLAUDE.md (regra de ouro do CTRC + INV-028).
//
// Gatilho: operador clica "Criar Card" no Lovable, informa NF + pagador (da
// carteira dele). O agente entra no SSW opção 101, busca a NF linkando com o
// pagador, lê a última ocorrência e CRIA o card 100% no fluxo normal — SE a
// última oc for de RELACIONAMENTO. Senão devolve mensagem clara e NÃO cria.
//
// Regras (todas server-side, não confiar no front):
//   1. Operador só cria pra CNPJ da própria carteira (gestor = qualquer um).
//   2. Não cria card duplicado (uniq_cards_nf_active + checagem prévia).
//   3. 2 CTRCs não-finalizados/não-complementares (NORMAL + REVERSA) → pede
//      pro operador escolher devolução vs normal (fluxo de 2 chamadas).
//   4. Última oc não-relacionamento → "NÃO FOI POSSÍVEL CRIAR POIS A ÚLTIMA
//      OCORRÊNCIA NÃO É RELACIONAMENTO".
//
// Reconciliação Bastão (INV-028): o card nasce com agent_state.origem="manual"
// (NÃO "email_ssw") e SEM carimbar bastao_*_no_lancamento — então flui pelo
// caminho NORMAL do sync-bastao nos próximos ciclos (49→AGUARDANDO VOCÊ,
// 41→CONFLITOS, resposta→CLIENTE RESPONDEU). uniq_cards_nf_active garante que o
// Bastão ATUALIZA em vez de duplicar.
//
// Auth: Bearer JWT do operador (verify_jwt=true, default — NÃO entra no
// config.toml). Reusa helpers já testados; só o GATILHO e as regras são novos.
// =============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bloquearSeModoVisualizacao } from "../_shared/trava-visualizacao.ts";
import { normalizeNf } from "../_shared/extravio-enrichment.ts";
import {
  buscarNFInterno,
  type CtrcRow,
  limparSessaoCache,
  listarCTRCsDaNF,
  listarOcorrenciasNF,
  loginInternoSSW,
  readSswInternalEnv,
  type SswOcorrencia,
  type SswSessao,
} from "../_shared/ssw-internal-client.ts";
import {
  type CtrcCandidatoManual,
  escolherCtrcManual,
} from "../_shared/escolher-ctrc-manual.ts";
import {
  isOcorrenciaDeRelacionamentoCtx,
  OCS_FINALIZADORAS,
} from "../_shared/bastao-rules.ts";
import { decidirGateCriacaoManual } from "../_shared/gate-criacao-card-manual.ts";
import { resolverCamposAtribuicaoDoCard } from "../_shared/operador-resolver.ts";
import { verificarEvidenciaESinalizar } from "../_shared/verificar-evidencia.ts";
import { proporAutoAcaoSeAplicavel } from "../_shared/regras-auto-acao.ts";
import { enfileirarScanEmailPreCard } from "../_shared/scan-email-enqueue.ts";

const MSG_NAO_RELACIONAMENTO =
  "NÃO FOI POSSÍVEL CRIAR POIS A ÚLTIMA OCORRÊNCIA NÃO É RELACIONAMENTO";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/** Normaliza nome p/ comparação: maiúsc, sem acento, espaços colapsados. */
function normNome(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

/** Mesmo pagador? Tolera truncamento do SSW (um é prefixo do outro). */
function mesmoNome(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normNome(a), nb = normNome(b);
  if (!na || !nb) return false;
  const ca = na.replace(/\s*\([A-Z]\.?\)\s*$/, "").trim();
  const cb = nb.replace(/\s*\([A-Z]\.?\)\s*$/, "").trim();
  return ca === cb || ca.startsWith(cb) || cb.startsWith(ca);
}

/** Só dígitos — pra comparar CNPJ da carteira com o do typeahead. */
function soDigitos(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Carrega CNPJs onde oc=13 vira relacionamento (espelha sync-bastao). */
async function loadExcecoesOc13(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<ReadonlySet<string>> {
  try {
    const { data, error } = await supabase
      .from("cliente_config_oc13")
      .select("cnpj_pagador")
      .eq("ativo", true);
    if (error || !data) return new Set<string>();
    const set = new Set<string>();
    for (const r of data as Array<{ cnpj_pagador: string }>) {
      if (r.cnpj_pagador) set.add(r.cnpj_pagador);
    }
    return set;
  } catch {
    return new Set<string>();
  }
}

/**
 * Roda o scan de e-mail pré-existente SÍNCRONO pra um card recém-criado,
 * chamando o caminho `scan_card_id` da edge scan-email-pre-card (que executa
 * processarScanJob inline, IGNORA o flag global + a fila e grava
 * cards.email_preexistente_sugerido). Timeout curto: se o Gmail demorar, aborta
 * e o caller cai pro enqueue assíncrono. scan-email-pre-card é verify_jwt=false
 * → aceita o service_role bearer.
 */
async function scanEmailSincrono(
  supabaseUrl: string,
  serviceRoleKey: string,
  cardId: string,
): Promise<{ encontrou: boolean; candidatos: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/scan-email-pre-card`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ scan_card_id: cardId, contexto: "nascimento" }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`scan-email-pre-card HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as {
      resultado?: { resultado?: string; candidatos_total?: number };
    };
    const r = data.resultado ?? {};
    return { encontrou: r.resultado === "sugerido", candidatos: r.candidatos_total ?? 0 };
  } finally {
    clearTimeout(t);
  }
}

/** Última oc (SswOcorrencia) de um CTRC específico, usando a sessão aberta. */
async function ultimaOcDoCtrc(
  sessao: SswSessao,
  nf: string,
  ctrc: string,
): Promise<SswOcorrencia | null> {
  const detalhe = await buscarNFInterno(sessao, nf, { ctrcEsperado: ctrc });
  const ocs = await listarOcorrenciasNF(sessao, detalhe);
  return ocs.find((o) => o.codigo != null) ?? null;
}

serve(async (req) => {
  // Trava modo visualização (mig 324): gestor só-leitura (João/Isadora) não
  // executa; service_role e preflight passam direto (sem Authorization → null).
  {
    const travaAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const bloqueio = await bloquearSeModoVisualizacao(req, travaAdmin, corsHeaders);
    if (bloqueio) return bloqueio;
  }
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // IMPORTANTE (Caio 2026-06-26): TODA resposta tratada é HTTP 200 com
  // {ok:false, resultado, mensagem}. Motivo: supabase.functions.invoke() DESCARTA
  // o corpo e mostra o genérico "Edge Function returned a non-2xx status code"
  // sempre que a função responde com status ≥ 300 — escondendo a mensagem clara.
  // Com 200, o front sempre recebe `data.mensagem` e exibe o motivo real em
  // português. Só um crash inesperado (fora do try/catch) ou o 401 do GATEWAY
  // (quando o front nem manda Authorization) escapam disso — o front trata via
  // error.context (ver prompt do Lovable).
  if (req.method !== "POST") {
    return jsonResp({ ok: false, resultado: "erro", mensagem: "Método inválido (use POST)." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResp({ ok: false, resultado: "erro", mensagem: "Configuração do servidor incompleta. Avise o time técnico." });
  }

  // --- Auth do operador (Bearer JWT) ---
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResp({ ok: false, resultado: "sessao_invalida", mensagem: "Sua sessão não foi reconhecida. Saia e entre de novo no Cockpit e tente outra vez." });
  }
  const userJwt = authHeader.slice(7);
  const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabaseAuth.auth.getUser(userJwt);
  if (userErr || !userData?.user) {
    return jsonResp({ ok: false, resultado: "sessao_invalida", mensagem: "Sua sessão expirou ou não foi reconhecida. Saia e entre de novo no Cockpit e tente outra vez." });
  }
  const userId = userData.user.id;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve operador (id, nome, papel, carteira) pelo user_id.
  const { data: opRow } = await supabase
    .from("operadores")
    .select("id, nome, papel, carteira, ssw_secret_prefix")
    .eq("user_id", userId)
    .maybeSingle();
  const operador = opRow as
    | { id: string; nome: string; papel: string | null; carteira: string[] | null; ssw_secret_prefix: string | null }
    | null;
  if (!operador?.id) {
    return jsonResp({ ok: false, resultado: "erro", mensagem: "Seu usuário não está cadastrado como operador no Cockpit. Avise o gestor." });
  }

  // --- Body ---
  let body: { nf?: string; cnpj_pagador?: string; pagador_nome?: string; ctrc_escolhido?: string; motivo_fora_padrao?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResp({ ok: false, resultado: "erro", mensagem: "Não recebi os dados do formulário. Tente de novo." });
  }
  const nf = normalizeNf(body.nf);
  const cnpjPagador = soDigitos(body.cnpj_pagador);
  const pagadorNome = (body.pagador_nome ?? "").trim() || null;
  const ctrcEscolhido = (body.ctrc_escolhido ?? "").trim().toUpperCase() || null;
  // Justificativa quando a última oc está fora do escopo de relacionamento
  // (Duílio 2026-07-27, NF 22232). Só destrava a criação COM motivo explícito.
  const motivoForaPadrao = (body.motivo_fora_padrao ?? "").trim() || null;

  if (!nf) return jsonResp({ ok: false, resultado: "erro", mensagem: "Informe o número da NF." });
  if (!cnpjPagador) return jsonResp({ ok: false, resultado: "erro", mensagem: "Selecione o pagador (cliente) da lista." });

  try {
    // --- 1. Autorização de carteira (RLS não vale no service-role) ---
    const ehGestor = (operador.papel ?? "").toLowerCase() === "gestor";
    const carteiraDigitos = new Set((operador.carteira ?? []).map((c) => soDigitos(c)));
    if (!ehGestor && !carteiraDigitos.has(cnpjPagador)) {
      return jsonResp({
        ok: false,
        resultado: "fora_carteira",
        mensagem: `O cliente ${pagadorNome ?? "selecionado"} não está na sua carteira — você só pode criar card para clientes da sua carteira. Se precisar, peça ao gestor para incluí-lo.`,
      });
    }

    // --- 2. Dedup: card ativo já existe pra essa NF? ---
    const { data: cardExistente } = await supabase
      .from("cards")
      .select("id, state")
      .eq("nf", nf)
      .not("state", "in", "(RESOLVIDO,CANCELADO)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cardExistente) {
      return jsonResp({
        ok: false,
        resultado: "card_ja_existe",
        card_id: (cardExistente as { id: string }).id,
        mensagem: `Já existe um card ativo para a NF ${nf}. Abra o card existente em vez de criar outro.`,
      });
    }

    // --- 3. SSW opção 101: login + lista CTRCs da NF ---
    let sessao: SswSessao;
    try {
      const sswEnv = readSswInternalEnv(Deno.env.toObject(), operador.ssw_secret_prefix ?? operador.nome);
      sessao = await loginInternoSSW(sswEnv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResp({
        ok: false,
        resultado: "ssw_indisponivel",
        mensagem: "Não consegui acessar o SSW agora para buscar a NF. Tente de novo em alguns instantes.",
        detalhe: msg,
      });
    }

    let ctrcs: CtrcRow[];
    try {
      ctrcs = await listarCTRCsDaNF(sessao, nf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResp({ ok: false, resultado: "nf_nao_encontrada", mensagem: `A NF ${nf} não foi encontrada no SSW. Confira o número da NF e o pagador.`, detalhe: msg });
    }

    // --- 4. Filtra cancelados + narrow por pagador (só quando há ambiguidade) ---
    let ativos = ctrcs.filter((c) => !c.cancelado);
    if (ativos.length === 0) {
      return jsonResp({
        ok: false,
        resultado: "sem_ctrc_ativo",
        mensagem: `A NF ${nf} não tem nenhum CTRC ativo no SSW (pode estar toda cancelada).`,
      });
    }
    if (ativos.length > 1 && pagadorNome) {
      const filtrados = ativos.filter((c) => c.pagador && mesmoNome(c.pagador, pagadorNome));
      if (filtrados.length > 0) ativos = filtrados;
    }

    // --- 5. Lê a última oc de cada candidato (define finalizado) ---
    const ocPorCtrc = new Map<string, SswOcorrencia | null>();
    const candidatos: CtrcCandidatoManual[] = [];
    for (const c of ativos) {
      let ultima: SswOcorrencia | null = null;
      try {
        ultima = await ultimaOcDoCtrc(sessao, nf, c.ctrc);
      } catch {
        // Não consegui ler a situação desse CTRC — exclui do conjunto (não chuta).
        continue;
      }
      ocPorCtrc.set(c.ctrc, ultima);
      candidatos.push({
        ctrc: c.ctrc,
        tipo: c.tipo,
        pagador: c.pagador || null,
        cancelado: false,
        finalizado: ultima?.codigo != null && OCS_FINALIZADORAS.has(ultima.codigo),
      });
    }
    if (candidatos.length === 0) {
      return jsonResp({
        ok: false,
        resultado: "ssw_indisponivel",
        mensagem: `Encontrei a NF ${nf} no SSW, mas não consegui ler a situação (última ocorrência) agora. Tente de novo em alguns instantes.`,
      });
    }

    // --- 6. Decide o CTRC ---
    const escolha = escolherCtrcManual(candidatos);

    let candidatoFinal: CtrcCandidatoManual | null = null;
    let escolhidoPeloOperador = false;
    if (escolha.tipo === "sem_ctrc_ativo") {
      return jsonResp({
        ok: false,
        resultado: "sem_ctrc_ativo",
        mensagem: "Nenhum CTRC desta NF está em aberto para criar card.",
      });
    } else if (escolha.tipo === "ambiguo") {
      return jsonResp({
        ok: false,
        resultado: "ctrc_ambiguo",
        mensagem: `A NF ${nf} tem mais de um CTRC em aberto e não dá pra escolher com segurança automaticamente (${escolha.candidatos.map((c) => c.ctrc).join(", ")}). Confira no SSW e trate manualmente.`,
        detalhe: escolha.motivo,
        candidatos: escolha.candidatos.map((c) => ({ ctrc: c.ctrc, tipo: c.tipo })),
      });
    } else if (escolha.tipo === "escolher") {
      if (!ctrcEscolhido) {
        // 1ª chamada: pede a escolha (devolução vs normal).
        return jsonResp({
          ok: false,
          resultado: "escolher_ctrc",
          mensagem: "Esta NF tem CTRC normal e de devolução em aberto para o pagador. Escolha qual usar.",
          opcoes: escolha.opcoes.map((c) => ({
            ctrc: c.ctrc,
            tipo: c.tipo,
            rotulo: c.tipo.toUpperCase() === "REVERSA" ? "Devolução" : "Normal",
          })),
        });
      }
      // 2ª chamada: valida que a escolha está entre as opções elegíveis atuais.
      candidatoFinal = escolha.opcoes.find((c) => c.ctrc.toUpperCase() === ctrcEscolhido) ?? null;
      escolhidoPeloOperador = true;
      if (!candidatoFinal) {
        return jsonResp({
          ok: false,
          resultado: "escolher_ctrc",
          mensagem: "A situação dos CTRCs mudou. Escolha novamente.",
          opcoes: escolha.opcoes.map((c) => ({
            ctrc: c.ctrc,
            tipo: c.tipo,
            rotulo: c.tipo.toUpperCase() === "REVERSA" ? "Devolução" : "Normal",
          })),
        });
      }
    } else {
      // unico
      candidatoFinal = escolha.ctrc;
    }

    const ctrc = candidatoFinal!.ctrc;
    const ultimaOc = ocPorCtrc.get(ctrc) ?? null;
    const oc = ultimaOc?.codigo ?? null;

    // --- 7. Gate de relacionamento na última oc do CTRC escolhido ---
    // Duílio 2026-07-27 (NF 22232, opção 1 do Caio): oc fora de relacionamento
    // (ex.: 31 agendamento) pode criar card COM justificativa explícita do
    // operador. Sem motivo → mantém a recusa de sempre (front pede o motivo).
    const excecoesOc13 = await loadExcecoesOc13(supabase);
    const ocEhRelacionamento = isOcorrenciaDeRelacionamentoCtx(oc, { cnpjPagador, excecoesOc13 });
    const gate = decidirGateCriacaoManual(ocEhRelacionamento, motivoForaPadrao);
    if (!gate.permitido) {
      const ocTxt = oc == null
        ? "a NF não tem ocorrência registrada no SSW"
        : `a última ocorrência é a ${oc}${ultimaOc?.descricao ? ` - ${ultimaOc.descricao}` : ""}`;
      return jsonResp({
        ok: false,
        resultado: "ultima_oc_nao_relacionamento",
        oc,
        ctrc,
        // `pode_forcar_com_motivo` sinaliza ao front que dá pra criar mesmo
        // assim, desde que o operador justifique o lançamento fora do padrão.
        pode_forcar_com_motivo: true,
        // Mantém a frase exata pedida pelo Caio + o detalhe de qual oc é.
        mensagem: `${MSG_NAO_RELACIONAMENTO} (${ocTxt}).`,
      });
    }
    const criadoForaDePadrao = gate.foraDePadrao === true;
    const motivoForaPadraoFinal = gate.foraDePadrao ? gate.motivo : null;

    // --- 8. Atribuição pelo CNPJ do pagador (dono da carteira) ---
    const atribuicao = await resolverCamposAtribuicaoDoCard(supabase, {
      responsavelNome: operador.nome,
      cnpjPagador,
    });
    if (!atribuicao.assigned_operator_id) {
      return jsonResp({
        ok: false,
        resultado: "cliente_nao_atribuido",
        mensagem: `O cliente ${pagadorNome ?? cnpjPagador} não está atribuído a nenhum operador ativo (carteira de operador inativo ou cliente excluído do Cockpit). Peça ao gestor para incluí-lo na carteira de um operador ativo antes de criar o card.`,
        detalhe: atribuicao.via,
      });
    }

    // --- 9. agent_state manual (INV-028: origem="manual", sem bastao_*) ---
    const agora = new Date().toISOString();
    const ctrcRowFinal = ativos.find((c) => c.ctrc === ctrc);
    const agentState: Record<string, unknown> = {
      origem: "manual",
      criado_por_operador_id: operador.id,
      criado_via: "criar-card-manual",
      cod_ultima_ocorrencia: oc,
      instrucao_ultima_ocorrencia: ultimaOc?.descricao ?? null,
      data_ultima_ocorrencia: ultimaOc?.data ?? null,
      cnpj_pagador: cnpjPagador,
      cnpj_remetente: null,
      remetente: ctrcRowFinal?.remetente ?? null,
      destinatario: ctrcRowFinal?.destinatario ?? null,
      base_destino: null,
      ctrc_escolhido_pelo_operador: escolhidoPeloOperador,
      ctrcs_disponiveis: candidatos.map((c) => ({ ctrc: c.ctrc, tipo: c.tipo, finalizado: c.finalizado })),
      criado_em: agora,
      // Auditoria do lançamento fora de padrão (oc não-relacionamento + motivo).
      criado_fora_de_padrao: criadoForaDePadrao,
      motivo_fora_padrao: motivoForaPadraoFinal,
    };

    // --- 10. INSERT card (espelha o card novo do sync-bastao) ---
    let cardId: string;
    {
      const { data: ins, error: insErr } = await supabase
        .from("cards")
        .insert({
          nf,
          ctrc,
          canal_origem: "sistema",
          empresa_cliente: pagadorNome ?? ctrcRowFinal?.pagador ?? null,
          pagador: pagadorNome ?? ctrcRowFinal?.pagador ?? null,
          base_destino: null,
          responsavel_relacionamento: atribuicao.responsavel_relacionamento,
          state: "AGUARDANDO_VALIDACAO_HUMANA",
          lock_aguardando_validacao: true,
          tipo: null,
          risco: "baixo",
          assigned_agent: null,
          assigned_operator_id: atribuicao.assigned_operator_id,
          bastao_pendencia_id: null,
          cod_ultima_ocorrencia: oc,
          bastao_data_ultima_ocorrencia: null,
          bastao_synced_at: null,
          qtde_volumes: null,
          agent_state: agentState,
        })
        .select("id")
        .single();
      if (insErr) {
        // 23505 = corrida com sync-bastao/outra criação (uniq_cards_nf_active).
        if ((insErr as { code?: string }).code === "23505") {
          const { data: jaExiste } = await supabase
            .from("cards")
            .select("id")
            .eq("nf", nf)
            .not("state", "in", "(RESOLVIDO,CANCELADO)")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          return jsonResp({
            ok: false,
            resultado: "card_ja_existe",
            card_id: (jaExiste as { id?: string } | null)?.id ?? null,
            mensagem: `Já existe um card ativo para a NF ${nf}. Abra o card existente em vez de criar outro.`,
          });
        }
        return jsonResp({ ok: false, resultado: "erro", mensagem: "Não consegui salvar o card no sistema. Tente de novo; se continuar, avise o time técnico.", detalhe: insErr.message });
      }
      cardId = (ins as { id: string }).id;
    }

    // --- 11. card_events (event sourcing) ---
    await supabase.from("card_events").insert({
      card_id: cardId,
      event_type: "CardCriadoManualmente",
      actor_type: "human",
      actor_id: operador.id,
      payload: {
        nf,
        ctrc,
        oc,
        cnpj_pagador: cnpjPagador,
        ctrc_escolhido_pelo_operador: escolhidoPeloOperador,
        via_atribuicao: atribuicao.via,
        operador_nome: operador.nome,
        // NF 22232: rastro do lançamento fora de padrão pra auditoria.
        fora_de_padrao: criadoForaDePadrao,
        motivo_fora_padrao: motivoForaPadraoFinal,
      },
    });

    // --- 12. Evidência (banner foto) — mesma chamada do card-email/Bastão ---
    await verificarEvidenciaESinalizar(supabase, cardId, nf, cnpjPagador, oc, ctrc, atribuicao.responsavel_relacionamento ?? operador.nome);

    // --- 13. Propostas base (REGRAS_AUTO_ACAO) — entra no fluxo de validação ---
    await proporAutoAcaoSeAplicavel(supabase, {
      cardId,
      cardNf: nf,
      cardCtrc: ctrc,
      codUltimaOc: oc,
      agentState,
      cardState: "AGUARDANDO_VALIDACAO_HUMANA",
      cardLock: true,
      actorId: "criar-card-manual",
      excecoesOc13,
    });

    // --- 14. Scan de e-mail pré-existente SÍNCRONO (na hora, caixa do operador) ---
    // Caio 2026-06-26: criação manual roda o scan JÁ na criação (não espera o cron
    // de 2 min). Usa o caminho `scan_card_id` da scan-email-pre-card, que roda
    // processarScanJob inline e IGNORA o flag global + a fila. Best-effort: nunca
    // bloqueia a criação; se falhar/estourar timeout, cai pro enqueue assíncrono
    // (cron, gated pelo flag) pra não perder a detecção. NF-âncora 684385 BUNZL:
    // a thread do Victor↔Simone (cliente respondeu) só aparecia ~70s depois.
    let emailPreexistente: { encontrou: boolean; candidatos: number } | null = null;
    try {
      emailPreexistente = await scanEmailSincrono(supabaseUrl, serviceRoleKey, cardId);
    } catch (e) {
      console.warn(`[criar-card-manual] scan síncrono falhou (card=${cardId}): ${e instanceof Error ? e.message : e}`);
      await enfileirarScanEmailPreCard(supabase, {
        card_id: cardId,
        nf,
        cnpj_pagador: cnpjPagador,
        assigned_operator_id: atribuicao.assigned_operator_id,
        origem: "manual",
      });
    }

    return jsonResp({
      ok: true,
      resultado: "created",
      card_id: cardId,
      nf,
      ctrc,
      oc,
      assigned_operator_id: atribuicao.assigned_operator_id,
      email_preexistente: emailPreexistente,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Sessão pode ter expirado no meio — limpa cache pra próxima tentativa.
    try {
      limparSessaoCache(readSswInternalEnv(Deno.env.toObject(), operador.ssw_secret_prefix ?? operador.nome));
    } catch { /* ignore */ }
    console.error(`[criar-card-manual] erro nf=${nf}: ${msg}`);
    return jsonResp({ ok: false, resultado: "erro", mensagem: "Erro inesperado ao criar o card. Tente de novo; se continuar, avise o time técnico com o número da NF.", detalhe: msg });
  }
});
