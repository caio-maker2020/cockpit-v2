import { cn } from "@/lib/utils";

/**
 * Fileira horizontal de lanes do cockpit. Extraída do container do kanban do
 * Inbox aprovado (`flex h-full gap-4 overflow-x-auto p-4`). Usada por Inbox e
 * Extravios pra garantir a MESMA densidade/gap/scroll entre os boards.
 */
export function CockpitBoard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full gap-4 overflow-x-auto p-4", className)}>{children}</div>
  );
}
