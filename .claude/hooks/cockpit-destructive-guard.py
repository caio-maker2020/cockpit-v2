#!/usr/bin/env python3
"""
PreToolUse(Bash) — guarda de operações DESTRUTIVAS no Cockpit v2.

Fecha o buraco do hook de Edit/Write: operações destrutivas via shell
(supabase functions delete, cron.unschedule, git rm, psql com DROP/TRUNCATE)
passavam sem nenhuma trava. O pior caso é acoplamento "por DADO" (uma função
alimenta uma tabela que outra feature lê) — invisível pra check de schema.

Comportamento:
  - Comando NÃO destrutivo            -> {} (libera, custo ~0).
  - Destrutivo mirando WATCHLIST       -> permissionDecision: deny (bloqueio duro).
  - Destrutivo nos demais casos        -> permissionDecision: ask (pausa pro Caio),
                                          com blast-radius scan anexado.

Lê SQL embutido (-c "...") E arquivos referenciados (psql -f arquivo.sql), pois
o DROP costuma morar DENTRO da migration, não na linha de comando.

Input (stdin):  { "tool_input": { "command": "..." }, ... }
Output (stdout): {} ou { "hookSpecificOutput": { "hookEventName": "PreToolUse",
                         "permissionDecision": "...", "permissionDecisionReason": "..." } }
"""
import json
import os
import re
import subprocess
import sys

PROJ = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

# Infra que PARECE removível mas alimenta outras features (acoplamento por dado).
# Operação destrutiva mirando qualquer um destes = BLOQUEIO DURO.
# Manter em sync com docs/INVARIANTES + memórias. O nome MENTE: documente o porquê.
WATCHLIST = {
    "refresh-historico-cards-com-oc21":
        "mantém historico_ssw fresco dos cards oc=13 E oc=21 — base do agente oc13 (ATIVO) e da aba PRIORIDADES AI. NÃO é do indicador oc21→oc14.",
    "dias_uteis_entre": "função usada por views de prioridades-ai + oc13.",
    "v_oc21_paradas_prioridades": "lida por sync-kanban-status-prioridades (prioridades-ai).",
    "v_oc13_paradas": "view do fluxo oc13.",
    "ssw-internal-client": "cliente SSW compartilhado por ~21 edge functions.",
    "lancar-ssw-portal": "envelope de lançamento SSW (idempotência + guard tripé).",
    "validar-tripe-ssw": "guard tripé CTRC/NF/Localização inviolável.",
    "brt.ts": "fonte única de horário de Brasília.",
    "bastao-rules": "lookup dinâmico de ocorrências de relacionamento (cold start).",
}

DESTRUTIVO = re.compile(
    r"\bDROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|TYPE|INDEX|TRIGGER|SCHEMA|POLICY)\b"
    r"|\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b"
    r"|\bTRUNCATE\b"
    r"|\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)"
    r"|cron\.unschedule"
    r"|supabase\s+functions\s+delete"
    r"|\bgit\s+rm\b",
    re.IGNORECASE,
)


def read_sql_files(cmd):
    blobs = []
    for m in re.finditer(r"-f\s+(\"?)([^\s\"']+\.sql)\1", cmd):
        p = m.group(2)
        path = p if os.path.isabs(p) else os.path.join(PROJ, p)
        try:
            blobs.append(open(path, encoding="utf-8", errors="replace").read())
        except Exception:
            pass
    return blobs


def extract_targets(text):
    names = set()
    for m in re.finditer(
        r"DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|TYPE|INDEX|TRIGGER|POLICY)\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)",
        text, re.IGNORECASE):
        names.add(m.group(1))
    for m in re.finditer(r"supabase\s+functions\s+delete\s+([a-zA-Z0-9_-]+)", text):
        names.add(m.group(1))
    for m in re.finditer(r"cron\.unschedule\(\s*'([^']+)'", text):
        names.add(m.group(1))
    for m in re.finditer(r"\bgit\s+rm\b\s+((?:-[a-zA-Z]+\s+)*)(.+)", text):
        for tok in m.group(2).split():
            base = os.path.basename(tok.rstrip("/"))
            if base and not base.startswith("-"):
                names.add(base)
    return {n for n in names if n}


def blast_radius(name):
    alvos = [os.path.join(PROJ, d) for d in ("supabase", "lib", "migration") if os.path.isdir(os.path.join(PROJ, d))]
    if not alvos:
        return []
    try:
        out = subprocess.run(
            ["grep", "-rIl", "--exclude-dir=.git", "--exclude-dir=node_modules", name, *alvos],
            capture_output=True, text=True, timeout=4).stdout.strip().splitlines()
        return [os.path.relpath(x, PROJ) for x in out][:15]
    except Exception:
        return []


def emit(decision, reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }}))


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("{}"); return
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd:
        print("{}"); return

    texto = cmd + "\n" + "\n".join(read_sql_files(cmd))
    if not DESTRUTIVO.search(texto):
        print("{}"); return

    # Alvos REAIS da operação destrutiva (não menções em comentário). Watchlist é
    # avaliada só contra os alvos — senão um comentário "NÃO TOCAR: refresh-..."
    # numa migration legítima dispararia bloqueio falso.
    targets = sorted(extract_targets(texto))
    pool = targets if targets else [texto]  # extração falhou → fallback conservador
    hits = [(k, m) for k, m in WATCHLIST.items()
            if any(k.lower() in p.lower() for p in pool)]
    if hits:
        emit("deny",
             "BLOQUEADO — operação destrutiva mira INFRA COMPARTILHADA do Cockpit:\n"
             + "\n".join(f"  • {k}: {m}" for k, m in hits)
             + "\n\nO nome pode enganar. PARE e confirme com o Caio antes — provavelmente quebra outra feature. "
               "Se for realmente intencional, ele aprova manualmente / edita a WATCHLIST do hook.")
        return

    linhas = []
    for t in targets:
        refs = blast_radius(t)
        if refs:
            linhas.append(f"  • {t}: referenciado em → {', '.join(refs)}")
        else:
            linhas.append(f"  • {t}: SEM referência textual no repo — CUIDADO: acoplamento por DADO? "
                          f"(quem LÊ/ESCREVE as tabelas que isso alimenta? pg_cron?)")
    emit("ask",
         "OPERAÇÃO DESTRUTIVA — protocolo blast-radius (Cockpit v2):\n"
         + ("\n".join(linhas) if linhas else "  (alvo não identificado automaticamente — verifique manualmente)")
         + "\n\nAntes de aprovar, confirme: (a) quem LÊ/ESCREVE as tabelas que isso alimenta "
           "(acoplamento por DADO, não só por referência); (b) pg_cron; (c) o NOME bate com o que a coisa faz?; "
           "(d) dá pra DESLIGAR (reversível) em vez de apagar?")


if __name__ == "__main__":
    main()
