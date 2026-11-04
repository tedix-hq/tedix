import { ExecutionRequirementSchema } from "@tedix/api-contract/schemas/execution-evidence";
import { workstationDispatchIdentity } from "../kernel/workstation-dispatch";
import type { RespondHomeApprovalInput } from "@tedix/api-contract/schemas/kernel-runtime";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { claimApprovedHomeDelegationResume } from "@tedix/db/queries/kernel-runtime-runs";
import {
	listKernelRuntimeEvents,
	type KernelRuntimeEvent,
} from "@tedix/db/queries/kernel-runtime-events";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { deriveWorkItemReadiness } from "@tedix/db/queries/work-items/readiness";
import { toJsonRecord } from "@tedix/db/utils/json";
import { createError, ErrorCodes, type BaseContext } from "../../orpc";
import { normalizeHomeRunRecord } from "../kernel/run-store-normalization";
import {
	nonNullRecord,
	predictAgentRunId,
	nowIso,
	stringFromPayload,
} from "../kernel/runtime-shared";
import { approvedExecutionWorkOrder } from "./turn-delegation";

type ResumeInput = Extract<RespondHomeApprovalInput, { resumeOnly: true }>;

function refused(message: string): never {
	throw createError(
		ErrorCodes.CONFLICT,
		`Recorded approval cannot continue: ${message}`,
	);
}

function canonical(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = nonNullRecord(value);
	if (!record) return refused("approval scope is not JSON");
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

/** All candidate bindings are server-retained; conflicting historical bindings never select a new Work. */
function savedWorkItemId(run: KernelRuntimeRun): string {
	const metadata = nonNullRecord(run.metadata);
	const savedRuntime = nonNullRecord(
		nonNullRecord(metadata?.redriveInput)?.runtimeMetadata,
	);
	const values = [
		metadata?.workItemId,
		nonNullRecord(run.runtimeMetadata)?.workItemId,
		savedRuntime?.workItemId,
	];
	const ids = values.filter((value) => value !== undefined && value !== null);
	if (
		ids.length === 0 ||
		ids.some((value) => typeof value !== "string" || value.length === 0) ||
		new Set(ids).size !== 1
	)
		return refused("saved Work binding is missing or ambiguous");
	return ids[0] as string;
}

export function recordedDelegationApprovalScope(
	run: KernelRuntimeRun,
	event: KernelRuntimeEvent,
	now: string,
) {
	const metadata = nonNullRecord(run.metadata);
	const delegation = nonNullRecord(metadata?.homeDelegation);
	const draft = nonNullRecord(delegation?.workOrder);
	const decision = nonNullRecord(delegation?.decision);
	const payload = nonNullRecord(event.payload);
	const approved = nonNullRecord(payload?.delegationWorkOrder);
	const producer = nonNullRecord(event.runtimeMetadata);
	const targetTediId = stringFromPayload(draft?.targetTediId);
	const actor = nonNullRecord(payload?.resolvedBy);
	if (
		!delegation ||
		!draft ||
		!targetTediId ||
		decision?.mode !== "needs_approval"
	)
		return refused("the original delegation hold is unavailable");
	if (
		event.organizationId !== run.organizationId ||
		event.runId !== run.id ||
		event.conversationId !== run.conversationId ||
		event.delegatedTediId !== targetTediId ||
		event.kind !== "approval.resolved"
	)
		return refused("receipt belongs to another delegation");
	if (
		event.id !==
		[
			"home",
			run.organizationId,
			"event",
			"delegation.approval.resolved",
			run.conversationId,
			run.id,
			event.createdAt,
		].join(":")
	)
		return refused("receipt identity is not canonical");
	if (
		producer?.source !== "kernelRuntime.respondApproval" ||
		producer.dispatch !== "home-delegation-approved" ||
		payload?.status !== "approved" ||
		approved?.status !== "approved"
	)
		return refused("receipt is not an approved operator delegation");
	// Legacy operator resolutions deliberately omitted resolvedBy. Preserve that NULL; never invent a user identity.
	if (
		payload.resolvedBy !== null &&
		payload.resolvedBy !== undefined &&
		(!actor ||
			actor.type !== "user" ||
			typeof actor.id !== "string" ||
			actor.id.length === 0)
	)
		return refused("receipt is not an operator decision");
	const expiresAt =
		typeof delegation.expiresAt === "string"
			? Date.parse(delegation.expiresAt)
			: NaN;
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now))
		return refused("the original approval hold expired");
	const expected = nonNullRecord(metadata?.homeDelegationResume)
		? { ...draft, status: "approved" }
		: approvedExecutionWorkOrder({
				delegation,
				workOrder: { ...draft, status: "approved" },
				note:
					typeof payload.resolution === "string"
						? payload.resolution
						: undefined,
			});
	const expectedJson = canonical(expected);
	if (
		new TextEncoder().encode(expectedJson).byteLength > 256 * 1024 ||
		expectedJson !== canonical(approved)
	)
		return refused("the approved work order changed");
	return {
		workItemId: savedWorkItemId(run),
		targetTediId,
		workOrder: approved!,
		resolvedBy: payload.resolvedBy ?? null,
		scope: expectedJson,
	};
}

export async function delegationApprovalScopeDigest(input: {
	organizationId: string;
	runId: string;
	conversationId: string;
	targetTediId: string;
	workItemId: string | null;
	workOrder: Record<string, unknown>;
}) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical(input)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function resumeRecordedHomeDelegationApproval(
	context: BaseContext,
	input: ResumeInput,
	run: KernelRuntimeRun,
) {
	const now = nowIso();
	const events = await listKernelRuntimeEvents(context.db, {
		organizationId: run.organizationId,
		conversationId: run.conversationId,
		runId: run.id,
		kind: "approval.resolved",
		order: "desc",
		limit: 2,
	});
	if (events.length !== 1 || events[0]!.id !== input.approvalEventId)
		return refused("receipt is absent, superseded or ambiguous");
	const event = events[0]!;
	const scope = recordedDelegationApprovalScope(run, event, now);
	const execution = ExecutionRequirementSchema.safeParse(
		scope.workOrder.executionRequirement,
	);
	if (!execution.success || !execution.data.satisfiable)
		return refused("recorded execution surface is unavailable");
	const expectedChildRunId =
		execution.data.surface === "workstation"
			? workstationDispatchIdentity({
					homeRunId: run.id,
					target: { id: scope.targetTediId },
				}).runtimeRunId
			: predictAgentRunId({
					clientRequestId: `${run.id}:approved:${scope.targetTediId}`,
					tediId: scope.targetTediId,
				});
	const work = await getWorkItemById(
		context.db,
		scope.workItemId,
		run.organizationId,
	);
	if (
		!work ||
		work.orgId !== run.organizationId ||
		work.disposition !== "accepted" ||
		work.version !== input.expectedWorkItemVersion
	)
		return refused(
			"current Work version differs from the requested continuation",
		);
	const scopeDigest = await delegationApprovalScopeDigest({
		organizationId: run.organizationId,
		runId: run.id,
		conversationId: run.conversationId,
		targetTediId: scope.targetTediId,
		workItemId: work.id,
		workOrder: scope.workOrder,
	});
	const marker = nonNullRecord(
		nonNullRecord(run.metadata)?.homeDelegationResume,
	);
	if (marker) {
		const initialObservation = nonNullRecord(marker.observation);
		const lateObservation = nonNullRecord(marker.lateObservation);
		const observation =
			initialObservation?.outcome === "unknown" &&
			lateObservation?.outcome === "acknowledged"
				? lateObservation
				: initialObservation;
		if (
			marker.approvalEventId === event.id &&
			marker.phase === "observed" &&
			observation?.outcome === "acknowledged" &&
			marker.scopeDigest === scopeDigest &&
			typeof observation.observedChildRunId === "string" &&
			observation.observedChildRunId === marker.expectedChildRunId &&
			marker.expectedChildRunId === expectedChildRunId &&
			(run.childRunId === observation.observedChildRunId ||
				(run.status === "canceled" && run.childRunId === null)) &&
			marker.workItemId === scope.workItemId &&
			marker.workItemVersion === input.expectedWorkItemVersion &&
			(run.delegatedTediId === scope.targetTediId ||
				(run.status === "canceled" && run.delegatedTediId === null))
		)
			return { run: normalizeHomeRunRecord(run), assignments: [] };
		return refused(
			"an earlier continuation may already have effects; inspect its recorded result",
		);
	}
	if (
		run.status !== "requires_approval" ||
		run.updatedAt !== event.createdAt ||
		run.childRunId ||
		run.delegatedTediId ||
		run.childConversationId ||
		nonNullRecord(run.metadata)?.homeApprovedDispatch ||
		nonNullRecord(nonNullRecord(run.metadata)?.homeDelegation)?.resolutionStatus
	)
		return refused("the run changed after its recorded approval");
	const readiness = await deriveWorkItemReadiness(context.db, {
		orgId: run.organizationId,
		workItemId: work.id,
		derivedAt: now,
	});
	if (!readiness.ready)
		return refused(`current Work admission is blocked (${readiness.state})`);
	const claimId = crypto.randomUUID();
	const claimed = await claimApprovedHomeDelegationResume(context.db, {
		organizationId: run.organizationId,
		runId: run.id,
		conversationId: run.conversationId,
		expectedUpdatedAt: run.updatedAt,
		expectedLatestEventAt: run.latestEventAt,
		expectedMetadata: toJsonRecord(run.metadata),
		approvalEventId: event.id,
		approvalResolvedAt: event.createdAt,
		targetTediId: scope.targetTediId,
		expectedChildRunId,
		workItemId: work.id,
		workItemVersion: work.version,
		admissionSpecRevision: work.admissionSpecRevision,
		scopeDigest,
		now,
		claimId,
	});
	if (!claimed)
		return refused(
			"another decision, cancellation or Work change won the continuation claim",
		);
	const { respondKernelDelegationRecommendationApprovalCore } =
		await import("./approval-control");
	return respondKernelDelegationRecommendationApprovalCore(context, {
		decision: "approve",
		organizationId: run.organizationId,
		run: claimed,
		approvedWorkItemId: work.id,
		recordedApproval: {
			claimId,
			eventId: event.id,
			resolvedAt: event.createdAt,
			workOrder: scope.workOrder,
			resolvedBy: nonNullRecord(scope.resolvedBy) ?? null,
			resolution:
				typeof nonNullRecord(event.payload)?.resolution === "string"
					? (nonNullRecord(event.payload)!.resolution as string)
					: null,
		},
	});
}
