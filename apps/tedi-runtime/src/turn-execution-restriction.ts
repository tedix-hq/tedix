import {
	TurnExecutionRestrictionSchema,
	type TurnExecutionRestriction,
} from "@tedix/api-contract/schemas/turn-execution-restriction";
import {
	isBlindVerificationSession,
	isWorkflowSynthesisSession,
} from "@tedix/api-contract/utils/runtime-identity";

export function resolveTurnExecutionRestriction(
	value: unknown,
	input: { sessionKey: string; evaluation?: unknown },
): TurnExecutionRestriction | undefined {
	if (value === undefined) return undefined;
	const restriction = TurnExecutionRestrictionSchema.parse(value);
	if (
		input.evaluation ||
		isBlindVerificationSession(input.sessionKey) ||
		isWorkflowSynthesisSession(input.sessionKey)
	)
		throw new Error("Execution restriction requires an ordinary chat turn");
	return restriction;
}

/** The dispatch journal, including settled turns, owns the original restriction. */
export async function assertOriginalExecutionRestriction(
	storage: Pick<DurableObjectStorage, "get">,
	runId: string,
	requested: TurnExecutionRestriction | undefined,
	requireOriginal = false,
): Promise<void> {
	const original = await storage.get<{
		params: { executionRestriction?: TurnExecutionRestriction };
	}>(`runtime-admission-workflow:${runId}`);
	if (requested && requireOriginal && !original)
		throw new Error("Original admitted execution restriction unavailable");
	if (
		original &&
		JSON.stringify(original.params.executionRestriction ?? null) !==
			JSON.stringify(requested ?? null)
	)
		throw new Error("Original admitted execution restriction changed");
}

/** Validate and journal the actual SDK call before any provider dispatch. */
export async function recordRestrictedProviderCall(input: {
	storage: Pick<DurableObjectStorage, "transaction">;
	runId: string;
	providerAttemptId: string;
	restriction: TurnExecutionRestriction;
	facetToolCount: number;
	call: Pick<
		import("@ai-sdk/provider").LanguageModelV2CallOptions,
		"tools" | "toolChoice"
	>;
}): Promise<void> {
	TurnExecutionRestrictionSchema.parse(input.restriction);
	if (
		!input.providerAttemptId ||
		!Array.isArray(input.call.tools) ||
		input.call.tools.length !== 0 ||
		input.call.toolChoice?.type !== "none" ||
		input.facetToolCount !== 0
	)
		throw new Error(
			"Restricted provider or executable tool surface is not empty",
		);
	const key =
		"turn-execution-restriction:" + input.runId + ":" + input.providerAttemptId;
	const applied = {
		runId: input.runId,
		providerAttemptId: input.providerAttemptId,
		...input.restriction,
		providerToolCount: input.call.tools.length,
		facetToolCount: input.facetToolCount,
		toolChoice: input.call.toolChoice.type,
	};
	await input.storage.transaction(async (storage) => {
		const prior = await storage.get(key);
		if (prior && JSON.stringify(prior) !== JSON.stringify(applied))
			throw new Error("Applied execution restriction receipt changed");
		await storage.put(key, applied);
	});
}
