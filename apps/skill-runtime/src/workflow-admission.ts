import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	claimSkillWorkflowAdmissionFence,
	getSkillWorkflowAdmissionFence,
	pruneSkillWorkflowAdmissionFences,
	releaseSkillWorkflowAdmissionFence,
} from "./db";

function frameIdentity(parts: string[]): string {
	return parts.map((value) => `${value.length}:${value}`).join("|");
}

export const IMPLICIT_WORKFLOW_ADMISSION_DEDUP_WINDOW_MS = 60_000;

export const WORKFLOW_ADMISSION_CREATE_FAILED =
	"WORKFLOW_ADMISSION_CREATE_FAILED:";
export const WORKFLOW_ADMISSION_PENDING = "WORKFLOW_ADMISSION_PENDING:";

export function isAdmissionCreateFailureMarker(input: {
	status: string;
	error: string | null;
}): boolean {
	return (
		input.status === "failed" &&
		(input.error?.startsWith(WORKFLOW_ADMISSION_CREATE_FAILED) === true ||
			input.error?.startsWith(WORKFLOW_ADMISSION_PENDING) === true)
	);
}

/**
 * Only a row proven to have failed before engine execution may retry create.
 * Ordinary workflow failures—and legacy rows with no explicit admission
 * marker—are terminal idempotent replays even after engine retention expires.
 */
export function isRecoverableAdmissionFailure(input: {
	status: string;
	error: string | null;
	executionStarted: boolean;
}): boolean {
	return isAdmissionCreateFailureMarker(input) && !input.executionStarted;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== "object") return value ?? null;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, sortJson(entry)]),
	);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

/** Compare JSON request snapshots independent of object key insertion order. */
export function workflowAdmissionJsonEqual(
	left: unknown,
	right: unknown,
): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/**
 * Complete identity for implicit short-window deduplication. Including the
 * pinned source and manifest keeps a corrupted same-revision mutation from
 * ever aliasing a different executable snapshot.
 */
export async function workflowAdmissionFingerprint(input: {
	orgId: string;
	skillId: string;
	tediId: string;
	runtimeEnvironment: "development" | "staging" | "production";
	skillRevision: number | null;
	params: unknown;
	workflowSource: string;
	skillDoc: string;
	capabilityManifest: unknown;
	workItemId: string | null;
	originTediRunId: string | null;
}): Promise<string> {
	return sha256Hex(
		frameIdentity([
			"implicit-workflow-admission-v2",
			input.orgId,
			input.skillId,
			input.tediId,
			input.runtimeEnvironment,
			input.skillRevision == null ? "null" : String(input.skillRevision),
			canonicalJson(input.params),
			input.workflowSource,
			input.skillDoc,
			canonicalJson(input.capabilityManifest),
			input.workItemId ?? "null",
			input.originTediRunId ?? "null",
		]),
	);
}

export interface WorkflowAdmissionDedupClaim {
	runId: string;
	deduplicated: boolean;
	fingerprint: string;
	expiresAt: string;
}

/**
 * Atomically reserve a short-lived canonical run for an implicit admission.
 *
 * The UPSERT replaces only an expired fence. Concurrent callers inside the
 * window observe the winner's runId; after expiry, an intentional identical
 * run may reserve a fresh identity. Explicit caller keys bypass this path.
 */
export async function claimImplicitWorkflowAdmission(input: {
	db: D1Database;
	fingerprint: string;
	candidateRunId: string;
	now?: Date;
	windowMs?: number;
}): Promise<WorkflowAdmissionDedupClaim> {
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const expiresAt = new Date(
		now.getTime() +
			Math.max(
				1,
				input.windowMs ?? IMPLICIT_WORKFLOW_ADMISSION_DEDUP_WINDOW_MS,
			),
	).toISOString();
	const claimed = await claimSkillWorkflowAdmissionFence(input.db, {
		fingerprint: input.fingerprint,
		candidateRunId: input.candidateRunId,
		expiresAt,
		now: nowIso,
	});
	if (claimed) {
		return {
			runId: claimed.run_id,
			deduplicated: claimed.run_id !== input.candidateRunId,
			fingerprint: input.fingerprint,
			expiresAt: claimed.expires_at,
		};
	}
	const existing = await getSkillWorkflowAdmissionFence(
		input.db,
		input.fingerprint,
	);
	if (!existing) {
		throw new Error(
			"WORKFLOW_ADMISSION_DEDUP_LOST: reservation disappeared after conflict",
		);
	}
	return {
		runId: existing.run_id,
		deduplicated: true,
		fingerprint: input.fingerprint,
		expiresAt: existing.expires_at,
	};
}

/** Bound table growth without touching any currently active fence. */
export async function pruneExpiredWorkflowAdmissionDedup(
	db: D1Database,
	now = new Date(),
): Promise<void> {
	const retentionCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	await pruneSkillWorkflowAdmissionFences(db, retentionCutoff.toISOString());
}

/**
 * Release only the caller's own still-current reservation. Used when admission
 * fails before the canonical skill_runs row exists so a retry need not wait for
 * the bounded expiry. A winner can never delete a replacement reservation.
 */
export async function releaseImplicitWorkflowAdmission(input: {
	db: D1Database;
	fingerprint: string;
	runId: string;
}): Promise<void> {
	await releaseSkillWorkflowAdmissionFence(input.db, {
		fingerprint: input.fingerprint,
		runId: input.runId,
	});
}

/**
 * Deterministic UUIDv8-style run ID for a caller-owned idempotency key. The
 * full framed identity is hashed; UUID version/variant bits are then set so
 * the result remains accepted by strict UUID validators.
 */
export async function deriveIdempotentRunId(input: {
	orgId: string;
	skillId: string;
	tediId: string;
	runtimeEnvironment: "development" | "staging" | "production";
	idempotencyKey: string;
}): Promise<string> {
	// Preserve already-issued production IDs while separating development and
	// staging from production and from each other. Every route independently
	// enforces the stored environment, so legacy explicit IDs also fail closed.
	const environmentScope =
		input.runtimeEnvironment === "production"
			? []
			: [`runtime-environment:${input.runtimeEnvironment}`];
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			frameIdentity([
				input.orgId,
				input.skillId,
				input.tediId,
				...environmentScope,
				input.idempotencyKey,
			]),
		),
	);
	const bytes = new Uint8Array(digest).slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
