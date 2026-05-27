# Lovable — Banner IA: botão "Ver evidência" inline + alerta caixa lacrada

**Data:** 2026-05-27
**Backend:** já deployado. Agente `agente-sugere-ocs-padrao` agora popula 2 campos novos no `cards.aviso_alteracao_oc`:

```ts
{
  // ... campos existentes ...
  alerta_caixa_lacrada: boolean | null,           // só oc=35 (null nas outras)
  alerta_caixa_lacrada_motivo: string | null,     // descrição visual da IA
  evidencia_foto_url: string,                     // URL pra abrir foto direto
}
```

E o `observacao_orquestrador` do banner já vem com `⚠️ EVIDÊNCIA INDICA CAIXA LACRADA — ...` quando aplicável.

## Mudanças no `BannerSugestaoIA.tsx`

### 1. Botão "Ver evidência" inline

Adicionar botão secundário no banner que abre modal/lightbox com a foto da ocorrência puxada via edge `foto-oc-card`. Evita que operador precise abrir aba HISTÓRICO SSW separada.

```tsx
{card.aviso_alteracao_oc?.evidencia_foto_url && (
  <button
    onClick={() => abrirModalEvidencia(card.id, card.cod_ultima_ocorrencia)}
    className="inline-flex items-center gap-1 text-caption text-ink-soft hover:text-ink border border-ink-mute/30 px-3 py-1.5 rounded-md hover:border-ink"
  >
    🖼 Ver evidência
  </button>
)}
```

O `abrirModalEvidencia` chama a edge `foto-oc-card` (já existe — memory `project_foto_oc_card_bonus`) que devolve JPEG/PDF do SSW interno e exibe num lightbox `<img>` ou `<embed>`.

```tsx
async function abrirModalEvidencia(cardId: string, codigoOc: number) {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/foto-oc-card?card_id=${cardId}&codigo_oc=${codigoOc}`;
  // Abre num modal lightbox passando token via header — ou usa proxy assinado.
  setModalEvidencia({ url, token, codigoOc });
}
```

Componente do modal (simples):

```tsx
<Dialog open={!!modalEvidencia} onOpenChange={() => setModalEvidencia(null)}>
  <DialogContent className="max-w-3xl">
    <DialogHeader>
      <DialogTitle>Evidência — oc={modalEvidencia?.codigoOc}</DialogTitle>
    </DialogHeader>
    {modalEvidencia && (
      <img
        src={modalEvidencia.url}
        alt={`Foto oc=${modalEvidencia.codigoOc}`}
        className="w-full h-auto rounded-md"
        onError={() => toast.error("Foto não disponível no SSW")}
      />
    )}
  </DialogContent>
</Dialog>
```

**Nota:** se `foto-oc-card` retornar 404 (`oc_sem_foto`), o botão não deve aparecer. Pode-se condicionar:

```tsx
{(card.cod_ultima_ocorrencia !== 11 && card.aviso_alteracao_oc?.evidencia_foto_url) && (
  <button>🖼 Ver evidência</button>
)}
```

(oc=11 raramente tem foto útil — opcional)

### 2. Chip de alerta caixa lacrada (oc=35)

Quando `aviso_alteracao_oc?.alerta_caixa_lacrada === true`, mostrar chip amarelo destacado **acima** do botão de aprovar:

```tsx
{card.aviso_alteracao_oc?.alerta_caixa_lacrada && (
  <div className="bg-amber-50 border-l-4 border-amber-400 px-4 py-2 rounded-r-md mb-3">
    <p className="text-amber-800 text-caption font-medium">
      ⚠️ Evidência indica caixa lacrada
    </p>
    <p className="text-amber-700 text-caption mt-1">
      {card.aviso_alteracao_oc.alerta_caixa_lacrada_motivo ??
        "IA detectou indicação de falta de itens em embalagem íntegra."}
    </p>
    <p className="text-amber-700 text-caption mt-1 italic">
      Pode não haver devolução real — apenas ressarcimento dos itens faltantes.
      Revise o template e o corpo do email antes de aprovar (você pode editar
      manualmente).
    </p>
  </div>
)}
```

## Substituição

No `BannerSugestaoIA.tsx`, adicionar os 2 blocos:

1. **Chip de alerta caixa lacrada** — antes do bloco de ações (acima dos botões de aprovar/IA errou/IA acertou).
2. **Botão "Ver evidência"** — entre o botão primário "Aprovar oc=54+email" e o botão "Ver outras opções →" (rodapé do banner).

## Exemplo visual

```
┌─ ✦ Recomendado pelo Agente IA ──────────────────────┐
│ Lançar oc=54 + email — Recusa Parcial               │
│ Confiança: 60% ⚠                                     │
│                                                       │
│ "Cliente abriu caixa e identificou falta de 2 itens." │
│                                                       │
│ ⚠️ Evidência indica caixa lacrada                     │
│ IA detectou texto 'lacre íntegro' na ressalva +       │
│ foto mostra embalagem fechada.                        │
│ Pode não haver devolução real — apenas ressarcimento  │
│ dos itens faltantes.                                  │
│                                                       │
│ [✓ Aprovar oc=54+email]   [🖼 Ver evidência]          │
│ [Ver outras opções →]                                 │
│                                                       │
│        ✦ 3 acertos · ✓ IA acertou · ⌐ IA errou        │
└───────────────────────────────────────────────────────┘
```

## Validação

1. Card oc=35 com IA Vision detectando caixa lacrada → chip aparece + botão "Ver evidência" abre foto.
2. Card oc=10/11/19/49 normal → sem chip, mas botão "Ver evidência" continua disponível.
3. Card oc=11 sem foto (típico) → botão pode ficar oculto ou mostrar mensagem "Sem foto disponível".

Cola no Lovable.
