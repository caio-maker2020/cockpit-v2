import { ExternalLink } from "lucide-react";
import { DASHBOARD_CLIENTES_URL } from "@/lib/dashboard-clientes";
import { avisarDashboardAberto } from "@/lib/abrir-dashboard-clientes";

/**
 * Botão vermelho abaixo da saudação do Inbox: abre o dashboard de clientes
 * (Vercel externo) em nova aba. Qualquer operador vê e clica.
 */
export function BotaoVisaoGeralClientes() {
  return (
    <a
      href={DASHBOARD_CLIENTES_URL}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => avisarDashboardAberto()}
      data-testid="botao-visao-geral-clientes"
      title="Abre a análise detalhada de performance por cliente (nova aba)"
      className="mt-3 inline-flex items-center gap-2 rounded-[8px] bg-sal px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-paper transition-colors hover:bg-sal-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sal/40"
    >
      Visão geral dos clientes
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}
