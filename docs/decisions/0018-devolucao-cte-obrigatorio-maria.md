# ADR 0018 — Devolução com CT-e obrigatório (MARIA EDUARDA): ciclo próprio, fail-closed, escopo cercado no banco

Data: 2026-09-01
Status: Aceito
Âncora: vídeo `entendo o fluxo.mp4` — AGV LOG SA VINHEDO · NF **239883** · CTRC **SSP912725-9** · oc 54 · CT-e `60022.pdf` · e-mail "Devolução - NF 239883" ao Leonel com o PDF anexado à mão

## Contexto

A operadora **MARIA EDUARDA** (operador `MARIA`, [mig 323](../../migration/2026-08-10_323_onboarding_maria.sql), segmentos `{040 OPERADOR LOGÍSTICO, 042 TRANSPORTADOR}`) atende clientes que são transportadoras e operadores logísticos. Para eles a devolução física **só é aceita com o CT-e de Devolução** emitido pelo remetente, e parte dos casos exige também a **NFD** (Nota Fiscal de Devolução).

Hoje é 100% manual: recebe o CT-e por e-mail → lança oc 44 no SSW com volumes/motivo/filial → reencaminha o PDF ao setor de Devolução, porque o anexo do SSW não tem qualidade de impressão.

**A investigação mediu, não inferiu.** Base: 3 e-mails reais exportados do Gmail, 5 CT-e de exemplo, 3 NFD de exemplo, 26 frames do vídeo, e uma varredura somente-leitura de **7.258 e-mails inbound / 1.128 conversas / 9 caixas** do banco de produção. O plano completo, com os 19 modos de falha e as 11 seções de medição, está em `~/.claude/plans/piped-wandering-wolf.md`.

## Decisão

### 1. A evidência de que um PDF é CT-e de devolução vem do E-MAIL, não do documento

Medido: 3 dos 5 CT-e de exemplo não têm marcador textual algum, e a regra "origem/destino invertidos" **falha no caso AGV** (Serra→Vinhedo, mesma direção da ida, e ainda assim autodeclarado "CTe de Devolucao"). Some-se que **não existe extração de texto de PDF em nenhum lugar do repo**.

### 2. Detector em DOIS NÍVEIS — o agente nunca age com prova indireta

- **Nível A** — a frase de entrega está na **própria** mensagem do anexo ("Em anexo Cte de devolução", "Segue CTE de devolução") ⇒ **monta a proposta de oc 44** com o anexo.
- **Nível B** — a prova está só em mensagem **anterior** da conversa ("devolução autorizada", "prosseguir com a devolução") ⇒ **apenas sinaliza no card. Nunca monta ação.**

Motivo do nível B: no caso AGV real a mensagem que carrega o CT-e diz só *"Bom dia! @Gabriel Segue,"* — a prova está **8 mensagens e 9 dias antes**. Detector por mensagem perderia o caso; detector por conversa que agisse sozinho geraria falso positivo.

**Resultado medido no histórico:** o nível A disparou **21 vezes e todas as 21 na caixa da MARIA — zero nas outras 8 caixas**, incluindo Larissa, Karoline e Ingrid. O fraseado de entrega é estruturalmente específico deste fluxo. O nível B é frouxo (173 no total, 33 na MARIA) — e é exatamente por isso que ele só sinaliza.

### 3. O modelo da chave fiscal distingue CT-e de NFD, sem abrir o PDF

Na chave de 44 dígitos, as posições **21-22** são o modelo: **57 = CT-e**, **55 = NF-e (a NFD)**. Verificado: as 3 NFD de exemplo são modelo 55 com dígito verificador válido, **96 de 96** chaves do histórico passam no módulo 11, e a distribuição por caixa é MARIA 25×57 e 1×55 contra 0×57 e 70×55 nas outras oito.

Isso resolve um problema que o **nome do arquivo não resolve** — e há contraexemplo provado: `LAMINA_PROTOCOLO_LEITEIRO_COMERCIAL_A4_0426_OF03_ID3298.pdf` tem cara de folheto de marketing e o conteúdo é uma DANFE de devolução. `escolherAnexoCte` passa a decidir pela chave, e um PDF provado NF-e **nunca** vira "o CT-e", nem quando é o único anexo.

### 4. Fail-closed: conversão PDF→JPEG falhando NÃO lança a oc 44

Era o **único item do desenho que transformava perda de documento fiscal em sucesso silencioso**. A cadeia não tinha freio: `carregarAnexosParaEnvio` pula anexo ausente em silêncio → o e-mail sai dizendo "CT-e em anexo" **sem anexo** → a 44 é lançada → `stateFinalAposBastao(44)='TRANSFERIDO'` → o card sai do Cockpit → `finalizarAnexosPosEnvio` apaga o PDF → o Bastão troca o CTRC → e o `card_event` diz `AcaoExecutada` **com sucesso**.

Contraria duas decisões já tomadas contra esta exata classe de erro: o [ADR 0014](0014-guard-conversao-pdf-ssw.md) (*"falha explícita > sucesso silencioso"*) e `veto-agendamento.ts` (*"nunca sobe pro SSW com anexo faltando"*).

Medido, para calibrar o risco: os 5 CT-e e as 3 NFD são **PDFs nativos/vetoriais**, 1 página, **zero JBIG2**, com fração não-branca de **6,05% a 13,18%** — 3,0× a 6,6× o piso de 2% do guard. A causa-raiz do ADR 0014 é máscara JBIG2 em documento **escaneado**, que estruturalmente não se aplica a CT-e emitido por ERP. **Mas escaneado chega:** o histórico tem `20260831_112011.pdf` e `20260901_124641.pdf`, nomes de timestamp de câmera. É justamente o caso que o fail-closed trata.

### 5. O ciclo é chaveado por `(nf, ctrc_origem)`, nunca por `card_id`

A devolução **gera um CTRC novo** e o Bastão cria um **card novo** ([ADR 0006](0006-ctrc-identidade-do-card.md)). Chavear por card prenderia a linha ao card morto, orfanaria anexo e baseline, e o detector redispararia no card novo gerando 2ª oc 44 e 2º e-mail. `card_id` é **ponteiro mutável**.

### 6. A regra "nunca 44 sem CT-e" é parede no BANCO, não checagem em código

`CHECK (oc44_lancada_em IS NULL OR cte_anexo_id IS NOT NULL)` + `CHECK (oc44_lancada_em IS NULL OR cte_convertido_ok IS TRUE)` + `CHECK (email_interno_enviado_em IS NULL OR oc44_lancada_em IS NOT NULL)`.

Motivo: tool novo não registrado em `decidir-clique-aprovacao.ts` cai em `"aprovar-direto"` e **aprova às cegas com `extras=null`** — é a 5ª recorrência de uma classe que o próprio arquivo cataloga. Guard em código pode ser furado; constraint não.

### 7. Escopo cercado no banco, com zero hardcode de CNPJ

Trigger `guard_escopo_devolucao_cte` recusa ligar `cliente_config.exige_cte_devolucao` para CNPJ fora da carteira do operador de escopo, que é **configuração** (`devolucao_cte_config.operador_escopo`), não literal em código (lição do INV-075). Vazar escopo atinge as carteiras de Larissa/Karoline/Ingrid e é irreversível na relação com o cliente.

### 8. NFD: quem emite é o DESTINATÁRIO, e o momento define quem entrega

- Emitiu **no ato da entrega** ⇒ o papel fica com a nossa operação ⇒ **a unidade anexa no SSW pela oc 49** (maioria dos casos).
- Emitiu **depois** ⇒ **o cliente envia** por e-mail.

Os dois caminhos são legítimos. Isso explica o que a medição mostrou: na caixa da MARIA há **4 e-mails pedindo** a NFD e **4 enviando**. Não era cliente incoerente.

**Ordem fiscal**, dita pela própria AGV: *"foi emitida a NFD em cima da nota de origem, ou seja, o CT-e devolução seria gerado em cima da NFD."* Havendo exigência de NFD, **NFD antes do CT-e**.

### 9. A exigência de NFD é POR PROCESSO e entra por CLIQUE humano, sem IA

Substitui a decisão inicial de tratá-la como configuração estável por cliente. Prova: a **mesma AGV** aparece nas duas pontas, e em 10/07 escreveu *"ainda não recebemos a NFD **do cliente** para seguirmos"* — a exigência depende do cliente **do** cliente e muda caso a caso. `cliente_config` fica só como **cerca de escopo**.

**Por que sem IA, medido:** nenhum e-mail real diz "Solicito NFD". As formas medidas — *"temos NFD?"*, *"solicitado a NFD para devolução das avarias"*, *"encaminhar uma foto nítida da NFD"* — são semanticamente iguais e lexicalmente sem interseção, então regra por palavra não resolve. E a armadilha é distinguir **exigência** de **pergunta de status** (*"temos retorno dessa devolução nf 9040 - nfd 9306?"*), que são quase idênticas. Volume: **4 casos/mês**. Isso não paga uma dependência de IA + eval + corpus rotulado + superfície de regressão numa função que serve **todos** os operadores. Os cliques da operadora geram os rótulos; o classificador entra depois, se o volume justificar.

### 10. A cobrança nasce dentro da feature — o cron existente NÃO será religado

Medido em produção: **`cobranca-cliente-aguardando-daily` está `active = false`**. Religar não é ação neutra — a primeira execução varreria **todo o backlog** acumulado e dispararia e-mail de cobrança **para clientes reais** sobre cards antigos. E-mail externo é irreversível.

A cobrança do ciclo é nova, dirigida por `devolucoes_cte.status` e **nunca** por `cards.state` — imune ao INV-019, que tirava o card de `AGUARDANDO_CLIENTE` a cada oc de relacionamento ≠54 e desligava a cobrança para sempre.

### 11. O ciclo próprio é o que segura o caso quando a oc 56 ejeta o card

Verificado em código: a **oc 56 não está** em `OCORRENCIAS_DE_RELACIONAMENTO`, então `stateFinalAposBastao(56)` devolve **`TRANSFERIDO`** e o card **sai do painel da operadora**. A volta é automática (a **oc 49 está** no conjunto), mas na espera — que dura semanas; a thread da AGV registra *"há mais de um mês"* — uma resposta do cliente só reativa o card dentro de **60 minutos** da última ação do Cockpit (`JANELA_ACAO_RECENTE_MS` no vinculador). Passado isso, o e-mail é anexado e **o card não volta**.

Sem `devolucoes_cte` como fonte do ciclo, o CT-e que chegasse durante a espera da NFD seria **engolido em silêncio**. Decisão: **manter a oc 56** (não mudar o processo) e segurar o caso pelo ciclo próprio. Requisito derivado: o detector roda por anexo salvo **inclusive em card TRANSFERIDO** com ciclo aberto (INV-131).

### 12. Rollout em escada, shadow-first, uma flag por degrau

Degrau 0 é infra com **todas as flags desligadas** ([mig 372](../../migration/2026-09-01_372_devolucao_cte_maria_infra.sql)). Degraus 3 a 7 são liga/desliga de flag, **TIPO B**, ordem nominal do Caio. Rollback de qualquer um é `UPDATE feature_flags SET enabled = false`. **`card_events` nunca é apagado no rollback** — é o que permite o retroativo depois (lição do INV-047).

### 13. Front: `apps/cockpit-web/` (Vercel), nunca prompt Lovable

Confirmado pelo Caio e coerente com o [ADR 0013](0013-front-proprio-fora-do-lovable.md). O `CLAUDE.md` está defasado nesse ponto e precisa de correção à parte.

## Consequências

**Positivas.** Um ciclo com identidade própria sobrevive à troca de CTRC, à ejeção do card pela oc 56 e à janela de 60 minutos do vinculador. As três regras que perdem documento fiscal viraram `CHECK` de banco. O escopo é cercado por trigger, não por inspeção. E o detector foi calibrado e medido em dado real, com falso positivo **zero** fora da carteira.

**Negativas, assumidas.** Mais uma tabela e um cron novo para manter. A cobrança do ciclo duplica conceitualmente um mecanismo que já existe no repo (mas está desligado). E `~45%` dos CT-e prováveis continuam caindo em nível B, ou seja, tratados à mão — decisão consciente de não dar autonomia com prova indireta.

**Aceitas com ressalva.** Nível B com sinal de nome forte (chave de 44 dígitos modelo 57) poderia ser promovido a nível A e dobrar a automação, mas isso inverteria a decisão nº 2. Fica registrado como pergunta, não como plano.

## Invariantes

**INV-123** escopo cercado (trigger + CHECK + gate) · **INV-124** anexo preservado · **INV-125** e-mail interno fora de `cards_emails_outbound` · **INV-126** nunca 44 sem CT-e (CHECK) · **INV-127** `caso_oc49` nomeado, fora da métrica-mãe da 49 · **INV-128** bump de `VERSAO_REGRAS_ANALISE` no mesmo diff · **INV-129** MIME por magic bytes · **INV-130** baseline imutável do vigia da NFD · **INV-131** detector roda em card TRANSFERIDO com ciclo aberto.

## Pendências conhecidas ao aceitar este ADR

1. Lista de **CNPJs** que entram em `cliente_config` — só o Caio pode dar (a config é por CNPJ pagador, e domínio de e-mail não resolve).
2. **Cadência da cobrança** semeada como 3 dias / a cada 3 / teto 4 — proposta, pendente de confirmação.
3. `cliente_config.cnpj_pagador` **sem CHECK de dígitos** (risco R17). Não corrigido na 372 porque validar dado existente deixaria de ser TIPO A. A migration emite `WARNING` com a contagem.
4. Policy de RLS para `authenticated` nas duas tabelas novas fica para o degrau do front — não vou adivinhar o helper de isolamento da mig 110.
5. A skill `supabase-postgres-best-practices`, exigida pelo CLAUDE.md, **não está instalada** na sessão que escreveu a mig 372. As práticas foram aplicadas à mão; a conferência pela skill está pendente.
6. Áudio do vídeo `entendo o fluxo.mp4` nunca analisado (só os 26 frames).
