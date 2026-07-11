/**
 * Banner de identificação de ambiente.
 *
 * Aparece em QUALQUER ambiente que NÃO seja produção (VITE_APP_ENV !== 'production').
 * Objetivo: enquanto o Cockpit novo está em migração/homologação, ninguém pode
 * confundir o preview da Vercel com o sistema de produção nem compartilhar com
 * operadores por engano. Só some quando VITE_APP_ENV === 'production'.
 */
import { ACOES_DESABILITADAS } from "@/lib/supabase";

export function EnvBanner() {
  const env = (import.meta.env.VITE_APP_ENV as string | undefined) ?? "homologacao";
  if (env === "production") return null;

  return (
    <div
      role="status"
      style={{
        // Somente-leitura = verde (seguro pra clicar à vontade); com escrita
        // liberada = âmbar (cuidado, ações vão pra produção). Deixa o estado
        // de segurança VISÍVEL — dá pra confirmar num olhar/screenshot que a
        // trava do piloto está ligada.
        background: ACOES_DESABILITADAS ? "#047857" : "#B45309",
        color: "#fff",
        fontSize: "12px",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textAlign: "center",
        padding: "4px 8px",
        width: "100%",
      }}
    >
      ⚠ HOMOLOGAÇÃO ({env}) · NÃO é produção ·{" "}
      {ACOES_DESABILITADAS
        ? "🔒 SOMENTE LEITURA — nenhuma ação vai pro SSW/e-mail"
        : "⚠ AÇÕES HABILITADAS — cuidado, ações vão pra produção"}
    </div>
  );
}
