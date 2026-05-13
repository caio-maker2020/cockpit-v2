# Lovable — Modal de aprovação "Email + Lançar oc 33 (Extravio Total)"

## Contexto

Nova proposta exclusiva pra clientes em `cliente_config.usa_romaneio_interno=true` (PRATI hoje, outros depois). Aparece quando o card tem **oc 49, 10 ou 35** E o `cnpj_pagador` está configurado pra romaneio interno.

Diferenças dessa proposta vs as outras opções:
- **NÃO pede romaneio pro cliente** — o agente busca em plataforma interna Sal Express (operação escaneia diariamente).
- **NÃO lança oc=54** — só envia um email formalizando o extravio e lança oc=33 (Reversão de Perdas).
- Cliente NÃO precisa responder nada — o processo é interno.

Identificação:

```ts
const ehEmailLancar33Romaneio =
  todo.proposta_payload?.tool === 'enviar_email_e_lancar_33_romaneio_interno';
const tipoAcao = todo.proposta_payload?.meta?.tipo_acao; // === 'extravio_total_romaneio_interno'
```

Backend já está pronto. O executor:
1. Envia o email (template configurável em `cliente_config.template_email_extravio_total`).
2. Loga no portal interno + busca romaneio pela NF.
3. Se achar: baixa JPEGs e anexa na oc=33.
4. Se não achar: gera JPEG sintético "Romaneio não localizado" e anexa.
5. Lança oc=33 via portal SSW interno (opção 101). Card → ACAO_EXECUTADA, cod_ultima=33.

---

## Modal de aprovação

Quando Larissa clica em **"Email + Lançar 33 (Extravio Total)"** entre as propostas, abrir modal:

```
┌──────────────────────────────────────────────────────────────────┐
│ Email + Lançar oc 33 — Extravio Total (PRATI)                    │
│                                                                  │
│ ✦ Romaneio será buscado automaticamente na plataforma interna    │
│   após o envio do email. Você não precisa anexar nada aqui.      │
│                                                                  │
│ ─── BLOCO EMAIL ───                                              │
│                                                                  │
│ Para: [dropdown contatos cliente + opção "outro email"]          │
│                                                                  │
│ Cc:   [+] Adicionar Cc                                           │
│                                                                  │
│ Assunto: Aviso Importante: Extravio Total NF {nf}                │
│ (editável)                                                       │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Prezado(a) {primeiro_nome},                                │  │
│ │                                                            │  │
│ │ Identificamos extravio total da NF {nf} ({empresa}).       │  │
│ │ Conforme nosso processo acordado em contrato...           │  │
│ │                                                            │  │
│ │ [...template completo, editável...]                       │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ─── TEXTO oc=33 (opcional) ───                                   │
│ [Extravio total - ressarcimento iniciado via romaneio interno]   │
│ (até 70 chars — SSW f6. Pode deixar default.)                    │
│                                                                  │
│                          CANCELAR  [CONFIRMAR →]                 │
└──────────────────────────────────────────────────────────────────┘
```

### Campos

**Email** (mesmo padrão dos outros modais com email):
- Destinatários: dropdown carregado de `contatos_cliente` filtrado por `documento_cliente = cnpj_pagador` E `tipo='email'`. Permitir múltiplos (TO + CC).
- Assunto: pré-preenchido com `template.assunto` renderizado. Editável.
- Corpo: pré-preenchido com `template.corpo_template` renderizado com placeholders já resolvidos. Editável.
- **NÃO tem bloco de anexos** — agente busca romaneio automaticamente.

**Texto oc=33** (opcional, ≤70 chars):
- Default: `"Extravio total - ressarcimento iniciado via romaneio interno"`
- Editável. Se Larissa deixar vazio, usa o default.

### Validação

- Pelo menos 1 destinatário no `Para`.
- Assunto e corpo não vazios.

### Submit

```ts
const { data, error } = await supabase.rpc('aprovar_e_executar', {
  p_todo_id: todoId,
  p_extras: {
    texto_email_customizado: corpoEditado.trim(),
    email_destinatarios: [destinoTo, ...destinosCc],
    assunto_override: assuntoEditado.trim(),
    texto_oc33: textoOc33.trim() || undefined,
  },
});
```

### Toasts pós-submit

- **Tudo OK** (email + romaneio + oc=33): `✓ Email enviado, oc=33 lançada com romaneio. Card foi pra "AÇÃO EXECUTADA".`
- **Email falhou, oc=33 OK**: `⚠ Email falhou (${motivo}), MAS oc=33 foi lançada com sucesso. Verifique aviso no card.`
- **oc=33 falhou**: `✕ Email enviado mas oc=33 falhou no SSW: ${motivo}. Retentar manualmente.` (card vai pra AVH+lock=true com `acao_falhou_motivo`).

---

## Diferenciação visual na lista de propostas

Essa é uma proposta **exclusiva PRATI** (e outros clientes futuros). Recomendo destaque visual sutil:

```tsx
const tipoAcao = todo.proposta_payload?.meta?.tipo_acao;
const nomeCliente = todo.proposta_payload?.meta?.nome_cliente;

if (tipoAcao === 'extravio_total_romaneio_interno') {
  // Ícone diferente (ex: 🗂️ ou ✦) + badge "{nome_cliente}"
  // Label: "Email + Lançar 33 — Extravio Total"
}
```

---

## Onde aparece na UI

Aparece como **proposta extra** ao lado das opções padrão da regra de oc=49/10/35. NÃO substitui as outras — fica como mais uma opção que a Larissa pode escolher.

Lista típica pra PRATI com oc=49:
1. Lançar oc 21 — Reentrega
2. Lançar oc 54 + email — Aguardar cliente
3. Lançar oc 55 — Autorizar entrega
4. Lançar oc 44 — Devolução
5. Lançar oc 56 — Falta info
6. Lançar oc 41 — Informação complementar
7. **🗂️ Email + Lançar 33 — Extravio Total (PRATI, romaneio interno)** ← NOVA

---

## Resumo

| Elemento | Valor |
|---|---|
| Tool | `enviar_email_e_lancar_33_romaneio_interno` |
| Tipo_acao | `extravio_total_romaneio_interno` |
| Modal | 1 bloco email (template + destinatários) + 1 campo texto oc=33 |
| Extras submit | `{ texto_email_customizado, email_destinatarios, assunto_override, texto_oc33 }` |
| Backend | Email → busca romaneio interno → lança oc=33 via portal SSW |
| Estado final | ACAO_EXECUTADA, cod_ultima=33 |
| NÃO encadeia | oc=54 (cliente não precisa enviar romaneio) |
