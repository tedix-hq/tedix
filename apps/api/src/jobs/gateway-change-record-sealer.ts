/**
 * Gateway change record sealer, no AI. On the two-minute platform tick, for a
 * bounded number of organizations with unsealed records: digest and chain
 * each record (`@tedix/agent-governance/seal`), continuing from the
 * organization's latest checkpoint, and write one checkpoint per run of
 * records, signed when CHANGE_RECORD_SIGNING_KEY is set.
 *
 * Sealing never runs on the tool-call path: the gateway's write stays one
 * insert, and records written concurrently or late are sealed here, in order.
 *
 * Why sealing in `sequence` order up to a settling cut-off cannot skip a
 * record: `sequence` is assigned by SQLite AUTOINCREMENT when the row is
 * inserted, and D1 has a single writer, so a row that lands later always gets
 * a higher sequence than every row already there, whatever its
 * `recorded_at`. A background write that arrives late (the gateway writes
 * allowed calls through waitUntil, with the `recorded_at` it chose earlier)
 * therefore lands after the sealed rows and is sealed in a later run. The
 * sealer walks an organization's unsealed rows in sequence order and stops at
 * the first one recorded less than SETTLING_WINDOW_MS ago, sealing only the
 * prefix before it; it never seals a row while leaving a lower unsealed one
 * behind. The window keeps a run from sealing the newest rows of a burst
 * while their neighbours are still being written, so runs are larger and
 * checkpoints fewer; it is not what keeps the chain gap-free.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { loadChangeRecordSigningKey } from "../lib/change-record-signing-key";
import { GatewayChangeRecordSchema } from "@tedix/api-contract/schemas/audit";
import {
	EVIDENCE_BUNDLE_FORMAT,
	type EvidenceBundle,
	evidenceBundleKey,
} from "@tedix/agent-governance/evidence";
import {
	type CheckpointInput,
	type DsseEnvelope,
	importVerifyingKey,
	sealRun,
	verifyChain,
	verifyCheckpoint,
} from "@tedix/agent-governance/seal";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getLatestGatewayChangeRecordCheckpoint,
	getUnsealedGatewayChangeRecordStats,
	listGatewayChangeRecordCheckpointsWithoutBundle,
	listGatewayChangeRecordsForCheckpoint,
	listOrganizationsWithUnsealedGatewayChangeRecords,
	listUnsealedGatewayChangeRecords,
	sealGatewayChangeRecords,
	setGatewayChangeRecordCheckpointBundle,
} from "@tedix/db/queries/gateway-change-records";

/** Rows recorded within this window are left for a later run. */
export const SETTLING_WINDOW_MS = 60_000;
/** Organizations per run, oldest waiting first. */
export const MAX_ORGANIZATIONS_PER_RUN = 20;
/** Records per checkpoint (one D1 batch of updates plus the checkpoint). */
export const RECORDS_PER_CHECKPOINT = 50;
/** Records sealed per run across all organizations. */
export const MAX_RECORDS_PER_RUN = 1_000;

/**
 * A record as `list_gateway_change_records` returns it, so the digest covers
 * exactly what a reader can check: the output schema drops unknown stored
 * fields. A row the schema rejects (which the read would also reject) is
 * digested as stored.
 */
function readerView(record: { sequence: number } & Record<string, unknown>) {
	const parsed = GatewayChangeRecordSchema.safeParse(record);
	return parsed.success ? parsed.data : record;
}

export interface SealerSigner {
	privateKey: CryptoKey;
	keyId: string;
}

export interface SealerResult extends Record<string, number> {
	organizationsSealed: number;
	recordsSealed: number;
	checkpointsWritten: number;
	conflicts: number;
	recordsUnsealed: number;
}

/** One sealer run against `db`; `now` is the run's clock in milliseconds. */
export async function sealGatewayChangeRecordRuns(
	db: DbQueryClient,
	now: number,
	signer: SealerSigner | null,
): Promise<SealerResult & { oldestUnsealedAgeSeconds?: number }> {
	const cutoff = new Date(now - SETTLING_WINDOW_MS).toISOString();
	const sealedAt = new Date(now).toISOString();
	const organizations = await listOrganizationsWithUnsealedGatewayChangeRecords(
		db,
		MAX_ORGANIZATIONS_PER_RUN,
	);
	let organizationsSealed = 0;
	let recordsSealed = 0;
	let checkpointsWritten = 0;
	let conflicts = 0;
	let failed = 0;
	for (const organizationId of organizations) {
		if (recordsSealed >= MAX_RECORDS_PER_RUN) break;
		let sealedHere = 0;
		try {
			let latest = await getLatestGatewayChangeRecordCheckpoint(
				db,
				organizationId,
			);
			while (recordsSealed < MAX_RECORDS_PER_RUN) {
				const limit = Math.min(
					RECORDS_PER_CHECKPOINT,
					MAX_RECORDS_PER_RUN - recordsSealed,
				);
				const afterSequence = latest?.lastSequence ?? 0;
				const candidates = await listUnsealedGatewayChangeRecords(
					db,
					organizationId,
					{ afterSequence, limit },
				);
				const unsettled = candidates.findIndex(
					(record) => !(record.recordedAt < cutoff),
				);
				const settled =
					unsettled === -1 ? candidates : candidates.slice(0, unsettled);
				if (settled.length === 0) break;
				const { seals, checkpoint } = await sealRun({
					organizationId,
					records: settled.map(readerView),
					previousChainHash: latest?.headChainHash ?? null,
					previousCheckpointDigest: latest?.checkpointDigest ?? null,
					sealedAt,
					signer: signer ?? undefined,
				});
				const row = {
					id: crypto.randomUUID(),
					organizationId,
					firstSequence: checkpoint.firstSequence,
					lastSequence: checkpoint.lastSequence,
					recordCount: checkpoint.recordCount,
					headChainHash: checkpoint.headChainHash,
					previousCheckpointDigest: checkpoint.previousCheckpointDigest,
					previousChainHash: checkpoint.previousChainHash,
					checkpointDigest: checkpoint.digest,
					sealedAt,
					envelope: checkpoint.envelope
						? JSON.stringify(checkpoint.envelope)
						: null,
					keyId: checkpoint.envelope ? (signer?.keyId ?? null) : null,
					evidenceBundleKey: null,
				};
				const written = await sealGatewayChangeRecords(db, {
					organizationId,
					afterSequence,
					seals,
					checkpoint: row,
				});
				if (!written) {
					// Another run sealed from the same point first; the next run
					// continues from its checkpoint.
					conflicts++;
					break;
				}
				latest = row;
				recordsSealed += seals.length;
				sealedHere += seals.length;
				checkpointsWritten++;
				if (unsettled !== -1 || candidates.length < limit) break;
			}
		} catch (error) {
			failed++;
			console.warn(
				JSON.stringify({
					event: "gateway_change_records.seal_failed",
					organizationId,
					exception: safeExceptionTopology(error),
				}),
			);
		}
		if (sealedHere > 0) organizationsSealed++;
	}
	const stats = await getUnsealedGatewayChangeRecordStats(db);
	const oldestUnsealedAgeSeconds = stats.oldestRecordedAt
		? Math.max(0, Math.round((now - Date.parse(stats.oldestRecordedAt)) / 1000))
		: null;
	console.log(
		JSON.stringify({
			event: "gateway_change_records.seal.run",
			organizationsSealed,
			recordsSealed,
			checkpointsWritten,
			conflicts,
			failedOrganizations: failed,
			recordsUnsealed: stats.rows,
			oldestUnsealedAgeSeconds,
			signing: signer ? "on" : "off",
		}),
	);
	if (failed > 0)
		throw new Error(`Gateway change record sealing failed for ${failed} orgs`);
	return {
		organizationsSealed,
		recordsSealed,
		checkpointsWritten,
		conflicts,
		recordsUnsealed: stats.rows,
		...(oldestUnsealedAgeSeconds === null ? {} : { oldestUnsealedAgeSeconds }),
	};
}

/** Bundles written per run, oldest checkpoint first. */
export const MAX_BUNDLES_PER_RUN = 25;

export interface BundleWriterKey {
	keyId: string;
	publicKeySpki: string;
}

/**
 * Write evidence bundles for checkpoints that have none, oldest first. Each
 * bundle is verified before it is written: every record's digest and chain
 * link up to the checkpoint's head and, when a public key is given and the
 * checkpoint is signed, the signature. After the stored object is confirmed,
 * the checkpoint is marked, which is what lets retention remove its records
 * from the main database. A checkpoint that fails is left unmarked and logged.
 */
export async function writeGatewayChangeRecordEvidenceBundles(
	db: DbQueryClient,
	bucket: R2Bucket,
	key: BundleWriterKey | null,
	now: number,
	limit = MAX_BUNDLES_PER_RUN,
): Promise<{ bundlesWritten: number; bundlesFailed: number }> {
	const publicKey = key ? await importVerifyingKey(key.publicKeySpki) : null;
	const checkpoints = await listGatewayChangeRecordCheckpointsWithoutBundle(
		db,
		limit,
	);
	let bundlesWritten = 0;
	let bundlesFailed = 0;
	for (const row of checkpoints) {
		try {
			const envelope = row.envelope
				? (JSON.parse(row.envelope) as DsseEnvelope)
				: null;
			const checkpoint: CheckpointInput = {
				organizationId: row.organizationId,
				firstSequence: row.firstSequence,
				lastSequence: row.lastSequence,
				recordCount: row.recordCount,
				previousCheckpointDigest: row.previousCheckpointDigest,
				previousChainHash: row.previousChainHash,
				sealedAt: row.sealedAt,
				headChainHash: row.headChainHash,
				envelope,
			};
			// The records as a reader gets them, which is what was digested.
			const records = (
				await listGatewayChangeRecordsForCheckpoint(db, row)
			).map((record) => ({
				...readerView(record),
				recordDigest: record.recordDigest,
				chainHash: record.chainHash,
			}));
			// The chain is checked on its own, so a checkpoint signed with an
			// earlier key still gets a bundle; the signature is checked apart.
			const chain = await verifyChain({
				records,
				checkpoints: [{ ...checkpoint, envelope: null }],
				publicKey: null,
				allowUnsigned: true,
			});
			if (!chain.ok || chain.recordsVerified !== row.recordCount)
				throw new Error(
					chain.ok
						? `verified ${chain.recordsVerified} of ${row.recordCount} records`
						: `${chain.reason} at ${chain.sequence}: ${chain.message}`,
				);
			let signature: EvidenceBundle["verification"]["signature"] = "unsigned";
			if (envelope) {
				signature = "not_checked";
				if (publicKey) {
					const verified = await verifyCheckpoint(envelope, publicKey);
					if (verified.ok) {
						if (verified.digest !== row.checkpointDigest)
							throw new Error("signed statement differs from the checkpoint");
						signature = "verified";
					}
				}
			}
			const bundle: EvidenceBundle = {
				format: EVIDENCE_BUNDLE_FORMAT,
				checkpointId: row.id,
				writtenAt: new Date(now).toISOString(),
				checkpoint,
				records,
				publicKey:
					key && signature === "verified"
						? {
								keyId: key.keyId,
								algorithm: "Ed25519",
								spki: key.publicKeySpki,
							}
						: null,
				verification: { recordsVerified: chain.recordsVerified, signature },
			};
			const objectKey = evidenceBundleKey(row);
			const body = JSON.stringify(bundle);
			await bucket.put(objectKey, body, {
				httpMetadata: { contentType: "application/json" },
				customMetadata: {
					checkpointDigest: row.checkpointDigest,
					recordCount: String(row.recordCount),
				},
			});
			const stored = await bucket.head(objectKey);
			if (
				!stored ||
				stored.size !== new TextEncoder().encode(body).byteLength ||
				stored.customMetadata?.checkpointDigest !== row.checkpointDigest
			)
				throw new Error("the stored bundle could not be confirmed");
			await setGatewayChangeRecordCheckpointBundle(db, row.id, objectKey);
			bundlesWritten++;
		} catch (error) {
			bundlesFailed++;
			console.error(
				JSON.stringify({
					event: "gateway_change_records.bundle_failed",
					organizationId: row.organizationId,
					checkpointId: row.id,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}
	return { bundlesWritten, bundlesFailed };
}

/**
 * The cron path: reads the database binding and the optional signing key,
 * seals, then writes evidence bundles for checkpoints that have none.
 */
export async function runGatewayChangeRecordSealer(
	env: Pick<CloudflareEnv, "DB" | "R2_BUCKET">,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const { createDbQueryClient } = await import("@tedix/db/query-client");
	const key = await loadChangeRecordSigningKey(env);
	if (!key)
		console.warn(
			JSON.stringify({
				event: "gateway_change_records.seal.signing_off",
				reason:
					"CHANGE_RECORD_SIGNING_KEY is not set; checkpoints are written unsigned",
			}),
		);
	const db = createDbQueryClient(env.DB);
	const sealed = await sealGatewayChangeRecordRuns(
		db,
		scheduledTime,
		key ? { privateKey: key.privateKey, keyId: key.keyId } : null,
	);
	const bundles = await writeGatewayChangeRecordEvidenceBundles(
		db,
		env.R2_BUCKET,
		key,
		scheduledTime,
	);
	console.log(
		JSON.stringify({ event: "gateway_change_records.bundle.run", ...bundles }),
	);
	return { ...sealed, ...bundles };
}
