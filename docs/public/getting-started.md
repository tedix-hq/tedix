---
sidebar:
  order: 20
title: "Getting started"
topic: "Getting started"
resource_type: tutorial
description: "Run Tedix locally from source and verify that its local data persists."
summary: "First local run from a source checkout"
read_when:
  - Running Tedix locally from a source checkout
  - Evaluating Tedix without a Cloud account
visibility: public
---

# Getting started

This tutorial starts Tedix from a source checkout, creates one local Workspace,
and checks that its data persists. No account or Cloud credential is needed.
To use an invited Cloud organization instead, [connect to Tedix
Cloud](./learning-paths/first-connection.md).

## Run Tedix locally

You need Git, [Bun](https://bun.sh), and Node.js 22+ on `PATH` (real Node, not
a Bun shim; Wrangler needs it). No account or cloud credentials are needed.

```bash
git clone https://github.com/tedix-hq/tedix.git && cd tedix
bun run-local
```

The launcher installs locked dependencies, starts the API on Cloudflare's local
workerd runtime with a local D1 database, and serves Tedix OS on
`http://localhost:3030`. Open it and name your local organization. Tedix
creates the organization, your owner account, and a first tedi through the
same API contracts Cloud uses. State persists in `.wrangler/run-local`; nothing
contacts a Cloudflare account.

| Option                                | What it does                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `--smoke`                             | Onboards into a temporary database, checks the result persists, exits.  |
| `--demo`                              | Loads sample data, kept separately in `.wrangler/run-local-demo`.       |
| `--inference --workers-ai-account=ID` | Turns on model calls through Workers AI on your own Cloudflare account. |
| `--ai-gateway=ID`                     | Uses a named AI Gateway instead of your account's default gateway.      |
| `--help`                              | Lists every option without starting anything.                           |

The [Tedix CLI](./cli.md) wraps this launcher: `tedix setup` runs it in a
checkout, or clones the source release matching your CLI version when one is
published, and `tedix dev` restarts the saved installation later.

### A first offline task

Choose **New workspace**, name it **Supplier review**, and describe the
decision you need to make before your next order. Save it, return to
**Workspaces**, and reopen it. The name and description remain after a refresh
or a restart. Drafting text needs model calls, which the next step turns on.

**Expected result:** the workspace still appears with the same name and
description after you refresh the page. This proves local storage and the local
API path. It does not prove that a digital worker ran.

### Turn on model calls

Model calls go to Workers AI and are billed to your Cloudflare account. All
other data stays on your machine.

```bash
bunx wrangler login
bunx wrangler whoami        # shows your 32-character account id
bun run-local --inference --workers-ai-account=<account-id>
```

Cloudflare's default AI Gateway is created on the first authenticated call.
Add `--ai-gateway=<gateway-id>` to use a named gateway in the same account.
Send a small test prompt to confirm replies come back.

With inference on, Home can propose local tool actions for your approval, such
as saving a document. The launcher also starts the MCP gateway on port 3000, so
a coding agent can discover local tools. [Install the CLI](./cli.md) first; local
calls need no login:

```sh
TEDIX_MCP_URL=<local-gateway-url> \
TEDIX_MCP_BEARER_TOKEN=tedix-local-demo \
tedix code 'async () => await discover.search({query: "get_os_output", limit: 2})'
```

Copy the gateway URL from **Gateways** in Tedix OS. The demo token only works
locally.

Local mode covers onboarding, Tedix OS, workspaces and preferences, the API
authentication boundary, migrations, and D1 reads and writes. It does not run
remote tedis, connect outside providers, or deploy anything.

### Build configuration

`bun run-local` builds Tedix OS with local placeholder values and no Tedix
Cloud identity. Any other `bun run --cwd apps/os build` needs `API_URL`,
`DESCOPE_PROJECT_ID`, and `DESCOPE_BASE_URL` (Descope is the identity
provider), either as `TEDIX_BUILD_*` environment variables or in the `vars`
block of `apps/os/wrangler.jsonc`. The build stops and names any missing value.
See "Build configuration" in `apps/os/README.md`.

## Next

- [Connect to Tedix Cloud](./learning-paths/first-connection.md) to use a live
  organization and its digital workers.
- Check [release status](./release-status.md) for the current limits of local
  and Cloud operation.
- Read [core concepts](./concepts.md) for the product vocabulary.
