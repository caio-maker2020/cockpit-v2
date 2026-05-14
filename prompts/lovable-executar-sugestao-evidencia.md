# Lovable — botão EXECUTAR SUGESTÃO IA (pós-interpretar evidência)

## Contexto

Cada card pode ter foto de evidência no histórico SSW (ocs como 19, 10, 35, 49 etc). Operador hoje já tem:
- Botão **"Ver Foto"** na linha da oc (abre `/r?t=...` da Vercel) — funciona.
- Botão **"INTERPRETAR EVIDÊNCIA"** dentro de cada card de oc no histórico SSW (chama edge function `interpretador-evidencia-foto`) — funciona.

Após INTERPRETAR, a resposta da IA é mostrada num bloco com:
- Transcrição do manuscrito
- Resumo da situação
- **oc_sugerida** (54 ou 56)
- **template_email_sugerido** (RECUSA_TOTAL, PROBLEMAS_COM_ENDERECO, etc) — quando oc=54
- **corpo_email_sugerido** (rascunho do email pro cliente) — quando oc=54
- **motivo_sugestao** + **confianca**

A sugestão fica em `cards.ia_sugestao_evidencia[codigo_oc].analise` (cache 24h).

## O que adicionar

Logo abaixo do bloco com a resposta da IA, **adicionar um botão "EXECUTAR SUGESTÃO IA"** com regras:

### Visibilidade do botão

- **Aparece** quando `analise.oc_sugerida` é `54` OU `56`.
- **Esconde** se `analise` é null/vazio (operador ainda não interpretou).

### Texto do botão (dinâmico)

- Se `oc_sugerida === 54` e template definido → **"EXECUTAR SUGESTÃO IA: lançar oc 54 + email"**
- Se `oc_sugerida === 56` → **"EXECUTAR SUGESTÃO IA: lançar oc 56 (Operação)"**

### Comportamento ao clicar

1. Chama edge function `executar-sugestao-evidencia` via `supabase.functions.invoke`:
   ```js
   const { data, error } = await supabase.functions.invoke('executar-sugestao-evidencia', {
     body: { card_id: card.id, codigo_oc: codigoOcAnalisada }
   });
   ```
   - `card.id` = id do card atual
   - `codigoOcAnalisada` = a oc cuja foto foi interpretada (a chave do objeto `ia_sugestao_evidencia`, não a `oc_sugerida`)

2. Tratamento de resposta — em AMBOS os casos (`reused: true` ou `false`), o resultado pro operador é o mesmo: existe um todo pendente da sugestão IA pronto pra aprovar. NÃO tratar reused como "erro" ou "nada aconteceu":

   - `data.ok === true && data.reused === true` →
     - Toast info: "Proposta IA já está aguardando aprovação. Role pra baixo nas opções e clique APROVAR no item 'sugestão IA, evidência'."
     - **Destacar visualmente** (highlight/scroll) o todo de `proposta_payload.meta.origem === 'executar_sugestao_evidencia'` na lista de propostas pendentes.

   - `data.ok === true && data.reused !== true` →
     - Toast sucesso: "Proposta IA criada! Role pra baixo e clique APROVAR pra enviar." + detalhes:
       - Se `data.tem_email === true`: "Email pré-preenchido pelo IA — você pode editar antes de enviar."
       - Se `data.tem_email === false` e `data.oc === 54`: "Lançamento sem email (cliente sem email cadastrado)."
       - Se `data.oc === 56`: "Lançamento direto pra Operação (sem email cliente)."
     - Se `data.anexo_id`: "Foto da evidência anexada automaticamente."
     - Se `data.anexo_erro`: aviso amarelo "Foto SSW indisponível ({anexo_erro}) — proposta criada sem anexo."
     - **Destacar visualmente** o todo recém-criado (mesma lógica do `reused: true`).

   - `error` ou `data.ok === false` → toast erro com `data.error`.

### Identificando o todo da sugestão IA na lista

Pra destacar visualmente o todo certo na lista de propostas pendentes, filtre por:
- `todo.proposta_payload.meta.origem === 'executar_sugestao_evidencia'`

Sugestão de UI:
- Ícone diferente (ex: ✨ ou 🤖) ao lado da descrição
- Cor de fundo diferenciada (ex: azul claro)
- Texto da descrição já indica claramente: "(sugestão IA, evidência oc=X)"

3. Após sucesso, **refetch do card** (cards + todos pendentes) — Lovable já deve fazer isso quando state muda.

4. O card volta automaticamente pra aba "AGUARDANDO VOCÊ" (state=AGUARDANDO_VALIDACAO_HUMANA, lock=true) com a nova proposta listada. Operador clica em **APROVAR** (botão já existente) → modal de aprovação abre **idêntico ao de "Lançar 54 + email"**, com:
   - `proposta_payload.texto` pré-preenchido como corpo do email (editável)
   - `proposta_payload.args.anexos_ids` carregado no preview de anexos do modal (operador pode remover se quiser)
   - `proposta_payload.args.template_id` e `email_destino` aplicados

### Estado de loading

Enquanto a chamada está em andamento, desabilitar o botão e mostrar spinner. Timeout sugerido: 30s (a função pode demorar a baixar foto do SSW).

### Idempotência (importante)

Se operador clicar 2x, a edge function detecta e devolve o todo existente (`reused: true`). Front não precisa proteger contra duplo-clique — backend já segura.

---

## Schema da resposta da edge function

```json
{
  "ok": true,
  "todo_id": "uuid",
  "oc": 54,
  "tem_email": true,
  "email_destino": "cliente@empresa.com.br",
  "anexo_id": "uuid",
  "anexo_erro": null,
  "confianca_ia": 0.92,
  "reused": false  // só vem quando true
}
```

Erros (`ok: false`):
- `Sem sugestão IA cacheada pra essa oc. Clique em INTERPRETAR EVIDÊNCIA antes.`
- `Card sem chave_cte resolvida. Aguarde Pass F ou rode chave-cte-resolver manualmente.`
- `oc_sugerida inesperada: X. IA só sugere 54 ou 56.`

---

## Onde encaixar visualmente

No card aberto, na seção "Histórico SSW", em cada oc que tem evidência interpretada:

```
┌─ oc=35 (RECUSA PARCIAL) ──────────────────┐
│ [Ver Foto]  [INTERPRETAR EVIDÊNCIA]      │
│                                            │
│ 📋 Análise da IA:                          │
│ Transcrição: "..."                         │
│ Situação: ...                              │
│ → Sugestão: lançar oc 54 + RECUSA_PARCIAL  │
│ Email rascunho: "..."                      │
│ Confiança: 92%                             │
│                                            │
│ [EXECUTAR SUGESTÃO IA: lançar oc 54+email]│  ← BOTÃO NOVO AQUI
└────────────────────────────────────────────┘
```

Cor sugerida: azul/verde (ação positiva). Diferenciar visualmente do botão INTERPRETAR (que é amarelo/info).
