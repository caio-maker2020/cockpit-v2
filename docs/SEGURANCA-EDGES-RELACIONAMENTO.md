# Porta do Relacionamento nas edges (INV-190)

Desde 08/10/2026 as edges que agem sobre card ou cliente e são chamadas pelo front
(`atualizar-card-via-portal-ssw`, `puxar-historico-ssw-card`, `enviar-retificacao-evidencia`,
`cobrar-cliente-aguardando`, `send-whatsapp-message`) só atendem:

- **service_role** (cron, edge-to-edge, scripts do trilho) — todos os chamadores internos
  mandam `Bearer SUPABASE_SERVICE_ROLE_KEY`; chave rotacionada/nova passa pela prova de
  capacidade (Admin API do Auth);
- **operador ativo** em `operadores` (inclui gestor), com o JWT conferido por `auth.getUser`.

Quem tem login mas não está em `operadores` (os membros da Operação) recebe 403
`NAO_MEMBRO_RELACIONAMENTO`. No WhatsApp, operador comum só envia pela própria instância.

Para uma edge nova do Relacionamento:

```ts
import { exigirMembroRelacionamento } from "../_shared/exigir-membro-relacionamento.ts";
// depois do preflight CORS / checagem de método:
const porta = await exigirMembroRelacionamento(req, { corsHeaders });
if (!porta.ok) return porta.resposta;
```

e acrescente o nome dela em `EDGES` de `_shared/exigir-membro-relacionamento.fiacao.test.ts`.
