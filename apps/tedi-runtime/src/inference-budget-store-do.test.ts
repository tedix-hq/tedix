import { Database } from "bun:sqlite";
import { assertTediChatNotCanceled } from "./pi-recovery";
import assert from "node:assert/strict";
import {
	DoInferenceBudgetStore,
	InferenceBudgetExceededError,
} from "./inference-budget-store-do";

function makeRunner() {
	const db = new Database(":memory:");
	return makeRunnerForDatabase(db);
}

function makeRunnerForDatabase(db: Database) {
	return {
		sql<T = Record<string, string | number | boolean | null>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			const sql = strings.reduce(
				(text, part, index) => text + part + (index < values.length ? "?" : ""),
				"",
			);
			return db.query(sql).all(...values) as T[];
		},
	};
}

const limits = {
	dailyMessageLimit: 2,
	dailyTokenLimit: 100,
	operatorMessageReserve: 0,
	operatorTokenReserve: 0,
	governedLearningMessageReserve: 0,
	governedLearningTokenReserve: 0,
};
const dayOne = new Date("2026-07-19T12:00:00.000Z");
const dayTwo = new Date("2026-07-20T00:00:00.000Z");

// Schema steps survive independent ALTER/backfill/acknowledgement failures.
// Recovery belongs only to the exact historical rows and balances snapshotted
// before ALTER, even if another writer advances usage before initialization retries.
for (const phase of [
	"tokens-column",
	"tokens-backfill",
	"tokens-complete",
	"messages-column",
	"messages-backfill",
	"messages-complete",
	"admission-column",
] as const) {
	const db = new Database(":memory:");
	db.run(`CREATE TABLE inference_daily_usage (
		day TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL,
		used_messages INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
	db.run("INSERT INTO inference_daily_usage VALUES ('2026-07-19', 100, 2, 0)");
	if (phase === "admission-column") {
		db.run(`CREATE TABLE inference_turn_usage (
			turn_id TEXT PRIMARY KEY, day TEXT NOT NULL, reserved_tokens INTEGER NOT NULL,
			recorded_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL)`);
	}
	const runner = makeRunnerForDatabase(db);
	const failure = new Error(`injected ${phase}`);
	let injected = false;
	const failingRunner = {
		sql<T>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			const sql = strings.join("?").replace(/\s+/g, " ");
			const matches =
				phase === "admission-column"
					? sql.includes("ALTER TABLE inference_turn_usage")
					: phase.endsWith("-column")
						? sql.includes(
								`ADD COLUMN operator_recovery_anchor_${phase.split("-")[0]}`,
							)
						: phase.endsWith("-backfill")
							? sql.includes(
									`UPDATE inference_daily_usage SET operator_recovery_anchor_${phase.split("-")[0]} =`,
								)
							: sql.includes("SET completed = 1") &&
								values.includes(
									phase.startsWith("tokens-") ? "tokens" : "messages",
								);
			if (!injected && matches) {
				injected = true;
				throw failure;
			}
			return runner.sql<T>(strings, ...values);
		},
	};
	const store = new DoInferenceBudgetStore(failingRunner);
	assert.throws(
		() => store.status(limits, dayOne),
		(error) => error === failure,
		`${phase} propagates the original storage failure`,
	);
	assert.equal(injected, true);
	db.run(
		"UPDATE inference_daily_usage SET used_tokens = 170, used_messages = 3",
	);
	db.run(`INSERT INTO inference_daily_usage (day, used_tokens, used_messages, updated_at)
		VALUES ('2026-07-20', 200, 4, 0)`);
	for (let reopen = 0; reopen < 2; reopen++) {
		(reopen === 0 ? store : new DoInferenceBudgetStore(runner)).status(
			limits,
			dayOne,
		);
		assert.deepEqual(
			db
				.query(`SELECT day, used_tokens, used_messages,
			operator_recovery_anchor_tokens, operator_recovery_anchor_messages
			FROM inference_daily_usage ORDER BY day`)
				.all(),
			[
				{
					day: "2026-07-19",
					used_tokens: 170,
					used_messages: 3,
					operator_recovery_anchor_tokens: 100,
					operator_recovery_anchor_messages: 2,
				},
				{
					day: "2026-07-20",
					used_tokens: 200,
					used_messages: 4,
					operator_recovery_anchor_tokens: null,
					operator_recovery_anchor_messages: null,
				},
			],
			`${phase} keeps historical recovery fixed and new days unanchored`,
		);
	}
}

// Fresh stores and previously migrated columns must never infer an allowance
// from NULL: on a normal day NULL deliberately retains the configured ceiling.
{
	const db = new Database(":memory:");
	const runner = makeRunnerForDatabase(db);
	new DoInferenceBudgetStore(runner).admit("fresh", limits, 20, dayOne);
	new DoInferenceBudgetStore(runner).status(limits, dayOne);
	assert.deepEqual(
		db
			.query(`SELECT operator_recovery_anchor_tokens,
		operator_recovery_anchor_messages FROM inference_daily_usage`)
			.all()[0],
		{
			operator_recovery_anchor_tokens: null,
			operator_recovery_anchor_messages: null,
		},
	);
	assert.equal(
		runner.sql<{
			count: number;
		}>`SELECT COUNT(*) AS count FROM inference_recovery_anchor_migrations`[0]
			?.count,
		0,
	);
}

// A column added by old code has no migration journal. Its NULLs cannot be
// distinguished from normal new-day NULLs, so never retroactively seed them.
// The independently missing message column still receives its own migration.
{
	const db = new Database(":memory:");
	db.run(`CREATE TABLE inference_daily_usage (
		day TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL, used_messages INTEGER NOT NULL,
		operator_recovery_anchor_tokens INTEGER, updated_at INTEGER NOT NULL)`);
	db.run(
		"INSERT INTO inference_daily_usage VALUES ('2026-07-19', 100, 2, 23, 0)",
	);
	db.run(
		"INSERT INTO inference_daily_usage VALUES ('2026-07-20', 200, 4, NULL, 0)",
	);
	new DoInferenceBudgetStore(makeRunnerForDatabase(db)).status(limits, dayOne);
	assert.deepEqual(
		db
			.query(`SELECT operator_recovery_anchor_tokens,
		operator_recovery_anchor_messages FROM inference_daily_usage ORDER BY day`)
			.all(),
		[
			{
				operator_recovery_anchor_tokens: 23,
				operator_recovery_anchor_messages: 2,
			},
			{
				operator_recovery_anchor_tokens: null,
				operator_recovery_anchor_messages: 4,
			},
		],
	);
}

// Snapshotting both migrations is atomic: failure halfway through the INSERT
// cannot leave only token history frozen while message history drifts on retry.
{
	const db = new Database(":memory:");
	db.run(`CREATE TABLE inference_daily_usage (day TEXT PRIMARY KEY,
		used_tokens INTEGER NOT NULL, used_messages INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
	db.run("INSERT INTO inference_daily_usage VALUES ('2026-07-19', 100, 2, 0)");
	db.run(`CREATE TABLE inference_recovery_anchor_migrations (
		migration TEXT NOT NULL, day TEXT NOT NULL, anchor INTEGER NOT NULL,
		completed INTEGER NOT NULL, PRIMARY KEY (migration, day))`);
	db.run(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON inference_recovery_anchor_migrations
		WHEN NEW.migration = 'messages' BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END`);
	const runner = makeRunnerForDatabase(db);
	const store = new DoInferenceBudgetStore(runner);
	assert.throws(
		() => store.status(limits, dayOne),
		/injected snapshot failure/,
	);
	assert.equal(
		runner.sql<{
			count: number;
		}>`SELECT COUNT(*) AS count FROM inference_recovery_anchor_migrations`[0]
			?.count,
		0,
	);
	assert.equal(
		db.query("PRAGMA table_info(inference_daily_usage)").all().length,
		4,
	);
	db.run("DROP TRIGGER fail_snapshot");
	store.status(limits, dayOne);
	assert.deepEqual(
		db
			.query(`SELECT operator_recovery_anchor_tokens,
		operator_recovery_anchor_messages FROM inference_daily_usage`)
			.all()[0],
		{
			operator_recovery_anchor_tokens: 100,
			operator_recovery_anchor_messages: 2,
		},
	);
}

// Even an empty legacy table needs a durable marker. A day created after its
// failed ALTER must not become historical recovery history on the next attempt.
{
	const db = new Database(":memory:");
	db.run(`CREATE TABLE inference_daily_usage (day TEXT PRIMARY KEY,
		used_tokens INTEGER NOT NULL, used_messages INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
	const runner = makeRunnerForDatabase(db);
	let fail = true;
	const store = new DoInferenceBudgetStore({
		sql<T>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			if (
				fail &&
				strings.join("?").includes("ADD COLUMN operator_recovery_anchor_tokens")
			) {
				fail = false;
				throw new Error("injected empty-table ALTER failure");
			}
			return runner.sql<T>(strings, ...values);
		},
	});
	assert.throws(
		() => store.status(limits, dayOne),
		/injected empty-table ALTER failure/,
	);
	db.run("INSERT INTO inference_daily_usage VALUES ('2026-07-19', 100, 2, 0)");
	store.status(limits, dayOne);
	assert.deepEqual(
		db
			.query(`SELECT operator_recovery_anchor_tokens,
		operator_recovery_anchor_messages FROM inference_daily_usage`)
			.all()[0],
		{
			operator_recovery_anchor_tokens: null,
			operator_recovery_anchor_messages: null,
		},
	);
}

// Attempt receipts survive lost acknowledgements and retain independent unknown liabilities.
{
	const runner = makeRunner();
	const store = new DoInferenceBudgetStore(runner);
	store.admit("journal", limits, 20, dayOne);
	assert.equal(
		store.reserveStep("journal", "s1", 30, limits, dayOne).usedTokens,
		30,
	);
	const restarted = new DoInferenceBudgetStore(runner);
	assert.equal(
		restarted.reserveStep("journal", "s1", 30, limits, dayOne).usedTokens,
		30,
	);
	assert.throws(
		() => restarted.reserveStep("journal", "s1", 31, limits, dayOne),
		/Conflicting/,
	);
	assert.equal(
		restarted.recordStep("journal", "s1", null, limits, dayOne).usedTokens,
		30,
	);
	assert.equal(
		restarted.reserveStep("journal", "s2", 20, limits, dayOne).usedTokens,
		50,
	);
	assert.equal(
		restarted.recordStep("journal", "s2", 15, limits, dayOne).usedTokens,
		45,
	);
	assert.equal(
		restarted.recordStep("journal", "s2", 15, limits, dayOne).usedTokens,
		45,
	);
	assert.throws(
		() => restarted.recordStep("journal", "s2", 16, limits, dayOne),
		/Conflicting/,
	);
	assert.equal(
		restarted.checkMidTurn("journal", limits, 500, dayOne).usage.usedTokens,
		45,
	);
	restarted.recordTokens("journal", 500, dayOne);
	assert.equal(restarted.status(limits, dayOne).usedTokens, 45);
	assert.equal(
		restarted.recordStep("journal", "s1", 0, limits, dayOne).usedTokens,
		15,
	);
	assert.equal(
		restarted.recordStep("journal", "s1", null, limits, dayOne).usedTokens,
		15,
	);
	assert.throws(
		() => restarted.recordStep("journal", "missing", 1, limits, dayOne),
		/reserved attempt/,
	);
}

// A storage failure cannot commit a receipt while dropping its matching debit.
{
	const runner = makeRunner();
	const store = new DoInferenceBudgetStore(runner);
	store.admit("atomic", limits, 20, dayOne);
	store.reserveStep("atomic", "one", 20, limits, dayOne);
	runner.sql`CREATE TRIGGER reject_accounting BEFORE UPDATE ON inference_turn_usage
		BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END`;
	assert.throws(
		() => store.recordStep("atomic", "one", 35, limits, dayOne),
		/injected accounting failure/,
	);
	assert.equal(
		store.status(limits, dayOne).usedTokens,
		20,
		"receipt and daily debit roll back together",
	);
	runner.sql`DROP TRIGGER reject_accounting`;
	assert.equal(
		store.recordStep("atomic", "one", 35, limits, dayOne).usedTokens,
		35,
	);
}

// A fully reserved first call transfers credit; later calls cannot borrow that credit again.
{
	const store = new DoInferenceBudgetStore(makeRunner());
	store.admit("full", limits, 100, dayOne);
	assert.equal(
		store.reserveStep("full", "first", 100, limits, dayOne).usedTokens,
		100,
	);
	assert.throws(
		() => store.reserveStep("full", "next", 1, limits, dayOne),
		InferenceBudgetExceededError,
	);
	assert.equal(
		store.recordStep("full", "first", 90, limits, dayOne).usedTokens,
		90,
	);
	assert.equal(
		store.reserveStep("full", "next", 10, limits, dayOne).usedTokens,
		100,
	);
	// Real usage is accounted even when it exceeds the estimate and ceiling.
	assert.equal(
		store.recordStep("full", "next", 20, limits, dayOne).usedTokens,
		110,
	);
}

// Daily continuation preserves immutable attribution for late receipts.
{
	const store = new DoInferenceBudgetStore(makeRunner());
	store.admit("old", limits, 20, dayOne);
	store.reserveStep("old", "pending", 20, limits, dayOne);
	store.admit("new", limits, 10, dayTwo);
	assert.equal(
		store.reserveStep("old", "retry", 10, limits, dayTwo).usedTokens,
		20,
	);
	assert.equal(store.admit("old", limits, 10, dayTwo).usedMessages, 2);
	const receipt = store.recordStep("old", "pending", 40, limits, dayTwo);
	assert.equal(receipt.day, "2026-07-19");
	assert.equal(receipt.usedTokens, 40);
	assert.equal(store.status(limits, dayTwo).usedTokens, 20);
}

// Class restrictions and malformed receipts cannot widen authority or silently erase liability.
{
	const runner = makeRunner();
	const store = new DoInferenceBudgetStore(runner);
	const reserved = { ...limits, operatorTokenReserve: 40 };
	store.admit("background", reserved, 20, dayOne, "background");
	store.reserveStep("background", "one", 60, reserved, dayOne);
	assert.throws(
		() => store.reserveStep("background", "two", 1, reserved, dayOne),
		InferenceBudgetExceededError,
	);
	assert.throws(
		() => store.recordStep("background", "one", Number.NaN, reserved, dayOne),
		/nonnegative/,
	);
	assert.throws(
		() => store.recordStep("background", "one", -1, reserved, dayOne),
		/nonnegative/,
	);
	assert.throws(
		() => store.reserveStep("background", "", 1, reserved, dayOne),
		/identity/,
	);
	runner.sql`UPDATE inference_turn_usage SET admission_class = NULL WHERE turn_id = ${"background"}`;
	assert.throws(
		() => store.reserveStep("background", "three", 1, reserved, dayOne),
		/known admission/,
	);
}

{
	const store = new DoInferenceBudgetStore(makeRunner());
	assert.equal(store.admit("turn-1", limits, 20, dayOne).usedTokens, 20);
	assert.equal(
		store.admit("turn-1", limits, 20, dayOne).usedMessages,
		1,
		"replayed admission is idempotent",
	);
	store.recordTokens("turn-1", 30, dayOne);
	assert.deepEqual(store.status(limits, dayOne), {
		day: "2026-07-19",
		...limits,
		admissionClass: "operator",
		backgroundMessageLimit: 2,
		backgroundTokenLimit: 100,
		governedLearningMessageLimit: 2,
		governedLearningTokenLimit: 100,
		admissionMessageLimit: 2,
		admissionTokenLimit: 100,
		remainingMessages: 1,
		remainingTokens: 70,
		usedMessages: 1,
		usedTokens: 30,
	});
	store.recordTokens("turn-1", 10, dayOne);
	assert.equal(store.status(limits, dayOne).usedTokens, 40);
	assert.equal(store.admit("turn-2", limits, 50, dayOne).usedMessages, 2);
	assert.throws(
		() => store.admit("turn-3", limits, 1, dayOne),
		(error) => error instanceof InferenceBudgetExceededError,
	);
	assert.equal(store.admit("turn-4", limits, 10, dayTwo).usedMessages, 1);
}

{
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE inference_daily_usage (
			day TEXT PRIMARY KEY,
			used_tokens INTEGER NOT NULL,
			used_messages INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.run(`
		INSERT INTO inference_daily_usage
		VALUES ('2026-07-19', 554024, 8, ${dayOne.getTime()})
	`);
	const store = new DoInferenceBudgetStore(makeRunnerForDatabase(db));
	const productionDefaults = {
		dailyMessageLimit: 50,
		dailyTokenLimit: 500_000,
		operatorMessageReserve: 5,
		operatorTokenReserve: 100_000,
		governedLearningMessageReserve: 20,
		governedLearningTokenReserve: 100_000,
	};
	assert.throws(
		() =>
			store.admit(
				"background-after-migration",
				productionDefaults,
				1,
				dayOne,
				"background",
			),
		(error) => error instanceof InferenceBudgetExceededError,
		"legacy usage above the cap remains closed to background work",
	);
	assert.equal(
		store.admit(
			"operator-after-migration",
			productionDefaults,
			80_000,
			dayOne,
			"operator",
		).usedTokens,
		634_024,
		"migration preserves a fresh operator reserve above legacy usage",
	);
	assert.throws(
		() =>
			store.admit(
				"operator-beyond-recovery-reserve",
				productionDefaults,
				20_001,
				dayOne,
				"operator",
			),
		(error) => error instanceof InferenceBudgetExceededError,
		"the recovery anchor grants exactly one configured reserve",
	);
	assert.throws(
		() =>
			store.admit(
				"background-next-day",
				productionDefaults,
				400_001,
				dayTwo,
				"background",
			),
		(error) => error instanceof InferenceBudgetExceededError,
		"new days retain the normal background ceiling",
	);
}

{
	const store = new DoInferenceBudgetStore(makeRunner());
	assert.throws(
		() =>
			store.admit(
				"turn",
				{
					dailyMessageLimit: 0,
					dailyTokenLimit: 0,
					operatorMessageReserve: 0,
					operatorTokenReserve: 0,
					governedLearningMessageReserve: 0,
					governedLearningTokenReserve: 0,
				},
				1,
			),
		(error) => error instanceof InferenceBudgetExceededError,
		"zero limits fail closed",
	);
}

{
	const store = new DoInferenceBudgetStore(makeRunner());
	const reserved = {
		dailyMessageLimit: 4,
		dailyTokenLimit: 100,
		operatorMessageReserve: 1,
		operatorTokenReserve: 20,
		governedLearningMessageReserve: 1,
		governedLearningTokenReserve: 20,
	};
	assert.equal(
		store.admit("cron-1", reserved, 60, dayOne, "background").usedTokens,
		60,
	);
	assert.throws(
		() => store.admit("cron-2", reserved, 1, dayOne, "background"),
		(error) =>
			error instanceof InferenceBudgetExceededError &&
			error.usage.admissionClass === "background" &&
			error.message.includes("for governed learning") &&
			error.message.includes("for operator work"),
		"general background turns cannot consume either protected reserve",
	);
	assert.equal(
		store.admit("learning-1", reserved, 20, dayOne, "governed_learning")
			.usedTokens,
		80,
		"governed learning can use its protected slice",
	);
	assert.equal(
		store.admit("operator-1", reserved, 20, dayOne, "operator").usedTokens,
		100,
		"operator work can use the reserved capacity without raising the hard ceiling",
	);
	assert.throws(
		() => store.admit("operator-2", reserved, 1, dayOne, "operator"),
		(error) => error instanceof InferenceBudgetExceededError,
		"the total daily ceiling still fails closed",
	);
}

{
	const store = new DoInferenceBudgetStore(makeRunner());
	const productionDefaults = {
		dailyMessageLimit: 50,
		dailyTokenLimit: 500_000,
		operatorMessageReserve: 5,
		operatorTokenReserve: 100_000,
		governedLearningMessageReserve: 20,
		governedLearningTokenReserve: 100_000,
	};
	store.admit(
		"background-history",
		productionDefaults,
		277_066,
		dayOne,
		"background",
	);
	assert.throws(
		() =>
			store.admit(
				"background-overrun",
				productionDefaults,
				23_001,
				dayOne,
				"background",
			),
		(error) => error instanceof InferenceBudgetExceededError,
		"general background work cannot consume the governed-learning reserve",
	);
	assert.equal(
		store.admit(
			"scheduled-learning",
			productionDefaults,
			100_001,
			dayOne,
			"governed_learning",
		).usedTokens,
		377_067,
		"the protected slice remains admissible for governed-learning schedules",
	);
	assert.equal(
		store.admit(
			"operator-work-item",
			productionDefaults,
			100_001,
			dayOne,
			"operator",
		).usedTokens,
		477_068,
		"operator-assigned labor retains its separate protected slice",
	);
}

// ── checkMidTurn: mid-turn enforcement for the agentic tool loop ─────────────
// Admission reserves ONE pre-turn estimate,
// but a tool loop makes dozens of provider calls under it. checkMidTurn feeds
// the turn's CUMULATIVE usage into the day ledger at each step boundary and
// reports when the class ceiling is hit so the loop stops.

{
	// Under limit: cumulative recording replaces the reservation and ratchets.
	const store = new DoInferenceBudgetStore(makeRunner());
	store.admit("turn-1", limits, 20, dayOne);
	const first = store.checkMidTurn("turn-1", limits, 5, dayOne);
	assert.equal(first.exhausted, false);
	assert.equal(
		first.usage.usedTokens,
		5,
		"the first mid-turn record releases the admission reservation",
	);
	const second = store.checkMidTurn("turn-1", limits, 40, dayOne);
	assert.equal(second.exhausted, false);
	assert.equal(second.usage.usedTokens, 40, "cumulative totals ratchet");
	const replay = store.checkMidTurn("turn-1", limits, 40, dayOne);
	assert.equal(
		replay.usage.usedTokens,
		40,
		"a replayed cumulative total is a no-op (idempotent settlement)",
	);
	const stale = store.checkMidTurn("turn-1", limits, 30, dayOne);
	assert.equal(
		stale.usage.usedTokens,
		40,
		"a stale smaller cumulative never decrements the day ledger",
	);
}

{
	// Over limit: the check trips exactly at the class ceiling and stays tripped.
	const store = new DoInferenceBudgetStore(makeRunner());
	store.admit("turn-1", limits, 10, dayOne);
	assert.equal(
		store.checkMidTurn("turn-1", limits, 99, dayOne).exhausted,
		false,
	);
	const at = store.checkMidTurn("turn-1", limits, 100, dayOne);
	assert.equal(
		at.exhausted,
		true,
		"the gate trips when used tokens reach the daily limit",
	);
	assert.equal(at.usage.usedTokens, 100);
	assert.equal(
		store.checkMidTurn("turn-1", limits, 250, dayOne).usage.usedTokens,
		250,
		"an over-limit turn still records its real spend before stopping",
	);
}

{
	// Nested class reserves: the admission class stamped on each turn remains
	// load-bearing at every mid-turn step boundary.
	const store = new DoInferenceBudgetStore(makeRunner());
	const reserved = {
		dailyMessageLimit: 4,
		dailyTokenLimit: 100,
		operatorMessageReserve: 1,
		operatorTokenReserve: 20,
		governedLearningMessageReserve: 1,
		governedLearningTokenReserve: 20,
	};
	store.admit("cron-1", reserved, 10, dayOne, "background");
	assert.equal(
		store.checkMidTurn("cron-1", reserved, 59, dayOne).exhausted,
		false,
	);
	const tripped = store.checkMidTurn("cron-1", reserved, 60, dayOne);
	assert.equal(
		tripped.exhausted,
		true,
		"a background turn trips at the background ceiling, not the daily limit",
	);
	assert.equal(tripped.usage.admissionClass, "background");
	// Governed learning can use the next slice but still stops before operator
	// capacity.
	store.admit("learning-1", reserved, 5, dayOne, "governed_learning");
	assert.equal(
		store.checkMidTurn("learning-1", reserved, 19, dayOne).exhausted,
		false,
	);
	const learningTripped = store.checkMidTurn(
		"learning-1",
		reserved,
		20,
		dayOne,
	);
	assert.equal(learningTripped.exhausted, true);
	assert.equal(learningTripped.usage.admissionClass, "governed_learning");
	// Operator work still has its final reserve headroom.
	store.admit("op-1", reserved, 5, dayOne, "operator");
	assert.equal(
		store.checkMidTurn("op-1", reserved, 19, dayOne).exhausted,
		false,
		"operator work keeps its reserved capacity after a background trip",
	);
	assert.equal(
		store.checkMidTurn("op-1", reserved, 20, dayOne).exhausted,
		true,
		"the total daily ceiling still stops operator work",
	);
}

{
	// Unknown turn rows record nothing but still report exhaustion state;
	// a day-rollover row (admitted yesterday) is treated the same.
	const store = new DoInferenceBudgetStore(makeRunner());
	const before = store.checkMidTurn("never-admitted", limits, 1_000, dayOne);
	assert.equal(before.exhausted, false);
	assert.equal(
		before.usage.usedTokens,
		0,
		"an unadmitted turn must not write into the day ledger",
	);
	store.admit("turn-1", limits, 10, dayOne);
	const rolled = store.checkMidTurn("turn-1", limits, 1_000, dayTwo);
	assert.equal(
		rolled.usage.usedTokens,
		0,
		"a prior-day turn row records nothing after UTC rollover",
	);
}

// Recovery reads the persisted admission class across a fresh store instance;
// it must neither consume a second turn nor release the original reservation.
{
	const db = new Database(":memory:");
	const runner = makeRunnerForDatabase(db);
	const store = new DoInferenceBudgetStore(runner);
	const reserved = {
		...limits,
		dailyMessageLimit: 10,
		operatorTokenReserve: 40,
	};
	store.admit("recover-background", reserved, 20, dayOne, "background");
	const restarted = new DoInferenceBudgetStore(runner);
	const before = restarted.status(reserved, dayOne, "background");
	assert.equal(
		restarted.canRecoverTurn("recover-background", reserved, dayOne),
		true,
	);
	assert.deepEqual(restarted.status(reserved, dayOne, "background"), before);
	assert.equal(
		restarted.canRecoverTurn("never-admitted", reserved, dayOne),
		false,
	);
	store.recordTokens("recover-background", 60, dayOne);
	assert.equal(
		restarted.canRecoverTurn("recover-background", reserved, dayOne),
		false,
	);
	store.admit("recover-operator", reserved, 1, dayOne, "operator");
	assert.equal(
		restarted.canRecoverTurn("recover-operator", reserved, dayOne),
		true,
	);
	// Recovery can proceed to the next day, where prepareStep reserves a new epoch.
	assert.equal(
		restarted.canRecoverTurn("recover-background", reserved, dayTwo),
		true,
	);
	runner.sql`UPDATE inference_turn_usage SET admission_class = NULL WHERE turn_id = ${"recover-operator"}`;
	assert.equal(
		restarted.canRecoverTurn("recover-operator", reserved, dayOne),
		false,
	);
}

// Initial inference uses the admitted reservation, not the recovery balance.
{
	const store = new DoInferenceBudgetStore(makeRunner());
	const admitted = store.admit(
		"fully-reserved",
		limits,
		limits.dailyTokenLimit,
		dayOne,
	);
	assert.equal(admitted.remainingTokens, 0);
	assert.equal(store.canRecoverTurn("fully-reserved", limits, dayOne), false);
	await assertTediChatNotCanceled("fully-reserved", async () => false);
	assert.deepEqual(store.status(limits, dayOne), admitted);
}

// Epoch admission debit is atomic, including failure to write the run metadata.
{
	const runner = makeRunner();
	const store = new DoInferenceBudgetStore(runner);
	store.status(limits, dayOne);
	runner.sql`CREATE TRIGGER reject_admission BEFORE INSERT ON inference_turn_usage
		BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END`;
	assert.throws(
		() => store.admit("atomic-admit", limits, 20, dayOne),
		/injected admission/,
	);
	assert.equal(store.status(limits, dayOne).usedTokens, 0);
	assert.equal(store.status(limits, dayOne).usedMessages, 0);
	runner.sql`DROP TRIGGER reject_admission`;
	assert.equal(store.admit("atomic-admit", limits, 20, dayOne).usedTokens, 20);
}

// Lost reservation acknowledgements retain the original day and never spend twice.
{
	const runner = makeRunner();
	const store = new DoInferenceBudgetStore(runner);
	store.admit("spanning", limits, 20, dayOne);
	store.reserveStep("spanning", "pending", 30, limits, dayOne);
	const restarted = new DoInferenceBudgetStore(runner);
	assert.equal(
		restarted.reserveStep("spanning", "pending", 30, limits, dayTwo).day,
		"2026-07-19",
	);
	assert.equal(restarted.status(limits, dayTwo).usedTokens, 0);
	assert.throws(
		() => restarted.reserveStep("spanning", "pending", 31, limits, dayTwo),
		/Conflicting/,
	);
	assert.equal(
		restarted.reserveStep("spanning", "next", 50, limits, dayTwo).usedTokens,
		50,
	);
	assert.equal(
		restarted.reserveStep("spanning", "last", 50, limits, dayTwo).usedTokens,
		100,
	);
	assert.throws(
		() => restarted.reserveStep("spanning", "overflow", 1, limits, dayTwo),
		InferenceBudgetExceededError,
	);
	assert.equal(restarted.status(limits, dayTwo).usedMessages, 1);
	assert.equal(
		restarted.recordStep("spanning", "pending", 40, limits, dayTwo).usedTokens,
		40,
	);
	assert.equal(
		restarted.recordStep("spanning", "next", 30, limits, dayTwo).usedTokens,
		80,
	);
	assert.equal(
		new DoInferenceBudgetStore(runner).recordStep(
			"spanning",
			"next",
			30,
			limits,
			dayTwo,
		).usedTokens,
		80,
	);
	assert.equal(restarted.status(limits, dayOne).usedTokens, 40);
}

// Daily message admission, class reserves and exhausted-day recovery remain enforced.
{
	const store = new DoInferenceBudgetStore(makeRunner());
	const reserved = {
		...limits,
		operatorTokenReserve: 40,
		dailyMessageLimit: 1,
	};
	store.admit("background-span", reserved, 20, dayOne, "background");
	assert.throws(
		() => store.admit("background-span", reserved, 61, dayTwo, "operator"),
		InferenceBudgetExceededError,
	);
	assert.equal(store.status(reserved, dayTwo).usedMessages, 0);
	assert.equal(
		store.reserveStep("background-span", "first", 60, reserved, dayTwo)
			.admissionClass,
		"background",
	);
	assert.equal(
		store.canRecoverTurn("background-span", reserved, dayTwo),
		false,
	);
	assert.throws(
		() => store.reserveStep("background-span", "second", 1, reserved, dayTwo),
		InferenceBudgetExceededError,
	);
	assert.throws(
		() => store.admit("another", reserved, 1, dayTwo),
		InferenceBudgetExceededError,
	);
	store.admit("yesterday", { ...reserved, dailyMessageLimit: 2 }, 1, dayOne);
	assert.equal(store.canRecoverTurn("yesterday", reserved, dayTwo), false);
}

// Migrate the shipped one-day journal without recharging or dropping liability.
{
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE inference_daily_usage (day TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL,
			used_messages INTEGER NOT NULL, operator_recovery_anchor_tokens INTEGER,
			operator_recovery_anchor_messages INTEGER, updated_at INTEGER NOT NULL);
		CREATE TABLE inference_turn_usage (turn_id TEXT PRIMARY KEY, day TEXT NOT NULL,
			reserved_tokens INTEGER NOT NULL, recorded_tokens INTEGER NOT NULL, admission_class TEXT,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE inference_step_usage (turn_id TEXT NOT NULL, step_id TEXT NOT NULL,
			estimated_tokens INTEGER NOT NULL, admission_credit INTEGER NOT NULL,
			actual_tokens INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(turn_id,step_id));
		INSERT INTO inference_daily_usage VALUES ('2026-07-19',30,1,NULL,NULL,0);
		INSERT INTO inference_turn_usage VALUES ('migrated','2026-07-19',20,0,'background',0,0);
		INSERT INTO inference_step_usage VALUES ('migrated','unknown',30,20,NULL,0);
	`);
	const runner = makeRunnerForDatabase(db);
	const store = new DoInferenceBudgetStore(runner);
	assert.equal(store.status(limits, dayOne).usedTokens, 30);
	assert.equal(store.status(limits, dayOne).usedMessages, 1);
	store.reserveStep("migrated", "new", 20, limits, dayTwo);
	assert.equal(
		store.recordStep("migrated", "unknown", 40, limits, dayTwo).usedTokens,
		40,
	);
	assert.equal(
		new DoInferenceBudgetStore(runner).status(limits, dayTwo).usedTokens,
		20,
	);
	assert.equal(store.status(limits, dayOne).usedTokens, 40);
}

// Restart backfill cannot debit an already-accounted legacy admission twice.
{
	const runner = makeRunner();
	const store = new DoInferenceBudgetStore(runner);
	store.status(limits, dayOne);
	runner.sql`INSERT INTO inference_daily_usage
		(day, used_tokens, used_messages, updated_at) VALUES (${"2026-07-19"}, 20, 1, 0)`;
	runner.sql`INSERT INTO inference_turn_usage
		(turn_id, day, reserved_tokens, recorded_tokens, admission_class, created_at, updated_at)
		VALUES ('legacy-after-init', '2026-07-19', 20, 0, 'background', 0, 0)`;
	const restarted = new DoInferenceBudgetStore(runner);
	assert.equal(restarted.status(limits, dayOne).usedTokens, 20);
	assert.equal(restarted.status(limits, dayOne).usedMessages, 1);
	assert.equal(
		restarted.reserveStep("legacy-after-init", "first", 30, limits, dayOne)
			.usedTokens,
		30,
	);
}

// -1 disables only the named individual dimension; usage remains measured and finite.
{
	for (const admissionClass of [
		"background",
		"governed_learning",
		"operator",
	] as const) {
		const store = new DoInferenceBudgetStore(makeRunner());
		const uncapped = {
			...limits,
			dailyMessageLimit: -1,
			dailyTokenLimit: -1,
			operatorTokenReserve: 40,
			operatorMessageReserve: 1,
			governedLearningTokenReserve: 10,
			governedLearningMessageReserve: 1,
		};
		for (let i = 0; i < 3; i++) {
			store.admit(`uncapped-${i}`, uncapped, 200, dayOne, admissionClass);
			store.reserveStep(`uncapped-${i}`, "first", 200, uncapped, dayOne);
			store.recordStep(`uncapped-${i}`, "first", 300, uncapped, dayOne);
		}
		const usage = store.status(uncapped, dayOne, admissionClass);
		assert.equal(usage.usedTokens, 900);
		assert.equal(usage.usedMessages, 3);
		assert.equal(usage.remainingTokens, -1);
		assert.equal(usage.remainingMessages, -1);
		assert.equal(usage.admissionTokenLimit, -1);
		assert.equal(usage.admissionMessageLimit, -1);
		assert.equal(usage.operatorTokenReserve, 0);
		assert.equal(
			store.checkMidTurn("uncapped-0", uncapped, 300, dayOne).exhausted,
			false,
		);
		assert.equal(store.canRecoverTurn("uncapped-0", uncapped, dayOne), true);
		assert.equal(store.canRecoverTurn("uncapped-0", uncapped, dayTwo), true);
		assert.ok(
			Object.values(usage)
				.filter((v) => typeof v === "number")
				.every(Number.isFinite),
		);
	}
	const store = new DoInferenceBudgetStore(makeRunner());
	const tokenOnly = { ...limits, dailyTokenLimit: -1, dailyMessageLimit: 1 };
	store.admit("one", tokenOnly, 200, dayOne);
	assert.throws(
		() => store.admit("two", tokenOnly, 1, dayOne),
		InferenceBudgetExceededError,
	);
	const messageOnly = { ...limits, dailyMessageLimit: -1 };
	store.admit("three", messageOnly, 100, dayTwo);
	assert.throws(
		() => store.admit("four", messageOnly, 1, dayTwo),
		InferenceBudgetExceededError,
	);
	assert.throws(
		() =>
			store.admit("malformed", { ...limits, dailyTokenLimit: -2 }, 1, dayTwo),
		InferenceBudgetExceededError,
	);
}

console.log("inference-budget-store-do tests passed");
