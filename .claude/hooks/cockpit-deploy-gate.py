#!/usr/bin/env python3
"""
DEPLOY-GATE — bloqueia `supabase functions deploy` a partir de base desatualizada.

Motivo (Caio 2026-07-21): um lote de 19 funções foi deployado a partir de um
commit anterior ao bastao-rules pós-59 e REGREDIU o vinculador em produção
(3ª regressão da mesma classe no dia — executor e atualizar-card antes).
Regra: "não posso eu mesmo fazer algo que não sei e gerar esse tipo de regressão".

O que este hook BLOQUEIA (exit 2 = a chamada não executa):
  1. Deploy com o checkout ATRÁS do origin/master (esqueceu git pull).
  2. Deploy com mudanças NÃO COMMITADAS em supabase/ (produção à frente do git).
  3. Deploy quando algum MARCADOR crítico do manifest (.claude/deploy-guards.json)
     está ausente do código local — sinal de checkout velho ou feature removida.
  4. Deploy de função listada como PROIBIDA (removida de produção de propósito).

Quebra-vidro auditável: prefixar o comando com DEPLOY_GATE_ACK=1 pula os checks
1-3 (nunca o 4). Use APENAS com ordem explícita do Caio, e diga o porquê.

ENCODING (2026-08-06) — não remova os `encoding="utf-8"` deste arquivo.
Este hook nasceu no macOS, onde o default do Python é UTF-8. No Windows o
default é cp1252, e toda leitura sem `encoding=` explícito corrompe acento.
Sintoma real: o marcador `Separação 54/59` era lido do manifest como mojibake
(bytes c3 a7 interpretados como dois caracteres), não batia com o fonte lido
corretamente em UTF-8, e o gate bloqueava 100% dos deploys da máquina com um
falso positivo.
"""
import json
import os
import re
import subprocess
import sys


def main() -> int:
    try:
        # stdin em UTF-8 explicito: com o default cp1252, um comando com acento
        # estoura UnicodeDecodeError e o except devolve 0 — o gate falharia
        # ABERTO, deixando passar justamente o deploy que devia checar.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except Exception:
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    cmd = (payload.get("tool_input") or {}).get("command") or ""
    if "functions deploy" not in cmd and "functions%20deploy" not in cmd:
        return 0

    repo = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

    def die(msg: str) -> int:
        sys.stderr.write(
            "🚫 DEPLOY-GATE BLOQUEOU este deploy.\n\n" + msg +
            "\n\nRegra do projeto (2026-07-21): todo deploy de edge function sai do "
            "master ATUALIZADO e commitado. Regressões reais: lote de 19 fns pré-59 "
            "regrediu o vinculador; executor/atualizar-card pré-59 mandavam card oc59 "
            "pra TRANSFERIDO (NF 292727). Corrija a causa apontada acima e rode de novo.\n"
            "Quebra-vidro (SÓ com ordem explícita do Caio): prefixe com DEPLOY_GATE_ACK=1.\n"
        )
        return 2

    # ---- 4. função proibida (nunca tem quebra-vidro) ----
    try:
        # encoding explícito: era ESTA linha que quebrava o gate no Windows.
        with open(os.path.join(repo, ".claude", "deploy-guards.json"), encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception:
        manifest = {"guards": {}, "funcoes_proibidas": {}}
    for slug, motivo in (manifest.get("funcoes_proibidas") or {}).items():
        if slug.startswith("_"):
            continue
        if re.search(r"functions\s+deploy\s+.*\b" + re.escape(slug) + r"\b", cmd):
            return die(f"A função '{slug}' foi REMOVIDA de produção de propósito e não pode ser re-deployada.\nMotivo: {motivo}")

    # ---- quebra-vidro (pula 1-3) ----
    if "DEPLOY_GATE_ACK=1" in cmd:
        sys.stderr.write("⚠️ deploy-gate: quebra-vidro DEPLOY_GATE_ACK=1 usado — checks 1-3 pulados. Registre o motivo pro Caio.\n")
        return 0

    def run(args, timeout=15):
        # `text=True` sozinho decodifica pelo locale (cp1252 no Windows) e
        # corrompe caminho/mensagem com acento vindos do git.
        return subprocess.run(
            args, cwd=repo, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )

    # ---- 1. checkout atrás do origin/master? ----
    try:
        run(["git", "fetch", "origin", "master", "--quiet"], timeout=20)
        r = run(["git", "merge-base", "--is-ancestor", "origin/master", "HEAD"])
        if r.returncode != 0:
            head = run(["git", "rev-parse", "--short", "HEAD"]).stdout.strip()
            om = run(["git", "rev-parse", "--short", "origin/master"]).stdout.strip()
            return die(
                f"Seu checkout ({head}) está ATRÁS do origin/master ({om}).\n"
                "Foi EXATAMENTE assim que o lote de 19 funções regrediu a produção.\n"
                "→ Rode: git checkout master && git pull  (e refaça o deploy do código atualizado)."
            )
    except subprocess.TimeoutExpired:
        sys.stderr.write("⚠️ deploy-gate: git fetch demorou — seguindo com os checks locais.\n")
    except Exception:
        pass  # sem git? deixa os checks 2-3 decidirem

    # ---- 2. mudanças não commitadas em supabase/ ----
    try:
        r = run(["git", "status", "--porcelain", "--", "supabase/"])
        sujo = [l for l in r.stdout.splitlines() if l.strip() and not l.strip().endswith(".env")]
        if sujo:
            return die(
                "Há mudanças NÃO COMMITADAS em supabase/:\n  " + "\n  ".join(sujo[:8]) +
                "\nDeploy só de código commitado (senão produção fica à frente do git — "
                "classe de bug já vivida neste projeto).\n→ Commite (branch + PR) antes de deployar."
            )
    except Exception:
        pass

    # ---- 3. marcadores críticos presentes? ----
    faltando = []
    for arquivo, marcadores in (manifest.get("guards") or {}).items():
        caminho = os.path.join(repo, arquivo)
        try:
            conteudo = open(caminho, encoding="utf-8", errors="replace").read()
        except FileNotFoundError:
            faltando.append(f"{arquivo}: ARQUIVO NÃO EXISTE neste checkout")
            continue
        for m in marcadores:
            if m not in conteudo:
                faltando.append(f"{arquivo}: marcador '{m}' ausente")
    if faltando:
        return die(
            "Marcadores CRÍTICOS ausentes do código local (checkout desatualizado ou "
            "feature removida sem atualizar .claude/deploy-guards.json):\n  " +
            "\n  ".join(faltando[:10]) +
            "\n→ git pull no master atual; se a remoção foi proposital, atualize o manifest no MESMO commit."
        )

    return 0

if __name__ == "__main__":
    sys.exit(main())
