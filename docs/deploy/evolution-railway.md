# Deploy Evolution API no Railway

Guia operacional pro Cockpit v2. Imagem oficial `atendai/evolution-api:v2.2.3`.
Tempo estimado: 15 min do zero ao QR code da primeira instância.

## Pré-requisitos

- Conta Railway com billing ativo
- CLI Railway (opcional): `brew install railway` + `railway login`
- Secret `AUTHENTICATION_API_KEY` gerado com `openssl rand -hex 32` — guarde, vamos colar 2x

## Passo a passo

### 1. Criar projeto Railway

1. https://railway.app/new
2. **Deploy from GitHub repo** → escolher este repo
3. Service: **Empty Service** (vamos apontar pro Dockerfile manualmente)
4. Settings → **Root Directory**: `deploy/evolution-api`
5. Settings → **Builder**: Dockerfile (auto-detectado via `railway.json`)

### 2. Adicionar plugin Postgres

1. **+ New** → Database → Add PostgreSQL
2. Aguardar provisionamento (~30s)
3. Railway expõe `${{Postgres.DATABASE_URL}}` automaticamente

### 3. Setar variáveis de ambiente

Variables → Raw Editor → colar `deploy/evolution-api/.env.example`, ajustando:

- `AUTHENTICATION_API_KEY`: rodar `openssl rand -hex 32` e colar o resultado
- `SERVER_URL`: deixar em branco no primeiro deploy. Após o deploy, copiar a URL pública (`https://<nome>.up.railway.app`) e atualizar essa var → redeploy.

### 4. Expor publicamente

Settings → Networking → **Generate Domain** → gera `https://<nome>.up.railway.app`.

### 5. Health check

```bash
curl https://<nome>.up.railway.app/
# Espera: { "status": 200, "message": "Welcome to the Evolution API, it is working!", ... }
```

Se retornar 200, Evolution está no ar.

### 6. Plugar Evolution no Cockpit (Supabase secrets)

```bash
# Apontar Cockpit pro servidor Evolution:
supabase secrets set EVOLUTION_BASE_URL=https://<nome>.up.railway.app

# Mesma key que está no AUTHENTICATION_API_KEY do Railway:
supabase secrets set EVOLUTION_GLOBAL_APIKEY=<a chave gerada no passo 3>
```

### 7. Criar instâncias dos operadores

Pelo Cockpit (após deploy das edges desta sessão):

```bash
# 1. Aba CADASTROS → Operadores → botão "Parear WhatsApp" em cada operador
# OU via curl:
curl -X POST "$SUPABASE_URL/functions/v1/criar-instancia-whatsapp" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"operador_id":"<uuid>"}'
```

Resposta traz `qrcode_base64` — front renderiza como `<img>`. Operador escaneia no
WhatsApp do celular dele (Configurações → Aparelhos conectados → Conectar aparelho).

Após scan, `whatsapp-instance-status` deve devolver `state="open"`.

## Quanto custa

Railway Hobby plan: ~US$ 5/mês fixo + uso de RAM/CPU. Evolution + Postgres + 2
instâncias WhatsApp idling consomem ~US$ 7-12/mês.

## Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| 401 em `/instance/create` | apikey errada | Conferir `EVOLUTION_GLOBAL_APIKEY` == `AUTHENTICATION_API_KEY` |
| QR code não aparece | Container reiniciou recentemente | Aguardar 30s + rechamar `criar-instancia-whatsapp` |
| Instância "close" após pareamento | Sessão Baileys expirou | Deletar instância via `DELETE /instance/delete/<name>` + recriar |
| 502 Bad Gateway | Container caiu | Logs Railway → quase sempre é DB connection — confirmar plugin Postgres ligado |

## Backup / Disaster Recovery

A sessão WhatsApp fica em `evolution_api.*` no Postgres do plugin Railway.
Se quiser snapshots, ligar `Railway → Postgres → Backups` (incluso no Hobby).
Restaurar = pareamento perdido, escanear QR de novo.

## ADR

Decisão registrada em [docs/decisions/0005-evolution-railway.md](../decisions/0005-evolution-railway.md) (criar se ainda não existe).
