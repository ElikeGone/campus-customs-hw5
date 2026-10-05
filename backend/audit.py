"""Append-only audit trail for the agent loop: output/audit_trail.json.

Each event is one JSON object in a single top-level array. Existing events are never
removed or rewritten. New events are added to the end, and the file is replaced
atomically so a crash can't leave it half-written. Only short, non-sensitive summaries
are stored: no model reasoning, prompts, API keys or headers.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AUDIT_PATH = Path(__file__).resolve().parent.parent / "output" / "audit_trail.json"
MAX_FIELD_CHARS = 300

_lock = threading.Lock()


def _short(value: Any) -> Any:
    """Shorten long values so the trail stays readable and doesn't copy whole tool outputs."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = value if isinstance(value, str) else json.dumps(value, default=str, separators=(",", ":"))
    return text if len(text) <= MAX_FIELD_CHARS else text[: MAX_FIELD_CHARS - 3] + "..."


def record(
    event: str,
    *,
    run_id: str,
    agent: str | None = None,
    ticket_id: int | None = None,
    action: str | None = None,
    inputs: Any = None,
    result: Any = None,
    outcome: str | None = None,
    **extra: Any,
) -> None:
    """Append one audit event to the trail."""
    entry = {
        "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "run_id": run_id,
        "event": event,
        "agent": agent,
        "ticket_id": ticket_id,
        "action": action,
        "inputs": _short(inputs),
        "result": _short(result),
        "outcome": outcome,
        **{k: _short(v) for k, v in extra.items()},
    }
    with _lock:
        AUDIT_PATH.parent.mkdir(exist_ok=True)
        events: list = []
        if AUDIT_PATH.exists() and AUDIT_PATH.stat().st_size:
            events = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))
            if not isinstance(events, list):
                raise ValueError(f"{AUDIT_PATH} is not a JSON array; refusing to overwrite it.")
        events.append(entry)
        tmp = AUDIT_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(events, indent=2), encoding="utf-8")
        os.replace(tmp, AUDIT_PATH)
