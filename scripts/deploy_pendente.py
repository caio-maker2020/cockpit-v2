#!/usr/bin/env python3
"""
deploy_pendente.py — diz QUAIS edge functions estão com o código de produção
ATRÁS do git, incluindo as que só mudaram por causa de um `_shared/` importado.

Por que existe (2026-09-02): a Fase 7 do /verify-cockpit listava "as 5 funções
mais recentes" (e ainda quebrava: `updated_at` da API é epoch em ms, o script
fazia `[:19]` numa int). Ninguém calculava o fecho transitivo dos imports. Caso
real: `_shared/propostas-pos-resposta-cliente.ts` mudou em 01/09 (filtro da 44
sem CT-e) e só `executor` + `gmail-poll-inbox` foram deployados; `vinculador`,
`scan-email-pre-card` e `cron-ia-resposta-pendentes` importam o módulo e
ficaram com o bundle antigo em produção sem ninguém perceber.

Regra: pra cada função, o conjunto de fontes = arquivos da pasta dela + todos
os `_shared/*.ts` alcançáveis por import (transitivo). Se o último commit que
tocou esse conjunto é mais novo que o `updated_at` da função na Management
API, a função está PENDENTE de deploy. Conservador de propósito: mudança só de
comentário também acusa — melhor um redeploy a mais que um bundle velho.

Uso:
    python3 scripts/deploy_pendente.py            # tabela + exit 1 se houver pendente
    python3 scripts/deploy_pendente.py --json
    python3 scripts/deploy_pendente.py --so-pendentes
    python3 scripts/deploy_pendente.py --comando  # imprime o `supabase functions deploy ...` pronto

Requer SUPABASE_ACCESS_TOKEN (ambiente ou .env.local — mesma busca do dbq.py).
Só usa biblioteca padrão. Funciona em macOS/Linux/Windows.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dbq import carregar_env_local, project_ref  # noqa: E402

RE_IMPORT = re.compile(r"""(?:from|import)\s+["']([^"']+\.ts)["']""")


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60).stdout.strip()


def raiz_repo() -> Path:
    top = git("rev-parse", "--show-toplevel", cwd=Path.cwd())
    return Path(top) if top else Path(__file__).resolve().parent.parent


def imports_de(arquivo: Path) -> set[Path]:
    try:
        texto = arquivo.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return set()
    out: set[Path] = set()
    for m in RE_IMPORT.finditer(texto):
        alvo = m.group(1)
        if alvo.startswith("http") or alvo.startswith("npm:") or alvo.startswith("jsr:"):
            continue
        cand = (arquivo.parent / alvo).resolve()
        if cand.is_file():
            out.add(cand)
    return out


def fontes_da_funcao(pasta: Path) -> set[Path]:
    fontes: set[Path] = set()
    fila: list[Path] = []
    for p in pasta.rglob("*"):
        if p.is_file():
            fontes.add(p.resolve())
            if p.suffix == ".ts":
                fila.append(p.resolve())
    while fila:
        f = fila.pop()
        for dep in imports_de(f):
            if dep not in fontes:
                fontes.add(dep)
                fila.append(dep)
    return fontes


def ultimo_commit(repo: Path, fontes: set[Path]) -> tuple[int, str, str]:
    rel = [str(f.relative_to(repo)) for f in sorted(fontes) if repo in f.parents]
    if not rel:
        return 0, "", ""
    out = git("log", "-1", "--format=%ct|%h|%s", "--", *rel, cwd=repo)
    if not out:
        return 0, "", ""
    ts, h, s = out.split("|", 2)
    return int(ts), h, s


def funcoes_deployadas() -> dict[str, dict]:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        raise SystemExit("deploy_pendente: SUPABASE_ACCESS_TOKEN ausente (ambiente ou .env.local).")
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{project_ref()}/functions",
        headers={"Authorization": f"Bearer {token}", "User-Agent": "cockpit-deploy-pendente/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            dados = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"deploy_pendente: Management API HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
    if not isinstance(dados, list):
        raise SystemExit(f"deploy_pendente: resposta inesperada da API: {str(dados)[:200]}")
    return {f["slug"]: f for f in dados}


def fmt(ts_s: float) -> str:
    return dt.datetime.fromtimestamp(ts_s, dt.timezone.utc).strftime("%Y-%m-%d %H:%MZ")


def main(argv: list[str]) -> int:
    como_json = "--json" in argv
    so_pend = "--so-pendentes" in argv
    comando = "--comando" in argv
    repo = raiz_repo()
    carregar_env_local()
    manifest_path = repo / ".claude" / "deploy-guards.json"
    proibidas: set[str] = set()
    try:
        man = json.load(open(manifest_path, encoding="utf-8"))
        proibidas = {k for k in (man.get("funcoes_proibidas") or {}) if not k.startswith("_")}
    except Exception:
        pass

    deployadas = funcoes_deployadas()
    base = repo / "supabase" / "functions"
    linhas: list[dict] = []
    for pasta in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith("_")):
        if not (pasta / "index.ts").is_file():
            continue
        slug = pasta.name
        if slug in proibidas:
            continue
        ts, h, msg = ultimo_commit(repo, fontes_da_funcao(pasta))
        info = deployadas.get(slug)
        if info is None:
            status = "NUNCA_DEPLOYADA"
            dep_ts = 0
            versao = None
        else:
            dep_ts = int(info.get("updated_at", 0)) / 1000.0
            versao = info.get("version")
            status = "PENDENTE" if ts > dep_ts else "OK"
        linhas.append({
            "funcao": slug, "status": status, "versao_prod": versao,
            "deploy_em": fmt(dep_ts) if dep_ts else None,
            "ultimo_commit": h, "commit_em": fmt(ts) if ts else None, "commit_msg": msg[:70],
        })

    pendentes = [l for l in linhas if l["status"] == "PENDENTE"]
    if como_json:
        print(json.dumps({"pendentes": pendentes, "todas": linhas}, ensure_ascii=False, indent=2))
    elif comando:
        if pendentes:
            print("supabase functions deploy " + " ".join(l["funcao"] for l in pendentes)
                  + f" --project-ref {project_ref()}")
        else:
            print("# nada pendente")
    else:
        mostrar = pendentes if so_pend else linhas
        print(f"{'FUNÇÃO':40s} {'STATUS':16s} {'PROD':>6s}  {'DEPLOY EM':17s}  {'ÚLTIMO COMMIT':17s}  COMMIT")
        for l in mostrar:
            print(f"{l['funcao']:40s} {l['status']:16s} {('v'+str(l['versao_prod'])) if l['versao_prod'] else '-':>6s}  "
                  f"{l['deploy_em'] or '-':17s}  {l['commit_em'] or '-':17s}  {l['ultimo_commit']} {l['commit_msg']}")
        print()
        if pendentes:
            print(f"⚠️  {len(pendentes)} função(ões) com produção ATRÁS do git: "
                  + ", ".join(l["funcao"] for l in pendentes))
            print("   Deploy (do master atualizado e commitado — o deploy-gate confere):")
            print("   supabase functions deploy " + " ".join(l["funcao"] for l in pendentes)
                  + f" --project-ref {project_ref()}")
        else:
            print("✅ nenhuma função pendente de deploy.")
    return 1 if pendentes else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
