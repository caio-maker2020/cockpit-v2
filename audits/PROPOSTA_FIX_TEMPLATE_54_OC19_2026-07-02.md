# PROPOSTA DE FIX (para auditoria Codex) — Template errado no todo 54+email do oc 19

Data: 2026-07-02 · Origem: Claude Code · Status: **PROPOSTA — não implementada, sem migration, sem deploy**
Caso-âncora: **NF 609867** (DUILIO, oc 19, AVH) · classe da **NF 705764** (banner certo × execução errada)

> Read-only até aqui. Codex deve auditar o fix (ataca a raiz?), o blast radius e confirmar/descartar. Separação
> Fato/Inferência/Hipótese mantida. **Não implementar** — só auditar/aprovar.

---

## Relatório (Diagnóstico antes de correção)

**Sintoma observado:** o todo "54 + e-mail" clicável da NF 609867 dispararia o template `FALTA_DE_VOLUME`
(que pergunta *"seguir parcial ou devolução?"* e **não** pede romaneio/descrição/valor), embora o
agente-sugere-ocs-padrao tenha decidido `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` (que pede as 3).

**Comportamento esperado:** o todo executável do oc 19 deve carregar o template do agente
(`ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`), coerente com a oc 49 do Ressarcimento ("AG ROMANEIO / DESCRICAO / VALOR").

**Evidências verificadas (Fato — código + banco):**
- Corpos verbatim: `FALTA_DE_VOLUME` = *"Podemos seguir com a entrega parcial ou devemos seguir com a
  devolução?"* (não pede as 3). `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` = *"gentileza encaminhar o romaneio de
  coleta assinado da NF **e a descrição/valor dos itens faltantes**"* (pede as 3).
- Todo pendente `930e4364` (código 54) → `template_id=FALTA_DE_VOLUME`, criado **16:00:59**.
- `AgenteOcsPadraoDecisao` **16:04:55** → `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`, destaque 54 (4 min DEPOIS).
- [regras-auto-acao.ts:473](supabase/functions/_shared/regras-auto-acao.ts#L473) — oc=19, proposta 54,
  `enviar_email_template: "FALTA_DE_VOLUME"` (default fixo).
- [regras-auto-acao.ts:646-656](supabase/functions/_shared/regras-auto-acao.ts#L646-L656) —
  `codigosJaPropostos` dedup por **`codigo_ssw`** (o CÓDIGO, não o tool/template).
- [regras-auto-acao.ts:672-674](supabase/functions/_shared/regras-auto-acao.ts#L672-L674) —
  `propostasPendentes` = propostas cujo código **ainda não** foi proposto.
- [regras-auto-acao.ts:780-794](supabase/functions/_shared/regras-auto-acao.ts#L780-L794) —
  `templateEmail54Override` aplicado **só** no loop de INSERT sobre `propostasPendentes`.
- [regras-auto-acao.ts:675-743](supabase/functions/_shared/regras-auto-acao.ts#L675-L743) — early-return
  (propostasPendentes vazio) chama `garantirOpcaoLancarSemEmail` e retorna — **não repatcha** o template do 54.
- `agente-sugere-ocs-padrao/index.ts:421` passa `templateEmail54Override`.

**Causa raiz confirmada (a hipótese do Caio, provada no código):** existe um todo ativo código 54 (criado
16:00:59 pelo sync-bastao com `FALTA_DE_VOLUME`) → `codigosJaPropostos` tem 54 → `propostasPendentes` **exclui**
o 54 → o loop do override (780-794) **nunca toca** o todo 54 existente; e quando `propostasPendentes` fica
vazio, o early-return (675-743) **não repatcha** o template. Logo o `templateEmail54Override` do agente
(`ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`) **só valeria para INSERT de todo novo** — o todo já existente permanece
com `FALTA_DE_VOLUME`. Some-se a isso o **default semanticamente errado** do oc 19 (FALTA_DE_VOLUME é pré-entrega
"parcial×devolução"; oc 19 é pós-entrega).

**Hipóteses descartadas:** "o template não pede descrição/valor" (o template certo pede — já populado, mig 210);
"é do seed/dossiê que criamos" (o seed só recupera romaneio; não toca seleção de template).

**Separação exigida (Caio):** este fix trata o **TODO EXECUTÁVEL** (template errado). O **BANNER VISUAL**
(`cards.ia_sugestao_oc_resposta = null` na 609867) é um **problema SEPARADO** — o destaque do agente não está
no campo que o front lê. *Hipótese não confirmada:* limpeza por Pass D (padrão NF 705764) ou `ia_sugestao`
não persistida. **Fora do escopo desta proposta** — investigação própria (ver §5).

---

## Fix proposto (pequeno) — ataca a raiz, não o sintoma

### A) Corrigir o default da regra oc 19 ([regras-auto-acao.ts:462-487](supabase/functions/_shared/regras-auto-acao.ts#L462))
- Trocar, na proposta código 54, `enviar_email_template: "FALTA_DE_VOLUME"` → `"ENTREGUE_COM_FALTA_PEDIR_ROMANEIO"`.
- Ajustar `descricao_todo`/`descricao_acao`/`rationale` para **pós-entrega com falta** (pedir romaneio +
  descrição + valor p/ abrir ressarcimento), não "consulta parcial×devolução".
- **Por que é raiz:** oc 19 = ENTREGA REALIZADA COM FALTA (pós-entrega). O ask correto é romaneio+descrição+valor,
  não a decisão parcial×devolução (que é de ANTES da entrega). Assim, mesmo sem o agente rodar, o default já é o certo.

### B) Repatch idempotente do todo 54+email existente (helper novo, puro-testável na borda)
Quando `templateEmail54Override` vier preenchido, **antes de qualquer early-return**:
- localizar o todo **ATIVO** com `tool=lancar_oc_e_enviar_email` **E** `codigo_ssw=54` (STATUS_ATIVOS);
- se `args.template_id` **≠** override → **atualizar o PRÓPRIO todo** (`UPDATE`, mesmo `id`);
- **não** criar gêmeo (respeita `uniq_todos_card_tool_cod_ativo`, INV-027/030);
- **preservar** `email_destino`, `acao_key`, `meta` e demais args; mexer só no `template_id`;
- emitir card_event `TemplateEmail54OverrideAplicado` (payload: todo_id, de, para).
- Idempotente: se `args.template_id` já == override → **no-op** (sem UPDATE, sem evento).

### C) Cobrir o early-return
O repatch (B) tem de rodar **também** quando `propostasPendentes.length === 0` — chamar o helper **antes** do
`return` em [675-743](supabase/functions/_shared/regras-auto-acao.ts#L675). (E também no caminho normal, para o
caso de 54 já ativo mas outros códigos pendentes.) Ou seja: o repatch é independente de haver proposta nova.

**Onde tocar:** só `supabase/functions/_shared/regras-auto-acao.ts` (regra 19 + helper + 2 call-sites) e o
teste. `agente-sugere-ocs-padrao` já passa o override (:421) — não muda.

---

## Testes obrigatórios (em `regras-auto-acao.template-override-54.test.ts`, que já existe)
1. **A:** oc=19 SEM override → cria 54+email com `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` (default novo).
2. **B/C:** todo 54+email ATIVO com `FALTA_DE_VOLUME` + chamada com override `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO`
   → **atualiza o MESMO todo** (mesmo id), **não** cria outro (contagem de todos 54 continua 1).
3. **Idempotência:** todo já com `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` + override igual → **não** faz UPDATE (no-op).
4. **Escopo:** override **não** afeta ações sem e-mail (`sem_email_explicito`/`lancar_ocorrencia`) nem outros códigos.
5. **Regressão:** oc=49 SEM override continua `FALTA_DE_VOLUME`.

---

## Riscos / blast radius
- **A afeta TODO card oc=19** vindo do sync-bastao. Validar que `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` é sempre
  certo p/ oc 19 (inclusive quando o agente NÃO roda, sem foto/evidência).
- **⚠ Variáveis do template (blocker a checar):** `ENTREGUE_COM_FALTA_PEDIR_ROMANEIO` usa `{link_evidencia}`;
  `FALTA_DE_VOLUME` não. Confirmar que o caminho do sync-bastao (default, A) resolve `{link_evidencia}` /
  degrada bem quando não há evidência — senão o e-mail sai com link vazio. (O caminho do agente, B, já popula.)
- **INV-027/030:** o repatch (B) **atualiza**, nunca insere — não pode nascer todo cod=54 gêmeo. Guard no teste 2.
- **Retroativo:** cards oc=19 já com todo `FALTA_DE_VOLUME` pendente (como a 609867) continuam com o template
  errado até um novo ciclo do agente com override (que agora repatcha) — avaliar backfill (UPDATE dos todos
  ativos 54 desses cards p/ o template correto) como passo separado.
- **card_events:** `TemplateEmail54OverrideAplicado` — nova trilha de auditoria (idempotente, só quando muda).

## Guards
- Testes 1-5 acima (anti-regressão).
- `/verify-cockpit`: item novo — "oc=19 default = ENTREGUE_COM_FALTA_PEDIR_ROMANEIO" + "override repatcha todo 54
  existente (não cria gêmeo)".
- Memória: atualizar [[project_pos_oc49_extravio_sobrevive_banner_template_scan]] (mesma classe NF 705764).

---

## §5 — Problema SEPARADO (fora deste fix): banner visual / `ia_sugestao_oc_resposta` null
Na 609867, `cards.ia_sugestao_oc_resposta` = null apesar do `AgenteOcsPadraoDecisao` (16:04:55) ter decidido
o destaque. *Hipótese não confirmada:* Pass D do sync-bastao limpou o banner por LAG do Bastão (padrão NF 705764),
ou o destaque não foi persistido no campo que o front lê. **Não abordar aqui** — precisa de investigação própria
(ler o gravador de `ia_sugestao_oc_resposta` + Pass D). Este fix garante que a AÇÃO EXECUTÁVEL fique correta
independentemente do que o banner visual mostrar.

---

## Restrições
Sem migration, sem flag, sem deploy até nova auditoria. Não mexer em seed/dossiê. Escopo só
`regras-auto-acao.ts` + teste. Separado do banner visual.
