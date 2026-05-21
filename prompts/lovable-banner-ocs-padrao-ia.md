# Lovable — Banner agente IA pra ocs padrão (10/11/19/35) + feedback loop

**Data:** 2026-05-23
**Backend:** já está em produção. Migrations 150-152 aplicadas, edge `agente-sugere-ocs-padrao` deployada, cron `*/5min` ativo. Esse prompt mexe SÓ no frontend.

**Skill ativada:** `frontend-design` — mesmo padrão visual do banner oc=13 (lovable-banner-oc13-ia-autonoma.md). Diferença chave: aqui **nunca tem ação autônoma**, só sugestão.

---

## Contexto

Cards com `cod_ultima_ocorrencia ∈ (10, 11, 19, 35)` de **todos os clientes/operadores** agora têm um agente IA que roda a cada 5min, **só sugere** próxima ação (oc=54+template OU oc=56). Sem ação autônoma.

Regras por oc (orquestrador):
- **oc=10 (RECUSA TOTAL):** precisa ressalva escrita motivo → sugere `54 + RECUSA_TOTAL`. Senão → `56`.
- **oc=11 (ENDEREÇO):** lê GPS na instrução SSW. ≤4000m → sugere `54 + PROBLEMAS_COM_ENDERECO`. >4000m ou sem GPS → `56`.
- **oc=19 (FALTA VOLUMES):** precisa ressalva escrita volumes → `54 + FALTA_DE_VOLUME`. Senão → `56`.
- **oc=35 (RECUSA PARCIAL):** ressalva + CT-e de devolução → `54 + RECUSA_PARCIAL` (alta confiança). Só ressalva → `54` (confiança média, alerta CT-e ausente). Sem ressalva → `56`.

---

## 1. Campos novos lidos pelo front

```ts
cards.analise_padrao_status: 'pendente' | 'analisando' | 'concluida' | 'falhou' | null
cards.analise_padrao_resultado: {
  proposta_destacada?: 54 | 56,
  template_email_sugerido?: 'RECUSA_TOTAL' | 'RECUSA_PARCIAL' | 'FALTA_DE_VOLUME' | 'PROBLEMAS_COM_ENDERECO' | null,
  corpo_email_sugerido?: string | null,
  motivo_extraido?: string | null,
  foto_classificacao?: string | null,
  tem_ressalva?: boolean,
  ressalva_texto?: string | null,
  ressalva_tipo?: 'motivo_recusa' | 'falta_volumes' | 'endereco_errado' | 'outro' | null,
  gps_distancia_metros?: number | null,         // só oc=11
  gps_dentro_threshold?: boolean | null,        // só oc=11
  tem_cte_devolucao?: boolean | null,           // só oc=35
  cte_devolucao_numero?: string | null,         // só oc=35
  confianca?: number,
  observacao_orquestrador?: string,
  // em falha:
  erro_msg?: string,
  categoria?: string,
  tentativa?: number,
  max_tentativas?: number,
}
cards.aviso_alteracao_oc: {
  tipo?: 'ia_sugestao_ocs_padrao' | 'ia_ocs_padrao_falhou',
  // demais campos por tipo
}
```

Renderizar SÓ se `card.cod_ultima_ocorrencia ∈ (10,11,19,35)` E `card.analise_padrao_status` populado.

---

## 2. Estados visuais

### Estado A — Analisando/pendente

```
┌─────────────────────────────────────────────────────────┐
│ 🤖 Agente IA analisando evidência da oc={codigo}...     │
│ (tentativa {tentativas}/3)                              │
└─────────────────────────────────────────────────────────┘
```

Cor: azul claro. Spinner no ícone.

### Estado B — Sugestão concluída (oc=54)

`analise_padrao_resultado.proposta_destacada === 54`

```
┌─────────────────────────────────────────────────────────┐
│ 💡 RECOMENDADO PELO AGENTE IA                            │
│                                                          │
│ Motivo extraído: {motivo_extraido}                       │
│ Confiança: {confianca em %}                              │
│                                                          │
│ {observacao_orquestrador}                                │
│                                                          │
│ Próximo passo sugerido: oc=54 + template                 │
│ {template_email_sugerido (humanizado)}                   │
│                                                          │
│ Corpo do email já pré-preenchido pelo agente:            │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ {corpo_email_sugerido — display compacto}           │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ [❌ IA errou]                                             │
└─────────────────────────────────────────────────────────┘
```

Cor: verde claro. Borda esquerda verde.
Badge "⭐ Recomendado IA" SOMENTE na proposta oc=54+email do card (entre as 4 propostas existentes).

**Específico oc=11:** mostrar bloco extra com GPS:
```
📍 Distância GPS da baixa: {gps_distancia_metros}m
   (dentro do limite de 4000m — evidência confiável)
```

**Específico oc=35:** mostrar status do CT-e devolução:
```
📦 CT-e de devolução: {cte_devolucao_numero ? '✓ ' + numero : '⚠ Não localizado'}
```

### Estado C — Sugestão concluída (oc=56)

`analise_padrao_resultado.proposta_destacada === 56`

```
┌─────────────────────────────────────────────────────────┐
│ ⚠️ RECOMENDADO PELO AGENTE IA: lançar oc=56             │
│                                                          │
│ {observacao_orquestrador}                                │
│                                                          │
│ Próximo passo sugerido: oc=56 (Operação revisa antes)    │
│                                                          │
│ [❌ IA errou]                                             │
└─────────────────────────────────────────────────────────┘
```

Cor: amarelo/âmbar. Sem template email (oc=56 não envia email).
Badge "⭐ Recomendado IA" na proposta oc=56 do card.

**Específico oc=11 com GPS desviado:**
```
📍 Distância GPS da baixa: {gps_distancia_metros}m
   (acima de 4000m — motorista pode ter baixado em local errado)
```

### Estado D — Falhou

`analise_padrao_status === 'falhou'`

```
┌─────────────────────────────────────────────────────────┐
│ ⚠️ Agente IA falhou ({tentativa}/3 tentativas)           │
│                                                          │
│ Categoria: {categoria humanizada}                        │
│ Detalhe: {erro_msg}                                      │
│                                                          │
│ Você pode aprovar manualmente as propostas abaixo, ou    │
│ aguardar próxima tentativa em ~10min.                    │
└─────────────────────────────────────────────────────────┘
```

Cor: vermelho/laranja claro.

**Mapping categoria → label** (mesmo padrão do oc=13):
```ts
const CATEGORIA_ERRO_LABELS = {
  timeout_anthropic: "Timeout na IA Anthropic",
  ssw_offline: "Portal SSW offline ou lento",
  foto_corrompida: "Foto da oc corrompida ou ausente no SSW",
  json_invalido: "Resposta da IA não veio em JSON válido",
  historico_sem_oc: "Histórico SSW não tem a oc esperada",
  erro_desconhecido: "Erro desconhecido",
};
```

---

## 3. Modal "IA errou"

Mesmo padrão do oc=13 (lovable-banner-oc13-ia-autonoma.md seção 2), mas:
- Sempre `tipo_feedback = 'sugestao_errada_explicita'` (não tem branch autônomo)
- Submit chama RPC nova:

```ts
const { data, error } = await supabase.rpc("registrar_feedback_ocs_padrao_ia", {
  p_card_id: cardId,
  p_decisao_correta_codigo_ssw: codigoSelecionado,
  p_motivo_correcao: motivoTexto.trim(),
});
```

Toast sucesso: "Feedback registrado — vai abastecer o indicador de acerto da IA pra ocs padrão."

---

## 4. Templates de email humanizados

```ts
const TEMPLATE_LABELS = {
  RECUSA_TOTAL: "Recusa total",
  RECUSA_PARCIAL: "Recusa parcial",
  FALTA_DE_VOLUME: "Falta de volume",
  PROBLEMAS_COM_ENDERECO: "Problemas com endereço",
};
```

---

## 5. Pré-preencher template no aprovar oc=54

Quando operador clica em "Aprovar oc=54+email" (a proposta destacada), o composer deve:

1. Carregar `template_email_sugerido` como template default selecionado
2. Substituir corpo do template pelo `corpo_email_sugerido` (IA já gerou texto contextualizado com motivo)
3. Operador edita se quiser e envia

Se o composer já popula via outro fluxo, garantir que `corpo_email_sugerido` tem precedência sobre o template raw quando IA tem sugestão.

---

## Resumo do que muda

| Onde | O que muda |
|---|---|
| Card oc=10/11/19/35 (qualquer aba) | Banner novo com 4 estados (A/B/C/D) lendo `analise_padrao_status` + `_resultado` |
| Proposta oc=54 ou oc=56 (a destacada) | Ganha badge "⭐ Recomendado IA" |
| Composer oc=54+email | Pré-preenche template + corpo via `template_email_sugerido` + `corpo_email_sugerido` |
| Botão "IA errou" | Visível nos estados B e C; modal → RPC `registrar_feedback_ocs_padrao_ia` |

Nada mais muda — as propostas existentes (21/54/56/41) seguem normais. Operador continua decidindo. O agente NUNCA age sozinho — só sugere.
