#!/usr/bin/env python3
"""
import_chaves_cte.py — Envia CSV do OPC 455 (SSW) pra Edge Function do Cockpit.

Uso:
    # Modo arquivo único:
    python3 import_chaves_cte.py /caminho/relatorio_455.csv

    # Modo pasta (importa todos os .csv da pasta):
    python3 import_chaves_cte.py /caminho/pasta/

Requisitos:
    pip install requests

Variáveis de ambiente:
    SUPABASE_URL              (default: https://xjbycvscljqoqpjkmevb.supabase.co)
    SUPABASE_SERVICE_KEY      (obrigatória — chave service_role)

Comportamento:
- Aceita CSV cru do SSW (cabeçalho original, com "†", data BR — tudo tratado no servidor)
- Faz POST com retry exponencial em erros de rede (3 tentativas)
- Quebra automaticamente em batches se arquivo > 5000 linhas
- Logs estruturados (JSON) — fácil de parsear num collector tipo Datadog/CloudWatch
- Exit code 0 em sucesso, 1 em falha total, 2 em sucesso parcial

Saída exemplo:
    {"event": "import_summary", "file": "relatorio_455.csv", "received": 10000,
     "inserted": 234, "skipped_invalid": 0, "errors": 0, "duration_ms": 4500,
     "status": "ok"}
"""

import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from typing import Optional

import requests


# =============================================================================
# Configuração
# =============================================================================

DEFAULT_URL = "https://xjbycvscljqoqpjkmevb.supabase.co"
ENDPOINT = "/functions/v1/import-chaves-cte"

MAX_LINES_PER_BATCH = 1000   # Edge Function tem limite de CPU/memória — chunks pequenos
                             # processam em ~2s e ficam com folga.
PARALLEL_WORKERS = int(os.environ.get("IMPORT_PARALLEL_WORKERS", "5"))
                             # Paralelismo de batches HTTP. Default 5.
                             # Em carga inicial massiva (180 dias / 670k linhas),
                             # subir pra 10 acelera mas pode bater rate limit.
TIMEOUT_SECONDS = 120
MAX_RETRIES = 3
RETRY_BACKOFF_BASE_SECONDS = 2  # 2s, 4s, 8s


# =============================================================================
# Logging estruturado (JSON)
# =============================================================================

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "event": record.msg if isinstance(record.msg, str) else "log",
        }
        if isinstance(record.args, dict):
            payload.update(record.args)
        return json.dumps(payload, ensure_ascii=False)


def get_logger() -> logging.Logger:
    logger = logging.getLogger("import_chaves_cte")
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logger.handlers = [handler]
    return logger


log = get_logger()


# =============================================================================
# Lógica
# =============================================================================

def split_csv_into_batches(csv_text: str, max_lines: int) -> list[str]:
    """Quebra CSV em batches preservando o cabeçalho em cada um."""
    lines = csv_text.splitlines()
    if not lines:
        return []
    header = lines[0]
    data_lines = lines[1:]

    if len(data_lines) <= max_lines:
        return [csv_text]

    batches = []
    for i in range(0, len(data_lines), max_lines):
        batch_lines = [header] + data_lines[i : i + max_lines]
        batches.append("\n".join(batch_lines))
    return batches


def post_csv_with_retry(
    url: str, headers: dict, body: bytes, max_retries: int = MAX_RETRIES
) -> requests.Response:
    """POST com backoff exponencial em erros de rede ou 5xx."""
    last_exc: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            res = requests.post(url, headers=headers, data=body, timeout=TIMEOUT_SECONDS)
            if res.status_code < 500:
                return res
            last_exc = Exception(f"server {res.status_code}: {res.text[:200]}")
        except requests.exceptions.RequestException as e:
            last_exc = e

        wait = RETRY_BACKOFF_BASE_SECONDS * (2**attempt)
        log.warning(
            "retry_post",
            {"attempt": attempt + 1, "wait_seconds": wait, "error": str(last_exc)},
        )
        time.sleep(wait)

    raise RuntimeError(f"POST falhou após {max_retries} tentativas: {last_exc}")


def _process_one_batch(
    batch_idx: int,
    total_batches: int,
    file_name: str,
    batch: str,
    url: str,
    headers: dict,
    log_lock: Lock,
) -> dict:
    """Processa 1 batch isolado. Chamada por ThreadPoolExecutor."""
    with log_lock:
        log.info(
            "batch_start",
            {
                "file": file_name,
                "batch": batch_idx + 1,
                "of": total_batches,
                "size_bytes": len(batch),
            },
        )

    result = {"received": 0, "inserted": 0, "skipped_invalid": 0, "errors": 0}

    try:
        res = post_csv_with_retry(url, headers, batch.encode("utf-8"))
    except Exception as e:
        with log_lock:
            log.error(
                "batch_failed_network",
                {"file": file_name, "batch": batch_idx + 1, "error": str(e)},
            )
        result["errors"] = 1
        return result

    if not res.ok:
        with log_lock:
            log.error(
                "batch_failed",
                {
                    "file": file_name,
                    "batch": batch_idx + 1,
                    "status": res.status_code,
                    "body": res.text[:500],
                },
            )
        result["errors"] = 1
        return result

    try:
        summary = res.json()
    except ValueError:
        with log_lock:
            log.error(
                "invalid_response",
                {"file": file_name, "batch": batch_idx + 1, "body": res.text[:200]},
            )
        result["errors"] = 1
        return result

    result["received"] = summary.get("received", 0)
    result["inserted"] = summary.get("inserted", 0)
    result["skipped_invalid"] = summary.get("skipped_invalid", 0)
    result["errors"] = len(summary.get("errors", []))

    with log_lock:
        log.info("batch_done", {"file": file_name, "batch": batch_idx + 1, **summary})

    return result


def import_file(file_path: Path, supabase_url: str, service_key: str) -> dict:
    """Importa um arquivo CSV em paralelo. Retorna sumário consolidado."""
    started = time.time()
    csv_text = file_path.read_text(encoding="utf-8", errors="replace")
    batches = split_csv_into_batches(csv_text, MAX_LINES_PER_BATCH)

    total = {
        "file": str(file_path.name),
        "received": 0,
        "inserted": 0,
        "skipped_invalid": 0,
        "errors": 0,
        "batches": len(batches),
        "parallel_workers": PARALLEL_WORKERS,
    }

    headers = {
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "text/csv",
    }
    url = f"{supabase_url.rstrip('/')}{ENDPOINT}"

    log_lock = Lock()

    log.info(
        "file_start",
        {
            "file": file_path.name,
            "total_batches": len(batches),
            "parallel_workers": PARALLEL_WORKERS,
        },
    )

    with ThreadPoolExecutor(max_workers=PARALLEL_WORKERS) as ex:
        futures = [
            ex.submit(
                _process_one_batch,
                i,
                len(batches),
                file_path.name,
                batch,
                url,
                headers,
                log_lock,
            )
            for i, batch in enumerate(batches)
        ]

        for fut in as_completed(futures):
            r = fut.result()
            total["received"] += r["received"]
            total["inserted"] += r["inserted"]
            total["skipped_invalid"] += r["skipped_invalid"]
            total["errors"] += r["errors"]

    total["duration_ms"] = int((time.time() - started) * 1000)
    total["status"] = "ok" if total["errors"] == 0 else "partial"
    return total


def find_csv_files(target: Path) -> list[Path]:
    if target.is_file():
        return [target]
    if target.is_dir():
        return sorted(target.glob("*.csv"))
    raise FileNotFoundError(f"Caminho não existe: {target}")


# =============================================================================
# Entry point
# =============================================================================

def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    target = Path(sys.argv[1]).expanduser().resolve()
    supabase_url = os.environ.get("SUPABASE_URL", DEFAULT_URL)
    service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")

    if not service_key:
        log.error("config_error", {"message": "SUPABASE_SERVICE_KEY não configurada"})
        return 1

    files = find_csv_files(target)
    if not files:
        log.error("no_files", {"path": str(target)})
        return 1

    log.info("run_start", {"path": str(target), "files": len(files)})

    overall_errors = 0
    for f in files:
        try:
            summary = import_file(f, supabase_url, service_key)
            log.info("import_summary", summary)
            if summary["status"] != "ok":
                overall_errors += 1
        except Exception as e:
            log.error("import_failed", {"file": f.name, "error": str(e)})
            overall_errors += 1

    if overall_errors == 0:
        return 0
    return 2 if overall_errors < len(files) else 1


if __name__ == "__main__":
    sys.exit(main())
