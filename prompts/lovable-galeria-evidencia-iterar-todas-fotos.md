# Lovable — Galeria HISTÓRICO SSW deve mostrar TODAS as fotos da oc (não só a 1ª)

## Problema (NF 362406, operadora Larissa, oc=49)
No card, ao abrir a foto de uma ocorrência com várias fotos, aparece **só a 1ª**.
No SSW essa oc tem **8 fotos** (paginadores `01 02 … 08`). Os números `01..08` que
você talvez esteja renderizando vêm do **viewer cru do SSW** (`ajaxEnvia('FOT_N')`)
— eles **só funcionam dentro da sessão do portal SSW** e ficam **mortos no card**,
por isso só a foto 01 carrega.

✅ Backend já confirmado correto: ele serve as 8 fotos. O front é que precisa
parar de depender do viewer do SSW / de iterar idx às cegas.

## Solução: consumir o MANIFESTO (1 chamada lista TODAS as fotos)

A edge function `foto-oc-card` agora tem um **modo `list`** que devolve, em JSON, a
lista completa das fotos da oc. O front renderiza a galeria com um `map` sobre essa
lista (declarativo) — assim **nunca** mais mostra 1 quando há N.

### 1) Buscar o manifesto
`POST {SUPABASE_URL}/functions/v1/foto-oc-card`
Headers: `Authorization: Bearer <JWT do operador>`, `Content-Type: application/json`
Body:
```json
{ "card_id": "<uuid>", "codigo_oc": 49, "list": true }
```
Resposta (200):
```json
{
  "ok": true,
  "codigo_oc": 49,
  "fotos_total": 8,
  "incompleto": false,
  "fotos": [
    { "idx": 0, "oc_descricao": "TRATATIVA…", "foto_data": "29/06/26 15:23", "foto_instrucao": "FOTO ID INSERIDA" },
    { "idx": 1, "oc_descricao": "…", "foto_data": "…", "foto_instrucao": "…" }
    // … até idx 7
  ]
}
```
Erros: `ok:false` com `error` ∈ `oc_sem_foto` (404) / `oc_nao_encontrada` (404) /
`ssw_erro` (502).

### 2) Renderizar a galeria a partir de `fotos` (declarativo)
Para cada item de `fotos`, mostrar a imagem buscando o **binário** no mesmo
endpoint, **modo binário** (sem `list`), passando o `idx`:
```
POST /functions/v1/foto-oc-card
{ "card_id": "<uuid>", "codigo_oc": 49, "idx": <f.idx> }
→ image/jpeg (ou application/pdf) inline
```
Renderize como `manifesto.fotos.map(f => <img src={fetchFoto(f.idx)} />)` com
contador **"{i+1} de {fotos_total}"** e navegação/miniaturas. Use `foto_data` +
`foto_instrucao` no rótulo de cada foto. **Não** pare no idx 0; **não** embuta o
viewer do SSW.

### 3) Tratar `incompleto`
Se `incompleto === true`, mostrar um aviso discreto tipo
**"Pode haver fotos não carregadas — abrir no SSW para conferir"**. Isso sinaliza
que a contagem pode estar subestimada (falha transitória no SSW) — melhor avisar do
que esconder.

## Critério de aceite
- Card NF **362406** → oc **49**: galeria mostra **"1 de 8"** e navega pelas 8
  fotos distintas.
- Uma oc com 1 foto (ex.: oc 6 desta NF) mostra "1 de 1" sem navegação.

## Não fazer
- Não embutir/iframe do viewer SSW (`ssw0122`) nem os links `01..08` dele.
- Não assumir 1 foto por oc; não parar no idx 0.
- Não usar `historico_ssw` para contar fotos — ele só tem `tem_foto` (booleano).
  A lista completa vem do modo `list` do `foto-oc-card`.
