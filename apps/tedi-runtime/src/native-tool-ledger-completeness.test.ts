/**
 * Completeness proof for native tool telemetry across a mid-turn restart.
 *
 * If the Durable Object restarts mid-turn and the ledger's per-run call counter
 * restarts with it, every event id it issues from then on is one the run has
 * already written, and `insertTediRuntimeEvent` drops a duplicate id in silence
 * (`onConflictDoNothing`). Execution continues and the telemetry does not, so
 * the run reads as a tedi that stopped working.
 *
 * The sink here applies exactly that rule — first write per id wins, later ones
 * are discarded — and the run is enumerated from it afterwards, the way
 * `cognitive.list_cognitive_runtime_events` enumerates a real one. The D1 half
 * of the contract (that `insertTediRuntimeEvent` really does drop a re-issued
 * id, and that 60 distinct ids all come back) is pinned beside the query, in
 * `packages/db/src/queries/cognitive-runtime.event-identity.test.ts`.
 */

import assert from "node:assert/strict";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { NativeToolLedger } from "./native-tool-ledger";

const RUN_ID = "tedi-1:mcp:delegate-1";
/** Well past the eviction point below. */
const TOOL_CALLS = 60;
/** The call at which the Durable Object is evicted and a fresh one takes over. */
const RESTART_AFTER = 22;

/** The ledger as D1 sees it: one row per id, first write wins. */
const ledgerRows = new Map<string, TediRuntimeEvent>();
async function writeToLedger(event: TediRuntimeEvent): Promise<void> {
	if (ledgerRows.has(event.id)) return;
	ledgerRows.set(event.id, event);
}

/** The provider call id the run's nth tool call carries. */
function callId(call: number): string {
	return `toolu_${call.toString().padStart(4, "0")}`;
}

/** The row id the run's nth `tool.started` must land under. */
function startedId(call: number): string {
	return `${RUN_ID}:native-tool.${callId(call)}.started`;
}

const context = {
	tediId: "tedi-1",
	runId: RUN_ID,
	conversationId: "cto:agent:main:delegation-1",
};

/** The gap the production turn spent restarting before it resumed. */
const RESTART_GAP_MS = 6 * 60_000;
const realNow = Date.now;

let ledger = new NativeToolLedger(writeToLedger);
for (let call = 0; call < TOOL_CALLS; call += 1) {
	// One eviction mid-run, exactly where the production turn lost its telemetry.
	if (call === RESTART_AFTER) {
		Date.now = () => realNow() + RESTART_GAP_MS;
		ledger = new NativeToolLedger(writeToLedger);
	}
	await ledger.observe(
		context,
		{
			name: "exec",
			// The AI SDK/provider call id: fresh per call, wherever the run executes.
			callId: callId(call),
			args: {
				command: `sed -n '${call},${call + 20}p' apps/tedi-runtime/src/do.ts`,
			},
		},
		async () => ({ ok: true, exitCode: 0, executionId: `exec-${call}` }),
	);
}
Date.now = realNow;

const rows = [...ledgerRows.values()];
const started = rows.filter((row) => row.kind === "tool.started");
const completed = rows.filter((row) => row.kind === "tool.completed");
assert.equal(
	started.length,
	TOOL_CALLS,
	`every tool call survives the turn (got ${started.length} of ${TOOL_CALLS})`,
);
assert.equal(completed.length, TOOL_CALLS, "each call closes its bracket");

// Every call is enumerable under its own id — including the last one. The read
// that misled the supervisor was "last tool call at 09:34", six minutes early.
const ids = new Set(started.map((row) => row.id));
for (let call = 0; call < TOOL_CALLS; call += 1) {
	assert.ok(ids.has(startedId(call)), `call ${call} never reached the ledger`);
}

// The sequence cursor does not rewind to the run's base when a fresh instance
// takes over. Under the old bases (`600` for steps, `100000 + 2n` for native
// calls) the restarted instance re-issued the run's opening values, which is
// what made the ids collide.
const sequenceById = new Map(started.map((row) => [row.id, row.sequence!]));
const firstSequence = sequenceById.get(startedId(0))!;
for (let call = RESTART_AFTER; call < TOOL_CALLS; call += 1) {
	assert.ok(
		sequenceById.get(startedId(call))! > firstSequence,
		`call ${call} sequenced back at the run's base after the restart`,
	);
}

console.log(
	`Native tool ledger completeness: ${TOOL_CALLS} calls across a mid-run restart, all enumerable`,
);
