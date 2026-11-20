import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { usePickableTedis, useTediNames } from "@/lib/use-tedi-names";

/**
 * Who answers a chat message when the person picks nobody. Saves straight
 * away, like the icon. Only tedis the person may pick themselves are offered;
 * the server checks the same rule and their build access.
 */
export function WorkspaceDefaultTediField({
	workspace,
}: {
	workspace: OsWorkspace;
}) {
	const queryClient = useQueryClient();
	const pickable = usePickableTedis();
	const names = useTediNames();
	const [failure, setFailure] = useState<string | null>(null);
	const current = workspace.defaultTediId ?? null;
	const save = useMutation({
		mutationFn: (tediId: string | null) =>
			osApi.osWorkspaces.workspaces.setDefaultTedi({
				workspaceId: workspace.id,
				tediId,
			}),
		onSuccess: async () => {
			setFailure(null);
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
		},
		onError: (error) =>
			setFailure(
				error instanceof Error && error.message
					? error.message
					: "The default could not be saved.",
			),
	});
	const options =
		current && !pickable.some((tedi) => tedi.id === current)
			? [...pickable, { id: current, name: names[current] ?? "Another tedi" }]
			: pickable;
	const label = (id: string | null) =>
		id
			? (options.find((tedi) => tedi.id === id)?.name ?? "Another tedi")
			: "Workspace agent";

	return (
		<div className="grid gap-2">
			<Text as="span" role="label" weight="medium">
				Answers by default
			</Text>
			<Select
				value={current ?? ""}
				onValueChange={(id) => save.mutate(id || null)}
				disabled={save.isPending}
			>
				<SelectTrigger aria-label="Answers by default" size="sm">
					<SelectValue>{label(current)}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="">Workspace agent</SelectItem>
					{options.map((tedi) => (
						<SelectItem key={tedi.id} value={tedi.id}>
							{tedi.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Text role="caption" tone="secondary">
				Answers a chat message when nobody is picked. If it is not available,
				the workspace agent answers and says so.
			</Text>
			{failure ? (
				<Text aria-atomic="true" aria-live="assertive" tone="error">
					{failure}
				</Text>
			) : null}
		</div>
	);
}
