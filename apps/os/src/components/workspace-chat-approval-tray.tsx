import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { appEditRequestFrom } from "@/lib/app-edit-approval";
import type { ChatApproval } from "@/lib/workspace-chat-state";
import {
	approvalTitle,
	webPageRequest,
} from "@/lib/workspace-chat-web-approval";

/** The item a proposal is for, when it names one. */
export function approvalTarget(approval: ChatApproval): string | null {
	if (approval.target?.title) return approval.target.title;
	const input = approval.input;
	if (input && typeof input === "object" && !Array.isArray(input)) {
		const title = (input as Record<string, unknown>).title;
		if (typeof title === "string" && title.trim()) return title;
		// A new app is named, not titled.
		const name = (input as Record<string, unknown>).name;
		if (typeof name === "string" && name.trim()) return name;
	}
	return null;
}

/**
 * What the proposal does to which item, for button names: "creating Budget",
 * "changing Plan", "editing an app draft".
 */
export function approvalSubject(approval: ChatApproval): string {
	const page = webPageRequest(approval);
	if (page) return `reading ${page.site}`;
	const target = approvalTarget(approval);
	const title = approval.title.trim();
	if (!target) return title.charAt(0).toLowerCase() + title.slice(1);
	const verb = title.split(/\s+/)[0]?.toLowerCase();
	const action =
		verb === "creating" || verb === "filing" ? "creating" : "changing";
	return `${action} ${target}`;
}

/**
 * Proposals still waiting for the person, above the composer. The chat goes
 * on while they wait; each can be decided here or on its card.
 */
export function ApprovalTray({
	approvals,
	onDecide,
	onApproveAll,
}: {
	approvals: readonly ChatApproval[];
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	onApproveAll: (approvalIds: string[]) => void;
}) {
	const [sent, setSent] = useState<ReadonlyMap<string, "approve" | "deny">>(
		new Map(),
	);
	if (approvals.length === 0) return null;
	const mark = (ids: string[], decision: "approve" | "deny") =>
		setSent((previous) => {
			const next = new Map(previous);
			for (const id of ids) next.set(id, decision);
			return next;
		});
	const open = approvals.filter((approval) => !sent.has(approval.approvalId));
	return (
		<section
			aria-label={`Waiting for you: ${approvals.length}`}
			className="workspace-chat-tray"
			data-testid="workspace-chat-tray"
		>
			<div className="workspace-chat-tray-head">
				<Text as="strong" role="label">
					Waiting for you ({approvals.length})
				</Text>
				{approvals.length > 1 ? (
					<Button
						disabled={open.length === 0}
						onClick={() => {
							const ids = open.map((approval) => approval.approvalId);
							mark(ids, "approve");
							onApproveAll(ids);
						}}
						size="sm"
					>
						Approve all
					</Button>
				) : null}
			</div>
			<ul className="workspace-chat-tray-list">
				{approvals.map((approval) => {
					const subject = approvalSubject(approval);
					const target = approvalTarget(approval);
					const page = webPageRequest(approval);
					const decision = sent.get(approval.approvalId);
					// An app draft is accepted or rejected as a whole, as on its card.
					const draft = appEditRequestFrom(approval.input) !== null;
					const no = draft ? "Reject" : "Deny";
					const yes = draft ? "Accept" : "Approve";
					return (
						<li key={approval.approvalId}>
							<a
								className="workspace-chat-tray-item"
								href={`#approval-${approval.approvalId}`}
								title="Show the proposal in the conversation"
							>
								<Text
									as="span"
									role="body"
									className="workspace-chat-tray-title"
								>
									{approvalTitle(approval)}
									{target ? `: ${target}` : ""}
								</Text>
								{page ? (
									<Text
										as="span"
										role="caption"
										tone="secondary"
										className="workspace-chat-tray-url"
									>
										{page.url}
									</Text>
								) : null}
							</a>
							<Button
								aria-label={`${no} ${subject}`}
								disabled={decision !== undefined}
								onClick={() => {
									mark([approval.approvalId], "deny");
									onDecide(approval.approvalId, "deny");
								}}
								size="sm"
								variant="outline"
							>
								{no}
							</Button>
							<Button
								aria-label={`${yes} ${subject}`}
								disabled={decision !== undefined}
								onClick={() => {
									mark([approval.approvalId], "approve");
									onDecide(approval.approvalId, "approve");
								}}
								size="sm"
							>
								{decision === "approve"
									? draft
										? "Accepting…"
										: "Approving…"
									: yes}
							</Button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
