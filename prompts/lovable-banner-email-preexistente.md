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

## Resumo de 1 linha
No detalhe do card, renderizar um banner indigo a partir da view `v_email_preexistente` com
prévia do histórico + checkbox de validação, e 3 ações (`adotar_thread_preexistente` /
`descartar_email_preexistente` / `marcar_email_preexistente_visto`). Zero mudança de backend.
