# Templates de Email do Cockpit — Documento de Trabalho

**Versão:** 2026-06-11
**Pra quem:** time de Relacionamento Sal Express (Larissa, Duilio, Carlos, gerência)
**Propósito:** revisar e atualizar **conteúdo** dos templates atuais com quem opera no dia a dia. Toda mudança feita aqui deve ser refletida no Cockpit pra rodar 100% — instruções no final.

---

## 1. Como o Cockpit escolhe o template (visão de produto)

Quando uma NF cai numa ocorrência (oc) do SSW que o time precisa tratar, o Cockpit:

1. **Lê a foto da evidência + a instrução SSW** e extrai sinais (motivo, ressalva manuscrita, distância GPS, CT-e devolução, quantidade de volumes extraviados, etc.).
2. **Decide qual oc propor** pro operador validar (54 = notificar cliente, 56 = revisar com Operação, ou ações operacionais tipo 21/44/55).
3. **Sugere um template de email pareado com essa oc.**
4. **Renderiza o email** com as variáveis substituídas, abre o modal pra operadora **editar/aprovar**, e dispara via Gmail OAuth da operadora.

**Hierarquia de qual template aparece no modal** (mig 186, `preview_email_todo`):

```
1. Override manual da operadora no modal (troca de template no dropdown)
2. template_sugerido_ia (o que a IA decidiu — vence default)
3. Template salvo no payload da proposta
4. default_por_oc (fallback fixo)
```

**Tabela de default por oc:**

| OC | Template default |
|----|------------------|
| 10 | RECUSA_TOTAL |
| 11 | PROBLEMAS_COM_ENDERECO |
| 35 | RECUSA_PARCIAL |
| 49 | FALTA_DE_VOLUME |
| outras | COBRANCA_LEMBRETE |

Pra **oc=19 e casos especiais da oc=49**, não tem default — a IA sempre escolhe.

---

## 2. O "molde" da decisão da IA (pra criar templates compatíveis)

Toda vez que a IA olha um card, ela escreve um JSON em `cards.aviso_alteracao_oc` (campo `tipo: "ia_sugestao_ocs_padrao"`) com os sinais que viu. Esse JSON é o que decide template + oc:

```json
{
  "tipo": "ia_sugestao_ocs_padrao",
  "codigo_oc_card": 10,
  "proposta_destacada": 54,              // 54=notificar cliente / 56=revisar com Operação
  "template_email_sugerido": "RECUSA_TOTAL",
  "motivo_extraido": "Cliente não tinha dinheiro pra pagar boleto",
  "foto_classificacao": "destinatario_com_ressalva",
  "tem_ressalva": true,
  "ressalva_texto": "NÃO POSSO PAGAR AGORA - VOLTAR AMANHÃ",
  "ressalva_tipo": "motivo_recusa",      // motivo_recusa | falta_volumes | outro
  "gps_distancia_metros": null,          // só pra oc=11
  "gps_dentro_threshold": null,
  "tem_cte_devolucao": null,             // só pra oc=35
  "alerta_caixa_lacrada": null,          // só pra oc=35
  "qtd_volumes_extraviados": null,       // só pra oc=49
  "qtd_volumes_nf": null,
  "caso_oc49": null,                     // extravio_total | extravio_parcial | extravio_sem_qtd
  "confianca": 0.85,                     // 0.0–1.0
  "observacao_orquestrador": "Ressalva manuscrita clara, foto autenticada pelo destinatário"
}
```

**Pra cada oc, os sinais que a IA usa pra decidir o template:**

| OC | Significado | Sinais que a IA olha | Template padrão da IA |
|----|-------------|---------------------|----------------------|
| **10** | Recusa Total da Entrega | Foto classificada como `destinatario_com_ressalva` ou `destinatario_sem_ressalva` + ressalva manuscrita legível com motivo real (ignora título auto "RECUSA TOTAL DA ENTREGA") | **RECUSA_TOTAL** (se ressalva OK) ou oc=56 (se sem ressalva) |
| **11** | Insucesso na entrega (endereço/destinatário ausente) | GPS extraído da instrução SSW: ≤4000m do CEP = válido; >4000m ou sem GPS = revisar | **PROBLEMAS_COM_ENDERECO** (se GPS ≤4km) ou oc=56 |
| **19** | Entregue com falta de volumes | Ressalva manuscrita do tipo `falta_volumes` no canhoto + qtd volumes faltantes extraída da instrução | **ENTREGUE_COM_FALTA_PEDIR_ROMANEIO** |
| **35** | Recusa parcial após entrega | Ressalva manuscrita + checagem se existe CT-e de devolução criado. Alerta especial `alerta_caixa_lacrada` quando embalagem íntegra mas falta interna (diminui confiança) | **ENTREGA_PARCIAL_APOS_FALTA_VOLUME** ou **RECUSA_PARCIAL** |
| **49** | Tratativa de relacionamento (várias causas) | Análise do contexto: extravio total/parcial, qtd volumes, status do romaneio interno | **FALTA_DE_VOLUME** / **FALTA_DE_VOLUME_TOTAL** / **EXTRAVIO_PARCIAL** / **EXTRAVIO_TOTAL_PEDIR_ROMANEIO** |
| **outras (13, 21, 26, 41, 44, 54, 55, 56)** | Diversas | Sem IA decidindo template — operadora escolhe no dropdown | depende — geralmente sem email automático |

> **Importante:** quando a IA não tem confiança suficiente (ressalva ilegível, motivo genérico SSWMOBILE, foto aleatória), ela **NÃO sugere oc=54+template**. Sugere **oc=56** ("revisar com Operação") sem email.

---

## 3. Inventário completo dos templates atuais (17)

Cada bloco abaixo é um template **editável**. Pra revisar, edite assunto e corpo direto. Mantenha as variáveis entre `{chaves}` — elas são substituídas em runtime.

**Variáveis disponíveis em todos os templates:**

- `{primeiro_nome}` — primeiro nome do contato do cliente
- `{nf}` — número da nota fiscal
- `{operadora_nome}` — nome da operadora Sal Express que está enviando (LARISSA, DUILIO, CARLOS)
- `{link_evidencia}` — URL única da foto/galeria (gerada em runtime, válida por 7 dias)
- `{empresa}` — razão social do cliente pagador
- `{n_volumes_falta}` — quantidade de volumes faltantes (extraída pela IA)
- `{qtde_volumes}` — quantidade total de volumes da NF
- `{saudacao}` — saudação adaptada por horário ("Bom dia", "Boa tarde", "Boa noite")

---

### 3.1 Templates de **notificação** (oc=54 — pedindo retorno do cliente)

#### 🟦 RECUSA_TOTAL
- **Quando a IA sugere:** card oc=10 com ressalva manuscrita legível e foto do destinatário
- **OC pareada:** 54 (notificar cliente)
- **Assunto:** `Recusa Total — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou integralmente a carga.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Para darmos continuidade, poderia, por gentileza, nos orientar quanto à tratativa: seguir com a devolução ou seguir para reentrega?
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem.
>
> Ficamos no aguardo para prosseguirmos.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis usadas:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
[escreva aqui o que mudar]
```

---

#### 🟦 RECUSA_PARCIAL
- **Quando a IA sugere:** card oc=35 com ressalva indicando recusa parcial (não falta interna em caixa lacrada)
- **OC pareada:** 54
- **Assunto:** `Recusa Parcial — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Ao realizarmos a tentativa de entrega referente à NF {nf}, o cliente recusou parte da carga.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Para darmos continuidade, poderia, por gentileza, nos orientar se podemos seguir para a devolução?
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem.
>
> Ficamos no aguardo para prosseguirmos.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
```

---

#### 🟦 ENTREGA_PARCIAL_APOS_FALTA_VOLUME
- **Quando a IA sugere:** card oc=35 com indício de recusa após entrega parcial (cliente recebeu parte e devolveu parte)
- **OC pareada:** 54
- **Assunto:** `Recusa após entrega parcial — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Identificamos que a NF {nf} foi entregue parcialmente, com recusa de parte da carga no destino.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Caso deseje, podemos compartilhar informações detalhadas da recusa (motivo registrado pelo destinatário, ressalva e demais comprovantes) pra avaliar a melhor tratativa.
>
> Ficamos no aguardo de sua orientação: seguir com a devolução, nova tentativa de entrega ou aguardar novas instruções?
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
```

---

#### 🟦 PROBLEMAS_COM_ENDERECO
- **Quando a IA sugere:** card oc=11 com GPS extraído da instrução SSW e ≤4000m do CEP do destino (motorista foi no lugar certo, endereço/destinatário sumiu)
- **OC pareada:** 54
- **Assunto:** `Insucesso na entrega — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Ao realizarmos a tentativa de entrega referente à NF {nf}, não foi possível localizar o endereço informado. Poderia confirmar se o endereço está correto?
>
> Segue evidência registrada pelo motorista, que pode ser acessada através do link: {link_evidencia}
>
> Para darmos continuidade com a entrega, poderia, por gentileza, confirmar/corrigir os dados de endereço? Caso necessário, solicitamos também o envio de uma CCe.
>
> Ficamos no aguardo de sua orientação para prosseguirmos com a reentrega o quanto antes.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
```

---

#### 🟦 ENTREGUE_COM_FALTA_PEDIR_ROMANEIO
- **Quando a IA sugere:** card oc=19 (entregue) com ressalva no canhoto indicando volume faltante na entrega
- **OC pareada:** 54
- **Assunto:** `Entrega parcial concluída — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Realizamos a entrega da NF {nf} no destino final com falta de {n_volumes_falta} volume(s). A ressalva foi coletada junto ao destinatário no momento da entrega.
>
> A evidência registrada pode ser acessada no link: {link_evidencia}
>
> Para darmos sequência ao processo de ressarcimento dos volumes faltantes, gentileza encaminhar o romaneio de coleta assinado da NF e a descrição/valor dos itens faltantes.
>
> Assim que recebermos, abrimos o processo de ressarcimento internamente.
>
> Ficamos no aguardo.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{n_volumes_falta}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
```

---

### 3.2 Templates de **extravio** (oc=49 — relacionamento pós-prazo)

#### 🟧 FALTA_DE_VOLUME
- **Quando a IA sugere:** card oc=49 com indício de extravio parcial (alguns volumes localizados, outros sumiram)
- **OC pareada:** 54 (ou ramificação operacional)
- **Assunto:** `Extravio Parcial — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Gostaria de informar o extravio de {n_volumes_falta} volume(s) referente(s) à NF {nf}.
>
> Podemos seguir com a entrega parcial, coletando a ressalva junto ao destinatário, e posteriormente compartilhar com vocês para a emissão de um novo pedido referente aos volumes faltantes. Caso os volumes sejam localizados, seguiremos com a devolução isenta. Ou, se preferirem, seguir com a devolução dos volumes atualmente em nossa posse?
>
> Ficamos no aguardo de sua orientação para prosseguirmos.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{n_volumes_falta}`, `{operadora_nome}`

**✏️ Sugestões do time:**
```
```

---

#### 🟧 FALTA_DE_VOLUME_TOTAL
- **Quando a IA sugere:** card oc=49 com extravio total confirmado (todos os volumes sumiram, busca interna esgotada)
- **OC pareada:** 54
- **Assunto:** `Extravio Total — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Gostaríamos de informar o extravio total referente à NF {nf}. As buscas internas já foram concluídas e os volumes não foram localizados.
>
> Para evitar impactos junto ao cliente, orientamos o envio de um novo pedido de reposição. Caso os volumes sejam localizados posteriormente, seguiremos automaticamente com a devolução dos mesmos, de forma isenta.
>
> Poderiam, por favor, nos enviar o romaneio de coleta assinado da NF?
>
> Seguimos acompanhando o caso com prioridade e permanecemos à disposição.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`

**✏️ Sugestões do time:**
```
```

---

#### 🟧 EXTRAVIO_PARCIAL
- **Quando a IA sugere:** card oc=49 com `caso_oc49: "extravio_parcial"` + qtd extraída (sabemos quantos sumiram e quantos foram localizados)
- **OC pareada:** 54
- **Assunto:** `Extravio parcial — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Identificamos que durante o transporte da NF {nf} houve extravio de {n_volumes_falta} de {qtde_volumes} volumes. Localizamos o restante.
>
> Para prosseguirmos, poderia nos orientar:
> (a) seguir com a entrega parcial dos volumes localizados, OU
> (b) realizar a devolução total?
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem caso aguardemos retorno por longo período.
>
> Atenciosamente,
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{n_volumes_falta}`, `{qtde_volumes}`, `{operadora_nome}`

**✏️ Sugestões do time:**
```
```

---

#### 🟧 EXTRAVIO_TOTAL_PEDIR_ROMANEIO
- **Quando a IA sugere:** card oc=49 com `caso_oc49: "extravio_total"` (todos os volumes extraviados, processo de indenização)
- **OC pareada:** 54
- **Assunto:** `Extravio total — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Lamentamos informar que todos os volumes da NF {nf} foram extraviados durante o transporte e não foram localizados dentro do prazo padrão de busca.
>
> Para darmos continuidade ao processo de indenização, solicitamos o envio do romaneio assinado e demais documentos pertinentes.
>
> Ficamos à disposição para esclarecimentos.
>
> Atenciosamente,
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`

**✏️ Sugestões do time:**
```
```

---

#### 🟧 EXTRAVIO_TOTAL_NOTIFICACAO
- **Quando dispara:** processo PRATI (cliente específico com romaneio disponível em plataforma interna). Não é IA — é regra de operação especial. **Não pede romaneio** ao cliente porque já temos.
- **OC pareada:** 49 (com oc=33 sequente automática)
- **Assunto:** `Aviso Importante: Extravio Total NF {nf}`
- **Corpo atual:**

> Prezado(a) {primeiro_nome},
>
> Identificamos extravio total da NF {nf} ({empresa}). Conforme nosso processo acordado em contrato, daremos andamento ao processo de ressarcimento via análise de perdas, com base no romaneio de coleta disponibilizado em nossos registros internos.
>
> Qualquer informação adicional ou contato do time de Perdas será encaminhado em separado.
>
> Atenciosamente,
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{empresa}`, `{operadora_nome}`

**✏️ Sugestões do time:**
```
```

---

### 3.3 Templates de **cobrança** (lembrete + escalonamento)

> ⚠️ **Importante:** cobrança automática está **desativada** desde 2026-05-26 (memory `project_cobranca_cliente_automatica_desativada`). Templates seguem ativos mas só disparam se o operador acionar manualmente.

#### 🟨 COBRANCA_LEMBRETE_4DIAS
- **Quando dispara:** cliente não respondeu por 4 dias após a 1ª notificação (envio via cron/manual)
- **Assunto:** `Aguardando retorno — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}. Até o momento, já se passaram 4 dias desde a nossa notificação, e seguimos no aguardo de sua orientação para continuidade.
>
> Ressaltamos que poderão ser aplicadas cobranças de armazenagem.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Pedimos, por gentileza, seu retorno para que possamos prosseguir com a tratativa.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
```

---

#### 🟨 COBRANCA_LEMBRETE_8DIAS
- **Quando dispara:** 8 dias sem resposta — **cobrança de armazenagem passa a vigorar**
- **Assunto:** `Aviso de cobrança de armazenagem — NF {nf}`
- **Corpo atual:**

> Olá {primeiro_nome},
>
> Conforme comunicado anterior, registramos uma ocorrência na tentativa de entrega referente à NF {nf}. Após 4 dias, realizamos a notificação sobre a possibilidade de cobrança de armazenagem e, neste momento, já se passaram 8 dias sem retorno para definição.
>
> Dessa forma, informamos que a cobrança de armazenagem passa a ser aplicada a partir de agora e será faturada ao final do desfecho da ocorrência, seja no momento da devolução ou da entrega efetiva.
>
> A evidência registrada pelo motorista pode ser acessada no link: {link_evidencia}
>
> Reforçamos a necessidade de seu retorno para prosseguirmos com a tratativa.
>
> {operadora_nome}
> Sal Express — Relacionamento

- **Variáveis:** `{primeiro_nome}`, `{nf}`, `{operadora_nome}`, `{link_evidencia}`

**✏️ Sugestões do time:**
```
```

---

#### 🟨 COBRANCA_LEMBRETE
- **Quando dispara:** fallback genérico — qualquer oc que não tem default específico
- **Conteúdo:** idêntico ao COBRANCA_LEMBRETE_4DIAS (alias de compatibilidade)

> **Sugestão pra discussão:** podemos deletar esse alias depois que o time decidir os defaults novos?

---

### 3.4 Templates de **resposta** (autoriza ação do cliente — replies curtos)

Disparados em **resposta na mesma thread** quando o cliente autoriza a tratativa (botão "Responder cliente por email" no Cockpit ao aprovar oc=21/44/55).

#### 🟩 RESPOSTA_AUTORIZA_REENTREGA
- **Quando dispara:** operadora aprova oc=21 (autorização de reentrega) e marcou "Responder cliente"
- **Assunto:** `Re: NF {nf}`
- **Corpo atual:**

> Ok {saudacao}, iremos seguir com a reentrega o mais rápido possível.

- **Variáveis:** `{saudacao}`, `{nf}`

**✏️ Sugestões do time:**
```
```

---

#### 🟩 RESPOSTA_AUTORIZA_DEVOLUCAO
- **Quando dispara:** operadora aprova oc=44 (autorização de devolução)
- **Assunto:** `Re: NF {nf}`
- **Corpo atual:**

> Ok {saudacao}, iremos seguir com a devolução conforme prazo acordado.

- **Variáveis:** `{saudacao}`, `{nf}`

**✏️ Sugestões do time:**
```
```

---

#### 🟩 RESPOSTA_AUTORIZA_ENTREGA_PARCIAL
- **Quando dispara:** operadora aprova oc=55 (autorização de entrega parcial)
- **Assunto:** `Re: NF {nf}`
- **Corpo atual:**

> Ok {saudacao}, iremos seguir com a entrega parcial conforme combinado.

- **Variáveis:** `{saudacao}`, `{nf}`

**✏️ Sugestões do time:**
```
```

---

### 3.5 Templates **deprecated** (manter ativo só por compatibilidade)

#### 🔴 ENDERECO_INCORRETO
- **Status:** substituído por PROBLEMAS_COM_ENDERECO em 2026-05-01
- **Decisão pendente:** podemos desativar?

---

## 4. Como atualizar um template SEM mexer no código

Cada template vive na tabela `templates_email` do Postgres (Supabase). Pra atualizar:

**Opção A — via Lovable (admin):** se já houver tela de gestão, edita lá direto (peça pro Caio).

**Opção B — via migration SQL:** abrir PR com arquivo novo em `migration/AAAA-MM-DD_NNN_atualizar_templates.sql`:

```sql
UPDATE public.templates_email
SET corpo_template = $$
Olá {primeiro_nome},

[novo corpo aqui — pode usar quebras de linha normais]

{operadora_nome}
Sal Express — Relacionamento
$$,
    assunto = 'Novo assunto — NF {nf}',
    updated_at = now()
WHERE id = 'RECUSA_TOTAL';
```

> **Variáveis** ficam entre `{ }`. Se a variável não existir, vai virar literal no email — sempre testar antes.

---

## 5. Como criar um template NOVO que roda 100% com a IA atual

Pra um template novo `MEU_TEMPLATE_NOVO` pareado com oc=35 entrar no fluxo automático, basta:

1. **Inserir o template** no banco (migration):

```sql
INSERT INTO public.templates_email (id, nome, descricao, assunto, corpo_template, variaveis_esperadas, ativo)
VALUES (
  'MEU_TEMPLATE_NOVO',
  'Nome curto pro time',
  'Quando disparar (1 linha)',
  'Assunto — NF {nf}',
  $$Olá {primeiro_nome}, ...$$,
  ARRAY['primeiro_nome','nf','operadora_nome','link_evidencia'],
  true
);
```

2. **Decidir como a IA vai escolher esse template em vez do default.** Tem 2 caminhos:

   - **Caminho A — operadora escolhe no dropdown:** já funciona. Operadora abre modal, troca template, envia. **Nenhuma mudança de código.**
   - **Caminho B — IA sugere automaticamente:** precisa de mudança no código do agente IA pra retornar `template_email_sugerido: "MEU_TEMPLATE_NOVO"` quando os sinais bater com sua regra. **Precisa de PR + revisão.**

3. **Pra adicionar novo sinal que a IA ainda não detecta** (ex: "cliente pediu retorno por WhatsApp"): mexe no `interpretador-evidencia-foto` + agente. **PR + alinhamento técnico.**

---

## 6. Variáveis disponíveis (referência rápida)

| Variável | De onde vem | Sempre disponível? |
|----------|-------------|---|
| `{primeiro_nome}` | Primeira palavra do contato do cliente | Sim — fallback "" se não houver |
| `{nf}` | `cards.nf` | Sim |
| `{operadora_nome}` | `operadores.nome` da operadora que aprovou | Sim |
| `{link_evidencia}` | Token gerado pelo executor; URL `cockpit-r-evidencia.vercel.app/r?t=…` | Só quando tem foto SSW disponível |
| `{empresa}` | `cards.pagador` (razão social) | Sim |
| `{n_volumes_falta}` | IA extrai da instrução SSW ou ressalva | Só ocs 19 e 49 |
| `{qtde_volumes}` | `cards.qtde_volumes` | Quando tem CT-e válido |
| `{saudacao}` | "Bom dia" / "Boa tarde" / "Boa noite" — automático | Só em templates de RESPOSTA |

---

## 7. Próximos passos pro time

1. **Revisar cada template** preenchendo a seção `✏️ Sugestões do time` com o novo conteúdo proposto.
2. **Discutir os defaults por oc** (seção 1):
   - Quer trocar default da oc=35 entre RECUSA_PARCIAL e ENTREGA_PARCIAL_APOS_FALTA_VOLUME?
   - Quer criar default explícito pra oc=19?
3. **Alinhar com Caio** quais sinais novos a IA precisa começar a detectar (ex: distinguir recusa por motivo administrativo vs recusa por motivo qualidade).
4. **Caio aplica as mudanças** via migration + redeploy. Validação E2E em 1-2 cards antes do go-live.

---

**Última edição:** {data — preenchida pelo último editor}
**Editado por:** {nome}
