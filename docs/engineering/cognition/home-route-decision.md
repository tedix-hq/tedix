---
title: Home route decision model
summary: Shadow evaluation and opt-in two-step Home routing
read_when:
  - Evaluating or configuring Home route selection
---

# Home route decision model

Home can ask Clef to choose one of the six route kinds and, for delegation or
handoff, one target from the current visible roster. This choice does not grant
permission. The existing route guard, dispatch policy, approval, billing and
cancellation checks still apply.

The policy lives in D1 organization metadata, under
`jev.purposes.homeRoute`, and is validated by `JevSettingsSchema`. The existing
organization update contract can change it. Preserve the other metadata and
Jev purpose values when updating the policy.

```json
{
	"mode": "shadow",
	"model": "@cf/cloudflare/clef-flash",
	"minConfidence": 0.85,
	"timeoutMs": 1500,
	"shadowTurns": 100
}
```

`shadow` is the default. `off` skips judgments. `enforce` applies an eligible
choice only when both its winning-option probability and reported confidence
reach the threshold. Delegation also requires the chosen live target's
probability and confidence to reach it. Distributions must include every option,
contain finite probabilities, sum to approximately one, and name a maximum
probability option. Malformed, unavailable, timed-out, image-bearing and
low-confidence turns use the current full router.

In shadow mode the judgment starts alongside the current route writer and never
changes its decision. `shadowTurns` is the evaluation sample target, not an
automatic promotion counter. Collect at least that many eligible observations,
inspect disagreements and confidence buckets against human corrections, then
explicitly update `mode` to `enforce` if the evidence supports it. Agreement with
the old router is a comparison, not proof of correctness. No code automatically
promotes a tenant or changes its policy.

Each judged turn logs `kernel.route_decision` and, when a route exists, retains
`kernelRoute.routeDecision` on its run. The record includes the model, mode,
threshold, option distributions, target-option IDs, execution IDs, decision
latency, router latency, final route/target agreement and whether the choice was
applied. It excludes message and answer text. Failed route generation still
produces the structured log. `kernelTurnTimings` remains the source of Home's
first-answer timing; report its timed sample size separately from all turns.
Exclude replay runs, explicit delegations and wake turns when reporting the
normal automatic-routing cohort. A model-unavailable terminal failure is not
necessarily a malformed JSON response; provider stalls can produce it too.

Under enforcement the generative model receives only the selected route's
fields. Direct answers contain just `answer`; action routes contain common
rationale/risk/effort/evidence fields plus their own action details. The server
stamps the route, target and decision confidence. Irrelevant capability lists
are omitted from writer context. A writer cannot change the chosen target.
Invalid action details get one bounded retry, then a question asking the user
to retry; no invented tool or dispatch arguments are executed. A confident
choice does not show the old routing-trouble notice.

Judgments use the existing governed executor and Cloudflare transport. Admission
and rate resolution stay awaited. A real Worker/DO lifetime holder bounds the
whole decision wait and retains both pending dispatch completion and usage
persistence; usage writes may finish after the decision. Callers without a
lifetime holder await completion. Receipt failures retain the existing retry
and reconciliation evidence. Direct unmetered calls are not used.

The offline replay suite contains two fictionalized recorded approval-stage
Work creation failures plus six synthetic route scenarios. It tests policy,
probabilities, streaming, target locking and recovery using supplied judgments;
it does not measure Clef's semantic routing quality. Live shadow metrics must
come from deployed observations, with the actual sample count and model latency.
