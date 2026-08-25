# 0016 — Ação Autônoma com Janela de Veto

Data: 2026-08-25 · Status: aprovado (Caio, 25/08) · Plano completo: sessão 25/08

## Decisão

O Cockpit deixa de ser copiloto (agente sugere, operador aprova tudo) e passa a
trilho autônomo com veto: **toda sugestão elegível de agente vira ação
programada que executa sozinha em 60 minutos ÚTEIS** (08h–17h30 BRT, seg–sex,
sem feriados — tabela `feriados`). Na janela, o operador:

1. **não faz nada** → executa (o silêncio é a aprovação);
2. **edita** (texto/template/anexos) sem cancelar → executa a versão editada,
   edição gravada estruturada (`edicoes_acao_autonoma`);
3. **cancela** (botão vermelho) → formulário obrigatório estruturado
   (`cancelamentos_acao_autonoma`), card volta ao fluxo manual, e a próxima
   ação do operador no card é capturada como "a correção".

Cancelamentos e edições são o dado de treinamento do agente. Exceções são dos
OPERADORES — o Caio não aprova nada no Cockpit.

## Mecânica (reuso deliberado)

- Trilho: `acoes_agendadas` tipo `executar_acao_autonoma` + edge
  `processar-acoes-agendadas` (cron 5min) — a infra batalhada do cancelamento
  de reentrega 24h.
- Execução: RPC nova `auto_aprovar_e_executar_veto` que replica o pré-voo
  HUMANO (cancela irmãs com a frase literal que o fluxo de falha reconhece,
  limpa aviso) e aprova **em nome do operador dono do card** — o e-mail sai
  da caixa dele (Gmail), rastreamento de resposta intacto.
- Segurança: flag master `acao_autonoma_veto_enabled` OFF + escada
  `acoes_autonomas_veto_config` (tudo nasce `ativa=false`; cada degrau é
  ordem nominal do Caio). Claim atômico, hash da proposta, TTL 30min,
  re-validação completa no vencimento, consulta à oc real do SSW antes de
  lançar, régua anti-duplicação por CICLO (`ciclosTratativa`).
- 35 riscos mapeados com defesa no plano (red-team 25/08).

## EMENDAS EXPLÍCITAS a regras anteriores

Estas três regras continuam válidas na LETRA nova abaixo — não foram
revogadas, foram emendadas conscientemente (aval do Caio 25/08):

1. **"Nenhuma ação sai sozinha do Cockpit" (Caio 22/06)** → ação SAI sozinha
   *apenas* pelo trilho de veto: janela de 60min úteis visível no Inbox,
   flag master + degrau da escada ativos, marcação obrigatória
   (`AutoAprovacaoPermitida` + `auto_approval_rule` + `aprovacao_modo`).
   Fora do trilho, a regra de 22/06 segue absoluta.
2. **INV-041 "e-mail nunca às cegas"** → a janela de veto É o olhar humano:
   o card mostra o conteúdo COMPLETO do e-mail durante a contagem. E-mail
   sem conteúdo completo gerado e visível não agenda (vira manual).
3. **INV-074 "robô Würth sugere-nunca-lança"** → o robô LANÇA quando a
   informação foi consumida da intranet, com a mesma janela de 1h útil
   (a operadora vê/corrige na janela). Sem consumo de intranet → só sugere,
   como antes.

A REGRA-MÃE da autonomia (21/08 — "nada roda autônomo sem validação expressa")
permanece intocada: tudo nasce desligado; cada ativação é ordem nominal.

## Alternativas descartadas

- **Autonomia instantânea por fatia (mig 340/348)** como via paralela:
  descartada — dois cérebros autônomos competindo (risco 25). O veto é O modo
  único; o cofre de fatias e suas travas viram config/insumo do veto.
- **Piloto com 1 operador**: descartado pelo Caio ("VAMOS ESTENDER PARA TODOS
  OS OPERADORES POR ORA MESMO") — a escada por AÇÃO já é o controle de risco;
  config por operador fica construída só como válvula de emergência.
- **Período de ensaio (dry-run)**: descartado — a 1h de veto É a validação.

## Consequências

- Duas abas novas no Inbox (AÇÃO AUTÔNOMA com countdown; EXECUTADA +1h) como
  VISÃO — nenhum estado novo de card; flag off = tudo volta ao layout atual.
- Aba Auditoria reformada (linha do tempo autônoma, cancelamentos, edições,
  placar do veto, devoluções/falhas).
- oc 44 e combos ficam manuais até o playbook do time trazer
  volumes/motivo/filial; oc 56/33/e-mail livre entram na onda 2 quando o
  agente gerar o conteúdo completo.
