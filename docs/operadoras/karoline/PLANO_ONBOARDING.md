# Onboarding KAROLINE — Runbook (herda clientes da LARISSA)

**Operadora:** Karoline Eduarda · **Login:** `karoline.eduarda@salexpress.com.br`
**Contexto:** Larissa sobrecarregada → Karoline assume **alguns** clientes dela (não todos).
**Status:** 🟡 tudo preparado — **falta APENAS a planilha de clientes** (Fase B).
**Decisões travadas (Caio 2026-07-21):** operadora nova e independente `KAROLINE`;
carteira-only (`segmentos={}`); ativar junto com a migração; respostas dos clientes
**migrados** aparecem no card da Karoline no Cockpit.

> ⚠️ **KAROLINE ≠ "ISA E KAROL".** Existe uma conta compartilhada `ISA E KAROL`
> (Karol + Isabelly, segmento 043, `sac@salexpress.com.br`). A Karoline Eduarda é
> **outra pessoa**, operadora nova. Não confundir nome/roteamento/threads.

---

## Como o sistema garante seus 4 requisitos (sem regressão)

| Requisito | Mecanismo que garante | Evidência |
|---|---|---|
| **Sem conflito de cliente** | `array_remove` da Larissa **na mesma transação** que seta a carteira da Karoline + Guarda G4 aborta se um CNPJ estiver em outra carteira ativa | `operador-resolver.ts:144-154` ("1 CNPJ = 1 operador") |
| **Nenhum card some** | Ativar `cockpit_ativo=true` junto (senão `carteira_dormente → NULL/NULL`) + reatribuir cards abertos explicitamente (branch RLS `pagador=carteira` é morto) | `operador-resolver.ts:156-164`; audit 2026-06-27 |
| **Nenhum card duplica** | Migration só faz `UPDATE` (não cria card); **nunca** toca `state`/`nf`; índice `uniq_cards_nf_active` = 1 card ativo/NF | ADR 0006; mig 030 |
| **Histórico de e-mail preservado** | Match inbound é por **thread→card→dono** (independe de operador) → resposta cai no card **agora da Karoline**. Exige manter a Gmail da Larissa conectada | `gmail-poll-inbox/index.ts:399-405`; `responder-email-cliente:144-161` |

---

## Fase A — JÁ PRONTO (não depende da planilha)

- [x] **Migration parametrizada:** [`migration/2026-07-21_300_onboarding_karoline.sql`](../../../migration/2026-07-21_300_onboarding_karoline.sql) — cria a operadora, faz o move de 4 camadas, reatribui cards com `card_events`, 4 guardas anti-regressão. Único TODO de dados: o bloco `_onb`.
- [x] **Pré-voo read-only:** [`preflight-checks.sql`](preflight-checks.sql) — prova 0-conflito + conta cards a mover.
- [x] Este runbook + checklist de go-live.
- [ ] Item no `/verify-cockpit` (INV-KAROLINE) — ver §7.

## Fase B — QUANDO A PLANILHA CHEGAR (ordem exata)

### 1. Criar o login (auth.users) — fora da migration
Não dá pra criar auth via SQL puro; usa a Admin API (mesma rota do `import_victor_isakarol.py` / edge `admin-operadores`). Opções:

```bash
# Via REST Admin API (service_role). Retorna o "id" (UUID) que vai na migration.
set -a && source .env.local && set +a
curl -s -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"karoline.eduarda@salexpress.com.br","password":"sal123456","email_confirm":true}' \
  | python3 -c 'import sys,json; print("user_id =", json.load(sys.stdin)["id"])'
```
- Se já existir, buscar o UUID pela listagem admin (paginação, igual `import_victor_isakarol.py:274-289`).
- Senha temporária `sal123456` (padrão dos outros) — Karoline troca no 1º acesso / "esqueci minha senha" (`admin-operadores` / `recuperar-senha-operador`).

### 2. Preencher a migration
- Colar a planilha no bloco `_onb` (formato no arquivo: `cnpj, nome, responsavel, emails[], phone, senha_ssw, segmento_codigo, segmento_nome`).
- Trocar o UUID sentinela (`00000000-...`) em `_cfg` pelo `user_id` do passo 1. (Busca por `⚠️ TODO`.)
- Colar os **mesmos CNPJs** no `_plan` do `preflight-checks.sql`.

### 3. Pré-voo (read-only, não escreve nada)
```bash
psql "$SUPABASE_DB_URL" -f docs/operadoras/karoline/preflight-checks.sql
```
Critérios de PASS antes de aplicar:
- §2 (Guarda G4) → **0 linhas** (nenhum conflito).
- §7 → **0 linhas** (nenhum card preso em outro operador ativo).
- §5 → anotar `cards_a_mover` (comparar com o pós).

### 4. Aplicar a migration
```bash
psql "$SUPABASE_DB_URL" -f migration/2026-07-21_300_onboarding_karoline.sql
```
- Transação atômica: se qualquer guarda disparar (`STOP G1..G4`), **nada** é escrito.
- Ler o `NOTICE` final: `carteira=N, clientes=N, contatos=N, tracking=N, cards_movidos=N`.
- `cards_movidos` deve bater com o `cards_a_mover` do pré-voo (§5).

### 5. E-mail — guardas obrigatórias (senão perde histórico)
- **NÃO desconectar a Gmail da Larissa.** As respostas às threads que ela já enviou
  caem na caixa dela; o poll (que não filtra por `ativo`) as captura e linka no card
  — que agora é da Karoline. Se a credencial dela for removida/revogada, essas
  respostas **nunca** são ingeridas. Vale mesmo se a Larissa sair depois.
- **Conectar a Gmail da Karoline** (`karoline.eduarda@`) no painel — seta
  `operadores.gmail_oauth_credentials`. Sem isso: ela **vê** os cards mas o e-mail
  de saída dela cai no fallback Postmark (`email_relacionamento`) e as threads
  **novas** dela não são capturadas na caixa própria.
- Quando a Karoline responder uma thread iniciada pela Larissa, o sistema já detecta
  `inboundOperadorId ≠ op.id` e manda como **thread nova** da caixa dela via
  In-Reply-To (`responder-email-cliente:144-161`, caso-âncora NF 5558833). Cliente
  segue vendo como resposta; nada quebra.
- (Opcional) Se você quiser que a resposta **também** caia fisicamente na caixa Gmail
  da Karoline: configurar encaminhamento/delegação no Google Workspace da Larissa
  para os domínios migrados. Fora do código — decisão sua.

### 6. SSW — nada a fazer
- **Lançamento:** conta única compartilhada `ai.salex` (INV-013), automática. Karoline
  não precisa de credencial própria.
- **Leitura/entrada:** **não criar** secrets `SSW_INTERNAL_KAROLINE_*` → ela cai no
  fallback compartilhado (mesma conta dos demais). Autoria (`aprovado_por`) fica
  correta mesmo com login compartilhado.

### 7. Validação pós-aplicação (mesma janela)
- Rodar `preflight-checks.sql` de novo: §1 mostra KAROLINE ativa; §3 mostra os CNPJs
  **fora** da carteira da Larissa; §6 mostra os cards agora `responsavel=KAROLINE`,
  `segmento_codigo` nulo.
- Login da Karoline → ela enxerga **exatamente** os cards migrados (RLS por
  `assigned_operator_id`), e a Larissa **deixou** de vê-los.
- Validar **1 NF real** de um cliente migrado: abrir o card, puxar histórico SSW
  (read via fallback), e lançar/aprovar 1 ocorrência de teste → confirma `ai.salex`.
- Conferir contagem: nº de cards ativos total **não muda** (é `UPDATE`, não cria/apaga).

### Rollback (se algo destoar)
- Antes do COMMIT: qualquer erro/`STOP` já reverte tudo (transação única).
- Depois do COMMIT: reverter é o **inverso da mig 300** — mover os CNPJs de volta
  pra Larissa nas 4 camadas + `card_events 'OperadorReatribuido'` (motivo=rollback).
  Cards terminais não foram tocados; `state`/`nf` intactos → sem risco de duplicação.

---

## O que a Karoline ainda precisa entregar (calibração, não bloqueia go-live)
Espelha o pacote da Larissa (`docs/operadoras/larissa/`), se for cuidar de tratativa
de entrega: questionário de voz (calibra o `redator`), templates de e-mail, e
validação do processo. Só a **planilha de clientes** bloqueia o go-live técnico.

## Âncoras de código (para auditoria)
- Roteamento: `supabase/functions/_shared/operador-resolver.ts`
- Sync/atribuição: `supabase/functions/sync-bastao/index.ts` (resolve por carteira a cada run)
- Inbound e-mail: `supabase/functions/gmail-poll-inbox/index.ts`
- Reatribuição-safe de resposta: `supabase/functions/responder-email-cliente/index.ts:144-161`
- Precedente 4-camadas Larissa→X: `migration/2026-07-02_288_centervida_larissa_para_isa_karol.sql`
- Onboarding operadora nova: `migration/2026-06-24_260_onboarding_julia_camila.sql`
