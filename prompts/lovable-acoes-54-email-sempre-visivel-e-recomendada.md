# Lovable — "54 + e-mail" NUNCA pode sumir da lista, e a recomendação do agente tem que aparecer (NF 705764)

## Contexto do bug (caso real)
NF 705764 (MED CENTER, operadora Larissa). Card de extravio → o agente lançou a oc 49 sozinho → o agente-sugere analisou e **recomendou "lançar oc 54 + e-mail de extravio (pedir romaneio)"**. Mas na tela "Ações propostas" do card:

1. **A opção "54 + e-mail" NÃO apareceu** — só apareceu a "54 SEM e-mail" (um todo antigo). As DUAS são ações **distintas e coexistem**; o front estava mostrando só uma das duas oc=54.
2. **Não apareceu nenhum banner de recomendação** (a "ação recomendada" destacada).

Resultado: a operadora clicou na única 54 que via ("SEM e-mail") → **o cliente nunca foi notificado do extravio**.

O backend já foi corrigido (o banner de recomendação agora sobrevive e o todo "54 + e-mail" carrega o template certo de extravio). Falta o front parar de colapsar/esconder e passar a renderizar a recomendação.

## O que precisa mudar no front

### 1. NUNCA deduplicar/colapsar a lista de ações por número de ocorrência
As ações vêm da tabela **`todos`** (status `pendente`/`aprovado`) do card. Cada todo tem em `proposta_payload`:
- `acao_key` (string) — **identidade única da ação**, formato `"<tool>:<codigo_ssw>"`.
- `tool` (string), `args.codigo_ssw` (number), `meta.modo` (`"completo"` | `"sem_email"`), `meta.sem_email_explicito` (bool).

**Regra fixa:** renderize **uma linha por `acao_key`**. NUNCA agrupe/esconda por `args.codigo_ssw`. Em particular, estas DUAS são ações OPOSTAS que SEMPRE coexistem e ambas têm que aparecer:
- `lancar_oc_e_enviar_email:54` → "Lançar oc 54 **+ e-mail** pro cliente" (notifica)
- `lancar_ocorrencia:54` (`meta.sem_email_explicito = true`) → "Lançar 54 **SEM e-mail**" (não notifica)

Se hoje existe qualquer `distinct`/`groupBy`/`uniqBy` por `codigo_ssw` (ou por número da oc) na montagem dessa lista, **troque a chave para `acao_key`**.

### 2. Renderizar a AÇÃO RECOMENDADA (banner destacado) por `acao_key`
A recomendação do agente vem de **`cards.aviso_alteracao_oc`** (JSONB) quando `aviso_alteracao_oc.tipo === "ia_sugestao_ocs_padrao"`. Campos relevantes:
- `proposta_destacada_acao` (string) — **o `acao_key` da ação recomendada** (ex: `"lancar_oc_e_enviar_email:54"`). Casa com o `proposta_payload.acao_key` de um todo pendente.
- `template_email_sugerido` (string) — template do e-mail (ex: `"EXTRAVIO_TOTAL_PEDIR_ROMANEIO"`).
- `caso_oc49` (string|null), `observacao_orquestrador`, `qtd_volumes_extraviados`, `qtd_volumes_nf`, `motivo_extraido`, `confianca`.

**Regra fixa:** se `aviso_alteracao_oc.tipo === "ia_sugestao_ocs_padrao"`, destaque (banner no topo da lista) o todo cujo `proposta_payload.acao_key === aviso_alteracao_oc.proposta_destacada_acao`. **Casar SEMPRE por `acao_key`, NUNCA pelo número** — "54" sozinho é ambíguo entre "+ e-mail" e "sem e-mail". Se nenhum todo casar o `acao_key`, mostre a lista normal sem banner (não invente destaque por número).

### 3. Defensivo: nunca preferir o "sem e-mail" como representante do 54
Se por algum motivo o front ainda precisar escolher 1 entre dois todos do mesmo número (NÃO deveria — ver item 1), **nunca** prefira o `meta.sem_email_explicito = true`. O default seguro é a versão que **notifica** o cliente (`lancar_oc_e_enviar_email`).

## Como validar
- Abrir um card de extravio pós-oc49 com recomendação: deve aparecer o banner "Recomendado: Lançar oc 54 + e-mail de extravio (pedir romaneio)" E, na lista, tanto "54 + e-mail" quanto "54 sem e-mail" como opções separadas.
- A contagem de "N PENDENTES" tem que bater com o número de todos pendentes (não pode "sumir" 1 por colapso de número).
- NF-âncora: 705764.
