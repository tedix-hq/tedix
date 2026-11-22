# Main certification

For an urgent pipeline cutover, `bun run push --priority` waits for the current
holder, then precedes ordinary waiting tickets without changing validation.
When upgrading the queue itself, `--queue-candidate` pins committed local queue
code only after proving it contains freshly fetched main; rebase before using it.
Normal pushes always load the fetched main version.

`full-suite-hourly.yml` runs on main pushes and manual dispatch. Pushes use
its policy gate and `Main CI` aggregate. `main-verify.yml` checks affected
workspace types after pushes with the separate `Main verify` aggregate.
Manual dispatch of `full-suite-hourly.yml` runs unit, integration, browser
and repository tests.

Affected verification includes transitive workspace consumers and earlier
changes since the latest successful type check. Docs-only ranges skip
workspace checks. Unknown paths, shared configuration, and missing history
select all workspaces. The planner is `scripts/ci/full-suite-hourly.mjs`.

The private ops healer also reads historical and manual workflow results.
The automatic type check emits no workspace test shard for it to bisect.
Managed Ship configuration belongs to the private ops repository.

Workspace and repository shards default to GitHub-hosted `ubuntu-latest`.
Standard hosted runners are free for this public repository. Set
`FULL_SUITE_RUNNER_LABELS` to a JSON array to override the runner labels.
A self-hosted Cloudflare pool is a later optimization, not a rollout dependency.
This workflow replaces the old scoped push CI; release and pull-request
certification remain in `oss-public-ci.yml`.

The local hook checks changed formatting, lint, secrets, scripts types and
selected policy invariants. Main verify runs workspace type checks.
`git config tedix.pushGateProfile full` retains
complete local proof; unsetting it restores the fast default.
The other checks stay in CI. `bun run verify` retains the complete profile;
`--ci-policy --all` runs the repository checks in CI. Full workspace suites cover
the consumer checks previously selected by `vitest related`.

Ship runs from the private ops repository every four hours. It also runs on
manual dispatch and on private main pushes that change the production overlay
or deployment values. Ship selects the newest product main commit certified
by the `Main CI` aggregate.

The repository observer reports pushes and certification results for runs that
still match main's tip. A failed result includes the exact workflow attempt's
failed jobs. Results carry the commit's Work trailer when present.

After runner setup, dispatch the workflow and record its exact SHA, aggregate,
per-shard durations, total CI duration, and runner identities:

```sh
gh workflow run full-suite-hourly.yml --ref main
gh run view <run-id> --json status,conclusion,headSha,createdAt,updatedAt,jobs
```

Push wall time includes queue waiting. Push-to-live starts when the remote
accepts the commit and ends at the guarded deployment's surface SHA readback.
A green aggregate, a queued Ship, and a live revision are separate receipts.

## Shard rerun

`shard-rerun.yml` runs one workspace shard at one exact main commit on demand
(`workflow_dispatch` with `sha`, `workspace`, `test_script`, `shard` and a
`label` that becomes the run title). It runs outside the `main-certification`
group and certifies nothing. A repair agent can use it to reproduce a failed
shard or check a focused fix.

## Tests after deploy and nightly

`hosted-suite.yml` runs tests that never block a deploy. It runs on free
GitHub-hosted `ubuntu-latest` only (it ignores `FULL_SUITE_RUNNER_LABELS`),
outside the `main-certification` group. Its `Hosted suite` aggregate is not
`Main CI`, so neither Ship nor the push gate reads it.

- After deploy: every 10 minutes a `Post-deploy tests (watch)` run reads
  `deployedSha` from the api, os and builder `/health` endpoints. Ship deploys
  only the services a commit changes, so the live commit is the newest report
  that the other reports are ancestors of. A live commit without a
  `Hosted suite / post-deploy` commit status is tested once: the run tests the
  workspaces affected since the last passing post-deploy run, so a failed
  range is tested again until a later run passes. The aggregate job's name,
  `Hosted suite @ <sha>`, records the tested commit. An idle watch run ends
  after the plan job. Runs come from the schedule, not from a `GITHUB_TOKEN`
  dispatch, because GitHub starts no `workflow_run` for runs that token
  creates and the observer listens for one. To test one live commit on
  demand, dispatch the workflow with `sha`.
- Nightly: at 02:17 UTC, `Nightly full suite @ <sha>` runs every workspace
  suite and the repository checks at main's tip. To run the full suite on
  demand, dispatch the workflow with `full` set.

`tedix-observer.yml` reports completed runs to the repository observer.
Failures on the `post-deploy` or `hosted-full` surface become `Red CI` repair
Work for the observer tedi. A later passing run on the same surface settles
those failures.
