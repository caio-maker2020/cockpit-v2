#!/usr/bin/env python3
import json, os, time, ssl, urllib.request, urllib.error

BASE = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EP = f"{BASE}/functions/v1/alterar-especie-cliente-lote"
HERE = os.path.dirname(os.path.abspath(__file__))

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    CTX = ssl._create_unverified_context()  # nosso próprio endpoint, bearer-auth

def call(payload, timeout=150):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(EP, data=data, method="POST", headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.loads(r.read().decode())

uniq = json.load(open(f"{HERE}/curva_f_unicos.json"))
nome = {u["cnpj"]: u["cliente"] for u in uniq}
all_cnpjs = [u["cnpj"] for u in uniq]

def drive(mode):
    pend = list(all_cnpjs)
    acc = []
    rounds = 0
    while pend:
        rounds += 1
        res = call({"cnpjs": pend, "codigos": ["043"], "mode": mode, "budgetMs": 110000})
        acc.extend(res["processados"])
        pend = res["pendentes"]
        print(f"[{mode}] round {rounds}: +{res['processados_count']} (resumo={res['resumo']}) pendentes={len(pend)} elapsed={res['elapsed_ms']}ms", flush=True)
        json.dump({"mode": mode, "acumulado": acc, "pendentes": pend},
                  open(f"{HERE}/curva_f_{mode}_progress.json", "w"), ensure_ascii=False)
    return acc

# FASE 1 — aplicar
ap = drive("aplicar")
ap_ok = [x for x in ap if x.get("ok")]
ap_fail = [x for x in ap if not x.get("ok")]
print(f"\n=== APLICAR: {len(ap_ok)} ok / {len(ap_fail)} falha de {len(ap)} ===", flush=True)

# FASE 2 — auditar (read-only, independente da gravação)
time.sleep(2)
au = drive("auditar")
au_conf = [x for x in au if x.get("conforme")]
au_nconf = [x for x in au if x.get("encontrado") and not x.get("conforme")]
au_nf = [x for x in au if not x.get("encontrado")]

report = {
    "total_unicos": len(all_cnpjs),
    "aplicar": {"ok": len(ap_ok), "falha": len(ap_fail),
                "falhas": [{"cnpj": x["cnpj"], "cliente": nome.get(x["cnpj"]), "erro": x.get("erro"), "depois": x.get("depois")} for x in ap_fail]},
    "auditoria": {"conforme": len(au_conf), "nao_conforme": len(au_nconf), "nao_encontrado": len(au_nf),
                  "nao_conforme_det": [{"cnpj": x["cnpj"], "cliente": nome.get(x["cnpj"]), "marcados": x.get("marcados")} for x in au_nconf],
                  "nao_encontrado_det": [{"cnpj": x["cnpj"], "cliente": nome.get(x["cnpj"])} for x in au_nf]},
}
json.dump(report, open(f"{HERE}/curva_f_REPORT.json", "w"), ensure_ascii=False, indent=2)
print("\n=== RELATÓRIO FINAL ===", flush=True)
print(json.dumps(report["aplicar"]["falhas"] and report or {k: (v if not isinstance(v, dict) else {kk: vv for kk, vv in v.items() if not kk.endswith("_det") and kk != "falhas"}) for k, v in report.items()}, ensure_ascii=False, indent=2), flush=True)
print("DONE", flush=True)
