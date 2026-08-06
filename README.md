# Cockpit v2 — Sal Express

Sistema de **agentes de IA autônomos** para tratativas de carga (NF) na Sal Express.
Evolução do Cockpit v1 (Lovable + Supabase) — paradigma novo: agentes agem sobre **cards**, operadores **validam** ações em vez de executá-las.

## Para que serve

Receber mensagens de cliente (WhatsApp + e-mail) e ocorrências do TMS (SSW), vincular ao card da NF, acionar o agente especialista certo (reentrega, devolução, avaria, extravio, etc.) e executar ações no SSW e nos canais do cliente — com humano só validando.

## Stack

- **Frontend (Cockpit do operador):** Lovable (mantido enquanto serve a operação)
- **Backend / DB / Auth / Realtime / Filas / Cron:** Supabase (Postgres + pgmq + pg_cron + Edge Functions)
- **IA:** Claude (Anthropic API) via SDK direto — Haiku 4.5 pra triagem, Sonnet 4.6 pra agentes especialistas
- **WhatsApp:** Evolution API (Railway) — VPS dedicada quando produção
- **E-mail saída:** Resend
- **E-mail entrada:** Postmark inbound (substituindo Apps Script)
- **TMS:** SSW (REST) via adapter próprio com retry + cache de token + idempotência
- **Bastão:** Supabase externo da Sal Express (espelho de pendências SSW)

## Estrutura

```
cockpit-v2/
├── README.md                    # este arquivo
├── CLAUDE.md                    # contexto e convenções pro Claude Code
├── .env.example                 # secrets necessários
├── docs/
│   ├── PRD.md                   # produto: problema, escopo, sucesso
│   ├── ARCHITECTURE.md          # stack, fluxo, diagrama
│   ├── STATE_MACHINE.md         # estados do card + transições
│   ├── AGENTS.md                # mapa dos agentes
│   ├── DATA_MODEL.md            # schema event-sourced
│   └── decisions/               # ADRs datados
├── prompts/                     # prompts versionados
├── evals/                       # casos de teste pros agentes
├── migration/                   # SQL versionado por data
├── lib/                         # extractors, clients, utils puros
└── apps/                        # backend (Edge Functions) e/ou Next.js futuro
```

## Como começar

1. Criar projeto Supabase novo (free tier serve).
2. **Ativar o guard de segredos — primeiro comando depois do clone:**
   ```bash
   git config core.hooksPath .githooks
   ```
   Sem isso o `pre-commit` não roda e nada impede um segredo de ir pro GitHub
   (o repo é público). `core.hooksPath` é config local: **não** vem no clone,
   cada máquina precisa rodar uma vez.
3. Copiar `.env.example` → `.env.local` e preencher. Segredo mora **só** aí —
   `.env.local` é ignorado pelo git. Nunca em `.ts`, `.md` ou arquivo com outro
   nome (`env.download`, `env.txt`, `prod.env` também estão bloqueados).
4. Aplicar migrations em `migration/` em ordem.
5. Importar dataset legado em schema `legacy.*` (read-only, só pra eval).
6. Rodar primeira eval pra confirmar baseline.

## Status atual

Fase 0 — fundação (docs + schema + extração de conhecimento do v1).
Próxima: Fase 1 — primeiro agente (Reentrega) em shadow mode.

## Onde achar cada coisa

| Pergunta | Doc |
|---|---|
| Por que esse projeto existe? | `docs/PRD.md` |
| Como as peças se ligam? | `docs/ARCHITECTURE.md` |
| Quais estados o card tem? | `docs/STATE_MACHINE.md` |
| Quais agentes existem? | `docs/AGENTS.md` |
| Qual o schema do banco? | `docs/DATA_MODEL.md` |
| Por que escolhemos X? | `docs/decisions/` |
