import type { DoSqlRunner } from "./brain-bridge-do";

export interface InferenceBudgetLimits {
	/** -1 removes the individual cap; shared organization admission still applies. */
	dailyMessageLimit: number;
	/** -1 removes the individual cap; zero denies inference. */
	dailyTokenLimit: number;
	operatorMessageReserve: number;
	operatorTokenReserve: number;
	governedLearningMessageReserve: number;
	governedLearningTokenReserve: number;
}

export type InferenceBudgetAdmissionClass =
	| "background"
	| "governed_learning"
	| "operator";

export interface InferenceBudgetUsage extends InferenceBudgetLimits {
	admissionClass: InferenceBudgetAdmissionClass;
	backgroundMessageLimit: number;
	backgroundTokenLimit: number;
	governedLearningMessageLimit: number;
	governedLearningTokenLimit: number;
	admissionMessageLimit: number;
	admissionTokenLimit: number;
	day: string;
	/** -1 means no individual cap, never an estimate of organization headroom. */
	remainingMessages: number;
	/** -1 means no individual cap, never an estimate of organization headroom. */
	remainingTokens: number;
	usedMessages: number;
	usedTokens: number;
}

export class InferenceBudgetExceededError extends Error {
	readonly usage: InferenceBudgetUsage;

	constructor(usage: InferenceBudgetUsage) {
		const operatorTurns = `${usage.operatorMessageReserve} ${
			usage.operatorMessageReserve === 1 ? "turn" : "turns"
		}`;
		const learningTurns = `${usage.governedLearningMessageReserve} ${
			usage.governedLearningMessageReserve === 1 ? "turn" : "turns"
		}`;
		const reserveDetail =
			usage.admissionClass === "background"
				? `; preserving ${usage.governedLearningTokenReserve} tokens and ${learningTurns} for governed learning, plus ${usage.operatorTokenReserve} tokens and ${operatorTurns} for operator work`
				: usage.admissionClass === "governed_learning"
					? `; preserving ${usage.operatorTokenReserve} tokens and ${operatorTurns} for operator work`
					: "";
		super(
			`Inference daily budget exhausted for ${usage.day} ` +
				`(${usage.usedTokens}/${usage.dailyTokenLimit} tokens, ` +
				`${usage.usedMessages}/${usage.dailyMessageLimit} turns${reserveDetail})`,
		);
		this.name = "InferenceBudgetExceededError";
		this.usage = usage;
	}
}

export interface InferenceBudgetMidTurnCheck {
	/** True when the day's used tokens now meet/exceed the turn's class limit —
	 * the caller must stop the turn's loop before the next provider call. */
	exhausted: boolean;
	usage: InferenceBudgetUsage;
}

export function inferenceBudgetDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function remainingLimit(limit: number, used: number): number {
	return limit === -1 ? -1 : Math.max(0, limit - used);
}

function boundedLimit(value: number): number {
	return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

/**
 * Per-tedi inference budget stored in the parent agent's Durable Object SQLite.
 *
 * Admission reserves an estimate before any provider request. Actual model
 * usage replaces the reservation as step/turn telemetry arrives. All SQL is
 * synchronous and the guarded UPDATE is atomic, so concurrent conversation
 * facets cannot all pass a stale read and overspend the same remaining budget.
 */
export class DoInferenceBudgetStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	private prepareRecoveryAnchorMigrations(): void {
		const columns = this.runner.sql<{
			name: string;
		}>`PRAGMA table_info(inference_daily_usage)`;
		const journal = this.runner.sql<{ migration: string }>`
			SELECT migration FROM inference_recovery_anchor_migrations WHERE day = ''
		`;
		// Existing columns may contain legitimate NULL anchors for new days.
		const needsSnapshot = (kind: "tokens" | "messages") =>
			!columns.some(
				(entry) => entry.name === `operator_recovery_anchor_${kind}`,
			) && !journal.some((entry) => entry.migration === kind);
		const tokens = Number(needsSnapshot("tokens"));
		const messages = Number(needsSnapshot("messages"));
		if (!tokens && !messages) return;
		// Both markers and historical balances are one atomic statement, before
		// any ALTER. The empty-day marker also records an empty historical table.
		// Retry never includes new days or changes the original recovery allowance.
		void this.runner.sql`
			INSERT INTO inference_recovery_anchor_migrations
				(migration, day, anchor, completed)
			SELECT migration, day,
				CASE WHEN migration = 'tokens' THEN used_tokens ELSE used_messages END, 0
			FROM inference_daily_usage CROSS JOIN (
				SELECT 'tokens' AS migration WHERE ${tokens} = 1
				UNION ALL SELECT 'messages' WHERE ${messages} = 1
			)
			UNION ALL SELECT 'tokens', '', 0, 0 WHERE ${tokens} = 1
			UNION ALL SELECT 'messages', '', 0, 0 WHERE ${messages} = 1
		`;
	}

	private migrateRecoveryAnchor(kind: "tokens" | "messages"): void {
		const journal = this.runner.sql<{ completed: number }>`
			SELECT completed FROM inference_recovery_anchor_migrations
			WHERE migration = ${kind} AND day = ''
		`[0];
		if (!journal || journal.completed === 1) return;
		const column = `operator_recovery_anchor_${kind}`;
		const columns = this.runner.sql<{
			name: string;
		}>`PRAGMA table_info(inference_daily_usage)`;
		if (!columns.some((entry) => entry.name === column)) {
			if (kind === "tokens") {
				void this.runner
					.sql`ALTER TABLE inference_daily_usage ADD COLUMN operator_recovery_anchor_tokens INTEGER`;
			} else {
				void this.runner
					.sql`ALTER TABLE inference_daily_usage ADD COLUMN operator_recovery_anchor_messages INTEGER`;
			}
		}
		if (kind === "tokens") {
			void this.runner.sql`
				UPDATE inference_daily_usage SET operator_recovery_anchor_tokens = (
					SELECT anchor FROM inference_recovery_anchor_migrations
					WHERE migration = 'tokens' AND day = inference_daily_usage.day
				) WHERE operator_recovery_anchor_tokens IS NULL AND day IN (
					SELECT day FROM inference_recovery_anchor_migrations WHERE migration = 'tokens' AND day != ''
				)
			`;
		} else {
			void this.runner.sql`
				UPDATE inference_daily_usage SET operator_recovery_anchor_messages = (
					SELECT anchor FROM inference_recovery_anchor_migrations
					WHERE migration = 'messages' AND day = inference_daily_usage.day
				) WHERE operator_recovery_anchor_messages IS NULL AND day IN (
					SELECT day FROM inference_recovery_anchor_migrations WHERE migration = 'messages' AND day != ''
				)
			`;
		}
		void this.runner.sql`
			UPDATE inference_recovery_anchor_migrations SET completed = 1
			WHERE migration = ${kind} AND day = ''
		`;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		void this.runner.sql`
			CREATE TABLE IF NOT EXISTS inference_daily_usage (
				day TEXT PRIMARY KEY,
				used_tokens INTEGER NOT NULL,
				used_messages INTEGER NOT NULL,
				operator_recovery_anchor_tokens INTEGER,
				operator_recovery_anchor_messages INTEGER,
				updated_at INTEGER NOT NULL
			)
		`;
		void this.runner.sql`
			CREATE TABLE IF NOT EXISTS inference_recovery_anchor_migrations (
				migration TEXT NOT NULL,
				day TEXT NOT NULL,
				anchor INTEGER NOT NULL,
				completed INTEGER NOT NULL,
				PRIMARY KEY (migration, day)
			)
		`;
		this.prepareRecoveryAnchorMigrations();
		this.migrateRecoveryAnchor("tokens");
		this.migrateRecoveryAnchor("messages");
		void this.runner.sql`
			CREATE TABLE IF NOT EXISTS inference_turn_usage (
				turn_id TEXT PRIMARY KEY,
				day TEXT NOT NULL,
				reserved_tokens INTEGER NOT NULL,
				recorded_tokens INTEGER NOT NULL,
				admission_class TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		// Mid-turn checks enforce the SAME class ceiling the turn was admitted
		// under, so admission stamps its class on the turn row. Pre-existing rows
		// keep NULL and fall back to the (wider) operator ceiling — fail-open for
		// in-flight turns admitted before this column shipped.
		if (
			!this.runner.sql<{
				name: string;
			}>`PRAGMA table_info(inference_turn_usage)`.some(
				(column) => column.name === "admission_class",
			)
		) {
			void this.runner.sql`
				ALTER TABLE inference_turn_usage
				ADD COLUMN admission_class TEXT
			`;
		}
		void this.runner.sql`
			CREATE TABLE IF NOT EXISTS inference_step_usage (
				turn_id TEXT NOT NULL,
				step_id TEXT NOT NULL,
				estimated_tokens INTEGER NOT NULL,
				admission_credit INTEGER NOT NULL,
				actual_tokens INTEGER,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (turn_id, step_id)
			)
		`;
		// A run can span UTC days. Keep its original row for legacy cumulative
		// receipts, and retain an immutable admission epoch for each active day.
		// Do not prune run identities: even admissions with no provider receipt
		// must retain their class and liability across redrive and late settlement.
		void this.runner.sql`
			CREATE TABLE IF NOT EXISTS inference_turn_admissions (
				turn_id TEXT NOT NULL,
				day TEXT NOT NULL,
				reserved_tokens INTEGER NOT NULL,
				admission_class TEXT,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (turn_id, day)
			)
		`;
		void this.runner.sql`
			INSERT OR IGNORE INTO inference_turn_admissions
				(turn_id, day, reserved_tokens, admission_class, updated_at)
			SELECT turn_id, day, reserved_tokens, admission_class, updated_at
			FROM inference_turn_usage
		`;
		if (
			!this.runner.sql<{
				name: string;
			}>`PRAGMA table_info(inference_step_usage)`.some(
				(column) => column.name === "day",
			)
		) {
			void this.runner
				.sql`ALTER TABLE inference_step_usage ADD COLUMN day TEXT`;
		}
		void this.runner.sql`
			UPDATE inference_step_usage SET day = (
				SELECT day FROM inference_turn_usage
				WHERE inference_turn_usage.turn_id = inference_step_usage.turn_id
			) WHERE day IS NULL
		`;
		// Pre-upgrade reservations already paid. The original-day predicate also
		// protects backfill if initialization is retried or an old writer resurfaces.
		// A guarded epoch insertion and its daily debit are one atomic statement.
		void this.runner.sql`
			CREATE TRIGGER IF NOT EXISTS inference_turn_admitted
			AFTER INSERT ON inference_turn_admissions
			WHEN NOT EXISTS (SELECT 1 FROM inference_turn_usage
				WHERE turn_id = NEW.turn_id AND day = NEW.day) BEGIN
				UPDATE inference_daily_usage
				SET used_tokens = used_tokens + NEW.reserved_tokens,
					used_messages = used_messages + 1, updated_at = NEW.updated_at
				WHERE day = NEW.day;
				INSERT OR IGNORE INTO inference_turn_usage
					(turn_id, day, reserved_tokens, recorded_tokens, admission_class, created_at, updated_at)
				VALUES (NEW.turn_id, NEW.day, NEW.reserved_tokens, 0, NEW.admission_class,
					NEW.updated_at, NEW.updated_at);
			END
		`;
		// Replace the old triggers which looked up the run's original day.
		void this.runner.sql`DROP TRIGGER IF EXISTS inference_step_reserved`;
		void this.runner.sql`DROP TRIGGER IF EXISTS inference_step_recorded`;
		void this.runner.sql`
			CREATE TRIGGER inference_step_reserved
			AFTER INSERT ON inference_step_usage BEGIN
				UPDATE inference_daily_usage
				SET used_tokens = used_tokens + NEW.estimated_tokens - NEW.admission_credit,
					updated_at = NEW.updated_at
				WHERE day = NEW.day;
			END
		`;
		void this.runner.sql`
			CREATE TRIGGER inference_step_recorded
			AFTER UPDATE OF actual_tokens ON inference_step_usage
			WHEN OLD.actual_tokens IS NULL AND NEW.actual_tokens IS NOT NULL BEGIN
				UPDATE inference_daily_usage
				SET used_tokens = used_tokens + NEW.actual_tokens - NEW.estimated_tokens,
					updated_at = NEW.updated_at
				WHERE day = NEW.day;
				UPDATE inference_turn_usage
				SET recorded_tokens = recorded_tokens + NEW.actual_tokens,
					updated_at = NEW.updated_at
				WHERE turn_id = NEW.turn_id AND day = NEW.day;
			END
		`;
		this.schemaReady = true;
	}

	private normalizeLimits(
		limits: InferenceBudgetLimits,
	): InferenceBudgetLimits {
		const dailyMessageLimit =
			limits.dailyMessageLimit === -1
				? -1
				: boundedLimit(limits.dailyMessageLimit);
		const dailyTokenLimit =
			limits.dailyTokenLimit === -1 ? -1 : boundedLimit(limits.dailyTokenLimit);
		// Reserves divide a finite individual allowance. With no individual cap,
		// every class can use the shared organization admission capacity.
		const reserve = (limit: number, value: number) =>
			limit === -1 ? 0 : Math.min(limit, boundedLimit(value));
		const operatorMessageReserve = reserve(
			dailyMessageLimit,
			limits.operatorMessageReserve,
		);
		const operatorTokenReserve = reserve(
			dailyTokenLimit,
			limits.operatorTokenReserve,
		);
		return {
			dailyMessageLimit,
			dailyTokenLimit,
			operatorMessageReserve,
			operatorTokenReserve,
			governedLearningMessageReserve: reserve(
				dailyMessageLimit === -1
					? -1
					: dailyMessageLimit - operatorMessageReserve,
				limits.governedLearningMessageReserve,
			),
			governedLearningTokenReserve: reserve(
				dailyTokenLimit === -1 ? -1 : dailyTokenLimit - operatorTokenReserve,
				limits.governedLearningTokenReserve,
			),
		};
	}

	/**
	 * Effective per-class ceilings for `day`: background work keeps the operator
	 * reserves untouched; operator work may ride a one-day recovery anchor when
	 * pre-reserve background spend already consumed the protected capacity.
	 * Shared by admission and the mid-turn check so the two gates cannot drift.
	 */
	private classLimits(
		day: string,
		normalized: InferenceBudgetLimits,
		admissionClass: InferenceBudgetAdmissionClass,
	): { messageLimit: number; tokenLimit: number } {
		let messageLimit =
			admissionClass === "background"
				? normalized.dailyMessageLimit -
					normalized.operatorMessageReserve -
					normalized.governedLearningMessageReserve
				: admissionClass === "governed_learning"
					? normalized.dailyMessageLimit - normalized.operatorMessageReserve
					: normalized.dailyMessageLimit;
		let tokenLimit =
			admissionClass === "background"
				? normalized.dailyTokenLimit -
					normalized.operatorTokenReserve -
					normalized.governedLearningTokenReserve
				: admissionClass === "governed_learning"
					? normalized.dailyTokenLimit - normalized.operatorTokenReserve
					: normalized.dailyTokenLimit;
		if (admissionClass === "operator") {
			const anchors = this.runner.sql<{
				messageAnchor: number | null;
				tokenAnchor: number | null;
			}>`
				SELECT
					operator_recovery_anchor_messages AS messageAnchor,
					operator_recovery_anchor_tokens AS tokenAnchor
				FROM inference_daily_usage WHERE day = ${day}
			`;
			const anchor = anchors[0];
			if (messageLimit !== -1 && anchor?.messageAnchor != null) {
				messageLimit = Math.max(
					messageLimit,
					anchor.messageAnchor + normalized.operatorMessageReserve,
				);
			}
			if (tokenLimit !== -1 && anchor?.tokenAnchor != null) {
				tokenLimit = Math.max(
					tokenLimit,
					anchor.tokenAnchor + normalized.operatorTokenReserve,
				);
			}
		}
		return { messageLimit, tokenLimit };
	}

	admit(
		turnId: string,
		limits: InferenceBudgetLimits,
		estimatedTokens: number,
		now = new Date(),
		admissionClass: InferenceBudgetAdmissionClass = "operator",
	): InferenceBudgetUsage {
		this.ensureSchema();
		const day = inferenceBudgetDay(now);
		const normalized = this.normalizeLimits(limits);
		const reservation = Math.max(1, boundedLimit(estimatedTokens));
		const original = this.runner.sql<{ admissionClass: string | null }>`
			SELECT admission_class AS admissionClass FROM inference_turn_usage WHERE turn_id = ${turnId}
		`[0];
		if (original) {
			// A replay cannot promote background work into the operator reserve.
			admissionClass = this.stepAdmission(turnId).admissionClass;
		}
		if (this.hasAdmission(turnId, day))
			return this.status(normalized, now, admissionClass);

		const updatedAt = now.getTime();
		void this.runner.sql`
			INSERT OR IGNORE INTO inference_daily_usage
				(day, used_tokens, used_messages, updated_at)
			VALUES (${day}, 0, 0, ${updatedAt})
		`;
		const { messageLimit, tokenLimit } = this.classLimits(
			day,
			normalized,
			admissionClass,
		);
		const admitted = this.runner.sql<{ day: string }>`
			INSERT INTO inference_turn_admissions
				(turn_id, day, reserved_tokens, admission_class, updated_at)
			SELECT ${turnId}, ${day}, ${reservation}, ${admissionClass}, ${updatedAt}
			FROM inference_daily_usage
			WHERE day = ${day}
				AND (${messageLimit} = -1 OR used_messages < ${messageLimit})
				AND (${tokenLimit} = -1 OR used_tokens + ${reservation} <= ${tokenLimit})
			RETURNING day
		`;
		if (!admitted[0]) {
			throw new InferenceBudgetExceededError(
				this.status(normalized, now, admissionClass),
			);
		}
		return this.status(normalized, now, admissionClass);
	}

	/** Reserve one model attempt, replaying the same identity without a second debit. */
	reserveStep(
		turnId: string,
		stepId: string,
		estimatedTokens: number,
		limits: InferenceBudgetLimits,
		now = new Date(),
	): InferenceBudgetUsage {
		this.ensureSchema();
		if (
			!stepId.trim() ||
			!Number.isSafeInteger(estimatedTokens) ||
			estimatedTokens < 1
		) {
			throw new Error(
				"Inference step requires an identity and positive integer estimate",
			);
		}
		const turn = this.stepAdmission(turnId);
		const previous = this.runner.sql<{ estimatedTokens: number; day: string }>`
			SELECT estimated_tokens AS estimatedTokens, day FROM inference_step_usage
			WHERE turn_id = ${turnId} AND step_id = ${stepId}
		`[0];
		if (previous) {
			if (previous.estimatedTokens !== estimatedTokens) {
				throw new Error("Conflicting inference step reservation");
			}
			return this.status(
				limits,
				new Date(`${previous.day}T00:00:00.000Z`),
				turn.admissionClass,
			);
		}
		const day = inferenceBudgetDay(now);
		// Native continuation may reach midnight without calling admit again.
		// The new epoch reserves this actual attempt estimate before dispatch.
		this.admit(turnId, limits, estimatedTokens, now, turn.admissionClass);
		const epoch = this.runner.sql<{ reservedTokens: number }>`
			SELECT reserved_tokens AS reservedTokens FROM inference_turn_admissions
			WHERE turn_id = ${turnId} AND day = ${day}
		`[0]!;
		const firstStep = !this.runner.sql<{ found: number }>`
			SELECT 1 AS found FROM inference_step_usage
			WHERE turn_id = ${turnId} AND day = ${day} LIMIT 1
		`.length;
		const credit =
			firstStep && (turn.day !== day || turn.recordedTokens === 0)
				? epoch.reservedTokens
				: 0;
		const { tokenLimit } = this.classLimits(
			day,
			this.normalizeLimits(limits),
			turn.admissionClass,
		);
		const inserted = this.runner.sql<{ stepId: string }>`
			INSERT INTO inference_step_usage
				(turn_id, step_id, day, estimated_tokens, admission_credit, actual_tokens, updated_at)
			SELECT ${turnId}, ${stepId}, ${day}, ${estimatedTokens}, ${credit}, NULL, ${now.getTime()}
			FROM inference_daily_usage
			WHERE day = ${day} AND (${tokenLimit} = -1 OR used_tokens + ${estimatedTokens - credit} <= ${tokenLimit})
			RETURNING step_id AS stepId
		`;
		if (!inserted[0]) {
			throw new InferenceBudgetExceededError(
				this.status(limits, now, turn.admissionClass),
			);
		}
		return this.status(limits, now, turn.admissionClass);
	}

	/**
	 * Reconcile observed usage exactly once. Null means unknown, not zero: that
	 * attempt's estimate remains charged until an authoritative receipt arrives.
	 * Late receipts charge the admission day even after another day's admission.
	 */
	recordStep(
		turnId: string,
		stepId: string,
		actualTokens: number | null,
		limits: InferenceBudgetLimits,
		now = new Date(),
	): InferenceBudgetUsage {
		this.ensureSchema();
		if (
			actualTokens !== null &&
			(!Number.isSafeInteger(actualTokens) || actualTokens < 0)
		) {
			throw new Error(
				"Inference usage must be a nonnegative integer or unknown",
			);
		}
		const turn = this.stepAdmission(turnId);
		const step = this.runner.sql<{ actualTokens: number | null; day: string }>`
			SELECT actual_tokens AS actualTokens, day FROM inference_step_usage
			WHERE turn_id = ${turnId} AND step_id = ${stepId}
		`[0];
		if (!step) throw new Error("Inference receipt has no reserved attempt");
		if (
			step.actualTokens !== null &&
			actualTokens !== null &&
			step.actualTokens !== actualTokens
		) {
			throw new Error("Conflicting inference step receipt");
		}
		if (actualTokens !== null && step.actualTokens === null) {
			void this.runner.sql`
				UPDATE inference_step_usage SET actual_tokens = ${actualTokens}, updated_at = ${now.getTime()}
				WHERE turn_id = ${turnId} AND step_id = ${stepId} AND actual_tokens IS NULL
			`;
		}
		return this.status(
			limits,
			new Date(`${step.day}T00:00:00.000Z`),
			turn.admissionClass,
		);
	}

	private hasAdmission(turnId: string, day: string): boolean {
		return (
			this.runner.sql<{ found: number }>`
			SELECT 1 AS found FROM inference_turn_admissions WHERE turn_id = ${turnId} AND day = ${day}
		`.length > 0
		);
	}

	private hasStepJournal(turnId: string): boolean {
		return (
			this.runner.sql<{ found: number }>`
			SELECT 1 AS found FROM inference_step_usage WHERE turn_id = ${turnId} LIMIT 1
		`.length > 0
		);
	}

	private stepAdmission(turnId: string): {
		day: string;
		reservedTokens: number;
		recordedTokens: number;
		admissionClass: InferenceBudgetAdmissionClass;
	} {
		const row = this.runner.sql<{
			day: string;
			reservedTokens: number;
			recordedTokens: number;
			admissionClass: string | null;
		}>`
			SELECT day, reserved_tokens AS reservedTokens, recorded_tokens AS recordedTokens,
				admission_class AS admissionClass FROM inference_turn_usage WHERE turn_id = ${turnId}
		`[0];
		if (
			!row ||
			(row.admissionClass !== "operator" &&
				row.admissionClass !== "background" &&
				row.admissionClass !== "governed_learning")
		) {
			throw new Error("Inference step requires a known admission class");
		}
		return { ...row, admissionClass: row.admissionClass };
	}

	/**
	 * Mid-turn budget enforcement: admission reserves ONE pre-turn estimate
	 * while the agentic tool loop makes dozens of provider calls with growing
	 * context under that single reservation, so without this check a turn can
	 * sail past `dailyTokenLimit` unchecked.
	 *
	 * Called at each step boundary with the turn's CUMULATIVE model-reported
	 * tokens so far. Idempotent on cumulative totals: the turn row's recorded
	 * tokens only ratchet up to `max(recorded, tokensSoFar)` and the day ledger
	 * absorbs exactly the delta (releasing the admission reservation on the
	 * first real record) — replays and end-of-turn settlement with the same
	 * total are no-ops. Returns whether the DAY's used tokens now meet the
	 * turn's admission-class ceiling, in which case the caller must stop the
	 * loop before the next provider call. Synchronous + atomic like the rest of
	 * the store (single-threaded DO SQLite).
	 *
	 * A turn row admitted on a PRIOR day (UTC rollover mid-turn) or missing
	 * entirely records nothing but still reports today's exhaustion state.
	 */
	checkMidTurn(
		turnId: string,
		limits: InferenceBudgetLimits,
		tokensSoFar: number,
		now = new Date(),
	): InferenceBudgetMidTurnCheck {
		this.ensureSchema();
		const day = inferenceBudgetDay(now);
		const normalized = this.normalizeLimits(limits);
		const rows = this.runner.sql<{
			day: string;
			recordedTokens: number;
			reservedTokens: number;
			admissionClass: string | null;
		}>`
			SELECT day, recorded_tokens AS recordedTokens,
				reserved_tokens AS reservedTokens,
				admission_class AS admissionClass
			FROM inference_turn_usage WHERE turn_id = ${turnId}
		`;
		const turn = rows[0];
		const admissionClass: InferenceBudgetAdmissionClass =
			turn?.admissionClass === "background" ||
			turn?.admissionClass === "governed_learning"
				? turn.admissionClass
				: "operator";
		if (turn && turn.day === day && !this.hasStepJournal(turnId)) {
			const cumulative = boundedLimit(tokensSoFar);
			const added = Math.max(0, cumulative - turn.recordedTokens);
			if (added > 0) {
				const reservationCredit =
					turn.recordedTokens === 0 ? turn.reservedTokens : 0;
				const delta = added - reservationCredit;
				const updatedAt = now.getTime();
				void this.runner.sql`
					UPDATE inference_daily_usage
					SET used_tokens = MAX(0, used_tokens + ${delta}),
						updated_at = ${updatedAt}
					WHERE day = ${day}
				`;
				void this.runner.sql`
					UPDATE inference_turn_usage
					SET recorded_tokens = ${turn.recordedTokens + added},
						updated_at = ${updatedAt}
					WHERE turn_id = ${turnId}
				`;
			}
		}
		const usage = this.status(normalized, now, admissionClass);
		const { tokenLimit } = this.classLimits(day, normalized, admissionClass);
		return {
			exhausted: tokenLimit !== -1 && usage.usedTokens >= tokenLimit,
			usage,
		};
	}

	/** Recovery checks the original class against today's capacity without a debit.
	 * reserveStep must still admit today's epoch before another provider attempt. */
	canRecoverTurn(
		turnId: string,
		limits: InferenceBudgetLimits,
		now = new Date(),
	): boolean {
		this.ensureSchema();
		const rows = this.runner.sql<{
			day: string;
			admissionClass: string | null;
		}>`
			SELECT day, admission_class AS admissionClass FROM inference_turn_usage
			WHERE turn_id = ${turnId}
		`;
		if (!rows[0]) return false;
		const admissionClass = rows[0].admissionClass;
		// Legacy admissions have no reliable class. Do not widen their authority.
		if (
			admissionClass !== "operator" &&
			admissionClass !== "background" &&
			admissionClass !== "governed_learning"
		)
			return false;
		const usage = this.status(limits, now, admissionClass);
		return (
			(usage.remainingTokens === -1 || usage.remainingTokens > 0) &&
			(this.hasAdmission(turnId, inferenceBudgetDay(now)) ||
				usage.remainingMessages === -1 ||
				usage.remainingMessages > 0)
		);
	}

	/** Add real provider-reported tokens for a turn, replacing its reservation once. */
	recordTokens(turnId: string, tokens: number, now = new Date()): void {
		this.ensureSchema();
		if (this.hasStepJournal(turnId)) return;
		const added = boundedLimit(tokens);
		if (added <= 0) return;
		const rows = this.runner.sql<{
			day: string;
			recordedTokens: number;
			reservedTokens: number;
		}>`
			SELECT day, recorded_tokens AS recordedTokens,
				reserved_tokens AS reservedTokens
			FROM inference_turn_usage WHERE turn_id = ${turnId}
		`;
		const turn = rows[0];
		if (!turn) return;
		const reservationCredit =
			turn.recordedTokens === 0 ? turn.reservedTokens : 0;
		const delta = added - reservationCredit;
		const updatedAt = now.getTime();
		void this.runner.sql`
			UPDATE inference_daily_usage
			SET used_tokens = MAX(0, used_tokens + ${delta}),
				updated_at = ${updatedAt}
			WHERE day = ${turn.day}
		`;
		void this.runner.sql`
			UPDATE inference_turn_usage
			SET recorded_tokens = recorded_tokens + ${added}, updated_at = ${updatedAt}
			WHERE turn_id = ${turnId}
		`;
	}

	status(
		limits: InferenceBudgetLimits,
		now = new Date(),
		admissionClass: InferenceBudgetAdmissionClass = "operator",
	): InferenceBudgetUsage {
		this.ensureSchema();
		const day = inferenceBudgetDay(now);
		const normalized = this.normalizeLimits(limits);
		const rows = this.runner.sql<{
			usedMessages: number;
			usedTokens: number;
		}>`
			SELECT used_tokens AS usedTokens, used_messages AS usedMessages
			FROM inference_daily_usage WHERE day = ${day}
		`;
		const usedMessages = rows[0]?.usedMessages ?? 0;
		const usedTokens = rows[0]?.usedTokens ?? 0;
		const backgroundMessageLimit =
			normalized.dailyMessageLimit -
			normalized.operatorMessageReserve -
			normalized.governedLearningMessageReserve;
		const backgroundTokenLimit =
			normalized.dailyTokenLimit -
			normalized.operatorTokenReserve -
			normalized.governedLearningTokenReserve;
		const governedLearningMessageLimit =
			normalized.dailyMessageLimit - normalized.operatorMessageReserve;
		const governedLearningTokenLimit =
			normalized.dailyTokenLimit - normalized.operatorTokenReserve;
		const { messageLimit, tokenLimit } = this.classLimits(
			day,
			normalized,
			admissionClass,
		);
		return {
			day,
			...normalized,
			admissionClass,
			backgroundMessageLimit,
			backgroundTokenLimit,
			governedLearningMessageLimit,
			governedLearningTokenLimit,
			admissionMessageLimit: messageLimit,
			admissionTokenLimit: tokenLimit,
			remainingMessages: remainingLimit(messageLimit, usedMessages),
			remainingTokens: remainingLimit(tokenLimit, usedTokens),
			usedMessages,
			usedTokens,
		};
	}
}
