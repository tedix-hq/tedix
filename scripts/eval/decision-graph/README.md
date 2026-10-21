# Decision graph measurement

This evaluator reads the supported Tedix CLI Code Mode APIs. It never writes
cards, decisions, graph edges or ranking signals. Publication is a separate
operator step, after reviewing the report and its ground-truth samples.

Run fictional fixtures without credentials or model calls:

```sh
bun scripts/eval/decision-graph/run.mjs --fixture --out /tmp/decision-graph-fixture
bun test scripts/eval/decision-graph/measure.test.ts
```

For live measurement, supply the actual writer, backfill and stored-reader
commits and both installation health URLs. The runner checks that all commits are on
`origin/main` and ancestors of each surface's full `deployedSha` before reading
any cards. A deployment receipt does not prove the backfill completed; verify
its scheduled-run receipt separately before claiming graph coverage.

```sh
TEDIX_AGENT_SESSION=<your-verified-session> bun scripts/eval/decision-graph/run.mjs \
  --organization <authorized-org> --profile <profile> \
  --writers-sha <full-sha> --backfill-sha <full-sha> \
  --reader-sha <full-sha> \
  --health-url <https-os-health-url> --api-health-url <https-api-health-url> \
  --out /tmp/decision-graph-live
```

Use owner authentication to measure that person's Deck; an external agent's
inbox is a different cohort. Existing authorization and grants remain enforced.
Every CLI call discovers an exact read-only callable before using it. History
uses the inbox cursor in descending `requestedAt` order, stopping at thirty
days, exhaustion, or `--max-pages` (default 1000). One interaction per page
avoids gateway truncation on large card bodies. Current factory/runtime/Work
approval projections are inventoried and conservatively protected; their
historical ledgers are outside this collector's thirty-day interaction cohort.
Missing contexts, unmapped cards, incomplete inventories and page bounds are
visible in the report. They must not be described as complete organization-wide
results.
The Deck read explicitly requests `presentation: "stored"`, which bypasses
presentation generation and persistence. The evaluator never requests a ranker
run.
It reads the caller's Deck timezone from `get_preferences` (UTC when unset),
independently of the organization's learning timezone. Known transient read
availability errors retry up to five times with bounded backoff; permission,
capacity and schema gates stop the run. Each history page is checkpointed to
the private snapshot before continuing.

The text baseline replays `planDeckSweep` from commit
`11420939c40d6a304b20b13e552fa3be1b382c1b`, frozen in `text-baseline.ts` before
graph qualification replaced its text matching. It
reports actions separately from fuzzy already-decided proposals and retains
the sweep's per-run retirement cap. Live sweep configuration and learned rules
come from `get_decision_learning`; rules are restricted to the observed
recipients. `--baseline-config <private-json>` permits an explicitly recorded
configuration override for a controlled comparison. Fixtures use versioned
defaults. A separate production comparison calls the current `planDeckSweep`,
`classifyDeckAsk` and `compareDecisionFreshness` helpers with supported graph
contexts. It retains the retirement cap and samples its recommendations for
the main precision table. Its rank comparison isolates `countBlocked` on shared
survivors. Card creation gates and the service's additional duplicate-subject
decision lookup are outside this replay and must not be claimed as measured.

Graph recommendations are a shadow policy over G1's exact context contract:
prior decisions (excluding the card's own answer), supersession, and duplicate
links with one newer keeper. Protected and owner-authored cards stay. These
counts need comparison with the production graph gate before claiming identical
behavior. Historical cards use today's graph and default Deck routing, including
previously resolved cards: these are retrospective opportunities, not current
removable cards or a time-travel replay. Rule counts can overlap; unique
removals and additional removals versus text matching count each card once.
Ranking compares the same survivors: current observed order (historical
`ruleRankDeck`) against direct `blocksCount` within existing priority tiers.

`sample-to-label.json` selects up to twenty candidates per rule by a stable
hash, independently of labels. Check every selected row against recorded owner
decisions, owner Not useful reasons, or dated Work completion evidence. Add
`correct` (boolean), `evidenceRef`, `sourceType`, `observedAt`, and `note` to
checked rows; omit unknown rows from the labels file. The graph edge alone is
not independent ground truth. False examples remain in the denominator.
Report checked precision together with unknown count, label coverage and any
shortfall below twenty; a zero candidate cohort has unmeasured precision.

Re-score saved evidence without further live calls:

```sh
bun scripts/eval/decision-graph/run.mjs \
  --snapshot /tmp/decision-graph-live/snapshot.json \
  --labels /tmp/decision-graph-labels.json --out /tmp/decision-graph-labelled
```

Evidence contains private organization content. Keep all snapshots, labels,
JSON results and report Markdown outside the source repository. The evaluator
writes files with private permissions. Publish the reviewed report to the
authorized Tedix OS Workspace Output, then read back its current revision.
Fixture numbers are synthetic accounting checks, never live product value.
