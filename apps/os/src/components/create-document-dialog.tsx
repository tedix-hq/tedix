import { Text } from "@/components/kumo/text";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLinkItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
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

type CreationKind = "document" | "sheet" | "presentation";

export function NewResourceMenu(props: Props) {
	const [kind, setKind] = useState<CreationKind | null>(null);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button size="sm" />}>
					<Plus size={16} />
					New
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => setKind("document")}>
						Document
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setKind("sheet")}>
						Sheet
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => setKind("presentation")}>
						Slides
					</DropdownMenuItem>
					<DropdownMenuLinkItem href="/blueprints">
						App from template
					</DropdownMenuLinkItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{kind && (
				<CreateDocumentDialog
					{...props}
					kind={kind}
					onClose={() => setKind(null)}
				/>
			)}
		</>
	);
}

export function CreateDocumentDialog({
	workspaceId,
	onCreated,
	onClose,
	kind = "document",
}: Props & { onClose: () => void; kind?: CreationKind }) {
	const label = kind === "presentation" ? "slides" : kind;
	const defaultTitle = `Untitled ${label}`;
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
			(kind !== "document" || templateId === "blank"
				? defaultTitle
				: template.name);
		create.mutate({
			kind,
			title: cleanTitle,
			...(selectedWorkspace === "none"
				? {}
				: { workspaceId: selectedWorkspace }),
			content:
				kind === "sheet"
					? { kind: "sheet", columns: ["A", "B", "C"], rows: [] }
					: kind === "presentation"
						? {
								kind: "presentation",
								slides: [{ title: cleanTitle, bullets: [] }],
							}
						: documentFromTemplate(templateId, cleanTitle),
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
					<DialogTitle>New {label}</DialogTitle>
					<DialogDescription>
						{kind === "document"
							? "Start from a blank page or a working template."
							: "Start with an editable blank file."}{" "}
						You can edit everything afterwards.
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
							aria-label="Title"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder={
								kind !== "document" || templateId === "blank"
									? defaultTitle
									: template.name
							}
							maxLength={120}
							disabled={create.isPending}
							autoFocus
						/>
					</div>
					{kind === "document" && (
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
							<Text role="label" tone="secondary">
								{template.description}
							</Text>
						</div>
					)}
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
								<div role="alert">
									<Text role="label" tone="error">
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
									</Text>
								</div>
							)}
						</div>
					)}
					{create.isError && (
						<Alert variant="destructive">
							<AlertTitle>{label} not created</AlertTitle>
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
							Create {label}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
