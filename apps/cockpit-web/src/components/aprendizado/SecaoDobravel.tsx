import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// Seção que o gestor pode fechar (Caio 2026-08-13). A aba Aprendizado é uma
// página longa por escolha — placar, dia a dia, chat e melhorias na mesma tela.
// Sem poder fechar o que não interessa agora, vira poluição.
//
// A preferência fica no localStorage por seção: fechou uma vez, continua fechada
// na próxima visita. Mesmo padrão já usado pelos chats desta aba.

export function SecaoDobravel({
  id,
  titulo,
  resumo,
  hint,
  padraoAberto = true,
  children,
}: {
  /** chave da preferência — não mudar depois de publicado, senão reseta */
  id: string;
  titulo: string;
  /** aparece no cabeçalho quando FECHADA: o número não some ao dobrar */
  resumo?: ReactNode;
  hint?: string;
  padraoAberto?: boolean;
  children: ReactNode;
}) {
  const chave = `aprendizado-secao-${id}`;
  const [aberto, setAberto] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(chave);
      return v === null ? padraoAberto : v === "1";
    } catch {
      return padraoAberto;
    }
  });

  const alternar = () => {
    setAberto((v) => {
      try {
        localStorage.setItem(chave, v ? "0" : "1");
      } catch { /* sem storage, sem memória */ }
      return !v;
    });
  };

  return (
    <section aria-label={titulo} className="mb-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={alternar}
          aria-expanded={aberto}
          className="group flex items-center gap-1.5 rounded text-left"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-ink-mute transition-transform ${
              aberto ? "" : "-rotate-90"
            }`}
            aria-hidden
          />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-mute group-hover:text-ink">
            {titulo}
          </span>
          {/* fechada: o essencial continua visível */}
          {!aberto && resumo && (
            <span className="ml-1.5 font-mono text-[11px] tabular-nums text-ink-soft">{resumo}</span>
          )}
        </button>
        {aberto && hint && <span className="text-[11px] text-ink-mute">{hint}</span>}
      </div>
      {aberto && children}
    </section>
  );
}
