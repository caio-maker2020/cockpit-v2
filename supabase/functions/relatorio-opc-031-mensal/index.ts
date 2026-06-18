// =============================================================================
// relatorio-opc-031-mensal — Gera relatório SSW opção 031 (CTRCs com
// determinada ocorrência) dos últimos 30 dias pra ocorrência 31 (AGUARDANDO
// AGENDAMENTO), filtrado por situação=Pendente, formato Excel. Envia o arquivo
// por email pra `isadora.baldoni@salexpress.com.br` via Gmail OAuth da LARISSA.
//
// Caio 2026-06-09: substituto do processo manual da Isadora (entrar SSW, baixar,
// enviar). Padrão reaproveitável pra outras OPCs (basta clonar e ajustar
// CODIGO_OC + DESTINATARIO).
//
// Auth: nenhum (deploy com --no-verify-jwt). Pode ser invocado por cron ou
// manualmente via HTTP POST. Sem body necessário.
//
// Fluxo:
//   1. Login SSW interno como LARISSA (creds SSW_INTERNAL_LARISSA_*)
//   2. POST /bin/ssw0495 (act=ENV) com filtros — solicitação vai pra fila
//   3. Polling /bin/ssw1440 (opção 156) até a linha aparecer como "Concluído"
//      com link "Baixar"
//   4. GET no link Baixar → Excel binário (.xls)
//   5. base64 + envia via gmail-sender pra destinatário, anexado
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { obterSessao, readSswInternalEnv } from "../_shared/ssw-internal-client.ts";
import { ddmmyyBRT } from "../_shared/brt.ts";
import { sendGmailMessage } from "../_shared/gmail-sender.ts";

const BASE = "https://sistema.ssw.inf.br";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const DESTINATARIO = "isadora.baldoni@salexpress.com.br";
const OPERADOR_NOME = "LARISSA";
const CODIGO_OC = "31";
const SITUACAO_CTRC = "P"; // P=pendente
const POLLING_MAX_TENTATIVAS = 30;
const POLLING_INTERVAL_MS = 2000;

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const supabase = createClient(env["SUPABASE_URL"]!, env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Permite override de destinatário via query string (?to=outro@email)
  const url = new URL(req.url);
  const destinatarioFinal = url.searchParams.get("to") || DESTINATARIO;

  const startedAt = Date.now();
  const debug: Record<string, unknown> = { destinatario: destinatarioFinal };

  try {
    // ─── 1. Carrega credenciais e sessão SSW ────────────────────────────────
    const sswEnv = readSswInternalEnv(env, OPERADOR_NOME);
    const sessao = await obterSessao(sswEnv);
    const cookieStr = () => [...sessao.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    debug["login_ms"] = Date.now() - startedAt;

    // ─── 2. Calcula datas: hoje-30d → hoje (formato DDMMYY, fuso BRT do SSW) ──
    // BRT obrigatório: das 21h à meia-noite, "hoje" em UTC vira amanhã e o SSW
    // rejeita a data final (ver _shared/brt.ts).
    const agora = Date.now();
    const dHoje = ddmmyyBRT(agora);
    const dInicio = ddmmyyBRT(agora - 30 * 24 * 60 * 60 * 1000);
    debug["data_inicio"] = dInicio;
    debug["data_fim"] = dHoje;

    // Captura SEQ máximo atual ANTES do submit pra garantir que polling
    // depois identifique APENAS a NOSSA linha (seq > seqInicial).
    let seqInicial = 0;
    {
      const rPre = await fetch(`${BASE}/bin/ssw1440`, {
        headers: { "User-Agent": UA, Referer: `${BASE}/bin/ssw0495`, cookie: cookieStr() },
        redirect: "manual",
      });
      const htmlPre = await rPre.text();
      const xmlPre = htmlPre.match(/<xml id="xmlsr"[^>]*>([\s\S]*?)<\/xml>/i)?.[1] ?? "";
      const seqs = [...xmlPre.matchAll(/<f0>(\d+)<\/f0>/gi)].map((m) => parseInt(m[1]!, 10));
      seqInicial = seqs.length > 0 ? Math.max(...seqs) : 0;
    }
    debug["seq_inicial"] = seqInicial;

    const marcoSubmit = Date.now();

    // ─── 3. POST /bin/ssw0495 act=ENV ───────────────────────────────────────
    const formEnv = new URLSearchParams({
      act: "ENV",
      programa: "ssw0495",
      f1: "", // período emissão CTRC (vazio)
      f2: "",
      f3: dInicio, // data ocorrência início
      f4: dHoje, // data ocorrência fim
      f6: CODIGO_OC, // código ocorrência
      ocor_descr: "", // autofill
      f8: "", // CNPJ pagador (vazio)
      f10: "", // conferente (vazio)
      f11: SITUACAO_CTRC,
      f12: "S", // arquivo excel = S
    });
    const rEnv = await fetch(`${BASE}/bin/ssw0495`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/bin/ssw0495`,
        cookie: cookieStr(),
      },
      body: formEnv,
      redirect: "manual",
    });
    const htmlEnv = await rEnv.text();
    debug["submit_status"] = rEnv.status;
    debug["submit_excerpt"] = htmlEnv.slice(0, 400);

    if (!/156|fila|processamento|aguardando|conclu/i.test(htmlEnv)) {
      return j({
        ok: false,
        error: "submit ssw0495 não retornou confirmação de fila",
        debug,
      }, 502);
    }

    // ─── 4. Polling /bin/ssw1440 (opção 156) até a NOSSA linha concluir ─────
    //
    // Tabela é XML embutido: <xml id="xmlsr"><rs><r><f0>seq</f0><f1>opção</f1>
    // <f2>dataHora</f2><f3>user</f3><f4>unidade</f4><f5>fone</f5><f6>situação
    // </f6><f7>duração</f7><f8>linkBaixar</f8><f9>seq</f9></r>...</rs></xml>
    //
    // f8 quando concluído contém HTML escapado: &lt;a ... onclick=ajaxEnvia(
    // 'DOW<seq>');&gt;Baixar&lt;/a&gt;
    //
    // Filtro: 1ª linha (mais recente — SSW devolve desc por seq) com f1
    // contendo "031" e f6 = "Concluído". Risco baixo de colisão com outro user
    // submetendo 031 ao mesmo tempo (manda só a Larissa).
    let seqBaixar: string | null = null;
    let linhaEncontrada: Record<string, string> | null = null;

    for (let tentativa = 1; tentativa <= POLLING_MAX_TENTATIVAS; tentativa++) {
      await new Promise((r) => setTimeout(r, POLLING_INTERVAL_MS));
      const rFila = await fetch(`${BASE}/bin/ssw1440`, {
        headers: { "User-Agent": UA, Referer: `${BASE}/bin/ssw0495`, cookie: cookieStr() },
        redirect: "manual",
      });
      const htmlFila = await rFila.text();

      const xmlMatch = htmlFila.match(/<xml id="xmlsr"[^>]*>([\s\S]*?)<\/xml>/i);
      if (!xmlMatch) continue;
      const xmlBody = xmlMatch[1] ?? "";

      const rs = [...xmlBody.matchAll(/<r>([\s\S]*?)<\/r>/gi)];
      for (const r of rs) {
        const inner = r[1] ?? "";
        const f = (n: number) => {
          const m = inner.match(new RegExp(`<f${n}>([\\s\\S]*?)<\/f${n}>`, "i"));
          return m?.[1] ?? "";
        };
        const f0 = parseInt(f(0), 10) || 0;
        const f1 = f(1);
        const f6 = f(6);
        const f8 = f(8);
        // Filtra APENAS minha nova solicitação (seq > seqInicial capturado
        // antes do submit). Garante que não pegue Excel antigo expirado.
        if (f0 <= seqInicial) continue;
        if (!/031/i.test(f1)) continue;
        if (!/Conclu/i.test(f6)) continue;
        const dowMatch = f8.match(/DOW(\d+)/i);
        if (!dowMatch) continue;
        seqBaixar = dowMatch[1]!;
        linhaEncontrada = {
          seq: f(0),
          opcao: f1,
          dataHora: f(2),
          usuario: f(3),
          situacao: f6,
          duracao: f(7),
        };
        break;
      }
      if (seqBaixar) {
        debug["polling_tentativa"] = tentativa;
        debug["polling_ms"] = Date.now() - marcoSubmit;
        debug["linha_encontrada"] = linhaEncontrada;
        break;
      }
    }

    if (!seqBaixar) {
      return j({
        ok: false,
        error: `Fila não concluiu em ${POLLING_MAX_TENTATIVAS} tentativas (${POLLING_MAX_TENTATIVAS * POLLING_INTERVAL_MS / 1000}s). Job pode estar lento.`,
        debug,
      }, 504);
    }

    // ─── 5. Download em 2 hops: POST DOW retorna metadata, GET ssw0424 baixa
    //
    // (a) POST /bin/ssw1440 act=DOW<seq> → response HTML contém web_body com
    //     URL-encoded chamada `abrir('FILE','FILE',1,1,'/usr/aws/jobs/SEP/',4)`
    // (b) Função `abrir` (de scripts/ssw_010622.js) constrói URL:
    //     /bin/ssw0424?act=<file>&filename=<file>&path=<path>&down=1&nw=1
    // (c) GET nessa URL → binário Excel/CSV
    const formDl = new URLSearchParams({ act: `DOW${seqBaixar}`, programa: "ssw1440" });
    const rDow = await fetch(`${BASE}/bin/ssw1440`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/bin/ssw1440`,
        cookie: cookieStr(),
      },
      body: formDl,
      redirect: "manual",
    });
    const dowTxt = await rDow.text();
    // Extrai params de abrir('arq','arq',1,1,'/path/', 4) — vem URL-encoded no value do hidden web_body
    const webBodyMatch = dowTxt.match(/name=["']?web_body["']?[^>]*value=["']([^"']+)["']/i);
    if (!webBodyMatch) {
      return j({
        ok: false,
        error: "POST DOW não retornou web_body com chamada abrir()",
        debug: { ...debug, dow_response: dowTxt.slice(0, 500) },
      }, 502);
    }
    const webBodyDecoded = decodeURIComponent(webBodyMatch[1]!);
    const abrirParams = webBodyDecoded.match(/abrir\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']+)'/i);
    if (!abrirParams) {
      return j({
        ok: false,
        error: `web_body não contém abrir() esperada: ${webBodyDecoded.slice(0, 200)}`,
        debug,
      }, 502);
    }
    const arqori = abrirParams[1]!;
    const arqdes = abrirParams[2]!;
    const down = abrirParams[3]!;
    const nw = abrirParams[4]!;
    const filePath = abrirParams[5]!;
    debug["arquivo_real"] = arqori;
    debug["path_real"] = filePath;

    const downloadUrl = `${BASE}/bin/ssw0424?act=${encodeURIComponent(arqori)}&filename=${encodeURIComponent(arqdes)}&path=${encodeURIComponent(filePath)}&down=${down}&nw=${nw}`;
    const rDl = await fetch(downloadUrl, {
      headers: { "User-Agent": UA, Referer: `${BASE}/bin/ssw1440`, cookie: cookieStr() },
      redirect: "follow",
    });
    if (!rDl.ok) {
      return j({
        ok: false,
        error: `Download falhou: HTTP ${rDl.status}`,
        debug: { ...debug, seq_baixar: seqBaixar },
      }, 502);
    }
    const ct = rDl.headers.get("content-type") ?? "application/octet-stream";
    const bin = new Uint8Array(await rDl.arrayBuffer());
    // Nome de arquivo amigável (Excel abre CSV nativamente)
    const filename = `relatorio_opc031_${dInicio}_${dHoje}.csv`;
    // Content-type pra anexo: força text/csv (Excel abre, clientes reconhecem)
    const ctAnexo = "text/csv; charset=iso-8859-1";
    debug["download_bytes"] = bin.byteLength;
    debug["download_content_type"] = ct;
    debug["download_filename_original"] = rDl.headers.get("content-disposition") ?? "";
    debug["filename_enviado"] = filename;

    // Sanity check: 1KB+ e content-type esperado
    if (bin.byteLength < 1000 || (!ct.includes("ssw") && !ct.includes("csv") && !ct.includes("excel") && !ct.includes("octet"))) {
      const textDump = new TextDecoder("iso-8859-1").decode(bin);
      return j({
        ok: false,
        error: `Download não parece ser arquivo válido: ${bin.byteLength}B content-type=${ct}`,
        download_raw_text: textDump.slice(0, 1500),
        debug,
      }, 502);
    }

    // base64 pro Gmail
    const base64 = uint8ToBase64(bin);

    // ─── 6. Envia email via Gmail OAuth LARISSA ─────────────────────────────
    const { data: operadora } = await supabase
      .from("operadores")
      .select("id, nome")
      .ilike("nome", OPERADOR_NOME)
      .maybeSingle();

    if (!operadora?.id) {
      return j({
        ok: false,
        error: `Operadora ${OPERADOR_NOME} não encontrada em DB pra enviar email`,
        debug,
      }, 500);
    }

    const assunto = `Relatório SSW OPC 031 — Ocorrência 31 Pendentes — ${dInicio} a ${dHoje}`;
    const corpo = [
      `Olá Isadora,`,
      ``,
      `Segue em anexo o relatório SSW da Opção 031 (CTRCs com determinada ocorrência), filtrado pelos seguintes critérios:`,
      ``,
      `• Código de ocorrência: ${CODIGO_OC} (AGUARDANDO AGENDAMENTO)`,
      `• Período: ${dInicio.slice(0, 2)}/${dInicio.slice(2, 4)}/20${dInicio.slice(4, 6)} a ${dHoje.slice(0, 2)}/${dHoje.slice(2, 4)}/20${dHoje.slice(4, 6)}`,
      `• Situação: Pendente`,
      ``,
      `Relatório gerado automaticamente pelo Cockpit.`,
      ``,
      `Atenciosamente,`,
      `LARISSA`,
      `Sal Express — Relacionamento`,
    ].join("\n");

    const sendResult = await sendGmailMessage({
      supabase,
      operadorId: operadora.id as string,
      destinatario: destinatarioFinal,
      subject: assunto,
      texto: corpo,
      attachments: [{
        filename,
        mime_type: ctAnexo,
        content_base64: base64,
      }],
    });

    if (!sendResult.ok) {
      return j({
        ok: false,
        error: `Envio email falhou: ${sendResult.error}`,
        debug,
      }, 502);
    }

    return j({
      ok: true,
      destinatario: destinatarioFinal,
      filename,
      tamanho_bytes: bin.byteLength,
      messageId: sendResult.messageId,
      duration_ms: Date.now() - startedAt,
      debug,
    }, 200);
  } catch (err) {
    return j({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      debug,
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
});

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    bin += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(bin);
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
