---
"@tedix/cli": patch
---

Dispatch an agent to verify landed work after deployment. Live evidence can complete the Work or return it to ready for repair, without asking the owner to verify it.

Set `TEDIX_LANE_VERIFY_HEALTH_URLS` on the dispatcher to the space-separated health URLs for the deployment surfaces it verifies. Each surface must report a full `deployedSha` that contains the landed commits.
