---
"@tedix/cli": patch
---

`tedix status` now shows in-flight runs and recent delegations for the conversation. It read the gateway's truncated preview of a long run set as an empty conversation and missed the delegated child tree inside the gateway envelope, so a delegated run in progress printed `active=0 delegations=0`. Run-set and child-tree reads are now projected inside the gateway, page down when a result is still too large, and a result that cannot be returned is reported as an error instead of "(none)". `tedix ask --thread <name>` and `tedix threads` work again: the organization check read the organization id off an unawaited `codemode.__runtime()` call and always failed with "Could not verify the organization for saved conversation names."
