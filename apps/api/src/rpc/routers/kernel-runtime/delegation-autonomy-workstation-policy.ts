import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getApprovalRequestById } from "@tedix/db/queries/approvals";
import {
	approvalHeldDelegationIntent,
	classifyWorkstationDispatch,
} from "../kernel/dispatch-policy";
import { readOrgDispatchPolicyLayer } from "../kernel/tedi-capabilities";
import {
	isTerminalHomeRunStatus,
	nonNullRecord,
	stringFromPayload,
} from "../kernel/runtime-shared";

export async function reviewWorkstationDelegationAutonomy(
	context: BaseContext,
	run: KernelRuntimeRun,
) {
	const metadata = nonNullRecord(run.metadata);
	const order = nonNullRecord(metadata?.delegationWorkOrder);
	const approvalId = stringFromPayload(metadata?.approvalRequestId);
	if (
		!metadata ||
		isTerminalHomeRunStatus(run.status) ||
		order?.kind !== "workstation.attach" ||
		!approvalId ||
		metadata.approvalResolvedAt
	)
		return null;
	if (
		run.childRunId ||
		metadata.childRunId ||
		nonNullRecord(metadata.homeApprovedDispatch)?.childRunId ||
		nonNullRecord(run.runtimeMetadata)?.childRunId ||
		nonNullRecord(run.runtimeMetadata)?.dispatch === "workstation-dispatched"
	)
		return {
			allowed: false,
			reason:
				"delegation already has execution evidence; retain its current approval",
			workstation: true,
		};
	const policy = await readOrgDispatchPolicyLayer(
		context.db,
		run.organizationId,
	);
	const source = order.sourceContent;
	if (
		!policy?.autonomy ||
		policy.effect === "deny" ||
		typeof source !== "string" ||
		!source.trim() ||
		approvalHeldDelegationIntent(source)
	)
		return {
			allowed: false,
			reason: "direct delegation policy or source is unavailable",
			workstation: true,
		};
	const decision = classifyWorkstationDispatch({
		autonomy: policy.autonomy,
		content: source,
		explicitHumanDelegation: true,
		hasActingUser: true,
		runtimeRunning: null,
	});
	const result = {
		allowed: decision.autoDispatch,
		reason: decision.reasons.join("; "),
		workstation: true,
	};
	if (
		result.allowed &&
		!stringFromPayload(metadata.workItemId) &&
		order.executionRequirement === undefined
	) {
		const approval = await getApprovalRequestById(context.db, approvalId);
		if (!approval || approval.orgId !== run.organizationId)
			return {
				...result,
				allowed: false,
				executionBlocked: true,
				reason: "legacy delegation has no organization-scoped approval record",
			};
	}
	return result;
}
