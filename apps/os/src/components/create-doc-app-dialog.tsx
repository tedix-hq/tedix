import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	OsGadget,
	OsOutput,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/kumo/dialog";
import {
	canvasGadgetsQueryOptions,
	canvasOutputsQueryOptions,
	activeWorkspacesQueryOptions,
	workspaceResourcesQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";

export function CreateOutputAppDialog({
	workspaceId,
	kind = "document",
	onCreated,
	onOpenOutput,
	onClose,
}: {
	workspaceId?: string;
	kind?: "document" | "sheet" | "presentation";
	onCreated: (gadget: OsGadget) => void;
	onOpenOutput: (output: OsOutput) => void;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(),
		enabled: !workspaceId,
	});
	const [selectedWorkspace, setSelectedWorkspace] = useState("");
	const targetWorkspace =
		workspaceId ||
		selectedWorkspace ||
		(workspaces.data?.items.length === 1 ? workspaces.data.items[0]!.id : "");
	const label =
		kind === "document" ? "Doc" : kind === "sheet" ? "Sheet" : "Slides";
	const defaultTitle =
		kind === "document"
			? "Untitled document"
			: kind === "sheet"
				? "Untitled sheet"
				: "Untitled presentation";
	const content: OsOutputContent =
		kind === "document"
			? { kind, blocks: [] }
			: kind === "sheet"
				? { kind, columns: ["A", "B", "C"], rows: [] }
				: { kind, slides: [{ title: "Untitled slide", bullets: [] }] };
	const submitting = useRef(false);
	const [title, setTitle] = useState("");
	const [output, setOutput] = useState<OsOutput | null>(null);
	const [error, setError] = useState<string | null>(null);
	const create = useMutation(
		osQuery.osWorkspaces.outputs.create.mutationOptions(),
	);
	const install = useMutation(
		osQuery.osWorkspaces.gadgets.installOutputEditor.mutationOptions(),
	);
	const pending = create.isPending || install.isPending;
	const submit = async () => {
		if (submitting.current || !targetWorkspace) return;
		submitting.current = true;
		setError(null);
		try {
			const document =
				output ??
				(
					await create.mutateAsync({
						workspaceId: targetWorkspace,
						title: title.trim() || defaultTitle,
						kind,
						content,
					})
				).output;
			setOutput(document);
			client.setQueryData(
				canvasOutputsQueryOptions(targetWorkspace).queryKey,
				(current) =>
					current
						? {
								...current,
								items: [
									document,
									...current.items.filter((item) => item.id !== document.id),
								],
							}
						: undefined,
			);
			const { gadget } = await install.mutateAsync({
				workspaceId: targetWorkspace,
				outputId: document.id,
				kind,
			});
			client.setQueryData(
				canvasGadgetsQueryOptions(targetWorkspace).queryKey,
				(current) =>
					current
						? {
								...current,
								items: [
									gadget,
									...current.items.filter((item) => item.id !== gadget.id),
								],
							}
						: undefined,
			);
			void client.invalidateQueries({ queryKey: osQueryKeys.blueprints() });
			void client.invalidateQueries({ queryKey: osQueryKeys.outputs() });
			void client.invalidateQueries({ queryKey: osQueryKeys.gadgets() });
			void client.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(targetWorkspace).queryKey,
			});
			onCreated(gadget);
			onClose();
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: `Could not create ${label}`,
			);
		} finally {
			submitting.current = false;
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose();
			}}
		>
			<DialogContent showCloseButton={!pending}>
				<DialogHeader>
					<DialogTitle>New {label}</DialogTitle>
					<DialogDescription>
						Create a {label} gadget that edits one saved file with revision
						history in your workspace.
					</DialogDescription>
				</DialogHeader>
				<label>
					Title
					<Input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						placeholder={defaultTitle}
						disabled={pending || !!output}
					/>
				</label>
				{!workspaceId && (
					<label>
						Workspace
						<Select
							value={targetWorkspace}
							onValueChange={(value) => {
								if (value) setSelectedWorkspace(value);
							}}
							disabled={pending || !!output || workspaces.isPending}
						>
							<SelectTrigger aria-label="Workspace">
								<SelectValue placeholder="Choose a workspace">
									{workspaces.data?.items.find(
										(row) => row.id === targetWorkspace,
									)?.name ?? "Choose a workspace"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{workspaces.data?.items.map((row) => (
									<SelectItem key={row.id} value={row.id}>
										{row.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
				)}
				{!workspaceId && workspaces.isError && (
					<p role="alert">
						Workspaces could not be loaded.{" "}
						<Button
							variant="secondary"
							onClick={() => void workspaces.refetch()}
						>
							Retry
						</Button>
					</p>
				)}
				{!workspaceId &&
					workspaces.isSuccess &&
					!workspaces.data.items.length && (
						<p>Create a workspace first to add a {label} gadget.</p>
					)}
				{error && (
					<p role="alert">
						{error}
						{output
							? " Your file was created. Retry installing its editor, or open the file read-only."
							: ""}
					</p>
				)}
				<DialogFooter>
					{output && error && (
						<Button
							variant="secondary"
							onClick={() => {
								onOpenOutput(output);
								onClose();
							}}
						>
							Open file read-only
						</Button>
					)}
					<Button
						disabled={pending || !targetWorkspace}
						onClick={() => void submit()}
					>
						{pending
							? "Creating…"
							: output
								? "Retry app installation"
								: `Create ${label}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
