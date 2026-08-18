#!/usr/bin/env python3
"""Urgent one-off fix: patches workflows 01/02/03's HTTP Request node URLs
directly to the real EODHD endpoints, in case they got reverted to the
generator's unconfigured "CONFIGURE-..." placeholder by a render-n8n-setup.py
run from BEFORE it started preserving manually-patched URLs (see that
script's preserve_manual_url_patches — this is the bug that caused it).

Confirmed via live E2E testing: this exact regression silently broke daily
data ingestion (every EODHD request returned "route ... could not be found"
since the URL literally contained the placeholder text) — fixing these 3
URLs restored data flow immediately (236/241 stocks got real data on the
next run).

Run via scripts/fix-endpoint-urls.sh, which prompts for inputs (keeps the
API key out of shell history). Stdlib only.
"""
import json
import os
import sys
import urllib.error
import urllib.request

# Verified against the real EODHD API (https://eodhd.com/api) — these match
# their documented "Get List of Tickers" and "EOD Historical Data" endpoints.
FIXES = {
    "01 - EGX Stock Universe": {
        "Fetch EGX Universe (CONFIGURE ENDPOINT)":
            "={{ $env.MARKET_API_BASE_URL }}/exchange-symbol-list/{{ $env.EGX_EXCHANGE_CODE }}",
    },
    "02 - EGX Historical Import": {
        "Fetch Historical OHLCV (CONFIGURE ENDPOINT)":
            "={{ $env.MARKET_API_BASE_URL }}/eod/{{ $json.symbol }}.{{ $env.EGX_EXCHANGE_CODE }}",
    },
    "03 - EGX Daily Market Update": {
        "Fetch Recent OHLCV (CONFIGURE ENDPOINT)":
            "={{ $env.MARKET_API_BASE_URL }}/eod/{{ $json.symbol }}.{{ $env.EGX_EXCHANGE_CODE }}",
    },
}


def env(name):
    v = os.environ.get(name, "")
    if not v:
        print(f"Missing required env var: {name}", file=sys.stderr)
        sys.exit(1)
    return v


def api(base_url, api_key, method, path, body=None):
    url = base_url.rstrip("/") + "/api/v1" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-N8N-API-KEY", api_key)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        print(f"  HTTP {e.code} on {method} {path}: {raw[:500]}", file=sys.stderr)
        raise


def find_workflow_id(base_url, api_key, name):
    from urllib.parse import quote
    result = api(base_url, api_key, "GET", f"/workflows?name={quote(name)}&limit=1")
    data = result.get("data", [])
    return data[0]["id"] if data else None


def main():
    base_url = env("N8N_BASE_URL")
    api_key = env("N8N_API_KEY")

    for wf_name, node_fixes in FIXES.items():
        print(f"== {wf_name} ==")
        wf_id = find_workflow_id(base_url, api_key, wf_name)
        if not wf_id:
            print(f"  NOT FOUND — skipping")
            continue
        full = api(base_url, api_key, "GET", f"/workflows/{wf_id}")
        changed = False
        for n in full["nodes"]:
            if n["name"] in node_fixes:
                old = n.get("parameters", {}).get("url")
                new = node_fixes[n["name"]]
                if old == new:
                    print(f"  '{n['name']}' already correct")
                    continue
                n["parameters"]["url"] = new
                changed = True
                print(f"  '{n['name']}': {old!r} -> {new!r}")
        if changed:
            api(base_url, api_key, "PUT", f"/workflows/{wf_id}?publishIfActive=true", {
                "name": full["name"], "nodes": full["nodes"],
                "connections": full["connections"], "settings": full.get("settings", {}),
            })
            print(f"  updated and republished")
        print()

    print("Done. Trigger 03 manually in the n8n UI (or wait for its next")
    print("scheduled retry) to confirm real data starts flowing again.")


if __name__ == "__main__":
    main()
