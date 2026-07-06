#!/usr/bin/env python3
"""UserPromptSubmit hook — trava de modo para trabalho de front.

Enquanto o Cockpit tem DOIS fronts vivos:

- Lovable = produção atual dos operadores.
- apps/cockpit-web = front próprio em Vercel/homologação.

Qualquer prompt ambíguo sobre UI/front deve fazer Claude parar e perguntar
qual trilho usar antes de editar arquivo, gerar prompt ou deployar.
"""

import json
import re
import sys
import unicodedata


def _strip_accents(texto: str) -> str:
    nfkd = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


FRONT_TRIGGER = re.compile(
    r"\bfront\b|\bui\b|\bux\b|\btela\b|\btelas\b|\bvisual\b|\blayout\b|"
    r"\bdesign\b|\babas?\b|\blistagem\b|\bformulario\b|\bmodal\b|"
    r"\bkanban\b|\binbox\b|\bcard\b|\bcards\b|\bdetalhe\b|"
    r"\blovable\b|\bvercel\b|\bpreview\b|\bhomologacao\b|"
    r"apps/cockpit-web|cockpit-web",
    re.IGNORECASE,
)

EXPLICIT_MODE = re.compile(
    r"modo\s+(lovable|front\s+proprio|vercel)|"
    r"producao\s+atual|front\s+atual\s+em\s+lovable|"
    r"novo\s+front|front\s+proprio|apps/cockpit-web|"
    r"nao\s+e\s+lovable|nao\s+e\s+vercel|"
    r"prompt\s+(pronto\s+)?(para\s+)?(o\s+)?lovable",
    re.IGNORECASE,
)

MODE_GATE = """\
🚦 FRONT MODE GATE — prompt de front/UI detectado sem modo operacional explícito.

Antes de planejar, editar arquivos, gerar prompt ou fazer deploy, PARE e pergunte ao Caio:

1. Isto é para o LOVABLE / produção atual dos operadores?
   - Não editar `apps/cockpit-web/`.
   - Entregar prompt pronto para colar no Lovable.

2. Ou é para o FRONT PRÓPRIO / Vercel (`apps/cockpit-web/`)?
   - Não gerar prompt Lovable.
   - Não mexer no Lovable.

Não prossiga até o Caio responder claramente um dos modos.
Se o modo já ficar claro em mensagem posterior, siga o modo escolhido e respeite o escopo.
"""


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        return 0

    prompt = data.get("prompt", "") or ""
    alvo = _strip_accents(prompt).lower()

    if not FRONT_TRIGGER.search(alvo):
        return 0
    if EXPLICIT_MODE.search(alvo):
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": MODE_GATE,
        }
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
