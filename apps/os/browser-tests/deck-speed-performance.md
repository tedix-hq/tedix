# Deck decision measurements — 19 October 2026

Baseline: `ca303b3cff878b732fb09f27fd1eb60aace492da`, including the landed
r2-work layout. [Raw samples](deck-speed-performance.results.json) record the results.

The existing Vite fixture server serves the real `/work?view=deck` route.
The browser supplies a fictional installed Deck and six recipient-scoped cards,
empty approvals and learning history, and a 500 ms response delay. Each latency
sample uses a fresh Chromium context, a 390×844 viewport and 4× CPU slowdown.
The measure starts at the decision button's click handler and ends on an
animation frame when the second card has a nonzero box and opacity above 0.9.
It excludes confirmation time and initial route loading.

| Measurement                                         |         Before |        After |
| --------------------------------------------------- | -------------: | -----------: |
| Chromium next-card median, five samples             |       765.8 ms |      66.5 ms |
| Chromium next-card range                            | 745.5–802.0 ms | 62.2–71.3 ms |
| WebKit next-card, iPhone 13 viewport                |   not measured |        22 ms |
| All API RPC requests in 121 idle seconds on `/work` |             26 |           10 |
| API requests per minute, normalized                 |          12.89 |         4.96 |

RPC queries use POST, so the traffic counter includes both HTTP methods.
It excludes initial route loading and the decision writes used by the latency
samples. The request count includes unchanged billing polling and lifecycle
telemetry. Uncovered fixture telemetry handlers still fail; these measurements
are local browser/API traffic, not production D1 statement counts or Cloud latency.

The first optimistic version still took 155–167 ms because the card entrance
fade lasted 240 ms. Live Deck cards now render without that fade; practice
cards and swipe transforms retain their existing motion.

The prefetch owner is the mounted, filtered Deck, so it warms the current card
and the next three in display order. Route and Work-home warmups no longer
start competing detail windows. One shared queue serializes speculative
interaction/runtime-approval reads; Work approvals already contain their detail.
Unmount releases queued reads and cancels unobserved active reads.

Optimistic Query removal covers ordinary and infinite inbox pages and approval
lists. A failed write restores only its own row, preserves concurrent decisions
and newer rows, returns focus to the failed card, and shows an error toast.
A single decision reconciliation pass runs after overlapping writes settle.
Existing confirmation and server version/authority checks remain in the write path.

Work inboxes have no organization-wide event subscription in the existing
Cap’n Web transport. Its runtime approval projection remains intact. The
changed Deck, Feed, approval-notification and Attention polls use a 120-second
fallback, pause when hidden, and reconcile on window focus/visibility and own
writes. No new realtime transport is introduced. A browser regression also
verifies that two successive window-focus events each refetch the inbox.

Chromium `Page.getInstallabilityErrors` returned an empty error list.
The test checks manifest MIME, standalone display, `/work` start URL and iOS
capability metadata. The Worker test separately checks manifest MIME and private,
no-store headers. Icons derive from the existing apple-touch icon and colours
match the default OS background tokens. There is no service worker or offline
API cache.

Playwright WebKit verifies touch-pointer drag, the 90 px/direction threshold,
short/vertical gesture rejection, immediate progression and failed-write rollback
with an error toast. Pointer completion clears the legacy touch fallback to
prevent duplicate decisions. These are browser-generated pointer events in an
emulated iPhone viewport; physical-device gesture arbitration and Add to Home
Screen remain unverified. No haptics are added.

Run `bun run --cwd apps/os test:browser:deck-speed` after
`bunx playwright install chromium webkit`. The harness owns and removes its
fixture server. `DECK_SPEED_BASELINE=1` and `DECK_SPEED_CWD=<baseline apps/os>`
run the same measurements against a clean baseline checkout.
`DECK_SPEED_RESULTS=<path>` saves receipts. `DECK_SPEED_POLL_MS=0` skips the
traffic window for focused gesture/installability checks; it produces no rate.

Validation: OS type-check, full test:run (Vitest, workerd and existing browser
suites), the new speed browser test, and lint:repo. Source push, Cloud deployment,
and physical iPhone installation are separate claims; this lane does not deploy.
