# /f6-mergear <número-do-PR> — merge de melhoria da F6 (SÓ com ordem do Caio)

O comando que o Caio roda no chat pra efetivar uma melhoria aprovada:
`/f6-mergear 12`. Executa o ciclo completo com os gates da casa.

## Procedimento (na ordem, sem pular)

1. **Mostrar o PR antes de qualquer coisa** (o Caio decide vendo):
   ```bash
   gh pr view <numero> --json title,body,files --jq '.title, .body' | head -40
   ```
   Confirmar que o corpo tem o LAUDO DO REPLAY com veredito MELHORA.
   Sem laudo ou veredito ≠ MELHORA → PARAR e avisar (não mergear).

2. **Merge** (squash, apaga a branch):
   ```bash
   gh pr merge <numero> --squash --delete-branch
   ```

3. **Deploy da função alterada a partir do master limpo** (deploy-gate):
   ```bash
   set -a && source .env.local && set +a
   git fetch origin master
   TMP=$(mktemp -d) && git worktree add "$TMP" origin/master
   cd "$TMP" && deno check supabase/functions/<funcao-alterada>/index.ts
   supabase functions deploy <funcao-alterada> --project-ref xjbycvscljqoqpjkmevb
   cd - && git worktree remove --force "$TMP"
   ```
   (A função alterada está nos arquivos do PR — passo 1.)

4. **Sincronizar a branch de trabalho** (se a criacao-agente-chefe ainda viver):
   ```bash
   git merge origin/master --no-edit
   ```

5. **Fechar o ciclo no banco** — marcar o ajuste como aplicado:
   ```bash
   psql "$SUPABASE_DB_URL" -c "
     UPDATE learning_log
     SET status='aplicado',
         detalhes = detalhes || jsonb_build_object('mergeado_em', now()::text)
     WHERE agente='agente-aprendizado' AND tipo='ajuste_sugerido'
       AND detalhes->>'pr_url' LIKE '%/<numero>';"
   ```

6. **Reportar ao Caio**: o que entrou, função redeployada, e lembrar que o
   impacto aparece em ~7 dias na seção "Suas respostas estão ensinando?".

## Regras duras
- SÓ rodar quando o Caio pedir explicitamente (é a assinatura dele).
- Veredito do replay ≠ MELHORA → não mergear, reabrir conversa.
- Nunca `--admin`/force; falha em qualquer passo → parar e reportar.
