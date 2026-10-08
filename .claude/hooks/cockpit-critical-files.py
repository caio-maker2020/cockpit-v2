#!/usr/bin/env python3
"""
PreToolUse hook — dispara mensagem com 3 perguntas obrigatórias + lista de
invariantes aplicáveis quando Claude edita arquivo crítico do Cockpit v2.

Catálogo canônico de invariantes: docs/INVARIANTES_COCKPIT.md
Mapeamento arquivo → INVs vem da seção "Mapa" desse arquivo.

Input via stdin (formato Claude Code hooks):
  { "tool_input": { "file_path": "..." }, ... }

Output via stdout (vazio se não-crítico, ou JSON com additionalContext):
  { "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "..." } }
"""
import json
import sys

# Lookup arquivo → lista de IDs de invariantes aplicáveis.
# Mantido em sync com docs/INVARIANTES_COCKPIT.md (seção "Mapa").
INV_POR_ARQUIVO = {
    "supabase/functions/_shared/confirmar-acao-executada-ssw.ts": ["INV-002"],
    "supabase/functions/sync-bastao/index.ts": ["INV-003", "INV-004", "INV-006", "INV-007", "INV-008", "INV-011", "INV-019", "INV-040", "INV-148"],
    "supabase/functions/_shared/guard-anti-loop-criacao.ts": ["INV-040"],
    "supabase/functions/health-check/index.ts": ["INV-019", "INV-023", "INV-058", "INV-186"],
    "supabase/functions/_shared/inv023-indefinido-preso.ts": ["INV-023"],
    "supabase/functions/voltar-para-to-do-com-rastreio/index.ts": ["INV-001", "INV-005"],
    "supabase/functions/_shared/ssw-internal-client.ts": ["INV-001", "INV-013", "INV-063"],
    "supabase/functions/_shared/lancar-ssw-portal.ts": ["INV-013", "INV-014", "INV-063"],
    "supabase/functions/interpretador-evidencia-foto/index.ts": ["INV-001"],
    "supabase/functions/executor/index.ts": ["INV-002", "INV-008", "INV-011"],
    "supabase/functions/_shared/verificar-evidencia.ts": ["INV-001", "INV-011"],
    "supabase/functions/revalidar-evidencia-card/index.ts": ["INV-011"],
    "supabase/functions/vinculador/index.ts": ["INV-011"],
    "lib/bastao-rules.ts": ["INV-010", "INV-008"],
    "supabase/functions/_shared/bastao-rules.ts": ["INV-010", "INV-008"],
    "supabase/functions/_shared/regras-auto-acao.ts": ["INV-004", "INV-008"],
    "supabase/functions/_shared/transicao-aguardando-cliente.ts": ["INV-006", "INV-008"],
    "supabase/config.toml": ["INV-009"],
    # Correção 08.09 (ADR 0026). INV-147: pouca tinta não reprova conversão boa
    # e uma página ruim não derruba o PDF inteiro. INV-148: na oc 13,
    # `ativo` (visibilidade) e `autonomo_ativo` (autonomia) são interruptores
    # separados — um nunca substitui o outro.
    "apps/cockpit-web/src/lib/pdfConversaoGuard.ts": ["INV-147"],
    "apps/cockpit-web/src/components/cards/ProposedActions.tsx": ["INV-147", "INV-150", "INV-152", "INV-153"],
    "supabase/functions/_shared/pdf-conversao-guard.ts": ["INV-147"],
    "supabase/functions/agente-oc13-autonomo/index.ts": ["INV-148"],
    "supabase/functions/_shared/bastao-client.ts": ["INV-148"],

    # Correção 09.09 (ADR 0027). INV-149: o 59 sobrevive por PENDÊNCIA DE
    # DOCUMENTO, não por "é extravio total?" — e a assimetria preservar(largo)
    # × ressuscitar(estreito) é deliberada. INV-150: a 33 bloqueada diz o que
    # falta, e o espelho do dossiê no front não pode divergir do backend.
    "supabase/functions/_shared/propostas-pos-resposta-cliente.ts": ["INV-149", "INV-161"],
    "apps/cockpit-web/src/lib/dossie33Faltando.ts": ["INV-150"],
    "supabase/functions/_shared/extravio-parcial-dossie.ts": ["INV-150"],

    # Correção 11.09 (NF 436268 / KAROLINE). INV-152: a tela não oferece oc 33
    # que a parede vai recusar, e o `disabled` sai do CARIMBO (o que a parede
    # lê), nunca do espelho do dossiê vivo. INV-153: a recusa deixa rastro — e
    # com o actor_id do operador, senão a RLS engole a telemetria.
    "apps/cockpit-web/src/lib/gateOc33Carimbo.ts": ["INV-152"],
    "apps/cockpit-web/src/lib/aprovacaoRecusadaEvento.ts": ["INV-153"],

    # Correção 28.09 (ADR 0035, NF 40484). INV-161: a 21 com CCE de endereço
    # vigente não sai pela janela de veto — toda armação das 3 portas passa pela
    # trava. As portas grandes (interpretador, agente-sugere) ficam fora deste
    # mapa de propósito; quem as protege é o guard de fiação.
    "supabase/functions/_shared/cce-endereco-trava.ts": ["INV-161"],
    # Operação no Cockpit (ADR 0041, 2026-10-07).
    "supabase/functions/_shared/lancar-ssw-portal-operacao.ts": ["INV-013", "INV-046", "INV-063", "INV-181"],
    "supabase/functions/_shared/operacao-lancamentos-worker.ts": ["INV-159", "INV-184", "INV-185", "INV-186"],
    "supabase/functions/processar-lancamentos-operacao/index.ts": ["INV-181", "INV-184", "INV-186"],
    "supabase/functions/_shared/operacao-materializar.ts": ["INV-040", "INV-182", "INV-188", "INV-189"],
    "supabase/functions/_shared/bastao-operacao-client.ts": ["INV-182"],
    "supabase/functions/materializar-fila-operacao/index.ts": ["INV-182", "INV-187"],
    "supabase/functions/_shared/operacao-sugestao.ts": ["INV-183", "INV-185", "INV-188"],
    "supabase/functions/_shared/operacao-vigia.ts": ["INV-058", "INV-186"],
    "migration/2026-10-07_430_operacao_fila_e_lancamentos.sql": ["INV-180", "INV-183", "INV-184", "INV-185", "INV-186", "INV-187"],
    "migration/2026-10-07_431_operacao_separacao_rls.sql": ["INV-180"],
    # Sugestão regra → agente e encaminhamento ao Relacionamento (ADR 0041 D10/D11).
    "supabase/functions/_shared/operacao-agente-sugestao.ts": ["INV-167", "INV-188"],
    "supabase/functions/_shared/operacao-sugerir-ia.ts": ["INV-188", "INV-189"],
    "supabase/functions/sugerir-operacao/index.ts": ["INV-188", "INV-189"],
    "supabase/functions/_shared/prompts/agente-operacao.ts": ["INV-188"],
    "prompts/agente-operacao.md": ["INV-188"],
    "migration/2026-10-07_434_operacao_regras_sugestao.sql": ["INV-188"],
    "migration/2026-10-07_435_operacao_sugestao_ia_cache.sql": ["INV-188"],
    "migration/2026-10-07_436_operacao_encaminhar_relacionamento.sql": ["INV-180", "INV-185", "INV-189"],
    "migration/2026-10-07_438_operacao_espelho_relacionamento.sql": ["INV-180", "INV-189"],
    "migration/2026-10-07_439_operacao_sugestao_aguardar_e_estado.sql": ["INV-185", "INV-188"],
    "migration/2026-10-07_440_operacao_regras_modelo_e_condicoes.sql": ["INV-188"],
}

# Resumo curto de cada invariante (1 linha) pra exibir no hook sem precisar
# abrir docs/INVARIANTES_COCKPIT.md. Detalhe completo + comando de verificação
# vive no .md.
INV_RESUMO = {
    "INV-001": "Bastão=INPUT, SSW interno=SAÍDA. Nenhum caller novo de lib/ssw-tracking-client.ts.",
    "INV-002": "confirmar-acao-executada-ssw NÃO pode limpar bastao_oc_no_lancamento nem bastao_updated_at_no_lancamento.",
    "INV-003": "Pass A voltouParaRelacionamento usa guard combinado (oc + updated_at) — bastaoEhMesmoSnapshotDoLancamento.",
    "INV-004": "Pass A preserva chave_cte + propostas_recusadas_em/para_oc + bastao_updated_at no agent_state.",
    "INV-005": "voltar-para-to-do-com-rastreio usa SSW interno (buscarNFInterno), não tracking público.",
    "INV-006": "oc=54 ⟺ AGUARDANDO_CLIENTE, exceto cliente_respondeu_em != null.",
    "INV-007": "state ACAO_EXECUTADA blindado contra Pass B (filtro SELECT + early skip).",
    "INV-008": "stateFinalAposBastao é fonte única de mapeamento oc→state. Não duplicar tabela.",
    "INV-009": "Edge functions internas têm verify_jwt=false no config.toml (triador, vinculador, executor, etc).",
    "INV-010": "OCORRENCIAS_DE_RELACIONAMENTO contém 54. NUNCA remover (49 cards movidos errado em 2026-05-12).",
    "INV-011": "Callers de temEvidenciaParaOc / verificarEvidenciaESinalizar PASSAM ctrcEsperado quando há card com ctrc (NFs com múltiplos CTRCs = reentrega/complementar).",
    "INV-019": "Card AGUARDANDO_CLIENTE com oc de relacionamento ≠54 TEM que ir pra AGUARDANDO VOCÊ. NUNCA pode ficar preso (operador não vê = sem tratativa). 3 camadas: Pass A move na hora + sweep selfHealAguardandoClienteOcRelacionamento (sync-bastao) + watchdog checkAguardandoClienteOcRelacionamento (health-check, processo separado). NÃO remover nenhuma das 3 sem aprovação explícita do Caio. Regressão 2026-06-22 (Pass E desligado) travou 52 cards 5 dias.",
    "INV-152": "A tela NUNCA oferece oc 33 que `aprovar_e_executar` vai recusar. O `disabled` sai do CARIMBO meta.gate_oc33 (o que a parede lê), NUNCA do espelho do dossiê vivo — medidos 29 todos em que os dois divergem, e apagar pelo espelho apaga botão que o banco aceita. Todo ramo que apaga o botão TEM que mostrar o motivo, e o modal de anexos só fecha quando a aprovação PASSA (NF 436268/KAROLINE: 156 cards de 9 operadoras; a recusa descartava a seleção de anexos e o relato virou 'os anexos não vão pro SSW').",
    "INV-153": "Aprovação recusada pela parede GRAVA card_event AprovacaoRecusadaNaParede, fora da transação que morreu, com actor_id = operador.id (a RLS card_events_insert_operator exige). Sem isso a recusa é invisível: em 11/09 havia 903 Oc33BloqueadaDossieIncompleto, TODOS do robô, ZERO de operadora clicando — e 156 cards presos passaram meses sem medição.",
    "INV-161": "Reentrega (oc 21) com CCE de ENDEREÇO vigente NUNCA sai pela janela de veto: as 3 portas (interpretador-resposta-cliente, propostas-pos-resposta-cliente, agente-sugere-ocs-padrao) armam por agendarComTravaCce, nunca direto em agendarAcaoAutonomaSeElegivel (nem por apelido). Evento CceEnderecoSegurouAutonomo não pode começar com 'Acao'. A frase do template que pede CCE nunca conta como CCE. NF 40484/3907402, ADR 0035.",
    "INV-040": "Sync NUNCA fabrica cards em loop: bloquearCriacaoSeLoopDetectado nos 2 pontos de criação (extravio + bastão) — ≥3 terminais da NF criados em 24h bloqueia criação + LoopCriacaoCardDetectado. NF 2084: 74 cards em rajada 14-15/07 (uniq parcial não segura card que nasce terminal). Caminho de criação novo = chamar o guard.",
}


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("{}")
        return

    file_path = (data.get("tool_input") or {}).get("file_path") or ""

    # Normaliza pra match relativo
    rel = next((k for k in INV_POR_ARQUIVO if file_path.endswith(k)), None)
    if not rel:
        print("{}")
        return

    invs = INV_POR_ARQUIVO[rel]
    invs_detalhe = "\n".join(f"   {iid} — {INV_RESUMO.get(iid, '?')}" for iid in invs)

    msg = f"""ARQUIVO CRITICO COCKPIT V2 - REGRA OBRIGATORIA antes de editar:

Voce esta mexendo em codigo que controla regras fundamentais. Mudancas aqui ja causaram bugs graves em producao (ex: 2026-05-12 remocao de oc=54 moveu 49 cards de AGUARDANDO_CLIENTE pra TRANSFERIDO; 2026-05-14 NF 1075381 reabriu indevidamente apos ssw confirmar oc=56).

INVARIANTES APLICAVEIS A ESTE ARQUIVO ({rel}):
{invs_detalhe}

Catalogo completo + comando de verificacao por INV: docs/INVARIANTES_COCKPIT.md

ANTES DE EDITAR, responda explicitamente as 3 perguntas no chat (sem essas 3 respostas, NAO PROSSIGA):

1. Qual regra fundamental esta sendo alterada? (cite a constante/funcao especifica + qual INV mapeia)

2. Lista TODAS as funcoes/passes que consultam essa regra DIRETAMENTE - use grep para verificar, nao confie em memoria. Cubra: Pass A (upsertCardFromPendencia), Pass B (releaseCard, releaseCardViaTracking), Pass C/D/E/F/G/H, vinculador, executor, regras-auto-acao, confirmar-acao-executada-ssw.

3. Se a regra for relaxada/removida, quais cenarios quebram? Mapeie pelo menos 2 casos reais (consulte cenario_real de cada INV citado).

APOS COMMIT/DEPLOY: rodar `/verify-cockpit` (Fase 8 = invariantes automatizados) pra confirmar que nenhum INV foi violado.

Invoque tambem skill supabase-postgres-best-practices se mexer em SQL/migration."""

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": msg,
        }
    }))


if __name__ == "__main__":
    main()
