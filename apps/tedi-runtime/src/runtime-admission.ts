/** Permanent runtime-neutral admission. No lifecycle, scheduler or external dispatch. */
export type AdmissionState = "active" | "held" | "quarantined" | "retired";
export interface AdmissionOwner {
	tediId: string | null;
	orgId: string | null;
	objectId: string;
}
export interface AdmissionSnapshot {
	owner: AdmissionOwner;
	state: AdmissionState;
	generation: number;
	evidence: string | null;
	reason: string | null;
}
export interface TurnClaim {
	turnId: string;
	requestHash: string;
	generation: number;
	status: "running" | "completed";
	completion: string | null;
}
export interface AdmissionEvidence {
	owner: AdmissionOwner;
	digest: string;
	complete: boolean;
	unknown: number;
	nonterminal: number;
	/** Receipt reconciliation binds the original accepted claim, not the current epoch. */
	claim?: { turnId: string; requestHash: string; generation: number };
	terminal?: boolean;
}
export type VerificationAction =
	| "initialize"
	| "hold"
	| "release"
	| "retire"
	| "complete";
export type AdmissionVerifier = (
	action: VerificationAction,
	input: Readonly<Record<string, unknown>>,
) => AdmissionEvidence;
const STATE = "runtime_admission",
	TURNS = "runtime_admission_turns",
	OPS = "runtime_admission_operations";
function fail(message: string): never {
	throw new Error(`Runtime admission: ${message}`);
}
function bounded(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 512)
		fail("invalid identifier");
	return value;
}
function hash(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		fail("invalid evidence hash");
	return value;
}
function generation(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		fail("invalid generation");
	return value;
}
function owner(value: AdmissionOwner): AdmissionOwner {
	return {
		tediId: value.tediId === null ? null : bounded(value.tediId),
		orgId: value.orgId === null ? null : bounded(value.orgId),
		objectId: bounded(value.objectId),
	};
}
function same(a: unknown, b: unknown) {
	return JSON.stringify(a) === JSON.stringify(b);
}
export class RuntimeAdmission {
	readonly owner: AdmissionOwner;
	constructor(
		private readonly storage: Pick<
			DurableObjectStorage,
			"sql" | "transactionSync"
		>,
		ownerValue: AdmissionOwner,
		private readonly verify: AdmissionVerifier,
	) {
		this.owner = Object.freeze(owner(ownerValue));
	}
	private exists(): boolean {
		return (
			this.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
					STATE,
				)
				.toArray().length > 0
		);
	}
	private setup() {
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${STATE} (id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)`,
		);
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${TURNS} (id TEXT PRIMARY KEY,record TEXT NOT NULL)`,
		);
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${OPS} (id TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL)`,
		);
	}
	read(): AdmissionSnapshot | null {
		if (!this.exists()) return null;
		const row = this.storage.sql
			.exec<{ record: string }>(`SELECT record FROM ${STATE} WHERE id=1`)
			.toArray()[0];
		if (!row) fail("missing persisted state");
		let s: AdmissionSnapshot;
		try {
			s = JSON.parse(row.record);
		} catch {
			fail("malformed persisted state");
		}
		if (!same(owner(s.owner), this.owner)) fail("owner mismatch");
		generation(s.generation);
		if (!["active", "held", "quarantined", "retired"].includes(s.state))
			fail("invalid persisted state");
		if (s.evidence !== null) hash(s.evidence);
		if (s.reason !== null) bounded(s.reason);
		return s;
	}
	claim(turnId: string): TurnClaim | null {
		bounded(turnId);
		if (!this.exists()) return null;
		this.known();
		const r = this.storage.sql
			.exec<{ record: string }>(
				`SELECT record FROM ${TURNS} WHERE id=?`,
				turnId,
			)
			.toArray()[0];
		if (!r) return null;
		let c: TurnClaim;
		try {
			c = JSON.parse(r.record);
		} catch {
			fail("malformed claim");
		}
		if (c.turnId !== turnId || !["running", "completed"].includes(c.status))
			fail("invalid claim");
		hash(c.requestHash);
		generation(c.generation);
		if (c.status === "completed") hash(c.completion);
		else if (c.completion !== null) fail("invalid running claim");
		return c;
	}
	private known(): AdmissionSnapshot {
		return this.read() ?? fail("unverified baseline");
	}
	private save(s: AdmissionSnapshot) {
		this.storage.sql.exec(
			`INSERT OR REPLACE INTO ${STATE} VALUES (1,?)`,
			JSON.stringify(s),
		);
	}
	private evidence(
		action: VerificationAction,
		input: Record<string, unknown>,
		claim?: TurnClaim,
	): string {
		if (
			(action === "initialize" || action === "release") &&
			(this.owner.tediId === null || this.owner.orgId === null)
		)
			fail("anonymous custody cannot become verified active identity");
		const e = this.verify(action, Object.freeze({ ...input }));
		if (
			!same(owner(e.owner), this.owner) ||
			e.complete !== true ||
			!Number.isSafeInteger(e.unknown) ||
			e.unknown !== 0 ||
			!Number.isSafeInteger(e.nonterminal) ||
			e.nonterminal !== 0
		)
			fail("unverified or nonterminal evidence");
		if (
			claim &&
			(e.terminal !== true ||
				!same(e.claim, {
					turnId: claim.turnId,
					requestHash: claim.requestHash,
					generation: claim.generation,
				}))
		)
			fail("receipt does not prove original claim");
		return hash(e.digest);
	}
	private idle() {
		for (const r of this.storage.sql
			.exec<{ id: string }>(`SELECT id FROM ${TURNS}`)
			.toArray())
			if (this.claim(r.id)?.status !== "completed")
				fail("unresolved accepted claim");
	}
	private operation(
		id: string,
		input: Record<string, unknown>,
		fn: () => AdmissionSnapshot,
	): AdmissionSnapshot {
		bounded(id);
		return this.storage.transactionSync(() => {
			if (this.exists()) {
				this.known();
				const prior = this.storage.sql
					.exec<{ input: string; result: string }>(
						`SELECT input,result FROM ${OPS} WHERE id=?`,
						id,
					)
					.toArray()[0];
				if (prior) {
					if (prior.input !== JSON.stringify(input))
						fail("operation id conflict");
					return JSON.parse(prior.result) as AdmissionSnapshot;
				}
			}
			const result = fn();
			this.storage.sql.exec(
				`INSERT INTO ${OPS} VALUES (?,?,?)`,
				id,
				JSON.stringify(input),
				JSON.stringify(result),
			);
			return result;
		});
	}
	initialize(input: {
		operationId: string;
		state: "active" | "quarantined";
		evidence?: string;
		reason?: string;
	}): AdmissionSnapshot {
		const normalized = {
			action: "initialize",
			state: input.state,
			evidence: input.evidence ?? null,
			reason: input.reason ?? null,
		};
		return this.operation(input.operationId, normalized, () => {
			if (this.read()) fail("already initialized");
			if (input.state !== "active" && input.state !== "quarantined")
				fail("invalid initial state");
			const evidence =
				input.state === "active"
					? this.evidence("initialize", normalized)
					: null;
			if (input.state === "active" && evidence !== input.evidence)
				fail("initial evidence mismatch");
			const reason = input.reason === undefined ? null : bounded(input.reason);
			this.setup();
			const s = {
				owner: this.owner,
				state: input.state,
				generation: 1,
				evidence,
				reason,
			};
			this.save(s);
			return s;
		});
	}
	beginTurn(input: {
		turnId: string;
		requestHash: string;
		expectedGeneration: number;
	}): { newlyAccepted: boolean; claim: TurnClaim } {
		bounded(input.turnId);
		hash(input.requestHash);
		generation(input.expectedGeneration);
		return this.storage.transactionSync(() => {
			const s = this.known(),
				prior = this.claim(input.turnId);
			if (prior) {
				if (
					prior.requestHash !== input.requestHash ||
					prior.generation !== input.expectedGeneration
				)
					fail("turn identity conflict");
				return { newlyAccepted: false, claim: prior };
			}
			if (s.state !== "active" || s.generation !== input.expectedGeneration)
				fail("dispatch denied");
			const claim: TurnClaim = {
				turnId: input.turnId,
				requestHash: input.requestHash,
				generation: s.generation,
				status: "running",
				completion: null,
			};
			this.storage.sql.exec(
				`INSERT INTO ${TURNS} VALUES (?,?)`,
				claim.turnId,
				JSON.stringify(claim),
			);
			return { newlyAccepted: true, claim };
		});
	}
	assertTurn(input: {
		turnId: string;
		requestHash: string;
		generation: number;
	}): TurnClaim {
		const s = this.known(),
			c = this.claim(input.turnId);
		if (
			s.state !== "active" ||
			s.generation !== input.generation ||
			!c ||
			c.status !== "running" ||
			c.requestHash !== input.requestHash ||
			c.generation !== input.generation
		)
			fail("dispatch denied");
		return c;
	}
	completeTurn(input: {
		turnId: string;
		requestHash: string;
		generation: number;
		evidence: string;
	}): TurnClaim {
		hash(input.evidence);
		generation(input.generation);
		return this.storage.transactionSync(() => {
			this.known();
			const c = this.claim(input.turnId);
			if (
				!c ||
				c.requestHash !== input.requestHash ||
				c.generation !== input.generation
			)
				fail("unknown original claim");
			if (c.status === "completed") {
				if (c.completion !== input.evidence) fail("completion conflict");
				return c;
			}
			const digest = this.evidence("complete", input, c);
			if (digest !== input.evidence) fail("completion evidence mismatch");
			const completed: TurnClaim = {
				...c,
				status: "completed",
				completion: digest,
			};
			this.storage.sql.exec(
				`UPDATE ${TURNS} SET record=? WHERE id=?`,
				JSON.stringify(completed),
				c.turnId,
			);
			return completed;
		});
	}
	private transition(
		state: AdmissionState,
		input: {
			operationId: string;
			expectedGeneration: number;
			evidence?: string;
			reason?: string;
		},
	): AdmissionSnapshot {
		generation(input.expectedGeneration);
		const normalized = {
			action: state,
			expectedGeneration: input.expectedGeneration,
			evidence: input.evidence ?? null,
			reason: input.reason ?? null,
		};
		return this.operation(input.operationId, normalized, () => {
			const s = this.known();
			if (s.generation !== input.expectedGeneration || s.state === "retired")
				fail("stale or retired generation");
			if (state === "held" && s.state !== "active")
				fail("hold requires active");
			if (state === "active" && !["held", "quarantined"].includes(s.state))
				fail("release requires held or quarantined");
			if (state === "quarantined" && s.state === "quarantined")
				fail("already quarantined");
			let evidence: string | null = null;
			if (state !== "quarantined") {
				this.idle();
				evidence = this.evidence(
					state === "active" ? "release" : state === "held" ? "hold" : "retire",
					normalized,
				);
			}
			if (state !== "quarantined" && evidence !== input.evidence)
				fail("transition evidence mismatch");
			if (s.generation === Number.MAX_SAFE_INTEGER)
				fail("generation exhausted");
			const next: AdmissionSnapshot = {
				owner: this.owner,
				state,
				generation: s.generation + 1,
				evidence,
				reason: input.reason === undefined ? null : bounded(input.reason),
			};
			this.save(next);
			return next;
		});
	}
	hold(input: {
		operationId: string;
		expectedGeneration: number;
		evidence: string;
	}) {
		return this.transition("held", input);
	}
	quarantine(input: {
		operationId: string;
		expectedGeneration: number;
		reason: string;
	}) {
		return this.transition("quarantined", input);
	}
	release(input: {
		operationId: string;
		expectedGeneration: number;
		evidence: string;
	}) {
		return this.transition("active", input);
	}
	retire(input: {
		operationId: string;
		expectedGeneration: number;
		evidence: string;
	}) {
		return this.transition("retired", input);
	}
}
