# Prompt — Regra obrigatória de deploy seguro das Edge Functions

Crie uma regra/processo no repositório para impedir deploy inseguro de Edge Functions, especialmente `sync-bastao`.

Contexto do incidente:
- Em 02/07/2026, o `sync-bastao` ficou parado por ~19h.
- O cron continuava disparando, mas a Edge Function retornava `BOOT_ERROR`.
- Causa técnica: foi publicado um bundle inconsistente, gerado a partir de working tree/WIP, onde `sync-bastao/index.ts` importava símbolos que não existiam em `_shared/lag-lancamento-54.ts`.
- Resultado: a função nem dava boot; cards ficaram sem aparecer/desatualizados.
- O usuário final não deve conseguir autorizar deploy se a árvore local estiver suja, sem check, ou se o deploy não vier de um ref limpo.

Objetivo:
Implementar uma regra de segurança que bloqueie qualquer deploy de Edge Function crítica quando as condições abaixo não forem verdadeiras.

Regra obrigatória antes de deploy:
1. `git status --short` deve estar limpo, ou o deploy deve ser feito a partir de um diretório temporário exportado de um commit/ref limpo.
2. O comando de validação da função deve passar antes do deploy:
   - para `sync-bastao`: `deno check supabase/functions/sync-bastao/index.ts`
   - para outras funções: `deno check supabase/functions/<nome>/index.ts`
3. O deploy deve informar explicitamente:
   - commit/ref usado;
   - função que será deployada;
   - resultado do `deno check`;
   - confirmação de que não está usando working tree sujo.
4. Se qualquer item falhar, o agente deve recusar o deploy e explicar o motivo.
5. O agente nunca deve pedir autorização com frase genérica tipo “posso deployar?” sem mostrar esses checks.

Implementação desejada:
- Adicionar um comando/documento de processo no repo, preferencialmente em `.claude/commands/` ou `docs/`, chamado algo como `deploy-edge-seguro`.
- Se existir comando `/verify-cockpit`, incluir nele uma seção “Deploy Gate” que falha quando `sync-bastao` ou `_shared` crítico foi alterado e `deno check` não foi executado/passador.
- Criar um checklist curto que qualquer agente deve seguir antes de sugerir deploy.
- Opcional, se couber no padrão do repo: criar um script não destrutivo que rode:
  - `git status --short`
  - `deno check supabase/functions/<function>/index.ts`
  - imprime `PASS/FAIL`
  - não faz deploy, só valida.

Texto obrigatório para qualquer pedido de autorização de deploy:

```text
Deploy Gate:
- Função: <nome>
- Ref/commit limpo: <sha ou branch>
- Working tree usado no deploy: limpo / export temporário de ref limpo
- `deno check`: PASS
- Risco de WIP/_shared sujo: bloqueado

Só vou prosseguir se esses itens estiverem verdes.
```

Critérios de aceite:
- Deve ser impossível, pelo processo documentado, autorizar deploy de `sync-bastao` sem ver `git status` e `deno check`.
- O documento deve citar explicitamente o incidente `BOOT_ERROR` de 02/07/2026 como motivação.
- A regra deve orientar agentes a preferirem deploy a partir de ref limpo/export temporário quando o working tree principal estiver sujo.
- A regra deve dizer claramente: “não deployar de working tree sujo”.
- Não fazer deploy real nesta tarefa.
- Não alterar lógica de produção do `sync-bastao`; esta tarefa é só processo/guard.
