import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useFiltroOperadorStore } from "@/stores/useFiltroOperadorStore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TODOS = "__todos__";

/**
 * Dropdown global de filtro por operador. Visível APENAS para gestor.
 */
export function FiltroOperadorAdmin() {
  const { operador } = useAuth();
  const isGestor = operador?.papel === "gestor";
  const { operadorId, setFiltro } = useFiltroOperadorStore();

  const { data: operadores = [] } = useQuery({
    queryKey: ["operadores-ativos-filtro"],
    enabled: isGestor && !!supabase,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase!
        .from("operadores")
        .select("id, nome")
        .eq("cockpit_ativo", true)
        .order("nome");
      if (error) throw error;
      return (data ?? []) as { id: string; nome: string }[];
    },
  });

  if (!isGestor) return null;

  const value = operadorId ?? TODOS;

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <Users className="h-3.5 w-3.5" style={{ color: "var(--c-ink-mute)" }} />
      <Select
        value={value}
        onValueChange={(v) => {
          if (v === TODOS) {
            setFiltro(null, null);
          } else {
            const op = operadores.find((o) => o.id === v);
            setFiltro(v, op?.nome ?? null);
          }
        }}
      >
        <SelectTrigger
          className="h-7 w-[200px] rounded-md border bg-transparent font-mono text-[11px] uppercase tracking-widest"
          style={{ borderColor: "var(--c-border)", color: "var(--c-ink)" }}
        >
          <SelectValue placeholder="Todos os operadores" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={TODOS}>Todos os operadores</SelectItem>
          {operadores.map((op) => (
            <SelectItem key={op.id} value={op.id}>
              {op.nome}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
