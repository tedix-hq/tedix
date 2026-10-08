# License artifacts

This directory holds the permissive license texts used by Tedix workspaces.
`Apache-2.0.txt` comes from the SPDX license-list data; `MIT.txt` is the
standard OSI template with the Tedix copyright line. The AGPL-3.0-only text is
the root `LICENSE`.

The root `LICENSE` and per-package SPDX metadata implement the
AGPL-3.0-only / Apache-2.0 / MIT matrix. Run `bun run oss:check` to verify the
workspace map, each manifest's license field, cross-workspace edges, and the
dependency-license allow-list.

Third-party license texts live under `third-party/` and are indexed from
`THIRD_PARTY_NOTICES.md`.
