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
  `this.db`. The first document or resource operation initializes the store
  from its shared workspace directory row; a missing row fails closed.
  Browser and agent operations use the workspace store without falling back
  to D1. Core rows (apps, Work, tedis) use the `DB` binding. The object never
  reads another workspace's rows.
- Use `test:unit` for pure behavior and `test:workers` for Durable Object
  authority, workspace isolation, or storage behavior. Use the workspace
  runner so workerd and its fixture load correctly.
