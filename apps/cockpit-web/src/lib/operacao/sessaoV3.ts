// A sessão do roteirizador v3, lida do MESMO armazenamento do site do v3 (mesma origem:
// a demonstração é servida em /operacao-cockpit/ pelo próprio site). O v3 guarda o JWT em
// localStorage["ri_token"] (apps/web/src/lib/api.ts). Aqui só se LÊ: quem valida a assinatura
// e o papel é a API do v3, a cada pedido. Só é usado no build demo-v3.
export const CHAVE_SESSAO_V3 = "ri_token";
export const EVENTO_SEM_SESSAO_V3 = "operacao-demo-v3:sem-sessao";
export const LOGIN_DO_V3 = "/login?voltar=/operacao-cockpit/";

export interface SessaoV3 {
  token: string;
  nome: string | null;
}

function payloadDoJwt(token: string): Record<string, unknown> | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  try {
    const b64 = partes[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64 + "===".slice((b64.length + 3) % 4))
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    const o = JSON.parse(json) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Pura: a sessão de PESSOA da operação/gestor no aparelho, ou null (sem token, vencido, motorista). */
export function lerSessaoV3(bruto: string | null | undefined, agoraS: number): SessaoV3 | null {
  if (!bruto) return null;
  const p = payloadDoJwt(bruto);
  if (!p) return null;
  if (p.papel === "motorista") return null;
  if (typeof p.exp === "number" && p.exp <= agoraS) return null;
  if (typeof p.sub !== "number") return null;
  return { token: bruto, nome: typeof p.nome === "string" ? p.nome : null };
}

export function sessaoV3DoAparelho(): SessaoV3 | null {
  try {
    return lerSessaoV3(window.localStorage.getItem(CHAVE_SESSAO_V3), Math.floor(Date.now() / 1000));
  } catch {
    return null;
  }
}

export function avisarSemSessaoV3(): void {
  try {
    window.dispatchEvent(new Event(EVENTO_SEM_SESSAO_V3));
  } catch {
    /* sem window (teste) */
  }
}
