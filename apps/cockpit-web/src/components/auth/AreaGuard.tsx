// =============================================================================
// Muro de TELA entre Relacionamento e Operação (ADR 0041 D2, INV-180).
// Decisão do dono: "Relacionamento não precisa aparecer para a Operação, nem
// vice-versa." Só o gestor vê os dois. O muro de DADOS é a RLS (migs 430/431);
// isto garante que ninguém sequer veja a rota/menu da outra área.
// =============================================================================
import { Navigate, Outlet } from "react-router-dom";
import { useAreas } from "@/contexts/OperacaoContext";
import { ROTA_OPERACAO } from "@/lib/operacao/areas";
import { OPERACAO_DEMO } from "@/lib/operacao/modoDemo";
import { rotaInicial, veHub } from "@/lib/inicio/hub";

function Carregando() {
  return (
    <div className="flex h-full items-center justify-center p-10 text-sm text-muted-foreground">
      Carregando seu acesso…
    </div>
  );
}

/** Rotas do Relacionamento (Inbox, cards, extravios…). Membro só da Operação vai para /operacao. */
export function SoRelacionamento() {
  const areas = useAreas();
  if (areas.veRelacionamento) return <Outlet />;
  if (areas.carregando) return <Carregando />;
  return <Navigate to={ROTA_OPERACAO} replace />;
}

/** Rotas da Operação. Operador do Relacionamento (não gestor) volta para o Inbox. */
export function SoOperacao() {
  const areas = useAreas();
  if (areas.podeAbrirOperacao) return <Outlet />;
  if (areas.carregandoOperacao) return <Carregando />;
  return <Navigate to="/inbox" replace />;
}

// ----------------------------------------------------------------------------
// Hub do gestor (/inicio). Acréscimo: as duas guardas acima não mudam.
// ----------------------------------------------------------------------------

/** "/" (e o destino do login): gestor → /inicio; o resto vai para onde sempre foi. */
export function RotaInicial() {
  const areas = useAreas();
  const destino = rotaInicial(areas, OPERACAO_DEMO);
  if (destino == null) return <Carregando />;
  return <Navigate to={destino} replace />;
}

/** /inicio: só gestor. Quem não é volta para "/", que decide como sempre. */
export function SoGestor() {
  const areas = useAreas();
  if (veHub(areas, OPERACAO_DEMO)) return <Outlet />;
  if (areas.carregandoOperacao) return <Carregando />;
  return <Navigate to={areas.veRelacionamento ? "/inbox" : ROTA_OPERACAO} replace />;
}
