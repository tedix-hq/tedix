import type {
	HomeRunTrace,
	HomeRunTraceBranch,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { traceBundleId } from "@tedix/context-core/harness-version";
import {
	listHomeRunAuditReferences,
	listHomeRunWakeReceipts,
	listHomeRunWorkstationReferences,
} from "@tedix/db/queries/kernel-home-run-trace";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { listHarnessSubjectTraceBundles } from "../../../services/harness-persistence";
import type { BaseContext } from "../../orpc";
import {
	readChildRunEvidenceRows,
	summarizeChildRuntimeEvents,
	workstationProcessOutcomeFromArtifactEvent,
} from "./child-run-reads";
import { readOptionalHomePlanFromRun } from "./home-plan";
import {
	evaluateHomeRunConvergenceHealth,
	isTerminalHomeRunTraceBranchStatus,
} from "./home-run-health";
import {
	childRunStatusFromSummary,
	nonNullRecord,
	stringFromPayload,
} from "./runtime-shared";

const PARENT_EVENT_LIMIT = 500;
const CHILD_EVENT_LIMIT = 200;
const CHILD_ARTIFACT_LIMIT = 100;
const BRANCH_LIMIT = 20;
const SYNTHESIS_SCAN_LIMIT = 300;

interface HomeRunTraceBranchRef {
	childRunId: string;
	delegatedTediId: string;
	workItemId: string | null;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function elapsedMs(start: string | null, end: string | null): number | null {
	if (!start || !end) return null;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
		return null;
	}
	return Math.round(endMs - startMs);
}

export function homeRunTraceLatency(input: {
	createdAt: string;
	completedAt: string | null;
	wakeReceipts: Array<{ queuedAt: string; ackedAt: string | null }>;
	synthesis: Array<{ createdAt: string }>;
}): HomeRunTrace["latency"] {
	const wakeQueueSamples = input.wakeReceipts.flatMap((wake) => {
		const value = elapsedMs(wake.queuedAt, wake.ackedAt);
		return value === null ? [] : [value];
	});
	const finalWakeQueuedAt = input.wakeReceipts
		.map((wake) => wake.queuedAt)
		.filter((value) => Number.isFinite(Date.parse(value)))
		.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
	const finalSynthesisAt = input.synthesis
		.map((item) => item.createdAt)
		.filter((value) => Number.isFinite(Date.parse(value)))
		.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
	return {
		parentElapsedMs: elapsedMs(input.createdAt, input.completedAt),
		maxWakeQueueMs:
			wakeQueueSamples.length > 0 ? Math.max(...wakeQueueSamples) : null,
		finalWakeToSynthesisMs: elapsedMs(
			finalWakeQueuedAt ?? null,
			finalSynthesisAt ?? null,
		),
	};
}

/** Collect direct-delegation and approved-plan branches without trusting one shape alone. */
export function homeRunTraceBranchRefs(
	row: KernelRuntimeRun,
): HomeRunTraceBranchRef[] {
	const refs: HomeRunTraceBranchRef[] = [];
	const seen = new Set<string>();
	const add = (ref: HomeRunTraceBranchRef): void => {
		const key = `${ref.delegatedTediId}:${ref.childRunId}`;
		if (seen.has(key)) return;
		seen.add(key);
		refs.push(ref);
	};
	const metadata = nonNullRecord(row.metadata);
	const directWorkItemId = stringFromPayload(metadata?.workItemId) ?? null;
	if (row.delegatedTediId && row.childRunId) {
		add({
			delegatedTediId: row.delegatedTediId,
			childRunId: row.childRunId,
			workItemId: directWorkItemId,
		});
	}

	const plan = nonNullRecord(metadata?.homePlan);
	const assignments = Array.isArray(plan?.assignments) ? plan.assignments : [];
	for (const value of assignments) {
		const assignment = nonNullRecord(value);
		const delegatedTediId = stringFromPayload(assignment?.ownerTediId);
		const childRunId = stringFromPayload(assignment?.childRunId);
		if (!delegatedTediId || !childRunId) continue;
		add({
			delegatedTediId,
			childRunId,
			workItemId: stringFromPayload(assignment?.workItemId) ?? null,
		});
	}
	return refs;
}

export function homeRunTraceBranchEvidence(input: {
	ref: HomeRunTraceBranchRef;
	rows: Awaited<ReturnType<typeof readChildRunEvidenceRows>>;
}): HomeRunTraceBranch {
	const { artifactRows, eventRows, observedRunIds } = input.rows;
	const summary = summarizeChildRuntimeEvents(eventRows);
	const eventIds = eventRows.map((event) => event.id);
	const terminalEvent = eventRows.find(
		(event) =>
			event.kind === "run.completed" ||
			event.kind === "run.failed" ||
			event.kind === "run.canceled",
	);
	const finalMessage = eventRows.find(
		(event) => event.kind === "message.completed",
	);
	return {
		...input.ref,
		status: childRunStatusFromSummary(summary),
		observedRunIds,
		eventIds,
		auditEventIds: [],
		toolEventIds: eventRows
			.filter((event) => event.kind.startsWith("tool."))
			.map((event) => event.id),
		workstationEventIds: eventRows
			.filter(
				(event) =>
					event.kind.startsWith("workstation.") ||
					workstationProcessOutcomeFromArtifactEvent(event) !== null,
			)
			.map((event) => event.id),
		artifactIds: artifactRows.map((artifact) => artifact.id),
		finalMessageEventId: finalMessage?.id ?? null,
		terminalEventId: terminalEvent?.id ?? null,
		latestEventAt: eventRows[0]?.createdAt ?? null,
		evidenceAvailable: eventRows.length > 0 || artifactRows.length > 0,
		truncated:
			eventRows.length >= CHILD_EVENT_LIMIT ||
			artifactRows.length >= CHILD_ARTIFACT_LIMIT,
	};
}

export function synthesisChildRunIds(input: { payload: unknown }): string[] {
	const payload = nonNullRecord(input.payload);
	const payloadMetadata = nonNullRecord(payload?.metadata);
	const branchRunIds = Array.isArray(payloadMetadata?.branchRunIds)
		? payloadMetadata.branchRunIds.filter(
				(id): id is string => typeof id === "string",
			)
		: [];
	const directChildRunId =
		typeof payloadMetadata?.childRunId === "string"
			? payloadMetadata.childRunId
			: null;
	// Plan convergence carries its authoritative branch set in the payload.
	// Direct async completion carries one canonical child id.
	return uniqueStrings(
		branchRunIds.length > 0
			? branchRunIds
			: directChildRunId
				? [directChildRunId]
				: [],
	);
}

export function synthesisEventBelongsToHomeRun(input: {
	eventRunId: string | null;
	homeRunId: string;
	hasHomePlan: boolean;
}): boolean {
	// A plan-convergence event is persisted under its parent Home run. Alarm
	// runtime metadata is only transport context and may batch children from
	// multiple concurrent plans, so it must never override this exact anchor.
	// Direct delegations predate plan-convergence events and still rely on the
	// child-id evidence join below.
	return !input.hasHomePlan || input.eventRunId === input.homeRunId;
}

/** Cancellation intentionally terminates convergence without a synthesis wake. */
export function homeRunTraceRequiresSynthesis(input: {
	branchCount: number;
	status: string;
}): boolean {
	return (
		input.branchCount > 0 &&
		(input.status === "completed" || input.status === "failed")
	);
}

/** A canceled parent deliberately abandons queued wake work. */
export function homeRunTraceWakeIsPending(input: {
	ackedAt: string | null;
	parentStatus: string;
}): boolean {
	return input.parentStatus !== "canceled" && input.ackedAt === null;
}

/** Assemble a bounded reference graph; canonical payloads remain in their owning ledgers. */
export async function assembleHomeRunTrace(
	context: BaseContext,
	row: KernelRuntimeRun,
	assembledAt = new Date().toISOString(),
): Promise<HomeRunTrace> {
	const plan = readOptionalHomePlanFromRun(row);
	const allBranchRefs = homeRunTraceBranchRefs(row);
	const branchRefs = allBranchRefs.slice(0, BRANCH_LIMIT);
	const parentEventsPromise = listKernelRuntimeEvents(context.db, {
		organizationId: row.organizationId,
		runId: row.id,
		order: "asc",
		limit: PARENT_EVENT_LIMIT,
	});
	const branchesPromise = Promise.all(
		branchRefs.map(async (ref) =>
			homeRunTraceBranchEvidence({
				ref,
				rows: await readChildRunEvidenceRows(context, {
					artifactLimit: CHILD_ARTIFACT_LIMIT,
					eventLimit: CHILD_EVENT_LIMIT,
					includeMappedWorkstationRun: true,
					kernelRunId: row.id,
					organizationId: row.organizationId,
					runId: ref.childRunId,
					tediId: ref.delegatedTediId,
				}),
			}),
		),
	);
	const childRunIds = branchRefs.map((ref) => ref.childRunId);
	const auditPromise = listHomeRunAuditReferences(context.db, {
		organizationId: row.organizationId,
		childRunIds,
		limit: BRANCH_LIMIT * 20,
	});
	const wakePromise = listHomeRunWakeReceipts(context.db, {
		organizationId: row.organizationId,
		childRunIds,
		limit: BRANCH_LIMIT * 4,
	});
	const synthesisScanPromise =
		childRunIds.length > 0
			? listKernelRuntimeEvents(context.db, {
					organizationId: row.organizationId,
					conversationId: row.conversationId,
					kind: "message.completed",
					order: "desc",
					limit: SYNTHESIS_SCAN_LIMIT,
				})
			: Promise.resolve([]);
	const anchorPromise = listHarnessSubjectTraceBundles(context.db, {
		subjectKind: "kernel",
		subjectId: `kernel:${row.organizationId}`,
		runId: row.id,
		limit: 1,
	});
	const workstationReferencesPromise = listHomeRunWorkstationReferences(
		context.db,
		{
			organizationId: row.organizationId,
			kernelRunId: row.id,
			limit: BRANCH_LIMIT * 4,
		},
	);

	const [
		parentEvents,
		rawBranches,
		wakeRows,
		synthesisRows,
		anchors,
		auditRows,
		workstationReferences,
	] = await Promise.all([
		parentEventsPromise,
		branchesPromise,
		wakePromise,
		synthesisScanPromise,
		anchorPromise,
		auditPromise,
		workstationReferencesPromise,
	]);
	const auditIdsByTrace = new Map<string, string[]>();
	for (const audit of auditRows) {
		if (!audit.traceId) continue;
		const ids = auditIdsByTrace.get(audit.traceId) ?? [];
		ids.push(audit.id);
		auditIdsByTrace.set(audit.traceId, ids);
	}
	const branches = rawBranches.map((branch) => ({
		...branch,
		auditEventIds: auditIdsByTrace.get(branch.childRunId) ?? [],
	}));
	const childRunIdSet = new Set(childRunIds);
	const synthesis = synthesisRows.flatMap((event) => {
		if (
			!synthesisEventBelongsToHomeRun({
				eventRunId: event.runId,
				homeRunId: row.id,
				hasHomePlan: plan !== null,
			})
		) {
			return [];
		}
		const ids = synthesisChildRunIds(event).filter((id) =>
			childRunIdSet.has(id),
		);
		if (ids.length === 0 || !event.runId) return [];
		const payload = nonNullRecord(event.payload);
		const content = stringFromPayload(payload?.content)?.trim() ?? null;
		return [
			{
				runId: event.runId,
				eventId: event.id,
				childRunIds: ids,
				contentPreview: content ? content.slice(0, 1_000) : null,
				createdAt: event.createdAt,
			},
		];
	});
	const gaps: string[] = [];
	const terminalParent =
		row.status === "completed" ||
		row.status === "failed" ||
		row.status === "canceled";
	if (!terminalParent) gaps.push("parent_not_terminal");
	if (parentEvents.length === 0) gaps.push("parent_events_missing");
	if (parentEvents.length >= PARENT_EVENT_LIMIT)
		gaps.push("parent_events_truncated");
	if (allBranchRefs.length > BRANCH_LIMIT) gaps.push("branch_limit_exceeded");
	for (const branch of branches) {
		if (!branch.evidenceAvailable)
			gaps.push(`child_evidence_missing:${branch.childRunId}`);
		if (!isTerminalHomeRunTraceBranchStatus(branch.status))
			gaps.push(`child_not_terminal:${branch.childRunId}`);
		if (branch.truncated)
			gaps.push(`child_evidence_truncated:${branch.childRunId}`);
	}
	for (const wake of wakeRows) {
		if (
			homeRunTraceWakeIsPending({
				ackedAt: wake.ackedAt,
				parentStatus: row.status,
			})
		) {
			gaps.push(`wake_pending:${wake.childRunId}`);
		}
	}
	if (
		homeRunTraceRequiresSynthesis({
			branchCount: branches.length,
			status: row.status,
		}) &&
		synthesis.length === 0
	) {
		gaps.push("final_synthesis_missing");
	}
	const anchor = anchors[0] ?? null;
	const kernelEventIds = uniqueStrings([
		...parentEvents.map((event) => event.id),
		...synthesis.map((item) => item.eventId),
		...(anchor?.eventIds ?? []),
	]);
	const tediEventIds = uniqueStrings(
		branches.flatMap((branch) => branch.eventIds),
	);
	const artifactIds = uniqueStrings([
		...branches.flatMap((branch) => branch.artifactIds),
		...(anchor?.artifactIds ?? []),
	]);
	const latency = homeRunTraceLatency({
		createdAt: row.createdAt,
		completedAt: row.completedAt,
		wakeReceipts: wakeRows,
		synthesis,
	});
	const traceWithoutHealth = {
		version: "home-run-trace.v1",
		organizationId: row.organizationId,
		conversationId: row.conversationId,
		homeRunId: row.id,
		// The converged graph has a stable identity even when the optional harness
		// snapshot was not recorded (notably the deterministic Home-plan path).
		// `sources` still tells callers whether a harness bundle contributed.
		traceBundleId: anchor?.id ?? expectedHomeTraceBundleId(row.id),
		harnessVersionId:
			anchor?.harnessVersionId ??
			stringFromPayload(nonNullRecord(row.metadata)?.harnessVersionId) ??
			null,
		status: row.status,
		parentEventIds: parentEvents.map((event) => event.id),
		branches,
		wakeReceipts: wakeRows.map((wake) => ({
			id: wake.id,
			childRunId: wake.childRunId,
			childStatus: wake.childStatus,
			queuedAt: wake.queuedAt,
			ackedAt: wake.ackedAt,
			queueLatencyMs: elapsedMs(wake.queuedAt, wake.ackedAt),
		})),
		synthesis,
		latency,
		eventIds: {
			kernel: kernelEventIds,
			tedi: tediEventIds,
			audit: uniqueStrings(auditRows.map((event) => event.id)),
		},
		artifactIds,
		assembledAt,
		sources: [
			...(anchor ? (["harness_subject_trace_bundles"] as const) : []),
			"kernel_runtime_events",
			"tedi_runtime_events",
			"tedi_artifacts",
			"kernel_wake_queue",
			...(auditRows.length > 0 ? (["audit_events"] as const) : []),
		],
	} satisfies Omit<HomeRunTrace, "complete" | "gaps" | "health">;
	const rowMetadata = nonNullRecord(row.metadata);
	const health = evaluateHomeRunConvergenceHealth({
		trace: traceWithoutHealth,
		requiredChildRunIds: plan?.assignments.flatMap((assignment) =>
			assignment.required && assignment.childRunId
				? [assignment.childRunId]
				: [],
		),
		workstationReferences: workstationReferences.map((reference) => ({
			id: reference.id,
			workItemId: reference.workItemId,
			childRunId:
				stringFromPayload(nonNullRecord(reference.metadata)?.childRunId) ??
				null,
		})),
		synthesisFailureCount:
			typeof rowMetadata?.synthesisFailureCount === "number"
				? rowMetadata.synthesisFailureCount
				: undefined,
		redriveCount:
			typeof rowMetadata?.redriveCount === "number"
				? rowMetadata.redriveCount
				: undefined,
	});
	for (const finding of health.findings) {
		if (finding.severity !== "error") continue;
		gaps.push(
			`convergence_health:${finding.code}${
				finding.childRunId ? `:${finding.childRunId}` : ""
			}`,
		);
	}
	const uniqueGaps = uniqueStrings(gaps);
	return {
		...traceWithoutHealth,
		health,
		complete: uniqueGaps.length === 0,
		gaps: uniqueGaps,
	};
}

export function expectedHomeTraceBundleId(homeRunId: string): string {
	return traceBundleId(homeRunId);
}
