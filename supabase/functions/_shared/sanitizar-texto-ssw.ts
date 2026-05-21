// =============================================================================
// sanitizar-texto-ssw — limpa tags HTML, comentários e entidades do texto cru
// do portal SSW antes de exibir pro operador ou enviar pra cliente.
//
// Caio 2026-05-23 (NF 1494821): campo instrucao_motorista vinha com
// '<!--...--> ... <a href=# class=sra onclick=showMapaVeic(...)><u>GPS</u></a>'
// porque o portal SSW retorna HTML inline pra link GPS. O texto puro útil
// fica fora das tags + comentários.
//
// Regra:
//   1. Remove comentários HTML <!--...-->
//   2. Remove tags HTML <...> (preserva conteúdo entre elas)
//   3. Decodifica entidades comuns (&nbsp; &amp; &lt; &gt; &quot; &#39;)
//   4. Colapsa múltiplos espaços/newlines em 1 espaço
//   5. Trim
// =============================================================================

export function sanitizarTextoSsw(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = raw;

  // 1. Remove comentários HTML (incluindo multilinha)
  t = t.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. Remove tags HTML (preserva texto entre elas)
  t = t.replace(/<[^>]*>/g, " ");

  // 3. Entidades HTML comuns
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");

  // 4. Colapsa whitespace
  t = t.replace(/\s+/g, " ");

  // 5. Trim
  return t.trim();
}

/**
 * Detecta se um texto vindo do SSW é **automático/genérico** (SSWMOBILE,
 * protocolo SEFAZ, metadado GPS, falta de informação real do motorista) e
 * NÃO conta como motivo válido pra justificar lançamento de oc=54+email.
 *
 * Caio 2026-05-23 (NF 1494821): texto "NAO TENHO ALERTA DE RE (SSWMOBILE)
 * GPS (3.090m)" passava como motivo real → agente sugeria 54+template
 * RECUSA_TOTAL erradamente. Texto é AUTOMÁTICO do SSWMOBILE, não instrução
 * do motorista. Quando detectado, agente sugere 56 (Operação revisa).
 *
 * Lista é extensível via env `MOTIVOS_SSW_GENERICOS_EXTRA` (csv).
 */
const SSW_PATTERNS_GENERICOS: RegExp[] = [
  /\(sswmobile\)/i,                  // qualquer texto com "(SSWMOBILE)"
  /sefaz[-\s]?[a-z]{2}/i,            // "SEFAZ-MG", "SEFAZ-SP"
  /cte\.fazenda\.gov\.br/i,
  /^nao tenho\b/i,                   // "NAO TENHO ALERTA DE RE"
  /^alerta de re\b/i,                // "ALERTA DE RE" sozinho
  /^comprovante (registrad|anexa)/i, // "COMPROVANTE REGISTRADO..." automático
  /^entrega realizada normalmente/i, // automático SSWMOBILE
  /^entrega iniciada/i,
  /protocolo:\s*\d+/i,
];

const SSW_PALAVRAS_GENERICAS = new Set([
  "", ".", "-", "x", "ok", "n/a", "na", "sem info", "sem informacao", "sem informação",
  "sem informacoes", "sem informações", "sem motivo", "nao informado", "não informado",
]);

export function ehMotivoSswGenerico(raw: string | null | undefined, extras?: string[]): boolean {
  const t = sanitizarTextoSsw(raw).trim().toLowerCase();
  if (!t) return true;
  if (t.length < 5) return true;
  if (SSW_PALAVRAS_GENERICAS.has(t)) return true;
  if (extras?.some((p) => t === p.toLowerCase())) return true;

  // Padrões automáticos do SSWMOBILE
  for (const re of SSW_PATTERNS_GENERICOS) {
    if (re.test(t)) return true;
  }

  // Heurística: se quase todo o texto é metadado GPS/protocolo + poucas
  // palavras úteis, é genérico
  const metadados = (t.match(/gps\s*\(|protocolo|sefaz|sswmobile|cte\.fazenda/gi) ?? []).length;
  const palavrasUteis = t.split(/\s+/).filter((w) => w.length > 3 && !/^\d+$/.test(w)).length;
  if (metadados >= 1 && palavrasUteis < 5) return true;

  return false;
}

/**
 * Detecta se o texto contém pelo menos UMA palavra-chave **acionável** —
 * algo que descreve causa real da entrega não realizada e justifica
 * notificar o cliente. Caio 2026-05-23 (NF 1494821): "ALERTA DE RE" passava
 * como motivo válido mas não diz NADA pro cliente; queremos só motivos
 * que o operador conseguiria escrever num email pro cliente decidir.
 *
 * Quando motivo NÃO tem palavra-chave acionável E foto está
 * aleatoria/ilegivel/sem_foto, o agente deve sugerir autônomo
 * (oc=21+cancel) em vez de 54+email — não há texto pra mandar.
 */
const PALAVRAS_ACIONAVEIS = [
  // Recusa / devolução
  "recusa", "recusou", "recusaram", "devolveu", "devolveram", "devolver", "nao\\s*aceit",
  // Endereço / localização
  "endere[cç]o", "cep", "rua", "n[uú]mero", "casa", "predio", "pr[eé]dio",
  "bairro", "cidade", "logradouro", "ref[eê]r[eê]ncia",
  // Acesso / ausência
  "ausente", "ningu[eé]m", "fechad", "ferias", "feriado", "expediente",
  "horario", "hor[aá]rio", "comercial", "almoco", "almo[cç]o",
  // Veículo / infraestrutura
  "ve[ií]culo", "caminh[aã]o", "acesso", "via", "rua\\s*estreit",
  // Pagamento / documentação
  "pagar", "pagamento", "dinheiro", "boleto", "nota", "fatur", "valor",
  "documento", "rg", "cnpj", "ie", "incons",
  // Cliente / pessoa
  "cliente", "destinatario", "destinat[áa]rio", "respons[áa]vel", "telefone",
  // Mercadoria
  "produto", "mercadoria", "embalag", "violad", "av[áa]ri", "danificad",
  "volume", "falta", "faltou", "quantidad",
];

/**
 * @returns true se o texto contém pelo menos uma palavra-chave que pode
 *          virar conteúdo de email pro cliente. false = texto vago/genérico
 *          (mesmo se passou no `ehMotivoSswGenerico`).
 */
export function ehMotivoAcionavelParaCliente(raw: string | null | undefined): boolean {
  const t = sanitizarTextoSsw(raw).toLowerCase();
  if (!t || t.length < 5) return false;
  for (const palavra of PALAVRAS_ACIONAVEIS) {
    if (new RegExp(`\\b${palavra}`, "i").test(t)) return true;
  }
  return false;
}

/**
 * Extrai apenas a distância GPS de uma instrução SSW (formato "GPS (Xm)"),
 * útil pra oc=11. Retorna o número de metros (inteiro) ou null.
 * NB: o portal BR usa ponto como separador de milhar ("2.102m" = 2102m).
 */
export function extrairGpsMetrosDaInstrucao(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // Limpa HTML antes de regex
  const limpo = sanitizarTextoSsw(raw);
  const m = limpo.match(/GPS\s*\(\s*([\d.]+)\s*m\s*\)/i);
  if (!m) return null;
  const numStr = m[1]!.replace(/\./g, ""); // remove separador de milhar
  const n = parseInt(numStr, 10);
  return Number.isFinite(n) ? n : null;
}
