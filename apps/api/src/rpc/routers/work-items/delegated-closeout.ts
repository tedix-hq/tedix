import { createRouterClient } from "@orpc/server";
import { DelegationCapabilityPlanSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { decideAutonomousAction } from "@tedix/api-contract/utils/approval-policy";
import {
	closeoutRequiresHuman,
	delegatedCloseoutProjects,
} from "@tedix/api-contract/utils/delegated-work-closeout";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { completeWorkItem } from "@tedix/db/queries/work-items/crud";
import {
	createError,
	ErrorCodes,
	type BaseContext,
	withAuthorization,
} from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { assertTediAccess } from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	rethrowWorkItemWriteError,
} from "./policy-helpers";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
const forbidden = (message: string): never => {
	throw createError(ErrorCodes.FORBIDDEN, message);
};

/** Native runtime authority is bounded by the owner's persisted request. A
 * supplied Home ID or a delegated MCP bearer grants no Work write authority. */
export async function closeoutDelegatedWork(
	context: BaseContext,
	input: {
		id: string;
		homeRunId: string;
		runId: string;
		linkedWorkItemId: string;
		sha: string;
	},
) {
	if (
		context.authType !== "service-binding" ||
		!context.tediId ||
		context.externalAgentPrincipalId ||
		context.headers.get("X-Tedix-Mcp-Tool-Id") ||
		context.serviceBindingAuthorization?.source === "mcp-tool" ||
		context.headers.get("X-Tedix-Caller-Source") !== "http-platform-client"
	)
		forbidden("Delegated closeout requires the native tedi runtime");
	const organizationId = requireOrgId(context);
	const tedi = await assertTediAccess(context, context.tediId!, organizationId);
	if (tedi.status !== "active")
		forbidden("Delegated closeout requires an active tedi");
	const home = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
		organizationId,
	});
	if (
		!home ||
		!["queued", "running", "waiting"].includes(home.status) ||
		home.delegatedTediId !== tedi.id ||
		home.childRunId !== input.runId ||
		home.metadata?.workItemId !== input.linkedWorkItemId ||
		input.id === input.linkedWorkItemId
	)
		forbidden("Delegated closeout does not match an active Home dispatch");
	const original = record(home!.metadata?.redriveInput);
	const order = record(record(home!.metadata?.homeDelegation).workOrder);
	const plan = DelegationCapabilityPlanSchema.safeParse(order.capabilityPlan);
	const projects =
		typeof original.content === "string"
			? delegatedCloseoutProjects(original.content)
			: [];
	if (
		!plan.success ||
		!plan.data.allowedToolIds.includes("close_completed_work_item") ||
		!projects.length ||
		typeof original.descopeUserId !== "string"
	)
		forbidden("Home did not authorize a project-scoped closeout");
	const member = await getMemberByUserId(
		context.db,
		organizationId,
		original.descopeUserId as string,
	);
	if (member?.status !== "active" || !["owner", "admin"].includes(member.role))
		forbidden(
			"Delegated closeout requires the requesting owner's current active membership",
		);
	const { mcpGovernanceContractRouter } = await import("../mcp-governance");
	const policy = await createRouterClient(mcpGovernanceContractRouter, {
		context,
	}).resolveAgentTransportPolicy({ organizationId, tediId: tedi.id });
	const autonomy = decideAutonomousAction({
		policy: policy.autonomy,
		risk: "medium",
		content:
			"Complete one settled coding Work item with its closing SHA comment",
		classId: "native:close_completed_work_item",
	});
	if (
		policy.requireExplicitApprovalPolicy ||
		closeoutRequiresHuman(policy.autonomy?.askForClasses) ||
		!autonomy.autoApprove
	)
		forbidden("Current policy requires human approval for this Work closeout");
	const item = await assertWorkItemAccess(context, input.id);
	if (
		!item.projectId ||
		!projects.includes(item.projectId.toLowerCase()) ||
		item.workKind !== "coding" ||
		!["low", "medium"].includes(item.riskLevel) ||
		!["accepted", "completed"].includes(item.disposition)
	)
		forbidden(
			"Work item is outside the requested low/medium-risk coding closeout scope",
		);
	const attempts = await listWorkItemAttempts(context.db, {
		orgId: organizationId,
		workItemId: item.id,
		limit: 1,
	});
	const latest = attempts.data[0];
	if (
		!latest ||
		latest.runtimeState !== "finished" ||
		latest.outcome !== "succeeded" ||
		!latest.finishedAt ||
		!new RegExp(`\\b${input.sha}\\b`, "i").test(
			JSON.stringify([latest.summary, latest.metadata]),
		)
	)
		forbidden(
			"Closeout requires the latest settled successful Attempt with this exact full SHA",
		);
	const linked = await listWorkItemAttempts(context.db, {
		orgId: organizationId,
		workItemId: input.linkedWorkItemId,
		limit: 1,
	});
	const active = linked.data[0];
	if (
		!active ||
		active.executorType !== "tedi" ||
		active.executorId !== tedi.id ||
		active.runId !== input.runId ||
		!["running", "waiting", "retrying"].includes(active.runtimeState) ||
		!active.expiresAt ||
		active.expiresAt <= new Date().toISOString()
	)
		forbidden("Delegated closeout requires its current fenced Work Attempt");
	try {
		const completed = await completeWorkItem(context.db, {
			orgId: organizationId,
			workItemId: item.id,
			actor: { type: "tedi", id: tedi.id },
			expectedWorkItemVersion: item.version,
			closingComment: {
				id: `${input.homeRunId}:closeout:${item.id}`,
				body: `Completed: ${input.sha.toLowerCase()} verified on origin/main.`,
				metadata: {
					homeRunId: input.homeRunId,
					childRunId: input.runId,
					delegatedByUserId: member!.userId,
					settledAttemptId: latest!.id,
				},
			},
		});
		return completed;
	} catch (error) {
		rethrowWorkItemWriteError(error);
	}
}

const nativeCloseoutOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler rejects human and MCP transports and verifies the persisted requesting owner's current membership",
		},
		"mcp:messaging.write",
	),
);
export const closeoutDelegatedProcedure =
	nativeCloseoutOs.closeoutDelegated.handler(({ input, context }) =>
		closeoutDelegatedWork(context, input),
	);
