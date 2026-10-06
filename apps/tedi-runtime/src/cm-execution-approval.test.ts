/**
 * Tests for the CodemodeRuntime approval facet:
 *   - CmExecutionStore (DO-SQLite ledger)
 *   - CmSessionGate (DO KV allowlist)
 *   - Gate semantics: parked when unauthorized, runs when explicitly
 *     session-authorized or exact-replay-authorized, audit row recorded both ways.
 */

import assert from "node:assert/strict";
import { CmSessionGate } from "./cm-execution-gate";
import {
	CmExecutionStore,
	type CmResolvedBy,
	hashCode,
} from "./cm-execution-store";

// ── Minimal in-memory SQL runner (mirrors DoDedupStore tests) ────────────────

import { Database } from "bun:sqlite";

function makeSqlRunner() {
	const db = new Database(":memory:");
	return {
		sql<T = Record<string, string | number | boolean | null>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			let query = "";
			for (let i = 0; i < strings.length; i++) {
				query += strings[i];
				if (i < values.length) {
					query += "?";
				}
			}
			const q = query.trim();
			if (/^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(q)) {
				db.run(q, values);
				return [] as T[];
			}
			return db.query(q).all(...values) as T[];
		},
	};
}

// ── Minimal in-memory KV store (mirrors CmSessionGate storage interface) ─────

function makeKvStore(): {
	get(key: string): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
} {
	const store = new Map<string, string>();
	return {
		async get(key: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
	};
}

// ── 1. hashCode produces stable hex ──────────────────────────────────────────
{
	const h1 = await hashCode("const x = 1;");
	const h2 = await hashCode("const x = 1;");
	assert.equal(h1, h2, "hashCode is deterministic");
	assert.equal(h1.length, 64, "hashCode produces 64-char SHA-256 hex");
	const h3 = await hashCode("const x = 2;");
	assert.notEqual(h1, h3, "different code produces different hash");
}

// ── 2. CmExecutionStore: park records a parked row ───────────────────────────
{
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);
	const id = crypto.randomUUID();
	const row = store.park({ id, sessionId: "session-a", codeHash: "abc123" });
	assert.equal(row.status, "parked", "park returns status=parked");
	assert.equal(row.risk_tier, "HIGH", "risk_tier is always HIGH");
	assert.equal(row.resolved_by, null, "parked row has no resolved_by");

	const fetched = store.get(id);
	if (!fetched) throw new Error("parked row not found");
	assert.equal(fetched.status, "parked");
	assert.equal(fetched.session_id, "session-a");
}

// ── 3. CmExecutionStore: markAuthorizedPre records pre-run row ───────────────
{
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);
	const id = crypto.randomUUID();
	const row = store.markAuthorizedPre({
		id,
		sessionId: "session-b",
		codeHash: "def456",
	});
	assert.equal(
		row.status,
		"authorized_ran",
		"markAuthorizedPre returns authorized_ran",
	);
	assert.equal(row.resolved_by, "policy", "resolved_by is policy");

	const fetched = store.get(id);
	if (!fetched) throw new Error("pre-authorized row not found");
	assert.equal(fetched.status, "authorized_ran");
}

// ── 4. CmExecutionStore: resolve updates the row ─────────────────────────────
{
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);
	const id = crypto.randomUUID();
	store.markAuthorizedPre({ id, sessionId: "session-c", codeHash: "ghi789" });
	store.resolve({
		id,
		status: "authorized_ran",
		resolvedBy: "policy",
		result: { value: 42 },
	});
	const row = store.get(id);
	if (!row) throw new Error("resolved row not found");
	assert.equal(row.status, "authorized_ran");
	assert.equal(row.resolved_by, "policy" satisfies CmResolvedBy);
	assert.equal(row.result, JSON.stringify({ value: 42 }));
	assert.ok(row.resolved_at !== null, "resolved_at set after resolve");
}

// ── 5. CmExecutionStore: error resolve ───────────────────────────────────────
{
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);
	const id = crypto.randomUUID();
	store.markAuthorizedPre({ id, sessionId: "session-d", codeHash: "jkl012" });
	store.resolve({
		id,
		status: "error",
		resolvedBy: "policy",
		error: "ReferenceError: x is not defined",
	});
	const row = store.get(id);
	if (!row) throw new Error("error row not found");
	assert.equal(row.status, "error");
	assert.equal(row.error, "ReferenceError: x is not defined");
	assert.equal(row.result, null);
}

// ── 6. CmSessionGate: unauthorized by default ────────────────────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	const authorized = await gate.isSessionAuthorized("session-main");
	assert.equal(authorized, false, "unauthorized by default (fail-closed)");
}

// ── 7. CmSessionGate: empty session key is always unauthorized ───────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	await gate.authorizeSession("main", "operator");
	const emptyAuth = await gate.isSessionAuthorized("");
	assert.equal(emptyAuth, false, "empty sessionKey is always unauthorized");
}

// ── 8. CmSessionGate: authorize then isAuthorized returns true ───────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	await gate.authorizeSession("coding-session-1", "operator");
	const authorized = await gate.isSessionAuthorized("coding-session-1");
	assert.equal(authorized, true, "authorized after authorizeSession");
}

// ── 9. CmSessionGate: authorizeSession is idempotent ─────────────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	await gate.authorizeSession("session-x", "operator");
	await gate.authorizeSession("session-x", "operator");
	const raw = await kv.get("cm_session_allowlist");
	const list = JSON.parse(raw as string);
	assert.equal(
		list.filter((g: { sessionKey: string }) => g.sessionKey === "session-x")
			.length,
		1,
		"duplicate authorize does not double-add",
	);
}

// ── 9b. CmSessionGate: a grant auto-expires after its TTL (fail-closed) ───────
{
	let clock = 1_000_000;
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv, () => clock);
	await gate.authorizeSession("session-ttl", "operator", 60_000); // 60s grant
	assert.equal(
		await gate.isSessionAuthorized("session-ttl"),
		true,
		"authorized within TTL",
	);
	clock += 61_000; // advance past expiry
	assert.equal(
		await gate.isSessionAuthorized("session-ttl"),
		false,
		"unauthorized after TTL expiry (fail-closed)",
	);
}

// ── 9c. CmSessionGate: legacy bare-string grants are treated as expired ───────
{
	const kv = makeKvStore();
	await kv.put("cm_session_allowlist", JSON.stringify(["legacy-session"]));
	const gate = new CmSessionGate(kv);
	assert.equal(
		await gate.isSessionAuthorized("legacy-session"),
		false,
		"legacy no-expiry string entry is fail-closed",
	);
}

// ── 9d. CmSessionGate: exact-code replay grants are one-shot ─────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	await gate.authorizeReplay({
		sessionKey: "replay-session",
		codeHash: "hash-a",
		sourceExecutionId: "parked-exec-a",
		authorizedBy: "operator",
	});

	assert.equal(
		await gate.consumeReplayGrant("replay-session", "hash-b"),
		null,
		"different code hash cannot consume a replay grant",
	);

	const consumed = await gate.consumeReplayGrant("replay-session", "hash-a");
	assert.equal(
		consumed?.sourceExecutionId,
		"parked-exec-a",
		"matching code hash consumes the replay grant",
	);
	assert.equal(
		await gate.consumeReplayGrant("replay-session", "hash-a"),
		null,
		"replay grant is consumed only once",
	);
}

// ── 9e. CmSessionGate: replay grants expire fail-closed ──────────────────────
{
	let clock = 5_000_000;
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv, () => clock);
	await gate.authorizeReplay({
		sessionKey: "replay-expire",
		codeHash: "hash-expire",
		sourceExecutionId: "parked-expire",
		authorizedBy: "operator",
		ttlMs: 1000,
	});
	clock += 1001;
	assert.equal(
		await gate.consumeReplayGrant("replay-expire", "hash-expire"),
		null,
		"expired replay grant is not accepted",
	);
}

// ── 10. CmSessionGate: revoke removes authorization ──────────────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	await gate.authorizeSession("session-y", "operator");
	assert.equal(await gate.isSessionAuthorized("session-y"), true);
	await gate.revokeSession("session-y");
	assert.equal(
		await gate.isSessionAuthorized("session-y"),
		false,
		"unauthorized after revokeSession",
	);
}

// ── 11. Gate semantics: parked when session unauthorized ─────────────────────
// Simulates the do.ts `execute` handler logic without importing cloudflare:workers.
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);

	const sessionKey = "uncoded-session";
	const code = "async () => 42;";
	const codeHash = await hashCode(code);
	const executionId = crypto.randomUUID();

	const authorized = await gate.isSessionAuthorized(sessionKey);
	assert.equal(authorized, false, "session not authorized");

	// Gate path: park the execution, do NOT run.
	let codeWasExecuted = false;
	if (!authorized) {
		store.park({ id: executionId, sessionId: sessionKey, codeHash });
	} else {
		codeWasExecuted = true;
	}

	assert.equal(
		codeWasExecuted,
		false,
		"code not executed when session unauthorized",
	);
	const row = store.get(executionId);
	if (!row) throw new Error("parked audit row not found");
	assert.equal(row.status, "parked", "parked status in audit row");
}

// ── 12. Gate semantics: runs when session is authorized ──────────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);

	const sessionKey = "authorized-session";
	await gate.authorizeSession(sessionKey, "operator");

	const code = "async () => 42;";
	const codeHash = await hashCode(code);
	const executionId = crypto.randomUUID();

	const authorized = await gate.isSessionAuthorized(sessionKey);
	assert.equal(authorized, true, "session is authorized");

	let codeWasExecuted = false;
	if (authorized) {
		store.markAuthorizedPre({
			id: executionId,
			sessionId: sessionKey,
			codeHash,
		});
		// simulate execution
		codeWasExecuted = true;
		store.resolve({
			id: executionId,
			status: "authorized_ran",
			resolvedBy: "policy",
			result: 42,
		});
	}

	assert.equal(codeWasExecuted, true, "code executed when session authorized");
	const row = store.get(executionId);
	if (!row) throw new Error("authorized audit row not found");
	assert.equal(row.status, "authorized_ran", "authorized_ran in audit row");
	assert.equal(row.resolved_by, "policy", "resolvedBy policy in audit row");
}

// ── 13. Gate semantics: authorize/revoke flips the gate ──────────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);

	assert.equal(
		await gate.isSessionAuthorized("flip-session"),
		false,
		"starts unauthorized",
	);
	await gate.authorizeSession("flip-session", "operator");
	assert.equal(
		await gate.isSessionAuthorized("flip-session"),
		true,
		"authorized after grant",
	);
	await gate.revokeSession("flip-session");
	assert.equal(
		await gate.isSessionAuthorized("flip-session"),
		false,
		"unauthorized after revoke",
	);
}

// ── 14. Approval-bridge helpers: park → link card → list → replay-authorize ─
{
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);
	const codeHash = "deadbeef";

	store.park({ id: "exec-bridge", sessionId: "sess-bridge", codeHash });
	// A parked row is not in the drain set until a card is linked.
	assert.equal(
		store.listParked().length,
		0,
		"parked row without a card is not drained",
	);

	store.updateApprovalId("exec-bridge", "card-123");
	const parked = store.listParked();
	assert.equal(parked.length, 1, "linked parked row appears in the drain set");
	assert.equal(parked[0]?.approval_request_id, "card-123", "card id linked");

	store.markReplayAuthorized("exec-bridge", "operator");
	assert.equal(
		store.get("exec-bridge")?.status,
		"replay_authorized",
		"approved card authorizes one exact replay",
	);
	assert.equal(
		store.listParked().length,
		0,
		"settled row leaves the drain set",
	);

	// Rejected/expired path abandons a fresh parked row.
	store.park({ id: "exec-rej", sessionId: "sess-rej", codeHash });
	store.updateApprovalId("exec-rej", "card-456");
	store.markAbandoned("exec-rej", "card_rejected");
	assert.equal(
		store.get("exec-rej")?.status,
		"abandoned",
		"rejected card abandons the row",
	);
}

// ── 15. Multiple sessions: independent authorization ─────────────────────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);

	await gate.authorizeSession("session-alpha", "operator");
	assert.equal(await gate.isSessionAuthorized("session-alpha"), true);
	assert.equal(
		await gate.isSessionAuthorized("session-beta"),
		false,
		"unrelated session stays unauthorized",
	);

	await gate.authorizeSession("session-beta", "operator");
	assert.equal(await gate.isSessionAuthorized("session-beta"), true);

	await gate.revokeSession("session-alpha");
	assert.equal(
		await gate.isSessionAuthorized("session-alpha"),
		false,
		"alpha revoked",
	);
	assert.equal(
		await gate.isSessionAuthorized("session-beta"),
		true,
		"beta still authorized",
	);
}

// ── 16. Approval replay: matching code runs, changed code parks again ─────────
{
	const kv = makeKvStore();
	const gate = new CmSessionGate(kv);
	const runner = makeSqlRunner();
	const store = new CmExecutionStore(runner);

	const sessionKey = "replay-run-session";
	const approvedCodeHash = await hashCode("async () => 42;");
	store.park({
		id: "parked-for-replay",
		sessionId: sessionKey,
		codeHash: approvedCodeHash,
	});
	store.updateApprovalId("parked-for-replay", "approval-replay");
	await gate.authorizeReplay({
		sessionKey,
		codeHash: approvedCodeHash,
		sourceExecutionId: "parked-for-replay",
		authorizedBy: "operator",
	});
	store.markReplayAuthorized("parked-for-replay", "operator");

	const changedCodeHash = await hashCode("async () => 43;");
	assert.equal(
		await gate.consumeReplayGrant(sessionKey, changedCodeHash),
		null,
		"changed code after approval does not inherit replay approval",
	);

	const replay = await gate.consumeReplayGrant(sessionKey, approvedCodeHash);
	assert.equal(
		replay?.sourceExecutionId,
		"parked-for-replay",
		"same code consumes replay approval",
	);
	if (!replay) throw new Error("expected replay grant");
	store.resolve({
		id: replay.sourceExecutionId,
		status: "authorized_ran",
		resolvedBy: "operator",
		result: 42,
	});
	const replayRow = store.get("parked-for-replay");
	assert.equal(replayRow?.id, "parked-for-replay");
	assert.equal(replayRow?.status, "authorized_ran");
	assert.equal(replayRow?.resolved_by, "operator");
	assert.equal(
		replayRow?.result,
		JSON.stringify(42),
		"reissued execution resolves the original parked row",
	);
}

console.log("cm-execution-approval.test.ts OK");
