# 0029 — PDI da Isadora: transcrição de áudio do 1:1 via OpenAI (novo provedor)

Data: 2026-09-16 · Status: aceita (ordem do Caio 16/09: "transcricao sera com
audio do iphone. eu vou gravar, pegar o arquivo e imputar. deve ser transcrito
e resumido")

## Contexto

O PDI da Isadora (aba nova no cockpit-web, mig 399) tem o ritual de 1:1: o
Caio grava a reunião no iPhone, sobe o arquivo de áudio na sessão, e a IA
transcreve e resume (pauta, feedbacks, compromissos com prazo — que viram
cards no kanban dela). O Claude não transcreve áudio; precisamos de um
provedor de fala→texto. A alternativa zero-dependência (colar a transcrição
do iPhone) foi oferecida e o Caio escolheu o upload do arquivo.

## Decisão

- **Provedor: OpenAI Audio Transcriptions** (`POST /v1/audio/transcriptions`,
  modelo `gpt-4o-mini-transcribe`; fallback `whisper-1` se indisponível).
  Custo ~US$ 0,003–0,006/min — um 1:1 de 45min ≈ US$ 0,15–0,27/sessão,
  frequência semanal → centavos/mês.
- **Escopo estrito:** a chave `OPENAI_API_KEY` (secret da edge, NUNCA no repo)
  é usada SÓ pela edge `pdi-processar-1a1`. Nenhum agente do Cockpit passa a
  usar OpenAI — o roteamento de modelos (convenção nº 7) segue 100% Anthropic.
- **Resumo continua no Claude** (Sonnet 4.6), prompt em
  `_shared/prompts/pdi-1a1.ts`, custo logado como `pdi-processar-1a1` no
  `anthropic_usage_log`.
- Fluxo: upload do áudio (bucket privado `pdi_1a1`, só o Caio insere) → edge
  baixa do Storage com service role → transcreve (OpenAI) → resume (Claude) →
  grava `transcricao` + `resumo` + cria os compromissos em `pdi_todos`.

## Limites conhecidos

- OpenAI aceita arquivos de até **25 MB** — no AAC comprimido do Notas de Voz
  (~48 kbps) isso dá ~70 min de reunião. Acima disso a edge falha com mensagem
  clara pedindo pra dividir o áudio (sem ffmpeg na edge; aceito).
- Sem a secret configurada, a sessão fica em `status='erro'` com instrução —
  o upload nunca se perde (áudio fica no Storage; reprocessável).

## Custo cognitivo assumido (convenção "antes de propor mudança grande")

+1 provedor = +1 chave pra rotacionar e +1 dashboard, mitigado pelo escopo de
uma única edge e pelo uso raro (1 chamada/semana). Reavaliar se a Anthropic
lançar transcrição nativa — aí o provedor sai.
