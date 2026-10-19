import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { decideAutonomousAction } from "@tedix/api-contract/utils/approval-policy";
import { KernelRouteDecisionSchema } from "../kernel/route-schema";
import {
	buildDelegationWorkOrder,
	decideDelegationDispatch,
} from "../kernel/delegation-dispatch";
import { resolveEarnedDelegationEnforcement } from "../kernel/dispatch-policy";
import {
	getTediCapabilityCards,
	readOrgDispatchPolicyLayer,
} from "../kernel/tedi-capabilities";
import { nonNullRecord } from "../kernel/runtime-shared";
import { reviewWorkstationDelegationAutonomy } from "./delegation-autonomy-workstation-policy";
import {
	approvalHeldDelegation,
	kernelDelegationRecommendationFromRun,
} from "./turn-delegation";

export async function reviewDelegationAutonomy(
	context: BaseContext,
	run: KernelRuntimeRun,
): Promise<{
	allowed: boolean;
	reason: string;
	workstation?: boolean;
	executionBlocked?: boolean;
	policyPack?: { id: string; version: number };
}> {
	const direct = await reviewWorkstationDelegationAutonomy(context, run);
	if (direct) return direct;
	const pending = kernelDelegationRecommendationFromRun(run);
	if (
		!pending ||
		pending.delegation.resolutionStatus ||
		approvalHeldDelegation(pending.delegation)
	)
		return {
			allowed: false,
			reason: "not an unresolved policy-eligible delegation",
		};
	const route = KernelRouteDecisionSchema.safeParse(
		pending.metadata.kernelRoute,
	);
	const source = pending.workOrder.sourceContent;
	if (!route.success || typeof source !== "string" || !source.trim())
		return {
			allowed: false,
			reason: "stored route or source request is unavailable",
		};
	const [policy, cards] = await Promise.all([
		readOrgDispatchPolicyLayer(context.db, run.organizationId),
		getTediCapabilityCards(context.db, run.organizationId),
	]);
	if (!policy?.autonomy)
		return { allowed: false, reason: "no active autonomy policy" };
	const card =
		cards.find((candidate) => candidate.tediId === pending.targetTediId) ??
		null;
	const environment = context.env.ENVIRONMENT ?? "development";
	const earnedDelegationEnforcement = resolveEarnedDelegationEnforcement({
		globalMode:
			context.env.EARNED_DELEGATION_ENFORCEMENT === "enforce"
				? "enforce"
				: "shadow",
		policy: policy.earnedDelegation,
		activityId: route.data.targetActivityId,
		tediId: pending.targetTediId,
		environment,
	});
	const workOrder = buildDelegationWorkOrder({
		route: route.data,
		card,
		userContent: source,
		executionEnvironment: environment,
		authorityMode: earnedDelegationEnforcement,
	});
	const decision = decideDelegationDispatch({
		route: route.data,
		card,
		speaker: { approvalAuthority: true },
		workOrderContent: source,
		executionRequirement: workOrder.executionRequirement,
		capabilityPlan: workOrder.capabilityPlan,
		executionEnvironment: environment,
		earnedDelegationEnforcement,
		earnedDelegationActivityAllowed: Boolean(
			route.data.targetActivityId &&
			policy.earnedDelegation?.activityIds.includes(
				route.data.targetActivityId,
			),
		),
		gating: { org: policy, tedi: card?.dispatchPolicy },
		delegationDepth: Number(nonNullRecord(run.metadata)?.delegationDepth ?? 0),
	});
	return {
		allowed: decision.canAutoDispatch && decision.mode === "auto",
		policyPack: policy.autonomy.policyPack,
		reason: decision.reason,
		executionBlocked:
			decision.mode === "blocked" &&
			decideAutonomousAction({
				policy: policy.autonomy,
				risk: route.data.risk,
				content: source,
				classId: `delegation:${route.data.effortClass ?? "unknown"}`,
			}).autoApprove,
	};
}
