/**
 * Test harness for the embed runtime (`embed.mjs`).
 *
 * Boots the real runtime in a happy-dom document, mounts one widget, and hands
 * the test its Shadow DOM plus a fake embedded transport. Every test therefore
 * observes what a host page would: rendered markup, SDK events, the requests
 * the widget makes, and the turn input it streams. Nothing reads the runtime's
 * source text.
 *
 * The fake transport lives on `globalThis` because each boot resets the module
 * registry so the runtime's IIFE runs fresh; the test file and the re-imported
 * mock factory must still share one transport.
 */
import { type Mock, vi } from "vite-plus/test";

type Frame = Record<string, unknown>;
type StreamInput = {
	clientRequestId: string;
	text: string;
	pageContext: Record<string, unknown>;
	modelRef?: string;
	reasoningEffort?: string;
};

export type FakeStream = {
	input: StreamInput;
	signal: AbortSignal;
	frame: (event: Frame) => void;
	finish: () => void;
	fail: (error: unknown) => void;
};

export type FakeClient = ReturnType<typeof createFakeEmbeddedClient>;

type Transport = {
	clients: FakeClient[];
	streams: FakeStream[];
	readTranscript: Mock<
		() => Promise<{ messages: Array<Record<string, unknown>> }>
	>;
	configure: (client: FakeClient) => void;
};

const TRANSPORT = Symbol.for("tedix.embed.test.transport");

export function transport(): Transport {
	const scope = globalThis as unknown as Record<symbol, Transport>;
	scope[TRANSPORT] ??= {
		clients: [],
		streams: [],
		readTranscript: vi.fn(async () => ({
			messages: [] as Array<Record<string, unknown>>,
		})),
		configure: () => {},
	};
	return scope[TRANSPORT];
}

function resetTransport() {
	const state = transport();
	state.clients.length = 0;
	state.streams.length = 0;
	state.readTranscript = vi.fn(async () => ({
		messages: [] as Array<Record<string, unknown>>,
	}));
	state.configure = () => {};
}

/** Stand-in for `@tedix/chat-transport/embedded-client`. */
export function createFakeEmbeddedClient(
	credentials: () => Promise<{ streamUrl: string; token: string }>,
	_connect?: unknown,
	observer: {
		onConnect?: () => void;
		onRetry?: (retry: { attempt: number; delayMs: number }) => void;
	} = {},
) {
	const state = transport();
	const client = {
		credentials,
		observer,
		readTranscript: vi.fn(async () => {
			await credentials();
			return state.readTranscript();
		}),
		stream: vi.fn(
			(
				input: StreamInput,
				onFrame: (frame: { event: Frame }) => void,
				signal: AbortSignal,
			) =>
				new Promise<void>((resolve, reject) => {
					const stream: FakeStream = {
						input,
						signal,
						frame: (event) => onFrame({ event }),
						finish: resolve,
						fail: reject,
					};
					signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
					void credentials().then(() => state.streams.push(stream), reject);
				}),
		),
		cancel: vi.fn(async (_clientRequestId: string) => {}),
		metrics: vi.fn(async (_batch: unknown) => ({})),
		dispose: vi.fn(),
		watchApprovals: vi.fn(
			(_apply: (result: { data: unknown[] }) => void, _options?: unknown) => ({
				dispose: vi.fn(),
				wake: vi.fn(),
			}),
		),
		resolveApproval: vi.fn(async (_id: string, _approved: boolean) => ({})),
		requestApproval: vi.fn(async (description: string) => ({
			id: "approval-requested",
			description,
		})),
		listConversationCapabilities: vi.fn(async () => ({ data: [] })),
		attachConversationCapability: vi.fn(async (input: unknown) => input),
		detachConversationCapability: vi.fn(async (id: string) => ({ id })),
		listConversationArtifactPins: vi.fn(async () => ({ data: [] })),
		attachConversationArtifactPin: vi.fn(async (input: unknown) => input),
		detachConversationArtifactPin: vi.fn(async (id: string) => ({ id })),
		callPortableTool: vi.fn(async (_input: unknown) => ({})),
		rankPortableTools: vi.fn(async (_input: unknown) => null as unknown),
	};
	state.clients.push(client);
	state.configure(client);
	return client;
}

export const tick = (ms = 0) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Let promise chains and animation frames settle. */
export async function settle(rounds = 4) {
	for (let round = 0; round < rounds; round += 1) await tick(20);
}

export const TENANT = "demo-shop";
export const THREADS_KEY = `tedix:threads:v2:${TENANT}`;
export const ACTIVE_THREAD_KEY = `tedix:thread:v2:${TENANT}`;
export const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type TedixApi = {
	init: (options: Record<string, unknown>) => TedixApi;
	boot: (options: Record<string, unknown>) => TedixApi;
	open: () => Promise<void>;
	close: () => void;
	ask: (message: string) => Promise<string>;
	update: (value: Record<string, unknown>) => TedixApi;
	context: (value: Record<string, unknown>) => void;
	track: (name: string, metadata?: Record<string, unknown>) => void;
	consent: (value: Record<string, unknown>) => TedixApi;
	deleteConversation: (id: string) => Promise<unknown>;
	capabilities: () => Promise<unknown>;
	attachCapability: (id: string, replayName: string) => Promise<unknown>;
	detachCapability: (id: string) => Promise<unknown>;
	artifactPins: () => Promise<unknown>;
	pinArtifactRevision: (id: string, replayName: string) => Promise<unknown>;
	detachArtifactPin: (id: string) => Promise<unknown>;
	status: () => Record<string, any>;
	diagnose: () => Promise<Record<string, any>>;
	shutdown: () => void;
	on: (event: string, callback: (detail: unknown) => void) => () => void;
};

export type BootOptions = {
	/** Mount options handed to `Tedix.init`. */
	options?: Record<string, unknown>;
	/** `data-*` attributes on the embed script. */
	dataset?: Record<string, string>;
	/** Runs after the page is reset, before the runtime loads. */
	before?: () => void;
	/** The embed script's own URL. */
	src?: string;
	/** Skip `Tedix.init` (auto-mount and loader-queue paths). */
	mount?: boolean;
};

const EVENTS = [
	"loaded",
	"ready",
	"opened",
	"closed",
	"error",
	"performance",
	"session-refreshed",
	"message-submitted",
	"first-token",
	"answer-completed",
	"answer-failed",
	"answer-cancelled",
	"consent",
	"shutdown",
	"conversationDeleted",
	"voice",
];

let active: { Tedix: TedixApi; dispose: () => void } | null = null;

export function teardown() {
	active?.dispose();
	active = null;
}

export async function bootWidget(boot: BootOptions = {}) {
	teardown();
	// Framed MCP App results must never reach the network from a test.
	const settings = (
		window as unknown as {
			happyDOM?: { settings: Record<string, unknown> };
		}
	).happyDOM?.settings;
	if (settings) {
		settings.disableIframePageLoading = true;
		settings.disableJavaScriptFileLoading = true;
		settings.disableCSSFileLoading = true;
	}
	vi.resetModules();
	resetTransport();
	document.body.innerHTML = "";
	document.head.innerHTML = "";
	document.documentElement.lang = "en-US";
	document.documentElement.className = "";
	delete document.documentElement.dataset.theme;
	sessionStorage.clear();
	delete (window as unknown as { Tedix?: unknown }).Tedix;
	const fetch = vi.fn(
		async (_url: unknown, _init?: RequestInit) =>
			new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
	);
	globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
	const events: Array<{ event: string; detail: Record<string, any> }> = [];
	const listeners = EVENTS.map((event) => {
		const listener = (entry: Event) =>
			events.push({
				event,
				detail: (entry as CustomEvent).detail as Record<string, any>,
			});
		window.addEventListener(`tedix:${event}`, listener);
		return () => window.removeEventListener(`tedix:${event}`, listener);
	});
	const script = document.createElement("script");
	// Inert: the runtime reads the tag's attributes, the test loads the code.
	script.type = "text/plain";
	script.src = boot.src ?? "https://widget.tedix.dev/embed.js";
	script.dataset.tedixTenant = TENANT;
	for (const [key, value] of Object.entries(boot.dataset ?? {}))
		script.dataset[key] = value;
	document.head.append(script);
	boot.before?.();
	await import("./embed.mjs");
	const Tedix = (window as unknown as { Tedix: TedixApi }).Tedix;
	const session = vi.fn(async (_request: Record<string, unknown>) => ({
		token: "session-token",
		streamUrl: "wss://acme.tedi.tedix.dev/embedded",
		expiresAt: Date.now() + 3_600_000,
	}));
	if (boot.mount !== false)
		Tedix.init({ script, branding: false, session, ...boot.options });
	await settle(2);
	active = {
		Tedix,
		dispose: () => {
			try {
				Tedix.shutdown();
			} catch {
				// A test may already have shut the runtime down.
			}
			for (const remove of listeners) remove();
		},
	};
	return widget(Tedix, { script, session, fetch, events });
}

function widget(
	Tedix: TedixApi,
	context: {
		script: HTMLScriptElement;
		session: ReturnType<typeof vi.fn>;
		fetch: ReturnType<typeof vi.fn>;
		events: Array<{ event: string; detail: Record<string, any> }>;
	},
) {
	const host = () => document.querySelector<HTMLElement>("[data-tedix-widget]");
	const root = () => {
		const shadow = host()?.shadowRoot;
		if (!shadow) throw new Error("the widget is not mounted");
		return shadow;
	};
	const $ = <T extends Element = HTMLElement>(selector: string) =>
		root().querySelector<T & Element>(selector) as T | null;
	const $$ = <T extends Element = HTMLElement>(selector: string) => [
		...root().querySelectorAll<T & Element>(selector),
	];
	const input = () => $<HTMLTextAreaElement>(".tedix-input")!;
	const send = () => $<HTMLButtonElement>(".tedix-send")!;
	const thread = () => $<HTMLElement>(".tedix-thread")!;
	const client = () => {
		const clients = transport().clients;
		return clients[clients.length - 1];
	};
	const type = (text: string) => {
		input().value = text;
		input().dispatchEvent(new Event("input"));
	};
	const submitForm = (submitter?: HTMLElement) => {
		const form = $<HTMLFormElement>(".tedix-form")!;
		const event = new Event("submit", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "submitter", { value: submitter ?? null });
		form.dispatchEvent(event);
	};
	const pressEnter = (init: KeyboardEventInit = {}) =>
		input().dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				bubbles: true,
				cancelable: true,
				...init,
			}),
		);
	const waitForStream = async (count = 1) => {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (transport().streams.length >= count)
				return transport().streams[count - 1]!;
			await tick(10);
		}
		throw new Error(`stream ${count} never started`);
	};
	return {
		Tedix,
		...context,
		host,
		root,
		$,
		$$,
		input,
		send,
		thread,
		client,
		transport,
		type,
		submitForm,
		pressEnter,
		waitForStream,
		/** Opens the panel the way a customer does: the launcher. */
		open: async () => {
			$<HTMLButtonElement>(".tedix-launcher")!.click();
			await settle();
		},
		/** Types and sends a message through the composer. */
		say: async (text: string) => {
			type(text);
			submitForm();
			await tick(0);
		},
		messages: () =>
			$$<HTMLElement>(".tedix-message").map((item) => [
				item.dataset.role,
				item.querySelector(".tedix-bubble")?.textContent?.trim() ?? "",
			]),
		eventNames: () => context.events.map(({ event }) => event),
		detailsOf: (name: string) =>
			context.events
				.filter(({ event }) => event === name)
				.map(({ detail }) => detail),
	};
}

export type Widget = Awaited<ReturnType<typeof bootWidget>>;

/** A session answer that also carries a model roster or tedi selection. */
export function sessionResult(extra: Record<string, unknown> = {}) {
	return {
		token: "session-token",
		streamUrl: "wss://acme.tedi.tedix.dev/embedded",
		expiresAt: Date.now() + 3_600_000,
		...extra,
	};
}

/** A WebMCP host that records the tools the runtime projects onto it. */
export function modelContextHost() {
	const tools = new Map<
		string,
		{ execute: (args: unknown, options?: unknown) => Promise<unknown> }
	>();
	const host = {
		tools,
		provideContext: vi.fn(
			(value: {
				tools: Array<{
					name: string;
					execute: (args: unknown, options?: unknown) => Promise<unknown>;
				}>;
			}) => {
				tools.clear();
				for (const tool of value.tools) tools.set(tool.name, tool);
			},
		),
	};
	return host;
}
