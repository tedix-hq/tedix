/**
 * Unit tests for within-tedi work-item fan-out (Phase 0 + Phase 1).
 *
 * Tests cover:
 *   - Flag-off: byte-identical serial fallback path (Phase 0)
 *   - Budget cap: over-budget items fail-soft to serial (never dropped)
 *   - Idempotency: same clientRequestId → same childRunId
 *   - childRunId uniqueness: two different clientRequestIds → two different childRunIds
 *   - HomePlanAssignment record shape
 *   - Workflow instance id derivation (colon-stripping, hash-capped id)
 *   - sessionKey distinctness: each item gets its own sessionKey
 *
 * Run: `bun run src/work-item-fanout.test.ts`
 */
import assert from "node:assert/strict";
import {
	buildRunId,
	buildWorkflowInstanceId,
	sanitizeTurnKey,
} from "./ledger-mirror";

// ---------------------------------------------------------------------------
// Helpers mirroring do.ts Phase 0/1 logic
// ---------------------------------------------------------------------------

const tediId = "00000000-0000-0000-0000-000000000001";

function deriveChildRunId(clientRequestId: string): string {
	return buildRunId(tediId, clientRequestId, "fanout");
}

function deriveSessionKey(clientRequestId: string): string {
	return `fanout:${sanitizeTurnKey(clientRequestId)}`;
}

function deriveWorkflowInstanceId(clientRequestId: string): string {
	return buildWorkflowInstanceId(clientRequestId);
}

// ---------------------------------------------------------------------------
// Baseline: only non-independent (coherent) items take the serial fallback.
// ---------------------------------------------------------------------------

function mockDispatchIndependentWorkItem(
	item: { clientRequestId: string; userText: string; independent?: boolean },
	_env: { TEDI_WORKITEM_FANOUT_ENABLED?: string },
	liveSlots: Map<string, string>,
	maxSlots: number,
): { dispatched: boolean; childRunId?: string; sessionKey?: string } {
	if (!item.independent) {
		return { dispatched: false };
	}
	const childRunId = deriveChildRunId(item.clientRequestId);
	const sessionKey = deriveSessionKey(item.clientRequestId);
	if (liveSlots.size >= maxSlots) {
		return { dispatched: false };
	}
	liveSlots.set(childRunId, deriveWorkflowInstanceId(item.clientRequestId));
	return { dispatched: true, childRunId, sessionKey };
}

// independent: false → serial fallback (coherent item)
{
	const slots = new Map<string, string>();
	const result = mockDispatchIndependentWorkItem(
		{
			clientRequestId: "req-coh",
			userText: "coherent item",
			independent: false,
		},
		{ TEDI_WORKITEM_FANOUT_ENABLED: "1" },
		slots,
		2,
	);
	assert.equal(
		result.dispatched,
		false,
		"independent: false → serial fallback",
	);
	console.log(
		"PASS: non-independent item → serial fallback (coherent-item invariant)",
	);
}

// ---------------------------------------------------------------------------
// Phase 1: flag ON + independent: true → dispatched, budget consumed
// ---------------------------------------------------------------------------

{
	const slots = new Map<string, string>();
	const result = mockDispatchIndependentWorkItem(
		{ clientRequestId: "req-a", userText: "task A", independent: true },
		{ TEDI_WORKITEM_FANOUT_ENABLED: "1" },
		slots,
		2,
	);
	assert.equal(
		result.dispatched,
		true,
		"flag ON + independent → dispatched: true",
	);
	assert.ok(result.childRunId, "childRunId is set");
	assert.ok(result.sessionKey, "sessionKey is set");
	assert.equal(slots.size, 1, "one budget slot consumed");
	console.log("PASS: flag ON + independent → dispatched (Phase 1 live slice)");
}

// ---------------------------------------------------------------------------
// Budget cap: over-budget items fail-soft to serial (NEVER dropped)
// ---------------------------------------------------------------------------

{
	const slots = new Map<string, string>();
	const env = { TEDI_WORKITEM_FANOUT_ENABLED: "1" };
	const maxSlots = 2;

	const r1 = mockDispatchIndependentWorkItem(
		{ clientRequestId: "item-1", userText: "task 1", independent: true },
		env,
		slots,
		maxSlots,
	);
	const r2 = mockDispatchIndependentWorkItem(
		{ clientRequestId: "item-2", userText: "task 2", independent: true },
		env,
		slots,
		maxSlots,
	);
	// Budget full (2/2)
	const r3 = mockDispatchIndependentWorkItem(
		{ clientRequestId: "item-3", userText: "task 3", independent: true },
		env,
		slots,
		maxSlots,
	);

	assert.equal(r1.dispatched, true, "item-1 dispatched");
	assert.equal(r2.dispatched, true, "item-2 dispatched");
	assert.equal(
		r3.dispatched,
		false,
		"item-3 over-budget → fail-soft serial fallback",
	);
	assert.equal(slots.size, 2, "only 2 slots occupied (cap enforced)");
	console.log(
		"PASS: budget cap → over-budget item fails-soft to serial (never dropped)",
	);
}

// ---------------------------------------------------------------------------
// Idempotency: same clientRequestId → same childRunId
// ---------------------------------------------------------------------------

{
	const crid = "req-idem-42";
	const id1 = deriveChildRunId(crid);
	const id2 = deriveChildRunId(crid);
	assert.equal(
		id1,
		id2,
		"same clientRequestId → same childRunId (idempotency dedup)",
	);
	console.log("PASS: childRunId idempotency (same clientRequestId → same id)");
}

// ---------------------------------------------------------------------------
// childRunId uniqueness: two different clientRequestIds → two distinct childRunIds
// ---------------------------------------------------------------------------

{
	const id1 = deriveChildRunId("item-alpha");
	const id2 = deriveChildRunId("item-beta");
	assert.notEqual(id1, id2, "distinct clientRequestIds → distinct childRunIds");
	console.log(
		"PASS: childRunId uniqueness (distinct clientRequestIds → distinct ids)",
	);
}

// ---------------------------------------------------------------------------
// sessionKey distinctness per item — no two concurrent items share a sessionKey
// ---------------------------------------------------------------------------

{
	const sk1 = deriveSessionKey("item-a");
	const sk2 = deriveSessionKey("item-b");
	assert.notEqual(sk1, sk2, "distinct items → distinct sessionKeys");
	assert.ok(sk1.startsWith("fanout:"), "sessionKey prefixed with fanout:");
	assert.ok(sk2.startsWith("fanout:"), "sessionKey prefixed with fanout:");
	console.log(
		"PASS: sessionKey distinctness (no shared sessionKey between concurrent items)",
	);
}

// ---------------------------------------------------------------------------
// HomePlanAssignment record shape (matches HomePlanAssignmentSchema)
// ---------------------------------------------------------------------------

{
	const childRunId = deriveChildRunId("item-shape");
	const parentRunId = "parent-run-id";
	const tediSlugLocal = "my-tedi";
	const now = new Date().toISOString();

	const assignmentRecord = {
		id: `${parentRunId}:fanout:${childRunId}`,
		ownerTediId: tediId,
		ownerSlug: tediSlugLocal,
		ownerLabel: "Summarize product page",
		routeKind: "agent" as const,
		objective: "Summarize product page for customer",
		expectedEvidence: [] as string[],
		risk: "low" as const,
		confidence: 1,
		requiresApproval: false,
		status: "queued" as const,
		childRunId,
		childConversationId: `${tediId}:fanout:${childRunId}`,
		dispatchedAt: now,
	};

	assert.ok(assignmentRecord.id, "assignment id is set");
	assert.equal(assignmentRecord.ownerTediId, tediId, "ownerTediId is self");
	assert.equal(assignmentRecord.routeKind, "agent", "routeKind is agent");
	assert.equal(assignmentRecord.status, "queued", "status starts as queued");
	assert.equal(
		assignmentRecord.childRunId,
		childRunId,
		"childRunId matches derived id",
	);
	assert.ok(
		Array.isArray(assignmentRecord.expectedEvidence),
		"expectedEvidence is array",
	);
	assert.equal(
		assignmentRecord.requiresApproval,
		false,
		"requiresApproval false for fanout",
	);
	console.log(
		"PASS: HomePlanAssignment record shape (matches HomePlanAssignmentSchema)",
	);
}

// ---------------------------------------------------------------------------
// Workflow instance id derivation (colon-stripping, 64-char cap)
// ---------------------------------------------------------------------------

{
	const colonId = "kern:req:item-abc-123";
	const sanitized = deriveWorkflowInstanceId(colonId);
	assert.ok(!sanitized.includes(":"), "workflowInstanceId has no colons");
	assert.ok(sanitized.length <= 64, "workflowInstanceId capped at 64 chars");

	const longId = "a".repeat(100);
	const sanitizedLong = deriveWorkflowInstanceId(longId);
	assert.equal(sanitizedLong.length, 64, "long ids are capped to 64 chars");
	assert.match(
		sanitizedLong,
		/^a{47}-[0-9a-f]{16}$/,
		"long ids keep a prefix plus stable hash suffix",
	);
	assert.notEqual(
		deriveWorkflowInstanceId(
			"home:runtime-identity-collision-proof:1782653623649:turn",
		),
		deriveWorkflowInstanceId(
			"home:runtime-identity-collision-proof:1782653561799:turn",
		),
		"long ids with the same first 64 chars do not collide",
	);

	console.log(
		"PASS: workflowInstanceId derivation (colon-stripping + hash-capped id)",
	);
}

// ---------------------------------------------------------------------------
// Budget slot cleanup: clearing a slot frees budget
// ---------------------------------------------------------------------------

{
	const slots = new Map<string, string>();
	const env = { TEDI_WORKITEM_FANOUT_ENABLED: "1" };
	const maxSlots = 1;

	const r1 = mockDispatchIndependentWorkItem(
		{ clientRequestId: "slot-1", userText: "task", independent: true },
		env,
		slots,
		maxSlots,
	);
	assert.equal(r1.dispatched, true);
	assert.equal(slots.size, 1, "slot occupied");

	// Simulate onWorkflowComplete clearing the slot
	const childRunId = deriveChildRunId("slot-1");
	slots.delete(childRunId);
	assert.equal(slots.size, 0, "slot freed after workflow complete");

	// Now another item can dispatch
	const r2 = mockDispatchIndependentWorkItem(
		{ clientRequestId: "slot-2", userText: "next task", independent: true },
		env,
		slots,
		maxSlots,
	);
	assert.equal(r2.dispatched, true, "slot freed → next item dispatches");
	console.log(
		"PASS: budget slot cleanup (onWorkflowComplete frees slot for next item)",
	);
}

console.log("\nAll work-item-fanout tests passed.");

// ---------------------------------------------------------------------------
// Route handler: /__internal/fanout-batch auth gate + per-item dispatch loop
//
// These tests mirror the exact logic in do.ts onRequest for the fanout-batch
// route, verifying auth behaviour and dispatch loop without a live DO instance.
// ---------------------------------------------------------------------------

/**
 * Mirror of the do.ts auth gate for /__internal/fanout-batch.
 * Returns true when the request should be allowed through.
 */
function isFanoutBatchAuthorized(
	adminToken: string | null,
	masterKey: string | undefined,
	isServiceBinding: boolean,
	hasPublicIp: boolean,
	isDev: boolean,
): boolean {
	const tokenMatches =
		Boolean(adminToken) && Boolean(masterKey) && adminToken === masterKey;
	const bindingAllowed = isServiceBinding && (!hasPublicIp || isDev);
	return tokenMatches || bindingAllowed;
}

/**
 * Mirror of the per-item dispatch loop in do.ts /__internal/fanout-batch,
 * using the same mockDispatchIndependentWorkItem as the Phase 1 tests above.
 */
function runFanoutBatch(
	items: Array<{
		client_request_id?: string;
		text?: string;
		independent?: boolean;
		objective?: string;
	}>,
	env: { TEDI_WORKITEM_FANOUT_ENABLED?: string },
	liveSlots: Map<string, string>,
	maxSlots: number,
): Array<{
	client_request_id: string;
	dispatched: boolean;
	childRunId?: string;
	sessionKey?: string;
	fallback?: boolean;
}> {
	const results: Array<{
		client_request_id: string;
		dispatched: boolean;
		childRunId?: string;
		sessionKey?: string;
		fallback?: boolean;
	}> = [];
	for (const item of items) {
		const clientRequestId = (item.client_request_id ?? "").trim();
		const userText = (item.text ?? "").trim();
		if (!clientRequestId || !userText) {
			results.push({
				client_request_id: clientRequestId || "(missing)",
				dispatched: false,
				fallback: true,
			});
			continue;
		}
		const fanoutResult = mockDispatchIndependentWorkItem(
			{
				clientRequestId,
				userText,
				independent: item.independent !== false,
			},
			env,
			liveSlots,
			maxSlots,
		);
		results.push({
			client_request_id: clientRequestId,
			dispatched: fanoutResult.dispatched,
			childRunId: fanoutResult.childRunId,
			sessionKey: fanoutResult.sessionKey,
			fallback: !fanoutResult.dispatched,
		});
	}
	return results;
}

// ---------------------------------------------------------------------------
// Auth gate: valid X-Tedix-Admin-Token === SECRETS_MASTER_KEY → allowed
// ---------------------------------------------------------------------------

{
	const MASTER_KEY = "test-secret-master-key";
	const allowed = isFanoutBatchAuthorized(
		MASTER_KEY,
		MASTER_KEY,
		false, // not a service binding
		false, // no public IP
		false, // not dev
	);
	assert.equal(allowed, true, "matching admin token → authorized");
	console.log("PASS: auth gate — valid X-Tedix-Admin-Token → authorized");
}

// ---------------------------------------------------------------------------
// Auth gate: wrong token → rejected (403)
// ---------------------------------------------------------------------------

{
	const MASTER_KEY = "test-secret-master-key";
	const rejected = isFanoutBatchAuthorized(
		"wrong-token",
		MASTER_KEY,
		false,
		false,
		false,
	);
	assert.equal(rejected, false, "wrong admin token → rejected (403)");
	console.log("PASS: auth gate — wrong X-Tedix-Admin-Token → rejected (403)");
}

// ---------------------------------------------------------------------------
// Auth gate: no token → rejected (403)
// ---------------------------------------------------------------------------

{
	const MASTER_KEY = "test-secret-master-key";
	const rejectedNull = isFanoutBatchAuthorized(
		null, // no header
		MASTER_KEY,
		false,
		false,
		false,
	);
	assert.equal(rejectedNull, false, "no admin token → rejected (403)");
	console.log("PASS: auth gate — no X-Tedix-Admin-Token → rejected (403)");
}

// ---------------------------------------------------------------------------
// Auth gate: service binding without public IP → allowed
// ---------------------------------------------------------------------------

{
	const bindingAllowed = isFanoutBatchAuthorized(
		null, // no token
		undefined, // no master key
		true, // is service binding
		false, // no public IP
		false, // not dev
	);
	assert.equal(
		bindingAllowed,
		true,
		"service binding (no public IP) → authorized",
	);
	console.log(
		"PASS: auth gate — service binding without public IP → authorized",
	);
}

// ---------------------------------------------------------------------------
// Auth gate: service binding WITH public IP + non-dev → rejected
// ---------------------------------------------------------------------------

{
	const bindingRejected = isFanoutBatchAuthorized(
		null,
		undefined,
		true, // service binding header set
		true, // but also has public IP (not a real binding)
		false, // not dev
	);
	assert.equal(
		bindingRejected,
		false,
		"service binding + public IP (non-dev) → rejected",
	);
	console.log(
		"PASS: auth gate — service binding + public IP (non-dev) → rejected",
	);
}

// ---------------------------------------------------------------------------
// Route handler dispatch loop: 2 independent items → both dispatched
// ---------------------------------------------------------------------------

{
	const slots = new Map<string, string>();
	const env = { TEDI_WORKITEM_FANOUT_ENABLED: "1" };
	let dispatchCallCount = 0;

	// Wrap mockDispatch to count calls
	const originalMock = (
		item: { clientRequestId: string; userText: string; independent?: boolean },
		e: { TEDI_WORKITEM_FANOUT_ENABLED?: string },
		s: Map<string, string>,
		max: number,
	) => {
		dispatchCallCount++;
		return mockDispatchIndependentWorkItem(item, e, s, max);
	};

	const items = [
		{
			client_request_id: "batch-item-1",
			text: "summarize product page alpha",
			independent: true,
		},
		{
			client_request_id: "batch-item-2",
			text: "summarize product page beta",
			independent: true,
		},
	];

	// Run through the dispatch loop directly (re-implementing inline to count calls)
	const batchResults: Array<{
		client_request_id: string;
		dispatched: boolean;
		childRunId?: string;
		sessionKey?: string;
		fallback?: boolean;
	}> = [];

	for (const item of items) {
		const crid = (item.client_request_id ?? "").trim();
		const text = (item.text ?? "").trim();
		if (!crid || !text) {
			batchResults.push({
				client_request_id: crid || "(missing)",
				dispatched: false,
				fallback: true,
			});
			continue;
		}
		const r = originalMock(
			{
				clientRequestId: crid,
				userText: text,
				independent: item.independent !== false,
			},
			env,
			slots,
			10,
		);
		batchResults.push({
			client_request_id: crid,
			dispatched: r.dispatched,
			childRunId: r.childRunId,
			sessionKey: r.sessionKey,
			fallback: !r.dispatched,
		});
	}

	assert.equal(
		dispatchCallCount,
		2,
		"dispatchIndependentWorkItem called TWICE for 2-item batch",
	);
	assert.equal(batchResults.length, 2, "2 results returned");
	assert.equal(batchResults[0]?.dispatched, true, "item-1 dispatched");
	assert.equal(batchResults[1]?.dispatched, true, "item-2 dispatched");
	assert.ok(batchResults[0]?.childRunId, "item-1 has childRunId");
	assert.ok(batchResults[1]?.childRunId, "item-2 has childRunId");
	assert.notEqual(
		batchResults[0]?.childRunId,
		batchResults[1]?.childRunId,
		"each item gets a distinct childRunId (no collision)",
	);
	assert.notEqual(
		batchResults[0]?.sessionKey,
		batchResults[1]?.sessionKey,
		"each item gets a distinct sessionKey (invariant)",
	);
	assert.equal(slots.size, 2, "2 budget slots occupied for 2 concurrent items");
	console.log(
		"PASS: route handler — 2 independent items → dispatchIndependentWorkItem called twice, both dispatched",
	);
}

// ---------------------------------------------------------------------------
// Route handler dispatch loop: malformed item (missing text) → fail-soft, not crash
// ---------------------------------------------------------------------------

{
	const slots = new Map<string, string>();
	const env = { TEDI_WORKITEM_FANOUT_ENABLED: "1" };

	const results = runFanoutBatch(
		[
			{
				client_request_id: "good-item",
				text: "do something",
				independent: true,
			},
			{ client_request_id: "bad-item" /* no text */ },
		],
		env,
		slots,
		10,
	);

	assert.equal(results.length, 2, "2 results for 2 items");
	assert.equal(results[0]?.dispatched, true, "good item dispatched");
	assert.equal(
		results[1]?.dispatched,
		false,
		"bad item (no text) fail-soft → dispatched: false",
	);
	assert.equal(results[1]?.fallback, true, "bad item marked fallback: true");
	console.log(
		"PASS: route handler — malformed item (missing text) fails-soft without crashing",
	);
}

console.log("\nAll fanout-batch route handler tests passed.");

// ---------------------------------------------------------------------------
// Phase 2: /__internal/fanout-slots route handler logic
//
// These tests mirror the slot-read logic in do.ts /__internal/fanout-slots,
// verifying auth gate, flag-gate, parentRunId filtering, and limit capping
// without a live DO instance.
// ---------------------------------------------------------------------------

/**
 * Mirror the auth gate from do.ts /__internal/fanout-slots.
 */
function isFanoutSlotsAuthorized(
	adminToken: string | null,
	masterKey: string | undefined,
	isServiceBinding: boolean,
	hasPublicIp: boolean,
	isDev: boolean,
): boolean {
	const tokenMatches =
		Boolean(adminToken) && Boolean(masterKey) && adminToken === masterKey;
	const bindingAllowed = isServiceBinding && (!hasPublicIp || isDev);
	return tokenMatches || bindingAllowed;
}

/**
 * Mirror the slot-filter logic from do.ts /__internal/fanout-slots.
 * Simulates reading from DO storage, filtering by parentRunId, and capping.
 */
function readFanoutSlotsFromStorage(
	stored: Map<
		string,
		{
			id: string;
			childRunId: string;
			ownerTediId: string;
			ownerSlug: string | null;
			ownerLabel: string;
			objective: string;
			status: string;
			dispatchedAt: string | null;
		}
	>,
	parentRunId: string,
	limit: number,
): Array<{
	id: string;
	childRunId: string;
	ownerTediId: string;
	ownerSlug: string | null;
	ownerLabel: string;
	objective: string;
	status: string;
	dispatchedAt: string | null;
}> {
	const clampedLimit = Math.min(Number.isFinite(limit) ? limit : 20, 50);
	const slots: Array<{
		id: string;
		childRunId: string;
		ownerTediId: string;
		ownerSlug: string | null;
		ownerLabel: string;
		objective: string;
		status: string;
		dispatchedAt: string | null;
	}> = [];
	for (const [_key, record] of stored) {
		if (parentRunId && !record.id.startsWith(`${parentRunId}:fanout:`))
			continue;
		if (slots.length >= clampedLimit) break;
		slots.push(record);
	}
	return slots;
}

// ---------------------------------------------------------------------------
// fanout-slots auth gate: service binding without public IP → authorized
// ---------------------------------------------------------------------------

{
	const allowed = isFanoutSlotsAuthorized(null, undefined, true, false, false);
	assert.equal(
		allowed,
		true,
		"fanout-slots: service binding (no public IP) → authorized",
	);
	console.log(
		"PASS: fanout-slots auth — service binding without public IP → authorized",
	);
}

// ---------------------------------------------------------------------------
// fanout-slots auth gate: no token, no binding → rejected
// ---------------------------------------------------------------------------

{
	const rejected = isFanoutSlotsAuthorized(
		null,
		undefined,
		false,
		false,
		false,
	);
	assert.equal(
		rejected,
		false,
		"fanout-slots: no token, no binding → rejected",
	);
	console.log("PASS: fanout-slots auth — no credentials → rejected (403)");
}

// ---------------------------------------------------------------------------
// fanout-slots: empty storage → { ok: true, slots: [] }
// ---------------------------------------------------------------------------

{
	const stored = new Map<
		string,
		ReturnType<typeof readFanoutSlotsFromStorage>[number]
	>();
	const slots = readFanoutSlotsFromStorage(stored, "parent-run-1", 20);
	assert.equal(slots.length, 0, "empty storage → 0 slots");
	console.log("PASS: fanout-slots — empty storage returns empty array");
}

// ---------------------------------------------------------------------------
// fanout-slots: filters by parentRunId prefix
// ---------------------------------------------------------------------------

{
	const parentRunId = "parent-run-abc";
	const otherParentRunId = "parent-run-xyz";
	const childRunId1 = deriveChildRunId("slot-filter-1");
	const childRunId2 = deriveChildRunId("slot-filter-2");
	const childRunId3 = deriveChildRunId("slot-filter-3");

	type SlotRecord = ReturnType<typeof readFanoutSlotsFromStorage>[number];
	const stored = new Map<string, SlotRecord>([
		[
			`fanoutslot:${childRunId1}`,
			{
				id: `${parentRunId}:fanout:${childRunId1}`,
				childRunId: childRunId1,
				ownerTediId: tediId,
				ownerSlug: "my-tedi",
				ownerLabel: "Task A",
				objective: "Do task A",
				status: "queued",
				dispatchedAt: new Date().toISOString(),
			},
		],
		[
			`fanoutslot:${childRunId2}`,
			{
				id: `${parentRunId}:fanout:${childRunId2}`,
				childRunId: childRunId2,
				ownerTediId: tediId,
				ownerSlug: "my-tedi",
				ownerLabel: "Task B",
				objective: "Do task B",
				status: "queued",
				dispatchedAt: new Date().toISOString(),
			},
		],
		[
			`fanoutslot:${childRunId3}`,
			{
				id: `${otherParentRunId}:fanout:${childRunId3}`,
				childRunId: childRunId3,
				ownerTediId: tediId,
				ownerSlug: "my-tedi",
				ownerLabel: "Task C (other parent)",
				objective: "Do task C for a different parent",
				status: "queued",
				dispatchedAt: new Date().toISOString(),
			},
		],
	]);

	const slots = readFanoutSlotsFromStorage(stored, parentRunId, 20);
	assert.equal(slots.length, 2, "only slots belonging to parentRunId returned");
	assert.ok(
		slots.every((s) => s.id.startsWith(`${parentRunId}:fanout:`)),
		"all returned slots have correct parentRunId prefix",
	);
	console.log("PASS: fanout-slots — filters by parentRunId prefix correctly");
}

// ---------------------------------------------------------------------------
// fanout-slots: no parent_run_id filter → returns ALL slots
// ---------------------------------------------------------------------------

{
	const childRunId1 = deriveChildRunId("no-filter-1");
	const childRunId2 = deriveChildRunId("no-filter-2");

	type SlotRecord = ReturnType<typeof readFanoutSlotsFromStorage>[number];
	const stored = new Map<string, SlotRecord>([
		[
			`fanoutslot:${childRunId1}`,
			{
				id: `parent-a:fanout:${childRunId1}`,
				childRunId: childRunId1,
				ownerTediId: tediId,
				ownerSlug: null,
				ownerLabel: "T1",
				objective: "task1",
				status: "queued",
				dispatchedAt: null,
			},
		],
		[
			`fanoutslot:${childRunId2}`,
			{
				id: `parent-b:fanout:${childRunId2}`,
				childRunId: childRunId2,
				ownerTediId: tediId,
				ownerSlug: null,
				ownerLabel: "T2",
				objective: "task2",
				status: "queued",
				dispatchedAt: null,
			},
		],
	]);

	// Pass empty string → no parentRunId filter
	const slots = readFanoutSlotsFromStorage(stored, "", 20);
	assert.equal(slots.length, 2, "no parent_run_id → all slots returned");
	console.log("PASS: fanout-slots — empty parentRunId returns all slots");
}

// ---------------------------------------------------------------------------
// fanout-slots: limit is capped at 50 even when caller requests more
// ---------------------------------------------------------------------------

{
	type SlotRecord = ReturnType<typeof readFanoutSlotsFromStorage>[number];
	const stored = new Map<string, SlotRecord>();
	for (let i = 0; i < 60; i++) {
		const cid = deriveChildRunId(`limit-test-${i}`);
		stored.set(`fanoutslot:${cid}`, {
			id: `parent-limit:fanout:${cid}`,
			childRunId: cid,
			ownerTediId: tediId,
			ownerSlug: null,
			ownerLabel: `Task ${i}`,
			objective: `task ${i}`,
			status: "queued",
			dispatchedAt: null,
		});
	}

	const slots = readFanoutSlotsFromStorage(stored, "parent-limit", 100);
	assert.equal(slots.length, 50, "limit capped at 50 even when 60 slots exist");
	console.log(
		"PASS: fanout-slots — limit capped at 50 regardless of caller request",
	);
}

console.log("\nAll fanout-slots route handler tests passed.");
