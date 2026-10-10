#!/usr/bin/env python3
"""Record real snapshots from the live gateway into tests/fixtures.

Run:  python3 scripts/record-fixtures.py   (needs the gateway running)
This is evidence capture, not a test: it is never invoked by `npm test`.
"""

import json
import os
import time
import urllib.request

# Same precedence as the extension: config/env first, shipped default as the fallback.
BASE = os.environ.get("CAMOUFOX_GATEWAY_URL", "http://localhost:9377")
USER = "pi-fixture-recorder"

TARGETS = [
    ("macro", "camoufox anti-detect browser", "serp-google.txt"),
    ("url", "https://duckduckgo.com/?q=camoufox%20anti-detect", "serp-duckduckgo.txt"),
    ("url", "https://html.duckduckgo.com/html/?q=camoufox%20anti-detect", "serp-duckduckgo-html.txt"),
    ("url", "https://www.bing.com/search?q=camoufox%20anti-detect", "serp-bing.txt"),
    ("url", "https://camoufox.com", "page-default.txt"),
    ("url", "https://github.com/daijro/camoufox", "page-github.txt"),
]


def post(path, payload, timeout=150):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(payload).encode(), headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read())


def delete(path, timeout=60):
    req = urllib.request.Request(f"{BASE}{path}", method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read())
    except Exception:  # noqa: BLE001 - best-effort teardown in a recording script
        return {"ok": False}


def get(path, timeout=60):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as response:
        return json.loads(response.read())


def main():
    try:
        post("/tabs/open", {"userId": USER, "url": "https://example.com"})
    except Exception:
        pass

    tab = next((t for t in get(f"/tabs?userId={USER}")["tabs"]), None)
    if tab is None:
        tab = post("/tabs/open", {"userId": USER, "url": "https://example.com"})
    tab_id = tab["tabId"]

    for kind, value, filename in TARGETS:
        payload = {"userId": USER}
        if kind == "macro":
            payload.update(macro="@google_search", query=value)
        else:
            payload["url"] = value
        try:
            post(f"/tabs/{tab_id}/navigate", payload)
        except Exception as error:  # noqa: BLE001 - recording script
            print(f"navigate failed for {filename}: {error}")
            continue
        time.sleep(2)
        snap = get(f"/tabs/{tab_id}/snapshot?userId={USER}&format=text")
        with open(f"tests/fixtures/{filename}", "w") as handle:
            handle.write(snap["snapshot"])
        print(f"{filename}: {len(snap['snapshot'])} chars, total {snap.get('totalChars')} @ {snap.get('url')[:60]}")

    delete(f"/sessions/{USER}")


if __name__ == "__main__":
    main()
