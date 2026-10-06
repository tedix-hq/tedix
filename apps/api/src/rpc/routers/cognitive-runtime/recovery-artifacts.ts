import type { BaseContext } from "../../orpc";
import type { DbClient } from "@tedix/db/client";
import {
	type OrphanRunCandidate as DbOrphanRunCandidate,
	type TediRuntimeEventRow,
	findOrphanRuns as findOrphanRunsQuery,
	insertOrphanTerminalEvent,
	listTediRunConversationHints,
	listTediRuntimeEventsForRouter,
	updateTediRuntimeEventPayload,
} from "@tedix/db/queries/cognitive-runtime";
import type {
	RunTerminalReason,
	TediRuntimeEvent,
	TediRuntimeRef,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	bestRuntimeText,
	runtimeEventId,
} from "@tedix/api-contract/utils/runtime-events";
import { buildBodyExecutionResult } from "@tedix/api-contract/utils/body-execution-result";
import { buildHarnessSubjectTraceBundle } from "@tedix/api-contract/utils/trace-bundle";
import {
	traceBundleId as buildTraceBundleId,
	traceReferenceEventIds,
} from "@tedix/context-core/harness-version";
import { ensureActiveKernelHarnessVersion } from "../../../services/harness-persistence";
import { recordHarnessSubjectTraceBundle } from "@tedix/db/queries/harness-version/trace-bundles";
import { findRuntimeEventRow } from "./event-reads";
import {
	insertRuntimeEvent,
	isWorkstationEgressEventKind,
	nonNullRecord,
	normalizeRuntimeEvent,
	nowIso,
	stringFromPayload,
	workstationFromEgressEvent,
} from "./events-policy";

export async function recordWorkstationEgressTraceBundle(
	context: BaseContext,
	input: {
		event: TediRuntimeEvent;
		organizationId: string;
	},
): Promise<void> {
	const { event } = input;
	if (!event.runId || !isWorkstationEgressEventKind(event.kind)) return;
	const payload = nonNullRecord(event.payload) ?? {};
	const runtimeMetadata = nonNullRecord(event.runtime?.metadata) ?? {};
	const traceBundleId = buildTraceBundleId(event.runId);
	const egressTraceBundleId =
		stringFromPayload(payload.traceBundleId) ??
		stringFromPayload(runtimeMetadata.traceBundleId) ??
		null;
	const traceId =
		stringFromPayload(payload.traceId) ??
		stringFromPayload(runtimeMetadata.traceId) ??
		null;
	const decision =
		stringFromPayload(payload.decision) ??
		(event.kind === "workstation.egress.allow" ? "allow" : "deny");
	const host = stringFromPayload(payload.host) ?? null;
	const reason = stringFromPayload(payload.reason) ?? null;
	const workItemId =
		stringFromPayload(payload.workItemId) ??
		stringFromPayload(runtimeMetadata.workItemId) ??
		null;
	const summary = `Workstation egress ${decision}${host ? ` for ${host}` : ""}`;
	const { version } = await ensureActiveKernelHarnessVersion(context.db, {
		orgId: input.organizationId,
		components: {
			workstation_egress: "runtime-event-v1",
		},
		reason: "workstation egress event observed",
		metadata: {
			surface: "workstation.egress",
			source: "cognitiveRuntime.recordEvent",
		},
		createdAt: event.createdAt,
	});
	const bodyExecutionResult = buildBodyExecutionResult({
		bodyKind: "workstation-egress",
		status: "completed",
		runId: event.runId,
		tediId: event.tediId,
		orgId: input.organizationId,
		conversationId: event.conversationId,
		harnessVersionId: version.id,
		traceBundleId,
		workstation: workstationFromEgressEvent(event),
		startedAt: event.createdAt,
		endedAt: event.createdAt,
		summary,
		structuredResult: {
			eventId: event.id,
			kind: event.kind,
			decision,
			host,
			reason,
			traceId,
			egressTraceBundleId,
			workItemId,
		},
		runtimeServices: ["cognitive-runtime", "workstation-egress"],
	});
	await recordHarnessSubjectTraceBundle(
		context.db,
		buildHarnessSubjectTraceBundle({
			id: traceBundleId,
			subjectKind: version.subjectKind,
			subjectId: version.subjectId,
			tediId: null,
			orgId: input.organizationId,
			conversationId: event.conversationId,
			runId: event.runId,
			harnessVersionId: version.id,
			createdAt: event.createdAt,
			eventIds: traceReferenceEventIds(event.id),
			rationaleRecordIds: [],
			artifactIds: [],
			bundleUri: null,
			summary,
			outcome: "success",
			bodyExecutionResult,
			metadata: {
				source: "cognitiveRuntime.recordEvent",
				surface: "workstation.egress",
				delegatedTediId: event.tediId,
				egressEventIds: [event.id],
				egressTraceBundleId,
				traceId,
				decision,
				host,
				reason,
				workItemId,
			},
		}),
	);
}

export function contentFromRuntimeEventRow(
	row: TediRuntimeEventRow,
): string | undefined {
	const payload = nonNullRecord(row.payload);
	return bestRuntimeText(
		row.delta,
		payload?.content,
		payload?.text,
		payload?.message,
		payload?.data,
	);
}

export async function findCompletedMessageForRun(
	context: BaseContext,
	input: {
		conversationId?: string;
		runId?: string;
		tediId: string;
	},
): Promise<TediRuntimeEvent | null> {
	if (!input.runId) return null;
	const row = await findRuntimeEventRow(context, {
		conversationId: input.conversationId,
		kind: "message.completed",
		runId: input.runId,
		tediId: input.tediId,
	});
	return row ? normalizeRuntimeEvent(row) : null;
}

export async function repairCompletedMessageContent(
	context: BaseContext,
	input: {
		existing: TediRuntimeEvent;
		content: string;
		deltaCount?: number;
		mode?: AssembledCompletion["mode"] | "runtime-completed";
		sourceEventId?: string;
		sourceDeltaEventId?: string;
		sourcePayload?: Record<string, unknown>;
	},
): Promise<TediRuntimeEvent> {
	const existingPayload = nonNullRecord(input.existing.payload) ?? {};
	const existingContent =
		bestRuntimeText(
			input.existing.delta,
			existingPayload.content,
			existingPayload.text,
			existingPayload.message,
			existingPayload.data,
		) ?? "";
	if (!input.content || input.content.length <= existingContent.length) {
		return input.existing;
	}
	const payload = {
		...existingPayload,
		...input.sourcePayload,
		role: stringFromPayload(input.sourcePayload?.role) ?? "assistant",
		content: input.content,
		...(input.deltaCount !== undefined
			? {
					deltaCount: input.deltaCount,
				}
			: {}),
		...(input.mode
			? {
					assemblyMode: input.mode,
				}
			: {}),
		...(input.sourceDeltaEventId
			? {
					sourceDeltaEventId: input.sourceDeltaEventId,
				}
			: {}),
		...(input.sourceEventId
			? {
					sourceEventId: input.sourceEventId,
				}
			: {}),
		repairedCompletedEventId: input.existing.id,
		repairedAt: nowIso(),
	};
	const row = await updateTediRuntimeEventPayload(context.db, {
		id: input.existing.id,
		payload,
	});
	return row ? normalizeRuntimeEvent(row) : input.existing;
}

export async function resolveConversationIdForRun(
	context: BaseContext,
	input: {
		fallbackConversationId?: string;
		runId?: string;
		tediId: string;
	},
): Promise<string | undefined> {
	if (input.fallbackConversationId) return input.fallbackConversationId;
	if (!input.runId) return undefined;
	const rows = await listTediRunConversationHints(context.db, {
		tediId: input.tediId,
		runId: input.runId,
		limit: 50,
	});
	return (
		rows.find(
			(row) =>
				row.conversationId &&
				(row.kind === "message.received" ||
					row.kind === "run.started" ||
					row.kind === "conversation.updated"),
		)?.conversationId ??
		rows.find((row) => row.conversationId)?.conversationId ??
		undefined
	);
}

/**
 * Assemble the final assistant message text from a list of `message.delta`
 * rows for a single run. Runtime cognitive streams can emit deltas with
 * mixed semantics observed in production (see
 * `pi-embedded-subscribe.handlers.messages.ts` + ledger audit on
 * f5048ecf/0562024d/49bc21a9/8b8c01b9):
 *
 *   - Cumulative path: each delta carries the full running text. Sequences
 *     are monotonic, content grows as a prefix-extension of prior deltas.
 *   - Chunked path: deltas carry only the new fragment. Concatenated in
 *     sequence order they reconstruct the full message.
 *   - Mixed: the same `sequence` may have BOTH a cumulative row and a
 *     chunked-fragment row (re-emission across the bridge). Trailing
 *     deltas may even be short fragments (e.g. " contradictions.") that
 *     individually do NOT represent the full reply.
 *
 * Strategy:
 *   1. Group by `sequence`, keep the longest content per sequence (the
 *      cumulative form if present, otherwise the only fragment available).
 *   2. Walk the grouped deltas in sequence order. If each successive
 *      content is a strict prefix-extension of the previous (cumulative
 *      mode), the final text is the longest cumulative delta.
 *   3. If the chain breaks (chunked mode), concatenate the per-sequence
 *      longest fragments in order to reconstruct the message.
 *   4. Always prefer the longest available text — never let a trailing
 *      short fragment win, which was the original truncation bug.
 */

export /**
 * Assemble the final assistant message text from a list of `message.delta`
 * rows for a single run. Runtime cognitive streams can emit deltas with
 * mixed semantics observed in production (see
 * `pi-embedded-subscribe.handlers.messages.ts` + ledger audit on
 * f5048ecf/0562024d/49bc21a9/8b8c01b9):
 *
 *   - Cumulative path: each delta carries the full running text. Sequences
 *     are monotonic, content grows as a prefix-extension of prior deltas.
 *   - Chunked path: deltas carry only the new fragment. Concatenated in
 *     sequence order they reconstruct the full message.
 *   - Mixed: the same `sequence` may have BOTH a cumulative row and a
 *     chunked-fragment row (re-emission across the bridge). Trailing
 *     deltas may even be short fragments (e.g. " contradictions.") that
 *     individually do NOT represent the full reply.
 *
 * Strategy:
 *   1. Group by `sequence`, keep the longest content per sequence (the
 *      cumulative form if present, otherwise the only fragment available).
 *   2. Walk the grouped deltas in sequence order. If each successive
 *      content is a strict prefix-extension of the previous (cumulative
 *      mode), the final text is the longest cumulative delta.
 *   3. If the chain breaks (chunked mode), concatenate the per-sequence
 *      longest fragments in order to reconstruct the message.
 *   4. Always prefer the longest available text — never let a trailing
 *      short fragment win, which was the original truncation bug.
 */
type AssembledCompletion = {
	content: string;
	sourceRow: TediRuntimeEventRow | undefined;
	mode: "cumulative" | "chunked" | "longest";
};

export function assembleCompletedContentFromDeltas(
	deltas: TediRuntimeEventRow[],
): AssembledCompletion {
	if (deltas.length === 0) {
		return {
			content: "",
			sourceRow: undefined,
			mode: "longest",
		};
	}

	// Group by sequence. When the bridge re-emits a delta with both
	// cumulative and chunked variants at the same sequence number, keep
	// the longest content (the cumulative form). Deltas with a null
	// sequence get a unique synthetic key based on insertion order so they
	// are preserved individually.
	const grouped = new Map<
		string,
		{
			row: TediRuntimeEventRow;
			content: string;
			sequence: number | null;
			order: number;
		}
	>();
	deltas.forEach((row, index) => {
		const content = contentFromRuntimeEventRow(row) ?? "";
		const key =
			row.sequence !== null && row.sequence !== undefined
				? `seq:${row.sequence}`
				: `idx:${index}`;
		const prior = grouped.get(key);
		if (!prior || content.length > prior.content.length) {
			grouped.set(key, {
				row,
				content,
				sequence: row.sequence ?? null,
				order: index,
			});
		}
	});
	const ordered = [...grouped.values()].sort((a, b) => {
		if (a.sequence !== null && b.sequence !== null) {
			if (a.sequence !== b.sequence) return a.sequence - b.sequence;
		} else if (a.sequence !== null) {
			return -1;
		} else if (b.sequence !== null) {
			return 1;
		}
		return a.order - b.order;
	});

	// Track the longest single delta as a safety fallback.
	let longest: (typeof ordered)[number] | undefined = ordered[0];
	if (!longest) {
		return {
			content: "",
			sourceRow: undefined,
			mode: "longest",
		};
	}
	for (const entry of ordered) {
		if (entry.content.length > longest.content.length) longest = entry;
	}

	// Detect cumulative-mode: each successive longer delta must be a
	// prefix-extension of the running best. Shorter deltas at later
	// sequences are treated as stale/late-arriving chunk fragments and
	// ignored (they must NOT truncate the final text). Cumulative mode
	// is broken only by a strictly-longer delta that does NOT extend the
	// running best — that is the only signal of a genuinely chunked
	// stream where each delta is a new fragment.
	let cumulativeBest: (typeof ordered)[number] | undefined;
	let cumulativeOk = true;
	let cumulativeExtensions = 0;
	for (const entry of ordered) {
		if (!entry.content) continue;
		if (!cumulativeBest) {
			cumulativeBest = entry;
			continue;
		}
		if (entry.content.length <= cumulativeBest.content.length) {
			// Shorter or equal-length delta — treat as a stale chunk
			// fragment regardless of whether it's a prefix of the
			// running best. It cannot represent the full message because
			// we have already seen a longer cumulative form.
			continue;
		}
		if (entry.content.startsWith(cumulativeBest.content)) {
			cumulativeBest = entry;
			cumulativeExtensions += 1;
		} else {
			cumulativeOk = false;
			break;
		}
	}
	// Multi-turn detection: a single runId can carry MULTIPLE assistant
	// turns (re-prompts within the same run). Each turn restarts cumulative
	// from "" — earlier turns end up shorter than the running best and get
	// dropped by the loop above, so the final text would be just the
	// longest single turn. Detect a turn boundary as: a shorter delta that
	// is NOT a prefix of the running best AND is itself subsequently
	// extended by a later delta. (A short non-prefix with no extension is a
	// stale chunk fragment from the same turn — see regression 0562024d.)
	let multiTurnDetected = false;
	{
		let best = "";
		for (let i = 0; i < ordered.length; i++) {
			const entry = ordered[i];
			if (!entry?.content) continue;
			if (entry.content.startsWith(best)) {
				best = entry.content;
				continue;
			}
			// Non-prefix of running best — candidate turn restart. Confirm
			// by scanning forward for a later delta that prefix-extends it.
			for (let j = i + 1; j < ordered.length; j++) {
				const next = ordered[j];
				if (!next?.content) continue;
				if (
					next.content.length > entry.content.length &&
					next.content.startsWith(entry.content)
				) {
					multiTurnDetected = true;
					break;
				}
			}
			if (multiTurnDetected) break;
		}
	}
	if (multiTurnDetected) cumulativeOk = false;
	// Require at least one observed extension before trusting cumulative
	// mode — a single delta could be either a cumulative full text or a
	// lone chunk fragment, but with no chain we can't tell. Fall back to
	// the longest single delta in that case (which equals the only delta
	// when there is just one).
	if (cumulativeOk && cumulativeBest && cumulativeExtensions === 0) {
		cumulativeOk = ordered.filter((e) => e.content).length === 1;
	}
	if (cumulativeOk && cumulativeBest) {
		return {
			content: cumulativeBest.content,
			sourceRow: cumulativeBest.row,
			mode: "cumulative",
		};
	}

	// Chunked / multi-turn mode: collapse maximal cumulative-prefix runs to
	// their longest delta, then concatenate those segment maxima. Some runtime
	// transports emit cumulative deltas per assistant turn: each frame carries
	// the full running text. A single
	// `runId` can carry MULTIPLE assistant turns (re-prompts within the same
	// run), and each turn restarts cumulative from "". Without segmenting,
	// raw concat of every delta produces the catastrophic
	// "Hi—Hi—,Hi—, andHi—, and I…" duplication.
	const segments: string[] = [];
	let segmentBest = "";
	for (const entry of ordered) {
		if (!entry.content) continue;
		if (entry.content === segmentBest) continue;
		if (entry.content.startsWith(segmentBest)) {
			// Prefix-extension of the current turn — keep the longer text.
			segmentBest = entry.content;
			continue;
		}
		// Non-prefix => turn boundary. Flush the previous turn and start fresh.
		if (segmentBest) segments.push(segmentBest);
		segmentBest = entry.content;
	}
	if (segmentBest) segments.push(segmentBest);
	const concatenated = segments.join("");

	// Safety: if concatenation produced something shorter than the single
	// longest delta we observed (which can happen when one delta already
	// contains the full text and the surrounding ones are fragments of
	// it), prefer the longest delta. This guarantees we never truncate.
	if (longest && longest.content.length > concatenated.length) {
		return {
			content: longest.content,
			sourceRow: longest.row,
			mode: "longest",
		};
	}
	const tail = ordered[ordered.length - 1] ?? longest;
	return {
		content: concatenated,
		sourceRow: tail.row,
		mode: "chunked",
	};
}

export async function promoteLatestDeltaToCompletedMessage(
	context: BaseContext,
	input: {
		completedAt?: string;
		conversationId?: string;
		organizationId: string;
		runId?: string;
		runtimeBackend: TediRuntimeRef["backend"];
		tediId: string;
		triggerEventId: string;
	},
): Promise<TediRuntimeEvent | null> {
	if (!input.runId) return null;
	const conversationId = await resolveConversationIdForRun(context, {
		fallbackConversationId: input.conversationId,
		runId: input.runId,
		tediId: input.tediId,
	});
	if (!conversationId) return null;
	let completedAt = input.completedAt;
	if (!completedAt) {
		const completedRuns = await listTediRuntimeEventsForRouter(context.db, {
			tediId: input.tediId,
			runId: input.runId,
			kind: "run.completed",
			order: "desc",
			limit: 1,
		});
		if (!completedRuns[0]) return null;
		completedAt = completedRuns[0].createdAt;
	}
	const deltas = await listTediRuntimeEventsForRouter(context.db, {
		tediId: input.tediId,
		runId: input.runId,
		kind: "message.delta",
		order: "asc",
	});
	if (deltas.length === 0) return null;
	const {
		content: bestContent,
		sourceRow: bestRow,
		mode,
	} = assembleCompletedContentFromDeltas(deltas);
	if (!bestContent || !bestRow) return null;
	const existing = await findCompletedMessageForRun(context, {
		conversationId,
		runId: input.runId,
		tediId: input.tediId,
	});
	if (existing) {
		return repairCompletedMessageContent(context, {
			existing,
			content: bestContent,
			deltaCount: deltas.length,
			mode,
			sourceDeltaEventId: bestRow.id,
		});
	}
	return insertRuntimeEvent(context, {
		organizationId: input.organizationId,
		tediId: input.tediId,
		kind: "message.completed",
		conversationId,
		runId: input.runId,
		messageId: bestRow?.messageId ?? `assistant:${input.runId}`,
		payload: {
			role: "assistant",
			content: bestContent,
			sourceDeltaEventId: bestRow?.id,
			deltaCount: deltas.length,
			assemblyMode: mode,
		},
		runtimeBackend: input.runtimeBackend,
		runtimeExternalId: input.runId,
		runtimeMetadata: {
			source: "cognitiveRuntime.deltaCompletionPromotion",
			triggerEventId: input.triggerEventId,
		},
		createdAt: completedAt,
	});
}

/**
 * Orphan-run sweep.
 *
 * A "run" is orphaned when:
 *   - `run.started` was written more than `orphanAgeMinutes` minutes ago
 *   - no terminator (`run.completed` / `run.failed` / `run.canceled`) exists
 *     for the same `(tediId, runId)`
 *   - no PROGRESS event — `message.delta`, `tool.started` / `tool.completed`
 *     / `tool.failed`, the T1.1 `message.progress` heartbeat, or a
 *     `step.completed` / `step.retry` marker — was written for the same
 *     `(tediId, runId)` in the last `activityWindowMinutes` minutes. Checking
 *     `message.delta` alone would false-seal a turn in a long SILENT tool call
 *     (it emits `tool.*` but no assistant text), so the real `run.completed`
 *     would then be blocked by the terminal dedup. The heartbeat/step kinds
 *     mean LIVENESS (not wall-clock) gates the sweep: a workflow turn mid
 *     deploy-recovery retry (`step.retry`) or a long streaming round with
 *     progress heartbeats is never sealed while it is demonstrably alive.
 *   - the run is NOT parked on an unresolved human approval (an
 *     `approval.requested` with no matching `approval.resolved` is a *waiting*
 *     state, not a dropped one — never seal it as `runtime_dropped`)
 *   - the run is NOT an optimistic enqueue record that has already been mapped
 *     to a canonical backend run. `enqueueMessage`
 *     prewrites `message.received` + `run.started` under the caller's
 *     idempotency key so Tedix OS/MCP reads have an immediate durable row; the first
 *     backend runtime event fills `chat_dispatch_idempotency.run_id`. Once that
 *     mapped run has a terminal/success signal or recent progress, the
 *     optimistic row is a dispatch receipt, not an orphaned runtime run.
 *
 * Originates from runtime drops (gateway wedge during dispatch, cold-boot
 * timeout, worker crash mid-flight) that leave the ledger advertising
 * `queued` forever. The sweep writes a terminal `run.failed` event with
 * `reason: "runtime_dropped"`. Capped per tick to keep latency bounded;
 * historic backlogs drain naturally over a handful of ticks.
 */

export /**
 * Orphan-run sweep.
 *
 * A "run" is orphaned when:
 *   - `run.started` was written more than `orphanAgeMinutes` minutes ago
 *   - no terminator (`run.completed` / `run.failed` / `run.canceled`) exists
 *     for the same `(tediId, runId)`
 *   - no PROGRESS event — `message.delta`, `tool.started` / `tool.completed`
 *     / `tool.failed`, the T1.1 `message.progress` heartbeat, or a
 *     `step.completed` / `step.retry` marker — was written for the same
 *     `(tediId, runId)` in the last `activityWindowMinutes` minutes. Checking
 *     `message.delta` alone would false-seal a turn in a long SILENT tool call
 *     (it emits `tool.*` but no assistant text), so the real `run.completed`
 *     would then be blocked by the terminal dedup. The heartbeat/step kinds
 *     mean LIVENESS (not wall-clock) gates the sweep: a workflow turn mid
 *     deploy-recovery retry (`step.retry`) or a long streaming round with
 *     progress heartbeats is never sealed while it is demonstrably alive.
 *   - the run is NOT parked on an unresolved human approval (an
 *     `approval.requested` with no matching `approval.resolved` is a *waiting*
 *     state, not a dropped one — never seal it as `runtime_dropped`)
 *   - the run is NOT an optimistic enqueue record that has already been mapped
 *     to a canonical backend run. `enqueueMessage`
 *     prewrites `message.received` + `run.started` under the caller's
 *     idempotency key so Tedix OS/MCP reads have an immediate durable row; the first
 *     backend runtime event fills `chat_dispatch_idempotency.run_id`. Once that
 *     mapped run has a terminal/success signal or recent progress, the
 *     optimistic row is a dispatch receipt, not an orphaned runtime run.
 *
 * Originates from runtime drops (gateway wedge during dispatch, cold-boot
 * timeout, worker crash mid-flight) that leave the ledger advertising
 * `queued` forever. The sweep writes a terminal `run.failed` event with
 * `reason: "runtime_dropped"`. Capped per tick to keep latency bounded;
 * historic backlogs drain naturally over a handful of ticks.
 */
const ORPHAN_DEFAULT_AGE_MINUTES = 12;

export const ORPHAN_DEFAULT_ACTIVITY_WINDOW_MINUTES = 12;

export type OrphanRunCandidate = DbOrphanRunCandidate;

export async function findOrphanRuns(
	db: DbClient,
	options: {
		now?: Date;
		organizationId?: string;
		orphanAgeMinutes?: number;
		activityWindowMinutes?: number;
		lookbackDays?: number;
		limit?: number;
	} = {},
): Promise<OrphanRunCandidate[]> {
	return findOrphanRunsQuery(db, options);
}

export type OrphanRunHealth = {
	asOf: string;
	organizationId: string;
	thresholds: {
		orphanAgeMinutes: number;
		activityWindowMinutes: number;
	};
	sampleLimit: number;
	candidateCount: number;
	candidateCountRelation: "exact" | "at_least";
	succeededLostCount: number;
	succeededLostCountRelation: "exact" | "at_least";
	truncated: boolean;
	samples: OrphanRunCandidate[];
};

/**
 * Read-only, org-scoped projection of the exact predicate used by the mutating
 * orphan sweep. Counts are exact when the bounded scan fits; when it does not,
 * the endpoint reports an explicit lower bound rather than inventing fleet
 * precision from a capped page.
 */

/**
 * Read-only, org-scoped projection of the exact predicate used by the mutating
 * orphan sweep. Counts are exact when the bounded scan fits; when it does not,
 * the endpoint reports an explicit lower bound rather than inventing fleet
 * precision from a capped page.
 */
export async function getOrphanRunHealth(
	db: DbClient,
	organizationId: string,
	options: {
		now?: Date;
		orphanAgeMinutes?: number;
		activityWindowMinutes?: number;
		sampleLimit?: number;
	} = {},
): Promise<OrphanRunHealth> {
	const now = options.now ?? new Date();
	const orphanAgeMinutes =
		options.orphanAgeMinutes ?? ORPHAN_DEFAULT_AGE_MINUTES;
	const activityWindowMinutes =
		options.activityWindowMinutes ?? ORPHAN_DEFAULT_ACTIVITY_WINDOW_MINUTES;
	const sampleLimit = options.sampleLimit ?? 25;
	const candidates = await findOrphanRuns(db, {
		now,
		organizationId,
		orphanAgeMinutes,
		activityWindowMinutes,
		limit: sampleLimit + 1,
	});
	const truncated = candidates.length > sampleLimit;
	const relation = truncated ? "at_least" : "exact";
	return {
		asOf: now.toISOString(),
		organizationId,
		thresholds: {
			orphanAgeMinutes,
			activityWindowMinutes,
		},
		sampleLimit,
		candidateCount: candidates.length,
		candidateCountRelation: relation,
		succeededLostCount: candidates.filter(
			(candidate) => candidate.succeededLost,
		).length,
		succeededLostCountRelation: relation,
		truncated,
		samples: candidates.slice(0, sampleLimit),
	};
}

export type OrphanSweepResult = {
	swept: number;
	skipped: number;
	errors: string[];
	sweptRunIds: string[];
	/** Sealed children whose parent Home run was driven terminal via `onSealed`. */
	propagatedRunIds: string[];
};

/** What the sweep tells an `onSealed` hook about a child it just sealed. */
export type OrphanSealedChild = {
	candidate: OrphanRunCandidate;
	terminalKind: "run.completed" | "run.failed";
	message: string;
	sealedAt: string;
};

export async function sweepOrphanRuns(
	db: DbClient,
	options: {
		now?: Date;
		orphanAgeMinutes?: number;
		activityWindowMinutes?: number;
		lookbackDays?: number;
		limit?: number;
		/**
		 * Parent propagation. Invoked once per child the sweep actually sealed
		 * (never for skipped/duplicate seals) so a delegated child's Home run and
		 * delegation receipt can be driven terminal instead of saying "Running"
		 * forever. Returns whether a parent was updated. The tick wires
		 * `propagateSweptChildFailureToHomeRun` here; a hook error is recorded in
		 * `errors` and never blocks the remaining candidates.
		 */
		onSealed?: (sealed: OrphanSealedChild) => Promise<boolean>;
	} = {},
): Promise<OrphanSweepResult> {
	const now = options.now ?? new Date();
	const candidates = await findOrphanRuns(db, {
		...options,
		now,
	});
	const result: OrphanSweepResult = {
		swept: 0,
		skipped: 0,
		errors: [],
		sweptRunIds: [],
		propagatedRunIds: [],
	};
	for (const candidate of candidates) {
		const createdAt = new Date().toISOString();
		// Only a completed message without failure/cancellation markers can
		// recover a lost success terminal. Artifacts prove intermediate output,
		// not turn success. `run.completed` carries no `payload.reason` (taxonomy
		// invariant); recovery provenance lives in `runtimeMetadata` so Mission
		// Control success-rate analytics stay accurate.
		const terminalKind = candidate.succeededLost
			? "run.completed"
			: "run.failed";
		const message = candidate.succeededLost
			? "Runtime produced a completed turn but lost its terminal event. Auto-completed by orphan sweep."
			: "Runtime dropped before emitting a terminal event. Auto-failed by orphan sweep.";
		const id = runtimeEventId({
			conversationId: candidate.conversationId ?? undefined,
			createdAt,
			kind: terminalKind,
			runId: candidate.runId,
			runtimeBackend: candidate.runtimeBackend,
			tediId: candidate.tediId,
		});
		try {
			const inserted = await insertOrphanTerminalEvent(db, {
				id,
				organizationId: candidate.organizationId,
				tediId: candidate.tediId,
				kind: terminalKind,
				conversationId: candidate.conversationId ?? undefined,
				runId: candidate.runId,
				runtimeBackend: candidate.runtimeBackend,
				runtimeExternalId: candidate.runtimeExternalId ?? undefined,
				runtimeMetadata: candidate.succeededLost
					? {
							source: "scheduled.sweepOrphanRuns",
							recoveredFrom: "terminal_lost",
							startedEventId: candidate.startedEventId,
							startedAt: candidate.startedAt,
							sweptAt: createdAt,
						}
					: {
							source: "scheduled.sweepOrphanRuns",
							reason: "runtime_dropped",
							startedEventId: candidate.startedEventId,
							startedAt: candidate.startedAt,
							sweptAt: createdAt,
						},
				payload: candidate.succeededLost
					? { message }
					: {
							reason: "runtime_dropped" satisfies RunTerminalReason,
							message,
						},
				createdAt,
			});
			if (inserted) {
				result.swept += 1;
				result.sweptRunIds.push(candidate.runId);
				if (options.onSealed) {
					try {
						const propagated = await options.onSealed({
							candidate,
							terminalKind,
							message,
							sealedAt: createdAt,
						});
						if (propagated) result.propagatedRunIds.push(candidate.runId);
					} catch (err) {
						result.errors.push(
							`runId=${candidate.runId}: parent propagation failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			} else {
				result.skipped += 1;
			}
		} catch (err) {
			result.errors.push(
				`runId=${candidate.runId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return result;
}
