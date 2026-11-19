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

## Shard rerun

`shard-rerun.yml` runs one workspace shard at one exact main commit on demand
(`workflow_dispatch` with `sha`, `workspace`, `test_script`, `shard` and a
`label` that becomes the run title). It runs outside the `main-certification`
group and certifies nothing. A repair agent can use it to reproduce a failed
shard or check a focused fix.

## Advisory high-risk review

The independent `Advisory high-risk review` job runs only for push ranges
matching `HIGH_RISK_PATHS` in `scripts/ci/high-risk-paths.mjs`. That explicit
list is the complete policy; unknown paths and UI-only pushes skip review.
It uses the push event's before/head range, including deleted paths, rather
than the broader certification range. Scheduled/manual runs skip it. An
unavailable push base is reported in the plan summary rather than represented
as a reviewed range.

The job has `continue-on-error: true`, runs alongside tests and is absent from
`Main CI` dependencies. Its four-minute timeout and 150-second model budget
bound advisory cost; neither findings nor reviewer failure grants approval or
blocks certification. Measure actual job start/completion timestamps from
Actions on a high-risk push; the receipt's elapsed seconds measure only the
review command, excluding checkout/setup/upload. The target is at most four
minutes, with no aggregate or commit-to-live dependency.

It uses `claude -p` with the checked-in `.agents/skills/code-review/SKILL.md`
instructions and a structured findings schema. Each finding requires severity,
a changed file and a positive line number. Tools are disabled and the reviewer
receives only Claude credentials. Existing `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY` secrets may supply authentication; empty secrets or an
absent skill produce a notice and an unavailable-review receipt. This change
provisions no secret. At introduction neither repository nor organization
exposed these secrets, and this checkout contained no code-review skill.

Current incidents use repository-observer OIDC, not a reusable board credential
for `tedix -w connect work comment`. Consequently findings and receipts are
printed in the run summary and attached as `high-risk-review-<sha>-<attempt>`
artifacts for 30 days. The receipt links every unique `Work-Item:` trailer in
the pushed commits, not just the final commit. Board posting requires a later
change once an existing CI board identity is available; do not repurpose the
observer token or add a secret here.

Each artifact records SHA, push base, run URL, review status, findings count,
findings and elapsed seconds. Skipped/failed reviews have a null count, never a
false zero. After 14 days from the first completed review, a human or agent
adjudicates each finding by run URL and finding number on its linked Work:
`precision: run=<url> finding=<n> wrong|correct; reason=<evidence>`. Post a cohort
note with `wrong / adjudicated`, total findings and unadjudicated counts, plus
job duration distribution and timeout/skip counts. Do not treat unadjudicated
findings as correct or include unavailable runs in the denominator. No blocking
mode is enabled; a separate brief follows measured precision. The source lane
Work tracks the first high-risk run and UI-only skip proof; the two-week cohort
cannot be measured before reviews actually run.
