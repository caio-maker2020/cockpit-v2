#!/usr/bin/env python3
"""UserPromptSubmit hook — REGRA CRÍTICA "Diagnóstico antes de correção" (CLAUDE.md).

Quando o prompt do Caio tem gatilho de correção (bug, fix, corrigir, correção,
regressão, "não funciona"/"não está funcionando"...), injeta o protocolo de
diagnóstico como additionalContext ANTES de Claude responder. Não bloqueia nada;
só reforça a regra que já está escrita no CLAUDE.md, pra não deixar escapar.

Determinístico: o harness executa este hook em todo prompt; a regra deixa de
depender só do CLAUDE.md passivo no contexto.
"""

import json
import re
import sys
import unicodedata


def _strip_accents(texto: str) -> str:
    nfkd = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


# Gatilhos casados contra o prompt em minúsculas E sem acento.
# Tokens curtos em inglês usam \b pra evitar falso-positivo (debug/prefix são OK,
# mas não queremos disparar em qualquer "fixar"); stems PT casam por substring.
TRIGGERS = re.compile(
    r"\bbug\b|\bbugs\b|\bfix\b|"          # bug(s), fix
    r"corrig|correc|"                      # corrigir, correção/correcao
    r"regress|"                            # regressão/regressao
    r"nao funciona|nao funcionou|nao funcionando|"
    r"nao esta funcionando|nao estao funcionando|"
    r"parou de funcionar",
    re.IGNORECASE,
)

PROTOCOLO = (
    "⚠️ GATILHO DE CORREÇÃO DETECTADO no prompt — aplicar a REGRA CRÍTICA "
    "\"Diagnóstico antes de correção\" do CLAUDE.md ANTES de responder:\n"
    "1. PROIBIDO afirmar causa raiz (\"o bug é X\", \"são 2 bugs\", \"a causa é Y\") "
    "ou propor fix definitivo sem verificar evidência direta (código, logs, banco, testes, diff).\n"
    "2. Começar a resposta com o relatório obrigatório, nesta ORDEM EXATA de rótulos: "
    "Sintoma observado / Comportamento esperado / Evidências verificadas / "
    "Hipóteses consideradas / Hipóteses descartadas / Causa raiz confirmada / "
    "Fix proposto / Riscos / blast radius / Como validar.\n"
    "3. Sem evidência que confirme → escrever \"hipótese não confirmada\", nunca como fato.\n"
    "4. Dois sintomas só viram \"dois bugs\" depois de PROVAR duas causas independentes.\n"
    "5. Explicar por que o fix ataca a RAIZ, não o sintoma, antes de editar código.\n"
    "6. Bug em produção: avaliar retroativo, teste anti-regressão, migration, evento "
    "em card_events, ajuste em memória/ADR e item no /verify-cockpit.\n"
    "7. Se o Caio questionar a conclusão, REABRIR o diagnóstico com evidência nova — "
    "não defender por inércia.\n"
    "8. Separar sempre: Fato verificado / Inferência / Hipótese / Decisão de implementação."
)


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        # Entrada inesperada: não atrapalha o fluxo.
        return 0

    prompt = data.get("prompt", "") or ""
    alvo = _strip_accents(prompt).lower()

    if not TRIGGERS.search(alvo):
        return 0

    saida = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": PROTOCOLO,
        }
    }
    print(json.dumps(saida, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
