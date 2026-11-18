---
sidebar:
  order: 171
title: "Tedix permissive package inventory"
topic: "Reference"
resource_type: reference
description: "Dated inventory of Tedix Apache-2.0 and MIT packages, their first commits and app imports."
summary: "Permissive packages and CMS templates recorded on 18 November 2026"
read_when:
  - Checking which Tedix packages have permissive licences
  - Reviewing package history and use by Tedix apps
visibility: public
---

# Tedix permissive package inventory

Recorded on **18 November 2026**, before 1 January 2027, from source commit
[`3f69e6f58f96e1c5b903b7bcf046720467e24408`](https://github.com/tedix-hq/tedix/commit/3f69e6f58f96e1c5b903b7bcf046720467e24408).
This covers all 18 Apache-2.0 or MIT workspaces in `packages/*` and the six MIT
CMS template packages. Names and licences come from their `package.json` files.
See [Licensing and operator FAQ](./licensing.md) for the overall boundary.

“App imports” means a direct import in deployable app source, including CSS
and type imports; each Yes gives one example, not every caller. Configuration
use is marked separately. This records source integration, not proof of a live
deployment or package publication; those states are unknown here. No means no
direct app import was found, not that the package has no other users.

## Packages

Each package lives at `packages/` followed by its name without `@tedix/`,
except `@tedix/mcp-shared`, which lives at `packages/mcp`.

| Package                            | What it does                                                                                  | Licence    | First commit date | App imports (example source path)                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ---------- | ----------------- | -------------------------------------------------------------- |
| `@tedix/agent-governance`          | Defines shared rules and records for agent memory, tool access and accountability.            | Apache-2.0 | 2026-10-06        | Yes: `apps/mcp/src/mcp/gateway-adapters.ts`                    |
| `@tedix/agent-governance-postgres` | Stores agent governance records in Postgres.                                                  | Apache-2.0 | 2026-11-07        | No                                                             |
| `@tedix/agent-runtime`             | Gives an agent storage, a code sandbox, named tools, events and timers through one interface. | Apache-2.0 | 2026-11-07        | No                                                             |
| `@tedix/api-client`                | Creates clients that call the Tedix API from browsers, the CLI and Workers.                   | Apache-2.0 | 2026-10-06        | Yes: `apps/tedi-runtime/src/mcp-client-runtime.ts`             |
| `@tedix/api-contract`              | Defines the request, response and validation shapes shared by Tedix API callers and servers.  | Apache-2.0 | 2026-10-06        | Yes: `apps/tedi-runtime/src/mcp-client-runtime.ts`             |
| `@tedix/context-core`              | Extracts observations, combines memories and compacts an agent's context.                     | Apache-2.0 | 2026-10-06        | Yes: `apps/tedi-runtime/src/brain/reflector.ts`                |
| `@tedix/design-tokens`             | Shares colours, typography and other visual settings across Tedix screens and widgets.        | MIT        | 2026-10-06        | Yes, CSS: `apps/landing/src/styles/globals.css`                |
| `@tedix/installation-manifest`     | Describes a Tedix installation and checks its configuration without storing secrets.          | Apache-2.0 | 2026-10-06        | No                                                             |
| `@tedix/mcp-client-core`           | Discovers MCP tools, manages their credentials and handles tool calls and results.            | Apache-2.0 | 2026-10-06        | Yes: `apps/tedi-runtime/src/mcp-client-runtime.ts`             |
| `@tedix/mcp-shared`                | Shares authentication, access scopes and protocol helpers between MCP servers.                | Apache-2.0 | 2026-10-06        | Yes: `apps/api/src/adapters/mcp.ts`                            |
| `@tedix/ssrf-guard`                | Checks outbound URLs to prevent requests to protected network addresses.                      | Apache-2.0 | 2026-10-06        | Yes: `apps/api/src/adapters/custom.ts`                         |
| `@tedix/tedi-codemode-core`        | Lets a tedi use tools through a single code execution tool.                                   | Apache-2.0 | 2026-10-06        | Yes: `apps/cms-runtime/src/tenant-plugin-executor.ts`          |
| `@tedix/tenant-directory`          | Builds and interprets hostnames for Tedix organizations and services.                         | Apache-2.0 | 2026-10-06        | Yes: `apps/api/src/rpc/routers/directory.ts`                   |
| `@tedix/tsconfig`                  | Shares TypeScript compiler settings across the repository.                                    | MIT        | 2026-10-06        | No source import; configuration only: `apps/api/tsconfig.json` |
| `@tedix/webmcp-core`               | Exposes browser tools so agents can interact with a web page.                                 | MIT        | 2026-10-06        | Yes: `apps/cms-runtime/src/webmcp.ts`                          |
| `@tedix/widget-i18n`               | Supplies translations for embedded Tedix widgets.                                             | MIT        | 2026-10-06        | Yes: `apps/api/src/lib/widget-branding.ts`                     |
| `@tedix/widget-ui`                 | Supplies shared interface components and styles for embedded Tedix widgets.                   | MIT        | 2026-10-06        | Yes: `apps/landing/src/components/landing/ChatGPTDemo.tsx`     |
| `@tedix/worker-kit`                | Shares request, storage and service helpers between Tedix Workers.                            | Apache-2.0 | 2026-10-06        | Yes: `apps/api/src/http/cors-and-limits.ts`                    |

## CMS templates

These packages live under `apps/cms/templates/` and are built separately from
the root workspaces. None is imported by package name by another deployable
app. All six are included as scaffold source in
`apps/cms/src/template-snapshot.ts`, which the CMS imports through
`apps/cms/src/agent/template-sync.ts`. A scaffold is copied to initialize a
site; its presence does not establish that a live site uses it.

| Package                                | Directory          | What it does                                                                      | Licence | First commit date | App imports                            |
| -------------------------------------- | ------------------ | --------------------------------------------------------------------------------- | ------- | ----------------- | -------------------------------------- |
| `@tedix/cms-template-blog`             | `blog`             | Provides a starting website for publishing blog posts.                            | MIT     | 2026-10-06        | No direct package import; CMS scaffold |
| `@tedix/cms-template-marketing`        | `marketing`        | Provides a starting website with marketing pages and content blocks.              | MIT     | 2026-10-06        | No direct package import; CMS scaffold |
| `@tedix/cms-template-native-marketing` | `native-marketing` | Provides a marketing website scaffold with native theme controls and page blocks. | MIT     | 2026-10-06        | No direct package import; CMS scaffold |
| `@tedix/cms-template-portfolio`        | `portfolio`        | Provides a starting website for presenting a portfolio.                           | MIT     | 2026-10-06        | No direct package import; CMS scaffold |
| `@tedix/cms-template-starter`          | `starter`          | Provides a basic website scaffold to extend with content.                         | MIT     | 2026-10-06        | No direct package import; CMS scaffold |
| `@tedix/cms-template-default`          | `tedix`            | Provides the default Tedix website scaffold and site editing tools.               | MIT     | 2026-10-06        | No direct package import; CMS scaffold |

## History and verification

First commit date means the committer date of the earliest addition of the
package manifest, following renames. It is not the date the licence was granted
or the code was originally written. The 22 entries dated 6 October first appear
in the parentless [initial public source commit](https://github.com/tedix-hq/tedix/commit/8886800812d286e1eb8b1a2239f089b9a38d930d).
The later additions are
[`agent-governance-postgres`](https://github.com/tedix-hq/tedix/commit/f96a695727d4a951380a15548ae62bfe75fbd1ad)
and [`agent-runtime`](https://github.com/tedix-hq/tedix/commit/19db8197d6c20a607b04f25bb282c16bb0755b6a).

To repeat a history check in a checkout with history back to that initial
commit, use the package's manifest path, for example:

```bash
git log --follow --diff-filter=A --format='%cs %H' -- packages/agent-runtime/package.json
git grep -n -F '@tedix/agent-runtime' -- apps
```

For app use, inspect the matches as imports rather than counting mentions in
manifests, comments, documentation, examples or tests. Check relative imports
and generated scaffold inclusion as well as package names. The paths in the
tables identify the checked callers. Licence declarations apply to this dated
source snapshot; later changes need a new inventory.
