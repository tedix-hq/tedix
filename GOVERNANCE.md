# Governance

This document describes who maintains Tedix and how decisions are made. See
also `CONTRIBUTING.md`, `SECURITY.md`, and `SUPPORT.md`.

## Roles

- **Owner:** Tedix GbR decides product direction, licensing, releases,
  trademarks, and this document.
- **Maintainers:** named in `.github/CODEOWNERS`. They triage issues, write
  every merged change, and own release quality.
- **Contributors:** anyone who reports a bug or proposes an idea in an issue.

## How changes are made

Maintainers write the code and commit directly to `main` after the pre-push
checks pass. Outside pull requests are not merged. To propose a change, open an
issue; if it is accepted, a maintainer re-authors it and credits you with a
`Reported-by:` trailer.

Changes touching authentication, tenant isolation, secrets, database
migrations, billing, or deployment get extra review before they land. Fixing
forward is not a substitute for preventing data disclosure or data loss.
Licensing and trademark decisions stay with the owner.

## Source and releases

Public `main` is the product source. Tedix Cloud is built from a public commit
plus private operational configuration; product code is never kept private.
`main` moves fast and is not a stable installation target. Release channels
and self-hosting support are described in
[Release status](docs/public/release-status.md).

## Issue triage

Maintainers label, deduplicate, and ask for a reproduction, then accept the
issue or close it with a reason. Stale issues missing information may be closed
after a warning.

## Changes to this document

Changes to this document require owner approval.
