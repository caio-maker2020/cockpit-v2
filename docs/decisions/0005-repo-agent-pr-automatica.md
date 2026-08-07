# ADR 0005 — Repo-agent: PR automática do Loop de Aprendizado

Data: 2026-08-08 · Status: aceita (Fase 4 do plano aprovado pelo Caio em 08/08)

## Contexto

O chat do agente-chefe fecha regras com a gestão e as valida no replay. Faltava
o último elo da fluidez pedida pelo Caio: a melhoria virar **PR já aberta** no
GitHub, pra que o e-mail diga "aprove a PR" e o humano só decida.

## Decisão

1. **A inteligência NÃO roda no CI.** A regra nasce na conversa e passa pelo
   replay ANTES; a GitHub Action (`.github/workflows/melhoria-pr.yml`) só faz
   **inserção mecânica** (`scripts/aplicar-melhoria.ts`) no bloco-âncora
   `<!-- INICIO/FIM-APRENDIZADOS-GESTAO -->` do prompt do agente-alvo.
   Consequências: PR 100% revisável, zero chave de IA no CI, comportamento
   determinístico e idempotente.
2. **Credenciais mínimas.** O runner usa só o `GITHUB_TOKEN` efêmero do job
   (escopo = este repo). Push é sempre em `ai-melhoria/<id>` — o workflow não
   toca a master. O disparo remoto (edge `aprendizado-disparar-pr`) usa um
   fine-grained PAT `GH_DISPATCH_TOKEN` (só este repo, só Contents read/write)
   guardado em Supabase secrets; **sem o secret o fluxo degrada limpo** (e-mail
   avisa que a PR fica pro `/f6-aplicar-melhorias`).
3. **Isolamento de branch é o default do git**: quem puxa a master nunca recebe
   `ai-melhoria/*`; a branch só vem com checkout explícito (validado com o
   Caio em 08/08).
4. **Merge continua exclusivamente humano** (Caio), com o ritual de deploy.
5. Agentes cujas regras são código (agente-sugere, oc13) não ganham inserção
   automática: a regra vira `prompts/aprendizados-pendentes/<agente>-<id>.md`
   e a PR marca "aplicação manual necessária".

## Como criar o GH_DISPATCH_TOKEN (pendência do Caio)

GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
repositório APENAS `caio-maker2020/cockpit-v2`; permissão APENAS
"Contents: Read and write"; validade 90 dias. Depois:
`supabase secrets set GH_DISPATCH_TOKEN=<token> --project-ref xjbycvscljqoqpjkmevb`.

## Alternativas rejeitadas

- Claude Code rodando no CI pra aplicar a regra: mais poder do que o passo
  precisa, chave de IA no CI, PR menos previsível.
- PAT largo (classic repo-scope): poderia dar push na master (sem proteção de
  branch hoje) — recusado; o fine-grained de Contents limita o raio.
