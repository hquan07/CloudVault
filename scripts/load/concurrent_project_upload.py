#!/usr/bin/env python3
"""Concurrent project-upload smoke test using only the Python standard library."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Result:
    index: int
    status: int
    duration: float
    file_id: str | None
    error: str | None


def multipart_body(fields: dict[str, str], filename: str, payload: bytes) -> tuple[bytes, str]:
    boundary = f"----cloudvault-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode(),
            b"\r\n",
        ])
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        payload,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    return b"".join(chunks), boundary


def upload(args: argparse.Namespace, run_id: str, index: int) -> Result:
    seed = f"{run_id}:{index}:".encode()
    repeats = (args.bytes + len(seed) - 1) // len(seed)
    payload = (seed * repeats)[: args.bytes]
    checksum = hashlib.sha256(payload).hexdigest()
    metadata = {
        "artifact_type": args.artifact_type,
        "logical_date": date.today().isoformat(),
        "source_run_id": run_id,
        "retention_class": args.retention_class,
        "checksum_sha256": checksum,
        "load_test_index": index,
    }
    body, boundary = multipart_body(
        {"metadata_json": json.dumps(metadata, separators=(",", ":"))},
        f"phase3-{run_id}-{index}.bin",
        payload,
    )
    request = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/api/v1/projects/{args.project}/files/upload",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {args.token}",
            "Idempotency-Key": f"phase3:{run_id}:{index}:{checksum}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except Exception as exc:  # Network errors are part of the smoke-test result.
        return Result(index, 0, time.perf_counter() - started, None, str(exc))

    duration = time.perf_counter() - started
    try:
        parsed = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        parsed = {}
    file_id = parsed.get("file_id") or parsed.get("id")
    error = None if 200 <= status < 300 else json.dumps(parsed, ensure_ascii=False)[:500]
    return Result(index, status, duration, file_id, error)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost")
    parser.add_argument("--project", required=True, help="Project UUID or slug")
    parser.add_argument("--token", default=os.getenv("CLOUDVAULT_PROJECT_TOKEN"))
    parser.add_argument("--requests", type=int, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--bytes", type=int, default=64 * 1024)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--artifact-type", default="load-test")
    parser.add_argument("--retention-class", default="temporary")
    parser.add_argument(
        "--allow-quota-rejections",
        action="store_true",
        help="Treat HTTP 413 as an expected result while testing a near-full quota",
    )
    args = parser.parse_args()
    if not args.token:
        parser.error("--token or CLOUDVAULT_PROJECT_TOKEN is required")
    if min(args.requests, args.workers, args.bytes) < 1:
        parser.error("--requests, --workers and --bytes must be positive")
    return args


def main() -> int:
    args = parse_args()
    run_id = uuid.uuid4().hex[:12]
    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda index: upload(args, run_id, index), range(args.requests)))
    elapsed = time.perf_counter() - started

    statuses = Counter(result.status for result in results)
    successes = [result for result in results if 200 <= result.status < 300]
    file_ids = [result.file_id for result in successes if result.file_id]
    accepted = {status for status in statuses if 200 <= status < 300}
    if args.allow_quota_rejections:
        accepted.add(413)
    unexpected = [result for result in results if result.status not in accepted]
    duplicate_ids = len(file_ids) != len(set(file_ids))

    latencies = [result.duration for result in results]
    print(f"run_id={run_id}")
    print(f"requests={len(results)} workers={args.workers} elapsed={elapsed:.3f}s rps={len(results) / elapsed:.2f}")
    print("statuses=" + ", ".join(f"{status}:{count}" for status, count in sorted(statuses.items())))
    print(
        "latency_seconds="
        f"mean:{statistics.fmean(latencies):.3f} "
        f"p50:{percentile(latencies, 0.50):.3f} "
        f"p95:{percentile(latencies, 0.95):.3f} "
        f"max:{max(latencies):.3f}"
    )
    print(f"successful_file_ids={len(file_ids)} duplicate_file_ids={duplicate_ids}")

    for result in unexpected[:10]:
        print(f"request={result.index} status={result.status} error={result.error}", file=sys.stderr)
    if duplicate_ids:
        print("Duplicate file IDs were returned for unique idempotency keys.", file=sys.stderr)
    return 1 if unexpected or duplicate_ids or len(file_ids) != len(successes) else 0


if __name__ == "__main__":
    raise SystemExit(main())
