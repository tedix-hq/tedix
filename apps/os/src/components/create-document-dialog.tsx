import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OsOutput } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
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
import { Label } from "@/components/kumo/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import {
	documentFromTemplate,
	documentTemplates,
	type DocumentTemplateId,
} from "@/lib/document-templates";
import {
	activeWorkspacesQueryOptions,
	canvasOutputsQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";

type Props = { workspaceId?: string; onCreated: (output: OsOutput) => void };

export function CreateDocumentButton(props: Props) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button size="sm" onClick={() => setOpen(true)}>
				<Plus size={16} />
				New document
			</Button>
			{open && (
				<CreateDocumentDialog {...props} onClose={() => setOpen(false)} />
			)}
		</>
	);
}

export function CreateDocumentDialog({
	workspaceId,
	onCreated,
	onClose,
}: Props & { onClose: () => void }) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	const [templateId, setTemplateId] = useState<DocumentTemplateId>("blank");
	const [selectedWorkspace, setSelectedWorkspace] = useState(
		workspaceId ?? "none",
	);
	const workspaces = useQuery({
		...activeWorkspacesQueryOptions(),
		enabled: !workspaceId,
	});
	const template = documentTemplates.find(
		(candidate) => candidate.id === templateId,
	)!;
	const create = useMutation({
		...osQuery.osWorkspaces.outputs.create.mutationOptions(),
		onSuccess: ({ output }) => {
			// Canvas validates the URL against this list before opening a workpiece.
			// Reconcile the known create result before navigation: an async refetch
			// alone leaves the cached list able to reject the newly created ID.
			if (output.workspaceId) {
				queryClient.setQueryData(
					canvasOutputsQueryOptions(output.workspaceId).queryKey,
					(current) =>
						current
							? {
									...current,
									items: [
										output,
										...current.items.filter((item) => item.id !== output.id),
									],
								}
							: undefined,
				);
			}
			void queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
			onClose();
			onCreated(output);
		},
	});
	const createDocument = () => {
		const cleanTitle =
			title.trim() ||
			(templateId === "blank" ? "Untitled document" : template.name);
		create.mutate({
			kind: "document",
			title: cleanTitle,
			...(selectedWorkspace === "none"
				? {}
				: { workspaceId: selectedWorkspace }),
			content: documentFromTemplate(templateId, cleanTitle),
		});
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !create.isPending) onClose();
			}}
		>
			<DialogContent showCloseButton={!create.isPending}>
				<DialogHeader>
					<DialogTitle>New document</DialogTitle>
					<DialogDescription>
						Start from a blank page or a working template. You can edit
						everything afterwards.
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!create.isPending) createDocument();
					}}
				>
					<div className="grid gap-2">
						<Label htmlFor="new-document-title">Title</Label>
						<Input
							id="new-document-title"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder={
								templateId === "blank" ? "Untitled document" : template.name
							}
							maxLength={120}
							disabled={create.isPending}
							autoFocus
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="new-document-template">Template</Label>
						<Select
							value={templateId}
							onValueChange={(value) => {
								if (value) setTemplateId(value as DocumentTemplateId);
							}}
							disabled={create.isPending}
						>
							<SelectTrigger id="new-document-template">
								<SelectValue>{template.name}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{documentTemplates.map((item) => (
									<SelectItem key={item.id} value={item.id}>
										{item.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-sm text-kumo-subtle">{template.description}</p>
					</div>
					{!workspaceId && (
						<div className="grid gap-2">
							<Label htmlFor="new-document-workspace">Workspace</Label>
							<Select
								value={selectedWorkspace}
								onValueChange={(value) => {
									if (value) setSelectedWorkspace(value);
								}}
								disabled={create.isPending || workspaces.isPending}
							>
								<SelectTrigger id="new-document-workspace">
									<SelectValue>
										{selectedWorkspace === "none"
											? "No workspace"
											: workspaces.data?.items.find(
													(item) => item.id === selectedWorkspace,
												)?.name}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">No workspace</SelectItem>
									{workspaces.data?.items.map((item) => (
										<SelectItem key={item.id} value={item.id}>
											{item.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{workspaces.isError && (
								<p role="alert" className="text-sm text-kumo-danger">
									Workspaces could not be loaded. You can create a document
									without a workspace or{" "}
									<Button
										type="button"
										variant="link"
										size="sm"
										onClick={() => void workspaces.refetch()}
									>
										try again
									</Button>
									.
								</p>
							)}
						</div>
					)}
					{create.isError && (
						<Alert variant="destructive">
							<AlertTitle>Document not created</AlertTitle>
							<AlertDescription>{create.error.message}</AlertDescription>
						</Alert>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={create.isPending}
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button type="submit" loading={create.isPending}>
							Create document
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
