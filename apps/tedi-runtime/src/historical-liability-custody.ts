import { createHash } from "node:crypto";
import {
	CanonicalReader,
	CanonicalKVValue,
	StreamArray,
	StreamObject,
	writeCanonical,
} from "./historical-liability-stream-codec";
import { RuntimeAdmission, type AdmissionSnapshot } from "./runtime-admission";

/** Passive historical custody only. A seal is a prohibition, never execution authority. */
export type HistoricalSDKTable = "cf_agents_workflows" | "cf_agents_fibers";
export type ReplayIdentity =
	| { kind: "workflow"; binding: string; id: string }
	| { kind: "fiber" | "fiber_key" | "run"; id: string };
export interface HistoricalSourceRequest {
	table: HistoricalSDKTable;
	id: string;
	expectedGeneration: number;
}
type Row = Record<string, SqlStorageValue>;
export interface HistoricalLiability {
	version: 1;
	liabilityId: string;
	objectId: string;
	custody: AdmissionSnapshot;
	ownerUnknown: boolean;
	source: HistoricalSourceRequest;
	sourceHash: string;
	sdkRow: Row;
	sourceFacts: {
		sql: Array<[string, Row[]]>;
		kv: Array<[string, unknown]>;
		history: Array<{ table: string; count: number; hash: string }>;
	};
	identities: ReplayIdentity[];
	exposure: {
		providerUsage: "unknown";
		reservationCoverage: "unknown";
		externalEffects: "unknown";
		ledgerDelivery: "unknown";
		observation: "stored_facts_only";
		inventoryScope: "fixed_whitelist_partial";
		estimatesAreBounds: false;
		financialFacts: "observed" | "not_observed";
		effectFacts: "observed" | "not_observed";
	};
	disposition: "unknown";
}
// https://developers.cloudflare.com/durable-objects/platform/limits/
// SQL rows are limited to 2 MB. One MB byte parts leave room for fixed hash/manifest columns.
// This bounds each row, never the complete archival record.
const CHUNK_BYTES = 1_000_000;
const SNAPSHOT = "historical_custody_snapshot",
	PARTS = "historical_custody_parts",
	REFS = "historical_liability_refs",
	SEALS = "historical_replay_seals";
const OWNED = [SNAPSHOT, PARTS, REFS, SEALS];
export interface SnapshotRequest {
	expectedGeneration: number;
}
export interface SnapshotSummary {
	snapshotId: string;
	sourceHash: string;
	generation: number;
	workflowCount: number;
	fiberCount: number;
	identityCount: number;
}
interface SourceEntry {
	table: HistoricalSDKTable;
	id: string;
	sdkRow: Row;
	identities: ReplayIdentity[];
}
interface SourceSnapshot {
	objectId: string;
	custody: AdmissionSnapshot;
	sourceFacts: HistoricalLiability["sourceFacts"];
	tables: Array<{
		table: HistoricalSDKTable;
		present: boolean;
		rows: SourceEntry[];
	}>;
}
interface RowLocator {
	where: string;
	values: SqlStorageValue[];
}
interface SourcePlan {
	custody: AdmissionSnapshot;
	kv: string[];
	sql: Array<[string, RowLocator[]]>;
	history: HistoricalLiability["sourceFacts"]["history"];
	tables: Array<{
		table: HistoricalSDKTable;
		present: boolean;
		rows: Array<{
			locator: RowLocator;
			id: string;
			identities: ReplayIdentity[];
		}>;
	}>;
}
interface CompactRef {
	liabilityId: string;
	table: HistoricalSDKTable;
	id: string;
	rowHash: string;
	sourceHash: string;
	identities: ReplayIdentity[];
}
interface CompactManifest {
	objectId: string;
	snapshotId: string;
	sourceHash: string;
	refs: CompactRef[];
	identities: Array<{
		key: string;
		identity: ReplayIdentity;
		liabilityIds: string[];
	}>;
}
interface Header extends SnapshotSummary {
	objectId: string;
	custody: AdmissionSnapshot;
	manifestHash: string;
	sourceBytes: number;
	sourceParts: number;
	manifestBytes: number;
	manifestParts: number;
}
const HISTORY = [
	"cf_agents_session_messages",
	"cf_agents_session_message_chunks",
	"cf_agents_session_compactions",
	"cf_agents_session_config",
	"cf_agents_session_attachment_meta",
	"cf_agents_session_attachment_chunks",
	"cf_agents_session_attachment_refs",
] as const;
const FACT_TABLES = [
	"cf_agents_state",
	"cf_agents_runs",
	"cf_agents_facet_runs",
	"cf_agents_task_runs",
	"cf_agent_tool_runs",
	"inference_daily_usage",
	"inference_recovery_anchor_migrations",
	"inference_turn_usage",
	"inference_turn_admissions",
	"inference_step_usage",
	"runtime_admission_turns",
	"runtime_admission_identities",
	"runtime_admission_receipts",
	"runtime_admission_evidence",
	// Original legacy history and registry facts remain evidence, never native execution claims.
	"assistant_messages",
	"assistant_compactions",
	"assistant_sessions",
	"assistant_fts",
	"cf_agents_sub_agents",
] as const;
const KV_PREFIXES = [
	"wfctx:",
	"wfcancel:",
	"wfimages:",
	"workflow-image-cleanup:",
	"think-accounting:",
	"pi-accounting:",
	"facet-dispatch-call:",
	"computer-effect:",
	"computer-environment:",
	"computer-continuation:",
	"ledger-outbox:",
	"ledger-delivery-blocked:",
	"tedix:pi:telegram:reply:",
	"__cf_messenger_recovery:",
	"cf:chat-recovery:incident:",
	"computer-acquisition:",
	"runtime-admission-workflow:",
	"runtime-workflow-observation:",
] as const;
const KV_KEYS = Object.freeze([
	"cf_agents_is_facet",
	"cf_agents_parent_path",
	"cf_agents_facet_name",
	"agent_name",
] as const);
/** Single source of capture selectors; diagnostics never maintain a second whitelist. */
export const HISTORICAL_CAPTURE_SELECTORS = Object.freeze({
	factTables: Object.freeze(FACT_TABLES),
	historyTables: Object.freeze(HISTORY),
	sdkTables: Object.freeze([
		"cf_agents_workflows",
		"cf_agents_fibers",
	] as const),
	kvPrefixes: Object.freeze(KV_PREFIXES),
	kvKeys: KV_KEYS,
});
export function historicalCaptureSelectorVersion(): string {
	return hash(canonical(HISTORICAL_CAPTURE_SELECTORS));
}
/** Exact archive bytes for one [key,value] KV item; the reference scope excludes its pair framing. */
export function historicalCaptureItemBytes(item: unknown): number {
	if (
		!Array.isArray(item) ||
		item.length !== 2 ||
		typeof item[0] !== "string" ||
		Object.keys(item).length !== 2 ||
		Object.keys(item).some((key, index) => key !== String(index))
	)
		fail("invalid source KV fields");
	return writeCanonical([item[0], new CanonicalKVValue(item[1])]).bytes;
}
function fail(message: string): never {
	throw new Error(`Historical liability: ${message}`);
}
function text(v: unknown): string {
	if (typeof v !== "string" || !v) fail("invalid identity");
	return v;
}
function record(v: unknown): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v)) fail("invalid record");
	return v as Record<string, unknown>;
}
function exact(v: unknown, keys: string[]) {
	const r = record(v);
	if (
		Object.keys(r).some((k) => !keys.includes(k)) ||
		keys.some((k) => !Object.hasOwn(r, k))
	)
		fail("invalid fields");
	return r;
}
function hash(v: string) {
	return createHash("sha256").update(v).digest("hex");
}
type Encoded =
	| ["null"]
	| ["string", string]
	| ["boolean", boolean]
	| ["number", number | "-0"]
	| ["buffer", number[]]
	| ["view", string, number[], number, number]
	| ["array", Encoded[]]
	| ["object", "plain" | "null", Array<[string, Encoded]>];
const VIEW_TYPES = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
};
function encode(x: unknown, seen = new WeakSet<object>()): Encoded {
	if (x === null) return ["null"];
	if (typeof x === "string") return ["string", x];
	if (typeof x === "boolean") return ["boolean", x];
	if (typeof x === "number" && Number.isFinite(x))
		return ["number", Object.is(x, -0) ? "-0" : x];
	if (typeof x !== "object") fail("unsupported source value");
	if (seen.has(x)) fail("unsupported source reference topology");
	seen.add(x);

	if (x instanceof ArrayBuffer)
		return ["buffer", Array.from(new Uint8Array(x))];
	if (ArrayBuffer.isView(x)) {
		const name = Object.prototype.toString.call(x).slice(8, -1);
		if (name !== "DataView" && !Object.hasOwn(VIEW_TYPES, name))
			fail("unsupported binary type");
		if (!(x.buffer instanceof ArrayBuffer) || seen.has(x.buffer))
			fail("unsupported source reference topology");
		seen.add(x.buffer);
		return [
			"view",
			name,
			Array.from(new Uint8Array(x.buffer)),
			x.byteOffset,
			x.byteLength,
		];
	}
	if (Array.isArray(x)) {
		const keys = Object.keys(x);
		if (
			keys.length !== x.length ||
			keys.some((key, index) => key !== String(index))
		)
			fail("unsupported source array properties");
		return ["array", Array.from(x, (value) => encode(value, seen))];
	}
	const r = record(x);
	if (
		Object.getPrototypeOf(x) !== Object.prototype &&
		Object.getPrototypeOf(x) !== null
	)
		fail("unsupported source object type");
	return [
		"object",
		Object.getPrototypeOf(x) === null ? "null" : "plain",
		Object.keys(r)
			.sort()
			.map<[string, Encoded]>((k) => [k, encode(r[k], seen)]),
	];
}
function decode(encoded: Encoded): unknown {
	switch (encoded[0]) {
		case "null":
			return null;
		case "string":
		case "boolean":
			return encoded[1];
		case "number":
			return encoded[1] === "-0" ? -0 : encoded[1];
		case "array":
			return encoded[1].map(decode);
		case "object":
			return encoded[1] === "null"
				? Object.assign(
						Object.create(null),
						Object.fromEntries(
							encoded[2].map(([key, value]) => [key, decode(value)]),
						),
					)
				: Object.fromEntries(
						encoded[2].map(([key, value]) => [key, decode(value)]),
					);
		case "buffer":
			return Uint8Array.from(encoded[1]).buffer;
		case "view": {
			const buffer = Uint8Array.from(encoded[2]).buffer;
			const offset = encoded[3],
				length = encoded[4];
			if (
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				!Number.isSafeInteger(length) ||
				length < 0 ||
				offset + length > buffer.byteLength
			)
				fail("invalid binary view bounds");
			if (encoded[1] === "DataView")
				return new DataView(buffer, offset, length);
			if (!Object.hasOwn(VIEW_TYPES, encoded[1]))
				fail("unsupported binary type");
			const View = VIEW_TYPES[encoded[1] as keyof typeof VIEW_TYPES];
			return new View(buffer, offset, length / View.BYTES_PER_ELEMENT);
		}
		default:
			fail("invalid persisted encoding");
	}
}
function canonical(v: unknown): string {
	return JSON.stringify(encode(v));
}
function compare(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}

function identity(v: ReplayIdentity): ReplayIdentity {
	const r = exact(
		v,
		v.kind === "workflow" ? ["kind", "binding", "id"] : ["kind", "id"],
	);
	if (!["workflow", "fiber", "fiber_key", "run"].includes(String(r.kind)))
		fail("invalid seal namespace");
	return r.kind === "workflow"
		? { kind: "workflow", binding: text(r.binding), id: text(r.id) }
		: { kind: r.kind as "fiber" | "fiber_key" | "run", id: text(r.id) };
}
function generation(v: unknown): number {
	if (!Number.isSafeInteger(v) || (v as number) < 1) fail("invalid generation");
	return v as number;
}
function digest(v: unknown): string {
	if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) fail("invalid hash");
	return v;
}
/** No constructor DDL, Agent lifecycle, provider calls, accepted claims or source mutations. */
export class HistoricalLiabilityCustody {
	constructor(
		private readonly storage: Pick<
			DurableObjectStorage,
			"sql" | "kv" | "transactionSync"
		>,
		private readonly objectId: string,
	) {
		text(objectId);
	}
	private names() {
		return new Set(
			this.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.toArray()
				.map((r) => r.name),
		);
	}
	private custody(names: Set<string>, generation: number): AdmissionSnapshot {
		if (!names.has("runtime_admission")) fail("missing custody");
		const rows = this.storage.sql
			.exec<{ record: string }>(
				"SELECT record FROM runtime_admission WHERE id=1",
			)
			.toArray();
		if (rows.length !== 1) fail("missing custody");
		let raw: Record<string, unknown>;
		try {
			raw = record(JSON.parse(rows[0]!.record));
		} catch {
			fail("malformed custody");
		}
		const owner = exact(raw.owner, ["tediId", "orgId", "objectId"]);
		if (
			owner.objectId !== this.objectId ||
			(owner.tediId === null) !== (owner.orgId === null)
		)
			fail("physical or tenant custody mismatch");
		const current = new RuntimeAdmission(
			this.storage,
			{
				objectId: this.objectId,
				tediId: owner.tediId === null ? null : text(owner.tediId),
				orgId: owner.orgId === null ? null : text(owner.orgId),
			},
			() => fail("unexpected admission operation"),
		).read();
		if (
			!current ||
			current.state === "active" ||
			current.generation !== generation
		)
			fail("non-active current custody required");
		const stateRows = names.has("cf_agents_state")
			? this.storage.sql
					.exec<{ state: string }>(
						"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
					)
					.toArray()
			: [];
		if (stateRows.length) {
			let s: Record<string, unknown>;
			try {
				s = record(JSON.parse(stateRows[0]!.state));
			} catch {
				fail("malformed tenant state");
			}
			const facet = this.storage.kv.get("cf_agents_is_facet") === true;
			const tenant = facet ? record(s.aigMetadata) : s;
			if (
				(tenant.tediId ?? null) !== current.owner.tediId ||
				(tenant.orgId ?? null) !== current.owner.orgId
			)
				fail("stored tenant custody mismatch");
		} else if (current.owner.tediId !== null) fail("missing tenant state");
		return current;
	}
	private quote(name: string) {
		return `"${name.replaceAll('"', '""')}"`;
	}
	private readRow(table: string, locator: RowLocator): Row {
		const count = this.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM ${this.quote(table)} WHERE ${locator.where}`,
				...locator.values,
			)
			.toArray()[0];
		if (count?.count !== 1) fail("unsupported or ambiguous source locator");
		const cursor = this.storage.sql.exec<Row>(
			`SELECT * FROM ${this.quote(table)} WHERE ${locator.where} LIMIT 1`,
			...locator.values,
		);
		const rows = cursor.toArray();
		if (rows.length !== 1) fail("unsupported or ambiguous source locator");
		return rows[0]!;
	}
	private locators(table: string): RowLocator[] {
		const columns = this.storage.sql
			.exec<{ name: string; pk: number }>(
				`PRAGMA table_info(${this.quote(table)})`,
			)
			.toArray();
		if (!columns.length) fail("unsupported source schema");
		const names = new Set(columns.map((c) => c.name.toLowerCase()));
		let result: RowLocator[] | null = null;
		for (const alias of ["rowid", "_rowid_", "oid"]) {
			if (names.has(alias)) continue;
			try {
				result = this.storage.sql
					.exec<{ locator: string }>(
						`SELECT CAST(${alias} AS TEXT) AS locator FROM ${this.quote(table)}`,
					)
					.toArray()
					.map((r) => ({
						where: `${alias}=CAST(? AS INTEGER)`,
						values: [r.locator],
					}));
				break;
			} catch {
				/* WITHOUT ROWID: use its actual ordered primary-key tuple. */
			}
		}
		if (!result) {
			const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
			if (!pk.length) fail("unsupported source locator");
			// Text casts preserve native 64-bit integer identities; lookup must still be unique.
			const selection = pk
				.flatMap((c, i) => [
					`typeof(${this.quote(c.name)}) AS t${i}`,
					`CAST(${this.quote(c.name)} AS TEXT) AS v${i}`,
				])
				.join(",");
			result = this.storage.sql
				.exec<Row>(`SELECT ${selection} FROM ${this.quote(table)}`)
				.toArray()
				.map((row) => {
					if (
						pk.some(
							(_, i) => !["text", "integer"].includes(String(row[`t${i}`])),
						)
					)
						fail("unsupported source locator");
					return {
						where: pk
							.map(
								(c, i) =>
									`${this.quote(c.name)}=${row[`t${i}`] === "integer" ? "CAST(? AS INTEGER)" : "?"}`,
							)
							.join(" AND "),
						values: pk.map((_, i) => row[`v${i}`]!),
					};
				});
		}
		// Canonical UTF16 order is the archive contract, not native PK/UTF8 order.
		for (const locator of result) this.readRow(table, locator);
		return result.sort((a, b) =>
			compare(
				canonical(this.readRow(table, a)),
				canonical(this.readRow(table, b)),
			),
		);
	}
	private kvKeys(): string[] {
		const keys = new Set<string>();
		for (const prefix of HISTORICAL_CAPTURE_SELECTORS.kvPrefixes) {
			let startAfter: string | undefined;
			for (;;) {
				let found = false;
				for (const [key] of this.storage.kv.list({
					prefix,
					limit: 1,
					...(startAfter === undefined ? {} : { startAfter }),
				})) {
					if (!key.startsWith(prefix) || key === startAfter)
						fail("invalid source KV enumeration");
					found = true;
					startAfter = key;
					keys.add(key);
				}
				if (!found) break;
			}
		}
		for (const key of HISTORICAL_CAPTURE_SELECTORS.kvKeys)
			for (const [stored] of this.storage.kv.list({
				prefix: key,
				start: key,
				end: key + "\0",
				limit: 1,
			})) {
				if (stored !== key) fail("invalid source KV key");
				keys.add(key);
			}
		return Array.from(keys).sort(compare);
	}
	private runLinks(
		keys: string[],
		read: (key: string) => unknown,
		needed: Set<string>,
	) {
		const context = new Map<string, string>(),
			journal = new Map<string, string>();
		for (const key of keys) {
			if (key.startsWith("wfctx:") && needed.has(key.slice(6)))
				context.set(key.slice(6), text(record(read(key)).runId));
			if (key.startsWith("runtime-admission-workflow:")) {
				const value = record(read(key));
				if (!needed.has(value.id as string)) continue;
				const run = text(record(value.params).runId),
					id = text(value.id);
				if (
					key !== `runtime-admission-workflow:${run}` ||
					(journal.has(id) && journal.get(id) !== run)
				)
					fail("conflicting original workflow journal identity");
				journal.set(id, run);
			}
		}
		return { context, journal };
	}
	private rowIdentities(
		table: HistoricalSDKTable,
		row: Row,
		links: ReturnType<HistoricalLiabilityCustody["runLinks"]>,
	) {
		text(row.status);
		const id = text(table === "cf_agents_workflows" ? row.id : row.fiber_id);
		const identities: ReplayIdentity[] =
			table === "cf_agents_workflows"
				? [
						{
							kind: "workflow",
							binding: text(row.workflow_name),
							id: text(row.workflow_id),
						},
					]
				: [{ kind: "fiber", id }];
		if (table === "cf_agents_fibers" && row.idempotency_key !== null)
			identities.push({ kind: "fiber_key", id: text(row.idempotency_key) });
		if (table === "cf_agents_workflows") {
			const workflow = text(row.workflow_id),
				context = links.context.get(workflow),
				journal = links.journal.get(workflow);
			if (context && journal && context !== journal)
				fail("conflicting original run identities");
			if (context || journal)
				identities.push({ kind: "run", id: (context || journal)! });
		}
		return { id, identities };
	}
	private plan(expectedGeneration: number): SourcePlan {
		const names = this.names(),
			custody = this.custody(names, expectedGeneration),
			kv = this.kvKeys();
		const sdkLocators = HISTORICAL_CAPTURE_SELECTORS.sdkTables.map((table) =>
			names.has(table) ? this.locators(table) : [],
		);
		const needed = new Set(
			sdkLocators[0]!.map((locator) =>
				text(this.readRow("cf_agents_workflows", locator).workflow_id),
			),
		);
		const links = this.runLinks(kv, (key) => this.storage.kv.get(key), needed);
		const sql = HISTORICAL_CAPTURE_SELECTORS.factTables
			.filter((t) => names.has(t))
			.map((t) => [t, this.locators(t)] as [string, RowLocator[]]);
		const history = HISTORICAL_CAPTURE_SELECTORS.historyTables
			.filter((t) => names.has(t))
			.map((table) => {
				const rows = this.locators(table);
				const result = writeCanonical(
					new StreamArray(
						function* (this: HistoricalLiabilityCustody) {
							for (const loc of rows) yield this.readRow(table, loc);
						}.bind(this),
					),
				);
				return { table, count: rows.length, hash: result.hash };
			});
		const tables = HISTORICAL_CAPTURE_SELECTORS.sdkTables.map(
			(table, index) => ({
				table,
				present: names.has(table),
				rows: names.has(table)
					? sdkLocators[index]!.map((locator) => ({
							locator,
							...this.rowIdentities(table, this.readRow(table, locator), links),
						}))
					: [],
			}),
		);
		return { custody, kv, sql, history, tables };
	}
	private source(plan: SourcePlan): StreamObject {
		const readRow = this.readRow.bind(this),
			readKV = this.storage.kv.get.bind(this.storage.kv);
		return new StreamObject({
			objectId: this.objectId,
			custody: plan.custody,
			sourceFacts: new StreamObject({
				history: plan.history,
				kv: new StreamArray(function* () {
					for (const key of plan.kv)
						yield [key, new CanonicalKVValue(readKV(key))];
				}),
				sql: new StreamArray(function* () {
					for (const [table, locators] of plan.sql)
						yield new StreamArray(function* () {
							yield table;
							yield new StreamArray(function* () {
								for (const locator of locators) yield readRow(table, locator);
							});
						});
				}),
			}),
			tables: new StreamArray(function* () {
				for (const table of plan.tables)
					yield new StreamObject({
						table: table.table,
						present: table.present,
						rows: new StreamArray(function* () {
							for (const row of table.rows)
								yield new StreamObject({
									table: table.table,
									id: row.id,
									identities: row.identities,
									sdkRow: readRow(table.table, row.locator),
								});
						}),
					});
			}),
		});
	}
	private sealKey(v: ReplayIdentity) {
		return hash(canonical([this.objectId, identity(v)]));
	}
	private links(refs: CompactRef[]) {
		const grouped = new Map<
			string,
			{ key: string; identity: ReplayIdentity; liabilityIds: string[] }
		>();
		for (const ref of refs)
			for (const v of ref.identities) {
				const key = this.sealKey(v);
				let group = grouped.get(key);
				if (!group) {
					group = { key, identity: identity(v), liabilityIds: [] };
					grouped.set(key, group);
				} else if (canonical(group.identity) !== canonical(v))
					fail("identity hash collision");
				group.liabilityIds.push(ref.liabilityId);
			}
		return Array.from(grouped.values())
			.map((g) => ({
				...g,
				liabilityIds: Array.from(new Set(g.liabilityIds)).sort(),
			}))
			.sort((a, b) => compare(a.key, b.key));
	}
	private reference(
		table: HistoricalSDKTable,
		id: string,
		rowHash: string,
		identities: ReplayIdentity[],
		snapshotId: string,
	): CompactRef {
		return {
			liabilityId: hash(canonical([this.objectId, table, id])),
			table,
			id,
			rowHash,
			sourceHash: hash(canonical([snapshotId, rowHash, identities])),
			identities,
		};
	}
	private assembled(
		custody: AdmissionSnapshot,
		sourceHash: string,
		sourceBytes: number,
		counts: number[],
		refs: CompactRef[],
	) {
		const snapshotId = hash(
			canonical([this.objectId, custody.generation, sourceHash]),
		);
		refs.sort((a, b) => compare(a.liabilityId, b.liabilityId));
		if (new Set(refs.map((r) => r.liabilityId)).size !== refs.length)
			fail("duplicate source identity");
		const identities = this.links(refs),
			manifest: CompactManifest = {
				objectId: this.objectId,
				snapshotId,
				sourceHash,
				refs,
				identities,
			};
		const info = writeCanonical(manifest);
		const header: Header = {
			objectId: this.objectId,
			custody,
			snapshotId,
			sourceHash,
			generation: custody.generation,
			workflowCount: counts[0]!,
			fiberCount: counts[1]!,
			identityCount: identities.length,
			manifestHash: info.hash,
			sourceBytes,
			sourceParts: Math.ceil(sourceBytes / CHUNK_BYTES),
			manifestBytes: info.bytes,
			manifestParts: info.parts,
		};
		return { header, manifest };
	}
	private streamBuild(plan: SourcePlan) {
		const info = writeCanonical(this.source(plan)),
			snapshotId = hash(
				canonical([this.objectId, plan.custody.generation, info.hash]),
			);
		const refs = plan.tables.flatMap((table) =>
			table.rows.map((row) =>
				this.reference(
					table.table,
					row.id,
					writeCanonical(this.readRow(table.table, row.locator)).hash,
					row.identities,
					snapshotId,
				),
			),
		);
		return this.assembled(
			plan.custody,
			info.hash,
			info.bytes,
			plan.tables.map((t) => t.rows.length),
			refs,
		);
	}
	private sourceEncoding(source: SourceSnapshot): string {
		const { sourceFacts } = source;
		const stream = new StreamObject({
			objectId: source.objectId,
			custody: source.custody,
			sourceFacts: new StreamObject({
				history: sourceFacts.history,
				sql: sourceFacts.sql,
				kv: new StreamArray(function* () {
					for (const [key, value] of sourceFacts.kv)
						yield [key, new CanonicalKVValue(value)];
				}),
			}),
			tables: source.tables,
		});
		const chunks: Uint8Array[] = [];
		writeCanonical(stream, (chunk) => chunks.push(chunk.slice()));
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			Buffer.concat(chunks),
		);
	}
	private build(source: SourceSnapshot) {
		const encoded = this.sourceEncoding(source),
			sourceHash = hash(encoded),
			snapshotId = hash(
				canonical([this.objectId, source.custody.generation, sourceHash]),
			);
		const refs = source.tables
			.flatMap((t) =>
				t.rows.map((r) => {
					const rowHash = hash(canonical(r.sdkRow)),
						liabilityId = hash(canonical([this.objectId, r.table, r.id]));
					return {
						liabilityId,
						table: r.table,
						id: r.id,
						rowHash,
						sourceHash: hash(canonical([snapshotId, rowHash, r.identities])),
						identities: r.identities,
					};
				}),
			)
			.sort((a, b) => compare(a.liabilityId, b.liabilityId));
		if (new Set(refs.map((r) => r.liabilityId)).size !== refs.length)
			fail("duplicate source identity");
		const identities = this.links(refs);
		// No shared object graph across the canonical manifest: each identity copy is independent.
		const manifest: CompactManifest = {
			objectId: this.objectId,
			snapshotId,
			sourceHash,
			refs,
			identities,
		};
		const manifestEncoded = canonical(manifest);
		const bytes = new TextEncoder().encode(encoded),
			manifestBytes = new TextEncoder().encode(manifestEncoded);
		const header: Header = {
			objectId: this.objectId,
			custody: source.custody,
			snapshotId,
			sourceHash,
			generation: source.custody.generation,
			workflowCount: source.tables[0]!.rows.length,
			fiberCount: source.tables[1]!.rows.length,
			identityCount: identities.length,
			manifestHash: hash(manifestEncoded),
			sourceBytes: bytes.length,
			sourceParts: Math.ceil(bytes.length / CHUNK_BYTES),
			manifestBytes: manifestBytes.length,
			manifestParts: Math.ceil(manifestBytes.length / CHUNK_BYTES),
		};
		return { header, manifest, bytes, manifestBytes };
	}
	private summary(h: Header): SnapshotSummary {
		return {
			snapshotId: h.snapshotId,
			sourceHash: h.sourceHash,
			generation: h.generation,
			workflowCount: h.workflowCount,
			fiberCount: h.fiberCount,
			identityCount: h.identityCount,
		};
	}
	inspectSnapshot(input: SnapshotRequest): SnapshotSummary {
		const r = exact(input, ["expectedGeneration"]);
		return this.storage.transactionSync(() =>
			this.summary(
				this.streamBuild(this.plan(generation(r.expectedGeneration))).header,
			),
		);
	}
	private schema() {
		this.storage.sql.exec(
			`CREATE TABLE ${SNAPSHOT}(id INTEGER PRIMARY KEY CHECK(id=1),header TEXT NOT NULL,header_hash TEXT NOT NULL)`,
		);
		this.storage.sql.exec(
			`CREATE TABLE ${PARTS}(snapshot_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('source','manifest')),part INTEGER NOT NULL,chunk BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(snapshot_id,kind,part))`,
		);
		this.storage.sql.exec(
			`CREATE TABLE ${REFS}(liability_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,ref_hash TEXT NOT NULL)`,
		);
		this.storage.sql.exec(
			`CREATE TABLE ${SEALS}(identity TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,link_hash TEXT NOT NULL)`,
		);
	}
	private header(): Header | null {
		const names = this.names(),
			present = OWNED.filter((t) => names.has(t));
		if (!present.length) return null;
		if (present.length !== OWNED.length) fail("incomplete custody store");
		const rows = this.storage.sql
			.exec<{ header: string; header_hash: string }>(
				`SELECT header,header_hash FROM ${SNAPSHOT}`,
			)
			.toArray();
		if (rows.length !== 1) fail("missing snapshot header");
		const row = rows[0]!;
		if (hash(row.header) !== row.header_hash) fail("tampered snapshot header");
		let h: Header;
		try {
			h = JSON.parse(row.header) as Header;
		} catch {
			fail("malformed snapshot header");
		}
		exact(h, [
			"objectId",
			"custody",
			"snapshotId",
			"sourceHash",
			"generation",
			"workflowCount",
			"fiberCount",
			"identityCount",
			"manifestHash",
			"sourceBytes",
			"sourceParts",
			"manifestBytes",
			"manifestParts",
		]);
		exact(h.custody, ["owner", "state", "generation", "evidence", "reason"]);
		const owner = exact(h.custody.owner, ["objectId", "tediId", "orgId"]);
		if ((owner.tediId === null) !== (owner.orgId === null))
			fail("invalid snapshot custody");
		if (owner.tediId !== null) {
			text(owner.tediId);
			text(owner.orgId);
		}
		if (
			!["held", "quarantined", "retired"].includes(h.custody.state) ||
			(h.custody.evidence !== null && typeof h.custody.evidence !== "string") ||
			(h.custody.reason !== null && typeof h.custody.reason !== "string")
		)
			fail("invalid snapshot custody");
		if (
			h.objectId !== this.objectId ||
			h.custody.owner.objectId !== this.objectId ||
			h.custody.state === "active" ||
			h.custody.generation !== generation(h.generation) ||
			h.snapshotId !==
				hash(canonical([this.objectId, h.generation, digest(h.sourceHash)]))
		)
			fail("invalid snapshot custody");
		for (const count of [h.workflowCount, h.fiberCount, h.identityCount])
			if (!Number.isSafeInteger(count) || count < 0)
				fail("invalid manifest count");
		for (const [bytes, parts] of [
			[h.sourceBytes, h.sourceParts],
			[h.manifestBytes, h.manifestParts],
		])
			if (
				!Number.isSafeInteger(bytes) ||
				bytes! <= 0 ||
				parts !== Math.ceil(bytes! / CHUNK_BYTES)
			)
				fail("invalid part count");
		digest(h.manifestHash);
		return h;
	}
	private parts(
		h: Header,
		kind: "source" | "manifest",
		verifyBytes: boolean,
	): string {
		const expectedCount = kind === "source" ? h.sourceParts : h.manifestParts,
			length = kind === "source" ? h.sourceBytes : h.manifestBytes;
		const rows = this.storage.sql
			.exec<{ part: number; chunk: ArrayBuffer; chunk_hash: string }>(
				`SELECT part,chunk,chunk_hash FROM ${PARTS} WHERE snapshot_id=? AND kind=? ORDER BY part`,
				h.snapshotId,
				kind,
			)
			.toArray();
		if (rows.length !== expectedCount) fail("missing or extra snapshot parts");
		const bytes = verifyBytes ? new Uint8Array(length) : null;
		for (let n = 0; n < rows.length; n++) {
			const row = rows[n]!,
				chunk = new Uint8Array(row.chunk);
			if (
				row.part !== n ||
				chunk.length !== Math.min(CHUNK_BYTES, length - n * CHUNK_BYTES)
			)
				fail("invalid snapshot parts");
			if (bytes) {
				if (createHash("sha256").update(chunk).digest("hex") !== row.chunk_hash)
					fail("tampered snapshot part");
				bytes.set(chunk, n * CHUNK_BYTES);
			}
		}
		if (!bytes) return "";
		let encoded: string;
		try {
			encoded = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes);
		} catch {
			fail("invalid snapshot UTF8");
		}
		if (hash(encoded) !== (kind === "source" ? h.sourceHash : h.manifestHash))
			fail("tampered snapshot payload");
		return encoded;
	}
	private compact(h: Header): CompactManifest {
		const encoded = this.parts(h, "manifest", true);
		let m: CompactManifest;
		try {
			m = decode(JSON.parse(encoded)) as CompactManifest;
		} catch {
			fail("invalid compact manifest");
		}
		if (
			canonical(m) !== encoded ||
			m.objectId !== this.objectId ||
			m.snapshotId !== h.snapshotId ||
			m.sourceHash !== h.sourceHash
		)
			fail("invalid compact manifest");
		exact(m, ["objectId", "snapshotId", "sourceHash", "refs", "identities"]);
		if (
			!Array.isArray(m.refs) ||
			!Array.isArray(m.identities) ||
			m.refs.length !== h.workflowCount + h.fiberCount ||
			m.identities.length !== h.identityCount
		)
			fail("invalid manifest count");
		for (const ref of m.refs) {
			exact(ref, [
				"liabilityId",
				"table",
				"id",
				"rowHash",
				"sourceHash",
				"identities",
			]);
			if (
				!["cf_agents_workflows", "cf_agents_fibers"].includes(ref.table) ||
				ref.liabilityId !==
					hash(canonical([this.objectId, ref.table, text(ref.id)])) ||
				ref.sourceHash !==
					hash(
						canonical([h.snapshotId, digest(ref.rowHash), ref.identities]),
					) ||
				!Array.isArray(ref.identities)
			)
				fail("invalid compact ref");
			for (const v of ref.identities) identity(v);
		}
		if (
			new Set(m.refs.map((r) => r.liabilityId)).size !== m.refs.length ||
			canonical(this.links(m.refs)) !== canonical(m.identities)
		)
			fail("invalid compact identity links");
		const refs = this.storage.sql
			.exec<{ liability_id: string; snapshot_id: string; ref_hash: string }>(
				`SELECT * FROM ${REFS} ORDER BY liability_id`,
			)
			.toArray();
		const seals = this.storage.sql
			.exec<{ identity: string; snapshot_id: string; link_hash: string }>(
				`SELECT * FROM ${SEALS} ORDER BY identity`,
			)
			.toArray();
		if (refs.length !== m.refs.length || seals.length !== m.identities.length)
			fail("missing or extra compact links");
		for (let i = 0; i < refs.length; i++) {
			const ref = m.refs[i]!,
				stored = refs[i]!;
			if (
				stored.liability_id !== ref.liabilityId ||
				stored.snapshot_id !== h.snapshotId ||
				stored.ref_hash !== hash(canonical(ref))
			)
				fail("tampered liability ref");
		}
		for (let i = 0; i < seals.length; i++) {
			const link = m.identities[i]!,
				stored = seals[i]!;
			if (
				stored.identity !== link.key ||
				stored.snapshot_id !== h.snapshotId ||
				stored.link_hash !== hash(canonical(link)) ||
				this.sealKey(link.identity) !== link.key
			)
				fail("tampered replay seals");
		}
		const other = this.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM ${PARTS} WHERE snapshot_id<>? OR kind NOT IN ('source','manifest')`,
				h.snapshotId,
			)
			.toArray()[0]!;
		if (other.count) fail("orphan snapshot parts");
		// Structural private-part existence only. Guard never reads private chunk bytes.
		const sourceParts = this.storage.sql
			.exec<{ part: number; bytes: number }>(
				`SELECT part,length(chunk) AS bytes FROM ${PARTS} WHERE snapshot_id=? AND kind='source' ORDER BY part`,
				h.snapshotId,
			)
			.toArray();
		if (
			sourceParts.length !== h.sourceParts ||
			sourceParts.some(
				(r, i) =>
					r.part !== i ||
					r.bytes !== Math.min(CHUNK_BYTES, h.sourceBytes - i * CHUNK_BYTES),
			)
		)
			fail("missing or extra source parts");
		return m;
	}
	/** Audit/retry retain one logical private value, never the complete source. */
	private verifyFull(
		h: Header,
		m: CompactManifest,
		originalRuns?: string[],
		visitSDKRow?: (table: HistoricalSDKTable, row: Row) => void,
	): void {
		const sql = this.storage.sql,
			sourceDigest = createHash("sha256");
		function* chunks() {
			for (let part = 0; part < h.sourceParts; part++) {
				const rows = sql
					.exec<{ chunk: ArrayBuffer; chunk_hash: string }>(
						`SELECT chunk,chunk_hash FROM ${PARTS} WHERE snapshot_id=? AND kind='source' AND part=?`,
						h.snapshotId,
						part,
					)
					.toArray();
				if (rows.length !== 1) fail("missing snapshot part");
				const bytes = new Uint8Array(rows[0]!.chunk);
				if (
					bytes.length !==
						Math.min(CHUNK_BYTES, h.sourceBytes - part * CHUNK_BYTES) ||
					createHash("sha256").update(bytes).digest("hex") !==
						rows[0]!.chunk_hash
				)
					fail("tampered snapshot part");
				sourceDigest.update(bytes);
				yield bytes;
			}
		}
		const reader = new CanonicalReader({ [Symbol.iterator]: chunks }),
			refs: CompactRef[] = [],
			counts: number[] = [];
		const needed = new Set(
			m.refs.flatMap((r) =>
				r.identities.filter((v) => v.kind === "workflow").map((v) => v.id),
			),
		);
		const links = {
			context: new Map<string, string>(),
			journal: new Map<string, string>(),
		};
		let custody: AdmissionSnapshot | null = null;
		reader.object(
			(key) => {
				if (key === "custody") {
					custody = reader.value() as AdmissionSnapshot;
					if (canonical(custody) !== canonical(h.custody))
						fail("tampered source binding");
				} else if (key === "objectId") {
					if (reader.value() !== this.objectId) fail("tampered source binding");
				} else if (key === "sourceFacts") {
					reader.object(
						(field) => {
							if (field === "history") {
								let previous = -1;
								reader.array(() => {
									const value = exact(reader.value(), [
											"table",
											"count",
											"hash",
										]),
										index = (
											HISTORICAL_CAPTURE_SELECTORS.historyTables as readonly string[]
										).indexOf(String(value.table));
									if (
										index <= previous ||
										!Number.isSafeInteger(value.count) ||
										(value.count as number) < 0
									)
										fail("invalid history facts");
									previous = index;
									digest(value.hash);
								});
							} else if (field === "kv") {
								let previous: string | null = null;
								reader.array(() => {
									let key = "";
									const count = reader.array((i) => {
										if (i === 0) {
											key = text(reader.value());
											if (
												(previous !== null && key <= previous) ||
												(!(
													HISTORICAL_CAPTURE_SELECTORS.kvKeys as readonly string[]
												).includes(key) &&
													!HISTORICAL_CAPTURE_SELECTORS.kvPrefixes.some((p) =>
														key.startsWith(p),
													))
											)
												fail("invalid source KV key");
											previous = key;
										} else if (i === 1) {
											const value = reader.value(true);
											if (key.startsWith("wfctx:") && needed.has(key.slice(6)))
												links.context.set(
													key.slice(6),
													text(record(value).runId),
												);
											if (key.startsWith("runtime-admission-workflow:")) {
												const r = record(value);
												if (needed.has(r.id as string)) {
													const id = text(r.id),
														run = text(record(r.params).runId);
													if (
														key !== `runtime-admission-workflow:${run}` ||
														(links.journal.has(id) &&
															links.journal.get(id) !== run)
													)
														fail(
															"conflicting original workflow journal identity",
														);
													links.journal.set(id, run);
												}
											}
										} else fail("invalid source KV fields");
									});
									if (count !== 2) fail("invalid source KV fields");
								});
							} else {
								let previous = -1;
								reader.array(() => {
									let priorRow: string | null = null;
									let sourceTable = "";
									const count = reader.array((i) => {
										if (i === 0) {
											const table = text(reader.value()),
												index = (
													HISTORICAL_CAPTURE_SELECTORS.factTables as readonly string[]
												).indexOf(table);
											if (index <= previous) fail("invalid source SQL table");
											previous = index;
											sourceTable = table;
										} else if (i === 1)
											reader.array(() => {
												const row = record(reader.value()),
													encoded = canonical(row);
												if (priorRow !== null && encoded < priorRow)
													fail("invalid source row order");
												priorRow = encoded;
												if (sourceTable === "cf_agents_runs")
													originalRuns?.push(text(row.id));
											});
										else fail("invalid source SQL fields");
									});
									if (count !== 2) fail("invalid source SQL fields");
								});
							}
						},
						["history", "kv", "sql"],
					);
				} else {
					const tables = reader.array((index) => {
						const table = HISTORICAL_CAPTURE_SELECTORS.sdkTables[index];
						if (!table) fail("invalid SDK tables");
						let present = false,
							count = 0,
							prior: string | null = null;
						reader.object(
							(field) => {
								if (field === "present") {
									const value = reader.value();
									if (typeof value !== "boolean") fail("invalid SDK presence");
									present = value;
								} else if (field === "table") {
									if (reader.value() !== table) fail("invalid SDK table");
								} else
									count = reader.array(() => {
										let id = "",
											identities: ReplayIdentity[] = [],
											row: Row | null = null;
										reader.object(
											(name) => {
												if (name === "id") id = text(reader.value());
												else if (name === "identities") {
													identities = reader.value() as ReplayIdentity[];
													if (!Array.isArray(identities))
														fail("invalid source identities");
													for (const value of identities) identity(value);
												} else if (name === "sdkRow")
													row = record(reader.value()) as Row;
												else if (reader.value() !== table)
													fail("invalid SDK row table");
											},
											["id", "identities", "sdkRow", "table"],
										);
										if (!row) fail("missing SDK row");
										const expected = this.rowIdentities(table, row, links),
											encoded = canonical(row);
										if (
											expected.id !== id ||
											canonical(expected.identities) !==
												canonical(identities) ||
											(prior !== null && encoded < prior)
										)
											fail("tampered source identities");
										prior = encoded;
										visitSDKRow?.(table, row);
										refs.push(
											this.reference(
												table,
												id,
												hash(encoded),
												identities,
												h.snapshotId,
											),
										);
									});
							},
							["present", "rows", "table"],
						);
						if (!present && count) fail("invalid SDK presence");
						counts.push(count);
					});
					if (tables !== HISTORICAL_CAPTURE_SELECTORS.sdkTables.length)
						fail("invalid SDK tables");
				}
			},
			["custody", "objectId", "sourceFacts", "tables"],
		);
		reader.finish();
		if (sourceDigest.digest("hex") !== h.sourceHash || !custody)
			fail("tampered snapshot payload");
		const rebuilt = this.assembled(
			custody,
			h.sourceHash,
			h.sourceBytes,
			counts,
			refs,
		);
		if (
			canonical(rebuilt.header) !== canonical(h) ||
			canonical(rebuilt.manifest) !== canonical(m)
		)
			fail("tampered source binding");
	}
	private full(h: Header, m: CompactManifest): SourceSnapshot {
		const encoded = this.parts(h, "source", true);
		let source: SourceSnapshot;
		try {
			const reader = new CanonicalReader([new TextEncoder().encode(encoded)]);
			const decoded: Record<string, unknown> = {};
			reader.object(
				(key) => {
					if (key === "sourceFacts") {
						const facts: Record<string, unknown> = {};
						reader.object(
							(field) => {
								if (field === "kv") {
									const values: Array<[string, unknown]> = [];
									reader.array(() => {
										let name = "",
											value: unknown;
										const count = reader.array((index) => {
											if (index === 0) name = text(reader.value());
											else if (index === 1) value = reader.value(true);
											else fail("invalid source KV fields");
										});
										if (count !== 2) fail("invalid source KV fields");
										values.push([name, value]);
									});
									facts[field] = values;
								} else facts[field] = reader.value();
							},
							["history", "kv", "sql"],
						);
						decoded[key] = facts;
					} else decoded[key] = reader.value();
				},
				["custody", "objectId", "sourceFacts", "tables"],
			);
			source = decoded as unknown as SourceSnapshot;
			reader.finish();
		} catch {
			fail("invalid source payload");
		}
		if (this.sourceEncoding(source) !== encoded)
			fail("noncanonical source payload");
		const rebuilt = this.build(source);
		if (
			canonical(rebuilt.header) !== canonical(h) ||
			canonical(rebuilt.manifest) !== canonical(m)
		)
			fail("tampered source binding");
		return source;
	}
	captureSnapshot(
		input: SnapshotRequest & { expectedSourceHash: string },
	): SnapshotSummary {
		const r = exact(input, ["expectedGeneration", "expectedSourceHash"]),
			expected = digest(r.expectedSourceHash);
		return this.storage.transactionSync(() => {
			const plan = this.plan(generation(r.expectedGeneration));
			const next = this.streamBuild(plan);
			if (next.header.sourceHash !== expected) fail("source changed");
			const existing = this.header();
			if (existing) {
				const m = this.compact(existing);
				this.verifyFull(existing, m);
				if (canonical(existing) !== canonical(next.header))
					fail("immutable snapshot conflict");
				return this.summary(existing);
			}
			this.schema();
			const h = next.header,
				json = JSON.stringify(h);
			this.storage.sql.exec(
				`INSERT INTO ${SNAPSHOT} VALUES (1,?,?)`,
				json,
				hash(json),
			);
			for (const [kind, value] of [
				["source", this.source(plan)],
				["manifest", next.manifest],
			] as const) {
				const info = writeCanonical(value, (chunk, n) =>
					this.storage.sql.exec(
						`INSERT INTO ${PARTS} VALUES (?,?,?,?,?)`,
						h.snapshotId,
						kind,
						n,
						chunk.slice().buffer,
						createHash("sha256").update(chunk).digest("hex"),
					),
				);
				if (
					info.hash !== (kind === "source" ? h.sourceHash : h.manifestHash) ||
					info.bytes !== (kind === "source" ? h.sourceBytes : h.manifestBytes)
				)
					fail("source changed during capture");
			}
			for (const ref of next.manifest.refs)
				this.storage.sql.exec(
					`INSERT INTO ${REFS} VALUES (?,?,?)`,
					ref.liabilityId,
					h.snapshotId,
					hash(canonical(ref)),
				);
			for (const link of next.manifest.identities)
				this.storage.sql.exec(
					`INSERT INTO ${SEALS} VALUES (?,?,?)`,
					link.key,
					h.snapshotId,
					hash(canonical(link)),
				);
			// Last-write source recheck is a null-sink integrity pass, not a second archive or cached proof.
			if (
				canonical(this.streamBuild(this.plan(h.generation)).header) !==
				canonical(h)
			)
				fail("source or custody changed during capture");
			return this.summary(h);
		});
	}
	/** Exact private original workflow fact, fully audited; never accepted-claim or provider attestation authority. */
	retainedWorkflowRow(input: {
		expectedGeneration: number;
		snapshotId: string;
		sourceHash: string;
		workflowId: string;
		binding: string;
	}): Row | null {
		const r = exact(input, [
				"expectedGeneration",
				"snapshotId",
				"sourceHash",
				"workflowId",
				"binding",
			]),
			expected = generation(r.expectedGeneration),
			snapshotId = digest(r.snapshotId),
			sourceHash = digest(r.sourceHash),
			workflowId = text(r.workflowId),
			binding = text(r.binding);
		return this.storage.transactionSync(() => {
			const h = this.header();
			if (
				!h ||
				h.snapshotId !== snapshotId ||
				h.sourceHash !== sourceHash ||
				h.generation !== expected
			)
				fail("retained workflow archive pin mismatch");
			const custody = this.custody(this.names(), expected);
			if (
				!custody.owner.tediId ||
				!custody.owner.orgId ||
				canonical(custody) !== canonical(h.custody)
			)
				fail("retained workflow custody mismatch");
			const m = this.compact(h);
			const matches = (table: HistoricalSDKTable, row: Row) =>
				table === "cf_agents_workflows" &&
				row.workflow_id === workflowId &&
				row.workflow_name === binding;
			let count = 0;
			this.verifyFull(h, m, undefined, (table, row) => {
				if (matches(table, row)) count++;
			});
			if (count > 1) fail("conflicting retained workflow");
			let found: Row | null = null;
			if (count === 1) {
				// Audit first without retaining a private row. Stop the bounded second lookup at its selected item.
				const stop = new Error("internal retained row found");
				try {
					this.verifyFull(h, m, undefined, (table, row) => {
						if (matches(table, row)) {
							found = row;
							throw stop;
						}
					});
				} catch (error) {
					if (error !== stop) throw error;
				}
				if (!found) fail("retained workflow disappeared");
			}

			if (
				canonical(this.custody(this.names(), expected)) !== canonical(h.custody)
			)
				fail("retained workflow custody mismatch");
			return found;
		});
	}
	/** Canonical projection of immutable archive bytes, omitting only the three tracking row arrays. */
	private retiredArchiveSourceHash(h: Header): string {
		const sql = this.storage.sql;
		const reader = new CanonicalReader({
			*[Symbol.iterator]() {
				for (let part = 0; part < h.sourceParts; part++) {
					const row = sql
						.exec<{ chunk: ArrayBuffer; chunk_hash: string }>(
							`SELECT chunk,chunk_hash FROM ${PARTS} WHERE snapshot_id=? AND kind='source' AND part=?`,
							h.snapshotId,
							part,
						)
						.toArray()[0];
					if (
						!row ||
						createHash("sha256")
							.update(new Uint8Array(row.chunk))
							.digest("hex") !== row.chunk_hash
					)
						fail("tampered snapshot part");
					yield new Uint8Array(row.chunk);
				}
			},
		});
		const digest = createHash("sha256"),
			emit = (text: string) => {
				digest.update(text);
			},
			value = () => emit(canonical(reader.value()));
		const object = (visit: (key: string) => void, keys: string[]) => {
			emit('["object","plain",[');
			let first = true;
			reader.object((key) => {
				if (!first) emit(",");
				first = false;
				emit("[" + JSON.stringify(key) + ",");
				visit(key);
				emit("]");
			}, keys);
			emit("]]");
		};
		const array = (visit: (index: number) => void) => {
			emit('["array",[');
			reader.array((index) => {
				if (index) emit(",");
				visit(index);
			});
			emit("]]");
		};
		object(
			(key) => {
				if (key === "sourceFacts")
					object(
						(field) => {
							if (field === "sql")
								array(() => {
									let table = "";
									array((index) => {
										if (index === 0) {
											table = text(reader.value());
											emit(canonical(table));
										} else if (table === "cf_agents_runs") {
											reader.array(() => {
												reader.value();
											});
											emit('["array",[]]');
										} else array(() => value());
									});
								});
							else if (field === "kv")
								array(() => {
									array((index) => {
										if (index === 0) value();
										else if (index === 1) {
											const item = reader.value(true);
											writeCanonical(new CanonicalKVValue(item), (chunk) =>
												digest.update(chunk),
											);
										} else fail("invalid source KV fields");
									});
								});
							else array(() => value());
						},
						["history", "kv", "sql"],
					);
				else if (key === "tables")
					array(() =>
						object(
							(field) => {
								if (field === "rows") {
									reader.array(() => {
										reader.value();
									});
									emit('["array",[]]');
								} else value();
							},
							["present", "rows", "table"],
						),
					);
				else value();
			},
			["custody", "objectId", "sourceFacts", "tables"],
		);
		reader.finish();
		return digest.digest("hex");
	}
	/** Full streaming archive/source proof; this grants no execution or settlement authority. */
	trackingRetirementProof(input: {
		expectedGeneration: number;
		snapshotId: string;
		sourceHash: string;
		expectedCurrentSourceHash?: string;
	}) {
		return this.storage.transactionSync(() => {
			const h = this.header();
			if (
				!h ||
				h.snapshotId !== digest(input.snapshotId) ||
				h.sourceHash !== digest(input.sourceHash) ||
				h.generation !== generation(input.expectedGeneration)
			)
				fail("retirement archive pin mismatch");
			const m = this.compact(h),
				runs: string[] = [];
			this.verifyFull(h, m, runs);
			for (const id of runs)
				if (
					!m.identities.some(
						(group) =>
							group.identity.kind === "fiber" && group.identity.id === id,
					)
				)
					fail("unsealed original executor");
			const original = {
				workflows: m.refs
					.filter((ref) => ref.table === "cf_agents_workflows")
					.map((ref) => ref.id),
				fibers: m.refs
					.filter((ref) => ref.table === "cf_agents_fibers")
					.map((ref) => ref.id),
				runs,
			};
			const plan = this.plan(h.generation);
			if (
				!plan.custody.owner.tediId ||
				!plan.custody.owner.orgId ||
				canonical(plan.custody) !== canonical(h.custody)
			)
				fail("retirement custody mismatch");
			const current = this.streamBuild(plan).header;
			if (
				current.sourceHash !==
				(input.expectedCurrentSourceHash === undefined
					? h.sourceHash
					: digest(input.expectedCurrentSourceHash))
			)
				fail("retirement source mismatch");
			const projectedHash = this.retiredArchiveSourceHash(h);
			if (
				input.expectedCurrentSourceHash !== undefined &&
				input.expectedCurrentSourceHash !== projectedHash
			)
				fail("retirement projection mismatch");
			if (input.expectedCurrentSourceHash !== undefined)
				return {
					...this.summary(h),
					currentSourceHash: current.sourceHash,
					...original,
					postRetirementSourceHash: current.sourceHash,
				};
			if (canonical(current) !== canonical(h))
				fail("retirement row set mismatch");
			const post: SourcePlan = {
				...plan,
				sql: plan.sql.map(([name, rows]) => [
					name,
					name === "cf_agents_runs" ? [] : rows,
				]),
				tables: plan.tables.map((table) => ({ ...table, rows: [] })),
			};
			if (this.streamBuild(post).header.sourceHash !== projectedHash)
				fail("retirement projection mismatch");
			return {
				...this.summary(h),
				currentSourceHash: current.sourceHash,
				...original,
				postRetirementSourceHash: projectedHash,
			};
		});
	}
	audit(): SnapshotSummary | null {
		return this.storage.transactionSync(() => {
			const h = this.header();
			if (!h) return null;
			const m = this.compact(h);
			this.verifyFull(h, m);
			return this.summary(h);
		});
	}
	read(input: { liabilityId: string }): HistoricalLiability | null {
		const r = exact(input, ["liabilityId"]),
			id = digest(r.liabilityId);
		return this.storage.transactionSync(() => {
			const h = this.header();
			if (!h) return null;
			const m = this.compact(h),
				source = this.full(h, m),
				ref = m.refs.find((v) => v.liabilityId === id);
			if (!ref) return null;
			const entry = source.tables
				.find((t) => t.table === ref.table)
				?.rows.find((v) => v.id === ref.id);
			if (!entry) fail("missing original row");
			const facts = source.sourceFacts;
			return {
				version: 1,
				liabilityId: id,
				objectId: this.objectId,
				custody: source.custody,
				ownerUnknown: source.custody.owner.tediId === null,
				source: {
					table: ref.table,
					id: ref.id,
					expectedGeneration: h.generation,
				},
				sourceHash: ref.sourceHash,
				sdkRow: entry.sdkRow,
				sourceFacts: facts,
				identities: entry.identities,
				disposition: "unknown",
				exposure: {
					providerUsage: "unknown",
					reservationCoverage: "unknown",
					externalEffects: "unknown",
					ledgerDelivery: "unknown",
					observation: "stored_facts_only",
					inventoryScope: "fixed_whitelist_partial",
					estimatesAreBounds: false,
					financialFacts: facts.sql.some(
						([t, rows]) => t.startsWith("inference_") && rows.length,
					)
						? "observed"
						: "not_observed",
					effectFacts:
						facts.kv.some(([k]) =>
							[
								"facet-dispatch-call:",
								"computer-effect:",
								"computer-environment:",
								"computer-continuation:",
								"ledger-outbox:",
								"ledger-delivery-blocked:",
								"tedix:pi:telegram:reply:",
							].some((p) => k.startsWith(p)),
						) ||
						facts.sql.some(
							([t, rows]) => t === "cf_agent_tool_runs" && rows.length,
						)
							? "observed"
							: "not_observed",
				},
			};
		});
	}
	/** Presence and lazy identity collection use one current compact proof, never private bytes. */
	hasSnapshot(): boolean {
		return this.assertNotSealedAll([]);
	}
	assertNotSealed(v: ReplayIdentity): void {
		this.assertNotSealedAll([v]);
	}
	assertNotSealedAll(
		values: ReplayIdentity[] | (() => ReplayIdentity[]),
	): boolean {
		const immediate =
			typeof values === "function"
				? null
				: new Set(values.map((v) => this.sealKey(v)));
		return this.storage.transactionSync(() => {
			const h = this.header();
			if (!h) return false;
			const m = this.compact(h);
			const keys =
				immediate ??
				new Set(
					(values as () => ReplayIdentity[])().map((v) => this.sealKey(v)),
				);
			if (m.identities.some((link) => keys.has(link.key)))
				fail("historical identity permanently sealed");
			return true;
		});
	}
}
