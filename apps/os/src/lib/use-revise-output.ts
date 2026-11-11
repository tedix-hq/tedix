import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { contentHash } from "@/lib/content-hash";
import { osApi } from "@/lib/api";
import { osQueryKeys, outputDetailQueryOptions } from "@/lib/os-query-options";

export type ReviseOutcome =
	| { kind: "saved"; revision: number; revisionId: string }
	| { kind: "unchanged" }
	| { kind: "conflict"; message: string }
	| { kind: "error"; message: string };

/**
 * The single save path for workshop editors: optimistic-concurrency revise of
 * an output body with content-hash dedupe.
 *
 * - `expectedRevision` pins the revision the editor loaded, so a concurrent
 *   writer surfaces as a typed CONFLICT instead of a silent overwrite; the
 *   caller renders `conflict` as reload-and-retry.
 * - A body whose canonical hash equals the loaded revision's is never sent —
 *   `unchanged` costs no revision and no network write.
 */
export function useReviseOutput(outputId: string) {
	const queryClient = useQueryClient();
	const [outcome, setOutcome] = useState<ReviseOutcome | null>(null);

	const mutation = useMutation({
		mutationFn: async (input: {
			content: OsOutputContent;
			baseContent: OsOutputContent;
			expectedRevision: number;
			note?: string;
		}): Promise<ReviseOutcome> => {
			const [nextHash, baseHash] = await Promise.all([
				contentHash(input.content),
				contentHash(input.baseContent),
			]);
			if (nextHash === baseHash) return { kind: "unchanged" };
			try {
				const result = await osApi.osWorkspaces.outputs.revise({
					outputId,
					content: input.content,
					expectedRevision: input.expectedRevision,
					...(input.note?.trim() ? { note: input.note.trim() } : {}),
				});
				return {
					kind: "saved",
					revision: result.revision.revision,
					revisionId: result.revision.id,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return /conflict/i.test(message)
					? { kind: "conflict", message }
					: { kind: "error", message };
			}
		},
		onSuccess: (result) => {
			setOutcome(result);
			if (result.kind === "saved" || result.kind === "conflict") {
				queryClient.invalidateQueries({
					queryKey: outputDetailQueryOptions(outputId).queryKey,
				});
				queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
			}
		},
	});

	return {
		save: mutation.mutateAsync,
		saving: mutation.isPending,
		outcome,
		clearOutcome: () => setOutcome(null),
	};
}
