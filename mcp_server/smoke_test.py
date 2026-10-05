"""Smoke test: call each MCP tool through a real MCP stdio connection, using the
server entry in .mcp.json, check the results against the working database,
and save the evidence to output/mcp_smoke.json.

Run from the project root:  .venv/Scripts/python mcp_server/smoke_test.py
"""
import asyncio
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastmcp import Client

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "campus_customs_new.db"
OUT_PATH = ROOT / "output" / "mcp_smoke.json"

USER_PROMPT = (
    "Now that the MCP server is connected, test each of the three MCP tools by actually "
    "calling them through the MCP connection, not by directly calling the Python functions.\n\n"
    "Use sensible test inputs based on the three open tickets. For each tool, save the prompt "
    "I asked you, the exact tool name, and the tool output in output/mcp_smoke.json.\n\n"
    "Verify every returned value against data/campus_customs_new.db before saving the evidence. "
    "The values in mcp_smoke.json must match the working database. Don't invent or manually "
    "substitute tool outputs if an MCP call fails; report the failure and fix the connection instead.\n\n"
    "Keep the evidence clear enough that a grader can see that all three tools were successfully "
    "called through MCP. Update the Problem 4 follow-up in AI_prompts.md with this prompt and one "
    "sentence explaining that the first prompt connected the server but had not yet produced the "
    "required smoke-test evidence."
)

CALLS = [
    ("check_stock_and_price", {"sku": "CC-TEE-WHITE", "size": "S"}, "101"),
    ("check_stock_and_price", {"sku": "CC-HOOD-NAVY", "size": "M"}, "103"),
    ("get_invoice_details", {"invoice_id": 501}, "101"),
    ("get_lease_and_cash", {"lease_id": 1}, "102"),
]


def expected(conn, tool, args):
    """Build the expected output from the database with separate queries, not the server code."""
    q = lambda sql, p=(): [dict(r) for r in conn.execute(sql, p).fetchall()]
    today = q("SELECT date_today FROM desk")[0]["date_today"]
    if tool == "check_stock_and_price":
        req = q("SELECT sku, name, size, qty, location FROM inventory WHERE sku=? AND size=?",
                (args["sku"], args["size"]))
        return {
            "found": bool(req),
            "requested": req[0] if req else None,
            "all_sizes": q("SELECT size, qty, location FROM inventory WHERE sku=?", (args["sku"],)),
            "pricing": q("SELECT unit_cost, list_price FROM pricing WHERE sku=?", (args["sku"],))[0],
        }
    if tool == "get_invoice_details":
        inv = q("SELECT * FROM invoices WHERE id=?", (args["invoice_id"],))[0]
        return {
            "found": True,
            "invoice": inv,
            "vendor": q("SELECT * FROM vendors WHERE id=?", (inv["vendor_id"],))[0],
            "payments": q("SELECT * FROM payments WHERE ref_id=?", (args["invoice_id"],)),
            "today": today,
            "overdue": inv["status"] == "open" and inv["due_date"] < today,
        }
    if tool == "get_lease_and_cash":
        return {
            "found": True,
            "lease": q("SELECT * FROM leases WHERE id=?", (args["lease_id"],))[0],
            "cash_accounts": q("SELECT * FROM cash_accounts"),
            "payments": q("SELECT * FROM payments WHERE ref_id=?", (args["lease_id"],)),
            "today": today,
        }
    raise ValueError(tool)


def sort_lists(obj):
    if isinstance(obj, dict):
        return {k: sort_lists(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return sorted((sort_lists(v) for v in obj), key=lambda v: json.dumps(v, sort_keys=True))
    return obj


async def main() -> int:
    config = json.loads((ROOT / ".mcp.json").read_text())
    conn = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    results, all_ok = [], True
    async with Client(config) as client:
        listed = sorted(t.name for t in await client.list_tools())
        for tool, args, ticket in CALLS:
            entry = {"ticket": ticket, "tool": tool, "arguments": args}
            try:
                res = await client.call_tool(tool, args)
                output = res.structured_content
                entry["mcp_call_succeeded"] = not res.is_error
                entry["output"] = output
                match = sort_lists(output) == sort_lists(expected(conn, tool, args))
            except Exception as exc:  # report the failure; never substitute an output
                entry["mcp_call_succeeded"] = False
                entry["error"] = repr(exc)
                match = False
            entry["matches_database"] = match
            all_ok &= match and entry["mcp_call_succeeded"]
            results.append(entry)
    conn.close()

    evidence = {
        "prompt": USER_PROMPT,
        "transport": "MCP stdio, using the campus-customs server from .mcp.json",
        "server_command": config["mcpServers"]["campus-customs"],
        "database": "data/campus_customs_new.db",
        "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tools_listed_by_server": listed,
        "calls": results,
        "all_calls_succeeded_and_match_database": all_ok,
    }
    OUT_PATH.parent.mkdir(exist_ok=True)
    OUT_PATH.write_text(json.dumps(evidence, indent=2))
    print(json.dumps({"listed": listed, "all_ok": all_ok,
                      "per_call": [(r["tool"], r["mcp_call_succeeded"], r["matches_database"]) for r in results]}))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
