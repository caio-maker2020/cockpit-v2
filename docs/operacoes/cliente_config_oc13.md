# cliente_config_oc13 — Exceção operacional: oc=13 vira caso de relacionamento

**Criada em:** 2026-05-19
**Migration:** `migration/2026-05-19_121_cliente_config_oc13.sql`

## O que faz

Lista de CNPJs em que a oc=13 (insucesso por motivo do cliente final) **NÃO** segue o padrão geral (operação resolve sozinha emitindo CTRC de reentrega auto). Pra esses clientes a operação não emite a reentrega — então o card precisa entrar no Cockpit pro time de relacionamento (Larissa/Duilio) tratar.

Quando o sync-bastao detecta uma pendência com:
- `cod_ultima_ocorrencia = 13`
- `cnpj_pagador` em `cliente_config_oc13` (ativo)

…cria um card em **AGUARDANDO_VALIDACAO_HUMANA + lock=true** com 4 propostas auto:

- **oc=21** — solicita reentrega (destrava a emissão do CTRC de reentrega na operação)
- **oc=54** — email pro cliente (template `FALTA_DE_VOLUME` por padrão)
- **oc=56** — falta info / encaminha pra Operação
- **oc=41** — informação complementar (texto livre)

A proposta 21 herda o checkbox "agendar cancelamento +24h" (memory `project_cancelamento_auto_reentrega`).

## SQLs operacionais (copy-paste)

### Listar CNPJs ativos

```sql
SELECT cnpj_pagador, nome_cliente, created_at, observacao
FROM public.cliente_config_oc13
WHERE ativo
ORDER BY nome_cliente, cnpj_pagador;
```

### Adicionar CNPJ novo

```sql
INSERT INTO public.cliente_config_oc13 (cnpj_pagador, nome_cliente, observacao)
VALUES (
  '00000000000000',                          -- só dígitos, 14 chars
  'NOME DO CLIENTE LTDA A1',
  'Motivo da exceção, contexto operacional'
)
ON CONFLICT (cnpj_pagador) DO UPDATE
  SET ativo = true,
      nome_cliente = EXCLUDED.nome_cliente,
      observacao = EXCLUDED.observacao,
      updated_at = now();
```

### Desativar CNPJ (cliente voltou a seguir fluxo padrão)

```sql
UPDATE public.cliente_config_oc13
SET ativo = false, updated_at = now()
WHERE cnpj_pagador = '00000000000000';
```

### Reativar CNPJ

```sql
UPDATE public.cliente_config_oc13
SET ativo = true, updated_at = now()
WHERE cnpj_pagador = '00000000000000';
```

### Remover CNPJ definitivamente (raro — só se foi cadastro errado)

```sql
DELETE FROM public.cliente_config_oc13
WHERE cnpj_pagador = '00000000000000';
```

### Quantas NFs ativas hoje no Cockpit caem nessa exceção

```sql
SELECT c.nf, c.responsavel_relacionamento, c.state, c.lock_aguardando_validacao,
       c.agent_state->>'cnpj_pagador' AS cnpj,
       cfg.nome_cliente
FROM public.cards c
JOIN public.cliente_config_oc13 cfg
  ON cfg.cnpj_pagador = c.agent_state->>'cnpj_pagador'
WHERE c.cod_ultima_ocorrencia = 13
  AND cfg.ativo
ORDER BY c.updated_at DESC;
```

## Como propagar pro sistema

Sync-bastao roda a cada 30min (cron `sync-bastao`). Após adicionar/desativar CNPJ:

- **Adições:** próximo sync já considera. Pendências oc=13 desse CNPJ que estiverem no Bastão vão criar card no Cockpit imediatamente.
- **Desativações:** próximo sync para de importar novos cards desse CNPJ. Cards já criados continuam no Cockpit (não são deletados — operador pode finalizar a tratativa).

Pra forçar o sync imediatamente (sem esperar 30min):

```bash
curl -X POST 'https://xjbycvscljqoqpjkmevb.supabase.co/functions/v1/sync-bastao' \
  -H "Authorization: Bearer $(psql "$SUPABASE_DB_URL" -tA -c \"SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_sync_bastao_key';\")" \
  -H 'Content-Type: application/json' \
  --data '{}' --max-time 200
```

## Arquitetura — onde o código mexe

1. **Tabela** `public.cliente_config_oc13` — lista canônica. RLS restritiva (só service_role lê).
2. **`_shared/bastao-rules.ts`** — `isOcorrenciaDeRelacionamentoCtx(codigo, { cnpjPagador, excecoesOc13 })` reconhece oc=13 + CNPJ na exceção como "de relacionamento".
3. **`_shared/bastao-client.ts`** — `fetchPendenciasDoCockpit` aceita `excecoesOc13Cnpjs` e faz 2ª query Bastão pra puxar pendências oc=13 desses CNPJs (que não caem no filtro normal).
4. **`sync-bastao` Pass A** — carrega `excecoesOc13` 1x no início, propaga pro fetch + pro `upsertCardFromPendencia`. Override do state pra AGUARDANDO_VALIDACAO_HUMANA + lock=true. Banner aviso_alteracao_oc respeita exceção.
5. **`_shared/regras-auto-acao.ts`** — `REGRAS_AUTO_ACAO[13]` define as 4 propostas. Guard interno só dispara se `cnpj_pagador ∈ excecoesOc13` (passado via `ProporAutoAcaoArgs.excecoesOc13`).

## Padrão pra outras exceções futuras

Cada exceção operacional ganha sua tabela dedicada (não reusa `cliente_config_oc13`). Naming: `cliente_config_<contexto>` (ex: `cliente_config_oc20_template_especial`, etc). Mantém auditável e desativa por contexto sem efeito colateral.
