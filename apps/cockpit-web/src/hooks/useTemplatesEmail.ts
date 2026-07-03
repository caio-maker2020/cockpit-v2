import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface TemplateEmailAtivo {
  id: string;
  nome: string;
  descricao: string | null;
}

/**
 * Lista TODOS os templates de email ativos.
 * Usado pelos composers/modals de aprovação oc=54+email pra permitir
 * que o operador escolha qualquer template em qualquer oc.
 */
export function useTemplatesEmail() {
  return useQuery({
    queryKey: ["templates-email-ativos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("templates_email")
        .select("id, nome, descricao")
        .eq("ativo", true)
        .order("id");
      if (error) throw error;
      return (data ?? []) as TemplateEmailAtivo[];
    },
    staleTime: 5 * 60_000,
  });
}
