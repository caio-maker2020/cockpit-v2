import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * INV-155 — os dois dados que a tela precisa pra decidir se o clique da oc 33
 * abre o pop-up "o cliente informou no e-mail ou em anexo?".
 *
 * Fonte ÚNICA (Carlos 2026-10-09, NF 387252): a lista de validação humana e o
 * cartão simples (cards fora de AGUARDANDO_VALIDACAO_HUMANA) leem daqui. Antes
 * só a lista tinha estas consultas, e o cartão simples nascia sem pop-up.
 * As chaves de cache são as mesmas de antes — as duas telas dividem o resultado.
 */
export function usePopupConfirmaOc33(cardId: string): {
  flagConfirma33: boolean | undefined;
  temAnexoNoCard: boolean | undefined;
} {
  // A chave nasce FALSE (mig 402). Desligada, nada muda: o botao segue cinza
  // exatamente como hoje. A edge function recusa por conta propria mesmo assim.
  const { data: flagConfirma33 } = useQuery({
    queryKey: ["flag-popup-confirma-dossie-oc33"],
    enabled: !!supabase,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase!
        .from("feature_flags")
        .select("enabled")
        .eq("key", "popup_confirma_dossie_oc33_enabled")
        .maybeSingle();
      return data?.enabled === true;
    },
  });
  // Regra do Carlos: o pop-up so aparece se houver ANEXO do cliente no card.
  // Mesma consulta que a edge function faz, pra tela e servidor nunca
  // discordarem sobre "este card tem anexo".
  const { data: temAnexoNoCard } = useQuery({
    queryKey: ["card-tem-anexo-inbound", cardId],
    enabled: !!supabase && flagConfirma33 === true,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data: msgs } = await supabase!
        .from("messages_inbox")
        .select("id")
        .eq("card_id", cardId);
      const ids = (msgs ?? []).map((m: { id: string }) => m.id);
      if (!ids.length) return false;
      const { count } = await supabase!
        .from("email_anexos")
        .select("id", { count: "exact", head: true })
        .in("message_inbox_id", ids)
        .eq("origem", "inbound")
        .is("deletado_em", null);
      return (count ?? 0) > 0;
    },
  });
  return { flagConfirma33, temAnexoNoCard };
}
