---
name: trajectory-mining
title: Deterministic trajectory mining
description: Mine repeated evidence-linked tool sequences into bounded draft skill proposals without model inference.
audience: ["tedi"]
capabilities:
  network: false
  mcp:
    tedi: [mine_skill_candidates]
---

# Deterministic trajectory mining

Executable workflow: `./scripts/workflow.ts`. This asset is initially on demand;
it declares no schedule and has no reasoning or messaging capability.

Identity comes from the immutable admitted run context, never from input. The
existing mining API owns evidence selection, distinct-run support, canonical
tool resolution, duplicate detection and draft proposal creation. This workflow
does not approve or apply proposals.

| Input          | Default | Bounds                                         |
| -------------- | ------- | ---------------------------------------------- |
| `dryRun`       | `true`  | Must explicitly be `false` to create proposals |
| `windowDays`   | 14      | 1–90                                           |
| `minSupport`   | 3       | 3–50 distinct successful runs                  |
| `maxProposals` | 3       | 1–10                                           |

Results distinguish `observation` (dry-run), `proposal_created` (draft IDs), and
`no_change` (no proposals created). Counts describe mining, not accepted value.
API failures and malformed results fail the workflow; they never become empty
successful results. A timeout may follow a committed proposal, so automatic
step retries are disabled. Inspect existing proposals before a manual retry.

## Controlled rollout

Keep this asset on demand. Add a recurring schedule only after an on-demand run
succeeds, dedupe is verified, and proposal outcomes show value.
