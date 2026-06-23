# Lovable — FIX URGENTE: restaurar features do banner "RECOMENDADO PELO AGENTE IA" que o regen derrubou

**Data:** 2026-06-23
**Contexto:** Uma regeneração recente do card de detalhe **apagou várias features vizinhas** do banner do agente (ocs 10/11/19/35). O backend NÃO mudou — todos os dados continuam lá. Este prompt é **só restauração de UI**. **NÃO regenere o card inteiro** — adicione/recoloque só os blocos abaixo e **não remova** nada que já funciona (feedback 👍/👎, propostas, "VER OUTRAS OPÇÕES").

> ⚠️ REGRA ANTI-REGRESSÃO: estas features JÁ existiam e foram definidas em prompts anteriores (`lovable-banner-ocs-padrao-ia.md`, `lovable-banner-evidencia-inline-e-alerta-caixa-lacrada.md`, `lovable-banner-evidencia-galeria-multifoto.md`, `lovable-banner-transcricao-ressalva-destacada.md`, `lovable-acao-lancar-so-54-sem-email.md`, `lovable-modal-edicao-email-CONSOLIDADO.md`). Ao aplicar, **preserve** todas elas juntas.

Todos os campos vêm de `cards.aviso_alteracao_oc` (JSONB) e dos `todos` (propostas). Nenhum endpoint novo.

---

## 1. Botão "🖼 VER EVIDÊNCIA" (sumiu) — voltar

Renderizar quando `card.aviso_alteracao_oc?.evidencia_foto_url` existir:

```tsx
{card.aviso_alteracao_oc?.evidencia_foto_url && (
  <button onClick={() => abrirModalEvidencia(card.id, card.cod_ultima_ocorrencia)}>
    🖼 Ver evidência
  </button>
)}
```

O modal chama a edge `foto-oc-card` (POST `{ card_id, codigo_oc, idx }`). Ela devolve a imagem binária + headers `X-Fotos-Total` / `X-Idx-Atual` / `X-Foto-Data` / `X-Foto-Instrucao`. Se `X-Fotos-Total > 1`, mostrar setas ← → + contador "X de N" (galeria multifoto). Detalhe completo em `lovable-banner-evidencia-galeria-multifoto.md`.

## 2. Transcrição da ressalva + interpretação da foto (sumiu) — voltar

Bloco destacado (âmbar), ANTES da observação do orquestrador, só pra ocs 10/19/35:

```tsx
const aviso = card.aviso_alteracao_oc;
const temRessalva = aviso?.tem_ressalva === true && !!aviso?.ressalva_texto?.trim();

{temRessalva ? (
  <div className="border-l-4 border-amber-400 bg-amber-50/60 p-3">
    <span className="font-semibold uppercase text-amber-900">📝 Transcrição da ressalva (lida da foto pela IA)</span>
    <blockquote className="font-mono">"{aviso.ressalva_texto}"</blockquote>
  </div>
) : (
  <p className="text-amber-700">⚠️ A IA não encontrou ressalva manuscrita legível na foto.</p>
)}
```

Também mostrar, quando presentes: `aviso.alerta_caixa_lacrada` (+ `alerta_caixa_lacrada_motivo`) pra oc=35, e GPS (`gps_distancia_metros`, `gps_dentro_threshold`) pra oc=11.

## 3. A "análise" (texto principal) — corrigir o que renderiza

O texto principal do banner deve ser **`aviso.observacao_orquestrador`** (narrativa do agente) + a transcrição acima — **NÃO** `motivo_extraido` cru (que pode ser só o título genérico da oc tipo "ENTREGA IMPOSSIBILITADA: LIMITACAO CLIENTE"). Se `observacao_orquestrador` estiver vazio, mostrar estado de análise pendente/falha conforme `analise_padrao_status` (`pendente`/`analisando`/`concluida`/`falhou`) — ver `lovable-banner-ocs-padrao-ia.md`. Nunca cair em exibir só a descrição crua da oc como se fosse análise.

## 4. As DUAS opções de 54 ("+ email" e "sem email") — sumiu uma — voltar

O backend cria 2 `todos` pra oc 54: um "com email" e um gêmeo "sem email". Distinguir por `proposta_payload.meta.sem_email_explicito`:

```tsx
// proposta com meta.sem_email_explicito === true  → "LANÇAR oc 54 (sem e-mail)"  → botão "LANÇAR →" (executa DIRETO, sem abrir editor)
// proposta sem essa flag (modo completo)          → "Lançar oc 54 + e-mail"      → botão "APROVAR oc 54 + e-mail" (abre o editor)
```

Renderizar AMBAS lado a lado. Detalhe em `lovable-acao-lancar-so-54-sem-email.md`.

## 5. "APROVAR oc 54 + email" tem que abrir o MODAL de email DIRETO (regressão de UX)

Hoje o clique manda pra um segundo passo na direita ("ABRIR EDITOR") e exige clicar de novo. Voltar ao comportamento: **clicar "APROVAR oc 54 + e-mail" abre o modal de edição de email imediatamente** (composer com assunto + corpo pré-preenchidos), e o ENVIO só acontece a partir do botão dentro do modal. Ver `lovable-modal-edicao-email-CONSOLIDADO.md`.

## 6. Mostrar erro de envio (CRÍTICO — hoje "não acontece nada")

O envio é **assíncrono**: `aprovar_e_executar` enfileira e o executor envia depois. Quando o envio falha (ex: e-mail do cliente inválido), o card **reverte** pra AGUARDANDO VOCÊ e grava um `card_event` `EmailNaoEnviado` com o motivo. Hoje o front não mostra isso → operadora acha que "não fez nada".

Implementar: na tela do card (com realtime sub em `cards`/`card_events` que já existe), quando aparecer um evento recente `EmailNaoEnviado` OU `AcaoRevertidaPosFalha` pra aquele card, mostrar um **banner/toast vermelho** com a mensagem:

```tsx
// buscar o último card_event do card
// .from("card_events").select("event_type, payload, created_at").eq("card_id", id)
//   .in("event_type", ["EmailNaoEnviado","AcaoRevertidaPosFalha"]).order("created_at",{ascending:false}).limit(1)
// se for recente (após a última aprovação), mostrar:
<div className="border-l-4 border-red-500 bg-red-50 p-3">
  ⚠ O e-mail não foi enviado: {payload.motivo}
  {/* ex: "E-mail do destinatário inválido: nfe@vipshowroom.com.b — corrija o contato do cliente" */}
</div>
```

O backend agora retorna mensagens claras (ex.: e-mail inválido) — basta exibir `payload.motivo`.

---

## 7. Banner oc=13 (`ia_sugestao_oc13`) — MESMA regressão de evidência (banner separado)

O card de oc=13 usa um banner próprio (`aviso_alteracao_oc.tipo === "ia_sugestao_oc13"`, prompt `lovable-banner-oc13-ia-autonoma.md`). Ele sofreu a MESMA regressão: sumiu o resumo + interpretação da foto + a transcrição da ressalva, sobrando só o `motivo_extraido` cru (ex.: "ENTREGA IMPOSSIBILITADA: LIMITACAO CLIENTE", que é só o título genérico do SSW).

O dado rico está em **`cards.ia_sugestao_evidencia[String(card.cod_ultima_ocorrencia)].analise`** (chaveado pelo código da oc):

```ts
const ev = card.ia_sugestao_evidencia?.[String(card.cod_ultima_ocorrencia)]?.analise;
// ev.resumo_situacao   → narrativa do que a foto mostra (USE como "análise" principal)
// ev.ressalva_texto    → transcrição manuscrita literal (bloco âmbar destacado)
// ev.descricao_imagem  → descrição da imagem
// ev.confianca         → 0..1
```

Renderizar no banner oc=13:
- **Resumo/interpretação:** mostrar `ev.resumo_situacao` (NÃO o `motivo_extraido` cru) como o texto de análise.
- **Transcrição da ressalva:** bloco âmbar com `ev.ressalva_texto` (igual ao item 2 acima).
- **VER EVIDÊNCIA:** botão que abre `foto-oc-card` (POST `{ card_id, codigo_oc: card.cod_ultima_ocorrencia }`) — igual ao item 1.

> Caso âncora NF 1090394: `ev.resumo_situacao` = "Foto de documento 'DECLARAÇÃO PARA RETENÇÃO DE COMPROVANTE'… 20 volumes sem avaria…" — isso é o que o operador precisa ver, não "ENTREGA IMPOSSIBILITADA: LIMITACAO CLIENTE".

## NÃO QUEBRAR / NÃO REMOVER (tudo coexiste)
- Feedback 👍 acertou / 👎 errou + modal de detalhamento (recém-restaurado).
- Propostas + "VER OUTRAS OPÇÕES".
- Banner laranja de pendências (resposta do cliente) — independente.
- Dropdowns de oc vêm sempre de `ocorrencias_dicionario` (nunca hardcode).
- Realtime sub em `cards`.

## Resumo
| Sumiu / quebrou | Campo / fonte | Voltar pra |
|---|---|---|
| VER EVIDÊNCIA | `aviso_alteracao_oc.evidencia_foto_url` → edge `foto-oc-card` | botão + modal galeria |
| Transcrição/interpretação | `aviso.tem_ressalva` + `aviso.ressalva_texto` | bloco âmbar |
| Análise crua/horrível | `aviso.observacao_orquestrador` (não `motivo_extraido`) | texto principal |
| 2ª opção "54 sem email" | `todos` com `meta.sem_email_explicito` | 2 botões lado a lado |
| Modal de email não abre direto | — | abrir composer no clique de aprovar |
| "Não acontece nada" no envio | `card_events` `EmailNaoEnviado`/`AcaoRevertidaPosFalha` | banner vermelho com `payload.motivo` |
