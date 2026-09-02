# Política de aplicação de migrations em produção

Definida pelo Caio em 2026-08-26. **Revisada pelo Caio em 2026-09-02** (sessão
Claude Code, resposta literal "Autonomia total"): o Carlos passa a autorizar e
aplicar TIPO A, TIPO B e liga/desliga de flags **sozinho**, pelo trilho
(`scripts/dbq.py`), com a autorização **declarada** em `--autorizado-por`, no
comentário da migration e no commit. A exigência mudou de "pedir ao Caio" para
"deixar escrito quem decidiu e por quê". O Caio é informado, não é gate.
Vale para TODOS que tocam o banco (Caio, Claude, Carlos, futuros
colaboradores). Em dúvida sobre a classificação, tratar como TIPO B — o
classificador do `dbq.py` faz isso automaticamente.

**Nada é lançado à mão no painel do Supabase.** Tudo passa por migration
versionada + `dbq.py`. Ver `docs/RITUAL_DEPLOY.md`.

## TIPO A — aditivas e reversíveis → roda direto pelo trilho

Mudanças que só ADICIONAM estrutura e podem ser desfeitas com um DROP sem
perder dado de produção:

- `CREATE TABLE` / `CREATE VIEW` / `CREATE INDEX` (inclusive parciais)
- `CREATE FUNCTION` / `CREATE POLICY` novos (sem substituir existentes)
- `ALTER TABLE ... ADD COLUMN` (nullable / com default, sem backfill)
- Seeds de configuração NOVOS e idempotentes (`INSERT ... ON CONFLICT DO
  NOTHING`) que nascem DESLIGADOS (flag off, ativa=false)
- Crons novos apontando pra função nova

Condições: idempotente, SEM `BEGIN/COMMIT` interno (regra 13/08), dry-run
`BEGIN...ROLLBACK` antes, e commit no master ANTES de aplicar.

## TIPO B — movem ou apagam dados → só com autorização DECLARADA (`--autorizado-por`)

- Qualquer `UPDATE` / `DELETE` / `TRUNCATE` em dado de produção
- Backfills e retroativos
- Remanejo de carteira (cliente trocando de operador — ver nota abaixo)
- `DROP` / `ALTER ... DROP COLUMN` / renames
- `CREATE OR REPLACE` de função/policy JÁ existente (substitui comportamento)
- Mudança em RLS/permissões/grants de objeto existente
- Ligar/desligar flags e degraus de automação

Quem pode autorizar TIPO B (revisão 02/09): **o Caio ou o Carlos**. A regra
de 21/08 ("autonomia = ordem nominal do Caio") foi delegada ao Carlos pelo
próprio Caio em 02/09. O que continua inegociável é o REGISTRO: o `dbq.py`
recusa TIPO B sem `--autorizado-por "<quem>, <quando>: <ordem/motivo>"`, e a
mesma frase vai no cabeçalho da migration e na mensagem do commit. Sem saber
quem decidiu e por quê, não roda — nem o Caio, nem o Carlos, nem o Claude.

"O cliente pediu", "é urgente" ou "é só uma linha" NÃO mudam o tipo.

## Nota — remanejo de carteira (cliente de um operador pra outro)

Decisão do Caio 2026-08-26: remanejo é operação de ROTINA e o Carlos pode
executar sozinho — **desde que seja pela função canônica**
`public.remanejar_cliente_operador(...)` (mig 360), que embute a receita
completa das migs 288/301/333/359 (7 camadas, desarme do veto, card_event
por card, 9 pós-checks, atômica). Manual: `docs/REMANEJAR_CLIENTE.md`.
Pré-requisito humano: trocar a espécie/responsável no SSW ANTES.

Remanejo FORA da função (UPDATE à mão em cards/operadores/contatos) segue
TIPO B — só o Caio, sem exceção. A função é o trilho; fora do trilho é
mutação de dados como outra qualquer.

## Nota — recriar VIEW com RLS: repetir SEMPRE o `WITH (security_invoker = on)`

Incidente 2026-08-28 → 31/08 (mig 367, corrigido pela mig 369). Vale pra
qualquer view que dependa de RLS pra filtrar (`v_extravios_kanban`,
`v_prioridades_ai`, `v_cards_requer_atencao`, `v_cancelamentos_reentrega`,
`v_card_events_legivel`, `v_email_preexistente`).

**A armadilha:** `CREATE OR REPLACE VIEW ... AS` **substitui as reloptions em
bloco** — não as preserva. E `pg_get_viewdef` **não imprime** a cláusula `WITH`.
Quem dumpar a definição de lá pra editar copia a view **sem** o atributo, e
**não tem como perceber**: colunas, filtros e front continuam funcionando
perfeitamente. O único efeito é a view passar a rodar como a **dona**
(`postgres`, `rolbypassrls=true`) e a RLS deixar de ser avaliada.

**O estrago:** todos os operadores passam a ver a carteira alheia **e** a chave
`anon` (pública, embarcada no bundle do front) lê a tabela inteira **sem
login**. Na 367 ficou aberto de sexta 14:52Z até a segunda de manhã — só não
foi mais tempo porque o fim de semana não teve uso.

**Regra:**
- Ao recriar uma view dessas, **repetir o `WITH (security_invoker = on)`**.
- Pra mudar só o atributo, usar `ALTER VIEW ... SET (security_invoker = on)` —
  não encosta na definição, que é o gesto que causa o bug.
- Depois de qualquer `CREATE OR REPLACE VIEW`, conferir `INV-121` do
  `/verify-cockpit` (o guard automático desse caso).

**Classificação:** restaurar/alterar `security_invoker` de view existente é
**TIPO B** (muda enforcement de RLS de objeto já existente). A mig 369 foi
aplicada sob autonomia declarada pelo Carlos por ser **incidente com exposição
ativa de dado de cliente** — desde 02/09 esse é o trilho normal, com o
`--autorizado-por` registrado.

## Receita obrigatória em qualquer tipo

1. Migration em `migration/` com número sequencial (conferir colisão!) e
   comentário do porquê;
2. Dry-run `BEGIN...ROLLBACK` colado no PR/commit quando fizer sentido;
3. Commit + push ANTES de aplicar (produção nunca à frente do git);
4. Pós-check verificando o resultado (e `/verify-cockpit` quando tocar em
   invariantes);
5. Registro de quem autorizou (TIPO B: `--autorizado-por` no `dbq.py` +
   cabeçalho da migration + commit).
6. Só pelo trilho: `python3 scripts/dbq.py -f migration/... [--dry-run]`.
   Nunca SQL Editor do painel, nunca script fora do repo.
