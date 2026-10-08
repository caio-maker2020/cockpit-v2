// Estados da tela da Operação (carregando, vazio, erro) num só molde: ícone, título curto,
// uma linha do que fazer. Erro nunca pede desculpa; diz o que houve e o que acontece agora.
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function EstadoOperacao({
  tipo,
  titulo,
  texto,
  icone,
  compacto = false,
  children,
}: {
  tipo: "carregando" | "vazio" | "erro";
  titulo: string;
  texto?: string;
  icone?: React.ReactNode;
  compacto?: boolean;
  children?: React.ReactNode;
}) {
  const Icone = tipo === "carregando" ? Loader2 : tipo === "erro" ? AlertTriangle : Inbox;
  return (
    <div
      role={tipo === "erro" ? "alert" : "status"}
      className={cn("mx-auto flex max-w-md flex-col items-center px-6 text-center", compacto ? "py-14" : "h-full justify-center py-24")}
    >
      <span
        className="grid h-11 w-11 place-items-center rounded-full"
        style={{
          background: tipo === "erro" ? "var(--signal-soft)" : "var(--bg-subtle)",
          color: tipo === "erro" ? "var(--signal-strong)" : "var(--c-ink-soft)",
        }}
      >
        {icone ?? <Icone className={cn("h-5 w-5", tipo === "carregando" && "animate-spin motion-reduce:animate-none")} aria-hidden />}
      </span>
      <p className="mt-3 text-[15px] font-semibold text-ink-2" style={{ textWrap: "balance" }}>
        {titulo}
      </p>
      {texto && (
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft-2" style={{ textWrap: "pretty" }}>
          {texto}
        </p>
      )}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
