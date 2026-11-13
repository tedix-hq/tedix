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

export function useChatModelPreference() {
	const queryClient = useQueryClient();
	const query = useQuery(userPreferencesQueryOptions());

	const save = useCallback(
		async (modelRef: string) => {
			if (!parseModelRef(modelRef)) return;
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
