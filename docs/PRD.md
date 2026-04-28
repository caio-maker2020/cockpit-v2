# PRD — Cockpit v2 Sal Express

**Versão:** 0.1 — Abril 2026
**Mantido por:** Caio (Sal Express)

## 1. Visão

Sistema de **agentes de IA autônomos** que tratam ocorrências de carga (NF) na Sal Express, com humanos validando ações em vez de executá-las. Objetivo de longo prazo: chegar a 70%+ de ações executadas sem intervenção humana, mantendo o time atual ou reduzindo headcount com aumento de volume.

## 2. Problema

A operação de relacionamento da Sal Express recebe centenas de mensagens/dia (WhatsApp e e-mail) sobre cargas em andamento — rastreamento, atrasos, reentregas, devoluções, avarias, extravios, inversões. O time de ~10 operadores faz três coisas hoje:

1. Lê mensagem, identifica problema e NF.
2. Consulta SSW pra entender o estado da carga.
3. Lança ocorrência no SSW e responde o cliente.

Quase tudo é trabalho repetitivo, conhecível por regras + contexto. **A IA pode tomar a decisão; o operador valida.** Mas a v1 (Cockpit Lovable) só ajuda a leitura/classificação — não age. Isso é o que muda.

## 3. Não-objetivos

Coisas que **não** são foco deste sistema, pra evitar deriva:

- **Não é chatbot de atendimento genérico.** Mensagem sem NF/card associada não é alvo prioritário.
- **Não é produto multi-tenant.** Uso interno da Sal Express. Sem ambição de vender pra outras transportadoras.
- **Não substitui o SSW.** SSW continua sendo TMS de verdade; o Cockpit é camada de tratativa em cima.
- **Não automatiza decisões irreversíveis sem humano.** Ações de alto risco (devolução, indenização, escalada legal) sempre passam por validação.

## 4. Usuários

| Papel | Hoje | Daqui pra frente |
|---|---|---|
| Operador (×10) | Lê e age | **Valida ação proposta pelo agente.** Em ações de baixo risco, eventualmente nem isso. |
| Gestor (Caio) | Acompanha tudo | Configura regras de risco, calibra prompts, lê auditoria, define o que pode rodar sem validação. |
| Agentes de IA | Sugerem | **Decidem e executam** (com ou sem validação humana, conforme regra). |

## 5. Casos de uso prioritários

Em ordem de implementação:

1. **Reentrega.** Cliente diz que tentou e ninguém estava — agente confirma novo endereço/data, lança ocorrência 21 no SSW, agenda follow-up D+1, responde cliente.
2. **Devolução.** Cliente autoriza devolução — agente valida autorização, lança ocorrência DEV, inicia processo, notifica.
3. **Rastreamento.** Cliente pergunta onde está — agente consulta SSW, traduz status, responde. (Candidato a auto-aprovação.)
4. **Avaria.** Cliente reporta dano — agente coleta evidências, classifica gravidade, abre processo (escala se houver seguro).
5. **Extravio.** Cliente diz que não chegou — agente busca filiais SSW, contata motorista, escala se não localizado.
6. **Inversão.** Cliente recebeu carga errada — agente cruza NFs próximas, identifica par, lança ocorrência.
7. **Cobrança/indenização.** Trigger por SLA — agente calcula indenização devida, monta demonstrativo, notifica.

## 6. Métricas de sucesso

| Métrica | Baseline (v1) | Meta v2 (6m) | Meta v2 (12m) |
|---|---|---|---|
| Tempo médio até 1ª resposta | ~30min | <15min | <5min |
| % ocorrências SSW lançadas sem operador | 0% | 30% | 70% |
| Taxa de aprovação de ações propostas pelo agente | n/a | >85% | >92% |
| Cards com classificação correta | ~90% (PRD v1) | >95% | >97% |
| Operadores simultâneos sem degradação | 10 | 10 | 10 (ou 5 com mesmo volume) |
| Disponibilidade horário comercial | n/a | >99% | >99,5% |

## 7. Restrições

- TMS é o **SSW** — sistema legado, REST disponível, sem garantia de idempotência nativa.
- WhatsApp é canal principal — Evolution API é a integração; risco de banimento se uso ficar suspeito.
- Empresa opera em **MG e ES**, B2B, fretes rodoviários.
- Time atual: ~10 operadores. Não é demitir — é reposicionar como validadores e absorver mais volume.
- Sem equipe de dev — Caio + Claude Code constroem.

## 8. Premissas operacionais

1. **Bastão (Supabase externo) continua sendo fonte de pendências SSW** enquanto não houver consulta direta confiável ao TMS.
2. **Validação humana é o estado padrão** pra qualquer ação de agente. Auto-aprovação é desbloqueada por agente, por tipo de risco, via feature flag, depois de medir taxa de acerto.
3. **Cards têm ciclo de vida fechado.** Card sem evolução por X dias úteis arquiva automaticamente.
4. **Toda ação tem rastro auditável** — quem (agente ou humano), quando, por quê, com que payload, com que resultado.

## 9. Fora de escopo desta versão

- Integração com transportadoras parceiras
- Portal do cliente (cliente segue interagindo via WhatsApp/e-mail)
- BI/dashboards analíticos (depois)
- Suporte a múltiplas filiais/operações além de MG-ES

## 10. Critérios pra remover validação humana de uma ação

Pra um agente passar a executar sem validação numa categoria de ação:

1. >300 ações desse tipo aprovadas pelo operador no histórico.
2. Taxa de aprovação >97% em janela de 30 dias.
3. Zero incidentes (lançamento errado, mensagem indevida) na janela.
4. Feature flag dedicada — desligável em 1 clique.
5. Auditoria sample 10% por 30 dias após ativação, sem regredir.
