/**
 * Offline unit test for the phase-1 append-only `TediSessionRepo`
 * (`SessionHarnessBackend` over DO-SQLite). Pure / fake-port ⇒ plain
 * `node:assert`, no Worker harness, no DO import.
 * Run: `bun run src/session-repo.test.ts`.
 *
 * The DO-SQLite substrate is faked with a tiny in-memory `sql` port (a JS array of
 * rows + a minimal matcher for the handful of statements the repo emits), so the
 * repo is testable entirely offline. We also wire a `SessionHarness` over the repo
 * to prove the frozen harness contract (ledger-first `buildContext`) still works
 * unchanged over this backend.
 */
import assert from "node:assert/strict";
import type {
	TediSessionContextEntry,
	TediSessionDurableCompaction,
	TediSessionDurableState,
} from "./session-harness";
import { SessionHarness } from "./session-harness";
import {
	deriveEntryId,
	deriveIdempotencyKey,
	estimateTokens,
	findCutPoint,
	pathToRoot,
	projectBranch,
	rowToTurn,
	type SessionEntry,
	type SessionRepoSql,
	selectRecentWindow,
	TediSessionRepo,
} from "./session-repo";

// ── Tiny in-memory DO-SQLite fake ────────────────────────────────────────────
// Models just enough of the `session_entries` table for the repo's statements:
// CREATE (no-op), INSERT OR IGNORE (with partial-unique idempotency dedup +
// PK dedup), and the SELECT … ORDER BY ts DESC LIMIT recent-window read.

interface FakeRow {
	id: string;
	session_key: string;
	parent_id: string | null;
	type: string;
	role: string;
	content: string;
	idempotency_key: string | null;
	ts: number;
	first_kept_entry_id: string | null;
	tokens_before: number | null;
	model_provider: string | null;
	model_id: string | null;
}

function createFakeSql(): { sql: SessionRepoSql; rows: FakeRow[] } {
	const rows: FakeRow[] = [];
	// Track which phase-2 columns have been "added" so a re-ALTER throws like
	// SQLite's "duplicate column name" — proving the repo's idempotent try/catch.
	const addedColumns = new Set<string>();
	const sql: SessionRepoSql = (<T>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[] => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();

		if (
			text.startsWith("CREATE TABLE") ||
			text.startsWith("CREATE INDEX") ||
			text.startsWith("CREATE UNIQUE INDEX")
		) {
			return [] as T[];
		}

		// Phase-2: idempotent ALTER TABLE ADD COLUMN. Second add of the same column
		// throws (SQLite "duplicate column name"); the repo swallows it in tryAlter.
		if (text.startsWith("ALTER TABLE session_entries ADD COLUMN")) {
			const col = /ADD COLUMN (\w+)/.exec(text)?.[1] ?? "";
			if (addedColumns.has(col)) {
				throw new Error(`duplicate column name: ${col}`);
			}
			addedColumns.add(col);
			return [] as T[];
		}

		if (text.startsWith("INSERT OR IGNORE INTO session_entries")) {
			// Message rows may carry model_provider + model_id; compaction/fork rows
			// use their own trailing first_kept_entry_id + tokens_before columns.
			const [
				id,
				session_key,
				parent_id,
				type,
				role,
				content,
				idempotency_key,
				ts,
			] = values;
			const isModelTurn = text.includes("model_provider, model_id");
			const first_kept_entry_id =
				!isModelTurn && values.length >= 10 ? values[8] : null;
			const tokens_before =
				!isModelTurn && values.length >= 10 ? values[9] : null;
			const model_provider = isModelTurn ? values[8] : null;
			const model_id = isModelTurn ? values[9] : null;
			// PK conflict → ignore.
			if (rows.some((r) => r.id === id)) return [] as T[];
			// Partial UNIQUE (session_key, idempotency_key) WHERE idempotency_key IS NOT NULL.
			if (
				idempotency_key != null &&
				rows.some(
					(r) =>
						r.session_key === session_key &&
						r.idempotency_key === idempotency_key,
				)
			) {
				return [] as T[];
			}
			rows.push({
				id: id as string,
				session_key: session_key as string,
				parent_id: (parent_id as string | null) ?? null,
				type: type as string,
				role: role as string,
				content: content as string,
				idempotency_key: (idempotency_key as string | null) ?? null,
				ts: ts as number,
				first_kept_entry_id: (first_kept_entry_id as string | null) ?? null,
				tokens_before: (tokens_before as number | null) ?? null,
				model_provider: (model_provider as string | null) ?? null,
				model_id: (model_id as string | null) ?? null,
			});
			// `RETURNING id` yields the inserted id on a real insert (the conflict
			// branches above return `[]`), so `appendTurnWithKey` reads a non-empty
			// row set as did-insert=true.
			return (text.includes("RETURNING id") ? [{ id }] : []) as T[];
		}

		// Phase-2: sessions with a compaction marker.
		if (
			text.startsWith(
				"SELECT DISTINCT session_key FROM session_entries WHERE type = 'compaction'",
			)
		) {
			const keys = [
				...new Set(
					rows.filter((r) => r.type === "compaction").map((r) => r.session_key),
				),
			];
			return keys.map((session_key) => ({ session_key })) as T[];
		}

		// Phase-2: full-column read (all sessions or one), ts-ascending.
		if (
			text.startsWith(
				"SELECT id, session_key, parent_id, type, role, content, ts, first_kept_entry_id, tokens_before, model_provider, model_id FROM session_entries",
			)
		) {
			const bySession = / WHERE session_key = \?/.test(text);
			const wantKey = bySession ? (values[0] as string) : null;
			const out = rows
				.filter((r) => (bySession ? r.session_key === wantKey : true))
				.sort((a, b) => a.ts - b.ts)
				.map((r) => ({ ...r }));
			return out as T[];
		}

		// Exact-keyed settle probe: WHERE session_key = ? AND idempotency_key = ? LIMIT 1
		if (
			text.startsWith(
				"SELECT id, role, content, ts, model_provider, model_id FROM session_entries",
			) &&
			text.includes("idempotency_key = ?")
		) {
			const [wantKey, wantIdem] = values as [string, string];
			return rows
				.filter(
					(r) =>
						r.session_key === wantKey &&
						r.idempotency_key === wantIdem &&
						r.type === "message",
				)
				.slice(0, 1)
				.map((r) => ({ ...r })) as T[];
		}
		if (
			text.startsWith(
				"SELECT session_key, role, content, ts, model_provider, model_id FROM session_entries",
			) &&
			text.includes("idempotency_key = ?")
		) {
			const [wantKey, wantIdem] = values as [string, string];
			return rows
				.filter(
					(r) => r.session_key === wantKey && r.idempotency_key === wantIdem,
				)
				.slice(0, 1)
				.map((r) => ({
					session_key: r.session_key,
					role: r.role,
					content: r.content,
					ts: r.ts,
					model_provider: r.model_provider,
					model_id: r.model_id,
				})) as T[];
		}

		if (
			text.startsWith(
				"SELECT session_key, role, content, ts, model_provider, model_id FROM session_entries",
			)
		) {
			// WHERE type = 'message' ORDER BY ts DESC LIMIT ?
			const limit = values[values.length - 1] as number;
			const out = rows
				.filter((r) => r.type === "message")
				.sort((a, b) => b.ts - a.ts)
				.slice(0, limit)
				.map((r) => ({
					session_key: r.session_key,
					role: r.role,
					content: r.content,
					ts: r.ts,
					model_provider: r.model_provider,
					model_id: r.model_id,
				}));
			return out as T[];
		}

		throw new Error(`fake sql: unhandled statement: ${text}`);
	}) as SessionRepoSql;
	return { sql, rows };
}

function durableState(
	entries: ReadonlyArray<TediSessionContextEntry>,
	compaction: TediSessionDurableCompaction | null = null,
): TediSessionDurableState {
	return {
		entries: entries.map((entry, index) => ({
			id: `ledger-${index + 1}`,
			...entry,
		})),
		compaction,
	};
}

const noDurable = async (): Promise<TediSessionDurableState> =>
	durableState([]);

// ── Pure: deriveIdempotencyKey follows the ledger {runId}:{seq} scheme ────────
{
	const runId = "tedi-123:chat:1000";
	assert.equal(deriveIdempotencyKey(runId, "user"), "tedi-123:chat:1000:0");
	assert.equal(
		deriveIdempotencyKey(runId, "assistant"),
		"tedi-123:chat:1000:2",
	);
}

// ── Pure: selectRecentWindow reverses ts-DESC rows to a ts-ASC suffix ─────────
{
	const desc = [
		{
			session_key: "k",
			role: "assistant",
			content: "c4",
			ts: 4,
			model_provider: null,
			model_id: null,
		},
		{
			session_key: "k",
			role: "user",
			content: "c3",
			ts: 3,
			model_provider: null,
			model_id: null,
		},
		{
			session_key: "k",
			role: "assistant",
			content: "c2",
			ts: 2,
			model_provider: null,
			model_id: null,
		},
		{
			session_key: "k",
			role: "user",
			content: "c1",
			ts: 1,
			model_provider: null,
			model_id: null,
		},
	];
	const win = selectRecentWindow(desc, 2);
	assert.deepEqual(
		win.map((t) => `${t.ts}:${t.content}`),
		["3:c3", "4:c4"],
		"keeps the 2 most-recent rows, ts-ascending",
	);
	assert.equal(rowToTurn(desc[0]!).role, "assistant");
	assert.ok(
		deriveEntryId({
			role: "user",
			content: "x",
			sessionKey: "k",
			ts: 7,
		}).includes("k:7:user"),
	);
}

// ── append → listTurns round-trips ts-ordered ────────────────────────────────
{
	const { sql } = createFakeSql();
	const repo = new TediSessionRepo({ sql, readDurable: noDurable });
	repo.appendTurn({ role: "user", content: "hi", sessionKey: "chat:A", ts: 1 });
	repo.appendTurn({
		role: "assistant",
		content: "yo",
		sessionKey: "chat:A",
		ts: 2,
	});
	repo.appendTurn({
		role: "user",
		content: "more",
		sessionKey: "chat:A",
		ts: 3,
	});
	const turns = repo.listTurns();
	assert.deepEqual(
		turns.map((t) => `${t.ts}:${t.role}:${t.content}`),
		["1:user:hi", "2:assistant:yo", "3:user:more"],
		"listTurns returns appended turns ts-ascending",
	);
}

// ── idempotency: same key twice = one row, second append returns false ───────
{
	const { sql, rows } = createFakeSql();
	const repo = new TediSessionRepo({ sql, readDurable: noDurable });
	const turn = {
		role: "assistant" as const,
		content: "answer",
		sessionKey: "chat:A",
		ts: 10,
	};
	const key = deriveIdempotencyKey("tedi-1:chat:9", "assistant");
	const first = repo.appendTurnWithKey(turn, key);
	const second = repo.appendTurnWithKey(turn, key); // retry — must no-op
	assert.equal(first, true, "first keyed append inserts → did-insert true");
	assert.equal(
		second,
		false,
		"second identical-key append is an idempotency hit → did-insert false (load-bearing dedup signal)",
	);
	assert.equal(
		rows.filter((r) => r.idempotency_key === key).length,
		1,
		"keyed append is idempotent",
	);
	assert.equal(repo.listTurns().length, 1);
	// A DISTINCT key inserts a new row and returns true.
	const otherKey = deriveIdempotencyKey("tedi-1:chat:9", "user");
	assert.equal(
		repo.appendTurnWithKey({ ...turn, role: "user", ts: 11 }, otherKey),
		true,
		"a distinct idempotency key inserts → did-insert true",
	);
}

// ── harness→repo key threading: appendTurn(turn, key) must NOT drop the key ──
// Regression guard for the silent key drop: the harness calls
// `backend.appendTurn(turn, idempotencyKey)`, and a one-parameter repo
// implementation type-checked (structural typing) while discarding the key at
// runtime — every harness append landed with idempotency_key = NULL and a
// retried turn (different ts) double-inserted.
{
	const { sql, rows } = createFakeSql();
	const repo = new TediSessionRepo({ sql, readDurable: noDurable });
	const harness = new SessionHarness(repo);
	const key = deriveIdempotencyKey("tedi-1:mcp:req-7", "assistant");
	const first = harness.appendTurn(
		"chat:A",
		{ role: "assistant", content: "reply", ts: 100 },
		key,
	);
	assert.equal(first, true, "harness keyed append inserts");
	assert.equal(
		rows.filter((r) => r.idempotency_key === key).length,
		1,
		"the idempotency key reaches the row (not dropped at the backend boundary)",
	);
	// Redelivery with a DIFFERENT ts (retry re-stamps Date.now()) must still
	// dedup on the key — the exact scenario the PK-only fallback failed.
	const retry = harness.appendTurn(
		"chat:A",
		{ role: "assistant", content: "reply", ts: 250 },
		key,
	);
	assert.equal(retry, false, "keyed redelivery with a new ts is a no-op");
	assert.equal(repo.listTurns().length, 1, "one row despite the ts drift");
}

// ── findTurnByIdempotencyKey: exact-keyed settle probe ───────────────────────
{
	const { sql } = createFakeSql();
	const repo = new TediSessionRepo({ sql, readDurable: noDurable });
	const runId = "tedi-1:mcp:req-42";
	const assistantKey = deriveIdempotencyKey(runId, "assistant");
	assert.equal(
		repo.findTurnByIdempotencyKey("chat:A", assistantKey),
		null,
		"absent key → null (turn not settled yet)",
	);
	// A DIFFERENT turn's assistant reply in the same session must NOT satisfy
	// the probe (the heuristic-scan failure mode this method exists to avoid).
	repo.appendTurnWithKey(
		{ role: "assistant", content: "other turn", sessionKey: "chat:A", ts: 5 },
		deriveIdempotencyKey("tedi-1:mcp:req-41", "assistant"),
	);
	assert.equal(
		repo.findTurnByIdempotencyKey("chat:A", assistantKey),
		null,
		"a concurrent turn's assistant row does not match",
	);
	// Same key in a DIFFERENT session must not match either.
	repo.appendTurnWithKey(
		{
			role: "assistant",
			content: "other session",
			sessionKey: "chat:B",
			ts: 6,
		},
		assistantKey,
	);
	assert.equal(
		repo.findTurnByIdempotencyKey("chat:A", assistantKey),
		null,
		"same key in another session does not match",
	);
	repo.appendTurnWithKey(
		{
			role: "assistant",
			content: "THE reply",
			sessionKey: "chat:A",
			ts: 7,
			modelIdentity: {
				provider: "azure-openai",
				model: "gpt-5.6-terra",
			},
		},
		assistantKey,
	);
	const found = repo.findTurnByIdempotencyKey("chat:A", assistantKey);
	assert.equal(found?.content, "THE reply", "keyed row found once committed");
	assert.equal(found?.ts, 7, "returns the committed turn's ts");
	assert.equal(found?.role, "assistant");
	assert.deepEqual(found?.modelIdentity, {
		provider: "azure-openai",
		model: "gpt-5.6-terra",
	});
}

// ── bounded window: > max → only the recent `max` ────────────────────────────
{
	const { sql } = createFakeSql();
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		maxRecentTurns: 3,
	});
	for (let i = 1; i <= 7; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: `m${i}`,
			sessionKey: "chat:A",
			ts: i,
		});
	}
	const turns = repo.listTurns();
	assert.equal(turns.length, 3, "bounded to maxRecentTurns");
	assert.deepEqual(
		turns.map((t) => t.content),
		["m5", "m6", "m7"],
		"keeps the most-recent 3, ts-ascending",
	);
}

// ── readMessages delegates to the durable port ───────────────────────────────
{
	const { sql } = createFakeSql();
	let seenKey = "";
	let seenLimit: number | undefined;
	const repo = new TediSessionRepo({
		sql,
		readDurable: async (k, limit) => {
			seenKey = k;
			seenLimit = limit;
			return durableState([{ role: "user", content: "from-ledger", ts: 99 }]);
		},
	});
	const out = await repo.readMessages("chat:Z", 25);
	assert.equal(seenKey, "chat:Z");
	assert.equal(seenLimit, 25);
	assert.deepEqual(out, [{ role: "user", content: "from-ledger", ts: 99 }]);
}

// ── SessionHarness over the repo: ledger-first buildContext, cold cache ───────
// Cold cache (nothing appended to the repo) MUST reconstruct full history from the
// durable port — proves the frozen harness contract still holds over this backend.
{
	const { sql } = createFakeSql();
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "Q1", ts: 1 },
		{ role: "assistant", content: "A1", ts: 2 },
	];
	const repo = new TediSessionRepo({
		sql,
		readDurable: async () => durableState(durable),
	});
	const harness = new SessionHarness(repo);
	const ctx = await harness.buildContext("chat:A");
	assert.deepEqual(
		ctx.map((m) => `${m.role}:${m.content}`),
		["user:Q1", "assistant:A1"],
		"cold cache reconstructs from the durable port (ledger-first)",
	);
}

// ── SessionHarness over the repo: durable prefix + hot-cache tail merge ───────
// Durable holds older history; the repo cache holds the in-flight tail. The
// ts-keyed merge must back-fill the older durable prefix under the cache suffix.
{
	const { sql } = createFakeSql();
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "OLD-Q", ts: 1 },
		{ role: "assistant", content: "OLD-A", ts: 2 },
		{ role: "user", content: "NEW-Q", ts: 3 }, // also in cache → de-duped by merge
	];
	const repo = new TediSessionRepo({
		sql,
		readDurable: async () => durableState(durable),
	});
	// Only the recent tail (ts >= 3) is in the hot cache.
	repo.appendTurn({
		role: "user",
		content: "NEW-Q",
		sessionKey: "chat:A",
		ts: 3,
	});
	repo.appendTurn({
		role: "assistant",
		content: "NEW-A",
		sessionKey: "chat:A",
		ts: 4,
	});
	const harness = new SessionHarness(repo);
	const ctx = await harness.buildContext("chat:A");
	assert.deepEqual(
		ctx.map((m) => `${m.role}:${m.content}`),
		["user:OLD-Q", "assistant:OLD-A", "user:NEW-Q", "assistant:NEW-A"],
		"durable prefix (ts<cacheStart) back-fills under the hot-cache suffix",
	);
}

// ── DURABLE COMPACTION / BODY-SWAP: cold cache projects D1 state ─────────────
// A new runtime body has no DO-local compaction marker or recent-turn cache.
// The single durable read must therefore restore the persisted summary + kept
// tail without leaking the pre-cut originals back into model context.
{
	const { sql } = createFakeSql();
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "OLD-Q", ts: 10 },
		{ role: "assistant", content: "OLD-A", ts: 20 },
		{ role: "user", content: "KEPT-Q", ts: 30 },
		{ role: "assistant", content: "KEPT-A", ts: 40 },
	];
	const repo = new TediSessionRepo({
		sql,
		readDurable: async () =>
			durableState(durable, {
				summary: "DURABLE-SUMMARY",
				firstKeptEntryId: "ledger-3",
				tokensBefore: 50,
			}),
	});
	const harness = new SessionHarness(repo);
	assert.equal(
		repo.listTurns().length,
		0,
		"simulated replacement body is cold",
	);
	const ctx = await harness.buildContext("chat:A");
	assert.deepEqual(
		ctx.map((message) => `${message.role}:${message.content}`),
		["assistant:DURABLE-SUMMARY", "user:KEPT-Q", "assistant:KEPT-A"],
		"cold body restores summary + kept tail from the canonical D1 read",
	);
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE-2: branch / fork / non-destructive compaction
// ════════════════════════════════════════════════════════════════════════════

// Helper: build a SessionEntry for pure-function tests.
function msg(
	id: string,
	role: "user" | "assistant",
	content: string,
	ts: number,
	parentId: string | null,
): SessionEntry {
	return {
		id,
		sessionKey: "chat:A",
		parentId,
		type: "message",
		role,
		content,
		ts,
	};
}

// ── Pure: estimateTokens is ceil(len/4) ──────────────────────────────────────
{
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2, "ceil(5/4) = 2");
}

// ── Pure: pathToRoot walks parentId root-first ───────────────────────────────
{
	const entries: SessionEntry[] = [
		msg("e1", "user", "q1", 1, null),
		msg("e2", "assistant", "a1", 2, "e1"),
		msg("e3", "user", "q2", 3, "e2"),
	];
	const path = pathToRoot(entries, "e3");
	assert.deepEqual(
		path.map((e) => e.id),
		["e1", "e2", "e3"],
		"root-first branch",
	);
	// Missing leaf → [] (best-effort, never throws).
	assert.deepEqual(pathToRoot(entries, "nope"), []);
	// Phase-1 fallback: null parentId chains by ts when older neighbours exist.
	const legacy: SessionEntry[] = [
		msg("e1", "user", "q1", 1, null),
		msg("e2", "assistant", "a1", 2, null),
	];
	assert.deepEqual(
		pathToRoot(legacy, "e2").map((e) => e.id),
		["e1", "e2"],
		"null-parent phase-1 rows chain by ts",
	);
}

// ── Pure: projectBranch — no compaction ⇒ 1:1 (phase-1 view preserved) ────────
{
	const entries: SessionEntry[] = [
		msg("e1", "user", "q1", 1, null),
		msg("e2", "assistant", "a1", 2, "e1"),
	];
	const ctx = projectBranch(entries);
	assert.deepEqual(
		ctx.map((c) => `${c.role}:${c.content}`),
		["user:q1", "assistant:a1"],
		"no compaction ⇒ identity projection",
	);
}

// ── Pure: projectBranch — compaction overlay (summary + read-time skip) ───────
{
	const entries: SessionEntry[] = [
		msg("e1", "user", "old-q", 1, null),
		msg("e2", "assistant", "old-a", 2, "e1"),
		msg("e3", "user", "kept-q", 3, "e2"),
		msg("e4", "assistant", "kept-a", 4, "e3"),
		{
			id: "c1",
			sessionKey: "chat:A",
			parentId: "e4",
			type: "compaction",
			role: "assistant",
			content: "SUMMARY of old turns",
			ts: 4,
			firstKeptEntryId: "e3",
			tokensBefore: 100,
		},
		msg("e5", "user", "live-q", 5, "c1"),
	];
	const ctx = projectBranch(entries);
	assert.deepEqual(
		ctx.map((c) => `${c.role}:${c.content}`),
		[
			"assistant:SUMMARY of old turns", // synthetic summary first
			"user:kept-q", // e3 = firstKeptEntryId (inclusive)
			"assistant:kept-a", // e4
			"user:live-q", // e5 appended after the marker
		],
		"summary surfaces; entries before firstKeptEntryId are skipped at read-time",
	);
	// NON-DESTRUCTIVE: e1/e2 are still in the input array (originals retained).
	assert.ok(
		entries.some((e) => e.id === "e1"),
		"pre-cut originals retained on disk",
	);
}

// ── Pure: findCutPoint protects tail ≥ budget and snaps to user boundary ──────
{
	// 8 messages, each content length 40 ⇒ 10 tokens each (ceil(40/4)).
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= 8; i++) {
		entries.push(
			msg(
				`e${i}`,
				i % 2 ? "user" : "assistant",
				"x".repeat(40),
				i,
				i === 1 ? null : `e${i - 1}`,
			),
		);
	}
	// keepRecentTokens = 25 ⇒ walk back tail: e8(10),e7(20),e6(30)≥25 → cut at e6.
	// e6 is assistant (even) ⇒ snap back to the user that starts the turn = e5.
	const cut = findCutPoint(entries, 25);
	assert.equal(cut.firstKeptId, "e5", "cut snaps to a USER boundary");
	assert.equal(
		cut.isSplit,
		true,
		"snapping off an assistant entry marks isSplit",
	);
	// Kept suffix (e5..e8) = 4 msgs × 10 = 40 tokens ≥ 25 budget (tail protected).
	const keptTokens =
		["e5", "e6", "e7", "e8"].length * estimateTokens("x".repeat(40));
	assert.ok(keptTokens >= 25, "retained tail meets the recent budget");
	// Whole conversation under budget ⇒ no-op cut.
	assert.deepEqual(findCutPoint(entries, 100_000), {
		firstKeptId: null,
		isSplit: false,
	});
}

// ── Repo: compactSession appends a marker; non-destructive; projected read ────
{
	const { sql, rows } = createFakeSql();
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		keepRecentTokens: 25,
	});
	// 6 turns of length-40 content ⇒ 10 tokens each.
	for (let i = 1; i <= 6; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "y".repeat(40),
			sessionKey: "chat:A",
			ts: i,
		});
	}
	const beforeCount = rows.length;
	let summarizedHead: TediSessionContextEntry[] = [];
	await repo.compactSession("chat:A", async (head) => {
		summarizedHead = head;
		return "COMPACTED";
	});
	// Append-only: original 6 message rows retained, exactly one compaction added.
	assert.equal(
		rows.filter((r) => r.type === "message").length,
		6,
		"originals retained",
	);
	assert.equal(
		rows.filter((r) => r.type === "compaction").length,
		1,
		"one compaction marker",
	);
	assert.equal(rows.length, beforeCount + 1);
	assert.ok(summarizedHead.length > 0, "summarizer received the head span");

	// listTurns now returns the PROJECTED branch: summary first, then kept tail.
	const turns = repo.listTurns();
	assert.equal(
		turns[0]?.content,
		"COMPACTED",
		"projected view leads with the summary",
	);
	assert.ok(
		turns.every((t) => t.sessionKey === "chat:A"),
		"projected turns keep their session key",
	);
	// The summary is surfaced and the pre-cut originals are skipped at read-time.
	const projectedContents = turns.map((t) => t.content);
	assert.ok(projectedContents.includes("COMPACTED"));
	assert.ok(
		projectedContents.length < 6 + 1,
		"some pre-cut turns are skipped from the view",
	);
}

// ── Repo: compactSession no-ops when summarize returns null ──────────────────
{
	const { sql, rows } = createFakeSql();
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		keepRecentTokens: 25,
	});
	for (let i = 1; i <= 6; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "z".repeat(40),
			sessionKey: "chat:A",
			ts: i,
		});
	}
	await repo.compactSession("chat:A", async () => null);
	assert.equal(
		rows.filter((r) => r.type === "compaction").length,
		0,
		"null summary ⇒ no marker",
	);
	// listTurns unchanged (phase-1 fast path, no compaction present).
	assert.equal(
		repo.listTurns().length,
		6,
		"no compaction ⇒ phase-1 view intact",
	);
}

// ── Repo: compactSession no-ops + never throws when summarize throws ─────────
{
	const { sql, rows } = createFakeSql();
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		keepRecentTokens: 25,
	});
	for (let i = 1; i <= 6; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "w".repeat(40),
			sessionKey: "chat:A",
			ts: i,
		});
	}
	await repo.compactSession("chat:A", async () => {
		throw new Error("summarizer boom");
	});
	assert.equal(
		rows.filter((r) => r.type === "compaction").length,
		0,
		"throwing summarizer ⇒ no marker, no throw",
	);
}

// ── Repo: compactSession no-ops when head fits under the keep budget ─────────
{
	const { sql, rows } = createFakeSql();
	// Big budget ⇒ nothing to compact.
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		keepRecentTokens: 1_000_000,
	});
	for (let i = 1; i <= 4; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "small",
			sessionKey: "chat:A",
			ts: i,
		});
	}
	let called = false;
	await repo.compactSession("chat:A", async () => {
		called = true;
		return "X";
	});
	assert.equal(
		called,
		false,
		"summarizer not called when head fits under budget",
	);
	assert.equal(rows.filter((r) => r.type === "compaction").length, 0);
}

// ── Repo: getBranch returns the path-to-root for a session ───────────────────
{
	const { sql } = createFakeSql();
	const repo = new TediSessionRepo({ sql, readDurable: noDurable });
	repo.appendTurn({ role: "user", content: "q1", sessionKey: "chat:A", ts: 1 });
	repo.appendTurn({
		role: "assistant",
		content: "a1",
		sessionKey: "chat:A",
		ts: 2,
	});
	repo.appendTurn({ role: "user", content: "q2", sessionKey: "chat:A", ts: 3 });
	const branch = repo.getBranch("chat:A");
	assert.deepEqual(
		branch.map((e) => e.content),
		["q1", "a1", "q2"],
		"getBranch walks the leaf back to root (phase-1 ts fallback)",
	);
}

// ── Repo: a synthetic LONG session compacts — projected = summary + protected
//        tail; originals all retained in session_entries (non-destructive) ────
{
	const { sql, rows } = createFakeSql();
	// keepRecentTokens = 20 ⇒ tail of ~2 length-40 turns (10 tokens each) is kept.
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		keepRecentTokens: 20,
	});
	const N = 12;
	for (let i = 1; i <= N; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: `turn-${i}-${"x".repeat(40)}`,
			sessionKey: "chat:L",
			ts: i,
		});
	}
	assert.equal(
		repo.listTurns().length,
		N,
		"all turns present before compaction",
	);

	let headLen = 0;
	await repo.compactSession("chat:L", async (head) => {
		headLen = head.length;
		return "LONG-SESSION-SUMMARY";
	});

	// A compaction marker was appended; ALL N originals are still on disk.
	assert.equal(
		rows.filter((r) => r.session_key === "chat:L" && r.type === "message")
			.length,
		N,
		"originals retained in session_entries (append-only, non-destructive)",
	);
	assert.equal(
		rows.filter((r) => r.session_key === "chat:L" && r.type === "compaction")
			.length,
		1,
		"exactly one compaction marker appended",
	);
	assert.ok(headLen > 0, "summarizer received the collapsed head span");

	// Projected context = summary FIRST, then the protected recent tail, and is
	// strictly SHORTER than the full N turns (the pre-cut head is read-time skipped).
	const projected = repo.listTurns();
	assert.equal(
		projected[0]?.content,
		"LONG-SESSION-SUMMARY",
		"projection leads with the summary",
	);
	assert.ok(
		projected.length < N,
		"projected context drops the pre-cut head (summary replaces it)",
	);
	// The most-recent turn survives verbatim in the protected tail.
	assert.ok(
		projected.some((t) => t.content === `turn-${N}-${"x".repeat(40)}`),
		"the newest turn is kept verbatim in the protected tail",
	);
	// No pre-cut head turn (turn-1) leaks into the projection — it's summarized away.
	assert.ok(
		!projected.some((t) => t.content.startsWith("turn-1-")),
		"the oldest pre-cut turn is summarized out of the projected view",
	);
}

// ── Repo: compactSession returns an observability result (compacted true/false)
//        + the `keepRecentTokens` FORCE override cuts a SHORT session ───────────
{
	// (a) Real cut under a small budget ⇒ rich result the ledger emitter consumes.
	const { sql } = createFakeSql();
	const repo = new TediSessionRepo({
		sql,
		readDurable: noDurable,
		keepRecentTokens: 25,
	});
	for (let i = 1; i <= 6; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "y".repeat(40), // 10 tokens each
			sessionKey: "chat:R",
			ts: i,
		});
	}
	const result = await repo.compactSession("chat:R", async () => "SUMMARY-12");
	assert.ok(result, "result is non-null when a branch exists");
	assert.equal(result?.compacted, true, "compacted=true on a real cut");
	assert.equal(
		result?.summaryChars,
		"SUMMARY-12".length,
		"summaryChars = summary length",
	);
	assert.equal(
		result?.summary,
		"SUMMARY-12",
		"summary is exposed so the caller can persist durable compaction state",
	);
	assert.ok(
		typeof result?.firstKeptEntryId === "string" &&
			result.firstKeptEntryId.length > 0,
		"firstKeptEntryId carried for the ledger event id",
	);
	assert.ok(
		(result?.tokensBefore ?? 0) > 0,
		"tokensBefore reports the head span",
	);
	assert.ok(
		typeof result?.markerTs === "number",
		"markerTs carried for runId derivation",
	);
	assert.equal(result?.checkpoint?.version, 1);
	assert.equal(
		result?.checkpoint?.coveredThroughEntryId,
		result?.checkpoint?.contextSources.at(-1)?.id,
		"checkpoint boundary names the last fingerprinted compacted entry",
	);
	assert.ok(
		(result?.checkpoint?.contextSources.length ?? 0) > 0 &&
			result?.checkpoint?.contextSources.every((source) =>
				/^sha256:[a-f0-9]{64}$/.test(source.fingerprint),
			),
		"checkpoint fingerprints every compacted source exactly",
	);
	assert.match(
		result?.checkpoint?.checkpointDigest ?? "",
		/^sha256:[a-f0-9]{64}$/,
		"checkpoint carries a canonical aggregate digest",
	);

	// (b) FORCE: a SHORT session under the DEFAULT 20k budget normally no-ops,
	//     but a `keepRecentTokens: 0` override always cuts — the proof hook path.
	const { sql: sql2 } = createFakeSql();
	const repo2 = new TediSessionRepo({ sql: sql2, readDurable: noDurable }); // default 20k budget
	for (let i = 1; i <= 4; i++) {
		repo2.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "short", // ~2 tokens — nowhere near 20k
			sessionKey: "chat:F",
			ts: i,
		});
	}
	const underBudget = await repo2.compactSession("chat:F", async () => "X");
	assert.deepEqual(
		underBudget,
		{ compacted: false },
		"short session no-ops under the default budget ⇒ compacted=false",
	);
	const forced = await repo2.compactSession(
		"chat:F",
		async () => "FORCED-SUMMARY",
		{
			keepRecentTokens: 0,
		},
	);
	assert.equal(
		forced?.compacted,
		true,
		"keepRecentTokens:0 forces a cut on the same short session",
	);
	assert.equal(forced?.summaryChars, "FORCED-SUMMARY".length);

	// (c) No branch at all ⇒ null (emitter stays silent).
	const { sql: sql3 } = createFakeSql();
	const repo3 = new TediSessionRepo({ sql: sql3, readDurable: noDurable });
	const empty = await repo3.compactSession("chat:none", async () => "S");
	assert.equal(empty, null, "empty session ⇒ null result");

	// (d) Null summary ⇒ compacted=false (no marker, emitter stays silent).
	const { sql: sql4 } = createFakeSql();
	const repo4 = new TediSessionRepo({
		sql: sql4,
		readDurable: noDurable,
		keepRecentTokens: 25,
	});
	for (let i = 1; i <= 6; i++) {
		repo4.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: "z".repeat(40),
			sessionKey: "chat:N",
			ts: i,
		});
	}
	const nulled = await repo4.compactSession("chat:N", async () => null);
	assert.deepEqual(
		nulled,
		{ compacted: false },
		"null summary ⇒ compacted=false",
	);
}

console.log("session-repo.test.ts: all assertions passed");
