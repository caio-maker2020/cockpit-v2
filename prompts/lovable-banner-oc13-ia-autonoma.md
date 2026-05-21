# Lovable — Banner agente IA oc=13 + modal "IA errou" (feedback loop)

**Data:** 2026-05-22
**Backend:** já está em produção. Migrations 146/147/148/149 aplicadas, edges deployadas, cron `*/5 * * * *` ativo. Esse prompt mexe SÓ no frontend.

**Skill ativada:** `frontend-design` — consistente com banners existentes (`aviso_alteracao_oc`). Cores semânticas (verde IA, amarelo aviso/aguardando, vermelho erro), microcopy direta, ícones objetivos.

---

## Contexto

Cards com `cod_ultima_ocorrencia = 13` de clientes na tabela `cliente_config_oc13` (F E F / Larissa, O.V.D / Duilio, etc) agora têm um agente IA autônomo (`agente-oc13-autonomo`) que roda a cada 5min. Esse agente:

- Lê histórico SSW
- Classifica a foto da oc=13 (destinatário / local fechado / aleatória / ilegível)
- Lê instrução escrita do motorista
- Decide entre: **ação autônoma** (lançar oc=21 + cancelar reentrega +24h) OU **sugestão pro operador** (lançar oc=54+email com template pré-preenchido)
- Se IA falhar (Anthropic timeout, SSW offline, etc): retry 10min × 3, depois fica manual

O front precisa exibir esse status no card e dar ao operador a possibilidade de discordar (feedback loop).

---

## 1. Estados (controlados por `cards.analise_oc13_status` + `cards.analise_oc13_resultado`)

Esses campos novos em `cards`:

```ts
analise_oc13_status: 'pendente' | 'analisando' | 'concluida' | 'falhou' | null
analise_oc13_resultado: {
  decisao?: 'autonoma' | 'sugerir_54_email' | 'operador_antecipou',
  subtipo?: string,
  motivo_extraido?: string | null,
  motivo_cancelamento?: string,
  texto_descricao?: string,
  foto_classificacao?: 'destinatario' | 'local_fechado' | 'aleatoria' | 'sem_foto' | 'ilegivel',
  confianca?: number,
  template_email_sugerido?: string,
  todo_id?: string,
  // só em falha:
  erro_msg?: string,
  categoria?: string,
  tentativa?: number,
  max_tentativas?: number,
} | null
aviso_alteracao_oc: {
  tipo?: 'ia_oc13_autonoma' | 'ia_sugestao_oc13' | 'ia_oc13_falhou',
  // demais campos variam por tipo (ver abaixo)
}
```

Renderizar banner SÓ se `card.cod_ultima_ocorrencia === 13` E `card.analise_oc13_status` está populado.

### Estado A — "pendente / analisando"

`analise_oc13_status IN ('pendente','analisando','falhou')` E `analise_oc13_resultado IS NULL`

```
┌─────────────────────────────────────────────────────────┐
│ 🤖 Agente IA analisando evidência da oc=13...           │
│ (tentativa {analise_oc13_tentativas}/3)                  │
└─────────────────────────────────────────────────────────┘
```

Cor: azul claro (cor info), borda esquerda azul.
Sem botões. Spinner leve animado no ícone.

### Estado B — Concluída autônoma

`analise_oc13_resultado.decisao === 'autonoma'`

```
┌─────────────────────────────────────────────────────────┐
│ ⚡ AÇÃO AUTÔNOMA EXECUTADA pelo Agente IA               │
│                                                          │
│ Motivo do cancelamento: {motivo_cancelamento}            │
│ Sub-tipo: {subtipo (humanizado — ver mapping abaixo)}    │
│                                                          │
│ ✓ oc=21 lançada no SSW                                  │
│ ✓ Cancelamento de reentrega agendado +24h                │
│ ✓ Erro reportado no indicador (EVIDÊNCIA INCOMPLETA)     │
│                                                          │
│ [📋 Ver na aba AUDITORIA]   [❌ IA errou]                │
└─────────────────────────────────────────────────────────┘
```

Cor: âmbar / amarelo (ação executada — não é erro nem sucesso operacional, é decisão autônoma).
Borda esquerda âmbar.

**Mapping de sub_tipo → label legível:**
```ts
const SUBTIPO_LABELS_AUTONOMO: Record<string, string> = {
  fora_horario_comercial: "Fora do horário comercial (seg-sex 8h-18h)",
  sem_foto: "Sem foto anexada",
  foto_destinatario_sem_motivo: "Foto no destinatário sem motivo escrito",
  local_fechado_sem_justificativa: "Local fechado sem justificativa adicional",
  foto_nao_comprova: "Foto não comprova a tentativa",
};
```

### Estado C — Sugestão manual (operador decide)

`analise_oc13_resultado.decisao === 'sugerir_54_email'`

- Card permanece em AVH+lock; as 4 propostas existentes (21/54+email/56/41) ficam visíveis normalmente
- Mas a proposta **oc=54+email** ganha destaque visual:

```
┌─────────────────────────────────────────────────────────┐
│ 💡 RECOMENDADO PELO AGENTE IA                            │
│                                                          │
│ Motivo extraído: {motivo_extraido}                       │
│ Classificação da foto: {foto_classificacao (humanizado)} │
│ Template sugerido: {template_email_sugerido}             │
│ Confiança: {confianca em %}                              │
│                                                          │
│ Pré-popular o template pré-preenchido com motivo ao      │
│ clicar "Aprovar oc=54+email".                            │
│                                                          │
│ [❌ IA errou]                                             │
└─────────────────────────────────────────────────────────┘
```

Cor: verde claro (sugestão IA = orientação positiva). Borda esquerda verde.
Badge "⭐ Recomendado IA" SOMENTE na proposta oc=54+email (não nas outras).

**Mapping foto_classificacao → label:**
```ts
const FOTO_CLASS_LABELS: Record<string, string> = {
  destinatario: "Foto no destinatário (fachada/recepção)",
  local_fechado: "Local fechado",
  aleatoria: "Foto aleatória / sem contexto",
  ilegivel: "Foto ilegível",
  sem_foto: "Sem foto",
};
```

### Estado D — Falhou (após 3 tentativas)

`analise_oc13_status === 'falhou'` E `analise_oc13_resultado.tentativa >= analise_oc13_resultado.max_tentativas`

```
┌─────────────────────────────────────────────────────────┐
│ ⚠️ Agente IA falhou ({tentativa}/3 tentativas)           │
│                                                          │
│ Categoria do erro: {categoria humanizada}                │
│ Detalhe: {erro_msg}                                      │
│                                                          │
│ Você pode aprovar manualmente as propostas abaixo, ou    │
│ aguardar próxima tentativa em ~10min.                    │
└─────────────────────────────────────────────────────────┘
```

Cor: vermelho/laranja claro. Borda vermelha.
Sem botão "IA errou" (não tem decisão pra contestar).

**Mapping categoria → label:**
```ts
const CATEGORIA_ERRO_LABELS: Record<string, string> = {
  timeout_anthropic: "Timeout na IA Anthropic",
  ssw_offline: "Portal SSW offline ou lento",
  foto_corrompida: "Foto da oc=13 corrompida ou ausente no SSW",
  json_invalido: "Resposta da IA não veio em JSON válido",
  card_sem_credencial_ssw: "Sem credenciais SSW pro operador deste card",
  historico_sem_oc13: "Histórico SSW não tem linha oc=13",
  erro_desconhecido: "Erro desconhecido",
};
```

Estado "ainda tentando" (tentativa < max): banner mesmo do Estado A com a mensagem ajustada — "Última tentativa falhou ({categoria}); próxima em ~10min (tentativa {tentativa+1}/3)".

---

## 2. Modal "IA errou" (botão dos estados B e C)

Quando operador clica `[❌ IA errou]`, abre modal:

```
┌──────────────────────────────────────────────────────┐
│ Você acha que a IA decidiu errado neste card?     ✕  │
│                                                       │
│ Decisão da IA: {decisao + subtipo OU recomendou 54}  │
│                                                       │
│ Qual era a decisão correta? *                         │
│ ┌──────────────────────────────────────────────────┐ │
│ │  ▾ Selecione                                      │ │
│ └──────────────────────────────────────────────────┘ │
│ Opções:                                               │
│  • 21 — REENTREGA SOLICITADA                          │
│  • 54 — AGUARDANDO POSICIONAMENTO DO CLIENTE          │
│  • 56 — FALTA INFO OPERACIONAL                        │
│  • 41 — INFORMAÇÃO COMPLEMENTAR                       │
│  • Outro (texto livre)                                │
│                                                       │
│ Por que a IA errou? * (mín 10 chars)                  │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Ex: a foto na verdade era do destinatário e o    │ │
│ │ motivo estava ilegível mas existia.              │ │
│ └──────────────────────────────────────────────────┘ │
│ {motivoTexto.length} / 10 mín                         │
│                                                       │
│              [ Cancelar ]   [ Enviar feedback ]       │
└──────────────────────────────────────────────────────┘
```

Tipo de feedback enviado (decidido automaticamente pelo client):
- Se `decisao === 'autonoma'` → `tipo_feedback = 'autonoma_errada'`
- Se `decisao === 'sugerir_54_email'` → `tipo_feedback = 'sugestao_errada_explicita'`

**Submit:**

```ts
async function enviarFeedbackIaErrou() {
  const codigo = opcaoSelecionada === "outro" ? null : Number(opcaoSelecionada);
  const { data, error } = await supabase.rpc("registrar_feedback_oc13_ia", {
    p_card_id: cardId,
    p_tipo_feedback: card.analise_oc13_resultado.decisao === "autonoma"
      ? "autonoma_errada"
      : "sugestao_errada_explicita",
    p_decisao_correta_codigo_ssw: codigo,
    p_motivo_correcao: motivoTexto.trim(),
  });
  if (error) {
    toast.error("Não foi possível registrar: " + error.message);
    return;
  }
  toast.success("Feedback registrado — vai abastecer o indicador de acerto da IA.");
  fecharModal();
}
```

Botão "Enviar feedback" desabilitado até `opcaoSelecionada !== null` E `motivoTexto.trim().length >= 10`.

---

## 3. Mensagens de erro do backend (toasts)

A RPC retorna mensagens claras — mostrar `error.message` no toast já basta:

- `"Operador não autenticado"` (auth perdeu)
- `"Motivo da correção é obrigatório (mínimo 10 caracteres)"` (já prevenido client-side)
- `"Card X não tem análise IA oc=13 — feedback inaplicável"` (race se card foi resetado)
- `"Sem permissão pra registrar feedback neste card"` (RLS — operador erradoo)

---

## Resumo do que muda

| Onde | O que muda |
|---|---|
| Card oc=13 (em qualquer aba) | Banner novo com 4 estados (A/B/C/D) lendo `analise_oc13_status` + `analise_oc13_resultado` |
| Proposta oc=54+email (em estado C) | Ganha badge "⭐ Recomendado IA" + template email pré-preenchido com `motivo_extraido` |
| Botão "IA errou" | Visível nos estados B e C; abre modal de feedback → RPC `registrar_feedback_oc13_ia` |

Nada mais muda — as 4 propostas existentes seguem normais. O agente NUNCA muda state nem lock do card de fora do executor (que é o mesmo fluxo que já existia).
