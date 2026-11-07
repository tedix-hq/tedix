# Working on apps/workspace-do

Read `README.md` first. Rules that are easy to break:

- The agent loop (`src/turn-loop.ts`) is pure: model, sandbox, events and
  summariser are ports. Keep it that way so it runs in the object, in a
  facet and in a `bun test` with a scripted model.
- Every binding the sandbox sees goes through `wrapBinding`
  (`src/bindings.ts`). Never hand a raw data-port method to the sandbox.
- The sandbox manifest lives only in `src/sandbox.ts` (allow-listed in
  `scripts/lint-loader-sandbox.ts`): `globalOutbound: null`,
  `disallow_importable_env`, model code as `agent.js`.
- Prompt text that is the same for every turn of a workspace belongs in
  `staticPromptPrefix()`; anything that varies goes in the suffix. Do not
  put the time, the user or the tedi into the prefix.
- Workspace rows are read through `@tedix/db/queries/durable-sqlite/*` over
  `this.db`; core rows (apps, resources, Work, tedis) through the `DB`
  binding. The object never reads another workspace's rows.
- Tests: `test:unit` (bun) for the loop, prompt and bindings;
  `test:workers` (workerd) for the object with the scripted model in
  `test/worker.ts`. Never bare `bun test`.
