import {
	DecisionAutonomyActionSchema,
	decideDecisionAutonomy,
} from "@tedix/api-contract/utils/decision-autonomy";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import { readOrgDispatchPolicyLayer } from "../rpc/routers/kernel/tedi-capabilities";
import type { VerifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import type { BaseContext } from "../rpc/orpc";

/** Routing returns the ask to its authenticated owner; it never executes code or grants a capability. */
export async function internalDecisionRouting(
	context: BaseContext,
	orgId: string,
	actor: VerifiedActiveWorkActor,
	input: {
		subject: string;
		prompt: string;
		metadata?: Record<string, unknown>;
	},
) {
	if (actor.type === "user") return null;
	const action = DecisionAutonomyActionSchema.safeParse(
		input.metadata?.internalAction,
	);
	if (
		!action.success ||
		action.data.ownerType !== actor.type ||
		action.data.effectKind === "create_owner_task" ||
		humanReservedActionClasses(`${input.subject}\n${input.prompt}`).length ||
		(input.metadata?.protectedEffects !== undefined &&
			(!Array.isArray(input.metadata.protectedEffects) ||
				input.metadata.protectedEffects.length > 0)) ||
		["high", "critical"].includes(String(input.metadata?.riskLevel)) ||
		input.metadata?.approvalOperation ||
		input.metadata?.localImport ||
		input.metadata?.schema === "tedix.outbound.v1"
	)
		return null;
	const layer = await readOrgDispatchPolicyLayer(context.db, orgId);
	const verdict = decideDecisionAutonomy({
		policy: layer?.effect === "deny" ? null : layer?.autonomy,
		action: { ...action.data, ownerType: actor.type },
		decision: input.metadata?.decisionDeck,
	});
	return verdict.eligible
		? {
				classId: verdict.classId,
				policyPack: layer?.autonomy?.policyPack ?? null,
				reason: verdict.reason,
			}
		: null;
}
