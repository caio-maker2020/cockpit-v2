# Automação de cobrança — REMOVIDA (2026-07-17)

> **⚠️ FEATURE APAGADA DE VEZ — decisão Caio/Matheus 2026-07-17 (mig 298).**
> Não existe flag; religar exige migration nova + ADR. Motivo: a "desativação"
> parcial da mig 168 deixou 5 portas criando `cobranca_email` que falhavam pra
> sempre e saturaram a fila `acoes_agendadas`, starvando os cancelamentos de
> reentrega (incidente 2026-07-12→16, INV-039; ver
> `audits/FIX_FILA_ACOES_AGENDADAS_SATURADA_2026-07-16.md`).
>
> O que morreu na mig 298 + deploy: RPC `agendar_cobranca_email` (DROP),
> agendamentos no executor (3 paths), no enviar-resposta (2 paths) e no
> `marcar_retorno_inconclusivo`. O que FICA: `contatos_cliente`,
> `templates_email`, `resolver_email_cobranca_cliente` (usados por outros
> fluxos), `cancelar_acoes_agendadas_do_card` (genérico), e o handler de
> `cobranca_email` no `processar-acoes-agendadas` (defensivo, drena stragglers
> com INV-fila). O restante deste documento é HISTÓRICO.

Documento operacional do que ficou pronto em 2026-05-01 e o que ainda
falta pra automação rodar 100%.

---

## O que está pronto (deployado e ativo)

### Schema do banco (migration 035 + 036)

3 tabelas novas:

- `contatos_cliente` — emails/whatsapp/dominio por cliente, com `ordem`
  (preferência) e `tipo_uso` (geral/cobranca/logistico/financeiro/comercial)
- `templates_email` — templates reutilizáveis com placeholders entre `{chaves}`.
  2 stubs criados (`FALTA_DE_VOLUME`, `COBRANCA_LEMBRETE`) inativos
- `acoes_agendadas` — relógio das ações futuras (`cobranca_email`)

3 RPCs novas:

- `cancelar_acoes_agendadas_do_card(card_id, motivo)` — cancela ações pendentes
- `agendar_cobranca_email(card_id, template_id, dias)` — agenda cobrança
- `resolver_email_cobranca_cliente(cnpj, tipo_uso)` — resolve melhor email pra processo

### Edge Functions

| Function | Quando dispara | O que faz |
|---|---|---|
| **processar-acoes-agendadas** | cron diário 9h BRT | Varre `acoes_agendadas` pendentes, cria propostas de re-cobrança |
| **vinculador** (atualizado) | a cada 1min | Quando msg cliente chega num card AGUARDANDO_CLIENTE → move pra AGUARDANDO_AGENTE + cancela cobranças agendadas |
| **enviar-resposta** (atualizado) | quando consume queue | Após enviar email, agenda cobrança em **D+4** automaticamente |
| **sync-bastao** (atualizado) | a cada 2min | Detecta oc=49 → propõe **lançar oc 54 + enviar email template FALTA_DE_VOLUME** (bloqueada hoje por template inativo) |
| **executor** (atualizado) | a cada 1min | Suporta tool composto `lancar_oc_e_enviar_email` — lança oc, depois renderiza template e enfileira email |

### Cron schedules

| Job | Quando |
|---|---|
| `processar-acoes-agendadas-daily` | `0 12 * * *` (12h UTC = 9h BRT) |
| `sync-bastao-every-2min` | `*/2 * * * *` |
| `triador-every-1min`, `vinculador-every-1min`, `executor-every-1min` | a cada minuto |
| `health-check-every-5min` | a cada 5min |

---

## O ciclo completo (como vai funcionar quando ativar)

```
                       ┌──────────────────────────────┐
oc=49 chega no Bastão  │ sync-bastao detecta          │
                       │ regra oc=49 → 54 + email     │
                       └──────────────┬───────────────┘
                                      │ verifica:
                                      │  - chave_cte? ok
                                      │  - template ativo? ok
                                      │  - cliente tem email? ok
                                      ▼
                       ┌──────────────────────────────┐
                       │ Cria todo "Lançar 54 + email"│
                       │ Card → AGUARDANDO_VALIDACAO  │
                       │ lock=true                    │
                       └──────────────┬───────────────┘
                                      │ Larissa aprova
                                      ▼
                       ┌──────────────────────────────┐
                       │ executor lança oc 54 no SSW  │
                       │ + renderiza template + push  │
                       │   na queue respostas_envio   │
                       │ Card → EXECUTANDO_ACAO       │
                       └──────────────┬───────────────┘
                                      │ enviar-resposta consome
                                      ▼
                       ┌──────────────────────────────┐
                       │ Postmark envia email cliente │
                       │ AGENDA: cobrança em D+4      │
                       │ Card → AGUARDANDO_CLIENTE    │
                       └──────────────┬───────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            │                                                   │
       cliente responde antes de D+4              4 dias passaram, sem resposta
            │                                                   │
            ▼                                                   ▼
┌──────────────────────────┐                   ┌──────────────────────────────┐
│ vinculador detecta resp. │                   │ processar-acoes-agendadas    │
│ Card → AGUARDANDO_AGENTE │                   │ cria todo "Reenviar cobrança"│
│ Cancela cobrança D+4     │                   │ Card → AGUARDANDO_VALIDACAO  │
│ Larissa vê e atende      │                   │ Larissa aprova → email       │
└──────────────────────────┘                   │ Agenda nova cobrança D+4     │
                                               └──────────────────────────────┘
```

---

## O que falta pra ativar (3 inputs)

**1. Templates ativos** — Larissa preenche [Templates-Email-Larissa.docx](exports/Templates-Email-Larissa.docx) com 4 templates. Quando entregar, eu rodo:

```sql
UPDATE public.templates_email
SET assunto = '...', corpo_template = '...', ativo = true
WHERE id = 'FALTA_DE_VOLUME';
```

**2. Contatos preenchidos** — Larissa adiciona 2 colunas (`ordem`, `tipo_uso`) na planilha `Contatos-Clientes-Larissa.xlsx` que ela já está preenchendo. Eu rodo o script de import:

```bash
set -a && source .env.local && set +a
python3 scripts/import_contatos_cliente.py
```

**3. (Opcional) Voz da Larissa** — Quando questionário Voz preenchido, calibro o `redator` pra gerar texto natural em vez de template fixo. Não bloqueante — templates funcionam sem isso.

---

## Pra adicionar na planilha existente — mensagem pra Larissa

> "Larissa, na sua planilha `Contatos-Clientes-Larissa.xlsx`, na aba
> **Contatos**, adiciona 2 colunas no final:
>
> - **ordem**: número 1, 2, 3... (1 = preferido pra usar primeiro,
>   2 = backup quando o primeiro não responde)
> - **tipo_uso**: uma destas palavras: `geral`, `cobranca`, `logistico`,
>   `financeiro`, `comercial`. Se não souber, deixa `geral`.
>
> Não precisa refazer nada. Só adiciona as 2 colunas e preenche pra
> cada linha. Default: ordem=1, tipo_uso=geral."

---

## Validação manual após ativar

Após popular templates + contatos, rodar manualmente uma vez pra confirmar:

```bash
# 1. Forçar sync-bastao (vai detectar cards com oc=49 e propor)
curl -X POST "$SUPABASE_URL/functions/v1/sync-bastao" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# 2. Forçar processar-acoes-agendadas (em ambiente de teste)
curl -X POST "$SUPABASE_URL/functions/v1/processar-acoes-agendadas" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Verifica no banco:

```sql
-- propostas pendentes de oc 54
SELECT c.nf, t.proposta_payload->>'tool', t.proposta_payload->'args'->>'template_id', t.status
FROM todos t JOIN cards c ON c.id=t.card_id
WHERE t.status='pendente'
  AND t.proposta_payload->>'tool' = 'lancar_oc_e_enviar_email';

-- cobranças agendadas
SELECT c.nf, a.executar_em, a.status, a.payload->>'template_id'
FROM acoes_agendadas a JOIN cards c ON c.id=a.card_id
ORDER BY a.executar_em;
```

---

## Próximos incrementos planejados (depois do MVP)

1. **Opção B** (IA interpreta resposta) — usa documento `Contexto-Pergunta-Original-IA.docx` quando Larissa preencher
2. **Limite de cobranças autônomas** — após N cobranças sem retorno, propor nova ação (devolução? escalation?)
3. **Botão "Pausar cobranças"** no card — Larissa pausa N dias quando cliente avisar fora-de-canal
4. **Métricas de eficácia** — taxa de resposta após 1ª/2ª/3ª cobrança, tempo médio até resposta
