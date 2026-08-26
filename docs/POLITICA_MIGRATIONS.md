# Política de aplicação de migrations em produção

Definida pelo Caio em 2026-08-26. Vale para TODOS que tocam o banco
(Caio, Claude, Carlos, futuros colaboradores). Em dúvida sobre a
classificação, tratar como TIPO B e pedir o Caio.

## TIPO A — aditivas e reversíveis → o CARLOS pode autorizar e aplicar

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

## TIPO B — movem ou apagam dados → SÓ O CAIO, SEMPRE, sem exceção

- Qualquer `UPDATE` / `DELETE` / `TRUNCATE` em dado de produção
- Backfills e retroativos
- Remanejo de carteira (cliente trocando de operador — ver nota abaixo)
- `DROP` / `ALTER ... DROP COLUMN` / renames
- `CREATE OR REPLACE` de função/policy JÁ existente (substitui comportamento)
- Mudança em RLS/permissões/grants de objeto existente
- Ligar/desligar flags e degraus de automação (autonomia = ordem nominal
  do Caio, regra de 21/08)

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

## Receita obrigatória em qualquer tipo

1. Migration em `migration/` com número sequencial (conferir colisão!) e
   comentário do porquê;
2. Dry-run `BEGIN...ROLLBACK` colado no PR/commit quando fizer sentido;
3. Commit + push ANTES de aplicar (produção nunca à frente do git);
4. Pós-check verificando o resultado (e `/verify-cockpit` quando tocar em
   invariantes);
5. Registro de quem autorizou (mensagem do Caio, quando TIPO B).
