import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { Button } from "@/components/kumo/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";

export function DocEditorUpgrade({
	workspaceId,
	outputId,
	gadgetId,
	revisionId,
}: {
	workspaceId: string;
	outputId: string;
	gadgetId: string;
	revisionId: string;
}) {
	const [open, setOpen] = useState(false);
	const client = useQueryClient();
	const upgrade = useMutation({
		mutationFn: async () => {
			const result = await osApi.osWorkspaces.gadgets.installOutputEditor({
				workspaceId,
				outputId,
				kind: "document",
				upgradeFromRevisionId: revisionId,
			});
			if (result.gadget.id !== gadgetId)
				throw new Error(
					"The editor identity changed. Reopen the workspace to review it.",
				);
			return result;
		},
		onSuccess: async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
				client.invalidateQueries({ queryKey: osQueryKeys.blueprints() }),
			]);
			setOpen(false);
		},
	});
	return (
		<>
			<Alert>
				<AlertTitle>Doc version 3 is available</AlertTitle>
				<AlertDescription>
					Upgrade to the latest reusable Doc editor. Your saved document and its
					history stay in place.
				</AlertDescription>
				<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
					Upgrade Doc editor
				</Button>
			</Alert>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Upgrade this Doc editor?"
				description="Save any edits first. This updates the editor code while keeping the same document, app and revision history. Unsaved edits in this view will be discarded."
				confirmLabel="Upgrade editor"
				pendingLabel="Upgrading…"
				isPending={upgrade.isPending}
				error={upgrade.error}
				onConfirm={() => upgrade.mutate()}
			/>
		</>
	);
}
