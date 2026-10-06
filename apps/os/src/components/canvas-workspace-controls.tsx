import { Archive, DotsThree, PencilSimple, Plus } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useState } from "react";
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
import { osQueryKeys } from "@/lib/os-query-options";
import { ShareControls } from "@/components/share-controls";

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
	useEffect(() => {
		if (!open) return;
		form.reset({
			name: workspace?.name ?? "",
			description: workspace?.description ?? "",
		});
		resetMutation();
	}, [form, resetMutation, open, workspace]);

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
							A workspace groups Gadgets and outputs inside this organization.
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
	onSelected,
	onArchived,
}: {
	workspace?: OsWorkspace;
	showCreate?: boolean;
	compactActions?: boolean;
	onSelected: (workspaceId: string) => void;
	onArchived: () => void;
}) {
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);

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

	return (
		<>
			<div className="flex flex-wrap items-center gap-2">
				{showCreate ? (
					<Button onClick={() => setCreateOpen(true)}>
						<Plus size={14} /> New workspace
					</Button>
				) : null}
				{workspace && (
					<>
						<ShareControls
							resourceType="workspace"
							resourceId={workspace.id}
							compact={compactActions}
						/>
						<span className="hidden items-center gap-2 sm:flex">
							{compactActions ? (
								<>
									<Button
										aria-label="Edit workspace"
										size="icon-sm"
										title="Edit workspace"
										variant="ghost"
										onClick={() => setEditOpen(true)}
									>
										<PencilSimple size={14} />
									</Button>
									<Button
										aria-label="Archive workspace"
										size="icon-sm"
										title="Archive workspace"
										variant="ghost"
										onClick={() => setArchiveOpen(true)}
									>
										<Archive size={14} />
									</Button>
								</>
							) : (
								<>
									<Button
										size="sm"
										variant="outline"
										onClick={() => setEditOpen(true)}
									>
										<PencilSimple size={14} /> Edit
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setArchiveOpen(true)}
									>
										<Archive size={14} /> Archive
									</Button>
								</>
							)}
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="Workspace actions"
										className="sm:hidden"
										size="icon-sm"
										variant="outline"
									/>
								}
							>
								<DotsThree size={16} weight="bold" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => setEditOpen(true)}>
									<PencilSimple size={14} /> Edit workspace
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
