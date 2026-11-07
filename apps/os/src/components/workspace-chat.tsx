import "./workspace-chat.css";
import {
	ArrowLeft,
	CaretRight,
	CheckCircle,
	Code,
	Eye,
	Lightbulb,
	PaperPlaneRight,
	PencilSimple,
	ShieldCheck,
	Stop,
	WarningCircle,
	Wrench,
} from "@phosphor-icons/react";
import {
	type FormEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import { isImeComposing } from "@/lib/keyboard";
import { useNow } from "@/lib/use-now";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import type { createWorkspaceChatClient } from "@/lib/workspace-chat-client";
import type { WorkspaceChatConnection } from "@/lib/workspace-chat-client";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";
import {
	activeTurn,
	type ChatApproval,
	type ChatStep,
	type ChatTurn,
	elapsedLabel,
	formatUsage,
	pendingApproval,
} from "@/lib/workspace-chat-state";

export type WorkspaceChatProps = {
	workspaceId: string;
	/** `null` = a fresh conversation; the first turn creates it in the object. */
	conversationId: string | null;
	/** The conversation list replaces the thread. */
	listOpen: boolean;
	onOpenList: () => void;
	onSelectConversation: (conversationId: string | null) => void;
	/** The object assigned an id to this pane's first turn. */
	onConversationCreated?: (conversationId: string) => void;
	/** Lets an adjacent control enqueue a message through this chat. */
	onSendMessageReady?: (send: (content: string) => void) => void;
	autoFocusComposer?: boolean;
	/** Test seam. */
	createClient?: typeof createWorkspaceChatClient;
};

export function WorkspaceChat({
	workspaceId,
	conversationId,
	listOpen,
	onOpenList,
	onSelectConversation,
	onConversationCreated,
	onSendMessageReady,
	autoFocusComposer = false,
	createClient,
}: WorkspaceChatProps) {
	const { snapshot, client } = useWorkspaceChat(
		workspaceId,
		conversationId,
		createClient,
	);
	const { state, connection, catchingUp } = snapshot;
	const running = activeTurn(state);
	const approval = pendingApproval(running);

	// The object names the conversation on the first accepted turn.
	const announced = useRef<string | null>(null);
	useEffect(() => {
		const assigned = client?.getConversationId() ?? null;
		if (
			conversationId === null &&
			assigned !== null &&
			announced.current !== assigned
		) {
			announced.current = assigned;
			onConversationCreated?.(assigned);
		}
	}, [client, conversationId, onConversationCreated, state.conversationId]);

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed || !client) return;
			client.sendTurn({ text: trimmed });
		},
		[client],
	);
	useEffect(() => {
		onSendMessageReady?.(send);
	}, [onSendMessageReady, send]);

	const title =
		state.conversations.find(
			(conversation) => conversation.id === conversationId,
		)?.title ?? null;

	if (listOpen) {
		return (
			<div className="workspace-chat" data-testid="workspace-chat">
				<ConversationList
					conversations={state.conversations}
					activeId={conversationId}
					onSelect={onSelectConversation}
				/>
				<Composer
					onSend={(text) => {
						onSelectConversation(null);
						send(text);
					}}
					disabledReason={null}
					autoFocus={autoFocusComposer}
					busy={false}
				/>
			</div>
		);
	}

	return (
		<div className="workspace-chat" data-testid="workspace-chat">
			<div className="workspace-chat-header">
				<Button
					aria-label="All conversations"
					onClick={onOpenList}
					size="icon-sm"
					variant="ghost"
				>
					<ArrowLeft aria-hidden />
				</Button>
				<Text as="strong" role="label" className="truncate">
					{title ?? (conversationId ? "Conversation" : "New conversation")}
				</Text>
				<ConnectionChip
					connection={connection}
					lastEventAt={state.lastEventAt}
				/>
			</div>
			<Thread
				turns={state.turns}
				pendingSend={state.pendingSend}
				catchingUp={
					catchingUp && state.turns.length === 0 && conversationId !== null
				}
				hasEarlier={state.hasEarlier}
				onLoadEarlier={() => client?.loadEarlier()}
				onDecide={(approvalId, decision) =>
					client?.decideApproval(approvalId, decision)
				}
				onCancel={(turnId) => client?.cancelTurn(turnId)}
				connection={connection}
			/>
			{state.lastError ? (
				<div className="workspace-chat-error" role="alert">
					<WarningCircle aria-hidden />
					<Text role="caption" tone="error">
						{state.lastError.message}
					</Text>
				</div>
			) : null}
			<Composer
				onSend={send}
				disabledReason={
					approval ? "Approve or deny the request above to continue." : null
				}
				autoFocus={autoFocusComposer}
				busy={running !== null || state.pendingSend !== null}
			/>
		</div>
	);
}

function ConversationList({
	conversations,
	activeId,
	onSelect,
}: {
	conversations: ConversationSummary[];
	activeId: string | null;
	onSelect: (conversationId: string | null) => void;
}) {
	return (
		<div className="workspace-chat-list">
			<Button onClick={() => onSelect(null)} size="sm" variant="secondary">
				New conversation
			</Button>
			{conversations.length === 0 ? (
				<Text role="body" tone="secondary">
					No conversations in this workspace yet.
				</Text>
			) : (
				<ul>
					{conversations.map((conversation) => (
						<li key={conversation.id}>
							<button
								aria-current={conversation.id === activeId ? "true" : undefined}
								className="workspace-chat-list-row"
								onClick={() => onSelect(conversation.id)}
								type="button"
							>
								<Text as="span" role="body" className="truncate">
									{conversation.title ?? "Untitled conversation"}
								</Text>
								<Text as="span" role="caption" tone="secondary">
									{relativeTime(conversation.updatedAt)}
								</Text>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * An inline chip, never a banner: the layout must not jump when the socket
 * blinks. "Reconnecting" is a state we pass through, not a dead end.
 */
function ConnectionChip({
	connection,
	lastEventAt,
}: {
	connection: WorkspaceChatConnection;
	lastEventAt: number | null;
}) {
	const now = useNow(connection.phase !== "open");
	if (connection.phase === "open") return null;
	const label =
		connection.phase === "closed"
			? "Closed"
			: connection.phase === "connecting"
				? "Connecting"
				: `Reconnecting${connection.attempt > 1 ? ` (${connection.attempt})` : ""}`;
	const since =
		lastEventAt !== null && connection.phase === "reconnecting"
			? ` · last update ${elapsedLabel(now - lastEventAt)} ago`
			: "";
	return (
		<span
			className="workspace-chat-connection"
			data-phase={connection.phase}
			data-testid="workspace-chat-connection"
			role="status"
		>
			<span className="workspace-chat-connection-dot" aria-hidden />
			{label}
			{since}
		</span>
	);
}

function Thread({
	turns,
	pendingSend,
	catchingUp,
	hasEarlier,
	onLoadEarlier,
	onDecide,
	onCancel,
	connection,
}: {
	turns: ChatTurn[];
	pendingSend: { clientTurnId: string; text: string; sentAt: number } | null;
	catchingUp: boolean;
	hasEarlier: boolean;
	onLoadEarlier: () => void;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	onCancel: (turnId: string) => void;
	connection: WorkspaceChatConnection;
}) {
	const scroller = useRef<HTMLDivElement | null>(null);
	const stick = useRef(true);
	useEffect(() => {
		const node = scroller.current;
		if (!node || !stick.current) return;
		node.scrollTop = node.scrollHeight;
	});
	return (
		<div
			className="workspace-chat-thread"
			onScroll={(event) => {
				const node = event.currentTarget;
				stick.current =
					node.scrollHeight - node.scrollTop - node.clientHeight < 48;
			}}
			ref={scroller}
		>
			{hasEarlier ? (
				<Button onClick={onLoadEarlier} size="xs" variant="ghost">
					Load earlier
				</Button>
			) : null}
			{catchingUp ? (
				<Text role="caption" tone="secondary">
					Loading the conversation…
				</Text>
			) : null}
			{turns.length === 0 && !pendingSend && !catchingUp ? (
				<div className="workspace-chat-empty">
					<Text role="body" tone="secondary">
						Ask about this workspace. The answer streams straight from it.
					</Text>
				</div>
			) : null}
			{turns.map((turn) => (
				<TurnView
					connection={connection}
					key={turn.turnId}
					onCancel={onCancel}
					onDecide={onDecide}
					turn={turn}
				/>
			))}
			{pendingSend ? (
				<div className="workspace-chat-turn" data-pending="true">
					<UserBubble text={pendingSend.text} />
					<Thinking label="Sending" since={pendingSend.sentAt} />
				</div>
			) : null}
		</div>
	);
}

function TurnView({
	turn,
	onDecide,
	onCancel,
	connection,
}: {
	turn: ChatTurn;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	onCancel: (turnId: string) => void;
	connection: WorkspaceChatConnection;
}) {
	const running = turn.status === "running";
	const startedAt = Date.parse(turn.startedAt);
	const now = useNow(running);
	const waiting = turn.approvals.find((approval) => approval.decision === null);
	const quiet = running && turn.reply === "" && turn.steps.length === 0;
	return (
		<article
			className="workspace-chat-turn"
			data-status={turn.status}
			data-testid="workspace-chat-turn"
		>
			{turn.text ? <UserBubble text={turn.text} /> : null}
			<div className="workspace-chat-reply" key={turn.replyKey}>
				{turn.steps.length > 0 ? <Activity steps={turn.steps} /> : null}
				{turn.approvals.map((approval) => (
					<ApprovalCard
						approval={approval}
						key={approval.approvalId}
						onDecide={onDecide}
					/>
				))}
				{quiet ? <Thinking label="Thinking" since={startedAt} /> : null}
				{turn.reply ? (
					<div
						className="workspace-chat-prose"
						data-streaming={!turn.replyDone}
					>
						<ChatMarkdown content={turn.reply} />
					</div>
				) : null}
				{turn.status === "error" ? (
					<div className="workspace-chat-error" role="alert">
						<WarningCircle aria-hidden />
						<Text role="caption" tone="error">
							{turn.error ?? "The workspace could not finish this turn."}
						</Text>
					</div>
				) : null}
				{turn.status === "cancelled" ? (
					<Text role="caption" tone="secondary">
						Stopped.
					</Text>
				) : null}
				<footer className="workspace-chat-turn-footer">
					{running ? (
						<>
							<Text
								role="caption"
								tone="secondary"
								data-testid="workspace-chat-timer"
							>
								{waiting
									? "Waiting for your decision"
									: connection.phase === "open"
										? "Working"
										: "Working · reconnecting"}{" "}
								· {elapsedLabel(now - startedAt)}
							</Text>
							<Button
								aria-label="Stop this turn"
								onClick={() => onCancel(turn.turnId)}
								size="icon-xs"
								variant="ghost"
							>
								<Stop aria-hidden />
							</Button>
						</>
					) : (
						<Text role="caption" tone="secondary">
							{[
								turn.durationMs !== undefined
									? elapsedLabel(turn.durationMs)
									: null,
								turn.usage ? formatUsage(turn.usage) : null,
								turn.model ?? null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
					)}
				</footer>
			</div>
		</article>
	);
}

function UserBubble({ text }: { text: string }) {
	return (
		<div className="workspace-chat-user">
			<div className="max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg bg-kumo-fill px-4 py-2.5">
				<ChatMarkdown content={text} preserveLineBreaks />
			</div>
		</div>
	);
}

function Thinking({ label, since }: { label: string; since: number }) {
	const now = useNow(true);
	return (
		<div
			className="workspace-chat-thinking"
			data-testid="workspace-chat-thinking"
		>
			<span className="workspace-chat-shimmer">{label}…</span>
			<Text as="span" role="caption" tone="secondary">
				{elapsedLabel(now - since)}
			</Text>
		</div>
	);
}

const STEP_ICON = {
	read: Eye,
	write: PencilSimple,
	code: Code,
	tool: Wrench,
	think: Lightbulb,
} as const;

/** The steps of one turn with plain labels; the group folds once it is done. */
function Activity({ steps }: { steps: ChatStep[] }) {
	const live = steps.some((step) => step.status === "running");
	const [open, setOpen] = useState(false);
	const expanded = open || live;
	const failed = steps.some((step) => step.status === "error");
	const summary = live
		? (steps.findLast((step) => step.status === "running")?.label ?? "Working")
		: steps.length === 1
			? steps[0]!.label
			: `${steps.length} steps`;
	return (
		<div className="workspace-chat-activity" data-live={live}>
			<button
				aria-expanded={expanded}
				className="workspace-chat-activity-summary"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<CaretRight
					aria-hidden
					className="workspace-chat-caret"
					data-open={expanded}
				/>
				<span className="truncate">{summary}</span>
				{failed ? (
					<Text as="span" role="caption" tone="error">
						Error
					</Text>
				) : null}
			</button>
			{expanded ? (
				<ol className="workspace-chat-steps">
					{steps.map((step) => {
						const Icon = STEP_ICON[step.kind] ?? Wrench;
						return (
							<li
								className="workspace-chat-step"
								data-status={step.status}
								data-testid="workspace-chat-step"
								key={step.stepId}
							>
								<Icon aria-hidden />
								<span className="truncate">{step.label}</span>
								{step.status === "ok" && step.summary ? (
									<Text as="span" role="caption" tone="secondary">
										{step.summary}
									</Text>
								) : null}
								{step.status === "error" ? (
									<Text as="span" role="caption" tone="error">
										{step.error ?? "failed"}
									</Text>
								) : null}
								{step.status === "running" ? (
									<span
										className="workspace-chat-step-pulse"
										aria-label="running"
									/>
								) : step.status === "ok" ? (
									<CheckCircle aria-hidden className="workspace-chat-step-ok" />
								) : null}
							</li>
						);
					})}
				</ol>
			) : null}
		</div>
	);
}

/** An approval the object is waiting on, decided here and posted back. */
function ApprovalCard({
	approval,
	onDecide,
}: {
	approval: ChatApproval;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
}) {
	const [sent, setSent] = useState<"approve" | "deny" | null>(null);
	const decided = approval.decision ?? sent;
	return (
		<div
			className="workspace-chat-approval"
			data-decision={approval.decision ?? (sent ? "pending" : "open")}
			data-testid="workspace-chat-approval"
		>
			<div className="workspace-chat-approval-head">
				<ShieldCheck aria-hidden />
				<Text as="strong" role="label">
					{approval.title}
				</Text>
			</div>
			<Text role="body" tone="secondary">
				{approval.reason}
			</Text>
			{approval.policy ? (
				<Text role="caption" tone="mono-secondary">
					{approval.policy}
				</Text>
			) : null}
			{approval.decision ? (
				<Text
					role="caption"
					tone={approval.decision === "approve" ? "success" : "secondary"}
				>
					{approval.decision === "approve" ? "Approved" : "Denied"}
					{approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
				</Text>
			) : (
				<div className="workspace-chat-approval-actions">
					<Button
						disabled={decided !== null}
						onClick={() => {
							setSent("deny");
							onDecide(approval.approvalId, "deny");
						}}
						size="sm"
						variant="outline"
					>
						Deny
					</Button>
					<Button
						disabled={decided !== null}
						onClick={() => {
							setSent("approve");
							onDecide(approval.approvalId, "approve");
						}}
						size="sm"
					>
						{sent === "approve" ? "Approving…" : "Approve"}
					</Button>
				</div>
			)}
		</div>
	);
}

function Composer({
	onSend,
	disabledReason,
	autoFocus,
	busy,
}: {
	onSend: (text: string) => void;
	disabledReason: string | null;
	autoFocus: boolean;
	busy: boolean;
}) {
	const [draft, setDraft] = useState("");
	const textarea = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		if (autoFocus) textarea.current?.focus();
	}, [autoFocus]);
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (disabledReason || !draft.trim()) return;
		onSend(draft);
		setDraft("");
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="workspace-chat-composer" onSubmit={submit}>
			<Textarea
				aria-label="Message the workspace"
				disabled={disabledReason !== null}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={
					disabledReason ??
					(busy ? "Add to this turn while it runs…" : "Ask this workspace…")
				}
				ref={textarea}
				rows={2}
				value={draft}
			/>
			<div className="workspace-chat-composer-row">
				<Text role="caption" tone="secondary">
					Enter to send · Shift+Enter for a new line
				</Text>
				<Button
					aria-label="Send"
					disabled={disabledReason !== null || !draft.trim()}
					size="icon-sm"
					type="submit"
				>
					<PaperPlaneRight aria-hidden />
				</Button>
			</div>
		</form>
	);
}

function relativeTime(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 60_000) return "just now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} d ago`;
}
