import { LoadingArea } from "@/components/loading-area";
import { ConversationUsageRing } from "@/components/chat-usage-line";
import "./workspace-chat.css";
import { RegisteredAppSchedule } from "./workspace-app-connections";
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
	type ReactNode,
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
import { ApprovalModePicker } from "@/components/workspace-chat-approval-mode";
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
import { AgentRunCard } from "@/components/agent-run-card";
import { agentRunFromToolResult } from "@/lib/agent-run-result";
import { WorkspaceChatResources } from "@/components/workspace-chat-resources";
import { ReplyApprovalActions } from "@/components/workspace-chat-reply-actions";
import { ConnectionRequestCard } from "@/components/workspace-chat-connect-card";
import { TediApprovalCard } from "@/components/workspace-chat-tedi-approval-card";
import { ChatImagePreview } from "@/components/chat-image-preview";
import {
	CHAT_FILE_LIMIT,
	pastedFiles,
	useWorkspaceChatFileDrop,
	useWorkspaceChatUploads,
	WorkspaceChatComposerFiles,
	WorkspaceChatDropZone,
} from "@/components/workspace-chat-attach";
import { isImeComposing } from "@/lib/keyboard";
import {
	canvasGadgetsQueryOptions,
	modelCatalogQueryOptions,
	osQueryKeys,
	SKILL_CATALOG_LIMIT,
	skillCatalogQueryOptions,
	tediDetailQueryOptions,
	tediRosterQueryOptions,
	workspaceDetailQueryOptions,
	workspacePresenceQueryOptions,
} from "@/lib/os-query-options";
import { useNow } from "@/lib/use-now";
import { useTediNames } from "@/lib/use-tedi-names";
import { WorkspaceChatAuthor } from "./workspace-chat-author";
import {
	refForWorkspaceModelId,
	useChatModelPreference,
	workspaceChatModelId,
	workspaceModelIdForRef,
} from "@/lib/use-chat-model-preference";
import { useWorkspaceChat } from "@/lib/use-workspace-chat";
import {
	readWorkspaceChatDraft,
	writeWorkspaceChatDraft,
} from "@/lib/workspace-chat-draft";
import { mayPickWorkspaceTedi } from "@/lib/workspace-guest-tedi";
import { turnFailure } from "@/lib/workspace-chat-failure";
import type { createWorkspaceChatClient } from "@/lib/workspace-chat-client";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";
import type {
	ConversationChange,
	WorkspaceChatClient,
	WorkspaceChatConnection,
} from "@/lib/workspace-chat-client";
import {
	activeTurn,
	type ChatApproval,
	type ChatStep,
	type ChatTurn,
	type WorkspaceChatState,
	elapsedLabel,
	messageAccepted,
	pendingApproval,
	turnDetails,
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
import { approvalTarget } from "@/lib/workspace-chat-approval-groups";
import {
	noteAskedTurn,
	receiveWorkspaceChatAsks,
	receiveWorkspaceChatDrafts,
	type WorkspaceChatAsk,
} from "@/lib/workspace-chat-draft-handoff";
import {
	approvalTitle,
	webPageRequest,
} from "@/lib/workspace-chat-web-approval";
import {
	OpenChangedFile,
	OpenCreatedApp,
	ReplyCopy,
	StepDetail,
	stepHasDetail,
	SummarisedMarker,
} from "@/components/workspace-chat-step-detail";
import {
	ConversationList,
	type ConversationNotifications,
	ConversationTitle,
} from "@/components/workspace-chat-conversations";
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
	/** Which conversations notify the person, and how to change one. */
	chatNotifications?: ConversationNotifications;
	/** Something happened in the open conversation: a turn started, finished or asked for a decision. */
	onActivity?: () => void;
	/** The person can view this workspace but not chat in it. */
	viewOnly?: boolean;
	/** Every conversation the chat knows, for a host that shows them itself. */
	onConversations?: (conversations: readonly ConversationSummary[]) => void;
	/**
	 * Opens the host's Agents view. The list then links to it and keeps only
	 * the conversations people started; the runs agents started are listed there.
	 */
	onOpenAgents?: () => void;
	/**
	 * The tedi that answers every message of this chat. The composer then
	 * offers no choice of its own, and a new chat starts on the tedi default
	 * model.
	 */
	tediId?: string | null;
	/**
	 * `personChat`: this is the person's own private workspace, so a new chat
	 * starts on the administrator's default for a person's chat, as a chat
	 * with a tedi does, and the workspace applies it until the person picks.
	 */
	modelDefault?: "personChat";
	/** Shown in the composer row, where the choice of who replies sits. */
	composerSlot?: ReactNode;
	/**
	 * The host lists the conversations beside the thread on wide screens, so
	 * the header's back button shows on narrow ones only.
	 */
	embedded?: boolean;
	/** The message box's hint; "Ask this workspace…" when absent. */
	placeholder?: string;
	/** The line an empty thread shows. */
	emptyText?: string;
	/** Test seam. */
	createClient?: typeof createWorkspaceChatClient;
};

/** The picker's value when the person chose the workspace agent itself. */
const WORKSPACE_AGENT = "agent";

/**
 * Who a send names to answer: a tedi, the workspace agent, or nobody, when
 * the workspace's default tedi answers.
 */
function answererFields(
	pinnedTediId: string | null,
	picked: string | undefined,
): { tediId?: string; answerer?: "agent" } {
	const answering = pinnedTediId ?? picked;
	if (!answering) return {};
	return answering === WORKSPACE_AGENT
		? { answerer: "agent" }
		: { tediId: answering };
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
	chatNotifications,
	onActivity,
	viewOnly = false,
	onConversations,
	onOpenAgents,
	tediId: pinnedTediId = null,
	modelDefault,
	composerSlot,
	embedded = false,
	placeholder,
	emptyText,
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
	useEffect(() => {
		onConversations?.(state.conversations);
	}, [onConversations, state.conversations]);
	const tediNames = useTediNames();
	const modelPreference = useChatModelPreference();
	// A chat with a tedi, or in the person's own private workspace, starts on
	// the administrator's default model for a person's chat.
	const personChat = Boolean(pinnedTediId) || modelDefault === "personChat";
	const modelCatalog = useQuery({
		...modelCatalogQueryOptions(),
		staleTime: 60_000,
		enabled: personChat,
	});
	const [pickedModel, setPickedModel] = useState<{
		conversationId: string | null;
		id: string;
	} | null>(null);
	const saveModelPreference = modelPreference.save;
	const selectModel = useCallback(
		(value: string) => {
			setPickedModel({ conversationId, id: value });
			// A pick in a person's chat stays in that chat: the remembered
			// model belongs to the ordinary workspace chats.
			if (!personChat) saveModelPreference(refForWorkspaceModelId(value));
		},
		[conversationId, personChat, saveModelPreference],
	);
	const pickedHere =
		pickedModel?.conversationId === conversationId ? pickedModel.id : null;
	const lastAnswered =
		state.turns.findLast((turn) => turn.model)?.model ?? null;
	const modelId = workspaceChatModelId({
		offered: state.models,
		pickedHere,
		lastAnswered,
		remembered: workspaceModelIdForRef(
			personChat
				? (modelCatalog.data?.personChatModelRef ?? null)
				: modelPreference.modelRef,
		),
	});
	// A person's chat names a model only when the person picked one here or
	// the conversation already has one. Otherwise the workspace applies the
	// administrator's default, also when this page has not loaded it yet.
	const sentModelId = personChat
		? workspaceChatModelId({
				offered: state.models.filter(
					({ id }) => id === pickedHere || id === lastAnswered,
				),
				pickedHere,
				lastAnswered,
				remembered: null,
			})
		: modelId;
	// Until the default is known, the picker of a person's chat shows no
	// model instead of the first offered one.
	const shownModelId =
		personChat && !sentModelId && modelCatalog.isPending ? undefined : modelId;
	const selectedModel = state.models.find((model) => model.id === shownModelId);
	const modelControl = state.models.length ? (
		<Select
			value={shownModelId ?? null}
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
	// The tray holds the whole workspace's, not only this conversation's.
	const waiting = waitingForDecision(state);
	const connected = connection.phase === "open";
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
		(
			text: string,
			attachments?: Array<{ outputId: string }>,
			tediId?: string,
		) => {
			const trimmed = text.trim();
			if (!trimmed || !client || viewOnly) return;
			notePost(trimmed);
			return client.sendTurn({
				text: trimmed,
				...answererFields(pinnedTediId, tediId),
				...(sentModelId ? { modelId: sentModelId } : {}),
				...(attachments?.length ? { attachments } : {}),
			});
		},
		[client, sentModelId, notePost, pinnedTediId, viewOnly],
	);
	// A workspace app asks the agent for the person using it: sent at once as
	// their own message, in a new conversation or the one shown here. Only the
	// workspace's own chat takes asks, never a chat with a pinned tedi.
	const takeAsk = useRef<((ask: WorkspaceChatAsk) => string) | null>(null);
	takeAsk.current =
		client && !viewOnly && !pinnedTediId && !embedded
			? (ask) => {
					const fresh = ask.conversation === "new" || conversationId === null;
					if (fresh) onSelectConversation(null);
					notePost(ask.text);
					return client.sendTurn({
						text: ask.text,
						...(fresh ? { newConversation: true } : {}),
						...(sentModelId ? { modelId: sentModelId } : {}),
						fromAppId: ask.fromAppId,
					});
				}
			: null;
	const takesAsks = takeAsk.current !== null;
	useEffect(() => {
		if (!takesAsks) return;
		return receiveWorkspaceChatAsks(workspaceId, (ask) =>
			takeAsk.current!(ask),
		);
	}, [takesAsks, workspaceId]);
	// An ask sent while a turn worked is answered by that turn.
	useEffect(() => {
		for (const turn of state.turns) {
			const status = {
				status:
					turn.status === "cancelled"
						? ("error" as const)
						: turn.status === "running"
							? ("running" as const)
							: turn.status,
				text: turn.reply,
			};
			noteAskedTurn(turn.turnId, status);
			for (const added of turn.added ?? [])
				noteAskedTurn(added.messageId, status);
		}
	}, [state.turns]);
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
			client && connected && !viewOnly
				? (change: ConversationChange) => client.changeConversation(change)
				: null,
		[client, connected, viewOnly],
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
			<WorkspaceChatDropZone
				className="workspace-chat"
				data-testid="workspace-chat"
			>
				<ConversationList
					conversations={state.conversations}
					onOpenAgents={onOpenAgents}
					activeId={conversationId}
					activeRunning={running !== null}
					activePendingApprovals={waiting.length}
					onChange={changeConversation}
					onSelect={onSelectConversation}
					unread={unreadByConversation}
					notifications={chatNotifications}
				/>
				{viewOnlyNote}
				<Composer
					key="composer"
					client={client}
					state={state}
					modelControl={modelControl}
					workspaceId={workspaceId}
					onBrowseResources={onBrowseResources}
					pinnedTediId={pinnedTediId}
					slot={composerSlot}
					placeholder={placeholder}
					onSend={(text, attachments, tediId) => {
						if (viewOnly) return undefined;
						onSelectConversation(null);
						notePost(text);
						return client?.sendTurn({
							text,
							newConversation: true,
							...answererFields(pinnedTediId, tediId),
							...(sentModelId ? { modelId: sentModelId } : {}),
							...(attachments?.length ? { attachments } : {}),
						});
					}}
					disabledReason={viewOnly ? VIEW_ONLY_CHAT_REASON : null}
					autoFocus={autoFocusComposer}
					busy={false}
					onStop={null}
				/>
			</WorkspaceChatDropZone>
		);
	}

	return (
		<WorkspaceChatDropZone
			className="workspace-chat"
			data-testid="workspace-chat"
		>
			<div
				className="workspace-chat-header"
				data-embedded={embedded || undefined}
			>
				<Button
					aria-label="All conversations"
					className={embedded ? "md:hidden" : undefined}
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
				<ConnectionChip client={client} connection={connection} />
			</div>
			<Thread
				workspaceId={workspaceId}
				conversationId={conversationId}
				emptyText={emptyText}
				turns={state.turns}
				models={state.models}
				queued={state.queued}
				pendingSend={state.pendingSend}
				catchingUp={
					catchingUp && state.turns.length === 0 && conversationId !== null
				}
				hasEarlier={state.hasEarlier}
				onLoadEarlier={() => client?.loadEarlier()}
				onDecide={(approvalId, decision, options) => {
					if (!viewOnly) client?.decideApproval(approvalId, decision, options);
				}}
				onApproveAll={(approvalIds) => {
					if (!viewOnly) client?.decideApprovals(approvalIds, "approve");
				}}
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
			{connection.phase === "unavailable" ? (
				<div
					className="workspace-chat-unavailable"
					data-testid="workspace-chat-unavailable"
					role="status"
				>
					<Text role="body">
						Workspace chat is unavailable on this origin. Home chat still works.
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
			{viewOnly ? null : (
				<ApprovalTray
					key={conversationId ?? "new"}
					approvals={waiting}
					// The object names a new chat before the pane's own id follows.
					conversationId={state.conversationId ?? conversationId}
					run={state.approvalRun}
					notice={state.approvalNotice}
					tediNames={tediNames}
					onDecide={(approvalId, decision) =>
						client?.decideApproval(approvalId, decision)
					}
					onDecideAll={(approvalIds, decision) =>
						client?.decideApprovals(approvalIds, decision)
					}
					onDismissNotice={() => client?.dismissApprovalNotice()}
					onOpenConversation={onSelectConversation}
				/>
			)}
			{viewOnlyNote}
			<Composer
				key="composer"
				client={client}
				state={state}
				modelControl={modelControl}
				workspaceId={workspaceId}
				onBrowseResources={onBrowseResources}
				pinnedTediId={pinnedTediId}
				slot={composerSlot}
				placeholder={placeholder}
				onSend={send}
				disabledReason={
					viewOnly
						? VIEW_ONLY_CHAT_REASON
						: connection.phase === "unavailable"
							? "Workspace chat is unavailable on this origin. Use Home chat for now."
							: null
				}
				autoFocus={autoFocusComposer}
				busy={running !== null || state.pendingSend !== null}
				onStop={
					running && client && !viewOnly
						? () => client.cancelTurn(running.turnId)
						: null
				}
				usage={
					state.conversationId && (
						<ConversationUsageRing
							key={state.conversationId}
							workspaceId={workspaceId}
							conversationId={state.conversationId}
							settledRunCount={
								state.turns.filter((turn) => turn.status !== "running").length
							}
						/>
					)
				}
			/>
		</WorkspaceChatDropZone>
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
	emptyText = "Ask about this workspace. The answer streams straight from it.",
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
	emptyText?: string;
	turns: ChatTurn[];
	models: ReadonlyArray<{ id: string; label: string }>;
	/** Sent while the agent works; it has not read them yet. */
	queued: WorkspaceChatState["queued"];
	pendingSend: { clientTurnId: string; text: string; sentAt: number } | null;
	catchingUp: boolean;
	hasEarlier: boolean;
	onLoadEarlier: () => void;
	onDecide: DecideApproval;
	onApproveAll: ApproveAll;
	/** Resumes after the last turn; `null` while another turn is busy. */
	onContinue: (() => void) | null;
	/** Sends a failed or stopped turn's own message again; `null` while busy. */
	onRetry: RetryTurn | null;
}) {
	const tediNames = useTediNames();
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
				<LoadingArea
					className="min-h-40 flex-1"
					label="Loading the conversation"
				/>
			) : null}
			{turns.length === 0 && !pendingSend && !catchingUp ? (
				<div className="workspace-chat-empty">
					<Text role="body" tone="secondary">
						{emptyText}
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
					tediNames={tediNames}
				/>
			))}
			<QueuedMessages messages={queued} tediNames={tediNames} />
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
	tediNames,
	modelLabel,
	latest,
	onDecide,
	onApproveAll,
	onContinue,
	onRetry,
}: {
	workspaceId: string;
	turn: ChatTurn;
	tediNames: Record<string, string>;
	/** The catalog name of the model that answered, else its id. */
	modelLabel: string | undefined;
	/** The newest turn of the thread. */
	latest: boolean;
	onDecide: DecideApproval;
	onApproveAll: ApproveAll;
	onContinue: (() => void) | null;
	onRetry: RetryTurn | null;
}) {
	const running = turn.status === "running";
	const startedAt = Date.parse(turn.startedAt);
	const waiting = turn.approvals.find((approval) => approval.decision === null);
	const agentRuns = new Map(
		turn.steps.flatMap((step) => {
			if (step.tool !== "work.startRun" || step.status !== "ok") return [];
			const run = agentRunFromToolResult(step.result);
			return run ? [[run.workItemId, run] as const] : [];
		}),
	);
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
			{turn.handedFrom || turn.runReport ? (
				<Text role="caption" tone="secondary">
					{turn.text}
				</Text>
			) : turn.text ? (
				<>
					{turn.authorId ? (
						<WorkspaceChatAuthor
							id={turn.authorId}
							kind={turn.authorKind}
							tediNames={tediNames}
						/>
					) : null}
					<UserBubble text={turn.text} />
					{turn.fromAppId ? (
						<AskedFromApp workspaceId={workspaceId} appId={turn.fromAppId} />
					) : null}
				</>
			) : null}
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
			<AddedMessages messages={turn.added} tediNames={tediNames} />
			<div className="workspace-chat-reply" key={turn.replyKey}>
				{turn.respondingTediId ? (
					<WorkspaceChatAuthor
						id={turn.respondingTediId}
						kind="tedi"
						tediNames={tediNames}
					/>
				) : null}
				{turn.answererNote ? (
					<Text role="caption" tone="secondary">
						{turn.answererNote}
					</Text>
				) : null}
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
						{turn.plainNotice ? (
							<p>{turn.reply}</p>
						) : (
							<ChatMarkdown content={turn.reply} />
						)}
					</div>
				) : null}
				{turn.reply && turn.replyDone ? (
					<ReplyCopy text={turn.reply} latest={latest} />
				) : null}
				{turn.agentRunAsk ? (
					<ul
						className="m-0 grid list-none gap-2 p-0"
						aria-label="Run question"
					>
						<AgentRunCard agentRun={turn.agentRunAsk} />
					</ul>
				) : null}
				{agentRuns.size > 0 ? (
					<ul className="m-0 grid list-none gap-2 p-0" aria-label="Coding runs">
						{[...agentRuns.values()].map((run) => (
							<AgentRunCard key={run.workItemId} agentRun={run} />
						))}
					</ul>
				) : null}
				{turn.connectionRequests?.map((request) => (
					<ConnectionRequestCard request={request} key={request.requestId} />
				))}
				{turn.tediApprovals?.map((request) => (
					<TediApprovalCard request={request} key={request.approvalId} />
				))}
				{turn.schedules?.map((run) => (
					<RegisteredAppSchedule
						key={`${run.gadgetId}:${run.triggerId}`}
						workspaceId={workspaceId}
						{...run}
					/>
				))}
				{turn.views?.map((view) => (
					<div
						className="workspace-chat-view"
						data-testid="workspace-chat-view"
						key={view.viewId}
					>
						<Suspense
							fallback={<LoadingArea className="h-24" label="Opening view" />}
						>
							<WidgetFrame
								appSlug={view.appSlug}
								resourceUri={view.resourceUri}
								title={view.title}
								toolResult={view.toolResult}
								unavailable={
									<Text role="caption" tone="secondary">
										This view could not be loaded.
									</Text>
								}
							/>
						</Suspense>
					</div>
				))}
				{turn.status === "error" ? <TurnFailure error={turn.error} /> : null}
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

/** Why a reply failed, in one plain sentence; the recorded error on request. */
function TurnFailure({ error }: { error: string | undefined }) {
	const { message, detail } = turnFailure(error);
	return (
		<>
			<div className="workspace-chat-error" role="alert">
				<WarningCircle aria-hidden />
				<Text role="caption" tone="error">
					{message}
				</Text>
			</div>
			{detail ? (
				<Collapsible className="workspace-chat-approval-details">
					<CollapsibleDefaultTrigger>
						Technical details
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						<pre>{detail}</pre>
					</CollapsibleDefaultContent>
				</Collapsible>
			) : null}
		</>
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

/** Under a message an app sent for the person: which app it came from. */
function AskedFromApp({
	workspaceId,
	appId,
}: {
	workspaceId: string;
	appId: string;
}) {
	const apps = useQuery(canvasGadgetsQueryOptions(workspaceId));
	const name = apps.data?.items.find((app) => app.id === appId)?.name;
	return (
		<div
			className="workspace-chat-user"
			data-testid="workspace-chat-asked-from"
		>
			<Text role="caption" tone="secondary">
				Asked from {name ?? "a workspace app"}
			</Text>
		</div>
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
	if (approval.automatic) return "Applying…";
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
	if (Array.isArray(input.ops)) {
		const hidden = input.ops.length - 6;
		const shown = input.ops
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
		return hidden > 0
			? `${shown}\n… and ${hidden} more ${hidden === 1 ? "operation" : "operations"} not shown`
			: shown;
	}
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
	// A new app: what it is for, the workspace files it may read, then the
	// files it starts with. An existing app asking to read files names them.
	const mayRead = Array.isArray(input.mayRead)
		? input.mayRead.filter((title) => typeof title === "string")
		: [];
	const reads = mayRead.length ? `May read: ${mayRead.join(", ")}` : "";
	const files = objectValue(input.files);
	if (files)
		return [
			typeof input.description === "string" ? input.description : "",
			reads,
			`Files: ${Object.keys(files).join(", ")}`,
		]
			.filter(Boolean)
			.join("\n\n")
			.slice(0, 2_000);
	if (reads) return reads.slice(0, 2_000);
	if (typeof input.description === "string")
		return input.description.slice(0, 2_000);
	return "";
}

/** `likeThis` also approves the same kind of action for the rest of that turn. */
type DecideApproval = (
	approvalId: string,
	decision: "approve" | "deny",
	options?: { likeThis?: boolean },
) => void;

/** The decision and the action's recorded result remain separate. */
function ApprovalCard({
	approval,
	workspaceId,
	onDecide,
	approving,
}: {
	approval: ChatApproval;
	workspaceId: string;
	onDecide: DecideApproval;
	/** Approved together with the rest of its reply; the decision is on its way. */
	approving: boolean;
}) {
	const [own, setSent] = useState<"approve" | "deny" | null>(null);
	const sent = own ?? (approving ? "approve" : null);
	const decided = approval.decision ?? sent;
	const input = objectValue(approval.input);
	const target = approvalTarget(approval);
	const appEdit = appEditRequestFrom(approval.input);
	const preview = appEdit ? "" : approvalPreview(input);
	const status = approvalStatus(approval);
	const failed = approval.execution?.status === "failed";
	const subject = approvalSubject(approval);
	const page = webPageRequest(approval);
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
			{approval.execution?.status === "applied" && approval.execution.app ? (
				<div className="workspace-chat-approval-actions">
					<OpenCreatedApp
						workspaceId={workspaceId}
						appId={approval.execution.app.appId}
						name={approval.execution.app.name}
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
					{approval.approveAllInTurn ? (
						<Button
							aria-label={`Approve ${subject} and all like it in this turn`}
							disabled={decided !== null}
							onClick={() => {
								setSent("approve");
								onDecide(approval.approvalId, "approve", { likeThis: true });
							}}
							size="sm"
							title="Also approves the same kind of action for the rest of this reply. The next message asks again."
							variant="outline"
						>
							Approve all like this in this turn
						</Button>
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
	pinnedTediId,
	slot,
	placeholder = "Ask this workspace…",
	onSend,
	disabledReason,
	autoFocus,
	busy,
	onStop,
	modelControl,
	usage,
}: {
	/** The tedi that answers every message; the composer then offers no choice. */
	pinnedTediId: string | null;
	slot?: ReactNode;
	placeholder?: string;
	/** This conversation's usage ring, beside the model control. */
	usage?: ReactNode;
	workspaceId: string;
	onBrowseResources?: () => void;
	/** `answerer` is a tedi id, the workspace agent, or absent for the default. */
	onSend: (
		text: string,
		attachments?: Array<{ outputId: string }>,
		answerer?: string,
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
		conversationId: string | null;
	} | null>(null);
	// An unsent message survives a reload and a switch to another conversation.
	const draftConversationId = client?.getConversationId() ?? null;
	const [draft, setDraftText] = useState(() =>
		readWorkspaceChatDraft(workspaceId, draftConversationId),
	);
	const [pickedTediId, setPickedTediId] = useState<string | null>(null);
	const tedis = useQuery({
		...tediRosterQueryOptions(100, { status: "active" }),
		enabled: disabledReason === null && !pinnedTediId,
		staleTime: 60_000,
	});
	const workspaceDetail = useQuery({
		...workspaceDetailQueryOptions(workspaceId),
		enabled: disabledReason === null && !pinnedTediId,
		staleTime: 60_000,
	});
	const defaultTediId = workspaceDetail.data?.workspace.defaultTediId ?? null;
	const listed = tedis.data?.data ?? [];
	// The roster is one page; a default tedi outside it is read by its id, so
	// the picker names the tedi that actually answers.
	const defaultTediRead = useQuery({
		...tediDetailQueryOptions(defaultTediId ?? ""),
		enabled:
			defaultTediId !== null &&
			tedis.isSuccess &&
			!listed.some((tedi) => tedi.id === defaultTediId),
		staleTime: 60_000,
	});
	const roster =
		defaultTediRead.data && !listed.some((tedi) => tedi.id === defaultTediId)
			? [...listed, defaultTediRead.data]
			: listed;
	// A personal tedi's owner is recorded under the sign-in id, the one the
	// presence read returns, never the account profile's id.
	const presence = useQuery({
		...workspacePresenceQueryOptions(workspaceId),
		enabled:
			disabledReason === null &&
			roster.some((tedi) => tedi.scope === "personal"),
	});
	const ownerId = presence.data?.userId;
	const recipients = roster
		.filter((tedi) => mayPickWorkspaceTedi(tedi, ownerId))
		.map((tedi) => ({ id: tedi.id, name: tedi.displayName ?? tedi.name }));
	// Answers when nobody is picked; offered only when this person may pick it.
	const defaultTedi = recipients.find((tedi) => tedi.id === defaultTediId);
	const pickedTedi =
		pickedTediId === null
			? defaultTedi
			: recipients.find((tedi) => tedi.id === pickedTediId);
	const tediLabel = (tedi: { id: string; name: string }) =>
		tedi.id === defaultTedi?.id
			? `${tedi.name} (workspace default)`
			: tedi.name;
	const mention = /(?:^|\s)@([^\s@]*)$/u.exec(draft)?.[1];
	const mentionOptions =
		mention !== undefined
			? recipients
					.filter((tedi) =>
						tedi.name.toLowerCase().startsWith(mention.toLowerCase()),
					)
					.slice(0, 6)
			: [];
	const [mentionDismissed, setMentionDismissed] = useState(false);
	const setDraft = (next: string | ((text: string) => string)) =>
		setDraftText((text) => {
			const value = typeof next === "function" ? next(text) : next;
			writeWorkspaceChatDraft(workspaceId, draftConversationId, value);
			return value;
		});
	const [selected, setSelected] = useState<
		Array<{ outputId: string; title: string }>
	>([]);
	// Files dropped on the chat or pasted here are saved to the workspace, then
	// join the files picked from it.
	const uploads = useWorkspaceChatUploads({
		workspaceId,
		attachedCount: selected.length,
		onAttached: (file) =>
			setSelected((files) =>
				files.some((item) => item.outputId === file.outputId) ||
				files.length >= CHAT_FILE_LIMIT
					? files
					: [...files, file],
			),
	});
	useWorkspaceChatFileDrop(
		disabledReason === null
			? { onFiles: uploads.addFiles, full: uploads.full }
			: null,
	);
	const previousDraft = useRef({ workspaceId, draftConversationId });
	useEffect(() => {
		const previous = previousDraft.current;
		previousDraft.current = { workspaceId, draftConversationId };
		if (
			previous.workspaceId === workspaceId &&
			previous.draftConversationId === draftConversationId
		)
			return;
		// A new conversation gets its id with the first message. That is the
		// same conversation, so what is typed and attached stays.
		if (
			previous.workspaceId === workspaceId &&
			previous.draftConversationId === null
		) {
			setDraftText((text) => {
				writeWorkspaceChatDraft(workspaceId, draftConversationId, text);
				return text;
			});
			return;
		}
		setSelected([]);
		setPickedTediId(null);
		uploads.clear();
		setDraftText(readWorkspaceChatDraft(workspaceId, draftConversationId));
		setSubmitted(null);
	}, [draftConversationId, workspaceId]);
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
			// The first message names the conversation, which moves the draft.
			writeWorkspaceChatDraft(workspaceId, submitted.conversationId, "");
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
	// Text another pane hands over (an app's errors) goes after what is
	// typed. It is not sent: the person reads it, changes it and sends it.
	useEffect(
		() =>
			receiveWorkspaceChatDrafts(workspaceId, (text) => {
				setDraftText((current) => {
					const value = current.trim() ? `${current}\n\n${text}` : text;
					writeWorkspaceChatDraft(workspaceId, draftConversationId, value);
					return value;
				});
				textarea.current?.focus();
			}),
		[workspaceId, draftConversationId],
	);
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (disabledReason || submitted || uploads.busy || !draft.trim()) return;
		const mentioned = mentionedPeople(
			draft,
			recipients.map(({ id, name }) => [id, name]),
		);
		const id = onSend(
			draft,
			selected.map(({ outputId }) => ({ outputId })),
			mentioned.length === 1
				? mentioned[0]
				: pickedTediId === WORKSPACE_AGENT
					? WORKSPACE_AGENT
					: // Nobody picked: the store applies the workspace default.
						pickedTediId
						? pickedTedi?.id
						: undefined,
		);
		if (id) returnedMessages.sent(id);
		if (id)
			setSubmitted({
				id,
				text: draft,
				files: selected.map((file) => file.outputId),
				conversationId: draftConversationId,
			});
	};
	// A bare `/` token opens the same bounded skill picker Home chat has. A
	// pick writes the canonical `/skill <slug>` line into the message; the
	// workspace object loads that skill for the turn.
	const skillTrigger = draftPickerTrigger(draft);
	const [skillDismissed, setSkillDismissed] = useState(false);
	const [skillActiveIndex, setSkillActiveIndex] = useState(-1);
	const skillListboxId = useId();
	// Archived skills and improvement copies are dropped on the server; a
	// large catalog otherwise fills the bounded page with skills the picker
	// never offers, and `/` shows nothing.
	const skillCatalog = useQuery({
		...skillCatalogQueryOptions({
			limit: SKILL_CATALOG_LIMIT,
			excludeArchived: true,
			excludeImprovements: true,
		}),
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
		if (
			event.key === "Escape" &&
			!mentionDismissed &&
			mentionOptions.length &&
			!isImeComposing(event)
		) {
			event.preventDefault();
			setMentionDismissed(true);
			return;
		}
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
				<WorkspaceChatComposerFiles
					workspaceId={workspaceId}
					files={selected}
					uploads={uploads.uploads}
					notice={uploads.notice}
					onRemove={(outputId) =>
						setSelected((files) =>
							files.filter((item) => item.outputId !== outputId),
						)
					}
					onRemoveUpload={uploads.remove}
				/>
				{mention !== undefined &&
				!mentionDismissed &&
				disabledReason === null &&
				mentionOptions.length > 0 ? (
					<div
						className="flex flex-wrap gap-1"
						aria-label="Mention a tedi"
						role="group"
					>
						{mentionOptions.map((tedi) => (
							<Button
								key={tedi.id}
								type="button"
								size="xs"
								variant="ghost"
								onClick={() => {
									setDraft(
										`${draft.slice(0, draft.length - mention.length)}${tedi.name} `,
									);
									setPickedTediId(tedi.id);
									textarea.current?.focus();
								}}
							>
								{tedi.name}
							</Button>
						))}
					</div>
				) : null}
				<Textarea
					aria-label="Message the workspace"
					className="workspace-chat-composer-input"
					disabled={disabledReason !== null}
					onChange={(event) => {
						setMentionDismissed(false);
						setDraft(event.target.value);
					}}
					onKeyDown={onKeyDown}
					onPaste={(event) => {
						const files = pastedFiles(event);
						if (files.length === 0) return;
						event.preventDefault();
						uploads.addFiles(files);
					}}
					placeholder={
						disabledReason ??
						(busy ? "Add to what the agent is working on…" : placeholder)
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
							messageBox={textarea}
							selectedIds={selected.map((file) => file.outputId)}
							onUploadFiles={uploads.addFiles}
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
					<div className="workspace-chat-model">
						{slot}
						{/* A pinned tedi answers every message; its own label is the slot.
						The roster can still come from another screen's cache. */}
						{!pinnedTediId &&
						recipients.length > 0 &&
						disabledReason === null ? (
							<Select
								value={pickedTedi?.id ?? ""}
								onValueChange={(id) => setPickedTediId(id || WORKSPACE_AGENT)}
								disabled={client === null}
							>
								<SelectTrigger
									aria-label="Replying agent"
									className="workspace-chat-model-trigger"
									size="sm"
								>
									<SelectValue>
										{pickedTedi ? tediLabel(pickedTedi) : "Workspace agent"}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="">Workspace agent</SelectItem>
									{recipients.map((tedi) => (
										<SelectItem key={tedi.id} value={tedi.id}>
											{tediLabel(tedi)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null}
						{state.approvalMode && disabledReason === null ? (
							<ApprovalModePicker
								state={state.approvalMode}
								onChange={(mode) => client?.setApprovalMode(mode)}
								disabled={client === null}
							/>
						) : null}
						{modelControl}
						{usage}
					</div>
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
							disabledReason !== null ||
							submitted !== null ||
							uploads.busy ||
							!draft.trim()
						}
						size="icon-sm"
						type="submit"
					>
						<PaperPlaneRight aria-hidden />
					</Button>
				</div>
			</div>
		</form>
	);
}
