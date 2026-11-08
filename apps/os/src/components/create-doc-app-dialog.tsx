import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	OsGadget,
	OsOutput,
} from "@tedix/api-contract/schemas/os-workspaces";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
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
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";

export function CreateDocAppDialog({
	workspaceId,
	onCreated,
	onOpenOutput,
	onClose,
}: {
	workspaceId: string;
	onCreated: (gadget: OsGadget) => void;
	onOpenOutput: (output: OsOutput) => void;
	onClose: () => void;
}) {
	const client = useQueryClient();
	const [title, setTitle] = useState("");
	const [output, setOutput] = useState<OsOutput | null>(null);
	const [error, setError] = useState<string | null>(null);
	const create = useMutation(
		osQuery.osWorkspaces.outputs.create.mutationOptions(),
	);
	const install = useMutation(
		osQuery.osWorkspaces.gadgets.installDocument.mutationOptions(),
	);
	const pending = create.isPending || install.isPending;
	const submit = async () => {
		setError(null);
		try {
			const document =
				output ??
				(
					await create.mutateAsync({
						workspaceId,
						title: title.trim() || "Untitled document",
						kind: "document",
						content: { kind: "document", blocks: [] },
					})
				).output;
			setOutput(document);
			client.setQueryData(
				canvasOutputsQueryOptions(workspaceId).queryKey,
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
				workspaceId,
				outputId: document.id,
			});
			client.setQueryData(
				canvasGadgetsQueryOptions(workspaceId).queryKey,
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
			onCreated(gadget);
			onClose();
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not create the Doc app",
			);
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
					<DialogTitle>New Doc app</DialogTitle>
					<DialogDescription>
						Create a blank document with a reusable editor app. Its content and
						revision history stay in this workspace.
					</DialogDescription>
				</DialogHeader>
				<label>
					Document title
					<Input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						placeholder="Untitled document"
						disabled={pending || !!output}
					/>
				</label>
				{error && (
					<p role="alert">
						{error}
						{output
							? " Your document was created. Retry installing the app or open it in the editor."
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
							Open document
						</Button>
					)}
					<Button disabled={pending} onClick={() => void submit()}>
						{pending
							? "Creating…"
							: output
								? "Retry app installation"
								: "Create Doc app"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
