/**
 * Regression test for the body-neutral session contract `selectSessionContext`
 * — the single guard against cross-conversation context bleed (P0). Pure
 * function ⇒ plain `node:assert`, no Worker harness.
 * Run: `bun run src/session-harness.test.ts`.
 */
import assert from "node:assert/strict";
import {
	mergeDurableAndCache,
	projectDurableCompaction,
	renderReplayCheckpoint,
	SessionHarness,
	type SessionHarnessBackend,
	selectSessionContext,
	type TediSessionContextEntry,
	type TediSessionTurn,
} from "./session-harness";

const replayFingerprint = `sha256:${"b".repeat(64)}`;
const replayCheckpoint = {
	version: 1 as const,
	coveredThroughEntryId: "e2",
	capabilityBindings: [
		{ id: "binding-1", namespace: "work", fingerprint: replayFingerprint },
	],
	artifactRevisions: [
		{
			id: "artifact-1",
			revision: "rev-1",
			fingerprint: replayFingerprint,
		},
	],
	pendingApprovals: [
		{
			id: "approval-1",
			status: "pending" as const,
			fingerprint: replayFingerprint,
		},
	],
	workReferences: [
		{
			id: "work-1",
			kind: "work_item" as const,
			fingerprint: replayFingerprint,
		},
	],
	toolResultDependencies: [
		{ id: "event-1", toolCallId: "call-1", fingerprint: replayFingerprint },
	],
	contextSources: [
		{ id: "e1", kind: "ledger_message", fingerprint: replayFingerprint },
	],
	truncated: false,
	checkpointDigest: replayFingerprint,
};

// Attachment-only messages are content, including after a cold-cache rebuild.
{
	const attachment = {
		type: "image" as const,
		content: "stored-ref",
		fileName: "screen.png",
		mimeType: "image/png",
	};
	const turn = {
		role: "user" as const,
		content: "",
		attachments: [attachment],
		sessionKey: "chat-a",
		ts: 1,
	};
	assert.equal(
		selectSessionContext([turn], "chat-a", { requireContent: true }).length,
		1,
	);
	assert.equal(
		selectSessionContext([turn], "chat-b", { requireContent: true }).length,
		0,
	);
	const harness = new SessionHarness({
		listTurns: () => [],
		appendTurn: () => false,
		readMessages: async () => [turn],
	});
	assert.deepEqual(
		await harness.buildContext("chat-a", { requireContent: true }),
		[{ role: "user", content: "", attachments: [attachment] }],
	);
}

// A structured checkpoint survives projection beside the summary while making
// its non-authoritative replay semantics explicit.
{
	const projected = projectDurableCompaction(
		[
			{ id: "e1", role: "user", content: "old", ts: 10 },
			{ id: "e2", role: "user", content: "kept", ts: 20 },
		],
		{
			summary: "summary",
			firstKeptEntryId: "e2",
			tokensBefore: 20,
			checkpoint: replayCheckpoint,
		},
	);
	assert.equal(projected.length, 3);
	assert.equal(projected[1]?.content, renderReplayCheckpoint(replayCheckpoint));
	assert.match(projected[1]?.content ?? "", /revalidate capabilities/);
	assert.match(projected[1]?.content ?? "", /artifact-1/);
}

// ── Durable D1 compaction projection is body-neutral and non-destructive ─────
{
	const entries = [
		{ id: "e1", role: "user" as const, content: "old-q", ts: 10 },
		{ id: "e2", role: "assistant" as const, content: "old-a", ts: 20 },
		{ id: "e3", role: "user" as const, content: "kept-q", ts: 30 },
		{ id: "e4", role: "assistant" as const, content: "kept-a", ts: 40 },
	];
	const projected = projectDurableCompaction(entries, {
		summary: "summary of old history",
		firstKeptEntryId: "e3",
		tokensBefore: 100,
	});
	assert.deepEqual(
		projected.map((entry) => `${entry.role}:${entry.content}:${entry.ts}`),
		[
			"assistant:summary of old history:29",
			"user:kept-q:30",
			"assistant:kept-a:40",
		],
		"summary replaces the pre-cut prefix and leads the retained tail",
	);
	assert.equal(entries.length, 4, "projection does not mutate durable entries");
}

// A bounded durable page can begin after firstKeptEntryId. Preserve the entire
// returned page after the summary instead of discarding valid recent messages.
{
	const page = [
		{ id: "e4", role: "assistant" as const, content: "kept-a", ts: 40 },
		{ id: "e5", role: "user" as const, content: "new-q", ts: 50 },
	];
	assert.deepEqual(
		projectDurableCompaction(page, {
			summary: "summary",
			firstKeptEntryId: "e3",
			tokensBefore: 100,
		}).map((entry) => entry.content),
		["summary", "kept-a", "new-q"],
		"a page newer than the cut remains intact",
	);
}

const turns: TediSessionTurn[] = [
	{
		role: "user",
		content: "ALPHA marker for chat A",
		sessionKey: "chat:A",
		ts: 1,
	},
	{ role: "assistant", content: "ack A", sessionKey: "chat:A", ts: 2 },
	{
		role: "user",
		content: "BRAVO marker for chat B",
		sessionKey: "chat:B",
		ts: 3,
	},
	{ role: "assistant", content: "ack B", sessionKey: "chat:B", ts: 4 },
	{ role: "user", content: "   ", sessionKey: "chat:A", ts: 5 }, // empty-ish
];

// ── CORE REGRESSION: chat B context MUST NOT include chat A's turns ──────────
{
	const ctxB = selectSessionContext(turns, "chat:B");
	assert.equal(ctxB.length, 2);
	assert.ok(
		!ctxB.some((m) => /ALPHA/.test(m.content)),
		"B must not see A's ALPHA marker (cross-session bleed)",
	);
	assert.deepEqual(
		ctxB.map((m) => m.content),
		["BRAVO marker for chat B", "ack B"],
	);
}

// ── chat A sees only A ──────────────────────────────────────────────────────
{
	const ctxA = selectSessionContext(turns, "chat:A");
	assert.ok(
		ctxA.every((m) => !/BRAVO/.test(m.content)),
		"A must not see B's BRAVO marker",
	);
}

// ── requireContent drops empty turns ────────────────────────────────────────
assert.equal(
	selectSessionContext(turns, "chat:A", { requireContent: true }).length,
	2,
	"empty chat:A turn (ts=5) dropped under requireContent",
);
assert.equal(
	selectSessionContext(turns, "chat:A").length,
	3,
	"without requireContent the empty turn stays",
);

// ── excludeUserTs drops the in-flight user turn ─────────────────────────────
assert.ok(
	!selectSessionContext(turns, "chat:A", { excludeUserTs: 1 }).some((m) =>
		m.content.includes("ALPHA marker"),
	),
	"ts=1 user turn excluded by excludeUserTs",
);

// ── empty sessionKey defaults to agent:main:main ────────────────────────────
assert.equal(
	selectSessionContext(
		[{ role: "user", content: "x", sessionKey: "", ts: 1 }],
		"agent:main:main",
	).length,
	1,
	"empty sessionKey defaults to agent:main:main",
);

// ── SessionHarness over a mock backend ──────────────────────────────────────
{
	const stored: TediSessionTurn[] = [...turns];
	const ledger: Record<string, TediSessionContextEntry[]> = {
		"chat:A": [{ role: "user", content: "durable A", ts: 1 }],
	};
	// The mock backend threads the optional idempotencyKey and returns a
	// load-bearing boolean (did-insert), matching the Stage 3 contract.
	let lastKey: string | undefined;
	const backend: SessionHarnessBackend = {
		listTurns: () => stored,
		appendTurn: (t, idempotencyKey) => {
			lastKey = idempotencyKey;
			stored.push(t);
			return true;
		},
		readMessages: async (sk) => ledger[sk] ?? [],
	};
	const harness = new SessionHarness(backend);

	// buildContext is session-scoped (delegates to selectSessionContext)
	assert.ok(
		!(await harness.buildContext("chat:B")).some((m) =>
			/ALPHA/.test(m.content),
		),
		"harness.buildContext is session-scoped",
	);
	// appendTurn stamps sessionKey + persists, threads the key, returns the bool
	const inserted = await harness.appendTurn(
		"chat:C",
		{ role: "user", content: "hi C", ts: 9, sessionKey: "ignored" },
		"run-9:0",
	);
	assert.equal(
		inserted,
		true,
		"appendTurn surfaces the backend's did-insert bool",
	);
	assert.equal(
		lastKey,
		"run-9:0",
		"appendTurn threads the idempotencyKey to the backend",
	);
	assert.equal(
		(await harness.buildContext("chat:C")).length,
		1,
		"appendTurn persisted under the passed sessionKey, not the turn's",
	);
	assert.equal(stored[stored.length - 1]?.sessionKey, "chat:C");
}

// ── LEDGER-FIRST / BODY-SWAP: cold cache reconstructs from the durable ledger ─
// A fresh/rebound DO (isolate↔runtime body swap, DO eviction, cold start) has
// no `recentTurns`; the cache holds ONLY the in-flight user turn while the prior
// conversation history lives in the durable transcript (D1 ledger). buildContext
// MUST reconstruct the full prompt history from the ledger + the in-flight tail.
{
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "u1 prior question", ts: 10 },
		{ role: "assistant", content: "a1 prior answer", ts: 20 },
	];
	const coldCache: TediSessionTurn[] = [
		{ role: "user", content: "u2 in-flight", sessionKey: "chat:X", ts: 99 },
	];
	const harness = new SessionHarness({
		listTurns: () => coldCache,
		appendTurn: () => true,
		readMessages: async () => durable,
	});
	const ctx = await harness.buildContext("chat:X");
	assert.deepEqual(
		ctx.map((m) => m.content),
		["u1 prior question", "a1 prior answer", "u2 in-flight"],
		"cold cache: prior history reconstructed from ledger + in-flight tail",
	);
}

// ── WARM cache: committed turns are not duplicated (ledger overlaps cache) ────
{
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "u1", ts: 1 },
		{ role: "assistant", content: "a1", ts: 2 },
	];
	const warmCache: TediSessionTurn[] = [
		{ role: "user", content: "u1", sessionKey: "chat:Y", ts: 1 },
		{ role: "assistant", content: "a1", sessionKey: "chat:Y", ts: 2 },
		{ role: "user", content: "u2 in-flight", sessionKey: "chat:Y", ts: 3 },
	];
	const harness = new SessionHarness({
		listTurns: () => warmCache,
		appendTurn: () => true,
		readMessages: async () => durable,
	});
	const ctx = await harness.buildContext("chat:Y");
	assert.deepEqual(
		ctx.map((m) => m.content),
		["u1", "a1", "u2 in-flight"],
		"warm cache: committed turns not duplicated, in-flight tail appended",
	);
}

// ── buildContext degrades to the cache when the durable read throws ──────────
{
	const harness = new SessionHarness({
		listTurns: () => [
			{ role: "user", content: "cache only", sessionKey: "chat:Z", ts: 1 },
		],
		appendTurn: () => true,
		readMessages: async () => {
			throw new Error("D1 down");
		},
	});
	const ctx = await harness.buildContext("chat:Z");
	assert.deepEqual(
		ctx.map((m) => m.content),
		["cache only"],
		"durable read failure degrades to cache, never throws from a prompt build",
	);
}

// ── pure mergeDurableAndCache edge cases (ts-keyed) ──────────────────────────
assert.deepEqual(
	mergeDurableAndCache([{ role: "user", content: "a", ts: 1 }], []).map(
		(m) => m.content,
	),
	["a"],
	"empty cache → durable only",
);
assert.deepEqual(
	mergeDurableAndCache([], [{ role: "user", content: "b", ts: 1 }]).map(
		(m) => m.content,
	),
	["b"],
	"empty durable → cache only",
);
assert.deepEqual(
	mergeDurableAndCache(
		[
			{ role: "user", content: "u1", ts: 1 },
			{ role: "assistant", content: "a1", ts: 2 },
		],
		[
			{ role: "user", content: "u1", ts: 1 },
			{ role: "assistant", content: "a1", ts: 2 },
		],
	).map((m) => m.content),
	["u1", "a1"],
	"fully-overlapping cache adds nothing (no duplication)",
);
// mesh excludeUserTs: the durable read's cache-fallback re-includes the in-flight
// raw user turn (ts 3), but the cache base excluded it. ts >= cacheStart drops it.
assert.deepEqual(
	mergeDurableAndCache(
		[
			{ role: "user", content: "u1", ts: 1 },
			{ role: "assistant", content: "a1", ts: 2 },
			{ role: "user", content: "RAW in-flight (excluded by caller)", ts: 3 },
		],
		[
			{ role: "user", content: "u1", ts: 1 },
			{ role: "assistant", content: "a1", ts: 2 },
		],
	).map((m) => m.content),
	["u1", "a1"],
	"excludeUserTs: in-flight turn in durable-fallback is not re-introduced",
);
// Ledger ahead of the cache (cache evicted older turns): durable prefix (ts < the
// cache window's earliest ts) is back-filled.
assert.deepEqual(
	mergeDurableAndCache(
		[
			{ role: "user", content: "old-u", ts: 1 },
			{ role: "assistant", content: "old-a", ts: 2 },
			{ role: "user", content: "recent-u", ts: 3 },
		],
		[{ role: "user", content: "recent-u", ts: 3 }],
	).map((m) => m.content),
	["old-u", "old-a", "recent-u"],
	"ledger back-fills the prefix the cache evicted",
);
// ── FINDING 2 REGRESSION: repeated/identical content must NOT drop history ────
// Two identical "ok"/"done" turn pairs. A content-keyed merge would match the
// cache's first "ok" against the EARLIEST durable "ok" (idx 0), compute an empty
// prefix, and silently drop the first pair. ts-keyed merge keeps the full log.
{
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "ok", ts: 1 },
		{ role: "assistant", content: "done", ts: 2 },
		{ role: "user", content: "ok", ts: 3 },
		{ role: "assistant", content: "done", ts: 4 },
	];
	const cache: TediSessionContextEntry[] = [
		{ role: "user", content: "ok", ts: 3 },
		{ role: "assistant", content: "done", ts: 4 },
		{ role: "user", content: "new question", ts: 5 },
	];
	assert.deepEqual(
		mergeDurableAndCache(durable, cache).map((m) => `${m.role}:${m.content}`),
		[
			"user:ok",
			"assistant:done",
			"user:ok",
			"assistant:done",
			"user:new question",
		],
		"repeated content: ts-keyed merge keeps the full history (no drop)",
	);
}

console.log("session-harness.test.ts: all assertions passed");
