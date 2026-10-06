import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	EMBEDDED_SESSION_EXPIRED_MESSAGE,
	type EmbeddedCapabilityAdapter,
	type EmbeddedRoot,
} from "./embedded-capability";
import {
	EMBEDDED_STREAM_CURSOR_REJECTED,
	EMBEDDED_STREAM_NOT_STARTED_EXPIRED,
	type EmbeddedSessionStub,
	type EmbeddedTurnInput,
} from "./embedded-contract";
import {
	createEmbeddedClient,
	embeddedResumeWatermarkKey,
} from "./embedded-client";
import { createResumeWatermarkStore } from "./resume-watermark";
import { mountEmbeddedCapability } from "./embedded-mount";
const factory = vi.hoisted(() => vi.fn());
vi.mock("capnweb", async (original) => ({
	...(await original<typeof import("capnweb")>()),
	newWorkersWebSocketRpcResponse: factory,
}));
const roots: EmbeddedRoot[] = [];
function request(
	origin: string | null = "https://host.example",
	method = "GET",
	upgrade = "websocket",
) {
	const headers = new Headers({ Upgrade: upgrade });
	if (origin !== null) headers.set("Origin", origin);
	return new Request("https://runtime.example/embedded", { method, headers });
}
function mounted(adapter = {} as EmbeddedCapabilityAdapter) {
	mountEmbeddedCapability(request(), adapter);
	const [, root, options] = factory.mock.calls.at(-1)! as [
		Request,
		EmbeddedRoot,
		{ onSendError(error: unknown): Error },
	];
	return { root, sanitize: options.onSendError };
}
beforeEach(() => {
	factory.mockReset().mockImplementation((_request, root) => {
		roots.push(root);
		return new Response(null);
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	for (const root of roots.splice(0)) root[Symbol.dispose]();
	vi.restoreAllMocks();
});
describe("embedded mount RPC boundary", () => {
	it.each([
		EMBEDDED_SESSION_EXPIRED_MESSAGE,
		EMBEDDED_STREAM_NOT_STARTED_EXPIRED,
		EMBEDDED_STREAM_CURSOR_REJECTED,
	])("preserves fixed signal %s without attached details", (message) => {
		const original = Object.assign(
			new Error(message, { cause: new Error("private cause") }),
			{ providerDetails: "private details" },
		);
		const result = mounted().sanitize(original);
		expect(result).not.toBe(original);
		expect(result.message).toBe(message);
		expect(result.cause).toBeUndefined();
		expect(Object.keys(result)).toEqual([]);
	});
	it.each([
		new Error("private provider failure"),
		{ message: EMBEDDED_STREAM_CURSOR_REJECTED },
		new Error(`${EMBEDDED_STREAM_CURSOR_REJECTED}: private details`),
	])("sanitizes arbitrary error", (error) => {
		expect(mounted().sanitize(error).message).toBe(
			"The embedded capability call failed.",
		);
	});
	it.each([
		null,
		"null",
		"http://host.example",
		"https://host.example/path",
		"invalid",
	])("rejects invalid origin %s before mounting", (origin) => {
		expect(
			mountEmbeddedCapability(request(origin), {} as EmbeddedCapabilityAdapter)
				.status,
		).toBe(403);
		expect(factory).not.toHaveBeenCalled();
	});
	it.each([
		["POST", "websocket"],
		["GET", "http"],
	])("requires GET WebSocket (%s/%s)", (method, upgrade) => {
		expect(
			mountEmbeddedCapability(
				request("https://host.example", method, upgrade),
				{} as EmbeddedCapabilityAdapter,
			).status,
		).toBe(426);
		expect(factory).not.toHaveBeenCalled();
	});
	it("cold-opens a rejected parked cursor through capability and mount sanitization", async () => {
		const store = createResumeWatermarkStore<string>();
		const parked = store.open(
			embeddedResumeWatermarkKey("conversation", "request_123"),
		);
		parked.advance("old-run:1");
		parked.settle();
		parked.close();
		const dispatch = vi.fn(
			async () =>
				new Response('data: {"kind":"done","text":"Completed"}\n\n', {
					headers: { "Content-Type": "text/event-stream" },
				}),
		);
		const adapter = {
			authorize: async () => ({
				sessionKey: "session",
				subject: "user",
				tenant: "tenant",
				origin: "https://host.example",
				expiresAt: Date.now() + 60000,
			}),
			runId: () => "current-run",
			stream: dispatch,
		} as unknown as EmbeddedCapabilityAdapter;
		const inputs: EmbeddedTurnInput[] = [];
		const retries: number[] = [];
		const client = createEmbeddedClient(
			async () => ({ streamUrl: "https://runtime.example", token: "signed" }),
			async () => {
				const { root, sanitize } = mounted(adapter);
				const session = await root.authenticate("signed");
				return {
					ping: () => session.ping(),
					stream: async (input, deliver) => {
						inputs.push(input);
						try {
							await session.stream(input, deliver);
						} catch (error) {
							expect(dispatch).not.toHaveBeenCalled();
							throw sanitize(error);
						}
					},
					[Symbol.dispose]: () => root[Symbol.dispose](),
				} as EmbeddedSessionStub;
			},
			{
				onRetry: ({ delayMs }) => {
					retries.push(delayMs);
					expect(delayMs).toBe(0);
				},
			},
			{ resumeWatermarks: store, resumeScope: "conversation" },
		);
		const delivered: unknown[] = [];
		try {
			await client.stream(
				{ clientRequestId: "request_123", text: "hello" },
				async (frame) => {
					delivered.push(frame.event);
				},
			);
			expect(inputs).toEqual([
				{
					clientRequestId: "request_123",
					text: "hello",
					resume: true,
					lastEventId: "old-run:1",
				},
				{
					clientRequestId: "request_123",
					text: "hello",
					resume: false,
					lastEventId: undefined,
				},
			]);
			expect(retries).toEqual([0]);
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(delivered).toEqual([{ kind: "done", text: "Completed" }]);
		} finally {
			client.dispose();
		}
	});
});
