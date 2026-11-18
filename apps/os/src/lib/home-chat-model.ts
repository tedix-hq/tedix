import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import type { ModelCatalogModel } from "@tedix/api-contract/schemas/model-catalog-projection";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import { initialModelRef } from "./model-selection";

export function homeChatModelRef(input: {
	models: readonly ModelCatalogModel[];
	conversationId: string | null;
	runs: readonly HomeRun[];
	pickedHere: string | null;
	remembered: string | null;
	routedDefault?: string | null;
}): string | null {
	const latest = [...input.runs]
		.filter(
			(run) =>
				run.conversationId === input.conversationId &&
				run.status !== "failed" &&
				run.status !== "canceled" &&
				typeof asRecord(run.metadata)?.modelRef === "string",
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
	const lastAnswered = asRecord(latest?.metadata)?.modelRef;
	for (const ref of [input.pickedHere, lastAnswered, input.remembered]) {
		if (
			typeof ref === "string" &&
			input.models.some((model) => model.allowed && model.ref === ref)
		)
			return ref;
	}
	return initialModelRef(input.models, input.routedDefault);
}
