# License artifacts

This directory holds the license texts used by Tedix workspaces. `AGPL-3.0-only.txt` and `Apache-2.0.txt`
come from the SPDX license-list data for the matching SPDX identifiers;
`MIT.txt` is the standard OSI template with the Tedix copyright line.

The root `LICENSE` and per-package SPDX metadata implement the
AGPL-3.0-only / Apache-2.0 / MIT matrix. Run `bun run oss:check` to verify the
texts, workspace map, and cross-workspace compatibility edges; regenerate the
readiness report with `bun scripts/oss/license-readiness.ts --write`.

Third-party license texts live under `third-party/` and is indexed from
`THIRD_PARTY_NOTICES.md`.
