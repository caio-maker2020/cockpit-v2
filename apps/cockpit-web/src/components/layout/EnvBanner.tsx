/**
 * Banner de identificação do front novo (piloto).
 *
 * Aparece enquanto VITE_APP_ENV !== 'production' (some só quando o front novo
 * virar a produção oficial). Objetivo: deixar VISÍVEL, num olhar ou screenshot,
 * qual é o estado de segurança do piloto.
 *
 * IMPORTANTE: o front novo fala com o MESMO Supabase de produção que o Lovable.
 * Não existe banco de teste separado. Por isso o banner NUNCA diz "não é
 * produção": os dados são de produção. O que muda é se as AÇÕES estão travadas:
 *   - ACOES_DESABILITADAS = true  -> somente leitura, nada sai pro SSW/e-mail (verde).
 *   - ACOES_DESABILITADAS = false -> ações REAIS: lançamento no SSW e e-mail pro
 *     cliente acontecem de verdade, nos mesmos cards da operação (vermelho).
 *
 * Layout: banner de segurança não pode sumir no scroll. `position: sticky` não
 * segura aqui porque #root/body colapsam de altura (o autoFocus da tela de login
 * rolava a página e escondia o aviso). Então é `position: fixed` no topo + um
 * espaçador invisível com o MESMO texto logo abaixo, pra reservar exatamente a
 * altura do banner (inclusive quando ele quebra em duas linhas em tela estreita).
 */
import { ACOES_DESABILITADAS } from "@/lib/supabase";

const boxStyle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textAlign: "center",
  padding: "4px 8px",
  width: "100%",
  boxSizing: "border-box",
};

export function EnvBanner() {
  const env = (import.meta.env.VITE_APP_ENV as string | undefined) ?? "homologacao";
  if (env === "production") return null;

  const texto = ACOES_DESABILITADAS
    ? "🔒 PILOTO · front novo (fora do Lovable) · SOMENTE LEITURA: nenhuma ação vai pro SSW ou e-mail"
    : "⚠ PILOTO · front novo (fora do Lovable) · AÇÕES REAIS: lançamento no SSW e e-mail pro cliente vão pra PRODUÇÃO";

  return (
    <>
      {/* Fixo no topo do viewport: nunca some, independente do scroll/layout. */}
      <div
        role="status"
        style={{
          ...boxStyle,
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          background: ACOES_DESABILITADAS ? "#047857" : "#B91C1C",
          color: "#fff",
        }}
      >
        {texto}
      </div>
      {/* Espaçador em fluxo, mesmo conteúdo: empurra o app pra baixo do banner
          com a altura exata (some visualmente, mas ocupa o espaço). */}
      <div aria-hidden style={{ ...boxStyle, visibility: "hidden" }}>
        {texto}
      </div>
    </>
  );
}
