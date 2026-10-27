import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";
import { Text } from "@/components/kumo/text";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { osApi } from "@/lib/api";
import { OS_COPY } from "@/shared/os-copy";
import {
	osQuery,
	osQueryKeys,
	osSharesQueryOptions,
} from "@/lib/os-query-options";

/**
 * Permanently delete an archived workspace. The lists mirror
 * `deleteOsWorkspace` and the schema's foreign keys: the workspace row, its
 * members, invite links, apps (with their versions) and resource links go;
 * outputs, chats, skills, schedules, projects and run records are separate
 * rows that stay. The API refuses while a share link is unrevoked or while
 * agent suggestions exist, so both are checked before the person types.
 */
export function WorkspaceDeleteDialog({
	workspace,
	open,
	onOpenChange,
	onDeleted,
}: {
	workspace: Pick<OsWorkspace, "id" | "name" | "visibility">;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted: (workspaceId: string) => void;
}) {
	const queryClient = useQueryClient();
	// Nothing in a private workspace can be shared, and the share list refuses it.
	const sharesQuery = osSharesQueryOptions({
		resourceType: "workspace",
		resourceId: workspace.id,
	});
	const shares = useQuery({
		...sharesQuery,
		enabled: open && workspace.visibility !== "private",
	});
	const suggestions = useQuery({
		...osQuery.osWorkspaces.collaboration.list.queryOptions({
			input: { workspaceId: workspace.id, limit: 1 },
		}),
		enabled: open,
	});
	const liveLinks = (shares.data?.items ?? []).filter(
		(share) => share.revokedAt === null,
	);
	const remove = useMutation({
		mutationFn: async () => {
			for (const link of liveLinks)
				await osApi.osShares.shares.revoke({ shareId: link.id });
			return osApi.osWorkspaces.workspaces.delete({
				workspaceId: workspace.id,
			});
		},
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey }),
		onSuccess: async () => {
			onDeleted(workspace.id);
			onOpenChange(false);
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
		},
	});
	const checking =
		suggestions.isPending ||
		(workspace.visibility !== "private" && shares.isPending);
	const title = `Delete ${workspace.name} permanently?`;
	const copy = OS_COPY.workspaceLifecycle;

	// Nothing to confirm: say why, and offer only Close.
	if (suggestions.data && suggestions.data.items.length > 0)
		return (
			<AlertDialog open={open} onOpenChange={onOpenChange}>
				<AlertDialogContent size="sm">
					<AlertDialogHeader>
						<AlertDialogTitle>{title}</AlertDialogTitle>
						<AlertDialogDescription>
							This workspace can't be deleted.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Alert variant="info">
						<AlertTitle>Agents suggested changes here</AlertTitle>
						<AlertDescription>
							An agent suggested changes to a document or app in this workspace.
							Tedix keeps those suggestions as a record of who changed what, so
							the workspace can't be deleted. Keep it archived: it stays hidden
							from Workspaces, and its share links don't work.
						</AlertDescription>
					</Alert>
					<AlertDialogFooter>
						<AlertDialogCancel>Close</AlertDialogCancel>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		);

	return (
		<TypedConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={title}
			description="This can't be undone. Restore won't bring it back."
			expectedName={workspace.name}
			nameLabel="Workspace name"
			confirmLabel={
				liveLinks.length > 0
					? "Turn off links and delete"
					: "Delete permanently"
			}
			pendingLabel="Deleting…"
			destructive
			confirmDisabled={checking}
			isPending={remove.isPending}
			error={remove.error}
			onConfirm={() => remove.mutate()}
		>
			<div className="grid gap-3">
				{liveLinks.length > 0 ? (
					<Alert variant="warning">
						<AlertTitle>
							{liveLinks.length === 1
								? "1 share link is still on"
								: `${liveLinks.length} share links are still on`}
						</AlertTitle>
						<AlertDescription>
							Deleting turns {liveLinks.length === 1 ? "it" : "them"} off first.
							Anyone using {liveLinks.length === 1 ? "it" : "them"} loses
							access.
						</AlertDescription>
					</Alert>
				) : null}
				{shares.isError || suggestions.isError ? (
					<Alert variant="warning">
						<AlertDescription>
							Tedix couldn't check this workspace's share links and agent
							suggestions. If either blocks the delete, you'll see why here.
						</AlertDescription>
					</Alert>
				) : null}
				<WorkspaceEffectList
					heading="Deleted for good"
					items={copy.deleteRemoves}
				/>
				<WorkspaceEffectList
					heading="Kept"
					items={[
						workspace.visibility === "private"
							? copy.deleteKeepsPrivateOutputs
							: copy.deleteKeepsOutputs,
						...copy.deleteKeeps,
					]}
				/>
			</div>
		</TypedConfirmDialog>
	);
}

/** A short headed list of what an archive or delete does. */
export function WorkspaceEffectList({
	heading,
	items,
}: {
	heading: string;
	items: readonly string[];
}) {
	return (
		<section className="grid gap-1">
			<Text as="h3" role="label" weight="medium" tone="strong">
				{heading}
			</Text>
			<ul className="m-0 grid list-disc gap-1 pl-5">
				{items.map((item) => (
					<Text as="li" key={item} role="body" tone="secondary">
						{item}
					</Text>
				))}
			</ul>
		</section>
	);
}
