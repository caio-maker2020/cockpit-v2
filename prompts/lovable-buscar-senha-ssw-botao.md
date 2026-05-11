# Lovable — Botão "Buscar senha no SSW" no cadastro de cliente

## Contexto

No form de **cadastro de cliente** (aba CADASTROS, modal `+ Novo Cliente` ou edição), o campo **"Senha de tracking SSW"** hoje é preenchido manualmente. Larissa precisa logar no SSW, navegar até opção 383, achar o CNPJ, copiar a senha, colar no Cockpit.

**Caio 2026-05-11**: automatizamos isso. O backend já tem endpoint que entra no SSW interno como Larissa, navega na opção 383, busca pelo CNPJ digitado e retorna `{nome_amigavel, senha}`. Falta só o **botão na UI** que dispara essa busca e preenche o campo.

---

## A mudança

**Adicionar um botão ao lado direito do input "Senha de tracking SSW"** no form de cadastro de cliente:

```
┌────────────────────────────────────────────────────────────┐
│  Senha de tracking SSW:                                    │
│  ┌─────────────────────────────┐  ┌──────────────────────┐│
│  │ 0366DENT                    │  │ 🔍 Buscar no SSW     ││
│  └─────────────────────────────┘  └──────────────────────┘│
│  É a senha que o SSW da transportadora configurou pro     │
│  CNPJ desse cliente.                                       │
└────────────────────────────────────────────────────────────┘
```

### Quando o botão fica habilitado

- Campo **CNPJ/CPF** preenchido com **14 dígitos válidos** (CNPJ).
- Botão fica **desabilitado** se:
  - Campo CNPJ vazio
  - Documento tem 11 dígitos (CPF — opção 383 só busca por CNPJ)
  - Documento tem ≠ 14 dígitos

### Comportamento ao clicar

1. **Estado loading**: trocar texto pra `⏳ Buscando...` e desabilitar o botão temporariamente.
2. **Chamar a edge function**:

```ts
const res = await fetch(
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cadastrar-tracking-auto`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cnpj: documento.replace(/\D/g, ""),
      apenas_buscar: true,  // CRÍTICO: só busca, não persiste
    }),
  }
);
const data = await res.json();
```

3. **Trata a resposta**:

| Caso | Resposta | Ação |
|---|---|---|
| Sucesso | `{ ok: true, nome_amigavel, senha, senha_obrigatoria }` | Preenche campo senha + campo nome (se vazio) + toast verde |
| CNPJ não cadastrado no SSW | HTTP 404, `{ ok: false, cnpj_nao_encontrado: true }` | Toast laranja "CNPJ não cadastrado no SSW (opção 383). Cadastre manualmente." |
| SSW indisponível | HTTP 5xx | Toast vermelho "SSW indisponível agora. Tenta de novo ou preenche manualmente." |

4. **Confirmação antes de sobrescrever**: se o campo `senha` já tem valor digitado pelo usuário, antes de preencher mostrar `confirm("Senha já preenchida. Substituir pela do SSW?")`.

### Toasts

- **Sucesso**: `✓ Senha encontrada: 0366DENT (DENTAL SORRIA LTDA)` — verde, ~3s.
- **Não encontrado**: `⚠ CNPJ não cadastrado no SSW (opção 383). Preencha manualmente.` — laranja, ~5s.
- **Erro técnico**: `✕ SSW indisponível agora. Tenta de novo em 1min ou preenche manualmente.` — vermelho, ~5s.

### Preenchimento auto do nome

- Se `nome` (do form) estiver **vazio** e a busca retornar `nome_amigavel`, preencher o campo `nome` também.
- Se já tem nome digitado, **NÃO sobrescrever** (pode ser ajuste manual da Larissa).

---

## Notas técnicas

- O endpoint `cadastrar-tracking-auto` JÁ está deployado e testado.
- Flag `apenas_buscar: true` é CRÍTICA — sem ela o endpoint faz upsert direto em `tracking_credentials`, o que conflita com o submit final do form (que usa `cadastrar_cliente_completo` pra salvar cliente + contatos + senha juntos numa transação).
- Latência típica da busca: 2-5s (login SSW + scraping). Por isso o loading state.
- Sessão SSW é compartilhada (Larissa l.silva). Se SSW retornar erro de sessão, o backend re-loga automaticamente.

## Resumo da UI

| Elemento | Mudança |
|---|---|
| Form de cadastro de cliente | Botão `🔍 Buscar no SSW` ao lado direito do input "Senha de tracking SSW" |
| Habilitado quando | CNPJ tem 14 dígitos válidos |
| Ao clicar | Loading → POST `cadastrar-tracking-auto {cnpj, apenas_buscar: true}` → preenche senha (+ nome se vazio) |
| Confirmação | Se senha já preenchida: confirm antes de sobrescrever |
| Toast | Verde (achou) / laranja (não cadastrado) / vermelho (SSW down) |

Nada mais muda no form — o submit final continua igual (RPC `cadastrar_cliente_completo`).
