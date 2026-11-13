# Reviewing a change to Tedix

How a coding agent reviews a change in this repository. For giving feedback
on Tedix as a product, use `AGENT-REVIEW.md` instead.

## Check first

1. **Does it do what the Work Item asks?** Read the item's accepted outcome,
   then the diff. A change that passes every check but misses the outcome is
   the most expensive defect to find later.
2. **Did the checks run?** Ask for the output of `bun run lint:repo`,
   `bun run --cwd <workspace> type-check` and the workspace's `test:run`.
   Do not re-derive by reading what a gate already proves.
3. **Who can call it?** New or changed API procedures need both permission
   and API-key scope guards, and a record fetched by a caller-supplied id must
   be bound to the caller's organization. `scripts/lint-authz.ts` checks the
   common shapes; review anything it lists as hand-rolled or exempt.
4. **Is new behavior tested?** Look for a test that fails without the change.

## Rules with one enforcement point

Each rule below is checked by code. If the check passes, do not flag the
rule; if a change edits the check, its baseline or its exception list, review
that edit closely.

| Rule                                                                  | Enforced by                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Database access lives in `@tedix/db/queries/<domain>`                 | `scripts/lint-db-access.ts`, with approved exceptions in `scripts/db-access-exceptions.json`         |
| Procedures come from `implement(contract)` over `@tedix/api-contract` | TypeScript, and `apps/api/src/rpc/routers/contract-parity.test.ts` for the three router registries   |
| `db.batch()`, never `db.transaction()`, on D1                         | `scripts/check-package-boundaries.ts`, and the D1 test facade in `packages/db/src/test/d1-facade.ts` |
| Every selected column has a unique output name                        | `scripts/lint-d1.ts`, and the same D1 test facade at runtime                                         |

All four scripts run in `bun run lint:repo`. The transaction ban covers D1
code only: `.transaction()` is correct in Durable Object SQLite
(`durable-sqlite`) and on the Postgres plane (`packages/db/src/pg/`). For
duplicate columns, the fix is `prefixedColumns()` or an explicit alias.

Not covered by any check: a Zod schema written inline in a router, or a
contract-shaped helper outside `packages/api-contract/src/`. Flag those by
reading; `apps/api/AGENTS.md` marks contract-first as advisory.

## Do not flag

- Formatting. `bun run format:check` owns it.
- Router length or bundle size. `apps/api/AGENTS.md` sets no ceilings.
- A Drizzle import or raw D1 SQL in a file listed in
  `scripts/db-access-exceptions.json`. The list records why.
- Existing entries in a lint baseline that the change does not touch. A
  gate with a baseline fails on new findings by itself.
- Style preferences, renames and refactors outside the Work Item's scope.
  File them as a follow-up Work Item if they matter.

## Report

Give each finding a file, a concrete failure (input, state, wrong result)
and a suggested fix. Say what you checked and what you could not verify.
Post the review on the Work Item, not as a GitHub issue or pull request.
