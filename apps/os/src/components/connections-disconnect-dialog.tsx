/**
 * The disconnect confirmation shared by /admin/connections and the Apps page
 * panel. Disconnecting is destructive (tools lose their credential), so every
 * surface confirms first — and keeps the target available after an error so
 * the operator can retry instead of losing the dialog.
 */

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";

export interface DisconnectConnectionTarget {
	appId: string;
	providerName: string;
	tokenScope: "tenant" | "user";
	connectionInstanceId?: string;
}

export function DisconnectConnectionDialog({
	target,
	isPending,
	onCancel,
	onConfirm,
}: {
	target: DisconnectConnectionTarget | null;
	isPending: boolean;
	onCancel: () => void;
	onConfirm: (target: DisconnectConnectionTarget) => void;
}) {
	return (
		<AlertDialog
			open={target !== null}
			onOpenChange={(open) => {
				if (!open && !isPending) onCancel();
			}}
		>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>
						Disconnect {target?.providerName ?? "credential"}?
					</AlertDialogTitle>
					<AlertDialogDescription>
						Tools that rely on this{" "}
						{target?.tokenScope === "user" ? "personal" : "organization"}{" "}
						credential will stop working until it is connected again.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={!target || isPending}
						onClick={(event) => {
							event.preventDefault();
							if (!target) return;
							onConfirm(target);
						}}
					>
						{isPending ? "Disconnecting…" : "Disconnect"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
