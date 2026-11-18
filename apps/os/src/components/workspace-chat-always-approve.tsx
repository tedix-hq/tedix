import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import type { AutoApprovalKind } from "@/lib/workspace-chat-protocol";

/**
 * "Always approve" on a proposal's card: a short confirmation that names
 * exactly what will be approved without asking from now on. Confirming
 * also approves the proposal on the card.
 */
export function AlwaysApproveButton({
	rule,
	disabled,
	onConfirm,
}: {
	rule: { kind: AutoApprovalKind; label: string };
	disabled: boolean;
	onConfirm: (kind: AutoApprovalKind) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				disabled={disabled}
				onClick={() => setOpen(true)}
				size="sm"
				variant="ghost"
			>
				Always approve…
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Always approve this kind of change?"
				description={`From now on, ${rule.label} is approved without asking. This change is approved too.`}
				confirmLabel="Always approve"
				pendingLabel="Saving…"
				isPending={false}
				onConfirm={() => {
					setOpen(false);
					onConfirm(rule.kind);
				}}
			>
				<Text role="body" tone="secondary">
					Deleting, sharing and anything outside this workspace still wait for
					you. You can turn this off under Activity and approvals, Workspace.
				</Text>
			</ConfirmDialog>
		</>
	);
}
