import { streamSqlTable } from "./preservation-source-stream";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	encryptTediSecret,
	decryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import {
	CutoverInspectionHopSchema,
	SessionPreservationTableNames,
} from "@tedix/api-contract/schemas/tedi";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import {
	NativeStatePreservation,
	NativePreservationIntentSchema,
} from "./native-state-preservation";

import { qualifySessionArchive } from "./session-state-rehydration";

const FORMAT = "session-state-archive-v1" as const;
const PURPOSE = "session-state-preservation-plan-v1" as const;
const SNAPSHOT = "session_preservation_snapshot",
	PARTS = "session_preservation_parts";
export const SESSION_PRESERVATION_PART_BYTES = 1_000_000;
const CELL_BYTES = 65_536,
	PROOF_LIMIT = 131_072,
	TTL = 300_000;
const OLD = [
	"historical_custody_snapshot",
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
	"native_preservation_snapshot",
	"native_preservation_parts",
] as const;
const HEADER_BYTES = PROOF_LIMIT + CELL_BYTES;
const DDL = {
	[SNAPSHOT]: `CREATE TABLE ${SNAPSHOT}(id INTEGER PRIMARY KEY CHECK(id=1),header TEXT NOT NULL,header_hash TEXT NOT NULL)`,
	[PARTS]: `CREATE TABLE ${PARTS}(archive_id TEXT NOT NULL,part INTEGER NOT NULL,chunk BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(archive_id,part))`,
};
const hash = z.string().regex(/^[a-f0-9]{64}$/),
	count = z.number().int().nonnegative().safe();
export const SessionPreservationIntentSchema = z.strictObject({
	kind: z.literal("session-preservation-capture-v1"),
	operationId: z.string().min(1).max(256),
	rootId: hash,
	objectId: hash,
	tediId: z.string().uuid(),
	orgId: z.string().min(1).max(512),
	objectName: z.string().min(1).max(1024),
	physicalName: z.string().min(1).max(1024),
	className: z.string().min(1).max(128),
	targetPath: z.array(CutoverInspectionHopSchema).max(16),
	generation: z.number().int().positive().safe(),
});
export type SessionPreservationIntent = z.infer<
	typeof SessionPreservationIntentSchema
>;
const MetadataSchema = z.strictObject({
	tables: z
		.array(
			z.strictObject({
				table: z.enum(SessionPreservationTableNames),
				present: z.boolean(),
				rows: count,
				schema: z.enum(["absent", "unknown"]),
			}),
		)
		.length(8),
	sourceBytes: count,
	recordCount: count,
	localOwnerUnknown: z.boolean(),
});
const PriorSchema = z.strictObject({
	historical: z.enum(["absent", "present"]),
	native: z.enum(["absent", "present"]),
});
const HeaderSchema = z.strictObject({
	format: z.literal(FORMAT),
	archiveId: z.string().uuid(),
	selectorVersion: hash,
	intent: SessionPreservationIntentSchema,
	sourceHash: hash,
	priorHash: hash,
	priorArchives: PriorSchema,
	metadata: MetadataSchema,
	metadataDigest: hash,
	parts: count,
	partBytes: count,
});
const ProofSchema = z.strictObject({
	purpose: z.literal(PURPOSE),
	issuedAt: count,
	expiresAt: count,
	header: HeaderSchema,
});
const StoredHeaderSchema = HeaderSchema.extend({
	planProof: z.string().min(1).max(PROOF_LIMIT),
});
type Header = z.infer<typeof HeaderSchema>;
type Storage = Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
const refuse = (): never => {
	throw new Error("Session preservation verification rejected");
};
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const digest = (v: string | Uint8Array) =>
	createHash("sha256").update(v).digest("hex");
const selectorVersion = digest(
	JSON.stringify([FORMAT, SessionPreservationTableNames]),
);
/** Private framed stream: JSON descriptors followed by exactly N raw bytes and a newline. */
function descriptor(value: unknown) {
	const text = JSON.stringify(value) + "\n";
	if (Buffer.byteLength(text) > CELL_BYTES) return refuse();
	return Buffer.from(text);
}
function asBytes(value: unknown) {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (value instanceof Uint8Array) return value;
	return refuse();
}
function one<T extends Record<string, SqlStorageValue>>(
	storage: Storage,
	sql: string,
	...args: SqlStorageValue[]
): T {
	const it = storage.sql.exec<T>(sql, ...args)[Symbol.iterator](),
		first = it.next();
	if (first.done || !it.next().done) return refuse();
	return first.value;
}
export class SessionStatePreservation {
	constructor(
		private readonly storage: Storage,
		private readonly intent: SessionPreservationIntent,
		private readonly recheck: () => void,
		private readonly verifyCanonical: () => Promise<void>,
	) {
		this.intent = SessionPreservationIntentSchema.parse(intent);
	}
	private present(table: string) {
		return (
			[
				...this.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
					table,
				),
			].length === 1
		);
	}
	private *tableFrames(table: string) {
		yield* streamSqlTable(this.storage, table, refuse);
	}
	private ownerUnknown() {
		if (!this.present("cf_agents_state")) return true;
		const rows = [
			...this.storage.sql.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			),
		];
		if (!rows.length) return true;
		if (rows.length !== 1) return refuse();
		const v = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(rows[0]!.state));
		const m =
			v.aigMetadata === undefined || v.aigMetadata === null
				? v
				: z.record(z.string(), z.unknown()).parse(v.aigMetadata);
		return (
			m.tediId === undefined ||
			m.tediId === null ||
			m.orgId === undefined ||
			m.orgId === null
		);
	}
	private scan(write?: (part: number, chunk: Uint8Array) => void) {
		this.recheck();
		const metadata: z.infer<typeof MetadataSchema> = {
				tables: [],
				sourceBytes: 0,
				recordCount: 0,
				localOwnerUnknown: this.ownerUnknown(),
			},
			h = createHash("sha256");
		let part = 0,
			used = 0;
		const buffer = write
			? new Uint8Array(SESSION_PRESERVATION_PART_BYTES)
			: null;
		const feed = (frame: Uint8Array) => {
			h.update(frame);
			metadata.sourceBytes = count.parse(
				metadata.sourceBytes + frame.byteLength,
			);
			metadata.recordCount = count.parse(metadata.recordCount + 1);
			if (!write) return;
			let position = 0;
			while (position < frame.byteLength) {
				const n = Math.min(
					frame.byteLength - position,
					SESSION_PRESERVATION_PART_BYTES - used,
				);
				buffer!.set(frame.subarray(position, position + n), used);
				used += n;
				position += n;
				if (used === SESSION_PRESERVATION_PART_BYTES) {
					write(part++, buffer!.slice());
					used = 0;
				}
			}
		};
		feed(
			descriptor([
				"format",
				FORMAT,
				"selector",
				selectorVersion,
				"intent",
				this.intent,
			]),
		);
		for (const table of SessionPreservationTableNames) {
			const present = this.present(table),
				rows = present
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
			for (const frame of this.tableFrames(table)) feed(frame);
		}
		if (write && used) write(part++, buffer!.slice(0, used));
		this.recheck();
		return {
			sourceHash: h.digest("hex"),
			metadata: MetadataSchema.parse(metadata),
			parts: part,
		};
	}
	private priorPin() {
		const h = createHash("sha256");
		for (const table of OLD)
			for (const frame of this.tableFrames(table)) h.update(frame);
		const historical = this.present(OLD[0]),
			native = this.present(OLD[4]);
		if (
			historical !== this.present(OLD[1]) ||
			native !== this.present(OLD[5]) ||
			(!historical && (this.present(OLD[2]) || this.present(OLD[3])))
		)
			return refuse();
		return {
			priorHash: h.digest("hex"),
			priorArchives: PriorSchema.parse({
				historical: historical ? "present" : "absent",
				native: native ? "present" : "absent",
			}),
		};
	}
	private async authenticatePrior(
		masterKey: string,
		pin: ReturnType<SessionStatePreservation["priorPin"]>,
		assertPins: () => void,
	) {
		if (pin.priorArchives.historical === "present") {
			if (
				!new HistoricalLiabilityCustody(
					this.storage,
					this.intent.objectId,
				).audit()
			)
				return refuse();
			assertPins();
		}
		if (pin.priorArchives.native === "present") {
			const size = one<{ kind: string; bytes: number }>(
				this.storage,
				"SELECT typeof(header) AS kind,length(CAST(header AS BLOB)) AS bytes FROM native_preservation_snapshot WHERE id=1",
			);
			if (
				size.kind !== "text" ||
				!Number.isSafeInteger(size.bytes) ||
				size.bytes < 1 ||
				size.bytes > HEADER_BYTES
			)
				return refuse();
			const row = one<{ header: string }>(
					this.storage,
					"SELECT header FROM native_preservation_snapshot WHERE id=1",
				),
				header = z
					.object({
						archiveId: z.string().uuid(),
						intent: NativePreservationIntentSchema,
					})
					.parse(JSON.parse(row.header));
			const expected = NativePreservationIntentSchema.parse({
				...this.intent,
				kind: "native-preservation-capture-v1",
				operationId: header.intent.operationId,
			});
			if (JSON.stringify(expected) !== JSON.stringify(header.intent))
				return refuse();
			const engine = new NativeStatePreservation(
				this.storage,
				header.intent,
				assertPins,
				async () => {
					await this.verifyCanonical();
					assertPins();
				},
			);
			if (!(await engine.audit(masterKey, header.archiveId))) return refuse();
			assertPins();
		}
	}
	private storeExists() {
		const a = this.present(SNAPSHOT),
			b = this.present(PARTS);
		if (a !== b) return refuse();
		if (!a) return false;
		for (const table of [SNAPSHOT, PARTS]) {
			const objects = [
				...this.storage.sql.exec<{
					type: string;
					name: string;
					sql: string | null;
				}>(
					"SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name",
					table,
				),
			];
			if (
				objects.filter((r) => r.type === "table").length !== 1 ||
				objects.find((r) => r.type === "table")?.sql !==
					DDL[table as keyof typeof DDL] ||
				objects.some(
					(r) =>
						r.type !== "table" &&
						!(
							table === PARTS &&
							r.type === "index" &&
							r.name === `sqlite_autoindex_${PARTS}_1` &&
							r.sql === null
						),
				)
			)
				return refuse();
		}
		return true;
	}
	private header(operation = true) {
		if (!this.storeExists()) return null;
		const size = one<{
			kind: string;
			bytes: number;
			hash_kind: string;
			hash_bytes: number;
		}>(
			this.storage,
			`SELECT typeof(header) AS kind,length(CAST(header AS BLOB)) AS bytes,typeof(header_hash) AS hash_kind,length(CAST(header_hash AS BLOB)) AS hash_bytes FROM ${SNAPSHOT}`,
		);
		if (
			size.kind !== "text" ||
			!Number.isSafeInteger(size.bytes) ||
			size.bytes < 1 ||
			size.bytes > HEADER_BYTES ||
			size.hash_kind !== "text" ||
			size.hash_bytes !== 64
		)
			return refuse();
		const r = one<{ header: string; header_hash: string }>(
			this.storage,
			`SELECT header,header_hash FROM ${SNAPSHOT}`,
		);
		if (digest(r.header) !== r.header_hash) return refuse();
		const h = StoredHeaderSchema.parse(JSON.parse(r.header));
		if (
			h.selectorVersion !== selectorVersion ||
			JSON.stringify(h.intent) !==
				JSON.stringify(
					operation
						? this.intent
						: { ...this.intent, operationId: h.intent.operationId },
				) ||
			h.metadataDigest !== digest(JSON.stringify(h.metadata))
		)
			return refuse();
		return h;
	}
	private verifyParts(h: Header) {
		const hash = createHash("sha256");
		let parts = 0,
			bytes = 0;
		for (const row of this.storage.sql.exec<{
			archive_id: string;
			id_bytes: number;
			part: number;
			part_kind: string;
			kind: string;
			bytes: number;
			chunk_hash: string;
			hash_bytes: number;
		}>(
			`SELECT substr(archive_id,1,37) AS archive_id,length(CAST(archive_id AS BLOB)) AS id_bytes,part,typeof(part) AS part_kind,typeof(chunk) AS kind,length(CAST(chunk AS BLOB)) AS bytes,substr(chunk_hash,1,65) AS chunk_hash,length(CAST(chunk_hash AS BLOB)) AS hash_bytes FROM ${PARTS} ORDER BY archive_id,part`,
		)) {
			if (
				row.id_bytes !== 36 ||
				row.archive_id !== h.archiveId ||
				row.part_kind !== "integer" ||
				row.part !== parts++ ||
				row.kind !== "blob" ||
				!Number.isSafeInteger(row.bytes) ||
				row.bytes < 1 ||
				row.bytes > SESSION_PRESERVATION_PART_BYTES ||
				row.hash_bytes !== 64
			)
				return refuse();
			const chunk = asBytes(
				one<{ chunk: ArrayBuffer }>(
					this.storage,
					`SELECT chunk FROM ${PARTS} WHERE archive_id=? AND part=?`,
					h.archiveId,
					row.part,
				).chunk,
			);
			if (chunk.byteLength !== row.bytes || digest(chunk) !== row.chunk_hash)
				return refuse();
			hash.update(chunk);
			bytes += chunk.byteLength;
		}
		if (
			parts !== h.parts ||
			bytes !== h.partBytes ||
			bytes !== h.metadata.sourceBytes ||
			hash.digest("hex") !== h.sourceHash
		)
			return refuse();
	}

	private archivePin() {
		const h = this.header(false);
		if (h) this.verifyParts(h);
		return JSON.stringify(h);
	}
	private public(h: Header) {
		return {
			format: FORMAT,
			archiveId: h.archiveId,
			selectorVersion: h.selectorVersion,
			metadata: h.metadata,
			metadataDigest: h.metadataDigest,
			projectionDigest: null,
			priorArchives: h.priorArchives,
		};
	}
	private pins(sourceHash: string, priorHash: string, archive: string) {
		this.recheck();
		if (
			this.scan().sourceHash !== sourceHash ||
			this.priorPin().priorHash !== priorHash ||
			this.archivePin() !== archive
		)
			return refuse();
	}
	private proof(text: string) {
		if (
			typeof text !== "string" ||
			!text.length ||
			text.length > PROOF_LIMIT ||
			!/^[A-Za-z0-9+/]+=*$/.test(text)
		)
			return refuse();
		return text;
	}
	async inspect(masterKey: string) {
		const source = this.scan(),
			prior = this.priorPin(),
			archive = this.archivePin(),
			existing = this.header();
		const assertPins = () =>
			this.pins(source.sourceHash, prior.priorHash, archive);
		await this.authenticatePrior(masterKey, prior, assertPins);
		assertPins();
		if (existing) {
			await this.audit(masterKey, existing.archiveId);
			assertPins();
		}
		const header: Header = {
			format: FORMAT,
			archiveId: existing?.archiveId ?? randomUUID(),
			selectorVersion,
			intent: this.intent,
			...source,
			...prior,
			metadataDigest: digest(JSON.stringify(source.metadata)),
			parts: 0,
			partBytes: source.metadata.sourceBytes,
		};
		if (
			existing &&
			(existing.sourceHash !== header.sourceHash ||
				existing.priorHash !== header.priorHash)
		)
			return refuse();
		const issuedAt = Date.now(),
			proof = await encryptTediSecret(
				masterKey,
				this.intent.tediId,
				JSON.stringify(
					ProofSchema.parse({
						purpose: PURPOSE,
						issuedAt,
						expiresAt: issuedAt + TTL,
						header,
					}),
				),
			);
		assertPins();
		await this.verifyCanonical();
		assertPins();
		this.proof(proof);
		return { ...this.public(header), proof };
	}
	async capture(masterKey: string, archiveId: string, proof: string) {
		this.proof(proof);
		const source = this.scan(),
			prior = this.priorPin(),
			archive = this.archivePin(),
			existing = this.header();
		const assertPins = () =>
			this.pins(source.sourceHash, prior.priorHash, archive);
		const plaintext = await decryptTediSecret(
			masterKey,
			this.intent.tediId,
			proof,
		);
		assertPins();
		const p = ProofSchema.parse(JSON.parse(plaintext)),
			h = p.header;
		const fresh = () => {
			const now = Date.now();
			if (
				p.issuedAt > now ||
				p.expiresAt <= now ||
				p.expiresAt - p.issuedAt !== TTL
			)
				return refuse();
		};
		fresh();
		if (
			h.archiveId !== archiveId ||
			h.selectorVersion !== selectorVersion ||
			JSON.stringify(h.intent) !== JSON.stringify(this.intent) ||
			h.sourceHash !== source.sourceHash ||
			h.priorHash !== prior.priorHash ||
			JSON.stringify(h.priorArchives) !== JSON.stringify(prior.priorArchives) ||
			JSON.stringify(h.metadata) !== JSON.stringify(source.metadata) ||
			h.metadataDigest !== digest(JSON.stringify(h.metadata))
		)
			return refuse();
		await this.authenticatePrior(masterKey, prior, assertPins);
		assertPins();
		if (existing) {
			await this.audit(masterKey, archiveId);
			assertPins();
		}
		await this.verifyCanonical();
		assertPins();
		return this.storage.transactionSync(() => {
			assertPins();
			fresh();
			if (existing) {
				this.verifyParts(existing);
				if (
					existing.archiveId !== archiveId ||
					existing.sourceHash !== h.sourceHash ||
					existing.priorHash !== h.priorHash
				)
					return refuse();
				fresh();
				return this.public(existing);
			}
			this.storage.sql.exec(DDL[SNAPSHOT]);
			fresh();
			this.recheck();
			fresh();
			this.storage.sql.exec(DDL[PARTS]);
			this.storeExists();
			// New store is intentionally absent in the original pin; source/prior pins remain immutable.
			const beforeWrite = () => {
				this.recheck();
				fresh();
				if (
					this.priorPin().priorHash !== prior.priorHash ||
					this.scan().sourceHash !== h.sourceHash
				)
					return refuse();
				fresh();
			};
			const written = this.scan((part, chunk) => {
				beforeWrite();
				this.storage.sql.exec(
					`INSERT INTO ${PARTS}(archive_id,part,chunk,chunk_hash) VALUES(?,?,?,?)`,
					archiveId,
					part,
					chunk,
					digest(chunk),
				);
			});
			if (
				written.sourceHash !== h.sourceHash ||
				JSON.stringify(written.metadata) !== JSON.stringify(h.metadata)
			)
				return refuse();
			beforeWrite();
			if (this.scan().sourceHash !== h.sourceHash) return refuse();
			const final = StoredHeaderSchema.parse({
				...h,
				parts: written.parts,
				planProof: proof,
			});
			const text = JSON.stringify(final);
			fresh();
			this.storage.sql.exec(
				`INSERT INTO ${SNAPSHOT}(id,header,header_hash) VALUES(1,?,?)`,
				text,
				digest(text),
			);
			this.storeExists();
			this.verifyParts(final);
			beforeWrite();
			if (this.scan().sourceHash !== h.sourceHash) return refuse();
			fresh();
			return this.public(final);
		});
	}
	async audit(masterKey: string, archiveId: string) {
		this.recheck();
		const h = this.header(false);
		if (!h) return null;
		if (h.archiveId !== archiveId) return refuse();
		this.verifyParts(h);
		const source = this.scan(),
			prior = this.priorPin(),
			archive = this.archivePin(),
			assertPins = () => this.pins(source.sourceHash, prior.priorHash, archive);
		if (
			prior.priorHash !== h.priorHash ||
			JSON.stringify(prior.priorArchives) !== JSON.stringify(h.priorArchives)
		)
			return refuse();
		await this.authenticatePrior(masterKey, prior, assertPins);
		assertPins();
		const plaintext = await decryptTediSecret(
			masterKey,
			this.intent.tediId,
			this.proof(h.planProof),
		);
		assertPins();
		const original = ProofSchema.parse(JSON.parse(plaintext));
		const { planProof: _proof, parts: _parts, ...stable } = h,
			{ parts: _planned, ...planned } = original.header;
		if (
			original.expiresAt - original.issuedAt !== TTL ||
			JSON.stringify(stable) !== JSON.stringify(planned)
		)
			return refuse();
		await this.verifyCanonical();
		assertPins();
		return this.public(h);
	}
	private *archivedParts(original: Header) {
		for (let part = 0; part < original.parts; part++) {
			const row = one<{ chunk: ArrayBuffer }>(
				this.storage,
				`SELECT chunk FROM ${PARTS} WHERE archive_id=? AND part=?`,
				original.archiveId,
				part,
			);
			yield asBytes(row.chunk);
		}
	}
	/** Request-local read operation; no functions or raw source escape its local publisher. */
	prepareQualification(
		masterKey: string,
		archiveId: string,
		deadline = performance.now() + 30_000,
	) {
		let first: unknown,
			failed = false,
			ready = false;
		const original = this.header(false),
			pin = this.archivePin(),
			source = this.scan(),
			prior = this.priorPin();
		const assertContinuity = () => {
			try {
				this.recheck();
				this.pins(source.sourceHash, prior.priorHash, pin);
				if (performance.now() >= deadline)
					throw new Error("Session qualification deadline expired");
			} catch (error) {
				if (!failed) {
					failed = true;
					first = error;
				}
			}
			if (failed) throw first;
		};
		const checked = async <T>(promise: Promise<T>): Promise<T> => {
			const observed = Promise.resolve(promise);
			void observed.catch(() => {});
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				assertContinuity();
				return await Promise.race([
					observed,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Session qualification deadline expired")),
							Math.max(0, deadline - performance.now()),
						);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				assertContinuity();
			}
		};
		const result = (async () => {
			assertContinuity();
			await checked(this.authenticatePrior(masterKey, prior, assertContinuity));
			await checked(this.verifyCanonical());
			const authenticated = await checked(this.audit(masterKey, archiveId));
			if (!original || !authenticated) {
				assertContinuity();
				ready = true;
				return null;
			}
			const qualification = qualifySessionArchive(
				this.archivedParts(original),
				original.metadata,
				original.selectorVersion,
				original.intent,
				deadline,
			);
			assertContinuity();
			ready = true;
			return {
				archive: authenticated,
				qualification: {
					...qualification,
					archiveAuthenticated: true as const,
				},
			};
		})();
		return {
			result,
			assertContinuity,
			assertReady: () => {
				assertContinuity();
				if (!ready) throw new Error("Session qualification unavailable");
			},
		};
	}
}
