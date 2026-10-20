# Hourly full suite

`full-suite-hourly.yml` runs at minute 17 each hour and supports manual dispatch
on `main`. Every job checks out the event's exact main SHA. A successful run of
this workflow for that SHA skips subsequent runs; cancelled and failed runs do
not count. New hourly or manual runs cancel older runs of this lane.

Set the repository variable `FULL_SUITE_RUNNER_LABELS` to a JSON array of the
existing Cloudflare runner labels before enabling this workflow. The planner
fails explicitly if labels are missing. Planning uses a GitHub-hosted runner;
workspace and repository checks use the configured runners.

The matrix discovers every `apps/*` and `packages/*` workspace with `test:run`
or `type-check`, including type-only packages. All shards finish after a test
failure so the observer can report every failing workspace together. Repository
checks also run script tests, script types and public documentation validation.

The existing `tedix-observer.yml` handles failed completed runs with GitHub
OIDC and `TEDIX_OBSERVER_URL`; no new secret is required. It reads jobs from
the failed run's exact attempt and submits one `ci_red` observation containing
the tested SHA and failed jobs. Work identity and notification delivery are
deduplicated by repository, SHA and `full-suite-hourly` surface. The API must
include `ci_red` support before failure reporting can succeed; older deployments
reject the new event.

To verify after landing and runner configuration:

```sh
gh workflow run full-suite-hourly.yml --ref main
gh run list --workflow full-suite-hourly.yml --event workflow_dispatch
gh run view <run-id> --json status,conclusion,headSha,createdAt,updatedAt,jobs
```

Record the tested SHA, run URL, elapsed duration and per-workspace outcomes.
Dispatching again at the same SHA verifies the successful-SHA skip path.
