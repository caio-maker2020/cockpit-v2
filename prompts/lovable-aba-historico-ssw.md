# Lovable — Aba HISTÓRICO SSW no card + botão "Trazer Histórico SSW"

## Contexto

No card detalhado já existem várias abas (PARA FAZER, AÇÃO EXECUTADA, AGUARDANDO VOCÊ, CLIENTE RESPONDEU, AUDITORIA, etc). Vamos adicionar **uma aba nova: HISTÓRICO SSW**.

A aba mostra um snapshot das ocorrências históricas dessa NF no SSW (sistema da transportadora). Larissa hoje precisa abrir o SSW manualmente pra ver isso — agora dá pra trazer com 1 clique.

**Caio 2026-05-12**: backend pronto. Edge function `puxar-historico-ssw-card` recebe `{card_id}`, loga no SSW interno, busca a NF, lista todas as ocorrências, e grava em 2 colunas:
- `cards.historico_ssw` (jsonb array)
- `cards.historico_ssw_atualizado_em` (timestamptz)

Latência típica: 2-3 segundos.

---

## Layout da aba

```
┌──────────────────────────────────────────────────────────────────┐
│  HISTÓRICO SSW                                                   │
│                                                                   │
│  Atualizado: 05/12 09:36 (há 3 min)  [🔄 Trazer Histórico SSW]   │
│                                                                   │
│  ─── Linha temporal (mais recente em cima) ──────────────────    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 05/05/26 17:16 · VGA · l.silva                              │ │
│  │ 54 — AGUARDANDO RETORNO DO CLIENTE PAGADOR                  │ │
│  │ "AGUARDANDO RETORNO DO CLIENTE PAGADOR"                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 04/05/26 13:28 · BHZ · t.darlan                             │ │
│  │ 49 — TRATATIVA DE RELACIONAMENTO PARA LIBERACAO DE CARG     │ │
│  │ "ACAREACAO - ROMANEIO DE COLETA - VALOR (LANCAR A 54 ...)"  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 22/04/26 15:58 · AMP · l.silva                              │ │
│  │ 54 — AGUARDANDO RETORNO DO CLIENTE PAGADOR     [📷 Foto]    │ │
│  │ "AGUARDANDO RETORNO DO CLIENTE PAGADOR"                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ... (mais entradas)                                              │
└──────────────────────────────────────────────────────────────────┘
```

### Cabeçalho da aba

- **Esquerda**: texto "Atualizado: {data formatada} (há X min)" — calcular delta entre `historico_ssw_atualizado_em` e agora.
- **Direita**: botão `🔄 Trazer Histórico SSW`.

### Botão "Trazer Histórico SSW"

- Sempre visível.
- Texto inicial: `🔄 Trazer Histórico SSW` (quando nunca puxou) ou `🔄 Atualizar` (quando já tem snapshot).
- Ao clicar:
  1. Trocar texto pra `⏳ Buscando no SSW... (~3s)`, desabilitar.
  2. Chamar `supabase.functions.invoke('puxar-historico-ssw-card', { body: { card_id: card.id } })`.
  3. Sucesso (`data.ok === true`): atualizar a aba com a nova lista. Toast verde `✓ {data.total} ocorrências carregadas`.
  4. Erro: toast vermelho `✕ Falha ao puxar histórico SSW: {error.message}` (geralmente sessão SSW expirou — backend re-loga automaticamente, então retentar funciona).

### Lista de ocorrências

Renderiza `card.historico_ssw` (array). Mais recente em cima (o backend já entrega ordenado).

Cada item (card branco com borda fina):
- Header: `{data} · {filial} · {usuario}` (texto cinza pequeno)
- Título: `{codigo} — {descricao}` (preto, médio)
- Subtítulo: `"{instrucao}"` em itálico cinza (oculta se vazia ou igual à descricao)
- Botão `📷 Ver Foto` no canto direito se `tem_foto === true` (cor azul claro)

#### Botão "📷 Ver Foto" (Caio 2026-05-13)

Quando `tem_foto === true`, renderizar botão clicável. Ao clicar:

1. Abrir modal/dialog (componente Lovable existente — usar o padrão de modal de imagem)
2. Mostrar spinner com texto `Buscando foto no SSW... (~3s)`
3. Chamar a edge function `foto-oc-card`:

```ts
async function abrirFoto(card_id: string, codigo_oc: number) {
  setLoadingFoto(true);
  try {
    const resp = await supabase.functions.invoke('foto-oc-card', {
      body: { card_id, codigo_oc },
    });
    // Edge function retorna binary inline em status 200, ou JSON com erro em 404/502.
    // Como o invoke wrapper trata binary diferente, melhor usar fetch direto:
    const fetchResp = await fetch(
      `${SUPABASE_URL}/functions/v1/foto-oc-card`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ card_id, codigo_oc }),
      },
    );
    if (!fetchResp.ok) {
      const err = await fetchResp.json();
      if (err.error === "oc_sem_foto") {
        toast.info("Essa ocorrência não tem foto anexada no SSW ainda.");
      } else {
        toast.error(`Não foi possível abrir a foto: ${err.error}`);
      }
      return;
    }
    // Sucesso — foto binary inline
    const blob = await fetchResp.blob();
    const objectUrl = URL.createObjectURL(blob);
    setFotoModal({ open: true, url: objectUrl, codigo_oc });
    // Limpar URL ao fechar modal: URL.revokeObjectURL(objectUrl)
  } catch (e) {
    toast.error(`Erro ao buscar foto: ${e.message}`);
  } finally {
    setLoadingFoto(false);
  }
}
```

4. Modal mostra imagem (`<img src={objectUrl} />`) com botão "Baixar" (`<a download>`) e "Fechar".
5. `URL.revokeObjectURL` ao fechar modal pra evitar memory leak.

**Fallback se foto não estiver no SSW ainda** (`error: "oc_sem_foto"`): toast informativo, não abre modal.

---

#### Botão "🔍 Interpretar Evidência" (Caio 2026-05-13)

**Nova feature — IA Vision lê a foto e sugere tratativa pra Larissa.**

**Posição:** dentro do CARD da ocorrência no histórico (ao lado do botão "📷 Ver Foto"), NÃO dentro do modal de foto. Assim Larissa pode interpretar sem precisar abrir a foto. Só aparece quando `tem_foto === true`.

Dentro do modal de foto (quando aberto com sucesso), ADICIONAR um segundo botão:

```
[ ⬇️ Baixar foto ]   [ 🔍 Interpretar Evidência (IA) ]   [ Fechar ]
```

Ao clicar "🔍 Interpretar Evidência":

1. Mostrar spinner "Analisando evidência com IA... (~15s)" (fica visível ~15s — Claude Vision lendo manuscritos demora).
2. Chamar edge function:

```ts
const resp = await fetch(`${SUPABASE_URL}/functions/v1/interpretador-evidencia-foto`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${session.access_token}`,
    "apikey": SUPABASE_ANON_KEY,
  },
  body: JSON.stringify({ card_id, codigo_oc }),
});
const data = await resp.json();
```

3. Resposta `data.analise` tem o JSON estruturado. Renderizar **um painel lateral ou abaixo da foto** com layout:

```
┌─────────────────────────────────────────────────────────────────┐
│ 📝 Transcrição manuscrita                                       │
│ "{analise.transcricao_manuscrita}"                              │
│                                                                  │
│ 🗒  Partes relevantes                                            │
│   Carimbos:                                                      │
│     • {analise.partes_relevantes.carimbos[0]}                   │
│   Assinaturas:                                                   │
│     • {analise.partes_relevantes.assinaturas[0]}                │
│     • {analise.partes_relevantes.assinaturas[1]}                │
│   Datas:                                                         │
│     • {analise.partes_relevantes.datas[0]}                      │
│                                                                  │
│ 📌 Resumo                                                        │
│ {analise.resumo_situacao}                                       │
│                                                                  │
│ ─────────────────────────────────────────────────────────────   │
│                                                                  │
│ 🤖 Sugestão da IA (confiança: {analise.confianca * 100}%)       │
│                                                                  │
│ Lançar oc {analise.oc_sugerida}                                 │
│ Template email: {analise.template_email_sugerido ?? "—"}        │
│                                                                  │
│ Por quê: {analise.motivo_sugestao}                              │
│                                                                  │
│ ⚠️ Validação humana obrigatória — sugestão NÃO é aplicada       │
│    automática. Você decide aprovar pela aba AGUARDANDO VOCÊ.    │
└─────────────────────────────────────────────────────────────────┘
```

4. Tratamento de erros:
   - `error: "oc_sem_foto"` → toast "Foto não disponível pra essa oc"
   - `error: "ssw_erro"` → toast "Não foi possível abrir a foto no SSW"
   - status 502 com erro Anthropic → toast "IA indisponível, tente novamente em alguns minutos"

5. Resultado fica salvo em `card_events.EvidenciaSugestaoIA` no payload → auditoria automática.

**Não dispara nada** — apenas mostra sugestão. Larissa continua aprovando manualmente via banner do card AGUARDANDO VOCÊ.

Códigos null (eventos sem código): renderizar só a instrução sem o cabeçalho de código.

### Estado vazio (nunca puxou OU expirou após 24h)

Se `card.historico_ssw === null` ou `card.historico_ssw === []` (snapshot pode estar nulo porque nunca foi puxado OU porque expirou após 24h — cleanup automático no banco):

```
┌──────────────────────────────────────────────────────────────────┐
│  HISTÓRICO SSW                                                   │
│                                                                   │
│  Nenhum histórico carregado ainda.                               │
│                                                                   │
│              [🔄 Trazer Histórico SSW]                            │
│                                                                   │
│  O agente vai logar no SSW e trazer todas as ocorrências dessa   │
│  NF. Latência típica ~3s.                                        │
│                                                                   │
│  ℹ️ Snapshot fica salvo por 24h pra economizar storage. Depois    │
│  você precisa clicar de novo pra puxar versão atualizada.        │
└──────────────────────────────────────────────────────────────────┘
```

### Botão sempre habilitado (mesmo com snapshot recente)

Larissa pode clicar "🔄 Atualizar" mesmo se o snapshot foi puxado há 5 min — é o jeito de forçar refresh quando ela suspeita que tem oc nova no SSW. Não bloquear o botão por throttling.

---

## Posição da aba

Adicionar entre as abas existentes do card. Sugestão de ordem (do esquerdo pro direito):

1. PARA FAZER / AÇÃO EXECUTADA / AGUARDANDO VOCÊ / CLIENTE RESPONDEU (as 4 existentes)
2. **HISTÓRICO SSW** (nova)
3. AUDITORIA (mantém no fim)

---

## Contrato técnico (backend)

Endpoint `puxar-historico-ssw-card` já deployado. Chamada:

```ts
const { data, error } = await supabase.functions.invoke('puxar-historico-ssw-card', {
  body: { card_id: card.id }
});

if (error || !data?.ok) {
  toast.error("Falha ao puxar histórico SSW: " + (error?.message ?? data?.error));
  return;
}

// data.total, data.atualizado_em, data.ocorrencias[], data.ultima_oc
toast.success(`${data.total} ocorrências carregadas`);
// Front pode re-fetchar o card via PostgREST ou usar data.ocorrencias direto
```

### Formato de cada ocorrência

```ts
{
  codigo: number | null,         // ex: 54, 49, 10, ou null pra eventos sem código
  descricao: string,             // ex: "AGUARDANDO RETORNO DO CLIENTE PAGADOR"
  instrucao: string,             // ex: "AGUARDANDO RETORNO DO CLIENTE PAGADOR"
  data: string,                  // ex: "05/05/26 17:16"
  filial: string | null,         // ex: "VGA"
  usuario: string | null,        // ex: "l.silva"
  tem_foto: boolean              // se a oc tem foto vinculada no SSW
}
```

---

## Resumo da UI

| Elemento | Mudança |
|---|---|
| Card detalhado | Nova aba "HISTÓRICO SSW" |
| Header da aba | "Atualizado: X (há N min)" + botão "🔄 Trazer/Atualizar" |
| Lista | Cards por ocorrência, ordenados (mais recente em cima) |
| Estado vazio | Mensagem + botão grande "Trazer Histórico SSW" |
| Endpoint | `supabase.functions.invoke('puxar-historico-ssw-card', { body: { card_id } })` |
| Latência | ~2-3s (login SSW + scraping) |

Nada mais muda no resto do card. A aba é read-only — Larissa só consulta.
