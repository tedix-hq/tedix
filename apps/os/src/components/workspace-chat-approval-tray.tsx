import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { appEditRequestFrom } from "@/lib/app-edit-approval";
import {
	type ApprovalGroup,
	approvalGroups,
	approvalLine,
	approvalNoticeText,
	approvalRunOrder,
	approvalRunProgress,
	approvalTarget,
	askedElsewhereCount,
} from "@/lib/workspace-chat-approval-groups";
import type { ApprovalDecision } from "@/lib/workspace-chat-protocol";
import type {
	ApprovalNotice,
	ApprovalRun,
	ChatApproval,
	WaitingApproval,
} from "@/lib/workspace-chat-state";
import {
	approvalTitle,
	webPageRequest,
} from "@/lib/workspace-chat-web-approval";
import { ChatCard } from "./workspace-chat-card";
import { useWorkspaceChatAuthor } from "./workspace-chat-author";

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

type Decide = (approvalId: string, decision: ApprovalDecision) => void;
type DecideAll = (approvalIds: string[], decision: ApprovalDecision) => void;

/**
 * Everything the workspace is waiting on, above the composer and grouped by
 * what each request changes. The chat goes on while they wait. A request
 * raised in another chat is here too and marked, because the workspace owes
 * the answer whichever chat asked. One request can be decided on its own, a
 * group or the whole tray together.
 */
function Requester({
	id,
	kind,
	actingTediId,
	tediNames,
}: {
	id: string;
	kind: "person" | "tedi";
	/** The tedi the person addressed; it applies the change once approved. */
	actingTediId?: string;
	tediNames: Record<string, string>;
}) {
	const { name } = useWorkspaceChatAuthor(id, kind, tediNames);
	const acting = useWorkspaceChatAuthor(actingTediId ?? "", "tedi", tediNames);
	return (
		<Text as="span" role="caption" tone="secondary">
			Asked by {name}
			{actingTediId ? `. ${acting.name} will apply it.` : null}
		</Text>
	);
}

export function ApprovalTray({
	approvals,
	conversationId,
	run,
	notice,
	onDecide,
	onDecideAll,
	onDismissNotice,
	onOpenConversation,
	tediNames = {},
}: {
	/** The workspace's waiting requests, oldest first. */
	approvals: readonly WaitingApproval[];
	/** The open chat; a request from any other is marked as asked elsewhere. */
	conversationId: string | null;
	/** Several requests being decided one after another right now. */
	run: ApprovalRun | null;
	/** What the last decision reported; stays until dismissed. */
	notice: ApprovalNotice | null;
	onDecide: Decide;
	/** Decides the given requests one at a time, in the order given. */
	onDecideAll: DecideAll;
	onDismissNotice: () => void;
	/** Opens the chat that raised a request. */
	onOpenConversation?: (conversationId: string) => void;
	/** Names of tedis, for who asked. */
	tediNames?: Record<string, string>;
}) {
	const [sent, setSent] = useState<ReadonlyMap<string, ApprovalDecision>>(
		new Map(),
	);
	const [openGroup, setOpenGroup] = useState<string | null>(null);
	// A notice means a decision came back refused or a run stopped: whatever
	// is still listed is waiting again, so its buttons work again.
	const [noticed, setNoticed] = useState<ApprovalNotice | null>(notice);
	if (notice !== noticed) {
		setNoticed(notice);
		if (notice) setSent(new Map());
	}
	const alert = notice ? (
		<div
			className="workspace-chat-tray-notice"
			data-focus-ring="inset"
			role="alert"
		>
			<Text as="span" role="caption" tone="error">
				{approvalNoticeText(notice)}
			</Text>
			<Button onClick={onDismissNotice} size="sm" variant="ghost">
				Dismiss
			</Button>
		</div>
	) : null;
	// A run can empty the tray and still owe the person where it stopped.
	if (approvals.length === 0)
		return alert ? (
			<ChatCard
				aria-label="Waiting for you"
				className="workspace-chat-tray"
				data-testid="workspace-chat-tray"
				title="Waiting for you"
			>
				{alert}
			</ChatCard>
		) : null;

	const mark = (ids: readonly string[], decision: ApprovalDecision) =>
		setSent((previous) => {
			const next = new Map(previous);
			for (const id of ids) next.set(id, decision);
			return next;
		});
	const decideAll = (
		requests: readonly WaitingApproval[],
		decision: ApprovalDecision,
	) => {
		const open = requests.filter((request) => !sent.has(request.approvalId));
		const ids = approvalRunOrder(open, decision);
		if (ids.length === 0) return;
		mark(ids, decision);
		onDecideAll(ids, decision);
	};
	const decisionOf = (approvalId: string) =>
		run?.requests.some((request) => request.approvalId === approvalId)
			? run.decision
			: sent.get(approvalId);
	const busy = run !== null;
	const groups = approvalGroups(approvals, conversationId);
	const elsewhere = askedElsewhereCount(approvals, conversationId);
	const undecided = approvals.filter(
		(approval) => decisionOf(approval.approvalId) === undefined,
	);

	const row = (request: WaitingApproval, alone: boolean) => {
		const subject = approvalSubject(request);
		const page = webPageRequest(request);
		const decision = decisionOf(request.approvalId);
		// An app draft is accepted or rejected as a whole, as on its card.
		const draft = appEditRequestFrom(request.input) !== null;
		const no = draft ? "Reject" : "Deny";
		const yes = draft ? "Accept" : "Approve";
		const here = request.conversationId === conversationId;
		const text = (
			<>
				<Text as="span" role="body" className="workspace-chat-tray-title">
					{/* Inside a group its name already says which item. */}
					{alone ? approvalLine(request) : approvalTitle(request)}
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
				{request.requester ? (
					<Requester
						{...request.requester}
						actingTediId={request.actingTediId}
						tediNames={tediNames}
					/>
				) : null}
				{alone && !here ? (
					<Text as="span" role="caption" tone="secondary">
						Asked in another chat
					</Text>
				) : null}
			</>
		);
		return (
			<li className="workspace-chat-tray-row" key={request.approvalId}>
				{here ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<a
									className="workspace-chat-tray-item"
									href={`#approval-${request.approvalId}`}
								/>
							}
						>
							{text}
						</TooltipTrigger>
						<TooltipContent>
							Show the proposal in the conversation
						</TooltipContent>
					</Tooltip>
				) : onOpenConversation ? (
					<Button
						className="workspace-chat-tray-item"
						multiline
						onClick={() => onOpenConversation(request.conversationId)}
						title="Open the chat that asked"
						variant="ghost"
					>
						{text}
					</Button>
				) : (
					<span className="workspace-chat-tray-item">{text}</span>
				)}
				<Button
					aria-label={`${no} ${subject}`}
					disabled={busy || decision !== undefined}
					onClick={() => {
						mark([request.approvalId], "deny");
						onDecide(request.approvalId, "deny");
					}}
					size="sm"
					variant="outline"
				>
					{no}
				</Button>
				<Button
					aria-label={`${yes} ${subject}`}
					disabled={busy || decision !== undefined}
					onClick={() => {
						mark([request.approvalId], "approve");
						onDecide(request.approvalId, "approve");
					}}
					size="sm"
				>
					{decision === "approve" ? (draft ? "Accepting…" : "Approving…") : yes}
				</Button>
			</li>
		);
	};

	const group = (item: ApprovalGroup) => {
		const [only] = item.requests;
		if (item.requests.length === 1 && only) return row(only, true);
		const open = openGroup === item.key;
		const left = item.requests.filter(
			(request) => decisionOf(request.approvalId) === undefined,
		);
		return (
			<li className="workspace-chat-tray-group" key={item.key}>
				<div className="workspace-chat-tray-row">
					<Button
						aria-expanded={open}
						className="workspace-chat-tray-item"
						multiline
						// One group at a time, so an open one never crowds out the rest.
						onClick={() => setOpenGroup(open ? null : item.key)}
						variant="ghost"
					>
						<Text as="span" role="body" className="workspace-chat-tray-title">
							{item.title}
						</Text>
						<Text as="span" role="caption" tone="secondary">
							{item.requests.length} requests
							{item.askedElsewhere ? " · Asked in another chat" : ""}
						</Text>
					</Button>
					<Button
						aria-label={`Deny all for ${item.title}`}
						disabled={busy || left.length === 0}
						onClick={() => decideAll(item.requests, "deny")}
						size="sm"
						variant="outline"
					>
						Deny all
					</Button>
					<Button
						aria-label={`Approve all for ${item.title}`}
						disabled={busy || left.length === 0}
						onClick={() => decideAll(item.requests, "approve")}
						size="sm"
					>
						Approve all
					</Button>
				</div>
				{open ? (
					<ul className="workspace-chat-tray-requests">
						{item.requests.map((request) => row(request, false))}
					</ul>
				) : null}
			</li>
		);
	};

	return (
		<ChatCard
			aria-label={`Waiting for you: ${approvals.length}`}
			attention
			className="workspace-chat-tray"
			data-testid="workspace-chat-tray"
			title={`Waiting for you (${approvals.length})`}
			meta={
				run ? (
					<span role="status">{approvalRunProgress(run, approvals)}</span>
				) : elsewhere > 0 ? (
					elsewhere === approvals.length ? (
						"Asked in other chats"
					) : (
						`${elsewhere} from other chats`
					)
				) : null
			}
			actions={
				approvals.length > 1 ? (
					<>
						<Button
							disabled={busy || undecided.length === 0}
							onClick={() => decideAll(approvals, "deny")}
							size="sm"
							variant="outline"
						>
							Deny all
						</Button>
						<Button
							disabled={busy || undecided.length === 0}
							onClick={() => decideAll(approvals, "approve")}
							size="sm"
						>
							Approve all
						</Button>
					</>
				) : null
			}
		>
			{alert}
			<ul className="workspace-chat-tray-list">{groups.map(group)}</ul>
		</ChatCard>
	);
}
