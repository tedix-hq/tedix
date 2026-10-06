export interface SelectedConversationModelIdentity {
	provider: "azure-openai" | "workers-ai";
	model: string;
}

/** A single model can be attributed only to fresh text from an ordinary turn. */
export function attributableConversationModel(input: {
	selectedModels: readonly SelectedConversationModelIdentity[];
	hasFreshText: boolean;
	stopped: boolean;
}): SelectedConversationModelIdentity | null {
	if (input.stopped || !input.hasFreshText) return null;
	const first = input.selectedModels[0];
	if (!first) return null;
	return input.selectedModels.every(
		(candidate) =>
			candidate.provider === first.provider && candidate.model === first.model,
	)
		? first
		: null;
}
