# Main certification

For an urgent pipeline cutover, `bun run push --priority` waits for the current
holder, then precedes ordinary waiting tickets without changing validation.
When upgrading the queue itself, `--queue-candidate` pins committed local queue
code only after proving it contains freshly fetched main; rebase before using it.
Normal pushes always load the fetched main version.

`full-suite-hourly.yml` runs on every main push, hourly, and manual dispatch.
Each run has its own concurrency group, including its SHA and run ID. New pushes,
scheduled runs and manual dispatches cannot cancel unfinished certification.
The required aggregate is `Main CI`. Pushes run every test/type-check shard of
workspaces affected since the latest green main ancestor, including transitive
package consumers. This includes earlier changes whose CI is red or pending;
a docs push cannot certify an untested code change. Docs/Markdown-only ranges
skip tests. Unknown paths or missing certification history run everything.

Shared inputs (root manifests, lockfiles, TypeScript/Vite/Vitest and formatter
configuration, workflows, scripts, API contracts, DB schema/migrations and Worker
configuration) run all workspace and repository checks. The selection rules live
in `scripts/ci/full-suite-hourly.mjs`. Scheduled and manual runs always run the
complete suite, even when the same SHA already passed affected checks. Repository
checks retain script tests, public docs, generated types, migration validation,
builds, licenses and lint. The aggregate requires success from each selected lane
and accepts a skipped lane only when the plan explicitly omitted it.

Ship continues to require a successful exact-SHA `Main CI` from this workflow
when green-only deployment is enabled; affected certification does not bypass
that selection. The plan summary records the selected shard count and scope.

Workspace and repository shards default to GitHub-hosted `ubuntu-latest`.
Standard hosted runners are free for this public repository. Set
`FULL_SUITE_RUNNER_LABELS` to a JSON array to override the runner labels.
A self-hosted Cloudflare pool is a later optimization, not a rollout dependency.
This workflow replaces the old scoped push CI; release and pull-request
certification remain in `oss-public-ci.yml`.

The local hook defaults to owner types, changed formatting, Oxlint,
architecture/dependency lint, and the fail-closed private secret scan. Operators
must enforce green-only deployment before enabling this default. During initial
cutover, keep Ship paused until the first full certification passes.
`git config tedix.pushGateProfile full` retains
complete local proof; unsetting it restores the fast default.
The other checks stay in CI. `bun run verify` retains the complete profile;
`--ci-policy --all` runs the repository checks in CI. Full workspace suites cover
the consumer checks previously selected by `vitest related`.

For the initial CI bootstrap, operations can pause new deployment plans while
fast pushes install this workflow and its fixes. Restore planning only after
certification passes and green-only selection is enforced.

Ops watches successful main certification every 15 seconds and wakes Ship
using its existing workflow token. The watcher renews itself and has an hourly
recovery schedule; Ship retains its hourly fallback. Ship independently
resolves and verifies the newest certified main commit and its `Main CI`
aggregate. No Actions secret is added to this repository, and pushing hosts
need no completion daemon or authenticated `gh` session.

The repository observer reports only failed runs that still match main's tip,
using the exact workflow attempt's failed shards. One `ci_red` Work observation
is deduplicated by repository, SHA and surface; it carries the pushing commit's
Work trailer when present. The API must ship `ci_red` support before reporting
can succeed. Older API deployments reject this event.

After runner setup, dispatch the workflow and record its exact SHA, aggregate,
per-shard durations, total CI duration, and runner identities:

```sh
gh workflow run full-suite-hourly.yml --ref main
gh run view <run-id> --json status,conclusion,headSha,createdAt,updatedAt,jobs
```

Push wall time includes queue waiting. Push-to-live starts when the remote
accepts the commit and ends at the guarded deployment's surface SHA readback.
A green aggregate, a queued Ship, and a live revision are separate receipts.
