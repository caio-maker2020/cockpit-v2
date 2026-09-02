# ADR 0019 — Ritual de deploy portátil e autonomia operacional do Carlos

Data: 2026-09-02
Status: Aceito (Caio, sessão Claude Code de 02/09)

## Contexto

O Carlos é o responsável por criar funcionalidades e corrigir bugs do Cockpit.
Ao fechar a feature da devolução com CT-e da MARIA (ADR 0018), o ritual travou
na máquina dele com a tela "Opção A — libere a permissão / Opção B — cole o SQL
no painel". Diagnóstico com evidência (não palpite):

1. **O ritual só existia na máquina do Caio.** `/verify-cockpit` fazia `cd` num
   caminho fixo do Mac (que nem existe mais), usava
   `/opt/homebrew/opt/libpq/bin/psql`, e as regras `permissions.allow` que deixam
   o Claude rodar sem prompt moravam no `~/.claude/settings.json` pessoal do
   Caio. O `.claude/settings.json` do repo só tinha hooks. No Windows do Carlos:
   sem psql, invariantes de banco em SKIP, Claude improvisando um `run_sql.py`
   fora do repo, classificador do modo automático barrando — e a leitura errada
   de que a liberação dependia do Caio (no modo automático o que o classificador
   nega vira bloqueio, não prompt; a saída é regra no repo ou troca de modo).
2. **O ritual não media deploy pendente.** A Fase 7 listava "5 funções mais
   recentes" e nem rodava (`updated_at` da API é epoch em ms; o script fazia
   `[:19]` numa int). Ninguém calculava quem importa um `_shared/` alterado.
   Resultado: `vinculador`, `scan-email-pre-card` e `cron-ia-resposta-pendentes`
   ficaram 6 dias com bundle de 26/08 depois da cerca da 44 sem CT-e entrar em
   `propostas-pos-resposta-cliente.ts`. Medido depois com a ferramenta nova: 10
   funções com produção atrás do git, algumas desde julho.
3. **A política dizia "TIPO B e flags só o Caio"** (docs/POLITICA_MIGRATIONS.md
   26/08; ADR 0018 §12; regra de 21/08). Mesmo com ferramenta perfeita o Carlos
   dependeria do Caio por regra.

## Decisão

1. **Trilho único e portátil de SQL: `scripts/dbq.py`.** Sem dependência fora
   da stdlib. Usa `psql` se houver; senão a Management API. Mesma forma de
   chamada do psql (`-c`/`-f`, `-tA`), então o `$PSQL` do ritual aponta pra ele
   via `scripts/psql-shim.sh` quando não há psql. Classificador TIPO A/B
   embutido (com consulta ao banco pra saber se `CREATE OR REPLACE` substitui
   objeto existente; corpos de função não contam, `DO` conta). TIPO B só roda
   com `--autorizado-por`, impresso no log. `--dry-run` embrulha em
   `BEGIN...ROLLBACK` e RECUSA arquivo com COMMIT interno (armadilha da mig 337).
   `--selftest` é o guard anti-regressão do classificador (Fase 7.1).
2. **`scripts/deploy_pendente.py`**: por função, último commit do conjunto
   (pasta + todo `_shared` alcançável por import, transitivo) contra o
   `updated_at` da API. Conservador de propósito (mudança só de comentário
   acusa). Exit 1 com pendência; `--comando` imprime o deploy exato. Fase 7.1
   do ritual: PASS só com zero pendentes ou pendência escrita com motivo.
3. **`scripts/ritual-env.sh`** substitui os 4 preâmbulos hardcoded do
   `/verify-cockpit`: acha o `.env.local` (checkout, checkout principal do
   worktree, pai), define `$PSQL`, exporta `CLAUDE_PROJECT_DIR`.
4. **Permissões no repo (`.claude/settings.json`)**: `allow` exatamente pro
   trilho (dbq, deploy_pendente, `supabase functions deploy/list`, testes, git
   push/commit/fetch, `gh pr`) e `deny` pro que é proibido por combinado
   (`vercel deploy --prod`, force push). Valem pra qualquer máquina após o
   diálogo de confiança do projeto; pulam o classificador do modo automático;
   os hooks (deploy-gate, guard destrutivo) continuam rodando por cima.
5. **Política revisada**: o Carlos autoriza e aplica TIPO A, TIPO B e flags
   sozinho, pelo trilho, com autorização declarada. O Caio é informado, não é
   gate. `docs/POLITICA_MIGRATIONS.md` e ADR 0018 §12 atualizados. Nada é
   lançado à mão no Supabase/Vercel/GitHub — regra do Caio: "100% por ele e
   sem lançar nada manual".
6. **Guard DEGRAU-ATUAL** substitui o DEGRAU-0: aceita qualquer degrau válido
   da escada do ADR 0018 e recusa conjunto incoerente.

## Consequências

- O que trava o Carlos agora é evidência (gate, classificador, guard), nunca
  ausência de ferramenta ou de permissão pessoal do Caio.
- Risco assumido: o Carlos passa a poder mutar dado de produção sem o par de
  olhos do Caio. Mitigação: registro obrigatório (`--autorizado-por` +
  migration + commit), dry-run, hook destrutivo pedindo confirmação em
  `DROP`/`TRUNCATE`, e `card_events` nunca apagado em rollback.
- `deploy_pendente.py` expõe dívida antiga: funções atrás do git desde julho.
  Cada uma precisa de decisão (deployar ou registrar "de propósito").
- O `schema_migrations` (scripts/apply_migrations.py) está morto desde a mig
  333 (12/08). Não foi ressuscitado aqui; `migration/` + git continuam sendo a
  fonte da verdade do que foi aplicado. Reavaliar à parte.

## Como validar

`python3 scripts/dbq.py --selftest` OK; `DBQ_FORCE_API=1 python3 scripts/dbq.py
-f migration/X.sql --dry-run` roda sem psql; `python3 scripts/deploy_pendente.py`
zera após deploy; `/verify-cockpit` na máquina do Carlos sem SKIP de banco.
