---
summary: "Choose and validate a local Tedix development lane"
read_when:
  - Starting local product or platform development
  - Choosing between fixtures and isolated local state
  - Validating Tedix OS or local services before a change
title: "Development"
---

# Development

Every lane on this page runs against isolated local state. Nothing here needs a
Tedix account, a secret provider, or production credentials.

Requirements: Bun, and Node.js 22+ on `PATH` (Wrangler needs a real Node, not a
Bun shim; the launcher checks this before building).

## Choose A Lane

| I want to...                      | Command                              | What I get                                                                         |
| --------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Try the product                   | `bun run-local`                      | Built OS Worker and real API on `localhost:3030`, persistent local D1, local owner |
| Iterate on UI against fixtures    | `cd apps/os && bun run dev:fixtures` | Fast SPA on `localhost:3010`, no login, no persistence                             |
| Work on platform services         | `bun dev`                            | Full local stack with local Wrangler state; OS stays fixture-backed                |
| Run fixture OS plus local API/MCP | `bun run dev:os-stack`               | Focused processes and logs                                                         |

## Try The Product

`bun run-local` is the one launcher for the whole product. Its options (smoke
run, demo data, Workers AI on your own account) are in
[Getting started](../public/getting-started.md#run-tedix-locally); `bun run-local
--help` lists them all. With the installed CLI, `tedix dev` resumes a saved
installation.

## Fixture-Only UI Loop

```bash
cd apps/os
bun run dev:fixtures
```

The fastest styling loop. Vite middleware serves deterministic,
contract-validated `/api` fixtures; an uncovered endpoint fails explicitly.
`VITE_LIVE_API=1` disables fixture interception but adds no session or login.

## Validation

```bash
bun run-local --smoke
bun run dev:health:os
bun run dev:health:full
bun run dev:local:test
```

Also run the affected workspaces' tests and typechecks. A green health command
is not browser proof: for visible OS changes, check the page and console once
the Worker is ready.

## When Something Fails

1. Read the startup banner and confirm the lane.
2. Run the lane's health or smoke command.
3. Check the Local Explorer at
   `http://127.0.0.1:<port>/cdn-cgi/local/explorer`.
4. Read `logs/dev/all.log`, then the surface log (`os.log`, `api.log`,
   `mcp.log`).

Local lanes need no secrets. Do not create `.dev.vars` or disable TLS
verification; put any value an app's `.env.example` names in a gitignored
`.env`.

## Related

- [Architecture](architecture.md)
- [Auth](platform/auth.md)
- [Tedix OS](product/tedix-os.md)
