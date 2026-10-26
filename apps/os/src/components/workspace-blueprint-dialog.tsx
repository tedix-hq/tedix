import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
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
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";

export function WorkspaceBlueprintDialog({
	workspace,
	onOpenChange,
}: {
	workspace: OsWorkspace;
	onOpenChange: (open: boolean) => void;
}) {
	const [name, setName] = useState(workspace.name);
	const queryClient = useQueryClient();
	const save = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.blueprints.saveWorkspace({
				workspaceId: workspace.id,
				name: name.trim(),
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.blueprints() }),
	});
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{save.isSuccess ? "Blueprint saved" : "Save as blueprint"}
					</DialogTitle>
					<DialogDescription>
						{save.isSuccess
							? "Your draft is in Blueprints. Publish it there when it is ready to install."
							: "Copy the committed apps, code and resource slots into a reusable draft. App data, documents and chats stay here. Each installation gets its own app storage and chooses its resources."}
					</DialogDescription>
				</DialogHeader>
				{save.isSuccess ? (
					<DialogFooter>
						<Button onClick={() => onOpenChange(false)}>Done</Button>
					</DialogFooter>
				) : (
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							save.mutate();
						}}
					>
						<label className="grid gap-2 text-sm">
							Blueprint name
							<Input
								aria-label="Blueprint name"
								autoFocus
								value={name}
								maxLength={120}
								required
								onChange={(event) => setName(event.target.value)}
							/>
						</label>
						{save.isError ? (
							<Alert variant="destructive">
								<AlertTitle>Blueprint not saved</AlertTitle>
								<AlertDescription>
									{save.error instanceof Error
										? save.error.message
										: "Try saving again."}
								</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button
								variant="outline"
								type="button"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								loading={save.isPending}
								disabled={!name.trim()}
							>
								Save blueprint
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
