// Só no build demo-v3 (a tela servida pelo site do roteirizador em /operacao-cockpit/): sem a
// sessão do roteirizador neste navegador, a tela não abre — a fila tem dado de cliente. Mostra
// "Entre no roteirizador primeiro" com o link do login do v3, que volta para cá.
import { useEffect, useState, type ReactNode } from "react";
import { EVENTO_SEM_SESSAO_V3, LOGIN_DO_V3, sessaoV3DoAparelho } from "@/lib/operacao/sessaoV3";

export function PortaoDemoV3({ children }: { children: ReactNode }) {
  const [comSessao, setComSessao] = useState(() => sessaoV3DoAparelho() !== null);
  useEffect(() => {
    const sem = () => setComSessao(false);
    window.addEventListener(EVENTO_SEM_SESSAO_V3, sem);
    return () => window.removeEventListener(EVENTO_SEM_SESSAO_V3, sem);
  }, []);
  if (comSessao) return <>{children}</>;
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4" data-testid="portao-demo-v3">
      <div className="max-w-md rounded-xl border bg-surface px-6 py-6 text-center shadow-sm">
        <h1 className="text-[18px] font-semibold text-ink">Entre no roteirizador primeiro</h1>
        <p className="mt-2 text-[13.5px] text-ink-soft-2">
          Esta tela mostra a fila real da Operação, com dados de cliente. Ela usa a sua conta do Roteirizador
          Inteligente (operação ou gestão).
        </p>
        <a
          href={LOGIN_DO_V3}
          className="mt-4 inline-flex items-center rounded-md bg-sal px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-sal/90"
        >
          Entrar no roteirizador
        </a>
      </div>
    </main>
  );
}
