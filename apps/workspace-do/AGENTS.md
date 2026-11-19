# Working on apps/workspace-do

Read `README.md` first. Rules that are easy to break:

- The agent loop (`src/turn-loop.ts`) is pure: model, sandbox, events and
  summariser are ports. Keep it that way so the object and facets can share
  the same loop.
- Every binding the sandbox sees goes through `wrapBinding`
  (`src/bindings.ts`). Never hand a raw data-port method to the sandbox.
- The sandbox manifest lives only in `src/sandbox.ts` (allow-listed in
  `scripts/lint-loader-sandbox.ts`): `globalOutbound: null`,
  `disallow_importable_env`, model code as `agent.js`.
- Prompt text that is the same for every turn of a workspace belongs in
  `staticPromptPrefix()`; anything that varies goes in the suffix. Do not
  put the time, the user or the tedi into the prefix.
- Workspace rows are read through `@tedix/db/queries/durable-sqlite/*` over
  `this.db`. Imports stage rows without changing output authority. Only the
  separate migration activation operation makes a staged workspace authoritative.
  Pre-protocol owners and object-only transfer destinations keep their authority.
  Browser and agent reads and writes use that same
  owner, without a per-output fallback. An index row is location metadata,
  not proof of object authority. Agent output and resource bindings require
  activation and never fall back to D1. Core rows (apps, Work, tedis)
  use the `DB` binding. The object never reads another workspace's rows.
- Choose a focused case for changes that risk losing data, breaking workspace
  isolation, or transferring authority incorrectly. Reuse `test:unit` for
  pure behavior and `test:workers` when the object or its storage matters.
  Use the workspace runner so workerd and its fixture load correctly.
