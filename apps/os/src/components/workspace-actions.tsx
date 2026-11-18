import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { activeWorkspaceMutes } from "@tedix/api-contract/schemas/web-push";
import { useEffect, useRef } from "react";
import * as z from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Text } from "@/components/kumo/text";
import { WorkspaceEffectList } from "@/components/workspace-delete-dialog";
import { WorkspaceIconField } from "@/components/workspace-icon-field";
import { useWorkspaceMuteState } from "@/components/workspace-muted-icon";
import { osApi } from "@/lib/api";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";
import {
	WORKSPACE_MUTE_CHOICES,
	workspaceMuteLabel,
	workspaceMuteUntil,
} from "@/lib/workspace-mute";
import { OS_COPY } from "@/shared/os-copy";

/*
 * The dialogs and writes behind a workspace's own actions (edit, mute,
 * archive). The workspace header and the "⋯" menu on a workspace row both use
 * them, so an action behaves the same wherever it is started.
 */

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The workspace could not be saved.";
}

const workspaceFormSchema = z.object({
	name: z.string().trim().min(1, "Enter a workspace name.").max(120),
	description: z.string().trim().max(2000),
});

/** Create a workspace, or change its name, description and icon. */
export function WorkspaceFormDialog({
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

/**
 * Whether the person muted a workspace, until when, and the ways to change
 * it. A muted workspace sends no notifications and shows no unread count;
 * approval requests still arrive.
 */
export function useWorkspaceMute(workspaceId: string | undefined) {
	const queryClient = useQueryClient();
	const { muted, until, preferences } = useWorkspaceMuteState(workspaceId);
	const save = useMutation({
		mutationFn: (next: { muted: boolean; until: string | null }) => {
			const active = activeWorkspaceMutes(preferences ?? {}, Date.now());
			const mutedWorkspaceUntil = { ...active.mutedWorkspaceUntil };
			delete mutedWorkspaceUntil[workspaceId!];
			if (next.muted && next.until)
				mutedWorkspaceUntil[workspaceId!] = next.until;
			return osApi.webPush.setPreferences({
				mutedProjectIds: preferences?.mutedProjectIds ?? [],
				mutedWorkspaceIds: next.muted
					? [...new Set([...active.mutedWorkspaceIds, workspaceId!])]
					: active.mutedWorkspaceIds.filter((id) => id !== workspaceId),
				mutedWorkspaceUntil,
			});
		},
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQuery.webPush.getStatus.key(),
				}),
				// Unread counts leave out a muted workspace.
				queryClient.invalidateQueries({
					queryKey: osQuery.workspaceUnread.key(),
				}),
			]),
	});
	const ready = !!workspaceId && !!preferences;
	return {
		muted,
		until,
		/** "Muted until 14:30", or "Muted" when it has no end. */
		label: workspaceMuteLabel(until, new Date()),
		disabled: !ready || save.isPending,
		/** Mute until an ISO time; null mutes until the person unmutes. */
		mute: (end: string | null) => {
			if (ready) save.mutate({ muted: true, until: end });
		},
		unmute: () => {
			if (ready) save.mutate({ muted: false, until: null });
		},
	};
}

/** Asks how long to mute a workspace for. */
export function WorkspaceMuteDialog({
	workspaceName,
	open,
	onOpenChange,
	onChoose,
}: {
	workspaceName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The end of the mute as an ISO time; null for no end. */
	onChoose: (until: string | null) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Mute {workspaceName}</DialogTitle>
					<DialogDescription>
						You get no notifications and no unread count from this workspace
						while it is muted. Approval requests still reach you.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-1" role="group" aria-label="Mute for">
					{WORKSPACE_MUTE_CHOICES.map((choice) => (
						<Button
							key={choice.id}
							className="justify-start"
							variant="ghost"
							onClick={() => {
								onChoose(workspaceMuteUntil(choice.id, new Date()));
								onOpenChange(false);
							}}
						>
							{choice.label}
						</Button>
					))}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Asks before archiving a workspace and says what stops and what is kept. */
export function WorkspaceArchiveDialog({
	workspace,
	open,
	onOpenChange,
	onArchived,
}: {
	workspace: Pick<OsWorkspace, "id" | "name">;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onArchived: () => void;
}) {
	const queryClient = useQueryClient();
	const archive = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.workspaces.archive({ workspaceId: workspace.id }),
		onSuccess: async () => {
			// Every input variant of `workspaces.list` — Canvas' own list, the
			// workspace library, the sidebar, and the command palette's shorter
			// slice — in one partial key. A hand-written literal could never
			// reach any of them.
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspaces(),
			});
			onOpenChange(false);
			onArchived();
		},
	});
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Archive ${workspace.name}?`}
			description="Nothing is deleted. You can restore it any time from Workspaces → Archived."
			confirmLabel="Archive workspace"
			pendingLabel="Archiving…"
			destructive
			isPending={archive.isPending}
			error={archive.error}
			onConfirm={() => archive.mutate()}
		>
			<div className="grid gap-3">
				<WorkspaceEffectList
					heading="What stops"
					items={OS_COPY.workspaceLifecycle.archiveStops}
				/>
				<WorkspaceEffectList
					heading="What's kept"
					items={OS_COPY.workspaceLifecycle.archiveKeeps}
				/>
				<Text role="body" tone="secondary" className="m-0">
					Just a test workspace? After archiving, choose Delete permanently
					under Workspaces → Archived.
				</Text>
			</div>
		</ConfirmDialog>
	);
}
