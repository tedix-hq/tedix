# @tedix/api

## 0.1.1

### Patch Changes

- fabec79: Honor an exact saved human factory approval when the gateway binds the kernel to the user's primary tedi, while preserving approval and run fences. Avoid labeling an unscheduled draft as paused in chat health.
- 6653d30: Let workspace chat preview factory creation and operate factory health, manual runs, pause, resume and archive through governed tools. Refresh the agent factory procedures.
- 0727b4d: Use the discoverable skill workflow runner for factory run-now requests, with the verified owning tedi, an explicit approval and a unique cycle key. Correct manual-run guidance for gateway aliases and non-default owners.
- 2d4998b: Show the factory dry-run owner, project, schedule, Output and warnings in its approval card, without internal receipts or stale model instructions.
- Updated dependencies [6653d30]
  - @tedix/api-contract@0.0.2
  - @tedix/api-client@0.0.2
  - @tedix/auth@0.1.1
  - @tedix/db@0.0.2
  - @tedix/mcp-shared@0.1.1
  - @tedix/mcp-client-core@0.0.2
  - @tedix/workers-ai@0.0.2
  - @tedix/provisioning@0.0.2
  - @tedix/voice@0.1.1
