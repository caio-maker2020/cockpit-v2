---
title: "Templates de email — Sal Express / Cockpit"
subtitle: "Documento pra Larissa preencher 5 modelos fixos (atualizado 2026-05-01)"
---

# Templates de email — Cockpit

Esses templates são as primeiras versões que o Cockpit vai usar pra
disparar emails automáticos pro cliente. **Larissa preenche cada bloco
abaixo** com o texto que ela escreveria de verdade.

Variáveis entre `{chaves}` o sistema substitui automaticamente. Ex:
`{nf}` vira "12345", `{nome_cliente}` vira "Carolina Souza", etc.

## Variáveis disponíveis

| Variável | O que substitui | Exemplo |
|---|---|---|
| `{nome_cliente}` | Nome cadastrado do cliente | Carolina Souza |
| `{primeiro_nome}` | Só o primeiro nome | Carolina |
| `{nf}` | Número da NF | 757022 |
| `{empresa}` | Razão social do cliente | ACME LTDA |
| `{n_volumes_falta}` | Quantos volumes faltam (se aplicável) | 2 |
| `{descricao_problema}` | Resumo da última ocorrência no SSW | "Endereço de entrega divergente" |
| `{previsao_atual}` | Previsão de entrega | 05/05/2026 |
| `{operadora_nome}` | Nome de quem assina (sempre Larissa hoje) | Larissa |
| `{cidade_destino}` | Cidade da entrega | Uberaba |
| **`{link_evidencia}`** ⭐ | **Link único pro cliente ver a foto/evidência da entrega no SSW (auto-login)** | `https://cockpit-r-evidencia.vercel.app/r?t=<token>` |

## ⭐ IMPORTANTE — `{link_evidencia}`

Em **3 dos 5 templates** abaixo (PROBLEMAS_COM_ENDERECO, RECUSA_TOTAL,
RECUSA_PARCIAL), o sistema gera um **link único de 7 dias** que o
cliente clica e cai diretamente no portal SSW já autenticado, vendo a
foto/evidência registrada pelo motorista (ex: foto do endereço errado,
NF com ressalva, NFD).

**Você precisa colocar `{link_evidencia}` no corpo do email**, de
preferência destacado tipo: "*Veja a evidência registrada pelo
motorista: {link_evidencia}*". O sistema substitui pelo link real no
momento do envio.

| Template | Precisa de `{link_evidencia}`? | O que o cliente vê ao clicar |
|---|---|---|
| FALTA_DE_VOLUME | ❌ não | — |
| PROBLEMAS_COM_ENDERECO | ✅ **obrigatório** | Foto do SSWMobile da tentativa de entrega |
| RECUSA_TOTAL | ✅ **obrigatório** | NFD — Nota Fiscal de Devolução |
| RECUSA_PARCIAL | ✅ **obrigatório** | NF com ressalva (ou NFD parcial) |
| COBRANCA_LEMBRETE | ❌ não | — |

Tempo pra preencher: ~15 minutos.

---

## Template 1 — FALTA_DE_VOLUME

**Quando usar**: chegou no destino mas falta(m) volume(s). Cliente
precisa decidir: aguardar localização do volume faltante OU autorizar
entrega parcial OU pedir devolução total.

**Variáveis sugeridas**: `{primeiro_nome}`, `{nf}`, `{n_volumes_falta}`, `{operadora_nome}`

**Assunto** (preencha o que você usaria):

> resposta:




**Corpo do email**:

> resposta:




**O que esperamos como retorno do cliente?** (1 frase clara — vai
ajudar o sistema a entender a resposta)

> resposta:




---

## Template 2 — PROBLEMAS_COM_ENDERECO  ⭐ (precisa de `{link_evidencia}`)

**Quando usar**: oc=11 no SSW. Entrega impossibilitada por endereço
divergente, incompleto, ou cliente não localizado. Precisa confirmar
endereço correto OU autorizar reentrega.

**Variáveis sugeridas**: `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, **`{link_evidencia}`**

**Lembrete**: `{link_evidencia}` é OBRIGATÓRIO no corpo. Cliente clica
e vê a foto que o motorista tirou no SSWMobile do endereço errado.

**Assunto**:

> resposta:




**Corpo do email** (não esquece o `{link_evidencia}` em algum lugar):

> resposta:




**O que esperamos como retorno do cliente?**

> resposta:




---

## Template 3 — RECUSA_TOTAL  ⭐ (precisa de `{link_evidencia}`)

**Quando usar**: oc=10 no SSW. Cliente recusou TODA a entrega. Precisa
decidir: devolver via NFD, nova tentativa em outro endereço, ou
aguardar instrução.

**Variáveis sugeridas**: `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, **`{link_evidencia}`**

**Lembrete**: `{link_evidencia}` é OBRIGATÓRIO. Cliente vê a NFD (Nota
Fiscal de Devolução) registrada.

**Assunto**:

> resposta:




**Corpo do email** (não esquece o `{link_evidencia}` em algum lugar):

> resposta:




**O que esperamos como retorno do cliente?**

> resposta:




---

## Template 4 — RECUSA_PARCIAL  ⭐ (precisa de `{link_evidencia}`)

**Quando usar**: oc=35 no SSW. Entrega foi feita PARCIALMENTE — parte
da carga foi recusada no destino. Cliente precisa dizer o que fazer
com a parte recusada (devolver / nova tentativa em outro endereço /
aguardar).

**Variáveis sugeridas**: `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, **`{link_evidencia}`**

**Lembrete**: `{link_evidencia}` é OBRIGATÓRIO. Cliente vê a NF com
ressalva (anotação do motorista do que foi recusado).

**Assunto**:

> resposta:




**Corpo do email** (não esquece o `{link_evidencia}` em algum lugar):

> resposta:




**O que esperamos como retorno do cliente?**

> resposta:




---

## Template 5 — COBRANCA_LEMBRETE

**Quando usar**: já mandamos um email anterior, cliente não respondeu
em 4 dias. Cobramos novamente o retorno dele.

Esse template tem 2 versões — Larissa pode preencher 2 estilos:

**Variáveis sugeridas**: `{primeiro_nome}`, `{nf}`, `{operadora_nome}`

### Versão A — primeira cobrança (passou 4 dias)

**Assunto**:

> resposta:




**Corpo do email**:

> resposta:




### Versão B — segunda cobrança (passou 8 dias)

**Assunto**:

> resposta:




**Corpo do email**:

> resposta:




---

## Assinatura padrão

Como você quer que termine TODO email automático? (uma versão só, vale
pros 5 templates):

> resposta:




---

## Observações finais — Larissa

Algum cenário comum que você atende com frequência e que NÃO se encaixa
nos 5 templates acima? Lista aqui:

> resposta:




Algum cliente específico que precisa de tom totalmente diferente
(formal demais, conhece muito bem, etc)?

> resposta:




---

## Para o Cockpit (referência interna — Larissa pode ignorar)

Quando terminar, manda o documento de volta pro Caio. Eu uso isso pra
popular a tabela `templates_email` no banco e o Cockpit começa a
disparar com a sua voz nos 5 cenários.

**IDs internos no banco** (só pra registro):

- Template 1 → `FALTA_DE_VOLUME`
- Template 2 → `PROBLEMAS_COM_ENDERECO`
- Template 3 → `RECUSA_TOTAL`
- Template 4 → `RECUSA_PARCIAL`
- Template 5 → `COBRANCA_LEMBRETE`
