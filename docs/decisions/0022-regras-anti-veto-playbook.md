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
