import { findPriorDecision } from "@tedix/db/queries/decision-graph";
import { listDeckSourceStates } from "@tedix/db/queries/work-items/deck-sweep";
import { deckCardStale } from "@tedix/api-contract/utils/deck-ask";
import { classifyDeckAsk } from "@tedix/api-contract/utils/deck-qualification";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import {
	deckGateMessage,
	deckSourceKey,
	evaluateDeckCreateGate,
} from "@tedix/api-contract/utils/deck-pipeline";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import type { VerifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { criticalDeckRequest } from "./deck-curation";

type GateInput = {
	kind: string;
	subject: string;
	prompt: string;
	workItemId?: string;
	caseId?: string;
	dueAt?: string;
	expiresAt?: string;
	metadata: Record<string, unknown>;
	recipientId: string;
};

/**
 * S0: deterministic create-time rules from the organization's D1 config. A
 * malformed agent card is returned to its agent with the reason (no card is
 * created). Protection preserves actionable asks; settled or stale asks withdraw.
 */
export async function deckCreateGate(
	context: BaseContext,
	orgId: string,
	actor: VerifiedActiveWorkActor,
	input: GateInput,
) {
	const config = (await getDecisionLearningConfig(context.db, orgId))
		.deckPipeline;
	const gate = config.createGate;
	if (gate.mode === "off") return null;
	const ask = classifyDeckAsk(input, config.qualification);
	let qualificationIssue: string | null =
		ask.responseKind === "task" && !ask.ownerTask
			? "This is a task for you, not a decision. Supply metadata.ownerTask with presence (login, mfa or consent), exact steps and estimatedMinutes before asking the owner."
			: null;
	let sourceState: string | undefined;
	if (config.qualification.enabled && input.workItemId) {
		const [prior, states] = await Promise.all([
			config.qualification.alreadyDecided && ask.responseKind !== "task"
				? findPriorDecision(context.db, orgId, [input.workItemId])
				: null,
			listDeckSourceStates(context.db, orgId, [input.workItemId], new Date()),
		]);
		sourceState = states.get(input.workItemId);
		if (prior)
			qualificationIssue = `Already decided: ${prior.edge.evidenceRef ?? `${prior.node.kind}:${prior.node.id}`}`;
		else if (sourceState === "completed")
			qualificationIssue = `Already decided: /work/items/${input.workItemId}`;
	}
	if (
		deckCardStale(
			{ ...input, request: input, workItem: { disposition: sourceState } },
			new Date(),
			config.qualification,
		)
	)
		qualificationIssue =
			"Withdrawn: check the source; ask again only if it still needs a decision.";
	if (qualificationIssue && gate.mode === "enforce")
		throw createError(ErrorCodes.UNPROCESSABLE_CONTENT, qualificationIssue);
	const sourceKey = deckSourceKey({
		creatorType: actor.type,
		creatorId: actor.id,
		metadata: input.metadata,
	});
	const rules = config.rules.filter(
		(rule) =>
			rule.recipientId === input.recipientId && rule.sourceKey === sourceKey,
	);
	const isProtected =
		criticalDeckRequest({
			kind: input.kind,
			subject: input.subject,
			prompt: input.prompt,
			metadata: input.metadata,
		} as Parameters<typeof criticalDeckRequest>[0]) ||
		credentialCard(`${input.subject} ${input.prompt}`, input.metadata);
	const bounceRule =
		rules.find((rule) => rule.reason === "agent_could_do") ?? null;
	const result = evaluateDeckCreateGate(input, gate, {
		protected: isProtected,
		ruleBounce: bounceRule,
	});
	if (result.verdict === "bounce" && gate.mode === "enforce")
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			deckGateMessage(result.missing, bounceRule),
		);
	// A learned "expired" rule: this source's asks end at their due time.
	const expiresAt =
		rules.some((rule) => rule.reason === "expired") &&
		input.dueAt &&
		!input.expiresAt
			? input.dueAt
			: undefined;
	return {
		expiresAt,
		receipt:
			result.verdict === "pass" && !expiresAt && !qualificationIssue
				? null
				: {
						verdict: result.verdict,
						mode: gate.mode,
						...(qualificationIssue ? { qualificationIssue } : {}),
						missing: result.missing,
						rule: result.rule,
						...(expiresAt
							? {
									expiryRule: rules.find((rule) => rule.reason === "expired")!
										.id,
								}
							: {}),
					},
	};
}
