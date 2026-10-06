/**
 * Turn-summary artifact recorder for the isolate tedi runtime.
 *
 * After each chat turn pair, the Observer LLM already produced a structured
 * summary (observations, currentTasks, suggestedResponse) inside
 * `AgentTediDO.onBridgeTurn`. We persist that summary as a durable
 * TediArtifact via `cognitiveRuntime.recordArtifact` so Tedix OS and
 * other read-side surfaces can browse isolate-tedi turn history through the
 * same runtime-neutral contract container tedis use.
 *
 * Storage shape:
 *   - The JSON body is sent to the platform artifact API, which publishes a
 *     content-addressed R2 object and immutable TediArtifact claim together.
 *   - The runtime never writes a mutable legacy alias before that claim.
 *   - `kind` is `"log"` (the closest fit in `TediArtifactKindSchema`, which
 *     does not yet include a `turn_summary` variant). The real classifier
 *     lives in `metadata.subKind = "turn_summary"` + `metadata.producer =
 *     "isolate-do"` so consumers can filter without an enum migration.
 *
 * Fail-soft: every error is swallowed and logged. Artifact recording must
 * never break chat or brain-bridge. Caller wraps in try/catch as well.
 */

import { logTediPersistenceFailure } from "./persistence-failure-log";
import type { RecordArtifactInput } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type TurnSummaryArtifactInput as CoreTurnSummaryArtifactInput,
	type TurnSummaryArtifactBody,
} from "./artifacts-contract";
import type { HttpPlatformClient } from "./brain/platform-client";

export interface TurnSummaryArtifactInput extends CoreTurnSummaryArtifactInput {
	platform: HttpPlatformClient;
	bucket: R2Bucket;
	signal?: AbortSignal;
}

/**
 * Deterministic TediArtifact id for a turn-summary artifact.
 *
 * Keyed on the artifact's own `runId` (the isolate's `isolate-run-${turnId}`
 * synthetic run) so re-emission on a queue retry hits the same row, and so the
 * per-run TraceBundle emitter can reference the id WITHOUT a list query. The
 * api `recordArtifact` accepts a client-provided `id`; a stable id makes the
 * artifact write idempotent on the row PK rather than relying on a random UUID.
 * The v2 namespace cannot collide with a pre-cutover URI-only claim for the
 * same run, whose immutable content fields differ from this private write.
 */
export function turnSummaryArtifactId(runId: string): string {
	return `${runId}:artifact:v2:turn_summary`;
}

/**
 * Build the artifact JSON body and let the platform atomically publish the
 * content-addressed R2 body with its TediArtifact claim. Returns the
 * deterministic artifact id (the caller references it from the per-run
 * TraceBundle), or `null` if the record RPC failed.
 *
 * The shared platform client owns the typed `recordArtifact` procedure and
 * canonical oRPC transport.
 */
export async function recordTurnSummaryArtifact(
	opts: TurnSummaryArtifactInput,
): Promise<string | null> {
	const {
		platform,
		tediId,
		conversationId,
		runId,
		turnId,
		observerSummary,
		userText,
		assistantText,
	} = opts;

	opts.signal?.throwIfAborted();
	const artifactId = turnSummaryArtifactId(runId);

	try {
		const body: TurnSummaryArtifactBody = {
			turn: {
				turnId,
				user: userText,
				assistant: assistantText,
			},
			observations: observerSummary.observations,
			currentTasks: observerSummary.currentTasks ?? [],
			suggestedResponse: observerSummary.suggestedResponse ?? null,
		};
		const json = JSON.stringify(body);
		opts.signal?.throwIfAborted();
		const sizeBytes = new TextEncoder().encode(json).byteLength;
		const input = {
			id: artifactId,
			tediId,
			conversationId,
			runId,
			kind: "log" as const,
			name: `turn_summary/${turnId}.json`,
			mimeType: "application/json",
			sizeBytes,
			content: json,
			accessClassification: "runtime_private" as const,
			metadata: {
				subKind: "turn_summary",
				producer: "isolate-do",
				turnId,
				observationCount: observerSummary.observations.length,
				hasCurrentTasks: (observerSummary.currentTasks?.length ?? 0) > 0,
				hasSuggestedResponse: Boolean(observerSummary.suggestedResponse),
			},
		};

		await platform.recordArtifact(input);
		opts.signal?.throwIfAborted();
		return artifactId;
	} catch (err) {
		opts.signal?.throwIfAborted();
		logTediPersistenceFailure("tedi.artifact.turn_summary_record_failed", err);
		return null;
	}
}

/** Allowed `kind` values for a deliverable, mirroring TediArtifactKindSchema. */
const DELIVERABLE_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
	"file",
	"image",
	"document",
	"spreadsheet",
	"presentation",
	"widget",
	"log",
	"link",
	"other",
]);

function isDeliverableArtifactKind(
	value: string,
): value is RecordArtifactInput["kind"] {
	return DELIVERABLE_ARTIFACT_KINDS.has(value);
}

function sanitizeDeliverableName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? name;
	const cleaned = base
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 120) || "deliverable";
}

export interface DeliverableArtifactInput {
	platform: HttpPlatformClient;
	bucket: R2Bucket;
	tediId: string;
	conversationId?: string;
	runId?: string;
	/** Logical file name, e.g. "dyson-price-report.md". */
	name: string;
	/** UTF-8 text body of the deliverable. */
	content: string;
	/** Defaults to "text/markdown; charset=utf-8". */
	mimeType?: string;
	/** TediArtifact kind; defaults to "document". */
	kind?: string;
	/** Optional human description stored in metadata. */
	description?: string;
}

export interface DeliverableArtifactResult {
	ok: boolean;
	artifactId?: string;
	name?: string;
	uri?: string;
	sizeBytes?: number;
	error?: string;
}

export interface WorkstationProcessArtifactRegistrationInput {
	platform: HttpPlatformClient;
	tediId: string;
	conversationId: string;
	runId: string;
	processId: string;
	artifactRefs: string[];
	/** Canonical ids already persisted by the trusted workstation edge. */
	persistedArtifactIds?: string[];
	evidence?: Record<string, unknown>;
	traceBundleId?: string;
}

export interface WorkstationProcessArtifactRegistrationResult {
	ok: boolean;
	artifactIds: string[];
	recorded: number;
	skipped: number;
	error?: string;
}

function optionalIdentity(
	value: string | null | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function resolveWorkstationProcessArtifactRunId(input: {
	activeRunId?: string | null;
	evidenceKernelRunId?: string | null;
	evidenceWorkItemId?: string | null;
	inputKernelRunId?: string | null;
	inputWorkItemId?: string | null;
}): string | undefined {
	const inputWorkItemId = optionalIdentity(input.inputWorkItemId);
	const evidenceWorkItemId = optionalIdentity(input.evidenceWorkItemId);
	return (
		optionalIdentity(input.inputKernelRunId) ??
		(inputWorkItemId ? `work-item:${inputWorkItemId}` : undefined) ??
		optionalIdentity(input.evidenceKernelRunId) ??
		(evidenceWorkItemId ? `work-item:${evidenceWorkItemId}` : undefined) ??
		optionalIdentity(input.activeRunId)
	);
}

function sanitizeArtifactIdPart(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._:-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 96) || "unknown"
	);
}

function compactOptionalMetadata(
	input: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null || value === "") continue;
		out[key] = value;
	}
	return out;
}

function workstationArtifactDescriptor(
	ref: string,
	index: number,
): { idPart: string; mimeType: string; name: string; refType: string } {
	const fileName = ref.split(/[/?#]/).filter(Boolean).at(-1) ?? `log-${index}`;
	if (fileName === "evidence.json") {
		return {
			idPart: "evidence",
			mimeType: "application/json",
			name: "evidence.json",
			refType: "evidence",
		};
	}
	if (fileName === "stdout.log") {
		return {
			idPart: "stdout",
			mimeType: "text/plain; charset=utf-8",
			name: "stdout.log",
			refType: "stdout",
		};
	}
	if (fileName === "stderr.log") {
		return {
			idPart: "stderr",
			mimeType: "text/plain; charset=utf-8",
			name: "stderr.log",
			refType: "stderr",
		};
	}
	const idPart = sanitizeArtifactIdPart(fileName || `log-${index}`);
	return {
		idPart,
		mimeType: "application/octet-stream",
		name: fileName || `log-${index}`,
		refType: "other",
	};
}

export function trustedPersistedWorkstationArtifactIds(input: {
	persistedEvidenceReadback: unknown;
	persistence: Record<string, unknown> | undefined;
	artifactRefs: readonly string[];
	runId: string;
	processId: string;
}): string[] {
	if (
		input.persistedEvidenceReadback !== true ||
		input.persistence?.status !== "skipped" ||
		input.persistence.reason !== "evidence_already_persisted"
	) {
		return [];
	}
	const aliases = new Set(
		input.artifactRefs
			.map((ref) => ref.trim())
			.filter((ref) => ref.startsWith("artifact://"))
			.map((ref) => ref.slice("artifact://".length)),
	);
	const safeProcessId = sanitizeArtifactIdPart(input.processId);
	return Array.from(
		new Set(
			input.artifactRefs
				.map((ref) => ref.trim())
				.filter((ref) => ref.startsWith("r2://"))
				.map((ref, index) => {
					const descriptor = workstationArtifactDescriptor(ref, index);
					return `${input.runId}:artifact:workstation_process:${safeProcessId}:${descriptor.idPart}`;
				})
				.filter((id) => aliases.has(id)),
		),
	);
}

export function trustedExistingWorkstationArtifactIds(input: {
	persistence: Record<string, unknown> | undefined;
	artifactRefs: readonly string[];
	runId: string;
	processId: string;
}): string[] {
	if (
		input.persistence?.status !== "persisted" &&
		input.persistence?.status !== "failed"
	) {
		return [];
	}
	const claimed = new Set(
		Array.isArray(input.persistence.artifactIds)
			? input.persistence.artifactIds.filter(
					(id): id is string => typeof id === "string",
				)
			: [],
	);
	const safeProcessId = sanitizeArtifactIdPart(input.processId);
	return Array.from(
		new Set(
			input.artifactRefs
				.map((ref) => ref.trim())
				.filter((ref) => ref.startsWith("r2://"))
				.map((ref, index) => {
					const descriptor = workstationArtifactDescriptor(ref, index);
					return `${input.runId}:artifact:workstation_process:${safeProcessId}:${descriptor.idPart}`;
				})
				.filter((id) => claimed.has(id)),
		),
	);
}

/**
 * Persist an arbitrary tedi-produced deliverable (a report, summary, CSV, etc.)
 * as a durable, openable TediArtifact. Sends the UTF-8 body to
 * `cognitiveRuntime.recordArtifact` (kind `document` by default), which
 * emits an `artifact.created` runtime event so Home/Tedix OS can render an openable
 * deliverable card and reconcile a lightweight reference back to the parent run.
 *
 * Idempotent on `(runId, name)`: re-emission reuses the same deterministic
 * v2 artifact id and immutable content claim, separate from URI-only legacy
 * ids. Returns `{ ok: false }` only when
 * the record RPC fails. The public platform client method is typed directly
 * from `RecordArtifactInputSchema`.
 */
export async function recordDeliverableArtifact(
	opts: DeliverableArtifactInput,
): Promise<DeliverableArtifactResult> {
	const { platform, tediId, conversationId, runId, content } = opts;
	const safeName = sanitizeDeliverableName(opts.name);
	const kind =
		opts.kind && isDeliverableArtifactKind(opts.kind) ? opts.kind : "document";
	const mimeType = opts.mimeType?.trim() || "text/markdown; charset=utf-8";
	const artifactId = `${runId ?? tediId}:artifact:v2:deliverable:${safeName}`;
	const sizeBytes = new TextEncoder().encode(content).byteLength;

	const input: RecordArtifactInput = {
		id: artifactId,
		tediId,
		...(conversationId ? { conversationId } : {}),
		...(runId ? { runId } : {}),
		kind,
		name: safeName,
		mimeType,
		sizeBytes,
		content,
		accessClassification: "runtime_private",
		metadata: {
			subKind: "deliverable",
			producer: "tedi-tool",
			...(opts.description ? { description: opts.description } : {}),
		},
	};

	try {
		const recorded = await platform.recordArtifact(input);
		const artifact =
			recorded && typeof recorded === "object" && "artifact" in recorded
				? (recorded.artifact as Record<string, unknown> | null)
				: null;
		const uri = typeof artifact?.uri === "string" ? artifact.uri : undefined;
		return { ok: true, artifactId, name: safeName, uri, sizeBytes };
	} catch (err) {
		logTediPersistenceFailure("tedi.artifact.deliverable_record_failed", err);
		return {
			ok: false,
			error: "artifact_record_failed",
		};
	}
}

/**
 * Register terminal workstation process R2 refs as canonical TediArtifact rows.
 *
 * The Tedi edge already writes `evidence.json`, `stdout.log`, and `stderr.log`
 * to R2. This helper deliberately does not rewrite those objects; it only
 * creates deterministic artifact rows for the active child run so
 * `kernelRuntime.readChildRunEvidence` can return process logs through the
 * normal `evidence.artifacts` contract.
 */
export async function recordWorkstationProcessArtifactRefs(
	opts: WorkstationProcessArtifactRegistrationInput,
): Promise<WorkstationProcessArtifactRegistrationResult> {
	const refs = Array.from(
		new Set(
			opts.artifactRefs
				.map((ref) => ref.trim())
				.filter((ref) => ref.startsWith("r2://")),
		),
	);
	if (
		!opts.conversationId.trim() ||
		!opts.runId.trim() ||
		!opts.processId.trim() ||
		refs.length === 0
	) {
		return {
			ok: true,
			artifactIds: [],
			recorded: 0,
			skipped: refs.length,
		};
	}

	const trustedPersistedIds = new Set(
		(opts.persistedArtifactIds ?? []).map((id) => id.trim()).filter(Boolean),
	);
	const artifactIds: string[] = [];
	let recorded = 0;
	let failed = false;
	for (const [index, ref] of refs.entries()) {
		const descriptor = workstationArtifactDescriptor(ref, index);
		const safeProcessId = sanitizeArtifactIdPart(opts.processId);
		const artifactId = `${opts.runId}:artifact:workstation_process:${safeProcessId}:${descriptor.idPart}`;
		if (trustedPersistedIds.has(artifactId)) {
			artifactIds.push(artifactId);
			continue;
		}
		const metadata = compactOptionalMetadata({
			subKind: "workstation_process",
			producer: "workstation-adapter",
			source: "workstation_process",
			processId: opts.processId,
			refType: descriptor.refType,
			eventType: opts.evidence?.eventType,
			workItemId: opts.evidence?.workItemId,
			kernelRunId: opts.evidence?.kernelRunId,
			traceId: opts.evidence?.traceId,
			traceBundleId: opts.traceBundleId,
			workstationId: opts.evidence?.workstationId,
			leaseId: opts.evidence?.leaseId,
			sessionId: opts.evidence?.sessionId,
			profileId: opts.evidence?.profileId,
			exitCode: opts.evidence?.exitCode,
			canceled: opts.evidence?.canceled,
			timedOut: opts.evidence?.timedOut,
			ref,
		});
		try {
			await opts.platform.recordArtifact({
				id: artifactId,
				tediId: opts.tediId,
				conversationId: opts.conversationId,
				runId: opts.runId,
				kind: "log",
				name: `workstation_process/${safeProcessId}/${descriptor.name}`,
				mimeType: descriptor.mimeType,
				uri: ref,
				accessClassification: "runtime_private",
				metadata,
			});
			artifactIds.push(artifactId);
			recorded += 1;
		} catch (err) {
			failed = true;
			logTediPersistenceFailure("tedi.artifact.workstation_record_failed", err);
		}
	}

	return {
		ok: !failed,
		artifactIds,
		recorded,
		skipped: refs.length - recorded,
		...(failed ? { error: "workstation_artifact_record_failed" } : {}),
	};
}
