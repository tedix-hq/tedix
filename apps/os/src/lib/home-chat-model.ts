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

/**
 * The tedi this conversation's messages go to: the one the person picked for
 * their latest message, or null for Home. Read from the conversation's stored
 * runs, so the pick outlives the composer and a reload. A message Home handed
 * to a tedi by itself does not count as a pick.
 */
export function homeChatPickedTediId(
	conversationId: string | null,
	runs: readonly HomeRun[],
): string | null {
	const latest = [...runs]
		.filter(
			(run) =>
				run.conversationId === conversationId &&
				asRecord(asRecord(run.metadata)?.pushRecipient)?.personStarted === true,
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
	return asRecord(latest?.metadata)?.pickedByPerson === true
		? (latest?.delegatedTediId ?? null)
		: null;
}
