# /f6-aplicar-melhorias — Agente de Repositório do Loop de Aprendizado (F6)

Transforma melhorias APROVADAS na fila do painel Aprendizado em mudança de
prompt/regra TESTADA POR REPLAY + PR. Envelope da spec (§5/D6): propor é do
agente-chefe, aprovar é da Isadora/Caio no painel, **este comando executa os
aprovados**, e o **merge do PR é exclusivo do Caio**. NUNCA mergear aqui.

## Procedimento (siga na ordem, sem pular)

1. **Ler a fila de aprovados** (só `status='aprovado'`, sem PR ainda):
   ```bash
   set -a && source .env.local && set +a
   psql "$SUPABASE_DB_URL" -At -c "
     SELECT id, agente_alvo, prompt_alvo, resumo, detalhes->>'chave_padrao'
     FROM learning_log
     WHERE agente='agente-aprendizado' AND tipo='ajuste_sugerido'
       AND status='aprovado' AND (detalhes->>'pr_url') IS NULL;"
   ```
   Fila vazia → reportar e encerrar.

2. **Pra cada ajuste**: ler a resposta-mãe (parent_id) COM as
   `respostas_estruturadas` e prints; ler o arquivo/prompt alvo indicado em
   `prompt_alvo`; escrever a mudança MÍNIMA que implementa a regra aprendida
   (prompt/caso de ouro/template — NUNCA árvore/código sem ordem explícita
   do Caio; se a regra exigir código, marcar `status='observacao'` com
   motivo "exige mudança de código — decisão do Caio" e pular).

3. **Replay obrigatório antes do PR**:
   ```bash
   deno run --allow-net --allow-env evals/replay-regras.ts \
     --chave "<chave_padrao>" --regra "<regra aprovada em 1 frase>" --limit 20
   ```
   - MELHORA → segue. EMPATE/PIORA → NÃO abre PR; registrar no learning_log
     (`revisar_learning_log` → observacao com o laudo) e avisar o Caio.

4. **Branch + PR** (nunca na master):
   ```bash
   git checkout -b f6/<chave_padrao-slug> origin/master
   # aplica o diff, commita com o laudo do replay no corpo
   git push -u origin f6/<chave_padrao-slug>
   gh pr create --title "f6: <regra curta>" --body "<laudo replay + link learning_log>"
   ```

5. **Fechar o ciclo no banco**: gravar `detalhes.pr_url` e `status='aplicado'`
   na linha do ajuste (UPDATE via psql, service). O agente-chefe mede o
   impacto automaticamente 7 dias após o merge (seção "Suas respostas estão
   ensinando?" do painel).

## Regras duras
- Merge é SÓ do Caio. Este comando nunca mergeia, nunca deploya.
- Replay com mínimo de 5 casos; sem volume → não conclui, não abre PR.
- Um PR por ajuste (pequeno e revisável).
- Deploy da função alterada segue o deploy-gate normal (código commitado).
