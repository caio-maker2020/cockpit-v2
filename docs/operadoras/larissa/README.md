# Larissa — Relacionamento Farmacêutico

**Operadora**: Larissa
**Processos que cuida**: Tratativa de Problema de Entrega (oc=10/11/13/35)
**Email**: relacionamento.farmaceutico@salexpress.com.br
**Status onboarding**: em andamento — go-live previsto 2026-05-04

---

## 📂 Estrutura dos documentos dela

### Por OPERADORA (Larissa em si — vale pra qualquer processo dela)

| Arquivo | Status | O que ela faz |
|---|---|---|
| **Voz-Larissa-Questionario.docx** | aguardando | 17 perguntas sobre como ela escreve emails. ~15min. Calibra prompt do agente "redator". |
| **Contatos-Clientes-Larissa.xlsx** | aguardando | Aba **Clientes**: CNPJ + senha SSW. Aba **Contatos**: emails/WhatsApp por cliente. |

### Por PROCESSO (Tratativa de Problema de Entrega)

| Arquivo | Status | O que ela faz |
|---|---|---|
| **Processo-Tratativa-Entrega.docx** | ⭐ pré-preenchido — ela valida | Já preenchido com tudo que está codificado hoje no Cockpit (mapa mental + matriz oc=10/11/13/35 + critérios de fim). Larissa lê e marca correções/lacunas. |
| **Templates-Email-Tratativa-Entrega.docx** | aguardando | Texto dos 5 emails (FALTA_DE_VOLUME, PROBLEMAS_COM_ENDERECO, RECUSA_TOTAL, RECUSA_PARCIAL, COBRANCA_LEMBRETE). ⭐ Os 3 do meio precisam de `{link_evidencia}` no corpo. |
| **Contexto-IA-Tratativa-Entrega.docx** | aguardando | Pra cada template, "como saber se a resposta resolveu de fato vs ok-obrigado-vou-ver?" |

---

## 📋 Status em tabela

### 🔴 Bloqueantes (Cockpit não opera sem isso)

| # | Arquivo | Status |
|---|---|---|
| 1 | Templates-Email-Tratativa-Entrega.docx | aguardando |
| 2 | Contatos-Clientes-Larissa.xlsx | aguardando |

### 🟡 Calibração (não bloqueia, melhora qualidade)

| # | Arquivo | Status |
|---|---|---|
| 3 | Voz-Larissa-Questionario.docx | aguardando |
| 4 | Contexto-IA-Tratativa-Entrega.docx | aguardando |

### 🟢 Validação do que já existe (importante mas não trava)

| # | Arquivo | Status |
|---|---|---|
| 5 | Processo-Tratativa-Entrega.docx | aguardando — pré-preenchido, ela revisa e marca correções |

---

## Ordem sugerida pra ela preencher

1. **Templates-Email-Tratativa-Entrega.docx** (15min) — bloqueante
2. **Contatos-Clientes-Larissa.xlsx** (30-60min) — bloqueante
3. **Voz-Larissa-Questionario.docx** (15min)
4. **Contexto-IA-Tratativa-Entrega.docx** (20min)
5. **Processo-Tratativa-Entrega.docx** (~1h validando) — depois do go-live

**Total mínimo pra go-live: #1 + #2 (~1h-1h30 dela)**

---

## ✅ O que JÁ está pronto da minha parte

- Templates `PROBLEMAS_COM_ENDERECO`, `RECUSA_TOTAL`, `RECUSA_PARCIAL`, `FALTA_DE_VOLUME`, `COBRANCA_LEMBRETE` criados no banco (ainda inativos — ativam quando ela entregar texto).
- Tabela `tracking_credentials` com 1 cliente cadastrado (Distribuidora ODON) pra teste. Demais clientes entram via planilha dela.
- Link de evidência funcionando: Vercel function `cockpit-r-evidencia.vercel.app/r?t=<token>` — gera token de 7d, faz auto-submit POST pra SSW autenticado, cliente vê foto/NFD/ressalva.
- Regras `REGRAS_AUTO_ACAO` deployadas pra oc=10/11/35 (lançar 21 + lançar 54+email com link evidência).

## Pendências do Caio

- [ ] Configurar DKIM/Return-Path do `salexpress.com.br` no Postmark (anti-spam)
- [ ] Passar senha temporária da Larissa via canal seguro
- [ ] Decidir caminho A/B/C dos 34 cards oc=54 herdados (segunda 2026-05-04)
- [ ] Definir oc=13 — quais CNPJs específicos exigem tratativa (Larissa lista no Processo-Tratativa-Entrega.docx)
