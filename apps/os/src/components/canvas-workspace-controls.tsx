import {
	Archive,
	ArrowCircleUp,
	Bell,
	BellSlash,
	Copy,
	DotsThree,
	PencilSimple,
	Plus,
	UsersThree,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { type ReactNode, useEffect, useRef, useState } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import { osApi } from "@/lib/api";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";
import { WorkspaceBlueprintDialog } from "@/components/workspace-blueprint-dialog";
import { WorkspaceIconField } from "@/components/workspace-icon-field";
import {
	BlueprintUpdateButton,
	BlueprintUpdateDialog,
	useBlueprintUpdate,
} from "@/components/workspace-blueprint-update";
import {
	WorkspaceShareDialog,
	type WorkspaceShareItem,
} from "@/components/workspace-share-dialog";

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The workspace could not be saved.";
}

const workspaceFormSchema = z.object({
	name: z.string().trim().min(1, "Enter a workspace name.").max(120),
	description: z.string().trim().max(2000),
});

function WorkspaceFormDialog({
	mode,
	open,
	workspace,
	onOpenChange,
	onSaved,
}: {
	mode: "create" | "edit";
	open: boolean;
	workspace?: OsWorkspace;
	onOpenChange: (open: boolean) => void;
	onSaved: (workspace: OsWorkspace) => void;
}) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (value: z.output<typeof workspaceFormSchema>) => {
			return mode === "create"
				? osApi.osWorkspaces.workspaces.create({
						name: value.name,
						...(value.description ? { description: value.description } : {}),
					})
				: osApi.osWorkspaces.workspaces.update({
						workspaceId: workspace!.id,
						name: value.name,
						description: value.description || null,
					});
		},
		onSuccess: async ({ workspace: saved }) => {
			await Promise.all([
				// Every input variant of `workspaces.list` — Canvas' own list, the
				// workspace library, the sidebar, and the command palette's shorter
				// slice — in one partial key. A hand-written literal could never
				// reach any of them.
				queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() }),
			]);
			onSaved(saved);
			onOpenChange(false);
		},
	});
	const form = useZodForm({
		schema: workspaceFormSchema,
		defaultValues: { name: "", description: "" },
		validateOn: "submit",
		onSubmit: async ({ value }) => {
			await mutation.mutateAsync(value);
		},
	});

	const resetMutation = mutation.reset;
	// Fill the form when it opens or switches workspace, never when a refetch
	// (say, after the icon saves) hands over a new copy of the same workspace;
	// that would throw away what the user is typing.
	const latestWorkspace = useRef(workspace);
	latestWorkspace.current = workspace;
	const workspaceId = workspace?.id;
	useEffect(() => {
		if (!open) return;
		form.reset({
			name: latestWorkspace.current?.name ?? "",
			description: latestWorkspace.current?.description ?? "",
		});
		resetMutation();
	}, [form, resetMutation, open, workspaceId]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						void form.handleSubmit();
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{mode === "create" ? "Create workspace" : "Edit workspace"}
						</DialogTitle>
						<DialogDescription>
							A workspace keeps related conversations, documents and Work
							together.
						</DialogDescription>
					</DialogHeader>
					<FormField form={form} name="name" label="Name">
						{(field, meta) => (
							<FormInput field={field} {...meta} autoFocus maxLength={120} />
						)}
					</FormField>
					<FormField
						form={form}
						name="description"
						label="Description"
						optional
					>
						{(field, meta) => (
							<FormTextarea
								field={field}
								{...meta}
								maxLength={2000}
								placeholder="What belongs in this workspace?"
							/>
						)}
					</FormField>
					{mode === "edit" && workspace ? (
						<WorkspaceIconField workspace={workspace} />
					) : null}
					{mutation.isError && (
						<Alert variant="destructive">
							<AlertTitle>Workspace not saved</AlertTitle>
							<AlertDescription>
								{errorMessage(mutation.error)}
							</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<form.Subscribe
							selector={(state) => [state.canSubmit, state.isSubmitting]}
						>
							{([canSubmit, isSubmitting]) => (
								<Button
									type="submit"
									disabled={!canSubmit}
									loading={isSubmitting}
								>
									{mode === "create" ? "Create workspace" : "Save changes"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function CanvasWorkspaceControls({
	workspace,
	showCreate = true,
	compactActions = false,
	openItem,
	menuItems,
	onSelected,
	onArchived,
}: {
	workspace?: OsWorkspace;
	showCreate?: boolean;
	compactActions?: boolean;
	/** The open app or file; Share also offers a link to it alone. */
	openItem?: WorkspaceShareItem;
	/** The host's own entries, listed first in the workspace menu. */
	menuItems?: ReactNode;
	onSelected: (workspaceId: string) => void;
	onArchived: () => void;
}) {
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [shareOpen, setShareOpen] = useState(false);
	const [blueprintOpen, setBlueprintOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const blueprintUpdate = useBlueprintUpdate(workspace);

	const archive = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.workspaces.archive({ workspaceId: workspace!.id }),
		onSuccess: async () => {
			await Promise.all([
				// Every input variant of `workspaces.list` — Canvas' own list, the
				// workspace library, the sidebar, and the command palette's shorter
				// slice — in one partial key. A hand-written literal could never
				// reach any of them.
				queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() }),
			]);
			setArchiveOpen(false);
			onArchived();
		},
	});

	const push = useQuery({
		...osQuery.webPush.getStatus.queryOptions({ input: {} }),
		enabled: !!workspace,
	});
	const pushMuted =
		(workspace &&
			push.data?.preferences.mutedWorkspaceIds?.includes(workspace.id)) ??
		false;
	const pushMute = useMutation({
		mutationFn: (mutedWorkspaceIds: string[]) =>
			osApi.webPush.setPreferences({
				mutedProjectIds: push.data?.preferences.mutedProjectIds ?? [],
				mutedWorkspaceIds,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: osQuery.webPush.getStatus.key(),
			}),
	});
	const togglePushMute = () => {
		if (!workspace || !push.data) return;
		const ids = push.data.preferences.mutedWorkspaceIds ?? [];
		pushMute.mutate(
			pushMuted
				? ids.filter((id) => id !== workspace.id)
				: [...new Set([...ids, workspace.id])],
		);
	};
	const pushMuteDisabled = !push.data || pushMute.isPending;

	return (
		<>
			<div
				className={
					compactActions
						? "flex items-center gap-1"
						: "flex flex-wrap items-center gap-2"
				}
			>
				{showCreate ? (
					<Button onClick={() => setCreateOpen(true)}>
						<Plus size={14} /> New workspace
					</Button>
				) : null}
				{workspace && (
					<>
						{blueprintUpdate ? (
							<BlueprintUpdateButton
								compact={compactActions}
								revision={blueprintUpdate.candidate.revision}
								blueprintName={blueprintUpdate.blueprintName}
								onOpen={() => setUpdateOpen(true)}
							/>
						) : null}
						{compactActions ? (
							<Button
								aria-label="Share"
								size="icon-sm"
								title="Share workspace"
								variant="ghost"
								onClick={() => setShareOpen(true)}
							>
								<UsersThree size={16} />
							</Button>
						) : (
							<Button
								size="sm"
								variant="secondary"
								onClick={() => setShareOpen(true)}
							>
								<UsersThree size={14} /> Share
							</Button>
						)}
						{/* The compact header keeps Share as its one icon; Edit, mute and
						    Archive live in the menu. */}
						{!compactActions && (
							<span className="hidden items-center gap-2 sm:flex">
								<Button
									size="sm"
									variant="outline"
									onClick={() => setEditOpen(true)}
								>
									<PencilSimple size={14} /> Edit
								</Button>
								<Button
									disabled={pushMuteDisabled}
									size="sm"
									title={
										pushMuted
											? "Notifications muted — approvals still arrive"
											: "Mute notifications"
									}
									variant="ghost"
									onClick={togglePushMute}
								>
									{pushMuted ? <BellSlash size={14} /> : <Bell size={14} />}
									{pushMuted ? "Unmute" : "Mute"}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setArchiveOpen(true)}
								>
									<Archive size={14} /> Archive
								</Button>
							</span>
						)}
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="Workspace actions"
										size="icon-sm"
										variant={compactActions ? "ghost" : "outline"}
									/>
								}
							>
								<DotsThree size={16} weight="bold" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{menuItems ? (
									<>
										{menuItems}
										<DropdownMenuSeparator />
									</>
								) : null}
								{blueprintUpdate ? (
									<DropdownMenuItem onClick={() => setUpdateOpen(true)}>
										<ArrowCircleUp size={14} /> Update available
									</DropdownMenuItem>
								) : null}
								<DropdownMenuItem onClick={() => setBlueprintOpen(true)}>
									<Copy size={14} /> Save as blueprint
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setEditOpen(true)}>
									<PencilSimple size={14} /> Edit workspace
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={pushMuteDisabled}
									onClick={togglePushMute}
								>
									{pushMuted ? <Bell size={14} /> : <BellSlash size={14} />}
									{pushMuted ? "Unmute notifications" : "Mute notifications"}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setArchiveOpen(true)}
								>
									<Archive size={14} /> Archive workspace
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				)}
			</div>
			{showCreate ? (
				<WorkspaceFormDialog
					mode="create"
					open={createOpen}
					onOpenChange={setCreateOpen}
					onSaved={(saved) => onSelected(saved.id)}
				/>
			) : null}
			{workspace && (
				<>
					{updateOpen && blueprintUpdate ? (
						<BlueprintUpdateDialog
							workspace={workspace}
							blueprintName={blueprintUpdate.blueprintName}
							candidate={blueprintUpdate.candidate}
							onOpenChange={setUpdateOpen}
						/>
					) : null}
					{blueprintOpen ? (
						<WorkspaceBlueprintDialog
							workspace={workspace}
							onOpenChange={setBlueprintOpen}
						/>
					) : null}
					{shareOpen ? (
						<WorkspaceShareDialog
							workspaceId={workspace.id}
							workspaceName={workspace.name}
							visibility={workspace.visibility}
							item={openItem}
							open
							onOpenChange={setShareOpen}
						/>
					) : null}
					<WorkspaceFormDialog
						mode="edit"
						open={editOpen}
						workspace={workspace}
						onOpenChange={setEditOpen}
						onSaved={(saved) => onSelected(saved.id)}
					/>
					<Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Archive {workspace.name}?</DialogTitle>
								<DialogDescription>
									It will leave the active Canvas list. Its committed records
									and execution evidence remain durable.
								</DialogDescription>
							</DialogHeader>
							{archive.isError && (
								<Alert variant="destructive">
									<AlertTitle>Workspace not archived</AlertTitle>
									<AlertDescription>
										{errorMessage(archive.error)}
									</AlertDescription>
								</Alert>
							)}
							<DialogFooter>
								<Button variant="outline" onClick={() => setArchiveOpen(false)}>
									Cancel
								</Button>
								<Button
									variant="destructive"
									loading={archive.isPending}
									onClick={() => archive.mutate()}
								>
									Archive workspace
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				</>
			)}
		</>
	);
}
