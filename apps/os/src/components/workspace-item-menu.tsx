import {
	Archive,
	ArrowSquareOut,
	DotsThree,
	PencilSimple,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type ReactElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kumo/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/kumo/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { Input } from "@/components/kumo/input";
import { osApi } from "@/lib/api";
import {
	canvasGadgetsQueryOptions,
	canvasOutputsQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

const MAX_NAME = 120;

/** What the menu acts on: a file, or an app that is not a file's editor. */
export interface WorkspaceMenuItem {
	title: string;
	kindLabel: string;
	/** Set for a file; its editor app follows the file. */
	outputId?: string;
	/** Set for a standalone app. */
	gadgetId?: string;
}

/**
 * Rename and archive for one workspace file or app. Both show at once in the
 * Files list and the tab strip and are put back if the server refuses.
 */
function useWorkspaceItemActions(workspaceId: string, item: WorkspaceMenuItem) {
	const queryClient = useQueryClient();
	const outputsKey = canvasOutputsQueryOptions(workspaceId).queryKey;
	const gadgetsKey = canvasGadgetsQueryOptions(workspaceId).queryKey;
	const key: readonly unknown[] = item.outputId ? outputsKey : gadgetsKey;
	const id = item.outputId ?? item.gadgetId;
	/** Apply `change` to this item's row now; return how to undo it. */
	const optimistic = async (
		change: (row: Record<string, unknown>) => Record<string, unknown> | null,
	) => {
		await queryClient.cancelQueries({ queryKey: key });
		const previous = queryClient.getQueryData(key);
		queryClient.setQueryData(key, (current: unknown) => {
			const list = current as { items?: Record<string, unknown>[] } | undefined;
			if (!list?.items) return current;
			return {
				...list,
				items: list.items.flatMap((row) => {
					if (row.id !== id) return [row];
					const next = change(row);
					return next ? [next] : [];
				}),
			};
		});
		return () => queryClient.setQueryData(key, previous);
	};
	const settle = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() }),
			queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
		]);
	const rename = useMutation<void, Error, string, () => void>({
		mutationFn: async (name) => {
			if (item.outputId)
				await osApi.osWorkspaces.outputs.rename({
					outputId: item.outputId,
					title: name,
				});
			else
				await osApi.osWorkspaces.gadgets.rename({
					workspaceId,
					gadgetId: item.gadgetId!,
					name,
				});
		},
		onMutate: (name) =>
			optimistic((row) =>
				item.outputId ? { ...row, title: name } : { ...row, name },
			),
		onError: (_error, _name, undo) => void undo?.(),
		onSettled: settle,
	});
	const archive = useMutation<void, Error, void, () => void>({
		mutationFn: async () => {
			if (item.outputId)
				await osApi.osWorkspaces.outputs.archive({ outputId: item.outputId });
			else
				await osApi.osWorkspaces.gadgets.archive({
					workspaceId,
					gadgetId: item.gadgetId!,
				});
		},
		onMutate: () => optimistic(() => null),
		onError: (_error, _input, undo) => void undo?.(),
		onSettled: settle,
	});
	return { rename, archive };
}

/**
 * Wraps a Files row with its actions: a "…" button, the same menu on
 * right-click, renaming in place and archiving after a confirmation.
 */
export function WorkspaceItemMenu({
	workspaceId,
	item,
	onOpen,
	onArchived,
	children,
}: {
	workspaceId: string;
	item: WorkspaceMenuItem;
	onOpen: () => void;
	/** The item left the workspace; close whatever was showing it. */
	onArchived?: () => void;
	children: ReactElement;
}) {
	const { rename, archive } = useWorkspaceItemActions(workspaceId, item);
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(item.title);
	const [confirming, setConfirming] = useState(false);
	const cancelled = useRef(false);
	const field = useRef<HTMLInputElement>(null);
	// A closing menu hands focus back to the row. Take focus only after that,
	// and ignore the blur it causes, or the rename would end as it starts.
	const armed = useRef(false);
	useEffect(() => {
		if (!renaming) return;
		armed.current = false;
		const timer = setTimeout(() => {
			armed.current = true;
			field.current?.focus();
			field.current?.select();
		}, 60);
		return () => clearTimeout(timer);
	}, [renaming]);
	const startRename = () => {
		setDraft(item.title);
		rename.reset();
		setRenaming(true);
	};
	const commit = () => {
		if (!armed.current) return;
		setRenaming(false);
		if (cancelled.current) {
			cancelled.current = false;
			return;
		}
		const next = draft.trim().slice(0, MAX_NAME);
		if (next && next !== item.title) rename.mutate(next);
	};
	const actions = (
		Item: typeof DropdownMenuItem | typeof ContextMenuItem,
		Separator: () => ReactNode,
	) => (
		<>
			<Item onClick={onOpen}>
				<ArrowSquareOut size={14} /> Open
			</Item>
			<Item onClick={startRename}>
				<PencilSimple size={14} /> Rename
			</Item>
			<Separator />
			<Item variant="danger" onClick={() => setConfirming(true)}>
				<Archive size={14} /> Archive
			</Item>
		</>
	);
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger
					className="workspace-outputs-item"
					data-workspace-item-menu=""
				>
					{renaming ? (
						<Input
							aria-label={`Rename ${item.title}`}
							ref={field}
							className="workspace-outputs-rename"
							size="sm"
							value={draft}
							maxLength={MAX_NAME}
							onChange={(event) => setDraft(event.target.value)}
							onBlur={commit}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									event.currentTarget.blur();
								} else if (event.key === "Escape") {
									cancelled.current = true;
									event.currentTarget.blur();
								}
							}}
						/>
					) : (
						<>
							{children}
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											aria-label={`Actions for ${item.title}`}
											className="workspace-outputs-more"
											size="icon-sm"
											variant="ghost"
										>
											<DotsThree size={16} weight="bold" />
										</Button>
									}
								/>
								<DropdownMenuContent align="end">
									{actions(DropdownMenuItem, () => (
										<DropdownMenuSeparator />
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					)}
				</ContextMenuTrigger>
				<ContextMenuContent>
					{actions(ContextMenuItem, () => (
						<ContextMenuSeparator />
					))}
				</ContextMenuContent>
			</ContextMenu>
			{rename.isError && (
				<p className="workspace-outputs-note" role="alert">
					The name could not be saved. Try again.
				</p>
			)}
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Archive “${item.title}”?`}
				description={`This ${item.kindLabel.toLowerCase()} leaves the workspace's Files. Nothing is deleted: its history is kept and it can be restored from the Files library.`}
				confirmLabel="Archive"
				pendingLabel="Archiving…"
				destructive
				isPending={archive.isPending}
				error={archive.error}
				onConfirm={() =>
					archive.mutate(undefined, {
						onSuccess: () => {
							setConfirming(false);
							onArchived?.();
						},
					})
				}
			/>
		</>
	);
}
