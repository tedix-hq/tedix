import type { BodyExecutionResult } from "../schemas/body-certification";
import {
	type HarnessSubjectKind,
	type HarnessSubjectTraceBundle,
	HarnessSubjectTraceBundleSchema,
	type TraceBundle,
	type TraceBundleOutcome,
	TraceBundleSchema,
	type TraceBundleWorkstation,
} from "../schemas/harness-version";

export function traceBundleMetadata(input: {
	bodyExecutionResult: BodyExecutionResult;
	extraMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> {
	return {
		...input.extraMetadata,
		bodyExecutionResult: input.bodyExecutionResult,
	};
}

export function traceBundleWorkstationFromBodyResult(input: {
	workstation: BodyExecutionResult["workstation"];
}): TraceBundleWorkstation | null {
	const workstation = input.workstation;
	if (!workstation) return null;
	return {
		profileId: workstation.profileId,
		workstationId: workstation.workstationId,
		leaseId: workstation.leaseId,
		sessionIds: workstation.sessionId ? [workstation.sessionId] : [],
		participantIds: workstation.participantIds,
	};
}

interface TraceBundleFields {
	id: string;
	orgId?: string | null;
	conversationId?: string | null;
	runId: string;
	harnessVersionId: string;
	createdAt: string;
	eventIds?: string[];
	rationaleRecordIds?: string[];
	artifactIds?: string[];
	evalResultId?: string | null;
	bundleUri?: string | null;
	summary?: string | null;
	outcome?: TraceBundleOutcome;
	bodyExecutionResult: BodyExecutionResult;
	metadata?: Record<string, unknown> | null;
}

export function buildTraceBundle(
	input: TraceBundleFields & { tediId: string },
): TraceBundle {
	return TraceBundleSchema.parse({
		id: input.id,
		tediId: input.tediId,
		orgId: input.orgId ?? undefined,
		conversationId: input.conversationId ?? undefined,
		runId: input.runId,
		harnessVersionId: input.harnessVersionId,
		createdAt: input.createdAt,
		eventIds: input.eventIds ?? [],
		rationaleRecordIds: input.rationaleRecordIds ?? [],
		artifactIds: input.artifactIds ?? [],
		workstation: traceBundleWorkstationFromBodyResult(
			input.bodyExecutionResult,
		),
		evalResultId: input.evalResultId ?? null,
		bundleUri: input.bundleUri ?? null,
		summary: input.summary ?? null,
		outcome: input.outcome,
		metadata: traceBundleMetadata({
			bodyExecutionResult: input.bodyExecutionResult,
			extraMetadata: input.metadata,
		}),
	});
}

export function buildHarnessSubjectTraceBundle(
	input: TraceBundleFields & {
		subjectKind: HarnessSubjectKind;
		subjectId: string;
		tediId?: string | null;
	},
): HarnessSubjectTraceBundle {
	return HarnessSubjectTraceBundleSchema.parse({
		id: input.id,
		subjectKind: input.subjectKind,
		subjectId: input.subjectId,
		tediId: input.tediId ?? null,
		orgId: input.orgId ?? undefined,
		conversationId: input.conversationId ?? undefined,
		runId: input.runId,
		harnessVersionId: input.harnessVersionId,
		createdAt: input.createdAt,
		eventIds: input.eventIds ?? [],
		rationaleRecordIds: input.rationaleRecordIds ?? [],
		artifactIds: input.artifactIds ?? [],
		workstation: traceBundleWorkstationFromBodyResult(
			input.bodyExecutionResult,
		),
		evalResultId: input.evalResultId ?? null,
		bundleUri: input.bundleUri ?? null,
		summary: input.summary ?? null,
		outcome: input.outcome,
		metadata: traceBundleMetadata({
			bodyExecutionResult: input.bodyExecutionResult,
			extraMetadata: input.metadata,
		}),
	});
}
