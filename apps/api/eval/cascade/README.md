# Cascade evaluation

This is an evaluation foundation, not a production cascade or a calibrated
model policy. The versioned candidate is off. Its confidence threshold of 0.9
is a proposal; raw confidence is not a correctness probability. No live model,
latency, cost or cache result has been measured for this corpus.

`fixtures.ts` fixes 10 fictional calibration cases and 10 separate holdout
cases before provider measurement. Gold labels never enter the model input.
Use the calibration partition to select thresholds; freeze the chosen policy
revision before running the holdout. Never tune against holdout answers.

`decision-cascade.ts` in the API services directory implements the evaluation
controller. It accepts trusted adapters; it is not connected to Home routing.
An adapter must dispatch each judgment through the governed Jev executor and
each prose request through the configured kernel model adapter, with admission
and paid usage persistence on every send. It must disable response caching for
independent samples, retain token-prefix cache accounting, enforce monetary
budgets and deadlines, and supply actual resolved model and execution receipts.
Three separate dispatches do not establish statistical independence. The host
citation validator must check source access, freshness and semantic support;
membership in the supplied source list alone is insufficient.
The controller awaits this validator and supplies the request, source excerpts
and full proposal, including prose. A rejected check stops further inference;
a negative check escalates or abstains. The host validator remains to be wired.

`dispatchCascadeJev` in `decision-cascade-jev.ts` implements the judgment send
through `executeJevJudgment`. It requests a label choice and bounded citation
choices in one admitted call, never a brief. Its receipt is published only after
the canonical usage write settles, retaining the actual resolved model and
governed cost. A rejected paid response retains its receipt with unknown model;
missing receipts stop further spending. Citation choices remain advisory until
the host validates semantic support, access and freshness. This adapter has
source tests only; it has not been exercised against a live provider.

Typed admission/budget/accounting denials stop the controller. Unavailable and
uncertain judgments escalate only when all receipt attribution is known.
No proposal authorizes execution. Reserved acts
return to their designated owner before inference. Roll back by selecting the
previous immutable policy revision or setting `mode` to `off`.

Run the offline report from the repository root:

```sh
bun apps/api/eval/cascade/report.ts
bun apps/api/eval/cascade/report.ts /path/to/measured-rows.json
```

Measurement rows follow `CascadeMeasurementSchema`. Capture end-to-end elapsed
time, every paid receipt including invalid/failed responses, actual resolved
model, cache token counts and governed cost. Record independent brief quality
against the cited source and observed correction separately; unknown is null.
Use at least three distinct repeats per case and arm. Baseline and cascade must
use the same corpus, source versions and strong-model configuration. Keep
measurement files with private/provider identifiers in OS evidence, not source.

The grader rejects duplicate rows and reused execution IDs. Missing prices,
usage persistence, resolved models, quality/correction scores or repetitions
cannot qualify a measurement set. Replay tests exercise control flow and
grading only. Report each partition separately. Summed cache tokens grouped by
resolved model are descriptive; they do not establish causal savings.

The report compares each partition only when both arms have complete provider
measurements and matching case/repeat identities. Deltas are cascade minus
baseline. `noRegression` requires no decrease in label accuracy or brief quality,
no increase in false successes, correction rate, p95 latency or total cost, and
no reserved-act violation in either arm. Missing or unpaired evidence leaves
the comparison unknown. These are descriptive checks, not a promotion decision:
the host must still prove matching source versions and strong-model configuration,
freeze the policy revision and review calibration thresholds before holdout.

`results.json` records the initial not-run state. Regenerate it only from
sanitized verified measurements and retain the corpus digest and configuration
revision in the associated OS evidence. It must not be replaced with test-double
results described as provider measurements.

Remaining implementation: admitted prose adapters, host citation validation,
live runner wiring and calibration, production routing behind measured promotion,
removal of any remaining caller-owned model policy, and a
verified optimizer receipt only when an eligible executor/model really changes.
No optimizer application is implemented or claimed here.
