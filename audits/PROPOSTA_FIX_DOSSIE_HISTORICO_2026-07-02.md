# PROPOSTA DE FIX (para auditoria Codex) — Dossiê enxerga evidência anterior à sua criação

Data: 2026-07-02 · Origem: Claude Code · Status: **PROPOSTA — não implementada, não deployada**
Caso-âncora: **NF 575330** (LARISSA) · espelha NF 66193

> **Regras (CLAUDE.md):** isto é uma PROPOSTA de fix na RAIZ, não código. Codex deve auditar se ataca a
> causa raiz (não o sintoma), o blast radius, e confirmar/descartar cada hipótese. Separação
> Fato/Inferência/Hipótese/Decisão mantida. Não aplicar nada — só auditar.

---

## 1. Problema — causa raiz (FATO verificado)

O dossiê de extravio parcial é montado **apenas a partir da resposta corrente do cliente**.
`montarEvidenciasRecebidas(llm, anexos, conteudo, ref)` em
[`_shared/extravio-parcial-dossie.ts`](supabase/functions/_shared/extravio-parcial-dossie.ts) recebe **só os
anexos e o corpo da mensagem atual**. Evidência que chegou **antes de o dossiê existir** é invisível.

**Evidência (NF 575330):**
- Romaneio recebido em **12/06 16:55** como anexo real — `email_anexos.filename = "NF 575330.pdf"`
  (268 KB, `origem=inbound`, `deletado_em=NULL`); corpo do e-mail: *"Segue em anexo o romaneio assinado…"*.
- oc **33** já lançada em **12/06 15:42** (SSW, com foto) — romaneio já aceito.
- Ressarcimento (oc **49**, 30/06 15:58) pediu **"DESCRICAO E VALOR"** — **NÃO** pediu romaneio.
- Card **não tem dossiê** (`agent_state.extravio_parcial` ausente) — tudo isto é anterior ao deploy shadow (02/07).

**Consequência (Inferência sólida a partir do código):** quando o cliente responder com itens+valor, o
interpretador monta um dossiê **fresco** que valida descrição+valor (corpo atual) mas marca
**`romaneio: ausente`** (o PDF de 12/06 não é passado pro validador) → `faltando=["romaneio de coleta
assinado"]` → re-patcha o todo de oc 33 ([interpretador-resposta-cliente:475-497](supabase/functions/interpretador-resposta-cliente/index.ts#L475-L497))
com **"falta romaneio"** — **falso negativo**, pois o romaneio já está salvo e já foi lançado.

**Isto NÃO é resolvido pela Fase 2** (re-busca / herança do dossiê): ambas pressupõem um dossiê prévio
referenciando o romaneio. Aqui não há dossiê prévio.

---

## 2. Princípio que a solução tem de preservar

1. **LLM classifica, evidência é provada contra a fonte original** (Ajuste 5 + blockers Codog). Nada de marcar
   evidência com base em alucinação.
2. **Merge monotônico** (`mergeEvidencia`): evidência presente nunca volta a ausente.
3. **Zero regressão no extravio total** (`ehExtravioParcial=false` → nada muda).
4. **Shadow-safe**: com `enforce=OFF` o fix só muda anotações; observável antes de bloquear.

---

## 3. Solução proposta (raiz) — "dossiê considera o histórico do card, deterministicamente"

A raiz é o **escopo da evidência** (só a resposta corrente). O fix amplia o escopo para o **histórico do
card**, no momento da **criação/seed do dossiê**, usando SINAIS DETERMINÍSTICOS (sem novo LLM sobre dados
antigos). Três níveis; **Nível 1 + Nível 2 são o núcleo**, Nível 3 é opcional.

### Nível 1 — Seed do romaneio a partir de `email_anexos` + corpo (determinístico)
Na criação do dossiê (ou enquanto `romaneio.presente=false`), varrer os anexos inbound do card e marcar
romaneio presente se houver anexo real cujo contexto indique romaneio.
- **Regra determinística:** existe `email_anexos` do card com `origem='inbound'` E `deletado_em IS NULL` E
  (mime PDF/imagem) E o corpo da mensagem-mãe (`messages_inbox`) contém indicador de romaneio
  (`/romaneio/i`, com guarda anti-pedido: ignorar quando o trecho é "aguardo/enviar o romaneio", i.e. quando
  quem escreve é o Sal pedindo). → `romaneio = {presente:true, fonte:"anexo", filename, message_inbox_id, size_bytes, mime_type}`.
- Referencia a FONTE ORIGINAL (o anexo real) — coerente com o princípio nº 1.
- Novo helper puro sugerido: `detectarRomaneioNoHistorico(anexosInbound[], corposInbound[]) → RefEvidenciaAnexo | null`.

### Nível 2 — Sinal AUTORITATIVO do SSW: o Ressarcimento diz o que falta (determinístico)
As palavras da oc 49 do Ressarcimento desambiguam o romaneio:
- **Regra:** se `historico_ssw` tem oc **33** já lançada E a oc **49** mais recente do Ressarcimento pede
  **apenas descrição/valor** (não menciona romaneio) → `romaneio.presente = true` (o Ressarcimento já
  aceitou o romaneio; só falta desc/valor).
- **Auto-consistência (FATO, valida a regra):**
  - **575330:** oc 49 = "DESCRICAO E VALOR" → romaneio presente ✓ (correto).
  - **66193:** oc 49 = "DESCRICAO, VALOR E ROMANEIO" → romaneio **NÃO** marcado ✓ (correto — lá faltava mesmo).
- Reaproveita o parser que já existe (`detectarPedirDescricaoValor` / `RE_PEDE_DOCS` em
  [`_shared/ressarcimento-relancar-54.ts`](supabase/functions/_shared/ressarcimento-relancar-54.ts)).
- Novo helper puro sugerido: `romaneioAceitoPeloSsw(historicoSsw) → boolean`.

**romaneio.presente final = (Nível 1) OR (Nível 2).** Os dois são determinísticos e se reforçam.

### Nível 3 (opcional) — Detecção determinística de "é parcial" (reduz o outro ramo de falha)
Hoje `deveProcessarDossie` depende do LLM marcar `contexto_extravio_parcial`. Se o LLM não marcar, não há
dossiê e o gate fica cego. Reforço determinístico:
- **Regra:** `historico_ssw` tem oc **19** (entrega com falta) OU (oc 6/9/16 extravio + oc 55 autorização
  parcial) → força `deveProcessarDossie=true`.
- Fica atrás da flag master; opcional nesta rodada.

---

## 4. Onde toca (SEM código — só o mapa para o Codex)

| arquivo | mudança proposta |
|---|---|
| `_shared/extravio-parcial-dossie.ts` | + `detectarRomaneioNoHistorico(...)`, + `romaneioAceitoPeloSsw(...)` (puros); dossiê passa a poder ser semeado por eles via `mergeEvidencia` (monotônico) |
| `interpretador-resposta-cliente/index.ts` | ao criar/atualizar o dossiê: buscar anexos inbound (`email_anexos`) + corpos (`messages_inbox`) + `historico_ssw` do card e chamar os helpers de seed ANTES do merge da resposta corrente; rodar o seed **1×** (quando `romaneio.presente=false`) |
| `_shared/ressarcimento-relancar-54.ts` | reuso do parser da oc 49 (já existe) para o Nível 2 — idealmente extrair um predicado puro compartilhado |
| `docs/decisions/0011-*.md` | adendo "seed do dossiê a partir do histórico" |
| `.claude/commands/verify-cockpit.md` + `docs/INVARIANTES_COCKPIT.md` | INV-034: novo check |

Sem migration nova (usa `email_anexos`, `messages_inbox`, `cards.historico_ssw` já existentes). Sem coluna nova.

---

## 5. Quando roda / idempotência / custo
- **Momento:** no seed do dossiê (primeira vez que vira parcial) e enquanto `romaneio.presente=false`. Como o
  merge é monotônico, uma vez presente não re-varre → custo O(1) depois.
- **Sem novo LLM sobre histórico** (Níveis 1 e 2 são determinísticos) → não aumenta custo Anthropic.
- Leitura extra: `email_anexos` por card (pequena) + `historico_ssw` (já no card). `messages_inbox` já é lido.

---

## 6. Rollout
- Tudo atrás de `extravio_parcial_dossie_enabled` (ON, shadow). `enforce=OFF` → só muda anotação `gate_oc33`
  (menos falso "faltando"). Observar em sombra antes do enforce. `caso2` segue OFF.
- **Retroativo (opcional):** re-seed dos dossiês existentes (hoje 2: 1119469, 28779) — baixo valor (early-stage);
  decidir com Codex/Caio. Não é pré-requisito.

---

## 7. Blast radius / o que NÃO quebrar
- Só cards parciais (com dossiê). **Extravio total intacto.**
- Determinístico → sem over-reach de LLM (princípio nº 1 preservado).
- Merge monotônico preservado.
- **Risco a vigiar (Hipótese):** Nível 1 marcar como romaneio um anexo que não é (ex.: cliente anexou a NF, não
  o romaneio). Mitigação: exigir indicador "romaneio" no corpo + guarda anti-pedido; e o Nível 2 corrobora.
- **Risco a vigiar (Hipótese):** oc 33 lançada INCOMPLETA (como 66193) — mas nesse caso a oc 49 pede romaneio
  também → Nível 2 não marca. Auto-protegido; Codex deve confirmar em mais amostras.

---

## 8. Guards (não-regressão)
- Testes puros novos (fixtures reais):
  - `detectarRomaneioNoHistorico`: PDF inbound + corpo "segue o romaneio assinado" → presente;
    anexo sem menção a romaneio → null; corpo "aguardo o romaneio" (pedido) → null.
  - `romaneioAceitoPeloSsw`: oc 33 + oc 49 "descrição e valor" → true (575330); oc 33 + oc 49 "descrição,
    valor e romaneio" → false (66193); sem oc 33 → false.
- `/verify-cockpit` INV-034: item "dossiê semeia romaneio do histórico (email_anexos/oc49)".
- ADR 0011 adendo + memória `[[project_extravio_parcial_dossie_gate_oc33]]`.

---

## 9. Perguntas para o Codex
1. O par (Nível 1 OR Nível 2) ataca a RAIZ (escopo da evidência) ou ainda é remendo? Falta alguma fonte
   (ex.: anexo usado em oc 33 lançada via Cockpit, com `anexos_ids` no todo)?
2. Nível 2: tratar "oc 33 lançada + oc 49 não pede romaneio ⟹ romaneio presente" é seguro? Contra-exemplos?
3. Nível 1: quão restritivo deve ser o match de "romaneio" no corpo para não pegar pedido do próprio Sal?
   Vale restringir a remetente = domínio do cliente (não @salexpress)?
4. Descrição/valor também devem ser semeados do histórico, ou só o romaneio (que é o que chega "cedo")?
5. Onde rodar o seed: só no interpretador, ou também no `sync-bastao` quando o dossiê é herdado na reabertura?
6. Nível 3 (detecção determinística de parcial) entra nesta rodada ou fica para depois?
7. Quantas causas independentes? (Hipótese: é UMA — "dossiê só olha a resposta corrente" — com 1 sintoma.)

---

## 10. Restrições de execução (auditoria)
READ-ONLY; nada de migration/deploy/executor com side effect; não ligar flags; separar
Fato/Inferência/Hipótese/Decisão.
