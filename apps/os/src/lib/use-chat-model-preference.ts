/**
 * The model a person last chose in chat, kept on their own preference row so
 * it follows them to another browser and is not inherited by the next person
 * on this one. Both chats read and write the same value.
 */

import { parseModelRef } from "@tedix/api-contract/schemas/model-catalog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { osApi } from "@/lib/api";
import { userPreferencesQueryOptions } from "@/lib/os-query-options";
import { isRevisionConflict } from "@/lib/use-os-preferences";

const WORKERS_AI_PREFIX = "workers-ai/";

/** Workspace chat names a Workers AI model by its bare `@cf/...` id. */
export function workspaceModelIdForRef(ref: string | null): string | null {
	if (!ref) return null;
	return ref.startsWith(WORKERS_AI_PREFIX)
		? ref.slice(WORKERS_AI_PREFIX.length)
		: ref;
}

export function refForWorkspaceModelId(id: string): string {
	return id.startsWith("@cf/") ? `${WORKERS_AI_PREFIX}${id}` : id;
}

/** The product default model for a chat with a tedi. */
const TEDI_CHAT_DEFAULT_MODEL = "gpt-6.1-sol";

/** The offered model a new chat with a tedi starts on, when it is offered. */
export function tediChatDefaultModelId(
	offered: ReadonlyArray<{ id: string }>,
): string | null {
	return (
		offered.find(({ id }) => id.endsWith(TEDI_CHAT_DEFAULT_MODEL))?.id ?? null
	);
}

/**
 * The model a workspace chat's picker shows. A choice made in this chat comes
 * first. A chat with answers stays on the model that last answered in it; a
 * new chat starts on the person's remembered model. A model that is no longer
 * offered is skipped, ending at the first offered one.
 */
export function workspaceChatModelId(input: {
	offered: ReadonlyArray<{ id: string }>;
	pickedHere: string | null;
	lastAnswered: string | null;
	remembered: string | null;
}): string | undefined {
	const offered = (id: string | null) =>
		id !== null && input.offered.some((model) => model.id === id);
	for (const id of [input.pickedHere, input.lastAnswered, input.remembered])
		if (offered(id)) return id ?? undefined;
	return input.offered[0]?.id;
}

// Saves run one at a time and only the newest pick is written, so two quick
// picks end on the second one however long the server takes over each.
let saveQueue: Promise<void> = Promise.resolve();
let newestPick = 0;

export function useChatModelPreference() {
	const queryClient = useQueryClient();
	const query = useQuery(userPreferencesQueryOptions());

	const write = useCallback(
		async (modelRef: string, pick: number) => {
			if (pick !== newestPick) return;
			// Other surfaces write the same row, so re-read and retry a lost write.
			for (let attempt = 0; attempt < 3; attempt++) {
				const fresh = await osApi.userSettings.getPreferences({});
				if (fresh.preferences.conversationModelRef === modelRef) return;
				try {
					const saved = await osApi.userSettings.updatePreferences({
						expectedRevision: fresh.revision,
						preferences: {
							...fresh.preferences,
							conversationModelRef: modelRef,
						},
					});
					queryClient.setQueryData(
						userPreferencesQueryOptions().queryKey,
						saved,
					);
					return;
				} catch (error) {
					if (attempt === 2 || !isRevisionConflict(error)) throw error;
				}
			}
		},
		[queryClient],
	);
	const save = useCallback(
		(modelRef: string) => {
			if (!parseModelRef(modelRef)) return Promise.resolve();
			const pick = ++newestPick;
			// Shown at once on this page, so a chat opened before the save lands
			// already starts on it; a failed save leaves it on this page only.
			queryClient.setQueryData(
				userPreferencesQueryOptions().queryKey,
				(current) =>
					current && {
						...current,
						preferences: {
							...current.preferences,
							conversationModelRef: modelRef,
						},
					},
			);
			const run = () => write(modelRef, pick);
			const result = saveQueue.then(run, run);
			saveQueue = result.catch(() => {});
			return result;
		},
		[queryClient, write],
	);

	return {
		modelRef: query.data?.preferences.conversationModelRef ?? null,
		/** The stored choice is known, or known to be unreadable. */
		settled: !query.isPending,
		/** A failed save leaves the choice applied to this page only. */
		save: useCallback(
			(modelRef: string) => {
				save(modelRef).catch(() => {});
			},
			[save],
		),
	};
}
