import { createHash } from "node:crypto";
import {
	DAY_MANIFEST_FORMAT,
	EVIDENCE_BUNDLE_FORMAT,
	type DayManifest,
	type EvidenceBundle,
} from "@tedix/agent-governance/evidence";
import {
	checkpointDigest,
	checkpointStatement,
	importVerifyingKey,
	verifyChain,
	type SealedRecordInput,
} from "@tedix/agent-governance/seal";
import type { HistoryBucket } from "./history-export";

export const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const evidencePrefix = (organization: string) =>
	`change-record-evidence/v1/${encodeURIComponent(organization)}/`;

export async function* objectKeys(bucket: HistoryBucket, prefix: string) {
	let continuationToken: string | undefined;
	const seen = new Set<string>();
	do {
		const page = await bucket.list({ prefix, continuationToken });
		for (const { key } of page.contents ?? []) {
			if (!key.startsWith(prefix))
				throw new Error("Object tenant prefix mismatch");
			yield key;
		}
		if (!page.isTruncated) break;
		const next = page.nextContinuationToken;
		if (!next || seen.has(next))
			throw new Error("Object pagination did not advance");
		seen.add(next);
		continuationToken = next;
	} while (true);
}

export function inRange(value: unknown, from: string, to: string) {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
		throw new Error("Invalid ledger timestamp");
	const time = new Date(value).toISOString();
	return time >= from && time < to;
}

export interface LedgerObject {
	key: string;
	bytes: Uint8Array;
}

/** Scan by record time, not sealing day: historical records can be sealed later. */
export async function collectLedger(
	bucket: HistoryBucket,
	organization: string,
	from: string,
	to: string,
) {
	const prefix = evidencePrefix(organization);
	const bundles = new Map<string, Uint8Array>();
	const days: { key: string; bytes: Uint8Array; value: DayManifest }[] = [];
	for await (const key of objectKeys(bucket, prefix)) {
		const bytes = await bucket.get(key);
		const value = JSON.parse(new TextDecoder().decode(bytes));
		if (key.startsWith(prefix + "days/")) {
			if (
				value.format !== DAY_MANIFEST_FORMAT ||
				value.organizationId !== organization ||
				key !== `${prefix}days/${value.day}.json`
			)
				throw new Error("Invalid ledger day manifest");
			days.push({ key, bytes, value });
		} else {
			if (
				value.format !== EVIDENCE_BUNDLE_FORMAT ||
				value.checkpoint.organizationId !== organization
			)
				throw new Error("Ledger tenant or format mismatch");
			if (
				value.records.some((row: Record<string, unknown>) =>
					inRange(row.recordedAt, from, to),
				) ||
				inRange(value.checkpoint.sealedAt, from, to)
			)
				bundles.set(key, bytes);
		}
	}
	const selected = new Set(bundles.keys());
	const objects: LedgerObject[] = [];
	for (const day of days) {
		if (
			!inRange(
				`${day.value.day}T00:00:00Z`,
				from.slice(0, 10) + "T00:00:00.000Z",
				to,
			) &&
			!day.value.checkpoints.some((cp) => selected.has(cp.bundleKey))
		)
			continue;
		objects.push({ key: day.key, bytes: day.bytes });
		for (const cp of day.value.checkpoints) {
			if (
				!cp.bundleKey.startsWith(prefix) ||
				cp.bundleKey.startsWith(prefix + "days/")
			)
				throw new Error("Ledger bundle tenant prefix mismatch");
			let bundle = bundles.get(cp.bundleKey);
			if (!bundle) {
				bundle = await bucket.get(cp.bundleKey);
				bundles.set(cp.bundleKey, bundle);
			}
			if (digest(bundle) !== cp.bundleSha256)
				throw new Error("Missing or changed ledger bundle");
			selected.add(cp.bundleKey);
		}
	}
	for (const key of selected) objects.push({ key, bytes: bundles.get(key)! });
	return objects;
}

/** Keys are supplied independently; bundle publicKey is descriptive, never a trust root. */
export async function verifyLedger(
	objects: LedgerObject[],
	organization: string,
	from: string,
	to: string,
	keys: Record<string, string>,
) {
	const bundles = new Map<string, EvidenceBundle>();
	const days: DayManifest[] = [];
	const versions = new Map<number, Set<string>>();
	const checkpoints = new Map<string, EvidenceBundle["checkpoint"]>();
	let selectedRecords = 0,
		contextRecords = 0,
		duplicateRecords = 0;
	const unsigned: string[] = [],
		standalone: string[] = [];
	const referenced = new Set<string>();
	const keyFingerprints = new Set<string>();
	const prefix = evidencePrefix(organization);
	for (const object of objects) {
		if (!object.key.startsWith(prefix) || bundles.has(object.key))
			throw new Error("Invalid ledger object key");
		const value = JSON.parse(new TextDecoder().decode(object.bytes));
		if (value.format === DAY_MANIFEST_FORMAT) {
			if (
				value.organizationId !== organization ||
				object.key !== `${prefix}days/${value.day}.json`
			)
				throw new Error("Ledger day tenant mismatch");
			days.push(value);
			continue;
		}
		const bundle = value as EvidenceBundle;
		if (
			bundle.format !== EVIDENCE_BUNDLE_FORMAT ||
			bundle.checkpoint.organizationId !== organization
		)
			throw new Error("Ledger tenant mismatch");
		const cp = bundle.checkpoint;
		let publicKey: CryptoKey | null = null;
		if (cp.envelope) {
			for (const spki of Object.values(keys)) {
				const candidate = await importVerifyingKey(spki);
				const result = await verifyChain({
					records: bundle.records as SealedRecordInput[],
					checkpoints: [cp],
					publicKey: candidate,
				});
				if (result.ok) {
					publicKey = candidate;
					keyFingerprints.add(`sha256:${digest(Buffer.from(spki, "base64"))}`);
					break;
				}
			}
			if (!publicKey)
				throw new Error(
					`Ledger signature/content verification failed: ${object.key}`,
				);
		} else {
			const result = await verifyChain({
				records: bundle.records as SealedRecordInput[],
				checkpoints: [cp],
				publicKey: null,
				allowUnsigned: true,
			});
			if (!result.ok)
				throw new Error(
					`Unsigned ledger content verification failed: ${result.message}`,
				);
			unsigned.push(object.key);
		}
		if (
			!bundle.records.length ||
			bundle.records[0]!.sequence !== cp.firstSequence ||
			bundle.records.at(-1)!.sequence !== cp.lastSequence
		)
			throw new Error("Ledger checkpoint range mismatch");
		for (const row of bundle.records) {
			if (
				row.organizationId !== undefined &&
				row.organizationId !== organization
			)
				throw new Error("Ledger record tenant mismatch");
			if (inRange(row.recordedAt, from, to)) selectedRecords++;
			else contextRecords++;
			const sequence = row.sequence as number;
			const values = versions.get(sequence) ?? new Set<string>();
			if (values.has(row.recordDigest as string)) duplicateRecords++;
			values.add(row.recordDigest as string);
			versions.set(sequence, values);
		}
		checkpoints.set(await checkpointDigest(checkpointStatement(cp)), cp);
		bundles.set(object.key, bundle);
	}
	for (const day of days)
		for (const ref of day.checkpoints) {
			const object = objects.find((object) => object.key === ref.bundleKey);
			const bundle = bundles.get(ref.bundleKey);
			if (
				!object ||
				!bundle ||
				digest(object.bytes) !== ref.bundleSha256 ||
				bundle.checkpointId !== ref.checkpointId
			)
				throw new Error("Day manifest bundle mismatch");
			const cp = bundle.checkpoint;
			if (
				cp.sealedAt.slice(0, 10) !== day.day ||
				cp.firstSequence !== ref.firstSequence ||
				cp.lastSequence !== ref.lastSequence ||
				cp.recordCount !== ref.recordCount ||
				(await checkpointDigest(checkpointStatement(cp))) !==
					ref.checkpointDigest
			)
				throw new Error("Day manifest checkpoint mismatch");
			referenced.add(ref.bundleKey);
		}
	const missingPredecessors: string[] = [];
	for (const [hash, cp] of checkpoints) {
		if (!cp.previousCheckpointDigest) continue;
		const previous = checkpoints.get(cp.previousCheckpointDigest);
		if (!previous) missingPredecessors.push(hash);
		else if (
			previous.headChainHash !== cp.previousChainHash ||
			previous.lastSequence >= cp.firstSequence
		)
			throw new Error("Ledger checkpoint linkage mismatch");
	}
	for (const key of bundles.keys())
		if (!referenced.has(key)) standalone.push(key);
	const missingDays: string[] = [];
	for (
		let time = Date.parse(from.slice(0, 10));
		time < Date.parse(to);
		time += 86_400_000
	) {
		const day = new Date(time).toISOString().slice(0, 10);
		if (!days.some((value) => value.day === day)) missingDays.push(day);
	}
	return {
		selectedRecords,
		contextRecords,
		duplicateRecords,
		conflictingSequences: [...versions]
			.filter(([, values]) => values.size > 1)
			.map(([sequence]) => sequence),
		unsigned,
		standalone,
		missingDays,
		missingPredecessors,
		keyFingerprints: [...keyFingerprints].sort(),
	};
}
