---
name: test-audit
description: Audit or prune Tedix tests, fixtures, and test-only code when asked to reduce redundant coverage or simplify a suite.
---

# Audit Tedix tests

Start with [the root testing policy](../../../AGENTS.md#check-your-change) and
[REVIEW.md](../../../REVIEW.md). Read the candidate test, the code it exercises,
its callers, and the command that selects it. Check nearby coverage and
relevant history before deciding what to remove.

- Name the observable failure each candidate can catch. Look for repeated
  journeys, copied inventories, assertions about private implementation, and
  mocks that supply the result being asserted.
- Keep the smallest check that proves each consequential behavior. Keep a
  second check when it covers a distinct failure, such as browser behavior,
  permissions, or persisted data across an upgrade.
- Remove orphaned fixtures, helpers, and test-only exports in the same change
  when the caller search confirms they are unused. Preserve independent
  contract, security, migration, and release checks.

Run the focused check that still owns the behavior. If speed is the reason
for the change, compare the same suite or shard with comparable setup and
report what was measured. Report removed coverage, the remaining proof, and
any material gaps.

Adapted from [OpenClaw's test audit](https://github.com/openclaw/openclaw/blob/c8931b32d3d/.agents/skills/test-audit/SKILL.md).
