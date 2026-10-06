import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type {
	CapnConversationSnapshot,
	CapnConversationStub,
	CapnEventFrame,
	CapnSessionStub,
	CapnStreamCursor,
	CapnSubscriber,
} from "@/capnweb/contract";
import type { ConversationStreamFrame } from "./conversation-stream";
import { subscribeLiveWorkspace } from "./live-workspace-projection";
import { homeRunSetQueryKey } from "./os-query-options";
import {
	createProjectionEnvelope,
	type ProjectionEnvelope,
} from "./projection-envelope";
import {
	configureRealtimeTeardown,
	type RealtimeStreamConfig,
	realtimeSubscriberCount,
	realtimeSubscriptionCount,
	resetRealtimeConnections,
	setActiveRealtimeConversation,
} from "./realtime-connection";
import {
	createRealtimeFrameHandler,
	resetRealtimePumps,
	useRealtimeSurface,
} from "./use-realtime";

const CONVERSATION_ID = "home:main";
const ORG_ID = "org-1";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "workspace-1";
const SINCE = Date.parse("2026-08-16T10:00:00.000Z");

function frame(
	overrides: Partial<RuntimeStreamEvent> & { offset?: number } = {},
): ConversationStreamFrame {
	const { offset = 0, ...rest } = overrides;
	const event: RuntimeStreamEvent = {
		id: rest.id ?? `evt-${offset}`,
		kind: rest.kind ?? "run.started",
		conversationId: CONVERSATION_ID,
		runId: RUN_ID,
		createdAt: "2026-08-16T10:00:01.000Z",
		...rest,
	};
	return {
		offset,
		eventId: `${CONVERSATION_ID}:${RUN_ID}:${offset}`,
		event,
	};
}

function wireFrame(streamFrame: ConversationStreamFrame): CapnEventFrame {
	return {
		conversationId: CONVERSATION_ID,
		runId: RUN_ID,
		offset: streamFrame.offset,
		nextOffset: streamFrame.offset + 1,
		event: streamFrame.event,
	};
}

/**
 * The SHARED envelope as the connection manager actually builds it — never
 * hand-shaped: `createProjectionEnvelope` is the same function
 * `realtime-connection.ts` calls at its fan-out point, so a fixture here
 * cannot invent a field the wire does not carry.
 */
function deliver(
	handle: (
		streamFrame: ConversationStreamFrame,
		envelope: ProjectionEnvelope,
	) => void,
	streamFrame: ConversationStreamFrame,
	generation: number,
	replay = false,
): void {
	handle(
		streamFrame,
		createProjectionEnvelope({ generation, replay, frame: streamFrame }),
	);
}

/** One fake `/capn` server — the same double `realtime-connection.test.ts` uses. */
function mockServer() {
	const subscribers = new Map<string, CapnSubscriber>();
	const brokenCallbacks: Array<(error: unknown) => void> = [];

	const conversationFor = (conversationId: string): CapnConversationStub => {
		const snapshotFor = (
			cursor: CapnStreamCursor | null,
		): CapnConversationSnapshot => ({
			conversationId,
			runId: cursor?.runId ?? RUN_ID,
			events: [],
			cursor: { runId: cursor?.runId ?? RUN_ID, offset: cursor?.offset ?? 0 },
			stream: {
				streamId: "stream-1",
				offset: cursor?.offset ?? 0,
				nextOffset: cursor?.offset ?? 0,
				closed: false,
			},
		});
		return {
			snapshot: async (cursor) => snapshotFor(cursor ?? null),
			subscribe: async (callback) => {
				subscribers.set(conversationId, callback);
				return { [Symbol.dispose]: () => {} };
			},
			enqueue: async (_input: { content: string }, idempotencyKey: string) =>
				({ idempotencyKey }) as never,
			cancel: (async () => ({})) as unknown as CapnConversationStub["cancel"],
			respondApproval: async () => ({}) as never,
			[Symbol.dispose]: () => {},
		};
	};

	const root: CapnSessionStub = {
		ping: async () => {},
		openConversation: (conversationId: string) => {
			const conversation = conversationFor(conversationId);
			const settled = Promise.resolve(conversation);
			return new Proxy(
				(() => {}) as unknown as Promise<CapnConversationStub> &
					CapnConversationStub,
				{
					get(_target, property) {
						if (
							property === "then" ||
							property === "catch" ||
							property === "finally"
						) {
							return (settled[property] as (...args: never[]) => unknown).bind(
								settled,
							);
						}
						const inner = (conversation as Record<PropertyKey, unknown>)[
							property
						];
						return typeof inner === "function"
							? inner.bind(conversation)
							: inner;
					},
				},
			);
		},
		onRpcBroken: (callback) => {
			brokenCallbacks.push(callback);
		},
		[Symbol.dispose]: () => {},
	};

	let dials = 0;
	return {
		root,
		connect: async (): Promise<CapnSessionStub> => {
			dials += 1;
			return root;
		},
		dialCount: () => dials,
		emit: (conversationId: string, entry: CapnEventFrame) =>
			subscribers.get(conversationId)?.(entry),
		breakConnection: (error: unknown = new Error("socket died")) => {
			for (const callback of brokenCallbacks) callback(error);
		},
	};
}

const flushAsync = () =>
	act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function client() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

function seedRunSet(queryClient: QueryClient) {
	queryClient.setQueryData(homeRunSetQueryKey(CONVERSATION_ID), {
		runSet: {
			organizationId: ORG_ID,
			conversationId: CONVERSATION_ID,
			activeRunIds: [],
			runs: [
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: CONVERSATION_ID,
					status: "queued",
					createdAt: "2026-08-16T09:59:00.000Z",
				},
			],
		},
	});
}

function runStatus(queryClient: QueryClient): string | undefined {
	return queryClient.getQueryData<{
		runSet: { runs: Array<{ id: string; status: string }> };
	}>(homeRunSetQueryKey(CONVERSATION_ID))?.runSet.runs[0]?.status;
}

// ---------------------------------------------------------------------------
// The generation guard
// ---------------------------------------------------------------------------

function frameHandlerFixture() {
	const queryClient = client();
	seedRunSet(queryClient);
	const published: string[] = [];
	const unsubscribe = subscribeLiveWorkspace(WORKSPACE_ID, (event) => {
		published.push(event.id);
	});
	cleanups.push(unsubscribe);
	return {
		queryClient,
		published,
		handle: createRealtimeFrameHandler({
			queryClient,
			conversationId: CONVERSATION_ID,
			since: SINCE,
		}),
	};
}

function workspaceFrame(overrides: Partial<RuntimeStreamEvent> = {}) {
	return frame({ payload: { workspaceId: WORKSPACE_ID }, ...overrides });
}

describe("createRealtimeFrameHandler", () => {
	it("rejects superseded frames from both query caches and workspace listeners", () => {
		const { queryClient, published, handle } = frameHandlerFixture();
		deliver(handle, workspaceFrame({ id: "started", kind: "run.started" }), 1);
		expect(runStatus(queryClient)).toBe("running");
		deliver(
			handle,
			workspaceFrame({ id: "completed", kind: "run.completed" }),
			2,
		);
		expect(runStatus(queryClient)).toBe("completed");
		deliver(handle, workspaceFrame({ id: "stale", kind: "run.started" }), 1);
		expect(runStatus(queryClient)).toBe("completed");
		expect(published).toEqual(["started", "completed"]);
	});

	it("applies the history cutoff before patching or publishing", () => {
		const { queryClient, published, handle } = frameHandlerFixture();
		deliver(
			handle,
			workspaceFrame({
				kind: "run.completed",
				createdAt: "2026-08-15T00:00:00.000Z",
			}),
			1,
		);
		expect(runStatus(queryClient)).toBe("queued");
		expect(published).toEqual([]);
	});

	it("suppresses cache patches and workspace publication for replayed frames", () => {
		const { queryClient, published, handle } = frameHandlerFixture();
		deliver(handle, workspaceFrame({ kind: "run.completed" }), 1, true);
		expect(runStatus(queryClient)).toBe("queued");
		expect(published).toEqual([]);
	});

	it.each(["replay", "history"] as const)(
		"advances generation even when the newer frame is suppressed by %s",
		(suppression) => {
			const { queryClient, published, handle } = frameHandlerFixture();
			deliver(
				handle,
				workspaceFrame({ id: "started", kind: "run.started" }),
				1,
			);
			deliver(
				handle,
				workspaceFrame({
					id: "suppressed",
					kind: "run.completed",
					...(suppression === "history"
						? { createdAt: "2026-08-15T00:00:00.000Z" }
						: {}),
				}),
				2,
				suppression === "replay",
			);
			deliver(handle, workspaceFrame({ id: "stale", kind: "run.failed" }), 1);
			expect(runStatus(queryClient)).toBe("running");
			expect(published).toEqual(["started"]);
			deliver(
				handle,
				workspaceFrame({ id: "completed", kind: "run.completed" }),
				2,
			);
			expect(runStatus(queryClient)).toBe("completed");
			expect(published).toEqual(["started", "completed"]);
		},
	);

	it("publishes workspace events even when their kind does not patch Home caches", () => {
		const { queryClient, published, handle } = frameHandlerFixture();
		deliver(
			handle,
			workspaceFrame({
				id: "workspace-event",
				kind: "message.delta",
				delta: "hi",
			}),
			1,
		);
		expect(runStatus(queryClient)).toBe("queued");
		expect(published).toEqual(["workspace-event"]);
	});
});

// ---------------------------------------------------------------------------
// useRealtimeSurface — fan-out
// ---------------------------------------------------------------------------

function manualTeardown() {
	const queue: Array<{ id: number; callback: () => void }> = [];
	let next = 1;
	return {
		timers: {
			schedule: (callback: () => void) => {
				const id = next;
				next += 1;
				queue.push({ id, callback });
				return id;
			},
			cancel: (handle: unknown) => {
				const index = queue.findIndex((entry) => entry.id === handle);
				if (index >= 0) queue.splice(index, 1);
			},
		},
		run() {
			for (const entry of queue.splice(0, queue.length)) entry.callback();
		},
	};
}

let teardown = manualTeardown();
const cleanups: Array<() => void> = [];

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	teardown = manualTeardown();
	configureRealtimeTeardown(teardown.timers);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0, cleanups.length)) cleanup();
	resetRealtimePumps();
	resetRealtimeConnections();
});

function render(node: ReactNode) {
	const queryClient = client();
	const container = document.createElement("div");
	const root: Root = createRoot(container);
	act(() => {
		root.render(
			createElement(QueryClientProvider, { client: queryClient }, node),
		);
	});
	cleanups.push(() => act(() => root.unmount()));
	return {
		queryClient,
		rerender: (next: ReactNode) =>
			act(() => {
				root.render(
					createElement(QueryClientProvider, { client: queryClient }, next),
				);
			}),
		unmount: () => act(() => root.unmount()),
	};
}

function Surface(props: { config: RealtimeStreamConfig }) {
	useRealtimeSurface({ config: props.config, now: () => SINCE });
	return null;
}

describe("useRealtimeSurface", () => {
	it("multiplexes several surfaces onto ONE subscription and ONE pump", async () => {
		const server = mockServer();
		setActiveRealtimeConversation(CONVERSATION_ID);
		const config: RealtimeStreamConfig = {
			connect: server.connect,
			metrics: null,
		};
		const rendered = render(
			createElement(
				"div",
				null,
				createElement(Surface, { key: "activity", config }),
				createElement(Surface, { key: "runs", config }),
				createElement(Surface, { key: "detail", config }),
			),
		);
		await flushAsync();

		// Three live surfaces, one wire connection. The server's subscription
		// ceiling is per session, so this is the difference between fitting and
		// not fitting inside it.
		expect(server.dialCount()).toBe(1);
		expect(realtimeSubscriptionCount()).toBe(1);
		expect(realtimeSubscriberCount()).toBe(1);

		seedRunSet(rendered.queryClient);
		const published: string[] = [];
		cleanups.push(
			subscribeLiveWorkspace(WORKSPACE_ID, (event) => {
				published.push(event.id);
			}),
		);
		act(() => {
			server.emit(
				CONVERSATION_ID,
				wireFrame(
					workspaceFrame({
						id: "shared-start",
						kind: "run.started",
					}),
				),
			);
		});
		expect(runStatus(rendered.queryClient)).toBe("running");
		expect(published).toEqual(["shared-start"]);

		rendered.unmount();
		teardown.run();
		expect(realtimeSubscriptionCount()).toBe(0);
	});

	it("subscribes to nothing when no conversation is active", async () => {
		const server = mockServer();
		setActiveRealtimeConversation(null);
		render(
			createElement(Surface, {
				config: { connect: server.connect, metrics: null },
			}),
		);
		await flushAsync();
		// No subscribers means no socket.
		expect(server.dialCount()).toBe(0);
		expect(realtimeSubscriptionCount()).toBe(0);
	});

	it("patches a live run event into the query cache through the pump", async () => {
		const server = mockServer();
		setActiveRealtimeConversation(CONVERSATION_ID);
		const rendered = render(
			createElement(Surface, {
				config: { connect: server.connect, metrics: null },
			}),
		);
		await flushAsync();
		seedRunSet(rendered.queryClient);
		act(() => {
			server.emit(CONVERSATION_ID, wireFrame(frame({ kind: "run.completed" })));
		});
		// A targeted in-place patch: no refetch, and activeRunIds re-derived.
		expect(runStatus(rendered.queryClient)).toBe("completed");
	});

	it("cancels reconnect work when the owning route unmounts after an error", async () => {
		const server = mockServer();
		const reconnects: Array<() => void> = [];
		const canceled = new Set<() => void>();
		setActiveRealtimeConversation(CONVERSATION_ID);
		const rendered = render(
			createElement(Surface, {
				config: {
					connect: server.connect,
					metrics: null,
					setTimeoutFn: (callback) => {
						reconnects.push(callback);
						return callback;
					},
					clearTimeoutFn: (handle) => {
						canceled.add(handle as () => void);
					},
				},
			}),
		);
		await flushAsync();
		act(() => {
			server.breakConnection();
		});
		await flushAsync();
		expect(reconnects.length).toBeGreaterThan(0);
		rendered.unmount();
		teardown.run();
		expect(canceled.has(reconnects[0] as () => void)).toBe(true);
		// Even a timer callback already queued by the host cannot resurrect it.
		reconnects[0]?.();
		expect(realtimeSubscriptionCount()).toBe(0);
	});
});
