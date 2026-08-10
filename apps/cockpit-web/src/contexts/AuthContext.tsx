import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import type { OperadorRow } from "@/lib/types";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  operador: OperadorRow | null;
  loading: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithMagicLink: (email: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [operador, setOperador] = useState<OperadorRow | null>(null);
  const [loading, setLoading] = useState<boolean>(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    // Subscribe BEFORE getSession.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) setOperador(null);
    });

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // Resolve operador.id a partir de auth.uid() — uma vez por sessão.
  useEffect(() => {
    if (!supabase || !session?.user) {
      setOperador(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let { data, error } = await supabase!
        .from("operadores")
        .select("id,user_id,nome,email,papel,carteira,ativo,pode_executar")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (error) {
        // Fallback: front no ar antes da mig 324 (coluna pode_executar ausente)
        // não pode derrubar a sessão de todos — recarrega sem a coluna.
        ({ data, error } = await supabase!
          .from("operadores")
          .select("id,user_id,nome,email,papel,carteira,ativo")
          .eq("user_id", session.user.id)
          .maybeSingle());
      }
      if (cancelled) return;
      if (error) {
        console.error("[auth] erro ao carregar operador:", error.message);
        setOperador(null);
        return;
      }
      const row = data as (Omit<OperadorRow, "pode_executar"> & { pode_executar?: boolean }) | null;
      setOperador(row ? { ...row, pode_executar: row.pode_executar ?? true } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const signIn: AuthContextValue["signIn"] = async (email, password) => {
    if (!supabase) return { error: "Supabase não está conectado." };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signInWithMagicLink: AuthContextValue["signInWithMagicLink"] = async (email) => {
    if (!supabase) return { error: "Supabase não está conectado." };
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/inbox` },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    // Zera TODO o cache do React Query. Sem isto, num handoff no mesmo browser
    // (turno trocando), o próximo operador pode ver dados do anterior servidos
    // do cache por até gcTime (5 min): caches keyados só por recurso como
    // ["card", id] e ["oc-labels"] não têm operador na key. `clear()` também
    // cancela queries em voo. É defensivo; o RLS ainda filtra no refetch.
    queryClient.clear();
  };

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    operador,
    loading,
    configured: isSupabaseConfigured,
    signIn,
    signInWithMagicLink,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
