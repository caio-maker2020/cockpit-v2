import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { CardState, CardTipo, CardRisco } from "./types";

/** Timestamp relativo PT-BR ("há 5 minutos", "há 2 horas"). */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return "—";
  }
}

/** Mapa estado → tom semântico do design system. */
export function stateTone(
  state: CardState,
  risco?: CardRisco | null,
): "ok" | "wait" | "block" | "run" | "muted" {
  if (state === "RESOLVIDO") return "ok";
  if (state === "BLOQUEADO_POR_ERRO" || state === "ESCALADO_HUMANO") return "block";
  if (risco === "alto" && state !== "CANCELADO") return "block";
  if (state === "EM_EXECUCAO_AUTOMATICA" || state === "EXECUTANDO_ACAO") return "run";
  if (state.startsWith("AGUARDANDO")) return "wait";
  if (state === "EM_TRIAGEM") return "run";
  return "muted";
}

export function stateBadgeClasses(tone: ReturnType<typeof stateTone>): string {
  switch (tone) {
    case "ok":
      return "bg-status-ok-soft text-status-ok border border-status-ok/30";
    case "wait":
      return "bg-status-wait-soft text-status-wait-foreground border border-status-wait/40";
    case "block":
      return "bg-status-block-soft text-status-block border border-status-block/30";
    case "run":
      return "bg-status-run-soft text-status-run border border-status-run/30";
    default:
      return "bg-muted text-muted-foreground border border-border";
  }
}

export function tipoChipClasses(tipo: CardTipo | null | undefined): string {
  switch (tipo) {
    case "rastreamento":
      return "bg-blue-50 text-blue-700 border border-blue-200";
    case "reentrega":
      return "bg-amber-50 text-amber-700 border border-amber-200";
    case "devolucao":
      return "bg-orange-50 text-orange-700 border border-orange-200";
    case "avaria":
      return "bg-rose-50 text-rose-700 border border-rose-200";
    case "extravio":
      return "bg-red-50 text-red-700 border border-red-200";
    case "inversao":
      return "bg-purple-50 text-purple-700 border border-purple-200";
    case "cobranca":
      return "bg-emerald-50 text-emerald-700 border border-emerald-200";
    case "outros":
      return "bg-slate-100 text-slate-700 border border-slate-200";
    default:
      return "bg-muted text-muted-foreground border border-border";
  }
}

/** Cor de chip + border-left por responsabilidade da ocorrência. */
export function responsabilidadeChipClasses(resp: string | null | undefined): {
  chip: string;
  border: string;
} {
  switch ((resp ?? "").toLowerCase()) {
    case "cliente":
      return {
        chip: "bg-primary-50 text-primary-700",
        border: "border-l-primary-500",
      };
    case "relacionamento":
      return { chip: "bg-blue-50 text-blue-700", border: "border-l-blue-500" };
    case "operação":
    case "operacao":
      return { chip: "bg-slate-100 text-slate-700", border: "border-l-slate-500" };
    case "perdas":
      return { chip: "bg-rose-50 text-rose-700", border: "border-l-rose-500" };
    case "ressarcimento":
      return { chip: "bg-amber-50 text-amber-700", border: "border-l-amber-500" };
    case "devolução":
    case "devolucao":
      return { chip: "bg-orange-50 text-orange-700", border: "border-l-orange-500" };
    case "agendamento":
      return { chip: "bg-emerald-50 text-emerald-700", border: "border-l-emerald-500" };
    default:
      return { chip: "bg-muted text-muted-foreground", border: "border-l-border" };
  }
}

export function canalIcon(canal: string | null | undefined): string {
  if (canal === "whatsapp") return "📱";
  if (canal === "email") return "✉️";
  if (canal === "sistema") return "⚙️";
  return "•";
}

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Iniciais (até 2 letras) a partir do nome do operador. */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "50d atraso", "3d atraso", "—". Cor depende da magnitude. */
export function diasAtrasoTone(dias: number | null | undefined): {
  label: string;
  className: string;
} {
  if (dias == null || isNaN(dias)) return { label: "—", className: "text-muted-foreground" };
  if (dias <= 0) return { label: "no prazo", className: "text-muted-foreground" };
  const label = `${dias}d atraso`;
  if (dias > 7) return { label, className: "text-primary-600 font-medium" };
  return { label, className: "text-status-wait-foreground" };
}

/** Saudação por hora local PT-BR. */
export function saudacao(d: Date = new Date()): string {
  const h = d.getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

/** Primeiro nome capitalizado a partir do nome do operador. */
export function primeiroNome(nome: string | null | undefined): string {
  if (!nome) return "operador";
  const p = nome.trim().split(/\s+/)[0] ?? "";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** Curto relativo: "agora", "há 5min", "há 2h", "há 3d". */
export function relativeShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "agora";
  if (diff < 3600) return `há ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)}h`;
  return `há ${Math.floor(diff / 86400)}d`;
}
