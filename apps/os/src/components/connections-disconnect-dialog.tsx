/**
 * The disconnect confirmation shared by /admin/connections and the Apps page
 * panel. Disconnecting is destructive (tools lose their credential), so every
 * surface confirms first — and keeps the target available after an error so
 * the operator can retry instead of losing the dialog.
 */

import { ConfirmDialog } from "@/components/confirm-dialog";

export interface DisconnectConnectionTarget {
	appId: string;
	providerName: string;
	tokenScope: "tenant" | "user";
	connectionInstanceId?: string;
}

export function DisconnectConnectionDialog({
	target,
	isPending,
	error,
	onCancel,
	onConfirm,
}: {
	target: DisconnectConnectionTarget | null;
	isPending: boolean;
	/** The failed disconnect, shown inside the dialog so the retry is in place. */
	error?: unknown;
	onCancel: () => void;
	onConfirm: (target: DisconnectConnectionTarget) => void;
}) {
	return (
		<ConfirmDialog
			open={target !== null}
			error={error}
			retryLabel="Try again"
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
			title={`Disconnect ${target?.providerName ?? "credential"}?`}
			description={`Tools that rely on this ${target?.tokenScope === "user" ? "personal" : "organization"} credential will stop working until it is connected again.`}
			confirmLabel="Disconnect"
			pendingLabel="Disconnecting…"
			destructive
			isPending={isPending}
			confirmDisabled={!target}
			onConfirm={() => {
				if (target) onConfirm(target);
			}}
		/>
	);
}
