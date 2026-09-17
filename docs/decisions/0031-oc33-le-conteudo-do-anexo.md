# ADR 0031 — A oc 33 passa a ler o CONTEÚDO do anexo do cliente

**Data:** 2026-09-15
**Decisor:** Carlos (dono do produto)
**Âncoras:** NF 431734 (valor dentro de PDF de 07/08), NF 436268 (Karoline, falta a descrição)
**Status:** aceito — implementado atrás de chave desligada (`dossie_le_conteudo_anexo_enabled`, migration 401)
**Renumerado em 2026-09-17:** nasceu como ADR 0029 / migration 399 na branch `oc33-le-anexo`. Enquanto a branch estava aberta, a master publicou o ADR 0029 (PDI Isadora) e as migrations 399 e 400. Para não haver dois arquivos com o mesmo número, este virou **0031 / migration 401** e o pop-up virou **migration 402**. O ADR 0030 (pop-up) manteve o número, que já estava citado no código e na memória. Por isso o 0030 cita o 0031 como "rodada anterior".

---

## Contexto

A oc 33 de extravio parcial caso 1 exige três provas: **romaneio + descrição dos itens
+ valor dos itens** (ADR 0023, migration 365). A exigência nasceu de um estrago real: a
**NF 660746** teve a indenização aberta incompleta e voltou 20 dias depois cobrando
"DESCRIÇÃO E VALOR".

Em 11/09 a investigação da NF 436268 (relato da Karoline: *"marco os anexos e eles não
vão pro SSW"*) fechou com INV-152 e INV-153: a tela parou de oferecer o que o banco
recusa, e a recusa passou a deixar rastro. **Mas a causa de fundo ficou.**

Em 15/09, com foco em anexo, ela apareceu: em `interpretador-resposta-cliente`, os anexos
do cliente eram entregues ao modelo **apenas como `filename, mime_type, size_bytes`** — o
conteúdo nunca era lido — e a consulta filtrava `.eq("message_inbox_id", body.message_id)`,
então **anexo de mensagem anterior era invisível**.

Consequência: descrição e valor só eram reconhecidos quando **escritos no corpo do
e-mail**. Dentro de um arquivo, ficavam ausentes → dossiê incompleto → to-do nasce com
`gate_oc33.bloqueada = true` → a trava de `aprovar_e_executar` recusa → botão cinza.

**Medido em 15/09:** 737 cards caso 1 com dossiê incompleto; 679 travados por descrição ou
valor; 514 com anexo inbound; **136 com romaneio já validado e arquivo legível vivo no
balde** — a primeira leva. A operadora com a maior pilha é justamente a Karoline (25).

## Decisão

**O agente passa a ABRIR o conteúdo dos anexos do cliente** (PDF, JPG/JPEG e PNG) para
achar descrição e valor, e **passa a enxergar anexo de mensagem anterior do mesmo card**.

Parâmetros fechados pelo Carlos em 15/09:

1. **Formatos:** PDF, JPG/JPEG e PNG. Planilha fica fora desta rodada.
2. **Não achou = continua faltando.** Se o agente abrir o arquivo e não encontrar a
   informação, a evidência segue ausente e a Sal segue cobrando o cliente. *"Para iniciar
   o processo de ressarcimento é necessário que as informações estejam completas."*
3. **Anexo de mensagem anterior conta** — para descrição e valor.
4. **Combo 33+44 fica de fora** desta rodada (141 to-dos): o caminho do combo não carrega
   descrição/valor no texto e ainda dispara devolução. Não mexer nele é risco zero.
5. **Quando o dossiê fechar, a cobrança pendente é cancelada** (139 pedidos de oc 59 e 123
   de oc 54). Precisa ser lido junto com o ADR 0027, que manda preservar o to-do de 59
   enquanto houver pendência de documento — o que muda é o significado de "há pendência".
6. **Evidência lida de arquivo NÃO libera lançamento autônomo** nesta rodada; libera só o
   botão para a operadora aprovar.
7. **Sem separação por piloto.** Recomendei começar pelos cards fora do piloto autônomo;
   com a decisão (6), a proteção real passa a ser o veto ao autônomo, não uma lista de
   nomes que muda quando o piloto crescer. Carlos confirmou: tratar os 136 igual.
8. **As 3 oc 33 já lançadas sem descrição/valor no texto** (NF 33588, 431555, 68001) não
   pedem providência — já foram ao SSW.

## O que este ADR REVERTE (e por que não é desobediência)

Duas decisões escritas caem aqui. Ficam registradas com todas as letras para ninguém
"consertar de volta" daqui a três meses:

1. **ADR 0023:** *"Fora desta rodada: (a) ler o **conteúdo** do anexo (OCR/visão) — (…)
   exige ADR próprio."* — Este é o ADR próprio que ele pediu. Não estamos furando a regra;
   estamos cumprindo o que ela previu.

2. **`docs/INVARIANTES_COCKPIT.md`, registro de 11/09:** *"dois buracos deliberadamente
   deixados fora **por decisão do Carlos em 11/09**: (a) a NF-e dos itens extraviados não é
   aceita como 'descrição dos itens' — 140 cards travados por isso, 21 deles já com o anexo
   no card."* — Em 14/09 o Carlos decidiu o oposto: a descrição **pode** vir dentro da NF de
   ressarcimento. É o dono do produto mudando de ideia com dado novo.

**O que NÃO muda:** a exigência das três provas continua idêntica. A trava continua
existindo. Ninguém ganha botão de "lançar mesmo assim".

## Consequências

### O desenho

- **Chave `dossie_le_conteudo_anexo_enabled` (migration 401), nascendo DESLIGADA.**
  Desligada, o comportamento é o de hoje byte a byte: mesma consulta, mesmo prompt, mesma
  chamada, mesmo texto no SSW. O flip é um UPDATE separado (TIPO B).
- **Recorte estreito:** só card que já é extravio parcial caso 1 faltando descrição ou
  valor — 37 conversas/dia de 196. Gatilhos mais largos foram descartados: 71 conversas em
  14 dias caem em card que **não** é parcial, e ali um contexto falso **criaria** dossiê +
  carimbo e passaria a recusar oc 33 em card que hoje funciona.
- **PDF vai como documento nativo para a API**, sem conversão. A edge
  `converter-anexo-pdf` foi **descartada**: grava linha nova em `email_anexos` com
  `origem='outbound'`, não é idempotente (63 linhas para 57 caminhos em produção) e cada
  linha queima vaga do teto de 20 anexos do operador — a falha da NF 719250. Ler não pode
  ter efeito colateral no card.
- **A leitura fica depois do disjuntor de falhas:** caminho degradado não baixa um byte.
- **Se a chamada com anexo falhar, repete uma vez sem anexo** — senão arquivo corrompido
  queima uma das 3 tentativas do disjuntor e o card cai no determinístico. Regressão pura.

### Campo novo: `texto_extraido`

O que o agente lê dentro do arquivo vai num campo **separado** de `texto_bruto`.
`texto_bruto` é a palavra literal do cliente e vai direto ao SSW; transcrição de máquina
não entra ali disfarçada de fala do cliente. Na Instrução do SSW, o texto lido aparece
**rotulado com o nome do documento** — `… (anexo NFE-433174 (1).pdf)`.

Isto **flexibiliza** o Ajuste 5 do ADR 0023 (*"o LLM só rotula, nunca parafraseia"*): ele
passa a poder transcrever, mas nunca a parafrasear, e a origem fica marcada.

**O nome do campo tem de ser idêntico em três lugares** — schema JSON do prompt, interface
`EvidenciaLlm` e `EvidenciaLlmRaw` do dossiê. Se um divergir, o dossiê ganha um campo que o
modelo nunca preenche, a Instrução volta a sair vazia e **ninguém percebe**, porque a trava
libera do mesmo jeito. O INV-154 confere os três.

### Cercas contra informação inventada

É o risco mais grave, e é o **inverso** do bug de hoje: o modelo ler um boleto e marcar como
valor a indenizar. Como evidência marcada **nunca é desfeita** (`mergeEvidencia` é
monotônico), um acerto falso é permanente.

- Só entram na validação os arquivos **realmente abertos** — nunca o card inteiro.
- Casamento de nome **exato e único**; ambíguo recusa (608 grupos `(card, filename)` repetem
  nome em produção, atingindo 201 dos 514 cards).
- **Romaneio continua preso à mensagem atual** — o romaneio histórico é território exclusivo
  do caminho determinístico (`seed_romaneio_v2_enabled`, em sombra desde 04/09). Se a leitura
  marcasse romaneio, venceria o seed no merge e 11 dias de medição virariam lixo.
- Regra dura no prompt: não achou legível, **omite**; boleto, nota de venda e comprovante
  **não** são valor a indenizar; nunca deduzir a partir de outro número da página.
- Estreia em observação (só mede, não decide), com amostra conferida por operadora antes do
  flip. Critério: erro de **valor** praticamente zero — valor errado no SSW é pior que valor
  ausente.

### Efeito colateral corrigido junto

Com texto lido de PDF, o caminho *"texto passou de 500 → vira imagem"* deixa de ser raro.
Ele **nunca rodou em produção** (0 de 183) e depende de buscar fonte na internet de dentro
da Edge Function. Quando falha, o SSW recebia *"ver anexo"* apontando para um arquivo
inexistente. Agora a promessa é trocada pelo texto real cortado, nos **dois** pontos de
materialização (no segundo, a variável `imagemGerada` nem existia).

### Dívidas herdadas, registradas e NÃO pagas aqui

- **O SYSTEM_PROMPT do interpretador continua inline no código**, contra a convenção 5 do
  CLAUDE.md. Extrair no mesmo commit misturaria duas mudanças de risco muito diferentes e
  quebraria um guard que conta texto dentro desse arquivo.
- **O executor tem 26 erros de tipagem anteriores** (`deno check`), provados idênticos aos de
  `origin/master`.
- **`bun` não está instalado nesta máquina**; o trilho real é `deno test` / `deno check`.
- **O aviso "AUTO-MIRROR de /lib" no cliente da Anthropic estava mentindo** — não há script
  de sincronia e as duas cópias divergiram (437 × 334 linhas). Corrigido o aviso; replicado
  só o tipo em `lib/`. Quem "consertar o espelho" copiando `lib/` por cima apaga a rede do
  INV-055.

### Fora desta rodada

O furo do `sync-bastao` (pedidos que nascem sem carimbo), a segunda porta de aprovação sem
trava, as 36 oc 33 já lançadas sem as provas, e o destravamento retroativo dos cards já
parados — que **não** se destravam sozinhos, porque a tela e a trava leem um carimbo
congelado que só o interpretador reescreve quando chega resposta nova.

## Guards

- **INV-154** no `/verify-cockpit` — provado: PASS nesta branch, **FAIL** contra
  `origin/master`.
- `_shared/dossie-anexo-lido.test.ts` — 6 testes; **5 falhavam** contra o código antigo
  (commit `cf4f736` registra a prova).
- `_shared/anexos-leitura.test.ts` (11), `_shared/anexos-blocos.test.ts` (9),
  `_shared/texto-oc33-promessa.test.ts` (6).
- Memória: `oc33-prova-pode-vir-em-anexo`.
