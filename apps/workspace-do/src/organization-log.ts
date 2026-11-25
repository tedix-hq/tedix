/**
 * One organization's log store: its gateway change ledger, chained as each
 * record is appended, checkpointed and signed, with an evidence bundle per
 * checkpoint and a manifest per day in the EU archive.
 *
 * Records keep the gateway ledger's contract byte for byte: the same body
 * JSON, the same digest over the reader view (`GatewayChangeRecordSchema`),
 * the same chain hash and checkpoint statement. Sealed history copied from
 * the main database during the finished move keeps its sequences, digests
 * and chain hashes, and the store's own records continue that chain. A new
 * organization's store starts live: its first append is sequence 1.
 */

import { DurableObject } from "cloudflare:workers";
import {
	DAY_MANIFEST_FORMAT,
	type DayManifest,
	dayManifestKey,
	EVIDENCE_BUNDLE_FORMAT,
	type EvidenceBundle,
	evidenceBundleKey,
} from "@tedix/agent-governance/evidence";
import {
	type CheckpointInput,
	chainHash,
	type DsseEnvelope,
	importSigningKey,
	recordDigest,
	type SigningKey,
	sealRun,
	verifyChain,
} from "@tedix/agent-governance/seal";
import {
	type GatewayChangeRecordInput,
	GatewayChangeRecordSchema,
} from "@tedix/api-contract/schemas/audit";
import type {
	GatewayChangeRecordCheckpointQuery,
	GatewayChangeRecordCheckpointRow,
	GatewayChangeRecordRangeParams,
	OrganizationLogAppendInput,
	OrganizationLogAppendResult,
	OrganizationLogRead,
	OrganizationLogRecord,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import type { WorkspaceEnv } from "./env";

/** A checkpoint closes at this many records, or after `CHECKPOINT_AFTER_MS`. */
export const RECORDS_PER_CHECKPOINT = 500;
export const CHECKPOINT_AFTER_MS = 5 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS log_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change_records (
	sequence INTEGER PRIMARY KEY,
	id TEXT NOT NULL UNIQUE,
	recorded_at TEXT NOT NULL,
	resource TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	subject_id TEXT,
	record TEXT NOT NULL,
	record_digest TEXT NOT NULL,
	chain_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_records_recorded_at ON change_records(recorded_at, sequence);
CREATE INDEX IF NOT EXISTS change_records_subject ON change_records(subject_id, sequence);
CREATE INDEX IF NOT EXISTS change_records_resource ON change_records(resource, sequence);
CREATE INDEX IF NOT EXISTS change_records_actor ON change_records(actor_id, sequence);
CREATE TABLE IF NOT EXISTS change_record_checkpoints (
	id TEXT PRIMARY KEY,
	first_sequence INTEGER NOT NULL,
	last_sequence INTEGER NOT NULL UNIQUE,
	record_count INTEGER NOT NULL,
	head_chain_hash TEXT NOT NULL,
	previous_checkpoint_digest TEXT,
	previous_chain_hash TEXT,
	checkpoint_digest TEXT NOT NULL,
	sealed_at TEXT NOT NULL,
	envelope TEXT,
	key_id TEXT,
	evidence_bundle_key TEXT
);
CREATE INDEX IF NOT EXISTS change_record_checkpoints_sealed_at ON change_record_checkpoints(sealed_at);
-- Held appends of the finished cutover from main; emptied when a store went live.
DROP TABLE IF EXISTS pending_change_records;
`;

interface RecordRow {
	sequence: number;
	id: string;
	recorded_at: string;
	record: string;
	record_digest: string;
	chain_hash: string;
	[column: string]: SqlStorageValue;
}

interface CheckpointRow {
	id: string;
	first_sequence: number;
	last_sequence: number;
	record_count: number;
	head_chain_hash: string;
	previous_checkpoint_digest: string | null;
	previous_chain_hash: string | null;
	checkpoint_digest: string;
	sealed_at: string;
	envelope: string | null;
	key_id: string | null;
	evidence_bundle_key: string | null;
	[column: string]: SqlStorageValue;
}

type Body = Omit<GatewayChangeRecordInput, "id" | "recordedAt">;

interface LinkedRecord {
	sequence: number;
	id: string;
	recordedAt: string;
	body: Body;
	digest: string;
	link: string;
}

/** The record without seal fields, as a reader gets it and as it is digested. */
function readerView(record: Record<string, unknown>) {
	const parsed = GatewayChangeRecordSchema.safeParse(record);
	return parsed.success ? parsed.data : record;
}

function toRecord(row: RecordRow): OrganizationLogRecord {
	return {
		...(JSON.parse(row.record) as Body),
		id: row.id,
		sequence: row.sequence,
		recordedAt: row.recorded_at,
		recordDigest: row.record_digest,
		chainHash: row.chain_hash,
	};
}

function toCheckpoint(
	row: CheckpointRow,
	organizationId: string,
): GatewayChangeRecordCheckpointRow {
	return {
		id: row.id,
		organizationId,
		firstSequence: row.first_sequence,
		lastSequence: row.last_sequence,
		recordCount: row.record_count,
		headChainHash: row.head_chain_hash,
		previousCheckpointDigest: row.previous_checkpoint_digest,
		previousChainHash: row.previous_chain_hash,
		checkpointDigest: row.checkpoint_digest,
		sealedAt: row.sealed_at,
		envelope: row.envelope,
		keyId: row.key_id,
		evidenceBundleKey: row.evidence_bundle_key,
	};
}

function checkpointInput(
	checkpoint: GatewayChangeRecordCheckpointRow,
	withEnvelope: boolean,
): CheckpointInput {
	return {
		organizationId: checkpoint.organizationId,
		firstSequence: checkpoint.firstSequence,
		lastSequence: checkpoint.lastSequence,
		recordCount: checkpoint.recordCount,
		previousCheckpointDigest: checkpoint.previousCheckpointDigest,
		previousChainHash: checkpoint.previousChainHash,
		sealedAt: checkpoint.sealedAt,
		headChainHash: checkpoint.headChainHash,
		envelope:
			withEnvelope && checkpoint.envelope
				? (JSON.parse(checkpoint.envelope) as DsseEnvelope)
				: null,
	};
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/** The record's own fields; `id`, `recordedAt` and seal fields live in columns. */
function bodyOf(record: Record<string, unknown>): Body {
	const {
		id: _id,
		sequence: _sequence,
		recordedAt: _recordedAt,
		recordDigest: _digest,
		chainHash: _chain,
		...body
	} = record;
	return body as Body;
}

/** A stored record as it was digested: the reader view, plus its sequence. */
function digestedView(record: OrganizationLogRecord) {
	return {
		...readerView({
			...bodyOf(record),
			id: record.id,
			sequence: record.sequence,
			recordedAt: record.recordedAt,
		}),
		sequence: record.sequence,
	};
}

/** The digested view with its seal fields, as an export carries it. */
function sealedView(record: OrganizationLogRecord) {
	return {
		...digestedView(record),
		recordDigest: record.recordDigest,
		chainHash: record.chainHash,
	};
}

export class OrganizationLogStore extends DurableObject<WorkspaceEnv> {
	readonly #sql: SqlStorage;
	#queue: Promise<unknown> = Promise.resolve();
	#key: Promise<SigningKey | null> | undefined;

	constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
		super(ctx, env);
		this.#sql = ctx.storage.sql;
		this.#sql.exec(SCHEMA);
	}

	/**
	 * Read tail, hash and write run one at a time. Web Crypto awaits sit
	 * between the read and the write, and input gates do not hold across
	 * them, so every step that touches the chain goes through this queue.
	 */
	#serial<T>(step: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(step);
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	#meta(key: string): string | null {
		const [row] = this.#sql
			.exec<{ value: string }>("SELECT value FROM log_meta WHERE key = ?", key)
			.toArray();
		return row?.value ?? null;
	}

	#setMeta(key: string, value: string | null) {
		if (value === null)
			this.#sql.exec("DELETE FROM log_meta WHERE key = ?", key);
		else
			this.#sql.exec(
				"INSERT INTO log_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				key,
				value,
			);
	}

	/** The object is named after one organization; refuse any other. */
	#bind(organizationId: string) {
		const bound = this.#meta("organization_id");
		if (bound === null) this.#setMeta("organization_id", organizationId);
		else if (bound !== organizationId)
			throw new Error(
				"Organization log store scope does not match this object",
			);
	}

	#tail(): { sequence: number; chainHash: string | null } | null {
		const sequence = this.#meta("tail_sequence");
		if (sequence === null) return null;
		return {
			sequence: Number(sequence),
			chainHash: this.#meta("tail_chain_hash"),
		};
	}

	#lastCheckpoint(): CheckpointRow | null {
		const [row] = this.#sql
			.exec<CheckpointRow>(
				"SELECT * FROM change_record_checkpoints ORDER BY last_sequence DESC LIMIT 1",
			)
			.toArray();
		return row ?? null;
	}

	#signingKey(): Promise<SigningKey | null> {
		const secret = (this.env as { CHANGE_RECORD_SIGNING_KEY?: unknown })
			.CHANGE_RECORD_SIGNING_KEY;
		if (typeof secret !== "string" || !secret.trim())
			return Promise.resolve(null);
		this.#key ??= importSigningKey(secret);
		return this.#key;
	}

	#keyId(key: SigningKey): string {
		const id = (this.env as { CHANGE_RECORD_SIGNING_KEY_ID?: unknown })
			.CHANGE_RECORD_SIGNING_KEY_ID;
		return typeof id === "string" && id.trim() ? id.trim() : key.fingerprint;
	}

	#recordById(id: string): OrganizationLogRecord | null {
		const [row] = this.#sql
			.exec<RecordRow>("SELECT * FROM change_records WHERE id = ?", id)
			.toArray();
		return row ? toRecord(row) : null;
	}

	/** Digest and link records after `after`, in order; writes nothing. */
	async #link(
		after: { sequence: number; chainHash: string | null } | null,
		records: Array<{ id: string; recordedAt: string; body: Body }>,
	): Promise<LinkedRecord[]> {
		const linked: LinkedRecord[] = [];
		let sequence = after?.sequence ?? 0;
		let previous = after?.chainHash ?? null;
		for (const { id, recordedAt, body } of records) {
			sequence += 1;
			const digest = await recordDigest(
				readerView({ ...body, id, sequence, recordedAt }),
			);
			const link = await chainHash(previous, sequence, digest);
			linked.push({ sequence, id, recordedAt, body, digest, link });
			previous = link;
		}
		return linked;
	}

	/** Insert linked records and move the tail. Synchronous: no await inside. */
	#insertLinked(linked: LinkedRecord[]) {
		for (const r of linked)
			this.#sql.exec(
				"INSERT INTO change_records (sequence, id, recorded_at, resource, actor_id, subject_id, record, record_digest, chain_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				r.sequence,
				r.id,
				r.recordedAt,
				r.body.resource,
				r.body.actor.id,
				r.body.subject?.id ?? null,
				JSON.stringify(r.body),
				r.digest,
				r.link,
			);
		const last = linked.at(-1);
		if (!last) return;
		this.#setMeta("tail_sequence", String(last.sequence));
		this.#setMeta("tail_chain_hash", last.link);
	}

	async organizationLogAppend(
		organizationId: string,
		input: OrganizationLogAppendInput,
	): Promise<OrganizationLogAppendResult> {
		this.#bind(organizationId);
		const { id, recordedAt, ...body } = input;
		const record = await this.#serial(async () => {
			const stored = this.#recordById(id);
			if (stored) return stored;
			const linked = await this.#link(this.#tail(), [{ id, recordedAt, body }]);
			this.#insertLinked(linked);
			return this.#recordById(id) as OrganizationLogRecord;
		});
		await this.#scheduleCheckpoint(organizationId);
		return { status: "stored", record };
	}

	#uncheckpointed(): number {
		const last = this.#lastCheckpoint()?.last_sequence ?? 0;
		const [row] = this.#sql
			.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM change_records WHERE sequence > ?",
				last,
			)
			.toArray();
		return row?.n ?? 0;
	}

	async #scheduleCheckpoint(organizationId: string) {
		if (this.#uncheckpointed() >= RECORDS_PER_CHECKPOINT) {
			await this.#closeCheckpoints(organizationId);
			return;
		}
		if ((await this.ctx.storage.getAlarm()) === null)
			await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_AFTER_MS);
	}

	override async alarm() {
		const organizationId = this.#meta("organization_id");
		if (!organizationId) return;
		await this.#closeCheckpoints(organizationId);
		await this.#writeMissingBundles(organizationId);
		if (this.#uncheckpointed() > 0)
			await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_AFTER_MS);
	}

	/** Seal every record after the last checkpoint, in runs of at most 500. */
	#closeCheckpoints(organizationId: string): Promise<void> {
		return this.#serial(async () => {
			const key = await this.#signingKey();
			if (!key) {
				// An unsigned checkpoint would be a permanent unsigned link in the
				// chain. Records stay chained but unsealed until the key is set.
				console.error(
					JSON.stringify({
						event: "organization_log.signing_key_missing",
						organizationId,
						uncheckpointedRecords: this.#uncheckpointed(),
					}),
				);
				return;
			}
			for (;;) {
				const last = this.#lastCheckpoint();
				const rows = this.#sql
					.exec<RecordRow>(
						"SELECT * FROM change_records WHERE sequence > ? ORDER BY sequence LIMIT ?",
						last?.last_sequence ?? 0,
						RECORDS_PER_CHECKPOINT,
					)
					.toArray();
				if (rows.length === 0) return;
				const records = rows.map(toRecord);
				const sealedAt = new Date().toISOString();
				const { seals, checkpoint } = await sealRun({
					organizationId,
					records: records.map(digestedView),
					previousChainHash: last?.head_chain_hash ?? null,
					previousCheckpointDigest: last?.checkpoint_digest ?? null,
					sealedAt,
					signer: key
						? { privateKey: key.privateKey, keyId: this.#keyId(key) }
						: undefined,
				});
				seals.forEach((seal, i) => {
					if (seal.chainHash !== records[i]?.chainHash)
						throw new Error(
							`Record ${seal.sequence} does not match its stored chain hash`,
						);
				});
				this.#sql.exec(
					"INSERT INTO change_record_checkpoints (id, first_sequence, last_sequence, record_count, head_chain_hash, previous_checkpoint_digest, previous_chain_hash, checkpoint_digest, sealed_at, envelope, key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					crypto.randomUUID(),
					checkpoint.firstSequence,
					checkpoint.lastSequence,
					checkpoint.recordCount,
					checkpoint.headChainHash,
					checkpoint.previousCheckpointDigest,
					checkpoint.previousChainHash,
					checkpoint.digest,
					sealedAt,
					checkpoint.envelope ? JSON.stringify(checkpoint.envelope) : null,
					checkpoint.envelope && key ? this.#keyId(key) : null,
				);
			}
		});
	}

	/** Write the bundle and manifest entry of every checkpoint that has none. */
	async #writeMissingBundles(organizationId: string) {
		const bucket = (this.env as { R2_BUCKET?: R2Bucket }).R2_BUCKET;
		if (!bucket) return;
		const key = await this.#signingKey();
		const rows = this.#sql
			.exec<CheckpointRow>(
				"SELECT * FROM change_record_checkpoints WHERE evidence_bundle_key IS NULL ORDER BY last_sequence LIMIT 50",
			)
			.toArray();
		for (const row of rows) {
			const checkpoint = toCheckpoint(row, organizationId);
			const records = this.#sql
				.exec<RecordRow>(
					"SELECT * FROM change_records WHERE sequence BETWEEN ? AND ? ORDER BY sequence",
					row.first_sequence,
					row.last_sequence,
				)
				.toArray()
				.map((r) => sealedView(toRecord(r)));
			const signed = row.envelope !== null && key !== null;
			const verified = await verifyChain({
				records: records as never,
				checkpoints: [checkpointInput(checkpoint, signed)],
				publicKey: signed ? key.publicKey : null,
				allowUnsigned: true,
			});
			if (!verified.ok)
				throw new Error(
					`Checkpoint ending at ${row.last_sequence} does not verify: ${verified.message}`,
				);
			const bundle: EvidenceBundle = {
				format: EVIDENCE_BUNDLE_FORMAT,
				checkpointId: row.id,
				writtenAt: new Date().toISOString(),
				checkpoint: checkpointInput(checkpoint, true),
				records,
				publicKey: signed
					? {
							keyId: this.#keyId(key),
							algorithm: "Ed25519",
							spki: key.publicKeySpki,
						}
					: null,
				verification: {
					recordsVerified: verified.recordsVerified,
					signature: signed
						? "verified"
						: row.envelope
							? "not_checked"
							: "unsigned",
				},
			};
			const objectKey = evidenceBundleKey(checkpoint);
			const body = JSON.stringify(bundle);
			await bucket.put(objectKey, body, {
				httpMetadata: { contentType: "application/json" },
				customMetadata: {
					checkpointDigest: row.checkpoint_digest,
					recordCount: String(row.record_count),
				},
			});
			const stored = await bucket.head(objectKey);
			if (stored?.customMetadata?.checkpointDigest !== row.checkpoint_digest)
				throw new Error("The stored bundle could not be confirmed");
			await this.#addToManifest(
				bucket,
				checkpoint,
				objectKey,
				await sha256Hex(body),
			);
			this.#sql.exec(
				"UPDATE change_record_checkpoints SET evidence_bundle_key = ? WHERE id = ?",
				objectKey,
				row.id,
			);
		}
	}

	/** Add one checkpoint to its day's manifest. The store is its only writer. */
	async #addToManifest(
		bucket: R2Bucket,
		checkpoint: GatewayChangeRecordCheckpointRow,
		bundleKey: string,
		bundleSha256: string,
	) {
		const day = checkpoint.sealedAt.slice(0, 10);
		const key = dayManifestKey(checkpoint.organizationId, day);
		const existing = await bucket.get(key);
		const manifest: DayManifest = existing
			? ((await existing.json()) as DayManifest)
			: {
					format: DAY_MANIFEST_FORMAT,
					organizationId: checkpoint.organizationId,
					day,
					updatedAt: "",
					checkpoints: [],
				};
		if (!manifest.checkpoints.some((c) => c.checkpointId === checkpoint.id))
			manifest.checkpoints.push({
				checkpointId: checkpoint.id,
				firstSequence: checkpoint.firstSequence,
				lastSequence: checkpoint.lastSequence,
				recordCount: checkpoint.recordCount,
				checkpointDigest: checkpoint.checkpointDigest,
				bundleKey,
				bundleSha256,
			});
		manifest.checkpoints.sort((a, b) => a.lastSequence - b.lastSequence);
		manifest.updatedAt = new Date().toISOString();
		await bucket.put(key, JSON.stringify(manifest), {
			httpMetadata: { contentType: "application/json" },
		});
	}

	#live<T>(organizationId: string, read: () => T): OrganizationLogRead<T> {
		this.#bind(organizationId);
		return { status: "live", value: read() };
	}

	async organizationLogList(
		organizationId: string,
		query: {
			resource?: string;
			actorId?: string;
			afterSequence?: number;
			limit: number;
		},
	): Promise<OrganizationLogRead<OrganizationLogRecord[]>> {
		return this.#live(organizationId, () => {
			const where = ["sequence > ?"];
			const params: SqlStorageValue[] = [query.afterSequence ?? 0];
			if (query.resource !== undefined) {
				where.push("resource = ?");
				params.push(query.resource);
			}
			if (query.actorId !== undefined) {
				where.push("actor_id = ?");
				params.push(query.actorId);
			}
			return this.#sql
				.exec<RecordRow>(
					`SELECT * FROM change_records WHERE ${where.join(" AND ")} ORDER BY sequence LIMIT ?`,
					...params,
					query.limit,
				)
				.toArray()
				.map(toRecord);
		});
	}

	async organizationLogGet(
		organizationId: string,
		id: string,
	): Promise<OrganizationLogRead<OrganizationLogRecord | null>> {
		return this.#live(organizationId, () => this.#recordById(id));
	}

	async organizationLogRange(
		organizationId: string,
		range: GatewayChangeRecordRangeParams,
		page: { afterSequence?: number; limit: number },
	): Promise<
		OrganizationLogRead<{ records: OrganizationLogRecord[]; count: number }>
	> {
		return this.#live(organizationId, () => {
			const where = ["recorded_at >= ?", "recorded_at < ?"];
			const params: SqlStorageValue[] = [range.from, range.until];
			if (range.resource !== undefined) {
				where.push("resource = ?");
				params.push(range.resource);
			}
			if (range.actorId !== undefined) {
				where.push("actor_id = ?");
				params.push(range.actorId);
			}
			if (range.subjectId !== undefined) {
				where.push("subject_id = ?");
				params.push(range.subjectId);
			}
			const filter = where.join(" AND ");
			const [counted] = this.#sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM change_records WHERE ${filter}`,
					...params,
				)
				.toArray();
			const records = this.#sql
				.exec<RecordRow>(
					`SELECT * FROM change_records WHERE ${filter} AND sequence > ? ORDER BY sequence LIMIT ?`,
					...params,
					page.afterSequence ?? 0,
					page.limit,
				)
				.toArray()
				.map(toRecord);
			return { records, count: counted?.n ?? 0 };
		});
	}

	async organizationLogCheckpoints(
		organizationId: string,
		query: GatewayChangeRecordCheckpointQuery,
	): Promise<OrganizationLogRead<GatewayChangeRecordCheckpointRow[]>> {
		return this.#live(organizationId, () => {
			const where: string[] = ["1 = 1"];
			const params: SqlStorageValue[] = [];
			if (query.fromSequence !== undefined) {
				where.push("last_sequence >= ?");
				params.push(query.fromSequence);
			}
			if (query.untilSequence !== undefined) {
				where.push("first_sequence <= ?");
				params.push(query.untilSequence);
			}
			if (query.sealedFrom !== undefined) {
				where.push("sealed_at >= ?");
				params.push(query.sealedFrom);
			}
			if (query.sealedUntil !== undefined) {
				where.push("sealed_at < ?");
				params.push(query.sealedUntil);
			}
			if (query.afterLastSequence !== undefined) {
				where.push("last_sequence > ?");
				params.push(query.afterLastSequence);
			}
			return this.#sql
				.exec<CheckpointRow>(
					`SELECT * FROM change_record_checkpoints WHERE ${where.join(" AND ")} ORDER BY last_sequence LIMIT ?`,
					...params,
					query.limit,
				)
				.toArray()
				.map((row) => toCheckpoint(row, organizationId));
		});
	}
}
