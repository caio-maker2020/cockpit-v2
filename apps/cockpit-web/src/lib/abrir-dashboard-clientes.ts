import { toast } from "sonner";
import { senhaDashboardClientes } from "@/lib/dashboard-clientes";

/**
 * Aviso pós-clique nos botões do dashboard de clientes. A navegação em si é
 * NATIVA do `<a target="_blank" rel="noopener noreferrer">` — não usamos
 * `window.open`: com `noopener` ele retorna null por especificação, o que
 * fazia o Cockpit acusar "pop-up bloqueado" com a aba já aberta (achado no
 * teste de navegador de 2026-09-18). Clique em âncora nunca cai no bloqueador.
 *
 * Se a senha única estiver na env, oferece "Copiar senha": a tela de acesso
 * do dashboard pede a senha na primeira abertura do navegador.
 */
export function avisarDashboardAberto(termo?: string): void {
  const senha = senhaDashboardClientes();
  const texto = termo
    ? `Dashboard aberto em nova aba no cliente "${termo}".`
    : "Dashboard aberto em nova aba.";
  const descricao = senha
    ? "Se pedir senha de acesso, use o botão ao lado."
    : "Se pedir senha de acesso, peça ao gestor.";
  toast(texto, {
    description: descricao,
    duration: 8000,
    action: senha
      ? {
          label: "Copiar senha",
          onClick: () => {
            void navigator.clipboard
              .writeText(senha)
              .then(() => toast.success("Senha copiada. Cole na tela de acesso do dashboard."))
              .catch(() => toast.error("Não consegui copiar. Peça a senha ao gestor."));
          },
        }
      : undefined,
  });
}
