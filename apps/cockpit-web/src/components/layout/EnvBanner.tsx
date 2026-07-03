/**
 * Banner de identificação de ambiente.
 *
 * Aparece em QUALQUER ambiente que NÃO seja produção (VITE_APP_ENV !== 'production').
 * Objetivo: enquanto o Cockpit novo está em migração/homologação, ninguém pode
 * confundir o preview da Vercel com o sistema de produção nem compartilhar com
 * operadores por engano. Só some quando VITE_APP_ENV === 'production'.
 */
export function EnvBanner() {
  const env = (import.meta.env.VITE_APP_ENV as string | undefined) ?? "homologacao";
  if (env === "production") return null;

  return (
    <div
      role="status"
      style={{
        background: "#B45309",
        color: "#fff",
        fontSize: "12px",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textAlign: "center",
        padding: "4px 8px",
        width: "100%",
      }}
    >
      ⚠ AMBIENTE DE HOMOLOGAÇÃO · Cockpit novo em migração ({env}) · NÃO é produção · não compartilhar com operadores
    </div>
  );
}
