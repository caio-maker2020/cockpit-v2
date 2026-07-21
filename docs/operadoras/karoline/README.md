# Karoline Eduarda — Onboarding (herda clientes da Larissa)

**Operadora:** Karoline Eduarda · **Login:** `karoline.eduarda@salexpress.com.br`
**Status:** 🟢 **APLICADO em prod (mig 300, 2026-07-21)** — 21 clientes, 74 cards ativos
reatribuídos. Falta só ação humana: conectar Gmail da Karoline + filtro forward na Larissa.

> ⚠️ Pessoa **nova e independente**. NÃO é o "Karol" da conta compartilhada
> `ISA E KAROL` (Karol + Isabelly, seg 043, `sac@salexpress.com.br`).

## Arquivos deste onboarding

| Arquivo | O que é |
|---|---|
| [`PLANO_ONBOARDING.md`](PLANO_ONBOARDING.md) | Runbook completo: auth, migration, e-mail, SSW, go-live, rollback |
| [`preflight-checks.sql`](preflight-checks.sql) | Verificação read-only (0-conflito + contagem de cards) — rodar ANTES |
| [`../../../migration/2026-07-21_300_onboarding_karoline.sql`](../../../migration/2026-07-21_300_onboarding_karoline.sql) | Migration APLICADA — 21 clientes, move de qualquer dono (Larissa/ISA E KAROL) → Karoline, só ativos |
| [`gmail-forwarding.md`](gmail-forwarding.md) | ⚠️ Filtro forward-only Larissa→Karoline (requisito Gmail) — ação humana pendente |

## Resumo das decisões (Caio 2026-07-21)

1. Operadora **nova** `KAROLINE` (nome interno UNIQUE, maiúsculo).
2. **Carteira-only** — só os CNPJs da planilha; `segmentos={}`. Larissa mantém o resto.
3. **Ativar junto** com a migração (`ativo=true, cockpit_ativo=true`) — evita cards órfãos.
4. Respostas dos clientes **migrados** aparecem no card da Karoline no Cockpit
   (mantendo a Gmail da Larissa conectada + conectar a Gmail da Karoline).

## Status de execução

- [x] Planilha conferida (21 CNPJs Karoline × 4 Larissa, 0 sobreposição).
- [x] `auth.users` criado — user_id `ed4259d6-15c6-4aa2-aafe-0963967aeb43`.
- [x] Pré-voo read-only (G4=0, 74 cards ativos) → migration aplicada e verificada.
- [ ] **Conectar a Gmail da Karoline** no painel (seta `gmail_oauth_credentials`).
- [ ] **Criar o filtro forward-only** na Gmail da Larissa ([`gmail-forwarding.md`](gmail-forwarding.md)) — **manter a da Larissa conectada**.
- [ ] Validar 1 NF real (read SSW + 1 lançamento via `ai.salex`).
