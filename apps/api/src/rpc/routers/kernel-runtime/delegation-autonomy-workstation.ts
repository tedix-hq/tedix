import {
	getApprovalRequestById,
	resolveApprovalRequest,
} from "@tedix/db/queries/approvals";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { recordDelegationFyi } from "@tedix/db/queries/work-items/delegation-autonomy";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import { createDelegationWorkItem } from "../kernel/delegation-work-item";
import { workstationDispatchIdentity } from "../kernel/workstation-dispatch";
import {
	nonNullRecord,
	nowIso,
	stringFromPayload,
} from "../kernel/runtime-shared";
import { resolveKernelDelegateTarget } from "./run-reads-streams";
import { resolveKernelWorkstationAttachWorkOrder } from "./control-proposals";
import { reviewDelegationAutonomy } from "./delegation-autonomy-review";
import { ExecutionRequirementSchema } from "@tedix/api-contract/schemas/execution-evidence";

export async function releaseWorkstationDelegationAutonomy(
	context: BaseContext,
	input: { organizationId: string; runId: string },
) {
	const run = await getKernelRuntimeRun(context.db, {
		id: input.runId,
		organizationId: input.organizationId,
	});
	if (!run || !(await reviewDelegationAutonomy(context, run)).allowed)
		throw createError(
			ErrorCodes.CONFLICT,
			"Direct delegation is no longer policy eligible",
		);
	const metadata = nonNullRecord(run.metadata);
	const order = nonNullRecord(metadata?.delegationWorkOrder);
	const approvalId = stringFromPayload(metadata?.approvalRequestId);
	const targetId = stringFromPayload(order?.targetTediId);
	const source = stringFromPayload(order?.sourceContent);
	const workItemId = stringFromPayload(metadata?.workItemId);
	if (!approvalId || !targetId || !source || !workItemId)
		throw createError(
			ErrorCodes.CONFLICT,
			"Direct delegation has incomplete admission evidence",
		);
	const approval = await getApprovalRequestById(context.db, approvalId);
	if (
		!approval ||
		approval.orgId !== input.organizationId ||
		approval.status !== "pending"
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"Direct delegation approval is no longer pending",
		);
	const target = await resolveKernelDelegateTarget(context, {
		organizationId: input.organizationId,
		delegateToTediId: targetId,
	});
	if (!target)
		throw createError(ErrorCodes.NOT_FOUND, "Delegated tedi not found");
	const identity = workstationDispatchIdentity({ homeRunId: run.id, target });
	await createDelegationWorkItem(context, {
		assigneeTediId: targetId,
		childRunId: identity.runtimeRunId,
		content: source,
		homeRunId: run.id,
		organizationId: input.organizationId,
		createdAt: nowIso(),
		conversationId: run.conversationId,
		executionRequirement: ExecutionRequirementSchema.parse(
			order?.executionRequirement,
		),
		workItemId,
		autonomyClass: "delegation:embodied",
	});
	const resolution =
		"Released by delegation-autonomy.v1; no human approval was supplied.";
	const resolved = await resolveApprovalRequest(context.db, approvalId, {
		status: "approved",
		resolvedBy: "policy:delegation-autonomy.v1",
		resolution,
	});
	if (!resolved)
		throw createError(
			ErrorCodes.CONFLICT,
			"Direct delegation approval changed; reload",
		);
	const result = await resolveKernelWorkstationAttachWorkOrder(context, {
		approvalRequestId: approvalId,
		organizationId: input.organizationId,
		status: "approved",
		resolution,
		policyResolution: true,
	});
	await recordDelegationFyi(context.db, {
		orgId: input.organizationId,
		workItemId,
		at: nowIso(),
		fyi: {
			classId: "delegation:embodied",
			homeRunId: run.id,
			childRunId: result.run.childRunId ?? identity.runtimeRunId,
			tediId: targetId,
			tediName: target.slug,
			task: source,
			outcome: result.run.status,
		},
	});
	return result;
}
