---
"@tedix/cli": patch
---

Ask through one canonical Work Interaction and use the blocking Work wait. Remove the settlement `--needs-user`/`--request-id` options and final `question` result. Runs return `waiting_on_user` with the actual request fence. Historical question logs remain readable; ended runs no longer accept alternate answers. Deploy the API and OS changes before updating runners and local plugins.
