# P0/P1 LOVABLE — Galeria de evidência SSW deve mostrar TODAS as fotos (via manifesto)

## Contexto (backend já pronto em produção)
A Edge Function `foto-oc-card` (v26) já suporta o modo manifesto. NÃO mexer no backend.

- **Manifesto (metadata de todas as fotos, sem binário):**
  `supabase.functions.invoke('foto-oc-card', { body: { card_id, codigo_oc, list: true } })`
  → JSON:
  ```json
  {
    "ok": true,
    "codigo_oc": 49,
    "fotos_total": 8,
    "incompleto": false,
    "fotos": [ { "idx": 0, "oc_descricao": "...", "foto_data": "26/06 14:37", "foto_instrucao": "..." }, ... ]
  }
  ```
- **Imagem binária de UMA foto:**
  `supabase.functions.invoke('foto-oc-card', { body: { card_id, codigo_oc, idx } })`
  → retorna o binário (Blob, image/jpeg ou application/pdf).

## Bug
A galeria ainda pode mostrar só a 1ª foto (fixando `idx=0` ou lendo o header `X-Fotos-Total`).
Perigoso: o operador decide vendo evidência INCOMPLETA.

## Correção (front-only, MODO LOVABLE)

### 1. Ao abrir a evidência de uma oc com foto, PRIMEIRO buscar o manifesto
```ts
const { data: manifesto, error } = await supabase.functions.invoke('foto-oc-card', {
  body: { card_id, codigo_oc, list: true },
});
if (error || !manifesto?.ok) { /* ver passo 9 */ }
```

### 2. Renderizar a galeria a partir de `manifesto.fotos.map(...)` — NUNCA assumir idx=0
```tsx
manifesto.fotos.map((foto) => <FotoThumb key={foto.idx} foto={foto} />)
```
NÃO existe caminho que renderize só `fotos[0]`.

### 3. Para cada foto, carregar o binário pelo MESMO endpoint com `idx: foto.idx`
```ts
const { data: blob } = await supabase.functions.invoke('foto-oc-card', {
  body: { card_id, codigo_oc, idx: foto.idx },
});
const url = URL.createObjectURL(blob);   // usar em <img src={url}>; revokeObjectURL ao desmontar
```
O `idx` SEMPRE vem de `manifesto.fotos[i].idx` (não de um contador local que assume 0).

### 4. Contador
Mostrar `foto atual / manifesto.fotos_total` (ex.: "3 / 8"). Usar `manifesto.fotos_total`,
não o header `X-Fotos-Total`.

### 5. Aviso de incompleto
Se `manifesto.incompleto === true`, mostrar aviso discreto:
"Pode haver fotos não carregadas do SSW. Confira o SSW se necessário."

### 6–8. Proibições
- NÃO embutir o viewer cru do SSW (iframe/HTML do portal).
- NÃO depender dos paginadores `ajaxEnvia('FOT_N')` do SSW.
- NÃO deduzir a quantidade só pelo header `X-Fotos-Total`. A verdade é `manifesto.fotos_total`
  (= `manifesto.fotos.length`).

### 9. Falha do `list:true`
Se `list:true` falhar (error ou `ok:false`): mostrar erro claro
("Não consegui carregar as fotos da ocorrência — tente de novo") + botão **Tentar de novo**
que refaz o passo 1. Tratar os `error` do backend: `oc_sem_foto` (mostrar "sem foto"),
`oc_nao_encontrada`, `ssw_erro`.

## Metadata por foto (usar no header de cada imagem)
Cada `foto` traz `foto_data` e `foto_instrucao` — mostrar no rótulo (ex.:
"26/06 14:37 · RECUSA TOTAL DA ENTREGA") pra diferenciar fotos de linhas/lançamentos distintos.

## Critérios de aceite
- Ocorrência com 8 fotos mostra **8 fotos navegáveis**.
- **Nenhum** caminho da galeria fixa `idx=0` como única foto.
- `manifesto.fotos_total === quantidade exibida`.
- Cada `<img>` usa `idx` vindo de `manifesto.fotos`.
- Validar no DevTools/Network: 1 chamada `list:true` + N chamadas `idx` (uma por foto).

## Referência
INV-012 / INV-012b (`docs/INVARIANTES_COCKPIT.md`). Backend: `foto-oc-card` + `_shared/foto-oc-manifest.ts`.
Sempre `supabase.functions.invoke` (nunca `fetch` + VITE_SUPABASE_URL).
