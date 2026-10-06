---
summary: "scripts/ contributor guide: what the repo gates check, how to run them, and how to add or change one"
read_when:
  - Touching any scripts/lint-*.ts, scripts/check-*.ts, or a scripts/*.json baseline
  - Adding a new root-level script or a new repo gate
title: "scripts/ guide"
---

# scripts/ Guide

Root rules live in `/AGENTS.md`. This directory holds the repo gates, their
baselines, and dev/CI tooling. A red gate is fixed at the cause, never by
relaxing the gate.

## Gates

| Gate                                                 | Checks                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| `check-package-boundaries.ts`                        | Tracked-path hygiene, the D1 transaction ban, DB/model boundary, tsconfigs      |
| `check-package-exports.ts`                           | `package.json#exports` targets exist; imports use exported subpaths             |
| `lint-import-cycles.ts` (+ `import-cycle-policy.ts`) | No new circular imports                                                         |
| `lint-db-access.ts`                                  | D1 access stays in `packages/db` or a listed storage owner                      |
| `lint-d1.ts`                                         | Duplicate output columns and unbounded `inArray` parameters                     |
| `lint-authz.ts`                                      | Two-plane authorization coverage and tenant scope in `apps/api` routers         |
| `lint-worker-route-authz.ts`                         | Every Worker HTTP route is guarded or annotated public                          |
| `lint-wrangler.ts`                                   | Both Worker config forms: secrets, DO migrations, crons, SSRF flag, env parity  |
| `lint-contracts.ts`                                  | Contract naming/JSON conventions; collection-read inputs reject unknown keys    |
| `lint-kumo.ts`, `lint-os.ts`                         | Tedix OS design tokens, Kumo adapters, query-key namespace, WebMCP tool modules |
| `lint-loader-sandbox.ts`                             | Every Worker Loader site sets its sandbox policy explicitly                     |
| `lint-vite-plus-imports.ts`                          | Vite/Vitest are imported through `vite-plus`                                    |

Each script's header states its rule. Run one with `bun run lint:<name>`; run
them all with `bun run lint:repo`, which must stay offline. Gates print findings
and exit 0 by default; `--strict` (what `lint:repo` uses) exits 1 on errors.

## Baselines

- `contract-input-strictness-baseline.json` and `import-cycles-baseline.json`
  record existing debt. They may only shrink: remove an entry when you fix it,
  and never add one to go green. Refresh with `--update-baseline`.
- `db-access-exceptions.json` lists the approved storage owners, each with its
  plane, binding, and responsibility. Unlisted or stale owners fail.
- The other gates have no baseline: fix the finding or add the script's typed,
  reasoned exemption.

## Adding or changing a gate

- Keep the shape: pure exported analysis functions with a co-located
  `<script>.test.ts`, driven by a thin runner that owns I/O and exit codes.
- Tests run with `bun run test:scripts` (plain Bun; the Worker-app `bun test`
  ban does not apply here).
- Opt new code into type checking through `scripts/tsconfig.json`'s `include`
  list (`bun run type-check:scripts`).
- Changing what a gate enforces is its own stated change, never a side effect
  of the change it would have blocked.
- Domain scripts go in a subdirectory (`ci/`, `docs/`, `oss/`, ...); the root is
  for repo-wide gates and dev orchestration.
