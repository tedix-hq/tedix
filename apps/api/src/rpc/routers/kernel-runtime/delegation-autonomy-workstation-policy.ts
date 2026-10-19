import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import {
	approvalHeldDelegationIntent,
	classifyWorkstationDispatch,
} from "../kernel/dispatch-policy";
import { readOrgDispatchPolicyLayer } from "../kernel/tedi-capabilities";
import {
	isTerminalHomeRunStatus,
	nonNullRecord,
} from "../kernel/runtime-shared";

export async function reviewWorkstationDelegationAutonomy(
	context: BaseContext,
	run: KernelRuntimeRun,
) {
	const metadata = nonNullRecord(run.metadata);
	const order = nonNullRecord(metadata?.delegationWorkOrder);
	if (
		isTerminalHomeRunStatus(run.status) ||
		order?.kind !== "workstation.attach" ||
		!metadata?.approvalRequestId ||
		metadata.approvalResolvedAt
	)
		return null;
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
	return {
		allowed: decision.autoDispatch,
		reason: decision.reasons.join("; "),
		workstation: true,
	};
}
