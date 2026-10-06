/** Read-only semantic reduction of an authenticated Session8 stream. No storage or SDK capabilities. */
import { createHash } from "node:crypto";
import { SessionPreservationTableNames } from "@tedix/api-contract/schemas/tedi";
import {
	projectBranch,
	type SessionEntry,
} from "@tedix/tedi-session/session-repo";

export const SESSION_REHYDRATION_BYTES = 8_388_608;
export const SESSION_REHYDRATION_ROWS = 20_000;
export const SESSION_REHYDRATION_WORK = 200_000;
export const SESSION_REHYDRATION_SCAN = 67_108_864;
export type SemanticBudgetWitness = {
	policy: "session-semantic-stream-v2";
	sourceBytes: number;
	selectedRows: number;
	processedRows: number;
	workUnits: number;
	scanBytes: number;
	retainedBytes: number;
	exhausted:
		| null
		| "source_bytes"
		| "selected_rows"
		| "retained_bytes"
		| "semantic_work"
		| "scan_bytes"
		| "time";
	attemptedCharge: number | null;
	clockExpired: boolean;
	retainedAtFailure: number | null;
};
class BudgetExhaustion extends Error {}
export class SessionSemanticBudget {
	readonly witness!: SemanticBudgetWitness;
	private retained = 0;
	constructor(
		sourceBytes: number,
		selectedRows: number,
		readonly deadline = performance.now() + 30_000,
		private readonly clock = () => performance.now(),
	) {
		if (
			![sourceBytes, selectedRows].every(
				(n) => Number.isSafeInteger(n) && n >= 0,
			)
		)
			return invalid();
		this.witness = {
			policy: "session-semantic-stream-v2",
			sourceBytes,
			selectedRows,
			processedRows: 0,
			workUnits: 0,
			scanBytes: 0,
			retainedBytes: 0,
			exhausted: null,
			attemptedCharge: null,
			clockExpired: false,
			retainedAtFailure: null,
		};
	}
	private fail(
		reason: NonNullable<SemanticBudgetWitness["exhausted"]>,
		charge: number | null = null,
	): never {
		if (!this.witness.exhausted) {
			this.witness.exhausted = reason;
			this.witness.attemptedCharge = charge;
			this.witness.clockExpired = reason === "time";
			this.witness.retainedAtFailure =
				reason === "retained_bytes" ? this.retained : null;
		}
		throw new BudgetExhaustion("Session semantic budget unavailable");
	}
	preflight() {
		if (this.witness.sourceBytes > SESSION_REHYDRATION_BYTES)
			this.fail("source_bytes");
		if (this.witness.selectedRows > SESSION_REHYDRATION_ROWS)
			this.fail("selected_rows");
		this.check();
	}
	check() {
		if (this.witness.exhausted)
			throw new BudgetExhaustion("Session semantic budget unavailable");
		if (this.clock() >= this.deadline) this.fail("time");
	}
	charge(scan = 0, work = 0, retain = 0) {
		this.check();
		if (![scan, work, retain].every((n) => Number.isSafeInteger(n) && n >= 0))
			return invalid();
		if (scan > SESSION_REHYDRATION_SCAN - this.witness.scanBytes)
			this.fail("scan_bytes", scan);
		if (work > SESSION_REHYDRATION_WORK - this.witness.workUnits)
			this.fail("semantic_work", work);
		if (retain > SESSION_REHYDRATION_BYTES - this.retained)
			this.fail("retained_bytes", retain);
		this.witness.scanBytes += scan;
		this.witness.workUnits += work;
		this.retained += retain;
		this.witness.retainedBytes = Math.max(
			this.retained,
			this.witness.retainedBytes,
		);
	}
	release(bytes: number) {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.retained)
			return invalid();
		this.retained -= bytes;
	}
	row() {
		this.charge(0, 1);
		this.witness.processedRows++;
		if (this.witness.processedRows > this.witness.selectedRows)
			return invalid();
	}
	/** Preflight tokens/depth before engine JSON allocation; quoted payload is never interpreted as structure. */
	bytes(text: string) {
		let bytes = 0;
		for (let i = 0; i < text.length; i++) {
			this.charge(2);
			const c = text.charCodeAt(i);
			if (c < 128) bytes++;
			else if (c < 2048) bytes += 2;
			else if (
				c >= 0xd800 &&
				c <= 0xdbff &&
				i + 1 < text.length &&
				text.charCodeAt(i + 1) >= 0xdc00 &&
				text.charCodeAt(i + 1) <= 0xdfff
			) {
				this.charge(2);
				i++;
				bytes += 4;
			} else bytes += 3;
		}
		return bytes;
	}
	array<T, R>(
		values: T[],
		method: "map",
		fn: (v: T, i: number, a: T[]) => R,
	): R[];
	array<T>(
		values: T[],
		method: "filter",
		fn: (v: T, i: number, a: T[]) => unknown,
	): T[];
	array<T>(values: T[], method: "sort", fn: (a: T, b: T) => number): T[];
	array<T>(
		values: T[],
		method: "some" | "every",
		fn: (v: T, i: number, a: T[]) => unknown,
	): boolean;
	array<T>(
		values: T[],
		method: "find",
		fn: (v: T, i: number, a: T[]) => unknown,
	): T | undefined;
	array<T, R>(
		values: T[],
		method: "map" | "filter" | "some" | "every" | "find" | "sort",
		fn: ((v: T, i: number, a: T[]) => R) | ((a: T, b: T) => number),
	): any {
		this.charge(0, values.length);
		const callback = (...args: unknown[]) => {
			this.charge(0, 1);
			return (fn as (...a: unknown[]) => unknown)(...args);
		};
		return (values[method] as Function).call(values, callback);
	}
	indexInput<T>(values: Iterable<T>): T[] {
		if (Array.isArray(values)) this.charge(0, values.length);
		else if (values instanceof Map || values instanceof Set)
			this.charge(0, values.size);
		const result: T[] = [];
		const iterator = values[Symbol.iterator]();
		for (;;) {
			this.charge(0, 1);
			const next = iterator.next();
			if (next.done) break;
			this.charge(0, 1);
			result.push(next.value);
		}
		this.charge(0, result.length);
		return result;
	}
	spreadInput<T>(values: Iterable<T>): T[] {
		return this.indexInput(values);
	}
	stringify(value: unknown): string {
		this.charge(0, 1);
		const stack: Array<{ value: unknown; depth: number }> = [
			{ value, depth: 0 },
		];
		let upper = 0;
		while (stack.length) {
			this.charge(0, 1);
			const item = stack.pop()!;
			if (item.depth > 128) return invalid();
			const v = item.value;
			if (typeof v === "string") {
				this.bytes(v);
				upper += v.length * 6 + 2;
			} else if (v === null || typeof v === "boolean" || typeof v === "number")
				upper += 32;
			else if (v && typeof v === "object") {
				upper += 2;
				for (const k in v) {
					if (!Object.hasOwn(v, k)) continue;
					this.charge(0, 3);
					if (!Array.isArray(v)) {
						this.bytes(k);
						upper += k.length * 6 + 3;
					}
					upper++;
					stack.push({
						value: (v as Record<string, unknown>)[k],
						depth: item.depth + 1,
					});
				}
			} else return invalid();
		}
		this.charge(upper, 1, upper);
		return JSON.stringify(value);
	}
	decodeText(bytes: Uint8Array): string {
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
			pieces: string[] = [];
		let retained = 0;
		for (let offset = 0; offset < bytes.length; offset += 65536) {
			const n = Math.min(65536, bytes.length - offset);
			this.charge(n, 2, n + 3);
			retained += n + 3;
			pieces.push(
				decoder.decode(bytes.subarray(offset, offset + n), { stream: true }),
			);
			this.check();
		}
		this.charge(0, 2, 3);
		retained += 3;
		pieces.push(decoder.decode());
		this.check();
		this.charge(bytes.length, 1, bytes.length);
		const result = pieces.join("");
		this.check();
		this.release(retained);
		return result;
	}
	parse(json: string): unknown {
		const bytes = this.bytes(json);
		this.charge(bytes, 1);
		let depth = 0,
			quoted = false,
			escaped = false,
			scalar = false;
		for (let i = 0; i < json.length; i++) {
			this.check();
			const c = json[i]!;
			if (quoted) {
				if (escaped) escaped = false;
				else if (c === "\\") escaped = true;
				else if (c === '"') quoted = false;
				continue;
			}
			if (c === '"') {
				this.charge(0, 1);
				quoted = true;
				scalar = false;
			} else if (c === "[" || c === "{") {
				this.charge(0, 1);
				if (++depth > 128) return invalid();
				scalar = false;
			} else if (c === "]" || c === "}") {
				this.charge(0, 1);
				if (--depth < 0) return invalid();
				scalar = false;
			} else if (c === "," || c === ":") {
				this.charge(0, 1);
				scalar = false;
			} else if (/\s/.test(c)) scalar = false;
			else if (!scalar) {
				this.charge(0, 1);
				scalar = true;
			}
		}
		if (quoted || depth !== 0) return invalid();
		this.charge(bytes, 1, bytes);
		const result = JSON.parse(json);
		this.check();
		return result;
	}
}
const rethrowBudget = (error: unknown) => {
	if (error instanceof BudgetExhaustion) throw error;
};
const DESCRIPTOR_BYTES = 65_536;
type Reason = "budget_unavailable" | "unsupported_schema" | "invalid_semantics";
export type SessionSemanticObservation = {
	status: "supported" | "absent" | "unavailable";
	reason: Reason | null;
	sessions: number;
	messages: number;
	branches: number;
	compactions: number;
	attachments: number;
};
type StreamedAttachment = { bytes: number; digest: string };
type Cell = null | string | number | Uint8Array | StreamedAttachment;
type Row = Record<string, Cell>;
type Table = {
	present: boolean;
	schema: Record<string, unknown>[];
	columns: Record<string, unknown>[];
	rows: Row[];
	storageValid?: boolean;
};
type Metadata = {
	sourceBytes: number;
	recordCount: number;
	tables: ReadonlyArray<{ table: string; present: boolean; rows: number }>;
};
export type SessionQualification = {
	schemaVersion: 2;
	budget: SemanticBudgetWitness;
	scope: "archived_selected_session8";
	parentLocal: SessionSemanticObservation;
	sdk7: SessionSemanticObservation;
	canonicalLedgerCorrespondence: "not_queried";
	adoptionReady: false;
	executionEligible: false;
};
const empty = (
	status: SessionSemanticObservation["status"],
	reason: Reason | null = null,
): SessionSemanticObservation => ({
	status,
	reason,
	sessions: 0,
	messages: 0,
	branches: 0,
	compactions: 0,
	attachments: 0,
});
const qualification = (
	parentLocal: SessionSemanticObservation,
	sdk7: SessionSemanticObservation,
	budget: SemanticBudgetWitness,
): SessionQualification => ({
	schemaVersion: 2,
	budget: { ...budget },
	scope: "archived_selected_session8",
	parentLocal,
	sdk7,
	canonicalLedgerCorrespondence: "not_queried",
	adoptionReady: false,
	executionEligible: false,
});
const invalid = (): never => {
	throw new Error("Session rehydration verification rejected");
};
const object = (v: unknown): Record<string, unknown> => {
	if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
	return v as Record<string, unknown>;
};
const safe = (v: unknown): number => {
	if (
		typeof v === "string" &&
		v.length <= 17 &&
		/^-?(0|[1-9][0-9]*)$/.test(v)
	) {
		const n = Number(v);
		if (Number.isSafeInteger(n) && String(n) === v) return n;
	}
	if (typeof v === "number" && Number.isSafeInteger(v)) return v;
	return invalid();
};
const nonnegative = (v: unknown): number => {
	const n = safe(v);
	if (n < 0) return invalid();
	return n;
};
const text = (v: unknown): string => (typeof v === "string" ? v : invalid());
const nonempty = (v: unknown): string => {
	const s = text(v);
	return s.length ? s : invalid();
};
const hash = (b: string | Uint8Array, budget: SessionSemanticBudget) => {
	budget.charge(typeof b === "string" ? budget.bytes(b) : b.length, 1);
	return createHash("sha256").update(b).digest("hex");
};

/** Part cursor never interprets descriptor-looking bytes within a raw cell. */
class Cursor {
	private iterator: Iterator<Uint8Array>;
	private part: Uint8Array = new Uint8Array(0);
	private offset = 0;
	private descriptors = new WeakMap<object, number>();
	private descriptorBuffer: Uint8Array;
	private livePart = 0;
	bytes = 0;
	records = 0;
	constructor(
		parts: Iterable<Uint8Array>,
		private readonly budget: SessionSemanticBudget,
	) {
		this.budget.charge(0, 1, DESCRIPTOR_BYTES);
		this.descriptorBuffer = new Uint8Array(DESCRIPTOR_BYTES);
		this.iterator = parts[Symbol.iterator]();
	}
	private fill() {
		while (this.offset === this.part.length) {
			this.budget.release(this.livePart);
			this.livePart = 0;
			this.budget.charge(0, 1, 1_000_000);
			const n = this.iterator.next();
			if (n.done) {
				this.budget.release(1_000_000);
				return false;
			}
			if (
				!(n.value instanceof Uint8Array) ||
				!n.value.length ||
				n.value.length > 1_000_000
			)
				return invalid();
			this.budget.release(1_000_000 - n.value.length);
			this.livePart = n.value.length;
			this.part = n.value;
			this.offset = 0;
		}
		return true;
	}
	byte() {
		if (!this.fill()) return invalid();
		this.budget.charge(1);
		this.bytes++;
		if (this.bytes > SESSION_REHYDRATION_BYTES) return invalid();
		return this.part[this.offset++]!;
	}
	raw(length: number) {
		if (
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > SESSION_REHYDRATION_BYTES - this.bytes
		)
			return invalid();
		this.budget.charge(0, 0, length);
		const out = new Uint8Array(length);
		let at = 0;
		while (at < length) {
			if (!this.fill()) return invalid();
			const n = Math.min(
				length - at,
				this.part.length - this.offset,
				DESCRIPTOR_BYTES,
			);
			this.budget.charge(n);
			out.set(this.part.subarray(this.offset, this.offset + n), at);
			this.offset += n;
			this.bytes += n;
			at += n;
		}
		return out;
	}
	descriptor(): unknown[] {
		let length = 0;
		for (;;) {
			const n = this.byte();
			if (n === 10) break;
			if (length >= DESCRIPTOR_BYTES - 1) return invalid();
			this.descriptorBuffer[length++] = n;
		}
		this.records++;
		this.budget.charge(0, 1);
		this.budget.charge(length, 1, length);
		const v: unknown = this.budget.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				this.descriptorBuffer.subarray(0, length),
			),
		);
		this.budget.release(length);
		if (!Array.isArray(v)) return invalid();
		this.budget.charge(0, 1);
		this.descriptors.set(v, length);
		return v;
	}
	releaseDescriptor(value: unknown[]) {
		const bytes = this.descriptors.get(value);
		if (bytes !== undefined) {
			this.budget.charge(0, 1);
			this.budget.release(bytes);
			this.descriptors.delete(value);
		}
	}

	payload(length: number, real = false) {
		const bytes = this.raw(length);
		if (this.byte() !== 10) return invalid();
		this.records += (real ? 1 : Math.ceil(length / DESCRIPTOR_BYTES)) + 1;
		this.budget.charge(0, 1);
		return bytes;
	}
	streamPayload(length: number, consume: (bytes: Uint8Array) => void) {
		if (
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > SESSION_REHYDRATION_BYTES - this.bytes
		)
			return invalid();
		let remaining = length;
		while (remaining) {
			if (!this.fill()) return invalid();
			const n = Math.min(
				remaining,
				this.part.length - this.offset,
				DESCRIPTOR_BYTES,
			);
			this.budget.charge(n, 1);
			consume(this.part.subarray(this.offset, this.offset + n));
			this.offset += n;
			this.bytes += n;
			remaining -= n;
		}
		if (this.byte() !== 10) return invalid();
		this.records += Math.ceil(length / DESCRIPTOR_BYTES) + 1;
		this.budget.charge(0, 1);
	}

	ended() {
		return !this.fill();
	}
}

// Token comparison accepts only whitespace spelling differences in these exact owning DDLs.
// Quoted literals/identifiers remain exact tokens; no arbitrary normalization of unknown SQL.
function tokens(sql: string, budget: SessionSemanticBudget) {
	const sqlBytes = budget.bytes(sql);
	budget.charge(sqlBytes, 1);
	if (sqlBytes > DESCRIPTOR_BYTES) return invalid();
	const result: string[] = [];
	let at = 0;
	const token =
		/'(?:(?:'')|[^'])*'|"(?:(?:"")|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),=;]/y;
	while (at < sql.length) {
		budget.check();
		if (/\s/.test(sql[at]!)) {
			at++;
			continue;
		}
		token.lastIndex = at;
		const m = token.exec(sql);
		if (!m) return invalid();
		budget.charge(0, 1);
		result.push(m[0]);
		at = token.lastIndex;
	}
	return budget.stringify(result);
}
const TABLE_SQL: Record<string, string> = {
	session_entries:
		"CREATE TABLE session_entries (id TEXT PRIMARY KEY, session_key TEXT NOT NULL,parent_id TEXT,type TEXT NOT NULL DEFAULT 'message',role TEXT NOT NULL,content TEXT NOT NULL,idempotency_key TEXT,ts INTEGER NOT NULL, first_kept_entry_id TEXT, tokens_before INTEGER, model_provider TEXT, model_id TEXT)",
	cf_agents_session_messages:
		"CREATE TABLE cf_agents_session_messages (session_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,parent_id TEXT,type TEXT NOT NULL DEFAULT 'message',role TEXT NOT NULL,content TEXT NOT NULL,content_chunks INTEGER NOT NULL DEFAULT 0,token_estimate INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,content_hash TEXT,PRIMARY KEY (session_id,id)) WITHOUT ROWID",
	cf_agents_session_message_chunks:
		"CREATE TABLE cf_agents_session_message_chunks (session_id TEXT NOT NULL,id TEXT NOT NULL,idx INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY (session_id,id,idx)) WITHOUT ROWID",
	cf_agents_session_compactions:
		"CREATE TABLE cf_agents_session_compactions (session_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,summary TEXT NOT NULL,from_message_id TEXT NOT NULL,to_message_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY (session_id,id)) WITHOUT ROWID",
	cf_agents_session_config:
		"CREATE TABLE cf_agents_session_config (session_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY (session_id,key)) WITHOUT ROWID",
	cf_agents_session_attachment_meta:
		"CREATE TABLE cf_agents_session_attachment_meta (hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,media_type TEXT NOT NULL,chunks INTEGER NOT NULL) WITHOUT ROWID",
	cf_agents_session_attachment_chunks:
		"CREATE TABLE cf_agents_session_attachment_chunks (hash TEXT NOT NULL,idx INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY (hash,idx)) WITHOUT ROWID",
	cf_agents_session_attachment_refs:
		"CREATE TABLE cf_agents_session_attachment_refs (session_id TEXT NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY (session_id,message_id,hash)) WITHOUT ROWID",
};
const INDEX_SQL: Record<string, string> = {
	idx_session_entries_key_ts:
		"CREATE INDEX idx_session_entries_key_ts ON session_entries (session_key, ts)",
	uq_session_entries_key_idem:
		"CREATE UNIQUE INDEX uq_session_entries_key_idem ON session_entries (session_key, idempotency_key) WHERE idempotency_key IS NOT NULL",
};
const COLUMNS: Record<string, string[]> = {
	session_entries: [
		"id",
		"session_key",
		"parent_id",
		"type",
		"role",
		"content",
		"idempotency_key",
		"ts",
		"first_kept_entry_id",
		"tokens_before",
		"model_provider",
		"model_id",
	],
	cf_agents_session_messages: [
		"session_id",
		"id",
		"seq",
		"parent_id",
		"type",
		"role",
		"content",
		"content_chunks",
		"token_estimate",
		"created_at",
		"content_hash",
	],
	cf_agents_session_message_chunks: ["session_id", "id", "idx", "content"],
	cf_agents_session_compactions: [
		"session_id",
		"id",
		"seq",
		"summary",
		"from_message_id",
		"to_message_id",
		"created_at",
	],
	cf_agents_session_config: ["session_id", "key", "value"],
	cf_agents_session_attachment_meta: ["hash", "bytes", "media_type", "chunks"],
	cf_agents_session_attachment_chunks: ["hash", "idx", "data"],
	cf_agents_session_attachment_refs: ["session_id", "message_id", "hash"],
};
function supportedSchema(
	name: string,
	t: Table,
	budget: SessionSemanticBudget,
) {
	if (!t.present) return true;
	try {
		if (
			t.columns.length !== COLUMNS[name]!.length ||
			budget.array(
				t.columns,
				"some",
				(c, i) => c.name !== COLUMNS[name]![i] || c.cid !== i || c.hidden !== 0,
			)
		)
			return false;
		const required = new Set(
			budget.indexInput(
				name === "session_entries"
					? [
							name,
							"idx_session_entries_key_ts",
							"uq_session_entries_key_idem",
							"sqlite_autoindex_session_entries_1",
						]
					: [name],
			),
		);
		for (const s of t.schema) {
			budget.charge(0, 1);
			if (
				s.tbl_name !== name ||
				typeof s.name !== "string" ||
				!(budget.charge(0, 1), required.delete(s.name))
			)
				return false;
			if (s.name === name) {
				if (
					s.type !== "table" ||
					typeof s.sql !== "string" ||
					tokens(s.sql, budget) !== tokens(TABLE_SQL[name]!, budget)
				)
					return false;
			} else if (s.name === "sqlite_autoindex_session_entries_1") {
				if (s.type !== "index" || s.sql !== null) return false;
			} else if (
				s.type !== "index" ||
				typeof s.sql !== "string" ||
				tokens(s.sql, budget) !== tokens(INDEX_SQL[s.name]!, budget)
			)
				return false;
		}
		// WITHOUT ROWID primary keys have no sqlite_master autoindex entry.
		return required.size === 0;
	} catch (error) {
		rethrowBudget(error);
		return false;
	}
}

function decode(
	parts: Iterable<Uint8Array>,
	meta: Metadata,
	selector: string,
	intent: unknown,
	budget: SessionSemanticBudget,
) {
	const c = new Cursor(parts, budget),
		format = c.descriptor();
	if (
		budget.stringify(format) !==
		budget.stringify([
			"format",
			"session-state-archive-v1",
			"selector",
			selector,
			"intent",
			intent,
		])
	)
		return invalid();
	c.releaseDescriptor(format);
	const result: Record<string, Table> = {};
	const attachmentStreams = new Map<
		string,
		{ hash: ReturnType<typeof createHash>; bytes: number; idx: number }
	>();
	let look: unknown[] | undefined;
	for (let i = 0; i < SessionPreservationTableNames.length; i++) {
		budget.charge(0, 1);
		const name = SessionPreservationTableNames[i]!,
			m = meta.tables[i]!;
		const marker = look ?? c.descriptor();
		look = undefined;
		if (
			marker.length !== 3 ||
			marker[0] !== "table" ||
			marker[1] !== name ||
			(marker[2] !== "present" && marker[2] !== "absent") ||
			m.table !== name ||
			m.present !== (marker[2] === "present")
		)
			return invalid();
		const t: Table = {
			present: m.present,
			schema: [],
			columns: [],
			rows: [],
			storageValid: true,
		};
		result[name] = t;
		c.releaseDescriptor(marker);
		if (!t.present) {
			if (m.rows !== 0) return invalid();
			continue;
		}
		for (;;) {
			budget.charge(0, 1);
			look = c.descriptor();
			if (look[0] !== "schema") break;
			if (look.length !== 3 || look[1] !== name) return invalid();
			t.schema.push(object(look[2]));
		}
		for (;;) {
			budget.charge(0, 1);
			if (look[0] !== "column") break;
			if (look.length !== 3 || look[1] !== name) return invalid();
			t.columns.push(object(look[2]));
			look = undefined;
			if (c.ended()) break;
			look = c.descriptor();
		}
		if (
			!t.columns.length ||
			new Set(budget.indexInput(budget.array(t.columns, "map", (x) => x.name)))
				.size !== t.columns.length
		)
			return invalid();
		for (let ordinal = 0; ordinal < m.rows; ordinal++) {
			budget.charge(0, 1);
			const r = look ?? c.descriptor();
			look = undefined;
			if (budget.stringify(r) !== budget.stringify(["row", name, ordinal]))
				return invalid();
			c.releaseDescriptor(r);
			const row: Row = {};
			for (const column of t.columns) {
				budget.charge(0, 1);
				budget.charge(0, 1);
				const d = c.descriptor();
				if (
					d.length !== 4 ||
					d[0] !== "cell" ||
					d[1] !== column.name ||
					typeof column.name !== "string"
				)
					return invalid();
				if (d[2] === "null") {
					if (d[3] !== 0) return invalid();
					row[column.name] = null;
				} else if (d[2] === "integer") {
					if (
						typeof d[3] !== "string" ||
						d[3].length > 20 ||
						!/^-?(0|[1-9][0-9]*)$/.test(d[3]) ||
						d[3] === "-0" ||
						BigInt(d[3]) < -9223372036854775808n ||
						BigInt(d[3]) > 9223372036854775807n
					)
						return invalid();
					budget.charge(0, 0, budget.bytes(d[3]));
					row[column.name] = d[3];
				} else if (d[2] === "real") {
					if (d[3] !== 8) return invalid();
					const b = c.payload(8, true);
					const n = new DataView(b.buffer, b.byteOffset, 8).getFloat64(
						0,
						false,
					);
					if (!Number.isFinite(n)) return invalid();
					row[column.name] = n;
					budget.release(8);
				} else if (d[2] === "text" || d[2] === "blob") {
					if (
						name === "cf_agents_session_attachment_chunks" &&
						column.name === "data" &&
						d[2] === "blob"
					) {
						if (column.type !== "BLOB") t.storageValid = false;
						const id = text(row.hash),
							idx = safe(row.idx);
						budget.charge(0, 2);
						let stream = (budget.charge(0, 1), attachmentStreams.get(id));
						if (!stream) {
							if (idx !== 0) return invalid();
							stream = { hash: createHash("sha256"), bytes: 0, idx: 0 };
							budget.charge(0, 1);
							attachmentStreams.set(id, stream);
						}
						if (idx !== stream.idx++) return invalid();
						const length = nonnegative(d[3]);
						c.streamPayload(length, (bytes) => {
							budget.charge(bytes.length);
							stream!.hash.update(bytes);
						});
						stream.bytes += length;
						budget.charge(0, 3, 64);
						row[column.name] = {
							bytes: stream.bytes,
							digest: stream.hash.copy().digest("hex"),
						};
						c.releaseDescriptor(d);
						continue;
					}
					const b = c.payload(nonnegative(d[3]));

					row[column.name] = d[2] === "blob" ? b : budget.decodeText(b);
					if (d[2] === "text") budget.release(b.length);
				} else return invalid();
				const declared = String(column.type),
					kind = String(d[2]);
				if (
					kind !== "null" &&
					((declared === "INTEGER" && kind !== "integer") ||
						(declared === "TEXT" && kind !== "text") ||
						(declared === "BLOB" && kind !== "blob"))
				)
					t.storageValid = false;
				c.releaseDescriptor(d);
			}
			budget.row();
			t.rows.push(row);
		}
		// Empty tables already consumed the next marker; nonempty ones have not.
	}
	if (
		look !== undefined ||
		!c.ended() ||
		c.bytes !== meta.sourceBytes ||
		c.records !== meta.recordCount
	)
		return invalid();
	return result;
}

function exactColumn(
	column: Record<string, unknown>,
	budget: SessionSemanticBudget,
) {
	let count = 0;
	for (const key in column) {
		if (!Object.hasOwn(column, key)) continue;
		budget.charge(0, 8);
		if (
			![
				"cid",
				"dflt_value",
				"hidden",
				"name",
				"notnull",
				"pk",
				"type",
			].includes(key)
		)
			return false;
		count++;
	}
	return count === 7;
}
function assertColumnValues(
	name: string,
	t: Table,
	budget: SessionSemanticBudget,
) {
	if (t.storageValid === false) return invalid();
	const nullable =
		name === "session_entries"
			? new Set(
					budget.indexInput([
						"id",
						"parent_id",
						"idempotency_key",
						"first_kept_entry_id",
						"tokens_before",
						"model_provider",
						"model_id",
					]),
				)
			: new Set(budget.indexInput(["parent_id", "content_hash"]));
	const integers = new Set(
		budget.indexInput([
			"seq",
			"idx",
			"bytes",
			"chunks",
			"content_chunks",
			"token_estimate",
			"created_at",
			"ts",
			"tokens_before",
		]),
	);
	for (const c of t.columns) {
		budget.charge(0, 1);
		budget.charge(0, 1);
		const col = text(c.name),
			kind = (budget.charge(0, 1), integers.has(col))
				? "INTEGER"
				: col === "data"
					? "BLOB"
					: "TEXT";
		const pks: Record<string, string[]> = {
			session_entries: ["id"],
			cf_agents_session_messages: ["session_id", "id"],
			cf_agents_session_message_chunks: ["session_id", "id", "idx"],
			cf_agents_session_compactions: ["session_id", "id"],
			cf_agents_session_config: ["session_id", "key"],
			cf_agents_session_attachment_meta: ["hash"],
			cf_agents_session_attachment_chunks: ["hash", "idx"],
			cf_agents_session_attachment_refs: ["session_id", "message_id", "hash"],
		};
		const pk = pks[name]!.indexOf(col) + 1,
			defaultValue =
				col === "type"
					? "'message'"
					: col === "content_chunks" || col === "token_estimate"
						? "0"
						: null;
		if (
			!exactColumn(c, budget) ||
			c.type !== kind ||
			c.notnull !== ((budget.charge(0, 1), nullable.has(col)) ? 0 : 1) ||
			c.hidden !== 0 ||
			c.pk !== pk ||
			c.dflt_value !== defaultValue
		)
			return invalid();
	}
	for (const r of t.rows) {
		budget.charge(0, 1);
		for (const c of t.columns) {
			budget.charge(0, 1);
			budget.charge(0, 1);
			const col = text(c.name),
				v = r[col];
			if (v === null) {
				if (!(budget.charge(0, 1), nullable.has(col))) return invalid();
				continue;
			}
			if (c.type === "BLOB") {
				if (
					!(v instanceof Uint8Array) &&
					!(
						name === "cf_agents_session_attachment_chunks" &&
						v &&
						typeof v === "object" &&
						"digest" in v
					)
				)
					return invalid();
			} else if (c.type === "INTEGER") safe(v);
			else if (typeof v !== "string") return invalid();
		}
	}
}
const key = (session: string, id: string, budget: SessionSemanticBudget) =>
	budget.stringify([session, id]);
function unique(rows: Row[], columns: string[], budget: SessionSemanticBudget) {
	const seen = new Set<string>();
	for (const r of rows) {
		budget.charge(0, 1);
		const id = budget.stringify(budget.array(columns, "map", (c) => r[c]));
		if ((budget.charge(0, 1), seen.has(id))) return invalid();
		budget.charge(0, 1);
		seen.add(id);
	}
}
function checkParts(
	message: Record<string, unknown>,
	seenCalls: Set<string>,
	budget: SessionSemanticBudget,
) {
	if (!Array.isArray(message.parts)) return invalid();
	for (const raw of message.parts) {
		budget.charge(0, 1);
		const p = object(raw),
			kind = nonempty(p.type);
		if (kind === "text" || kind === "reasoning") {
			text(p.text);
			continue;
		}
		if (kind === "file") {
			text(p.mediaType);
			text(p.url);
			continue;
		}
		if (kind === "step-start") continue;
		if (kind === "dynamic-tool" || kind.startsWith("tool-")) {
			const id = nonempty(p.toolCallId);
			if ((budget.charge(0, 1), seenCalls.has(id))) return invalid();
			budget.charge(0, 1);
			seenCalls.add(id);
			if (p.state !== "output-available" && p.state !== "output-error")
				return invalid();
			if (p.state === "output-available" && !Object.hasOwn(p, "output"))
				return invalid();
			if (p.state === "output-error") text(p.errorText);
			if (!Object.hasOwn(p, "input")) return invalid();
			continue;
		}
		return invalid();
	}
}
function grouped<T>(
	items: T[],
	getKey: (item: T) => string,
	budget: SessionSemanticBudget,
) {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		budget.charge(0, 4);
		const k = getKey(item);
		let bucket = (budget.charge(0, 1), groups.get(k));
		if (!bucket) {
			bucket = [];
			budget.charge(0, 1);
			groups.set(k, bucket);
		}
		bucket.push(item);
	}
	return groups;
}
function acyclic(
	parents: Map<string, string | null>,
	budget: SessionSemanticBudget,
) {
	const done = new Set<string>();
	for (const id of parents.keys()) {
		budget.charge(0, 1);
		const visiting = new Set<string>();
		let at: string | null = id;
		while (at !== null && !(budget.charge(0, 1), done.has(at))) {
			budget.charge(0, 4);
			if (
				(budget.charge(0, 1), visiting.has(at)) ||
				!(budget.charge(0, 1), parents.has(at))
			)
				return invalid();
			budget.charge(0, 1);
			visiting.add(at);
			at = (budget.charge(0, 1), parents.get(at))!;
		}
		for (const key of visiting) {
			budget.charge(0, 1);
			budget.charge(0, 1);
			done.add(key);
		}
	}
}

export function reduceSessionTables(
	tables: Record<string, Table>,
	budget = new SessionSemanticBudget(
		0,
		Object.values(tables).reduce((n, t) => n + t.rows.length, 0),
	),
) {
	const root = tables.session_entries!;
	let parent = empty(root.present ? "supported" : "absent"),
		sdk = empty(
			budget.array(
				SessionPreservationTableNames.slice(1),
				"some",
				(n) => tables[n]!.present,
			)
				? "supported"
				: "absent",
		);
	const privateParent: Array<{
		sessionId: string;
		leafId: string;
		context: ReturnType<typeof projectBranch>;
	}> = [];
	const privateSdk: Array<{
		sessionId: string;
		leafId: string;
		messages: Record<string, unknown>[];
	}> = [];
	if (root.present) {
		if (!supportedSchema("session_entries", root, budget))
			parent = empty("unavailable", "unsupported_schema");
		else
			try {
				assertColumnValues("session_entries", root, budget);
				unique(root.rows, ["id"], budget);
				const entries: (SessionEntry & {
					idempotencyKey: string | null;
					modelProvider: string | null;
					modelId: string | null;
				})[] = budget.array(root.rows, "map", (r) => ({
					id: nonempty(r.id),
					sessionKey: nonempty(r.session_key),
					parentId: r.parent_id === null ? null : nonempty(r.parent_id),
					type:
						r.type === "message"
							? "message"
							: r.type === "compaction"
								? "compaction"
								: r.type === "branch_summary"
									? "branch_summary"
									: invalid(),
					role:
						r.role === "user"
							? "user"
							: r.role === "assistant"
								? "assistant"
								: invalid(),
					content: text(r.content),
					idempotencyKey:
						r.idempotency_key === null ? null : nonempty(r.idempotency_key),
					ts: safe(r.ts),
					firstKeptEntryId:
						r.first_kept_entry_id === null
							? undefined
							: nonempty(r.first_kept_entry_id),
					tokensBefore:
						r.tokens_before === null ? undefined : nonnegative(r.tokens_before),
					modelProvider:
						r.model_provider === null ? null : text(r.model_provider),
					modelId: r.model_id === null ? null : text(r.model_id),
				}));
				const ids = new Map(
					budget.indexInput(budget.array(entries, "map", (e) => [e.id, e])),
				);
				const bySession = grouped(entries, (e) => e.sessionKey, budget),
					parentMap = new Map<string, string | null>();
				for (const members of bySession.values()) {
					budget.array(
						members,
						"sort",
						(a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1),
					);
					for (let i = 0; i < members.length; i++) {
						budget.charge(0, 2);
						budget.charge(0, 1);
						parentMap.set(
							members[i]!.id,
							members[i]!.parentId ?? members[i - 1]?.id ?? null,
						);
					}
				}
				acyclic(parentMap, budget);
				function parentPath(id: string) {
					const out: SessionEntry[] = [];
					while (id) {
						budget.charge(0, 3);
						const current = (budget.charge(0, 1), ids.get(id));
						if (!current) return invalid();
						out.push(current);
						id = (budget.charge(0, 1), parentMap.get(id)) ?? "";
					}
					budget.charge(0, out.length);
					return out.reverse();
				}
				const idem = new Set<string>();
				for (const e of entries) {
					budget.charge(0, 1);
					if (
						e.parentId &&
						((budget.charge(0, 1), ids.get(e.parentId))?.sessionKey !==
							e.sessionKey ||
							(budget.charge(0, 1), ids.get(e.parentId))!.ts > e.ts)
					)
						return invalid();
					if (e.idempotencyKey !== null) {
						const id = key(e.sessionKey, e.idempotencyKey, budget);
						if ((budget.charge(0, 1), idem.has(id))) return invalid();
						budget.charge(0, 1);
						idem.add(id);
					}

					if (e.type === "compaction") {
						if (
							!e.firstKeptEntryId ||
							e.firstKeptEntryId === e.id ||
							e.tokensBefore === undefined ||
							(budget.charge(0, 1), ids.get(e.firstKeptEntryId))?.type !==
								"message" ||
							(budget.charge(0, 1), ids.get(e.firstKeptEntryId))?.sessionKey !==
								e.sessionKey ||
							!budget.array(
								parentPath(e.id),
								"some",
								(x) => x.id === e.firstKeptEntryId,
							)
						)
							return invalid();
					} else if (
						e.firstKeptEntryId !== undefined ||
						e.tokensBefore !== undefined
					)
						return invalid();
					if ((e.modelProvider === null) !== (e.modelId === null))
						return invalid();
				}
				const sessions = [
					...budget.spreadInput(
						new Set(
							budget.indexInput(
								budget.array(entries, "map", (e) => e.sessionKey),
							),
						),
					),
				];
				let leaves = 0;
				for (const sessionId of sessions) {
					budget.charge(0, 1);
					const members = (budget.charge(0, 1), bySession.get(sessionId))!;
					const parentIds = new Map(
						budget.indexInput(
							budget.array(members, "map", (e, i) => [
								e.id,
								e.parentId ?? members[i - 1]?.id ?? null,
							]),
						),
					);
					budget.charge(0, parentIds.size);
					const parentValues = new Set(budget.indexInput(parentIds.values()));
					for (const e of members) {
						budget.charge(0, 1);
						if (!(budget.charge(0, 1), parentValues.has(e.id))) leaves++;
					}
					const active = members.at(-1)!;
					privateParent.push({
						sessionId,
						leafId: active.id,
						context: (() => {
							const chain = parentPath(active.id);
							budget.charge(0, chain.length * 7);
							return projectBranch(chain);
						})(),
					});
				}
				parent = {
					...parent,
					sessions: sessions.length,
					messages: budget.array(entries, "filter", (e) => e.type === "message")
						.length,
					branches: leaves,
					compactions: budget.array(
						entries,
						"filter",
						(e) => e.type === "compaction",
					).length,
				};
			} catch (error) {
				rethrowBudget(error);
				parent = empty("unavailable", "invalid_semantics");
				privateParent.length = 0;
			}
	}
	if (sdk.status !== "absent") {
		if (
			budget.array(
				SessionPreservationTableNames.slice(1),
				"some",
				(n) => !tables[n]!.present || !supportedSchema(n, tables[n]!, budget),
			)
		)
			sdk = empty("unavailable", "unsupported_schema");
		else
			try {
				for (const n of SessionPreservationTableNames.slice(1)) {
					budget.charge(0, 1);
					assertColumnValues(n, tables[n]!, budget);
				}
				const rows = (n: string) => tables[n]!.rows;
				const messages = rows("cf_agents_session_messages"),
					continuations = rows("cf_agents_session_message_chunks"),
					compacts = rows("cf_agents_session_compactions"),
					configs = rows("cf_agents_session_config"),
					metas = rows("cf_agents_session_attachment_meta"),
					chunks = rows("cf_agents_session_attachment_chunks"),
					refs = rows("cf_agents_session_attachment_refs");
				unique(messages, ["session_id", "id"], budget);
				unique(continuations, ["session_id", "id", "idx"], budget);
				unique(compacts, ["session_id", "id"], budget);
				unique(configs, ["session_id", "key"], budget);
				unique(metas, ["hash"], budget);
				unique(chunks, ["hash", "idx"], budget);
				unique(refs, ["session_id", "message_id", "hash"], budget);
				const attachmentChunks = grouped(chunks, (c) => text(c.hash), budget),
					messageChunks = grouped(
						continuations,
						(c) => key(text(c.session_id), text(c.id), budget),
						budget,
					);
				const sessionMessages = grouped(
						messages,
						(m) => text(m.session_id),
						budget,
					),
					sessionCompactions = grouped(
						compacts,
						(c) => text(c.session_id),
						budget,
					);
				const referenceSet = new Set<string>();
				for (const ref of refs) {
					budget.charge(0, 2);
					budget.charge(0, 1);
					referenceSet.add(
						budget.stringify([ref.session_id, ref.message_id, ref.hash]),
					);
				}
				const attachments = new Map<string, Row>();
				for (const m of metas) {
					budget.charge(0, 1);
					const id = nonempty(m.hash);
					if (!/^[a-f0-9]{64}$/.test(id)) return invalid();
					const parts = budget.array(
						(budget.charge(0, 1), attachmentChunks.get(id)) ?? [],
						"sort",
						(a, b) => safe(a.idx) - safe(b.idx),
					);
					if (
						parts.length !== nonnegative(m.chunks) ||
						budget.array(parts, "some", (p, i) => safe(p.idx) !== i)
					)
						return invalid();
					const h = createHash("sha256");
					let bytes = 0;
					for (const p of parts) {
						budget.charge(0, 1);
						if (p.data instanceof Uint8Array) {
							budget.charge(p.data.length, 1);
							h.update(p.data);
							bytes += p.data.length;
						} else if (
							p.data &&
							typeof p.data === "object" &&
							"digest" in p.data
						)
							bytes = p.data.bytes;
						else return invalid();
					}
					const last = parts.at(-1)?.data;
					const digest =
						last &&
						!(last instanceof Uint8Array) &&
						typeof last === "object" &&
						"digest" in last
							? last.digest
							: h.digest("hex");
					if (bytes !== nonnegative(m.bytes) || digest !== id) return invalid();
					text(m.media_type);
					budget.charge(0, 1);
					attachments.set(id, m);
				}
				if (
					budget.array(
						chunks,
						"some",
						(c) => !(budget.charge(0, 1), attachments.has(text(c.hash))),
					)
				)
					return invalid();
				type Node = { row: Row; message: Record<string, unknown> };
				const nodes = new Map<string, Node>();
				const pointers = new Map<string, Set<string>>();
				function references(v: unknown, set: Set<string>) {
					const stack: Array<{ value: unknown; depth: number }> = [
						{ value: v, depth: 0 },
					];
					budget.charge(0, 1);
					while (stack.length) {
						budget.charge(0, 1);
						const { value, depth } = stack.pop()!;
						if (depth > 128) return invalid();
						if (value === null || typeof value !== "object") continue;
						if (!Array.isArray(value)) {
							const o = object(value);
							for (const k of ["url", "data"]) {
								budget.charge(0, 1);
								const p = o[k];
								if (
									typeof p === "string" &&
									p.startsWith("attachment:sha256:")
								) {
									const id = p.slice(18);
									if (!(budget.charge(0, 1), attachments.has(id)))
										return invalid();
									budget.charge(0, 1);
									set.add(id);
								}
							}
						}
						for (const k in value) {
							if (!Object.hasOwn(value, k)) continue;
							budget.charge(0, 3);
							stack.push({
								value: (value as Record<string, unknown>)[k],
								depth: depth + 1,
							});
						}
					}
				}
				for (const m of messages) {
					budget.charge(0, 1);
					const sid = nonempty(m.session_id),
						id = nonempty(m.id),
						parts = budget.array(
							(budget.charge(0, 1), messageChunks.get(key(sid, id, budget))) ??
								[],
							"sort",
							(a, b) => safe(a.idx) - safe(b.idx),
						);
					if (
						m.type !== "message" ||
						parts.length !== nonnegative(m.content_chunks) ||
						budget.array(parts, "some", (p, i) => safe(p.idx) !== i + 1)
					)
						return invalid();
					let joinBytes = budget.bytes(text(m.content));
					for (const p of parts) {
						budget.charge(0, 1);
						joinBytes += budget.bytes(text(p.content));
					}
					budget.charge(joinBytes, 1, joinBytes);
					const json =
						text(m.content) +
						budget.array(parts, "map", (p) => text(p.content)).join("");
					if (
						m.content_hash !== null &&
						(typeof m.content_hash !== "string" ||
							hash(json, budget) !== m.content_hash)
					)
						return invalid();
					const parsed = object(budget.parse(json));
					if (
						parsed.id !== id ||
						parsed.role !== m.role ||
						!["user", "assistant", "system"].includes(text(m.role))
					)
						return invalid();
					safe(m.created_at);
					nonnegative(m.token_estimate);
					const set = new Set<string>();
					references(parsed, set);
					budget.charge(0, 1);
					pointers.set(key(sid, id, budget), set);
					budget.charge(0, 1);
					nodes.set(key(sid, id, budget), { row: m, message: parsed });
					budget.release(joinBytes);
				}
				if (
					budget.array(
						continuations,
						"some",
						(c) =>
							!(budget.charge(0, 1),
							nodes.has(key(text(c.session_id), text(c.id), budget))),
					)
				)
					return invalid();
				for (const ref of refs) {
					budget.charge(0, 1);
					const id = key(text(ref.session_id), text(ref.message_id), budget),
						h = text(ref.hash);
					if (
						!(budget.charge(0, 1), nodes.has(id)) ||
						!(budget.charge(0, 1), attachments.has(h)) ||
						!(budget.charge(0, 1),
						(budget.charge(0, 1), pointers.get(id))!.has(h))
					)
						return invalid();
				}
				for (const [id, set] of pointers) {
					budget.charge(0, 1);
					const [sid, mid] = budget.parse(id) as string[];
					for (const hash of set) {
						budget.charge(0, 2);
						if (
							!(budget.charge(0, 1),
							referenceSet.has(budget.stringify([sid, mid, hash])))
						)
							return invalid();
					}
				}
				const sessionIds = [
					...budget.spreadInput(
						new Set(
							budget.indexInput([
								...budget.spreadInput(
									budget.array(messages, "map", (m) => text(m.session_id)),
								),
								...budget.spreadInput(
									budget.array(configs, "map", (c) => text(c.session_id)),
								),
							]),
						),
					),
				];
				let branches = 0;
				function path(sid: string, leaf: string) {
					const list: Node[] = [];
					const seen = new Set<string>();
					let id: string | null = leaf;
					while (id !== null) {
						budget.charge(0, 6);
						if ((budget.charge(0, 1), seen.has(id))) return invalid();
						budget.charge(0, 1);
						seen.add(id);
						const n: Node | undefined =
							(budget.charge(0, 1), nodes.get(key(sid, id, budget)));
						if (!n) return invalid();
						list.push(n);
						id = n.row.parent_id === null ? null : text(n.row.parent_id);
					}
					budget.charge(0, list.length);
					return list.reverse();
				}
				for (const sid of sessionIds) {
					budget.charge(0, 1);
					const members = budget.array(
						(budget.charge(0, 1), sessionMessages.get(sid)) ?? [],
						"sort",
						(a, b) => safe(a.seq) - safe(b.seq),
					);
					unique(members, ["seq"], budget);
					for (const m of members) {
						budget.charge(0, 1);
						nonnegative(m.seq);
						if (m.parent_id !== null) {
							const p =
								(budget.charge(0, 1),
								nodes.get(key(sid, text(m.parent_id), budget)));
							if (!p || safe(p.row.seq) >= safe(m.seq)) return invalid();
						}
					}
					// Match the pinned SDK's child traversal: hidden overlay rows are
					// replaced by their visible descendants, never exposed as leaves.
					const hidden = new Set(
						budget.indexInput(
							budget.array(
								(budget.charge(0, 1), sessionCompactions.get(sid)) ?? [],
								"map",
								(c) => `compaction_${text(c.id)}`,
							),
						),
					);
					const visibleMembers = budget.array(
						members,
						"filter",
						(m) => !(budget.charge(0, 1), hidden.has(text(m.id))),
					);
					const visibleParents = new Set(
						budget.indexInput(
							budget.array(visibleMembers, "map", (m) => {
								let parent = m.parent_id;
								while (
									parent !== null &&
									(budget.charge(0, 1), hidden.has(text(parent)))
								) {
									budget.charge(0, 1);
									parent = (budget.charge(0, 1),
									nodes.get(key(sid, text(parent), budget)))!.row.parent_id;
								}
								return parent;
							}),
						),
					);
					const compactByStart = grouped(
						(budget.charge(0, 1), sessionCompactions.get(sid)) ?? [],
						(c) => text(c.from_message_id),
						budget,
					);
					for (const leaf of budget.array(
						visibleMembers,
						"filter",
						(m) => !(budget.charge(0, 1), visibleParents.has(m.id)),
					)) {
						budget.charge(0, 1);
						branches++;
						const chain = path(sid, text(leaf.id)),
							calls = new Set<string>();
						for (const n of chain) {
							budget.charge(0, 1);
							checkParts(n.message, calls, budget);
						}
						const visible = budget.array(
								chain,
								"filter",
								(n) => !(budget.charge(0, 1), hidden.has(text(n.row.id))),
							),
							indices = new Map(
								budget.indexInput(
									budget.array(visible, "map", (n, i) => [text(n.row.id), i]),
								),
							);

						const projected: Record<string, unknown>[] = [];
						for (let i = 0; i < visible.length; i++) {
							budget.charge(0, 2);
							let compact: Row | undefined;
							for (const c of (budget.charge(0, 1),
							compactByStart.get(text(visible[i]!.row.id))) ?? []) {
								budget.charge(0, 3);
								if (
									((budget.charge(0, 1), indices.get(text(c.to_message_id))) ??
										-1) >= i &&
									(!compact || safe(c.seq) > safe(compact.seq))
								)
									compact = c;
							}
							if (compact) {
								budget.charge(0, 5);
								projected.push({
									id: `compaction_${text(compact.id)}`,
									role: "assistant",
									parts: [{ type: "text", text: text(compact.summary) }],
								});
								i = (budget.charge(0, 1),
								indices.get(text(compact.to_message_id)))!;
							} else {
								budget.charge(0, 1);
								projected.push(visible[i]!.message);
							}
						}
						// Private semantic projection keeps authenticated attachment pointers;
						// no payload hydration/base64 allocation or deferred uncharged subtree.
						budget.charge(0, 3);
						privateSdk.push({
							sessionId: sid,
							leafId: text(leaf.id),
							messages: projected,
						});
					}
				}
				for (const c of configs) {
					budget.charge(0, 1);
					text(c.key);
					text(c.value);
					return invalid();
				}
				for (const c of compacts) {
					budget.charge(0, 1);
					const sid = text(c.session_id),
						from = text(c.from_message_id),
						to = text(c.to_message_id);
					safe(c.created_at);
					nonnegative(c.seq);
					text(c.summary);
					if (!budget.array(path(sid, to), "some", (n) => n.row.id === from))
						return invalid();
				}
				sdk = {
					...sdk,
					sessions: sessionIds.length,
					messages: messages.length,
					branches,
					compactions: compacts.length,
					attachments: metas.length,
				};
			} catch (error) {
				rethrowBudget(error);
				sdk = empty("unavailable", "invalid_semantics");
				privateSdk.length = 0;
			}
	}
	return {
		qualification: qualification(parent, sdk, budget.witness),
		privateParent,
		privateSdk,
	};
}

/** Private semantic projection for owning golden tests; callers must authenticate archive bytes first. */
export function reduceSessionArchive(
	parts: Iterable<Uint8Array>,
	metadata: Metadata,
	selector: string,
	intent: unknown,
	deadline = performance.now() + 30_000,
	clock = () => performance.now(),
) {
	let selectedRows = 0;
	for (const t of metadata.tables) {
		if (
			!Number.isSafeInteger(t.rows) ||
			t.rows < 0 ||
			t.rows > Number.MAX_SAFE_INTEGER - selectedRows
		)
			return invalid();
		selectedRows += t.rows;
	}
	const budget = new SessionSemanticBudget(
		metadata.sourceBytes,
		selectedRows,
		deadline,
		clock,
	);
	try {
		budget.preflight();
		const tables = decode(parts, metadata, selector, intent, budget);
		const result = reduceSessionTables(tables, budget);
		budget.check();
		return {
			...result,
			qualification: { ...result.qualification, budget: { ...budget.witness } },
		};
	} catch (error) {
		if (error instanceof BudgetExhaustion)
			return {
				qualification: qualification(
					empty("unavailable", "budget_unavailable"),
					empty("unavailable", "budget_unavailable"),
					budget.witness,
				),
				privateParent: [],
				privateSdk: [],
			};
		return invalid();
	}
}

export function qualifySessionArchive(
	parts: Iterable<Uint8Array>,
	metadata: Metadata,
	selector: string,
	intent: unknown,
	deadline = performance.now() + 30000,
	clock = () => performance.now(),
): SessionQualification {
	return reduceSessionArchive(
		parts,
		metadata,
		selector,
		intent,
		deadline,
		clock,
	).qualification;
}
