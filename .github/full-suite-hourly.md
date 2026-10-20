# Main certification

`full-suite-hourly.yml` runs on every main push, hourly, and manual dispatch.
Runs share concurrency group `main`; a newer tip cancels older certification.
The required aggregate is `Main CI`. Every discovered workspace runs its full
`test:ci` (or `test:run`) and type-check. Repository checks retain script tests,
public docs, generated types, migration validation, builds, licenses and lint.
The latest successful certification of the same SHA can be reused by the hourly
run. A newer failed or pending run prevents reuse of an older success.

Workspace and repository shards default to GitHub-hosted `ubuntu-latest`.
Standard hosted runners are free for this public repository. Set
`FULL_SUITE_RUNNER_LABELS` to a JSON array to override the runner labels.
A self-hosted Cloudflare pool is a later optimization, not a rollout dependency.
This workflow replaces the old scoped push CI; release and pull-request
certification remain in `oss-public-ci.yml`.

The local hook defaults to its complete gate during rollout. Only after the
operator proves runners, failure reporting, and green-only deployment should
`git config tedix.pushGateProfile fast` activate owner types, changed formatting,
Oxlint, architecture/dependency lint, and the fail-closed private secret scan.
The other checks stay in CI. `bun run verify` retains the complete profile;
`--ci-policy --all` runs the repository checks in CI. Full workspace suites cover
the consumer checks previously selected by `vitest related`.

In fast mode, `bun run push` starts a detached completion observer using the
existing `gh` session. It checks every 15 seconds for up to 30 minutes and wakes
ops only after this push, or a main descendant containing it, passes CI. Ops
independently resolves and verifies the newest green main commit. No Actions
secret is added. Logs are in the common Git directory's `ci-completion.log`.
An unavailable `gh` session or an expired observer leaves the scheduled fallback
active; immediate notification requires the pushing host to remain running.

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
