/**
 * The permanent, offline-checkable copy of a sealed change ledger: one
 * evidence bundle per checkpoint and one manifest per day, as JSON objects in
 * object storage. Every writer of a ledger (the gateway sealer, an
 * organization log store) uses these shapes and keys, so one verifier reads
 * them all.
 *
 * Verify a bundle with `verifyChain({ records, checkpoints: [checkpoint], publicKey })`
 * from `./seal`; verify a day by downloading its manifest, checking each
 * bundle's SHA-256 against the manifest and running `verifyChain` over all of
 * the day's records and checkpoints together. Obtain the public key out of band.
 */

import type { CheckpointInput } from "./seal.js";

/** Prefix of every evidence object. Objects under it are never deleted. */
export const EVIDENCE_BUNDLE_PREFIX = "change-record-evidence/v1/";

/** A bundle's `format`; version 1 holds exactly the fields of `EvidenceBundle`. */
export const EVIDENCE_BUNDLE_FORMAT =
	"https://tedix.dev/evidence/change-record-bundle/v1";

/** A day manifest's `format`; version 1 holds exactly the fields of `DayManifest`. */
export const DAY_MANIFEST_FORMAT =
	"https://tedix.dev/evidence/change-record-day/v1";

export function evidenceBundleKey(checkpoint: {
	organizationId: string;
	lastSequence: number;
	id: string;
}): string {
	return `${EVIDENCE_BUNDLE_PREFIX}${encodeURIComponent(checkpoint.organizationId)}/${String(checkpoint.lastSequence).padStart(12, "0")}-${checkpoint.id}.json`;
}

/** The day is the UTC date the checkpoint was sealed. */
export function dayManifestKey(organizationId: string, day: string): string {
	return `${EVIDENCE_BUNDLE_PREFIX}${encodeURIComponent(organizationId)}/days/${day}.json`;
}

/** One checkpoint and every record it covers. */
export interface EvidenceBundle {
	format: typeof EVIDENCE_BUNDLE_FORMAT;
	checkpointId: string;
	writtenAt: string;
	checkpoint: CheckpointInput;
	/** Records as a reader gets them, with `recordDigest` and `chainHash`. */
	records: Array<Record<string, unknown>>;
	/** The key the writer checked the signature with; confirm it elsewhere. */
	publicKey: { keyId: string; algorithm: "Ed25519"; spki: string } | null;
	/** What the writer checked before storing the bundle. */
	verification: {
		recordsVerified: number;
		signature: "verified" | "unsigned" | "not_checked";
	};
}

/** The checkpoints sealed on one UTC day, in sequence order. */
export interface DayManifest {
	format: typeof DAY_MANIFEST_FORMAT;
	organizationId: string;
	/** `YYYY-MM-DD`, UTC. */
	day: string;
	updatedAt: string;
	checkpoints: Array<{
		checkpointId: string;
		firstSequence: number;
		lastSequence: number;
		recordCount: number;
		checkpointDigest: string;
		bundleKey: string;
		/** SHA-256 hex of the bundle object's bytes. */
		bundleSha256: string;
	}>;
}
