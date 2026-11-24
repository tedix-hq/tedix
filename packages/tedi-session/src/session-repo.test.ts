/**
 * Offline unit test for the phase-1 append-only `TediSessionRepo`
 * (`SessionHarnessBackend` over DO-SQLite). Pure / fake-port ⇒ plain
 * `node:assert`, no Worker harness, no DO import.
 * Run: `bun run src/session-repo.test.ts`.
 *
 * The DO-SQLite substrate is a real in-memory `node:sqlite` database behind the
 * shared Durable Object storage fixture, so the repo runs its actual Drizzle
 * statements and migrations offline. We also wire a `SessionHarness` over the repo
 * to prove the frozen harness contract (ledger-first `buildContext`) still works
 * unchanged over this backend.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
	selectRecentWindow,
	TediSessionRepo,
} from "./session-repo";

// ── Real in-memory DO-SQLite ──────────────────────────────────────────────────
// `rows` is a live view of `session_entries`; `queries` records every statement
// the repo sends to storage, in order.

interface StoredRow {
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

type Storage = ConstructorParameters<typeof TediSessionRepo>[0]["storage"];
type Bound = Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>;

/**
 * The Durable Object storage slice drizzle-orm/durable-sqlite drives
 * (`sql.exec` cursors with `toArray`/`raw`, and `transactionSync`) over
 * `node:sqlite`. Records each statement and can fail on demand.
 */
function recordingStorage(
	db: DatabaseSync,
	queries: string[] = [],
	failOn?: () => string | undefined,
): Storage {
	const exec = (query: string, ...params: unknown[]) => {
		queries.push(query);
		const failing = failOn?.();
		if (failing && query.includes(failing))
			throw new Error("injected storage failure");
		const statement = db.prepare(query);
		const bound = params.map((value) =>
			typeof value === "boolean" ? Number(value) : value,
		) as Bound;
		const verb = query.trimStart().split(/\s+/, 1)[0]!.toUpperCase();
		const rows =
			verb === "SELECT" ||
			verb === "WITH" ||
			verb === "PRAGMA" ||
			/\bRETURNING\b/i.test(query)
				? (statement.all(...bound) as Record<string, unknown>[])
				: (statement.run(...bound), []);
		return {
			toArray: () => rows,
			raw: () => {
				const values = rows.map((row) => Object.values(row));
				const iterator = values[Symbol.iterator]();
				return Object.assign(iterator, { toArray: () => values });
			},
		};
	};
	return {
		sql: { exec },
		transactionSync<T>(closure: () => T): T {
			db.exec("BEGIN");
			try {
				const result = closure();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

function createStore(): {
	storage: Storage;
	rows: StoredRow[];
	queries: string[];
} {
	const db = new DatabaseSync(":memory:");
	const queries: string[] = [];
	const read = (): StoredRow[] => {
		try {
			return db
				.prepare("SELECT * FROM session_entries")
				.all() as unknown as StoredRow[];
		} catch {
			return [];
		}
	};
	const rows = new Proxy([] as StoredRow[], {
		get(_target, property) {
			const current = read();
			const value = Reflect.get(current, property);
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
	return { storage: recordingStorage(db, queries), rows, queries };
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

// Real SQLite covers every interrupted column-add boundary and cold restart.
for (let existingColumns = 0; existingColumns <= 4; existingColumns++) {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE session_entries (
			id TEXT PRIMARY KEY, session_key TEXT NOT NULL, parent_id TEXT,
			type TEXT NOT NULL DEFAULT 'message', role TEXT NOT NULL,
			content TEXT NOT NULL, idempotency_key TEXT, ts INTEGER NOT NULL)`);
		const definitions = [
			"first_kept_entry_id TEXT",
			"tokens_before INTEGER",
			"model_provider TEXT",
			"model_id TEXT",
		];
		for (const definition of definitions.slice(0, existingColumns))
			db.exec(`ALTER TABLE session_entries ADD COLUMN ${definition}`);
		db.exec(`INSERT INTO session_entries
			(id, session_key, type, role, content, idempotency_key, ts)
			VALUES ('original', 'chat:old', 'message', 'user', 'Keep this message', 'old:1', 1)`);
		if (existingColumns >= 2)
			db.exec(`INSERT INTO session_entries
				(id, session_key, parent_id, type, role, content, ts, first_kept_entry_id, tokens_before)
				VALUES ('summary', 'chat:old', 'original', 'compaction', 'assistant', 'Keep this summary', 2, 'original', 100)`);
		const before = db
			.prepare("SELECT * FROM session_entries ORDER BY ts")
			.all();
		const queries: string[] = [];
		const storage = recordingStorage(db, queries);
		new TediSessionRepo({ storage, readDurable: noDurable }).listTurns();
		assert.equal(
			queries.filter((q) => q.startsWith("ALTER TABLE")).length,
			4 - existingColumns,
		);
		assert.deepEqual(
			db
				.prepare(`SELECT name FROM pragma_table_info('session_entries')
			WHERE name IN ('first_kept_entry_id', 'tokens_before', 'model_provider', 'model_id')`)
				.all().length,
			4,
		);
		const after = db.prepare("SELECT * FROM session_entries ORDER BY ts").all();
		assert.equal(after.length, before.length);
		for (let row = 0; row < before.length; row++) {
			for (const [key, value] of Object.entries(before[row]!))
				assert.equal(
					after[row]![key],
					value,
					`preserves ${key} with ${existingColumns} columns`,
				);
		}
		assert.ok(
			new TediSessionRepo({ storage, readDurable: noDurable })
				.getBranch("chat:old")
				.some((entry) => entry.id === "original"),
			`reads the preserved message with ${existingColumns} columns`,
		);
		queries.length = 0;
		new TediSessionRepo({ storage, readDurable: noDurable }).listTurns();
		assert.equal(
			queries.filter((q) => q.startsWith("ALTER TABLE")).length,
			0,
			"restart never re-adds columns",
		);
	} finally {
		db.close();
	}
}

// Another store in the same object may have recorded its migrations first;
// this store still adopts its own older table.
{
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE session_entries (
			id TEXT PRIMARY KEY, session_key TEXT NOT NULL, parent_id TEXT,
			type TEXT NOT NULL DEFAULT 'message', role TEXT NOT NULL,
			content TEXT NOT NULL, idempotency_key TEXT, ts INTEGER NOT NULL)`);
		db.exec(`INSERT INTO session_entries (id, session_key, role, content, ts)
			VALUES ('kept', 'chat:shared', 'user', 'Still here', 1)`);
		db.exec(`CREATE TABLE __drizzle_migrations (
			id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric,
			name text, applied_at TEXT)`);
		db.exec(`INSERT INTO __drizzle_migrations (hash, created_at, name)
			VALUES ('', 0, '20261124113147_poppy_store_core')`);
		const storage = recordingStorage(db);
		const repo = new TediSessionRepo({ storage, readDurable: noDurable });
		assert.deepEqual(
			repo.listTurns().map((turn) => turn.content),
			["Still here"],
		);
		repo.appendTurn({
			role: "assistant",
			content: "Reply",
			sessionKey: "chat:shared",
			ts: 2,
			modelIdentity: { provider: "anthropic", model: "claude" },
		});
		assert.equal(
			repo.getBranch("chat:shared").at(-1)?.modelIdentity?.model,
			"claude",
			"the adopted table has the model columns",
		);
	} finally {
		db.close();
	}
}

// A real migration failure propagates; retry adds only the remaining columns.
for (const failedStatement of [
	"PRAGMA table_info(session_entries)",
	"ADD COLUMN first_kept_entry_id",
	"ADD COLUMN tokens_before",
	"ADD COLUMN model_provider",
	"ADD COLUMN model_id",
]) {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`CREATE TABLE session_entries (
			id TEXT PRIMARY KEY, session_key TEXT NOT NULL, parent_id TEXT,
			type TEXT NOT NULL DEFAULT 'message', role TEXT NOT NULL,
			content TEXT NOT NULL, idempotency_key TEXT, ts INTEGER NOT NULL)`);
		let failAlter = true;
		const storage = recordingStorage(db, [], () =>
			failAlter ? failedStatement : undefined,
		);
		const repo = new TediSessionRepo({ storage, readDurable: noDurable });
		// Drizzle wraps storage errors; the original is the cause.
		assert.throws(
			() => repo.listTurns(),
			(error: Error & { cause?: Error }) =>
				/injected storage failure/.test(
					`${error.message} ${error.cause?.message ?? ""}`,
				),
			failedStatement,
		);
		failAlter = false;
		assert.deepEqual(repo.listTurns(), []);
	} finally {
		db.close();
	}
}

{
	const db = new DatabaseSync(":memory:");
	try {
		const queries: string[] = [];
		const storage = recordingStorage(db, queries);
		assert.deepEqual(
			new TediSessionRepo({ storage, readDurable: noDurable }).listTurns(),
			[],
		);
		assert.ok(
			!queries.some((query) => query.startsWith("ALTER TABLE")),
			"fresh stores use the current schema",
		);
	} finally {
		db.close();
	}
}

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
	const { storage } = createStore();
	const repo = new TediSessionRepo({ storage, readDurable: noDurable });
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
	const { storage, rows } = createStore();
	const repo = new TediSessionRepo({ storage, readDurable: noDurable });
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
	const { storage, rows } = createStore();
	const repo = new TediSessionRepo({ storage, readDurable: noDurable });
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
	const { storage } = createStore();
	const repo = new TediSessionRepo({ storage, readDurable: noDurable });
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
	const { storage } = createStore();
	const repo = new TediSessionRepo({
		storage,
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
	const { storage } = createStore();
	let seenKey = "";
	let seenLimit: number | undefined;
	const repo = new TediSessionRepo({
		storage,
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
	const { storage } = createStore();
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "Q1", ts: 1 },
		{ role: "assistant", content: "A1", ts: 2 },
	];
	const repo = new TediSessionRepo({
		storage,
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
	const { storage } = createStore();
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "OLD-Q", ts: 1 },
		{ role: "assistant", content: "OLD-A", ts: 2 },
		{ role: "user", content: "NEW-Q", ts: 3 }, // also in cache → de-duped by merge
	];
	const repo = new TediSessionRepo({
		storage,
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
	const { storage } = createStore();
	const durable: TediSessionContextEntry[] = [
		{ role: "user", content: "OLD-Q", ts: 10 },
		{ role: "assistant", content: "OLD-A", ts: 20 },
		{ role: "user", content: "KEPT-Q", ts: 30 },
		{ role: "assistant", content: "KEPT-A", ts: 40 },
	];
	const repo = new TediSessionRepo({
		storage,
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
	const { storage, rows } = createStore();
	const repo = new TediSessionRepo({
		storage,
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
	const { storage, rows } = createStore();
	const repo = new TediSessionRepo({
		storage,
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
	const { storage, rows } = createStore();
	const repo = new TediSessionRepo({
		storage,
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
	const { storage, rows } = createStore();
	// Big budget ⇒ nothing to compact.
	const repo = new TediSessionRepo({
		storage,
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
	const { storage } = createStore();
	const repo = new TediSessionRepo({ storage, readDurable: noDurable });
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
	const { storage, rows } = createStore();
	// keepRecentTokens = 20 ⇒ tail of ~2 length-40 turns (10 tokens each) is kept.
	const repo = new TediSessionRepo({
		storage,
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

// ── Repo: compacted recent reads stay SQL-bounded across all sessions ─────────
{
	const { storage, queries } = createStore();
	const repo = new TediSessionRepo({
		storage,
		readDurable: noDurable,
		maxRecentTurns: 4,
		keepRecentTokens: 8,
	});
	for (let i = 1; i <= 30; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: `compacted-${i}-${"x".repeat(1_000)}`,
			sessionKey: "chat:compacted",
			ts: i,
		});
	}
	await repo.compactSession("chat:compacted", async () => "BOUNDED-SUMMARY");
	for (let i = 31; i <= 40; i++) {
		repo.appendTurn({
			role: i % 2 ? "user" : "assistant",
			content: `other-${i}`,
			sessionKey: "chat:other",
			ts: i,
		});
	}

	const queryStart = queries.length;
	const recent = repo.listTurns();
	const readQueries = queries.slice(queryStart);
	assert.equal(
		recent.length,
		4,
		"projected read returns only the configured cap",
	);
	assert.deepEqual(
		recent.map((turn) => turn.content),
		["other-37", "other-38", "other-39", "other-40"],
		"the bounded projection keeps the globally newest turns",
	);
	assert.ok(
		readQueries.some((query) =>
			query.trimStart().startsWith("WITH latest_compactions AS"),
		),
		"compacted reads project and limit inside SQL",
	);
	assert.ok(
		!readQueries.some(
			(query) =>
				query.includes('"parent_id"') &&
				query.includes('from "session_entries"') &&
				!query.includes('"session_entries"."session_key" = ?'),
		),
		"recent reads never materialize every session entry",
	);
}

// ── Repo: compactSession returns an observability result (compacted true/false)
//        + the `keepRecentTokens` FORCE override cuts a SHORT session ───────────
{
	// (a) Real cut under a small budget ⇒ rich result the ledger emitter consumes.
	const { storage } = createStore();
	const repo = new TediSessionRepo({
		storage,
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
	const { storage: sql2 } = createStore();
	const repo2 = new TediSessionRepo({ storage: sql2, readDurable: noDurable }); // default 20k budget
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
	const { storage: sql3 } = createStore();
	const repo3 = new TediSessionRepo({ storage: sql3, readDurable: noDurable });
	const empty = await repo3.compactSession("chat:none", async () => "S");
	assert.equal(empty, null, "empty session ⇒ null result");

	// (d) Null summary ⇒ compacted=false (no marker, emitter stays silent).
	const { storage: sql4 } = createStore();
	const repo4 = new TediSessionRepo({
		storage: sql4,
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
