# Teste prático — cobrança WhatsApp via PRIORIDADES AI

Estado pronto pra teste em produção em 2026-05-20.

## ✅ Backend pronto

| Item | Status |
|---|---|
| Evolution rodando no Railway | ✅ HTTP 200, multi-instance |
| Duilio pareado (`op-duilio`, state=`open`) | ✅ |
| Edge `disparar-cobranca-escalonada` lê `whatsapp_instance` do DB | ✅ |
| Edge `disparar-cobranca-escalonada` aceita `contato_id` opcional | ✅ |
| Edge `listar-contatos-cobranca` (popular dropdown front) | ✅ |
| 3 contatos Pouso Alegre cadastrados (Mirella, Heleandro, Bruno) | ✅ |
| `audit_log` + `cobrancas_disparadas` registram disparo | ✅ |

## ⚠️ Front Lovable — ajuste necessário

A regra "1 cargo = 1 contato por base" mudou: agora pode haver **N contatos do mesmo cargo na mesma base** (ex.: Mirella e Bruno como Coordenadores de Entrega em Pouso Alegre). O front precisa mudar dois pontos:

### Mudança 1 — Dropdown de contato no modal de cobrança

Quando operador clica "Cobrar WhatsApp" num card PRIORIDADES AI, ANTES o front mostrava só o cargo (gerente_base / coordenador_entrega / gerente_relacionamento). AGORA precisa:

1. Chamar `supabase.functions.invoke('listar-contatos-cobranca', { body: { card_id } })`
2. Receber array `contatos[]` (cada item já vem com campo `label` pronto, ex.: `"Mirella (Coordenador de Entrega)"`)
3. Renderizar dropdown agrupado por `cargo_humanizado` (ou lista simples)
4. Quando operador seleciona um, ao confirmar passar `contato_id` no body do `disparar-cobranca-escalonada` (junto com `papel` e `canal`).

### Mudança 2 — Body do disparar-cobranca-escalonada

Atual:
```ts
supabase.functions.invoke('disparar-cobranca-escalonada', {
  body: { card_id, papel: 'coordenador_entrega', canal: 'whatsapp', texto_final, assunto_final }
})
```

Novo (recomendado quando há múltiplos contatos do mesmo cargo):
```ts
supabase.functions.invoke('disparar-cobranca-escalonada', {
  body: {
    card_id,
    papel: 'coordenador_entrega',
    canal: 'whatsapp',
    contato_id: '62167e20-4e18-4a21-96a0-db18a70e4346',  // ← novo, opcional
    texto_final,
    assunto_final
  }
})
```

Se `contato_id` for omitido (cron de cobrança autônoma, por ex.), edge faz lookup automático antigo — retrocompat preservada.

## 📋 Prompt Lovable (colar no editor)

```
Na aba PRIORIDADES AI, ajustar modal de cobrança WhatsApp/Email pra suportar múltiplos contatos do mesmo cargo na base:

1. Antes de abrir o modal de cobrança, chamar:
   supabase.functions.invoke('listar-contatos-cobranca', { body: { card_id: card.id } })
   Resposta: { ok, base, contatos: [{ id, nome, telefone, email, cargo, cargo_humanizado, label, base, observacao }] }

2. No modal de cobrança, substituir botões fixos "Cobrar Gerente da Base / Coordenador / Gerente de Relacionamento" por:
   - Lista agrupada por cargo_humanizado mostrando todos contatos da base
   - Se há múltiplos contatos do mesmo cargo, mostrar cada um com seu próprio botão/radio (usar o campo `label` que já vem pronto)
   - Quando contato é selecionado, capturar tanto o cargo (= `papel`) quanto o `id` (= `contato_id`)

3. Ao confirmar disparo, chamar disparar-cobranca-escalonada com body:
   {
     card_id,
     papel: <cargo selecionado>,
     canal: 'whatsapp' (ou 'email'),
     contato_id: <id do contato selecionado>,
     texto_final: <texto opcional ajustado pelo operador>,
     assunto_final: <só pra email>
   }

4. Tratar erro 400 com error="contato_inativo" mostrando toast "Contato foi desativado, recarregue a lista".
5. Tratar erro 400 com error="contato_sem_destino_para_canal" mostrando "Contato sem WhatsApp/email cadastrado, escolha outro ou edite o cadastro".
6. Tratar erro 400/500 com mensagens contendo "WhatsApp" — significa que o operador não tem instance pareada. Mostrar CTA "Conectar WhatsApp" que leva pra aba Cadastros.

Manter retrocompat: aba de Cobrança Automática (cron futuro) NÃO passará `contato_id` e o backend continua resolvendo o primeiro contato da base/cargo automaticamente.
```

## 🧪 Passo a passo do teste no Cockpit

Você precisa fazer 2 coisas antes do teste:

### 1. Aplicar prompt Lovable acima → fazer deploy do Lovable

### 2. Login no Cockpit como Duilio

O operador precisa ser **Duilio** porque é o único com WhatsApp pareado (`whatsapp_instance="op-duilio"`).

Login:
- Acessar Cockpit → entrar como `ferramentas.construcao@salexpress.com.br` (email do Duilio na tabela operadores)
- Confirmar que aparece "DUILIO" no canto superior

### 3. Rodar o teste

1. Aba **PRIORIDADES AI**
2. Localizar uma NF do Duilio com base Pouso Alegre (você sabe qual)
3. Clicar em **Cobrar WhatsApp**
4. No modal:
   - Verificar que dropdown traz **3 contatos** (Heleandro / Mirella / Bruno)
   - Selecionar quem você quer cobrar
   - Revisar texto (gerado pela IA)
   - Confirmar
5. Verificar:
   - Toast "Mensagem enviada"
   - O contato escolhido recebe a mensagem
   - `cobrancas_disparadas` ganha 1 linha nova
   - `audit_log` ganha 1 linha com `action_type='whatsapp_outbound'` e `external_system='evolution'`
   - Kanban status do card avança (parada → cobrado se gerente_base; ou → escalado se coordenador/gerente_relacionamento)

### 4. Se der erro de WhatsApp

Possíveis erros + fix:

| Erro | Significa | Como resolver |
|---|---|---|
| `operador sem WhatsApp pareado` | Duilio não tem instance | Reparear: `curl POST .../criar-instancia-whatsapp` + pairing code |
| `WhatsApp do Duilio não está pareado (state=close)` | Instance saiu do ar | Mesmo de cima |
| `Evolution sendText falhou (401)` | Apikey global errada | Conferir `EVOLUTION_GLOBAL_APIKEY` no Supabase secrets |
| `contato_sem_destino_para_canal` | Contato cadastrado sem telefone | Editar cadastro |

## 📞 Pareamento de outros operadores (depois do teste OK)

Comando padrão pra eu rodar quando você estiver com cada operador (Larissa, Camila, Ingrid, Maria, Tulio, Victor):

```bash
# 1. Pegar UUID do operador
psql ... -c "SELECT id, nome FROM operadores WHERE nome='LARISSA';"

# 2. Pedir o WhatsApp da operadora (formato 5535999998888)

# 3. Eu rodo (você precisa estar com o celular dela em mãos):
curl -X POST .../instance/create -d '{"instanceName":"op-larissa","number":"5535XXXXXXX","integration":"WHATSAPP-BAILEYS","qrcode":true}'
# → retorna pairing code, ela digita no WhatsApp

# 4. UPDATE operadores SET whatsapp_instance='op-larissa', whatsapp_numero='...' WHERE id=...
```

Tempo médio por operador: 60 segundos.

## 📊 Checks pós-teste (se quiser inspecionar o resultado)

```sql
-- Última cobrança disparada
SELECT card_id, papel, canal, contato_nome, status, evolution_message_id, disparado_em
FROM cobrancas_disparadas
ORDER BY disparado_em DESC
LIMIT 1;

-- Audit_log do envio
SELECT id, card_id, status, external_id, idempotency_key, created_at
FROM audit_log
WHERE action_type='whatsapp_outbound' AND external_system='evolution'
ORDER BY created_at DESC
LIMIT 3;

-- Estado do card no kanban
SELECT card_id, status_kanban_atual, prioridades_kanban_status
FROM v_prioridades_ai
WHERE card_id = '<uuid>';
```
