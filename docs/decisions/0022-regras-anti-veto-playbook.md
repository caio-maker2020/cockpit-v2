# ADR 0022 — Regras anti-veto do playbook (R1–R6)

**Data:** 2026-09-02 · **Status:** aceita (aprovada pelo Caio 02/09) · **Guard:** INV-139

## Contexto

Nos 7 primeiros dias do trilho autônomo (26/08–01/09): 337 ações armadas, 219
executadas, **20 vetos reais**. A análise veto a veto + o playbook respondido
pelo time (página `playbook-vetos` no monitor; respostas do Duilio 02/09 às 13
perguntas + decisões do Caio) converteu 19 dos 20 vetos em 6 regras
determinísticas. Meta: taxa de veto de 6% → <1%.

## Decisão

Todas pós-LLM/pós-padrão, determinísticas, com caso-âncora real e teste:

- **R1 Acareação → 41** (`oc49-casos-time.ts`): 49 com `ACAREA` → destaque 41,
  texto fixo "Realizar acareação" semeado nos extras do todo
  (`textoSsw41Override`). **Fora do trilho autônomo por ordem do Caio** — a 41
  não entra na escada `acoes_autonomas_veto_config`. Sem re-cobrança automática.
- **R2 Ressalva já existe → 54** (`resolver-pedido-ressalva.ts`): pedido de
  ressalva + ela já no ciclo → responder, nunca 56. Foto transcrita → 54
  normal; só texto "NÃO ASSINOU/RECUSOU ASSINAR" → 54 **sempre manual** (veto
  nunca arma; banner avisa "sem imagem").
- **R3 Extravio parcial → 54 pergunta / 55 se autorizado**
  (`extravio-parcial-regra.ts`): sem 55 após o extravio → 54 com o template
  literal do Duilio (parcial OU devolver); card já em 54 → aguardar (INV-094);
  quantidade indeterminável → manual.
- **R4 Escada da indenização** (`escada-indenizacao.ts`): (1) faltante sem 59 →
  59+e-mail docs (extravio: romaneio+descritivo+valor; avaria: +imagem);
  (2) 59 sem e-mail → só o e-mail (veto bloqueado, operador age); (3) dossiê
  completo → 33 (no interpretador E no agente). Exceção **romaneio-interno**
  (`cliente_config.usa_romaneio_interno` — PRATI/Würth/B&D): e-mail não pede
  romaneio.
- **R5 Reentrega × informação nova** (`oc49-contexto.ts` +
  `reentrega-em-aberto.ts`): 21/CTRC de reentrega APÓS a 49 → não relançar,
  info vira 55; 49 com contestação → manual; card 13 sem reentrega em aberto +
  LLM sugerindo 55 → 21. Parser "EMITIDO PARA REENTREGA" do Duilio (p11).
- **R6 Terminal/setor** (`estado-terminal-ssw.ts`): SSW encerrado ou devolução
  em curso (oc 30/reversa, Duilio p12) → não arma janela nenhuma na armação;
  INV-022 do vencimento vira segunda linha.

`VERSAO_REGRAS_ANALISE` → `2026-09-02a` (re-análise dos cards abertos =
retroativo natural).

## Fora de escopo (deliberado)

- Re-cobrança automática pós-41 (Caio: "não precisa agora").
- Variante romaneio-interno no corpo do template do AGENTE (o trilho
  romaneio-interno existente já oferece a ação recomendada certa; o
  interpretador cobre o corpo sem romaneio).
- WhatsApp como canal (veto NF 3578 permanece humano por design).

## Consequências

19/20 vetos cobertos; vetos legítimos que restam = informação de fora do
Cockpit. Regressão de qualquer lib = INV-139 FAIL (7 suítes, 49 testes).

## Adendo 2026-10-02 — R8 Conversa do lado do cliente (Carlos; relato da operadora)

**Contexto.** NF 1042798 (PRATI; nomes fictícios): a Ana respondeu a todos pedindo ao
"@Bruno", colega dela, a evidência de erro cliente "para não gerar RC" — "a
imagem abaixo" era o print do próprio Bruno. O interpretador não recebia
De/Para/Cc, leu a contestação como dirigida à Sal e a 56 saiu sozinha pela
janela de veto (30/09 08:19). No mesmo card ele já tinha acertado duas vezes
("encaminhamento interno → 54") quando o texto era óbvio.

**Decisão.** Mesmo padrão R2–R6 (modelo lê, código trava), como ÚLTIMO elo da
cadeia do interpretador (R2–R5 decidem como antes), agindo SÓ sobre a 56:

- o prompt ganha o bloco "QUEM ESCREVEU ESTA RESPOSTA E PARA QUEM"
  (`participantes-email.ts`) e o campo `pedido_dirigido_a` (a quem se
  dirigem os PEDIDOS/CONTESTAÇÕES do texto novo); a seção (e) vale só para a
  56 e diz que, para qualquer outra decisão, o destinatário não importa;
- leitura `outra_pessoa` + 56 → aguardar (54/59), sem texto de 56, sem
  devolução automática ao terminal, e nem esse aguardar arma a janela;
- sinal DETERMINÍSTICO das menções (o texto novo só marca com "@" quem não é
  da Sal) → a 56 não arma a janela, mesmo que o modelo erre a leitura;
- tudo que não é 56 → hoje (cerca `conversa_interna_cliente` em
  `veto-elegibilidade.ts`, lida no agendador para os dois call sites do
  interpretador).

**Como chegamos aqui — ensaio A/B (`evals/replay-conversa-interna.ts`, 201
respostas reais de 60 dias, mesma entrada nos dois prompts).** Variação
natural medida: o prompt de hoje, rodado de novo, discorda da produção em
~12% (13/105 do controle) e de si mesmo em 1/23 nas 56. Quatro rodadas:

1. "outra pessoa = nada a fazer": virava 33/44/21 legítimos em 54 ("@Paula,
   segue o romaneio em anexo"; autorização no histórico citado — NFs 50769,
   8087, 287903, 245154; contato corrigido — NF 518693). Descartado.
2. Destinatário só muda o pedido: melhor, mas ainda empurrava informação
   repassada a colega para 54, e a âncora 1042798 voltou a 56 (leu "a imagem
   abaixo" como prova do motorista). → nasceu o sinal determinístico.
3. Seção (e) só para a 56: sugestões no nível do ruído (alvo 5/90 = ruído
   5/90). Mas segurar no autônomo toda ação com leitura `outra_pessoa` tirava
   16 de 90 decisões legítimas do automático sem evitar erro → a cerca
   encolheu para a 56.
4. Frase nova fora da DEFINIÇÃO da 56 (ela deixava o modelo com receio de 56
   legítima — NF 906427 "não consigo abrir a ressalva"): âncoras em 54 nas 2
   rodadas; 906427 voltou a 56.

**Descartado também.** Regex de "@colega" decidindo oc: "Devolução
autorizada. @Estoque, gentileza recepcionar" (Autoglass/AGV) é decisão
legítima para a Sal. **Custo medido** do sinal das menções em 60 dias: 17 de
644 leituras 56 seguradas; das 63 que saíram sozinhas, 3 passariam pela
operadora (2 indevidas: NF 1042798 e NF 895809; 1 legítima: NF 911810).
**Fora de escopo:** agentes que não leem resposta de cliente
(`agente-sugere-ocs-padrao`, oc 13, Würth). Guard: INV-166 + Fase 7.9 do
`/verify-cockpit`.
