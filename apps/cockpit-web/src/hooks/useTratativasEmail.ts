import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

export interface TratativaMensagem {
  direcao: "inbound" | "outbound";
  endereco: string;
  assunto: string;
  ts: string;
  preview: string;
  eh_msg_ia: boolean;
}

export interface Tratativa {
  gmail_thread_id: string;
  assunto: string;
  participantes: string[];
  responder_para: string | null;
  qtd_mensagens: number;
  primeiro_em: string;
  ultimo_em: string;
  analisada_pela_ia: boolean;
  aguardando_resposta: boolean;
  escolhida: boolean;
  mensagens: TratativaMensagem[];
}

export interface TratativasEmailData {
  card_id: string;
  total_tratativas: number;
  tratativas_ativas: number;
  multiplas_tratativas: boolean;
  tratativa_escolhida: string | null;
  tratativas: Tratativa[];
}

export const tratativasEmailKey = (cardId: string) => ["tratativas-email", cardId];

export function useTratativasEmail(cardId: string) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: tratativasEmailKey(cardId),
    enabled: !!supabase && !!cardId,
    queryFn: async () => {
      const { data, error } = await supabase!.rpc("listar_tratativas_email_do_card", {
        p_card_id: cardId,
      });
      if (error) throw error;
      return (data ?? null) as TratativasEmailData | null;
    },
  });

  const escolher = useMutation({
    mutationFn: async (threadId: string | null) => {
      if (!supabase) throw new Error("Sem conexão");
      const { error } = await supabase.rpc("escolher_tratativa_email", {
        p_card_id: cardId,
        p_thread_id: threadId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tratativasEmailKey(cardId) });
    },
    onError: (err: any) =>
      toast.error("Erro ao escolher tratativa", {
        description: err?.message ?? "Tente novamente",
      }),
  });

  return { ...query, escolher };
}

/** Lê o cache da RPC pra usar em fluxos de aprovação sem disparar nova request. */
export function getTratativasFromCache(
  qc: ReturnType<typeof useQueryClient>,
  cardId: string,
): TratativasEmailData | null {
  return (qc.getQueryData(tratativasEmailKey(cardId)) as TratativasEmailData | null) ?? null;
}

/** Retorna o `responder_para` da tratativa escolhida (ou null). */
export function getResponderParaEscolhido(d: TratativasEmailData | null): string | null {
  if (!d || !d.multiplas_tratativas || !d.tratativa_escolhida) return null;
  const t = d.tratativas.find((x) => x.gmail_thread_id === d.tratativa_escolhida);
  return t?.responder_para ?? null;
}
