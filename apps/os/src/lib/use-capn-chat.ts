/**
 * Cap'n Web chat transport — the React half.
 *
 * A browser-session PROJECTION over the existing canonical machinery: the
 * kernelRuntime oRPC handlers behind the OS worker's API_SERVICE binding
 * remain the ONLY business logic. The `/capn` WebSocket adds no verb that
 * oRPC lacks — `enqueue`, `cancel`, and `respondApproval` are the same
 * canonical calls carried over a different transport, and the events are the
 * same `kernelRuntime/readRunEvents` durable log.
 *
 * Cap'n Web is the only event transport; there is no SSE fallback lane. When the socket cannot establish, the connection
 * manager flips `RealtimeStatusSnapshot.degraded` (visible chip + polling in
 * ChatThread) and MUTATIONS fall back to the identical oRPC calls below —
 * sends never depended on the socket.
 *
 * The wire contract and the connection machine live elsewhere:
 * - `@/capnweb/contract`     the ONE RPC declaration, shared with the Worker.
 * - `./capn-chat-machine`    the framework-free machine, driven directly by
 *                            the real-socket roundtrip test in a workerd
 *                            isolate (React cannot be loaded there).
 * - `./overlay-state`        the pure provisional-overlay reducer.
 */

import type {
	EnqueueHomeMessageInput,
	EnqueueHomeMessageOutput,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	CapnConnectFn,
	CapnRespondApprovalParams,
} from "@/capnweb/contract";
import { osApi, osChatMutationApi } from "@/lib/api";
import { uploadChatAttachments } from "./chat-attachment-upload";
import {
	type CapnChatActions,
	CapnNotConnectedError,
	isOutcomeUnknown,
} from "@/lib/capn-chat-machine";
import {
	getSharedTransportMetrics,
	type TransportMetrics,
} from "@/lib/capn-measurement";
import type { ClientTurnMilestoneName } from "@tedix/chat-transport/client-turn-milestones";
import {
	armNativeTurn,
	bindNativeTurn,
	finishNativeTurn,
	markNativeTurnMilestone,
	readNativeTurn,
} from "@/lib/native-turn-milestones";
import {
	type ConversationStreamStatus,
	createFrameCoalescer,
	defaultFrameScheduler,
	type FrameCoalescer,
	type FrameScheduler,
} from "@/lib/conversation-stream";
import {
	applyOverlayEvent,
	createOverlayState,
	listOverlays,
	type StreamedOverlay,
} from "@/lib/overlay-state";
import {
	acquireConversationStream,
	setActiveRealtimeConversation,
} from "@/lib/realtime-connection";

// ---------------------------------------------------------------------------
// useCapnStreamedOverlays — stream + overlay reducer + rAF-coalesced delivery
// ---------------------------------------------------------------------------

export type UseStreamedOverlaysOptions = {
	/**
	 * Raw frame tap for consumers that fold additional state (tool cards).
	 * Receives hydrated events too, flagged by `source` so the consumer can
	 * fold tool cards from both history and the live stream.
	 */
	onFrame?: (event: RuntimeStreamEvent, source: "live" | "hydrate") => void;
	/**
	 * Historical events for ACTIVE runs, applied ONCE per conversation into
	 * the overlay state before/alongside live frames. Flows through the SAME
	 * `applyOverlayEvent` fold as live frames, so overlap with re-delivered
	 * frames is harmless (dedupe by sequence / idempotent finalization).
	 * Events not relevant to overlays are ignored as usual. Leave undefined
	 * (or empty) until loaded — the once-per-conversation guard arms on the
	 * first non-empty batch.
	 */
	hydrate?: RuntimeStreamEvent[];
	/**
	 * Runs EXEMPT from the `since` cutoff: a frame whose `event.runId` is in
	 * this list is processed even when created before `since`, so a reload
	 * mid-run streams the remainder of an in-flight turn. Everything else
	 * keeps the storm-guard cutoff.
	 */
	activeRunIds?: string[];
	/**
	 * Epoch ms cutoff: events created before it are ignored entirely (unless
	 * their run is in `activeRunIds`). The conversation stream replays history
	 * on first connect; without a cutoff every historical durable event would
	 * fire an invalidation and storm the API (observed live: hundreds of
	 * refetches, 429s). The transcript owns history via readMessages; the
	 * stream only needs NOW.
	 */
	since?: number;
	enabled?: boolean;
	frameScheduler?: FrameScheduler;
};

export type UseStreamedOverlaysResult = {
	supported: boolean;
	status: ConversationStreamStatus;
	/** Provisional per-run assistant overlays, rAF-coalesced. */
	overlays: StreamedOverlay[];
};

export type UseCapnChatOptions = UseStreamedOverlaysOptions & {
	connect?: CapnConnectFn;
	/** Injectable for tests; defaults to the dev-only shared harness. */
	metrics?: TransportMetrics | null;
	/** Injectable backoff clock, mirroring `RealtimeStreamConfig`. */
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
};

export type UseCapnChatResult = UseStreamedOverlaysResult & {
	/** Canonical-verb passthroughs; null until the session is open-capable. */
	actions: CapnChatActions | null;
};

export function isCapnSupported(): boolean {
	return typeof WebSocket !== "undefined";
}

/**
 * The overlay contract over the Cap'n machine: hydrate-once, `since` storm
 * guard with `activeRunIds` exemption, durable tap, rAF-coalesced overlays.
 */
export function useCapnStreamedOverlays(
	conversationId: string | null,
	options: UseCapnChatOptions = {},
): UseCapnChatResult {
	const supported = options.connect !== undefined || isCapnSupported();
	const enabled = options.enabled ?? true;
	const [status, setStatus] = useState<ConversationStreamStatus>("idle");
	const [actions, setActions] = useState<CapnChatActions | null>(null);
	const stateRef = useRef(createOverlayState());
	const [overlays, setOverlays] = useState<
		UseStreamedOverlaysResult["overlays"]
	>([]);
	const hydratedForRef = useRef<string | null>(null);

	const coalescerRef = useRef<FrameCoalescer | null>(null);
	const frameSchedulerRef = useRef(options.frameScheduler);
	frameSchedulerRef.current = options.frameScheduler;
	const ensureCoalescer = useCallback((): FrameCoalescer => {
		coalescerRef.current ??= createFrameCoalescer(() => {
			setOverlays(listOverlays(stateRef.current));
		}, frameSchedulerRef.current ?? defaultFrameScheduler);
		return coalescerRef.current;
	}, []);
	ensureCoalescer();
	// StrictMode double-invokes this effect: setup → cleanup → setup, with no
	// render in between. The ref outlives that cycle, so a cleanup that only
	// disposed would leave the SECOND setup holding an instance whose
	// `disposed` flag is already latched — and `schedule()` early-returns on it
	// forever. `setOverlays` would then never fire again, so streamed text
	// and phase rows never render in any dev session. Clearing the
	// ref on teardown makes the next setup mint a live one.
	useEffect(() => {
		const coalescer = ensureCoalescer();
		return () => {
			coalescer.dispose();
			if (coalescerRef.current === coalescer) coalescerRef.current = null;
		};
	}, [ensureCoalescer]);

	// Per-render ref discipline: inline callbacks and fresh option identities
	// never re-create the machine.
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const connectRef = useRef(options.connect);
	connectRef.current = options.connect;
	const metricsRef = useRef<TransportMetrics | null>(null);
	metricsRef.current =
		options.metrics === undefined
			? getSharedTransportMetrics()
			: options.metrics;

	// One live-frame fold, rebuilt each render so `since`/`activeRunIds` stay
	// fresh.
	const processLiveFrameRef = useRef<(event: RuntimeStreamEvent) => void>(
		() => {},
	);
	processLiveFrameRef.current = (event) => {
		const current = optionsRef.current;
		if (
			current.since !== undefined &&
			Date.parse(event.createdAt) < current.since &&
			!(
				typeof event.runId === "string" &&
				current.activeRunIds?.includes(event.runId) === true
			)
		) {
			return;
		}
		current.onFrame?.(event, "live");
		if (applyOverlayEvent(stateRef.current, event)) {
			coalescerRef.current?.schedule();
		}
	};

	// New conversation → fresh overlay state and a fresh hydration slot.
	useEffect(() => {
		stateRef.current = createOverlayState();
		setOverlays([]);
		hydratedForRef.current = null;
	}, [conversationId]);

	// Hydration: fold historical active-run events through the SAME reducer as
	// live frames, exactly once per conversation. No `since` filter: the caller
	// curated the batch.
	const hydrate = options.hydrate;
	useEffect(() => {
		if (conversationId === null) return;
		if (hydrate === undefined || hydrate.length === 0) return;
		if (hydratedForRef.current === conversationId) return;
		// The caller clears its batch with a setState, which does not change this
		// prop within the SAME commit that first carries the new conversation id.
		// So the first render after a switch arrives here holding the PREVIOUS
		// conversation's events, and `applyOverlayEvent` keys only on runId — it
		// has no idea they are foreign. Folding them produced the old thread's
		// assistant bubble under the new thread's rows (`visibleOverlays` only
		// retires an overlay whose run appears in the CURRENT transcript, and
		// that run never will), and latching the slot below meant the new
		// conversation's own hydration was later skipped by this very guard.
		const own = hydrate.filter(
			(event) =>
				typeof event.conversationId !== "string" ||
				event.conversationId === conversationId,
		);
		// Nothing of ours in this batch: leave the slot unclaimed so the real
		// batch still hydrates when it arrives.
		if (own.length === 0) return;
		hydratedForRef.current = conversationId;
		for (const event of own) {
			optionsRef.current.onFrame?.(event, "hydrate");
			if (applyOverlayEvent(stateRef.current, event)) {
				coalescerRef.current?.schedule();
			}
		}
	}, [conversationId, hydrate]);

	// The stream itself belongs to the global connection manager: this hook
	// takes a ref-counted lease, so Home and every surface projecting the same
	// durable events ride ONE subscription on ONE shared socket. Leak
	// accounting, wire ledgers and stub tracking moved there with the ownership.
	useEffect(() => {
		if (!supported || !enabled || conversationId === null) {
			setStatus("idle");
			setActions(null);
			return;
		}
		const lease = acquireConversationStream(
			conversationId,
			{
				onFrame: (frame) => processLiveFrameRef.current(frame.event),
				onStatus: setStatus,
			},
			{
				connect: connectRef.current,
				metrics: metricsRef.current,
				setTimeoutFn: optionsRef.current.setTimeoutFn,
				clearTimeoutFn: optionsRef.current.clearTimeoutFn,
			},
		);
		setActions(lease.getActions());
		setStatus(lease.getStatus());
		return () => {
			lease.release();
			setActions(null);
			setStatus("idle");
		};
	}, [conversationId, supported, enabled]);

	return { supported, status, overlays, actions };
}

// ---------------------------------------------------------------------------
// useChatTransport — the ONE transport seam ChatThread consumes
// ---------------------------------------------------------------------------

export type ChatTransportActions = {
	enqueueMessage(
		input: Pick<
			EnqueueHomeMessageInput,
			| "conversationId"
			| "content"
			| "attachments"
			| "metadata"
			| "modelRef"
			| "workspaceContext"
		> & { idempotencyKey: string },
	): Promise<EnqueueHomeMessageOutput>;
	cancelRun(input: { runId: string }): Promise<unknown>;
	respondApproval(input: CapnRespondApprovalParams): Promise<unknown>;
};

export type ChatTransportResult = UseStreamedOverlaysResult & {
	actions: ChatTransportActions;
	/**
	 * Report that a run's durable assistant row is on screen. Only the thread
	 * knows this: `terminal_received` fires when the finalize frame lands, but
	 * the overlay is still what the reader sees until the durable row replaces
	 * it, and the gap between the two is exactly the render latency this
	 * milestone exists to measure. Deduped per run by the correlation store, so
	 * the thread may call it on every commit.
	 */
	recordRendered: (runId: string) => void;
};

export type UseChatTransportOptions = UseStreamedOverlaysOptions & {
	connect?: CapnConnectFn;
	/** Injectable for tests; defaults to the dev-only shared harness. */
	metrics?: TransportMetrics | null;
	/** Injectable backoff clock, mirroring `RealtimeStreamConfig`. */
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
};

/**
 * A Cap'n conversation capability is bound to the conversation that opened it.
 * The synthetic New state has no conversation yet, so it must never reuse a
 * capability from the previously selected thread while React is retiring that
 * lease in a passive effect.
 */
export function canUseBoundConversationCapability(
	conversationId: string | null,
	actions: CapnChatActions | null,
): actions is CapnChatActions {
	return conversationId !== null && actions !== null;
}

/**
 * A synthetic new thread has no id to bind into a conversation capability.
 * Its first send is therefore an explicit control-plane bootstrap, not a
 * fallback for a failed Cap'n call. The response supplies the durable id; all
 * subsequent conversation mutations travel through that bound capability.
 */
const NEW_CONVERSATION_ACTIONS: ChatTransportActions = {
	enqueueMessage: (input) =>
		osChatMutationApi.kernelRuntime.enqueueMessage(input),
	cancelRun: (input) => osApi.kernelRuntime.cancelRun(input),
	respondApproval: (input) =>
		osChatMutationApi.kernelRuntime.respondApproval(input),
};

/**
 * The transport seam: the Cap'n hook serves the overlay contract and the
 * canonical conversation verbs travel only through the `/capn` capability.
 * A disconnected established conversation is a visible unavailable state,
 * never a hidden oRPC retry. Only the synthetic new-thread bootstrap uses the
 * control plane because no conversation capability can exist yet.
 */
export function useChatTransport(
	conversationId: string | null,
	options: UseChatTransportOptions = {},
): ChatTransportResult {
	const metrics =
		options.metrics === undefined
			? getSharedTransportMetrics()
			: options.metrics;
	const metricsRef = useRef(metrics);
	metricsRef.current = metrics;

	const { connect, metrics: _metrics, ...streamOptions } = options;
	const onFrame = streamOptions.onFrame;
	const recordNativeMilestone = (
		milestone: ClientTurnMilestoneName,
		runId?: string,
		explicitConversationId?: string,
	) => {
		const correlation = runId
			? milestone === "submitted" || milestone === "acknowledged"
				? readNativeTurn(runId)
				: markNativeTurnMilestone(runId, milestone)
			: null;
		const correlatedConversationId =
			explicitConversationId ?? correlation?.conversationId ?? conversationId;
		if (!correlatedConversationId) return;
		if (runId && !correlation) return;
		const track = osApi.analytics?.trackWidgetLifecycle;
		if (!track) return;
		void track({
			events: [
				{
					event: "client_turn_milestone",
					eventId: crypto.randomUUID(),
					surface: "native_os",
					milestone,
					conversationId: correlatedConversationId,
					...(runId ? { runId, traceId: runId } : {}),
					durationMs: correlation
						? Math.max(0, Date.now() - correlation.startedAt)
						: 0,
				},
			],
		}).catch(() => {});
		// `rendered`, not `terminal_received`, ends the CLIENT turn: the reader is
		// still looking at the streaming overlay until the durable row lands, and
		// retiring the correlation at the finalize frame would drop the very
		// milestone that measures that gap. `failed` still ends it — nothing
		// renders after a failure. A turn abandoned before its row renders is
		// reclaimed by the correlation store's capacity bound.
		if ((milestone === "rendered" || milestone === "failed") && runId) {
			finishNativeTurn(runId);
		}
	};
	const instrumented: UseStreamedOverlaysOptions = {
		...streamOptions,
		onFrame: (event, source) => {
			const record = metricsRef.current;
			if (source === "live") {
				record?.recordEventId("capn", event.id);
				// The runtime's first progress signal, which normally precedes any
				// assistant text. `markNativeTurnMilestone` already dedupes per run,
				// so later phase transitions do not re-emit.
				if (event.kind === "message.phase" && typeof event.runId === "string") {
					recordNativeMilestone("first_phase", event.runId);
				}
				if (event.kind === "message.delta" && typeof event.runId === "string") {
					record?.markFirstAssistantDelta("capn", event.runId);
					recordNativeMilestone("first_text", event.runId);
				}
				if (
					(event.kind === "message.completed" ||
						event.kind === "run.completed") &&
					typeof event.runId === "string"
				) {
					recordNativeMilestone("terminal_received", event.runId);
				}
				if (
					(event.kind === "run.failed" || event.kind === "run.canceled") &&
					typeof event.runId === "string"
				) {
					recordNativeMilestone("failed", event.runId);
				}
			}
			onFrame?.(event, source);
		},
	};

	// Publish the conversation Home is working in. Surfaces with no capability
	// of their own (Activity, approvals, run state) join THIS stream through the
	// manager's ref-count rather than opening a second one.
	useEffect(() => {
		if (conversationId === null) return;
		setActiveRealtimeConversation(conversationId);
	}, [conversationId]);

	const capn = useCapnStreamedOverlays(conversationId, {
		...instrumented,
		connect,
		metrics,
	});

	// Reconnect-recovery measurement from status transitions.
	const previousStatusRef = useRef<ConversationStreamStatus>("idle");
	useEffect(() => {
		const previous = previousStatusRef.current;
		previousStatusRef.current = capn.status;
		const record = metricsRef.current;
		if (record === null) return;
		if (capn.status === "reconnecting" && previous !== "reconnecting") {
			record.markDisconnected("capn");
			recordNativeMilestone("reconnect_started");
		}
		if (capn.status === "open" && previous === "reconnecting") {
			record.markReconnected("capn");
			recordNativeMilestone("reconnect_recovered");
		}
	}, [capn.status]);

	const capnActions = capn.actions;
	const actions = useMemo<ChatTransportActions>(() => {
		const base: ChatTransportActions =
			conversationId === null
				? NEW_CONVERSATION_ACTIONS
				: canUseBoundConversationCapability(conversationId, capnActions)
					? {
							enqueueMessage: (input) =>
								capnActions.enqueue(
									{
										content: input.content,
										attachments: input.attachments,
										metadata: input.metadata,
										modelRef: input.modelRef,
									},
									input.idempotencyKey,
								),
							cancelRun: (input) => capnActions.cancel(input.runId),
							// Approval is a durable control-plane mutation, not a realtime
							// transport concern. Send it directly so a connected-but-stalled
							// Cap'n session cannot strand the visible approval card.
							respondApproval: NEW_CONVERSATION_ACTIONS.respondApproval,
						}
					: {
							enqueueMessage: async () => {
								throw new CapnNotConnectedError();
							},
							cancelRun: async () => {
								throw new CapnNotConnectedError();
							},
							respondApproval: NEW_CONVERSATION_ACTIONS.respondApproval,
						};
		return {
			...base,
			enqueueMessage: async (input) => {
				const record = metricsRef.current;
				armNativeTurn(input.idempotencyKey, input.conversationId);
				record?.markEnqueued("capn", input.idempotencyKey);
				recordNativeMilestone(
					"submitted",
					input.idempotencyKey,
					input.conversationId,
				);
				try {
					const attachments = await uploadChatAttachments(
						input.attachments,
						(attachment) =>
							osApi.kernelRuntime.uploadAttachment({
								...attachment,
								type: attachment.type === "image" ? "image" : "file",
							}),
					);
					const output = await base.enqueueMessage({ ...input, attachments });
					bindNativeTurn(input.idempotencyKey, output.conversationId);
					// The optimistic user bubble renders synchronously from this
					// response — settle time bounds send-to-visible.
					record?.markVisible("capn", input.idempotencyKey);
					recordNativeMilestone(
						"acknowledged",
						input.idempotencyKey,
						output.conversationId,
					);
					return output;
				} catch (error) {
					recordNativeMilestone("failed", input.idempotencyKey);
					if (isOutcomeUnknown(error)) {
						record?.recordUnknownOutcome("capn", input.idempotencyKey);
					}
					throw error;
				}
			},
		};
	}, [capnActions, conversationId]);

	return {
		supported: capn.supported,
		status: capn.status,
		overlays: capn.overlays,
		actions,
		recordRendered: (runId: string) => {
			recordNativeMilestone("rendered", runId);
		},
	};
}
