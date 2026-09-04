# Ritual de deploy do Cockpit — em QUALQUER máquina (Caio, Carlos, quem vier)

Escrito em 2026-09-02, depois que o ritual travou na máquina do Carlos. Motivo
registrado: o `/verify-cockpit` fazia `cd` num caminho fixo do Mac do Caio,
chamava o `psql` do homebrew, e as permissões que deixam o Claude rodar o trilho
sem prompt moravam no `~/.claude/settings.json` pessoal do Caio. No Windows
nada disso existia: os invariantes de banco viravam SKIP, o Claude improvisava
um `run_sql.py` fora do repo, o classificador do modo automático barrava, e a
conclusão errada era "preciso do Caio pra liberar".

**Regra de ouro deste documento: se o Claude pedir permissão no meio do ritual,
ele saiu do trilho. Não invente script, não cole SQL no painel do Supabase.
Volte pro comando do trilho.** Nada é lançado à mão no Supabase, na Vercel ou
no GitHub — tudo passa por script versionado neste repo.

## 0. Preparar a máquina (uma vez)

1. `git clone` do repo e `python3` (3.10+) no PATH. Não precisa de `psql`.
   Se tiver, é usado; se não, o `scripts/dbq.py` fala com a Management API.
2. `supabase` CLI instalado e `deno` (pro type check).
3. `.env.local` na raiz do checkout (nunca commitado; o `.gitignore` já cobre) com:
   - `SUPABASE_DB_URL` (conexão direta, role postgres) **e/ou**
   - `SUPABASE_ACCESS_TOKEN` (token da Management API — obrigatório pro deploy
     de edge function e pro `deploy_pendente.py`; é o que substitui o psql).
   - `SUPABASE_URL` (o `dbq.py` tira o project ref daqui).
4. Abrir o repo no Claude Code e **aceitar o diálogo de confiança do projeto**.
   É ele que ativa as regras `permissions.allow` do `.claude/settings.json`,
   que liberam exatamente o trilho abaixo e nada mais. Sem aceitar, o
   classificador do modo automático volta a barrar.
5. Conferir: `python3 scripts/dbq.py -c "select 1;"` responde `1` sem prompt.

## 1. O trilho (comandos canônicos — só estes tocam produção)

| O quê | Comando | Guard que roda por cima |
|---|---|---|
| Ler o banco | `python3 scripts/dbq.py -c "select ...;"` | — |
| Simular migration | `python3 scripts/dbq.py -f migration/X.sql --dry-run` | recusa arquivo com COMMIT interno |
| Aplicar migration TIPO A | `python3 scripts/dbq.py -f migration/X.sql` | classificador A/B |
| Aplicar migration TIPO B / ligar flag | `python3 scripts/dbq.py -f migration/X.sql --autorizado-por "<quem>, <quando>: <ordem>"` | exige a declaração; hook destrutivo (`DROP`/`TRUNCATE`) ainda pede confirmação |
| Saber o que falta deployar | `python3 scripts/deploy_pendente.py` | — |
| Deployar edge functions | `supabase functions deploy <fn...> --project-ref xjbycvscljqoqpjkmevb` | `deploy-gate` (checkout atrás do master, sujo, marcador crítico ausente, função proibida) |
| Front (Vercel) | `git push` na `master` | deploy automático; **`vercel deploy --prod` é proibido** |

`$PSQL` dentro do `/verify-cockpit` aponta pro `psql` real ou pro
`scripts/psql-shim.sh` (que delega ao `dbq.py`) — o ritual não precisa saber.

## 2. A sequência, do commit à contraprova

1. **Testar** o que mudou (`bun test`, `deno check`, testes do front se tocou front).
2. **Commitar** só os arquivos seus (nunca `git add -A` em trabalho paralelo).
   Migration nova: número sequencial livre (conferir colisão com branches
   remotas: `git fetch && git ls-tree -r --name-only origin/<branch> migration/`),
   sem `BEGIN/COMMIT` interno, comentário do porquê, receita de reversão.
3. **`/verify-cockpit`** completo. Cada fase PASS/FAIL. SKIP de banco numa
   máquina com `.env.local` configurado é sinal de trilho quebrado, não de "ok".
4. **Push + PR + merge na `master`** (o PR precisa passar o workflow
   `branch-atualizada`). Produção nunca fica à frente do git.
5. **Banco:** `dbq.py -f ... --dry-run`, depois aplicar. TIPO B: com
   `--autorizado-por`, e a mesma frase vai no comentário da migration e no commit.
6. **Edge functions:** `python3 scripts/deploy_pendente.py --comando` imprime o
   deploy exato. Rodar a partir da `master` atualizada. O `deploy-gate` confere.
   **REGRA ABSOLUTA (Caio 04/09): deployar TUDO que o script listar — NUNCA
   deixar função de fora, nem "de propósito", nem com justificativa técnica.**
   Caso real que criou a regra: 03/09, 4 edges ficaram fora por análise manual
   ("só usam normalizeNf, que não mudou") que estava ERRADA pra 2 delas —
   produção rodou 18h com o parser de extravio forte nos agentes e fraco nos
   syncs. A análise humana de impacto não substitui o fecho transitivo do
   script; um redeploy a mais custa segundos, um bundle velho custa incidente.
7. **Contraprova:** `deploy_pendente.py` zerado; `/verify-cockpit` Fases 7 e 8
   PASS; flag/objeto conferido com um `select` (nunca "deve ter aplicado").
8. **Rastro:** linha na tabela de deploys de `docs/BOAS-PRATICAS-git-deploy.md`
   (data, funções, versão, commit, quem) e memória/ADR quando for regra nova.

## 3. Quem autoriza o quê (revisão 2026-09-02)

`docs/POLITICA_MIGRATIONS.md` é o canônico. Resumo: o Carlos tem autonomia
pra implementar, corrigir, aplicar TIPO A e TIPO B, ligar/desligar flags e
deployar — **desde que pelo trilho, com a autorização declarada no
`--autorizado-por`, na migration e no commit**. A exigência mudou de "pedir ao
Caio" pra "deixar escrito quem decidiu e por quê". O Caio é informado, não é gate.

## 4. Se algo pedir permissão / falhar

- **Claude pede pra adicionar regra ou trocar modo (Shift+Tab):** o comando não
  está no trilho. Use o comando da tabela. Se o trilho em si estiver bloqueado,
  a correção é no `.claude/settings.json` do repo, via PR — não no seu
  `settings.local.json`.
- **`deploy-gate` bloqueou:** leia o motivo; é sempre um de: `git pull`
  faltando, mudança não commitada em `supabase/`, marcador crítico ausente,
  função proibida. `DEPLOY_GATE_ACK=1` só com registro do porquê no commit.
- **`dbq.py` disse TIPO B:** declare `--autorizado-por`. Se você não sabe quem
  decidiu nem por quê, não rode.
- **Management API deu 403 `error code: 1010`:** user-agent bloqueado pelo
  Cloudflare; o `dbq.py` já manda o seu. Se aparecer noutro script, mande
  `User-Agent: cockpit-<script>/1.0`.
- **Sem `SUPABASE_ACCESS_TOKEN`:** deploy e `deploy_pendente.py` não rodam.
  Gerar em https://supabase.com/dashboard/account/tokens (nome = seu nome,
  validade 90–180 dias).
