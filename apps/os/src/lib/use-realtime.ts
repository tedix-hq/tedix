/**
 * React bindings for the shared conversation connection manager.
 * useRealtimeSurface retains one ref-counted pump per conversation to update
 * canonical query caches and publish workspace events. Status and active
 * conversation hooks expose the manager's document-wide state.
 *
 * Each pump tracks the newest connection generation before checking replay or
 * history cutoffs, so callbacks from superseded connections cannot update UI
 * state. Multiple surfaces share the pump and its single publication path.
 */

import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
	ConversationStreamFrame,
	ConversationStreamStatus,
} from "@/lib/conversation-stream";
import type { ProjectionEnvelope } from "@/lib/projection-envelope";
import {
	acquireConversationStream,
	getActiveRealtimeConversation,
	getRealtimeStatus,
	type RealtimeLease,
	type RealtimeStatusSnapshot,
	type RealtimeStreamConfig,
	subscribeActiveRealtimeConversation,
	subscribeRealtimeStatus,
} from "@/lib/realtime-connection";
import {
	patchQueryCachesFromEvent,
	REALTIME_PATCHED_EVENT_KINDS,
} from "@/lib/realtime-projections";
import { publishLiveWorkspaceEvent } from "@/lib/live-workspace-projection";

// ---------------------------------------------------------------------------
// Status + active conversation reads
// ---------------------------------------------------------------------------

export function useRealtimeStatus(): RealtimeStatusSnapshot {
	return useSyncExternalStore(
		subscribeRealtimeStatus,
		getRealtimeStatus,
		getRealtimeStatus,
	);
}

export function useActiveRealtimeConversation(): string | null {
	return useSyncExternalStore(
		subscribeActiveRealtimeConversation,
		getActiveRealtimeConversation,
		getActiveRealtimeConversation,
	);
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

type Pump = {
	conversationId: string;
	lease: RealtimeLease;
	refs: number;
};

const pumps = new Map<string, Pump>();

/**
 * The pump's frame handler, extracted so the generation guard is testable
 * directly: a reconnect race cannot be staged through a real transport, and a
 * guard that is only exercised by accident is a guard nobody knows works.
 *
 * `since` is the storm cutoff. The conversation stream replays FULL history on
 * connect; without it the pump would patch and invalidate once per historical
 * event — the storm that produced hundreds of refetches and 429s live. The
 * transcript and the run set own history through their reads.
 */
export function createRealtimeFrameHandler(options: {
	queryClient: QueryClient;
	conversationId: string;
	since: number;
}): (frame: ConversationStreamFrame, envelope: ProjectionEnvelope) => void {
	const { queryClient, conversationId, since } = options;
	let connectionGeneration = 0;
	return (frame, envelope) => {
		// GENERATION GUARD: a callback issued by a connection that has since died
		// must never mutate state the reconnect already re-established. The
		// generation is read off the shared envelope, so the guard and every other
		// projection agree on which connection a frame belongs to.
		if (envelope.generation < connectionGeneration) return;
		if (envelope.generation > connectionGeneration) {
			connectionGeneration = envelope.generation;
		}
		const event = frame.event;
		const at = Date.parse(envelope.createdAt);
		if (Number.isFinite(at) && at < since) return;
		// Replayed frames come from the stream's own buffer — already reflected in
		// the canonical reads. Patching on them would re-invalidate
		// history.
		if (envelope.replay) return;
		publishLiveWorkspaceEvent(event);
		if (!REALTIME_PATCHED_EVENT_KINDS.has(envelope.kind)) return;
		patchQueryCachesFromEvent(queryClient, event, conversationId);
	};
}

function retainPump(
	conversationId: string,
	queryClient: QueryClient,
	config: RealtimeStreamConfig,
	now: () => number,
): () => void {
	const existing = pumps.get(conversationId);
	if (existing !== undefined) {
		existing.refs += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			existing.refs -= 1;
			if (existing.refs === 0 && pumps.get(conversationId) === existing) {
				pumps.delete(conversationId);
				existing.lease.release();
			}
		};
	}

	const onFrame = createRealtimeFrameHandler({
		queryClient,
		conversationId,
		since: now(),
	});
	const pump: Pump = {
		conversationId,
		lease: acquireConversationStream(conversationId, { onFrame }, config),
		refs: 1,
	};
	pumps.set(conversationId, pump);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		pump.refs -= 1;
		if (pump.refs === 0 && pumps.get(conversationId) === pump) {
			pumps.delete(conversationId);
			pump.lease.release();
		}
	};
}

export type UseRealtimeSurfaceOptions = {
	/** Override the conversation to follow (Home passes its own). */
	conversationId?: string | null;
	enabled?: boolean;
	/** Transport seams, applied only when this acquire creates the stream. */
	config?: RealtimeStreamConfig;
	/** Injectable clock for the replay cutoff. */
	now?: () => number;
};

export type UseRealtimeSurfaceResult = {
	/** Conversation the surface is following; null when nothing is live. */
	conversationId: string | null;
	status: ConversationStreamStatus;
};

/**
 * Makes a surface live off the shared durable-event stream.
 *
 * Surfaces that have no capability of their own follow the conversation Home
 * published (`setActiveRealtimeConversation`). This is deliberately honest
 * about its reach: there is no org- or workspace-scoped forward tail in the
 * product, so work that never touched this conversation is not on this feed and
 * those surfaces still converge through their existing reads.
 */
export function useRealtimeSurface(
	options: UseRealtimeSurfaceOptions = {},
): UseRealtimeSurfaceResult {
	const queryClient = useQueryClient();
	const active = useActiveRealtimeConversation();
	const conversationId =
		options.conversationId === undefined ? active : options.conversationId;
	const enabled = options.enabled ?? true;
	// Creation-time seams held in refs: re-running the effect on their identity
	// would tear down a healthy stream on every render.
	const seamsRef = useRef({ config: options.config, now: options.now });
	seamsRef.current = { config: options.config, now: options.now };
	const aggregate = useRealtimeStatus();

	useEffect(() => {
		if (!enabled || conversationId === null) return;
		const { config, now } = seamsRef.current;
		return retainPump(
			conversationId,
			queryClient,
			config ?? {},
			now ?? Date.now,
		);
	}, [conversationId, enabled, queryClient]);

	return {
		conversationId,
		status: enabled && conversationId !== null ? aggregate.status : "idle",
	};
}

/** Test seam: drops every pump without waiting for a component to unmount. */
export function resetRealtimePumps(): void {
	// Snapshot: releasing a pump removes it from the map it iterates.
	const live = Array.from(pumps.values());
	for (const pump of live) pump.lease.release();
	pumps.clear();
}
