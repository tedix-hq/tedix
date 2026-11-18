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
	createContext,
	lazy,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseSkillReferences } from "@tedix/api-contract/utils/skill-reference";
import {
	ChatSkillPicker,
	ChatSkillPills,
} from "@/components/chat-skill-picker";
import {
	type ComposerSkill,
	composerReachableSkills,
	draftPickerTrigger,
	filterComposerSkills,
	insertSkillReference,
	removeSkillReference,
} from "@/lib/chat-skill-picker";
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
import { AppEditDiff, AppEditUndo } from "@/components/app-edit-approval";
import {
	appEditRequestFrom,
	publishPendingAppEdits,
} from "@/lib/app-edit-approval";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { mentionedPeople, notifyChatPosted } from "@/lib/workspace-chat-notify";
import { WorkspaceChatResources } from "@/components/workspace-chat-resources";
import { ReplyApprovalActions } from "@/components/workspace-chat-reply-actions";
import { ChatImagePreview } from "@/components/chat-image-preview";
import { isImeComposing } from "@/lib/keyboard";
import {
	osQueryKeys,
	SKILL_CATALOG_LIMIT,
	skillCatalogQueryOptions,
} from "@/lib/os-query-options";
import { useNow } from "@/lib/use-now";
import {
	refForWorkspaceModelId,
	useChatModelPreference,
	workspaceModelIdForRef,
} from "@/lib/use-chat-model-preference";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import type { createWorkspaceChatClient } from "@/lib/workspace-chat-client";
import type {
	ConversationChange,
	WorkspaceChatClient,
	WorkspaceChatConnection,
} from "@/lib/workspace-chat-client";
import type { AutoApprovalKind } from "@/lib/workspace-chat-protocol";
import {
	activeTurn,
	type ChatApproval,
	type ChatStep,
	type ChatTurn,
	conversationUsage,
	type WorkspaceChatState,
	elapsedLabel,
	formatConversationUsage,
	formatWorkspaceUsage,
	messageAccepted,
	pendingApproval,
	turnDetails,
	usageTotalsNote,
	waitingForDecision,
} from "@/lib/workspace-chat-state";
import {
	AddedMessages,
	QueuedMessages,
	useReturnedMessages,
} from "./workspace-chat-queued";
import {
	ApprovalTray,
	approvalSubject,
} from "@/components/workspace-chat-approval-tray";
import { AlwaysApproveButton } from "@/components/workspace-chat-always-approve";
import {
	approvalTitle,
	webPageRequest,
} from "@/lib/workspace-chat-web-approval";
import {
	OpenChangedFile,
	ReplyCopy,
	StepDetail,
	stepHasDetail,
	SummarisedMarker,
} from "@/components/workspace-chat-step-detail";
import {
	ConversationList,
	ConversationTitle,
} from "@/components/workspace-chat-conversations";
import { publishWorkspaceAutoApprovals } from "@/lib/workspace-auto-approvals";
import { VIEW_ONLY_CHAT_REASON } from "@/lib/workspace-view-only";

const WidgetFrame = lazy(async () => ({
	default: (await import("@/components/widget-frame")).WidgetFrame,
}));

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
	/** The person can view this workspace but not chat in it. */
	viewOnly?: boolean;
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
	onBrowseResources,
	autoFocusComposer = false,
	unreadByConversation,
	onActivity,
	viewOnly = false,
	createClient,
}: WorkspaceChatProps) {
	const queryClient = useQueryClient();
	const onOutputChanged = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
		void queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() });
	}, [queryClient]);
	const { snapshot, client } = useWorkspaceChat(
		workspaceId,
		conversationId,
		createClient,
		onOutputChanged,
	);
	const { state, connection, catchingUp } = snapshot;
	const modelPreference = useChatModelPreference();
	const [pickedModelId, setPickedModelId] = useState<string | null>(null);
	const selectedModelId =
		pickedModelId ?? workspaceModelIdForRef(modelPreference.modelRef);
	const saveModelPreference = modelPreference.save;
	const selectModel = useCallback(
		(value: string) => {
			setPickedModelId(value);
			saveModelPreference(refForWorkspaceModelId(value));
		},
		[saveModelPreference],
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
				<SelectValue>{selectedModel?.label ?? null}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{state.models.map((model) => (
					<SelectItem key={model.id} value={model.id}>
						{model.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	) : null;
	const running = activeTurn(state);
	const approval = pendingApproval(running);
	// Waiting proposals never block the composer: they sit in the tray above
	// it, and the agent is told about them on the next message. Every hold in
	// workspace chat is an independent write; no agent step blocks on one.
	const waiting = waitingForDecision(state);
	const connected = connection.phase === "open";
	const setRule = useMemo(
		() =>
			client && connected
				? (kind: AutoApprovalKind, enabled: boolean) =>
						client.setAutoApproval(kind, enabled)
				: null,
		[client, connected],
	);
	const rules = state.autoApprovals;
	useEffect(() => {
		publishWorkspaceAutoApprovals({ workspaceId, rules, setRule });
		return () => publishWorkspaceAutoApprovals(null);
	}, [workspaceId, rules, setRule]);
	const autoApproval = useMemo(
		() => ({
			enabled: new Set(rules.map((rule) => rule.kind)),
			enable: setRule ? (kind: AutoApprovalKind) => setRule(kind, true) : null,
		}),
		[rules, setRule],
	);
	useEffect(() => {
		const edits = state.turns.flatMap((turn) =>
			turn.approvals.flatMap((item) => {
				const request = appEditRequestFrom(item.input);
				return request && item.decision === null && !item.execution
					? [
							{
								...request,
								workspaceId,
								approvalId: item.approvalId,
								decide: (decision: "approve" | "deny") =>
									client?.decideApproval(item.approvalId, decision),
							},
						]
					: [];
			}),
		);
		publishPendingAppEdits(edits);
		return () => publishPendingAppEdits([]);
	}, [state.turns, client, workspaceId]);

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
			if (!trimmed || !client || viewOnly) return;
			notePost(trimmed);
			return client.sendTurn({
				text: trimmed,
				...(modelId ? { modelId } : {}),
				...(attachments?.length ? { attachments } : {}),
			});
		},
		[client, modelId, notePost, viewOnly],
	);
	const viewOnlyNote = viewOnly ? (
		<p
			className="workspace-chat-view-only"
			data-testid="workspace-chat-view-only"
			role="status"
		>
			{VIEW_ONLY_CHAT_REASON}
		</p>
	) : null;
	useEffect(() => {
		if (!client || !onSendMessageReady) return;
		onSendMessageReady(send);
		return () => onSendMessageReady(() => {});
	}, [client, onSendMessageReady, send]);

	const title =
		state.conversations.find(
			(conversation) => conversation.id === conversationId,
		)?.title ?? null;
	const changeConversation = useMemo(
		() =>
			client && connected
				? (change: ConversationChange) => client.changeConversation(change)
				: null,
		[client, connected],
	);
	// The open conversation was deleted, here or by someone else.
	const deleted = state.lastError?.code === "conversation_deleted";
	const leftDeleted = useRef<WorkspaceChatClient | null>(null);
	useEffect(() => {
		if (!deleted || leftDeleted.current === client) return;
		leftDeleted.current = client;
		onSelectConversation(null);
		onOpenList();
	}, [deleted, client, onSelectConversation, onOpenList]);

	if (listOpen) {
		return (
			<div className="workspace-chat" data-testid="workspace-chat">
				<ConversationList
					conversations={state.conversations}
					activeId={conversationId}
					activeRunning={running !== null}
					activePendingApprovals={waiting.length}
					onChange={changeConversation}
					onSelect={onSelectConversation}
					unread={unreadByConversation}
				/>
				{viewOnlyNote}
				<Composer
					key="composer"
					client={client}
					state={state}
					modelControl={modelControl}
					workspaceId={workspaceId}
					onBrowseResources={onBrowseResources}
					onSend={(text, attachments) => {
						if (viewOnly) return undefined;
						onSelectConversation(null);
						notePost(text);
						return client?.sendTurn({
							text,
							newConversation: true,
							...(modelId ? { modelId } : {}),
							...(attachments?.length ? { attachments } : {}),
						});
					}}
					disabledReason={viewOnly ? VIEW_ONLY_CHAT_REASON : null}
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
				<ConversationTitle
					key={conversationId ?? "new"}
					fallback={conversationId ? "Conversation" : "New conversation"}
					onRename={
						conversationId && changeConversation
							? (next) =>
									changeConversation({
										type: "rename_conversation",
										conversationId,
										title: next,
									})
							: null
					}
					title={title}
				/>
				<WorkspaceSpend state={state} />
				<ConnectionChip client={client} connection={connection} />
			</div>
			<AutoApprovalContext.Provider value={autoApproval}>
				<Thread
					workspaceId={workspaceId}
					conversationId={conversationId}
					turns={state.turns}
					models={state.models}
					queued={state.queued}
					pendingSend={state.pendingSend}
					catchingUp={
						catchingUp && state.turns.length === 0 && conversationId !== null
					}
					hasEarlier={state.hasEarlier}
					onLoadEarlier={() => client?.loadEarlier()}
					onDecide={(approvalId, decision) =>
						client?.decideApproval(approvalId, decision)
					}
					onApproveAll={(approvalIds) =>
						client?.decideApprovals(approvalIds, "approve")
					}
					onContinue={
						viewOnly || running || state.pendingSend
							? null
							: () => void send(CONTINUE_TEXT)
					}
					onRetry={
						viewOnly || running || state.pendingSend
							? null
							: (text, attachments) => void send(text, attachments)
					}
				/>
			</AutoApprovalContext.Provider>
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
			) : state.lastError && !viewOnly ? (
				<div className="workspace-chat-error" role="alert">
					<WarningCircle aria-hidden />
					<Text role="caption" tone="error">
						{state.lastError.message}
					</Text>
				</div>
			) : null}
			<ApprovalTray
				key={conversationId ?? "new"}
				approvals={waiting}
				onDecide={(approvalId, decision) =>
					client?.decideApproval(approvalId, decision)
				}
				onApproveAll={(approvalIds) =>
					client?.decideApprovals(approvalIds, "approve")
				}
			/>
			{viewOnlyNote}
			<Composer
				key="composer"
				client={client}
				state={state}
				modelControl={modelControl}
				workspaceId={workspaceId}
				onBrowseResources={onBrowseResources}
				onSend={send}
				disabledReason={
					viewOnly
						? VIEW_ONLY_CHAT_REASON
						: connection.phase === "unavailable"
							? "Workspace chat is being upgraded. Use Home chat for now."
							: null
				}
				autoFocus={autoFocusComposer}
				busy={running !== null || state.pendingSend !== null}
				onStop={
					running && client ? () => client.cancelTurn(running.turnId) : null
				}
				footer={<ConversationSpend state={state} />}
			/>
		</div>
	);
}

/** What this conversation has used so far; nothing until a reply reports it. */
function ConversationSpend({ state }: { state: WorkspaceChatState }) {
	const totals = conversationUsage(state);
	const label = formatConversationUsage(totals);
	if (!totals || !label) return null;
	return (
		<p
			className="workspace-chat-spend"
			data-testid="workspace-chat-conversation-spend"
			title={usageTotalsNote(totals) ?? "Used by this conversation so far"}
		>
			{label}
		</p>
	);
}

/** The workspace's running total, beside the conversation title. */
function WorkspaceSpend({ state }: { state: WorkspaceChatState }) {
	const label = formatWorkspaceUsage(state.usage);
	if (!state.usage || !label) return null;
	const note = usageTotalsNote(state.usage);
	return (
		<span
			className="workspace-chat-workspace-spend"
			data-testid="workspace-chat-workspace-spend"
			title={
				note
					? `Used in this workspace so far. ${note}`
					: "Used in this workspace so far"
			}
		>
			<span className="sr-only">Used in this workspace so far: </span>
			{label}
		</span>
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
	workspaceId,
	conversationId,
	turns,
	models,
	queued,
	pendingSend,
	catchingUp,
	hasEarlier,
	onLoadEarlier,
	onDecide,
	onApproveAll,
	onContinue,
	onRetry,
}: {
	workspaceId: string;
	conversationId: string | null;
	turns: ChatTurn[];
	models: ReadonlyArray<{ id: string; label: string }>;
	/** Sent while the agent works; it has not read them yet. */
	queued: WorkspaceChatState["queued"];
	pendingSend: { clientTurnId: string; text: string; sentAt: number } | null;
	catchingUp: boolean;
	hasEarlier: boolean;
	onLoadEarlier: () => void;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	onApproveAll: ApproveAll;
	/** Resumes after the last turn; `null` while another turn is busy. */
	onContinue: (() => void) | null;
	/** Sends a failed or stopped turn's own message again; `null` while busy. */
	onRetry: RetryTurn | null;
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
					workspaceId={workspaceId}
					modelLabel={
						models.find((model) => model.id === turn.model)?.label ?? turn.model
					}
					onDecide={onDecide}
					onApproveAll={onApproveAll}
					latest={index === turns.length - 1}
					onContinue={
						index === turns.length - 1 &&
						(turn.status === "cancelled" || turn.status === "error")
							? onContinue
							: null
					}
					onRetry={
						index === turns.length - 1 &&
						(turn.status === "cancelled" || turn.status === "error")
							? onRetry
							: null
					}
					turn={turn}
				/>
			))}
			<QueuedMessages messages={queued} />
			{pendingSend ? (
				<div className="workspace-chat-turn" data-pending="true">
					<UserBubble text={pendingSend.text} />
					<Thinking label="Sending" since={pendingSend.sentAt} />
				</div>
			) : null}
		</div>
	);
}

/** Approves every listed proposal of one reply together. */
type ApproveAll = (approvalIds: string[]) => void;

type RetryTurn = (
	text: string,
	attachments?: Array<{ outputId: string }>,
) => void;

/** What Continue sends after a stopped or interrupted turn. */
const CONTINUE_TEXT =
	"Continue where you stopped. Check what already happened before repeating any change.";

function TurnView({
	workspaceId,
	turn,
	modelLabel,
	latest,
	onDecide,
	onApproveAll,
	onContinue,
	onRetry,
}: {
	workspaceId: string;
	turn: ChatTurn;
	/** The catalog name of the model that answered, else its id. */
	modelLabel: string | undefined;
	/** The newest turn of the thread. */
	latest: boolean;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	onApproveAll: ApproveAll;
	onContinue: (() => void) | null;
	onRetry: RetryTurn | null;
}) {
	const running = turn.status === "running";
	const startedAt = Date.parse(turn.startedAt);
	const waiting = turn.approvals.find((approval) => approval.decision === null);
	const now = useNow(running && !waiting);
	const [approvingAll, setApprovingAll] = useState<readonly string[]>([]);
	const quiet =
		running && !waiting && turn.reply === "" && turn.steps.length === 0;
	return (
		<article
			className="workspace-chat-turn group/message"
			data-status={turn.status}
			data-testid="workspace-chat-turn"
		>
			{turn.summarizedEarlier ? <SummarisedMarker /> : null}
			{turn.text ? <UserBubble text={turn.text} /> : null}
			{turn.attachments?.length ? (
				<ul aria-label="Message files" className="m-0 grid list-none gap-1 p-0">
					{turn.attachments.map((file) => (
						<li key={file.outputId}>
							<ChatImagePreview
								workspaceId={workspaceId}
								outputId={file.outputId}
								title={file.title}
							/>
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
			<AddedMessages messages={turn.added} />
			<div className="workspace-chat-reply" key={turn.replyKey}>
				{turn.steps.length > 0 ? (
					<Activity steps={turn.steps} approvals={turn.approvals} />
				) : null}
				{turn.approvals.map((approval) => (
					<ApprovalCard
						approval={approval}
						workspaceId={workspaceId}
						key={approval.approvalId}
						onDecide={onDecide}
						approving={approvingAll.includes(approval.approvalId)}
					/>
				))}
				<ReplyApprovalActions
					approvals={turn.approvals}
					approvingAll={turn.approvals.some(
						(approval) =>
							approval.decision === null &&
							approvingAll.includes(approval.approvalId),
					)}
					onApproveAll={(approvalIds) => {
						setApprovingAll(approvalIds);
						onApproveAll(approvalIds);
					}}
				/>
				{quiet ? <Thinking label="Thinking" since={startedAt} /> : null}
				{turn.reply ? (
					<div
						className="workspace-chat-prose"
						data-streaming={!turn.replyDone}
					>
						<ChatMarkdown content={turn.reply} />
					</div>
				) : null}
				{turn.reply && turn.replyDone ? (
					<ReplyCopy text={turn.reply} latest={latest} />
				) : null}
				{turn.views?.map((view) => (
					<div
						className="workspace-chat-view"
						data-testid="workspace-chat-view"
						key={view.viewId}
					>
						<Suspense fallback={<Text role="label">Opening view…</Text>}>
							<WidgetFrame
								appSlug={view.appSlug}
								resourceUri={view.resourceUri}
								title={view.title}
								toolResult={view.toolResult}
							/>
						</Suspense>
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
				{onContinue || (onRetry && turn.text) ? (
					<div className="flex gap-2">
						{onContinue ? (
							<Button onClick={onContinue} size="xs" variant="outline">
								Continue
							</Button>
						) : null}
						{onRetry && turn.text ? (
							<Button
								onClick={() =>
									onRetry(
										turn.text,
										turn.attachments?.map((file) => ({
											outputId: file.outputId,
										})),
									)
								}
								size="xs"
								variant="ghost"
							>
								Retry
							</Button>
						) : null}
					</div>
				) : null}
				{waiting || running || turn.status === "waiting" ? (
					<footer className="workspace-chat-turn-footer">
						<Text
							role="caption"
							tone="secondary"
							data-testid="workspace-chat-timer"
						>
							{waiting || turn.status === "waiting" ? (
								<a
									href={
										waiting
											? `#approval-${waiting.approvalId}`
											: turn.approvalUrl
									}
								>
									Waiting for approval
								</a>
							) : (
								<>Working · {elapsedLabel(now - startedAt)}</>
							)}
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
	if (approval.execution?.status === "applied")
		return approval.automatic ? "Approved automatically" : "Applied";
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
	const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
	const expanded = open || live;
	const errored = (step: ChatStep) =>
		!held(step) && !refused(step) && step.status === "error";
	// A step that went wrong and was followed by one that worked is a retry,
	// not a failed reply: only an unrecovered last step or a failed change is.
	const failed =
		steps.some((step) => held(step)?.execution?.status === "failed") ||
		(steps.length > 0 && errored(steps.at(-1)!));
	const retried = failed ? 0 : steps.filter(errored).length;
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
				) : retried > 0 ? (
					<Text as="span" role="caption" tone="secondary">
						{retried} retried
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
						const detailed = stepHasDetail(step);
						const detailOpen = detailed && shown.has(step.stepId);
						return (
							<li key={step.stepId}>
								<div
									className="workspace-chat-step"
									data-status={approvalLabel ?? step.status}
									data-testid="workspace-chat-step"
								>
									<Icon aria-hidden />
									{detailed ? (
										<button
											aria-expanded={detailOpen}
											className="workspace-chat-step-toggle truncate"
											onClick={() =>
												setShown((previous) => {
													const next = new Set(previous);
													if (!next.delete(step.stepId)) next.add(step.stepId);
													return next;
												})
											}
											title={detailOpen ? "Hide what ran" : "Show what ran"}
											type="button"
										>
											{step.label}
										</button>
									) : (
										<span className="truncate">{step.label}</span>
									)}
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
										<CheckCircle
											aria-hidden
											className="workspace-chat-step-ok"
										/>
									) : null}
								</div>
								{detailOpen ? <StepDetail step={step} /> : null}
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

/**
 * The workspace's "Always approve" rules, for the cards: which kinds are on,
 * and how to turn one on. `enable` is null while the chat is not connected.
 */
const AutoApprovalContext = createContext<{
	enabled: ReadonlySet<AutoApprovalKind>;
	enable: ((kind: AutoApprovalKind) => void) | null;
}>({ enabled: new Set(), enable: null });

/** The decision and the action's recorded result remain separate. */
function ApprovalCard({
	approval,
	workspaceId,
	onDecide,
	approving,
}: {
	approval: ChatApproval;
	workspaceId: string;
	onDecide: (approvalId: string, decision: "approve" | "deny") => void;
	/** Approved together with the rest of its reply; the decision is on its way. */
	approving: boolean;
}) {
	const [own, setSent] = useState<"approve" | "deny" | null>(null);
	const sent = own ?? (approving ? "approve" : null);
	const decided = approval.decision ?? sent;
	const input = objectValue(approval.input);
	const target =
		approval.target?.title ??
		(typeof input?.title === "string" ? input.title : null);
	const appEdit = appEditRequestFrom(approval.input);
	const preview = appEdit ? "" : approvalPreview(input);
	const status = approvalStatus(approval);
	const failed = approval.execution?.status === "failed";
	const subject = approvalSubject(approval);
	const page = webPageRequest(approval);
	const autoApproval = useContext(AutoApprovalContext);
	const rule = approval.rule;
	const canAlwaysApprove =
		rule !== undefined && !appEdit && !autoApproval.enabled.has(rule.kind);
	return (
		<div
			className="workspace-chat-approval"
			id={`approval-${approval.approvalId}`}
			data-decision={approval.decision ?? (sent ? "pending" : "open")}
			data-testid="workspace-chat-approval"
		>
			<div className="workspace-chat-approval-head">
				<ShieldCheck aria-hidden />
				<Text as="strong" role="label">
					{approvalTitle(approval)}
				</Text>
			</div>
			{page ? (
				<Text
					role="body"
					className="workspace-chat-approval-url"
					data-testid="workspace-chat-approval-url"
				>
					{page.url}
				</Text>
			) : null}
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
						? page
							? "The agent read this page."
							: "The workspace applied this change."
						: approval.decision === "deny"
							? "The action was denied."
							: approval.decision === "approve"
								? "Your approval was recorded. The action's result has not been recorded."
								: page
									? `The agent wants to read this page. If you approve, it can read pages on ${page.site} for the rest of this conversation.`
									: "Review the proposed change, then approve or deny it."}
			</Text>
			{appEdit ? (
				<div className="workspace-chat-approval-preview">
					<AppEditDiff workspaceId={workspaceId} edit={appEdit} />
					{approval.execution?.status === "applied" ? (
						<AppEditUndo workspaceId={workspaceId} edit={appEdit} />
					) : null}
				</div>
			) : null}
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
			{approval.execution?.status === "applied" &&
			approval.execution.output &&
			!appEdit ? (
				<div className="workspace-chat-approval-actions">
					<OpenChangedFile
						outputId={approval.execution.output.outputId}
						title={target}
					/>
				</div>
			) : null}
			{!approval.decision && !approval.execution ? (
				<div className="workspace-chat-approval-actions">
					<Button
						aria-label={`${appEdit ? "Reject" : "Deny"} ${subject}`}
						disabled={decided !== null}
						onClick={() => {
							setSent("deny");
							onDecide(approval.approvalId, "deny");
						}}
						size="sm"
						variant="outline"
					>
						{appEdit ? "Reject" : "Deny"}
					</Button>
					<Button
						aria-label={`${appEdit ? "Accept" : "Approve"} ${subject}`}
						disabled={decided !== null}
						onClick={() => {
							setSent("approve");
							onDecide(approval.approvalId, "approve");
						}}
						size="sm"
					>
						{sent === "approve"
							? appEdit
								? "Accepting…"
								: "Approving…"
							: appEdit
								? "Accept"
								: "Approve"}
					</Button>
					{canAlwaysApprove && rule ? (
						<AlwaysApproveButton
							rule={rule}
							disabled={decided !== null || !autoApproval.enable}
							onConfirm={(kind) => {
								autoApproval.enable?.(kind);
								setSent("approve");
								onDecide(approval.approvalId, "approve");
							}}
						/>
					) : null}
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
	footer,
}: {
	/** A quiet line under the composer card. */
	footer?: ReactNode;
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
	// Stop hands back what the agent had not read: it goes ahead of the draft.
	const returnedMessages = useReturnedMessages(state.returned, (messages) => {
		const text = messages.map((message) => message.text).join("\n\n");
		setDraft((current) => (current.trim() ? `${text}\n\n${current}` : text));
		setSelected((files) =>
			[
				...files,
				...messages
					.flatMap((message) => message.attachments ?? [])
					.filter(
						(file) => !files.some((item) => item.outputId === file.outputId),
					)
					.map(({ outputId, title }) => ({ outputId, title })),
			].slice(0, 5),
		);
	});
	const workingTurnId = activeTurn(state)?.turnId ?? null;
	useEffect(() => {
		if (!submitted) return;
		if (messageAccepted(state, submitted.id)) {
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
	}, [state.turns, state.queued, state.returned, state.lastError, submitted]);
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
		if (id) returnedMessages.sent(id);
		if (id)
			setSubmitted({
				id,
				text: draft,
				files: selected.map((file) => file.outputId),
				draftKey,
			});
	};
	// A bare `/` token opens the same bounded skill picker Home chat has. A
	// pick writes the canonical `/skill <slug>` line into the message; the
	// workspace object loads that skill for the turn.
	const skillTrigger = draftPickerTrigger(draft);
	const [skillDismissed, setSkillDismissed] = useState(false);
	const [skillActiveIndex, setSkillActiveIndex] = useState(-1);
	const skillListboxId = useId();
	const skillCatalog = useQuery({
		...skillCatalogQueryOptions(SKILL_CATALOG_LIMIT),
		enabled: skillTrigger !== null && !skillDismissed,
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
	const reachableSkills = useMemo(
		() => composerReachableSkills(skillCatalog.data?.entries ?? []),
		[skillCatalog.data],
	);
	const skillMatches = useMemo(
		() =>
			skillTrigger === null
				? []
				: filterComposerSkills(reachableSkills, skillTrigger),
		[reachableSkills, skillTrigger],
	);
	const skillPickerOpen =
		skillTrigger !== null &&
		!skillDismissed &&
		(skillCatalog.isPending || skillCatalog.isError || skillMatches.length > 0);
	useEffect(() => {
		setSkillActiveIndex(-1);
		if (skillTrigger === null) setSkillDismissed(false);
	}, [skillTrigger]);
	const skillPills = useMemo(() => {
		const titles = new Map(
			reachableSkills.map((skill) => [skill.slug, skill.title]),
		);
		return parseSkillReferences(draft).map((slug) => ({
			slug,
			title: titles.get(slug) ?? slug,
		}));
	}, [draft, reachableSkills]);
	const confirmSkill = (skill: ComposerSkill) => {
		setDraft(insertSkillReference(draft, skill.slug));
		setSkillActiveIndex(-1);
		textarea.current?.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (skillPickerOpen && !isImeComposing(event)) {
			if (
				skillMatches.length > 0 &&
				(event.key === "ArrowDown" || event.key === "ArrowUp")
			) {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setSkillActiveIndex((index) => {
					const next = index + step;
					if (next < 0) return skillMatches.length - 1;
					return next >= skillMatches.length ? 0 : next;
				});
				return;
			}
			// Enter confirms only from a row the person highlighted, so typing
			// `/anything` and pressing Enter still sends.
			const highlighted = skillMatches[skillActiveIndex];
			if (event.key === "Enter" && !event.shiftKey && highlighted) {
				event.preventDefault();
				confirmSkill(highlighted);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setSkillDismissed(true);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="workspace-chat-composer" onSubmit={submit}>
			<div className="workspace-chat-composer-card">
				{skillPickerOpen ? (
					<ChatSkillPicker
						activeIndex={skillActiveIndex}
						error={skillCatalog.isError}
						listboxId={skillListboxId}
						loading={skillCatalog.isPending}
						onRetry={() => void skillCatalog.refetch()}
						onSelect={confirmSkill}
						skills={skillMatches}
					/>
				) : null}
				<ChatSkillPills
					skills={skillPills}
					onRemove={(slug) => {
						setDraft(removeSkillReference(draft, slug));
						textarea.current?.focus();
					}}
				/>
				{selected.length ? (
					<ul
						aria-label="Files added to this message"
						className="workspace-chat-composer-files"
					>
						{selected.map((file) => (
							<li key={file.outputId}>
								<ChatImagePreview
									workspaceId={workspaceId}
									outputId={file.outputId}
									title={file.title}
									size="chip"
								/>
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
						(busy
							? "Add to what the agent is working on…"
							: "Ask this workspace…")
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
					{onStop ? (
						<Button
							aria-label="Stop"
							title="Stop. Messages the agent has not read come back here."
							onClick={() => {
								if (workingTurnId) returnedMessages.stopped(workingTurnId);
								onStop();
							}}
							size="icon-sm"
							type="button"
							variant="outline"
						>
							<Stop aria-hidden weight="fill" />
						</Button>
					) : null}
					<Button
						aria-label="Send"
						title={
							onStop
								? "Send to the agent while it works (Enter). It reads this at its next step."
								: "Send (Enter). Shift+Enter adds a line."
						}
						disabled={
							disabledReason !== null || submitted !== null || !draft.trim()
						}
						size="icon-sm"
						type="submit"
					>
						<PaperPlaneRight aria-hidden />
					</Button>
				</div>
			</div>
			{footer}
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
