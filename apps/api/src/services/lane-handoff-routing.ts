import { humanOnlyAskReasons } from "@tedix/api-contract/utils/human-only-ask";
import { createWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { DbQueryClient } from "@tedix/db/query-client";

type LaneExecutor =
	| { type: "tedi"; id: string }
	| { type: "external_agent"; id: string; sessionId: string };

/**
 * A lane's next step goes to its person only when the step names an
 * owner-only act (deck-routing.v1 criticalSubjectClasses/Patterns): money,
 * legal or tax facts, consent and credentials, access, deletion, publishing
 * or messaging. Any other next step is an agent decision.
 */
export function laneNextStepNeedsPerson(nextClick: string) {
	return humanOnlyAskReasons(nextClick).length > 0;
}

/** File an agent-decidable next step with the Work's tedi steward, else the lane's own principal. */
export async function routeLaneNextStepToAgent(
	db: DbQueryClient,
	p: {
		work: WorkItem;
		executor: LaneExecutor;
		externalSessionKey?: string;
		nextClick: string;
		summary?: string;
		now: string;
	},
) {
	const owner =
		p.work.stewardType === "tedi" && p.work.stewardId
			? { type: "tedi" as const, id: p.work.stewardId }
			: { type: p.executor.type, id: p.executor.id };
	const nextClick = p.nextClick.trim();
	return createWorkInteraction(db, {
		id: crypto.randomUUID(),
		orgId: p.work.orgId,
		workItemId: p.work.id,
		kind: "question",
		subject: nextClick.slice(0, 300),
		prompt: `${p.summary?.trim() || "Lane result ready."}\n\nWork: /work/items/${p.work.id}\n\nNext step (agent decision): ${nextClick}`,
		creator:
			p.executor.type === "external_agent"
				? {
						type: "external_agent",
						id: p.executor.id,
						sessionId: p.executor.sessionId,
						externalSessionKey: p.externalSessionKey,
					}
				: { type: "tedi", id: p.executor.id },
		targetType: owner.type,
		targetId: owner.id,
		metadata: {
			laneNextStep: {
				nextClick,
				routedTo: owner.type,
				reason: "The next step names no owner-only act; an agent decides it.",
			},
		},
		now: p.now,
	});
}
