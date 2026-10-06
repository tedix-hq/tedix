import { encodePrivateKvValue } from "./preservation-source-stream";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	encryptTediSecret,
	decryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import {
	compareCutoverWorkflowIds,
	CutoverInspectionHopSchema,
	NativePreservationTableNames,
} from "@tedix/api-contract/schemas/tedi";

const FORMAT = "native-state-archive-v1" as const;
const PURPOSE = "native-state-preservation-plan-v1" as const;
const SNAPSHOT = "native_preservation_snapshot",
	PARTS = "native_preservation_parts";
export const NATIVE_PRESERVATION_PART_BYTES = 1_000_000;
export const NATIVE_PRESERVATION_PROOF_LIMIT = 131_072;
const TTL = 300_000;
export const NATIVE_PRESERVATION_TABLES = NativePreservationTableNames;
const PREFIXES = [
	"think-accounting:",
	"pi-accounting:",
	"pi-ui-entry:",
	"pi-image-projection:v1:",
	"__cf_messenger_recovery:",
	"cf:chat-recovery:incident:",
	"tedix:pi:telegram:reply:",
	"tedix:pi:maintenance:v1:",
	"tedix:pi:maintenance:fire:",
	"tedix:pi:maintenance:effect:",
	"workflow-image-cleanup:",
	"pi-state-cutover:v1:",
];
const KEYS = [
	"__ps_name",
	"cf_agents_is_facet",
	"cf_agents_facet_name",
	"cf_agents_parent_path",
	"facet-pending-submission",
	"pi-facet-pending-submission",
	"pi-admitted-operation:v1",
	"pi:legacy-imported:v1",
	"pi-active-conversation-id:v1",
	"pi-cutover-active-graph:v1",
];
const OLD = [
	"historical_custody_snapshot",
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
];
const DDL = {
	[SNAPSHOT]: `CREATE TABLE ${SNAPSHOT}(id INTEGER PRIMARY KEY CHECK(id=1),header TEXT NOT NULL,header_hash TEXT NOT NULL)`,
	[PARTS]: `CREATE TABLE ${PARTS}(archive_id TEXT NOT NULL,part INTEGER NOT NULL,chunk BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(archive_id,part))`,
};
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/),
	count = z.number().int().nonnegative().safe();
const LegacySchema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("absent") }),
	z.strictObject({
		state: z.literal("present"),
		snapshotId: hashSchema,
		sourceHash: hashSchema,
		generation: z.number().int().positive().safe(),
		workflowCount: count,
		fiberCount: count,
		identityCount: count,
	}),
]);
export const NativePreservationIntentSchema = z.strictObject({
	kind: z.literal("native-preservation-capture-v1"),
	operationId: z.string().min(1).max(256),
	rootId: hashSchema,
	objectId: hashSchema,
	tediId: z.string().uuid(),
	orgId: z.string().min(1).max(512),
	objectName: z.string().min(1).max(1024),
	physicalName: z.string().min(1).max(1024),
	className: z.string().min(1).max(128),
	targetPath: z.array(CutoverInspectionHopSchema).max(16),
	generation: z.number().int().positive().safe(),
});
export type NativePreservationIntent = z.infer<
	typeof NativePreservationIntentSchema
>;
const MetadataSchema = z.strictObject({
	tables: z
		.array(
			z.strictObject({
				table: z.enum(NATIVE_PRESERVATION_TABLES),
				present: z.boolean(),
				rows: count,
				schema: z.enum(["absent", "unknown"]),
			}),
		)
		.length(23),
	kvEntries: count,
	sourceBytes: count,
	recordCount: count,
	localOwnerUnknown: z.boolean(),
});
const HeaderSchema = z.strictObject({
	format: z.literal(FORMAT),
	archiveId: z.string().uuid(),
	selectorVersion: hashSchema,
	intent: NativePreservationIntentSchema,
	sourceHash: hashSchema,
	legacyHash: hashSchema,
	legacyArchive: LegacySchema,
	metadata: MetadataSchema,
	metadataDigest: hashSchema,
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
	planProof: z.string().min(1).max(NATIVE_PRESERVATION_PROOF_LIMIT),
});
type Header = z.infer<typeof HeaderSchema>;
type Storage = Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
const refuse = (): never => {
	throw new Error("Native preservation verification rejected");
};
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const digest = (s: string | Uint8Array) =>
	createHash("sha256").update(s).digest("hex");
const encode = (value: unknown) => encodePrivateKvValue(value, refuse);

const selectorVersion = digest(
	JSON.stringify([FORMAT, NATIVE_PRESERVATION_TABLES, PREFIXES, KEYS]),
);

export class NativeStatePreservation {
	constructor(
		private readonly storage: Storage,
		private readonly intent: NativePreservationIntent,
		private readonly recheck: () => void,
		private readonly verifyCanonical: () => Promise<void>,
	) {
		this.intent = NativePreservationIntentSchema.parse(intent);
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
	private *tableFrames(table: string): Generator<Uint8Array> {
		if (!this.present(table)) {
			yield encode(["table", table, "absent"]);
			return;
		}
		yield encode(["table", table, "present"]);
		for (const row of this.storage.sql.exec(
			"SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type COLLATE BINARY,name COLLATE BINARY",
			table,
		))
			yield encode(["schema", table, row]);
		const columns = [
			...this.storage.sql.exec<{ name: string }>(
				`PRAGMA table_xinfo(${quote(table)})`,
			),
		];
		for (const row of columns) yield encode(["column", table, row]);
		if (!columns.length) return refuse();
		const names = columns.map((r) => quote(r.name));
		const selection = names.flatMap((name, i) => [
			`${name} AS ${quote(`value_${i}`)}`,
			`typeof(${name}) AS ${quote(`type_${i}`)}`,
		]);
		for (const row of this.storage.sql.exec(
			`SELECT ${selection.join(",")} FROM ${quote(table)} ORDER BY ${[...names.map((name) => `${name} COLLATE BINARY`), ...names.map((name) => `typeof(${name}) COLLATE BINARY`)].join(",")}`,
		)) {
			// Native SQL exposes integer cells as JS numbers; unsafe integers cannot prove exact bytes.
			if (
				Object.values(row).some(
					(value) =>
						typeof value === "number" &&
						Number.isInteger(value) &&
						!Number.isSafeInteger(value),
				)
			)
				return refuse();
			yield encode([
				"row",
				table,
				columns.map((column, i) => ({
					name: column.name,
					type: row[`type_${i}`],
					value: row[`value_${i}`],
				})),
			]);
		}
	}
	private legacy() {
		const summary = new HistoricalLiabilityCustody(
			this.storage,
			this.intent.objectId,
		).audit();
		const h = createHash("sha256");
		for (const table of OLD)
			for (const frame of this.tableFrames(table)) h.update(frame);
		if (!summary && OLD.some((t) => this.present(t))) return refuse();
		return {
			legacyArchive: LegacySchema.parse(
				summary ? { state: "present", ...summary } : { state: "absent" },
			),
			legacyHash: h.digest("hex"),
		};
	}
	private *frames(
		metadata: z.infer<typeof MetadataSchema>,
	): Generator<Uint8Array> {
		yield encode([
			"format",
			FORMAT,
			"selector",
			selectorVersion,
			"intent",
			this.intent,
		]);
		for (const table of NATIVE_PRESERVATION_TABLES) {
			const present = this.present(table);
			let rows = 0;
			if (present) {
				const result = [
					...this.storage.sql.exec<{ n: number }>(
						`SELECT count(*) AS n FROM ${quote(table)}`,
					),
				][0];
				rows = count.parse(result?.n);
			}
			metadata.tables.push({
				table,
				present,
				rows,
				schema: present ? "unknown" : "absent",
			});
			yield* this.tableFrames(table);
		}
		const emitted = new Set<string>();
		for (const key of KEYS) {
			const entry = this.storage.kv
				.list({ start: key, end: `${key}\0`, limit: 1 })
				[Symbol.iterator]()
				.next();
			if (!entry.done) {
				if (entry.value[0] !== key) return refuse();
				const v = entry.value[1];
				metadata.kvEntries++;
				emitted.add(key);
				yield encode(["kv", key, v]);
			}
		}
		for (const prefix of PREFIXES) {
			let startAfter: string | undefined;
			for (;;) {
				const rows = this.storage.kv.list({
					prefix,
					limit: 1,
					...(startAfter === undefined ? {} : { startAfter }),
				});
				const first = rows[Symbol.iterator]().next();
				if (first.done) break;
				const [key, value] = first.value;
				if (
					startAfter !== undefined &&
					compareCutoverWorkflowIds(key, startAfter) <= 0
				)
					return refuse();
				if (!key.startsWith(prefix)) return refuse();
				startAfter = key;
				if (emitted.has(key)) return refuse();
				metadata.kvEntries++;
				yield encode(["kv", key, value]);
			}
		}
	}
	private scan(write?: (part: number, chunk: Uint8Array) => void) {
		this.recheck();
		const metadata: z.infer<typeof MetadataSchema> = {
			tables: [],
			kvEntries: 0,
			sourceBytes: 0,
			recordCount: 0,
			localOwnerUnknown: this.ownerUnknown(),
		};
		const h = createHash("sha256");
		let part = 0,
			buffer: Uint8Array[] = [];
		let bytes = 0;
		const flush = () => {
			if (!bytes) return;
			const chunk = Buffer.concat(buffer, bytes);
			write?.(part++, chunk);
			buffer = [];
			bytes = 0;
		};
		for (const frame of this.frames(metadata)) {
			metadata.recordCount++;
			metadata.sourceBytes += frame.byteLength;
			count.parse(metadata.sourceBytes);
			count.parse(metadata.recordCount);
			h.update(frame);
			if (write) {
				if (bytes + frame.byteLength > NATIVE_PRESERVATION_PART_BYTES) flush();
				buffer.push(frame);
				bytes += frame.byteLength;
			}
		}
		if (write) flush();
		this.recheck();
		return {
			sourceHash: h.digest("hex"),
			metadata: MetadataSchema.parse(metadata),
			parts: part,
		};
	}
	private ownerUnknown() {
		if (!this.present("cf_agents_state")) return true;
		const row = [
			...this.storage.sql.exec<{ state: string }>(
				"SELECT state FROM cf_agents_state WHERE id='cf_state_row_id'",
			),
		][0];
		if (!row) return true;
		const value: unknown = JSON.parse(row.state);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return refuse();
		const v = value as Record<string, unknown>,
			m = v.aigMetadata;
		const owner =
			m === undefined || m === null
				? v
				: typeof m === "object" && !Array.isArray(m)
					? (m as Record<string, unknown>)
					: refuse();
		return (
			owner.tediId === undefined ||
			owner.tediId === null ||
			owner.orgId === undefined ||
			owner.orgId === null
		);
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
	private header(checkOperation = true) {
		if (!this.storeExists()) return null;
		const rows = [
			...this.storage.sql.exec<{ header: string; header_hash: string }>(
				`SELECT header,header_hash FROM ${SNAPSHOT}`,
			),
		];
		if (rows.length !== 1) return refuse();
		const r = rows[0]!;
		if (digest(r.header) !== r.header_hash) return refuse();
		const h = StoredHeaderSchema.parse(JSON.parse(r.header));
		if (
			h.selectorVersion !== selectorVersion ||
			JSON.stringify(h.intent) !==
				JSON.stringify(
					checkOperation
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
			part: number;
			chunk: ArrayBuffer;
			chunk_hash: string;
		}>(
			`SELECT archive_id,part,chunk,chunk_hash FROM ${PARTS} ORDER BY archive_id,part`,
		)) {
			const chunk = new Uint8Array(row.chunk);
			if (
				row.archive_id !== h.archiveId ||
				row.part !== parts++ ||
				!chunk.byteLength ||
				chunk.byteLength > NATIVE_PRESERVATION_PART_BYTES ||
				digest(chunk) !== row.chunk_hash
			)
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
	private public(h: Header) {
		return {
			format: FORMAT,
			archiveId: h.archiveId,
			selectorVersion: h.selectorVersion,
			metadata: h.metadata,
			metadataDigest: h.metadataDigest,
			projectionDigest: null,
			legacyArchive: h.legacyArchive,
		};
	}
	async inspect(masterKey: string) {
		const source = this.scan(),
			legacy = this.legacy(),
			prior = this.header();
		if (prior) {
			await this.audit(masterKey, prior.archiveId);
			this.recheck();
			if (
				this.scan().sourceHash !== source.sourceHash ||
				JSON.stringify(this.legacy()) !== JSON.stringify(legacy)
			)
				return refuse();
		}
		if (JSON.stringify(this.header()) !== JSON.stringify(prior))
			return refuse();
		if (prior) this.verifyParts(prior);
		const h: Header = {
			format: FORMAT,
			archiveId: prior?.archiveId ?? randomUUID(),
			selectorVersion,
			intent: this.intent,
			...source,
			...legacy,
			metadataDigest: digest(JSON.stringify(source.metadata)),
			parts: 0,
			partBytes: source.metadata.sourceBytes,
		};
		if (
			prior &&
			(prior.sourceHash !== h.sourceHash || prior.legacyHash !== h.legacyHash)
		)
			return refuse();
		const issuedAt = Date.now();
		const proof = await encryptTediSecret(
			masterKey,
			this.intent.tediId,
			JSON.stringify(
				ProofSchema.parse({
					purpose: PURPOSE,
					issuedAt,
					expiresAt: issuedAt + TTL,
					header: h,
				}),
			),
		);
		this.recheck();
		if (
			this.scan().sourceHash !== h.sourceHash ||
			JSON.stringify(this.legacy()) !== JSON.stringify(legacy) ||
			JSON.stringify(this.header()) !== JSON.stringify(prior)
		)
			return refuse();
		if (prior) this.verifyParts(prior);
		await this.verifyCanonical();
		this.recheck();
		if (
			this.scan().sourceHash !== h.sourceHash ||
			JSON.stringify(this.legacy()) !== JSON.stringify(legacy)
		)
			return refuse();
		if (JSON.stringify(this.header()) !== JSON.stringify(prior))
			return refuse();
		if (prior) this.verifyParts(prior);
		if (proof.length > NATIVE_PRESERVATION_PROOF_LIMIT) return refuse();
		return { ...this.public(h), proof };
	}
	async capture(masterKey: string, archiveId: string, proof: string) {
		if (
			typeof proof !== "string" ||
			!proof.length ||
			proof.length > NATIVE_PRESERVATION_PROOF_LIMIT ||
			!/^[A-Za-z0-9+/]+=*$/.test(proof)
		)
			return refuse();
		const before = this.scan(),
			legacy = this.legacy();
		const plaintext = await decryptTediSecret(
			masterKey,
			this.intent.tediId,
			proof,
		);
		this.recheck();
		const p = ProofSchema.parse(JSON.parse(plaintext)),
			h = p.header,
			now = Date.now();
		if (
			p.issuedAt > now ||
			p.expiresAt <= now ||
			p.expiresAt - p.issuedAt !== TTL ||
			h.archiveId !== archiveId ||
			h.selectorVersion !== selectorVersion ||
			JSON.stringify(h.intent) !== JSON.stringify(this.intent) ||
			h.sourceHash !== before.sourceHash ||
			JSON.stringify({
				legacyArchive: h.legacyArchive,
				legacyHash: h.legacyHash,
			}) !== JSON.stringify(legacy)
		)
			return refuse();
		if (
			this.scan().sourceHash !== h.sourceHash ||
			JSON.stringify(this.legacy()) !== JSON.stringify(legacy)
		)
			return refuse();
		const existingPin = this.header();
		if (existingPin) {
			await this.audit(masterKey, archiveId);
			this.recheck();
			if (
				this.scan().sourceHash !== h.sourceHash ||
				JSON.stringify(this.legacy()) !== JSON.stringify(legacy) ||
				JSON.stringify(this.header()) !== JSON.stringify(existingPin)
			)
				return refuse();
		}
		if (existingPin) this.verifyParts(existingPin);
		await this.verifyCanonical();
		this.recheck();
		const assertProofFresh = () => {
			const now = Date.now();
			if (
				p.issuedAt > now ||
				p.expiresAt <= now ||
				p.expiresAt - p.issuedAt !== TTL
			)
				return refuse();
		};
		return this.storage.transactionSync(() => {
			this.recheck();
			assertProofFresh();
			if (
				this.scan().sourceHash !== h.sourceHash ||
				JSON.stringify(this.legacy()) !== JSON.stringify(legacy)
			)
				return refuse();
			const existing = this.header();
			if (JSON.stringify(existing) !== JSON.stringify(existingPin))
				return refuse();
			if (existing) {
				this.verifyParts(existing);
				if (
					existing.archiveId !== h.archiveId ||
					existing.sourceHash !== h.sourceHash ||
					existing.legacyHash !== h.legacyHash ||
					JSON.stringify(existing.metadata) !== JSON.stringify(before.metadata)
				)
					return refuse();
				assertProofFresh();
				return this.public(existing);
			}
			assertProofFresh();
			this.storage.sql.exec(DDL[SNAPSHOT]);
			this.storage.sql.exec(DDL[PARTS]);
			this.storeExists();
			const written = this.scan((part, chunk) => {
				assertProofFresh();
				this.storage.sql.exec(
					`INSERT INTO ${PARTS}(archive_id,part,chunk,chunk_hash) VALUES(?,?,?,?)`,
					h.archiveId,
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
			const final = StoredHeaderSchema.parse({
				...h,
				parts: written.parts,
				partBytes: written.metadata.sourceBytes,
				planProof: proof,
			});
			const text = JSON.stringify(final);
			assertProofFresh();
			this.storage.sql.exec(
				`INSERT INTO ${SNAPSHOT}(id,header,header_hash) VALUES(1,?,?)`,
				text,
				digest(text),
			);
			this.storeExists();
			this.verifyParts(final);
			this.recheck();
			if (
				this.scan().sourceHash !== h.sourceHash ||
				JSON.stringify(this.legacy()) !== JSON.stringify(legacy)
			)
				return refuse();
			assertProofFresh();
			return this.public(final);
		});
	}
	async audit(masterKey: string, archiveId: string) {
		this.recheck();
		const h = this.header(false);
		if (!h) return null;
		if (h.archiveId !== archiveId) return refuse();
		this.verifyParts(h);
		const legacy = this.legacy();
		if (
			h.legacyHash !== legacy.legacyHash ||
			JSON.stringify(h.legacyArchive) !== JSON.stringify(legacy.legacyArchive)
		)
			return refuse();
		const sourcePin = this.scan().sourceHash;
		const pin = JSON.stringify(h),
			oldPin = JSON.stringify(legacy);
		if (!/^[A-Za-z0-9+/]+=*$/.test(h.planProof)) return refuse();
		const plaintext = await decryptTediSecret(
			masterKey,
			this.intent.tediId,
			h.planProof,
		);
		this.recheck();
		if (
			this.scan().sourceHash !== sourcePin ||
			JSON.stringify(this.header(false)) !== pin ||
			JSON.stringify(this.legacy()) !== oldPin
		)
			return refuse();
		this.verifyParts(h);
		await this.verifyCanonical();
		this.recheck();
		if (this.scan().sourceHash !== sourcePin) return refuse();
		const original = ProofSchema.parse(JSON.parse(plaintext)).header;
		const { planProof: _proof, parts: _parts, ...stable } = h;
		const { parts: _plannedParts, ...planned } = original;
		if (
			JSON.stringify(stable) !== JSON.stringify(planned) ||
			JSON.stringify(this.header(false)) !== pin ||
			JSON.stringify(this.legacy()) !== oldPin
		)
			return refuse();
		this.verifyParts(h);
		this.recheck();
		return this.public(h);
	}
}
