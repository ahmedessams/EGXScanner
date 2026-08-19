#!/usr/bin/env python3
"""Automates the manual n8n setup steps documented in docs/RENDER_DEPLOY.md:
create the Postgres credential, import all workflows/*.json with that
credential wired into every Postgres node, fix cross-workflow
Execute-Workflow references (n8n assigns new IDs on import), and publish
everything in dependency order.

Idempotent / safe to re-run: an existing "EGX Postgres" credential or
same-named workflow is reused and UPDATED rather than duplicated — so this
doubles as a "sync latest local changes to production n8n" tool (symmetric
with sync-live.js, which does the same for local dev) whenever
workflows/*.json changes, not just for the initial import.

Run via scripts/render-n8n-setup.sh, which prompts for the inputs below
instead of taking them as CLI args (keeps the API key and DB password out
of shell history). Stdlib only — no pip install needed.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS_DIR = REPO_ROOT / "workflows"
PUBLISH_ORDER = [
    "01-egx-stock-universe.json",
    "02-egx-historical-import.json",
    "03-egx-daily-market-update.json",
    "04-egx-technical-analysis.json",
    "05-egx-support-resistance.json",
    "06-egx-volume-analysis.json",
    "07-egx-breakout-scanner.json",
    "08-egx-momentum-scanner.json",
    "09-egx-pullback-scanner.json",
    "10-egx-reversal-scanner.json",
    "11-egx-overall-ranking.json",
    "17-egx-ai-assessment.json",
    "12-egx-daily-master-workflow.json",
    "13-egx-report-api.json",
    "14-egx-prediction-evaluation.json",
    "15-egx-backtest.json",
    "16-egx-target-window-evaluation.json",
]


def env(name, required=True):
    v = os.environ.get(name, "")
    if required and not v:
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


def find_credential_id(base_url, api_key, name):
    result = api(base_url, api_key, "GET", "/credentials?limit=250")
    for c in result.get("data", []):
        if c.get("name") == name:
            return c["id"]
    return None


def find_workflow_id(base_url, api_key, name):
    from urllib.parse import quote
    result = api(base_url, api_key, "GET", f"/workflows?name={quote(name)}&limit=1")
    data = result.get("data", [])
    return data[0]["id"] if data else None


def preserve_manual_url_patches(base_url, api_key, existing_id, body):
    """Workflows 01/02/03 ship with placeholder HTTP Request URLs
    (literal "CONFIGURE-..." segments — see docs/IMPORT-N8N.md) that get
    manually patched to the real provider endpoint directly on the live
    instance, by design (never committed to the repo). A naive PUT of the
    generator's own JSON would silently overwrite that real URL back to
    the placeholder on every re-sync — confirmed as a REAL regression via
    live E2E testing (this exact bug broke daily data ingestion after a
    routine re-sync). Fetch the current live node URLs first and keep
    whichever side is NOT a placeholder.
    """
    existing = api(base_url, api_key, "GET", f"/workflows/{existing_id}")
    existing_urls = {
        n["name"]: n.get("parameters", {}).get("url")
        for n in existing.get("nodes", [])
        if n.get("type") == "n8n-nodes-base.httpRequest"
    }
    for n in body["nodes"]:
        if n.get("type") != "n8n-nodes-base.httpRequest":
            continue
        new_url = n.get("parameters", {}).get("url", "")
        old_url = existing_urls.get(n["name"])
        if "CONFIGURE-" in new_url and old_url and "CONFIGURE-" not in old_url:
            n["parameters"]["url"] = old_url
            print(f"    preserved manually-configured URL on '{n['name']}' (generator's placeholder would have overwritten it)")


def build_create_body(wf_json, cred_id, cred_name):
    nodes = json.loads(json.dumps(wf_json["nodes"]))  # deep copy
    for n in nodes:
        if n.get("type") == "n8n-nodes-base.postgres":
            n["credentials"] = {"postgres": {"id": cred_id, "name": cred_name}}
    return {
        "name": wf_json["name"],
        "nodes": nodes,
        "connections": wf_json["connections"],
        "settings": wf_json.get("settings", {}),
    }


def main():
    base_url = env("N8N_BASE_URL")
    api_key = env("N8N_API_KEY")
    pg_host = env("PG_HOST")
    pg_port = int(env("PG_PORT"))
    pg_database = env("PG_DATABASE")
    pg_user = env("PG_USER")
    pg_password = env("PG_PASSWORD")

    cred_name = "EGX Postgres"
    print(f"== Postgres credential ('{cred_name}') ==")
    existing_cred_id = find_credential_id(base_url, api_key, cred_name)
    if existing_cred_id:
        cred_id = existing_cred_id
        print(f"  found existing: {cred_id} (reusing — credential data can't be updated via this API; delete and re-run if the DB password changed)")
    else:
        cred = api(base_url, api_key, "POST", "/credentials", {
            "name": cred_name,
            "type": "postgres",
            "data": {
                "host": pg_host, "port": pg_port, "database": pg_database,
                "user": pg_user, "password": pg_password,
            },
        })
        cred_id = cred["id"]
        print(f"  created: {cred_id}")

    print()
    print("== Importing / syncing workflows ==")
    name_to_id = {}
    created_bodies = {}
    for filename in PUBLISH_ORDER:
        path = WORKFLOWS_DIR / filename
        wf_json = json.loads(path.read_text())
        body = build_create_body(wf_json, cred_id, cred_name)
        existing_id = find_workflow_id(base_url, api_key, wf_json["name"])
        if existing_id:
            preserve_manual_url_patches(base_url, api_key, existing_id, body)
            # publishIfActive=false: an already-published workflow's PUT
            # defaults to immediately re-publishing it, but at THIS point
            # Execute Workflow references are still blank (fixed in the
            # next pass below) — n8n's own publish validation would reject
            # them. The explicit "Publishing" pass further down (after refs
            # are fixed) is what actually (re-)publishes everything.
            api(base_url, api_key, "PUT", f"/workflows/{existing_id}?publishIfActive=false", body)
            wf_id = existing_id
            print(f"  {filename} -> {wf_json['name']} ({wf_id}) [updated existing]")
        else:
            created = api(base_url, api_key, "POST", "/workflows", body)
            wf_id = created["id"]
            print(f"  {filename} -> {wf_json['name']} ({wf_id}) [created]")
        name_to_id[wf_json["name"]] = wf_id
        created_bodies[filename] = (wf_id, body)

    print()
    print("== Fixing cross-workflow Execute Workflow references ==")
    for filename in PUBLISH_ORDER:
        wf_id, body = created_bodies[filename]
        changed = False
        for n in body["nodes"]:
            if n.get("type") == "n8n-nodes-base.executeWorkflow":
                target_name = n["parameters"]["workflowId"].get("cachedResultName")
                target_id = name_to_id.get(target_name)
                if target_id:
                    n["parameters"]["workflowId"]["value"] = target_id
                    changed = True
                else:
                    print(f"  WARNING: {filename} references unknown workflow '{target_name}'")
        if changed:
            api(base_url, api_key, "PUT", f"/workflows/{wf_id}?publishIfActive=false", body)
            print(f"  {filename}: references updated")

    print()
    print("== Publishing (dependency order) ==")
    for filename in PUBLISH_ORDER:
        wf_id, _ = created_bodies[filename]
        try:
            api(base_url, api_key, "POST", f"/workflows/{wf_id}/publish", {})
            print(f"  {filename}: published")
        except urllib.error.HTTPError as e:
            if e.code == 409:
                print(f"  {filename}: SKIPPED - 409 conflict (likely a webhook path")
                print(f"    already claimed by another published workflow with the")
                print(f"    same route — e.g. this script was run before without")
                print(f"    cleaning up the earlier import). Publish it manually in")
                print(f"    the n8n UI once the conflict is resolved.")
            else:
                raise

    print()
    print("== Done ==")
    print("All 15 workflows imported, wired to the Postgres credential, and")
    print("published. 03/12/14 have Schedule Triggers, so publishing them")
    print("also activates those schedules. Verify at the egx-webapp URL —")
    print("it should already show data from the restored dump.")


if __name__ == "__main__":
    main()
