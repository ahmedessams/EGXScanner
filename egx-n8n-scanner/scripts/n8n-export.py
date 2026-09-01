#!/usr/bin/env python3
"""Pulls every workflow from a live n8n instance back into workflows/*.json —
the "export" counterpart to render-n8n-setup.py (which only pushes).

Why: workflows get edited directly on the live instance (via the n8n UI or
MCP) and the repo silently drifts behind. Because render-n8n-setup.py PUTs
the repo's JSON verbatim, the next re-sync would revert those live edits.
Run this first, review `git diff workflows/`, and commit — then the repo is
the source of truth again.

Normalisation (so the output matches the committed shape and never leaks
instance-specific state):
  - `credentials` blocks are stripped from every node (docs/IMPORT-N8N.md,
    "Why credentials can't ship pre-wired").
  - Execute Workflow nodes get `workflowId.value` blanked (IDs are per-instance).
  - HTTP Request URLs that are a "CONFIGURE-..." placeholder in the repo stay
    that way (the real provider endpoint is a live-only patch by design —
    mirror of render-n8n-setup.py's preserve_manual_url_patches).
  - Top-level shape mirrors the existing files: active=false, pinData={},
    staticData=null, tags=[], and the file's existing workflow `id`, node
    `id`s and `webhookId`s are kept (n8n regenerates them on import — they
    are instance-local and would otherwise make every node look changed).
  - Refuses to write anything that looks like a literal secret.

Run via scripts/n8n-export.sh, which prompts for the API key with hidden
input. Stdlib only — no pip install needed.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS_DIR = REPO_ROOT / "workflows"

MIN_REQUEST_GAP_SECONDS = 1.5  # same edge-WAF burst avoidance as render-n8n-setup.py
_last_request_at = [0.0]

NODE_KEY_ORDER = ["name", "type", "typeVersion", "position", "parameters", "id"]
TOP_LEVEL_ORDER = ["name", "active", "nodes", "connections", "pinData", "settings", "staticData", "meta", "id", "tags"]

# Anything matching these in a string value aborts the export. Expression
# values ("={{ $env.X }}") are what the repo expects — literal keys are not.
SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"\b[A-Fa-f0-9]{40,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}"),  # JWT
]
SECRET_PARAM_NAMES = {"api_token", "x-api-key", "apikey", "api_key", "authorization", "token"}


def env(name):
    v = os.environ.get(name, "")
    if not v:
        print(f"Missing required env var: {name}", file=sys.stderr)
        sys.exit(1)
    return v


def _pace():
    elapsed = time.monotonic() - _last_request_at[0]
    remaining = MIN_REQUEST_GAP_SECONDS - elapsed
    if remaining > 0:
        time.sleep(remaining)
    _last_request_at[0] = time.monotonic()


def api(base_url, api_key, path, _retry=0):
    _pace()
    req = urllib.request.Request(base_url.rstrip("/") + "/api/v1" + path, method="GET")
    req.add_header("X-N8N-API-KEY", api_key)
    req.add_header("Accept", "application/json")
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        if e.code == 403 and "<html" in raw.lower() and _retry < 3:
            backoff = [8, 20, 45][_retry]
            print(f"  HTTP 403 (blocked, not from n8n) on GET {path} — backing off {backoff}s ({_retry + 1}/3)...", file=sys.stderr)
            time.sleep(backoff)
            return api(base_url, api_key, path, _retry=_retry + 1)
        print(f"  HTTP {e.code} on GET {path}: {raw[:500]}", file=sys.stderr)
        raise


def list_workflows(base_url, api_key):
    out, cursor = [], None
    while True:
        path = "/workflows?limit=250" + (f"&cursor={quote(cursor)}" if cursor else "")
        page = api(base_url, api_key, path)
        out.extend(page.get("data", []))
        cursor = page.get("nextCursor")
        if not cursor:
            return out


def load_repo_files():
    """name -> (path, json) for every committed workflow."""
    by_name = {}
    for path in sorted(WORKFLOWS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  WARNING: {path.name} is not valid JSON ({e}) — will be treated as new", file=sys.stderr)
            continue
        if isinstance(data, dict) and data.get("name"):
            by_name[data["name"]] = (path, data)
    return by_name


def slug_filename(name):
    """'18 - EGX Range Forecast' -> '18-egx-range-forecast.json'."""
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not s:
        raise ValueError(f"cannot derive a filename from workflow name {name!r}")
    return f"{s}.json"


def order_keys(obj, preferred, template=None):
    """Re-key `obj`: template's key order first (keeps diffs quiet on untouched
    nodes), then `preferred`, then anything else in original order."""
    seen, ordered = set(), {}
    for source in ((template or {}).keys(), preferred, obj.keys()):
        for k in source:
            if k in obj and k not in seen:
                ordered[k] = obj[k]
                seen.add(k)
    return ordered


def normalise_node(node, repo_node):
    n = {k: v for k, v in node.items() if k != "credentials"}
    params = n.get("parameters") or {}

    # Node ids / webhook ids are regenerated by n8n on every import and mean
    # nothing across instances (connections reference node NAMES). Keep the
    # committed ones so an unchanged node produces no diff.
    for instance_local_key in ("id", "webhookId"):
        if repo_node and instance_local_key in repo_node and instance_local_key in n:
            n[instance_local_key] = repo_node[instance_local_key]

    if n.get("type") == "n8n-nodes-base.executeWorkflow":
        wf_ref = params.get("workflowId")
        if isinstance(wf_ref, dict):
            wf_ref = dict(wf_ref)
            wf_ref["value"] = ""
            params = dict(params, workflowId=wf_ref)

    if n.get("type") == "n8n-nodes-base.httpRequest" and repo_node:
        repo_url = (repo_node.get("parameters") or {}).get("url", "")
        if isinstance(repo_url, str) and "CONFIGURE-" in repo_url:
            params = dict(params, url=repo_url)

    n["parameters"] = params
    return order_keys(n, NODE_KEY_ORDER, template=repo_node)


def normalise_workflow(live, repo_data):
    repo_nodes = {nd["name"]: nd for nd in (repo_data or {}).get("nodes", []) if isinstance(nd, dict)}
    nodes = [normalise_node(nd, repo_nodes.get(nd.get("name"))) for nd in live.get("nodes", [])]

    settings = dict(live.get("settings") or {})
    out = {
        "name": live["name"],
        "active": False,
        "nodes": nodes,
        "connections": live.get("connections") or {},
        "pinData": {},
        "settings": settings,
        "staticData": None,
        "meta": {"templateCredsSetupCompleted": False},
        "id": (repo_data or {}).get("id") or live.get("id"),
        "tags": [],
    }
    return order_keys(out, TOP_LEVEL_ORDER, template=repo_data)


def find_secrets(obj, path="$"):
    """Yields (path, snippet) for any string that looks like a literal secret."""
    if isinstance(obj, dict):
        name = str(obj.get("name", "")).lower()
        value = obj.get("value")
        if name in SECRET_PARAM_NAMES and isinstance(value, str) and value and not value.startswith("={{"):
            yield (f"{path}.value", f"literal value for parameter {name!r}")
        for k, v in obj.items():
            yield from find_secrets(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from find_secrets(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        for pat in SECRET_PATTERNS:
            m = pat.search(obj)
            if m:
                yield (path, f"matches {pat.pattern!r}")
                break


def dump(data):
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def main():
    base_url = env("N8N_BASE_URL")
    api_key = env("N8N_API_KEY")
    WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)

    repo = load_repo_files()
    print(f"== Listing workflows on {base_url} ==")
    summaries = [w for w in list_workflows(base_url, api_key) if not w.get("isArchived")]
    print(f"  {len(summaries)} live workflow(s), {len(repo)} committed file(s)")
    print()

    created, updated, unchanged, blocked = [], [], [], []
    print("== Exporting ==")
    for summary in sorted(summaries, key=lambda w: w.get("name", "")):
        name = summary.get("name")
        if not name:
            continue
        live = api(base_url, api_key, f"/workflows/{summary['id']}")
        path, repo_data = repo.get(name, (WORKFLOWS_DIR / slug_filename(name), None))
        normalised = normalise_workflow(live, repo_data)

        leaks = list(find_secrets(normalised))
        if leaks:
            blocked.append(name)
            print(f"  {path.name}: REFUSED — possible literal secret(s):")
            for where, why in leaks[:5]:
                print(f"      {where}: {why}")
            continue

        text = dump(normalised)
        if path.exists() and path.read_text(encoding="utf-8") == text:
            unchanged.append(path.name)
            print(f"  {path.name}: unchanged")
            continue
        path.write_text(text, encoding="utf-8")
        (updated if repo_data else created).append(path.name)
        print(f"  {path.name}: {'updated' if repo_data else 'CREATED'} ({len(normalised['nodes'])} nodes)")

    live_names = {w.get("name") for w in summaries}
    orphans = sorted(p.name for n, (p, _) in repo.items() if n not in live_names)

    print()
    print("== Done ==")
    print(f"  created:   {len(created)}  {' '.join(created)}")
    print(f"  updated:   {len(updated)}  {' '.join(updated)}")
    print(f"  unchanged: {len(unchanged)}")
    if orphans:
        print(f"  in repo but not live (left untouched): {' '.join(orphans)}")
    if blocked:
        print(f"  REFUSED (secret check): {' '.join(blocked)} — fix the live node to use $env and re-run")
    print()
    print("Review with `git diff --stat workflows/`, then commit. New files need")
    print("adding to PUBLISH_ORDER in scripts/render-n8n-setup.py before they")
    print("will be pushed by a future re-sync.")
    sys.exit(1 if blocked else 0)


if __name__ == "__main__":
    main()
