// =============================================================================
// resolver-pedido-ressalva — REGRA ANTI-VETO R2 (playbook 02/09).
//
// Vetos-âncora: NFs 898554 e 919288 (FELIPE, 26/08) — cliente pediu a ressalva
// e o robô armou 56 (pedir informação à Operação) sendo que a ressalva JÁ
// EXISTIA na oc 10/49. O certo (Duilio p4-p5 + Caio 02/09): RESPONDER o
// cliente (54) com a ressalva que já temos, nunca pedir de novo.
//
// Decisões do Caio 02/09:
//  - Ressalva COM FOTO transcrita (IA Vision: aviso_alteracao_oc.tem_ressalva
//    + ressalva_texto) → 54 respondendo com transcrição + link da evidência.
//    Elegível ao trilho autônomo como qualquer 54.
//  - Ressalva SÓ TEXTO nos padrões "CLIENTE SE RECUSOU A ASSINAR" / "CLIENTE
//    NÃO ASSINOU" → 54 + e-mail SEMPRE MANUAL: nunca arma janela de veto, e o
//    banner avisa o operador que NÃO há imagem (só o texto da ocorrência).
//  - Nada encontrado → mantém a 56 de hoje.
//
// Duilio (p4): "na maioria das vezes onde a 56 é sugerida pela IA, é devido a
// leitura dificultada do comprovante" — por isso a varredura usa o que é
// VERIFICÁVEL (transcrição já feita + texto da oc), nunca re-adivinha foto.
// =============================================================================

/** Ocorrências cujo texto/foto pode carregar a ressalva do insucesso. */
const OCS_COM_RESSALVA: ReadonlySet<number> = new Set([10, 11, 13, 19, 35, 49]);

/** O cliente está PEDINDO a ressalva/comprovante do insucesso?
 *  (pedido, não envio — quem envia anexo cai nas regras de combo/33) */
export function detectarPedidoDeRessalva(respostaCliente: string): boolean {
  const t = respostaCliente ?? "";
  const mencionaDoc = /RESSALVA|CANHOTO|COMPROVANTE\s+(DE\s+)?(ENTREGA|RECUSA|DEVOLU)|COMPROVANTE\s+ASSINADO/i.test(t);
  if (!mencionaDoc) return false;
  // verbo de pedido perto do contexto (evita "segue a ressalva em anexo")
  const pede = /ENVIA|ENVIE|ENCAMINH|MANDA|MANDE|PRECIS|SOLICIT|GOSTARIA|PODE(M|RIA)?\s|NOS\s+PASSE|COMPARTILH|QUAL\s+(FOI|É)|CAD[EÊ]/i.test(t);
  const estaEnviando = /SEGUE(M)?\s+(EM\s+)?ANEXO|ANEXO\s+SEGUE|CONFORME\s+ANEXO/i.test(t);
  return pede && !estaEnviando;
}

/** Texto de oc que caracteriza ressalva SEM imagem (decisão Caio 02/09). */
export function ehRessalvaSemAssinatura(instrucaoOc: string): boolean {
  return /RECUSOU(-|\s+)?(SE\s+)?A?\s*ASSINAR|N[AÃ]O\s+(QUIS\s+)?ASSINOU|N[AÃ]O\s+QUIS\s+ASSINAR|SEM\s+ASSINATURA\s+DO\s+(CLIENTE|RECEBEDOR)/i.test(
    instrucaoOc ?? "",
  );
}

export interface RessalvaResolvida {
  /** 'foto_transcrita' = IA Vision já leu a foto; 'texto_sem_assinatura' =
   *  só o texto da oc (CLIENTE NÃO ASSINOU etc) — SEMPRE manual. */
  tipo: "foto_transcrita" | "texto_sem_assinatura";
  /** oc de onde a ressalva veio (a de insucesso mais recente que casou). */
  oc_origem: number;
  /** o conteúdo que vai pro cliente (transcrição ou texto da oc). */
  texto: string;
}

/** Varre o histórico (mais recente primeiro) atrás da ressalva já existente.
 *  `temRessalvaFoto`/`ressalvaTexto` vêm de aviso_alteracao_oc (IA Vision). */
export function resolverRessalvaExistente(opts: {
  historico: ReadonlyArray<{ codigo: number | null; instrucao: string | null }>;
  temRessalvaFoto: boolean;
  ressalvaTexto: string | null;
}): RessalvaResolvida | null {
  // 1º: transcrição da foto já feita pela análise (o melhor que temos).
  if (opts.temRessalvaFoto && (opts.ressalvaTexto ?? "").trim()) {
    const ocFoto = [...opts.historico].reverse().find((o) => OCS_COM_RESSALVA.has(o.codigo ?? -1));
    return {
      tipo: "foto_transcrita",
      oc_origem: ocFoto?.codigo ?? 0,
      texto: (opts.ressalvaTexto ?? "").trim(),
    };
  }
  // 2º: texto da oc nos padrões sem-assinatura (Caio 02/09).
  for (let i = opts.historico.length - 1; i >= 0; i--) {
    const o = opts.historico[i]!;
    if (!OCS_COM_RESSALVA.has(o.codigo ?? -1)) continue;
    if (ehRessalvaSemAssinatura(o.instrucao ?? "")) {
      return { tipo: "texto_sem_assinatura", oc_origem: o.codigo ?? 0, texto: (o.instrucao ?? "").trim() };
    }
  }
  return null;
}
