#!/usr/bin/env python3
"""Offline integrity check. Obtain the manifest digest through a trusted channel."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path


def timestamp(value, epoch=False):
    if epoch:
        return datetime.datetime.fromtimestamp(value, datetime.timezone.utc)
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=datetime.timezone.utc) if parsed.tzinfo is None else parsed


def verify(root, expected):
    raw = (root / "manifest.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Manifest SHA-256 mismatch")
    manifest = json.loads(raw)
    if manifest["format"] != "tedix-history-pack/v1":
        raise ValueError("Unknown pack format")
    tables = {entry["table"]: entry for entry in manifest["tables"]}
    lower, upper = timestamp(manifest["from"]), timestamp(manifest["to"])
    seen = set()
    counts = {}
    for entry in manifest["files"]:
        name = entry["path"]
        if name in seen or Path(name).name != name or name in (".", "..", "manifest.json"):
            raise ValueError("Invalid or duplicate file path")
        seen.add(name)
        path = root / name
        if path.is_symlink():
            raise ValueError("Pack files cannot be symlinks")
        digest = hashlib.sha256()
        rows, times = 0, []
        with path.open("rb") as stream:
            for line in stream:
                digest.update(line)
                if entry["table"] is None:
                    continue
                row = json.loads(line)
                spec = tables[entry["table"]]
                if not spec.get("indirect") and row[spec["owner"]] != manifest["organization"]:
                    raise ValueError("Tenant mismatch")
                if spec["time"]:
                    time = timestamp(row[spec["time"]], spec.get("epoch", False))
                    if not lower <= time < upper:
                        raise ValueError("Row outside requested range")
                    times.append(time)
                rows += 1
        if digest.hexdigest() != entry["sha256"] or path.stat().st_size != entry["bytes"]:
            raise ValueError("File SHA-256 or size mismatch: " + name)
        if entry["table"] is not None:
            if rows != entry["rows"]:
                raise ValueError("Row count mismatch: " + name)
            if times:
                if min(times) != timestamp(entry["from"]) or max(times) != timestamp(entry["to"]):
                    raise ValueError("Observed time range mismatch: " + name)
            elif entry["from"] is not None or entry["to"] is not None:
                raise ValueError("Unexpected time range: " + name)
            source = "d1-archive/v1" if entry["source"].startswith("d1-archive/v1/") else entry["source"]
            key = (entry["table"], source)
            counts[key] = counts.get(key, 0) + rows
    for scan in manifest["scans"]:
        if counts.pop((scan["table"], scan["source"]), 0) != scan["rows"]:
            raise ValueError("Scan count mismatch")
    if counts:
        raise ValueError("File has no matching scan")
    return {"verifiedFiles": len(seen), "organization": manifest["organization"], "manifestSha256": expected}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", type=Path)
    parser.add_argument("--sha256", required=True, help="Trusted manifest SHA-256 from the export receipt")
    args = parser.parse_args()
    print(json.dumps(verify(args.pack, args.sha256)))
