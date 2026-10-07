# ADR 0040 — Baixa do motorista: o Roteirizador manda, o Cockpit grava no SSW

Data: 2026-10-07
Status: proposto. Código na branch `op/baixa-motorista` (base eb2d098 = master 178dcf8 +
ponte v2). As migrations 420 e 421 **não foram aplicadas** (nem dry-run). Nenhuma edge
foi deployada, nenhuma flag ligada, nenhum secret criado. Tudo aguarda o time do Cockpit,
pelo trilho.
Contrato: "Ponte v3: baixa do motorista" (`docs/PONTE-COCKPIT.md` do Roteirizador). Esta
branch implementa o contrato como foi passado ao Cockpit em 07/10; **conferir campo a
campo contra o documento do v3 antes do merge** (o arquivo não estava disponível nesta
máquina na hora da construção).
Guards: **INV-013** (atualizado), **INV-058** (atualizado), **INV-174 a INV-177** ·
migrations `2026-10-07_420_baixa_motorista.sql` e `2026-10-07_421_cron_processar_baixas_motorista.sql`
Relacionados: 0004 (o Cockpit é do Relacionamento), 0033 (ação irreversível), 0038 e
0039 (pontes v1 e v2), INV-159 (credencial única sem rajada).

## Contexto

O motorista dá baixa no app do Roteirizador: entregou (com recebedor, foto do canhoto,
GPS) ou não entregou (insucesso). Hoje alguém da base redigita isso no SSW. O
Roteirizador não escreve no SSW e não deve: **o Cockpit continua sendo o único que
escreve**, pela conta de serviço `ai.salex` (INV-013/INV-063), com as cercas que já
existem. O que muda é que, pela primeira vez, uma ocorrência sai **sem card**.

## Decisão

### D1 — A exceção "CTRC vem da baixa, sem card", com tripé obrigatório

A regra crítica do SSW diz: o CTRC correto é **sempre o do card**, nunca o achado pela
NF. A baixa não tem card — e não deve ganhar um: entrega não é tratativa (0004), e
criar card por baixa encheria o Relacionamento de notas que deram certo.

A exceção vale **só** com estas quatro condições juntas (INV-174):

1. o CTRC e a NF vêm **da baixa** (o romaneio do Roteirizador, que saiu do SSW) e
   **nunca** de busca por NF. O detalhe do CTRC é aberto com o CTRC da baixa
   (`buscarNFInterno(..., { ctrcEsperado })`), que falha se o SSW devolver outro;
2. o **tripé** CTRC + NF + Localização atual (`validarTripeCtrcNfPagador`) roda **antes
   do submit** nos dois canais. Divergiu = recusado, nunca "tenta outro CTRC";
3. a **verdade do SSW é lida antes de gravar** (`descobrirUltimaOcSsw`, mesma sessão):
   a 01 já está no CTRC → `ja_no_ssw`, nada é gravado; insucesso em nota entregue ou
   encerrada → recusado;
4. tudo passa pelo envelope novo `_shared/lancar-ssw-baixa.ts` (`lancarSswBaixa`). O
   `lancar-ssw-portal.ts` do Relacionamento **não é tocado nem usado**: a idempotência
   dele é por card (`acoes_executadas_ssw.card_id`), e aqui não há card. A idempotência
   da baixa é a própria fila (`baixaId` = PK, reserva atômica).

A baixa **não escreve** em `cards` nem em `card_events`. Ela só **lê** `cards` para não
lançar por cima do executor (card do CTRC em `EXECUTANDO_ACAO` → a baixa espera).

### D2 — Canal do SSW atrás de config, sem default

`baixa_motorista_config.canal` = `webapi` | `portal101`, nasce **NULL** (nada vai ao SSW),
muda só por migration TIPO B com `autorizado_por`/`autorizado_em` (CHECK).

- **`portal101`** = `lancarOcorrenciaPortal` (opção 101), o mesmo caminho do
  Relacionamento, com o tripé no callback do act=O, a evidência como foto da ocorrência
  e a hora real (D3).
- **`webapi`** = `ocorrenciaParceiro` (`createSswClient`, `_shared/ssw-client.ts`, que
  existia sem uso desde 08/06 e foi reaproveitado sem mudança). Aceita `dataHoraEvento`
  e **1** imagem em base64. Ele pede `chaveCTe` e `cnpjRemetente`, que a baixa não tem:
  - a chave é lida da lista de CTRCs da NF **filtrando pelo CTRC da baixa, igualdade
    exata, não cancelado** (só leitura: o CTRC continua sendo o da baixa);
  - o CNPJ do remetente é lido da tela do CTRC; sem achar → recusado (`webapi_sem_dados`);
  - o tripé roda sobre a tela do CTRC; se o layout não casar, **recusa** (fail-closed);
  - **credencial (INV-013):** a WebAPI usa `SSW_USERNAME`/`SSW_CNPJ_EDI`. O canal só roda
    se `SSW_USERNAME` == `SSW_LANCAMENTO_USUARIO` (a `ai.salex`). Diferente → nada é
    enviado, a baixa volta à fila e o vigia acusa.

As leituras (verdade, detalhe) usam sempre a sessão do portal da `ai.salex`, nos dois
canais.

**Por que os dois e não um:** quem gera o **Comprovante de Entrega** (evento do CT-e na
SEFAZ) e qual dos caminhos deixa a foto onde a Sal precisa é pergunta da Sal/Caio (ver
"Depende da Sal"). O código fica pronto para os dois e a escolha é uma linha de config.

### D3 — Hora real

A ocorrência vai com `ocorridoEm` (hora em que o motorista deu baixa), não com "agora":

- `lancarOcorrenciaPortal` ganhou `dataHoraEvento?: Date` (f4/f5). **Diff mínimo** (3
  trechos): ausente = comportamento de sempre (agora − 2 min); presente = a hora, limitada
  a agora − 2 min (**nunca futura**; o SSW recusa); inválida = nada enviado. Provado
  byte a byte contra o arquivo base em 8 cenários e travado por teste (INV-176).
- WebAPI: `dataHoraEvento` no formato `yyyy-mm-ddThh:mm:ss:mmm-03:00`, mesmo limite.
- O contrato recusa (422) `ocorridoEm` mais de 2 min no futuro e hora **sem fuso**.

### D4 — Execução, vazão e orçamento de SSW (INV-159, INV-175)

O POST **nunca** faz login: grava `baixas_motorista` e responde. O worker
`processar-baixas-motorista` (cron 1 min, mig 421) faz o resto, **um por vez**:

0. **Prazos:** a baixa vale até o **fim do dia seguinte ao ocorrido** (São Paulo).
   Passou disso → `erro` "lançar à mão" (uma baixa de anteontem já não é hora real, e a
   base pode ter baixado à mão). `lancando` há mais de 15 min → `erro` "lançamento
   interrompido: conferir no SSW". **Nunca relança às cegas.**
1. **Freio no começo:** `baixa_motorista_lancar_ssw` OFF ou canal NULL → a rodada para.
   As baixas **esperam** (não são descartadas) e expiram no prazo.
2. **Preparar:** piloto (D6) e lista de insucesso relida → `na_fila`.
3. **Reservar** (`baixa_motorista_reservar`): advisory lock próprio, janela **global** de
   60 s, **2/min, teto 3 no SQL**, quarentena de **30 min** depois de login recusado,
   **insucesso antes de entrega** (o insucesso precisa entrar antes de a 01 encerrar o
   CTRC), depois a hora do evento. Os parâmetros são **importados** de
   `ponte-operacao-worker.ts` (mesma fonte da v2).
4. **Para cada reservada:** cerca no banco (outra baixa já fez a 01 deste CTRC →
   `ja_no_ssw`; outra em voo ou o Relacionamento executando → espera) → **evidência**
   baixada e conferida (D7) → **freio relido** → envelope.

Falha **antes do submit** (leitura do SSW, Roteirizador fora) volta à fila e conta
tentativa (3 → `erro`). Login recusado volta à fila **sem** gastar tentativa, para a
rodada e liga a quarentena (INV-159 d: esperar). O SSW **recusou** o submit, ou caiu
**no meio** → `erro`.

**Orçamento, no pior caso:**

| | por minuto | observação |
|---|---|---|
| lançamentos da baixa | ≤ 3 (normal 2) | teto no SQL, contagem global |
| logins no portal pela baixa | ≤ 1 | sessão em cache no isolate (~1 h de JWT); 0 quando quente |
| logins na WebAPI | ≤ 1 a cada ~50 min | token em cache no cliente |
| requisições ao portal | ≤ ~27 | ~9 por baixa: verdade (3), detalhe (2), act=O + upload + submit |
| refresh de histórico | 0 | a baixa não tem card; não dispara `puxar-historico-ssw-card` |

Somando com a ponte v2 (≤ 3 lançamentos e ≤ 1 login/min), o pior caso fica em ~2 logins
e 6 lançamentos por minuto, abaixo dos ~10 logins/min do INV-159 (a). As duas filas têm
**janelas separadas**; se a operação crescer, juntar as duas numa contagem só é o próximo
passo. Vazão: 120 baixas/h por fila; uma base de ~300 entregas espalhadas no dia não
represa, e um pico de 30 baixas em 10 min escoa em 15 min, muito dentro do prazo.

### D5 — Contrato (`ponte-baixa-entrega`)

- Auth: o **mesmo esquema da v2** (`Bearer PONTE_OPERACAO_TOKEN`; sem o segredo → 503;
  errado → 401). O `ROTEIRIZADOR_PONTE_TOKEN` é da direção contrária e não abre esta porta.
- `POST` → **202** `{baixaId, status:"recebido"}`; **200** mesmo `baixaId` e mesmo
  conteúdo (status atual); **409** mesmo `baixaId`, conteúdo diferente (status do
  original, nada executado); **422** com a lista de motivos (código fora da lista, nf/ctrc
  inválidos, `ocorridoEm` no futuro ou sem fuso, evidência > 1 ou mime fora de
  JPEG/PDF, motorista/rota ausentes, motorista com nome de automação); **503** com
  `baixa_motorista_receber` OFF.
- `GET ?ids=a,b` (até 200) → `[{baixaId, status, em, motivo}]`, status ∈ `recebido |
  na_fila | executado | ja_no_ssw | recusado | erro` (o interno `lancando` sai como
  `na_fila`); ids desconhecidos ficam de fora.
- `tipo: entrega` ⇒ código **01** (implícito, nunca da lista). `tipo: insucesso` ⇒ código
  da lista fechada, nunca 01.

### D6 — Lista fechada de insucesso e piloto (INV-177)

- `baixa_motorista_codigos` nasce **vazia**; CHECK proíbe 01, 49, 54, 59; trigger exige
  `responsabilidade = 'Operação'` no `ocorrencias_dicionario`; `ativo` exige quem pediu e
  quem autorizou. **Dono: Caio** (como a lista da v2). **Por que só Operação:** oc de
  Relacionamento lançada pela `ai.salex` é lida pelo `decidirVisibilidadePorSsw` como
  ação do próprio Cockpit (`MANTER_FORA`) — a tratativa sumiria do operador. Insucesso que
  é tratativa vai pelo `devolver_ao_relacionamento` da v2.
- `baixa_motorista_piloto` nasce **vazio**: uma linha casa por base, por motorista ou pelos
  dois. Fora do piloto → `recusado` "lançar à mão" (a baixa não some em silêncio).

### D7 — Evidência

O worker baixa `{RI_PONTE_BASE_URL}/v3/ponte/evidencias/:id` com o
`ROTEIRIZADOR_PONTE_TOKEN` (direção Cockpit → Roteirizador; base de reserva:
`ROTEIRIZADOR_API_URL`), até 8 MB, e confere **sha256** == o declarado, **mime** do
cabeçalho == o declarado e a **assinatura** dos bytes (JPEG/PDF). Divergiu → `recusado`
sem ir ao SSW. 5xx/rede → espera (tentativa). 4xx → `recusado`. Os bytes não são
guardados no Cockpit.

### D8 — Auditoria

- `baixas_motorista` é o trilho completo: quem, quando, onde, rota, status, categoria,
  motivo, protocolo, canal.
- `audit_log`: uma linha por baixa que foi ao SSW (`external_system='ssw'`, `card_id`
  NULL, `idempotency_key = 'baixa_motorista:<baixaId>'`), com o texto enviado.
- Texto da ocorrência: o fato primeiro (cabe nos 70 caracteres que o setor lê:
  "ENTREGUE A <nome> DOC <doc>"), depois motorista, placa, rota, base, GPS e
  "BAIXA PELO APP DO ROTEIRIZADOR <id>".

## O que ficou DELIBERADAMENTE de fora

- **Card.** A baixa não cria nem move card. Num card ativo do mesmo CTRC, a 01 chega pelo
  fluxo de sempre (Bastão → sync-bastao). O insucesso (oc da Operação) pode fazer o card
  aparecer em CONFLITOS (INV-014 não o reconhece como "lançado pelo Cockpit", porque não
  há `acoes_executadas_ssw`): é o efeito certo — um terceiro (o motorista) mudou a nota.
- **Relançar.** Não existe. Erro é conferido e lançado à mão.
- **Texto livre do insucesso.** O contrato não traz; o código diz o motivo.
- **Guardar a foto.** Ela fica no Roteirizador e no SSW.

## Consequências e riscos

- **WebAPI não validada ao vivo:** chave do CT-e pela lista, CNPJ do remetente e tripé
  pela tela do CTRC foram escritos contra o parser e o layout que o Cockpit já conhece,
  com teste sintético. Todos falham **fechado** (recusa). O primeiro lançamento real por
  `webapi` vai num CTRC de teste.
- **Código "01" na WebAPI** vai como `"01"`; se o SSW exigir código de wire diferente
  (o antigo dexpara), a primeira chamada responde 4xx → `erro`, sem gravar nada.
- **`ja_no_ssw` do insucesso** compara código e hora (±2 min) com a data que o SSW mostra
  no histórico. Se essa data for a da **inclusão** e não a do evento, o "já está lá" do
  insucesso só pega lançamento quase imediato. A duplicidade real é barrada antes, pela
  fila (`baixaId` único, reserva atômica).
- **Tabelas quentes:** nenhum ALTER em `cards`, `card_events`, `audit_log`. O
  `ssw-internal-client.ts` mudou (D3): o pino da v2 foi repinado com o motivo.
- **Cron por minuto** (mig 421): +1440 execuções/dia, inertes com a flag OFF.

## Como ligar (time do Cockpit, pelo trilho, um passo por vez)

A ordem é fixa: **420 → deploy das 2 funções → 421 + pulso → `receber` ON → piloto + canal
→ `lancar_ssw` ON, com a lista de insucesso vazia.**

0. Antes: revisar este ADR e as 7 suítes (`deno test --no-check --allow-read
   supabase/functions/_shared/baixa-motorista-*.test.ts supabase/functions/_shared/lancar-ssw-baixa.test.ts
   supabase/functions/_shared/ssw-internal-client-data-hora-evento.test.ts`); conferir o
   contrato contra o `docs/PONTE-COCKPIT.md` do v3; confirmar a paridade de CTRC com um
   CTRC real; responder "Depende da Sal".
1. **Mig 420** (`dbq.py --autorizado-por`; TIPO B). Smoke: flags OFF, canal NULL, listas
   vazias, nenhum cron.
2. **Deploy** de `ponte-baixa-entrega` e `processar-baixas-motorista`. Secrets: o
   `PONTE_OPERACAO_TOKEN` já é o da v2; `RI_PONTE_BASE_URL` (ou `ROTEIRIZADOR_API_URL`) e
   `ROTEIRIZADOR_PONTE_TOKEN` para a evidência. Para `webapi`: `SSW_DOMAIN`,
   `SSW_USERNAME` (= a `ai.salex`), `SSW_PASSWORD`, `SSW_CNPJ_EDI`.
3. **Mig 421** (cron) e a **prova de pulso** (INV-156). O worker devolve `skipped: flag_off`.
4. **`baixa_motorista_receber` ON.** O v3 manda; as baixas ficam `recebido` (lançamento
   desligado); o vigia avisa que estão esperando.
5. **Piloto + canal** por migration TIPO B com dono: uma base (VGA) ou alguns motoristas,
   e o canal decidido pela Sal.
6. **`baixa_motorista_lancar_ssw` ON**, em horário calmo, com a lista de insucesso
   **ainda vazia** (só entregas). Antes, medir a taxa orgânica de login (INV-159 c). A
   primeira baixa real num CTRC de teste; conferir no SSW a hora, o texto, a foto e o
   usuário (`ai.salex`).

Depois: os códigos de insucesso entram um a um, por migration TIPO B, com critério e dono.

## Como desligar

- **Na hora, sem deploy:** `baixa_motorista_lancar_ssw` OFF (relida antes de cada
  lançamento; as baixas esperam e expiram no prazo). `baixa_motorista_receber` OFF (POST e
  GET 503, worker `skipped`). `UPDATE baixa_motorista_config SET canal = NULL`.
- **Um código / um piloto:** `UPDATE … SET ativo = false` (TIPO B).
- **Remover:** `cron.unschedule('processar-baixas-motorista')` e a reversão do cabeçalho
  da mig 420. O que foi lançado no SSW fica.

## Depende da Sal / do Caio

1. **Qual canal gera o Comprovante de Entrega na SEFAZ** (evento do CT-e) com a foto do
   canhoto: a 01 pelo portal 101 com foto, a `ocorrenciaParceiro` com imagem, ou nenhum
   dos dois (só o SSWMobile)? Isso decide `baixa_motorista_config.canal`.
2. **WebAPI:** a credencial `SSW_USERNAME`/`SSW_CNPJ_EDI` pode ser a da `ai.salex`? (Se não
   puder, o canal `webapi` fica bloqueado pelo INV-013 e só o `portal101` serve.) O código
   da entrega na WebAPI é `"01"`? O `cnpjRemetente` é mesmo exigido?
3. **Hora no passado:** até quantos dias o SSW aceita a 01 com data retroativa, e a data
   da 01 entra no prazo/SLA do cliente?
4. **Lista de insucesso:** quais códigos, com critério (fato da rota, responsabilidade
   Operação). Dono: Caio.
5. **Piloto:** qual base e quais motoristas.
6. A data que o histórico do SSW mostra é a do evento ou a da inclusão? (afeta só o
   `ja_no_ssw` do insucesso).
