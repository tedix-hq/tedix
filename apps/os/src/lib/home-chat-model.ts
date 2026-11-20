import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import type { ModelCatalogModel } from "@tedix/api-contract/schemas/model-catalog-projection";
import { asRecord } from "@tedix/api-contract/utils/is-record";
import { initialModelRef } from "./model-selection";

/**
 * The model the composer shows and sends. A choice made here comes first,
 * then the model that last answered in this conversation, then the person's
 * remembered choice, then the chat default the server uses for a person who
 * picked nothing. Until that default existed every unpicked turn ran on the
 * routed model, so an earlier answer on the routed model is not a choice and
 * does not hold a conversation back from the chat default.
 */
export function homeChatModelRef(input: {
	models: readonly ModelCatalogModel[];
	conversationId: string | null;
	runs: readonly HomeRun[];
	pickedHere: string | null;
	remembered: string | null;
	chatDefault?: string | null;
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
	const answered = asRecord(latest?.metadata)?.modelRef;
	const lastAnswered =
		input.chatDefault && answered === input.routedDefault ? null : answered;
	for (const ref of [input.pickedHere, lastAnswered, input.remembered]) {
		if (
			typeof ref === "string" &&
			input.models.some((model) => model.allowed && model.ref === ref)
		)
			return ref;
	}
	return initialModelRef(
		input.models,
		input.chatDefault ?? input.routedDefault,
	);
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

// Picks made in a composer, by the conversation they were made for. A new
// conversation's thread is rebuilt after its first reply; the pick must still
// apply while that conversation's runs load, or the next message goes to Home.
const composerTediPicks = new Map<string, string | null>();

/** Null is a pick too: the person chose Home. */
export function rememberComposerTediPick(
	conversationId: string,
	tediId: string | null,
): void {
	composerTediPicks.delete(conversationId);
	composerTediPicks.set(conversationId, tediId);
	if (composerTediPicks.size > 50)
		for (const oldest of composerTediPicks.keys()) {
			composerTediPicks.delete(oldest);
			break;
		}
}

/**
 * Who the composer sends to. `known` is false only while an existing
 * conversation's runs are still loading and nobody picked in this page; the
 * composer must not send then, because a pick may be about to appear.
 */
export function composerTediTarget(
	conversationId: string | null,
	sendTargetId: string | null,
	runs: readonly HomeRun[] | undefined,
): { tediId: string | null; known: boolean } {
	const key = conversationId ?? sendTargetId;
	if (key !== null && composerTediPicks.has(key))
		return { tediId: composerTediPicks.get(key) ?? null, known: true };
	return {
		tediId: homeChatPickedTediId(conversationId, runs ?? []),
		known: conversationId === null || runs !== undefined,
	};
}
