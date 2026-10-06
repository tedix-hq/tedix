/**
 * The `/capn` RPC contract — one Tedix-owned declaration imported by both
 * halves of the lane.
 *
 * Before this module existed, `use-capn-chat.ts` hand-wrote its own "binding
 * view" of the server and reached the socket through an `as unknown as` cast,
 * while `session-root.ts` returned a different shape and rejected the cursor
 * the client sent. Both test suites were green against separate fakes. The
 * fix is structural, not documentary: the server classes now `implements`
 * these interfaces and the browser's stub types are DERIVED from them with
 * `Parameters<>`/`ReturnType<>`, so a change on either side that the other
 * does not follow is a type error rather than a silent runtime divergence.
 *
 * ZERO runtime imports. Every import here is `import type`, so this module
 * compiles to nothing and carries no zod (or any other) byte into the browser
 * bundle; the two exported constants are the whole runtime surface. Keep it
 * that way — this file is imported by the OS worker AND the SPA.
 *
 * ---------------------------------------------------------------------------
 * DURABLE CURSOR SEMANTICS (the load-bearing part)
 * ---------------------------------------------------------------------------
 * The `/capn` lane projects `kernelRuntime.readRunEvents`, which is the
 * canonical durable replay verb (`kernel-events-stream.ts` says so in its own
 * header). Its offsets are RUN-LOCAL ordinals: consecutive indices starting at
 * `stream.offset` within ONE run, reset to 0 for the next run of the same
 * conversation. They are NOT the conversation-scoped array indices the SSE
 * frame ids carry, and treating them as such is what broke the pilot.
 *
 * So the cursor on this wire is explicitly a `(runId, offset)` pair:
 *
 * - {@link CapnStreamCursor}`.offset` is the NEXT offset to read — i.e. the
 *   previous frame's `nextOffset`. There is no inclusive/exclusive ambiguity
 *   and no negative sentinel: "I have nothing" is expressed by omitting the
 *   cursor (`null`/`undefined`), not by `-1`.
 * - A cursor is only ever applied to the run it names. When the server is
 *   following a different run than `cursor.runId`, it starts that run at 0,
 *   because the client has by definition seen none of it.
 * - Every {@link CapnEventFrame} carries `runId`, `offset` AND `nextOffset`,
 *   so the client's resume token is a value the server sent, never one the
 *   client recomputed.
 * - {@link capnFrameId} is the dedupe key: `{conversationId}:{runId}:{offset}`.
 *   Run-namespaced, so run 2's offset 0 can never collide with run 1's — the
 *   collision that silently dropped every event after the first run.
 */

import type {
	EnqueueHomeMessageInput,
	EnqueueHomeMessageOutput,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type {
	RuntimeStreamEvent,
	RuntimeStreamReceipt,
} from "@tedix/api-contract/schemas/runtime-submissions";

// ---------------------------------------------------------------------------
// Wire data shapes — identical on both sides, by construction
// ---------------------------------------------------------------------------

/**
 * Resume position in a run's durable event log.
 *
 * `offset` is the next offset to READ (the previous frame's `nextOffset`), and
 * it is meaningful only for `runId`. Absence of a cursor means "start at the
 * beginning of whatever run is current".
 */
export type CapnStreamCursor = {
	runId: string;
	offset: number;
};

/** One durable event as it crosses the wire, with its exact resume position. */
export type CapnEventFrame = {
	conversationId: string;
	runId: string;
	/** Run-local ordinal of this event (`readRunEvents` offset model). */
	offset: number;
	/** Resume cursor offset: the next offset to read after this event. */
	nextOffset: number;
	event: RuntimeStreamEvent;
};

/**
 * Event-log snapshot for a conversation from a cursor.
 *
 * Deliberately event-only: the durable transcript is served by
 * `kernelRuntime/readMessages` through React Query on the oRPC path, and the
 * pilot's version of this shape carried a `messages` array no client ever read
 * while paying an extra upstream round trip on every reconnect.
 */
export type CapnConversationSnapshot = {
	conversationId: string;
	/** The run `events` belong to; null when the conversation has no run yet. */
	runId: string | null;
	events: CapnEventFrame[];
	/** Pass verbatim to {@link CapnConversationApi.subscribe}; null when no run. */
	cursor: CapnStreamCursor | null;
	/** Durable receipt backing `cursor`; null when no run exists. */
	stream: RuntimeStreamReceipt | null;
};

/** Browser-facing enqueue payload (org/conversation/key are pinned server-side). */
export type CapnEnqueueInput = Pick<
	EnqueueHomeMessageInput,
	"content" | "attachments" | "metadata" | "modelRef"
>;

export type CapnRespondApprovalParams = {
	runId: string;
	decision: "approve" | "reject";
};

export type CapnCancelOutput = { run: HomeRun };

/**
 * The subscriber the browser hands to `subscribe`. It arrives server-side as a
 * capnweb function stub: callable, duplicable (`dup()`, required so the pump's
 * retained copy outlives the delivering call) and disposable.
 */
export interface CapnSubscriber {
	(frame: CapnEventFrame): unknown;
	dup?(): CapnSubscriber;
	[Symbol.dispose]?(): void;
}

/** Dedupe / correlation key for one delivered frame. Run-namespaced. */
export function capnFrameId(frame: {
	conversationId: string;
	runId: string;
	offset: number;
}): string {
	return `${frame.conversationId}:${frame.runId}:${frame.offset}`;
}

/**
 * Per-stream ledger key for the dev measurement harness. Offsets are run-local,
 * so a conversation-keyed ledger reports phantom gaps and phantom duplicates
 * the moment a second run starts.
 */
export function capnStreamKey(conversationId: string, runId: string): string {
	return `${conversationId}:${runId}`;
}

// ---------------------------------------------------------------------------
// Capability interfaces — what the SERVER implements
// ---------------------------------------------------------------------------

/** A live server-side subscription. `dispose()` ends the pump deterministically. */
export interface CapnSubscriptionApi {
	dispose(): void;
	isDisposed(): boolean;
	[Symbol.dispose](): void;
}

export interface CapnConversationApi {
	/** Durable events from `cursor` (or from the current run's start when null). */
	snapshot(cursor?: CapnStreamCursor | null): Promise<CapnConversationSnapshot>;
	/** Live tail from `cursor`; rolls forward across run boundaries. */
	subscribe(
		subscriber: CapnSubscriber,
		cursor?: CapnStreamCursor | null,
	): CapnSubscriptionApi;
	/** NEVER retried internally: an outcome-unknown failure reaches the caller. */
	enqueue(
		input: CapnEnqueueInput,
		idempotencyKey: string,
	): Promise<EnqueueHomeMessageOutput>;
	cancel(runId: string, reason?: string): Promise<CapnCancelOutput>;
	respondApproval(params: CapnRespondApprovalParams): Promise<unknown>;
}

export interface CapnSessionApi {
	/** Lightweight round trip used to detect a zombie browser socket on wake. */
	ping(): Promise<void>;
	openConversation(conversationId: string): CapnConversationApi;
	[Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// Stub projections — what the BROWSER holds, derived from the above
// ---------------------------------------------------------------------------

/**
 * capnweb memory-management surface present on every received stub. Optional
 * because a locally-constructed test double is a plain object; the machine
 * treats both identically.
 */
export type CapnStubLike = {
	[Symbol.dispose]?(): void;
	onRpcBroken?(callback: (error: unknown) => void): void;
};

/**
 * Client view of a capnweb method: same parameters, result always a promise.
 * Capability-returning methods are projected by hand below (their result is a
 * STUB, not the server object), everything else flows through this alias so
 * params and payloads can never drift from {@link CapnConversationApi}.
 */
type Returned<F> = F extends (...args: never[]) => infer R
	? Promise<Awaited<R>>
	: never;

/**
 * A capability result that can be USED before it resolves. capnweb returns an
 * `RpcPromise`, which is both a promise and a live stub: calls made on it are
 * pipelined to the peer in the same round trip that created it, so a caller
 * that awaits before chaining pays a full round trip for nothing.
 *
 * Typing capability returns this way is what makes the pipelined call site
 * type-check; awaiting one still works and stays correct.
 *
 * Note for anyone writing a double: capnweb's `RpcPromise` is a `Proxy` whose
 * target is a FUNCTION, so `typeof stub === "function"`, never `"object"`. A
 * guard that tests for `"object"` silently skips a real stub.
 */
export type CapnPipelined<T> = Promise<T> & T;

/**
 * The browser stops a subscription by DISPOSING the stub (capnweb runs the
 * target's `[Symbol.dispose]`), so no RPC verb is projected here — the server's
 * `dispose()`/`isDisposed()` exist for in-process callers and tests.
 */
export type CapnSubscriptionStub = CapnStubLike;

export type CapnConversationStub = CapnStubLike & {
	snapshot(
		...args: Parameters<CapnConversationApi["snapshot"]>
	): Returned<CapnConversationApi["snapshot"]>;
	subscribe(
		...args: Parameters<CapnConversationApi["subscribe"]>
	): Promise<CapnSubscriptionStub>;
	enqueue(
		...args: Parameters<CapnConversationApi["enqueue"]>
	): Returned<CapnConversationApi["enqueue"]>;
	cancel(
		...args: Parameters<CapnConversationApi["cancel"]>
	): Returned<CapnConversationApi["cancel"]>;
	respondApproval(
		...args: Parameters<CapnConversationApi["respondApproval"]>
	): Returned<CapnConversationApi["respondApproval"]>;
};

export type CapnSessionStub = CapnStubLike & {
	ping(
		...args: Parameters<CapnSessionApi["ping"]>
	): Returned<CapnSessionApi["ping"]>;
	openConversation(
		...args: Parameters<CapnSessionApi["openConversation"]>
	): CapnPipelined<CapnConversationStub>;
};

/** Injectable connection factory — production dials `wss://<host>/capn`. */
export type CapnConnectFn = () => Promise<CapnSessionStub>;

// ---------------------------------------------------------------------------
// Shared route constants
// ---------------------------------------------------------------------------

/** The one path this capability is served on. */
export const CAPN_ROUTE_PATH = "/capn";

/**
 * Max concurrently live subscriptions per session root — a SERVER limit, but
 * declared here because it binds the client too: the browser holds ONE shared
 * session (`capn-session-hub.ts`), so this is the ceiling on how many
 * capabilities the global connection manager may hold open at once across every
 * OS surface. Multiplexing many logical subscribers onto few server
 * subscriptions is the manager's job precisely because this number is small.
 */
export const CAPN_MAX_LIVE_SUBSCRIPTIONS = 4;
