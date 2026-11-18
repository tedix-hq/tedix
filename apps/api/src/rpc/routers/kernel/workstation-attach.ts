/**
 * Kernel — workstation-attach approval plumbing. Builds the workstation-attach
 * delegation work order, ensures/parses its approval-request payload, and
 * records the kernel harness trace bundle for the attach decision. This module
 * must NOT import kernel-runtime.ts (the router imports this module; a value
 * import back would create a cycle).
 */

import type {
	DelegationWorkOrder,
	KernelRuntimeEvent,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
import { buildBodyExecutionResult } from "@tedix/api-contract/utils/body-execution-result";
import { buildHarnessSubjectTraceBundle } from "@tedix/api-contract/utils/trace-bundle";
import {
	traceBundleId as buildTraceBundleId,
	traceReferenceEventIds,
} from "@tedix/context-core/harness-version";
import {
	createApprovalRequest,
	getApprovalRequestById,
} from "@tedix/db/queries/approvals";
import { recordHarnessSubjectTraceBundle } from "@tedix/db/queries/harness-version/trace-bundles";
import { toJsonRecord } from "@tedix/db/utils/json";
import { ensureActiveKernelHarnessVersion } from "../../../services/harness-persistence";
import type { BaseContext } from "../../orpc";
import {
	errorMessage,
	nonNullRecord,
	offsetIso,
	stringFromPayload,
} from "./runtime-shared";

export function workstationAttachWorkOrder(input: {
	approvalRequestId: string;
	content: string;
	delegateToTediId: string;
	runId: string;
	workItemId?: string | null;
	verifyCommand?: string | null;
	executionRequirement?: ExecutionRequirement;
}): DelegationWorkOrder & { workItemId?: string } {
	const verifyCommand = input.verifyCommand?.trim() || null;
	const requestPreview =
		input.content.length > 180
			? `${input.content.slice(0, 177)}...`
			: input.content;
	return {
		id: `work-order:${input.runId}`,
		approvalRequestId: input.approvalRequestId,
		kind: "workstation.attach",
		...(input.workItemId ? { workItemId: input.workItemId } : {}),
		...(verifyCommand ? { verifyCommand } : {}),
		status: "requires_approval",
		authorityMode: "shadow",
		targetTediId: input.delegateToTediId,
		objective: "Fulfill the Home operator request in Source request.",
		outputContract:
			"Start the final response with exactly `Outcome: succeeded`, `Outcome: failed`, or `Outcome: needs_follow_up`. Return a concise result with the evidence (sources/tool outputs) that supports it, and name any requested work that remains undone.",
		toolGuidance: [
			"Use the selected workstation adapter for shell, filesystem, browser, process, or native dependency work when needed.",
		],
		boundaries: [
			"Stay within the approved Home work order.",
			"Publish progress through the runtime event stream and stop if the task needs authority beyond the work order.",
			"Continue while execution authority is valid; honor cancellation, enforced runtime budgets, and any explicit task deadline.",
			...(input.workItemId
				? [
						"For this Home-delegated run, the runtime renews the exact assigned Work Attempt, including while Computer commands are pending. When waiting for a pending Computer command, end the current response to yield; the same Home run stays pending and resumes with completion evidence. Do not settle the Work Item or use shell sleeps merely to wait; stop if its authority expires or is revoked.",
					]
				: []),
		],
		executionRequirement: input.executionRequirement ?? {
			surface: "workstation",
			requiredCapabilities: ["process"],
			fallbackSurface: null,
			prohibitedSurfaces: [],
			satisfiable: true,
			reason: "the approved work order attaches an interactive workstation",
		},
		contract: {
			successCriteria: [
				"every claimed action cites the mutating tool receipt that performed it",
				"anything the output contract asks for that is not delivered is named explicitly as missing",
			],
			budgetHint: "use the approved workstation lease only for this work order",
			// Approval expiry governs dispatch, not the admitted task's duration.
			// No execution deadline is supplied here; the renderer omits empty hints.
			deadlineHint: "",
			failurePolicy:
				"fail_closed — if the criteria cannot be met, report the unmet criterion",
		},
		traceExcerpts: [],
		projectValidation: false,
		outputSchema: null,
		sourceContent: input.content,
		resultContract: {
			progressEvents: true,
			timeoutSemantics: "required-before-dispatch",
			commitAck: "required-before-dispatch",
			visibleHomeWorkCard: true,
		},
		requestPreview,
	};
}

export async function ensureWorkstationAttachApprovalRequest(
	context: BaseContext,
	input: {
		approvalRequestId: string;
		content: string;
		conversationId: string;
		createdAt: string;
		delegateToTediId: string;
		organizationId: string;
		runId: string;
		workOrder: Record<string, unknown>;
		/** Approval window in hours; defaults to 24h when absent. */
		ttlHours?: number;
	},
) {
	const existing = await getApprovalRequestById(
		context.db,
		input.approvalRequestId,
	);
	if (existing) return existing;
	const ttlHours = input.ttlHours ?? 24;
	return createApprovalRequest(context.db, {
		id: input.approvalRequestId,
		tediId: input.delegateToTediId,
		orgId: input.organizationId,
		actionType: "workstation.attach",
		description: "Approve certified Home workstation attachment",
		payload: toJsonRecord({
			source: "home.workstation_attach",
			homeRunId: input.runId,
			homeConversationId: input.conversationId,
			delegateToTediId: input.delegateToTediId,
			requestPreview:
				input.content.length > 280
					? `${input.content.slice(0, 277)}...`
					: input.content,
			workOrder: input.workOrder,
		}),
		createdAt: input.createdAt,
		expiresAt: offsetIso(input.createdAt, ttlHours * 60 * 60 * 1000),
	});
}

export function homeWorkstationAttachPayload(value: unknown): {
	delegateToTediId: string;
	homeConversationId: string;
	homeRunId: string;
	workOrder?: Record<string, unknown> | null;
} | null {
	const payload = nonNullRecord(value);
	if (payload?.source !== "home.workstation_attach") return null;
	const homeRunId = stringFromPayload(payload.homeRunId);
	const homeConversationId = stringFromPayload(payload.homeConversationId);
	const delegateToTediId = stringFromPayload(payload.delegateToTediId);
	if (!homeRunId || !homeConversationId || !delegateToTediId) return null;
	return {
		homeRunId,
		homeConversationId,
		delegateToTediId,
		workOrder: nonNullRecord(payload.workOrder),
	};
}

function summaryExcerpt(content: string | null | undefined): string | null {
	if (!content) return null;
	const compact = content.replace(/\s+/g, " ").trim();
	if (!compact) return null;
	return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

export async function recordWorkstationAttachKernelTraceBundle(
	context: BaseContext,
	input: {
		approvalRequestId: string | null;
		assistantContent: string;
		assistantEvent: KernelRuntimeEvent;
		autoApprovedAttach: boolean;
		childRunId: string | null;
		completedAt: string;
		conversationId: string;
		delegatedTediId: string;
		dispatchPolicy: Record<string, unknown> | null;
		organizationId: string;
		runId: string;
		startedAt: string;
		terminalEvent: KernelRuntimeEvent;
		workItemId: string | null;
		workstationDispatchNow: boolean;
	},
): Promise<void> {
	try {
		const { version } = await ensureActiveKernelHarnessVersion(context.db, {
			orgId: input.organizationId,
			components: {
				home_dispatch: "direct-workstation-attach-v1",
			},
			reason: "direct Home workstation attachment observed",
			metadata: {
				surface: "home.workstation_attach",
				source: "kernelRuntime.enqueueMessage",
			},
			createdAt: input.startedAt,
		});
		const traceBundleId = buildTraceBundleId(input.runId);
		const bodyExecutionResult = buildBodyExecutionResult({
			bodyKind: "kernel",
			status: input.autoApprovedAttach ? "completed" : "blocked",
			runId: input.runId,
			tediId: null,
			orgId: input.organizationId,
			conversationId: input.conversationId,
			harnessVersionId: version.id,
			traceBundleId,
			startedAt: input.startedAt,
			endedAt: input.completedAt,
			summary: summaryExcerpt(input.assistantContent),
			structuredResult: {
				routeKind: "delegate_tedi",
				routeSource: "explicit",
				delegation: "workstation_attach",
				delegatedTediId: input.delegatedTediId,
				childRunId: input.childRunId,
				workItemId: input.workItemId,
				approvalRequestId: input.approvalRequestId,
				autoApprovedAttach: input.autoApprovedAttach,
				workstationDispatchNow: input.workstationDispatchNow,
				dispatchPolicy: input.dispatchPolicy,
			},
			session: {
				beforeRef: `kernel_runtime_runs:${input.runId}:started`,
				afterRef: `kernel_runtime_runs:${input.runId}`,
			},
			approvalIds: input.approvalRequestId ? [input.approvalRequestId] : [],
			runtimeServices: ["kernel-runtime", "home", "workstation-dispatch"],
		});
		await recordHarnessSubjectTraceBundle(
			context.db,
			buildHarnessSubjectTraceBundle({
				id: traceBundleId,
				subjectKind: version.subjectKind,
				subjectId: version.subjectId,
				tediId: null,
				orgId: input.organizationId,
				conversationId: input.conversationId,
				runId: input.runId,
				harnessVersionId: version.id,
				createdAt: input.completedAt,
				eventIds: traceReferenceEventIds(
					input.assistantEvent.id,
					input.terminalEvent.id,
				),
				rationaleRecordIds: [],
				artifactIds: [],
				bundleUri: null,
				summary: summaryExcerpt(input.assistantContent),
				outcome: input.autoApprovedAttach ? "success" : "escalated",
				bodyExecutionResult,
				metadata: {
					source: "kernelRuntime.enqueueMessage",
					surface: "home.workstation_attach",
					childRunId: input.childRunId,
					delegatedTediId: input.delegatedTediId,
					workItemId: input.workItemId,
					approvalRequestId: input.approvalRequestId,
				},
			}),
		);
	} catch (error) {
		console.warn(
			"[kernelRuntime] workstation attach kernel trace bundle record failed",
			errorMessage(error),
		);
	}
}
