import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	osQuery,
	osQueryKeys,
	workspacePreferencesQueryOptions,
} from "@/lib/os-query-options";

/**
 * Pin or unpin a workspace for the signed-in person. The pin shows at once in
 * every list and is put back if the server refuses.
 */
export function useSetWorkspaceFavorite(
	options: {
		onSettled?: () => void;
		/** The pin was saved, but the lists could not be read again. */
		onRefreshFailed?: () => void;
	} = {},
) {
	const queryClient = useQueryClient();
	return useMutation({
		...osQuery.osWorkspaces.workspacePreferences.setFavorite.mutationOptions(),
		onMutate: async ({ workspaceId, favorite }) => {
			const preferences = workspacePreferencesQueryOptions();
			await queryClient.cancelQueries(preferences);
			const previous = queryClient.getQueryData(preferences.queryKey);
			queryClient.setQueryData(preferences.queryKey, (old) => ({
				items: [
					...(old?.items ?? []).filter(
						(item) => item.workspaceId !== workspaceId,
					),
					{
						workspaceId,
						favorite,
						lastOpenedAt:
							old?.items.find((item) => item.workspaceId === workspaceId)
								?.lastOpenedAt ?? null,
						updatedAt: new Date().toISOString(),
					},
				],
			}));
			return { previous };
		},
		onError: (_error, _input, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					workspacePreferencesQueryOptions().queryKey,
					context.previous,
				);
			}
		},
		onSettled: () => options.onSettled?.(),
		onSuccess: async ({ preference }) => {
			try {
				queryClient.setQueryData(
					workspacePreferencesQueryOptions().queryKey,
					(previous) =>
						previous
							? {
									items: [
										...previous.items.filter(
											(item) => item.workspaceId !== preference.workspaceId,
										),
										preference,
									],
								}
							: previous,
				);
				await queryClient.invalidateQueries(
					{ queryKey: osQueryKeys.workspacePreferences() },
					{ throwOnError: true },
				);
			} catch {
				options.onRefreshFailed?.();
			}
		},
	});
}
