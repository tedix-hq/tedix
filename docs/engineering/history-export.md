---
title: "Organization history packs"
description: "Organization history packs"
---

# Organization history packs

An authorized installation operator can collect one organization's history for
an inclusive `--from` and exclusive `--to`. The command reads main D1, every
supplied logs partition and the organization's archives and signed ledger, writes
a local working copy, and publishes the pack in the private EU R2 bucket.
It does not change source rows or archive objects.

Use private ops inventory and credentials. Do not infer targets from the
example Worker configuration. Set:

- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with D1 read access.
- `HISTORY_D1_DATABASES`: a JSON object mapping `DB`, `LOGS_DB` and **every**
  historical `LOGS_DB_<n>` binding to its database UUID. Omitting a binding
  omits its data; the command cannot discover Worker bindings from D1 access.
- `HISTORY_R2_BUCKET`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for
  the existing private EU archive bucket, with object list/read/write access.
  The command uses the account's `.eu.r2.cloudflarestorage.com` endpoint;
  there is no fallback to a bucket outside EU.
- `HISTORY_LEDGER_KEYS`: a JSON object mapping key IDs to base64 Ed25519
  SPKI public keys obtained from the installation operator through an independent
  trusted channel. Include historical keys after rotation. Signed bundles fail
  verification without a matching trusted key. Embedded bundle keys are never
  used as trust roots; `{}` permits only unsigned historical bundles.
- `HISTORY_LEDGER_KEY_PROVENANCE`: the independent source or receipt for the
  public keys. The manifest records this statement with the verified key
  fingerprints; if omitted, it explicitly reports the source as unrecorded.

```sh
bun scripts/db/history-export.ts \
  --organization org_example \
  --from 2026-01-01T00:00:00Z \
  --to 2026-02-01T00:00:00Z \
  --output /private/export-new-directory
```

The output directory must not exist. Local files use private permissions.
Each page is uploaded and its SHA-256 checked by reading it back. A unique
`history-exports/v1/<organization>/<export-id>/manifest.json` is published
last. A failure stops the command; partial directories/prefixes without a
manifest are incomplete. Retain the final receipt's `manifestKey` and
`manifestSha256` as Work evidence. Share the digest through a trusted channel
separately from the pack. The manifest is not digitally signed.

## Contents and limits

The manifest declares its table inventory, stores, collection interval, scanned
rowid high waters, empty scans, physical row counts, observed time ranges,
file sizes and SHA-256 hashes of the exact exported bytes. Archive-derived
files also identify their original object key and compressed input hash.
Archive keys are scanned under each organization/table prefix without a day
filter: the key's day describes only the first row in a chunk.

The inventory includes audit events and their metadata dictionaries, runtime
events, skill artifacts, agent attributions, organization call costs, request
events, usage events, widget events and Work events. Dictionaries have no
timestamp and are included in full for the organization, with null observed
time bounds. Platform cron/workflow rows and
platform call costs have no organization and are excluded. This is a history
export, not a backup of all business-state tables or referenced artifact bodies.
Standalone `audit-exports/v1` rows are filtered by record time and included as
`audit_daily_export`, preserving their source key and compressed input hash.
The exporter also scans the organization's `change-record-evidence/v1` prefix,
including the authoritative day manifests written by the organization log store
after cutover and older standalone bundles. It selects bundles by record time
or sealing time, then includes the full applicable sealing-day manifests and
their referenced bundles. A record can be sealed days after it was recorded;
the scan therefore does not prune bundles by object name or sealing day.

Complete checkpoint bundles are preserved byte for byte. Records outside the
requested dates remain as verification context, counted separately in
`ledger.contextRecords`; `ledger.selectedRecords` counts records in the range.
The report retains unsigned historical exceptions, standalone bundles, duplicate
record copies, conflicting sequence versions, missing sealing-day manifests and
missing predecessor checkpoints. Missing coverage is unknown, never proof of
an empty day. Missing referenced bundles, changed manifest digests, broken
checkpoint links and invalid signatures or record hashes fail the export.
Unsigned exceptions receive content/chain checks only, not signature proof.
The report records fingerprints of the independently supplied keys that verified
signatures. It does not establish who controlled those keys.
A successful history pack does not prove that a workspace and its live R2
bodies can be restored.

Each source's copies remain separate, including conflicting versions and
duplicates made during retention moves. Do not sum counts as unique events.
The read order is main, logs, then R2, following the direction of retention
moves. This is a collection interval with per-store bounds, not an atomic
cross-store snapshot. Use a closed historical range and coordinate partition
rotation with the operator. Late writes, mutable rows, deleted source history
and omitted installation targets cannot be proven absent offline.

D1 skill artifacts and usage events use the organization's current main
`skill_runs` and `tedis` IDs. R2 uses the organization prefix assigned when the
row was archived, including rows whose parent no longer exists in main.
Unarchived rows with deleted parents cannot be attributed from D1 alone.
Malformed archives, tenant mismatches, missing tables, denied reads and broken
pagination fail the export instead of producing a successful partial manifest.

## Offline verification

Download the entire unique pack prefix, preserving file names, or use the
local copy. Python 3 with its standard library and Bun are required; credentials,
network access and the repository are unnecessary. Use a trusted copy of the
verifier (included as `verify.py`) and the digest from the export receipt:

```sh
python3 verify.py /path/to/pack --sha256 <trusted-manifest-sha256> --keys /trusted/keys.json
```

It checks the pinned manifest hash, every file's hash and size, NDJSON row
counts, direct tenant ownership, requested and observed time bounds, scan
totals and unsafe file paths. Hashes prove integrity against the pinned
manifest, not the truth of source events or completeness of undisclosed stores.
After checking file integrity, Python invokes the included `verify-ledger.js`,
a self-contained bundle of the existing DSSE/Ed25519 and record-chain verifier.
It checks the signed statement against the exported checkpoint, each record's
canonical content hash and chain link, day-manifest references, checkpoint
linkage and the coverage/version report. Supply the independent public-key map
again for offline verification, or `{}` for wholly unsigned history. Never use
keys copied from the pack as proof of signing-key provenance.

Focused development checks:

```sh
bun test scripts/db/history-export.test.ts
python3 scripts/db/test_verify_history_pack.py
bun run type-check:scripts
```
