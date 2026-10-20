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
 * created); a protected ask always passes and is flagged instead.
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
			result.verdict === "pass" && !expiresAt
				? null
				: {
						verdict: result.verdict,
						mode: gate.mode,
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
