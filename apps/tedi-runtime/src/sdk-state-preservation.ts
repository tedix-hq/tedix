import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	encryptTediSecret,
	decryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import {
	SdkPreservationTableNames,
	SdkPreservationSummarySchema,
} from "@tedix/api-contract/schemas/tedi";
import {
	NativeStatePreservation,
	NativePreservationIntentSchema,
} from "./native-state-preservation";
import {
	SessionStatePreservation,
	SessionPreservationIntentSchema,
} from "./session-state-preservation";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import {
	streamSqlTable,
	sourceDescriptor,
	encodePrivateKvValue,
	presentSqlTable,
} from "./preservation-source-stream";
const FORMAT = "sdk-work-state-archive-v1" as const,
	PURPOSE = "sdk-work-state-preservation-plan-v1" as const;
const SNAPSHOT = "sdk_work_preservation_snapshot",
	PARTS = "sdk_work_preservation_parts",
	PART_BYTES = 1_000_000,
	PROOF_BYTES = 131_072,
	TTL = 300_000;
const SELECTOR =
	"420335a11e49b81134025035a54fc9cda5b6b1bec4dd2b276f3766531651e242";
const OLD = [
	"historical_custody_snapshot",
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
	"native_preservation_snapshot",
	"native_preservation_parts",
	"session_preservation_snapshot",
	"session_preservation_parts",
] as const;
const DDL = {
	[SNAPSHOT]: `CREATE TABLE ${SNAPSHOT}(id INTEGER PRIMARY KEY CHECK(id=1),header TEXT NOT NULL,header_hash TEXT NOT NULL)`,
	[PARTS]: `CREATE TABLE ${PARTS}(archive_id TEXT NOT NULL,part INTEGER NOT NULL,chunk BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(archive_id,part))`,
};
type Storage = Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
const refuse = (): never => {
		throw Error("SDK preservation verification rejected");
	},
	digest = (v: string | Uint8Array) =>
		createHash("sha256").update(v).digest("hex"),
	quote = (s: string) => '"' + s.replaceAll('"', '""') + '"',
	eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const count = z.number().int().nonnegative().safe(),
	hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SdkPreservationIntentSchema = NativePreservationIntentSchema.omit({
	kind: true,
}).extend({ kind: z.literal("sdk-work-preservation-capture-v1") });
export type SdkPreservationIntent = z.infer<typeof SdkPreservationIntentSchema>;
const Metadata = SdkPreservationSummarySchema.shape.metadata,
	Prior = SdkPreservationSummarySchema.shape.priorArchives;
const Header = z.strictObject({
	format: z.literal(FORMAT),
	archiveId: z.string().uuid(),
	selectorVersion: z.literal(SELECTOR),
	intent: SdkPreservationIntentSchema,
	sourceHash: hash,
	priorHash: hash,
	schemaHash: hash,
	priorArchives: Prior,
	metadata: Metadata,
	metadataDigest: hash,
	parts: count,
	partBytes: count,
});
const Proof = z.strictObject({
		purpose: z.literal(PURPOSE),
		issuedAt: count,
		expiresAt: count,
		header: Header,
	}),
	Stored = Header.extend({ planProof: z.string().min(1).max(PROOF_BYTES) });
type Header = z.infer<typeof Header>;
const blob = (v: unknown) =>
	v instanceof ArrayBuffer
		? new Uint8Array(v)
		: v instanceof Uint8Array
			? v
			: refuse();
function one<T extends Record<string, SqlStorageValue>>(
	s: Storage,
	q: string,
	...a: SqlStorageValue[]
): T {
	const it = s.sql.exec<T>(q, ...a)[Symbol.iterator](),
		r = it.next();
	if (r.done || !it.next().done) return refuse();
	return r.value;
}
function priority(f: () => void) {
	let failed = false,
		first: unknown;
	return () => {
		try {
			f();
		} catch (e) {
			if (!failed) {
				failed = true;
				first = e;
			}
		}
		if (failed) throw first;
	};
}
async function checked<T>(p: Promise<T>, pins: () => void): Promise<T> {
	try {
		return await p;
	} finally {
		pins();
	}
}
// One request-local result fence; nested operations never replace each other's pins.
function sdkOperation<T>(
	initial: () => void,
	work: (
		update: (guard: () => void) => void,
		ready: (guard: () => void) => void,
	) => Promise<T>,
) {
	let current = initial,
		prepared = false;
	const assertContinuity = priority(() => current());
	const result = work(
		(guard) => {
			current = guard;
		},
		(guard) => {
			current = guard;
			prepared = true;
		},
	);
	return {
		result,
		assertContinuity,
		assertReady: () => {
			assertContinuity();
			if (!prepared) return refuse();
		},
	};
}
/** Fixed selected SQL plus complete supported KV; no lifecycle, alarm or restoration capability. */
export class SdkStatePreservation {
	private readonly intent: SdkPreservationIntent;
	constructor(
		private readonly storage: Storage,
		intent: SdkPreservationIntent,
		private readonly recheck: () => void,
		private readonly verifyCanonical: () => Promise<void>,
	) {
		this.intent = SdkPreservationIntentSchema.parse(intent);
	}
	private preflight() {
		this.recheck();
		// Refuse oversized schema before selected table frames or PRAGMA defaults can materialize it.
		for (const r of this.storage.sql.exec<{ kind: string; bytes: number }>(
			"SELECT typeof(sql) AS kind,length(CAST(sql AS BLOB)) AS bytes FROM sqlite_master",
		))
			if (
				r.kind !== "null" &&
				(r.kind !== "text" || !Number.isSafeInteger(r.bytes) || r.bytes > 65536)
			)
				return refuse();
		const selected = new Set<string>(SdkPreservationTableNames),
			ordinary = new Set<string>(SdkPreservationTableNames.slice(0, 25)),
			reserved = new Set<string>([...OLD, SNAPSHOT, PARTS]);
		for (const r of this.storage.sql.exec<{ name: string; type: string }>(
			"SELECT name,type FROM sqlite_master ORDER BY name COLLATE BINARY",
		)) {
			if (
				reserved.has(r.name.toLowerCase()) &&
				(r.name !== r.name.toLowerCase() || r.type !== "table")
			)
				return refuse();
			if (
				!selected.has(r.name.toLowerCase()) ||
				!(r.type === "table" || r.type === "view")
			)
				continue;
			if (r.name !== r.name.toLowerCase()) return refuse();
			if (!ordinary.has(r.name) || r.type !== "table") return refuse();
			let table = false;
			for (const x of this.storage.sql.exec<{ name: string; type: string }>(
				"PRAGMA table_list",
			))
				if (x.name === r.name) {
					if (x.type !== "table") return refuse();
					table = true;
				}
			if (!table) return refuse();
			for (const c of this.storage.sql.exec<{ hidden: number }>(
				`PRAGMA table_xinfo(${quote(r.name)})`,
			))
				if (c.hidden !== 0) return refuse();
		}
	}
	private schemaPin() {
		const h = createHash("sha256");
		for (const probe of this.storage.sql.exec<{
			type: string;
			name: string;
			kind: string;
			bytes: number;
		}>(
			"SELECT type,name,typeof(sql) AS kind,length(CAST(sql AS BLOB)) AS bytes FROM sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY",
		)) {
			if (
				probe.kind !== "null" &&
				(probe.kind !== "text" ||
					!Number.isSafeInteger(probe.bytes) ||
					probe.bytes > 65536)
			)
				return refuse();
			const row = one(
				this.storage,
				"SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE type=? AND name=?",
				probe.type,
				probe.name,
			);
			if (row.tbl_name === SNAPSHOT || row.tbl_name === PARTS) continue;
			h.update(sourceDescriptor(["schema-inventory", row], refuse));
		}
		return h.digest("hex");
	}
	private ownerUnknown() {
		if (!presentSqlTable(this.storage, "cf_agents_state")) return true;
		const rows = [
			...this.storage.sql.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			),
		];
		if (!rows.length) return true;
		if (rows.length !== 1) return refuse();
		const state = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(rows[0]!.state));
		const m =
			state.aigMetadata === null || state.aigMetadata === undefined
				? state
				: z.record(z.string(), z.unknown()).parse(state.aigMetadata);
		return (
			m.tediId === null ||
			m.tediId === undefined ||
			m.orgId === null ||
			m.orgId === undefined
		);
	}
	private *kvFrames() {
		let last: string | undefined;
		for (;;) {
			const rows = [
				...this.storage.kv.list({
					limit: 1,
					...(last === undefined ? {} : { startAfter: last }),
				}),
			];
			if (rows.length === 0) return;
			if (rows.length !== 1) return refuse();
			const [key, value] = rows[0]!;
			if (
				last !== undefined &&
				Buffer.compare(Buffer.from(last), Buffer.from(key)) >= 0
			)
				return refuse();
			last = key;
			const encoded = encodePrivateKvValue(value, refuse),
				description = sourceDescriptor(["kv", key, encoded.byteLength], refuse);
			if (encoded.byteLength + description.byteLength > PART_BYTES)
				return refuse();
			yield description;
			yield encoded;
		}
	}
	private scan(write?: (part: number, chunk: Uint8Array) => void) {
		this.preflight();
		const metadata: z.infer<typeof Metadata> = {
				tables: [],
				kvEntries: 0,
				sourceBytes: 0,
				recordCount: 0,
				localOwnerUnknown: this.ownerUnknown(),
			},
			h = createHash("sha256");
		let part = 0,
			used = 0;
		const buffer = write ? new Uint8Array(PART_BYTES) : null;
		const feed = (frame: Uint8Array) => {
			h.update(frame);
			metadata.sourceBytes = count.parse(
				metadata.sourceBytes + frame.byteLength,
			);
			metadata.recordCount = count.parse(metadata.recordCount + 1);
			if (!write) return;
			let at = 0;
			while (at < frame.byteLength) {
				const n = Math.min(frame.byteLength - at, PART_BYTES - used);
				buffer!.set(frame.subarray(at, at + n), used);
				used += n;
				at += n;
				if (used === PART_BYTES) {
					write(part++, buffer!.slice());
					used = 0;
				}
			}
		};
		feed(
			sourceDescriptor(
				["format", FORMAT, "selector", SELECTOR, "intent", this.intent],
				refuse,
			),
		);
		for (const table of SdkPreservationTableNames) {
			const present = presentSqlTable(this.storage, table);
			const rows = present
				? count.parse(
						one<{ n: number }>(
							this.storage,
							`SELECT count(*) AS n FROM ${quote(table)}`,
						).n,
					)
				: 0;
			metadata.tables.push({
				table,
				present,
				rows,
				schema: present ? "unknown" : "absent",
			});
			for (const frame of streamSqlTable(this.storage, table, refuse))
				feed(frame);
		}
		for (const frame of this.kvFrames()) {
			if (
				frame[0] === 91 &&
				Buffer.from(frame).subarray(0, 6).toString() === '["kv",'
			)
				metadata.kvEntries = count.parse(metadata.kvEntries + 1);
			feed(frame);
		}
		if (write && used) write(part++, buffer!.slice(0, used));
		this.recheck();
		return {
			sourceHash: h.digest("hex"),
			metadata: Metadata.parse(metadata),
			parts: part,
		};
	}
	private priorPin() {
		const h = createHash("sha256");
		for (const t of OLD)
			for (const f of streamSqlTable(this.storage, t, refuse)) h.update(f);
		const present = (i: number) => presentSqlTable(this.storage, OLD[i]!);
		if (
			present(0) !== present(1) ||
			present(4) !== present(5) ||
			present(6) !== present(7) ||
			(!present(0) && (present(2) || present(3)))
		)
			return refuse();
		return {
			priorHash: h.digest("hex"),
			priorArchives: Prior.parse({
				historical: present(0) ? "present" : "absent",
				native: present(4) ? "present" : "absent",
				session: present(6) ? "present" : "absent",
			}),
		};
	}
	private store() {
		const a = presentSqlTable(this.storage, SNAPSHOT),
			b = presentSqlTable(this.storage, PARTS);
		if (a !== b) return refuse();
		if (!a) {
			for (const r of this.storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE name IN (?,?)",
				SNAPSHOT,
				PARTS,
			))
				if (r) return refuse();
			return false;
		}
		for (const t of [SNAPSHOT, PARTS]) {
			const objects = [
				...this.storage.sql.exec<{
					type: string;
					name: string;
					sql: string | null;
				}>(
					"SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name",
					t,
				),
			];
			if (
				objects.filter((x) => x.type === "table").length !== 1 ||
				objects.find((x) => x.type === "table")!.sql !==
					DDL[t as keyof typeof DDL] ||
				objects.some(
					(x) =>
						x.type !== "table" &&
						!(
							t === PARTS &&
							x.type === "index" &&
							x.name === `sqlite_autoindex_${PARTS}_1` &&
							x.sql === null
						),
				)
			)
				return refuse();
		}
		return true;
	}
	private header(operation = true) {
		if (!this.store()) return null;
		const size = one<{ kind: string; bytes: number; hk: string; hb: number }>(
			this.storage,
			`SELECT typeof(header) AS kind,length(CAST(header AS BLOB)) AS bytes,typeof(header_hash) AS hk,length(CAST(header_hash AS BLOB)) AS hb FROM ${SNAPSHOT}`,
		);
		if (
			size.kind !== "text" ||
			!Number.isSafeInteger(size.bytes) ||
			size.bytes < 1 ||
			size.bytes > PROOF_BYTES + 65536 ||
			size.hk !== "text" ||
			size.hb !== 64
		)
			return refuse();
		const r = one<{ header: string; header_hash: string }>(
			this.storage,
			`SELECT header,header_hash FROM ${SNAPSHOT}`,
		);
		if (digest(r.header) !== r.header_hash) return refuse();
		const h = Stored.parse(JSON.parse(r.header));
		if (
			!eq(
				h.intent,
				operation
					? this.intent
					: { ...this.intent, operationId: h.intent.operationId },
			) ||
			h.metadataDigest !== digest(JSON.stringify(h.metadata))
		)
			return refuse();
		return h;
	}
	private parts(h: Header) {
		let n = 0,
			total = 0;
		const all = createHash("sha256");
		for (const r of this.storage.sql.exec<{
			archive_id: string;
			ib: number;
			part: number;
			pk: string;
			kind: string;
			bytes: number;
			chunk_hash: string;
			hb: number;
		}>(
			`SELECT substr(archive_id,1,37) AS archive_id,length(CAST(archive_id AS BLOB)) AS ib,part,typeof(part) AS pk,typeof(chunk) AS kind,length(CAST(chunk AS BLOB)) AS bytes,substr(chunk_hash,1,65) AS chunk_hash,length(CAST(chunk_hash AS BLOB)) AS hb FROM ${PARTS} ORDER BY archive_id,part`,
		)) {
			if (
				r.archive_id !== h.archiveId ||
				r.ib !== 36 ||
				r.pk !== "integer" ||
				r.part !== n++ ||
				r.kind !== "blob" ||
				!Number.isSafeInteger(r.bytes) ||
				r.bytes < 1 ||
				r.bytes > PART_BYTES ||
				r.hb !== 64
			)
				return refuse();
			const chunk = blob(
				one<{ chunk: ArrayBuffer }>(
					this.storage,
					`SELECT chunk FROM ${PARTS} WHERE archive_id=? AND part=?`,
					h.archiveId,
					r.part,
				).chunk,
			);
			if (chunk.byteLength !== r.bytes || digest(chunk) !== r.chunk_hash)
				return refuse();
			all.update(chunk);
			total = count.parse(total + chunk.byteLength);
		}
		if (
			n !== h.parts ||
			total !== h.partBytes ||
			total !== h.metadata.sourceBytes ||
			all.digest("hex") !== h.sourceHash
		)
			return refuse();
	}
	private archivePin() {
		const h = this.header(false);
		if (h) this.parts(h);
		return JSON.stringify(h);
	}
	private snapshot() {
		return {
			source: this.scan(),
			prior: this.priorPin(),
			schema: this.schemaPin(),
			archive: this.archivePin(),
		};
	}
	private pins(original: ReturnType<SdkStatePreservation["snapshot"]>) {
		this.recheck();
		if (
			this.scan().sourceHash !== original.source.sourceHash ||
			this.priorPin().priorHash !== original.prior.priorHash ||
			this.schemaPin() !== original.schema ||
			this.archivePin() !== original.archive
		)
			return refuse();
	}
	private public(h: Header) {
		return SdkPreservationSummarySchema.parse({
			format: FORMAT,
			archiveId: h.archiveId,
			selectorVersion: SELECTOR,
			metadata: h.metadata,
			metadataDigest: h.metadataDigest,
			projectionDigest: null,
			priorArchives: h.priorArchives,
			alarmCovered: false,
			alarmConsistency: "UNKNOWN",
		});
	}
	private proof(text: string) {
		if (
			typeof text !== "string" ||
			!text.length ||
			text.length > PROOF_BYTES ||
			!/^[A-Za-z0-9+/]+=*$/.test(text)
		)
			return refuse();
		return text;
	}
	private async priorAudit(
		key: string,
		original: ReturnType<SdkStatePreservation["snapshot"]>,
		pins: () => void,
	) {
		if (original.prior.priorArchives.historical === "present") {
			if (
				!new HistoricalLiabilityCustody(
					this.storage,
					this.intent.objectId,
				).audit()
			)
				return refuse();
			pins();
		}
		for (const family of ["native", "session"] as const) {
			if (original.prior.priorArchives[family] !== "present") continue;
			const table = family === "native" ? OLD[4] : OLD[6];
			const size = one<{ kind: string; bytes: number }>(
				this.storage,
				`SELECT typeof(header) AS kind,length(CAST(header AS BLOB)) AS bytes FROM ${table} WHERE id=1`,
			);
			if (
				size.kind !== "text" ||
				!Number.isSafeInteger(size.bytes) ||
				size.bytes < 1 ||
				size.bytes > PROOF_BYTES + 65536
			)
				return refuse();
			const raw = JSON.parse(
				one<{ header: string }>(
					this.storage,
					`SELECT header FROM ${table} WHERE id=1`,
				).header,
			);
			const parser =
				family === "native"
					? NativePreservationIntentSchema
					: SessionPreservationIntentSchema;
			const intent = parser.parse(raw.intent),
				expected = parser.parse({
					...this.intent,
					kind:
						family === "native"
							? "native-preservation-capture-v1"
							: "session-preservation-capture-v1",
					operationId: intent.operationId,
				});
			if (
				!eq(intent, expected) ||
				!z.string().uuid().safeParse(raw.archiveId).success
			)
				return refuse();
			const verify = async () => {
				await checked(this.verifyCanonical(), pins);
			};
			const engine =
				family === "native"
					? new NativeStatePreservation(
							this.storage,
							intent as z.infer<typeof NativePreservationIntentSchema>,
							pins,
							verify,
						)
					: new SessionStatePreservation(
							this.storage,
							intent as z.infer<typeof SessionPreservationIntentSchema>,
							pins,
							verify,
						);
			if (!(await checked<unknown>(engine.audit(key, raw.archiveId), pins)))
				return refuse();
			pins();
		}
	}
	inspect(key: string) {
		const initial = this.snapshot(),
			existing = this.header(),
			pins = priority(() => this.pins(initial));
		return sdkOperation(pins, async (update, ready) => {
			await checked(this.priorAudit(key, initial, pins), pins);
			if (existing) {
				const audit = this.audit(key, existing.archiveId);
				await checked(audit.result, pins);
				audit.assertReady();
				pins();
			}
			const h: Header = {
				format: FORMAT,
				archiveId: existing?.archiveId ?? randomUUID(),
				selectorVersion: SELECTOR,
				intent: this.intent,
				sourceHash: initial.source.sourceHash,
				priorHash: initial.prior.priorHash,
				schemaHash: initial.schema,
				priorArchives: initial.prior.priorArchives,
				metadata: initial.source.metadata,
				metadataDigest: digest(JSON.stringify(initial.source.metadata)),
				parts: 0,
				partBytes: initial.source.metadata.sourceBytes,
			};
			if (
				existing &&
				(existing.sourceHash !== h.sourceHash ||
					existing.priorHash !== h.priorHash ||
					existing.schemaHash !== h.schemaHash)
			)
				return refuse();
			const issuedAt = Date.now(),
				planPins = priority(() => {
					pins();
					if (Date.now() < issuedAt || Date.now() >= issuedAt + TTL)
						return refuse();
				});
			update(planPins);
			const proof = await checked(
				encryptTediSecret(
					key,
					this.intent.tediId,
					JSON.stringify(
						Proof.parse({
							purpose: PURPOSE,
							issuedAt,
							expiresAt: issuedAt + TTL,
							header: h,
						}),
					),
				),
				planPins,
			);
			await checked(this.verifyCanonical(), planPins);
			this.proof(proof);
			planPins();
			ready(planPins);
			return { ...this.public(h), proof };
		});
	}
	capture(key: string, id: string, proof: string) {
		this.proof(proof);
		const initial = this.snapshot(),
			existing = this.header(),
			pins = priority(() => this.pins(initial));
		return sdkOperation(pins, async (update, ready) => {
			const p = Proof.parse(
					JSON.parse(
						await checked(
							decryptTediSecret(key, this.intent.tediId, proof),
							pins,
						),
					),
				),
				h = p.header;
			const fresh = () => {
				const n = Date.now();
				if (
					p.issuedAt > n ||
					p.expiresAt <= n ||
					p.expiresAt - p.issuedAt !== TTL
				)
					return refuse();
			};
			fresh();
			if (
				h.archiveId !== id ||
				!eq(h.intent, this.intent) ||
				h.sourceHash !== initial.source.sourceHash ||
				h.priorHash !== initial.prior.priorHash ||
				h.schemaHash !== initial.schema ||
				!eq(h.priorArchives, initial.prior.priorArchives) ||
				!eq(h.metadata, initial.source.metadata) ||
				h.metadataDigest !== digest(JSON.stringify(h.metadata)) ||
				h.parts !== 0 ||
				h.partBytes !== h.metadata.sourceBytes
			)
				return refuse();
			const capturePins = priority(() => {
				pins();
				fresh();
			});
			update(capturePins);
			await checked(this.priorAudit(key, initial, capturePins), capturePins);
			if (existing) {
				const audit = this.audit(key, id);
				await checked(audit.result, capturePins);
				audit.assertReady();
				capturePins();
			}
			await checked(this.verifyCanonical(), capturePins);
			const captured = this.storage.transactionSync(() => {
				pins();
				fresh();
				if (existing) {
					if (
						existing.archiveId !== id ||
						existing.sourceHash !== h.sourceHash ||
						existing.priorHash !== h.priorHash ||
						existing.schemaHash !== h.schemaHash
					)
						return refuse();
					this.parts(existing);
					fresh();
					return {
						value: this.public(existing),
						archive: JSON.stringify(existing),
					};
				}
				this.storage.sql.exec(DDL[SNAPSHOT]);
				this.storage.sql.exec(DDL[PARTS]);
				this.store();
				const assertSource = () => {
					this.recheck();
					fresh();
					this.store();
					if (
						this.scan().sourceHash !== h.sourceHash ||
						this.priorPin().priorHash !== h.priorHash ||
						this.schemaPin() !== h.schemaHash
					)
						return refuse();
					fresh();
				};
				let written = 0;
				const partHashes: string[] = [];
				const assertWritten = () => {
					let n = 0;
					for (const r of this.storage.sql.exec<{
						archive_id: string;
						ib: number;
						part: number;
						pk: string;
						kind: string;
						bytes: number;
						chunk_hash: string;
						hb: number;
					}>(
						`SELECT substr(archive_id,1,37) AS archive_id,length(CAST(archive_id AS BLOB)) AS ib,part,typeof(part) AS pk,typeof(chunk) AS kind,length(CAST(chunk AS BLOB)) AS bytes,substr(chunk_hash,1,65) AS chunk_hash,length(CAST(chunk_hash AS BLOB)) AS hb FROM ${PARTS} ORDER BY archive_id,part`,
					)) {
						if (
							r.archive_id !== id ||
							r.ib !== 36 ||
							r.part !== n ||
							r.pk !== "integer" ||
							r.kind !== "blob" ||
							!Number.isSafeInteger(r.bytes) ||
							r.bytes < 1 ||
							r.bytes > PART_BYTES ||
							r.hb !== 64 ||
							r.chunk_hash !== partHashes[n]
						)
							return refuse();
						const chunk = blob(
							one<{ chunk: ArrayBuffer }>(
								this.storage,
								`SELECT chunk FROM ${PARTS} WHERE archive_id=? AND part=?`,
								id,
								r.part,
							).chunk,
						);
						if (chunk.byteLength !== r.bytes || digest(chunk) !== partHashes[n])
							return refuse();
						n++;
					}
					if (n !== written) return refuse();
				};
				const source = this.scan((part, chunk) => {
					assertSource();
					assertWritten();
					this.storage.sql.exec(
						`INSERT INTO ${PARTS}(archive_id,part,chunk,chunk_hash) VALUES(?,?,?,?)`,
						id,
						part,
						chunk,
						digest(chunk),
					);
					partHashes.push(digest(chunk));
					written++;
					assertSource();
					assertWritten();
				});
				if (
					source.sourceHash !== h.sourceHash ||
					!eq(source.metadata, h.metadata)
				)
					return refuse();
				assertSource();
				assertWritten();
				const final = Stored.parse({
						...h,
						parts: source.parts,
						planProof: proof,
					}),
					text = JSON.stringify(final);
				fresh();
				this.storage.sql.exec(
					`INSERT INTO ${SNAPSHOT}(id,header,header_hash) VALUES(1,?,?)`,
					text,
					digest(text),
				);
				this.store();
				if (!eq(this.header(), final)) return refuse();
				this.parts(final);
				assertSource();
				assertWritten();
				fresh();
				return { value: this.public(final), archive: JSON.stringify(final) };
			});
			const resultPins = priority(() => {
				this.pins({ ...initial, archive: captured.archive });
				fresh();
			});
			ready(resultPins);
			resultPins();
			return captured.value;
		});
	}
	audit(key: string, id: string) {
		const initial = this.snapshot(),
			h = this.header(false),
			pins = priority(() => this.pins(initial));
		return sdkOperation(pins, async (_update, ready) => {
			await checked(this.priorAudit(key, initial, pins), pins);
			if (!h) {
				await checked(this.verifyCanonical(), pins);
				pins();
				ready(pins);
				return null;
			}
			if (h.archiveId !== id) return refuse();
			this.parts(h);
			if (
				h.priorHash !== initial.prior.priorHash ||
				!eq(h.priorArchives, initial.prior.priorArchives)
			)
				return refuse();
			const p = Proof.parse(
				JSON.parse(
					await checked(
						decryptTediSecret(key, this.intent.tediId, this.proof(h.planProof)),
						pins,
					),
				),
			);
			const { planProof: _proof, parts: _parts, ...stable } = h,
				{ parts: _planned, ...planned } = p.header;
			if (p.expiresAt - p.issuedAt !== TTL || !eq(stable, planned))
				return refuse();
			await checked(this.verifyCanonical(), pins);
			pins();
			ready(pins);
			return this.public(h);
		});
	}
}
