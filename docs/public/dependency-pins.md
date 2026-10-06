---
sidebar:
  order: 145
title: "Dependency pins, overrides and patches"
topic: "Operations"
resource_type: reference
description: "Why Tedix pins dependencies exactly, overrides transitive versions, and carries local patches."
summary: "Dependency pinning policy and the root package.json sources for overrides and patches"
read_when:
  - Upgrading a dependency that is pinned exactly, overridden or patched
  - Wondering why a prerelease or canary version is in the lockfile
visibility: public
---

# Dependency pins, overrides and patches

The root `package.json` `catalog` is the single version source; workspaces
write `"catalog:"`. Most entries are caret ranges because `bun.lock` already
makes installs reproducible. An entry is exact only when a patch release would
change behaviour. Upgrade any of them as one reviewed change, together with
the items named beside it.

The current inventory lives in `package.json`: `catalog`, `overrides`, and
`patchedDependencies`. The tables below explain the main compatibility rules;
read those fields for the complete package list and current versions.

## Exact pins

| Package                            | Pinned to                                                   | Why                                                                                                                                                                                                                                                                                          | Upstream                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@orpc/*`                          | a 2.0 beta                                                  | Prerelease: a beta bump can break the API with no semver signal. All `@orpc/*` packages move together.                                                                                                                                                                                       | [middleapi/orpc](https://github.com/middleapi/orpc)                                                                            |
| `drizzle-orm`                      | a 1.0 release candidate                                     | Prerelease, as above. The D1 rules in `packages/db/AGENTS.md` are written against this version.                                                                                                                                                                                              | [drizzle-team/drizzle-orm](https://github.com/drizzle-team/drizzle-orm)                                                        |
| `@cloudflare/sandbox`              | `1.0.0`                                                     | Runtime-coupled: Workstation, CMS and Docs extend app-owned Durable Objects, use native `ctx.container` RPC, and copy the matching v1 `sandbox-shim` into each image. Upgrade the SDK and donor image together.                                                                              | [cloudflare/sandbox-sdk](https://github.com/cloudflare/sandbox-sdk)                                                            |
| `vite-plus`, `vitest`, `vite`      | exact; `vite` is an alias of `@voidzero-dev/vite-plus-core` | `vp fmt` bundles a specific formatter, so this version decides the bytes the format check compares. `vite` is aliased to the Vite+ core, as Vite+ documents, and `vitest` must equal the version `vite-plus` depends on (`vp toolchain vitest`). Keep the core version equal to `vite-plus`. | [voidzero-dev/vite-plus](https://github.com/voidzero-dev/vite-plus)                                                            |
| `wrangler`, `agents`               | exact                                                       | Deploy and runtime behaviour at the edge.                                                                                                                                                                                                                                                    | [cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk), [cloudflare/agents](https://github.com/cloudflare/agents) |
| `emdash`, `@emdash-cms/cloudflare` | exact, matching release line                                | CMS runtime compatibility and version-specific local patches. Update the starter manifests, embedded snapshot, patches, and lockfiles together.                                                                                                                                              | [emdash-cms/emdash](https://github.com/emdash-cms/emdash)                                                                      |

## Overrides

| Override         | Why                                                                                                                                                                                                                                           | Upstream                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `zod`            | Forces one zod copy. The AI SDK and `@orpc/zod` check schemas by identity, and several transitive packages still request zod 3; without the override the lockfile resolves several zod versions and schemas fail at runtime.                  | [colinhacks/zod](https://github.com/colinhacks/zod) |
| `chat`           | Uses the catalog version for transitive requests as well as direct dependencies. The lockfile resolves `chat` and its Telegram/shared adapters to 4.41.1, satisfying the `agents` peer range. Review upgrades with `agents` and the adapters. | [vercel/chat](https://github.com/vercel/chat)       |
| `vite`, `vitest` | Apply the catalog versions above to transitive requests too, including `vite-plus`'s own.                                                                                                                                                     | —                                                   |

## Patches

The root `patchedDependencies` currently names `agents`, EmDash and its
Cloudflare adapter; `bun.lock` records the same patch paths:

- `patches/emdash@1.1.0.patch` handles the Worker Loader transaction path,
  guarded collection deletion, registry bundle validation and required plugin
  lifecycle hooks, external-auth roles, import/seed fencing, locale-aware
  taxonomy archives, and atomic menu replacement.
- `patches/@emdash-cms/cloudflare@1.1.0.patch` implements the collection-deletion
  registry guard using D1 batches or Durable Object `transactionSync`, and
  relaxes the Kumo peer dependency to a compatible range.
- `patches/agents@0.26.0.patch` routes facet Lifecycle alarms through registered
  parent-owned native jobs, preserves facet class and path identity, and adds
  a policy hook before facet initialization and alarm dispatch.

The CMS starters carry matching copies under `apps/cms/templates/*/patches/`.
Their manifests also apply `@emdash-cms/plugin-forms@0.2.9.patch`, which excludes
raw visitor IPs from stored submissions and defaults new forms to 30-day
retention. The exact patch inventory and hashes are recorded in
`scripts/oss/third-party-sources.json`.
Review the actual hunks on every upgrade and remove fixes supplied upstream.
