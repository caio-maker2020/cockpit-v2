// =============================================================================
// categorizar-erro-ssw — classifica erro vindo de edges SSW (puxar-historico,
// interpretador-evidencia-foto, atualizar-card-via-portal-ssw etc).
//
// Caio 2026-05-22 (bug NF 2299043): agente-sugere-ocs-padrao rotulou
// "SSW login falhou — sem cookie 'token'" como "ssw_offline". Errado — SSW
// não estava offline; o que falhou foi o login do operador (sessão/cred/
// janela de manutenção). Categorização vira mensagem pro banner do operador
// e pro indicador de falhas — precisa ser precisa pra distinguir ação.
// =============================================================================

export type CategoriaErroSsw =
  | "ssw_login_falhou"          // POST de login OK mas sem cookie token (janela manutenção / sessão concorrente / throttling)
  | "ssw_credencial_invalida"   // resposta do portal dizendo cred errada
  | "ssw_sessao_concorrente"    // sessão derrubada pq operador logou em outro lugar
  | "ssw_offline"               // 5xx genuíno, timeout TCP, conexão recusada
  | "ssw_card_sem_credencial"   // operador do card sem env SSW_INTERNAL_<NOME>_*
  | "historico_sem_oc"          // SSW respondeu mas histórico não tem a oc esperada
  | "foto_corrompida"           // SSW devolveu binário inválido
  | "timeout_anthropic"         // IA Vision excedeu tempo
  | "json_invalido"             // resposta IA não decodável
  | "erro_desconhecido";

export interface ErroCategorizado {
  categoria: CategoriaErroSsw;
  mensagem_operador: string;    // texto curto, human-readable, pra banner
  detalhe_tecnico: string;      // primeiros 300 chars do payload original
}

/**
 * Categoriza erro de chamadas pra edges SSW. Atribui categoria, mensagem
 * legível pro operador, e preserva detalhe técnico pro indicador.
 */
export function categorizarErroSsw(
  source: "puxar-historico" | "interpretador" | "atualizar-portal" | "outro",
  status: number,
  body: string,
): ErroCategorizado {
  const b = (body ?? "").toLowerCase();
  const detalheTecnico = (body ?? "").slice(0, 300);

  // 1. Login falhou — cookie token ausente após POST OK
  if (b.includes("login falhou") || b.includes("sem cookie") || b.includes("cookie 'token'")) {
    const usuario = extrairUsuario(body);
    return {
      categoria: "ssw_login_falhou",
      mensagem_operador: usuario
        ? `Não consegui logar no SSW como ${usuario} (sessão pode ter caído ou janela de manutenção). Tento de novo em alguns minutos.`
        : `Não consegui logar no SSW (cookie de sessão ausente). Tento de novo em alguns minutos.`,
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 2. Credencial inválida — portal respondeu cred errada
  if (b.includes("senha incorret") || b.includes("usuario invalid") || b.includes("usuário inválid") ||
      b.includes("credenciais inválidas") || b.includes("login inválid") || b.includes("acesso negado")) {
    return {
      categoria: "ssw_credencial_invalida",
      mensagem_operador: "Credencial SSW do operador parece inválida. Caio precisa revisar SSW_INTERNAL_<NOME>_* no Supabase.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 3. Sessão concorrente
  if (b.includes("já logado") || b.includes("ja logado") || b.includes("sessao em outro") ||
      b.includes("sessão em outro") || b.includes("sessao concorrente")) {
    return {
      categoria: "ssw_sessao_concorrente",
      mensagem_operador: "SSW derrubou a sessão (outro login do mesmo operador rodando). Tento de novo em alguns minutos.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 4. Sem credencial cadastrada (operador do card sem env)
  if (b.includes("sem credencial") || b.includes("sem creds") || b.includes("env ssw_internal")) {
    return {
      categoria: "ssw_card_sem_credencial",
      mensagem_operador: "Operador do card não tem credenciais SSW cadastradas. Caio precisa setar SSW_INTERNAL_<NOME>_*.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 5. Histórico sem oc esperada
  if (b.includes("historico_sem_oc") || b.includes("histórico ssw não tem oc") || b.includes("historico ssw nao tem oc")) {
    return {
      categoria: "historico_sem_oc",
      mensagem_operador: "Histórico SSW não tinha a ocorrência esperada nesse momento. Próxima sincronização deve corrigir.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 6. Foto corrompida
  if (b.includes("foto") && (b.includes("corromp") || b.includes("inválid") || b.includes("invalid"))) {
    return {
      categoria: "foto_corrompida",
      mensagem_operador: "Foto da ocorrência veio corrompida do SSW. Operador precisa validar manualmente.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 7. Timeout Anthropic
  if (b.includes("anthropic") && (b.includes("timeout") || b.includes("excedeu"))) {
    return {
      categoria: "timeout_anthropic",
      mensagem_operador: "IA Vision demorou demais — tentando novamente.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 8. JSON inválido
  if (b.includes("json") && (b.includes("invalid") || b.includes("parse"))) {
    return {
      categoria: "json_invalido",
      mensagem_operador: "Resposta da IA veio mal-formada — tentando novamente.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // 9. SSW offline genuíno (status 5xx + sem padrão acima, ou timeout)
  if (status >= 500 || b.includes("timeout") || b.includes("connection refused") || b.includes("econnreset")) {
    return {
      categoria: "ssw_offline",
      mensagem_operador: "Portal SSW não respondeu (pode ser instabilidade pontual). Tento de novo em alguns minutos.",
      detalhe_tecnico: detalheTecnico,
    };
  }

  // Fallback
  return {
    categoria: "erro_desconhecido",
    mensagem_operador: "Falha inesperada na análise IA. Operador pode aprovar manual ou aguardar nova tentativa.",
    detalhe_tecnico: detalheTecnico,
  };
}

/**
 * Extrai nome do usuário SSW da mensagem de erro do helper de login.
 * Ex: "SSW login falhou — sem cookie 'token' após POST (creds: dominio=SEP usuario=DUILIO.D)"
 *     → "DUILIO.D"
 */
function extrairUsuario(body: string): string | null {
  const m = body.match(/usuario=([A-Z0-9._-]+)/i);
  return m ? m[1]! : null;
}
