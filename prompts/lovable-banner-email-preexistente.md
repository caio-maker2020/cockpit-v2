# Lovable — Detalhe do card: banner "E-mail anterior desse cliente sobre essa NF"

**Data:** 2026-06-22
**Escopo:** 100% frontend (detalhe do card). Backend já está pronto e atrás de flag.

## Problema (casos reais — NF 30459 / Victor, NF 114668 / Duilio)

Muitas vezes o **cliente (ou uma base/parceiro) abre um e-mail questionando a NF ANTES de
existir card** no Cockpit. O operador acaba tratando manualmente dentro dessa thread e o
Cockpit nunca "vê" essa conversa → **perde o tracking** e o agente sugere ações do zero.

Agora, quando o card nasce, um job busca no Gmail do operador se já existe uma thread daquele
**cliente** sobre aquela **NF** (com vínculo robusto de cliente — nunca sobe e-mail de NF de
outro cliente). Se acha, grava a sugestão no card. **Falta o front**: mostrar o banner e deixar
o operador **validar** e **decidir** (Seguir nesta thread / Abrir e-mail novo).

---

## Backend — já pronto (nada a fazer no banco)

| Item | Fonte | Observação |
|---|---|---|
| Dado do banner | **view `v_email_preexistente`** | já filtra não-vistos/não-decididos + RLS por operador |
| (alternativa) | coluna `cards.email_preexistente_sugerido` (jsonb) | mesma info, caso prefira ler do card |
| Decisão "Seguir" | RPC `adotar_thread_preexistente(p_card_id uuid, p_gmail_thread_id text)` | importa histórico + assume o canal (async ~2min) |
| Decisão "Abrir novo" | RPC `descartar_email_preexistente(p_card_id uuid)` | some o banner, segue fluxo normal |
| Snooze "Depois" | RPC `marcar_email_preexistente_visto(p_card_id uuid)` | some o banner sem decidir |

### Shape da view `v_email_preexistente`
```ts
{
  card_id: string;
  nf: string;
  state: string;
  assigned_operator_id: string;
  detectado_em: string;          // ISO
  qtd_candidatos: number;
  candidatos: Array<{
    gmail_thread_id: string;
    assunto: string;             // ex.: "DMDC // NFs: 30459 e 30460 _ HIPER CARIJOS..."
    score: number;               // ordenação (maior = mais forte)
    nf_no_assunto: boolean;      // true = NF citada no assunto (mais confiável)
    iniciada_em: string | null;  // ISO da 1ª msg da thread
    qtd_mensagens: number;
    tem_sent_operador: boolean;  // operador já respondeu manual nessa thread
    participantes: string[];     // e-mails externos (ex.: ["adriano.souza@alfaparfdbdc.com.br"])
    preview: Array<{ direcao: "inbound"|"outbound"; de: string|null; ts: string|null; snippet: string }>;
  }>;
}
```

Consulta sugerida no front (por card aberto):
```ts
const { data } = await supabase
  .from("v_email_preexistente")
  .select("*")
  .eq("card_id", cardId)
  .maybeSingle();
// data == null  → sem sugestão ativa (não renderiza o banner)
```

### Assinaturas das RPCs (todas retornam jsonb `{ ok, ... }`, exceto a de snooze que é void)
```ts
// Seguir nesta thread (precisa do checkbox de validação marcado)
await supabase.rpc("adotar_thread_preexistente", { p_card_id, p_gmail_thread_id });
//   → { ok:true, decisao:"seguir", importacao:"enfileirada" }
//   → { ok:false, error:"..." }  (thread fora dos candidatos / card de outro operador)

// Abrir e-mail novo (descarta a sugestão)
await supabase.rpc("descartar_email_preexistente", { p_card_id });
//   → { ok:true, decisao:"novo" }

// Depois (snooze — some até o próximo scan)
await supabase.rpc("marcar_email_preexistente_visto", { p_card_id });
```

---

## UI — banner colapsável no topo do detalhe do card

Renderiza **só quando** `v_email_preexistente` retorna linha pro card. Estilo no padrão dos
outros banners de decisão (ver `lovable-aba-conflitos-forcar-atualizacao.md` e
`lovable-tratativas-email-multiplas.md`), colapsável (ver `lovable-card-detalhe-modo-foco-colapsavel.md`).

```
┌──────────────────────────────────────────────────────────────────── [▴] ┐
│ 🔗 ENCONTRAMOS UM E-MAIL ANTERIOR DESSE CLIENTE SOBRE ESSA NF             │
│                                                                          │
│ Assunto: DMDC // NFs: 30459 e 30460 _ HIPER CARIJOS LTDA - 40            │
│ Participantes: adriano.souza@alfaparfdbdc.com.br                         │
│ 6 mensagens · iniciada em 15/06 (antes do card) · ✅ você já respondeu   │
│                                                                          │
│ ▸ Prévia:                                                                │
│   ⟵ adriano.souza@…  "Poderia verificar o motivo do atraso nas notas…"   │
│   ⟶ você  "Extravio de 1V identificado, podemos seguir parcialmente?"    │
│   ⟵ adriano.souza@…  "Solicito seguir com a entrega mesmo com faltas…"   │
│                                                                          │
│ ☐ Confirmo que este e-mail é da NF 30459                                 │
│                                                                          │
│ [ ✓ Seguir nesta thread ]   [ Abrir e-mail novo ]            [ Depois ]  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Regras
- **Mostra o candidato de maior `score` em destaque.** Se `qtd_candidatos > 1`, um link
  "ver outras N tratativas" expande os demais (cada um com seu próprio botão Seguir).
- **Selo "iniciada antes do card"** quando `iniciada_em < card.created_at` (é o caso-alvo).
- **Selo "✅ você já respondeu"** quando `tem_sent_operador === true`.
- Badge de confiança pelo `score`/`nf_no_assunto`: NF no assunto = "alta"; só no corpo = "média".
- **Checkbox de validação obrigatório**: o botão **"Seguir nesta thread"** fica **desabilitado**
  até o operador marcar "Confirmo que este e-mail é da NF {nf}". (O sistema sugere; o humano valida.)

### Ações
1. **Seguir nesta thread** (com checkbox marcado) → `adotar_thread_preexistente(card_id, gmail_thread_id do candidato)`.
   - Em `ok:true`: trocar o banner por um estado **"Importando a conversa… (até ~2 min)"** e
     fechar. A importação roda em background (cron 2min): em seguida a thread aparece na aba
     **MENSAGENS** do card (histórico inbound + seus envios), e o agente publica uma sugestão de
     ação (banner de sugestão IA já existente). Não precisa o operador fazer mais nada.
   - Em `ok:false`: toast com `error`.
2. **Abrir e-mail novo** → `descartar_email_preexistente(card_id)` → some o banner; o operador
   segue no fluxo normal (compõe e-mail novo pela aba Resposta).
3. **Depois** → `marcar_email_preexistente_visto(card_id)` → some o banner (volta no próximo scan).

---

## Tokens visuais (design system v3)
- Tom do banner: **indigo/informativo** (distinto do vermelho de conflito e do âmbar do agente).
  Sugestão: fundo `--info-soft`, borda-esquerda 3px `--info`, texto `--ink`.
- Dados técnicos (NF, datas, e-mails) em `JetBrains Mono` (`--font-mono`); corpo em
  `Bricolage Grotesque` (`--font-body`).
- Botão primário "Seguir nesta thread" sólido; "Abrir e-mail novo" outline; "Depois" ghost.
- Colapsável animado (height/opacity ~150ms), recolhido vira faixa fina de 1 linha:
  `🔗 E-mail anterior do cliente sobre a NF {nf} — [Seguir] [Novo]  [▾]`.

---

## Smoke test
1. Card da NF 30459 (Victor) com a flag ON e a thread DMDC no Gmail dele → banner aparece com
   o assunto certo, participante `@alfaparfdbdc.com.br`, "iniciada antes do card", "você já respondeu".
2. Botão "Seguir" começa **desabilitado**; marcar o checkbox habilita.
3. Clicar "Seguir" → banner vira "Importando a conversa…"; após ~2 min, a aba MENSAGENS mostra o
   histórico e surge a sugestão do agente.
4. Em outro card, clicar "Abrir e-mail novo" → banner some; nenhuma thread é adotada.
5. Card SEM sugestão (view retorna null) → nenhum banner (topo limpo).

---

---

## Variante `contexto = 'card_em_espera'` (resposta do cliente em OUTRA thread)

A view agora retorna um campo **`contexto`**: `'nascimento'` (tudo acima — cliente abriu a
thread ANTES do card) **ou** `'card_em_espera'`. Este segundo caso é diferente e mais urgente:

> O card está em **AGUARDANDO_CLIENTE** (o Cockpit já notificou e está esperando), e detectamos
> que o cliente/base **respondeu numa thread SEPARADA** da que o Cockpit abriu — uma conversa
> que estava passando batida. Ex. real: NF 617089 (Duilio/OVD) — Cockpit notificou em 16/06,
> a base OVD abriu *"ATRASO DE ENTREGA/ EXTRAVIO | NF 617089/2 | … CHAMADO 1154294"* em 22/06.

O backend **não muda o estado do card** com base nessa detecção (a trava NF+cliente+domínio é
forte, mas quem confirma é o operador). A transição pra CLIENTE RESPONDEU de verdade só acontece
quando o operador clica **Seguir** (a adoção importa a thread → vira resposta do cliente pelo
fluxo normal). Então o front precisa de **2 coisas** pra esse contexto:

### 1. Puxar o card pra aba **CLIENTE RESPONDEU**
A aba CLIENTE RESPONDEU hoje filtra `state==='AGUARDANDO_VALIDACAO_HUMANA' && cliente_respondeu_em!=null`.
**Adicione um OR**: incluir também os cards que têm sugestão `card_em_espera` ativa:
```ts
// CLIENTE RESPONDEU (passa a ser a união):
(state === 'AGUARDANDO_VALIDACAO_HUMANA' && cliente_respondeu_em != null)
|| (v_email_preexistente.contexto === 'card_em_espera')   // card ainda em AGUARDANDO_CLIENTE
```
Busca: `supabase.from('v_email_preexistente').select('*').eq('contexto','card_em_espera')` →
junta esses card_ids na lista da aba. Badge distinto (pra diferenciar da resposta normal):
```
📨 POSSÍVEL RESPOSTA EM OUTRA THREAD · valide
NF 617089 — MEF MATERIAIS · "ATRASO DE ENTREGA/ EXTRAVIO | NF 617089/2 | CHAMADO 1154294"
```

### 2. Aviso na aba **RESPOSTA** do card (decisão do operador)
No detalhe do card (aba RESPOSTA), quando `contexto==='card_em_espera'`, mostrar um aviso âmbar
ACIMA do compositor:
```
┌────────────────────────────────────────────────────────────────────────┐
│ 📨 DETECTAMOS UMA POSSÍVEL RESPOSTA DO CLIENTE EM OUTRA THREAD            │
│ O cliente/base respondeu numa conversa separada da que notificamos —     │
│ confirme se é verdadeira e da NF {nf}.                                    │
│                                                                          │
│ Assunto: ATRASO DE ENTREGA/ EXTRAVIO | NF 617089/2 | … CHAMADO 1154294   │
│ Participantes: sabrina.oliveira@ovd.com.br, jhonatan.rogato@ovd.com.br   │
│ ▸ Prévia: …(preview[])…                                                  │
│                                                                          │
│ ☐ Confirmo que esta thread é do cliente e da NF {nf}                     │
│ [ ✓ Seguir nesta thread ]                 [ Não é verdadeira / descartar ]│
└──────────────────────────────────────────────────────────────────────────┘
```
- **Seguir nesta thread** (checkbox marcado) → `adotar_thread_preexistente(card_id, gmail_thread_id)`.
  A adoção importa o histórico (inclusive **romaneio/NFD anexados**), assume o canal e o card
  passa pra CLIENTE RESPONDEU de verdade (`cliente_respondeu_em` setado pelo fluxo normal) + o
  agente sugere a próxima ação. Trocar o aviso por "Importando… (~2 min)".
- **Não é verdadeira / descartar** → `descartar_email_preexistente(card_id)` → some o aviso, card
  segue normal em AGUARDANDO_CLIENTE.

> Copy: no `contexto='nascimento'` o título é *"Encontramos um e-mail anterior…"*; no
> `card_em_espera` é *"Detectamos uma possível resposta em outra thread…"*. Mesmas RPCs.

---

## Resumo de 1 linha
No detalhe do card, renderizar um banner indigo a partir da view `v_email_preexistente`
(campo `contexto`) com prévia do histórico + checkbox de validação, e 3 ações
(`adotar_thread_preexistente` / `descartar_email_preexistente` / `marcar_email_preexistente_visto`);
no `contexto='card_em_espera'` o card também entra na aba CLIENTE RESPONDEU com aviso na aba RESPOSTA.
Zero mudança de backend.
