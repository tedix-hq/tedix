import routing from "@tedix/api-contract/assets/blocker-attention.v1.json";
import { DEFAULT_DECISION_AUTONOMY } from "@tedix/api-contract/utils/decision-autonomy";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import { humanOnlyAskReasons } from "@tedix/api-contract/utils/human-only-ask";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { queryWorkItemBlockers } from "@tedix/db/queries/work-items/relations";
import type { BaseContext } from "../rpc/orpc";
import type { VerifiedActiveWorkActor } from "../rpc/routers/work-items-principal";

/** Assigns investigation, never approval or execution authority. */
export async function blockerAttentionRouting(
	context: BaseContext,
	orgId: string,
	actor: VerifiedActiveWorkActor,
	input: {
		kind: string;
		subject: string;
		prompt: string;
		workItemId?: string;
		metadata?: Record<string, unknown>;
	},
) {
	if (actor.type === "user" || !["question", "input"].includes(input.kind))
		return null;
	const m = input.metadata ?? {};
	const text = `${input.subject}\n${input.prompt}`;
	const decision = DecisionEnvelopeSchema.safeParse(m.decisionDeck);
	const declaredClasses = [
		m.decisionClass,
		(m.internalAction as { classId?: unknown } | undefined)?.classId,
		(m.decisionDeck as { classId?: unknown } | undefined)?.classId,
	];
	if (
		humanReservedActionClasses(text).length ||
		humanOnlyAskReasons(text).length ||
		declaredClasses.some((id) =>
			new RegExp(DEFAULT_DECISION_AUTONOMY.reservedClassPattern, "i").test(
				String(id ?? ""),
			),
		) ||
		new RegExp(routing.humanChoicePattern, "i").test(text) ||
		credentialCard(text, m) ||
		m.protected ||
		m.approvalOperation !== undefined ||
		m.localImport ||
		m.schema === "tedix.outbound.v1" ||
		["high", "critical"].includes(String(m.riskLevel)) ||
		(m.protectedEffects !== undefined &&
			(!Array.isArray(m.protectedEffects) || m.protectedEffects.length > 0)) ||
		(m.decisionDeck !== undefined &&
			(!decision.success ||
				decision.data.protectedEffects.length > 0 ||
				decision.data.tasteOrStrategy ||
				["approval", "outbound"].includes(decision.data.kind)))
	)
		return null;
	if (!new RegExp(routing.routineSubjectPattern, "i").test(input.subject))
		return null;
	let work = input.workItemId
		? await getWorkItemById(context.db, input.workItemId, orgId)
		: null;
	if (input.workItemId && !work) return null;
	if (typeof m.blockerWorkItemId === "string" && work) {
		const blockers = await queryWorkItemBlockers(context.db, work.id, orgId);
		if (
			!blockers.some(
				(b) =>
					b.id === m.blockerWorkItemId &&
					!["completed", "cancelled"].includes(b.disposition),
			)
		)
			return null;
		work = await getWorkItemById(context.db, m.blockerWorkItemId, orgId);
		if (!work) return null;
	}
	const target =
		work?.stewardType === "tedi" && work.stewardId
			? { type: "tedi" as const, id: work.stewardId }
			: work?.accountableOwnerType === "tedi" && work.accountableOwnerId
				? { type: "tedi" as const, id: work.accountableOwnerId }
				: actor;
	return {
		target,
		reason:
			"Routine blocker investigation belongs to the machine owner; execution still requires admission.",
		evidenceRef: work ? `/work/items/${work.id}` : null,
	};
}
