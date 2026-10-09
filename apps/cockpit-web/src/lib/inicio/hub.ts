// =============================================================================
// Hub do gestor (/inicio): a tela inicial de quem vê as duas áreas.
// Puro e testado. Só ACRESCENTA: decidirAreas (areas.ts) segue sendo a única
// fonte de quem vê o quê; aqui só se decide a rota inicial e o destaque.
//   - operador do Relacionamento (não gestor) → /inbox, como sempre foi;
//   - membro só da Operação → /operacao, como sempre foi;
//   - gestor (operadores.papel='gestor' ou eh_gestor da Operação) → /inicio.
// =============================================================================
import type { Areas } from "@/lib/operacao/areas";

export const ROTA_INICIO = "/inicio";
export type Area = "relacionamento" | "operacao";

/** Rota de "/" (e de depois do login). null = ainda não dá para decidir. */
export function rotaInicial(a: Pick<Areas, "carregando" | "ehGestor" | "veRelacionamento">, demo = false): string | null {
  if (a.ehGestor || demo) return ROTA_INICIO;
  if (a.veRelacionamento) return "/inbox";
  if (a.carregando) return null;
  return "/operacao";
}

/** Quem vê o hub e o seletor de área do header. */
export function veHub(a: Pick<Areas, "ehGestor">, demo = false): boolean {
  return a.ehGestor || demo;
}

const CHAVE_ULTIMA = "cockpit.inicio.ultimaArea.v1";

export function lerUltimaArea(): Area | null {
  try {
    const v = window.localStorage.getItem(CHAVE_ULTIMA);
    return v === "operacao" || v === "relacionamento" ? v : null;
  } catch {
    return null;
  }
}

export function gravarUltimaArea(a: Area): void {
  try {
    window.localStorage.setItem(CHAVE_ULTIMA, a);
  } catch {
    /* sem storage: o hub só não lembra a última área */
  }
}

/** Área de uma rota (null = rota neutra, como o próprio hub). */
export function areaDaRota(pathname: string): Area | null {
  if (pathname === ROTA_INICIO || pathname === "/" || pathname === "/login") return null;
  return pathname === "/operacao" || pathname.startsWith("/operacao/") ? "operacao" : "relacionamento";
}

/**
 * Qual área ganha o bloco grande: a que tem mais coisa pedindo o gestor agora.
 * Enquanto um dos lados não respondeu (ou empatam), vale a última usada;
 * sem nada lembrado, o Relacionamento (a área que já existia).
 */
export function areaDestaque(
  urgencia: { relacionamento: number | null; operacao: number | null },
  disponiveis: { relacionamento: boolean; operacao: boolean },
  ultima: Area | null,
): Area {
  if (!disponiveis.operacao) return "relacionamento";
  if (!disponiveis.relacionamento) return "operacao";
  const { relacionamento: r, operacao: o } = urgencia;
  if (r != null && o != null && r !== o) return r > o ? "relacionamento" : "operacao";
  return ultima ?? "relacionamento";
}

/** Abre a Operação já numa aba (Gestão, Comprovantes, Torre) — a mesma chave que a tela lê. */
export function prepararAbaOperacao(aba: "trabalho" | "gestao" | "comprovantes" | "torre"): void {
  try {
    window.localStorage.setItem("operacao.aba.v2", JSON.stringify(aba));
  } catch {
    /* sem storage: a Operação abre na aba que já abriria */
  }
}
