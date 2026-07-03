import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const ADMIN_EMAIL = "caio@salexpress.com.br";

interface OperadorAdmin {
  id: number;
  nome: string;
  email: string | null;
  papel: string | null;
  cockpit_ativo: boolean;
  tem_login: boolean;
}

export default function Administracao() {
  const { user } = useAuth();
  const [editing, setEditing] = useState<OperadorAdmin | null>(null);

  if (!user || user.email?.toLowerCase() !== ADMIN_EMAIL) {
    return <Navigate to="/inbox" replace />;
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-operadores"],
    enabled: !!supabase,
    queryFn: async () => {
      const { data, error } = await supabase!.functions.invoke("admin-operadores", {
        body: { action: "listar" },
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error ?? "Falha ao listar operadores");
      return data.operadores as OperadorAdmin[];
    },
  });

  return (
    <div className="p-6">
      <header className="mb-6">
        <h1 className="font-display text-h1" style={{ color: "var(--c-ink)" }}>
          Administração
        </h1>
        <p className="font-body text-body" style={{ color: "var(--c-ink-soft)" }}>
          Gerenciar credenciais de acesso dos operadores.
        </p>
      </header>

      <div
        className="rounded-md"
        style={{ border: "1px solid var(--c-border)", background: "var(--bg)" }}
      >
        {isLoading ? (
          <div className="flex items-center gap-2 p-6 font-body text-body" style={{ color: "var(--c-ink-soft)" }}>
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando operadores…
          </div>
        ) : error ? (
          <div className="p-6 font-body text-body text-destructive">
            {(error as Error).message}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>E-mail (login)</TableHead>
                <TableHead>Papel</TableHead>
                <TableHead>Tem login?</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((op) => (
                <TableRow key={op.id}>
                  <TableCell className="font-medium">{op.nome}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {op.email ?? <span style={{ color: "var(--c-ink-mute)" }}>—</span>}
                  </TableCell>
                  <TableCell>{op.papel ?? "—"}</TableCell>
                  <TableCell>
                    {op.tem_login ? (
                      <Badge variant="secondary">Sim</Badge>
                    ) : (
                      <Badge variant="outline">Não</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(op)}>
                      <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                      Editar credenciais
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center" style={{ color: "var(--c-ink-mute)" }}>
                    Nenhum operador encontrado.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {editing && (
        <EditarCredenciaisDialog
          operador={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EditarCredenciaisDialog({
  operador,
  onClose,
}: {
  operador: OperadorAdmin;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [novoEmail, setNovoEmail] = useState(operador.email ?? "");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmaSenha, setConfirmaSenha] = useState("");
  const [mostrarSenha, setMostrarSenha] = useState(false);

  const semLogin = !operador.tem_login;

  const mutation = useMutation({
    mutationFn: async () => {
      const emailMudou = novoEmail.trim() && novoEmail.trim() !== (operador.email ?? "");
      const body: Record<string, unknown> = {
        action: "set_credenciais",
        operador_id: operador.id,
      };
      if (semLogin) {
        if (!novoEmail.trim() || !novaSenha) {
          throw new Error("Para criar o acesso, informe e-mail e senha.");
        }
        body.novo_email = novoEmail.trim();
        body.nova_senha = novaSenha;
      } else {
        if (!emailMudou && !novaSenha) {
          throw new Error("Informe um novo e-mail ou uma nova senha.");
        }
        if (emailMudou) body.novo_email = novoEmail.trim();
        if (novaSenha) body.nova_senha = novaSenha;
      }
      if (novaSenha) {
        if (novaSenha.length < 8) throw new Error("Senha deve ter pelo menos 8 caracteres.");
        if (novaSenha !== confirmaSenha) throw new Error("Confirmação de senha não confere.");
      }
      const { data, error } = await supabase!.functions.invoke("admin-operadores", {
        body,
      });
      if (error) throw new Error(error.message);
      if (!data?.ok) throw new Error(data?.error ?? "Falha ao atualizar credenciais.");
      return data;
    },
    onSuccess: () => {
      toast.success("Credenciais atualizadas");
      queryClient.invalidateQueries({ queryKey: ["admin-operadores"] });
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar credenciais — {operador.nome}</DialogTitle>
          <DialogDescription>
            {semLogin
              ? "Este operador ainda não tem acesso — informe e-mail e senha para criar o login."
              : "Atualize o e-mail (login) e/ou a senha. Preencha apenas o que quiser alterar."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="novo-email">Novo e-mail (login){semLogin && " *"}</Label>
            <Input
              id="novo-email"
              type="email"
              autoComplete="off"
              value={novoEmail}
              onChange={(e) => setNovoEmail(e.target.value)}
              placeholder="email@exemplo.com"
              required={semLogin}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nova-senha">Nova senha{semLogin && " *"}</Label>
            <div className="relative">
              <Input
                id="nova-senha"
                type={mostrarSenha ? "text" : "password"}
                autoComplete="new-password"
                value={novaSenha}
                onChange={(e) => setNovaSenha(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                minLength={novaSenha ? 8 : undefined}
                required={semLogin}
              />
              <button
                type="button"
                onClick={() => setMostrarSenha((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-label={mostrarSenha ? "Ocultar senha" : "Mostrar senha"}
              >
                {mostrarSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirma-senha">Confirmar nova senha{semLogin && " *"}</Label>
            <Input
              id="confirma-senha"
              type={mostrarSenha ? "text" : "password"}
              autoComplete="new-password"
              value={confirmaSenha}
              onChange={(e) => setConfirmaSenha(e.target.value)}
              placeholder="Repita a senha"
              required={semLogin || !!novaSenha}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
