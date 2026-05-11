# Lovable — Botão "Buscar senha no SSW" no cadastro de cliente

## Contexto

No form de **cadastro de cliente** (aba CADASTROS, modal `+ Novo Cliente` ou edição), o campo **"Senha de tracking SSW"** hoje é preenchido manualmente. Larissa precisa logar no SSW, navegar até opção 383, achar o CNPJ, copiar a senha, colar no Cockpit.

**Caio 2026-05-11**: automatizamos isso. Botão na UI → backend entra no SSW interno como Larissa, navega na opção 383, busca pelo CNPJ digitado, **já salva** a senha em `tracking_credentials` E preenche o input no form.

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
2. **Chamar a edge function** (salva direto em `tracking_credentials`):

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
      // SEM apenas_buscar — endpoint salva direto no DB com upsert
    }),
  }
);
const data = await res.json();
```

3. **Trata a resposta**:

| Caso | Resposta | Ação |
|---|---|---|
| Sucesso | `{ ok: true, nome_amigavel, senha, senha_obrigatoria, persisted }` | Preenche campo senha + campo nome (se vazio) + toast verde "Senha cadastrada" |
| CNPJ não cadastrado no SSW | HTTP 404, `{ ok: false, cnpj_nao_encontrado: true }` | Toast laranja "CNPJ não cadastrado no SSW (opção 383). Cadastre manualmente." |
| SSW indisponível | HTTP 5xx | Toast vermelho "SSW indisponível agora. Tenta de novo ou preenche manualmente." |

4. **Confirmação antes de sobrescrever** (no campo do form, não no DB): se o input `senha` já tem valor digitado pelo usuário, antes de preencher mostrar `confirm("Senha já preenchida. Substituir pela do SSW?")`. (O backend faz upsert e sobrescreve independente — a confirmação é só pra UX local.)

### Toasts

- **Sucesso**: `✓ Senha cadastrada: 0366DENT (DENTAL SORRIA LTDA)` — verde, ~3s.
- **Não encontrado**: `⚠ CNPJ não cadastrado no SSW (opção 383). Preencha manualmente.` — laranja, ~5s.
- **Erro técnico**: `✕ SSW indisponível agora. Tenta de novo em 1min ou preenche manualmente.` — vermelho, ~5s.

### Preenchimento auto do nome

- Se `nome` (do form) estiver **vazio** e a busca retornar `nome_amigavel`, preencher o campo `nome` também.
- Se já tem nome digitado, **NÃO sobrescrever** (pode ser ajuste manual da Larissa).

### Por que salvar direto (em vez de só buscar)

Cockpit precisa da senha SSW pra rastrear evidência mesmo antes da Larissa terminar o cadastro completo. Se ela só clicou no botão e fechou a tela (sem cadastrar contatos), pelo menos o agente já consegue rastrear (tracking_credentials populada). Quando Larissa terminar o cadastro completo pela RPC `cadastrar_cliente_completo`, a linha existente é ATUALIZADA via `ON CONFLICT DO UPDATE` — sem erro de duplicata.

---

## Notas técnicas

- Endpoint `cadastrar-tracking-auto` faz upsert em `tracking_credentials` (PK = documento, 14 dígitos).
- `operador_responsavel_id` é resolvido automaticamente pelo backend: preserva existente se já houver linha; senão fallback pro operador único ativo (Larissa hoje).
- Latência típica da busca: 2-5s (login SSW + scraping). Por isso o loading state.
- Sessão SSW é compartilhada (Larissa l.silva). Se SSW retornar erro de sessão, o backend re-loga automaticamente.

## Resumo da UI

| Elemento | Mudança |
|---|---|
| Form de cadastro de cliente | Botão `🔍 Buscar no SSW` ao lado direito do input "Senha de tracking SSW" |
| Habilitado quando | CNPJ tem 14 dígitos válidos |
| Ao clicar | Loading → POST `cadastrar-tracking-auto {cnpj}` → preenche senha (+ nome se vazio) + salva direto no DB |
| Confirmação | Se senha já preenchida no form: confirm antes de sobrescrever (UX local) |
| Toast | Verde (cadastrada) / laranja (não cadastrado no SSW) / vermelho (SSW down) |

O submit final do form continua igual (RPC `cadastrar_cliente_completo`). Ele atualiza a linha já criada pelo botão sem conflito.
