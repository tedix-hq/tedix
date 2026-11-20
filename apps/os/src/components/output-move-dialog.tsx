import { Check } from "@phosphor-icons/react";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { SearchInput } from "@/components/kumo/search-input";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { fileActionRefusal } from "@/lib/file-action-refusal";
import {
	activeWorkspacesQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { LoadingArea } from "@/components/loading-area";

/**
 * Pick the workspace a file moves to. The list is the active workspaces the
 * person can open; the server decides whether the move is allowed, and its
 * refusal is shown here.
 */
export function MoveOutputDialog({
	outputId,
	title,
	workspaceId,
	onClose,
	onMoved,
}: {
	outputId: string;
	title: string;
	/** Where the file is now; left out of the choices. */
	workspaceId: string | null;
	onClose: () => void;
	onMoved?: (target: { id: string; name: string }) => void;
}) {
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const [target, setTarget] = useState<{ id: string; name: string } | null>(
		null,
	);
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(search.trim() || undefined),
		placeholderData: keepPreviousData,
	});
	const choices = (workspaces.data?.items ?? []).filter(
		(workspace) => workspace.id !== workspaceId,
	);
	const move = useMutation({
		mutationFn: (to: { id: string; name: string }) =>
			osApi.osWorkspaces.outputs.move({ outputId, workspaceId: to.id }),
		onSuccess: async (_result, to) => {
			onClose();
			onMoved?.(to);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
			]);
		},
	});
	return (
		<Dialog open onOpenChange={(open) => !open && !move.isPending && onClose()}>
			<DialogContent size="sm" showCloseButton={!move.isPending}>
				<DialogHeader>
					<DialogTitle>Move to workspace</DialogTitle>
					<DialogDescription>
						Choose where “{title}” should live. It keeps its versions and its
						share links.
					</DialogDescription>
				</DialogHeader>
				<SearchInput
					aria-label="Search workspaces"
					placeholder="Search workspaces"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				{workspaces.isPending ? (
					<LoadingArea className="h-24" label="Loading workspaces" />
				) : workspaces.isError ? (
					<Alert variant="destructive">
						<AlertDescription>
							{fileActionRefusal(workspaces.error, "list your workspaces")}
						</AlertDescription>
					</Alert>
				) : choices.length === 0 ? (
					<Text as="p" role="body" tone="secondary">
						{search.trim()
							? "No workspace matches that search."
							: "There is no other workspace to move this file to."}
					</Text>
				) : (
					<div
						role="radiogroup"
						aria-label="Workspaces"
						className="grid max-h-64 gap-1 overflow-y-auto"
					>
						{choices.map((workspace) => {
							const selected = target?.id === workspace.id;
							return (
								<Button
									key={workspace.id}
									role="radio"
									aria-checked={selected}
									variant={selected ? "secondary" : "ghost"}
									className="w-full justify-between"
									disabled={move.isPending}
									onClick={() => {
										move.reset();
										setTarget({ id: workspace.id, name: workspace.name });
									}}
								>
									<span className="truncate">{workspace.name}</span>
									{selected && <Check size={14} aria-hidden />}
								</Button>
							);
						})}
					</div>
				)}
				{move.isError && (
					<Alert variant="destructive" data-move-error>
						<AlertDescription>
							{fileActionRefusal(move.error, "move this file")}
						</AlertDescription>
					</Alert>
				)}
				<DialogFooter>
					<Button variant="outline" disabled={move.isPending} onClick={onClose}>
						Cancel
					</Button>
					<Button
						loading={move.isPending}
						disabled={!target || move.isPending}
						onClick={() => target && move.mutate(target)}
					>
						{move.isPending
							? "Moving…"
							: target
								? `Move to ${target.name}`
								: "Move"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
