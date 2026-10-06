/**
 * Standalone assertions for the pure `/__admin/agent-diag` + `/__admin/dequeue`
 * helpers. Run directly: `bun run src/admin-agent-diag.test.ts`.
 *
 * No vitest/cloudflare:workers harness needed — these are pure functions, so a
 * plain `node:assert` file keeps the check zero-dependency while the rest of the
 * agent runtime stays untestable in this offline harness.
 */
import assert from "node:assert/strict";
import {
	isAdminAuthorized,
	parseDequeueBody,
	summarizeQueue,
} from "./admin-agent-diag";

// --- isAdminAuthorized: mirrors the /__admin/workflow-* guard exactly --------

function authRequest(headers: HeadersInit = {}): Request {
	return new Request("https://tedi-runtime/__admin/test", { headers });
}

// Shared-secret token path.
assert.equal(
	await isAdminAuthorized({
		request: authRequest({ "X-Tedix-Admin-Token": "secret" }),
		masterKey: "secret",
	}),
	true,
	"matching admin token authorizes even over public IP",
);
// Token mismatch is rejected.
assert.equal(
	await isAdminAuthorized({
		request: authRequest({ "X-Tedix-Admin-Token": "wrong" }),
		masterKey: "secret",
	}),
	false,
	"mismatched admin token is rejected",
);
// Fail-closed: no master key configured => token path can never pass.
assert.equal(
	await isAdminAuthorized({
		request: authRequest({ "X-Tedix-Admin-Token": "anything" }),
		masterKey: undefined,
	}),
	false,
	"absent master key fails closed on the token path",
);
// A trusted service binding authorizes.
assert.equal(
	await isAdminAuthorized({
		request: authRequest({ "X-Service-Binding": "true" }),
		masterKey: undefined,
	}),
	true,
	"trusted service binding authorizes",
);
// Neither a binding nor a token is rejected.
assert.equal(
	await isAdminAuthorized({
		request: authRequest({}),
		masterKey: "secret",
	}),
	false,
	"request with neither binding marker nor token is rejected",
);

// --- summarizeQueue: depth + newest-first bounded list -----------------------

const queueSummary = summarizeQueue(
	[
		{ id: "a", callback: "onBridgeTurn", created_at: 100 },
		{ id: "b", callback: "onLedgerMirror", created_at: 300 },
		{ id: "c", callback: "onBridgeTurn", created_at: 200 },
	],
	2,
);
assert.equal(queueSummary.depth, 3, "depth counts every row");
assert.deepEqual(
	queueSummary.recent.map((r) => r.id),
	["b", "c"],
	"recent is newest-first and respects the limit",
);
assert.equal(summarizeQueue([]).depth, 0, "empty queue has depth 0");

// --- parseDequeueBody: validation + fail-soft --------------------------------

assert.deepEqual(
	parseDequeueBody({}),
	{ ok: true, value: {} },
	"empty body means drain-all",
);
assert.deepEqual(
	parseDequeueBody(null),
	{ ok: true, value: {} },
	"null body means drain-all",
);
assert.deepEqual(
	parseDequeueBody({ callback: "onBridgeTurn" }),
	{ ok: true, value: { callback: "onBridgeTurn" } },
	"callback is preserved",
);
assert.deepEqual(
	parseDequeueBody({ callback: "  onLedgerMirror  ", cancelSchedules: true }),
	{ ok: true, value: { callback: "onLedgerMirror", cancelSchedules: true } },
	"callback is trimmed; cancelSchedules passes through",
);
assert.equal(
	parseDequeueBody({ callback: 5 }).ok,
	false,
	"non-string callback is rejected",
);
assert.equal(
	parseDequeueBody({ callback: "   " }).ok,
	false,
	"whitespace-only callback is rejected",
);
assert.equal(
	parseDequeueBody({ cancelSchedules: "yes" }).ok,
	false,
	"non-boolean cancelSchedules is rejected",
);

console.log("admin-agent-diag: all assertions passed");
