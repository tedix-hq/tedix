import "./workspace-chat.css";
import {
	ArrowLeft,
	CaretRight,
	CheckCircle,
	Code,
	Eye,
	Lightbulb,
	FileText,
	PaperPlaneRight,
	PencilSimple,
	ShieldCheck,
	Stop,
	WarningCircle,
	Wrench,
	X,
} from "@phosphor-icons/react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { Link } from "@/components/kumo/link";
import { UnreadBadge } from "@/components/unread-badge";
import { WidgetFrame } from "@/components/widget-frame";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { mentionedPeople, notifyChatPosted } from "@/lib/workspace-chat-notify";
import { WorkspaceChatResources } from "@/components/workspace-chat-resources";
import { isImeComposing } from "@/lib/keyboard";
import { plainModelLabel } from "@/lib/plain-model-label";
import { osQueryKeys } from "@/lib/os-query-options";
import { useNow } from "@/lib/use-now";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import type { createWorkspaceChatClient } from "@/lib/workspace-chat-client";
import type {
	WorkspaceChatClient,
	WorkspaceChatConnection,
} from "@/lib/workspace-chat-client";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";
import {
	activeTurn,
	type ChatApproval,
	type ChatStep,
	type ChatTurn,
	type WorkspaceChatState,
	elapsedLabel,
	pendingApproval,
	turnDetails,
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
	onBrowseResources?: () => void;
	autoFocusComposer?: boolean;
	/** Unread chat rows per conversation id, for the badges in the list. */
	unreadByConversation?: ReadonlyMap<string, number>;
	/** Something happened in the open conversation: a turn started, finished or asked for a decision. */
	onActivity?: () => void;
	/** Test seam. */
	createClient?: typeof createWorkspaceChatClient;
};

function chosenModelKey(workspaceId: string) {
	return `tedix.workspace-chat.model.${workspaceId}`;
}

/** The model this browser last chose in the workspace; unknown ids fall back to the first. */
function readChosenModel(workspaceId: string): string | null {
	try {
		return window.localStorage.getItem(chosenModelKey(workspaceId));
	} catch {
		return null;
	}
}

export function WorkspaceChat({
	workspaceId,
	conversationId,
	listOpen,
	onOpenList,
	onSelectConversation,
	onConversationCreated,
	onSendMessageReady,
	onBrowseResources,
	autoFocusComposer = false,
	unreadByConversation,
	onActivity,
	createClient,
}: WorkspaceChatProps) {
	const queryClient = useQueryClient();
	const onOutputChanged = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
	}, [queryClient]);
	const { snapshot, client } = useWorkspaceChat(
		workspaceId,
		conversationId,
		createClient,
		onOutputChanged,
	);
	const { state, connection, catchingUp } = snapshot;
	const [selectedModelId, setSelectedModelId] = useState<string | null>(() =>
		readChosenModel(workspaceId),
	);
	useEffect(() => {
		setSelectedModelId(readChosenModel(workspaceId));
	}, [workspaceId]);
	const selectModel = useCallback(
		(value: string) => {
			setSelectedModelId(value);
			try {
				window.localStorage.setItem(chosenModelKey(workspaceId), value);
			} catch {
				// Storage can be unavailable; the choice still applies to this page.
			}
		},
		[workspaceId],
	);
	const selectedModel =
		state.models.find((model) => model.id === selectedModelId) ??
		state.models[0];
	const modelId = selectedModel?.id;
	const modelControl = state.models.length ? (
		<Select
			value={modelId}
			onValueChange={(value) => {
				if (value) selectModel(value);
			}}
			disabled={connection.phase !== "open"}
		>
			<SelectTrigger
				aria-label="Model"
				className="workspace-chat-model-trigger"
				size="sm"
				title={selectedModel?.label}
			>
				<SelectValue>
					{selectedModel ? plainModelLabel(selectedModel.label) : null}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{state.models.map((model) => (
					<SelectItem key={model.id} value={model.id} title={model.label}>
						{plainModelLabel(model.label)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	) : null;
	const running = activeTurn(state);
	const approval = pendingApproval(running);

	// Tell the page when the conversation moves, so unread state is re-read
	// once per turn rather than on every streamed word.
	const activity = `${state.conversationId ?? ""}:${state.turns.length}:${running ? "running" : "idle"}:${approval ? "asking" : ""}`;
	const lastActivity = useRef<string | null>(null);
	// Set when this tab posts; once the post has a conversation, the server is
	// asked to notify the people it mentions or who took part.
	const directory = useContext(WorkActorDirectoryContext);
	const postedMentions = useRef<string[] | null>(null);
	const notePost = useCallback(
		(text: string) => {
			const people: Array<[string, string]> = [];
			for (const [key, profile] of directory)
				if (key.startsWith("user:") && profile.name)
					people.push([key.slice("user:".length), profile.name]);
			postedMentions.current = mentionedPeople(text, people);
		},
		[directory],
	);
	const activeConversation = state.conversationId;
	useEffect(() => {
		if (!activeConversation || postedMentions.current === null) return;
		notifyChatPosted({
			workspaceId,
			conversationId: activeConversation,
			mentionedUserIds: postedMentions.current,
		});
		postedMentions.current = null;
	}, [activity, activeConversation, workspaceId]);
	useEffect(() => {
		if (catchingUp) return;
		const previous = lastActivity.current;
		lastActivity.current = activity;
		if (previous !== null && previous !== activity) onActivity?.();
	}, [activity, catchingUp, onActivity]);
	const unreadElsewhere = [...(unreadByConversation ?? [])].reduce(
		(sum, [id, count]) => (id === conversationId ? sum : sum + count),
		0,
	);

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
		(text: string, attachments?: Array<{ outputId: string }>) => {
			const trimmed = text.trim();
			if (!trimmed || !client) return;
			notePost(trimmed);
			return client.sendTurn({
				text: trimmed,
				...(modelId ? { modelId } : {}),
				...(attachments?.length ? { attachments } : {}),
			});
		},
		[client, modelId, notePost],
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
					unread={unreadByConversation}
				/>
				<Composer
					key="composer"
					client={client}
					state={state}
					modelControl={modelControl}
					workspaceId={workspaceId}
					onBrowseResources={onBrowseResources}
					onSend={(text, attachments) => {
						onSelectConversation(null);
						notePost(text);
						return client?.sendTurn({
							text,
							newConversation: true,
							...(modelId ? { modelId } : {}),
							...(attachments?.length ? { attachments } : {}),
						});
					}}
					disabledReason={null}
					autoFocus={autoFocusComposer}
					busy={false}
					onStop={null}
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
				<UnreadBadge
					count={unreadElsewhere}
					label="unread in other conversations"
				/>
				<Text as="strong" role="label" className="truncate">
					{title ?? (conversationId ? "Conversation" : "New conversation")}
				</Text>
				<ConnectionChip client={client} connection={connection} />
			</div>
			<Thread
				conversationId={conversationId}
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
				onContinue={
					running || state.pendingSend || approval
						? null
						: () => void send(CONTINUE_TEXT)
				}
			/>
			{connection.phase === "unavailable" ? (
				<div
					className="workspace-chat-unavailable"
					data-testid="workspace-chat-unavailable"
					role="status"
				>
					<Text role="body">
						Workspace chat is being upgraded. Home chat still works.
					</Text>
					<Button onClick={() => client?.retry()} size="sm" variant="outline">
						Retry
					</Button>
				</div>
			) : state.lastError ? (
				<div className="workspace-chat-error" role="alert">
					<WarningCircle aria-hidden />
					<Text role="caption" tone="error">
						{state.lastError.message}
					</Text>
				</div>
			) : null}
			<Composer
				key="composer"
				client={client}
				state={state}
				modelControl={modelControl}
				workspaceId={workspaceId}
				onBrowseResources={onBrowseResources}
				onSend={send}
				disabledReason={
					connection.phase === "unavailable"
						? "Workspace chat is being upgraded. Use Home chat for now."
						: approval
							? "Approve or deny the request above to continue."
							: null
				}
				autoFocus={autoFocusComposer}
				busy={running !== null || state.pendingSend !== null}
				onStop={
					running && client ? () => client.cancelTurn(running.turnId) : null
				}
			/>
		</div>
	);
}

function ConversationList({
	conversations,
	activeId,
	onSelect,
	unread,
}: {
	conversations: ConversationSummary[];
	activeId: string | null;
	onSelect: (conversationId: string | null) => void;
	unread?: ReadonlyMap<string, number>;
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
								<UnreadBadge
									count={unread?.get(conversation.id) ?? 0}
									label="unread"
								/>
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

/** How long a dropped connection stays silent, so a blip shows nothing. */
export const RECONNECTING_NOTICE_DELAY_MS = 1_500;

/**
 * The one sign of the connection, and only after it was lost: nothing while
 * the chat first connects or moves to another conversation. An inline chip,
 * never a banner, so the layout does not jump.
 */
function ConnectionChip({
	client,
	connection,
}: {
	client: WorkspaceChatClient | null;
	connection: WorkspaceChatConnection;
}) {
	const opened = useRef<WorkspaceChatClient | null>(null);
	if (connection.phase === "open") opened.current = client;
	const dropped =
		client !== null &&
		opened.current === client &&
		(connection.phase === "reconnecting" || connection.phase === "connecting");
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!dropped) {
			setShown(false);
			return;
		}
		const timer = setTimeout(
			() => setShown(true),
			RECONNECTING_NOTICE_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [dropped]);
	if (!dropped || !shown) return null;
	return (
		<span
			className="workspace-chat-connection"
			data-testid="workspace-chat-connection"
			role="status"
		>
			<span className="workspace-chat-connection-dot" aria-hidden />
			Reconnecting…
		</span>
	);
}

function Thread({
	conversationId,
	turns,
	pendingSend,
	catchingUp,
	hasEarlier,
	onLoadEarlier,
	onDecide,
	onContinue,
}: {
	conversationId: string | null;
	turns: ChatTurn[];
	pendingSend: { clientTurnId: string; text: string; sentAt: number } | null;
	catchingUp: boolean;
	hasEarlier: boolean;
	onLoadEarlier: () => void;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	/** Resumes after the last turn; `null` while another turn is busy. */
	onContinue: (() => void) | null;
}) {
	const scroller = useRef<HTMLDivElement | null>(null);
	const stick = useRef(true);
	const shownConversation = useRef(conversationId);
	// Before paint, so a thread never shows its top and then jumps down.
	useLayoutEffect(() => {
		if (shownConversation.current !== conversationId) {
			shownConversation.current = conversationId;
			stick.current = true;
		}
		const node = scroller.current;
		if (!node || !stick.current) return;
		if (typeof node.scrollTo === "function")
			node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
		else node.scrollTop = node.scrollHeight;
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
			{turns.map((turn, index) => (
				<TurnView
					key={turn.turnId}
					onDecide={onDecide}
					onContinue={
						index === turns.length - 1 &&
						(turn.status === "cancelled" || turn.status === "error")
							? onContinue
							: null
					}
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

/** What Continue sends after a stopped or interrupted turn. */
const CONTINUE_TEXT =
	"Continue where you stopped. Check what already happened before repeating any change.";

function TurnView({
	turn,
	onDecide,
	onContinue,
}: {
	turn: ChatTurn;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	onContinue: (() => void) | null;
}) {
	const modelLabel = turn.model?.startsWith("azure-openai/")
		? `Azure deployment: ${turn.model.slice("azure-openai/".length)}`
		: turn.model;
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
			{turn.attachments?.length ? (
				<ul aria-label="Message files" className="m-0 grid list-none gap-1 p-0">
					{turn.attachments.map((file) => (
						<li key={file.outputId}>
							<Link href={`/outputs/${encodeURIComponent(file.outputId)}`}>
								{file.title}
							</Link>{" "}
							<Text as="span" role="caption">
								· Revision {file.revision}
							</Text>
						</li>
					))}
				</ul>
			) : null}
			<div className="workspace-chat-reply" key={turn.replyKey}>
				{turn.steps.length > 0 ? (
					<Activity steps={turn.steps} approvals={turn.approvals} />
				) : null}
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
				{turn.views?.map((view) => (
					<div
						className="workspace-chat-view"
						data-testid="workspace-chat-view"
						key={view.viewId}
					>
						<WidgetFrame
							appSlug={view.appSlug}
							resourceUri={view.resourceUri}
							title={view.title}
							toolResult={view.toolResult}
						/>
					</div>
				))}
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
				{onContinue ? (
					<div>
						<Button onClick={onContinue} size="xs" variant="outline">
							Continue
						</Button>
					</div>
				) : null}
				{running ? (
					<footer className="workspace-chat-turn-footer">
						<Text
							role="caption"
							tone="secondary"
							data-testid="workspace-chat-timer"
						>
							{waiting ? "Waiting for your decision" : "Working"} ·{" "}
							{elapsedLabel(now - startedAt)}
						</Text>
					</footer>
				) : (
					<TurnTime
						details={turnDetails(turn, modelLabel)}
						startedAt={startedAt}
					/>
				)}
			</div>
		</article>
	);
}

/**
 * When a finished turn began. It appears while the turn is hovered or holds
 * focus, and its tooltip carries what was recorded about the turn.
 */
function TurnTime({
	startedAt,
	details,
}: {
	startedAt: number;
	details: string[];
}) {
	if (!Number.isFinite(startedAt)) return null;
	const time = new Date(startedAt).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
	const label = (
		<button
			className="workspace-chat-turn-time"
			data-testid="workspace-chat-turn-time"
			type="button"
		>
			{time}
		</button>
	);
	if (details.length === 0) return label;
	return (
		<Tooltip>
			<TooltipTrigger render={label} />
			<TooltipContent align="start" side="bottom">
				{details.map((detail) => (
					<span key={detail}>{detail}</span>
				))}
			</TooltipContent>
		</Tooltip>
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

function approvalStatus(approval: ChatApproval) {
	if (approval.execution?.status === "applied") return "Applied";
	if (approval.execution?.status === "failed") return "Failed";
	if (approval.decision === "deny") return "Denied";
	if (approval.decision === "approve") return "Approved";
	return "Waiting for approval";
}

/** The steps of one turn with plain labels; the group folds once it is done. */
function Activity({
	steps,
	approvals,
}: {
	steps: ChatStep[];
	approvals: ChatApproval[];
}) {
	const refused = (step: ChatStep) =>
		step.error?.startsWith("Approval required") ||
		step.error?.includes("approval_pending");
	const held = (step: ChatStep) =>
		approvals.find((approval) => approval.stepId === step.stepId) ??
		(refused(step) ? approvals.at(-1) : undefined);
	const live = steps.some((step) => step.status === "running");
	const [open, setOpen] = useState(false);
	const expanded = open || live;
	const failed = steps.some(
		(step) =>
			held(step)?.execution?.status === "failed" ||
			(!held(step) && !refused(step) && step.status === "error"),
	);
	const approval = approvals.at(-1);
	const summary = live
		? (steps.findLast((step) => step.status === "running")?.label ?? "Working")
		: steps.length === 1
			? steps[0]!.label
			: `${steps.length} steps`;
	return (
		<div className="workspace-chat-activity" data-live={live}>
			<Button
				aria-expanded={expanded}
				className="workspace-chat-activity-summary"
				onClick={() => setOpen((value) => !value)}
				variant="ghost"
				size="xs"
			>
				<CaretRight
					aria-hidden
					className="workspace-chat-caret"
					data-open={expanded}
				/>
				<span className="truncate">{summary}</span>
				{failed ? (
					<Text as="span" role="caption" tone="error">
						Failed
					</Text>
				) : approval ? (
					<Text as="span" role="caption" tone="secondary">
						{approvalStatus(approval)}
					</Text>
				) : null}
			</Button>
			{expanded ? (
				<ol className="workspace-chat-steps">
					{steps.map((step) => {
						const Icon = STEP_ICON[step.kind] ?? Wrench;
						const approval = held(step);
						const approvalLabel = approval
							? approvalStatus(approval)
							: refused(step)
								? "Waiting for approval"
								: null;
						return (
							<li
								className="workspace-chat-step"
								data-status={approvalLabel ?? step.status}
								data-testid="workspace-chat-step"
								key={step.stepId}
							>
								<Icon aria-hidden />
								<span className="truncate">{step.label}</span>
								{approvalLabel ? (
									<Text
										as="span"
										role="caption"
										tone={
											approval?.execution?.status === "failed"
												? "error"
												: "secondary"
										}
									>
										{approvalLabel}
									</Text>
								) : null}
								{!approvalLabel && step.status === "ok" && step.summary ? (
									<Text as="span" role="caption" tone="secondary">
										{step.summary}
									</Text>
								) : null}
								{!approvalLabel && step.status === "error" ? (
									<Text as="span" role="caption" tone="error">
										{step.error ?? "failed"}
									</Text>
								) : null}
								{!approvalLabel && step.status === "running" ? (
									<span
										className="workspace-chat-step-pulse"
										aria-label="running"
									/>
								) : approval?.execution?.status === "applied" ||
								  (!approval && step.status === "ok") ? (
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

function objectValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function blockPreview(value: unknown): string {
	const block = objectValue(value);
	if (!block) return "";
	if (typeof block.text === "string") return block.text;
	if (Array.isArray(block.items))
		return block.items
			.map((item) =>
				typeof item === "string" ? item : objectValue(item)?.text,
			)
			.filter((item) => typeof item === "string")
			.join("\n");
	if (Array.isArray(block.rows))
		return [block.headers, ...block.rows]
			.filter(Array.isArray)
			.map((row) => row.join(" · "))
			.join("\n");
	return "";
}

function approvalPreview(input: Record<string, unknown> | null): string {
	if (!input) return "";
	if (Array.isArray(input.cells))
		return `Edit cells at row ${Number(input.startRow ?? 0) + 1}, column ${Number(input.startColumn ?? 0) + 1}:\n${input.cells
			.slice(0, 6)
			.filter(Array.isArray)
			.map((row) => row.join(" · "))
			.join("\n")}`.slice(0, 2_000);
	if (Array.isArray(input.ops))
		return input.ops
			.slice(0, 6)
			.map((value) => {
				const operation = objectValue(value);
				if (!operation) return "";
				if (operation.op === "move")
					return `Move slide ${Number(operation.from) + 1} to position ${Number(operation.to) + 1}`;
				const position =
					typeof operation.index === "number"
						? ` at position ${operation.index + 1}`
						: "";
				const unit =
					operation.slide || input.kind === "presentation" ? "slide" : "block";
				const action =
					operation.op === "delete"
						? `Delete a ${unit}${position}`
						: operation.op === "insert"
							? `Insert a ${unit}${position}`
							: `Replace a ${unit}${position}`;
				const slide = objectValue(operation.slide);
				const text = slide
					? [
							slide.title,
							...(Array.isArray(slide.bullets) ? slide.bullets : []),
							slide.notes,
						]
							.filter((value) => typeof value === "string")
							.join("\n")
					: blockPreview(operation.block);
				return text ? `${action}: ${text}` : action;
			})
			.join("\n")
			.slice(0, 2_000);
	const content = objectValue(input.content);
	if (Array.isArray(content?.blocks))
		return content.blocks
			.map(blockPreview)
			.filter(Boolean)
			.join("\n\n")
			.slice(0, 2_000);
	if (Array.isArray(content?.rows))
		return content.rows
			.slice(0, 6)
			.filter(Array.isArray)
			.map((row) => row.join(" · "))
			.join("\n")
			.slice(0, 2_000);
	if (Array.isArray(content?.slides))
		return content.slides
			.slice(0, 6)
			.map((slide) => {
				const value = objectValue(slide);
				return typeof value?.title === "string" ? value.title : "";
			})
			.filter(Boolean)
			.join("\n")
			.slice(0, 2_000);
	if (typeof input.description === "string")
		return input.description.slice(0, 2_000);
	return "";
}

/** The decision and the action's recorded result remain separate. */
function ApprovalCard({
	approval,
	onDecide,
}: {
	approval: ChatApproval;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
}) {
	const [sent, setSent] = useState<"approve" | "deny" | null>(null);
	const decided = approval.decision ?? sent;
	const input = objectValue(approval.input);
	const target =
		approval.target?.title ??
		(typeof input?.title === "string" ? input.title : null);
	const preview = approvalPreview(input);
	const status = approvalStatus(approval);
	const failed = approval.execution?.status === "failed";
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
			{target ? (
				<Text
					as="strong"
					role="body"
					className="workspace-chat-approval-target"
				>
					{target}
				</Text>
			) : null}
			<Text role="body" tone="secondary">
				{failed
					? "The workspace could not apply this action. See Technical details for the recorded error."
					: approval.execution?.status === "applied"
						? "The workspace applied this change."
						: approval.decision === "deny"
							? "The action was denied."
							: approval.decision === "approve"
								? "Your approval was recorded. The action's result has not been recorded."
								: "Review the proposed change, then approve or deny it."}
			</Text>
			{preview ? (
				<div className="workspace-chat-approval-preview">
					<Text role="caption" tone="secondary">
						Preview · full request in Technical details
					</Text>
					<pre>{preview}</pre>
				</div>
			) : null}
			<Text
				role="caption"
				tone={
					failed
						? "error"
						: approval.execution?.status === "applied"
							? "success"
							: "secondary"
				}
				data-testid="workspace-chat-approval-status"
			>
				{!approval.decision && !approval.execution && sent
					? "Recording your decision…"
					: status}
			</Text>
			<Collapsible className="workspace-chat-approval-details">
				<CollapsibleDefaultTrigger>Technical details</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<Text role="caption" tone="secondary">
						Reason: {approval.reason}
					</Text>
					{approval.policy ? (
						<Text role="caption" tone="mono-secondary">
							Policy: {approval.policy}
						</Text>
					) : null}
					{approval.decidedBy ? (
						<Text role="caption" tone="mono-secondary">
							Decision by: {approval.decidedBy}
						</Text>
					) : null}
					{approval.execution?.error ? (
						<Text role="caption" tone="error">
							Error: {approval.execution.error}
						</Text>
					) : null}
					{approval.input !== undefined ? (
						<pre>{JSON.stringify(approval.input, null, 2)}</pre>
					) : null}
				</CollapsibleDefaultContent>
			</Collapsible>
			{!approval.decision && !approval.execution ? (
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
			) : null}
		</div>
	);
}

function Composer({
	client,
	state,
	workspaceId,
	onBrowseResources,
	onSend,
	disabledReason,
	autoFocus,
	busy,
	onStop,
	modelControl,
}: {
	workspaceId: string;
	onBrowseResources?: () => void;
	onSend: (
		text: string,
		attachments?: Array<{ outputId: string }>,
	) => string | undefined;
	state: WorkspaceChatState;
	client: WorkspaceChatClient | null;
	disabledReason: string | null;
	autoFocus: boolean;
	busy: boolean;
	/** Stops the running turn; `null` when nothing is running. */
	onStop: (() => void) | null;
	modelControl: ReactNode;
}) {
	const [submitted, setSubmitted] = useState<{
		id: string;
		text: string;
		files: string[];
		draftKey: string;
	} | null>(null);
	// An unsent message survives a reload and a switch to another conversation.
	const draftKey = `tedix.workspace-chat.draft.${workspaceId}.${client?.getConversationId() ?? "new"}`;
	const [draft, setDraftText] = useState(() => readDraft(draftKey));
	const setDraft = (next: string | ((text: string) => string)) =>
		setDraftText((text) => {
			const value = typeof next === "function" ? next(text) : next;
			writeDraft(draftKey, value);
			return value;
		});
	const [selected, setSelected] = useState<
		Array<{ outputId: string; title: string }>
	>([]);
	const previousDraftKey = useRef(draftKey);
	useEffect(() => {
		const previous = previousDraftKey.current;
		previousDraftKey.current = draftKey;
		if (previous === draftKey) return;
		// A new conversation gets its id with the first message. That is the
		// same conversation, so what is typed and attached stays.
		if (previous === `tedix.workspace-chat.draft.${workspaceId}.new`) {
			setDraftText((text) => {
				writeDraft(draftKey, text);
				return text;
			});
			return;
		}
		setSelected([]);
		setDraftText(readDraft(draftKey));
		setSubmitted(null);
	}, [draftKey, workspaceId]);
	useEffect(() => setSubmitted(null), [client]);
	useEffect(() => {
		if (!submitted) return;
		if (state.turns.some((turn) => turn.turnId === submitted.id)) {
			// The first message names the conversation, which moves the draft key.
			writeDraft(submitted.draftKey, "");
			setDraft((text) => (text === submitted.text ? "" : text));
			setSelected((files) =>
				files.filter((file) => !submitted.files.includes(file.outputId)),
			);
			setSubmitted(null);
		} else if (state.lastError?.clientTurnId === submitted.id) {
			setSubmitted(null);
		}
	}, [state.turns, state.lastError, submitted]);
	const textarea = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		if (autoFocus) textarea.current?.focus();
	}, [autoFocus]);
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (disabledReason || submitted || !draft.trim()) return;
		const id = onSend(
			draft,
			selected.map(({ outputId }) => ({ outputId })),
		);
		if (id)
			setSubmitted({
				id,
				text: draft,
				files: selected.map((file) => file.outputId),
				draftKey,
			});
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="workspace-chat-composer" onSubmit={submit}>
			<div className="workspace-chat-composer-card">
				{selected.length ? (
					<ul
						aria-label="Files added to this message"
						className="workspace-chat-composer-files"
					>
						{selected.map((file) => (
							<li key={file.outputId}>
								<FileText aria-hidden size={14} />
								<span className="truncate">{file.title}</span>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={`Remove ${file.title}`}
									title="Remove"
									onClick={() =>
										setSelected((files) =>
											files.filter((item) => item.outputId !== file.outputId),
										)
									}
								>
									<X aria-hidden size={12} />
								</Button>
							</li>
						))}
					</ul>
				) : null}
				<Textarea
					aria-label="Message the workspace"
					className="workspace-chat-composer-input"
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
					{onBrowseResources ? (
						<WorkspaceChatResources
							workspaceId={workspaceId}
							onBrowseResources={onBrowseResources}
							selectedIds={selected.map((file) => file.outputId)}
							onSelect={(file) =>
								setSelected((files) =>
									files.some((item) => item.outputId === file.outputId) ||
									files.length >= 5
										? files
										: [...files, file],
								)
							}
						/>
					) : null}
					<div className="workspace-chat-model">{modelControl}</div>
					{onStop && !draft.trim() ? (
						<Button
							aria-label="Stop"
							title="Stop"
							onClick={onStop}
							size="icon-sm"
							type="button"
						>
							<Stop aria-hidden weight="fill" />
						</Button>
					) : (
						<Button
							aria-label="Send"
							title="Send (Enter). Shift+Enter adds a line."
							disabled={
								disabledReason !== null || submitted !== null || !draft.trim()
							}
							size="icon-sm"
							type="submit"
						>
							<PaperPlaneRight aria-hidden />
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}

function readDraft(key: string): string {
	try {
		return window.sessionStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function writeDraft(key: string, text: string) {
	try {
		if (text) window.sessionStorage.setItem(key, text);
		else window.sessionStorage.removeItem(key);
	} catch {
		// Storage can be unavailable; the draft still lives on this page.
	}
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
