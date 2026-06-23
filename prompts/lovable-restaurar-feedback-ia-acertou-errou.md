# Lovable — RESTAURAR "IA acertou / IA errou" + detalhamento no banner da Sugestão da IA

**Data:** 2026-06-23
**Por quê:** O widget de feedback (👍 acertou / 👎 errou + detalhamento do erro) **sumiu do front** numa regeneração. O backend está 100% intacto (tabela + RPC + view já em produção desde mig 160). Esta é uma reintrodução **só de UI** — nenhuma mudança de backend é necessária.

> Sintoma reportado: o card mostra "🤖 SUGESTÃO DA IA — Lançar oc X (CONFIANÇA …%)" e o banner laranja de pendências, mas **não há mais** os botões "IA acertou / IA errou" nem o modal que pede o detalhamento do erro. Precisa voltar **e gravar os dados**.

---

## Onde aparece

No card de detalhe, dentro do banner **roxo/lavanda "🤖 SUGESTÃO DA IA"** — o que renderiza quando `cards.ia_sugestao_oc_resposta` está populado (qualquer oc: 21/33/44/54/55/56). Os botões 👍/👎 ficam **no canto superior direito do banner**, ao lado da pílula "CONFIANÇA", pequenos e discretos (não competem com o CTA "APROVAR OC X").

> Importante: o widget deve aparecer **mesmo quando a oc sugerida é 54** (manter aguardando) e **mesmo quando `rebaixado_de_oc21_por_pendencia === true`**. Esse é justamente o caso em que o feedback é mais valioso (o operador valida se o rebaixamento automático foi certo).

---

## Contrato de backend (NÃO mudar nada — já existe)

### Gravar feedback explícito — RPC

```ts
// 👍 acertou
await supabase.rpc("registrar_feedback_interpretador_resposta_ia", {
  p_card_id: cardId,
  p_acertou: true,
  p_decisao_correta_codigo_ssw: null,   // opcional no acerto
  p_motivo_correcao: null,              // opcional no acerto
});

// 👎 errou  (motivo OBRIGATÓRIO, >= 10 chars — a RPC rejeita com erro 22023 se faltar)
await supabase.rpc("registrar_feedback_interpretador_resposta_ia", {
  p_card_id: cardId,
  p_acertou: false,
  p_decisao_correta_codigo_ssw: codigoCorreto, // int ou null ("não sei")
  p_motivo_correcao: motivo,                    // string >= 10 chars
});
```

- A RPC é **idempotente (upsert)**: o operador pode trocar 👍↔👎 quantas vezes quiser.
- Ela já resolve `auth.uid() → operadores.id` internamente (não passar operador).
- Erros possíveis a exibir via toast: `Operador não autenticado` (42501), `Card sem sugestão IA` (P0002), `Motivo obrigatório (mínimo 10 caracteres)` (22023). Sempre mostrar `error.message` no toast.

### Ler feedback já registrado (pra mostrar estado final)

```ts
const { data: feedback } = await supabase
  .from("interpretador_resposta_cliente_feedback")
  .select("id, tipo_feedback, motivo_correcao, decisao_correta_codigo_ssw, corrigido_em")
  .eq("card_id", cardId)
  .eq("origem", "explicito")            // só o feedback explícito do operador
  .eq("message_id", sugestao.message_id) // o email que gerou ESTA sugestão
  .maybeSingle();
// tipo_feedback ∈ "acertou_explicito" | "errou_explicito"
```

### Dropdown "qual oc seria a correta" — SEMPRE do dicionário (nunca hardcode)

Regra fixa do projeto: lista de ocs no front vem **sempre** de `ocorrencias_dicionario` (dinâmico), nunca array fixo no código.

```ts
const { data: ocs } = await supabase
  .from("ocorrencias_dicionario")
  .select("codigo, descricao")
  .order("codigo");
// render: <option value={o.codigo}>{o.codigo} — {o.descricao}</option>
// primeira opção fixa: "— não sei / não se aplica —" (value vazio → envia null)
```

---

## Comportamento da UI

### Estados dos botões
- **Sem feedback ainda:** dois botões outline — `👍 acertou` (verde) e `👎 errou` (vermelho). Ambos clicáveis.
- **Clicou 👍:** chama a RPC com `p_acertou: true` direto (sem modal) → vira pílula sólida verde "✓ você marcou: acertou" + link tiny "alterar →".
- **Clicou 👎:** abre o **modal de detalhamento** (abaixo). Só grava após salvar. Depois vira pílula sólida vermelha "✗ você marcou: errou" + link "alterar →".
- **Já tem feedback:** mostra a pílula do estado final + "alterar →" que reabre o fluxo (👍 vira clique direto; 👎 reabre o modal). Upsert no backend cuida da troca.

### Modal "IA errou — me ajude a melhorar" (o detalhamento que sumiu)

Campos:
1. **"Qual oc seria a correta?" (opcional)** — `<select>` populado do `ocorrencias_dicionario` (ver acima). Default "— não sei / não se aplica —" → envia `null`.
2. **"O que a IA errou? / O que era o certo?" (obrigatório, ≥ 10 caracteres)** — `<textarea>`. Placeholder contextual, ex.: *"Cliente só pediu pra aguardar, não confirmou endereço/data — não era pra sugerir reentrega (oc 21), era pra responder cobrando."*
3. Botão **Salvar feedback** desabilitado enquanto `motivo.trim().length < 10`.

Ao salvar: chama a RPC com `p_acertou: false`, `p_decisao_correta_codigo_ssw: <codigo ou null>`, `p_motivo_correcao: <motivo>`. Toast de sucesso, fecha o modal, recarrega o feedback.

---

## NÃO QUEBRAR
- O fluxo "APROVAR OC X" / "VER OUTRAS N OPÇÕES" do banner segue intacto.
- O banner laranja de pendências ("Responder cliente" / "Ignorar e seguir") continua independente, acima das propostas.
- Realtime sub em `cards` continua.
- O modal de feedback é overlay — não bloqueia outras ações do card.
- O dropdown de ocs **tem que** vir de `ocorrencias_dicionario` — não recriar lista fixa.

---

## Os outros dois banners de IA usam o MESMO padrão (mesma UI, RPCs diferentes)

Se os botões também sumiram nos banners de oc=13 e ocs-padrão (10/11/19/35), aplicar o **mesmo widget** trocando só a RPC:

| Banner | 👍 acertou (RPC) | 👎 errou (RPC) | Tabela de leitura |
|---|---|---|---|
| Sugestão resposta cliente (este) | `registrar_feedback_interpretador_resposta_ia(p_card_id, p_acertou:true)` | `registrar_feedback_interpretador_resposta_ia(p_card_id, p_acertou:false, p_decisao_correta_codigo_ssw, p_motivo_correcao)` | `interpretador_resposta_cliente_feedback` |
| Agente oc=13 | `registrar_acerto_oc13_ia(p_card_id, p_observacao?)` | `registrar_feedback_oc13_ia(p_card_id, p_decisao_correta_codigo_ssw, p_motivo_correcao)` | `agente_oc13_feedback` |
| Agente ocs-padrão 10/11/19/35 | `registrar_acerto_ocs_padrao_ia(p_card_id, p_observacao?)` | `registrar_feedback_ocs_padrao_ia(p_card_id, p_decisao_correta_codigo_ssw, p_motivo_correcao)` | `agente_ocs_padrao_feedback` |

> Atenção (oc=13 / ocs-padrão): usar a assinatura de **3 argumentos** `(p_card_id, p_decisao_correta_codigo_ssw, p_motivo_correcao)`. A versão antiga de 4 args foi removida (mig 192) — chamar a antiga dá erro de FK.

---

## Resumo
| Antes (bug) | Depois |
|---|---|
| Sem botões de feedback no banner da IA | 👍/👎 de volta no header do banner |
| Erro da IA não é capturado | 👎 abre modal pedindo **detalhamento (≥10 chars) + qual oc era a certa** |
| — | Tudo gravado em `interpretador_resposta_cliente_feedback` via RPC idempotente |
| — | Dropdown de oc vindo do `ocorrencias_dicionario` (dinâmico) |
