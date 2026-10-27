import "./canvas-page.css";
import { buildAppEditTools } from "@/components/app-edit-webmcp-tools";
import { WorkspaceChatPageTools } from "@/lib/workspace-chat-page-tools";
import { usePushConversation } from "@/lib/use-push-conversation";
import {
	CHAT_CREATE_OPTIONS,
	CHAT_FORMATS,
	chatSlashCommands,
	chatComposerPlaceholder,
} from "@/components/chat-composer-options";
import { isHomeRouteRetryable } from "@tedix/api-contract/utils/home-route-retry";
import {
	isLocalAiUnavailable,
	isLocalWorkersAi,
	LOCAL_AI_UNAVAILABLE,
} from "@/lib/local-inference";
import {
	ArrowUp,
	File,
	MagnifyingGlass,
	Microphone,
	Plus,
	Paperclip,
	Sparkle,
	Square,
	X,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EnqueueHomeMessageInputSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import type { HomeMessage } from "@tedix/api-contract/schemas/kernel-runtime";
import type { KeyboardEvent } from "react";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isImeComposing } from "@/lib/keyboard";
import {
	appendVoiceTranscript,
	useComposerDictation,
} from "@/lib/use-composer-dictation";
import {
	VOICE_WAVE_BAR_COUNT,
	voiceWaveBarHeight,
} from "@tedix/chat-transport/voice-composer";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Collapsible, CollapsibleContent } from "@/components/kumo/collapsible";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import { ConversationCapabilityPalette } from "@/components/conversation-capability-palette";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Textarea } from "@/components/kumo/textarea";
import { osApi, osChatReadApi, osDirectReadApi } from "@/lib/api";
import { observeScrollResize } from "@tedix/chat-transport/composer-semantics";
import {
	ApprovalCard,
	approvalsFromRunSet,
	approvalsForAuthority,
	DelegationSummaryRow,
	mergeToolEvents,
	pruneDepartedRunFrames,
	isStoppableRunStatus,
	RunControls,
	sortToolStates,
	TOOL_EVENT_KINDS,
	WorkTraceCard,
} from "@/components/chat-cards";
import {
	StreamedAssistantBubble,
	StreamedPhaseRow,
	StreamedRationaleRow,
} from "@/components/chat-streaming";
import { isNearBottom } from "@tedix/chat-transport/composer-semantics";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { visibleOverlays } from "@/lib/overlay-state";
import { errorMessage } from "@/lib/orpc-error";
import {
	emptyProvisionalSends,
	hasProvisionalSend,
	isUnknownSendOutcome,
	listProvisionalSends,
	type ProvisionalSendAction,
	type ProvisionalSendMap,
	provisionalSendMessageId,
	reduceProvisionalSends,
	takeCarriedProvisionalFirstTurn,
} from "@/lib/provisional-send";
import {
	type ChatTransportActions,
	useChatTransport,
} from "@/lib/use-capn-chat";
import { WorkspaceFileUpload } from "./workspace-file-upload";
import { LiveDelegationCard } from "@/components/delegation-live-card";
import { useActiveTedis, useTediNames } from "@/lib/use-tedi-names";
import type { ConversationStreamStatus } from "@/lib/conversation-stream";
import { useRealtimeStatus, useRealtimeSurface } from "@/lib/use-realtime";
import {
	homeMessagesQueryKey,
	homeMessagesQueryOptions,
	homeRunSetQueryKey,
	homeRunSteeringQueryOptions,
	modelCatalogQueryOptions,
	operationalContextQueryOptions,
	osQueryKeys,
	osQuery,
	SKILL_CATALOG_LIMIT,
	skillCatalogQueryOptions,
} from "@/lib/os-query-options";
import { initialModelRef, modelsForNewSelection } from "@/lib/model-selection";
import { assistantLinkedOutputIds } from "@/lib/output-navigation";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type ComposerAttachment,
	attachmentType,
	composerImageRefusal,
	readComposerAttachment,
} from "@/components/chat-attachments";
import { ContextUsedInspector } from "@/components/chat-context-used";
import { ChatModelPicker } from "@/components/chat-model-picker";
import { DirectReadPanel } from "@/components/chat-direct-read-composer";
import { ConversationUsageLine } from "@/components/chat-usage-line";
import {
	type DirectReadCommand,
	type DirectReadRequest,
	parseDirectReadCommand,
	readOnlyToolCatalogQueryOptions,
} from "@/components/chat-direct-read";
import {
	ApprovalInputGate,
	ChatMessageBubble,
	ChatMessageWidgets,
	ChatStarterPrompts,
	ConversationCostChip,
	JumpToLatestControl,
	ProvisionalUserBubble,
	RunningIndicator,
	SendFailureBanner,
} from "@/components/chat-message-parts";
import {
	type FirstSendInFlight,
	MESSAGES_PAGE_LIMIT,
	RUN_POLL_INTERVAL_MS,
	controllableRun,
	firstSendConfirmPollMs,
	shouldPollTranscript,
	shouldShowRunningIndicator,
	transientTranscriptRetryMs,
	useIsRunActive,
} from "@/components/chat-polling";
import {
	ACTIVE_RUN_STATUSES,
	type ChatContext,
	HYDRATE_RUN_EVENTS_TAIL,
	activeDelegations,
	appendHydrateEvents,
	finishedDelegationsByMessage,
	applyDelegatedRunPreviews,
	chatDraftKey,
	conversationIdForSend,
	encodeChatContext,
	executionLinkMessageIds,
	invalidateHomeTranscript,
	invalidateOnFocus,
	isBlockingApprovalCard,
	mergeHomeMessages,
	needsDelegationChoice,
	newHomeConversationId,
	nextIdempotencyKey,
	nextSessionAutoApproval,
	reconcileApprovalsAfterReconnect,
	restoreChatDraft,
	shouldHydrateRun,
	shouldReconcileApprovalsOnStreamOpen,
	userMessageFromEnqueue,
} from "@/components/chat-transcript";

type RecoverableChatSend = Parameters<
	ChatTransportActions["enqueueMessage"]
>[0] & {
	conversationId: string;
	draftContent: string;
};

const FIRST_SEND_PENDING_MS = 15_000;
const RECOVERED_SEND_NOTICE =
	"Confirmation is taking longer than expected. Check status or retry the saved message.";

function readRecoverableChatSend(key: string): RecoverableChatSend | null {
	try {
		const requests = JSON.parse(window.localStorage.getItem(key) ?? "[]");
		const value = Array.isArray(requests) ? requests.at(-1) : null;
		if (
			!value ||
			typeof value.draftContent !== "string" ||
			typeof value.conversationId !== "string" ||
			typeof value.idempotencyKey !== "string" ||
			!EnqueueHomeMessageInputSchema.safeParse(value).success
		)
			return null;
		return value;
	} catch {
		return null;
	}
}

function saveRecoverableChatSend(
	key: string,
	request: RecoverableChatSend | null,
	settledKey?: string,
) {
	try {
		const stored = JSON.parse(window.localStorage.getItem(key) ?? "[]");
		const requests = Array.isArray(stored)
			? stored.filter(
					(candidate) =>
						candidate?.idempotencyKey !==
						(request?.idempotencyKey ?? settledKey),
				)
			: [];
		if (request) requests.push(request);
		if (requests.length)
			window.localStorage.setItem(key, JSON.stringify(requests));
		else window.localStorage.removeItem(key);
	} catch {
		// Storage denial must not prevent sending or confirming a durable turn.
	}
}

export function ChatThread({
	conversationId,
	onConversationCreated,
	onSendStarted,
	context,
	workspaceId,
	composerOnly = false,
	recoverPendingSend = false,
	autoFocusComposer = false,
	onSendMessageReady,
	onOutputCreated,
	detailsActions,
	detailsOpen = false,
}: {
	/** `null` = fresh conversation not yet created; the first send creates it. */
	conversationId: string | null;
	/** Reveal the transcript without replacing this thread's pending send state. */
	onSendStarted?: () => void;
	onConversationCreated?: (
		conversationId: string,
		workspaceId?: string,
	) => void;
	context?: ChatContext;
	/** Canonical host Workspace; required for durable Workspace conversation association. */
	workspaceId?: string;
	/**
	 * Render only the composer beneath the conversation list. The first send
	 * creates the conversation through the same path as the full thread.
	 */
	composerOnly?: boolean;
	/** Restore on page entry; an explicit New action starts a fresh composer. */
	recoverPendingSend?: boolean;
	/**
	 * Focus the composer when the thread mounts or changes conversation. The
	 * Workspace's chat-first layout sets it so the first-send navigation from
	 * `/chat` (a new route tree, so a new composer) lands with the caret where
	 * the user just was.
	 */
	autoFocusComposer?: boolean;
	/** Lets an adjacent user-facing control enqueue a message through this chat. */
	onSendMessageReady?: (send: (content: string) => void) => void;
	/**
	 * An assistant message that arrived while this thread was open links an
	 * output (`/outputs/<id>`), typically the receipt of a create. History
	 * loaded on open or by "Load earlier" never fires it.
	 */
	onOutputCreated?: (outputId: string) => void;
	/** Conversation-level actions shown in the "Chat details" panel. */
	detailsActions?: ReactNode;
	/** The header's "Chat details" icon button owns this toggle. */
	detailsOpen?: boolean;
}) {
	const pushVisibilityRef = usePushConversation(
		composerOnly ? null : conversationId,
	);
	const queryClient = useQueryClient();
	const [pageTools] = useState(() => new WorkspaceChatPageTools());
	const tediNames = useTediNames();
	const activeTedis = useActiveTedis();
	// Null sends to Home, which routes the message itself. A picked tedi is
	// sent as an explicit delegation, like the embedded widget's switcher.
	const [selectedTediId, setSelectedTediId] = useState<string | null>(null);
	const selectedTediName = selectedTediId
		? (activeTedis.find((tedi) => tedi.id === selectedTediId)?.name ?? null)
		: null;
	const localAiUnavailable = isLocalAiUnavailable();
	const localWorkersAi = isLocalWorkersAi();

	// Idempotent message cache: keyed by message id, merged into ordered state.
	const cacheRef = useRef(new Map<string, HomeMessage>());
	// Which conversation the cache currently belongs to. Pre-set to the enqueue
	// echo when a fresh conversation is created so the prop flip keeps the cache.
	const cacheConversationRef = useRef<string | null>(conversationId);
	// A New thread has no route id until its first turn succeeds. Hold the id
	// across retries so failed first turns cannot create multiple conversations.
	const recoveryKey = `tedix-os:chat-bootstrap:${workspaceId ?? "home"}`;
	const [recoveredSend] = useState(() => {
		if (!recoverPendingSend) return null;
		const request = readRecoverableChatSend(recoveryKey);
		return request &&
			(conversationId === null || conversationId === request.conversationId)
			? request
			: null;
	});
	const recoveryRequestRef = useRef<RecoverableChatSend | null>(recoveredSend);
	const newConversationIdRef = useRef<string | null>(
		recoveredSend?.conversationId ?? null,
	);
	if (conversationId === null && newConversationIdRef.current === null) {
		newConversationIdRef.current = newHomeConversationId();
	}
	const sendTargetRef = useRef(conversationId ?? newConversationIdRef.current);
	sendTargetRef.current = conversationId ?? newConversationIdRef.current;
	const mountedRef = useRef(false);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const isCurrentSend = (target: string) =>
		mountedRef.current && sendTargetRef.current === target;
	const [messages, setMessages] = useState<HomeMessage[]>([]);
	// Output ids already linked when this conversation's transcript first
	// loaded (plus older pages). Null until that first load: anything linked
	// later arrived live and is announced through `onOutputCreated`.
	const knownOutputIdsRef = useRef<Set<string> | null>(null);
	const onOutputCreatedRef = useRef(onOutputCreated);
	onOutputCreatedRef.current = onOutputCreated;
	const [olderCursor, setOlderCursor] = useState<string | null>(null);
	const cursorInitializedRef = useRef(false);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [loadEarlierError, setLoadEarlierError] = useState<string | null>(null);

	const [pendingRunId, setPendingRunId] = useState<string | null>(null);
	// A brand-new thread's first send, while its enqueue is in flight. See
	// `firstSendConfirmPollMs`: the transcript is read under the minted id so
	// the turn shows as sent once its durable row exists, not at the response.
	const [firstSendInFlight, setFirstSendInFlight] =
		useState<FirstSendInFlight | null>(recoveredSend);
	const [notice, setNotice] = useState<string | null>(null);
	const [steeringError, setSteeringError] = useState<string | null>(null);
	const [sendError, setSendError] = useState<string | null>(
		recoveredSend ? RECOVERED_SEND_NOTICE : null,
	);
	const [sendErrorUnknown, setSendErrorUnknown] = useState(
		Boolean(recoveredSend),
	);
	// Held until the send settles successfully; a retry reuses the same key.
	const idempotencyKeyRef = useRef<string | null>(
		recoveredSend?.idempotencyKey ?? null,
	);
	const unknownBootstrapKeyRef = useRef<string | null>(
		recoveredSend?.idempotencyKey ?? null,
	);
	const directReadRetryRef = useRef<DirectReadRequest | null>(null);

	// Provisional turns reconcile by key. A saved bootstrap restores its unknown
	// overlay on reload; established-thread overlays remain ephemeral.
	const [provisional, setProvisional] = useState<ProvisionalSendMap>(() => {
		let initial = takeCarriedProvisionalFirstTurn(conversationId);
		if (recoveredSend) {
			initial = reduceProvisionalSends(initial, {
				type: "send",
				...recoveredSend,
				at: new Date().toISOString(),
			});
			initial = reduceProvisionalSends(initial, {
				type: "unknown",
				idempotencyKey: recoveredSend.idempotencyKey,
				error: RECOVERED_SEND_NOTICE,
			});
		}
		return initial;
	});
	const dispatchProvisional = useCallback((action: ProvisionalSendAction) => {
		setProvisional((current) => reduceProvisionalSends(current, action));
	}, []);

	const [draft, setDraft] = useState(() =>
		recoveredSend ? "" : restoreChatDraft(window.localStorage, conversationId),
	);
	const [includeContext, setIncludeContext] = useState(Boolean(context));
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
	const [preparingAttachments, setPreparingAttachments] = useState(false);
	const attachmentPickGeneration = useRef(0);
	const attachmentPreparationRef = useRef(false);
	const attachmentDragDepth = useRef(0);
	const [attachmentDragActive, setAttachmentDragActive] = useState(false);
	// Why the last pick refused an image, if it did. Cleared by the next pick,
	// by a model change, and on conversation switch.
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [directReadOpen, setDirectReadOpen] = useState(false);
	// Session approvals are memory-only, scoped to one exact
	// delegation target, and cleared on a full page/session reset.
	const alwaysApproveScopesRef = useRef(new Set<string>());
	const autoApprovalAttemptedRef = useRef(new Set<string>());
	const attachmentInputRef = useRef<HTMLInputElement | null>(null);
	const operationalContext = useQuery(operationalContextQueryOptions());
	const organizationId = operationalContext.data?.organization.id;
	const readOnlyCatalog = useQuery({
		...readOnlyToolCatalogQueryOptions(organizationId),
		enabled: directReadOpen,
	});
	const [selectedModelRef, setSelectedModelRef] = useState<string | null>(null);
	const modelCatalog = useQuery({
		...modelCatalogQueryOptions(),
		staleTime: 60_000,
	});
	const resolvableModels = useMemo(
		() => modelCatalog.data?.models.filter((model) => model.allowed) ?? [],
		[modelCatalog.data],
	);
	const selectableModels = useMemo(
		() => modelsForNewSelection(resolvableModels),
		[resolvableModels],
	);
	useEffect(() => {
		if (selectedModelRef || resolvableModels.length === 0) return;
		setSelectedModelRef(
			initialModelRef(resolvableModels, modelCatalog.data?.routing.modelRef),
		);
	}, [resolvableModels, modelCatalog.data, selectedModelRef]);
	const selectedModelLabel =
		resolvableModels.find((model) => model.ref === selectedModelRef)?.label ??
		selectedModelRef ??
		"The selected model";
	// Image capability gate. A MIME type says what the file is; it says nothing
	// about whether the model can read it, and the two were conflated here.
	//
	// `selectionPending` covers both halves of "not resolved YET": the query is
	// in flight, or it has landed with allowed models and the effect above has
	// not yet committed the pick. Everything else with a null ref is a resolved
	// nothing — an empty allow-list or a failed catalog — and says so.
	const modelSelectionPending =
		modelCatalog.isPending ||
		(selectedModelRef === null && resolvableModels.length > 0);
	const imageRefusal = localWorkersAi
		? "The local inference model is configured by the launcher. Its image support is not verified here; send text instead."
		: composerImageRefusal({
				models: resolvableModels,
				selectedRef: selectedModelRef,
				modelLabel: selectedModelLabel,
				selectionPending: modelSelectionPending,
			});
	// An image already attached when the operator switches to a model that
	// refuses it: the pick-time filter cannot have caught this one, so the send
	// is blocked with the same named reason rather than wedging the turn.
	const blockedByAttachedImage =
		imageRefusal !== null &&
		attachments.some((attachment) => attachment.type === "image");
	const composerAttachmentError = blockedByAttachedImage
		? imageRefusal
		: attachmentError;

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	// See `autoFocusComposer`: the caret follows the user across the first-send
	// route change from `/chat` into the Workspace.
	useEffect(() => {
		if (!autoFocusComposer) return;
		composerRef.current?.focus();
	}, [autoFocusComposer, conversationId]);
	// Distance from the bottom recorded before an older-page prepend; restored
	// in useLayoutEffect so the viewport does not jump.
	const prependAnchorRef = useRef<number | null>(null);
	const stickToBottomRef = useRef(true);
	// Mirror of stickToBottomRef that drives the "jump to latest" affordance;
	// setState with an unchanged value is a React no-op, so per-scroll updates
	// stay cheap.
	const [pinnedToBottom, setPinnedToBottom] = useState(true);

	// Reset all per-conversation state when the thread switches — unless the
	// "switch" is the prop catching up to the conversation this thread just
	// created via enqueue (cacheConversationRef was pre-set in onSuccess).
	useEffect(() => {
		if (cacheConversationRef.current === conversationId) return;
		cacheConversationRef.current = conversationId;
		// Leaving the synthetic New state starts the next New thread from a
		// distinct id. Keep it only while this same new thread is resolving.
		newConversationIdRef.current =
			conversationId === null ? newHomeConversationId() : null;
		sendTargetRef.current = conversationId ?? newConversationIdRef.current;
		setSelectedTediId(null);
		cacheRef.current = new Map();
		knownOutputIdsRef.current = null;
		cursorInitializedRef.current = false;
		stickToBottomRef.current = true;
		setPinnedToBottom(true);
		prependAnchorRef.current = null;
		idempotencyKeyRef.current = null;
		unknownBootstrapKeyRef.current = null;
		recoveryRequestRef.current = null;
		setFirstSendInFlight(null);
		setMessages([]);
		setOlderCursor(null);
		setLoadEarlierError(null);
		setPendingRunId(null);
		setNotice(null);
		setSteeringError(null);
		steeringRequestRef.current = null;
		setSendError(null);
		setSendErrorUnknown(false);
		setAttachmentError(null);
		// Ephemeral overlay only: the durable rows come back from `readMessages`
		attachmentPickGeneration.current += 1;
		attachmentPreparationRef.current = false;
		attachmentDragDepth.current = 0;
		setAttachmentDragActive(false);
		setAttachments([]);
		setPreparingAttachments(false);
		// and the draft comes back from localStorage below.
		setProvisional(emptyProvisionalSends());
		setDraft(restoreChatDraft(window.localStorage, conversationId));
	}, [conversationId]);

	// One event stream feeds the provisional overlay, the tool-card fold, and
	// durable-event invalidations. Canonical run-set reconciliation remains as a
	// low-frequency backstop for state changes outside that run-local stream.
	const toolFramesRef = useRef(new Map<string, RuntimeStreamEvent>());
	const [toolFrameCount, setToolFrameCount] = useState(0);
	// Runs ever observed active — the prune baseline for departed-run frames.
	const seenActiveRunIdsRef = useRef(new Set<string>());
	const streamSinceRef = useRef(Date.now());
	// L5 reload-mid-run restoration: active runs whose recent events were
	// already fetched (once per run), and the collected events handed to the
	// overlay hook as `hydrate`.
	const hydratedRunIdsRef = useRef(new Set<string>());
	const [hydrateEvents, setHydrateEvents] = useState<RuntimeStreamEvent[]>([]);
	// Durable events no longer invalidate from here. The global connection
	// manager's pump patches the run set and the transcript in place from the
	// same frames this hook folds into overlays (`use-realtime.ts`), so the
	// trailing throttle that existed to soften a broad invalidation is gone
	// with the broad invalidation.
	// The pump lease only; the reconnect signal below comes from this
	// conversation's own stream, never from the worst-first aggregate.
	useRealtimeSurface({ conversationId });
	useEffect(() => {
		toolFramesRef.current = new Map();
		setToolFrameCount(0);
		seenActiveRunIdsRef.current = new Set();
		hydratedRunIdsRef.current = new Set();
		setHydrateEvents([]);
	}, [conversationId]);

	// Degraded-mode polling: when the Cap'n Web stream cannot establish (WS
	// blocked, server regression, a dev origin with no `/capn`), the connection
	// manager flips `degraded` and accelerates the run-set reconciliation below
	// plus transcript refetch — live data keeps flowing, just on a cadence. A
	// slower run-set reconciliation remains armed while any run is active even
	// on a healthy stream, because child orphan settlement and other canonical
	// projection changes do not necessarily emit a parent-run frame. This is the
	// only event fallback: the SSE lane remains retired.
	const realtimeDegraded = useRealtimeStatus().degraded;

	const { isActive, activeRunIds, runSet } = useIsRunActive(
		conversationId,
		pendingRunId !== null,
		realtimeDegraded,
	);
	const pendingRun = controllableRun(runSet, pendingRunId);
	const steeringRunId =
		pendingRun &&
		(pendingRun.status === "queued" || pendingRun.status === "running")
			? pendingRun.id
			: null;
	const steeringTargetId =
		pendingRun?.id ??
		[...(runSet?.runs ?? [])].sort(
			(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
		)[0]?.id;
	const steering = useQuery({
		...homeRunSteeringQueryOptions(steeringTargetId ?? "", organizationId),
		enabled: steeringTargetId != null,
		refetchInterval: steeringRunId ? 1000 : false,
	});
	const queuedSteering =
		steering.data?.messages.filter((message) => message.status === "queued") ??
		[];
	const steeringRequestRef = useRef<{
		runId: string;
		content: string;
		idempotencyKey: string;
	} | null>(null);
	const steer = useMutation({
		mutationFn: async (input: {
			runId: string;
			content: string;
			idempotencyKey: string;
			conversationId: string;
		}) => {
			const result = await transportActions.steerRun({
				runId: input.runId,
				instruction: input.content,
				idempotencyKey: input.idempotencyKey,
			});
			const forward = result.run.metadata?.delegatedChildSteer as
				| { outcome?: string; error?: string }
				| undefined;
			if (forward?.outcome === "failed")
				throw new Error(
					forward.error ?? "The tedi did not accept the steering message.",
				);
			return result;
		},
		onSuccess: (_result, input) => {
			try {
				window.localStorage.removeItem(chatDraftKey(input.conversationId));
			} catch {
				/* Draft storage is optional. */
			}
			if (!isCurrentSend(input.conversationId)) return;
			setDraft("");
			steeringRequestRef.current = null;
			setSteeringError(null);
			void steering.refetch();
			void transcript.refetch();
		},
		onError: (error, input) => {
			if (isCurrentSend(input.conversationId))
				setSteeringError(
					errorMessage(
						error,
						"Could not queue the message. Your draft is kept; try again.",
					),
				);
		},
	});
	const approvalCards = useMemo(
		() =>
			approvalsForAuthority(
				runSet ? approvalsFromRunSet(runSet) : [],
				operationalContext.data?.authority,
			),
		[runSet, operationalContext.data?.authority],
	);
	const displayMessages = useMemo(
		() =>
			applyDelegatedRunPreviews(
				messages.filter(
					(message) =>
						!steering.data?.messages.some(
							(queued) =>
								queued.status !== "read" &&
								queued.id === message.metadata?.steeringId,
						),
				),
				runSet?.runs ?? [],
			),
		[messages, runSet, steering.data],
	);
	const executionLinks = useMemo(
		() => executionLinkMessageIds(displayMessages),
		[displayMessages],
	);
	const blockingApprovalCards = approvalCards.filter(isBlockingApprovalCard);

	// Live-card pruning: when a run leaves the active set its tool frames are
	// dropped — durable evidence lives in the transcript and run detail, so a
	// long-lived tab never accumulates stale cards below fresh messages.
	useEffect(() => {
		if (runSet === undefined) return;
		const changed = pruneDepartedRunFrames(
			toolFramesRef.current,
			seenActiveRunIdsRef.current,
			activeRunIds,
		);
		if (changed) setToolFrameCount(toolFramesRef.current.size);
	}, [runSet, activeRunIds]);

	// Reload-mid-run restoration: when the run set reports active runs on
	// mount or after a conversation switch, fetch each run's recent durable
	// events once (hydrate-once guard) and feed them to the overlay hook —
	// a hard reload during generation shows the partial assistant text
	// immediately while the live stream (since-cutoff-exempt via
	// `activeRunIds`) continues the remainder of the turn.
	useEffect(() => {
		if (conversationId === null || activeRunIds.length === 0) return;
		const toHydrate = activeRunIds.filter((runId) =>
			shouldHydrateRun(hydratedRunIdsRef.current, runId),
		);
		if (toHydrate.length === 0) return;
		const hydratedFor = conversationId;
		void Promise.all(
			toHydrate.map(async (runId) => {
				try {
					const output = await osChatReadApi.kernelRuntime.readRunEvents({
						runId,
						tail: HYDRATE_RUN_EVENTS_TAIL,
					});
					return output.events;
				} catch {
					// Non-fatal: live frames still arrive; un-mark so a later
					// run-set refresh may retry this run's hydration.
					hydratedRunIdsRef.current.delete(runId);
					return [];
				}
			}),
		).then((eventLists) => {
			// The conversation switched while the fetch was in flight — the
			// per-conversation reset already cleared the hydrate state.
			if (cacheConversationRef.current !== hydratedFor) return;
			const events = eventLists.flat();
			if (events.length === 0) return;
			setHydrateEvents((previous) => appendHydrateEvents(previous, events));
		});
	}, [conversationId, activeRunIds]);

	// Transport seam: the Cap'n Web projection — overlays
	// plus canonical-verb actions, with mutations falling back to the identical
	// oRPC calls whenever the socket is down.
	const {
		overlays,
		status: conversationStreamStatus,
		actions: transportActions,
		heldSendKeys,
		recordRendered,
	} = useChatTransport(conversationId, {
		// Both live and hydrated frames land here (source: "live" | "hydrate")
		// and fold into the same id-keyed tool-card map — re-delivery across
		// sources is a plain overwrite, never a duplicate card.
		onFrame: (event) => {
			void pageTools.handle(event, (input) =>
				transportActions.resolvePageTool(input),
			);
			if (!TOOL_EVENT_KINDS.has(event.kind)) return;
			toolFramesRef.current.set(event.id, event);
			setToolFrameCount(toolFramesRef.current.size);
		},
		since: streamSinceRef.current,
		// Historical events of active runs, applied once (idempotent with any
		// re-delivered stream frames).
		hydrate: hydrateEvents,
		// In-flight runs bypass the `since` storm-guard cutoff so a reload
		// mid-run streams the remainder of the turn.
		activeRunIds,
	});

	// Render latency: `terminal_received` fires when the finalize frame lands,
	// but the reader is still looking at the streaming overlay until the durable
	// row replaces it. Reporting from here — the only place that knows a durable
	// assistant row is on screen — closes the last unmeasured leg of a turn and
	// completes the vocabulary the embedded lane already emits in full.
	//
	// Deliberately not inside `visibleOverlays`: that is a pure filter called
	// during render, and telemetry there would fire on every unrelated commit.
	// The correlation store dedupes per run, so this effect may run freely.
	useEffect(() => {
		for (const message of displayMessages) {
			if (message.role !== "assistant" || !message.runId) continue;
			if (message.status === "pending" || message.status === "streaming")
				continue;
			recordRendered(message.runId);
		}
	}, [displayMessages, recordRendered]);

	// Reconnect reconciliation: a resolution that landed while this connection
	// was down is not on the resumed stream, so a card still rendered pending
	// when the lane comes back re-reads the run set once. See
	// `reconcileApprovalsAfterReconnect` for why this is bounded to that one
	// query and skipped when nothing is pending.
	//
	// It reads this conversation'S stream status, not the shell's aggregate.
	// `useRealtimeSurface().status` is worst-first across every live entry, so
	// one unrelated capability sitting in `connecting` holds the aggregate off
	// `open` and the reconnect transition this effect waits for never fires —
	// leaving the stale approval card the reconcile exists to refresh. The
	// transport hook already owns the per-conversation lease and publishes its
	// exact status, which is the one that describes the cards on screen.
	const previousRealtimeStatusRef = useRef<ConversationStreamStatus>("idle");
	// Read inside the effect so the reconcile sees the current cards without
	// re-running on every run-set refresh.
	const approvalCardsRef = useRef(approvalCards);
	approvalCardsRef.current = approvalCards;
	useEffect(() => {
		const previous = previousRealtimeStatusRef.current;
		previousRealtimeStatusRef.current = conversationStreamStatus;
		if (
			!shouldReconcileApprovalsOnStreamOpen(previous, conversationStreamStatus)
		)
			return;
		reconcileApprovalsAfterReconnect(
			queryClient,
			conversationId,
			approvalCardsRef.current,
		);
	}, [conversationStreamStatus, conversationId, queryClient]);

	// Focus convergence: a window-focus listener invalidates the run set and
	// newest transcript slice (see `invalidateOnFocus` for why a listener over
	// `refetchOnWindowFocus: "always"`). Multi-tab convergence follows from
	// the idempotent id-keyed caches + this focus revalidation.
	useEffect(() => {
		const onFocus = () => invalidateOnFocus(queryClient, conversationId);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [queryClient, conversationId]);

	const [approvalError, setApprovalError] = useState<string | null>(null);
	const respondApproval = useMutation({
		mutationFn: (input: {
			runId: string;
			decision: "approve" | "reject";
			delegateRecommendation?: boolean;
		}) => transportActions.respondApproval(input),
		onMutate: () => setApprovalError(null),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
			queryClient.invalidateQueries({
				queryKey: homeMessagesQueryKey(conversationId),
			});
			// An approved write may have renamed or edited the workspace or an
			// output open beside the chat.
			queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() });
			queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
		},
		onError: (error) => {
			setApprovalError(
				errorMessage(
					error,
					"The approval could not be recorded. The card is still pending; try again.",
				),
			);
			void queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
		},
	});
	const alwaysApprove = useCallback(
		(approvalId: string, scopeKey: string) => {
			const card = approvalCards.find(
				(candidate) => candidate.approvalId === approvalId,
			);
			if (!card || respondApproval.isPending) return;
			alwaysApproveScopesRef.current.add(scopeKey);
			autoApprovalAttemptedRef.current.add(approvalId);
			respondApproval.mutate({ runId: card.runId, decision: "approve" });
		},
		[approvalCards, respondApproval],
	);
	useEffect(() => {
		const liveIds = new Set(approvalCards.map((card) => card.approvalId));
		for (const approvalId of autoApprovalAttemptedRef.current) {
			if (!liveIds.has(approvalId)) {
				autoApprovalAttemptedRef.current.delete(approvalId);
			}
		}
		if (respondApproval.isPending) return;
		const card = nextSessionAutoApproval(
			approvalCards,
			alwaysApproveScopesRef.current,
			autoApprovalAttemptedRef.current,
		);
		if (!card) return;
		autoApprovalAttemptedRef.current.add(card.approvalId);
		respondApproval.mutate({ runId: card.runId, decision: "approve" });
	}, [approvalCards, respondApproval]);
	const withdrawSteering = useMutation({
		mutationFn: async (input: { runId: string }) => {
			const target = conversationId;
			const { messages: withdrawn } = await transportActions.withdrawSteering(
				input.runId,
			);
			if (target && withdrawn.length) {
				const restore = (current: string) => {
					const restored = [
						...withdrawn.map((message) => message.content),
						current,
					]
						.filter(Boolean)
						.join("\n\n");
					try {
						window.localStorage.setItem(chatDraftKey(target), restored);
					} catch {
						/* Draft storage is optional. */
					}
					return restored;
				};
				if (isCurrentSend(target)) {
					setDraft(restore);
					void steering.refetch();
				} else restore(restoreChatDraft(window.localStorage, target));
			}
			if (steeringRequestRef.current?.runId === input.runId)
				steeringRequestRef.current = null;
		},
		onError: (error) =>
			setSteeringError(
				errorMessage(error, "Could not return queued messages. Try again."),
			),
	});
	const cancelRun = useMutation({
		mutationFn: async (input: { runId: string }) => {
			await withdrawSteering.mutateAsync(input);
			return transportActions.cancelRun(input);
		},
		onError: (error) =>
			setSteeringError(
				errorMessage(error, "Could not stop this run. Try again."),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
		},
	});
	// A stalled delegation is stopped first: only a stopped or failed run
	// can be started again.
	const restartDelegation = useMutation({
		mutationFn: async (input: { runId: string }) => {
			await transportActions.cancelRun(input);
			return osApi.kernelRuntime.retryRun(input);
		},
		onSuccess: (result) => {
			setPendingRunId(result.newRunId);
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
			queryClient.invalidateQueries({
				queryKey: homeMessagesQueryKey(conversationId),
			});
		},
	});
	const retryRun = useMutation({
		mutationFn: (input: { runId: string }) =>
			osApi.kernelRuntime.retryRun(input),
		onSuccess: (result) => {
			setPendingRunId(result.newRunId);
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
			queryClient.invalidateQueries({
				queryKey: homeMessagesQueryKey(conversationId),
			});
		},
	});

	const transcriptConversationId =
		conversationId ?? firstSendInFlight?.conversationId ?? null;
	const transcript = useQuery({
		...homeMessagesQueryOptions(
			transcriptConversationId ?? "",
			MESSAGES_PAGE_LIMIT,
		),
		enabled: transcriptConversationId !== null,
		// Until the first turn's row exists the read is refused or empty; the
		// next poll is the retry.
		...(conversationId === null ? { retry: false } : {}),
		// While a run is live, refresh the newest slice so streaming/completed
		// assistant rows land; the id-keyed merge makes re-delivery a no-op.
		refetchInterval: (query) => {
			if (conversationId === null)
				return firstSendConfirmPollMs(
					firstSendInFlight,
					query.state.data?.messages,
				);
			if (
				shouldPollTranscript({
					isActive,
					pendingRun: pendingRunId !== null,
					realtimeDegraded,
				})
			)
				return RUN_POLL_INTERVAL_MS;
			// A transient read failure clears itself without a manual reload.
			return query.state.status === "error"
				? transientTranscriptRetryMs(
						query.state.error,
						query.state.errorUpdateCount,
					)
				: false;
		},
	});

	// Merge each newest-page fetch into the cache. Only the first page of a
	// conversation seeds the older-history cursor — refetches of page 1 return
	// a cursor into history already loaded, which must not clobber paging.
	useEffect(() => {
		const data = transcript.data;
		if (!data) return;
		setMessages(mergeHomeMessages(cacheRef.current, data.messages));
		if (!cursorInitializedRef.current) {
			cursorInitializedRef.current = true;
			setOlderCursor(data.nextCursor ?? null);
		}
	}, [transcript.data]);

	useEffect(() => {
		if (!firstSendInFlight || !isCurrentSend(firstSendInFlight.conversationId))
			return;
		if (
			!messages.some(
				(message) =>
					message.id ===
					provisionalSendMessageId(firstSendInFlight.idempotencyKey),
			)
		)
			return;
		const target = firstSendInFlight.conversationId;
		setFirstSendInFlight(null);
		setPendingRunId(firstSendInFlight.idempotencyKey);
		unknownBootstrapKeyRef.current = null;
		setSendError(null);
		setSendErrorUnknown(false);
		recoveryRequestRef.current = null;
		saveRecoverableChatSend(
			recoveryKey,
			null,
			firstSendInFlight.idempotencyKey,
		);
		try {
			window.localStorage.removeItem(chatDraftKey(conversationId));
		} catch {
			/* Draft storage is optional. */
		}
		if (conversationId === null && cacheConversationRef.current !== target) {
			cacheConversationRef.current = target;
			dispatchProvisional({ type: "adopt", conversationId: target });
			onConversationCreated?.(target, workspaceId);
		}
	}, [
		messages,
		firstSendInFlight,
		conversationId,
		recoveryKey,
		workspaceId,
		onConversationCreated,
		dispatchProvisional,
	]);

	// The first non-empty transcript is the baseline; an output link that
	// appears after it arrived live (a create receipt) and is announced once.
	useEffect(() => {
		if (messages.length === 0) return;
		const linked = assistantLinkedOutputIds(messages);
		const known = knownOutputIdsRef.current;
		if (known === null) {
			knownOutputIdsRef.current = new Set(linked);
			return;
		}
		for (const id of linked) {
			if (known.has(id)) continue;
			known.add(id);
			onOutputCreatedRef.current?.(id);
		}
	}, [messages]);

	// Durable-wins reconciliation. `{key}:input` is exactly the id the canonical
	// read returns for the user turn, so membership in the transcript is proof
	// the durable row exists and the overlay must go — whatever state it was in.
	// This is the path that retires a bubble left in `outcome_unknown` when the
	// first attempt turns out to have been accepted after all, and it retires
	// exactly one entry because the key is the identity.
	useEffect(() => {
		if (provisional.size === 0) return;
		const durableMessageIds = new Set(messages.map((message) => message.id));
		// Retire the key with the overlay. The key is the run id
		// (execution-proposals derives runId from idempotencyKey) and the durable
		// event id is derived from it, inserted with onConflictDoNothing — so
		// reusing a key whose row already landed makes the server discard the new
		// message's content silently, with no error anywhere. Clearing on success
		// alone was not enough: an outcome-unknown send that turns out to have
		// been accepted is retired here, and the live ref would otherwise carry
		// the consumed key into the operator's next, different message.
		const activeKey = idempotencyKeyRef.current;
		if (
			activeKey !== null &&
			durableMessageIds.has(provisionalSendMessageId(activeKey))
		) {
			idempotencyKeyRef.current = null;
		}
		dispatchProvisional({ type: "reconcile", durableMessageIds });
	}, [messages, provisional.size, dispatchProvisional]);

	const loadEarlier = useCallback(async () => {
		if (!conversationId || !olderCursor || loadingEarlier) return;
		setLoadingEarlier(true);
		setLoadEarlierError(null);
		const el = scrollRef.current;
		prependAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
		try {
			const page = await osApi.kernelRuntime.readMessages({
				conversationId,
				limit: MESSAGES_PAGE_LIMIT,
				cursor: olderCursor,
			});
			// Older history is not a fresh create: never auto-open its links.
			for (const id of assistantLinkedOutputIds(page.messages)) {
				knownOutputIdsRef.current?.add(id);
			}
			setMessages(mergeHomeMessages(cacheRef.current, page.messages));
			setOlderCursor(page.nextCursor ?? null);
		} catch (error) {
			prependAnchorRef.current = null;
			setLoadEarlierError((error as Error).message);
		} finally {
			setLoadingEarlier(false);
		}
	}, [conversationId, olderCursor, loadingEarlier]);

	// Scroll maintenance: restore the pre-prepend anchor after "Load earlier",
	// otherwise follow the tail while the reader is pinned near the bottom.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const anchor = prependAnchorRef.current;
		if (anchor !== null) {
			prependAnchorRef.current = null;
			el.scrollTop = el.scrollHeight - anchor;
			return;
		}
		if (stickToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
		// Every source of transcript height belongs here, not just the durable
		// rows. The thread also renders provisional sends (`provisional`),
		// approval cards, and delegation rows derived from the run set — each
		// grows the column without touching `messages` or `overlays`, so a
		// pinned reader was left above the fold by their own optimistic bubble.
		// `displayMessages` replaces `messages` because it already folds the run
		// set's delegated previews.
	}, [
		displayMessages,
		provisional,
		approvalCards,
		runSet,
		pendingRunId,
		overlays,
		toolFrameCount,
		steering.data,
	]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const near = isNearBottom(el);
		stickToBottomRef.current = near;
		setPinnedToBottom(near);
	}, []);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		return observeScrollResize(el, () => stickToBottomRef.current);
	}, [composerOnly, conversationId]);

	const jumpToLatest = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottomRef.current = true;
		setPinnedToBottom(true);
		el.scrollTop = el.scrollHeight;
	}, []);

	// Resolve the running indicator: once the pending run reports a terminal
	// status in the run set, pull the transcript for the assistant reply.
	useEffect(() => {
		if (!pendingRunId || !runSet) return;
		const pendingRun = runSet.runs.find((run) => run.id === pendingRunId);
		if (!pendingRun) return; // stale snapshot — keep waiting
		if (ACTIVE_RUN_STATUSES.has(pendingRun.status)) return;
		setPendingRunId(null);
		queryClient.invalidateQueries({
			queryKey: homeMessagesQueryKey(conversationId),
		});
		// A chat turn may have renamed or edited the workspace around it, or
		// the output open beside it.
		queryClient.invalidateQueries({ queryKey: osQueryKeys.workspaces() });
		queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
	}, [pendingRunId, runSet, conversationId, queryClient]);

	const send = useMutation({
		mutationFn: async (
			input: RecoverableChatSend & {
				enqueueMessage: ChatTransportActions["enqueueMessage"];
			},
		) => {
			const { enqueueMessage, draftContent, ...request } = input;
			void draftContent;
			const tools =
				request.workspaceContext?.workpiece?.kind === "gadget" &&
				!request.delegateToTediId
					? buildAppEditTools(
							request.workspaceContext.workspaceId,
							request.conversationId,
							() =>
								queryClient.invalidateQueries({
									queryKey: osQueryKeys.collaborationProposals(),
								}),
						)
					: [];
			const descriptors = pageTools.offer(request.idempotencyKey, tools);
			const result = enqueueMessage({
				...request,
				...(descriptors.length ? { pageTools: descriptors } : {}),
			}).then((output) => {
				if (descriptors.length && output.status !== "failed")
					pageTools.bind(request.idempotencyKey, output.run.id, (input) =>
						transportActions.resolvePageTool(input),
					);
				return output;
			});
			// Only bootstrap has no bound conversation capability yet. A timeout
			// means unknown outcome; the same-key retry never creates a second run.
			if (conversationId !== null) return result;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					result,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error(RECOVERED_SEND_NOTICE)),
							FIRST_SEND_PENDING_MS,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
		onSuccess: (output, variables) => {
			if (!isCurrentSend(variables.conversationId)) return;
			if (
				output.status === "failed" &&
				!output.assistantMessage &&
				unknownBootstrapKeyRef.current === variables.idempotencyKey
			) {
				// This refusal says nothing about the earlier attempt's outcome.
				const message = output.error ?? "Tedix could not confirm the message.";
				setSendError(message);
				setSendErrorUnknown(true);
				dispatchProvisional({
					type: "unknown",
					idempotencyKey: variables.idempotencyKey,
					error: message,
				});
				return;
			}
			unknownBootstrapKeyRef.current = null;
			if (
				recoveryRequestRef.current?.idempotencyKey === variables.idempotencyKey
			) {
				recoveryRequestRef.current = null;
				saveRecoverableChatSend(recoveryKey, null, variables.idempotencyKey);
			}
			setFirstSendInFlight(null);
			if (output.status === "failed" && !output.assistantMessage) {
				// A refusal without a receipt is not-sent. A persisted failure reply
				// follows normal transcript reconciliation instead of restoring a draft.
				dispatchProvisional({
					type: "rejected",
					idempotencyKey: variables.idempotencyKey,
				});
				setDraft(variables.draftContent);
				setSendError(output.error ?? "Tedix could not accept the message.");
				return;
			}
			idempotencyKeyRef.current = null;
			setSendError(null);
			setSendErrorUnknown(false);
			// The durable user row now exists (`{key}:input`) and is merged below,
			// so the provisional overlay retires here rather than waiting for the
			// reconcile pass — durable always wins, never coexists.
			dispatchProvisional({
				type: "settled",
				idempotencyKey: variables.idempotencyKey,
			});
			setNotice(
				needsDelegationChoice(output)
					? "Choose which tedi should handle this: pick one next to the model, then send again."
					: null,
			);
			try {
				// The draft was stored under the key we sent from (possibly "new").
				window.localStorage.removeItem(chatDraftKey(conversationId));
			} catch {
				// storage unavailability never blocks the send
			}
			setDraft("");
			stickToBottomRef.current = true;
			// The enqueue persisted the user turn — render it from the response.
			const delivered: HomeMessage[] = [
				userMessageFromEnqueue(output, variables.content),
			];
			if (output.assistantMessage) delivered.push(output.assistantMessage);
			setMessages(mergeHomeMessages(cacheRef.current, delivered));
			if (!output.assistantMessage && output.status !== "needs_delegation") {
				setPendingRunId(output.run.id);
			}
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(output.conversationId),
			});
			if (
				conversationId === null &&
				cacheConversationRef.current !== output.conversationId
			) {
				// Keep the cache when the parent flips the route to the new id.
				cacheConversationRef.current = output.conversationId;
				dispatchProvisional({
					type: "adopt",
					conversationId: output.conversationId,
				});
				onConversationCreated?.(
					output.conversationId,
					variables.workspaceContext?.workspaceId,
				);
			}
		},
		onError: (error, variables) => {
			if (!isCurrentSend(variables.conversationId)) return;
			if (
				cacheRef.current.has(provisionalSendMessageId(variables.idempotencyKey))
			)
				return;
			// The key is always kept: Retry re-sends it, and a same-key resend is
			// exactly-once server-side.
			const message = errorMessage(error, "The send failed.");
			setSendError(message);
			// Recorded separately from the overlay because the overlay may already
			// be gone: a durable row can land before the promise rejects.
			const outcomeUnknown =
				isUnknownSendOutcome(error) ||
				unknownBootstrapKeyRef.current === variables.idempotencyKey;
			setSendErrorUnknown(outcomeUnknown);
			if (outcomeUnknown) {
				if (
					recoveryRequestRef.current?.idempotencyKey ===
					variables.idempotencyKey
				)
					unknownBootstrapKeyRef.current = variables.idempotencyKey;
				// The kernel may hold this turn. The bubble stays — as unconfirmed,
				// never as sent — and the composer stays empty so Retry re-sends that
				// message rather than letting a second draft accumulate beside it.
				dispatchProvisional({
					type: "unknown",
					idempotencyKey: variables.idempotencyKey,
					error: message,
				});
				// Nor may a reload bring the text back as a draft: the turn usually
				// did land, and the restored draft merged with the next message.
				try {
					window.localStorage.removeItem(chatDraftKey(conversationId));
				} catch {
					// storage unavailability never blocks the send
				}
				return;
			}
			setFirstSendInFlight(null);
			if (
				recoveryRequestRef.current?.idempotencyKey === variables.idempotencyKey
			) {
				recoveryRequestRef.current = null;
				saveRecoverableChatSend(recoveryKey, null, variables.idempotencyKey);
			}
			// The server answered and refused: nothing durable will ever appear, so
			// the overlay goes and the text returns to the composer.
			dispatchProvisional({
				type: "rejected",
				idempotencyKey: variables.idempotencyKey,
			});
			setDraft(variables.draftContent);
		},
		onMutate: (variables) => {
			if (!isCurrentSend(variables.conversationId) || conversationId !== null)
				return;
			const { enqueueMessage, ...request } = variables;
			void enqueueMessage;
			recoveryRequestRef.current = request;
			saveRecoverableChatSend(recoveryKey, request);
			setFirstSendInFlight({
				conversationId: variables.conversationId,
				idempotencyKey: variables.idempotencyKey,
			});
		},
		onSettled: (_output, _error, variables) => {
			if (!isCurrentSend(variables.conversationId)) return;
			// The composer is readOnly (never disabled) while sending, so focus is
			// normally retained — this refocus covers the cases where a transcript
			// data load or an error banner stole it mid-send.
			composerRef.current?.focus();
		},
	});

	const directRead = useMutation({
		mutationFn: (input: DirectReadRequest) =>
			osDirectReadApi.kernelRuntime.executeReadOnlyTool(input),
		onSuccess: (output, variables) => {
			setMessages(
				mergeHomeMessages(cacheRef.current, [
					output.requestMessage,
					output.receiptMessage,
				]),
			);
			setDraft("");
			setSendError(null);
			setSendErrorUnknown(false);
			idempotencyKeyRef.current = null;
			directReadRetryRef.current = null;
			try {
				window.localStorage.removeItem(chatDraftKey(variables.conversationId));
			} catch {
				// Draft persistence is best effort.
			}
			invalidateHomeTranscript(queryClient, variables.conversationId);
			setDirectReadOpen(false);
			if (conversationId === null) {
				cacheConversationRef.current = variables.conversationId;
				dispatchProvisional({
					type: "adopt",
					conversationId: variables.conversationId,
				});
				onConversationCreated?.(
					variables.conversationId,
					variables.workspaceContext?.workspaceId,
				);
			}
		},
		onError: (error) => {
			setSendError(
				errorMessage(error, "The direct read could not be started."),
			);
			setSendErrorUnknown(isUnknownSendOutcome(error));
		},
		onSettled: () => composerRef.current?.focus(),
	});

	const startDirectRead = useCallback(
		(command: DirectReadCommand) => {
			if (directRead.isPending) return;
			const targetConversationId = conversationIdForSend(
				conversationId,
				newConversationIdRef.current,
			);
			if (conversationId === null)
				newConversationIdRef.current = targetConversationId;
			const key = nextIdempotencyKey(null);
			idempotencyKeyRef.current = key;
			setSendError(null);
			stickToBottomRef.current = true;
			const request: DirectReadRequest = {
				...command,
				conversationId: targetConversationId,
				idempotencyKey: key,
				...(organizationId ? { organizationId } : {}),
				...(workspaceId
					? {
							workspaceContext: {
								workspaceId: workspaceId,
								...(context &&
								includeContext &&
								(context.kind === "gadget" || context.kind === "output")
									? { workpiece: { kind: context.kind, id: context.id } }
									: {}),
							},
						}
					: {}),
			};
			directReadRetryRef.current = request;
			directRead.mutate(request);
		},
		[
			conversationId,
			context,
			directRead,
			includeContext,
			organizationId,
			workspaceId,
		],
	);

	/**
	 * Each composer submission gets a new key; Retry replays the original request.
	 * The draft leaves the textarea immediately —
	 * the provisional bubble now holds it. New-thread requests are saved with
	 * their key before sending, so reload restores recovery rather than a new draft.
	 */
	const startSend = useCallback(
		async (content: string) => {
			if (localAiUnavailable && !parseDirectReadCommand(content)) return;
			if (
				(!content.trim() && attachments.length === 0) ||
				preparingAttachments ||
				(conversationId === null && recoveryRequestRef.current !== null) ||
				send.isPending ||
				steer.isPending ||
				cancelRun.isPending ||
				directRead.isPending ||
				// Enter bypasses the disabled submit button; the gate cannot.
				blockedByAttachedImage
			)
				return;
			const directCommand =
				attachments.length === 0 ? parseDirectReadCommand(content) : null;
			const contextualContent =
				context && includeContext
					? encodeChatContext(context, content)
					: content;
			const targetConversationId = conversationIdForSend(
				conversationId,
				newConversationIdRef.current,
			);
			if (conversationId === null) {
				newConversationIdRef.current = targetConversationId;
			}
			const key = nextIdempotencyKey(null);
			idempotencyKeyRef.current = key;
			if (directCommand) {
				idempotencyKeyRef.current = null;
				startDirectRead(directCommand);
				return;
			}
			const priorSteering = steeringRequestRef.current;
			const targetRun =
				priorSteering?.content === content
					? priorSteering.runId
					: steeringRunId;
			if (targetRun) {
				if (attachments.length) {
					setSteeringError(
						"Steering accepts text. Keep these attachments for your next message.",
					);
					return;
				}
				const request =
					priorSteering?.runId === targetRun &&
					priorSteering.content === content
						? priorSteering
						: {
								runId: targetRun,
								content,
								idempotencyKey: crypto.randomUUID(),
							};
				steeringRequestRef.current = request;
				setSteeringError(null);
				steer.mutate({ ...request, conversationId: targetConversationId });
				return;
			}
			directReadRetryRef.current = null;
			setSendError(null);
			setSendErrorUnknown(false);
			const provisionalAction = {
				type: "send",
				idempotencyKey: key,
				content: contextualContent,
				conversationId: targetConversationId,
				at: new Date().toISOString(),
			} as const;
			dispatchProvisional(provisionalAction);
			setDraft("");
			onSendStarted?.();
			stickToBottomRef.current = true;
			send.mutate({
				enqueueMessage: transportActions.enqueueMessage,
				draftContent: content,
				content: contextualContent,
				conversationId: targetConversationId,
				idempotencyKey: key,
				attachments: attachments.map(({ previewUrl, ...attachment }) => {
					void previewUrl;
					return attachment;
				}),
				metadata:
					context && includeContext ? { chatContext: context } : undefined,
				workspaceContext: workspaceId
					? {
							workspaceId: workspaceId,
							...(context &&
							includeContext &&
							(context.kind === "gadget" || context.kind === "output")
								? {
										workpiece: { kind: context.kind, id: context.id },
									}
								: {}),
						}
					: undefined,
				modelRef: localWorkersAi ? undefined : (selectedModelRef ?? undefined),
				// A tedi that left the active roster falls back to Home.
				delegateToTediId:
					selectedTediId && selectedTediName ? selectedTediId : undefined,
			});
			setAttachments([]);
		},
		[
			attachments,
			preparingAttachments,
			localAiUnavailable,
			localWorkersAi,
			blockedByAttachedImage,
			context,
			conversationId,
			dispatchProvisional,
			includeContext,
			selectedModelRef,
			selectedTediId,
			selectedTediName,
			directRead,
			onSendStarted,
			startDirectRead,
			steeringRunId,
			steer,
			cancelRun.isPending,
			transportActions,
			send,
			workspaceId,
		],
	);

	const submit = useCallback(() => {
		void startSend(draft);
	}, [draft, startSend]);

	useEffect(() => {
		if (!onSendMessageReady) return;
		onSendMessageReady((content) => {
			void startSend(content);
		});
		return () => onSendMessageReady(() => {});
	}, [onSendMessageReady, startSend]);

	/** Re-send the same key with the same text — never a second message. */
	const retrySend = useCallback(() => {
		const key = idempotencyKeyRef.current;
		const request =
			send.variables ??
			(recoveryRequestRef.current
				? {
						...recoveryRequestRef.current,
						enqueueMessage: transportActions.enqueueMessage,
					}
				: null);
		if (!request || request.idempotencyKey !== key || send.isPending) return;
		setSendError(null);
		setSendErrorUnknown(false);
		dispatchProvisional({
			type: "send",
			idempotencyKey: request.idempotencyKey,
			content: request.content,
			conversationId: request.conversationId,
			at: new Date().toISOString(),
		});
		// Replay the complete request, including attachments and context. Passing
		// encoded text through startSend encodes it twice and loses attachments.
		send.mutate(request);
	}, [dispatchProvisional, send, transportActions.enqueueMessage]);

	/** Replay the exact direct-read request and key. The server's request-event
	 * insert is the execution fence, so a transport retry returns the durable
	 * receipt without invoking the provider a second time. */
	const retryDirectRead = useCallback(() => {
		const request = directReadRetryRef.current;
		if (!request || directRead.isPending) return;
		setSendError(null);
		setSendErrorUnknown(false);
		directRead.mutate(request);
	}, [directRead]);

	const updateDraft = useCallback(
		(value: string) => {
			setDraft(value);
			try {
				if (value) {
					window.localStorage.setItem(chatDraftKey(conversationId), value);
				} else {
					window.localStorage.removeItem(chatDraftKey(conversationId));
				}
			} catch {
				// draft persistence is best-effort
			}
		},
		[conversationId],
	);
	const dictation = useComposerDictation((transcript) => {
		updateDraft(appendVoiceTranscript(draft, transcript));
		composerRef.current?.focus();
	});

	// --- Composer skill picker -------------------------------------------
	// Skills are governed on their own admin surface but were not invocable
	// where the operator types. A bare slash token opens a bounded picker; a
	// confirmation writes the canonical `/skill <slug>` reference into the
	// message itself, which the kernel's operator-slash parser understands.
	const [composerMenuOpen, setComposerMenuOpen] = useState(false);
	const [skillSearch, setSkillSearch] = useState<string | null>(null);
	const skillTrigger = skillSearch ?? draftPickerTrigger(draft);
	const skillListboxId = useId();
	const [skillPickerDismissed, setSkillPickerDismissed] = useState(false);
	const [skillActiveIndex, setSkillActiveIndex] = useState(-1);
	const skillCatalog = useQuery({
		...skillCatalogQueryOptions(SKILL_CATALOG_LIMIT),
		enabled:
			composerMenuOpen || (skillTrigger !== null && !skillPickerDismissed),
		// Freshness per open, never per conversation. A catalog cached for the
		// life of a thread makes a skill recorded a minute ago invisible, and a
		// cached failure reads as an empty library. staleTime 0 plus
		// gcTime 0 means every open re-reads rather than replaying a snapshot.
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
	const composerTools = useQuery({
		...osQuery.apps.listComposerCommands.queryOptions({ input: {} }),
		enabled: composerMenuOpen,
		staleTime: 0,
		gcTime: 0,
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
		!skillPickerDismissed &&
		(skillSearch !== null ||
			skillCatalog.isPending ||
			skillCatalog.isError ||
			skillMatches.length > 0);
	const skillListboxOpen =
		skillSearch === null &&
		skillPickerOpen &&
		!skillCatalog.isPending &&
		!skillCatalog.isError;
	// Pills are a pure projection of the durable text through the shared parser,
	// so a hand-edited draft and the pill row can never disagree.
	const referencedSlugs = useMemo(() => parseSkillReferences(draft), [draft]);
	const skillTitles = useMemo(() => {
		const titles = new Map<string, string>();
		for (const skill of reachableSkills) titles.set(skill.slug, skill.title);
		return titles;
	}, [reachableSkills]);
	const skillPills = useMemo(
		() =>
			referencedSlugs.map((slug) => ({
				slug,
				title: skillTitles.get(slug) ?? slug,
			})),
		[referencedSlugs, skillTitles],
	);
	const confirmSkill = useCallback(
		(skill: ComposerSkill) => {
			updateDraft(insertSkillReference(draft, skill.slug));
			setSkillSearch(null);
			setSkillActiveIndex(-1);
			composerRef.current?.focus();
		},
		[draft, updateDraft],
	);
	const handleSkillPickerKey = (event: KeyboardEvent) => {
		if (isImeComposing(event)) return false;
		if (skillPickerOpen && skillMatches.length > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setSkillActiveIndex((index) => {
					const step = event.key === "ArrowDown" ? 1 : -1;
					const next = index + step;
					if (next < 0) return skillMatches.length - 1;
					return next >= skillMatches.length ? 0 : next;
				});
				return true;
			}
			// Enter confirms only from a row the operator explicitly
			// highlighted. Typing `/anything` and pressing Enter is
			// still a plain send — the picker never swallows a message.
			if (event.key === "Enter" && !event.shiftKey) {
				const highlighted = skillMatches[skillActiveIndex];
				if (highlighted) {
					event.preventDefault();
					confirmSkill(highlighted);
					return true;
				}
			}
		}
		if (skillPickerOpen && event.key === "Escape") {
			event.preventDefault();
			setSkillSearch(null);
			setSkillPickerDismissed(true);
			composerRef.current?.focus();
			return true;
		}
		if (skillSearch !== null && event.key === "Enter") {
			event.preventDefault();
			return true;
		}
		return false;
	};

	// A new trigger is a new list: a stale highlight would confirm a row the
	// operator can no longer see.
	useEffect(() => {
		setSkillActiveIndex(-1);
		if (skillTrigger === null) setSkillPickerDismissed(false);
	}, [skillTrigger]);

	// A first turn whose durable row has landed is sent; until the enqueue
	// answers, the only progress this thread can show is that it is working.
	const firstSendRunning =
		firstSendInFlight !== null &&
		!provisional.has(firstSendInFlight.idempotencyKey);
	const showRunning = pendingRunId !== null || isActive || firstSendRunning;
	const provisionalSends = listProvisionalSends(
		provisional,
		conversationId,
		newConversationIdRef.current,
	);
	// An overlay for this key is still on screen, so the composer must not also
	// hold the text — Retry re-sends the bubble, not a second draft.
	const sendHeldProvisionally = hasProvisionalSend(
		provisional,
		idempotencyKeyRef.current,
	);
	// The overlay is the usual evidence that an outcome is unknown, but it is
	// retired the moment the durable row lands — and the enqueue promise can
	// reject after that (the common flake shape). Without this the banner
	// claimed "Message not sent" while the message sat durably on screen, and
	// promised a held draft next to an empty composer. Classify from the error
	// itself, which stays true whichever order those two events arrive in.
	const sendOutcomeUnknown = sendHeldProvisionally || sendErrorUnknown;
	const showTranscriptSkeleton =
		conversationId !== null && transcript.isPending && messages.length === 0;
	const resetAttachmentDrag = () => {
		attachmentDragDepth.current = 0;
		setAttachmentDragActive(false);
	};
	const addComposerFiles = (selected: File[]) => {
		// Ref fence also covers a picker and drop arriving before React rerenders.
		if (attachmentPreparationRef.current || selected.length === 0) return;
		const capacity = Math.max(0, 5 - attachments.length);
		if (capacity === 0) {
			setAttachmentError("Messages are limited to 5 attachments.");
			return;
		}
		const picked = selected.slice(0, capacity);
		const files =
			imageRefusal === null
				? picked
				: picked.filter((file) => attachmentType(file) !== "image");
		setAttachmentError(
			files.length !== picked.length
				? imageRefusal
				: selected.length > capacity
					? "Messages are limited to 5 attachments; extra files were not added."
					: null,
		);
		if (files.length === 0) return;
		attachmentPreparationRef.current = true;
		setPreparingAttachments(true);
		const generation = ++attachmentPickGeneration.current;
		void Promise.all(files.map(readComposerAttachment))
			.then((items) => {
				if (attachmentPickGeneration.current === generation)
					setAttachments((current) => [...current, ...items]);
			})
			.catch((error: unknown) => {
				if (attachmentPickGeneration.current !== generation) return;
				setAttachmentError(
					error instanceof Error
						? error.message
						: "Could not prepare attachment.",
				);
			})
			.finally(() => {
				if (attachmentPickGeneration.current === generation) {
					attachmentPreparationRef.current = false;
					setPreparingAttachments(false);
				}
			});
	};
	const hasContent =
		displayMessages.length > 0 || provisionalSends.length > 0 || showRunning;
	const finishedDelegations = finishedDelegationsByMessage(
		runSet?.runs ?? [],
		displayMessages,
	);
	const latestAssistantMessageId = displayMessages.findLast(
		(message) => message.role === "assistant",
	)?.id;

	return (
		<div
			ref={pushVisibilityRef}
			className={
				composerOnly
					? "flex min-h-0 flex-col gap-4"
					: "flex h-full min-h-0 flex-col gap-4"
			}
		>
			{!composerOnly && conversationId !== null ? (
				// Opened by the "Chat details" icon in the conversation header,
				// which names this id in aria-controls.
				<Collapsible className="shrink-0" open={detailsOpen}>
					<CollapsibleContent id="chat-details-panel">
						<div className="flex flex-wrap items-center justify-end gap-2 pt-2">
							{detailsActions}
							<ConversationCapabilityPalette conversationId={conversationId} />
							{runSet !== undefined ? (
								<>
									<ContextUsedInspector
										runs={runSet.runs}
										workspaceId={workspaceId}
										context={context}
									/>
									<ConversationCostChip runs={runSet.runs} />
								</>
							) : null}
						</div>
					</CollapsibleContent>
				</Collapsible>
			) : null}
			{composerOnly ? null : (
				<div className="relative flex min-h-0 flex-1 flex-col">
					<div
						ref={scrollRef}
						data-slot="conversation-transcript"
						onScroll={handleScroll}
						role="log"
						aria-label="Conversation"
						aria-live="polite"
						tabIndex={0}
						className="min-h-48 flex-1 overflow-y-auto bg-transparent py-4"
					>
						<div className="mx-auto min-w-0 w-full max-w-3xl">
							{conversationId === null && !hasContent ? (
								<Empty appearance="inline">
									<EmptyHeader className="w-full max-w-none">
										<EmptyTitle>What can I help with?</EmptyTitle>
										<EmptyDescription>
											Ask a question, or ask for a doc, sheet or deck.
										</EmptyDescription>
										<ChatStarterPrompts onChoose={updateDraft} />
									</EmptyHeader>
								</Empty>
							) : null}
							{showTranscriptSkeleton ? (
								<div className="grid gap-2" aria-hidden>
									<Skeleton className="h-14 w-2/3" />
									<Skeleton className="ml-auto h-14 w-2/3" />
									<Skeleton className="h-14 w-2/3" />
								</div>
							) : null}
							{conversationId !== null &&
							transcript.isError &&
							messages.length === 0 ? (
								<Alert variant="destructive">
									<AlertTitle>The transcript is unavailable</AlertTitle>
									<AlertDescription>
										{(transcript.error as Error).message}
									</AlertDescription>
								</Alert>
							) : null}
							{conversationId !== null &&
							transcript.isSuccess &&
							!hasContent ? (
								<Empty appearance="inline">
									<EmptyHeader className="w-full max-w-none">
										<EmptyTitle>No messages yet</EmptyTitle>
										<EmptyDescription>
											Type a message below to get started.
										</EmptyDescription>
										<ChatStarterPrompts onChoose={updateDraft} />
									</EmptyHeader>
								</Empty>
							) : null}
							{hasContent ? (
								<ul className="m-0 grid min-w-0 grid-cols-[minmax(0,1fr)] list-none gap-4 p-0">
									{olderCursor ? (
										<li className="flex justify-center">
											<Button
												size="sm"
												variant="ghost"
												className="text-kumo-subtle"
												loading={loadingEarlier}
												disabled={loadingEarlier}
												onClick={() => void loadEarlier()}
											>
												Load earlier
											</Button>
										</li>
									) : null}
									{loadEarlierError ? (
										<li
											className="text-center text-kumo-danger text-xs"
											role="alert"
										>
											Could not load earlier messages: {loadEarlierError}
										</li>
									) : null}
									{displayMessages.map((message) => (
										<Fragment key={message.id}>
											<ChatMessageBubble
												message={message}
												latest={message.id === latestAssistantMessageId}
												showExecutionLink={executionLinks.has(message.id)}
												context={context}
												workspaceId={workspaceId}
												runActive={
													!!message.runId &&
													activeRunIds.includes(message.runId)
												}
											/>
											<ChatMessageWidgets
												message={message}
												onFollowUp={startSend}
											/>
											{(() => {
												const work = finishedDelegations.get(message.id);
												return work ? (
													<DelegationSummaryRow
														work={work}
														tediName={
															work.delegatedTediId
																? tediNames[work.delegatedTediId]
																: null
														}
													/>
												) : null;
											})()}
										</Fragment>
									))}
									{/* Provisional user turns render after every durable row and
								    before the assistant overlay: they are the newest thing in
								    the thread by construction, and the reconcile pass has
								    already dropped any whose durable row is in `messages`. */}
									{provisionalSends.map((send) => (
										<ProvisionalUserBubble
											key={send.idempotencyKey}
											send={send}
											held={heldSendKeys.has(send.idempotencyKey)}
										/>
									))}
									{visibleOverlays(
										overlays,
										new Set(displayMessages.map((message) => message.id)),
										new Set(
											displayMessages
												.filter((message) => message.role === "assistant")
												.flatMap((message) =>
													message.runId ? [message.runId] : [],
												),
										),
										new Map(
											(runSet?.runs ?? []).flatMap((run) =>
												run.status === "failed" || run.status === "canceled"
													? [[run.id, run.status] as const]
													: [],
											),
										),
									).map((overlay) => (
										<Fragment key={overlay.key}>
											{/* The planner's provisional thinking line, above the
										    answer it precedes. Pre-spaced: it reserves its line for
										    the whole in-flight window, so nothing shifts when the
										    rationale arrives or when the answer supersedes it. */}
											{overlay.phase && !overlay.finalized ? (
												<StreamedRationaleRow rationale={overlay.rationale} />
											) : null}
											{overlay.text ? (
												<StreamedAssistantBubble
													text={overlay.text}
													done={overlay.finalized}
												/>
											) : null}
											{overlay.phase && !overlay.finalized ? (
												<StreamedPhaseRow phase={overlay.phase} />
											) : null}
										</Fragment>
									))}
									{(() => {
										const tools = sortToolStates(
											mergeToolEvents([
												...toolFramesRef.current.values(),
											]).values(),
										);
										return tools.length > 0 ? (
											<WorkTraceCard tools={tools} />
										) : null;
									})()}
									{activeDelegations(runSet?.runs ?? []).map((work) => (
										<LiveDelegationCard
											key={work.childRunId ?? work.runId}
											work={work}
											tediName={
												work.delegatedTediId
													? tediNames[work.delegatedTediId]
													: null
											}
											pending={
												cancelRun.isPending || restartDelegation.isPending
											}
											onStop={() => cancelRun.mutate({ runId: work.runId })}
											onRetry={() =>
												restartDelegation.mutate({ runId: work.runId })
											}
										/>
									))}
									{restartDelegation.error ? (
										<li>
											<Text role="label" tone="error" className="m-0">
												{errorMessage(
													restartDelegation.error,
													"The delegation could not be restarted. Please try again.",
												)}
											</Text>
										</li>
									) : null}
									{approvalCards.map((card) => (
										<ApprovalCard
											key={card.approvalId}
											approval={card}
											resolving={
												respondApproval.isPending &&
												respondApproval.variables?.runId === card.runId
											}
											onResolve={(_, decision, delegateRecommendation) =>
												respondApproval.mutate({
													runId: card.runId,
													decision,
													delegateRecommendation,
												})
											}
											onAlwaysApprove={alwaysApprove}
										/>
									))}
									{approvalError ? (
										<li>
											<Text role="label" tone="error" className="m-0">
												{approvalError}
											</Text>
										</li>
									) : null}
									{shouldShowRunningIndicator({
										showRunning,
										overlayCount: overlays.length,
									}) ? (
										<RunningIndicator
											label={
												pendingRun?.progress?.label ??
												pendingRun?.progress?.detail ??
												null
											}
										/>
									) : null}
									{/* Retry sits under the line it acts on; Stop is the
									    composer's send slot. */}
									{pendingRun?.status === "failed" ? (
										<li className="flex w-full justify-start">
											<RunControls
												status={pendingRun.status}
												delegated={pendingRun.delegatedTediId != null}
												routeRetryable={isHomeRouteRetryable(pendingRun)}
												pending={cancelRun.isPending || retryRun.isPending}
												onRetry={() =>
													retryRun.mutate({ runId: pendingRun.id })
												}
											/>
										</li>
									) : null}
									{queuedSteering.map((message) => (
										<li
											key={`steering:${message.id}`}
											className="ml-auto max-w-full whitespace-pre-wrap break-words rounded-lg bg-kumo-tint p-3 text-sm"
											data-steering-status="queued"
										>
											{message.content}
											<div className="mt-1 text-kumo-subtle text-xs">
												Queued · waiting for the run
											</div>
										</li>
									))}
									{queuedSteering.length > 0 &&
									!steeringRunId &&
									steeringTargetId ? (
										<li>
											<Button
												variant="secondary"
												size="sm"
												loading={withdrawSteering.isPending}
												onClick={() =>
													withdrawSteering.mutate({ runId: steeringTargetId })
												}
											>
												Return queued messages to draft
											</Button>
										</li>
									) : null}
									{retryRun.error ? (
										<li>
											<Text role="label" tone="error" className="m-0">
												{errorMessage(
													retryRun.error,
													"The retry could not be started. Please try again.",
												)}
											</Text>
										</li>
									) : null}
								</ul>
							) : null}
						</div>
					</div>
					<JumpToLatestControl
						visible={!pinnedToBottom && hasContent}
						onJump={jumpToLatest}
					/>
				</div>
			)}

			{localAiUnavailable ? (
				<Alert variant="info">
					<AlertTitle>Local exploration mode</AlertTitle>
					<AlertDescription>
						{LOCAL_AI_UNAVAILABLE}{" "}
						<a href="https://docs.tedix.dev/getting-started/">
							Set up local inference
						</a>
					</AlertDescription>
				</Alert>
			) : null}
			{steeringError ? (
				<Alert variant="destructive">
					<AlertTitle>Message kept</AlertTitle>
					<AlertDescription>{steeringError}</AlertDescription>
				</Alert>
			) : null}
			{notice ? (
				<Alert variant="info">
					<AlertTitle>Delegation choice needed</AlertTitle>
					<AlertDescription>{notice}</AlertDescription>
				</Alert>
			) : null}
			{sendError ? (
				<div className="[&_button]:min-h-11 [&_button]:min-w-11">
					<SendFailureBanner
						message={sendError}
						// The banner's claim is read off the same overlay the transcript
						// renders, so the two can never disagree about whether the outcome
						// is unknown.
						outcomeUnknown={sendOutcomeUnknown}
						draftHeld={sendHeldProvisionally}
						retrying={send.isPending || directRead.isPending}
						onRetry={directReadRetryRef.current ? retryDirectRead : retrySend}
					/>
				</div>
			) : null}
			{firstSendInFlight && sendErrorUnknown ? (
				<Button
					size="sm"
					variant="outline"
					className="min-h-11 self-start"
					disabled={transcript.isFetching}
					onClick={() => void transcript.refetch()}
				>
					{transcript.isFetching ? "Checking status…" : "Check status"}
				</Button>
			) : null}
			{directReadOpen && blockingApprovalCards.length === 0 ? (
				<DirectReadPanel
					catalog={readOnlyCatalog}
					pending={directRead.isPending}
					onClose={() => setDirectReadOpen(false)}
					onRun={startDirectRead}
				/>
			) : null}

			{blockingApprovalCards.length > 0 ? (
				<ApprovalInputGate count={blockingApprovalCards.length} />
			) : null}
			<form
				data-slot="chat-composer"
				className="chat-composer relative mx-auto w-full shrink-0 max-w-3xl rounded-2xl border border-kumo-hairline bg-kumo-base shadow-tedix-raised transition-shadow duration-tedix-standard focus-within:shadow-tedix-floating motion-reduce:transition-none"
				onDragEnter={(event) => {
					if (!Array.from(event.dataTransfer.types).includes("Files")) return;
					event.preventDefault();
					attachmentDragDepth.current += 1;
					setAttachmentDragActive(true);
				}}
				onDragOver={(event) => {
					if (!Array.from(event.dataTransfer.types).includes("Files")) return;
					event.preventDefault();
					event.dataTransfer.dropEffect =
						preparingAttachments || attachments.length >= 5 ? "none" : "copy";
					setAttachmentDragActive(true);
				}}
				onDragLeave={() => {
					attachmentDragDepth.current = Math.max(
						0,
						attachmentDragDepth.current - 1,
					);
					if (attachmentDragDepth.current === 0) setAttachmentDragActive(false);
				}}
				onDragEnd={resetAttachmentDrag}
				onDrop={(event) => {
					if (!Array.from(event.dataTransfer.types).includes("Files")) return;
					event.preventDefault();
					event.stopPropagation();
					resetAttachmentDrag();
					addComposerFiles(Array.from(event.dataTransfer.files));
				}}
				onSubmit={(event) => {
					event.preventDefault();
					if (dictation.phase !== "idle") {
						if (dictation.phase === "recording") dictation.stop();
						return;
					}
					submit();
				}}
			>
				{skillPickerOpen ? (
					<ChatSkillPicker
						activeIndex={skillActiveIndex}
						error={skillCatalog.isError}
						listboxId={skillListboxId}
						loading={skillCatalog.isPending}
						onRetry={() => void skillCatalog.refetch()}
						onSelect={confirmSkill}
						search={
							skillSearch === null
								? undefined
								: {
										value: skillSearch,
										onValueChange: setSkillSearch,
										onKeyDown: handleSkillPickerKey,
									}
						}
						skills={skillMatches}
					/>
				) : null}
				<ChatSkillPills
					skills={skillPills}
					onRemove={(slug) => {
						updateDraft(removeSkillReference(draft, slug));
						composerRef.current?.focus();
					}}
				/>
				{attachmentDragActive ? (
					<Surface
						data-slot="attachment-dropzone"
						role="status"
						className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-kumo-brand p-4"
					>
						<Text role="body" className="m-0 flex items-center gap-2">
							<Paperclip size={20} aria-hidden="true" />
							{preparingAttachments
								? "Preparing attachments…"
								: attachments.length >= 5
									? "Messages are limited to 5 attachments"
									: "Drop files to attach"}
						</Text>
					</Surface>
				) : null}
				<input
					ref={attachmentInputRef}
					type="file"
					className="hidden"
					aria-label="Attach files"
					disabled={preparingAttachments}
					multiple
					onChange={(event) => {
						addComposerFiles(Array.from(event.target.files ?? []));
						event.target.value = "";
					}}
				/>
				{composerAttachmentError ? (
					<p
						data-slot="attachment-error"
						role="alert"
						className="m-0 px-4 pt-3 text-kumo-danger text-xs"
					>
						{composerAttachmentError}
					</p>
				) : null}
				{dictation.error ? (
					<div
						role="alert"
						className="flex items-center justify-between gap-3 px-4 pt-3 text-kumo-danger text-xs"
					>
						<span>{dictation.error}</span>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => void dictation.start().catch(() => undefined)}
						>
							Try again
						</Button>
					</div>
				) : null}
				{attachments.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{attachments.map((attachment) => (
							<div
								key={`${attachment.fileName}:${attachment.size}`}
								className="relative flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-tint px-2 py-1"
							>
								{attachment.previewUrl ? (
									<img
										src={attachment.previewUrl}
										alt=""
										className="size-8 rounded object-cover"
									/>
								) : (
									<File size={14} />
								)}
								<Text as="span" role="label" className="max-w-36 truncate">
									{attachment.fileName}
								</Text>
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									aria-label={`Remove ${attachment.fileName}`}
									onClick={() =>
										setAttachments((items) =>
											items.filter((item) => item !== attachment),
										)
									}
									icon={<X size={12} />}
								/>
							</div>
						))}
					</div>
				) : null}
				{dictation.phase === "idle" ? (
					<Textarea
						ref={composerRef}
						aria-label="Message"
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={skillListboxOpen}
						aria-controls={skillListboxOpen ? skillListboxId : undefined}
						aria-activedescendant={
							skillListboxOpen && skillActiveIndex >= 0
								? `${skillListboxId}-option-${skillActiveIndex}`
								: undefined
						}
						placeholder={chatComposerPlaceholder(hasContent)}
						value={draft}
						onValueChange={updateDraft}
						onKeyDown={(event) => {
							// The IME guard comes first for the picker too: a candidate
							// selection is Enter/Arrow traffic that belongs to the IME,
							// never to the composer.
							if (isImeComposing(event)) return;
							if (handleSkillPickerKey(event)) return;
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								submit();
							}
						}}
						// readOnly (not disabled) while sending: a disabled control blurs
						// the composer and swallows the next Enter — focus must survive
						// the send round-trip.
						readOnly={
							send.isPending ||
							steer.isPending ||
							cancelRun.isPending ||
							firstSendInFlight !== null
						}
						autoResize
						minRows={1}
						maxRows={8}
						// The form draws the composer's border and focus state; the field
						// inside it stays borderless so the two never read as nested boxes.
						className="min-h-14 resize-none rounded-2xl border-0 bg-transparent px-4 pt-3 pb-1 shadow-none ring-0 focus:ring-0 focus-visible:ring-0"
					/>
				) : (
					<div
						className="chat-voice-capture flex min-h-14 items-center gap-3 px-3"
						role="status"
						aria-label={
							dictation.phase === "connecting"
								? "Connecting microphone"
								: dictation.phase === "recording"
									? "Listening"
									: "Transcribing"
						}
					>
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							aria-label="Cancel dictation"
							onClick={dictation.cancel}
							icon={<X size={16} />}
						/>
						{dictation.phase === "recording" ? (
							<div className="chat-voice-wave" aria-hidden="true">
								{Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => {
									return (
										<i
											key={index}
											style={{
												height: `${voiceWaveBarHeight(dictation.audioHistory[index] ?? 0)}px`,
											}}
										/>
									);
								})}
							</div>
						) : (
							<div className="flex flex-1 justify-center">
								<Loader size="sm" />
							</div>
						)}
						{dictation.phase === "recording" ? (
							<Button
								type="button"
								size="icon-sm"
								aria-label="Stop and transcribe"
								onClick={dictation.stop}
								icon={<Square size={14} weight="fill" />}
							/>
						) : null}
					</div>
				)}
				{dictation.phase === "idle" ? (
					<div className="chat-composer-actions">
						<div className="chat-composer-context">
							{workspaceId ? (
								<WorkspaceFileUpload
									compact
									workspaceId={workspaceId}
									onError={setAttachmentError}
									onUploaded={(file) =>
										updateDraft(
											`${draft}${draft ? "\n\n" : ""}Workspace file: ${file.name} (${new URL(file.url, window.location.origin).href})`,
										)
									}
								/>
							) : null}
							<DropdownMenu
								open={composerMenuOpen}
								onOpenChange={setComposerMenuOpen}
							>
								<DropdownMenuTrigger
									render={
										<Button
											type="button"
											size="icon-sm"
											variant="ghost"
											aria-label="Composer options"
											icon={<Plus size={16} />}
										/>
									}
								/>
								<DropdownMenuContent
									align="start"
									className="w-[360px] max-w-[calc(100vw-16px)]"
								>
									<DropdownMenuGroup>
										<DropdownMenuLabel>Add</DropdownMenuLabel>
										<DropdownMenuItem
											onClick={() => attachmentInputRef.current?.click()}
										>
											<Paperclip size={18} aria-hidden="true" />
											<span className="min-w-0 text-left">
												<span className="block">Attach files</span>
												<span className="block whitespace-nowrap text-xs text-kumo-subtle">
													Add files to your message.
												</span>
											</span>
										</DropdownMenuItem>
										<DropdownMenuItem onClick={() => setDirectReadOpen(true)}>
											<MagnifyingGlass size={18} aria-hidden="true" />
											<span className="min-w-0 text-left">
												<span className="block">Read from connected app</span>
												<span className="block whitespace-nowrap text-xs text-kumo-subtle">
													Choose an app and read its data.
												</span>
											</span>
										</DropdownMenuItem>
									</DropdownMenuGroup>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel>Commands</DropdownMenuLabel>
										{reachableSkills.length > 0 ? (
											<DropdownMenuItem
												onClick={() => {
													setSkillPickerDismissed(false);
													setSkillActiveIndex(-1);
													setSkillSearch("");
												}}
											>
												<Sparkle size={18} aria-hidden="true" />
												<span className="min-w-0 text-left">
													<span className="block">Use a skill…</span>
													<span className="block whitespace-nowrap text-xs text-kumo-subtle">
														Find and use an available skill.
													</span>
												</span>
											</DropdownMenuItem>
										) : null}
										{chatSlashCommands(
											reachableSkills,
											composerTools.data?.commands ?? [],
										).map((item) => (
											<DropdownMenuItem
												key={item.command}
												onClick={() =>
													updateDraft(`${item.instruction}\n\n${draft}`.trim())
												}
											>
												<item.icon size={18} aria-hidden="true" />
												<span className="min-w-0 text-left">
													<span className="block">{item.command}</span>
													<span className="block whitespace-nowrap text-xs text-kumo-subtle">
														{item.description}
													</span>
												</span>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel>Create</DropdownMenuLabel>
										{CHAT_FORMATS.map((format) => {
											const option = CHAT_CREATE_OPTIONS[format];
											return (
												<DropdownMenuItem
													key={format}
													onClick={() =>
														updateDraft(
															`${draft}${draft ? "\n\n" : ""}Create a ${format} output for this request.`,
														)
													}
												>
													<option.icon size={18} aria-hidden="true" />
													<span className="min-w-0 text-left">
														<span className="block">Create {format}</span>
														<span className="block whitespace-nowrap text-xs text-kumo-subtle">
															{option.description}
														</span>
													</span>
												</DropdownMenuItem>
											);
										})}
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>
							{context ? (
								<Button
									type="button"
									size="sm"
									className="chat-composer-chip"
									variant={includeContext ? "outline" : "ghost"}
									aria-pressed={includeContext}
									title={context.label}
									onClick={() => setIncludeContext((value) => !value)}
									icon={<Paperclip size={14} aria-hidden="true" />}
								>
									<span className="chat-composer-label">{context.label}</span>
								</Button>
							) : null}
							<Text
								as="span"
								role="label"
								className="chat-composer-hint truncate text-kumo-subtle"
							>
								Enter to send · Shift+Enter for a new line
							</Text>
						</div>
						<div className="chat-composer-submit">
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="Start dictation"
								disabled={send.isPending}
								onClick={() => void dictation.start().catch(() => undefined)}
								icon={<Microphone size={16} />}
							/>
							{activeTedis.length > 0 ? (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												type="button"
												size="sm"
												variant="ghost"
												className="chat-composer-picker"
												aria-label={`Send to ${selectedTediName ?? "Home"}`}
											>
												<span className="truncate">
													{selectedTediName ?? "Home"}
												</span>
											</Button>
										}
									/>
									<DropdownMenuContent>
										<DropdownMenuItem onClick={() => setSelectedTediId(null)}>
											Home (picks for you)
										</DropdownMenuItem>
										{activeTedis.map((tedi) => (
											<DropdownMenuItem
												key={tedi.id}
												onClick={() => setSelectedTediId(tedi.id)}
											>
												{tedi.name}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							) : null}
							{localWorkersAi ? (
								<Text
									as="span"
									role="label"
									tone="secondary"
									title="Model configured by the local launcher; inference billed to your inference account"
								>
									Auto
								</Text>
							) : (
								<ChatModelPicker
									models={resolvableModels}
									choices={selectableModels}
									selectedRef={selectedModelRef}
									onSelect={(ref) => {
										setSelectedModelRef(ref);
										// The refusal is re-derived from the new selection;
										// the stale one must not outlive it.
										setAttachmentError(null);
									}}
								/>
							)}
							{/* While a run can be stopped and nothing is typed, the send
							    slot IS Stop. Typing turns it back into the submit control,
							    which queues steering text or answers an approval. */}
							{pendingRun &&
							isStoppableRunStatus(pendingRun.status) &&
							!draft.trim() &&
							attachments.length === 0 ? (
								<Button
									type="button"
									size="icon-sm"
									aria-label="Stop"
									title="Stop"
									icon={<Square size={14} weight="fill" />}
									disabled={cancelRun.isPending || retryRun.isPending}
									onClick={() => cancelRun.mutate({ runId: pendingRun.id })}
								/>
							) : (
								<Button
									type="submit"
									size="icon-sm"
									aria-label={
										steeringRunId ? "Queue steering message" : "Send message"
									}
									// No spinner here: the sending bubble and the running row
									// already say the message is on its way.
									icon={<ArrowUp size={16} weight="bold" />}
									disabled={
										preparingAttachments ||
										send.isPending ||
										steer.isPending ||
										cancelRun.isPending ||
										firstSendInFlight !== null ||
										directRead.isPending ||
										blockedByAttachedImage ||
										(localAiUnavailable && !parseDirectReadCommand(draft)) ||
										(!draft.trim() && attachments.length === 0)
									}
								/>
							)}
						</div>
					</div>
				) : null}
			</form>
			{conversationId && !composerOnly ? (
				<ConversationUsageLine
					conversationId={conversationId}
					settledRunCount={
						(runSet?.runs.length ?? 0) - (runSet?.activeRunIds.length ?? 0)
					}
				/>
			) : null}
		</div>
	);
}
