#!/usr/bin/env python3
"""Read-only Litium/Monitor sync for the Sevede configurator.

The script reads a bounded Sevede subset, joins accessories by exact Monitor ID
and writes a sanitized local cache. Credentials and source tokens never enter
the cache. A failed or incomplete run leaves the last accepted cache untouched.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_JSON = APP_ROOT / "data" / "sevede-current.json"
OUTPUT_JS = APP_ROOT / "data" / "sevede-current.js"
LITIUM_BASE = os.environ.get("LITIUM_BASE_URL", "https://www.auralight.com").rstrip("/")
LITIUM_KEYCHAIN_SERVICE = os.environ.get("LITIUM_KEYCHAIN_SERVICE", "Litium Admin Web API")
DEFAULT_AURA_ROOT = Path.home() / "Library/CloudStorage/OneDrive-AuraLightInternationalAB/📌 AI - Dokument/CODEX library/Auralight/AI IMPLEMENT AURA"
AURA_ROOT = Path(os.environ.get("AI_IMPLEMENT_AURA_ROOT", DEFAULT_AURA_ROOT))
MONITOR_CLIENT = AURA_ROOT / "03_SALES/SalesGoal/04_IMPLEMENTATION/monitor_api_adapter/monitor_client.py"

SYSTEM_BASES = {
    "Sevede CE System": "ce",
    "Sevede PE System": "pe",
    "Sevede RE System": "re",
}
ACCESSORY_BASES = {
    "Joint Bracket Kit Sevede CE-PE": "cepe",
    "Bracketkit Sevede RE Plaster Ceiling": "re",
}


def localized(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get("sv-SE") or value.get("en-US") or next(iter(value.values()), None)
    return value


def litium_credentials() -> tuple[str, str]:
    metadata = subprocess.run(
        ["security", "find-generic-password", "-s", LITIUM_KEYCHAIN_SERVICE],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    match = re.search(r'"acct"<blob>="([^"]+)"', metadata)
    if not match:
        raise RuntimeError("Litium Keychain account metadata was not found")
    account = match.group(1)
    secret = subprocess.run(
        ["security", "find-generic-password", "-a", account, "-s", LITIUM_KEYCHAIN_SERVICE, "-w"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return account, secret


def litium_token() -> str:
    account, secret = litium_credentials()
    body = urllib.parse.urlencode(
        {"grant_type": "client_credentials", "client_id": account, "client_secret": secret}
    ).encode()
    request = urllib.request.Request(
        f"{LITIUM_BASE}/Litium/OAuth/token",
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.load(response)
    token = payload.get("access_token")
    if not token:
        raise RuntimeError("Litium did not return an access token")
    return str(token)


def litium_request(token: str, path: str, method: str = "GET", body: dict[str, Any] | None = None) -> Any:
    request = urllib.request.Request(
        f"{LITIUM_BASE}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def load_monitor_client():
    if not MONITOR_CLIENT.exists():
        raise RuntimeError(f"Monitor adapter not found: {MONITOR_CLIENT}")
    spec = importlib.util.spec_from_file_location("sevede_monitor_client", MONITOR_CLIENT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    settings = module.monitor_config(overrides={"MONITOR_REGION": "se"})
    return module.MonitorClient(settings)


def variant_kind(name: str) -> str:
    lowered = name.lower()
    if " start" in lowered:
        return "start"
    if " end" in lowered:
        return "end"
    if " middle" in lowered or " mid" in lowered:
        return "mid"
    return "unspecified"


def compact_variant(mode: str, detail: dict[str, Any]) -> dict[str, Any]:
    fields = detail.get("fields") or {}
    name = str(localized(fields.get("_name")) or "")
    return {
        "mode": mode,
        "articleNumber": str(detail.get("id") or ""),
        "pimVariantId": str(detail.get("systemId") or ""),
        "name": name,
        "kind": variant_kind(name),
        "lengthMm": localized(fields.get("LengthDec")),
        "mounting": localized(fields.get("Mounting")) or localized(fields.get("InstallationSurface")),
        "color": localized(fields.get("Color")),
        "luminousFluxLm": localized(fields.get("LuminousFluxLmDec")),
        "optic": localized(fields.get("Optic")),
        "control": localized(fields.get("Controllability")),
        "cri": localized(fields.get("CRI")),
        "cct": localized(fields.get("ColorTempCCT")),
    }


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def sync() -> dict[str, Any]:
    token = litium_token()
    search = litium_request(token, "/Litium/api/admin/products/baseProducts/search", "POST", {"take": 1000, "skip": 0})
    base_products = search.get("items") or search.get("data") or []
    selected: dict[str, dict[str, Any]] = {}
    for base in base_products:
        name = str(localized((base.get("fields") or {}).get("_name")) or "")
        if name in SYSTEM_BASES or name in ACCESSORY_BASES:
            selected[name] = base
    expected_names = set(SYSTEM_BASES) | set(ACCESSORY_BASES)
    missing = sorted(expected_names - set(selected))
    if missing:
        raise RuntimeError(f"Required Litium products missing: {', '.join(missing)}")

    modules: list[dict[str, Any]] = []
    accessories: list[dict[str, Any]] = []
    monitor = load_monitor_client()
    for base_name, mode in SYSTEM_BASES.items():
        base_id = selected[base_name].get("systemId")
        variants = litium_request(token, f"/Litium/api/admin/products/baseProducts/{base_id}/variants")
        for item in (variants.get("items") if isinstance(variants, dict) else variants) or []:
            variant_id = item.get("systemId") if isinstance(item, dict) else item
            detail = litium_request(token, f"/Litium/api/admin/products/variants/{variant_id}")
            modules.append(compact_variant(mode, detail))

    for base_name, mode in ACCESSORY_BASES.items():
        base_id = selected[base_name].get("systemId")
        variants = litium_request(token, f"/Litium/api/admin/products/baseProducts/{base_id}/variants")
        items = (variants.get("items") if isinstance(variants, dict) else variants) or []
        if len(items) != 1:
            raise RuntimeError(f"Expected one Litium variant for {base_name}, got {len(items)}")
        variant_id = items[0].get("systemId") if isinstance(items[0], dict) else items[0]
        detail = litium_request(token, f"/Litium/api/admin/products/variants/{variant_id}")
        fields = detail.get("fields") or {}
        monitor_id = localized(fields.get("m_monitor_id"))
        if not monitor_id:
            raise RuntimeError(f"Litium product {base_name} has no Monitor ID")
        rows = monitor.query(
            "Inventory",
            "Parts",
            {"$filter": f"Id eq {monitor_id}", "$top": "1", "$select": "Id,PartNumber,Description,Status,Type"},
        )
        if len(rows) != 1 or str(rows[0].get("PartNumber")) != str(detail.get("id")):
            raise RuntimeError(f"Exact Litium/Monitor join failed for {base_name}")
        accessories.append(
            {
                "mode": mode,
                "articleNumber": str(rows[0]["PartNumber"]),
                "name": str(rows[0].get("Description") or base_name),
                "pimVariantId": str(detail.get("systemId") or ""),
                "erpVerified": True,
            }
        )

    if len(modules) != 84 or len(accessories) != 2:
        raise RuntimeError(f"Coverage gate failed: {len(modules)} modules, {len(accessories)} accessories")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "schemaVersion": 1,
        "generatedAt": now,
        "readOnly": True,
        "externalWritesPerformed": False,
        "sources": {
            "litium": {"status": "ok", "role": "product-content", "baseProducts": 5, "variants": len(modules) + len(accessories)},
            "monitor": {"status": "ok", "role": "erp-article-truth", "verifiedArticles": len(accessories)},
        },
        "modules": modules,
        "accessories": accessories,
        "applicationPolicy": {
            "lengths": "review-required-on-conflict",
            "standardArticle": "complete-criteria-match-only",
            "accessories": "exact-litium-monitor-id-join",
        },
    }


def main() -> None:
    payload = sync()
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    atomic_write(OUTPUT_JSON, serialized)
    atomic_write(OUTPUT_JS, "window.SEVEDE_SYNC_SNAPSHOT = " + serialized.rstrip() + ";\n")
    print(json.dumps({"status": "ok", "generatedAt": payload["generatedAt"], "modules": len(payload["modules"]), "accessories": len(payload["accessories"]), "outputs": [str(OUTPUT_JSON), str(OUTPUT_JS)]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
